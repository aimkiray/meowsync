// OpenAI 兼容接口客户端（/chat/completions 形态）——为 AI 辅助功能提供
// 统一入口：解锁歌名规整、外部曲↔网易云匹配确认、歌词归属核验、无译
// 歌词自动翻译。任何一环 AI 不可用都只返回 null，绝不抛错——AI 是增强
// 路径而非关键路径，所有调用点必须有无 AI 的降级行为。
//
// 配置（全部必填才启用，优先级：app_settings 覆盖 > 环境变量——设置页
// 「留空读服务端配置」的回落链在 lib/settings.js）：
//   AI_BASE_URL   OpenAI 兼容根地址，如 http://127.0.0.1:8317/v1（本地
//                 聚合网关 CLIProxyAPI/new-api/ollama 均可；刻意不做公网
//                 IP 校验——本机/内网代理正是主要部署形态，属于管理员配置
//                 信任域而非用户输入 SSRF 面）
//   AI_API_KEY    Bearer key
//   AI_MODEL      模型名（本地实测 deepseek-v4.1-flash）
//   AI_TIMEOUT_MS 单次调用超时，默认 30000——整链预算：结构化尝试→
//                 裸回退→瞬态重试合计收在这一份里（不是每跳各计）
const { aiConfig } = require('./settings');

// 非法 base 的告警按值去重：覆盖热改后新值要重新判，但同一坏值不重复刷日志
let warnedInvalidBase = null;

function aiEnabled() {
  const { baseUrl, apiKey, model } = aiConfig();
  if (!baseUrl || !apiKey || !model) return false;
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad scheme');
    return true;
  } catch {
    if (warnedInvalidBase !== baseUrl) {
      warnedInvalidBase = baseUrl;
      console.warn(`[ai] AI_BASE_URL='${baseUrl}' 不是合法 http(s) 地址，AI 功能已停用`);
    }
    return false;
  }
}

const aiModel = () => aiConfig().model;

// deepseek 等模型会把 JSON 包进 ```json 围栏，或前后带解释性文字——
// 先整串 parse，失败再收集全部顶层平衡的 {...}/[...] 片段、从最末
// 往前取首个能 parse 的：模型爱在真回答前回显 prompt 里的示例对象，
// 取首个平衡段会把样板当答案
function parseJsonContent(content) {
  const s = String(content || '').trim();
  if (!s) return null;
  const stripped = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(stripped); } catch { /* fallthrough */ }
  const spans = [];
  let depth = 0;
  let inStr = false;
  let esc = false;
  let open = '';
  let close = '';
  let start = -1;
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (depth === 0) {
      if (ch === '{' || ch === '[') { open = ch; close = ch === '{' ? '}' : ']'; depth = 1; start = i; }
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) { spans.push([start, i + 1]); start = -1; }
    }
  }
  for (let i = spans.length - 1; i >= 0; i--) {
    try { return JSON.parse(stripped.slice(spans[i][0], spans[i][1])); } catch { /* 试前一个 */ }
  }
  return null;
}

// 响应体量闸：chat 回包合理上限远低于 256KB——上游异常/被劫持回大体积
// 响应时不让它整坨进内存（readJsonCapped 与 lyric-external 同款形态，
// 本地复刻保持依赖单向）。无 stream 面（测试桩/特殊实现）退 res.json()
const MAX_AI_BODY_BYTES = 256 * 1024;
async function readJsonCapped(res) {
  const reader = res.body?.getReader?.();
  if (!reader) return res.json();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value?.byteLength || 0;
    if (size > MAX_AI_BODY_BYTES) {
      try { await reader.cancel(); } catch { /* 拒收尽力而为 */ }
      throw new Error('AI 响应体超限');
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8'));
}

// 可中止 sleep——退避等待期间调用方断连/链预算烧完要即时醒；reject
// 带 signal.reason（TimeoutError/AbortError）让上层日志留得出真因
const abortableSleep = (ms, signal) => new Promise((resolve, reject) => {
  const bail = () => reject(signal?.reason ?? Object.assign(new Error('已取消'), { aborted: true }));
  if (signal?.aborted) return bail();
  const t = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort);
    resolve();
  }, ms);
  const onAbort = () => { clearTimeout(t); bail(); };
  signal?.addEventListener('abort', onAbort, { once: true });
});

// 瞬态重试面：429 限流与 5xx 网关/上游临时故障——同 body 退避重发。
// 400/404/422 是参数不兼容信号（response_format/非标字段），不重发——
// 走既有裸回退路径
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
// 退避序列（至多 2 次重试）；Retry-After 在场优先、顶帽 4s
let RETRY_DELAYS = [300, 900];
const RETRY_AFTER_CAP_MS = 4000;
const retryDelayMs = (res, attempt) => {
  const ra = res?.headers?.get?.('retry-after');
  if (ra != null) {
    const sec = Number(ra);
    if (Number.isFinite(sec)) return Math.min(Math.max(sec, 0) * 1000, RETRY_AFTER_CAP_MS);
    const at = Date.parse(ra); // Retry-After 也允许 HTTP-date 形态
    if (Number.isFinite(at)) return Math.min(Math.max(at - Date.now(), 0), RETRY_AFTER_CAP_MS);
  }
  return RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)];
};

async function postChat(body, chainSignal) {
  const { baseUrl, apiKey } = aiConfig();
  // 并发热改可能恰好抽空绑定（env 密钥对新址拒发）——Bearer null 裸字面
  // 发出去不如直接按 AI 不可用抛给上层降级；标 noRetry——确定性配置
  // 缺失退避重发无意义
  if (!baseUrl || !apiKey) {
    const err = new Error('AI 配置不完整');
    err.noRetry = true;
    throw err;
  }
  // origin+pathname 拼接（与 ai-test 同口径）——env 直配的 URL 可能带
  // query/尾斜杠，裸字符串拼接会把路径吞进查询串。
  // 热改竞态把 baseUrl 在 aiEnabled 闸后换成非法值时 new URL 抛 TypeError——
  // 确定性配置故障与上空配闸同口径标 noRetry，不进瞬态退避白烧跳数
  let u;
  try {
    u = new URL(baseUrl);
  } catch {
    const err = new Error(`AI_BASE_URL 非法（'${baseUrl}'）`);
    err.noRetry = true;
    throw err;
  }
  const res = await fetch(`${u.origin}${u.pathname.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    // Same posture as ai-test: never follow redirects silently — a 3xx lands
    // on the !res.ok path below and degrades AI instead of re-targeting
    redirect: 'manual',
    signal: chainSignal,
  });
  return res;
}

// postChat 的瞬态重试壳：429/5xx 与网络错误（非 abort）按退避最多重发
// 2 次，Retry-After 顶帽 4s；失败响应先 drain 再重发（undici keep-alive
// 下未消费体会占住 socket 到 GC）。重发与退避全程吃 chainSignal——
// 瞬态重试是抢上游恢复窗口，不许把总耗时放出 effTimeout 包线
async function postChatRetry(body, chainSignal, tag) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await postChat(body, chainSignal);
    } catch (e) {
      if (chainSignal.aborted || e?.noRetry || attempt >= RETRY_DELAYS.length) throw e;
      console.warn(`[ai] tag=${tag} 请求异常（${e?.message || e}），${RETRY_DELAYS[attempt]}ms 后重试 ${attempt + 1}/${RETRY_DELAYS.length}`);
      await abortableSleep(RETRY_DELAYS[attempt], chainSignal);
      continue;
    }
    if (!RETRYABLE_STATUS.has(res.status) || attempt >= RETRY_DELAYS.length) return res;
    const wait = retryDelayMs(res, attempt);
    console.warn(`[ai] tag=${tag} chat HTTP ${res.status}，${wait}ms 后重试 ${attempt + 1}/${RETRY_DELAYS.length}`);
    await res.arrayBuffer().catch(() => {}); // drain：同 keep-alive 理由
    await abortableSleep(wait, chainSignal);
  }
}

// askAiJson: 请求 chat completions 并解析 JSON 回答。任何失败（网络/
// 非 2xx/解析失败/超时/断连）都返回 null——调用方按「AI 不在」降级。
// tag 只用于成功/失败日志行归属——多业务面共用同一出口时可分辨来源
async function askAiJson({ system, user, maxTokens = 1024, timeoutMs, signal = null, tag = 'chat' }) {
  if (!aiEnabled()) return null;
  const { model, timeoutMs: cfgTimeout } = aiConfig();
  const effTimeout = timeoutMs ?? cfgTimeout;
  const startedAt = Date.now();
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  const baseBody = {
    model, messages, temperature: 0.1,
    // 推理型模型的 reasoning 与 content 共享 max_tokens 预算——调用方给的是
    // 「回答本体」预算，额外留 4096 给思维链（实测 deepseek 推理歌词类任务
    // reasoning 可达 ~4k tokens），否则推理吃掉配额后 content 为空
    max_tokens: Math.min(Math.max(maxTokens, 16) + 4096, 20000),
    // 能省则省（不支持的后端会忽略该参数，无副作用）
    reasoning_effort: 'low',
    stream: false,
  };
  try {
    // AbortSignal.any：业务超时与客户端断连任一触发即中止。整条尝试链
    // （结构化→裸回退→瞬态重试）共享一份 effTimeout 预算而非每跳各计——
    // 重试抢的是剩余预算，总包线不动
    const chain = [AbortSignal.timeout(effTimeout)];
    if (signal) chain.push(signal);
    const chainSignal = AbortSignal.any(chain);
    // 优先请求结构化输出；不兼容 response_format 的实现回退裸文本 + 自行解析
    // （回退同时去掉 reasoning_effort——严格校验的网关可能正是被这类
    // 非标准参数 400 掉的）
    let res = await postChatRetry({ ...baseBody, response_format: { type: 'json_object' } }, chainSignal, tag);
    let bare = false;
    const retryBare = async () => {
      bare = true;
      const { reasoning_effort, ...rest } = baseBody;
      return postChatRetry(rest, chainSignal, tag);
    };
    if (!res.ok && (res.status === 400 || res.status === 404 || res.status === 422)) {
      // 重试前 drain 响应体——undici keep-alive 下未消费体会占住 socket 到 GC
      await res.arrayBuffer().catch(() => {});
      res = await retryBare();
    }
    if (!res.ok) {
      console.warn(`[ai] tag=${tag} chat 请求失败 HTTP ${res.status}`);
      await res.arrayBuffer().catch(() => {}); // drain：同 keep-alive 理由
      return null;
    }
    let data = await readJsonCapped(res);
    let content = data?.choices?.[0]?.message?.content;
    // 聚合网关会把上游失败包成 200 + {error:{...}}（one-api/new-api 常见）——
    // 但 error 与有效 choices 可共存，拿到内容就不重试；只在 content 为空
    // 且疑似参数不兼容时按裸请求再试一次
    if ((content == null || content === '') && !bare) {
      const res2 = await retryBare();
      if (!res2.ok) {
        console.warn(`[ai] tag=${tag} chat 重试失败 HTTP ${res2.status}`);
        await res2.arrayBuffer().catch(() => {});
      } else {
        const data2 = await readJsonCapped(res2);
        const content2 = data2?.choices?.[0]?.message?.content;
        // 重试只在其确实更优时替换——拿不到内容就回落首份 data，
        // 不把首个有效回包被裸重试的失败丢弃
        if (content2 != null && content2 !== '') {
          data = data2;
          content = content2;
        }
      }
    }
    // error 与有效 choices 共存的网关回包以内容为准——只在拿不到内容时才算失败
    if (data?.error && (content == null || content === '')) {
      console.warn(`[ai] tag=${tag} 上游返回错误:`, data.error?.message || data.error);
      return null;
    }
    const parsed = parseJsonContent(content);
    if (parsed == null) {
      // 空 content 多半是被推理挤爆 max_tokens（finish=length）——
      // 把 usage/finish 打出来才能区分「截断」与「模型不产 JSON」
      const finish = data?.choices?.[0]?.finish_reason;
      const completion = data?.usage?.completion_tokens;
      console.warn(`[ai] tag=${tag} 回答非合法 JSON (finish=${finish}, completion_tokens=${completion}):`,
        String(content).slice(0, 160));
    } else {
      // 成功面单行留痕：tag 归业务、模型/token 进出与整链时延——配额
      // 消耗与各功能可用性从此可查（失败面各有 warn，不重复打）
      const usage = data?.usage;
      console.info(`[ai] tag=${tag} model=${model} in=${usage?.prompt_tokens ?? '-'} out=${usage?.completion_tokens ?? '-'} ms=${Date.now() - startedAt}`);
    }
    return parsed;
  } catch (e) {
    if (signal?.aborted) return null;
    console.warn(`[ai] tag=${tag} 请求异常:`, e?.message || e);
    return null;
  }
}

// 测试钩子：退避序列换 ~0 值免真等——只影响重试节奏不影响分支
const _setRetryDelays = (d) => { RETRY_DELAYS = d; };

module.exports = { aiEnabled, askAiJson, aiModel, _setRetryDelays };

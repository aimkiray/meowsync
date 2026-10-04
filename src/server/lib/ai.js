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
//   AI_TIMEOUT_MS 单次请求超时，默认 30000
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
// 先整串 parse，失败再取首个平衡的 {...}/[...] 片段
function parseJsonContent(content) {
  const s = String(content || '').trim();
  if (!s) return null;
  const stripped = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(stripped); } catch { /* fallthrough */ }
  const start = stripped.search(/[{[]/);
  if (start < 0) return null;
  const open = stripped[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(stripped.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

async function postChat(body, timeoutMs, signal) {
  const { baseUrl, apiKey } = aiConfig();
  // AbortSignal.any：业务超时与客户端断连任一触发即中止
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.any(signals),
  });
  return res;
}

// askAiJson: 请求 chat completions 并解析 JSON 回答。任何失败（网络/
// 非 2xx/解析失败/超时/断连）都返回 null——调用方按「AI 不在」降级
async function askAiJson({ system, user, maxTokens = 1024, timeoutMs, signal = null }) {
  if (!aiEnabled()) return null;
  const { model, timeoutMs: cfgTimeout } = aiConfig();
  const effTimeout = timeoutMs ?? cfgTimeout;
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
    // 优先请求结构化输出；不兼容 response_format 的实现回退裸文本 + 自行解析
    // （回退同时去掉 reasoning_effort——严格校验的网关可能正是被这类
    // 非标准参数 400 掉的）
    let res = await postChat({ ...baseBody, response_format: { type: 'json_object' } }, effTimeout, signal);
    let bare = false;
    const retryBare = async () => {
      bare = true;
      const { reasoning_effort, ...rest } = baseBody;
      return postChat(rest, effTimeout, signal);
    };
    if (!res.ok && (res.status === 400 || res.status === 404 || res.status === 422)) {
      // 重试前 drain 响应体——undici keep-alive 下未消费体会占住 socket 到 GC
      await res.arrayBuffer().catch(() => {});
      res = await retryBare();
    }
    if (!res.ok) {
      console.warn(`[ai] chat 请求失败 HTTP ${res.status}`);
      await res.arrayBuffer().catch(() => {}); // drain：同 keep-alive 理由
      return null;
    }
    let data = await res.json();
    // 聚合网关会把上游失败包成 200 + {error:{...}}（one-api/new-api 常见）——
    // 若首次带 response_format 且疑似参数不兼容，按裸请求再试一次
    if ((data?.error || !Array.isArray(data?.choices)) && !bare) {
      res = await retryBare();
      if (!res.ok) {
        console.warn(`[ai] chat 重试失败 HTTP ${res.status}`);
        await res.arrayBuffer().catch(() => {});
        return null;
      }
      data = await res.json();
    }
    const content = data?.choices?.[0]?.message?.content;
    // error 与有效 choices 共存的网关回包以内容为准——只在拿不到内容时才算失败
    if (data?.error && (content == null || content === '')) {
      console.warn('[ai] 上游返回错误:', data.error?.message || data.error);
      return null;
    }
    const parsed = parseJsonContent(content);
    if (parsed == null) {
      // 空 content 多半是被推理挤爆 max_tokens（finish=length）——
      // 把 usage/finish 打出来才能区分「截断」与「模型不产 JSON」
      const finish = data?.choices?.[0]?.finish_reason;
      const completion = data?.usage?.completion_tokens;
      console.warn(`[ai] 回答非合法 JSON (finish=${finish}, completion_tokens=${completion}):`,
        String(content).slice(0, 160));
    }
    return parsed;
  } catch (e) {
    if (signal?.aborted) return null;
    console.warn('[ai] 请求异常:', e?.message || e);
    return null;
  }
}

module.exports = { aiEnabled, askAiJson, aiModel };

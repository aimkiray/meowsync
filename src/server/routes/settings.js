// 运行时配置端点：设置页读写 app_settings 覆盖值，留空回落环境变量。
// 读面：非密值全量回显（输入框占位用），密值只出存在性+尾标——
// 密钥类值不出进程的既有口径不因设置页开口。
// 写面：authGate 统一门禁（users 空表=局域网免登录同全写面同口径），
// 另加低频限流防脚本刷库
const { Hono } = require('hono');
const { Readable } = require('stream');
const { parseJsonBody } = require('../lib/validate');
const { settingsBody, aiTestBody } = require('../../shared/contracts.js');
const { fail } = require('../lib/http-error');
const { rateLimit } = require('../lib/rate-limit');
const settingsLib = require('../lib/settings');
const repo = require('../repositories/settings');
const { aiEnabled, aiModel } = require('../lib/ai');

const app = new Hono();

// GET /settings —— 全键投影 + AI 启用态汇总（前端直接绑表单）。
// no-store 显式盖掉 token/开放态路径的启发式缓存（session 分支 auth-gate 已盖）
app.get('/settings', (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json({
    code: 200,
    fields: settingsLib.describeSettings(),
    ai: { enabled: aiEnabled(), model: aiEnabled() ? aiModel() : null },
  });
});

// PUT /settings {key: value|null|''} —— ''/null = 清覆盖回落 env。
// 逐键整形，第一处非法即整单 400（部分落库的半配置态比全拒更难排查）
app.put('/settings', async (c) => {
  const { data: body, error } = await parseJsonBody(c, settingsBody, 32 * 1024);
  if (error) return error;
  const entries = Object.entries(body || {}).filter(([k]) => settingsLib.DEFS[k]);
  if (!entries.length) return fail(c, 400, '无可写配置项');
  if (!rateLimit(c, 'settings-write', 20)) return fail(c, 429, '请求过于频繁');
  const ops = [];
  for (const [key, raw] of entries) {
    const v = raw == null ? '' : String(raw).trim();
    if (v === '') { ops.push({ key, value: null }); continue; }
    const norm = settingsLib.normalizeOverride(key, raw);
    if (!norm.ok) return fail(c, 400, norm.error);
    ops.push({ key, value: norm.value });
  }
  repo.applyOps(ops);
  return c.json({
    code: 200,
    fields: settingsLib.describeSettings(),
    ai: { enabled: aiEnabled(), model: aiEnabled() ? aiModel() : null },
  });
});

// POST /settings/ai-test {baseUrl?, apiKey?, model?} —— 连通性探测：
// 未填段用已生效配置补位（「测一下刚填的还没存的值」是设置页的自然动作）。
// 打 /models 而非 chat completion——只验可达与鉴权，不烧 token。
// AI_BASE_URL 的公网校验刻意不做（与 ai.js 头注同口径：管理员配置信任域，
// 本机/内网聚合网关是主形态；写面已在 authGate 后）
app.post('/settings/ai-test', async (c) => {
  const { data: body, error } = await parseJsonBody(c, aiTestBody, 8 * 1024);
  if (error) return error;
  if (!rateLimit(c, 'ai-test', 10)) return fail(c, 429, '请求过于频繁');
  const cfg = settingsLib.aiConfig();
  const baseUrl = String(body.baseUrl || '').trim().replace(/\/+$/, '') || cfg.baseUrl;
  // 密钥回落也过 origin 绑定——草稿 URL 指到别站时不能拿存着的密钥去测
  const apiKey = String(body.apiKey || '').trim() || settingsLib.aiKeyBoundTo(baseUrl);
  const model = String(body.model || '').trim() || cfg.model;
  if (!baseUrl || !apiKey) {
    return c.json({ code: 200, ok: false, reason: 'incomplete', message: 'base_url 与 api_key 必填' });
  }
  let u;
  try {
    u = new URL(baseUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('scheme');
  } catch {
    return c.json({ code: 200, ok: false, reason: 'bad-url', message: 'base_url 不是合法 http(s) 地址' });
  }
  try {
    const res = await fetch(`${u.origin}${u.pathname.replace(/\/+$/, '')}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000),
      // manual：调用方选的上游，跳转链不该代它走（防探测被引到第二站）
      redirect: 'manual',
    });
    if (!res.ok) {
      await res.arrayBuffer().catch(() => {}); // drain：keep-alive 不消费体会占住 socket
      return c.json({ code: 200, ok: false, status: res.status, message: `上游 HTTP ${res.status}` });
    }
    // 上限读体——上游是调用方选的，256KB 防爆
    const chunks = []; let bytes = 0;
    for await (const ch of (res.body ? Readable.fromWeb(res.body) : [])) {
      bytes += ch.length;
      if (bytes > 256 * 1024) throw new Error('上游响应超限');
      chunks.push(ch);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const ids = Array.isArray(data?.data) ? data.data.map(m => m?.id).filter(Boolean) : [];
    return c.json({
      code: 200, ok: true,
      modelCount: ids.length,
      // 名单不可得/模型不在列都不判死——网关可能只暴露部分模型
      modelFound: model && ids.length ? ids.includes(model) : null,
      model: model || null,
    });
  } catch (e) {
    return c.json({ code: 200, ok: false, message: `连接失败：${e?.message || e}` });
  }
});

module.exports = app;

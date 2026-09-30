const { createHash } = require('crypto');
const { Hono } = require('hono');
const { getDb } = require('../db/client');
const { readJsonBody } = require('../lib/http-body');
const { rateLimit } = require('../lib/rate-limit');
const { callNeteaseApi } = require('../services/netease-api');
const { aiEnabled, askAiJson, AI_MODEL } = require('../lib/ai');

const app = new Hono();

// 词源相关端点只认网易云数字 id——bv_/yt_ 等外部 id 没有网易云词源，放行
// 只会空耗一次上游 lyric 调用再 404
const NETEASE_ID_RE = /^\d{1,20}$/;
// 翻译负载上限：千行级歌词多半是滚动歌词逐字拆分（字数标记），整单 AI 翻译
// 既不经济也无必要——超量直接拒
const MAX_LYRIC_LINES = 400;
const TRANSLATE_CHUNK = 40;
// CJK 占比 ≥30% 视为已是中文语境歌词（含日汉混排误判方向——宁可不翻不错翻）
const CJK_SKIP_RATIO = 0.3;

const fail = (c, status, message, extra = {}) =>
  c.json({ code: status, message, ...extra }, status);

// 同 id/vkey 在途去重（值只是完成信号，不载数据——见各路由内注释）
const inflightTranslate = new Map();
const inflightVerify = new Map();

// GET /ai/status —— 暴露启用态给前端（模型名可回显；key 绝不出口）
app.get('/ai/status', (c) => {
  return c.json({ code: 200, enabled: aiEnabled(), model: aiEnabled() ? AI_MODEL : null });
});

// 与前端 parseLyrics 同口径的 LRC 行解析（服务端无 ESM 共享，~15 行自洽）：
// 返回 [{tag, text}]——tag 保留原始时间戳串，翻译重建时原样回贴
function parseLrcLines(lrc) {
  const out = [];
  const tagRe = /\[(\d+):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  for (const line of String(lrc || '').split('\n')) {
    const tags = [...line.matchAll(tagRe)];
    if (!tags.length) continue;
    const text = line.replace(tagRe, '')
      .replace(/<\d+:\d{1,2}(?:[.:]\d{1,3})?>/g, '')
      .trim();
    if (!text) continue;
    for (const t of tags) out.push({ tag: t[0], text });
  }
  return out;
}

const lrcMetaLines = (lrc) => String(lrc || '').split('\n')
  .map(l => l.trim())
  .filter(l => /^\[(ti|ar|al|by|offset|re|ve):/i.test(l));

// CJK 占比：日文假名/韩文谚文计入分母（它们同样需要翻译）
function cjkRatio(text) {
  const cjk = (text.match(/[一-鿿㐀-䶿]/g) || []).length;
  const other = (text.match(/[A-Za-z぀-ヿ가-힯]/g) || []).length;
  return cjk / (cjk + other || 1);
}

// 制作名单/纯音乐标记行不进翻译负载（它们没有翻译意义，译了反而污染对齐）
// 词边界：op/sp/music/词/曲 这类短 token 必须跟冒号才判为信息行——
// "open your eyes"/"speed of light"/「曲がり角」这类正常行首不能误杀
const NON_LYRIC_RE = /^(?:(?:纯音乐|instrumental|作曲|作词|编曲|监制|制作人|出品|录入|歌词制作)|(?:op|sp|music|词|曲)\s*[:：])/i;

// callNeteaseApi 不透传 signal——上游 lyric 请求会跑到自身超时（有界），
// 调用点在拿到结果后靠 ownsLyric/abort 检查丢弃迟到的数据
async function fetchLyricRaw(id) {
  const res = await callNeteaseApi('lyric', { id });
  return {
    lrc: res.body?.lrc?.lyric || '',
    tlyric: res.body?.tlyric?.lyric || '',
  };
}

// POST /ai/lyric-translate {id} —— 词源没有官方译文时生成中文 tlyric。
// 结果按词源 id 永久落库：同一首歌在任何歌单/壳里重放零成本命中。
// 幂等：缓存命中/官方译文直回都不消耗 AI 额度
app.post('/ai/lyric-translate', async (c) => {
  if (!aiEnabled()) return fail(c, 503, 'AI 未配置', { enabled: false });
  let body;
  try {
    body = await readJsonBody(c, 16 * 1024);
  } catch (e) {
    if (e?.status === 413) return fail(c, 413, '请求体过大');
    body = {};
  }
  const id = String(body?.id ?? '');
  if (!NETEASE_ID_RE.test(id)) return fail(c, 400, '非法 songId');
  const signal = c.req.raw.signal;

  const db = getDb();
  // 行存在即命中——skip 哨兵（tlyric=''）也是有效缓存项，防止
  // already-zh/无词曲每次重播都重打上游 lyric
  const rowOf = () => db.prepare(
    'SELECT tlyric FROM song_lyric_translation WHERE song_id = ?'
  ).get(id);
  const skipInsert = (reason) => db.prepare(
    `INSERT INTO song_lyric_translation (song_id, tlyric, model)
     VALUES (?, '', ?) ON CONFLICT(song_id) DO NOTHING`).run(id, `skip:${reason}`);
  const cached0 = rowOf();
  if (cached0) {
    return c.json({ code: 200, tlyric: cached0.tlyric || null, cached: true });
  }
  // 缓存未命中才吃配额——快速切歌的重复请求不该撞上 429
  if (!rateLimit(c, 'ai-translate', 8)) return fail(c, 429, '请求过于频繁');

  // 同 id 在途翻译去重：并发/重试请求等首个完成后直接吃缓存，
  // 不为同一首歌付两份上游 AI 配额（首个失败则放行本次自行尝试）
  // 多 waiter 同醒场景循环重查——后醒者看到先醒者的新 gate 继续等，
  // 而不是覆盖它造成并行重复扣费
  while (inflightTranslate.has(id)) {
    await inflightTranslate.get(id).catch(() => {});
    const hit = rowOf();
    if (hit) return c.json({ code: 200, tlyric: hit.tlyric || null, cached: true });
  }
  let release;
  const myGate = new Promise(r => { release = r; });
  inflightTranslate.set(id, myGate);

  try {
    const { lrc, tlyric: rawTlyric } = await fetchLyricRaw(id);
    const tlyric = typeof rawTlyric === 'string' ? rawTlyric : String(rawTlyric || '');
    if (tlyric.trim()) {
      // 官方译文直回——也落库，下次连上游都不用打
      db.prepare(`INSERT INTO song_lyric_translation (song_id, tlyric, model)
        VALUES (?, ?, 'netease') ON CONFLICT(song_id) DO UPDATE SET
        tlyric = excluded.tlyric, model = 'netease', updated_at = CURRENT_TIMESTAMP`).run(id, tlyric);
      return c.json({ code: 200, tlyric, source: 'netease' });
    }
    const lines = parseLrcLines(lrc);
    if (!lines.length) {
      skipInsert('no-lyric');
      return fail(c, 404, '该歌曲无歌词');
    }
    if (lines.length > MAX_LYRIC_LINES) return fail(c, 400, '歌词行数超出翻译上限');

    const allText = lines.map(l => l.text).join('\n');
    if (cjkRatio(allText) >= CJK_SKIP_RATIO) {
      skipInsert('already-zh');
      return c.json({ code: 200, tlyric: null, skipped: 'already-zh' });
    }

    // 逐块翻译：只送需要译的行，时间戳留在服务端回贴——模型只管文本，
    // 不碰时序。契约是 {t:{行号:译文}} 键控映射而非等长数组：推理型模型
    // 会压缩合并输入行，数组对位必漂；键控只采纳它实际给出的行，
    // 缺失行保留原文（mergeTranslations 按时间邻近对齐，自然空出）
    // 同文本行（多时间戳副歌等）去重只送一次——translated 以原文为键，
    // 回写时所有同文行共享一份译文
    const seenTexts = new Set();
    const jobs = [];
    for (const l of lines) {
      if (NON_LYRIC_RE.test(l.text) || seenTexts.has(l.text)) continue;
      seenTexts.add(l.text);
      jobs.push({ text: l.text });
    }
    if (!jobs.length) {
      // 全是非歌词行（纯音乐轨等）——记 skip 缓存，重播不再打上游
      skipInsert('no-translatable');
      return c.json({ code: 200, tlyric: null, skipped: 'no-translatable' });
    }
    const translated = new Map(); // 原文 -> 译文
    for (let off = 0; off < jobs.length; off += TRANSLATE_CHUNK) {
      if (signal?.aborted) return c.body(null, 499);
      const chunk = jobs.slice(off, off + TRANSLATE_CHUNK);
      const ans = await askAiJson({
        system: '你是歌词翻译器。输入是 {行号:歌词行} 对象，逐行翻译成简体中文：'
          + '键名与输入行号一一对应；语气贴合歌词文体；专名可音译或保留；'
          + '纯拟声词保留原文；实在无法翻译的行可省略该键。'
          + '只输出 JSON {"t":{"0":"译文","1":"译文",...}}',
        user: JSON.stringify(Object.fromEntries(chunk.map((j, k) => [k, j.text]))),
        maxTokens: Math.min(8192, chunk.length * 96 + 512),
        timeoutMs: 90000,
        signal,
      });
      // 兼容两种回包：键控对象（首选）或等长数组（老 prompt 习惯）
      const t = ans?.t;
      const pairs = t && typeof t === 'object' && !Array.isArray(t)
        ? Object.entries(t)
        : Array.isArray(t) ? t.map((v, k) => [k, v]) : null;
      if (!pairs || !pairs.length) {
        if (signal?.aborted) return c.body(null, 499);
        return fail(c, 502, 'AI 未返回有效翻译');
      }
      for (const [k, v] of pairs) {
        const idx = Number(k);
        // 译文净化：歌词原文来自 UGC、模型输出可被 prompt 注入带偏——
        // 剥换行+全部 ASCII 方括号（行中 [mm:ss] 照样能被客户端当时间戳
        // 展开成幻影行，只查行首不够）；剥零宽字符；限长防异常膨胀。
        // 全角【】不受影响（LRC 只认 ASCII）。这里产出的文本会永久落库下发
        const text = typeof v === 'string'
          ? v.replace(/[\r\n]+/g, ' ')
            .replace(/[\[\]]/g, '')
            .replace(/[​-‏﻿]/g, '')
            .trim()
          : '';
        if (Number.isInteger(idx) && idx >= 0 && idx < chunk.length
          && text && text.length <= 500) {
          translated.set(chunk[idx].text, text);
        }
      }
    }

    const out = [...lrcMetaLines(lrc)];
    for (const l of lines) {
      const t = translated.get(l.text);
      if (t) out.push(`${l.tag}${t}`);
    }
    if (!translated.size) return fail(c, 502, 'AI 未返回有效翻译');
    const result = out.join('\n');
    db.prepare(`INSERT INTO song_lyric_translation (song_id, tlyric, model)
      VALUES (?, ?, ?) ON CONFLICT(song_id) DO UPDATE SET
      tlyric = excluded.tlyric, model = excluded.model, updated_at = CURRENT_TIMESTAMP`
    ).run(id, result, AI_MODEL);
    return c.json({ code: 200, tlyric: result, lines: translated.size, source: 'ai' });
  } catch (e) {
    if (signal?.aborted) return c.body(null, 499);
    console.error('[ai] lyric-translate 失败:', e?.message || e);
    return fail(c, 502, '翻译失败');
  } finally {
    // 只删自己创建的 gate——多 waiter 场景里别人的新 gate 不能被误删
    if (inflightTranslate.get(id) === myGate) inflightTranslate.delete(id);
    release();
  }
});

// POST /ai/lyric-verify {id, sourceTitle, sourceAuthor} —— 外部导入曲经
// 网易云匹配取词时，核验配到的歌词与来源音视频是不是同一首歌。
// 「错歌词比没歌词更糟」：判不符时前端把歌词整组隐藏。
// 判定按词源 id 落库（song_ai_verdict kind='lyric'）——同一错配不重复问模型
app.post('/ai/lyric-verify', async (c) => {
  if (!aiEnabled()) return fail(c, 503, 'AI 未配置', { enabled: false });
  let body;
  try {
    body = await readJsonBody(c, 64 * 1024);
  } catch (e) {
    if (e?.status === 413) return fail(c, 413, '请求体过大');
    body = {};
  }
  const id = String(body?.id ?? '');
  if (!NETEASE_ID_RE.test(id)) return fail(c, 400, '非法 songId');
  // 进 prompt 的输入剥换行/方括号——标题作者与歌词原文都是不可信输入，
  // 去掉结构字符至少让注入不能伪造消息边界/键控协议
  const sanitizePrompt = (s) => String(s || '')
    .replace(/[\r\n\[\]]+/g, ' ').replace(/\s+/g, ' ').trim();
  const sourceTitle = sanitizePrompt(body?.sourceTitle).slice(0, 500);
  const sourceAuthor = sanitizePrompt(body?.sourceAuthor).slice(0, 200);
  if (!sourceTitle) return fail(c, 400, '缺少 sourceTitle');
  const signal = c.req.raw.signal;

  // 判定对象是「(词源, 来源视频, 模型) 三元组」而非词源本身：同一 neteaseId
  // 可能被不同视频匹配到，A 视频的错配不能污染 B 视频的正常取用；换模型后
  // 旧判定自动失效重判（避免旧模型的误判被永久固化）
  const sig = createHash('sha1')
    .update(`${sourceTitle.toLowerCase().trim()}|${sourceAuthor.toLowerCase().trim()}`)
    .digest('hex').slice(0, 12);
  const vkey = `${id}@${AI_MODEL}@${sig}`;

  const db = getDb();
  const verdictOf = () => db.prepare(
    "SELECT ok FROM song_ai_verdict WHERE song_id = ? AND kind = 'lyric'"
  ).get(vkey);
  const cached = verdictOf();
  if (cached) return c.json({ code: 200, ok: !!cached.ok, cached: true });
  // 缓存未命中才吃配额
  if (!rateLimit(c, 'ai-verify', 20)) return fail(c, 429, '请求过于频繁');

  // 同 vkey 在途判定去重（与 translate 同款门）
  while (inflightVerify.has(vkey)) {
    await inflightVerify.get(vkey).catch(() => {});
    const hit = verdictOf();
    if (hit) return c.json({ code: 200, ok: !!hit.ok, cached: true });
    // 在途者判定失败（不落库）则由本次自行重试——跳出循环抢 gate
    if (!inflightVerify.has(vkey)) break;
  }
  let release;
  const myGate = new Promise(r => { release = r; });
  inflightVerify.set(vkey, myGate);

  try {
    const { lrc } = await fetchLyricRaw(id);
    const lines = parseLrcLines(lrc);
    if (!lines.length) {
      // 没词可验——无词显示不算错配
      return c.json({ code: 200, ok: true, reason: 'no-lyric' });
    }
    // 抽样而非全文：首 4 行抓歌名植入（很多歌词开头点题），中段 6 行看主题
    const sample = [...lines.slice(0, 4), ...lines.slice(4).filter((_, i) => i % Math.max(1, Math.floor(lines.length / 6)) === 0)]
      .slice(0, 10)
      .map(l => sanitizePrompt(l.text).slice(0, 200))
      .filter(Boolean);

    const ans = await askAiJson({
      system: '你是音乐内容核验助手。给定来源音/视频的标题与作者，以及从音乐平台配到的歌词抽样，'
        + '判断这份歌词是否明显属于另一首歌（完全不同的主题/内容/语言体系）。'
        + '保守原则：只有「明显是别的歌」才判不符；拿不准、纯音乐标注、语言相符但主题难判都回 true。'
        + '只输出 JSON {"ok":true|false}',
      user: `来源标题：${sourceTitle}\n来源作者/频道：${sourceAuthor || '未知'}\n歌词抽样：\n${sample.map((t, i) => `${i + 1}. ${t}`).join('\n')}`,
      maxTokens: 64,
      signal,
    });
    if (ans == null || typeof ans.ok !== 'boolean') {
      // 模型没给判定 → 不缓存、不误伤，按「相符」放行
      return c.json({ code: 200, ok: true, inconclusive: true });
    }
    db.prepare(`INSERT INTO song_ai_verdict (song_id, kind, ok, detail)
      VALUES (?, 'lyric', ?, ?) ON CONFLICT(song_id, kind) DO UPDATE SET
      ok = excluded.ok, detail = excluded.detail, updated_at = CURRENT_TIMESTAMP`
    ).run(vkey, ans.ok ? 1 : 0, sourceTitle.slice(0, 200));
    return c.json({ code: 200, ok: ans.ok });
  } catch (e) {
    if (signal?.aborted) return c.body(null, 499);
    console.error('[ai] lyric-verify 失败:', e?.message || e);
    // 核验通道故障按相符放行——AI 是增强不是门禁
    return c.json({ code: 200, ok: true, inconclusive: true });
  } finally {
    if (inflightVerify.get(vkey) === myGate) inflightVerify.delete(vkey);
    release();
  }
});

module.exports = app;

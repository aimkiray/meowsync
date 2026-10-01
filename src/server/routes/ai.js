const { createHash } = require('crypto');
const { Hono } = require('hono');
const lyricAiRepo = require('../repositories/lyricAi');
const { parseJsonBody } = require('../lib/validate');
const { aiLyricBody } = require('../../shared/contracts.js');
const { fail } = require('../lib/http-error');
const { rateLimit } = require('../lib/rate-limit');
const { callNeteaseApi } = require('../services/netease-api');
const { aiEnabled, askAiJson, AI_MODEL } = require('../lib/ai');

const app = new Hono();

// 词源相关端点只认网易云数字 id 与 qq_<songmid>（QQ 曲吃自家权威歌词做词源）——
// bv_/yt_ 等外部 id 没有可翻译词源，放行只会空耗一次上游 lyric 调用再 404
const NETEASE_ID_RE = /^\d{1,20}$/;
const LYRIC_ID_RE = /^qq_[0-9A-Za-z]{10,20}$/;
// 翻译负载上限：千行级歌词多半是滚动歌词逐字拆分（字数标记），整单 AI 翻译
// 既不经济也无必要——超量直接拒
const MAX_LYRIC_LINES = 400;
const TRANSLATE_CHUNK = 40;
// CJK 占比 ≥30% 视为已是中文语境歌词（含日汉混排误判方向——宁可不翻不错翻）
const CJK_SKIP_RATIO = 0.3;

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

// meta 行重建为 [tag:value]——值里的内嵌括号剥掉，源 lrc 里形如
// [ti:x [00:01] y] 的行否则会把幻影时间戳带进下发 tlyric
const lrcMetaLines = (lrc) => String(lrc || '').split('\n')
  .map(l => l.trim().match(/^\[(ti|ar|al|by|offset|re|ve):(.*)\]$/i))
  .filter(Boolean)
  .map(m => `[${m[1]}:${m[2].replace(/[\[\]]/g, ' ').replace(/\s+/g, ' ').trim()}]`);

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
async function fetchLyricRaw(id, signal) {
  const qqM = id.match(/^qq_([0-9A-Za-z]{10,20})$/);
  if (qqM) {
    const { getLyric } = require('../lib/qq');
    const r = await getLyric(qqM[1], signal);
    return { lrc: r.lyric || '', tlyric: r.trans || '' };
  }
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
  const { data: body, error } = await parseJsonBody(c, aiLyricBody, 16 * 1024);
  if (error) return error;
  const id = String(body.id ?? '');
  if (!NETEASE_ID_RE.test(id) && !LYRIC_ID_RE.test(id)) return fail(c, 400, '非法 songId');
  const signal = c.req.raw.signal;

  // 行存在即命中——skip 哨兵（tlyric=''）也是有效缓存项，防止
  // already-zh/无词曲每次重播都重打上游 lyric。但 skip 是启发式判定
  // 的结果（cjkRatio/credit 行都可能误判），给 7 天 TTL：过期按未命中
  // 重判一次，避免一次瞬时误判被永久固化；重新判为 skip 时 DO UPDATE
  // 刷新 updated_at 续期（SQL 细节收敛在 repositories/lyricAi.js）
  const rowOf = () => lyricAiRepo.getCachedTranslation(id);
  const skipInsert = (reason) => lyricAiRepo.markTranslationSkip(id, reason);
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
    // 排队期间客户端可能已断连——拿到 gate 后先查 aborted，别再烧上游+AI
    if (signal?.aborted) return c.body(null, 499);
    const { lrc, tlyric: rawTlyric } = await fetchLyricRaw(id, signal);
    const tlyric = typeof rawTlyric === 'string' ? rawTlyric : String(rawTlyric || '');
    if (tlyric.trim()) {
      // 官方译文直回——也落库，下次连上游都不用打（model 记录词源而非固定 netease）
      const srcModel = id.startsWith('qq_') ? 'qq' : 'netease';
      lyricAiRepo.upsertTranslation(id, tlyric, srcModel);
      return c.json({ code: 200, tlyric, source: srcModel });
    }
    const lines = parseLrcLines(lrc);
    if (!lines.length) {
      skipInsert('no-lyric');
      return fail(c, 404, '该歌曲无歌词');
    }
    if (lines.length > MAX_LYRIC_LINES) {
      // 也记 skip——超长判定确定但每次重播重打上游 lyric 没必要（TTL 兜底修订）
      skipInsert('too-long');
      return fail(c, 400, '歌词行数超出翻译上限');
    }

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
      // 输入侧限长与输出侧 500 对齐——巨型 UGC 行整行进 prompt 不经济
      if (NON_LYRIC_RE.test(l.text) || l.text.length > 500 || seenTexts.has(l.text)) continue;
      seenTexts.add(l.text);
      jobs.push({ text: l.text });
    }
    if (!jobs.length) {
      // 全是非歌词行（纯音乐轨等）——记 skip 缓存，重播不再打上游
      skipInsert('no-translatable');
      return c.json({ code: 200, tlyric: null, skipped: 'no-translatable' });
    }
    const translated = new Map(); // 原文 -> 译文
    // 最坏时长收进客户端 axios 300s 包线内：块数封顶 5（=200 个去重文本）
    // × 55s 块超时 = 275s + 上游 lyric ≈30s < 300s。超出的尾部行显示原文
    // （未译行回填原文，见下），不会有错译文；循环内 signal 检查保证断连即停
    const startedAt = Date.now();
    // 译文净化：歌词原文来自 UGC、模型输出可被 prompt 注入带偏——
    // 剥换行；成对 [..] 段整体移除（模型回显的 [mm:ss] 连数字一起剥，
    // 只剥括号字符会残留 "05:00" 裸数字进展示文本），落单括号再清；
    // \p{Cf} 剥零宽/BOM 等格式字符（比不可见字面量稳，格式化工具碰不坏）；
    // 限长防异常膨胀。全角【】不受影响（LRC 只认 ASCII）。产出会永久落库下发
    const cleanText = (v) => typeof v === 'string'
      ? v.replace(/[\r\n]+/g, ' ')
        .replace(/\[[^\]]*\]/g, ' ')
        .replace(/[\[\]]/g, ' ')
        .replace(/\p{Cf}/gu, '')
        .replace(/\s+/g, ' ')
        .trim()
      : '';
    // 返回 [{src, text}]——idx 已就地解析成原文，对半拆重试时索引不错位。
    // 推理模型偶发把 token 预算烧在 reasoning 上致 content 截断（finish=length）：
    // 块失败时对半拆降输出需求重试一轮；split 受 150s 时间闸约束，
    // 闸后不再补救（再加 ~2×55s 就顶穿客户端 300s 包线）
    const translateChunk = async (chunk, allowSplit) => {
      const ans = await askAiJson({
        system: '你是歌词翻译器。输入是 {行号:歌词行} 对象，逐行翻译成简体中文：'
          + '键名与输入行号一一对应；语气贴合歌词文体；专名可音译或保留；'
          + '纯拟声词保留原文；实在无法翻译的行可省略该键。'
          + '只输出 JSON {"t":{"0":"译文","1":"译文",...}}',
        user: JSON.stringify(Object.fromEntries(chunk.map((j, k) => [k, j.text]))),
        maxTokens: Math.min(8192, chunk.length * 96 + 512),
        timeoutMs: 55000,
        signal,
      });
      // 兼容两种回包：键控对象（首选）或等长数组（老 prompt 习惯）
      const t = ans?.t;
      const rawPairs = t && typeof t === 'object' && !Array.isArray(t)
        ? Object.entries(t)
        : Array.isArray(t) ? t.map((v, k) => [k, v]) : null;
      const pairs = (rawPairs || [])
        .map(([k, v]) => ({ src: chunk[Number(k)]?.text, text: cleanText(v) }))
        .filter(p => p.src != null && p.text && p.text.length <= 500);
      if (pairs.length) return pairs;
      if (signal?.aborted) return 'aborted';
      if (allowSplit && chunk.length > 1 && Date.now() - startedAt < 150000) {
        const mid = Math.ceil(chunk.length / 2);
        const a = await translateChunk(chunk.slice(0, mid), false);
        if (a === 'aborted') return 'aborted';
        const b = await translateChunk(chunk.slice(mid), false);
        if (b === 'aborted') return 'aborted';
        return [...(a || []), ...(b || [])]; // 仍失败的半边贡献为空
      }
      return null;
    };
    for (let off = 0; off < Math.min(jobs.length, TRANSLATE_CHUNK * 5); off += TRANSLATE_CHUNK) {
      if (signal?.aborted) return c.body(null, 499);
      const res = await translateChunk(jobs.slice(off, off + TRANSLATE_CHUNK), true);
      if (res === 'aborted') return c.body(null, 499);
      // 整块失败只损失该块覆盖（行显示原文），不连带整曲 502
      for (const p of res || []) translated.set(p.src, p.text);
    }

    if (!translated.size) return fail(c, 502, 'AI 未返回有效翻译');
    const out = [...lrcMetaLines(lrc)];
    for (const l of lines) {
      const t = translated.get(l.text);
      // 未译行回填原文占住自己的时间戳：客户端 mergeTranslations 用
      // 0.5s 邻近窗取最近译文，没有占位行会把邻行译文错贴到本行头上；
      // 同文即未译，前端展示层自行判同文不显示
      out.push(`${l.tag}${t || l.text}`);
    }
    const result = out.join('\n');
    lyricAiRepo.upsertTranslation(id, result, AI_MODEL);
    return c.json({ code: 200, tlyric: result, lines: translated.size, total: lines.length, source: 'ai' });
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
  const { data: body, error } = await parseJsonBody(c, aiLyricBody, 64 * 1024);
  if (error) return error;
  const id = String(body.id ?? '');
  if (!NETEASE_ID_RE.test(id)) return fail(c, 400, '非法 songId');
  // 进 prompt 的输入剥换行/方括号——标题作者与歌词原文都是不可信输入，
  // 去掉结构字符至少让注入不能伪造消息边界/键控协议
  const sanitizePrompt = (s) => String(s || '')
    .replace(/[\r\n\[\]]+/g, ' ').replace(/\s+/g, ' ').trim();
  const sourceTitle = sanitizePrompt(body.sourceTitle).slice(0, 500);
  const sourceAuthor = sanitizePrompt(body.sourceAuthor).slice(0, 200);
  if (!sourceTitle) return fail(c, 400, '缺少 sourceTitle');
  const signal = c.req.raw.signal;

  // 判定对象是「(词源, 来源视频, 模型) 三元组」而非词源本身：同一 neteaseId
  // 可能被不同视频匹配到，A 视频的错配不能污染 B 视频的正常取用；换模型后
  // 旧判定自动失效重判（避免旧模型的误判被永久固化）
  const sig = createHash('sha1')
    .update(`${sourceTitle.toLowerCase().trim()}|${sourceAuthor.toLowerCase().trim()}`)
    .digest('hex').slice(0, 12);
  const vkey = `${id}@${AI_MODEL}@${sig}`;

  const verdictOf = () => lyricAiRepo.getLyricVerdict(vkey);
  const cached = verdictOf();
  if (cached) return c.json({ code: 200, ok: !!cached.ok, cached: true });
  // 缓存未命中才吃配额
  if (!rateLimit(c, 'ai-verify', 20)) return fail(c, 429, '请求过于频繁');

  // 同 vkey 在途判定去重（与 translate 同款门）
  while (inflightVerify.has(vkey)) {
    await inflightVerify.get(vkey).catch(() => {});
    const hit = verdictOf();
    if (hit) return c.json({ code: 200, ok: !!hit.ok, cached: true });
    // 在途者判定失败（不落库）则循环条件放行，由本次自行重试抢 gate
  }
  let release;
  const myGate = new Promise(r => { release = r; });
  inflightVerify.set(vkey, myGate);

  try {
    if (signal?.aborted) return c.body(null, 499);
    const { lrc } = await fetchLyricRaw(id);
    const lines = parseLrcLines(lrc);
    if (!lines.length) {
      // 没词可验——无词显示不算错配
      return c.json({ code: 200, ok: true, reason: 'no-lyric' });
    }
    // 抽样而非全文：首 4 行抓歌名植入（很多歌词开头点题），中段 6 行看主题；
    // 同文行（多时间戳副歌展开）去重，不浪费采样位
    const seenSample = new Set();
    const sample = [...lines.slice(0, 4), ...lines.slice(4).filter((_, i) => i % Math.max(1, Math.floor(lines.length / 6)) === 0)]
      .map(l => sanitizePrompt(l.text).slice(0, 200))
      .filter(t => t && !seenSample.has(t) && seenSample.add(t))
      .slice(0, 10);

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
    lyricAiRepo.upsertLyricVerdict(vkey, ans.ok, sourceTitle.slice(0, 200));
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

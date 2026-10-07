const { Hono } = require('hono');
const lyricAiRepo = require('../repositories/lyricAi');
const { parseLrcLines, lyricVerdictKey, judgeLyricLines, resolveYtDeclared, resolveCreditGateCandidate, composerCreditRefutes, sanitizePrompt } = require('../services/lyric-verify');
const { parseJsonBody } = require('../lib/validate');
const { aiLyricBody } = require('../../shared/contracts.js');
const { fail } = require('../lib/http-error');
const { rateLimit } = require('../lib/rate-limit');
const { callNeteaseApi } = require('../services/netease-api');
const { aiEnabled, askAiJson, aiModel } = require('../lib/ai');

const app = new Hono();

// 词源相关端点只认网易云数字 id、qq_<songmid>（QQ 曲吃自家权威歌词做词源）
// 与 EXT_LYRIC_ID_RE 外源词源 id（ytm_/lrclib_/kugou_——下载链外源兜底的
// 词键，取词走 lyric-external.fetchByExtId 反查支路）；bv_/yt_ 轨道 id
// 仍拒——它们没有可翻译词源，放行只会空耗一次上游调用再 404
// 20 位上限的 bounded 形与共享无界 NETEASE_ID_RE 语义不同——直接用共享名防遮蔽
const { NETEASE_ID_BOUNDED_RE, QQ_SONG_ID_RE, EXT_LYRIC_ID_RE, YT_TRACK_ID_RE } = require('../../shared/predicates.js');
// 翻译负载上限：千行级歌词多半是滚动歌词逐字拆分（字数标记），整单 AI 翻译
// 既不经济也无必要——超量直接拒
const MAX_LYRIC_LINES = 400;
const TRANSLATE_CHUNK = 40;
// 翻译循环整体单调时间闸：到点不再开新块（含块内对半拆重试的耗时）。
// 与上游 lyric ~30s 合计收进客户端 axios 300s 包线内
const TRANSLATE_DEADLINE_MS = 240000;
// CJK 占比 ≥30% 视为已是中文语境歌词（含日汉混排误判方向——宁可不翻不错翻）
const CJK_SKIP_RATIO = 0.3;

// 同 id/vkey 在途去重（值只是完成信号，不载数据——见各路由内注释）
const inflightTranslate = new Map();
const inflightVerify = new Map();

// GET /ai/status —— 暴露启用态给前端（模型名可回显；key 绝不出口）
app.get('/ai/status', (c) => {
  return c.json({ code: 200, enabled: aiEnabled(), model: aiEnabled() ? aiModel() : null });
});

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

// callNeteaseApi 第三参 options.signal 端到端透传到 request 层——
// 客户端断连即杀上游 socket，不必等自身超时
async function fetchLyricRaw(id, signal) {
  // 外源词源 id（ytm_/lrclib_/kugou_）：下载链级联兜底的词键，反查取原文。
  // 外源无官方译文概念——tlyric 恒空；kugou_ 出缓存查不回（accesskey 不
  // 落 extId）归一成空词，与网易云无词同走 no-lyric 语义
  if (EXT_LYRIC_ID_RE.test(id)) {
    const { fetchByExtId } = require('../services/lyric-external');
    const hit = await fetchByExtId(id, { signal });
    return { lrc: String(hit?.lrc || hit?.plain || ''), tlyric: '' };
  }
  const qqM = id.match(QQ_SONG_ID_RE);
  if (qqM) {
    const { getLyric } = require('../lib/qq');
    try {
      const r = await getLyric(qqM[1], signal);
      return { lrc: r.lyric || '', tlyric: r.trans || '' };
    } catch (e) {
      // 业务码（-1901/-1301 无词等）= 确定性无词——与 file-downloader 的
      // NO_LYRICS 映射同口径：归一成空 lrc 走 skip:no-lyric 落哨兵，
      // 否则无词 qq_ 曲每次重播都重打上游再 502、永远写不进缓存。
      // 传输层错误（无 bizCode）照旧上抛
      if (e && e.bizCode !== undefined) return { lrc: '', tlyric: '' };
      throw e;
    }
  }
  const res = await callNeteaseApi('lyric', { id }, { signal });
  return {
    lrc: res.body?.lrc?.lyric || '',
    tlyric: res.body?.tlyric?.lyric || '',
  };
}

// POST /ai/lyric-translate {id} —— 词源没有官方译文时生成中文 tlyric。
// 结果按词源 id 永久落库：同一首歌在任何歌单/壳里重放零成本命中。
// 幂等：缓存命中/官方译文直回都不消耗 AI 额度
app.post('/ai/lyric-translate', async (c) => {
  const { data: body, error } = await parseJsonBody(c, aiLyricBody, 16 * 1024);
  if (error) return error;
  const id = String(body.id ?? '');
  if (!NETEASE_ID_BOUNDED_RE.test(id) && !QQ_SONG_ID_RE.test(id)
    && !EXT_LYRIC_ID_RE.test(id)) return fail(c, 400, '非法 songId');
  const signal = c.req.raw.signal;

  // 行存在即命中——skip 哨兵（tlyric=''）也是有效缓存项，防止
  // already-zh/无词曲每次重播都重打上游 lyric。但 skip 是启发式判定
  // 的结果（cjkRatio/credit 行都可能误判），给 7 天 TTL：过期按未命中
  // 重判一次，避免一次瞬时误判被永久固化；重新判为 skip 时 DO UPDATE
  // 刷新 updated_at 续期（SQL 细节收敛在 repositories/lyricAi.js）。
  // 缓存查询先于 aiEnabled 闸：AI 关闭后已落库译文（含官方 netease/qq
  // 译文——本来就不依赖 AI）照常下发，只是不再产新译文（verify 同口径）
  const rowOf = () => lyricAiRepo.getCachedTranslation(id, aiModel());
  const skipInsert = (reason) => lyricAiRepo.markTranslationSkip(id, reason);
  const cached0 = rowOf();
  if (cached0) {
    return c.json({ code: 200, tlyric: cached0.tlyric || null, cached: true });
  }
  if (!aiEnabled()) return fail(c, 503, 'AI 未配置', { enabled: false });
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
      // kugou_ 前缀不写哨兵：它出缓存恒 null 的语义是「无取词通道」
      // （accesskey 不落 extId）而非「确证无词」——写 skip:no-lyric 会把
      // 取不到固化成没有 7 天。ytm_/lrclib_ 的 null 是真无词，照写哨兵
      if (!id.startsWith('kugou_')) skipInsert('no-lyric');
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
    // 最坏时长由 TRANSLATE_DEADLINE_MS 单调闸收口：块数上限 10
    // （=MAX_LYRIC_LINES 400 / TRANSLATE_CHUNK 40 的自然推导）× 55s 块
    // 超时理论 550s 已超客户端 300s 包线——时间闸到点不再开新块。
    // 超出的尾部行显示原文（未译行回填原文，见下），不会有错译文；
    // 循环内 signal 检查保证断连即停
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
    // 块数上限覆盖全部去重文本（10 块）；单调时间闸到点不再开新块，
    // 截断部分照常回填原文透出（lines<total），只是不落库
    const chunkLimit = Math.ceil(MAX_LYRIC_LINES / TRANSLATE_CHUNK) * TRANSLATE_CHUNK;
    for (let off = 0; off < Math.min(jobs.length, chunkLimit)
      && Date.now() - startedAt < TRANSLATE_DEADLINE_MS; off += TRANSLATE_CHUNK) {
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
    // 截断产出永不写库：缓存无完成度标记，截断译文固化成「完整缓存」
    // 比现状更差——只在去重文本全覆盖时落库，部分覆盖照旧经响应透出
    if (translated.size === jobs.length) {
      lyricAiRepo.upsertTranslation(id, result, aiModel());
    }
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

// POST /ai/lyric-verify {id, sourceTitle, sourceAuthor, trackId?} —— 外部
// 导入曲经网易云匹配取词时，核验配到的歌词与来源音视频是不是同一首歌。
// trackId 携 yt_ 轨道 id 时反解投稿自署本家进判定语境（声明证据分键）。
// 「错歌词比没歌词更糟」：判不符时前端把歌词整组隐藏。
// 判定按词源 id 落库（song_ai_verdict kind='lyric'）——同一错配不重复问模型
app.post('/ai/lyric-verify', async (c) => {
  const { data: body, error } = await parseJsonBody(c, aiLyricBody, 64 * 1024);
  if (error) return error;
  const id = String(body.id ?? '');
  // 外源词源 id 同收——下载链外源词的归属核验键就是 extId（vkey 同口径）
  if (!NETEASE_ID_BOUNDED_RE.test(id) && !EXT_LYRIC_ID_RE.test(id)) return fail(c, 400, '非法 songId');
  const sourceTitle = String(body.sourceTitle || '').trim();
  const sourceAuthor = String(body.sourceAuthor || '').trim();
  if (!sourceTitle) return fail(c, 400, '缺少 sourceTitle');
  const signal = c.req.raw.signal;
  // yt_ 来源（前端携 trackId=来源轨道 id）先反解投稿自署本家——判官的
  // 声明语境证据。解析必须在 vkey 之前：缓存键含声明位，先定 declMark
  // 才能命中级联/下载链已落的声明语境判定行；AI 关时也照解析——判定
  // 缓存查询同样吃这个键面。fail-soft——上游故障/超时只归「无声明」
  // 不炸请求（8s 硬闸见 lyric-verify.resolveYtDeclared）；trackId 缺席
  // 或非 yt_ 形态时旧路径逐位不动
  const ytM = YT_TRACK_ID_RE.exec(String(body.trackId || ''));
  const declared = ytM ? await resolveYtDeclared(ytM[1], signal) : null;
  // 键入参用未 trim 的原串——键函数内置 slice→lower→trim，与下载链
  // providerData 截断值产同键；先 trim 再传会让截断窗口错位。
  // sourceAuthor 缺省传 '' 而非 undefined——String(undefined) 会把字面量
  // 'undefined' 写进 vkey 签名，与下载链的空串签名产不同键。
  // declMark 与 judgeInner declSeg 出场条件逐字对齐（declTitle||declAuthor）
  // ——声明实参在场但题/名全空时键与 prompt 不劈叉
  const vkey = lyricVerdictKey(id, body.sourceTitle, body.sourceAuthor || '', false,
    Boolean(declared?.title || declared?.author));

  // 署名闸重检（缓存早退与 inflight 命中两处共用；declared/id/signal 取
  // 路由闭包，入参仅为已落库 ok）：已落库的放行判定可能是署名闸接线前
  // 固化的错判（wholicoji 实案：声明本家「ポップしなないで」配到
  // wholicoji 自署作曲条目，v2d3 键落 ok:1 被命中透出）——「ok ∧ 声明
  // 在场 ∧ 网易词源 id」交集不直信，付一跳 lyric + 至多一跳 song_detail
  // 把确定性闸重算一遍：命中否证压回 false（与判定闸同口径不落 verdict、
  // 同款审计行），未命中原样透回。fail-soft：重检路故障/abort 归闸不
  // 适用，传入判定透出不变（AI 是增强不是门禁）；缓存否决/无声明作者/
  // extId 词源零上行原样透回（qq_ 在 L285 已 400 不入此分支）
  const recheckCreditGate = async (ok) => {
    if (!(ok && declared?.author && NETEASE_ID_BOUNDED_RE.test(id))) return ok;
    let refuteSig = null;
    try {
      const { lrc } = await fetchLyricRaw(id, signal);
      const lines = parseLrcLines(lrc);
      const candidate = await resolveCreditGateCandidate({ id, lines, declared, signal });
      refuteSig = composerCreditRefutes(lines, candidate?.artist, declared?.author);
    } catch { /* 上游故障/abort 归不适用——已落库判定继续透出 */ }
    if (refuteSig === null) return ok;
    console.info(`[lyric-verify] 署名否证: 作曲「${sanitizePrompt(refuteSig).slice(0, 120)}」=候选艺人≠声明本家「${sanitizePrompt(declared?.author).slice(0, 120)}」`);
    return false;
  };

  // 已落库判定先查再闸：AI 关掉后缓存 verdict 照常生效（记忆不随开关
  // 旁路），只是不能再产新判定——未命中才 503
  const verdictOf = () => lyricAiRepo.getVerdict(vkey, 'lyric');
  const cached = verdictOf();
  if (cached) {
    // 命中先过署名闸重检：被闸压回的判否是重算结论而非 verdict 记忆透出
    // ——与判定闸同口径不落 verdict、不烙 cached 标记；未否证逐位早退
    const ok = await recheckCreditGate(!!cached.ok);
    if (cached.ok && !ok) return c.json({ code: 200, ok: false });
    return c.json({ code: 200, ok, cached: true });
  }
  if (!aiEnabled()) return fail(c, 503, 'AI 未配置', { enabled: false });
  // 缓存未命中才吃配额
  if (!rateLimit(c, 'ai-verify', 20)) return fail(c, 429, '请求过于频繁');

  // 同 vkey 在途判定去重（与 translate 同款门）
  while (inflightVerify.has(vkey)) {
    await inflightVerify.get(vkey).catch(() => {});
    const hit = verdictOf();
    if (hit) {
      // 跟从者命中与缓存早退同口径过署名闸重检——并发同 vkey/异 trackId
      // 携异声明撞同键时，首判落的放行不许绕过闸直透（重检故障同
      // fail-soft 口径透出 hit 判定）
      const ok = await recheckCreditGate(!!hit.ok);
      if (hit.ok && !ok) return c.json({ code: 200, ok: false });
      return c.json({ code: 200, ok, cached: true });
    }
    // 在途者判定失败（不落库）则循环条件放行，由本次自行重试抢 gate
  }
  let release;
  const myGate = new Promise(r => { release = r; });
  inflightVerify.set(vkey, myGate);

  try {
    if (signal?.aborted) return c.body(null, 499);
    const { lrc } = await fetchLyricRaw(id, signal);
    const lines = parseLrcLines(lrc);
    if (!lines.length) {
      // 没词可验——无词显示不算错配
      return c.json({ code: 200, ok: true, reason: 'no-lyric' });
    }
    // 署名否证闸的候选艺人惰性补料（wholicoji 实案病灶：song_match 绑错
    // 网易条目时本链手里没有候选身份，闸够不着）——仅声明在场 + 词源为
    // 网易条目 + 词内确有作曲署名行才付一跳 song_detail；extId 词源由
    // 形态闸跳过（级联 verifyHit 自带 candidate）、无声明/无署名行零上行。
    // 拿不到归 null 不传——闸对照轴不齐自动不适用
    const candidate = await resolveCreditGateCandidate({ id, lines, declared, signal })
      .catch(() => null);   // 补料自身抛错同归「无候选」——不连带牺牲本次判定
    const ok = await judgeLyricLines({ vkey, lines, title: sourceTitle, author: sourceAuthor, candidate, signal, declared });
    if (ok === null) {
      // 模型没给判定 → 不缓存、不误伤，按「相符」放行
      return c.json({ code: 200, ok: true, inconclusive: true });
    }
    return c.json({ code: 200, ok });
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

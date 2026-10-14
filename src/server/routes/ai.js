const { Hono } = require('hono');
const lyricAiRepo = require('../repositories/lyricAi');
const { parseLrcLines, plainTextLines, lyricVerdictKey, judgeLyricLines, resolveYtDeclared, resolveYtPublishDate, resolveCreditGateCandidate, composerCreditRefutes, sanitizePrompt } = require('../services/lyric-verify');
const { csrfOriginOk } = require('../lib/auth-gate');
const { parseJsonBody } = require('../lib/validate');
const { aiLyricBody } = require('../../shared/contracts.js');
const { fail } = require('../lib/http-error');
const { rateLimit } = require('../lib/rate-limit');
const { callNeteaseApi } = require('../services/netease-api');
const { aiEnabled, aiModel } = require('../lib/ai');

const app = new Hono();

// 词源相关端点只认网易云数字 id、qq_<songmid>（QQ 曲吃自家权威歌词做词源）
// 与 EXT_LYRIC_ID_RE 外源词源 id（ytm_/lrclib_/kugou_——下载链外源兜底的
// 词键，取词走 lyric-external.fetchByExtId 反查支路）；bv_/yt_ 轨道 id
// 仍拒——它们没有可翻译词源，放行只会空耗一次上游调用再 404
// 20 位上限的 bounded 形与共享无界 NETEASE_ID_RE 语义不同——直接用共享名防遮蔽
const { NETEASE_ID_BOUNDED_RE, QQ_SONG_ID_RE, EXT_LYRIC_ID_RE, YT_TRACK_ID_RE, isLikelyChineseLyric } = require('../../shared/predicates.js');
const { neteaseLyricBody } = require('../../shared/lrc.js');
// 翻译业务层（分块/对半拆/时间闸/净化/复贴/哨兵）收敛在 services/lyric-translate——
// 本路由只留 CSRF/参数/限流/inflight/缓存行编排
const {
  MAX_LYRIC_LINES, NON_LYRIC_RE, translateJobTexts, buildTlyric, markSkip,
} = require('../services/lyric-translate');
// 「已是中文语境」跳翻判定收敛在共享层 isLikelyChineseLyric——单看汉字占比
// 会把高汉字密度的日文词（30-50% 是常态）误判 already-zh 跳翻；假名/谚文
// 在场即「需要翻译」硬证据（少女レイ 实案：CJK 0.365 被旧 cjkRatio 跳翻）

// 同 id/vkey 在途去重（值只是完成信号，不载数据——见各路由内注释）
const inflightTranslate = new Map();
const inflightVerify = new Map();

// 来源发布日合法性窗（chrono-guard 规格 §3.1 同式——不为 3 行函数建共享
// 依赖，各消费文件就地实现）：下限 2000-01-01（平台上线前不存在真发布日，
// 再早必脏）；上限 now+24h 容忍时钟偏差——body 回传的超界/非有限数按
// 「未注」丢弃，脏数据不进证据面
const sanePublishMs = (v) => {
  const ms = Number(v);
  return Number.isFinite(ms) && ms >= 946684800000 && ms <= Date.now() + 86400e3 ? ms : 0;
};

// GET /ai/status —— 暴露启用态给前端（模型名可回显；key 绝不出口）
app.get('/ai/status', (c) => {
  return c.json({ code: 200, enabled: aiEnabled(), model: aiEnabled() ? aiModel() : null });
});

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
  // nolyric/uncollected 声明无词、占位词（[99:00]纯音乐请欣赏）归一成空——
  // 归一口径收敛在共享层 neteaseLyricBody（与 QQ 业务码/客户端 getLyrics/
  // 下载链/对齐拉词同口径）；占位词若透下去会被 isLikelyChineseLyric 判
  // already-zh skip，把「其实是纯音乐」固化成「已有中文词」还挡外源兜底；
  // 占位主词的 tlyric 同归空不透出（neteaseLyricBody 已做这层）
  return neteaseLyricBody(res.body);
}

// POST /ai/lyric-translate {id} —— 词源没有官方译文时生成中文 tlyric。
// 结果按词源 id 永久落库：同一首歌在任何歌单/壳里重放零成本命中。
// 幂等：缓存命中/官方译文直回都不消耗 AI 额度
app.post('/ai/lyric-translate', async (c) => {
  // 写请求 CSRF 纵深（与 downloads/match 同口径）：开放部署与
  // DOWNLOAD_TOKEN 旁路不经 authGate，跨站裸 POST 会烧上游抓取+
  // AI 配额+写缓存行——Origin 异源/Sec-Fetch-Site 跨站一律拒
  if (!csrfOriginOk(c)) return fail(c, 403, 'Forbidden');
  const { data: body, error } = await parseJsonBody(c, aiLyricBody, 16 * 1024);
  if (error) return error;
  const id = String(body.id ?? '');
  if (!NETEASE_ID_BOUNDED_RE.test(id) && !QQ_SONG_ID_RE.test(id)
    && !EXT_LYRIC_ID_RE.test(id)) return fail(c, 400, '非法 songId');
  const signal = c.req.raw.signal;

  // 行存在即命中——skip 哨兵（tlyric=''）也是有效缓存项，防止
  // already-zh/无词曲每次重播都重打上游 lyric。但 skip 是启发式判定
  // 的结果（isLikelyChineseLyric/credit 行都可能误判），给 7 天 TTL：过期按未命中
  // 重判一次，避免一次瞬时误判被永久固化；重新判为 skip 时 DO UPDATE
  // 刷新 updated_at 续期（SQL 细节收敛在 repositories/lyricAi.js）。
  // 缓存查询先于 aiEnabled 闸：AI 关闭后已落库译文（含官方 netease/qq
  // 译文——本来就不依赖 AI）照常下发，只是不再产新译文（verify 同口径）
  // AI 译文行按 模型@prompt版本 盐键读（translationModelKey——盐规则
  // 收口在 repositories/lyricAi）；skip 哨兵与官方译文不参盐照常命中
  const rowOf = () => lyricAiRepo.getCachedTranslation(id, lyricAiRepo.translationModelKey(aiModel()));
  const skipInsert = (reason) => markSkip(id, reason);
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
    if (isLikelyChineseLyric(allText)) {
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
    // 逐块打 AI + 对半拆自愈 + 单调时间闸收敛在 services/lyric-translate
    const { aborted, translated } = await translateJobTexts(jobs, { signal });
    if (aborted || signal?.aborted) return c.body(null, 499);
    if (!translated.size) return fail(c, 502, 'AI 未返回有效翻译');
    const result = buildTlyric({ lrc, lines, translated });
    // 截断产出永不写库：缓存无完成度标记，截断译文固化成「完整缓存」
    // 比现状更差——只在去重文本全覆盖时落库，部分覆盖照旧经响应透出
    if (translated.size === jobs.length) {
      lyricAiRepo.upsertTranslation(id, result, lyricAiRepo.translationModelKey(aiModel()));
    }
    return c.json({ code: 200, tlyric: result, lines: translated.size, total: lines.length, source: 'ai' });
  } catch (e) {
    if (signal?.aborted) return c.body(null, 499);
    // answer 对象（{status,body,cookie[]}）无 .message——裸 dump 会把
    // 上游 Set-Cookie 指纹整包打进日志，归一成 status+body.code 留痕
    console.error('[ai] lyric-translate 失败:', e?.message || (e && typeof e === 'object' ? `answer.status=${e.status} body.code=${e.body?.code}` : e));
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
  // 写请求 CSRF 纵深（与 /ai/lyric-translate 同口径）
  if (!csrfOriginOk(c)) return fail(c, 403, 'Forbidden');
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
  // 源发布日（vkey c1 语境位）：客户端持久快照优先（body.publishedAt），
  // yt_ 缺席回退惰性反解（resolveYtPublishDate 8s/60s memo——与 declared
  // 同位同价）；仅网易条目词源配日期轴——extId 无候选日期对照（级联
  // verifyHit/下载链键面守恒）。与 declared 同纪律先于 vkey：c1 键位
  // 落定才能命中「日期语境」已落的判定行；脏 body 值经 sanePublishMs
  // 丢弃按未注（fail-soft 不炸请求）
  const srcPubMs = NETEASE_ID_BOUNDED_RE.test(id)
    ? (sanePublishMs(body.publishedAt)
      || (ytM ? (await resolveYtPublishDate(ytM[1], signal)) || 0 : 0))
    : 0;
  // 键入参用未 trim 的原串——键函数内置 slice→lower→trim，与下载链
  // providerData 截断值产同键；先 trim 再传会让截断窗口错位。
  // sourceAuthor 缺省传 '' 而非 undefined——String(undefined) 会把字面量
  // 'undefined' 写进 vkey 签名，与下载链的空串签名产不同键。
  // declMark 与 judgeInner declSeg 出场条件逐字对齐（declTitle||declAuthor）
  // ——声明实参在场但题/名全空时键与 prompt 不劈叉；chronoMark 同纪律携
  // srcPubMs>0——与 judgeInner pubSeg 出场条件逐字对齐，携日期语境的
  // 判定与无日期旧键分家互不命中
  const vkey = lyricVerdictKey(id, body.sourceTitle, body.sourceAuthor || '', false,
    Boolean(declared?.title || declared?.author), srcPubMs > 0);

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
      // 与下方判定链同口径的纯文本兜底——无时戳词的裸署名行（'作曲：X'
      // 不带方括号）同样要够得着闸，不然纯文本形态的已落库 ok 绕过重检
      let lines = parseLrcLines(lrc);
      if (!lines.length) lines = plainTextLines(lrc);
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
    // 纯文本词与真空词分开（与 verifyHit/verifyDownloadOwnership 同口径）：
    // 剥标签行后仍有词文的照常过判定链，剥完真空（纯元行/空白）才按
    // 「没词可验」放行
    let lines = parseLrcLines(lrc);
    if (!lines.length) lines = plainTextLines(lrc);
    if (!lines.length) {
      // 没词可验——无词显示不算错配
      return c.json({ code: 200, ok: true, reason: 'no-lyric' });
    }
    // 署名否证闸的候选艺人惰性补料（wholicoji 实案病灶：song_match 绑错
    // 网易条目时本链手里没有候选身份，闸够不着）——声明在场 + 词源为
    // 网易条目 + 词内确有作曲署名行才付一跳 song_detail；wantDates 携
    // 源侧日期在场位——无声明/无署名行的形态同样付跳取候选上架日
    // （署名闸要艺人、时间轴要 publishTime，一跳双供）；双触发位全缺零上行。
    // 已知盲区如实记：本路由手里只有词源 id 没有候选 meta（fetchLyricRaw
    // 只回词文），extId 词源（ytm_/lrclib_/kugou_）又没有网易条目可反查——
    // 声明在场时署名闸对 extId 词源不适用。级联 verifyHit 自带 candidate、
    // 下载链 verifyDownloadOwnership 有 candidate 形参可收口；本路由缺这
    // 半供给，拿不到归 null 不传——闸对照轴不齐自动不适用
    const candidate = await resolveCreditGateCandidate({ id, lines, declared, signal, wantDates: srcPubMs > 0 })
      .catch(() => null);   // 补料自身抛错同归「无候选」——不连带牺牲本次判定
    const ok = await judgeLyricLines({ vkey, lines, title: sourceTitle, author: sourceAuthor, candidate, signal, declared, publishedAt: srcPubMs || undefined });
    if (ok === null) {
      // 模型没给判定 → 不缓存、不误伤，按「相符」放行
      return c.json({ code: 200, ok: true, inconclusive: true });
    }
    return c.json({ code: 200, ok });
  } catch (e) {
    if (signal?.aborted) return c.body(null, 499);
    // 同 lyric-translate：answer 对象裸 dump 会泄上游 cookie——归一留痕
    console.error('[ai] lyric-verify 失败:', e?.message || (e && typeof e === 'object' ? `answer.status=${e.status} body.code=${e.body?.code}` : e));
    // 核验通道故障按相符放行——AI 是增强不是门禁
    return c.json({ code: 200, ok: true, inconclusive: true });
  } finally {
    if (inflightVerify.get(vkey) === myGate) inflightVerify.delete(vkey);
    release();
  }
});

module.exports = app;

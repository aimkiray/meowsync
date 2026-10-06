const { callNeteaseApi } = require('./netease-api');
const { aiEnabled, askAiJson, aiModel } = require('../lib/ai');
const {
  scoreCandidate, normToken, noiseKey, QUERY_NOISE,
  ACCEPT_SCORE, GRAY_SCORE, DUR_HARD_GATE_SEC,
} = require('./netease-score');
// 标题变体层与外源歌词级联（lyric-external.js）共用同一份规则集——
// 'Xを歌いました ／ UP主'/'Title ver.EMA' 这类 UGC 噪声形态在漏斗层统一
// 剥缀，四个匹配入口（yt/bv/qq/rematch）一次全愈
const { titleVariantsOf, isPlaceholderAuthor, normKey } = require('../../shared/title-variants.js');
const songMatchRepo = require('../repositories/songMatch');

// 外部导入曲（B 站/YouTube/QQ）匹配网易云词源：每个候选串云搜 limit:10，
// 全候选过 netease-score 打分池（reject 滤掉，按分降序）——
//   ≥75 确定性收；50-74 灰区有 AI 按分降序复核（否决记 vetoedIds 取下一个，
//   同串连否两个判空转下一串），无 AI 保持宽松语义灰区 top 直接收；<50 丢弃。
// 硬闸/封顶在打分器内：源有时长且差>45s reject、源无伴奏标候选带伴奏标
// reject、title<15 总分不过灰区、中立艺人分配非精确 title 压到灰区下——
// 纯时长命中永不确定性收（错词源比没词源更糟的哲学不变，只是把单维判据
// 换成证据总分）。中立艺人面下「仅剥缀变体作证」的精确 title 命中由
// searchOnce 内钳回灰区顶（打分器不动）——同名异曲不走确定性通道固化。
// 标类硬拒连 AI 兜底池都开除；时长类硬拒留池等 120s 粗闸
const MATCH_DUR_TOLERANCE_SEC = DUR_HARD_GATE_SEC;

// 每首曲目的 AI 调用硬上界（confirm + extract + pick 合计）——超预算后
// 按 verdict-null 同语义收下当前候选（AI 是增强不是门禁）
const AI_CALL_BUDGET = 4;

// 名命中是否需要 AI 复核：查询是多 token 组合（「艺人 歌名」形态）且候选
// 艺人与（源作者 ∪ 查询内 token）零交集 → 同名错配风险真实存在。
// 打分池化后该判定已被吸收（零交集 → artist 0 分 → 进不了 ACCEPT 线自动
// 落灰区复核），保留导出作契约工具。
const nameHitNeedsConfirm = (song, q, sourceInfo) => {
  const tokens = String(q).trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return false;
  // author 同样过噪声闸——频道名就叫 'Cover'/'LIVE官方' 时它是假引用
  const refs = [sourceInfo?.author, ...tokens]
    .filter(t => !QUERY_NOISE.has(noiseKey(t)))
    .map(normToken).filter(x => x.length >= 2);
  const arts = (Array.isArray(song.ar || song.artists) ? (song.ar || song.artists) : [])
    .map(a => normToken(a?.name)).filter(x => x.length >= 2);
  return !arts.some(a => refs.some(r =>
    a.includes(r)
    // 反向（ref 吞艺人名）加两道闸：艺人本身叫 'Live'/'MV' 之类的噪声词，
    // 或短到 <3 字符——'olive' 吞 'live'、'lemon' 吞 'lemo' 都是假交集
    || (a.length >= 3 && !QUERY_NOISE.has(noiseKey(a)) && r.includes(a))));
};

// 进 prompt 的字段统一净化：来源标题/频道名是 UGC、上游歌名/歌手/专辑
// 是第三方数据——剥换行与方括号，至少让注入无法伪造消息边界/候选行
const cleanPrompt = (s) => String(s ?? '')
  .replace(/[\r\n\[\]]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);

const songDesc = (s) => {
  const arr = Array.isArray(s?.ar || s?.artists) ? (s.ar || s.artists) : [];
  const artists = arr.map(a => a?.name).filter(Boolean).join('/') || '未知';
  const dur = Math.round((s?.dt || s?.duration || 0) / 1000);
  const album = s?.al?.name || s?.album?.name || '未知';
  return `${cleanPrompt(s?.name)} — ${cleanPrompt(artists)}（${dur}s，专辑《${cleanPrompt(album)}》）`;
};

// AI 复核：灰区候选是错配高发场景——有能力时让模型复核；模型拒答/超时
// 返回 null 按原启发式放行（AI 是增强不是门禁）
async function aiConfirmMatch(song, sourceInfo, durationSec, signal) {
  const ans = await askAiJson({
    // match 路径嵌在 25s resolve 预算内——AI 单次调用收窄到 10s，
    // 慢端点（挂起/排队）不能独占整个预算让启发式链没机会跑
    timeoutMs: 10000,
    system: '你是音乐识别助手。判断候选歌曲与来源音/视频是不是同一首歌'
      + '（同一录音、官方版本，或同一首歌的不同平台发布）。歌名不同语言/译名差异属正常。'
      + '只输出 JSON {"match":true|false}。',
    user: `来源：${cleanPrompt(sourceInfo.title)} — ${cleanPrompt(sourceInfo.author) || '未知'}（${durationSec || '?'}s）\n候选：${songDesc(song)}`,
    maxTokens: 32,
    signal,
  });
  return ans && typeof ans.match === 'boolean' ? ans.match : null;
}

// AI 再生查询：启发式候选串全是脏标题时（韩翻「歌名┃频道 COVER」、搬运号
// 塞梗词等），云搜只回噪声、池子里根本没有正主——让模型从标题/作者抽出
// 干净查询词再搜一轮，把正主装进候选池。产出串同样要过打分池闸门
async function aiExtractQueries(sourceInfo, signal) {
  const ans = await askAiJson({
    system: '你是音乐识别助手。从音/视频标题与作者名提取用于音乐平台搜索的查询词。'
      + '标题常带频道名/COVER/翻唱/分隔符等噪声，作者常是翻唱者而非原唱。'
      + '给出至多 3 条查询（首选干净歌名，其次「原唱/艺人 歌名」组合）。'
      + '提取不出返回 {"queries":[]}。只输出 JSON。',
    user: `标题：${cleanPrompt(sourceInfo.title)}\n作者/频道：${cleanPrompt(sourceInfo.author) || '未知'}`,
    maxTokens: 96,
    timeoutMs: 10000,
    signal,
  });
  const raw = Array.isArray(ans?.queries) ? ans.queries : [];
  return [...new Set(raw
    // 只收字符串元素——对象/数字经 String() 会产垃圾查询白烧上游；
    // 控制符（C0/DEL/bidi）会进 keywords 与日志/持久化 matchedBy，一并剥
    .filter(q => typeof q === 'string')
    .map(q => q.replace(/[\p{C}]+/gu, ' ').replace(/\s+/g, ' ').trim())
    .filter(q => q.length >= 2 && q.length <= 80))]
    .slice(0, 3);
}

// AI 兜底：启发式全失败时，把所有查询见过的候选整批给模型挑——
// 一次调用覆盖 ≤10 候选，比逐候选问省额度且上下文更全
async function aiPickMatch(seenSongs, sourceInfo, durationSec, signal, vetoedIds = null, preferIds = null, scoreById = null, rejectedIds = null) {
  // 已被否决的候选不进池——否决后再被兜底挑回是语义矛盾；打分器标类硬拒
  // （伴奏/inst/karaoke——与源不是同类内容）同样开除出池，时长类硬拒留池：
  // 45s<diff≤120s 的「长片头视频真匹配」只能靠尾部 120s 粗闸救济。
  // preferIds（再生轮新装入的候选）排在截断窗口前部——启发式批先填 ≥10 时
  // 再生批会被 slice 挤掉，而那恰是正主在的批；同侧内按打分降序
  const scoreOf = (s) => scoreById?.get(s.id) ?? 0;
  const all = [...seenSongs.values()].filter(s =>
    !vetoedIds?.has(String(s.id)) && !rejectedIds?.has(String(s.id)));
  const list = (preferIds?.size
    ? [...all.filter(s => preferIds.has(s.id)).sort((a, b) => scoreOf(b) - scoreOf(a)),
      ...all.filter(s => !preferIds.has(s.id)).sort((a, b) => scoreOf(b) - scoreOf(a))]
    : all.sort((a, b) => scoreOf(b) - scoreOf(a))).slice(0, 10);
  if (!list.length) return null;
  const desc = list.map((s, i) => `${i + 1}. ${songDesc(s)}`).join('\n');
  const ans = await askAiJson({
    system: '你是音乐识别助手。从候选列表选出与来源音/视频同一首歌的编号'
      + '（同一录音/官方版本/同名同曲的不同发布都算；翻唱/混音/live 版本不算）。'
      + '都不符返回 {"match":0}，能确定返回 {"match":编号}。只输出 JSON。',
    user: `来源：${cleanPrompt(sourceInfo.title)} — ${cleanPrompt(sourceInfo.author) || '未知'}（${durationSec || '?'}s）\n候选：\n${desc}`,
    maxTokens: 32,
    timeoutMs: 10000,
    signal,
  });
  // match:true（模型混用 confirm 形态）Number(true)=1 会假命中第 1 候选——
  // 布尔与 null 显式排除后再转数字
  if (typeof ans?.match !== 'number' && typeof ans?.match !== 'string') return null;
  const n = Number(ans.match);
  if (!Number.isInteger(n) || n < 1 || n > list.length) return null;
  const pick = list[n - 1];
  // AI 兜底仍过粗粒度时长闸（120s，约为确定性窗口的 3 倍——片头尾垫长
  // 可过，但「时长差几分钟的另一首歌」不能仅凭模型点头就命中）
  const pickDt = (pick.dt || pick.duration || 0) / 1000;
  if (durationSec > 0 && pickDt > 0 && Math.abs(pickDt - durationSec) > 120) {
    console.info(`[ai-pick] 时长差 ${Math.round(Math.abs(pickDt - durationSec))}s 超闸，弃票: ${songDesc(pick)}`);
    return null;
  }
  return pick;
}

// ── song_match 缓存（repositories/songMatch.js）──────────────────────
// trackId 即客户端曲目 id（bv_<bvid>[_pN]/yt_<videoId>/qq_<mid>）——经
// sourceInfo.trackId 传入，不传则不读不写（测试/游离调用方零 DB 依赖）。
// 正向行只存 netease_id：命中后经 song_detail 单跳回水化出完整 matched
// 投影，回水化失败退成裸 {id} 壳（name/ar/al 缺失 → 前端走提取名兜底，
// 词源 neteaseId 不失）。负缓存（netease_id NULL）记「搜过但没中」，
// 7d TTL 在读查询判，模型键控不对称：正行 model=''（纯启发式）永命中、
// AI 参与结果只在同模型下复用；负行必须 model 精确同模——无 AI 期攒的
// 「搜不到」不能挡住配上 AI 后本可救回的匹配。另：全串传输失败的结果
// 不落负缓存（searchedAny=false → writeMatchCache 跳过）——风控/断网
// 期跑一次批量导入不该把整批 trackId 固化成一周无词源
const trackIdOf = (sourceInfo) => {
  const t = sourceInfo?.trackId;
  return (typeof t === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(t)) ? t : null;
};

async function cachedMatch(trackId, signal) {
  // 当前生效模型与写侧同口径：AI 此刻不可用 → 本次运行等价纯启发式
  // （model=''），只认 '' 键控的行——否则「配了模型名但 AI 关着」的部署里
  // 启发式负行永远读不回来，负缓存形同虚设
  const row = songMatchRepo.getMatch(trackId, aiEnabled() ? (aiModel() || '') : '');
  if (!row) return null;
  if (row.netease_id == null) {
    return { song: null, query: row.matched_by || null, score: row.score ?? null, cached: true };
  }
  const rawId = String(row.netease_id);
  const bare = { id: /^\d+$/.test(rawId) ? Number(rawId) : rawId };
  let song = bare;
  try {
    const res = await callNeteaseApi('song_detail', { ids: rawId }, { signal });
    const s = res.body?.songs?.[0];
    if (s && typeof s === 'object') song = s;
  } catch { /* 回水化失败——裸 id 壳仍保住词源 */ }
  return { song, query: row.matched_by || null, score: row.score ?? null, cached: true };
}

function writeMatchCache(trackId, r) {
  // 全灭=传输故障而非「搜过没中」——负缓存会把 7d 内的重试全部短路成
  // 无词源；任一云搜 resolve（含空集）才算真搜过，可落负行。正命中永远写
  if (!r?.song && !r?.searchedAny) return;
  try {
    songMatchRepo.upsertMatch(trackId,
      r?.song?.id != null ? String(r.song.id) : null,
      r?.query || '', Number.isFinite(r?.score) ? Math.round(r.score) : null,
      r?.ai ? (aiModel() || '') : '');
  } catch (e) {
    // 缓存是增强不是关键路径——DB 不可写不该炸掉匹配
    console.warn('[match] song_match 缓存写入失败:', e?.message || e);
  }
}

// ── candidates 标题变体展开 ──
// 输入 candidates 常带 UGC 噪声（'Xを歌いました ／ UP主'、'Title ver.EMA'、
// 'covered by X'、'【栏目】Title'）——漏斗层统一过 titleVariantsOf 展开剥缀
// 形态，四个入口（yt/bv/qq/rematch）一次全愈，不再依赖各路由自己的清洗腿。
// 逐 candidate 交错展开（raw 占首、剥缀形态殿后）→ normKey 大小写不敏感
// 去重 → cap 8 封顶：25s 预算下单串 ~0.5s 云搜，8 串稳进预算；原 ~4 串
// 上限外的增量正是变体收益位。
const SEARCH_QUERY_CAP = 8;

// 展开结果行首的占位作者 token 剥除：路由侧把 author 拼进候选串时
// （'_ sasayaku…'）占位前缀本身是检索噪声，且会让艺人锚剥缀错位——
// '_ sasayaku' → 'sasayaku'。行首纯分隔料 run（'-- '/'__ '）恒剥——
// 它不含词义，'_ sasayaku' 正是目标病例；词形 token（含
// 'various artists' 二词组）只在头词 normKey ∈ placeholderKeys（本曲
// sourceInfo artists∪author 中占位成员的集合）时才剥——全局占位表
// 直接套任意标题首词会把 'Unknown Pleasures'/'Various Positions' 这类
// 真名剥残、原始串整列丢失；sourceInfo 无占位作者时词形剥头整体不启用。
// 迭代剥至非占位词（'unknown _ X' 叠罗汉形态也收），≤4 轮防死循环；
// 全剥空回 '' 由调用方丢弃（'--' 纯噪声串不构成检索词）。
// 括弧字符刻意不进分隔料——'【栏目】X' 这类括弧组有配对语义，
// 留给变体规则的 HEAD_BANG/TAIL_GROUP 整组剥
const HEAD_JUNK_RE = /^[^\p{L}\p{N}【】「」『』《》（）()\[\]]+/u;
const HEAD_WORD_RE = /^[\p{L}\p{N}]+/u;
const HEAD_BIGRAM_RE = /^[\p{L}\p{N}]+\s+[\p{L}\p{N}]+/u;
function stripPlaceholderHead(s, placeholderKeys) {
  let t = String(s || '').trim();
  for (let i = 0; i < 4 && t; i++) {
    const junk = t.match(HEAD_JUNK_RE);
    if (junk) { t = t.slice(junk[0].length).trimStart(); continue; }
    const bigram = t.match(HEAD_BIGRAM_RE)?.[0];
    if (bigram && placeholderKeys.has(normKey(bigram))) { t = t.slice(bigram.length); continue; }
    const word = t.match(HEAD_WORD_RE)?.[0];
    if (word && placeholderKeys.has(normKey(word))) { t = t.slice(word.length); continue; }
    break;
  }
  return t.trim();
}

// informativeArtist：sourceInfo.artists/author 里首个非占位艺人——占位值
// （'_'/'unknown'）传 ''，避免 '_ X' 这类假锚污染变体生成（j/k 艺人锚规则
// 会拿 '_' 当锚把标题首词吃掉）
// variantKeys（可选收集器出参）：收回「剥缀产出串」的 normToken 集——
// 与所属原始 candidate 归一同键的产出（'_ X' 剥头/'X【MV】' 清洗在打分器
// normToken 归一下本就同串）不算变体；真·剥缀形态才入集。searchOnce 的
// S1 钳制拿它判「精确命中是否仅由变体作证」，打分比对同口径用 normToken
function expandSearchQueries(candidates, sourceInfo, variantKeys = null) {
  const informativeArtist = [
    ...(Array.isArray(sourceInfo?.artists) ? sourceInfo.artists : []),
    sourceInfo?.author,
  ].map(x => String(x || '').trim())
    .find(x => x && !isPlaceholderAuthor(x)) || '';
  // 本曲实际挂的占位作者集（normKey）——词形剥头闸（S3）：头词命中这个
  // 集合才剥；空集=词形剥头整体不启用，'Unknown Soldier' 类真名不剥残
  const placeholderKeys = new Set(
    [...(Array.isArray(sourceInfo?.artists) ? sourceInfo.artists : []),
      sourceInfo?.author]
      .map(x => String(x || '').trim())
      .filter(x => x && isPlaceholderAuthor(x))
      .map(normKey));
  const seen = new Set();
  const out = [];
  for (const q of (Array.isArray(candidates) ? candidates : [])) {
    const qk = normToken(q);
    for (const v of titleVariantsOf(q, informativeArtist)) {
      const t = stripPlaceholderHead(v, placeholderKeys);
      if (!t) continue;
      const k = normKey(t);
      if (seen.has(k)) continue;
      seen.add(k);
      if (variantKeys) {
        const tk = normToken(t);
        if (tk && tk !== qk) variantKeys.add(tk);
      }
      out.push(t);
      if (out.length >= SEARCH_QUERY_CAP) return out;
    }
  }
  return out;
}

// candidates 按优先级排（提取名/频道歌手组合 → 清洗标题），逐个云搜打分；
// 首个产出可收命中的串即返回（确定性 ≥75 或灰区收下）。signal：客户端断连/
// 调用方主动作废时早退，不刷无意义的上游云搜。
// sourceInfo={title,author,artists[],titles[],trackId,durationSec?}：
//   AI 增强用——灰区复核 + 启发式全灭时再生/兜底挑；artists/titles 喂打分器，
//   trackId 接 song_match 缓存键。AI 未配置时语义与宽松启发式一致
// opts={excludeIds}：请求级预置否决集（/match/retry 纠错口）——并入
//   vetoedIds，与 AI 否决同规则永不复活
async function matchNeteaseSong(candidates, durationSec, tag = 'import', signal = null, sourceInfo = null, opts = null) {
  // 输入 candidates 常带 UGC 噪声——漏斗层统一展开标题变体（去重、cap 8、
  // 剥行首占位作者 token），展开后的列表同时进 srcBaseTitles 打分参照面。
  // variantKeys 收回「剥缀产出串」normToken 集，origTitleKeys 记调用方
  // 原始串 ∪ 源标题集——S1 变体命中钳制的判定面（见 searchOnce 打分循环）
  const variantKeys = new Set();
  const origTitleKeys = new Set(
    [...(Array.isArray(candidates) ? candidates : []),
      ...(Array.isArray(sourceInfo?.titles) ? sourceInfo.titles : []),
      sourceInfo?.title]
      .map(x => normToken(x)).filter(Boolean));
  candidates = expandSearchQueries(candidates, sourceInfo, variantKeys);
  const seenSongs = new Map();
  const scoreById = new Map();
  const vetoedIds = new Set();
  const rejectedMarkerIds = new Set(); // 标类硬拒——连 AI 兜底池都开除
  let searchedAny = false; // 任一云搜 resolve（空集也算搜过）——全灭=传输故障
  for (const id of (Array.isArray(opts?.excludeIds) ? opts.excludeIds : [])) {
    if (id != null) vetoedIds.add(String(id));
  }
  const useAi = aiEnabled() && !!sourceInfo?.title;
  let aiLeft = AI_CALL_BUDGET;
  let aiTouched = false;

  // 打分参照源：titles = 查询串 ∪ 候选串 ∪ 源标题（候选串本身是「我们认为
  // 歌名长这样」的提取产物，是最强比对面）；artists = artists[] ∪ author
  // ——占位作者（'_'/'unknown'/'VA'）滤出不占槽：它不含艺人信息，
  // 留着只会混进 refMembers 比对（normToken 后空串虽不收，过滤语义更诚实）
  const srcArtists = [...new Set(
    [...(Array.isArray(sourceInfo?.artists) ? sourceInfo.artists : []),
      sourceInfo?.author]
      .map(x => String(x || '').trim())
      .filter(x => x && !isPlaceholderAuthor(x)))];
  const srcBaseTitles = [
    ...(Array.isArray(sourceInfo?.titles) ? sourceInfo.titles : []),
    ...(Array.isArray(candidates) ? candidates : []),
    sourceInfo?.title];
  const srcFor = (q) => ({
    titles: [...new Set([q, ...srcBaseTitles]
      .map(x => String(x || '').trim()).filter(Boolean))],
    artists: srcArtists,
    durationSec: Number.isFinite(durationSec) ? durationSec : 0,
  });

  // 单条查询的云搜 + 打分池：reject 滤掉、按分降序——≥ACCEPT 确定性收；
  // 灰区有 AI 按分降序复核（≤2 次/串且受每首 AI_CALL_BUDGET 总闸），否决
  // 进 vetoedIds 取下一个；无 AI 宽松收 top。未命中也把全量结果记入
  // seenSongs/scoreById 供再生/兜底复用
  const searchOnce = async (q, collect = null) => {
    const res = await callNeteaseApi('cloudsearch', { keywords: q, type: '1', limit: '10' }, { signal });
    searchedAny = true; // resolve 即算搜过——空集也是上游给的真实回答
    if (signal?.aborted) return null;
    // 上游数组混入 null 元素会让下游裸取字段 TypeError——先净化
    const songs = (res.body?.result?.songs || []).filter(s => s && typeof s === 'object');
    if (!songs.length) return null;
    for (const s of songs) if (s.id != null) { seenSongs.set(s.id, s); collect?.add(s.id); }
    const src = srcFor(q);
    const scored = [];
    for (const s of songs) {
      // veto 是「(源,候选)对」级判定与证据类型无关——被否的 id 不经任何
      // 路径复活（含后续串），否则同一错配换个查询串就钻回来
      if (s.id == null || vetoedIds.has(String(s.id))) continue;
      const sc = scoreCandidate(s, src);
      if (sc.reject) {
        if (sc.rejectKind === 'marker') rejectedMarkerIds.add(String(s.id));
        continue;
      }
      // S1 钳制：源艺人面缺位（srcArtists 空→中立 15 分）时，仅由剥缀变体
      // 作证的 title=50 精确命中绕过了打分器的中立压分（只在 title<50
      // 生效）——50+15+时长≈85 会把同名异曲确定性收进 song_match 正行
      // 无 TTL 固化。候选名归一 ∈ 变体集且 ∉ 原始串/源标题集 → 钳到灰区
      // 顶走既有灰区流：AI 在→复核过照样收/否决取下一个；AI 不在→宽松
      // 收 top。召回不变，只关这条确定性错配通道
      if (sc.score >= ACCEPT_SCORE && !srcArtists.length) {
        const cn = normToken(s.name);
        if (cn && variantKeys.has(cn) && !origTitleKeys.has(cn)) {
          console.info(`[${tag}] 变体命中钳灰区: ${songDesc(s)} ← ${q}`);
          sc.score = ACCEPT_SCORE - 1;
        }
      }
      scoreById.set(s.id, Math.max(scoreById.get(s.id) ?? 0, sc.score));
      if (sc.score >= GRAY_SCORE) scored.push({ s, score: sc.score });
    }
    scored.sort((a, b) => b.score - a.score);
    if (!scored.length) return null;
    if (scored[0].score >= ACCEPT_SCORE) {
      return { song: scored[0].s, query: q, score: scored[0].score };
    }
    // 灰区：无 AI 保持宽松语义（top 直接收）；有 AI 逐候选复核——复核通过/
    // 哑火/预算耗尽都收下当前候选（增强不是门禁），明确否决才取下一个；
    // 同串连否两个=这串候选池本身可疑，余下候选不免检收下——判空转下一串
    if (!useAi) return { song: scored[0].s, query: q, score: scored[0].score };
    let confirms = 0, vetoes = 0;
    for (const g of scored) {
      if (signal?.aborted) return null;
      if (confirms < 2 && aiLeft > 0) {
        confirms++; aiLeft--; aiTouched = true;
        const verdict = await aiConfirmMatch(g.s, sourceInfo, durationSec, signal);
        if (verdict === false) {
          vetoedIds.add(String(g.s.id));
          console.info(`[${tag}] AI 否决灰区候选: ${songDesc(g.s)} ← ${q}`);
          if (++vetoes >= 2) return null;
          continue;
        }
        return { song: g.s, query: q, score: g.score, aiChecked: true };
      }
      return { song: g.s, query: q, score: g.score };
    }
    return null;
  };

  const warnFail = (q, e) => {
    // 上游 reject(answer) 形态无 .message——归一化再记
    const why = e?.message || (e?.body ? `code=${e.body.code ?? '?'}` : String(e));
    console.warn(`[${tag}] 网易云搜索「${q}」失败:`, why);
  };

  for (const q of candidates) {
    if (signal?.aborted) break;
    if (!q) continue;
    try {
      const hit = await searchOnce(q);
      if (hit) return { ...hit, ai: aiTouched, searchedAny };
    } catch (e) {
      warnFail(q, e);
    }
  }
  // 启发式链全灭 → ①AI 再生干净查询词补一轮（脏标题串搜不到正主时
  // 唯一把正主装进候选池的路），产出仍过打分池/否决闸——且再生轮命中
  // 额外过一次 AI 复核（模型产出的查询串离 ground truth 远一跳，臆造
  // 真实歌名会被确定性放行，不能免检）；
  // ②AI 兜底从全量已见候选里挑（如『短视频标题串了梗词导致
  // 所有搜索串都搜不到正主』的场景——直接看整批候选比再搜一轮更有效）
  // query/matchedBy 值域：'<搜索串>'（启发式）/ 'ai:regen:<串>' / 'ai:pick'
  const regenIds = new Set();
  if (useAi && !signal?.aborted && aiLeft > 0) {
    aiLeft--; aiTouched = true;
    const candSet = new Set(candidates.map(q => String(q || '').trim().toLowerCase()));
    const regen = (await aiExtractQueries(sourceInfo, signal).catch(() => []))
      .filter(q => !candSet.has(q.toLowerCase())); // 与已试过的串去重，不白烧上游
    for (const q of regen) {
      if (signal?.aborted) break;
      try {
        const hit = await searchOnce(q, regenIds);
        if (!hit) continue;
        // searchOnce 内已问过的同对（aiChecked）不重复问——AI 哑是粘性的
        if (!hit.aiChecked && aiLeft > 0) {
          aiLeft--; aiTouched = true;
          const verdict = await aiConfirmMatch(hit.song, sourceInfo, durationSec, signal);
          if (verdict === false) {
            vetoedIds.add(String(hit.song.id));
            console.info(`[${tag}] AI 否决再生命中: ${songDesc(hit.song)} ← ${q}`);
            continue;
          }
        }
        console.info(`[${tag}] AI 再生查询命中「${q}」: ${songDesc(hit.song)} ← ${sourceInfo.title}`);
        return { song: hit.song, query: `ai:regen:${q}`, score: hit.score, ai: aiTouched, searchedAny };
      } catch (e) {
        warnFail(q, e);
      }
    }
  }
  if (useAi && seenSongs.size && !signal?.aborted && aiLeft > 0) {
    aiLeft--; aiTouched = true;
    // 畸形上游数据（ar 非数组等）在 desc 构建处可能 TypeError——
    // 兜底是增强路径，异常按「无兜底」降级而非 502；再生批优先入池
    const pick = await aiPickMatch(seenSongs, sourceInfo, durationSec, signal, vetoedIds, regenIds, scoreById, rejectedMarkerIds)
      .catch(() => null);
    if (pick) {
      console.info(`[${tag}] AI 兜底命中: ${songDesc(pick)} ← ${sourceInfo.title}`);
      return { song: pick, query: 'ai:pick', score: scoreById.get(pick.id) ?? null, ai: aiTouched, searchedAny };
    }
  }
  return { song: null, query: null, score: null, ai: aiTouched, searchedAny };
}

// 归一 matched 投影：三路由 resolve/批量导入共用同一下发形态
function toMatchedJson(song) {
  return song ? {
    id: song.id,
    name: song.name,
    ar: song.ar || song.artists || [],
    al: song.al || song.album || {},
  } : null;
}

// 单条匹配带总预算：race(match, 预算)——预算耗尽不只让 race 判负，
// abort 停掉在途云搜/AI 复核，否则孤儿流程继续烧上游请求与 AI 额度。
// reqSignal 级联客户端断连（Hono c.req.raw.signal）
// sourceInfo.trackId 存在时走 song_match 缓存：命中直接回（含负缓存），
// 未命中跑完把结果（含未中）写回——abort/预算掐断的结果不写，半截判定
// 不配进缓存。skipCache=/match/retry 纠错口专用：跳过读但仍覆写
async function matchWithBudget({ candidates, durationSec, tag, reqSignal, sourceInfo, budgetMs = 25000, skipCache = false, excludeIds = null }) {
  const trackId = trackIdOf(sourceInfo);
  if (trackId && !skipCache) {
    const hit = await cachedMatch(trackId, reqSignal).catch(() => null);
    if (hit) return hit;
  }
  const budgetCtrl = new AbortController();
  let budgetTimer;
  const budget = new Promise(resolve => {
    budgetTimer = setTimeout(() => {
      budgetCtrl.abort();
      resolve({ song: null, query: null, score: null });
    }, budgetMs);
    budgetTimer.unref?.();
  });
  try {
    const r = await Promise.race([
      matchNeteaseSong(candidates, durationSec, tag,
        AbortSignal.any([reqSignal, budgetCtrl.signal].filter(Boolean)), sourceInfo,
        { excludeIds }),
      budget,
    ]);
    // 预算/断连掐断的半截判定不缓存；全灭=传输故障的「空结果」由
    // writeMatchCache 内 searchedAny 闸再拦一道——负缓存尤其毒，一次抖动固化 7 天
    if (trackId && !budgetCtrl.signal.aborted && !reqSignal?.aborted) writeMatchCache(trackId, r);
    return r;
  } finally {
    clearTimeout(budgetTimer); // match 抛错也收——unref 兜底不保险，泄漏的 timer 会空 abort
  }
}

// 批量匹配并发池：worker 模型，总预算到点 abort——在途判定被掐断的曲目按
// 无匹配回落。命中原地写 t.matched/t.matchedBy/t.matchScore 并返回命中数
async function matchTracksPool(tracks, { signal, budgetMs, concurrency, tag, candidatesOf, durationOf, infoOf }) {
  const budgetCtrl = new AbortController();
  const matchSignal = AbortSignal.any([signal, budgetCtrl.signal].filter(Boolean));
  const budgetTimer = setTimeout(() => budgetCtrl.abort(), budgetMs);
  budgetTimer.unref?.();
  let cursor = 0;
  let matchedCount = 0;
  const worker = async () => {
    while (cursor < tracks.length && !matchSignal.aborted) {
      const t = tracks[cursor++];
      const info = infoOf(t);
      const trackId = trackIdOf(info);
      let r = trackId ? await cachedMatch(trackId, matchSignal).catch(() => null) : null;
      if (!r) {
        r = await matchNeteaseSong(
          candidatesOf(t), durationOf(t), tag, matchSignal, info)
          .catch(() => ({ song: null }));
        if (trackId && !matchSignal.aborted) writeMatchCache(trackId, r);
      }
      const matched = r?.song;
      if (matched && !matchSignal.aborted) {
        t.matched = toMatchedJson(matched);
        t.matchedBy = r.query ?? null;
        t.matchScore = Number.isFinite(r?.score) ? r.score : null;
        matchedCount++;
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, tracks.length) }, worker));
  } finally {
    clearTimeout(budgetTimer);
  }
  return matchedCount;
}

module.exports = {
  matchNeteaseSong, matchWithBudget, matchTracksPool, toMatchedJson,
  nameHitNeedsConfirm, MATCH_DUR_TOLERANCE_SEC,
  // 候选串展开（含占位作者剥头/去重/cap 8）——导出供测试直钉展开面
  expandSearchQueries,
};

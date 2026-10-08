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
const { YT_TRACK_ID_RE } = require('../../shared/predicates.js');
// 本家声明惰性解析（yt_ 来源的 shortDescription 自署出处链）——收单决断
// 前挑战与候选面穷尽兜底两处调用，模块顶层 require 不带运行期成本
const { resolveOriginalInfo } = require('../lib/youtube');
const songMatchRepo = require('../repositories/songMatch');

// 外部导入曲（B 站/YouTube/QQ）匹配网易云词源：每个候选串云搜 limit:10，
// 全候选过 netease-score 打分池（reject 滤掉，按分降序）——
//   ≥75 确定性收（yt_ 且本家声明在位的收单决断——任何分位——先过声明
//   语境复核；s88 撞名收单实证后分数豁免已废——见 challengeAccept）；
//   50-74 灰区有 AI 按分降序复核（否决记 vetoedIds 取下一个，同串连否两个
//   判空转下一串），无 AI 保持宽松语义灰区 top 直接收；<50 丢弃。
// 硬闸/封顶在打分器内：源有时长且差>45s reject、源无伴奏标候选带伴奏标
// reject、title<15 总分不过灰区、中立艺人分配非精确 title 压到灰区下——
// 纯时长命中永不确定性收（错词源比没词源更糟的哲学不变，只是把单维判据
// 换成证据总分）。中立艺人面下「仅剥缀变体作证」的精确 title 命中由
// searchOnce 内钳回灰区顶（打分器不动）——同名异曲不走确定性通道固化。
// 标类硬拒连 AI 兜底池都开除；时长类硬拒留池等 120s 粗闸
const MATCH_DUR_TOLERANCE_SEC = DUR_HARD_GATE_SEC;

// 每首曲目的 AI 调用硬上界（confirm + extract + pick + 声明挑战重判合计）——
// 超预算后按 verdict-null 同语义收下当前候选（AI 是增强不是门禁）
const AI_CALL_BUDGET = 4;

// 待定挂起的强度闸（acceptOrHold 专用）：收单已过挑战且 ≥80 才不为等
// 未跑派生串挂起——且仅限「证据问已结」的命中（声明语境复核放行烙
// aiChecked，或全曲无声明可核）。前身是「≥80 免挑战」的豁免分位：
// 'Moonlight ver.EMA' 实案里后续串 s88 撞名收单凭分数免证据直收同题
// 异曲——分数自此只定挂起强度，不再是免复核通道（见 challengeAccept）
const HELD_BYPASS_SCORE = 80;

// 本家派生串的标题变体席位：本家题是视频标题形态（'P主 - 曲名 ft.歌姬【MV】'
// /'曲名 - 歌姬'）——原串/单拼接串进云搜打不中网易的干净条目，origTitle 侧
// 过与 expandSearchQueries 同款的 titleVariantsOf 剥缀管线才成检索料；
// 管线自身 ≤4 条封顶，cap 钉住不随规则集膨胀（变体×2 派生串 ≤8 仍在预算内）
const ORIG_TITLE_VARIANT_CAP = 4;

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
// 返回 null 按原启发式放行（AI 是增强不是门禁）。
// 复核口径是「词源匹配」而非「同一录音」：neteaseId 只驱动歌词拉取与下载
// 嵌入，目标函数是词文相同——来源常是翻唱/歌ってみた投稿，候选艺人与来源
// 作者不同不构成否决；排他面只剩同名异曲、重新填词/异语言改编与伴奏条目
//
// 判定语义块抽常量供 confirm/pick 两 prompt 逐字共用——两处口径漂移过
// （pick 曾缺「歌名不同语言/译名差异属正常」句），抽常量杜绝再漂。
// 排他面双向写全：候选侧改编/伴奏不算；来源侧本身是重新填词/异语言
// 填词版时，词文不同的原曲同样不算（B 站 'Lemon 中文翻唱' 类来源——
// 日文原曲字面命中「原曲算」的话会绑错词）
const LYRIC_MATCH_CRITERIA = '——判词文相同而非同一录音：同一作品的原曲算；'
  + '沿用原词的翻唱/演绎/live/重编曲版也算'
  + '（来源常是翻唱/歌ってみた投稿，候选艺人与来源作者不同不构成否决）。'
  + '同名异曲、重新填词或异语言填词的改编版、伴奏/inst/karaoke 不算；'
  + '来源若为重新填词/异语言填词版，词文不同的原曲同样不算。'
  + '歌名不同语言/译名差异属正常。'
  + '来源描述自署的本家（原曲出处）与候选一致是强证据；未自署不构成否决。';

// 本家声明行：sourceInfo.original 在时是投稿者自署的一手出处（匹配器在
// 首轮证据面穷尽后经 yt_ 描述链惰性解析，或由调用方预注）——拼进证据串
// 让模型拿来分同题异曲；缺席不出行，模型看不到这档证据就不该为它扣分
const origDeclLine = (sourceInfo) => {
  const o = sourceInfo?.original;
  if (!o || (!o.title && !o.author)) return '';
  return `\n来源描述声明本家：${cleanPrompt(o.title) || '未知'} — ${cleanPrompt(o.author) || '未知'}`;
};
async function aiConfirmMatch(song, sourceInfo, durationSec, signal) {
  const ans = await askAiJson({
    // 复核/再生/兜底三处的单发时限不写死——交 askAiJson 默认链治理
    // （AI_TIMEOUT_MS env，默认 30s，见 lib/ai.js）。慢模型部署实测单发
    // ~16s，10s 硬编码等于把整条 AI 复核层功能关闭；总时长纪律由
    // matchWithBudget 的 budgetMs 总闸承担（耗尽 abort 在途调用），
    // 不靠在每发上砍时限
    system: '你是歌词源匹配助手。判断候选歌曲与来源音/视频的歌词是否同一作品'
      + LYRIC_MATCH_CRITERIA
      + '只输出 JSON {"match":true|false}。',
    user: `来源：${cleanPrompt(sourceInfo.title)} — ${cleanPrompt(sourceInfo.author) || '未知'}（${durationSec || '?'}s）${origDeclLine(sourceInfo)}\n候选：${songDesc(song)}`,
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
    // 单发时限同走 AI_TIMEOUT_MS env（见 aiConfirmMatch 头注）
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
// 一次调用覆盖 ≤10 候选，比逐候选问省额度且上下文更全。
// 挑选口径与 aiConfirmMatch 同一「词源」语义（见上）：挑词文同源的条目
// 而非同一录音——旧口径「翻唱/混音/live 版本不算」曾把翻唱投稿的
// 正确原曲成批否决
async function aiPickMatch(seenSongs, sourceInfo, durationSec, signal, vetoedIds = null, preferIds = null, scoreById = null, rejectedIds = null, derivedIds = null) {
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
    system: '你是歌词源匹配助手。从候选列表选出与来源音/视频歌词同一作品的编号'
      + LYRIC_MATCH_CRITERIA
      + '都不符返回 {"match":0}，能确定返回 {"match":编号}。只输出 JSON。',
    user: `来源：${cleanPrompt(sourceInfo.title)} — ${cleanPrompt(sourceInfo.author) || '未知'}（${durationSec || '?'}s）${origDeclLine(sourceInfo)}\n候选：\n${desc}`,
    maxTokens: 32,
    // 单发时限同走 AI_TIMEOUT_MS env（见 aiConfirmMatch 头注）
    signal,
  });
  // match:true（模型混用 confirm 形态）Number(true)=1 会假命中第 1 候选——
  // 布尔与 null 显式排除后再转数字
  if (typeof ans?.match !== 'number' && typeof ans?.match !== 'string') return null;
  const n = Number(ans.match);
  if (!Number.isInteger(n) || n < 1 || n > list.length) return null;
  const pick = list[n - 1];
  // AI 兜底仍过粗粒度时长闸（120s，约为确定性窗口的 3 倍——片头尾垫长
  // 可过，但「时长差几分钟的另一首歌」不能仅凭模型点头就命中）。
  // 例外：声明派生串搜出的条目免闸——它自带第一方出处证据（打分面
  // 同口径按无时长证据处理，见 srcFor 的 origDerivedKeys 判面）又经
  // 模型点名挑中，双重证据在场；而切片翻唱对本家的时长失配是结构性
  // 常态（87s 切片 vs 230s 本家），粗闸在派生面上必然误杀真身
  const pickDt = (pick.dt || pick.duration || 0) / 1000;
  if (durationSec > 0 && pickDt > 0 && Math.abs(pickDt - durationSec) > 120
    && !derivedIds?.has(pick.id)) {
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
// sourceInfo={title,author,artists[],titles[],trackId,durationSec?,description?,
//   original?}：AI 增强用——灰区复核 + 启发式全灭时再生/兜底挑；artists/titles
//   喂打分器，trackId 接 song_match 缓存键。original={title,author} 是投稿者
//   自署的本家出处：调用方可预注（任意源），未注且 trackId 为 yt_<videoId>
//   时经 sourceInfo.description（或补一跳 player）惰性解析——触发点提前
//   到首个收单决断前（让证据先于决断到场），全灭路径兜底位仍解析。
//   AI 未配置时语义与宽松启发式一致
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
  // 声明语境放行记忆（vetoedIds 的对偶，yt_ 声明语境专属）：带声明行复核
  // 放行的 (源,候选) 对是终态——同一首歌后续查询串以 ≥ACCEPT top 复现时
  // 挑战直返，同一问题不再重答。declSeen/hit.aiChecked 都不跨查询存续，
  // 无此集合则同曲复现恒重发同 prompt——模型抖动把已放行歌曲翻成否决，
  // vetoedIds 连 heldHit 回补一并堵死。对偶不变量：「否决不经任何路径
  // 复活」↔「放行不重复烧额度」
  const declClearedIds = new Set();
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
      sourceInfo?.author, sourceInfo?.original?.author]
      .map(x => String(x || '').trim())
      .filter(x => x && !isPlaceholderAuthor(x)))];
  const srcBaseTitles = [
    ...(Array.isArray(sourceInfo?.titles) ? sourceInfo.titles : []),
    ...(Array.isArray(candidates) ? candidates : []),
    sourceInfo?.title, sourceInfo?.original?.title];
  const srcFor = (q) => ({
    titles: [...new Set([q, ...srcBaseTitles]
      .map(x => String(x || '').trim()).filter(Boolean))],
    artists: srcArtists,
    // 声明派生串按「无时长证据」打分（netease-score 契约：0=不加分不硬闸）：
    // 它自带第一方出处证据，而切片翻唱对原曲的时长失配是结构性常态
    // （87s 切片 vs 230s 本家——时长闸在派生面上必然误杀真身）。掉 dur 分
    // 后强候选分位走低，但收单照样过声明复核（挑战对全分位生效）——权责不降级
    durationSec: origDerivedKeys.has(normKey(q))
      ? 0 : Number.isFinite(durationSec) ? durationSec : 0,
  });

  // 已试查询集（小写归一）——本家派生串与 AI 再生轮的「不重复打上游」判面共用
  const triedQueries = new Set(candidates.map(q => String(q || '').trim().toLowerCase()));

  // ── 本家声明挑战（yt_ 限定）──────────────────────────────────────────
  // 病灶：声明解析曾挂在候选面穷尽后——弱分收单（确定性 75-79 / 灰区放行）
  // 在证据到场前就 return，同艺人撞名（'□° ver.EMA' 收进 EMA 另一首、
  // '早く帰りたい' 错收同题异曲古井戸）正是这条分带的高发错配。
  // 第二洞（本轮收口）：≥80 曾走分数豁免整段跳挑战——同案 'Moonlight
  // ver.EMA' 后续串 'Moonlight Serenade'/Noema s88 撞名直收同题异曲，
  // 声明证据在场时分数豁免把一手证据换成了启发式置信。改为
  // 「收单决断前先问过声明」：resolveOriginalInfo 每曲目至多一次
  // （origAttempted memoize；描述在手零成本、链接形态至多一跳），命中后——
  //   ①sourceInfo.original 置位：之后的 confirm/pick prompt 带声明行
  //   ②本家艺人/曲名并进打分参照面（后续串打分直接吃声明证据）
  //   ③派生检索串插到当前串之后、剩余候选之前（第一方证据不排尾）
  //   ④待收单候选用带声明语境重判一次——冲突记 veto 转下一个；
  //     AI 通道关/耗尽则保守维持原收单；解析空手/null 照返不误
  const ytSelfId = trackIdOf(sourceInfo)?.match(YT_TRACK_ID_RE)?.[1] || null;
  let origAttempted = false;      // 每曲目至多一次回源（memoize）
  let origDerivedReady = false;   // 参照并入 + 派生串构建只做一次
  const origDerived = [];         // 待打派生串——挑战插队或兜底轮消费
  // 派生串归一键集：origDerived 构建同跳落键、构建完即只读——splice 消费
  // 的是数组本体，键集留存供 srcFor 判「本条查询是不是声明派生面」；挑战
  // 插队（派生串进主循环）与兜底轮（直调 searchOnce）两条消费路径同享判面。
  // 角色判面按字面生效：与既有候选串撞键的派生字面值不入队重打（检索
  // 面去重）但仍记键——同字面值的常规候选串命中同享派生待遇，而该字面
  // 本就是第一方出处证据的检索词形态
  // 键粒度与 triedQueries（toLowerCase）不对称已知：normKey 多折一步空白
  // ——流经判面的串全链归一单空格（展开链 cleanQueryTitle/再生消毒同径），
  // 唯一可能带异型空白的是派生串字面值本身（anchor 内嵌空白），而它入队
  // 同跳双键齐落；normKey 同键即同一检索词，有害碰撞不可达
  const origDerivedKeys = new Set();
  // 派生串检索命中的候选 id 集——aiPickMatch 对集内条目免 120s 粗闸
  // （声明证据+模型点名=双重证据）；srcFor/acceptOrHold 的角色判面同口径
  // ——按查询字面 ∈ origDerivedKeys 生效
  const derivedSeenIds = new Set();
  let candidateCursor = -1;       // 主循环当前下标——派生串插队锚点
  // 弱收单待定最优（至多一格，分高者留、同分守先到者）——「可收单但身后
  // 还有未跑的本家派生串」时挂起不返：主循环继续把第一方证据检索词打
  // 完，候选面+兜底派生轮全穷尽仍无新收单才回补（见兜底轮尾）
  let heldHit = null;
  const ensureOriginal = async () => {
    if (!sourceInfo) return null;
    if (!sourceInfo.original && !origAttempted && ytSelfId && !signal?.aborted) {
      origAttempted = true;
      const orig = await resolveOriginalInfo({
        videoId: ytSelfId, description: sourceInfo.description, signal,
      }).catch(() => null);
      if (orig) sourceInfo.original = orig;
    }
    const o = sourceInfo.original;
    // 本家艺人并进打分参照面与 o?.title 解耦（origDeclLine 对 author-only
    // 声明同样产段——判定面有证据轴，打分面不该丢）——占位作者不过闸；
    // 预注形态在 srcArtists 初始化已并入，此去重幂等
    const oa = String(o?.author || '').trim();
    if (oa && !isPlaceholderAuthor(oa)
      && !srcArtists.some(a => normKey(a) === normKey(oa))) srcArtists.push(oa);
    if (o?.title && !origDerivedReady) {
      origDerivedReady = true;
      const ot = String(o.title || '').trim();
      if (ot && !srcBaseTitles.some(t => normKey(t) === normKey(ot))) srcBaseTitles.push(ot);
      // 本家题是视频标题形态（'Giga & KIRA - 'GETCHA!' ft.初音ミク【MV】'/
      // 'Moonlight - VY1'）——原串直搜打不中网易的干净条目；origTitle 侧过与
      // expandSearchQueries 同款的 titleVariantsOf 剥缀管线（' - ' 艺人前缀/
      // feat.尾/【MV】括弧/ver.尾缀）取检索料，每个变体产「本家P+变体题」
      // 组合串与裸变体串两条派生，cap 收敛总量。占位作者不作锚（与
      // informativeArtist 同口径）也不拼组合串头——'_ X' 是噪声不是引用
      const anchor = oa && !isPlaceholderAuthor(oa) ? oa : '';
      const derived = [];
      for (const v of titleVariantsOf(ot, anchor).slice(0, ORIG_TITLE_VARIANT_CAP)) {
        derived.push(`${anchor} ${v}`.trim(), v);
      }
      for (const dq of [...new Set(derived)]
        .map(x => String(x || '').trim()).filter(Boolean)) {
        // 免时长闸判面键按字面值无条件记——与既有候选串撞键的派生字面
        // 值不入队重打（检索面去重），但同字面的常规候选串命中仍属
        // 「声明派生面」（该字面本就是第一方检索词形态）
        origDerivedKeys.add(normKey(dq));
        const k = dq.toLowerCase();
        if (!triedQueries.has(k)) {
          triedQueries.add(k);
          origDerived.push(dq);
        }
      }
    }
    return o || null;
  };
  // hit={song,query,score[,aiChecked]} 收单决断挑战：true=照原收单；
  // false=声明冲突否决（vetoedIds 已记，调用方转下一个）。declSeen=该
  // 候选的放行判决本就在声明语境下作出——证据已含，不重复烧额度；
  // declClearedIds=跨决断放行记忆——带声明语境判过的 (源,候选) 对是
  // 终态，后续查询串同曲复现直返不重问。
  // 豁免语义是「无声明才豁免」：yt_ 声明在位的每次收单决断（任何分位）
  // 都过带声明行的复核——'Moonlight ver.EMA' 实案 s88 撞名收单凭分数
  // 豁免直收同题异曲（把确定的一手证据换成启发式置信），分数自此不是
  // 免证据通道；声明缺席（解析空手/失败/非 yt_）即无证据可核，照原
  // 启发式放行零漂移。
  // 成本纪律：每收单决断至多 1 跳 resolveOriginalInfo（origAttempted
  // memoize 全曲只一次）+ ≤1 发 AI（AI_CALL_BUDGET 总闸兜底）；非 yt_
  // 源 !ytSelfId 早退不变
  const challengeAccept = async (hit, declSeen) => {
    if (!ytSelfId || signal?.aborted) return true;
    await ensureOriginal();
    // 派生串插队到当前串之后——本家检索词是第一方证据，先于剩余候选打
    if (origDerived.length) {
      candidates.splice(candidateCursor + 1, 0, ...origDerived.splice(0));
    }
    // 已放行对直返：声明语境放行是 (源,候选) 对级终态——同曲在后续串
    // 复现不重发同 prompt（「否决不经任何路径复活」的对偶：放行不重复
    // 烧额度——重答只会给模型抖动一次翻案机会，连 heldHit 回补都堵死）
    if (!sourceInfo?.original || declSeen
      || declClearedIds.has(String(hit.song.id))) return true;
    if (!useAi || aiLeft <= 0) return true;    // AI 通道关/耗尽——保守维持
    aiLeft--; aiTouched = true;
    const verdict = await aiConfirmMatch(hit.song, sourceInfo, durationSec, signal);
    if (verdict === false) {
      vetoedIds.add(String(hit.song.id));
      console.info(`[${tag}] 本家声明挑战否决收单: ${songDesc(hit.song)} ← ${hit.query}`);
      return false;
    }
    // 放行（含模型哑 null——哑是粘性放行，与复核放行同记）记对级终态
    declClearedIds.add(String(hit.song.id));
    hit.aiChecked = true;    // 该对已带声明语境判过——再生轮不再重问
    return true;
  };

  // 收单决策：挑战放行的 hit 不必然即刻收——它身后若还压着未跑的本家派生
  // 串（挑战已 splice 进 candidates 当前位之后，或尚在 origDerived 兜底队列），
  // 非终态收单先挂起成 heldHit、主循环继续把第一方证据检索词打完。派生串
  // 命中即终态——收单本就自带声明语境复核，同池同证据的后续串不更优，不
  // 再等身后派生；「身后无派生」的收单照原即时返回。
  // ≥HELD_BYPASS_SCORE 的强收单不挂起，但前提是证据问已结：本命中已在
  // 声明语境判过（挑战内烙 aiChecked——复核放行与模型哑同算，哑是粘性），
  // 或全曲无声明可核（pending 恒空的同效短路）。声明在场而复核没跑
  // （AI 关/耗尽保守维持）的强命中与弱命中同待遇挂起——分数本身不再
  // 单独截停第一方检索词
  // 病灶实证：'Moonlight ver.EMA' 首串弱收单 'Moonlight (Single Ver.)'/Mosq
  // （同题异艺人，声明复核判 ok）截停主循环，origDerived 里压着的
  // 'shima VY1' 等第一方检索词永远没出场——真身词条被同题错配顶掉
  const acceptOrHold = (hit) => {
    if (origDerivedKeys.has(normKey(hit.query))) return true;
    if (hit.score >= HELD_BYPASS_SCORE
      && (hit.aiChecked || !sourceInfo?.original)) return true;
    // origDerived.length 判面恒空——挑战内 splice 已把派生串全数搬进
    // candidates（兜底轮 splice(0) 同跳排空），无路径能带着未消费队列
    // 到达这里；防御性保留。生效判面是「剩余 candidates 里还压着派生串」
    const pending = origDerived.length > 0
      || candidates.slice(candidateCursor + 1)
        .some(c => origDerivedKeys.has(normKey(c)));
    if (!pending) return true;
    // 待定最优=分高者留（同分守先到者——先到先得与「最优」命名一致）；
    // 低分后来者不覆盖也不记日志
    if (!heldHit || hit.score > heldHit.score) {
      heldHit = hit;
      console.info(`[${tag}] 收单待定: ${songDesc(hit.song)} ← ${hit.query}（身后有未跑本家派生串）`);
    }
    return false;
  };

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
    let confirms = 0, vetoes = 0;
    // ≥ACCEPT 确定性收——收单决断先过声明挑战：yt_ 声明在位的确定性单
    // （任何分位）要问过本家证据；挑战否决不落直接返，记 veto（同串连否
    // 同口径）后余下候选转灰区流续面
    if (scored[0].score >= ACCEPT_SCORE) {
      const hit = { song: scored[0].s, query: q, score: scored[0].score };
      if (await challengeAccept(hit, false)) {
        // 待定=本串判空转下一串（插队派生串）——不记 veto，hit 未否决只延后
        if (acceptOrHold(hit)) return hit;
        return null;
      }
      vetoes++;
    }
    // 灰区：无 AI 保持宽松语义（top 直接收——收单决断同过挑战，AI 关时
    // 挑战内保守维持原收单）；有 AI 逐候选复核——复核通过/哑火/预算耗尽
    // 都收下当前候选（增强不是门禁），明确否决才取下一个；同串连否两个=
    // 这串候选池本身可疑，余下候选不免检收下——判空转下一串。放行决断
    // 同过声明挑战；declSeen 钉「该判是否已在声明语境下作出」防重复问
    if (!useAi) {
      const hit = { song: scored[0].s, query: q, score: scored[0].score };
      if (await challengeAccept(hit, false) && acceptOrHold(hit)) return hit;
      return null;   // AI 关时挑战只维持不否决——防御性收口；待定亦判空转下一串
    }
    for (const g of scored) {
      if (signal?.aborted) return null;
      if (vetoedIds.has(String(g.s.id))) continue;   // 挑战/复核否决的不复活
      if (confirms < 2 && aiLeft > 0) {
        confirms++; aiLeft--; aiTouched = true;
        const declSeen = !!sourceInfo?.original;
        const verdict = await aiConfirmMatch(g.s, sourceInfo, durationSec, signal);
        if (verdict === false) {
          vetoedIds.add(String(g.s.id));
          console.info(`[${tag}] AI 否决灰区候选: ${songDesc(g.s)} ← ${q}`);
          if (++vetoes >= 2) return null;
          continue;
        }
        const hit = { song: g.s, query: q, score: g.score, aiChecked: true };
        if (await challengeAccept(hit, declSeen)) {
          if (acceptOrHold(hit)) return hit;
          return null;   // 待定转下一串——不记 veto（挑战放行只是延后收单）
        }
        if (++vetoes >= 2) return null;
        continue;
      }
      const hit = { song: g.s, query: q, score: g.score };
      if (await challengeAccept(hit, false)) {
        if (acceptOrHold(hit)) return hit;
        return null;   // 同上——待定转下一串
      }
      if (++vetoes >= 2) return null;
    }
    return null;
  };

  const warnFail = (q, e) => {
    // 预算/断连掐断的在途云搜不算源故障——abort 面不记噪声 warn；
    // e.aborted 同静默（与 lyric-external 的 e?.aborted || signal?.aborted
    // 口径对齐——上游 abort 拒绝冒泡到本层时自身 signal 可能仍活）
    if (e?.aborted || signal?.aborted) return;
    // 上游 reject(answer) 形态无 .message——归一化再记
    const why = e?.message || (e?.body ? `code=${e.body.code ?? '?'}` : String(e));
    console.warn(`[${tag}] 网易云搜索「${q}」失败:`, why);
  };

  for (candidateCursor = 0; candidateCursor < candidates.length; candidateCursor++) {
    const q = candidates[candidateCursor];
    if (signal?.aborted) break;
    if (!q) continue;
    try {
      // 派生面字面的检索命中收进 derivedSeenIds（aiPickMatch 免 120s 闸
      // 判面）——与 srcFor/acceptOrHold 的 origDerivedKeys 字面判面同口径
      const hit = await searchOnce(q, origDerivedKeys.has(normKey(q)) ? derivedSeenIds : null);
      // searchOnce 内各收单点已过同款 acceptOrHold——此处同决策兜底：
      // 能回到主循环的 hit 在判面上必是即刻收单形态，待定则继续下一串
      if (hit && acceptOrHold(hit)) return { ...hit, ai: aiTouched, searchedAny };
    } catch (e) {
      warnFail(q, e);
    }
  }
  // ── 本家声明兜底轮（miss 路径）───────────────────────────────────────
  // 主循环一路未收单才到这——挑战链没醒过（全灭/全拒/无弱分决断）时声明
  // 解析在此完成同一跳（ensureOriginal memoize：挑战已解析过则零成本秒
  // 回）。utaite/翻唱稿的描述普遍带投稿者自署的本家链（'本家：URL'），
  // 同题异曲在标题/作者元数据层不可分，这手第一方声明是唯一能分它的
  // 证据；派生串是仅剩的第一方检索词——先于 AI 再生/兜底打。声明缺席/
  // 解析失败都按「无本家」继续，不构成否决
  await ensureOriginal();
  for (const q of origDerived.splice(0)) {
    if (signal?.aborted) break;
    try {
      const hit = await searchOnce(q, derivedSeenIds);
      // 派生串自身收单即终态——acceptOrHold 在派生面恒放行（同判面兜底）
      if (hit && acceptOrHold(hit)) return { ...hit, ai: aiTouched, searchedAny };
    } catch (e) {
      warnFail(q, e);
    }
  }
  // ── 待定弱收单回补 ──────────────────────────────────────────────────
  // 主循环为等本家派生证据挂起的弱收单：候选面+兜底派生轮全打完仍无新
  // 收单——它就是全程最优的可收命中，先于 AI 再生/兜底回补（不另烧额度）。
  // 回补同守 veto 不变量：判定途中被挑战否决的 id 不经任何路径复活
  if (heldHit && !vetoedIds.has(String(heldHit.song.id))) {
    return { ...heldHit, ai: aiTouched, searchedAny };
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
    const candSet = triedQueries;  // 含本家派生串——再生轮不重复打已试串
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
    const pick = await aiPickMatch(seenSongs, sourceInfo, durationSec, signal, vetoedIds, regenIds, scoreById, rejectedMarkerIds, derivedSeenIds)
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

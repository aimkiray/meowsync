// 外部滚动歌词源链——网易云词源缺席/未匹配时的兜底：
//   yt_ 曲先走 YouTube Music（videoId 直达、LyricFind 供词），
//   再 LRCLIB（开放歌词库，本端自筛时长/艺人/纯音乐标记），
//   最后酷狗 lyrics.kugou.com（华语/粤语补位，fmt=lrc 直给行级 LRC，
//   非 LRC 载荷拒收）。
// 艺人面策略随 AI 开关分两态：AI 关时 artistHit 是硬滤（无核验兜底，
// 错词比没词更糟）；AI 在位时降成排序偏好（provider 艺人字段不可信——
// 翻唱条目艺人名与检索艺人不相像但词文可能是同曲真身），归属判定交
// choose 整池消歧 + verify 逐候选词文核验，且曲库 id（qq_/数字等）同
// 样追加 '' 开放轮（AI 关时曲库行不加降轮，维持保守）。
// 三路全灭回 null——调用方按「无词」处理（路由 404、下载链 NO_LYRICS）。
// UGC 曲（yt_/bv_）在「有时长闸可摘 + 存在干净 miss 面」时追加「免时长
// 末轮」：durationSec=0、标题闸恒在位的单次 artist='' 开放轮
// 重扫两检索源，救「截取版/片头尾超长」型失效。
// yt_ 曲在常规轮发起前先反解本家声明（投稿描述 original:/本家: 链接 →
// {title,author} 真身元数据，至多 +2 跳 fail-soft）：choose/verify 自
// 首轮起携 declared——判官对同题池看得到「自署本家」轴（池中有本家
// 条目选它、没有则倾向判死而非乱挑；实案 'Moonlight ver.EMA' 开放轮
// 曾把 Gaulin 英文同名异曲 pick+verify 连过收单、声明还没到场——判官
// 是在无证据语境下对同题池做的选择）。常规轮全灭后原位置再追加「声明
// 轮」（先于免时长末轮）以本家题/名重扫两检索源——同题异曲在元数据
// 层不可分（'Moonlight'→moumoon/Gaulin、'Boi'→Dina Jashari 同名异曲），
// 声明证据是检索侧的确定性出口、比摘时长闸更精准故排前；题归一相同
// 且艺人面无新信息（本家 author 缺席/占位或与来源 artist 归一相同）
// 才不重复打——题同而本家 author 是新艺人轴仍起轮。declared 透给判官
// 作语境（自署本家行进 prompt；「有声明」位并进判定键盐尾分键——无
// 声明语境落的旧 verdict 不被携自署证据的重判吃到，choose 侧
// pickMemo 'd|' 同义）。
// 标题身份闸（strictTitle）全轮次在位：候选标题剥缀归一后与检索标题
// 精确等才放行——具名轮的 artistHit 子串约束只收窄召回、不能替代标题
// 证据（'EMA' 撞进 'MAISONdes feat. EMA & たなか' 的艺人字段照样放行
// 同题异曲：实案 '□° ver.EMA' 具名轮回收 'ダンス・ダンス・ダダ' 落错词）。
// 无艺人约束轮（开放轮与免时长末轮）的同名歧义再交 choose 整池单发
// 消歧兜：fetch 层池 ≥1 条即把排序后前 8 条身份交判官一发
// 选择题「来源最可能翻唱哪条」——逐候选布尔盲审对同题异曲不够决断
// （实证：KKB 英文版被判 ok 收录；常规开放轮 'Boi/Moonlight/匿名希望'
// 类同题异曲被盲审连放），整池相对判定才分得清。挑中条再补 verify
// 词文核验——pick 只比候选元数据不看词文（实案 'Boi ver.EMA' 开放轮
// pick 选马其顿语同名歌直接收录，西里尔词文全程未验），元数据消歧与
// 词文归属是两道独立证据缺一不可：判否即判死该变体不落回迭代（pick
// 已是池内最优的相对判定，最优条过不了词文关说明池中无正解，逐条重
// 验只是重复烧 AI 且同池条目大概率同错）；核验通道故障（非 abort）
// 按未收录落回逐候选迭代——candidatePass 式「异常放行」会把没验过
// 的错词重新放进门。判官明言「池中无合理候选」同判死不落回兜底
// （precise 优先：错词比没词更糟，没词走 rematch 自愈）；choose 未应
// 答/故障落回逐候选归属核验（带同题池语境：条目身份进判定 prompt，
// vkey 换 v4 盐与无池盲审互不命中——降级期不缩召回）。具名 artist 轮
// 不注入 choose（具名检索词已把上游候选面收窄到艺人相关——消歧面小，
// 多烧一发整池判定不抵收益，逐候选核验照旧）。末轮不按 artist 轮次重扫——
// 免时长后标题是唯一硬证据，UGC artist 是翻唱者/UP 主而非原曲艺人，具名
// 约束只收窄（'Flamingo／rei shirose' 的 'R' 轮曾把真身 米津玄師 滤死、
// 放行子串撞名的 Earl Bostic）。
// 常规轮全死于传输故障（有 lastErr 且无干净 miss）不展开——同源重试必死
// 白打，末轮恰回干净空表还会污染 cleanMiss 溃掉尾部抛错语义；durationSec
// 缺省/0 时末轮与 '' 宽检轮逐字节同参，纯重复扇出，同样不展开。
// 单一源全灭在传输层（没有一个「干净无词」终态）时抛错——这是故障不是
// 缺词，让调用方走重试语义，且不写负缓存。
//
// 结果面 { lrc, source:'ytm'|'lrclib'|'kugou'|'netease'|'qq', extId, synced,
//          plain?, meta? }：
//   lrc    最佳文本——synced=true 是标准 LRC；false 时是纯文本（无时间戳
//          行，落盘仍是可读词稿，播放端解析不出滚动行而已）
//   extId  源内稳定 id（ytm_<videoId>/lrclib_<条目id>/kugou_<行id>——级联
//          产出面；netease_<曲目id>/qq_<songmid> 只出手选候选池与
//          fetchByExtId 反查支路）——归属核验 vkey 与 AI 译文缓存键都
//          挂它，与网易云/QQ id 空间隔离，形态见 shared/predicates.js
//          EXT_LYRIC_ID_RE
//   plain  纯文本歌词（LRCLIB 条目常带 synced+plain 两形态时顺带透出）
//   meta   候选条目身份 {title, artist, album}——lrclib/kugou 检索命中透出，
//          verifyHit 喂给 AI 归属判定作同名异曲拦截证据；ytm 支路
//          （timedLyricsData 无候选条目元数据）与缓存反查略
//
// 进程内 LRU 缓存（cap 500，不建表）：正结果 6h、负结果 10min——负窗短
// 防一次上游抖动把「无词」固化成准永久，正窗长削重播/重试的上游扇出。
// 级联被 deadline 截断的终态不进缓存：纯没跑完回 null 但不落负窗（「没
// 查完」≠「无词」），截断前已有源传输抛错则整链抛错走重试语义。
// 同键并发单飞共享一次级联——下载相位并行任务与路由重试不重复打上游。
// 与 lyric-verify 的 judgeInflight 不同语义：那里的共享 promise 不吃调用
// 方 signal；这里的级联由首个调用方的 signal 驱动，其 abort 会让搭车者
// 吃到同一个 aborted 拒绝——搭车者自身仍存活时降级自行重跑（见
// fetchExternalLyric 的 gate.catch），不陪绑也不重复打上游（重跑先吃
// 缓存/新 gate）。
//
// AI 归属核验：产出词过 lyric-verify.judgeLyricLines——判「明显是别的歌」
// 视同无词继续下一源；已落库判定不随 aiEnabled 旁路（记忆是累积知识，
// AI 关只影响新判定），AI 关/判不定放行（「AI 是增强不是门禁」与
// lyric-verify 同口径）。判不定放行有逐候选收紧例外：AI 在位时艺人面
// 已降成排序偏好，艺人不相符的「失锚」候选只在核验明言判真
// （ok===true）才收——判不定（AI 超时/故障/未应答）与核验异常同拒，
// 否则「AI 名义开实挂」窗口会把 AI 关时必滤的同题异曲放行，比 AI 关
// 还弱。锚基准：具名轮=轮 artist；曲库 '' 开放轮=曲目原始 artist
// （roundArtist 是 '' 空约束不是锚）；UGC '' 开放轮不设锚（UGC artist
// 是 UP 主非原曲艺人，锚它会灭掉全部翻唱命中——与旧口径同宽）。
const { ytDispatcher } = require('../lib/yt-proxy');
// LRCLIB/酷狗两条直连链的外源代理通道（LYRIC_PROXY 本地部署档——见
// lib/lyric-proxy.js 头注）：代理在位走共享 dispatcher，代理连接级
// 失败（闸死）剥代理直连重发一次；未配置纯透传，各 fetch 点逐字节旧行为
const { lyricFetch } = require('../lib/lyric-proxy');
const { YT_TRACK_ID_RE, BV_TRACK_ID_RE, EXT_LYRIC_ID_STRICT_RE, NETEASE_ID_RE, SONGMID_RE } = require('../../shared/predicates.js');
// 标题变体/剥艺人/检索词清理的唯一真相源上提到 shared——网易云匹配漏斗
// （netease-match.js candidates 展开）与这里的外源级联共用同一份规则集
const {
  titleVariantsOf, artistFromTitle, cleanQueryTitle, normKey, isPlaceholderAuthor,
  NAME_SEP_CH,
} = require('../../shared/title-variants.js');
const { normToken, foldCjkCompat } = require('../../shared/text-norm.js');
const { aiEnabled } = require('../lib/ai');
const { parseLrcLines, plainTextLines, judgeLyricLines, lyricVerdictKey, judgePoolPick } = require('./lyric-verify');
// 本家声明反解（投稿描述 original:/本家: 链接 → {title,author} 真身元数据）
// ——经模块对象调用：测试面可就地桩，并行落地期缺席（undefined）按无
// 声明 fail-soft 处理
const ytLib = require('../lib/youtube');
// 手选候选池的两个曲库源原语（只进 searchLyricCandidates/fetchByExtId，
// 不进级联）：网易走 ./netease 门面——候选池只要 callNeteaseApi 一跳，
// 不拉 ./netease-api 的解锁/流址重依赖面；QQ 经模块对象调 lib/qq——
// searchSongs 三层兜底/getLyric 已收口在内（与 file-downloader 同款
// 消费形态，测试面可就地支桩）；neteaseLyricBody 是 lyric 回包归一
// 唯一真相源（nolyric/uncollected/占位词归空——与 fetchLyricRaw/
// 下载链 neteaseLyricOf 同口径）
const { callNeteaseApi } = require('./netease');
const qq = require('../lib/qq.js');
const { neteaseLyricBody } = require('../../shared/lrc.js');

const EXT_TIMEOUT_MS = 12000;
// 级联软时限默认值——fetchExternalLyric 经 args.deadlineMs 可覆写（测试
// 注入点；同键并发搭车共享的是首个调用方那次级联的时限）
const CASCADE_DEADLINE_MS = 45_000;
// 检索源内常量：单请求超时（LRCLIB 检索/直取、酷狗检索/下载共用）、
// 时长容差（yt_ 标题实为视频标题、时长含片头偏长——±15s 软窗）、
// 同题池喂判官的条数上限、逐候选核验迭代上限
const SRC_REQ_TIMEOUT_MS = 10000;
const DUR_TOLERANCE_SEC = 15;
const POOL_TOP_N = 8;
const CANDIDATE_TRY_N = 3;
// 429 Retry-After 等待上限（过长/缺省不硬等，判失败换源）与 5xx 单点
// 重试间隔（观测过真实 503 抖动）
const RETRY_AFTER_MAX_SEC = 8;
const RETRY_5XX_DELAY_MS = 800;
// 酷狗词文载荷卫生闸：无时间戳且可打印字符占比低于此值判「非 LRC
// 载荷」拒收（krc1 乱码/二进制回包不冒充纯文本词）
const KUGOU_PRINTABLE_MIN = 0.9;
const abortErr = () => Object.assign(new Error('已取消'), { aborted: true });
const timedSignal = (extraSignal, ms = EXT_TIMEOUT_MS) => extraSignal
  ? AbortSignal.any([AbortSignal.timeout(ms), extraSignal])
  : AbortSignal.timeout(ms);

// ── 进程内结果缓存（LRU + 负结果短窗）──
const CACHE_CAP = 500;
const POS_TTL_MS = 6 * 60 * 60 * 1000;
const NEG_TTL_MS = 10 * 60 * 1000;
// 混合故障 null（一源传输炸 + 余源干净 miss）的短负缓存窗：故障源的
// 检索面可能没执行，不能固化成 10min 假阴性；但持久故障源若每请求都
// 全级联重跑会吃满级联上限——短窗把「局部故障」与「真无词」分开固化
const DIRTY_NEG_TTL_MS = 90 * 1000;
const resultCache = new Map();   // key -> {res: result|null, at}
const inflight = new Map();      // key -> Promise<result|null>

function cacheKeyOf({ songId, title, artist, durationSec }) {
  // 全部检索输入都进键：同 id 无检索词的一次空跑（LRCLIB/酷狗无米下锅
  // 快返 null）不能把随后「同 id + title」本可命中的查询钉成 10min
  // 假阴性。键不带 source——缓存的是级联终态而非单源结果。
  // durationSec 归一成整秒：前端传整秒、下载链传探测浮点（200.497）——
  // 不 round 同一首歌会劈叉成两个键各烧一次级联
  const dur = Number.isFinite(durationSec) && durationSec > 0 ? Math.round(durationSec) : '';
  return [String(songId ?? '').trim(), normKey(title), normKey(artist), dur].join('|');
}

function cacheRead(key) {
  const e = resultCache.get(key);
  if (!e) return { hit: false };
  if (Date.now() - e.at > (e.ttl ?? (e.res ? POS_TTL_MS : NEG_TTL_MS))) {
    resultCache.delete(key);
    return { hit: false };
  }
  // LRU touch：Map 键序即插入序，delete+set 把命中挪到队尾
  resultCache.delete(key);
  resultCache.set(key, e);
  return { hit: true, res: e.res };
}

// ttl 覆写只用于混合故障的短负窗（DIRTY_NEG_TTL_MS）——正负结果仍走
// 默认窗
function cacheWrite(key, res, ttl) {
  // 满容挤最旧（队首）——FIFO 挤出与路由层会话缓存同口径
  if (resultCache.size >= CACHE_CAP && !resultCache.has(key)) {
    resultCache.delete(resultCache.keys().next().value);
  }
  resultCache.set(key, { res, at: Date.now(), ttl });
}

// ── 公共小件 ──
// [mm:ss.xx] 厘秒时间戳：先整体化厘秒再取段——62.999s 的 round 不进位出
// ss=60 残值
const msTag = (ms) => {
  const cs = Math.round(ms / 10);
  const mm = Math.floor(cs / 6000);
  const ss = Math.floor((cs % 6000) / 100);
  return `[${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}]`;
};

// 歌词行消毒：换行/方括号会破坏 LRC 行结构（伪造时间戳注入），Cf 零宽
// 字符剥除与 routes/ai.js cleanText 同口径
const cleanLine = (s) => String(s || '')
  .replace(/[\r\n]+/g, ' ')
  .replace(/\[[^\]]*\]/g, ' ')
  .replace(/[\[\]]/g, ' ')
  .replace(/\p{Cf}/gu, '')
  .replace(/\s+/g, ' ')
  .trim();

// 艺人相似判定：归一（小写 + CJK 异体折叠 + 剥 title-variants 艺人
// 分隔集）后互相包含即算——'周杰伦' vs '周杰伦/林俊杰'、'A B'（本站
// 多艺人空格拼接）vs 'A'、'A／B'（全角斜杠）vs 'A' 都认（旧实现只
// 剥半角分隔，全角/「」形态会把两轴艺人拼成整串撞不进子串）。
// 消费面两态：AI 关时是硬滤（不相似即出局——无核验兜底，错词比没词
// 更糟）；AI 在位时降成排序偏好（provider 艺人字段不可信，硬滤会滤
// 死 'nqrse'↔'EMA' 类翻唱真身——归属交给 choose/verify 判）
const normName = (s) => foldCjkCompat(String(s || '').toLowerCase()
  .replace(new RegExp(`[${NAME_SEP_CH}]+`, 'g'), ''));
const artistHit = (want, got) => {
  const w = normName(want);
  const g = normName(got);
  if (!w) return true;      // 调用方没给艺人——不卡也不加权
  return Boolean(g) && (g.includes(w) || w.includes(g));
};

// 标题身份闸（级联全轮次在位）：闸=候选与检索标题双侧剥缀面
// （titleVariantsOf 单份规则集：尾括弧/feat./ver./cover/'A - B' 头/
// 全大写署名头等）归一集合相交才放行——'Twig (feat. Miku)'→'twig' 收、
// 'twig' vs 'pinocchiotwig' 拒、'ロストアンブレラ' 精确收。
// 开放轮里它是唯一挡「子串撞名」的确定性闸：artist 空检时 artistHit
// 全放行，/api/search 自由文本命中的撞名候选会照收（实证病例：查询
// 'Twig' 撞上英文同名异曲 'Pinocchio Twig / Koosje'，时长还巧合贴近）。
// 具名轮同样要它——artistHit 子串约束只收窄召回、不能替代标题证据：
// 'EMA' 会撞进 'MAISONdes feat. EMA & たなか' 的艺人字段（实案 '□°
// ver.EMA' 具名轮回收 'ダンス・ダンス・ダダ' 同题异曲落错词——子串
// 命中≠同曲）。
// 检索词归一成空串（纯符号/分隔符标题，剥缀后无字母数字证据）同样走
// 等比对：只收「候选标题归一后也为空」的条目（真·符号标题自证），
// 正常标题一律拒——「无可比对不卡」的宽让等于放行一切，闸即虚设。
// 查询词本身为空由上游 lrclibFetch/kugouFetch 的 `if (!q) return null`
// 兜住不发请求，此闸面对的只有「非空但归一为空」的纯符号检索。
// 刻意取舍：跨文字形态（罗马音 vs 日文原名）不互认——漏判由绑后外源
// 兜底与自动首配愈合，错词比没词更伤。
const strictTitleHit = (candTitle, queryTitle) => {
  // 查询侧同走变体面：检索词展开靠 titleVariantsOf(title)（级联按变体
  // 串行打面），闸若只比对原始形态，上游只在含 'ver.X' 噪声的检索词下
  // 回包时（实案 kw='懐中道標 ver.EMA EMA' 回 'EMA/懐中道標'）同曲候选
  // 会被自己展开出的剥缀面闸死——双侧变体归一集合相交才算同题
  const wants = new Set(titleVariantsOf(queryTitle, '')
    .map((v) => normToken(v)));
  return titleVariantsOf(candTitle, '')
    .some((v) => wants.has(normToken(v)));
};

// 逐候选核验容错包装：verify 回三态（true 判过 / false 判否 / null
// 判不定）。艺人面相符（anchored）候选判不定与核验异常照旧放行
// （与级联外层「核验故障不拦」同口径——AI 是增强不是门禁）；失锚
// 候选（锚定艺人面比对不相符——AI 在位时艺人只是排序偏好，艺人不
// 相符条目本靠 AI 判真兜底）判不定与异常一律拒收，否则「AI 名义开
// 实挂」比 AI 关还松、同题异曲零核验直进。abort 穿透。
// vkey 挂各候选 extId——同一检索里多条判否行互不串。
// extra（可选）= 检索侧随候选透出的判定语境 {pool}——同题候选池身份，
// 缺席时 verify 按无池盲审（反查/直调等无检索池场景）
const candidatePass = async (verify, hit, signal, extra, anchored = true) => {
  if (!verify) return true;
  try {
    const v = await verify(hit, extra);
    return anchored ? v !== false : v === true;
  } catch (e) {
    if (e?.aborted || signal?.aborted) throw abortErr();
    return anchored;
  }
};

// 已过逐候选核验的烙记：不可枚举——路由层 ...res 摊出与 JSON.stringify
// 都不带它，内部标记不泄进 API 面；级联凭它跳过外层二次核验
const markVerified = (hit) => Object.defineProperty(hit, 'verified', { value: true });

// 检索标题清理（cleanQueryTitle）、剥艺人候选（artistFromTitle）与
// 标题变体生成（titleVariantsOf）已上提到 shared/title-variants.js——
// 网易云匹配漏斗与本级联共用同一份规则集，本文件只留消费点。
// 规则语义见该文件头部考据（'ver.<歌姬>'/cover/尾括弧/'Artist - Title'
// 前缀/【栏目】头/feat.尾/斜杠尾/歌系语尾/字幕组/艺人锚/全大写署名头
// 十二条——'EMA rumor' 类搬运形态由 CAPS_HEAD_RE 无锚剥头兜底）。

// 外源 fetch 通用防御：三家 API 均无合法跳转语义——redirect:'manual' 把
// 3xx 显式露给上层（res.ok=false 走现有「源失败换下一源」语义），不裸
// follow 到被劫持的落点
const EXT_FETCH_GUARD = { redirect: 'manual' };
// 响应体量闸：歌词 JSON 合理上限远低于 2MB——上游异常/被劫持回大体积
// 响应时不让它整坨进内存。无 stream 面（测试桩/特殊实现）退 res.json()
const MAX_EXT_BODY_BYTES = 2 * 1024 * 1024;
async function readJsonCapped(res) {
  const reader = res.body?.getReader?.();
  if (!reader) return res.json();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value?.byteLength || 0;
    if (size > MAX_EXT_BODY_BYTES) {
      try { await reader.cancel(); } catch { /* 拒收尽力而为 */ }
      throw new Error('外源响应体超限');
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8'));
}

// 可中止 sleep——429 Retry-After 等待期间调用方断连要即时醒
const abortableSleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(abortErr());
  const t = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort);
    resolve();
  }, ms);
  const onAbort = () => { clearTimeout(t); reject(abortErr()); };
  signal?.addEventListener('abort', onAbort, { once: true });
});

// ── 源 1：YouTube Music（yt_ 曲首选，LyricFind 供词）──
// next(WEB_REMIX) 拿歌词 tab 的 browseId（MPLYt…）；browse 必须
// ANDROID_MUSIC context 才回 timedLyricsData（桌面形态不回）。
// music.youtube.com 属 YouTube 域族（isYoutubeHost 后缀即覆盖）——
// yt_proxy 在位时经共享 ProxyAgent 出口（lib/youtube.js ytFetchOpts 同口径）
const YTM_KEY = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30';
const YTM_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const ytmOpts = () => {
  const d = ytDispatcher();
  return d ? { dispatcher: d } : {};
};

async function ytmPost(endpoint, body, signal) {
  const res = await fetch(`https://music.youtube.com/youtubei/v1/${endpoint}?alt=json&key=${YTM_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': YTM_UA },
    body: JSON.stringify(body),
    signal: timedSignal(signal),
    ...EXT_FETCH_GUARD,
    ...ytmOpts(),
  });
  if (!res.ok) throw new Error(`ytm ${endpoint} HTTP ${res.status}`);
  return readJsonCapped(res);
}

// renderer 树按键名递归取节点——嵌套深度随 YouTube 改版漂移，按形状找比
// 按路径深取稳（lib/youtube.js innertubeSearch/fetchYtPlaylistPage 同款防御）
function findNode(node, key) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const it of node) {
      const hit = findNode(it, key);
      if (hit != null) return hit;
    }
    return null;
  }
  if (node[key] != null) return node[key];
  for (const k of Object.keys(node)) {
    const hit = findNode(node[k], key);
    if (hit != null) return hit;
  }
  return null;
}

// next → 歌词 tab 的 browseId：无 tab / tab 标 unselectable（该曲无词）/
// 无 browseId 都按无词 null 处理——确定性不恋战
async function ytmLyricsBrowseId(videoId, signal) {
  const body = await ytmPost('next', {
    videoId,
    // clientVersion 钉 '1.x'：'2.2024…' 形态被 Innertube 拒（/youtubei/v1/next
    // 实回 404 NOT_FOUND，直连与代理同现）；'1.20241101.01.00' 实测 200 正常
    // 回歌词 tab。ANDROID_MUSIC 的 7.21.50 实测可用不动
    context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20241101.01.00', hl: 'en', gl: 'US' } },
  }, signal);
  const tabs = findNode(body, 'watchNextTabbedResultsRenderer')?.tabs;
  if (!Array.isArray(tabs)) return null;
  for (const tab of tabs) {
    const tr = tab?.tabRenderer;
    if (!tr) continue;
    const pageType = tr.pageType
      || tr.endpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs
        ?.browseEndpointContextMusicConfig?.pageType
      || '';
    const isLyricsTab = pageType === 'MUSIC_PAGE_TYPE_TRACK_LYRICS'
      || /^lyrics$/i.test(String(tr.title || '').trim());
    if (!isLyricsTab) continue;
    // tab 在但 unselectable = 该曲无歌词——确定性终态，不再打 browse 白跳
    if (tr.unselectable === true) return null;
    const browseId = tr.endpoint?.browseEndpoint?.browseId;
    return typeof browseId === 'string' && browseId ? browseId : null;
  }
  return null;
}

async function ytmFetchLyric(videoId, signal) {
  const browseId = await ytmLyricsBrowseId(videoId, signal);
  if (!browseId) return null;
  const body = await ytmPost('browse', {
    browseId,
    context: { client: { clientName: 'ANDROID_MUSIC', clientVersion: '7.21.50', hl: 'en', gl: 'US' } },
  }, signal);
  const timed = findNode(body, 'timedLyricsModel')?.lyricsData?.timedLyricsData;
  if (!Array.isArray(timed)) return null;
  const lrc = timed
    .map((it) => ({ ms: Number(it?.cueRange?.startTimeMilliseconds), text: cleanLine(it?.lyricLine) }))
    .filter((it) => Number.isFinite(it.ms) && it.ms >= 0 && it.text)
    .sort((a, b) => a.ms - b.ms)
    .map((it) => `${msTag(it.ms)}${it.text}`)
    .join('\n');
  return lrc ? { lrc, source: 'ytm', extId: `ytm_${videoId}`, synced: true } : null;
}

// ── 源 2：LRCLIB（开放歌词库通用兜底）──
// /api/search 自由文本检索 + 本端自筛：instrumental 跳过、艺人归一包含
// （AI 在位时降成排序偏好、AI 关维持硬滤——见 normName/artistHit 头注）、
// 时长 ±DUR_TOLERANCE_SEC 窗内取最近（yt_ 曲名实际是视频标题、时长含片头
// 偏长——官方 /api/get 的 ±2s 精确闸对它们太严）。~20req/s 礼仪：429 尊重
// Retry-After 重试一次即止，不叠重试打爆公共上游。
// 标题身份闸恒在（strictTitleHit 硬接线——具名/开放轮同闸，见其头注实案）
const LRCLIB_UA = 'MeowSync external-lyric fallback (self-hosted)';
// verify（可选）：(hit, {pool})=>Promise<boolean> 逐候选归属核验——同名
// 汤里首顺位常被撞名者占住，判否换条在同源内完成而非整源判死；第二参
// 透排序后候选池身份供判官比较同题异曲；verify 缺席保持旧行为取第一
// 顺位（反查/直调等无核验通道场景，pool 也不构）
// choose（可选）：(pool)=>Promise<{pick,answered}|null> 整池单发消歧——
// 级联侧无艺人约束轮注入（开放轮与免时长末轮——具名轮不注，见
// cascade）：池 ≥1 条即把排序后前 8 条身份交判官一发选择题
// （单候选同走——布尔盲审的「拿不准判真」对同题异曲太松）。裁决三态：
//   {pick:extId, answered:true} —— 挑中后补跑 verify 词文核验再定收录
//     （pick 只比候选元数据不看词文，元数据消歧与词文归属是两道独立
//     证据）：判过 markVerified 收录；判否判死该变体不落回迭代（pick
//     已是池内最优的相对判定，最优条过不了词文关=池中无正解，逐条重
//     验只重复烧 AI）；核验通道故障（非 abort）按未收录落回 verify
//     迭代——candidatePass 式「异常放行」会把没验过的错词重新放进门；
//     指回池外 id 按未应答落回迭代
//   {pick:null,  answered:true} —— 判官明言全池无合理候选：判死该变体，
//     跳过逐候选核验兜底（precise 优先——错词比没词更糟）
//   null/{answered:false}      —— 通道未给裁决（AI 关/故障/畸形应答）：
//     落回 verify 迭代，降级期不缩召回
// deadline（可选）：级联软时限戳——逐候选迭代把单源 AI 判定面放大到
// 至多 3 次，过期起轮即停不再续烧；缺席保持旧行为（直调/测试不填）
// LRCLIB /api/search 的传输面（429 尊重 Retry-After 重试一次、5xx 单点
// 重试、体量闸读体）——lrclibFetch 级联检索与 searchLyricCandidates
// 手选候选池共用同一段请求序列，两消费面只在筛后处理上分家
async function lrclibSearchList(q, signal) {
  const url = `https://lrclib.net/api/search?q=${encodeURIComponent(q)}`;
  const doFetch = () => lyricFetch(url, {
    headers: { 'User-Agent': LRCLIB_UA, Accept: 'application/json' },
    signal: timedSignal(signal, SRC_REQ_TIMEOUT_MS),
    ...EXT_FETCH_GUARD,
  });
  let res = await doFetch();
  if (res.status === 429) {
    const waitSec = Number(res.headers.get('retry-after'));
    // Retry-After 过长/缺省不硬等——判失败换下一源，比堵调用方强
    if (!Number.isFinite(waitSec) || waitSec <= 0 || waitSec > RETRY_AFTER_MAX_SEC) {
      throw new Error('lrclib 限流');
    }
    await abortableSleep(waitSec * 1000, signal);
    res = await doFetch();
  }
  // 5xx 单点重试：观测过真实 503 抖动——800ms 后原样重发一次再判死。
  // 429 分支语义不动（Retry-After 已尊重过）；重发仍走 doFetch 同防御面
  if (!res.ok && res.status >= 500) {
    await abortableSleep(RETRY_5XX_DELAY_MS, signal);
    res = await doFetch();
  }
  if (!res.ok) throw new Error(`lrclib HTTP ${res.status}`);
  return readJsonCapped(res);
}

async function lrclibFetch({ title, artist, anchor, durationSec, verify, choose, signal, deadline }) {
  // 艺人面双态：AI 在位降排序偏好（artistOk 进排序键），AI 关维持硬滤。
  // anchor=失锚判定的比对艺人（级联 runRound 注入：具名轮=轮 artist，
  // 曲库 '' 开放轮=曲目原始 artist；缺省/null=不设锚）——失锚候选
  // 只在 verify 明言判真时收录，判不定拒收（详见文件头注 AI 段）
  const aiRank = aiEnabled();
  const q = [cleanQueryTitle(title), String(artist || '').trim()].filter(Boolean).join(' ');
  if (!q) return null;
  const list = await lrclibSearchList(q, signal);
  const items = (Array.isArray(list) ? list : [])
    .filter((it) => it && typeof it === 'object' && it.id != null)
    .filter((it) => it.instrumental !== true)
    .filter((it) => (typeof it.syncedLyrics === 'string' && it.syncedLyrics.trim())
      || (typeof it.plainLyrics === 'string' && it.plainLyrics.trim()))
    .filter((it) => aiRank || artistHit(artist, it.artistName))
    .filter((it) => strictTitleHit(it.trackName, title))
    .map((it) => ({
      it,
      synced: Boolean(typeof it.syncedLyrics === 'string' && it.syncedLyrics.trim()),
      artistOk: artistHit(artist, it.artistName),
      anchored: !normName(anchor) || artistHit(anchor, it.artistName),
      diff: durationSec && Number.isFinite(+it.duration) ? Math.abs(+it.duration - durationSec) : null,
    }))
    // 有声明时长才进时长闸；调用方没给时长则不做时长过滤
    .filter((x) => !durationSec || (x.diff != null && x.diff <= DUR_TOLERANCE_SEC));
  if (!items.length) return null;
  // 滚动词优先 → 艺人相符（AI 在位时仅是排序偏好；AI 关时已全部相符，
  // 键恒 0 不改旧序）→ 时长差升序（无差值殿后）
  items.sort((a, b) => Number(b.synced) - Number(a.synced)
    || Number(b.artistOk) - Number(a.artistOk)
    || (a.diff ?? 9e9) - (b.diff ?? 9e9));
  // 同题候选池：排序后前 POOL_TOP_N 条的条目身份——extId 与 hit.extId
  // 同式供 choose 指回条目；{title,artist,album} 随 verify 透出喂归属核验
  // （进 judgeInner 的 poolSeg 与 vkey v4 盐）。它是判定证据不是迭代面——
  // 逐候选核验上限仍 CANDIDATE_TRY_N 条不变
  const pool = items.slice(0, POOL_TOP_N).map(({ it }) => ({
    extId: `lrclib_${it.id}`,
    title: it.trackName, artist: it.artistName, album: it.albumName,
  }));
  // 条目 → hit 构造：choose 挑中条与逐候选迭代共用一份
  const hitOf = (pick) => {
    const syncedText = String(pick.syncedLyrics || '').trim();
    const plainText = String(pick.plainLyrics || '').trim();
    return {
      lrc: syncedText || plainText,
      plain: syncedText && plainText ? plainText : undefined,
      source: 'lrclib',
      extId: `lrclib_${pick.id}`,
      synced: Boolean(syncedText),
      // 候选条目身份——归属核验的同名异曲拦截证据（判定只入参与键版本段，
      // 不进 vkey 签名料：条目身份随 extId 稳定，不构成第二判定对象）
      meta: { title: pick.trackName, artist: pick.artistName, album: pick.albumName },
    };
  };
  // choose 通道：池 ≥1 条即整池单发消歧（单候选同走选择题——布尔盲审
  // 的「拿不准判真」对同题异曲太松）。裁决三态见函数头注：挑中条补跑
  // verify 词文核验再定收录（外层 verifyHit 凭 verified 烙记不重验）；
  // 明言否决与挑中条判否都判死该变体不落回兜底；核验故障（非 abort）/
  // 未应答/池外 id/迭代过期落回迭代
  if (choose && items.length >= 1) {
    let sel = null;
    try {
      sel = await choose(pool);
    } catch (e) {
      if (e?.aborted || signal?.aborted) throw abortErr();
      sel = null;                           // 消歧故障按未应答——落回迭代
    }
    if (sel?.answered) {
      // 判官否决全池——该变体判死：日志留痕，「池有候选却零产出」可回放
      if (sel.pick == null) {
        console.info(`[lyric-ext] lrclib 同题池 ${pool.length} 条被整池否决，判死该变体`);
        return null;
      }
      // 同 kugouFetch——过期不做 pick 处理落回迭代（迭代顶部 deadline
      // 闸自然截归 null）。不前置会让 verify 闭包的过期判否把「超龄未
      // 验」误记成「词文核验判否」日志——病例回放分不出真判否与没来
      // 得及验
      if (!(deadline && Date.now() >= deadline)) {
        if (signal?.aborted) throw abortErr();
        const idx = pool.findIndex((p) => p.extId === sel.pick);
        if (idx >= 0) {
          const hit = hitOf(items[idx].it);
          if (!verify) return markVerified(hit);   // 无核验通道——挑中即收旧行为
          try {
            // pick 只是元数据相对判定——词文归属是第二道独立证据。判否即
            // 判死该变体不落回迭代：池内最优条都过不了词文关说明池中无正
            // 解，逐条重验只是重复烧 AI 且同池条目大概率同错。verify 闭包
            // 自带 deadline 闸仍兜底「闸点到调用点间过期」的面——过期判否
            // 不盲收（该变体归 null 由级联尾部按截断分流）。失锚挑中条
            // 判不定（null）按拒收落回迭代——明言判真才收（失锚条款）
            const v = await verify(hit, { pool });
            if (v === false) {
              console.info(`[lyric-ext] lrclib 挑中条 ${sel.pick} 词文核验判否，判死该变体`);
              return null;
            }
            if (v === true || items[idx].anchored) return markVerified(hit);
          } catch (e) {
            if (e?.aborted || signal?.aborted) throw abortErr();
            // 核验通道故障按「未收录」落回逐候选迭代——candidatePass 式
            // 异常放行会把没验过的错词重新放进门；迭代内回盲审保底，与
            // 候选迭代已有容错同口径，不丢召回
          }
        }
        // 指回池外 id 按未应答落回迭代——不整源判死
      }
    }
  }
  // verify 在 → 至多前 CANDIDATE_TRY_N 条逐候选核验（条目内嵌歌词零额外
  // 请求），判否换条；不在 → 仅取首顺位
  for (const x of (verify ? items.slice(0, CANDIDATE_TRY_N) : items.slice(0, 1))) {
    if (signal?.aborted) throw abortErr();
    // 软时限戳在才查——过期即停：继续迭代只是在级联尾巴上多烧逐候选
    // AI 判定；归 null 由级联尾部分流（deadlineHit 在循环外层记）
    if (deadline && Date.now() >= deadline) break;
    const hit = hitOf(x.it);
    if (verify) {
      if (!(await candidatePass(verify, hit, signal, { pool }, x.anchored))) continue;
      markVerified(hit);
    }
    return hit;
  }
  return null;
}

// LRCLIB /api/get/<id>：按条目 id 直取——fetchByExtId 反查支路用，不走
// 检索自筛（归属核验在级联产出时已经做过，反查只是取回同一份词）
async function lrclibGetById(id, signal) {
  const res = await lyricFetch(`https://lrclib.net/api/get/${encodeURIComponent(id)}`, {
    headers: { 'User-Agent': LRCLIB_UA, Accept: 'application/json' },
    signal: timedSignal(signal, SRC_REQ_TIMEOUT_MS),
    ...EXT_FETCH_GUARD,
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`lrclib get HTTP ${res.status}`);
  const it = await readJsonCapped(res);
  if (!it || typeof it !== 'object' || it.id == null) return null;
  const syncedText = String(it.syncedLyrics || '').trim();
  const plainText = String(it.plainLyrics || '').trim();
  if (!syncedText && !plainText) return null;
  return {
    lrc: syncedText || plainText,
    plain: syncedText && plainText ? plainText : undefined,
    source: 'lrclib',
    extId: `lrclib_${it.id}`,
    synced: Boolean(syncedText),
  };
}

// ── 源 3：酷狗（华语/粤语补位）──
// search 拿 candidates（id+accesskey 成对出现才可用），download fmt=lrc
// 直给行级 LRC 的 base64（krc 加密形态不解，回包有卫生闸——fmt 非 lrc/
// krc1 magic/低可打印率载荷拒收）。艺人面同 lrclibFetch 双态（AI 在位
// 降排序偏好、AI 关硬滤）。候选按艺人相符 → 时长差升序 → 上游 score
// 决胜，至多串行试 CANDIDATE_TRY_N 条——单条失败换条不恋战。
// 候选标题字段实测是 song（部分回包形态带 songname——两槽都认）
const kugouCandTitle = (cd) => cd.song || cd.songname;

// 酷狗 search 一跳：keyword+duration 提示 → candidates 原始回包——
// kugouFetch 级联与 searchLyricCandidates 手选候选池共用同一段请求
async function kugouSearchList(kw, durationSec, signal) {
  const durArg = durationSec ? `&duration=${Math.round(durationSec * 1000)}` : '';
  const sres = await lyricFetch(`https://lyrics.kugou.com/search?ver=1&man=yes&client=pc&keyword=${encodeURIComponent(kw)}${durArg}`, {
    headers: { 'User-Agent': YTM_UA, Accept: 'application/json' },
    signal: timedSignal(signal, SRC_REQ_TIMEOUT_MS),
    ...EXT_FETCH_GUARD,
  });
  if (!sres.ok) throw new Error(`kugou search HTTP ${sres.status}`);
  return readJsonCapped(sres);
}

// 酷狗 download 一跳：candidate id + accesskey → fmt=lrc 词原文。
// kugouFetch 的 downloadHit 迭代与 fetchByExtId 的手选重取（候选池
// token 透回）共用同一段请求 + 载荷卫生闸（krc1 magic/低可打印率拒收）
async function kugouDownloadLrc(id, accesskey, signal) {
  const dres = await lyricFetch('https://lyrics.kugou.com/download?ver=1&client=pc'
    + `&id=${encodeURIComponent(String(id))}&accesskey=${encodeURIComponent(String(accesskey))}`
    + '&fmt=lrc&charset=utf8', {
    headers: { 'User-Agent': YTM_UA, Accept: 'application/json' },
    signal: timedSignal(signal, SRC_REQ_TIMEOUT_MS),
    ...EXT_FETCH_GUARD,
  });
  if (!dres.ok) return null;
  const dbody = await readJsonCapped(dres);
  // 非 LRC 载荷拒收（换条不恋战）：fmt 协商失败回 'krc' 等其它格式
  if (dbody?.fmt != null && String(dbody.fmt).toLowerCase() !== 'lrc') return null;
  const buf = Buffer.from(String(dbody?.content || ''), 'base64');
  // 'krc1' magic = KRC 加密词——协商漏判时按内容再挡一道
  if (buf.subarray(0, 4).toString('latin1') === 'krc1') return null;
  const lrc = buf.toString('utf8').trim();
  if (!lrc) return null;
  // 无时间戳又大面积不可打印/替换符 = 实为二进制/乱码载荷——拒收；
  // 真纯文本词（无戳但正常可读）放行走 synced:false 面
  if (!parseLrcLines(lrc).length) {
    const units = [...lrc];
    // 可打印=非控制类（\p{C} 覆盖 Cc/Cf/Co/Cs/Cn）且非替换符
    // U+FFFD（So 类不在 \p{C} 内，码点单列）；\r\n\t 是版面不是脏字
    const printable = units.filter((ch) => '\r\n\t'.includes(ch)
      || (ch.charCodeAt(0) !== 0xFFFD && !/\p{C}/u.test(ch))).length;
    if (printable < units.length * KUGOU_PRINTABLE_MIN) return null;
  }
  return lrc;
}

// 标题身份闸恒在（strictTitleHit 硬接线，语义同 lrclibFetch 头注）
// verify（可选）：(hit, {pool}) 逐候选归属核验——download 得词后判否即
// 换条，并入「单条失败换条」同款语义；第二参透排序后候选池身份（同
// lrclibFetch）；缺席取首个可用条（pool 也不构）
// choose（可选）：(pool)=>Promise<{pick,answered}|null> 整池单发消歧
// （同 lrclibFetch 三态契约）——挑中只对这一条发 download，得词后同
// 补 verify 词文核验：判过收录；判否判死该变体不落回迭代（最优条过
// 不了词文关=池中无正解）；核验通道故障（非 abort）按未收录落回迭
// 代；判官明言否决全池判死该变体；目标 download 失败/choose 故障/
// 池外 id/未应答都按未选中落回逐候选迭代
// deadline（可选）：级联软时限戳——候选迭代过期起轮即停（每条候选都
// 还要烧一发 download 拿词再判定）；缺席保持旧行为
async function kugouFetch({ title, artist, anchor, durationSec, verify, choose, signal, deadline }) {
  // 艺人面双态：AI 在位降排序偏好（artistOk 进排序键），AI 关维持硬滤。
  // anchor 口径同 lrclibFetch（失锚候选须 verify 明言判真才收）
  const aiRank = aiEnabled();
  const kw = [cleanQueryTitle(title), String(artist || '').trim()].filter(Boolean).join(' ');
  if (!kw) return null;
  const sbody = await kugouSearchList(kw, durationSec, signal);
  const cands = (Array.isArray(sbody?.candidates) ? sbody.candidates : [])
    .filter((cd) => cd && cd.id != null && cd.accesskey)
    .filter((cd) => aiRank || artistHit(artist, cd.singer))
    .filter((cd) => strictTitleHit(kugouCandTitle(cd), title))
    .map((cd) => ({
      cd,
      artistOk: artistHit(artist, cd.singer),
      anchored: !normName(anchor) || artistHit(anchor, cd.singer),
      // 候选 duration 是毫秒——与 durationSec 同量纲化再比差
      diff: durationSec && Number.isFinite(+cd.duration)
        ? Math.abs(+cd.duration / 1000 - durationSec) : null,
    }))
    .filter((x) => !durationSec || (x.diff != null && x.diff <= DUR_TOLERANCE_SEC));
  cands.sort((a, b) => Number(b.artistOk) - Number(a.artistOk)
    || (a.diff ?? 9e9) - (b.diff ?? 9e9)
    || (b.cd.score || 0) - (a.cd.score || 0));
  // 同 lrclib——排序后前 POOL_TOP_N 条候选身份进 pool（extId 与 hit.extId
  // 同式供 choose 指回；{title,artist,album} 喂归属核验，判定证据非迭代
  // 面）；酷狗候选无专辑字段则 album 略
  const pool = cands.slice(0, POOL_TOP_N).map(({ cd }) => ({
    extId: `kugou_${cd.id}`,
    title: kugouCandTitle(cd), artist: cd.singer,
    album: cd.album || cd.albumname || undefined,
  }));
  // 单候选 download → hit：失败归 null（调用方换条/落回迭代，不整源判
  // 死），abort 穿透。choose 挑中条与逐候选迭代共用一份；传输面收在
  // 模块级 kugouDownloadLrc（手选重取 fetchByExtId 同用）
  const downloadHit = async (cd) => {
    try {
      const lrc = await kugouDownloadLrc(cd.id, cd.accesskey, signal);
      if (!lrc) return null;
      return {
        lrc, source: 'kugou', extId: `kugou_${cd.id}`,
        synced: parseLrcLines(lrc).length > 0,
        // 同 lrclib——候选条目身份透给归属核验（酷狗候选无专辑字段则略）
        meta: {
          title: kugouCandTitle(cd), artist: cd.singer,
          album: cd.album || cd.albumname || undefined,
        },
      };
    } catch (e) {
      if (e?.aborted || signal?.aborted) throw abortErr();
      return null;
    }
  };
  // choose 通道同 lrclibFetch：池 ≥1 条即整池单发消歧，挑中只对这一条发
  // download，得词后补 verify 词文核验——判过 markVerified 收录；判否
  // 判死该变体不落回迭代（理由同 lrclibFetch：池内最优过不了词文关=
  // 池中无正解）；核验通道故障（非 abort）按未收录落回迭代（被挑条
  // 在迭代里重 download 重验，盲审保底不丢召回）；明言否决判死该变
  // 体；未应答/池外 id/download 失败/迭代过期都按未应答落回逐候选迭
  // 代（被挑条在迭代里再败即换条，语义同构）
  if (choose && cands.length >= 1) {
    let sel = null;
    try {
      sel = await choose(pool);
    } catch (e) {
      if (e?.aborted || signal?.aborted) throw abortErr();
      sel = null;                           // 消歧故障按未应答——落回迭代
    }
    if (sel?.answered) {
      // 判官否决全池——该变体判死：日志留痕同 lrclibFetch
      if (sel.pick == null) {
        console.info(`[lyric-ext] kugou 同题池 ${pool.length} 条被整池否决，判死该变体`);
        return null;
      }
      if (!(deadline && Date.now() >= deadline)) {
        if (signal?.aborted) throw abortErr();
        const idx = pool.findIndex((p) => p.extId === sel.pick);
        const hit = idx < 0 ? null : await downloadHit(cands[idx].cd);
        if (hit) {
          if (!verify) return markVerified(hit);   // 无核验通道——挑中即收旧行为
          try {
            // 得词补验（deadline 过期判否在 verify 闭包内——无法核验的
            // 挑中条不收录、判死该变体，取舍同 lrclibFetch）。失锚挑中条
            // 判不定（null）按拒收落回迭代——明言判真才收（失锚条款）
            const v = await verify(hit, { pool });
            if (v === false) {
              console.info(`[lyric-ext] kugou 挑中条 ${sel.pick} 词文核验判否，判死该变体`);
              return null;
            }
            if (v === true || cands[idx].anchored) return markVerified(hit);
          } catch (e) {
            if (e?.aborted || signal?.aborted) throw abortErr();
            // 核验通道故障按「未收录」落回迭代——见上注
          }
        }
        // 目标条 download 失败/核验故障都按「未选中」落回迭代——既有语义不动
      }
    }
  }
  for (const x of cands.slice(0, CANDIDATE_TRY_N)) {
    if (signal?.aborted) throw abortErr();
    // 同 lrclibFetch——过期即停：每条候选还要烧一发 download 再核验
    if (deadline && Date.now() >= deadline) break;
    const hit = await downloadHit(x.cd);
    if (!hit) continue;  // 单条候选失败换下一条——不整源判死
    // 核验在 download 外：核验通道故障要放行候选（与级联「核验故障不拦」
    // 同口径），并入「单条失败换条」会把核验哑火放大成整源判死；失锚
    // 候选反过来判不定/异常拒收（失锚条款——见 candidatePass 头注）
    if (verify) {
      if (!(await candidatePass(verify, hit, signal, { pool }, x.anchored))) continue;  // 判否换条
      markVerified(hit);
    }
    return hit;
  }
  return null;
}

// ── 级联与缓存包装 ──
// AI 归属核验：判「明显是别的歌」视同无词继续下一源；核验通道故障/判不定
// 放行。无条件走 judgeLyricLines——它内部 getVerdict 缓存先行（命中即返不烧
// AI），「已落库判定不随 aiEnabled 旁路」与下载链 verifyDownloadOwnership
// 同口径；AI 关时 askAiJson 前置返 null 按判不定放行。vkey 锚
// (extId, title, author)——与 verifyDownloadOwnership 传 providerData 同款
// 签名时同键命中落库判定。
// hit.meta（检索命中的候选条目身份）进 judgeLyricLines 的 candidate 参——
// 词面撞名时条目身份是同名异曲拦截的关键证据；pool（可选，检索侧排序
// 后前 8 条身份）挂 candidate.pool 进判定提示词，vkey 同步换 v4 盐——
// pool 语境判定与无池盲审互不命中（见 lyricVerdictKey 版本段说明）；
// declared（可选）= 已反解落地的本家声明 {title,author}——级联声明轮
// 起透进判定语境（自署本家行进 prompt；「有声明」位进 vkey 盐尾分键
// ——无声明语境落的持久 verdict 不能被携自署证据的重判吃到，否则
// 声明轮/末轮同 extId 重进撞旧键、自署证据根本没进判）
async function verifyHit(hit, { title, artist, signal, pool, declared }) {
  let lines = parseLrcLines(hit.lrc);
  // 纯文本词不再零核验：剥标签行取词文行抽样——剥完真空（纯元行/
  // instrumental 声明词这类没词文的形态）才放行
  if (!lines.length) lines = plainTextLines(hit.lrc);
  if (!lines.length) return true;
  // declMark 与 judgeInner declSeg 出场条件逐字对齐（declTitle||declAuthor），
  // 同 ai.js:305 / lyric-verify.js:484 的声明位口径——声明实参在场但题/名
  // 全空时键与 prompt 不劈叉（本链 declaredNow 由 resolveDeclared 产出，
  // title 非空才落值，此分叉实际不可达——纯对称收口）
  const vkey = lyricVerdictKey(hit.extId, title || '', artist || '', pool?.length,
    Boolean(declared?.title || declared?.author));
  // 三态直透（true 判过/false 判否/null 判不定）——失锚候选须明言判真、
  // 相符候选判不定放行的取舍由候选所属轮的锚口径裁决（candidatePass）
  return await judgeLyricLines({
    vkey, lines, title: title || '', author: artist || '',
    candidate: { ...hit.meta, pool }, signal, declared,
  });
}

async function cascade({ songId, title, artist, durationSec, videoId, signal, deadlineMs = CASCADE_DEADLINE_MS }) {
  const ytVid = String(videoId || '') || String(songId || '').match(YT_TRACK_ID_RE)?.[1] || '';
  // 检索标题变体：raw 在前、剥缀形态殿后——每个 artist 轮内 LRCLIB/酷狗
  // 各自按序串行试，首个非 null 命中即停该源（YTM 吃 videoId 不吃
  // title——保持首轮一次不动）。artist 传调用方原始值而非 roundArtist
  // ——变体生成是输入清洗，与归属轮次解耦；但占位作者（'_'/'unknown'）
  // 不配当变体锚（j/k 规则会拿它吃掉标题首词），滤成 '' 与匹配漏斗的
  // informativeArtist 同口径
  const titleVariants = titleVariantsOf(title, isPlaceholderAuthor(artist) ? '' : artist);
  // 级联软时限：artist 轮 × 源 × 变体的展开会挤爆前端 80s 超时里 AI 核验
  // 与响应的份额——每轮/每变体启动前查一次，超线记 deadlineHit 截断。
  // 截断不是干净 miss，尾部按「截断前已有源抛错→抛 lastErr 走重试；
  // 纯没跑完→null+truncated（调用方不落负缓存）」分流
  const deadline = Date.now() + deadlineMs;
  // 检索轮次（artist 画像）：首轮严格用调用方给的 artist。UGC 曲
  // （bv_/yt_/显式 videoId）的 artist 实为 UP 主/频道名，严格轮必灭——
  // 干净 miss 后追加降轮：
  //   1. artistFromTitle 剥出的真实艺人候选
  //   2. artist:'' 宽检——artistHit('','x') 放行全部
  // 宽检轮（artist 归一为空=无艺人约束，'' 与 '_'/'--' 类占位符都算——
  // 实证病例作者就是 '_'）在标题闸之上再注入 choose 整池消歧；具名
  // artist 轮同样过 strictTitle 标题闸（artistHit 子串命中≠同曲——
  // 见 strictTitleHit 头注 '□° ver.EMA' 实案），只不注 choose 保召回。
  // 曲库行（qq_/数字/其他非 UGC）：AI 关时不加降轮——宽检会把「真无词」
  // 变成「可能错词」（无核验兜底）；AI 在位时同样追加 '' 开放轮——
  // artist 元数据不可信（命名轮 artistHit 已降排序偏好不再滤池），
  // 具名轮全灭后宽检 + choose/verify 兜底仍能把翻唱/原唱条目捞回
  const ugc = Boolean(ytVid) || BV_TRACK_ID_RE.test(String(songId));
  const artistRounds = [String(artist || '')];
  if (ugc) {
    const seen = new Set(artistRounds.map(normName));
    for (const a of [artistFromTitle(title), '']) {
      const k = normName(a);
      if (!seen.has(k)) { seen.add(k); artistRounds.push(a); }
    }
  } else if (aiEnabled() && normName(artistRounds[0])) {
    artistRounds.push('');
  }
  let lastErr = null;
  let cleanMiss = false;   // 有过「干净的无词」终态（区别于全源传输故障）
  let deadlineHit = false; // 被软时限截断——展开没跑完，不等价于「无词」

  // fetch 层逐候选核验闭包：同名曲汤里首顺位常是撞名者——判否换条在
  // 同源内完成（每候选 vkey 挂各自 extId 互不串），「一锤定音」的整源
  // 判死面收窄成单候选判否。归属签名始终用来源原标题/作者（vkey 与
  // 下载链同口径）——roundArtist 与变体 title 只是检索展开的候选料，
  // 不进归属判定。extra.pool 是该次检索排序后前 8 条身份——判官拿到
  // 同题池才分得清「同题异曲里来源实际唱哪条」（vkey 换 v4 盐与无池
  // 判定互不命中）。declaredNow 同理随语境透传：yt_ 级联在常规轮发
  // 起前已解析置位（下方 eager 解析点），逐候选调用读的是已落地的
  // 同步值、不在闭包里每次 await
  const verify = async (h, extra) => {
    // 软时限过期判否而非放行——候选迭代把单源单变体 AI 判定面放大到至
    // 多 3 次，迭代中过期还逐条烧 AI 会把级联拖出 45s 软时限；但过期
    // 放行等于零词文核验盲收——choose 挑中条同此（无法核验的挑中条
    // 不该入库，错词比没词更糟）。判否即收束：迭代路径由循环顶部
    // deadline break 自然截断归 null（级联尾部按 truncated 不落负缓
    // 存，下次播放重试）；pick 路径走 verify===false 判死该变体的既
    // 有语义
    if (Date.now() >= deadline) return false;
    const ok = await verifyHit(h, { title, artist, signal, pool: extra?.pool, declared: declaredNow });
    if (ok === false) console.info(`[lyric-ext] 候选 ${h.extId} 词归属核验不符，试下一条`);
    return ok;                      // 三态直透：锚口径裁决在 candidatePass
  };

  // 无艺人约束轮的整池单发消歧闭包：同题异曲逐候选盲审不够决断（实证
  // KKB 英文版被判 ok 收录；开放轮 'Boi/Moonlight' 类同题异曲连放）——
  // 排序后候选池整盘交 judgePoolPick 做单发选择题「来源最可能翻唱哪
  // 条」，0 基下标翻回池条 extId 透传给 fetch 层。出参三态契约（fetch
  // 层消费，见 lrclibFetch 头注）：{pick:extId, answered:true} 挑中 /
  // {pick:null, answered:true} 判官明言否决全池（fetch 层判死该变体、
  // 跳过逐候选兜底——错词比没词更糟）/ null 通道未给裁决（AI 关/异常/
  // abort/畸形——落回逐候选核验，降级期不缩召回）。签名用来源原始
  // title/artist——与 verify 同口径：roundArtist/变体只是检索展开的
  // 候选料不进判定。按池 extId 集 memoize：LRCLIB/酷狗两池各判一次，
  // 同池在变体/轮次展开里重进不重复烧 AI，否决亦按池存续（同池再进
  // 同死；末轮免时长池 ⊋ 常规轮时长滤后池——异池换键重判不吃旧裁
  // 决）。键上「d|」有声明位是兜底：declaredNow 现于常规轮发起前即
  // 就位、级联内不再跨语境翻转，同池恒同键共享裁决；防御声明曾随声
  // 明轮才落地的旧路径——无声明语境的旧裁决不复用到带自署证据的新
  // 判定。过期/异常归 null——「未应答」由 fetch 层落回迭代（迭代自带
  // deadline/abort 闸）
  const pickMemo = new Map();   // 声明位+池 extId 集 -> Promise<{pick,answered}|null>
  const choose = (pool) => {
    if (Date.now() >= deadline) return Promise.resolve(null);
    const key = (declaredNow ? 'd|' : '') + pool.map((p) => p.extId).join('|');
    let p = pickMemo.get(key);
    if (!p) {
      p = judgePoolPick({ title, author: artist, pool, signal, declared: declaredNow })
        .then((r) => {
          if (!r?.answered) return null;              // 通道未给裁决
          // 0 基下标翻回 extId；pick:null 明言否决原样透传给 fetch 层
          return { pick: r.pick == null ? null : pool[r.pick]?.extId ?? null, answered: true };
        })
        .catch(() => null);
      pickMemo.set(key, p);
    }
    return p;
  };

  // 本家声明证据（yt_ 限定）：utaite 投稿描述里的 original:/本家: 链接
  // 反解 {title,author} 真身元数据——同题异曲在元数据层不可分，声明是
  // 检索侧的确定性出口。常规轮发起前解析一次 + memoize：一次级联至
  // 多一次（头轮起的判定语境与声明轮共用同一份证据）。fail-soft——
  // 函数缺席（并行落地期）/故障/超时归 null 按无声明走原路径。abort
  // 不在本层穿透：impl 真身把 abort 吞成 null 落地（归「无声明」继续），
  // 中止信号靠级联轮/变体检查点的 signal?.aborted 闸穿透——declaredNow
  // 落 null 照常展开即被下一闸截停；下方 catch 的重抛只兜 impl 真抛
  // aborted 的面（fail-soft 不吞取消语义）。解析计入 deadline：signal
  // 挂「调用方 signal ∪ 剩余时限」，外加 race 兜底——impl 不吃 signal
  // 时硬等也不拖穿 45s 软时限（unref 计时器不绊事件循环收尾）
  // declaredNow = 已落地的声明值——上方 verify/choose 闭包按调用时
  // 读它进判定语境；置位点在下方常规轮循环前的 eager 解析点——yt_
  // 级联自首轮起的 choose/verify 即持自署证据
  let declaredP = null;
  let declaredNow = null;
  const resolveDeclared = () => {
    if (declaredP) return declaredP;
    const remaining = Math.max(1, deadline - Date.now());
    const TIMEOUT = {};
    declaredP = Promise.race([
      Promise.resolve().then(() => ytLib.resolveOriginalInfo?.({
        videoId: ytVid, signal: timedSignal(signal, remaining),
      })),
      new Promise((res) => {
        const t = setTimeout(() => res(TIMEOUT), remaining);
        t.unref?.();
      }),
    ]).then((r) => (r && r !== TIMEOUT && String(r.title || '').trim()
      ? { title: String(r.title).trim(), author: String(r.author || '').trim() }
      : null))
      .catch((e) => {
        if (e?.aborted || signal?.aborted) throw abortErr();
        return null;
      });
    return declaredP;
  };

  // 检索面去重（源,roundArtist,title,dur 已打查询集）：声明轮本家变体
  // 与来源变体交叠时同面查询在上游回包等值——跳过重打不重复扇出。
  // 常规轮间 artist/变体已各自去重，此集只对声明轮真正咬人
  const searched = new Set();

  // 单轮展开体：roundArtist × 源 × 标题变体——常规轮/声明轮/免时长末轮
  // 共用一份执行体（dur/withYtm/tag/choose/titles 取值不同；titles 缺省
  // 用来源标题变体——声明轮喂本家题变体；标题闸在 fetch 层硬接线全轮
  // 在位；choose 只注入无艺人约束轮：'' 开放轮/声明开放轮/免时长末轮，
  // 具名轮多候选仍走逐候选核验）。命中且过归属核验即返 hit；干净 miss
  // 归 null；deadline 记 deadlineHit 断展开
  const runRound = async ({ roundArtist, dur, tag, withYtm = false, choose = undefined, titles = titleVariants }) => {
    // 失锚判定的比对基准：具名轮=轮自身 artist；曲库 '' 开放轮锚曲目
    // 原始 artist（roundArtist '' 是「无检索约束」不是锚——开放轮池须按
    // 原艺人面判失锚）；UGC '' 开放轮不设锚——UGC artist 是 UP 主非原曲
    // 艺人，锚它会灭掉全部翻唱命中（与旧口径同宽）
    const anchor = normName(roundArtist) ? roundArtist : (ugc ? null : artist);
    const sources = [];
    // YTM 支路吃 videoId 不吃 artist——只在常规首轮排（重复打同一份词没意义）
    if (withYtm) sources.push(['ytm', (sig) => ytmFetchLyric(ytVid, sig)]);
    sources.push(['lrclib', (sig, t) => lrclibFetch({ title: t, artist: roundArtist, anchor, durationSec: dur, verify, choose, signal: sig, deadline })]);
    sources.push(['kugou', (sig, t) => kugouFetch({ title: t, artist: roundArtist, anchor, durationSec: dur, verify, choose, signal: sig, deadline })]);
    for (const [name, run] of sources) {
      if (signal?.aborted) throw abortErr();
      let hit = null;
      // LRCLIB/酷狗按标题变体串行展开（YTM 单次——t=null 占位不吃）
      for (const t of (name === 'ytm' ? [null] : titles)) {
        if (signal?.aborted) throw abortErr();
        // 已打过的 (源,artist,title,dur) 检索面不重打——声明轮与常规轮
        // 交叠时同面查询回包等值，跳过只是省上游扇出，语义不变（miss 面
        // 已记）。dur 在键里：免时长末轮的同题名同艺人查询时长面不同
        // （kugou 摘 duration= 参、lrclib 摘 ±15s 自筛）——不是重复扇出
        const sKey = t != null
          ? JSON.stringify([name, normName(roundArtist), normKey(t), dur || 0])
          : null;
        if (sKey && searched.has(sKey)) continue;
        if (sKey) searched.add(sKey);
        if (Date.now() >= deadline) { deadlineHit = true; break; }
        try {
          hit = await run(signal, t);
        } catch (e) {
          if (e?.aborted || signal?.aborted) throw abortErr();
          // 轮次/变体标注进日志便于病例回放——语义同原「第N轮」
          const vtag = t && t !== titles[0] ? `·变体「${t}」` : '';
          console.warn(`[lyric-ext] ${name} 源失败（${tag}${vtag}）：${e?.message || e}`);
          // 传输故障的面没吃到回包——回滚「已检索」烙记：记席只该挡
          // 「回包等值」的重复扇出，故障面不算已检索，给声明轮/末轮的
          // 同面查询留一次新机会
          if (sKey) searched.delete(sKey);
          lastErr = e;
          break;  // 传输故障换源——同族变体重打大概率同死
        }
        if (hit) break;   // 首个非 null 命中即停该源
        cleanMiss = true;
      }
      if (!hit) continue;
      // fetch 内逐候选核验验收过的命中带 verified 烙记——vkey 同口径已
      // 验过不再二次烧 AI；YTM 支无逐候选通道，照旧过外层 verifyHit
      // （declaredNow 同透——yt_ 级联自首轮起已持自署证据）
      if (!hit.verified) {
        // 外层核验同吃级联 deadline 闸（与 verify 闭包口径对齐）：词到手
        // 已过期就不验不收——判否不收录、记截断续下一源，尾部归 truncated
        // null 不落负缓存（过期词的核验结论没跑完，判死等同盲收外）。
        // 丢命中留日志——同类判否都有 [lyric-ext] 行，静默丢会让截断病例无从回放
        if (Date.now() >= deadline) {
          deadlineHit = true;
          console.info(`[lyric-ext] ${name} 命中到手已过级联时限，弃收续下一源（${tag}）`);
          continue;
        }
        try {
          // 判不定放行——本支是「无候选池语境」盲审面（YTM 直词/无锚对照），
          // 逐候选失锚收紧只在 fetch 层 candidatePass 内生效
          if ((await verifyHit(hit, { title, artist, signal, declared: declaredNow })) === false) {
            console.info(`[lyric-ext] ${name} 词归属核验不符，继续下一源`);
            cleanMiss = true;
            continue;
          }
        } catch (e) {
          if (e?.aborted || signal?.aborted) throw abortErr();
          // 核验通道故障放行——与 verifyDownloadOwnership 归 null 同口径
        }
      }
      return hit;
    }
    return null;
  };

  // yt_ 级联 eager 解析点：常规轮发起前反解本家声明——choose/verify
  // 自首轮起持自署证据（判官对同题池看得到「自署本家」轴，池中无本家
  // 条目时倾向判死而非乱挑）。成本至多 +2 跳且只落在 yt_（self 描述
  // +本家反解——描述缺席时自跳也计，fail-soft 归 null 继续）；fail-soft
  // 在 resolveDeclared 内——故障/超时/无声明归 null 照常跑无声明路径。
  // deadline 已穿不解析：轮循环头自会记 deadlineHit 截断，不白烧反解跳
  if (ytVid) {
    if (signal?.aborted) throw abortErr();
    if (Date.now() < deadline) declaredNow = await resolveDeclared();
  }

  for (let round = 0; round < artistRounds.length; round++) {
    if (signal?.aborted) throw abortErr();
    if (Date.now() >= deadline) { deadlineHit = true; break; }
    const roundArtist = artistRounds[round];
    const hit = await runRound({
      // 标题身份闸全轮在位（fetch 层硬接线——具名轮的 artistHit 子串
      // 约束只收窄召回、不能替代标题证据：'EMA' 撞进 'MAISONdes
      // feat. EMA & たなか' 艺人字段照样放行同题异曲，实案 '□° ver.EMA'
      // 具名轮回收 'ダンス・ダンス・ダダ' 落错词）。上闸的有意取舍：
      // 具名轮（含曲库单轮场景）的模糊召回面一并收掉——跨文字译名/
      // 子串撞名命中一律拒，漏判走 rematch 与绑后外源兜底自愈，错词
      // 比没词更伤
      roundArtist, dur: durationSec,
      tag: `第${round + 1}轮`, withYtm: round === 0 && Boolean(ytVid),
      // choose 仍只注入无艺人约束轮（'' 开放轮；末轮下方显式注入）——
      // 具名检索词已把上游候选面收窄到艺人相关条目，同题异曲面小，
      // 多烧一发整池判定不抵收益：标题闸 + 逐候选核验照旧保召回
      choose: normName(roundArtist) ? undefined : choose,
    });
    if (hit) return { hit, truncated: false };
  }

  // 声明轮（yt_ 限定，先于免时长末轮）：常规轮全灭后以 eager 点已解析
  // 的本家声明 {title,author}（上方 memoize 结果直读，不重解）重扫两检
  // 索源——同题异曲在元数据层不可分（'Moonlight'→moumoon/Gaulin 同名
  // 异曲、'Boi'→Dina Jashari 马其顿语同名歌），声明证据比摘时长闸更精
  // 准故排前。具名本家 author 收窄池（artistHit 在位，同具名轮口径不
  // 注 choose）；author 缺席/占位作开放轮照注 choose 整池消歧；
  // 标题闸全轮硬接线在位。跳轮条件=「题相同且艺人面无新信息」：本家题
  // 归一与来源题相同但 author 是新艺人轴仍起轮——具名轮 artistHit
  // 收窄的正是缺的那条检索轴（实案：来源题归一与本家题同 'Moonlight'，
  // 常规轮只跑过来源艺人具名+开放两轮，本家 author 'shima' 的具名面
  // 从未被检索）；author 缺席/占位或与来源 artist 归一相同才是纯重复
  // 不重打（残留交叠变体由 runRound 检索面去重再兜一层）。declaredNow
  // 在 eager 点已置位——跳轮与否不影响判定语境（自首轮起已携）。常规
  // 轮全死于传输故障（lastErr 无干净 miss）不展开——同源重试必死白打，
  // 与末轮 gate 同口径；deadline 过期不起轮记 deadlineHit 走尾部分流
  if (ytVid && !(lastErr && !cleanMiss)) {
    if (signal?.aborted) throw abortErr();
    if (Date.now() >= deadline) deadlineHit = true;
    else {
      const declared = await resolveDeclared();   // memoize 直读——eager 点已发起
      if (declared) {
        // 占位本家 author（'unknown'/'_' 类）不配当具名约束——滤成 ''
        // 走开放轮，与 artistRounds 的 informativeArtist 口径一致
        const dAuthor = isPlaceholderAuthor(declared.author) ? '' : declared.author;
        const sameTitle = normKey(cleanQueryTitle(declared.title))
          === normKey(cleanQueryTitle(title));
        // 艺人面相同 = 声明 author 缺席/占位（无艺人信息可增），或归一
        // 后与来源 artist 相同（该具名面已被常规轮覆盖）
        const sameArtist = !dAuthor || normName(dAuthor) === normName(artist);
        if (!sameTitle || !sameArtist) {
          const hit = await runRound({
            roundArtist: dAuthor, dur: durationSec,
            titles: titleVariantsOf(declared.title, dAuthor),
            tag: '声明轮', choose: normName(dAuthor) ? undefined : choose,
          });
          if (hit) return { hit, truncated: false };
        }
      }
    }
  }

  // 免时长末轮（UGC 限定）：截取版/片头尾超长的投稿对 ±15s 时长闸必灭。
  // 收成单次 artist='' 开放轮重扫：durationSec=0、标题闸恒在位
  // ——无艺人约束轮自带 choose 整池单发消歧 + 带同题池语境的逐候选
  // 核验兜底兜撞名排序（裁决按池 extId 集 memoize：末轮免时长池 ⊋
  // 常规轮时长滤后池，异池换键重判不吃旧否决/旧 pick）。刻意不按原
  // artist 轮次面重扫——
  // 免时长后标题是唯一硬证据，此时任何具名 artist 约束都只收窄不增益：
  // UGC 的 artist 是翻唱者/UP 主，不等于原曲艺人（实证：72s 截取版
  // 'Flamingo／rei shirose' artist='R'，具名轮 artistHit('R') 归一成
  // 'r' 子串筛——放行英文同名异曲 'Earl Bostic' 却滤死真身 '米津玄師'/
  // 'Kenshi Yonezu' 两版；单开放轮是具名轮超集，剩下的撞名歧义交给
  // 整池消歧 + pool 语境逐候选核验判）。刻意取舍不变：只救「截取版/
  // 片头尾超长」型失效——strictTitle 在位，跨文字形态（罗马音 vs
  // 原名）依旧不互认；曲库行不进末轮（同宽检不加降轮的理由）。
  // YTM 吃 videoId 不吃 title/duration 不重复排。
  // gate 两收（lastErr/cleanMiss 即上方级联面，本地可读）：
  //  · durationSec 缺省/0——常规轮本就免时长过滤，末轮与 '' 宽检轮
  //    逐字节同参，纯重复扇出
  //  · 常规轮全死于传输故障（lastErr 在且无干净 miss）——末轮同源重试
  //    必死白打；更糟的是末轮某源恰回干净空表会把 cleanMiss 污染回
  //    true，尾部 lastErr && !cleanMiss 失稳归 null 被 cacheWrite 固化
  //    成 10min 负缓存，违背「传输故障不固化负缓存」设计
  if (ugc && Number(durationSec) > 0 && !(lastErr && !cleanMiss)) {
    if (signal?.aborted) throw abortErr();
    // 过期即不起轮——与常规轮同款截断记法，归尾部分流
    if (Date.now() >= deadline) deadlineHit = true;
    else {
      const hit = await runRound({
        roundArtist: '', dur: 0, tag: '末轮·免时长', choose,
      });
      if (hit) return { hit, truncated: false };
    }
  }
  // 尾部判定前先补一记末位截断：deadlineHit 此前只在轮次/变体/轮段
  // gate 的检查点置位——deadline 若在最后一次 run() 内部耗穿（fetch
  // 层迭代判否/download 拖时）且其后无检查点（qq_/无时长路径不经声
  // 明轮与免时长末轮 gate），循环正常归 null 会漏记截断，落成 10min
  // 负缓存把「没跑完」固化成「无词」。截断 null 与干净 miss 的分界
  // 只有「归 null 那刻是否已过期」——超龄级联一律按截断分流：恰过
  // 线的真干净 miss 也只是少一次负窗（保守向安全），同键重查真打上级
  deadlineHit ||= Date.now() >= deadline;
  // 尾部判定：
  //  · deadline 截断且截断前已有源在传输层抛错（混合故障）→ 抛
  //    lastErr——截断掐掉的只是「还没跑的源/变体」，已发生的故障不能
  //    被吞成「无词」固化 10min；与全源故障同待遇走重试、不写缓存
  //  · 全源都死在传输层（一个「干净无词」终态都没有）→ 抛 lastErr
  //  · 其余回 null：deadlineHit 带 truncated（没跑完≠无词，不落缓存）；
  //    lastErr 带 dirty（有源故障的混合结局——故障源的检索面可能根本没
  //    被执行，只写 DIRTY_NEG_TTL_MS 短负窗挡连击，不写 10min 假阴性）
  if (deadlineHit && lastErr) throw lastErr;
  if (lastErr && !cleanMiss) throw lastErr;
  return { hit: null, truncated: deadlineHit, dirty: Boolean(lastErr) };
}

// extId → 词原文反查（ai.js 词源核验/翻译端点的取词支路与
// routes/lyric-manual 的手选绑定——它们手里只有词源 id 没有检索词）。
// ytm_<videoId> 直通 YTM（videoId 即键）、lrclib_<条目id> 走 /api/get；
// netease_<曲目id> 走 /api/song/lyric、qq_<songmid> 走 fcg_query_lyric_new
// ——两源的 id/mid 即 refetch 键，无 token 面；kugou_ 的 accesskey 不落
// extId——两条取词道：进程内 LRU 里级联/手选刚产出的那份（正窗 6h 内可
// 命中），或 opts.token 携候选池透回的 accesskey 直达
// lyrics.kugou.com/download（手选绑定唯一取词通道——缺 token 只能等
// 缓存，出缓存即归 null）。
// 返回与级联同构的 {lrc, source, extId, synced, plain?}；id 非法/无词 →
// null，传输故障抛错（与级联同语义：故障走重试而不是固化成「无词」）。
async function fetchByExtId(extId, { signal, token } = {}) {
  const id = String(extId || '').trim();
  const m = EXT_LYRIC_ID_STRICT_RE.exec(id);
  if (!m) return null;
  const [, src, key] = m;
  // 进程内 LRU 先扫：下载相位几分钟前级联出的词，与手选候选池
  // cand_probe: 条目（netease/qq 探针探中、lrclib 检索内嵌词、ytm 已取
  // 词——POST /lyric/manual 选定免二次上游往返）都走这层免一跳；比对
  // 用 trim 后的 id——入参带空白时原串比对必漏
  for (const e of resultCache.values()) {
    if (e.res && e.res.extId === id && Date.now() - e.at <= POS_TTL_MS) {
      return e.res;
    }
  }
  if (src === 'ytm') return ytmFetchLyric(key, signal);
  if (src === 'lrclib') return lrclibGetById(key, signal);
  // netease_：曲目 id 直取 /api/song/lyric。neteaseLyricBody 归一
  // nolyric/uncollected/占位词→''（与 fetchLyricRaw/下载链同口径——
  // 「纯音乐请欣赏」类占位不许冒充词文进绑定）；空/缺 → null
  if (src === 'netease') {
    const res = await neteaseCall('lyric', { id: key }, signal);
    const lrc = neteaseLyricBody(res?.body).lrc;
    if (!lrc) return null;
    return { lrc, source: 'netease', extId: id, synced: parseLrcLines(lrc).length > 0 };
  }
  // qq_：songmid 直取 fcg_query_lyric_new（getLyric 内已 base64 解码 +
  // 占位词归空——官方译文 trans 不进结果面：外源词契约 {lrc} 无译文槽，
  // 与 ai.js「外源 tlyric 恒空」同口径）。业务码（-1901/-1301 无词等）是
  // 确定性无词——归 null 与空词同口径；传输层错误（无 bizCode）照旧上
  // 抛走重试语义
  if (src === 'qq') {
    const r = await qq.getLyric(key, signal).catch((e) => {
      if (e && e.bizCode !== undefined) return null;
      throw e;
    });
    const lrc = String(r?.lyric || '');
    if (!lrc) return null;
    return { lrc, source: 'qq', extId: id, synced: parseLrcLines(lrc).length > 0 };
  }
  // kugou_：候选池透回的 accesskey token 是 download 必填凭证；收敛
  // 字符集/长度再进查询串（虽经 encodeURIComponent，脏尾仍拒收）
  const ak = String(token || '').trim();
  if (!/^[\w-]{1,200}$/.test(ak)) return null;
  const lrc = await kugouDownloadLrc(key, ak, signal);
  if (!lrc) return null;
  return {
    lrc, source: 'kugou', extId: id,
    synced: parseLrcLines(lrc).length > 0,
  };
}

// ── 手选候选池（GET /lyric/candidates 供）──
// 级联是「系统判官」——错配时用户是终审：本函数把外源的宽检候选
// 原样端出（级联侧的 strictTitleHit 标题闸/artistHit 艺人面/±15s 时长
// 硬滤全部摘掉——那些是「错词比没词更糟」的自动收窄，人眼终审要看到
// 全池，含刻意可挑的异时长版）。仍剥的只有「没词可给」的条目
// （lrclib 的 instrumental/无双形态词文行、netease/qq 的无 id/mid 或
// 键形非法脏行、以及 lyric 探针确定无词的曲目——netease/qq 候选是
// 「曲目」不是词行，有没有词要逐条 lyric 端点探过才知道；摆进池也
// 只能给用户挑出一个 404，纯噪音）。无核验无 choose——judge 席位留
// 给用户。
// 出参 [{extId, source, title, artist, album?, durationSec?, synced,
// preview, token?}]：
//   preview  词稿首 1-2 行词文（剥行首时间戳与 [tag:] 元行，≤80 字）——
//            列表里人眼比对用；netease/qq 经 lyric 探针探中回填（词文
//            本就要探，预览是白捡的；探针故障漏网条仍 ''），kugou 候选
//            逐条 download 才见词、候选池不付那笔扇出 → 恒 ''
//   token    kugou accesskey——POST /lyric/manual 时须原样回传，是
//            download 唯一取词凭证（kugou_ extId 无 refetch 通道）；
//            netease_/qq_ 的 id/mid 即 refetch 键——无 token
//   synced   滚动词旗标三态（true 滚动/false 纯文本/null 未知）；
//            lrclib/ytm 检索面即真值；netease/qq 经 lyric 探针回填真值，
//            探针故障漏网条 null 如实「未知」——故障不是纯文本断言不谎
//            报；kugou 检索面无词型信息恒 false 占位（前端按源白名单显
//            「未知」，见 LyricPicker 的 SYNC_KNOWN_SOURCES）
// 检索词展开接通级联同款漏斗：否则 yt_ 翻唱曲恒空——'楽園 ver.EMA EMA'
// 实测 0 条而剥缀形态 '楽園' 20 条。标题变体 × 艺人降轮按序逐发（见
// candQueryForms/runCandForms 头注），命中条目烙 _form=形态序号进排序键。
// 排序：形态序 _form（0=最严形态命中——降轮命中是不同曲的可能性高，
// 特异性先于时长差决胜）→ |候选时长-durationSec| 升序（无差值殿后——
// 刻意不做 ±15s 硬滤，截取版/异时长版用户有权明挑）→ 源序
// lrclib→kugou→netease→qq→ytm，截 12 条。每源独立 15s 伞时限（内部单跳
// 仍 10s——qq.searchSongs 内层 15s 由伞收口），形态中途失败与整源故障
// 都降级部分池（warn 续走）——一源死拖不翻整池（「池子缺一角」比
// 「整池 502」强）。
const CAND_SRC_ORDER = { lrclib: 0, kugou: 1, netease: 2, qq: 3, ytm: 4 };
const CAND_CAP = 12;
// 扇出节流双闸（机制见 runCandForms 头注）：召回地板——池收满此数后
// 最多再宽采 1 个形态即停；形态硬顶——单源形态查询数硬上限
const CAND_POOL_FLOOR = 4;
const CAND_MAX_FORMS = 6;
// lyric 探测预算收顶（netease/qq 在 runCandForms 产池与 probeCandLyrics
// 之间的 candProbeTop 用）：检索窗放宽到 30/形态后只探出榜序最优的前
// N 条——池尾注定不出榜的不付探测费，防放宽的检索窗把 lyric 端点压力
// 翻倍
const CAND_PROBE_CAP = 15;
// 探针并发分片宽：miss 队列按 5/批顺序执行（批内 Promise.all）——15 发
// 瞬时并行与 runCandForms 的串行节流取向矛盾（批并发=上游 lyric 端点的
// 瞬时突刺宽度，纯串行又把探针面拖长），分片折中
const CAND_PROBE_BATCH = 5;
const CAND_SRC_TIMEOUT_MS = 15000;
const CAND_PREVIEW_CHARS = 80;
const CAND_PREVIEW_LINES = 2;

// 词稿预览：剥行首时间戳与 [tag:] 元行（plainTextLines 与 verifyHit
// 同口径）取首 N 行词文——元行不冒充词文行占位
const candPreview = (text) => plainTextLines(text)
  .slice(0, CAND_PREVIEW_LINES).map((l) => l.text)
  .join(' / ').slice(0, CAND_PREVIEW_CHARS);

const candDiff = (dur, durationSec) => (
  dur != null && Number.isFinite(durationSec) && durationSec > 0
    ? Math.abs(dur - durationSec) : null
);

// 检索形态展开（与级联同构的漏斗）：标题变体 × 艺人降轮笛卡尔展开、按整
// 串查询词 normKey 去重——'楽園 EMA' 这类变体与具名轮撞出的同形查询不重
// 复打。形态序=特异性序（0 最严），命中的候选烙 _form=形态序号。variants
// 与级联同参（占位作者不作变体锚）；artistRounds：UGC 曲（yt_/bv_）
// [artist, artistFromTitle, ''] normName 去重——级联同构，UGC artist 是
// UP 主/翻唱者而非原曲艺人，具名轮之外剥题艺人候选与裸标题轮才是召回
// 来源；非 UGC [artist, '']——手动池无 AI 闸、用户即判官，裸标题轮是修
// 错配的正当召回面（不走级联的 aiEnabled 闸）。
// 展开序按 ugc 分家：
//  · UGC 变体外圈 × 艺人轮内圈——翻唱曲的修复目标形态是「剥缀变体+裸轮」，
//    变体外圈让它（形态序号=变体序×3+2）在 15s 伞内更早触达；轮外圈会把
//    它推到末段（伞超时面更先被截断）
//  · 非 UGC 轮外圈 × 变体内圈——与级联 runRound 同序：具名变体全部先于裸
//    轮打。变体外圈下裸标题轮（_form=轮数-1）会排在「剥缀变体+真艺人」
//    （_form≥轮数）之前——无艺人证据的同题命中压过标题弱化+真艺人命中是
//    特异性倒挂，且池满 CAND_CAP 早停会把更准的具名变体形态挤出伞外
function candQueryForms({ songId, title, artist }) {
  const sid = String(songId || '');
  const ugc = YT_TRACK_ID_RE.test(sid) || BV_TRACK_ID_RE.test(sid);
  const variants = titleVariantsOf(title, isPlaceholderAuthor(artist) ? '' : artist);
  const artistRounds = [String(artist || '')];
  const seenArtist = new Set(artistRounds.map(normName));
  for (const a of (ugc ? [artistFromTitle(title), ''] : [''])) {
    const k = normName(a);
    if (!seenArtist.has(k)) { seenArtist.add(k); artistRounds.push(a); }
  }
  const forms = [];
  const seenQ = new Set();
  const push = (v, ra) => {
    const q = [v, String(ra || '').trim()].filter(Boolean).join(' ');
    if (!q) return;
    const k = normKey(q);
    if (seenQ.has(k)) return;
    seenQ.add(k);
    forms.push(q);
  };
  if (ugc) {
    for (const v of variants) for (const ra of artistRounds) push(v, ra);
  } else {
    for (const ra of artistRounds) for (const v of variants) push(v, ra);
  }
  return forms;
}

// 形态展开执行体（lrclib/kugou/netease/qq 共用）：forms 按序逐发（尊重
// 上游不并发扇出），extId 首现者胜（形态序=特异性序，先入者更可信）、
// 烙 _form=命中形态序号，池满 ≥CAND_CAP 早停——本层只做早停不做截断
// （单形态可超收，CAND_CAP 截断在跨源合并层 searchLyricCandidates 尾部）。
// 扇出节流：「地板+1 宽采 + 6 形态硬顶」——形态扇出把单端点查询数 ×变体
// 数放大（每源最多 12 发串行），用户连点几首歌就能把部署 IP 刷进上游限流
// （实机病例：「楽園 ver.EMA」首形态即吃 lrclib 429 → 整源归空池）。双闸：
//   · 召回地板早停——某形态使 pool ≥ CAND_POOL_FLOOR(4) 后记其序号 N，至
//     多执行到 N+1 形态（含）即停：给次优形态一次补位机会（防首个非空形
//     态只有 1-2 条同题异曲）；未达地板照常走到头/硬顶
//   · 形态硬顶 CAND_MAX_FORMS(6)——UGC 变体外圈序下前 6 形态覆盖 v0 全
//     轮 + v1 全轮（剥缀+裸轮在内）；更多形态的收益边际递减而限流成本陡增
// 形态级失败与「源失败降级部分池」同口径：已收条目在池即中断余下形态、
// 端出已拿到的部分（warn 留痕，含伞自裁面——调用方真断连由路由 499 兜底）；
// 中途 429 即此熔断面（非重试——上游 Retry-After/5xx 单点重试消化在
// lrclibSearchList 内部，本层不动）；首形态即炸自然空池，上抛归外层
// 「源失败 warn+[]」旧语义（调用方 abort 亦经外层 signal 判定穿透）
async function runCandForms(forms, source, query) {
  const pool = [];
  const seenIds = new Set();
  // 可执行形态上界：形态数与硬顶取小；召回地板再把它压到「首个使池
  // ≥CAND_POOL_FLOOR 的形态序号 +1」——地板后只再宽采 1 个形态即停
  let lastIdx = Math.min(forms.length, CAND_MAX_FORMS) - 1;
  for (let f = 0; f <= lastIdx; f++) {
    if (pool.length >= CAND_CAP) break;
    let batch;
    try {
      batch = await query(forms[f]);
    } catch (e) {
      if (!pool.length) throw e;
      console.warn(`[lyric-ext] 候选池 ${source} 形态「${forms[f]}」检索失败，`
        + `保留已收 ${pool.length} 条：${e?.message || e}`);
      break;
    }
    for (const cand of batch) {
      if (seenIds.has(cand.extId)) continue;
      seenIds.add(cand.extId);
      cand._form = f;
      pool.push(cand);
    }
    if (pool.length >= CAND_POOL_FLOOR) lastIdx = Math.min(lastIdx, f + 1);
  }
  return pool;
}

async function lrclibCandidates({ songId, title, artist, durationSec, signal }) {
  return runCandForms(candQueryForms({ songId, title, artist }), 'lrclib',
    async (q) => {
      const list = await lrclibSearchList(q, signal);
      return (Array.isArray(list) ? list : [])
        .filter((it) => it && typeof it === 'object' && it.id != null)
        .filter((it) => it.instrumental !== true)
        .filter((it) => (typeof it.syncedLyrics === 'string' && it.syncedLyrics.trim())
          || (typeof it.plainLyrics === 'string' && it.plainLyrics.trim()))
        .map((it) => {
          const syncedText = String(it.syncedLyrics || '').trim();
          const plainText = String(it.plainLyrics || '').trim();
          const extId = `lrclib_${it.id}`;
          // 检索回包内嵌词文——顺带落 cand_probe: 正缓存（与 netease/qq
          // 探针同键位、与 lrclibGetById 同形状）：用户点选这条时
          // fetchByExtId 的 LRU 扫描直接命中，免 /api/get 二次上游往返
          cacheWrite(`cand_probe:${extId}`, {
            lrc: syncedText || plainText,
            plain: syncedText && plainText ? plainText : undefined,
            source: 'lrclib', extId, synced: Boolean(syncedText),
          });
          // null/''/非数都归「无时长信息」——+x 强转会把 null 吃成 0 假时长
          const durNum = Number(it.duration);
          const dur = Number.isFinite(durNum) && durNum > 0 ? durNum : null;
          return {
            extId, source: 'lrclib',
            title: String(it.trackName || ''), artist: String(it.artistName || ''),
            album: it.albumName || undefined,
            durationSec: dur ?? undefined,
            synced: Boolean(syncedText),
            preview: candPreview(syncedText || it.plainLyrics),
            _diff: candDiff(dur, durationSec),
          };
        });
    });
}

async function kugouCandidates({ songId, title, artist, durationSec, signal }) {
  // 刻意不透 durationSec 给上游：级联侧的 ±15s 时长滤在候选池面全摘
  // （用户可能明挑异时长版——kugou 的 duration= 参是服务端收窄，透出去
  // 等于把「宽检池」又关回窗内）；时长只进本地 _diff 排序键
  return runCandForms(candQueryForms({ songId, title, artist }), 'kugou',
    async (kw) => {
      const sbody = await kugouSearchList(kw, 0, signal);
      return (Array.isArray(sbody?.candidates) ? sbody.candidates : [])
        .filter((cd) => cd && cd.id != null && cd.accesskey)
        .map((cd) => {
          // 毫秒→秒；null/''/非数归「无时长信息」（+x 强转会吃 null 成 0）
          const durNum = Number(cd.duration);
          const dur = Number.isFinite(durNum) && durNum > 0 ? durNum / 1000 : null;
          return {
            extId: `kugou_${cd.id}`, source: 'kugou',
            title: String(kugouCandTitle(cd) || ''), artist: String(cd.singer || ''),
            album: cd.album || cd.albumname || undefined,
            durationSec: dur ?? undefined,
            synced: false,
            preview: '',
            // accesskey 原样透回——POST /lyric/manual 的取词凭证（见头注）
            token: String(cd.accesskey),
            _diff: candDiff(dur, durationSec),
          };
        });
    });
}

// callNeteaseApi 对上游非 200 拒的是 answer{status,body,cookie} 对象而非
// Error（上游兼容契约，见 netease/request.js——含 abort/超时也归一成
// 502 answer）——候选池「源失败/形态熔断」与反查故障日志都吃
// e?.message，裸 answer 会落 '[object Object]' 不可回放；归一成 Error
// 再上抛，失败语义不变。单跳时限收 SRC_REQ_TIMEOUT_MS（与其它源同口径；
// 外层 15s 伞仍在）
const neteaseCall = (api, params, signal) =>
  callNeteaseApi(api, params, { signal, timeoutMs: SRC_REQ_TIMEOUT_MS })
    .catch((e) => {
      if (e instanceof Error) throw e;
      throw new Error(`netease ${api} status=${e?.status ?? e?.body?.code ?? '?'}`);
    });

// netease/qq 候选是「曲目」不是词行——检索面只回元数据，该曲有没有词
// 要逐条 lyric 端点探过才知道（实案：qq_002yaHfo2tvaS5「楽園-EMA」
// 搜索命中、点选后 getLyric 回 bizCode=-1901 该曲无词 → POST
// /lyric/manual 404「词源取词失败」死选）。runCandForms 出池后经
// cand_probe: 缓存读穿 + CAND_PROBE_BATCH 分片探测（复用源伞 signal——
// 探针扇出受同一把伞收口，与检索形态同伞不超源时限预算）：
//   · 确定无词 → 滤出池 + cacheWrite(ck,null) 负窗固化——netease
//     nolyric/uncollected/占位词归空与 fetchByExtId 同口径；qq 只认
//     空 lyric 或 bizCode===-1901 实测无词码（getLyric 对任意
//     code!==0 都打 err.bizCode——风控/权限/未知码不是「确定无词」，
//     白名单化防 15 并发面下整源静默蒸发）。与「没词可给不摆池」
//     头注同口径
//   · 传输/探测异常 → 保留候选——探针故障≠无词，不惩罚条目：synced
//     置 null 出「未知」+ 空 preview（故障不是纯文本断言，不谎报
//     词型），且不写缓存——故障不固化，下次开窗给重探新机会；点选时
//     fetchByExtId 直取照旧兜底
//   · 探中 → 回填 preview=candPreview(lrc)（词文本就探过，预览是白捡
//     的）与 synced=parseLrcLines 真值；并 cacheWrite('cand_probe:'+
//     extId)——fetchByExtId 的 LRU 扫描按 e.res.extId 命中它（正窗 6h
//     内），用户点选 POST /lyric/manual 时免二次上游往返
//   · cand_probe: 读穿——正命中（res 非空）免上游直接回填收下；负命中
//     （res:null 在 NEG_TTL 窗内）=确定无词直接滤出不重探。同 extId
//     二次开窗零 lyric 上行（lrclib/ytm 的内嵌/已取词也写同键位正
//     缓存，见 lrclibCandidates/ytmCandidate）
// 探测预算按出榜序收顶——池尾注定不出榜的不付探测费：检索窗放宽到
// 30/形态后池内深榜条目跨源合并也进不了 12 顶，按与源内出榜同序的
// _form→_diff（形态特异性先决——晚形态近时长条不该挤掉早形态榜头
// 条的探测位；null/无值殿后；sort 稳定、同键保上游序）取前
// CAND_PROBE_CAP 条进探针，余者直接弃
const candProbeTop = (pool) => pool.slice()
  .sort((a, b) => (a._form ?? 9e9) - (b._form ?? 9e9)
    || (a._diff ?? 9e9) - (b._diff ?? 9e9))
  .slice(0, CAND_PROBE_CAP);

// 探针量上界=喂入条目数——调用侧先经 candProbeTop 按出榜序收顶
// （CAND_PROBE_CAP，放宽检索窗的探测费闸）；全部空词时该源如实出空池。
// probe(key) 归一词文：''=确定无词；抛错按 bizCode 白名单分家——
// bizCode===-1901=确定无词滤出+负窗固化，其余一切（他码 bizCode/
// 传输错/伞 abort）=传输故障保留（不写缓存、synced:null 出「未知」）。
// 执行面：先逐条 cand_probe: cacheRead 读穿（正命中回填收下/负窗滤出/
// miss 归队列），miss 队列按 CAND_PROBE_BATCH 分片顺序探测（批内
// Promise.all——瞬时并发面压到 5 而非 15 齐发）；out 槽保收顶序即
// 出池序（合并层仍按 _form→_diff 重排，此序只兜同键稳定位）
async function probeCandLyrics(pool, probe) {
  const out = new Array(pool.length);
  const queue = [];
  for (const [i, cand] of pool.entries()) {
    const key = EXT_LYRIC_ID_STRICT_RE.exec(cand.extId)?.[2];
    // 键形预滤层已兜住脏条（netease/qq 各自 re），此判是双保险——
    // 键形对不上的 extId 连探针都不配吃
    if (!key) continue;
    const ck = `cand_probe:${cand.extId}`;
    const hit = cacheRead(ck);
    if (hit.hit) {
      // 负命中（res:null 在 NEG_TTL 窗内）=确定无词——直接滤出不重探
      if (!hit.res) continue;
      // 正命中免上游回填收下；缓存条回填面异常落回探测队列重探——
      // 脏缓存不坑条目
      try {
        cand.preview = candPreview(hit.res.lrc);
        cand.synced = hit.res.synced;
        out[i] = cand;
        continue;
      } catch { /* 落回探测队列 */ }
    }
    queue.push({ i, cand, key, ck });
  }
  for (let b = 0; b < queue.length; b += CAND_PROBE_BATCH) {
    await Promise.all(queue.slice(b, b + CAND_PROBE_BATCH).map(async (s) => {
      // 词文后处理与缓存写全收进 try——parseLrcLines/candPreview/
      // cacheWrite 的同步抛与异步拒包同归「故障保留」，不再灭整源
      // （旧面在 try 外，一条畸形词文让 Promise.all 整池判死）
      try {
        const lrc = await probe(s.key);
        if (!lrc) {
          cacheWrite(s.ck, null);        // 确定无词——走现成负窗 TTL 固化
          return;
        }
        const synced = parseLrcLines(lrc).length > 0;
        s.cand.preview = candPreview(lrc);
        s.cand.synced = synced;
        cacheWrite(s.ck, {
          lrc, source: s.cand.source, extId: s.cand.extId, synced,
        });
        out[s.i] = s.cand;
      } catch (e) {
        // bizCode===-1901 是 QQ 实测「该曲无词」码——确定无词滤出+负窗
        // 固化；其余 bizCode（风控/权限/未知码）、传输错、伞 abort 全归
        // 传输故障——保留条目不写缓存（故障不固化）
        if (e?.bizCode === -1901) {
          try { cacheWrite(s.ck, null); } catch { /* 负窗写入尽力而为 */ }
          return;
        }
        s.cand.synced = null;            // 漏网条如实「未知」——非纯文本占位
        out[s.i] = s.cand;
      }
    }));
  }
  return out.filter(Boolean);
}

// 候选池曲库源·网易云：cloudsearch(type=1) 单曲检索——检索窗放宽到
// limit=30/形态收深榜（实案：裸「楽園」检索春野真身居第 23 名、窗 15
// 直接截掉；池满 12 截断在跨源排序后，上游窗口只是候选料）。实机钉
// 字段名——songs[{id,name,ar[{name}],al{name},dt(ms)}]，双名口径取
// （ar||artists、al||album、dt||duration——netease-match 同款，防上游
// 新旧命名漂移）；多艺人 join '/'。检索面不回词文——词文/词型交
// lyric 探针回填（probeCandLyrics：确定无词滤出、探中 preview/synced
// 真值 + 落 cand_probe: LRU、传输故障漏网条 synced:null 如实「未知」
// 不写缓存），探测预算按出榜序收顶 CAND_PROBE_CAP(15)——池尾注定不出
// 榜的不付探测费（candProbeTop 头注）；id 即 extId 可 refetch——无 token
async function neteaseCandidates({ songId, title, artist, durationSec, signal }) {
  const pool = await runCandForms(candQueryForms({ songId, title, artist }), 'netease',
    async (kw) => {
      const res = await neteaseCall('cloudsearch', { keywords: kw, type: 1, limit: 30 }, signal);
      const songs = res?.body?.result?.songs;
      return (Array.isArray(songs) ? songs : [])
        // 键形预滤：非纯数字 id 产的 netease_ extId 过不了 fetchByExtId
        // 严格形也配不上 lyric 接口形参——注定 404 的脏条不摆进池
        .filter((s) => s && typeof s === 'object' && NETEASE_ID_RE.test(String(s.id ?? '')))
        .map((s) => {
          // 毫秒→秒；null/''/非数归「无时长信息」（+x 强转会吃 null 成 0）
          const durNum = Number(s.dt || s.duration);
          const dur = Number.isFinite(durNum) && durNum > 0 ? durNum / 1000 : null;
          const ars = Array.isArray(s.ar || s.artists) ? (s.ar || s.artists) : [];
          return {
            extId: `netease_${s.id}`, source: 'netease',
            title: String(s.name || ''),
            artist: ars.map((a) => a?.name).filter(Boolean).join('/'),
            album: (s.al || s.album)?.name || undefined,
            durationSec: dur ?? undefined,
            // 词型占位 null=「未知」——探针探中回填真值、故障漏网条保持
            // null 如实出「未知」（故障保留不谎报纯文本）
            synced: null,
            preview: '',
            _diff: candDiff(dur, durationSec),
          };
        });
    });
  // 出池前 lyric 可用性探针——候选是曲目不是词行（probeCandLyrics 头注）；
  // 探测预算按出榜序收顶 15——池尾注定不出榜的不付探测费
  return probeCandLyrics(candProbeTop(pool), async (key) => {
    const res = await neteaseCall('lyric', { id: key }, signal);
    return neteaseLyricBody(res?.body).lrc;
  });
}

// 候选池曲库源·QQ：searchSongs 三层兜底收口在 lib/qq 内（soso→shc→
// musicu），检索窗放宽到 limit=30/形态收深榜（与 netease 同口径——
// 池满 12 截断在跨源排序后，上游窗口只是候选料），探测预算按出榜序
// 收顶 CAND_PROBE_CAP(15)——池尾注定不出榜的不付探测费
// （candProbeTop 头注）；list 条目已 normalizeTrack 归一成
// {mid,name,artists[],album,intervalSec}；多艺人 join '/'。mid 即
// extId 可 refetch——无 token；检索面不回词文——词文/词型交 lyric
// 探针回填（getLyric 支：bizCode===-1901 白名单=确定无词滤出+负窗
// 固化、他码/传输错保留不写缓存（synced:null 出「未知」）、探中回填
// 真值+落 LRU，见 probeCandLyrics 头注）。无 mid/形非法脏行剥除
// （normalizeTrack 滤无 mid，键形 SONGMID_RE 由本层兜）
async function qqCandidates({ songId, title, artist, durationSec, signal }) {
  const pool = await runCandForms(candQueryForms({ songId, title, artist }), 'qq',
    async (kw) => {
      const { list } = await qq.searchSongs(kw, { limit: 30 }, signal);
      return (Array.isArray(list) ? list : [])
        // 键形预滤：SONGMID_RE 过不了的脏 mid 产的 qq_ extId 同样过不了
        // fetchByExtId/QQ_SONG_ID_RE 严格形——注定取不到词的条不摆进池
        .filter((s) => s && typeof s === 'object' && SONGMID_RE.test(String(s.mid ?? '')))
        .map((s) => {
          // intervalSec 已是秒；null/''/非数归「无时长信息」
          const durNum = Number(s.intervalSec);
          const dur = Number.isFinite(durNum) && durNum > 0 ? durNum : null;
          return {
            extId: `qq_${s.mid}`, source: 'qq',
            title: String(s.name || ''),
            artist: (Array.isArray(s.artists) ? s.artists : [])
              .filter(Boolean).join('/'),
            album: s.album || undefined,
            durationSec: dur ?? undefined,
            // 词型占位 null=「未知」——同 netease 支口径（探针回填真值、
            // 故障漏网条不谎报纯文本）
            synced: null,
            preview: '',
            _diff: candDiff(dur, durationSec),
          };
        });
    });
  // 出池前 lyric 可用性探针——候选是曲目不是词行（probeCandLyrics 头注）；
  // 探测预算按出榜序收顶 15——池尾注定不出榜的不付探测费
  return probeCandLyrics(candProbeTop(pool), async (key) => {
    const r = await qq.getLyric(key, signal);
    return String(r?.lyric || '');
  });
}

// ytm 支路限 yt_ 曲（videoId 直达）：候选存在的前提是词真拿得到——
// 拿不到词/支路故障静默略（候选池不因一支路哑火翻面，也摆不出一个
// 注定 404 的条目）；拿得到顺带产 preview。title/artist 回填检索词
// ——timedLyricsData 无候选条目元数据，展示面用来源身份兜底
async function ytmCandidate({ songId, title, artist, signal }) {
  const vid = String(songId || '').match(YT_TRACK_ID_RE)?.[1];
  if (!vid) return [];
  const hit = await ytmFetchLyric(vid, signal);
  if (!hit) return [];
  // 词已取过（next+browse 两跳）——落 cand_probe: 正缓存（与探针同键位）：
  // 用户点选时 fetchByExtId 的 LRU 扫描命中它，免重走 YTM 两跳
  cacheWrite(`cand_probe:${hit.extId}`, hit);
  return [{
    extId: `ytm_${vid}`, source: 'ytm',
    title: String(title || ''), artist: String(artist || ''),
    synced: Boolean(hit.synced),
    preview: candPreview(hit.lrc),
    _diff: null,
  }];
}

async function searchLyricCandidates({ songId, title, artist, durationSec, signal }) {
  if (signal?.aborted) throw abortErr();
  const jobs = [
    ['lrclib', lrclibCandidates({
      songId, title, artist, durationSec, signal: timedSignal(signal, CAND_SRC_TIMEOUT_MS),
    })],
    ['kugou', kugouCandidates({
      songId, title, artist, durationSec, signal: timedSignal(signal, CAND_SRC_TIMEOUT_MS),
    })],
    // 两个曲库源恒在——LRCLIB/酷狗对翻唱曲的召回黑洞正是它们的补位面
    // （实案「楽園 ver.EMA」：LRCLIB 无条目、酷狗抽风返 0、网易云曲库
    // 有真身）。各走自己的 runCandForms——同 6 形态顶/地板+1 闸不扩
    // 上游预算
    ['netease', neteaseCandidates({
      songId, title, artist, durationSec, signal: timedSignal(signal, CAND_SRC_TIMEOUT_MS),
    })],
    ['qq', qqCandidates({
      songId, title, artist, durationSec, signal: timedSignal(signal, CAND_SRC_TIMEOUT_MS),
    })],
  ];
  if (YT_TRACK_ID_RE.test(String(songId || ''))) {
    jobs.push(['ytm', ytmCandidate({
      songId, title, artist, signal: timedSignal(signal, CAND_SRC_TIMEOUT_MS),
    })]);
  }
  const pools = await Promise.all(jobs.map(async ([name, p]) => {
    try {
      return await p;
    } catch (e) {
      // 穿透判定只凭调用方信号——不看 e.aborted：源内部走的是伞信号
      // （timedSignal 合成），伞时限自裁或源内 Retry-After 睡眠被伞掐醒
      // 都产带 .aborted 的 abortErr；误穿透会让路由对仍连接的客户端回
      // 499。调用方断连才穿透（整池响应已无人接收）；源自身故障/伞超时
      // 都只灭自己一角——warn 留痕可回放
      if (signal?.aborted) throw abortErr();
      console.warn(`[lyric-ext] 候选池 ${name} 源失败：${e?.message || e}`);
      return [];
    }
  }));
  const all = pools.flat();
  // 形态序 _form 先决（0=最严形态——降轮命中是不同曲的可能性高，时长差
  // 贴近不翻案特异性）→ 时长差升序（null 殿后）→ 源序；同键内保上游
  // 原序（sort 稳定）。ytm 支路无 _form（videoId 直达无查询形态）殿后——
  // 哨兵须大过真实 _form 上限（硬顶 CAND_MAX_FORMS 内 _form ≤5；旧哨兵
  // 9 曾在 12 形态时代让 UGC 尾形态命中与 ytm 串桶混排、甚至排到其后，
  // 哨兵余量即防此类回潮）
  all.sort((a, b) => (a._form ?? 9e9) - (b._form ?? 9e9)
    || (a._diff ?? 9e9) - (b._diff ?? 9e9)
    || (CAND_SRC_ORDER[a.source] ?? 9) - (CAND_SRC_ORDER[b.source] ?? 9));
  // _form/_diff 是内部排序键——不透出 API 面
  return all.slice(0, CAND_CAP).map(({ _diff, _form, ...cand }) => cand);
}

// 入口：单飞 + LRU。{ songId, title, artist, durationSec, videoId, signal,
// deadlineMs }——songId 为 yt_<videoId> 时 YTM 支路自动抽 videoId；
// title/artist 是 LRCLIB/酷狗的检索词与核验签名料；deadlineMs 覆写级联
// 软时限（测试注入点，缺省 CASCADE_DEADLINE_MS=45s）。
async function fetchExternalLyric(args) {
  const key = cacheKeyOf(args);
  const hit = cacheRead(key);
  if (hit.hit) return hit.res;
  const gate = inflight.get(key);
  // 共享 gate 由首个调用方的 signal 驱动——它 abort 时搭车者吃到同一个
  // aborted 拒绝。搭车者自身仍存活时不陪绑：自行重走入口（先吃缓存/新
  // gate，级联不重复打穿上游）；自身已 abort 或非 abort 失败原样上抛
  if (gate) {
    return gate.catch(e => (
      e?.aborted && !args.signal?.aborted
        ? fetchExternalLyric(args)
        : Promise.reject(e)
    ));
  }
  const p = cascade(args)
    .then(({ hit, truncated, dirty }) => {
      // 截断 null 不落负缓存——「没跑完」≠「无词」，固化会把上游慢写成
      // 10min 假阴性。混合故障 null（dirty：一源炸 + 余源干净 miss）写
      // DIRTY_NEG_TTL_MS 短负窗——持久故障源若每请求全级联重跑会吃满
      // 级联上限，短窗挡住连击又让上游恢复后自然重查；truncated/dirty
      // 与 hit 不并存（命中在级联内即早返）；搭车者共享本 promise 同待遇
      if (!truncated) cacheWrite(key, hit, dirty ? DIRTY_NEG_TTL_MS : undefined);
      return hit;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

module.exports = {
  fetchExternalLyric,
  fetchByExtId,
  // 手选候选池（GET /lyric/candidates）——宽检无闸的用户终审面
  searchLyricCandidates,
  // 源内函数导出供测试探针/调试——正常消费只走 fetchExternalLyric
  ytmFetchLyric, lrclibFetch, kugouFetch, lrclibGetById, titleVariantsOf, strictTitleHit,
  artistHit, normName, DIRTY_NEG_TTL_MS,
  // 测试钩子：清空进程内缓存 / 探最新缓存条目（key 计算是内部细节——
  // 测试只需要「刚才那次级联落了什么」，取队尾即可；不改生产语义）
  _clearCache: () => { resultCache.clear(); inflight.clear(); },
  _cachePeek: () => {
    const e = [...resultCache.values()].at(-1);
    return e ? { res: e.res, at: e.at, ttl: e.ttl ?? null } : null;
  },
};

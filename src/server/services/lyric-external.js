// 外部滚动歌词源链——网易云词源缺席/未匹配时的兜底：
//   yt_ 曲先走 YouTube Music（videoId 直达、LyricFind 供词），
//   再 LRCLIB（开放歌词库，本端自筛时长/艺人/纯音乐标记），
//   最后酷狗 lyrics.kugou.com（华语/粤语补位，fmt=lrc 直给行级 LRC）。
// 三路全灭回 null——调用方按「无词」处理（路由 404、下载链 NO_LYRICS）。
// UGC 曲（yt_/bv_）在「有时长闸可摘 + 存在干净 miss 面」时追加「免时长
// 末轮」：durationSec=0 + strictTitle 恒 true 的单次 artist='' 开放轮
// 重扫两检索源，救「截取版/片头尾超长」型失效——同名歧义由标题精确闸 +
// 末轮整池单发消歧兜：fetch 层多候选时走 choose 通道，排序后前 8 条身份
// 交判官一发选择题「来源最可能翻唱哪条」——逐候选布尔盲审对同题异曲
// 不够决断（实证：KKB 英文版被判 ok 收录），整池相对判定才分得清；
// choose 未选中/故障落回逐候选归属核验（带同题池语境：条目身份进判定
// prompt，vkey 换 v3 盐与无池盲审互不命中）。末轮不按 artist 轮次重扫——
// 免时长后标题是唯一硬证据，UGC artist 是翻唱者/UP 主而非原曲艺人，具名
// 约束只收窄（'Flamingo／rei shirose' 的 'R' 轮曾把真身 米津玄師 滤死、
// 放行子串撞名的 Earl Bostic）。
// 常规轮全死于传输故障（有 lastErr 且无干净 miss）不展开——同源重试必死
// 白打，末轮恰回干净空表还会污染 cleanMiss 溃掉尾部抛错语义；durationSec
// 缺省/0 时末轮与 '' 宽检轮逐字节同参，纯重复扇出，同样不展开。
// 单一源全灭在传输层（没有一个「干净无词」终态）时抛错——这是故障不是
// 缺词，让调用方走重试语义，且不写负缓存。
//
// 结果面 { lrc, source:'ytm'|'lrclib'|'kugou', extId, synced, plain?, meta? }：
//   lrc    最佳文本——synced=true 是标准 LRC；false 时是纯文本（无时间戳
//          行，落盘仍是可读词稿，播放端解析不出滚动行而已）
//   extId  源内稳定 id（ytm_<videoId>/lrclib_<条目id>/kugou_<行id>）——
//          归属核验 vkey 与 AI 译文缓存键都挂它，与网易云/QQ id 空间隔离，
//          形态见 shared/predicates.js EXT_LYRIC_ID_RE
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
// lyric-verify 同口径）。
const { ytDispatcher } = require('../lib/yt-proxy');
const { lyricDispatcher } = require('../lib/lyric-proxy');
const { YT_TRACK_ID_RE, BV_TRACK_ID_RE, EXT_LYRIC_ID_STRICT_RE } = require('../../shared/predicates.js');
// 标题变体/剥艺人/检索词清理的唯一真相源上提到 shared——网易云匹配漏斗
// （netease-match.js candidates 展开）与这里的外源级联共用同一份规则集
const {
  titleVariantsOf, artistFromTitle, cleanQueryTitle, normKey, isPlaceholderAuthor,
} = require('../../shared/title-variants.js');
const { normToken } = require('./netease-score');
const { parseLrcLines, judgeLyricLines, lyricVerdictKey, judgePoolPick } = require('./lyric-verify');

const EXT_TIMEOUT_MS = 12000;
// 级联软时限默认值——fetchExternalLyric 经 args.deadlineMs 可覆写（测试
// 注入点；同键并发搭车共享的是首个调用方那次级联的时限）
const CASCADE_DEADLINE_MS = 45_000;
const abortErr = () => Object.assign(new Error('已取消'), { aborted: true });
const timedSignal = (extraSignal, ms = EXT_TIMEOUT_MS) => extraSignal
  ? AbortSignal.any([AbortSignal.timeout(ms), extraSignal])
  : AbortSignal.timeout(ms);

// ── 进程内结果缓存（LRU + 负结果短窗）──
const CACHE_CAP = 500;
const POS_TTL_MS = 6 * 60 * 60 * 1000;
const NEG_TTL_MS = 10 * 60 * 1000;
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
  if (Date.now() - e.at > (e.res ? POS_TTL_MS : NEG_TTL_MS)) {
    resultCache.delete(key);
    return { hit: false };
  }
  // LRU touch：Map 键序即插入序，delete+set 把命中挪到队尾
  resultCache.delete(key);
  resultCache.set(key, e);
  return { hit: true, res: e.res };
}

function cacheWrite(key, res) {
  // 满容挤最旧（队首）——FIFO 挤出与路由层会话缓存同口径
  if (resultCache.size >= CACHE_CAP && !resultCache.has(key)) {
    resultCache.delete(resultCache.keys().next().value);
  }
  resultCache.set(key, { res, at: Date.now() });
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

// 艺人相似判定：归一（小写 + 剥空白/连接标点）后互相包含即算——
// '周杰伦' vs '周杰伦/林俊杰'、'A B'（本站多艺人空格拼接）vs 'A' 都认；
// 给了艺人且全不相似时不选——错词比没词更糟
const normName = (s) => String(s || '').toLowerCase()
  .replace(/[\s\-_·•、,，。&+＋/\\'’"（）()\[\]【】]+/g, '');
const artistHit = (want, got) => {
  const w = normName(want);
  const g = normName(got);
  if (!w) return true;      // 调用方没给艺人——不卡
  return Boolean(g) && (g.includes(w) || w.includes(g));
};

// 宽检轮标题身份闸：artist 空检时 artistHit 全放行，/api/search 自由文本
// 命中的「子串撞名」候选会照收（实证病例：查询 'Twig' 撞上英文同名异曲
// 'Pinocchio Twig / Koosje'，时长还巧合贴近）。闸=候选标题剥缀面
// （titleVariantsOf 单份规则集：尾括弧/feat./ver./cover/'A - B' 头等）
// 归一后与检索变体精确相等才放行——'Twig (feat. Miku)'→'twig' 收、
// 'twig' vs 'pinocchiotwig' 拒、'ロストアンブレラ' 精确收。
// 刻意取舍：跨文字形态（罗马音 vs 日文原名）不互认——漏判由绑后外源
// 兜底与自动首配愈合，错词比没词更伤。具名 artist 轮不上此闸（artistHit
// 交叉约束在位，保模糊召回）
const strictTitleHit = (candTitle, queryTitle) => {
  const want = normToken(cleanQueryTitle(queryTitle));
  if (!want) return true;            // 检索词归一后为空——无可比对不卡
  return titleVariantsOf(candTitle, '')
    .some((v) => normToken(v) === want);
};

// 逐候选核验容错包装：verify 判否 → 该候选出局；核验通道故障 → 放行候选
// （与级联外层「核验故障不拦」同口径——AI 是增强不是门禁）；abort 穿透。
// vkey 挂各候选 extId——同一检索里多条判否行互不串。
// extra（可选）= 检索侧随候选透出的判定语境 {pool}——同题候选池身份，
// 缺席时 verify 按无池盲审（反查/直调等无检索池场景）
const candidatePass = async (verify, hit, signal, extra) => {
  try {
    return await verify(hit, extra) !== false;
  } catch (e) {
    if (e?.aborted || signal?.aborted) throw abortErr();
    return true;
  }
};

// 已过逐候选核验的烙记：不可枚举——路由层 ...res 摊出与 JSON.stringify
// 都不带它，内部标记不泄进 API 面；级联凭它跳过外层二次核验
const markVerified = (hit) => Object.defineProperty(hit, 'verified', { value: true });

// 检索标题清理（cleanQueryTitle）、剥艺人候选（artistFromTitle）与
// 标题变体生成（titleVariantsOf）已上提到 shared/title-variants.js——
// 网易云匹配漏斗与本级联共用同一份规则集，本文件只留消费点。
// 规则语义见该文件头部考据（'ver.<歌姬>'/cover/尾括弧/'Artist - Title'
// 前缀/【栏目】头/feat.尾/斜杠尾/歌系语尾/字幕组/艺人锚十条）。

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

// LRCLIB/酷狗两条直连链的外源代理通道（LYRIC_PROXY 本地部署档——见
// lib/lyric-proxy.js 头注）；未配置回 {}，各 fetch 点逐字节旧行为
const lyricOpts = () => {
  const d = lyricDispatcher();
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
// /api/search 自由文本检索 + 本端自筛：instrumental 跳过、艺人归一包含、
// 时长 ±15s 窗内取最近（yt_ 曲名实际是视频标题、时长含片头偏长——官方
// /api/get 的 ±2s 精确闸对它们太严）。~20req/s 礼仪：429 尊重 Retry-After
// 重试一次即止，不叠重试打爆公共上游。
const LRCLIB_UA = 'MeowSync external-lyric fallback (self-hosted)';
// strictTitle：宽检轮（无艺人约束）标题身份闸——见 strictTitleHit
// verify（可选）：(hit, {pool})=>Promise<boolean> 逐候选归属核验——同名
// 汤里首顺位常被撞名者占住，判否换条在同源内完成而非整源判死；第二参
// 透排序后候选池身份供判官比较同题异曲；verify 缺席保持旧行为取第一
// 顺位（反查/直调等无核验通道场景，pool 也不构）
// choose（可选）：(pool)=>Promise<extId|null> 整池单发消歧——免时长末轮
// 注入，多候选（≥2）时把排序后前 8 条身份交判官一发选择题，挑中即收录
// 不再逐候选核验（pick 已是全池相对判定）；null/抛错/池外 id 按未选中
// 落回 verify 迭代；单候选无歧义不启用
// deadline（可选）：级联软时限戳——逐候选迭代把单源 AI 判定面放大到
// 至多 3 次，过期起轮即停不再续烧；缺席保持旧行为（直调/测试不填）
async function lrclibFetch({ title, artist, durationSec, strictTitle = false, verify, choose, signal, deadline }) {
  const q = [cleanQueryTitle(title), String(artist || '').trim()].filter(Boolean).join(' ');
  if (!q) return null;
  const url = `https://lrclib.net/api/search?q=${encodeURIComponent(q)}`;
  const doFetch = () => fetch(url, {
    headers: { 'User-Agent': LRCLIB_UA, Accept: 'application/json' },
    signal: timedSignal(signal, 10000),
    ...EXT_FETCH_GUARD,
    ...lyricOpts(),
  });
  let res = await doFetch();
  if (res.status === 429) {
    const waitSec = Number(res.headers.get('retry-after'));
    // Retry-After 过长/缺省不硬等——判失败换下一源，比堵调用方强
    if (!Number.isFinite(waitSec) || waitSec <= 0 || waitSec > 8) {
      throw new Error('lrclib 限流');
    }
    await abortableSleep(waitSec * 1000, signal);
    res = await doFetch();
  }
  // 5xx 单点重试：观测过真实 503 抖动——800ms 后原样重发一次再判死。
  // 429 分支语义不动（Retry-After 已尊重过）；重发仍走 doFetch 同防御面
  if (!res.ok && res.status >= 500) {
    await abortableSleep(800, signal);
    res = await doFetch();
  }
  if (!res.ok) throw new Error(`lrclib HTTP ${res.status}`);
  const list = await readJsonCapped(res);
  const items = (Array.isArray(list) ? list : [])
    .filter((it) => it && typeof it === 'object' && it.id != null)
    .filter((it) => it.instrumental !== true)
    .filter((it) => (typeof it.syncedLyrics === 'string' && it.syncedLyrics.trim())
      || (typeof it.plainLyrics === 'string' && it.plainLyrics.trim()))
    .filter((it) => artistHit(artist, it.artistName))
    .filter((it) => !strictTitle || strictTitleHit(it.trackName, title))
    .map((it) => ({
      it,
      synced: Boolean(typeof it.syncedLyrics === 'string' && it.syncedLyrics.trim()),
      diff: durationSec && Number.isFinite(+it.duration) ? Math.abs(+it.duration - durationSec) : null,
    }))
    // 有声明时长才进 ±15s 闸；调用方没给时长则不做时长过滤
    .filter((x) => !durationSec || (x.diff != null && x.diff <= 15));
  if (!items.length) return null;
  // 滚动词优先 → 时长差升序（无差值殿后）
  items.sort((a, b) => Number(b.synced) - Number(a.synced) || (a.diff ?? 9e9) - (b.diff ?? 9e9));
  // 同题候选池：排序后前 8 条的条目身份——extId 与 hit.extId 同式供
  // choose 指回条目；{title,artist,album} 随 verify 透出喂归属核验（进
  // judgeInner 的 poolSeg 与 vkey v3 盐）。它是判定证据不是迭代面——
  // 逐候选核验上限仍 3 条不变
  const pool = items.slice(0, 8).map(({ it }) => ({
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
  // choose 通道：多候选时整池单发消歧，挑中即核验结论直接收录（外层
  // verifyHit 凭 verified 烙记不重验）；未选中/故障/池外 id 落回迭代
  if (choose && items.length >= 2) {
    let picked = null;
    try {
      picked = await choose(pool);
    } catch (e) {
      if (e?.aborted || signal?.aborted) throw abortErr();
      picked = null;                        // 消歧故障按未选中——落回迭代
    }
    if (picked != null) {
      const idx = pool.findIndex((p) => p.extId === picked);
      if (idx >= 0) return markVerified(hitOf(items[idx].it));
      // 指回池外 id 按未选中落回迭代——不整源判死
    }
  }
  // verify 在 → 至多前 3 条逐候选核验（条目内嵌歌词零额外请求），判否
  // 换条；不在 → 仅取首顺位
  for (const { it: pick } of (verify ? items.slice(0, 3) : items.slice(0, 1))) {
    if (signal?.aborted) throw abortErr();
    // 软时限戳在才查——过期即停：继续迭代只是在级联尾巴上多烧逐候选
    // AI 判定；归 null 由级联尾部分流（deadlineHit 在循环外层记）
    if (deadline && Date.now() > deadline) break;
    const hit = hitOf(pick);
    if (verify) {
      if (!(await candidatePass(verify, hit, signal, { pool }))) continue;
      markVerified(hit);
    }
    return hit;
  }
  return null;
}

// LRCLIB /api/get/<id>：按条目 id 直取——fetchByExtId 反查支路用，不走
// 检索自筛（归属核验在级联产出时已经做过，反查只是取回同一份词）
async function lrclibGetById(id, signal) {
  const res = await fetch(`https://lrclib.net/api/get/${encodeURIComponent(id)}`, {
    headers: { 'User-Agent': LRCLIB_UA, Accept: 'application/json' },
    signal: timedSignal(signal, 10000),
    ...EXT_FETCH_GUARD,
    ...lyricOpts(),
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
// 直给行级 LRC 的 base64（krc 加密形态不解）。候选按时长差升序、上游
// score 决胜，至多串行试 3 条——单条失败换条不恋战。
// verify（可选）：(hit, {pool}) 逐候选归属核验——download 得词后判否即
// 换条，并入「单条失败换条」同款语义；第二参透排序后候选池身份（同
// lrclibFetch）；缺席取首个可用条（pool 也不构）
// choose（可选）：(pool)=>Promise<extId|null> 整池单发消歧（同
// lrclibFetch）——挑中只对这一条发 download；目标 download 失败/choose
// 故障/池外 id 都按未选中落回逐候选迭代
// deadline（可选）：级联软时限戳——候选迭代过期起轮即停（每条候选都
// 还要烧一发 download 拿词再判定）；缺席保持旧行为
async function kugouFetch({ title, artist, durationSec, strictTitle = false, verify, choose, signal, deadline }) {
  const kw = [cleanQueryTitle(title), String(artist || '').trim()].filter(Boolean).join(' ');
  if (!kw) return null;
  const durArg = durationSec ? `&duration=${Math.round(durationSec * 1000)}` : '';
  const sres = await fetch(`https://lyrics.kugou.com/search?ver=1&man=yes&client=pc&keyword=${encodeURIComponent(kw)}${durArg}`, {
    headers: { 'User-Agent': YTM_UA, Accept: 'application/json' },
    signal: timedSignal(signal, 10000),
    ...EXT_FETCH_GUARD,
    ...lyricOpts(),
  });
  if (!sres.ok) throw new Error(`kugou search HTTP ${sres.status}`);
  const sbody = await readJsonCapped(sres);
  // 候选标题字段实测是 song（部分回包形态带 songname——两槽都认）
  const candTitleOf = (cd) => cd.song || cd.songname;
  const cands = (Array.isArray(sbody?.candidates) ? sbody.candidates : [])
    .filter((cd) => cd && cd.id != null && cd.accesskey)
    .filter((cd) => artistHit(artist, cd.singer))
    .filter((cd) => !strictTitle || strictTitleHit(candTitleOf(cd), title))
    .map((cd) => ({
      cd,
      // 候选 duration 是毫秒——与 durationSec 同量纲化再比差
      diff: durationSec && Number.isFinite(+cd.duration)
        ? Math.abs(+cd.duration / 1000 - durationSec) : null,
    }))
    .filter((x) => !durationSec || (x.diff != null && x.diff <= 15));
  cands.sort((a, b) => (a.diff ?? 9e9) - (b.diff ?? 9e9) || (b.cd.score || 0) - (a.cd.score || 0));
  // 同 lrclib——排序后前 8 条候选身份进 pool（extId 与 hit.extId 同式供
  // choose 指回；{title,artist,album} 喂归属核验，判定证据非迭代面）；
  // 酷狗候选无专辑字段则 album 略
  const pool = cands.slice(0, 8).map(({ cd }) => ({
    extId: `kugou_${cd.id}`,
    title: candTitleOf(cd), artist: cd.singer,
    album: cd.album || cd.albumname || undefined,
  }));
  // 单候选 download → hit：失败归 null（调用方换条/落回迭代，不整源判
  // 死），abort 穿透。choose 挑中条与逐候选迭代共用一份
  const downloadHit = async (cd) => {
    try {
      const dres = await fetch('https://lyrics.kugou.com/download?ver=1&client=pc'
        + `&id=${encodeURIComponent(String(cd.id))}&accesskey=${encodeURIComponent(String(cd.accesskey))}`
        + '&fmt=lrc&charset=utf8', {
        headers: { 'User-Agent': YTM_UA, Accept: 'application/json' },
        signal: timedSignal(signal, 10000),
        ...EXT_FETCH_GUARD,
        ...lyricOpts(),
      });
      if (!dres.ok) return null;
      const dbody = await readJsonCapped(dres);
      const lrc = Buffer.from(String(dbody?.content || ''), 'base64').toString('utf8').trim();
      if (!lrc) return null;
      return {
        lrc, source: 'kugou', extId: `kugou_${cd.id}`,
        synced: parseLrcLines(lrc).length > 0,
        // 同 lrclib——候选条目身份透给归属核验（酷狗候选无专辑字段则略）
        meta: {
          title: candTitleOf(cd), artist: cd.singer,
          album: cd.album || cd.albumname || undefined,
        },
      };
    } catch (e) {
      if (e?.aborted || signal?.aborted) throw abortErr();
      return null;
    }
  };
  // choose 通道同 lrclibFetch：多候选整池单发消歧，挑中只对这一条发
  // download；choose 故障/池外 id/download 失败/迭代过期都按未选中落回
  // 逐候选迭代（被挑条在迭代里再败即换条，语义同构）
  if (choose && cands.length >= 2) {
    let picked = null;
    try {
      picked = await choose(pool);
    } catch (e) {
      if (e?.aborted || signal?.aborted) throw abortErr();
      picked = null;                        // 消歧故障按未选中——落回迭代
    }
    if (picked != null && !(deadline && Date.now() > deadline)) {
      if (signal?.aborted) throw abortErr();
      const idx = pool.findIndex((p) => p.extId === picked);
      const hit = idx < 0 ? null : await downloadHit(cands[idx].cd);
      if (hit) return markVerified(hit);    // pick 即核验结论——不重验
    }
  }
  for (const { cd } of cands.slice(0, 3)) {
    if (signal?.aborted) throw abortErr();
    // 同 lrclibFetch——过期即停：每条候选还要烧一发 download 再核验
    if (deadline && Date.now() > deadline) break;
    const hit = await downloadHit(cd);
    if (!hit) continue;  // 单条候选失败换下一条——不整源判死
    // 核验在 download 外：核验通道故障要放行候选（与级联「核验故障不拦」
    // 同口径），并入「单条失败换条」会把核验哑火放大成整源判死
    if (verify) {
      if (!(await candidatePass(verify, hit, signal, { pool }))) continue;  // 判否换条
      markVerified(hit);
    }
    return hit;
  }
  return null;
}

// 纯文本词 → 判定抽样行：剥方括号段（[mm:ss] 时间戳、[ti:]/[ar:] 元行、
// [re:]/[ve:] 词源烙记同剥）取词文——「没轴的文本词」也过 AI 归属核验。
// 出参与 parseLrcLines 同构 {text}（judgeInner 只消费 .text）
const plainTextLines = (lrc) => String(lrc || '').split('\n')
  .map((l) => ({ text: l.replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim() }))
  .filter((l) => l.text);

// ── 级联与缓存包装 ──
// AI 归属核验：判「明显是别的歌」视同无词继续下一源；核验通道故障/判不定
// 放行。无条件走 judgeLyricLines——它内部 getVerdict 缓存先行（命中即返不烧
// AI），「已落库判定不随 aiEnabled 旁路」与下载链 verifyDownloadOwnership
// 同口径；AI 关时 askAiJson 前置返 null 按判不定放行。vkey 锚
// (extId, title, author)——与 verifyDownloadOwnership 传 providerData 同款
// 签名时同键命中落库判定。
// hit.meta（检索命中的候选条目身份）进 judgeLyricLines 的 candidate 参——
// 词面撞名时条目身份是同名异曲拦截的关键证据；pool（可选，检索侧排序
// 后前 8 条身份）挂 candidate.pool 进判定提示词，vkey 同步换 v3 盐——
// pool 语境判定与无池盲审互不命中（见 lyricVerdictKey 版本段说明）
async function verifyHit(hit, { title, artist, signal, pool }) {
  let lines = parseLrcLines(hit.lrc);
  // 纯文本词不再零核验：剥标签行取词文行抽样——剥完真空（纯元行/
  // instrumental 声明词这类没词文的形态）才放行
  if (!lines.length) lines = plainTextLines(hit.lrc);
  if (!lines.length) return true;
  const vkey = lyricVerdictKey(hit.extId, title || '', artist || '', pool?.length);
  const ok = await judgeLyricLines({
    vkey, lines, title: title || '', author: artist || '',
    candidate: { ...hit.meta, pool }, signal,
  });
  return ok !== false;             // null=无法判定按相符放行
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
  // 检索轮次（artist 画像）：首轮严格用调用方给的 artist——曲库 id
  // （qq_/数字）的 artist 是元数据，可信。UGC 曲（bv_/yt_/显式 videoId）
  // 的 artist 实为 UP 主/频道名，严格轮必灭——干净 miss 后追加降轮：
  //   1. artistFromTitle 剥出的真实艺人候选
  //   2. artist:'' 宽检——artistHit('','x') 放行全部
  // 宽检轮（artist 归一为空=无艺人约束，'' 与 '_'/'--' 类占位符都算——
  // 实证病例作者就是 '_'）改由 strictTitle 标题身份闸先挡同名异曲，
  // 再由 verifyHit 归属核验兜；具名 artist 轮 artistHit 交叉约束在位，
  // 保持模糊召回
  // 曲库行不加降轮：宽检会把「真无词」变成「可能错词」（AI 关时无核验兜底）
  const ugc = Boolean(ytVid) || BV_TRACK_ID_RE.test(String(songId));
  const artistRounds = [String(artist || '')];
  if (ugc) {
    const seen = new Set(artistRounds.map(normName));
    for (const a of [artistFromTitle(title), '']) {
      const k = normName(a);
      if (!seen.has(k)) { seen.add(k); artistRounds.push(a); }
    }
  }
  let lastErr = null;
  let cleanMiss = false;   // 有过「干净的无词」终态（区别于全源传输故障）
  let deadlineHit = false; // 被软时限截断——展开没跑完，不等价于「无词」

  // fetch 层逐候选核验闭包：同名曲汤里首顺位常是撞名者——判否换条在
  // 同源内完成（每候选 vkey 挂各自 extId 互不串），「一锤定音」的整源
  // 判死面收窄成单候选判否。归属签名始终用来源原标题/作者（vkey 与
  // 下载链同口径）——roundArtist 与变体 title 只是检索展开的候选料，
  // 不进归属判定。extra.pool 是该次检索排序后前 8 条身份——判官拿到
  // 同题池才分得清「同题异曲里来源实际唱哪条」（vkey 换 v3 盐与无池
  // 判定互不命中）
  const verify = async (h, extra) => {
    // 软时限过期短路放行——候选迭代把单源单变体 AI 判定面放大到至多
    // 3 次，迭代中过期还逐条烧 AI 会把级联拖出 45s 软时限；放行比继续
    // 烧省（判否面收窄成「标题闸漏过」一种，归截断尾部语义兜）
    if (Date.now() > deadline) return true;
    const ok = await verifyHit(h, { title, artist, signal, pool: extra?.pool });
    if (!ok) console.info(`[lyric-ext] 候选 ${h.extId} 词归属核验不符，试下一条`);
    return ok;
  };

  // 免时长末轮的整池单发消歧闭包：同题异曲逐候选盲审不够决断（实证
  // KKB 英文版被判 ok 收录）——排序后候选池整盘交 judgePoolPick 做
  // 单发选择题「来源最可能翻唱哪条」，指回 extId 由 fetch 层直接收录
  // （挑中即核验结论不再单审）。签名用来源原始 title/artist——与
  // verify 同口径：roundArtist/变体只是检索展开的候选料不进判定。
  // 按池 extId 集 memoize：LRCLIB/酷狗两池各判一次，同池在变体展开里
  // 重进不重复烧 AI。过期/异常/abort 归 null——「未选中」由 fetch 层
  // 落回逐候选核验（迭代自带 deadline/abort 闸）
  const pickMemo = new Map();   // 池 extId 集 -> Promise<extId|null>
  const choose = (pool) => {
    if (Date.now() > deadline) return Promise.resolve(null);
    const key = pool.map((p) => p.extId).join('|');
    let p = pickMemo.get(key);
    if (!p) {
      p = judgePoolPick({ title, author: artist, pool, signal })
        .then((idx) => (idx == null ? null : pool[idx]?.extId ?? null))
        .catch(() => null);
      pickMemo.set(key, p);
    }
    return p;
  };

  // 单轮展开体：roundArtist × 源 × 标题变体——常规轮与免时长末轮共用
  // 一份执行体（dur/strictTitle/withYtm/tag/choose 五处取值不同——choose
  // 只在末轮注入，常规轮多候选仍走逐候选核验）。命中且过归属核验即返
  // hit；干净 miss 归 null；deadline 记 deadlineHit 断展开
  const runRound = async ({ roundArtist, dur, strictTitle, tag, withYtm = false, choose = undefined }) => {
    const sources = [];
    // YTM 支路吃 videoId 不吃 artist——只在常规首轮排（重复打同一份词没意义）
    if (withYtm) sources.push(['ytm', (sig) => ytmFetchLyric(ytVid, sig)]);
    sources.push(['lrclib', (sig, t) => lrclibFetch({ title: t, artist: roundArtist, durationSec: dur, strictTitle, verify, choose, signal: sig, deadline })]);
    sources.push(['kugou', (sig, t) => kugouFetch({ title: t, artist: roundArtist, durationSec: dur, strictTitle, verify, choose, signal: sig, deadline })]);
    for (const [name, run] of sources) {
      if (signal?.aborted) throw abortErr();
      let hit = null;
      // LRCLIB/酷狗按标题变体串行展开（YTM 单次——t=null 占位不吃）
      for (const t of (name === 'ytm' ? [null] : titleVariants)) {
        if (signal?.aborted) throw abortErr();
        if (Date.now() > deadline) { deadlineHit = true; break; }
        try {
          hit = await run(signal, t);
        } catch (e) {
          if (e?.aborted || signal?.aborted) throw abortErr();
          // 轮次/变体标注进日志便于病例回放——语义同原「第N轮」
          const vtag = t && t !== titleVariants[0] ? `·变体「${t}」` : '';
          console.warn(`[lyric-ext] ${name} 源失败（${tag}${vtag}）：${e?.message || e}`);
          lastErr = e;
          break;  // 传输故障换源——同族变体重打大概率同死
        }
        if (hit) break;   // 首个非 null 命中即停该源
        cleanMiss = true;
      }
      if (!hit) continue;
      // fetch 内逐候选核验验收过的命中带 verified 烙记——vkey 同口径已
      // 验过不再二次烧 AI；YTM 支无逐候选通道，照旧过外层 verifyHit
      if (!hit.verified) {
        try {
          if (!(await verifyHit(hit, { title, artist, signal }))) {
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

  for (let round = 0; round < artistRounds.length; round++) {
    if (signal?.aborted) throw abortErr();
    if (Date.now() > deadline) { deadlineHit = true; break; }
    const roundArtist = artistRounds[round];
    // 本轮无艺人约束 → 上标题身份闸：artistHit 全放行时自由文本「子串
    // 撞名」照收的口子由 strictTitleHit 确定性闸掉（先于 AI 核验）
    const strictTitle = !normName(roundArtist);
    const hit = await runRound({
      roundArtist, dur: durationSec, strictTitle,
      tag: `第${round + 1}轮`, withYtm: round === 0 && Boolean(ytVid),
    });
    if (hit) return { hit, truncated: false };
  }

  // 免时长末轮（UGC 限定）：截取版/片头尾超长的投稿对 ±15s 时长闸必灭。
  // 收成单次 artist='' 开放轮重扫：durationSec=0 + strictTitle 恒 true
  // + choose 整池单发消歧（多候选时一发选择题，未选中落回带同题池
  // 语境的逐候选核验）兜撞名排序。刻意不按原 artist 轮次面重扫——
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
    if (Date.now() > deadline) deadlineHit = true;
    else {
      const hit = await runRound({
        roundArtist: '', dur: 0, strictTitle: true, tag: '末轮·免时长', choose,
      });
      if (hit) return { hit, truncated: false };
    }
  }
  // 尾部判定：
  //  · deadline 截断且截断前已有源在传输层抛错（混合故障）→ 抛
  //    lastErr——截断掐掉的只是「还没跑的源/变体」，已发生的故障不能
  //    被吞成「无词」固化 10min；与全源故障同待遇走重试、不写缓存
  //  · 全源都死在传输层（一个「干净无词」终态都没有）→ 抛 lastErr
  //  · 其余回 null；deadlineHit 带 truncated——纯上游慢/展开没跑完
  //    ≠ 无词，调用方透 null 但跳过负缓存
  if (deadlineHit && lastErr) throw lastErr;
  if (lastErr && !cleanMiss) throw lastErr;
  return { hit: null, truncated: deadlineHit };
}

// extId → 词原文反查（ai.js 词源核验/翻译端点的取词支路——它们手里只有
// 词源 id 没有检索词）。ytm_<videoId> 直通 YTM（videoId 即键）、
// lrclib_<条目id> 走 /api/get；kugou_ 的 accesskey 不落 extId——出缓存即
// 无反查通道，只能吃进程内 LRU 里级联刚产出的那份（正窗 6h 内可命中）。
// 返回与级联同构的 {lrc, source, extId, synced, plain?}；id 非法/无词 →
// null，传输故障抛错（与级联同语义：故障走重试而不是固化成「无词」）。
async function fetchByExtId(extId, { signal } = {}) {
  const id = String(extId || '').trim();
  const m = EXT_LYRIC_ID_STRICT_RE.exec(id);
  if (!m) return null;
  const [, src, key] = m;
  // 进程内 LRU 先扫：下载相位几分钟前级联出的词免一次上游往返；
  // kugou_ 更是唯一取词道。比对用 trim 后的 id——入参带空白时原串比对必漏
  for (const e of resultCache.values()) {
    if (e.res && e.res.extId === id && Date.now() - e.at <= POS_TTL_MS) {
      return e.res;
    }
  }
  if (src === 'ytm') return ytmFetchLyric(key, signal);
  if (src === 'lrclib') return lrclibGetById(key, signal);
  return null; // kugou_
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
    .then(({ hit, truncated }) => {
      // 截断 null 不落负缓存——「没跑完」≠「无词」，固化会把上游慢写成
      // 10min 假阴性。truncated 与 hit 不并存（命中在级联内即早返）；
      // 搭车者共享本 promise，同待遇
      if (!truncated) cacheWrite(key, hit);
      return hit;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

module.exports = {
  fetchExternalLyric,
  fetchByExtId,
  // 源内函数导出供测试探针/调试——正常消费只走 fetchExternalLyric
  ytmFetchLyric, lrclibFetch, kugouFetch, lrclibGetById, titleVariantsOf, strictTitleHit,
  // 测试钩子：清空进程内缓存（不改生产语义）
  _clearCache: () => { resultCache.clear(); inflight.clear(); },
};

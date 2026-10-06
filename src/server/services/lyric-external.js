// 外部滚动歌词源链——网易云词源缺席/未匹配时的兜底：
//   yt_ 曲先走 YouTube Music（videoId 直达、LyricFind 供词），
//   再 LRCLIB（开放歌词库，本端自筛时长/艺人/纯音乐标记），
//   最后酷狗 lyrics.kugou.com（华语/粤语补位，fmt=lrc 直给行级 LRC）。
// 三路全灭回 null——调用方按「无词」处理（路由 404、下载链 NO_LYRICS）。
// 单一源全灭在传输层（没有一个「干净无词」终态）时抛错——这是故障不是
// 缺词，让调用方走重试语义，且不写负缓存。
//
// 结果面 { lrc, source:'ytm'|'lrclib'|'kugou', extId, synced, plain? }：
//   lrc    最佳文本——synced=true 是标准 LRC；false 时是纯文本（无时间戳
//          行，落盘仍是可读词稿，播放端解析不出滚动行而已）
//   extId  源内稳定 id（ytm_<videoId>/lrclib_<条目id>/kugou_<行id>）——
//          归属核验 vkey 与 AI 译文缓存键都挂它，与网易云/QQ id 空间隔离，
//          形态见 shared/predicates.js EXT_LYRIC_ID_RE
//   plain  纯文本歌词（LRCLIB 条目常带 synced+plain 两形态时顺带透出）
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
// AI 归属核验：产出词在 aiEnabled 时过 lyric-verify.judgeLyricLines——
// 判「明显是别的歌」视同无词继续下一源；AI 关/判不定放行（「AI 是增强
// 不是门禁」与 lyric-verify 同口径）。
const { ytDispatcher } = require('../lib/yt-proxy');
const { YT_TRACK_ID_RE, BV_TRACK_ID_RE, EXT_LYRIC_ID_STRICT_RE } = require('../../shared/predicates.js');
const { aiEnabled } = require('../lib/ai');
const { parseLrcLines, judgeLyricLines, lyricVerdictKey } = require('./lyric-verify');

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

const normKey = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
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

// 检索标题清理：视频站标题的「MV/官方/4K/字幕」类括弧装饰会稀释检索命中
// ——只剥明显视频语境的括弧段；live/cover 这类版本限定词保留（剥了会
// 错配录音室版词）
const VIDEO_TAG_RE = /[【\[（(][^\]】)）]{0,60}(?:mv|official|video|audio|hd|uhd|4k|8k|lyrics?|官方|字幕|高清|完整版|音乐录像带)[^\[（(【\]】)）]{0,60}[\]】)）]/gi;
function cleanQueryTitle(title) {
  const raw = String(title || '').replace(/\s+/g, ' ').trim();
  const cleaned = raw.replace(VIDEO_TAG_RE, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || raw;
}

// UGC 投稿标题剥艺人候选：bv_/yt_ 语境的 artist 实为 UP 主/频道名，
// artistHit 硬滤对曲库艺人名必灭——从标题形态里补一个真实艺人候选：
//   'A - B' / 'A – B'  YouTube「Artist - Song」与 B 站「UP主 - 标题」同形
//   'A《B》'           书名号前段常是艺人（'周杰伦《晴天》'）
//   '【A】B'           B 站前缀段（艺人/栏目——【4K】这类已在 cleanQueryTitle
//                      剥掉；残存误候选由归属核验兜）
// 剥不出归 ''。只产候选不改写 title——检索词仍用完整标题
function artistFromTitle(title) {
  const t = cleanQueryTitle(title);
  const strip = (s) => String(s || '').replace(/[【】\[\]（）()「」『』]/g, '').trim();
  let m = t.match(/^\s*(.{1,40}?)\s+[-–—]\s+\S/);
  if (m) return strip(m[1]);
  m = t.match(/^\s*(.{1,40}?)\s*《[^》]{1,80}》/);
  if (m) return strip(m[1]);
  m = t.match(/^\s*【([^】]{1,30})】\s*\S/);
  if (m) return strip(m[1]);
  return '';
}

// 检索标题变体：VTuber/翻唱投稿标题常带检索噪声段——'ver.<歌姬>' 尾缀、
// cover 标记、尾括弧、'Artist - Title' 前缀、【栏目】头、feat. 尾、
// '曲 ／ 演唱者' 斜杠尾、'を歌いました/歌ってみた' 日语翻唱语尾、
// 中文字幕/中字/CC字幕 字幕组标记、艺人名头尾缀。
// 实证病例：'Dream Play Sick ver.EMA' 原始形态级联全灭、剥成
// 'Dream Play Sick' 后 LRCLIB 命中（lrclib_25010661）；
// 'ロストアンブレラを歌いました ／ rei sirose' 要斜杠尾+歌系中缀双剥才出真名。
// 基座 = cleanQueryTitle（已剥 MV/官方类视频语境括弧）占首，规则集对基座
// 各剥一层产单变体——剥一层即止不滚雪球；normKey 去重，总量上限 4 项。
// 「激进变体」= 全规则迭代到不动点（≤3 趟）：单规则产不出的复合噪声形态
// 靠它兜底，保底末位槽（最冒险最后试）——它有效时单变体只取前 2 给它
// 留位，无效/与已有项重复时单变体取满 3 不浪费槽位。
// 变体只喂检索词——归属核验签名仍用调用方原始 title（见 cascade）。
// ver/feat/艺人锚剥缀带边界断言：'Conver. x'/'Somewith you'/'EMAIL'/
// 'ver.EMA' 这类词干内嵌的形态不误剥出残片变体。
// routes/youtube.js extractYtSong 的 candidates 补腿与 a 规则同口径——
// VER_TAIL_RE 改动要两边同步。
const VER_TAIL_RE = /\s*[-–—~\/|：:]?\s*(?<![\p{L}\p{N}])ver(?:sion)?[\.。]\s*[\p{L}\p{N}][\p{L}\p{N}\s_'&·-]{0,30}$/iu;
// b 系 cover 尾缀三件：cover 语义的尾括弧组 / 'covered by X'（'×' 多人连接
// 不挡路——cover 语后整段剥）/ 分隔符引导的裸 cover 尾
const COVER_BRACKET_TAIL_RE = /[（(【\[][^（）()【】\[\]]{0,38}?\bcover(?:ed|s)?\b[^（）()【】\[\]]{0,38}?[)）】\]]\s*$/iu;
const COVER_BY_TAIL_RE = /[\s\-–—~\/|：:／]+cover(?:ed)?\s+by\s+\S.{0,38}$/iu;
const BARE_COVER_TAIL_RE = /[\s\-–—~\/|：:／]+covers?\s*$/iu;
const TAIL_GROUP_RE = /(?:（[^（）]{1,40}）|\([^()]{1,40}\)|【[^【】]{1,40}】|\[[^\[\]]{1,40}\])\s*$/u;
const ARTIST_DASH_HEAD_RE = /^.{1,40}?\s*[-–—]\s+/;
const HEAD_BANG_RE = /^【[^【】]{1,40}】\s*/u;
const FEAT_TAIL_RE = /\s*(?<![\p{L}\p{N}])(?:feat\.?|ft\.?|featuring|with)\s+.{1,40}$/i;
// 斜杠尾：'X ／ Y'/'X / Y'（全/半角、前后空格可缺）尾段 ≤40 字——VTuber
// 标题挂演唱者尾巴的常见形态（'幸福な死を ／ 久遠千歳'）
const SLASH_TAIL_RE = /\s*[/／]\s*[^/／]{1,40}\s*$/u;
// 日语翻唱语尾/中缀：を歌いました/歌ってみた/歌った/歌わせて頂きました/
// 歌ってみたよ——仅近行尾才剥（尾段 ≤12 字且不含斜杠/括弧），标题中段的
// 歌系词不剥，叠了斜杠尾的形态留给激进变体双剥
const UTA_TAIL_RE = /\s*[をはが]?\s*歌(?:いました|ってみた|った|わせて頂きました|ってみたよ)[^\/／（(【\[]{0,12}$/iu;
// 字幕组标记：出现即剥（剥完非空才收，push 闸把空结果滤掉）——长短语
// 先列（'中文字幕' 先于子串 '中字'，'付き' 先于 '付'）
const SUBTITLE_TAG_RE = /\s*(?:CC字幕|中文字幕|字幕付き|歌詞付き|歌词付き|字幕付|歌詞付|歌词付|中字)\s*/giu;
// 艺人锚用归一分隔符字符集（与 normName 剥除同族，加冒号/全角斜杠/波浪）
const NAME_SEP_CH = String.raw`\s\-_·•、,，。&+＋/／\\'’"（）()【】\[\]:：~～|`;
const NAME_SEP_RUN = new RegExp(`[${NAME_SEP_CH}]+`);
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// artist 可缺省：级联传调用方原始 artist——变体生成是输入清洗，与归属
// 轮次（roundArtist 降轮）解耦
function titleVariantsOf(title, artist = '') {
  const base = cleanQueryTitle(title);
  const seen = new Set([normKey(base)]);
  // 单规则变体先全量收集（normKey 去重、保规则序）——席位在末尾拼装时
  // 再切，好给激进变体保底末位槽（见 return 前注释）
  const singles = [];
  const collect = (v) => {
    const t = String(v || '').replace(/\s+/g, ' ').trim();
    if (!t) return;
    const k = normKey(t);
    if (seen.has(k)) return;
    seen.add(k);
    singles.push(t);
  };
  // 艺人锚：parts 间容许任意连接料（与归一后比同口径），锚后须分隔符或
  // 行尾——'EMA' 不切进 'EMAIL'/'ver.EMA' 的词干粘连
  const ap = String(artist || '').trim().split(NAME_SEP_RUN).filter(Boolean).map(escRe);
  const ab = ap.join(`[${NAME_SEP_CH}]*`);
  // 规则集：每条对输入剥一层——单规则变体对基座各剥一次；激进变体对
  // 进化中的串迭代应用
  const rules = [
    // a. 尾缀 ver.<名>——$ 锚定只剥尾巴，标题中段的 ver. 不动
    (s) => s.replace(VER_TAIL_RE, ''),
    // b. cover 尾缀——cleanQueryTitle 故意保 cover 括弧作版本限定，但作
    //    检索变体剥掉是对的（cover 与原曲同词）
    (s) => s.replace(COVER_BRACKET_TAIL_RE, '')
            .replace(COVER_BY_TAIL_RE, '')
            .replace(BARE_COVER_TAIL_RE, ''),
    // c. 尾括弧组：'乐园(粤)' → '乐园'——只剥最后一个、组内 ≤40 字
    (s) => s.replace(TAIL_GROUP_RE, ''),
    // d. 'Artist - Title' 前缀——artistFromTitle 的 title 侧补腿
    (s) => s.replace(ARTIST_DASH_HEAD_RE, ''),
    // e. 头部【…】B 站栏目头
    (s) => s.replace(HEAD_BANG_RE, ''),
    // f. 尾缀 feat./ft./featuring/with X
    (s) => s.replace(FEAT_TAIL_RE, ''),
    // g. 斜杠尾
    (s) => s.replace(SLASH_TAIL_RE, ''),
    // h. 日语翻唱语尾/中缀
    (s) => s.replace(UTA_TAIL_RE, ''),
    // i. 字幕组标记
    (s) => s.replace(SUBTITLE_TAG_RE, ' '),
    // j/k. 艺人锚前缀/尾缀（'EMA rumor'→'rumor'；'X ／ artist'、
    //      'X by artist'、裸 artist 尾——artist 缺省时规则缺席）
    ...(ab ? [
      (s) => s.replace(new RegExp(`^[${NAME_SEP_CH}]*${ab}(?:[${NAME_SEP_CH}]+|$)`, 'iu'), ''),
      (s) => s.replace(new RegExp(`[${NAME_SEP_CH}]+(?:by[${NAME_SEP_CH}]+)?${ab}[${NAME_SEP_CH}]*$`, 'iu'), ''),
    ] : []),
  ];
  for (const r of rules) collect(r(base));
  // 激进变体：全规则迭代到不动点（≤3 趟）——'Xを歌いました ／ Y' 这类复合
  // 噪声要斜杠尾+歌系中缀双剥才出真名，单规则各剥一层产不出
  let agg = base;
  for (let pass = 0; pass < 3; pass++) {
    const next = rules.reduce((s, r) => r(s), agg).replace(/\s+/g, ' ').trim();
    if (normKey(next) === normKey(agg)) break;
    agg = next;
  }
  agg = String(agg || '').replace(/\s+/g, ' ').trim();
  const aggOk = Boolean(agg) && !seen.has(normKey(agg));
  // 拼装：raw 永远占首（空基座也保形——级联按一次正常尝试消费）；激进
  // 变体保底末位槽——复合噪声正是它的设计目标病例形态（'【栏】A - B
  // (cover) ／ 演唱者' 这类标题单规则恰占满 3 席时，真名只有全剥才得出）。
  // agg 有效→单变体只取前 2 给它留位；无效/重复→取满 3 不浪费槽位
  const out = [base, ...singles.slice(0, aggOk ? 2 : 3)];
  if (aggOk) out.push(agg);
  return out;
}

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
// /api/search 自由文本检索 + 本端自筛：instrumental 跳过、艺人归一包含、
// 时长 ±15s 窗内取最近（yt_ 曲名实际是视频标题、时长含片头偏长——官方
// /api/get 的 ±2s 精确闸对它们太严）。~20req/s 礼仪：429 尊重 Retry-After
// 重试一次即止，不叠重试打爆公共上游。
const LRCLIB_UA = 'MeowSync external-lyric fallback (self-hosted)';
async function lrclibFetch({ title, artist, durationSec, signal }) {
  const q = [cleanQueryTitle(title), String(artist || '').trim()].filter(Boolean).join(' ');
  if (!q) return null;
  const url = `https://lrclib.net/api/search?q=${encodeURIComponent(q)}`;
  const doFetch = () => fetch(url, {
    headers: { 'User-Agent': LRCLIB_UA, Accept: 'application/json' },
    signal: timedSignal(signal, 10000),
    ...EXT_FETCH_GUARD,
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
  const pick = items[0].it;
  const syncedText = String(pick.syncedLyrics || '').trim();
  const plainText = String(pick.plainLyrics || '').trim();
  return {
    lrc: syncedText || plainText,
    plain: syncedText && plainText ? plainText : undefined,
    source: 'lrclib',
    extId: `lrclib_${pick.id}`,
    synced: Boolean(syncedText),
  };
}

// LRCLIB /api/get/<id>：按条目 id 直取——fetchByExtId 反查支路用，不走
// 检索自筛（归属核验在级联产出时已经做过，反查只是取回同一份词）
async function lrclibGetById(id, signal) {
  const res = await fetch(`https://lrclib.net/api/get/${encodeURIComponent(id)}`, {
    headers: { 'User-Agent': LRCLIB_UA, Accept: 'application/json' },
    signal: timedSignal(signal, 10000),
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
// 直给行级 LRC 的 base64（krc 加密形态不解）。候选按时长差升序、上游
// score 决胜，至多串行试 3 条——单条失败换条不恋战。
async function kugouFetch({ title, artist, durationSec, signal }) {
  const kw = [cleanQueryTitle(title), String(artist || '').trim()].filter(Boolean).join(' ');
  if (!kw) return null;
  const durArg = durationSec ? `&duration=${Math.round(durationSec * 1000)}` : '';
  const sres = await fetch(`https://lyrics.kugou.com/search?ver=1&man=yes&client=pc&keyword=${encodeURIComponent(kw)}${durArg}`, {
    headers: { 'User-Agent': YTM_UA, Accept: 'application/json' },
    signal: timedSignal(signal, 10000),
    ...EXT_FETCH_GUARD,
  });
  if (!sres.ok) throw new Error(`kugou search HTTP ${sres.status}`);
  const sbody = await readJsonCapped(sres);
  const cands = (Array.isArray(sbody?.candidates) ? sbody.candidates : [])
    .filter((cd) => cd && cd.id != null && cd.accesskey)
    .filter((cd) => artistHit(artist, cd.singer))
    .map((cd) => ({
      cd,
      // 候选 duration 是毫秒——与 durationSec 同量纲化再比差
      diff: durationSec && Number.isFinite(+cd.duration)
        ? Math.abs(+cd.duration / 1000 - durationSec) : null,
    }))
    .filter((x) => !durationSec || (x.diff != null && x.diff <= 15));
  cands.sort((a, b) => (a.diff ?? 9e9) - (b.diff ?? 9e9) || (b.cd.score || 0) - (a.cd.score || 0));
  for (const { cd } of cands.slice(0, 3)) {
    if (signal?.aborted) throw abortErr();
    try {
      const dres = await fetch('https://lyrics.kugou.com/download?ver=1&client=pc'
        + `&id=${encodeURIComponent(String(cd.id))}&accesskey=${encodeURIComponent(String(cd.accesskey))}`
        + '&fmt=lrc&charset=utf8', {
        headers: { 'User-Agent': YTM_UA, Accept: 'application/json' },
        signal: timedSignal(signal, 10000),
        ...EXT_FETCH_GUARD,
      });
      if (!dres.ok) continue;
      const dbody = await readJsonCapped(dres);
      const lrc = Buffer.from(String(dbody?.content || ''), 'base64').toString('utf8').trim();
      if (!lrc) continue;
      return {
        lrc, source: 'kugou', extId: `kugou_${cd.id}`,
        synced: parseLrcLines(lrc).length > 0,
      };
    } catch (e) {
      if (e?.aborted || signal?.aborted) throw abortErr();
      // 单条候选失败换下一条——不整源判死
    }
  }
  return null;
}

// ── 级联与缓存包装 ──
// AI 归属核验：产出词在 aiEnabled 时判「明显是别的歌」视同无词继续下一
// 源；核验通道故障/判不定放行。vkey 锚 (extId, title, author)——与下载链
// verifyDownloadOwnership 传 providerData 同款签名时同键命中落库判定。
async function verifyHit(hit, { title, artist, signal }) {
  if (!aiEnabled()) return true;
  const lines = parseLrcLines(hit.lrc);
  if (!lines.length) return true;  // 纯文本词无时间戳行可验——放行
  const vkey = lyricVerdictKey(hit.extId, title || '', artist || '');
  const ok = await judgeLyricLines({ vkey, lines, title: title || '', author: artist || '', signal });
  return ok !== false;             // null=无法判定按相符放行
}

async function cascade({ songId, title, artist, durationSec, videoId, signal, deadlineMs = CASCADE_DEADLINE_MS }) {
  const ytVid = String(videoId || '') || String(songId || '').match(YT_TRACK_ID_RE)?.[1] || '';
  // 检索标题变体：raw 在前、剥缀形态殿后——每个 artist 轮内 LRCLIB/酷狗
  // 各自按序串行试，首个非 null 命中即停该源（YTM 吃 videoId 不吃
  // title——保持首轮一次不动）。artist 传调用方原始值而非 roundArtist
  // ——变体生成是输入清洗，与归属轮次解耦
  const titleVariants = titleVariantsOf(title, artist);
  // 级联软时限：artist 轮 × 源 × 变体的展开会挤爆前端 80s 超时里 AI 核验
  // 与响应的份额——每轮/每变体启动前查一次，超线记 deadlineHit 截断。
  // 截断不是干净 miss，尾部按「截断前已有源抛错→抛 lastErr 走重试；
  // 纯没跑完→null+truncated（调用方不落负缓存）」分流
  const deadline = Date.now() + deadlineMs;
  // 检索轮次（artist 画像）：首轮严格用调用方给的 artist——曲库 id
  // （qq_/数字）的 artist 是元数据，可信。UGC 曲（bv_/yt_/显式 videoId）
  // 的 artist 实为 UP 主/频道名，严格轮必灭——干净 miss 后追加降轮：
  //   1. artistFromTitle 剥出的真实艺人候选
  //   2. artist:'' 宽检——artistHit('','x') 放行全部，错词由 verifyHit
  //      归属核验兜（UGC 严格轮本就必灭，宽检严格劣化不了什么）
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
  for (let round = 0; round < artistRounds.length; round++) {
    if (signal?.aborted) throw abortErr();
    if (Date.now() > deadline) { deadlineHit = true; break; }
    const roundArtist = artistRounds[round];
    const sources = [];
    // YTM 支路吃 videoId 不吃 artist——只在首轮排（重复打同一份词没意义）
    if (round === 0 && ytVid) sources.push(['ytm', (sig) => ytmFetchLyric(ytVid, sig)]);
    sources.push(['lrclib', (sig, t) => lrclibFetch({ title: t, artist: roundArtist, durationSec, signal: sig })]);
    sources.push(['kugou', (sig, t) => kugouFetch({ title: t, artist: roundArtist, durationSec, signal: sig })]);
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
          // 变体标注进日志便于病例回放——语义同原「第N轮」
          const vtag = t && t !== titleVariants[0] ? `·变体「${t}」` : '';
          console.warn(`[lyric-ext] ${name} 源失败（第${round + 1}轮${vtag}）：${e?.message || e}`);
          lastErr = e;
          break;  // 传输故障换源——同族变体重打大概率同死
        }
        if (hit) break;   // 首个非 null 命中即停该源
        cleanMiss = true;
      }
      if (!hit) continue;
      try {
        // 归属核验签名始终用来源原标题/作者（vkey 与下载链同口径）——
        // roundArtist 与变体 title 只是检索展开的候选料，不进归属判定
        if (!(await verifyHit(hit, { title, artist, signal }))) {
          console.info(`[lyric-ext] ${name} 词归属核验不符，继续下一源`);
          cleanMiss = true;
          continue;
        }
      } catch (e) {
        if (e?.aborted || signal?.aborted) throw abortErr();
        // 核验通道故障放行——与 verifyDownloadOwnership 归 null 同口径
      }
      return { hit, truncated: false };
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
  ytmFetchLyric, lrclibFetch, kugouFetch, lrclibGetById, titleVariantsOf,
  // 测试钩子：清空进程内缓存（不改生产语义）
  _clearCache: () => { resultCache.clear(); inflight.clear(); },
};

// ─────────────────────────────────────────────────────────────────────────
// 前后端共享谓词层（唯一真相源）
//
// 纯 ESM、零 IO、零顶层 await——前端经 Vite 直接 import，服务端 CJS 经
// require(ESM)（Node ≥20.19 / ≥22.12）消费同一文件，消灭「同口径两份正则
// 靠注释对齐」的漂移面（BV 形态表就曾前后端不一致：BV1{9} vs BV{10}）。
//
// 信任域注意：前端侧是「意图路由」（决定走哪条导入/搜索分支），服务端侧是
// 「安全校验」（参数合法性）——同一份正则两边各取所需语义，不矛盾。
// ─────────────────────────────────────────────────────────────────────────

// ── 原始形态正则 ──
// QQ songmid：10-20 位字母数字（新 mid 实际 14 位，留宽兼容旧形态）
export const SONGMID_RE = /^[0-9A-Za-z]{10,20}$/;
// 「疑似 songmid」判定（点歌台/顶栏 qq: 关键词分流用）：SONGMID_RE 之上还要
// 数字+字母混合——纯字母英文关键词不值得烧一次 resolve 往返，直接走搜索
export function isSongmidLike(s) {
  const v = String(s || '').trim();
  return SONGMID_RE.test(v) && /\d/.test(v) && /[a-z]/i.test(v);
}
// 真实 bvid 恒「BV1」头 + 9 位（bv 编码算法的固定前缀）；前后端统一严格形
export const BVID_RE = /^BV1[0-9A-Za-z]{9}$/i;
// 文本中抽取 bvid 的宽松形（含前后文容忍，服务端解析 href 用）
export const BVID_IN_TEXT_RE = /BV1[0-9A-Za-z]{9}/i;
export const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;
// 网易云 id：纯十进制；BOUNDED 是给入参校验的 20 位上限形态
export const NETEASE_ID_RE = /^\d+$/;
export const NETEASE_ID_BOUNDED_RE = /^\d{1,20}$/;
// qq_<songmid> 本站轨道 id（捕获组取裸 mid——ai.js/file-downloader 用）
export const QQ_SONG_ID_RE = /^qq_([0-9A-Za-z]{10,20})$/;
// bv_<bvid>[_pN] / yt_<videoId> 本站轨道 id（mix 导入/分享链白名单用；
// 捕获组取裸 id 与分 p 序号——App.vue mix 恢复循环用 exec 消费）。
// BV 段刻意宽于 BVID_RE（不强卡第 3 位 '1'）——前置过滤宽松放行，
// 非法 bvid 由服务端 BVID_RE 严校拒收计数 skipped，别把两头收同一条
export const BV_TRACK_ID_RE = /^bv_(BV[0-9A-Za-z]{10})(?:_p(\d+))?$/i;
export const YT_TRACK_ID_RE = /^yt_([A-Za-z0-9_-]{11})$/;
// 用户上传/自建曲目 id：file_<36进制戳+随机>——服务端 local_uploads 伪歌单
// 下登记 download_tasks（文件资产行），播放走 /downloads/songs/:id/file。
// 刻意不进 isResolvableTrackId：接收端没有那份文件，mix 分享链应滤掉它；
// 「下载到服务器」对它也无意义（文件本就在盘上）
export const FILE_TRACK_ID_RE = /^file_[0-9a-z]{8,40}$/;
// 外部词源 id：lyric-external 级联/手选候选池产出的源内 id（ytm_<videoId>/
// lrclib_<条目id>/kugou_<行id>/netease_<曲目id>）——词源核验/翻译白名单
// 与词属主键用它和网易云/QQ id 空间隔离。注意这是**词源**命名空间不是
// 轨道 id——不进 isResolvableTrackId（接收端没有对应媒体可解）。
// netease_ 收进宽松形是绑定词下游链路所需：网易轨道 id 是纯数字裸串，
// netease_ 前缀零撞型；手选绑定的 netease_ 词属主键要过 ai.js 翻译/
// 核验白名单——fetchLyricRaw 对 netease_<数字> 走专属直支保官方
// tlyric（非数字尾段才落 fetchByExtId 反查）——不收等于给每条手绑
// 网易词判「永不可译」（每次播放白打一发 400）。
// qq_ 刻意不收：与轨道 id 命名空间（QQ_SONG_ID_RE）同型，收进会把真
// QQ 轨道词的 fetchLyricRaw 分流劫到反查支路、丢掉官方译文 tlyric；
// qq_ 手选绑定词经 QQ_SONG_ID_RE 支路照常取词（官方译文一并回），
// 不在本白名单仍可被翻译端点放行
export const EXT_LYRIC_ID_RE = /^(ytm|lrclib|kugou|netease)_/;
// extId 严格整串形（fetchByExtId 反查入参校验用）：白名单闸只查前缀，
// 进 URL path/源内查询的键必须连尾段字符集也收敛——`[ /?` 这类脏尾
// 在宽松形下会漏到上游请求里。netease_<曲目id>/qq_<songmid> 两个手选
// 池词源 id（id/mid 即取词键，无 kugou 式 accesskey token 面）在严格
// 形全收；宽松形的取舍按撞型逐源评估见上方头注
export const EXT_LYRIC_ID_STRICT_RE = /^(ytm|lrclib|kugou|netease|qq)_([\w-]{1,120})$/;

// 本地歌单 id 前缀族
// - single_song_*：单曲分享临时壳
// - saved_queue_*：待播队列存成的歌单
// - local_pl_*：用户手动歌单（含 mix 导入的 local_pl_mix_*）
export const SINGLE_SONG_PREFIX = 'single_song_';
export const SAVED_QUEUE_PREFIX = 'saved_queue_';
export const LOCAL_PLAYLIST_PREFIX = 'local_pl_';

// 服务端镜像接受面：local_pl_/saved_queue_ + 长度上限（single_song_ 壳不下发镜像）
export const MIRROR_PLAYLIST_ID_RE = /^(local_pl_|saved_queue_)[\w-]{1,64}$/;

// 「接收端可解析」的本站轨道 id 判定——mix 分享链过滤（PlaylistPanel）与
// 服务端下载白名单（routes/downloads.js）共用同一条；id 不认识源站形态的
// 曲目（异常持久化行）两侧都该跳过而不是带病下发
export function isResolvableTrackId(id) {
  const s = String(id ?? '');
  return NETEASE_ID_RE.test(s) || QQ_SONG_ID_RE.test(s) || BV_TRACK_ID_RE.test(s) || YT_TRACK_ID_RE.test(s);
}

// 「换源」手动媒体源绑定可作用的轨道 id 集：网易数值曲（resolveOne 手动
// 插队步消费）+ qq_/bv_/yt_ 自有源曲（三个自有源流端点在自有源败亡时
// 由 manualStreamOverride 消费绑定 + file-downloader 手动腿顶替）。与
// isResolvableTrackId 今日同集合、异日未必——「接收端可解析」≠「可手动
// 绑媒体源」是两套演进轴，刻意独立成谓词：file_ 是用户上传资产，没有可
// 被顶替的在线链（存下=永不消费的僵尸行）；mix_ 壳 id 与 ext_ 词源命名
// 空间同型撞名（注区 L37-61）——永不该进本集，别拿宽化当「顺手收下」。
// 数组形态留测试谱逐条断言与将来分源闸取用面
export const UNLOCK_MANUAL_TRACK_RES = [
  NETEASE_ID_BOUNDED_RE, QQ_SONG_ID_RE, BV_TRACK_ID_RE, YT_TRACK_ID_RE
];
export function isUnlockManualTrackId(id) {
  const s = String(id ?? '');
  return UNLOCK_MANUAL_TRACK_RES.some(re => re.test(s));
}

// file_ 上传曲判定：本地资产，播放/编辑面需要单独识别
export function isFileTrackId(id) {
  return FILE_TRACK_ID_RE.test(String(id ?? ''));
}

// 外部歌单导入壳 id 的构造/解析对——生产侧 App.vue 导入器、解析侧
// PlaylistPanel 分享链反解共用同一张表，字面量不再两处手写。
// source: 'yt' | 'bili' | 'qq'；key 为源站单 id（listId/fid/disstid）
export function providerPlaylistShellId(source, key) {
  return `local_pl_${source}_${key}`;
}

// 解析外部导入壳 id：{source:'yt'|'bili'|'qq', key} | null。
// local_pl_mix_*/local_pl_<ts> 等非导入壳返回 null（调用方按本地单处理）
export function parseProviderShellId(id) {
  const m = /^local_pl_(yt|bili|qq)_([A-Za-z0-9_-]+)$/.exec(String(id ?? ''));
  return m ? { source: m[1], key: m[2] } : null;
}

// 本地内存态歌单 id 判定：三类非数字 id——不进 ?pl= URL、不参与网易接口拉取；
// 分享走 ?mix= 内容链、下载走服务端镜像
export function isLocalPlaylistId(id) {
  const s = String(id ?? '');
  return s.startsWith(SINGLE_SONG_PREFIX) || s.startsWith(SAVED_QUEUE_PREFIX) || s.startsWith(LOCAL_PLAYLIST_PREFIX);
}

// 播放上下文物件判定：single_song_/saved_queue_ 前缀的单是「播放行为的产物」
// （分享壳/队列快照），底栏据此禁用随机等歌单级操作
export function isEphemeralPlaylistId(id) {
  const s = String(id ?? '');
  return s.startsWith(SINGLE_SONG_PREFIX) || s.startsWith(SAVED_QUEUE_PREFIX);
}

// 单曲分享壳——只装一首分享曲的容器，不提供歌单级分享/下载入口
export function isSingleSongShellId(id) {
  return String(id ?? '').startsWith(SINGLE_SONG_PREFIX);
}

// ── 数值 id 解析 ──
// 路由 :id 参数统一校验：只收纯十进制——Number() 会放过 '1e5'/'0x10'/' 3 '
// 这类脏输入，parseInt 又会截断 '12abc'，两者都得拦
export function parseNumericId(raw) {
  if (!NETEASE_ID_RE.test(String(raw ?? ''))) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// ── Bilibili ──
// 收藏夹链接识别（先于 isBilibiliInput 判定——favlist URL 也含 bilibili.com，
// 顺序错了会被单曲导入抢走）：space.bilibili.com/<uid>/favlist?fid=N、
// bilibili.com/medialist/(detail|play)/mlN、/list/mlN 连播页、整串裸写 mlN。
// fid= 必须跟在 favlist 语境后——通用 fid 参数（微博等）不该被抢；
// 裸 mlN 只认整串形态，混在句子里的是普通文本
export function extractBiliFavlistId(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  // 裸 mlN 收 6+ 位——真实 ml id ~10 位；3-5 位的 mlN 更像型号/缩写搜索词
  if (/^ml(\d{6,})$/i.test(s)) return s.slice(2);
  // URL 形态限 B 站域——别站的 favlist/fid 参数不该被抢
  if (!/bilibili\.com/i.test(s)) return null;
  return s.match(/favlist[^ ]*?\bfid=(\d+)/i)?.[1]
    // medialist detail/play 页 + /list/mlN 连播页（canonical 形态）
    || s.match(/(?:medialist\/(?:detail|play)|list)\/ml(\d+)/i)?.[1]
    || null;
}

// B 站输入识别：BV 号、av 号、bilibili.com/b23.tv/bili2233.cn 链接。\b 词边界防长 token 误吞
export function isBilibiliInput(input) {
  const s = String(input || '');
  // QQ 链接/载荷里的 songmid 理论可呈 BV1xxxxxxxxx 形态——域/scheme 前置
  // 排除防撞车（qq.com 任意子域、qqmusic:* scheme 都按 QQ 处理）
  if (/(?:^|[/:.\s'"])(?:[a-z0-9-]+\.)*qq\.com/i.test(s) || /qqmusic[:./]/i.test(s)) return false;
  if (/^qq[:：]/i.test(s.trim())) return false; // qq: 前缀语法专属于 QQ 输入，不给 BV 形 mid 抢走
  return BVID_IN_TEXT_RE.test(s) // 小写 bv 也收下——服务端会校验真实 bvid
    || /bilibili\.com|b23\.tv|bili2233\.cn/i.test(s) // bili2233.cn 是 B 站官方短链族（同 isBiliLinkHost 口径）
    || /(?:^|\/)av\d+/i.test(s);
}

// SourcePicker 直绑行远端解析的收单谓词（GET /unlock/resolve-media 前置闸，
// 前后端共享同一真相源）——比 isBilibiliInput 更紧：
//   - av 只收裸锚形 ^av\d+$：'example.com/av123'/'foo?av=1' 这类非 B 站语境
//     不误送远端解析（错绑比拒绑代价大）——顶栏宽支是既有行为不跟收
//   - 域支带边界类 (?:^|[^a-zA-Z0-9-])：'notbilibili.com/x'、'xb23.tv/x' 不
//     误捕；'.' 不在排除集内，'www.bilibili.com'/'sub.b23.tv' 子域照常过
//   - qq 系前置排除与 isBilibiliInput 同口径（'qq:av1' 不误送）
//   - 裸 BVID 支收入（直调 API 完备性；客户端 BV 在本地支先行拦截，
//     本谓词的 BVID 支只服务直调）
export const isBiliDirectBindInput = (s) => {
  if (typeof s !== 'string' || !s) return false;
  if (/^https?:\/\/[^/]*qq\.com/i.test(s) || /^qqmusic:\/\//i.test(s) || /^qq:/i.test(s)) return false;
  return BVID_RE.test(s) || /^av\d+$/i.test(s)
    || /(?:^|[^a-zA-Z0-9-])(?:b23\.tv|bili2233\.cn)\//i.test(s)
    || /(?:^|[^a-zA-Z0-9-])bilibili\.com\//i.test(s);
};

// ── YouTube ──
// URL 形态表（顺序敏感）——裸 11 位 id 不进本表（与搜索关键词天然歧义，
// `lofi1234567` 这类 11 位词会被误当 videoId 劫持进导入流程）
const YT_URL_RES = [
  /(?:youtube(?:-nocookie)?\.com|music\.youtube\.com)\/(?:watch\?[^ ]*?\bv=|shorts\/|embed\/|live\/|v\/)([A-Za-z0-9_-]{11})/i,
  /youtu\.be\/([A-Za-z0-9_-]{11})/i,
  /[?&]yt=([A-Za-z0-9_-]{11})/i,
];

// 歌单链接识别（先于 isYouTubeInput 判——watch?v=&list= 复合链的播放单
// 语境更具体，与 favlist 先于视频同口径）：/playlist?list=、watch 带的
// &list=、youtu.be/X?list=。URL 形态限 YouTube 域；裸写只收已知前缀
// （PL/UU/RD/OLAK5uy_ 等，≥11 位后缀——短形态更像搜索词不抢）
export function extractYouTubePlaylistId(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  // 裸形态不带 /i——真实 listId 前缀恒大写，放行小写会把
  // 'tldr-weekly-01' 型 ≥13 位搜索词劫进歌单导入
  if (/^(?:PL|UU|RD|LL|FL|TL|OLAK5uy_)[A-Za-z0-9_-]{11,60}$/.test(s)) return s;
  if (!/(?:youtube(?:-nocookie)?\.com|youtu\.be|music\.youtube\.com)/i.test(s)) return null;
  // URL 分支同样要求 ≥13 位——与路由 /youtube/playlist 的 {13,80} 闸对齐，
  // 短 list 值（如 watch?v=x&list=RD 残参）解出来也会被路由拒，不如不抢
  return s.match(/[?&]list=([A-Za-z0-9_-]{13,80})/i)?.[1] || null;
}

// YouTube 视频 id 提取：URL 形态 + 裸 11 位 id（须含非数字，纯数字与网易云 id 撞型）
export function extractYouTubeId(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  for (const re of YT_URL_RES) {
    const m = s.match(re);
    if (m) return m[1];
  }
  return (YT_ID_RE.test(s) && /\D/.test(s)) ? s : null;
}

// YouTube 输入识别：只认无歧义的 URL 形态；裸 id 输入走正常搜索，
// 想用裸 id 可以拼 youtu.be/<id>
export function isYouTubeInput(input) {
  const s = String(input || '').trim();
  return !!s && YT_URL_RES.some(re => re.test(s));
}

// ── QQ 音乐 ──
// QQ 单曲输入识别：只认无歧义形态——y.qq.com 系链接（含 c.y.qq.com 短链）、
// ?qq= 本站还原链、qqmusic:// 协议、songid 参数。裸 songmid/disstid 与关键词/
// 网易云 id 同型歧义，裸串一律走正常搜索。
// 注意 qq: 是点歌台「QQ 曲库搜索」前缀不是歌曲链接——收进 URL_RES 会让
// qq:<10-20位字母数字关键词>被劫持去 resolve
const QQ_SONG_URL_RES = [
  /songmid=([0-9A-Za-z]{10,20})/i,
  /songDetail\/([0-9A-Za-z]{10,20})/i,
  /qq\.com\/[^ ]*?\/song\/([0-9A-Za-z]{10,20})\.html/i,
  /[?&]qq=([0-9A-Za-z]{10,20})/i,
  /[?&]songid=(\d+)/i,
];

export function isQQInput(input) {
  const s = String(input || '').trim();
  if (!s) return false;
  if (extractQQPlaylistId(s)) return false; // 歌单链接走歌单导入分支，不进单曲导入
  return QQ_SONG_URL_RES.some(re => re.test(s)) || /qqmusic:\/\//i.test(s)
    || /^(?:https?:\/\/)?(?:[a-z0-9]+\.)*y\.qq\.com\//i.test(s);
}

// p=%7B...%7D 编码 JSON 载荷解码回明文——songmid/disstid 正则吃的是字面量。
// 只动追加副本：原 href 保持原样，避免解码产物干扰其它参数判定
function withDecodedPayload(href) {
  const pEnc = String(href).match(/[?&]p=([^&]+)/i)?.[1];
  if (pEnc && /%[0-9a-f]{2}/i.test(pEnc)) {
    try { return href + '&' + decodeURIComponent(pEnc); } catch { /* 残缺编码不致命 */ }
  }
  return href;
}

// QQ 歌单识别：y.qq.com/n/ryqq[_v2]/playlist/<disstid>、分享页 taoge.html?id=、
// ?disstid=N / p={"disstid":"N"} 编码载荷（与 pickQqFromUrl 同口径，防前端把
// 歌单链误判成单曲送去 resolve 再被 400 弹回的死循环）
export function extractQQPlaylistId(input) {
  let s = String(input || '').trim();
  if (!/(?:y\.qq\.com|qq\.com|qqmusic)/i.test(s)) return null;
  s = withDecodedPayload(s);
  return s.match(/\/playlist\/(\d+)/i)?.[1]
    || s.match(/taoge\.html[^ ]*?[?&]id=(\d+)/i)?.[1]
    || s.match(/playlist\?[^ ]*?\bid=(\d+)/i)?.[1]  // qqmusic://qq.com/playlist?id=N
    || s.match(/\bdisstid["']?\s*[:=]\s*["']?(\d+)/i)?.[1]
    || null;
}

// 分享链接解析：提取 songmid/songid/disstid/albummid（服务端 c.y.qq.com 短链
// 逐跳跟随前先用本表扫每个 hop 的 URL；前端 ?qq=/songmid= 分享还原也用同表）
export function pickQqFromUrl(href) {
  // p= 编码 JSON 载荷先解码（与 extractQQPlaylistId 共用同一帮手）
  href = withDecodedPayload(href);
  // 歌单形态先于 mid：playlist?id=N&p={"songmid":"x"} 这类链接语义是歌单，
  // 内嵌 songmid 是载体噪音——先解出单曲等于把歌单丢成一首。
  // \b 左边界：xdisstid/subdisstid 这类参数名前缀不得误吃
  const diss = href.match(/taoge\.html\?[^#]*?\bid=(\d+)/i)?.[1]
    || href.match(/\/playlist\/(\d+)/i)?.[1]
    || href.match(/playlist\?[^ ]*?\bid=(\d+)/i)?.[1]  // qqmusic://qq.com/playlist?id=N
    || href.match(/\bdisstid["']?\s*[:=]\s*["']?(\d+)/i)?.[1];  // ?disstid=N 或 p={"disstid":"N"}
  if (diss) return { disstid: diss };
  // ?qq=<mid> 是本站分享链形态——与 ?yt= 同口径也在这里收
  const mid = href.match(/[?&]qq=([0-9A-Za-z]{10,20})/i)?.[1]
    || href.match(/songmid=([0-9A-Za-z]{10,20})/i)?.[1]
    || href.match(/songDetail\/([0-9A-Za-z]{10,20})/i)?.[1]
    || href.match(/\/song\/([0-9A-Za-z]{10,20})\.html/i)?.[1]
    || href.match(/["']?songmid["']?\s*:\s*["']([0-9A-Za-z]{10,20})/i)?.[1];  // qqmusic://...?p={"songmid":"x"}
  if (mid) return { mid };
  const songid = href.match(/\bsongid["']?\s*[=:]\s*["']?(\d+)/i)?.[1];  // songid=N 或 {"songid":"N"}
  if (songid) return { songid };
  const albummid = href.match(/albumDetail\/([0-9A-Za-z]{10,20})/i)?.[1];
  if (albummid) return { albummid };
  return null;
}

// 注：服务端短链跳解的宿主白名单（*.y.qq.com）比本表刻意更窄——SSRF 防线
// 不放宽进共享层，留在 server/lib/qq.js:isQqLinkHost。

// 网易云歌单判定：纯数字 id（PlaylistPanel 等）
export function isNeteasePlaylist(playlist) {
  return NETEASE_ID_RE.test(String(playlist?.id ?? ''));
}

// ── 歌词语言判定 ──
// 「已是中文语境」判定：汉字占比≥阈值只是必要非充分——真中文词假名/谚文≈0；
// 日文词汉字密度 30-50% 是常态，只看汉字占比会把日文误判成中文跳过翻译
// （少女レイ 实案：词文 CJK 占比 0.365 被 already-zh 跳掉）。
// 假名/谚文存在即「需要翻译」的硬证据；拉丁文不构成豁免（中文歌夹英文 hook
// 仍算中文语境）。分母只计四类字母字符——数字/标点/空白不稀释判定
export function isLikelyChineseLyric(text, { cjkMin = 0.3, foreignMax = 0.05 } = {}) {
  const s = String(text ?? '');
  // 四类字符计数口径：汉字 CJK 统一表意+扩展 A、假名 全角块 ぀-ヿ ∪
  // 半角片假名 ｦ-ﾟ（U+FF66-FF9F——假名本体止于 ﾝ/FF9D，尾部 ﾞﾟ
  // 半角浊点同为日语硬证据一并计；半角形态零中文歧义）、谚文
  // 가-힯（韩文音节块）、拉丁 A-Za-z。残余漏译边如实登记（启发式
  // 固有限度）：々〆 迭代记号、谚文 jamo 字母块、全角拉丁、CJK
  // Ext-B 均不入四类计数——带这些特征的稀有文本会漏判，可接受
  const cjk = (s.match(/[一-鿿㐀-䶿]/g) || []).length;
  const kana = (s.match(/[぀-ヿｦ-ﾟ]/g) || []).length;
  const hangul = (s.match(/[가-힯]/g) || []).length;
  const latin = (s.match(/[A-Za-z]/g) || []).length;
  const total = cjk + latin + kana + hangul;
  if (!total) return false;
  return cjk / total >= cjkMin && (kana + hangul) / total < foreignMax;
}

// ── 网易云 ──
// 网易云歌曲 id 提取：music.163.com/song?id= / song/N / ?song=N / 裸数字
export function extractNeteaseSongId(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  // song\? 吃掉字面 ? 后接 \bid=——id 是首参（song?id=N）或非首参（song?x=1&id=N）
  // 都命中；不要再要求第二个 [?&]，否则主流形式全灭退回关键词搜索
  const m = s.match(/song\?[^ ]*?\bid=(\d+)/i)        // music.163.com/[#/]song?id=N
    || s.match(/\/song\/(\d+)/i)                      // .../song/N
    || s.match(/[?&]song=(\d+)/i);                    // 本站 ?song=N 分享链
  if (m) return m[1];
  return NETEASE_ID_RE.test(s) ? s : null;
}

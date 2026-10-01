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

// 本地歌单 id 前缀族
// - single_song_*：单曲分享临时壳
// - saved_queue_*：待播队列存成的歌单
// - local_pl_*：用户手动歌单（含 mix 导入的 local_pl_mix_*）
export const SINGLE_SONG_PREFIX = 'single_song_';
export const SAVED_QUEUE_PREFIX = 'saved_queue_';
export const LOCAL_PLAYLIST_PREFIX = 'local_pl_';

// 服务端镜像接受面：local_pl_/saved_queue_ + 长度上限（single_song_ 壳不下发镜像）
export const MIRROR_PLAYLIST_ID_RE = /^(local_pl_|saved_queue_)[\w-]{1,64}$/;

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
// B 站输入识别：BV 号、av 号、bilibili.com/b23.tv 链接。\b 词边界防长 token 误吞
export function isBilibiliInput(input) {
  const s = String(input || '');
  // QQ 链接/载荷里的 songmid 理论可呈 BV1xxxxxxxxx 形态——域/scheme 前置
  // 排除防撞车（qq.com 任意子域、qqmusic:* scheme 都按 QQ 处理）
  if (/(?:^|[/:.\s'"])(?:[a-z0-9-]+\.)*qq\.com/i.test(s) || /qqmusic[:./]/i.test(s)) return false;
  if (/^qq[:：]/i.test(s.trim())) return false; // qq: 前缀语法专属于 QQ 输入，不给 BV 形 mid 抢走
  return BVID_IN_TEXT_RE.test(s) // 小写 bv 也收下——服务端会校验真实 bvid
    || /bilibili\.com|b23\.tv/i.test(s)
    || /(?:^|\/)av\d+/i.test(s);
}

// ── YouTube ──
// URL 形态表（顺序敏感）——裸 11 位 id 不进本表（与搜索关键词天然歧义，
// `lofi1234567` 这类 11 位词会被误当 videoId 劫持进导入流程）
const YT_URL_RES = [
  /(?:youtube(?:-nocookie)?\.com|music\.youtube\.com)\/(?:watch\?[^ ]*?\bv=|shorts\/|embed\/|live\/|v\/)([A-Za-z0-9_-]{11})/i,
  /youtu\.be\/([A-Za-z0-9_-]{11})/i,
  /[?&]yt=([A-Za-z0-9_-]{11})/i,
];

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

// QQ 歌单识别：y.qq.com/n/ryqq[_v2]/playlist/<disstid>、分享页 taoge.html?id=
export function extractQQPlaylistId(input) {
  const s = String(input || '').trim();
  if (!/(?:y\.qq\.com|qq\.com|qqmusic)/i.test(s)) return null;
  return s.match(/\/playlist\/(\d+)/i)?.[1]
    || s.match(/taoge\.html[^ ]*?[?&]id=(\d+)/i)?.[1]
    || s.match(/playlist\?[^ ]*?\bid=(\d+)/i)?.[1]  // qqmusic://qq.com/playlist?id=N
    || s.match(/[?&]disstid=(\d+)/i)?.[1]
    || null;
}

// 分享链接解析：提取 songmid/songid/disstid/albummid（服务端 c.y.qq.com 短链
// 逐跳跟随前先用本表扫每个 hop 的 URL；前端 ?qq=/songmid= 分享还原也用同表）
export function pickQqFromUrl(href) {
  // p=%7B...%7D 编码 JSON 载荷先解码回明文——songmid/disstid 正则吃的是字面量
  const pEnc = href.match(/[?&]p=([^&]+)/i)?.[1];
  if (pEnc && /%[0-9a-f]{2}/i.test(pEnc)) {
    try { href += '&' + decodeURIComponent(pEnc); } catch { /* 残缺编码不致命 */ }
  }
  // 歌单形态先于 mid：playlist?id=N&p={"songmid":"x"} 这类链接语义是歌单，
  // 内嵌 songmid 是载体噪音——先解出单曲等于把歌单丢成一首
  const diss = href.match(/taoge\.html\?[^#]*?\bid=(\d+)/i)?.[1]
    || href.match(/\/playlist\/(\d+)/i)?.[1]
    || href.match(/playlist\?[^ ]*?\bid=(\d+)/i)?.[1]  // qqmusic://qq.com/playlist?id=N
    || href.match(/["']?disstid["']?\s*[:=]\s*["']?(\d+)/i)?.[1];  // ?disstid=N 或 p={"disstid":"N"}
  if (diss) return { disstid: diss };
  // ?qq=<mid> 是本站分享链形态——与 ?yt= 同口径也在这里收
  const mid = href.match(/[?&]qq=([0-9A-Za-z]{10,20})/i)?.[1]
    || href.match(/songmid=([0-9A-Za-z]{10,20})/i)?.[1]
    || href.match(/songDetail\/([0-9A-Za-z]{10,20})/i)?.[1]
    || href.match(/\/song\/([0-9A-Za-z]{10,20})\.html/i)?.[1]
    || href.match(/["']?songmid["']?\s*:\s*["']([0-9A-Za-z]{10,20})/i)?.[1];  // qqmusic://...?p={"songmid":"x"}
  if (mid) return { mid };
  const songid = href.match(/songid=(\d+)/i)?.[1];
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

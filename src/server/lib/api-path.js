// 「这是 API 请求吗」唯一判定源：authGate（公开白名单）与 SPA 兜底
// （不喂 index.html）共用同一份分类，防两处漂移。
// /:apiName 网关背后是 ALLOWED_APIS 白名单 + 自研端点表（apiModules，
// 17 名）——反向枚举黑名单必漏，只有正向判定可靠。
const PREFIXES = [
  '/downloads', '/playlists', '/audio-proxy', '/img-proxy', '/remote',
  '/ping', '/healthz', '/bilibili', '/youtube', '/qq',
  '/song-meta', '/ai', '/auth', '/uploads', '/settings', '/match', '/lyric-align',
  '/sync'
];

// 已摘除的上游路由家族首段——历史上这些是 API（JSON 404/鉴权），摘除后若不
// 收口会被判成非 API 公开 GET → SPA 兜底 200 回 index.html，探测方会把
// HTML 当成功响应。正向列入恢复「API 路径」语义：不命中路由表则 JSON 404
const LEGACY_API_SEGMENTS = new Set([
  'login', 'register', 'captcha', 'cellphone', 'user', 'users',
  'dj', 'mv', 'comment', 'like', 'resource', 'daily_signin',
  'playlist', 'artist', 'cloud', 'msg', 'topic', 'video',
  'fm_trash', 'event', 'program', 'scrobble', 'send', 'states',
  'history', 'nickname', 'playmode', 'recent', 'related', 'listen',
]);

let apiFirstSegments = null;
function firstSegments() {
  if (!apiFirstSegments) {
    // 懒加载：music routes ↔ netease-api 依赖较重，启动路径能晚则晚
    const musicRoutes = require('../routes/music');
    const { apiModules } = require('../services/netease-api');
    apiFirstSegments = new Set(
      [...(musicRoutes.ALLOWED_APIS || []), ...Object.keys(apiModules)]
        .map(s => s.toLowerCase())
    );
  }
  return apiFirstSegments;
}

// 小写归一：/Downloads/x、/Song_url/x 这类大小写变体同样是 API
function isApiPath(pathname) {
  const lower = String(pathname || '').toLowerCase();
  if (PREFIXES.some(px => lower === px || lower.startsWith(px + '/'))) return true;
  const firstSegment = (lower.split('/')[1] || '');
  return firstSegments().has(firstSegment) || LEGACY_API_SEGMENTS.has(firstSegment);
}

module.exports = { isApiPath, API_PREFIXES: PREFIXES };

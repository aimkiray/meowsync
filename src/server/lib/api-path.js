// 「这是 API 请求吗」唯一判定源：authGate（公开白名单）与 SPA 兜底
// （不喂 index.html）共用同一份分类，防两处漂移。
// /:apiName 网关背后是 ALLOWED_APIS 白名单 + 自研端点表（apiModules，
// 17 名）——反向枚举黑名单必漏，只有正向判定可靠。
const PREFIXES = [
  '/downloads', '/playlists', '/audio-proxy', '/remote',
  '/ping', '/healthz', '/bilibili', '/youtube', '/qq',
  '/song-meta', '/ai', '/auth'
];

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
  return firstSegments().has(firstSegment);
}

module.exports = { isApiPath, API_PREFIXES: PREFIXES };

// 进站大门：session cookie 优先，x-download-token 作 API 客户端旁路。
// users 表空 → 全放行（向后兼容现有局域网无登录部署——与 DOWNLOAD_TOKEN
// 「未配即开放」同口径；公网部署请完成 /auth/setup）。
// 注册顺序见 netease-api-server.js：cors → 本中间件 → 静态 → 路由。
const crypto = require('crypto');
const { isApiPath } = require('./api-path');
const { corsOrigins } = require('./env');
const { fail } = require('./http-error');
const usersRepo = require('../repositories/users');
const sessionsRepo = require('../repositories/sessions');
const { tokenMatches } = require('./token-eq');

const COOKIE_NAME = 'ms_session';
const PUBLIC_PREFIXES = ['/auth', '/ping', '/healthz'];
// vault token 本身就是能力凭证（mint 入口已全部在门内）——分享出去的播放
// 地址对未登录者仍有效，这是 stream-vault 的设计意图
const PUBLIC_GET_PREFIXES = ['/audio-proxy/t/'];

function isPublic(c) {
  const m = c.req.method;
  if (m === 'OPTIONS') return true; // CORS 预检无凭据
  const p = c.req.path;
  if (PUBLIC_PREFIXES.some(x => p === x || p.startsWith(x + '/'))) return true;
  if ((m === 'GET' || m === 'HEAD')
    && PUBLIC_GET_PREFIXES.some(x => p.startsWith(x))) return true;
  // 非 API 的 GET/HEAD = 静态资源/SPA 壳——登录页本身也要能渲染
  if ((m === 'GET' || m === 'HEAD') && !isApiPath(p)) return true;
  return false;
}

function sessionFromCookieHeader(cookieHeader) {
  const raw = String(cookieHeader || '').split(';')
    .map(s => s.trim())
    .find(s => s.startsWith(COOKIE_NAME + '='))
    ?.slice(COOKIE_NAME.length + 1);
  if (!raw) return null;
  let token = raw;
  try { token = decodeURIComponent(raw); } catch { /* 原样用 */ }
  return sessionsRepo.resolveSession(token);
}

const downloadTokenHash = process.env.DOWNLOAD_TOKEN
  ? crypto.createHash('sha256').update(process.env.DOWNLOAD_TOKEN).digest()
  : null;

// CSRF：cookie 自动携带使跨站表单/脚本天然带上登录态。写请求且 Origin 存在时
// 必须同源（Origin.host === Host）或命中 CORS 白名单；Origin 缺失放行
// （非浏览器客户端不发——它们也拿不到 cookie，不在 CSRF 威胁模型里；
// 浏览器跨站 POST/fetch 必发 Origin，SameSite=Lax 兜住剩余表单场景）。
// auth.js 的 POST 检查与这里共用本函数——两处口径漂移=一处放行绕过
function csrfOriginOk(c) {
  const origin = c.req.header('origin');
  if (!origin) return true;
  try {
    const o = new URL(origin);
    const proto = o.protocol === 'http:' || o.protocol === 'https:';
    return (proto && o.host === new URL(c.req.url).host) || corsOrigins().includes(o.origin);
  } catch {
    return false;
  }
}

async function authGate(c, next) {
  if (isPublic(c)) return next();
  if (!authEnabled()) return next(); // 未启用登录：全放行
  const sess = sessionFromCookieHeader(c.req.header('cookie'));
  if (sess) {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.method !== 'OPTIONS'
      && !csrfOriginOk(c)) {
      return fail(c, 403, 'Forbidden');
    }
    c.set('user', sess);
    return next();
  }
  // x-download-token 降级为「服务对服务/脚本」旁路凭据——浏览器不再需要
  // 构建期注入 VITE_DOWNLOAD_TOKEN（bundle 内嵌等于向全体访客发口令）
  if (downloadTokenHash) {
    const provided = crypto.createHash('sha256')
      .update(c.req.header('x-download-token') || '').digest();
    if (crypto.timingSafeEqual(provided, downloadTokenHash)) return next();
  }
  return c.json({ code: 401, message: '未登录' }, 401);
}

// 登录启用态：users 空表 = 未启用（authGate 与 WS 共用同一判定，防两边漂移）
function authEnabled() {
  return usersRepo.countUsers() > 0;
}

module.exports = { authGate, sessionFromCookieHeader, csrfOriginOk, COOKIE_NAME, authEnabled };

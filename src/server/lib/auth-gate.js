// 进站大门：session cookie 优先，x-download-token 作 API 客户端旁路。
// users 表空 → 全放行（向后兼容现有局域网无登录部署——与 DOWNLOAD_TOKEN
// 「未配即开放」同口径；公网部署请完成 /auth/setup）。
// 注册顺序见 server.js：cors → 本中间件 → compress → 静态 → 路由。
const { isApiPath } = require('./api-path');
const { corsOrigins, trustProxyEnabled } = require('./env');
const { fail } = require('./http-error');
const { rateLimit } = require('./rate-limit');
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

// cookie 内裸 token 切分（独立导出，勿再抄第三份）：sync.js 的读/写路径
// 要拿裸 token 自选会话解析器（pull 用 peekSession 纯读、push 用
// resolveSession 滑动续期）；本函数只做提取不解会话
function sessionTokenFromCookie(cookieHeader) {
  const raw = String(cookieHeader || '').split(';')
    .map(s => s.trim())
    .find(s => s.startsWith(COOKIE_NAME + '='))
    ?.slice(COOKIE_NAME.length + 1);
  if (!raw) return null;
  try { return decodeURIComponent(raw); } catch { return raw; /* 原样用 */ }
}

function sessionFromCookieHeader(cookieHeader) {
  const token = sessionTokenFromCookie(cookieHeader);
  return token ? sessionsRepo.resolveSession(token) : null;
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
    await next();
    // 登录态 API 响应禁缓存——CDN/共享缓存不得回放带会话语义的 200
    if (!c.res.headers.has('Cache-Control')) c.res.headers.set('Cache-Control', 'no-store');
    return;
  }
  // DOWNLOAD_TOKEN = 服务对服务/脚本的全量 API 旁路凭据（含 GET）——命中即过门。
  // 浏览器不再需要构建期注入 VITE_DOWNLOAD_TOKEN（bundle 内嵌等于向全体访客
  // 发口令）。懒读 env 而非启动快照——与 env.js 「不拿陈值」承诺同口径
  if (tokenMatches(c.req.header('x-download-token'), process.env.DOWNLOAD_TOKEN)) {
    return next();
  }
  // 提供了旁路头但错配——per-IP 失败记账：旁路猜测此前零成本（对照 WS
  // 未认证握手 20/min 收紧桶，30/min 对齐量级）。未带头不记账：无凭据
  // 请求走下方正常 401 面，不吃这个桶
  if (c.req.header('x-download-token') !== undefined
    && !rateLimit(c, 'dl-token', 30)) {
    return fail(c, 429, 'Too Many Requests');
  }
  // x-ms-auth 标记：前端拦截器只认本头踢门——上游透传的裸 401 不误触发登出
  c.header('X-Ms-Auth', 'required');
  c.header('Cache-Control', 'no-store');
  return c.json({ code: 401, message: '未登录' }, 401);
}

// CSRF：cookie 自动携带使跨站表单/脚本天然带上登录态。写请求且 Origin 存在时
// 必须同源（Origin.host === 请求有效 host）或命中 CORS 白名单；Origin 缺失放行
// （非浏览器客户端不发——它们也拿不到 cookie，不在 CSRF 威胁模型里；
// 浏览器跨站 POST/fetch 必发 Origin，SameSite=Lax 兜住剩余表单场景）。
// 「有效 host」与 WS 同源判定同口径：TRUST_PROXY 下先取 X-Forwarded-Host——
// 反代把 Host 重写成内部地址时，只比 Host 会把自家前端的 Origin 也误判成异源
// auth.js 的 POST 检查与这里共用本函数——两处口径漂移=一处放行绕过
function csrfOriginOk(c) {
  const origin = c.req.header('origin');
  if (!origin) {
    // Origin 缺失放行（非浏览器客户端不发）。二级纵深：现代浏览器
    // 跨站写必带 Sec-Fetch-Site: cross-site——Origin 被代理剥掉的
    // 链路里这道信号仍能拦下跨站写（login CSRF 残面）
    const sfs = (c.req.header('sec-fetch-site') || '').toLowerCase();
    if (sfs === 'cross-site') return false;
    return true;
  }
  try {
    const o = new URL(origin);
    const proto = o.protocol === 'http:' || o.protocol === 'https:';
    const host = (trustProxyEnabled()
      && (c.req.header('x-forwarded-host') || '').split(',')[0].trim())
      || c.req.header('host') || '';
    return (proto && host && o.host.toLowerCase() === host.toLowerCase())
      || corsOrigins().includes(o.origin);
  } catch {
    return false;
  }
}

// 登录启用态：users 空表 = 未启用（authGate 与 WS 共用同一判定，防两边漂移）
function authEnabled() {
  return usersRepo.countUsers() > 0;
}

module.exports = { authGate, sessionFromCookieHeader, sessionTokenFromCookie, csrfOriginOk, COOKIE_NAME, authEnabled };

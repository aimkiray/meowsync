// 登录体系路由：status（探活/引导判定）、setup（首启建号，仅空 users 表）、
// login/logout/me。会话 = sqlite opaque token + HttpOnly cookie。
// 防护：per-IP + per-account 双键限流；用户不存在也跑完整 KDF（恒时间防枚举）；
// POST 校验 Origin（cookie 会话的 CSRF 纵深——SameSite=Lax 之外的兜底）。
const { Hono } = require('hono');
const { getCookie, setCookie, deleteCookie } = require('hono/cookie');
const { fail } = require('../lib/http-error');
const { parseJsonBody } = require('../lib/validate');
const { authCredentialsBody } = require('../../shared/contracts.js');
const { rateLimit, rateLimitByKey } = require('../lib/rate-limit');
const { trustProxyEnabled } = require('../lib/env');
// CSRF 判定与 authGate 同一份实现——login/setup 是公开路由，authGate 的
// 写请求 Origin 校验不会覆盖它们，必须各自在路由内显式调用同一函数
const { csrfOriginOk } = require('../lib/auth-gate');
const usersRepo = require('../repositories/users');
const sessionsRepo = require('../repositories/sessions');
const { hashPassword, verifyPassword, needsRehash, getDummyHash } = require('../lib/password');

const app = new Hono();
const COOKIE_NAME = 'ms_session';
const SESSION_COOKIE_AGE_S = Math.floor(sessionsRepo.ABSOLUTE_TTL_MS / 1000);

function requestIsHttps(c) {
  if (trustProxyEnabled()) {
    const fwd = c.req.header('x-forwarded-proto');
    if (fwd) return fwd.split(',')[0].trim() === 'https';
  }
  return new URL(c.req.url).protocol === 'https:';
}

function clientIp(c) {
  const trustProxy = trustProxyEnabled();
  return (trustProxy && c.req.header('x-forwarded-for')?.split(',')[0]?.trim())
    || c.env?.incoming?.socket?.remoteAddress
    || 'local';
}

function setSessionCookie(c, rawToken) {
  setCookie(c, COOKIE_NAME, rawToken, {
    httpOnly: true, sameSite: 'Lax', path: '/',
    // Secure 按请求协议动态：自托管常跑 http://局域网，恒 Secure 会让 cookie
    // 根本写不进去；公网经反代 HTTPS 时 TRUST_PROXY 给出真实协议
    secure: requestIsHttps(c),
    maxAge: SESSION_COOKIE_AGE_S
  });
}

// 探活：前端首屏分流依据。永远 200——authenticated/username/setupRequired
// 三个字段足够前端决定渲染登录页、建号页还是直接进应用
app.get('/auth/status', (c) => {
  c.header('Cache-Control', 'no-store');
  const authEnabled = usersRepo.countUsers() > 0;
  const raw = getCookie(c, COOKIE_NAME);
  const sess = authEnabled && raw ? sessionsRepo.resolveSession(raw) : null;
  return c.json({
    code: 200,
    data: {
      authEnabled,
      setupRequired: !authEnabled,
      authenticated: !!sess,
      username: sess?.username || null
    }
  });
});

// 首启建号：仅空 users 表。count 复查在写库事务内（TOCTOU），并发双 setup
// 由 UNIQUE(username) 兜底——负方 409。建号即登录
app.post('/auth/setup', async (c) => {
  if (!csrfOriginOk(c)) {
    return fail(c, 403, '非法请求来源');
  }
  if (!rateLimit(c, 'auth-setup', 5)) {
    return fail(c, 429, '请求太频繁，稍后再试');
  }
  const { data: body, error } = await parseJsonBody(c, authCredentialsBody, 8 * 1024);
  if (error) return error;
  if (usersRepo.countUsers() > 0) {
    return fail(c, 409, '管理员已存在，请直接登录');
  }
  const passwordHash = await hashPassword(body.password);
  // 复查必须在 insert 前的同步窗口内——better-sqlite3 调用同步执行，
  // count→insert 之间不夹 await 才构成真正的原子临界区；
  // 夹在中间的 hashPassword 是异步的，会让并发 setup 双双越过前置检查
  if (usersRepo.countUsers() > 0) {
    return fail(c, 409, '管理员已存在，请直接登录');
  }
  let user;
  try {
    user = usersRepo.createUser(body.username.trim(), passwordHash, 'admin');
  } catch {
    // UNIQUE 冲突——并发 setup 的负方
    return fail(c, 409, '管理员已存在，请直接登录');
  }
  console.log(`[auth] 管理员 '${user.username}' 已创建（首个用户，登录体系启用）`);
  const raw = sessionsRepo.createSession(user.id, {
    ip: clientIp(c), userAgent: c.req.header('user-agent') || ''
  });
  setSessionCookie(c, raw);
  c.header('Cache-Control', 'no-store');
  return c.json({ code: 200, data: { username: user.username } });
});

app.post('/auth/login', async (c) => {
  if (!csrfOriginOk(c)) {
    return fail(c, 403, '非法请求来源');
  }
  const { data: body, error } = await parseJsonBody(c, authCredentialsBody, 8 * 1024);
  if (error) return error;
  // 双键限流：per-IP 防扫多号，per-account 防换 IP 喷单号
  if (!rateLimitByKey(`auth-login:ip:${clientIp(c)}`, 20, 10 * 60 * 1000)
    || !rateLimitByKey(`auth-login:acct:${body.username.toLowerCase()}`, 8, 10 * 60 * 1000)) {
    return fail(c, 429, '尝试太频繁，请 10 分钟后再试');
  }
  const user = usersRepo.findByUsername(body.username.trim());
  // 用户不存在也对 dummy hash 跑完整校验——「用户不存在」与「密码错误」
  // 在响应文案和时序上都必须不可区分
  const stored = user ? user.password_hash : await getDummyHash();
  const ok = await verifyPassword(body.password, stored);
  if (!user || !ok) {
    console.warn(`[auth] 登录失败 user=${body.username} ip=${clientIp(c)}`);
    return fail(c, 401, '用户名或密码错误');
  }
  // 参数落后基线的旧 hash 透明升档
  if (needsRehash(user.password_hash)) {
    hashPassword(body.password)
      .then(h => usersRepo.updatePasswordHash(user.id, h))
      .catch(() => { /* 升档失败不阻塞登录 */ });
  }
  const raw = sessionsRepo.createSession(user.id, {
    ip: clientIp(c), userAgent: c.req.header('user-agent') || ''
  });
  setSessionCookie(c, raw);
  c.header('Cache-Control', 'no-store');
  return c.json({ code: 200, data: { username: user.username } });
});

app.post('/auth/logout', (c) => {
  const raw = getCookie(c, COOKIE_NAME);
  if (raw) sessionsRepo.deleteSession(raw);
  deleteCookie(c, COOKIE_NAME, { path: '/' });
  c.header('Cache-Control', 'no-store');
  return c.json({ code: 200 });
});

// 当前会话（前端轮询/页内校验用）
app.get('/auth/me', (c) => {
  c.header('Cache-Control', 'no-store');
  const raw = getCookie(c, COOKIE_NAME);
  const sess = raw ? sessionsRepo.resolveSession(raw) : null;
  if (!sess) return fail(c, 401, '未登录');
  return c.json({ code: 200, data: { username: sess.username, role: sess.role } });
});

module.exports = app;
module.exports.COOKIE_NAME = COOKIE_NAME;
module.exports.sessionsRepo = sessionsRepo;
module.exports.usersRepo = usersRepo;

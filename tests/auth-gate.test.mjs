// authGate 中间件本体矩阵：users 空表放行 / 启用登录后的 401+标记头 /
// 会话 cookie 的 CSRF 同源写 / x-download-token 旁路 / 公开前缀。
// 单测层只覆盖过 csrfOriginOk 纯函数——这里是真 Hono 挂载的端到端钉板。
// DATA_DIR 隔离 + 真 users/sessions repo（空表判定吃真 count）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-authgate-');
const require = createRequire(import.meta.url);

let authGate, usersRepo, sessionsRepo, app;
before(() => {
  const { Hono } = require('hono');
  authGate = require('../src/server/lib/auth-gate.js');
  usersRepo = require('../src/server/repositories/users.js');
  sessionsRepo = require('../src/server/repositories/sessions.js');

  app = new Hono();
  app.use('*', authGate.authGate);
  // 探针路由：API 前缀路径（走鉴权）、/auth/*（公开前缀）、/assets/*（非 API GET）
  app.get('/downloads/probe', (c) => c.json({ code: 200, user: c.get('user')?.username ?? null }));
  app.post('/downloads/probe', (c) => c.json({ code: 200, user: c.get('user')?.username ?? null }));
  app.get('/auth/status', (c) => c.json({ code: 200 }));
  app.get('/assets/app.css', (c) => c.text('css'));
});
after(() => { rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

const api = (path, init = {}) =>
  app.request(`http://localhost${path}`, { headers: { host: 'localhost' }, ...init });

// ── users 空表 = 未启用登录：全放行（默认部署不回归）──

test('authGate：users 空表时 API GET/POST 全放行', async () => {
  assert.equal(usersRepo.countUsers(), 0);
  assert.equal((await api('/downloads/probe')).status, 200);
  assert.equal((await api('/downloads/probe', { method: 'POST' })).status, 200);
});

// ── 启用登录（建号+建会话）后的门径矩阵 ──
// before 钩子先于全部用例执行——空表用例需要真 0 计数，
// 故建号改成首个消费方惰性触发（用例按声明顺序串行）

let cookie;
function ensureAuthEnabled() {
  if (cookie) return;
  const u = usersRepo.createUser('GateAdmin', 'a2id$x', 'admin');
  cookie = `ms_session=${sessionsRepo.createSession(u.id)}`;
}

test('authGate：启用登录后无凭据 API GET/POST → 401 + X-Ms-Auth + no-store', async () => {
  ensureAuthEnabled();
  for (const method of ['GET', 'POST']) {
    const res = await api('/downloads/probe', { method });
    assert.equal(res.status, 401, method);
    assert.equal(res.headers.get('X-Ms-Auth'), 'required');
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.equal((await res.json()).code, 401);
  }
});

test('authGate：合法会话 cookie GET 放行且响应 no-store', async () => {
  ensureAuthEnabled();
  const res = await api('/downloads/probe', { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).user, 'GateAdmin');
  // 登录态 API 响应禁缓存——CDN/共享缓存不得回放带会话语义的 200
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
});

test('authGate：会话 POST——同源 Origin 放行，异源 403', async (t) => {
  ensureAuthEnabled();
  // Host 是 fetch 禁设头——app.request 里 c.req.header('host') 恒空，
  // 同源判定必须起真 HTTP server 让 Host 头自然出现
  const { serve } = require('@hono/node-server');
  const srv = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  t.after(() => srv.close());
  await new Promise(r => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;

  const post = (headers) => fetch(`${base}/downloads/probe`, {
    method: 'POST',
    headers: { cookie, ...headers },
  });

  // 浏览器同源写：Origin（含端口）与 Host 一致
  const same = await post({ origin: base });
  assert.equal(same.status, 200);
  await same.arrayBuffer();

  // 跨站写：Origin host ≠ Host → CSRF 拒
  const evil = await post({ origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  await evil.arrayBuffer();

  // Origin 缺失（非浏览器客户端不带）照常放行
  const noOrigin = await post({});
  assert.equal(noOrigin.status, 200);
  await noOrigin.arrayBuffer();
});

test('authGate：x-download-token 旁路——配对放行，错配/缺失 401', async () => {
  ensureAuthEnabled();
  process.env.DOWNLOAD_TOKEN = 'dt-probe-123';
  try {
    const ok = await api('/downloads/probe', {
      headers: { 'x-download-token': 'dt-probe-123' },
    });
    assert.equal(ok.status, 200);

    const wrong = await api('/downloads/probe', {
      headers: { 'x-download-token': 'dt-nope' },
    });
    assert.equal(wrong.status, 401);

    const missing = await api('/downloads/probe');
    assert.equal(missing.status, 401);
  } finally {
    delete process.env.DOWNLOAD_TOKEN;
  }
});

test('authGate：x-download-token 连错 30 次触发 429——旁路猜测的 per-IP 失败记账', async () => {
  ensureAuthEnabled();
  process.env.DOWNLOAD_TOKEN = 'dt-rate-probe';
  // TRUST_PROXY + 独占 XFF：用独立 IP 起新桶，与其它用例的 'local' 桶隔离
  process.env.TRUST_PROXY = '1';
  try {
    const bad = { 'x-download-token': 'dt-wrong', 'x-forwarded-for': '10.77.7.7' };
    // 错配 1-30：记满 30/min 失败预算，仍回 401
    for (let i = 0; i < 30; i++) {
      const r = await api('/downloads/probe', { headers: bad });
      assert.equal(r.status, 401, `failure #${i + 1}`);
    }
    // 第 31 次：桶满——猜测面收紧成 429
    const over = await api('/downloads/probe', { headers: bad });
    assert.equal(over.status, 429);
    // 正确令牌不吃失败桶——同 IP 上依然放行
    const ok = await api('/downloads/probe', {
      headers: { 'x-download-token': 'dt-rate-probe', 'x-forwarded-for': '10.77.7.7' },
    });
    assert.equal(ok.status, 200);
    // 未提供头不记账——同 IP 无头请求仍走正常 401 面而非 429
    const none = await api('/downloads/probe', {
      headers: { 'x-forwarded-for': '10.77.7.7' },
    });
    assert.equal(none.status, 401);
  } finally {
    delete process.env.DOWNLOAD_TOKEN;
    delete process.env.TRUST_PROXY;
  }
});

test('authGate：公开前缀与非 API GET 始终放行（登录页可渲染）', async () => {
  ensureAuthEnabled();
  assert.equal((await api('/auth/status')).status, 200);
  const assets = await api('/assets/app.css');
  assert.equal(assets.status, 200);
  // 公开 GET 不是登录态响应——不该被强贴 no-store（静态缓存语义保留）
  assert.equal(assets.headers.get('Cache-Control'), null);
  // OPTIONS 预检无凭据放行
  assert.equal((await api('/downloads/probe', { method: 'OPTIONS' })).status, 404);
});

test('authGate：sessionTokenFromCookie 裸 token 提取（URI 解码/缺名/空值）', () => {
  // F6 收敛：sync.js 的读/写路径与 authGate 共用同一提取实现——
  // 提取语义（; 切分/name 前缀匹配/decodeURIComponent 兜底原样）在这里钉死
  assert.equal(authGate.sessionTokenFromCookie('a=1; ms_session=tok%40x; b=2'), 'tok@x');
  assert.equal(authGate.sessionTokenFromCookie('ms_session=plain'), 'plain');
  assert.equal(authGate.sessionTokenFromCookie('ms_session=%E0%A4%A'), '%E0%A4%A'); // 畸形百分号原样
  assert.equal(authGate.sessionTokenFromCookie('ms_other=1'), null);
  assert.equal(authGate.sessionTokenFromCookie(''), null);
  assert.equal(authGate.sessionTokenFromCookie(undefined), null);
});

test('authGate：伪造/被删会话 cookie → 401', async () => {
  ensureAuthEnabled();
  const bogus = await api('/downloads/probe', {
    headers: { cookie: 'ms_session=forged-token' },
  });
  assert.equal(bogus.status, 401);

  // 会话删除后旧 cookie 立即失效
  const u = usersRepo.findByUsername('gateadmin');
  const raw = sessionsRepo.createSession(u.id);
  sessionsRepo.deleteSession(raw);
  const dead = await api('/downloads/probe', {
    headers: { cookie: `ms_session=${raw}` },
  });
  assert.equal(dead.status, 401);
});

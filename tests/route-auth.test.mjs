// routes/auth.js 冒烟：status 探活 / setup 首启建号（仅空表）/ login 双键
// 限流+恒时 / me / logout——全链真库真 KDF。CSRF 的 Origin 判定走
// app.request 可达路径（异源拒）；同源面由 auth-gate.test.mjs 真 server 钉。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-route-auth-');
const require = createRequire(import.meta.url);

let app, usersRepo;
before(() => {
  app = require('../src/server/routes/auth.js');
  usersRepo = require('../src/server/repositories/users.js');
});
after(() => { rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

const json = async (res) => ({ status: res.status, body: await res.json().catch(() => null) });
const post = (path, body, headers = {}) => app.request(`http://t${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];

test('auth：status 空表 → setupRequired + 未认证', async () => {
  const res = await app.request('http://t/auth/status');
  const r = await json(res);
  assert.equal(r.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(r.body.data, {
    authEnabled: false, setupRequired: true, authenticated: false, username: null,
  });
});

test('auth：setup 建号即登录——Set-Cookie + status 翻转；重复 setup 409', async () => {
  const r = await post('/auth/setup', { username: 'admin', password: 'password123' });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).data.username, 'admin');
  assert.match(cookieOf(r), /^ms_session=/);
  assert.equal(usersRepo.countUsers(), 1);

  const st = await json(await app.request('http://t/auth/status'));
  assert.equal(st.body.data.authEnabled, true);
  assert.equal(st.body.data.setupRequired, false);

  const dup = await post('/auth/setup', { username: 'admin2', password: 'password123' });
  assert.equal(dup.status, 409);
});

test('auth：login 错密 401 / 正密 200 + 会话 cookie；me 回当前用户', async () => {
  const wrong = await post('/auth/login', { username: 'admin', password: 'wrongpass!' });
  assert.equal(wrong.status, 401);

  const ok = await post('/auth/login', { username: 'ADMIN', password: 'password123' });
  assert.equal(ok.status, 200);
  const cookie = cookieOf(ok);
  assert.match(cookie, /^ms_session=/);

  const me = await json(await app.request('http://t/auth/me', { headers: { cookie } }));
  assert.equal(me.status, 200);
  assert.equal(me.body.data.username, 'admin');
  assert.equal(me.body.data.role, 'admin');
});

test('auth：logout 后会话失效——me 401', async () => {
  const ok = await post('/auth/login', { username: 'admin', password: 'password123' });
  const cookie = cookieOf(ok);
  const out = await app.request('http://t/auth/logout', {
    method: 'POST', headers: { cookie },
  });
  assert.equal(out.status, 200);
  assert.match(out.headers.get('set-cookie') || '', /ms_session=;/); // 清 cookie

  const me = await app.request('http://t/auth/me', { headers: { cookie } });
  assert.equal(me.status, 401);
});

test('auth：login 异源 Origin → 403（CSRF 纵深；同源面见 auth-gate.test.mjs）', async () => {
  const r = await post('/auth/login',
    { username: 'admin', password: 'password123' },
    { origin: 'https://evil.example' });
  assert.equal(r.status, 403);
});

test('auth：凭据 schema——坏用户名/短密码 400', async () => {
  const r1 = await post('/auth/login', { username: 'a b<script>', password: 'password123' });
  assert.equal(r1.status, 400);
  const r2 = await post('/auth/login', { username: 'admin', password: 'short' });
  assert.equal(r2.status, 400);
});

test('auth：不存在用户也 401 不区分（恒时防枚举通道）', async () => {
  const r = await post('/auth/login', { username: 'ghost', password: 'password123' });
  assert.equal(r.status, 401);
  const b = await r.json();
  assert.match(b.message, /用户名或密码错误/);
});

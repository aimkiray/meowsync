// lib/protected-write 中间件矩阵（server.js 挂载的 DOWNLOAD_TOKEN 写闸）：
//   · /lyric 段入闸——/lyric/manual POST/DELETE 会写库+触发上游取词，
//     token-only 部署下不许 LAN 裸写（与 /lyric-align 同待遇）
//   · 闸只挡写——GET/HEAD 恒豁免（/lyric/manual 读绑定、/lyric/candidates
//     候选池、/lyric/external 外源词等读面不受影响）
//   · 凭据两态：x-download-token 配对 / 已登录会话（cookie）都放行
//   · DOWNLOAD_TOKEN 缺席 → 全放行（局域网默认部署不回归）
// 真库 sessions repo 供会话旁路；探针路由不吃外部依赖。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-protw-');
const require = createRequire(import.meta.url);

let app, usersRepo, sessionsRepo;
before(() => {
  const { Hono } = require('hono');
  const { protectedWrite } = require('../src/server/lib/protected-write.js');
  usersRepo = require('../src/server/repositories/users.js');
  sessionsRepo = require('../src/server/repositories/sessions.js');
  app = new Hono();
  app.use('*', protectedWrite);
  // 探针路由：闸内（/lyric/*、/downloads/*）与表外对照各一
  app.get('/lyric/manual', (c) => c.json({ code: 200 }));
  app.post('/lyric/manual', (c) => c.json({ code: 200 }));
  app.delete('/lyric/manual', (c) => c.json({ code: 200 }));
  app.get('/lyric/candidates', (c) => c.json({ code: 200 }));
  app.get('/lyric/external', (c) => c.json({ code: 200 }));
  app.post('/downloads/probe', (c) => c.json({ code: 200 }));
  app.get('/downloads/probe', (c) => c.json({ code: 200 }));
  app.post('/lyric-align', (c) => c.json({ code: 200 }));
  app.post('/outside/probe', (c) => c.json({ code: 200 }));
});
after(() => { rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

const req = (path, init = {}) => app.request(`http://t${path}`, init);

test('protectedWrite：DOWNLOAD_TOKEN 缺席 → 写面全放行（默认部署不回归）', async () => {
  delete process.env.DOWNLOAD_TOKEN;
  assert.equal((await req('/lyric/manual', { method: 'POST' })).status, 200);
  assert.equal((await req('/lyric/manual', { method: 'DELETE' })).status, 200);
  assert.equal((await req('/downloads/probe', { method: 'POST' })).status, 200);
});

test('protectedWrite：/lyric/manual 写端点入闸——缺/错 token 401，配对 200', async () => {
  process.env.DOWNLOAD_TOKEN = 'dt-prot-123';
  try {
    for (const method of ['POST', 'DELETE']) {
      const none = await req('/lyric/manual', { method });
      assert.equal(none.status, 401, `${method} 缺 token 应 401`);
      assert.equal((await none.json()).code, 401);
      const bad = await req('/lyric/manual', {
        method, headers: { 'x-download-token': 'dt-nope' },
      });
      assert.equal(bad.status, 401, `${method} 错 token 应 401`);
      const ok = await req('/lyric/manual', {
        method, headers: { 'x-download-token': 'dt-prot-123' },
      });
      assert.equal(ok.status, 200, `${method} 配对 token 应放行`);
    }
    // 裸 '/lyric' 也是段内形态（p === px 分支）——无匹配路由也先吃 401
    assert.equal((await req('/lyric', { method: 'POST' })).status, 401);
  } finally {
    delete process.env.DOWNLOAD_TOKEN;
  }
});

test('protectedWrite：GET/HEAD 恒豁免——/lyric/* 读面与存量闸内 GET 不受影响', async () => {
  process.env.DOWNLOAD_TOKEN = 'dt-prot-123';
  try {
    for (const p of ['/lyric/manual?id=1', '/lyric/candidates?id=1',
      '/lyric/external?id=1', '/downloads/probe']) {
      const res = await req(p);
      assert.equal(res.status, 200, `GET ${p} 不该被写闸拦`);
    }
    // 对照：同段非 GET 仍入闸
    assert.equal((await req('/lyric/manual', { method: 'POST' })).status, 401);
    assert.equal((await req('/downloads/probe', { method: 'POST' })).status, 401);
    assert.equal((await req('/lyric-align', { method: 'POST' })).status, 401);
    // 表外路径不受闸影响
    assert.equal((await req('/outside/probe', { method: 'POST' })).status, 200);
  } finally {
    delete process.env.DOWNLOAD_TOKEN;
  }
});

test('protectedWrite：已登录会话 cookie 等效凭据放行写；伪造 cookie 不放行', async () => {
  process.env.DOWNLOAD_TOKEN = 'dt-prot-123';
  try {
    const u = usersRepo.createUser('PwAdmin', 'hash$x', 'admin');
    const cookie = `ms_session=${sessionsRepo.createSession(u.id)}`;
    const ok = await req('/lyric/manual', { method: 'POST', headers: { cookie } });
    assert.equal(ok.status, 200, '活会话免 token 放行');
    const forged = await req('/lyric/manual', {
      method: 'POST', headers: { cookie: 'ms_session=forged' },
    });
    assert.equal(forged.status, 401, '伪造会话不顶凭据');
  } finally {
    delete process.env.DOWNLOAD_TOKEN;
  }
});

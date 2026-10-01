// 登录体系回归网：密码 KDF / users+sessions repo / 门径分类 / CSRF 判定。
// DATA_DIR 隔离 + 直接调 repository 层（HTTP 端到端由冒烟覆盖）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'meowsync-auth-test-'));
const require = createRequire(import.meta.url);

let password, usersRepo, sessionsRepo, apiPath, authGate;
before(() => {
  password = require('../src/server/lib/password.js');
  usersRepo = require('../src/server/repositories/users.js');
  sessionsRepo = require('../src/server/repositories/sessions.js');
  apiPath = require('../src/server/lib/api-path.js');
  authGate = require('../src/server/lib/auth-gate.js');
});
after(() => { rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

// ── password.js ──

test('password：argon2id 往返 + 错密码拒绝 + 垃圾哈希不炸', async () => {
  const h = await password.hashPassword('correct horse battery staple');
  assert.match(h, /^(a2id|scrypt)\$/);                  // PHC 自描述
  assert.equal(await password.verifyPassword('correct horse battery staple', h), true);
  assert.equal(await password.verifyPassword('wrong', h), false);
  assert.equal(await password.verifyPassword('x', 'not-a-hash'), false);
  assert.equal(await password.verifyPassword('x', ''), false);
});

test('password：needsRehash 判型 + dummy hash 形态合法', async () => {
  const dummy = await password.getDummyHash();
  assert.match(dummy, /^(a2id|scrypt)\$/);
  assert.equal(await password.verifyPassword('anything', dummy), false);
  assert.equal(password.needsRehash('garbage'), true);
  // 同口令两次哈希不同（随机盐）
  const h1 = await password.hashPassword('same-password');
  const h2 = await password.hashPassword('same-password');
  assert.notEqual(h1, h2);
});

// ── users repo ──

test('users：创建/查找 NOCASE/唯一约束/计数', () => {
  assert.equal(usersRepo.countUsers(), 0);
  const u = usersRepo.createUser('Admin', 'a2id$x', 'admin');
  assert.equal(usersRepo.countUsers(), 1);
  assert.equal(usersRepo.findByUsername('admin').id, u.id);       // NOCASE
  assert.equal(usersRepo.findByUsername('ADMIN').username, 'Admin');
  assert.equal(usersRepo.findByUsername('ghost'), undefined);
  assert.throws(() => usersRepo.createUser('admin', 'x'));        // UNIQUE
});

// ── sessions repo ──

test('sessions：建/解/滑动/删/清扫', () => {
  const u = usersRepo.findByUsername('admin');
  const raw = sessionsRepo.createSession(u.id, { ip: '1.2.3.4', userAgent: 'ua' });
  const s = sessionsRepo.resolveSession(raw);
  assert.equal(s.username, 'Admin');
  assert.equal(s.role, 'admin');
  assert.equal(sessionsRepo.resolveSession('bogus-token'), null);
  assert.equal(sessionsRepo.resolveSession(''), null);
  // 库内只存摘要——原文不落盘
  const { getDb } = require('../src/server/db/client.js');
  const row = getDb().prepare('SELECT id FROM sessions').get();
  assert.equal(row.id.includes(raw), false);
  assert.equal(row.id.length, 64); // sha256 hex
  sessionsRepo.deleteSession(raw);
  assert.equal(sessionsRepo.resolveSession(raw), null);
});

test('sessions：过期行 resolve 即删 + sweepExpired 兜底', () => {
  const u = usersRepo.findByUsername('admin');
  const raw = sessionsRepo.createSession(u.id);
  const { getDb } = require('../src/server/db/client.js');
  // 手工推过期：expires_at 拉到过去
  getDb().prepare('UPDATE sessions SET expires_at = ? WHERE 1=1').run(Date.now() - 1000);
  assert.equal(sessionsRepo.resolveSession(raw), null);          // 惰性删除
  // 再造一条过期行走 sweep
  const raw2 = sessionsRepo.createSession(u.id);
  getDb().prepare('UPDATE sessions SET expires_at = ? WHERE 1=1').run(Date.now() - 1000);
  sessionsRepo.sweepExpired();
  assert.equal(sessionsRepo.resolveSession(raw2), null);
});

// ── api-path 分类（authGate 与 SPA 兜底共用同一口径）──

test('isApiPath：公开前缀/静态资源/SPA 路径分类', () => {
  assert.equal(apiPath.isApiPath('/song_url'), true);
  assert.equal(apiPath.isApiPath('/downloads/x'), true);
  assert.equal(apiPath.isApiPath('/playlists'), true);
  assert.equal(apiPath.isApiPath('/audio-proxy'), true);
  assert.equal(apiPath.isApiPath('/auth/login'), true);
  assert.equal(apiPath.isApiPath('/remote'), true);
  assert.equal(apiPath.isApiPath('/'), false);
  assert.equal(apiPath.isApiPath('/assets/index.css'), false);
});

// ── cookie 解析（不进 Hono 的单测形态）──

test('sessionFromCookieHeader：name 匹配/URI 解码/空值', () => {
  const u = usersRepo.findByUsername('admin');
  const raw = sessionsRepo.createSession(u.id);
  const got = authGate.sessionFromCookieHeader(`a=1; ms_session=${raw}; b=2`);
  assert.equal(got.username, 'Admin');
  assert.equal(authGate.sessionFromCookieHeader('ms_session=wrong'), null);
  assert.equal(authGate.sessionFromCookieHeader(''), null);
  assert.equal(authGate.sessionFromCookieHeader(undefined), null);
  sessionsRepo.deleteSession(raw);
});

// ── CSRF Origin 判定 ──

function fakeCtx({ origin, url = 'https://app.example.com/x', host = 'app.example.com' } = {}) {
  return {
    req: {
      method: 'POST',
      header: (n) => ({ origin, host }[n.toLowerCase()] || undefined),
      url
    }
  };
}

test('csrfOriginOk：同源放行/异源拒/无 Origin 放行/白名单', () => {
  process.env.CORS_ORIGINS = 'https://allowed.example.com';
  const same = fakeCtx({ origin: 'https://app.example.com' });
  assert.equal(authGate.csrfOriginOk(same), true);
  const evil = fakeCtx({ origin: 'https://evil.example.com' });
  assert.equal(authGate.csrfOriginOk(evil), false);
  const noOrigin = fakeCtx({});
  assert.equal(authGate.csrfOriginOk(noOrigin), true);
  const badScheme = fakeCtx({ origin: 'javascript:void(0)' });
  assert.equal(authGate.csrfOriginOk(badScheme), false);
  // CORS 白名单内来源放行（跨域部署形态的合法前端）
  const allowed = fakeCtx({ origin: 'https://allowed.example.com' });
  assert.equal(authGate.csrfOriginOk(allowed), true);
  delete process.env.CORS_ORIGINS;
});

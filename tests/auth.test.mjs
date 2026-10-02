// 登录体系回归网：密码 KDF / users+sessions repo / 门径分类 / CSRF 判定。
// DATA_DIR 隔离 + 直接调 repository 层（HTTP 端到端由冒烟覆盖）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-auth-test-');
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
  // findAuthByUsername 是 password_hash 唯一出口：映射域字段名，无库列名泄漏
  const authRow = usersRepo.findAuthByUsername('ADMIN');
  assert.equal(authRow.passwordHash, 'a2id$x');
  assert.equal('password_hash' in authRow, false);
  assert.equal(usersRepo.findAuthByUsername('ghost'), undefined);
  // findByUsername 不带 hash 列
  assert.equal('passwordHash' in usersRepo.findByUsername('admin'), false);
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

test('peekSession：只读探活不写库（与 resolve 对比）', () => {
  const u = usersRepo.findByUsername('admin');
  const raw = sessionsRepo.createSession(u.id);
  const { getDb } = require('../src/server/db/client.js');
  const id = require('crypto').createHash('sha256').update(raw).digest('hex');
  // 把 last_seen_at 推到 20min 前使 touch 生效条件成立——peek 仍不得写
  const pushed = Date.now() - 20 * 60 * 1000;
  getDb().prepare('UPDATE sessions SET last_seen_at=? WHERE id=?').run(pushed, id);
  const s = sessionsRepo.peekSession(raw);
  assert.equal(s.username, 'Admin');
  const after = getDb().prepare('SELECT last_seen_at FROM sessions WHERE id=?').get(id);
  assert.equal(after.last_seen_at, pushed, 'peek 不得滑动续期');
  // resolve 对照组——超过节流间隔应写
  sessionsRepo.resolveSession(raw);
  const touched = getDb().prepare('SELECT last_seen_at FROM sessions WHERE id=?').get(id);
  assert.ok(touched.last_seen_at > after.last_seen_at, 'resolve 应滑动续期');
  sessionsRepo.deleteSession(raw);
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

function fakeCtx({ origin, url = 'https://app.example.com/x', host = 'app.example.com', xfh, xff, socketIp, sfs } = {}) {
  const headers = {
    origin, host, 'x-forwarded-host': xfh,
    'x-forwarded-for': xff, 'sec-fetch-site': sfs
  };
  return {
    req: {
      method: 'POST',
      header: (n) => headers[n.toLowerCase()],
      url
    },
    env: socketIp ? { incoming: { socket: { remoteAddress: socketIp } } } : undefined
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

test('csrfOriginOk：TRUST_PROXY 下采信 X-Forwarded-Host（反代重写 Host 形态）', () => {
  // 反代把 Host 改成内部地址时，Origin 应与 XFH（外部域）对齐而非内部 Host
  process.env.TRUST_PROXY = '1';
  const behindProxy = fakeCtx({
    origin: 'https://music.example.com',
    url: 'http://meowsync:3002/downloads',   // Host 头被反代重写后的入站形态
    host: 'meowsync:3002',
    xfh: 'music.example.com'
  });
  assert.equal(authGate.csrfOriginOk(behindProxy), true);
  // 异源即便伪造 XFH 也无济于事（Origin 是浏览器强制的）
  const evil = fakeCtx({
    origin: 'https://evil.example.com',
    host: 'meowsync:3002',
    xfh: 'music.example.com'
  });
  assert.equal(authGate.csrfOriginOk(evil), false);
  delete process.env.TRUST_PROXY;
});

// ── CSRF 边界补测 ──

test('csrfOriginOk：TRUST_PROXY 关闭时伪造 XFH 不采信', () => {
  delete process.env.TRUST_PROXY;
  // 直连部署：攻击者自带的 X-Forwarded-Host 必须被忽略——否则异源 Origin
  // 配上伪造 XFH 就把 CSRF 检查洗成同源
  const forged = fakeCtx({
    origin: 'https://evil.example.com',
    host: 'app.example.com',
    xfh: 'evil.example.com'
  });
  assert.equal(authGate.csrfOriginOk(forged), false);
});

test('csrfOriginOk：Origin null/端口错配/尾点 FQDN 均拒', () => {
  assert.equal(authGate.csrfOriginOk(fakeCtx({ origin: 'null' })), false);
  // Origin 带显式端口 vs Host 无端口 → host 不等 → 拒
  assert.equal(authGate.csrfOriginOk(fakeCtx({
    origin: 'https://app.example.com:8443'
  })), false);
  // 尾随点 FQDN（DNS 等价但 host 串不等）——fail-closed 误拒不误放
  assert.equal(authGate.csrfOriginOk(fakeCtx({
    origin: 'https://app.example.com.'
  })), false);
});

// ── rate-limit.js ──

test('rateLimitByKey：窗口计数/满容拒新不洗存量桶/refund 回退', async () => {
  const { rateLimitByKey, refundByKey } = require('../src/server/lib/rate-limit.js');
  // 正常计数
  const k = 'test:acct:victim';
  for (let i = 0; i < 3; i++) assert.equal(rateLimitByKey(k, 3, 60000), true);
  assert.equal(rateLimitByKey(k, 3, 60000), false);  // 第 4 次拒
  // refund：成功路径退回最新一拍 → 再获准一次
  refundByKey(k);
  assert.equal(rateLimitByKey(k, 3, 60000), true);
  assert.equal(rateLimitByKey(k, 3, 60000), false);
  // 窗口外放行（用 1ms 窗让桶自然过期）
  const short = 'test:short';
  assert.equal(rateLimitByKey(short, 1, 1), true);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(rateLimitByKey(short, 1, 1), true);
});

test('rateLimitByKey：满容拒新——洪泛的随机 key 自限，存量桶不丢', () => {
  const { rateLimitByKey } = require('../src/server/lib/rate-limit.js');
  // 受害者先建桶
  const victim = 'flood:victim';
  assert.equal(rateLimitByKey(victim, 8, 60000), true);
  // 灌桶：5000+ 个随机新 key。桶满后新 key 被拒（return false）——
  // 它们计数不到但占桶成功；关键断言是受害者桶不被逐
  let rejected = 0;
  for (let i = 0; i < 5200; i++) {
    if (!rateLimitByKey(`flood:attacker:${i}`, 1, 60000)) rejected++;
  }
  assert.ok(rejected > 0, '满容后新 key 应被拒');
  // 受害者桶仍健在：第 2 拍正常计数，第 8 拍后拒绝语义不变
  for (let i = 0; i < 7; i++) assert.equal(rateLimitByKey(victim, 8, 60000), true);
  assert.equal(rateLimitByKey(victim, 8, 60000), false);
});

// ── clientIp：XFF 右起第 N 跳（可信反代追加位）──

test('clientIp：TRUST_PROXY=1 取 XFF 末位（追加的直连对端），伪造首跳无效', () => {
  const { clientIp } = require('../src/server/lib/env.js');
  process.env.TRUST_PROXY = '1';
  // 客户端伪造 XFF 首跳经 append 型反代（$proxy_add_x_forwarded_for）后：
  // 伪造值, 真实对端 —— 右起第 1 个是不可伪造的真实 IP
  assert.equal(clientIp(fakeCtx({ xff: '6.6.6.6, 1.2.3.4' })), '1.2.3.4');
  // 覆写型反代（XFF=remote_addr 单值）同样取末位
  assert.equal(clientIp(fakeCtx({ xff: '1.2.3.4' })), '1.2.3.4');
  // 缺 XFF（直连/链路异常）回落 socket 对端
  assert.equal(clientIp(fakeCtx({ socketIp: '10.0.0.9' })), '10.0.0.9');
  delete process.env.TRUST_PROXY;
  // 关闭时 XFF 完全不可信——socket 兜底
  assert.equal(clientIp(fakeCtx({ xff: '6.6.6.6', socketIp: '10.0.0.9' })), '10.0.0.9');
});

test('clientIp：TRUST_PROXY=N 多级链取右起第 N 个，链不足回落 socket', () => {
  const { clientIp } = require('../src/server/lib/env.js');
  process.env.TRUST_PROXY = '2';
  // CDN→nginx→app：XFF = 客户端声称值, CDN 见值, nginx 见值 → 右起第 2 = 客户端
  assert.equal(clientIp(fakeCtx({ xff: 'spoofed, 1.2.3.4, 10.9.9.9' })), '1.2.3.4');
  // 链短于配置跳数（绕过外层直连内层）——伪造不出真实身份，回落 socket
  assert.equal(clientIp(fakeCtx({ xff: '1.2.3.4', socketIp: '10.0.0.1' })), '10.0.0.1');
  delete process.env.TRUST_PROXY;
});

test('csrfOriginOk：Origin 缺失时 Sec-Fetch-Site: cross-site 仍拒（剥头链路纵深）', () => {
  // Origin 被代理/老 UA 剥掉的跨站写——Sec-Fetch-Site 二级信号接住
  assert.equal(authGate.csrfOriginOk(fakeCtx({ sfs: 'cross-site' })), false);
  // 同源/同站/无该头（非浏览器客户端）照常放行
  assert.equal(authGate.csrfOriginOk(fakeCtx({ sfs: 'same-origin' })), true);
  assert.equal(authGate.csrfOriginOk(fakeCtx({ sfs: 'same-site' })), true);
  assert.equal(authGate.csrfOriginOk(fakeCtx({})), true);
});

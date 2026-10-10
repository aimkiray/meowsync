// ws/remote.js 接线测试：真 http.Server + ws 客户端，钉握手拒绝矩阵
// （跨站 Origin 403 / 33rd controller 503 / >64KB 帧断连）、消息面
// （畸形 payload 丢弃不炸连、state_update 白名单投影）、停机清理。
// DATA_DIR 隔离：authEnabled() 走真 usersRepo（空表=局域网开放态）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-remote-ws-');
const require = createRequire(import.meta.url);

const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { WebSocket, WebSocketServer } = require('ws'); // eslint-disable-line no-unused-vars
const { attachRemoteControl, revokeConnections } = require('../src/server/ws/remote.js');
const { MSG_TYPES, REMOTE_LIMITS } = require('../src/shared/protocol.js');

let server, remote, base;
const liveClients = new Set();

before(async () => {
  server = http.createServer((req, res) => { res.end('ok'); });
  remote = attachRemoteControl(server, { allowedOrigins: [], token: '' });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `ws://127.0.0.1:${server.address().port}`;
});
after(async () => {
  for (const ws of liveClients) { try { ws.terminate(); } catch { /* 已关 */ } }
  remote.close();
  await new Promise(r => server.close(r));
  rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

// 连接结果归一：open → ws；拒 → {code}（握手拒绝进 'unexpected-response'）
function tryConnect(query = '', origin = null) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${base}/remote${query}`, origin ? { origin } : {});
    inboxOf(ws); // message 监听先于 open 就位——欢迎包同 tick 连发不漏
    ws.once('open', () => { liveClients.add(ws); resolve(ws); });
    ws.once('error', (e) => resolve({ code: Number(String(e.message).match(/\d{3}/)?.[0]) || 0 }));
  });
}
const closeWs = (ws) => new Promise((r) => { ws.once('close', r); ws.close(); });
// 握手欢迎包与后续帧可能同 tick 连发——once('message') 会漏，统一收件箱
const inboxOf = (ws) => {
  const inbox = [];
  ws.on('message', (d) => { try { inbox.push(JSON.parse(d.toString())); } catch { /* 畸形帧不入箱 */ } });
  ws.inbox = inbox;
  return inbox;
};
const waitFor = async (inbox, n, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  while (inbox.length < n && Date.now() < deadline) await tick(15);
  if (inbox.length < n) throw new Error(`ws inbox timeout: got ${inbox.length}/${n}`);
};
const tick = (ms = 60) => new Promise(r => setTimeout(r, ms));

// ── 握手 ──

test('remote：跨站 Origin 握手 403；同源与无 Origin（非浏览器）放行', async () => {
  const evil = await tryConnect('', 'http://evil.example');
  assert.equal(evil.code, 403);

  const same = await tryConnect('', base.replace('ws://', 'http://'));
  assert.ok(same instanceof WebSocket);
  const noOrigin = await tryConnect('');
  assert.ok(noOrigin instanceof WebSocket);
  await closeWs(same);
  await closeWs(noOrigin);
});

test('remote：非 /remote 路径的 upgrade 被静默销毁', async () => {
  const ws = new WebSocket(`${base}/remotex`);
  const code = await new Promise(r => {
    ws.once('open', () => r('open'));
    ws.once('error', () => r('error'));
    ws.once('unexpected-response', (req, res) => r(res.statusCode));
  });
  assert.notEqual(code, 'open'); // socket.destroy → 连接中止而非升级
});

// ── 消息面 ──

test('remote：controller→host 白名单转发；畸形消息丢弃不断连', async () => {
  const host = await tryConnect('?role=host');
  await waitFor(host.inbox, 1); // request_state 欢迎包
  const ctrl = await tryConnect('');
  await waitFor(host.inbox, 2); // controller 加入再发一次 request_state

  // 畸形：非 JSON / 非对象 / 白名单外 type / payload 形状不符——全丢
  ctrl.send('not-json');
  ctrl.send('null');
  ctrl.send(JSON.stringify({ type: 'evil' }));
  ctrl.send(JSON.stringify({ type: 'seek', payload: 'abc' }));
  await tick(120);
  // 连接没死、垃圾没转发：紧跟一条合法指令应原样到 host
  const before = host.inbox.length;
  ctrl.send(JSON.stringify({ type: 'pause' }));
  await waitFor(host.inbox, before + 1);
  assert.deepEqual(host.inbox.at(-1), { type: 'pause' });
  assert.equal(ctrl.readyState, WebSocket.OPEN); // 畸形包没炸断连
  await closeWs(ctrl);
  await closeWs(host);
});

test('remote：state_update 白名单投影——host 脏 song 被消毒后才下发', async () => {
  const host = await tryConnect('?role=host');
  await waitFor(host.inbox, 1);
  const ctrl = await tryConnect('');
  await waitFor(host.inbox, 2); // controller 加入触发的 request_state

  host.send(JSON.stringify({
    type: 'state_update',
    payload: {
      isPlaying: 'yes', // 非布尔 → false
      currentTime: -5,  // 负值 → 钳 0
      volume: 250,      // 超上限 → 钳 100
      evil: 'injected',
      currentSong: {
        id: 'x'.repeat(200),
        name: '歌',
        ar: 'evil-string-not-array', // 畸形 ar → 空表
        al: { picUrl: 'javascript:alert(1)', evil: 1 },
        secret: 'field',
      },
      queue: [{ id: 1, name: 'q' }, 'garbage'],
      queueIndex: 9999,
    },
  }));
  await waitFor(ctrl.inbox, 1);
  const msg = ctrl.inbox[0];
  assert.equal(msg.type, MSG_TYPES.STATE_UPDATE);
  const p = msg.payload;
  assert.equal(p.isPlaying, false);
  assert.equal(p.currentTime, 0);
  assert.equal(p.volume, 100);
  assert.equal('evil' in p, false);
  // song 消毒：picUrl 非 http(s)/相对路径 清、ar 字符串→[]、id 截断、未知字段剥
  assert.equal(p.currentSong.al.picUrl, '');
  assert.deepEqual(p.currentSong.ar, []);
  assert.equal(p.currentSong.id.length, 128); // 与 play_song 守卫同值
  assert.equal('secret' in p.currentSong, false);
  // queue：合法条目保留消毒形、非对象条目被丢；queueIndex 钳 49
  assert.equal(p.queue.length, 1);
  assert.equal(p.queueIndex, 49);
  await closeWs(ctrl);
  await closeWs(host);
});

test('remote：state_update 整条非法（currentSong 非对象）→ 不转发', async () => {
  const host = await tryConnect('?role=host');
  await waitFor(host.inbox, 1);
  const ctrl = await tryConnect('');
  await waitFor(host.inbox, 2);

  host.send(JSON.stringify({ type: 'state_update', payload: { currentSong: 'string-not-obj' } }));
  host.send(JSON.stringify({ type: 'state_update', payload: null }));
  await tick(150);
  assert.equal(ctrl.inbox.filter(m => m.type === MSG_TYPES.STATE_UPDATE).length, 0);
  await closeWs(ctrl);
  await closeWs(host);
});

test('remote：>64KB 帧被 maxPayload 断连', async () => {
  const ctrl = await tryConnect('');
  const closed = new Promise(r => ctrl.once('close', (code) => r(code)));
  ctrl.send(JSON.stringify({ type: 'pause', pad: 'x'.repeat(70 * 1024) }));
  const code = await closed;
  assert.equal(code, 1009); // ws 库对超限帧 close 1009 Message Too Big
});

// ── 鉴权级联（登录启用后 WS 不得裸奔——旁路洞的回归网）──
// 桶注意：'remote-upgrade' 限流桶是模块级共享，用例会累计消耗；
// 见末尾限流用例的「补满即见 429」稳健断言设计

test('remote：启用登录后无凭据握手 401；session cookie 放行', async () => {
  const usersRepo = require('../src/server/repositories/users.js');
  const sessionsRepo = require('../src/server/repositories/sessions.js');
  if (usersRepo.countUsers() === 0) {
    usersRepo.createUser('wsgate', 'scrypt$test'); // 占位——级联只查会话不验密码
  }
  const srv3 = http.createServer((req, res) => res.end('ok'));
  const remote3 = attachRemoteControl(srv3, { allowedOrigins: [], token: '' });
  await new Promise(r => srv3.listen(0, '127.0.0.1', r));
  const b3 = `ws://127.0.0.1:${srv3.address().port}`;
  const conn3 = (opts = {}) => new Promise((resolve) => {
    const ws = new WebSocket(`${b3}/remote`, opts);
    ws.once('open', () => resolve(ws));
    ws.once('error', (e) => resolve({ code: Number(String(e.message).match(/\d{3}/)?.[0]) || 0 }));
  });
  try {
    // 无 session、无 token（server 未配）→ 登录启用后必须 401 而非裸奔
    const noCred = await conn3();
    assert.equal(noCred.code, 401);
    // 错误 token 同样 401（authEnabled 分支拒一切无 session 请求）
    const badTok = await conn3({ });
    // ?token= 通道（query 参数）
    const badQ = await new Promise((resolve) => {
      const ws = new WebSocket(`${b3}/remote?token=wrong`);
      ws.once('open', () => resolve(ws));
      ws.once('error', (e) => resolve({ code: Number(String(e.message).match(/\d{3}/)?.[0]) || 0 }));
    });
    assert.equal(badQ.code, 401);
    assert.equal(badTok.code, 401);
    // 有效 session cookie → 放行（sessionFromCookieHeader 命中即跳级联）
    const raw = sessionsRepo.createSession(usersRepo.findByUsername('wsgate').id);
    const authed = await conn3({ headers: { cookie: `ms_session=${raw}` } });
    assert.ok(authed instanceof WebSocket);
    await closeWs(authed);
  } finally {
    remote3.close();
    await new Promise(r => srv3.close(r));
    // users 非空会让 authEnabled() 为真——不清掉的话后续用例的无凭据
    // 连接全部吃 401（容量测试靠匿名握手）。还原空表开放态
    const { getDb } = require('../src/server/db/client.js');
    getDb().exec('DELETE FROM sessions; DELETE FROM users');
  }
});

test('remote：REMOTE_TOKEN 服务端——?token=/子协议双通道放行，错配 401', async () => {
  const srv4 = http.createServer((req, res) => res.end('ok'));
  const remote4 = attachRemoteControl(srv4, { allowedOrigins: [], token: 's3cr3t' });
  await new Promise(r => srv4.listen(0, '127.0.0.1', r));
  const b4 = `ws://127.0.0.1:${srv4.address().port}`;
  try {
    const good = await new Promise((resolve) => {
      const ws = new WebSocket(`${b4}/remote?token=s3cr3t`);
      ws.once('open', () => resolve(ws));
      ws.once('error', (e) => resolve({ code: Number(String(e.message).match(/\d{3}/)?.[0]) || 0 }));
    });
    assert.ok(good instanceof WebSocket);
    await closeWs(good);
    // 子协议通道（不落 URL 日志的优选通道）
    const proto = await new Promise((resolve) => {
      const ws = new WebSocket(`${b4}/remote`, ['remote.s3cr3t']);
      ws.once('open', () => resolve(ws));
      ws.once('error', (e) => resolve({ code: Number(String(e.message).match(/\d{3}/)?.[0]) || 0 }));
    });
    assert.ok(proto instanceof WebSocket);
    await closeWs(proto);
    const bad = await new Promise((resolve) => {
      const ws = new WebSocket(`${b4}/remote?token=nope`);
      ws.once('open', () => resolve(ws));
      ws.once('error', (e) => resolve({ code: Number(String(e.message).match(/\d{3}/)?.[0]) || 0 }));
    });
    assert.equal(bad.code, 401);
  } finally {
    remote4.close();
    await new Promise(r => srv4.close(r));
  }
});

test('remote：未认证升级洪泛触发 429 限流（20/min/IP 滑窗）', async () => {
  // 'remote-upgrade' 桶模块级共享——前序用例已消耗若干额度；
  // 上限 25 发内必须见到 429（漏限流会跑满 25 发全 401 而穿帮）
  const srv5 = http.createServer((req, res) => res.end('ok'));
  const remote5 = attachRemoteControl(srv5, { allowedOrigins: [], token: 'x' });
  await new Promise(r => srv5.listen(0, '127.0.0.1', r));
  const b5 = `ws://127.0.0.1:${srv5.address().port}`;
  try {
    let saw429 = false;
    for (let i = 0; i < 25 && !saw429; i++) {
      const code = await new Promise((resolve) => {
        const ws = new WebSocket(`${b5}/remote?token=bad`);
        ws.once('open', () => resolve('open'));
        ws.once('error', (e) => resolve(Number(String(e.message).match(/\d{3}/)?.[0]) || 0));
      });
      if (code === 429) saw429 = true;
      else assert.equal(code, 401); // 未限流前应全部是 401
    }
    assert.ok(saw429, '25 发未认证升级内未见 429——remote-upgrade 限流未生效');
  } finally {
    remote5.close();
    await new Promise(r => srv5.close(r));
  }
});

test('remote：picUrl 放行 http(s) 与本服务相对路径，拒 //协议相对与异 scheme', async () => {
  const host = await tryConnect('?role=host');
  await waitFor(host.inbox, 1);
  const ctrl = await tryConnect('');
  await waitFor(host.inbox, 2); // 无快照 → controller 入会回源要 request_state

  const sendState = (picUrl) => host.send(JSON.stringify({
    type: 'state_update',
    payload: { currentSong: { id: 1, name: 'x', al: { picUrl }, ar: [] } },
  }));
  sendState('/downloads/songs/file_abc/file?kind=cover');
  sendState('https://cdn.example/c.jpg');
  sendState('//evil.example/x.jpg');
  await waitFor(ctrl.inbox, 3);
  // file_ 封面以 apiBase 相对形态上线——服务端放行 '/x'，拒 '//x'（协议相对=任意外链）
  assert.equal(ctrl.inbox[0].payload.currentSong.al.picUrl, '/downloads/songs/file_abc/file?kind=cover');
  assert.equal(ctrl.inbox[1].payload.currentSong.al.picUrl, 'https://cdn.example/c.jpg');
  assert.equal(ctrl.inbox[2].payload.currentSong.al.picUrl, '');
  await closeWs(ctrl);
  await closeWs(host);
});

test('remote：state_update 广播帧上限 8KB——queue 砍尾不丢整帧', async () => {
  const host = await tryConnect('?role=host');
  await waitFor(host.inbox, 1);
  const ctrl = await tryConnect('');
  await waitFor(host.inbox, 2);

  // 50 条各 ~1KB 的肥队列 → 原始帧 ~50KB，广播侧必须压到 8KB 内
  const fatQueue = Array.from({ length: 50 }, (_, i) => ({
    id: i, name: '歌'.repeat(200),
    ar: [{ name: 'a'.repeat(100) }],
    al: { picUrl: `https://cdn.example/${'p'.repeat(400)}` },
  }));
  host.send(JSON.stringify({
    type: 'state_update',
    payload: { isPlaying: true, currentSong: { id: 1, name: 'x', ar: [] },
      queue: fatQueue, queueIndex: 49 },
  }));
  await waitFor(ctrl.inbox, 1);
  const msg = ctrl.inbox.at(-1);
  assert.equal(msg.type, MSG_TYPES.STATE_UPDATE);
  // 按线上字节量核——CJK 歌名 UTF-8 每字 3B，str.length 会低估
  const wireLen = Buffer.byteLength(JSON.stringify(msg));
  assert.ok(wireLen <= REMOTE_LIMITS.MAX_STATE_PAYLOAD_BYTES,
    `广播帧 ${wireLen}B 超过状态帧上限 ${REMOTE_LIMITS.MAX_STATE_PAYLOAD_BYTES}`);
  assert.ok(msg.payload.queue.length > 0 && msg.payload.queue.length < 50,
    'queue 应被砍尾保留部分，而非丢整帧');
  assert.equal(msg.payload.queueIndex, -1); // 砍尾后 index 越界归 -1
  await closeWs(ctrl);
  await closeWs(host);
});

test('remote：控制帧小顶——>1KB 的 controller 帧静默丢弃不炸连', async () => {
  const host = await tryConnect('?role=host');
  await waitFor(host.inbox, 1);
  const ctrl = await tryConnect('');
  await waitFor(host.inbox, 2);
  const before = host.inbox.length;
  // 形状合法但超控制帧上限：转发面直接丢，连 parse 都不进
  ctrl.send(JSON.stringify({ type: 'play_song', payload: 'q', pad: 'x'.repeat(2048) }));
  await tick(120);
  assert.equal(host.inbox.length, before);
  // 连接没死：合法小帧照常转发
  ctrl.send(JSON.stringify({ type: 'pause' }));
  await waitFor(host.inbox, before + 1);
  assert.equal(ctrl.readyState, WebSocket.OPEN);
  await closeWs(ctrl);
  await closeWs(host);
});

test('remote：新 controller 优先回缓存快照（不打扰 host）；host 断线缓存清、回 host_absent', async () => {
  const host = await tryConnect('?role=host');
  await waitFor(host.inbox, 1); // request_state 欢迎包
  host.send(JSON.stringify({
    type: 'state_update',
    payload: { isPlaying: true, currentSong: { id: 42, name: '缓存曲', ar: [] },
      currentTime: 7, duration: 200, volume: 50 },
  }));
  await tick(100); // 快照落服务端缓存
  const ctrl = await tryConnect('');
  await waitFor(ctrl.inbox, 1);
  assert.equal(ctrl.inbox[0].type, MSG_TYPES.STATE_UPDATE);
  assert.equal(ctrl.inbox[0].payload.currentSong.id, 42);
  await tick(120);
  assert.equal(host.inbox.length, 1, '有快照时新客入会不应再打扰 host 要 request_state');
  await closeWs(ctrl);
  await closeWs(host);
  await tick(80);
  // host 断线 → 快照已清：新客拿到 host_absent 而非陈快照
  const ctrl2 = await tryConnect('');
  await waitFor(ctrl2.inbox, 1);
  assert.equal(ctrl2.inbox[0].type, MSG_TYPES.HOST_ABSENT);
  await closeWs(ctrl2);
});

// ── 会话吊销与全量限流（各自独立 server——auth 态与限流桶不当共享）──

test('remote：会话吊销同步断关联 WS（logout=tokenId / deleteAllForUser=userId）', async () => {
  const usersRepo = require('../src/server/repositories/users.js');
  const sessionsRepo = require('../src/server/repositories/sessions.js');
  if (!usersRepo.findByUsername('wsrevoke')) {
    usersRepo.createUser('wsrevoke', 'scrypt$test');
  }
  const uid = usersRepo.findByUsername('wsrevoke').id;
  const srv6 = http.createServer((req, res) => res.end('ok'));
  const remote6 = attachRemoteControl(srv6, { allowedOrigins: [], token: '' });
  await new Promise(r => srv6.listen(0, '127.0.0.1', r));
  const b6 = `ws://127.0.0.1:${srv6.address().port}`;
  const connAuthed = (raw) => new Promise((resolve) => {
    const ws = new WebSocket(`${b6}/remote`, { headers: { cookie: `ms_session=${raw}` } });
    ws.once('open', () => resolve(ws));
    ws.once('error', (e) => resolve({ code: Number(String(e.message).match(/\d{3}/)?.[0]) || 0 }));
  });
  const closedOf = (ws) => new Promise(r => ws.once('close', r));
  try {
    const rawA = sessionsRepo.createSession(uid);
    const rawB = sessionsRepo.createSession(uid);
    const wsA = await connAuthed(rawA);
    const wsB = await connAuthed(rawB);
    assert.ok(wsA instanceof WebSocket && wsB instanceof WebSocket);
    // tokenId 粒度（logout 路径）：只收该会话的连接
    const closedA = closedOf(wsA);
    revokeConnections({ tokenId: sessionsRepo.tokenId(rawA) });
    await closedA;
    await tick(60);
    assert.equal(wsB.readyState, WebSocket.OPEN);
    // userId 粒度（deleteAllForUser 路径）：该用户全部端收编
    const closedB = closedOf(wsB);
    sessionsRepo.deleteAllForUser(uid); // repo 内部惰性调 remote 钩子
    await closedB;
  } finally {
    remote6.close();
    await new Promise(r => srv6.close(r));
    const { getDb } = require('../src/server/db/client.js');
    getDb().exec('DELETE FROM sessions; DELETE FROM users');
  }
});

test('remote：upgrade 全量限流——per-IP 60/min 不计成败（成功握手也计数）', async () => {
  const srv7 = http.createServer((req, res) => res.end('ok'));
  const remote7 = attachRemoteControl(srv7, { allowedOrigins: [], token: '' });
  await new Promise(r => srv7.listen(0, '127.0.0.1', r));
  const b7 = `ws://127.0.0.1:${srv7.address().port}`;
  try {
    let opened = 0;
    let saw429 = false;
    // role=host 绕过 controller 容量闸——每次成功握手互为顶替，
    // 第 61 发起应被全量桶拦成 429（证明成功握手也计入计数）
    for (let i = 0; i < 70; i++) {
      const res = await new Promise((resolve) => {
        const ws = new WebSocket(`${b7}/remote?role=host`);
        ws.once('open', () => { liveClients.add(ws); resolve('open'); });
        ws.once('error', (e) => resolve(Number(String(e.message).match(/\d{3}/)?.[0]) || 0));
      });
      if (res === 'open') opened++;
      else if (res === 429) saw429 = true;
    }
    assert.equal(opened, 60, '60/min 桶应恰好放行 60 个 upgrade');
    assert.ok(saw429, '超过 60 应见 429');
  } finally {
    remote7.close();
    await new Promise(r => srv7.close(r));
  }
});

// ── 容量与停机（module 级 controllers 集合——保持此序收尾）──

test('remote：第 33 个 controller 握手 503；close 后容量释放', async () => {
  const conns = [];
  for (let i = 0; i < 32; i++) conns.push(await tryConnect(''));
  const over = await tryConnect('');
  assert.equal(over.code, 503);
  for (const ws of conns) await closeWs(ws);
});

test('remote：host 候选并发上限 8——第 9 个 role=host 握手 503', async () => {
  // 顶替 UX 下活跃 host 恒为 1，但被顶替的旧 host 在对端不应答 close 帧时
  // 挂 CLOSING 直到 5s 强拆——raw socket 完成 101 握手后装死不回 close，
  // 把 8 个候选同时按住再验第 9 个撞 MAX_HOST_CANDIDATES
  const srv8 = http.createServer((req, res) => res.end('ok'));
  const remote8 = attachRemoteControl(srv8, { allowedOrigins: [], token: '' });
  await new Promise(r => srv8.listen(0, '127.0.0.1', r));
  const port = srv8.address().port;
  const fakeHost = () => new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let buf = '';
    sock.on('connect', () => {
      sock.write(
        `GET /remote?role=host HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\n` +
        `Sec-WebSocket-Version: 13\r\n\r\n`);
    });
    // 读到 101 响应头即算占位成功；之后服务端发的 close/state 帧全不应答
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      if (buf.includes('\r\n\r\n')) resolve(sock);
    });
    sock.on('error', reject);
  });
  const fakes = [];
  try {
    for (let i = 0; i < 8; i++) fakes.push(await fakeHost());
    // 8 个候选在册（7 个 CLOSING 顶替残 + 1 个活跃）——第 9 个 503
    const over = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/remote?role=host`);
      ws.once('open', () => resolve(ws));
      ws.once('error', (e) => resolve({ code: Number(String(e.message).match(/\d{3}/)?.[0]) || 0 }));
    });
    assert.equal(over.code, 503);
  } finally {
    for (const s of fakes) s.destroy();
    remote8.close();
    await new Promise(r => srv8.close(r));
  }
});

test('remote：remote.close() 终止在册客户端并可重复调用', async () => {
  // 另起一台 server 验证清理句柄（before 台的 remote 全局集合已共享，
  // 只验证 close 语义幂等+terminate 不抛）
  const srv2 = http.createServer((req, res) => res.end('ok'));
  const remote2 = attachRemoteControl(srv2, {});
  await new Promise(r => srv2.listen(0, '127.0.0.1', r));
  const ws = new WebSocket(`ws://127.0.0.1:${srv2.address().port}/remote`);
  await new Promise(r => ws.once('open', r));
  const closed = new Promise(r => ws.once('close', r));
  remote2.close();
  remote2.close(); // 幂等
  await closed;
  await new Promise(r => srv2.close(r));
});

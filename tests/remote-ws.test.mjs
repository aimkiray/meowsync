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
const { WebSocket, WebSocketServer } = require('ws'); // eslint-disable-line no-unused-vars
const { attachRemoteControl } = require('../src/server/ws/remote.js');
const { MSG_TYPES } = require('../src/shared/protocol.js');

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
  // song 消毒：picUrl 非 http(s) 清、ar 字符串→[]、id 截断、未知字段剥
  assert.equal(p.currentSong.al.picUrl, '');
  assert.deepEqual(p.currentSong.ar, []);
  assert.equal(p.currentSong.id.length, 64);
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

// ── 容量与停机（module 级 controllers 集合——保持此序收尾）──

test('remote：第 33 个 controller 握手 503；close 后容量释放', async () => {
  const conns = [];
  for (let i = 0; i < 32; i++) conns.push(await tryConnect(''));
  const over = await tryConnect('');
  assert.equal(over.code, 503);
  for (const ws of conns) await closeWs(ws);
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

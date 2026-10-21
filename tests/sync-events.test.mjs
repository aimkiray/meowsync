// routes/sync.js /sync/events SSE 回归网：
//   - 响应头面：text/event-stream / Cache-Control:no-cache /
//     X-Accel-Buffering:no（streamSSE 三头 + 反代防缓冲头）
//   - 订阅注册进 syncUserId 桶；关流（reader.cancel→abort）摘除，
//     空桶连 Map 键一起摘
//   - push 落地广播 changed，data.seq=本批最大 seq；批量 push 取末位
//   - pull、全批判负（零 applied）push、别桶 push 都不触发 changed
//   - 单桶订阅上限分档：登录桶 8 / 'default' 桶 32（无会话部署全局
//     桶，订阅数≈设备数）。超限软拒——连接照 200 建立、流内 retry:
//     行刷 30s 退避后 EOF 关流（非 2xx 会 fail the connection 永不
//     重试，故不能 429 硬拒）；软拒端不进订阅表零槽位占用、不踢老
//   - 429 只剩限流一路：断言 body.message 坐实「请求太频繁」与
//     桶满软拒区分（限流是前置 fail，软拒是流内帧——判 status
//     之外必须看体/帧才算分清两路）
//   - 无订阅 push 照常（广播面零开销早退）
//   - 坏订阅两条摘除路径都钉：aborted 标志预检摘除（write 根本不该
//     被调到）+ write 抛错 catch 摘除，不拖累同桶活订阅
// 心跳帧（25s 注释行）超出用例时间预算不直测——其"不当事件派发"
// 性质由帧格式（冒号注释行）保证，静默断言顺带覆盖无杂帧。
// DATA_DIR 指临时目录；路由直挂 app.request（不过 server.js 的
// authGate/compress）——syncUserId 的 cookie 兜底解析正是被测路径。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-sse-');
const require = createRequire(import.meta.url);

let app, syncItems, sessionsRepo, usersRepo;
before(() => {
  app = require('../src/server/routes/sync.js');
  syncItems = require('../src/server/repositories/syncItems.js');
  sessionsRepo = require('../src/server/repositories/sessions.js');
  usersRepo = require('../src/server/repositories/users.js');
});
after(() => { rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

// 订阅表探针（路由文件尾挂的 __syncEventsForTest）
const subs = (uid = 'default') => app.__syncEventsForTest().get(uid);
const dec = new TextDecoder();

// 帧缓冲：多次广播可能合并进一个 chunk（write 是异步 enqueue——
// 用例里两次 push 的帧可能同块到达）。按文本累计+消费切走的读取
// 模型，避免「一 chunk 两帧」被误读成丢帧。
const frameBuffer = (reader) => {
  let buf = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
      }
    } catch { /* 取消即退——pump 不抛 */ }
  })();
  return {
    // 等 buf 出现 re——命中即把已消费段切走（下一帧从切点起配）
    async take(re, ms = 3000) {
      const t0 = Date.now();
      for (;;) {
        const m = buf.match(re);
        if (m) {
          buf = buf.slice(m.index + m[0].length);
          return m;
        }
        assert.ok(Date.now() - t0 < ms, `SSE 帧等待超时: ${re}`);
        await new Promise(r => setTimeout(r, 15));
      }
    },
    // changed 整帧消费（含 \n\n 帧尾）——整帧吃掉后 assertQuiet
    // 的「buf 必须为空」语义才成立；回解析后的 data JSON
    async takeChanged(ms = 3000) {
      const m = await this.take(/event: changed\ndata: ([^\n]+)\n\n/, ms);
      return JSON.parse(m[1]);
    },
    text: () => buf,
    done: pump,
  };
};

// 开一条 SSE 订阅；返回 reader 供关流、fb 供帧断言
const openEvents = async (headers = {}) => {
  const res = await app.request('http://t/sync/events', { headers });
  assert.equal(res.status, 200, 'SSE 订阅握手');
  const reader = res.body.getReader();
  return { res, reader, fb: frameBuffer(reader), close: () => reader.cancel() };
};

// 反向断言窗：窗口内累积文本必须为空——pull/零落地 push/别桶广播
// 都不该惊动订阅端（150ms 对进程内 broadcast 已足够宽裕）
const assertQuiet = async (fb, ms = 150) => {
  await new Promise(r => setTimeout(r, ms));
  assert.equal(fb.text(), '', '订阅端不应收到任何帧');
};

// abort→onAbort→finally 摘除是微任务链——轮询等它落定再断言
const eventually = async (pred, ms = 2000) => {
  const t0 = Date.now();
  while (!pred()) {
    assert.ok(Date.now() - t0 < ms, '等待条件超时');
    await new Promise(r => setTimeout(r, 10));
  }
};

const push = (changes, headers = {}) => app.request('http://t/sync/push', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify({ changes }),
});

test('sync/events：SSE 头齐备；订阅注册 default 桶；关流摘除+空桶摘键', async () => {
  const { res, reader } = await openEvents();
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  assert.equal(res.headers.get('x-accel-buffering'), 'no');
  // 注册在响应返回前落定（streamSSE 回调同步段完成 add）
  assert.equal(subs()?.size, 1);
  await reader.cancel();
  // 摘除走 abort→finally 微任务链；空桶连 Map 键一起摘防漏
  await eventually(() => subs() === undefined);
});

test('sync/events：push 落地广播 changed——data.seq=本批最大 seq', async () => {
  const { fb, reader } = await openEvents();
  try {
    // 批量 push：两条都赢——水位线提示须是末条（最大号）的 seq
    const r = await push([
      { key: 'doc:ev-a', value: 1, updatedAt: Date.now() },
      { key: 'doc:ev-b', value: 2, updatedAt: Date.now() },
    ]);
    assert.equal(r.status, 200);
    const seqA = syncItems.getItem('default', 'doc:ev-a').seq;
    const seqB = syncItems.getItem('default', 'doc:ev-b').seq;
    assert.ok(seqB > seqA, 'repo 按批内数组序发号');
    const data = await fb.takeChanged();
    assert.equal(data.seq, seqB);

    // 第二推照常下发更高水位线（无去抖——客户端 flush 已节流）
    await push([{ key: 'doc:ev-c', value: 3, updatedAt: Date.now() }]);
    const data2 = await fb.takeChanged();
    assert.equal(data2.seq, syncItems.getItem('default', 'doc:ev-c').seq);
  } finally {
    await reader.cancel();
  }
});

test('sync/events：pull 不触发 changed；零落地 push（全批判负）也不触发', async () => {
  const { fb, reader } = await openEvents();
  try {
    // pull 是读面——不得惊动订阅端
    const p = await app.request('http://t/sync/pull?since=0');
    assert.equal(p.status, 200);
    await assertQuiet(fb);

    // 全批判负：repo 直写造一条库内现值（不过路由不产生广播帧），
    // 再用更旧 updatedAt 经路由 push→零 applied 零广播
    syncItems.applyChanges('default', [
      { key: 'doc:ev-stale', value: '现值', updatedAt: Date.now(), deleted: false },
    ]);
    const stale = await push([
      { key: 'doc:ev-stale', value: '旧写', updatedAt: 1 },
    ]);
    assert.equal(stale.status, 200);
    const st = await stale.json();
    assert.equal(st.applied.length, 0);
    assert.equal(st.conflicts.length, 1);
    await assertQuiet(fb);
  } finally {
    await reader.cancel();
  }
});

test('sync/events：无订阅时 push 照常（广播面早退零开销）', async () => {
  // 此刻无订阅（上例已 cancel+摘除落定）——先坐实空表
  await eventually(() => subs() === undefined);
  const r = await push([{ key: 'doc:ev-lonely', value: 1, updatedAt: Date.now() }]);
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.deepEqual(b.applied, ['doc:ev-lonely']);
});

test('sync/events：登录桶上限 8——第 9 条软拒（200+retry 帧后关流），不占槽位不踢老', async () => {
  // 软拒发生在 streamSSE 内部（连接已 200 建立）——这正是钉板点：
  // EventSource 遇非 2xx 直接 fail the connection 永不重试，只有
  // 流内 EOF 才自动重连，所以超限只能 200 流内 retry: 帧退避
  // XFF 独立 IP 桶隔离限流（'sync-events' 30/min 与本文件其它用例的
  // 'local' 桶互不干扰；手法同 route-auth.test.mjs 的 TRUST_PROXY+XFF）
  process.env.TRUST_PROXY = '1';
  const u = usersRepo.createUser('SseCapUser', 'a2id$x', 'admin');
  const cookie = `ms_session=${sessionsRepo.createSession(u.id)}`;
  const uid = String(u.id);
  const via = { cookie, 'x-forwarded-for': '10.99.8.8' };
  const opened = [];
  try {
    for (let i = 0; i < 8; i++) {
      opened.push(await openEvents(via));
    }
    assert.equal(subs(uid)?.size, 8);
    // 第 9 条：200 握手 + 流内 retry: 30000 帧 + EOF 关流；不进订阅表
    const ninth = await app.request('http://t/sync/events', { headers: via });
    assert.equal(ninth.status, 200, '桶满软拒仍走 200 流（不是 429——429 只剩限流一路）');
    const nfb = frameBuffer(ninth.body.getReader());
    await nfb.take(/retry: 30000/, 3000);
    await nfb.done; // 帧写完即关——run() 的 finally 收口成 EOF
    assert.equal(subs(uid)?.size, 8, '软拒端不占槽位');

    // 老连接全量不受影响：扇出断言每条注册订阅都收到帧——
    // 只查第一条会把「广播中途断圈」的回归藏掉
    await push([{ key: 'doc:ev-cap', value: 1, updatedAt: Date.now() }], { cookie });
    for (const o of opened) await o.fb.takeChanged();

    // 429 与桶满软拒分两路：同 IP 打满 'sync-events' 30/min 后的
    // 第 31 条才是 429——断言 body.message 坐实是限流「请求太频繁」
    // 而非超限（此处已累计 9 hits：8 注册 + 1 软拒，再补 21 条到满；
    // 软拒响应不消费也要 cancel 释放流）
    for (let i = 0; i < 21; i++) {
      const r = await app.request('http://t/sync/events', { headers: via });
      assert.equal(r.status, 200, '桶满后每条都是软拒 200');
      await r.body.cancel();
    }
    const limited = await app.request('http://t/sync/events', { headers: via });
    assert.equal(limited.status, 429);
    const lb = await limited.json();
    assert.match(lb.message, /太频繁/, '本路由 429 只来自限流桶，不再有「订阅数超限」');
  } finally {
    delete process.env.TRUST_PROXY;
    for (const o of opened) await o.close();
    await eventually(() => subs(uid) === undefined);
  }
});

test("sync/events：'default' 桶上限放宽 32——第 9 条仍成功，第 33 条软拒", async () => {
  // 'default' 是无会话部署全局桶（订阅数≈设备数），分档放宽到 32。
  // 每请求轮换 XFF IP：限流桶按 IP 分（30/min，33 条同 IP 会先撞
  // 429），订阅桶按 userId 分与 IP 无关——轮换 IP 只隔限流不隔桶
  process.env.TRUST_PROXY = '1';
  const via = (i) => ({ 'x-forwarded-for': `10.77.${(i >> 8) & 255}.${i & 255}` });
  const opened = [];
  try {
    for (let i = 0; i < 32; i++) {
      opened.push(await openEvents(via(i)));
    }
    assert.equal(subs().size, 32, '登录桶 8 上限不约束 default 桶');
    // 放宽面广播照常扇出：全 32 条订阅都收到帧
    await push([{ key: 'doc:ev-wide', value: 1, updatedAt: Date.now() }]);
    for (const o of opened) await o.fb.takeChanged();

    // 第 33 条软拒：200 + retry: 帧 + EOF，桶仍 32
    const over = await app.request('http://t/sync/events', { headers: via(32) });
    assert.equal(over.status, 200);
    const ofb = frameBuffer(over.body.getReader());
    await ofb.take(/retry: 30000/, 3000);
    await ofb.done;
    assert.equal(subs().size, 32, 'default 桶软拒同样不占槽位');
  } finally {
    delete process.env.TRUST_PROXY;
    for (const o of opened) await o.close();
    await eventually(() => subs() === undefined);
  }
});

test('sync/events：广播按 syncUserId 分桶——登录桶收不到 default 桶事件', async () => {
  // 建登录态会话：cookie 订阅落用户桶，无 cookie 落 default 桶
  const u = usersRepo.createUser('SseUser', 'a2id$x', 'admin');
  const cookie = `ms_session=${sessionsRepo.createSession(u.id)}`;

  const userSide = await openEvents({ cookie });
  const guestSide = await openEvents();
  try {
    assert.equal(subs(String(u.id))?.size, 1, 'cookie 订阅落用户桶');
    assert.equal(subs('default')?.size, 1, '裸订阅落 default 桶');

    // default 桶 push → 只惊动 default 桶订阅者
    await push([{ key: 'doc:ev-iso1', value: 1, updatedAt: Date.now() }]);
    await guestSide.fb.takeChanged();
    await assertQuiet(userSide.fb);

    // 登录桶 push（带 cookie）→ 只惊动用户桶订阅者
    await push([{ key: 'doc:ev-iso2', value: 2, updatedAt: Date.now() }], { cookie });
    await userSide.fb.takeChanged();
    await assertQuiet(guestSide.fb);
  } finally {
    await userSide.close();
    await guestSide.close();
    await eventually(() => subs() === undefined && subs(String(u.id)) === undefined);
  }
});

test('sync/events：坏订阅两条摘除路径都钉死——不拖累同桶活订阅', async () => {
  const { fb, reader } = await openEvents();
  try {
    // 路径①：aborted/closed 标志预检摘除——hono 的 stream.write
    // 自身吞流错误不抛，真死连接靠标志位识别。注入 aborted:true
    // 且 write 一被调就记标的假流：摘除必须发生在 write 之前，
    // flagWriteCalled 保持 false 才坐实走的是预检而非 catch
    let flagWriteCalled = false;
    const flagDead = {
      aborted: true,
      closed: false,
      write() { flagWriteCalled = true; },
    };
    // 路径②：write 抛错 catch 摘除——抛错面只剩非 hono 实现/
    // 序列化异常，防御 catch 的摘除语义必须钉死
    const throwDead = {
      aborted: false,
      closed: false,
      write() { throw new Error('boom'); },
    };
    subs().add(flagDead);
    subs().add(throwDead);
    assert.equal(subs().size, 3);

    await push([{ key: 'doc:ev-dead', value: 1, updatedAt: Date.now() }]);
    // 两条坏订阅各按其路径被摘，活订阅照常收帧
    assert.equal(subs().has(flagDead), false, 'flag 预检摘除');
    assert.equal(flagWriteCalled, false, '预检命中时 write 根本不该被调到');
    assert.equal(subs().has(throwDead), false, 'catch 摘除');
    assert.equal(subs().size, 1);
    await fb.takeChanged();
  } finally {
    await reader.cancel();
    await eventually(() => subs() === undefined);
  }
});

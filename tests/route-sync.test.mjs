// routes/sync.js 冒烟：pull 全量/seq 域增量/越顶自愈（reset 诊断）/分页
// 续拉（末行 seq 喂回 since）、
// push 批量 LWW+conflicts 回包（item 带 key/seq）+逐条 rejected（含未来戳
// 诚拒）、体量上限（value/批条数/body）、CSRF 闸、无会话落 'default' 桶与
// 登录态按 userId 分域、两端点 per-IP 独立限流桶。
// DATA_DIR 隔离 + 真 users/sessions repo（登录分域用例吃真会话解析）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-rsync-');
const require = createRequire(import.meta.url);

let app, usersRepo, sessionsRepo, syncItems;
before(() => {
  app = require('../src/server/routes/sync.js');
  usersRepo = require('../src/server/repositories/users.js');
  sessionsRepo = require('../src/server/repositories/sessions.js');
  syncItems = require('../src/server/repositories/syncItems.js');
});
after(() => { rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

const json = async (res) => ({ status: res.status, body: await res.json().catch(() => null) });
const pull = (qs = '', headers = {}) => app.request(`http://t/sync/pull${qs}`, { headers });
const push = (body, headers = {}) => app.request('http://t/sync/push', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

test('sync pull：空桶全量回空 items + serverTime', async () => {
  const r = await json(await pull());
  assert.equal(r.status, 200);
  assert.equal(r.body.code, 200);
  assert.deepEqual(r.body.items, []);
  assert.equal(typeof r.body.serverTime, 'number');
  assert.equal(r.body.hasMore, undefined);
});

test('sync push→pull 往返：无会话落 default 桶，value 已解析非双重编码', async () => {
  const r = await json(await push({
    changes: [
      { key: 'doc:t1', value: { playing: true, n: 1 }, updatedAt: 1000 },
      { key: 'playlist:pl_1', value: { name: '单', tracks: [{ id: '1' }] }, updatedAt: 1001 },
    ]
  }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.applied.sort(), ['doc:t1', 'playlist:pl_1']);
  assert.deepEqual(r.body.conflicts, []);
  assert.deepEqual(r.body.rejected, []);

  const p = await json(await pull());
  assert.equal(p.body.items.length, 2);
  const doc = p.body.items.find(i => i.key === 'doc:t1');
  assert.deepEqual(doc.value, { playing: true, n: 1 }); // 解析后的 JSON 值
  assert.equal(doc.updatedAt, 1000);
  assert.equal(doc.deleted, false);
  assert.equal(typeof doc.seq, 'number'); // 交付水位线随 item 下发
});

test('sync pull since=seq 域：严格大于续拉；脏 since 400；退役 cursor 收下不解释', async () => {
  // 续拉游标=回包 item 的 seq——客户端不解释只回喂
  const all = await json(await pull());
  const seqOf = (k) => all.body.items.find(i => i.key === k).seq;
  const p1 = await json(await pull(`?since=${seqOf('doc:t1')}`));
  assert.equal(p1.status, 200);
  // seq>since 严格大于：doc:t1 不回，只剩 seq 更晚的行
  assert.deepEqual(p1.body.items.map(i => i.key), ['playlist:pl_1']);
  const p0 = await json(await pull('?since=0'));
  assert.equal(p0.body.items.length, 2); // since=0=全量
  // 脏参数按 400 拦——静默吞成全量会藏起客户端的增量丢数据 bug
  assert.equal((await pull('?since=abc')).status, 400);
  assert.equal((await pull('?since=-1')).status, 400);
  // cursor 退役兼容位：在途旧客户端带上不 400、不解释（不裁剪结果）；
  // 响应不再发 nextCursor
  const cur = await json(await pull(`?cursor=${encodeURIComponent('1000|doc:t1')}`));
  assert.equal(cur.status, 200);
  assert.equal(cur.body.items.length, 2);
  assert.equal(cur.body.nextCursor, undefined);
});

test('sync pull since 越顶自愈：旧契约 ms 大数首拉拿全量+reset 诊断；正常增量不带 reset', async () => {
  // 存量 SINCE_KEY 可能是旧契约 ms 时钟域大数（~1.7e12）——seq>since
  // 永空会让该端同步静默停摆；服务端按「越顶=全量重发」幂等自愈，
  // reset 标记供前端日志观测这次矫正
  const r = await json(await pull('?since=1700000000000'));
  assert.equal(r.status, 200);
  assert.equal(r.body.reset, true);
  assert.deepEqual(r.body.items.map(i => i.key).sort(), ['doc:t1', 'playlist:pl_1']);
  // 客户端消化后把末行 seq 落盘即回增量轨：越顶续拉空页且不带 reset
  const tail = await json(await pull(`?since=${r.body.items.at(-1).seq}`));
  assert.equal(tail.body.items.length, 0);
  assert.equal(tail.body.reset, undefined);
  // 水位线内的合法增量不触发 reset——正常路径不受影响
  const mid = await json(await pull(`?since=${r.body.items[0].seq}`));
  assert.equal(mid.body.reset, undefined);
  assert.deepEqual(mid.body.items.map(i => i.key), ['playlist:pl_1']);
});

test('sync push 混合批：applied/conflicts/rejected 三路各归其位', async () => {
  // 先落一条基线（doc:c updatedAt=500）
  await push({ changes: [{ key: 'doc:c', value: 'v500', updatedAt: 500 }] });
  const r = await json(await push({
    changes: [
      { key: 'doc:c', value: 'v600', updatedAt: 600 },   // 新写赢
      { key: 'doc:c', value: 'v550', updatedAt: 550 },   // 过期（同批内已写到 600）
      { key: 'doc:c', value: 'v600dup', updatedAt: 600 },// 平局留旧
      { key: 'bad key!', value: 1, updatedAt: 1 },       // 非法 key
      { key: 'doc:x', value: 1, updatedAt: 'abc' },      // updatedAt 非有限正数
      { key: 'doc:y', value: 1, updatedAt: -5 },         // 非正数
    ]
  }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.applied, ['doc:c']);
  // 过期+平局都进 conflicts，回包服务端现值（600 那版）让客户端采纳；
  // item 内冗余 key/seq——客户端零拼接消费
  assert.equal(r.body.conflicts.length, 2);
  for (const cf of r.body.conflicts) {
    assert.equal(cf.key, 'doc:c');
    assert.equal(cf.item.key, 'doc:c');
    assert.equal(cf.item.updatedAt, 600);
    assert.equal(cf.item.value, 'v600');
    assert.equal(cf.item.deleted, false);
    assert.equal(typeof cf.item.seq, 'number');
  }
  assert.equal(r.body.rejected.length, 3);
  assert.deepEqual(r.body.rejected.map(x => x.reason).sort(),
    ['invalid key', 'invalid updatedAt', 'invalid updatedAt']);
  // 库内是 600 版
  assert.equal(syncItems.getItem('default', 'doc:c').value, 'v600');
});

test('sync push 未来戳：updatedAt>serverNow+5min 该条诚拒 future-timestamp 不落库', async () => {
  const r = await json(await push({
    changes: [
      // 超窗拒（+10min）——钟坏设备的写不静默 clamp 成"正常"
      { key: 'doc:fut', value: 1, updatedAt: Date.now() + 10 * 60 * 1000 },
      // 窗内收（+4min）——校时误差常态放行
      { key: 'doc:fut-ok', value: 1, updatedAt: Date.now() + 4 * 60 * 1000 },
    ]
  }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.applied, ['doc:fut-ok']);
  assert.deepEqual(r.body.rejected, [{ key: 'doc:fut', reason: 'future-timestamp' }]);
  assert.equal(syncItems.getItem('default', 'doc:fut'), undefined);
  assert.equal(syncItems.getItem('default', 'doc:fut-ok').value, 1);
});

test('sync push：异源 Origin 写请求被 CSRF 闸拒 403', async () => {
  const r = await push({ changes: [{ key: 'doc:z', value: 1, updatedAt: 1 }] },
    { origin: 'http://evil.example' });
  assert.equal(r.status, 403);
});

test('sync push 体量上限：value>256KB 整批 400 不落一条；changes>500 400；body>8MB 413', async () => {
  // 单条超限 → 整批拒（别静默截断）——同批的合法条目也不落
  const big = 'x'.repeat(256 * 1024); // JSON 化后含引号 >256KB
  const r = await push({
    changes: [
      { key: 'doc:big', value: big, updatedAt: 1 },
      { key: 'doc:innocent', value: 1, updatedAt: 1 },
    ]
  });
  assert.equal(r.status, 400);
  assert.equal(syncItems.getItem('default', 'doc:innocent'), undefined);
  // 501 条整批拒
  const many = Array.from({ length: 501 }, (_, i) =>
    ({ key: `doc:m${i}`, value: 1, updatedAt: 1 }));
  assert.equal((await push({ changes: many })).status, 400);
  // 超 body 硬顶 → 413（readJsonBody 的 Content-Length 预检路径）
  const huge = await app.request('http://t/sync/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: `{"changes":[], "pad":"${'y'.repeat(9 * 1024 * 1024)}"}`,
  });
  assert.equal(huge.status, 413);
});

test('sync 分域：无会话=default 桶；登录会话按 users.id 隔离互不可见', async () => {
  // default 桶此时已有 doc:t1（前面用例落的）
  const u = usersRepo.createUser('SyncUser', 'a2id$x', 'admin');
  const cookie = `ms_session=${sessionsRepo.createSession(u.id)}`;
  // 登录态 pull：user 桶是全新空桶——default 桶的 doc:t1 不可见
  const pUser = await json(await pull('', { cookie }));
  assert.equal(pUser.status, 200);
  assert.equal(pUser.body.items.length, 0);
  // 同 key 两桶各写各的互不干扰
  await push({ changes: [{ key: 'doc:t1', value: 'user版', updatedAt: 2000 }] }, { cookie });
  const pUser2 = await json(await pull('', { cookie }));
  assert.equal(pUser2.body.items.length, 1);
  assert.equal(pUser2.body.items[0].value, 'user版');
  // default 桶仍是旧版——用户行不回流开放桶
  const pDef = await json(await pull());
  assert.equal(pDef.body.items.find(i => i.key === 'doc:t1').value.playing, true);
  // 登录态 push 的 rejected/conflicts 语义同样按 user 桶判
  const rUser = await json(await push({
    changes: [{ key: 'doc:t1', value: '更旧', updatedAt: 1999 }] }, { cookie }));
  assert.equal(rUser.body.conflicts.length, 1);
  assert.equal(rUser.body.conflicts[0].item.value, 'user版');
});

test('sync 墓碑：push deleted=true 后 pull 见墓碑；覆写复活拿新 seq', async () => {
  await push({ changes: [{ key: 'doc:dead', value: { a: 1 }, updatedAt: 100 }] });
  await push({ changes: [{ key: 'doc:dead', value: null, updatedAt: 200, deleted: true }] });
  const p = await json(await pull('?since=0'));
  const tomb = p.body.items.find(i => i.key === 'doc:dead');
  assert.equal(tomb.deleted, true);
  assert.equal(tomb.value, null);
  assert.equal(tomb.updatedAt, 200);
  // 复活：更大戳的非墓碑写覆盖——拿新 seq：墓碑 seq 位续拉可见新态
  await push({ changes: [{ key: 'doc:dead', value: { a: 2 }, updatedAt: 300, deleted: false }] });
  const p2 = await json(await pull(`?since=${tomb.seq}`));
  const alive = p2.body.items.find(i => i.key === 'doc:dead');
  assert.equal(alive.deleted, false);
  assert.equal(alive.value.a, 2);
  assert.ok(alive.seq > tomb.seq, '覆写墓碑拿新 seq');
});

test('sync pull 分页：>PAGE_SIZE 截页 hasMore；末行 seq 作 since 续拉收全尾页', async () => {
  // 路由 PAGE_SIZE=2000——直灌 repo 层造 2001 行（绕开 push 500 条批限
  // 与限流桶）。水位线基线=当前 max(seq)（与前面用例的行隔离）
  const before0 = await json(await pull('?since=0'));
  const watermark = Math.max(0, ...before0.body.items.map(i => i.seq));
  await syncItems.applyChanges('default', Array.from({ length: 2001 }, (_, i) => ({
    key: `doc:pg${String(i).padStart(5, '0')}`,
    value: i, updatedAt: 9e12 + i, deleted: false,
  })));
  const p1 = await json(await pull(`?since=${watermark}`));
  assert.equal(p1.body.items.length, 2000);
  assert.equal(p1.body.hasMore, true);
  assert.equal(p1.body.nextCursor, undefined); // 契约退役——游标即末行 seq
  const p2 = await json(await pull(`?since=${p1.body.items.at(-1).seq}`));
  assert.equal(p2.body.items.length, 1);
  assert.equal(p2.body.hasMore, undefined);
  // 两页合起来 2001 行不重不漏
  const keys = new Set([...p1.body.items, ...p2.body.items].map(i => i.key));
  assert.equal(keys.size, 2001);
});

// 以下三个用例必须在分页用例之后：本文件 pull('?since=0') 的水位线基线
// 依赖「全表小行一次拿完」——8.8MB 的 doc:bz* 若先入册会让该拉取被字节
// 预算截页（这正是要测的行为），分页用例的 max(seq) 基线随之失真
test('sync push：deleted 严格布尔——字符串 "false"/数字 1 不产墓碑', async () => {
  const r = await json(await push({
    changes: [
      { key: 'doc:strict1', value: { v: 'alive' }, updatedAt: 4000, deleted: 'false' },
      { key: 'doc:strict2', value: 'v', updatedAt: 4001, deleted: 1 },
    ]
  }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.applied.sort(), ['doc:strict1', 'doc:strict2']);
  // 旧行为 Boolean('false')===true：活数据被写成墓碑——数据丢失方向回归钉
  const i1 = syncItems.getItem('default', 'doc:strict1');
  assert.equal(i1.deleted, false);
  assert.deepEqual(i1.value, { v: 'alive' });
  assert.equal(syncItems.getItem('default', 'doc:strict2').deleted, false);
  // 真墓碑路径不受影响
  await push({ changes: [{ key: 'doc:strict1', updatedAt: 4002, deleted: true }] });
  assert.equal(syncItems.getItem('default', 'doc:strict1').deleted, true);
});

test('sync push 字节预算：整批 value 总字节>4MB 整批 400 不落一条', async () => {
  // 20 条 × ~225KB：每条都过 256KB 单值闸，累计 ~4.4MB 超整批预算——
  // 此前无总量闸，限流只管次数管不了这种体量膨胀
  const r = await push({
    changes: Array.from({ length: 20 }, (_, i) => ({
      key: `doc:bb${String(i).padStart(2, '0')}`, value: 'x'.repeat(220 * 1024), updatedAt: 5000 + i,
    })),
  });
  assert.equal(r.status, 400);
  assert.equal(syncItems.getItem('default', 'doc:bb00'), undefined);
  // 预算内的同形态批照常落库——闸按总字节不按条数
  const ok = await push({
    changes: Array.from({ length: 8 }, (_, i) => ({
      key: `doc:bs${i}`, value: 'x'.repeat(200 * 1024), updatedAt: 6000 + i,
    })),
  });
  assert.equal(ok.status, 200);
});

test('sync pull 字节预算：单页 >8MB 按字节截页 hasMore；seq 续拉不重不漏', async () => {
  // repo 层直灌绕开 push 批量闸。先拿真水位线（probe 行 seq 必为当前 max——
  // 库里已有 2001 行分页钉子，?since=0 的第一页只回前 2000 行，不能直接
  // 取它算 max）
  await syncItems.applyChanges('default', [
    { key: 'doc:bz-probe', value: 0, updatedAt: 9e12, deleted: false },
  ]);
  const watermark = syncItems.getItem('default', 'doc:bz-probe').seq;
  // 40 条 × ~220KB ≈ 8.8MB——按条数远没到 2000，纯字节预算截页
  await syncItems.applyChanges('default', Array.from({ length: 40 }, (_, i) => ({
    key: `doc:bz${String(i).padStart(3, '0')}`,
    value: 'z'.repeat(220 * 1024), updatedAt: 9e12 + 1000 + i, deleted: false,
  })));
  const p1 = await json(await pull(`?since=${watermark}`));
  assert.equal(p1.status, 200);
  assert.equal(p1.body.hasMore, true);
  assert.ok(p1.body.items.length > 0 && p1.body.items.length < 40,
    `字节截页应放出部分行（预算内尽量多），实得 ${p1.body.items.length}`);
  // 页末行 seq 喂回 since 续拉——keyset 语义在字节截页下不变：不重不漏收全
  const seen = new Set(p1.body.items.map(i => i.key));
  let since = p1.body.items.at(-1).seq;
  while (true) {
    const p = await json(await pull(`?since=${since}`));
    assert.equal(p.status, 200);
    for (const it of p.body.items) {
      assert.equal(seen.has(it.key), false, `重复下发 ${it.key}`);
      seen.add(it.key);
    }
    if (!p.body.hasMore) break;
    since = p.body.items.at(-1).seq;
  }
  assert.equal(seen.size, 40);
});

// 限流收尾——把桶打满会影响后续用例，留最后跑；TRUST_PROXY+XFF 换 IP
// 证明桶按 IP 独立（'local' 桶灌满不误伤别家）
test('sync push 限流：sync-push 30/min per-IP 独立桶', async () => {
  process.env.TRUST_PROXY = '1';
  try {
    const ipA = { 'x-forwarded-for': '10.9.9.1' };
    let last;
    for (let i = 0; i < 30; i++) {
      last = await push({ changes: [{ key: 'doc:rl', value: i, updatedAt: 1000 + i }] }, ipA);
      assert.equal(last.status, 200, `第 ${i + 1} 次`);
    }
    const over = await push({ changes: [{ key: 'doc:rl', value: 99, updatedAt: 2000 }] }, ipA);
    assert.equal(over.status, 429);
    // 另一 IP 同刻不受限——桶独立
    const other = await push({ changes: [{ key: 'doc:rl', value: 1, updatedAt: 2001 }] },
      { 'x-forwarded-for': '10.9.9.2' });
    assert.equal(other.status, 200);
  } finally {
    delete process.env.TRUST_PROXY;
  }
});

test('sync pull 限流：sync-pull 30/min per-IP 独立桶（与 push 桶互不相通）', async () => {
  process.env.TRUST_PROXY = '1';
  try {
    const ipB = { 'x-forwarded-for': '10.9.9.9' };
    let last;
    for (let i = 0; i < 30; i++) {
      last = await pull('', ipB);
      assert.equal(last.status, 200, `第 ${i + 1} 次`);
    }
    assert.equal((await pull('', ipB)).status, 429);
    // 同 IP 的 push 桶独立——pull 灌满不误伤写
    const wr = await push({ changes: [{ key: 'doc:rlx', value: 1, updatedAt: 1 }] }, ipB);
    assert.equal(wr.status, 200);
    // 另一 IP pull 不受限
    assert.equal((await pull('', { 'x-forwarded-for': '10.9.9.10' })).status, 200);
  } finally {
    delete process.env.TRUST_PROXY;
  }
});

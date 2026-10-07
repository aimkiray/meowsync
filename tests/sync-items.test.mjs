// syncItems repo 回归网：LWW 三向（新写赢/旧写拒/平局留旧）、墓碑行读写、
// user 分域隔离、seq 域交付水位线（写方钟慢仍下发/被拒行不跳号/覆写拿新
// seq/seq 续拉分页/since 越顶自愈全量重发）、老库 seq 补列迁移回填、
// 单页字节预算的页首行豁免。
// DATA_DIR 指向临时目录，db/client 首次 require 时在该处建库跑迁移。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-syncitems-');
const require = createRequire(import.meta.url);

let repo;
before(() => {
  repo = require('../src/server/repositories/syncItems.js');
});
after(() => { rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

test('syncItems LWW：新写赢 / 旧写拒 / 平局服务端留旧', () => {
  const u = 'u-lww';
  // 首写入行
  let r = repo.applyChanges(u, [{ key: 'doc:a', value: { v: 1 }, updatedAt: 1000, deleted: false }]);
  assert.deepEqual(r.applied, ['doc:a']);
  assert.equal(r.conflicts.length, 0);
  const first = repo.getItem(u, 'doc:a');
  assert.deepEqual(first.value, { v: 1 });
  assert.equal(first.updatedAt, 1000);
  assert.equal(first.deleted, false);
  assert.equal(typeof first.seq, 'number');

  // 旧写（更小 updated_at）→ 拒 + conflicts 回包服务端现值（item 带 key/seq）
  r = repo.applyChanges(u, [{ key: 'doc:a', value: { v: 0 }, updatedAt: 900, deleted: false }]);
  assert.equal(r.applied.length, 0);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].key, 'doc:a');
  assert.equal(r.conflicts[0].item.key, 'doc:a');
  assert.equal(r.conflicts[0].item.updatedAt, 1000);
  assert.equal(r.conflicts[0].item.seq, first.seq);
  assert.deepEqual(r.conflicts[0].item.value, { v: 1 });
  // 库内未被覆写
  assert.equal(repo.getItem(u, 'doc:a').value.v, 1);

  // 平局（同 updated_at）→ 服务端留旧，仍入 conflicts
  r = repo.applyChanges(u, [{ key: 'doc:a', value: { v: 9 }, updatedAt: 1000, deleted: false }]);
  assert.equal(r.applied.length, 0);
  assert.equal(r.conflicts[0].item.value.v, 1);

  // 新写（更大 updated_at）→ 覆写
  r = repo.applyChanges(u, [{ key: 'doc:a', value: { v: 2 }, updatedAt: 1500, deleted: false }]);
  assert.deepEqual(r.applied, ['doc:a']);
  assert.equal(repo.getItem(u, 'doc:a').value.v, 2);
});

test('syncItems seq：applied 单调递增；覆写拿新 seq；被拒行不消耗 seq', () => {
  const u = 'u-seq';
  repo.applyChanges(u, [{ key: 'doc:s1', value: 1, updatedAt: 100, deleted: false }]);
  const s1 = repo.getItem(u, 'doc:s1').seq;
  repo.applyChanges(u, [{ key: 'doc:s2', value: 1, updatedAt: 100, deleted: false }]);
  const s2 = repo.getItem(u, 'doc:s2').seq;
  assert.ok(s2 > s1, 'applied 写 seq 递增');
  // 被拒（过期写）不取号——水位线无跳号
  const rej = repo.applyChanges(u, [{ key: 'doc:s2', value: 0, updatedAt: 50, deleted: false }]);
  assert.equal(rej.applied.length, 0);
  // 覆写拿新 seq：紧接被拒写之后的 applied 恰好取下一号（拒绝无消耗钉死）
  repo.applyChanges(u, [{ key: 'doc:s1', value: 2, updatedAt: 200, deleted: false }]);
  const s1b = repo.getItem(u, 'doc:s1').seq;
  assert.equal(s1b, s2 + 1, '被拒行不消耗 seq——覆写拿到的恰是下一号');
  // 旧 seq 位的续拉能看到覆写后新态（覆盖写不拿新号=永久跳过回归钉）
  const inc = repo.listChanges(u, { since: s2 });
  assert.deepEqual(inc.items.map(i => i.key), ['doc:s1']);
  assert.equal(inc.items[0].value, 2);
  assert.equal(inc.items[0].seq, s1b);
});

test('syncItems seq 域交付：写方钟慢（updatedAt 远落后）的写仍按序下发', () => {
  const u = 'u-slowclock';
  repo.applyChanges(u, [{ key: 'doc:c1', value: 1, updatedAt: 1_700_000_000_000, deleted: false }]);
  const base = repo.getItem(u, 'doc:c1').seq;
  // 钟慢设备的写：updatedAt 远小于其它端已发的戳——旧 updated_at>since
  // 语义下这类写永不下发（水位线混用回归钉）；seq 域拿新号照常在序
  repo.applyChanges(u, [{ key: 'doc:c2', value: 'slow', updatedAt: 1000, deleted: false }]);
  const inc = repo.listChanges(u, { since: base });
  assert.deepEqual(inc.items.map(i => i.key), ['doc:c2']);
  assert.equal(inc.items[0].value, 'slow');
  // updatedAt 原样透传——它仍是 LWW 判优钟，只是不再参与交付序
  assert.equal(inc.items[0].updatedAt, 1000);
});

test('syncItems 墓碑：deleted 行读写往返、增量可见、后写 deleted=0 复活', () => {
  const u = 'u-tomb';
  repo.applyChanges(u, [{ key: 'playlist:p1', value: { name: '单' }, updatedAt: 100, deleted: false }]);
  // 删除=墓碑行：value_json 归一 'null'，pull 回 deleted:true + value:null
  const r = repo.applyChanges(u, [{ key: 'playlist:p1', value: { name: '残留载荷' }, updatedAt: 200, deleted: true }]);
  assert.deepEqual(r.applied, ['playlist:p1']);
  const tomb = repo.getItem(u, 'playlist:p1');
  assert.equal(tomb.deleted, true);
  assert.equal(tomb.value, null);
  assert.equal(tomb.updatedAt, 200);
  // 增量拉取必须含墓碑——删除才能跨端传播（墓碑覆写本身拿新 seq）
  const inc = repo.listChanges(u, { since: tomb.seq - 1 });
  assert.equal(inc.items.length, 1);
  assert.equal(inc.items[0].deleted, true);
  // 早于墓碑戳的"复活"写 → 拒（墓碑赢）
  const stale = repo.applyChanges(u, [{ key: 'playlist:p1', value: { name: 'x' }, updatedAt: 150, deleted: false }]);
  assert.equal(stale.applied.length, 0);
  assert.equal(stale.conflicts[0].item.deleted, true);
  // 同 key 后写 deleted=0 覆盖墓碑 → 复活
  const rev = repo.applyChanges(u, [{ key: 'playlist:p1', value: { name: '复活' }, updatedAt: 300, deleted: false }]);
  assert.deepEqual(rev.applied, ['playlist:p1']);
  const alive = repo.getItem(u, 'playlist:p1');
  assert.equal(alive.deleted, false);
  assert.equal(alive.value.name, '复活');
});

test('syncItems user 分域：A 不读 B 的行；同 key 两桶互不干扰', () => {
  repo.applyChanges('user-a', [{ key: 'doc:same', value: 'A的', updatedAt: 1000, deleted: false }]);
  repo.applyChanges('user-b', [{ key: 'doc:same', value: 'B的', updatedAt: 500, deleted: false }]);
  assert.equal(repo.getItem('user-a', 'doc:same').value, 'A的');
  assert.equal(repo.getItem('user-b', 'doc:same').value, 'B的');
  // user-c 完全无行——同 key 也不存在
  assert.equal(repo.getItem('user-c', 'doc:same'), undefined);
  assert.equal(repo.listChanges('user-c', { since: 0 }).items.length, 0);
  // B 的增量扫只出 B 行
  const bOnly = repo.listChanges('user-b', { since: 0 });
  assert.ok(bOnly.items.every(i => i.value === 'B的'));
});

test('syncItems since=seq 域：seq > since 严格大于；交付序=取号序非时戳序', () => {
  const u = 'u-since';
  // updatedAt 故意乱序——交付序跟取号序（批内数组序）走，不是时戳序
  repo.applyChanges(u, [
    { key: 'doc:k1', value: 1, updatedAt: 300, deleted: false },
    { key: 'doc:k2', value: 2, updatedAt: 50, deleted: false },
    { key: 'doc:k3', value: 3, updatedAt: 200, deleted: false },
    { key: 'doc:k4', value: 4, updatedAt: 100, deleted: false },
  ]);
  const seqOf = (k) => repo.getItem(u, k).seq;
  // 全量（since=0）按 seq 定序
  const all = repo.listChanges(u, { since: 0 });
  assert.deepEqual(all.items.map(i => i.key), ['doc:k1', 'doc:k2', 'doc:k3', 'doc:k4']);
  assert.equal(all.hasMore, false);
  // since=seq(k2) → 严格大于：k2 不回，k3/k4 回
  const inc = repo.listChanges(u, { since: seqOf('doc:k2') });
  assert.deepEqual(inc.items.map(i => i.key), ['doc:k3', 'doc:k4']);
  // since=seq(k4)=末尾 → 空页
  assert.equal(repo.listChanges(u, { since: seqOf('doc:k4') }).items.length, 0);
});

test('syncItems since 越顶自愈：>本桶 max(seq) 按全量重发；max 限本 user 行', () => {
  const u = 'u-stale';
  repo.applyChanges(u, [
    { key: 'doc:r1', value: 1, updatedAt: 10, deleted: false },
    { key: 'doc:r2', value: 2, updatedAt: 20, deleted: false },
  ]);
  const ownMax = repo.getItem(u, 'doc:r2').seq;
  // 别桶继续取号把全表 max(seq) 推高——seq 计数器全局共享，若误用全表
  // max 判定，本桶「合法超顶」会被当成正常增量而永空停摆
  repo.applyChanges('u-stale-other', [
    { key: 'doc:o1', value: 1, updatedAt: 1, deleted: false },
    { key: 'doc:o2', value: 2, updatedAt: 2, deleted: false },
    { key: 'doc:o3', value: 3, updatedAt: 3, deleted: false },
  ]);
  // since 落在 (本桶max, 全表max]：对本桶是超顶 → 全量重发 + reset 标记
  const mid = repo.listChanges(u, { since: ownMax + 2 });
  assert.equal(mid.reset, true);
  assert.deepEqual(mid.items.map(i => i.key), ['doc:r1', 'doc:r2']);
  // 旧契约 ms 时钟域存量大数（~1.7e12）同路自愈——首拉即拿全量
  const legacy = repo.listChanges(u, { since: 1_700_000_000_000 });
  assert.equal(legacy.reset, true);
  assert.equal(legacy.items.length, 2);
  // 正常增量不受影响：水位线内 since 不触发 reset，严格大于语义不变
  const inc = repo.listChanges(u, { since: repo.getItem(u, 'doc:r1').seq });
  assert.equal(inc.reset, false);
  assert.deepEqual(inc.items.map(i => i.key), ['doc:r2']);
  // since==本桶max（幂等尾页）不算越顶
  const tail = repo.listChanges(u, { since: ownMax });
  assert.equal(tail.reset, false);
  assert.equal(tail.items.length, 0);
  // 空桶：max(seq)=0，任何 since>0 都走全量口径（空集）——全表有行
  // 也不影响判定（per-user 钉死）
  const empty = repo.listChanges('u-stale-empty', { since: 99 });
  assert.equal(empty.reset, true);
  assert.equal(empty.items.length, 0);
});

test('syncItems 分页：limit+1 探测 hasMore；断连后 since=末行seq 续拉不重不漏', () => {
  const u = 'u-page';
  repo.applyChanges(u, [
    { key: 'doc:pa', value: 'a', updatedAt: 10, deleted: false },
    { key: 'doc:pb', value: 'b', updatedAt: 10, deleted: false },
    { key: 'doc:pc', value: 'c', updatedAt: 10, deleted: false },
    { key: 'doc:pd', value: 'd', updatedAt: 20, deleted: false },
    { key: 'doc:pe', value: 'e', updatedAt: 30, deleted: false },
  ]);
  const p1 = repo.listChanges(u, { since: 0, limit: 2 });
  assert.deepEqual(p1.items.map(i => i.key), ['doc:pa', 'doc:pb']);
  assert.equal(p1.hasMore, true);
  // 断连重连续拉：客户端拿末行 seq 作 since（无 nextCursor——游标即水位线）
  const p2 = repo.listChanges(u, { since: p1.items.at(-1).seq, limit: 2 });
  assert.deepEqual(p2.items.map(i => i.key), ['doc:pc', 'doc:pd']);
  assert.equal(p2.hasMore, true);
  const p3 = repo.listChanges(u, { since: p2.items.at(-1).seq, limit: 2 });
  assert.deepEqual(p3.items.map(i => i.key), ['doc:pe']);
  assert.equal(p3.hasMore, false);
  // 越过末尾 → 空页（幂等尾页，客户端停拉）
  const p4 = repo.listChanges(u, { since: p3.items.at(-1).seq, limit: 2 });
  assert.equal(p4.items.length, 0);
  assert.equal(p4.hasMore, false);
});

test('syncItems 迁移：老库无 seq 列——ALTER 补列+rowid 序回填+计数器初始化', () => {
  // 造旧 schema 库（sync_items 无 seq/sync_meta 整表缺）后换 DATA_DIR
  // 重 require——initSchema 即新进程视角的启动迁移
  const oldDir = tmpDataDir('meowsync-oldschema-');
  const Database = require('better-sqlite3');
  const pre = new Database(join(oldDir, 'meowsync.sqlite'));
  pre.exec(`
    CREATE TABLE sync_items (
      user_id TEXT NOT NULL,
      item_key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      recv_at INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, item_key)
    );
    INSERT INTO sync_items (user_id, item_key, value_json, updated_at, recv_at, deleted)
    VALUES ('u1','doc:old1','1',100,100,0),
           ('u1','doc:old2','2',200,200,0),
           ('u2','doc:old3','3',300,300,0);
  `);
  pre.close();

  const clientPath = require.resolve('../src/server/db/client.js');
  const itemsPath = require.resolve('../src/server/repositories/syncItems.js');
  const savedClient = require.cache[clientPath];
  const savedItems = require.cache[itemsPath];
  const prevDir = process.env.DATA_DIR;
  let migDb = null;
  try {
    process.env.DATA_DIR = oldDir;
    delete require.cache[clientPath];
    delete require.cache[itemsPath];
    const migRepo = require('../src/server/repositories/syncItems.js');
    migDb = require('../src/server/db/client.js').getDb();

    // 列已补 + 存量行按 rowid 序单调回填
    const cols = migDb.prepare('PRAGMA table_info(sync_items)').all().map(c => c.name);
    assert.ok(cols.includes('seq'), '老库补出 seq 列');
    const rows = migDb.prepare('SELECT item_key, seq FROM sync_items ORDER BY seq').all();
    assert.deepEqual(rows.map(r => r.item_key), ['doc:old1', 'doc:old2', 'doc:old3']);
    assert.ok(rows[0].seq < rows[1].seq && rows[1].seq < rows[2].seq, '回填 seq 单调');
    // 计数器初始化到 max(seq)——新写从计数器继续发号不撞回填段
    const counter = migDb.prepare("SELECT v FROM sync_meta WHERE k = 'sync_seq'").get().v;
    assert.equal(counter, rows[2].seq);
    migRepo.applyChanges('u1', [{ key: 'doc:new', value: 9, updatedAt: 1, deleted: false }]);
    assert.equal(migRepo.getItem('u1', 'doc:new').seq, counter + 1);
    // seq 域拉取覆盖存量回填行与新行
    assert.equal(migRepo.listChanges('u1', { since: 0 }).items.length, 3);
    // 旧时钟域索引退役、seq 索引在册
    const idx = migDb.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sync_items'"
    ).all().map(r => r.name);
    assert.ok(idx.includes('idx_sync_items_user_seq'));
    assert.ok(!idx.includes('idx_sync_items_user_updated'));
  } finally {
    migDb?.close();
    process.env.DATA_DIR = prevDir;
    // 还原 require.cache——后续用例继续吃主 DATA_DIR 的 repo 单例
    delete require.cache[clientPath];
    delete require.cache[itemsPath];
    if (savedClient) require.cache[clientPath] = savedClient;
    if (savedItems) require.cache[itemsPath] = savedItems;
    rmSync(oldDir, { recursive: true, force: true });
  }
});

test('syncItems 字节预算：页首行豁免——单行超 maxBytes 也发出，防卡页死循环', () => {
  const u = 'u-bigrow';
  // 存量巨型单行（迁移前写入/手工改库可超 256KB）：若首行也吃字节闸，
  // 每页都算出空页+hasMore——该端永远卡在这一页
  repo.applyChanges(u, [
    { key: 'doc:huge', value: 'x'.repeat(9 * 1024 * 1024), updatedAt: 10, deleted: false },
    { key: 'doc:after', value: 's', updatedAt: 20, deleted: false },
  ]);
  const maxBytes = 8 * 1024 * 1024; // 与路由 MAX_PAGE_BYTES 同口径
  const p1 = repo.listChanges(u, { since: 0, maxBytes });
  assert.deepEqual(p1.items.map(i => i.key), ['doc:huge']); // 首行豁免放行
  assert.equal(p1.hasMore, true); // 次行起预算闸恢复生效
  const p2 = repo.listChanges(u, { since: p1.items.at(-1).seq, maxBytes });
  assert.deepEqual(p2.items.map(i => i.key), ['doc:after']);
  assert.equal(p2.hasMore, false);
});

test('syncItems valueJsonOf：墓碑恒 null；undefined 归一 null', () => {
  assert.equal(repo.valueJsonOf({ value: { a: 1 }, deleted: true }), 'null');
  assert.equal(repo.valueJsonOf({ value: undefined, deleted: false }), 'null');
  assert.equal(repo.valueJsonOf({ value: 0, deleted: false }), '0');
});

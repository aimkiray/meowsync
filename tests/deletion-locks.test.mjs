// deletion-locks：墓碑 TTL 绑在途导入计数——多腿串行抓取（detail+每500曲一腿
// 各120s上限）可远超固定 130s，纯 TTL 会在慢上游下让已删歌单复活
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const locks = require('../src/server/lib/deletion-locks.js');

test('在途导入未归零时墓碑维持 Infinity，归零才转 TTL', () => {
  locks.beginNeteasePlaylistImport('900');
  locks.markNeteasePlaylistDeleted('900');
  assert.equal(locks.deletingNeteasePlaylists.get('900'), Infinity);
  assert.ok(locks.isNeteasePlaylistDeleting('900'));

  locks.endNeteasePlaylistImport('900');
  const expiresAt = locks.deletingNeteasePlaylists.get('900');
  assert.ok(Number.isFinite(expiresAt) && expiresAt > Date.now());
  assert.ok(locks.isNeteasePlaylistDeleting('900'));
});

test('并发多腿导入：最后一腿归零才降级', () => {
  locks.beginNeteasePlaylistImport('901');
  locks.beginNeteasePlaylistImport('901');
  locks.markNeteasePlaylistDeleted('901');

  locks.endNeteasePlaylistImport('901'); // 还剩一腿在途
  assert.equal(locks.deletingNeteasePlaylists.get('901'), Infinity);

  locks.endNeteasePlaylistImport('901'); // 归零 → TTL 起算
  assert.ok(Number.isFinite(locks.deletingNeteasePlaylists.get('901')));
});

test('无在途导入时墓碑照常走 TTL', () => {
  locks.markNeteasePlaylistDeleted('902');
  assert.ok(Number.isFinite(locks.deletingNeteasePlaylists.get('902')));
});

test('end 幂等：无 begin 配对的 end 不崩不污染', () => {
  locks.endNeteasePlaylistImport('903');
  assert.equal(locks.deletingNeteasePlaylists.get('903'), undefined);
  assert.ok(!locks.isNeteasePlaylistDeleting('903'));
});

test('TTL 到期：isNeteasePlaylistDeleting 惰性摘除过期墓碑并判活', () => {
  locks.markNeteasePlaylistDeleted('904');
  const expiresAt = locks.deletingNeteasePlaylists.get('904');
  // 登记窗 ≈130s（NETEASE_TOMBSTONE_TTL_MS——导入多腿抓取上限的余量）
  assert.ok(expiresAt - Date.now() <= 130_000 && expiresAt > Date.now());
  // 时间越过期点（直接改写墓碑时刻模拟——比真等 130s 或 monkeypatch
  // Date.now 更能钉「过期即摘」这条惰性清除分支）
  locks.deletingNeteasePlaylists.set('904', Date.now() - 1);
  assert.equal(locks.isNeteasePlaylistDeleting('904'), false);
  // 惰性摘除落位：过期项从 Map 消失（不留给清扫器重复收拾）
  assert.equal(locks.deletingNeteasePlaylists.has('904'), false);
});

test('Infinity 墓碑不因时钟到期被误摘（在途导入期间的删除永不过期）', () => {
  locks.beginNeteasePlaylistImport('905');
  locks.markNeteasePlaylistDeleted('905');
  assert.equal(locks.deletingNeteasePlaylists.get('905'), Infinity);
  // 即便外部把键读回再判——Infinity > 任何时刻，惰性清除分支不触发
  assert.ok(locks.isNeteasePlaylistDeleting('905'));
  locks.endNeteasePlaylistImport('905'); // 收尾转 TTL，不残留 Infinity
  assert.ok(Number.isFinite(locks.deletingNeteasePlaylists.get('905')));
});

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

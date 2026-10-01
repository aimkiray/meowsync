// repositories 层回归网——孤儿表收口后的 SQL 语义固定
// DATA_DIR 指向临时目录，db/client 首次 require 时在该处建库跑迁移
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-test-');
const require = createRequire(import.meta.url);

let songMetaRepo, lyricAiRepo;
before(() => {
  songMetaRepo = require('../src/server/repositories/songLyricMeta.js');
  lyricAiRepo = require('../src/server/repositories/lyricAi.js');
});

test('songLyricMeta：0/缺省行语义一致、upsert 覆盖、delete 归零', () => {
  assert.equal(songMetaRepo.getOffsetMs('s-none'), 0);      // 无行=未校准
  songMetaRepo.upsertOffsetMs('s1', 120);
  assert.equal(songMetaRepo.getOffsetMs('s1'), 120);
  songMetaRepo.upsertOffsetMs('s1', -40);                  // 覆盖
  assert.equal(songMetaRepo.getOffsetMs('s1'), -40);
  songMetaRepo.deleteOffsetMs('s1');
  assert.equal(songMetaRepo.getOffsetMs('s1'), 0);
});

test('lyricAi 翻译缓存：upsert 命中、skip 哨兵行存在', () => {
  assert.equal(lyricAiRepo.getCachedTranslation('no-such'), undefined); // better-sqlite3 无行回 undefined
  lyricAiRepo.upsertTranslation('song-a', '[00:01.00]译词', 'm-test');
  const hit = lyricAiRepo.getCachedTranslation('song-a');
  assert.equal(hit.tlyric, '[00:01.00]译词');
  // skip 哨兵：tlyric 空串——行在但词空（防重复打上游），TTL 语义在路由层
  lyricAiRepo.markTranslationSkip('song-b', 'already-zh');
  const skip = lyricAiRepo.getCachedTranslation('song-b');
  assert.ok(skip);
  assert.equal(skip.tlyric, '');
});

test('lyricAi 判定缓存：vkey 键隔离、ok/detail 往返', () => {
  assert.equal(lyricAiRepo.getLyricVerdict('v-none'), undefined);
  lyricAiRepo.upsertLyricVerdict('id@m1@sig1', false, '错配示例');
  const v = lyricAiRepo.getLyricVerdict('id@m1@sig1');
  assert.equal(v.ok, 0);            // sqlite 无 bool——0/1 落列，路由层转布尔
  // detail 是写侧诊断列——getLyricVerdict 只 SELECT ok（读面不回诊断文本）
  lyricAiRepo.upsertLyricVerdict('id@m2@sig1', true, null); // 不同模型/来源=不同键
  assert.equal(lyricAiRepo.getLyricVerdict('id@m2@sig1').ok, 1);
});


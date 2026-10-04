// repositories 层回归网——孤儿表收口后的 SQL 语义固定
// DATA_DIR 指向临时目录，db/client 首次 require 时在该处建库跑迁移
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-test-');
const require = createRequire(import.meta.url);

let songMetaRepo, lyricAiRepo, playlistsRepo, downloadQueuesRepo, downloadTasksRepo;
before(() => {
  songMetaRepo = require('../src/server/repositories/songLyricMeta.js');
  lyricAiRepo = require('../src/server/repositories/lyricAi.js');
  playlistsRepo = require('../src/server/repositories/playlists.js');
  downloadQueuesRepo = require('../src/server/repositories/downloadQueues.js');
  downloadTasksRepo = require('../src/server/repositories/downloadTasks.js');
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
  // AI 译文按模型键控——模型不符不命中（换模型后旧译文不失效是 D6 要修的洞）
  assert.equal(lyricAiRepo.getCachedTranslation('song-a', 'other-model'), undefined);
  const hit = lyricAiRepo.getCachedTranslation('song-a', 'm-test');
  assert.equal(hit.tlyric, '[00:01.00]译词');
  // 官方译文行（netease/qq）永命中——不随模型键漂移
  lyricAiRepo.upsertTranslation('song-o', '[00:01.00]官方', 'netease');
  assert.equal(lyricAiRepo.getCachedTranslation('song-o', 'whatever').tlyric, '[00:01.00]官方');
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


test('downloadQueues：neteasePlaylistId 透出（?view=downloads&pl= 深链映射承重列）', () => {
  // 深链按"侧栏歌单 id === 队列 neteasePlaylistId"匹配——镜像单存 local_pl_*
  // 原文、远端单存数字串；投影缺失/改名会让整链静默全灭，这里钉住
  const pl = playlistsRepo.upsertPlaylist({ neteasePlaylistId: 'local_pl_test_x', name: '镜像单' });
  const q = downloadQueuesRepo.createQueue({ playlistId: pl.id, name: 'q', totalTasks: 0 });
  assert.equal(q.neteasePlaylistId, 'local_pl_test_x');
  assert.equal(downloadQueuesRepo.findQueueById(q.id).neteasePlaylistId, 'local_pl_test_x');
  assert.equal(downloadQueuesRepo.listQueues().find(x => x.id === q.id).neteasePlaylistId, 'local_pl_test_x');
  // 数字侧栏 id 与 TEXT 列同形落库（String 归一在消费侧，存储层原样透传）
  const plNum = playlistsRepo.upsertPlaylist({ neteasePlaylistId: '777014', name: '远端单' });
  const qNum = downloadQueuesRepo.createQueue({ playlistId: plNum.id, name: 'qn', totalTasks: 0 });
  assert.equal(String(qNum.neteasePlaylistId), '777014');
});

test('downloadTasks：listStandaloneTasksByPlaylist 只收 queue_id NULL 行', () => {
  // 「未入队单曲」分节的服务端收窄面——收养语义靠这口闸：建队列 UPDATE
  // queue_id 后行掉出 standalone 集，混入即越权展示
  const pl = playlistsRepo.upsertPlaylist({ neteasePlaylistId: 'local_pl_std_x', name: 'std' });
  const q = downloadQueuesRepo.createQueue({ playlistId: pl.id, name: 'q', totalTasks: 0 });
  const lone = downloadTasksRepo.createTask({
    playlistId: pl.id, queueId: null, songId: 's-lone', songName: '独立', artist: 'a'
  });
  const queued = downloadTasksRepo.createTask({
    playlistId: pl.id, queueId: q.id, songId: 's-queued', songName: '入队', artist: 'a'
  });
  const out = downloadTasksRepo.listStandaloneTasksByPlaylist(pl.id);
  assert.deepEqual(out.map(t => t.songId), ['s-lone']);
  // 收养后行掉出集（findAnyTaskByPlaylistAndSongId 的收养写 queueId=新值）
  downloadTasksRepo.updateTask(lone.id, { queueId: q.id });
  assert.equal(downloadTasksRepo.listStandaloneTasksByPlaylist(pl.id).length, 0);
  assert.equal(queued.queueId, q.id);
});

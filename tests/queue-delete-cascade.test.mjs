// 管理页「删除歌单」= DELETE /downloads/queues/:id：队列行只是歌单下载足迹的
// 视图句柄，删除升级为歌单级联——同歌单的 standalone 单曲任务、歌单登记行与
// 盘上文件一并清理；邻歌单资产与本地上传伪歌单必须幸存。
// DATA_DIR 临时化：真路由真存储真 DB，不打桩。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-qdel-');
const require = createRequire(import.meta.url);

let app, tasksRepo, queuesRepo, playlistsRepo, downloadFs;
before(() => {
  app = require('../src/server/routes/downloads.js');
  tasksRepo = require('../src/server/repositories/downloadTasks.js');
  queuesRepo = require('../src/server/repositories/downloadQueues.js');
  playlistsRepo = require('../src/server/repositories/playlists.js');
  downloadFs = require('../src/server/services/download-fs.js');
});

const del = (queueId) => app.request(`http://t/downloads/queues/${queueId}`, { method: 'DELETE' });

// 种一张歌单 + 一个 completed 任务 + 盘上文件；queueId 缺省 = standalone 单曲任务
function seedDownload(neteaseId, { queue = true } = {}) {
  const pl = playlistsRepo.upsertPlaylist({ neteasePlaylistId: neteaseId, name: `pl-${neteaseId}` });
  const q = queue ? queuesRepo.createQueue({ playlistId: pl.id, name: pl.name, status: 'completed', totalTasks: 1 }) : null;
  const task = tasksRepo.createTask({
    playlistId: pl.id, queueId: q?.id ?? null, songId: `${neteaseId}001`,
    songName: '歌', artist: '艺人', status: 'completed', downloadAudio: true
  });
  const audioPath = join(downloadFs.DOWNLOAD_BASE_DIR, String(pl.id), 'audio', `${task.songId}.mp3`);
  mkdirSync(join(audioPath, '..'), { recursive: true });
  writeFileSync(audioPath, `audio-bytes-${neteaseId}`);
  tasksRepo.updateTask(task.id, { audioPath });
  return { pl, queue: q, task: tasksRepo.findTaskById(task.id), audioPath };
}

test('删除队列级联清空歌单足迹：任务/队列/歌单行与盘上文件全清', async () => {
  const { pl, queue, audioPath } = seedDownload('777001');
  // 同歌单的 standalone 单曲下载（playlist 页逐曲下，queue_id=NULL）——
  // 窄删时代的残留面：行在、文件在、收割器视作在册永不清理
  const soloTask = tasksRepo.createTask({
    playlistId: pl.id, songId: '777001solo', songName: '单曲', artist: '乙',
    status: 'completed', downloadAudio: true
  });
  const soloPath = join(downloadFs.DOWNLOAD_BASE_DIR, String(pl.id), 'audio', 'solo.mp3');
  writeFileSync(soloPath, 'solo-bytes');
  tasksRepo.updateTask(soloTask.id, { audioPath: soloPath });

  const res = await del(queue.id);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).data.success, true);

  assert.equal(queuesRepo.findQueueById(queue.id), null);
  assert.equal(tasksRepo.listTasksByPlaylist(pl.id).length, 0);
  assert.equal(playlistsRepo.findPlaylistById(pl.id), null);
  assert.equal(existsSync(audioPath), false);
  assert.equal(existsSync(soloPath), false);
  // 空目录骨架也收掉
  assert.equal(existsSync(join(downloadFs.DOWNLOAD_BASE_DIR, String(pl.id))), false);
});

test('级联只清目标歌单：邻歌单的队列/任务/文件幸存', async () => {
  const a = seedDownload('777002');
  const b = seedDownload('777003');

  const res = await del(a.queue.id);
  assert.equal(res.status, 200);

  assert.equal(playlistsRepo.findPlaylistById(a.pl.id), null);
  assert.ok(queuesRepo.findQueueById(b.queue.id));
  assert.equal(tasksRepo.listTasksByPlaylist(b.pl.id).length, 1);
  assert.ok(existsSync(b.audioPath));
});

test('local_uploads 伪歌单不可经队列删除级联清空（服务层不变量）', async () => {
  // 伪歌单是全部 file_ 上传资产的登记锚——队列删除升级为级联后，伪歌单上
  // 挂的队列（异常数据形态）绝不能一键清掉所有上传音源
  const { pl, queue, audioPath } = seedDownload('local_uploads');

  const res = await del(queue.id);
  assert.equal(res.status, 400);

  assert.ok(queuesRepo.findQueueById(queue.id));
  assert.equal(tasksRepo.listTasksByPlaylist(pl.id).length, 1);
  assert.ok(playlistsRepo.findPlaylistById(pl.id));
  assert.ok(existsSync(audioPath));
});

test('删除不存在的队列 → 404', async () => {
  const res = await del(999999);
  assert.equal(res.status, 404);
});

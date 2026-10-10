// 管理页「删除歌单」= DELETE /downloads/queues/:id：队列行只是歌单下载足迹的
// 视图句柄，删除升级为歌单级联——同歌单的 standalone 单曲任务、歌单登记行与
// 盘上文件一并清理；邻歌单资产与本地上传伪歌单必须幸存。
// DATA_DIR 临时化：真路由真存储真 DB，不打桩。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { seed, tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-qdel-');
const require = createRequire(import.meta.url);

// 排空测试用 stub：下载函数挂起至 abort——不起真协程就验证不了级联的
// abort+drain 语义（这正是队列删除升级的主要价值面）。必须早于任何
// download-manager 加载（require.cache 播种）
const hangUntilAbort = (...args) => new Promise((_, reject) => {
  const signal = args.find(a => a && typeof a.aborted === 'boolean' && typeof a.addEventListener === 'function');
  const abort = () => reject(Object.assign(new Error('下载已取消'), { name: 'AbortError' }));
  if (signal?.aborted) return abort();
  signal?.addEventListener('abort', abort, { once: true });
});
seed('../src/server/services/file-downloader.js', {
  downloadAudio: hangUntilAbort,
  downloadVideo: hangUntilAbort,
  downloadLyrics: hangUntilAbort,
  downloadCover: hangUntilAbort
});

let app, tasksRepo, queuesRepo, playlistsRepo, playlistTracksRepo, downloadFs, locks, dm;
before(() => {
  app = require('../src/server/routes/downloads.js');
  tasksRepo = require('../src/server/repositories/downloadTasks.js');
  queuesRepo = require('../src/server/repositories/downloadQueues.js');
  playlistsRepo = require('../src/server/repositories/playlists.js');
  playlistTracksRepo = require('../src/server/repositories/playlistTracks.js');
  downloadFs = require('../src/server/services/download-fs.js');
  locks = require('../src/server/lib/deletion-locks.js');
  dm = require('../src/server/services/download-manager.js');
});

const del = (queueId) => app.request(`http://t/downloads/queues/${queueId}`, { method: 'DELETE' });

// 级联的文件清扫是 detached 异步任务（DELETE 响应不再等 fs unlink）——
// 断言盘上文件消失前必须先排空在途清扫，否则断言快过线程池一拍
const drainCleanups = () => Promise.all([...dm.pendingFileCleanups]);

// 种一张歌单 + 一个 completed 任务 + 盘上文件；queueId 缺省 = standalone 单曲任务
function seedDownload(neteaseId, { queue = true } = {}) {
  const pl = playlistsRepo.upsertPlaylist({ neteasePlaylistId: neteaseId, name: `pl-${neteaseId}` });
  const q = queue ? queuesRepo.createQueue({ playlistId: pl.id, name: pl.name, status: 'completed', totalTasks: 1 }) : null;
  const task = tasksRepo.createTask({
    playlistId: pl.id, queueId: q?.id ?? null, songId: `${neteaseId}001`,
    songName: '歌', artist: '艺人', status: 'completed', downloadAudio: true
  });
  const audioPath = join(downloadFs.DOWNLOAD_BASE_DIR, String(pl.id), 'audio', `${task.songId}.mp3`);
  mkdirSync(dirname(audioPath), { recursive: true });
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
  await drainCleanups();
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

test('同歌单多队列连坐删除（deleteQueuesByPlaylist 全量语义）', async () => {
  const { pl, queue } = seedDownload('777010');
  // schema 允许一歌单多队列——管理页删任一行 = 删歌单，兄弟队列随行
  const sibling = queuesRepo.createQueue({ playlistId: pl.id, name: 'sibling', status: 'cancelled', totalTasks: 0 });

  const res = await del(queue.id);
  assert.equal(res.status, 200);
  assert.equal(queuesRepo.findQueueById(sibling.id), null);
  assert.equal(playlistsRepo.findPlaylistById(pl.id), null);
});

test('并发删除同一歌单足迹 → 一路 200 一路 409', async () => {
  const { queue } = seedDownload('777011');
  // cascade 的 deletingPlaylists 在首个 await 前同步登记——顺序发射即确定性命中
  const [first, second] = await Promise.all([del(queue.id), del(queue.id)]);
  const codes = [first.status, second.status].sort((x, y) => x - y);
  assert.deepEqual(codes, [200, 409]);
});

test('级联后墓碑窗内重下同歌单 → 409 可重试语义', async () => {
  const { pl, queue } = seedDownload('777012');
  assert.equal((await del(queue.id)).status, 200);
  // quick 下载走 resolvePlaylistId → 墓碑命中 409（~130s 窗内防复活）
  const res = await app.request(`http://t/downloads/playlists/${pl.neteasePlaylistId}/quick`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  });
  assert.equal(res.status, 409);
});

test('local_uploads 伪歌单不可经队列删除级联清空（服务层不变量）', async () => {
  // 伪歌单是全部 file_ 上传资产的登记锚——队列删除升级为级联后，伪歌单上
  // 挂的队列（异常数据形态）绝不能一键清掉所有上传音源
  const pl = playlistsRepo.upsertPlaylist({ neteasePlaylistId: 'local_uploads', name: '上传库', source: 'local' });
  const queue = queuesRepo.createQueue({ playlistId: pl.id, name: pl.name, status: 'completed', totalTasks: 0 });
  const task = tasksRepo.createTask({
    playlistId: pl.id, queueId: queue.id, songId: 'file_guard1',
    songName: '资产', artist: '', status: 'completed', downloadAudio: true
  });
  const audioPath = join(downloadFs.DOWNLOAD_BASE_DIR, 'uploads', 'audio', 'file_guard1.mp3');
  mkdirSync(dirname(audioPath), { recursive: true });
  writeFileSync(audioPath, 'uploaded-bytes');
  tasksRepo.updateTask(task.id, { audioPath });

  const res = await del(queue.id);
  assert.equal(res.status, 400);
  assert.match((await res.json()).message || '', /不可删除/);

  assert.ok(queuesRepo.findQueueById(queue.id));
  assert.equal(tasksRepo.listTasksByPlaylist(pl.id).length, 1);
  assert.ok(playlistsRepo.findPlaylistById(pl.id));
  assert.ok(existsSync(audioPath));
});

test('删除不存在的队列 → 404', async () => {
  const res = await del(999999);
  assert.equal(res.status, 404);
});

test('锁释放断言：local_uploads 400 之后再发同请求仍 400（锁泄漏会变 409）', async () => {
  const pl = playlistsRepo.upsertPlaylist({ neteasePlaylistId: 'local_uploads', name: '上传库2', source: 'local' });
  const queue = queuesRepo.createQueue({ playlistId: pl.id, name: 'q', status: 'completed', totalTasks: 0 });
  assert.equal((await del(queue.id)).status, 400);
  assert.equal((await del(queue.id)).status, 400); // deletingPlaylists 若泄漏，第二次拿 409
});

test('队列已完成曲「补视频」翻 pending 接管——不再幂等谎报成功', async () => {
  // 修复前：queueTask completed+intact 的幂等短路不查 downloadVideo/videoPath，
  // 「下载视频到服务器」直接返回完成态、前端 toast 成功但什么都没下
  const pl = playlistsRepo.upsertPlaylist({ neteasePlaylistId: '777014', name: 'pl-video' });
  playlistTracksRepo.replaceTracksForPlaylist(pl.id, [
    { id: 'bv_BV7770140000', name: '曲', ar: [{ name: '艺人' }], al: { name: '专' }, dt: 200000 }
  ]);
  const queue = queuesRepo.createQueue({
    playlistId: pl.id, name: pl.name, status: 'completed', totalTasks: 1, completedTasks: 1
  });
  const task = tasksRepo.createTask({
    playlistId: pl.id, queueId: queue.id, songId: 'bv_BV7770140000', songName: '曲',
    artist: '艺人', status: 'completed', downloadAudio: true, downloadVideo: false
  });
  const audioPath = join(downloadFs.DOWNLOAD_BASE_DIR, String(pl.id), 'audio', 'bv_BV7770140000.mp3');
  mkdirSync(dirname(audioPath), { recursive: true });
  writeFileSync(audioPath, 'audio-bytes');
  tasksRepo.updateTask(task.id, { audioPath });

  const res = await app.request('http://t/downloads/songs/bv_BV7770140000', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playlistId: pl.id, downloadVideo: true })
  });
  assert.equal(res.status, 200);

  const row = tasksRepo.findTaskById(task.id);
  // 摘出队列（standalone 代跑会往旧队列写计数）+ 翻 pending 真跑视频相位
  assert.equal(row.queueId, null);
  assert.equal(row.downloadVideo, true);
  assert.ok(['pending', 'downloading'].includes(row.status));
  // 完好音频工件保留——分段幂等只补视频相位，不整首重下
  assert.equal(row.audioPath, audioPath);
  assert.ok(existsSync(audioPath));
  // 旧队列被摘空即收壳——completed 0/0 幽灵行不留（单行队列摘完即删）
  assert.equal(queuesRepo.findQueueById(queue.id), null);

  // 收尾：壳已被收掉——另种一条队列走级联 abort 挂起的 standalone 视频协程
  const sweeper = queuesRepo.createQueue({ playlistId: pl.id, name: 'sweep', status: 'completed', totalTasks: 0 });
  await del(sweeper.id);
});

test('队列已完成曲补视频——videoPath 已在册时仍幂等返回不重复下', async () => {
  const pl = playlistsRepo.upsertPlaylist({ neteasePlaylistId: '777015', name: 'pl-video2' });
  playlistTracksRepo.replaceTracksForPlaylist(pl.id, [
    { id: 'bv_BV7770150000', name: '曲2', ar: [], al: {}, dt: 100 }
  ]);
  const queue = queuesRepo.createQueue({
    playlistId: pl.id, name: pl.name, status: 'completed', totalTasks: 1, completedTasks: 1
  });
  const task = tasksRepo.createTask({
    playlistId: pl.id, queueId: queue.id, songId: 'bv_BV7770150000', songName: '曲2',
    artist: '', status: 'completed', downloadAudio: true, downloadVideo: true
  });
  const audioPath = join(downloadFs.DOWNLOAD_BASE_DIR, String(pl.id), 'audio', 'bv_BV7770150000.mp3');
  const videoPath = join(downloadFs.DOWNLOAD_BASE_DIR, String(pl.id), 'videos', 'bv_BV7770150000.mp4');
  mkdirSync(dirname(audioPath), { recursive: true });
  mkdirSync(dirname(videoPath), { recursive: true });
  writeFileSync(audioPath, 'audio-bytes');
  writeFileSync(videoPath, 'video-bytes');
  tasksRepo.updateTask(task.id, { audioPath, videoPath });

  const res = await app.request('http://t/downloads/songs/bv_BV7770150000', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playlistId: pl.id, downloadVideo: true })
  });
  assert.equal(res.status, 200);
  const row = tasksRepo.findTaskById(task.id);
  // 幂等语义保留：行仍是队列所有、completed 不动、不派新协程
  assert.equal(row.queueId, queue.id);
  assert.equal(row.status, 'completed');
  assert.equal(row.videoPath, videoPath);

  await del(queue.id);
});

test('在途协程级联：abort+排空后任务/队列/歌单行全清', async () => {
  const dm = require('../src/server/services/download-manager.js');
  const pl = playlistsRepo.upsertPlaylist({ neteasePlaylistId: '777013', name: 'live-pl' });
  playlistTracksRepo.replaceTracksForPlaylist(pl.id, [
    { id: 'song_live1', name: '活着的歌', ar: [{ name: 'a' }], al: { name: 'b' }, dt: 60000 }
  ]);
  const queue = await dm.createDownloadQueue(pl.id, {
    downloadAudio: true, downloadLyrics: false, downloadCover: false, downloadVideo: false
  });
  await dm.startQueue(queue.id);
  // 让协程跑到 downloadAudio 挂起点（微任务一跳）
  await new Promise(r => setImmediate(r));

  const res = await del(queue.id);
  assert.equal(res.status, 200);
  assert.equal(tasksRepo.listTasksByPlaylist(pl.id).length, 0);
  assert.equal(queuesRepo.findQueueById(queue.id), null);
  assert.equal(playlistsRepo.findPlaylistById(pl.id), null);
});

test('幻影 videoPath 清册：登记但文件已删 + 不补视频的重跑清掉登记', async () => {
  // 修复前：videoPath 在册而文件被外删 → taskFilesIntact 永假 → 行永远钉在
  // 「未下载」，且 flag 同步把 downloadVideo 翻 false 后视频相位不再跑——
  // 任何普通重下都修不好登记幻影。现在重跑时清册让完好工件重新算 intact
  const pl = playlistsRepo.upsertPlaylist({ neteasePlaylistId: '777016', name: 'pl-phantom' });
  playlistTracksRepo.replaceTracksForPlaylist(pl.id, [
    { id: 'bv_BV7770160000', name: '曲', ar: [{ name: '艺人' }], al: { name: '专' }, dt: 200000 }
  ]);
  const task = tasksRepo.createTask({
    playlistId: pl.id, queueId: null, songId: 'bv_BV7770160000', songName: '曲',
    artist: '艺人', status: 'completed', downloadAudio: true, downloadVideo: true
  });
  const audioPath = join(downloadFs.DOWNLOAD_BASE_DIR, String(pl.id), 'audio', 'bv_BV7770160000.mp3');
  const phantomVideo = join(downloadFs.DOWNLOAD_BASE_DIR, String(pl.id), 'videos', 'bv_BV7770160000.mp4');
  mkdirSync(dirname(audioPath), { recursive: true });
  writeFileSync(audioPath, 'audio-bytes');
  // 登记 videoPath 但不落盘——模拟文件被外部删除的幻影态
  tasksRepo.updateTask(task.id, {
    audioPath, videoPath: phantomVideo, videoMeta: { h: 1080, w: 1920, codec: 'avc1', br: 1, source: 'adaptive' }
  });
  assert.equal(downloadFs.taskFilesIntact(tasksRepo.findTaskById(task.id)), false);

  // 普通重下（不补视频）→ flag 同步时应清幻影登记
  const res = await app.request('http://t/downloads/songs/bv_BV7770160000', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playlistId: pl.id })
  });
  assert.equal(res.status, 200);
  const row = tasksRepo.findTaskById(task.id);
  assert.equal(row.videoPath, null);
  assert.equal(row.videoMeta, null);
  assert.equal(row.downloadVideo, false);

  // 收尾：种队列走级联 abort 挂起的 standalone 协程
  const q = queuesRepo.createQueue({ playlistId: pl.id, name: pl.name, status: 'completed', totalTasks: 0 });
  await del(q.id);
});

test('status/file 契约：body.data.task 嵌套形态 + kind=video 的 Range 与幻影 404', async () => {
  // WatchView 本地档探测吃 {code,data:{downloaded,task}} 嵌套——读错层级
  // （st.task）整段功能即死代码；此用例钉住服务端契约面
  const pl = playlistsRepo.upsertPlaylist({ neteasePlaylistId: '777017', name: 'pl-contract' });
  const task = tasksRepo.createTask({
    playlistId: pl.id, queueId: null, songId: 'bv_BV7770170000', songName: '曲',
    artist: '艺人', status: 'completed', downloadAudio: true, downloadVideo: true
  });
  const audioPath = join(downloadFs.DOWNLOAD_BASE_DIR, String(pl.id), 'audio', 'bv_BV7770170000.mp3');
  const videoPath = join(downloadFs.DOWNLOAD_BASE_DIR, String(pl.id), 'videos', 'bv_BV7770170000.mp4');
  mkdirSync(dirname(audioPath), { recursive: true });
  mkdirSync(dirname(videoPath), { recursive: true });
  writeFileSync(audioPath, 'audio-bytes');
  writeFileSync(videoPath, 'video-bytes-0123456789');
  tasksRepo.updateTask(task.id, {
    audioPath, videoPath, videoMeta: { h: 1080, w: 1920, codec: 'avc1.640032', br: 5400000, source: 'adaptive' }
  });

  const st = await (await app.request(
    `http://t/downloads/songs/bv_BV7770170000/status?playlistId=${pl.id}`)).json();
  assert.equal(st.code, 200);
  assert.equal(st.data.downloaded, true);
  // toPublicTask 透相对路径（歌单目录相对）——前端探测消费的就是这个形态
  assert.equal(st.data.task.videoPath, `${pl.id}/videos/bv_BV7770170000.mp4`);
  assert.equal(st.data.task.videoMeta.h, 1080);

  const file = await app.request(
    `http://t/downloads/songs/bv_BV7770170000/file?playlistId=${pl.id}&kind=video`);
  assert.equal(file.status, 200);
  assert.match(file.headers.get('content-type') || '', /video\/mp4/);
  // 防护三头与 media-cache 供给同口径——同性质字节走同一边界
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(file.headers.get('content-security-policy'), 'sandbox');
  assert.equal(file.headers.get('referrer-policy'), 'no-referrer');

  const ranged = await app.request(
    `http://t/downloads/songs/bv_BV7770170000/file?playlistId=${pl.id}&kind=video`,
    { headers: { Range: 'bytes=0-4' } });
  assert.equal(ranged.status, 206);
  assert.equal(await ranged.text(), 'video');

  // 幻影 videoPath（登记在库、文件外删）：status 照报登记值，file 404——
  // 前端靠这个 404 走 error→在线流回落
  const phantom = tasksRepo.createTask({
    playlistId: pl.id, queueId: null, songId: 'bv_BV7770180000', songName: '幻',
    artist: '', status: 'completed', downloadAudio: true, downloadVideo: true
  });
  tasksRepo.updateTask(phantom.id, {
    videoPath: join(downloadFs.DOWNLOAD_BASE_DIR, String(pl.id), 'videos', 'gone.mp4')
  });
  const file404 = await app.request(
    `http://t/downloads/songs/bv_BV7770180000/file?playlistId=${pl.id}&kind=video`);
  assert.equal(file404.status, 404);

  const q = queuesRepo.createQueue({ playlistId: pl.id, name: pl.name, status: 'completed', totalTasks: 0 });
  await del(q.id);
});

test('kind=audio 的 videoPath 兜底仅限 file_ 曲：bv_ 仅视频行 404', async () => {
  // 收紧前：audio 请求在 audioPath 缺位时无条件回落 videoPath——bv_/yt_
  // 任务（UI 恒 downloadAudio:true，仅视频行只能手工 API 构造）会把 mp4
  // 当音频源播，等于 watch 页外消费视频档。收紧后只有 file_ 上传曲
  // （video-only 上传没有音频工件，mp4 音轨即其音频）保留回落。
  const pl = playlistsRepo.upsertPlaylist({ neteasePlaylistId: '777019', name: 'pl-audiofb' });

  // bv_ completed 行：无 audioPath、videoPath 落盘（手工构造形态）
  const bvTask = tasksRepo.createTask({
    playlistId: pl.id, queueId: null, songId: 'bv_BV7770190000', songName: '曲',
    artist: '', status: 'completed', downloadAudio: false, downloadVideo: true
  });
  const bvVideo = join(downloadFs.DOWNLOAD_BASE_DIR, String(pl.id), 'videos', 'bv_BV7770190000.mp4');
  mkdirSync(dirname(bvVideo), { recursive: true });
  writeFileSync(bvVideo, 'video-bytes');
  tasksRepo.updateTask(bvTask.id, { videoPath: bvVideo });
  const bvRes = await app.request(
    `http://t/downloads/songs/bv_BV7770190000/file?playlistId=${pl.id}&kind=audio`);
  assert.equal(bvRes.status, 404, 'bv_ 仅视频行的 audio 请求应 404 而非供 mp4');
  // 同曲 kind=video 仍供档（WatchView 本地视频探测链不受影响）
  const bvVid = await app.request(
    `http://t/downloads/songs/bv_BV7770190000/file?playlistId=${pl.id}&kind=video`);
  assert.equal(bvVid.status, 200);

  // file_ completed 行：video-only 上传曲保留 audio→videoPath 兜底
  const fileTask = tasksRepo.createTask({
    playlistId: pl.id, queueId: null, songId: 'file_abcd1234', songName: '传',
    artist: '', status: 'completed', downloadAudio: true, downloadVideo: true
  });
  const fileVideo = join(downloadFs.DOWNLOAD_BASE_DIR, String(pl.id), 'videos', 'file_abcd1234.mp4');
  writeFileSync(fileVideo, 'upload-video-bytes');
  tasksRepo.updateTask(fileTask.id, { videoPath: fileVideo });
  const fileRes = await app.request(
    `http://t/downloads/songs/file_abcd1234/file?playlistId=${pl.id}&kind=audio`);
  assert.equal(fileRes.status, 200, 'file_ video-only 曲的 audio 请求应回落 videoPath');
  assert.match(fileRes.headers.get('content-type') || '', /video\/mp4/);
});

test('级联墓碑只对数字 id 立：local_pl_/saved_queue_ 镜像行跳过', async () => {
  // 墓碑的防护面 = 在途上游导入按同 netease_playlist_id upsert 复活已删行；
  // 上游导入准入闸（resolvePlaylistId /playlists/import）只放纯数字 id——
  // 本地命名空间永远到不了那条路。修复前镜像行被无差别立 130s 墓碑，
  // mirror 重放整窗 409。镜像的复活竞态由 deletingPlaylists 行锁 +
  // 镜像事务内行 id 复查覆盖，不需要 netease 域墓碑
  for (const mirrorId of ['local_pl_qdel1', 'saved_queue_qdel1']) {
    const pl = playlistsRepo.upsertPlaylist({ neteasePlaylistId: mirrorId, name: `pl-${mirrorId}`, source: 'local' });
    const q = queuesRepo.createQueue({ playlistId: pl.id, name: pl.name, status: 'completed', totalTasks: 0 });
    assert.equal((await del(q.id)).status, 200);
    assert.equal(playlistsRepo.findPlaylistById(pl.id), null); // 级联本体不受影响
    assert.equal(locks.deletingNeteasePlaylists.has(mirrorId), false);
    assert.equal(locks.isNeteasePlaylistDeleting(mirrorId), false);
  }

  // 回归钉：数字 id 能过上游导入准入闸，墓碑必须照常立——
  // 删了它，在途导入 fetch 返回后就会把刚删的行复活
  const num = seedDownload('777020');
  assert.equal((await del(num.queue.id)).status, 200);
  assert.ok(locks.isNeteasePlaylistDeleting('777020'));
});

test('镜像端到端：本地歌单删下载足迹后立即可重镜（不再被墓碑 409 封 130s）', async () => {
  // 修复前表象：删歌单足迹后 130s 内镜像 POST 撞墓碑 409——单曲提交的
  // resolvePlaylistId 跟着落空，非数字 id 直接被 400「无效的歌单 ID」弹回
  const localId = 'local_pl_qdel_e2e';
  const postMirror = () => app.request('http://t/downloads/local/mirror', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      localId, name: '本地歌单',
      tracks: [{ id: '777020001', name: '曲', ar: [{ name: 'a' }], al: { name: 'b' }, dt: 1000 }]
    })
  });
  assert.equal((await postMirror()).status, 200);

  const delRes = await app.request(`http://t/downloads/local/mirror/${localId}`, { method: 'DELETE' });
  assert.equal(delRes.status, 200);
  assert.equal(playlistsRepo.findPlaylistByNeteaseId(localId), null);

  // 级联完成的下一拍重镜同 id——有墓碑时这里是 409
  const remirror = await postMirror();
  assert.equal(remirror.status, 200);
  assert.ok((await remirror.json()).data.playlistId);
});

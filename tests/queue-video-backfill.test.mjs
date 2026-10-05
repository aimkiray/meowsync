// 队列级「补视频」收养：downloadVideo:false 的队列里跑完成的外源曲，同歌单
// 带 downloadVideo:true 重提交时应翻 pending 补视频相位——修复前完好行被
// 原样收养（keepCompleted 短路），队列侧永远开不了视频相位
// （standalone 单曲早有同语义，队列收养段是缺口）。
// DATA_DIR 临时化：真 repo 真 DB 真盘；file-downloader 桩成「落盘即完成」
// ——不起协程真跑就到不了 completed 终态，验不了收养三分支。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { seed, tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-qvbf-');
const require = createRequire(import.meta.url);

// 相位桩：写盘到位 + 录调用数。返回形状对齐真 file-downloader——
// audio={path,size,br}、video={path,videoMeta}、lyrics/cover={path}
const calls = { audio: 0, video: 0, lyrics: 0, cover: 0 };
const land = (dest, bytes) => {
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, bytes);
};
seed('../src/server/services/file-downloader.js', {
  downloadAudio: async (_songId, dest) => {
    calls.audio += 1;
    land(dest, 'audio-bytes');
    // 8MB@320kbps≈200s——即使外源时长对账豁免失效也不触发剪辑闸
    return { path: dest, size: 8_000_000, br: 320000 };
  },
  downloadVideo: async (_songId, dest) => {
    calls.video += 1;
    land(dest, 'video-bytes');
    return { path: dest, videoMeta: { h: 1080, w: 1920, codec: 'avc1', br: 1, source: 'adaptive' } };
  },
  downloadLyrics: async (_songId, dest) => {
    calls.lyrics += 1;
    land(dest, 'lrc-bytes');
    return { path: dest };
  },
  downloadCover: async (_url, dest) => {
    calls.cover += 1;
    land(dest, 'jpg-bytes');
    return { path: dest };
  }
});

let dm, tasksRepo, queuesRepo, playlistsRepo, playlistTracksRepo;
before(() => {
  dm = require('../src/server/services/download-manager.js');
  tasksRepo = require('../src/server/repositories/downloadTasks.js');
  queuesRepo = require('../src/server/repositories/downloadQueues.js');
  playlistsRepo = require('../src/server/repositories/playlists.js');
  playlistTracksRepo = require('../src/server/repositories/playlistTracks.js');
});

// processQueue 是后台协程——轮询队列行到终态（桩相位瞬时完成，
// 400×10ms 上限只防回归死等）
const waitQueueTerminal = async (queueId) => {
  for (let i = 0; i < 400; i++) {
    const q = queuesRepo.findQueueById(queueId);
    if (q && ['completed', 'failed', 'cancelled'].includes(q.status)) return q;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error(`队列 ${queueId} 未及时收尾`);
};

const seedPlaylistWithTrack = (neteaseId, songId, youtube) => {
  const pl = playlistsRepo.upsertPlaylist({ neteasePlaylistId: neteaseId, name: `pl-${neteaseId}` });
  playlistTracksRepo.replaceTracksForPlaylist(pl.id, [
    { id: songId, name: '曲', ar: [{ name: 'UP' }], al: { name: '专' }, dt: 200000, youtube }
  ]);
  return pl;
};

test('队列级补视频：downloadVideo:true 重提交时完好完成行翻 pending 只补视频相位', async () => {
  const songId = 'yt_vbackfill01';
  const pl = seedPlaylistWithTrack('778801', songId, { videoId: 'vbackfill01' });

  // 第一遍：无视频队列真跑完成——产物真落盘，行登记真路径进终态
  const q1 = await dm.createDownloadQueue(pl.id, {
    downloadAudio: true, downloadLyrics: false, downloadCover: false, downloadVideo: false
  });
  await dm.startQueue(q1.id);
  assert.equal((await waitQueueTerminal(q1.id)).status, 'completed');
  const doneRow = tasksRepo.listTasksByQueue(q1.id)[0];
  assert.equal(doneRow.status, 'completed');
  const audioPath = doneRow.audioPath;
  assert.ok(audioPath && existsSync(audioPath), '首轮音频工件应真落盘');
  assert.equal(doneRow.downloadVideo, false);
  const audioCallsAfterFirstRun = calls.audio;

  // 第二遍：同歌单 downloadVideo:true 重提交——终态队列原地复活，
  // 完好完成行应翻 pending 补视频而不是纯收养
  const q2 = await dm.createDownloadQueue(pl.id, {
    downloadAudio: true, downloadLyrics: false, downloadCover: false, downloadVideo: true
  });
  assert.equal(q2.id, q1.id, '终态队列应原地复活——queueId 稳定');
  assert.equal(q2.downloadVideo, true);

  const row = tasksRepo.findTaskById(doneRow.id);
  assert.equal(row.status, 'pending', '完好完成行应翻 pending 开视频相位');
  assert.equal(row.downloadVideo, true);
  assert.equal(row.queueId, q2.id);
  assert.equal(row.audioPath, audioPath, '已落盘音频登记保留——分段幂等靠它跳过');
  assert.equal(row.completedAt, null);
  assert.equal(row.retryCount, 0);
  assert.equal(row.providerData?.youtube?.videoId, 'vbackfill01');
  assert.ok(existsSync(audioPath), '完好工件不得进收养删除清册（adoptedPaths 误删）');

  // 翻 pending 的行计入未完成——recount 后队列复活能按 pending 正常调度
  const counters = queuesRepo.findQueueById(q2.id);
  assert.equal(counters.totalTasks, 1);
  assert.equal(counters.completedTasks, 0, '翻 pending 的行不该再计完成数');

  // 真跑第二遍验证语义闭环：只补视频相位——音频幂等跳过重下
  await dm.startQueue(q2.id);
  assert.equal((await waitQueueTerminal(q2.id)).status, 'completed');
  assert.equal(calls.audio, audioCallsAfterFirstRun, '音频相位应幂等跳过不重下');
  assert.equal(calls.video, 1, '视频相位应真跑一次');
  const finalRow = tasksRepo.findTaskById(doneRow.id);
  assert.equal(finalRow.status, 'completed');
  assert.equal(finalRow.audioPath, audioPath);
  assert.ok(finalRow.videoPath && existsSync(finalRow.videoPath));
});

test('反向钉：downloadVideo:false 重提交时完好完成行仍纯收养不动', async () => {
  const songId = 'yt_vnovideo001';
  const pl = seedPlaylistWithTrack('778802', songId, { videoId: 'vnovideo001' });

  const q1 = await dm.createDownloadQueue(pl.id, {
    downloadAudio: true, downloadLyrics: false, downloadCover: false, downloadVideo: false
  });
  await dm.startQueue(q1.id);
  assert.equal((await waitQueueTerminal(q1.id)).status, 'completed');
  const doneRow = tasksRepo.listTasksByQueue(q1.id)[0];
  const audioPath = doneRow.audioPath;
  const completedAt = doneRow.completedAt;
  assert.ok(audioPath && existsSync(audioPath));

  const q2 = await dm.createDownloadQueue(pl.id, {
    downloadAudio: true, downloadLyrics: false, downloadCover: false, downloadVideo: false
  });
  assert.equal(q2.id, q1.id);
  const row = tasksRepo.findTaskById(doneRow.id);
  assert.equal(row.status, 'completed', '无补视频语义时完好行应纯收养不翻 pending');
  assert.equal(row.downloadVideo, false);
  assert.equal(row.audioPath, audioPath);
  assert.equal(row.completedAt, completedAt, '收养不写完成时刻');
  assert.ok(existsSync(audioPath));
  const counters = queuesRepo.findQueueById(q2.id);
  assert.equal(counters.totalTasks, 1);
  assert.equal(counters.completedTasks, 1, '纯收养的完成行照计完成数');
});

test('幻影登记档：videoPath 在册但盘上已删的完成行重提交翻 pending 补下', async () => {
  const songId = 'yt_vphantom001';
  const pl = seedPlaylistWithTrack('778803', songId, { videoId: 'vphantom001' });

  // 第一遍：带视频队列真跑完成——audio+video 工件真落盘并登记
  const q1 = await dm.createDownloadQueue(pl.id, {
    downloadAudio: true, downloadLyrics: false, downloadCover: false, downloadVideo: true
  });
  await dm.startQueue(q1.id);
  assert.equal((await waitQueueTerminal(q1.id)).status, 'completed');
  const doneRow = tasksRepo.listTasksByQueue(q1.id)[0];
  assert.equal(doneRow.status, 'completed');
  const audioPath = doneRow.audioPath;
  const videoPath = doneRow.videoPath;
  assert.ok(audioPath && existsSync(audioPath), '首轮音频工件应真落盘');
  assert.ok(videoPath && existsSync(videoPath), '首轮视频工件应真落盘');

  // 盘上删掉视频档但行仍登记 videoPath——幻影 completed 行
  unlinkSync(videoPath);
  assert.ok(!existsSync(videoPath));

  // 同歌单 downloadVideo:true 重提交：幻影不算完好——翻 pending 复位重跑
  // （路径清册+旧档进 adoptedPaths），不是原样收养的 completed
  const q2 = await dm.createDownloadQueue(pl.id, {
    downloadAudio: true, downloadLyrics: false, downloadCover: false, downloadVideo: true
  });
  assert.equal(q2.id, q1.id, '终态队列应原地复活——queueId 稳定');
  const row = tasksRepo.findTaskById(doneRow.id);
  assert.equal(row.status, 'pending', '幻影登记档应翻 pending 补下而非纯收养');
  assert.equal(row.downloadVideo, true);
  assert.equal(row.queueId, q2.id);
  assert.equal(row.audioPath, null, '非完好行走复位重跑——旧路径登记清册');
  assert.ok(!existsSync(audioPath), '复位行的旧档随 adoptedPaths 清掉');

  // 真跑验证闭环：幻影视频档与复位清掉的音频都真补回落盘
  const audioCallsBefore = calls.audio;
  const videoCallsBefore = calls.video;
  await dm.startQueue(q2.id);
  assert.equal((await waitQueueTerminal(q2.id)).status, 'completed');
  assert.equal(calls.audio, audioCallsBefore + 1, '复位后音频相位重下');
  assert.equal(calls.video, videoCallsBefore + 1, '幻影视频档真补回');
  const finalRow = tasksRepo.findTaskById(doneRow.id);
  assert.equal(finalRow.status, 'completed');
  assert.ok(finalRow.audioPath && existsSync(finalRow.audioPath));
  assert.ok(finalRow.videoPath && existsSync(finalRow.videoPath));
});

test('非外源曲钉：downloadVideo:true 重提交时 numeric/网易云 id 行纯收养不动', async () => {
  // 同歌单混外源曲+网易云数字 id——isExternalSongId 裁剪在同队里分路：
  // 外源行翻 pending 补视频相位，数字 id 行无视频相位可补走纯收养
  const pl = playlistsRepo.upsertPlaylist({ neteasePlaylistId: '778804', name: 'pl-778804' });
  playlistTracksRepo.replaceTracksForPlaylist(pl.id, [
    { id: 'yt_vmixext0001', name: '外源曲', ar: [{ name: 'UP' }], al: { name: '专' }, dt: 200000, youtube: { videoId: 'vmixext0001' } },
    { id: '987654321', name: '网易曲', ar: [{ name: 'UP' }], al: { name: '专' }, dt: 200000 }
  ]);

  // 第一遍：无视频队列真跑完成——两行都只有音频档
  const q1 = await dm.createDownloadQueue(pl.id, {
    downloadAudio: true, downloadLyrics: false, downloadCover: false, downloadVideo: false
  });
  await dm.startQueue(q1.id);
  assert.equal((await waitQueueTerminal(q1.id)).status, 'completed');
  const doneRows = tasksRepo.listTasksByQueue(q1.id);
  assert.equal(doneRows.length, 2);
  const extDone = doneRows.find(t => t.songId === 'yt_vmixext0001');
  const netDone = doneRows.find(t => t.songId === '987654321');
  assert.equal(extDone.status, 'completed');
  assert.equal(netDone.status, 'completed');
  const netAudioPath = netDone.audioPath;
  const netCompletedAt = netDone.completedAt;
  assert.ok(netAudioPath && existsSync(netAudioPath));
  assert.equal(netDone.downloadVideo, false);

  // 同歌单 downloadVideo:true 重提交：外源行翻 pending 补视频，
  // 数字 id 行被 isExternalSongId 裁掉——纯收养 completed 不动
  const q2 = await dm.createDownloadQueue(pl.id, {
    downloadAudio: true, downloadLyrics: false, downloadCover: false, downloadVideo: true
  });
  assert.equal(q2.id, q1.id);
  const extRow = tasksRepo.findTaskById(extDone.id);
  assert.equal(extRow.status, 'pending', '外源行应翻 pending 开视频相位');
  assert.equal(extRow.downloadVideo, true);
  const netRow = tasksRepo.findTaskById(netDone.id);
  assert.equal(netRow.status, 'completed', '非外源曲无视频相位可补——完好行纯收养不翻 pending');
  assert.equal(netRow.downloadVideo, false, 'isExternalSongId 裁掉——video 位不该被置上');
  assert.equal(netRow.audioPath, netAudioPath);
  assert.equal(netRow.completedAt, netCompletedAt, '收养不写完成时刻');
  assert.ok(existsSync(netAudioPath), '完好工件不得进收养删除清册');
  const counters = queuesRepo.findQueueById(q2.id);
  assert.equal(counters.totalTasks, 2);
  assert.equal(counters.completedTasks, 1, '只有外源行翻 pending，数字行照计完成数');

  // 真跑闭环：只有外源行补视频相位——数字行已 completed 不再派发
  const audioCallsBefore = calls.audio;
  const videoCallsBefore = calls.video;
  await dm.startQueue(q2.id);
  assert.equal((await waitQueueTerminal(q2.id)).status, 'completed');
  assert.equal(calls.audio, audioCallsBefore, '外源行音频幂等跳过、数字行不重跑');
  assert.equal(calls.video, videoCallsBefore + 1, '只有外源行真跑视频相位');
  assert.equal(tasksRepo.findTaskById(netDone.id).status, 'completed');
});

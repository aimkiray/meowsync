// 远端单（纯数字 id）localDelta 建队回归：客户端 addedTracks/removedTrackIds
// 只活在 localStorage——createDownloadQueue 必须在枚举 playlist_tracks 之前
// 把 delta 落库/对账，否则本地追加的 yt_/bv_/qq_ 曲静默缺席队列。
// 对账模型（B1 修复后）：addedTracks 是权威全集——upsert 打 local_added=1
// 标记，再剪枝全部缺席的标记行（用户删追加曲只剪数组不补墓碑，剪掉后
// 「清空到零」的空 added 必须能扫掉落库行）；removedIds 只做枚举期虚拟
// 过滤不删行（恢复墓碑曲只清数组，行删了就回不来）。
// 单曲下载路径同款打通（文件尾段用例）：POST /downloads/songs/:songId 的
// track 载荷是增量补行不是权威对账——只插不改（已存在行零写不降级
// raw_json），缺席才 local_added=1 补尾位；单元素 delta 会误剪其他标记行
// 故刻意不走 applyLocalTrackDelta。
// DATA_DIR 临时化：真 repo 真 DB。建队不跑下载协程（startQueue 才派发）；
// 单曲路径会真派 standalone 协程——file-downloader 播种抛错桩防真打网络，
// 断言只钉提交侧行级效果（任务行/playlist_tracks 行），协程终态不归本文件管。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { seed, tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-localdelta-');
const require = createRequire(import.meta.url);

// 单曲下载的 standalone 协程会真到 file-downloader——抛错桩拦网
// （必须早于被测文件 require：require.cache 预播种）
seed('../src/server/services/file-downloader.js', {
  downloadAudio: async () => { throw new Error('stub audio'); },
  downloadVideo: async () => { throw new Error('stub video'); },
  downloadLyrics: async () => { throw new Error('stub lyrics'); },
  downloadCover: async () => { throw new Error('stub cover'); },
});

let app, dm, tasksRepo, queuesRepo, playlistsRepo, playlistTracksRepo, getDb;
before(() => {
  app = require('../src/server/routes/downloads.js');
  dm = require('../src/server/services/download-manager.js');
  tasksRepo = require('../src/server/repositories/downloadTasks.js');
  queuesRepo = require('../src/server/repositories/downloadQueues.js');
  playlistsRepo = require('../src/server/repositories/playlists.js');
  playlistTracksRepo = require('../src/server/repositories/playlistTracks.js');
  getDb = require('../src/server/db/client.js').getDb;
});

// 种一张「远端单」：netease_playlist_id 为纯数字的上游导入形态
const seedRemote = (neteaseId, tracks) => {
  const pl = playlistsRepo.upsertPlaylist({ neteasePlaylistId: neteaseId, name: `pl-${neteaseId}` });
  playlistTracksRepo.replaceTracksForPlaylist(pl.id, tracks);
  return pl;
};
const queueOpts = (extra = {}) => ({
  downloadAudio: true, downloadLyrics: false, downloadCover: false, downloadVideo: false,
  ...extra
});
const queueSongIds = (queueId) => tasksRepo.listTasksByQueue(queueId).map(t => t.songId).sort();
// local_added 是内部标记列不透出 repo 投影——直查行断言打标语义
const localAddedFlag = (playlistId, songId) => getDb().prepare(
  'SELECT local_added FROM playlist_tracks WHERE playlist_id = ? AND song_id = ?'
).get(playlistId, String(songId))?.local_added;

test('localDelta.addedTracks：yt_ 追加曲落 playlist_tracks 尾并入队，providerData 带源定位', async () => {
  const pl = seedRemote('779001', [
    { id: '77900101', name: '远端曲', ar: [{ name: 'a' }], al: { name: 'b' }, dt: 1000 }
  ]);
  const queue = await dm.createDownloadQueue(pl.id, queueOpts({
    localDelta: {
      addedTracks: [{
        id: 'yt_vdelta00001', name: '追加曲', ar: [{ name: 'UP' }], al: { name: '' }, dt: 200000,
        youtube: { videoId: 'vdelta00001', title: '源标题', author: 'UP主' }
      }],
      removedIds: []
    }
  }));

  assert.deepEqual(queueSongIds(queue.id), ['77900101', 'yt_vdelta00001']);
  const ytTask = tasksRepo.findAnyTaskByPlaylistAndSongId(pl.id, 'yt_vdelta00001');
  assert.equal(ytTask.providerData?.youtube?.videoId, 'vdelta00001');
  assert.equal(ytTask.providerData?.youtube?.title, '源标题');
  assert.equal(ytTask.providerData?.youtube?.author, 'UP主');
  // 行级落库：raw_json 带 provider 块，位置追加在既有曲目尾（客户端「追加尾」渲染同序）；
  // 追加行打 local_added=1——对账剪枝的打击面标记
  const rows = playlistTracksRepo.listTracksByPlaylistId(pl.id);
  assert.equal(rows.length, 2);
  assert.equal(rows.at(-1).id, 'yt_vdelta00001');
  assert.equal(rows.at(-1).youtube.videoId, 'vdelta00001');
  assert.equal(localAddedFlag(pl.id, 'yt_vdelta00001'), 1);
  assert.equal(localAddedFlag(pl.id, '77900101'), 0); // 上游行不标
});

test('localDelta.removedIds：墓碑曲不入队但行保留（虚拟过滤），撤碑即回归', async () => {
  // B1 方向二回归：removedIds 物理删行会让「恢复墓碑曲」（客户端只清
  // removedTrackIds 不重进 addedTracks）永久缺席——行必须留，过滤只在枚举期
  const pl = seedRemote('779002', [
    { id: '77900201', name: '留', ar: [], al: {}, dt: 1 },
    { id: '77900202', name: '删', ar: [], al: {}, dt: 1 }
  ]);
  const queue = await dm.createDownloadQueue(pl.id, queueOpts({
    localDelta: { addedTracks: [], removedIds: ['77900202'] }
  }));

  assert.deepEqual(queueSongIds(queue.id), ['77900201']);
  // 行保留而非真删——这是恢复语义的承载
  assert.notEqual(playlistTracksRepo.findTrackBySongId(pl.id, '77900202'), null);
  assert.equal(playlistTracksRepo.listTracksByPlaylistId(pl.id).length, 2);

  // 下一轮 removedIds 不再含它（用户撤销墓碑）→ 同一行重新进枚举
  queuesRepo.updateQueue(queue.id, { status: 'cancelled' });
  const q2 = await dm.createDownloadQueue(pl.id, queueOpts({
    localDelta: { addedTracks: [], removedIds: [] }
  }));
  assert.deepEqual(queueSongIds(q2.id), ['77900201', '77900202']);
});

test('B1 方向一：addedTracks 清空=权威空集，对账剪掉标记行不再入队', async () => {
  // 用户移除本地追加曲时客户端只剪 addedTracks 数组不补墓碑——没有权威
  // 对账，已落库的标记行成永久幽灵（每次建队重复下载）
  const pl = seedRemote('779010', [{ id: '77901001', name: 'x', ar: [], al: {}, dt: 1 }]);
  const q1 = await dm.createDownloadQueue(pl.id, queueOpts({
    localDelta: {
      addedTracks: [{ id: 'yt_ghost000010', name: '追加', ar: [], al: {}, dt: 1 }],
      removedIds: []
    }
  }));
  assert.deepEqual(queueSongIds(q1.id), ['77901001', 'yt_ghost000010']);
  assert.equal(localAddedFlag(pl.id, 'yt_ghost000010'), 1);

  // 整队删掉再建（任务行随 FK 级联走）——新一轮建队携带「清空到零」的
  // 权威 delta：addedTracks 空集必须把标记行扫掉
  queuesRepo.deleteQueue(q1.id);
  const q2 = await dm.createDownloadQueue(pl.id, queueOpts({
    localDelta: { addedTracks: [], removedIds: [] }
  }));
  assert.equal(playlistTracksRepo.findTrackBySongId(pl.id, 'yt_ghost000010'), null);
  assert.deepEqual(queueSongIds(q2.id), ['77901001']);
});

test('localDelta 缺席（undefined）早退：不触发对账，标记行原样保留', async () => {
  // localDelta 缺省 = 「无 delta 信息」而非权威空集——老客户端/单曲路径不
  // 发这个键，缺席时绝不可当空集把标记行扫掉
  const pl = seedRemote('779011', [{ id: '77901101', name: 'x', ar: [], al: {}, dt: 1 }]);
  const q1 = await dm.createDownloadQueue(pl.id, queueOpts({
    localDelta: {
      addedTracks: [{ id: 'yt_absent00001', name: '追加', ar: [], al: {}, dt: 1 }],
      removedIds: []
    }
  }));
  assert.equal(localAddedFlag(pl.id, 'yt_absent00001'), 1);
  queuesRepo.deleteQueue(q1.id);

  const q2 = await dm.createDownloadQueue(pl.id, queueOpts()); // 无 localDelta 键
  assert.equal(localAddedFlag(pl.id, 'yt_absent00001'), 1, '缺席 delta 不剪标记行');
  assert.deepEqual(queueSongIds(q2.id), ['77901101', 'yt_absent00001']);
});

test('localDelta 非法 id 形态静默弃：不 400 整单、脏条目不落库', async () => {
  const pl = seedRemote('779003', [{ id: '77900301', name: 'x', ar: [], al: {}, dt: 1 }]);
  const queue = await dm.createDownloadQueue(pl.id, queueOpts({
    localDelta: {
      addedTracks: [
        { id: 'not-an-id!!', name: '坏曲' },      // 不认识形态 → skipped
        null,                                     // 空槽同弃
        {
          id: 'yt_goodytid002', name: '好曲', ar: [], al: {}, dt: 1,
          youtube: { videoId: 'goodytid002' }
        }
      ],
      removedIds: []
    }
  }));

  assert.deepEqual(queueSongIds(queue.id), ['77900301', 'yt_goodytid002']);
  assert.equal(playlistTracksRepo.findTrackBySongId(pl.id, 'not-an-id!!'), null);
});

test('localDelta 撞上游行 id：刷新投影保 position、不置 local_added', async () => {
  // 远端已含的曲被本地补 provider 字段/改名后随 delta 重放——同 id 行
  // 刷 raw_json 原位保留，不能 append 成第二行；且 UPDATE 命中不改标记——
  // 上游行撞 id 仍是上游行，否则下一轮「added 不含它」的对账会误删远端曲
  const pl = seedRemote('779004', [
    { id: '77900401', name: '旧名', ar: [{ name: 'a' }], al: {}, dt: 1 },
    { id: '77900402', name: 'y', ar: [], al: {}, dt: 1 }
  ]);
  const q1 = await dm.createDownloadQueue(pl.id, queueOpts({
    localDelta: {
      addedTracks: [{ id: '77900401', name: '新名', ar: [{ name: 'b' }], al: { name: 'c' }, dt: 2 }],
      removedIds: []
    }
  }));

  const rows = playlistTracksRepo.listTracksByPlaylistId(pl.id);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, '77900401'); // 原位——不坠尾
  assert.equal(rows[0].name, '新名');
  assert.equal(localAddedFlag(pl.id, '77900401'), 0, '上游行撞 id 不置标记');
  assert.deepEqual(queueSongIds(q1.id), ['77900401', '77900402']);

  // 下一轮 delta 不再含它（本地编辑面清空）——标 0 的上游行不被对账误删
  queuesRepo.updateQueue(q1.id, { status: 'cancelled' });
  const q2 = await dm.createDownloadQueue(pl.id, queueOpts({
    localDelta: { addedTracks: [], removedIds: [] }
  }));
  assert.notEqual(playlistTracksRepo.findTrackBySongId(pl.id, '77900401'), null);
  assert.deepEqual(queueSongIds(q2.id), ['77900401', '77900402']);
});

test('localDelta 幂等重放：同 delta 二次建队不产生重复行/重复任务', async () => {
  const pl = seedRemote('779005', [{ id: '77900501', name: 'x', ar: [], al: {}, dt: 1 }]);
  const localDelta = {
    addedTracks: [{
      id: 'yt_idem0000005', name: '追', ar: [{ name: 'U' }], al: {}, dt: 1,
      youtube: { videoId: 'idem0000005' }
    }],
    removedIds: []
  };
  const q1 = await dm.createDownloadQueue(pl.id, queueOpts({ localDelta }));
  assert.deepEqual(queueSongIds(q1.id), ['77900501', 'yt_idem0000005']);

  // 同单活跃队列在时不许再建——翻终态后重放（队列原地复活路径）
  queuesRepo.updateQueue(q1.id, { status: 'cancelled' });
  const q2 = await dm.createDownloadQueue(pl.id, queueOpts({ localDelta }));
  assert.equal(q2.id, q1.id);

  assert.equal(playlistTracksRepo.listTracksByPlaylistId(pl.id).length, 2, 'delta 重放不增生行');
  assert.equal(tasksRepo.listTasksByQueue(q2.id).length, 2, '收养复位不产重复任务行');
  // 追加曲位置仍钉在尾部（原位刷新而非再 append），标记不因重放丢
  const rows = playlistTracksRepo.listTracksByPlaylistId(pl.id);
  assert.equal(rows.at(-1).id, 'yt_idem0000005');
  assert.equal(localAddedFlag(pl.id, 'yt_idem0000005'), 1);
});

test('S2：本地镜像单（source=local）delta 两键全忽略', async () => {
  // local_pl_ 镜像行的曲目表由 /downloads/local/mirror 整表重写承载——
  // delta 不插手：addedTracks 不落库、removedIds 不过滤镜像行、标记面不剪
  const pl = playlistsRepo.upsertPlaylist({
    neteasePlaylistId: 'local_pl_s2gate', name: '本地单', source: 'local'
  });
  playlistTracksRepo.replaceTracksForPlaylist(pl.id, [
    { id: '880101', name: '镜像一', ar: [], al: {}, dt: 1 },
    { id: '880102', name: '镜像二', ar: [], al: {}, dt: 1 }
  ]);
  const queue = await dm.createDownloadQueue(pl.id, queueOpts({
    localDelta: {
      addedTracks: [{ id: 'yt_s2shouldnt', name: '不该落', ar: [], al: {}, dt: 1 }],
      removedIds: ['880101']
    }
  }));

  assert.equal(playlistTracksRepo.findTrackBySongId(pl.id, 'yt_s2shouldnt'), null,
    '本地单 upsert 被跳过');
  assert.deepEqual(queueSongIds(queue.id), ['880101', '880102'],
    'removedIds 对镜像行不生效——过滤也随本地单一并跳过');
});

test('S3：delta 先于活跃队列 409 落库——撞 409 后行已在、可重建', async () => {
  // applyLocalTrackDelta 在「已有进行中队列」409 之前执行：建队被拒的
  // 请求照样把追加面落库，等队列终态后重试即正常入队
  const pl = seedRemote('779012', [{ id: '77901201', name: 'x', ar: [], al: {}, dt: 1 }]);
  const q1 = await dm.createDownloadQueue(pl.id, queueOpts());
  assert.equal(q1.status, 'pending');

  await assert.rejects(
    dm.createDownloadQueue(pl.id, queueOpts({
      localDelta: {
        addedTracks: [{ id: 'yt_pre409ready', name: '先落', ar: [], al: {}, dt: 1 }],
        removedIds: []
      }
    })),
    /进行中的下载队列/
  );
  // 409 没挡住落库：标记行已写入
  assert.equal(localAddedFlag(pl.id, 'yt_pre409ready'), 1);

  queuesRepo.updateQueue(q1.id, { status: 'cancelled' });
  const q2 = await dm.createDownloadQueue(pl.id, queueOpts({
    localDelta: {
      addedTracks: [{ id: 'yt_pre409ready', name: '先落', ar: [], al: {}, dt: 1 }],
      removedIds: []
    }
  }));
  assert.deepEqual(queueSongIds(q2.id), ['77901201', 'yt_pre409ready']);
});

test('removedIds 虚拟过滤先于判空：全曲墓碑远端单报「没有歌曲」而非建空队', async () => {
  const pl = seedRemote('779013', [{ id: '77901301', name: 'x', ar: [], al: {}, dt: 1 }]);
  await assert.rejects(
    dm.createDownloadQueue(pl.id, queueOpts({
      localDelta: { addedTracks: [], removedIds: ['77901301'] }
    })),
    /歌单中没有歌曲/
  );
  // 行仍在——撤碑后还能建队
  assert.equal(playlistTracksRepo.listTracksByPlaylistId(pl.id).length, 1);
});

test('路由级：POST /downloads/queues 透传 localDelta 落库建队', async () => {
  const pl = seedRemote('779008', [
    { id: '77900801', name: '留', ar: [], al: {}, dt: 1 },
    { id: '77900802', name: '删', ar: [], al: {}, dt: 1 }
  ]);
  const res = await app.request('http://t/downloads/queues', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playlistId: pl.id,
      localDelta: {
        addedTracks: [{
          id: 'yt_routedelta8', name: '路由追加', ar: [{ name: 'ch' }], al: {}, dt: 1,
          youtube: { videoId: 'routedelta8' }
        }],
        removedIds: ['77900802']
      }
    })
  });
  assert.equal(res.status, 200);
  const queue = (await res.json()).data;
  assert.deepEqual(queueSongIds(queue.id), ['77900801', 'yt_routedelta8']);
  const ytTask = tasksRepo.findAnyTaskByPlaylistAndSongId(pl.id, 'yt_routedelta8');
  assert.equal(ytTask.providerData?.youtube?.videoId, 'routedelta8');
  // 墓碑曲过滤不入队但行保留（虚拟过滤语义）
  assert.notEqual(playlistTracksRepo.findTrackBySongId(pl.id, '77900802'), null);
});

test('路由级：localDelta 形状越界 400（schema 体量硬边界）', async () => {
  const pl = seedRemote('779009', [{ id: '77900901', name: 'x', ar: [], al: {}, dt: 1 }]);
  const res = await app.request('http://t/downloads/queues', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playlistId: pl.id,
      localDelta: { addedTracks: 'not-array', removedIds: [] }
    })
  });
  assert.equal(res.status, 400);
});

// ── 单曲下载路径（POST /downloads/songs/:songId 的 track 载荷）──
// 远端单追加曲（qq_/bv_/yt_ 与数字 id 追加曲）在服务端 playlist_tracks
// 无行，旧路径 find(songId) 必 404——track 瘦身投影随请求下发，服务端在
// 枚举前增量补行：只插不改（已存在行零写，瘦身投影不降级 richer raw_json），
// 缺席才 local_added=1 补尾位。与权威对账共用标记面：谎报行（曲其实不在
// 客户端 addedTracks）靠该单下轮 delta 建队的 prune 扫掉才自愈——该单
// 不再建队则无害留存（自愈非必然事件），单曲段无需验真。

test('单曲 track 载荷：数字远端单 + yt_ 追加曲 → 200 任务且 providerData 带 youtube 定位', async () => {
  const pl = seedRemote('779020', [
    { id: '77902001', name: '远端曲', ar: [{ name: 'a' }], al: { name: 'b' }, dt: 1000 }
  ]);
  const res = await app.request('http://t/downloads/songs/yt_single00001', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playlistId: pl.id,
      track: {
        id: 'yt_single00001', name: '追加曲', ar: [{ name: 'UP' }], al: { name: '' }, dt: 200000,
        youtube: { videoId: 'single00001', title: '源标题', author: 'UP主' }
      }
    })
  });
  assert.equal(res.status, 200);

  // 行级落库：追加尾位 + local_added=1 标记 + provider 字段进 raw_json
  const rows = playlistTracksRepo.listTracksByPlaylistId(pl.id);
  assert.equal(rows.length, 2);
  assert.equal(rows.at(-1).id, 'yt_single00001');
  assert.equal(rows.at(-1).youtube.videoId, 'single00001');
  assert.equal(localAddedFlag(pl.id, 'yt_single00001'), 1);
  assert.equal(localAddedFlag(pl.id, '77902001'), 0); // 上游行不标
  // providerData 由落库行派生——youtube 流定位随任务行走（自有源下载链可达）
  const ytTask = tasksRepo.findAnyTaskByPlaylistAndSongId(pl.id, 'yt_single00001');
  assert.ok(ytTask);
  assert.equal(ytTask.providerData?.youtube?.videoId, 'single00001');
  assert.equal(ytTask.providerData?.youtube?.title, '源标题');
  assert.equal(ytTask.providerData?.youtube?.author, 'UP主');
});

test('单曲 track 载荷与 songId 不一致 → 400，两侧 id 都不落库', async () => {
  // 载荷不一致是客户端 bug/攻击面——如实拒，不悄悄按任一 id 补行
  const pl = seedRemote('779021', [
    { id: '77902101', name: 'x', ar: [], al: {}, dt: 1 }
  ]);
  const res = await app.request('http://t/downloads/songs/yt_mismatch001', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playlistId: pl.id,
      track: { id: 'yt_other000001', name: '冒名', ar: [], al: {}, dt: 1 }
    })
  });
  assert.equal(res.status, 400);
  assert.equal(playlistTracksRepo.findTrackBySongId(pl.id, 'yt_mismatch001'), null);
  assert.equal(playlistTracksRepo.findTrackBySongId(pl.id, 'yt_other000001'), null);
});

test('单曲无 track 的旧路径：曲目表无该曲仍 404（回归钉）', async () => {
  const pl = seedRemote('779022', [
    { id: '77902201', name: 'x', ar: [], al: {}, dt: 1 }
  ]);
  const res = await app.request('http://t/downloads/songs/yt_absent00001', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playlistId: pl.id })
  });
  assert.equal(res.status, 404);
  assert.equal(playlistTracksRepo.findTrackBySongId(pl.id, 'yt_absent00001'), null);
});

test('单曲 track 载荷撞上游已存在行 → 零写：raw_json 原样不被瘦身投影降级', async () => {
  // 关键不变量：单曲路径是增量补行不是权威对账——上游行 richer raw_json
  // （上游详情全字段）绝不能被客户端瘦身投影 UPDATE 降级，也不 append 二行
  const rich = {
    id: '77902301', name: '上游曲', ar: [{ name: 'a', id: 7, alias: ['x'] }],
    al: { name: 'b', picUrl: 'https://p1.music.126.net/c.jpg' }, dt: 1000,
    privilege: { fee: 1 }, mv: 99, richField: { nested: [1, 2, 3] }
  };
  const pl = seedRemote('779023', [rich]);
  const rawBefore = getDb().prepare(
    'SELECT raw_json FROM playlist_tracks WHERE playlist_id = ? AND song_id = ?'
  ).get(pl.id, '77902301').raw_json;

  // 客户端发的瘦身投影（与 projectTrackForDownload 同形——只有投影列字段）
  const res = await app.request('http://t/downloads/songs/77902301', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playlistId: pl.id,
      track: { id: '77902301', name: '上游曲', ar: [{ name: 'a' }], al: { name: 'b' }, dt: 1000 }
    })
  });
  assert.equal(res.status, 200);

  const rawAfter = getDb().prepare(
    'SELECT raw_json FROM playlist_tracks WHERE playlist_id = ? AND song_id = ?'
  ).get(pl.id, '77902301').raw_json;
  assert.equal(rawAfter, rawBefore, '已存在上游行不得被瘦身投影改写');
  assert.equal(localAddedFlag(pl.id, '77902301'), 0, '上游行不置 local_added 标记');
  assert.equal(playlistTracksRepo.listTracksByPlaylistId(pl.id).length, 1, '不追加重复行');
});

test('数字 id 追加曲同链可下：addedTracks 里的另一首网易曲不再 404', async () => {
  // 菜单本就亮着（数字 id 全场景可下）但曲目表无行必 404——track 载荷
  // 把 addedTracks 成员增量补进 playlist_tracks
  const pl = seedRemote('779024', [
    { id: '77902401', name: '远端曲', ar: [{ name: 'a' }], al: {}, dt: 1 }
  ]);
  const res = await app.request('http://t/downloads/songs/77902499', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playlistId: pl.id,
      track: { id: '77902499', name: '追加网易曲', ar: [{ name: 'b' }], al: {}, dt: 3000 }
    })
  });
  assert.equal(res.status, 200);
  assert.equal(localAddedFlag(pl.id, '77902499'), 1);
  const task = tasksRepo.findAnyTaskByPlaylistAndSongId(pl.id, '77902499');
  assert.ok(task);
  assert.equal(task.songName, '追加网易曲');
});

test('单曲 track 载荷白名单弃件（file_）：跳过补插，find 自然 404', async () => {
  // file_ 上传曲资产本就在服务端——track 载荷不给它开口：消毒弃件跳过
  // 补插后按旧路径走，曲目表无该曲 404 如实上报
  const pl = seedRemote('779025', [
    { id: '77902501', name: 'x', ar: [], al: {}, dt: 1 }
  ]);
  const res = await app.request('http://t/downloads/songs/file_abcd1234', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playlistId: pl.id,
      track: { id: 'file_abcd1234', name: '上传曲', ar: [], al: {}, dt: 1 }
    })
  });
  assert.equal(res.status, 404);
  assert.equal(playlistTracksRepo.findTrackBySongId(pl.id, 'file_abcd1234'), null);
});

test('单曲 track 载荷对 source=local 镜像单不补插：谎报曲不落 local_added 幽灵行', async () => {
  // N1 纵深闸：本地单曲目表由 /downloads/local/mirror 整表重写承载——
  // 客户端正常链不发 track（本地单走镜像链），谎报/误发的载荷也不该在
  // 镜像表落 local_added 行：applyLocalTrackDelta 对本地单早退、prune
  // 永不可达，幽灵行会一直躺在枚举面内直到下一次整表重写
  const pl = playlistsRepo.upsertPlaylist({
    neteasePlaylistId: 'local_pl_n1gate', name: '本地单', source: 'local'
  });
  playlistTracksRepo.replaceTracksForPlaylist(pl.id, [
    { id: '880301', name: '镜像一', ar: [], al: {}, dt: 1 },
    { id: '880302', name: '镜像二', ar: [], al: {}, dt: 1 }
  ]);

  // 曲不在镜像表：补插被闸 → find 落空 404，表内不增生行
  const res404 = await app.request('http://t/downloads/songs/yt_n1ghost001', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playlistId: pl.id,
      track: {
        id: 'yt_n1ghost001', name: '谎报曲', ar: [], al: {}, dt: 1,
        youtube: { videoId: 'n1ghost001' }
      }
    })
  });
  assert.equal(res404.status, 404);
  assert.equal(playlistTracksRepo.findTrackBySongId(pl.id, 'yt_n1ghost001'), null,
    '本地单不落 local_added 幽灵行');
  assert.equal(playlistTracksRepo.listTracksByPlaylistId(pl.id).length, 2);

  // 曲在镜像表：跳过补插不影响提交——find 仍按镜像行解析走通
  const res200 = await app.request('http://t/downloads/songs/880301', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playlistId: pl.id,
      track: { id: '880301', name: '镜像一', ar: [], al: {}, dt: 1 }
    })
  });
  assert.equal(res200.status, 200);
  assert.ok(tasksRepo.findAnyTaskByPlaylistAndSongId(pl.id, '880301'));
  assert.equal(playlistTracksRepo.listTracksByPlaylistId(pl.id).length, 2);
  assert.equal(localAddedFlag(pl.id, '880301'), 0, '镜像行不置 local_added');
});

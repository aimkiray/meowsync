// 镜像投影 → playlist_tracks.raw_json → providerDataOf 的端到端回归：
// 这个链路断过一次（客户端投影丢 title/author，下载侧歌词归属核验成死代码），
// 这里的用例钉住「来源元数据必须活到 providerData」全链。
// DATA_DIR 指向临时目录，db/client 首次 require 时在该处建库跑迁移
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-mirror-');
const require = createRequire(import.meta.url);

let mirror, tracksRepo, providerDataOf, downloadTasksRepo;
before(() => {
  mirror = require('../src/server/services/local-mirror.js');
  tracksRepo = require('../src/server/repositories/playlistTracks.js');
  providerDataOf = require('../src/server/services/download-manager.js').providerDataOf;
  downloadTasksRepo = require('../src/server/repositories/downloadTasks.js');
});

const track = (over = {}) => ({
  id: 'bv_t1', name: '歌名', ar: [{ name: 'UP' }], al: { name: '', picUrl: '' },
  dt: 200000,
  bilibili: { bvid: 'BV1xx411c7mD', cid: '123456', page: 2, title: '视频标题', author: 'UP主名' },
  neteaseId: '456789',
  ...over
});

test('镜像链：bilibili title/author 穿透 raw_json 到 providerData', () => {
  const row = mirror.mirrorLocalPlaylist('local_pl_a', '歌单', '', [track()]);
  const [stored] = tracksRepo.listTracksByPlaylistId(row.id);
  const pd = providerDataOf(stored);
  assert.deepEqual(pd, {
    bilibili: { bvid: 'BV1xx411c7mD', cid: '123456', page: 2, title: '视频标题', author: 'UP主名' },
    neteaseId: '456789'
  });
});

test('镜像链：youtube 投影同样穿透 + 超长按服务端口径截断', () => {
  const longTitle = 't'.repeat(400), longAuthor = 'a'.repeat(200);
  const row = mirror.mirrorLocalPlaylist('local_pl_b', '歌单', '', [{
    id: 'yt_abc123', name: '歌名', ar: [{ name: 'ch' }], al: { name: '' }, dt: 100,
    youtube: { videoId: 'abc123', title: longTitle, author: longAuthor },
    neteaseId: '789'
  }]);
  const [stored] = tracksRepo.listTracksByPlaylistId(row.id);
  const pd = providerDataOf(stored);
  assert.equal(pd.youtube.videoId, 'abc123');
  assert.equal(pd.youtube.title.length, 300);    // 截断在 providerDataOf 收口
  assert.equal(pd.youtube.author.length, 120);
  assert.equal(pd.neteaseId, '789');
});

test('老镜像（无 title/author）重传补齐：签名变化触发重写', () => {
  const bare = { id: 'bv_t2', name: '歌名', ar: [{ name: 'UP' }], al: { name: '' }, dt: 200000,
    bilibili: { bvid: 'BV2xx', cid: '99', page: 1 } };        // 无 title/author/neteaseId
  const row = mirror.mirrorLocalPlaylist('local_pl_c', '歌单', '', [bare]);
  let [stored] = tracksRepo.listTracksByPlaylistId(row.id);
  assert.equal(providerDataOf(stored).bilibili.title, null); // 老数据无损降级为 null

  // 重传带全字段——sigOf 差异必须触发 replace，否则 providerData 永远陈旧
  mirror.mirrorLocalPlaylist('local_pl_c', '歌单', '', [{
    ...bare, bilibili: { ...bare.bilibili, title: '新标题', author: 'UP' }, neteaseId: '777'
  }]);
  const pd = providerDataOf(tracksRepo.listTracksByPlaylistId(row.id)[0]);
  assert.equal(pd.bilibili.title, '新标题');
  assert.equal(pd.bilibili.author, 'UP');
  assert.equal(pd.neteaseId, '777');
});

test('镜像链：publishedAt 穿透 raw_json 到 providerData；缺席/脏值不出键', () => {
  const ms = 1586217600000;   // 2020-04-07T00:00:00Z
  const row = mirror.mirrorLocalPlaylist('local_pl_pub1', '歌单', '', [
    { id: 'bv_p1', name: 'x', ar: [{ name: 'UP' }], al: { name: '' }, dt: 200000,
      bilibili: { bvid: 'BV1xx411c7mD', cid: '123456', page: 2, title: 't', author: 'a', publishedAt: ms } },
    { id: 'yt_p2', name: 'y', ar: [{ name: 'ch' }], al: { name: '' }, dt: 100,
      youtube: { videoId: 'abcdefghijk', title: 't', author: 'a', publishedAt: ms } },
  ]);
  const [s1, s2] = tracksRepo.listTracksByPlaylistId(row.id);
  assert.equal(providerDataOf(s1).bilibili.publishedAt, ms);
  assert.equal(providerDataOf(s2).youtube.publishedAt, ms);
  // 缺席/脏值不产键——providerData 投影面与既有 deepEqual 断言同形零扰动
  const row2 = mirror.mirrorLocalPlaylist('local_pl_pub2', '歌单', '', [
    { id: 'bv_p3', name: 'x', ar: [{ name: 'U' }], al: { name: '' }, dt: 100,
      bilibili: { bvid: 'BV3xx', cid: '1', page: 1, title: 't', author: 'a' } },
    { id: 'bv_p4', name: 'x', ar: [{ name: 'U' }], al: { name: '' }, dt: 100,
      bilibili: { bvid: 'BV4xx', cid: '1', page: 1, title: 't', author: 'a', publishedAt: null } },
    { id: 'bv_p5', name: 'x', ar: [{ name: 'U' }], al: { name: '' }, dt: 100,
      bilibili: { bvid: 'BV5xx', cid: '1', page: 1, title: 't', author: 'a', publishedAt: -5 } },
    { id: 'bv_p6', name: 'x', ar: [{ name: 'U' }], al: { name: '' }, dt: 100,
      bilibili: { bvid: 'BV6xx', cid: '1', page: 1, title: 't', author: 'a', publishedAt: '脏' } },
  ]);
  for (const stored of tracksRepo.listTracksByPlaylistId(row2.id)) {
    assert.equal('publishedAt' in providerDataOf(stored).bilibili, false,
      `${stored.id} 缺席/脏值不落 publishedAt 键`);
  }
});

test('老镜像（无 publishedAt）重传补齐：签名变化触发重写自愈', () => {
  const ms = 1664197919000;   // 2022-09-26
  const bare = { id: 'bv_p7', name: '歌名', ar: [{ name: 'UP' }], al: { name: '' }, dt: 200000,
    bilibili: { bvid: 'BV7xx', cid: '9', page: 1, title: 't', author: 'a' } };   // 无 publishedAt
  const row = mirror.mirrorLocalPlaylist('local_pl_pub3', '歌单', '', [bare]);
  const [stored] = tracksRepo.listTracksByPlaylistId(row.id);
  assert.equal('publishedAt' in providerDataOf(stored).bilibili, false);

  // 客户端带新字段重传——sigOf 的新分量必须让这次 rewrite 发生
  // （publishedAt 从无到有落 raw_json），否则老镜像永远拿不到时间证据
  mirror.mirrorLocalPlaylist('local_pl_pub3', '歌单', '', [{
    ...bare, bilibili: { ...bare.bilibili, publishedAt: ms },
  }]);
  const pd = providerDataOf(tracksRepo.listTracksByPlaylistId(row.id)[0]);
  assert.equal(pd.bilibili.publishedAt, ms);
  // 幂等复查：同值重传签名不变（不该把 0/缺席再洗掉）
  mirror.mirrorLocalPlaylist('local_pl_pub3', '歌单', '', [{
    ...bare, bilibili: { ...bare.bilibili, publishedAt: ms },
  }]);
  assert.equal(providerDataOf(tracksRepo.listTracksByPlaylistId(row.id)[0]).bilibili.publishedAt, ms);
});

test('镜像链：qq publishedAt 穿透 raw_json 到 providerData；缺席/脏值不出键', () => {
  const ms = 1193932800000;   // 2007-11-01
  const row = mirror.mirrorLocalPlaylist('local_pl_qqpub', '歌单', '', [
    { id: 'qq_m1', name: 'x', ar: [{ name: '歌手' }], al: {}, dt: 200000,
      qq: { mediaMid: 'mm1', publishedAt: ms }, neteaseId: '555' },
    { id: 'qq_m2', name: 'y', ar: [{ name: '歌手' }], al: {}, dt: 200000,
      qq: { mediaMid: 'mm2' }, neteaseId: '556' },
    { id: 'qq_m3', name: 'z', ar: [{ name: '歌手' }], al: {}, dt: 200000,
      qq: { mediaMid: 'mm3', publishedAt: -5 } },
  ]);
  const [q1, q2, q3] = tracksRepo.listTracksByPlaylistId(row.id);
  assert.equal(providerDataOf(q1).qq.publishedAt, ms); // grafted 核验链的时间证据
  assert.equal('publishedAt' in providerDataOf(q2).qq, false);
  assert.equal('publishedAt' in providerDataOf(q3).qq, false);

  // sigOf 含 qq.publishedAt：同曲带新字段重传触发一次性重写自愈——
  // 签名不吃它的话老镜像行被跳过重写，providerData 永远拿不到日期
  mirror.mirrorLocalPlaylist('local_pl_qqpub', '歌单', '', [
    { id: 'qq_m2', name: 'y', ar: [{ name: '歌手' }], al: {}, dt: 200000,
      qq: { mediaMid: 'mm2', publishedAt: ms }, neteaseId: '556' },
  ]);
  assert.equal(
    providerDataOf(tracksRepo.listTracksByPlaylistId(row.id)[0]).qq.publishedAt, ms);
});

test('providerDataOf 边界：qq 分支带回落词源签名 / 纯网易云曲为 null / 缺 provider 字段的外部曲保底 neteaseId', () => {
  // qq 曲：mediaMid + 回落核验签名（名/艺人）+ neteaseId 全带
  const qqPd = providerDataOf({ id: 'qq_001', name: 'QQ曲', ar: [{ name: '歌手甲' }], qq: { mediaMid: 'mid1' }, neteaseId: '555' });
  assert.deepEqual(qqPd, {
    qq: { mediaMid: 'mid1' }, neteaseId: '555', title: 'QQ曲', author: '歌手甲'
  });
  // 纯网易云曲：providerData 为 null（词源=自身 id，无需快照）
  assert.equal(providerDataOf({ id: '12345', name: 'x', ar: [], al: {} }), null);
  // 外部曲缺 provider 定位字段但有匹配词源——neteaseId 单独落库保词源
  assert.deepEqual(providerDataOf({ id: 'bv_BV1xx411c7mD', name: 'x', neteaseId: '88' }), { neteaseId: '88' });
  // qq_<mid> 裸 id（mediaMid 缺位的镜像/旧数据残缺行）与 bv_/yt_ 同权——回链键不丢
  assert.deepEqual(providerDataOf({ id: 'qq_001ABCdef234', name: 'x', neteaseId: '99' }), { neteaseId: '99' });
  // 数字 id 曲即便混进 neteaseId 字段也不产 providerData（自身即词源）
  assert.equal(providerDataOf({ id: '12345', name: 'x', neteaseId: '12345' }), null);
});

test('updateTask 白名单：providerData 写入往返 + null 清列', () => {
  const row = mirror.mirrorLocalPlaylist('local_pl_d', '歌单', '', [track()]);
  const task = downloadTasksRepo.createTask({
    playlistId: row.id, queueId: null, songId: 'bv_BV1xx411c7mD', songName: '歌名', artist: 'UP',
    providerData: { bilibili: { bvid: 'BV1xx411c7mD', title: '旧标题' } }
  });
  assert.equal(task.providerData.bilibili.title, '旧标题');
  // 复位路径的刷新形态：新快照覆盖
  downloadTasksRepo.updateTask(task.id, { providerData: { bilibili: { bvid: 'BV1xx411c7mD', title: '新标题' } } });
  assert.equal(downloadTasksRepo.findTaskById(task.id).providerData.bilibili.title, '新标题');
  // null 显式清列——providerDataOf 判 null 时别留旧快照
  downloadTasksRepo.updateTask(task.id, { providerData: null });
  assert.equal(downloadTasksRepo.findTaskById(task.id).providerData, null);
});

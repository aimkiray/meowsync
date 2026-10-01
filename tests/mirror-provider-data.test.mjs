// 镜像投影 → playlist_tracks.raw_json → providerDataOf 的端到端回归：
// 这个链路断过一次（客户端投影丢 title/author，下载侧歌词归属核验成死代码），
// 这里的用例钉住「来源元数据必须活到 providerData」全链。
// DATA_DIR 指向临时目录，db/client 首次 require 时在该处建库跑迁移
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'meowsync-mirror-'));
const require = createRequire(import.meta.url);

let mirror, tracksRepo, providerDataOf;
before(() => {
  mirror = require('../src/server/services/local-mirror.js');
  tracksRepo = require('../src/server/repositories/playlistTracks.js');
  providerDataOf = require('../src/server/services/download-manager.js').providerDataOf;
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

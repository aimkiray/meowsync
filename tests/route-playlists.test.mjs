// routes/playlists.js 冒烟：id 校验 / list/detail 形状 / import 的前导零
// 归一化与墓碑 409 / refresh 本地单拒绝 / delete 的 local_uploads 护栏。
// playlist-sync 与 download-manager 全桩（级联真身在 queue-delete-cascade
// 已钉）；deletion-locks 用真身——墓碑是本路由的独有拒因。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { seed, tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-route-pl-');
const require = createRequire(import.meta.url);

const importCalls = [];
let syncDetail = null;
seed('../src/server/services/playlist-sync.js', {
  importPlaylistFromNetease: async (neteasePlaylistId, opts) => {
    importCalls.push({ neteasePlaylistId, ...opts });
    return { id: 501, neteasePlaylistId, name: 'imported' };
  },
  getPlaylistDetail: () => syncDetail,
  listSavedPlaylists: () => [{ id: 1, name: 'saved' }],
});
let cascadeResult = true;
const cascadeCalls = [];
seed('../src/server/services/download-manager.js', {
  deletePlaylistCascade: async (id) => { cascadeCalls.push(id); return cascadeResult; },
});

let app, playlistsRepo, locks;
before(() => {
  app = require('../src/server/routes/playlists.js');
  playlistsRepo = require('../src/server/repositories/playlists.js');
  locks = require('../src/server/lib/deletion-locks.js');
});
after(() => { rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

const json = async (res) => ({ status: res.status, body: await res.json().catch(() => null) });
const post = (path, body = {}) => app.request(`http://t${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('playlists：list/detail 形状 + id 校验 400/404', async () => {
  const list = await json(await app.request('http://t/playlists'));
  assert.equal(list.body.code, 200);
  assert.equal(list.body.playlists[0].name, 'saved');

  assert.equal((await app.request('http://t/playlists/abc')).status, 400);
  syncDetail = null;
  assert.equal((await app.request('http://t/playlists/999')).status, 404);
  syncDetail = { id: 9, name: 'x' };
  const ok = await json(await app.request('http://t/playlists/9'));
  assert.equal(ok.body.playlist.name, 'x');
});

test('playlists/import：非法 neteasePlaylistId 400；前导零归一化进服务', async () => {
  const bad = await post('/playlists/import', { neteasePlaylistId: 'abc!' });
  assert.equal(bad.status, 400);

  const ok = await json(await post('/playlists/import', { neteasePlaylistId: '000123' }));
  assert.equal(ok.status, 200);
  assert.equal(importCalls.at(-1).neteasePlaylistId, '123'); // 前导零已剥
});

test('playlists/import：网易云 id 墓碑窗内 → 409（级联后防复活）', async () => {
  locks.markNeteasePlaylistDeleted('555001');
  try {
    const r = await post('/playlists/import', { neteasePlaylistId: '555001' });
    assert.equal(r.status, 409);
  } finally {
    locks.deletingNeteasePlaylists.delete('555001');
  }
});

test('playlists/import：本地行还在且挂级联锁 → 409', async () => {
  const row = playlistsRepo.upsertPlaylist({ neteasePlaylistId: '555002', name: 'del-pl' });
  locks.deletingPlaylists.add(row.id);
  try {
    const r = await post('/playlists/import', { neteasePlaylistId: '555002' });
    assert.equal(r.status, 409);
  } finally {
    locks.deletingPlaylists.delete(row.id);
  }
});

test('playlists/refresh：本地歌单 400 / 级联锁 409 / 不存在 404 / 正常 200', async () => {
  // 本地歌单（非纯数字远端 id）没有可刷新源
  const local = playlistsRepo.upsertPlaylist({ neteasePlaylistId: 'local_pl_test1', name: '本地', source: 'local' });
  assert.equal((await post(`/playlists/${local.id}/refresh`)).status, 400);

  const remote = playlistsRepo.upsertPlaylist({ neteasePlaylistId: '555003', name: '远端' });
  locks.deletingPlaylists.add(remote.id);
  assert.equal((await post(`/playlists/${remote.id}/refresh`)).status, 409);
  locks.deletingPlaylists.delete(remote.id);

  assert.equal((await post('/playlists/999999/refresh')).status, 404);
  const ok = await post(`/playlists/${remote.id}/refresh`);
  assert.equal(ok.status, 200);
  assert.equal(importCalls.at(-1).neteasePlaylistId, '555003');
});

test('playlists/delete：local_uploads 护栏 400 / 不存在 404 / 级联真值 200', async () => {
  const uploads = playlistsRepo.upsertPlaylist({ neteasePlaylistId: 'local_uploads', name: '上传库', source: 'local' });
  const guard = await app.request(`http://t/playlists/${uploads.id}`, { method: 'DELETE' });
  assert.equal(guard.status, 400);
  assert.equal(cascadeCalls.length, 0); // 护栏早于级联

  cascadeResult = false;
  const missing = playlistsRepo.upsertPlaylist({ neteasePlaylistId: '555004', name: 'gone' });
  const nf = await app.request(`http://t/playlists/${missing.id}`, { method: 'DELETE' });
  assert.equal(nf.status, 404);

  cascadeResult = true;
  const del = await app.request(`http://t/playlists/${missing.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal(cascadeCalls.at(-1), missing.id);
});

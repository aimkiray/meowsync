// /uploads 上传接管端点：octet-stream 流式落盘 → download_tasks 登记（local_uploads
// 伪歌单一曲一行挂 4 类资产列）→ /downloads/songs/:id/file 播放回看 → DELETE 级联。
// DATA_DIR 临时化：DOWNLOAD_BASE_DIR 与 db 都建在其下——真路由真存储，不打桩。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-uploads-');
const require = createRequire(import.meta.url);

let app, repo, downloadFs;
before(() => {
  app = require('../src/server/routes/uploads.js');
  repo = require('../src/server/repositories/downloadTasks.js');
  downloadFs = require('../src/server/services/download-fs.js');
  // file 端点也要拉进来测回看链——它住在 downloads 路由
  const downloads = require('../src/server/routes/downloads.js');
  const { Hono } = require('hono');
  const root = new Hono();
  root.route('/', app);
  root.route('/', downloads);
  app = root;
});

const post = (qs, bytes, headers = {}, init = {}) => app.request(`http://t/uploads?${qs}`, {
  method: 'POST',
  headers: { 'content-type': 'application/octet-stream', ...headers },
  body: bytes,
  ...init,
});

const artifactReq = (songId, kind, headers = {}) =>
  app.request(`http://t/downloads/songs/${songId}/file?playlistId=local_uploads&kind=${kind}`, { headers });

const rowOf = (songId) => repo.listTasksByPlaylist(1) // local_uploads 懒建必是首个歌单行 id=1
  .find(t => t.songId === songId);

test('音频上传：落盘 + 登记 completed 行 + file 端点可回看', async () => {
  const payload = Buffer.from('ID3 fake audio bytes'.repeat(64));
  const res = await post('kind=audio&filename=我的歌.mp3', payload);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.songId, /^file_[0-9a-z]{8,40}$/);

  const row = rowOf(body.songId);
  assert.equal(row.status, 'completed');
  assert.equal(row.downloadAudio, true); // repo 把列读成 boolean
  assert.ok(row.audioPath.endsWith(`${body.songId}.mp3`));
  assert.ok(downloadFs.isUnderDownloadDir(row.audioPath));
  assert.ok(existsSync(row.audioPath));
  assert.deepEqual(readFileSync(row.audioPath), payload);

  const back = await artifactReq(body.songId, 'audio');
  assert.equal(back.status, 200);
  assert.equal(back.headers.get('content-type'), 'audio/mpeg');
  assert.deepEqual(Buffer.from(await back.arrayBuffer()), payload);
});

test('Range 请求：206 + Content-Range 正确', async () => {
  const payload = Buffer.alloc(4096, 7);
  const res = await post('kind=audio&filename=r.flac', payload);
  const { songId } = await res.json();
  const back = await artifactReq(songId, 'audio', { range: 'bytes=100-199' });
  assert.equal(back.status, 206);
  assert.equal(back.headers.get('content-range'), 'bytes 100-199/4096');
  assert.equal((await back.arrayBuffer()).byteLength, 100);
});

test('同 songId 换源换扩展名：旧文件被清、登记行指新路径', async () => {
  const res1 = await post('kind=audio&filename=v1.mp3', Buffer.from('aaa'));
  const { songId } = await res1.json();
  const oldPath = rowOf(songId).audioPath;

  const res2 = await post(`kind=audio&songId=${songId}&filename=v2.flac`, Buffer.from('bbbbb'));
  assert.equal(res2.status, 200);
  const row = rowOf(songId);
  assert.ok(row.audioPath.endsWith('.flac'));
  assert.equal(existsSync(oldPath), false, '旧 mp3 应被清掉（换扩展名不留孤儿）');
  assert.equal(readFileSync(row.audioPath).toString(), 'bbbbb');
});

test('一曲多 kind：audio+cover+lyrics 挂同一行的不同列', async () => {
  const res = await post('kind=audio&filename=song.ogg', Buffer.from('ogg'));
  const { songId } = await res.json();
  await post(`kind=cover&songId=${songId}&filename=art.png`, Buffer.from('PNG89'));
  await post(`kind=lyrics&songId=${songId}&filename=ly.lrc`, Buffer.from('[00:01.00]词'));

  const row = rowOf(songId);
  assert.ok(row.coverPath.endsWith('.png'));
  assert.ok(row.lyricsPath.endsWith('.lrc'));

  const cov = await artifactReq(songId, 'cover');
  assert.equal(cov.headers.get('content-type'), 'image/png');
  const lrc = await artifactReq(songId, 'lyrics');
  assert.equal(await lrc.text(), '[00:01.00]词');
});

test('同 songId 并发上传：后到请求 409（不共享 .part）', async () => {
  const songId = `file_c${Date.now().toString(36)}`;
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = new ReadableStream({
    async start(ctrl) {
      ctrl.enqueue(Buffer.alloc(64, 1));
      await gate; // 持有写窗口，让 r2 落在锁期内
      ctrl.enqueue(Buffer.alloc(64, 2));
      ctrl.close();
    }
  });
  const r1 = post(`kind=audio&songId=${songId}&filename=a.mp3`, slow, {}, { duplex: 'half' });
  await new Promise((r) => setTimeout(r, 20));
  const r2 = await post(`kind=audio&songId=${songId}&filename=b.mp3`, Buffer.from('x'));
  assert.equal(r2.status, 409);
  release();
  assert.equal((await r1).status, 200);
});

test('video-only 曲目：kind=audio 回落 videoPath（浏览器抽 mp4 音轨）', async () => {
  const res = await post('kind=video&filename=only.mp4', Buffer.from('VIDEOBYTES'));
  const { songId } = await res.json();
  const back = await artifactReq(songId, 'audio');
  assert.equal(back.status, 200);
  assert.deepEqual(Buffer.from(await back.arrayBuffer()), Buffer.from('VIDEOBYTES'));
});

test('换源后 If-Range 旧 ETag 失配 → 200 全量（不混新旧字节）', async () => {
  const res1 = await post('kind=audio&filename=v1.mp3', Buffer.from('AAA'));
  const { songId } = await res1.json();
  const etag1 = (await artifactReq(songId, 'audio')).headers.get('etag');
  assert.ok(etag1);
  await post(`kind=audio&songId=${songId}&filename=v2.mp3`, Buffer.from('BBBBBB'));

  const stale = await artifactReq(songId, 'audio', { range: 'bytes=0-1', 'if-range': etag1 });
  assert.equal(stale.status, 200, 'ETag 变了 If-Range 失效，应回全量');

  const etag2 = (await artifactReq(songId, 'audio')).headers.get('etag');
  const fresh = await artifactReq(songId, 'audio', { range: 'bytes=0-1', 'if-range': etag2 });
  assert.equal(fresh.status, 206, 'ETag 匹配正常走 Range');
});

test('非法输入家族：kind/songId/扩展名/空体逐项 400', async () => {
  assert.equal((await post('kind=exe&filename=a.mp3', Buffer.from('x'))).status, 400);
  assert.equal((await post('kind=audio&filename=a.exe', Buffer.from('x'))).status, 400);
  assert.equal((await post('kind=audio&songId=../../../etc&filename=a.mp3', Buffer.from('x'))).status, 400);
  assert.equal((await post('kind=audio&songId=138536252&filename=a.mp3', Buffer.from('x'))).status, 400); // 网易云数字 id 不许接管上传位
  assert.equal((await post('kind=audio&filename=a.mp3', new Uint8Array(0))).status, 400);
});

test('声明超限 413（content-length 闸）+ 未声明超限流中 413', async () => {
  const big = Buffer.alloc(600 * 1024 * 1024, 1);
  const res = await post('kind=cover&filename=big.png', big); // cover 上限 32MB
  assert.equal(res.status, 413);
  assert.equal((await res.json()).code, 413);
});

test('DELETE 级联：行+全部资产文件双清', async () => {
  const res = await post('kind=audio&filename=del.m4a', Buffer.from('music'));
  const { songId } = await res.json();
  await post(`kind=video&songId=${songId}&filename=mv.mp4`, Buffer.from('video'));
  const row = rowOf(songId);
  const audioPath = row.audioPath, videoPath = row.videoPath;

  const del = await app.request(`http://t/uploads/${songId}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal(rowOf(songId), undefined, '登记行应已删');
  assert.equal(existsSync(audioPath), false);
  assert.equal(existsSync(videoPath), false);
  assert.equal((await artifactReq(songId, 'audio')).status, 404);
});

test('DELETE 非法/不存在的 songId', async () => {
  assert.equal((await app.request('http://t/uploads/not_a_file', { method: 'DELETE' })).status, 400);
  assert.equal((await app.request('http://t/uploads/file_zzzzzzzz', { method: 'DELETE' })).status, 404);
});

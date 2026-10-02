// /uploads 上传接管端点：octet-stream 流式落盘 → download_tasks 登记（local_uploads
// 伪歌单一曲一行挂 4 类资产列）→ /downloads/songs/:id/file 播放回看 → DELETE 级联。
// DATA_DIR 临时化：DOWNLOAD_BASE_DIR 与 db 都建在其下——真路由真存储，不打桩。
// TRUST_PROXY=1 + 每请求唯一 XFF：uploads 桶 20/min/IP，全文件 ~30 个 POST 共享
// 'local' 桶会顶着上限 flake——独立 IP 各自分桶，限流路径由专门用例单独验
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-uploads-');
process.env.TRUST_PROXY = '1';
const require = createRequire(import.meta.url);

let app, repo, downloadFs, playlistsRepo;
before(() => {
  app = require('../src/server/routes/uploads.js');
  repo = require('../src/server/repositories/downloadTasks.js');
  playlistsRepo = require('../src/server/repositories/playlists.js');
  downloadFs = require('../src/server/services/download-fs.js');
  // file 端点也要拉进来测回看链——它住在 downloads 路由
  const downloads = require('../src/server/routes/downloads.js');
  const { Hono } = require('hono');
  const root = new Hono();
  root.route('/', app);
  root.route('/', downloads);
  app = root;
});

let ipSeq = 0;
const xff = () => ({ 'x-forwarded-for': `10.9.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}` });

const post = (qs, bytes, headers = {}, init = {}) => app.request(`http://t/uploads?${qs}`, {
  method: 'POST',
  headers: { 'content-type': 'application/octet-stream', ...xff(), ...headers },
  body: bytes,
  ...init,
});

const artifactReq = (songId, kind, headers = {}) =>
  app.request(`http://t/downloads/songs/${songId}/file?playlistId=local_uploads&kind=${kind}`, {
    headers: { ...xff(), ...headers },
  });

const rowOf = (songId) => repo.listTasksByPlaylist(1) // local_uploads 懒建必是首个歌单行 id=1
  .find(t => t.songId === songId);

test('音频上传：落盘 + 登记 completed 行 + file 端点可回看', async () => {
  const payload = Buffer.from('ID3 fake audio bytes'.repeat(64));
  const res = await post('kind=audio&filename=我的歌.mp3', payload);
  assert.equal(res.status, 200);
  const body = await res.json();
  const songId = body.data.songId; // {code,data:{songId,...}} 包封
  assert.match(songId, /^file_[0-9a-z]{8,40}$/);

  const row = rowOf(songId);
  assert.equal(row.status, 'completed');
  assert.equal(row.downloadAudio, true); // repo 把列读成 boolean
  assert.ok(row.audioPath.endsWith(`${songId}.mp3`));
  assert.ok(downloadFs.isUnderDownloadDir(row.audioPath));
  assert.ok(existsSync(row.audioPath));
  assert.deepEqual(readFileSync(row.audioPath), payload);

  const back = await artifactReq(songId, 'audio');
  assert.equal(back.status, 200);
  assert.equal(back.headers.get('content-type'), 'audio/mpeg');
  assert.deepEqual(Buffer.from(await back.arrayBuffer()), payload);
});

test('客户端预生成 songId 被采用（create 回滚窗口需要）', async () => {
  const cid = `file_t${Date.now().toString(36)}abc`;
  const res = await post(`kind=audio&songId=${cid}&filename=x.mp3`, Buffer.from('zz'));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).data.songId, cid);
  assert.equal(rowOf(cid)?.songId, cid);
});

test('Range 请求矩阵：206 / 后缀段 / 416 / 畸形 400', async () => {
  const payload = Buffer.alloc(4096, 7);
  const res = await post('kind=audio&filename=r.flac', payload);
  const { songId } = (await res.json()).data;

  const back = await artifactReq(songId, 'audio', { range: 'bytes=100-199' });
  assert.equal(back.status, 206);
  assert.equal(back.headers.get('content-range'), 'bytes 100-199/4096');
  assert.equal((await back.arrayBuffer()).byteLength, 100);

  const suffix = await artifactReq(songId, 'audio', { range: 'bytes=-50' });
  assert.equal(suffix.status, 206);
  assert.equal(suffix.headers.get('content-range'), 'bytes 4046-4095/4096');

  const oor = await artifactReq(songId, 'audio', { range: 'bytes=99999-' });
  assert.equal(oor.status, 416);
  assert.equal(oor.headers.get('content-range'), 'bytes */4096');

  for (const bad of ['bytes=0-1,3-5', 'bytes=-', 'bytes=5-3']) {
    const r = await artifactReq(songId, 'audio', { range: bad });
    assert.ok(r.status === 400 || r.status === 416, `${bad} 应拒（400/416），实得 ${r.status}`);
  }
});

test('If-None-Match 条件请求：单值/多值/* 都 304', async () => {
  const res = await post('kind=audio&filename=c.flac', Buffer.from('cache'));
  const { songId } = (await res.json()).data;
  const etag = (await artifactReq(songId, 'audio')).headers.get('etag');
  assert.ok(etag);

  for (const inm of [etag, `W/"x-y", ${etag}`, '*']) {
    const r = await artifactReq(songId, 'audio', { 'if-none-match': inm });
    assert.equal(r.status, 304, `INM=${inm} 应 304`);
  }
  const miss = await artifactReq(songId, 'audio', { 'if-none-match': 'W/"1-2"' });
  assert.equal(miss.status, 200);
});

test('同 songId 换源换扩展名：旧文件被清、登记行指新路径、曲名刷新', async () => {
  const res1 = await post('kind=audio&filename=v1.mp3', Buffer.from('aaa'));
  const { songId } = (await res1.json()).data;
  const oldPath = rowOf(songId).audioPath;

  const res2 = await post(`kind=audio&songId=${songId}&filename=v2.flac`, Buffer.from('bbbbb'));
  assert.equal(res2.status, 200);
  const row = rowOf(songId);
  assert.ok(row.audioPath.endsWith('.flac'));
  assert.equal(row.songName, 'v2'); // 媒体换源刷新显示名
  assert.equal(existsSync(oldPath), false, '旧 mp3 应被清掉（换扩展名不留孤儿）');
  assert.equal(readFileSync(row.audioPath).toString(), 'bbbbb');
});

test('一曲多 kind：挂同一行不同列 + 后传 kind 置 download_* 就位标记', async () => {
  const res = await post('kind=lyrics&filename=first.lrc', Buffer.from('[00:01.00]先传词'));
  const { songId } = (await res.json()).data;
  let row = rowOf(songId);
  assert.equal(row.downloadAudio, false, 'audio 未传不该置 flag');
  assert.equal(row.downloadLyrics, true);

  await post(`kind=cover&songId=${songId}&filename=art.png`, Buffer.from('PNG89'));
  await post(`kind=audio&songId=${songId}&filename=song.ogg`, Buffer.from('ogg'));
  row = rowOf(songId);
  assert.equal(row.downloadAudio, true, '补传音频要置 download_audio=1（flag 门）');
  assert.equal(row.downloadCover, true);
  assert.ok(row.coverPath.endsWith('.png'));
  // 封面文件名不得覆盖媒体显示名/originalName
  assert.equal(row.songName, 'song');

  const cov = await artifactReq(songId, 'cover');
  assert.equal(cov.headers.get('content-type'), 'image/png');
  const lrc = await artifactReq(songId, 'lyrics');
  assert.equal(await lrc.text(), '[00:01.00]先传词');
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

test('写盘窗口内登记行被并发删除：409 + 新文件回收不留孤儿', async () => {
  // 先建行
  const res1 = await post('kind=audio&filename=first.mp3', Buffer.from('v1'));
  const { songId } = (await res1.json()).data;
  const row = rowOf(songId);
  const doomedPath = row.audioPath.replace(/\.mp3$/, '.flac'); // 第二次传 flac 的新路径

  // 换源流：pull 时把登记行删掉（模拟窗口内 DELETE /uploads/:id）
  let pulled = false;
  const killer = new ReadableStream({
    async pull(ctrl) {
      if (!pulled) {
        pulled = true;
        repo.deleteTask(row.id);
      }
      ctrl.enqueue(Buffer.from('newbytes'));
      ctrl.close();
    }
  });
  const r2 = await post(`kind=audio&songId=${songId}&filename=v2.flac`, killer, {}, { duplex: 'half' });
  assert.equal(r2.status, 409, '登记行消失应 409 而非假 200');
  assert.equal(existsSync(doomedPath), false, '新文件应被回收——uploads/ 无收割者');
});

test('video-only 曲目：kind=audio 回落 videoPath（浏览器抽 mp4 音轨）', async () => {
  const res = await post('kind=video&filename=only.mp4', Buffer.from('VIDEOBYTES'));
  const { songId } = (await res.json()).data;
  const back = await artifactReq(songId, 'audio');
  assert.equal(back.status, 200);
  assert.deepEqual(Buffer.from(await back.arrayBuffer()), Buffer.from('VIDEOBYTES'));
});

test('换源后 If-Range 旧 ETag 失配 → 200 全量（不混新旧字节）', async () => {
  const res1 = await post('kind=audio&filename=v1.mp3', Buffer.from('AAA'));
  const { songId } = (await res1.json()).data;
  const etag1 = (await artifactReq(songId, 'audio')).headers.get('etag');
  assert.ok(etag1);
  await post(`kind=audio&songId=${songId}&filename=v2.mp3`, Buffer.from('BBBBBB'));

  const stale = await artifactReq(songId, 'audio', { range: 'bytes=0-1', 'if-range': etag1 });
  assert.equal(stale.status, 200, 'ETag 变了 If-Range 失效，应回全量');

  const etag2 = (await artifactReq(songId, 'audio')).headers.get('etag');
  const fresh = await artifactReq(songId, 'audio', { range: 'bytes=0-1', 'if-range': etag2 });
  assert.equal(fresh.status, 206, 'ETag 匹配正常走 Range');
});

test('?download= 触发附件语义 + 真实扩展名', async () => {
  const res = await post('kind=audio&filename=dl.flac', Buffer.from('flacbytes'));
  const { songId } = (await res.json()).data;
  const r = await app.request(
    `http://t/downloads/songs/${songId}/file?playlistId=local_uploads&kind=audio&download=${encodeURIComponent('艺人 - 歌名')}`,
    { headers: xff() }
  );
  assert.equal(r.status, 200);
  const cd = r.headers.get('content-disposition');
  assert.match(cd, /^attachment;/);
  assert.match(cd, /\.flac"*$|\.flac$/m); // filename* 尾部带真实扩展名
  assert.match(cd, /filename\*=UTF-8''/);
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

  // 无 content-length 的流式 body（duplex half 不会带声明长）——
  // 流中累计字节闸兜住：>32MB 即 413，且 .part 残片自收
  const huge = new ReadableStream({
    start(ctrl) {
      for (let i = 0; i < 40; i++) ctrl.enqueue(Buffer.alloc(1024 * 1024, 2));
      ctrl.close();
    }
  });
  const res2 = await post('kind=cover&filename=huge.png', huge, {}, { duplex: 'half' });
  assert.equal(res2.status, 413);
  // .part 残片自收：cover 目录下不得留任何 .part
  const uploadsCoverDir = join(downloadFs.DOWNLOAD_BASE_DIR, 'uploads', 'cover');
  const leftovers = existsSync(uploadsCoverDir)
    ? readdirSync(uploadsCoverDir).filter(f => f.endsWith('.part'))
    : [];
  assert.deepEqual(leftovers, [], '.part 残片应自收');
});

test('DELETE 级联：行+全部资产文件双清', async () => {
  const res = await post('kind=audio&filename=del.m4a', Buffer.from('music'));
  const { songId } = (await res.json()).data;
  await post(`kind=video&songId=${songId}&filename=mv.mp4`, Buffer.from('video'));
  const row = rowOf(songId);
  const audioPath = row.audioPath, videoPath = row.videoPath;

  const del = await app.request(`http://t/uploads/${songId}`, { method: 'DELETE', headers: xff() });
  assert.equal(del.status, 200);
  assert.equal(rowOf(songId), undefined, '登记行应已删');
  assert.equal(existsSync(audioPath), false);
  assert.equal(existsSync(videoPath), false);
  assert.equal((await artifactReq(songId, 'audio')).status, 404);
});

test('DELETE /downloads/playlists/local_uploads/files 被拦——伪歌单不可批量清空', async () => {
  const res = await post('kind=audio&filename=keep.mp3', Buffer.from('keepme'));
  const { songId } = (await res.json()).data;
  const keepPath = rowOf(songId).audioPath;

  const del = await app.request('http://t/downloads/playlists/local_uploads/files', {
    method: 'DELETE', headers: xff(),
  });
  assert.equal(del.status, 400, '批量清空伪歌单必须被拦');
  assert.ok(existsSync(keepPath), '资产文件应仍在');
  assert.ok(rowOf(songId), '登记行应仍在');
});

test('DELETE 非法/不存在的 songId', async () => {
  assert.equal((await app.request('http://t/uploads/not_a_file', { method: 'DELETE', headers: xff() })).status, 400);
  assert.equal((await app.request('http://t/uploads/file_zzzzzzzz', { method: 'DELETE', headers: xff() })).status, 404);
});

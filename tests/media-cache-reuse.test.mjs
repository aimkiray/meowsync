// file-downloader 的媒体缓存复用：盘上完整档（media-cache 键与 /stream
// mint 侧同构）命中时 downloadAudio/downloadVideo 不重解、不拉流，直接
// copyFile 产出工件；miss 时照走原解析链。lib/youtube、lib/bilibili 的
// 解析入口全桩成必炸——命中路径若真去打上游立刻被抓。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { seed, tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-cache-reuse-');
const require = createRequire(import.meta.url);

const realYt = require('../src/server/lib/youtube.js');
const realBv = require('../src/server/lib/bilibili.js');
const BOMB = (tag) => async () => { throw new Error(`${tag}-must-not-be-called`); };
// biliCachePagePart 反解 cid→page 用——桩 view 数据按用例覆写
let biliView = { cid: 111, pages: [{ cid: 111, page: 1 }, { cid: 222, page: 2 }] };
seed('../src/server/lib/youtube.js', {
  ...realYt,
  fetchPlayer: BOMB('ytFetchPlayer'),
  fetchPlayerWith: BOMB('ytFetchPlayerWith'),
});
seed('../src/server/lib/bilibili.js', {
  ...realBv,
  resolveBiliAudio: BOMB('resolveBiliAudio'),
  resolveBiliMedia: BOMB('resolveBiliMedia'),
  biliFetch: async () => biliView,
});

let mc, fd;
before(() => {
  mc = require('../src/server/services/media-cache.js');
  fd = require('../src/server/services/file-downloader.js');
});
after(() => { rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

// 预置完整缓存档（与播放链 beginCapture→close 的产物同形）
const seedEntry = (key, bytes, { contentType = 'audio/mp4', ...extra } = {}) => {
  mkdirSync(mc.CACHE_DIR, { recursive: true });
  writeFileSync(join(mc.CACHE_DIR, `${key}.bin`), bytes);
  const now = Date.now();
  writeFileSync(join(mc.CACHE_DIR, `${key}.json`), JSON.stringify({
    key, contentType, size: bytes.length, ranges: [[0, bytes.length - 1]],
    complete: true, createdAt: now, updatedAt: now, lastAccessAt: now,
    ...extra,
  }));
};

const outPath = (name) => join(process.env.DATA_DIR, 'dl', name);

test('下载复用：yt_ 音频命中完整档——不解析不拉流直出 .m4a 工件', async () => {
  const key = 'yt_ABCDEFGHIJK_a_mp4a.40.2_131072';
  seedEntry(key, Buffer.from('cached-audio-bytes'), { br: 131072 });
  // 128k 目标的 80% 门槛=102400——缓存 131k 过线即复用
  const r = await fd.downloadAudio('yt_ABCDEFGHIJK', outPath('a1.mp3'), 128000, null, null, null);
  assert.equal(r.fromCache, true);
  assert.equal(r.url, 'media-cache');
  assert.equal(r.size, 18);
  assert.ok(r.path.endsWith('.m4a'), `audio/mp4 → m4a，实际 ${r.path}`);
  assert.equal(readFileSync(r.path, 'utf8'), 'cached-audio-bytes');
});

test('下载复用：bv_ 分P音频命中——键前缀含 page 定位', async () => {
  // 260k 档对 320k 目标：低于目标但 ≥80% 底线（256k）——仍复用
  const key = 'bv_BV1xx411c7mD_p2_a_mp4a.40.5_260000';
  seedEntry(key, Buffer.from('bv-audio'), { contentType: 'audio/mp4', br: 260000 });
  const r = await fd.downloadAudio('bv_BV1xx411c7mD_p2', outPath('a2.mp3'), 320000, null, null, {
    bilibili: { bvid: 'BV1xx411c7mD', page: 2 },
  });
  assert.equal(r.fromCache, true);
  assert.equal(r.br, 260000);
  assert.ok(r.path.endsWith('.m4a'));
});

test('下载复用：webm 音频档按 meta.contentType 落 .webm', async () => {
  const key = 'yt_WEBMVIDEO01_a_opus_140000';
  seedEntry(key, Buffer.from('webm-bytes'), { contentType: 'audio/webm', br: 140000 });
  const r = await fd.downloadAudio('yt_WEBMVIDEO01', outPath('a3.mp3'), 128000, null, null, null);
  assert.equal(r.fromCache, true);
  assert.ok(r.path.endsWith('.webm'), `audio/webm → webm，实际 ${r.path}`);
});

test('下载复用：muxed 视频档直出最终 mp4（不解码不合流）', async () => {
  const key = 'yt_MUXEDVIDEO0_v_video-mp4_x';
  seedEntry(key, Buffer.from('muxed-mp4-bytes'), { contentType: 'video/mp4', muxed: true, br: null });
  const r = await fd.downloadVideo('yt_MUXEDVIDEO0', outPath('v1.mp4'), null, null, null);
  assert.equal(r.url, 'media-cache');
  assert.equal(r.videoMeta.source, 'media-cache');
  assert.equal(readFileSync(r.path, 'utf8'), 'muxed-mp4-bytes');
  assert.ok(r.path.endsWith('.mp4'));
});

test('miss 语义：盘上无档照常进解析链（桩炸即证走到了 resolve）', async () => {
  await assert.rejects(
    fd.downloadAudio('yt_MISSVIDEO01', outPath('a9.mp3'), 320000, null, null, null),
    /must-not-be-called/,
    'miss 必须回落真实解析'
  );
});

test('下载复用：低于 80% 码率底线的档不复用——prefer=best 不被低码档截胡', async () => {
  // 播放链缓存的常规 131k AAC 对 320k 目标（门槛 256k）不达标——走真下载
  seedEntry('yt_LOWBITRATE0_a_mp4a.40.2_131072', Buffer.from('low'), { br: 131072 });
  await assert.rejects(
    fd.downloadAudio('yt_LOWBITRATE0', outPath('a10.mp3'), 320000, null, null, null),
    /must-not-be-called/,
    '低码档不该命中，应回落真解析链'
  );
});

test('下载复用：br 缺失档（_x 指纹）不在复用面', async () => {
  seedEntry('yt_NOBRVIDEO01_a_audio_mp4_x', Buffer.from('x'), { contentType: 'audio/mp4' });
  await assert.rejects(
    fd.downloadAudio('yt_NOBRVIDEO01', outPath('a11.mp3'), 320000, null, null, null),
    /must-not-be-called/,
    'br 缺失档不该命中，应回落真解析链'
  );
});

test('下载复用：bv_ 显式 cid 在位——键的 page 成分跟 cid 反解的真实分P 走', async () => {
  // providerData 快照 page=1 但 cid=222 属 P2——内容与键都应按 P2 计
  seedEntry('bv_BV1xx411c7mD_p2_a_mp4a.40.5_260000', Buffer.from('p2-bytes'), { br: 260000 });
  biliView = { cid: 111, pages: [{ cid: 111, page: 1 }, { cid: 222, page: 2 }] };
  const r = await fd.downloadAudio('bv_BV1xx411c7mD', outPath('a12.mp3'), 320000, null, null, {
    bilibili: { bvid: 'BV1xx411c7mD', cid: '222', page: 1 },
  });
  assert.equal(r.fromCache, true, 'cid→P2 反解成功应命中 p2 键');
  assert.equal(readFileSync(r.path, 'utf8'), 'p2-bytes');
});

test('下载复用：cid 反解不出——用 c<cid> 键段绝不错位命中 p1 档', async () => {
  // p1 档在盘，请求带 view 里查无的 cid=999——键段 c999 不合并也不吃错档
  seedEntry('bv_BV1xx411c7mD_p1_a_mp4a.40.5_260000', Buffer.from('p1-bytes'), { br: 260000 });
  biliView = { cid: 111, pages: [{ cid: 111, page: 1 }, { cid: 222, page: 2 }] };
  await assert.rejects(
    fd.downloadAudio('bv_BV1xx411c7mD', outPath('a13.mp3'), 320000, null, null, {
      bilibili: { bvid: 'BV1xx411c7mD', cid: '999', page: 1 },
    }),
    /must-not-be-called/,
    'c999 键段不该命中 p1 档——宁可不合并绝不错位'
  );
});

test('下载复用：搬运失败清 .part——最终路径被占成目录时 rename 必败', async () => {
  seedEntry('yt_PARTVIDEO01_a_mp4a.40.2_400000', Buffer.from('part-bytes'), { br: 400000 });
  // 最终落盘位被目录占位——renameSync(part→dir) 确定性 ENOTEMPTY/EISDIR
  const dl = join(process.env.DATA_DIR, 'dl');
  mkdirSync(dl, { recursive: true });
  mkdirSync(join(dl, 'a14.m4a'));
  await assert.rejects(
    fd.downloadAudio('yt_PARTVIDEO01', outPath('a14.mp3'), 320000, null, null, null),
    /下载音频失败/
  );
  assert.equal(existsSync(join(dl, 'a14.m4a.part')), false, '失败不得留 .part 残片');
});

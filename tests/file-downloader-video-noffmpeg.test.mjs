// file-downloader 视频腿「无 ffmpeg」形态钉板。
// 通过 seed child_process 让模块顶层 spawnSync('ffmpeg -version') 探测
// 失败 → FFMPEG_OK=false（真 spawn 保留在桩里，进程面零影响——仅仅是
// 探测命令回报非零）。!FFMPEG_OK 下自适应相位整体跳过，分支判据变成
// `!FFMPEG_OK && (bvM || progressiveCarry.length)` 的三态：
//   - yt carry 空：放行二轮——常规链批是 formats 兜底表唯一来源
//   - yt 两轮皆空：fatal「未提供合流格式且未检测到 ffmpeg」而非空转
//   - carry 非空：一轮即 break，不白打二跳
//   - bv：thunk 轮轮同料——恒一轮 break（额外钉 resolveBiliMedia 跳数）
// 桩面与 file-downloader-video-resume 同构（fetchStream 桩 + 全真落盘）。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import { seed, tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-dl-vnoff-');
const require = createRequire(import.meta.url);

// ── child_process 探测桩：spawnSync 恒 status:1 → FFMPEG_OK=false。
// 用 node: 前缀拿真身（与 file-downloader 的 'child_process' 解析键不同，
// 不被自家 seed 截回），展开保留真 spawn 等全部其他出口 ──
const realCp = require('node:child_process');
seed('child_process', {
  ...realCp,
  spawnSync: () => ({ status: 1, stdout: null, stderr: null }),
});

// ── 模块顶层 require 面桩（与 vresume 同域，本域不消费）──
seed('../src/server/lib/qq.js', {
  hasQqCookie: () => false,
  BEST_LADDER: ['F000', 'M800', 'M500', 'C400'],
  QUALITY_TIERS: {
    RS01: { ext: 'flac' }, F000: { ext: 'flac' },
    M800: { ext: 'mp3' }, M500: { ext: 'mp3' }, C400: { ext: 'm4a' },
  },
  pickStreamUrl: async () => null,
});
seed('../src/server/services/netease-api.js', {
  callNeteaseApi: async () => ({ body: { data: [] } }),
  resolveSongUrls: async (items) => items,
  resolveTrackUnlock: async () => ({ resolved: null, errors: [] }),
  qqUnlockInfo: (mid) => ({ id: `qq_${mid}` }),
  needsUnlock: () => true,
  MAX_UNLOCK_ITEMS: 20,
  apiModules: {},
  estimateDuration: () => null,
  forgetSongUnlock: () => {},
});
seed('../src/server/services/unlock/index.js', {
  PROVIDERS: {},
  PLAYBACK_SOURCES: ['pyncmd', 'youtube', 'bilibili'],
  DOWNLOAD_SOURCES: ['pyncmd', 'youtube', 'bilibili'],
  QQ_UNLOCK_SOURCES: ['youtube', 'bilibili'],
});

// ── download-io：真身 + 只桩 fetchStream ──
const realIo = require('../src/server/services/download-io.js');
const fetchCalls = [];
let fetchImpl = async () => { throw new Error('unstubbed fetch'); };
seed('../src/server/services/download-io.js', {
  ...realIo,
  fetchStream: (url, o) => { fetchCalls.push([url, o]); return fetchImpl(url, o); },
});

// ── lib/bilibili / lib/youtube 可编程桩 ──
const realBv = require('../src/server/lib/bilibili.js');
let biliMediaImpl = async () => ({ videos: [], audios: [], progressive: async () => [] });
seed('../src/server/lib/bilibili.js', {
  ...realBv,
  resolveBiliAudio: async () => [],
  resolveBiliMedia: async (o) => biliMediaImpl(o),
  biliFetch: async () => ({ pages: [] }),
});
const ytPlayerCalls = [];
let ytPlayerImpl = async () => ({ streamingData: { adaptiveFormats: [], formats: [] } });
let ytVisionosImpl = null;
let ytRegularImpl = null;
const realYt = require('../src/server/lib/youtube.js');
seed('../src/server/lib/youtube.js', {
  ...realYt,
  fetchPlayer: async (videoId) => {
    ytPlayerCalls.push(['player', videoId]);
    return (ytRegularImpl || ytPlayerImpl)(videoId);
  },
  fetchPlayerWith: async (videoId, signal, client) => {
    ytPlayerCalls.push([client, videoId]);
    return ((client === 'VISIONOS' && ytVisionosImpl) || ytPlayerImpl)(videoId);
  },
});

const { downloadVideo } = require('../src/server/services/file-downloader.js');
const outDir = tmpDataDir('meowsync-dl-vnoff-out-');

const YT_TRACK = 'yt_dQw4w9WgXcQ';
const BV_TRACK = 'bv_BV1xx411c7mD';
const okStream = (buf) => Readable.from([buf]);
const resp200 = (total, data) => ({
  status: 200, headers: { 'content-length': String(total) }, data,
});
const progOnly = (url, h = 720) => ({ streamingData: {
  adaptiveFormats: [],
  formats: [{ url, mimeType: 'video/mp4; codecs="avc1.64001F"',
    height: h, width: Math.floor(h * 16 / 9), bitrate: 2000000 }],
} });
// 自适应轨在场但无 ffmpeg 可合流——相位整体跳过，URL 不该被打一次
const adaptiveOnly = (vUrl) => ({ streamingData: {
  adaptiveFormats: [
    { url: vUrl, mimeType: 'video/mp4; codecs="avc1.640028"',
      bitrate: 4000000, itag: 137, height: 720, width: 1280 },
    { url: 'https://x/audio', mimeType: 'audio/mp4', bitrate: 128000, itag: 140 },
  ],
  formats: [],
} });

beforeEach(() => {
  fetchImpl = async () => { throw new Error('unstubbed fetch'); };
  ytPlayerImpl = async () => ({ streamingData: { adaptiveFormats: [], formats: [] } });
  ytVisionosImpl = ytRegularImpl = null;
  biliMediaImpl = async () => ({ videos: [], audios: [], progressive: async () => [] });
  fetchCalls.length = ytPlayerCalls.length = 0;
});

test('无 ffmpeg：yt 首轮 VISIONOS carry 空 → 放行二轮常规链 → 其 formats 合流兜底成', async () => {
  const vUrl = 'https://rrN1---sn-x.googlevideo.com/v?itag=137&batch=visionos';
  const pUrl = 'https://rrN1---sn-x.googlevideo.com/v?itag=22&batch=android';
  // 首轮：自适应轨在场但 formats 空——无 ffmpeg 时该相位整体跳过，
  // carry 空不得 break，必须放二轮去取 formats 兜底表
  ytVisionosImpl = async () => adaptiveOnly(vUrl);
  ytRegularImpl = async () => progOnly(pUrl);
  fetchImpl = async (u) => {
    assert.equal(u, pUrl, '自适应轨 URL 一次不该被打——无 ffmpeg 拉它注定死在合流前');
    return resp200(2048, okStream(Buffer.alloc(2048, 0x61)));
  };
  const dest = join(outDir, 'nf1.mp4');
  const r = await downloadVideo(YT_TRACK, dest, null, null, {});
  assert.deepEqual(ytPlayerCalls.map(c => c[0]), ['VISIONOS', 'player'],
    'carry 空放行二轮——常规链批是 formats 兜底表唯一来源');
  assert.equal(r.videoMeta.source, 'progressive');
  assert.equal(r.size, 2048);
  assert.equal(fetchCalls.length, 1, '自适应轨零死请求——只有合流档被拉');
  assert.deepEqual(readFileSync(dest), Buffer.alloc(2048, 0x61));
});

test('无 ffmpeg：两轮 formats 皆空 → fatal「未提供合流格式且未检测到 ffmpeg」', async () => {
  ytVisionosImpl = async () => adaptiveOnly('https://x/v1');
  ytRegularImpl = async () => ({ streamingData: { adaptiveFormats: [], formats: [] } });
  fetchImpl = async () => { throw new Error('全程不该发起拉流'); };
  const dest = join(outDir, 'nf2.mp4');
  const e = await downloadVideo(YT_TRACK, dest, null, null, {})
    .then(() => null, x => x);
  assert.ok(e);
  assert.match(e.message, /未提供合流格式且未检测到 ffmpeg/);
  assert.equal(e.fatal, true, '语义性 fatal——装 ffmpeg 才能解的形态不空转重试');
  assert.equal(fetchCalls.length, 0, '零拉流');
  assert.deepEqual(ytPlayerCalls.map(c => c[0]), ['VISIONOS', 'player'],
    '两轮解析照跑——carry 空不放行也无处可去');
  assert.ok(!existsSync(dest));
  assert.ok(!existsSync(`${dest}.part`));
});

test('无 ffmpeg：首轮 VISIONOS carry 非空 → 一轮即 break 合流直落', async () => {
  const pUrl = 'https://rrN3---sn-x.googlevideo.com/v?itag=22&batch=visionos';
  ytVisionosImpl = async () => progOnly(pUrl);
  ytRegularImpl = async () => { throw new Error('不该有第二轮解析'); };
  fetchImpl = async (u) => {
    assert.equal(u, pUrl);
    return resp200(1500, okStream(Buffer.alloc(1500, 0x62)));
  };
  const dest = join(outDir, 'nf3.mp4');
  const r = await downloadVideo(YT_TRACK, dest, null, null, {});
  assert.deepEqual(ytPlayerCalls.map(c => c[0]), ['VISIONOS'],
    'carry 在手一轮即收——不白打第二轮解析');
  assert.equal(r.videoMeta.source, 'progressive');
  assert.equal(r.size, 1500);
  assert.equal(fetchCalls.length, 1);
});

test('无 ffmpeg：bv 恒一轮 break——resolveBiliMedia 只打一跳', async () => {
  const pUrl = 'https://upos-sz-m1.bilivideo.com/noff.mp4';
  let mediaCalls = 0;
  biliMediaImpl = async () => {
    mediaCalls++;
    return { videos: [], audios: [],
      progressive: async () => [{ url: pUrl, mimeType: 'video/mp4', br: null, h: 480 }] };
  };
  fetchImpl = async (u) => {
    assert.equal(u, pUrl);
    return resp200(900, okStream(Buffer.alloc(900, 0x64)));
  };
  const dest = join(outDir, 'nf4.mp4');
  const r = await downloadVideo(BV_TRACK, dest, null, null, {});
  assert.equal(mediaCalls, 1, 'bv thunk 轮轮同料——一轮即 break 不白打二跳');
  assert.equal(r.videoMeta.source, 'progressive');
  assert.equal(r.size, 900);
  assert.equal(fetchCalls.length, 1);
  assert.equal(ytPlayerCalls.length, 0, 'bvM 分支——yt 解析链零触达');
});

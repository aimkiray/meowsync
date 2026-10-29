// file-downloader 视频腿 SABR 窗口续拉钉板。
// 闸控实测形态：自适应视频流拒裸全量 GET（上游 403——`bytes=0-` 无界 Range
// 同判）；有界 Range 窗回 206 但每连接放量 ~1-2MB 即断流（ECONNRESET/提前
// EOF）。fetchTo 全量腿失败后转 resumeByRangeWindows：每窗新连接发有界
// `bytes=off-(off+4MiB-1)`，以已落盘 .part 字节续传；连续零进展窗重试
// ≤2 次耗尽才判该 URL 死走既有降档。
// 钉面：
//   - 首窗 206 半截断流 → 次窗按已收字节续传 → 文件字节完整对账
//   - 全量 403 → 自动进续拉 → 成功
//   - 窗内反复 ECONNRESET 零进展 → 重试耗尽抛错（降档语义）→ 全候选判死
//   - signal abort 中途取消 → 立即终止不再发窗
//   - 不回归：全量一次成不触发续拉（fetch 调用数=1）
//   - 兼容面：窗内回 200（服务端无视 Range）丢弃已收前缀后追加收齐
//   - 病态上游：206 报 /3000 后续窗 200 无 CL 短件拉低 total——不产假完成
//   - 负向闸：全量腿非 403 上游 fatal（404）不转续拉（fetch 调用数=1）
//   - 客户端轮次翻转：首轮 VISIONOS 签名批先行（配额自由批——ANDROID 批
//     ~2MB/URL 即焚注定全灭），首批空/瞬断时次轮常规客户端链兜底，其
//     ANDROID 批 formats 填 progressiveCarry 供合流相位
//   - BV 回归：bvM 分支零扰动——yt 解析链一次不触
// 桩面与 file-downloader-ext-manual 同构，但字节通路更「真」：download-io
// 只桩 fetchStream（网络面唯一出口），streamToFile/streamRangeWindow 全真
// ——.part 落盘/对账/rename 整条是真件。lib/youtube 桩 fetchPlayer/With
// 分入口录参可编程（缺省同回落 ytPlayerImpl）；urls 不打真网络。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import { seed, tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-dl-vresume-');
const require = createRequire(import.meta.url);

// ── lib/qq / netease-api / unlock 索引桩：模块顶层 require 面（本域不消费）──
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

// ── download-io：真身全量 + 只桩 fetchStream（续拉字节通路全真）──
const realIo = require('../src/server/services/download-io.js');
const fetchCalls = [];
let fetchImpl = async () => { throw new Error('unstubbed fetch'); };
seed('../src/server/services/download-io.js', {
  ...realIo,
  fetchStream: (url, o) => { fetchCalls.push([url, o]); return fetchImpl(url, o); },
});

// ── lib/bilibili：真身展开，取流函数桩可编程（yt 用例不触达，防误打真
// 网络；resolveBiliMedia 供 BV 回归用例出合流档）──
const realBv = require('../src/server/lib/bilibili.js');
let biliMediaImpl = async () => ({ videos: [], audios: [], progressive: async () => [] });
seed('../src/server/lib/bilibili.js', {
  ...realBv,
  resolveBiliAudio: async () => [],
  resolveBiliMedia: async (o) => biliMediaImpl(o),
  biliFetch: async () => ({ pages: [] }),
});

// ── lib/youtube：fetchPlayer/With 分入口录参可编程，pickStreamList 保真身。
// 轮次翻转后两入口分工不同：VISIONOS 首轮走 fetchPlayerWith、常规链次轮走
// fetchPlayer——ytVisionosImpl/ytRegularImpl 缺省同回落 ytPlayerImpl ──
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
const outDir = tmpDataDir('meowsync-dl-vresume-out-');

const YT_TRACK = 'yt_dQw4w9WgXcQ';
const BV_TRACK = 'bv_BV1xx411c7mD';
const RANGE_WINDOW = 4 * 1024 * 1024; // VIDEO_RANGE_WINDOW（4MiB 窗宽）
const rangeEnd = (off) => off + RANGE_WINDOW - 1;

// progressive-only 夹具：formats 只留 video/mp4 合流档→bestH=0<1080→winners
// 直落 fetchTo（无自适应/无 ffmpeg 依赖）
const progOnly = (url, h = 720) => ({ streamingData: {
  adaptiveFormats: [],
  formats: [{ url, mimeType: 'video/mp4; codecs="avc1.64001F"',
    height: h, width: Math.floor(h * 16 / 9), bitrate: 2000000 }],
} });

// 断流响应体：吐 buf 后以 err 毁流（SABR 每连接限量放量的实测形态）。
// 抛错前留 10ms 事件循环余量——fs.write 走线程池，同 tick 毁流会让未刷
// 缓冲整体丢弃（bytesWritten=0），钉不住「半截字节已落盘」的续传前提
const cutStream = (buf, err) => Readable.from((async function* () {
  if (buf) yield buf;
  await new Promise(r => setTimeout(r, 10));
  throw err;
})());
const okStream = (buf) => Readable.from([buf]);
const resp206 = (start, end, total, data) => ({
  status: 206,
  headers: { 'content-range': `bytes ${start}-${end}/${total}` },
  data,
});
const resp200 = (total, data) => ({
  status: 200, headers: { 'content-length': String(total) }, data,
});
// 上游 403 按真 fetchStream 契约挂 fatal+upstreamStatus
const err403 = () => {
  const e = new Error('上游返回 403');
  e.fatal = true; e.upstreamStatus = 403;
  return e;
};
const errReset = () => {
  const e = new Error('read ECONNRESET');
  e.code = 'ECONNRESET';
  return e;
};
// 非 403 的上游 fatal——resumableVideoError 负向闸判据（换窗同果不放行）
const err404 = () => {
  const e = new Error('上游返回 404');
  e.fatal = true; e.upstreamStatus = 404;
  return e;
};
const rangeStart = (o) => +(/^bytes=(\d+)-/.exec(o.headers.Range) || [])[1];

beforeEach(() => {
  fetchImpl = async () => { throw new Error('unstubbed fetch'); };
  ytPlayerImpl = async () => ({ streamingData: { adaptiveFormats: [], formats: [] } });
  ytVisionosImpl = ytRegularImpl = null;
  biliMediaImpl = async () => ({ videos: [], audios: [], progressive: async () => [] });
  fetchCalls.length = ytPlayerCalls.length = 0;
});

test('断流续拉：全量腿半截断流 → 首窗放 1500B 断 → 次窗按已收字节续传 → 文件字节完整对账', async () => {
  const url = 'https://rr1---sn-x.googlevideo.com/v?itag=137';
  ytPlayerImpl = async () => progOnly(url);
  const tail = Buffer.alloc(1000, 0x42);
  fetchImpl = async (u, o) => {
    if (o.headers.Range === 'bytes=0-') {
      // 全量腿：206 起手放 1500 字节后 ECONNRESET（限量断流形态）
      return { status: 206, headers: { 'content-range': 'bytes 0-2499/2500' },
        data: cutStream(Buffer.alloc(1500, 0x41), errReset()) };
    }
    const off = rangeStart(o);
    if (off === 0) {
      // 首窗：同样只放 1500 字节断流——已收前缀留住，零进展不成立
      return resp206(0, 2499, 2500, cutStream(Buffer.alloc(1500, 0x41), errReset()));
    }
    if (off === 1500) {
      // 次窗续传：Content-Range 起点=已落盘字节
      return resp206(1500, 2499, 2500, okStream(tail));
    }
    throw new Error(`unexpected range ${o.headers.Range}`);
  };
  const dest = join(outDir, 'w1.mp4');
  const r = await downloadVideo(YT_TRACK, dest, null, null, {});
  assert.equal(r.size, 2500);
  assert.equal(r.path, dest);
  assert.deepEqual(readFileSync(dest),
    Buffer.concat([Buffer.alloc(1500, 0x41), tail]),
    '续拉拼接后落盘字节与资源一致');
  assert.equal(fetchCalls.length, 3, '全量一发 + 两窗续拉');
  assert.equal(fetchCalls[1][1].headers.Range, `bytes=0-${rangeEnd(0)}`);
  assert.equal(fetchCalls[2][1].headers.Range, `bytes=1500-${rangeEnd(1500)}`,
    '次窗起点=首窗已落盘字节——按已收偏移续传');
});

test('全量 403 → 自动转窗口续拉 → 一窗收齐', async () => {
  const url = 'https://rr2---sn-x.googlevideo.com/v?itag=22';
  ytPlayerImpl = async () => progOnly(url);
  fetchImpl = async (u, o) => {
    if (o.headers.Range === 'bytes=0-') throw err403(); // 拒全量的闸控形态
    const off = rangeStart(o);
    assert.equal(off, 0, '续拉首窗从 0 起');
    return resp206(0, 1999, 2000, okStream(Buffer.alloc(2000, 0x55)));
  };
  const dest = join(outDir, 'w2.mp4');
  const r = await downloadVideo(YT_TRACK, dest, null, null, {});
  assert.equal(r.size, 2000);
  assert.equal(fetchCalls.length, 2, '403 一发 + 一窗收齐');
  assert.equal(fetchCalls[1][1].headers.Range, `bytes=0-${rangeEnd(0)}`);
  assert.equal(readFileSync(dest).length, 2000);
});

test('续拉窗反复 ECONNRESET 零进展 → 重试耗尽抛错（降档语义）→ 全候选判死', async () => {
  const url = 'https://rr3---sn-x.googlevideo.com/v?itag=22';
  ytPlayerImpl = async () => progOnly(url);
  fetchImpl = async (u, o) => {
    if (o.headers.Range === 'bytes=0-') throw err403();
    throw errReset(); // 每窗零进展断流——3 发（1+2 重试）耗尽判死
  };
  const dest = join(outDir, 'w3.mp4');
  const e = await downloadVideo(YT_TRACK, dest, null, null, {})
    .then(() => null, x => x);
  assert.ok(e, '候选全灭应拒');
  assert.match(e.message, /ECONNRESET/);
  assert.equal(e.fatal, false, '瞬时断流不带 fatal——任务级 ≤3 重试权保留');
  assert.equal(fetchCalls.length, 4, '全量 1 发 + 窗 3 发（重试 ≤2 耗尽）');
  assert.ok(!existsSync(dest));
  assert.ok(!existsSync(`${dest}.part`), '失败候选的 .part 残片清走');
});

test('signal abort：续拉中途取消 → 立即终止不再发窗', async () => {
  const url = 'https://rr4---sn-x.googlevideo.com/v?itag=137';
  ytPlayerImpl = async () => progOnly(url);
  const ac = new AbortController();
  fetchImpl = async (u, o) => {
    if (o.headers.Range === 'bytes=0-') throw errReset();
    // 首窗响应到手即取消：字节仍落盘（已收进展），但总长未达——下一轮
    // 循环顶的 throwIfAborted 必须截住，不许再发新窗
    ac.abort();
    return resp206(0, 999, 2000, okStream(Buffer.alloc(1000, 0x33)));
  };
  const dest = join(outDir, 'w4.mp4');
  const e = await downloadVideo(YT_TRACK, dest, null, ac.signal, {})
    .then(() => null, x => x);
  assert.equal(e?.aborted, true, '取消语义穿透包装不丢');
  assert.equal(fetchCalls.length, 2, 'abort 后零新窗——全量 1 + 首窗 1');
  assert.ok(!existsSync(dest));
  assert.ok(!existsSync(`${dest}.part`));
});

test('不回归：全量 GET 一次成 → 不触发续拉（fetch 调用数=1）', async () => {
  const url = 'https://rr5---sn-x.googlevideo.com/v?itag=22';
  ytPlayerImpl = async () => progOnly(url);
  fetchImpl = async () => resp200(2048, okStream(Buffer.alloc(2048, 0x77)));
  const dest = join(outDir, 'w5.mp4');
  const r = await downloadVideo(YT_TRACK, dest, null, null, {});
  assert.equal(r.size, 2048);
  assert.equal(fetchCalls.length, 1, '全量一次成——续拉零开销');
  assert.equal(fetchCalls[0][1].headers.Range, 'bytes=0-',
    '全量腿照旧带 RANGE_ALL 无界窗（语义同全量）');
  assert.deepEqual(readFileSync(dest), Buffer.alloc(2048, 0x77));
});

test('窗内回 200（服务端无视 Range 回全量）：丢弃已收前缀后追加收齐', async () => {
  const url = 'https://rr6---sn-x.googlevideo.com/v?itag=22';
  ytPlayerImpl = async () => progOnly(url);
  const body = Buffer.concat([Buffer.alloc(1000, 0x41), Buffer.alloc(2000, 0x42)]);
  fetchImpl = async (u, o) => {
    if (o.headers.Range === 'bytes=0-') throw err403();
    const off = rangeStart(o);
    if (off === 0) {
      // 首窗 206 放 1000 字节干净收尾（合法短窗）
      return resp206(0, 999, 3000, okStream(body.subarray(0, 1000)));
    }
    // 次窗无视 Range 回全量 200——续拉丢弃与已收前缀等长的 1000 字节后追加
    return resp200(3000, okStream(body));
  };
  const dest = join(outDir, 'w6.mp4');
  const r = await downloadVideo(YT_TRACK, dest, null, null, {});
  assert.equal(r.size, 3000);
  assert.deepEqual(readFileSync(dest), body,
    '200 兼容路径落盘字节 = 全量资源——前缀丢弃不重影');
  assert.equal(fetchCalls.length, 3);
  assert.equal(fetchCalls[2][1].headers.Range, `bytes=1000-${rangeEnd(1000)}`);
});

test('病态上游拉低 total 不产假完成：W1 206 报 /3000 → 后续窗 200 无 CL 短件 → 零进展耗尽抛错', async () => {
  const url = 'https://rr7---sn-x.googlevideo.com/v?itag=22';
  ytPlayerImpl = async () => progOnly(url);
  const short = Buffer.alloc(1500, 0x66);
  fetchImpl = async (u, o) => {
    if (o.headers.Range === 'bytes=0-') throw err403();
    const off = rangeStart(o);
    if (off === 0) {
      // 首窗合法短窗：206 声明总长 3000——total 学到 3000
      return resp206(0, 999, 3000, okStream(Buffer.alloc(1000, 0x41)));
    }
    // 病态边沿节点：无视 Range 恒回 200 无 content-length 的 1500B 短件
    //（干净 EOF）。win.total=off+written 是弱推断只许上调：off=1000 窗
    // 写 500B（win.total=1500<3000 不许拉低）；off=1500 起 skip 吞掉整
    // body 零落盘→连续零进展窗耗尽判死。旧 `total=win.total` 把总长
    // 缩水成 1500，off(1500)<total(1500) 为假退循环，stats.size===total
    // 对账反成帮凶——1500/3000 截断件被 rename 登记成完成
    return { status: 200, headers: {}, data: okStream(short) };
  };
  const dest = join(outDir, 'w7.mp4');
  const e = await downloadVideo(YT_TRACK, dest, null, null, {})
    .then(() => null, x => x);
  assert.ok(e, '病态上游拉低 total 不得产出假完成');
  assert.match(e.message, /续拉窗口连续无进展/);
  assert.ok(!existsSync(dest), '截断件不得以终名出现');
  assert.ok(!existsSync(`${dest}.part`), '.part 残片已清');
  assert.equal(fetchCalls.length, 6,
    '全量 1 + 窗 5（2 进展窗后 3 连零进展耗尽）');
});

test('全量腿非 403 上游 fatal（404）：负向闸判死——不转续拉零烧窗', async () => {
  const url = 'https://rr8---sn-x.googlevideo.com/v?itag=22';
  ytPlayerImpl = async () => progOnly(url);
  fetchImpl = async () => { throw err404(); };
  const dest = join(outDir, 'w8.mp4');
  const e = await downloadVideo(YT_TRACK, dest, null, null, {})
    .then(() => null, x => x);
  assert.ok(e, '任务级拒绝');
  // downloadVideo 包装层只透传 code/aborted/fatal——钉原错消息与 fatal 位
  assert.match(e.message, /上游返回 404/);
  assert.equal(e.fatal, true, '上游 fatal 穿透包装不丢');
  assert.equal(fetchCalls.length, 1,
    'resumableVideoError 负向闸——不得进续拉烧窗口');
  assert.ok(!existsSync(dest));
  assert.ok(!existsSync(`${dest}.part`));
});

// ── 客户端轮次翻转钉板（ANDROID 批 ~2MB/URL 焚 → VISIONOS 先行）──

test('轮次翻转：首轮 VISIONOS 签名批（formats 恒空）→ 次轮常规链批兜底——其 formats 填合流相位', async () => {
  const vUrl = 'https://rr9---sn-x.googlevideo.com/v?itag=137&batch=visionos';
  const aUrl = 'https://rr9---sn-x.googlevideo.com/v?itag=140&batch=visionos';
  const pUrl = 'https://rr9---sn-x.googlevideo.com/v?itag=22&batch=android';
  // 首轮 VISIONOS 批：自适应视频轨+音轨齐、formats 恒空（实测批形态），
  // 流全部 403 造「首轮批不可用」促二轮（实测 VISIONOS 无墙——这里纯
  // 钉轮次语义，不是复刻配额焚批）
  ytVisionosImpl = async () => ({ streamingData: { adaptiveFormats: [
    { url: vUrl, mimeType: 'video/mp4; codecs="avc1.640028"',
      bitrate: 4000000, itag: 137, height: 720, width: 1280 },
    { url: aUrl, mimeType: 'audio/mp4', bitrate: 128000, itag: 140 },
  ], formats: [] } });
  // 次轮常规链批（ANDROID 档）：formats 带合流——carry 跨轮填它的
  ytRegularImpl = async () => progOnly(pUrl);
  fetchImpl = async (u) => {
    if (u === vUrl || u === aUrl) throw err403();
    if (u === pUrl) return resp200(2048, okStream(Buffer.alloc(2048, 0x61)));
    throw new Error(`unexpected ${u}`);
  };
  const dest = join(outDir, 'r1.mp4');
  const r = await downloadVideo(YT_TRACK, dest, null, null, {});
  assert.deepEqual(ytPlayerCalls.map(c => c[0]), ['VISIONOS', 'player'],
    '首轮 VISIONOS 直解批 → 次轮常规客户端链');
  assert.deepEqual(ytPlayerCalls.map(c => c[1]), ['dQw4w9WgXcQ', 'dQw4w9WgXcQ']);
  assert.equal(r.size, 2048);
  assert.equal(r.videoMeta.source, 'progressive',
    'VISIONOS 批 formats 恒空——次轮 ANDROID 批 formats 填 carry 供合流兜底');
  assert.equal(fetchCalls.at(-1)[0], pUrl);
  assert.equal(readFileSync(dest).length, 2048);
});

test('VISIONOS 首轮解析自身瞬断 → 次轮照常走常规链（名额派发即消费，不重试 VISIONOS）', async () => {
  const pUrl = 'https://rrA---sn-x.googlevideo.com/v?itag=22&batch=android';
  ytVisionosImpl = async () => { throw errReset(); }; // visitor/innertube 瞬断形态
  ytRegularImpl = async () => progOnly(pUrl);
  fetchImpl = async (u) => {
    assert.equal(u, pUrl);
    return resp200(1024, okStream(Buffer.alloc(1024, 0x62)));
  };
  const dest = join(outDir, 'r2.mp4');
  const r = await downloadVideo(YT_TRACK, dest, null, null, {});
  assert.deepEqual(ytPlayerCalls.map(c => c[0]), ['VISIONOS', 'player'],
    'VISIONOS 解析级瞬断——次轮回落常规链（其内链已含 VISIONOS 档）');
  assert.equal(r.size, 1024);
  assert.equal(r.videoMeta.source, 'progressive');
  assert.equal(fetchCalls.length, 1, '瞬断轮零死请求——常规链批合流直落');
});

test('BV 回归：bv_ 走 resolveBiliMedia 合流档直落——yt 解析链零触达', async () => {
  const pUrl = 'https://upos-sz-m1.bilivideo.com/prog.mp4';
  biliMediaImpl = async () => ({ videos: [], audios: [],
    progressive: async () => [{ url: pUrl, mimeType: 'video/mp4', br: null, h: 720 }] });
  fetchImpl = async (u) => {
    assert.equal(u, pUrl);
    return resp200(1500, okStream(Buffer.alloc(1500, 0x63)));
  };
  const dest = join(outDir, 'r3.mp4');
  const r = await downloadVideo(BV_TRACK, dest, null, null, {});
  assert.equal(r.size, 1500);
  assert.equal(r.videoMeta.source, 'progressive');
  assert.equal(ytPlayerCalls.length, 0, 'bvM 分支零扰动——yt 解析链一次不触');
  assert.equal(fetchCalls.length, 1);
});

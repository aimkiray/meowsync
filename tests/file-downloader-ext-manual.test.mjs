// file-downloader 外源曲手动媒体源绑定钉板：qq_/bv_/yt_ 任务自有源腿败亡
// 时，song_unlock_manual 里用户点名的媒体顶替——位序与数值域
// 「官方直解→手动→推导回链」同构：
//   - bv_/yt_：自有源败 → 绑定腿（合成 bvM/ytM/pd 只含绑定媒体——不透传
//     任务行 providerData，cid/bvid 会把取流钉回自有源）→ 成功烙
//     unblockedSource 'manual→<src>' 且 unblocked 恒 false；双腿全灭拼
//     （manual=<err>）终错，双腿同 fatal 才判死
//   - qq_：绑定腿插在词源回链（providerData.neteaseId）之前——显式终审 >
//     导入期词源匹配产物；绑定腿死→回链照走；hit 在场→绑定腿不进、
//     低档升级腿照旧只比 relay（升级腿隔离）
//   - 穿透纪律：abort/errnoToFatal 前置打标的 ENOSPC/EROFS 不触发绑定腿；
//     绑定腿 abort 穿透不拼 combined
//   - 读口收敛：只外源前缀 id 查表（数值 id 的绑定消费在 resolveSongUrls
//     手动步，双查绕过 pyncmd 位序）；脏行（source 枚举外/mediaId 不严形）
//     warn 按无绑走原链
// 桩面同 file-downloader-qq-relay：qq/netease-api 整模块桩、download-io
// 留真身助手只桩字节腿（errnoToFatal/penetratesCandidates 是被测语义
// 一部分）；lib/bilibili 桩 resolveBiliAudio+biliFetch（缓存键 page 反解
// 走它）；lib/youtube 桩 fetchPlayer/With 保 pickStreamList 真身；真库
// unlockManual repo 加 getManual 记账包装（数值支零调用断言面）。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { seed, tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-dl-extmanual-');
const require = createRequire(import.meta.url);

// ── lib/qq 桩：pickStreamUrl 可翻转（同 file-downloader-qq-relay 面）──
let pickImpl = async () => null;
let cookieOn = false;
const pickCalls = [];
seed('../src/server/lib/qq.js', {
  hasQqCookie: () => cookieOn,
  BEST_LADDER: ['F000', 'M800', 'M500', 'C400'],
  QUALITY_TIERS: {
    RS01: { ext: 'flac' }, F000: { ext: 'flac' },
    M800: { ext: 'mp3' }, M500: { ext: 'mp3' }, C400: { ext: 'm4a' },
  },
  pickStreamUrl: async (...a) => { pickCalls.push(a); return pickImpl(...a); },
});

// ── netease-api 桩：回链腿/数值支的 song_url 录参回放 ──
const apiCalls = [];
let callApiImpl = async () => ({ body: { data: [] } });
const resolveCalls = [];
seed('../src/server/services/netease-api.js', {
  callNeteaseApi: (...a) => { apiCalls.push(a); return callApiImpl(...a); },
  resolveSongUrls: async (items, o) => { resolveCalls.push(o); return items; },
  needsUnlock: () => true,
  MAX_UNLOCK_ITEMS: 20,
  apiModules: {},
  estimateDuration: () => null,
  forgetSongUnlock: () => {},
});

// ── download-io：真身助手 + 桩字节腿 ──
const realIo = require('../src/server/services/download-io.js');
const fetchCalls = [];
const streamCalls = [];
let fetchImpl = async (url) => ({ status: 200, data: { destroy() {} }, headers: { 'content-type': 'audio/mp4' }, url });
let streamImpl = async (resp, outputPath) => ({ path: outputPath, size: 4096 });
seed('../src/server/services/download-io.js', {
  ...realIo,
  fetchStream: (url, o) => { fetchCalls.push([url, o]); return fetchImpl(url, o); },
  streamToFile: (resp, outputPath, o) => {
    streamCalls.push([resp, outputPath, o]);
    return streamImpl(resp, outputPath, o);
  },
});

// ── lib/bilibili：resolveBiliAudio 录参可编程；biliFetch 只喂缓存键
// page 反解（带 cid 的自有源腿会 view 一跳——绑定腿合成 pd 无 cid 不打）──
const biliAudioCalls = [];
const biliFetchCalls = [];
let biliAudioImpl = async () => [];
const realBv = require('../src/server/lib/bilibili.js');
seed('../src/server/lib/bilibili.js', {
  ...realBv,
  resolveBiliAudio: async (o) => { biliAudioCalls.push(o); return biliAudioImpl(o); },
  biliFetch: async (p) => { biliFetchCalls.push(p); return { pages: [] }; },
});

// ── lib/youtube：fetchPlayer/With 录参可编程，pickStreamList 保真身
//（adaptiveFormats 夹具驱动候选表——与真实 streamingData 同构）──
const ytPlayerCalls = [];
let ytPlayerImpl = async () => ({ streamingData: { adaptiveFormats: [], formats: [] } });
const realYt = require('../src/server/lib/youtube.js');
seed('../src/server/lib/youtube.js', {
  ...realYt,
  fetchPlayer: async (videoId, signal) => {
    ytPlayerCalls.push(['player', videoId]);
    return ytPlayerImpl(videoId);
  },
  fetchPlayerWith: async (videoId, signal, client) => {
    ytPlayerCalls.push([client, videoId]);
    return ytPlayerImpl(videoId);
  },
});

// ── unlockManual repo：真库 + getManual 记账（数值支零调用/外源支必查
// 断言面）——upsert/delete 直落真表，脏行形态靠直写造出 ──
const realManualRepo = require('../src/server/repositories/unlockManual.js');
const getManualCalls = [];
seed('../src/server/repositories/unlockManual.js', {
  ...realManualRepo,
  getManual: (id) => { getManualCalls.push(String(id)); return realManualRepo.getManual(id); },
});

const { downloadAudio } = require('../src/server/services/file-downloader.js');
const outDir = tmpDataDir('meowsync-dl-extmanual-out-');

// 升级腿胜出换名是真 fs rename——streamToFile 写穿让 relay 档有实体可换
const streamWriteThrough = async (resp, outputPath) => {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `bytes:${resp.url || ''}`);
  return { path: outputPath, size: 4096 };
};
const ytAdaptive = (url, br = 130000) => ({ streamingData: { adaptiveFormats: [
  { url, mimeType: 'audio/mp4', bitrate: br, itag: 140 },
], formats: [] } });
const BVID = 'BV1xx411c7mD';
const BV_TRACK = `bv_${BVID}`;
const YT_TRACK = 'yt_dQw4w9WgXcQ';
const QQ_TRACK = 'qq_0034M8WL3V4oHA';
const BOUND_BVID = 'BV1BOUNDXX12';   // BV1+9位 严形合法
const BOUND_VID = 'BOUNDVID111';     // 11 位严形合法
const bind = (trackId, source, mediaId) => realManualRepo.upsertManual(trackId,
  { source, mediaId, title: '', owner: '', durationSec: null });

beforeEach(() => {
  pickImpl = async () => null;
  cookieOn = false;
  callApiImpl = async () => ({ body: { data: [] } });
  fetchImpl = async (url) => ({ status: 200, data: { destroy() {} }, headers: { 'content-type': 'audio/mp4' }, url });
  streamImpl = async (resp, outputPath) => ({ path: outputPath, size: 4096 });
  biliAudioImpl = async () => [];
  ytPlayerImpl = async () => ({ streamingData: { adaptiveFormats: [], formats: [] } });
  pickCalls.length = apiCalls.length = resolveCalls.length = fetchCalls.length = 0;
  streamCalls.length = biliAudioCalls.length = biliFetchCalls.length = 0;
  ytPlayerCalls.length = getManualCalls.length = 0;
  for (const id of [BV_TRACK, YT_TRACK, QQ_TRACK]) realManualRepo.deleteManual(id);
});

// ── bv_/yt_ 绑定顶替（用例 10/11）──

test('bv_ 自有源死+绑定 bilibili → manual→bilibili；合成 pd 只含绑定媒体（任务行 cid/page 不透传）', async () => {
  bind(BV_TRACK, 'bilibili', BOUND_BVID);
  biliAudioImpl = async (o) => o.bvid === BOUND_BVID
    ? [{ url: 'https://upos-sz-m1.bilivideo.com/bound.m4s', mimeType: 'audio/mp4', br: 192000 }]
    : []; // 自有源「无可下载音轨」——fatal 无 errno 不穿透，恰是绑定要救的形态
  const providerData = { bilibili: { bvid: BVID, cid: '777', page: '2' }, neteaseId: '999001' };
  const r = await downloadAudio(BV_TRACK, join(outDir, 'm1.mp3'), 320000, null, null, providerData);
  assert.equal(r.unblockedSource, 'manual→bilibili', '血缘烙记箭头字面量');
  assert.equal(r.unblocked, false, '绑定顶替不走解锁链——不戴解锁徽章');
  // 合成调参断言：自有源腿吃任务行 pd（cid/page 照常），绑定腿只见绑定
  // 媒体定位——任务行 bilibili.cid/bvid 透传会把取流钉回已死的自有源
  assert.equal(biliAudioCalls.length, 2);
  assert.equal(biliAudioCalls[0].bvid, BVID);
  assert.equal(biliAudioCalls[0].cid, '777', '自有源腿照吃任务行 cid');
  assert.equal(biliAudioCalls[0].page, 2);
  assert.equal(biliAudioCalls[1].bvid, BOUND_BVID);
  assert.equal(biliAudioCalls[1].cid, undefined, '绑定腿不透传任务行 cid');
  assert.equal(biliAudioCalls[1].page, 1, '绑定腿恒 page 1——分 P 绑定不表达');
  assert.equal(fetchCalls.at(-1)[0], 'https://upos-sz-m1.bilivideo.com/bound.m4s');
  // 回链不参与：bv_ 曲的失败只走自有源→绑定两腿（neteaseId 不抢活）
  assert.equal(apiCalls.length, 0);
});

test('跨源双向：yt_ 死+绑 BV → bilibili 管线；bv_ 死+绑 videoId → youtube 管线', async () => {
  // yt_ 绑 BV——绑定媒体解 BV 取流不走 youtube 链
  bind(YT_TRACK, 'bilibili', BOUND_BVID);
  ytPlayerImpl = async () => { const e = new Error('player 410 gone'); e.code = 'ECONNRESET'; throw e; };
  biliAudioImpl = async () => [{ url: 'https://upos-sz-m1.bilivideo.com/x.m4s', mimeType: 'audio/mp4', br: 192000 }];
  let r = await downloadAudio(YT_TRACK, join(outDir, 'x1.mp3'), 320000, null, null,
    { youtube: { videoId: 'dQw4w9WgXcQ' } });
  assert.equal(r.unblockedSource, 'manual→bilibili');
  assert.equal(r.unblocked, false);
  assert.equal(ytPlayerCalls.length, 2, '自有源腿两轮解析都败');
  assert.equal(biliAudioCalls.at(-1).bvid, BOUND_BVID, '绑定腿解绑定 BV');
  // bv_ 绑 videoId——反向跨源同收
  bind(BV_TRACK, 'youtube', BOUND_VID);
  biliAudioImpl = async () => [];
  ytPlayerImpl = async (videoId) => ytAdaptive(`https://rr1---sn-x.googlevideo.com/v?sig=${videoId}`);
  biliAudioCalls.length = 0; ytPlayerCalls.length = 0;
  r = await downloadAudio(BV_TRACK, join(outDir, 'x2.mp3'), 320000, null, null,
    { bilibili: { bvid: BVID } });
  assert.equal(r.unblockedSource, 'manual→youtube');
  assert.equal(r.unblocked, false);
  assert.equal(biliAudioCalls.length, 1, '自有源腿「无可下载音轨」fatal 立即判死');
  assert.equal(ytPlayerCalls.at(-1)[1], BOUND_VID,
    '绑定腿解绑定 videoId——合成 ytM 不拿自有 bvid');
});

// ── qq_ 位序：绑定腿先于词源回链（用例 12）──

test('qq_：绑定腿先于 relayId 回链；绑定腿死→回链照走；双腿全灭终错拼 manual=+netease=', async () => {
  bind(QQ_TRACK, 'youtube', BOUND_VID);
  pickImpl = async () => null; // 自有源「健康空」——code=0 全档 purl 空形态
  ytPlayerImpl = async (v) => ytAdaptive(`https://rr1---sn-x.googlevideo.com/v?sig=${v}`);
  callApiImpl = async (name, args) => ({ body: { data: [
    { id: +args.id, url: 'https://m701.music.126.net/relay.mp3', br: 320000 },
  ] } });
  // 绑定腿成功 → 回链根本不被触达（显式绑定 > 词源推导回链）
  let r = await downloadAudio(QQ_TRACK, join(outDir, 'q1.mp3'), 320000, null, null,
    { neteaseId: '777001', qq: { mediaMid: 'mm9' } });
  assert.equal(r.unblockedSource, 'manual→youtube');
  assert.equal(r.unblocked, false);
  assert.equal(apiCalls.length, 0, '绑定腿成功——词源回链不该被触达');
  assert.equal(ytPlayerCalls.at(-1)[1], BOUND_VID);
  // 绑定腿死（瞬时）→ 回链照走兜底
  ytPlayerImpl = async () => { const e = new Error('yt ECONNRESET'); e.code = 'ECONNRESET'; throw e; };
  apiCalls.length = 0;
  r = await downloadAudio(QQ_TRACK, join(outDir, 'q2.mp3'), 320000, null, null,
    { neteaseId: '777001' });
  assert.equal(r.unblockedSource, 'qq→netease', '绑定腿死——词源回链兜底');
  assert.equal(apiCalls.length, 1, '回链确实尝试过');
  assert.deepEqual(apiCalls[0], ['song_url', { id: '777001', br: 320000 }]);
  // 双腿全灭 → 终错拼 manual= 与 netease= 双死因段（不吞因）
  callApiImpl = async () => { const e = new Error('netease ECONNRESET'); e.code = 'ECONNRESET'; throw e; };
  const e = await downloadAudio(QQ_TRACK, join(outDir, 'q3.mp3'), 320000, null, null,
    { neteaseId: '777001' }).then(() => null, x => x);
  assert.match(e.message, /manual=yt ECONNRESET/, '绑定腿死因拼上终错');
  assert.match(e.message, /netease=netease ECONNRESET/, '回链死因拼上终错');
  assert.equal(e.fatal, false, '两腿皆瞬时——不带 fatal 走 ≤3 重试');
});

test('qq_：pickStreamUrl 抛未标记瞬断 → 原错穿透不进绑定腿（瞬断交任务级重试管）', async () => {
  bind(QQ_TRACK, 'youtube', BOUND_VID);
  pickImpl = async () => { throw new Error('qq musicu vkey.GetVkeyServer code=0/2000'); };
  const e = await downloadAudio(QQ_TRACK, join(outDir, 'q4.mp3'), 320000, null, null,
    { neteaseId: '777001' }).then(() => null, x => x);
  assert.match(e.message, /code=0\/2000/);
  assert.equal(e.qqAnonDenied, undefined);
  assert.equal(ytPlayerCalls.length, 0,
    '非拒答瞬断照旧穿透——不为瞬时毛刺烧绑定解析（与播放侧不对称是刻意的）');
  assert.equal(apiCalls.length, 0, '瞬断也不进回链（既有行为不动）');
});

// ── 穿透纪律（用例 13）──

test('穿透语义：自有源 abort/ENOSPC 判死 → 绑定腿不触；绑定腿 abort → 穿透不拼 combined', async () => {
  bind(BV_TRACK, 'youtube', BOUND_VID);
  // 自有源 abort（标记错）→ 穿透，绑定腿一次不触
  biliAudioImpl = async () => { const e = new Error('aborted'); e.aborted = true; throw e; };
  let e = await downloadAudio(BV_TRACK, join(outDir, 'p1.mp3'), 320000, null, null, {})
    .then(() => null, x => x);
  assert.equal(e.aborted, true);
  assert.equal(ytPlayerCalls.length, 0, 'abort 穿透——绑定腿不触');
  // 自有源 ENOSPC（裸 errno 无 fatal——mkdir 段同款形态）：errnoToFatal
  // 前置打标后才判 penetrates——不打标会漏穿透，换源救不了盘满
  biliAudioImpl = async () => { const err = new Error('ENOSPC: no space'); err.code = 'ENOSPC'; throw err; };
  e = await downloadAudio(BV_TRACK, join(outDir, 'p2.mp3'), 320000, null, null, {})
    .then(() => null, x => x);
  assert.equal(e.fatal, true, 'errnoToFatal 前置——ENOSPC 判死穿透');
  assert.equal(e.code, 'ENOSPC');
  assert.equal(ytPlayerCalls.length, 0, 'fatal errno 穿透——绑定腿不触');
  // 绑定腿 abort → 穿透不兜底、不拼 combined
  biliAudioImpl = async () => [];
  ytPlayerImpl = async (v) => ytAdaptive(`https://rr1---sn-x.googlevideo.com/v?sig=${v}`);
  fetchImpl = async () => { const err = new Error('aborted'); err.aborted = true; throw err; };
  e = await downloadAudio(BV_TRACK, join(outDir, 'p3.mp3'), 320000, null, null, {})
    .then(() => null, x => x);
  assert.equal(e.aborted, true);
  assert.ok(!/manual=/.test(e.message), '绑定腿 abort 穿透——不拼 combined 段');
});

// ── 终错拼装/fatal 合流（用例 14）──

test('fatal 合流：双腿同 fatal→combined.fatal；绑定腿瞬时错→非 fatal 保重试权', async () => {
  bind(BV_TRACK, 'youtube', BOUND_VID);
  biliAudioImpl = async () => [];                     // 自有源 fatalError（fatal 无 errno）
  ytPlayerImpl = async () => ({ streamingData: { adaptiveFormats: [], formats: [] } }); // 绑定腿同 fatal
  let e = await downloadAudio(BV_TRACK, join(outDir, 'f1.mp3'), 320000, null, null, {})
    .then(() => null, x => x);
  assert.equal(e.fatal, true, '双腿全判死——fatal 存活');
  assert.match(e.message, /manual=YouTube 无可下载音轨/, '绑定腿死因拼上终错');
  // 绑定腿瞬时错 → combined 非 fatal（一条腿可重试就不判死）
  ytPlayerImpl = async () => { const err = new Error('player ECONNRESET'); err.code = 'ECONNRESET'; throw err; };
  e = await downloadAudio(BV_TRACK, join(outDir, 'f2.mp3'), 320000, null, null, {})
    .then(() => null, x => x);
  assert.equal(e.fatal, false, '绑定腿瞬时死——不判死保 ≤3 重试权');
  assert.match(e.message, /manual=player ECONNRESET/);
});

// ── 脏行防御 + 读口收敛（用例 15/16）──

test('脏行防御：source 枚举外/mediaId 不严形的行 → warn 按无绑走原链', async () => {
  // upsertManual 直写绕过 POST 严校——模拟手工改库/语义漂移脏行
  realManualRepo.upsertManual(BV_TRACK, { source: 'kugou', mediaId: 'whatever', title: '', owner: '', durationSec: null });
  biliAudioImpl = async () => [];
  let e = await downloadAudio(BV_TRACK, join(outDir, 'd1.mp3'), 320000, null, null, {})
    .then(() => null, x => x);
  assert.match(e.message, /B 站 无可下载音轨/, '脏行按无绑——原自有源错误照报');
  assert.ok(!/manual=/.test(e.message));
  assert.equal(ytPlayerCalls.length, 0);
  // mediaId 严形不过同判（youtube 源配非 11 位 videoId）
  realManualRepo.upsertManual(BV_TRACK, { source: 'youtube', mediaId: 'not-a-vid', title: '', owner: '', durationSec: null });
  e = await downloadAudio(BV_TRACK, join(outDir, 'd2.mp3'), 320000, null, null, {})
    .then(() => null, x => x);
  assert.match(e.message, /B 站 无可下载音轨/);
  assert.equal(ytPlayerCalls.length, 0, 'mediaId 严形不过——不烧绑定解析');
});

test('数值曲不查绑定表：getManual 零调用（绑定消费在 resolveSongUrls 手动步）', async () => {
  callApiImpl = async (name, args) => ({ body: { data: [
    { id: +args.id, url: 'https://m701.music.126.net/x.mp3', br: 320000 },
  ] } });
  await downloadAudio('88', join(outDir, 'n1.mp3'), 320000, null, null, {});
  assert.equal(getManualCalls.filter(id => id === '88').length, 0,
    '数值支读口在 resolveSongUrls——file-downloader 双查会绕过位序');
  // 对照：外源 id 必查一次
  biliAudioImpl = async () => [];
  await downloadAudio(BV_TRACK, join(outDir, 'n2.mp3'), 320000, null, null, {})
    .then(() => null, () => {});
  assert.ok(getManualCalls.includes(BV_TRACK), '外源前缀 id 开绑定读口');
});

// ── 升级腿隔离（用例 17）──

test('升级腿隔离：qq hit 成功低档+绑定在场 → 升级腿照旧只比 relay，绑定腿不进', async () => {
  bind(QQ_TRACK, 'youtube', BOUND_VID);
  pickImpl = async () => ({ url: 'https://stream.qqmusic.qq.com/low.mp3', tier: 'M500' });
  callApiImpl = async (name, args) => ({ body: { data: [
    { id: +args.id, url: 'https://m701.music.126.net/hi.mp3', br: 320000 },
  ] } });
  streamImpl = streamWriteThrough;
  const r = await downloadAudio(QQ_TRACK, join(outDir, 'u1.mp3'), 320000, null, null,
    { neteaseId: '777001' });
  assert.equal(apiCalls.length, 1, '低档 hit + neteaseId → 升级腿照常跑 relay 择优');
  assert.equal(r.unblockedSource, 'qq→netease', '回链更优胜出——绑定腿不抢活');
  assert.equal(ytPlayerCalls.length, 0, 'hit 在场→绑定腿不进');
});

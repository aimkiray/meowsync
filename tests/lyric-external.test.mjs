// 外部滚动词链（services/lyric-external + routes/lyric-external +
// file-downloader 外源相位）钉测：
//   · YTM next→browse 的 timedLyricsData → LRC 转换（乱序归位/空行过滤/
//     unselectable 与无 tab 的确定性无词）
//   · LRCLIB 自筛：instrumental/艺人不符/±15s 时长窗，滚动词优先+差值
//     最近取胜，纯文本形态 synced=false；429 尊重 Retry-After 重试一次
//   · 酷狗候选筛选 + fmt=lrc base64 解码
//   · 级联顺序 ytm→lrclib→kugou、全灭回 null、全源传输故障抛错
//   · 标题变体检索：ver.<歌姬>/cover 标记/尾括弧/Artist - Title/【栏目】头
//     /feat. 尾的剥缀形态在 LRCLIB/酷狗源内串行补位（raw 先、命中即停）
//   · LRCLIB 5xx 抖动单点重试（429 Retry-After 语义不动）
//   · 进程内 LRU：同键命中/负结果缓存都不打穿上游；并发同键单飞
//   · file-downloader：外源曲无 neteaseId 时外源词落盘；网易侧 romalrc
//     作为独立层与译文一同按同刻行落盘
//   · 免时长末轮 gate：常规轮传输故障全灭/durationSec 缺省时末轮不展开
//   · 末轮收成单开放轮 + 同题候选池语境（pool 进判定 prompt、vkey v4
//     盐与无池盲审互不命中）
//   · yt_ 声明：常规轮发起前反解本家声明 {title,author}——choose/verify
//     自首轮起携 declared（同题池判官看得到自署本家轴）；常规轮全灭
//     后原位置声明轮重扫、先于免时长末轮、题同且艺人面无新信息才跳
//     （题同作者异仍起轮）、反解故障/超时静默走原路径
//   · 标题身份闸全轮在位（strictTitle 恒 true）——具名轮 artistHit 子串
//     命中不豁免：'□° ver.EMA'→'ダンス・ダンス・ダダ' 实案钉死
//   · choose 整池单发消歧：无艺人约束轮（开放+末轮）池 ≥1 即发选择题，
//     挑中条补跑词文核验——判否判死不落回、核验故障落回逐候选迭代；
//     明言否决判死、未应答/故障落回逐候选核验；具名轮不注入
//   · deadline 短路：逐候选迭代过期起轮即停不续烧 AI/download；verify
//     闭包过期判否不盲收（choose 挑中条过期补验判死该变体不收录）
//   · LYRIC_PROXY：LRCLIB/酷狗 fetch 带共享 dispatcher，缺省无 dispatcher 键
// globalThis.fetch 按 URL 分发到各源桩——不打真网络；lib/ai 桩控
// aiEnabled/askAiJson（核验路径开/关都要钉）；netease-api 桩供
// file-downloader 网易词相位。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { seed, tmpDataDir, getJson } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-lyrext-');
const require = createRequire(import.meta.url);

// AI 层桩：核验走 lyric-verify.judgeLyricLines → lib/ai.askAiJson
// aiArgs 录制入参——「候选条目身份进 prompt」这类断言要看 user/system 段
let aiOn = false;
let aiAnswer = null;
let aiCalls = 0;
const aiArgs = [];
seed('../src/server/lib/ai.js', {
  aiEnabled: () => aiOn,
  aiModel: () => 'test-model',
  // aiAnswer 可为固定判答或按入参判答的函数——逐候选核验用例要按各候选
  // 的条目身份分别给判（同题异曲在 pool 语境下各归各的判）
  askAiJson: async (args) => {
    aiCalls++; aiArgs.push(args);
    return typeof aiAnswer === 'function' ? aiAnswer(args) : aiAnswer;
  },
});

// file-downloader 的网易云 API 桩：callNeteaseApi('lyric') 回包可控
let neResponse = null;
const neCalls = [];
seed('../src/server/services/netease-api.js', {
  apiModules: { lyric: {} },
  callNeteaseApi: async (name, q) => { neCalls.push({ name, q }); return neResponse; },
  resolveSongUrls: async () => {},
  needsUnlock: () => false,
  MAX_UNLOCK_ITEMS: 20,
});

// 纯文本词补轴桩：file-downloader 的对齐相位走进程内 alignAudioToLrc——
// 桩成可录制/可抛错形态（ffmpeg/LLM 真身在 lyric-align.test.mjs 钉）
let alignImpl = async () => null;
const alignCalls = [];
seed('../src/server/services/lyric-align.js', {
  alignAudioToLrc: async (args) => { alignCalls.push(args); return alignImpl(args); },
});

// lyric-verify 真身先加载再 seed 一层入参录制包装：judgePoolPick/
// judgeLyricLines 的实参形态（declared 声明证据是否透到判定层）靠它
// 钉——委托真实现不改行为语义。须在 lyric-external/file-downloader
// require 前播种：它们 require 时解构绑定这些函数
const realLyricVerify = require('../src/server/services/lyric-verify.js');
const judgePoolArgs = [];
const judgeLineArgs = [];
seed('../src/server/services/lyric-verify.js', {
  ...realLyricVerify,
  judgePoolPick: (a) => { judgePoolArgs.push(a); return realLyricVerify.judgePoolPick(a); },
  judgeLyricLines: (a) => { judgeLineArgs.push(a); return realLyricVerify.judgeLyricLines(a); },
});

const svc = require('../src/server/services/lyric-external.js');
const app = require('../src/server/routes/lyric-external.js');
const fd = require('../src/server/services/file-downloader.js');
const { isYoutubeHost } = require('../src/server/lib/yt-proxy.js');
const lyricProxy = require('../src/server/lib/lyric-proxy.js');
const { ProxyAgent } = require('undici');
const { EXT_LYRIC_ID_RE, EXT_LYRIC_ID_STRICT_RE } = await import('../src/shared/predicates.js');
// 补轴相位的任务行寻址需要真库：任务行 audioPath/durationMs 即上下文源
const downloadTasksRepo = require('../src/server/repositories/downloadTasks.js');
const playlistsRepo = require('../src/server/repositories/playlists.js');
const { DOWNLOAD_BASE_DIR } = require('../src/server/services/download-fs.js');
// 归属核验的 verdict 预置（下载链「判否→外源接一手」用例）与反查 LRU 命中
const lyricAiRepo = require('../src/server/repositories/lyricAi.js');
const { lyricVerdictKey } = require('../src/server/services/lyric-verify.js');
// 本家声明反解可控桩：lyric-external 经模块对象调 lib/youtube 的
// resolveOriginalInfo（真身在并行单元落地中）——钉录制桩让声明轮用例
// 可控（默认 null=无声明，各用例 origInfoImpl 覆写），也隔离真身内部
// 的 fetchPlayer 上行面
const ytLib = require('../src/server/lib/youtube.js');
let origInfoImpl = null;
const origInfoCalls = [];
ytLib.resolveOriginalInfo = async (args) => {
  origInfoCalls.push(args);
  return origInfoImpl ? origInfoImpl(args) : null;
};

// ── fetch 桩：URL 子串分发；calls 记序（级联顺序断言用）──
const calls = [];
let handler = async () => new Response('{}', { status: 404 });
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  calls.push(url);
  return handler(url, init || {});
};
after(() => { globalThis.fetch = realFetch; });
// LYRIC_PROXY 缓存 ProxyAgent 收尾：删 env 再取一次即销毁测试期建的池
// （值变重建语义顺带 destroy 旧池——与 youtube-proxy.test.mjs 同款收尾）
after(() => { delete process.env.LYRIC_PROXY; lyricProxy.lyricDispatcher(); });

const J = (obj, status = 200, headers) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json', ...(headers || {}) },
});
// 桩表值恒给 thunk——同一路径命中两次时每次产新 Response（body 只能消费一次）。
// init 透传给桩：redirect 断言与 abort 感知桩都要摸 fetch init
const dispatch = (table) => async (url, init) => {
  for (const [match, fn] of table) {
    if (url.includes(match)) return fn(url, init);
  }
  return J({ err: 'unhandled' }, 404);
};
const reset = (table) => { calls.length = 0; handler = dispatch(table); svc._clearCache(); };

// ── 罐头回包 ──
const YTM_VID = 'abcdefgh123';  // 11 位
const SONG = `yt_${YTM_VID}`;
const nextOk = (browseId) => J({
  contents: { singleColumn: { tabbedRenderer: { watchNextTabbedResultsRenderer: {
    tabs: [
      { tabRenderer: { title: 'Up next', pageType: 'MUSIC_PAGE_TYPE_QUEUE' } },
      { tabRenderer: { title: 'LYRICS', endpoint: { browseEndpoint: {
        browseId,
        browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: {
          pageType: 'MUSIC_PAGE_TYPE_TRACK_LYRICS' } } } } } },
    ] } } } },
});
const nextUnselectable = () => J({
  contents: { watchNextTabbedResultsRenderer: { tabs: [
    { tabRenderer: { title: 'LYRICS', unselectable: true,
      endpoint: { browseEndpoint: { browseEndpointContextSupportedConfigs: {
        browseEndpointContextMusicConfig: { pageType: 'MUSIC_PAGE_TYPE_TRACK_LYRICS' } } } } } },
  ] } },
});
const nextNoTab = () => J({
  contents: { watchNextTabbedResultsRenderer: { tabs: [
    { tabRenderer: { title: 'Up next', pageType: 'MUSIC_PAGE_TYPE_QUEUE' } } ] } },
});
// timedLyricsData 乱序 + 空行 + 缺 cueRange 行——分别钉排序与过滤
const browseOk = () => J({
  contents: { x: { timedLyricsModel: { lyricsData: { timedLyricsData: [
    { lyricLine: '第二行', cueRange: { startTimeMilliseconds: 12340 } },
    { lyricLine: '第一行', cueRange: { startTimeMilliseconds: 1000 } },
    { lyricLine: '', cueRange: { startTimeMilliseconds: 5000 } },
    { lyricLine: '无时刻', cueRange: {} },
  ] } } } },
});
const kgLrc = '[00:03.00]狗词一\n[00:06.00]狗词二';
const kg = {
  candidates: [
    // 艺人不符（即便 score 高）与超窗（diff 100s）都滤，剩 k3
    { id: 'k1', accesskey: 'ak1', singer: '别人', song: '曲', duration: 200000, score: 99 },
    { id: 'k2', accesskey: 'ak2', singer: '艺人', song: '曲', duration: 300000, score: 90 },
    { id: 'k3', accesskey: 'ak3', singer: '艺人', song: '曲', duration: 208000, score: 50 },
  ],
};
const kgAll = () => J({
  content: Buffer.from(kgLrc).toString('base64'), charset: 'utf8',
});

test('isYoutubeHost 覆盖 music.youtube.com（YTM 词源走 yt_proxy）', () => {
  assert.equal(isYoutubeHost('music.youtube.com'), true);
  assert.equal(isYoutubeHost('music.youtube.com.evil.com'), false);
});

test('EXT_LYRIC_ID_RE：三源词源 id 收，轨道 id 不收', () => {
  for (const s of ['ytm_abcdefgh123', 'lrclib_777', 'kugou_k3']) {
    assert.equal(EXT_LYRIC_ID_RE.test(s), true);
  }
  for (const s of ['yt_abcdefgh123', 'qq_abc12345678', '998877', 'bv_BV1xx411c7mD']) {
    assert.equal(EXT_LYRIC_ID_RE.test(s), false);
  }
  // 严格形连尾段字符集也收脏——进 URL path 的反查入参用它
  assert.equal(EXT_LYRIC_ID_STRICT_RE.test('lrclib_55'), true);
  assert.equal(EXT_LYRIC_ID_STRICT_RE.test('lrclib_../../etc'), false);
  assert.equal(EXT_LYRIC_ID_STRICT_RE.test('ytm_'), false);
});

test('YTM：next→browse 取 timedLyricsData 转 LRC（乱序归位 + 非法行过滤）', async () => {
  reset([
    ['/youtubei/v1/next', () => nextOk('MPLYt_1')],
    ['/youtubei/v1/browse', () => browseOk()],
  ]);
  const res = await svc.fetchExternalLyric({ songId: SONG, title: '曲', artist: '艺人' });
  assert.equal(res.source, 'ytm');
  assert.equal(res.extId, `ytm_${YTM_VID}`);
  assert.equal(res.synced, true);
  assert.equal(res.lrc, '[00:01.00]第一行\n[00:12.34]第二行');
  assert.equal(calls.filter(u => u.includes('/youtubei/v1/next')).length, 1);
  assert.equal(calls.filter(u => u.includes('/youtubei/v1/browse')).length, 1);
});

test('YTM：歌词 tab unselectable → 该源无词，级联落 LRCLIB（不打 browse）', async () => {
  reset([
    ['/youtubei/v1/next', () => nextUnselectable()],
    ['lrclib.net/api/search', () => J([
      { id: 7, trackName: '曲', artistName: '艺人', duration: 200, syncedLyrics: '[00:01.00]L' },
    ])],
    ['lyrics.kugou.com', () => J({})],
  ]);
  const res = await svc.fetchExternalLyric({ songId: SONG, title: '曲', artist: '艺人', durationSec: 200 });
  assert.equal(res.source, 'lrclib');
  assert.equal(res.extId, 'lrclib_7');
  assert.equal(calls.filter(u => u.includes('/browse')).length, 0);
  assert.equal(calls.filter(u => u.includes('kugou')).length, 0);  // LRCLIB 命中短路
});

test('YTM：无歌词 tab → null；级联走到头全源干净 miss → null', async () => {
  reset([
    ['music.youtube.com', () => nextNoTab()],
    ['lrclib.net', () => J([])],
    ['lyrics.kugou.com', () => J({ candidates: [] })],
  ]);
  const res = await svc.fetchExternalLyric({ songId: SONG, title: '曲', artist: '艺人' });
  assert.equal(res, null);
  assert.ok(calls.some(u => u.includes('music.youtube.com')));
  assert.ok(calls.some(u => u.includes('lrclib.net')));
  assert.ok(calls.some(u => u.includes('lyrics.kugou.com')));
});

test('级联顺序 ytm→lrclib→kugou：前两源空时酷狗候选筛选 + base64 LRC', async () => {
  reset([
    ['/youtubei/v1/next', () => nextUnselectable()],
    ['lrclib.net', () => J([])],
    ['lyrics.kugou.com/search', () => J(kg)],
    ['lyrics.kugou.com/download', () => kgAll()],
  ]);
  const res = await svc.fetchExternalLyric({ songId: SONG, title: '曲', artist: '艺人', durationSec: 200 });
  assert.equal(res.source, 'kugou');
  assert.equal(res.extId, 'kugou_k3');       // 艺人不符/超窗的都滤掉
  assert.equal(res.synced, true);
  assert.match(res.lrc, /狗词一/);
  const seq = calls.map(u => u.includes('music.youtube.com') ? 'ytm'
    : u.includes('lrclib') ? 'lrc' : 'kg');
  assert.deepEqual([...new Set(seq)], ['ytm', 'lrc', 'kg']);
});

test('LRCLIB：instrumental/艺人不符/超窗滤掉；滚动词优先 + 时长差最近', async () => {
  reset([['lrclib.net', () => J([
    { id: 1, trackName: '曲', artistName: '艺人', duration: 200, instrumental: true, syncedLyrics: '[00:01.00]器' },
    { id: 2, trackName: '曲', artistName: '不相干歌手', duration: 200, syncedLyrics: '[00:01.00]错人' },
    { id: 3, trackName: '曲', artistName: '艺人', duration: 300, syncedLyrics: '[00:01.00]远' },
    { id: 4, trackName: '曲', artistName: '艺人', duration: 210, plainLyrics: '只纯文本' },
    { id: 5, trackName: '曲', artistName: '艺人', duration: 208, syncedLyrics: '[00:02.00]对', plainLyrics: 'p5' },
    { id: 6, trackName: '曲', artistName: '艺人', duration: 212, syncedLyrics: '[00:02.00]远12' },
  ])]]);
  const res = await svc.lrclibFetch({ title: '曲', artist: '艺人', durationSec: 200 });
  assert.equal(res.extId, 'lrclib_5');       // synced 双候选里 diff 8 < 12
  assert.equal(res.synced, true);
  assert.equal(res.lrc, '[00:02.00]对');
  assert.equal(res.plain, 'p5');             // 两形态并存时纯文本顺带透出
});

test('LRCLIB：只有纯文本 → synced=false，lrc 位放纯文本', async () => {
  reset([['lrclib.net', () => J([
    { id: 9, trackName: '曲', artistName: '艺人', duration: 200, plainLyrics: '纯文本词' },
  ])]]);
  const res = await svc.lrclibFetch({ title: '曲', artist: '艺人', durationSec: 200 });
  assert.equal(res.synced, false);
  assert.equal(res.lrc, '纯文本词');
  assert.equal(res.plain, undefined);
});

test('LRCLIB：429 尊重 Retry-After 重试一次', async () => {
  let hits = 0;
  reset([['lrclib.net', () => {
    hits++;
    return hits === 1 ? J({ error: 'rate limited' }, 429, { 'retry-after': '0.1' })
      : J([{ id: 11, trackName: '曲', artistName: '艺人', duration: 200, syncedLyrics: '[00:01.00]R' }]);
  }]]);
  const res = await svc.lrclibFetch({ title: '曲', artist: '艺人', durationSec: 200 });
  assert.equal(hits, 2);
  assert.equal(res.extId, 'lrclib_11');
});

test('缓存：同键命中不打穿上游；负结果 10min 窗内同样缓存', async () => {
  reset([
    ['/youtubei/v1/next', () => nextOk('MPLYt_c')],
    ['/youtubei/v1/browse', () => browseOk()],
  ]);
  const args = { songId: 'yt_cachevid001', title: '曲', artist: '艺人' };
  const a = await svc.fetchExternalLyric(args);
  assert.equal(a.source, 'ytm');
  const n = calls.length;
  const b = await svc.fetchExternalLyric(args);
  assert.deepEqual(b, a);
  assert.equal(calls.length, n);             // 正结果命中不再发请求
  // 负结果（全源干净 miss）也进缓存——同键重查 10min 内不打穿级联
  reset([
    ['music.youtube.com', () => nextNoTab()],
    ['lrclib.net', () => J([])],
    ['lyrics.kugou.com', () => J({ candidates: [] })],
  ]);
  const nulArgs = { songId: 'qq_negcase12345', title: '空', artist: '无', durationSec: 1 };
  assert.equal(await svc.fetchExternalLyric(nulArgs), null);
  const m = calls.length;
  assert.equal(await svc.fetchExternalLyric(nulArgs), null);
  assert.equal(calls.length, m);
});

test('缓存键含检索词：同 id 先裸查空跑、后带 title 不应吃假阴性', async () => {
  reset([
    ['music.youtube.com', () => nextNoTab()],
    ['lrclib.net', () => J([
      { id: 21, trackName: '曲', artistName: '艺人', duration: 200, syncedLyrics: '[00:01.00]迟到的词' },
    ])],
    ['lyrics.kugou.com', () => J({ candidates: [] })],
  ]);
  const bare = { songId: 'qq_keyshape0001' };              // 无 title/artist
  const full = { ...bare, title: '曲', artist: '艺人', durationSec: 200 };
  assert.equal(await svc.fetchExternalLyric(bare), null);  // 无米下锅 → null 入缓存
  const res = await svc.fetchExternalLyric(full);
  assert.equal(res?.extId, 'lrclib_21');                   // 键不同 → 重新级联命中
});

test('并发同键单飞：两个并发调用共享一次级联', async () => {
  reset([
    ['/youtubei/v1/next', () => nextOk('MPLYt_i')],
    ['/youtubei/v1/browse', () => browseOk()],
  ]);
  const args = { songId: 'yt_iflight0001', title: '曲', artist: '艺人' };
  const [r1, r2] = await Promise.all([svc.fetchExternalLyric(args), svc.fetchExternalLyric(args)]);
  assert.deepEqual(r1, r2);
  assert.equal(calls.length, 2);             // next + browse 各一次
});

test('全源传输故障 → 抛错（不写负缓存，下次仍打上游）', async () => {
  reset([['', () => J({}, 500)]]);
  const args = { songId: 'yt_errvid00001', title: 'x' };
  await assert.rejects(svc.fetchExternalLyric(args), /HTTP 500/);
  const n = calls.length;
  await assert.rejects(svc.fetchExternalLyric(args), /HTTP 500/);
  assert.ok(calls.length > n);               // 故障不固化成负缓存
});

test('级联 deadline 截断：纯没跑完回 null 但不写负缓存', async () => {
  reset([
    ['lrclib.net', () => J([
      { id: 95, trackName: 'x', artistName: 'a', duration: 200, syncedLyrics: '[00:01.00]迟词' },
    ])],
    ['lyrics.kugou.com', () => J({ candidates: [] })],
  ]);
  const args = { songId: 'qq_deadline001', title: 'x', artist: 'a', durationSec: 200 };
  // deadlineMs 注入成已过期：级联首轮启动前即截断——一个上游请求都不发
  assert.equal(await svc.fetchExternalLyric({ ...args, deadlineMs: -1 }), null);
  assert.equal(calls.length, 0);
  // 同键正常重查必须真打级联——若截断 null 被写成 10min 负缓存，这次会
  // 吃缓存静默返回 null
  const res = await svc.fetchExternalLyric(args);
  assert.equal(res?.extId, 'lrclib_95');
});

test('级联 deadline 截断前已有源抛错（混合故障）→ 抛 lastErr 不吞不固化', async () => {
  reset([
    // lrclib 拖 60ms 再炸——30ms 的 deadline 被耗穿时 lastErr 已记
    ['lrclib.net', async () => {
      await new Promise((r) => setTimeout(r, 60));
      throw new Error('lrclib 传输炸');
    }],
    ['lyrics.kugou.com', () => J({ candidates: [] })],
  ]);
  const args = { songId: 'qq_deaderr0001', title: 'x', artist: 'a', deadlineMs: 30 };
  await assert.rejects(svc.fetchExternalLyric(args), /传输炸/);
  const n = calls.length;
  await assert.rejects(svc.fetchExternalLyric(args), /传输炸/);
  assert.ok(calls.length > n);   // 故障不固化成负缓存——重试仍打上游
});

test('调用方 signal 已 abort → 立即拒绝且不打上游', async () => {
  reset([['', () => J({})]]);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    svc.fetchExternalLyric({ songId: 'yt_abort000001', signal: ac.signal }),
    (e) => e.aborted === true);
  assert.equal(calls.length, 0);
});

test('AI 核验：判不符视同无词继续级联；判相符放行', async () => {
  aiOn = true; aiCalls = 0;
  try {
    aiAnswer = { ok: false };
    reset([
      ['/youtubei/v1/next', () => nextOk('MPLYt_ai')],
      ['/youtubei/v1/browse', () => browseOk()],
      ['lrclib.net', () => J([])],
      ['lyrics.kugou.com', () => J({ candidates: [] })],
    ]);
    const res = await svc.fetchExternalLyric({ songId: 'yt_aivideo0001', title: '曲', artist: '艺人' });
    assert.equal(res, null);                 // YTM 词被判错歌 → 整链无词
    assert.ok(aiCalls > 0);
    aiAnswer = { ok: true };
    const res2 = await svc.fetchExternalLyric({ songId: 'yt_aivideo0002', title: '曲', artist: '艺人' });
    assert.equal(res2.source, 'ytm');
  } finally {
    aiOn = false; aiAnswer = null;
  }
});

test('路由：/lyric/external 入参闸、命中形状与全灭 404', async () => {
  assert.equal((await getJson(app, '/lyric/external')).status, 400);          // 无 id 无 title
  assert.equal((await getJson(app, '/lyric/external?id=!!bad!!')).status, 400);
  reset([
    ['/youtubei/v1/next', () => nextOk('MPLYt_r')],
    ['/youtubei/v1/browse', () => browseOk()],
  ]);
  const ok = await getJson(app, `/lyric/external?id=yt_routevid001&title=${encodeURIComponent('曲')}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.code, 200);
  assert.equal(ok.body.source, 'ytm');
  assert.equal(ok.body.extId, 'ytm_routevid001');
  assert.equal(ok.body.synced, true);
  assert.match(ok.body.lrc, /^\[00:01\.00\]/);
  reset([
    ['music.youtube.com', () => nextNoTab()],
    ['lrclib.net', () => J([])],
    ['kugou', () => J({})],
  ]);
  const miss = await getJson(app, `/lyric/external?id=qq_route404abc&title=x`);
  assert.equal(miss.status, 404);
});

// ── file-downloader 歌词相位集成 ──
test('downloadLyrics：网易词相位的 romalrc 与译文按同刻三层落盘', async () => {
  neResponse = {
    body: {
      code: 200,
      lrc: { lyric: '[00:01.00]原词\n[00:05.00]第二句' },
      romalrc: { lyric: '[00:01.00]rōma\n[00:05.00]rōma2' },
      tlyric: { lyric: '[00:01.00]译文\n[00:05.00]译文2' },
    },
  };
  const out = join(process.env.DATA_DIR, 'ne-roma.lrc');
  const r = await fd.downloadLyrics('998877', out, null, null);
  assert.equal(r.path, out);
  assert.equal(readFileSync(out, 'utf-8'),
    '[00:01.00]原词\n[00:01.00]rōma\n[00:01.00]译文\n'
    + '[00:05.00]第二句\n[00:05.00]rōma2\n[00:05.00]译文2');
  assert.equal(neCalls[0].name, 'lyric');
});

test('downloadLyrics：yt_ 无 neteaseId → 外源词落盘；全灭才 NO_LYRICS', async () => {
  reset([
    ['/youtubei/v1/next', () => nextOk('MPLYt_d')],
    ['/youtubei/v1/browse', () => browseOk()],
  ]);
  const out = join(process.env.DATA_DIR, 'yt-ext.lrc');
  const r = await fd.downloadLyrics('yt_dltestvid01', out, null, {
    youtube: { videoId: 'dltestvid01', title: '曲', author: '艺人' },
  });
  assert.equal(r.path, out);
  // 外源产物首部烙 [re:MeowSync <extId>] 词源标记
  assert.equal(readFileSync(out, 'utf-8'),
    '[re:MeowSync ytm_dltestvid01]\n[00:01.00]第一行\n[00:12.34]第二行');
  // 外源相位短路——不打网易云 lyric 端点
  assert.equal(neCalls.filter(c => c.name === 'lyric').length, 1); // 上一条用例的那次
  reset([
    ['music.youtube.com', () => nextNoTab()],
    ['lrclib.net', () => J([])],
    ['lyrics.kugou.com', () => J({ candidates: [] })],
  ]);
  await assert.rejects(
    fd.downloadLyrics('yt_nolyric0001', join(process.env.DATA_DIR, 'no.lrc'), null,
      { youtube: { videoId: 'nolyric0001', title: '空', author: '无' } }),
    (e) => e.code === 'NO_LYRICS');
});

// ── fetchByExtId：词源 id → 词原文反查（ai.js 核验/翻译取词支路）──

test('fetchByExtId：ytm_ 直通重取；lrclib_ 走 /api/get；脏形态/无词归 null', async () => {
  reset([
    ['/youtubei/v1/next', () => nextOk('MPLYt_b')],
    ['/youtubei/v1/browse', () => browseOk()],
  ]);
  const ytm = await svc.fetchByExtId(`ytm_${YTM_VID}`);
  assert.equal(ytm.source, 'ytm');
  assert.equal(ytm.lrc, '[00:01.00]第一行\n[00:12.34]第二行');

  reset([['lrclib.net/api/get/55', () => J({
    id: 55, trackName: '曲', artistName: '艺人',
    syncedLyrics: '[00:01.00]S', plainLyrics: 'P',
  })]]);
  const lb = await svc.fetchByExtId('lrclib_55');
  assert.equal(lb.lrc, '[00:01.00]S');
  assert.equal(lb.plain, 'P');
  assert.equal(lb.synced, true);
  // 无此条目（表外 URL 一律 404）/脏尾段/空尾段都归一成 null
  assert.equal(await svc.fetchByExtId('lrclib_404'), null);
  assert.equal(await svc.fetchByExtId('lrclib_../../x'), null);
  assert.equal(await svc.fetchByExtId('ytm_'), null);
  const beforeKg = calls.length;
  // kugou_ 出缓存无反查通道——回 null 且不打上游
  assert.equal(await svc.fetchByExtId('kugou_never'), null);
  assert.equal(calls.length, beforeKg);
});

test('fetchByExtId：kugou_ 吃进程内级联缓存——命中零上游往返', async () => {
  reset([
    ['music.youtube.com', () => nextNoTab()],
    ['lrclib.net', () => J([])],
    ['lyrics.kugou.com/search', () => J(kg)],
    ['lyrics.kugou.com/download', () => kgAll()],
  ]);
  const viaCascade = await svc.fetchExternalLyric({
    songId: 'yt_kgcache0001', title: '曲', artist: '艺人', durationSec: 200,
  });
  assert.equal(viaCascade.extId, 'kugou_k3');
  const n = calls.length;
  const back = await svc.fetchByExtId('kugou_k3');
  assert.equal(back.extId, 'kugou_k3');
  assert.equal(back.lrc, kgLrc);
  assert.equal(calls.length, n);
});

// ── 下载相位：外源纯文本词 + 盘上音频 → 进程内自动对齐 ──

// 任务行上下文供给器：audioPath 触发补轴与外源时长筛的盘档实测探测
// （bv_/yt_ 行 durationMs 是视频时长不可信——file-downloader 现在用
// ffprobe/ffmpeg 探盘档取真实时长）。audioBytes 可覆写成真 wav 让探针有米
function seedAudioTask(songId, { playlistKey, durationMs, audioBytes } = {}) {
  const pl = playlistsRepo.upsertPlaylist({ neteasePlaylistId: playlistKey, name: 'al' });
  const audio = join(DOWNLOAD_BASE_DIR, `extalign/audio/${songId.replace(/\W/g, '')}.wav`);
  mkdirSync(join(audio, '..'), { recursive: true });
  writeFileSync(audio, audioBytes || Buffer.alloc(2048));
  const t = downloadTasksRepo.createTask({
    playlistId: pl.id, queueId: null, songId, songName: '对齐曲', artist: '艺人',
    durationMs,
  });
  downloadTasksRepo.updateTask(t.id, { audioPath: audio });
  return audio;
}

// 3s 真 wav（8kHz 16bit 单声道）——ffprobe/ffmpeg 探得出 ~3s 时长
function wavOfSec(sec, sampleRate = 8000) {
  const n = sec * sampleRate;
  const data = n * 2;
  const buf = Buffer.alloc(44 + data);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + data, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(data, 40);
  return buf;
}

// 外源时长筛的盘档探测依赖 ffprobe/ffmpeg——两者都不在的环境跳过该段断言
const PROBE_OK = (() => {
  try {
    const { spawnSync } = require('child_process');
    if (spawnSync('ffprobe', ['-hide_banner', '-version'], { stdio: 'ignore' }).status === 0) return true;
    return spawnSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' }).status === 0;
  } catch { return false; }
})();

test('downloadLyrics：纯文本词+盘上音频 → 对齐补轴落盘（盘档实测时长筛掉远候选）', async (t) => {
  if (!PROBE_OK) return t.skip('环境无 ffprobe/ffmpeg——盘档时长探测不可用');
  aiOn = false;
  // 任务行 durationMs 报 200s（视频元数据形态），盘档实测 ~3s——
  // 新行为是探盘档不信行值：duration=190 的候选对行值在窗内、
  // 对实测 3s 远在窗外被滤
  const audio = seedAudioTask('yt_alignext001', {
    playlistKey: 'local_pl_extalign1', durationMs: 200000, audioBytes: wavOfSec(3),
  });
  reset([
    ['/youtubei/v1/next', () => nextUnselectable()],
    ['lrclib.net', () => J([
      { id: 30, trackName: '对齐曲', artistName: '艺人', duration: 190, syncedLyrics: '[00:01.00]远词' },
      { id: 31, trackName: '对齐曲', artistName: '艺人', duration: 4, plainLyrics: '纯文一\n纯文二' },
    ])],
    ['lyrics.kugou.com', () => J({ candidates: [] })],
  ]);
  alignCalls.length = 0;
  alignImpl = async ({ lines }) => ({
    lrc: lines.map((l, i) => `[00:0${i + 1}.00]${l}`).join('\n'),
    alignedBy: 'llm',
  });
  const out = join(process.env.DATA_DIR, 'ext-align.lrc');
  const r = await fd.downloadLyrics('yt_alignext001', out, null, {
    youtube: { videoId: 'alignext001', title: '对齐曲', author: '艺人' },
  });
  assert.equal(r.alignedBy, 'llm');
  // [re:]词源标记 + 补轴产物的 [ve:align-<by>] 一并烙进工件首部
  assert.equal(readFileSync(out, 'utf-8'),
    '[re:MeowSync lrclib_31]\n[ve:align-llm]\n[00:01.00]纯文一\n[00:02.00]纯文二');
  assert.equal(alignCalls.length, 1);
  assert.equal(alignCalls[0].audioPath, audio);
  assert.deepEqual(alignCalls[0].lines, ['纯文一', '纯文二']);
});

test('downloadLyrics：纯文本词但无音频工件 → 不补轴，纯文本照落', async () => {
  aiOn = false;
  reset([
    ['/youtubei/v1/next', () => nextUnselectable()],
    ['lrclib.net', () => J([
      { id: 41, trackName: 'x', artistName: 'y', plainLyrics: '无轴一\n无轴二' },
    ])],
    ['lyrics.kugou.com', () => J({ candidates: [] })],
  ]);
  alignCalls.length = 0;
  const out = join(process.env.DATA_DIR, 'ext-plain.lrc');
  const r = await fd.downloadLyrics('yt_noaudiox001', out, null, {
    youtube: { videoId: 'noaudiox001', title: 'x', author: 'y' },
  });
  assert.equal(r.alignedBy, undefined);
  assert.equal(readFileSync(out, 'utf-8'), '[re:MeowSync lrclib_41]\n无轴一\n无轴二');
  assert.equal(alignCalls.length, 0); // 盘上无档不触发对齐
});

test('downloadLyrics：对齐相位抛错 → 降级落纯文本不炸任务', async () => {
  aiOn = false;
  seedAudioTask('yt_alignerr001', { playlistKey: 'local_pl_extalign2' });
  reset([
    ['/youtubei/v1/next', () => nextUnselectable()],
    ['lrclib.net', () => J([
      { id: 51, trackName: 'e', artistName: 'a', plainLyrics: '降级词一\n降级词二' },
    ])],
    ['lyrics.kugou.com', () => J({ candidates: [] })],
  ]);
  alignCalls.length = 0;
  alignImpl = async () => { throw new Error('ffmpeg 解 PCM 失败'); };
  const out = join(process.env.DATA_DIR, 'ext-degrade.lrc');
  const r = await fd.downloadLyrics('yt_alignerr001', out, null, {
    youtube: { videoId: 'alignerr001', title: 'e', author: 'a' },
  });
  assert.equal(readFileSync(out, 'utf-8'), '[re:MeowSync lrclib_51]\n降级词一\n降级词二');
  assert.equal(alignCalls.length, 1); // 试了对齐但失败降级
});

// ── 级联降轮（UGC 曲 artist 实为 UP 主名）与外源 fetch 防御 ──

test('级联降轮：title 剥出艺人候选——UP 主名严格轮滤净后派生候选命中', async () => {
  const seen = [];
  reset([
    ['lrclib.net/api/search', (url) => { seen.push(decodeURIComponent(url)); return J([
      { id: 88, trackName: '晴天', artistName: '周杰伦', duration: 200, syncedLyrics: '[00:01.00]晴词' },
    ]); }],
    ['lyrics.kugou.com', () => J({ candidates: [] })],
  ]);
  const res = await svc.fetchExternalLyric({
    songId: 'bv_BV1xx411c7mD', title: '周杰伦 - 晴天', artist: '音乐搬运工',
  });
  assert.equal(res.extId, 'lrclib_88');
  // 第一轮 '音乐搬运工' 被 artistHit 滤净——raw 与 'A - B' 剥出的「晴天」
  // 变体同轮都试（两发检索）；第二轮「周杰伦」具名轮也过标题闸：raw
  // 变体 '周杰伦 - 晴天' 归一 ≠ '晴天' 被闸拒，剥缀变体 '晴天' 归一相等
  // 才命中——具名轮检索面比上闸前多一发（raw 变体白打换确定性）
  assert.equal(seen.length, 4);
  assert.ok(seen[0].includes('音乐搬运工'));
  assert.ok(seen[1].includes('音乐搬运工'));
  assert.ok(seen[2].includes('周杰伦') && !seen[2].includes('音乐搬运工'));
  assert.ok(seen[3].includes('晴天') && seen[3].includes('周杰伦'));
});

test('级联降轮：title 剥不出艺人 → artist:\'\' 宽检放行（艺人不约束；候选标题须归一相等——见标题闸用例）', async () => {
  reset([
    ['lrclib.net/api/search', () => J([
      { id: 89, trackName: '无名投稿标题', artistName: '真艺人', duration: 200, syncedLyrics: '[00:02.00]宽检词' },
    ])],
    ['lyrics.kugou.com', () => J({ candidates: [] })],
  ]);
  const res = await svc.fetchExternalLyric({
    songId: 'bv_BV1xx411c7mD', title: '无名投稿标题', artist: 'UP主甲',
  });
  assert.equal(res?.extId, 'lrclib_89');
});

test('级联降轮不波及曲库 id：qq_ 严格轮全灭即 null，不派生不宽检', async () => {
  const seen = [];
  reset([
    ['lrclib.net/api/search', (url) => { seen.push(url); return J([
      { id: 90, trackName: 'x', artistName: '别人', duration: 200, syncedLyrics: '[00:01.00]x' },
    ]); }],
    ['lyrics.kugou.com', () => J({ candidates: [] })],
  ]);
  const res = await svc.fetchExternalLyric({ songId: 'qq_abc12345678', title: 'x', artist: '原艺人' });
  assert.equal(res, null);
  assert.equal(seen.length, 1); // 只打了严格轮
});

// ── 标题变体检索（ver.<歌姬>/cover/尾括弧/前缀剥除）与 LRCLIB 5xx 重试 ──

test('titleVariantsOf：剥缀形态、raw 占首、去重与上限', () => {
  // 真实病例形态：VTuber 翻唱标题的 'ver.<歌姬>' 检索噪声尾
  const v = svc.titleVariantsOf('Dream Play Sick ver.EMA');
  assert.equal(v[0], 'Dream Play Sick ver.EMA');            // raw 永远占首
  assert.ok(v.includes('Dream Play Sick'));
  assert.ok(svc.titleVariantsOf('乐园(粤)').includes('乐园'));
  assert.ok(svc.titleVariantsOf('EMA - Dream Play Sick').includes('Dream Play Sick'));
  assert.ok(svc.titleVariantsOf('【栏目】某曲').includes('某曲'));
  assert.ok(svc.titleVariantsOf('某曲 Covered by X').includes('某曲'));
  assert.ok(svc.titleVariantsOf('某曲 (cover)').includes('某曲'));
  assert.ok(svc.titleVariantsOf('某曲 ／COVER').includes('某曲'));
  assert.ok(svc.titleVariantsOf('Song feat. Guest').includes('Song'));
  // 日文惯写 'ft.歌姫' 点号后无空格也剥；整包围引号壳剥出裸题
  assert.ok(svc.titleVariantsOf('Song ft.初音ミク').includes('Song'));
  assert.ok(svc.titleVariantsOf("'GETCHA!'").includes('GETCHA!'));
  // 词干粘连不误剥残片：'Somewith you' 原样保留不产 'Some'
  assert.deepEqual(svc.titleVariantsOf('Somewith you'), ['Somewith you']);
  assert.deepEqual(svc.titleVariantsOf('晴天'), ['晴天']);     // 无变体 → 仅 raw
  assert.equal(svc.titleVariantsOf('').length, 1);
  // '(cover)' 同是 cover 括弧与尾括弧——两规则产同形去重只剩一份
  const d = svc.titleVariantsOf('某曲(cover)');
  assert.equal(d.filter((x) => x === '某曲').length, 1);
  // 上限 4：多条剥缀规则同产的标题也不超帽
  assert.ok(svc.titleVariantsOf('【栏】A - B (c) feat. D ver.E').length <= 4);
});

test('titleVariantsOf 第二参 artist：歌系中缀/斜杠尾/字幕组/艺人锚与激进变体', () => {
  // 真实未匹配库形态：'を歌いました ／ 演唱者' 复合噪声要双剥才出真名——
  // 单规则各剥一层产不出，激进变体（全规则迭代到不动点）必须能
  assert.ok(svc.titleVariantsOf('ロストアンブレラを歌いました ／ rei sirose', 'rei sirose')
    .includes('ロストアンブレラ'));
  assert.ok(svc.titleVariantsOf('アンノウン・マザーグースを歌いました ／ rei sirose', 'rei sirose')
    .includes('アンノウン・マザーグース'));
  // 艺人锚前缀/尾缀（归一比对）：'EMA 世界寿命'/'EMA rumor' 剥艺人前缀
  assert.ok(svc.titleVariantsOf('EMA rumor', 'EMA').includes('rumor'));
  assert.ok(svc.titleVariantsOf('EMA 世界寿命と最後の一日', 'EMA')
    .includes('世界寿命と最後の一日'));
  // covered by 多人 × 连接不挡路——cover 语后整段剥
  assert.ok(svc.titleVariantsOf('ホワイトリリー covered by 雨森小夜 × 久遠千歳', 'rei sirose')
    .includes('ホワイトリリー'));
  // 斜杠尾：全角 ／ 也剥（尾段 ≤40 字）
  assert.ok(svc.titleVariantsOf('幸福な死を ／ 久遠千歳', '久遠千歳').includes('幸福な死を'));
  // 字幕组尾 + by 尾 + 括弧 + 歌系中缀——激进变体收敛到真名
  assert.ok(svc.titleVariantsOf('雲散霧消を歌いました by ニート(rei sirose) 中文字幕', 'rei sirose')
    .includes('雲散霧消'));
  // 艺人词干粘连不切：'ver.EMA' 尾的 'EMA' 不是独立尾缀；'EMAIL' 不吃 'EMA' 前缀
  assert.ok(!svc.titleVariantsOf('Dream Play Sick ver.EMA', 'EMA')
    .includes('Dream Play Sick ver.'));
  assert.ok(!svc.titleVariantsOf('EMAIL test', 'EMA').includes('IL test'));
  // artist 缺省退化为旧行为——艺人锚规则缺席不炸
  assert.ok(svc.titleVariantsOf('EMA rumor').length >= 1);
});

test('titleVariantsOf：激进变体保底末位槽——单变体占满时真名不被挤出', () => {
  // 复合噪声病例：【栏目】头 + 'A - B' 前缀 + '(cover)' + 斜杠尾艺人——
  // 单规则各剥一层恰好占满 3 个变体席，而真名 'B' 只有激进腿迭代收敛
  // 才出。钉末位元素而非 includes——保底槽语义保证它在 4 项上限内不被
  // 挤掉（旧实现 push 闸丢弃时末位是 '【X】A - B (cover)'）
  const v = svc.titleVariantsOf('【X】A - B (cover) ／ rei sirose', 'rei sirose');
  assert.ok(v.length <= 4);
  assert.equal(v.at(-1), 'B');
});

test('级联标题变体：ver.<名> 尾缀原始形态全灭，剥缀形态在 LRCLIB 命中', async () => {
  const queries = [];
  reset([
    ['/youtubei/v1/next', () => nextUnselectable()],
    ['lrclib.net/api/search', (url) => {
      const q = decodeURIComponent(url);
      queries.push(q);
      // 病例回放：带 'ver.EMA' 的原始形态全灭，剥成 'Dream Play Sick' 才命中
      return q.includes('Dream Play Sick EMA') && !q.includes('ver.')
        ? J([{ id: 25010661, trackName: 'Dream Play Sick', artistName: 'EMA', duration: 234, plainLyrics: 'p1\np2' }])
        : J([]);
    }],
    ['lyrics.kugou.com', () => J({ candidates: [] })],
  ]);
  const res = await svc.fetchExternalLyric({
    songId: 'yt_variantvid1', title: 'Dream Play Sick ver.EMA', artist: 'EMA', durationSec: 234,
  });
  assert.equal(res?.extId, 'lrclib_25010661');
  // 剥缀变体须真实发检索——raw 命中或没打过都不算数
  assert.ok(queries[0].includes('ver.'), 'raw 形态先打');
  assert.ok(queries.some((q) => q.includes('Dream Play Sick EMA') && !q.includes('ver.')));
});

test('LRCLIB：5xx 抖动单点重试——503 后原样重发一次命中', async () => {
  let hits = 0;
  reset([['lrclib.net', () => {
    hits++;
    return hits === 1 ? J({ error: 'upstream flap' }, 503)
      : J([{ id: 66, trackName: '曲', artistName: '艺人', duration: 200, syncedLyrics: '[00:01.00]抖后词' }]);
  }]]);
  const res = await svc.lrclibFetch({ title: '曲', artist: '艺人', durationSec: 200 });
  assert.equal(hits, 2);
  assert.equal(res.extId, 'lrclib_66');
});

test('外源 fetch 全走 redirect:manual——3xx 当源失败不裸 follow', async () => {
  const inits = [];
  reset([
    ['/youtubei/v1/next', (url, init) => {
      inits.push(['ytm', init]);
      return new Response(null, { status: 302, headers: { location: 'https://evil.example/x' } });
    }],
    ['lrclib.net', (url, init) => { inits.push(['lrclib', init]); return J([]); }],
    ['lyrics.kugou.com/search', (url, init) => { inits.push(['kgs', init]); return J(kg); }],
    ['lyrics.kugou.com/download', (url, init) => { inits.push(['kgd', init]); return kgAll(); }],
  ]);
  const res = await svc.fetchExternalLyric({ songId: SONG, title: '曲', artist: '艺人', durationSec: 200 });
  // ytm 的 302 不跟跳（判源失败）→ 级联落酷狗
  assert.equal(res.source, 'kugou');
  assert.equal(inits.length, 4);
  assert.ok(inits.every(([, i]) => i.redirect === 'manual'));
});

test('外源响应体量闸：>2MB 响应判源失败换下一源', async () => {
  const big = 'x'.repeat(3 * 1024 * 1024);
  reset([
    ['/youtubei/v1/next', () => nextUnselectable()],
    ['lrclib.net', () => new Response(big, { status: 200, headers: { 'content-type': 'application/json' } })],
    ['lyrics.kugou.com/search', () => J(kg)],
    ['lyrics.kugou.com/download', () => kgAll()],
  ]);
  const res = await svc.fetchExternalLyric({ songId: SONG, title: '曲', artist: '艺人', durationSec: 200 });
  assert.equal(res.source, 'kugou');
});

test('inflight 单飞：首调用方 abort 后，存活的搭车者自行重跑级联', async () => {
  let nextHits = 0;
  reset([
    // 首个 next 挂起直到 signal 中止——桩对 init.signal 做中止感知（真 fetch 同款）
    ['/youtubei/v1/next', (url, init) => {
      nextHits++;
      if (nextHits !== 1) return nextOk('MPLYt_s');
      return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { aborted: true })), { once: true });
      });
    }],
    ['/youtubei/v1/browse', () => browseOk()],
  ]);
  const ac = new AbortController();
  const args = { songId: 'yt_shareabort1', title: '曲', artist: '艺人' };
  const p1 = svc.fetchExternalLyric({ ...args, signal: ac.signal });
  const p2 = svc.fetchExternalLyric(args); // 搭上同一个 gate
  await new Promise(r => setTimeout(r, 10)); // p1 入挂起点、p2 已挂 gate
  ac.abort();
  await assert.rejects(p1, e => e?.aborted === true);
  const r2 = await p2; // 搭车者不陪绑——自行重跑命中
  assert.equal(r2.source, 'ytm');
  assert.ok(nextHits >= 2, '搭车者重跑应再发一次 next');
});

test('缓存键 durationSec 归一：浮点与整秒同键不劈叉', async () => {
  reset([
    ['/youtubei/v1/next', () => nextOk('MPLYt_dk')],
    ['/youtubei/v1/browse', () => browseOk()],
  ]);
  const a = await svc.fetchExternalLyric({
    songId: 'yt_durkey00001', title: '曲', artist: '艺人', durationSec: 200,
  });
  const n = calls.length;
  const b = await svc.fetchExternalLyric({
    songId: 'yt_durkey00001', title: '曲', artist: '艺人', durationSec: 200.497,
  });
  assert.deepEqual(b, a);
  assert.equal(calls.length, n); // 200.497→200 同键命中不再发请求
});

test('fetchByExtId：kugou_ 入参带空白也吃进程内级联缓存', async () => {
  reset([
    ['music.youtube.com', () => nextNoTab()],
    ['lrclib.net', () => J([])],
    ['lyrics.kugou.com/search', () => J(kg)],
    ['lyrics.kugou.com/download', () => kgAll()],
  ]);
  const viaCascade = await svc.fetchExternalLyric({
    songId: 'yt_kgcache0002', title: '曲', artist: '艺人', durationSec: 200,
  });
  assert.equal(viaCascade.extId, 'kugou_k3');
  const n = calls.length;
  // 未 trim 原串此前比对必漏——trim 后统一比才能吃上 LRU
  const back = await svc.fetchByExtId('  kugou_k3  ');
  assert.equal(back?.extId, 'kugou_k3');
  assert.equal(calls.length, n);
});

// ── S-DL1：网易云嫁接词归属判否 → 外源级联接一手 ──

test('downloadLyrics：网易嫁接词判否 → 外源级联命中即落盘', async () => {
  aiOn = false;
  // 括弧形态【官方MV】走 cleanQueryTitle 剥除——标题身份闸现全轮在位，
  // 具名轮也要求候选标题与某检索变体剥缀归一精确等；裸 ' 官方MV' 尾不在
  // 剥缀面内（候选 '晴天' 会被闸拒），括弧形态才能剥出 '晴天' 变体
  const providerData = {
    bilibili: { bvid: 'BV1xx411c7mD', title: '周杰伦 - 晴天【官方MV】', author: '音乐搬运工' },
    neteaseId: '88001',
  };
  // 预置网易云词源的判否 verdict——已落库判定不随 aiEnabled 旁路
  lyricAiRepo.upsertVerdict(
    lyricVerdictKey('88001', providerData.bilibili.title, providerData.bilibili.author),
    'lyric', false, 'test');
  neResponse = { body: { code: 200, lrc: { lyric: '[00:01.00]错配词' } } };
  reset([
    ['lrclib.net', () => J([
      { id: 77, trackName: '晴天', artistName: '周杰伦', duration: 200, syncedLyrics: '[00:01.00]外源对词' },
    ])],
    ['lyrics.kugou.com', () => J({ candidates: [] })],
  ]);
  const out = join(process.env.DATA_DIR, 'graft-ext.lrc');
  await fd.downloadLyrics('bv_BV1xx411c7mD', out, null, providerData);
  // 判否后外源接一手：title 剥出的「周杰伦」候选轮命中（UP 主严格轮滤净），
  // 落盘的是外源词而非错配的网易词，也不是 NO_LYRICS
  assert.equal(readFileSync(out, 'utf-8'), '[re:MeowSync lrclib_77]\n[00:01.00]外源对词');
});

// ── 宽检轮标题身份闸 / 候选 meta 进判定 / 纯文本词抽样核验 ──
// 实证病例：yt_ 曲 'Twig ／ rei sirose'（author='_'）级联撞上英文同名异曲
// 'Pinocchio Twig / Koosje'（lrclib_12990682，时长 214s 巧合贴近 212s）——
// 子串撞名 + AI 判定器看不见候选身份 + 纯文本零核验，三层缺口分别钉死。

test('strictTitleHit：候选剥缀归一与检索变体精确等才放行', () => {
  const gate = svc.strictTitleHit;
  assert.equal(gate('Pinocchio Twig', 'Twig'), false);          // 子串撞名拒
  assert.equal(gate('Pinocchio Twig', 'Twig ／ rei sirose'), false);
  assert.equal(gate('Twig (feat. Miku)', 'Twig'), true);        // 尾括弧剥缀收
  assert.equal(gate('Twig', 'Twig'), true);                     // 精确同名收
  assert.equal(gate('ロストアンブレラ', 'ロストアンブレラ'), true);
  // 刻意取舍：跨文字形态不互认（罗马音 vs 日文原名）——漏判由兜底链愈合
  assert.equal(gate('ロストアンブレラ', 'Lost Umbrella'), false);
  // 检索词归一成空串（'——' 类纯符号标题）：无标题证据不放行——只收
  // 「候选标题归一后也为空」的条目自证，正常标题一律拒（实案 '□°' 型
  // 检索开放轮回收 'ダンス・ダンス・ダダ' 同题异曲即旧宽让漏入）
  assert.equal(gate('ダンス・ダンス・ダダ', '——'), false);
  assert.equal(gate('曲', '——'), false);
  assert.equal(gate('——', '——'), true);                       // 真·符号同名收
  assert.equal(gate('(——)', '——'), true);                     // 剥括弧归一为空收
  assert.equal(gate('曲', ''), false);                          // 空查询词同样只收归一空候选
  // 候选侧全大写署名头放宽是特性不是 bug（'EMA rumor' 类搬运形态——候选
  // 侧 titleVariantsOf 剥缀归一）——显式钉住防日后被当误剥修回
  assert.equal(gate('EMA rumor', 'rumor'), true);
});

test('LRCLIB 宽检标题闸：strictTitle 下撞名拒、剥缀/精确同名收；闸仍是拉取层可选参数', async () => {
  reset([['lrclib.net', () => J([
    { id: 201, trackName: 'Pinocchio Twig', artistName: 'Koosje', duration: 214, syncedLyrics: '[00:01.00]撞名词' },
    { id: 202, trackName: 'Twig (feat. Miku)', artistName: 'P主', duration: 214, syncedLyrics: '[00:01.00]剥缀同名' },
    { id: 203, trackName: 'Twig', artistName: 'rei sirose', duration: 214, syncedLyrics: '[00:01.00]精确同名' },
  ])]]);
  // strictTitle（级联各轮同款入参）：201 撞名拒收，202/203 归一相等放行
  const res = await svc.lrclibFetch({ title: 'Twig', artist: '', durationSec: 212, strictTitle: true });
  assert.equal(res.extId, 'lrclib_202');
  // 闸缺席（直调拉取层不传参数）：艺人吻合时子串撞名照旧收——strictTitle
  // 参数本身仍是可选；级联层现已全轮恒 true，具名轮不再有此模糊召回形态
  const named = await svc.lrclibFetch({ title: 'Twig', artist: 'Koosje', durationSec: 212 });
  assert.equal(named.extId, 'lrclib_201');
});

test('酷狗宽检标题闸：song 字段撞名拒、同名收；hit 带 meta', async () => {
  reset([
    ['lyrics.kugou.com/search', () => J({
      candidates: [
        { id: 'kx', accesskey: 'akx', singer: 'Koosje', song: 'Pinocchio Twig', duration: 214000, score: 99 },
        { id: 'ky', accesskey: 'aky', singer: 'sirose', song: 'Twig', duration: 214000, score: 10 },
      ],
    })],
    ['lyrics.kugou.com/download', () => kgAll()],
  ]);
  const res = await svc.kugouFetch({ title: 'Twig', artist: '', durationSec: 212, strictTitle: true });
  assert.equal(res.extId, 'kugou_ky');       // 撞名拒收，同名者进 download
  assert.equal(res.meta.title, 'Twig');
  assert.equal(res.meta.artist, 'sirose');
});

test('LRCLIB 宽检标题闸：检索词归一为空（纯符号标题）——正常标题拒、同型符号条目自证收', async () => {
  // 实案回放：UGC 纯符号标题（实录 '□°'）检索词被 normToken 剥净成空串——
  // 旧码 `if (!want) return true` 放行一切候选，开放轮回收
  // 'ダンス・ダンス・ダダ / MAISONdes feat. EMA & たなか' 同题异曲落错词。
  // 新语义：归一空=查询侧无标题证据——只收「候选标题归一后也为空」的条目
  reset([['lrclib.net', () => J([
    { id: 301, trackName: 'ダンス・ダンス・ダダ', artistName: 'MAISONdes', duration: 200, syncedLyrics: '[00:01.00]同题异曲' },
    { id: 302, trackName: '——', artistName: '真作者', duration: 200, syncedLyrics: '[00:01.00]符号同名' },
  ])]]);
  const res = await svc.lrclibFetch({ title: '——', artist: '', durationSec: 200, strictTitle: true });
  assert.equal(res.extId, 'lrclib_302');     // 正常标题撞闸拒收，纯符号同名过闸
});

test('酷狗宽检标题闸：检索词归一为空——song 字段正常标题拒、纯符号收', async () => {
  reset([
    ['lyrics.kugou.com/search', () => J({
      candidates: [
        { id: 'ks1', accesskey: 'ak1', singer: 'MAISONdes', song: 'ダンス・ダンス・ダダ', duration: 200000, score: 99 },
        { id: 'ks2', accesskey: 'ak2', singer: '真作者', song: '——', duration: 200000, score: 10 },
      ],
    })],
    ['lyrics.kugou.com/download', () => kgAll()],
  ]);
  const res = await svc.kugouFetch({ title: '——', artist: '', durationSec: 200, strictTitle: true });
  assert.equal(res.extId, 'kugou_ks2');      // 正常标题拒收，符号同名进 download
});

test('端到端钉案：纯符号标题 UGC（「—— ver.EMA」）剥缀变体归一为空——同题异曲闸拒，级联 NULL', async () => {
  aiOn = true; aiCalls = 0; aiArgs.length = 0;
  try {
    aiAnswer = { ok: true };                 // AI 连判 ok 也救不回——闸先于 AI
    const queries = [];
    reset([
      ['/youtubei/v1/next', () => nextNoTab()],
      // 病例回放：'—— ver.EMA' 剥出变体 '—'（归一为空）——旧码该变体
      // 开放轮放行一切，'—' 检索回收 'ダンス・ダンス・ダダ' 同题异曲
      ['lrclib.net/api/search', (url) => { queries.push(decodeURIComponent(url)); return J([
        { id: 777001, trackName: 'ダンス・ダンス・ダダ', artistName: 'MAISONdes feat. EMA & たなか',
          duration: 200, syncedLyrics: '[00:01.00]little dance song' },
      ]); }],
      ['lyrics.kugou.com', () => J({ candidates: [] })],
    ]);
    const res = await svc.fetchExternalLyric({
      songId: 'yt_symgate0001', title: '—— ver.EMA', artist: '_', durationSec: 200,
    });
    assert.equal(res, null);                 // 正常标题候选全轮次被闸拒
    assert.equal(aiCalls, 0);                // 候选根本没走到 AI 判定/消歧
    assert.ok(queries.length >= 2);          // raw 与剥缀变体都真打过检索
    assert.ok(queries.some((q) => !q.includes('ver.EMA')));   // 归一为空变体实发
    // 对照：归一也为空的纯符号条目正常收（闸只挡「有词形」不同名者）——
    // 过闸后走 strictTitle 轮的 choose 消歧（桩 {ok:true} 畸形应答→未应答）
    // 落回逐候选核验判过收录
    reset([
      ['/youtubei/v1/next', () => nextNoTab()],
      ['lrclib.net/api/search', () => J([
        { id: 777001, trackName: 'ダンス・ダンス・ダダ', artistName: 'MAISONdes feat. EMA & たなか',
          duration: 200, syncedLyrics: '[00:01.00]little dance song' },
        { id: 777002, trackName: '——', artistName: '某P',
          duration: 200, syncedLyrics: '[00:01.00]真词' },
      ])],
      ['lyrics.kugou.com', () => J({ candidates: [] })],
    ]);
    const res2 = await svc.fetchExternalLyric({
      songId: 'yt_symgate0002', title: '—— ver.EMA', artist: '_', durationSec: 200,
    });
    assert.equal(res2?.extId, 'lrclib_777002');
  } finally { aiOn = false; aiAnswer = null; }
});

// ── 具名轮标题闸（strictTitle 恒 true）──
// 实案：'□° ver.EMA'（本家宇田もずく，翻唱者 EMA）具名 'EMA' 轮撞上
// 'ダンス・ダンス・ダダ / MAISONdes feat. EMA & たなか'——候选艺人字段
// 真含 'EMA'，artistHit 子串通过；旧码具名轮无标题闸，同题异曲直接放行
// + AI 盲审 ok:1 落错词。artistHit 只收窄召回，不能替代标题证据

test('具名轮标题闸：艺人字段子串命中 ≠ 同曲——「□° ver.EMA」实案重演', async () => {
  aiOn = true; aiCalls = 0; aiArgs.length = 0;
  try {
    aiAnswer = { ok: true };               // 闸先于 AI——连判 ok 也救不回
    const queries = [];
    const kgDl = [];
    reset([
      ['/youtubei/v1/next', () => nextNoTab()],
      ['lrclib.net/api/search', (url) => { queries.push(decodeURIComponent(url)); return J([
        { id: 8801, trackName: 'ダンス・ダンス・ダダ', artistName: 'MAISONdes feat. EMA & たなか',
          duration: 200, syncedLyrics: '[00:01.00]dance dance dada' },
      ]); }],
      // 酷狗同形态候选也进钉——双源具名轮都被闸拒
      ['lyrics.kugou.com/search', () => J({
        candidates: [
          { id: 'kg88', accesskey: 'ak88', singer: 'MAISONdes feat. EMA & たなか',
            song: 'ダンス・ダンス・ダダ', duration: 200000, score: 99 },
        ],
      })],
      ['lyrics.kugou.com/download', (url) => { kgDl.push(url); return kgAll(); }],
    ]);
    const res = await svc.fetchExternalLyric({
      songId: 'yt_namedgate01', title: '□° ver.EMA', artist: 'EMA', durationSec: 200,
    });
    assert.equal(res, null);                 // 标题不符全轮次被闸拒
    assert.equal(aiCalls, 0);                // 候选根本没走到 AI 判定/消歧
    assert.equal(kgDl.length, 0);            // 酷狗候选被闸拒——download 都没发
    // 具名 'EMA' 轮真实打过检索（artistHit 子串是过的——拒它的是标题闸）
    assert.ok(queries.filter((q) => q.endsWith(' EMA')).length >= 2);
  } finally { aiOn = false; aiAnswer = null; }
});

test('具名轮标题闸不误伤：标题剥缀相等 + 艺人命中照收（feat. 形态）', async () => {
  reset([
    ['lrclib.net', () => J([
      { id: 8810, trackName: 'Twig (feat. Miku)', artistName: 'rei sirose',
        duration: 212, syncedLyrics: '[00:01.00]真词' },
    ])],
    ['lyrics.kugou.com', () => J({ candidates: [] })],
  ]);
  // qq_ 单具名轮——'Twig (feat. Miku)' 剥缀归一 = 'twig' 精确等，闸放行
  const res = await svc.fetchExternalLyric({
    songId: 'qq_namedgate02', title: 'Twig', artist: 'rei sirose', durationSec: 212,
  });
  assert.equal(res?.extId, 'lrclib_8810');
  assert.equal(res?.meta.artist, 'rei sirose');
});

test('端到端钉案：Twig ／ rei sirose（author=_）→「Pinocchio Twig」确定性闸拒，级联 NULL', async () => {
  aiOn = true; aiCalls = 0; aiArgs.length = 0;
  try {
    aiAnswer = { ok: true };                 // AI 连判 ok 也救不回——闸先于 AI
    const queries = [];
    reset([
      ['/youtubei/v1/next', () => nextNoTab()],
      ['lrclib.net/api/search', (url) => { queries.push(decodeURIComponent(url)); return J([
        // 病例回放：lrclib_12990682 英文同名异曲，214s 时长巧合贴近
        { id: 12990682, trackName: 'Pinocchio Twig', artistName: 'Koosje', duration: 214, syncedLyrics: '[00:01.00]little twig song' },
      ]); }],
      ['lyrics.kugou.com', () => J({ candidates: [] })],
    ]);
    const res = await svc.fetchExternalLyric({
      songId: 'yt_KhdXvKwrAcQ', title: 'Twig ／ rei sirose', artist: '_', durationSec: 212,
    });
    assert.equal(res, null);                 // 占位作者轮即上闸——确定性拒收
    assert.equal(aiCalls, 0);                // 候选根本没走到 AI 判定
    assert.ok(queries.length >= 2);          // raw 与剥缀变体都真打过检索
    // 对照：同轮里精确同名候选正常收（闸只挡撞名不挡真名）
    reset([
      ['/youtubei/v1/next', () => nextNoTab()],
      ['lrclib.net/api/search', () => J([
        { id: 12990682, trackName: 'Pinocchio Twig', artistName: 'Koosje', duration: 214, syncedLyrics: '[00:01.00]little twig song' },
        { id: 1300, trackName: 'Twig', artistName: 'rei sirose', duration: 213, syncedLyrics: '[00:01.00]真词' },
      ])],
      ['lyrics.kugou.com', () => J({ candidates: [] })],
    ]);
    const res2 = await svc.fetchExternalLyric({
      songId: 'yt_KhdXvKwrAcQ', title: 'Twig ／ rei sirose', artist: '_', durationSec: 212,
    });
    assert.equal(res2?.extId, 'lrclib_1300');
    // meta 随 hit 透出并进了判定提示词——同名异曲拦截证据到模型
    assert.deepEqual(res2.meta, { title: 'Twig', artist: 'rei sirose', album: undefined });
    // 单候选池同走一发选择题（≥1 语义）——桩回 {ok:true} 对选择题是畸形
    // 应答 → 按未应答落回逐候选核验判过收录
    assert.equal(aiCalls, 2);
    assert.match(aiArgs[0].system, /消歧助手/);
    assert.match(aiArgs[0].user, /候选池：\n1\. Twig \/ rei sirose/);
    assert.match(aiArgs[1].user, /候选条目：标题 Twig \/ 艺人 rei sirose/);
    assert.match(aiArgs[1].system, /候选条目标题\/艺人与来源明显不同/);
  } finally { aiOn = false; aiAnswer = null; }
});

test('AI 核验：纯文本命中也过判定——剥标签行抽样；判否视同无词续级联', async () => {
  aiOn = true; aiCalls = 0; aiArgs.length = 0;
  try {
    aiAnswer = { ok: false };
    reset([
      ['lrclib.net', () => J([
        { id: 401, trackName: '某曲', artistName: '某艺', duration: 200,
          plainLyrics: '[ti:某曲]\n[ar:某艺]\n纯文一\n纯文二' },
      ])],
      ['lyrics.kugou.com', () => J({ candidates: [] })],
    ]);
    const res = await svc.fetchExternalLyric({
      songId: 'qq_plainai0001', title: '某曲', artist: '某艺', durationSec: 200,
    });
    assert.equal(res, null);                 // 纯文本命中不再零核验——判否即丢
    assert.equal(aiCalls, 1);
    assert.match(aiArgs[0].user, /纯文一/);   // 词文行进抽样
    assert.ok(!aiArgs[0].user.includes('ti:')); // 元行剥净不混进证据
    // 剥完真空（纯元行）才放行——不打模型
    reset([['lrclib.net', () => J([
      { id: 402, trackName: '某曲', artistName: '某艺', duration: 200, plainLyrics: '[ti:x]\n[ar:y]' },
    ])],
    ['lyrics.kugou.com', () => J({ candidates: [] })]]);
    const res2 = await svc.fetchExternalLyric({
      songId: 'qq_plainai0002', title: '某曲', artist: '某艺', durationSec: 200,
    });
    assert.equal(res2?.extId, 'lrclib_402');
    assert.equal(aiCalls, 1);                // 没再打模型
  } finally { aiOn = false; aiAnswer = null; }
});

test('AI 核验：已落库判否 verdict 不随 aiEnabled 旁路——AI 关仍拒收续级联', async () => {
  // 播放预览链与下载链同口径（verifyDownloadOwnership 缓存先行）：记忆是
  // 累积知识，AI 关只影响新判定。播种 lrclib_66 对本曲的 ok=0 判定——
  // vkey 锚 (extId, title, artist)，verifyHit 不再被 aiEnabled 短路
  aiOn = false; aiCalls = 0; aiArgs.length = 0;
  // 级联核验带候选池语境 → v4 键（pool 非空即换盐——见 lyricVerdictKey
  // 版本段）；预置要锚新口径的判定键
  lyricAiRepo.upsertVerdict(
    lyricVerdictKey('lrclib_66', '曲', '艺人', true), 'lyric', false, 'test');
  reset([
    ['lrclib.net/api/search', () => J([
      { id: 66, trackName: '曲', artistName: '艺人', duration: 200, syncedLyrics: '[00:01.00]错配词' },
    ])],
    ['lyrics.kugou.com/search', () => J(kg)],
    ['lyrics.kugou.com/download', () => kgAll()],
  ]);
  const res = await svc.fetchExternalLyric({
    songId: 'qq_verdictmem01', title: '曲', artist: '艺人', durationSec: 200,
  });
  assert.equal(res?.extId, 'kugou_k3');      // 判否拒收 → 级联转下一源
  // 落库判定命中即返不烧 AI；幸存候选判定入 askAiJson——桩按入口计数，
  // 真身 aiEnabled false 时前置返 null（不发 HTTP）→ 判不定按相符放行
  assert.equal(aiCalls, 1);
});

// ── 免时长末轮 + fetch 层逐候选核验 ──
// 实证病例：72s 截取版翻唱 'Flamingo／rei shirose'（author='R'）——
// ±15s 时长闸对截取版全灭；摘掉时长后检索首顺位是英文同名异曲
// 'Flamingo / Kero Kero Bonito'，真主 'Flamingo / 米津玄師' 紧随其后。
// 末轮 = UGC 限定 durationSec=0 + strictTitle 恒 true 重扫，同名歧义由
// 标题精确闸先挡、逐候选归属核验（判否换条）兜住。

test('免时长末轮：时长闸全灭的截取版 UGC → durationSec=0 + strictTitle 末轮命中真主', async () => {
  aiOn = true; aiCalls = 0; aiArgs.length = 0;
  try {
    aiAnswer = { ok: true };
    const kgUrls = [];
    const lrcQueries = [];
    reset([
      ['/youtubei/v1/next', () => nextNoTab()],
      ['lrclib.net/api/search', (url) => { lrcQueries.push(decodeURIComponent(url)); return J([
        // 两条都 duration 240s——对 72s 截取版的 ±15s 闸必滤；免时长轮才收。
        // 'Pinocchio Flamingo' 艺人名含 r 过 artistHit('R')、含 Flamingo
        // 子串——唯有 strictTitle 精确闸拒它（闸缺席时它以 501 顺位进
        // verify 并胜出）；末轮 strictTitle 恒 true
        { id: 501, trackName: 'Pinocchio Flamingo', artistName: 'Kero Kero Bonito',
          duration: 240, syncedLyrics: '[00:01.00]english song' },
        { id: 502, trackName: 'Flamingo', artistName: '米津玄師',
          duration: 240, syncedLyrics: '[00:01.00]真词' },
      ]); }],
      ['lyrics.kugou.com/search', (url) => { kgUrls.push(url); return J({ candidates: [] }); }],
    ]);
    const res = await svc.fetchExternalLyric({
      songId: 'yt_o5wwDO4eDo8', title: 'Flamingo／rei shirose', artist: 'R', durationSec: 72,
    });
    assert.equal(res?.extId, 'lrclib_502');
    // 撞名者被确定性闸挡在 AI 之前；末轮单候选池走一发选择题（≥1 语义），
    // 桩回 {ok:true} 是畸形应答 → 未应答落回逐候选核验判过收录
    assert.equal(aiCalls, 2);
    assert.match(aiArgs[0].system, /消歧助手/);
    assert.match(aiArgs[0].user, /候选池：\n1\. Flamingo \/ 米津玄師/);
    // meta 随末轮 hit 照常透出并进判定提示词——AI 拿候选身份才分得清同名
    assert.deepEqual(res.meta, { title: 'Flamingo', artist: '米津玄師', album: undefined });
    assert.match(aiArgs[1].user, /候选条目：标题 Flamingo \/ 艺人 米津玄師/);
    // durationSec=0 实锤上行：常规轮酷狗检索带 duration=72000；末轮是
    // 单次 '' 开放轮——lrclib 命中即收不再打酷狗。检索面 = 常规两轮 4 发
    // + 末轮 2 发 = 6，具名 'R' 检索只在常规轮出现（末轮再打一遍会是 8）
    assert.ok(kgUrls.length >= 1 && kgUrls.every((u) => u.includes('duration=72000')));
    assert.equal(lrcQueries.length, 6);
    assert.equal(lrcQueries.filter((q) => q.endsWith(' R')).length, 2);
  } finally { aiOn = false; aiAnswer = null; }
});

test('逐候选核验：首顺位同名候选判否 → 次位判过收录（vkey 挂各自 extId 不串）', async () => {
  aiOn = true; aiCalls = 0; aiArgs.length = 0;
  try {
    // 选择题哑火（未应答）才落到本用例要测的逐候选核验面——回 {pick:x}
    // 会直接收录、回 {pick:null} 会判死全池，都测不到换条
    aiAnswer = (a) => (/消歧助手/.test(a.system) ? null : { ok: true });
    // 预置首顺位候选的判否 verdict——vkey 锚 (extId, 来源title, 来源artist)，
    // 601 判否不影响 602 的判定行
    lyricAiRepo.upsertVerdict(
      lyricVerdictKey('lrclib_601', 'Flamingo', 'R', true), 'lyric', false, 'test');
    reset([
      ['/youtubei/v1/next', () => nextNoTab()],
      ['lrclib.net/api/search', () => J([
        // 同名同长：首顺位撞名英文曲、次位真主——旧「一锤定音」拿 601
        // 判否即整源判死；逐候选核验判否换条
        { id: 601, trackName: 'Flamingo', artistName: 'Kero Kero Bonito',
          duration: 72, syncedLyrics: '[00:01.00]english cover words' },
        { id: 602, trackName: 'Flamingo', artistName: '米津玄師',
          duration: 72, syncedLyrics: '[00:01.00]本物の詞' },
      ])],
      ['lyrics.kugou.com', () => J({ candidates: [] })],
    ]);
    const res = await svc.fetchExternalLyric({
      songId: 'yt_percdv00001', title: 'Flamingo', artist: 'R', durationSec: 72,
    });
    assert.equal(res?.extId, 'lrclib_602');
    assert.equal(res.meta.artist, '米津玄師');
    assert.equal(aiCalls, 2);              // choose 哑火 1 发 + 602 判定 1 发
    assert.match(aiArgs[0].system, /消歧助手/);   // 开放轮池先进选择题
    // 601 判否吃落库 verdict 不烧 AI；进判定的是次位候选的条目身份——
    // 候选序断言（首顺位确被先试）
    assert.match(aiArgs[1].user, /候选条目：标题 Flamingo \/ 艺人 米津玄師/);
  } finally { aiOn = false; aiAnswer = null; }
});

test('逐候选核验（酷狗）：首条 download 得词判否 → 换条判过收录', async () => {
  aiOn = true; aiCalls = 0; aiArgs.length = 0;
  try {
    // 同上——选择题哑火才进逐候选迭代面（开放轮池现在先走 choose）
    aiAnswer = (a) => (/消歧助手/.test(a.system) ? null : { ok: true });
    lyricAiRepo.upsertVerdict(
      lyricVerdictKey('kugou_kc1', 'Flamingo', 'R', true), 'lyric', false, 'test');
    const dlUrls = [];
    reset([
      ['/youtubei/v1/next', () => nextNoTab()],
      ['lrclib.net', () => J([])],
      ['lyrics.kugou.com/search', () => J({
        candidates: [
          // singer 都不含 r——具名 'R' 轮被 artistHit 滤净，宽检轮才展开
          { id: 'kc1', accesskey: 'ak1', singer: 'Koosje', song: 'Flamingo', duration: 72000, score: 99 },
          { id: 'kc2', accesskey: 'ak2', singer: '米津玄師', song: 'Flamingo', duration: 72000, score: 50 },
        ],
      })],
      ['lyrics.kugou.com/download', (url) => {
        dlUrls.push(url);
        return J({ content: Buffer.from('[00:03.00]狗词一\n[00:06.00]狗词二').toString('base64'), charset: 'utf8' });
      }],
    ]);
    const res = await svc.fetchExternalLyric({
      songId: 'yt_kgverify001', title: 'Flamingo', artist: 'R', durationSec: 72,
    });
    assert.equal(res?.extId, 'kugou_kc2');
    assert.equal(res.meta.artist, '米津玄師');
    // 候选序断言：score 高的 kc1 先 download 得词被判否 → continue 换 kc2
    assert.equal(dlUrls.length, 2);
    assert.ok(dlUrls[0].includes('id=kc1'));
    assert.ok(dlUrls[1].includes('id=kc2'));
    assert.equal(aiCalls, 2);              // choose 哑火 1 发 + kc2 判定 1 发
    assert.match(aiArgs[0].system, /消歧助手/);   // 开放轮池先进选择题
    // kc1 判否吃落库；kc2 判过进 AI
    assert.match(aiArgs[1].user, /候选条目：标题 Flamingo \/ 艺人 米津玄師/);
  } finally { aiOn = false; aiAnswer = null; }
});

test('免时长末轮不波及曲库 id：qq_ 常规轮全灭即 null，免时长轮不展开', async () => {
  const kgUrls = [];
  const lrcQueries = [];
  reset([
    ['lrclib.net/api/search', (url) => {
      lrcQueries.push(decodeURIComponent(url));
      // 时长 240s 对 72s 必滤——若误进免时长轮它会现身收成 hit
      return J([
        { id: 701, trackName: 'Flamingo', artistName: 'Kero Kero Bonito',
          duration: 240, syncedLyrics: '[00:01.00]x' },
      ]);
    }],
    ['lyrics.kugou.com/search', (url) => { kgUrls.push(url); return J({ candidates: [] }); }],
  ]);
  const res = await svc.fetchExternalLyric({
    songId: 'qq_noflame0001', title: 'Flamingo', artist: 'R', durationSec: 72,
  });
  assert.equal(res, null);
  // 曲库 id 只跑严格轮：检索数=变体数（'Flamingo' 无剥缀 → 1 变体），
  // 酷狗检索全部带 duration=——免时长轮一次都没展开
  assert.equal(lrcQueries.length, 1);
  assert.ok(kgUrls.length >= 1 && kgUrls.every((u) => u.includes('duration=72000')));
});

test('免时长末轮 strictTitle 恒 true：具名轮里撞名候选也确定性闸（先于 AI）', async () => {
  aiOn = true; aiCalls = 0; aiArgs.length = 0;
  try {
    aiAnswer = { ok: true };               // AI 连判 ok 也救不回——闸先于 AI
    const kgUrls = [];
    reset([
      ['/youtubei/v1/next', () => nextNoTab()],
      ['lrclib.net/api/search', () => J([
        // 艺人名含 r 过 artistHit('R')、标题含 Flamingo 子串——免时长轮
        // 里若具名 'R' 轮不上 strictTitle，它会以首顺位进 verify 并胜出
        { id: 801, trackName: 'Pinocchio Flamingo', artistName: 'Kero Kero Bonito',
          duration: 240, syncedLyrics: '[00:01.00]little flamingo song' },
      ])],
      ['lyrics.kugou.com/search', (url) => { kgUrls.push(url); return J({ candidates: [] }); }],
    ]);
    const res = await svc.fetchExternalLyric({
      songId: 'yt_strictgate1', title: 'Flamingo', artist: 'R', durationSec: 72,
    });
    assert.equal(res, null);               // 撞名候选全轮次被闸拒
    assert.equal(aiCalls, 0);              // 候选根本没走到 AI 判定
    // 免时长轮确已展开（酷狗检索出现不带 duration= 的形态）
    assert.ok(kgUrls.some((u) => !u.includes('duration=')));
  } finally { aiOn = false; aiAnswer = null; }
});

// ── 末轮收成单开放轮 + 整池单发消歧（Flamingo 钉案真实形态）──
// 实证病例回放：72s 截取版 'Flamingo／rei shirose'（artist='R'）——旧末轮
// 按 artist 轮次面重扫，'R' 具名轮 artistHit('R') 归一成 'r' 子串筛：放行
// 'Earl Bostic'/'Fäaschtbänkler'、滤死真身 '米津玄師'/'Kenshi Yonezu'——
// 真身没到 AI 眼前，撞名者被盲审判 ok 收录。pool-in-prompt 逐候选判定
// 仍是逐题形态，对同题异曲消歧不够决断（活跑把 KKB 英文版判 ok 收录）——
// 改成整池单发选择题（choose→judgePoolPick）：排序后全池摆给判官一发
// 问「来源最可能翻唱哪条」，单发指中原曲本家；未选中才落回逐候选核验。

test('免时长末轮整池消歧 e2e：Flamingo 钉案——choose 单发指中米津玄師', async () => {
  aiOn = true; aiCalls = 0; aiArgs.length = 0;
  try {
    // AI 桩：pick 选择题回 4（排序后池序见下——synced 优先纯文本殿后）；
    // 挑中条词文核验判过——若代码误落逐候选核验，首顺位 KKB 判过收录会
    // 让 extId 断言露馅（不会静默收错条）
    aiAnswer = (a) => (/消歧助手/.test(a.system) ? { pick: 4 } : { ok: true });
    const lrcQueries = [];
    const kgUrls = [];
    reset([
      ['/youtubei/v1/next', () => nextNoTab()],
      ['lrclib.net/api/search', (url) => {
        lrcQueries.push(decodeURIComponent(url));
        return J([
          // 真实池形态：同题 'Flamingo' 一池，duration 皆 240——对 72s 截取版
          // 的 ±15s 闸必灭，全靠免时长末轮进场。'r' 子串筛在位时 Earl/
          // Fäaschtbänkler 放行、米津玄師 滤死；开放轮里全进 pool。
          // 排序后面序：KKB×2、Fäascht、米津、Kenshi、Earl（纯文本殿后）
          { id: 36018560, trackName: 'Flamingo', artistName: 'Kero Kero Bonito',
            albumName: 'Flamingo', duration: 240,
            syncedLyrics: '[00:01.00]kkb english words\n[00:05.00]second line' },
          { id: 36018666, trackName: 'Flamingo', artistName: 'Kero Kero Bonito',
            albumName: 'Flamingo (Remixes)', duration: 240,
            syncedLyrics: '[00:01.00]kkb remix words' },
          { id: 26801631, trackName: 'Flamingo', artistName: 'Earl Bostic',
            albumName: 'Jazz Icons', duration: 240,
            plainLyrics: 'flamingo jazz words\nsecond line' },
          { id: 44000001, trackName: 'Flamingo', artistName: 'Fäaschtbänkler',
            albumName: 'Zirbenlieder', duration: 240,
            syncedLyrics: '[00:01.00]deutsche Zeile\n[00:05.00]noch eine' },
          { id: 37537527, trackName: 'Flamingo', artistName: '米津玄師',
            albumName: 'Flamingo / TEENAGE RIOT', duration: 240,
            syncedLyrics: '[00:01.00]宵闇に爪弾き\n[00:05.00]悲しみに雨ざらし' },
          { id: 34560247, trackName: 'Flamingo', artistName: 'Kenshi Yonezu',
            albumName: 'Flamingo / TEENAGE RIOT', duration: 240,
            syncedLyrics: '[00:01.00]romanized synced words' },
        ]);
      }],
      ['lyrics.kugou.com/search', (url) => { kgUrls.push(url); return J({ candidates: [] }); }],
    ]);
    const res = await svc.fetchExternalLyric({
      songId: 'yt_flmpool0001', title: 'Flamingo／rei shirose', artist: 'R', durationSec: 72,
    });
    assert.equal(res?.extId, 'lrclib_37537527');
    assert.equal(res?.synced, true);
    assert.equal(res?.meta.artist, '米津玄師');
    // choose 单发挑中 + 挑中条词文核验判过收录——两道独立证据各一发，
    // 不再逐候选烧 N 发 AI
    assert.equal(aiCalls, 2);
    assert.match(aiArgs[0].system, /消歧助手/);
    // 排序后全池身份都进了同一发 prompt——判官拿相对语境做选择题
    assert.match(aiArgs[0].user,
      /候选池：\n1\. Flamingo \/ Kero Kero Bonito \/ Flamingo\n2\. Flamingo \/ Kero Kero Bonito \/ Flamingo \(Remixes\)\n3\. Flamingo \/ Fäaschtbänkler \/ Zirbenlieder\n4\. Flamingo \/ 米津玄師 \/ Flamingo \/ TEENAGE RIOT\n5\. Flamingo \/ Kenshi Yonezu \/ Flamingo \/ TEENAGE RIOT\n6\. Flamingo \/ Earl Bostic \/ Jazz Icons/);
    // 第二发是挑中条的词文核验——判米津玄師条目的词文抽样（带同题池语境）
    assert.match(aiArgs[1].system, /核验助手/);
    assert.match(aiArgs[1].user, /候选条目：标题 Flamingo \/ 艺人 米津玄師/);
    // 末轮单开放轮实锤不变：具名 'R' 只在常规首轮打（2 发 ' R' 尾检索），
    // 末轮检索（位序最末两发）不带 artist
    assert.equal(lrcQueries.filter((q) => q.endsWith(' R')).length, 2);
    assert.equal(lrcQueries.length, 6);      // 'R'轮2 + ''轮2 + 末轮开放2
    assert.ok(lrcQueries.slice(4).every((q) => !q.endsWith(' R')));
    // 末轮 lrclib 命中即收——酷狗只在常规轮被检索（全带 duration=72000）
    assert.ok(kgUrls.length >= 1 && kgUrls.every((u) => u.includes('duration=72000')));
  } finally { aiOn = false; aiAnswer = null; }
});

test('免时长末轮 choose 明言否决全池：判死该变体——跳过逐候选核验兜底归 null', async () => {
  aiOn = true; aiCalls = 0; aiArgs.length = 0;
  try {
    // pick:null 是判官应答且明言「池中无合理候选」——precise 优先：判官
    // 说不合理就判死（错词比没词更糟，没词走 rematch 自愈）；若误落回
    // 逐候选核验，桩判 ok 全收会把「不该收录」露馅成 hit
    aiAnswer = (a) => (/消歧助手/.test(a.system) ? { pick: null } : { ok: true });
    reset([
      ['/youtubei/v1/next', () => nextNoTab()],
      ['lrclib.net/api/search', () => J([
        { id: 36018560, trackName: 'Flamingo', artistName: 'Kero Kero Bonito',
          albumName: 'Flamingo', duration: 240,
          syncedLyrics: '[00:01.00]english cover words' },
        { id: 37537527, trackName: 'Flamingo', artistName: '米津玄師',
          albumName: 'Flamingo / TEENAGE RIOT', duration: 240,
          syncedLyrics: '[00:01.00]本物の詞' },
      ])],
      ['lyrics.kugou.com', () => J({ candidates: [] })],
    ]);
    const res = await svc.fetchExternalLyric({
      songId: 'yt_picknull001', title: 'Flamingo', artist: 'R', durationSec: 72,
    });
    assert.equal(res, null);                 // 全池否决 → 级联无词
    // 只有一发选择题——逐候选核验兜底被跳过（否决不回落、不落 verdict）
    assert.equal(aiCalls, 1);
    assert.match(aiArgs[0].system, /消歧助手/);
    assert.match(aiArgs[0].user,
      /候选池：\n1\. Flamingo \/ Kero Kero Bonito \/ Flamingo\n2\. Flamingo \/ 米津玄師 \/ Flamingo \/ TEENAGE RIOT/);
  } finally { aiOn = false; aiAnswer = null; }
});

test('choose 故障落回：choose 抛错 → 逐候选核验迭代照常判否换条', async () => {
  const verifyCalls = [];
  reset([['lrclib.net', () => J([
    { id: 610, trackName: 'Flamingo', artistName: 'Kero Kero Bonito', duration: 240, syncedLyrics: '[00:01.00]x' },
    { id: 611, trackName: 'Flamingo', artistName: '米津玄師', duration: 240, syncedLyrics: '[00:01.00]y' },
  ])]]);
  const res = await svc.lrclibFetch({
    title: 'Flamingo', artist: '', strictTitle: true,
    verify: async (h) => { verifyCalls.push(h.extId); return h.extId === 'lrclib_611'; },
    choose: async () => { throw new Error('消歧上游炸'); },
  });
  assert.equal(res?.extId, 'lrclib_611');              // 故障不整源判死
  assert.deepEqual(verifyCalls, ['lrclib_610', 'lrclib_611']);  // 迭代序不变
  assert.equal(res?.verified, true);                   // 过 verify 烙记照打
});

test('choose ≥1 语义：单候选池同走一发选择题——布尔盲审对同题异曲太松', async () => {
  let chooseCalls = 0;
  const verifyCalls = [];
  reset([['lrclib.net', () => J([
    { id: 620, trackName: 'Flamingo', artistName: '米津玄師', duration: 240, syncedLyrics: '[00:01.00]y' },
  ])]]);
  const res = await svc.lrclibFetch({
    title: 'Flamingo', artist: '', strictTitle: true,
    verify: async (h) => { verifyCalls.push(h.extId); return true; },
    choose: async (pool) => {
      chooseCalls++;
      assert.deepEqual(pool.map((p) => p.extId), ['lrclib_620']);
      return { pick: 'lrclib_620', answered: true };
    },
  });
  assert.equal(res?.extId, 'lrclib_620');
  assert.equal(chooseCalls, 1);                        // 单候选也发选择题
  assert.deepEqual(verifyCalls, ['lrclib_620']);       // 挑中条补跑一发词文核验
  assert.equal(res?.verified, true);
});

test('choose 指回池外 extId（判官答非所问）→ 按未应答落回逐候选迭代', async () => {
  const verifyCalls = [];
  reset([['lrclib.net', () => J([
    { id: 621, trackName: 'Flamingo', artistName: 'Kero Kero Bonito', duration: 240, syncedLyrics: '[00:01.00]x' },
    { id: 622, trackName: 'Flamingo', artistName: '米津玄師', duration: 240, syncedLyrics: '[00:01.00]y' },
  ])]]);
  const res = await svc.lrclibFetch({
    title: 'Flamingo', artist: '', strictTitle: true,
    verify: async (h) => { verifyCalls.push(h.extId); return h.extId === 'lrclib_622'; },
    // 池里没有这条 id——应答了但指不回去，按未应答落回（不整源判死）
    choose: async () => ({ pick: 'lrclib_99999999', answered: true }),
  });
  assert.equal(res?.extId, 'lrclib_622');
  assert.deepEqual(verifyCalls, ['lrclib_621', 'lrclib_622']);
});

test('kugou choose：挑中只对一条发 download——整池消歧替代逐条试下', async () => {
  const dlUrls = [];
  const verifyCalls = [];
  reset([
    ['lyrics.kugou.com/search', () => J({
      candidates: [
        // score 决胜序 kc1>kc2>kc3——choose 不取首顺位取 kc2
        { id: 'kc1', accesskey: 'ak1', singer: 'Kero Kero Bonito', song: 'Flamingo', duration: 240000, score: 99 },
        { id: 'kc2', accesskey: 'ak2', singer: '米津玄師', song: 'Flamingo', duration: 240000, score: 50 },
        { id: 'kc3', accesskey: 'ak3', singer: 'Fäaschtbänkler', song: 'Flamingo', duration: 240000, score: 10 },
      ],
    })],
    ['lyrics.kugou.com/download', (url) => { dlUrls.push(url); return kgAll(); }],
  ]);
  const res = await svc.kugouFetch({
    title: 'Flamingo', artist: '', strictTitle: true,
    verify: async (h) => { verifyCalls.push(h.extId); return true; },
    choose: async (pool) => {
      // 池行 extId 与 hit.extId 同式——choose 凭它指回条目
      assert.deepEqual(pool.map((p) => p.extId), ['kugou_kc1', 'kugou_kc2', 'kugou_kc3']);
      return { pick: 'kugou_kc2', answered: true };
    },
  });
  assert.equal(res?.extId, 'kugou_kc2');
  assert.equal(res?.meta.artist, '米津玄師');
  assert.equal(dlUrls.length, 1);                      // 只对挑中条发 download
  assert.ok(dlUrls[0].includes('id=kc2'));
  assert.deepEqual(verifyCalls, ['kugou_kc2']);        // 得词后补跑一发词文核验
  assert.equal(res?.verified, true);
});

// ── choose 只注无艺人约束轮（strictTitle 恒 true 全轮在位）：≥1 启用 /
// 否决判死三态 / 挑中条补验 ──
// 实证病例：常规开放轮（±15s 时长闸在位）里 'Boi ver.EMA'→'Boi/Dina
// Jashari' 马其顿语歌、'Moonlight ver.EMA'→'Moonlight/Gaulin' rap、
// '匿名希望 ver.EMA'→'匿名希望/amazarashi' 同题异曲被逐候选盲审连判
// ok:1 收录——时长闸与标题闸都拦不住的形态，只有整池选择题分得清；
// 且 pick 只比候选元数据不看词文——挑中条补跑 verify 才有第二道证据
// （'Boi' 实案里被 pick 选中的恰是马其顿语同名歌，词文判否即判死变体）。

test('strictTitle 开放轮多候选：choose 单发挑中 + 补验判过收录——常规轮也走整池消歧', async () => {
  aiOn = true; aiCalls = 0; aiArgs.length = 0;
  try {
    aiAnswer = (a) => (/消歧助手/.test(a.system) ? { pick: 2 } : { ok: true });
    const lrcQueries = [];
    reset([
      ['/youtubei/v1/next', () => nextNoTab()],
      ['lrclib.net/api/search', (url) => { lrcQueries.push(decodeURIComponent(url)); return J([
        { id: 710, trackName: '曲', artistName: '撞名艺人', duration: 200, syncedLyrics: '[00:01.00]撞名词' },
        { id: 711, trackName: '曲', artistName: '真身艺人', duration: 205, syncedLyrics: '[00:01.00]真词' },
      ]); }],
      ['lyrics.kugou.com', () => J({ candidates: [] })],
    ]);
    const res = await svc.fetchExternalLyric({
      songId: 'yt_openchoose1', title: '曲', artist: 'UP主', durationSec: 200,
    });
    assert.equal(res?.extId, 'lrclib_711');
    assert.equal(res?.meta.artist, '真身艺人');
    // 选择题挑中 + 挑中条补一发词文核验判过收录——漏接 verify 的话
    // 挑中条会不验词直接收录（旧病灶：'Boi' 实案西里尔词文未验即收）
    assert.equal(aiCalls, 2);
    assert.match(aiArgs[0].system, /消歧助手/);
    assert.match(aiArgs[0].user, /候选池：\n1\. 曲 \/ 撞名艺人 \/ 未知\n2\. 曲 \/ 真身艺人 \/ 未知/);
    assert.match(aiArgs[1].system, /核验助手/);
    assert.match(aiArgs[1].user, /候选条目：标题 曲 \/ 艺人 真身艺人/);
    // 命中发生在常规开放轮而非免时长末轮：'UP主' 具名轮（artistHit 滤净）
    // 1 发检索 + '' 开放轮 1 发即收，没走到末轮
    assert.equal(lrcQueries.length, 2);
    assert.ok(lrcQueries[0].endsWith(' UP主'));
    assert.ok(!lrcQueries[1].includes('UP主'));
  } finally { aiOn = false; aiAnswer = null; }
});

test('choose 否决全池（lrclib）：判官明言无合理候选 → 该变体判死不落回 verify', async () => {
  const verifyCalls = [];
  reset([['lrclib.net', () => J([
    { id: 630, trackName: 'Boi', artistName: 'Dina Jashari', duration: 200, syncedLyrics: '[00:01.00]macedonian words' },
    { id: 631, trackName: 'Boi', artistName: '別人', duration: 200, syncedLyrics: '[00:01.00]x' },
  ])]]);
  const res = await svc.lrclibFetch({
    title: 'Boi', artist: '', durationSec: 200, strictTitle: true,
    verify: async (h) => { verifyCalls.push(h.extId); return true; },
    choose: async () => ({ pick: null, answered: true }),  // 「池中无合理候选」
  });
  assert.equal(res, null);                   // 判死——precise 优先不落回兜底
  assert.equal(verifyCalls.length, 0);       // 盲审「拿不准判真」没机会再放行
});

test('choose 否决全池（酷狗）：判死即停——挑中 download 与逐候选迭代都不发', async () => {
  const dlUrls = [];
  const verifyCalls = [];
  reset([
    ['lyrics.kugou.com/search', () => J({
      candidates: [
        { id: 'kv1', accesskey: 'ak1', singer: '别人', song: 'Boi', duration: 200000, score: 99 },
        { id: 'kv2', accesskey: 'ak2', singer: '別二', song: 'Boi', duration: 200000, score: 50 },
      ],
    })],
    ['lyrics.kugou.com/download', (url) => { dlUrls.push(url); return kgAll(); }],
  ]);
  const res = await svc.kugouFetch({
    title: 'Boi', artist: '', durationSec: 200, strictTitle: true,
    verify: async (h) => { verifyCalls.push(h.extId); return true; },
    choose: async () => ({ pick: null, answered: true }),
  });
  assert.equal(res, null);
  assert.equal(dlUrls.length, 0);
  assert.equal(verifyCalls.length, 0);
});

test('choose 未应答（AI 关/哑火/畸形）→ 落回逐候选核验迭代——降级期不缩召回', async () => {
  const verifyCalls = [];
  reset([['lrclib.net', () => J([
    { id: 640, trackName: 'Boi', artistName: 'Dina Jashari', duration: 200, syncedLyrics: '[00:01.00]x' },
    { id: 641, trackName: 'Boi', artistName: '可不', duration: 200, syncedLyrics: '[00:01.00]y' },
  ])]]);
  const res = await svc.lrclibFetch({
    title: 'Boi', artist: '', strictTitle: true,
    verify: async (h) => { verifyCalls.push(h.extId); return h.extId === 'lrclib_641'; },
    choose: async () => null,                  // 通道不可用——没给裁决
  });
  assert.equal(res?.extId, 'lrclib_641');
  assert.deepEqual(verifyCalls, ['lrclib_640', 'lrclib_641']);  // 迭代序照走
});

test('choose 挑中条词文核验判否 → 判死该变体不落回迭代（Boi/Dina Jashari 实案形态）', async () => {
  // 实案回放：'Boi ver.EMA'（本家ポリスピカデリー）开放轮池=[Boi/Dina
  // Jashari 马其顿语同名歌]——旧码 pick 选中即 markVerified 收录，西里尔
  // 词文全程未验。新语义挑中补验：pick 已是池内最优的相对判定，最优条
  // 过不了词文关说明池中无正解——判死该变体，逐条重验只是重复烧 AI
  const verifyCalls = [];
  reset([['lrclib.net', () => J([
    { id: 650, trackName: 'Boi', artistName: 'Dina Jashari', duration: 200, syncedLyrics: '[00:01.00]македонски зборови' },
    { id: 651, trackName: 'Boi', artistName: 'ポリスピカデリー', duration: 200, syncedLyrics: '[00:01.00]y' },
  ])]]);
  const res = await svc.lrclibFetch({
    title: 'Boi', artist: '', durationSec: 200, strictTitle: true,
    verify: async (h) => { verifyCalls.push(h.extId); return false; },
    choose: async () => ({ pick: 'lrclib_650', answered: true }),
  });
  assert.equal(res, null);                          // 判死——不落回逐候选迭代
  assert.deepEqual(verifyCalls, ['lrclib_650']);    // 只对挑中条补验一发即终
});

test('choose 挑中条补验抛错（非 abort）→ 按未收录落回逐候选核验迭代', async () => {
  // candidatePass 式「异常放行」会把没验过的错词重新放进门——故障改按
  // 未收录落回迭代，迭代内再走 candidatePass 盲审保底（与候选迭代已有
  // 容错同口径，不丢召回）
  const verifyCalls = [];
  let n = 0;
  reset([['lrclib.net', () => J([
    { id: 652, trackName: 'Boi', artistName: 'Dina Jashari', duration: 200, syncedLyrics: '[00:01.00]x' },
    { id: 653, trackName: 'Boi', artistName: 'ポリスピカデリー', duration: 200, syncedLyrics: '[00:01.00]y' },
  ])]]);
  const res = await svc.lrclibFetch({
    title: 'Boi', artist: '', durationSec: 200, strictTitle: true,
    verify: async (h) => {
      verifyCalls.push(h.extId);
      if (++n === 1) throw new Error('核验通道炸');   // 挑中条补验故障
      return h.extId === 'lrclib_653';
    },
    choose: async () => ({ pick: 'lrclib_652', answered: true }),
  });
  assert.equal(res?.extId, 'lrclib_653');           // 落回迭代照常判否换条
  // 挑中条在迭代里被盲审重验一发——故障不白打也不直接放行
  assert.deepEqual(verifyCalls, ['lrclib_652', 'lrclib_652', 'lrclib_653']);
  assert.equal(res?.verified, true);
});

test('choose 挑中条词文核验判否（酷狗）→ 判死该变体不落回迭代', async () => {
  // 同 lrclib 侧——挑中只对一条发 download，得词补验判否即判死；
  // 不落回迭代（池内最优过不了词文关=池中无正解）
  const dlUrls = [];
  const verifyCalls = [];
  reset([
    ['lyrics.kugou.com/search', () => J({
      candidates: [
        { id: 'kb1', accesskey: 'ak1', singer: 'Dina Jashari', song: 'Boi', duration: 200000, score: 99 },
        { id: 'kb2', accesskey: 'ak2', singer: 'ポリスピカデリー', song: 'Boi', duration: 200000, score: 50 },
      ],
    })],
    ['lyrics.kugou.com/download', (url) => { dlUrls.push(url); return kgAll(); }],
  ]);
  const res = await svc.kugouFetch({
    title: 'Boi', artist: '', durationSec: 200, strictTitle: true,
    verify: async (h) => { verifyCalls.push(h.extId); return false; },
    choose: async () => ({ pick: 'kugou_kb1', answered: true }),
  });
  assert.equal(res, null);
  assert.equal(dlUrls.length, 1);                   // 只对挑中条烧过一发 download
  assert.deepEqual(verifyCalls, ['kugou_kb1']);     // 补验一发判否即终
});

test('choose 挑中 + 词文核验判死 e2e：Boi/Dina Jashari 实案——判死变体级联归 null', async () => {
  aiOn = true; aiCalls = 0; aiArgs.length = 0;
  try {
    // 实案回放：'Boi ver.EMA'（本家ポリスピカデリー，翻唱 EMA）开放轮池
    // 只剩 Dina Jashari 马其顿语同名歌——选择题按元数据指中它（确实最合），
    // 词文核验判否即判死变体；判否落 v4 verdict——末轮同池重进吃落库
    // 判否与 memoize 裁决，不再重复烧 AI
    aiAnswer = (a) => (/消歧助手/.test(a.system) ? { pick: 1 } : { ok: false });
    reset([
      ['/youtubei/v1/next', () => nextNoTab()],
      ['lrclib.net/api/search', () => J([
        { id: 8802, trackName: 'Boi', artistName: 'Dina Jashari', duration: 200,
          syncedLyrics: '[00:01.00]македонски зборови\n[00:05.00]втора линија' },
      ])],
      ['lyrics.kugou.com', () => J({ candidates: [] })],
    ]);
    const res = await svc.fetchExternalLyric({
      songId: 'yt_boiverema01', title: 'Boi ver.EMA', artist: 'EMA', durationSec: 200,
    });
    assert.equal(res, null);                 // 池中无正解——错词不收录
    assert.equal(aiCalls, 2);                // 选择题 1 发 + 挑中条词文核验 1 发
    assert.match(aiArgs[0].system, /消歧助手/);
    assert.match(aiArgs[0].user, /候选池：\n1\. Boi \/ Dina Jashari/);
    assert.match(aiArgs[1].system, /核验助手/);
    assert.match(aiArgs[1].user, /候选条目：标题 Boi \/ 艺人 Dina Jashari/);
  } finally { aiOn = false; aiAnswer = null; }
});

test('choose 降级不缩召回 e2e：AI 关时开放轮池未应答 → 落回逐候选核验照收', async () => {
  aiOn = false; aiCalls = 0; aiArgs.length = 0;
  reset([
    ['/youtubei/v1/next', () => nextNoTab()],
    ['lrclib.net/api/search', () => J([
      { id: 730, trackName: '曲', artistName: '撞名', duration: 200, syncedLyrics: '[00:01.00]词' },
      { id: 731, trackName: '曲', artistName: '真身', duration: 205, syncedLyrics: '[00:01.00]词2' },
    ])],
    ['lyrics.kugou.com', () => J({ candidates: [] })],
  ]);
  const res = await svc.fetchExternalLyric({
    songId: 'yt_aioffpool01', title: '曲', artist: 'UP主', durationSec: 200,
  });
  // aiEnabled 前置 false——选择题一发不发（未应答）；落回逐候选核验后
  // 模型判不定按相符放行，首顺位照收（与旧「AI 是增强不是门禁」同口径）
  assert.equal(res?.extId, 'lrclib_730');
  assert.ok(!aiArgs.some((a) => /消歧助手/.test(a.system)));
});

test('具名轮不注入 choose：artistHit 约束在位——多候选照旧逐候选核验', async () => {
  aiOn = true; aiCalls = 0; aiArgs.length = 0;
  try {
    aiAnswer = { ok: true };
    reset([
      ['/youtubei/v1/next', () => nextNoTab()],
      ['lrclib.net/api/search', () => J([
        { id: 720, trackName: '曲', artistName: '艺人', duration: 200, syncedLyrics: '[00:01.00]词一' },
        { id: 721, trackName: '曲', artistName: '艺人', duration: 201, syncedLyrics: '[00:01.00]词二' },
      ])],
      ['lyrics.kugou.com', () => J({ candidates: [] })],
    ]);
    const res = await svc.fetchExternalLyric({
      songId: 'yt_namedround01', title: '曲', artist: '艺人', durationSec: 200,
    });
    assert.equal(res?.extId, 'lrclib_720');        // 首顺位盲审判过即收
    assert.equal(aiCalls, 1);
    assert.match(aiArgs[0].system, /核验助手/);    // 发的是逐候选判定题
    // 具名轮一发选择题都没打——{ok:true} 对选择题是畸形应答，若误注
    // choose 会先烧一发 消歧助手 再落回 verify，aiArgs[0] 就会是选择题
    assert.ok(!aiArgs.some((a) => /消歧助手/.test(a.system)));
  } finally { aiOn = false; aiAnswer = null; }
});

test('免时长末轮不执行具名轮：检索面 = 常规轮变体数 + 单开放轮变体数', async () => {
  const lrcQueries = [];
  const kgUrls = [];
  reset([
    ['/youtubei/v1/next', () => nextNoTab()],
    ['lrclib.net/api/search', (url) => { lrcQueries.push(decodeURIComponent(url)); return J([]); }],
    ['lyrics.kugou.com/search', (url) => { kgUrls.push(url); return J({ candidates: [] }); }],
  ]);
  const res = await svc.fetchExternalLyric({
    songId: 'yt_openround01', title: 'X／vocal', artist: 'UP主', durationSec: 60,
  });
  assert.equal(res, null);                   // 全干净 miss → null
  // 全灭才数检索面：'X／vocal' 变体 = raw + 'X' 两枚；常规轮 'UP主' + ''
  // 两轮 ×2 变体 = 4 发；末轮单开放轮再 ×2 = 6 发——旧按轮次面重扫会是
  // 8 发（'UP主' 轮在末轮再打一遍）。具名轮只在常规轮出现
  assert.equal(lrcQueries.length, 6);
  assert.equal(lrcQueries.filter((q) => q.endsWith(' UP主')).length, 2);
  assert.ok(lrcQueries.slice(4).every((q) => !q.includes('UP主')));
  assert.equal(kgUrls.filter((u) => !u.includes('duration=')).length, 2);
});

test('同题候选池进判定 prompt：排序前 8 条身份列出，未轮判的候选也在', async () => {
  aiOn = true; aiCalls = 0; aiArgs.length = 0;
  try {
    aiAnswer = { ok: true };
    reset([
      ['lrclib.net', () => J([
        { id: 910, trackName: '曲', artistName: '甲', albumName: 'A1', duration: 200, syncedLyrics: '[00:01.00]对词' },
        { id: 911, trackName: '曲', artistName: '甲乐队', albumName: 'A2', duration: 201, syncedLyrics: '[00:01.00]别词' },
      ])],
      ['lyrics.kugou.com', () => J({ candidates: [] })],
    ]);
    const res = await svc.fetchExternalLyric({
      songId: 'qq_poolprompt1', title: '曲', artist: '甲', durationSec: 200,
    });
    assert.equal(res?.extId, 'lrclib_910');  // 首顺位判过即收
    assert.equal(aiCalls, 1);
    // 911 没轮到逐候选核验，但它的条目身份已进 pool 段给判官作比较证据
    assert.match(aiArgs[0].user,
      /同题候选池（供判歧义）：\n1\. 曲 \/ 甲 \/ A1\n2\. 曲 \/ 甲乐队 \/ A2/);
    assert.match(aiArgs[0].system, /候选池若含多个同题条目/);
    assert.match(aiArgs[0].system, /来源实际所唱那首/);
  } finally { aiOn = false; aiAnswer = null; }
});

test('v4 键不复用 v2 判定：同 extId 的盲审判否 verdict 不挡 pool 语境重判', async () => {
  aiOn = true; aiCalls = 0; aiArgs.length = 0;
  try {
    // 预置「无池盲审」口径的判否 verdict（v2 键）——级联核验带 pool 走
    // v4 键不复用它：判据语境不同，判定记忆不互相命中，照发新判定
    lyricAiRepo.upsertVerdict(
      lyricVerdictKey('lrclib_950', '曲', '艺人'), 'lyric', false, 'test');
    aiAnswer = { ok: true };
    reset([
      ['lrclib.net', () => J([
        { id: 950, trackName: '曲', artistName: '艺人', duration: 200, syncedLyrics: '[00:01.00]词' },
        { id: 951, trackName: '曲', artistName: '艺人二号', duration: 201, syncedLyrics: '[00:01.00]词2' },
      ])],
      ['lyrics.kugou.com', () => J({ candidates: [] })],
    ]);
    const res = await svc.fetchExternalLyric({
      songId: 'qq_v4key00001', title: '曲', artist: '艺人', durationSec: 200,
    });
    // v2 判否若被复用，950 会被拒收续到酷狗归 null——实收证明 v4 重判
    assert.equal(res?.extId, 'lrclib_950');
    assert.equal(aiCalls, 1);
  } finally { aiOn = false; aiAnswer = null; }
});

// ── 免时长末轮 gate 收紧 / deadline 短路 / LYRIC_PROXY 接线 ──

test('免时长末轮 gate：常规轮全灭于传输故障不展开——抛 lastErr 不归 null 不固化', async () => {
  let kgLastRound = 0;
  reset([
    // lrclib 恒传输炸；酷狗常规轮（带 duration=）也炸——若末轮误展开，
    // 免时长检索（不带 duration=）会干净空回把 cleanMiss 污染成 true，
    // 尾部 lastErr && !cleanMiss 失稳归 null 被固化成 10min 负缓存
    ['lrclib.net', () => { throw new Error('lrclib 传输炸'); }],
    ['lyrics.kugou.com/search', (url) => {
      if (!url.includes('duration=')) { kgLastRound++; return J({ candidates: [] }); }
      throw new Error('kugou 传输炸');
    }],
  ]);
  const args = { songId: 'yt_gatefail001', title: 'Flamingo', artist: 'R', durationSec: 72 };
  await assert.rejects(svc.fetchExternalLyric(args), /传输炸/);
  assert.equal(kgLastRound, 0);              // 末轮一发免时长检索都没打
  const n = calls.length;
  await assert.rejects(svc.fetchExternalLyric(args), /传输炸/);
  assert.ok(calls.length > n);               // 故障不固化负缓存——重查仍打上游
});

test('免时长末轮 gate：durationSec 缺省时末轮与宽检轮逐字节同参——不重复扇出', async () => {
  const lrcQueries = [];
  reset([
    ['/youtubei/v1/next', () => nextNoTab()],
    ['lrclib.net/api/search', (url) => { lrcQueries.push(decodeURIComponent(url)); return J([]); }],
    ['lyrics.kugou.com/search', () => J({ candidates: [] })],
  ]);
  const res = await svc.fetchExternalLyric({ songId: 'yt_nodur000001', title: 'Flamingo', artist: 'R' });
  assert.equal(res, null);                   // 全干净 miss → null
  // UGC 降轮面 = 2 轮（'R' + ''）各一发检索；durationSec 缺省时常规轮
  // 本就免时长过滤，末轮同参再打纯属重复扇出
  assert.equal(lrcQueries.length, 2);
  assert.equal(calls.filter((u) => u.includes('kugou.com/search')).length, 2);
});

test('verify 吃级联 deadline：迭代中过期——候选核验判否不收录不烧 AI', async () => {
  aiOn = true; aiCalls = 0; aiArgs.length = 0;
  try {
    aiAnswer = { ok: true };    // 即便 AI 本会判过——过期判否在先，不收录也不烧 AI
    reset([
      ['lrclib.net', () => J([])],
      ['lyrics.kugou.com/search', () => J({
        candidates: [{ id: 'kd1', accesskey: 'ak1', singer: 'a', song: 'x', duration: 200000, score: 10 }],
      })],
      // download 慢回把 verify 推到 30ms 软时限之后——迭代起轮时尚未过，
      // 落到核验调用点才过期：旧码「过期短路放行」会把这条未验词直接收录，
      // 新语义判否出局（错词比没词更糟）
      ['lyrics.kugou.com/download', async () => {
        await new Promise((r) => setTimeout(r, 60));
        return J({ content: Buffer.from('[00:03.00]词一\n[00:06.00]词二').toString('base64'), charset: 'utf8' });
      }],
    ]);
    const res = await svc.fetchExternalLyric({
      songId: 'qq_vdeadline01', title: 'x', artist: 'a', durationSec: 200, deadlineMs: 30,
    });
    assert.equal(res, null);                 // 迭代中过期——判否不盲收
    assert.equal(aiCalls, 0);                // 没再起 AI 判定
    // 截断 null 不落负缓存：deadline 在末次 run() 内部耗穿（download 拖
    // 时），其后再无检查点（qq_/无时长路径不经声明轮与免时长末轮 gate）
    // ——级联尾部兜底补记 truncated。同键重查必须真打级联：若被固化成
    // 10min 负缓存会静默吃缓存 null
    const n = calls.length;
    assert.equal(await svc.fetchExternalLyric({
      songId: 'qq_vdeadline01', title: 'x', artist: 'a', durationSec: 200, deadlineMs: 30,
    }), null);
    assert.ok(calls.length > n);
  } finally { aiOn = false; aiAnswer = null; }
});

test('choose 挑中条补验落在 deadline 之后：过期判否——判死该变体不收录不烧 AI', async () => {
  aiOn = true; aiCalls = 0; aiArgs.length = 0;
  try {
    // 选择题应答本身耗穿 30ms 软时限——判官确已挑中（pick 有效应答），但
    // 补验落到核验调用点时已过期：旧码「过期短路放行」会把挑中的同题异曲
    // 零词文核验 markVerified 收录（'Boi ver.EMA'→Dina Jashari 实案形态），
    // 新语义 verify===false 判死该变体——无法核验的挑中条不收录
    aiAnswer = async (a) => {
      if (/消歧助手/.test(a.system)) {
        await new Promise((r) => setTimeout(r, 60));
        return { pick: 1 };
      }
      return { ok: true };
    };
    reset([
      ['/youtubei/v1/next', () => nextNoTab()],
      ['lrclib.net/api/search', () => J([
        { id: 960, trackName: 'Boi', artistName: 'Dina Jashari', duration: 200,
          syncedLyrics: '[00:01.00]македонски зборови' },
      ])],
      ['lyrics.kugou.com', () => J({ candidates: [] })],
    ]);
    const args = {
      songId: 'yt_pickdl00001', title: 'Boi ver.EMA', artist: 'EMA',
      durationSec: 200, deadlineMs: 30,
    };
    const res = await svc.fetchExternalLyric(args);
    assert.equal(res, null);                 // 挑中条过期判否→判死变体，不收录
    assert.equal(aiCalls, 1);                // 只烧了选择题一发——补验没再打模型
    assert.match(aiArgs[0].system, /消歧助手/);
    // 截断 null 不落负缓存——同键重查必须真打级联（若被固化会静默吃 null）
    const n = calls.length;
    await svc.fetchExternalLyric(args);
    assert.ok(calls.length > n);
  } finally { aiOn = false; aiAnswer = null; }
});

test('候选迭代吃级联 deadline：过期起轮即停——不再发 download/烧 AI', async () => {
  aiOn = true; aiCalls = 0; aiArgs.length = 0;
  try {
    aiAnswer = { ok: true };
    let kgDl = 0;
    // LRCLIB 检索慢回——候选到手时 30ms 软时限已过，逐候选迭代首轮即停，
    // verify/AI 一次不起（截断 null 不落负缓存，由级联尾部分流）
    reset([
      ['lrclib.net/api/search', async () => {
        await new Promise((r) => setTimeout(r, 60));
        return J([{ id: 901, trackName: 'x', artistName: 'a', duration: 200, syncedLyrics: '[00:01.00]迟词' }]);
      }],
      ['lyrics.kugou.com', () => J({ candidates: [] })],
    ]);
    const res = await svc.fetchExternalLyric({
      songId: 'qq_vdeadline02', title: 'x', artist: 'a', durationSec: 200, deadlineMs: 30,
    });
    assert.equal(res, null);                 // 过期截断 → null（truncated 不落负缓存）
    assert.equal(aiCalls, 0);                // 候选根本没进 verify
    // 酷狗支路同理——检索慢回时 download 一发不发（下载在候选迭代体内，
    // 外层 runRound 的 deadline 闸管不到这里）
    reset([
      ['lrclib.net/api/search', () => J([])],
      ['lyrics.kugou.com/search', async () => {
        await new Promise((r) => setTimeout(r, 60));
        return J({ candidates: [{ id: 'kd2', accesskey: 'ak2', singer: 'a', song: 'x', duration: 200000, score: 10 }] });
      }],
      ['lyrics.kugou.com/download', () => { kgDl++; return kgAll(); }],
    ]);
    const res2 = await svc.fetchExternalLyric({
      songId: 'qq_vdeadline03', title: 'x', artist: 'a', durationSec: 200, deadlineMs: 30,
    });
    assert.equal(res2, null);
    assert.equal(kgDl, 0);
    assert.equal(aiCalls, 0);
  } finally { aiOn = false; aiAnswer = null; }
});

test('LYRIC_PROXY：LRCLIB/酷狗 fetch 三面带共享 dispatcher；缺省无 dispatcher 键', async () => {
  delete process.env.LYRIC_PROXY;
  const inits = [];
  reset([
    ['lrclib.net/api/search', (url, init) => { inits.push(['lrc', init]); return J([]); }],
    ['lrclib.net/api/get', (url, init) => {
      inits.push(['lrcg', init]);
      return J({ id: 55, trackName: 'x', artistName: 'a', syncedLyrics: '[00:01.00]S' });
    }],
    ['lyrics.kugou.com/search', (url, init) => { inits.push(['kgs', init]); return J(kg); }],
    ['lyrics.kugou.com/download', (url, init) => { inits.push(['kgd', init]); return kgAll(); }],
  ]);
  // 缺省——检索/下载 init 全无 dispatcher 键（逐字节旧行为）
  await svc.fetchExternalLyric({ songId: 'qq_noproxy001', title: '曲', artist: '艺人', durationSec: 200 });
  assert.equal(inits.length, 3);             // lrc search + kg search + kg download
  assert.ok(inits.every(([, i]) => !('dispatcher' in i)));
  // env 在位——检索/下载/反查三面同携共享 ProxyAgent
  inits.length = 0;
  process.env.LYRIC_PROXY = 'http://127.0.0.1:12093';
  try {
    await svc.fetchExternalLyric({ songId: 'qq_proxy00001', title: '曲', artist: '艺人', durationSec: 200 });
    assert.equal(inits.length, 3);
    assert.ok(inits.every(([, i]) => i.dispatcher instanceof ProxyAgent));
    assert.ok(inits.every(([, i]) => i.dispatcher === inits[0][1].dispatcher)); // 同池
    inits.length = 0;
    const back = await svc.fetchByExtId('lrclib_55');
    assert.equal(back.extId, 'lrclib_55');   // 反查支路（lrclibGetById）同接线
    assert.equal(inits.length, 1);
    assert.ok(inits[0][1].dispatcher instanceof ProxyAgent);
  } finally {
    delete process.env.LYRIC_PROXY;
    lyricProxy.lyricDispatcher();            // 值变重建顺带销毁测试池
  }
});

test('lyricDispatcher：懒建缓存、值变重建销毁旧池、清除归 null；畸形/socks5 按未配置 warn 一次', () => {
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...a) => warns.push(a.map(String).join(' '));
  try {
    delete process.env.LYRIC_PROXY;
    assert.equal(lyricProxy.lyricDispatcher(), null);
    process.env.LYRIC_PROXY = 'http://127.0.0.1:12093';
    const d1 = lyricProxy.lyricDispatcher();
    assert.ok(d1 instanceof ProxyAgent);
    assert.equal(lyricProxy.lyricDispatcher(), d1);            // 懒建缓存同实例
    process.env.LYRIC_PROXY = 'http://127.0.0.1:12094';
    const d2 = lyricProxy.lyricDispatcher();
    assert.ok(d2 instanceof ProxyAgent && d2 !== d1);          // 值变重建
    assert.equal(d1.destroyed, true);                          // 旧池销毁
    delete process.env.LYRIC_PROXY;
    assert.equal(lyricProxy.lyricDispatcher(), null);          // 清除归 null
    // 畸形/scheme 非 http(s) 按未配置处理——URL 可内嵌凭据，值不落日志
    for (const bad of ['socks5://127.0.0.1:1080', 'not-a-url', 'http://']) {
      warns.length = 0;
      process.env.LYRIC_PROXY = bad;
      assert.equal(lyricProxy.lyricDispatcher(), null, bad);
      assert.equal(warns.length, 1, bad);
      assert.ok(!warns[0].includes(bad));
    }
    warns.length = 0;
    lyricProxy.lyricDispatcher();                              // 同坏值不重复刷
    assert.equal(warns.length, 0);
  } finally {
    console.warn = realWarn;
    delete process.env.LYRIC_PROXY;
    lyricProxy.lyricDispatcher();
  }
});

// ── 本家声明（yt_ 限定：头轮前反解 + 原位声明轮先于免时长末轮）──
// utaite 投稿描述里的 original:/本家: 链接反解 {title,author} 真身元数据——
// 同题异曲在元数据层不可分（'Moonlight'→moumoon/Gaulin 同名异曲、'Boi'→
// Dina Jashari 马其顿语同名歌），声明是检索侧的确定性出口。级联常规轮
// 发起前解析、一次级联至多一次——choose/verify 自首轮起携 declared
// （判官看得到「自署本家」轴：池中有本家条目选它、没有则倾向判死而非
// 乱挑）；声明轮保留原位——常规轮全灭后以本家题/名重扫，具名本家
// author 收窄池、缺席作开放轮照注 choose；跳轮条件=题同且艺人面无新
// 信息（author 缺席/占位或与来源 artist 归一相同）——题同而本家
// author 是新艺人轴仍起轮

test('本家声明轮命中：常规轮全灭 → 以本家题名具名重扫命中（解析至多一次、头轮前触发）', async () => {
  origInfoCalls.length = 0;
  const order = [];
  origInfoImpl = async ({ videoId }) => { order.push('decl'); return { videoId, title: 'Moonlight', author: 'shima' }; };
  try {
    const lrcQueries = [];
    const kgUrls = [];
    reset([
      ['/youtubei/v1/next', () => { order.push('ytm'); return nextNoTab(); }],
      ['lrclib.net/api/search', (url) => {
        order.push('lrc');
        const q = decodeURIComponent(url);
        lrcQueries.push(q);
        // 本家题检索才回真身条目——来源 'Boi ver.EMA' 检索面全 miss
        return q.includes('Moonlight') ? J([
          { id: 9901, trackName: 'Moonlight', artistName: 'shima',
            duration: 200, syncedLyrics: '[00:01.00]本家詞' },
        ]) : J([]);
      }],
      ['lyrics.kugou.com/search', (url) => { kgUrls.push(decodeURIComponent(url)); return J({ candidates: [] }); }],
    ]);
    const res = await svc.fetchExternalLyric({
      songId: 'yt_declhit0001', title: 'Boi ver.EMA', artist: 'EMA', durationSec: 200,
    });
    assert.equal(res?.extId, 'lrclib_9901');
    assert.equal(res?.meta.artist, 'shima');
    // 头轮发起前解析实锤：反解先于一切检索源调用；一次级联至多一次
    // （songId yt_ 前缀抽出的 videoId 直达反解）
    assert.equal(order[0], 'decl');
    assert.equal(origInfoCalls.length, 1);
    assert.equal(origInfoCalls[0].videoId, 'declhit0001');
    // 声明轮具名检索实锤：'Moonlight shima' 真打过——常规轮只有
    // 'Boi ver.EMA'/'Boi' × ('EMA'/'') 面（4 发），本家题检索在其后
    const decl = lrcQueries.filter((q) => q.includes('Moonlight'));
    assert.equal(decl.length, 1);
    assert.ok(decl[0].includes('shima'));
    assert.equal(lrcQueries.indexOf(decl[0]), 4);
    // lrclib 具名轮命中即收——酷狗 'Moonlight' 检索没追加（声明轮内短路）
    assert.ok(kgUrls.every((u) => !u.includes('Moonlight')));
  } finally { origInfoImpl = null; }
});

test('本家声明轮先于免时长末轮：声明检索位序在末轮免时长查询之前', async () => {
  origInfoCalls.length = 0;
  origInfoImpl = async () => ({ title: 'Boi2', author: 'shima' });
  try {
    const lrcQueries = [];
    const kgUrls = [];
    reset([
      ['/youtubei/v1/next', () => nextNoTab()],
      ['lrclib.net/api/search', (url) => { lrcQueries.push(decodeURIComponent(url)); return J([]); }],
      ['lyrics.kugou.com/search', (url) => { kgUrls.push(url); return J({ candidates: [] }); }],
    ]);
    const res = await svc.fetchExternalLyric({
      songId: 'yt_declord0001', title: 'Boi ver.EMA', artist: 'EMA', durationSec: 200,
    });
    assert.equal(res, null);                 // 声明轮也全灭 → 末轮仍展开兜底
    // 'Boi ver.EMA' 变体 2 枚：常规 'EMA'+'' 两轮 = 4 发；声明轮具名
    // 'Boi2 shima' 第 5 发；末轮免时长 '' 开放轮 2 发殿后 = 7
    assert.equal(lrcQueries.length, 7);
    assert.ok(lrcQueries[4].includes('Boi2') && lrcQueries[4].includes('shima'));
    // 声明轮酷狗检索带 duration=（时长闸在位）；末轮检索全部免时长
    assert.ok(kgUrls.some((u) => u.includes('Boi2') && u.includes('duration=')));
    assert.equal(kgUrls.filter((u) => !u.includes('duration=')).length, 2);
  } finally { origInfoImpl = null; }
});

test('本家声明轮（author 缺席/占位）：作开放轮照注 choose 整池消歧', async () => {
  aiOn = true; aiCalls = 0; aiArgs.length = 0;
  origInfoCalls.length = 0;
  origInfoImpl = async () => ({ title: '本家题', author: 'unknown' });
  try {
    aiAnswer = (a) => (/消歧助手/.test(a.system) ? { pick: 1 } : { ok: true });
    reset([
      ['/youtubei/v1/next', () => nextNoTab()],
      ['lrclib.net/api/search', (url) => {
        return decodeURIComponent(url).includes('本家题') ? J([
          { id: 9902, trackName: '本家题', artistName: '本家P',
            duration: 200, syncedLyrics: '[00:01.00]本家の詞' },
        ]) : J([]);
      }],
      ['lyrics.kugou.com', () => J({ candidates: [] })],
    ]);
    const res = await svc.fetchExternalLyric({
      songId: 'yt_declopen001', title: '別の題', artist: 'UP主', durationSec: 200,
    });
    assert.equal(res?.extId, 'lrclib_9902');
    // 占位 author 滤成 '' 走开放轮：整池选择题 + 挑中条补词文核验，
    // 两道证据与常规开放轮同构
    assert.equal(aiCalls, 2);
    assert.match(aiArgs[0].system, /消歧助手/);
    assert.match(aiArgs[0].user, /候选池：\n1\. 本家题 \/ 本家P/);
    assert.match(aiArgs[1].user, /候选条目：标题 本家题 \/ 艺人 本家P/);
  } finally { aiOn = false; aiAnswer = null; origInfoImpl = null; }
});

// 跳轮条件回归：题同作者异照起轮（旧病灶——只比标题会把新艺人轴吞掉）；
// 题同作者同/占位才跳。顺带钉 declared 自头轮起透进判定层的实参形态
test('本家声明：题同作者异 → 声明轮照起（author 是新艺人轴）；头轮判定实参即携 declared', async () => {
  aiOn = true; aiCalls = 0; aiArgs.length = 0;
  judgePoolArgs.length = 0; judgeLineArgs.length = 0;
  origInfoCalls.length = 0;
  origInfoImpl = async () => ({ title: 'Moonlight', author: 'shima' });
  try {
    // 开放轮选择题携声明后判官明言否决同题池（池中无 'shima' 条不乱挑
    // ——声明语境下倾向判死）；声明轮具名 'shima' 命中真身条补验判过。
    // 若 declared 没落进选择题 prompt（旧「常规轮全灭才解析」惰性时序），
    // 无声明应答 pick:1 会把 moumoon 条收进来露馅
    aiAnswer = (a) => (/消歧助手/.test(a.system)
      ? (a.user.includes('声明本家') ? { pick: null } : { pick: 1 })
      : { ok: a.user.includes('声明本家') });
    const lrcQueries = [];
    reset([
      ['/youtubei/v1/next', () => nextNoTab()],
      ['lrclib.net/api/search', (url) => {
        const q = decodeURIComponent(url);
        lrcQueries.push(q);
        // 声明轮具名 'Moonlight shima' 回真身条目；常规开放轮
        // 'Moonlight' 给同题异曲池（声明语境下被整池否决）；具名 'UP主' 空
        if (q.includes('shima')) return J([
          { id: 9905, trackName: 'Moonlight', artistName: 'shima',
            duration: 200, syncedLyrics: '[00:01.00]本家の詞' },
        ]);
        if (q.endsWith('q=Moonlight')) return J([
          { id: 7701, trackName: 'Moonlight', artistName: 'moumoon',
            duration: 200, syncedLyrics: '[00:01.00]moumoon詞' },
          { id: 7702, trackName: 'Moonlight', artistName: 'VY1',
            duration: 200, syncedLyrics: '[00:01.00]VY1詞' },
        ]);
        return J([]);
      }],
      ['lyrics.kugou.com', () => J({ candidates: [] })],
    ]);
    const res = await svc.fetchExternalLyric({
      songId: 'yt_declart0001', title: 'Moonlight', artist: 'UP主', durationSec: 200,
    });
    // 题归一相同不挡轮——'Moonlight shima' 具名检索实锤打过并命中
    assert.equal(res?.extId, 'lrclib_9905');
    assert.equal(res?.meta.artist, 'shima');
    assert.equal(origInfoCalls.length, 1);
    const decl = lrcQueries.filter((q) => q.includes('shima'));
    assert.equal(decl.length, 1);
    assert.ok(decl[0].includes('Moonlight'));
    assert.equal(lrcQueries.indexOf(decl[0]), 2);   // 常规两轮后第 3 发
    // 判定层实参形态：声明头轮前就位——唯一一发选择题（开放轮）与
    // 唯一一发词文核验（声明轮具名轮命中条）实参全程携 declared
    assert.equal(aiCalls, 2);
    assert.equal(judgePoolArgs.length, 1);
    assert.deepEqual(judgePoolArgs[0].declared, { title: 'Moonlight', author: 'shima' });
    assert.equal(judgeLineArgs.length, 1);
    assert.deepEqual(judgeLineArgs[0].declared, { title: 'Moonlight', author: 'shima' });
    // 自署本家行进两条判定通道的 prompt（整池选择题 + 词文核验）
    assert.match(aiArgs[0].user, /声明本家：Moonlight — shima/);
    assert.match(aiArgs[0].system, /消歧助手/);
    assert.match(aiArgs[1].user, /声明本家：Moonlight — shima/);
    assert.match(aiArgs[1].system, /核验助手|自署的本家/);
  } finally { aiOn = false; aiAnswer = null; origInfoImpl = null; }
});

test('本家声明：题同作者同 → 声明轮跳过；证据仍进末轮判定语境', async () => {
  aiOn = true; aiCalls = 0; aiArgs.length = 0;
  judgePoolArgs.length = 0; judgeLineArgs.length = 0;
  origInfoCalls.length = 0;
  origInfoImpl = async () => ({ title: 'Moonlight', author: 'shima' });
  try {
    aiAnswer = (a) => (/消歧助手/.test(a.system) ? { pick: 1 } : { ok: true });
    let moonOpen = 0;
    const lrcQueries = [];
    reset([
      ['/youtubei/v1/next', () => nextNoTab()],
      ['lrclib.net/api/search', (url) => {
        const q = decodeURIComponent(url);
        lrcQueries.push(q);
        // 常规开放轮（含时长闸）miss，末轮免时长同词重扫回同题池——
        // 同名查询两入两出按序分派
        if (q.endsWith('q=Moonlight')) {
          moonOpen += 1;
          return moonOpen >= 2 ? J([
            { id: 8801, trackName: 'Moonlight', artistName: 'moumoon',
              duration: 200, syncedLyrics: '[00:01.00]moumoon詞' },
            { id: 8802, trackName: 'Moonlight', artistName: 'VY1',
              duration: 200, syncedLyrics: '[00:01.00]VY1詞' },
          ]) : J([]);
        }
        return J([]);
      }],
      ['lyrics.kugou.com', () => J({ candidates: [] })],
    ]);
    const res = await svc.fetchExternalLyric({
      // 来源 artist 即本家 author——艺人轴已被常规具名轮覆盖，声明轮
      // 是纯重复（即便跑了检索面去重也使查询面等值，此断言钉的是「不
      // 追加任何检索面」这一可观测口径）
      songId: 'yt_declsame002', title: 'Moonlight', artist: 'shima', durationSec: 200,
    });
    assert.equal(res?.extId, 'lrclib_8801');
    assert.equal(origInfoCalls.length, 1);
    // 全程只有 具名'Moonlight shima' + 开放'Moonlight' + 末轮免时长
    // 'Moonlight' = 3 发——声明轮零追加
    assert.equal(lrcQueries.length, 3);
    assert.equal(lrcQueries.filter((q) => q.includes('shima')).length, 1);
    // 声明轮跳过不影响语境——declaredNow 头轮前已置位：末轮 choose/verify
    // 实参携声明
    assert.equal(judgePoolArgs.length, 1);
    assert.deepEqual(judgePoolArgs[0].declared, { title: 'Moonlight', author: 'shima' });
    assert.deepEqual(judgeLineArgs.at(-1).declared, { title: 'Moonlight', author: 'shima' });
    // 自署本家行进两条判定通道的 prompt（整池选择题 + 词文核验）
    assert.ok(aiArgs.some((a) => /消歧助手/.test(a.system)
      && a.user.includes('声明本家：Moonlight — shima')));
    assert.ok(aiArgs.some((a) => /核验助手/.test(a.system)
      && a.user.includes('声明本家：Moonlight — shima')));
  } finally { aiOn = false; aiAnswer = null; origInfoImpl = null; }
});

test('本家声明证据自头轮入判定语境：开放轮 choose/verify 携 declared 挑中本家条即收', async () => {
  aiOn = true; aiCalls = 0; aiArgs.length = 0;
  judgePoolArgs.length = 0; judgeLineArgs.length = 0;
  origInfoCalls.length = 0;
  origInfoImpl = async () => ({ title: 'Moonlight', author: 'shima' });
  try {
    // 声明语境下的选择题指中本家条（索引 2）；无声明语境挑首顺位
    // moumoon——declared 没到头轮判定层就收错条露馅
    aiAnswer = (a) => (/消歧助手/.test(a.system)
      ? (a.user.includes('声明本家') ? { pick: 2 } : { pick: 1 })
      : { ok: a.user.includes('声明本家') });
    const lrcQueries = [];
    reset([
      ['/youtubei/v1/next', () => nextNoTab()],
      ['lrclib.net/api/search', (url) => {
        lrcQueries.push(decodeURIComponent(url));
        // 常规开放轮（±15s 时长闸在位）同题异曲池——声明语境下判官
        // 一发选择题直接指中本家条，级联在开放轮即收
        if (decodeURIComponent(url).endsWith('q=Moonlight')) return J([
          { id: 8801, trackName: 'Moonlight', artistName: 'moumoon',
            duration: 200, syncedLyrics: '[00:01.00]moumoon詞' },
          { id: 8802, trackName: 'Moonlight', artistName: 'shima',
            duration: 200, syncedLyrics: '[00:01.00]本家の詞' },
        ]);
        return J([]);
      }],
      ['lyrics.kugou.com', () => J({ candidates: [] })],
    ]);
    const res = await svc.fetchExternalLyric({
      songId: 'yt_declctx0001', title: 'Moonlight', artist: 'UP主', durationSec: 200,
    });
    assert.equal(res?.extId, 'lrclib_8802');
    assert.equal(res?.meta.artist, 'shima');
    // 具名 'UP主' + 开放 'Moonlight' 两发即收——声明轮/末轮都不再需要
    assert.equal(lrcQueries.length, 2);
    // 头轮起的判定实参全程携 declared：选择题与挑中条词文核验各一发
    assert.equal(aiCalls, 2);
    assert.equal(judgePoolArgs.length, 1);
    assert.deepEqual(judgePoolArgs[0].declared, { title: 'Moonlight', author: 'shima' });
    assert.equal(judgeLineArgs.length, 1);
    assert.deepEqual(judgeLineArgs[0].declared, { title: 'Moonlight', author: 'shima' });
    assert.match(aiArgs[0].user, /声明本家：Moonlight — shima/);
    assert.match(aiArgs[1].user, /声明本家：Moonlight — shima/);
  } finally { aiOn = false; aiAnswer = null; origInfoImpl = null; }
});

test('声明语境头轮就位 e2e（Moonlight ver.EMA 实案）：开放轮同题池按自署本家挑 VY1——Gaulin 同名异曲不再错收', async () => {
  aiOn = true; aiCalls = 0; aiArgs.length = 0;
  judgePoolArgs.length = 0; judgeLineArgs.length = 0;
  origInfoCalls.length = 0;
  origInfoImpl = async () => ({ title: 'Moonlight', author: 'shima' });
  try {
    // 实案回放：yt_xuFgAqSU4dE 开放轮 strictTitle 池里 Gaulin 英文同名
    // 异曲曾被 pick+verify 连过收单（lrclib_37347988）——声明 {shima}
    // 根本没到场，判官在无证据语境下对同题池做了选择。新时序头轮判定
    // 即携「自署本家：Moonlight — shima」：选择题指中 VY1 本家条；
    // declared 没落进 prompt 则无声明应答 pick:1 回首顺位 Gaulin 露馅
    aiAnswer = (a) => (/消歧助手/.test(a.system)
      ? (a.user.includes('声明本家') ? { pick: 2 } : { pick: 1 })
      : { ok: a.user.includes('候选条目：标题 Moonlight / 艺人 VY1') });
    reset([
      ['/youtubei/v1/next', () => nextNoTab()],
      ['lrclib.net/api/search', (url) => {
        if (decodeURIComponent(url).includes('Moonlight')) return J([
          { id: 37347988, trackName: 'Moonlight', artistName: 'Gaulin',
            duration: 200, syncedLyrics: '[00:01.00]english words' },
          { id: 37347999, trackName: 'Moonlight', artistName: 'VY1',
            duration: 200, syncedLyrics: '[00:01.00]本家の詞' },
        ]);
        return J([]);
      }],
      ['lyrics.kugou.com', () => J({ candidates: [] })],
    ]);
    const res = await svc.fetchExternalLyric({
      // author='_' 占位：首轮即无艺人约束开放轮——choose 在头轮就注
      songId: 'yt_xuFgAqSU4dE', title: 'Moonlight ver.EMA', artist: '_', durationSec: 200,
    });
    assert.equal(res?.extId, 'lrclib_37347999');   // 本家条——不是 Gaulin 同名异曲
    assert.equal(res?.meta.artist, 'VY1');
    // 声明实锤头轮前解析：一轮选择题 + 挑中条词文核验实参全程携 declared
    assert.equal(origInfoCalls.length, 1);
    assert.equal(origInfoCalls[0].videoId, 'xuFgAqSU4dE');
    assert.equal(aiCalls, 2);
    assert.equal(judgePoolArgs.length, 1);
    assert.deepEqual(judgePoolArgs[0].declared, { title: 'Moonlight', author: 'shima' });
    assert.equal(judgeLineArgs.length, 1);
    assert.deepEqual(judgeLineArgs[0].declared, { title: 'Moonlight', author: 'shima' });
    assert.match(aiArgs[0].user, /声明本家：Moonlight — shima/);
    assert.match(aiArgs[1].user, /声明本家：Moonlight — shima/);
  } finally { aiOn = false; aiAnswer = null; origInfoImpl = null; }
});

test('vkey 声明位 e2e：无声明语境落的判否 verdict 不被声明语境重进复用——同 extId 换键重判', async () => {
  aiOn = true; aiCalls = 0; aiArgs.length = 0;
  judgePoolArgs.length = 0; judgeLineArgs.length = 0;
  origInfoCalls.length = 0;
  origInfoImpl = async () => ({ title: 'DeclKey', author: '本家P' });
  try {
    // 病灶回放：无声明语境的旧级联对同 extId 落过 ok:false（v4 盐、无
    // 声明位）。声明到场后同条目重进核验——若不分键，旧 verdict 直接
    // 命中判死、自署证据根本没机会进判。预置无声明键的判否 verdict
    lyricAiRepo.upsertVerdict(
      lyricVerdictKey('lrclib_8892', 'DeclKey', 'DKUP', true), 'lyric', false, 'test');
    // 开放轮选择题指中本家条、词文核验判过——若 verify 侧没分键，8892
    // 会吃旧判否 verdict 判死变体归 null（v4d2 键不命中 v4 行才走到判定）
    aiAnswer = (a) => (/消歧助手/.test(a.system) ? { pick: 2 } : { ok: true });
    reset([
      ['/youtubei/v1/next', () => nextNoTab()],
      ['lrclib.net/api/search', (url) => {
        // 具名 'DKUP' 轮查询带艺人尾不进此分支（endsWith 不咬）；
        // '' 开放轮 'q=DeclKey' 回同题池
        if (decodeURIComponent(url).endsWith('q=DeclKey')) return J([
          { id: 8891, trackName: 'DeclKey', artistName: 'moumoon',
            duration: 200, syncedLyrics: '[00:01.00]moumoon詞' },
          { id: 8892, trackName: 'DeclKey', artistName: '本家P',
            duration: 200, syncedLyrics: '[00:01.00]本家の詞' },
        ]);
        return J([]);
      }],
      ['lyrics.kugou.com', () => J({ candidates: [] })],
    ]);
    const res = await svc.fetchExternalLyric({
      songId: 'yt_declvkey001', title: 'DeclKey', artist: 'DKUP', durationSec: 200,
    });
    assert.equal(res?.extId, 'lrclib_8892');   // 无声明判否没挡住声明语境重判
    assert.equal(aiCalls, 2);                  // 选择题 + 挑中条词文核验各一发
    // 判定键实锤携声明位：与「无声明同参」键不同、与携声明手算键逐位同
    assert.equal(judgeLineArgs.length, 1);
    assert.equal(judgeLineArgs[0].vkey,
      lyricVerdictKey('lrclib_8892', 'DeclKey', 'DKUP', true, true));
    assert.notEqual(judgeLineArgs[0].vkey,
      lyricVerdictKey('lrclib_8892', 'DeclKey', 'DKUP', true));
  } finally { aiOn = false; aiAnswer = null; origInfoImpl = null; }
});

test('本家声明：反解故障/无声明/超时 → 静默走原路径不炸不误时', async () => {
  const missTable = () => [
    ['/youtubei/v1/next', () => nextNoTab()],
    ['lrclib.net', () => J([])],
    ['lyrics.kugou.com', () => J({ candidates: [] })],
  ];
  // 反解抛错（头轮前 eager 解析点炸）→ 按无声明处理：级联照常跑检索
  // 路径、归 null 不炸
  origInfoCalls.length = 0;
  origInfoImpl = async () => { throw new Error('本家反解传输炸'); };
  try {
    reset(missTable());
    const res = await svc.fetchExternalLyric({
      songId: 'yt_declerr0001', title: 'Boi ver.EMA', artist: 'EMA', durationSec: 200,
    });
    assert.equal(res, null);
    assert.equal(origInfoCalls.length, 1);
    // 失败后检索路径照展开——反解故障不吞常规轮
    assert.ok(calls.some((u) => u.includes('lrclib.net')));
    assert.ok(calls.some((u) => u.includes('kugou')));
  } finally { origInfoImpl = null; }

  // 无声明（impl=null 默认桩回 null）→ 原路径干净 miss
  origInfoCalls.length = 0;
  reset(missTable());
  const res2 = await svc.fetchExternalLyric({
    songId: 'yt_declnull001', title: 'Boi ver.EMA', artist: 'EMA', durationSec: 200,
  });
  assert.equal(res2, null);
  assert.equal(origInfoCalls.length, 1);

  // 反解超时（impl 挂起不吃 signal）→ race 兜底按 deadline 归 null，
  // 不拖穿级联软时限；反解计入 deadline——60ms 软时限被反解吃满后
  // 常规轮一记 deadlineHit 截断，上游检索一发不打
  origInfoCalls.length = 0;
  origInfoImpl = () => new Promise(() => {});    // 永不落地
  try {
    reset(missTable());
    const t0 = Date.now();
    const res3 = await svc.fetchExternalLyric({
      songId: 'yt_declslow001', title: 'Boi ver.EMA', artist: 'EMA',
      durationSec: 200, deadlineMs: 60,
    });
    assert.equal(res3, null);
    assert.ok(Date.now() - t0 < 5000);           // 没被挂起 impl 拖死
    assert.equal(origInfoCalls.length, 1);
    assert.equal(calls.length, 0);               // 软时限被反解吃满——零检索
  } finally { origInfoImpl = null; }
});

test('本家声明解析限 yt_：首轮命中也已付头轮前解析成本；qq_/bv_ 永不解析', async () => {
  origInfoCalls.length = 0;
  origInfoImpl = async () => ({ title: '本家题', author: 'shima' });
  try {
    reset([
      ['/youtubei/v1/next', () => nextOk('MPLYt_decl')],
      ['/youtubei/v1/browse', () => browseOk()],
    ]);
    const res = await svc.fetchExternalLyric({
      songId: 'yt_decllazy001', title: '曲', artist: '艺人',
    });
    assert.equal(res.source, 'ytm');             // 常规首轮命中即返
    // yt_ 级联头轮发起前必解析——首轮命中不省这 +2 跳成本（判定语境
    // 自首轮就位的前提）
    assert.equal(origInfoCalls.length, 1);

    // 曲库/bv_ 全灭也不解析——声明证据只服务 yt_ 投稿
    reset([
      ['lrclib.net', () => J([])],
      ['lyrics.kugou.com', () => J({ candidates: [] })],
    ]);
    assert.equal(await svc.fetchExternalLyric({
      songId: 'qq_declnone001', title: '曲', artist: '艺人', durationSec: 200,
    }), null);
    assert.equal(await svc.fetchExternalLyric({
      songId: 'bv_BV1xx411c7mD', title: '曲', artist: '艺人', durationSec: 200,
    }), null);
    assert.equal(origInfoCalls.length, 1);       // 非 yt_ 零调用
  } finally { origInfoImpl = null; }
});

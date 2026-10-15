// 手选候选池（services/lyric-external.searchLyricCandidates +
// routes/lyric-manual 的 GET /lyric/candidates）钉测：
//   · lrclib 候选归一：extId 前缀/synced/preview 剥 [mm:ss] 与 [tag:] 元行、
//     ≤80 字截断、album/durationSec 透出
//   · kugou 候选：token=accesskey 原样透回（pick 唯一取词凭证）、preview
//     恒 ''（逐条 download 不付扇出）、时长毫秒→秒归一
//   · 宽检无闸：同名异曲/艺人不符/超 ±15s 窗的条目都留池——用户终审
//   · 排序：时长差升序（null 殿后）→ 源序 lrclib→kugou→ytm；无时长时纯
//     源序；总池截 12
//   · 源故障隔离：一源炸不翻整池（warn + 继续）
//   · ytm 支路：yt_ id 才挂候选，取词失败静默略
//   · fetchByExtId kugou 通道：token=accesskey 直达 download；缺/脏 token
//     归 null 且零上游调用
// globalThis.fetch 按 URL 子串分发到各源桩——不打真网络。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { seed, tmpDataDir, getJson } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-lyrcand-');
const require = createRequire(import.meta.url);

// AI 层桩——lyric-external require 链挂着 lib/ai（级联核验面）；候选池
// 不经核验，桩成恒关即可
seed('../src/server/lib/ai.js', {
  aiEnabled: () => false,
  aiModel: () => 'test-model',
  askAiJson: async () => null,
});

const svc = require('../src/server/services/lyric-external.js');
const app = require('../src/server/routes/lyric-manual.js');

// ── fetch 桩：URL 子串分发；calls 记全量上行 ──
const calls = [];
let handler = async () => new Response('{}', { status: 404 });
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  calls.push(url);
  return handler(url, init || {});
};
after(() => { globalThis.fetch = realFetch; });
after(() => { rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

const J = (obj, status = 200, headers) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json', ...(headers || {}) },
});
const dispatch = (table) => async (url, init) => {
  for (const [match, fn] of table) {
    if (url.includes(match)) return fn(url, init);
  }
  return J({ err: 'unhandled' }, 404);
};
const reset = (table) => { calls.length = 0; handler = dispatch(table); svc._clearCache(); };

const LRCLIB_SYNCED = '[ti:词题]\n[ar:词人]\n[00:01.00]第一行词文\n[00:02.00]第二行词文\n[00:03.00]第三行';
const KG_LRC = '[00:03.00]狗词一\n[00:06.00]狗词二';
const kgDownload = () => J({ content: Buffer.from(KG_LRC).toString('base64'), charset: 'utf8' });
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
const browseOk = () => J({
  contents: { x: { timedLyricsModel: { lyricsData: { timedLyricsData: [
    { lyricLine: 'yt词一行', cueRange: { startTimeMilliseconds: 1000 } },
    { lyricLine: 'yt词二行', cueRange: { startTimeMilliseconds: 2000 } },
  ] } } } },
});

test('候选归一：lrclib extId/preview 剥戳剥元行/synced；kugou token 透回 preview 空', async () => {
  reset([
    ['lrclib.net/api/search', () => J([
      { id: 7, trackName: '曲', artistName: '艺人', albumName: '专辑', duration: 200,
        syncedLyrics: LRCLIB_SYNCED, plainLyrics: '纯文本底' },
      { id: 8, trackName: '曲', artistName: '艺人', duration: 200, plainLyrics: '只有纯文本' },
      { id: 9, trackName: '曲', artistName: '艺人', duration: 200, instrumental: true },
      { id: 10, trackName: '曲', artistName: '艺人', duration: 200 },  // 无词文行——剥
    ])],
    ['lyrics.kugou.com/search', () => J({
      candidates: [
        { id: 'k1', accesskey: 'ak-1', singer: '艺人', song: '曲', duration: 205000, score: 90 },
        { id: 'k2', singer: '艺人', song: '曲' },  // 缺 accesskey——剥
      ],
    })],
  ]);
  const list = await svc.searchLyricCandidates({ songId: '880001', title: '曲', artist: '艺人' });
  const lb = list.filter(c => c.source === 'lrclib');
  assert.equal(lb.length, 2);                       // instrumental 与无词行剥掉
  assert.equal(lb[0].extId, 'lrclib_7');
  assert.equal(lb[0].synced, true);
  assert.equal(lb[0].album, '专辑');
  assert.equal(lb[0].durationSec, 200);
  assert.equal(lb[0].preview, '第一行词文 / 第二行词文');  // 剥 [ti:]/[ar:] 元行与时间戳
  assert.equal(lb[1].extId, 'lrclib_8');
  assert.equal(lb[1].synced, false);
  assert.equal(lb[1].preview, '只有纯文本');
  const kg = list.filter(c => c.source === 'kugou');
  assert.equal(kg.length, 1);                       // 缺 accesskey 的剥掉
  assert.equal(kg[0].extId, 'kugou_k1');
  assert.equal(kg[0].token, 'ak-1');                // accesskey 原样透回
  assert.equal(kg[0].preview, '');
  assert.equal(kg[0].synced, false);
  assert.equal(kg[0].durationSec, 205);             // 毫秒→秒归一
  assert.ok(!('_diff' in kg[0]) && !('_diff' in lb[0])); // 内部排序键不透出
});

test('宽检无闸：同名异曲/艺人不符/超 ±15s 窗都留池（级联的闸摘掉）', async () => {
  reset([
    ['lrclib.net/api/search', () => J([
      // 同名异曲（标题闸在级联侧会拒）、艺人不符（artistHit 硬滤会拒）、
      // 超窗（durationSec=200 vs 400 差 200s>15s）——候选池全收
      { id: 1, trackName: '完全不同的撞名歌', artistName: '别人', duration: 400, syncedLyrics: '[00:01.00]A' },
      { id: 2, trackName: '曲', artistName: '艺人', duration: 200, syncedLyrics: '[00:01.00]B' },
    ])],
    ['lyrics.kugou.com/search', () => J({ candidates: [] })],
  ]);
  const list = await svc.searchLyricCandidates({ songId: '880002', title: '曲', artist: '艺人', durationSec: 200 });
  assert.deepEqual(list.map(c => c.extId), ['lrclib_2', 'lrclib_1']);  // 差值序：200 差 0 先、400 差 200 后
});

test('排序：时长差升序 null 殿后 → 源序决胜；无时长声明时纯源序', async () => {
  const lrc = (id, dur) => ({ id, trackName: '曲', artistName: '艺人', duration: dur, syncedLyrics: '[00:01.00]X' });
  const kg = (id, dur) => ({ id, accesskey: `ak${id}`, singer: '艺人', song: '曲', duration: dur });
  reset([
    ['/youtubei/v1/next', () => nextOk('MPLYt_c1')],
    ['/youtubei/v1/browse', () => browseOk()],
    ['lrclib.net/api/search', () => J([lrc('l_far', 300), lrc('l_near', 210), lrc('l_nodur')])],
    ['lyrics.kugou.com/search', () => J({ candidates: [kg('k_near', 202000), kg('k_nodur', null)] })],
  ]);
  const list = await svc.searchLyricCandidates({
    songId: 'yt_abcdefghijk', title: '曲', artist: '艺人', durationSec: 200,
  });
  assert.deepEqual(list.map(c => c.extId), [
    'kugou_k_near',   // diff 2
    'lrclib_l_near',  // diff 10
    'lrclib_l_far',   // diff 100
    'lrclib_l_nodur', // null 殿后，同源内保上游序——先于 kugou null
    'kugou_k_nodur',  // null + 源序 kugou
    'ytm_abcdefghijk',// null + 源序 ytm
  ]);

  // 不声明时长：diff 全 null → 纯源序 lrclib→kugou→ytm（各源内保上游序）
  const list2 = await svc.searchLyricCandidates({ songId: 'yt_abcdefghijk', title: '曲', artist: '艺人' });
  assert.deepEqual(list2.map(c => c.extId), [
    'lrclib_l_far', 'lrclib_l_near', 'lrclib_l_nodur',
    'kugou_k_near', 'kugou_k_nodur',
    'ytm_abcdefghijk',
  ]);
});

test('源故障隔离：lrclib 传输炸不翻池——kugou 候选照常返回', async () => {
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a.map(String).join(' '));
  try {
    reset([
      ['lrclib.net', () => J({}, 500)],   // 5xx 重试一次仍死 → 抛错被池吞掉
      ['lyrics.kugou.com/search', () => J({
        candidates: [{ id: 'k9', accesskey: 'ak9', singer: '艺人', song: '曲', duration: 200000 }],
      })],
    ]);
    const list = await svc.searchLyricCandidates({ songId: '880003', title: '曲', artist: '艺人' });
    assert.deepEqual(list.map(c => c.extId), ['kugou_k9']);
    assert.ok(warns.some(l => /候选池 lrclib 源失败/.test(l)));
    // 真打过 lrclib（含 5xx 重试一跳）——隔离不是跳过
    assert.ok(calls.filter(u => u.includes('lrclib.net')).length >= 1);
  } finally { console.warn = origWarn; }
});

test('ytm 支路：yt_ id 挂候选带真词 preview；取词失败/非 yt_ 静默略', async () => {
  reset([
    ['/youtubei/v1/next', () => nextOk('MPLYt_c2')],
    ['/youtubei/v1/browse', () => browseOk()],
    ['lrclib.net', () => J([])],
    ['lyrics.kugou.com', () => J({ candidates: [] })],
  ]);
  const list = await svc.searchLyricCandidates({ songId: 'yt_vidcand001x', title: '曲', artist: '艺人' });
  assert.equal(list.length, 1);
  assert.equal(list[0].extId, 'ytm_vidcand001x');
  assert.equal(list[0].source, 'ytm');
  assert.equal(list[0].synced, true);
  assert.equal(list[0].preview, 'yt词一行 / yt词二行');

  // ytm 取词失败（无歌词 tab）→ 候选静默略，池空但 200 面
  reset([
    ['music.youtube.com', () => J({ contents: {} })],
    ['lrclib.net', () => J([])],
    ['lyrics.kugou.com', () => J({ candidates: [] })],
  ]);
  const list2 = await svc.searchLyricCandidates({ songId: 'yt_nolyric0001', title: '曲', artist: '艺人' });
  assert.equal(list2.length, 0);

  // 非 yt_ id → 不打 YTM 上行（next 都不发）
  reset([
    ['lrclib.net', () => J([])],
    ['lyrics.kugou.com', () => J({ candidates: [] })],
  ]);
  await svc.searchLyricCandidates({ songId: '880004', title: '曲', artist: '艺人' });
  assert.ok(!calls.some(u => u.includes('music.youtube.com')));
});

test('截 12：跨源候选池溢出按排序键截断', async () => {
  const lrcRows = Array.from({ length: 9 }, (_, i) => ({
    id: i + 1, trackName: '曲', artistName: '艺人', duration: 200 + i, syncedLyrics: '[00:01.00]X',
  }));
  const kgRows = Array.from({ length: 6 }, (_, i) => ({
    id: `k${i}`, accesskey: `ak${i}`, singer: '艺人', song: '曲', duration: (250 + i) * 1000,
  }));
  reset([
    ['lrclib.net/api/search', () => J(lrcRows)],
    ['lyrics.kugou.com/search', () => J({ candidates: kgRows })],
  ]);
  const list = await svc.searchLyricCandidates({ songId: '880005', title: '曲', artist: '艺人', durationSec: 200 });
  assert.equal(list.length, 12);            // 9+6=15 → 截 12
  assert.equal(list[0].extId, 'lrclib_1');  // 差 0 最小在前
});

test('preview ≤80 字截断；纯时间戳行无词文时归空', async () => {
  const long = '长'.repeat(100);
  reset([
    ['lrclib.net/api/search', () => J([
      { id: 1, trackName: '曲', artistName: 'a', duration: 200, syncedLyrics: `[00:01.00]${long}` },
    ])],
    ['lyrics.kugou.com', () => J({ candidates: [] })],
  ]);
  const list = await svc.searchLyricCandidates({ songId: '880006', title: '曲', artist: 'a' });
  assert.equal(list[0].preview.length, 80);
  assert.equal(list[0].preview, '长'.repeat(80));
});

test('fetchByExtId kugou 通道：token=accesskey 直达 download；缺/脏 token 归 null 零上行', async () => {
  reset([['lyrics.kugou.com/download', () => kgDownload()]]);
  const hit = await svc.fetchByExtId('kugou_k55', { token: 'ak-9' });
  assert.equal(hit.source, 'kugou');
  assert.equal(hit.extId, 'kugou_k55');
  assert.equal(hit.synced, true);
  assert.match(hit.lrc, /狗词一/);
  const dl = calls.find(u => u.includes('download'));
  assert.ok(dl.includes('id=k55'));
  assert.ok(dl.includes('accesskey=ak-9'));

  // 缺 token：归 null 且不打任何上游（LRU 已清）
  calls.length = 0;
  assert.equal(await svc.fetchByExtId('kugou_k55'), null);
  assert.equal(calls.length, 0);
  // 脏 token（带查询串字符）：同样拒收零上行
  assert.equal(await svc.fetchByExtId('kugou_k55', { token: 'ak&debug=1' }), null);
  assert.equal(calls.length, 0);
  // download 回非 lrc 载荷 → null
  reset([['lyrics.kugou.com/download', () => J({ content: 'a3JjMQ==', fmt: 'krc' })]]);
  assert.equal(await svc.fetchByExtId('kugou_k9', { token: 'ak9' }), null);
});

// ── 路由面：GET /lyric/candidates 入参闸与形状 ──

test('路由 /lyric/candidates：无 id 无 title → 400；脏 id → 400；命中形状', async () => {
  assert.equal((await getJson(app, '/lyric/candidates')).status, 400);          // 无米下锅
  assert.equal((await getJson(app, '/lyric/candidates?id=!!bad!!')).status, 400);
  assert.equal((await getJson(app, `/lyric/candidates?id=880007&title=${'t'.repeat(301)}`)).status, 400); // title 超长
  // 有 id 无 title 合法（require id OR title）——检索词空时两检索源快返空池
  reset([
    ['lrclib.net', () => J([])],
    ['lyrics.kugou.com', () => J({ candidates: [] })],
  ]);
  const bareId = await getJson(app, '/lyric/candidates?id=880007');
  assert.equal(bareId.status, 200);
  assert.deepEqual(bareId.body.candidates, []);
  assert.ok(!calls.length);   // 无检索词零上行
  // 命中形状：{code:200, candidates:[{extId,source,title,artist,synced,preview,...}]}
  reset([
    ['lrclib.net/api/search', () => J([
      { id: 42, trackName: '曲', artistName: '艺人', duration: 200, syncedLyrics: LRCLIB_SYNCED },
    ])],
    ['lyrics.kugou.com', () => J({ candidates: [] })],
  ]);
  const ok = await getJson(app, `/lyric/candidates?id=880008&title=${encodeURIComponent('曲')}&artist=${encodeURIComponent('艺人')}&duration=200`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.code, 200);
  assert.equal(ok.body.candidates.length, 1);
  assert.equal(ok.body.candidates[0].extId, 'lrclib_42');
  assert.equal(ok.body.candidates[0].preview, '第一行词文 / 第二行词文');
});

test('伞自裁不误穿透：源抛 .aborted 而调用方信号存活 → 灭一角留余池（服务与路由同口径）', async () => {
  // 复刻伞时限在源内掐醒的形态（如 lrclib Retry-After 的 abortableSleep
  // 被 15s 伞信号拒醒）：带 .aborted 标记的拒包——但调用方 signal 从头
  // 到尾存活。穿透判定只看调用方信号，不看 e.aborted
  reset([
    ['lrclib.net', () => Promise.reject(Object.assign(new Error('已取消'), { aborted: true }))],
    ['lyrics.kugou.com/search', () => J({
      candidates: [{ id: 'k8', accesskey: 'ak8', singer: '艺人', song: '曲', duration: 200000 }],
    })],
  ]);
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a.map(String).join(' '));
  let list;
  try {
    const ac = new AbortController();
    list = await svc.searchLyricCandidates({
      songId: '880009', title: '曲', artist: '艺人', signal: ac.signal,
    });
  } finally { console.warn = origWarn; }
  assert.deepEqual(list.map(c => c.extId), ['kugou_k8']); // lrclib 灭一角，kugou 池照常端出
  assert.ok(warns.some(l => /候选池 lrclib 源失败/.test(l)), '伞醒该留 warn 痕而非穿透');
  // 路由面同口径：源内 abort + 客户端仍连接 → 200 部分池而非 499
  const viaRoute = await getJson(app,
    `/lyric/candidates?id=880010&title=${encodeURIComponent('曲')}&artist=${encodeURIComponent('艺人')}`);
  assert.equal(viaRoute.status, 200);
  assert.deepEqual(viaRoute.body.candidates.map(c => c.extId), ['kugou_k8']);
});

test('调用方真断连仍穿透：源挂起被掐 + 调用方 signal 已 abort → 抛 aborted', async () => {
  reset([
    // 源挂起直到伞信号（含调用方信号成分）被掐——真 fetch/abortableSleep 同款
    ['lrclib.net', (url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () =>
        reject(Object.assign(new Error('aborted'), { aborted: true })), { once: true });
    })],
    ['lyrics.kugou.com/search', () => J({ candidates: [] })],
  ]);
  const ac = new AbortController();
  const p = svc.searchLyricCandidates({
    songId: '880011', title: '曲', artist: '艺人', signal: ac.signal,
  });
  await new Promise(r => setTimeout(r, 10)); // 让 lrclib 支路入挂起点
  ac.abort();
  await assert.rejects(p, (e) => e?.aborted === true);
});

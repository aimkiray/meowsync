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

// ── 形态展开（变体 × 艺人降轮）——yt_ 翻唱曲恒空修复钉板 ──
// 检索词不再是 cleanQueryTitle 单形态：与级联同构的 titleVariantsOf ×
// artistRounds 按序逐发、extId 首现者胜、烙 _form 进排序键（特异性先于
// 时长差）、池满 ≥12 早停；扇出节流双闸——召回地板（池 ≥4 后最多再宽采
// 1 个形态）+ 形态硬顶 6；形态中途失败降级部分池、首形态即炸维持「源失败
// warn+[]」旧语义。
const qOf = (u, key) => decodeURIComponent(u.match(new RegExp(`[?&]${key}=([^&]*)`))?.[1] || '');
const lrclibQs = () => calls.filter(u => u.includes('lrclib.net/api/search')).map(u => qOf(u, 'q'));
const kugouQs = () => calls.filter(u => u.includes('lyrics.kugou.com/search')).map(u => qOf(u, 'keyword'));

test('yt_ 翻唱曲形态展开：原形态恒空 → 剥缀变体 + 裸艺人轮命中', async () => {
  const row = (id) => ({
    id, trackName: '楽園', artistName: '本家艺人', duration: 200,
    syncedLyrics: '[00:01.00]楽園の詞一行',
  });
  reset([
    // 实案回放：'楽園 ver.EMA EMA' 0 条；只有剥到 '楽園' 裸标题才出真身
    ['lrclib.net/api/search', (url) => J(qOf(url, 'q') === '楽園' ? [row(101), row(102)] : [])],
    ['lyrics.kugou.com/search', () => J({ candidates: [] })],
    ['music.youtube.com', () => J({ contents: {} })],   // ytm 支路无词 tab 静默略
  ]);
  const list = await svc.searchLyricCandidates({
    songId: 'yt_rakuen01234', title: '楽園 ver.EMA', artist: 'EMA', durationSec: 200,
  });
  assert.deepEqual(list.map(c => c.extId), ['lrclib_101', 'lrclib_102']);
  // 形态序 = 变体外圈 × 艺人轮内圈：'楽園 ver.EMA' 配 ['EMA','']（UGC 降轮
  // artistFromTitle 剥不出→归并入 ''），再轮到剥缀变体 '楽園'
  assert.deepEqual(lrclibQs(), [
    '楽園 ver.EMA EMA', '楽園 ver.EMA', '楽園 EMA', '楽園',
  ]);
  // 内部排序键不透出 API 面
  assert.ok(list.every(c => !('_form' in c) && !('_diff' in c)));
});

test('跨形态 extId 去重：首现者胜（降轮重复命中不重复进池）', async () => {
  const row = (id, dur) => ({
    id, trackName: '平原曲', artistName: '艺人', duration: dur, syncedLyrics: '[00:01.00]X',
  });
  reset([
    ['lrclib.net/api/search', (url) => J(qOf(url, 'q') === '平原曲 艺人'
      ? [row(1, 200), row(2, 210)]
      : [row(2, 210), row(3, 205)])],   // 裸轮重复命中 id2
    ['lyrics.kugou.com/search', () => J({ candidates: [] })],
  ]);
  const list = await svc.searchLyricCandidates({
    songId: '880020', title: '平原曲', artist: '艺人', durationSec: 200,
  });
  // id2 只留 form0 那份；id3 是裸轮新增（_form=1 殿后）
  assert.deepEqual(list.map(c => c.extId), ['lrclib_1', 'lrclib_2', 'lrclib_3']);
  assert.equal(lrclibQs().length, 2);   // 具名轮 + 裸标题轮各一发
});

test('池满早停：首形态回 ≥12 条不再发该源后续形态查询', async () => {
  const rows = Array.from({ length: 15 }, (_, i) => ({
    id: i + 1, trackName: '平原曲', artistName: '艺人', duration: 200 + i, syncedLyrics: '[00:01.00]X',
  }));
  reset([
    ['lrclib.net/api/search', () => J(rows)],
    ['lyrics.kugou.com/search', () => J({ candidates: [] })],
  ]);
  const list = await svc.searchLyricCandidates({
    songId: '880021', title: '平原曲', artist: '艺人', durationSec: 200,
  });
  // lrclib 首形态已收 15 ≥ CAND_CAP——'平原曲' 裸轮不再打
  assert.equal(lrclibQs().length, 1);
  assert.deepEqual(lrclibQs(), ['平原曲 艺人']);
  // kugou 未触满——自家两形态照发（早停是 per-源闸）
  assert.deepEqual(kugouQs(), ['平原曲 艺人', '平原曲']);
  assert.equal(list.length, 12);   // 跨源池仍按 CAND_CAP 截断
});

test('降轮构成：非 UGC [artist, 裸标题]；UGC 中间夹 artistFromTitle 轮', async () => {
  const row = (id) => ({
    id, trackName: '平原曲', artistName: '别人', duration: 300, syncedLyrics: '[00:01.00]Y',
  });
  reset([
    ['lrclib.net/api/search', (url) => J(qOf(url, 'q') === '平原曲' ? [row(9)] : [])],
    ['lyrics.kugou.com/search', () => J({ candidates: [] })],
  ]);
  // 曲库行（数字 id）：具名轮灭、裸标题轮命中——手动池无 AI 闸，裸轮是
  // 修错配正当召回面
  const list = await svc.searchLyricCandidates({ songId: '880022', title: '平原曲', artist: '艺人' });
  assert.deepEqual(lrclibQs(), ['平原曲 艺人', '平原曲']);
  assert.deepEqual(list.map(c => c.extId), ['lrclib_9']);

  // UGC 曲：artist 实为 UP 主，artistFromTitle 剥出的真艺人候选占中间轮
  reset([
    ['lrclib.net/api/search', () => J([])],
    ['lyrics.kugou.com/search', () => J({ candidates: [] })],
  ]);
  await svc.searchLyricCandidates({ songId: 'bv_BV1abcdefghi', title: 'Singer - 平原曲', artist: 'UP主' });
  assert.deepEqual(lrclibQs(), [
    'Singer - 平原曲 UP主', 'Singer - 平原曲 Singer', 'Singer - 平原曲',
    '平原曲 UP主', '平原曲 Singer', '平原曲',
  ]);
});

test('排序：_form 特异性序先于 _diff——降轮低差值不压 strict 命中', async () => {
  const row = (id, dur) => ({
    id, trackName: '平原曲', artistName: '艺人', duration: dur, syncedLyrics: '[00:01.00]X',
  });
  reset([
    ['lrclib.net/api/search', (url) => J(qOf(url, 'q') === '平原曲 艺人'
      ? [row(1, 250)]   // form0 diff50
      : [row(2, 201)])], // form1 diff1
    ['lyrics.kugou.com/search', (url) => J({ candidates: qOf(url, 'keyword') === '平原曲 艺人'
      ? [{ id: 'k0', accesskey: 'ak0', singer: '艺人', song: '平原曲', duration: 230000 }]  // form0 diff30
      : [{ id: 'k1', accesskey: 'ak1', singer: '艺人', song: '平原曲', duration: 200000 }] })], // form1 diff0
  ]);
  const list = await svc.searchLyricCandidates({
    songId: '880023', title: '平原曲', artist: '艺人', durationSec: 200,
  });
  // 旧纯 _diff 序会排成 k1(0)→l2(1)→k0(30)→l1(50)；_form 先决后降轮
  // 命中整体劣后——降轮命中是不同曲的可能性高
  assert.deepEqual(list.map(c => c.extId), [
    'kugou_k0', 'lrclib_1',   // form0 内按 diff：30 < 50
    'kugou_k1', 'lrclib_2',   // form1 内按 diff：0 < 1
  ]);
});

test('形态中途故障：保留已收部分池、中断余下形态；首形态炸仍归源失败', async () => {
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a.map(String).join(' '));
  try {
    reset([
      ['lrclib.net/api/search', (url) => {
        if (qOf(url, 'q') === 'Singer - 平原曲 UP主') {
          return J([{ id: 5, trackName: '平原曲', artistName: 'Singer', duration: 200, syncedLyrics: '[00:01.00]X' }]);
        }
        return Promise.reject(new Error('socket hangup'));  // 第 2 形态起传输炸
      }],
      ['lyrics.kugou.com/search', () => J({ candidates: [] })],
      ['music.youtube.com', () => J({ contents: {} })],
    ]);
    const list = await svc.searchLyricCandidates({
      songId: 'yt_abcdefghijk', title: 'Singer - 平原曲', artist: 'UP主',
    });
    // form0 命中端出；第 2 形态炸后 '平原曲' 系形态（3~6）不再打
    assert.deepEqual(list.map(c => c.extId), ['lrclib_5']);
    assert.equal(lrclibQs().length, 2);
    assert.ok(warns.some(l => /候选池 lrclib 形态/.test(l) && /保留已收 1 条/.test(l)));

    // 对照：首形态即炸（池尚空）→ 上抛归外层「源失败 warn+[]」旧语义
    warns.length = 0;
    reset([
      ['lrclib.net', () => Promise.reject(new Error('socket hangup'))],
      ['lyrics.kugou.com/search', () => J({
        candidates: [{ id: 'k7', accesskey: 'ak7', singer: '艺人', song: '平原曲', duration: 200000 }],
      })],
    ]);
    const list2 = await svc.searchLyricCandidates({ songId: '880025', title: '平原曲', artist: '艺人' });
    assert.deepEqual(list2.map(c => c.extId), ['kugou_k7']);  // lrclib 空池、kugou 照常
    assert.ok(warns.some(l => /候选池 lrclib 源失败/.test(l)));
    assert.equal(lrclibQs().length, 1);   // 首形态炸即中断，不再打裸轮
  } finally { console.warn = origWarn; }
});

// ── 展开序与 _form 哨兵边界钉 ──

test('_form 哨兵不穿桶：执行面尾形态（_form 4/5）命中仍排在 ytm 无 _form 候选前', async () => {
  const row = (id) => ({
    id, trackName: '平原曲', artistName: 'Singer', duration: 200,
    syncedLyrics: '[00:01.00]X',
  });
  reset([
    ['/youtubei/v1/next', () => nextOk('MPLYt_sent')],
    ['/youtubei/v1/browse', () => browseOk()],
    // 4 变体×3 轮=12 形态被 CAND_MAX_FORMS 硬顶截到前 6（v0 全轮+v1 全轮）：
    // 只让可执行面尾部两形态出命中（'Singer - 平原曲 Singer'=_form4、
    // 'Singer - 平原曲'=_form5），前 4 发全空
    ['lrclib.net/api/search', (url) => {
      const q = qOf(url, 'q');
      if (q === 'Singer - 平原曲 Singer') return J([row(51)]);
      if (q === 'Singer - 平原曲') return J([row(52)]);
      return J([]);
    }],
    ['lyrics.kugou.com/search', () => J({ candidates: [] })],
  ]);
  const list = await svc.searchLyricCandidates({
    songId: 'yt_sentinel001', title: 'Singer - 平原曲 ver.EMA', artist: 'UP主',
  });
  // 确认命中确系执行面尾形态（_form 4/5）而非早形态——哨兵判例成立的前提
  assert.equal(lrclibQs().indexOf('Singer - 平原曲 Singer'), 4);
  assert.equal(lrclibQs().indexOf('Singer - 平原曲'), 5);
  // 哨兵 9 时代：ytm 无 _form 按 9 排——大 _form 真命中被压在它之后（殿后
  // 意图破缺）；哨兵 9e9 后 ytm 恒殿后、尾形态命中不与其串桶（本例在硬顶
  // 6 时代守同一回归面——_form 上限怎么调都不回潮）
  assert.deepEqual(list.map(c => c.extId), [
    'lrclib_51', 'lrclib_52', 'ytm_sentinel001',
  ]);
});

test('非 UGC 展开序：轮外圈 × 变体内圈——具名变体全部先于裸标题轮', async () => {
  const row = (id) => ({
    id, trackName: '平原曲', artistName: '艺人', duration: 200, syncedLyrics: '[00:01.00]X',
  });
  reset([
    ['lrclib.net/api/search', (url) => {
      const q = qOf(url, 'q');
      // 剥缀变体+真艺人（轮外圈序 _form=1）与裸轮首形态（_form=4）各出一条
      if (q === 'Singer - 平原曲 艺人') return J([row(31)]);
      if (q === 'Singer - 平原曲 ver.EMA') return J([row(30)]);
      return J([]);
    }],
    ['lyrics.kugou.com/search', () => J({ candidates: [] })],
  ]);
  const list = await svc.searchLyricCandidates({
    songId: '880030', title: 'Singer - 平原曲 ver.EMA', artist: '艺人',
  });
  // 与级联 runRound 同序：具名轮 4 变体全打完才进裸标题轮（裸轮恒居尾）。
  // 8 形态输入被 CAND_MAX_FORMS 硬顶截到前 6：具名轮 4 发 + 裸轮 v0/v1 两
  // 发——截掉的恰是裸轮尾部两形态，「具名先于裸轮」的序断言不受影响
  assert.deepEqual(lrclibQs(), [
    'Singer - 平原曲 ver.EMA 艺人', 'Singer - 平原曲 艺人',
    '平原曲 ver.EMA 艺人', '平原曲 艺人',
    'Singer - 平原曲 ver.EMA', 'Singer - 平原曲',
  ]);
  // 特异性序纠正：变体外圈旧序下裸轮命中 'Singer - 平原曲 ver.EMA'(_form=1)
  // 会压在具名变体命中 'Singer - 平原曲 艺人'(_form=2) 之前——无艺人证据
  // 的同题命中不该赢过标题弱化+真艺人命中
  assert.deepEqual(list.map(c => c.extId), ['lrclib_31', 'lrclib_30']);
});

test('UGC 展开序回归钉：仍变体外圈 × 艺人轮内圈（剥缀+裸轮伞内早触达）', async () => {
  reset([
    ['lrclib.net/api/search', () => J([])],
    ['lyrics.kugou.com/search', () => J({ candidates: [] })],
  ]);
  await svc.searchLyricCandidates({
    songId: 'bv_BV1abcdefghi', title: 'Singer - 平原曲 ver.EMA', artist: 'UP主',
  });
  // 4 变体 × 3 轮（UP主 / artistFromTitle='Singer' / ''）：每变体先打全
  // 艺人轮再换变体——修复目标形态「v1 剥缀+裸轮」'Singer - 平原曲' 居
  // _form=5，轮外圈序会把它推到第 9 发（15s 伞内更晚触达），故 UGC 不换序。
  // CAND_MAX_FORMS 硬顶 6 恰截在 v0 全轮 + v1 全轮（目标形态在内），
  // v2/v3 尾部形态（'平原曲 ver.EMA'/'平原曲' 系 6 发）不再打
  assert.deepEqual(lrclibQs(), [
    'Singer - 平原曲 ver.EMA UP主', 'Singer - 平原曲 ver.EMA Singer', 'Singer - 平原曲 ver.EMA',
    'Singer - 平原曲 UP主', 'Singer - 平原曲 Singer', 'Singer - 平原曲',
  ]);
});

// ── 扇出节流钉板：召回地板早停 + 形态硬顶 + 429 熔断 ──
// 实机教训：形态扇出把单端点查询数 ×变体数放大，连点几首歌即把部署 IP
// 刷进 lrclib 429（首形态即 429 → 整源归空池）。双闸收口：池 ≥4 后最多
// 再宽采 1 个形态；单源形态查询数硬顶 6。

test('召回地板早停：形态命中使池 ≥4 → 再宽采 1 个形态（N+1 含）即停', async () => {
  const row = (id) => ({
    id, trackName: '平原曲', artistName: '艺人', duration: 200, syncedLyrics: '[00:01.00]X',
  });
  reset([
    // 非 UGC 4 形态：form0 空、form1 '平原曲 艺人' 出 4 条触地板（N=1）→
    // form2 宽采补位照发、form3 '平原曲' 裸轮不再打
    ['lrclib.net/api/search', (url) => J(qOf(url, 'q') === '平原曲 艺人'
      ? [row(1), row(2), row(3), row(4)] : [])],
    ['lyrics.kugou.com/search', () => J({ candidates: [] })],
  ]);
  const list = await svc.searchLyricCandidates({
    songId: '880040', title: '平原曲 ver.EMA', artist: '艺人', durationSec: 200,
  });
  // 轮外圈展开：['平原曲 ver.EMA 艺人','平原曲 艺人','平原曲 ver.EMA','平原曲']
  assert.deepEqual(lrclibQs(), [
    '平原曲 ver.EMA 艺人', '平原曲 艺人', '平原曲 ver.EMA',
  ]);
  assert.deepEqual(list.map(c => c.extId), ['lrclib_1', 'lrclib_2', 'lrclib_3', 'lrclib_4']);
});

test('形态硬顶 6：12 形态输入两源各只发前 6 发（v0 全轮 + v1 全轮）', async () => {
  reset([
    ['lrclib.net/api/search', () => J([])],
    ['lyrics.kugou.com/search', () => J({ candidates: [] })],
  ]);
  await svc.searchLyricCandidates({
    songId: 'bv_BV1abcdefghi', title: 'Singer - 平原曲 ver.EMA', artist: 'UP主',
  });
  // 4 变体×3 轮=12 形态全空——无地板无满池，纯硬顶把两源各截到前 6 发：
  // UGC 变体外圈序下恰覆盖 v0 全轮 + v1 全轮（剥缀+裸轮在内）
  const first6 = [
    'Singer - 平原曲 ver.EMA UP主', 'Singer - 平原曲 ver.EMA Singer', 'Singer - 平原曲 ver.EMA',
    'Singer - 平原曲 UP主', 'Singer - 平原曲 Singer', 'Singer - 平原曲',
  ];
  assert.deepEqual(lrclibQs(), first6);
  assert.deepEqual(kugouQs(), first6);
});

test('中途 429 熔断：已收部分池端出、余下形态停发；首形态 429 → 源空池', async () => {
  const row = (id) => ({
    id, trackName: '平原曲', artistName: '艺人', duration: 200, syncedLyrics: '[00:01.00]X',
  });
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a.map(String).join(' '));
  try {
    reset([
      // form0 命中 2 条；第 2 形态起上游 429（无 Retry-After →
      // lrclibSearchList 即抛「lrclib 限流」——重试消化在源内，形态层熔断）
      ['lrclib.net/api/search', (url) => (
        qOf(url, 'q') === '平原曲 ver.EMA 艺人'
          ? J([row(5), row(6)])
          : J({ err: 'rate limited' }, 429)
      )],
      ['lyrics.kugou.com/search', () => J({ candidates: [] })],
    ]);
    const list = await svc.searchLyricCandidates({
      songId: '880041', title: '平原曲 ver.EMA', artist: '艺人',
    });
    // 已收 2 条端出；form1 熔断后 form2/3（'平原曲 ver.EMA'/'平原曲' 裸轮）
    // 不再发——429 是熔断面不是重试面
    assert.deepEqual(list.map(c => c.extId), ['lrclib_5', 'lrclib_6']);
    assert.equal(lrclibQs().length, 2);
    assert.ok(warns.some(l => /候选池 lrclib 形态/.test(l) && /保留已收 2 条/.test(l)));

    // 对照：首形态即 429（池尚空）→ 上抛归「源失败 warn+[]」旧语义，
    // 后续形态一发不打
    warns.length = 0;
    reset([
      ['lrclib.net', () => J({ err: 'rate limited' }, 429)],
      ['lyrics.kugou.com/search', () => J({
        candidates: [{ id: 'k7', accesskey: 'ak7', singer: '艺人', song: '平原曲', duration: 200000 }],
      })],
    ]);
    const list2 = await svc.searchLyricCandidates({
      songId: '880042', title: '平原曲', artist: '艺人',
    });
    assert.deepEqual(list2.map(c => c.extId), ['kugou_k7']);  // lrclib 空池、kugou 照常
    assert.ok(warns.some(l => /候选池 lrclib 源失败/.test(l)));
    assert.equal(lrclibQs().length, 1);   // 首形态即熔断中断
  } finally { console.warn = origWarn; }
});

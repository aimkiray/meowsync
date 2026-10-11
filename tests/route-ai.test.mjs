// routes/ai.js 冒烟：aiEnabled 降级 / id 校验 / 翻译成功形状+落库缓存 /
// verify 判定链。上游两依赖（lib/ai 模型客户端、netease-api 词源）全桩——
// 真身覆盖面在 services/lyric-verify + repositories/lyricAi（真库）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { seed, tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-route-ai-');
const require = createRequire(import.meta.url);

// ── 桩：AI 客户端与词源上游 ──
let aiOn = false;
let aiAnswer = null;
let aiImpl = null;    // 逐调用定制应答（如挂起造并发窗）——缺席回 aiAnswer
const aiCalls = [];
seed('../src/server/lib/ai.js', {
  aiEnabled: () => aiOn,
  aiModel: () => 'test-model',
  askAiJson: async (args) => { aiCalls.push(args); return aiImpl ? aiImpl(args) : aiAnswer; },
});
let lyricPayload = { lrc: { lyric: '' }, tlyric: { lyric: '' } };
let detailSongs = [];   // song_detail 反查应答（songs 数组）——署名闸供料桩
let apiThrow = null;    // 'lyric'/'song_detail' → 该上游抛错（fail-soft 注入桩）
const apiCalls = [];    // 记录上游调用 {name, params}——「未发 song_detail」断言靠它
seed('../src/server/services/netease-api.js', {
  callNeteaseApi: async (name, params) => {
    apiCalls.push({ name, params });
    if (name === apiThrow) throw new Error(`${name} upstream boom`);
    if (name === 'song_detail') return { body: { songs: detailSongs } };
    return { body: lyricPayload };
  },
  apiModules: {},
});
// 外源词源反查桩：ytm_/lrclib_/kugou_ 词键的取词支路（真身在
// lyric-external.test.mjs 钉——这里只钉路由放行+支路命中）
let extHit = null;
const extCalls = [];
seed('../src/server/services/lyric-external.js', {
  fetchExternalLyric: async () => null,
  fetchByExtId: async (id) => { extCalls.push(id); return extHit; },
});
// 自署本家反解桩：lyric-verify（经模块对象调 lib/youtube.resolveOriginalInfo）
// 的 yt_ trackId 声明解析——钉录制桩隔离真身 fetchPlayer 上行面；
// origImpl 缺席默认归 null=无声明。
// resolvePublishedAt 同款录制桩：chrono-guard 的源发布日惰性反解经
// ytLib.resolvePublishedAt?.() 打到这里；pubImpl 缺席默认归 null=无日期
let origImpl = null;
const origCalls = [];
let pubImpl = null;
const pubCalls = [];
seed('../src/server/lib/youtube.js', {
  resolveOriginalInfo: async (args) => { origCalls.push(args); return origImpl ? origImpl(args) : null; },
  resolvePublishedAt: async (args) => { pubCalls.push(args); return pubImpl ? pubImpl(args) : null; },
});

let app, lyricAiRepo, lyricVerify;
before(() => {
  app = require('../src/server/routes/ai.js');
  lyricAiRepo = require('../src/server/repositories/lyricAi.js');
  lyricVerify = require('../src/server/services/lyric-verify.js');
});
after(() => { rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

const post = (path, body) => app.request(`http://t${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const json = async (res) => ({ status: res.status, body: await res.json() });

// ── 降级与校验 ──

test('ai：aiEnabled=false 时 status 透出停用态，translate 降级 503', async () => {
  aiOn = false;
  const st = await json(await app.request('http://t/ai/status'));
  assert.deepEqual(st.body, { code: 200, enabled: false, model: null });
  const r = await json(await post('/ai/lyric-translate', { id: '123456' }));
  assert.equal(r.status, 503);
  assert.equal(r.body.enabled, false); // 前端靠此分辨「未配置」与真错误
});

test('ai：非法 songId 400（外部 bv_/yt_ id 无词源可译）', async () => {
  aiOn = true;
  const r = await post('/ai/lyric-translate', { id: 'bv_BV123' });
  assert.equal(r.status, 400);
  // id 缺失连 zod 都过不了——同 400 但走 schema 通道
  const r2 = await post('/ai/lyric-translate', {});
  assert.equal(r2.status, 400);
});

test('ai：lyric-verify 入参校验——坏 id 400、缺 sourceTitle 400', async () => {
  const r = await post('/ai/lyric-verify', { id: 'qq_abc', sourceTitle: 'x' });
  assert.equal(r.status, 400);
  const r2 = await post('/ai/lyric-verify', { id: '123456' });
  assert.equal(r2.status, 400);
});

// ── 翻译成功链 ──

test('ai：无官方译文的 lrc → AI 翻译产出 tlyric 并落库；重放吃缓存', async () => {
  aiOn = true;
  lyricPayload = {
    lrc: { lyric: '[00:01.00]hello world\n[00:02.00]goodbye sky' },
    tlyric: { lyric: '' },
  };
  aiAnswer = { t: { '0': '你好世界', '1': '再会天空' } };
  const before1 = aiCalls.length;
  const r = await json(await post('/ai/lyric-translate', { id: '880001' }));
  assert.equal(r.status, 200);
  assert.equal(r.body.source, 'ai');
  assert.equal(r.body.total, 2);
  assert.match(r.body.tlyric, /\[00:01\.00\]你好世界/); // 时间戳回贴原文行
  assert.ok(aiCalls.length > before1);

  // 第二发：行存在即命中——缓存路径不吃配额、不问模型
  const r2 = await json(await post('/ai/lyric-translate', { id: '880001' }));
  assert.equal(r2.status, 200);
  assert.equal(r2.body.cached, true);
  assert.equal(r2.body.tlyric, r.body.tlyric);
});

test('ai：官方译文直回（tlyric 存在）→ source=词源、零模型调用', async () => {
  lyricPayload = {
    lrc: { lyric: '[00:01.00]song' },
    tlyric: { lyric: '[00:01.00]官方翻译' },
  };
  const before = aiCalls.length;
  const r = await json(await post('/ai/lyric-translate', { id: '880002' }));
  assert.equal(r.status, 200);
  assert.equal(r.body.tlyric, '[00:01.00]官方翻译');
  assert.equal(r.body.source, 'netease');
  assert.equal(aiCalls.length, before); // 未问模型
});

test('ai：截断译文（模型缺键）透出但不落库——重播须重打 AI', async () => {
  lyricPayload = {
    lrc: { lyric: '[00:01.00]line one\n[00:02.00]line two\n[00:03.00]line three' },
    tlyric: { lyric: '' },
  };
  // 模型合法省略一个键（prompt 明示可省）→ translated.size<jobs → 截断
  aiAnswer = { t: { '0': '第一行', '2': '第三行' } };
  const before = aiCalls.length;
  const r = await json(await post('/ai/lyric-translate', { id: '880010' }));
  assert.equal(r.status, 200);
  assert.ok(r.body.lines < r.body.total, '截断应透出 lines<total');
  // 不落库：缓存行查询应空——否则残缺译文被固化成"完整缓存"永不再补
  assert.equal(lyricAiRepo.getCachedTranslation('880010', 'test-model'), undefined);
  // 重播无缓存可吃 → 又打一次 AI（配额代价换取正确性）
  const r2 = await json(await post('/ai/lyric-translate', { id: '880010' }));
  assert.equal(r2.status, 200);
  assert.ok(aiCalls.length > before + 1, '截断未落库时重播应重打上游');
});

test('ai：模型回非字符串译文值（数字/对象）整条丢——不 String 化落库', async () => {
  lyricPayload = {
    lrc: { lyric: '[00:01.00]line one\n[00:02.00]line two\n[00:03.00]line three' },
    tlyric: { lyric: '' },
  };
  // {t:{"0":123}} 与对象值——typeof 闸把它们滤成未译（回填原文占位），
  // 不许把 '123'/'[object Object]' 写进下发词稿
  aiAnswer = { t: { '0': 123, '1': { zh: '嵌套' }, '2': '第三行' } };
  // ai-translate 按 clientIp 分桶（8/min）——独立 IP 不占共享桶
  const prevTp = process.env.TRUST_PROXY;
  process.env.TRUST_PROXY = '1';
  try {
    const r = await json(await app.request('http://t/ai/lyric-translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '10.9.9.1' },
      body: JSON.stringify({ id: '880011' }),
    }));
    assert.equal(r.status, 200);
    assert.ok(!r.body.tlyric.includes('123'));
    assert.ok(!r.body.tlyric.includes('[object'));
    assert.match(r.body.tlyric, /\[00:03\.00\]第三行/);
    // 非串值行按未译回填原文占位（占住时间戳防邻行错贴）
    assert.match(r.body.tlyric, /\[00:01\.00\]line one/);
  } finally { process.env.TRUST_PROXY = prevTp; }
});

test('ai：无歌词源 → 404 + skip 落库（重放不再打上游）', async () => {
  lyricPayload = { lrc: { lyric: '' }, tlyric: { lyric: '' } };
  const r = await post('/ai/lyric-translate', { id: '880003' });
  assert.equal(r.status, 404);
  // skip 哨兵也是有效缓存行
  const r2 = await json(await post('/ai/lyric-translate', { id: '880003' }));
  assert.equal(r2.status, 200);
  assert.equal(r2.body.cached, true);
});

test('ai：主词即占位声明（[99:00]纯音乐请欣赏）→ 无词 404，挂着的 tlyric 不透出', async () => {
  lyricPayload = {
    lrc: { lyric: '[99:00.00]纯音乐，请欣赏' },
    // 占位主词的译文层没有语义——neteaseLyricBody 一并归空不透出，
    // 不然译层可能被下游当成真词稿
    tlyric: { lyric: '[99:00.00]instrumental, please enjoy' },
  };
  const prevTp = process.env.TRUST_PROXY;
  process.env.TRUST_PROXY = '1';
  try {
    const r = await app.request('http://t/ai/lyric-translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '10.9.9.2' },
      body: JSON.stringify({ id: '880012' }),
    });
    assert.equal(r.status, 404);
  } finally { process.env.TRUST_PROXY = prevTp; }
});

// ── verify 判定链 ──

test('ai：lyric-verify 模型判定落库——判不符 ok:false，重放 cached', async () => {
  lyricPayload = { lrc: { lyric: '[00:01.00]totally different song\n[00:02.00]another line' } };
  aiAnswer = { ok: false };
  const r = await json(await post('/ai/lyric-verify', {
    id: '880004', sourceTitle: 'Some Video', sourceAuthor: 'author',
  }));
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  const r2 = await json(await post('/ai/lyric-verify', {
    id: '880004', sourceTitle: 'Some Video', sourceAuthor: 'author',
  }));
  assert.equal(r2.body.cached, true);
  assert.equal(r2.body.ok, false);
});

test('ai：lyric-verify AI 关闭但缓存命中仍回判定（记忆不随开关旁路）', async () => {
  // 上行已把 (880004@model,title,author) 判为 false——关 AI 后同键重放
  aiOn = false;
  const r = await json(await post('/ai/lyric-verify', {
    id: '880004', sourceTitle: 'Some Video', sourceAuthor: 'author',
  }));
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  // 未命中新键 → 503 降级而非炸
  const r2 = await post('/ai/lyric-verify', {
    id: '880005', sourceTitle: 'Other', sourceAuthor: '',
  });
  assert.equal(r2.status, 503);
  aiOn = true;
});

// ── 外源词源 id（ytm_/lrclib_/kugou_ 白名单 + fetchByExtId 取词支路）──

test('ai：translate 收 lrclib_ 词源 id——fetchByExtId 取词后照常 AI 翻译', async () => {
  aiOn = true;
  extHit = {
    lrc: '[00:01.00]foreign line\n[00:02.00]another',
    source: 'lrclib', extId: 'lrclib_88001', synced: true,
  };
  aiAnswer = { t: { '0': '外文行一', '1': '另一句' } };
  const r = await json(await post('/ai/lyric-translate', { id: 'lrclib_88001' }));
  assert.equal(r.status, 200);
  assert.equal(r.body.source, 'ai');
  assert.match(r.body.tlyric, /\[00:01\.00\]外文行一/);
  assert.equal(extCalls.at(-1), 'lrclib_88001');
  // 译文按 extId 落库——重放吃缓存不再问反查/模型
  const r2 = await json(await post('/ai/lyric-translate', { id: 'lrclib_88001' }));
  assert.equal(r2.status, 200);
  assert.equal(r2.body.cached, true);
});

test('ai：lyric-verify 收 ytm_ 词源 id——反查取词走判定链', async () => {
  aiOn = true;
  extHit = {
    lrc: '[00:01.00]video song line\n[00:02.00]second line',
    source: 'ytm', extId: 'ytm_extvid0001', synced: true,
  };
  aiAnswer = { ok: true };
  const r = await json(await post('/ai/lyric-verify', {
    id: 'ytm_extvid0001', sourceTitle: 'Video Song', sourceAuthor: 'chan',
  }));
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(extCalls.at(-1), 'ytm_extvid0001');
});

test('ai：lyric-verify 携 yt_ trackId → 反解自署本家进判定语境；缺席/非 yt_ 逐位同旧', async () => {
  aiOn = true;
  // memoize 命中会绕过 origImpl 原位桩——用例前后清 videoId 级解析缓存
  lyricVerify._clearDeclaredMemo();
  origImpl = async ({ videoId }) => ({ videoId, title: 'Original Song', author: 'honkaP' });
  try {
    lyricPayload = { lrc: { lyric: '[00:01.00]verify line\n[00:02.00]other' }, tlyric: { lyric: '' } };
    aiAnswer = { ok: true };
    const before = origCalls.length;
    const r = await json(await post('/ai/lyric-verify', {
      id: '880020', sourceTitle: 'Cover 動画', sourceAuthor: 'utaite',
      trackId: 'yt_abcdefghijk',
    }));
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    // 反解以 trackId 抽出的 videoId 发起
    assert.equal(origCalls.length, before + 1);
    assert.equal(origCalls.at(-1).videoId, 'abcdefghijk');
    // 声明证据实锤进判官 prompt
    assert.match(aiCalls.at(-1).user, /声明本家：Original Song — honkaP/);
    // trackId 缺席/非 yt_ 形态：零反解调用——旧 body 行为逐位不动
    const r2 = await json(await post('/ai/lyric-verify', {
      id: '880021', sourceTitle: 'x', sourceAuthor: '',
    }));
    assert.equal(r2.status, 200);
    const r3 = await json(await post('/ai/lyric-verify', {
      id: '880022', sourceTitle: 'x', sourceAuthor: '', trackId: 'bv_BV1xx411c7mD',
    }));
    assert.equal(r3.status, 200);
    assert.equal(origCalls.length, before + 1);
    // AI 关也照解析——判定缓存键的声明位要先定才能查库（未命中才 503）
    aiOn = false;
    const r4 = await post('/ai/lyric-verify', {
      id: '880023', sourceTitle: 'x', sourceAuthor: '', trackId: 'yt_zzzzzzzzzzz',
    });
    assert.equal(r4.status, 503);
    assert.equal(origCalls.length, before + 2);
  } finally { aiOn = true; origImpl = null; lyricVerify._clearDeclaredMemo(); }
});

// ── 署名否证闸的惰性 candidate 接线 ──
// wholicoji 实案病灶：song_match 绑错网易条目时播放核验走本路由——手里没有
// 候选条目身份，署名闸够不着。声明在场 + 网易词源 + 词内有「作曲:X」署名行
// 才付一跳 song_detail 反查候选艺人喂闸；缺任一条件零反查（对照轴不齐时闸
// 本就不适用，不该为它付上行）
test('ai：lyric-verify 声明在场+网易词含作曲署名 → song_detail 反查喂闸判 false', async () => {
  aiOn = true;
  lyricVerify._clearDeclaredMemo();
  origImpl = async ({ videoId }) => ({ videoId, title: '早く帰りたい', author: 'ポップしなないで' });
  lyricPayload = { lrc: { lyric: '[00:01.00] 作曲 : wholicoji\n[00:02.00]行きたくない\n[00:03.00]帰りたい' }, tlyric: { lyric: '' } };
  detailSongs = [{ name: '早く帰りたい', ar: [{ name: 'wholicoji' }] }];
  aiAnswer = { ok: true };   // 模型即便放行——确定性闸必须在 AI 通道前截停
  try {
    const nApi = apiCalls.length;
    const nAi = aiCalls.length;
    const r = await json(await post('/ai/lyric-verify', {
      id: '880030', sourceTitle: '早く帰りたい 歌ってみた', sourceAuthor: 'coverP',
      trackId: 'yt_gatecred001',
    }));
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, false);   // 作曲署名=候选艺人≠声明本家 → 闸判否
    const det = apiCalls.slice(nApi).filter(x => x.name === 'song_detail');
    assert.equal(det.length, 1);
    assert.equal(det[0].params.ids, '880030');
    assert.equal(aiCalls.length, nAi);   // 闸先截停——没烧模型
  } finally { origImpl = null; detailSongs = []; lyricVerify._clearDeclaredMemo(); }
});

test('ai：lyric-verify 署名闸惰性面——无声明/无署名行/extId 词源不发 song_detail', async () => {
  aiOn = true;
  lyricVerify._clearDeclaredMemo();
  detailSongs = [{ name: 'x', ar: [{ name: 'wholicoji' }] }];   // 误发反查也能应答——靠 apiCalls 钉「没发」
  const credLrc = '[00:01.00] 作曲 : wholicoji\n[00:02.00]line\n[00:03.00]line2';
  try {
    // 词有署名行但无 trackId → declared 缺席：对照轴不齐零反查
    lyricPayload = { lrc: { lyric: credLrc }, tlyric: { lyric: '' } };
    aiAnswer = { ok: true };
    let n = apiCalls.length;
    const r1 = await json(await post('/ai/lyric-verify', { id: '880031', sourceTitle: 't', sourceAuthor: 'a' }));
    assert.equal(r1.status, 200);
    assert.ok(!apiCalls.slice(n).some(x => x.name === 'song_detail'), '无声明不应发 song_detail');
    // 声明在场但词内无作曲署名行——预检短路不反查
    origImpl = async () => ({ title: '本家', author: '本家P' });
    lyricPayload = { lrc: { lyric: '[00:01.00]plain line\n[00:02.00]other' }, tlyric: { lyric: '' } };
    n = apiCalls.length;
    const r2 = await json(await post('/ai/lyric-verify', {
      id: '880032', sourceTitle: 't', sourceAuthor: 'a', trackId: 'yt_gatecred002',
    }));
    assert.equal(r2.status, 200);
    assert.ok(!apiCalls.slice(n).some(x => x.name === 'song_detail'), '无署名行不应发 song_detail');
    // 外源词源 id（ytm_）：级联 verifyHit 已自带 candidate——路由侧形态闸
    // 跳过，声明在场+署名行齐备也只走 AI 判定
    extHit = { lrc: credLrc, source: 'ytm', extId: 'ytm_credit01', synced: true };
    n = apiCalls.length;
    const r3 = await json(await post('/ai/lyric-verify', {
      id: 'ytm_credit01', sourceTitle: 't', sourceAuthor: 'a', trackId: 'yt_gatecred003',
    }));
    assert.equal(r3.status, 200);
    assert.equal(r3.body.ok, true);   // candidate 缺席——闸不适用落回 AI 放行
    assert.ok(!apiCalls.slice(n).some(x => x.name === 'song_detail'), 'extId 词源不应发 song_detail');
    // 反查拿不到艺人（songs 空）→ candidate 不传、闸不适用，落回 AI 判定
    lyricPayload = { lrc: { lyric: credLrc }, tlyric: { lyric: '' } };
    detailSongs = [];
    n = apiCalls.length;
    const r4 = await json(await post('/ai/lyric-verify', {
      id: '880033', sourceTitle: 't', sourceAuthor: 'a', trackId: 'yt_gatecred004',
    }));
    assert.equal(r4.status, 200);
    assert.equal(r4.body.ok, true);
    assert.equal(apiCalls.slice(n).filter(x => x.name === 'song_detail').length, 1);   // 试过但拿不到→不传
  } finally { origImpl = null; extHit = null; detailSongs = []; lyricVerify._clearDeclaredMemo(); }
});

// ── 缓存放行 verdict 的署名闸重检 ──
// wholicoji 病灶的另一半：v2d3 键已固化 ok:1（署名闸接线前的 AI 放行错判），
// verdictOf() 早退把闸短路永久透出。「声明在场 + 网易词源」交集的缓存 ok:1
// 不早退——付一跳 lyric + 至多一跳 song_detail 重检确定性闸：命中否证压回
// ok:false 且零 AI 重判；未命中否证信任已落库判定回 cached:true。其余命中
// （无声明/extId/缓存否决）逐位不动原样早退零上行
test('ai：lyric-verify 缓存 ok:1 逢声明在场+作曲署名=候选艺人≠本家 → 闸压回 ok:false', async () => {
  aiOn = true;
  lyricVerify._clearDeclaredMemo();
  origImpl = async () => ({ title: '早く帰りたい', author: 'ポップしなないで' });
  lyricPayload = { lrc: { lyric: '[00:01.00] 作曲 : wholicoji\n[00:02.00]行きたくない\n[00:03.00]帰りたい' }, tlyric: { lyric: '' } };
  detailSongs = [{ name: '早く帰りたい', ar: [{ name: 'wholicoji' }] }];
  aiAnswer = { ok: true };
  // 预置声明语境（d3 盐位）下已落库的放行判定——模拟闸接线前固化的错判
  const body = {
    id: '880040', sourceTitle: '早く帰りたい 歌ってみた', sourceAuthor: 'coverP',
    trackId: 'yt_gatecache01',
  };
  lyricAiRepo.upsertVerdict(
    lyricVerify.lyricVerdictKey(body.id, body.sourceTitle, body.sourceAuthor, false, true),
    'lyric', true, 'preset|decl:ポップしなないで');
  try {
    const nAi = aiCalls.length;
    const nApi = apiCalls.length;
    const r = await json(await post('/ai/lyric-verify', body));
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, false);           // 固化放行被确定性闸压回
    assert.equal(r.body.cached, undefined);   // 判否不落 verdict——非缓存透出
    assert.equal(aiCalls.length, nAi);        // 闸截停不重判——零 AI 消耗
    const ups = apiCalls.slice(nApi);
    assert.equal(ups.filter(x => x.name === 'lyric').length, 1);        // 一跳词拉取
    assert.equal(ups.filter(x => x.name === 'song_detail').length, 1);  // 至多一跳反查
  } finally { origImpl = null; detailSongs = []; lyricVerify._clearDeclaredMemo(); }
});

test('ai：lyric-verify 缓存 ok:1 逢声明在场但署名=本家 → 闸不否证回 cached:true', async () => {
  aiOn = true;
  lyricVerify._clearDeclaredMemo();
  origImpl = async () => ({ title: '早く帰りたい', author: 'ポップしなないで' });
  // 署名归一后与声明本家同名——对照轴不否证（翻唱沿用原曲署名同理放行）
  lyricPayload = { lrc: { lyric: '[00:01.00] 作曲 : ポップしなないで\n[00:02.00]行きたくない\n[00:03.00]帰りたい' }, tlyric: { lyric: '' } };
  detailSongs = [{ name: '早く帰りたい', ar: [{ name: 'ポップしなないで' }] }];
  const body = {
    id: '880041', sourceTitle: '早く帰りたい 歌ってみた', sourceAuthor: 'coverP',
    trackId: 'yt_gatecache02',
  };
  lyricAiRepo.upsertVerdict(
    lyricVerify.lyricVerdictKey(body.id, body.sourceTitle, body.sourceAuthor, false, true),
    'lyric', true, 'preset');
  try {
    const nApi = apiCalls.length;
    const r = await json(await post('/ai/lyric-verify', body));
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.cached, true);   // 闸未否证——信任已落库放行判定
    // 重检确实跑过：署名行在场 → 付过一跳反查，只是署名=本家不否证
    assert.equal(apiCalls.slice(nApi).filter(x => x.name === 'song_detail').length, 1);
  } finally { origImpl = null; detailSongs = []; lyricVerify._clearDeclaredMemo(); }
});

test('ai：lyric-verify 缓存命中逐位不动面——无声明/extId/缓存否决原样早退零上行', async () => {
  aiOn = true;
  lyricVerify._clearDeclaredMemo();
  try {
    // 无声明键（无 d3 盐位）预置放行——无 trackId 则 declared 缺席，闸不介入
    lyricAiRepo.upsertVerdict(
      lyricVerify.lyricVerdictKey('880042', 'Some Video', 'author', false, false),
      'lyric', true, 'preset');
    let n = apiCalls.length;
    const r1 = await json(await post('/ai/lyric-verify', {
      id: '880042', sourceTitle: 'Some Video', sourceAuthor: 'author',
    }));
    assert.equal(r1.status, 200);
    assert.equal(r1.body.ok, true);
    assert.equal(r1.body.cached, true);
    assert.ok(!apiCalls.slice(n).some(x => x.name === 'lyric' || x.name === 'song_detail'),
      '无声明缓存命中不应付词拉取/detail 反查');
    // extId 词源 + 声明在场：形态闸排除非网易 id 仍早退——连 fetchByExtId 也不打
    origImpl = async () => ({ title: '本家', author: '本家P' });
    lyricAiRepo.upsertVerdict(
      lyricVerify.lyricVerdictKey('ytm_gatecache1', 't', 'a', false, true),
      'lyric', true, 'preset');
    n = apiCalls.length;
    const nExt = extCalls.length;
    const r2 = await json(await post('/ai/lyric-verify', {
      id: 'ytm_gatecache1', sourceTitle: 't', sourceAuthor: 'a', trackId: 'yt_gatecache03',
    }));
    assert.equal(r2.status, 200);
    assert.equal(r2.body.ok, true);
    assert.equal(r2.body.cached, true);
    assert.equal(extCalls.length, nExt);
    assert.ok(!apiCalls.slice(n).some(x => x.name === 'lyric' || x.name === 'song_detail'),
      'extId 缓存命中不应付词拉取/detail 反查');
    // 缓存否决不掺闸语义——声明在场也原样早退 ok:false，不付重检上行
    lyricAiRepo.upsertVerdict(
      lyricVerify.lyricVerdictKey('880043', 't', 'a', false, true),
      'lyric', false, 'preset');
    n = apiCalls.length;
    const r3 = await json(await post('/ai/lyric-verify', {
      id: '880043', sourceTitle: 't', sourceAuthor: 'a', trackId: 'yt_gatecache04',
    }));
    assert.equal(r3.status, 200);
    assert.equal(r3.body.ok, false);
    assert.equal(r3.body.cached, true);
    assert.ok(!apiCalls.slice(n).some(x => x.name === 'lyric' || x.name === 'song_detail'),
      '缓存否决不应付重检上行');
  } finally { origImpl = null; lyricVerify._clearDeclaredMemo(); }
});

// ── inflight 命中回路的署名闸重检 ──
// vkey 声明位只占「有无」不载声明内容——同 id/题/名、异 trackId 携异自署
// 本家的两请求撞同键时，跟从者在 inflight 回路里吃到首发落的判定行。该
// 命中与缓存早退同口径过署名闸重检——否则首发放行落库会被跟从者绕过闸直透
test('ai：lyric-verify inflight 命中 ok:1 + 跟从者声明被署名否证 → 闸压回 ok:false', async () => {
  aiOn = true;
  lyricVerify._clearDeclaredMemo();
  // 首发携「署名本人」声明（署名=声明本家，闸不否证→AI 放行落 ok:1）；
  // 跟从者携第三方本家声明（署名=候选艺人≠本家→重检否证）
  origImpl = async ({ videoId }) => videoId === 'gatelead001'
    ? { videoId, title: '早く帰りたい', author: 'wholicoji' }
    : { videoId, title: '早く帰りたい', author: 'ポップしなないで' };
  lyricPayload = { lrc: { lyric: '[00:01.00] 作曲 : wholicoji\n[00:02.00]行きたくない\n[00:03.00]帰りたい' }, tlyric: { lyric: '' } };
  detailSongs = [{ name: '早く帰りたい', ar: [{ name: 'wholicoji' }] }];
  // 判官挂起造并发窗：首发占住 gate 进判官后跟从者才上路——钉死「走
  // inflight 回路」而非首个 verdictOf 命中分支（verdict 此时尚未落库）。
  // 判定落库先于 gate 释放（同步序列在 finally 之前），跟从者醒来必见 hit
  let releaseAi;
  const aiHold = new Promise(r => { releaseAi = r; });
  aiImpl = async () => { await aiHold; return { ok: true }; };
  const body = (trackId) => ({
    id: '880050', sourceTitle: '早く帰りたい 歌ってみた', sourceAuthor: 'coverP', trackId,
  });
  const tick = () => new Promise(r => setImmediate(r));
  try {
    const pA = post('/ai/lyric-verify', body('yt_gatelead001'));
    const nAi = aiCalls.length;
    for (let i = 0; i < 200 && aiCalls.length === nAi; i++) await tick();
    assert.ok(aiCalls.length > nAi, '首发应已挂进判官（gate 先于判官占用）');
    const nApi = apiCalls.length;
    const pB = post('/ai/lyric-verify', body('yt_gatefollow1'));
    // 跟从者声明反解完成（origCalls 见其 videoId）后距泊入 gate 仅剩数个
    // 微任务——首发仍持 gate，旋出让保其走 inflight 回路吃到落库判定
    for (let i = 0; i < 200 && !origCalls.some(a => a.videoId === 'gatefollow1'); i++) await tick();
    for (let i = 0; i < 50; i++) await tick();
    releaseAi();
    const [rA, rB] = await Promise.all([pA.then(json), pB.then(json)]);
    assert.equal(rA.body.ok, true);            // 署名=声明本家不否证 → AI 放行落库
    assert.equal(rB.body.ok, false);           // 跟从者命中 ok:1 仍被署名闸压回
    assert.equal(rB.body.cached, undefined);   // 闸压回是重算结论——非缓存透出
    const ups = apiCalls.slice(nApi);
    assert.ok(ups.some(x => x.name === 'lyric'), '跟从者应自付重检词拉取');
    assert.ok(ups.some(x => x.name === 'song_detail'), '跟从者应自付候选反查');
  } finally { origImpl = null; aiImpl = null; detailSongs = []; lyricVerify._clearDeclaredMemo(); }
});

// ── 署名闸重检/补料的 fail-soft ──
// 「AI 是增强不是门禁」同口径：重检路上游抛错归闸不适用——已落库放行
// 透出语义不变；直判路径候选反查抛错归「无候选」——落回 judgeLyricLines
// 正常判，不炸请求也不固化 inconclusive
test('ai：lyric-verify 缓存 ok:1 重检遇 lyric/detail 抛错 → 透出已落库 ok:1', async () => {
  aiOn = true;
  lyricVerify._clearDeclaredMemo();
  origImpl = async () => ({ title: '早く帰りたい', author: 'ポップしなないで' });
  lyricPayload = { lrc: { lyric: '[00:01.00] 作曲 : wholicoji\n[00:02.00]行きたくない' }, tlyric: { lyric: '' } };
  const preset = (id) => lyricAiRepo.upsertVerdict(
    lyricVerify.lyricVerdictKey(id, 't', 'a', false, true), 'lyric', true, 'preset');
  const body = (id, trackId) => ({ id, sourceTitle: 't', sourceAuthor: 'a', trackId });
  try {
    // lyric 拉取抛错：重检付不出上行——透出已落库 ok:1 而非 502/误否
    preset('880051');
    apiThrow = 'lyric';
    let n = apiCalls.length;
    let r = await json(await post('/ai/lyric-verify', body('880051', 'yt_failsoft001')));
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.ok, r.body.cached], [true, true]);
    assert.ok(apiCalls.slice(n).some(x => x.name === 'lyric'), '重检确已发起词拉取');
    // song_detail 反查抛错：候选艺人缺席 → 闸不适用 → 透出已落库 ok:1
    preset('880052');
    apiThrow = 'song_detail';
    n = apiCalls.length;
    r = await json(await post('/ai/lyric-verify', body('880052', 'yt_failsoft002')));
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.ok, r.body.cached], [true, true]);
    const ups = apiCalls.slice(n);
    assert.ok(ups.some(x => x.name === 'lyric') && ups.some(x => x.name === 'song_detail'),
      '重检应走完 词拉取+候选反查 再归不适用');
  } finally { origImpl = null; apiThrow = null; detailSongs = []; lyricVerify._clearDeclaredMemo(); }
});

test('ai：lyric-verify 直判路径 song_detail 抛错 → candidate=null 落回 AI 判定', async () => {
  aiOn = true;
  lyricVerify._clearDeclaredMemo();
  origImpl = async () => ({ title: '本家', author: '本家P' });
  lyricPayload = { lrc: { lyric: '[00:01.00] 作曲 : wholicoji\n[00:02.00]行きたくない' }, tlyric: { lyric: '' } };
  apiThrow = 'song_detail';
  aiAnswer = { ok: true };
  try {
    const n = apiCalls.length;
    const nAi = aiCalls.length;
    const r = await json(await post('/ai/lyric-verify', {
      id: '880053', sourceTitle: 't', sourceAuthor: 'a', trackId: 'yt_failsoft003',
    }));
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.inconclusive, undefined);   // 走完判定而非故障兜底放行
    assert.ok(aiCalls.length > nAi, 'candidate 缺席应落回 judgeLyricLines 问模型');
    assert.equal(apiCalls.slice(n).filter(x => x.name === 'song_detail').length, 1);
    // 判定照常落库——补料故障不固化 inconclusive
    assert.ok(lyricAiRepo.getVerdict(
      lyricVerify.lyricVerdictKey('880053', 't', 'a', false, true), 'lyric'));
  } finally { origImpl = null; apiThrow = null; detailSongs = []; lyricVerify._clearDeclaredMemo(); }
});

test('ai：fetchByExtId 查无词 → verify 按 no-lyric 放行、translate 404', async () => {
  aiOn = true;
  extHit = null; // kugou_ 出缓存即无反查通道的形态
  const rv = await json(await post('/ai/lyric-verify', {
    id: 'kugou_gone99', sourceTitle: 'x', sourceAuthor: '',
  }));
  assert.equal(rv.status, 200);
  assert.equal(rv.body.reason, 'no-lyric');
  const rt = await post('/ai/lyric-translate', { id: 'kugou_gone99' });
  assert.equal(rt.status, 404);
});

test('ai：kugou_ 查无词不写 skip 哨兵（null 是「无取词通道」非「确证无词」）；ytm_ 照写', async () => {
  aiOn = true;
  extHit = null;
  extCalls.length = 0;
  // ai-translate 限流按 clientIp 分桶（8/min）且只计未命中——前置用例已把
  // 'local' 桶打近满。TRUST_PROXY=1 下 clientIp 取 XFF 末跳：给本用例每发
  // 独立 IP，限流桶互不挤占（env 逐请求现读，用毕还原）
  const prevTp = process.env.TRUST_PROXY;
  process.env.TRUST_PROXY = '1';
  const postIp = (ip, id) => app.request('http://t/ai/lyric-translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ id }),
  });
  try {
    // kugou_：404 但不落哨兵——重放重查反查（每次都真打 fetchByExtId）
    await postIp('10.9.0.1', 'kugou_sentinel01');
    assert.equal(lyricAiRepo.getCachedTranslation('kugou_sentinel01', 'test-model'), undefined);
    const n = extCalls.length;
    const rt = await postIp('10.9.0.2', 'kugou_sentinel01');
    assert.equal(rt.status, 404);
    assert.equal(extCalls.length, n + 1); // 无哨兵可吃——重放又走反查
    // ytm_/lrclib_ 的 null 是真无词——哨兵照写，重放吃缓存不再反查
    await postIp('10.9.0.3', 'ytm_sentinel001');
    const hit = lyricAiRepo.getCachedTranslation('ytm_sentinel001', 'test-model');
    assert.ok(hit, 'ytm_ 应落 skip 哨兵');
    const m = extCalls.length;
    const r2 = await json(await postIp('10.9.0.4', 'ytm_sentinel001'));
    assert.equal(r2.status, 200);
    assert.equal(r2.body.cached, true);
    assert.equal(extCalls.length, m); // 哨兵命中不再反查
  } finally {
    if (prevTp === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = prevTp;
  }
});

// ── already-zh 判定收口在 isLikelyChineseLyric ──
// 少女レイ 实案病灶：日文词汉字密度 30-50% 常态——旧 cjkRatio 只数汉字占比，
// CJK≈0.385 的假名混排词被判「已是中文」跳过翻译。假名/谚文在场即「需要
// 翻译」硬证据；用例经独立 XFF IP 隔离限流桶（'local' 桶已被前置用例占近满）
const postTranslateIp = (ip, id) => app.request('http://t/ai/lyric-translate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
  body: JSON.stringify({ id }),
});

test('ai：日文汉字+假名混排词（CJK>0.3）不再 already-zh skip——走到 AI 翻译分支', async () => {
  aiOn = true;
  lyricPayload = {
    lrc: { lyric: '[00:01.00]本能が狂い始める 追い詰められたハツカネズミ\n[00:02.00]今 絶望の淵に立って 踏切へと飛び出した' },
    tlyric: { lyric: '' },   // 无官方译文的日文词——旧实现在这里被 skip 拦死
  };
  aiAnswer = { t: { '0': '本能开始发狂 被逼入绝境的旅鼠', '1': '此刻立于绝望深渊 纵身跃向道口' } };
  const prevTp = process.env.TRUST_PROXY;
  process.env.TRUST_PROXY = '1';
  try {
    const r = await json(await postTranslateIp('10.8.1.1', '880060'));
    assert.equal(r.status, 200);
    assert.equal(r.body.source, 'ai');              // 走到 AI 翻译分支
    assert.equal(r.body.skipped, undefined);        // 不是 already-zh skip
    assert.match(r.body.tlyric, /\[00:01\.00\]本能开始发狂/);
  } finally {
    if (prevTp === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = prevTp;
  }
});

test('ai：纯中文词仍 already-zh skip（判定在模型前——零 AI 消耗）', async () => {
  lyricPayload = {
    lrc: { lyric: '[00:01.00]我看过沙漠下暴雨\n[00:02.00]看过大海亲吻鲨鱼\n[00:03.00]看过黄昏追逐黎明' },
    tlyric: { lyric: '' },
  };
  const before = aiCalls.length;
  const prevTp = process.env.TRUST_PROXY;
  process.env.TRUST_PROXY = '1';
  try {
    const r = await json(await postTranslateIp('10.8.1.2', '880061'));
    assert.equal(r.status, 200);
    assert.equal(r.body.skipped, 'already-zh');
    assert.equal(r.body.tlyric, null);
    assert.equal(aiCalls.length, before);   // skip 判定短路——没烧模型
  } finally {
    if (prevTp === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = prevTp;
  }
});

// ── POST CSRF 纵深（F4）+ 纯文本词兜底取样（F1 收口）──────────────────

test('ai：两处 POST 端点异源 Origin / cross-site 信号 → 403；无源非浏览器客户端照旧放行', async () => {
  aiOn = true;
  // 异源 Origin 双端点同拒——403 先于限流/解析/上游，不烧配额
  for (const p of ['/ai/lyric-translate', '/ai/lyric-verify']) {
    const r = await app.request(`http://t${p}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', origin: 'http://evil.example' },
      body: JSON.stringify({ id: '880070', sourceTitle: 'x', sourceAuthor: 'a' }),
    });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).code, 403);
  }
  // Origin 缺席但 fetch 元数据报跨站 → 同拒（二级纵深）
  const r2 = await app.request('http://t/ai/lyric-translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify({ id: '880070' }),
  });
  assert.equal(r2.status, 403);
  // 非浏览器客户端（无 Origin 无跨站元数据）照旧放行——CSRF 只拦跨站形态
  lyricPayload = { lrc: { lyric: '[00:01.00]x' }, tlyric: { lyric: '' } };
  aiAnswer = { ok: true };
  const r3 = await json(await post('/ai/lyric-verify', {
    id: '880070', sourceTitle: 'x', sourceAuthor: '',
  }));
  assert.equal(r3.status, 200);
  assert.equal(r3.body.ok, true);
});

test('ai：lyric-verify 纯文本词兜底取样——有词文照判、真空仍 no-lyric', async () => {
  aiOn = true;
  // 无时戳有词文的纯文本词不再零核验（与 verifyHit 同口径）——剥标签行
  // 仍有词文的进判定链；纯元行剥完真空才按「没词可验」放行
  extHit = { lrc: '純文一\n純文二\n純文三', source: 'lrclib', extId: 'lrclib_plain01', synced: false };
  aiAnswer = { ok: false };
  try {
    const r = await json(await post('/ai/lyric-verify', {
      id: 'lrclib_plain01', sourceTitle: '某曲', sourceAuthor: 'a',
    }));
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.reason, undefined);
    assert.match(aiCalls.at(-1).user, /純文一/);   // 词文进了判定抽样
    // 剥完真空（纯元行）仍走 no-lyric 放行——没烧模型
    extHit = { lrc: '[ti:某曲]\n[ar:某艺]', source: 'lrclib', extId: 'lrclib_plain02', synced: false };
    const nAi = aiCalls.length;
    const r2 = await json(await post('/ai/lyric-verify', {
      id: 'lrclib_plain02', sourceTitle: '某曲', sourceAuthor: 'a',
    }));
    assert.equal(r2.status, 200);
    assert.equal(r2.body.ok, true);
    assert.equal(r2.body.reason, 'no-lyric');
    assert.equal(aiCalls.length, nAi);
  } finally { extHit = null; }
});

// ── 源发布日证据（publishedAt → vkey c1 语境位 / pubSeg）──
// chrono-guard：客户端持久快照（body.publishedAt）优先、yt_ 缺席惰性反解；
// 仅网易条目词源配日期轴——extId 无候选日期对照轴（与级联/下载链键面守恒）。
// 用例经独立 XFF IP 隔离限流桶（'local' 桶已被前置用例占近满）
const postVerifyIp = (ip, body) => app.request('http://t/ai/lyric-verify', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
  body: JSON.stringify(body),
});

test('ai：lyric-verify body.publishedAt 接受→c1 键+来源发布日进 prompt；出窗脏值丢弃', async () => {
  aiOn = true;
  lyricVerify._clearDeclaredMemo();
  lyricPayload = { lrc: { lyric: '[00:01.00]chrono line\n[00:02.00]other' }, tlyric: { lyric: '' } };
  aiAnswer = { ok: true };
  const prevTp = process.env.TRUST_PROXY;
  process.env.TRUST_PROXY = '1';
  try {
    const nPub = pubCalls.length;
    const r = await json(await postVerifyIp('10.7.0.1', {
      id: '880080', sourceTitle: 'chrono-src', sourceAuthor: 'a',
      publishedAt: Date.parse('2020-04-07'),
    }));
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    // body 直吃零上行——快照在手不经 yt_ 惰性反解
    assert.equal(pubCalls.length, nPub);
    // c1 键位实锤：verdict 落 v2c1 盐键，无 c1 旧键面不被携日期判定写到
    assert.ok(lyricAiRepo.getVerdict(
      lyricVerify.lyricVerdictKey('880080', 'chrono-src', 'a', false, false, true), 'lyric'));
    assert.ok(!lyricAiRepo.getVerdict(
      lyricVerify.lyricVerdictKey('880080', 'chrono-src', 'a'), 'lyric'));
    assert.match(aiCalls.at(-1).user, /来源发布日：2020-04-07/);
    // 出窗脏值（2000 前/超 now+24h 的合法数值）→ sanePublishMs 丢弃按未注：
    // 落无 c1 旧键、prompt 无日期段（schema 前的服务端正校验面——非数值
    // 型脏值由 looseObject/zod 面拦截，这里钉的是过 schema 后的语义窗）
    for (const [i, dirty] of [Date.parse('1999-01-01'), Date.now() + 10 * 86400e3].entries()) {
      const rid = `880081${i}`;
      const r2 = await json(await postVerifyIp('10.7.0.1', {
        id: rid, sourceTitle: 't', sourceAuthor: 'a', publishedAt: dirty,
      }));
      assert.equal(r2.status, 200);
      assert.ok(lyricAiRepo.getVerdict(lyricVerify.lyricVerdictKey(rid, 't', 'a'), 'lyric'));
      assert.ok(!lyricAiRepo.getVerdict(
        lyricVerify.lyricVerdictKey(rid, 't', 'a', false, false, true), 'lyric'));
    }
    assert.ok(!aiCalls.at(-1).user.includes('来源发布日'));
    assert.equal(pubCalls.length, nPub);   // 无 trackId——脏值丢弃后也无回退
  } finally {
    if (prevTp === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = prevTp;
    lyricVerify._clearDeclaredMemo();
  }
});

test('ai：lyric-verify yt_ trackId+网易词源→惰性反解携 c1；extId/无 trackId 零解析', async () => {
  aiOn = true;
  lyricVerify._clearDeclaredMemo();
  origImpl = null;
  pubImpl = async () => Date.parse('2020-04-07');
  lyricPayload = { lrc: { lyric: '[00:01.00]chrono line\n[00:02.00]other' }, tlyric: { lyric: '' } };
  aiAnswer = { ok: true };
  const prevTp = process.env.TRUST_PROXY;
  process.env.TRUST_PROXY = '1';
  try {
    // yt_ trackId + 网易 id + body 未注 → 惰性反解（与 declared 同位同价）
    const nPub = pubCalls.length;
    const nApi = apiCalls.length;
    // wantDates 接线钉（本案主流形态端到端）：无声明/无署名行 + srcPubMs>0
    // → song_detail 补料被调，取回的 publishTime 进判定 prompt 上架段
    detailSongs = [{ name: '墨田区 SUMMER NIGHT', ar: [{ name: '未来電波基地' }],
      publishTime: Date.parse('2024-03-18') }];
    const r = await json(await postVerifyIp('10.7.0.2', {
      id: '880082', sourceTitle: 'chrono-src', sourceAuthor: 'a', trackId: 'yt_pubvid00001',
    }));
    assert.equal(r.status, 200);
    assert.equal(pubCalls.length, nPub + 1);
    assert.equal(pubCalls.at(-1).videoId, 'pubvid00001');
    // c1 键位实锤：verdict 落携日期语境键；prompt 携来源发布日
    assert.ok(lyricAiRepo.getVerdict(
      lyricVerify.lyricVerdictKey('880082', 'chrono-src', 'a', false, false, true), 'lyric'));
    assert.match(aiCalls.at(-1).user, /来源发布日：2020-04-07/);
    assert.equal(apiCalls.slice(nApi).filter(x => x.name === 'song_detail').length, 1);
    assert.match(aiCalls.at(-1).user, /\/ 上架 2024-03-18/);
    detailSongs = [];
    // 快照优先钉：trackId+body.publishedAt 同发——body 值直吃，惰性解析
    // 不发起（pubCalls 不变），vkey 仍携 c1
    const nPubS = pubCalls.length;
    const rS = await json(await postVerifyIp('10.7.0.2', {
      id: '880084', sourceTitle: 'chrono-src', sourceAuthor: 'a',
      trackId: 'yt_pubvid00004', publishedAt: Date.parse('2021-06-01'),
    }));
    assert.equal(rS.status, 200);
    assert.equal(pubCalls.length, nPubS);
    assert.ok(lyricAiRepo.getVerdict(
      lyricVerify.lyricVerdictKey('880084', 'chrono-src', 'a', false, false, true), 'lyric'));
    assert.match(aiCalls.at(-1).user, /来源发布日：2021-06-01/);
    // extId 词源（ytm_）：trackId+publishedAt 齐在场也不解析不携 c1——
    // 无候选日期对照轴，与级联 verifyHit 键面守恒互命中
    extHit = { lrc: '[00:01.00]ext line\n[00:02.00]x', source: 'ytm', extId: 'ytm_chrono01', synced: true };
    const nPub2 = pubCalls.length;
    const r2 = await json(await postVerifyIp('10.7.0.2', {
      id: 'ytm_chrono01', sourceTitle: 't', sourceAuthor: 'a', trackId: 'yt_pubvid00002',
      publishedAt: Date.parse('2020-04-07'),
    }));
    assert.equal(r2.status, 200);
    assert.equal(r2.body.ok, true);
    assert.equal(pubCalls.length, nPub2);
    assert.ok(lyricAiRepo.getVerdict(
      lyricVerify.lyricVerdictKey('ytm_chrono01', 't', 'a'), 'lyric'));  // 无 c1 旧键
    // qq_ 词源 id：L203 形态闸 400 拒在解析面前——连 declared/srcPubMs 都不发起
    const nPubQ = pubCalls.length;
    const rq = await postVerifyIp('10.7.0.2', {
      id: 'qq_chrono001', sourceTitle: 't', sourceAuthor: 'a', trackId: 'yt_pubvid00003',
      publishedAt: Date.parse('2020-04-07'),
    });
    assert.equal(rq.status, 400);
    assert.equal(pubCalls.length, nPubQ);
    // body/trackId 双缺 → 无源可解不解析（无日期旧路径逐位不动）
    const nPub3 = pubCalls.length;
    const r3 = await json(await postVerifyIp('10.7.0.2', { id: '880083', sourceTitle: 't', sourceAuthor: 'a' }));
    assert.equal(r3.status, 200);
    assert.equal(pubCalls.length, nPub3);
  } finally {
    if (prevTp === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = prevTp;
    origImpl = null; pubImpl = null; extHit = null; detailSongs = []; lyricVerify._clearDeclaredMemo();
  }
});

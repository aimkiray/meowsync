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
const aiCalls = [];
seed('../src/server/lib/ai.js', {
  aiEnabled: () => aiOn,
  aiModel: () => 'test-model',
  askAiJson: async (args) => { aiCalls.push(args); return aiAnswer; },
});
let lyricPayload = { lrc: { lyric: '' }, tlyric: { lyric: '' } };
seed('../src/server/services/netease-api.js', {
  callNeteaseApi: async () => ({ body: lyricPayload }),
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

let app, lyricAiRepo;
before(() => {
  app = require('../src/server/routes/ai.js');
  lyricAiRepo = require('../src/server/repositories/lyricAi.js');
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

test('ai：无歌词源 → 404 + skip 落库（重放不再打上游）', async () => {
  lyricPayload = { lrc: { lyric: '' }, tlyric: { lyric: '' } };
  const r = await post('/ai/lyric-translate', { id: '880003' });
  assert.equal(r.status, 404);
  // skip 哨兵也是有效缓存行
  const r2 = await json(await post('/ai/lyric-translate', { id: '880003' }));
  assert.equal(r2.status, 200);
  assert.equal(r2.body.cached, true);
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

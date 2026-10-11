// 自源发布日产线回归网（日期产线 §4.1）：
//   1) 提取序——microformat.publishDate 主取 / uploadDate 回落 / 全缺归 null
//   2) basicsMemo 纪律——同 videoId 单飞去重、TTL 分档（发布日在手 6h；
//      发布日缺席 10min 负结果短窗）、cap/FIFO、_clearBasicsMemo 清后重打
//   3) 共享跳——一条 player 上行同时喂描述轴（resolveOriginalInfo）与
//      发布日轴（resolvePublishedAt），两轴同吃零边际
//   4) player 直给——/resolve 解析期一手新料零上行提取 + 写穿焐热 memo
//   5) fail-soft——fetch 全灭/调用方 abort 一律归 null 不抛
//   6) 脏日期——下限前/超未来窗/非日期串/非串值全归 null
// fetch 层桩法与 youtube-original.test.mjs 同口径：stub globalThis.fetch
// 喂真实 player 响应形态，lib/settings 预播种防真 settings 开 dev DB。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { seed } from './helpers.mjs';

const require = createRequire(import.meta.url);
seed('../src/server/lib/settings.js', { effectiveValue: () => null });
const {
  resolveOriginalInfo, resolvePublishedAt, _clearOriginalMemo, _clearBasicsMemo
} = require('../src/server/lib/youtube.js');

const realFetch = globalThis.fetch;
// playerBody(over, mf)：videoDetails 字段经 over 覆写；mf 非 null 时挂
// microformat.playerMicroformatRenderer（发布日数据位）
const playerBody = (over = {}, mf = null) => ({
  playabilityStatus: { status: 'OK' },
  streamingData: { adaptiveFormats: [] },
  videoDetails: { videoId: 'x', title: 'T', author: 'A', shortDescription: '', ...over },
  ...(mf ? { microformat: { playerMicroformatRenderer: mf } } : {}),
});
let players = {};
const fetchCalls = [];
const stubFetch = () => {
  fetchCalls.length = 0;
  _clearOriginalMemo();  // 连带清 basicsMemo——两簿同清保持链冷
  _clearBasicsMemo();
  globalThis.fetch = async (url, opt) => {
    const u = typeof url === 'string' ? url : String(url);
    const id = u.match(/[?&]videoId=([^&]+)/)?.[1]
      ?? (opt?.body ? String(opt.body).match(/"videoId"\s*:\s*"([^"]+)"/)?.[1] : null);
    if (id) fetchCalls.push(id);
    const body = players[id];
    if (body instanceof Error) return { ok: false, status: 200, json: async () => { throw body; } };
    if (body) return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    return { ok: false, status: 404, json: async () => ({}), text: async () => '{}' };
  };
};
const restore = () => { globalThis.fetch = realFetch; players = {}; };
const playerFetches = () => fetchCalls.filter(c => /^[A-Za-z0-9_-]{11}$/.test(c));

// ── 1) 提取序 ──────────────────────────────────────────────────────────
test('resolvePublishedAt：publishDate 主取 / uploadDate 回落 / 全缺归 null', async () => {
  stubFetch();
  try {
    players = { vid00000001: playerBody({}, { publishDate: '2020-04-07' }) };
    assert.equal(await resolvePublishedAt({ videoId: 'vid00000001' }),
      Date.parse('2020-04-07'));
    // publishDate 优先——uploadDate 同在场不抢位（定时首播公开日是前者）
    players = { vid00000002: playerBody({},
      { publishDate: '2020-04-07', uploadDate: '2019-01-01' }) };
    assert.equal(await resolvePublishedAt({ videoId: 'vid00000002' }),
      Date.parse('2020-04-07'));
    players = { vid00000003: playerBody({}, { uploadDate: '2021-11-30' }) };
    assert.equal(await resolvePublishedAt({ videoId: 'vid00000003' }),
      Date.parse('2021-11-30'));
    // microformat 整段缺席（部分客户端形态常态）与双字段缺席同归 null
    players = { vid00000004: playerBody(), vid00000005: playerBody({}, {}) };
    assert.equal(await resolvePublishedAt({ videoId: 'vid00000004' }), null);
    assert.equal(await resolvePublishedAt({ videoId: 'vid00000005' }), null);
  } finally { restore(); }
});

// ── 2) basicsMemo 纪律 ─────────────────────────────────────────────────
test('basicsMemo：同 videoId 单飞；分档 TTL；cap/FIFO；清簿重打', async () => {
  stubFetch();
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    players = { vid00000001: playerBody({}, { publishDate: '2020-04-07' }) };
    assert.equal(await resolvePublishedAt({ videoId: 'vid00000001' }),
      Date.parse('2020-04-07'));
    const n = fetchCalls.length;
    assert.equal(await resolvePublishedAt({ videoId: 'vid00000001' }),
      Date.parse('2020-04-07'));
    assert.equal(fetchCalls.length, n);              // 落地命中——零回源
    // 并发首调单飞去重（与 origMemo 同纪律）
    _clearBasicsMemo(); fetchCalls.length = 0;
    const [a, b] = await Promise.all([
      resolvePublishedAt({ videoId: 'vid00000001' }),
      resolvePublishedAt({ videoId: 'vid00000001' }),
    ]);
    assert.equal(a, Date.parse('2020-04-07'));
    assert.equal(b, a);
    assert.deepEqual(playerFetches(), ['vid00000001']);
    // 拿到发布日的落地按 6h 正档——挺过 null 窗（11min）不重打
    offset = 11 * 60e3;
    assert.equal(await resolvePublishedAt({ videoId: 'vid00000001' }),
      Date.parse('2020-04-07'));
    assert.equal(fetchCalls.length, 1);
    // 发布日缺席（microformat 缺形态）按 10min 负档——过窗给形态轮替
    // 一次翻身机会（fetchVideoBasicsOnce 不炸即不固化「它没有」）
    players.vid00000002 = playerBody({ shortDescription: '没有声明' });
    assert.equal(await resolvePublishedAt({ videoId: 'vid00000002' }), null);
    const n2 = fetchCalls.length;
    assert.equal(await resolvePublishedAt({ videoId: 'vid00000002' }), null);
    assert.equal(fetchCalls.length, n2);             // 负窗内不重打
    offset = 22 * 60e3;                              // 过负窗 → 重打
    assert.equal(await resolvePublishedAt({ videoId: 'vid00000002' }), null);
    assert.ok(fetchCalls.length > n2);
    // _clearBasicsMemo 清簿后重打
    _clearBasicsMemo(); fetchCalls.length = 0;
    assert.equal(await resolvePublishedAt({ videoId: 'vid00000001' }),
      Date.parse('2020-04-07'));
    assert.equal(fetchCalls.length, 1);
  } finally { Date.now = realNow; restore(); }
});

test('basicsMemo：cap=500 FIFO 挤出最旧', async () => {
  stubFetch();
  try {
    const ids = [];
    for (let i = 0; i < 500; i++) {
      const id = `vid${String(i).padStart(8, '0')}`;
      ids.push(id);
      players[id] = playerBody({}, { publishDate: '2020-04-07' });
    }
    await Promise.all(ids.map(id => resolvePublishedAt({ videoId: id })));
    assert.equal(playerFetches().length, 500);
    // 第 501 条挤掉最旧——最旧再调要重打
    players.vid00000500 = playerBody({}, { publishDate: '2021-05-20' });
    await resolvePublishedAt({ videoId: 'vid00000500' });
    fetchCalls.length = 0;
    await resolvePublishedAt({ videoId: 'vid00000000' });   // 被挤 → 重打
    assert.deepEqual(playerFetches(), ['vid00000000']);
    await resolvePublishedAt({ videoId: 'vid00000500' });   // 未挤 → 命中
    assert.deepEqual(playerFetches(), ['vid00000000']);
  } finally { restore(); }
});

// ── 3) 共享跳：一喂两轴 ────────────────────────────────────────────────
test('共享跳：本家声明与发布日解析同吃一跳 player——两轴零边际', async () => {
  stubFetch();
  try {
    players = {
      vid00000001: playerBody({ shortDescription: '本家：shima - Moonlight' },
        { publishDate: '2020-04-07' }),
    };
    // 描述轴先行：self 跳落地 basics，发布日轴吃同一本 memo
    const orig = await resolveOriginalInfo({ videoId: 'vid00000001' });
    assert.deepEqual(orig, { title: 'Moonlight', author: 'shima' });
    const n = playerFetches().length;
    assert.equal(await resolvePublishedAt({ videoId: 'vid00000001' }),
      Date.parse('2020-04-07'));
    assert.equal(playerFetches().length, n);         // 第二轴零上行
    // 反向次序同效：发布日轴先行的落地喂饱描述轴
    _clearOriginalMemo(); _clearBasicsMemo(); fetchCalls.length = 0;
    assert.equal(await resolvePublishedAt({ videoId: 'vid00000001' }),
      Date.parse('2020-04-07'));
    assert.deepEqual(await resolveOriginalInfo({ videoId: 'vid00000001' }),
      { title: 'Moonlight', author: 'shima' });
    assert.equal(playerFetches().length, 1);         // 两轴共享唯一一跳
  } finally { restore(); }
});

// ── 4) player 直给 + 写穿焐热 ──────────────────────────────────────────
test('resolvePublishedAt：player 直给零上行；写穿焐热 memo 并覆盖陈旧负条目', async () => {
  stubFetch();
  try {
    const player = playerBody({ shortDescription: '本家：shima - Moonlight' },
      { publishDate: '2020-04-07' });
    const ms = await resolvePublishedAt({ videoId: 'vid00000001', player });
    assert.equal(ms, Date.parse('2020-04-07'));
    assert.equal(fetchCalls.length, 0);              // 直给零上行
    // 写穿焐热：随后无 player 的发布日调用命中同一本 memo
    assert.equal(await resolvePublishedAt({ videoId: 'vid00000001' }),
      Date.parse('2020-04-07'));
    assert.equal(fetchCalls.length, 0);
    // 描述轴同焐——resolveOriginalInfo 也不再回源
    assert.deepEqual(await resolveOriginalInfo({ videoId: 'vid00000001' }),
      { title: 'Moonlight', author: 'shima' });
    assert.equal(fetchCalls.length, 0);
    // 一手新料覆盖陈旧负条目：microformat 缺形态的落地不该挡住
    // 解析期直给的真发布日
    players = { vid00000002: playerBody() };
    assert.equal(await resolvePublishedAt({ videoId: 'vid00000002' }), null);
    const ms2 = await resolvePublishedAt({ videoId: 'vid00000002',
      player: playerBody({}, { publishDate: '2021-01-15' }) });
    assert.equal(ms2, Date.parse('2021-01-15'));
    assert.equal(await resolvePublishedAt({ videoId: 'vid00000002' }),
      Date.parse('2021-01-15'));                     // 覆盖已落簿
    fetchCalls.length = 0;
    assert.equal(await resolvePublishedAt({ videoId: 'vid00000002' }),
      Date.parse('2021-01-15'));
    assert.equal(fetchCalls.length, 0);              // 覆盖条目继续喂
    // merge 不降级钉：簿内焓热正条目 {publishedAt, description} 不被本次缺
    // microformat/描述形态的直给写穿成双 null——两轴都是单调事实，新 null
    // 不盖旧真值（修复前会写穿降级成 10min 负窗）
    players = { vid00000003: playerBody({ shortDescription: '本家：shima - Moonlight' },
      { publishDate: '2020-04-07' }) };
    assert.equal(await resolvePublishedAt({ videoId: 'vid00000003' }),
      Date.parse('2020-04-07'));                     // 焓热正条目落簿
    const ms3 = await resolvePublishedAt({ videoId: 'vid00000003',
      player: playerBody({ shortDescription: undefined }) });   // 直给两轴全缺
    assert.equal(ms3, Date.parse('2020-04-07'));     // merge 后旧真值续命
    fetchCalls.length = 0;
    assert.equal(await resolvePublishedAt({ videoId: 'vid00000003' }),
      Date.parse('2020-04-07'));                     // 6h 正档而非 10min 负窗
    assert.equal(fetchCalls.length, 0);
    assert.deepEqual(await resolveOriginalInfo({ videoId: 'vid00000003' }),
      { title: 'Moonlight', author: 'shima' });      // 描述轴同保真
    assert.equal(fetchCalls.length, 0);
  } finally { restore(); }
});

// ── 5) fail-soft ───────────────────────────────────────────────────────
test('resolvePublishedAt：fail-soft——fetch 全灭/abort 归 null 不抛', async () => {
  stubFetch();
  try {
    players = { vid00000001: new Error('LOGIN_REQUIRED') };
    assert.equal(await resolvePublishedAt({ videoId: 'vid00000001' }), null);
    // 入场即 abort：不进场不占簿位（与 origMemo 早退同口径）
    const ac = new AbortController();
    ac.abort();
    fetchCalls.length = 0;
    assert.equal(await resolvePublishedAt({ videoId: 'vid00000002', signal: ac.signal }), null);
    assert.equal(fetchCalls.length, 0);
    // 在途 abort：共享计算不吃本调用方 signal——真值照落簿，本调用方
    // 归 null；abort 不固化伪 null，后续调用方吃到真值
    players = { vid00000003: playerBody({}, { publishDate: '2020-04-07' }) };
    const ac2 = new AbortController();
    const p = resolvePublishedAt({ videoId: 'vid00000003', signal: ac2.signal });
    ac2.abort();
    assert.equal(await p, null);
    assert.equal(await resolvePublishedAt({ videoId: 'vid00000003' }),
      Date.parse('2020-04-07'));
  } finally { restore(); }
});

// ── 6) 脏日期 ──────────────────────────────────────────────────────────
test('resolvePublishedAt：脏日期归 null——下限前/超未来窗/非日期串/非串值', async () => {
  stubFetch();
  try {
    const cases = [
      // 下限前真值：规格 §4.7 夹具原文写的 '2004-12-31' 实过 §3.1 窗
      // （Date.parse=1104451200000 ≥ 946684800000 下限 2000-01-01）——
      // 夹具与 canonical 公式冲突处按公式为准，取窗下真值
      { publishDate: '1999-12-31' },
      { publishDate: '2999-01-01' },                    // 超 now+24h 未来窗
      { publishDate: 'garbage' },                       // 非日期串
      { publishDate: 5 },                               // 数字原始值按 ms 轴消毒——5ms 窗下
      { publishDate: null },                            // null 原始值
      { uploadDate: '1980-06-01' },                     // 回落轴同样过窗
      { publishDate: '2020-13-45' },                    // 伪 ISO——parse 落 NaN
    ];
    for (let i = 0; i < cases.length; i++) {
      const id = `vid${String(i).padStart(8, '0')}`;
      players[id] = playerBody({}, cases[i]);
      assert.equal(await resolvePublishedAt({ videoId: id }), null,
        `case ${i} ${JSON.stringify(cases[i])} 应归 null`);
    }
  } finally { restore(); }
});

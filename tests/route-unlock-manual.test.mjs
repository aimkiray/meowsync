// routes/unlock-manual.js 冒烟：GET 未绑 404 / POST 点名绑定（服务端先
// resolveById 真取流验证再落库——只存指针不存回链，签名 url 不入库不入包）
// / DELETE 幂等解绑 / id·source·mediaId 严校闸 / CSRF 写闸 / 限流桶 /
// candidates 两源扇出（故障隔离/双灭 502/keyword 兜底派生与回显）。
// 真 repo/真库 + seed 桩 netease 门面/unlock 门面——绑定持久化语义桩测不出。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { seed, tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-runlockmanual-');
// 限流桶按 IP 分：TRUST_PROXY 开后每用例给独立 XFF——用例间互不消耗配额
process.env.TRUST_PROXY = '1';
const require = createRequire(import.meta.url);

// AI 层桩——netease-api require 链挂着 lib/ai（规整面）
seed('../src/server/lib/ai.js', {
  aiEnabled: () => false,
  aiModel: () => 'test-model',
  askAiJson: async () => null,
});

// 网易门面桩：song_detail 供 candidates 端点 keyword 兜底派生
const detailCalls = [];
let songDetailImpl = async (ids) => ({
  body: { songs: ids.map(id => ({ id, dt: 200000, name: `n${id}`, ar: [{ name: 'a' }, { name: 'b' }] })) },
});
seed('../src/server/services/netease/index.js', {
  callNeteaseApi: async (name, params) => {
    detailCalls.push({ name, params });
    if (name === 'song_detail') return songDetailImpl(String(params.ids).split(',').map(Number));
    throw new Error(`unexpected api ${name}`);
  },
  apiModules: {},
});

// provider 桩：search/resolveById 可编程；forgetSong 记账实参（验
// forgetSongUnlock 必调）。验流产物带签名 url——断言它绝不进库行/回包
const SIGNED_YT = 'https://rr1---sn-x.googlevideo.com/videoplayback?sig=SECRETYT&ip=1.2.3.4';
const SIGNED_BV = 'https://upos-sz-m1.bilivideo.com/ugax/x.m4s?sig=SECRETBV&uip=1.2.3.4';
const searchCalls = [];
const resolveByIdCalls = [];
const forgetCalls = [];
let ytSearchImpl = async () => [];
let bvSearchImpl = async () => [];
let ytResolveByIdImpl = async () => ({ url: SIGNED_YT, urls: [SIGNED_YT], br: 128000, durationSec: null });
let bvResolveByIdImpl = async () => ({ url: SIGNED_BV, urls: [SIGNED_BV], br: 192000, durationSec: null });
seed('../src/server/services/unlock/index.js', {
  PROVIDERS: {
    youtube: {
      search: async (kw, o) => { searchCalls.push({ source: 'youtube', keyword: kw }); return ytSearchImpl(kw, o); },
      resolveById: async (mediaId, o) => {
        resolveByIdCalls.push({ source: 'youtube', mediaId, ctx: o });
        return ytResolveByIdImpl(mediaId, o);
      },
      forgetSong: (id) => forgetCalls.push(`yt:${id}`),
    },
    bilibili: {
      search: async (kw, o) => { searchCalls.push({ source: 'bilibili', keyword: kw }); return bvSearchImpl(kw, o); },
      resolveById: async (mediaId, o) => {
        resolveByIdCalls.push({ source: 'bilibili', mediaId, ctx: o });
        return bvResolveByIdImpl(mediaId, o);
      },
      forgetSong: (id) => forgetCalls.push(`bv:${id}`),
    },
  },
  PLAYBACK_SOURCES: ['pyncmd', 'youtube', 'bilibili'],
  DOWNLOAD_SOURCES: ['pyncmd', 'youtube', 'bilibili'],
});

let app, repo;
before(() => {
  app = require('../src/server/routes/unlock-manual.js');
  repo = require('../src/server/repositories/unlockManual.js');
});
after(() => {
  delete process.env.TRUST_PROXY;
  rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

let ipSeq = 10;
const nextIp = () => `10.11.${++ipSeq}.1`;
const json = async (res) => ({ status: res.status, body: await res.json().catch(() => null) });
const getCand = (qs, ip = nextIp()) => app.request(
  `http://t/unlock/candidates?${qs}`,
  { headers: { 'x-forwarded-for': ip } });
const getM = (id, ip = nextIp()) => app.request(
  `http://t/unlock/manual?id=${encodeURIComponent(id)}`,
  { headers: { 'x-forwarded-for': ip } });
const post = (body, ip = nextIp(), headers = {}) => app.request('http://t/unlock/manual', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip, ...headers },
  body: JSON.stringify(body),
});
const del = (id, ip = nextIp(), headers = {}) => app.request(
  `http://t/unlock/manual?id=${encodeURIComponent(id)}`,
  { method: 'DELETE', headers: { 'x-forwarded-for': ip, ...headers } });
const resetStubs = () => {
  searchCalls.length = 0; resolveByIdCalls.length = 0; forgetCalls.length = 0;
  detailCalls.length = 0;
  ytSearchImpl = async () => [];
  bvSearchImpl = async () => [];
  ytResolveByIdImpl = async () => ({ url: SIGNED_YT, urls: [SIGNED_YT], br: 128000, durationSec: null });
  bvResolveByIdImpl = async () => ({ url: SIGNED_BV, urls: [SIGNED_BV], br: 192000, durationSec: null });
  songDetailImpl = async (ids) => ({
    body: { songs: ids.map(id => ({ id, dt: 200000, name: `n${id}`, ar: [{ name: 'a' }, { name: 'b' }] })) },
  });
};

test('GET 未绑 404 → POST 点名绑定 → GET 命中 → DELETE 解绑 → 二次 DELETE 幂等', async () => {
  const ip = nextIp();
  resetStubs();
  const unbound = await json(await getM('880200', ip));
  assert.equal(unbound.status, 404);
  assert.equal(unbound.body.code, 404);

  const r = await json(await post({
    id: '880200', source: 'youtube', mediaId: 'dQw4w9WgXcQ',
    title: '正曲', owner: '频道名', durationSec: 212,
  }, ip));
  assert.equal(r.status, 200);
  assert.equal(r.body.code, 200);
  // 先验证后落库：resolveById 以裸 mediaId 验流（purpose=playback）
  assert.deepEqual(resolveByIdCalls.map(x => `${x.source}:${x.mediaId}`), ['youtube:dQw4w9WgXcQ']);
  assert.equal(resolveByIdCalls[0].ctx.purpose, 'playback');
  assert.equal(r.body.hit.source, 'youtube');
  assert.equal(r.body.hit.mediaId, 'dQw4w9WgXcQ');
  assert.equal(r.body.hit.title, '正曲');
  assert.equal(r.body.hit.owner, '频道名');
  assert.equal(r.body.hit.durationSec, 212);
  assert.ok(r.body.hit.updatedAt, 'hit 须含 updatedAt');
  // 签名 url 不入包不入库（指针表永不存回链）
  assert.ok(!JSON.stringify(r.body).includes('SECRETYT'), '验流产物的签名链不得透进回包');
  const row = repo.getManual('880200');
  assert.equal(row.source, 'youtube');
  assert.equal(row.mediaId, 'dQw4w9WgXcQ');
  assert.ok(!JSON.stringify(row).includes('SECRETYT'), '签名链不得落库');
  // forgetSongUnlock 必调——provider forgetSong 钩记账为证
  assert.deepEqual(forgetCalls.sort(), ['bv:880200', 'yt:880200']);

  const g = await json(await getM('880200', ip));
  assert.equal(g.status, 200);
  assert.equal(g.body.hit.mediaId, 'dQw4w9WgXcQ');
  assert.equal(g.body.hit.durationSec, 212);

  forgetCalls.length = 0;
  assert.equal((await del('880200', ip)).status, 200);
  assert.deepEqual(forgetCalls.sort(), ['bv:880200', 'yt:880200'], '解绑同样 forgetSongUnlock');
  assert.equal((await getM('880200', ip)).status, 404);
  assert.equal((await del('880200', ip)).status, 200, 'DELETE 幂等：没绑过也 200');
});

test('id 归一：\'000123\' 前导零形过闸后按 \'123\' 落库/读口/解绑——防僵尸绑定（R1-N4）', async () => {
  const ip = nextIp();
  resetStubs();
  const r = await json(await post({
    id: '000123', source: 'youtube', mediaId: 'dQw4w9WgXcQ',
    title: 't', owner: 'o', durationSec: 200,
  }, ip));
  assert.equal(r.status, 200);
  // 落库键必须归一到数值形——resolveOne 消费键是 String(item.id)='123'
  assert.equal(repo.getManual('123')?.mediaId, 'dQw4w9WgXcQ', '绑定键须归一到数值形');
  assert.equal(repo.getManual('000123'), null, '前导零键不得落库');
  assert.deepEqual(forgetCalls.sort(), ['bv:123', 'yt:123'],
    'forgetSongUnlock 用归一键——清缓存/簿子对得上消费键');
  // GET/DELETE 同口径归一——'000123' 读口命中同一绑定、解绑按归一键删
  const g = await json(await getM('000123', ip));
  assert.equal(g.status, 200);
  assert.equal(g.body.hit.mediaId, 'dQw4w9WgXcQ');
  assert.equal((await del('000123', ip)).status, 200);
  assert.equal(repo.getManual('123'), null, '解绑同样按归一键删行');
  // candidates 端点同口径：keyword 缺席时 detail 入参是归一形
  await json(await getCand('id=000124', ip));
  assert.equal(detailCalls.at(-1)?.params?.ids, '124', 'detail 兜底派生用归一 id');
});

test('POST 入参闸：坏 songId/坏 source/坏 mediaId → 400（URL 串永不收）', async () => {
  resetStubs();
  // 每桶 15/min——本用例发大量 POST，每发独立 IP 避免先撞桶（拒闸断言的
  // 是 400 而非 429）
  // songId 闸：canonManualTrackId——非数字/超 20 位/file_ 上传资产与
  // 撞名命名空间全拒（qq_/bv_/yt_ 前缀轨道 id 现在收——下方专项谱钉）
  for (const id of ['abc', '88020 1', '9'.repeat(21), 'file_abcdef12', 'mix_x', 'ext_ytm_x', 'spotify_x']) {
    assert.equal((await post({ id, source: 'youtube', mediaId: 'dQw4w9WgXcQ' })).status, 400, `id=${id}`);
  }
  // source 闸：schema 枚举外源 400
  for (const source of ['pyncmd', 'qq', 'kugou', 'yt']) {
    assert.equal((await post({ id: '880201', source, mediaId: 'dQw4w9WgXcQ' })).status, 400, `source=${source}`);
  }
  // mediaId 严校：URL 串/短链/短号/纯数字/异源垃圾全 400——服务端零 URL 解析面
  const badForBv = [
    'bilibili.com/video/BV1xx411c7mD', 'https://www.bilibili.com/video/BV1xx411c7mD',
    'https://b23.tv/abc123', 'av170001', 'BVxx', 'BV1xx411c7mD/trailing',
    'dQw4w9WgXcQ', // yt 净形投 bilibili 也是 400（mediaId 按源分正则）
  ];
  for (const mediaId of badForBv) {
    assert.equal((await post({ id: '880201', source: 'bilibili', mediaId })).status, 400, `bv mediaId=${mediaId}`);
  }
  const badForYt = [
    'youtu.be/dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXc', // 10 位短号
    'BV1xx411c7mD', 'spotify_!!', '123456', 'dQw4w9WgXcQ junk', // spotify_xxx 恰是合法 11 位形不收进坏例
  ];
  for (const mediaId of badForYt) {
    assert.equal((await post({ id: '880201', source: 'youtube', mediaId })).status, 400, `yt mediaId=${mediaId}`);
  }
  // 缺键 schema 拒
  assert.equal((await post({ id: '880201', source: 'youtube' })).status, 400);
  assert.equal((await post({ source: 'youtube', mediaId: 'dQw4w9WgXcQ' })).status, 400);
  assert.equal(resolveByIdCalls.length, 0, '形闸前置——坏入参绝不烧上游取流');
  // 合法净形过闸
  assert.equal((await post({ id: '880201', source: 'bilibili', mediaId: 'BV1xx411c7mD' })).status, 200);
  assert.equal((await post({ id: '880202', source: 'youtube', mediaId: 'dQw4w9WgXcQ' })).status, 200);
});

test('POST 验证闸：resolveById 回 null/无 url → 404 不落库；authRejected → 502；普通抛 → 502', async () => {
  resetStubs();
  const ip = nextIp();
  ytResolveByIdImpl = async () => null;
  let r = await json(await post({ id: '880203', source: 'youtube', mediaId: 'dQw4w9WgXcQ' }, ip));
  assert.equal(r.status, 404);
  assert.equal(repo.getManual('880203'), null, '验证失败不落库');
  // 有产出但无 url 同判 404
  ytResolveByIdImpl = async () => ({ url: null, br: 1 });
  r = await json(await post({ id: '880203', source: 'youtube', mediaId: 'dQw4w9WgXcQ' }, ip));
  assert.equal(r.status, 404);
  assert.equal(repo.getManual('880203'), null);
  // authRejected → 502「源站凭据被拒（风控）」
  const wall = new Error('Innertube LOGIN_REQUIRED');
  wall.authRejected = true;
  ytResolveByIdImpl = async () => { throw wall; };
  r = await json(await post({ id: '880204', source: 'youtube', mediaId: 'dQw4w9WgXcQ' }, ip));
  assert.equal(r.status, 502);
  assert.match(r.body.message, /凭据被拒/);
  assert.equal(repo.getManual('880204'), null);
  // 普通传输故障 → 502
  ytResolveByIdImpl = async () => { throw new Error('upstream HTTP 503'); };
  r = await json(await post({ id: '880205', source: 'youtube', mediaId: 'dQw4w9WgXcQ' }, ip));
  assert.equal(r.status, 502);
  assert.equal(repo.getManual('880205'), null);
});

test('POST 能力面断言：provider 无 resolveById → 400「该源不支持手动绑定」', async () => {
  resetStubs();
  const ip = nextIp();
  const idx = require('../src/server/services/unlock/index.js');
  const orig = idx.PROVIDERS.bilibili.resolveById;
  delete idx.PROVIDERS.bilibili.resolveById;
  try {
    const r = await json(await post({ id: '880206', source: 'bilibili', mediaId: 'BV1xx411c7mD' }, ip));
    assert.equal(r.status, 400);
    assert.match(r.body.message, /不支持手动绑定/);
    assert.equal(repo.getManual('880206'), null);
  } finally {
    idx.PROVIDERS.bilibili.resolveById = orig;
  }
});

test('CSRF 双闸：异源 Origin 的 POST/DELETE → 403；sec-fetch-site: cross-site → 403', async () => {
  resetStubs();
  const ip = nextIp();
  assert.equal((await post({ id: '880207', source: 'youtube', mediaId: 'dQw4w9WgXcQ' },
    ip, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await del('880207', ip, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await post({ id: '880207', source: 'youtube', mediaId: 'dQw4w9WgXcQ' },
    ip, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal(repo.getManual('880207'), null, '403 一律不写库');
  // 同源 Origin 放行——app.request 不自动带 Host，显式补（浏览器真实形态）
  assert.equal((await post({ id: '880207', source: 'youtube', mediaId: 'dQw4w9WgXcQ' },
    ip, { origin: 'http://t', host: 't' })).status, 200);
  assert.equal((await getM('880207', nextIp())).status, 200);
});

test('写桶限流：unlock-manual:write 15/min——第 16 发 429，POST/DELETE 共桶', async () => {
  const ip = nextIp();
  let last = null;
  for (let i = 0; i < 15; i++) {
    // 过 CSRF/桶后落 400（坏 mediaId）——桶计数先于 schema 消费
    last = await post({ id: '880208', source: 'youtube', mediaId: 'bad!' }, ip);
    assert.equal(last.status, 400, `第 ${i + 1} 发应过桶落 400`);
    await last.arrayBuffer();
  }
  last = await json(await post({ id: '880208', source: 'youtube', mediaId: 'bad!' }, ip));
  assert.equal(last.status, 429);
  assert.equal(last.body.code, 429);
  assert.equal((await del('880208', ip)).status, 429, 'DELETE 与 POST 共写桶');
});

test('GET 桶：unlock-manual 30/min——第 31 发 429', async () => {
  const ip = nextIp();
  for (let i = 0; i < 30; i++) {
    const res = await getM('880209', ip);
    assert.equal(res.status, 404, `第 ${i + 1} 发应过桶（未绑 404）`);
    await res.arrayBuffer();
  }
  const res = await getM('880209', ip);
  assert.equal(res.status, 429);
});

test('GET /unlock/candidates：id 闸 + 两源合并下发（mediaId 统一键/cover https 绝对形）', async () => {
  resetStubs();
  const ip = nextIp();
  assert.equal((await getCand('id=abc&keyword=x', ip)).status, 400);
  assert.equal((await getCand(`id=${'9'.repeat(21)}&keyword=x`, ip)).status, 400);
  assert.equal((await getCand('keyword=x', ip)).status, 400); // id 缺席也拒
  ytSearchImpl = async (kw) => [
    { videoId: 'dQw4w9WgXcQ', title: 'yt-t1', owner: 'yt-o1', durationSec: 200, channelId: 'UCx', publishedTimeText: '3 年前' },
    { videoId: 'abc123def45', title: 'yt-t2', owner: 'yt-o2', durationSec: 210 },
    { videoId: 'zzzzzzzzzzz', title: 'yt-t3', owner: 'yt-o3', durationSec: null },
  ];
  bvSearchImpl = async (kw) => [
    { videoId: 'BV1xx411c7mD', title: 'bv-t1', owner: 'bv-o1', durationSec: 199, cover: 'https://i0.hdslb.com/bfs/a.jpg' },
    { videoId: 'BV1yy411c7mE', title: 'bv-t2', owner: 'bv-o2', durationSec: 205, cover: 'https://i0.hdslb.com/bfs/b.jpg' },
    { videoId: 'BV1zz411c7mF', title: 'bv-t3', owner: 'bv-o3', durationSec: 100, cover: 'https://i0.hdslb.com/bfs/c.jpg' },
  ];
  const r = await json(await getCand('id=880210&keyword=自定词', ip));
  assert.equal(r.status, 200);
  assert.equal(r.body.code, 200);
  assert.equal(r.body.keyword, '自定词', 'keyword 回显实际用掉的词');
  assert.equal(r.body.candidates.length, 6);
  // 源组序：youtube 块 → bilibili 块；mediaId 是统一键名（无 videoId 漏出）
  assert.deepEqual(r.body.candidates.map(c => c.source), ['youtube', 'youtube', 'youtube', 'bilibili', 'bilibili', 'bilibili']);
  assert.equal(r.body.candidates[0].mediaId, 'dQw4w9WgXcQ');
  assert.equal(r.body.candidates[0].channelId, 'UCx');
  assert.equal(r.body.candidates[0].publishedTimeText, '3 年前');
  assert.ok(!('videoId' in r.body.candidates[0]));
  for (const cand of r.body.candidates) {
    assert.ok(!String(cand.cover || '').startsWith('//'), `cover 不得是协议相对形：${JSON.stringify(cand)}`);
    if (cand.cover) assert.match(cand.cover, /^https:\/\//, `cover 必须是 https 绝对形：${JSON.stringify(cand)}`);
  }
  // youtube 桩未给 cover 字段时归一成 ''——客户端兜底音符占位
  assert.equal(r.body.candidates[0].cover, '');
  // keyword 在场 → 直通不打 song_detail
  assert.equal(detailCalls.length, 0, 'keyword 显式在场时零多一跳 detail');
  assert.deepEqual(searchCalls.map(x => x.keyword), ['自定词', '自定词']);
});

test('GET /unlock/candidates：keyword 缺席走 song_detail+baseUnlockInfo 兜底派生并回显', async () => {
  resetStubs();
  const ip = nextIp();
  ytSearchImpl = async () => [{ videoId: 'dQw4w9WgXcQ', title: 't', owner: 'o', durationSec: 200 }];
  bvSearchImpl = async () => [];
  const r = await json(await getCand('id=880211', ip));
  assert.equal(r.status, 200);
  // [canonical KWFORM]：name - artists.join(' / ')——上游搜索实参断言同串
  assert.equal(r.body.keyword, 'n880211 - a / b');
  assert.deepEqual(searchCalls.map(x => x.keyword), ['n880211 - a / b', 'n880211 - a / b']);
  assert.equal(detailCalls.length, 1);
  // detail 失败/无行且无 keyword → 502
  songDetailImpl = async () => ({ body: { songs: [] } });
  const r2 = await json(await getCand('id=880212', ip));
  assert.equal(r2.status, 502);
  songDetailImpl = async () => { throw new Error('netease down'); };
  const r3 = await json(await getCand('id=880213', ip));
  assert.equal(r3.status, 502);
  assert.equal(r3.body.message, '曲目详情获取失败');
});

test('GET /unlock/candidates：单源失败故障隔离 errors 下发；双灭 502', async () => {
  resetStubs();
  const ip = nextIp();
  ytSearchImpl = async () => { throw new Error('Innertube 风控\n多行消息'); };
  bvSearchImpl = async () => [
    { videoId: 'BV1xx411c7mD', title: 'bv-t', owner: 'bv-o', durationSec: 199, cover: 'https://i0.hdslb.com/x.jpg' },
  ];
  const r = await json(await getCand('id=880214&keyword=k', ip));
  assert.equal(r.status, 200);
  assert.equal(r.body.candidates.length, 1, '他源照常——不翻整池');
  assert.equal(r.body.candidates[0].source, 'bilibili');
  assert.equal(r.body.errors.length, 1);
  assert.equal(r.body.errors[0].source, 'youtube');
  assert.match(r.body.errors[0].msg, /Innertube 风控/);
  assert.ok(!r.body.errors[0].msg.includes('\n'), 'errors msg 单行化');
  // 双源全灭 → 502
  bvSearchImpl = async () => { throw new Error('bilibili search HTTP 412'); };
  const r2 = await json(await getCand('id=880214&keyword=k', ip));
  assert.equal(r2.status, 502);
});

test('candidates emit 预整形：durationSec 注定被 POST 拒的形态键缺席（非 null）；合法值舍入照发', async () => {
  resetStubs();
  const ip = nextIp();
  // POST schema durationSec = int().positive().max(7200).optional()——只容
  // 缺席不容 null/非整数/超限；emit 侧同构判舍入后值（resolve-media 成功支同法）
  ytSearchImpl = async () => [
    { videoId: 'dQw4w9WgXcQ', title: 'absent', owner: 'o' },                    // 键缺席
    { videoId: 'abc123def45', title: 'nullv', owner: 'o', durationSec: null },  // null
    { videoId: 'e5e5e5e5e5e', title: 'nanv', owner: 'o', durationSec: NaN },    // NaN
    { videoId: 'k1k1k1k1k1k', title: 'strv', owner: 'o', durationSec: '200' },  // 字符串不收编
    { videoId: 'm2m2m2m2m2m', title: 'boolv', owner: 'o', durationSec: true },  // 布尔不收编
    { videoId: 'f6f6f6f6f6f', title: 'over', owner: 'o', durationSec: 7201 },   // >7200
    { videoId: 'g7g7g7g7g7g', title: 'tiny', owner: 'o', durationSec: 0.4 },    // round→0
    { videoId: 'h8h8h8h8h8h', title: 'frac', owner: 'o', durationSec: 200.6 },  // →201 对照
    { videoId: 'i9i9i9i9i9i', title: 'edge', owner: 'o', durationSec: 7200.4 }, // 舍入回 7200 照发
    { videoId: 'j0j0j0j0j0j', title: 'intv', owner: 'o', durationSec: 200 },    // 整数直通
  ];
  bvSearchImpl = async () => [];
  const r = await json(await getCand('id=880230&keyword=k', ip));
  assert.equal(r.status, 200);
  const cs = r.body.candidates;
  assert.equal(cs.length, 10);
  // 注定被 POST 400 拒的形态一律不挂键——「无快照时长」透传，绝不发 null；
  // '200'/true 非数值形同律不收编（isFinite 前置闸，resolve-media 同法）
  for (const cand of cs.slice(0, 7)) {
    assert.ok(!('durationSec' in cand),
      `${cand.title} durationSec 键须缺席而非 null/脏值：${JSON.stringify(cand)}`);
  }
  assert.equal(cs[7].durationSec, 201, '200.6 → Math.round → 201 照发');
  assert.equal(cs[8].durationSec, 7200, '7200.4 舍入回界内照发');
  assert.equal(cs[9].durationSec, 200, '整数直通');
});

test('candidates emit 预整形：title>300 截 300 / owner>200 截 200 / 非字符串→空串', async () => {
  resetStubs();
  const ip = nextIp();
  ytSearchImpl = async () => [
    { videoId: 'dQw4w9WgXcQ', title: '长'.repeat(400), owner: '频'.repeat(300), durationSec: 200 },
    { videoId: 'abc123def45', title: 12345, owner: 'x', durationSec: 100 }, // 数字 title
    { videoId: 'zzzzzzzzzzz', owner: 'y', durationSec: 100 },                // title 键缺席
  ];
  bvSearchImpl = async () => [];
  const r = await json(await getCand('id=880231&keyword=k', ip));
  assert.equal(r.status, 200);
  const cs = r.body.candidates;
  assert.equal(cs[0].title, '长'.repeat(300), 'title 截到 POST max(300)');
  assert.equal(cs[0].owner, '频'.repeat(200), 'owner 截到 POST max(200)');
  assert.equal(cs[1].title, '', '非字符串 title 归空串（str 只收字符串形）');
  assert.equal(cs[2].title, '', 'title 缺席归空串');
  assert.equal(cs[2].owner, 'y');
});

test('candidates→POST 闭环钉：缺时长+超长快照的候选行回包直喂 POST → 200（缝闭合）', async () => {
  resetStubs();
  const ip = nextIp();
  ytSearchImpl = async () => [
    // durationSec 缺席 + title/owner 超上限——修前 POST 注定 400 的形状
    { videoId: 'dQw4w9WgXcQ', title: '环'.repeat(400), owner: '道'.repeat(300) },
  ];
  bvSearchImpl = async () => [];
  const r = await json(await getCand('id=880232&keyword=k', ip));
  assert.equal(r.status, 200);
  const cand = r.body.candidates[0];
  assert.ok(!('durationSec' in cand), '无快照时长——键缺席而非 null');
  // 客户端挑选后构造的 body 形状：id + 候选行字段原样回送（无 durationSec 键）
  const p = await json(await post({
    id: '880232',
    source: cand.source,
    mediaId: cand.mediaId,
    title: cand.title,
    owner: cand.owner,
  }, ip));
  assert.equal(p.status, 200, '候选产出即保证可 POST——不得 400');
  assert.equal(p.body.hit.mediaId, 'dQw4w9WgXcQ');
  assert.equal(p.body.hit.title, '环'.repeat(300));
  assert.equal(p.body.hit.owner, '道'.repeat(200));
  assert.equal(p.body.hit.durationSec, null, '库行时长列容 NULL（schema 只拒入包 null）');
});

test('candidates 读桶：unlock-cand 20/min——第 21 发 429', async () => {
  resetStubs();
  const ip = nextIp();
  for (let i = 0; i < 20; i++) {
    const res = await getCand('id=880215&keyword=k', ip);
    assert.equal(res.status, 200, `第 ${i + 1} 发应过桶`);
    await res.arrayBuffer();
  }
  const res = await getCand('id=880215&keyword=k', ip);
  assert.equal(res.status, 429);
});

// ── 外源轨道 id（qq_/bv_/yt_）扩展谱：同一绑定设施对外源自有源曲开放 ──

test('前缀 id 全生命周期：qq_/bv_/bv__pN/yt_ POST→GET→DELETE→GET 404，二次 DELETE 幂等', async () => {
  resetStubs();
  for (const tid of ['qq_0034M8WL3V4oHA', 'bv_BV1xx411c7mD', 'bv_BV1xx411c7mD_p3', 'yt_dQw4w9WgXcQ']) {
    const ip = nextIp();
    assert.equal((await getM(tid, ip)).status, 404, `未绑 ${tid}`);
    const r = await json(await post({
      id: tid, source: 'youtube', mediaId: 'dQw4w9WgXcQ',
      title: '正曲', owner: '频道', durationSec: 212,
    }, ip));
    assert.equal(r.status, 200, `POST ${tid}`);
    assert.equal(r.body.hit.mediaId, 'dQw4w9WgXcQ');
    assert.equal(repo.getManual(tid)?.mediaId, 'dQw4w9WgXcQ', `${tid} 按规范键落库`);
    const g = await json(await getM(tid, ip));
    assert.equal(g.status, 200);
    assert.equal(g.body.hit.mediaId, 'dQw4w9WgXcQ');
    assert.equal((await del(tid, ip)).status, 200);
    assert.equal((await getM(tid, ip)).status, 404);
    assert.equal((await del(tid, ip)).status, 200, 'DELETE 幂等：没绑过也 200');
  }
});

test('id 闸精确枚举：file_/mix_/ext_词源/spotify_/裸 qq_/截短/超长全 400；qq_+20位 mid（23字符）过闸', async () => {
  resetStubs();
  // 形态闸：精确枚举四形态之外一律 400（宽化=收下永不消费的僵尸行）
  for (const id of ['file_abcdef12', 'mix_x', 'ext_ytm_x', 'ytm_dQw4w9WgXcQ', 'spotify_x',
    'qq_', 'qq_short', 'yt_short', 'bv_short', 'bv_', 'p3']) {
    assert.equal((await post({ id, source: 'youtube', mediaId: 'dQw4w9WgXcQ' })).status, 400, `POST id=${id}`);
    assert.equal((await getM(id)).status, 400, `GET id=${id}`);
  }
  // qq_+20 位 mid=23 字符——schema max(40) 生效过闸（旧 max(20) 在 schema 层就拒）
  const r = await json(await post({
    id: `qq_${'a1'.repeat(10)}`, source: 'youtube', mediaId: 'dQw4w9WgXcQ',
  }));
  assert.equal(r.status, 200, 'qq_+20位 mid（23字符）须过闸');
  // >40 字符：schema 体量闸先拒（形态闸之前）
  assert.equal((await post({ id: `qq_${'a1'.repeat(19)}`, source: 'youtube', mediaId: 'dQw4w9WgXcQ' })).status, 400);
  assert.equal((await post({ id: 'x'.repeat(41), source: 'youtube', mediaId: 'dQw4w9WgXcQ' })).status, 400);
  assert.equal((await getM('x'.repeat(41))).status, 400);
});

test('canonManualTrackId 归一：BV_/小写 bvid/_PN/_p尾段 非规范形 → canonical 键落库/读口；qq_/yt_ 原样', async () => {
  resetStubs();
  const ip = nextIp();
  // 'BV_bv1xxxxxxxxx'（BV_TRACK_ID_RE /i 宽形过闸）→ 落库 'bv_BV1xxxxxxxxx'
  let r = await json(await post({
    id: 'BV_bv1xxxxxxxxx', source: 'youtube', mediaId: 'dQw4w9WgXcQ',
    title: 't', owner: 'o', durationSec: 200,
  }, ip));
  assert.equal(r.status, 200);
  assert.equal(repo.getManual('bv_BV1xxxxxxxxx')?.mediaId, 'dQw4w9WgXcQ',
    '落库键须归一成 BV 大写头——与 song.id/端点轨道键规范形一致');
  assert.equal(repo.getManual('BV_bv1xxxxxxxxx'), null, '非规范键不得落库');
  // 非规范形读口同口径归一——'bv_bv1xxxxxxxxx' 命中同一绑定
  assert.equal((await getM('bv_bv1xxxxxxxxx', ip)).status, 200);
  // 大写 _PN 分 P 形 → 'bv_BV1xxxxxxxxx_p2'
  r = await json(await post({
    id: 'bv_BV1xxxxxxxxx_P2', source: 'bilibili', mediaId: 'BV1xx411c7mD',
    title: 't', owner: 'o', durationSec: 200,
  }, ip));
  assert.equal(r.status, 200);
  assert.equal(repo.getManual('bv_BV1xxxxxxxxx_p2')?.mediaId, 'BV1xx411c7mD', '_PN 归一到 _pN');
  assert.equal((await getM('bv_BV1xxxxxxxxx_p2', ip)).status, 200);
  // _p 尾段数值归一（R3-SF1）：/bilibili/stream 只在 pageWanted>1 产 _pN
  // 轨道键——_p0/_p1/_p01 原样落库=端点永不命中的僵尸绑定，须归一到裸键
  for (const tail of ['p0', 'p1', 'p01']) {
    r = await json(await post({
      id: `bv_BV1zz411c7mF_${tail}`, source: 'youtube', mediaId: 'dQw4w9WgXcQ',
      title: 't', owner: 'o', durationSec: 200,
    }));
    assert.equal(r.status, 200, `POST bv_..._${tail}`);
    assert.equal(repo.getManual('bv_BV1zz411c7mF')?.mediaId, 'dQw4w9WgXcQ',
      `_${tail} 须归一到裸键 bv_BV1zz411c7mF（端点 ?p=0/1 产裸键）`);
    assert.equal(repo.getManual(`bv_BV1zz411c7mF_${tail}`), null,
      `_${tail} 原形不得落库`);
    // GET 用归一键命中——非规范尾段读口命中同一绑定
    assert.equal((await getM(`bv_BV1zz411c7mF_${tail}`)).status, 200,
      `GET _${tail} 归一键命中`);
    repo.deleteManual('bv_BV1zz411c7mF');
  }
  // _p03/_P03（RE /i 放行大写 P）→ _p3——端点 ?p=03 产 pageWanted=3→_p3 键
  for (const tail of ['p03', 'P03']) {
    r = await json(await post({
      id: `bv_BV1zz411c7mF_${tail}`, source: 'youtube', mediaId: 'dQw4w9WgXcQ',
      title: 't', owner: 'o', durationSec: 200,
    }));
    assert.equal(r.status, 200, `POST bv_..._${tail}`);
    assert.equal(repo.getManual('bv_BV1zz411c7mF_p3')?.mediaId, 'dQw4w9WgXcQ',
      `_${tail} 须归一到 _p3（前导零/大写 P 剥掉）`);
    assert.equal(repo.getManual(`bv_BV1zz411c7mF_${tail}`), null,
      `_${tail} 原形不得落库`);
    assert.equal((await getM(`bv_BV1zz411c7mF_${tail}`)).status, 200,
      `GET _${tail} 归一键命中`);
    repo.deleteManual('bv_BV1zz411c7mF_p3');
  }
  // qq_/yt_ RE 无 /i——大写前缀非规范形不收（原样即规范形，不做大小写宽化）
  assert.equal((await post({ id: 'QQ_0034M8WL3V4oHA', source: 'youtube', mediaId: 'dQw4w9WgXcQ' })).status, 400);
  assert.equal((await post({ id: 'YT_dQw4w9WgXcQ', source: 'youtube', mediaId: 'dQw4w9WgXcQ' })).status, 400);
});

test('candidates 外源支：keyword 在场直通双源扇出；缺席 →400 且 song_detail 零调用', async () => {
  resetStubs();
  const ip = nextIp();
  ytSearchImpl = async (kw) => [{ videoId: 'dQw4w9WgXcQ', title: 't', owner: 'o', durationSec: 200 }];
  bvSearchImpl = async () => [{ videoId: 'BV1xx411c7mD', title: 'b', owner: 'u', durationSec: 199, cover: 'https://i0.hdslb.com/x.jpg' }];
  // keyword 在场——外源 id 照常扇出（上游桩实参=显式词）
  const r = await json(await getCand('id=qq_0034M8WL3V4oHA&keyword=外源词', ip));
  assert.equal(r.status, 200);
  assert.equal(r.body.keyword, '外源词');
  assert.equal(r.body.candidates.length, 2);
  assert.deepEqual(searchCalls.map(x => x.keyword), ['外源词', '外源词']);
  assert.equal(detailCalls.length, 0, '显式词在场零 detail');
  // keyword 缺席 → 400（外源无 song_detail 兜底源）且 detail/搜索桩零调用
  detailCalls.length = 0; searchCalls.length = 0;
  const r2 = await json(await getCand('id=qq_0034M8WL3V4oHA', ip));
  assert.equal(r2.status, 400);
  assert.match(r2.body.message, /外源曲目须显式携带检索关键词/);
  assert.equal(detailCalls.length, 0, '400 不烧注定空回的 detail 跳');
  assert.equal(searchCalls.length, 0, '400 不烧上游搜索');
  // bv_/yt_ 同判
  assert.equal((await json(await getCand('id=bv_BV1xx411c7mD', ip))).status, 400);
  assert.equal((await json(await getCand('id=bv_BV1xx411c7mD_p3', ip))).status, 400);
  assert.equal((await json(await getCand('id=yt_dQw4w9WgXcQ', ip))).status, 400);
  assert.equal(detailCalls.length, 0);
  // 数值 id 无 keyword 照旧 detail 兜底（回归不破）
  const r3 = await json(await getCand('id=880220', ip));
  assert.equal(r3.status, 200);
  assert.equal(detailCalls.length, 1, '数值支 detail 兜底照旧');
});

test('POST 验流纪律回归（前缀 id 同律）：resolveById null→404 不落库；authRejected→502；签名链不落库不回包', async () => {
  resetStubs();
  const ip = nextIp();
  ytResolveByIdImpl = async () => null;
  let r = await json(await post({ id: 'qq_0034M8WL3V4oHA', source: 'youtube', mediaId: 'dQw4w9WgXcQ' }, ip));
  assert.equal(r.status, 404);
  assert.equal(repo.getManual('qq_0034M8WL3V4oHA'), null, '验证失败不落库');
  const wall = new Error('Innertube LOGIN_REQUIRED');
  wall.authRejected = true;
  ytResolveByIdImpl = async () => { throw wall; };
  r = await json(await post({ id: 'qq_0034M8WL3V4oHA', source: 'youtube', mediaId: 'dQw4w9WgXcQ' }, ip));
  assert.equal(r.status, 502);
  assert.match(r.body.message, /凭据被拒/);
  assert.equal(repo.getManual('qq_0034M8WL3V4oHA'), null);
  // 验流成功：签名 url 用完即弃——不落库不回包（前缀 id 同律）
  ytResolveByIdImpl = async () => ({ url: SIGNED_YT, urls: [SIGNED_YT], br: 128000, durationSec: null });
  r = await json(await post({ id: 'qq_0034M8WL3V4oHA', source: 'youtube', mediaId: 'dQw4w9WgXcQ' }, ip));
  assert.equal(r.status, 200);
  assert.ok(!JSON.stringify(r.body).includes('SECRETYT'), '验流产物签名链不得透进回包');
  assert.ok(!JSON.stringify(repo.getManual('qq_0034M8WL3V4oHA')).includes('SECRETYT'), '签名链不得落库');
  // bv_/yt_ 前缀 id 验流同律
  bvResolveByIdImpl = async () => null;
  r = await json(await post({ id: 'bv_BV1xx411c7mD', source: 'bilibili', mediaId: 'BV1xx411c7mD' }, ip));
  assert.equal(r.status, 404);
  assert.equal(repo.getManual('bv_BV1xx411c7mD'), null);
});

test('repo 单测面：upsert→get→覆盖写 last-write-wins→delete→null；durationSec 脏值归 NULL', async () => {
  repo.deleteManual('880216');
  assert.equal(repo.getManual('880216'), null);
  repo.upsertManual('880216', { source: 'youtube', mediaId: 'dQw4w9WgXcQ', title: 't', owner: 'o', durationSec: 200 });
  let row = repo.getManual('880216');
  assert.deepEqual({ source: row.source, mediaId: row.mediaId, title: row.title, owner: row.owner, durationSec: row.durationSec },
    { source: 'youtube', mediaId: 'dQw4w9WgXcQ', title: 't', owner: 'o', durationSec: 200 });
  assert.ok(row.updatedAt);
  // 重挑覆盖：同曲第二发整行替换（song_id 主键 upsert）
  repo.upsertManual('880216', { source: 'bilibili', mediaId: 'BV1xx411c7mD', title: 't2', owner: 'o2', durationSec: 400 });
  row = repo.getManual('880216');
  assert.equal(row.source, 'bilibili');
  assert.equal(row.mediaId, 'BV1xx411c7mD');
  assert.equal(row.durationSec, 400);
  // duration_sec 非有限正数落 NULL
  repo.upsertManual('880216', { source: 'bilibili', mediaId: 'BV1xx411c7mD', title: '', owner: '', durationSec: -3 });
  assert.equal(repo.getManual('880216').durationSec, null);
  repo.upsertManual('880216', { source: 'bilibili', mediaId: 'BV1xx411c7mD', title: '', owner: '', durationSec: NaN });
  assert.equal(repo.getManual('880216').durationSec, null);
  repo.deleteManual('880216');
  assert.equal(repo.getManual('880216'), null);
});

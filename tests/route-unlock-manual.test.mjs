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
  // songId 闸：NETEASE_ID_BOUNDED_RE——非数字/超 20 位/前缀轨道 id 全拒
  for (const id of ['abc', '88020 1', '9'.repeat(21), 'bv_BV1xx411c7mD', 'yt_dQw4w9WgXcQ', 'qq_abc123defg', 'file_abcdef12']) {
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

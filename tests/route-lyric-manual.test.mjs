// routes/lyric-manual.js 冒烟：GET 未绑 404 / POST 点名绑定（服务端按
// extId 重取词文整行落库——kugou_ 须携 token=accesskey）/ DELETE 幂等
// 解绑 / id·extId 白名单闸 / CSRF 写闸 / 写桶限流。
// 真库 + 真 service + fetch 桩——绑定持久化语义桩测不出。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { seed, tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-rlyrmanual-');
// 限流桶按 IP 分：TRUST_PROXY 开后每用例给独立 XFF——用例间互不消耗配额
process.env.TRUST_PROXY = '1';
const require = createRequire(import.meta.url);

// AI 层桩——lyric-external require 链挂着 lib/ai（级联核验面）
seed('../src/server/lib/ai.js', {
  aiEnabled: () => false,
  aiModel: () => 'test-model',
  askAiJson: async () => null,
});

const svc = require('../src/server/services/lyric-external.js');
let app, repo;
before(() => {
  app = require('../src/server/routes/lyric-manual.js');
  repo = require('../src/server/repositories/lyricManual.js');
});
after(() => {
  delete process.env.TRUST_PROXY;
  rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

// ── fetch 桩：URL 子串分发 ──
const calls = [];
let handler = async () => new Response('{}', { status: 404 });
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  calls.push(url);
  return handler(url, init || {});
};
after(() => { globalThis.fetch = realFetch; });
const J = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json' },
});
const dispatch = (table) => async (url, init) => {
  for (const [match, fn] of table) {
    if (url.includes(match)) return fn(url, init);
  }
  return J({ err: 'unhandled' }, 404);
};
const reset = (table) => { calls.length = 0; handler = dispatch(table); svc._clearCache(); };

let ipSeq = 10;
const nextIp = () => `10.9.${++ipSeq}.1`;
const json = async (res) => ({ status: res.status, body: await res.json().catch(() => null) });
const getM = (id, ip = nextIp()) => app.request(
  `http://t/lyric/manual?id=${encodeURIComponent(id)}`,
  { headers: { 'x-forwarded-for': ip } });
const post = (body, ip = nextIp(), headers = {}) => app.request('http://t/lyric/manual', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip, ...headers },
  body: JSON.stringify(body),
});
const del = (id, ip = nextIp(), headers = {}) => app.request(
  `http://t/lyric/manual?id=${encodeURIComponent(id)}`,
  { method: 'DELETE', headers: { 'x-forwarded-for': ip, ...headers } });

test('GET /lyric/manual：未绑 → 404；非法 id → 400', async () => {
  const unbound = await json(await getM('880100'));
  assert.equal(unbound.status, 404);
  assert.equal(unbound.body.code, 404);
  assert.equal((await getM('bad id!')).status, 400);       // 空格脏形态
  assert.equal((await getM('notavalididform')).status, 400);
  // 词属主键全形收——ext 词源 id 也合法（与 songmeta 同一份谓词集）
  assert.equal((await getM('lrclib_' + 'x'.repeat(40))).status, 404); // 形态合法但未绑
});

test('POST /lyric/manual 入参闸：坏 id/坏 extId/缺键 → 400；异源 Origin → 403', async () => {
  assert.equal((await post({ id: 'bad id', extId: 'lrclib_1' })).status, 400);
  assert.equal((await post({ id: '880101', extId: 'spotify_1' })).status, 400);   // 源白名单外
  assert.equal((await post({ id: '880101', extId: 'lrclib_../../x' })).status, 400); // 脏尾段
  assert.equal((await post({ id: '880101' })).status, 400);                      // 缺 extId（schema）
  assert.equal((await post({ extId: 'lrclib_1' })).status, 400);                 // 缺 id
  // CSRF：异源 Origin 的写请求 403；DELETE 同闸
  assert.equal((await post({ id: '880101', extId: 'lrclib_1' },
    nextIp(), { origin: 'http://evil.example' })).status, 403);
  assert.equal((await del('880101', nextIp(), { origin: 'http://evil.example' })).status, 403);
  // GET 是只读端点——异源 Origin 不拦（与全站 GET 同口径）
  assert.equal((await getM('880101', nextIp())).status, 404);
});

test('POST lrclib 点名 → 词文整行落库 → GET 回绑定 → DELETE 幂等解绑', async () => {
  const ip = nextIp();
  reset([
    ['lrclib.net/api/get/7', () => J({
      id: 7, trackName: '曲', artistName: '艺人',
      syncedLyrics: '[00:01.00]手选词一\n[00:02.00]手选词二', plainLyrics: '手选词一\n手选词二',
    })],
  ]);
  const r = await json(await post({ id: '880102', extId: 'lrclib_7' }, ip));
  assert.equal(r.status, 200);
  assert.equal(r.body.code, 200);
  assert.equal(r.body.hit.extId, 'lrclib_7');
  assert.equal(r.body.hit.source, 'lrclib');
  assert.equal(r.body.hit.synced, true);
  assert.match(r.body.hit.lrc, /手选词一/);
  assert.equal(r.body.hit.plain, '手选词一\n手选词二');
  // 持久层直查——词文整行落库（不是指针）
  const row = repo.getManual('880102');
  assert.equal(row.extId, 'lrclib_7');
  assert.match(row.lrc, /手选词二/);
  assert.equal(row.plain, '手选词一\n手选词二');
  // GET 回绑定
  const g = await json(await getM('880102', ip));
  assert.equal(g.status, 200);
  assert.equal(g.body.hit.extId, 'lrclib_7');
  assert.equal(g.body.hit.synced, true);
  // DELETE 幂等：删后 404，再删仍 200
  assert.equal((await del('880102', ip)).status, 200);
  assert.equal((await getM('880102', ip)).status, 404);
  assert.equal((await del('880102', ip)).status, 200);
  assert.equal((await del('bad id', ip)).status, 400);
});

test('POST 数字 id（netease 数值形态 body）也收——union 归一成串主键', async () => {
  reset([['lrclib.net/api/get/8', () => J({ id: 8, syncedLyrics: '[00:01.00]数词' })]]);
  const r = await json(await post({ id: 880103, extId: 'lrclib_8' }));
  assert.equal(r.status, 200);
  assert.equal(repo.getManual('880103').extId, 'lrclib_8');   // 落库键归一成串
});

test('POST kugou 点名：token=accesskey 直达 download 取词落库', async () => {
  const ip = nextIp();
  reset([
    ['lyrics.kugou.com/download', () => J({
      content: Buffer.from('[00:03.00]狗词一\n[00:06.00]狗词二').toString('base64'),
      charset: 'utf8',
    })],
  ]);
  const r = await json(await post({ id: '880104', extId: 'kugou_k55', token: 'ak-9' }, ip));
  assert.equal(r.status, 200);
  assert.equal(r.body.hit.source, 'kugou');
  assert.equal(r.body.hit.extId, 'kugou_k55');
  assert.match(r.body.hit.lrc, /狗词一/);
  const dl = calls.find(u => u.includes('download'));
  assert.ok(dl.includes('id=k55') && dl.includes('accesskey=ak-9'));
  // GET 回得出手选的 kugou 词（词文已随绑定落库，不依赖 accesskey 复用）
  const g = await json(await getM('880104', ip));
  assert.equal(g.body.hit.source, 'kugou');
  assert.match(g.body.hit.lrc, /狗词二/);
});

test('POST kugou 缺 token → 404 词源取词失败，不落库零上行', async () => {
  reset([['lyrics.kugou.com', () => J({})]]);
  const r = await json(await post({ id: '880105', extId: 'kugou_k77' }));
  assert.equal(r.status, 404);
  assert.match(r.body.message, /词源取词失败/);
  assert.equal(repo.getManual('880105'), null);
  assert.equal(calls.length, 0);   // 没 token 连 download 都不发
});

test('POST 上游取词失败 → 404 不落库；传输故障 → 502', async () => {
  reset([['lrclib.net/api/get/404', () => J({ message: 'not found' }, 404)]]);
  const r = await json(await post({ id: '880106', extId: 'lrclib_404' }));
  assert.equal(r.status, 404);
  assert.equal(repo.getManual('880106'), null);
  // 传输层抛错（非无词）→ 502 与 /lyric/external 同口径
  reset([['lrclib.net/api/get/500', () => J({ message: 'boom' }, 500)]]);
  const r2 = await json(await post({ id: '880107', extId: 'lrclib_500' }));
  assert.equal(r2.status, 502);
});

test('重挑覆盖：同曲再绑新 extId → upsert last-write-wins，GET 回新绑定', async () => {
  const ip = nextIp();
  reset([
    ['lrclib.net/api/get/7', () => J({
      id: 7, trackName: '曲', artistName: '艺人', syncedLyrics: '[00:01.00]旧词一',
    })],
    ['lrclib.net/api/get/9', () => J({
      id: 9, trackName: '曲', artistName: '艺人',
      syncedLyrics: '[00:02.00]新词二', plainLyrics: '新词二',
    })],
  ]);
  const r1 = await json(await post({ id: '880109', extId: 'lrclib_7' }, ip));
  assert.equal(r1.status, 200);
  assert.equal(repo.getManual('880109').extId, 'lrclib_7');
  // 同曲第二发点名——行被替换不是追加（song_id 主键 upsert）
  const r2 = await json(await post({ id: '880109', extId: 'lrclib_9' }, ip));
  assert.equal(r2.status, 200);
  assert.equal(r2.body.hit.extId, 'lrclib_9');
  const row = repo.getManual('880109');
  assert.equal(row.extId, 'lrclib_9');
  assert.match(row.lrc, /新词二/);
  assert.equal(row.plain, '新词二');
  // GET 回的是新绑定——旧词不再透得出
  const g = await json(await getM('880109', ip));
  assert.equal(g.body.hit.extId, 'lrclib_9');
  assert.match(g.body.hit.lrc, /新词二/);
  assert.doesNotMatch(g.body.hit.lrc, /旧词一/);
});

test('POST 词文体量闸：lrc/plain 超 512K 字 → 502 不落库；token>200 被 schema 收 400', async () => {
  reset([['lrclib.net/api/get/big', () => J({
    id: 'big', trackName: '曲', artistName: '艺人',
    // [00:01.00] 10 字 + 512K 词字 = 超闸——上游脏载荷不固化进绑定表
    syncedLyrics: `[00:01.00]${'词'.repeat(512 * 1024)}`,
  })]]);
  const r = await json(await post({ id: '880110', extId: 'lrclib_big' }));
  assert.equal(r.status, 502);
  assert.equal(r.body.message, '词源内容过大');
  assert.equal(repo.getManual('880110'), null, '超限词文不许落库');
  // token 契约上限 200（与 fetchByExtId 的 accesskey 收口同口径）：
  // 201 → schema 400；恰 200 过 schema 直通服务层（无 accesskey 回包 → 404）
  const longTok = await json(await post({
    id: '880110', extId: 'kugou_k1', token: 'a'.repeat(201),
  }));
  assert.equal(longTok.status, 400);
  const okTok = await json(await post({
    id: '880110', extId: 'kugou_k1', token: 'a'.repeat(200),
  }));
  assert.equal(okTok.status, 404);
});

test('写桶限流：lyric-manual:write 15/min——第 16 发 429', async () => {
  const ip = nextIp();
  let last = null;
  for (let i = 0; i < 15; i++) {
    last = await post({ id: '880108', extId: 'spotify_bad' }, ip);  // 过桶后 400
    assert.equal(last.status, 400, `第 ${i + 1} 发应过桶落 400`);
    await last.arrayBuffer();
  }
  last = await json(await post({ id: '880108', extId: 'spotify_bad' }, ip));
  assert.equal(last.status, 429);
  assert.equal(last.body.code, 429);
  // DELETE 与 POST 共桶——写配额已尽的 IP 上 DELETE 也 429
  assert.equal((await del('880108', ip)).status, 429);
});

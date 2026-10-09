// routes/songmeta.js 冒烟：GET 默认 0 / PUT upsert 往返 / 0=删行复位 /
// 入参整形（±300000、整数、id 白名单）/ PUT 写端点 CSRF 闸。
// 真库——校准值持久化语义桩测不出。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-route-songmeta-');
const require = createRequire(import.meta.url);

let app;
before(() => { app = require('../src/server/routes/songmeta.js'); });
after(() => { rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

const json = async (res) => ({ status: res.status, body: await res.json().catch(() => null) });
const put = (id, body) => app.request(`http://t/song-meta/${id}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('song-meta：未校准 200 回 offsetMs:0；PUT→GET 往返；0 复位删行', async () => {
  const first = await json(await app.request('http://t/song-meta/880101'));
  assert.equal(first.status, 200);
  assert.equal(first.body.offsetMs, 0); // 未校准不是 404

  const w = await json(await put('880101', { offsetMs: 1500 }));
  assert.equal(w.status, 200);
  assert.equal(w.body.offsetMs, 1500);
  const read = await json(await app.request('http://t/song-meta/880101'));
  assert.equal(read.body.offsetMs, 1500);

  // offsetMs=0 = 恢复默认：删行后 GET 回 0
  const zero = await put('880101', { offsetMs: 0 });
  assert.equal(zero.status, 200);
  const read2 = await json(await app.request('http://t/song-meta/880101'));
  assert.equal(read2.body.offsetMs, 0);
});

test('song-meta：PUT 校验——越界/非整数/缺键 400', async () => {
  for (const body of [{ offsetMs: 300001 }, { offsetMs: -300001 }, { offsetMs: 1.5 }, { offsetMs: 'x' }, {}]) {
    const r = await put('880102', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    await r.arrayBuffer();
  }
  // 边界值放行
  assert.equal((await put('880102', { offsetMs: 300000 })).status, 200);
  assert.equal((await put('880102', { offsetMs: -300000 })).status, 200);
});

test('song-meta：PUT 写端点过 CSRF 闸——异源 Origin 403；GET 只读不受闸', async () => {
  const r = await app.request('http://t/song-meta/880103', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', origin: 'http://evil.example' },
    body: JSON.stringify({ offsetMs: 100 }),
  });
  assert.equal(r.status, 403);
  // 对照：无 Origin 的同请求照常进门（非浏览器客户端不受闸影响）
  assert.equal((await put('880103', { offsetMs: 100 })).status, 200);
  // GET 是只读端点——异源 Origin 不拦（与全站 GET 同口径）
  const g = await app.request('http://t/song-meta/880103', {
    headers: { origin: 'http://evil.example' },
  });
  assert.equal(g.status, 200);
});

test('song-meta：id 白名单——非法字符 400', async () => {
  assert.equal((await app.request('http://t/song-meta/bad%20id')).status, 400);
  assert.equal((await app.request('http://t/song-meta/' + 'a'.repeat(65))).status, 400);
  assert.equal((await put('bad%20id', { offsetMs: 1 })).status, 400);
});

test('song-meta：词属主键全形收——ext 词源 id（lrclib_+120）/qq_/file_/bv_/yt_ 放行', async () => {
  // 外源词属主键可比旧 64 字符通用正则长（EXT_LYRIC_ID_STRICT_RE 到
  // lrclib_+120）——旧闸会把合法外源键 400 掉，校准写不进去
  const longExt = 'lrclib_' + 'x'.repeat(120);
  assert.equal((await app.request(`http://t/song-meta/${longExt}`)).status, 200);
  for (const id of ['qq_0123456789ab', 'file_abcdef12', 'bv_BV1xx411c7mD', 'yt_dQw4w9WgXcQ']) {
    assert.equal((await app.request(`http://t/song-meta/${id}`)).status, 200, id);
  }
  // 形态集合外的串仍拒：泛字母数字串、超 120 的 ext 后缀、路径形
  assert.equal((await app.request('http://t/song-meta/notavalididform')).status, 400);
  assert.equal((await app.request('http://t/song-meta/lrclib_' + 'x'.repeat(121))).status, 400);
});

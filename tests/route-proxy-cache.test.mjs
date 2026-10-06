// /audio-proxy/t/<token> 的媒体缓存集成：cacheKey mint → 首发过路落盘 →
// 二发完整档直喂不触上游；Range 分段覆盖累计→complete 后整段离线可播；
// 无 cacheKey 条目不受影响。桩面与 route-proxy.test.mjs 同口径
// （net-guard 半桩 + fetch 全桩，不打真网络）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { seed, tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-route-cache-');
const require = createRequire(import.meta.url);

const realGuard = require('../src/server/lib/net-guard.js');
seed('../src/server/lib/net-guard.js', {
  ...realGuard,
  resolvesToPublicIp: async () => true,
});

const fetchCalls = [];
let upstreamHandler = async () => new Response('upstream-bytes', {
  status: 200,
  headers: { 'content-type': 'audio/mp4', 'content-length': '14' },
});
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url: String(url), headers: init?.headers || {} });
  return upstreamHandler(url, init);
};

let app, streamVault, mediaCache;
before(() => {
  app = require('../src/server/routes/proxy.js');
  streamVault = require('../src/server/lib/stream-vault.js');
  mediaCache = require('../src/server/services/media-cache.js');
});
after(() => { rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

const get = (path, init = {}) => app.request(`http://t${path}`, init);

test('proxy-cache：cacheKey 首发过路落盘，二发完整档直喂不触上游', async () => {
  const cacheKey = 'yt_cachehit001_a_mp4a.40.2_131072';
  const before1 = fetchCalls.length;
  const token = streamVault.mint('https://a.kuwo.cn/song.m4a', { cacheKey });
  const r1 = await get(`/audio-proxy/t/${token}`);
  assert.equal(r1.status, 200);
  assert.equal(await r1.text(), 'upstream-bytes');
  assert.equal(fetchCalls.length, before1 + 1, '首发照常回源');

  // 捕获已落完整档——换个 token（模拟签名过期重解）同键命中
  const meta = mediaCache.lookup(cacheKey);
  assert.ok(meta?.complete, '首发过路应捕获成完整档');
  assert.deepEqual(meta.ranges, [[0, 13]]);

  const token2 = streamVault.mint('https://a.kuwo.cn/song.m4a?sig=expired', { cacheKey });
  const r2 = await get(`/audio-proxy/t/${token2}`);
  assert.equal(r2.status, 200);
  assert.equal(await r2.text(), 'upstream-bytes');
  assert.equal(r2.headers.get('content-type'), 'audio/mp4');
  assert.equal(fetchCalls.length, before1 + 1, '二发命中盘上档，上游零请求');
});

test('proxy-cache：Range 分段覆盖累计→complete，此后任意请求离线可播', async () => {
  const cacheKey = 'yt_rangeseg01_a_mp4a.40.2_131072';
  const body = '0123456789'; // 10 字节
  upstreamHandler = async (url, init) => {
    // 代理侧注头键是 'Range'——headers 大小写不敏感地取
    const rangeHeader = Object.entries(init?.headers || {})
      .find(([k]) => k.toLowerCase() === 'range')?.[1] || '';
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader) || [];
    const s = parseInt(m[1], 10);
    const e = m[2] ? parseInt(m[2], 10) : body.length - 1;
    return new Response(body.slice(s, e + 1), {
      status: 206,
      headers: {
        'content-type': 'audio/mp4',
        'content-range': `bytes ${s}-${e}/${body.length}`,
        'accept-ranges': 'bytes',
      },
    });
  };
  const token = streamVault.mint('https://a.kuwo.cn/seg.m4a', { cacheKey });
  const base = fetchCalls.length;

  const r1 = await get(`/audio-proxy/t/${token}`, { headers: { range: 'bytes=0-4' } });
  assert.equal(r1.status, 206);
  assert.equal(await r1.text(), '01234');
  // 半截档不命中——第二段照常回源
  const r2 = await get(`/audio-proxy/t/${token}`, { headers: { range: 'bytes=5-' } });
  assert.equal(r2.status, 206);
  assert.equal(await r2.text(), '56789');
  assert.equal(fetchCalls.length, base + 2);

  const meta = mediaCache.lookup(cacheKey);
  assert.equal(meta?.complete, true, '两段覆盖应合并成完整档');

  // 此后全量与 Range 都由盘上喂——连 Range 请求也不再回源
  const r3 = await get(`/audio-proxy/t/${token}`);
  assert.equal(r3.status, 200);
  assert.equal(await r3.text(), body);
  const r4 = await get(`/audio-proxy/t/${token}`, { headers: { range: 'bytes=2-5' } });
  assert.equal(r4.status, 206);
  assert.equal(r4.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(await r4.text(), '2345');
  assert.equal(fetchCalls.length, base + 2, '完整后所有请求零回源');
});

test('proxy-cache：无 cacheKey 条目每发都回源（自然短路不挂缓存）', async () => {
  upstreamHandler = async () => new Response('plain', {
    status: 200, headers: { 'content-type': 'audio/mp4' },
  });
  const token = streamVault.mint('https://a.kuwo.cn/plain.mp3');
  const base = fetchCalls.length;
  await get(`/audio-proxy/t/${token}`);
  await get(`/audio-proxy/t/${token}`);
  assert.equal(fetchCalls.length, base + 2, '无键不缓存，两发都回源');
});

test('proxy-cache：encoded 响应不捕获（字节与落盘语义不符）', async () => {
  upstreamHandler = async () => new Response('gzipfake', {
    status: 200,
    headers: { 'content-type': 'audio/mp4', 'content-encoding': 'gzip' },
  });
  const cacheKey = 'yt_encoded001_a_mp4a.40.2_131072';
  const token = streamVault.mint('https://a.kuwo.cn/enc.m4a', { cacheKey });
  const r = await get(`/audio-proxy/t/${token}`);
  assert.equal(r.status, 200);
  await r.text();
  assert.equal(mediaCache.lookup(cacheKey), null, 'encoded 流不该落盘');
  // 复位
  upstreamHandler = async () => new Response('upstream-bytes', {
    status: 200, headers: { 'content-type': 'audio/mp4', 'content-length': '14' },
  });
});

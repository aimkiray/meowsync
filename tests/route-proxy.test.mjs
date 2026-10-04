// routes/proxy.js 冒烟：url 缺失 400 / 协议与端口策略 403 / 白名单外域 403 /
// 上游成功透传形状（安全头+CSP sandbox）/ 上游 ≥400 透出 / 302 重定向逐跳重验 /
// 畸形 Range 400 / vault token 失效 404。
// net-guard 半桩：真 normalizeOutboundUrl/isProxyAllowedHost（策略面就是要测的），
// resolvesToPublicIp 桩成 true（离网可跑——DNS/SSRF 真判定在 net-guard 自身覆盖）。
// 上游 fetch 全桩，不打真网络。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { seed, tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-route-proxy-');
const require = createRequire(import.meta.url);

// 先取真身再播种——策略函数保持真实现
const realGuard = require('../src/server/lib/net-guard.js');
seed('../src/server/lib/net-guard.js', {
  ...realGuard,
  resolvesToPublicIp: async () => true,
});

const fetchCalls = [];
let upstreamHandler = async () => new Response('audio-bytes', {
  status: 200,
  headers: { 'content-type': 'audio/mp4', 'content-length': '11' },
});
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url: String(url), headers: init?.headers || {} });
  return upstreamHandler(url, init);
};

let app, streamVault;
before(() => {
  app = require('../src/server/routes/proxy.js');
  streamVault = require('../src/server/lib/stream-vault.js');
});
after(() => { rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

const get = (path, init = {}) => app.request(`http://t${path}`, init);
const json = async (res) => ({ status: res.status, body: await res.json().catch(() => null) });

test('proxy：缺 url 400；协议违例 403', async () => {
  assert.equal((await get('/audio-proxy')).status, 400);
  const r = await json(await get(`/audio-proxy?url=${encodeURIComponent('ftp://x/y')}`));
  assert.equal(r.status, 403);
});

test('proxy：白名单外域 403（不出 fetch 调用）', async () => {
  const before = fetchCalls.length;
  const r = await json(await get(`/audio-proxy?url=${encodeURIComponent('https://evil.example/x.mp3')}`));
  assert.equal(r.status, 403);
  assert.equal(fetchCalls.length, before);
});

test('proxy：白名单域 200 透传 + 安全头齐（ACAO/nosniff/CSP sandbox）', async () => {
  const res = await get(`/audio-proxy?url=${encodeURIComponent('https://a.kuwo.cn/x.mp3')}`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'audio-bytes');
  assert.equal(res.headers.get('content-type'), 'audio/mp4');
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('content-security-policy'), 'sandbox');
});

test('proxy：上游 ≥400 透出状态（候选拒绝语义）', async () => {
  upstreamHandler = async () => new Response('no', { status: 500 });
  const r = await json(await get(`/audio-proxy?url=${encodeURIComponent('https://a.kuwo.cn/x.mp3')}`));
  assert.equal(r.status, 500);
  upstreamHandler = async () => new Response('audio-bytes', {
    status: 200, headers: { 'content-type': 'audio/mp4' },
  });
});

test('proxy：302 逐跳重验——重定向到白名单外域仍 403', async () => {
  upstreamHandler = async (url) => {
    if (String(url).includes('music.126.net')) {
      return new Response(null, { status: 302, headers: { location: 'https://evil.example/t' } });
    }
    return new Response('x', { status: 200 });
  };
  const r = await json(await get(`/audio-proxy?url=${encodeURIComponent('https://music.126.net/a.mp3')}`));
  assert.equal(r.status, 403);
  upstreamHandler = async () => new Response('audio-bytes', {
    status: 200, headers: { 'content-type': 'audio/mp4' },
  });
});

test('proxy：畸形/多段 Range 400（multipart 不兼容面）', async () => {
  for (const range of ['bytes=0-1,3-5', 'bytes=-', 'nonsense']) {
    const r = await get(`/audio-proxy?url=${encodeURIComponent('https://a.kuwo.cn/x.mp3')}`, {
      headers: { range },
    });
    assert.equal(r.status, 400, range);
    await r.arrayBuffer();
  }
});

test('proxy：vault token 失效 404；有效 token 透传上游', async () => {
  const bad = await json(await get('/audio-proxy/t/no-such-token'));
  assert.equal(bad.status, 404);
  assert.match(bad.body.message, /expired/);

  const token = streamVault.mint('https://a.kuwo.cn/vaulted.mp3');
  const res = await get(`/audio-proxy/t/${token}`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'audio-bytes');
  assert.equal(fetchCalls.at(-1).url, 'https://a.kuwo.cn/vaulted.mp3');
});

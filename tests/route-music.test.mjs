// routes/music.js 冒烟：/:apiName 白名单端点的写方法 CSRF 纵深钉板——
// 该端点是路由层唯一收非 GET 写方法的收单口，csrfOriginOk 闸与
// match.js POST /match/retry 同口径：跨站 Origin 的 POST/PATCH → 403
// 且不打上游；无 Origin 的非浏览器请求照常放行（不误伤 API 客户端）；
// GET/HEAD 只读不挂闸。上游 netease-api 全桩——云搜不打真网络。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { seed, tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-route-music-');
const require = createRequire(import.meta.url);

// ── 桩：网易云上游——callNeteaseApi 录制入参，回固定 200 信封 ──
const apiCalls = [];
seed('../src/server/services/netease-api.js', {
  apiModules: { search: {}, lyric: {} },
  callNeteaseApi: async (name, params) => {
    apiCalls.push({ name, params });
    return { status: 200, body: { code: 200, echoed: name }, cookie: [] };
  },
  resolveSongUrls: async () => {},
  needsUnlock: () => false,
  MAX_UNLOCK_ITEMS: 20,
});

let app;
before(() => { app = require('../src/server/routes/music.js'); });
after(() => { rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

const req = (path, init = {}) => app.request(`http://t${path}`, init);

test('music：写方法带跨站 Origin → 403 且零上游扇出', async () => {
  apiCalls.length = 0;
  for (const method of ['POST', 'PATCH', 'DELETE']) {
    const r = await req('/search', {
      method,
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ keywords: 'x' }),
    });
    assert.equal(r.status, 403, method);
    assert.equal((await r.json()).code, 403);
  }
  assert.equal(apiCalls.length, 0);   // CSRF 闸在限流/上游扇出之前
});

test('music：写方法无 Origin（非浏览器客户端）照常放行到上游', async () => {
  apiCalls.length = 0;
  const r = await req('/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ keywords: '周杰伦' }),
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).echoed, 'search');
  assert.equal(apiCalls.length, 1);
  assert.equal(apiCalls[0].params.keywords, '周杰伦');
});

test('music：Origin 缺失但 Sec-Fetch-Site: cross-site → 403（剥 Origin 链路兜底）', async () => {
  apiCalls.length = 0;
  const r = await req('/search', {
    method: 'POST',
    headers: { 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(r.status, 403);
  assert.equal(apiCalls.length, 0);
});

test('music：GET 只读不挂 CSRF 闸——异源 Origin 照常过上游', async () => {
  apiCalls.length = 0;
  const r = await req('/search?keywords=x', {
    headers: { origin: 'https://evil.example' },
  });
  assert.equal(r.status, 200);
  assert.equal(apiCalls.length, 1);
});

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

// ── 桩：网易云上游——callNeteaseApi 录制入参（含第三参 options——signal/
// timeoutMs 透传面），默认回固定 200 信封；
// upstreamImpl 可例内替换（模拟上游 reject answer / 在途断连组合）
const apiCalls = [];
let upstreamImpl = async (name) => ({ status: 200, body: { code: 200, echoed: name }, cookie: [] });
seed('../src/server/services/netease-api.js', {
  apiModules: { search: {}, lyric: {} },
  callNeteaseApi: async (name, params, options) => {
    apiCalls.push({ name, params, options });
    return upstreamImpl(name, params);
  },
  resolveSongUrls: async () => {},
  needsUnlock: () => false,
  MAX_UNLOCK_ITEMS: 20,
});

let app;
let ALLOWED_APIS;
before(() => {
  app = require('../src/server/routes/music.js');
  ALLOWED_APIS = app.ALLOWED_APIS; // module.exports.ALLOWED_APIS 挂在 app 上
});
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

test('music：/lyric 的 id 只收网易云数字——abc 400 不打上游；数字 id 放行', async () => {
  apiCalls.length = 0;
  const bad = await req('/lyric?id=abc');
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).code, 400);
  // qq_/ext 词源 id 同拒——它们走自家路由不是 passthrough
  assert.equal((await req('/lyric?id=qq_0123456789ab')).status, 400);
  assert.equal((await req('/lyric?id=lrclib_55')).status, 400);
  assert.equal(apiCalls.length, 0);
  const ok = await req('/lyric?id=2731319524');
  assert.equal(ok.status, 200);
  assert.equal(apiCalls.length, 1);
  assert.equal(apiCalls[0].params.id, '2731319524');
});

test('music：lyric_new 移出 passthrough 白名单 → 404', async () => {
  apiCalls.length = 0;
  assert.equal((await req('/lyric_new?id=1')).status, 404);
  assert.equal(apiCalls.length, 0);
});

// 零前端消费端点随白名单收面摘除——ENDPOINTS 定义仍在（进程内/兼容留档），
// 但 /:apiName 透传面不再放行；每个摘除名都钉 404 防悄悄复活
test('music：零消费端点摘出白名单 → 一律 404 且零上游扇出', async () => {
  apiCalls.length = 0;
  for (const name of ['song_url_v1', 'check_music', 'album', 'artists', 'banner', 'toplist']) {
    // 桩 apiModules 只含 search/lyric——摘除名即便复活回白名单，HTTP 断言
    // 也照拿 404（!apiModules[name] 短路）永不红；白名单集判定才是真复活钉
    assert.ok(!ALLOWED_APIS.has(name), `端点 ${name} 复活进了白名单`);
    assert.equal((await req(`/${name}?id=1`)).status, 404, name);
  }
  assert.equal(apiCalls.length, 0);
});

test('music：Set-Cookie 白名单透传——ms_session/异键/超长值滤掉，网易已知键过', async () => {
  apiCalls.length = 0;
  const saved = upstreamImpl;
  upstreamImpl = async () => ({
    status: 200,
    body: { code: 200 },
    cookie: [
      'MUSIC_U=abc; Path=/; HttpOnly',
      'ms_session=hijack; Path=/',                    // 撞本站会话名——显式拒
      'MS_SESSION=also-bad; Path=/',                  // 大小写变体同拒
      'EVIL_KEY=x; Path=/',                           // 白名单外键族
      `NMTID=${'v'.repeat(5000)}; Path=/`,            // 值超 4096 → 滤
      '__csrf=token123; Path=/',
      'WM_NI=xx; Path=/',
      '_ntes_nuid=nu; Path=/',                        // 下行独有键（回带白名单外）
    ],
  });
  try {
    const r = await req('/search?keywords=x');
    assert.equal(r.status, 200);
    const setCookies = r.headers.getSetCookie();
    const keys = setCookies.map(s => s.split('=', 1)[0]);
    assert.deepEqual(keys.sort(), ['MUSIC_U', 'WM_NI', '_ntes_nuid', '__csrf'].sort());
  } finally {
    upstreamImpl = saved;
  }
});

test('music：Set-Cookie 总条数封顶 20', async () => {
  const saved = upstreamImpl;
  upstreamImpl = async () => ({
    status: 200,
    body: { code: 200 },
    cookie: Array.from({ length: 25 }, (_, i) => `WM_TID=v${i}; Path=/`),
  });
  try {
    const r = await req('/search?keywords=x');
    assert.equal(r.status, 200);
    assert.equal(r.headers.getSetCookie().length, 20);
  } finally {
    upstreamImpl = saved;
  }
});

test('music：断连优先于上游 answer 透传——aborted 时 upstream answer 归一 499', async () => {
  apiCalls.length = 0;
  const ac = new AbortController();
  const saved = upstreamImpl;
  upstreamImpl = async () => {
    ac.abort();                                    // 在途断连
    throw { status: 502, body: { code: 502 } };    // 上游 answer 形态（非 Error）
  };
  try {
    // aborted 判必须先于 isUpstreamAnswer——否则断连请求会拿到 502 假错
    const r = await req('/search?keywords=x', { signal: ac.signal });
    assert.equal(r.status, 499);
  } finally {
    upstreamImpl = saved;
  }
  // 对照：未断连的同型 answer 照常透传上游状态码
  upstreamImpl = async () => { throw { status: 502, body: { code: 502 } }; };
  try {
    assert.equal((await req('/search?keywords=y')).status, 502);
  } finally {
    upstreamImpl = saved;
  }
});

// ambient Cookie 注入双向钉：仅 params.cookie 缺席（=== undefined）才注入
// 本域凭据——显式 cookie:null 是调用方自填值（要游客态/自有凭据），被
// ambient 覆盖等于把本站 SSO/网关会话泄给上游；缺席方向则锁注入本身
// 不丢（注入还要过 NETEASE_COOKIE_KEYS 白名单，ms_session 这种本站键滤掉）
test('music：显式 cookie:null 不被 ambient 覆盖；cookie 缺席走白名单注入', async () => {
  apiCalls.length = 0;
  const ambient = { cookie: 'MUSIC_U=ambient-u; ms_session=site-session' };
  const explicit = await req('/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ambient },
    body: JSON.stringify({ keywords: 'x', cookie: null }),
  });
  assert.equal(explicit.status, 200);
  assert.equal(apiCalls.length, 1);
  assert.equal(apiCalls[0].params.cookie, null, '显式 cookie:null 不得被 ambient 覆盖');
  const absent = await req('/search?keywords=x', { headers: ambient });
  assert.equal(absent.status, 200);
  assert.equal(apiCalls.length, 2);
  assert.equal(apiCalls[1].params.cookie, 'MUSIC_U=ambient-u',
    'cookie 缺席应注入白名单过滤后的 ambient 凭据');
});

// signal 透传钉：路由层把客户端在途信号交给 callNeteaseApi 第三参——
// Request 构造器产「跟随体」AbortSignal 而非同一对象（=== 会误判），
// 故钉 instanceof + 跟随 abort 语义（断连杀上游 socket 链的接线）
test('music：options.signal 透传——AbortSignal 实例且跟随客户端断连', async () => {
  apiCalls.length = 0;
  const ac = new AbortController();
  const r = await req('/search?keywords=x', { signal: ac.signal });
  assert.equal(r.status, 200);
  assert.equal(apiCalls.length, 1);
  const sig = apiCalls[0].options?.signal;
  assert.ok(sig instanceof AbortSignal, '第三参 options.signal 应为 AbortSignal');
  ac.abort();
  assert.equal(sig.aborted, true, 'options.signal 须跟随客户端请求信号 abort');
});

// routes/img-proxy.js 冒烟：url 缺失/坏 URL 400 / 协议与端口策略 403 /
// 白名单外域 403（零回源）/ 解析私网 403 / HEAD 405 零回源 / 上游 ≥400 透码不透体 /
// 302 逐跳重验（白名单跟随、出白 403、私网 403、超 3 跳 502、无 location 502）/
// 类型闸（text/html·octet-stream·缺头·svg+xml 502；大小写+参数合规放行）/
// 体积闸（content-length 早拒+body cancel、流侧兜底超界 502）/ 成功 200 头面
// （Cache-Control public 86400、ACAO、nosniff、CSP sandbox、ETag 透传、
// Content-Length 按实读重计）/ 304 条件请求链 / fetch 抛错 502 / 超时 504 /
// 限流 key=img-proxy 429 / YT 族 dispatcher 换道且跳过公网校验 /
// isApiPath('/img-proxy') PREFIXES 命中。
// net-guard 半桩：真 normalizeOutboundUrl/isImgProxyHost 策略面就是要测的，
// resolvesToPublicIp 换可控桩（离网可跑）；rate-limit/yt-proxy 可控桩；
// 上游 fetch 全桩，不打真网络。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { seed, tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-route-img-proxy-');
const require = createRequire(import.meta.url);

// ── 桩：net-guard——策略函数保持真实现，仅公网判定换成录制桩
const realGuard = require('../src/server/lib/net-guard.js');
const publicIpCalls = [];
let publicIpImpl = async () => true;
seed('../src/server/lib/net-guard.js', {
  ...realGuard,
  resolvesToPublicIp: (h) => { publicIpCalls.push(h); return publicIpImpl(h); },
});

// ── 桩：rate-limit——记录桶 key/限额，rateAllow 例内可关
const rateCalls = [];
let rateAllow = true;
seed('../src/server/lib/rate-limit.js', {
  rateLimit: (c, key, limit) => { rateCalls.push({ key, limit }); return rateAllow; },
});

// ── 桩：yt-proxy——isYoutubeHost 保持真实现（判定口径本身是被测面），
// ytDispatcher 换可控桩：非 null 时断言 fetch init.dispatcher 直吃它
const realYt = require('../src/server/lib/yt-proxy.js');
let ytAgent = null;
seed('../src/server/lib/yt-proxy.js', {
  ...realYt,
  ytDispatcher: () => ytAgent,
});

// ── 桩：上游 fetch——url/init 全录制（method/headers/dispatcher/signal 可断言）
const fetchCalls = [];
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // 4 字节假图
let upstreamHandler = async () => new Response(PNG, {
  status: 200,
  headers: { 'content-type': 'image/png', 'content-length': String(PNG.byteLength) },
});
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url: String(url), init: init || {} });
  return upstreamHandler(url, init);
};

let app;
before(() => { app = require('../src/server/routes/img-proxy.js'); });
after(() => { rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

const u = (s) => encodeURIComponent(s);
const get = (path, init = {}) => app.request(`http://t${path}`, init);
const img = (target, init) => get(`/img-proxy?url=${u(target)}`, init);
const json = async (res) => ({ status: res.status, body: await res.json().catch(() => null) });

// 每例复位：上游回 200 PNG、公网判定放行、限流放行、无 YT dispatcher
const reset = () => {
  upstreamHandler = async () => new Response(PNG, {
    status: 200,
    headers: { 'content-type': 'image/png', 'content-length': String(PNG.byteLength) },
  });
  publicIpImpl = async () => true;
  publicIpCalls.length = 0;
  rateCalls.length = 0;
  rateAllow = true;
  fetchCalls.length = 0;
  ytAgent = null;
};

test('img-proxy：HEAD/POST 不服务——HEAD 405 零回源，POST 404', async () => {
  reset();
  const head = await img('https://i0.hdslb.com/x.png', { method: 'HEAD' });
  assert.equal(head.status, 405);
  await head.arrayBuffer();
  assert.equal(fetchCalls.length, 0); // 方法闸在任何回源之前

  const post = await img('https://i0.hdslb.com/x.png', { method: 'POST' });
  assert.equal(post.status, 404); // 未注册方法落框架 notFound（主 app 处才是 JSON 壳）
  await post.arrayBuffer();
  assert.equal(fetchCalls.length, 0);
});

test('img-proxy：缺 url/空 url/坏 URL → 400；非 http(s) 与非标端口 → 403', async () => {
  reset();
  assert.equal((await get('/img-proxy')).status, 400);
  assert.equal((await get('/img-proxy?url=')).status, 400);
  let r = await json(await get('/img-proxy'));
  assert.equal(r.body.message, 'missing url');
  r = await json(await img('not a url'));
  assert.equal(r.status, 400);
  assert.equal(r.body.message, 'invalid url');
  r = await json(await img('ftp://i0.hdslb.com/x.png'));
  assert.equal(r.status, 403);
  assert.equal(r.body.message, 'forbidden protocol');
  r = await json(await img('javascript:alert(1)'));
  assert.equal(r.status, 403);
  for (const bad of ['https://i0.hdslb.com:8080/x.png', 'http://i0.hdslb.com:0/x.png']) {
    r = await json(await img(bad));
    assert.equal(r.status, 403, bad);
    assert.equal(r.body.message, 'forbidden port');
  }
  assert.equal(fetchCalls.length, 0);
});

test('img-proxy：白名单外域/蹭名/尾挂/IP 字面量/嵌套自链 → 403 零回源', async () => {
  reset();
  for (const host of [
    'https://evil.example/x.png',
    'https://xytimg.com/x.jpg',            // 蹭名：不是 .ytimg.com 后缀
    'https://ytimg.com.evil.com/x.jpg',    // 尾挂：白名单域是中间段
    // y.qq.com 收窄钉：白名单只收 music-file./qpic. 两个封面专用子域——
    // 裸域与 musicu/fcg JSON 端点子域（u./c./shc）不收，宽收=扩代取回源面
    'https://y.qq.com/n/ryqq/playlist/8313', // 裸 y.qq.com 不入白
    'https://u.y.qq.com/cgi-bin/musicu.fcg', // musicu/fcg 端点子域同拒
    'https://shc.y.qq.com/x.jpg',            // 兄弟子域不在封面宿主之列
    'https://qpic.y.qq.com.evil.com/x.jpg',  // 尾挂：白名单域是中间段
    'https://evil-y.qq.com.attacker.com/x.jpg', // 尾挂 attacker.com 同理
    'https://xqpic.y.qq.com/x.jpg',          // 蹭名：缺 . 边界的前缀同型
    'https://127.0.0.1/x.png',             // IP 字面量天然不命中后缀表
    'https://169.254.169.254/latest/meta', // 云元数据
    'http://localhost/img-proxy?url=x', // 嵌套自链：我方域不在白名单
  ]) {
    const r = await json(await img(host));
    assert.equal(r.status, 403, host);
    assert.equal(r.body.message, 'forbidden host', host);
  }
  assert.equal(fetchCalls.length, 0);
});

test('img-proxy：白名单域解析非公网 → 403 forbidden address', async () => {
  reset();
  publicIpImpl = async () => false;
  const r = await json(await img('https://p1.music.126.net/x.jpg'));
  assert.equal(r.status, 403);
  assert.equal(r.body.message, 'forbidden address');
  assert.equal(fetchCalls.length, 0);
});

test('img-proxy：成功 200——字节全等、头面齐、Content-Length 按实读重计', async () => {
  reset();
  // 上游 content-length 谎报与实体不符 → 下行按实际缓冲字节数
  upstreamHandler = async () => new Response(PNG, {
    status: 200,
    headers: {
      'content-type': 'image/png',
      'content-length': '999',
      etag: '"v1"',
      'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT',
    },
  });
  const res = await img('https://i0.hdslb.com/a.png', {
    headers: { cookie: 'ms_session=secret', range: 'bytes=0-1' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), PNG);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('content-length'), String(PNG.byteLength));
  assert.equal(res.headers.get('cache-control'), 'public, max-age=86400');
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('content-security-policy'), 'sandbox');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('etag'), '"v1"');
  assert.equal(res.headers.get('last-modified'), 'Wed, 21 Oct 2015 07:28:00 GMT');

  // 上行头面：真实浏览器 UA + identity + hdslb 系 Referer；会话/Range 不透
  const sent = fetchCalls.at(-1);
  assert.equal(sent.url, 'https://i0.hdslb.com/a.png');
  assert.equal(sent.init.method, 'GET');
  assert.equal(sent.init.redirect, 'manual');
  assert.match(sent.init.headers['User-Agent'], /Chrome\/126/);
  assert.equal(sent.init.headers['Accept-Encoding'], 'identity');
  assert.equal(sent.init.headers['Referer'], 'https://www.bilibili.com/');
  assert.equal(sent.init.headers['Cookie'], undefined);
  assert.equal(sent.init.headers['Range'], undefined);
  // 非 hdslb 白名单域不附 Referer
  await img('https://p1.music.126.net/a.jpg');
  assert.equal(fetchCalls.at(-1).init.headers['Referer'], undefined);
});

test('img-proxy：http 明文回链放行；FQDN 尾点与 userinfo 被归一化剥掉', async () => {
  reset();
  assert.equal((await img('http://i0.hdslb.com/x.png')).status, 200);
  assert.equal(fetchCalls.at(-1).url, 'http://i0.hdslb.com/x.png');
  assert.equal((await img('https://i.ytimg.com./vi/x/hqdefault.jpg')).status, 200);
  assert.equal(fetchCalls.at(-1).url, 'https://i.ytimg.com/vi/x/hqdefault.jpg');
  assert.equal((await img('https://user:pw@i0.hdslb.com/x.png')).status, 200);
  assert.equal(fetchCalls.at(-1).url, 'https://i0.hdslb.com/x.png');
  // QQ 歌单封面实测宿主过白名单闸：music-file.y.qq.com（https 侧）与
  // qpic.y.qq.com（http 明文侧）——回源 URL 逐字节透传到上游
  assert.equal((await img('https://music-file.y.qq.com/mcover/x.jpg')).status, 200);
  assert.equal(fetchCalls.at(-1).url, 'https://music-file.y.qq.com/mcover/x.jpg');
  assert.equal((await img('http://qpic.y.qq.com/mcover/x.jpg')).status, 200);
  assert.equal(fetchCalls.at(-1).url, 'http://qpic.y.qq.com/mcover/x.jpg');
});

test('img-proxy：YT 族命中 isYoutubeHost → fetch 吃 ytDispatcher 桩且跳过公网校验', async () => {
  reset();
  ytAgent = { marker: 'yt-proxy-agent' };
  const res = await img('https://i.ytimg.com/vi/x/hqdefault.jpg');
  assert.equal(res.status, 200);
  await res.arrayBuffer();
  assert.equal(fetchCalls.at(-1).init.dispatcher, ytAgent);
  assert.equal(publicIpCalls.length, 0); // 代理通道下本机 DNS 答案无关

  // ggpht 同属 YT 族；未配置（桩回 null）时落回钉扎直连
  ytAgent = null;
  const r2 = await img('https://yt3.ggpht.com/a.jpg');
  assert.equal(r2.status, 200);
  await r2.arrayBuffer();
  const sent = fetchCalls.at(-1);
  assert.ok(sent.init.dispatcher && sent.init.dispatcher !== ytAgent);
  assert.equal(sent.init.dispatcher.constructor.name, 'Agent'); // makeGuardedLookup 钉扎 Agent
  assert.deepEqual(publicIpCalls, ['yt3.ggpht.com']);
});

test('img-proxy：302 逐跳重验——白名单跟随、出白 403、私网 403、超 3 跳 502、畸形/缺 location 502', async () => {
  reset();
  // 相对 location 同域跟随：两跳后 200，第二跳重跑校验链
  upstreamHandler = async (url) => String(url).endsWith('/a.png')
    ? new Response(null, { status: 302, headers: { location: '/b.png' } })
    : new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
  const ok = await img('https://i0.hdslb.com/a.png');
  assert.equal(ok.status, 200);
  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls.at(-1).url, 'https://i0.hdslb.com/b.png');
  assert.deepEqual(publicIpCalls, ['i0.hdslb.com', 'i0.hdslb.com']);

  // 跳去非白名单 → 下一跳域名闸 403
  reset();
  upstreamHandler = async () => new Response(null, {
    status: 302, headers: { location: 'https://evil.example/t.png' },
  });
  let r = await json(await img('https://i0.hdslb.com/a.png'));
  assert.equal(r.status, 403);
  assert.equal(r.body.message, 'forbidden host');
  assert.equal(fetchCalls.length, 1); // 只对首跳回过源

  // 跳去解析私网的白名单名 → 公网闸 403
  reset();
  publicIpImpl = async (h) => h !== 'p1.music.126.net';
  upstreamHandler = async () => new Response(null, {
    status: 302, headers: { location: 'https://p1.music.126.net/t.jpg' },
  });
  r = await json(await img('https://i0.hdslb.com/a.png'));
  assert.equal(r.status, 403);
  assert.equal(r.body.message, 'forbidden address');

  // 自环 302：跟随满 3 次后仍 3xx → 502（至多 4 次上游请求）
  reset();
  upstreamHandler = async (url) => new Response(null, {
    status: 302, headers: { location: String(url) },
  });
  r = await json(await img('https://i0.hdslb.com/a.png'));
  assert.equal(r.status, 502);
  assert.equal(r.body.message, 'too many redirects');
  assert.equal(fetchCalls.length, 4);

  // 3xx 缺 location → 502；location 解析失败 → 502
  reset();
  upstreamHandler = async () => new Response(null, { status: 302 });
  r = await json(await img('https://i0.hdslb.com/a.png'));
  assert.equal(r.status, 502);
  assert.equal(r.body.message, 'upstream redirect without location');
  upstreamHandler = async () => new Response(null, {
    status: 302, headers: { location: 'http://[::1' },
  });
  r = await json(await img('https://i0.hdslb.com/a.png'));
  assert.equal(r.status, 502);
  assert.equal(r.body.message, 'invalid redirect location');
});

test('img-proxy：上游 ≥400 透传状态码、空体、no-store', async () => {
  reset();
  upstreamHandler = async () => new Response('<html>no</html>', { status: 500 });
  let res = await img('https://i0.hdslb.com/a.png');
  assert.equal(res.status, 500);
  assert.equal(await res.text(), ''); // 不透上游错误页
  assert.equal(res.headers.get('cache-control'), 'no-store');
  upstreamHandler = async () => new Response('no', { status: 404 });
  res = await img('https://i0.hdslb.com/a.png');
  assert.equal(res.status, 404);
  assert.equal(await res.text(), '');
});

test('img-proxy：类型闸——text/html/octet-stream/缺头/svg+xml → 502；大小写+参数合规放行', async () => {
  reset();
  for (const [type, note] of [
    ['text/html', 'html'],
    ['application/octet-stream', 'bin'],
    [null, 'missing'],
    ['image/svg+xml', 'svg'],
    ['IMAGE/SVG+XML; charset=utf-8', 'svg 大小写+参数'],
  ]) {
    upstreamHandler = async () => new Response(PNG, {
      status: 200, headers: type ? { 'content-type': type } : {},
    });
    const r = await json(await img('https://i0.hdslb.com/a.png'));
    assert.equal(r.status, 502, note);
    assert.equal(r.body.message, 'upstream not an image', note);
  }
  // 合规：image/* 大小写不敏感、';' 参数归一，原值透传
  upstreamHandler = async () => new Response(PNG, {
    status: 200, headers: { 'content-type': 'IMAGE/JPEG; charset=binary' },
  });
  const res = await img('https://i0.hdslb.com/a.jpg');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'IMAGE/JPEG; charset=binary');
  await res.arrayBuffer();
});

test('img-proxy：体积闸——content-length 超限早拒且 body cancel；流侧超界兜底 502', async () => {
  reset();
  // 头侧：声明 9MiB 早拒，实体字节一个都不拉（源流 cancel 计数为证）
  let cancelled = false;
  const declaredBig = new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(8)); },
    cancel() { cancelled = true; },
  });
  upstreamHandler = async () => new Response(declaredBig, {
    status: 200,
    headers: { 'content-type': 'image/png', 'content-length': String(9 * 1024 * 1024) },
  });
  let r = await json(await img('https://i0.hdslb.com/a.png'));
  assert.equal(r.status, 502);
  assert.equal(r.body.message, 'image too large');
  await new Promise((res) => setImmediate(res));
  assert.equal(cancelled, true);

  // 流侧：无 content-length、实体 8MiB+1 → 超界即断
  reset();
  upstreamHandler = async () => new Response(new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); c.close(); },
  }), { status: 200, headers: { 'content-type': 'image/png' } });
  r = await json(await img('https://i0.hdslb.com/a.png'));
  assert.equal(r.status, 502);
  assert.equal(r.body.message, 'image too large');

  // 恰好上界放行
  upstreamHandler = async () => new Response(new Uint8Array(8 * 1024 * 1024), {
    status: 200, headers: { 'content-type': 'image/png' },
  });
  const ok = await img('https://i0.hdslb.com/a.png');
  assert.equal(ok.status, 200);
  assert.equal((await ok.arrayBuffer()).byteLength, 8 * 1024 * 1024);
});

test('img-proxy：fetch 抛错 → 502；连接+响应头超时 10s → 504', async (t) => {
  reset();
  upstreamHandler = async () => { throw new Error('reset'); };
  let r = await json(await img('https://i0.hdslb.com/a.png'));
  assert.equal(r.status, 502);
  assert.equal(r.body.message, 'upstream request failed');

  // 秒表 mock：超时控制器到点 abort，挂起的上游按 504 收场
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => t.mock.timers.reset()); // 断言中途抛错也复位，假秒表不漏给后续用例
  upstreamHandler = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const p = img('https://i0.hdslb.com/a.png').then((res) => json(res));
  await new Promise((res) => setImmediate(res)); // 让链路推进到挂起的 fetch
  t.mock.timers.tick(10000);
  r = await p;
  assert.equal(r.status, 504);
  assert.equal(r.body.message, 'upstream timeout');
});

test('img-proxy：限流被拒 → 429，桶 key=img-proxy 与 audio-proxy 隔离', async () => {
  reset();
  rateAllow = false;
  const r = await json(await img('https://i0.hdslb.com/a.png'));
  assert.equal(r.status, 429);
  assert.equal(r.body.message, '请求太频繁，稍后再试');
  assert.deepEqual(rateCalls, [{ key: 'img-proxy', limit: 300 }]);
  assert.equal(fetchCalls.length, 0);
});

test('img-proxy：条件请求透传——If-None-Match/If-Modified-Since 到上游，304 空体+可缓存', async () => {
  reset();
  upstreamHandler = async () => new Response(null, { status: 304 });
  const res = await img('https://i0.hdslb.com/a.png', {
    headers: { 'if-none-match': '"v1"', 'if-modified-since': 'Wed, 21 Oct 2015 07:28:00 GMT' },
  });
  assert.equal(fetchCalls.at(-1).init.headers['If-None-Match'], '"v1"');
  assert.equal(fetchCalls.at(-1).init.headers['If-Modified-Since'], 'Wed, 21 Oct 2015 07:28:00 GMT');
  assert.equal(res.status, 304);
  assert.equal(await res.text(), '');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=86400');
});

test('img-proxy：/img-proxy 在 isApiPath PREFIXES 表内（authGate/SPA 兜底同源分类）', () => {
  const { isApiPath } = require('../src/server/lib/api-path.js');
  assert.equal(isApiPath('/img-proxy'), true);
  assert.equal(isApiPath('/img-proxy/extra'), true);
});

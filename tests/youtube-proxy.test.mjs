// YouTube 出站代理通道（yt_proxy / YT_PROXY）三面接线钉：
// - lib/yt-proxy.js：URL 校验（http/https 收、其余 scheme 拒、凭据随 URL
//   整进隧道 agent）、ytDispatcher 懒建/值变重建/清除销毁、
//   isYoutubeHost 域族判定（后缀点防蹭名）、settings.normalizeOverride 写时验
// - lib/youtube.js：四发 fetch 带 dispatcher 位（player/search/browse/首页）；
//   cookie+proxy 同发同框；代理凭据不落日志不渗请求头；未配逐字节旧行为
// - download-io fetchStream：googlevideo 跳换隧道 agent 对+proxy:false、
//   下掉 guarded 钉扎 agent、跳过本机公网校验；抛错剥 config/request
//   防凭据落日志；非 YT 域与重定向离族跳维持现状
// - routes/proxy.js：googlevideo 目标换共享 ProxyAgent（本机 DNS 闸整跳
//   跳过）且错误路径不 destroy；白名单非 YT 域仍走一次性 guarded Agent
// lib/settings 先取真身再播种（normalizeOverride 用真实现，effectiveValue
// 桩控 yt_proxy/yt_cookie——真键解析会经 repo 开 dev DB）；axios 模块与
// globalThis.fetch 上桩观测接线，不打真网络。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { seed, tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-ytproxy-');
const require = createRequire(import.meta.url);
const { ProxyAgent, Agent } = require('undici');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');

// ── 桩面 ──
let proxyValue = null;             // settings stub 的 yt_proxy 生效值
let cookieValue = '';              // settings stub 的 yt_cookie 生效值
const realSettings = require('../src/server/lib/settings.js');
seed('../src/server/lib/settings.js', {
  ...realSettings,
  effectiveValue: (k) => (k === 'yt_proxy' ? proxyValue
    : k === 'yt_cookie' ? cookieValue : null),
});

// net-guard：normalizeOutboundUrl/isProxyAllowedHost 用真实现（策略面即被测
// 面），本机 DNS 公网判定桩控——在线 DNS 不引入测试面，'blocked'/false 可
// 模拟墙内污染答案
let publicIpOk = true;             // resolvesToPublicIp 桩结果
let checkHostState = 'ok';         // checkHostPublic 桩结果
const checkHostCalls = [];         // checkHostPublic 调用流水（跳闸断言面）
const realGuard = require('../src/server/lib/net-guard.js');
seed('../src/server/lib/net-guard.js', {
  ...realGuard,
  resolvesToPublicIp: async () => publicIpOk,
  checkHostPublic: async (h) => { checkHostCalls.push(h); return checkHostState; },
});

// axios 模块桩：download-io fetchStream 的唯一出口——录 config 观测
// proxy/agent 接线；默认 200 最小流响应
const axiosCalls = [];
let axiosImpl = async () => ({ status: 200, headers: {}, data: { destroy() {} } });
seed('axios', (config) => { axiosCalls.push(config); return axiosImpl(config); });

// fetch 桩：routes/proxy（media 转发）与 lib/youtube（Innertube）共用出口。
// /youtubei/ 按 Innertube 形态回，youtube.com 首页按 ytcfg 形态回，其余走
// 真实 Response（routes/proxy 消费 .ok/.headers/.body）
const fetchCalls = [];             // {url, opts}
const warns = [];                  // console.warn 捕获（凭据不泄漏断言面）
let upstreamHandler = async () => new Response('audio-bytes', {
  status: 200, headers: { 'content-type': 'audio/mp4', 'content-length': '11' },
});
let playerImpl = async () => ({
  ok: true,
  json: async () => ({ playabilityStatus: { status: 'OK' }, streamingData: { adaptiveFormats: [] } })
});
let homepageImpl = async () => ({
  ok: true, text: async () => '<x>"VISITOR_DATA":"vd-stub"</x>'
});
const realFetch = globalThis.fetch;
const realWarn = console.warn;
globalThis.fetch = async (url, opts) => {
  fetchCalls.push({ url: String(url), opts: opts || {} });
  const u = String(url);
  if (u.includes('/youtubei/')) return playerImpl(url, opts);
  if (u === 'https://www.youtube.com' || u === 'https://www.youtube.com/') {
    return homepageImpl(url, opts);
  }
  return upstreamHandler(url, opts);
};
console.warn = (...a) => { warns.push(a.map(String).join(' ')); };
process.on('exit', () => { globalThis.fetch = realFetch; console.warn = realWarn; });

// 桩先于消费者播种完，模块在此取（yt-proxy 的 settings 依赖即上面的 stub）
const ytProxy = require('../src/server/lib/yt-proxy.js');
const yt = require('../src/server/lib/youtube.js');
const io = require('../src/server/services/download-io.js');
const proxyRoute = require('../src/server/routes/proxy.js');

after(() => {
  // 缓存 ProxyAgent 收尾：未建连的 client 无 socket 可收，destroy 是干净语义
  proxyValue = null;
  ytProxy.ytDispatcher();
  rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

const reset = () => {
  fetchCalls.length = 0;
  axiosCalls.length = 0;
  warns.length = 0;
  checkHostCalls.length = 0;
  proxyValue = null;
  cookieValue = '';
  publicIpOk = true;
  checkHostState = 'ok';
  upstreamHandler = async () => new Response('audio-bytes', {
    status: 200, headers: { 'content-type': 'audio/mp4', 'content-length': '11' },
  });
  playerImpl = async () => ({
    ok: true,
    json: async () => ({ playabilityStatus: { status: 'OK' }, streamingData: { adaptiveFormats: [] } })
  });
  homepageImpl = async () => ({
    ok: true, text: async () => '<x>"VISITOR_DATA":"vd-stub"</x>'
  });
  axiosImpl = async () => ({ status: 200, headers: {}, data: { destroy() {} } });
};

const PROXY = 'http://127.0.0.1:7890';
const GV = 'https://rr1---sn-x4a1aa.googlevideo.com/videoplayback?x=1';

// ── lib/yt-proxy.js：URL 校验与域族 ──

test('isYoutubeHost：YouTube 系域族全收，蹭名后缀与外域全拒', () => {
  const { isYoutubeHost } = ytProxy;
  for (const h of ['youtube.com', 'www.youtube.com', 'music.youtube.com',
    'googlevideo.com', 'rr1---sn-x.googlevideo.com', 'youtubei.googleapis.com',
    'i.ytimg.com', 'yt3.ggpht.com']) {
    assert.equal(isYoutubeHost(h), true, h);
  }
  for (const h of ['xgooglevideo.com', 'googlevideo.com.evil.example',
    'music.126.net', 'a.kuwo.cn', 'example.com', '']) {
    assert.equal(isYoutubeHost(h), false, h);
  }
});

test('youtubeProxy：http/https 收，其余 scheme/垃圾串拒且按值 warn 一次', () => {
  reset();
  proxyValue = ' http://127.0.0.1:7890 ';
  assert.equal(ytProxy.youtubeProxy().hostname, '127.0.0.1');       // trim 生效
  proxyValue = 'https://proxy.example.com:8443';
  assert.equal(ytProxy.youtubeProxy().protocol, 'https:');
  // socks5 不收——axios proxy 无此形态（三面口径见 yt-proxy 头注）
  for (const bad of ['socks5://127.0.0.1:1080', 'ftp://x/y',
    'file:///etc/passwd', 'not-a-url', 'http://',
    'http://u%zz@127.0.0.1:1']) {  // 裸 % 过 parser 但拆凭据即炸——按非法值拒
    proxyValue = bad;
    warns.length = 0;
    assert.equal(ytProxy.youtubeProxy(), null, bad);
    assert.equal(warns.length, 1, bad);
    assert.ok(!warns[0].includes(bad));                             // 值不落日志
  }
  // 同一坏值不重复刷 warn
  warns.length = 0;
  ytProxy.youtubeProxy();
  ytProxy.youtubeProxy();
  assert.equal(warns.length, 0);
  // 新坏值重新告警
  proxyValue = 'gopher://fresh-bad';
  ytProxy.youtubeProxy();
  assert.equal(warns.length, 1);
});

test('youtubeProxy：带 userinfo 的 URL 合法通过，凭据不进 warn', () => {
  reset();
  proxyValue = 'http://u%40corp:p%3Ass@127.0.0.1:7890';
  const u = ytProxy.youtubeProxy();
  assert.equal(u.hostname, '127.0.0.1');
  assert.ok(!warns.some((w) => w.includes('p%3Ass') || w.includes('p:ss')));
  // 内嵌非 ASCII 的粘贴串：剔除后可用 + warn 一次（尾部 \n 会被 trim 先行吃掉，
  // 须内嵌才能过消毒分支）
  proxyValue = 'http://127.0.0.1中:7890';
  warns.length = 0;
  assert.equal(ytProxy.youtubeProxy().port, '7890');
  assert.equal(warns.length, 1);
  assert.ok(!warns[0].includes('7890'));
  // 剔除后仍畸形 → 未配置
  proxyValue = 'not-url-中';
  warns.length = 0;
  assert.equal(ytProxy.youtubeProxy(), null);
  assert.equal(warns.length, 1);
});

test('ytAxiosProxyFor：YT 域命中回隧道 agent 对+proxy:false，域外/未配 null', () => {
  reset();
  assert.equal(ytProxy.ytAxiosProxyFor('rr1---sn-x.googlevideo.com'), null);
  proxyValue = 'http://u%40corp:p%3Ass@127.0.0.1:7890';
  assert.equal(ytProxy.ytAxiosProxyFor('music.126.net'), null);      // 非 YT 域短路
  const p = ytProxy.ytAxiosProxyFor('rr1---sn-x.googlevideo.com');
  assert.ok(p.httpAgent instanceof HttpProxyAgent);
  assert.ok(p.httpsAgent instanceof HttpsProxyAgent);
  assert.equal(p.proxy, false);                                      // 挡 env 代理叠加
  // 凭据随整 URL 进 agent（percent 形态缓在 proxy.href），CONNECT 期
  // agent 自行 decodeURIComponent 拼 Basic——与 undici ProxyAgent 同口径
  assert.equal(p.httpsAgent.proxy.username, 'u%40corp');
  assert.equal(p.httpsAgent.proxy.password, 'p%3Ass');
  assert.equal(p.httpsAgent.proxy.host, '127.0.0.1:7890');
  assert.equal(p.keepAlive, undefined);                              // 返回面只有三个键
  assert.equal(p.httpsAgent.keepAlive, false);                       // 长流不留池
  // 每跳新建不复用（不共享 socket 池）
  assert.notEqual(ytProxy.ytAxiosProxyFor('rr1---sn-x.googlevideo.com').httpsAgent, p.httpsAgent);
  proxyValue = 'https://proxy.example.com';
  const p2 = ytProxy.ytAxiosProxyFor('www.youtube.com');
  assert.equal(p2.httpsAgent.proxy.protocol, 'https:');              // 代理 scheme 如实留
  assert.equal(p2.httpsAgent.connectOpts.port, 443);                 // 缺省端口 agent 内补全
  assert.equal(p2.httpsAgent.proxy.username, '');
});

test('ytDispatcher：懒建缓存、同值同实例、值变重建销毁旧池、清除归 null', () => {
  reset();
  assert.equal(ytProxy.ytDispatcher(), null);
  proxyValue = PROXY;
  const d1 = ytProxy.ytDispatcher();
  assert.ok(d1 instanceof ProxyAgent);
  assert.equal(ytProxy.ytDispatcher(), d1);                          // 懒建缓存
  proxyValue = 'http://127.0.0.1:8080';
  const d2 = ytProxy.ytDispatcher();
  assert.ok(d2 instanceof ProxyAgent && d2 !== d1);                  // 值变重建
  assert.equal(d1.destroyed, true);                                  // 旧池销毁
  // （destroyed 是 undici 公开 getter——不 wrap destroy：实例级覆写会让
  // dispatcher-base 内部 this.destroy(err,cb) 递归进包装器爆栈）
  proxyValue = null;
  assert.equal(ytProxy.ytDispatcher(), null);                        // 清除归 null
});

test('describeSettings：yt_proxy 尾标剥 userinfo——凭据尾不落 hint', () => {
  // 短 host 下原值尾 4 会带上密码尾（'…pw@h'），尾标只能出自剥凭据后的段
  process.env.YT_PROXY = 'http://user:topsecretpw@proxy.internal:8080';
  try {
    const d = realSettings.describeSettings().yt_proxy;
    assert.equal(d.set, true);
    assert.equal(d.source, 'env');
    assert.ok(!('value' in d));
    assert.ok(!JSON.stringify(d).includes('topsecretpw'));
    assert.equal(d.hint, '••••080/');   // 出自 http://proxy.internal:8080/ 尾段
  } finally {
    delete process.env.YT_PROXY;
  }
});

test('settings.normalizeOverride：yt_proxy 写时验——http(s) 收、其余 400', () => {
  const n = (v) => realSettings.normalizeOverride('yt_proxy', v);
  assert.equal(n('http://127.0.0.1:7890').ok, true);
  assert.equal(n('http://u:p@proxy.internal:3128').ok, true);        // userinfo 合法
  assert.equal(n('https://proxy.example.com').ok, true);
  assert.ok(n('socks5://127.0.0.1:1080').error);                     // 写面即拒
  assert.ok(n('javascript:alert(1)').error);
  assert.ok(n('not-a-url').error);
  assert.ok(n('http://u%zz@h:1').error);                             // 裸 % 凭据写时拒
  assert.ok(n('http://x\u4e2d.com').error);                          // 非 ASCII 先被 secretAscii 挡
  assert.ok(n('http://h:0').error);                                  // ':0' 不可拨——写时拒
  assert.ok(n('http://h:00/').error);                                // parser 归一后仍是 0
  assert.equal(n('http://h:65535').ok, true);
  assert.ok(n('http://h:65536').error);                              // 超界 parser 自拒
});

// ── lib/youtube.js：fetch 四面接线 ──

test('lib/youtube：代理在位 player/search/browse/首页 fetch 全带同一 dispatcher', async () => {
  reset();
  proxyValue = PROXY;
  // player
  await yt.fetchPlayer('vidproxy001', null);
  const playerCall = fetchCalls.find((c) => c.url.includes('/v1/player'));
  assert.ok(playerCall.opts.dispatcher instanceof ProxyAgent);
  // search
  playerImpl = async () => ({
    ok: true,
    json: async () => ({ contents: { videoRenderer: {
      videoId: 'vidsearch0x', title: { simpleText: 'T' },
      lengthText: { simpleText: '1:23' } } } })
  });
  await yt.innertubeSearch('kw', null, 5);
  const searchCall = fetchCalls.find((c) => c.url.includes('/v1/search'));
  assert.equal(searchCall.opts.dispatcher, playerCall.opts.dispatcher); // 共享同池
  // browse
  playerImpl = async () => ({
    ok: true,
    json: async () => ({
      header: { playlistHeaderRenderer: { title: { simpleText: 'pl' } } },
      contents: { playlistVideoRenderer: {
        videoId: 'vidbrowse0x', title: { simpleText: 'I' } } },
    })
  });
  await yt.fetchYtPlaylistPage({ listId: 'PLproxytest001', extraSignal: null });
  const browseCall = fetchCalls.find((c) => c.url.includes('/v1/browse'));
  assert.equal(browseCall.opts.dispatcher, playerCall.opts.dispatcher);
  // 首页（VISIONOS 升级路 getVisitorData 出口）
  playerImpl = async () => ({
    ok: true,
    json: async () => ({ playabilityStatus: { status: 'OK' }, streamingData: {} })
  });
  await yt.fetchPlayerWith('vidproxy002', null, 'VISIONOS');
  const homeCall = fetchCalls.find((c) => c.url === 'https://www.youtube.com');
  assert.equal(homeCall.opts.dispatcher, playerCall.opts.dispatcher);
});

test('lib/youtube：代理未配——四发 fetch 无 dispatcher 键（逐字节旧行为）', async () => {
  reset();
  await yt.fetchPlayer('vidproxy003', null);
  const call = fetchCalls.find((c) => c.url.includes('/v1/player'));
  assert.ok(!('dispatcher' in call.opts));
});

test('lib/youtube：cookie+proxy 同发——WEB_AUTH 凭据头与 dispatcher 同框且不互斥', async () => {
  reset();
  cookieValue = 'SAPISID=proxy-sid; SID=s';
  proxyValue = 'http://u%40corp:p%3Ass@127.0.0.1:7890';
  await yt.fetchPlayer('vidproxy004', null);
  const call = fetchCalls.find((c) => c.url.includes('/v1/player'));
  const h = call.opts.headers;
  assert.equal(h['X-YouTube-Client-Name'], '1');                    // WEB_AUTH 档
  assert.equal(h.Cookie, cookieValue);
  assert.match(h.Authorization, /^SAPISIDHASH \d+_[0-9a-f]{40}$/);
  assert.ok(call.opts.dispatcher instanceof ProxyAgent);            // 传输层同帧
  // 代理凭据不渗请求头也不落日志
  assert.ok(!JSON.stringify(h).includes('p@ss'));
  assert.ok(!JSON.stringify(h).includes('p%3Ass'));
  assert.ok(!warns.some((w) => w.includes('p@ss') || w.includes('p%3Ass')));
});

// ── download-io fetchStream：axios 接线 ──

test('fetchStream：googlevideo 跳换隧道 agent 对+proxy:false、跳过本机公网校验', async () => {
  reset();
  proxyValue = PROXY;
  checkHostState = 'blocked';                  // 本机 DNS 污染语义——不得挡代理跳
  const resp = await io.fetchStream(GV, { timeout: 5000 });
  assert.equal(resp.status, 200);
  assert.equal(axiosCalls.length, 1);
  const cfg = axiosCalls[0];
  assert.equal(cfg.proxy, false);                                   // 显式挡 env 代理叠加
  assert.ok(cfg.httpsAgent instanceof HttpsProxyAgent);             // 隧道顶替钉扎位
  assert.ok(cfg.httpAgent instanceof HttpProxyAgent);
  assert.equal(cfg.httpsAgent.proxy.href, 'http://127.0.0.1:7890/');
  assert.equal(checkHostCalls.length, 0);                           // 本机校验整跳跳过
});

test('fetchStream：代理在位但非 YT 域维持现状——guarded agent 在位、无 proxy 键', async () => {
  reset();
  proxyValue = PROXY;
  await io.fetchStream('https://m701.music.126.net/a.mp3', { timeout: 5000 });
  const cfg = axiosCalls[0];
  assert.ok(!('proxy' in cfg));
  assert.ok(cfg.httpAgent && cfg.httpsAgent);
  assert.ok(!(cfg.httpsAgent instanceof HttpsProxyAgent));          // 钉扎 agent 非隧道
  assert.deepEqual(checkHostCalls, ['m701.music.126.net']);         // 本机校验照常
});

test('fetchStream：代理未配时 googlevideo 维持现状（逐字节旧行为）', async () => {
  reset();
  await io.fetchStream(GV, { timeout: 5000 });
  const cfg = axiosCalls[0];
  assert.ok(!('proxy' in cfg));
  assert.ok(cfg.httpAgent && cfg.httpsAgent);
  assert.equal(checkHostCalls.length, 1);
});

test('fetchStream：YT→非 YT 重定向跳——首跳走代理，离族跳回落直连守卫', async () => {
  reset();
  proxyValue = PROXY;
  axiosImpl = async (config) => (config.url.includes('googlevideo')
    ? { status: 302, headers: { location: 'https://m701.music.126.net/x.mp3' }, data: { destroy() {} } }
    : { status: 200, headers: {}, data: { destroy() {} } });
  const resp = await io.fetchStream(GV, { timeout: 5000 });
  assert.equal(resp.status, 200);
  assert.equal(axiosCalls.length, 2);
  assert.equal(axiosCalls[0].proxy, false);                         // 首跳隧道
  assert.ok(axiosCalls[0].httpsAgent instanceof HttpsProxyAgent);
  assert.ok(!('proxy' in axiosCalls[1]) && axiosCalls[1].httpAgent // 离族跳直连守卫
    && !(axiosCalls[1].httpsAgent instanceof HttpsProxyAgent));
  assert.deepEqual(checkHostCalls, ['m701.music.126.net']);
});

test('fetchStream：抛出的错误剥 config/request——隧道 agent 凭据不落失败日志对象', async () => {
  reset();
  proxyValue = 'http://u%40corp:p%3Ass@127.0.0.1:7890';
  // 模拟 axios 失败对象：config.request/response.* 上回挂带凭据的隧道 agent
  const agent = new HttpsProxyAgent('http://u%40corp:p%3Ass@127.0.0.1:7890');
  const boom = new Error('connect ECONNREFUSED 127.0.0.1:7890');
  boom.config = { httpsAgent: agent };
  boom.request = { agent };
  boom.response = { status: 500, config: boom.config, request: boom.request,
    data: { destroy() {} } };
  axiosImpl = async () => { throw boom; };
  try {
    await io.fetchStream(GV, { timeout: 5000 });
    assert.fail('应抛错');
  } catch (e) {
    assert.equal(e, boom);                                          // 原对象穿透
    assert.equal(e.message, 'connect ECONNREFUSED 127.0.0.1:7890');  // message 链不动
    assert.equal(e.response.status, 500);                           // response 壳保留
    assert.ok(!('config' in e) && !('request' in e));
    assert.ok(!('config' in e.response) && !('request' in e.response));
    assert.ok(!JSON.stringify(e).includes('p%3Ass'));               // 序列化面无凭据
  }
});

// ── routes/proxy.js：转发面接线 ──

test('/audio-proxy：googlevideo 目标换共享 ProxyAgent，本机 DNS 闸整跳跳过', async () => {
  reset();
  proxyValue = PROXY;
  publicIpOk = false;                        // 本机解析被污染语义——不得挡代理跳
  const res = await proxyRoute.request(
    `http://t/audio-proxy?url=${encodeURIComponent(GV)}`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'audio-bytes');
  const call = fetchCalls.find((c) => c.url.includes('googlevideo'));
  assert.ok(call.opts.dispatcher instanceof ProxyAgent);
});

test('/audio-proxy：非 YT 白名单域仍走一次性 guarded Agent 且过本机公网闸', async () => {
  reset();
  proxyValue = PROXY;
  publicIpOk = false;
  const r1 = await proxyRoute.request(
    `http://t/audio-proxy?url=${encodeURIComponent('https://a.kuwo.cn/x.mp3')}`);
  assert.equal(r1.status, 403);                                   // 非 YT 域照常拦截
  await r1.arrayBuffer();
  assert.equal(fetchCalls.length, 0);                             // 拦截在 fetch 前
  publicIpOk = true;
  const r2 = await proxyRoute.request(
    `http://t/audio-proxy?url=${encodeURIComponent('https://a.kuwo.cn/x.mp3')}`);
  assert.equal(r2.status, 200);
  await r2.text();
  const call = fetchCalls.find((c) => c.url.includes('kuwo'));
  assert.ok(call.opts.dispatcher instanceof Agent);
  assert.ok(!(call.opts.dispatcher instanceof ProxyAgent));       // 非共享代理池
});

test('/audio-proxy：代理未配——googlevideo 维持 guarded Agent（逐字节旧行为）', async () => {
  reset();
  const res = await proxyRoute.request(
    `http://t/audio-proxy?url=${encodeURIComponent(GV)}`);
  assert.equal(res.status, 200);
  await res.text();
  const call = fetchCalls.find((c) => c.url.includes('googlevideo'));
  assert.ok(call.opts.dispatcher instanceof Agent);
  assert.ok(!(call.opts.dispatcher instanceof ProxyAgent));
});

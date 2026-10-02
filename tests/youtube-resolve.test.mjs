// services/youtube-resolve.js 行为钉：SABR 闸控探测三态分类、gateCache
// TTL/LRU/容量淘汰、VISIONOS 升级与回落排序、progressive 跨批结转、
// 白名单/去重/探测目标选取。桩打在两个接缝上：
// - lib/youtube 的 fetchPlayer/fetchPlayerWith（Innertube 出口）
// - download-io 的 fetchStream（探测唯一出口，upstreamStatus 按其真实契约挂）
// pickStreamList 与 net-guard 用真实现——探测目标过滤/白名单语义不失真。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { seed } from './helpers.mjs';

const require = createRequire(import.meta.url);

const realYt = require('../src/server/lib/youtube.js');
let fetchPlayerImpl = async () => ({ streamingData: {} });
let fetchPlayerWithImpl = async () => ({ streamingData: {} });
let fetchPlayerWithCalls = [];
let fetchStreamImpl = async () => ({ data: { destroy() {} } });
let fetchStreamCalls = [];

seed('../src/server/lib/youtube.js', {
  fetchPlayer: (...a) => fetchPlayerImpl(...a),
  fetchPlayerWith: (...a) => { fetchPlayerWithCalls.push(a); return fetchPlayerWithImpl(...a); },
  pickStreamList: realYt.pickStreamList,
  innertubeSearch: realYt.innertubeSearch,
});
seed('../src/server/services/download-io.js', {
  fetchStream: (...a) => { fetchStreamCalls.push(a); return fetchStreamImpl(...a); },
});

// gateCache 是模块级状态——每用例重载拿干净判定（桩经 require.cache 仍生效）
const freshResolve = () => {
  const p = require.resolve('../src/server/services/youtube-resolve.js');
  delete require.cache[p];
  return require('../src/server/services/youtube-resolve.js').resolveYoutubeStreams;
};

// googlevideo 在 isProxyAllowedHost 白名单内；非白名单域用 example.invalid
const GV = (tag) => `https://rr1---sn-${tag}.googlevideo.com/videoplayback?x=1`;
const audioF = (tag, { len = '5000000', br = 130000 } = {}) => ({
  url: GV(`a-${tag}`), mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: br, contentLength: len
});
const videoF = (tag, { len = '8000000', h = 720 } = {}) => ({
  url: GV(`v-${tag}`), mimeType: 'video/mp4; codecs="avc1.42e01e"', bitrate: 900000,
  contentLength: len, height: h, width: 1280
});
const progF = (tag, h = 360) => ({
  url: GV(`p-${tag}`), mimeType: 'video/mp4; codecs="avc1.42e01e,mp4a.40.2"',
  bitrate: 500000, height: h, width: 640
});
const sd = ({ ad = [], fm = [] } = {}) => ({ adaptiveFormats: ad, formats: fm });

const errStatus = (n) => Object.assign(new Error(`upstream ${n}`), { upstreamStatus: n });
const reset = () => {
  fetchPlayerImpl = async () => ({ streamingData: {} });
  fetchPlayerWithImpl = async () => ({ streamingData: {} });
  fetchPlayerWithCalls = [];
  fetchStreamImpl = async () => ({ data: { destroy() {} } });
  fetchStreamCalls = [];
};

test('探测 2xx → gated=false：自适应直解，合流拼尾，VISIONOS 不触发', async () => {
  reset();
  const resolve = freshResolve();
  fetchPlayerImpl = async () => ({ streamingData: sd({ ad: [audioF('x')], fm: [progF('x')] }) });
  const r = await resolve('vid00000001', { kind: 'audio' });
  assert.equal(r.gated, false);
  assert.deepEqual(r.streams.map(s => s.url), [GV('a-x'), GV('p-x')]);
  assert.equal(fetchPlayerWithCalls.length, 0);
  assert.equal(fetchStreamCalls.length, 1);                    // 探测一发
  // 探测目标 = 同 kind 最大 contentLength 的自适应流；窗位 2MiB 处
  assert.equal(fetchStreamCalls[0][0], GV('a-x'));
  assert.equal(fetchStreamCalls[0][1].headers.Range, 'bytes=2097152-2098175');
});

test('探测 403 → gated=true：VISIONOS 重解，候选整批换新签名', async () => {
  reset();
  const resolve = freshResolve();
  fetchPlayerImpl = async () => ({ streamingData: sd({ ad: [audioF('old')], fm: [progF('old')] }) });
  fetchStreamImpl = async () => { throw errStatus(403); };
  fetchPlayerWithImpl = async () => ({
    streamingData: sd({ ad: [audioF('new')], fm: [progF('new')] })
  });
  const r = await resolve('vid00000002', { kind: 'audio' });
  assert.equal(r.gated, true);
  assert.deepEqual(fetchPlayerWithCalls.map(c => c[2]), ['VISIONOS']);
  // VISIONOS 批自适应提首（不受闸的新签名），其合流档随批拼尾
  assert.deepEqual(r.streams.map(s => s.url), [GV('a-new'), GV('p-new')]);
});

test('探测 403 + VISIONOS 失败 → deadAdaptive：已证死链押尾，合流提首', async () => {
  reset();
  const resolve = freshResolve();
  fetchPlayerImpl = async () => ({ streamingData: sd({ ad: [audioF('old')], fm: [progF('old')] }) });
  fetchStreamImpl = async () => { throw errStatus(403); };
  fetchPlayerWithImpl = async () => { throw new Error('VISIONOS 拒'); };
  const r = await resolve('vid00000003', { kind: 'audio' });
  assert.equal(r.gated, true);
  // 核心回归点：单 URL 消费方取 streams[0] 必须是活链而非已证 403 的自适应
  assert.equal(r.streams[0].url, GV('p-old'));
  assert.deepEqual(r.streams.map(s => s.url), [GV('p-old'), GV('a-old')]);
});

test('VISIONOS 批不回 formats → progressive 跨批结转原批兜底', async () => {
  reset();
  const resolve = freshResolve();
  fetchPlayerImpl = async () => ({ streamingData: sd({ ad: [audioF('old')], fm: [progF('old')] }) });
  fetchStreamImpl = async () => { throw errStatus(403); };
  fetchPlayerWithImpl = async () => ({ streamingData: sd({ ad: [audioF('new')], fm: [] }) });
  const r = await resolve('vid00000004', { kind: 'audio' });
  assert.deepEqual(r.streams.map(s => s.url), [GV('a-new'), GV('p-old')]);
});

test('探测无定论（超时/5xx/网络错）→ gated=null 且不写缓存，次次重探', async () => {
  reset();
  const resolve = freshResolve();
  fetchPlayerImpl = async () => ({ streamingData: sd({ ad: [audioF('x')] }) });
  fetchStreamImpl = async () => { throw new Error('socket hangup'); };   // 无 upstreamStatus
  const r1 = await resolve('vid00000005', { kind: 'audio' });
  assert.equal(r1.gated, null);
  assert.equal(fetchStreamCalls.length, 1);
  // 无定论结果不缓存——第二次同 videoId 必须真探而非吃 30min 旧判定
  const r2 = await resolve('vid00000005', { kind: 'audio' });
  assert.equal(r2.gated, null);
  assert.equal(fetchStreamCalls.length, 2);
});

test('416 → gated=false：探针越过 EOF 恰证 Range 通道畅通，且判定入缓存', async () => {
  reset();
  const resolve = freshResolve();
  fetchPlayerImpl = async () => ({ streamingData: sd({ ad: [audioF('x')] }) });
  fetchStreamImpl = async () => { throw errStatus(416); };
  const r = await resolve('vid00000006', { kind: 'audio' });
  assert.equal(r.gated, false);
  await resolve('vid00000006', { kind: 'audio' });
  assert.equal(fetchStreamCalls.length, 1);   // false 是确定性判定——同样缓存 30min
});

test('判定缓存命中免重探；TTL 过期重探', async () => {
  reset();
  const resolve = freshResolve();
  fetchPlayerImpl = async () => ({ streamingData: sd({ ad: [audioF('x')] }) });
  fetchStreamImpl = async () => { throw errStatus(403); };
  fetchPlayerWithImpl = async () => ({ streamingData: sd({ ad: [audioF('v')] }) });
  await resolve('vid00000007', { kind: 'audio' });
  await resolve('vid00000007', { kind: 'audio' });
  assert.equal(fetchStreamCalls.length, 1);          // 缓存命中——探测只打一发
  // 拨快 31min 越过 GATE_TTL_MS——下次 resolve 重新探测
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 31 * 60e3;
    await resolve('vid00000007', { kind: 'audio' });
    assert.equal(fetchStreamCalls.length, 2);
  } finally { Date.now = realNow; }
});

test('abort 穿透不写缓存：调用方断连的探测结果不得落 30min 判定', async () => {
  reset();
  const resolve = freshResolve();
  fetchPlayerImpl = async () => ({ streamingData: sd({ ad: [audioF('x')] }) });
  fetchStreamImpl = async (url, opts) => {
    if (opts?.signal?.aborted) { const e = new Error('canceled'); e.aborted = true; throw e; }
    return { data: { destroy() {} } };
  };
  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(() => resolve('vid00000008', { kind: 'audio', signal: ctl.signal }));
  // 未写入缓存——干净 signal 重resolve真探测（否则断连污染成"未闸"30min）
  const r = await resolve('vid00000008', { kind: 'audio' });
  assert.equal(r.gated, false);
  assert.equal(fetchStreamCalls.length, 2);
});

test('gateCache LRU：命中刷新排序，满容淘汰真最旧而非最近活跃项', async () => {
  reset();
  const resolve = freshResolve();
  fetchPlayerImpl = async () => ({ streamingData: sd({ ad: [audioF('x')] }) });
  fetchStreamImpl = async () => { throw errStatus(403); };
  fetchPlayerWithImpl = async () => ({ streamingData: sd({ ad: [audioF('v')] }) });
  const vid = (i) => `vid${String(i).padStart(8, '0')}`;
  // 填满 512 容量——v0 最早插入
  for (let i = 0; i < 512; i++) await resolve(vid(i), { kind: 'audio' });
  const probesAtFill = fetchStreamCalls.length;
  // v0 命中 + LRU touch 挪尾；此时插入序最旧的是 v1
  await resolve(vid(0), { kind: 'audio' });
  assert.equal(fetchStreamCalls.length, probesAtFill);        // 命中免探
  // 新增 v512 → 淘汰最旧 = v1（v0 已 touch 到尾）；v0/v512 入缓存
  await resolve(vid(512), { kind: 'audio' });
  assert.equal(fetchStreamCalls.length, probesAtFill + 1);
  // v0 仍命中（未被误淘）；v1 被淘 → 重探
  await resolve(vid(0), { kind: 'audio' });
  await resolve(vid(1), { kind: 'audio' });
  assert.equal(fetchStreamCalls.length, probesAtFill + 2);    // v0 未增探测，v1 +1
});

test('探测目标限同 kind 最大档：video/audio 各自过滤 + contentLength 最大', async () => {
  reset();
  const resolve = freshResolve();
  // 混合批次：audio 小档 + audio 大档 + video 大档——kind=audio 必须探最大 audio
  fetchPlayerImpl = async () => ({
    streamingData: sd({
      ad: [audioF('small', { len: '900000' }), audioF('big', { len: '9000000' }), videoF('v', { len: '99999999' })],
    })
  });
  await resolve('vid00000009', { kind: 'audio' });
  assert.equal(fetchStreamCalls.at(-1)[0], GV('a-big'));       // 不探 video 档
  fetchStreamCalls = [];
  await resolve('vid00000009', { kind: 'audio' });             // 复用缓存无新探测
  assert.equal(fetchStreamCalls.length, 0);
  // kind=video 探最大 video 档（缓存键按 videoId 共享——闸控是视频级签名策略）
  await resolve('vid00000010', { kind: 'video' });
  assert.equal(fetchStreamCalls.at(-1)[0], GV('v-v'));         // video kind 只探 video/ 流
});

test('白名单外 url 不进候选链也不当探测目标', async () => {
  reset();
  const resolve = freshResolve();
  fetchPlayerImpl = async () => ({
    streamingData: sd({
      ad: [{ url: 'https://evil.example.invalid/a', mimeType: 'audio/mp4', bitrate: 1, contentLength: '9999999' }, audioF('ok')],
      fm: [progF('ok')]
    })
  });
  const r = await resolve('vid00000011', { kind: 'audio' });
  assert.equal(fetchStreamCalls.at(-1)[0], GV('a-ok'));        // 探测目标跳过非白名单
  assert.deepEqual(r.streams.map(s => s.url), [GV('a-ok'), GV('p-ok')]);
});

test('progressive 档 br 恒 null——容器总码率不得冒充音轨码率进下游对账', async () => {
  reset();
  const resolve = freshResolve();
  fetchPlayerImpl = async () => ({ streamingData: sd({ fm: [progF('x')] }) });  // 无自适应
  const r = await resolve('vid00000012', { kind: 'audio' });
  assert.equal(r.streams.length, 1);
  assert.equal(r.streams[0].br, null);
  assert.equal(r.gated, null);                                 // 无探测目标 → 无定论
});

test('候选去重保序：同 url 跨批只出现一次', async () => {
  reset();
  const resolve = freshResolve();
  const dup = audioF('x');
  fetchPlayerImpl = async () => ({ streamingData: sd({ ad: [dup, { ...dup }], fm: [progF('x')] }) });
  fetchStreamImpl = async () => ({ data: { destroy() {} } });
  const r = await resolve('vid00000013', { kind: 'audio' });
  assert.deepEqual(r.streams.map(s => s.url), [GV('a-x'), GV('p-x')]);
});

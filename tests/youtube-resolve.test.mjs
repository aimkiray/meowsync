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

// errStatus 对齐真 fetchStream 的 4xx 错误形态：upstreamStatus+fatal 双挂
//（download-io.js 对非 429 的 4xx 两者都挂；5xx/超时则都不挂——无定论路径
// 的桩用裸 Error 而非 errStatus(5xx)，后者形状失真）
const errStatus = (n) => Object.assign(new Error(`upstream ${n}`), { upstreamStatus: n, fatal: true });
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
  // 探测两发：与客户端首请求同形的无界 bytes=0-，通了再补 ~90% 深处
  // 无界探针（= 客户端 seek 真实形态）抓「头放行深位拒」
  assert.equal(fetchStreamCalls.length, 2);
  assert.equal(fetchStreamCalls[0][0], GV('a-x'));             // 探测目标 = 下发首链
  assert.equal(fetchStreamCalls[0][1].headers.Range, 'bytes=0-');
  assert.equal(fetchStreamCalls[1][0], GV('a-x'));
  assert.equal(fetchStreamCalls[1][1].headers.Range, 'bytes=4500000-');  // 5MB×0.9
});

test('探测 403 → gated=true：VISIONOS 重解并复验，候选整批换新签名', async () => {
  reset();
  const resolve = freshResolve();
  fetchPlayerImpl = async () => ({ streamingData: sd({ ad: [audioF('old')], fm: [progF('old')] }) });
  // 原批闸控、VISIONOS 新批畅通（新签名批的闸态与原批无继承关系）
  fetchStreamImpl = async (url) => {
    if (url.includes('-old')) throw errStatus(403);
    return { data: { destroy() {} } };
  };
  fetchPlayerWithImpl = async () => ({
    streamingData: sd({ ad: [audioF('new')], fm: [progF('new')] })
  });
  const r = await resolve('vid00000002', { kind: 'audio' });
  assert.equal(r.gated, true);
  assert.deepEqual(fetchPlayerWithCalls.map(c => c[2]), ['VISIONOS']);
  // VISIONOS 批自适应提首（不受闸的新签名），其合流档随批拼尾
  assert.deepEqual(r.streams.map(s => s.url), [GV('a-new'), GV('p-new')]);
  // 三发：原批首探 403 一发即走 + 新批复验头/深两发
  assert.equal(fetchStreamCalls.length, 3);
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

test('VISIONOS 批复验亦 403 → deadAdaptive：新批合流提首，死批押尾', async () => {
  reset();
  const resolve = freshResolve();
  fetchPlayerImpl = async () => ({ streamingData: sd({ ad: [audioF('old')], fm: [progF('old')] }) });
  fetchStreamImpl = async () => { throw errStatus(403); };     // 两批皆闸
  fetchPlayerWithImpl = async () => ({
    streamingData: sd({ ad: [audioF('new')], fm: [progF('new')] })
  });
  const r = await resolve('vid00000004a', { kind: 'audio' });
  // 新批复验坐实死批——streams[0] 须是新批合流而非已证 403 的新批自适应
  assert.equal(r.streams[0].url, GV('p-new'));
  assert.deepEqual(r.streams.map(s => s.url), [GV('p-new'), GV('a-new')]);
  assert.equal(fetchStreamCalls.length, 2);                    // 首探+复验各一发 403
});

test('VISIONOS 批不回 formats → progressive 跨批结转原批兜底', async () => {
  reset();
  const resolve = freshResolve();
  fetchPlayerImpl = async () => ({ streamingData: sd({ ad: [audioF('old')], fm: [progF('old')] }) });
  fetchStreamImpl = async (url) => {
    if (url.includes('-old')) throw errStatus(403);
    return { data: { destroy() {} } };
  };
  fetchPlayerWithImpl = async () => ({ streamingData: sd({ ad: [audioF('new')], fm: [] }) });
  const r = await resolve('vid00000004', { kind: 'audio' });
  assert.deepEqual(r.streams.map(s => s.url), [GV('a-new'), GV('p-old')]);
});

test('头通深拒的窗口闸：bytes=0- 放行 + 深位 403 同样判闸', async () => {
  reset();
  const resolve = freshResolve();
  fetchPlayerImpl = async () => ({ streamingData: sd({ ad: [audioF('old')], fm: [progF('old')] }) });
  // 首探放行、深探拒——SABR 放行窗的另一形态（2MiB 有界旧指纹必假阴）
  fetchStreamImpl = async (url, opts) => {
    if (opts?.headers?.Range === 'bytes=0-' && !url.includes('-new')) {
      return { data: { destroy() {} } };
    }
    throw errStatus(403);
  };
  fetchPlayerWithImpl = async () => ({ streamingData: sd({ ad: [audioF('new')] }) });
  const r = await resolve('vid00000004b', { kind: 'audio' });
  assert.equal(r.gated, true);
  assert.equal(fetchPlayerWithCalls.length, 1);
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
  assert.equal(fetchStreamCalls.length, 2);   // 头/深两探；false 确定性判定同样缓存 30min
});

test('判定缓存命中免重探；TTL 过期重探', async () => {
  reset();
  const resolve = freshResolve();
  fetchPlayerImpl = async () => ({ streamingData: sd({ ad: [audioF('x')] }) });
  fetchStreamImpl = async () => { throw errStatus(403); };
  fetchPlayerWithImpl = async () => ({ streamingData: sd({ ad: [audioF('v')] }) });
  const r1 = await resolve('vid00000007', { kind: 'audio' });
  assert.equal(r1.streams[0].url, GV('a-v'));
  // r1 = 首探 403 + VISIONOS 复验 403 两发（新批每次重解必验——新签名批
  // 的闸态与原批无继承关系，缓存命中只免原批探测）
  assert.equal(fetchStreamCalls.length, 2);
  const r2 = await resolve('vid00000007', { kind: 'audio' });
  assert.equal(fetchStreamCalls.length, 3);          // 命中免首探，复验照打
  // 命中的是"已闸"判定而非直接返原批：VISIONOS 升级链必须照样走
  assert.equal(fetchPlayerWithCalls.length, 2);
  assert.equal(r2.streams[0].url, GV('a-v'));
  // 拨快 31min 越过 GATE_TTL_MS——下次 resolve 重新探测
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 31 * 60e3;
    await resolve('vid00000007', { kind: 'audio' });
    assert.equal(fetchStreamCalls.length, 5);        // 重探+复验
  } finally { Date.now = realNow; }
});

test('skipCache 旁路判定缓存读：重试路径强制重探，新判定照常回写', async () => {
  reset();
  const resolve = freshResolve();
  fetchPlayerImpl = async () => ({ streamingData: sd({ ad: [audioF('x')] }) });
  await resolve('vid00000007a', { kind: 'audio' });
  assert.equal(fetchStreamCalls.length, 2);                    // 头+深探写缓存
  await resolve('vid00000007a', { kind: 'audio' });
  assert.equal(fetchStreamCalls.length, 2);                    // 命中免探
  // ?retry=1 的服务端落点——判定缓存可能误判，重试必须真探而非吃旧判定
  await resolve('vid00000007a', { kind: 'audio', skipCache: true });
  assert.equal(fetchStreamCalls.length, 4);
  await resolve('vid00000007a', { kind: 'audio' });
  assert.equal(fetchStreamCalls.length, 4);                    // 新判定回写后照常命中
});

test('abort 的调用方不污染共享探测——诚实完成的判定照常写缓存', async () => {
  reset();
  const resolve = freshResolve();
  fetchPlayerImpl = async () => ({ streamingData: sd({ ad: [audioF('x')] }) });
  const ctl = new AbortController();
  ctl.abort();
  // 共享探测不带调用方 signal：断连方自查 signal 抛错，但探测本身诚实
  // 跑完——不再被 abort 吞成无定论，写完的判定可被后来者直接复用
  await assert.rejects(() => resolve('vid00000008', { kind: 'audio', signal: ctl.signal }));
  assert.equal(fetchStreamCalls.length, 2);                    // 头+深探已完成
  const r = await resolve('vid00000008', { kind: 'audio' });
  assert.equal(r.gated, false);
  assert.equal(fetchStreamCalls.length, 2);                    // 缓存命中零新探
});

test('同 (videoId,kind) 并发 resolve 共享在途探测（单飞）', async () => {
  reset();
  const resolve = freshResolve();
  fetchPlayerImpl = async () => ({ streamingData: sd({ ad: [audioF('x')] }) });
  fetchStreamImpl = async () => {
    await new Promise(r => setTimeout(r, 5));   // 拉开在途窗口让第二家能搭上
    return { data: { destroy() {} } };
  };
  const [r1, r2] = await Promise.all([
    resolve('vid00000008a', { kind: 'audio' }),
    resolve('vid00000008a', { kind: 'audio' }),
  ]);
  assert.equal(r1.gated, false);
  assert.equal(r2.gated, false);
  assert.equal(fetchStreamCalls.length, 2);                    // 一次探测两家搭车
});

test('gateCache LRU：命中刷新排序，满容淘汰真最旧而非最近活跃项', async () => {
  reset();
  const resolve = freshResolve();
  fetchPlayerImpl = async () => ({ streamingData: sd({ ad: [audioF('x')] }) });
  fetchStreamImpl = async () => { throw errStatus(403); };
  fetchPlayerWithImpl = async () => ({ streamingData: sd({ ad: [audioF('v')] }) });
  const vid = (i) => `vid${String(i).padStart(8, '0')}`;
  // 填满 512 容量——v0 最早插入；全 403 桩下每趟未命中 resolve =
  // 首探+VISIONOS 复验两发，缓存命中 = 复验一发
  for (let i = 0; i < 512; i++) await resolve(vid(i), { kind: 'audio' });
  const probesAtFill = fetchStreamCalls.length;
  // v0 命中 + LRU touch 挪尾；此时插入序最旧的是 v1
  await resolve(vid(0), { kind: 'audio' });
  assert.equal(fetchStreamCalls.length, probesAtFill + 1);    // 命中免首探，复验一发
  // 新增 v512 → 淘汰最旧 = v1（v0 已 touch 到尾）；v0/v512 入缓存
  await resolve(vid(512), { kind: 'audio' });
  assert.equal(fetchStreamCalls.length, probesAtFill + 3);    // 首探+复验
  // 逐步断言淘的是谁——v0（刚 touch 过）仍命中免首探；v1 被淘重探。
  // 若实现无 touch，v0 才是淘汰受害者——这两步的计数区分得出
  await resolve(vid(0), { kind: 'audio' });
  assert.equal(fetchStreamCalls.length, probesAtFill + 4);    // v0 复验一发
  await resolve(vid(1), { kind: 'audio' });
  assert.equal(fetchStreamCalls.length, probesAtFill + 6);    // v1 重探+复验
});

test('探测目标 = 下发首链（排序头名），gateCache 键带 kind 互不串判', async () => {
  reset();
  const resolve = freshResolve();
  // 混合批：低码率巨档先行 + 低像素巨档先行——探测必须按下发序取首链
  // 而非数组序/contentLength 最大档（旧口径探永不下发的 vp9 巨档假阴）
  fetchPlayerImpl = async () => ({
    streamingData: sd({
      ad: [
        audioF('alo', { len: '90000000', br: 70000 }),   // 巨但码率低——非首链
        audioF('ahi', { len: '5000000', br: 130000 }),   // audio 排序头名
        videoF('vlo', { len: '99999999', h: 360 }),      // 巨但像素低
        videoF('vhi', { len: '8000000', h: 1080 }),      // video 排序头名
      ],
    })
  });
  const r = await resolve('vid00000009', { kind: 'audio' });
  assert.equal(fetchStreamCalls[0][0], GV('a-ahi'));     // 探的即 streams[0]
  assert.equal(r.streams[0].url, GV('a-ahi'));
  assert.equal(fetchStreamCalls[1][1].headers.Range, 'bytes=4500000-'); // 5MB×0.9
  // kind 分键：同 videoId 换 kind 不复用判定——音视频探测目标本就不同，
  // 共键会让一边的假判串到另一边
  await resolve('vid00000009', { kind: 'video' });
  assert.equal(fetchStreamCalls[2][0], GV('v-vhi'));
  assert.equal(fetchStreamCalls[3][1].headers.Range, 'bytes=7200000-'); // 8MB×0.9
  // 两键各自缓存——再来一轮零新探测
  await resolve('vid00000009', { kind: 'audio' });
  await resolve('vid00000009', { kind: 'video' });
  assert.equal(fetchStreamCalls.length, 4);
});

test('下发首链是合流档时退回批次签名代表：同 kind 最大自适应档', async () => {
  reset();
  const resolve = freshResolve();
  // video kind 批内无 avc1（只有 vp9）——pickStreamList 回落合流；探合流
  // 无信息量（合流签名批不被闸），退回 video/ 最大自适应档作批代表
  fetchPlayerImpl = async () => ({
    streamingData: sd({
      ad: [{ url: GV('vp9'), mimeType: 'video/webm; codecs="vp09.00.40.08"', bitrate: 2e6, contentLength: '99999999', height: 720, width: 1280 }],
      fm: [progF('x')],
    })
  });
  await resolve('vid00000010a', { kind: 'video' });
  assert.equal(fetchStreamCalls[0][0], GV('vp9'));       // 批代表兜底
  assert.equal(fetchStreamCalls[0][1].headers.Range, 'bytes=0-');
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
  assert.equal(fetchStreamCalls[0][0], GV('a-ok'));      // 探测目标跳过非白名单
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

test('pickStreamList video：adaptiveOnly 不交合流档（下载链防 mux 双音轨）', () => {
  reset();
  const data = sd({ fm: [progF('x', 720)] }); // 无 adaptive，只有 720p 合流
  // 播放链（默认）：avc1 缺席回落合流兜底
  assert.equal(realYt.pickStreamList(data, 'video').length, 1);
  // 下载链：adaptiveOnly 必须返回空——合流由 file-downloader 尾部相位接管
  assert.equal(realYt.pickStreamList(data, 'video', 'best', { adaptiveOnly: true }).length, 0);
});

test('pickStreamList video 次键：同像素先 fps 再 bitrate（1080p60 赢 1080p30）', () => {
  const v30 = { url: GV('v30'), mimeType: 'video/mp4; codecs="avc1.640028"', height: 1080, width: 1920, fps: 30, bitrate: 4500000 };
  const v60 = { url: GV('v60'), mimeType: 'video/mp4; codecs="avc1.640032"', height: 1080, width: 1920, fps: 60, bitrate: 5500000 };
  const vHiBr = { url: GV('vhi'), mimeType: 'video/mp4; codecs="avc1.640028"', height: 1080, width: 1920, fps: 30, bitrate: 8000000 };
  const data = sd({ ad: [v30, v60, vHiBr] });
  const out = realYt.pickStreamList(data, 'video', 'best', { adaptiveOnly: true });
  assert.equal(out[0].url, GV('v60'));   // 60fps 档赢（fps 先于码率）
  assert.equal(out[1].url, GV('vhi'));   // 同 30fps 段内 bitrate 决胜
  assert.equal(out[2].url, GV('v30'));
});

test('VISIONOS 阶段 abort 穿透——不得吞成 deadAdaptive 回落', async () => {
  reset();
  const resolve = freshResolve();
  fetchPlayerImpl = async () => ({ streamingData: sd({ ad: [audioF('x')], fm: [progF('x')] }) });
  fetchStreamImpl = async () => { throw errStatus(403); };     // 闸控命中
  const ctl = new AbortController();
  // abort 落在 VISIONOS 段内部（真实现 fetchPlayerWith 循环顶查 signal）
  fetchPlayerWithImpl = async () => { ctl.abort(); throw new Error('canceled'); };
  await assert.rejects(() => resolve('vid00000014', { kind: 'audio', signal: ctl.signal }));
  // abort 穿透而非回落——若吞成 deadAdaptive 会返回 streams 而非抛错
});

test('pickStreamList video adaptiveOnly：2160p vp9-webm 反超 1080p avc1，同像素仍 avc1 优先', () => {
  const avc1080 = { url: GV('avc1080'), mimeType: 'video/mp4; codecs="avc1.640028"', height: 1080, width: 1920, fps: 30, bitrate: 5000000 };
  const vp9_2160 = { url: GV('vp9-4k'), mimeType: 'video/webm; codecs="vp09.00.51.08"', height: 2160, width: 3840, fps: 30, bitrate: 18000000 };
  const vp9_1080 = { url: GV('vp9-1080'), mimeType: 'video/webm; codecs="vp09.00.40.08"', height: 1080, width: 1920, fps: 30, bitrate: 2400000 };
  const data = sd({ ad: [avc1080, vp9_2160, vp9_1080] });
  const out = realYt.pickStreamList(data, 'video', 'best', { adaptiveOnly: true });
  // >1080p 的 webm/vp9 档必须可达（avc1-only 时代 2160p 静默落成 1080p）
  assert.equal(out[0].url, GV('vp9-4k'));
  // 同像素 avc1 优先——vp9 1080p 排在 avc1 1080p 后（mp4 兼容档首选）
  assert.equal(out[1].url, GV('avc1080'));
  assert.equal(out[2].url, GV('vp9-1080'));
});

test('pickStreamList video 播放链不收 webm——非 avc1 档不外泄给浏览器直放', () => {
  const vp9_2160 = { url: GV('vp9-4k'), mimeType: 'video/webm; codecs="vp09.00.51.08"', height: 2160, width: 3840, fps: 30, bitrate: 18000000 };
  const avc1080 = { url: GV('avc1080'), mimeType: 'video/mp4; codecs="avc1.640028"', height: 1080, width: 1920, fps: 30, bitrate: 5000000 };
  const data = sd({ ad: [vp9_2160, avc1080] });
  const out = realYt.pickStreamList(data, 'video');
  assert.equal(out.length, 1);
  assert.equal(out[0].url, GV('avc1080'));
});

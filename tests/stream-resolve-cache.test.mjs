// stream-resolve-cache + 三端点正缓存钉：
//   - 工具层：TTL 过期即删、set 已存在键挪尾（LRU）、满容淘汰最旧、delete、未命中
//   - 端点层：同键二次请求不重解（上游只调一次）；retry=1 绕过读、照常写——
//     重试产物落在常规键上治愈旧档；404 形态（noAvc1/空 usable/null hit）不缓存
// 上游全桩：biliFetch/resolveYoutubeStreams/pickStreamUrl 记账计数，沿用
// stream-inflight.test.mjs / route-stream-keys.test.mjs 的桩面（真身 spread +
// 局部覆写）；TTL 测试手动拨 Date.now，不睡真时钟。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { seed, tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-resolve-cache-');
const require = createRequire(import.meta.url);

const { createTtlCache } = require('../src/server/lib/stream-resolve-cache.js');

// settings 先桩（lib/qq 顶层 require 它取凭据面）
seed('../src/server/lib/settings.js', {
  effectiveValue: () => null,
  qqCookieOverride: () => '',
  persistRenewedQqCookie: () => {},
});

const VIEW = {
  bvid: 'BV1xx411c7mD', cid: 111,
  pages: [{ cid: 111, page: 1 }, { cid: 222, page: 2 }],
};
const PLAYURL = {
  dash: {
    audio: [{
      id: 30280, mimeType: 'audio/mp4', codecs: 'mp4a.40.5', bandwidth: 129024,
      baseUrl: 'https://upos-sz-mirrorcos.bilivideo.com/a.m4s',
    }],
    video: [{
      id: 80, mimeType: 'video/mp4', codecs: 'avc1.640028', bandwidth: 800000,
      width: 1920, height: 1080, baseUrl: 'https://upos-sz-mirrorcos.bilivideo.com/v.m4s',
    }],
  },
};
const EMPTY_PLAYURL = { dash: { audio: [], video: [] } };
const biliCalls = [];
let biliFetchImpl = async (path) => {
  if (path.includes('/x/web-interface/view')) return VIEW;
  if (path.includes('/x/player/playurl')) return PLAYURL;
  throw new Error(`unexpected upstream ${path}`);
};
const realBv = require('../src/server/lib/bilibili.js');
seed('../src/server/lib/bilibili.js', {
  ...realBv,
  biliFetch: async (path) => { biliCalls.push(path); return biliFetchImpl(path); },
});

let ytCalls = 0;
let ytImpl = async () => ({
  streams: [{
    url: 'https://rr1---sn-abcde.googlevideo.com/videoplayback?itag=251&expire=999',
    mimeType: 'audio/webm; codecs="opus"', br: 140000,
  }],
});
const realYtResolve = require('../src/server/services/youtube-resolve.js');
seed('../src/server/services/youtube-resolve.js', {
  ...realYtResolve,
  resolveYoutubeStreams: async (...a) => { ytCalls++; return ytImpl(...a); },
});

let qqCalls = 0;
let qqImpl = async () => ({ url: 'https://ws.stream.qqmusic.qq.com/x.m4a?vkey=k1&uin=0', tier: 'M800' });
const realQq = require('../src/server/lib/qq.js');
seed('../src/server/lib/qq.js', {
  ...realQq,
  pickStreamUrl: async (...a) => { qqCalls++; return qqImpl(...a); },
  // 外源解锁腿 buildInfo 的 detail 上行——桩死防真打 fcg 上游
  getSongDetail: async () => null,
});
// qq 外源解锁兜底桩：provider 表空 → 共享链逐源零调用即全灭——null-hit
// 用例会走到 F1 链，真 provider 图会打上游检索扇出（本文件只钉正缓存语义）
seed('../src/server/services/unlock/index.js', {
  PROVIDERS: {},
  QQ_UNLOCK_SOURCES: ['youtube', 'bilibili'],
});

let biliApp, ytApp, qqApp, streamVault;
before(() => {
  biliApp = require('../src/server/routes/bilibili.js');
  ytApp = require('../src/server/routes/youtube.js');
  qqApp = require('../src/server/routes/qq.js');
  streamVault = require('../src/server/lib/stream-vault.js');
});
after(() => rmSync(process.env.DATA_DIR, { recursive: true, force: true }));

// 302 → vault token → 上游 URL（断言「吃的是哪次解析的产物」用）
const servedUrls = async (app, path) => {
  const r = await app.request(`http://t${path}`);
  const loc = r.headers.get('location') || '';
  const token = /\/audio-proxy\/t\/([^\s]+)/.exec(loc)?.[1];
  return { status: r.status, urls: token ? streamVault.resolve(token)?.urls : null };
};

// ---------- 工具层 ----------

test('createTtlCache：未命中回 undefined；set 后可读', () => {
  const c = createTtlCache({ max: 4, ttlMs: 1000 });
  assert.equal(c.get('nope'), undefined);
  c.set('k1', { v: 1 });
  assert.deepEqual(c.get('k1'), { v: 1 });
  assert.equal(c.size, 1);
});

test('createTtlCache：TTL 过期命中即删——回 undefined 且摘键', () => {
  const realNow = Date.now;
  let t = 1000;
  Date.now = () => t;
  try {
    const c = createTtlCache({ max: 4, ttlMs: 100 });
    c.set('k1', 'v1');
    assert.equal(c.get('k1'), 'v1');
    t += 99;
    assert.equal(c.get('k1'), 'v1', '窗口内仍活');
    t += 2; // 101ms 过线
    assert.equal(c.get('k1'), undefined);
    assert.equal(c.size, 0, '惰性过期顺手摘键');
  } finally { Date.now = realNow; }
});

test('createTtlCache：set 已存在键挪尾——满容淘汰跳过刷新的热键', () => {
  const realNow = Date.now;
  Date.now = () => 0;
  try {
    const c = createTtlCache({ max: 3, ttlMs: 1000 });
    c.set('a', 1); c.set('b', 2); c.set('c', 3);
    c.set('a', 10); // 重设 a：挪到队尾，淘汰序变成 b → c → a
    c.set('d', 4);  // 满容——最旧的 b 被逐，a 因挪尾存活
    assert.equal(c.get('b'), undefined, 'b 应被满容淘汰');
    assert.equal(c.get('a'), 10, 'a 挪尾存活且值已刷新');
    assert.equal(c.get('c'), 3);
    assert.equal(c.get('d'), 4);
    assert.equal(c.size, 3);
  } finally { Date.now = realNow; }
});

test('createTtlCache：满容淘汰最旧', () => {
  const c = createTtlCache({ max: 2, ttlMs: 1000 });
  c.set('x', 1); c.set('y', 2); c.set('z', 3);
  assert.equal(c.get('x'), undefined);
  assert.equal(c.get('y'), 2);
  assert.equal(c.get('z'), 3);
  assert.equal(c.size, 2, '容量封顶不膨胀');
});

test('createTtlCache：delete 摘键', () => {
  const c = createTtlCache({ max: 4, ttlMs: 1000 });
  c.set('k', 'v');
  assert.equal(c.delete('k'), true);
  assert.equal(c.get('k'), undefined);
  assert.equal(c.delete('k'), false, '删不存在的键回 false');
  assert.equal(c.size, 0);
});

// ---------- /youtube/stream ----------

test('youtube/stream：同键二次请求上游只调一次', async () => {
  ytCalls = 0;
  const v = 'CACHEAAAAA1'; // YT_ID_RE 定长 11 位
  const r1 = await ytApp.request(`http://t/youtube/stream?v=${v}`);
  assert.equal(r1.status, 302);
  const r2 = await ytApp.request(`http://t/youtube/stream?v=${v}`);
  assert.equal(r2.status, 302);
  assert.equal(ytCalls, 1, '第二发吃正缓存——player+探测扇出只跑一遍');
});

test('youtube/stream：retry=1 绕过读照常写——重试产物治愈常规键', async () => {
  ytCalls = 0;
  const v = 'CACHEBBBBB2';
  // 首发常规请求写入 |0 产物（itag=251）
  await ytApp.request(`http://t/youtube/stream?v=${v}`);
  // retry=1：绕过读（上游再调一次），照常写——产物换成 itag=999
  ytImpl = async () => ({
    streams: [{
      url: 'https://rr1---sn-abcde.googlevideo.com/videoplayback?itag=999&expire=999',
      mimeType: 'audio/webm; codecs="opus"', br: 150000,
    }],
  });
  const rr = await ytApp.request(`http://t/youtube/stream?v=${v}&retry=1`);
  assert.equal(rr.status, 302);
  assert.equal(ytCalls, 2, 'retry=1 不吃缓存——照常重解');
  // 后续常规请求命中的是 retry 写回的新产物——gateCache 同口径的治愈写
  const { status, urls } = await servedUrls(ytApp, `/youtube/stream?v=${v}`);
  assert.equal(status, 302);
  assert.ok(urls?.[0]?.includes('itag=999'), `应吃 retry 写回的产物，实际 ${urls?.[0]}`);
  assert.equal(ytCalls, 2, '第三发吃正缓存不重解');
  ytImpl = async () => ({
    streams: [{
      url: 'https://rr1---sn-abcde.googlevideo.com/videoplayback?itag=251&expire=999',
      mimeType: 'audio/webm; codecs="opus"', br: 140000,
    }],
  });
});

test('youtube/stream：缓存命中先于 inflight——在途 retry 链挂起不挡命中方', async () => {
  ytCalls = 0;
  const v = 'CACHECCCCC3';
  await ytApp.request(`http://t/youtube/stream?v=${v}`); // 写入 |0
  assert.equal(ytCalls, 1);
  // retry=1 在途挂起：同曲常规请求仍应吃缓存秒回，不等这条链
  let release;
  const gate = new Promise(r => { release = r; });
  ytImpl = async () => { await gate; return {
    streams: [{
      url: 'https://rr1---sn-abcde.googlevideo.com/videoplayback?itag=555&expire=999',
      mimeType: 'audio/webm; codecs="opus"', br: 160000,
    }],
  }; };
  const pending = ytApp.request(`http://t/youtube/stream?v=${v}&retry=1`);
  await new Promise(r => setTimeout(r, 10));
  const { status, urls } = await servedUrls(ytApp, `/youtube/stream?v=${v}`);
  assert.equal(status, 302);
  assert.ok(urls?.[0]?.includes('itag=251'), '命中方吃缓存旧档，不被在途 retry 拖住');
  release();
  assert.equal((await pending).status, 302);
  assert.equal(ytCalls, 2);
  ytImpl = async () => ({
    streams: [{
      url: 'https://rr1---sn-abcde.googlevideo.com/videoplayback?itag=251&expire=999',
      mimeType: 'audio/webm; codecs="opus"', br: 140000,
    }],
  });
});

test('youtube/stream：空 streams（404 形态）不缓存——下一发照常重解', async () => {
  ytCalls = 0;
  const v = 'CACHEDDDDD4';
  const saved = ytImpl;
  ytImpl = async () => ({ streams: [] });
  try {
    const path = `/youtube/stream?v=${v}`;
    assert.equal((await ytApp.request(`http://t${path}`)).status, 404);
    assert.equal(ytCalls, 1);
    assert.equal((await ytApp.request(`http://t${path}`)).status, 404);
    assert.equal(ytCalls, 2, '负结果不固化——与 bv/qq 同口径');
  } finally { ytImpl = saved; }
});

// ---------- /bilibili/stream ----------

test('bilibili/stream：同键二次请求上游只调一次', async () => {
  biliCalls.length = 0;
  const path = '/bilibili/stream?bvid=BV1xx411c7mD&p=1';
  assert.equal((await biliApp.request(`http://t${path}`)).status, 302);
  const after1 = biliCalls.length;
  assert.ok(after1 >= 2, '首发走 view+playurl 扇出');
  assert.equal((await biliApp.request(`http://t${path}`)).status, 302);
  assert.equal(biliCalls.length, after1, '第二发吃正缓存——上游零新调用');
});

test('bilibili/stream：404 形态不缓存——空 usable 下一发照常重解', async () => {
  biliCalls.length = 0;
  const saved = biliFetchImpl;
  biliFetchImpl = async (path) => {
    if (path.includes('/x/web-interface/view')) return VIEW;
    if (path.includes('/x/player/playurl')) return EMPTY_PLAYURL;
    throw new Error(`unexpected upstream ${path}`);
  };
  try {
    const path = '/bilibili/stream?bvid=BV1xx411c7mD&p=1&cid=999'; // 异键绕开上条缓存
    assert.equal((await biliApp.request(`http://t${path}`)).status, 404);
    const after1 = biliCalls.length;
    assert.equal((await biliApp.request(`http://t${path}`)).status, 404);
    assert.ok(biliCalls.length > after1, '负结果不固化——下一发照常重解');
  } finally { biliFetchImpl = saved; }
});

test('bilibili/stream：异键不复用——kind/cid 不同各自重解', async () => {
  biliCalls.length = 0;
  assert.equal((await biliApp.request('http://t/bilibili/stream?bvid=BV1xx411c7mD&p=1&kind=video')).status, 302);
  const after1 = biliCalls.length;
  assert.equal((await biliApp.request('http://t/bilibili/stream?bvid=BV1xx411c7mD&p=1&cid=222&kind=video')).status, 302);
  assert.ok(biliCalls.length > after1, '显式 cid 与分P序是不同键——不重吃');
});

// ---------- /qq/stream ----------

test('qq/stream：同键二次请求上游只调一次；异 mid 不重吃', async () => {
  qqCalls = 0;
  const r1 = await qqApp.request('http://t/qq/stream?mid=qqAAAAA00001');
  assert.equal(r1.status, 302);
  const r2 = await qqApp.request('http://t/qq/stream?mid=qqAAAAA00001');
  assert.equal(r2.status, 302);
  assert.equal(qqCalls, 1, 'vkey ~22h 寿命——第二发吃正缓存');
  await qqApp.request('http://t/qq/stream?mid=qqBBBBB00002');
  assert.equal(qqCalls, 2, '异 mid 不同键');
});

test('qq/stream：null hit（无权限）不缓存——下一发照常重解', async () => {
  qqCalls = 0;
  const saved = qqImpl;
  qqImpl = async () => null;
  try {
    assert.equal((await qqApp.request('http://t/qq/stream?mid=qqCCCCC00003')).status, 404);
    assert.equal(qqCalls, 1);
    assert.equal((await qqApp.request('http://t/qq/stream?mid=qqCCCCC00003')).status, 404);
    assert.equal(qqCalls, 2, '负结果不固化');
  } finally { qqImpl = saved; }
});

// ---------- 复审增补：retry 旁路三源补齐 / 键分离钉板 / LRU 读触 ----------

test('createTtlCache：get 命中挪尾——读热键满容存活（FIFO→真 LRU）', () => {
  const c = createTtlCache({ max: 3, ttlMs: 1000 });
  c.set('a', 1); c.set('b', 2); c.set('c', 3);
  assert.equal(c.get('a'), 1); // 读热 a——挪尾后淘汰序变 b → c → a
  c.set('d', 4);               // 满容——只读不挪尾的 FIFO 会误杀热键 a
  assert.equal(c.get('b'), undefined, 'b 应被满容淘汰');
  assert.equal(c.get('a'), 1, 'a 读触挪尾存活');
  assert.equal(c.get('c'), 3);
  assert.equal(c.get('d'), 4);
});

test('createTtlCache：get 挪尾不刷 expiresAt——读触不延寿', () => {
  const realNow = Date.now;
  let t = 1000;
  Date.now = () => t;
  try {
    const c = createTtlCache({ max: 4, ttlMs: 100 });
    c.set('k', 'v');
    t += 90;
    assert.equal(c.get('k'), 'v', '临期命中挪尾');
    t += 20; // 110ms 过线——读触若顺手刷 TTL 这里仍活
    assert.equal(c.get('k'), undefined, '读触不延寿——死签名不能靠命中续命');
  } finally { Date.now = realNow; }
});

test('bilibili/stream：retry=1 绕过读照常写——重试产物治愈常规键', async () => {
  biliCalls.length = 0;
  const bvid = 'BV1xx411c7mF';
  const path = `/bilibili/stream?bvid=${bvid}&p=1`;
  // 首发常规请求写入产物（cos 镜像组）
  assert.equal((await biliApp.request(`http://t${path}`)).status, 302);
  const after1 = biliCalls.length;
  const saved = biliFetchImpl;
  biliFetchImpl = async (p) => {
    if (p.includes('/x/web-interface/view')) return VIEW;
    if (p.includes('/x/player/playurl')) return {
      dash: {
        audio: [{
          id: 30280, mimeType: 'audio/mp4', codecs: 'mp4a.40.5', bandwidth: 129024,
          baseUrl: 'https://upos-sz-mirrorbkup.bilivideo.com/a.m4s',
        }],
        video: [],
      },
    };
    throw new Error(`unexpected upstream ${p}`);
  };
  try {
    // retry=1：绕过读（上游再扇出），照常写——产物换成 bkup 镜像组
    assert.equal((await biliApp.request(`http://t${path}&retry=1`)).status, 302);
    assert.ok(biliCalls.length > after1, 'retry=1 不吃缓存——照常重解');
    const after2 = biliCalls.length;
    const { status, urls } = await servedUrls(biliApp, path);
    assert.equal(status, 302);
    assert.ok(urls?.[0]?.includes('mirrorbkup'),
      `应吃 retry 写回的产物，实际 ${urls?.[0]}`);
    assert.equal(biliCalls.length, after2, '第三发吃正缓存不重解');
  } finally { biliFetchImpl = saved; }
});

test('qq/stream：retry=1 绕过读照常写——重试产物治愈常规键', async () => {
  qqCalls = 0;
  const mid = 'qqDDDDD00004';
  assert.equal((await qqApp.request(`http://t/qq/stream?mid=${mid}`)).status, 302);
  assert.equal(qqCalls, 1);
  const saved = qqImpl;
  qqImpl = async () => ({ url: 'https://ws.stream.qqmusic.qq.com/y.m4a?vkey=k2&uin=0', tier: 'M800' });
  try {
    // retry=1：绕过读（vkey 再取一次），照常写——产物换成 vkey=k2
    assert.equal((await qqApp.request(`http://t/qq/stream?mid=${mid}&retry=1`)).status, 302);
    assert.equal(qqCalls, 2, 'retry=1 不吃缓存——照常重取 vkey');
    const { status, urls } = await servedUrls(qqApp, `/qq/stream?mid=${mid}`);
    assert.equal(status, 302);
    assert.ok(urls?.[0]?.includes('vkey=k2'), `应吃 retry 写回的产物，实际 ${urls?.[0]}`);
    assert.equal(qqCalls, 2, '第三发吃正缓存不重解');
  } finally { qqImpl = saved; }
});

test('bilibili/stream：prefer=best 与常规档不共键——令牌门后终值分键', async () => {
  biliCalls.length = 0;
  const bvid = 'BV1xx411c7mG';
  const path = `/bilibili/stream?bvid=${bvid}&p=1`;
  assert.equal((await biliApp.request(`http://t${path}`)).status, 302);
  const after1 = biliCalls.length;
  assert.equal((await biliApp.request(`http://t${path}&prefer=best`)).status, 302);
  assert.ok(biliCalls.length > after1, 'best 与常规档是不同字节实体——分键重解');
  const after2 = biliCalls.length;
  assert.equal((await biliApp.request(`http://t${path}&prefer=best`)).status, 302);
  assert.equal(biliCalls.length, after2, '同 best 键复访命中');
});

test('qq/stream：mmid 段缺失与有值不共键', async () => {
  qqCalls = 0;
  const mid = 'qqEEEEE00005';
  assert.equal((await qqApp.request(`http://t/qq/stream?mid=${mid}`)).status, 302);
  assert.equal((await qqApp.request(`http://t/qq/stream?mid=${mid}&mmid=mm1234567890`)).status, 302);
  assert.equal(qqCalls, 2, 'mediaMid 不同是不同选链扇出——分键');
  assert.equal((await qqApp.request(`http://t/qq/stream?mid=${mid}&mmid=mm1234567890`)).status, 302);
  assert.equal(qqCalls, 2, '同 mmid 键复访命中');
});

test('youtube/stream：kind=video 与 audio 不共键', async () => {
  ytCalls = 0;
  const v = 'CACHEEEEEE5';
  assert.equal((await ytApp.request(`http://t/youtube/stream?v=${v}`)).status, 302);
  assert.equal((await ytApp.request(`http://t/youtube/stream?v=${v}&kind=video`)).status, 302);
  assert.equal(ytCalls, 2, '不同字节实体各自解析');
  assert.equal((await ytApp.request(`http://t/youtube/stream?v=${v}&kind=video`)).status, 302);
  assert.equal(ytCalls, 2, '同 video 键复访命中');
});

test('youtube/stream：prefer 归一——垃圾值与空值共键', async () => {
  ytCalls = 0;
  const v = 'CACHEFFFFF6';
  assert.equal((await ytApp.request(`http://t/youtube/stream?v=${v}`)).status, 302);
  assert.equal(ytCalls, 1);
  assert.equal((await ytApp.request(`http://t/youtube/stream?v=${v}&prefer=garbage`)).status, 302);
  assert.equal(ytCalls, 1, 'lib 只认 best——垃圾值归一为空，不白占键基数');
});

test('bilibili/stream：显式 cid 折叠共键——?cid=X 与 ?cid=X&p=9 命中同档', async () => {
  biliCalls.length = 0;
  const bvid = 'BV1xx411c7mH';
  assert.equal((await biliApp.request(`http://t/bilibili/stream?bvid=${bvid}&cid=222`)).status, 302);
  const after1 = biliCalls.length;
  // cid 在位时播放内容只由 cid 决定——?p 是死参数，折叠键形下复访必须命中
  assert.equal((await biliApp.request(`http://t/bilibili/stream?bvid=${bvid}&cid=222&p=9`)).status, 302);
  assert.equal(biliCalls.length, after1, 'cid 优先于 p——同 cid 复访不重解');
});

test('缓存产物只读契约：freeze 的桩产物命中后被消费方触碰不炸', async () => {
  // 深冻辅助——把上游桩对象整棵 freeze：下游任何原位变异（push/sort/
  // 字段改写）在 freeze 面上 TypeError，只读消费应安然通过
  const deepFreeze = (o) => {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      for (const v of Object.values(o)) deepFreeze(v);
      Object.freeze(o);
    }
    return o;
  };

  // yt：freeze resolve 产物本体+streams 数组+流条目
  ytCalls = 0;
  const v = 'CACHEGGGGG7';
  const savedYt = ytImpl;
  ytImpl = async () => deepFreeze({
    streams: [{
      url: 'https://rr1---sn-abcde.googlevideo.com/videoplayback?itag=251&expire=999',
      mimeType: 'audio/webm; codecs="opus"', br: 140000,
    }],
  });
  try {
    assert.equal((await ytApp.request(`http://t/youtube/stream?v=${v}`)).status, 302);
    assert.equal((await ytApp.request(`http://t/youtube/stream?v=${v}`)).status, 302);
    assert.equal(ytCalls, 1, 'freeze 产物缓存命中——下游只读不炸');
  } finally { ytImpl = savedYt; }

  // qq：freeze pickStreamUrl 命中对象
  qqCalls = 0;
  const mid = 'qqFFFFF00006';
  const savedQq = qqImpl;
  qqImpl = async () => deepFreeze({ url: 'https://ws.stream.qqmusic.qq.com/z.m4a?vkey=k3&uin=0', tier: 'M800' });
  try {
    assert.equal((await qqApp.request(`http://t/qq/stream?mid=${mid}`)).status, 302);
    assert.equal((await qqApp.request(`http://t/qq/stream?mid=${mid}`)).status, 302);
    assert.equal(qqCalls, 1, 'freeze hit 缓存命中——下游只读不炸');
  } finally { qqImpl = savedQq; }

  // bv：缓存产物的 cacheTier 直接引用上游 dash 条目——深冻上游响应，
  // 命中链若对它做原位变异立刻炸
  biliCalls.length = 0;
  const bvid = 'BV1xx411c7mJ';
  const savedBv = biliFetchImpl;
  biliFetchImpl = async (p) => {
    if (p.includes('/x/web-interface/view')) return deepFreeze({
      bvid, cid: 111, pages: [{ cid: 111, page: 1 }, { cid: 222, page: 2 }],
    });
    if (p.includes('/x/player/playurl')) return deepFreeze({
      dash: {
        audio: [{
          id: 30280, mimeType: 'audio/mp4', codecs: 'mp4a.40.5', bandwidth: 129024,
          baseUrl: 'https://upos-sz-mirrorcos.bilivideo.com/a.m4s',
        }],
        video: [],
      },
    });
    throw new Error(`unexpected upstream ${p}`);
  };
  try {
    const path = `/bilibili/stream?bvid=${bvid}&p=1`;
    assert.equal((await biliApp.request(`http://t${path}`)).status, 302);
    const after1 = biliCalls.length;
    assert.equal((await biliApp.request(`http://t${path}`)).status, 302);
    assert.equal(biliCalls.length, after1, 'freeze 上游产物缓存命中——下游只读不炸');
  } finally { biliFetchImpl = savedBv; }
});

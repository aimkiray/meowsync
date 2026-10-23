// 外源曲手动媒体源绑定的流端点消费步钉板（「自有源败亡→绑定顶替」失败触发
// 位序——与数值域「官方直解→手动→推导回链」同构投影）：
//   - /qq/stream：自有源 null/qqAnonDenied → 绑定 302+x-manual-source 头；
//     自有源健康+绑定在场 → 302 自有源、resolveById 零调用（核心位序断言）；
//     绑定死 → 原 404/502 分档文案（ownErr 回抛）；retry=1 旁路手动缓存
//   - /bilibili/stream：kind=audio 空 usable → 绑定 302；轨道键
//     ?p=N→bv_…_pN、小写 bvid→BV canonicalize；kind=video 闸外豁免
//   - /youtube/stream：自有空流+跨源绑定 → 302；未绑 → 原 404
//   - 手动缓存 60s 正/负档；POST/DELETE 调 forgetManualStream 即时生效
// 桩面对表 stream-resolve-cache.test.mjs（三端点 app 直挂+上游桩）+
// route-unlock-manual.test.mjs（unlock 门面桩+真 repo/真库）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { seed, tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-manual-stream-');
// 限流桶按 IP 分：每发独立 XFF 防跨用例配额互耗
process.env.TRUST_PROXY = '1';
const require = createRequire(import.meta.url);

// settings 先桩（lib/qq 顶层 require 它取凭据面）
seed('../src/server/lib/settings.js', {
  effectiveValue: () => null,
  qqCookieOverride: () => '',
  persistRenewedQqCookie: () => {},
});
// AI 层桩——netease-api require 链挂着 lib/ai
seed('../src/server/lib/ai.js', {
  aiEnabled: () => false,
  aiModel: () => 'test-model',
  askAiJson: async () => null,
});
seed('../src/server/services/netease/index.js', {
  callNeteaseApi: async (name) => { throw new Error(`unexpected api ${name}`); },
  apiModules: {},
});

// provider 桩：resolveById 可编程记账——端点内手动步与 POST 验流共用同桩
const BOUND_YT_URL = 'https://rr1---sn-x.googlevideo.com/videoplayback?sig=BOUND_YT';
const BOUND_BV_URL = 'https://upos-sz-m1.bilivideo.com/ugax/bound.m4s?sig=BOUND_BV';
const resolveByIdCalls = [];
const forgetCalls = [];
let ytResolveByIdImpl = async () => ({ url: BOUND_YT_URL, urls: [BOUND_YT_URL], br: 128000, durationSec: null });
let bvResolveByIdImpl = async () => ({ url: BOUND_BV_URL, urls: [BOUND_BV_URL], br: 192000, durationSec: null, ext: 'm4a' });
seed('../src/server/services/unlock/index.js', {
  PROVIDERS: {
    youtube: {
      resolveById: async (mediaId, o) => {
        resolveByIdCalls.push({ source: 'youtube', mediaId, ctx: o });
        return ytResolveByIdImpl(mediaId, o);
      },
      forgetSong: (id) => forgetCalls.push(`yt:${id}`),
    },
    bilibili: {
      resolveById: async (mediaId, o) => {
        resolveByIdCalls.push({ source: 'bilibili', mediaId, ctx: o });
        return bvResolveByIdImpl(mediaId, o);
      },
      forgetSong: (id) => forgetCalls.push(`bv:${id}`),
    },
  },
  PLAYBACK_SOURCES: ['pyncmd', 'youtube', 'bilibili'],
  DOWNLOAD_SOURCES: ['pyncmd', 'youtube', 'bilibili'],
});

// qq lib：pickStreamUrl 可编程（自有源腿死活开关）；hasQqCookie=false 走匿名文案
let pickImpl = async () => null;
const pickCalls = [];
const realQq = require('../src/server/lib/qq.js');
seed('../src/server/lib/qq.js', {
  ...realQq,
  hasQqCookie: () => false,
  pickStreamUrl: async (...a) => { pickCalls.push(a); return pickImpl(...a); },
});

// bili lib：biliFetch 可编程——默认 EMPTY_PLAYURL 自有源空 usable
const VIEW = {
  bvid: 'BV1xx411c7mD', cid: 111,
  pages: [{ cid: 111, page: 1 }, { cid: 222, page: 2 }, { cid: 333, page: 3 }],
};
const EMPTY_PLAYURL = { dash: { audio: [], video: [] } };
const biliCalls = [];
let biliFetchImpl = async (path) => {
  if (path.includes('/x/web-interface/view')) return VIEW;
  if (path.includes('/x/player/playurl')) return EMPTY_PLAYURL;
  throw new Error(`unexpected upstream ${path}`);
};
const realBv = require('../src/server/lib/bilibili.js');
seed('../src/server/lib/bilibili.js', {
  ...realBv,
  biliFetch: async (p) => { biliCalls.push(p); return biliFetchImpl(p); },
});

// youtube-resolve：resolveYoutubeStreams 可编程——默认空 streams 自有源败亡
const ytResolveCalls = [];
let ytImpl = async () => ({ streams: [] });
const realYtResolve = require('../src/server/services/youtube-resolve.js');
seed('../src/server/services/youtube-resolve.js', {
  ...realYtResolve,
  resolveYoutubeStreams: async (...a) => { ytResolveCalls.push(a); return ytImpl(...a); },
});

let qqApp, biliApp, ytApp, unlockApp, streamVault, repo;
before(() => {
  qqApp = require('../src/server/routes/qq.js');
  biliApp = require('../src/server/routes/bilibili.js');
  ytApp = require('../src/server/routes/youtube.js');
  unlockApp = require('../src/server/routes/unlock-manual.js');
  streamVault = require('../src/server/lib/stream-vault.js');
  repo = require('../src/server/repositories/unlockManual.js');
});
after(() => {
  delete process.env.TRUST_PROXY;
  rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

let ipSeq = 100;
const nextIp = () => `10.22.${++ipSeq}.1`;
const BVID = 'BV1xx411c7mD';
const VID = 'dQw4w9WgXcQ';
// 302→vault token→urls + x-manual-source 头；非 302 回 body（分档文案断言面）
const probe = async (app, path) => {
  const r = await app.request(`http://t${path}`, { headers: { 'x-forwarded-for': nextIp() } });
  const loc = r.headers.get('location') || '';
  const token = /\/audio-proxy\/t\/([^\s]+)/.exec(loc)?.[1];
  return {
    status: r.status,
    manual: r.headers.get('x-manual-source'),
    urls: token ? streamVault.resolve(token)?.urls : null,
    body: await r.json().catch(() => null),
  };
};
const bind = (trackId, source, mediaId) => repo.upsertManual(trackId,
  { source, mediaId, title: '', owner: '', durationSec: null });
const reset = () => {
  pickCalls.length = biliCalls.length = ytResolveCalls.length = 0;
  resolveByIdCalls.length = forgetCalls.length = 0;
  pickImpl = async () => null;
  biliFetchImpl = async (path) => {
    if (path.includes('/x/web-interface/view')) return VIEW;
    if (path.includes('/x/player/playurl')) return EMPTY_PLAYURL;
    throw new Error(`unexpected upstream ${path}`);
  };
  ytImpl = async () => ({ streams: [] });
  ytResolveByIdImpl = async () => ({ url: BOUND_YT_URL, urls: [BOUND_YT_URL], br: 128000, durationSec: null });
  bvResolveByIdImpl = async () => ({ url: BOUND_BV_URL, urls: [BOUND_BV_URL], br: 192000, durationSec: null, ext: 'm4a' });
};

// ---------- /qq/stream ----------

test('/qq/stream 自有源 null + 绑定在场 → 302 绑媒体；pickStream 先行 + x-manual-source 头', async () => {
  reset();
  bind('qq_qqMANUAL0001', 'youtube', VID);
  const r = await probe(qqApp, '/qq/stream?mid=qqMANUAL0001');
  assert.equal(r.status, 302);
  assert.equal(r.manual, 'youtube', 'x-manual-source 头烙绑定血缘');
  assert.ok(r.urls?.[0]?.includes('BOUND_YT'), `应 mint 绑媒体 urls，实际 ${r.urls?.[0]}`);
  assert.equal(pickCalls.length, 1, '自有源先跑——绑定是失败触发不是先行');
  assert.deepEqual(resolveByIdCalls.map(x => `${x.source}:${x.mediaId}`), [`youtube:${VID}`]);
  assert.equal(resolveByIdCalls[0].ctx.purpose, 'playback');
  repo.deleteManual('qq_qqMANUAL0001');
});

test('/qq/stream 自有源抛 qqAnonDenied → 同样消费绑定 302（凭据拒答也触发）', async () => {
  reset();
  bind('qq_qqDENIED0002', 'bilibili', BVID);
  pickImpl = async () => {
    const e = new Error('qq musicu vkey.GetVkeyServer code=0/1000');
    e.qqAnonDenied = true;
    throw e;
  };
  const r = await probe(qqApp, '/qq/stream?mid=qqDENIED0002');
  assert.equal(r.status, 302);
  assert.equal(r.manual, 'bilibili');
  assert.ok(r.urls?.[0]?.includes('BOUND_BV'));
  repo.deleteManual('qq_qqDENIED0002');
});

test('/qq/stream 自有源健康+绑定在场 → 302 自有源，resolveById 零调用（失败触发核心位序）', async () => {
  reset();
  bind('qq_qqHEALTHY003', 'youtube', VID);
  pickImpl = async () => ({ url: 'https://ws.stream.qqmusic.qq.com/own.m4a?vkey=OWN', tier: 'M800' });
  const r = await probe(qqApp, '/qq/stream?mid=qqHEALTHY003');
  assert.equal(r.status, 302);
  assert.ok(r.urls?.[0]?.includes('vkey=OWN'), `应播自有源产物，实际 ${r.urls?.[0]}`);
  assert.equal(r.manual, null, '自有源命中不带 manual 头');
  assert.equal(resolveByIdCalls.length, 0,
    '自有源健康时绑定休眠——与数值域「pyncmd 健康绑定休眠」同语义');
  repo.deleteManual('qq_qqHEALTHY003');
});

test('/qq/stream 绑定死 → 原 404/502 分档文案原样（ownErr 回抛既有路径）', async () => {
  reset();
  // null-hit + 绑定 resolveById 回 null → 原 404 匿名指引
  bind('qq_qqDEAD000004', 'youtube', VID);
  ytResolveByIdImpl = async () => null;
  let r = await probe(qqApp, '/qq/stream?mid=qqDEAD000004');
  assert.equal(r.status, 404);
  assert.match(r.body.message, /QQ 已关闭匿名取流，配置 Cookie 或匹配网易词源后可播/);
  assert.equal(r.manual, null);
  // qqAnonDenied + 绑定 resolveById 抛 → 原 502 拒答文案（ownErr 优先于 404）
  bind('qq_qqDEAD000005', 'youtube', VID);
  pickImpl = async () => {
    const e = new Error('vkey denied');
    e.qqAnonDenied = true;
    throw e;
  };
  ytResolveByIdImpl = async () => { throw new Error('upstream 412'); };
  r = await probe(qqApp, '/qq/stream?mid=qqDEAD000005');
  assert.equal(r.status, 502);
  assert.match(r.body.message, /QQ 已关闭匿名取流——请在设置页配置 QQ Cookie 后重试/);
  repo.deleteManual('qq_qqDEAD000004');
  repo.deleteManual('qq_qqDEAD000005');
});

test('/qq/stream ?retry=1 旁路手动缓存读、照常写（治愈写同口径）', async () => {
  reset();
  bind('qq_qqRETRY00006', 'youtube', VID);
  ytResolveByIdImpl = async () => ({
    url: 'https://rr1---sn-x.googlevideo.com/v?sig=V1',
    urls: ['https://rr1---sn-x.googlevideo.com/v?sig=V1'], br: 1,
  });
  let r = await probe(qqApp, '/qq/stream?mid=qqRETRY00006');
  assert.ok(r.urls?.[0]?.includes('sig=V1'));
  assert.equal(resolveByIdCalls.length, 1);
  // 二发常规——吃 60s 正档不重解
  ytResolveByIdImpl = async () => ({
    url: 'https://rr1---sn-x.googlevideo.com/v?sig=V2',
    urls: ['https://rr1---sn-x.googlevideo.com/v?sig=V2'], br: 1,
  });
  r = await probe(qqApp, '/qq/stream?mid=qqRETRY00006');
  assert.ok(r.urls?.[0]?.includes('sig=V1'), '60s 正档——第二发吃绑定产物');
  assert.equal(resolveByIdCalls.length, 1);
  // retry=1 旁路读 → 重解出 V2（与自有源缓存同口径）
  r = await probe(qqApp, '/qq/stream?mid=qqRETRY00006&retry=1');
  assert.ok(r.urls?.[0]?.includes('sig=V2'));
  assert.equal(resolveByIdCalls.length, 2);
  repo.deleteManual('qq_qqRETRY00006');
});

// ---------- /bilibili/stream ----------

test('/bilibili/stream kind=audio 自有源空 usable + 绑定 → 302 绑媒体（自有源先行）', async () => {
  reset();
  bind(`bv_${BVID}`, 'youtube', VID);
  const r = await probe(biliApp, `/bilibili/stream?bvid=${BVID}&kind=audio`);
  assert.equal(r.status, 302);
  assert.equal(r.manual, 'youtube');
  assert.ok(r.urls?.[0]?.includes('BOUND_YT'));
  assert.ok(biliCalls.length >= 2, '自有源先行——view+playurl 扇出已跑');
  repo.deleteManual(`bv_${BVID}`);
});

test('/bilibili/stream 轨道键：?p=N→bv_…_pN 查绑（键分离）；小写 bvid canonicalize 命中规范键', async () => {
  reset();
  // 只绑 _p3 键：?p=1 不命中（键分离断言）、?p=3 命中
  bind(`bv_${BVID}_p3`, 'youtube', VID);
  let r = await probe(biliApp, `/bilibili/stream?bvid=${BVID}&p=1`);
  assert.equal(r.status, 404, 'p1 键未绑——不回退到 p3 绑定');
  assert.equal(resolveByIdCalls.length, 0);
  r = await probe(biliApp, `/bilibili/stream?bvid=${BVID}&p=3`);
  assert.equal(r.status, 302, '?p=3 → bv_…_p3 键命中（与 buildBilibiliSong id 编码同构）');
  // 小写 bvid 形参 /i 宽形过闸 → canonical 键命中（与 canonManualTrackId
  // 同口径）。绑另一 mediaId 避开上方正档——键带绑定身份，新键必走真解
  repo.deleteManual(`bv_${BVID}_p3`);
  bind(`bv_${BVID}`, 'youtube', 'ZZZZZZZZZZZ');
  resolveByIdCalls.length = 0;
  r = await probe(biliApp, '/bilibili/stream?bvid=bv1xx411c7mD');
  assert.equal(r.status, 302, '小写 bvid canonicalize 到 BV 大写键');
  assert.deepEqual(resolveByIdCalls.map(x => x.mediaId), ['ZZZZZZZZZZZ']);
  repo.deleteManual(`bv_${BVID}`);
});

test('/bilibili/stream kind=video → resolveById 零调用（绑定语义是音源顶替，视频恒自有源）', async () => {
  reset();
  bind(`bv_${BVID}`, 'youtube', VID);
  const r = await probe(biliApp, `/bilibili/stream?bvid=${BVID}&kind=video`);
  assert.equal(r.status, 404);
  assert.match(r.body.message, /avc1/);
  assert.equal(resolveByIdCalls.length, 0, 'kind=video 不穿绑定步');
  repo.deleteManual(`bv_${BVID}`);
});

test('/bilibili/stream 自有源健康+绑定在场 → 302 自有源产物，resolveById 零调用（分水岭补钉）', async () => {
  reset();
  // 专用 bvid 隔离 biliResolveCache——健康产物会写 10min 正档，复用 BVID
  // 会把其它用例的同键「自有源败亡」语义污染成命中
  const ownBvid = 'BV1yy411c7mE';
  bind(`bv_${ownBvid}`, 'youtube', VID);
  biliFetchImpl = async (path) => {
    if (path.includes('/x/web-interface/view')) return VIEW;
    if (path.includes('/x/player/playurl')) return {
      dash: {
        audio: [{
          baseUrl: 'https://upos-sz-m1.bilivideo.com/ugax/own.m4s?sig=OWN_BV',
          bandwidth: 192000, mimeType: 'audio/mp4', codecs: 'mp4a.40.2',
        }],
        video: [],
      },
    };
    throw new Error(`unexpected upstream ${path}`);
  };
  const r = await probe(biliApp, `/bilibili/stream?bvid=${ownBvid}&kind=audio`);
  assert.equal(r.status, 302);
  assert.equal(r.manual, null, '自有源命中不带 manual 头');
  assert.ok(r.urls?.[0]?.includes('sig=OWN_BV'), `302 须指向自有源产物，实际 ${r.urls?.[0]}`);
  assert.equal(resolveByIdCalls.length, 0,
    '自有源健康时绑定休眠——与 /qq/stream 分水岭同律（绑定是失败触发）');
  repo.deleteManual(`bv_${ownBvid}`);
});

// ---------- /youtube/stream ----------

test('/youtube/stream 自有空流 + 跨源绑定（bilibili）→ 302；未绑 → 原 404', async () => {
  reset();
  bind(`yt_${VID}`, 'bilibili', BVID);
  const r = await probe(ytApp, `/youtube/stream?v=${VID}`);
  assert.equal(r.status, 302);
  assert.equal(r.manual, 'bilibili');
  assert.ok(r.urls?.[0]?.includes('BOUND_BV'), '跨源绑定——yt_ 曲绑 BV 同收');
  assert.deepEqual(resolveByIdCalls.map(x => x.mediaId), [BVID]);
  // 未绑同形态 → 原 404 文案
  const r2 = await probe(ytApp, '/youtube/stream?v=UNBOUNDVID1');
  assert.equal(r2.status, 404);
  assert.match(r2.body.message, /没有可代理的音频流/);
  repo.deleteManual(`yt_${VID}`);
});

test('/youtube/stream 自有源健康+绑定在场 → 302 自有源产物，resolveById 零调用（分水岭补钉）', async () => {
  reset();
  // 专用 videoId 隔离 ytResolveCache——健康产物写 10min 正档
  const ownVid = 'OWNVIDEOID1';
  bind(`yt_${ownVid}`, 'bilibili', BVID);
  ytImpl = async () => ({
    streams: [{
      url: 'https://rr1---sn-x.googlevideo.com/v?sig=OWN_YT&itag=140',
      mimeType: 'audio/mp4; codecs="mp4a.40.2"', br: 128000,
    }],
    gated: false,
  });
  const r = await probe(ytApp, `/youtube/stream?v=${ownVid}`);
  assert.equal(r.status, 302);
  assert.equal(r.manual, null, '自有源命中不带 manual 头');
  assert.ok(r.urls?.[0]?.includes('sig=OWN_YT'), `302 须指向自有源产物，实际 ${r.urls?.[0]}`);
  assert.equal(resolveByIdCalls.length, 0,
    '自有源健康时绑定休眠——与 /qq/stream 分水岭同律（绑定是失败触发）');
  repo.deleteManual(`yt_${ownVid}`);
});

// ---------- 手动流缓存 + forgetManualStream ----------

test('手动缓存：绑定曲两连播 resolveById 一次（60s 正档）；死绑定两连播一次（60s 负档）', async () => {
  reset();
  pickImpl = async () => null;
  bind('qq_qqCACHE00007', 'youtube', VID);
  await probe(qqApp, '/qq/stream?mid=qqCACHE00007');
  await probe(qqApp, '/qq/stream?mid=qqCACHE00007');
  assert.equal(resolveByIdCalls.length, 1, '60s 正档——第二发不重解');
  // 负档：绑定 resolveById 抛 → 死绑定期内不重烧上游
  bind('qq_qqCACHE00008', 'youtube', VID);
  ytResolveByIdImpl = async () => { throw new Error('media gone'); };
  resolveByIdCalls.length = 0;
  let r = await probe(qqApp, '/qq/stream?mid=qqCACHE00008');
  assert.equal(r.status, 404);
  r = await probe(qqApp, '/qq/stream?mid=qqCACHE00008');
  assert.equal(r.status, 404);
  assert.equal(resolveByIdCalls.length, 1, '60s 负档——死绑定每次播放不重复烧上游');
  repo.deleteManual('qq_qqCACHE00007');
  repo.deleteManual('qq_qqCACHE00008');
});

test('POST/DELETE 调 forgetManualStream：同媒体重绑后旧负档即刻失效', async () => {
  reset();
  const ip = nextIp();
  pickImpl = async () => null;
  bind('qq_qqFORGET0009', 'youtube', VID);
  // 绑定媒体死 → 负档形成（resolveById null）
  ytResolveByIdImpl = async () => null;
  let r = await probe(qqApp, '/qq/stream?mid=qqFORGET0009');
  assert.equal(r.status, 404);
  assert.equal(resolveByIdCalls.length, 1);
  r = await probe(qqApp, '/qq/stream?mid=qqFORGET0009');
  assert.equal(r.status, 404);
  assert.equal(resolveByIdCalls.length, 1, '负档在场——不重解');
  // 媒体复活 + 同媒体重绑 → POST 落库后 forgetManualStream 清负档
  ytResolveByIdImpl = async () => ({
    url: 'https://rr1---sn-x.googlevideo.com/v?sig=LIVE',
    urls: ['https://rr1---sn-x.googlevideo.com/v?sig=LIVE'], br: 1,
  });
  const pr = await unlockApp.request('http://t/unlock/manual', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ id: 'qq_qqFORGET0009', source: 'youtube', mediaId: VID }),
  });
  assert.equal(pr.status, 200);
  assert.equal(resolveByIdCalls.length, 2, 'POST 验流本身一次 resolveById');
  assert.deepEqual(forgetCalls.sort(), ['bv:qq_qqFORGET0009', 'yt:qq_qqFORGET0009'],
    'POST 落库后 forgetSongUnlock 对前缀 id 安全空调用照旧（facade 不劈叉）');
  r = await probe(qqApp, '/qq/stream?mid=qqFORGET0009');
  assert.equal(r.status, 302, 'forget 收掉负档——重绑即刻生效');
  assert.ok(r.urls?.[0]?.includes('sig=LIVE'));
  assert.equal(resolveByIdCalls.length, 3, 'POST 后即刻重解');
  // DELETE → 清行+forget → 回自有源败亡原路（404）
  const dr = await unlockApp.request(
    `http://t/unlock/manual?id=${encodeURIComponent('qq_qqFORGET0009')}`,
    { method: 'DELETE', headers: { 'x-forwarded-for': ip } });
  assert.equal(dr.status, 200);
  assert.deepEqual(forgetCalls.sort(), [
    'bv:qq_qqFORGET0009', 'bv:qq_qqFORGET0009',
    'yt:qq_qqFORGET0009', 'yt:qq_qqFORGET0009',
  ], 'DELETE 同律调 forgetSongUnlock（POST+DELETE 各一轮）');
  r = await probe(qqApp, '/qq/stream?mid=qqFORGET0009');
  assert.equal(r.status, 404);
  assert.equal(resolveByIdCalls.length, 3, '解绑后 repo 读 null——绑定步不进缓存');
});

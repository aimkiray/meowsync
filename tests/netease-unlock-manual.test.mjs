// 手动媒体源绑定的编排层消费钉板（netease-api.js resolveOne 手动插队步 +
// unblockedManual/unblockedMediaId 下发 + forgetSongUnlock 语义）——
// spec §4 服务端 #7-13。seed 面照抄 netease-unlock-errors.test.mjs
// （net-guard/stream-vault/ai/unlock-index/netease 门面五处）外补
// lib/youtube + youtube-resolve + lib/bilibili 三处（真 provider 的
// resolveById/search 单测依赖它们）；绑定簿 repo 用真身（真库持久化语义
// 桩测不出）。health 用真身 + _resetForTest。
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { seed, tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-ne-unlockmanual-');
const require = createRequire(import.meta.url);

// 公网校验桩可控——私网全拒分支需要它回 false；其余守卫原语用真身
const realGuard = require('../src/server/lib/net-guard.js');
let publicIpImpl = async () => true;
seed('../src/server/lib/net-guard.js', { ...realGuard, resolvesToPublicIp: (...a) => publicIpImpl(...a) });
seed('../src/server/lib/stream-vault.js', { mint: () => 'tok-stub' });
// AI 规整桩——手动步不消费 info，但 resolveOne 的 info 派生支路挂着它
let aiEnabledImpl = () => false;
seed('../src/server/lib/ai.js', {
  aiEnabled: () => aiEnabledImpl(),
  askAiJson: async () => null,
  aiModel: () => 'stub',
});

// provider 桩：resolve/resolveById 可编程、调用序可观测；forgetSong 记账
// （验 forgetSongUnlock 钩面）。resolveById 桩产出的 url 必须过
// normalizeOutboundUrl 真身——用合法 https 公网形（resolvesToPublicIp 桩 true）
const calls = [];
const forgetCalls = [];
let pyncmdImpl = async () => null;
let ytResolveImpl = async () => null;
let bvResolveImpl = async () => null;
let ytResolveByIdImpl = async () => ({
  url: 'https://rr1---sn-x.googlevideo.com/v.mp3?sig=s',
  urls: ['https://rr1---sn-x.googlevideo.com/v.mp3?sig=s'],
  br: 128000, durationSec: null,
});
let bvResolveByIdImpl = async () => ({
  url: 'https://upos-sz-m1.bilivideo.com/ugax/x.m4s?s=1',
  urls: ['https://upos-sz-m1.bilivideo.com/ugax/x.m4s?s=1'],
  br: 192000, durationSec: null,
});
const resolveByIdCtx = []; // resolveById 收到的 ctx（purpose 透传断言面）
seed('../src/server/services/unlock/index.js', {
  PROVIDERS: {
    pyncmd: {
      resolve: async (info, ctx) => { calls.push('pyncmd'); return pyncmdImpl(info, ctx); },
      forgetSong: (id) => { forgetCalls.push(`py:${id}`); },
    },
    youtube: {
      resolve: async (info, ctx) => { calls.push('yt:resolve'); return ytResolveImpl(info, ctx); },
      resolveById: async (mediaId, ctx) => {
        calls.push('yt:resolveById');
        resolveByIdCtx.push({ source: 'youtube', mediaId, ctx });
        return ytResolveByIdImpl(mediaId, ctx);
      },
      forgetSong: (id) => { forgetCalls.push(`yt:${id}`); },
    },
    bilibili: {
      resolve: async (info, ctx) => { calls.push('bv:resolve'); return bvResolveImpl(info, ctx); },
      resolveById: async (mediaId, ctx) => {
        calls.push('bv:resolveById');
        resolveByIdCtx.push({ source: 'bilibili', mediaId, ctx });
        return bvResolveByIdImpl(mediaId, ctx);
      },
      forgetSong: (id) => { forgetCalls.push(`bv:${id}`); },
    },
  },
  PLAYBACK_SOURCES: ['pyncmd', 'youtube', 'bilibili'],
  DOWNLOAD_SOURCES: ['pyncmd', 'youtube', 'bilibili'],
});

// song_detail 桩：dt=200s（时长对账基准），name=n<id>，ar=[a]——
// baseUnlockInfo 派生词 = `n<id> - a`
let songDetailImpl = async (ids) => ({
  body: { songs: ids.map(id => ({ id, dt: 200000, name: `n${id}`, ar: [{ name: 'a' }] })) },
});
seed('../src/server/services/netease/index.js', {
  callNeteaseApi: async (name, params) => {
    if (name === 'song_detail') return songDetailImpl(String(params.ids).split(',').map(Number));
    throw new Error(`unexpected api ${name}`);
  },
  apiModules: {},
});

// ── 真 provider resolveById/search 单测依赖桩（§4 #13）────────────
// 真 unlock/youtube.js 的取流原语 + 搜索原语做成可变桩——seed 必须在
// require provider 之前
let innertubeSearchImpl = async () => [];
let ytStreamsImpl = async () => ({ streams: [] });
seed('../src/server/lib/youtube.js', {
  innertubeSearch: (...a) => innertubeSearchImpl(...a),
});
seed('../src/server/services/youtube-resolve.js', {
  resolveYoutubeStreams: (...a) => ytStreamsImpl(...a),
});
let biliSearchImpl = async () => ({ items: [] });
let biliAudioImpl = async () => [];
seed('../src/server/lib/bilibili.js', {
  biliSearchVideos: (...a) => biliSearchImpl(...a),
  resolveBiliAudio: (...a) => biliAudioImpl(...a),
});

const health = require('../src/server/services/unlock/health.js');
const { resolveSongUrls, forgetSongUnlock } = require('../src/server/services/netease-api.js');
const repo = require('../src/server/repositories/unlockManual.js');
// 真 provider 文件直接 require（绕过 seed 过的 index 门面——provider 自身
// 不 import index.js），其 deps 已全部播种
const ytProvider = require('../src/server/services/unlock/youtube.js');
const bvProvider = require('../src/server/services/unlock/bilibili.js');

const mkItem = (id) => ({ id, url: null, fee: 1, time: 0 });
const bind = (songId, source, mediaId, durationSec = 200) =>
  repo.upsertManual(songId, { source, mediaId, title: `t-${mediaId}`, owner: 'o', durationSec });
// console.info 捕获——时长豁免/失败留痕的行断言（用完须 finally 还原）
const captureInfo = () => {
  const logs = [];
  const orig = console.info;
  console.info = (...a) => logs.push(a.join(' '));
  return { logs, restore: () => { console.info = orig; } };
};

beforeEach(() => {
  health._resetForTest();
  calls.length = 0; forgetCalls.length = 0; resolveByIdCtx.length = 0;
  publicIpImpl = async () => true;
  aiEnabledImpl = () => false;
  pyncmdImpl = async () => null;
  ytResolveImpl = async () => null;
  bvResolveImpl = async () => null;
  ytResolveByIdImpl = async () => ({
    url: 'https://rr1---sn-x.googlevideo.com/v.mp3?sig=s',
    urls: ['https://rr1---sn-x.googlevideo.com/v.mp3?sig=s'],
    br: 128000, durationSec: null,
  });
  bvResolveByIdImpl = async () => ({
    url: 'https://upos-sz-m1.bilivideo.com/ugax/x.m4s?s=1',
    urls: ['https://upos-sz-m1.bilivideo.com/ugax/x.m4s?s=1'],
    br: 192000, durationSec: null,
  });
  songDetailImpl = async (ids) => ({
    body: { songs: ids.map(id => ({ id, dt: 200000, name: `n${id}`, ar: [{ name: 'a' }] })) },
  });
  innertubeSearchImpl = async () => [];
  ytStreamsImpl = async () => ({ streams: [] });
  biliSearchImpl = async () => ({ items: [] });
  biliAudioImpl = async () => [];
});

after(() => {
  rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

// ── §4 #7 位序 ─────────────────────────────────────────────────
test('位序：绑 youtube → 调用序 [pyncmd, resolveById]，搜索 resolve 不被调', async () => {
  bind('501', 'youtube', 'dQw4w9WgXcQ', 200);
  const [it] = await resolveSongUrls([mkItem(501)], {});
  assert.deepEqual(calls, ['pyncmd', 'yt:resolveById'],
    '手动步在 pyncmd 之后、全部搜索源之前插队');
  assert.equal(it.unblocked, true);
  assert.equal(it.unblockedSource, 'youtube', 'resolved.source 落绑定源名');
  assert.equal(it.unblockedManual, true);
  assert.equal(it.unblockedMediaId, 'dQw4w9WgXcQ');
  assert.equal(it.url, 'https://rr1---sn-x.googlevideo.com/v.mp3?sig=s');
  repo.deleteManual('501');
});

test('位序：绑 bilibili → resolveById 压过前位搜索源 youtube', async () => {
  bind('502', 'bilibili', 'BV1xx411c7mD', 200);
  const [it] = await resolveSongUrls([mkItem(502)], {});
  assert.deepEqual(calls, ['pyncmd', 'bv:resolveById'],
    '绑定源是 bilibili 时手动步仍抢在 youtube 自动链之前——'
    + '绑 bv 的场景恰是 yt 自动链错配在先，放绑定源槽位会被前位抢先');
  assert.equal(it.unblockedSource, 'bilibili');
  assert.equal(it.unblockedManual, true);
  assert.equal(it.unblockedMediaId, 'BV1xx411c7mD');
  assert.ok(!calls.includes('yt:resolve'), 'youtube 搜索源不得先跑');
  repo.deleteManual('502');
});

test('位序：pyncmd 官方直解成功 → resolveById 与搜索源均不触', async () => {
  bind('503', 'youtube', 'dQw4w9WgXcQ', 200);
  pyncmdImpl = async (info) => ({
    url: `https://m701.music.126.net/${info.id}.mp3`, br: 320000, durationSec: 200,
  });
  const [it] = await resolveSongUrls([mkItem(503)], {});
  assert.deepEqual(calls, ['pyncmd'],
    'pyncmd 零错配官方直解优先——手动纠错不该压过官方源');
  assert.equal(it.unblockedSource, 'pyncmd');
  assert.equal(it.unblockedManual, undefined, '非手动命中不挂标记');
  repo.deleteManual('503');
});

// ── §4 #8 回落 ─────────────────────────────────────────────────
test('回落：resolveById 回 null → 自动链接管，errors[0] 带 manual:true + 前缀 + nomatch', async () => {
  bind('504', 'youtube', 'dQw4w9WgXcQ', 200);
  ytResolveByIdImpl = async () => null;
  ytResolveImpl = async () => ({
    url: 'https://rr2---sn-x.googlevideo.com/auto.mp3', br: 128000, durationSec: 200,
  });
  const [it] = await resolveSongUrls([mkItem(504)], {});
  assert.deepEqual(calls, ['pyncmd', 'yt:resolveById', 'yt:resolve'],
    '手动步失败回落剩余自动链——含被绑源自身搜索');
  assert.equal(it.unblocked, true, '自动链接管成功');
  assert.equal(it.unblockedSource, 'youtube');
  assert.equal(it.unblockedManual, undefined, '自动命中不挂手动标记');
  // errors[0] 是 pyncmd「源未产出候选」——手动归因须 find 而非按下标
  const manualErr = it.unlockErrors.find(e => e.manual === true);
  assert.ok(manualErr, '手动失败须留 manual:true 归因');
  assert.equal(manualErr.source, 'youtube');
  assert.ok(manualErr.msg.startsWith('手动绑定媒体：'),
    `msg 须以「手动绑定媒体：」前缀，实得: ${manualErr.msg}`);
  assert.equal(manualErr.cls, 'nomatch');
  // 绑定保留——一次失败不该毁绑
  assert.ok(repo.getManual('504'), '绑定行在失败后必须保留');
  repo.deleteManual('504');
});

test('回落：resolveById 抛错 → msg 前缀「手动绑定媒体：」，msg 单行化', async () => {
  bind('505', 'youtube', 'dQw4w9WgXcQ', 200);
  ytResolveByIdImpl = async () => { throw new Error('取流失败\n第二行'); };
  const [it] = await resolveSongUrls([mkItem(505)], {});
  assert.equal(it.unlockFailed, true, '自动链也全灭（桩全 null）');
  const manualErr = it.unlockErrors.find(e => e.manual === true);
  assert.ok(manualErr, '须有一条 manual:true 归因');
  assert.ok(manualErr.msg.startsWith('手动绑定媒体：'));
  assert.equal(manualErr.source, 'youtube');
  assert.ok(!manualErr.msg.includes('\n'), 'msg 单行剥 \\n 同口径');
  repo.deleteManual('505');
});

// ── §4 #9 时长豁免 ──────────────────────────────────────────────
test('时长豁免：绑定行 400s vs originalDt 200s → 手动步放行，time=400000 + 留痕；自动步同偏差会被杀', async () => {
  bind('506', 'youtube', 'lOgNgRYSvHQ', 400);
  const cap = captureInfo();
  let it;
  try {
    [it] = await resolveSongUrls([mkItem(506)], {});
  } finally { cap.restore(); }
  assert.equal(it.unblocked, true, '手动步时长偏离也放行——用户是更高终审');
  assert.equal(it.time, 400000, 'resolved.timeMs 如实落绑定媒体时长');
  assert.equal(it.unblockedManual, true);
  assert.ok(cap.logs.some(l => l.includes('手动绑定媒体时长偏离') && l.includes('放行')),
    `时长豁免须 console.info 留痕，实得: ${JSON.stringify(cap.logs)}`);
  repo.deleteManual('506');
  // 对照组：自动步同偏差会被时长墙 continue 杀掉
  ytResolveImpl = async () => ({
    url: 'https://rr9---sn-x.googlevideo.com/long.mp3', br: 128000, durationSec: 400,
  });
  const [it2] = await resolveSongUrls([mkItem(507)], {});
  assert.equal(it2.unlockFailed, true, '自动步 400s vs 200s 超 0.4 容差 → continue');
  assert.ok(it2.unlockErrors.some(e => e.source === 'youtube' && e.msg.includes('时长校验不符')));
});

// ── §4 #10 熔断 ────────────────────────────────────────────────
test('熔断：youtube 盖章窗内绑 youtube → breaker 跳过（resolveById 零调用）', async () => {
  health.noteAuthRejected('youtube');
  health.noteAuthRejected('youtube'); // 到阈盖章
  assert.equal(health.isOpen('youtube'), true);
  bind('508', 'youtube', 'dQw4w9WgXcQ', 200);
  bvResolveImpl = async () => ({
    url: 'https://upos-sz-m1.bilivideo.com/ugax/auto.m4s?s=1', br: 192000, durationSec: 200,
  });
  const [it] = await resolveSongUrls([mkItem(508)], {});
  assert.ok(!calls.includes('yt:resolveById'), '熔断窗内 resolveById 不得真跑');
  assert.ok(!calls.includes('yt:resolve'), '被绑源的自动步同样撞墙');
  const manualErr = it.unlockErrors.find(e => e.manual === true);
  assert.ok(manualErr, '手动步撞墙须留 manual:true 归因');
  assert.equal(manualErr.cls, 'breaker');
  assert.ok(manualErr.msg.includes('（手动绑定）'), `breaker msg 须注「（手动绑定）」，实得: ${manualErr.msg}`);
  assert.equal(manualErr.source, 'youtube');
  repo.deleteManual('508');
});

test('DB 故障面：getManual 抛错 → 按无绑定放行，自动链照常', async () => {
  bind('509', 'youtube', 'dQw4w9WgXcQ', 200);
  const orig = repo.getManual;
  repo.getManual = () => { throw new Error('db down'); };
  try {
    ytResolveImpl = async () => ({
      url: 'https://rr3---sn-x.googlevideo.com/auto.mp3', br: 128000, durationSec: 200,
    });
    const [it] = await resolveSongUrls([mkItem('509')], {});
    assert.deepEqual(calls, ['pyncmd', 'yt:resolve'],
      '库不可用按无绑定放行——手动步缺席，自动链照常');
    assert.equal(it.unblocked, true);
    assert.equal(it.unblockedManual, undefined);
  } finally {
    repo.getManual = orig;
  }
  repo.deleteManual('509');
});

// ── R1-N6 补断言：手动步健康记账（对绑定源名记账）────────────────
test('健康记账：手动步 authRejected 计 noteAuthRejected 连败、成功计 noteSourceOk 回春', async () => {
  // 手动步 authRejected：cls='authwall' 且 err 无 authCounted 标记 →
  // noteAuthRejected 对绑定源名计一败——预置一败后本次到阈盖章为证
  bind('512', 'youtube', 'dQw4w9WgXcQ', 200);
  const wall = new Error('Innertube LOGIN_REQUIRED'); wall.authRejected = true;
  ytResolveByIdImpl = async () => { throw wall; };
  health.noteAuthRejected('youtube'); // 预置一败（未到阈不盖章）
  const [it] = await resolveSongUrls([mkItem(512)], {});
  assert.equal(health.isOpen('youtube'), true,
    '手动步 authRejected 须计 noteAuthRejected——预置1+本次1 到阈盖章');
  const manualErr = it.unlockErrors.find(e => e.manual === true);
  assert.ok(manualErr, '手动失败须留 manual:true 归因');
  assert.equal(manualErr.cls, 'authwall');
  repo.deleteManual('512');

  // 手动步成功 → noteSourceOk 清连败：预置一败 + 成功 + 再败一发仍不
  // 该盖章（若成功步没清，streak 累计到阈会盖——反证记账缺失）
  health._resetForTest();
  bind('513', 'youtube', 'dQw4w9WgXcQ', 200);
  health.noteAuthRejected('youtube'); // 预置一败
  ytResolveByIdImpl = async () => ({   // 恢复成功产出（同 beforeEach 默认形）
    url: 'https://rr1---sn-x.googlevideo.com/v.mp3?sig=s',
    urls: ['https://rr1---sn-x.googlevideo.com/v.mp3?sig=s'],
    br: 128000, durationSec: null,
  });
  const [it2] = await resolveSongUrls([mkItem(513)], {});
  assert.equal(it2.unblockedManual, true, '手动步成功落绑定标记');
  // 清缓存重解（绑定仍在）+ 手动步败一发——streak 已被成功步清零，
  // 这发只有 1 败不到阈，不该盖章
  forgetSongUnlock('513');
  ytResolveByIdImpl = async () => { throw wall; };
  await resolveSongUrls([mkItem(513)], {});
  assert.equal(health.isOpen('youtube'), false,
    '成功步须 noteSourceOk 清连败——再败一发 streak=1 未到阈');
  repo.deleteManual('513');
});

// ── §4 #11 缓存/清理 ────────────────────────────────────────────
test('缓存/清理：绑定命中进 60s 缓存；forgetSongUnlock 后重解回源；解绑+forget 后自动链恢复', async () => {
  bind('510', 'youtube', 'dQw4w9WgXcQ', 200);
  await resolveSongUrls([mkItem(510)], {});
  assert.deepEqual(calls, ['pyncmd', 'yt:resolveById']);
  calls.length = 0;
  const [cached] = await resolveSongUrls([mkItem(510)], {});
  assert.equal(calls.length, 0, '60s 缓存窗内第二发不回源');
  // 缓存命中路径同转写诊断字段——resolved.manual/mediaId 随缓存对象下发，
  // 命中不重解也要如实标出「手动绑定命中」（R1-N6 补断言）
  assert.equal(cached.unblocked, true);
  assert.equal(cached.unblockedSource, 'youtube');
  assert.equal(cached.unblockedManual, true, '缓存命中须同转写 unblockedManual');
  assert.equal(cached.unblockedMediaId, 'dQw4w9WgXcQ', '缓存命中须同转写 unblockedMediaId');
  // forgetSongUnlock 清缓存 → 重解必须真回源
  forgetSongUnlock('510');
  assert.deepEqual(forgetCalls.sort(), ['bv:510', 'py:510', 'yt:510'],
    'provider forgetSong 钩全叫到');
  await resolveSongUrls([mkItem(510)], {});
  assert.deepEqual(calls, ['pyncmd', 'yt:resolveById'], 'forget 后重解回源');
  // 解绑 + forget → 自动链恢复消费（resolve 被调）
  repo.deleteManual('510');
  forgetCalls.length = 0;
  forgetSongUnlock('510');
  calls.length = 0;
  ytResolveImpl = async () => ({
    url: 'https://rr4---sn-x.googlevideo.com/auto.mp3', br: 128000, durationSec: 200,
  });
  const [it] = await resolveSongUrls([mkItem(510)], {});
  assert.deepEqual(calls, ['pyncmd', 'yt:resolve'], '解绑后自动链恢复');
  assert.equal(it.unblocked, true);
  assert.equal(it.unblockedManual, undefined);
  assert.equal(it.unblockedMediaId, undefined);
});

// ── §4 #12 download purpose ────────────────────────────────────
test('download：purpose 透传给 resolveById 且绑定生效（DOWNLOAD_SOURCES 同享）', async () => {
  bind('511', 'bilibili', 'BV1xx411c7mD', 200);
  const [it] = await resolveSongUrls([mkItem(511)], { purpose: 'download' });
  assert.deepEqual(calls, ['pyncmd', 'bv:resolveById']);
  assert.equal(resolveByIdCtx.length, 1);
  assert.equal(resolveByIdCtx[0].source, 'bilibili');
  assert.equal(resolveByIdCtx[0].mediaId, 'BV1xx411c7mD');
  assert.equal(resolveByIdCtx[0].ctx.purpose, 'download', 'purpose 必须透传给 resolveById');
  assert.equal(it.unblocked, true);
  assert.equal(it.unblockedSource, 'bilibili');
  assert.equal(it.unblockedManual, true);
  assert.equal(it.unblockedMediaId, 'BV1xx411c7mD');
  repo.deleteManual('511');
});

// ── §4 #13 真 provider resolveById/search 单测 ─────────────────
test('resolveById 单测 youtube：形闸前置 null / streams[0] 映射 {url,urls,br,durationSec:null} / prefer 透传', async () => {
  // 形闸前置——非法 videoId 直回 null 不烧上游
  for (const bad of ['short', 'BV1xx411c7mD', 'dQw4w9WgXcQ junk', 'https://youtu.be/x']) {
    assert.equal(await ytProvider.resolveById(bad, {}), null, `bad=${bad}`);
  }
  let seen = null;
  ytStreamsImpl = async (videoId, opts) => {
    seen = { videoId, opts };
    return { streams: [{ url: 'u1', br: 128000 }, { url: 'u2', br: 64000 }] };
  };
  const r = await ytProvider.resolveById('dQw4w9WgXcQ', { purpose: 'playback' });
  assert.deepEqual(r, { url: 'u1', urls: ['u1'], br: 128000, durationSec: null },
    '首流映射——跨档候选是不同字节实体只下发首链');
  assert.equal(seen.videoId, 'dQw4w9WgXcQ');
  assert.equal(seen.opts.kind, 'audio');
  assert.equal(seen.opts.prefer, '', 'playback 档 prefer 空');
  assert.ok(seen.opts.signal instanceof AbortSignal, '30s 子预算合流 signal');
  // download → prefer='best'
  await ytProvider.resolveById('dQw4w9WgXcQ', { purpose: 'download' });
  assert.equal(seen.opts.prefer, 'best');
  // 无流 → null
  ytStreamsImpl = async () => ({ streams: [] });
  assert.equal(await ytProvider.resolveById('dQw4w9WgXcQ', {}), null);
  // authRejected 裸抛透出（路由/编排层分类消费）
  const wall = new Error('LOGIN_REQUIRED'); wall.authRejected = true;
  ytStreamsImpl = async () => { throw wall; };
  const e = await ytProvider.resolveById('dQw4w9WgXcQ', {}).then(() => null, (x) => x);
  assert.equal(e, wall, 'authRejected 须裸抛透出');
});

test('resolveById 单测 bilibili：形闸 / 空轨 null / playback 提 audio/mp4 头 / download 首项 / ext 下发 / 镜像组', async () => {
  for (const bad of ['dQw4w9WgXcQ', 'BVxx', 'av170001', 'https://b23.tv/x']) {
    assert.equal(await bvProvider.resolveById(bad, {}), null, `bad=${bad}`);
  }
  // 空轨 → null
  biliAudioImpl = async () => [];
  assert.equal(await bvProvider.resolveById('BV1xx411c7mD', {}), null);
  // 多档摊平：flac(best) + mp4 同档镜像 + mp4 低码率——
  // playback 提首个 audio/mp4 档作头、同 pathname 镜像成组、ext=m4a
  const cands = [
    { url: 'https://upos.bilivideo.com/ugax/x-flac.flac?s=1', mimeType: 'audio/flac', br: 900000 },
    { url: 'https://upos.bilivideo.com/ugax/x-30280.m4s?s=1', mimeType: 'audio/mp4', br: 192000 },
    { url: 'https://upos-sz-m2.bilivideo.com/ugax/x-30280.m4s?s=2', mimeType: 'audio/mp4', br: 192000 },
    { url: 'https://upos.bilivideo.com/ugax/x-30232.m4s?s=1', mimeType: 'audio/mp4', br: 108000 },
  ];
  biliAudioImpl = async () => cands;
  const play = await bvProvider.resolveById('BV1xx411c7mD', { purpose: 'playback' });
  assert.equal(play.url, 'https://upos.bilivideo.com/ugax/x-30280.m4s?s=1',
    'playback 跳过 flac 选 audio/mp4 档头——Safari/旧浏览器放不了 flac');
  assert.deepEqual(play.urls, [
    'https://upos.bilivideo.com/ugax/x-30280.m4s?s=1',
    'https://upos-sz-m2.bilivideo.com/ugax/x-30280.m4s?s=2',
  ], '同字节镜像组——跨档（30232）绝不混入');
  assert.equal(play.br, 192000);
  assert.equal(play.durationSec, null);
  assert.equal(play.ext, 'm4a', 'audio/mp4 轨 → m4a 显式下发（.m4s 走 extOf 会错落 mp3 壳）');
  const dl = await bvProvider.resolveById('BV1xx411c7mD', { purpose: 'download' });
  assert.equal(dl.url, 'https://upos.bilivideo.com/ugax/x-flac.flac?s=1',
    'download 保 best 首项——无损优先是归档语义');
  assert.equal(dl.ext, 'flac');
  // 风控判定照旧抛（不吞成 null）
  biliAudioImpl = async () => { throw new Error('bilibili playurl HTTP 412'); };
  const e = await bvProvider.resolveById('BV1xx411c7mD', {}).then(() => null, (x) => x);
  assert.match(String(e?.message), /HTTP 412/, '风控错须透出');
});

test('provider search 单测：youtube mqdefault 封面推导 + 位置形 limit=8；bilibili 归一去重 + pic 封面', async () => {
  let searchArgs = null;
  innertubeSearchImpl = async (...a) => {
    searchArgs = a;
    return [
      { videoId: 'dQw4w9WgXcQ', title: 't1', owner: 'o1', durationSec: 200, publishedTimeText: '3 年前' },
      { videoId: 'abc123def45', title: 't2', owner: 'o2', durationSec: null },
    ];
  };
  const yt = await ytProvider.search('测试词', { signal: null });
  // 位置形调用（keyword, signal, limit）与 resolve 内 L41/L49 同式；手动池放宽到 8
  assert.equal(searchArgs[0], '测试词');
  assert.equal(searchArgs[2], 8, '手动池截断 8——自动链 5 条截断正是漏真命候选来源');
  assert.equal(yt[0].cover, 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg',
    'cover 由 videoId 确定性推导零上行');
  assert.equal(yt[0].publishedTimeText, '3 年前');
  // bilibili：biliSearchVideos → normalizeCands（去重/滤脏行/截8）→ cover=pic
  biliSearchImpl = async (q) => {
    searchArgs = [q];
    return {
      items: [
        { bvid: 'BV1aa', title: 'a', author: 'x', durationSec: 200, pic: 'https://i0.hdslb.com/a.jpg' },
        { bvid: 'BV1aa', title: 'dup', author: 'x', durationSec: 1, pic: '' },        // 重复 bvid 去重
        { bvid: '', title: 'nobvid' },                                                 // 脏行滤掉
        { bvid: 'BV1bb', title: 'b', author: 'y', durationSec: 0, pic: 'https://i0.hdslb.com/b.jpg' },
      ],
    };
  };
  const bv = await bvProvider.search('测试词', {});
  assert.equal(searchArgs[0], '测试词');
  assert.equal(bv.length, 2);
  assert.equal(bv[0].videoId, 'BV1aa');
  assert.equal(bv[0].cover, 'https://i0.hdslb.com/a.jpg', 'cover 取归一行 pic（已补 https:）');
  assert.equal(bv[1].videoId, 'BV1bb');
  // 搜索段失败包 asTransientErr——412 归 transient 口径
  biliSearchImpl = async () => { throw new Error('bilibili search HTTP 412'); };
  const e = await bvProvider.search('x', {}).then(() => null, (x) => x);
  assert.match(String(e?.message), /HTTP 429/, '风控搜索失败须带 transient 等价标记');
});

// F1 resolveTrackUnlock 共享链 + F2 qqUnlockInfo 伪行装配 + QQ_UNLOCK_SOURCES
// 钉板（canonical §2/§12 首行 8 断言）：
//   ① 键域隔离（qq_ vs 数字、px/direct 段、skipCache 语义）
//   ② includeManual:false → getManual 零调用、手动步缺席
//   ③ sources 显传序（pyncmd 被调即炸——永不在 qq_ 集）
//   ④ buildInfo 惰性（缓存命中/搭车不触）
//   ⑤ 全灭 → {resolved:null, errors cls 齐}
//   ⑥ resolved.mediaId 加性透传
//   ⑦ 调用方 abort 不杀共享链（搭车者拿产物）
//   ⑧ forgetSongUnlock('qq_x') → provider forgetSong 收 'qq_x'
// seed 面照抄 netease-inflight/unlock-errors（net-guard/stream-vault/ai/
// unlock/index.js/netease 门面），外加 unlockManual repo 与 lib/qq 两处——
// 前者计 getManual 调用、后者计 getSongDetail 调用
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { seed, tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-ext-unlock-');
const require = createRequire(import.meta.url);

// 公网校验桩可控——其余守卫原语（normalizeOutboundUrl/isProxyAllowedHost）
// 用真身：proxied 语境的白名单预筛是本用例要钉的真路径
const realGuard = require('../src/server/lib/net-guard.js');
let publicIpImpl = async () => true;
seed('../src/server/lib/net-guard.js', { ...realGuard, resolvesToPublicIp: (...a) => publicIpImpl(...a) });
seed('../src/server/lib/stream-vault.js', { mint: () => 'tok-stub' });
let aiEnabledImpl = () => false;
let askAiJsonImpl = async () => null;
let aiCalls = 0;
seed('../src/server/lib/ai.js', {
  aiEnabled: () => aiEnabledImpl(),
  askAiJson: async (...a) => { aiCalls++; return askAiJsonImpl(...a); },
  aiModel: () => 'stub',
});

// QQ_UNLOCK_SOURCES 真值钉板：seed 前先取真模块引用——seed 只换 require.cache
// 键，已取到的引用仍指真身
const realUnlockIndex = require('../src/server/services/unlock/index.js');

// provider 桩：resolve 记账「源:id」序（显传序断言）；pyncmd 若被 qq_ 链触达
// 即炸——它是「网易数值 id→126 CDN」直解器，对 qq_<mid> 无语义
// （[canonical:QQ-UNLOCK-ORDER]）
const callOrder = [];
const byIdCalls = [];
const forgetCalls = [];
const impls = {};
const stubProvider = (name) => ({
  resolve: async (info, ctx) => {
    callOrder.push(`${name}:${info.id}`);
    if (name === 'pyncmd') throw new Error('pyncmd 对 qq_<mid> 无语义——不得入链');
    return impls[name] ? impls[name](info, ctx) : null;
  },
  resolveById: async (mediaId) => {
    byIdCalls.push(`${name}:${mediaId}`);
    return { url: 'https://upos-sz-m1.bilivideo.com/bind.m4a', br: 192000, durationSec: 200 };
  },
  forgetSong: (id) => { forgetCalls.push(`${name}:${id}`); },
});
seed('../src/server/services/unlock/index.js', {
  PROVIDERS: {
    pyncmd: stubProvider('pyncmd'),
    youtube: stubProvider('youtube'),
    bilibili: stubProvider('bilibili'),
  },
  PLAYBACK_SOURCES: ['pyncmd', 'youtube', 'bilibili'],
  DOWNLOAD_SOURCES: ['pyncmd', 'youtube', 'bilibili'],
});

// 手动绑定簿桩：getManual 调用记账——includeManual:false 必须零调用
let manualRow = null;
const getManualCalls = [];
seed('../src/server/repositories/unlockManual.js', {
  getManual: (id) => { getManualCalls.push(String(id)); return manualRow; },
  upsertManual: () => {},
  deleteManual: () => {},
});

// lib/qq 桩：qqUnlockInfo detail 径计 getSongDetail 调用（快照径必须零上行）
const detailCalls = [];
let detailImpl = async () => ({
  name: '歌名', artists: ['歌手甲', '歌手乙'], album: '专辑', intervalSec: 200,
});
seed('../src/server/lib/qq.js', {
  getSongDetail: async (mid, signal, hint) => { detailCalls.push(mid); return detailImpl(mid, signal, hint); },
});

seed('../src/server/services/netease/index.js', {
  callNeteaseApi: async (name) => { throw new Error(`unexpected api ${name}`); },
  apiModules: {},
});

const health = require('../src/server/services/unlock/health.js');
const { resolveTrackUnlock, qqUnlockInfo, forgetSongUnlock } = require('../src/server/services/netease-api.js');

const mkInfo = (id) => ({ id, name: 'n', artists: ['a'], keyword: 'n - a', durationMs: 200000 });

beforeEach(() => {
  health._resetForTest();
  callOrder.length = 0; byIdCalls.length = 0; forgetCalls.length = 0;
  getManualCalls.length = 0; detailCalls.length = 0; aiCalls = 0;
  manualRow = null;
  aiEnabledImpl = () => false; askAiJsonImpl = async () => null; publicIpImpl = async () => true;
  impls.youtube = async () => null;
  impls.bilibili = async () => null;
  detailImpl = async () => ({ name: '歌名', artists: ['歌手甲', '歌手乙'], album: '专辑', intervalSec: 200 });
});

// ① 键域隔离：qq_<mid> 与数字 id 各走各键；proxied 位进缓存键 px/direct 段；
// skipCache 只旁路正档读——治愈写照常落（下一发常规读直接命中）
test('键域隔离：qq_ vs 数字键、px/direct 分段、skipCache 旁路读不改写/合流', async () => {
  impls.youtube = async (info) => ({
    url: `https://upos-sz-m1.bilivideo.com/${encodeURIComponent(info.id)}.m4a`,
    br: 128000, durationSec: 200,
  });
  const r1 = await resolveTrackUnlock('qq_k1', {
    sources: ['youtube'], proxied: true, info: mkInfo('qq_k1'), originalDt: 200000,
  });
  assert.equal(r1.cached, false);
  assert.equal(r1.shared, false);
  assert.equal(r1.resolved.source, 'youtube');
  // 同键第二发——60s 正档命中，provider 不回源
  const r2 = await resolveTrackUnlock('qq_k1', {
    sources: ['youtube'], proxied: true, info: mkInfo('qq_k1'), originalDt: 200000,
  });
  assert.equal(r2.cached, true);
  assert.equal(callOrder.length, 1);
  // direct 语境与 px 语境不同键——不带代理预筛的读不得消费白名单筛过的集合
  const r3 = await resolveTrackUnlock('qq_k1', {
    sources: ['youtube'], proxied: false, info: mkInfo('qq_k1'), originalDt: 200000,
  });
  assert.equal(r3.cached, false, 'direct 段与 px 段键不同——不得读 px 档');
  // 数字 id 与 qq_ 键互不相见（[canonical:ID-PASSTHROUGH] 原值直通）
  const r4 = await resolveTrackUnlock(12345, {
    sources: ['youtube'], proxied: false, info: mkInfo(12345), originalDt: 200000,
  });
  assert.equal(r4.cached, false);
  assert.equal(callOrder.filter(c => c === 'youtube:qq_k1').length, 2);
  assert.equal(callOrder.filter(c => c === 'youtube:12345').length, 1);
  // skipCache 旁路正档读——但产物照常落档：下一发常规读命中不重解
  const r5 = await resolveTrackUnlock('qq_k1', {
    sources: ['youtube'], proxied: false, info: mkInfo('qq_k1'),
    originalDt: 200000, skipCache: true,
  });
  assert.equal(r5.cached, false, 'skipCache 不得读正档');
  assert.equal(callOrder.filter(c => c === 'youtube:qq_k1').length, 3, 'skipCache 重跑实链');
  const r6 = await resolveTrackUnlock('qq_k1', {
    sources: ['youtube'], proxied: false, info: mkInfo('qq_k1'), originalDt: 200000,
  });
  assert.equal(r6.cached, true, 'skipCache 产物照常落档被常规读消费');
  assert.equal(callOrder.filter(c => c === 'youtube:qq_k1').length, 3);
});

// ② includeManual:false → unlockManualRepo.getManual 零调用、'manual' 虚拟步
// 缺席（[canonical:MANUAL-ONCE]——qq_ 绑定由外层腿专职消费）；对照默认
// true：getManual 读 + 手动步插在首个具 resolveById 源之前胜出
test('includeManual:false → getManual 零调用、手动步缺席；true → 绑定插入', async () => {
  manualRow = { source: 'youtube', mediaId: 'yt_bind1', durationSec: 200 };
  impls.bilibili = async () => ({ url: 'https://upos-sz-m1.bilivideo.com/m1.m4a', br: 192000, durationSec: 200 });
  const r = await resolveTrackUnlock('qq_m1', {
    sources: ['youtube', 'bilibili'], includeManual: false,
    info: mkInfo('qq_m1'), originalDt: 200000,
  });
  assert.deepEqual(getManualCalls, [], 'includeManual:false 连 repo 读都跳过');
  assert.deepEqual(byIdCalls, [], '手动步缺席——resolveById 不得被调');
  assert.deepEqual(callOrder, ['youtube:qq_m1', 'bilibili:qq_m1'], 'steps 即显传 sources，无 manual 插队');
  assert.equal(r.resolved.source, 'bilibili');
  assert.equal(r.resolved.manual, undefined);

  const r2 = await resolveTrackUnlock('qq_m2', {
    sources: ['youtube', 'bilibili'], // includeManual 默认 true
    info: mkInfo('qq_m2'), originalDt: 200000,
  });
  assert.deepEqual(getManualCalls, ['qq_m2'], 'getManual 收 String(trackId) 原值');
  assert.deepEqual(byIdCalls, ['youtube:yt_bind1'], '手动步点名直解绑定媒体');
  assert.equal(r2.resolved.source, 'youtube');
  assert.equal(r2.resolved.manual, true);
  assert.equal(r2.resolved.mediaId, 'yt_bind1');
  // 自动步不该再跑——手动步在 youtube 槽位前已胜出
  assert.ok(!callOrder.some(c => c.endsWith(':qq_m2')), '手动步胜出后自动链不跑');
});

// ③ sources 显传序：['bilibili','youtube'] 按序跑；QQ_UNLOCK_SOURCES 真值
// 恒 ['youtube','bilibili']——pyncmd 被调即炸（stub resolve 内 throw）
test('sources 显传序逐字生效；pyncmd 永不入 qq_ 集', async () => {
  impls.bilibili = async () => { throw new Error('bv HTTP 503'); };
  impls.youtube = async (info) => ({
    url: `https://upos-sz-m1.bilivideo.com/${encodeURIComponent(info.id)}.m4a`,
    br: 128000, durationSec: 200,
  });
  const r = await resolveTrackUnlock('qq_s1', {
    sources: ['bilibili', 'youtube'], // 显传倒序——集序必须按传参而非默认表
    info: mkInfo('qq_s1'), originalDt: 200000,
  });
  assert.deepEqual(callOrder, ['bilibili:qq_s1', 'youtube:qq_s1']);
  assert.equal(r.resolved.source, 'youtube');
  // 前序源失败留痕随成功结果下发
  assert.deepEqual(r.errors, [{ source: 'bilibili', msg: 'bv HTTP 503', cls: 'transient' }]);
  assert.ok(!callOrder.some(c => c.startsWith('pyncmd:')),
    'pyncmd 对 qq_ 无语义——若被调 stub 已炸并留痕');

  // info 缺席时 provider 收到 {id: trackId, keyword:''} 回落——qq_<mid> 原值直通
  impls.youtube = async () => null;
  const r2 = await resolveTrackUnlock('qq_s2', { sources: ['youtube'], originalDt: 200000 });
  assert.equal(r2.resolved, null, 'info=null → keyword 空，源回 null 按 nomatch 全灭');
  assert.deepEqual(callOrder.at(-1), 'youtube:qq_s2');
  assert.deepEqual(r2.errors, [{ source: 'youtube', msg: '源未产出候选', cls: 'nomatch' }]);

  // QQ_UNLOCK_SOURCES 真值钉板（seed 前取到的真模块引用）
  assert.deepEqual(realUnlockIndex.QQ_UNLOCK_SOURCES, ['youtube', 'bilibili']);
  assert.ok(!realUnlockIndex.QQ_UNLOCK_SOURCES.includes('pyncmd'));
});

// ④ buildInfo 惰性：仅「新链实跑」被调——缓存命中与 inflight 搭车者均不触发
//（播放腿 detail 不白打：qqUnlockInfo 上行只在链真跑时发生）
test('buildInfo 惰性：缓存命中/搭车者均不触发', async () => {
  impls.youtube = async () => ({
    url: 'https://upos-sz-m1.bilivideo.com/b1.m4a', br: 128000, durationSec: 200,
  });
  let builds = 0;
  const buildInfo = async () => { builds++; return mkInfo('qq_b1'); };
  const r1 = await resolveTrackUnlock('qq_b1', {
    sources: ['youtube'], proxied: true, buildInfo, originalDt: 200000,
  });
  assert.equal(r1.resolved.source, 'youtube');
  assert.equal(builds, 1, '新链实跑装配一次');
  const r2 = await resolveTrackUnlock('qq_b1', {
    sources: ['youtube'], proxied: true, buildInfo, originalDt: 200000,
  });
  assert.equal(r2.cached, true);
  assert.equal(builds, 1, '缓存命中不得触发 buildInfo');

  // 搭车者：链在途时第二发同键调用共享 gate——它的 buildInfo 永不触发
  let release; const gate = new Promise(r => { release = r; });
  impls.youtube = async () => {
    await gate;
    return { url: 'https://upos-sz-m1.bilivideo.com/b2.m4a', br: 128000, durationSec: 200 };
  };
  let builds1 = 0; let builds2 = 0;
  const p1 = resolveTrackUnlock('qq_b2', {
    sources: ['youtube'], originalDt: 200000,
    buildInfo: async () => { builds1++; return mkInfo('qq_b2'); },
  });
  const p2 = resolveTrackUnlock('qq_b2', {
    sources: ['youtube'], originalDt: 200000,
    buildInfo: async () => { builds2++; return mkInfo('qq_b2'); },
  });
  await new Promise(r => setTimeout(r, 30)); // 等 p2 挂上 inflight
  release();
  const [o1, o2] = await Promise.all([p1, p2]);
  assert.equal(o2.shared, true, '第二发同键调用应搭车');
  assert.equal(builds1, 1);
  assert.equal(builds2, 0, '搭车者 buildInfo 不触发');
  assert.equal(o1.resolved.url, o2.resolved.url);
});

// ⑤ 全灭：resolved=null 且 errors 逐源 cls 归位——transient/nomatch/breaker/
// authwall 全齐（终错归因面：下载腿 cls→fatal 分档与端点 502 文案消费它）
test('全灭 → {resolved:null, errors 逐源 cls 齐}', async () => {
  impls.youtube = async () => { throw new Error('yt HTTP 503'); };
  impls.bilibili = async () => null;
  const r = await resolveTrackUnlock('qq_e1', {
    sources: ['youtube', 'bilibili'], info: mkInfo('qq_e1'), originalDt: 200000,
  });
  assert.equal(r.resolved, null);
  assert.deepEqual(r.errors, [
    { source: 'youtube', msg: 'yt HTTP 503', cls: 'transient' },
    { source: 'bilibili', msg: '源未产出候选', cls: 'nomatch' },
  ]);
  assert.equal(r.cached, false);
  assert.equal(r.shared, false);

  // 熔断源整跳（breaker）+ 凭据被拒（authwall）
  health.noteAuthRejected('youtube');
  health.noteAuthRejected('youtube'); // 连败到阈盖章
  const e2 = new Error('Innertube LOGIN_REQUIRED'); e2.authRejected = true;
  impls.bilibili = async () => { throw e2; };
  const r2 = await resolveTrackUnlock('qq_e2', {
    sources: ['youtube', 'bilibili'], info: mkInfo('qq_e2'), originalDt: 200000,
  });
  assert.equal(r2.resolved, null);
  assert.equal(r2.errors[0].cls, 'breaker');
  assert.equal(r2.errors[0].source, 'youtube');
  assert.ok(r2.errors[0].msg.startsWith('源熔断中：'));
  assert.equal(callOrder.filter(c => c === 'youtube:qq_e2').length, 0,
    '熔断窗内不得真跑 provider');
  assert.deepEqual(r2.errors[1], { source: 'bilibili', msg: 'Innertube LOGIN_REQUIRED', cls: 'authwall' });
});

// ⑥ resolved.mediaId 加性透传：provider return 带 mediaId 直通 resolved，
// 缺席不编（/qq/stream 端点 mint cacheKey 消费面）
test('resolved.mediaId：provider 供值直通，缺席不编', async () => {
  impls.youtube = async () => ({
    url: 'https://upos-sz-m1.bilivideo.com/v1.m4a', br: 128000, durationSec: 200,
    mediaId: 'vid_abc',
  });
  const r = await resolveTrackUnlock('qq_md1', {
    sources: ['youtube'], info: mkInfo('qq_md1'), originalDt: 200000,
  });
  assert.equal(r.resolved.mediaId, 'vid_abc', 'provider mediaId 加性透传');

  impls.youtube = async () => ({
    url: 'https://upos-sz-m1.bilivideo.com/v2.m4a', br: 128000, durationSec: 200,
  });
  const r2 = await resolveTrackUnlock('qq_md2', {
    sources: ['youtube'], info: mkInfo('qq_md2'), originalDt: 200000,
  });
  assert.ok(!('mediaId' in r2.resolved), 'mediaId 缺席不编');
});

// ⑦ [canonical:SHARED-GATE]：调用方 signal 只门控「本等待方是否消费结果」——
// 断连不杀共享链：链续跑、搭车者拿产物、产物照常落 60s 正档（retry 不二次
// 烧上游）；入链前已 abort 的调用方抛 'aborted' 且不发起链
test('调用方 abort 不杀共享链：搭车者拿产物、缓存照常落', async () => {
  let release; const gate = new Promise(r => { release = r; });
  impls.youtube = async () => {
    await gate;
    return { url: 'https://upos-sz-m1.bilivideo.com/a1.m4a', br: 128000, durationSec: 200 };
  };
  const ctl = new AbortController();
  const doomed = resolveTrackUnlock('qq_a1', {
    sources: ['youtube'], info: mkInfo('qq_a1'), originalDt: 200000, signal: ctl.signal,
  }).then(() => 'resolved', (e) => `threw:${e.message}`);
  const rider = resolveTrackUnlock('qq_a1', {
    sources: ['youtube'], info: mkInfo('qq_a1'), originalDt: 200000,
  });
  await new Promise(r => setTimeout(r, 30)); // 等两路都挂上 gate
  ctl.abort();   // 首调用方断连——只影响自己吃不吃结果
  release();
  assert.equal(await doomed, 'threw:aborted');
  const rr = await rider;
  assert.equal(rr.shared, true);
  assert.equal(rr.resolved.source, 'youtube');
  assert.equal(callOrder.filter(c => c === 'youtube:qq_a1').length, 1,
    '共享链只跑一发 provider');
  // 产物照常落缓存——后续 retry 直接命中（绝不二次烧上游）
  const again = await resolveTrackUnlock('qq_a1', {
    sources: ['youtube'], info: mkInfo('qq_a1'), originalDt: 200000,
  });
  assert.equal(again.cached, true);
  assert.equal(callOrder.filter(c => c === 'youtube:qq_a1').length, 1);

  // 入链前已 abort——抛 aborted 且不发起链
  const ctl2 = new AbortController(); ctl2.abort();
  await assert.rejects(
    () => resolveTrackUnlock('qq_a2', { sources: ['youtube'], signal: ctl2.signal }),
    /^Error: aborted$/,
  );
  assert.equal(callOrder.filter(c => c === 'youtube:qq_a2').length, 0,
    '已断连的等待方不得发起链');
});

// ⑧ forgetSongUnlock('qq_x')：编排层缓存/inflight 后缀清 + provider
// forgetSong 以 'qq_<mid>' 原值调用（[canonical:ID-PASSTHROUGH]——
// 死簿/冷却/verdict 三簿的 GLOB qq_<mid>@* 靠原值命中）
test("forgetSongUnlock('qq_x') → provider forgetSong 收原值、重解回源", async () => {
  impls.youtube = async () => ({
    url: 'https://upos-sz-m1.bilivideo.com/f1.m4a', br: 128000, durationSec: 200,
  });
  await resolveTrackUnlock('qq_f1', {
    sources: ['youtube'], info: mkInfo('qq_f1'), originalDt: 200000,
  });
  forgetSongUnlock('qq_f1');
  for (const s of ['pyncmd', 'youtube', 'bilibili']) {
    assert.ok(forgetCalls.includes(`${s}:qq_f1`),
      `provider ${s}.forgetSong 须收 'qq_f1' 原值（实际集: ${forgetCalls.join(',')}）`);
  }
  await resolveTrackUnlock('qq_f1', {
    sources: ['youtube'], info: mkInfo('qq_f1'), originalDt: 200000,
  });
  assert.equal(callOrder.filter(c => c === 'youtube:qq_f1').length, 2,
    'forget 后重解必须回源');
});

// ── F2 qqUnlockInfo 伪行装配钉板（§2.3 两种喂法 + 否决项 9 同管线）──

test('qqUnlockInfo detail 径：getSongDetail 上行取真 artists[]，过 aiUnlockInfo 同管线', async () => {
  aiEnabledImpl = () => true;
  askAiJsonImpl = async () => ({ name: 'AI名', artists: ['AI歌手'] });
  const info = await qqUnlockInfo('midQ1', {});
  assert.deepEqual(detailCalls, ['midQ1'], 'detail 径上行一次');
  assert.equal(aiCalls, 1, '伪行必须过 aiUnlockInfo 同管线（否决旁路 AI 规整）');
  assert.equal(info.id, 'qq_midQ1', 'info.id 保 qq_ 键域');
  assert.equal(info.name, 'AI名');
  assert.deepEqual(info.artists, ['AI歌手']);
  assert.equal(info.keyword, 'AI名 - AI歌手');
  assert.equal(info.durationMs, 200000, 'intervalSec×1000 落 dt');

  // AI 缺席 → baseUnlockInfo 回落——伪行 ar 字段同真 songRow 形态
  aiEnabledImpl = () => false; aiCalls = 0;
  const info2 = await qqUnlockInfo('midQ2', {});
  assert.equal(aiCalls, 0);
  assert.equal(info2.keyword, '歌名 - 歌手甲 / 歌手乙', '真 artists[] 进 keyword');

  // detail 不可达 → null（共享链按既有口径全灭 nomatch）
  detailImpl = async () => { throw new Error('fcg down'); };
  assert.equal(await qqUnlockInfo('midQ3', {}), null);
});

test('qqUnlockInfo providerData 径：快照零上行；author 整串单元素绝不 split；字段全空归 null', async () => {
  const info = await qqUnlockInfo('midP1', {
    title: '歌', author: 'A B / C', durationMs: 180000,
  });
  assert.equal(detailCalls.length, 0, '快照径不得打 getSongDetail');
  assert.equal(info.id, 'qq_midP1');
  assert.equal(info.keyword, '歌 - A B / C', 'author 整串单元素兜底——不 split');
  assert.equal(info.durationMs, 180000);

  // artists 在场优先于 author（≤10 名截断）
  const info2 = await qqUnlockInfo('midP2', {
    title: '歌2',
    artists: Array.from({ length: 12 }, (_, i) => `a${i}`),
    author: '兜底', durationMs: 180000,
  });
  assert.equal(info2.artists.length, 10, 'artists ≤10 名截断');
  assert.equal(info2.keyword, `歌2 - ${Array.from({ length: 10 }, (_, i) => `a${i}`).join(' / ')}`);
  assert.equal(detailCalls.length, 0);

  // 字段全空 → null（快照径喂了键但值全空——不转 detail、零上行；
  // spec §8.2：providerData 全缺 → info=null → 各源 nomatch 全灭 fatal）
  assert.equal(await qqUnlockInfo('midP3', {
    title: null, author: null, artists: null, durationMs: null,
  }), null);
  assert.equal(detailCalls.length, 0, 'providerData 全缺归 null——零上行');
});

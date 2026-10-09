// resolveSongUrls 在途合流 + unlockCache 逐旧淘汰钉。
// 被测模块是真身 netease-api.js——上游依赖（netease 门面/unlock 注册表/
// AI/公网校验/vault）全部 require.cache 预播种，不打真网络。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { seed, tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-ne-inflight-');
const require = createRequire(import.meta.url);

// 公网校验桩成恒真——私有段判定与 DNS 不在本用例面内；其余守卫原语用真身
const realGuard = require('../src/server/lib/net-guard.js');
seed('../src/server/lib/net-guard.js', { ...realGuard, resolvesToPublicIp: async () => true });
// mint 桩记账实参：post-pass 契约要求镜像组以「归一化后的字符串数组」入库
const mintCalls = [];
seed('../src/server/lib/stream-vault.js', {
  mint: (u) => { mintCalls.push(u); return 'tok-stub'; },
});
seed('../src/server/lib/ai.js', { aiEnabled: () => false, askAiJson: async () => null, aiModel: () => 'stub' });

// provider 桩：resolve 调用按 info.id 记账；resolveImpl 可换成可控挂起
const resolveCalls = [];
let resolveImpl = async (info) => ({
  url: `https://m701.music.126.net/${info.id}.mp3`, br: 320000, durationSec: 200,
});
seed('../src/server/services/unlock/index.js', {
  PROVIDERS: {
    pyncmd: { resolve: async (info, ctx) => { resolveCalls.push(info.id); return resolveImpl(info, ctx); } },
  },
  PLAYBACK_SOURCES: ['pyncmd'],
  DOWNLOAD_SOURCES: ['pyncmd'],
});
// song_detail 桩：按逗号 id 串回同构 songs 数组（dt=200s 与 provider 的
// durationSec=200 对齐——时长对账必须过才写缓存）
seed('../src/server/services/netease/index.js', {
  callNeteaseApi: async (name, params) => {
    if (name === 'song_detail') {
      const ids = String(params.ids).split(',').map(Number);
      return { body: { songs: ids.map(id => ({ id, dt: 200000, name: `n${id}`, ar: [{ name: 'a' }] })) } };
    }
    throw new Error(`unexpected api ${name}`);
  },
  apiModules: {},
});

const { resolveSongUrls } = require('../src/server/services/netease-api.js');
const mkItem = (id) => ({ id, url: null, fee: 1, time: 0 });
const countFor = (id) => resolveCalls.filter(x => x === id).length;

test('同 id 在途合流：批内重复条目与跨调用并发共享一条解锁链', async () => {
  resolveCalls.length = 0;
  let release;
  const gate = new Promise(r => { release = r; });
  resolveImpl = async (info) => {
    await gate;
    return { url: `https://m701.music.126.net/${info.id}.mp3`, br: 320000, durationSec: 200 };
  };
  // 同一调用里同 id 两条目（worker 池并发）+ 第二个并发调用——三路应共享一发
  const p1 = resolveSongUrls([mkItem(42), mkItem(42)], {});
  const p2 = resolveSongUrls([mkItem(42)], {});
  await new Promise(r => setTimeout(r, 20)); // 等两路都挂上 gate
  release();
  const [i1, i2] = await Promise.all([p1, p2]);
  assert.equal(resolveCalls.length, 1, '三路同 id 应只打一发 provider.resolve');
  for (const it of [...i1, ...i2]) {
    assert.equal(it.unblocked, true);
    assert.equal(it.unblockedSource, 'pyncmd');
  }
});

test('等待方 abort 不杀共享链：aborted 调用方退出，陪绑者照常吃到结果', async () => {
  resolveCalls.length = 0;
  let release;
  const gate = new Promise(r => { release = r; });
  resolveImpl = async (info) => {
    await gate;
    return { url: `https://m701.music.126.net/${info.id}.mp3`, br: 320000, durationSec: 200 };
  };
  const ctl = new AbortController();
  const doomed = resolveSongUrls([mkItem(77)], { signal: ctl.signal })
    .then(() => 'resolved', (e) => `threw:${e.message}`);
  const survivor = resolveSongUrls([mkItem(77)], {});
  await new Promise(r => setTimeout(r, 20));
  ctl.abort();   // 共享链在途时断连
  release();
  assert.equal(await doomed, 'threw:aborted');   // 本调用方 abort 穿透
  const items = await survivor;                   // 陪绑者不受影响
  assert.equal(items[0].unblocked, true);
  assert.equal(resolveCalls.length, 1);
});

// proxyOrigin 回链钉板：http 源命中代理面时 item.url = 裸 origin + 部署前缀 +
// vault 链。BASE_PATH 子目录部署下漏拼前缀 → 客户端拿根链撞 base-外 404
// （music.js requestOrigin 只产 proto://host，前缀必须服务端自己补）
test('resolveSongUrls：proxyOrigin 回链随 BASE_PATH 带部署前缀', async () => {
  resolveCalls.length = 0;
  resolveImpl = async (info) => ({
    url: `http://m701.music.126.net/${info.id}.mp3`, br: 320000, durationSec: 200,
  });
  const saved = { BASE_PATH: process.env.BASE_PATH, VITE_BASE_PATH: process.env.VITE_BASE_PATH };
  try {
    delete process.env.BASE_PATH;
    delete process.env.VITE_BASE_PATH;
    const plain = await resolveSongUrls([mkItem(7777)], { proxyOrigin: 'https://demo.example' });
    assert.equal(plain[0].url, 'https://demo.example/audio-proxy/t/tok-stub');

    process.env.BASE_PATH = '/music';
    const prefixed = await resolveSongUrls([mkItem(7778)], { proxyOrigin: 'https://demo.example' });
    assert.equal(prefixed[0].url, 'https://demo.example/music/audio-proxy/t/tok-stub');
  } finally {
    for (const k of ['BASE_PATH', 'VITE_BASE_PATH']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

// ── 发射 post-pass 钉板：proxyOrigin 在场时一切回链 vault 化（不变式：
// 浏览器不直连源站）——非解锁项的官方直链与解锁裸链同口径，源站 URL
// 不出下发 JSON
test('post-pass：proxyOrigin + 非解锁 https 白名单链 → vaulted /audio-proxy/t/', async () => {
  resolveCalls.length = 0;
  const item = { id: 8801, url: 'https://m701.music.126.net/8801.mp3', fee: 1, time: 200000 };
  const [it] = await resolveSongUrls([item], { proxyOrigin: 'https://demo.example' });
  assert.equal(resolveCalls.length, 0, '可播项不该走解锁链');
  assert.equal(it.url, 'https://demo.example/audio-proxy/t/tok-stub');
  assert.equal(it.usedAudioProxy, true);
});

test('post-pass：proxyOrigin + 白名单外链 → url:null 且 urls 不外泄', async () => {
  resolveCalls.length = 0;
  const item = {
    id: 8802, url: 'https://evil.example/x.mp3', fee: 1, time: 200000,
    urls: ['https://m701.music.126.net/ok.mp3', 'https://evil.example/x.mp3'],
  };
  const [it] = await resolveSongUrls([item], { proxyOrigin: 'https://demo.example' });
  assert.equal(it.url, null, '候选含白名单外域 → fail-closed 不下发');
  assert.ok(!('urls' in it), 'urls 候选数组不得进序列化面');
  assert.ok(!JSON.stringify(it).includes('evil.example'), '源站串不得出现在 JSON');
  assert.equal(it.usedAudioProxy, undefined);
});

test('post-pass：无 proxyOrigin → 回链原样透传（进程内调用方契约不变）', async () => {
  resolveCalls.length = 0;
  const item = { id: 8803, url: 'https://m701.music.126.net/8803.mp3', fee: 1, time: 200000 };
  const [it] = await resolveSongUrls([item], {});
  assert.equal(it.url, 'https://m701.music.126.net/8803.mp3');
  assert.equal(it.usedAudioProxy, undefined);
});

// 解锁源产 urls[] 镜像组：post-pass 须把「归一化后的字符串数组」整组交给
// mint——代理逐试 failover 语义靠数组保真；归一化形态入库（FQDN 尾点等
// 清洗在入库前完成，代理端拿到的直接是可用形态）
test('post-pass：解锁镜像组 urls[] → mint 收归一化数组，urls 不外泄', async () => {
  resolveCalls.length = 0;
  mintCalls.length = 0;
  resolveImpl = async () => ({
    url: 'http://m701.music.126.net/mirror.mp3',
    urls: ['http://m701.music.126.net./mirror.mp3', 'https://m702.music.126.net/mirror.mp3'],
    br: 320000, durationSec: 200,
  });
  const [it] = await resolveSongUrls([mkItem(8804)], { proxyOrigin: 'https://demo.example' });
  assert.equal(it.url, 'https://demo.example/audio-proxy/t/tok-stub');
  assert.equal(it.usedAudioProxy, true);
  assert.ok(!('urls' in it), 'urls 候选数组不得进序列化面');
  const last = mintCalls.at(-1);
  assert.ok(Array.isArray(last), '镜像组必须以数组形态入 vault');
  // 尾点 FQDN 归一化后才能过白名单判——断言入库的是清洗后形态而非原文
  assert.deepEqual(last, [
    'http://m701.music.126.net/mirror.mp3',
    'https://m702.music.126.net/mirror.mp3',
  ]);
  assert.ok(!JSON.stringify(it).includes('music.126.net'), '源站串不得出现在 JSON');
});

// 逐候选归一化钉板：镜像组混一条坏协议候选不能靠裸 hostname 白名单判蒙混
// 进 vault（mint 进去即"已 mint 却 403/拒连"的烧死跳）——任一不过整项
// fail-closed
test('post-pass：镜像组混入 ftp:// 坏协议候选 → 整项 fail-closed url:null', async () => {
  resolveCalls.length = 0;
  const item = {
    id: 8805, url: 'https://m701.music.126.net/8805.mp3', fee: 1, time: 200000,
    urls: ['https://m701.music.126.net/ok.mp3', 'ftp://music.126.net/x.mp3'],
  };
  const [it] = await resolveSongUrls([item], { proxyOrigin: 'https://demo.example' });
  assert.equal(it.url, null, '候选含坏协议 → fail-closed 不下发');
  assert.ok(!('urls' in it), 'urls 候选数组不得进序列化面');
  assert.ok(!JSON.stringify(it).includes('music.126.net'), '源站串不得出现在 JSON');
});

// freeTrialInfo 试听档：不 mint 省 vault 容量，但残片链同样不落 JSON——
// 客户端试听提示走 freeTrialInfo 字段判定（isUnavailableTrack），不吃
// url。能带 freeTrialInfo 活到 post-pass 的只剩无 id 项（带 id 试听项
// 必经解锁链：成功清 freeTrialInfo、失败已 url=null+unlockFailed）
test('post-pass：freeTrialInfo 试听项 → url:null（试听链不外泄），字段保留', async () => {
  resolveCalls.length = 0;
  const item = {
    url: 'https://m701.music.126.net/trial.mp3', fee: 1, time: 30000,
    freeTrialInfo: { fragment: true },
  };
  const [it] = await resolveSongUrls([item], { proxyOrigin: 'https://demo.example' });
  assert.equal(it.url, null, '试听残片链不得进下发 JSON');
  assert.equal(it.freeTrialInfo?.fragment, true, '试听字段须保留供客户端文案判定');
  assert.equal(it.usedAudioProxy, undefined, '试听项不 mint 不打已代理标');
  assert.ok(!JSON.stringify(it).includes('m701.music.126.net'), '源站串不得出现在 JSON');
});

test('unlockCache 满容逐最旧淘汰而非整表清空', async () => {
  resolveCalls.length = 0;
  resolveImpl = async (info) => ({
    url: `https://m701.music.126.net/${info.id}.mp3`, br: 320000, durationSec: 200,
  });
  // 260 个不同 id 分批喂满 256 上限并溢出——最早的 4 条（1000-1003）被挤掉
  const ids = Array.from({ length: 260 }, (_, i) => 1000 + i);
  for (let off = 0; off < ids.length; off += 20) {
    await resolveSongUrls(ids.slice(off, off + 20).map(mkItem), {});
  }
  const base = countFor(1000);
  assert.equal(base, 1);
  // 最早档已被淘汰 → 重解再打一发；整表 clear() 语义下这里也会打——
  // 判别点在下行：最新档若被全清同样会回源
  await resolveSongUrls([mkItem(1000)], {});
  assert.equal(countFor(1000), 2, '最旧键应已淘汰——重解回源');
  await resolveSongUrls([mkItem(1259)], {});
  assert.equal(countFor(1259), 1, '次新键应仍在窗内——整表清空会误伤它');
});

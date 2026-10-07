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
seed('../src/server/lib/stream-vault.js', { mint: () => 'tok-stub' });
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

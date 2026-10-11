// 解锁编排层逐源失败归因（item.unlockErrors）+ 源级熔断跳过 + 按曲负状态
// 清理（forgetSongUnlock）钉板——spec-retry-heal-b 单元 B 的 netease-api.js
// 消费面。seed 面照抄 netease-inflight.test.mjs（net-guard/stream-vault/ai/
// unlock/index.js/netease 门面五处），provider 桩可编程抛错/回 null。
// health：单元 A 的 unlock/health.js 可能尚未落地——在场用真身+_resetForTest；
// 缺席时播种契约等价桩，并补 _resolveFilename 兜底把 ./unlock/health 解析
// 指到桩键（桩只实现 canonical HEALTHAPI 面，用例断言也只用该面）。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { fileURLToPath } from 'node:url';
import { seed, tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-ne-unlockerr-');
const require = createRequire(import.meta.url);

// 公网校验桩可控——私网全拒分支需要它回 false；其余守卫原语用真身
const realGuard = require('../src/server/lib/net-guard.js');
let publicIpImpl = async () => true;
seed('../src/server/lib/net-guard.js', { ...realGuard, resolvesToPublicIp: (...a) => publicIpImpl(...a) });
seed('../src/server/lib/stream-vault.js', { mint: () => 'tok-stub' });
// AI 规整桩可控：forgetSongUnlock 清 unlockInfoCache 的观测靠 askAiJson 计数
let aiEnabledImpl = () => false;
let askAiJsonImpl = async () => null;
let aiInfoCalls = 0;
seed('../src/server/lib/ai.js', {
  aiEnabled: () => aiEnabledImpl(),
  askAiJson: async (...a) => { aiInfoCalls++; return askAiJsonImpl(...a); },
  aiModel: () => 'stub',
});

// provider 桩：resolveImpl/resolveImpl2 可编程；forgetSong 记账实参（L3 钩面）
const resolveCalls = [];
const forgetCalls = [];
let resolveImpl = async (info) => ({
  url: `https://m701.music.126.net/${info.id}.mp3`, br: 320000, durationSec: 200,
});
let resolveImpl2 = async () => null;
seed('../src/server/services/unlock/index.js', {
  PROVIDERS: {
    pyncmd: {
      resolve: async (info, ctx) => { resolveCalls.push(info.id); return resolveImpl(info, ctx); },
      forgetSong: (id) => { forgetCalls.push(id); },
    },
    stub2: { resolve: async (info, ctx) => { resolveCalls.push(`s2:${info.id}`); return resolveImpl2(info, ctx); } },
  },
  PLAYBACK_SOURCES: ['pyncmd'],
  DOWNLOAD_SOURCES: ['pyncmd'],
});
// song_detail 桩：按逗号 id 串回同构 songs 数组（dt=200s 对齐 durationSec）
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

// health 真身优先、契约桩兜底——两边都是同一模块键，netease-api require 到的
// 与用例持有的恒为同一实例（_resetForTest 才能真清编排层看到的簿）
const healthPath = fileURLToPath(new URL('../src/server/services/unlock/health.js', import.meta.url));
let health;
try {
  health = require(healthPath); // A 已落地：真身（自带 _resetForTest）
} catch {
  // 未落地：spec §3.1 状态机的契约等价桩（只用 canonical HEALTHAPI 面）
  const streaks = new Map(); const stamped = new Map();
  health = {
    BREAKER_TTL_MS: 10 * 60e3, BREAKER_THRESHOLD: 2,
    BREAKER_REASON: '凭据被拒连败（疑似反机器人墙）',
    isOpen: (s) => { const x = stamped.get(s); return !!x && Date.now() < x.until; },
    breakerReason: (s) => stamped.get(s)?.reason || null,
    noteAuthRejected: (s) => {
      const n = (streaks.get(s) || 0) + 1; streaks.set(s, n);
      if (n >= health.BREAKER_THRESHOLD && !health.isOpen(s)) {
        stamped.set(s, { until: Date.now() + health.BREAKER_TTL_MS, reason: health.BREAKER_REASON });
        return true;
      }
      return false;
    },
    noteSourceOk: (s) => { streaks.delete(s); },
    _resetForTest: () => { streaks.clear(); stamped.clear(); },
  };
  require.cache[healthPath] = { id: healthPath, filename: healthPath, loaded: true, exports: health };
  const origResolveFilename = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, isMain, options) {
    try { return origResolveFilename.call(this, request, parent, isMain, options); }
    catch (e) {
      if (request === './unlock/health' || request === './unlock/health.js') return healthPath;
      throw e;
    }
  };
}

const { resolveSongUrls, forgetSongUnlock, MAX_UNLOCK_ITEMS } = require('../src/server/services/netease-api.js');
const unlockIndex = require('../src/server/services/unlock/index.js');
const mkItem = (id) => ({ id, url: null, fee: 1, time: 0 });

beforeEach(() => {
  health._resetForTest();
  resolveCalls.length = 0; forgetCalls.length = 0; aiInfoCalls = 0;
  aiEnabledImpl = () => false; askAiJsonImpl = async () => null; publicIpImpl = async () => true;
  resolveImpl = async (info) => ({
    url: `https://m701.music.126.net/${info.id}.mp3`, br: 320000, durationSec: 200,
  });
  resolveImpl2 = async () => null;
  // 源序可能被子用例临时扩过——收回原桩面
  unlockIndex.PLAYBACK_SOURCES.splice(1);
  unlockIndex.DOWNLOAD_SOURCES.splice(1);
});

test('逐源抛错归类：HTTP 5xx → transient；HTTP 4xx → nomatch', async () => {
  resolveImpl = async () => { throw new Error('pyncmd HTTP 503'); };
  const [it] = await resolveSongUrls([mkItem(101)], {});
  assert.equal(it.unlockFailed, true);
  assert.equal(it.url, null);
  assert.deepEqual(it.unlockErrors, [{ source: 'pyncmd', msg: 'pyncmd HTTP 503', cls: 'transient' }]);
  assert.ok(!it.unlockErrors[0].msg.includes('\n'), 'msg 必须单行——进任务错误消息');

  resolveImpl = async () => { throw new Error('pyncmd HTTP 404'); };
  const [it2] = await resolveSongUrls([mkItem(102)], {});
  assert.deepEqual(it2.unlockErrors, [{ source: 'pyncmd', msg: 'pyncmd HTTP 404', cls: 'nomatch' }]);
});

test('authRejected → authwall 且进连败记账：2 发到阈盖章', async () => {
  const e1 = new Error('Innertube LOGIN_REQUIRED'); e1.authRejected = true;
  resolveImpl = async () => { throw e1; };
  const [it] = await resolveSongUrls([mkItem(111)], {});
  assert.equal(it.unlockErrors[0].cls, 'authwall');
  assert.equal(health.isOpen('pyncmd'), false, '单发凭据被拒不到阈——单视频会员专享不该误盖章');
  const [it2] = await resolveSongUrls([mkItem(112)], {});
  assert.equal(it2.unlockErrors[0].cls, 'authwall');
  assert.equal(health.isOpen('pyncmd'), true, '连败 2 次到阈应盖章');
  assert.equal(health.breakerReason('pyncmd'), '凭据被拒连败（疑似反机器人墙）');
});

test('[canonical MARKER]：带 authCounted 的 authwall 不重复记连败', async () => {
  const counted = new Error('Innertube 凭据被拒（1/2 候选）');
  counted.authRejected = true; counted.authCounted = true;
  const uncounted = new Error('Innertube LOGIN_REQUIRED');
  uncounted.authRejected = true;
  resolveImpl = async () => { throw counted; };
  const [it] = await resolveSongUrls([mkItem(113)], {});
  assert.equal(it.unlockErrors[0].cls, 'authwall');
  // 若 MARKER 失效双计，仅这一发就计了 1 次——再一发不带的凑满阈 2 即盖章
  resolveImpl = async () => { throw uncounted; };
  await resolveSongUrls([mkItem(114)], {});
  assert.equal(health.isOpen('pyncmd'), false, 'authCounted 已记账的不许重复进 streaks');
  await resolveSongUrls([mkItem(115)], {});
  assert.equal(health.isOpen('pyncmd'), true, '不带的连发两次才该到阈');
});

test('源回 null → nomatch「源未产出候选」；回链全私网 → 「回链归一化/公网校验全拒」', async () => {
  resolveImpl = async () => null;
  const [it] = await resolveSongUrls([mkItem(121)], {});
  assert.deepEqual(it.unlockErrors, [{ source: 'pyncmd', msg: '源未产出候选', cls: 'nomatch' }]);

  publicIpImpl = async () => false; // 公网校验全拒
  resolveImpl = async (info) => ({ url: `https://m701.music.126.net/${info.id}.mp3`, br: 320000, durationSec: 200 });
  const [it2] = await resolveSongUrls([mkItem(122)], {});
  assert.deepEqual(it2.unlockErrors, [{ source: 'pyncmd', msg: '回链归一化/公网校验全拒', cls: 'nomatch' }]);
});

test('熔断窗内整源跳过：provider.resolve 零调用，cls=breaker', async () => {
  health.noteAuthRejected('pyncmd');
  health.noteAuthRejected('pyncmd'); // 到阈盖章
  assert.equal(health.isOpen('pyncmd'), true);
  const [it] = await resolveSongUrls([mkItem(131)], {});
  assert.equal(resolveCalls.length, 0, '熔断窗内不得真跑 provider');
  assert.equal(it.unlockFailed, true);
  assert.equal(it.unlockErrors[0].cls, 'breaker');
  assert.ok(it.unlockErrors[0].msg.startsWith('源熔断中：'), 'breaker msg 以「源熔断中：」起头');
  assert.ok(it.unlockErrors[0].msg.includes('凭据被拒连败（疑似反机器人墙）'));
});

test('源一次成功 → noteSourceOk 连败清零', async () => {
  const e1 = new Error('Innertube LOGIN_REQUIRED'); e1.authRejected = true;
  resolveImpl = async () => { throw e1; };
  await resolveSongUrls([mkItem(141)], {}); // streak=1
  resolveImpl = async (info) => ({ url: `https://m701.music.126.net/${info.id}.mp3`, br: 320000, durationSec: 200 });
  await resolveSongUrls([mkItem(142)], {}); // 成功 → 清零
  resolveImpl = async () => { throw e1; };
  await resolveSongUrls([mkItem(143)], {}); // 若未清零则 streak=2 已盖章
  assert.equal(health.isOpen('pyncmd'), false, '成功后连败必须清零——只计 1 次不该盖章');
});

test('同 id 三件套车失败：每个 item 拿到同一份 unlockErrors（共享结果下发）', async () => {
  let release; const gate = new Promise(r => { release = r; });
  resolveImpl = async () => { await gate; throw new Error('pyncmd HTTP 503'); };
  const p1 = resolveSongUrls([mkItem(151), mkItem(151)], {});
  const p2 = resolveSongUrls([mkItem(151)], {});
  await new Promise(r => setTimeout(r, 20));
  release();
  const [i1, i2] = await Promise.all([p1, p2]);
  assert.equal(resolveCalls.length, 1, '三路同 id 应只打一发 provider.resolve');
  for (const it of [...i1, ...i2]) {
    assert.equal(it.unlockFailed, true);
    assert.deepEqual(it.unlockErrors, [{ source: 'pyncmd', msg: 'pyncmd HTTP 503', cls: 'transient' }],
      '搭车 item 必须拿到共享结果里的归因，不能落在首调用方对象上');
  }
});

test('前序源失败留痕随成功结果下发；干净成功不带 unlockErrors', async () => {
  unlockIndex.PLAYBACK_SOURCES.push('stub2');
  try {
    resolveImpl = async () => { throw new Error('pyncmd HTTP 503'); };
    resolveImpl2 = async (info) => ({ url: `https://m701.music.126.net/${info.id}.mp3`, br: 320000, durationSec: 200 });
    const [it] = await resolveSongUrls([mkItem(161)], {});
    assert.equal(it.unblocked, true);
    assert.equal(it.unblockedSource, 'stub2');
    assert.deepEqual(it.unlockErrors, [{ source: 'pyncmd', msg: 'pyncmd HTTP 503', cls: 'transient' }],
      '前序源失败归因随成功结果一起下发（部分失败留痕）');
  } finally {
    unlockIndex.PLAYBACK_SOURCES.pop();
  }
  resolveImpl = async (info) => ({ url: `https://m701.music.126.net/${info.id}.mp3`, br: 320000, durationSec: 200 });
  const [it2] = await resolveSongUrls([mkItem(162)], {});
  assert.equal(it2.unblocked, true);
  assert.ok(!('unlockErrors' in it2), '干净成功不得挂空归因——数组仅非空才落 item');
});

test('MAX_UNLOCK_ITEMS 截断：丢弃项落 unlockFailed + source=\'-\' 归因', async () => {
  const items = Array.from({ length: MAX_UNLOCK_ITEMS + 1 }, (_, i) => mkItem(300 + i));
  const out = await resolveSongUrls(items, {});
  const dropped = out[MAX_UNLOCK_ITEMS];
  assert.equal(dropped.unlockFailed, true);
  assert.equal(dropped.url, null);
  assert.deepEqual(dropped.unlockErrors,
    [{ source: '-', msg: '超出单次解锁条数上限，未尝试', cls: 'nomatch' }]);
});

test('download purpose 同享逐源归因', async () => {
  resolveImpl = async () => { throw new Error('pyncmd HTTP 503'); };
  const [it] = await resolveSongUrls([mkItem(191)], { purpose: 'download' });
  assert.equal(it.unlockFailed, true);
  assert.equal(it.unlockErrors[0].cls, 'transient');
});

test('forgetSongUnlock：清 unlockCache 重解回源 + provider forgetSong 钩被调', async () => {
  await resolveSongUrls([mkItem(171)], {});
  assert.equal(resolveCalls.length, 1);
  await resolveSongUrls([mkItem(171)], {});
  assert.equal(resolveCalls.length, 1, '缓存窗内第二发不该回源');
  forgetSongUnlock(171);
  assert.deepEqual(forgetCalls, ['171'], 'provider.forgetSong 须以字符串 id 调用');
  await resolveSongUrls([mkItem(171)], {});
  assert.equal(resolveCalls.length, 2, 'forget 后重解必须回源');
});

test('forgetSongUnlock：清 unlockInfoCache（AI 规整重打）与 unlockInfoInflight（不搭旧链）', async () => {
  aiEnabledImpl = () => true;
  askAiJsonImpl = async () => ({ name: 'AI名', artists: ['a'] });
  resolveImpl = async () => null; // 失败不写 unlockCache——第二发会重跑 resolveOne
  await resolveSongUrls([mkItem(181)], {});
  assert.equal(aiInfoCalls, 1);
  await resolveSongUrls([mkItem(181)], {});
  assert.equal(aiInfoCalls, 1, 'unlockInfoCache 窗内第二发不重打 AI');
  forgetSongUnlock(181);
  await resolveSongUrls([mkItem(181)], {});
  assert.equal(aiInfoCalls, 2, 'forget 后 unlockInfoCache 已清——AI 规整重打');

  // inflight 键清除：旧链在途时 forget，新调用必须另起而非搭车
  aiInfoCalls = 0;
  let release; const gate = new Promise(r => { release = r; });
  askAiJsonImpl = async () => { await gate; return { name: 'x', artists: ['a'] }; };
  const p1 = resolveSongUrls([mkItem(182)], {});
  await new Promise(r => setTimeout(r, 30)); // 等 aiUnlockInfo 挂上 unlockInfoInflight
  forgetSongUnlock(182);
  const p2 = resolveSongUrls([mkItem(182)], {});
  await new Promise(r => setTimeout(r, 30));
  assert.equal(aiInfoCalls, 2, 'unlockInfoInflight 已清——新调用不搭旧链');
  release();
  await Promise.all([p1, p2]);
});

// forget 交错钉板（unlockInflight 身份守卫）：forgetSongUnlock 在旧 gate 在途时
// 清键，旧链 finally 必须只逐自身——误逐后注册的 gate2 会让 p3 另起第三条链
// （同键双链并发，单飞去重失效）。resolveImpl 回 null 走 nomatch 不落
// unlockCache——否则后续调用走缓存命中，inflight 判定被掩盖断言空转
test('forget 清键后旧 gate 的 finally 不误逐后注册的新 gate（unlockInflight 身份守卫）', async () => {
  const releases = [];
  // resolveImpl 每次被调挂起并把放行阀推入 releases——阀数即 resolveOne 发起数
  resolveImpl = async () => { await new Promise(r => releases.push(r)); return null; };
  const p1 = resolveSongUrls([mkItem(401)], {});
  await new Promise(r => setTimeout(r, 30));     // 等 gate1 挂上 unlockInflight
  assert.equal(releases.length, 1);
  forgetSongUnlock(401);                         // 外部清键——gate1 的 finally 尚未跑
  const p2 = resolveSongUrls([mkItem(401)], {});
  await new Promise(r => setTimeout(r, 30));     // 等 gate2 注册
  assert.equal(releases.length, 2, 'forget 后同 id 调用须另起 gate2');
  releases[0]();                                 // 放行 gate1——其 finally 此刻执行
  await p1;                                      // p1 整条结清 ⇒ 守卫判定已发生
  const p3 = resolveSongUrls([mkItem(401)], {});
  await new Promise(r => setTimeout(r, 30));
  const gateCount = releases.length;
  for (const r of releases) r();                 // 放行全部在途 gate，防挂起泄漏
  await Promise.all([p2, p3]);
  assert.equal(gateCount, 2, 'p3 应搭 gate2 的便车——误逐新键才会另起第三条链');
});

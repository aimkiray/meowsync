// unlock/youtube.js 反机器人墙行为钉 + forgetSong 按曲清负状态。
// authRejected（Innertube LOGIN_REQUIRED/401/403）是 IP 信誉证据不是候选
// 死活：逐候选记进源级熔断（health 真身）、绝不进死簿/verdict、连败到阈
// 早退；全灭时 resolve 抛带 authCounted 标记的 authwall 错而非回 null。
// seed 面照抄 unlock-youtube.test.mjs：lib/youtube、services/youtube-resolve、
// lib/ai、repositories/lyricAi 四处预播种（lyricAi 桩补 deleteUnlockVerdicts），
// health 用真身且每用例 _resetForTest()。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { seed, tmpDataDir } from './helpers.mjs';

// 真库用例（deleteUnlockVerdicts GLOB 语义）落临时 DATA_DIR——
// 必须在任何 db/client 触库前设定
process.env.DATA_DIR = tmpDataDir('meowsync-ytwall-');
const require = createRequire(import.meta.url);

let aiOn = true;
let aiScript = [];                 // askAiJson 依次返回
let askBlock = null;               // 非空时 askAiJson 先等它放行（在途单飞钉）
let askBlockResolve = null;
let verdictRows = {};              // vkey → {ok}
const verdictWrites = [];          // upsertVerdict 记录
const delCalls = [];               // deleteUnlockVerdicts 调用记录
let askCalls = 0;
let resolveStreamsImpl = async () => ({ streams: [] });
let searchImpl = async () => [];

seed('../src/server/lib/youtube.js', {
  innertubeSearch: (...a) => searchImpl(...a),
});
seed('../src/server/services/youtube-resolve.js', {
  resolveYoutubeStreams: (...a) => resolveStreamsImpl(...a),
});
seed('../src/server/lib/ai.js', {
  aiEnabled: () => aiOn,
  askAiJson: async () => {
    askCalls += 1;
    if (askBlock) await askBlock;
    return aiScript.length ? aiScript.shift() : null;
  },
  aiModel: () => 'stub-model',
});
seed('../src/server/repositories/lyricAi.js', {
  getVerdict: (vkey) => verdictRows[vkey],
  // upsert 同步刷 verdictRows——后续 getVerdict 必须看见刚落的判定
  upsertVerdict: (vkey, kind, ok, detail) => { verdictWrites.push({ vkey, kind, ok, detail }); verdictRows[vkey] = { ok }; },
  deleteUnlockVerdicts: (id) => { delCalls.push(id); return 0; },
});
const { resolve, aiRankCandidates, forgetSong } = require('../src/server/services/unlock/youtube.js');
const health = require('../src/server/services/unlock/health.js');

// 每用例独立 info.id：模块级 rejectedAt/deadCands 以曲为键，共用 id 会跨用例泄漏
const mkInfo = (id) => ({ id, name: '目标曲', artists: ['目标歌手'], keyword: '目标曲 - 目标歌手', durationMs: 200000 });
const cand = (id) => ({ videoId: id, title: `t-${id}`, owner: `o-${id}`, durationSec: 200 });
const ids = (r) => r.ordered.map(c => c.videoId);
const authErr = () => { const e = new Error('LOGIN_REQUIRED'); e.authRejected = true; return e; };
const reset = () => {
  aiOn = true; aiScript = []; askBlock = null; askBlockResolve = null;
  verdictRows = {}; verdictWrites.length = 0; delCalls.length = 0; askCalls = 0;
  resolveStreamsImpl = async () => ({ streams: [] });
  searchImpl = async () => [];
  health._resetForTest();          // 连败簿/章跨用例残留会污染断言
};

test('authRejected 连败到阈：不进死簿、3 候选只打 2 次、抛 authwall 且源盖章', async () => {
  reset();
  const info = mkInfo('w1');
  searchImpl = async () => [cand('a'), cand('b'), cand('c')];
  aiOn = false;
  let streamCalls = 0;
  resolveStreamsImpl = async () => { streamCalls += 1; throw authErr(); };
  const err = await resolve(info, {}).then(() => null, (e) => e);
  assert.equal(streamCalls, 2, '第 2 记到阈即整源停打——候选 c 不再喂风控');
  assert.equal(err?.authRejected, true, '全灭由回 null 变抛 authwall（失败形态透出）');
  assert.equal(err?.authCounted, true, '防编排层双计标记');
  assert.match(err?.message || '', /2\/3 候选，源已熔断/);
  assert.equal(verdictWrites.length, 0, '墙证据绝不升级 ok=0 verdict');
  assert.equal(health.isOpen('youtube'), true);
  assert.equal(health.breakerReason('youtube'), '凭据被拒连败（疑似反机器人墙）');
});

test('单发 authRejected 后次候选成功：正常返回不抛、不达阈不盖章、不入死簿', async () => {
  reset();
  const info = mkInfo('w2');
  searchImpl = async () => [cand('a'), cand('b')];
  aiOn = false;
  resolveStreamsImpl = async (vid) => {
    if (vid === 'a') throw authErr();
    return { streams: [{ url: `u-${vid}`, br: 128 }] };
  };
  const r = await resolve(info, {});
  assert.equal(r.url, 'u-b');
  assert.equal(health.isOpen('youtube'), false, '连败 1 次不达阈——单视频会员专享不误伤');
  // a 未进死簿的旁证：重新排序 a 不押尾（markDead 会把它按进死簿尾段）
  const r2 = await aiRankCandidates(info, [cand('a'), cand('b')], null);
  assert.deepEqual(ids(r2), ['a', 'b']);
});

test('authSeen>0 但未到阈：仍抛 authwall（真因透出，盖章与否由连败判据独立决定）', async () => {
  reset();
  const info = mkInfo('w3');
  searchImpl = async () => [cand('a'), cand('b')];
  aiOn = false;
  resolveStreamsImpl = async (vid) => {
    if (vid === 'a') throw authErr();
    return { streams: [] };                 // 普通取流失败（非凭据）——死簿记账
  };
  const err = await resolve(info, {}).then(() => null, (e) => e);
  assert.equal(err?.authRejected, true);
  assert.equal(err?.authCounted, true);
  assert.match(err?.message || '', /Innertube 凭据被拒（1\/2 候选）/);
  assert.equal(health.isOpen('youtube'), false, '单发不盖章');
});

test('非凭据全灭仍回 null——失败形态按真因分流', async () => {
  reset();
  const info = mkInfo('w4');
  searchImpl = async () => [cand('a'), cand('b')];
  aiOn = false;
  resolveStreamsImpl = async () => ({ streams: [] });
  const r = await resolve(info, {});
  assert.equal(r, null, 'authSeen=0 维持原失败形态');
  assert.equal(health.isOpen('youtube'), false);
});

test('forgetSong：死簿按曲前缀清（旁曲不波及）+ deleteUnlockVerdicts 收裸 sid', async () => {
  reset();
  const info = mkInfo('f1');
  aiOn = false;
  // 播种死簿：f1 的 a 候选与旁曲 fx 的 z 候选各死一次（n=1 内存死簿不写 verdict）
  searchImpl = async () => [cand('a')];
  resolveStreamsImpl = async () => ({ streams: [] });
  await resolve(info, {});
  const infoX = mkInfo('fx');
  searchImpl = async () => [cand('z')];
  await resolve(infoX, {});
  assert.equal(verdictWrites.length, 0);
  let r = await aiRankCandidates(info, [cand('a'), cand('b')], null);
  assert.deepEqual(ids(r), ['b', 'a'], '死候选应押尾');
  forgetSong('f1');
  assert.deepEqual(delCalls, ['f1'], 'GLOB 口径 <sid>@yt_* 由 repo 内拼——provider 只传裸 sid');
  r = await aiRankCandidates(info, [cand('a'), cand('b')], null);
  assert.deepEqual(ids(r), ['a', 'b'], '死簿清后 a 回原序');
  r = await aiRankCandidates(infoX, [cand('z'), cand('q')], null);
  assert.deepEqual(ids(r), ['q', 'z'], 'fx 的死簿不清——清理由是曲级前缀界');
});

test('forgetSong：全否冷却清——同候选集重评', async () => {
  reset();
  const info = mkInfo('f2');
  aiScript = [{ pick: 0 }];
  let r = await aiRankCandidates(info, [cand('u'), cand('v')], null);
  assert.deepEqual(r.ordered, []);
  assert.equal(askCalls, 1);
  r = await aiRankCandidates(info, [cand('u'), cand('v')], null);
  assert.equal(askCalls, 1, '全否冷却命中——同集不烧 AI');
  forgetSong('f2');
  aiScript = [{ pick: 1 }];
  r = await aiRankCandidates(info, [cand('u'), cand('v')], null);
  assert.equal(askCalls, 2, '冷却清后同集重新评估');
  assert.equal(r.pickedId, 'u');
});

test('forgetSong：在途判定单飞键清——同键新调用不搭旧车', async () => {
  reset();
  const info = mkInfo('f3');
  aiScript = [{ pick: 1 }, { pick: 2 }];
  askBlock = new Promise((r) => { askBlockResolve = r; });
  const p1 = aiRankCandidates(info, [cand('x'), cand('y')], null);
  assert.equal(askCalls, 1, '首个判定在途（inflightRank 持 f3 键）');
  forgetSong('f3');
  const p2 = aiRankCandidates(info, [cand('x'), cand('y')], null);
  assert.equal(askCalls, 2, '键清后同候选集起新单飞——不共享在途 promise');
  askBlockResolve();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.pickedId, 'x');
  assert.equal(r2.pickedId, 'y');
});

test('lyricAi.deleteUnlockVerdicts 真库：unlock 行按曲前缀整删、lyric 行不波及', () => {
  reset();
  // 本文件 lyricAi 已被桩播种——临时摘桩取真身（db/client 真身落 DATA_DIR 临时库）
  const p = require.resolve('../src/server/repositories/lyricAi.js');
  const stub = require.cache[p];
  delete require.cache[p];
  try {
    const repo = require('../src/server/repositories/lyricAi.js');
    repo.upsertVerdict('s1@yt_a@m', 'unlock', 0, '死');
    repo.upsertVerdict('s1@yt_b@m', 'unlock', 1, '活');
    repo.upsertVerdict('s1@m@sig', 'lyric', 0, '词归属核验');
    repo.upsertVerdict('s2@yt_a@m', 'unlock', 0, '别曲');
    repo.upsertVerdict('sx1@yt_a@m', 'unlock', 0, 'LIKE 宽匹诱饵');
    assert.equal(repo.deleteUnlockVerdicts('s1'), 2, '返回删除行数');
    assert.equal(repo.getVerdict('s1@yt_a@m', 'unlock'), undefined);
    assert.equal(repo.getVerdict('s1@yt_b@m', 'unlock'), undefined);
    assert.equal(repo.getVerdict('s1@m@sig', 'lyric')?.ok, 0, 'kind=lyric 判定行绝不受波及');
    assert.equal(repo.getVerdict('s2@yt_a@m', 'unlock')?.ok, 0, '前缀逐字相等——别曲不宽匹');
    // GLOB 的 '_' 逐字——LIKE 下 's_1' 的 _ 会单字通配宽匹到 'sx1'
    assert.equal(repo.deleteUnlockVerdicts('s_1'), 0);
    assert.equal(repo.getVerdict('sx1@yt_a@m', 'unlock')?.ok, 0, 'GLOB 逐字匹配——sx1 幸存');
  } finally {
    delete require.cache[p];
    if (stub) require.cache[p] = stub;   // 还原桩面——后续 require 仍见桩
  }
});

// forget 交错钉板（inflightRank 身份守卫，同 unlockInflight 先例）：forgetSong
// 在旧单飞在途时清键，旧链 finally 必须只逐自身——误逐后注册的 gate2 会让
// 第三发另起 gate3（同键双链并发，单飞去重失效）。askBlock 逐发换挂起阀：
// gate1 单独放行时 gate2 仍挂起，第三发搭不搭车才由 askCalls 判别
test('forgetSong：旧链 finally 不误逐清键后新注册的同键单飞（inflightRank 身份守卫）', async () => {
  reset();
  const info = mkInfo('f4');
  const releases = [];                           // askBlock 逐发换阀，releases 即放行器数组
  askBlock = new Promise((r) => { releases.push(r); });
  const p1 = aiRankCandidates(info, [cand('x'), cand('y')], null);
  assert.equal(askCalls, 1, 'gate1 在途——inflightRank 持 f4:x,y 键');
  forgetSong('f4');                              // 外部清键——gate1 的 finally 尚未跑
  askBlock = new Promise((r) => { releases.push(r); });
  const p2 = aiRankCandidates(info, [cand('x'), cand('y')], null);
  assert.equal(askCalls, 2, 'forget 后同候选集另起 gate2——不搭旧车');
  releases[0]();                                 // 放行 gate1——其 finally 此刻执行
  await p1;                                      // p1 整条结清 ⇒ 守卫判定已发生
  const p3 = aiRankCandidates(info, [cand('x'), cand('y')], null);
  assert.equal(askCalls, 2, 'p3 应搭 gate2 便车——误逐新键才会起 gate3 再烧一次 AI');
  releases[1]();                                 // 放行 gate2（守卫退化时同阀也放走 gate3，防挂起泄漏）
  await Promise.all([p2, p3]);
});

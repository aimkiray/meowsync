// unlock/youtube.js 的 aiRankCandidates + resolve：判定记忆 + AI 择候选 +
// 死簿升级否决 + 全否冷却指纹的行为钉。
// 三个上游依赖（lib/youtube 拉流、lib/ai 模型、verdict 库）全部 require.cache
// 预播种——模块在 require 时解构绑定，必须就位后再 require。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let aiOn = true;
let aiScript = [];                 // askAiJson 依次返回
let verdictRows = {};              // vkey → {ok}
const verdictWrites = [];          // upsertVerdict 记录
let askCalls = 0;
// lib/youtube 三件套做成可变桩——resolve 级用例要改取流行为
let fetchPlayerImpl = async () => ({ streamingData: {} });
let searchImpl = async () => [];
let pickImpl = () => [];

import { seed } from './helpers.mjs';
seed('../src/server/lib/youtube.js', {
  fetchPlayer: (...a) => fetchPlayerImpl(...a),
  innertubeSearch: (...a) => searchImpl(...a),
  pickStreamList: (...a) => pickImpl(...a),
});
seed('../src/server/lib/ai.js', {
  aiEnabled: () => aiOn,
  askAiJson: async () => { askCalls += 1; return aiScript.length ? aiScript.shift() : null; },
  AI_MODEL: 'stub-model',
});
seed('../src/server/repositories/lyricAi.js', {
  getVerdict: (vkey) => verdictRows[vkey],
  // upsert 同步刷 verdictRows——后续 getVerdict 必须看见刚落的判定（死簿升级否决依赖此）
  upsertVerdict: (vkey, kind, ok, detail) => { verdictWrites.push({ vkey, kind, ok, detail }); verdictRows[vkey] = { ok }; },
});
const { aiRankCandidates, resolve } = require('../src/server/services/unlock/youtube.js');

// 每用例独立 info.id：模块级 rejectedAt/deadCands 冷却以曲为键，共用 id 会跨用例泄漏
const mkInfo = (id) => ({ id, name: '目标曲', artists: ['目标歌手'], keyword: '目标曲 - 目标歌手', durationMs: 200000 });
const cand = (id) => ({ videoId: id, title: `t-${id}`, owner: `o-${id}`, durationSec: 200 });
const reset = () => {
  aiOn = true; aiScript = []; verdictRows = {}; verdictWrites.length = 0; askCalls = 0;
  fetchPlayerImpl = async () => ({ streamingData: {} });
  searchImpl = async () => [];
  pickImpl = () => [];
};
const ids = (r) => r.ordered.map(c => c.videoId);

test('已批准候选前置 + 已否决候选剔除，无未判则不问 AI', async () => {
  reset();
  verdictRows['t1@yt_a@stub-model'] = { ok: 1 };
  verdictRows['t1@yt_b@stub-model'] = { ok: 0 };
  const r = await aiRankCandidates(mkInfo('t1'), [cand('b'), cand('a')], null);
  assert.deepEqual(ids(r), ['a']);
  assert.equal(askCalls, 0);
});

test('AI 选定候选置首并回 pickedId；批准 verdict 延迟到取流成功', async () => {
  reset();
  aiScript = [{ pick: 2 }];
  const r = await aiRankCandidates(mkInfo('t2'), [cand('x'), cand('y'), cand('z')], null);
  assert.deepEqual(ids(r), ['y', 'x', 'z']);
  assert.equal(r.pickedId, 'y');
  // 关键：判定阶段不落库——批准承诺的是「是这首歌且能播」，得等 resolve 验证
  assert.equal(verdictWrites.length, 0);
});

test('AI 全否（pick:0）→ 仅剩已批准；否决不持久化', async () => {
  reset();
  aiScript = [{ pick: 0 }];
  verdictRows['t3@yt_ok@stub-model'] = { ok: 1 };
  const r = await aiRankCandidates(mkInfo('t3'), [cand('u'), cand('ok'), cand('v')], null);
  assert.deepEqual(ids(r), ['ok']);
  assert.equal(verdictWrites.length, 0);   // 全否不落库——一次误判不永久判死
});

test('AI 哑火/畸形返回 → 原序放行', async () => {
  reset();
  const info = mkInfo('t4');
  aiScript = [null];
  let r = await aiRankCandidates(info, [cand('a'), cand('b')], null);
  assert.deepEqual(ids(r), ['a', 'b']);
  aiScript = [{ pick: true }];             // 布尔混用形态——不得转成 1 假批准
  r = await aiRankCandidates(info, [cand('a'), cand('b')], null);
  assert.deepEqual(ids(r), ['a', 'b']);
  assert.equal(verdictWrites.length, 0);   // 关键：不能给未认可候选写 verdict
  aiScript = [{ pick: 9 }];                // 越界编号
  r = await aiRankCandidates(info, [cand('a'), cand('b')], null);
  assert.deepEqual(ids(r), ['a', 'b']);
});

test('AI 关闭 → 原序放行且零调用', async () => {
  reset();
  aiOn = false;
  const r = await aiRankCandidates(mkInfo('t5'), [cand('a'), cand('b')], null);
  assert.deepEqual(ids(r), ['a', 'b']);
  assert.equal(askCalls, 0);
});

test('resolve：AI 选定候选取流成功才落批准 verdict', async () => {
  reset();
  const info = mkInfo('r1');
  searchImpl = async () => [cand('x'), cand('y'), cand('z')];
  aiScript = [{ pick: 2 }];
  fetchPlayerImpl = async (vid) => ({ streamingData: { vid } });
  pickImpl = (sd) => [{ url: `u-${sd.vid}`, bitrate: 128 }];
  const r = await resolve(info, {});
  assert.equal(r.url, 'u-y');
  assert.deepEqual(verdictWrites, [{ vkey: 'r1@yt_y@stub-model', kind: 'unlock', ok: 1, detail: 't-y' }]);
});

test('resolve：选定候选取流失败不落 verdict，死候选不再喂回 AI', async () => {
  reset();
  const info = mkInfo('r2');
  searchImpl = async () => [cand('x'), cand('y'), cand('z')];
  aiScript = [{ pick: 2 }];
  fetchPlayerImpl = async (vid) => ({ streamingData: { vid } });
  pickImpl = (sd) => sd.vid === 'y' ? [] : [{ url: `u-${sd.vid}`, bitrate: 128 }];
  const r = await resolve(info, {});
  assert.equal(r.url, 'u-x');                  // y(选定)死 → x 兜底成功
  assert.equal(verdictWrites.length, 0);       // 批准不落库——x 不是 AI 选定
  // 第二次 resolve：y 在死簿不进 AI 候选池；AI 重选 x（pick:1 of [x,z]）
  aiScript = [{ pick: 1 }];
  const r2 = await resolve(info, {});
  assert.equal(r2.url, 'u-x');
  assert.deepEqual(verdictWrites, [{ vkey: 'r2@yt_x@stub-model', kind: 'unlock', ok: 1, detail: 't-x' }]);
});

test('同一候选反复取流失败 ≥2 次 → 升级 ok=0 verdict 永久剔除', async () => {
  reset();
  aiOn = false;                                // 无 AI 路径同样走死簿升级
  const info = mkInfo('r3');
  searchImpl = async () => [cand('d'), cand('w')];
  fetchPlayerImpl = async (vid) => ({ streamingData: { vid } });
  pickImpl = () => [];
  await resolve(info, {});                     // d/w 各死一次——还只是内存死簿
  assert.equal(verdictWrites.length, 0);
  await resolve(info, {});                     // 再死 → n=2 升级持久否决
  assert.deepEqual(verdictWrites.map(w => w.ok), [0, 0]);
  // 第三轮：ok=0 verdict 直接剔除，连候选序都进不去
  const r = await aiRankCandidates(info, [cand('d'), cand('w')], null);
  assert.deepEqual(r.ordered, []);
});

test('全否冷却按候选集生效：同集跳过 AI、新候选进榜即重评', async () => {
  reset();
  const info = mkInfo('r4');
  aiScript = [{ pick: 0 }];
  let r = await aiRankCandidates(info, [cand('u'), cand('v')], null);
  assert.deepEqual(r.ordered, []);
  assert.equal(askCalls, 1);
  // 同集再问 → 冷却命中，不烧 AI
  r = await aiRankCandidates(info, [cand('u'), cand('v')], null);
  assert.equal(askCalls, 1);
  // 新候选进榜 → 冷却不吞，重新评估
  aiScript = [{ pick: 3 }];
  r = await aiRankCandidates(info, [cand('u'), cand('v'), cand('w')], null);
  assert.equal(askCalls, 2);
  assert.equal(r.pickedId, 'w');
});

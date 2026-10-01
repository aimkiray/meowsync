// unlock/youtube.js 的 aiRankCandidates：判定记忆 + AI 择候选的行为钉。
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

const seed = (path, exports) => {
  const p = require.resolve(path);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
seed('../src/server/lib/youtube.js', {
  fetchPlayer: async () => ({}), innertubeSearch: async () => [], pickStreamList: () => [],
});
seed('../src/server/lib/ai.js', {
  aiEnabled: () => aiOn,
  askAiJson: async () => { askCalls += 1; return aiScript.length ? aiScript.shift() : null; },
  AI_MODEL: 'stub-model',
});
seed('../src/server/repositories/lyricAi.js', {
  getVerdict: (vkey) => verdictRows[vkey],
  upsertVerdict: (vkey, kind, ok, detail) => { verdictWrites.push({ vkey, kind, ok, detail }); },
});
const { aiRankCandidates } = require('../src/server/services/unlock/youtube.js');

const info = { id: 297501, name: '目标曲', artists: ['目标歌手'], keyword: '目标曲 - 目标歌手', durationMs: 200000 };
const cand = (id) => ({ videoId: id, title: `t-${id}`, owner: `o-${id}`, durationSec: 200 });
const reset = () => { aiOn = true; aiScript = []; verdictRows = {}; verdictWrites.length = 0; askCalls = 0; };

test('已批准候选前置 + 已否决候选剔除，无未判则不问 AI', async () => {
  reset();
  verdictRows['297501@yt_a@stub-model'] = { ok: 1 };
  verdictRows['297501@yt_b@stub-model'] = { ok: 0 };
  const r = await aiRankCandidates(info, [cand('b'), cand('a')], null);
  assert.deepEqual(r.map(c => c.videoId), ['a']);
  assert.equal(askCalls, 0);
});

test('AI 选定候选置首并落库批准 verdict', async () => {
  reset();
  aiScript = [{ pick: 2 }];
  const r = await aiRankCandidates(info, [cand('x'), cand('y'), cand('z')], null);
  assert.deepEqual(r.map(c => c.videoId), ['y', 'x', 'z']);
  assert.deepEqual(verdictWrites, [{ vkey: '297501@yt_y@stub-model', kind: 'unlock', ok: 1, detail: 't-y' }]);
});

test('AI 全否（pick:0）→ 仅剩已批准；否决不持久化', async () => {
  reset();
  aiScript = [{ pick: 0 }];
  verdictRows['297501@yt_ok@stub-model'] = { ok: 1 };
  const r = await aiRankCandidates(info, [cand('u'), cand('ok'), cand('v')], null);
  assert.deepEqual(r.map(c => c.videoId), ['ok']);
  assert.equal(verdictWrites.length, 0);   // 全否不落库——一次误判不永久判死
});

test('AI 哑火/畸形返回 → 原序放行', async () => {
  reset();
  aiScript = [null];
  let r = await aiRankCandidates(info, [cand('a'), cand('b')], null);
  assert.deepEqual(r.map(c => c.videoId), ['a', 'b']);
  aiScript = [{ pick: true }];             // 布尔混用形态
  r = await aiRankCandidates(info, [cand('a'), cand('b')], null);
  assert.deepEqual(r.map(c => c.videoId), ['a', 'b']);
  aiScript = [{ pick: 9 }];                // 越界编号
  r = await aiRankCandidates(info, [cand('a'), cand('b')], null);
  assert.deepEqual(r.map(c => c.videoId), ['a', 'b']);
});

test('AI 关闭 → 原序放行且零调用', async () => {
  reset();
  aiOn = false;
  const r = await aiRankCandidates(info, [cand('a'), cand('b')], null);
  assert.deepEqual(r.map(c => c.videoId), ['a', 'b']);
  assert.equal(askCalls, 0);
});

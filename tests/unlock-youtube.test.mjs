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
// lib/youtube 搜索 + services/youtube-resolve 取流做成可变桩——
// resolve 级用例要改取流行为（闸控感知解析已下沉，此处桩在编排接缝上）
let resolveStreamsImpl = async () => ({ streams: [] });
let searchImpl = async () => [];

import { seed } from './helpers.mjs';
seed('../src/server/lib/youtube.js', {
  innertubeSearch: (...a) => searchImpl(...a),
});
seed('../src/server/services/youtube-resolve.js', {
  resolveYoutubeStreams: (...a) => resolveStreamsImpl(...a),
});
seed('../src/server/lib/ai.js', {
  aiEnabled: () => aiOn,
  askAiJson: async () => { askCalls += 1; return aiScript.length ? aiScript.shift() : null; },
  aiModel: () => 'stub-model',
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
  resolveStreamsImpl = async () => ({ streams: [] });
  searchImpl = async () => [];
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
  resolveStreamsImpl = async (vid) => ({
    streams: [{ url: `u-${vid}-1`, br: 128 }, { url: `u-${vid}-2`, br: null }]
  });
  const r = await resolve(info, {});
  assert.equal(r.url, 'u-y-1');
  // 回链单实体：跨码率/编码候选是不同字节文件，混排换档会把同一 offset
  // 的另一文件字节拼给客户端——只下发首链（bilibili 同字节镜像先例的反面）
  assert.deepEqual(r.urls, ['u-y-1']);
  assert.deepEqual(verdictWrites, [{ vkey: 'r1@yt_y@stub-model', kind: 'unlock', ok: 1, detail: 't-y' }]);
});

test('resolve：选定候选取流失败不落 verdict，死候选不再喂回 AI', async () => {
  reset();
  const info = mkInfo('r2');
  searchImpl = async () => [cand('x'), cand('y'), cand('z')];
  aiScript = [{ pick: 2 }];
  resolveStreamsImpl = async (vid) => ({
    streams: vid === 'y' ? [] : [{ url: `u-${vid}`, br: 128 }]
  });
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
  resolveStreamsImpl = async () => ({ streams: [] });
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

// 搜索真空降级钉板：只在 items 零条目时剥歌名尾缀版本修饰重试一次——
// 时长筛空/AI 全否是「搜到了但不配」，换词重搜没有依据不该触发
test('resolve：首搜零条目触发降级重试——剥尾缀括号重建 name - artists', async () => {
  reset();
  const info = {
    id: 'd1', name: 'ぱられループ を歌ってみた (2024 Radio Edit)',
    artists: ['Jeku'], keyword: 'ぱられループ を歌ってみた (2024 Radio Edit) - Jeku',
    durationMs: 200000,
  };
  const seen = [];
  searchImpl = async (kw) => { seen.push(kw); return seen.length === 1 ? [] : [cand('y')]; };
  aiOn = false;
  resolveStreamsImpl = async (vid) => ({ streams: [{ url: `u-${vid}`, br: 128 }] });
  const r = await resolve(info, {});
  assert.equal(seen.length, 2, '零条目必须起第二跳');
  assert.equal(seen[0], info.keyword, '首跳用原 keyword');
  assert.equal(seen[1], 'ぱられループ を歌ってみた - Jeku', '次跳剥 (2024 Radio Edit) 尾缀重建');
  assert.equal(r.url, 'u-y');
});

test('resolve：非零条目不降级——name 带尾缀括号但首搜有候选只打一跳', async () => {
  reset();
  const info = {
    id: 'd2', name: '曲名 (Live)', artists: ['a'],
    keyword: '曲名 (Live) - a', durationMs: 200000,
  };
  const seen = [];
  searchImpl = async (kw) => { seen.push(kw); return [cand('y')]; };
  aiOn = false;
  resolveStreamsImpl = async (vid) => ({ streams: [{ url: `u-${vid}`, br: 128 }] });
  const r = await resolve(info, {});
  assert.equal(seen.length, 1, '有候选即消费——版本后缀是否可剥与本路无关');
  assert.equal(r.url, 'u-y');
});

test('resolve：剥无可剥（无尾缀括号）零条目不白打第二跳；降级仍零回 null', async () => {
  reset();
  // 尾缀无括号（繭色型）——剥后词与原词相同，第二跳注定同结果必须省
  const info = {
    id: 'd3', name: '繭色', artists: ['sajou no hana'],
    keyword: '繭色 - sajou no hana', durationMs: 200000,
  };
  const seen = [];
  searchImpl = async (kw) => { seen.push(kw); return []; };
  assert.equal(await resolve(info, {}), null);
  assert.equal(seen.length, 1, 'degraded===keyword 时重试无意义——只打一跳');
  // 多段尾缀连剥 + 全/半角混排（【Cover】(2024 Remaster) 一串两段）
  const info2 = {
    id: 'd4', name: '曲名【Cover】(2024 Remaster)', artists: ['a'],
    keyword: '曲名【Cover】(2024 Remaster) - a', durationMs: 200000,
  };
  seen.length = 0;
  assert.equal(await resolve(info2, {}), null);
  assert.equal(seen.length, 2);
  assert.equal(seen[1], '曲名 - a', '连续尾缀括号群整串剥掉');
});

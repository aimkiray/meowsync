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
let askArgs = null;              // 最近一次 askAiJson 实参（仲裁用例钉 prompt 候选面）
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
  askAiJson: async (opts) => { askCalls += 1; askArgs = opts; return aiScript.length ? aiScript.shift() : null; },
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
  aiOn = true; aiScript = []; verdictRows = {}; verdictWrites.length = 0;
  askCalls = 0; askArgs = null;
  resolveStreamsImpl = async () => ({ streams: [] });
  searchImpl = async () => [];
};
// console.info 捕获——仲裁留痕/否决语境的行断言（用完须 finally 还原）
const captureInfo = () => {
  const logs = [];
  const orig = console.info;
  console.info = (...a) => logs.push(a.join(' '));
  return { logs, restore: () => { console.info = orig; } };
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

// ── ±5s 时长筛全灭仲裁池（durationPool 三态池接线钉板）─────────────────
// ±5s 硬筛比编排层 DURATION_TOLERANCE(youtube 0.4)严一个量级——官方上传/
// MV 带片头尾超窗却是真命候选（实机假阴性）：筛空不弃，全候选交 AI 仲裁
const offSec = (id, sec) => ({ ...cand(id), durationSec: sec });

test('resolve：±5s 全灭但有候选 → 不早退，全候选交 AI 仲裁，选中照常取流', async () => {
  reset();
  const info = mkInfo('a1');                       // durationMs 200s
  // 候选 235~240s 全超 ±5s 窗（17.5%~20% 偏差仍在编排层 0.4 闸内）
  searchImpl = async () => [offSec('x', 235), offSec('y', 240), offSec('z', 236)];
  aiScript = [{ pick: 2 }];
  resolveStreamsImpl = async (vid) => ({ streams: [{ url: `u-${vid}`, br: 128 }] });
  const cap = captureInfo();
  let r;
  try { r = await resolve(info, {}); } finally { cap.restore(); }
  assert.equal(r.url, 'u-y', '仲裁后 AI 选中者照常取流');
  // AI 收到全候选（非 ±5s 筛后空集）——候选行逐条在 prompt
  assert.ok(askArgs, 'AI 必须被问到（仲裁池不该早退）');
  for (const [i, id] of ['x', 'y', 'z'].entries()) {
    assert.ok(askArgs.user.includes(`${i + 1}. t-${id}`), `候选 ${id} 应进 prompt`);
  }
  // 仲裁留痕：诊断链不许把「筛空交仲裁」写成「源未产出候选」
  assert.ok(cap.logs.some(l => l.includes('youtube: ±5s 时长筛全灭') && l.includes('3 候选交 AI 仲裁')),
    `缺仲裁留痕，实得: ${JSON.stringify(cap.logs)}`);
  // AI 选定 + 取流验证成功 → 批准 verdict 照常落库
  assert.deepEqual(verdictWrites, [{ vkey: 'a1@yt_y@stub-model', kind: 'unlock', ok: 1, detail: 't-y' }]);
});

test('resolve：仲裁池 AI 全否（pick:0）→ 照旧 null，不打取流', async () => {
  reset();
  const info = mkInfo('a2');
  searchImpl = async () => [offSec('x', 235), offSec('y', 240)];
  aiScript = [{ pick: 0 }];
  let streamCalls = 0;
  resolveStreamsImpl = async () => { streamCalls += 1; return { streams: [{ url: 'u', br: 1 }] }; };
  assert.equal(await resolve(info, {}), null);
  assert.equal(streamCalls, 0, 'AI 全否 → ordered 空 → 不白打取流');
});

test('resolve：仲裁池照常过判定记忆——ok=0 候选不进 AI 池也不取流', async () => {
  reset();
  const info = mkInfo('a3');
  verdictRows['a3@yt_x@stub-model'] = { ok: 0 };     // 否决记忆对仲裁池同口径
  searchImpl = async () => [offSec('x', 235), offSec('y', 240)];
  aiScript = [{ pick: 1 }];                        // 未判池只剩 y → pick:1=y
  const seenStreams = [];
  resolveStreamsImpl = async (vid) => { seenStreams.push(vid); return { streams: [{ url: `u-${vid}`, br: 128 }] }; };
  const r = await resolve(info, {});
  assert.equal(r.url, 'u-y');
  assert.ok(askArgs && !askArgs.user.includes('t-x'), 'ok=0 候选不进 AI prompt');
  assert.deepEqual(seenStreams, ['y'], '被否决候选不取流');
});

test('resolve：仲裁池全被判定记忆否决 → null，否决留痕带仲裁语境', async () => {
  reset();
  aiOn = false;
  const info = mkInfo('a4');
  verdictRows['a4@yt_x@stub-model'] = { ok: 0 };
  verdictRows['a4@yt_y@stub-model'] = { ok: 0 };
  searchImpl = async () => [offSec('x', 235), offSec('y', 240)];
  const cap = captureInfo();
  try { assert.equal(await resolve(info, {}), null); } finally { cap.restore(); }
  assert.ok(cap.logs.some(l => l.includes('±5s 时长筛全灭')), '仲裁留痕在');
  assert.ok(cap.logs.some(l => l.includes('全部被判定记忆否决') && l.includes('仲裁池')),
    `否决语境须区分仲裁池，实得: ${JSON.stringify(cap.logs)}`);
});

test('resolve：durationMs 缺席维持旧路径——前 3 条原序、不打仲裁留痕', async () => {
  reset();
  aiOn = false;
  const info = { ...mkInfo('a5'), durationMs: null };
  searchImpl = async () => [cand('x'), cand('y'), cand('z'), cand('w')];  // 4 条取前 3
  const seenStreams = [];
  resolveStreamsImpl = async (vid) => { seenStreams.push(vid); return { streams: [] }; };
  const cap = captureInfo();
  try { assert.equal(await resolve(info, {}), null); } finally { cap.restore(); }
  assert.deepEqual(seenStreams, ['x', 'y', 'z'], '无基准仍只放前 3 条原序');
  assert.ok(!cap.logs.some(l => l.includes('仲裁')), '无基准不触发仲裁语义');
});

// ── 仲裁池缺时长候选稳定划分（durOk 押尾）────────────────────────────
// durationSec 非正（lockupItem 无角标兜底 0/videoItemOf 缺字段归 null）
// 的候选胜出链是 googlevideo——裸 HEAD 毒化签名链被编排层刻意跳过 →
// estMs null → 时长对账静默缺位。划分保各组内相对序：可对账候选先
// 试错，缺时长全灭后才被摸
test('resolve：仲裁池缺时长候选稳定押尾——可对账候选保相对序在前先试错', async () => {
  reset();
  aiOn = false;
  const info = mkInfo('a6');                           // durationMs 200s
  // 0/null 双坏形态都在池——全超 ±5s 窗进仲裁
  searchImpl = async () => [offSec('nodur', 0), offSec('x', 235), offSec('nulldur', null), offSec('y', 240)];
  const seenStreams = [];
  resolveStreamsImpl = async (vid) => { seenStreams.push(vid); return { streams: [] }; };  // 全灭看序
  await resolve(info, {});
  assert.deepEqual(seenStreams, ['x', 'y', 'nodur', 'nulldur'],
    '正时长保相对序在前，缺时长（0 与 null 同病）保相对序押尾');
});

test('resolve：仲裁池划分不扰 AI 语义序——正时长选中仍在首；缺时长胜出留痕', async () => {
  reset();
  const info = mkInfo('a7');
  // unjudged=[nodur,x,y]，AI 选 y（pick:3）→ ranked=[y,nodur,x]
  // 划分后 [y,x,nodur]——AI 选中（正时长）仍在首，缺时长只在全灭后被摸
  searchImpl = async () => [offSec('nodur', 0), offSec('x', 235), offSec('y', 240)];
  aiScript = [{ pick: 3 }];
  const seenStreams = [];
  resolveStreamsImpl = async (vid) => {
    seenStreams.push(vid);
    return { streams: vid === 'nodur' ? [{ url: 'u-nodur', br: 128 }] : [] };
  };
  const cap = captureInfo();
  let r;
  try { r = await resolve(info, {}); } finally { cap.restore(); }
  assert.deepEqual(seenStreams, ['y', 'x', 'nodur'],
    'AI 选中的正时长候选仍首位取流；缺时长候选排最后');
  assert.equal(r.url, 'u-nodur', '可对账候选全灭后缺时长候选兜底胜出');
  assert.equal(r.durationSec, 0, '胜出形如实下发——缺时长字段不谎报');
  assert.ok(cap.logs.some(l => l.includes('youtube: 仲裁选中候选缺时长字段') && l.includes('对账缺位')),
    `缺时长胜出须留痕，实得: ${JSON.stringify(cap.logs)}`);
  assert.equal(verdictWrites.length, 0, 'AI 选中的 y 死、胜出非选定——都不落 verdict');
});

test('resolve：非仲裁池缺时长候选序不变——durationMs 缺席无对账基准，划分是仲裁池限定', async () => {
  reset();
  aiOn = false;
  const info = { ...mkInfo('a8'), durationMs: null };  // 无基准 → 前 3 原序非仲裁
  searchImpl = async () => [offSec('nodur', 0), cand('x'), cand('y')];
  const seenStreams = [];
  resolveStreamsImpl = async (vid) => { seenStreams.push(vid); return { streams: [] }; };
  await resolve(info, {});
  assert.deepEqual(seenStreams, ['nodur', 'x', 'y'], '非仲裁路径原序不动——缺时长不押尾');
});

// unlock/bilibili.js：SSR 岛搜索 → 时长筛 → AI 核验（共享 ai-rank 面，bv_ 键域）
// → playurl 取流的行为钉。覆盖：产出形（同字节镜像组/br/durationSec/ext）、
// 播放档 mp4 优选、零候选/全否决/取流失败分支、搜索段与取流段的
// transient 标记、风控码归墙（-352/-412/-799）、bvid 去重防同 deadKey
// 连死升级、搜索真空降级重试、死簿升级否决、forgetSong 的 bv_ 前缀清。
// 依赖播种口径同 unlock-youtube.test.mjs：lib/bilibili、lib/ai、
// repositories/lyricAi 预播种；bv_ verdict 删除直走 db/client——另播
// getDb 桩录 prepare().run() 实参（yt_ 侧走 repo 删除函数，bv_ 侧没有
// 对应 repo 导出，GLOB 语义在 ai-rank.js 内复刻）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { seed } from './helpers.mjs';

const require = createRequire(import.meta.url);

let aiOn = true;
let aiScript = [];                 // askAiJson 依次返回
let verdictRows = {};              // vkey → {ok}
const verdictWrites = [];          // upsertVerdict 记录
let askCalls = 0;
let askArgs = null;              // 最近一次 askAiJson 实参（仲裁用例钉 prompt 候选面）
let searchImpl = async () => ({ items: [] });
let audioImpl = async () => [];
const delCalls = [];               // getDb().prepare(sql).run(...args) 记录

// 编排层 transient 判据的最小复刻（netease-api.js UNLOCK_TRANSIENT_RE
// 私有表）——断言「会被归 transient」直接吃同一正则而非绕路 mock 分类器
const TRANSIENT_LIKE_RE = /HTTP (5\d\d|429)|超时|timed?\s*out|abort|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket hang up/i;

seed('../src/server/lib/bilibili.js', {
  biliSearchVideos: (...a) => searchImpl(...a),
  resolveBiliAudio: (...a) => audioImpl(...a),
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
seed('../src/server/db/client.js', {
  getDb: () => ({
    prepare: (sql) => ({ run: (...args) => { delCalls.push({ sql, args }); return { changes: 1 }; } }),
  }),
});
const { resolve, aiRankCandidates, forgetSong } = require('../src/server/services/unlock/bilibili.js');

// 每用例独立 info.id：死簿/全否冷却以曲为键，共用 id 会跨用例泄漏
const mkInfo = (id) => ({ id, name: '目标曲', artists: ['目标歌手'], keyword: '目标曲 - 目标歌手', durationMs: 200000 });
// 搜索行 = lib/bilibili videoItemToRow 产出形（bvid/title/author/durationSec）
const row = (bvid, sec = 200) => ({ bvid, title: `t-${bvid}`, author: `a-${bvid}`, durationSec: sec });
const cand = (id) => ({ videoId: id, title: `t-${id}`, owner: `o-${id}`, durationSec: 200 });
const reset = () => {
  aiOn = true; aiScript = []; verdictRows = {}; verdictWrites.length = 0;
  askCalls = 0; askArgs = null;
  searchImpl = async () => ({ items: [] });
  audioImpl = async () => [];
  delCalls.length = 0;
};
// console.info 捕获——仲裁留痕/否决语境的行断言（用完须 finally 还原）
const captureInfo = () => {
  const logs = [];
  const orig = console.info;
  console.info = (...a) => logs.push(a.join(' '));
  return { logs, restore: () => { console.info = orig; } };
};
const ids = (r) => r.ordered.map(c => c.videoId);

test('搜索→时长筛→取流→产出：同 path 镜像成组、跨档截断、br/durationSec 落位', async () => {
  reset();
  aiOn = false;
  searchImpl = async () => ({ items: [row('BV1aaa'), row('BV1bbb')] });
  audioImpl = async ({ bvid }) => [
    { url: `https://upos-sz-m1.bilivideo.com/ugax/${bvid}-30280.m4s?s=1`, mimeType: 'audio/mp4', br: 192000 },
    { url: `https://upos-sz-m2.bilivideo.com/ugax/${bvid}-30280.m4s?s=2`, mimeType: 'audio/mp4', br: 192000 },
    // 下一档（30232）——path 不同即不同字节实体，绝不许混进镜像组
    { url: `https://upos-sz-m1.bilivideo.com/ugax/${bvid}-30232.m4s?s=1`, mimeType: 'audio/mp4', br: 108000 },
  ];
  const r = await resolve(mkInfo('b1'), {});
  assert.equal(r.url, 'https://upos-sz-m1.bilivideo.com/ugax/BV1aaa-30280.m4s?s=1');
  assert.deepEqual(r.urls, [
    'https://upos-sz-m1.bilivideo.com/ugax/BV1aaa-30280.m4s?s=1',
    'https://upos-sz-m2.bilivideo.com/ugax/BV1aaa-30280.m4s?s=2',
  ], '镜像组只收与首条同 pathname 的连续前缀');
  assert.equal(r.br, 192000);
  assert.equal(r.durationSec, 200, 'durationSec 取搜索行稿件时长（与时长筛同基准）');
});

test('播放档优先 audio/mp4 轨作头；下载档保 best 首项（flac）', async () => {
  reset();
  aiOn = false;
  searchImpl = async () => ({ items: [row('BV1mix')] });
  audioImpl = async ({ bvid }) => [
    { url: `https://upos.bilivideo.com/ugax/${bvid}-flac.flac?s=1`, mimeType: 'audio/flac', br: 900000 },
    { url: `https://upos.bilivideo.com/ugax/${bvid}-30280.m4s?s=1`, mimeType: 'audio/mp4', br: 192000 },
  ];
  const play = await resolve(mkInfo('b2'), { purpose: 'playback' });
  assert.match(play.url, /-30280\.m4s/, '播放档跳过 flac 选 m4a 头——Safari/旧浏览器放不了 flac');
  assert.equal(play.br, 192000);
  const dl = await resolve(mkInfo('b3'), { purpose: 'download' });
  assert.match(dl.url, /-flac\.flac/, '下载档保 best 首项——无损优先是归档语义');
  assert.equal(dl.br, 900000);
});

test('零候选：搜索空回与时长筛全灭都回 null', async () => {
  reset();
  aiOn = false;
  searchImpl = async () => ({ items: [] });
  assert.equal(await resolve(mkInfo('b4'), {}), null);
  // 时长超窗（±5s 外）——筛空交 AI 仲裁池（新语义），AI 关闭原序放行后
  // 取流全灭仍归 null（null 结局同、路径已换：不再是筛空早退）
  searchImpl = async () => ({ items: [row('BV1far', 240)] });
  assert.equal(await resolve(mkInfo('b5'), {}), null);
  // keyword/name 守门（youtube 同款）
  assert.equal(await resolve({ id: 'b6', keyword: '', name: '' }, {}), null);
});

test('判定记忆全否决（ok=0）→ 候选序为空回 null，且不再打搜索外任何一跳', async () => {
  reset();
  aiOn = false;
  verdictRows['b7@bv_BV1x@stub-model'] = { ok: 0 };
  verdictRows['b7@bv_BV1y@stub-model'] = { ok: 0 };
  searchImpl = async () => ({ items: [row('BV1x'), row('BV1y')] });
  let audioCalls = 0;
  audioImpl = async () => { audioCalls += 1; return [{ url: 'u', mimeType: 'audio/mp4', br: 1 }]; };
  assert.equal(await resolve(mkInfo('b7'), {}), null);
  assert.equal(audioCalls, 0, '全否决早退——不白打 playurl');
});

test('AI 选定候选置首、取流成功落 bv_ 批准 verdict', async () => {
  reset();
  const info = mkInfo('b8');
  searchImpl = async () => ({ items: [row('BVx'), row('BVy'), row('BVz')] });
  aiScript = [{ pick: 2 }];
  audioImpl = async ({ bvid }) => [{ url: `u-${bvid}`, mimeType: 'audio/mp4', br: 128000 }];
  const r = await resolve(info, {});
  assert.equal(r.url, 'u-BVy');
  assert.deepEqual(verdictWrites, [
    { vkey: 'b8@bv_BVy@stub-model', kind: 'unlock', ok: 1, detail: 't-BVy' },
  ], '批准 verdict 键域是 <曲id>@bv_<bvid>@<模型>');
});

test('AI 全否（pick:0）→ 全否冷却；否决不持久化', async () => {
  reset();
  const info = mkInfo('b9');
  aiScript = [{ pick: 0 }];
  let r = await aiRankCandidates(info, [cand('u'), cand('v')], null);
  assert.deepEqual(r.ordered, []);
  assert.equal(askCalls, 1);
  r = await aiRankCandidates(info, [cand('u'), cand('v')], null);
  assert.equal(askCalls, 1, '同候选集命中全否冷却');
  assert.equal(verdictWrites.length, 0);
});

test('取流失败分支：空音轨候选死簿押尾续试下一候选；全灭回 null', async () => {
  reset();
  aiOn = false;
  const info = mkInfo('b10');
  searchImpl = async () => ({ items: [row('BVdead'), row('BVlive')] });
  audioImpl = async ({ bvid }) =>
    (bvid === 'BVlive' ? [{ url: 'u-live', mimeType: 'audio/mp4', br: 128000 }] : []);
  const r = await resolve(info, {});
  assert.equal(r.url, 'u-live', '死候选押后续试');
  assert.equal(verdictWrites.length, 0, '单死一次只在内存死簿——不升级 verdict');
  // 全灭回 null（非风控错形态）
  audioImpl = async () => [];
  assert.equal(await resolve(mkInfo('b11'), {}), null);
});

test('死簿 n>=2 升级 ok=0 verdict（bv_ 键域），再排序直接剔除', async () => {
  reset();
  aiOn = false;
  const info = mkInfo('b12');
  searchImpl = async () => ({ items: [row('BVd'), row('BVw')] });
  audioImpl = async () => [];
  await resolve(info, {});
  assert.equal(verdictWrites.length, 0);
  await resolve(info, {});
  assert.deepEqual(verdictWrites.map(w => w.ok), [0, 0]);
  assert.ok(verdictWrites.every(w => w.vkey.startsWith('b12@bv_')), '否决键前缀 bv_');
  const r = await aiRankCandidates(info, [cand('BVd'), cand('BVw')], null);
  assert.deepEqual(r.ordered, []);
});

test('取流段 412 风控：不进死簿、全灭抛 transient 标记错', async () => {
  reset();
  aiOn = false;
  const info = mkInfo('b13');
  searchImpl = async () => ({ items: [row('BVx'), row('BVy')] });
  audioImpl = async () => { throw new Error('bilibili /x/player/playurl HTTP 412'); };
  const err = await resolve(info, {}).then(() => null, (e) => e);
  assert.ok(err instanceof Error, '风控全灭须抛错而非回 null（真因透出）');
  assert.match(err.message, /HTTP 429/, '须带「HTTP 429 等价」可识别标记');
  assert.ok(TRANSIENT_LIKE_RE.test(err.message), '按编排层判据归 transient');
  // 不进死簿的旁证：同候选重排不押尾（markDead 会把它按进尾段）
  const r = await aiRankCandidates(info, [cand('BVx'), cand('BVy')], null);
  assert.deepEqual(ids(r), ['BVx', 'BVy']);
  assert.equal(verdictWrites.length, 0, '墙证据绝不升级 ok=0 verdict');
});

// SF-1：-352（风控校验失败）与 -799（请求过于频繁——限流同族码）同属
// IP 信誉证据——归墙不进死簿、全灭抛 transient 标记错，与 -412 同口径
test('取流段 code=-352/-799 风控：归墙不进死簿、全灭抛 transient 标记错', async () => {
  reset();
  aiOn = false;
  const info = mkInfo('b17');
  searchImpl = async () => ({ items: [row('BVx'), row('BVy')] });
  audioImpl = async () => { throw new Error('bilibili /x/player/playurl code=-352 风控校验失败'); };
  const err = await resolve(info, {}).then(() => null, (e) => e);
  assert.ok(err instanceof Error, '-352 风控全灭须抛错而非回 null');
  assert.match(err.message, /HTTP 429/, '须带「HTTP 429 等价」可识别标记');
  assert.ok(TRANSIENT_LIKE_RE.test(err.message), '按编排层判据归 transient');
  // 不进死簿：同候选重排不押尾、不升级 verdict（此前 -352 漏判会 markDead
  // ——两次 resolve 即 n=2 把健康候选写成 ok=0 永久否决）
  const r = await aiRankCandidates(info, [cand('BVx'), cand('BVy')], null);
  assert.deepEqual(ids(r), ['BVx', 'BVy']);
  assert.equal(verdictWrites.length, 0, '墙证据绝不升级 ok=0 verdict');
  // -799 限流同族码同口径
  const info2 = mkInfo('b18');
  audioImpl = async () => { throw new Error('bilibili /x/player/playurl code=-799 请求过于频繁，请稍后再试'); };
  const err2 = await resolve(info2, {}).then(() => null, (e) => e);
  assert.ok(TRANSIENT_LIKE_RE.test(err2.message), `-799 须归 transient，实得: ${err2.message}`);
  const r2 = await aiRankCandidates(info2, [cand('BVx'), cand('BVy')], null);
  assert.deepEqual(ids(r2), ['BVx', 'BVy'], '-799 同样不进死簿');
  assert.equal(verdictWrites.length, 0);
});

// SF-2：provider 显式供 ext——选定流真实容器（.m4s 链走 extOf 会错落 mp3）
test('产出带 ext：按流表 mimeType 供容器后缀，mime 缺席退 pathname 白名单', async () => {
  reset();
  aiOn = false;
  searchImpl = async () => ({ items: [row('BVext')] });
  audioImpl = async ({ bvid }) => [
    { url: `https://upos.bilivideo.com/ugax/${bvid}-flac.flac?s=1`, mimeType: 'audio/flac', br: 900000 },
    { url: `https://upos.bilivideo.com/ugax/${bvid}-30280.m4s?s=1`, mimeType: 'audio/mp4', br: 192000 },
  ];
  const play = await resolve(mkInfo('b19'), { purpose: 'playback' });
  assert.equal(play.ext, 'm4a', 'audio/mp4 轨 → m4a（播放档选中 AAC 头）');
  const dl = await resolve(mkInfo('b20'), { purpose: 'download' });
  assert.equal(dl.ext, 'flac', '下载档 best 首项 flac → flac');
  // mime 缺席 → pathname 尾缀白名单；.m4s 段标记不在名单归 null 交编排层兜底
  audioImpl = async () => [{ url: 'https://upos.bilivideo.com/ugax/x-30280.m4s?s=1', br: 64000 }];
  const r = await resolve(mkInfo('b21'), {});
  assert.equal(r.ext, null, 'mime 缺席 + .m4s → null（宁缺不谎报）');
});

// N-7：SSR 岛重复下发同 bvid 去重——同 deadKey 一次 resolve 内连死两次
// 会直接 n=2 升级 ok=0 verdict（健康候选永久误判）
test('候选按 bvid 去重：同 deadKey 单次 resolve 内不连记两次死', async () => {
  reset();
  aiOn = false;
  const info = mkInfo('b22');
  // 同 bvid 占两个候选位 + 一个异 bvid——去重后应只剩 2 候选
  searchImpl = async () => ({ items: [row('BVdup'), row('BVdup'), row('BVok')] });
  const audioCalls = [];
  audioImpl = async ({ bvid }) => { audioCalls.push(bvid); return []; };
  await resolve(info, {});
  assert.deepEqual(audioCalls, ['BVdup', 'BVok'], '重复 bvid 只取流一次');
  // 单次死留内存死簿不升级——未去重时 BVdup 连死两次会立刻写 ok=0
  assert.equal(verdictWrites.length, 0, '同 deadKey 未连记两次——不升级 ok=0 verdict');
});

// N-11：搜索真空降级重试（共享 match.js degradedKeyword）——只在 items
// 零条目时触发；剥后与原词相同不白打第二跳
test('首搜零条目触发降级重试：剥尾缀括号重建 name - artists 词', async () => {
  reset();
  aiOn = false;
  const info = {
    id: 'b23', name: '曲名 (2024 Remaster)', artists: ['a'],
    keyword: '曲名 (2024 Remaster) - a', durationMs: 200000,
  };
  const seen = [];
  searchImpl = async (kw) => {
    seen.push(kw);
    return { items: seen.length === 1 ? [] : [row('BVhit')] };
  };
  audioImpl = async () => [{ url: 'u-hit', mimeType: 'audio/mp4', br: 128000 }];
  const r = await resolve(info, {});
  assert.equal(seen.length, 2, '零条目必须起第二跳');
  assert.equal(seen[0], info.keyword, '首跳用原 keyword');
  assert.equal(seen[1], '曲名 - a', '次跳剥 (2024 Remaster) 尾缀重建');
  assert.equal(r.url, 'u-hit');
});

test('非零条目不降级 + 剥无可剥不白打第二跳；降级仍零回 null', async () => {
  reset();
  aiOn = false;
  const seen = [];
  searchImpl = async (kw) => { seen.push(kw); return { items: [row('BVy')] }; };
  audioImpl = async () => [{ url: 'u-y', mimeType: 'audio/mp4', br: 1 }];
  const info = {
    id: 'b24', name: '曲名 (Live)', artists: ['a'],
    keyword: '曲名 (Live) - a', durationMs: 200000,
  };
  assert.equal((await resolve(info, {})).url, 'u-y');
  assert.equal(seen.length, 1, '有候选即消费——可剥尾缀也不起第二跳');
  // 零条目但剥后词与原词相同 → 重试无意义必须省
  seen.length = 0;
  searchImpl = async (kw) => { seen.push(kw); return { items: [] }; };
  const info2 = {
    id: 'b25', name: '繭色', artists: ['sajou no hana'],
    keyword: '繭色 - sajou no hana', durationMs: 200000,
  };
  assert.equal(await resolve(info2, {}), null);
  assert.equal(seen.length, 1, 'degraded===keyword 时只打一跳');
});

test('搜索段失败按 transient 抛：412 加标记、5xx 原样透传', async () => {
  reset();
  aiOn = false;
  searchImpl = async () => { throw new Error('bilibili search HTTP 412'); };
  const e1 = await resolve(mkInfo('b14'), {}).then(() => null, (e) => e);
  assert.ok(TRANSIENT_LIKE_RE.test(e1.message), `412 须归 transient，实得: ${e1.message}`);
  assert.match(e1.message, /等价/);
  searchImpl = async () => { throw new Error('bilibili search HTTP 520'); };
  const e2 = await resolve(mkInfo('b15'), {}).then(() => null, (e) => e);
  assert.equal(e2.message, 'bilibili search HTTP 520', '已命中 transient 形态的不加标记原样透传');
});

test('forgetSong：死簿/冷却按曲前缀清 + bv_ 前缀 GLOB 删 verdict', async () => {
  reset();
  aiOn = false;
  const info = mkInfo('b16');
  // 播种死簿：BVa 死一次
  searchImpl = async () => ({ items: [row('BVa')] });
  audioImpl = async () => [];
  await resolve(info, {});
  let r = await aiRankCandidates(info, [cand('BVa'), cand('BVb')], null);
  assert.deepEqual(ids(r), ['BVb', 'BVa'], '死候选应押尾');
  forgetSong('b16');
  assert.equal(delCalls.length, 1, 'verdict 删除恰一次');
  assert.match(delCalls[0].sql, /song_ai_verdict/);
  assert.deepEqual(delCalls[0].args, ['b16@bv_*'], 'GLOB 前缀 <sid>@bv_*');
  r = await aiRankCandidates(info, [cand('BVa'), cand('BVb')], null);
  assert.deepEqual(ids(r), ['BVa', 'BVb'], '死簿清后回原序');
});

// ── ±5s 时长筛全灭仲裁池（durationPool 三态池接线钉板，youtube 同款）───
// ±5s 硬筛比编排层 DURATION_TOLERANCE(default 0.2)严一个量级——搬运稿件
// 片头尾超窗却是真命候选（实机假阴性）：筛空不弃，全候选交 AI 仲裁
test('±5s 全灭但有候选 → 不早退，全候选交 AI 仲裁，选中照常取流', async () => {
  reset();
  const info = mkInfo('bb1');                       // durationMs 200s
  // 候选 215~220s 全超 ±5s 窗（7.5%~10% 偏差仍在编排层 0.2 闸内）
  searchImpl = async () => ({ items: [row('BVx', 215), row('BVy', 220), row('BVz', 216)] });
  aiScript = [{ pick: 2 }];
  audioImpl = async ({ bvid }) => [{ url: `u-${bvid}`, mimeType: 'audio/mp4', br: 128000 }];
  const cap = captureInfo();
  let r;
  try { r = await resolve(info, {}); } finally { cap.restore(); }
  assert.equal(r.url, 'u-BVy', '仲裁后 AI 选中者照常取流');
  // AI 收到全候选（非 ±5s 筛后空集）——候选行逐条在 prompt
  assert.ok(askArgs, 'AI 必须被问到（仲裁池不该早退）');
  for (const [i, id] of ['BVx', 'BVy', 'BVz'].entries()) {
    assert.ok(askArgs.user.includes(`${i + 1}. t-${id}`), `候选 ${id} 应进 prompt`);
  }
  // 仲裁留痕：诊断链不许把「筛空交仲裁」写成「源未产出候选」
  assert.ok(cap.logs.some(l => l.includes('bilibili: ±5s 时长筛全灭') && l.includes('3 候选交 AI 仲裁')),
    `缺仲裁留痕，实得: ${JSON.stringify(cap.logs)}`);
  assert.deepEqual(verdictWrites, [
    { vkey: 'bb1@bv_BVy@stub-model', kind: 'unlock', ok: 1, detail: 't-BVy' },
  ], 'AI 选定 + 取流验证成功 → bv_ 批准 verdict 照常落库');
});

test('仲裁池 AI 全否（pick:0）→ 照旧 null，不打 playurl', async () => {
  reset();
  const info = mkInfo('bb2');
  searchImpl = async () => ({ items: [row('BVx', 215), row('BVy', 220)] });
  aiScript = [{ pick: 0 }];
  let audioCalls = 0;
  audioImpl = async () => { audioCalls += 1; return [{ url: 'u', mimeType: 'audio/mp4', br: 1 }]; };
  assert.equal(await resolve(info, {}), null);
  assert.equal(audioCalls, 0, 'AI 全否 → ordered 空 → 不白打 playurl');
});

test('仲裁池照常过判定记忆——ok=0 候选不进 AI 池也不取流', async () => {
  reset();
  const info = mkInfo('bb3');
  verdictRows['bb3@bv_BVx@stub-model'] = { ok: 0 };  // 否决记忆对仲裁池同口径
  searchImpl = async () => ({ items: [row('BVx', 215), row('BVy', 220)] });
  aiScript = [{ pick: 1 }];                        // 未判池只剩 BVy → pick:1
  const seenAudio = [];
  audioImpl = async ({ bvid }) => { seenAudio.push(bvid); return [{ url: `u-${bvid}`, mimeType: 'audio/mp4', br: 128000 }]; };
  const r = await resolve(info, {});
  assert.equal(r.url, 'u-BVy');
  assert.ok(askArgs && !askArgs.user.includes('t-BVx'), 'ok=0 候选不进 AI prompt');
  assert.deepEqual(seenAudio, ['BVy'], '被否决候选不取流');
});

test('仲裁池全被判定记忆否决 → null，否决留痕带仲裁语境', async () => {
  reset();
  aiOn = false;
  const info = mkInfo('bb4');
  verdictRows['bb4@bv_BVx@stub-model'] = { ok: 0 };
  verdictRows['bb4@bv_BVy@stub-model'] = { ok: 0 };
  searchImpl = async () => ({ items: [row('BVx', 215), row('BVy', 220)] });
  const cap = captureInfo();
  try { assert.equal(await resolve(info, {}), null); } finally { cap.restore(); }
  assert.ok(cap.logs.some(l => l.includes('±5s 时长筛全灭')), '仲裁留痕在');
  assert.ok(cap.logs.some(l => l.includes('全部被判定记忆否决') && l.includes('仲裁池')),
    `否决语境须区分仲裁池，实得: ${JSON.stringify(cap.logs)}`);
});

// ── 墙期本地阈早退（WALL_EVIDENCE_CAP=2）─────────────────────────────
// 仲裁池放宽后至多 8 候选 × ~3 跳 playurl/view/cid 自愈——墙期持续
// -352/-412/-799 只是给风控喂信号。youtube 侧 sourceHealth.noteAuthRejected
// 到阈 break 同口径；本域未接 sourceHealth，阈自守
test('风控证据到阈（累计 2 记）早退：第三候选不再打，仍抛 transient 标记错', async () => {
  reset();
  aiOn = false;
  const info = mkInfo('bw1');
  searchImpl = async () => ({ items: [row('BVx'), row('BVy'), row('BVz')] });
  const audioCalls = [];
  audioImpl = async ({ bvid }) => { audioCalls.push(bvid); throw new Error('bilibili /x/player/playurl HTTP 412'); };
  const err = await resolve(info, {}).then(() => null, (e) => e);
  assert.ok(err instanceof Error, '风控全灭须抛错而非回 null');
  assert.deepEqual(audioCalls, ['BVx', 'BVy'], '第 2 记墙证据即停打——第三候选不给风控喂信号');
  assert.match(err.message, /2\/3/, '留痕带真实触墙计数');
  assert.ok(TRANSIENT_LIKE_RE.test(err.message), `须归 transient，实得: ${err.message}`);
});

test('墙证据取累计数：混排死候选不抵消——第 2 记墙即停打剩余候选', async () => {
  reset();
  aiOn = false;
  const info = mkInfo('bw2');
  searchImpl = async () => ({ items: [row('BVw1'), row('BVd'), row('BVw2'), row('BVlast')] });
  const audioCalls = [];
  audioImpl = async ({ bvid }) => {
    audioCalls.push(bvid);
    if (bvid === 'BVd') return [];             // 空音轨=候选死（非墙证据）
    throw new Error('bilibili /x/player/playurl code=-352 风控校验失败');
  };
  const err = await resolve(info, {}).then(() => null, (e) => e);
  assert.deepEqual(audioCalls, ['BVw1', 'BVd', 'BVw2'],
    '累计计数非连败——中间死候选不重置，BVlast 未出场');
  assert.ok(TRANSIENT_LIKE_RE.test(err.message));
  assert.equal(verdictWrites.length, 0, '墙证据与单次死都不升级 verdict');
});

// ── 仲裁池缺时长候选稳定划分（durOk 押尾）────────────────────────────
// durationSecOf 坏形态归 0/字段缺席的候选胜出后，下游 estMs 只能走
// br×size 的裸 HEAD 支路（upos CDN 无 Referer 必遭防盗链拦截）→ 对账
// 静默缺位。划分保各组内相对序：可对账候选先试错，缺时长全灭后才被摸
test('仲裁池缺时长候选稳定押尾：可对账候选保相对序在前先试错', async () => {
  reset();
  aiOn = false;
  const info = mkInfo('bd1');                          // durationMs 200s
  // 0/null 双坏形态都在池——全超 ±5s 窗进仲裁
  searchImpl = async () => ({
    items: [row('BVnodur', 0), row('BVx', 215), row('BVnulldur', null), row('BVy', 220)],
  });
  const seenAudio = [];
  audioImpl = async ({ bvid }) => { seenAudio.push(bvid); return []; };  // 全灭看序
  await resolve(info, {});
  assert.deepEqual(seenAudio, ['BVx', 'BVy', 'BVnodur', 'BVnulldur'],
    '正时长保相对序在前，缺时长（0 与 null 同病）保相对序押尾');
});

test('仲裁池划分不扰 AI 语义序：正时长选中仍在首；缺时长胜出留痕', async () => {
  reset();
  const info = mkInfo('bd2');
  // unjudged=[BVnodur,BVx,BVy]，AI 选 BVy（pick:3）→ ranked=[BVy,BVnodur,BVx]
  // 划分后 [BVy,BVx,BVnodur]——AI 选中（正时长）仍在首，缺时长只在全灭后被摸
  searchImpl = async () => ({ items: [row('BVnodur', 0), row('BVx', 215), row('BVy', 220)] });
  aiScript = [{ pick: 3 }];
  const seenAudio = [];
  audioImpl = async ({ bvid }) => {
    seenAudio.push(bvid);
    return bvid === 'BVnodur' ? [{ url: 'u-nodur', mimeType: 'audio/mp4', br: 128000 }] : [];
  };
  const cap = captureInfo();
  let r;
  try { r = await resolve(info, {}); } finally { cap.restore(); }
  assert.deepEqual(seenAudio, ['BVy', 'BVx', 'BVnodur'],
    'AI 选中的正时长候选仍首位取流；缺时长候选排最后');
  assert.equal(r.url, 'u-nodur', '可对账候选全灭后缺时长候选兜底胜出');
  assert.equal(r.durationSec, 0, '胜出形如实下发——缺时长字段不谎报');
  assert.ok(cap.logs.some(l => l.includes('bilibili: 仲裁选中候选缺时长字段') && l.includes('对账缺位')),
    `缺时长胜出须留痕，实得: ${JSON.stringify(cap.logs)}`);
  assert.equal(verdictWrites.length, 0, 'AI 选中的 BVy 死、胜出非选定——都不落 verdict');
});

test('非仲裁池缺时长候选序不变：durationMs 缺席无对账基准——划分是仲裁池限定', async () => {
  reset();
  aiOn = false;
  const info = { ...mkInfo('bd3'), durationMs: null };  // 无基准 → 前 3 原序非仲裁
  searchImpl = async () => ({ items: [row('BVnodur', 0), row('BVx'), row('BVy')] });
  const seenAudio = [];
  audioImpl = async ({ bvid }) => { seenAudio.push(bvid); return []; };
  await resolve(info, {});
  assert.deepEqual(seenAudio, ['BVnodur', 'BVx', 'BVy'], '非仲裁路径原序不动——缺时长不押尾');
});

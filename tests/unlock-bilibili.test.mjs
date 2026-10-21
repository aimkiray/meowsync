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
  askAiJson: async () => { askCalls += 1; return aiScript.length ? aiScript.shift() : null; },
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
  aiOn = true; aiScript = []; verdictRows = {}; verdictWrites.length = 0; askCalls = 0;
  searchImpl = async () => ({ items: [] });
  audioImpl = async () => [];
  delCalls.length = 0;
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
  // 时长超窗（±5s 外）——有搜索结果但不配，照样 null
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

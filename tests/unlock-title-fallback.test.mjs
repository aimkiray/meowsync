// AI 全否（pick:0）标题+时长兜底行为钉——match.js pickTitleDurationMatch
// 经 ai-rank.js 选定。实锤漏判形：QQ 曲「ぱられループ を歌ってみた / Jeku /
// 259s」实为 aori 原曲的 Jeku Remix，YouTube 候选池多条 260s 同名标题是
// 正主，AI 因期望艺人 Jeku vs 标题 aori + remix 标注误判全否 → 诚实失败。
// 规则：AI 全否时存在「标题含歌名（容跨语言/罗马音写法）+ 时长贴近」候选，
// 选首条命中者；命中不写全否冷却（确定性规则与 AI 裁决相左，下次重评）。
// 播种口径同 unlock-youtube.test.mjs：lib/youtube、youtube-resolve、
// lib/ai、repositories/lyricAi 全预播种后再 require。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let aiOn = true;
let aiScript = [];                 // askAiJson 依次返回
let verdictRows = {};              // vkey → {ok}
const verdictWrites = [];          // upsertVerdict 记录
let askCalls = 0;
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
  // upsert 同步刷 verdictRows——后续 getVerdict 必须看见刚落的判定
  upsertVerdict: (vkey, kind, ok, detail) => { verdictWrites.push({ vkey, kind, ok, detail }); verdictRows[vkey] = { ok }; },
});
const { aiRankCandidates, resolve } = require('../src/server/services/unlock/youtube.js');

// 每用例独立 info.id：rejectedAt/deadCands 冷却以曲为键，共用 id 会跨用例泄漏
// 实锤曲形：name 带日语翻唱语尾「を歌ってみた」，期望艺人是 Remix 作者
const info259 = (id) => ({
  id, name: 'ぱられループ を歌ってみた', artists: ['Jeku'],
  keyword: 'ぱられループ を歌ってみた - Jeku', durationMs: 259000,
});
// 正主候选形：标题署名是原曲艺人 aori + 括弧 Remix 标注——AI 易误杀、
// 标题+时长兜底该接住的那条
const remixCand = (id, sec = 260) => ({
  videoId: id,
  title: 'aori - ぱられループ を歌ってみた (Jeku Remix)',
  owner: 'up', durationSec: sec,
});
const plainCand = (id, title, sec = 200) => ({ videoId: id, title, owner: `o-${id}`, durationSec: sec });
const reset = () => {
  aiOn = true; aiScript = []; verdictRows = {}; verdictWrites.length = 0; askCalls = 0;
  resolveStreamsImpl = async () => ({ streams: [] });
  searchImpl = async () => [];
};
const ids = (r) => r.ordered.map(c => c.videoId);

test('AI 全否 + 候选标题含歌名且时长贴近 → 兜底选定，不写全否冷却', async () => {
  reset();
  const info = info259('f1');
  aiScript = [{ pick: 0 }];
  const r = await aiRankCandidates(info, [remixCand('v1'), plainCand('v2', 't-v2', 260)], null);
  assert.deepEqual(ids(r), ['v1'], '命中候选独占 ordered——AI 否决的其余未判候选不回流');
  assert.equal(r.pickedId, 'v1', '兜底命中走 pickedId 既有批准机制');
  assert.equal(askCalls, 1);
  assert.equal(verdictWrites.length, 0, '批准 verdict 仍延迟到取流验证');
  // 命中兜底不写 rejectedAt：同候选集再问 AI 仍发问（冷却生效会停在 1）
  aiScript = [{ pick: 0 }];
  const r2 = await aiRankCandidates(info, [remixCand('v1'), plainCand('v2', 't-v2', 260)], null);
  assert.equal(askCalls, 2, '确定性规则与 AI 裁决相左不冷却——下次 resolve 重评');
  assert.equal(r2.pickedId, 'v1');
});

test('AI 全否 + 候选标题不含歌名 → 维持丢弃，全否冷却照旧', async () => {
  reset();
  const info = { id: 'f2', name: '目标曲', artists: ['x'], keyword: 'k', durationMs: 200000 };
  aiScript = [{ pick: 0 }];
  const r = await aiRankCandidates(info, [plainCand('u', 't-u'), plainCand('v', 't-v')], null);
  assert.deepEqual(r.ordered, []);
  const r2 = await aiRankCandidates(info, [plainCand('u', 't-u'), plainCand('v', 't-v')], null);
  assert.equal(askCalls, 1, '未命中兜底 → rejectedAt 冷却生效，不重复烧 AI');
  assert.deepEqual(r2.ordered, []);
});

test('标题含歌名但时长差 >10s → 不命中', async () => {
  reset();
  aiScript = [{ pick: 0 }];
  // 标题全中但 200s vs 259s = 59s 差——候选资格被时长闸挡在兜底外
  const r = await aiRankCandidates(info259('f3'), [remixCand('v1', 200)], null);
  assert.deepEqual(r.ordered, []);
  assert.equal(r.pickedId, null);
});

test('多条候选命中 → 只选首条（保原序）', async () => {
  reset();
  aiScript = [{ pick: 0 }];
  const r = await aiRankCandidates(info259('f4'),
    [remixCand('v1'), remixCand('v2'), plainCand('v3', 't-v3', 259)], null);
  assert.deepEqual(ids(r), ['v1']);
  assert.equal(r.pickedId, 'v1');
});

test('durationMs 缺席 → 兜底不启用（无对账基准无法验证时长贴近）', async () => {
  reset();
  aiScript = [{ pick: 0 }];
  const info = { ...info259('f5'), durationMs: null };
  const r = await aiRankCandidates(info, [remixCand('v1')], null);
  assert.deepEqual(r.ordered, []);
  assert.equal(r.pickedId, null);
});

test('resolve：AI 全否 + 标题命中候选 → 兜底选定照常取流，批准 verdict 落库', async () => {
  reset();
  const info = info259('f6');
  searchImpl = async () => [remixCand('v9'), plainCand('vx', 't-vx', 260)];
  aiScript = [{ pick: 0 }];
  resolveStreamsImpl = async (vid) => ({ streams: [{ url: `u-${vid}`, br: 128 }] });
  const r = await resolve(info, {});
  assert.equal(r.url, 'u-v9');
  assert.equal(r.mediaId, 'v9');
  // pickedId 走「选定候选取流验证成功才落 ok=1 verdict」既有批准机制
  assert.deepEqual(verdictWrites, [
    { vkey: 'f6@yt_v9@stub-model', kind: 'unlock', ok: 1, detail: 'aori - ぱられループ を歌ってみた (Jeku Remix)' },
  ]);
});

test('罗马音混排：候选括弧内日文残留命中；完全翻译无残留诚实不命中', async () => {
  reset();
  const info = {
    id: 'f7', name: '繭色', artists: ['sajou no hana'],
    keyword: '繭色 - sajou no hana', durationMs: 200000,
  };
  aiScript = [{ pick: 0 }];
  // 罗马音标题但括弧内残留日文歌名——剥括号符留内容后可见，规则命中
  const r = await aiRankCandidates(info, [plainCand('hk', 'Mayuiro - sajou no hana（繭色）', 200)], null);
  assert.deepEqual(ids(r), ['hk']);
  assert.equal(r.pickedId, 'hk');
  // 纯「Mayuiro」零日文残留——跨语言完全翻译确定性无法判等，维持全否旧路径
  const info2 = { ...info, id: 'f8' };
  aiScript = [{ pick: 0 }];
  const r2 = await aiRankCandidates(info2, [plainCand('hm', 'Mayuiro - sajou no hana', 200)], null);
  assert.deepEqual(r2.ordered, []);
});

// ── 规则 b/c 命中面补钉（前列命中用例全由规则 a 先中，b/c 零触发）──

test('规则 c：候选只含最长 token（缺其余 token，a/b 皆不中）→ 兜底选定', async () => {
  reset();
  const info = info259('c1');
  aiScript = [{ pick: 0 }];
  // 「Aori - Parallel Loop / ぱられループ (Jeku Remix)」缺「を歌ってみた」
  // token：a 的整串针「ぱられループを歌ってみた」不连子串缺席，b 要求全
  // token 在场同样不中——由最长 token「ぱられループ」(≥4 字符） 规则 c 兜
  const r = await aiRankCandidates(info,
    [plainCand('rc', 'Aori - Parallel Loop / ぱられループ (Jeku Remix)', 260)], null);
  assert.equal(r.pickedId, 'rc');
  assert.deepEqual(ids(r), ['rc']);
});

test('规则 b：乱序/夹字 token 全命中（整串针缺席、最长 token <4 字符 c 缺席）→ 兜底选定', async () => {
  reset();
  const info = { id: 'b1', name: '夏 物語', artists: ['x'], keyword: 'k', durationMs: 200000 };
  aiScript = [{ pick: 0 }];
  // ck「物語夏-official」不含整串针「夏物語」——a 不中；两 token 乱序+夹
  // 字全在场 b 中；最长 token「物語」仅 2 字符 <4——本例 c 规则缺席，
  // 命中只能来自 b
  const r = await aiRankCandidates(info, [plainCand('rb', '物語 夏 -official', 205)], null);
  assert.equal(r.pickedId, 'rb');
  assert.deepEqual(ids(r), ['rb']);
});

test('时长容差边界：Δ=9s/Δ=10s（含界 <=）命中、Δ=11s 不命中', async () => {
  reset();
  const info = (id) => ({ id, name: '対象曲', artists: ['x'], keyword: 'k', durationMs: 200000 });
  const cand = (id, sec) => plainCand(id, `対象曲 - ${id}`, sec);
  aiScript = [{ pick: 0 }];
  const r9 = await aiRankCandidates(info('t9'), [cand('d9', 209)], null);
  assert.equal(r9.pickedId, 'd9', 'Δ=9s 在 ±10s 窗内');
  aiScript = [{ pick: 0 }];
  const r10 = await aiRankCandidates(info('ta'), [cand('da', 210)], null);
  assert.equal(r10.pickedId, 'da', 'Δ=10s 恰压含界——判定是 >TOLERANCE 才弃');
  aiScript = [{ pick: 0 }];
  const r11 = await aiRankCandidates(info('tb'), [cand('db', 189)], null);
  assert.deepEqual(r11.ordered, []);
  assert.equal(r11.pickedId, null, 'Δ=11s 出窗——时长闸挡在标题判定之前');
});

test('durationSec 0/null 候选被跳过不命中；同池正时长活候选照常选定', async () => {
  reset();
  const info = { id: 'z1', name: '対時曲', artists: ['x'], keyword: 'k', durationMs: 200000 };
  aiScript = [{ pick: 0 }];
  const r = await aiRankCandidates(info, [
    plainCand('z0', '対時曲 官方', 0), plainCand('zn', '対時曲 完全版', null)], null);
  assert.deepEqual(r.ordered, [], '0s/null 时长候选双双被闸挡——无对账基准不选');
  // 死证在前不挡路：跳过后首条正时长命中候选照常选定
  const info2 = { ...info, id: 'z2' };
  aiScript = [{ pick: 0 }];
  const r2 = await aiRankCandidates(info2, [
    plainCand('z0', '対時曲 官方', 0), plainCand('zg', '対時曲 完全版', 200)], null);
  assert.equal(r2.pickedId, 'zg');
});

test('歌名纯标点（titleKey 无文数字）→ 不命中任何候选（裸针误选闸）', async () => {
  reset();
  const info = { id: 'p1', name: '???', artists: ['x'], keyword: 'k', durationMs: 200000 };
  aiScript = [{ pick: 0 }];
  // 「???」剥出的针整串标点——文数字下限前候选标题恰好含「???」+时长
  // 贴近即成裸针误选，且 pickedId→ok=1 verdict 永久批准。针集空直接不选
  // （token 侧同款过滤使 b/c 也缺席）。带字母的短针（'op'/'go' 类）按裁决
  // 不设长度下限——2 字符 CJK 歌名（繭色）依赖短针，残余面见 match.js 注
  const r = await aiRankCandidates(info, [plainCand('pp', '???', 200)], null);
  assert.deepEqual(r.ordered, []);
  assert.equal(r.pickedId, null);
});

test('歌名带尾括号 → name core 针剥分隔符尾命中裸名候选（b/c 缺席的真双针形）', async () => {
  reset();
  // 「【曲名】 - (Live)」：歌名整体在括号内 → token 集空（b/c 双双缺席），
  // 只剩针面。core 修前带死尾「【曲名】 -」→「曲名-」永不中裸名候选；
  // 分隔符尾清理后「曲名」命中——分隔符尾清理的红绿钉
  const info = { id: 'l1', name: '【曲名】 - (Live)', artists: ['x'], keyword: 'k', durationMs: 200000 };
  aiScript = [{ pick: 0 }];
  const r = await aiRankCandidates(info, [plainCand('lc', '曲名', 200)], null);
  assert.equal(r.pickedId, 'lc');
  // 常规双针形「曲名 - (Live)」：全串针不中、b（token「曲名」在场）与
  // 清理后 core 针同中——钉住裸名候选命中的意图形态不回归
  const info2 = { id: 'l2', name: '曲名 - (Live)', artists: ['x'], keyword: 'k', durationMs: 200000 };
  aiScript = [{ pick: 0 }];
  const r2 = await aiRankCandidates(info2, [plainCand('lc2', '曲名', 200)], null);
  assert.equal(r2.pickedId, 'lc2');
});

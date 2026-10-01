// netease-match.js 回归测试：两个上游依赖（云搜 + AI）用 require.cache 预播种
// stub——netease-match 在 require 时解构绑定，必须在首次 require 之前就位。
// node --test 每文件独立进程，全局污染安全。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// —— 可变脚本：每个用例重置 ——
let aiOn = true;
let aiScript = [];       // askAiJson 依次返回（null=模型哑/超时）
let apiScript = [];      // callNeteaseApi 依次返回 {songs:[...]}（数组即 result.songs）
const apiCalls = [];     // 记录每次云搜的 keywords + 是否带 signal

const apiPath = require.resolve('../src/server/services/netease-api.js');
const aiPath = require.resolve('../src/server/lib/ai.js');
require.cache[apiPath] = { id: apiPath, filename: apiPath, loaded: true, exports: {
  callNeteaseApi: async (name, params, opts) => {
    apiCalls.push({ name, keywords: params?.keywords, signal: !!opts?.signal });
    const fn = apiScript.length ? apiScript.shift() : [];
    return { body: { result: { songs: fn } } };
  },
} };
require.cache[aiPath] = { id: aiPath, filename: aiPath, loaded: true, exports: {
  aiEnabled: () => aiOn,
  askAiJson: async () => (aiScript.length ? aiScript.shift() : null),
  AI_MODEL: 'stub',
} };
const { matchNeteaseSong } = require('../src/server/services/netease-match.js');

const song = (id, name, dtMs = 200000, ar = '某人') => ({ id, name, dt: dtMs, ar: [{ name: ar }], al: { name: 'al' } });
const src = { title: 'T', author: 'A' };
const reset = () => { aiOn = true; aiScript = []; apiScript = []; apiCalls.length = 0; };

test('歌名互包含 → 启发式命中返回原查询串，不触发 AI', async () => {
  reset();
  apiScript = [[song(1, 'Mela!', 193000, '緑黄色社会')]];
  const r = await matchNeteaseSong(['Mela!'], 193, 't', null, src);
  assert.equal(r.song.id, 1);
  assert.equal(r.query, 'Mela!');          // 无 ai: 前缀的回归钉
  assert.equal(aiScript.length, 0);
});

test('云搜请求透传调用方 signal（abort 语义）', async () => {
  reset();
  apiScript = [[song(1, 'X')]];
  const ctl = new AbortController();
  await matchNeteaseSong(['X'], 0, 't', ctl.signal, src);
  assert.equal(apiCalls[0].signal, true);
});

test('AI 关闭：全灭后不烧 AI 调用，按串数精确消耗云搜', async () => {
  reset();
  aiOn = false;
  apiScript = [[song(1, '无关', 9999000)], [song(2, '无关2', 9999000)]];
  const r = await matchNeteaseSong(['甲', '乙'], 10, 't', null, src);
  assert.equal(r.song, null);
  assert.equal(apiCalls.length, 2);        // 无再生轮白打
});

test('再生轮命中 → query 带 ai:regen: 前缀；name 命中先过复核', async () => {
  reset();
  apiScript = [[], [], [song(7, 'Mela!', 193000)]];   // 启发式两串全空；再生串搜出正主
  aiScript = [{ queries: ['Mela!'] }, { match: true }];   // extract → confirm
  const r = await matchNeteaseSong(['脏串1', '脏串2'], 193, 't', null, src);
  assert.equal(r.song.id, 7);
  assert.equal(r.query, 'ai:regen:Mela!');
});

test('再生 name 命中被 AI 否决 → 记 veto、不回、不进兜底池', async () => {
  reset();
  apiScript = [[], [song(9, '伪正主')]];   // 启发式空；再生串搜出同名伪正主
  aiScript = [{ queries: ['伪正主'] }, { match: false }];
  const r = await matchNeteaseSong(['脏'], 100, 't', null, src);
  assert.equal(r.song, null);             // 否决后 pick 池里它被滤掉
});

test('再生串与已试 candidates 去重——不重复打云搜', async () => {
  reset();
  apiScript = [[], [song(3, '其它', 90000)]];
  aiScript = [{ queries: ['乙', '新串', '  乙  '] }];  // '乙' 重复（大小写/空白归一）
  const r = await matchNeteaseSong(['甲', '乙'], 10, 't', null, src);
  assert.deepEqual(apiCalls.map(c => c.keywords), ['甲', '乙', '新串']);
});

test('aiExtractQueries 输出消毒：非串/控制符/超长/过短元素全滤掉', async () => {
  reset();
  apiScript = [[], [song(3, '其它', 90000)]];
  aiScript = [{ queries: [{}, 42, 'a', 'x\ny', 'ok', 'ok', 'z'.repeat(90)] }];
  await matchNeteaseSong(['甲'], 10, 't', null, src);
  // 只剩 'x y'（换行→空格）与 'ok'（去重后）；'a' 过短、90串超长、对象/数字被滤
  assert.deepEqual(apiCalls.map(c => c.keywords), ['甲', 'x y', 'ok']);
});

test('aiPickMatch 防御：match:true 不固化第 1 候选', async () => {
  reset();
  apiScript = [[song(5, 'Alpha')]];
  aiScript = [{ queries: [] }, { match: true }];   // extract 空 → 直接进 pick
  const r = await matchNeteaseSong(['甲'], 10, 't', null, src);
  assert.equal(r.song, null);             // Number(true)=1 的假命中被挡
});

test('时长-only 命中：AI 复核否决后同 id 在后续串不再重问', async () => {
  reset();
  const noise = song(4, '时长噪声', 100000);   // dt=100s 与 durationSec=100 恰在窗内
  apiScript = [[noise], [noise]];              // 两串都搜回同一首
  aiScript = [{ match: false }, { queries: [] }, { match: 0 }];
  const r = await matchNeteaseSong(['甲', '乙'], 100, 't', null, src);
  assert.equal(r.song, null);
  // confirm 只问一次（veto 后第二串直接滤）；pick 池被 veto 清空 →
  // 不发请求即返回 null——{match:0} 剩在脚本里正是「没白问」的证据
  assert.equal(aiScript.length, 1);
});

test('组合查询名命中·艺人零交集 → 过 AI 复核（翻唱判 true 放行）', async () => {
  reset();
  // 'coverer Lemon' 组合串让任何叫 Lemon 的曲都 shareName 命中
  apiScript = [[song(1, 'Lemon', 200000, '米津玄師')]];
  aiScript = [{ match: true }];
  const r = await matchNeteaseSong(['coverer Lemon', 'Lemon'], 200, 't', null, { title: 'Lemon covered', author: 'coverer' });
  assert.equal(r.song.id, 1);
  assert.equal(r.query, 'coverer Lemon');
});

test('组合名命中被否 → veto 拦阻后续裸名查询复活同一错配', async () => {
  reset();
  const wrong = song(1, 'Lemon', 200000, '别的歌手');
  apiScript = [[wrong], [wrong]];   // 组合串与裸名串都搜回同一首错配
  aiScript = [{ match: false }, { queries: [] }, { match: 0 }];
  const r = await matchNeteaseSong(['coverer Lemon', 'Lemon'], 200, 't', null, { title: 'Lemon', author: 'coverer' });
  assert.equal(r.song, null);       // 第二串 'Lemon' 名命中被 veto 拦住
});

test('组合查询名命中·艺人有交集 → 不过 AI（确定性放行）', async () => {
  reset();
  apiScript = [[song(1, 'Lemon', 200000, '米津玄師')]];
  const r = await matchNeteaseSong(['米津玄師 Lemon', 'Lemon'], 200, 't', null, src);
  assert.equal(r.song.id, 1);
  assert.equal(aiScript.length, 0);  // 艺人重叠——零 AI 调用
});

test('再生批在兜底池截断窗口优先——启发式噪声挤不掉正主', async () => {
  reset();
  // 启发式串装满 12 条噪声（>10 截断窗），再生串搜出正主 id=99
  const noise = Array.from({ length: 12 }, (_, i) => song(100 + i, `噪声${i}`));
  apiScript = [[noise.slice(0, 6)], [noise.slice(6)], [song(99, '正主')]];
  aiScript = [{ queries: ['新串'] }, { match: 1 }];  // pick：再生批排第一 → 编号 1
  const r = await matchNeteaseSong(['脏1', '脏2'], 0, 't', null, src);
  assert.equal(r.song.id, 99);
  assert.equal(r.query, 'ai:pick');
});

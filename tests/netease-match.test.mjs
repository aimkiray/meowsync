// netease-match.js 回归测试：两个上游依赖（云搜 + AI）用 require.cache 预播种
// stub——netease-match 在 require 时解构绑定，必须在首次 require 之前就位。
// node --test 每文件独立进程，全局污染安全。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { tmpDataDir } from './helpers.mjs';

// song_match 缓存走真库——DATA_DIR 先指向临时目录再触发 db/client 装载
// （netease-match → repositories/songMatch → db/client 在 require 时读 env）
process.env.DATA_DIR = tmpDataDir('meowsync-match-');
const require = createRequire(import.meta.url);

// —— 可变脚本：每个用例重置 ——
let aiOn = true;
let aiModelName = 'stub';
let aiScript = [];       // askAiJson 依次返回（null=模型哑/超时）
let apiScript = [];      // cloudsearch 依次返回 {songs:[...]}（数组即 result.songs）
let detailScript = [];   // song_detail 回水化脚本（缓存正命中专用，元素=songs 数组，与 apiScript 同构）
const apiCalls = [];     // 记录每次上游调用（name 区分 cloudsearch/song_detail）
const aiCalls = [];      // 记录每次 AI 调用的 {system,user}——「零调用」断言不能只靠
                          // 脚本剩量（空脚本上调用返回 null 不留痕迹）；prompt 口径钉也靠它

const apiPath = require.resolve('../src/server/services/netease-api.js');
const aiPath = require.resolve('../src/server/lib/ai.js');
require.cache[apiPath] = { id: apiPath, filename: apiPath, loaded: true, exports: {
  callNeteaseApi: async (name, params, opts) => {
    apiCalls.push({ name, keywords: params?.keywords, ids: params?.ids, signal: !!opts?.signal });
    if (name === 'song_detail') {
      return { body: { songs: detailScript.length ? detailScript.shift() : [] } };
    }
    const fn = apiScript.length ? apiScript.shift() : [];
    if (fn instanceof Error) throw fn;          // 传输故障脚本（风控/断网）
    if (typeof fn === 'function') return fn();  // 自定义应答 thunk
    return { body: { result: { songs: fn } } };
  },
} };
require.cache[aiPath] = { id: aiPath, filename: aiPath, loaded: true, exports: {
  aiEnabled: () => aiOn,
  askAiJson: async (opts) => {
    aiCalls.push({ system: opts?.system, user: opts?.user });   // 记 prompt 供口径断言
    return aiScript.length ? aiScript.shift() : null;
  },
  aiModel: () => aiModelName,
} };
// 本家惰性解析出口桩：netease-match 只消费 resolveOriginalInfo 这个面——
// Innertube/描述解析细节由 tests/youtube-original.test.mjs 钉真实现
let resolveOrigImpl = async () => null;
const resolveOrigCalls = [];
const ytLibPath = require.resolve('../src/server/lib/youtube.js');
require.cache[ytLibPath] = { id: ytLibPath, filename: ytLibPath, loaded: true, exports: {
  resolveOriginalInfo: (...a) => { resolveOrigCalls.push(...a); return resolveOrigImpl(...a); },
} };
const {
  matchNeteaseSong, nameHitNeedsConfirm, matchWithBudget, matchTracksPool,
} = require('../src/server/services/netease-match.js');

const song = (id, name, dtMs = 200000, ar = '某人') => ({ id, name, dt: dtMs, ar: [{ name: ar }], al: { name: 'al' } });
const src = { title: 'T', author: 'A' };
const reset = () => {
  aiOn = true; aiModelName = 'stub';
  aiScript = []; apiScript = []; detailScript = [];
  apiCalls.length = 0; aiCalls.length = 0;
  resolveOrigImpl = async () => null; resolveOrigCalls.length = 0;
};

test('歌名互包含 → 启发式命中返回原查询串，不触发 AI', async () => {
  reset();
  apiScript = [[song(1, 'Mela!', 193000, '緑黄色社会')]];
  const r = await matchNeteaseSong(['Mela!'], 193, 't', null, src);
  assert.equal(r.song.id, 1);
  assert.equal(r.query, 'Mela!');          // 无 ai: 前缀的回归钉
  assert.equal(aiCalls.length, 0);         // 启发式直达——AI 一次都没打
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
  // dt=110s vs durationSec=100：差 10s 在 45s 硬闸内——确定性 75 走再生复核
  // 分支被否（修复前 dt 超窗硬拒连灰区都没进，{match:false} 被 pick 白消费）
  apiScript = [[], [song(9, '伪正主', 110000)]];   // 启发式空；再生串搜出同名伪正主
  aiScript = [{ queries: ['伪正主'] }, { match: false }, { match: 1 }];
  const r = await matchNeteaseSong(['脏'], 100, 't', null, src);
  assert.equal(r.song, null);      // 否决→veto；pick 池被滤空，{match:1} 白备
  assert.equal(aiCalls.length, 2); // extract + 再生复核各一次——pick 没发起
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

test('灰区命中：AI 否决后同 id 在后续串不再重问', async () => {
  reset();
  // '甲乙歌名' 真灰区：title 互含 46 + artist 0 + 时长贴 20 = 66——confirm
  // 真发起（修复前 title=0 总分 35 <GRAY，{match:false} 被 extract 白消费）
  const cand = song(4, '甲乙歌名', 100000, '别人');
  apiScript = [[cand], [cand]];                     // 两串都搜回同一首
  aiScript = [{ match: false }, { queries: [] }];
  const r = await matchNeteaseSong(['歌名', '乙歌名'], 100, 't', null,
    { title: 'T', author: '某甲' });
  assert.equal(r.song, null);
  // confirm 1 次 + extract 1 次；veto 后第二串同 id 直接滤、pick 池空 →
  // 若否决失效，第二串会再问 confirm（aiCalls=3）或直接收下（song 非空）
  assert.equal(aiCalls.length, 2);
});

test('组合查询名命中·艺人零交集 → 过 AI 复核（翻唱判 true 放行）', async () => {
  reset();
  // 'coverer Lemon' 组合串让任何叫 Lemon 的曲都 shareName 命中
  apiScript = [[song(1, 'Lemon', 200000, '米津玄師')]];
  aiScript = [{ match: true }];
  const r = await matchNeteaseSong(['coverer Lemon', 'Lemon'], 200, 't', null, { title: 'Lemon covered', author: 'coverer' });
  assert.equal(r.song.id, 1);
  assert.equal(r.query, 'coverer Lemon');
  assert.equal(aiCalls.length, 1);   // 复核确实发生且只问一次——组合名命中不免检
});

test('组合名命中被否 → veto 拦阻后续裸名查询复活同一错配', async () => {
  reset();
  const wrong = song(1, 'Lemon', 200000, '别的歌手');
  apiScript = [[wrong], [wrong]];   // 组合串与裸名串都搜回同一首错配
  aiScript = [{ match: false }, { queries: [] }, { match: 0 }];
  const r = await matchNeteaseSong(['coverer Lemon', 'Lemon'], 200, 't', null, { title: 'Lemon', author: 'coverer' });
  assert.equal(r.song, null);       // 第二串 'Lemon' 名命中被 veto 拦住
  assert.equal(aiScript.length, 1); // confirm 消费 match:false、extract 消费 queries:[]——
                                    // pick 池被 veto 清空，{match:0} 剩着 = 没白问
});

test('组合查询名命中·艺人有交集 → 不过 AI（确定性放行）', async () => {
  reset();
  apiScript = [[song(1, 'Lemon', 200000, '米津玄師')]];
  const r = await matchNeteaseSong(['米津玄師 Lemon', 'Lemon'], 200, 't', null, src);
  assert.equal(r.song.id, 1);
  assert.equal(aiCalls.length, 0);   // 艺人重叠——一次 AI 都不该打
});

test('组合查询噪声词不造假交集：cover 修饰撞上含 cover 的艺人名仍复核', async () => {
  reset();
  // 'Lemon cover' 里的 'cover' 是修饰词——'Discovery' 艺人名虽然字面含
  // 'cover'，那是修饰 token 被吸收成假交集，不是真艺人重叠 → 必须过复核
  apiScript = [[song(1, 'Lemon', 200000, 'Discovery')]];
  aiScript = [{ match: true }];
  const r = await matchNeteaseSong(['Lemon cover'], 200, 't', null, { title: 'Lemon', author: 'up' });
  assert.equal(aiCalls.length, 1);   // 复核确实发起——修复前假交集会免检放行
  assert.equal(r.song.id, 1);
});

test('nameHitNeedsConfirm 边界：噪声艺名/噪声 token/单 token', () => {
  // 艺人本身叫 Live（噪声词）：'olive' 吞 'live' 是假交集 → 需要复核
  assert.equal(nameHitNeedsConfirm(song(1, 'X', 0, 'Live'), 'olive lemon', { author: 'up' }), true);
  // 带标点的噪声 token（'cover.'）被严归一滤掉，否则它吞艺人名 'Cover' 造假交集
  assert.equal(nameHitNeedsConfirm(song(1, 'X', 0, 'Cover'), 'lemon cover.', { author: 'up' }), true);
  // 真艺人交集仍免检
  assert.equal(nameHitNeedsConfirm(song(1, 'X', 0, '米津玄師'), '米津玄師 lemon', { author: 'up' }), false);
  // 单 token 纯歌名查询恒免检
  assert.equal(nameHitNeedsConfirm(song(1, 'X', 0, 'nobody'), 'lemon', { author: 'up' }), false);
  // 频道名就叫噪声词时 author 也不作引用
  assert.equal(nameHitNeedsConfirm(song(1, 'X', 0, 'Cover'), 'lemon mix', { author: 'Cover' }), true);
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

// ── 真实现包装层：路由侧 helpers.mjs 的种子 stub 只模拟串行语义，
//    预算/并发/abort 接线钉在真函数上（上游依赖仍是本文件顶部的 seed）──

test('matchWithBudget 真实现：预算内命中原样回传，budget race 不吞结果', async () => {
  reset();
  apiScript = [[song(1, 'Mela!', 193000)]];
  const r = await matchWithBudget({
    candidates: ['Mela!'], durationSec: 193, tag: 't', budgetMs: 5000,
  });
  assert.equal(r.song.id, 1);
  assert.equal(r.query, 'Mela!');
});

test('matchWithBudget 真实现：云搜空集在预算内正常空回', async () => {
  reset();
  aiOn = false;
  const r = await matchWithBudget({
    candidates: ['无关'], durationSec: 0, tag: 't', budgetMs: 5000,
  });
  assert.equal(r.song, null);      // 云搜空集 → 正常空回，不走异常分支
  assert.equal(apiCalls.length, 1); // 单串单搜——无重试无再生
});

test('matchTracksPool 真实现：命中原地写 matched/matchedBy 并计数', async () => {
  reset();
  const tracks = [{ k: 1 }, { k: 2 }, { k: 3 }];
  // 三轨同候选 'Hit'——第 2 轨云搜空回，另两轨名命中
  apiScript = [[song(11, 'Hit', 200000)], [], [song(13, 'Hit', 200000)]];
  const n = await matchTracksPool(tracks, {
    concurrency: 2, budgetMs: 5000, tag: 'pool-t',
    candidatesOf: () => ['Hit'], durationOf: () => 200, infoOf: () => null,
  });
  assert.equal(n, 2);
  assert.equal(apiCalls.length, 3);          // 三轨各搜一次，无重试无再生
  assert.equal(tracks[0].matched.id, 11);
  assert.equal(tracks[0].matchedBy, 'Hit');
  assert.equal(tracks[1].matched, undefined); // 未中不写回
  assert.equal(tracks[2].matched.id, 13);
});

test('matchTracksPool 真实现：预 abort 的 signal 让 worker 不消费任何曲目', async () => {
  reset();
  const ctl = new AbortController();
  ctl.abort();
  const tracks = [{ k: 1 }, { k: 2 }];
  apiScript = [[song(1, 'Hit')]];
  const n = await matchTracksPool(tracks, {
    signal: ctl.signal, concurrency: 1, budgetMs: 5000, tag: 't',
    candidatesOf: () => ['Hit'], durationOf: () => 0, infoOf: () => null,
  });
  assert.equal(n, 0);
  assert.equal(apiCalls.length, 0); // aborted 检查在取曲之前——一次云搜都不发
});

// ── 打分池（netease-score 接入 searchOnce）──────────────────────────

test('乐园(粤) 实案回归：同名异曲混入——正主确定性收、异曲不压顶', async () => {
  reset();
  // B 站实案形态：源「乐园(粤)」by 久遠千歳——网易云池混入同名异曲
  const info = { title: '乐园(粤)', author: '久遠千歳', artists: ['久遠千歳'] };
  apiScript = [[
    // 同名异曲+时长差 110s>45 → 硬闸拒（就算漏网 45+0+2=47 也进不了灰区，
    // 是噪声位——硬闸的达标证明在下方专用用例）
    song(1, '乐园', 130000, '别人'),
    song(2, '乐园', 236000, '别人2'),         // 同名异曲+时长近 → 灰区(61)
    song(3, '乐园(粤)', 242000, '久遠千歳'),  // 正主：名50+艺30+时20=100
  ]];
  const r = await matchNeteaseSong(['乐园(粤)'], 240, 't', null, info);
  assert.equal(r.song.id, 3);
  assert.equal(aiCalls.length, 0);   // ≥75 确定性收——不吃 AI
});

test('乐园(粤) 变体：池里只有同名异曲——灰区复核否决即不误收', async () => {
  reset();
  const info = { title: '乐园(粤)', author: '久遠千歳', artists: ['久遠千歳'] };
  apiScript = [[song(2, '乐园', 236000, '别人2')]];   // 灰区唯一候选
  aiScript = [{ match: false }, { queries: [] }];
  const r = await matchNeteaseSong(['乐园(粤)'], 240, 't', null, info);
  assert.equal(r.song, null);   // 否决→veto；兜底池被 veto 清空，宁可无词源
});

test('翻唱合法收：候选艺人=源作者、时长近 → 压过原唱确定性收', async () => {
  reset();
  apiScript = [[
    song(1, 'Lemon', 200000, '米津玄師'),   // 原唱：50+0+20=70 灰区
    song(2, 'Lemon', 201000, 'coverer'),    // 翻唱者版：50+30+20=100 确定性
  ]];
  const r = await matchNeteaseSong(['Lemon'], 200, 't', null,
    { title: 'Lemon cover', author: 'coverer', artists: ['coverer'] });
  assert.equal(r.song.id, 2);   // 艺人分把「这个视频的演唱」顶过原唱
  assert.equal(aiCalls.length, 0);
});

test('GRAY veto：AI 否决 top 后同池次优被复核收下', async () => {
  reset();
  apiScript = [[
    song(1, '明日之歌', 200000, '无关A'),   // 50+0+20=70 灰区 top
    song(2, '明日之歌', 210000, '无关B'),   // 50+0+10=60 灰区次优
  ]];
  aiScript = [{ match: false }, { match: true }];
  const r = await matchNeteaseSong(['明日之歌'], 200, 't', null,
    { title: '明日之歌', author: '某人', artists: ['某人'] });
  assert.equal(r.song.id, 2);
  assert.equal(aiCalls.length, 2);   // 否决 1 次 + 收下 1 次
});

test('无 AI 宽松：aiEnabled=false 时灰区 top 照收（不收紧语义）', async () => {
  reset();
  aiOn = false;
  apiScript = [[song(1, '明日之歌', 200000, '无关A')]];   // 70 灰区
  const r = await matchNeteaseSong(['明日之歌'], 200, 't', null,
    { title: '明日之歌', author: '某人', artists: ['某人'] });
  assert.equal(r.song.id, 1);
  assert.equal(aiCalls.length, 0);
});

test('时长硬闸钉死：同名同艺人 dt 差 60s 必拒——漏网将得 ~82 确定性收', async () => {
  reset();
  aiOn = false;
  apiScript = [[song(1, '明日之歌', 260000, '某人')]];   // 若闸失效 50+30+2=82
  const r = await matchNeteaseSong(['明日之歌'], 200, 't', null,
    { title: '明日之歌', author: '某人', artists: ['某人'] });
  assert.equal(r.song, null);
});

test('时长类硬拒留 AI 兜底池：120s 粗闸内 pick 可救回（设计意图）', async () => {
  reset();
  apiScript = [[song(1, '明日之歌', 260000, '某人')]];   // 打分器差 60s 硬拒
  aiScript = [{ queries: [] }, { match: 1 }];
  const r = await matchNeteaseSong(['明日之歌'], 200, 't', null,
    { title: '明日之歌', author: '某人', artists: ['某人'] });
  assert.equal(r.song.id, 1);   // 长片头视频的真匹配靠 pick 粗闸救济
  assert.equal(r.query, 'ai:pick');
});

test('标类硬拒连兜底池都开除：伴奏标候选进不了 AI pick', async () => {
  reset();
  apiScript = [[song(1, '明日之歌 伴奏', 200000, '某人')]];
  aiScript = [{ queries: [] }, { match: 1 }];   // pick 若见到它会选 1
  const r = await matchNeteaseSong(['明日之歌'], 200, 't', null,
    { title: '明日之歌', author: '某人', artists: ['某人'] });
  assert.equal(r.song, null);
  assert.equal(aiCalls.length, 1);   // 只烧 extract——池被标类拒清空，pick 未发起
});

test('中立艺人分+非精确 title：同名异曲压到灰区下，不确定收', async () => {
  reset();
  // author/artists 全缺 → artist 中立 15；互含 title ~39 + 时长近 16 = ~70
  // 修复前越过 ≥75 误收；修复后 <50 丢弃，只剩 AI 兜底池可救。
  // 标题带「现场版」尾：候选串经 titleVariantsOf 展开后进入 srcBaseTitles，
  // 若源标题是 '乐园(粤)'，剥缀变体 '乐园' 会与同名异曲精确命中（title=50）
  // 绕过中立艺人压分——钉「变体也剥不掉的后缀」让 title 证据保持非精确
  apiScript = [[song(2, '乐园', 236000, '别人2')]];
  aiScript = [{ queries: [] }, { match: 0 }];
  const r = await matchNeteaseSong(['乐园(粤) 现场版'], 240, 't', null, { title: '乐园(粤) 现场版' });
  assert.equal(r.song, null);
  assert.equal(aiCalls.length, 2);   // extract + pick 都走了——没被确定性短路
});

test('同串连否两个灰区 → 该串判空：第 3 个候选不免检收下', async () => {
  reset();
  apiScript = [[
    song(1, '明日之歌', 200000, '无关A'),   // 50+0+20=70 灰区 top
    song(2, '明日之歌', 210000, '无关B'),   // 50+0+10=60
    song(3, '明日之歌', 215000, '无关C'),   // 修复前 confirms 用尽后免检收下
  ]];
  aiScript = [{ match: false }, { match: false }, { queries: [] }, { match: 0 }];
  const r = await matchNeteaseSong(['明日之歌'], 200, 't', null,
    { title: '明日之歌', author: '某人', artists: ['某人'] });
  assert.equal(r.song, null);        // 修复前会免检收 id3
  assert.equal(aiCalls.length, 4);   // confirm×2 + extract + pick（id3 被 {match:0} 拒）
});

// ── AI 判定口径：词源匹配（判词文相同而非同一录音）────────────────────
// neteaseId 只驱动歌词拉取/下载嵌入——匹配目标是词文相同不是同一录音。
// prompt 须把沿用原词的翻唱/演绎/live/重编曲版放在「也算」侧（来源常是
// 翻唱/歌ってみた投稿，候选艺人不同不构成否决）；排他面双向写全——同名
// 异曲、重新填词/异语言改编与伴奏条目不算，来源本身是填词版时词文不同
// 的原曲同样不算。旧口径「同一录音…翻唱/混音/live 版本不算」曾把
// EMA/rei sirose 类翻唱投稿的正确原曲（sasayaku/笹川真生、
// 人マニア/原口沙輔、Twig/大沼パセリ…）成批否决——钉 prompt 语义防回退
const assertLyricSourcePrompt = (sys) => {
  assert.match(sys, /词文相同/);                 // 判词文不判录音
  assert.match(sys, /沿用原词/);                 // 翻唱收录挂词文条件：沿用原词才算
  assert.match(sys, /翻唱[^。]*也算/);            // 沿用原词的翻唱版在「也算」侧
  assert.match(sys, /同名异曲/);                 // 排他面仍在：同名异曲不放宽
  assert.match(sys, /重新填词|异语言填词/);       // 排他面：候选侧填词改编版不算
  assert.match(sys, /伴奏|inst|karaoke/);        // 排他面：伴奏条目不算
  assert.match(sys, /不构成否决/);               // 候选艺人≠来源作者不否决
  assert.match(sys, /词文不同的原曲同样不算/);    // 反向排他：来源本身是填词版时
                                                // 词文不同的原曲也拒（S2 洞）
  assert.match(sys, /译名差异/);                 // 歌名不同语言/译名差异属正常
  assert.match(sys, /\{"match":/);               // JSON schema 钉不变
  assert.doesNotMatch(sys, /翻唱[^。]*不算/);     // 旧排他句「翻唱/混音/live 版本不算」
};

test('灰区复核 prompt 是词源口径——翻唱沿用原词判匹配', async () => {
  reset();
  // 翻唱投稿配同题不同艺人的原曲：剥缀变体 'sasayaku' 进 srcBaseTitles 给
  // title 50 精确命中 + artist 0 + 时长 20 = 70 灰区（实测复核值），
  // confirm 必发起——拿到 system 钉口径
  apiScript = [[song(1, 'sasayaku', 222000, '笹川真生')]];
  aiScript = [{ match: true }];
  const r = await matchNeteaseSong(['sasayakuを歌いました'], 222, 't', null,
    { title: 'sasayakuを歌いました ／ rei sirose', author: 'rei sirose' });
  assert.equal(r.song.id, 1);
  assert.equal(r.score, 70);                 // 分数钉死——灰区上沿游走
  assert.equal(aiCalls.length, 1);
  assertLyricSourcePrompt(aiCalls[0].system);
});

test('AI 兜底 pick prompt 同词源口径', async () => {
  reset();
  apiScript = [[song(1, '无关')]];   // 打分 <50 全灭 → extract 空 → pick 见池
  aiScript = [{ queries: [] }, { match: 1 }];
  const r = await matchNeteaseSong(['甲'], 0, 't', null, src);
  assert.equal(r.song.id, 1);
  assert.equal(aiCalls.length, 2);               // extract + pick
  assertLyricSourcePrompt(aiCalls[1].system);    // [0] 是 extract（口径本就正确）
});

test('实案回归：歌ってみた投稿 + 同题不同艺人原曲——AI 判同源收下', async () => {
  reset();
  // rei sirose 翻唱 sasayaku（笹川真生原曲）：灰区复核 {match:true} 收下——
  // 旧口径曾以「来源是翻唱、候选艺人不同」否决这类正确原曲，钉接线没变
  apiScript = [[song(1316563227, 'sasayaku', 222000, '笹川真生')]];
  aiScript = [{ match: true }];
  const r = await matchNeteaseSong(['sasayakuを歌いました'], 222, 't', null,
    { title: 'sasayakuを歌いました ／ rei sirose', author: 'rei sirose', artists: ['rei sirose'] });
  assert.equal(r.song.id, 1316563227);
  assert.equal(r.query, 'sasayakuを歌いました'); // 启发式串收下，非 ai: 前缀路径
  assert.equal(aiCalls.length, 1);
});

// ── song_match 缓存（真库，DATA_DIR=临时目录）─────────────────────────

const songMatchRepo = require('../src/server/repositories/songMatch.js');

test('song_match 正缓存：二次匹配不打云搜，song_detail 回水化出完整投影', async () => {
  reset();
  const info = { title: 'Mela!', author: 'A', trackId: 'bv_CACHE1' };
  apiScript = [[song(5, 'Mela!', 193000, '緑黄色社会')]];
  detailScript = [[song(5, 'Mela!', 193000, '緑黄色社会')]];
  const args = { candidates: ['Mela!'], durationSec: 193, tag: 't', sourceInfo: info, budgetMs: 5000 };
  const r1 = await matchWithBudget(args);
  assert.equal(r1.song.id, 5);
  const searches = apiCalls.filter(x => x.name === 'cloudsearch').length;
  // 同 trackId 再匹配：候选串/时长乱填也应短路——缓存键只认 trackId
  const r2 = await matchWithBudget({ ...args, candidates: ['别串'], durationSec: 10 });
  assert.equal(r2.song.id, 5);
  assert.equal(r2.song.name, 'Mela!');   // detail 回水化生效（裸 id 没有 name）
  assert.equal(apiCalls.filter(x => x.name === 'cloudsearch').length, searches);
});

test('song_match 负缓存：二次匹配零上游调用；超 7d TTL 重搜', async () => {
  reset();
  const info = { title: 'X曲', author: 'A', trackId: 'bv_NEG1' };
  apiScript = [[]];   // 空池 → miss → 负缓存落行
  const args = { candidates: ['X曲'], durationSec: 0, tag: 't', sourceInfo: info, budgetMs: 5000 };
  const r1 = await matchWithBudget(args);
  assert.equal(r1.song, null);
  const calls1 = apiCalls.length;
  const r2 = await matchWithBudget(args);
  assert.equal(r2.song, null);
  assert.equal(apiCalls.length, calls1);        // 负缓存短路——零上游调用
  // 老化负行（>7d）→ 失效重搜
  const { getDb } = require('../src/server/db/client.js');
  getDb().prepare("UPDATE song_match SET updated_at = datetime('now', '-8 days') WHERE track_id = 'bv_NEG1'").run();
  apiScript = [[]];
  await matchWithBudget(args);
  assert.equal(apiCalls.length, calls1 + 1);
});

test('song_match：传输全灭不落负缓存——恢复后同 trackId 照常重搜', async () => {
  reset();
  aiOn = false;
  const info = { title: 'X曲', author: 'A', trackId: 'bv_TRANS1' };
  apiScript = [new Error('风控'), new Error('断网')];   // 两串全死传输层
  const args = { candidates: ['甲歌', '乙歌'], durationSec: 0, tag: 't', sourceInfo: info, budgetMs: 5000 };
  const r1 = await matchWithBudget(args);
  assert.equal(r1.song, null);
  assert.equal(songMatchRepo.getMatch('bv_TRANS1', ''), undefined); // 没落负行
  apiScript = [[song(5, '甲歌', 200000)]];   // 供给恢复——不被假负缓存短路
  const r2 = await matchWithBudget(args);
  assert.equal(r2.song.id, 5);
});

test('song_match：部分串故障+干净空回仍落负缓存（真搜过才算 miss）', async () => {
  reset();
  aiOn = false;
  const info = { title: 'X曲', author: 'A', trackId: 'bv_TRANS2' };
  apiScript = [new Error('风控'), []];   // 一串死传输一串干净空回 → searchedAny
  const args = { candidates: ['甲', '乙'], durationSec: 0, tag: 't', sourceInfo: info, budgetMs: 5000 };
  const r1 = await matchWithBudget(args);
  assert.equal(r1.song, null);
  const calls = apiCalls.length;
  const r2 = await matchWithBudget(args);
  assert.equal(r2.song, null);
  assert.equal(apiCalls.length, calls);   // 负缓存短路——零上游调用
});

test('matchTracksPool：传输全灭同口径不落负缓存', async () => {
  reset();
  const tracks = [{ k: 1 }];
  apiScript = [new Error('风控')];
  const n = await matchTracksPool(tracks, {
    concurrency: 1, budgetMs: 5000, tag: 'pool-t',
    candidatesOf: () => ['甲'], durationOf: () => 0,
    infoOf: () => ({ title: 'T', author: 'A', trackId: 'bv_PTRAN' }),
  });
  assert.equal(n, 0);
  assert.equal(songMatchRepo.getMatch('bv_PTRAN', 'stub'), undefined);
});

test('song_match 负行 model 精确键控：跨模型负行不短路重搜', async () => {
  reset();
  // 无 AI 期攒的负行(model='')：配上 AI 后不命中——真搜一遍本可救回
  songMatchRepo.upsertMatch('bv_MN1', null, '旧串', null, '');
  const info = { title: '明日之歌', author: '某人', artists: ['某人'], trackId: 'bv_MN1' };
  const args = { candidates: ['明日之歌'], durationSec: 200, tag: 't', sourceInfo: info, budgetMs: 5000 };
  apiScript = [[song(1, '明日之歌', 200000, '无关A')]];
  aiScript = [{ match: true }];
  const r1 = await matchWithBudget(args);
  assert.equal(r1.song.id, 1);
  assert.equal(apiCalls.filter(x => x.name === 'cloudsearch').length, 1);
  // AI 期负行(model='stub')：currentModel='' 侧同样不命中
  songMatchRepo.upsertMatch('bv_MN2', null, '旧串', null, 'stub');
  aiModelName = '';
  apiScript = [[]];
  const r2 = await matchWithBudget({ ...args, sourceInfo: { ...info, trackId: 'bv_MN2' } });
  assert.equal(r2.song, null);
  assert.equal(apiCalls.filter(x => x.name === 'cloudsearch').length, 2);
});

test('song_match model 键控：AI 参与结果换模型失效、纯启发式行永命中', async () => {
  reset();
  const info = { title: '明日之歌', author: '某人', artists: ['某人'], trackId: 'bv_M1' };
  const args = { candidates: ['明日之歌'], durationSec: 200, tag: 't', sourceInfo: info, budgetMs: 5000 };
  // 灰区复核收下 → aiTouched → 行以 model='stub' 落库
  apiScript = [[song(1, '明日之歌', 200000, '无关A')]];
  aiScript = [{ match: true }];
  const r1 = await matchWithBudget(args);
  assert.equal(r1.song.id, 1);
  const row = songMatchRepo.getMatch('bv_M1', 'stub');
  assert.equal(row.model, 'stub');
  const searches = apiCalls.filter(x => x.name === 'cloudsearch').length;
  await matchWithBudget(args);                                   // 同模型 → 命中
  assert.equal(apiCalls.filter(x => x.name === 'cloudsearch').length, searches);
  aiModelName = 'm2';                                            // 换模型 → 失效
  apiScript = [[song(1, '明日之歌', 200000, '无关A')]];
  aiScript = [{ match: true }];
  await matchWithBudget(args);
  assert.equal(apiCalls.filter(x => x.name === 'cloudsearch').length, searches + 1);
});

// ── /match/retry 纠错口（真路由 + 真匹配链，上游全桩）─────────────────

const matchRoute = require('../src/server/routes/match.js');
const postRetry = (body, headers = {}) => matchRoute.request('http://t/match/retry', {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

test('/match/retry：excludeIds 并入否决——错配被排除后收同池次优', async () => {
  reset();
  // 两名候选同分（70 灰区）：无 exclude 收 id1，exclude 后收 id2
  apiScript = [[song(1, '明日之歌', 200000, '无关A'), song(2, '明日之歌', 200000, '无关B')]];
  aiScript = [{ match: true }];
  const res = await postRetry({
    trackId: 'yt_R1', title: '明日之歌', author: 'up主',
    candidates: ['明日之歌'], excludeIds: [1], durationSec: 200,
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.matched.id, 2);
  assert.equal(body.code, 200);
});

test('/match/retry：命中覆写 song_match 行（纠正前的负/旧配被顶掉）', async () => {
  reset();
  // 先落一条旧行（id 9 的错配），retry 命中 id1 后行被覆写
  songMatchRepo.upsertMatch('yt_R2', '9', '旧配', 60, 'stub');
  apiScript = [[song(1, '明日之歌', 200000, '无关A'), song(2, '明日之歌', 200000, '无关B')]];
  aiScript = [{ match: true }];
  const res = await postRetry({
    trackId: 'yt_R2', title: '明日之歌', author: 'up主',
    candidates: ['明日之歌'], durationSec: 200,
  });
  const body = await res.json();
  assert.equal(body.matched.id, 1);
  assert.equal(songMatchRepo.getMatch('yt_R2', 'stub').netease_id, '1');
});

test('/match/retry：异源 Origin → 403；缺 trackId/材料 → 400', async () => {
  reset();
  const csrf = await postRetry({ trackId: 'yt_X', title: 'x' }, { origin: 'http://evil.example' });
  assert.equal(csrf.status, 403);
  assert.equal((await postRetry({ title: 'x' })).status, 400);
  assert.equal((await postRetry({ trackId: 'yt_X' })).status, 400);
});

test('/match/retry：异常消息脱敏——绝对路径不外泄（F5）', async () => {
  reset();
  // 注入一枚含 POSIX 绝对路径的异常（fs/上游错误原文形态）。取道本家
  // 惰性解析桩的同步抛错：种子桩是非 async 透传，同步异常在 .catch
  // 挂上之前就抛出，穿透 ensureOriginal 的 fail-soft 兜底一路冒到
  // 路由 catch——正是该 catch 把 e.message 拼进下发串的泄漏面
  resolveOrigImpl = () => {
    throw new Error("ENOENT: no such file or directory, open '/Users/alice/secret/data.json'");
  };
  apiScript = [[]];          // 云搜全灭 → miss 路径的 ensureOriginal 触雷
  const res = await postRetry({
    trackId: 'yt_sanit000001', title: 'x', author: 'a', candidates: ['查无此曲'],
  });
  const body = await res.json();
  assert.equal(res.status, 502);
  assert.match(body.message, /重匹配失败/);
  assert.ok(!body.message.includes('/Users/alice'));   // 绝对路径被剥
  assert.match(body.message, /'<path>'/);               // 引号包裹位换占位符
});

// ── 本家声明证据轮（yt_ 描述链 → 惰性解析 → 派生检索）────────────────
// 'Moonlight ver.EMA' 实案型：首轮标题面撞同题异曲（moumoon 与 shima/VY1
// 的同名 'Moonlight' 在元数据层不可分）——描述自署的本家链是唯一能分它的
// 一手证据。惰性边界：首个收单决断即触发解析（memoize 每曲一跳）、非 yt_
// trackId 整段跳过、预注零回源、解析失败静默按无本家续漏斗

test('yt_ 曲目首轮全灭 → 惰性解析本家、派生串命中（本家艺人计正分）', async () => {
  reset();
  const info = { title: 'Moonlight ver.EMA', author: 'EMA', artists: ['EMA'], trackId: 'yt_abcdefghijk' };
  resolveOrigImpl = async () => ({ videoId: 'orig0000001', title: 'Moonlight', author: 'shima' });
  // 首轮两串（原串 + ver.剥缀变体）全灭；派生 'shima Moonlight' 搜出正主
  apiScript = [[], [], [song(7, 'Moonlight', 200000, 'shima')]];
  aiScript = [{ match: true }];                      // 派生串收单的声明复核放行
  const r = await matchNeteaseSong(['Moonlight ver.EMA'], 0, 't', null, info);
  assert.equal(r.song.id, 7);
  assert.equal(r.query, 'shima Moonlight');          // 派生串的实际搜索词记 matchedBy
  // title 精确命中 origTitle(50) + 本家艺人命中(30) = 80 确定性收——但声明
  // 在位的收单决断全分位过复核（分数豁免已废），烧一发复核属新语义预期
  assert.equal(aiCalls.length, 1);
  assert.match(aiCalls[0].user, /来源描述声明本家：Moonlight — shima/);
  assert.equal(resolveOrigCalls.length, 1);
  assert.equal(resolveOrigCalls[0].videoId, 'abcdefghijk');
  assert.deepEqual(apiCalls.map(c => c.keywords),
    ['Moonlight ver.EMA', 'Moonlight', 'shima Moonlight']);
  assert.equal(info.original.title, 'Moonlight');    // 就地记入供后续 AI 阶段用
});

test('sourceInfo.original 预注：零回源，声明行进灰区复核 prompt', async () => {
  reset();
  const info = { title: '脏标题', author: 'up主', trackId: 'yt_abcdefghijk',
    original: { title: 'Moonlight', author: 'shima' } };
  // 注入后 origTitle 进标题面：候选名 'Moonlight' 精确 50 + 艺人零交集
  // + 无时长 → 灰区复核发起——prompt 应带本家声明行
  apiScript = [[song(1, 'Moonlight', 9999000, '别人')]];
  aiScript = [{ match: true }];
  const r = await matchNeteaseSong(['脏串'], 0, 't', null, info);
  assert.equal(r.song.id, 1);
  assert.equal(resolveOrigCalls.length, 0);          // 预注不回源
  assert.equal(aiCalls.length, 1);                   // declSeen=true：该对已在声明
                                                   // 语境判过——收单挑战不重复烧复核
  assert.match(aiCalls[0].user, /来源描述声明本家：Moonlight — shima/);
});

test('惰性解析命中后：派生轮灰区复核 prompt 同样带声明行', async () => {
  reset();
  const info = { title: '脏标题', author: 'up主', trackId: 'yt_abcdefghijk' };
  resolveOrigImpl = async () => ({ videoId: 'orig0000001', title: 'Moonlight', author: 'shima' });
  // 首轮灭；派生 'shima Moonlight' 搜回艺人不符的同名曲 → 50 灰区复核；
  // 声明行是证据不是保送——AI 否决照样记 veto 放行下一轮
  apiScript = [[], [song(1, 'Moonlight', 9999000, '别人')]];
  aiScript = [{ match: false }, { queries: [] }, { match: 0 }];
  const r = await matchNeteaseSong(['脏串'], 0, 't', null, info);
  assert.equal(r.song, null);
  assert.equal(resolveOrigCalls.length, 1);
  assert.equal(aiCalls.length, 2);                   // confirm + extract（兜底池被 veto 清空）
  assert.match(aiCalls[0].user, /来源描述声明本家：Moonlight — shima/);
});

test('AI 兜底 pick 的 prompt 同带本家声明行', async () => {
  reset();
  const info = { title: '甲', author: 'A', trackId: 'yt_abcdefghijk',
    original: { title: 'Moonlight', author: 'shima' } };
  // 首轮与两条派生串（'shima Moonlight'/'Moonlight'）全灭 → 兜底见声明行
  apiScript = [[song(5, '无关', 0)], [], []];
  aiScript = [{ queries: [] }, { match: 1 }];
  const r = await matchNeteaseSong(['甲'], 0, 't', null, info);
  assert.equal(r.song.id, 5);
  assert.equal(r.query, 'ai:pick');
  assert.match(aiCalls[1].user, /来源描述声明本家：Moonlight — shima/);
});

test('惰性边界：yt_ 收单决断花一跳解析（memoize），非 yt_ trackId 整段跳过', async () => {
  reset();
  // 首轮确定性命中——收单决断挑战内完成解析（每曲至多一跳：声明在位才
  // 复核，解析空手按无声明照收）。旧语义 ≥80 连这一跳都免，新语义用
  // 一跳换「声明在场」的证据位
  apiScript = [[song(1, 'Hit', 200000, 'AB')]];
  const r1 = await matchNeteaseSong(['Hit'], 0, 't', null,
    { title: 'T', author: 'AB', trackId: 'yt_abcdefghijk' });
  assert.equal(r1.song.id, 1);
  assert.equal(resolveOrigCalls.length, 1);
  assert.equal(aiCalls.length, 0);            // 解析空手→无声明可核→零复核
  // bv_ 前缀全灭也不回源——惰性解析是 yt_ 来源专属
  aiOn = false;
  apiScript = [[]];
  const r2 = await matchNeteaseSong(['甲'], 0, 't', null,
    { title: 'T', author: 'A', trackId: 'bv_BV1xx411c7mD' });
  assert.equal(r2.song, null);
  assert.equal(resolveOrigCalls.length, 1);   // 不增——bv_ 永远不进解析
});

test('resolveOriginalInfo 抛错静默——漏斗按无本家续走 AI 兜底', async () => {
  reset();
  resolveOrigImpl = async () => { throw new Error('取流全灭'); };
  const info = { title: 'T', author: 'A', trackId: 'yt_abcdefghijk' };
  apiScript = [[song(5, '无关', 0)]];
  aiScript = [{ queries: [] }, { match: 1 }];
  const r = await matchNeteaseSong(['甲'], 0, 't', null, info);
  assert.equal(r.song.id, 5);
  assert.equal(r.query, 'ai:pick');
  assert.equal(resolveOrigCalls.length, 1);
  assert.equal(info.original, undefined);            // 空手不注字段
});

// ── 收单决断前的声明挑战（时序修复：证据先于决断到场）───────────────
// 病灶实案：'□° ver.EMA' s76 确定性收进 EMA 自己另一首（声明是 宇田もずく
// '□°'）；'早く帰りたい' s52 灰区错收古井戸（声明是 ポップしなないで）。
// 同案第二洞：'Moonlight ver.EMA' 后续串 s88 撞名凭分数豁免直收同题异曲
// ——修法：yt_ 的收单决断前先 ensureOriginal，声明在位的决断全分位过
// 复核——重判/派生串翻案；无声明即无证据可核，维持豁免零漂移

test('弱确定性收单（s75）被本家声明挑战翻案：重判否决 → 派生串收真身', async () => {
  reset();
  // '□° ver.EMA' 实案型：撞名收单=名精确 50 + 艺人成员级交集 25 = 75
  const info = { title: 'Moonlight ver.EMA', author: 'EMA', artists: ['EMA'], trackId: 'yt_ozw1EG3QORc' };
  resolveOrigImpl = async () => ({ title: 'Moonlight', author: '宇田もずく' });
  apiScript = [
    [song(1, 'Moonlight', 200000, 'EMA×ZZ')],     // 撞名错配：50+25=75 弱确定性
    [song(7, 'Moonlight', 200000, '宇田もずく')],  // 派生串命中真身：50+30=80
  ];
  aiScript = [{ match: false }, { match: true }]; // 声明语境重判否决 + 派生串收单复核放行
  const r = await matchNeteaseSong(['Moonlight'], 0, 't', null, info);
  assert.equal(r.song.id, 7);
  assert.equal(r.query, '宇田もずく Moonlight');
  assert.equal(resolveOrigCalls.length, 1);       // 收单决断前解析——唯一一跳
  // 挑战重判 + 派生串收单复核各一次——派生面收单同属声明在位的收单决断
  assert.equal(aiCalls.length, 2);
  assert.match(aiCalls[0].user, /来源描述声明本家：Moonlight — 宇田もずく/);
  assert.deepEqual(apiCalls.map(c => c.keywords), ['Moonlight', '宇田もずく Moonlight']);
});

test('灰区复核放行后仍被声明挑战翻案——判决先于证据的时序修复', async () => {
  reset();
  // '早く帰りたい' 实案型：旧流灰区复核过了就收——但那判没带声明语境
  const info = { title: '早く帰りたい 歌ってみた', author: 'coverup', trackId: 'yt_t0Uwq6THbKE' };
  resolveOrigImpl = async () => ({ title: '早く帰りたい', author: 'ポップしなないで' });
  apiScript = [
    [song(1, '早く帰りたい', 0, '古井戸')],                // 同名异曲 50 灰区
    [song(9, '早く帰りたい', 200000, 'ポップしなないで')],  // 派生串真身 50+30=80
  ];
  // 旧判放行 → 声明重判否决；派生串收单属声明在位的收单决断——同过复核
  aiScript = [{ match: true }, { match: false }, { match: true }];
  const r = await matchNeteaseSong(['早く帰りたい'], 0, 't', null, info);
  assert.equal(r.song.id, 9);
  assert.equal(r.query, 'ポップしなないで 早く帰りたい');
  assert.equal(aiCalls.length, 3);
  assert.doesNotMatch(aiCalls[0].user, /来源描述声明本家/);   // 首判无声明（时序钉）
  assert.match(aiCalls[1].user, /来源描述声明本家：早く帰りたい — ポップしなないで/);
  assert.match(aiCalls[2].user, /来源描述声明本家：早く帰りたい — ポップしなないで/);
});

test('≥80 强收单在声明缺席时豁免——一跳解析空手，零复核直收', async () => {
  reset();
  // 「无声明即无证据可核」：分数豁免通道已废，但解析空手时挑战不烧复核——
  // 收单决断花掉的只有 memoize 一跳
  apiScript = [[song(1, 'Hit', 200000, 'AB')]];      // 50+30+20=100
  const r = await matchNeteaseSong(['Hit'], 200, 't', null,
    { title: 'T', author: 'AB', trackId: 'yt_abcdefghijk' });
  assert.equal(r.song.id, 1);
  assert.equal(r.score, 100);
  assert.equal(resolveOrigCalls.length, 1);          // 决断即解析（旧语义此跳也免）
  assert.equal(aiCalls.length, 0);                   // 无声明 → 零复核直收
});

test('声明解析空手/异常 → 弱收单照返不误（fail-soft 两形态）', async () => {
  // null 回包：挑战发起但没证据——维持原收单且不重判
  reset();
  apiScript = [[song(1, 'Hit', 0, 'AB×ZZ')]];        // 50+25=75 弱确定性
  let r = await matchNeteaseSong(['Hit'], 0, 't', null,
    { title: 'T', author: 'AB', trackId: 'yt_abcdefghijk' });
  assert.equal(r.song.id, 1);
  assert.equal(resolveOrigCalls.length, 1);
  assert.equal(aiCalls.length, 0);
  // 异常同口径
  reset();
  resolveOrigImpl = async () => { throw new Error('取流灭'); };
  apiScript = [[song(2, 'Hit', 0, 'AB×ZZ')]];
  r = await matchNeteaseSong(['Hit'], 0, 't', null,
    { title: 'T', author: 'AB', trackId: 'yt_abcdefghijk' });
  assert.equal(r.song.id, 2);
  assert.equal(resolveOrigCalls.length, 1);
  assert.equal(aiCalls.length, 0);
});

test('声明派生串插队到剩余候选之前打（apiCalls 序钉死）', async () => {
  reset();
  const info = { title: '脏稿', author: 'EMA', trackId: 'yt_RvEkVR0Fbao' };
  resolveOrigImpl = async () => ({ title: '本家曲', author: '本家P' });
  apiScript = [
    [song(1, '曲一', 0, 'EMA×ZZ')],    // 首串弱收单（75）→ 挑战否决
    [],                                // 派生 '本家P 本家曲' 空
    [],                                // 派生 '本家曲' 空
    [song(9, '曲二', 0, 'EMA')],       // 剩余候选照旧走（80 收）
  ];
  aiScript = [{ match: false }, { match: true }];   // 挑战否决 + '曲二' 收单复核放行
  const r = await matchNeteaseSong(['曲一', '曲二'], 0, 't', null, info);
  assert.equal(r.song.id, 9);
  assert.equal(r.query, '曲二');
  // 第一方证据不排尾：两条派生串先于剩余候选 '曲二'
  assert.deepEqual(apiCalls.map(c => c.keywords),
    ['曲一', '本家P 本家曲', '本家曲', '曲二']);
  // 挑战重判 + '曲二' s80 收单复核——声明在位的收单决断全分位过复核
  assert.equal(aiCalls.length, 2);
});

test('确定性收单被声明否决后：同串余下候选转灰区流续面（连否判空）', async () => {
  reset();
  const info = { title: '稿', author: 'EMA', trackId: 'yt_RvEkVR0Fbao' };
  resolveOrigImpl = async () => ({ title: '本家曲', author: '本家P' });
  apiScript = [[
    song(1, '撞名曲', 0, 'EMA×ZZ'),    // top 75 → 声明挑战否决
    song(2, '撞名曲', 0, '别人'),      // 次优 50 灰区 → 复核否决
    song(3, '撞名曲', 0, '别人2'),     // 池可疑判空——第 3 个不免检收
  ]];
  aiScript = [{ match: false }, { match: false }, { queries: [] }, { match: 0 }];
  const r = await matchNeteaseSong(['撞名曲'], 0, 't', null, info);
  assert.equal(r.song, null);
  // 挑战重判 + 灰区复核 + extract + pick（池里只剩未否的 id3 被 {match:0} 拒）
  assert.equal(aiCalls.length, 4);
  assert.deepEqual(apiCalls.map(c => c.keywords), ['撞名曲', '本家P 本家曲', '本家曲']);
});

// ── 本家题变体管线（视频标题形态 → 检索料）───────────────────────────
// 病灶实案：本家声明的 title 是视频标题原串（'P主 - 曲名 ft.歌姬【MV】'），
// 原拼接 '频道 视频题' 直搜打不中网易的干净条目——origTitle 侧过同款
// titleVariantsOf 剥缀管线后，剥缀变体与「本家P+变体」组合串成派生检索词

test('本家题是视频标题形态：剥缀变体与组合串进派生检索', async () => {
  reset();
  // GETCHA 实案型：本家视频题 'Giga & KIRA - 'GETCHA!' ft.初音ミク & GUMI【MV】'
  // ——'P主 - 曲名' 头 + 'ft.歌姬' 无空格尾 + 整包围引号壳三层噪声叠【MV】；
  // 剥缀管线收敛出裸歌名 'GETCHA!'（实证网易裸查询 rank1 = 真身原曲）
  const info = { title: 'GETCHA! 歌ってみた', author: 'coverup', trackId: 'yt_abcdefghijk' };
  resolveOrigImpl = async () => ({
    title: "Giga & KIRA - 'GETCHA!' ft.初音ミク & GUMI【MV】",
    author: 'Giga & KIRA',
  });
  apiScript = [[]];                        // 候选串与全部派生串全灭——只钉检索词面
  aiScript = [{ queries: [] }];
  const r = await matchNeteaseSong(['脏串'], 0, 't', null, info);
  assert.equal(r.song, null);
  // 派生序钉死：变体管线 [基座, d剥' - '头, f剥ft.尾, 激进腿裸歌名] ×
  // [本家P组合串, 裸串]——钱查询 'GETCHA!' 与组合串 'Giga & KIRA GETCHA!'
  // 都在末段；任何派生串不带【MV】视频装饰
  assert.deepEqual(apiCalls.map(c => c.keywords), [
    '脏串',
    "Giga & KIRA Giga & KIRA - 'GETCHA!' ft.初音ミク & GUMI",  // 基座组合串
    "Giga & KIRA - 'GETCHA!' ft.初音ミク & GUMI",              // 基座裸串
    "Giga & KIRA 'GETCHA!' ft.初音ミク & GUMI",                // d 剥头变体组合
    "'GETCHA!' ft.初音ミク & GUMI",                            // d 剥头裸变体
    "Giga & KIRA Giga & KIRA - 'GETCHA!'",                     // f 剥ft尾变体组合
    "Giga & KIRA - 'GETCHA!'",                                 // f 剥ft尾裸变体
    'Giga & KIRA GETCHA!',                                     // 激进腿裸歌名组合
    'GETCHA!',                                                 // 钱查询：裸歌名
  ]);
});

test('本家题「曲名 - 歌姬」形态：\' - \' 拆分变体进派生检索', async () => {
  reset();
  // Moonlight 实案型：本家 shima 的视频题 'Moonlight - VY1'——' - ' 前缀剥出
  // 'VY1' 变体（'VY1 Moonlight' 实证命中的同族拆分证据），组合 'shima VY1' 同进
  const info = { title: 'Moonlight 歌ってみた', author: 'coverup', trackId: 'yt_abcdefghijk' };
  resolveOrigImpl = async () => ({ title: 'Moonlight - VY1', author: 'shima' });
  apiScript = [[]];
  aiScript = [{ queries: [] }];
  const r = await matchNeteaseSong(['脏串'], 0, 't', null, info);
  assert.equal(r.song, null);
  assert.deepEqual(apiCalls.map(c => c.keywords), [
    '脏串',
    'shima Moonlight - VY1',   // 基座组合串（原 '频道+题' 形态保留）
    'Moonlight - VY1',         // 基座裸串
    'shima VY1',               // ' - ' 拆分变体组合串
    'VY1',                     // 拆分裸变体
  ]);
});

// ── 声明派生串免时长闸（切片翻唱 vs 原曲的结构性时长失配）──────────────
// 病灶实案：yt_ 87s 切片翻唱自署本家 230s 原曲——'GETCHA!' 派生串云搜命中
// 真身（1479930555），却被 DUR_HARD_GATE_SEC=45 按 143s 差全灭，漏到 AI
// 再生轮收进同题错配（'GETCHA — Fatt Qwake' 126s 恰过闸）。修法：派生串
// 自带第一方出处证据，srcFor 对其按 durationSec:0（无时长证据）打分；
// 常规串时长闸语义不变。免闸只认「以派生身份调度」的串——同一字面值在
// 无声明语境下仍受闸（origDerivedKeys 是角色判面不是字符串白名单）

test('GETCHA 实案回归：87s 切片声明 230s 本家——派生串命中免时长闸收单', async () => {
  reset();
  // 兜底轮路径：常规串先行——同一首 230s 真身在 '切片脏串' 轮照常被 dur 拒
  // （常规串时长闸未失效的对照钉在同用例）；派生 'GETCHA!' 免闸打分 50+25
  // =75 弱确定性 → 掉 dur 分落 <80 挑战带，仍须过声明复核才收单
  const info = { title: '切片脏串', author: 'coverup', trackId: 'yt_abcdefghijk' };
  resolveOrigImpl = async () => ({
    title: "Giga & KIRA - 'GETCHA!' ft.初音ミク & GUMI【MV】",
    author: 'Giga & KIRA',
  });
  const real = song(1479930555, 'GETCHA!', 230000, 'Giga');
  apiScript = [
    [real],                // '切片脏串' 搜到真身 → durDiff143>45 拒（对照钉）
    ...Array(7).fill([]),  // 派生前 7 串全灭
    [real],                // 钱查询 'GETCHA!' 命中——修复前此处同被 dur 拒
  ];
  aiScript = [{ match: true }];   // 挑战复核放行
  const r = await matchNeteaseSong(['切片脏串'], 87, 't', null, info);
  assert.equal(r.song.id, 1479930555);
  assert.equal(r.query, 'GETCHA!');  // 收单归属派生串——常规串轮的 dur 拒是实证
  assert.equal(r.score, 75);         // 时长证据整维让位——无 dur 分的 50+25
  assert.equal(aiCalls.length, 1);   // <80 弱收单照过声明挑战复核（权责不降级）
  assert.match(aiCalls[0].user, /来源描述声明本家：Giga & KIRA - 'GETCHA!'/);
  // 派生串调度序列不变——末位钱查询即收单串
  assert.deepEqual(apiCalls.map(c => c.keywords), [
    '切片脏串',
    "Giga & KIRA Giga & KIRA - 'GETCHA!' ft.初音ミク & GUMI",
    "Giga & KIRA - 'GETCHA!' ft.初音ミク & GUMI",
    "Giga & KIRA 'GETCHA!' ft.初音ミク & GUMI",
    "'GETCHA!' ft.初音ミク & GUMI",
    "Giga & KIRA Giga & KIRA - 'GETCHA!'",
    "Giga & KIRA - 'GETCHA!'",
    'Giga & KIRA GETCHA!',
    'GETCHA!',
  ]);
});

test('对称钉：挑战插队路径的派生串同享免时长闸（主循环 srcFor 共判面）', async () => {
  reset();
  // 同一实案走另一条消费路径：弱确定性收单先触发声明挑战——ensureOriginal
  // 在挑战内完成并把派生串插进 candidates 主循环，srcFor 判面与兜底轮共享
  const info = { title: '切片脏串', author: 'coverup', trackId: 'yt_abcdefghijk' };
  resolveOrigImpl = async () => ({
    title: "Giga & KIRA - 'GETCHA!' ft.初音ミク & GUMI【MV】",
    author: 'Giga & KIRA',
  });
  const real = song(1479930555, 'GETCHA!', 230000, 'Giga');
  apiScript = [
    [song(1, '曲一', 0, 'coverup×ZZ')],  // 50+25=75 弱确定性 → 触发挑战+插队
    ...Array(7).fill([]),                // 插队派生前 7 串全灭
    [real],                              // 'GETCHA!' 命中真身——同不收 dur 拒
  ];
  aiScript = [{ match: false },          // 挑战否决撞名收单 → 候选面继续走
    { match: true }];                    // 派生串命中的挑战复核放行
  const r = await matchNeteaseSong(['曲一'], 87, 't', null, info);
  assert.equal(r.song.id, 1479930555);
  assert.equal(r.query, 'GETCHA!');
  assert.equal(r.score, 75);
  assert.equal(aiCalls.length, 2);       // 挑战重判 + 派生轮复核各一次
  assert.deepEqual(apiCalls.map(c => c.keywords), [
    '曲一',
    "Giga & KIRA Giga & KIRA - 'GETCHA!' ft.初音ミク & GUMI",
    "Giga & KIRA - 'GETCHA!' ft.初音ミク & GUMI",
    "Giga & KIRA 'GETCHA!' ft.初音ミク & GUMI",
    "'GETCHA!' ft.初音ミク & GUMI",
    "Giga & KIRA Giga & KIRA - 'GETCHA!'",
    "Giga & KIRA - 'GETCHA!'",
    'Giga & KIRA GETCHA!',
    'GETCHA!',
  ]);
});

test('免闸是角色判面非串白名单：同字面 GETCHA! 在无声明语境仍被 dur 拒', async () => {
  reset();
  aiOn = false;
  // 无 trackId/无声明——origDerivedKeys 恒空，'GETCHA!' 以常规串身份调度：
  // 87s 源 vs 230s 候选 durDiff143>45 照常被硬拒（既有时长闸语义零漂移）
  apiScript = [[song(1479930555, 'GETCHA!', 230000, 'Giga')]];
  const r = await matchNeteaseSong(['GETCHA!'], 87, 't', null,
    { title: '切片', author: 'up' });
  assert.equal(r.song, null);
  assert.equal(apiCalls.length, 1);
});

// ── 弱收单待定（heldHit）：本家派生串未跑完前不截停 ──────────────────
// 病灶实案：'Moonlight ver.EMA'（投稿者 EMA，声明本家 'Moonlight - VY1'/
// shima）——主循环首串弱收单 'Moonlight (Single Ver.)'/Mosq（同题异艺人，
// 声明复核判 ok）即 return，origDerived 里压着没跑的第一方检索词
// （'shima VY1' 等）永远没机会出场——能把带 作曲:shima 署名的真身词条
// 打进候选的检索被截停。修法：弱收单+身后有未跑派生 → 记待定最优挂起；
// 派生串收单（自带声明复核）即终态；全打完无新收单才回补待定命中

test('弱收单待定：声明复核放行的弱候选不截停——派生串随后打、命中即收单', async () => {
  reset();
  const info = { title: 'Moonlight ver.EMA', author: 'EMA', artists: ['EMA'], trackId: 'yt_abcdefghijk' };
  resolveOrigImpl = async () => ({ title: 'Moonlight - VY1', author: 'shima' });
  apiScript = [
    [song(1, 'Moonlight (Single Ver.)', 200000, 'Mosq')], // 45+0+20=65 灰区弱命中
    [],                                   // 'shima Moonlight - VY1' 空
    [],                                   // 'Moonlight - VY1' 空
    [song(9, 'Moonlight', 200000, 'shima')],  // 'shima VY1' 命中真身 50+30=80
  ];
  // 灰区复核放行（无声明语境）+ 声明挑战重判放行 + 派生串收单复核放行——
  // 旧实现此处直接收单 id1
  aiScript = [{ match: true }, { match: true }, { match: true }];
  const r = await matchNeteaseSong(['Moonlight ver.EMA'], 200, 't', null, info);
  assert.equal(r.song.id, 9);
  assert.equal(r.query, 'shima VY1');        // 收单归属派生串——弱命中没截停它
  assert.equal(r.score, 80);
  // 修复前 apiCalls 止于首串；待定后派生串被插队检索——且 'shima VY1' 收单
  // 即终态，'VY1' 与剩余候选 'Moonlight' 都不再白打
  assert.deepEqual(apiCalls.map(c => c.keywords),
    ['Moonlight ver.EMA', 'shima Moonlight - VY1', 'Moonlight - VY1', 'shima VY1']);
  // 灰区复核 + 挑战重判 + 派生串 s80 收单复核——分数豁免已废，派生面收单
  // 同属声明在位的收单决断
  assert.equal(aiCalls.length, 3);
  assert.equal(resolveOrigCalls.length, 1);
});

test('弱收单待定回补：派生面全打空 → 首个弱候选回补收单（query=原串）', async () => {
  reset();
  const info = { title: 'Moonlight ver.EMA', author: 'EMA', artists: ['EMA'], trackId: 'yt_abcdefghijk' };
  resolveOrigImpl = async () => ({ title: 'Moonlight - VY1', author: 'shima' });
  apiScript = [
    [song(1, 'Moonlight (Single Ver.)', 200000, 'Mosq')], // 弱命中→待定
    [], [], [], [],                                       // 四条派生串全空
    [],                                                   // 剩余候选 'Moonlight' 也空
  ];
  aiScript = [{ match: true }, { match: true }];
  const r = await matchNeteaseSong(['Moonlight ver.EMA'], 200, 't', null, info);
  assert.equal(r.song.id, 1);                  // 待定最优回补——仍是首个弱候选
  assert.equal(r.query, 'Moonlight ver.EMA');
  assert.equal(r.score, 65);
  assert.deepEqual(apiCalls.map(c => c.keywords),
    ['Moonlight ver.EMA', 'shima Moonlight - VY1', 'Moonlight - VY1', 'shima VY1', 'VY1', 'Moonlight']);
  assert.equal(aiCalls.length, 2);   // 回补先于再生轮——extract/pick 未发起
});

test('派生串收单即终态：首条派生命中后余下派生串不再打（apiCalls 截停）', async () => {
  reset();
  const info = { title: 'Moonlight ver.EMA', author: 'EMA', artists: ['EMA'], trackId: 'yt_abcdefghijk' };
  resolveOrigImpl = async () => ({ title: 'Moonlight - VY1', author: 'shima' });
  apiScript = [
    [song(1, 'Moonlight (Single Ver.)', 200000, 'Mosq')],   // 弱命中→待定
    [song(9, 'Moonlight', 200000, 'shima')],                // 首条派生即命中真身
  ];
  // 复核×2（灰区+挑战）+ 派生串收单复核——声明在位的收单决断全分位过复核
  aiScript = [{ match: true }, { match: true }, { match: true }];
  const r = await matchNeteaseSong(['Moonlight ver.EMA'], 200, 't', null, info);
  assert.equal(r.song.id, 9);
  assert.equal(r.query, 'shima Moonlight - VY1');
  // 身后还有 3 条派生串 + 剩余候选——同池同证据的后续串不更优，全部不打
  assert.deepEqual(apiCalls.map(c => c.keywords),
    ['Moonlight ver.EMA', 'shima Moonlight - VY1']);
  assert.equal(aiCalls.length, 3);
});

test('声明在场 + ≥80 声明一致候选：复核放行即时收——烧一发 AI 属预期', async () => {
  reset();
  // 预注声明在场时 ≥80 不再免挑战——收单决断过带声明行的复核（新语义），
  // 放行后不挂起等派生（复核放行的命中属「证据问已结」）——apiCalls 仍 1
  const info = { title: 'Hit', author: 'AB', trackId: 'yt_abcdefghijk',
    original: { title: 'Moonlight', author: 'shima' } };
  apiScript = [[song(1, 'Hit', 200000, 'AB')]];   // 50+30+20=100 确定性收
  aiScript = [{ match: true }];                    // 声明语境复核放行
  const r = await matchNeteaseSong(['Hit'], 200, 't', null, info);
  assert.equal(r.song.id, 1);
  assert.equal(r.query, 'Hit');
  assert.equal(resolveOrigCalls.length, 0);        // 预注声明——零回源
  assert.equal(aiCalls.length, 1);                 // 新语义钉：≥80 也烧一发复核
  assert.equal(apiCalls.length, 1);                // 复核放行即终态——派生面没空打
  assert.match(aiCalls[0].user, /来源描述声明本家：Moonlight — shima/);
});

test('待定后被否决不复活：heldHit 在派生轮遭 AI 否决 → 回补让位兜底链', async () => {
  reset();
  const info = { title: 'Moonlight ver.EMA', author: 'EMA', artists: ['EMA'], trackId: 'yt_abcdefghijk' };
  resolveOrigImpl = async () => ({ title: 'Moonlight - VY1', author: 'shima' });
  // 'Mosq×shima'：首串轮 srcArtists 仅 ['EMA'] → 艺人 0 → 65 灰区待定；
  // 派生轮声明并入后艺人 25 → 70 灰区再过复核——此处否决即记 veto
  const wrong = song(1, 'Moonlight (Single Ver.)', 200000, 'Mosq×shima');
  apiScript = [
    [wrong],       // 首串弱命中→待定
    [wrong],       // 'shima Moonlight - VY1' 搜回同首 → 复核否决记 veto
    [], [], [],    // 余下派生串全空
    [],            // 剩余候选 'Moonlight' 空
  ];
  aiScript = [{ match: true }, { match: true }, { match: false },
    { queries: [] }];
  const r = await matchNeteaseSong(['Moonlight ver.EMA'], 200, 't', null, info);
  // 「否决不经任何路径复活」对待定回补同成立——veto 过的 id 不回补
  assert.equal(r.song, null);
  assert.equal(aiCalls.length, 4);   // 复核+挑战+派生轮否决+extract（pick 池空未发起）
});

test('声明复核放行跨串记忆：同曲 ≥ACCEPT 复现不重问——抖动脚本翻不了案', async () => {
  reset();
  // 修复前漏洞：declSeen/aiChecked 都不跨查询存续——q1 声明复核放行的歌
  // 在 q2 以 ≥ACCEPT top 复现时 challengeAccept 恒重发同 prompt 复核，
  // 模型抖动把已放行歌曲翻成否决、vetoedIds 连 heldHit 回补一并堵死。
  // declClearedIds 记 (源,候选) 对级终态：复现直返，同一问题不再重答
  const info = { title: 'Moonlight ver.EMA', author: 'EMA', artists: ['EMA'], trackId: 'yt_abcdefghijk' };
  resolveOrigImpl = async () => ({ title: 'Moonlight - VY1', author: 'shima' });
  const hit = song(1, 'Moonlight', 200000, 'shima');
  apiScript = [
    [hit],            // '脏串'：声明未解析 srcArtists 仅 ['EMA']→50+0+20=70
                      // 灰区→复核放行→挑战放行（记入 declClearedIds）→待定
    [], [], [], [],   // 四条派生串全空
    [hit],            // 'Moonlight'：shima 已并入艺人面→50+30+20=100
                      // ≥ACCEPT 复现——挑战直返，同 prompt 不再重答
  ];
  // 尾弹 {match:false} 是故意排的抖动：修复前它会被复现轮挑战消费掉→
  // 否决记 veto→回补堵死（song=null）；修复后永远轮不到它
  aiScript = [{ match: true }, { match: true }, { match: false }];
  const r = await matchNeteaseSong(['脏串', 'Moonlight'], 200, 't', null, info);
  assert.equal(r.song.id, 1);
  assert.equal(r.query, 'Moonlight');    // 收单归属复现串——不翻转
  assert.equal(r.score, 100);
  assert.equal(aiCalls.length, 2);       // 灰区复核+挑战复核——复现零调用
  assert.equal(aiScript.length, 1);      // 抖动否决没被消费=同题没再问
  assert.match(aiCalls[1].user, /来源描述声明本家：Moonlight - VY1 — shima/);
  assert.deepEqual(apiCalls.map(c => c.keywords),
    ['脏串', 'shima Moonlight - VY1', 'Moonlight - VY1', 'shima VY1', 'VY1', 'Moonlight']);
  assert.equal(resolveOrigCalls.length, 1);
});

// ── 分数豁免洞收口（本轮病灶实证）────────────────────────────────────
// 'Moonlight ver.EMA'（声明 'Moonlight - VY1'/shima）heldHit 让位后，后续
// 串撞进 s88 级同题异曲——旧语义 ≥80 免挑战直收。新语义：声明在位的每次
// 收单决断都过声明语境复核，分数不再是免证据通道

test('实案回归：后续串强收单撞名（s100，旧豁免带）——声明复核否决记 veto', async () => {
  reset();
  // 首串弱命中复核放行→待定让位；'Moonlight' 串撞进 EMA 自己另一首
  // 'Moonlight'（名50+艺30+时长20=100 强叠合）——旧实现此处免挑战直收
  // 同题异曲。新语义否决记 veto，后续候选串命中声明一致的真身照样收
  const info = { title: 'Moonlight ver.EMA', author: 'EMA', artists: ['EMA'], trackId: 'yt_abcdefghijk' };
  resolveOrigImpl = async () => ({ title: 'Moonlight - VY1', author: 'shima' });
  apiScript = [
    [song(1, 'Moonlight (Single Ver.)', 200000, 'Mosq')],  // 65 灰区弱命中→待定
    [], [], [], [],                                        // 四条派生串全空
    [song(2, 'Moonlight', 200000, 'EMA')],                 // 'Moonlight' 撞名 s100→复核否决
    [song(9, 'Moonlight', 200000, 'shima')],               // 尾串收声明一致的真身
  ];
  aiScript = [{ match: true }, { match: true }, { match: false }, { match: true }];
  const r = await matchNeteaseSong(['Moonlight ver.EMA', '尾串'], 200, 't', null, info);
  assert.equal(r.song.id, 9);
  assert.equal(r.query, '尾串');
  assert.equal(r.score, 100);
  // 复核否决只记在 veto（同题异曲 id2 不进兜底）；两次强收单决断都带
  // 声明行过复核——分数不构成豁免的证据
  assert.equal(aiCalls.length, 4);
  assert.match(aiCalls[2].user, /来源描述声明本家：Moonlight - VY1 — shima/);
  assert.match(aiCalls[3].user, /来源描述声明本家：Moonlight - VY1 — shima/);
  assert.deepEqual(apiCalls.map(c => c.keywords),
    ['Moonlight ver.EMA', 'shima Moonlight - VY1', 'Moonlight - VY1', 'shima VY1', 'VY1', 'Moonlight', '尾串']);
  assert.equal(resolveOrigCalls.length, 1);        // 解析每曲一跳（memoize）
});

test('AI 关+声明在场：未复核的强收单同挂起等派生——分数不免证据位', async () => {
  reset();
  aiOn = false;
  // 声明在场但复核跑不了（AI 关）时，≥80 收单不再凭分数即时截停——
  // 与弱命中同待遇挂起，让第一方派生串先打；派生命中即终态
  const info = { title: 'Moonlight ver.EMA', author: 'EMA', artists: ['EMA'], trackId: 'yt_abcdefghijk' };
  resolveOrigImpl = async () => ({ title: 'Moonlight - VY1', author: 'shima' });
  apiScript = [
    [song(2, 'Moonlight', 200000, 'EMA')],                  // 撞名 s100——无 AI 复核没跑
    [song(9, 'Moonlight', 200000, 'shima')],                // 派生 'shima Moonlight - VY1' 收真身
  ];
  const r = await matchNeteaseSong(['Moonlight ver.EMA'], 200, 't', null, info);
  assert.equal(r.song.id, 9);
  assert.equal(r.query, 'shima Moonlight - VY1');
  assert.equal(aiCalls.length, 0);
  assert.deepEqual(apiCalls.map(c => c.keywords),
    ['Moonlight ver.EMA', 'shima Moonlight - VY1']);
});

// ── 派生串证据进兜底池（F3）／heldHit 最优保留（N5）／撞键判面（N6）／
// author-only 并入（N8）／warnFail 静默 abort（N7）─────────────────────

test('派生串搜出条目免 120s 粗闸：pick 兜底挑中的派生面命中不被时长差杀', async () => {
  reset();
  // GETCHA 实案变体：87s 切片声明 230s 本家——派生串搜出的真身名不沾边
  // （打分 <50 沉进 seenSongs+derivedSeenIds），启发式/再生全灭后 pick
  // 兜底挑中；|230-87|=143>120 的粗闸弃票会把它杀掉落负行——派生串自带
  // 声明证据（打分面已按无时长证据免 dur）又经模型点名，双重证据在场
  const info = { title: '切片脏串', author: 'coverup', trackId: 'yt_abcdefghijk' };
  resolveOrigImpl = async () => ({ title: '本家曲', author: '本家P' });
  const real = song(1479930555, 'GETCHA!', 230000, 'Giga');
  apiScript = [
    [],                  // 常规串 '切片脏串' 空
    [],                  // 兜底派生 '本家P 本家曲' 空
    [real],              // 兜底派生 '本家曲' 搜回真身——名不沾边沉池留证
  ];
  aiScript = [{ queries: [] }, { match: 1 }];
  const r = await matchNeteaseSong(['切片脏串'], 87, 't', null, info);
  assert.equal(r.song.id, 1479930555);   // 修复前被 120s 粗闸弃票 → null
  assert.equal(r.query, 'ai:pick');
  assert.equal(aiCalls.length, 2);       // extract + pick
  assert.deepEqual(apiCalls.map(c => c.keywords),
    ['切片脏串', '本家P 本家曲', '本家曲']);
});

test('对照：非派生面候选仍吃 120s 粗闸——派生豁免不溢出到常规串', async () => {
  reset();
  // 同一 143s 时长差、同一首歌——只是调度身份不同：常规串搜出的 dur 拒
  // 条目留兜底池但不属派生集，pick 挑中照样被粗闸弃票（无出处证据面的
  // 护栏不动）
  apiScript = [[song(1479930555, 'GETCHA!', 230000, 'Giga')]];
  aiScript = [{ queries: [] }, { match: 1 }];
  const r = await matchNeteaseSong(['GETCHA!'], 87, 't', null,
    { title: '切片', author: 'up' });
  assert.equal(r.song, null);
  assert.equal(aiCalls.length, 2);
});

test('待定最优=分高者留：撞键派生字面同享待定判面，低分后来者不覆盖 heldHit', async () => {
  reset();
  // 声明本家题 'Moonlight' 产派生字面 'Moonlight'——与既有候选串撞键：
  // 不入队重打但同记 origDerivedKeys（角色判面按字面生效）——'脏串二'
  // 弱命中时 'Moonlight' 仍压在身后 → 第二格待定成立；50<60 不覆盖已持
  // 待定——全灭后回补的是先到的高分命中而非最后被挂起的那个
  const info = { title: '脏稿', author: 'EMA', trackId: 'yt_abcdefghijk' };
  resolveOrigImpl = async () => ({ title: 'Moonlight', author: 'shima' });
  apiScript = [
    [song(1, '脏串一', 215000, 'Mosq')],  // 名50+艺0+时10=60 灰区→待定
    [],                                   // 插队派生 'shima Moonlight' 空
    [song(2, '脏串二', 0, 'Mosq')],        // 名50+艺0+无时长=50 灰区→待定(50<60 不盖)
    [],                                   // 撞键字面 'Moonlight'（常规候选身份）空
  ];
  aiScript = [{ match: true }, { match: true }, { match: true }];
  const r = await matchNeteaseSong(['脏串一', '脏串二', 'Moonlight'], 200, 't', null, info);
  assert.equal(r.song.id, 1);             // 待定最优回补——高分的先到者
  assert.equal(r.query, '脏串一');
  assert.equal(r.score, 60);
  assert.equal(aiCalls.length, 3);        // 复核 + 挑战重判 + '脏串二' 复核
  assert.deepEqual(apiCalls.map(c => c.keywords),
    ['脏串一', 'shima Moonlight', '脏串二', 'Moonlight']);
});

test('待定最优同分守先到：同分后来者不覆盖 heldHit——严格 > 语义钉死', async () => {
  reset();
  // acceptOrHold 的 `hit.score > heldHit.score` 严格大于隐含「同分守先到」。
  // 若被误改成 >=，后到同分命中会静默盖掉先到者——本用例两候选同 60 分
  // （名50+艺0+时10），回补必须仍归首串命中
  const info = { title: '脏稿', author: 'EMA', trackId: 'yt_abcdefghijk' };
  resolveOrigImpl = async () => ({ title: 'Moonlight', author: 'shima' });
  apiScript = [
    [song(1, '脏串一', 215000, 'Mosq')],  // 名50+艺0+时10=60 灰区→待定
    [],                                   // 插队派生 'shima Moonlight' 空
    [song(2, '脏串二', 215000, 'Mosq')],  // 同 60 灰区→待定（同分不盖先到者）
    [],                                   // 撞键字面 'Moonlight'（常规候选身份）空
  ];
  aiScript = [{ match: true }, { match: true }, { match: true }];
  const r = await matchNeteaseSong(['脏串一', '脏串二', 'Moonlight'], 200, 't', null, info);
  assert.equal(r.song.id, 1);             // 同分先到者回补——>= 会翻成 id 2
  assert.equal(r.query, '脏串一');
  assert.equal(r.score, 60);
  assert.equal(aiCalls.length, 3);
  assert.deepEqual(apiCalls.map(c => c.keywords),
    ['脏串一', 'shima Moonlight', '脏串二', 'Moonlight']);
});

test('author-only 本家声明并入艺人参照面——缺题不丢艺人轴证据', async () => {
  reset();
  // 声明只自署艺人（题缺席）：origDeclLine 对 author-only 同样产段——
  // 判定面看得到艺人轴证据，打分参照面同口径并入 srcArtists；
  // 并入后声明艺人候选吃 +30 艺人分
  const info = { title: '撞名稿', author: 'coverup', trackId: 'yt_abcdefghijk' };
  resolveOrigImpl = async () => ({ title: '', author: 'shima' });   // author-only
  apiScript = [
    [song(1, '撞名', 200000, 'Mosq')],        // 50+0+20=70 灰区→复核放行→挑战否决
    [song(2, 'Moonlight', 200000, 'shima')],  // 并入后 50+30+20=100 确定性收
  ];
  aiScript = [{ match: true }, { match: false }, { match: true }];
  const r = await matchNeteaseSong(['撞名', 'Moonlight'], 200, 't', null, info);
  assert.equal(r.song.id, 2);
  assert.equal(r.query, 'Moonlight');
  // 修复前 srcArtists 恒 ['coverup'] → 该命中只有 50+0+20=70 灰区
  assert.equal(r.score, 100);
  assert.equal(aiCalls.length, 3);
  // author-only 声明在复核 prompt 也产段（缺席槽位填「未知」）
  assert.match(aiCalls[1].user, /来源描述声明本家：未知 — shima/);
});

test('warnFail 静默 abort：预算/断连掐断的在途云搜不记噪声 warn', async () => {
  reset();
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    // abort 面：云搜在途被掐断抛错——signal 已 abort 的不记 warn
    const ctl = new AbortController();
    apiScript = [async () => { ctl.abort(); throw new Error('掐断在途'); }];
    const r = await matchNeteaseSong(['X'], 0, 't', ctl.signal, src);
    assert.equal(r.song, null);
    assert.equal(warns.length, 0);
    // e.aborted 面同静默：上游 abort 拒绝冒泡、调用方 signal 仍活——
    // 与 lyric-external 的 e?.aborted || signal?.aborted 口径对齐，
    // 该拒绝链上的 in-flight 掐断同样不是源故障
    apiScript = [Object.assign(new Error('上游 in-flight 掐断'), { aborted: true })];
    const r2 = await matchNeteaseSong(['Z'], 0, 't', null, src);
    assert.equal(r2.song, null);
    assert.equal(warns.length, 0);
    // 非 abort 真故障照常记——静默只掐 abort 面
    apiScript = [new Error('风控')];
    await matchNeteaseSong(['Y'], 0, 't', null, src);
    assert.equal(warns.length, 1);
    assert.match(warns[0], /风控/);
  } finally { console.warn = origWarn; }
});

// ── CJK 繁简异体折叠端到端（netease-score normToken 折叠面接入打分池）──
// 实案：yt_ 曲「懐中道標 ver.EMA」（EMA，332s）应绑网易 id=668118
// 「懐中道标/やなぎなぎ」（338s）——同作品原唱，词文相同。修复前
// pairTitleScore 不折叠繁简 → title=0 → title<15 封顶灰区下，逐项
// 复核根本轮不到；折叠后 50+0+10=60 灰区走复核放行收下

test('繁简异体标题端到端：翻唱源「懐中道標」× 网易「懐中道标」灰区复核收下', async () => {
  reset();
  apiScript = [[song(668118, '懐中道标', 338000, 'やなぎなぎ')]];
  aiScript = [{ match: true }];
  const r = await matchNeteaseSong(['懐中道標'], 332, 't', null,
    { title: '懐中道標 ver.EMA', author: 'EMA', artists: ['EMA'] });
  assert.equal(r.song.id, 668118);
  assert.equal(r.query, '懐中道標');       // 启发式串收下，非 ai: 前缀路径
  assert.equal(r.score, 60);               // 50+0+10 灰区——修复前 title=0 总分 10
  assert.equal(aiCalls.length, 1);         // 复核确实发起——修复前该候选进不了灰区池
});

// ── AI 单发超时与 retry 预算钉（fs 静态断言，同 virtual-scroll-anchor
//    的文本钉法）──────────────────────────────────────────────────────
// 复核/再生/兜底三处 askAiJson 曾写死 timeoutMs:10000——慢模型部署（实测
// ~16s/发）下每发必超时，AI 复核层形同关闭。单发时限归 AI_TIMEOUT_MS env
// 治理（lib/ai.js 默认 30s）：本文件不得再出现任何 timeoutMs 覆写；
// 总时长纪律由 matchWithBudget 的 budgetMs 总闸承担。
// /match/retry 是唯一拿到加宽预算的 matchWithBudget 调用方（55s——客户端
// axios 60s 超时之下留头，推导见路由内注释）；yt/bv/qq resolve 单曲路径
// 保持默认 25s（解析链要快，预算耗尽按无匹配回落）不跟进
const matchImplSrc = readFileSync(
  new URL('../src/server/services/netease-match.js', import.meta.url), 'utf8');
const matchRouteSrc = readFileSync(
  new URL('../src/server/routes/match.js', import.meta.url), 'utf8');

test('netease-match.js 三处 AI 调用不写死 timeoutMs——归 env 治理', () => {
  assert.doesNotMatch(matchImplSrc, /timeoutMs\s*:/);
});

test('/match/retry 显式传 55s 匹配预算（客户端 60s 超时之下留头）', () => {
  // (?![\d_]) 边界锚：值尾巴再跟数字/下划线（如 550000）时拒绝前缀误命中
  assert.match(matchRouteSrc, /budgetMs:\s*55_?000(?![\d_])/);
});

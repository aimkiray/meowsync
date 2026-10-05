// netease-match.js 回归测试：两个上游依赖（云搜 + AI）用 require.cache 预播种
// stub——netease-match 在 require 时解构绑定，必须在首次 require 之前就位。
// node --test 每文件独立进程，全局污染安全。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
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
const aiCalls = [];      // 记录每次 AI 调用——「零调用」断言不能只靠脚本剩量
                          // （空脚本上调用返回 null 不留痕迹）

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
  askAiJson: async () => { aiCalls.push(1); return aiScript.length ? aiScript.shift() : null; },
  aiModel: () => aiModelName,
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
  // author/artists 全缺 → artist 中立 15；互含 title 45 + 时长近 16 = 76
  // 修复前越过 ≥75 误收；修复后 <50 丢弃，只剩 AI 兜底池可救
  apiScript = [[song(2, '乐园', 236000, '别人2')]];
  aiScript = [{ queries: [] }, { match: 0 }];
  const r = await matchNeteaseSong(['乐园(粤)'], 240, 't', null, { title: '乐园(粤)' });
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

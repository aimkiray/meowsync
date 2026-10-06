// netease-match candidates 标题变体展开钉测——漏斗层统一剥 UGC 噪声：
//   yt_ 实案 '_ sasayakuを歌いました ／ rei sirose'（author='_'）经
//   titleVariantsOf 展开+行首占位 token 剥除后出真名 'sasayaku'，
//   命中网易云 1316563227（时长零差+曲名精确）——修复前候选串全带噪全灭。
// 覆盖：expandSearchQueries 展开序/剥头/dedup/cap 8、三类噪声（ver.尾/
//   covered by/【】头）、占位作者判定与 artists 槽过滤、端到端命中。
// 上游 stub 面与 netease-match.test.mjs 同口径：require.cache 预播种，
// 必须在首次 require netease-match 之前就位；node --test 每文件独立进程。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-matchvar-');
const require = createRequire(import.meta.url);

let aiOn = true;
let aiScript = [];
let apiScript = [];      // cloudsearch 依次返回 {songs:[...]}（数组即 result.songs）
const apiCalls = [];
const aiCalls = [];

const apiPath = require.resolve('../src/server/services/netease-api.js');
const aiPath = require.resolve('../src/server/lib/ai.js');
require.cache[apiPath] = { id: apiPath, filename: apiPath, loaded: true, exports: {
  callNeteaseApi: async (name, params, opts) => {
    apiCalls.push({ name, keywords: params?.keywords, signal: !!opts?.signal });
    if (name === 'song_detail') return { body: { songs: [] } };
    const fn = apiScript.length ? apiScript.shift() : [];
    if (fn instanceof Error) throw fn;
    if (typeof fn === 'function') return fn();
    return { body: { result: { songs: fn } } };
  },
} };
require.cache[aiPath] = { id: aiPath, filename: aiPath, loaded: true, exports: {
  aiEnabled: () => aiOn,
  askAiJson: async () => { aiCalls.push(1); return aiScript.length ? aiScript.shift() : null; },
  aiModel: () => 'stub',
} };
const { matchNeteaseSong, expandSearchQueries } = require('../src/server/services/netease-match.js');
// 共享层真身（ESM）——isPlaceholderAuthor/titleVariantsOf 直接钉单元行为
const {
  isPlaceholderAuthor, titleVariantsOf,
} = await import('../src/shared/title-variants.js');
// lyric-external 侧再导出钉：同一函数对象，不是第二份实现
const lyricExt = require('../src/server/services/lyric-external.js');

const song = (id, name, dtMs = 200000, ar = '某人') => ({ id, name, dt: dtMs, ar: [{ name: ar }], al: { name: 'al' } });
const reset = () => { aiOn = true; aiScript = []; apiScript = []; apiCalls.length = 0; aiCalls.length = 0; };

// ── isPlaceholderAuthor（shared/title-variants.js）──

test('isPlaceholderAuthor：占位形态全收、真实艺名不误伤', () => {
  for (const v of ['_', '__', '--', '。。', 'unknown', 'UNKNOWN', 'Unknown',
    'va', 'VA', 'v.a.', 'various', 'Various Artists', 'VARIOUS  ARTISTS',
    'anonymous', 'Anonymous', '', '   ']) {
    assert.equal(isPlaceholderAuthor(v), true, `应为占位: ${JSON.stringify(v)}`);
  }
  for (const v of ['rei sirose', '笹川真生', 'A', 'up主', '久遠千歳', 'Lemon']) {
    assert.equal(isPlaceholderAuthor(v), false, `不该判占位: ${JSON.stringify(v)}`);
  }
});

test('isPlaceholderAuthor：中日文占位词与纯长音符串（S2 补面）', () => {
  // '群星'/'佚名'/'名無し'/'ななし' 与英文占位同待遇；'ー'/'ｰ' 挂 \p{Lm}
  // 字母籍，纯长音与「长音混标点」串都是无信息占位
  for (const v of ['群星', '佚名', '名無し', 'ななし', 'ー', 'ーー', 'ｰ', 'ー_', '＿ー']) {
    assert.equal(isPlaceholderAuthor(v), true, `应为占位: ${JSON.stringify(v)}`);
  }
  // 长音符作真名词中成分不误判——'サーカス'/'メーヴェ' 的 'ー' 是词干
  for (const v of ['サーカス', 'メーヴェ', 'マキナ', '笹川真生']) {
    assert.equal(isPlaceholderAuthor(v), false, `不该判占位: ${JSON.stringify(v)}`);
  }
});

// ── expandSearchQueries 单元面 ──

test('expandSearchQueries：「_ sasayaku…」实案——剥头+双剥出真名、去重收 3 串', () => {
  // '_ ' 前缀是 extractYtSong 把占位 author 拼进候选串的产物；
  // 'を歌いました ／ rei sirose' 要激进变体双剥才出 'sasayaku'
  const out = expandSearchQueries(
    ['_ sasayakuを歌いました ／ rei sirose', 'sasayakuを歌いました ／ rei sirose'],
    { title: 'sasayakuを歌いました ／ rei sirose', author: '_', artists: ['_'] });
  assert.deepEqual(out, [
    'sasayakuを歌いました ／ rei sirose',   // c1 raw 剥头
    'sasayakuを歌いました',                  // c1 斜杠尾单变体剥头
    'sasayaku',                             // c1 激进变体剥头（真名）
    // c2 三形态全部与上同 key——大小写不敏感去重不收第二遍
  ]);
  assert.ok(!out.some(q => /^[_\-–—~]|\s_/u.test(q)), '不得残留占位前缀形态');
});

test('expandSearchQueries：ver.尾/covered by/【】头 三类噪声各剥出真名', () => {
  const out = expandSearchQueries(
    ['Dream Play Sick ver.EMA', 'ホワイトリリー covered by 雨森小夜', '【栏目】Song Z'],
    { title: 't', author: 'up' });
  assert.ok(out.includes('Dream Play Sick'));    // a. ver.<歌姬> 尾
  assert.ok(out.includes('ホワイトリリー'));        // b. covered by 尾
  assert.ok(out.includes('Song Z'));             // e. 【栏目】头
});

test('expandSearchQueries：交错序（raw 先变体后）、cap 8、normKey 去重', () => {
  const out = expandSearchQueries(
    ['Alpha cover', 'Beta cover', 'Gamma cover', 'Delta cover', 'Epsilon cover'],
    { title: 't', author: 'up' });
  // 每 candidate 产 [raw, 剥cover] 两串；10 串裁到 cap 8——E 整组出列
  assert.equal(out.length, 8);
  assert.deepEqual(out.slice(0, 4), ['Alpha cover', 'Alpha', 'Beta cover', 'Beta']);
  assert.deepEqual(out.slice(6, 8), ['Delta cover', 'Delta']);
  // 大小写/空白归一视为同串——'ALPHA cover' 不再占席
  const d = expandSearchQueries(['Alpha cover', 'ALPHA  cover'], { title: 't', author: 'up' });
  assert.deepEqual(d, ['Alpha cover', 'Alpha']);
});

test('expandSearchQueries：占位叠罗汉行首迭代剥——头词须属本曲占位作者', () => {
  // S3 闸：'unknown' 确为本曲 author → 词形剥头启用；'--' 纯分隔料恒剥
  const out = expandSearchQueries(['unknown -- Lemon', '-- Radio Ga Ga'], { title: 't', author: 'unknown' });
  assert.ok(out.includes('Lemon'));
  assert.ok(out.includes('Radio Ga Ga'));
});

test('expandSearchQueries：词形剥头只认本曲作者——「Unknown Soldier」类真名不剥残', () => {
  // S3：sourceInfo 无占位作者 → placeholderKeys 空 → 词形剥头整体不启用，
  // 'Unknown Soldier'/'Various Positions' 这类恰好以占位词开头的真名原样保留
  assert.deepEqual(
    expandSearchQueries(['Unknown Soldier'], { title: 'Unknown Soldier', author: 'up' }),
    ['Unknown Soldier']);
  const vp = expandSearchQueries(['Various Positions'], { title: 't', author: 'leonard' });
  assert.ok(vp.includes('Various Positions'));
  assert.ok(!vp.includes('Positions'));
  // 纯分隔料头无作者门槛——author='_' 时 '_ sasayaku' 恒剥成 'sasayaku'
  const u = expandSearchQueries(['_ sasayaku'], { title: 't', author: '_' });
  assert.ok(u.includes('sasayaku'));
  // 头词确为本曲占位作者时照剥：author='Various Artists' → 二词组头命中
  // 本曲占位集剥出 'Lemon Tree'（无连字符形态——变体规则 d 不参与，
  // 剥头路独立生效）；对照组 author='leonard' 时同串不剥
  const va = expandSearchQueries(['Various Artists Lemon Tree'], { title: 't', author: 'Various Artists' });
  assert.ok(va.includes('Lemon Tree'));
  const vaKeep = expandSearchQueries(['Various Artists Lemon Tree'], { title: 't', author: 'leonard' });
  assert.ok(!vaKeep.includes('Lemon Tree'));
});

test('expandSearchQueries：artists 里首个非占位艺人作锚（_ 占位不传锚）', () => {
  // 'EMA rumor' 只有拿到 'EMA' 作艺人锚才剥得出 'rumor'——证明 '_'
  // 被跳过、真艺人 'EMA' 是 informativeArtist
  const out = expandSearchQueries(['EMA rumor'], { title: 't', author: '_', artists: ['_', 'EMA'] });
  assert.ok(out.includes('rumor'));
  // 全占位 → artist='' → 艺人锚规则缺席，剥不出 'rumor'
  const none = expandSearchQueries(['EMA rumor'], { title: 't', author: '_', artists: ['_'] });
  assert.ok(!none.includes('rumor'));
  assert.deepEqual(none, ['EMA rumor']);
});

test('expandSearchQueries：防御——非数组/全剥空不产出垃圾查询', () => {
  assert.deepEqual(expandSearchQueries(null, null), []);
  assert.deepEqual(expandSearchQueries(['_', '--'], { title: 't', author: '_' }), []);
});

// ── 端到端（云搜桩）──

test('端到端：「_ sasayakuを歌いました ／ rei sirose」展开命中 1316563227', async () => {
  reset();
  aiOn = false;
  // 实案回放：前两串带噪形态上游空回，剥到真名 'sasayaku' 才回正主
  // （1316563227 sasayaku 笹川真生 222s——与源 222s 时长零差）
  apiScript = [[], [], [song(1316563227, 'sasayaku', 222000, '笹川真生')]];
  const r = await matchNeteaseSong(
    ['_ sasayakuを歌いました ／ rei sirose', 'sasayakuを歌いました ／ rei sirose'],
    222, 't', null,
    { title: 'sasayakuを歌いました ／ rei sirose', author: '_', artists: ['_'] });
  assert.deepEqual(apiCalls.map(c => c.keywords), [
    'sasayakuを歌いました ／ rei sirose', 'sasayakuを歌いました', 'sasayaku']);
  assert.equal(r.song.id, 1316563227);
  assert.equal(r.query, 'sasayaku');          // matchedBy 记真名串
  assert.equal(aiCalls.length, 0);            // 85 分确定性收——AI 不动
});

test('端到端：「ver.EMA」尾缀 raw 灭、剥缀变体命中（灰区宽松收）', async () => {
  reset();
  aiOn = false;
  apiScript = [[], [song(11, 'Dream Play Sick', 234000, 'EMA')]];
  const r = await matchNeteaseSong(['Dream Play Sick ver.EMA'], 234, 't', null,
    { title: 'Dream Play Sick ver.EMA', author: 'somechannel' });
  assert.equal(r.song.id, 11);
  assert.equal(r.query, 'Dream Play Sick');
  assert.deepEqual(apiCalls.map(c => c.keywords), ['Dream Play Sick ver.EMA', 'Dream Play Sick']);
});

test('端到端：占位 author 不进 informativeArtist——真艺人仍在 artists 槽供锚剥', async () => {
  reset();
  aiOn = false;
  // sourceInfo.artists=['_','Eve']：'_' 占位跳过后 'Eve' 作锚——
  // 'Eve rum' 剥锚得 'rum' 命中（若 '_' 占锚位该变体产不出）
  apiScript = [[], [song(21, 'rum', 200000, 'Eve')]];
  const r = await matchNeteaseSong(['Eve rum'], 200, 't', null,
    { title: 'Eve rum', author: '_', artists: ['_', 'Eve'] });
  assert.deepEqual(apiCalls.map(c => c.keywords), ['Eve rum', 'rum']);
  assert.equal(r.song.id, 21);
});

// ── S1：变体精确命中 × 中立艺人面 → 钳灰区顶 ──
// 剥缀变体（'sasayaku'）与同名异曲 title 精确命中拿 50 分，恰绕过打分器
// 中立艺人压分（只在 title<50 生效）——50+15+时长≈85 确定性收、跳过
// AI 复核、正行无 TTL 固化。钳制把这条确定性错配通道降回既有灰区流：
// AI 在→复核过照样收/否决取下一个；AI 不在→宽松收 top。召回不变

test('S1：占位作者+变体命中同名异曲 → 钳灰区顶，AI 复核过才收', async () => {
  reset();
  // '_ sasayaku…' 实案通道修复后回放：剥缀变体 'sasayaku' 精确命中
  // （srcArtists 全占位→中立 15）——修复前 50+15+20=85 确定性收；
  // 修复后钳到 74 走灰区，复核 verdict 放行才收
  apiScript = [[], [], [song(1316563227, 'sasayaku', 222000, '笹川真生')]];
  aiScript = [{ match: true }];
  const r = await matchNeteaseSong(
    ['_ sasayakuを歌いました ／ rei sirose'],
    222, 't', null,
    { title: 'sasayakuを歌いました ／ rei sirose', author: '_', artists: ['_'] });
  assert.equal(r.song.id, 1316563227);   // 复核过照样收——召回不变
  assert.equal(r.score, 74);             // 钳到灰区顶（ACCEPT-1）而非 85
  assert.equal(aiCalls.length, 1);       // AI 复核确实发起——确定性通道关闭
});

test('S1：变体命中被钳后 AI 否决 → veto 不误收', async () => {
  reset();
  // 同名异曲：复核否决记 veto——钳制把「确定性固化错配」降级成可复核判定
  apiScript = [[], [song(99, 'sasayaku', 222000, '别人')]];
  aiScript = [{ match: false }, { queries: [] }];
  const r = await matchNeteaseSong(['sasayakuを歌いました'], 222, 't', null,
    { title: 'sasayakuを歌いました', author: '_' });
  assert.equal(r.song, null);
  assert.equal(aiCalls.length, 2);       // confirm + extract；兜底池被 veto 清空
});

test('S1：无 AI 时变体命中仍灰区宽松收 top——召回不变', async () => {
  reset();
  aiOn = false;
  apiScript = [[], [song(6, 'sasayaku', 222000, '别人')]];
  const r = await matchNeteaseSong(['sasayakuを歌いました'], 222, 't', null,
    { title: 'sasayakuを歌いました', author: '_' });
  assert.equal(r.song.id, 6);
  assert.equal(r.score, 74);
  assert.equal(aiCalls.length, 0);
});

test('S1：作者有料时变体命中不受影响——确定性照收不打 AI', async () => {
  reset();
  // srcArtists 非空 → 中立压分面本就不存在，钳制不参与：50+30+20=100
  apiScript = [[], [song(7, 'sasayaku', 222000, '笹川真生')]];
  const r = await matchNeteaseSong(['sasayakuを歌いました'], 222, 't', null,
    { title: 'sasayakuを歌いました', author: '笹川真生', artists: ['笹川真生'] });
  assert.equal(r.song.id, 7);
  assert.equal(r.score, 100);
  assert.equal(aiCalls.length, 0);
});

test('S1：原始串（非变体）作证的精确命中不钳', async () => {
  reset();
  // 候选串本身就是干净歌名——'sasayaku' ∈ 原始串/源标题集，非变体产物
  apiScript = [[song(5, 'sasayaku', 222000, '别人')]];
  const r = await matchNeteaseSong(['sasayaku'], 222, 't', null,
    { title: 'sasayaku', author: '_' });
  assert.equal(r.song.id, 5);
  assert.equal(r.score, 85);             // 50+15+20 确定性收
  assert.equal(aiCalls.length, 0);
});

// ── 模块接线钉 ──

test('lyric-external 再导出与 shared 同函数对象——唯一真相源无第二份', () => {
  assert.equal(lyricExt.titleVariantsOf, titleVariantsOf);
});

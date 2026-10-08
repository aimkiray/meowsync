// netease-score.js 打分器单元钉测——纯函数零 IO，直接 require 真身。
// 钉 CJK 繁→简折叠面：normToken 归一（比较面多对一）、scoreCandidate
// 繁简变体配对进灰区（实案：yt_ 翻唱源「懐中道標 ver.EMA」332s 应绑网易
// 同作品原唱 id=668118「懐中道标/やなぎなぎ」338s——折叠前 title=0 总分
// 封顶灰区下、逐项复核根本轮不到它），以及反向钉——标题完全不同的
// 繁简混合串仍 title=0，折叠不是宽松化
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const {
  scoreCandidate, normToken, foldCjkCompat, ACCEPT_SCORE, GRAY_SCORE,
} = require('../src/server/services/netease-score.js');

test('normToken：繁体/日文新字体异体折叠归一到同一比较键', () => {
  assert.equal(normToken('懐中道標'), normToken('懐中道标'));   // 实案配对
  assert.equal(normToken('紅蓮華'), normToken('红莲华'));
  assert.equal(normToken('竜と虎'), normToken('龍と虎'));
  assert.equal(normToken('千本桜'), normToken('千本樱'));
  assert.equal(normToken('悪ノ娘'), normToken('恶ノ娘'));
  // 繁体正字补表钉：日文新字体已有键对应的繁体同归一比较键
  assert.equal(normToken('小說家'), normToken('小说家'));   // 說→说
  assert.equal(normToken('聽雨'), normToken('听雨'));       // 聽→听
  assert.equal(normToken('團子大家族'), normToken('团子大家族')); // 團→团
  // 回归钉：既有小写/剥标点语义不变
  assert.equal(normToken(' Lemon '), normToken('lemon'));
  assert.equal(normToken('A - B'), normToken('ab'));
  assert.equal(normToken('前前前世'), '前前前世');      // 表外字原样保留
  assert.equal(normToken('懐中道標'), '怀中道标');      // 折叠键钉死字面值
});

test('foldCjkCompat：逐字映射——表外字符原样、多对一归并同归一键', () => {
  assert.equal(foldCjkCompat('懐中道標 ver.EMA'), '怀中道标 ver.EMA');
  assert.equal(foldCjkCompat(''), '');
  assert.equal(foldCjkCompat(null), '');
  assert.equal(foldCjkCompat('ABC123'), 'ABC123');     // 非 CJK 不碰
  // 多对一钉：'後' 与 '后' 同归 '后'——'後來' 折叠后与字面 '后来' 同键；
  // '皇后' 不含可折字（'后' 本身就是汇）原样过——两条词比较键仍不同
  assert.equal(foldCjkCompat('後來'), '后来');
  assert.equal(foldCjkCompat('皇后'), '皇后');
});

test('scoreCandidate：繁简异体标题配对——「懐中道標」源 × 网易「懐中道标」落灰区', () => {
  // 折叠前 title=0 → title<15 封顶 GRAY-1（实测总分 10）；折叠后
  // title 精确 50 + 艺人零交集 0 + |338-332|=6s 时长 10 = 60 灰区走复核
  const r = scoreCandidate(
    { id: 668118, name: '懐中道标', ar: [{ name: 'やなぎなぎ' }], dt: 338000 },
    { titles: ['懐中道標'], artists: ['EMA'], durationSec: 332 });
  assert.equal(r.feats.title, 50);
  assert.equal(r.reject, false);
  assert.equal(r.score, 60);
  assert.ok(r.score >= GRAY_SCORE && r.score < ACCEPT_SCORE,
    `应落灰区（${GRAY_SCORE}-${ACCEPT_SCORE - 1}）而非被 title<15 封顶丢弃: ${r.score}`);
});

test('scoreCandidate 反向钉：标题完全不同的繁简混合串仍 title=0', () => {
  // 折叠是多对一归一不是宽松化——全串无公共比较面的条目不沾边
  const r = scoreCandidate(
    { id: 1, name: '深海少女の唄', ar: [{ name: '初音ミク' }], dt: 330000 },
    { titles: ['懐中道標'], artists: ['EMA'], durationSec: 332 });
  assert.equal(r.feats.title, 0);
  // title<15 封顶语义不变：时长贴近也救不回灰区
  assert.ok(r.score < GRAY_SCORE);
});

// CJK_FOLD 不外泄——表规模按源文本钉（与 netease-match.test.mjs 末尾的
// fs 钉同法）：繁体正字补齐后条数不得萎缩回补表前水位
const scoreSrc = readFileSync(
  new URL('../src/server/services/netease-score.js', import.meta.url), 'utf8');
const foldBlock = scoreSrc.match(
  /const CJK_FOLD = new Map\(Object\.entries\(\{([\s\S]*?)\}\)\)/)?.[1] || '';
const foldPairs = foldBlock.match(/\p{sc=Han}:/gu) || [];

test('CJK_FOLD 补表规模钉：繁体正字补齐后 ≥240 条（防回退萎缩）', () => {
  assert.ok(foldPairs.length >= 240,
    `CJK_FOLD 只数到 ${foldPairs.length} 条——补表疑似被回退`);
});

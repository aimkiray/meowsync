// src/shared/text-norm.js 钉板：CJK 繁→简兼容折叠 + token 归一——
// 打分比对/标题闸/变体键全链共用同一比较面。钉死「异体字同键」与
// 「分隔符整组剥除」两条核心语义（比较面近似，最终判定归下游核验）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { foldCjkCompat, normToken } from '../src/shared/text-norm.js';
import { normKey } from '../src/shared/title-variants.js';

const require = createRequire(import.meta.url);
const { artistHit, normName } = require('../src/server/services/lyric-external.js');

test('normToken/normKey：日文新字体与简体正字同键——懐中道標 ≡ 懐中道标', () => {
  assert.equal(normToken('懐中道標'), normToken('懐中道标'));
  assert.equal(normKey('懐中道標 ver.EMA'), normKey('懐中道标 ver.EMA'));
  // 剥除集含全/半角波浪号；全角 ／： 不在剥除集——那是 normName 的
  // 分隔符域（NAME_SEP_CH），token 归一各管一段
  assert.equal(normToken('测试～曲'), normToken('测试~曲'));
});

test('normName：全角斜杠/「」等分隔符整组剥除——A／B 与 A 艺人面命中', () => {
  // 「A／B」（多艺人全角斜杠拼接）vs 'A'——旧口径只剥半角分隔会把
  // 两轴艺人拼成整串撞不进子串
  assert.equal(artistHit('A／B', 'A'), true);
  assert.equal(artistHit('「初音ミク」', '初音ミク'), true);
  // 异体字折叠进艺人面：懐 vs 怀
  assert.equal(artistHit('懐中道標', '怀中道标'), true);
  // 撞名不误收：子串全不交集仍拒
  assert.equal(artistHit('米津玄師', '初音ミク'), false);
  // 调用方没给艺人——不卡
  assert.equal(artistHit('', '任何人'), true);
});

test('foldCjkCompat/normToken：表外字原样；空白与括弧标点剥除、点保留', () => {
  assert.equal(foldCjkCompat('Hello世界'), 'Hello世界'); // 界不在表内原样
  assert.equal(foldCjkCompat('語言'), '语言');
  // 剥除集：空白、（）()、《》【】、-—–_~～·；点号不在剥除集内
  assert.equal(normToken('Twig (feat. x)'), 'twigfeat.x');
});

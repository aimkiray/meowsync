// lib/format.js 的 parseDurationMs 回归网——编辑弹窗时长输入的解析边界族
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDurationMs, formatDuration } from '../src/lib/format.js';

test('parseDurationMs：空/空白 = 0（自动语义，不走 VIP 误报）', () => {
  assert.equal(parseDurationMs(''), 0);
  assert.equal(parseDurationMs('   '), 0);
  assert.equal(parseDurationMs(null), 0);
  assert.equal(parseDurationMs(undefined), 0);
});

test('parseDurationMs：mm:ss 常规形态', () => {
  assert.equal(parseDurationMs('3:45'), 225000);
  assert.equal(parseDurationMs('0:00'), 0);
  assert.equal(parseDurationMs('12:05'), 725000);
});

test('parseDurationMs：纯秒与小数秒', () => {
  assert.equal(parseDurationMs('90'), 90000);
  assert.equal(parseDurationMs('4:33.5'), 273500);
  assert.equal(parseDurationMs('4:33.05'), 273050);
});

test('parseDurationMs：分钟 5 位上限（长播客/电台流）', () => {
  assert.equal(parseDurationMs('99999:59'), 5999999000);
  assert.ok(Number.isNaN(parseDurationMs('100000:00')));
});

test('parseDurationMs：非法输入回 NaN（调用方 Number.isNaN 判）', () => {
  for (const bad of ['abc', '1:2:3', '12:60', '12:6x', '-3:00', '3:', ':45', '3.5:20']) {
    assert.ok(Number.isNaN(parseDurationMs(bad)), `应拒绝: ${bad}`);
  }
});

test('formatDuration：0/非法值显示 0:00', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(NaN), '0:00');
  assert.equal(formatDuration(225000), '3:45');
});

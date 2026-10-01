// server/lib/token-eq.js 与 http-error.js 契约回归网
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { tokenMatches } = require('../src/server/lib/token-eq.js');
const { httpError } = require('../src/server/lib/http-error.js');

test('tokenMatches：等值命中、异值拒绝、缺省拒绝', () => {
  assert.ok(tokenMatches('abc123', 'abc123'));
  assert.ok(!tokenMatches('abc123', 'abc124'));
  assert.ok(!tokenMatches('', 'abc'));
  assert.ok(!tokenMatches('abc', ''));
  assert.ok(!tokenMatches(null, 'abc'));
  assert.ok(!tokenMatches(undefined, 'abc'));
  // 空对空永不命中——expected 未配置时提供者也缺省不得放行
  assert.ok(!tokenMatches('', ''));
  assert.ok(!tokenMatches(undefined, undefined));
  // 不同长度不得短路相等（时序攻击面：长度本身不判等后再比）
  assert.ok(!tokenMatches('a', 'abc'));
});

test('httpError：status/exposed 双标——handleError 透传闸就靠它', () => {
  const e = httpError(409, '该歌单正在删除中');
  assert.equal(e.status, 409);
  assert.equal(e.exposed, true);
  assert.equal(e.message, '该歌单正在删除中');
});

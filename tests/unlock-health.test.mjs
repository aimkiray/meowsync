// unlock/health.js 源级熔断状态机钉：连败到阈盖章 TTL、成功清连败不清章、
// 章过期 streak 未消时复败一次即复盖（半开重探仍败 → 再关）。
// 时钟用 Date.now 补丁做窗过期——生产戳只读 Date.now，AbortSignal 不受影响
// （tests/youtube-auth-negative.test.mjs 同款手法）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const health = require('../src/server/services/unlock/health.js');

const S = 'youtube';
// 每用例清两张簿——模块级连败/盖章状态跨用例残留会污染断言
const reset = () => health._resetForTest();

test('首记不到阈不盖章；二记到阈盖章且原因文案为 canonical BRKREASON', () => {
  reset();
  assert.equal(health.isOpen(S), false);
  assert.equal(health.breakerReason(S), null);
  assert.equal(health.noteAuthRejected(S), false, '第 1 记未达阈');
  assert.equal(health.isOpen(S), false);
  assert.equal(health.noteAuthRejected(S), true, '第 2 记达阈触发盖章');
  assert.equal(health.isOpen(S), true);
  assert.equal(health.breakerReason(S), '凭据被拒连败（疑似反机器人墙）');
  assert.equal(health.BREAKER_REASON, '凭据被拒连败（疑似反机器人墙）');
  assert.equal(health.BREAKER_TTL_MS, 10 * 60e3);
  assert.equal(health.BREAKER_THRESHOLD, 2);
  // 章内再记不重盖（返回 false——盖章动作一次性，不重发 warn 不续期）
  assert.equal(health.noteAuthRejected(S), false);
  assert.equal(health.isOpen(S), true);
  // 熔断按源分簿：youtube 盖章不波及其余源
  assert.equal(health.isOpen('pyncmd'), false);
});

test('章内 noteSourceOk 不清章（isOpen 仍 true）但连败清零', () => {
  reset();
  health.noteAuthRejected(S);
  health.noteAuthRejected(S);
  assert.equal(health.isOpen(S), true);
  health.noteSourceOk(S);
  assert.equal(health.isOpen(S), true, '已盖章不撤销——窗内仍整源跳过');
  // streaks 已清的旁证：章过期后只记 1 次不达阈——若没清，streak≥2
  // 会让这 1 记直接复盖
  const realNow = Date.now;
  Date.now = () => realNow() + 11 * 60e3;
  try {
    assert.equal(health.isOpen(S), false, '窗过期自然半开');
    assert.equal(health.noteAuthRejected(S), false, 'streak 已清——单记不达阈');
    assert.equal(health.isOpen(S), false);
  } finally { Date.now = realNow; }
});

test('章过期时 streak 未清 → 复败一次即复盖（半开重探仍败再关）', () => {
  reset();
  health.noteAuthRejected(S);
  health.noteAuthRejected(S);
  const realNow = Date.now;
  Date.now = () => realNow() + 11 * 60e3;
  try {
    assert.equal(health.isOpen(S), false, '窗过期章失效');
    assert.equal(health.noteAuthRejected(S), true, 'streak 未清——复败一次即复盖');
    assert.equal(health.isOpen(S), true);
    assert.equal(health.breakerReason(S), health.BREAKER_REASON);
  } finally { Date.now = realNow; }
});

test('未盖章时 noteSourceOk 清零连败——瞬时成功不留账', () => {
  reset();
  health.noteAuthRejected(S);
  health.noteSourceOk(S);
  assert.equal(health.noteAuthRejected(S), false, '连败已清，再记 1 次仍不达阈');
  assert.equal(health.isOpen(S), false);
});

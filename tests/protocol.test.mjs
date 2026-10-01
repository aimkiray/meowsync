// shared/protocol.js WS 遥控契约回归网
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTROL_TYPES, CONTROL_PAYLOAD_GUARDS, MSG_TYPES, REMOTE_LIMITS } from '../src/shared/protocol.js';

test('控制指令白名单七枚', () => {
  assert.deepEqual([...CONTROL_TYPES].sort(),
    ['next', 'pause', 'play', 'play_song', 'prev', 'seek', 'volume']);
});

test('payload 守卫：形状不符的指令被丢', () => {
  assert.ok(CONTROL_PAYLOAD_GUARDS.play(undefined));
  assert.ok(!CONTROL_PAYLOAD_GUARDS.play({}));
  assert.ok(CONTROL_PAYLOAD_GUARDS.seek(1.5));
  assert.ok(!CONTROL_PAYLOAD_GUARDS.seek('1'));   // 字符串 seek 拒收
  assert.ok(!CONTROL_PAYLOAD_GUARDS.seek(NaN));
  assert.ok(CONTROL_PAYLOAD_GUARDS.play_song('qq_0031sbUK1c0Oav'));
  assert.ok(CONTROL_PAYLOAD_GUARDS.play_song(186016));
  assert.ok(!CONTROL_PAYLOAD_GUARDS.play_song('x'.repeat(200))); // 128 上限
  assert.ok(!CONTROL_PAYLOAD_GUARDS.play_song({}));
});

test('线协议常量与限额', () => {
  assert.equal(MSG_TYPES.STATE_UPDATE, 'state_update');
  assert.equal(MSG_TYPES.HOST_ABSENT, 'host_absent');
  assert.equal(REMOTE_LIMITS.MAX_PAYLOAD_BYTES, 65536);
  assert.equal(REMOTE_LIMITS.MAX_CONTROLLERS, 32);
});

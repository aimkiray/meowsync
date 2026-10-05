// shared/contracts.js 写接口 schema 回归网——契约只收形状/量纲，业务规则在路由
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  downloadTaskBody, quickDownloadBody, mirrorBody,
  importPlaylistBody, songMetaBody, aiLyricBody,
  settingsBody, aiTestBody
} from '../src/shared/contracts.js';

test('downloadTaskBody：playlistId 必填、选项量纲硬边界', () => {
  assert.ok(downloadTaskBody.safeParse({ playlistId: 'local_pl_x' }).success);
  assert.ok(downloadTaskBody.safeParse({ playlistId: 123 }).success);
  assert.ok(!downloadTaskBody.safeParse({}).success);
  assert.ok(!downloadTaskBody.safeParse({ playlistId: '' }).success);
  assert.ok(downloadTaskBody.safeParse({ playlistId: 1, bitrate: 320000 }).success);
  assert.ok(!downloadTaskBody.safeParse({ playlistId: 1, bitrate: 100 }).success);
  assert.ok(!downloadTaskBody.safeParse({ playlistId: 1, concurrentLimit: 99 }).success);
  // looseObject：未知键放行不 400（与历史行为一致）
  assert.ok(downloadTaskBody.safeParse({ playlistId: 1, extra: 'x' }).success);
});

test('mirrorBody：localId 必填、tracks 体量封顶', () => {
  assert.ok(mirrorBody.safeParse({ localId: 'local_pl_a', tracks: [] }).success);
  // 5000 是硬上限：上游单页 1000 曲夹×5 的极端体量，防单次 POST 灌爆内存
  assert.ok(mirrorBody.safeParse({ localId: 'local_pl_a', tracks: Array(5000).fill({}) }).success);
  assert.ok(!mirrorBody.safeParse({ localId: 'local_pl_a', tracks: Array(5001).fill({}) }).success);
  assert.ok(mirrorBody.safeParse({ localId: 'local_pl_a' }).success); // tracks 可缺省
  assert.ok(!mirrorBody.safeParse({ localId: 123 }).success);
  assert.ok(!mirrorBody.safeParse({ localId: 'x'.repeat(81) }).success);
  assert.ok(!mirrorBody.safeParse({ localId: 'local_pl_a', tracks: {} }).success);
});

test('songMetaBody：±300000 整数偏移', () => {
  assert.ok(songMetaBody.safeParse({ offsetMs: -80 }).success);
  assert.ok(songMetaBody.safeParse({ offsetMs: 0 }).success);
  assert.ok(!songMetaBody.safeParse({ offsetMs: 300001 }).success);
  assert.ok(!songMetaBody.safeParse({ offsetMs: 'x' }).success);
  assert.ok(!songMetaBody.safeParse({ offsetMs: 1.5 }).success);
});

test('aiLyricBody / importPlaylistBody', () => {
  assert.ok(aiLyricBody.safeParse({ id: 'bv_x' }).success);
  assert.ok(aiLyricBody.safeParse({ id: 186016, sourceTitle: 't' }).success);
  assert.ok(!aiLyricBody.safeParse({}).success);
  assert.ok(importPlaylistBody.safeParse({}).success); // body 可空（query 兜底）
  assert.ok(importPlaylistBody.safeParse({ neteasePlaylistId: '7014347621' }).success);
});

test('authCredentialsBody：用户名白名单字符集 + 密码 8-128 硬边界', async () => {
  const { authCredentialsBody } = await import('../src/shared/contracts.js');
  assert.ok(authCredentialsBody.safeParse({ username: 'alice', password: 'password-one' }).success);
  // 用户名白名单 [\w.@-]：空格/引号/HTML 字符一律拒（日志与 UI 注入面）
  assert.ok(!authCredentialsBody.safeParse({ username: 'a b', password: 'password-one' }).success);
  assert.ok(!authCredentialsBody.safeParse({ username: '<script>', password: 'password-one' }).success);
  assert.ok(!authCredentialsBody.safeParse({ username: "a'b", password: 'password-one' }).success);
  // 边界：8 位收下，7 位拒；128 位收下，129 拒
  assert.ok(authCredentialsBody.safeParse({ username: 'a', password: '12345678' }).success);
  assert.ok(!authCredentialsBody.safeParse({ username: 'a', password: '1234567' }).success);
  assert.ok(authCredentialsBody.safeParse({ username: 'a', password: 'x'.repeat(128) }).success);
  assert.ok(!authCredentialsBody.safeParse({ username: 'a', password: 'x'.repeat(129) }).success);
  // 缺字段/空串
  assert.ok(!authCredentialsBody.safeParse({ username: 'a' }).success);
  assert.ok(!authCredentialsBody.safeParse({ username: '', password: 'password-one' }).success);
});

test('settingsBody：七键全部可选、null=清覆盖语义、类型与量纲硬边界', () => {
  assert.ok(settingsBody.safeParse({}).success); // 全可缺省（「无可写键」在路由层判 400）
  // null 是「清覆盖回落 env」合法值——不是空值校验错
  assert.ok(settingsBody.safeParse({ ai_model: null, bili_cookie: null, yt_cookie: null }).success);
  assert.ok(settingsBody.safeParse({ ai_timeout_ms: 60000 }).success); // int 直收
  assert.ok(settingsBody.safeParse({ ai_timeout_ms: '60000' }).success); // 字符串也收（归一化在 lib）
  // 类型边界：布尔/对象不收
  assert.ok(!settingsBody.safeParse({ ai_base_url: true }).success);
  assert.ok(!settingsBody.safeParse({ ai_api_key: {} }).success);
  assert.ok(!settingsBody.safeParse({ ai_timeout_ms: false }).success);
  // 长度硬上限：cookie 8000、url/key 1000、model 500、timeout 串 20
  assert.ok(!settingsBody.safeParse({ bili_cookie: 'x'.repeat(8001) }).success);
  assert.ok(settingsBody.safeParse({ bili_cookie: 'x'.repeat(8000) }).success);
  assert.ok(!settingsBody.safeParse({ yt_cookie: 'x'.repeat(8001) }).success);
  assert.ok(!settingsBody.safeParse({ ai_base_url: 'x'.repeat(1001) }).success);
  assert.ok(!settingsBody.safeParse({ ai_model: 'x'.repeat(501) }).success);
  assert.ok(!settingsBody.safeParse({ ai_timeout_ms: '1'.repeat(21) }).success);
  // looseObject：未知键放行（路由层白名单再过滤）
  assert.ok(settingsBody.safeParse({ hacker_key: 'x' }).success);
});

test('aiTestBody：三段全可选（留空用生效配置补位）、纯字符串量纲', () => {
  assert.ok(aiTestBody.safeParse({}).success);
  assert.ok(aiTestBody.safeParse({ baseUrl: 'http://x/v1', apiKey: 'sk-1', model: 'm' }).success);
  // 与 settingsBody 不同——草稿三段不收 null（留空=不写字段而非显式 null）
  assert.ok(!aiTestBody.safeParse({ baseUrl: null }).success);
  assert.ok(!aiTestBody.safeParse({ apiKey: 42 }).success);
  assert.ok(!aiTestBody.safeParse({ baseUrl: 'x'.repeat(1001) }).success);
  assert.ok(!aiTestBody.safeParse({ model: 'x'.repeat(501) }).success);
  assert.ok(aiTestBody.safeParse({ whatever: true }).success); // looseObject
});

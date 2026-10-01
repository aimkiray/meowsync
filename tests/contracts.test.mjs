// shared/contracts.js 写接口 schema 回归网——契约只收形状/量纲，业务规则在路由
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  downloadTaskBody, quickDownloadBody, mirrorBody,
  importPlaylistBody, songMetaBody, aiLyricBody
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

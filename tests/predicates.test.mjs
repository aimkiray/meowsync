// shared/predicates.js 回归网——前后端谓词口径漂移历史 bug 的固定网
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SONGMID_RE, isSongmidLike, isNeteasePlaylist, NETEASE_ID_RE,
  BVID_RE, BVID_IN_TEXT_RE, isBilibiliInput,
  SINGLE_SONG_PREFIX, SAVED_QUEUE_PREFIX, MIRROR_PLAYLIST_ID_RE,
  isLocalPlaylistId, isEphemeralPlaylistId, isSingleSongShellId,
  parseNumericId
} from '../src/shared/predicates.js';

test('songmid：QQ songmid 形态', () => {
  assert.ok(SONGMID_RE.test('0031sbUK1c0Oav'));
  assert.ok(isSongmidLike('004Z8Ihr0JIu5s'));
  assert.ok(!isSongmidLike('abc'));         // 太短
  assert.ok(!isSongmidLike('186016'));      // 纯数字是网易云 id
});

test('BV：12 位全形态；11 位是非法', () => {
  assert.ok(BVID_RE.test('BV1GJ411x7h7'));
  assert.ok(!BVID_RE.test('BV1G411x7h7'));  // 11 位——曾把前端测试值写错的形态
  // qq 域/qqmusic scheme/qq: 前缀内的 BV 形 songmid 不得被 B 站抢走
  assert.ok(isBilibiliInput('BV1GJ411x7h7'));
  assert.ok(!isBilibiliInput('https://y.qq.com/n/ryqq/songDetail/BV1GJ411x7h7'));
  assert.ok(!isBilibiliInput('qq:BV1GJ411x7h7'));
});

test('播放列表 id 三族：网易云数字 / local_pl_ / saved_queue_', () => {
  // isNeteasePlaylist 收歌单对象（.id 是纯数字才算网易云远端单）
  assert.ok(isNeteasePlaylist({ id: '7014347621' }));
  assert.ok(isNeteasePlaylist({ id: 12345 }));
  assert.ok(!isNeteasePlaylist({ id: 'local_pl_x' }));
  assert.ok(!isNeteasePlaylist('7014347621')); // 裸 id 传进来是误用
  assert.ok(MIRROR_PLAYLIST_ID_RE.test('local_pl_abc'));
  assert.ok(MIRROR_PLAYLIST_ID_RE.test('saved_queue_xyz'));
  assert.ok(!MIRROR_PLAYLIST_ID_RE.test('7014347621'));
  assert.ok(isLocalPlaylistId('local_pl_abc'));
  assert.ok(isEphemeralPlaylistId('single_song_123'));
  assert.ok(isSingleSongShellId(`${SINGLE_SONG_PREFIX}qq_0031sbUK1c0Oav`));
  assert.ok(!isSingleSongShellId(`${SAVED_QUEUE_PREFIX}x`));
});

test('parseNumericId：只收纯十进制', () => {
  assert.equal(parseNumericId('186016'), 186016);
  assert.equal(parseNumericId('1e5'), null);
  assert.equal(parseNumericId(' 3'), null);
  assert.equal(parseNumericId('12abc'), null);
  assert.equal(parseNumericId(''), null);
});

test('BVID_IN_TEXT_RE：内嵌提取', () => {
  const m = '看 https://www.bilibili.com/video/BV1GJ411x7h7?t=3'.match(BVID_IN_TEXT_RE);
  assert.equal(m?.[0], 'BV1GJ411x7h7');
  assert.ok(NETEASE_ID_RE.test('186016'));
});

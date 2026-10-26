import test from 'node:test'
import assert from 'node:assert/strict'

// url.js 是「httpsCover + 30 个谓词 re-export」桶——song.js 已踩过
// export {x} from 'y' 不绑本地作用域的坑（songSource→isFileTrackId
// ReferenceError 生产崩溃）。import+export 两段式收敛后钉住两条链：
//   1. re-export 面全可调（名在 predicates.js 消失/改名即刻翻）
//   2. httpsCover 本函数在 node 环境原样透传（非 https 页面不升级）
// 只 import 不调用抓不到调用期 ReferenceError——逐个 typeof/call。

import {
  httpsCover,
  SONGMID_RE, isSongmidLike, isNeteasePlaylist,
  BVID_RE, NETEASE_ID_RE, NETEASE_ID_BOUNDED_RE,
  QQ_SONG_ID_RE, BV_TRACK_ID_RE, YT_TRACK_ID_RE, YT_ID_RE,
  SINGLE_SONG_PREFIX, SAVED_QUEUE_PREFIX, LOCAL_PLAYLIST_PREFIX,
  isLocalPlaylistId, isEphemeralPlaylistId, isSingleSongShellId,
  isResolvableTrackId, providerPlaylistShellId, parseProviderShellId,
  parseNumericId, isBilibiliInput, isBiliDirectBindInput, extractBiliFavlistId,
  extractYouTubePlaylistId, extractYouTubeId, isYouTubeInput,
  isQQInput, extractQQPlaylistId, pickQqFromUrl, extractNeteaseSongId,
} from '../src/lib/url.js'

test('url.js re-export 面：30 名全绑真实体（regex/string/function）', () => {
  const regexes = [
    SONGMID_RE, BVID_RE, NETEASE_ID_RE, NETEASE_ID_BOUNDED_RE,
    QQ_SONG_ID_RE, BV_TRACK_ID_RE, YT_TRACK_ID_RE, YT_ID_RE,
  ]
  for (const re of regexes) assert.ok(re instanceof RegExp, `${re} 非正则`)

  const prefixes = [SINGLE_SONG_PREFIX, SAVED_QUEUE_PREFIX, LOCAL_PLAYLIST_PREFIX]
  for (const p of prefixes) assert.equal(typeof p, 'string')

  const fns = [
    isSongmidLike, isNeteasePlaylist, isLocalPlaylistId, isEphemeralPlaylistId,
    isSingleSongShellId, isResolvableTrackId, providerPlaylistShellId,
    parseProviderShellId, parseNumericId, isBilibiliInput, isBiliDirectBindInput,
    extractBiliFavlistId, extractYouTubePlaylistId, extractYouTubeId, isYouTubeInput, isQQInput,
    extractQQPlaylistId, pickQqFromUrl, extractNeteaseSongId,
  ]
  for (const fn of fns) assert.equal(typeof fn, 'function')
})

test('re-export 绑定是真转发：调用链直达 predicates（非本地死名）', () => {
  // 若两段式退化回 export-from 而调用方又只 import 不调用，这类断言缺席；
  // 逐个挑代表名钉「调得到、返回对」
  assert.equal(isLocalPlaylistId('local_pl_1'), true)
  // shell id 形态 local_pl_<source>_<key>，source 词表 yt|bili|qq——roundtrip 钉
  assert.equal(providerPlaylistShellId('bili', '123'), 'local_pl_bili_123')
  assert.deepEqual(parseProviderShellId('local_pl_bili_123'), { source: 'bili', key: '123' })
  assert.equal(parseProviderShellId('local_pl_mix_x'), null) // 非导入壳
  assert.equal(parseNumericId('347230'), 347230)
  assert.equal(extractYouTubeId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ')
  assert.equal(isSingleSongShellId(`${SINGLE_SONG_PREFIX}x`), true)
})

test('httpsCover：node/非 https 环境原样透传，https 页面升级 http 外链', () => {
  // node 无 window → 透传分支（worker/测试语义）
  assert.equal(httpsCover('http://a/b.jpg'), 'http://a/b.jpg')
  assert.equal(httpsCover('https://a/b.jpg'), 'https://a/b.jpg')
  assert.equal(httpsCover(null), '')
  // 有 window 且 https → 升级；http 页面 → 透传（自托管常态不得强拆）
  globalThis.window = { location: { protocol: 'https:' } }
  try {
    assert.equal(httpsCover('http://p1.music.126.net/x.jpg'), 'https://p1.music.126.net/x.jpg')
  } finally {
    globalThis.window = { location: { protocol: 'http:' } }
    try {
      assert.equal(httpsCover('http://p1.music.126.net/x.jpg'), 'http://p1.music.126.net/x.jpg')
    } finally {
      delete globalThis.window
    }
  }
})

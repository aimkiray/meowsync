import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  UPLOADS_PLAYLIST_ID, fileArtifactUrl, isVipSong, isVipUnplayable,
  songArtists, songCoverUrl, visibleSongs, songSource, songSourceName,
  songSourceUrl, externalArtistName, externalCoverUrl, applyTrackOverrides,
  isFileTrackId, isLocalPlaylistId, isEphemeralPlaylistId, isSingleSongShellId
} from '../src/lib/song.js'

// song.js 导出面烟测——本文件曾藏「export {x} from 'y' 不绑本地作用域，
// 函数体裸用 x 即 ReferenceError」的生产崩溃（songSource→isFileTrackId，
// SongList 每行渲染都炸）。导出全调一遍是唯一可靠钉法：只 import 抓不到
// 调用期 ReferenceError。

const NE = { id: '347230', name: '网易云曲' }
const FILE_OBJ = { id: 'file_abc12345', name: '上传曲', file: { hasCover: true, coverV: 3 } }
const FILE_NO_OBJ = { id: 'file_abc12345', name: '旧投影上传曲' } // 无 .file——镜像投影形态
const BV = { id: 'bv_BV1xx411c7mD', name: 'B站曲', bilibili: { bvid: 'BV1xx411c7mD', author: 'UP主', page: 2 } }
const YT = { id: 'yt_dQw4w9WgXcQ', name: 'YT曲', youtube: { videoId: 'dQw4w9WgXcQ', authorClean: 'Rick' } }
const QQ = { id: 'qq_004abc123def', name: 'QQ曲', qq: { mid: '004abc123def' } }

test('songSource：五形态标签 + 无对象 file_ 兜底（崩溃钉——曾 ReferenceError）', () => {
  assert.equal(songSource(NE), null)                  // 无 provider 对象——触达 isFileTrackId 分支
  assert.equal(songSource(FILE_OBJ), '本地上传')       // .file 短路
  assert.equal(songSource(FILE_NO_OBJ), '本地上传')    // id 兜底——镜像投影无 .file 的落点
  assert.equal(songSource(BV), 'B站')
  assert.equal(songSource(YT), 'YouTube')
  assert.equal(songSource(QQ), 'QQ音乐')
  // 口径钉死：bv_/yt_/qq_ 无 provider 对象不出徽标（对象即凭据——与
  // songSourceName 的 id 兜底刻意不同，改语义要先改这里）
  assert.equal(songSource({ id: 'bv_BV1xx411c7mD' }), null)
  assert.equal(songSource({ id: 'yt_dQw4w9WgXcQ' }), null)
  assert.equal(songSource({ id: 'qq_004abc123def' }), null)
})

test('songSourceName：对象优先/id 兜底双通道与网易云归名', () => {
  assert.equal(songSourceName(NE), '网易云')
  assert.equal(songSourceName(FILE_NO_OBJ), '本地上传')
  assert.equal(songSourceName({ id: 'bv_BV1xx411c7mD' }), 'B站')    // id 兜底（与 songSource 的分化点）
  assert.equal(songSourceName({ id: 'yt_dQw4w9WgXcQ' }), 'YouTube')
  assert.equal(songSourceName({ id: 'qq_004abc123def' }), 'QQ音乐')
  assert.equal(songSourceName(BV), 'B站')
  assert.equal(songSourceName({ id: 'x_garbage' }), null)
})

test('songSourceUrl：回源链接各源形态（分P/videoId/mid/数字）', () => {
  assert.equal(songSourceUrl(BV), 'https://www.bilibili.com/video/BV1xx411c7mD?p=2')
  assert.equal(songSourceUrl({ id: 'bv_BV1xx411c7mD' }), 'https://www.bilibili.com/video/BV1xx411c7mD')
  assert.equal(songSourceUrl(YT), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')
  assert.equal(songSourceUrl(QQ), 'https://y.qq.com/n/ryqq/songDetail/004abc123def')
  assert.equal(songSourceUrl(NE), 'https://music.163.com/song?id=347230')
  assert.equal(songSourceUrl(FILE_NO_OBJ), null)
  assert.equal(songSourceUrl(null), null)
})

test('fileArtifactUrl + songCoverUrl：file 工件 URL 与封面兜底链', () => {
  // node 环境 resolveApiBaseUrl 回落 ''——断言相对 URL 形态而非主机
  const u = fileArtifactUrl('file_x', 'cover', 7)
  assert.ok(u.endsWith('/downloads/songs/file_x/file?playlistId=local_uploads&kind=cover&v=7'))
  assert.equal(UPLOADS_PLAYLIST_ID, 'local_uploads')
  assert.equal(songCoverUrl(FILE_OBJ), fileArtifactUrl('file_abc12345', 'cover', 3))
  assert.equal(songCoverUrl({ id: 'x', picUrl: 'http://a/1.jpg' }), 'http://a/1.jpg')
  assert.equal(songCoverUrl({ id: 'x', al: { picUrl: 'http://a/2.jpg' } }), 'http://a/2.jpg')
  assert.equal(songCoverUrl({ id: 'x' }), '')
})

test('isVipSong/isVipUnplayable/visibleSongs：VIP 凭据感知过滤', () => {
  assert.equal(isVipSong({ fee: 1 }), true)
  assert.equal(isVipSong({ qq: { payPlay: true } }), true)
  assert.ok(!isVipSong(NE)) // 非 VIP 归 falsy（短路尾操作数 undefined——真值契约）
  // qq payPlay + 服务端已登 → 可播不隐藏；无凭据 → 不可播
  const qqVip = { id: 'qq_x', qq: { payPlay: true } }
  assert.equal(isVipUnplayable(qqVip, { qq: { loggedIn: true } }), false)
  assert.equal(isVipUnplayable(qqVip, {}), true)
  const list = [NE, qqVip, { id: 'v1', fee: 1 }]
  assert.deepEqual(visibleSongs(list, true, {}).map(s => s.id), ['347230', 'qq_x', 'v1'])
  assert.deepEqual(visibleSongs(list, false, {}).map(s => s.id), ['347230'])
})

test('songArtists/externalArtistName/externalCoverUrl：展示口径', () => {
  assert.equal(songArtists({ ar: [{ name: 'a' }, { name: 'b' }] }), 'a, b')
  assert.equal(songArtists({ artists: [{ name: 'c' }] }), 'c')
  assert.equal(songArtists({}), '未知艺术家')
  assert.equal(externalArtistName(YT), 'Rick')
  assert.equal(externalArtistName({ youtube: { author: 'X - Topic' } }), 'X')
  assert.equal(externalArtistName(BV), 'UP主')
  assert.equal(externalArtistName(NE), null)
  assert.equal(externalCoverUrl(YT), 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg')
  assert.equal(externalCoverUrl({ bilibili: { cover: 'https://x/c.jpg' } }), 'https://x/c.jpg')
  assert.equal(externalCoverUrl(NE), null)
})

test('applyTrackOverrides：覆盖字段全通路与空值显式语义', () => {
  const s = { id: '1', name: 'old', al: { name: 'a', picUrl: 'p' } }
  const out = applyTrackOverrides(s, { '1': { name: 'new', artist: 'B', album: 'c', durationMs: 0, coverUrl: 'cv' } })
  assert.equal(out.name, 'new')
  assert.equal(out.ar[0].name, 'B')
  assert.equal(out.al.name, 'c')
  assert.equal(out.al.picUrl, 'p')   // al 只换名不伤 picUrl
  assert.equal(out.dt, 0)            // 0=显式清空也要覆盖（!= null 口径）
  assert.equal(out.picUrl, 'cv')
  assert.equal(applyTrackOverrides(s, {}), s)   // 无覆盖原样返回（同引用）
  assert.equal(applyTrackOverrides(s, null), s)
})

test('re-export 面：四个谓词经 song.js 透出即真绑定（不是死转发）', () => {
  // 本用例钉住「re-export 的函数可被本文件与下游调用」——导出名单与
  // predicates 同源，漂移一处即翻
  assert.equal(isFileTrackId('file_abc12345'), true)
  assert.equal(isFileTrackId('347230'), false)
  assert.equal(isLocalPlaylistId('local_pl_x'), true)
  assert.equal(isEphemeralPlaylistId('single_song_x'), true)
  assert.equal(isSingleSongShellId('single_song_x'), true)
  assert.equal(isSingleSongShellId('local_pl_x'), false)
})

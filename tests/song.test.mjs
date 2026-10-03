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
const FILE_NO_OBJ = { id: 'file_abc12345', name: '旧投影上传曲' } // 无 .file——旧持久化形态（镜像服务端拒收 file_ id，不是投影来源）
const BV = { id: 'bv_BV1xx411c7mD_p2', name: 'B站曲', bilibili: { bvid: 'BV1xx411c7mD', author: 'UP主', page: 2 } }
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
  // id 内嵌分P（bv_..._pN 的 pN 段）与对象 page 双通道；page=1 不挂 ?p
  assert.equal(songSourceUrl({ id: 'bv_BV1xx411c7mD_p3' }), 'https://www.bilibili.com/video/BV1xx411c7mD?p=3')
  assert.equal(songSourceUrl({ bilibili: { bvid: 'BV1xx411c7mD', page: 1 } }), 'https://www.bilibili.com/video/BV1xx411c7mD')
  assert.equal(songSourceUrl({ id: 'bv_BV1xx411c7mD' }), 'https://www.bilibili.com/video/BV1xx411c7mD')
  assert.equal(songSourceUrl(YT), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')
  assert.equal(songSourceUrl({ id: 'yt_dQw4w9WgXcQ' }), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ') // id 兜底
  assert.equal(songSourceUrl(QQ), 'https://y.qq.com/n/ryqq/songDetail/004abc123def')
  assert.equal(songSourceUrl({ id: 'qq_004abc123def' }), 'https://y.qq.com/n/ryqq/songDetail/004abc123def') // id 兜底
  assert.equal(songSourceUrl(NE), 'https://music.163.com/song?id=347230')
  // 数字型 id 归一化契约——生产网易云 id 是 number，掉 String() 会 404
  assert.equal(songSourceUrl({ id: 347230 }), 'https://music.163.com/song?id=347230')
  assert.equal(songSourceUrl(FILE_NO_OBJ), null)
  assert.equal(songSourceUrl(null), null)
  assert.equal(songSourceUrl(undefined), null)
})

test('fileArtifactUrl + songCoverUrl：file 工件 URL 与封面兜底链', () => {
  // node 环境 resolveApiBaseUrl 回落 ''——断言相对 URL 形态而非主机
  const u = fileArtifactUrl('file_x', 'cover', 7)
  assert.ok(u.endsWith('/downloads/songs/file_x/file?playlistId=local_uploads&kind=cover&v=7'))
  // kind/v 缺省分支是生产热路：usePlayer 播放 URL 与 lyrics 拉取都走省略形，
  // 若漏出 'kind=undefined' 字样每个 file_ 曲播放都会断
  assert.ok(fileArtifactUrl('file_x').endsWith('/downloads/songs/file_x/file?playlistId=local_uploads'))
  assert.ok(fileArtifactUrl('file_x', 'lyrics').endsWith('file?playlistId=local_uploads&kind=lyrics'))
  assert.equal(UPLOADS_PLAYLIST_ID, 'local_uploads')
  assert.equal(songCoverUrl(FILE_OBJ), fileArtifactUrl('file_abc12345', 'cover', 3))
  // 兜底优先级 file > picUrl > al > album
  assert.equal(songCoverUrl({ id: 'x', picUrl: 'http://a/1.jpg' }), 'http://a/1.jpg')
  assert.equal(songCoverUrl({ id: 'x', al: { picUrl: 'http://a/2.jpg' } }), 'http://a/2.jpg')
  assert.equal(songCoverUrl({ id: 'x', album: { picUrl: 'http://a/3.jpg' } }), 'http://a/3.jpg')
  const fileCover = songCoverUrl({ id: 'x', file: { hasCover: true }, picUrl: 'http://a/1.jpg' })
  assert.equal(fileCover, fileArtifactUrl('x', 'cover', undefined))
  assert.ok(fileCover.endsWith('kind=cover'))   // 字面锚点：v 省略时不得漏 'v=undefined'
  assert.ok(!fileCover.includes('v='))
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
  // 网易云 fee=1 无用户凭据通道——qq 已登也救不回，恒不可播（song?.qq 闸
  // 若被放宽成 caps-only，网易云 VIP 会全被放出来）
  assert.equal(isVipUnplayable({ id: 'v1', fee: 1 }, { qq: { loggedIn: true } }), true)
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
  // artist:'' 经 `|| '未知艺术家'` 兜底——与其他字段的显式清空语义不同，
  // 钉住现行为；al 非对象（旧字符串形态）的 typeof 闸不产裸 spread
  const cleared = applyTrackOverrides(s, { '1': { artist: '' } })
  assert.equal(cleared.ar[0].name, '未知艺术家')
  const strAl = applyTrackOverrides({ id: '2', name: 'n', al: '老专辑' }, { '2': { album: 'b' } })
  assert.equal(strAl.al.name, 'b')
  assert.equal(strAl.al.picUrl, undefined)
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

test('node 环境契约：resolveApiBaseUrl 回落空串，裸值调用不炸', async () => {
  // api-base 的 window 闸是 song.js 可测性的底座——显式钉住返回值而非
  // 只经 fileArtifactUrl 的 endsWith 传递性兜底
  const { resolveApiBaseUrl } = await import('../src/lib/api-base.js')
  assert.equal(resolveApiBaseUrl(), '')
  assert.equal(songSource(null), null)        // 裸值经 ?. 链安全
  assert.equal(songSource(undefined), null)
})

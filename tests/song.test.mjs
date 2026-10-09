import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  UPLOADS_PLAYLIST_ID, fileArtifactUrl, isVipSong, isVipUnplayable,
  songArtists, songCoverUrl, coverSizeUrl, songThumbUrl, visibleSongs,
  songSource, songSourceName,
  songSourceUrl, externalArtistName, externalCoverUrl, applyTrackOverrides,
  isFileTrackId, isLocalPlaylistId, isEphemeralPlaylistId, isSingleSongShellId,
  proxiedCoverUrl, slimTrack
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

test('coverSizeUrl：四 provider 缩放语法 + 幂等 + 放行面', () => {
  // 白名单图床域的产出恒为 /img-proxy 包装形（node 无 DOM → apiBase='' 相对形），
  // 且 url= 解码后必须是已完成缩放改写的产物——先改写后包装是契约
  const proxied = (u) => `/img-proxy?url=${encodeURIComponent(u)}`
  // 网易云 ?param={w}y{h}
  assert.equal(coverSizeUrl('http://p1.music.126.net/a/b.jpg', 96),
    proxied('http://p1.music.126.net/a/b.jpg?param=96y96'))
  assert.equal(coverSizeUrl('https://p2.music.126.net/a/b.jpg?x=1', 96),
    proxied('https://p2.music.126.net/a/b.jpg?x=1&param=96y96'))
  // 已带 param 改写值而非追加（first-wins 未定义语义兜底）
  assert.equal(coverSizeUrl('https://p1.music.126.net/a/b.jpg?param=200y200', 96),
    proxied('https://p1.music.126.net/a/b.jpg?param=96y96'))
  // 协议相对按 https 升格解析后命中白名单；大写域经 URL 归一小写进 url=
  assert.equal(coverSizeUrl('//p1.MUSIC.126.NET/x.jpg', 80),
    proxied('https://p1.music.126.net/x.jpg?param=80y80'))
  // B站 @ 后缀挂 path（query 之前）；CDN 缩放幂等（已缩放形不改写再包装）
  assert.equal(coverSizeUrl('https://i0.hdslb.com/bfs/archive/x.jpg', 96),
    proxied('https://i0.hdslb.com/bfs/archive/x.jpg@96w_96h_1c.jpg'))
  assert.equal(coverSizeUrl('https://i0.hdslb.com/bfs/archive/x.jpg?f=1', 96),
    proxied('https://i0.hdslb.com/bfs/archive/x.jpg@96w_96h_1c.jpg?f=1'))
  assert.equal(coverSizeUrl('https://i0.hdslb.com/bfs/archive/x.jpg@300w_300h_1c.jpg', 96),
    proxied('https://i0.hdslb.com/bfs/archive/x.jpg@300w_300h_1c.jpg'))
  // YouTube 档位名归一到 mq；mq/default 幂等——降档发生在包装前
  assert.equal(coverSizeUrl('https://i.ytimg.com/vi/a/hqdefault.jpg', 96),
    proxied('https://i.ytimg.com/vi/a/mqdefault.jpg'))
  assert.equal(coverSizeUrl('https://i.ytimg.com/vi/a/maxresdefault.jpg', 96),
    proxied('https://i.ytimg.com/vi/a/mqdefault.jpg'))
  assert.equal(coverSizeUrl('https://i.ytimg.com/vi/a/mqdefault.jpg', 96),
    proxied('https://i.ytimg.com/vi/a/mqdefault.jpg'))
  // QQ T002R 段 px 随行；T001R 不改写但仍在白名单——照样进代理
  assert.equal(coverSizeUrl('https://y.gtimg.cn/music/photo_new/T002R300x300M000x.jpg', 240),
    proxied('https://y.gtimg.cn/music/photo_new/T002R240x240M000x.jpg'))
  assert.equal(coverSizeUrl('https://y.gtimg.cn/music/photo_new/T001R300x300M000x.jpg', 96),
    proxied('https://y.gtimg.cn/music/photo_new/T001R300x300M000x.jpg'))
  // p.qpic.cn 无公开缩放通道不改写，但 qpic.cn 在白名单 → 代理形
  assert.equal(coverSizeUrl('https://p.qpic.cn/music_cover/x/150.jpg', 96),
    proxied('https://p.qpic.cn/music_cover/x/150.jpg'))
  // 透传/fail-closed 面：file_ 端点（相对形）/ data: / blob: / 空值原样透传；
  // 非白名单域归 ''——零被动外联不变式下不再留浏览器直连口径
  const fileCov = fileArtifactUrl('file_abc12345', 'cover', 7)
  assert.equal(coverSizeUrl(fileCov, 96), fileCov)
  assert.equal(coverSizeUrl('data:image/png;base64,AAA', 96), 'data:image/png;base64,AAA')
  assert.equal(coverSizeUrl('blob:https://x/abc', 96), 'blob:https://x/abc')
  assert.equal(coverSizeUrl('https://example.com/x.jpg', 96), '')
  assert.equal(coverSizeUrl('', 96), '')
  assert.equal(coverSizeUrl(null, 96), '')
  assert.equal(coverSizeUrl(undefined, 96), '')
})

test('proxiedCoverUrl：白名单包装/直通矩阵 + 幂等防腐化', () => {
  const proxied = (u) => `/img-proxy?url=${encodeURIComponent(u)}`
  // 白名单域全包：ytimg/hdslb/126/gtimg/qpic/ggpht/kuwo；http 明文也包
  //（服务端允许 http 回源——HTTP 部署下明文回链是合法面）
  assert.equal(proxiedCoverUrl('https://i.ytimg.com/vi/x/hqdefault.jpg'),
    proxied('https://i.ytimg.com/vi/x/hqdefault.jpg'))
  assert.equal(proxiedCoverUrl('http://i0.hdslb.com/x.jpg'), proxied('http://i0.hdslb.com/x.jpg'))
  assert.equal(proxiedCoverUrl('https://p1.music.126.net/a.jpg'), proxied('https://p1.music.126.net/a.jpg'))
  assert.equal(proxiedCoverUrl('https://y.gtimg.cn/m/T002R300x300M000x.jpg'),
    proxied('https://y.gtimg.cn/m/T002R300x300M000x.jpg'))
  assert.equal(proxiedCoverUrl('https://p.qpic.cn/x/150.jpg'), proxied('https://p.qpic.cn/x/150.jpg'))
  assert.equal(proxiedCoverUrl('https://yt3.ggpht.com/a.jpg'), proxied('https://yt3.ggpht.com/a.jpg'))
  assert.equal(proxiedCoverUrl('https://a.kuwo.cn/x.jpg'), proxied('https://a.kuwo.cn/x.jpg'))
  // 协议相对按 https 升格后再判白名单与包装（url= 内是规范绝对形）
  assert.equal(proxiedCoverUrl('//p1.music.126.net/x.jpg'), proxied('https://p1.music.126.net/x.jpg'))
  // 蹭名/尾挂/FQDN 尾点不命中白名单（与服务端剥尾点后回源同向收敛）——
  // fail-closed 后全归 ''：不放浏览器直连源站
  assert.equal(proxiedCoverUrl('https://xytimg.com/x.jpg'), '')
  assert.equal(proxiedCoverUrl('https://ytimg.com.evil.com/x.jpg'), '')
  assert.equal(proxiedCoverUrl('https://i.ytimg.com./x'), '')
  // fail-closed 收口：非白名单域（含协议相对升格后判出的）一律 ''；
  // 非标端口/userinfo 同归 ''（服务端必拒 + 凭据不外联）
  assert.equal(proxiedCoverUrl('https://example.com/x.jpg'), '')
  assert.equal(proxiedCoverUrl('https://foo.googleusercontent.com/x'), '')
  assert.equal(proxiedCoverUrl('//example.com/x.jpg'), '')
  assert.equal(proxiedCoverUrl('https://example.com:8443/x.jpg'), '')
  assert.equal(proxiedCoverUrl('https://u:p@example.com/x.jpg'), '')
  // 透传面只剩必同源/不外联形：非 http(s) / 同源相对 / file_ 工件 / 空与裸相对串
  assert.equal(proxiedCoverUrl('data:image/png;base64,AAA'), 'data:image/png;base64,AAA')
  assert.equal(proxiedCoverUrl('blob:https://x/abc'), 'blob:https://x/abc')
  assert.equal(proxiedCoverUrl('/downloads/songs/f/file?playlistId=local_uploads'),
    '/downloads/songs/f/file?playlistId=local_uploads')
  const fileCov = fileArtifactUrl('file_x', 'cover')
  assert.equal(proxiedCoverUrl(fileCov), fileCov)
  assert.equal(proxiedCoverUrl('https://i.ytimg.com:8443/x'), '')
  assert.equal(proxiedCoverUrl('https://u:p@i.ytimg.com/x'), '')
  assert.equal(proxiedCoverUrl(''), '')
  assert.equal(proxiedCoverUrl(null), '')
  assert.equal(proxiedCoverUrl(undefined), '')
  assert.equal(proxiedCoverUrl('not a url'), 'not a url')
  // isProxiedImgUrl 占位基址也解析失败的畸形串——既非相对引用亦非合法 URL，
  // fail-closed 空串（旧版直通会把垃圾串留给浏览器拼基址）
  assert.equal(proxiedCoverUrl('http://[::1'), '')
  assert.equal(proxiedCoverUrl('https://'), '')
  // 反斜杠升格面：WHATWG 解析把 '\host'、'/\host' 升成 //host 外联——同归 ''
  assert.equal(proxiedCoverUrl('\\\\evil.com/x.jpg'), '')
  assert.equal(proxiedCoverUrl('/\\evil.com/x.jpg'), '')
  // 幂等：已代理相对形逐字节原样；双包装不嵌套。宿主闸收紧后绝对形只认
  // ${API_BASE_URL}/ 前缀（浏览器跨源 base 部署的回环链）——node 环境 base=''
  // 下任何绝对同形都既非相对形也非前缀形，按非白名单口径归 '' 而非原样透出
  const wrapped = proxiedCoverUrl('https://i.ytimg.com/vi/x/hqdefault.jpg')
  assert.equal(proxiedCoverUrl(wrapped), wrapped)
  const abs = 'http://h:3101/img-proxy?url=' + encodeURIComponent('https://i.ytimg.com/x')
  assert.equal(proxiedCoverUrl(abs), '')
  // 伪造代理外观的外链同形不再直通：path 尾段 /img-proxy + url 参数不等于已代理
  assert.equal(proxiedCoverUrl('https://evil.example/img-proxy?url=x'), '')
  assert.equal(proxiedCoverUrl('//evil/img-proxy?url=x'), '')
  // 内嵌 /img-proxy?url= 片段 ≠ 已代理（解析 pathname 判，非裸子串）——
  // 白名单域 query 里带这串照样被包装
  assert.equal(proxiedCoverUrl('https://i.ytimg.com/x?next=/img-proxy?url=y'),
    proxied('https://i.ytimg.com/x?next=/img-proxy?url=y'))
  // coverSizeUrl 防腐化闸：已代理形逐字节原样——编码内明文 hdslb.com/126.net
  // 不喂 @WxH/param 改写（否则后缀拼到代理 path 上产死链）
  const proxiedHdslb = proxied('https://i0.hdslb.com/bfs/archive/x.jpg')
  assert.equal(coverSizeUrl(proxiedHdslb, 96), proxiedHdslb)
  const proxied126 = proxied('https://p1.music.126.net/a.jpg')
  assert.equal(coverSizeUrl(proxied126, 96), proxied126)
})

test('songThumbUrl：file_ 曲放行原图、provider 曲缩略后经代理、空曲空串', () => {
  // file_ 上传封面没有服务端缩放通道——原样经 file 端点出（量小）；
  // 同源相对 URL 不落 /img-proxy 包装
  assert.equal(songThumbUrl(FILE_OBJ, 96), fileArtifactUrl('file_abc12345', 'cover', 3))
  // provider 曲按 al.picUrl 走对应 CDN 语法，白名单域再经代理包装
  //（songThumbUrl 代码未动——包装是 coverSizeUrl 管线内生的）
  const ne = { id: '1', al: { picUrl: 'https://p1.music.126.net/abc/x.jpg' } }
  assert.equal(songThumbUrl(ne, 96),
    `/img-proxy?url=${encodeURIComponent('https://p1.music.126.net/abc/x.jpg?param=96y96')}`)
  const bv = { id: 'bv_BV1xx411c7mD', al: { picUrl: 'https://i0.hdslb.com/bfs/a.jpg' } }
  assert.equal(songThumbUrl(bv, 80),
    `/img-proxy?url=${encodeURIComponent('https://i0.hdslb.com/bfs/a.jpg@80w_80h_1c.jpg')}`)
  // 非白名单域封面：缩略改写不命中且 fail-closed 归 ''——不再直通外联，
  // 模板守卫以加工后值判空改收占位图
  const other = { id: '2', al: { picUrl: 'https://example.com/c.jpg' } }
  assert.equal(songThumbUrl(other, 96), '')
  assert.equal(songThumbUrl(null, 96), '')
  assert.equal(songThumbUrl({ id: '1' }, 96), '') // 无封面字段
})

test('songCoverUrl：恒回原始 URL——持久化/同步载荷基线不被包装', () => {
  // 展示侧包装归 coverSizeUrl/proxiedCoverUrl；songCoverUrl 原值必须干净，
  // 它同时喂 saved_queue.coverImgUrl/serializeRemoteSong 等持久化写入位
  const raw = 'https://p1.music.126.net/abc/x.jpg'
  assert.equal(songCoverUrl({ id: '1', al: { picUrl: raw } }), raw)
  assert.ok(!songCoverUrl({ id: '1', al: { picUrl: raw } }).includes('/img-proxy'))
})

// ── slimTrack：localStorage 持久化投影——白名单字段缺失=刷新后功能退化 ──

test('slimTrack：接口原对象瘦到白名单——alia/privilege 深字段/无关键全剥', () => {
  const fat = {
    id: '1', name: '歌', ar: [{ name: '甲', id: 7, tns: ['x'] }], artists: [{ name: '不该取' }],
    al: { name: '专', picUrl: 'http://c', id: 55, publishTime: 1, alia: ['big'], company: 'x' },
    picUrl: 'http://p', dt: 200000, duration: 199, fee: 1, mv: 99,
    privilege: { fee: 1, chargeInfoList: [{ a: 1 }], freeTrialPrivilege: { big: true }, payed: 1 },
    alia: ['别'], tns: ['t'], mark: 1, copyright: 1, mst: 9, cp: 2, sq: { big: 1 },
    bilibili: { bvid: 'BV1', author: 'UP' }, neteaseId: 'n1', custom: { lyricOffset: 5 },
  }
  const s = slimTrack(fat)
  assert.deepEqual(s, {
    id: '1', name: '歌',
    ar: [{ name: '甲' }],                              // 只留 name——id/tns 剥
    al: { id: 55, name: '专', picUrl: 'http://c', pic_str: undefined },
    picUrl: 'http://p', dt: 200000, duration: 199, fee: 1,
    privilege: { fee: 1 },                             // 套餐明细全剥
    neteaseId: 'n1',
    bilibili: { bvid: 'BV1', author: 'UP' },           // provider 整对象透传
    youtube: undefined, qq: undefined, file: undefined,
    custom: { lyricOffset: 5 },
  })
  // 剥掉的字段不在键集里（不是 undefined——真没有）
  for (const k of ['mv', 'alia', 'tns', 'mark', 'copyright', 'mst', 'cp', 'sq', 'artists', 'album'])
    assert.ok(!(k in s), `${k} 不该出现在瘦身结果`)
})

test('slimTrack：旧数据形态——字符串 ar 成员/字符串 al/artists 回折不丢', () => {
  const legacy = {
    id: '2', name: '老歌',
    artists: ['纯字符串艺人', { name: '混合对象' }], // ar 缺席时回折 artists
    album: '字符串专辑',                              // 非对象原样透传
    dt: 100,
  }
  const s = slimTrack(legacy)
  assert.deepEqual(s.ar, [{ name: '纯字符串艺人' }, { name: '混合对象' }])
  assert.equal(s.al, '字符串专辑')
})

test('slimTrack：al 缺 picUrl 时回捞 album.picUrl（封面不丢）', () => {
  const s = slimTrack({ id: '3', al: { name: 'A' }, album: { name: 'B', picUrl: 'http://b' } })
  assert.equal(s.al.picUrl, 'http://b') // 主形 al 胜名，封面回捞次形
  assert.equal(s.al.name, 'A')
})

test('slimTrack：空值/无 id 原样返回；provider/custom/file 整对象透传', () => {
  assert.equal(slimTrack(null), null)
  assert.equal(slimTrack(undefined), undefined)
  const bare = { name: '没 id' }
  assert.equal(slimTrack(bare), bare)
  const f = { id: 'file_x', file: { hasVideo: true, hasCover: true, coverV: 2, videoV: 1 } }
  assert.deepEqual(slimTrack(f).file, f.file)
})

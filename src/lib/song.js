// 歌单 id 谓词唯一真相源在 src/shared/predicates.js——
// re-export 保持既有调用面（App/SongList/PlaylistPanel/WatchView 均从此导入）
import { BV_TRACK_ID_RE, YT_TRACK_ID_RE, QQ_SONG_ID_RE, NETEASE_ID_RE, YT_ID_RE, FILE_TRACK_ID_RE } from '../shared/predicates.js'
import { resolveApiBaseUrl } from './api-base'
export { isLocalPlaylistId, isEphemeralPlaylistId, isSingleSongShellId, isFileTrackId } from '../shared/predicates.js'

// 上传资产的归属伪歌单——与服务端 routes/uploads.js 的 UPLOADS_PLAYLIST_ID 同源契约：
// file_ 曲的一切工件（audio/video/cover/lyrics）都经 file 端点按此 playlistId 取
export const UPLOADS_PLAYLIST_ID = 'local_uploads'

// file_ 曲工件 URL：与 downloadsApi.songFileUrl 同形但留在 lib 层——song.js
// 是纯函数库，不引 axios 链（api/uploads.js 经 http.js 拖实例副作用）。
// v 参数：换源后 URL 恒定，靠它戳破 <img>/<audio> 的 URL 键缓存
//（服务端 ETag 管 revalidate，img src 不变浏览器压根不 revalidate）
export function fileArtifactUrl(songId, kind, v) {
  const params = new URLSearchParams({ playlistId: UPLOADS_PLAYLIST_ID })
  if (kind) params.set('kind', kind)
  if (v != null) params.set('v', String(v))
  return `${resolveApiBaseUrl()}/downloads/songs/${encodeURIComponent(songId)}/file?${params}`
}

/** 歌曲是否 VIP 付费（App 与 SongList 共用同一谓词，避免两处过滤逻辑漂移） */
export function isVipSong(song) {
  return song?.fee === 1 || song?.privilege?.fee === 1
    || song?.qq?.payPlay || song?.qq?.vipOnly
}

/**
 * 凭据感知的"VIP 且不可播"判定（隐藏 VIP 过滤用）：qq payPlay 曲在服务端
 * 配了 QQ_COOKIE（含 VIP）时可播，不应被隐藏。caps 缺省/未拉取按无凭据
 * 保守处理（维持隐藏）。网易云 fee=1 无用户凭据通道，恒不可播。
 */
export function isVipUnplayable(song, caps) {
  if (!isVipSong(song)) return false
  if (song?.qq && caps?.qq?.loggedIn) return false
  return true
}

/** 艺人名兜底：ar||artists 数组 → "a, b"，空则 未知艺术家 */
export function songArtists(song) {
  const list = song?.ar || song?.artists || []
  return list.map(a => a?.name).filter(Boolean).join(', ') || '未知艺术家'
}

// 封面统一兜底：provider 曲封面在 al.picUrl；网易云曲另有顶层 picUrl /
// album.picUrl 形态——展示侧收口一条，比逐处 || 链少漂移。
// file_ 曲的封面是本地工件：扩展名由服务端登记行持有，客户端不推 URL——
// hasCover 位存在即走 file 端点（按行查 coverPath，任意图片扩展名都命中）
export function songCoverUrl(song) {
  // coverV 版本戳随换封面刷新——URL 不变 <img> 不会重取，视图会滞留旧图
  if (song?.file?.hasCover) return fileArtifactUrl(song.id, 'cover', song.file.coverV)
  return song?.picUrl || song?.al?.picUrl || song?.album?.picUrl || ''
}

// 「VIP 隐藏开关」过滤谓词（App.vue filteredSongs 与 SongList 共用——
// 此前两份手写副本）：showVip 时全量；否则滤掉 VIP 且当前凭据不可播的曲
export function visibleSongs(list, showVip, caps) {
  if (showVip) return list
  return (list || []).filter(song => !isVipUnplayable(song, caps))
}

/** 导入来源标签：youtube/bilibili/qq/file 字段即持久化的来源凭据（行内小牌用） */
export function songSource(song) {
  if (song?.bilibili) return 'B站'
  if (song?.youtube) return 'YouTube'
  if (song?.qq) return 'QQ音乐'
  if (song?.file || isFileTrackId(song?.id)) return '本地上传'
  return null
}

/**
 * 回源标签：provider 对象优先、本站轨道 id 前缀兜底——镜像投影/旧持久化
 * 形态可能缺 provider 对象但 id 仍在；网易云数字 id 也归有名（回源菜单文案）
 */
export function songSourceName(song) {
  const id = String(song?.id ?? '')
  if (song?.bilibili || BV_TRACK_ID_RE.test(id)) return 'B站'
  if (song?.youtube || YT_TRACK_ID_RE.test(id)) return 'YouTube'
  if (song?.qq || QQ_SONG_ID_RE.test(id)) return 'QQ音乐'
  if (song?.file || FILE_TRACK_ID_RE.test(id)) return '本地上传'
  if (NETEASE_ID_RE.test(id)) return '网易云'
  return null
}

/**
 * 回源 URL：曲目在源站的原页面——B站视频页（含分P）、YouTube watch、
 * QQ 单曲详情、网易云 song 页。与 songSourceName 同口径的对象优先/id 兜底
 */
export function songSourceUrl(song) {
  if (!song) return null
  const id = String(song.id ?? '')
  const bvM = BV_TRACK_ID_RE.exec(id)
  const bvid = song.bilibili?.bvid || bvM?.[1]
  if (bvid) {
    const page = +song.bilibili?.page || +bvM?.[2] || 0
    return `https://www.bilibili.com/video/${bvid}${page > 1 ? `?p=${page}` : ''}`
  }
  const vid = song.youtube?.videoId || YT_TRACK_ID_RE.exec(id)?.[1]
  if (vid) return `https://www.youtube.com/watch?v=${vid}`
  const mid = song.qq?.mid || QQ_SONG_ID_RE.exec(id)?.[1]
  if (mid) return `https://y.qq.com/n/ryqq/songDetail/${mid}`
  if (NETEASE_ID_RE.test(id)) return `https://music.163.com/song?id=${id}`
  return null
}

/**
 * 外部导入曲的演唱者口径：归真实上传者——YouTube=频道名、B站=UP主名，
 * 不用匹配到的网易云艺人（导入的是「这个视频的演唱」，matched 只供词源与封面兜底）。
 * 服务端 resolve 已给 authorClean（剥 ' - Topic'/'VEVO' 后缀）；旧持久化曲
 * 只有原始 author——本地同口径再剥一次，存量数据加载时自愈
 */
export function externalArtistName(song) {
  if (song?.youtube) {
    const clean = song.youtube.authorClean
      || String(song.youtube.author || '')
        .replace(/\s*-\s*Topic$/i, '')
        .replace(/VEVO$/i, '')
        .trim()
    return clean || 'YouTube'
  }
  if (song?.bilibili) return song.bilibili.author || 'Bilibili'
  return null // qq 曲的 ar 本身就是真实元数据，不走此口径
}

// 视频导入曲的「视频封面」口径：yt_ 可由 videoId 纯推导（hqdefault 恒存在，
// maxresdefault 在无高清缩略图的视频上 404 不能用）；bv_ 无推导路径，吃
// 导入时落库的 bilibili.cover（旧数据没有则返回 null 走不动）；qq_ 的
// picUrl 本就是自家封面，不走此口径
export function externalCoverUrl(song) {
  const id = String(song?.youtube?.videoId || '')
  if (YT_ID_RE.test(id)) return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`
  const cover = String(song?.bilibili?.cover || '')
  return /^https?:\/\//i.test(cover) ? cover : null
}

/**
 * trackOverrides 应用器：远端单曲目不可就地改写（下次 detail 拉取会覆盖），
 * 编辑落库对象上的 trackOverrides{songId:{name?,artist?,album?,durationMs?,coverUrl?}}，
 * 渲染前 merge——local_pl_/addedTracks 成员直接改字段不走这层。
 * 覆盖优先级最高：name/artist 换显示串；album 只改 al.name 不伤 al.picUrl
 * （封面换绑走 coverUrl——al.picUrl 是 provider 封面的既有槽位不能丢）。
 * file_ 曲不经过此函数（它的编辑直接写库对象成员）。
 */
export function applyTrackOverrides(song, overrides) {
  const o = overrides?.[String(song?.id ?? '')]
  if (!o) return song
  const out = { ...song }
  // 全字段 != null 口径：''=显式清空、0=显式清零（与就地分支同律）——真值闸
  // 会把「清空名/封面」静默丢掉
  if (o.name != null) out.name = o.name
  if (o.artist != null) out.ar = [{ name: o.artist || '未知艺术家' }]
  if (o.album != null) out.al = { ...(typeof song.al === 'object' && song.al ? song.al : {}), name: o.album }
  if (o.durationMs != null) out.dt = o.durationMs // 0=用户清空回「自动」，也要覆盖
  if (o.coverUrl != null) out.picUrl = o.coverUrl
  return out
}

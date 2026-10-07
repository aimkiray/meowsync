// 歌单 id 谓词唯一真相源在 src/shared/predicates.js——
// re-export 保持既有调用面（App/SongList/PlaylistPanel/WatchView 均从此导入）
import { BV_TRACK_ID_RE, YT_TRACK_ID_RE, QQ_SONG_ID_RE, NETEASE_ID_RE, YT_ID_RE, FILE_TRACK_ID_RE,
  isLocalPlaylistId, isEphemeralPlaylistId, isSingleSongShellId, isFileTrackId } from '../shared/predicates.js'
import { resolveApiBaseUrl } from './api-base.js'
// 注意必须用 import + export 两段式：export {x} from 'y' 不绑本地作用域，
// 本文件函数体（songSource 等）直接用谓词时裸 re-export 会 ReferenceError
export { isLocalPlaylistId, isEphemeralPlaylistId, isSingleSongShellId, isFileTrackId }

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

// 封面按展示档位走 CDN 缩放：列表 30~48px 小位不该拉原始分辨率——
// 网易原图动辄 600~3000px，每张解码位图 1~8MB，长歌单是 tab 内存头号
// 驱动。按各站图片服务的缩放语法改写 URL；file_ 本地工件与未知域原样
// 放行（服务端 file 端点无缩放通道，量也小）。
export function coverSizeUrl(url, px = 96) {
  const s = String(url || '')
  if (!s) return ''
  // 网易云 p*.music.126.net：?param={w}y{h} 服务端裁剪缩放；
  // 上游偶发已带 param 的 URL——重复键是 first-wins 未定义，改写其值而非追加
  if (/music\.126\.net/i.test(s)) {
    return /[?&]param=\d+y\d+/i.test(s)
      ? s.replace(/([?&]param=)\d+y\d+/i, `$1${px}y${px}`)
      : `${s}${s.includes('?') ? '&' : '?'}param=${px}y${px}`
  }
  // B站 i*.hdslb.com：@ 后缀挂在 path 尾（在 query 之前），_1c 居中裁方；
  // .jpg 服务端转码兜底——裸 .webp 在老内核（pre-Big-Sur Safari）直接白图
  if (/hdslb\.com/i.test(s)) {
    if (/@\d+w_/.test(s)) return s
    const qi = s.indexOf('?')
    const path = qi === -1 ? s : s.slice(0, qi)
    return `${path}@${px}w_${px}h_1c.jpg${qi === -1 ? '' : s.slice(qi)}`
  }
  // YouTube i.ytimg.com：default/mq/hq/maxres 是固定档位名，降档到 mq
  if (/i\.ytimg\.com/i.test(s)) {
    return s.replace(/(?:maxres|sd|hq)default/i, 'mqdefault')
  }
  // QQ y.gtimg.cn：T002R{w}x{h} 尺寸嵌在路径段（p.qpic.cn 无公开缩放通道，放行）
  if (/y\.gtimg\.cn/i.test(s)) {
    return /T002R\d+x\d+/i.test(s) ? s.replace(/T002R\d+x\d+/i, `T002R${px}x${px}`) : s
  }
  return s
}

/** 曲封面缩略图：songCoverUrl + coverSizeUrl 的合成，列表行/小卡统一走它 */
export function songThumbUrl(song, px = 96) {
  return coverSizeUrl(songCoverUrl(song), px)
}

// 「VIP 隐藏开关」过滤谓词（App.vue filteredSongs 与 SongList 共用——
// 此前两份手写副本）：showVip 时全量；否则滤掉 VIP 且当前凭据不可播的曲
export function visibleSongs(list, showVip, caps) {
  if (showVip) return list
  return (list || []).filter(song => !isVipUnplayable(song, caps))
}

/**
 * UGC 外链曲谓词（B 站/YouTube 投稿视频轨道）：provider 对象或裸前缀 id
 * 任一命中——provider 对象缺失的老持久化行只剩 bv_/yt_ 形态 id，id 即
 * 真理来源。qq_ 不在此列（QQ 曲有自家权威源，ar/词源链路都不同口径）。
 * 词务形闸（外源兜底/自动首配/水合/判否换绑）唯一消费点——此前 5+ 处
 * 各写一份「对象或形态任一」判断，口径漂移重灾区，收敛单点。
 */
export function isUgcExternalTrack(song) {
  return !!(song?.bilibili || song?.youtube)
    || BV_TRACK_ID_RE.test(String(song?.id)) || YT_TRACK_ID_RE.test(String(song?.id))
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

// 持久化瘦身投影：localStorage 曲对象只留「渲染+播放+自愈」读的字段。
// 网易云接口原对象单曲 ~2-4KB（alia/mv/privilege.chargeInfoList 等死字段
// 占大头），白名单后 ~400-700B——千曲本地单持久化从 ~8MB 压到 ~1MB。
// 读者面（逐字段对过）：songArtists= ar/artists[].name；songCoverUrl=
// file.hasCover/coverV + picUrl + al/album.picUrl；isVipSong= fee +
// privilege.fee + qq.payPlay/vipOnly；externalArtistName= youtube.author*/
// bilibili.author；externalCoverUrl= youtube.videoId 推导 + bilibili.cover；
// provider 对象（bilibili/youtube/qq/file）是播放凭据与下载镜像键——结构本
// 就紧凑（构建器收口），整体保留。dt/duration 双留：读者全走 dt||duration
// 且 file_ 曲两字段语义不同（duration 是媒体秒数）
export function slimTrack(t) {
  if (!t || t.id == null) return t
  const alObj = t.al && typeof t.al === 'object' ? t.al : null
  const albumObj = t.album && typeof t.album === 'object' ? t.album : null
  const alSrc = alObj || albumObj
  const arSrc = Array.isArray(t.ar) ? t.ar : (Array.isArray(t.artists) ? t.artists : null)
  return {
    id: t.id, name: t.name,
    // 成员可能是裸字符串（旧数据）：对象取 name、字符串透传——
    // {name:'x'} 与 'x' 对 songArtists 的 a?.name 读取同义，不该丢
    ar: arSrc ? arSrc.map(a => ({ name: typeof a === 'object' ? a?.name : a })) : undefined,
    // al 可能是字符串形态（旧数据/上游简化对象——healExternalAr 同口径
    // 只治对象形）：对象瘦身、非对象原样透传不丢专辑名。al 与 album 混
    // 存时主形缺 picUrl 回捞另一形（封面只挂在次形的混形曲不丢图）；
    // al.id 保留——首页专辑架去重按 id 优先于 name（同名专辑不坍缩）
    al: alSrc ? {
      id: alSrc.id, name: alSrc.name,
      picUrl: alSrc.picUrl ?? (alSrc === alObj ? albumObj : alObj)?.picUrl,
      pic_str: alSrc.pic_str,
    } : (t.al ?? t.album),
    picUrl: t.picUrl, dt: t.dt, duration: t.duration,
    fee: t.fee,
    // privilege 只读 fee（isVipSong）——chargeInfoList/freeTrialPrivilege 等
    // ~500-900B/曲的套餐明细是持久化最大死重
    privilege: t.privilege ? { fee: t.privilege.fee } : undefined,
    neteaseId: t.neteaseId,
    bilibili: t.bilibili, youtube: t.youtube, qq: t.qq, file: t.file,
    custom: t.custom,
  }
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

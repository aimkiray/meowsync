// 歌单 id 谓词唯一真相源在 src/shared/predicates.js——
// re-export 保持既有调用面（App/SongList/PlaylistPanel/WatchView 均从此导入）
import { BV_TRACK_ID_RE, YT_TRACK_ID_RE, QQ_SONG_ID_RE, NETEASE_ID_RE } from '../shared/predicates.js'
export { isLocalPlaylistId, isEphemeralPlaylistId, isSingleSongShellId } from '../shared/predicates.js'

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

/** 导入来源标签：youtube/bilibili/qq 字段即持久化的来源凭据（行内小牌用） */
export function songSource(song) {
  if (song?.bilibili) return 'B站'
  if (song?.youtube) return 'YouTube'
  if (song?.qq) return 'QQ音乐'
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
 * 不用匹配到的网易云艺人（导入的是「这个视频的演唱」，matched 只供封面/词源）。
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

// 歌单 id 谓词唯一真相源在 src/shared/predicates.js——
// re-export 保持既有调用面（App/SongList/PlaylistPanel/WatchView 均从此导入）
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

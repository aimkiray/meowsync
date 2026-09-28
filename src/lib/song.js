/** 歌曲是否 VIP 付费（App 与 SongList 共用同一谓词，避免两处过滤逻辑漂移） */
export function isVipSong(song) {
  return song?.fee === 1 || song?.privilege?.fee === 1
}

/**
 * 本地内存态歌单 id 判定：single_song_*（单曲分享临时歌单）与 saved_queue_*
 * （待播队列存成的歌单）都是非数字 id——不进 URL、不参与网易接口拉取、
 * 不显示分享/下载入口。各处判断统一收口到这里，避免前缀散落漂移。
 */
export function isLocalPlaylistId(id) {
  const s = String(id ?? '')
  return s.startsWith('single_song_') || s.startsWith('saved_queue_')
}

/** 艺人名兜底：ar||artists 数组 → "a, b"，空则 未知艺术家 */
export function songArtists(song) {
  const list = song?.ar || song?.artists || []
  return list.map(a => a?.name).filter(Boolean).join(', ') || '未知艺术家'
}

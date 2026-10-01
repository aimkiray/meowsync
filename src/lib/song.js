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

/**
 * 本地内存态歌单 id 判定：single_song_*（单曲分享临时歌单）、saved_queue_*
 * （待播队列存成的歌单）与 local_pl_*（用户手动新建的歌单，含 mix 导入的
 * local_pl_mix_*）都是非数字 id——不进 ?pl= URL、不参与网易接口拉取。
 * 分享走 ?mix= 内容链、下载走服务端镜像；single_song_ 壳是例外（仍隐藏，
 * 见 isSingleSongShellId）。
 * 各处判断统一收口到这里，避免前缀散落漂移。
 */
export function isLocalPlaylistId(id) {
  const s = String(id ?? '')
  return s.startsWith('single_song_') || s.startsWith('saved_queue_') || s.startsWith('local_pl_')
}

/**
 * 播放上下文物件判定：single_song_/saved_queue_ 前缀的单是「播放行为的产物」
 * （分享壳/队列快照），底栏据此禁用随机等歌单级操作；
 * local_pl_ 前缀的用户歌单不在此列——它就是正经歌单。
 */
export function isEphemeralPlaylistId(id) {
  const s = String(id ?? '')
  return s.startsWith('single_song_') || s.startsWith('saved_queue_')
}

/**
 * 单曲分享壳（single_song_*）——只装一首分享曲的容器，不提供歌单级
 * 分享/下载入口（单条曲目级分享已覆盖）。local_pl_/saved_queue_ 是正经
 * 内容歌单，享受远端单同款能力（mix 分享链 + 服务端镜像下载）。
 */
export function isSingleSongShellId(id) {
  return String(id ?? '').startsWith('single_song_')
}

/** 艺人名兜底：ar||artists 数组 → "a, b"，空则 未知艺术家 */
export function songArtists(song) {
  const list = song?.ar || song?.artists || []
  return list.map(a => a?.name).filter(Boolean).join(', ') || '未知艺术家'
}

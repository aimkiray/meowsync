// 全仓 localStorage key 的唯一注册表——新增 key 先在这里登记，避免字面量散布
export const LS_KEYS = {
  // 历史沿用名（勿改串值——存量用户数据挂在旧 key 上）：歌单库是全仓最大
  // 持久化负载，removedDefaultPlaylists 是其附属删除名单
  PLAYLISTS: 'userPlaylists',
  REMOVED_DEFAULT_PLAYLISTS: 'removedDefaultPlaylists',
  PLAYER_STATE: 'meowsync-player-state',
  PLAY_HISTORY: 'meowsync-play-history',
  PLAYLIST_HISTORY: 'meowsync-playlist-history',
  THEME: 'meowsync-theme',
  SETUP_DISMISSED: 'meowsync-setup-dismissed',
  // 历史沿用名：B 站时代起的视频偏好开关，YouTube 接入不换名以保留用户选择
  VIDEO_MODE: 'meowsync-bili-video',
  LYRIC_FONT_SIZE: 'meowsync-lyric-fs',
  WATCH_TAB: 'meowsync-watch-tab',
}

// localStorage JSON 读写（全部带异常防护，脏数据不再阻断调用方）
export function readJSON(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : JSON.parse(raw)
  } catch (e) {
    console.warn(`localStorage 读取 ${key} 失败，已重置:`, e.message)
    return fallback
  }
}

// 返回成败——配额满/存储禁用时调用方决定是否告知用户（此前静默 console.warn，
// 「已保存」类 toast 会撒谎：刷新后数据消失）
export function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch (e) {
    console.warn(`localStorage 写入 ${key} 失败:`, e.message)
    return false
  }
}

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
  // 故障动效减动豁免（glitch 字符腐蚀）：'1'=强制开，其余/absent=跟随系统。
  // 设备级 a11y 豁免——显式不进 sync.js 的 SYNC_LS_KEYS：减动豁免绑的是
  // 本机用户的感官需求，跨端 LWW 复制会把一台设备的豁免静默传染到所有登录端。
  // 钉板：tests/ui/sync.spec.mjs「非白名单键」用例
  GLITCH_MOTION: 'meowsync-glitch-motion',
  // 多端同步引擎（lib/sync.js）内部簿记：seq 域交付水位线 / doc 级
  // LWW 写戳表。只登记键名，不进同步白名单——簿记自身不产生同步内容
  SYNC_SINCE: 'meowsync-sync-since',
  SYNC_META: 'meowsync-sync-meta',
}

// 同步引擎写钩（src/lib/sync.js 的 initSync 注册）：默认 null 即 no-op——
// 未 init（未登录/遥控端/单测环境）时 writeJSON 零同步开销，测试隔离干净。
// 走模块级槽而非反向 import sync.js：storage 是依赖最底层，import 就成环
let writeHook = null
export function setWriteHook(fn) { writeHook = typeof fn === 'function' ? fn : null }
// 非 JSON 写路径（prefs.js/theme.js 的裸 setItem/removeItem）共用同一脏标记口
export function notifyStorageWrite(key) { writeHook?.(key) }

// localStorage JSON 读写（全部带异常防护，脏数据不再阻断调用方）
export function readJSON(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : JSON.parse(raw)
  } catch (e) {
    console.warn(`localStorage 读取 ${key} 失败，已重置:`, e.message)
    // 脏值清掉：不清则此后每次读取都重复告警且坏数据永久占位；
    // removeItem 自身也可能因存储禁用抛——与读失败一起放弃即可
    try { localStorage.removeItem(key) } catch { /* 存储禁用时同读失败一起放弃 */ }
    return fallback
  }
}

// 返回成败——配额满/存储禁用时调用方决定是否告知用户（此前静默 console.warn，
// 「已保存」类 toast 会撒谎：刷新后数据消失）。
// opts.remoteApplied：远端值回写专用——跳过脏标记，否则拉取落盘会被当成
// 本地变更立刻回推，形成拉-推回声环
export function writeJSON(key, value, opts = null) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    if (!opts?.remoteApplied) notifyStorageWrite(key)
    return true
  } catch (e) {
    console.warn(`localStorage 写入 ${key} 失败:`, e.message)
    return false
  }
}

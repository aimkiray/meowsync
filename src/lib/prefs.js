// 本机偏好共享态：设置页与 WatchView 是同一组 localStorage 偏好的两个
// 写面——共享 ref 让任一侧改动即时生效（设置页调视频模式，开着的 watch
// 页不用等下次挂载才吃到）
import { ref, watch, nextTick } from 'vue'
import { LS_KEYS, notifyStorageWrite } from './storage.js'

// 隐私模式/存储禁用时 localStorage 抛 SecurityError——裸读会砸模块求值
const safeGetLs = (k) => { try { return localStorage.getItem(k) } catch { return null } }
// 落盘成功顺带通知同步引擎记脏（引擎未 init 时 no-op）——与 writeJSON
// 内嵌钩同一收口，不让偏好裸写绕过同步白名单
const safeSetLs = (k, v) => {
  try {
    localStorage.setItem(k, v)
    notifyStorageWrite(k)
  } catch { /* 存不上就只用会话值 */ }
}

// 远端应用窗：同步引擎已把远端原文落进 LS，回填 ref 带起的 watcher
// 写盘要跳过——本机口径钳位/归一后的值若写回 LS，会被记脏推上去把
// 远端新版数据降级（如远端 lyric-fs=30、本机 MAX=24，回写 24 即成
// 「本机以新戳压掉远端合法值」）。LS 原文保持，重启读回同口径归一
let remoteApplying = false
const beginRemoteApply = () => {
  remoteApplying = true
  // post watcher 在同微任务批冲刷——nextTick 回调排在其后，窗口盖住回填写
  void nextTick(() => { remoteApplying = false })
}

// 视频模式：'0' 显式关，其余为开——视频源曲的价值就是画面，默认开。
// LS_KEYS.VIDEO_MODE 沿用 B 站时代键名：YouTube 接入不换名重置用户选择
export const prefVideoOn = ref(safeGetLs(LS_KEYS.VIDEO_MODE) !== '0')
watch(prefVideoOn, v => { if (!remoteApplying) safeSetLs(LS_KEYS.VIDEO_MODE, v ? '1' : '0') })

// 歌词字号：本机偏好存 localStorage（不像时间校准那样随歌曲入库）。
// CSS 变量 --lyric-fs 挂列表上，当前行/译文用 calc 相对值随动
export const LYRIC_FS_MIN = 10
export const LYRIC_FS_MAX = 24
// 导出给同步引擎远端回填用（src/lib/sync.js 的远端订阅调它）——
// 叶模块不许反向 import sync.js：会把 api/http 链拖进 node:test 裸跑面
export const clampLyricFs = (raw) => Math.min(LYRIC_FS_MAX, Math.max(LYRIC_FS_MIN,
  parseInt(raw) || 18))
export const prefLyricFontSize = ref(clampLyricFs(safeGetLs(LS_KEYS.LYRIC_FONT_SIZE)))
watch(prefLyricFontSize, v => { if (!remoteApplying) safeSetLs(LS_KEYS.LYRIC_FONT_SIZE, String(v)) })

// 多端同步远端落地（订阅在同步侧 sync.js initSync 注册）：LS 已被引擎
// 写好，这里只灌内存 ref；watcher 落盘由 remoteApplying 窗跳过
export function applyRemoteVideoPref() {
  beginRemoteApply()
  prefVideoOn.value = safeGetLs(LS_KEYS.VIDEO_MODE) !== '0'
}
export function applyRemoteLyricFs() {
  beginRemoteApply()
  prefLyricFontSize.value = clampLyricFs(safeGetLs(LS_KEYS.LYRIC_FONT_SIZE))
}

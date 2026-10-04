// 本机偏好共享态：设置页与 WatchView 是同一组 localStorage 偏好的两个
// 写面——共享 ref 让任一侧改动即时生效（设置页调视频模式，开着的 watch
// 页不用等下次挂载才吃到）
import { ref, watch } from 'vue'
import { LS_KEYS } from './storage.js'

// 隐私模式/存储禁用时 localStorage 抛 SecurityError——裸读会砸模块求值
const safeGetLs = (k) => { try { return localStorage.getItem(k) } catch { return null } }
const safeSetLs = (k, v) => { try { localStorage.setItem(k, v) } catch { /* 存不上就只用会话值 */ } }

// 视频模式：'0' 显式关，其余为开——视频源曲的价值就是画面，默认开。
// LS_KEYS.VIDEO_MODE 沿用 B 站时代键名：YouTube 接入不换名重置用户选择
export const prefVideoOn = ref(safeGetLs(LS_KEYS.VIDEO_MODE) !== '0')
watch(prefVideoOn, v => safeSetLs(LS_KEYS.VIDEO_MODE, v ? '1' : '0'))

// 歌词字号：本机偏好存 localStorage（不像时间校准那样随歌曲入库）。
// CSS 变量 --lyric-fs 挂列表上，当前行/译文用 calc 相对值随动
export const LYRIC_FS_MIN = 10
export const LYRIC_FS_MAX = 24
export const prefLyricFontSize = ref(
  Math.min(LYRIC_FS_MAX, Math.max(LYRIC_FS_MIN,
    parseInt(safeGetLs(LS_KEYS.LYRIC_FONT_SIZE)) || 18)))
watch(prefLyricFontSize, v => safeSetLs(LS_KEYS.LYRIC_FONT_SIZE, String(v)))

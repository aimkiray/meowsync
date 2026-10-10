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
// 「本机以新戳压掉远端合法值」）。LS 原文保持，重启读回同口径归一。
// 旗标键级独立（与 App.vue watchTabRemoteApplying 同口径）：applyRemoteItems
// 同步 for 循环连发多键时，先到键 ref 值没变→无 watcher job→它的关窗
// nextTick 会排在后到键的 watcher job 前面跑——共用单旗标被提前关窗，
// 后到键的归一值照样被回写推回服务端
const makeRemoteApplyGate = () => {
  let applying = false
  return {
    isApplying: () => applying,
    // 开窗/关窗拆两步，调用方在两步之间赋 ref——关窗 nextTick 必须挂在
    // ref 赋值**之后**：watcher 是 pre-flush 任务，ref 一变才入队；若先挂
    // nextTick 再改 ref，关窗回调会排在 watcher job 前面跑，窗口提前关上，
    // 归一值照样被回写推上去（App.vue watchTab 的 onRemoteApply 同款坑同序）
    begin: () => { applying = true },
    end: () => { void nextTick(() => { applying = false }) }
  }
}
const videoRemoteGate = makeRemoteApplyGate()
const lyricFsRemoteGate = makeRemoteApplyGate()

// 视频模式：'0' 显式关，其余为开——视频源曲的价值就是画面，默认开。
// LS_KEYS.VIDEO_MODE 沿用 B 站时代键名：YouTube 接入不换名重置用户选择
export const prefVideoOn = ref(safeGetLs(LS_KEYS.VIDEO_MODE) !== '0')
watch(prefVideoOn, v => { if (!videoRemoteGate.isApplying()) safeSetLs(LS_KEYS.VIDEO_MODE, v ? '1' : '0') })

// 歌词字号：本机偏好存 localStorage（不像时间校准那样随歌曲入库）。
// CSS 变量 --lyric-fs 挂列表上，当前行/译文用 calc 相对值随动
export const LYRIC_FS_MIN = 10
export const LYRIC_FS_MAX = 24
// 导出给同步引擎远端回填用（src/lib/sync.js 的远端订阅调它）——
// 叶模块不许反向 import sync.js：会把 api/http 链拖进 node:test 裸跑面
export const clampLyricFs = (raw) => Math.min(LYRIC_FS_MAX, Math.max(LYRIC_FS_MIN,
  parseInt(raw) || 18))
export const prefLyricFontSize = ref(clampLyricFs(safeGetLs(LS_KEYS.LYRIC_FONT_SIZE)))
watch(prefLyricFontSize, v => { if (!lyricFsRemoteGate.isApplying()) safeSetLs(LS_KEYS.LYRIC_FONT_SIZE, String(v)) })

// 故障动效豁免：'1' 显式强制开，其余/absent 跟随系统——读判据 === '1' 是
// opt-in（与 VIDEO_MODE 的 !== '0' opt-out 方向相反）：默认不该越过 a11y
// 系统闸，脏值保守回落跟随而非擅自开动效。本键不同步（设备级豁免不跨端
// 复制），故无 remoteApplyGate/applyRemote 回填函数
export const prefGlitchMotion = ref(safeGetLs(LS_KEYS.GLITCH_MOTION) === '1')
// DOM 侧豁免闸：<html> 挂 data-glitch-motion=强制开，是 style.css 减动块里
// 两条 .char-glitch 规则的 :not() 豁免锚。JS 判据与 CSS 豁免同生同灭——
// 缺 JS 则 active=false 不产 .char-glitch 节点；缺 CSS 则替身生成却被
// reduce 媒体块压回不可见。document 守卫守叶模块无 DOM 可 import 不变量
const applyGlitchMotionAttr = (on) => {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (on) root.setAttribute('data-glitch-motion', '')
  else root.removeAttribute('data-glitch-motion')
}
watch(prefGlitchMotion, v => {
  safeSetLs(LS_KEYS.GLITCH_MOTION, v ? '1' : '0')
  applyGlitchMotionAttr(v)
})
applyGlitchMotionAttr(prefGlitchMotion.value)

// 多端同步远端落地（订阅在同步侧 sync.js initSync 注册）：LS 已被引擎
// 写好，这里只灌内存 ref；watcher 落盘由各键自己的远端应用窗跳过
export function applyRemoteVideoPref() {
  videoRemoteGate.begin()
  prefVideoOn.value = safeGetLs(LS_KEYS.VIDEO_MODE) !== '0'
  videoRemoteGate.end()
}
export function applyRemoteLyricFs() {
  lyricFsRemoteGate.begin()
  prefLyricFontSize.value = clampLyricFs(safeGetLs(LS_KEYS.LYRIC_FONT_SIZE))
  lyricFsRemoteGate.end()
}

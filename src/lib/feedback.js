import { reactive } from 'vue'
import { glitchBurst } from './theme.js'

// 全局反馈服务：pixel-toast（轻提示）+ pixel-confirm（确认框）。
// 宿主组件 FeedbackHost.vue 挂在 App 根；业务侧只用 toast/pixelConfirm
// （toastDismiss 是手动回收通道，长驻 toast 完成时才需要）。
// error/danger 事件顺带推进 glitch 世代计数——GlitchText 实例在
// glitch 主题下同代 burst（张力表盘语义，其他主题下为零成本 no-op）
const state = reactive({
  toasts: [],          // { id, text, type: 'info'|'success'|'error', action? }
  confirm: null        // { message, confirmText, danger, resolve }
})

let toastSeq = 0

// 计时簿记：toast 自动退场可被悬停/聚焦暂停续跑——action toast 的 6s 对
// 键盘 Tab 序（Teleport 落 body 尾）不友好，hold/release 兜底 WCAG 2.2.1。
// holds 是占用源集合（pointer/focus 可同时占用），清空才真正续跑
const toastTimers = new Map() // id -> { timer, deadline, remaining, holds:Set }

export function toastHold(id, source) {
  const t = toastTimers.get(id)
  if (!t) return
  t.holds.add(source)
  if (t.timer) {
    clearTimeout(t.timer)
    t.timer = null
    t.remaining = Math.max(0, t.deadline - Date.now())
  }
}

export function toastRelease(id, source) {
  const t = toastTimers.get(id)
  if (!t || !t.holds.delete(source) || t.holds.size || t.timer) return
  if (t.remaining <= 0) { toastDismiss(id); return }
  t.timer = setTimeout(() => toastDismiss(id), t.remaining)
  t.deadline = Date.now() + t.remaining
}

// 返回 toast id 供 toastDismiss 手动回收——长驻进度 toast（外部导入
// 最坏分钟级）在完成后需要立即退场，不能挂着等超时。
// action: { label, onAction }——带操作入口的 toast（"查看进度"类跳转），
// 默认驻留翻倍到 6s 保证用户读得完点得上；点动作后由宿主回收。
// 契约：action 必须是第 4 实参，duration 用 null 占位取默认——
// 误放第 3 参会被当毫秒值 NaN→0ms 立即消失且 action 静默不渲染
export function toast(text, type = 'info', duration, action = null) {
  if (type === 'error') glitchBurst()
  const id = ++toastSeq
  const ms = duration ?? (action ? 6000 : 2600)
  state.toasts.push({ id, text: String(text), type, action })
  toastTimers.set(id, {
    timer: setTimeout(() => toastDismiss(id), ms),
    deadline: Date.now() + ms,
    remaining: ms,
    holds: new Set()
  })
  return id
}

export function toastDismiss(id) {
  const rec = toastTimers.get(id)
  if (rec?.timer) clearTimeout(rec.timer)
  toastTimers.delete(id)
  const i = state.toasts.findIndex(t => t.id === id)
  if (i !== -1) state.toasts.splice(i, 1)
}

export function pixelConfirm(message, { confirmText = '确定', danger = false } = {}) {
  // 重入防护：新 confirm 顶掉未决的旧框（按取消结算），否则旧 Promise 永远悬挂
  if (state.confirm) resolveConfirm(false)
  if (danger) glitchBurst()
  return new Promise(resolve => {
    state.confirm = { message: String(message), confirmText, danger, resolve }
  })
}

export function isConfirmOpen() {
  return state.confirm != null
}

// 仅供 FeedbackHost 使用
export function useFeedbackState() {
  return state
}

export function resolveConfirm(ok) {
  const c = state.confirm
  state.confirm = null
  c?.resolve(ok)
}

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
// holds 是占用源集合（pointer:<id>/focus 可同时占用），清空才真正续跑。
// deadline/remaining 用 performance.now() 单调钟——与 setTimeout 同源，
// 系统时钟回拨不会给 remaining 注入偏斜量放大驻留
const toastTimers = new Map() // id -> { timer, deadline, remaining, holds:Set }

export function toastHold(id, source) {
  const t = toastTimers.get(id)
  if (!t) return
  t.holds.add(source)
  if (t.timer) {
    clearTimeout(t.timer)
    t.timer = null
    t.remaining = Math.max(0, t.deadline - performance.now())
  }
}

export function toastRelease(id, source) {
  const t = toastTimers.get(id)
  if (!t || !t.holds.delete(source) || t.holds.size || t.timer) return
  if (t.remaining <= 0) { toastDismiss(id); return }
  t.timer = setTimeout(() => toastDismiss(id), t.remaining)
  t.deadline = performance.now() + t.remaining
}

// setTimeout 的 delay 按 int32 截断：>2^31-1 溢出回绕成 ~1ms——长驻语义
// 传超大 duration 反而下一拍立即退场，钳到 int32 上限
const MAX_TIMER_MS = 2 ** 31 - 1
// toasts 并存上限：批量失败/错误风暴无限堆叠会把屏幕顶满且旧条永驻
// 计时簿记白记——超帽逐最旧（与 scroll-mem FIFO 同思路）
const TOAST_CAP = 5

// 返回 toast id 供 toastDismiss 手动回收——长驻进度 toast（外部导入
// 最坏分钟级）在完成后需要立即退场，不能挂着等超时。
// action: { label, onAction }——带操作入口的 toast（"查看进度"类跳转），
// 默认驻留翻倍到 6s 保证用户读得完点得上；点动作后由宿主回收。
// 契约：action 必须是第 4 实参，duration 用 null 占位取默认——
// 误放第 3 参（对象等）会按非数值退化回默认驻留，action 静默不渲染。
// duration 边界语义：0/负数 = 下一拍立即退场；Infinity/NaN 也退化取默认；
// 要粘性（不自动退场）用大毫秒值 + toastDismiss 回收，不要传 Infinity
export function toast(text, type = 'info', duration, action = null) {
  if (type === 'error') glitchBurst()
  const id = ++toastSeq
  const fallback = action ? 6000 : 2600
  const raw = Number(duration ?? fallback)
  const ms = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), MAX_TIMER_MS) : fallback // 非数值 duration 退化取默认，簿记不产 NaN
  state.toasts.push({ id, text: String(text), type, action })
  // 超帽逐最旧——新条已入列尾，挤掉的总是最老那条
  while (state.toasts.length > TOAST_CAP) toastDismiss(state.toasts[0].id)
  toastTimers.set(id, {
    timer: setTimeout(() => toastDismiss(id), ms),
    deadline: performance.now() + ms,
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

// 「本拍刚结算」对拍戳：confirm 在 overlay 内被 @keydown.esc 结算先于一切
// window 层监听跑——轮到它们时 state.confirm 已 null，裸读会把同一发 Esc
// 再结算一次（确认框+沉浸层一键双关）。结算起的同一同步分发内
// isConfirmOpen 继续报开：后跑的 Esc/Tab 监听仍须把顶层让给它；
// queueMicrotask 清戳——分发结束即恢复，下一发按键不受影响
let settledInDispatch = false

export function isConfirmOpen() {
  return state.confirm != null || settledInDispatch
}

// 仅供 FeedbackHost 使用
export function useFeedbackState() {
  return state
}

export function resolveConfirm(ok) {
  const c = state.confirm
  state.confirm = null
  // 仅真结算过才打戳——无悬挂框的 no-op 调用（auth 清场等）不伪造「刚结算」
  if (c) {
    settledInDispatch = true
    queueMicrotask(() => { settledInDispatch = false })
  }
  c?.resolve(ok)
}

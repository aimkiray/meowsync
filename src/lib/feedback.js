import { reactive } from 'vue'

// 全局反馈服务：pixel-toast（轻提示）+ pixel-confirm（确认框）。
// 宿主组件 FeedbackHost.vue 挂在 App 根；业务代码只 import 这两个函数。
const state = reactive({
  toasts: [],          // { id, text, type: 'info'|'success'|'error' }
  confirm: null        // { message, confirmText, danger, resolve }
})

let toastSeq = 0

export function toast(text, type = 'info', duration = 2600) {
  const id = ++toastSeq
  state.toasts.push({ id, text: String(text), type })
  setTimeout(() => {
    const i = state.toasts.findIndex(t => t.id === id)
    if (i !== -1) state.toasts.splice(i, 1)
  }, duration)
}

export function pixelConfirm(message, { confirmText = '确定', danger = false } = {}) {
  return new Promise(resolve => {
    state.confirm = { message: String(message), confirmText, danger, resolve }
  })
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

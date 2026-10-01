import { reactive } from 'vue'

// 登录态模块级单例（与本项目 composable 惯例同型——ref 模块单例）。
// booted=false 期间 App 不渲染主壳：防止未判定就先打出一堆 401
const SETUP_DISMISS_KEY = 'meowsync-setup-dismissed'

export const authState = reactive({
  booted: false,        // /auth/status 已回包
  enabled: false,       // 服务端 users 非空
  setupRequired: false, // users 空 → 首个管理员建号页
  authenticated: false,
  username: null,
  expired: false,       // 运行中收到服务端 401 标记 → 弹回登录（session 过期/被清）
  // 建号引导可被「暂不设置」略过——局域网自用不想开登录的合法路径；
  // localStorage 记忆，公网部署者照常看到建号页。
  // try 包裹：cookies 全禁/严格隐私模式下访问 localStorage 直接抛 SecurityError，
  // 模块顶层裸读会让 import 失败 → createApp 不执行 → 整站白屏
  setupDismissed: (() => {
    try { return localStorage.getItem(SETUP_DISMISS_KEY) === '1' } catch { return false }
  })()
})

export function dismissSetup() {
  authState.setupDismissed = true
  try { localStorage.setItem(SETUP_DISMISS_KEY, '1') } catch { /* 隐私模式 */ }
}

// 需要登录门控：待建号且未略过，或已启用且未认证（含运行中被踢）
export function authRequired() {
  return (authState.setupRequired && !authState.setupDismissed)
    || (authState.enabled && !authState.authenticated)
}

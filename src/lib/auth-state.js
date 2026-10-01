import { reactive } from 'vue'

// 登录态模块级单例（与本项目 composable 惯例同型——ref 模块单例）。
// booted=false 期间 App 不渲染主壳：防止未判定就先打出一堆 401
export const authState = reactive({
  booted: false,        // /auth/status 已回包
  enabled: false,       // 服务端 users 非空
  setupRequired: false, // users 空 → 首个管理员建号页
  authenticated: false,
  username: null,
  expired: false        // 运行中收到 401 → 弹回登录（session 过期/被清）
})

// 需要登录门控：已启用且未认证（含运行中被踢）
export function authRequired() {
  return authState.enabled && !authState.authenticated
}

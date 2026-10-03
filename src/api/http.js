import axios from 'axios'
import { resolveApiBaseUrl } from '../lib/api-base.js'
import { authState } from '../lib/auth-state.js'

export const API_BASE_URL = resolveApiBaseUrl()

// DOWNLOAD_TOKEN（构建期注入）：服务端开写鉴权时所有请求自动带令牌。
// 令牌只发自己的 API host（baseURL 同源/配置域），不会外泄给上游
const DOWNLOAD_TOKEN = import.meta.env.VITE_DOWNLOAD_TOKEN || ''

// 单实例三域共用：music/downloads/ai 此前各建实例，拦截器口径漂移
// （music 剥 r.data、downloads 不剥、ai 在调用点手剥）。统一为：
// 请求加 _t 防缓存；响应直接回 JSON body {code,...}——调用方读 body.data
const http = axios.create({
  baseURL: API_BASE_URL,
  timeout: Number(import.meta.env.VITE_API_TIMEOUT) || 10000,
  withCredentials: true,
  headers: {
    'Accept': '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
  }
})

http.interceptors.request.use(
  config => {
    // 令牌只发自己的 API：按目标 URL 条件注入而非实例默认头——默认头会
    // 跟着任何混进本实例的绝对 URL 外泄（当前无此调用方，属加固）
    if (DOWNLOAD_TOKEN && config.url && !/^https?:/i.test(config.url)) {
      config.headers['x-download-token'] = DOWNLOAD_TOKEN
    }
    // 不污染调用方传入的 params 对象
    config.params = { ...config.params, _t: Date.now() }
    return config
  },
  error => Promise.reject(error)
)

http.interceptors.response.use(
  response => response.data,
  error => {
    // 会话过期/被服务端清扫：踢回登录门。只认服务端 authGate 下发的
    // x-ms-auth 标记——上游透传的裸 401（如 check_music）不带此头，
    // 不误触登出；同时不依赖本地 enabled 标志（探活失败时服务端仍标记）
    const url = error?.config?.url || ''
    const marker = error?.response?.headers?.['x-ms-auth']
    if (error?.response?.status === 401
      && marker === 'required'
      && !url.startsWith('/auth/')) {
      authState.enabled = true
      // 服务端既已要求登录，users 必非空——清掉探活期留下的陈旧
      // setupRequired，否则略过 setup 的用户被踢后看到建号页而非登录页
      authState.setupRequired = false
      authState.authenticated = false
      authState.expired = true
    }
    return Promise.reject(error)
  }
)

export default http

// 服务端错误统一返回 { code, message }——axios 把非 2xx 包成 error.response
// .data，裸 Error 只有 .message。此前 「response?.data?.message || message」
// 在 14 处手写，收口一处。注意：不经拦截器剥壳的错误（如 unwrapBody 抛的
// 业务错）走 .message 兜底，口径不变
export function apiErrorMessage(error) {
  return error?.response?.data?.message || error?.message
}

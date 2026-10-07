import axios from 'axios'
import { resolveApiBaseUrl } from '../lib/api-base.js'
import { authState } from '../lib/auth-state.js'

export const API_BASE_URL = resolveApiBaseUrl()

// VITE_DOWNLOAD_TOKEN（构建期注入）：服务对服务/脚本旁路凭据（全量 API）——
// 服务端开 DOWNLOAD_TOKEN 鉴权时所有请求自动带令牌。
// 令牌只发自己的 API host（baseURL 同源/配置域），不会外泄给上游
const DOWNLOAD_TOKEN = import.meta.env.VITE_DOWNLOAD_TOKEN || ''

// 裸 fetch/XHR 通道（uploads.js / music.js 流式落盘）与请求拦截器同口径的
// 令牌头构造——多处各自重复 VITE_DOWNLOAD_TOKEN 读取会漂移，统一收口在这里
export const downloadTokenHeaders = () =>
  DOWNLOAD_TOKEN ? { 'x-download-token': DOWNLOAD_TOKEN } : {}

// config.params 展开闸：只对 plain object 做合参——URLSearchParams/FormData
// 实例的键位不可枚举，{...p} 会静默展开成全空对象丢光调用方参数
const isPlainObject = (v) => typeof v === 'object' && v !== null
  && (v.constructor === Object || Object.getPrototypeOf(v) === null)

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
    // 令牌只发自己的 API：本实例调用全是根相对路径（'/x'），正向收敛
    // startsWith('/') 且排除 '//'——协议相对 '//evil.com/x' 会被 axios 当
    // 绝对地址直飞，旧的 /^https?:/i 负判定拦不住它，令牌随之裸泄
    if (DOWNLOAD_TOKEN && typeof config.url === 'string' && /^\/(?!\/)/.test(config.url)) {
      config.headers['x-download-token'] = DOWNLOAD_TOKEN
    }
    // 不污染调用方传入的 params 对象；非 plain object 展开即丢参——
    // URLSearchParams 走 append，其它异常形态告警透传（当前无此调用方）
    const p = config.params
    if (p instanceof URLSearchParams) {
      p.append('_t', String(Date.now()))
    } else if (p == null || isPlainObject(p)) {
      config.params = { ...p, _t: Date.now() }
    } else {
      console.warn('[http] config.params 非 plain object，防缓存参数 _t 未注入:', p?.constructor?.name)
    }
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
  // 三级兜底到非空串——裸 Error 无 message 的错误（如 DOMException/异常
  // 形态）不能让调用方拼出 '下载失败: undefined' 或直接空串上屏
  return error?.response?.data?.message || error?.message || '未知错误'
}

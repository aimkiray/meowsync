import axios from 'axios'
import { resolveApiBaseUrl } from '../lib/api-base'

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
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    ...(DOWNLOAD_TOKEN ? { 'x-download-token': DOWNLOAD_TOKEN } : {})
  }
})

http.interceptors.request.use(
  config => {
    // 不污染调用方传入的 params 对象
    config.params = { ...config.params, _t: Date.now() }
    return config
  },
  error => Promise.reject(error)
)

http.interceptors.response.use(
  response => response.data,
  error => Promise.reject(error)
)

export default http

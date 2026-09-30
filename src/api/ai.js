import axios from 'axios'
import { resolveApiBaseUrl } from '../lib/api-base'

const API_BASE_URL = resolveApiBaseUrl()

// AI 辅助接口走写通道——DOWNLOAD_TOKEN 开启时与 downloads/song-meta 同口径带令牌
// （AI 调用消耗上游配额，属于需要门禁的写路径）
const DOWNLOAD_TOKEN = import.meta.env.VITE_DOWNLOAD_TOKEN || ''

const http = axios.create({
  timeout: 30000,
  withCredentials: true,
  headers: DOWNLOAD_TOKEN ? { 'x-download-token': DOWNLOAD_TOKEN } : {}
})

// status 只缓存成功响应——瞬时失败（服务端重启/超时）不粘性禁用，
// 下次调用重试；200 的 enabled:false 是真实配置态，缓存到会话结束
let statusPromise = null

export const aiApi = {
  status: () => {
    if (!statusPromise) {
      statusPromise = http.get(`${API_BASE_URL}/ai/status`, { timeout: 8000 })
        .then(r => r.data || { enabled: false })
        .catch(() => { statusPromise = null; return { enabled: false } })
    }
    return statusPromise
  },

  // 生成/取回词源的中文译文 LRC（服务端缓存命中即回；官方译文存在则直回）
  // 歌词翻译是批量 AI 调用，整首最坏几分钟——给足 300s
  translateLyric: (id, signal = null) =>
    http.post(`${API_BASE_URL}/ai/lyric-translate`, { id }, { signal, timeout: 300000 })
      .then(r => r.data),

  // 核验配到的歌词是否属于来源音视频（外部导入曲专用）
  verifyLyric: (id, sourceTitle, sourceAuthor, signal = null) =>
    http.post(`${API_BASE_URL}/ai/lyric-verify`, { id, sourceTitle, sourceAuthor }, { signal })
      .then(r => r.data)
}

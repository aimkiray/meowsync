import axios from 'axios'
import { resolveApiBaseUrl } from '../lib/api-base'

const API_BASE_URL = resolveApiBaseUrl()
const API_TIMEOUT = parseInt(import.meta.env.VITE_API_TIMEOUT) || 10000
const RETRY_COUNT = 3
const RETRY_DELAY = 500

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: API_TIMEOUT,
  withCredentials: true,
  headers: {
    'Accept': '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
  }
})

api.interceptors.request.use(
  config => {
    // 不污染调用方传入的 params 对象
    config.params = { ...config.params, _t: Date.now() }
    return config
  },
  error => Promise.reject(error)
)

api.interceptors.response.use(
  response => response.data,
  error => Promise.reject(error)
)

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.name === 'CanceledError' || error?.code === 'ERR_CANCELED'
}

// 4xx 客户端错误（含参数错误、未找到的 API）重试无意义
function isRetryable(error) {
  const status = error?.response?.status
  return !(status >= 400 && status < 500)
}

async function withRetry(fn, retries = RETRY_COUNT) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn()
    } catch (error) {
      if (isAbortError(error) || !isRetryable(error) || i === retries - 1) throw error
      console.warn(`请求失败，${RETRY_DELAY}ms 后重试 (${i + 1}/${retries})`, error.message)
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * (i + 1)))
    }
  }
}

// 试听版/解锁失败统一判定
function isUnavailableTrack(songData) {
  return songData.unlockFailed || songData.freeTrialInfo != null
}

export const musicApi = {
  searchPlaylists: async (keywords, limit = 20, abortSignal = null) => {
    const response = await withRetry(() =>
      api.get('/search', { params: { keywords, type: 1000, limit }, signal: abortSignal })
    )
    const data = response.body || response
    return data.result || {}
  },

  getPlaylistDetail: async (id, abortSignal = null) => {
    const response = await withRetry(() =>
      api.get('/playlist_detail', { params: { id }, signal: abortSignal })
    )
    const data = response.body || response
    const playlist = data.playlist || {}

    const tracksResponse = await withRetry(() =>
      api.get('/playlist_track_all', {
        params: { id, limit: playlist.trackCount || 1000, offset: 0 },
        signal: abortSignal
      })
    )
    const tracksData = tracksResponse.body || tracksResponse
    return { ...playlist, tracks: tracksData.songs || [] }
  },

  getSongUrl: async (id, abortSignal = null) => {
    const bitrates = [320000, 192000]
    for (const br of bitrates) {
      abortSignal?.throwIfAborted?.()

      try {
        const response = await withRetry(() =>
          api.get('/song_url', { params: { id, br }, signal: abortSignal })
        )
        const data = response.body || response
        const songData = data.data?.[0] || {}

        if (songData.url && !songData.freeTrialInfo) {
          // 记录实际返回的码率而非请求的码率
          songData.bitrate = songData.br || br
          return songData
        }

        if (isUnavailableTrack(songData)) {
          throw new Error('无法获取完整版播放链接，可能是版权限制')
        }
      } catch (error) {
        if (isAbortError(error) || String(error?.message ?? '').includes('版权限制')) throw error
        console.warn(`音质 ${br} 获取失败:`, error?.message)
      }
    }
    throw new Error('无法获取歌曲播放链接，可能是版权限制')
  },

  getDownloadUrl: async (id, bitrate = 320000, abortSignal = null) => {
    const response = await withRetry(() =>
      api.get('/song_url', { params: { id, br: bitrate }, signal: abortSignal })
    )
    const data = response.body || response
    const songData = data.data?.[0] || {}
    if (!songData.url) throw new Error('无法获取下载链接')
    if (isUnavailableTrack(songData)) throw new Error('仅获取到试听片段，可能受版权限制')
    return { url: songData.url, bitrate: songData.br || bitrate, size: songData.size || 0, type: songData.type || 'mp3' }
  },

  downloadSong: async (song, bitrate = 320000) => {
    const downloadData = await musicApi.getDownloadUrl(song.id, bitrate)
    const artists = song.ar?.map(a => a.name).join(', ') ||
                   song.artists?.map(a => a.name).join(', ') || '未知艺术家'
    const fileName = `${artists} - ${song.name}.${downloadData.type}`
      .replace(/[\\/:*?"<>|]/g, '_')

    // 跨域 URL 的 download 属性会被浏览器忽略，需拉取为 blob 后触发本地下载
    const blobResponse = await fetch(downloadData.url)
    if (!blobResponse.ok) throw new Error(`下载失败: HTTP ${blobResponse.status}`)
    const blob = await blobResponse.blob()
    const objectUrl = URL.createObjectURL(blob)

    try {
      const link = document.createElement('a')
      link.href = objectUrl
      link.download = fileName
      link.style.display = 'none'
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
    } finally {
      URL.revokeObjectURL(objectUrl)
    }
    return { success: true, fileName, bitrate: downloadData.bitrate, size: downloadData.size }
  },

  getLyrics: async (id, abortSignal = null) => {
    const response = await withRetry(() =>
      api.get('/lyric', { params: { id }, signal: abortSignal })
    )
    const data = response.body || response
    const lyrics = parseLyrics(data.lrc?.lyric || '')
    const translations = parseLyrics(data.tlyric?.lyric || '')
    return {
      lyrics: mergeTranslations(lyrics, translations)
    }
  },

  getSongDetail: async (id, abortSignal = null) => {
    const response = await withRetry(() =>
      api.get('/song_detail', { params: { ids: id }, signal: abortSignal })
    )
    const data = response.body || response
    const songs = data.songs || []
    if (songs.length > 0) return songs[0]
    throw new Error('歌曲不存在')
  }
}

// 歌词与翻译数组均按时间排序，双指针合并 O(n+m)
function mergeTranslations(lyrics, translations) {
  let j = 0
  return lyrics.map(lyric => {
    while (j < translations.length - 1 &&
           Math.abs(translations[j + 1].time - lyric.time) <= Math.abs(translations[j].time - lyric.time)) {
      j++
    }
    const translation = translations[j] && Math.abs(translations[j].time - lyric.time) < 0.5
      ? translations[j].text
      : ''
    return { ...lyric, translation }
  })
}

function parseLyrics(lyricText) {
  if (!lyricText) return []
  return lyricText.split('\n')
    .map(line => {
      const match = line.match(/\[(\d+):(\d{1,2})(?:[.:](\d{1,3}))?\](.*)/)
      if (!match) return null
      // 去除增强LRC的行内时间标签 <mm:ss.xx> 和残留的重复时间戳
      const text = match[4]
        .replace(/<\d+:\d{1,2}(?:[.:]\d{1,3})?>/g, '')
        .replace(/^\s*(?:\[\d+:\d{1,2}(?:[.:]\d{1,3})?\]\s*)+/, '')
        .trim()
      const ms = match[3] ? parseInt(match[3].padEnd(3, '0')) : 0
      const time = parseInt(match[1]) * 60 + parseInt(match[2]) + ms / 1000
      return text ? { time, text } : null
    })
    .filter(Boolean)
    .sort((a, b) => a.time - b.time)
}

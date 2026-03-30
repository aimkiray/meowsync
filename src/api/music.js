import axios from 'axios'
import CryptoJS from 'crypto-js'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3002'
const API_TIMEOUT = parseInt(import.meta.env.VITE_API_TIMEOUT) || 10000
const RETRY_COUNT = 3
const RETRY_DELAY = 500

// 网抑云加密相关常量
const IV = '0102030405060708'
const PRESET_KEY = '0CoJUm6Qyw8W8jud'
const LINUX_API_KEY = 'rFgB&h#%2?^eDg:Q'
const BASE62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

function randomString(length) {
  let result = ''
  for (let i = 0; i < length; i++) {
    result += BASE62.charAt(Math.floor(Math.random() * BASE62.length))
  }
  return result
}

function aesEncrypt(text, key) {
  const keyBytes = CryptoJS.enc.Utf8.parse(key)
  const ivBytes = CryptoJS.enc.Utf8.parse(IV)
  const encrypted = CryptoJS.AES.encrypt(text, keyBytes, {
    iv: ivBytes,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7
  })
  return encrypted.toString()
}

function rsaEncrypt(text) {
  return '257348aecb5e556c066de214e531faadd1c55d814f9be95fd06d6bff9f4c7a41f831f6394d5a3fd2e3881736d94a02ca919d952872e7d0a50ebfa1769a7a62d512f5f1ca21aec60bc3819a9c3ffca5eca9a0dba6d6f7249b06f5965ecfff3695b54e1c28f3f624750ed39e7de08fc8493242e26dbc4484a01c76f739e135637c'
}

function weapi(object) {
  const text = JSON.stringify(object)
  const secretKey = randomString(16)
  const params = aesEncrypt(aesEncrypt(text, PRESET_KEY), secretKey)
  const encSecKey = rsaEncrypt(secretKey.split('').reverse().join(''))
  return { params, encSecKey }
}

function eapi(url, object) {
  const text = JSON.stringify(object)
  const message = `nobody${url}use${text}md5forencrypt`
  const digest = CryptoJS.MD5(message).toString()
  const data = `${url}-36cd479b6b5-${text}-36cd479b6b5-${digest}`
  return { params: aesEncrypt(data, LINUX_API_KEY).toUpperCase() }
}

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
    if (config.params) config.params._t = Date.now()
    return config
  },
  error => Promise.reject(error)
)

api.interceptors.response.use(
  response => response.data,
  error => Promise.reject(error)
)

async function withRetry(fn, retries = RETRY_COUNT) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn()
    } catch (error) {
      if (i === retries - 1) throw error
      console.warn(`请求失败，${RETRY_DELAY}ms 后重试 (${i + 1}/${retries})`, error.message)
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * (i + 1)))
    }
  }
}

export const musicApi = {
  searchPlaylists: async (keywords, limit = 20) => {
    const response = await withRetry(() =>
      api.get('/search', { params: { keywords, type: 1000, limit } })
    )
    const data = response.body || response
    return data.result || {}
  },

  getPlaylistDetail: async (id) => {
    const response = await withRetry(() =>
      api.get('/playlist_detail', { params: { id } })
    )
    const data = response.body || response
    const playlist = data.playlist || {}

    const tracksResponse = await withRetry(() =>
      api.get('/playlist_track_all', {
        params: { id, limit: playlist.trackCount || 1000, offset: 0 }
      })
    )
    const tracksData = tracksResponse.body || tracksResponse
    return { ...playlist, tracks: tracksData.songs || [] }
  },

  getSongUrl: async (id, abortSignal = null) => {
    const bitrates = [320000, 192000, 128000, 96000]
    for (const br of bitrates) {
      try {
        const response = await withRetry(() =>
          api.get('/song_url', { params: { id, br }, signal: abortSignal })
        )
        const data = response.body || response
        const songData = data.data?.[0] || {}
        // 解锁失败或仍是试听版，抛出明确错误
        if (songData.unlockFailed || songData.freeTrialInfo != null) {
          throw new Error('无法获取完整版播放链接，可能是版权限制')
        }
        if (songData.url) {
          songData.bitrate = br
          return songData
        }
      } catch (error) {
        if (error.message.includes('版权限制')) throw error
        console.warn(`音质 ${br} 获取失败:`, error.message)
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
    return { url: songData.url, bitrate, size: songData.size || 0, type: songData.type || 'mp3' }
  },

  downloadSong: async (song, bitrate = 320000) => {
    const downloadData = await musicApi.getDownloadUrl(song.id, bitrate)
    const link = document.createElement('a')
    link.href = downloadData.url
    const artists = song.ar?.map(a => a.name).join(', ') ||
                   song.artists?.map(a => a.name).join(', ') || '未知艺术家'
    const fileName = `${artists} - ${song.name}.${downloadData.type}`
    link.download = fileName
    link.style.display = 'none'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    return { success: true, fileName, bitrate: downloadData.bitrate, size: downloadData.size }
  },

  getLyrics: async (id) => {
    const response = await withRetry(() =>
      api.get('/lyric', { params: { id } })
    )
    const data = response.body || response
    const lyrics = parseLyrics(data.lrc?.lyric || '')
    const translations = parseLyrics(data.tlyric?.lyric || '')
    return {
      lyrics: lyrics.map(lyric => ({
        ...lyric,
        translation: translations.find(t => Math.abs(t.time - lyric.time) < 0.5)?.text || ''
      }))
    }
  },

  getSongDetail: async (id) => {
    const response = await withRetry(() =>
      api.get('/song/detail', { params: { ids: id } })
    )
    const data = response.body || response
    const songs = data.songs || []
    if (songs.length > 0) return songs[0]
    throw new Error('歌曲不存在')
  }
}

function parseLyrics(lyricText) {
  if (!lyricText) return []
  return lyricText.split('\n')
    .map(line => {
      const match = line.match(/\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/)
      if (!match) return null
      const time = parseInt(match[1]) * 60 + parseInt(match[2]) + parseInt(match[3].padEnd(3, '0')) / 1000
      const text = match[4].trim()
      return text ? { time, text } : null
    })
    .filter(Boolean)
    .sort((a, b) => a.time - b.time)
}

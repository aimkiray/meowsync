import axios from 'axios'
import { resolveApiBaseUrl } from '../lib/api-base'
import { httpsCover } from '../lib/url'

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

// 响应形态校验：反代把 API 错指到静态服时会返回 HTML 200——不经校验的
// `.result`/`.playlist` 会静默吞成空态（"无结果"/"空歌单"假象），必须抛错
function unwrapBody(response) {
  const data = response && typeof response === 'object' && 'body' in response
    ? response.body
    : response
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    // 打标而非靠消息串匹配——catch 侧靠标记透出，改文案不会静默退化
    const err = new Error('接口返回异常')
    err.isShapeError = true
    throw err
  }
  return data
}

export const musicApi = {
  // limit 默认 100：网易歌单搜索对英文/长尾关键词的召回深度很差，
  // 相关结果常排在官方第一页之外（如 "mushroom" 的相关歌单在 25 位以后），
  // 20 条会直接漏掉。上游实测接受 100，前端已有分页负责展示切片
  searchPlaylists: async (keywords, limit = 100, abortSignal = null) => {
    const response = await withRetry(() =>
      api.get('/search', { params: { keywords, type: 1000, limit }, signal: abortSignal })
    )
    const data = unwrapBody(response)
    return data.result || {}
  },

  // 搜索建议（typeahead）：返回按类型分组的建议（songs/artists/albums/playlists）
  searchSuggest: async (keywords, abortSignal = null) => {
    const response = await api.get('/search_suggest', {
      params: { keywords },
      signal: abortSignal,
      timeout: 5000 // typeahead 要快——超时就别弹了
    })
    const data = unwrapBody(response)
    return data.result || {}
  },

  // 歌曲搜索（type=1）：结果直接可播，点击即播。
  // 走 cloudsearch 而非 legacy /search——后者 album 只有 picId 无 picUrl，
  // 行封面全掉 fallback；cloudsearch 返回完整 al/ar/dt/privilege 字段
  searchSongs: async (keywords, limit = 30, abortSignal = null) => {
    const response = await withRetry(() =>
      api.get('/cloudsearch', { params: { keywords, type: 1, limit }, signal: abortSignal })
    )
    const data = unwrapBody(response)
    return data.result?.songs || []
  },

  // 首页发现流：排行榜（toplist）+ 推荐歌单（personalized）+ 热搜词
  getToplists: async (abortSignal = null) => {
    const response = await api.get('/toplist', { signal: abortSignal, timeout: 15000 })
    const data = unwrapBody(response)
    return data.list || []
  },

  getPersonalized: async (limit = 12, abortSignal = null) => {
    const response = await api.get('/personalized', {
      params: { limit },
      signal: abortSignal,
      timeout: 15000
    })
    const data = unwrapBody(response)
    return data.result || []
  },

  getSearchHot: async (abortSignal = null) => {
    const response = await api.get('/search_hot', { signal: abortSignal, timeout: 8000 })
    const data = unwrapBody(response)
    return data.result?.hots || []
  },

  getPlaylistDetail: async (id, abortSignal = null) => {
    // 千曲歌单的上游链路已放宽到 120s，前端超时必须对齐——10s 先断只是
    // 让服务端继续跑僵尸上游请求，用户看到的仍是失败
    const response = await withRetry(() =>
      api.get('/playlist_detail', { params: { id }, signal: abortSignal, timeout: 120000 })
    )
    const data = unwrapBody(response)
    if (!data.playlist || typeof data.playlist !== 'object') {
      throw new Error('歌单接口返回异常')
    }
    const playlist = data.playlist

    // limit 用 trackIds 全长而非 trackCount——后者是展示计数会滞后，
    // 上游新增未刷新时按它截断会丢尾部曲目（服务端 playlist-sync 同款坑）
    const response2 = await withRetry(() =>
      api.get('/playlist_track_all', {
        params: { id, limit: playlist.trackIds?.length || playlist.trackCount || 1000, offset: 0 },
        signal: abortSignal,
        timeout: 120000
      })
    )
    const tracksData = unwrapBody(response2)
    // 上游错误码/空返不当空列表过：调用方会把空 tracks 当"歌单被清空"合并，冲掉本地差量
    if (tracksData.code != null && tracksData.code !== 200) {
      throw new Error(`歌单曲目接口返回 code=${tracksData.code}`)
    }
    return { ...playlist, tracks: Array.isArray(tracksData.songs) ? tracksData.songs : [] }
  },

  getSongUrl: async (id, abortSignal = null) => {
    const bitrates = [320000, 192000]
    let lastError = null
    for (const br of bitrates) {
      abortSignal?.throwIfAborted?.()

      try {
        const response = await withRetry(() =>
          // 解锁链最坏路径（4 源串行试错+HEAD 探测）远超 10s 默认超时——
          // 客户端先断会让服务端继续跑僵尸链，必须给足窗口
          api.get('/song_url', {
            params: { id, br, purpose: 'playback' },
            signal: abortSignal,
            timeout: 90000
          })
        )
        const data = unwrapBody(response)
        const songData = data.data?.[0] || {}

        if (songData.url && !songData.freeTrialInfo) {
          // 记录实际返回的码率而非请求的码率；
          // http:// 音频链在 HTTPS 部署下会被混合内容拦截（Safari 不自动升级）
          songData.bitrate = songData.br || br
          songData.url = httpsCover(songData.url)
          return songData
        }

        if (isUnavailableTrack(songData)) {
          throw new Error('无法获取完整版播放链接，可能是版权限制')
        }
      } catch (error) {
        // 形态校验错误（部署错配/反代 HTML）必须直接透出——吞掉换码率重试会
        // 把部署问题降级成误导性的"版权限制"
        if (isAbortError(error) || error?.isShapeError
            || String(error?.message ?? '').includes('版权限制')) throw error
        lastError = error
        console.warn(`音质 ${br} 获取失败:`, error?.message)
      }
    }
    // 真实错误优先透出：全部码率失败时把 5xx/超时归因塌缩成"版权限制"
    // 会误导排障方向
    throw lastError || new Error('无法获取歌曲播放链接，可能是版权限制')
  },

  getDownloadUrl: async (id, bitrate = 320000, abortSignal = null) => {
    const response = await withRetry(() =>
      api.get('/song_url', {
        params: { id, br: bitrate, purpose: 'download' },
        signal: abortSignal,
        timeout: 90000
      })
    )
    const data = unwrapBody(response)
    const songData = data.data?.[0] || {}
    if (!songData.url) throw new Error('无法获取下载链接')
    if (isUnavailableTrack(songData)) throw new Error('仅获取到试听片段，可能受版权限制')
    // fetch 是主动混合内容——http:// 在 HTTPS 页面下必被拦截且不自动升级
    return { url: httpsCover(songData.url), bitrate: songData.br || bitrate, size: songData.size || 0, type: songData.type || 'mp3' }
  },

  downloadSong: async (song, bitrate = 320000) => {
    const downloadData = await musicApi.getDownloadUrl(song.id, bitrate)
    const artists = song.ar?.map(a => a.name).join(', ') ||
                   song.artists?.map(a => a.name).join(', ') || '未知艺术家'
    const fileName = `${artists} - ${song.name}.${downloadData.type}`
      .replace(/[\\/:*?"<>|]/g, '_')

    // 跨域 URL 的 download 属性会被浏览器忽略，需拉取为 blob 后触发本地下载。
    // 解锁源 CDN（kuwo/googlevideo 等）基本不带 ACAO，fetch 会被 CORS 拒——
    // 一律先走同源 /audio-proxy 中转（白名单域 http/https 都放、逐跳公网校验）；
    // 白名单外目标或代理上游失败回退直连（官方 CDN 带 ACAO 的能直连成功，
    // 无 ACAO 的也只是与代理相同的失败，不回退体验）
    const proxyUrl = `${API_BASE_URL}/audio-proxy?url=${encodeURIComponent(downloadData.url)}`
    let blobResponse = await fetch(proxyUrl).catch(() => null)
    if (!blobResponse || !blobResponse.ok) {
      blobResponse = await fetch(downloadData.url).catch(error => {
        throw new Error(`下载失败: ${error.message || '网络错误'}`)
      })
    }
    if (!blobResponse.ok) throw new Error(`下载失败: HTTP ${blobResponse.status}`)
    const blob = await blobResponse.blob()
    const objectUrl = URL.createObjectURL(blob)

    const link = document.createElement('a')
    link.href = objectUrl
    link.download = fileName
    link.style.display = 'none'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    // 吊销必须延迟：click 同步触发但浏览器取流是异步的，立即 revoke 在
    // Safari/旧 Firefox 上会取消刚启动的下载
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
    return { success: true, fileName, bitrate: downloadData.bitrate, size: downloadData.size }
  },

  getLyrics: async (id, abortSignal = null) => {
    const response = await withRetry(() =>
      api.get('/lyric', { params: { id }, signal: abortSignal })
    )
    const data = unwrapBody(response)
    const lyrics = parseLyrics(data.lrc?.lyric || '')
    // 翻译文件常缺自己的 [offset:] 标签——用主歌词的 offset 兜底对齐，
    // 否则主词已偏移、翻译未偏移，0.5s 合并窗永远配不上对而全部丢弃
    const translations = parseLyrics(data.tlyric?.lyric || '', getLrcOffsetSec(data.lrc?.lyric))
    return {
      lyrics: mergeTranslations(lyrics, translations)
    }
  },

  getSongDetail: async (id, abortSignal = null) => {
    const response = await withRetry(() =>
      api.get('/song_detail', { params: { ids: id }, signal: abortSignal })
    )
    const data = unwrapBody(response)
    const songs = data.songs || []
    if (songs.length > 0) return songs[0]
    throw new Error('歌曲不存在')
  },

  // B 站导入：解析 BV/av/URL → 视频元信息 + 歌名提取 + 网易云匹配。
  // 服务端串三次上游（view/tags/playurl + 云搜），链路最坏 ~20s，放宽超时
  resolveBilibili: async (input, abortSignal = null) => {
    const response = await api.get('/bilibili/resolve', {
      params: { input },
      signal: abortSignal,
      timeout: 60000
    }).catch(err => {
      // 服务端错误体 {code,message} 必须透出——axios 对非 2xx 直接 reject，
      // 不提取的话用户只看到 "status code 502" 而非具体失败原因
      if (err?.response?.data?.message) throw new Error(err.response.data.message)
      throw err
    })
    const data = unwrapBody(response)
    if (data.code !== 200) throw new Error(data.message || 'B 站解析失败')
    return data
  },

  // 流地址：服务端每次重解 playurl（CDN 签名会过期）再 302 进 /audio-proxy，
  // 前端拿到的总是新鲜地址——直接塞给 <audio>/<video>/Howler 即可
  bilibiliStreamUrl: (bvid, kind = 'audio', cid = null) => {
    const params = new URLSearchParams({ bvid, kind })
    if (cid) params.set('cid', cid)
    return `${API_BASE_URL}/bilibili/stream?${params}`
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

// [offset:±ms] LRC 全局偏移：约定正值=歌词整体提前（显示时间 = 标签时间 - offset）。
// 锚定行首——正文里恰好出现的 "[offset:xxx]" 不该污染全局时序。
// 返回 null 表示文件未声明（调用方用主歌词的 offset 兜底）
function getLrcOffsetSec(lyricText) {
  if (!lyricText) return null
  const offsetMatch = lyricText.match(/^\s*\[offset:\s*([+-]?\d+)\s*\]/im)
  return offsetMatch ? parseInt(offsetMatch[1]) / 1000 : null
}

function parseLyrics(lyricText, fallbackOffsetSec = null) {
  if (!lyricText) return []
  const offsetSec = getLrcOffsetSec(lyricText) ?? fallbackOffsetSec ?? 0
  // /g 是承重墙：matchAll 对非 global 正则直接 TypeError
  const timeTag = /\[(\d+):(\d{1,2})(?:[.:](\d{1,3}))?\]/g

  const result = []
  for (const line of lyricText.split('\n')) {
    const tags = [...line.matchAll(timeTag)]
    if (!tags.length) continue
    // 多时间戳行（[t1][t2]text）= 同一文本在多个时间点出现——展开成多条；
    // 文本=去掉所有行首时间戳与增强 LRC 行内 <mm:ss.xx> 标签
    const text = line.replace(timeTag, '')
      .replace(/<\d+:\d{1,2}(?:[.:]\d{1,3})?>/g, '')
      .trim()
    if (!text) continue
    for (const m of tags) {
      const ms = m[3] ? parseInt(m[3].padEnd(3, '0')) : 0
      const time = parseInt(m[1]) * 60 + parseInt(m[2]) + ms / 1000 - offsetSec
      result.push({ time: Math.max(0, time), text })
    }
  }
  return result.sort((a, b) => a.time - b.time)
}

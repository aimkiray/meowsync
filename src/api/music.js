import api, { API_BASE_URL } from './http.js'
import { httpsCover } from '../lib/url.js'

const RETRY_COUNT = 3
const RETRY_DELAY = 500

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.name === 'CanceledError' || error?.code === 'ERR_CANCELED'
}

// 4xx 客户端错误（含参数错误、未找到的 API）重试无意义
function isRetryable(error) {
  // 超时不重试：90s/120s 端点 ×3 重试是十几分钟假死，且每次重发都让
  // 服务端重跑一条僵尸上游链。axios 超时错误码 ECONNABORTED；fetch 语义
  // 超时是 TimeoutError（AbortSignal.timeout）——name/message 双兜底
  // （AbortError/CanceledError 由 isAbortError 管，不冲突）
  if (error?.code === 'ECONNABORTED' || error?.name === 'TimeoutError'
      || /timeout/i.test(error?.message || '')) return false
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

// resolve 系错误的重抛帮手：透出服务端 message 的同时保留响应 data——
// 结构化字段（disstid 歌单跳转、favlist 收藏夹跳转）下游靠它路由
function resolveRethrow(err) {
  const e = new Error(err.response.data.message)
  e.data = err.response.data
  return e
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
  // 20 条会直接漏掉。上游实测接受 100，前端 PlaylistGrid 渐进渲染窗负责展示切片
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

  // 单曲搜索深挖：cloudsearch 上游带 offset 翻页 + songCount 总数。
  // 与 searchSongs 分离——返回形带 total，调用面互不污染；同样裹 withRetry
  // （首屏腿与深挖腿共用，瞬断时与旧 searchSongs 同口径自愈）
  searchSongsPage: async (keywords, { limit = 20, offset = 0, signal } = {}) => {
    const response = await withRetry(() =>
      api.get('/cloudsearch', {
        params: { keywords, type: 1, limit, offset }, signal
      })
    )
    const data = unwrapBody(response)
    return { songs: data.result?.songs || [], total: data.result?.songCount ?? null }
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
    // 无 ACAO 的也只是与代理相同的失败，不回退体验）。
    // 服务端已 vault 化的回链（/audio-proxy/t/…）是成品同源地址——直接 fetch，
    // 再包一层 ?url= 会得到代理套代理的坏链
    const alreadyProxied = downloadData.url.includes('/audio-proxy/')
    const proxyUrl = alreadyProxied ? downloadData.url
      : `${API_BASE_URL}/audio-proxy?url=${encodeURIComponent(downloadData.url)}`
    let blobResponse = await fetch(proxyUrl, { credentials: 'include' }).catch(() => null)
    if (!blobResponse || !blobResponse.ok) {
      // CDN 直连必须 omit——上游普遍只回 ACAO:*，credentialed 请求会被浏览器拦
      blobResponse = await fetch(downloadData.url, { credentials: 'omit' }).catch(error => {
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

  // 无 neteaseId 外源曲（bv_/yt_）的歌词兜底：服务端 YTM→LRCLIB→酷狗
  // 三级级联（routes/lyric-external）。命中回 {lrc, source, extId, synced,
  // plain?}——extId（ytm_/lrclib_/kugou_ 前缀词源命名空间 id）即词属主键，
  // 校准 meta/verify/translate 白名单均已对它放开；synced=false 时 lrc
  // 是纯文本。级联全灭服务端回 404——「外面确实没词」是常态结局，归一成
  // null 不进错误通道；其余错误（网络/超时）照常抛。三源串行 + AI 归属
  // 核验最坏 ~70s，超时给 80s
  getExternalLyric: async ({ id, title, artist, durationSec }, abortSignal = null) => {
    const response = await api.get('/lyric/external', {
      params: { id, title, artist, duration: durationSec },
      signal: abortSignal,
      timeout: 80000
    }).catch(err => {
      if (err?.response?.status === 404) return null
      throw err
    })
    if (response === null) return null
    const data = unwrapBody(response)
    // 契约平铺 {code,lrc,...}；data 嵌套形态兼容性地看一眼
    const hit = data.data && typeof data.data === 'object' ? data.data : data
    if (typeof hit.lrc !== 'string' || !hit.lrc.trim()) return null
    return {
      lrc: hit.lrc,
      plain: typeof hit.plain === 'string' ? hit.plain : null,
      source: hit.source ?? null,
      extId: hit.extId ?? null,
      synced: hit.synced !== false
    }
  },

  // 手动「生成滚动词」：POST /lyric-align——纯文本词行 + 已下载音频工件
  // （songId 寻址，服务端跨歌单查 download_tasks 的 completed 行）经
  // ffmpeg 抽包络 + LLM 行首映射产滚动 LRC。ffmpeg 解码+AI 是重活，
  // 超时放宽到 120s。错误不吞——调用方按 e.response.status 分诊文案
  // （404 无已下载音频或无词 / 503 ffmpeg 缺席 / 429 限流 / 502 对齐失败）
  lyricAlign: async ({ songId, lines }, abortSignal = null) => {
    const response = await api.post('/lyric-align', { songId, lines }, {
      signal: abortSignal,
      timeout: 120000
    })
    const data = unwrapBody(response)
    if (data.code !== 200) throw new Error(data.message || '歌词对齐失败')
    return data
  },

  // 错配纠正口：POST /match/retry——前端拿持久化 provider 字段组匹配材料，
  // excludeIds 把当前判否的词源 id 并进请求级否决集重跑云搜+AI 复核链，
  // 命中即服务端覆写 song_match 行。回命中对象 {id,name,ar,al} 并透传同层
  // 诊断字段：matchedBy 是命中它的查询串、score 是置信分，调用方经 extras
  // 落 provider.matchedBy/matchScore 供纠错排查（score 为调用方实读字段，
  // matchScore 别名对齐 provider 侧命名）；未中回 null；错误（429/502 等）
  // 照常抛给调用方。最坏 ~55s，超时放宽到 60s
  retryMatch: async ({ trackId, title, author, artists, durationSec, candidates, excludeIds },
    abortSignal = null) => {
    const response = await api.post('/match/retry', {
      trackId, title, author, artists, durationSec, candidates, excludeIds
    }, { signal: abortSignal, timeout: 60000 })
    const data = unwrapBody(response)
    if (data.code !== 200) throw new Error(data.message || '重匹配失败')
    const payload = data.data && typeof data.data === 'object' ? data.data : data
    return payload.matched && typeof payload.matched === 'object' && payload.matched.id != null
      ? {
        ...payload.matched,
        matchedBy: payload.matchedBy ?? null,
        matchScore: payload.score ?? null,
        score: payload.score ?? null,
      }
      : null
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

  // 批量歌曲详情（mix 分享链重解析用）：上游 ids 逗号串接受数组口径
  getSongsDetail: async (ids, abortSignal = null) => {
    if (!ids?.length) return []
    const response = await withRetry(() =>
      api.get('/song_detail', { params: { ids: ids.join(',') }, signal: abortSignal })
    )
    const data = unwrapBody(response)
    // 上游业务码非 200（限流/参数错）必须抛错——静默 [] 会让 mix 导入把整块
    // 记成 skipped 产出残缺单，而幂等壳短路会让它永久无法补齐
    if (data.code != null && data.code !== 200) {
      throw new Error(`歌曲详情接口异常（code ${data.code}）`)
    }
    return data.songs || []
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
      // 不提取的话用户只看到 "status code 502" 而非具体失败原因。
      // 重抛的裸 Error 带上 .data——favlist/disstid 这类结构化跳转字段
      // 在 catch 链下游靠它自动转歌单导入，丢了会陷入「请粘顶栏」死循环
      if (err?.response?.data?.message) throw resolveRethrow(err)
      throw err
    })
    const data = unwrapBody(response)
    if (data.code !== 200) throw new Error(data.message || 'B 站解析失败')
    return data
  },

  // B 站收藏夹导入：favlist 链接/mlN → 收藏夹元信息 + 归一曲目（服务端
  // 翻页拉全 + 预算制词源匹配）。大夹链路最坏 ~60s+，超时放宽到 120s
  getBiliFavlist: async (input, abortSignal = null) => {
    const response = await api.get('/bilibili/favlist', {
      params: { input },
      signal: abortSignal,
      timeout: 120000
    }).catch(err => {
      if (err?.response?.data?.message) throw resolveRethrow(err)
      throw err
    })
    const data = unwrapBody(response)
    if (data.code !== 200) throw new Error(data.message || '收藏夹获取失败')
    return data
  },

  // YouTube 歌单导入：playlist?list=/watch?list=/裸 PL → 歌单元信息 +
  // 归一曲目（服务端 continuation 翻页 + 预算制词源匹配）。最坏 ~60s+，
  // 超时放宽到 120s
  getYouTubePlaylist: async (input, abortSignal = null) => {
    const response = await api.get('/youtube/playlist', {
      params: { input },
      signal: abortSignal,
      timeout: 120000
    }).catch(err => {
      if (err?.response?.data?.message) throw resolveRethrow(err)
      throw err
    })
    const data = unwrapBody(response)
    if (data.code !== 200) throw new Error(data.message || '歌单获取失败')
    return data
  },

  // 流地址：服务端每次重解 playurl（CDN 签名会过期）再 302 进 /audio-proxy，
  // 前端拿到的总是新鲜地址——直接塞给 <audio>/<video>/Howler 即可。
  // kind=video 下匿名低热度稿可能被 durl 合流档反超（服务端内部比高）
  bilibiliStreamUrl: (bvid, kind = 'audio', cid = null, page = 1, prefer = '') => {
    const params = new URLSearchParams({ bvid, kind })
    if (cid) params.set('cid', cid)
    if (page > 1) params.set('p', page)
    if (prefer) params.set('prefer', prefer)
    return `${API_BASE_URL}/bilibili/stream?${params}`
  },

  // B 站曲的"获取源文件"：prefer=best 优先 Hi-Res FLAC/杜比轨
  // （需服务端 BILI_COOKIE 登录态下发，无则回落最高码率 AAC），
  // 扩展名按实际 Content-Type 落地（flac→.flac，aac→.m4a）
  downloadBilibiliSong: async (song) => {
    const b = song?.bilibili
    if (!b?.bvid) throw new Error('不是 B 站导入曲')
    const artists = song.ar?.map(a => a.name).join(', ') || '未知艺术家'
    return saveStreamAsFile(
      musicApi.bilibiliStreamUrl(b.bvid, 'audio', b.cid, b.page, 'best'),
      `${artists} - ${song.name}.m4a`)
  },

  // YouTube 导入：解析 watch/youtu.be/shorts 等 URL 形态 → videoDetails + 歌名提取 + 网易云
  // 匹配。服务端串 Innertube + 云搜，超时放宽与 B 站同款
  resolveYouTube: async (input, abortSignal = null) => {
    const response = await api.get('/youtube/resolve', {
      params: { input },
      signal: abortSignal,
      timeout: 60000
    }).catch(err => {
      if (err?.response?.data?.message) throw resolveRethrow(err)
      throw err
    })
    const data = unwrapBody(response)
    if (data.code !== 200) throw new Error(data.message || 'YouTube 解析失败')
    return data
  },

  // 流地址：服务端每次重解 Innertube（googlevideo 签名 ~6h 过期）再 302 进
  // /audio-proxy——kind=video 拿 avc1 adaptive，audio 默认优先
  // mp4a（Safari 兼容）；prefer=best 给下载归档用——按码率取最优（Opus 251
  // 全频带，AAC 140 在 16kHz 被低通截断）
  youtubeStreamUrl: (videoId, kind = 'audio', prefer = '', retry = 0) => {
    const params = new URLSearchParams({ v: videoId, kind })
    if (prefer) params.set('prefer', prefer)
    // 重试标记：服务端 gateCache 30min 判定可能误判——重试旁路缓存读
    // 强制重探（服务端仍写新判定），不是无意义地重放同一个死链
    if (retry > 0) params.set('retry', '1')
    return `${API_BASE_URL}/youtube/stream?${params}`
  },

  // YouTube 曲的"获取源文件"：prefer=best 抓 Opus 251（扩展名按实际
  // Content-Type 落地——webm，不是强行塞 m4a）
  downloadYouTubeSong: async (song) => {
    const y = song?.youtube
    if (!y?.videoId) throw new Error('不是 YouTube 导入曲')
    const artists = song.ar?.map(a => a.name).join(', ') || '未知艺术家'
    return saveStreamAsFile(
      musicApi.youtubeStreamUrl(y.videoId, 'audio', 'best'),
      `${artists} - ${song.name}.m4a`)
  },

  // QQ 音乐导入：解析 songDetail/分享链接/songmid/songid → 真实元数据 +
  // 网易云匹配（只做封面/歌词兜底源）。服务端串 musicu + 云搜
  resolveQQ: async (input, abortSignal = null) => {
    const response = await api.get('/qq/resolve', {
      params: { input },
      signal: abortSignal,
      timeout: 60000
    }).catch(err => {
      if (err?.response?.data?.message) throw resolveRethrow(err)
      throw err
    })
    const data = unwrapBody(response)
    if (data.code !== 200) throw new Error(data.message || 'QQ 音乐解析失败')
    return data
  },

  // 流地址：服务端每次重取 vkey（签名 ~22h 过期且绑 IP）再 302 进
  // /audio-proxy。prefer=best 走 RS01/F000 无损档梯（需 QQ_COOKIE 登录态），
  // 播放默认匿名稳态档（M800/M500/C400 逐档回落）
  qqStreamUrl: (mid, prefer = '', mmid = '') => {
    const params = new URLSearchParams({ mid })
    if (mmid) params.set('mmid', mmid)
    if (prefer) params.set('prefer', prefer)
    return `${API_BASE_URL}/qq/stream?${params}`
  },

  // QQ 曲的"获取源文件"：prefer=best 优先 Hi-Res/FLAC 档
  downloadQQSong: async (song) => {
    const q = song?.qq
    if (!q?.mid) throw new Error('不是 QQ 音乐曲')
    const artists = song.ar?.map(a => a.name).join(', ') || '未知艺术家'
    return saveStreamAsFile(
      musicApi.qqStreamUrl(q.mid, 'best', q.mediaMid),
      `${artists} - ${song.name}.m4a`)
  },

  // QQ 自带权威歌词（LRC+翻译，服务端 base64 解好）——qq_ 曲的词源正主。
  // 返回与 getLyrics 同形态（已合并翻译的 lyrics 数组）
  getQQLyric: async (mid, abortSignal = null) => {
    const response = await api.get('/qq/lyric', { params: { mid }, signal: abortSignal }).catch(err => {
      if (err?.response?.data?.message) throw resolveRethrow(err)
      throw err
    })
    const data = unwrapBody(response)
    if (data.code !== 200) throw new Error(data.message || 'QQ 歌词获取失败')
    const lyrics = parseLyrics(data.lyric || '')
    const translations = parseLyrics(data.trans || '', getLrcOffsetSec(data.lyric))
    return { lyrics: mergeTranslations(lyrics, translations) }
  },

  // QQ 凭据状态：{loggedIn}——配了 VIP QQ_COOKIE 的部署里 qq payPlay 曲可播，
  // 前端"隐藏VIP"过滤据此放行（失败保守回落未登录）
  getQqStatus: async () => {
    // api 拦截器已剥 axios 壳——resolve 值就是 body {code, loggedIn}，无 .data 层
    const body = await api.get('/qq/status', { timeout: 5000 }).catch(() => null)
    return { loggedIn: Boolean(body?.loggedIn) }
  },

  // QQ 曲库搜索（点歌台 qq: 前缀；服务端固定回 20 条）
  searchQQSongs: async (q, abortSignal = null) => {
    const response = await api.get('/qq/search', { params: { q }, signal: abortSignal }).catch(err => {
      if (err?.response?.data?.message) throw resolveRethrow(err)
      throw err
    })
    const data = unwrapBody(response)
    if (data.code !== 200) throw new Error(data.message || 'QQ 音乐搜索失败')
    return data.list || []
  },

  // QQ 歌单详情（disstid → 归一曲目列表，导入本地歌单用）
  getQQPlaylist: async (id) => {
    const response = await api.get('/qq/playlist', {
      params: { id }, timeout: 60000
    }).catch(err => {
      if (err?.response?.data?.message) throw resolveRethrow(err)
      throw err
    })
    const data = unwrapBody(response)
    if (data.code !== 200) throw new Error(data.message || 'QQ 歌单获取失败')
    return data
  }
}

// 流式落盘共用：同源 fetch（已含代理链）→ blob → a[download] 触发保存。
// 扩展名以实际 Content-Type 为准——prefer=best 时 YouTube 音频可能是
// webm/opus 而非调用方猜的 m4a，容器名对不上播不了的播放器会懵
const STREAM_EXT = {
  'audio/mp4': '.m4a', 'audio/webm': '.webm', 'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3', 'audio/flac': '.flac', 'audio/x-flac': '.flac',
  'video/mp4': '.mp4', 'video/webm': '.webm'
}
// 文件头魔数 → 扩展名：flac 'fLaC' / webm+mkv EBML / mp4族 'ftyp' 在第5字节 /
// ogg 'OggS' / mp3 'ID3' 或帧同步 0xFFEx。读前 12 字节足够
async function sniffExt(blob) {
  const buf = new Uint8Array(await blob.slice(0, 12).arrayBuffer())
  const hex = [...buf].map(b => b.toString(16).padStart(2, '0')).join('')
  if (hex.startsWith('664c6143')) return '.flac'
  if (hex.startsWith('1a45dfa3')) return '.webm'
  if (hex.slice(8, 16) === '66747970') return '.m4a'
  if (hex.startsWith('4f676753')) return '.ogg'
  if (hex.startsWith('494433') || hex.startsWith('ffe')) return '.mp3'
  return null
}
// prefer=best 在配了 DOWNLOAD_TOKEN+BILI_COOKIE 的部署要令牌——带上无妨，
// 未配令牌门的服务端会忽略它
const DOWNLOAD_TOKEN = import.meta.env.VITE_DOWNLOAD_TOKEN || ''
async function saveStreamAsFile(url, fileName) {
  const resp = await fetch(url, {
    credentials: 'include', // 跨域部署（VITE_API_BASE_URL ≠ 页面源）也要带会话 cookie
    headers: DOWNLOAD_TOKEN ? { 'x-download-token': DOWNLOAD_TOKEN } : {}
  })
  if (!resp.ok) {
    // 服务端错误体是 {code,message}——「该视频没有可代理的音频流」这类
    // 具体原因上屏好过裸状态码
    const msg = await resp.json().then(d => d?.message).catch(() => null)
    throw new Error(msg || `下载失败: HTTP ${resp.status}`)
  }
  const blob = await resp.blob()
  const ct = (resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  // 魔数优先于 Content-Type：代理对缺 CT 的上游兜 audio/mp4，魔数是字节
  // 真相——flac 字节流被存成 .m4a 比没扩展名更误导；两者都缺再回落调用方
  const ext = await sniffExt(blob) || STREAM_EXT[ct]
  if (ext) {
    fileName = /\.[a-z0-9]+$/i.test(fileName)
      ? fileName.replace(/\.[a-z0-9]+$/i, ext)
      : fileName + ext
  }
  const objectUrl = URL.createObjectURL(blob)
  const safeName = fileName.replace(/[\\/:*?"<>|]/g, '_')
  const link = document.createElement('a')
  link.href = objectUrl
  link.download = safeName
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  // 吊销必须延迟：click 同步触发但浏览器取流是异步的
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
  return { success: true, fileName: safeName }
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
    // AI 译文里未译行回填的是原文（占住时间戳防邻行错贴）——同文即未译不显示
    return { ...lyric, translation: translation === lyric.text ? '' : translation }
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

// 供 AI 译文回填复用——loadLyrics 拿到 tlyric 后与主歌词按时间窗合并
export { parseLyrics, mergeTranslations }

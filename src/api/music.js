import api, { API_BASE_URL, downloadTokenHeaders } from './http.js'
import { httpsCover } from '../lib/url.js'
import { parseLrc, lrcOffsetSec, mergeTranslations as mergeLrcTranslations, neteaseLyricBody } from '../shared/lrc.js'

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

// 上游业务码闸：HTTP 200 下发的 code!==200（301 重定向/460 拥挤/限流参数错
// 等）不能当空态归一——「上游拒了」与「真没有」是两种结局，静默吞会让搜索
// 空态/「没词」假象骗过排障。code 缺席放行：自有端点契约未必带 code，
// 与 playlist_track_all/getSongsDetail 两处既有闸同口径。err.bizCode 打标——
// 调用方要按码分诊不必回头串匹配 message
function assertCode200(data, label) {
  if (data.code != null && data.code !== 200) {
    const err = new Error(`${label}接口异常（code ${data.code}）`)
    err.bizCode = data.code
    throw err
  }
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
    assertCode200(data, '歌单搜索')
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
    assertCode200(data, '搜索建议')
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
    assertCode200(data, '歌曲搜索')
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
    assertCode200(data, '歌曲搜索')
    return { songs: data.result?.songs || [], total: data.result?.songCount ?? null }
  },

  getPersonalized: async (limit = 12, abortSignal = null) => {
    const response = await api.get('/personalized', {
      params: { limit },
      signal: abortSignal,
      timeout: 15000
    })
    const data = unwrapBody(response)
    assertCode200(data, '推荐歌单')
    return data.result || []
  },

  getSearchHot: async (abortSignal = null) => {
    const response = await api.get('/search_hot', { signal: abortSignal, timeout: 8000 })
    const data = unwrapBody(response)
    assertCode200(data, '热搜')
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
          // 解锁链最坏路径（2 源串行试错+HEAD 探测）远超 10s 默认超时——
          // 客户端先断会让服务端继续跑僵尸链，必须给足窗口
          api.get('/song_url', {
            params: { id, br, purpose: 'playback' },
            signal: abortSignal,
            timeout: 90000
          })
        )
        const data = unwrapBody(response)
        // 上游业务码（301/460 等）随 HTTP 200 下发——换码率重试前先进
        // lastError 簿记，全部码率失败时把它透出而非塌缩成「版权限制」
        assertCode200(data, '播放地址')
        const songData = data.data?.[0] || {}

        if (songData.url && !songData.freeTrialInfo) {
          // 记录实际返回的码率而非请求的码率；
          // http:// 音频链在 HTTPS 部署下会被混合内容拦截（Safari 不自动升级）
          songData.bitrate = songData.br || br
          songData.url = httpsCover(songData.url)
          return songData
        }

        if (isUnavailableTrack(songData)) {
          // 打标分流：catch 侧靠 err.isUnavailable 透出，不靠「版权限制」
          // 串匹配——改文案不会静默退化成换码率空转
          const err = new Error('无法获取完整版播放链接，可能是版权限制')
          err.isUnavailable = true
          throw err
        }
      } catch (error) {
        // 形态校验错误（部署错配/反代 HTML）与不可用判定的错误必须直接透出——
        // 吞掉换码率重试会把部署问题/确定性失败降级成误导性的重试空转
        if (isAbortError(error) || error?.isShapeError || error?.isUnavailable) throw error
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
    // 与 getSongUrl 同口径：code!==200（404 无货/301/460 等）透出业务码，
    // 不能塌缩成笼统「无法获取下载链接」让排障分不清上游拒与真没链
    assertCode200(data, '下载地址')
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
    // /song_url 回链已在服务端 vault 化（/audio-proxy/t/… 成品同源地址）——
    // 直接 fetch，再包一层 ?url= 会得到代理套代理的坏链；未 vault 化的边缘
    // 形态（旧服务端/无 proxyOrigin 回链）防御性包 ?url= 同源壳，保留为
    // 调试/兼容通道。fail-closed：代理链失败只透错误——直连源站回退已删
    // （「浏览器不对源站发被动请求」整站不变式；无 ACAO 的 CDN 直连本就
    // 是与代理相同的失败，回退无体验收益）。
    // credentials=same-origin：/audio-proxy 固定回 ACAO:*，include 在跨源
    // 部署下硬冲突必败；vault 链是 PUBLIC_GET 无需凭据，同源下仍带 cookie
    // 兼容 auth-gate 收编的 ?url= 兜底
    // [/?] 双形态都算已代理：/t/<token>（vault 链）与 ?url=（旧壳/调试通道）——
    // 防未来 vault→query 形态漂移时套出代理包代理的双包坏链
    const alreadyProxied = /\/audio-proxy[/?]/.test(downloadData.url)
    const proxyUrl = alreadyProxied ? downloadData.url
      : `${API_BASE_URL}/audio-proxy?url=${encodeURIComponent(downloadData.url)}`
    const blobResponse = await fetch(proxyUrl, {
      credentials: 'same-origin',
      signal: AbortSignal.timeout(BLOB_FETCH_TIMEOUT_MS)
    })
    if (!blobResponse.ok) {
      // 服务端错误体是 {code,message}——「请求太频繁」/「stream token expired」
      // 这类具体原因上屏好过裸状态码（与 saveStreamAsFile 同口径）。
      // 不带「下载失败:」前缀——toast 层（useServerDownloads）固定补前缀，防双显
      const msg = await blobResponse.json().then(d => d?.message).catch(() => null)
      throw new Error(msg || `HTTP ${blobResponse.status}`)
    }
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
    // 上游错误码不当「没词」归一——歌词空与上游拒词是两种结局
    assertCode200(data, '歌词')
    // 无词标记/纯占位词归一成空词——nolyric·uncollected 旗标或全文只剩
    // 「纯音乐，请欣赏」式占位行的词不该进合并/展示（空词会触下游兜底；
    // 归一口径收敛在共享层 neteaseLyricBody——占位主词连带不透 tlyric）
    const { lrc: lrcText, tlyric: tlyricText } = neteaseLyricBody(data)
    const lyrics = parseLyrics(lrcText)
    // 翻译文件常缺自己的 [offset:] 标签——用主歌词的 offset 兜底对齐，
    // 否则主词已偏移、翻译未偏移，0.5s 合并窗永远配不上对而全部丢弃
    const translations = parseLyrics(tlyricText, getLrcOffsetSec(lrcText))
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
    // 「外面确实没词」是常态结局：HTTP 404 已在 catch 归 null；body 内
    // code:404（防御：契约漂移时）同口径归 null，其余业务码照常抛
    if (data.code === 404) return null
    assertCode200(data, '外部歌词')
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
  // ffmpeg 抽包络 + LLM 行首映射产滚动 LRC。服务端最坏路径=
  // ALIGN_DEADLINE_MS 240s（ffmpeg 解码窗口）+ AI 行首映射——客户端
  // 120s 会先死在等待里（服务端活儿没做完回包却被掐断），给 300s。
  // 错误不吞——调用方按 e.response.status 分诊文案
  // （404 无已下载音频或无词 / 503 ffmpeg 缺席 / 429 限流 / 502 对齐失败）
  lyricAlign: async ({ songId, lines }, abortSignal = null) => {
    const response = await api.post('/lyric-align', { songId, lines }, {
      signal: abortSignal,
      timeout: 300000
    })
    const data = unwrapBody(response)
    if (data.code !== 200) throw new Error(data.message || '歌词对齐失败')
    return data
  },

  // 绑定态只读口：GET /match/state?trackId=——song_match 现行生效绑定的
  // 查询面（读侧模型键与匹配管线同口径：跨模型行/异模负行按未命中回）。
  // 客户端未绑定外源曲水合用：本地 neteaseId 缺席不代表服务端无正绑
  // （别会话/服务端侧写入不回推客户端持久化）——读口零云搜/AI 上行，
  // 与 /match/retry（skipCache 重跑+覆写）职责分离，改绑定只能走 retry。
  // 回 {id,name,ar,al,matchedBy,score}|null（match=null=无正绑/负缓存行）；
  // 错误照常抛——后台水合链自行 fail-soft，不在这里吞
  getMatchState: async (trackId, abortSignal = null) => {
    const response = await api.get('/match/state', { params: { trackId }, signal: abortSignal })
    const data = unwrapBody(response)
    // match:null 是合法未命中（code 200 下发）；业务码非 200 照常抛——
    // 水合链按错误通道分诊（429 释放槽位），不能归一成「无绑定」
    assertCode200(data, '匹配状态')
    return data.match ?? null
  },

  // 错配纠正口：POST /match/retry——前端拿持久化 provider 字段组匹配材料，
  // excludeIds 把当前判否的词源 id 并进请求级否决集重跑云搜+AI 复核链，
  // 命中即服务端覆写 song_match 行。回命中对象 {id,name,ar,al} 并透传同层
  // 诊断字段：matchedBy 是命中它的查询串、score 是置信分，调用方经 extras
  // 落 provider.matchedBy/matchScore 供纠错排查（score 为调用方实读字段，
  // matchScore 别名对齐 provider 侧命名）；未中回 null；错误（429/502 等）
  // 照常抛给调用方。最坏 ~55s，超时放宽到 60s
  // publishedAt（epoch ms，可选）：源媒体发布日回喂——服务端重建
  // sourceInfo 不回源重取；缺席/undefined 键不进 body，与旧负载逐位同
  retryMatch: async ({ trackId, title, author, artists, durationSec, candidates, excludeIds, publishedAt },
    abortSignal = null) => {
    const response = await api.post('/match/retry', {
      trackId, title, author, artists, durationSec, candidates, excludeIds, publishedAt
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
    assertCode200(data, '歌曲详情')
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
  bilibiliStreamUrl: (bvid, kind = 'audio', cid = null, page = 1, prefer = '', retry = 0) => {
    const params = new URLSearchParams({ bvid, kind })
    if (cid) params.set('cid', cid)
    if (page > 1) params.set('p', page)
    if (prefer) params.set('prefer', prefer)
    // 重试标记：旁路服务端流解析正缓存读（服务端仍照常写回治愈旧档），
    // 不是无意义地重放同一份死产物——与 youtubeStreamUrl 同口径
    if (retry > 0) params.set('retry', '1')
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

  // B 站曲库搜索（顶栏/点歌台 bili: 前缀）：{items}——items 是服务端
  // 已归一好的 buildBilibiliSong 直喂形。搜索走 SSR 数据岛，无续页
  // 游标无总数（total 恒 null——深挖键恒灭，与 ytContinuation 同理
  // 无消费面）。SSR HTML 页重（pinia 岛 ~115KB），超时给 30s；
  // all=1 放行服务端音乐分区过滤（默认只放行音乐分区桶）
  searchBiliSongs: async (q, { all = false, signal } = {}) => {
    const response = await api.get('/bilibili/search', {
      params: { q, ...(all ? { all: 1 } : {}) },
      signal, timeout: 30000,
    }).catch(err => {
      if (err?.response?.data?.message) throw resolveRethrow(err)
      throw err
    })
    const data = unwrapBody(response)
    if (data.code !== 200) throw new Error(data.message || 'B 站搜索失败')
    return { items: data.items || [] }
  },

  // B 站搜索建议（web-interface/suggest → 网易 search_suggest 归一形
  // {allMatch:[{keyword}]}）——groundwork:全局切源(P5)消费
  getBiliSuggest: async (term, abortSignal = null) => {
    const response = await api.get('/bilibili/suggest', {
      params: { term }, signal: abortSignal, timeout: 5000,
    }).catch(err => {
      if (err?.response?.data?.message) throw resolveRethrow(err)
      throw err
    })
    const data = unwrapBody(response)
    if (data.code !== 200) throw new Error(data.message || 'B 站搜索建议失败')
    return data.result || {}
  },

  // B 站相关视频（archive/related → buildBilibiliSong 直喂形）：{items}
  // groundwork:相关面板分派(P5)消费
  getBiliRelated: async (bvid, abortSignal = null) => {
    const response = await api.get('/bilibili/related', {
      params: { bvid }, signal: abortSignal, timeout: 15000,
    }).catch(err => {
      if (err?.response?.data?.message) throw resolveRethrow(err)
      throw err
    })
    const data = unwrapBody(response)
    if (data.code !== 200) throw new Error(data.message || 'B 站相关获取失败')
    return { items: data.items || [] }
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

  // YouTube 曲库搜索（顶栏 yt: 前缀 + 深挖游标）：{items,continuation}——
  // items 是服务端已剥洗好的 buildYouTubeSong 直喂形；continuation 是
  // 不透明上游翻页 token（深挖游标原样回传，null=见底）。YT 无总数——
  // 深挖亮灭走 ytContinuation 而非 searchSongTotal（QQ 的 total 口径不适用）
  searchYouTubeSongs: async (q, { limit = 20, continuation = null, signal } = {}) => {
    const response = await api.get('/youtube/search', {
      params: { q, limit, ...(continuation ? { continuation } : {}) },
      signal, timeout: 30000,
    }).catch(err => {
      if (err?.response?.data?.message) throw resolveRethrow(err)
      throw err
    })
    const data = unwrapBody(response)
    if (data.code !== 200) throw new Error(data.message || 'YouTube 搜索失败')
    return { items: data.items || [], continuation: data.continuation ?? null }
  },

  // YouTube 搜索建议（suggestqueries → 网易 search_suggest 归一形
  // {allMatch:[{keyword}]}）——groundwork:全局切源(P5)消费
  getYouTubeSuggest: async (q, abortSignal = null) => {
    const response = await api.get('/youtube/suggest', {
      params: { q }, signal: abortSignal, timeout: 5000,
    }).catch(err => {
      if (err?.response?.data?.message) throw resolveRethrow(err)
      throw err
    })
    const data = unwrapBody(response)
    if (data.code !== 200) throw new Error(data.message || 'YouTube 搜索建议失败')
    return data.result || {}
  },

  // YouTube 相关视频（/next secondaryResults → buildYouTubeSong 直喂形）：
  // {items,mixPlaylistId}——mix 是 YouTube Mix 自动生成单
  // groundwork:相关面板分派(P5)消费
  getYouTubeRelated: async (videoId, abortSignal = null) => {
    const response = await api.get('/youtube/related', {
      params: { v: videoId }, signal: abortSignal, timeout: 30000,
    }).catch(err => {
      if (err?.response?.data?.message) throw resolveRethrow(err)
      throw err
    })
    const data = unwrapBody(response)
    if (data.code !== 200) throw new Error(data.message || 'YouTube 相关获取失败')
    return { items: data.items || [], mixPlaylistId: data.mixPlaylistId ?? null }
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
  qqStreamUrl: (mid, prefer = '', mmid = '', retry = 0) => {
    const params = new URLSearchParams({ mid })
    if (mmid) params.set('mmid', mmid)
    if (prefer) params.set('prefer', prefer)
    // 重试标记：旁路服务端 vkey 正缓存读（照常写回治愈）——同 yt/bv 口径
    if (retry > 0) params.set('retry', '1')
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

  // QQ 曲库搜索（点歌台 qq: 前缀）：回 {songs,total}——total 是上游
  // totalnum 真值（挖不到归 null），前端深挖「加载更多」按它亮灭；
  // page 是页码游标（上游 p，1 起）不是 offset。三跳兜底最坏 ~45s，
  // 客户端上限给 30s——超时后服务端仍在跑但前端不再悬挂
  searchQQSongs: async (q, { limit = 20, page = 1, signal } = {}) => {
    const response = await api.get('/qq/search', {
      params: { q, p: page, limit }, signal, timeout: 30000,
    }).catch(err => {
      if (err?.response?.data?.message) throw resolveRethrow(err)
      throw err
    })
    const data = unwrapBody(response)
    if (data.code !== 200) throw new Error(data.message || 'QQ 音乐搜索失败')
    return { songs: data.list || [], total: data.total ?? null }
  },

  // QQ 搜索建议（smartbox → 网易 search_suggest 归一形）：
  // {allMatch:[{keyword}],songs,artists,albums}——与 searchSuggest 同消费面
  // groundwork:全局切源(P5)消费
  searchQQSuggest: async (key, abortSignal = null) => {
    const response = await api.get('/qq/suggest', {
      params: { key }, signal: abortSignal, timeout: 8000,
    }).catch(err => {
      if (err?.response?.data?.message) throw resolveRethrow(err)
      throw err
    })
    const data = unwrapBody(response)
    if (data.code !== 200) throw new Error(data.message || 'QQ 搜索建议失败')
    return data.result || {}
  },

  // QQ 热搜（gethotkey → 网易 search_hot 归一形）：[{first}]
  // groundwork:全局切源(P5)消费
  getQQHot: async (abortSignal = null) => {
    const response = await api.get('/qq/hot', { signal: abortSignal, timeout: 8000 })
      .catch(err => {
        if (err?.response?.data?.message) throw resolveRethrow(err)
        throw err
      })
    const data = unwrapBody(response)
    if (data.code !== 200) throw new Error(data.message || 'QQ 热搜获取失败')
    return data.result?.hots || []
  },

  // QQ 歌单搜索：归一 PlaylistGrid 卡（provider:'qq' + disstid——点卡
  // 走 /qq/playlist 导入链不是 getPlaylistDetail）；{playlists,total}
  searchQQPlaylists: async (q, { page = 1, limit = 20, signal } = {}) => {
    const response = await api.get('/qq/search-playlists', {
      params: { q, p: page, limit }, signal, timeout: 20000,
    }).catch(err => {
      if (err?.response?.data?.message) throw resolveRethrow(err)
      throw err
    })
    const data = unwrapBody(response)
    if (data.code !== 200) throw new Error(data.message || 'QQ 歌单搜索失败')
    return { playlists: data.playlists || [], total: data.total ?? null }
  },

  // QQ 相似曲：上游相似接口匿名全拒，服务端艺人搜索降级实装——
  // degraded=true 透出降级面（曲目元素与 searchQQSongs 同形）
  // groundwork:全局切源(P5)消费
  getQQSimilar: async (songmid, abortSignal = null) => {
    const response = await api.get('/qq/similar', {
      params: { songmid }, signal: abortSignal, timeout: 30000,
    }).catch(err => {
      if (err?.response?.data?.message) throw resolveRethrow(err)
      throw err
    })
    const data = unwrapBody(response)
    if (data.code !== 200) throw new Error(data.message || 'QQ 相似歌曲获取失败')
    return { songs: data.list || [], degraded: data.degraded === true }
  },

  // QQ 歌单详情（disstid → 归一曲目列表，导入本地歌单用）：
  // 服务端 200 条/页串行拉取上限 ~75s——客户端上限 90s 不早退
  getQQPlaylist: async (id) => {
    const response = await api.get('/qq/playlist', {
      params: { id }, timeout: 90000
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
// 大文件 blob 拉取没有进度可看——裸 fetch 悬挂会让「获取源文件」永远转圈，
// 给总量级超时兜底（服务端代理链/外网 CDN 慢死时 5min 足够判死）。
// TimeoutError 进错误通道与 axios ECONNABORTED 同族（isRetryable 不重试）
const BLOB_FETCH_TIMEOUT_MS = 5 * 60 * 1000

// prefer=best 在配了 DOWNLOAD_TOKEN+BILI_COOKIE 的部署要令牌——带上无妨，
// 未配令牌门的服务端会忽略它；头构造与 http.js 请求拦截器同一收口
async function saveStreamAsFile(url, fileName) {
  const resp = await fetch(url, {
    credentials: 'include', // 跨域部署（VITE_API_BASE_URL ≠ 页面源）也要带会话 cookie
    headers: downloadTokenHeaders(),
    signal: AbortSignal.timeout(BLOB_FETCH_TIMEOUT_MS)
  })
  if (!resp.ok) {
    // 服务端错误体是 {code,message}——「该视频没有可代理的音频流」这类
    // 具体原因上屏好过裸状态码。不带「下载失败:」前缀——toast 层固定补，防双显
    const msg = await resp.json().then(d => d?.message).catch(() => null)
    throw new Error(msg || `HTTP ${resp.status}`)
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

// LRC 解析/译文窗口合并的唯一真相源在 src/shared/lrc.js（服务端落盘
// 合并与词性核验同消费一份——播放与落盘词序/时序口径不再漂移）。
// 壳名保留：usePlayer 与既有测试以 parseLyrics/mergeTranslations 为契约
const getLrcOffsetSec = lrcOffsetSec
const parseLyrics = (lyricText, fallbackOffsetSec = null) =>
  lyricText ? parseLrc(lyricText, fallbackOffsetSec) : []
const mergeTranslations = mergeLrcTranslations

// 供 AI 译文回填复用——loadLyrics 拿到 tlyric 后与主歌词按时间窗合并
export { parseLyrics, mergeTranslations }

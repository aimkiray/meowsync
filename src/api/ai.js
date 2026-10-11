import http from './http.js'

// AI 辅助接口走写通道——共享 http 实例已带 DOWNLOAD_TOKEN 头
// （AI 调用消耗上游配额，属于需要门禁的写路径）。
// 响应由共享拦截器剥壳：下列方法直接回 JSON body {code,...}

// status 只缓存成功响应——瞬时失败（服务端重启/超时）不粘性禁用，
// 下次调用重试；200 的 enabled:false 是真实配置态，缓存到会话结束
let statusPromise = null

export const aiApi = {
  status: () => {
    if (!statusPromise) {
      statusPromise = http.get('/ai/status', { timeout: 8000 })
        .then(r => r || { enabled: false })
        .catch(() => { statusPromise = null; return { enabled: false } })
    }
    return statusPromise
  },

  // 设置页改完 AI 配置后失效会话缓存——否则 enabled 粘住旧判定直到刷新
  invalidateStatus: () => { statusPromise = null },

  // 生成/取回词源的中文译文 LRC（服务端缓存命中即回；官方译文存在则直回）
  // 歌词翻译是批量 AI 调用，整首最坏几分钟——给足 300s。
  // signal 预留给后续调用方：歌词加载路径刻意不传——切歌不该打断服务端
  // 翻译（完成后按词源落库缓存，下次播放直接命中）
  translateLyric: (id, signal = null) =>
    http.post('/ai/lyric-translate', { id }, { signal, timeout: 300000 }),

  // 核验配到的歌词是否属于来源音视频（外部导入曲专用）。trackId 携 yt_
  // 轨道 id 时服务端反解投稿自署本家作判定语境；publishedAt（epoch ms）
  // 是稿日倒挂判据的时间证据——只送有限正数，缺席/脏值键不进 body，
  // 与旧请求负载逐位相同。入参先归一成串：number 型 song.id 直发会被
  // zod z.string() 拒成 400 静默丢 verify——防御性收口
  verifyLyric: (id, sourceTitle, sourceAuthor, signal = null, trackId = null, publishedAt = null) =>
    // 服务端前置链（yt_ 声明反解 + 词文拉取 + 署名闸重检可各烧一条上游跳）
    // 之后才是 ≤30s 的 AI 判定——30s 前端超时会把仍在跑的合法核验掐成
    // 「通道故障放行」，给到 45s
    http.post('/ai/lyric-verify', {
      id, sourceTitle, sourceAuthor,
      trackId: String(trackId || '') || undefined,
      publishedAt: Number.isFinite(publishedAt) && publishedAt > 0 ? publishedAt : undefined
    }, { signal, timeout: 45000 })
}

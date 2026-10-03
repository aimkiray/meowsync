// 外部媒体（B 站/YouTube/QQ）曲目归一化构造器 + 单曲导入 spec 表。
// 从 App.vue 抽出的纯函数层——归一形态是跨边界契约（服务端 resolve 路由
// 与下载器共用同一口径），不锁在组件内。
//
// 三条不变量（各 builder 共同遵守）：
// 1. id 前缀隔离：bv_/yt_/qq_ 与网易云数值 id 不撞（谓词见 shared/predicates）
// 2. 演唱者/封面归真实上传者（导入的是「这个视频的演唱」），matched 网易云
//    数据只作缺省兜底 + neteaseId 词源
// 3. provider 块持久化播放所需的源凭据（bvid/cid/videoId/mid...）
import { httpsCover } from './url.js'
import { musicApi } from '../api/music.js'

// B 站导入曲对象：id 用 bv_ 前缀与网易云数值 id 隔离；歌曲名优先吃
// 网易云匹配（双语词源的正主），封面/演唱者归视频自己的（导入的是
// 「这个视频」——封面就该是视频封面，matched 只作缺省兜底）；
// bilibili 字段挂播放所需的源信息（bvid/cid/hasVideo），neteaseId 仅作歌词源
export const buildBilibiliSong = (data) => ({
  id: `bv_${data.bvid}${(data.page || 1) > 1 ? `_p${data.page}` : ''}`,
  name: data.matched?.name || data.songName || data.title,
  ar: data.owner ? [{ name: data.owner }] : (data.matched?.ar?.length ? data.matched.ar : [{ name: 'Bilibili' }]),
  al: {
    id: data.matched?.al?.id ?? null,
    name: data.matched?.al?.name || data.title,
    // hdslb 对无 Referer 放行（Referrer-Policy: no-referrer 经
    // index.html meta 随文档下发，不经 Hono 的部署也生效）；服务端下载
    // 封面经 fetchStream 不带 Referer 同口径。非 http(s) 的 cover 不入库
    picUrl: /^https?:\/\//i.test(String(data.cover || ''))
      ? (httpsCover(data.cover) || data.matched?.al?.picUrl || '')
      : (data.matched?.al?.picUrl || '')
  },
  dt: (data.duration || 0) * 1000,
  bilibili: {
    bvid: data.bvid, cid: data.cid, page: data.page || 1,
    hasVideo: !!data.hasVideo,
    // 下载口径独立于浏览器直放口径——纯非 avc1 稿件（4K 独占 hev1/av01）
    // 无在线流可放但下载链可合流进 mp4，入口不能跟着 hasVideo 一起灭
    hasDownloadableVideo: !!data.hasDownloadableVideo,
    title: data.title,
    // 封面持久化进 providerData——bv_ 封面不能由 bvid 推导（yt_ 可以），
    // 存量加载自愈/口径偏离修正都要靠它
    cover: data.cover || '',
    author: data.owner || '', matchedBy: data.matchedBy || null
  },
  neteaseId: data.matched?.id || null
})

// YouTube 导入曲对象：id 用 yt_ 前缀与 bv_/网易云数值隔离；youtube 字段
// 挂播放源（videoId/hasVideo），neteaseId 仍仅作歌词源。封面走 ytimg
// 视频缩略图优先（导入的是「这个视频」），matched 网易云封面作缺省兜底
export const buildYouTubeSong = (data) => ({
  id: `yt_${data.videoId}`,
  name: data.matched?.name || data.songName || data.title,
  // 演唱者归真实频道名（authorClean 已剥 ' - Topic'/'VEVO'）——不是匹配到
  // 的网易云艺人；频道名被整体剥光（如恰叫 'VEVO'）时退回匹配艺人再兜 'YouTube'
  ar: data.authorClean ? [{ name: data.authorClean }] : (data.matched?.ar?.length ? data.matched.ar : [{ name: 'YouTube' }]),
  al: {
    id: data.matched?.al?.id ?? null,
    name: data.matched?.al?.name || data.title,
    picUrl: /^https?:\/\//i.test(String(data.cover || ''))
      ? (httpsCover(data.cover) || data.matched?.al?.picUrl || '')
      : (data.matched?.al?.picUrl || '')
  },
  dt: (data.duration || 0) * 1000,
  youtube: {
    videoId: data.videoId, hasVideo: !!data.hasVideo,
    hasDownloadableVideo: !!data.hasDownloadableVideo,
    // authorClean 持久化：存量自愈/行内展示不必再剥 ' - Topic'/'VEVO'
    title: data.title, author: data.author, authorClean: data.authorClean || null,
    matchedBy: data.matchedBy || null
  },
  neteaseId: data.matched?.id || null
})

// QQ 导入曲对象：id 用 qq_<songmid> 前缀。与 bv/yt 的关键差异是 QQ 自带
// 真实元数据（name/artists/album/duration/cover 就是正主而非提取的噪声
// 标题）与权威双语歌词——matched 仅作封面退化兜底与 neteaseId 词源备胎
export const buildQQSong = (data) => ({
  id: `qq_${data.mid}`,
  name: data.name || data.matched?.name || '未知歌曲',
  ar: data.artists?.length
    ? data.artists.map(n => ({ name: n }))
    : (data.matched?.ar?.length ? data.matched.ar : [{ name: 'QQ 音乐' }]),
  al: {
    id: data.matched?.al?.id ?? null,
    name: data.album || data.matched?.al?.name || '',
    // QQ 封面（gtimg 无防盗链）优先于匹配封面——错配时脏封面的观感损失更大
    picUrl: httpsCover(data.cover || '') || data.matched?.al?.picUrl || ''
  },
  dt: (data.duration || 0) * 1000,
  qq: {
    mid: data.mid, mediaMid: data.mediaMid || data.mid,
    songId: data.songId, albummid: data.albummid || '',
    payPlay: !!data.payPlay, vipOnly: !!data.vipOnly,
    matchedBy: data.matchedBy || null
  },
  neteaseId: data.matched?.id || null
})

// 外部媒体导入共用骨架：B 站/YouTube/QQ 同一形态「resolve → 幂等壳 → 开播进
// watch」，差异只在解析端点/壳 id/显示名——收进 spec 防多份逻辑漂移
export const MEDIA_IMPORT_SPECS = {
  bilibili: {
    tag: 'B 站', icon: '📺',
    resolve: input => musicApi.resolveBilibili(input),
    build: buildBilibiliSong,
    shellIdOf: d => `single_song_bv_${d.bvid}${(d.page || 1) > 1 ? `_p${d.page}` : ''}`,
    shellNameOf: (song, d) => `B站导入 - ${song.name}${(d.page || 1) > 1 ? ` (P${d.page})` : ''}`,
    creator: 'B 站导入'
  },
  youtube: {
    tag: 'YouTube', icon: '▶️',
    resolve: input => musicApi.resolveYouTube(input),
    build: buildYouTubeSong,
    shellIdOf: d => `single_song_yt_${d.videoId}`,
    shellNameOf: song => `YouTube导入 - ${song.name}`,
    creator: 'YouTube 导入'
  },
  qq: {
    tag: 'QQ音乐', icon: '🐧',
    resolve: input => musicApi.resolveQQ(input),
    build: buildQQSong,
    shellIdOf: d => `single_song_qq_${d.mid}`,
    shellNameOf: song => `QQ音乐 - ${song.name}`,
    creator: 'QQ 导入'
  }
}

// 服务端 resolve 把输入解成了「播放单」而非单曲时，回填的引导字段：
// disstid → QQ 歌单、favlist → B 站收藏夹、playlist → YouTube 歌单。
// 前端两个消费点（单曲导入转跳 / 点歌台提示）共用此表——新增通道改一处
export const PLAYLIST_REDIRECT_FIELDS = [
  { key: 'disstid', label: 'QQ 歌单' },
  { key: 'favlist', label: 'B 站收藏夹' },
  { key: 'playlist', label: 'YouTube 歌单' },
]

// resolve 重抛的 Error 经 .data 保字段，裸 axios 错走 .response.data——
// 双口径归一，调用处不再手写两遍
export const redirectDataOf = (error) => error?.data || error?.response?.data || null

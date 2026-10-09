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
import { externalCoverUrl } from './song.js'
import { musicApi } from '../api/music.js'

// ── 艺人重合闸（builder 与 applyMatchResult 共用）──
// 词源绑定宽松 / 展示身份保守：matched 网易云数据的核心职责是给外源曲
// 嫁接歌词源（neteaseId）——同名 cover/翻唱借了别家词源无伤大雅（错词
// 有 verify→rematch 判否链兜底），但把别家专辑名/封面挂到展示位是元信息
// 污染：错配会把「同名异曲」的专辑烘进曲对象，slimTrack 持久化后删单
// 重下都洗不掉。故 matched.al 身份字段（id/name/picUrl）只在「匹配艺人
// ∩ 真实上传者」非空时采纳，不重合按无匹配 provider 态展示。
// 闸输入只认 provider 侧原始字段（author/authorClean/owner/artists），
// 不读 song.ar——无上传者信息时 ar 的兜底值就是 matched.ar，拿它判
// 重合是循环论证恒真
const normArtistName = (v) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ')

const artistsOverlap = (matchedAr, sourceNames) => {
  const src = new Set((sourceNames || []).map(normArtistName).filter(Boolean))
  if (!src.size || !Array.isArray(matchedAr)) return false
  return matchedAr.some(a =>
    src.has(normArtistName(a && typeof a === 'object' ? a.name : a)))
}

// 封面归一（构造与修复同一口径）：provider 封面优先——导入的是「这个
// 视频」，封面就该是视频封面（hdslb 对无 Referer 放行：Referrer-Policy:
// no-referrer 经 index.html meta 随文档下发，不经 Hono 的部署也生效；
// 服务端下载封面经 fetchStream 不带 Referer 同口径）。provider 封面缺失
// 时才吃 matched.al.picUrl，且同样受艺人重合闸——错配的封面也是脏展示。
// 非 http(s) 的 cover 串不入库
const pickAlbumCover = (providerCover, matchedPicUrl, overlap) =>
  /^https?:\/\//i.test(String(providerCover || ''))
    ? (httpsCover(providerCover) || (overlap ? matchedPicUrl || '' : ''))
    : (overlap ? (matchedPicUrl || '') : '')

// 专辑身份重建：id+name+picUrl 是一组绑死的展示身份——艺人重合才整组吃
// matched.al（吃了 name 却留别家 al.id 是更隐蔽的脏数据）；否则回
// provider 态（name=provider 原标题兜底，封面走 provider 链）。
// pic_str 是上游专辑对象的图链双生字段（local-mirror.js 读 al.picUrl ||
// pic_str 当封面、download-manager 同口径兜底）——applyMatchResult 走
// {...oldAl, ...rebuilt} 合入，不显式给值会让旧匹配烘进的 pic_str 在
// 「不重合洗白」后仍残留。无重合不采匹配专辑图链任何字段；重合时 matched
// 侧双生字段同闸采纳（picUrl 空壳专辑靠它兜底封面）
const buildAlbum = ({ overlap, matchedAl, titleFallback, providerCover }) => ({
  id: overlap ? (matchedAl?.id ?? null) : null,
  name: (overlap ? matchedAl?.name : null) || titleFallback || '',
  picUrl: pickAlbumCover(providerCover, matchedAl?.picUrl, overlap),
  pic_str: overlap ? (matchedAl?.pic_str ?? null) : null,
})

// B 站导入曲对象：id 用 bv_ 前缀与网易云数值 id 隔离；演唱者/封面/展示名
// 归视频自己的（导入的是「这个视频」），matched 只在艺人重合时进展示位、
// 否则作缺省兜底；bilibili 字段挂播放所需的源信息（bvid/cid/hasVideo），
// neteaseId 仅作歌词源
export const buildBilibiliSong = (data) => {
  // 展示名与专辑身份同一道闸（与 applyMatchResult 同构——重叠源数组
  // 一处算两处用，防 name/al 判面漂移）：owner ∩ matched.ar 为空时
  // name 回提取名/原标题、al 回 title/cover 链——词源照借（宽松侧），
  // 同名异曲的曲名/专辑/封面不烘进曲对象（保守侧）
  const overlap = artistsOverlap(data.matched?.ar, [data.owner])
  return {
    id: `bv_${data.bvid}${(data.page || 1) > 1 ? `_p${data.page}` : ''}`,
    name: (overlap ? data.matched?.name : null) || data.songName || data.title,
    ar: data.owner ? [{ name: data.owner }] : (data.matched?.ar?.length ? data.matched.ar : [{ name: 'Bilibili' }]),
    al: buildAlbum({
      overlap,
      matchedAl: data.matched?.al,
      titleFallback: data.title, providerCover: data.cover,
    }),
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
      author: data.owner || '', matchedBy: data.matchedBy || null,
      // 匹配分透传（诊断用——/match/retry 纠错与排查错配时要看证据强弱）
      matchScore: data.matchScore ?? null
    },
    neteaseId: data.matched?.id || null
  }
}

// YouTube 导入曲对象：id 用 yt_ 前缀与 bv_/网易云数值隔离；youtube 字段
// 挂播放源（videoId/hasVideo），neteaseId 仍仅作歌词源。封面走 ytimg
// 视频缩略图优先（导入的是「这个视频」），matched 网易云封面作缺省兜底
export const buildYouTubeSong = (data) => {
  // 展示名与专辑身份同一道闸（与 buildBilibiliSong 同口径，重叠源数组
  // 一处算两处用）：频道名/净名 ∩ matched.ar 为空时 name 回提取名/
  // 原标题、al 回 title/cover 链——同名异曲错配的展示身份不烘进曲对象
  const overlap = artistsOverlap(data.matched?.ar, [data.author, data.authorClean])
  return {
    id: `yt_${data.videoId}`,
    name: (overlap ? data.matched?.name : null) || data.songName || data.title,
    // 演唱者归真实频道名（authorClean 已剥 ' - Topic'/'VEVO'）——不是匹配到
    // 的网易云艺人；频道名被整体剥光（如恰叫 'VEVO'）时退回匹配艺人再兜 'YouTube'
    ar: data.authorClean ? [{ name: data.authorClean }] : (data.matched?.ar?.length ? data.matched.ar : [{ name: 'YouTube' }]),
    al: buildAlbum({
      overlap,
      matchedAl: data.matched?.al,
      titleFallback: data.title, providerCover: data.cover,
    }),
    dt: (data.duration || 0) * 1000,
    youtube: {
      videoId: data.videoId, hasVideo: !!data.hasVideo,
      hasDownloadableVideo: !!data.hasDownloadableVideo,
      // authorClean 持久化：存量自愈/行内展示不必再剥 ' - Topic'/'VEVO'
      title: data.title, author: data.author, authorClean: data.authorClean || null,
      matchedBy: data.matchedBy || null,
      matchScore: data.matchScore ?? null
    },
    neteaseId: data.matched?.id || null
  }
}

// QQ 导入曲对象：id 用 qq_<songmid> 前缀。与 bv/yt 的关键差异是 QQ 自带
// 真实元数据（name/artists/album/duration/cover 就是正主而非提取的噪声
// 标题）与权威双语歌词——matched 仅作封面退化兜底与 neteaseId 词源备胎
export const buildQQSong = (data) => ({
  id: `qq_${data.mid}`,
  name: data.name || data.matched?.name || '未知歌曲',
  ar: data.artists?.length
    ? data.artists.map(n => ({ name: n }))
    : (data.matched?.ar?.length ? data.matched.ar : [{ name: 'QQ 音乐' }]),
  // QQ 专辑名/封面 provider 优先——matched 字段只是兜底，但兜底同样过
  // 艺人重合闸（与 bv_/yt_ 构造器同口径）：闸不过时连 al.id 也不放行——
  // 展示的是 QQ 专辑名却挂着别家专辑 id 是更隐蔽的脏数据
  al: (() => {
    const overlap = artistsOverlap(data.matched?.ar, data.artists)
    return {
      id: overlap ? (data.matched?.al?.id ?? null) : null,
      name: data.album || (overlap ? data.matched?.al?.name || '' : ''),
      picUrl: pickAlbumCover(data.cover, data.matched?.al?.picUrl, overlap),
    }
  })(),
  dt: (data.duration || 0) * 1000,
  qq: {
    mid: data.mid, mediaMid: data.mediaMid || data.mid,
    songId: data.songId, albummid: data.albummid || '',
    payPlay: !!data.payPlay, vipOnly: !!data.vipOnly,
    matchedBy: data.matchedBy || null,
    matchScore: data.matchScore ?? null
  },
  neteaseId: data.matched?.id || null
})

// 重匹配修复器：/match/retry 回包落进既有曲对象的唯一收口——菜单显式
// 纠错与 verify 判否自动换绑共用同一口径，防「只换 neteaseId 留下错配
// 专辑名/封面」的元信息残留（slimTrack 把 al/neteaseId/provider 块全量
// 持久化——残留进了 localStorage 删单重下都洗不掉）。
//
// 口径与构造期同构（builder 同款优先级重建派生字段，幂等）：
// - 词源绑定宽松：neteaseId 恒按本次结果覆写（matched=null 即解绑）——
//   词源只是嫁接物，错了判否链还能再纠
// - 展示身份保守：song.name/al 只在「匹配艺人 ∩ 上传者」重合时吃
//   matched.name/matched.al（翻唱曲绑别家词源可以，把别家曲名/专辑挂上
//   展示位不行）；不重合/解绑回 provider 原标题；ar 不动——真实上传者
//   本就是对的
// - matched=null（显式纠错后无替代）：解绑——name/al/匹配证据全回
//   provider 态。用户显式说「这不是」，留错绑不如没绑
// - qq_ 曲的 name/ar/al 是 QQ 自带权威元数据（builder 即 provider
//   优先）：只换词源与证据，展示身份不动
// - custom 位（用户显式编辑过的曲）同样只换词源：修复不覆盖用户意图
//   （与 healExternalAr 的停手口径一致）
// 就地改写返回 song；对缺字段防御（al 缺对象/provider 块缺字段均不炸）
export const applyMatchResult = (song, matched, extras = {}) => {
  if (!song || typeof song !== 'object') return song
  const yt = song.youtube || null
  const bv = song.bilibili || null
  const qq = song.qq || null

  // 词源绑定（宽松侧）：恒按本次结果覆写；matched=null 即显式解绑
  song.neteaseId = matched?.id ?? null
  // 匹配证据随绑定走：retryMatch 回包已透传同层诊断字段（matchedBy/
  // score，调用方经 extras 捎入）——缺省置 null，没证据清掉比残留旧的诚实
  const prov = yt || bv || qq
  if (prov) {
    prov.matchedBy = extras.matchedBy ?? null
    prov.matchScore = extras.matchScore ?? null
  }
  // qq 权威元数据与用户改过的曲：展示身份都不动（见头注）
  if (qq || song.custom) return song

  const provTitle = yt?.title || bv?.title || ''
  const overlap = artistsOverlap(matched?.ar, [yt?.author, yt?.authorClean, bv?.author])
  // name 与 al 同一道闸：翻唱借词源（艺人不重合）不改展示身份——历史
  // 脏名（旧错配烘进 raw_json 的 matched.name）经本闸自愈回 provider；
  // 解绑/无名匹配同回落。裸 id 行（无 provider 块）provTitle 空则
  // name 不动——无原料不治（已知残面）
  if (overlap && matched?.name) song.name = matched.name
  else if (provTitle) song.name = provTitle

  // al 可能是缺失/非对象形态（旧持久化行/上游简化对象）——重建而非修补
  const rebuilt = buildAlbum({
    overlap, matchedAl: matched?.al,
    titleFallback: provTitle,
    // yt_ 封面由 videoId 推导、bv_ 吃持久化 cover——与 externalCoverUrl/
    // 构造期同一条 provider 封面链，不靠残留 al.picUrl 猜
    providerCover: externalCoverUrl(song) || '',
  })
  song.al = { ...(song.al && typeof song.al === 'object' ? song.al : {}), ...rebuilt }
  return song
}

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

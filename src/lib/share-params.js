// 分享链 URL 参数的单一解析点。
// 此前七个 getXxxFromUrl 各自 new URLSearchParams 一趟 + 手写正则校验，
// 现在一趟解析返回全字段——消费端（onMounted 引导编排）按序取用。
//
// 契约：返回 null/[] 表示「该参数不存在或不合法」，null 形态绝不进导入链。
import { extractBiliFavlistId, extractYouTubePlaylistId, SONGMID_RE } from './url.js'

// 一次性消费的消费键表——与下方 readShareParams 的产出字段对应（playlist/playlists
// 合并到 playlistIds 一槽；p 是 ?bili= 的分 P 伴生参）
const SHARE_PARAM_KEYS = ['song', 'playlist', 'playlists', 'bili', 'yt', 'qq', 'qqpl', 'p', 'mix']

// 从 URL 一次读齐所有分享参数。
// 返回 { playlistIds:[], songId, bili, yt, qq, qqpl, mix } ——字段语义：
// - playlistIds：?playlist=N / ?playlists=N,M 网易云歌单 id 数组（逗号或竖线分隔）
// - songId：?song=N 网易云单曲 id
// - bili：?bili= 原文（BV/av/收藏夹 URL/mlN 都放行，分 P 拼回 input 串）
// - yt：?yt= 原文或 `?yt=<id>` 还原形态（失败重进搜索框仍命中 isYouTubeInput）
// - qq：?qq= 还原形态（同口径）
// - qqpl：?qqpl=N QQ 歌单 disstid
// - mix：?mix=name~ids 原文（~ 内含名字的解析留给 importMixPlaylist）
export function readShareParams() {
  const urlParams = new URLSearchParams(window.location.search)

  // ?playlist=123 单歌单 / ?playlists=123,456|789 多歌单——逗号竖线同义
  const playlistParam = urlParams.get('playlists') || urlParams.get('playlist')
  const playlistIds = playlistParam
    ? playlistParam.split(/[,|]/).map(id => id.trim()).filter(id => /^\d+$/.test(id))
    : []

  const songParam = urlParams.get('song')
  const songId = songParam && /^\d+$/.test(songParam.trim()) ? songParam.trim() : null

  // ?bili=BVxxx 分享链；收藏夹 URL/mlN 也放行（下游 importBilibiliOrFav
  // 自己分单曲/收藏夹——?bili=favlistURL 是收藏夹的按引用分享通道）
  let bili = null
  const biliRaw = urlParams.get('bili')?.trim()
  if (biliRaw) {
    if (extractBiliFavlistId(biliRaw)) {
      bili = biliRaw
    } else if (/^(BV[0-9A-Za-z]{10}|av\d+)$/i.test(biliRaw)) {
      // 分P分享链 ?bili=BV&p=N——拼回 input 串让服务端 pickPageParam 接住
      const p = /^\d+$/.test(urlParams.get('p') || '') ? Number(urlParams.get('p')) : 0
      bili = p > 1 ? `${biliRaw}?p=${p}` : biliRaw
    }
  }

  // ?yt=<videoId> 分享链；歌单 URL/listId 也放行（?yt= 是歌单的按引用分享通道）
  let yt = null
  const ytRaw = urlParams.get('yt')?.trim()
  if (ytRaw) {
    if (extractYouTubePlaylistId(ytRaw)) {
      yt = ytRaw
    } else if (/^[A-Za-z0-9_-]{11}$/.test(ytRaw)) {
      // 传 ?yt= 形态而非裸 id：服务端 [?&]yt= 分支无 \D 要求（全数字 videoId
      // 也可解），且 resolve 失败还原进搜索框后仍是 isYouTubeInput 形态——
      // 回车重试不会退化关键词搜索（isYouTubeInput 收窄后裸 id 不再命中）。
      // id 过 encodeURIComponent 与生成侧 share.js 同口径（合法字符集下是
      // 恒等映射——校验口径放宽时重建串不带裸特殊字符）
      yt = `?yt=${encodeURIComponent(ytRaw)}`
    }
  }

  // ?qq=<songmid> 分享链——同 ?yt= 口径：传 ?qq= 形态让失败还原后仍命中
  // isQQInput 可回车重试；id 编码与生成侧 share.js 同口径
  let qq = null
  const qqRaw = urlParams.get('qq')
  if (qqRaw && SONGMID_RE.test(qqRaw.trim())) qq = `?qq=${encodeURIComponent(qqRaw.trim())}`

  // ?qqpl=<disstid> QQ 歌单按引用分享链——接收端整单重拉
  const qqplRaw = urlParams.get('qqpl')?.trim()
  const qqpl = /^\d+$/.test(qqplRaw || '') ? qqplRaw : null

  // ?mix=<name>~id1,id2,... 本地歌单内容携带链（~ 分隔名/载荷，名里可再含 ~）
  const mixRaw = urlParams.get('mix')
  const mix = mixRaw && mixRaw.includes('~') ? mixRaw : null

  return { playlistIds, songId, bili, yt, qq, qqpl, mix }
}

// 消费掉一次性 URL 参数：不清理的话每次刷新都会重新劫持恢复逻辑
// （?song= 会永久抢占 restorePlaybackState；?playlists= 会重复尝试导入）
export function consumeUrlShareParams() {
  const url = new URL(window.location.href)
  let changed = false
  for (const key of SHARE_PARAM_KEYS) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key)
      changed = true
    }
  }
  if (changed) window.history.replaceState(null, '', url.toString())
}

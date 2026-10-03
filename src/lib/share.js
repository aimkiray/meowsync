import { isLocalPlaylistId, isResolvableTrackId, parseProviderShellId } from './url.js'

/** 复制文本到剪贴板：Clipboard API → textarea+execCommand 降级。返回是否成功。 */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // 降级方案（非安全上下文 / 旧浏览器）
    const textArea = document.createElement('textarea')
    textArea.value = text
    textArea.setAttribute('readonly', '') // 避免 iOS 聚焦时弹出键盘
    textArea.style.position = 'fixed'
    textArea.style.opacity = '0'
    document.body.appendChild(textArea)
    try {
      textArea.select()
      // iOS Safari 需要显式选区，execCommand 才有内容可复制
      textArea.setSelectionRange(0, textArea.value.length)
      // execCommand 返回 false 代表复制失败，不能再当成功上报
      return document.execCommand('copy')
    } catch {
      return false
    } finally {
      // 放在 finally：select/execCommand 抛错时不能把 textarea 遗留在 DOM 里
      textArea.remove()
    }
  }
}

/**
 * 单曲分享链：B 站导入曲走 ?bili=BV（分P带 p）、YouTube 走 ?yt=<videoId>、
 * QQ 走 ?qq=<mid>——?song= 只认网易云数值 id；带 view=watch 冷启动直达播放页。
 * 参数名是跨边界契约——消费端在 lib/share-params.js:readShareParams
 */
export function songShareUrl(song) {
  const origin = window.location.origin
  if (song?.bilibili?.bvid) {
    return `${origin}/?bili=${song.bilibili.bvid}${song.bilibili.page > 1 ? `&p=${song.bilibili.page}` : ''}&view=watch`
  }
  if (song?.youtube?.videoId) return `${origin}/?yt=${song.youtube.videoId}&view=watch`
  if (song?.qq?.mid) return `${origin}/?qq=${song.qq.mid}&view=watch`
  return `${origin}/?song=${song?.id}&view=watch`
}

// 本地单无远端 id——?mix=<name>~<ids> 内容携带链，接收端按 id 重解析。
// 按字节而非条数切：bv_ id ~24B/yt_ ~14B，300 条全 bv_ 会到 7KB 触 nginx 414 边缘
const MIX_ID_CAP = 300
const MIX_IDS_BUDGET = 3000

// mix 链的曲目 id 挑选：只收「接收端可解析」形态（与导入侧 isResolvableTrackId
// 同口径），条数与字节双上限
export function mixShareIds(playlist) {
  const ids = []
  let budget = MIX_IDS_BUDGET
  for (const t of playlist.tracks || []) {
    const id = String(t.id)
    if (!isResolvableTrackId(id)) continue
    if (ids.length >= MIX_ID_CAP || id.length + 1 > budget) break
    budget -= id.length + 1
    ids.push(id)
  }
  return ids
}

// 歌单分享链：远端单带 view=songs&pl= 直达歌曲页；外部导入壳按引用分享
// （?yt=/?bili=/?qqpl= 接收端整单重拉，绕开 ?mix= 逐曲 resolve 上限）；
// 其余本地单退 ?mix= 内容携带链
export function playlistShareUrl(playlist) {
  const origin = window.location.origin
  if (!isLocalPlaylistId(playlist?.id)) {
    return `${origin}/?playlist=${playlist.id}&view=songs&pl=${playlist.id}`
  }
  const shell = parseProviderShellId(playlist.id)
  if (shell?.source === 'yt') {
    return `${origin}/?yt=${encodeURIComponent(`https://www.youtube.com/playlist?list=${shell.key}`)}`
  }
  if (shell?.source === 'bili') {
    return `${origin}/?bili=${encodeURIComponent(`https://www.bilibili.com/list/ml${shell.key}`)}`
  }
  if (shell?.source === 'qq') return `${origin}/?qqpl=${shell.key}`
  return `${origin}/?mix=${encodeURIComponent(String(playlist.name || '歌单'))}~${mixShareIds(playlist).join(',')}`
}

// ?mix= 链空载荷判定：ids 全部不可解析时 URL 以 ~ 收尾——分享侧据此拦截提示
export function isEmptyMixShareUrl(url) {
  return /[?&]mix=/.test(url) && url.endsWith('~')
}

/**
 * 分享：Web Share API → 复制链接降级。
 * @returns {'shared'|'copied'|'cancelled'|'failed'}
 */
export async function shareOrCopy({ title, text, url }) {
  if (navigator.share) {
    try {
      await navigator.share({ title, text, url })
      return 'shared'
    } catch (err) {
      // 用户主动取消不算失败，也不再降级复制
      if (err?.name === 'AbortError') return 'cancelled'
      // 其余错误（如不支持的内容）继续走复制降级
    }
  }
  // url 为空时复制 text，避免把 "undefined" 写进剪贴板
  return (await copyText(url || text || '')) ? 'copied' : 'failed'
}

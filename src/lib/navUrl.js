// URL 导航寻址的纯函数核：useSearchNav 的 build/apply 语义抽到这里可测。
// 规则单点收口——view 词表、pl 归属分账（songs=歌单地址栏态 /
// downloads=深链预选意图，同一参数位按视图分账）、本地态 id 不落 URL
import { isLocalPlaylistId } from './url.js'

export const NAV_VIEWS = new Set(['home', 'songs', 'search', 'watch', 'downloads'])

// 在既有 query 上重写 view/pl——其余参数（mode/mix/playlist 等）原样保留。
// songs 的 pl 只在可寻址时写：本地内存态歌单（single_song_/saved_queue_/
// local_pl_*）id 非数字、刷新无法按歌单恢复，写进 URL 是死链。
// downloads 的 pl 是预选意图而非歌单态——独立于 songs 分支保留
export function writeNavParams(params, { view, songsPl = null, downloadsPl = null } = {}) {
  params.delete('view')
  params.delete('pl')
  if (view) params.set('view', view)
  if (view === 'songs' && songsPl != null && !isLocalPlaylistId(songsPl)) {
    params.set('pl', String(songsPl))
  }
  if (view === 'downloads' && downloadsPl != null) {
    params.set('pl', String(downloadsPl))
  }
  return params
}

// 读侧：view 过词表闸（非法/缺省归 null 交给兜底阶梯），pl 原样透传
export function readNavParams(params) {
  const view = params.get('view')
  return {
    view: view && NAV_VIEWS.has(view) ? view : null,
    pl: params.get('pl')
  }
}

// applyUrlNav 的兜底阶梯（纯函数面）：search 无结果回落 home、watch 无曲
// 回落 songs/home。songs 分支的歌单回选/id 预览属副作用，留在 composable
export function resolveNavView({
  view,
  hasSelectedPlaylist = false,
  hasSong = false,
  hasSearchResults = false,
  searching = false
} = {}) {
  if (!view) return 'home'
  if (view === 'search' && !hasSearchResults && !searching) return 'home'
  if (view === 'watch' && !hasSong) return hasSelectedPlaylist ? 'songs' : 'home'
  return view
}

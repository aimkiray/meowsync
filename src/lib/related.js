// 相关曲分派共享层：WatchView 相关面板与 usePlayer 队列耗尽接续共用同一
// 口径——判源/缺料早退/种曲剔除三处语义同源，两处各写一份必漂移。
// 叶模块定位：纯函数 + musicApi/builders，不引组件/composable/同步引擎
import { musicApi } from '../api/music.js'
import { BV_TRACK_ID_RE, YT_TRACK_ID_RE, QQ_SONG_ID_RE } from './url.js'
import { buildBilibiliSong, buildYouTubeSong, buildQQSong, QQ_ARTIST_FALLBACK } from './external-songs.js'

// 判源：曲目 id 前缀定源——provider 块在场与否不改源归属（缺 provider 块的
// 老持久化行只剩前缀 id，内嵌凭据是唯一真理，与 usePlayer bvM/ytM 解形、
// songSourceUrl 的「provider 块优先、id 解形兜底」同惯例）
export const relatedSourceOf = (song) => {
  const id = String(song?.id ?? '')
  if (BV_TRACK_ID_RE.test(id)) return 'bili'
  if (YT_TRACK_ID_RE.test(id)) return 'yt'
  if (QQ_SONG_ID_RE.test(id)) return 'qq'
  return 'netease'
}

const firstArtistOf = (song) => (song?.ar || song?.artists || [])[0]?.name

// 相关拉取：返回 { source, items }；缺料返回 null = 该曲无相关面——
// bv_/yt_ 解不出源凭据（id 即凭据，理论不可达但兜脏数据）、qq_/数值曲
// 无首艺人、QQ 侧哨兵艺人。调用方按空集刊出且不回落错源（bv_ 曲拿 UP
// 主名搜网易云曲库得到的是假相关）。
// 种曲剔除收在本层：上游相似接口可能把种曲本体混进结果——bv 按解出
// bvid 比对（种曲 bv_X_p2 多P形态的回包常带 bv_X P1 本体，整 id 比对
// 会漏），yt 按 videoId，qq/netease 按整 id
export const relatedFetch = async (song) => {
  if (song?.id == null) return null
  const seedId = String(song.id)
  const source = relatedSourceOf(song)
  if (source === 'bili') {
    const bvid = song.bilibili?.bvid || BV_TRACK_ID_RE.exec(seedId)?.[1]
    if (!bvid) return null
    const r = await musicApi.getBiliRelated(bvid)
    return {
      source,
      items: (r?.items || []).map(buildBilibiliSong)
        .filter(s => s?.id != null && s.bilibili?.bvid !== bvid),
    }
  }
  if (source === 'yt') {
    const videoId = song.youtube?.videoId || YT_TRACK_ID_RE.exec(seedId)?.[1]
    if (!videoId) return null
    const r = await musicApi.getYouTubeRelated(videoId)
    return {
      source,
      items: (r?.items || []).map(buildYouTubeSong)
        .filter(s => s?.id != null && s.youtube?.videoId !== videoId),
    }
  }
  const artist = firstArtistOf(song)
  // qq_ 上游相似匿名全拒 → 按首艺人搜 QQ 曲库（服务端降级口径的前端对应面）；
  // 其余（网易云数值/file_）照旧网易云艺人搜索。buildQQSong 的无艺人兜底
  // 哨兵（QQ_ARTIST_FALLBACK）拿去做搜索词必返垃圾——同字面量判拒
  if (!artist || (source === 'qq' && artist === QQ_ARTIST_FALLBACK)) return null
  const items = source === 'qq'
    ? ((await musicApi.searchQQSongs(artist, { limit: 15, page: 1 }))?.songs || []).map(buildQQSong)
    : await musicApi.searchSongs(artist, 15)
  return {
    source,
    items: (items || []).filter(s => s?.id != null && String(s.id) !== seedId),
  }
}

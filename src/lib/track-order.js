// 曲序归并与歌手聚类的纯函数域——SongList 排序模式与 usePlaylistLibrary
// 持久化共用。无 DOM/Vue 依赖，node:test 可直接断言。
//
// 序的双系存储（与墓碑/追加/override 同构的客户端覆盖层模型）：
//   远端单——trackOrder 有序 id 表，持久化在歌单库对象上：成员归属仍归
//     远端（同步增删由远端裁决），只有「顺序」这层归本地；
//   本地单——tracks 数组本身就是序，直接整列重排，不写覆盖层
//     （镜像上传按此序落服务端 position，下载队列天然跟随）。

/**
 * 覆盖层归并：登记在 order 里的成员按登记序排前，未登记成员保持原相对序
 * 追加在尾——远端同步的新曲/appendSongToLibraryPlaylist 的追加曲不在表里，
 * 自然落尾与用户预期一致；order 里的陈旧 id（墓碑/已删）在列表侧不命中，
 * 保留不摘——墓碑恢复时曲目回到原位（镜像墓碑语义）。
 * 重复 id 以首登记位为准；order 为空/非数组原样返回同一引用。
 */
export function applyTrackOrder(list, order) {
  if (!Array.isArray(list) || !Array.isArray(order) || order.length === 0) return list
  const pos = new Map()
  order.forEach((id, i) => {
    const k = String(id)
    if (!pos.has(k)) pos.set(k, i)
  })
  const listed = []
  const unlisted = []
  list.forEach(t => {
    const p = pos.get(String(t?.id))
    if (p === undefined) unlisted.push(t)
    else listed.push({ t, p })
  })
  listed.sort((a, b) => a.p - b.p)
  return [...listed.map(e => e.t), ...unlisted]
}

// 双桶 collator：zh 拼音序对拉丁/汉字的相对排布随 ICU 版本漂移（实测拉丁沉尾），
// 拆桶显式定序——首字符 ASCII 的键走拉丁组先行（数字<字母），其余走拼音组。
// 组内 numeric:true 数值序、sensitivity:base 大小写/声调不敏感
const PINYIN_COLLATOR = new Intl.Collator('zh-Hans-u-co-pinyin', {
  numeric: true, sensitivity: 'base'
})
const LATIN_COLLATOR = new Intl.Collator('en', {
  numeric: true, sensitivity: 'base'
})
const isLatinKey = (k) => /^[\x00-\x7F]/.test(k)

/**
 * 聚类键＝主唱口径：ar/artists 第一艺人名。
 * 「相同作者放一起」按第一署名归拢——featuring 曲（'A / B' 并列）落主唱组
 * 而非自成孤岛；用户编辑过艺人的曲（applyTrackOverrides 写 ar[0]）按其
 * 口径聚类；外链导入曲的 ar[0] 是 UP主/频道名（healExternalAr 口径），
 * 同 UP 主的稿自然聚拢。
 */
export function trackArtistGroupKey(song) {
  const list = song?.ar || song?.artists
  const name = Array.isArray(list) ? list[0]?.name : null
  return String(name ?? '').trim()
}

/**
 * 按主唱名归拢：组间按 collator 序，组内保持既有相对序（Array.sort 稳定——
 * 不打散用户在组内已手调过的顺序）。无名艺人的曲目整体沉尾而非置顶。
 */
export function groupTracksByArtist(list) {
  if (!Array.isArray(list)) return []
  return [...list].sort((a, b) => {
    const ka = trackArtistGroupKey(a)
    const kb = trackArtistGroupKey(b)
    if (!ka && !kb) return 0
    if (!ka) return 1
    if (!kb) return -1
    const la = isLatinKey(ka)
    const lb = isLatinKey(kb)
    if (la !== lb) return la ? -1 : 1
    return (la ? LATIN_COLLATOR : PINYIN_COLLATOR).compare(ka, kb)
  })
}

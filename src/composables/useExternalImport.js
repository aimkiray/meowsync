import { musicApi } from '../api/music'
import { downloadsApi } from '../api/downloads'
import { toast, toastDismiss } from '../lib/feedback'
import {
  httpsCover, extractBiliFavlistId, extractYouTubePlaylistId,
  isSingleSongShellId, providerPlaylistShellId, isResolvableTrackId,
  QQ_SONG_ID_RE, BV_TRACK_ID_RE, YT_TRACK_ID_RE,
} from '../lib/url'
import {
  buildBilibiliSong, buildYouTubeSong, buildQQSong,
  MEDIA_IMPORT_SPECS, redirectDataOf,
} from '../lib/external-songs'

const MIX_IMPORT_CAP = 300   // 与生成侧 playlistShareUrl 的截断对齐
const MIX_RESOLVE_CAP = 10   // bv_/yt_ 逐项 resolve——客户端预算共桶（服务端两端点各 12/min 分桶）
const MIX_SHELL_CAP = 20     // mix 壳是分享导入快照，封顶个数防长期累积撞配额
const SINGLE_SHELL_CAP = 10  // single_song_ 单曲分享壳同上

// 外部导入域：单曲 resolve 导入 + 三源整单导入 + mix 内容分享导入 + 网易云单曲壳。
//
// deps（App 注入的跨域共享）：
//   gates.mediaImport / gates.select — 互作废闸（选单顶掉在途导入，导入反向占住选单）
//   userPlaylists / selectedPlaylist / songs / loadingSongs / savePlaylistsToStorage — 库域
//   searchQuery / currentSong — 顶栏输入与播放器域
//   playSong / enterWatch / selectPlaylistAndShow — App 侧播放器与导航动作
export function useExternalImport({
  gates,
  userPlaylists, selectedPlaylist, songs, loadingSongs, savePlaylistsToStorage,
  searchQuery, currentSong,
  playSong, enterWatch, selectPlaylistAndShow,
}) {

  // 单曲分享壳统一容量剪枝：倒序 splice 防下标错位
  const pruneSingleSongShells = () => {
    const tempIndexes = userPlaylists.value
      .map((p, i) => isSingleSongShellId(p.id) ? i : -1)
      .filter(i => i !== -1)
    for (const i of tempIndexes.slice(SINGLE_SHELL_CAP).reverse()) {
      userPlaylists.value.splice(i, 1)
    }
  }

  const importExternalMedia = async (input, kind) => {
    const spec = MEDIA_IMPORT_SPECS[kind]
    const myReq = gates.mediaImport.claim()
    // 占住 select 闸：resolve 慢（远端多跳），期间在途的 selectPlaylist
    // 回包不得在落壳之后盖掉 selectedPlaylist/songs
    gates.select.invalidate()
    loadingSongs.value = false // 被顶的 selectPlaylist 不会再复位 loading——收掉
    searchQuery.value = '' // 提前清框——防用户重复回车并发多个 resolve
    try {
      console.log(`${spec.icon} 解析 ${spec.tag} 视频:`, input)
      toast(`正在解析 ${spec.tag} 视频…`, 'info', 30000) // 覆盖 resolve 最坏耗时（~25s 匹配预算）
      const data = await spec.resolve(input)
      // 解析期间用户点了别的歌/再导入——过期意图不得抢播放+强跳视图
      if (!gates.mediaImport.isCurrent(myReq)) return
      const song = spec.build(data)
      console.log(`${spec.icon} 解析完成:`, song.name, '网易云匹配:', data.matched?.id ?? '无', '提取歌名:', data.songName)

      // 与 ?song= 分享壳同款的幂等壳：同视频重复导入直接复用，不重复入库
      const shellId = spec.shellIdOf(data)
      let shell = userPlaylists.value.find(p => String(p.id) === shellId)
      if (shell) {
        // 壳在但曲目空/陈旧：原地刷新曲目与元信息（不 unshift——同 id 双壳会渲染冲突）。
        // 锚曲放回头位，用户后来追加进壳的曲保留不丢
        shell.tracks = [song, ...(shell.tracks || []).filter(t => String(t.id) !== String(song.id))]
        shell.trackCount = shell.tracks.length
        shell.name = spec.shellNameOf(song, data)
        shell.coverImgUrl = song.al?.picUrl || ''
        savePlaylistsToStorage()
      } else {
        shell = {
          id: shellId,
          name: spec.shellNameOf(song, data),
          coverImgUrl: song.al?.picUrl || '',
          creator: { nickname: spec.creator },
          trackCount: 1,
          tracks: [song]
        }
        userPlaylists.value.unshift(shell)
        // 与单曲分享壳同一个上限桶（保留最近 10 个）
        pruneSingleSongShells()
        savePlaylistsToStorage()
      }

      selectedPlaylist.value = shell
      currentSong.value = song
      songs.value = shell.tracks || []

      await playSong(song)
      enterWatch()
    } catch (error) {
      if (!gates.mediaImport.isCurrent(myReq)) return // 过期请求的转跳/失败都不打扰用户
      // 服务端把输入解成了 QQ 歌单/B 站收藏夹（短链跳解形态前端谓词看不穿）——
      // 按结构化字段自动转歌单导入，别让"请粘到顶栏"的提示死循环。
      // redirectDataOf 归一 .data（resolve 重抛）与 .response.data（裸 axios）双口径
      const errData = redirectDataOf(error)
      if (errData?.disstid) {
        importQQPlaylist(errData.disstid)
        return
      }
      if (errData?.favlist) {
        importBiliFavlist(errData.favlist)
        return
      }
      if (errData?.playlist) {
        importYouTubePlaylist(errData.playlist)
        return
      }
      console.error(`❌ ${spec.tag} 导入失败:`, error)
      searchQuery.value = input // 失败还原输入——用户可直接回车重试
      toast(`${spec.tag} 导入失败：${error.message || '请检查链接后重试'}`, 'error', 5000)
    }
  }
  const importBilibili = (input) => importExternalMedia(input, 'bilibili')
  const importYouTube = (input) => importExternalMedia(input, 'youtube')
  const importQQ = (input) => importExternalMedia(input, 'qq')
  // 收藏夹/歌单输入先判——favlist/medialist URL 也满足 isBilibiliInput、
  // watch?v=&list= 也满足 isYouTubeInput，顶栏分发已挡一遍，这里是
  // ?bili=/?yt= 分享链/直调路径的双保险
  const importBilibiliOrFav = (input) =>
    extractBiliFavlistId(input) ? importBiliFavlist(input) : importBilibili(input)
  const importYouTubeOrPlaylist = (input) =>
    extractYouTubePlaylistId(input) ? importYouTubePlaylist(input) : importYouTube(input)

  // 整单导入共享壳 upsert：幂等壳存在则原地刷新元信息+新集曲目前插，
  // 用户本地追加的曲目保留在尾（撞 id 的以新集为准自然消歧）。
  // 正选中该壳时视图数组已换引用——selectPlaylistAndShow 须 force 防同 id 短路
  const upsertImportedShell = ({ shellId, tracks, name, coverImgUrl, creator }) => {
    let pl = userPlaylists.value.find(p => String(p.id) === shellId)
    if (!pl) {
      pl = { id: shellId, name: '', coverImgUrl: '', creator: { nickname: '' }, trackCount: 0, tracks: [], isLocal: true }
      userPlaylists.value.unshift(pl)
    }
    pl.name = name
    pl.coverImgUrl = coverImgUrl
    pl.creator = { nickname: creator }
    const newIds = new Set(tracks.map(t => String(t.id)))
    pl.tracks = [...tracks, ...(pl.tracks || []).filter(t => !newIds.has(String(t.id)))]
    pl.trackCount = pl.tracks.length
    savePlaylistsToStorage()
    selectPlaylistAndShow(pl, { force: true })
    return pl
  }

  // 三源公共导入骨架：闸 + 清框 + 长驻进度 toast + 拉取 + upsert + 播报。
  // spec 提供各源差异面：拉取函数/构造器/壳 id 与壳名/封面与创建者/计数透出文案
  const importProviderPlaylist = async (spec) => {
    gates.select.invalidate()
    const myReq = gates.mediaImport.claim()
    loadingSongs.value = false
    // 先清框：导入在途期间（最坏 ~60s+）输入还在的话回车会双发吃限流桶。
    // QQ 歌单是转跳/提取出的 id 非原始输入，沿用旧口径不在开头清（失败留输入可重试）
    if (spec.clearOnStart !== false) searchQuery.value = ''
    const progressToast = spec.progress && toast(spec.progress, 'info', 120000)
    try {
      const data = await spec.fetch()
      if (!gates.mediaImport.isCurrent(myReq)) return
      const tracks = (data.tracks || []).map(spec.build)
      if (!tracks.length) {
        toast(spec.emptyMsg, 'error')
        return
      }
      const pl = upsertImportedShell({
        shellId: spec.shellIdOf(data),
        tracks,
        name: spec.nameOf(data),
        coverImgUrl: spec.coverOf(data, tracks),
        creator: spec.creatorOf(data),
      })
      searchQuery.value = ''
      const note = [
        data.matchedCount ? `词源匹配 ${data.matchedCount}` : '',
        data.skipped ? `跳过失效 ${data.skipped}` : '',
        data.truncated ? '超出上限部分未导入' : '',
      ].filter(Boolean).join('，')
      toast(`已导入 ${spec.tag}「${pl.name}」（${tracks.length} 首${note ? `，${note}` : ''}）`, 'success', 6000)
    } catch (e) {
      if (!gates.mediaImport.isCurrent(myReq)) return
      if (spec.restoreInput) searchQuery.value = spec.input // 失败还原输入——用户可直接回车重试
      toast(`${spec.failTag}导入失败：${e.message || '请检查链接后重试'}`, 'error', 5000)
    } finally {
      if (progressToast) toastDismiss(progressToast) // 进度 toast 完成即退——stale/失败路径也收
    }
  }

  // QQ 歌单导入：disstid → 归一曲目 → 幂等壳 local_pl_qq_<id>——与手动建单
  // 同权（local_pl_ 前缀全链已通：mix 内容分享链/服务端镜像下载/持久化）。
  // 重复导入原地刷新曲目与元信息而不是再复制一份
  const importQQPlaylist = async (disstid) => {
    await importProviderPlaylist({
      tag: 'QQ 歌单',
      failTag: 'QQ 歌单',
      input: disstid,
      clearOnStart: false, // 输入是提取的 disstid 非原始链接——不清框，失败留输入可重试
      restoreInput: false,
      progress: '正在导入 QQ 歌单…',
      emptyMsg: 'QQ 歌单为空或全部不可解析',
      fetch: () => musicApi.getQQPlaylist(disstid),
      build: buildQQSong,
      shellIdOf: () => providerPlaylistShellId('qq', disstid),
      nameOf: (data) => data.name || `QQ 歌单 ${disstid}`,
      coverOf: (data, tracks) => data.cover || tracks[0]?.al?.picUrl || '',
      creatorOf: (data) => data.creator || 'QQ 音乐',
    })
  }

  // B 站收藏夹导入：fid/mlN/分享链 → local_pl_bili_<fid> 幂等壳——
  // 与 QQ 歌单同一形态（手动歌单同权：mix 分享/镜像下载/追加保留全通）。
  // 服务端已按预算跑过词源匹配，matchedCount/skipped 透出给用户
  const importBiliFavlist = async (input) => {
    await importProviderPlaylist({
      tag: 'B 站收藏夹',
      failTag: '收藏夹',
      input,
      restoreInput: true,
      progress: '正在导入 B 站收藏夹…',
      emptyMsg: '收藏夹为空或条目全部失效',
      fetch: () => musicApi.getBiliFavlist(input),
      build: buildBilibiliSong,
      shellIdOf: (data) => providerPlaylistShellId('bili', data.fid),
      nameOf: (data) => data.name || `B 站收藏夹 ${data.fid}`,
      coverOf: (data, tracks) => httpsCover(data.cover || '') || tracks[0]?.al?.picUrl || '',
      creatorOf: (data) => data.creator || 'Bilibili',
    })
  }

  // YouTube 歌单导入：listId/分享链 → local_pl_yt_<id> 幂等壳——与
  // B 站收藏夹同一形态（重导保留本地追加，matchedCount/skipped 透出）。
  // 服务端已按预算跑过词源匹配
  const importYouTubePlaylist = async (input) => {
    await importProviderPlaylist({
      tag: 'YouTube 歌单',
      failTag: '歌单',
      input,
      restoreInput: true,
      progress: '正在导入 YouTube 歌单…',
      emptyMsg: '歌单为空或条目全部失效',
      fetch: () => musicApi.getYouTubePlaylist(input),
      build: buildYouTubeSong,
      shellIdOf: (data) => providerPlaylistShellId('yt', data.listId),
      nameOf: (data) => data.name || `YouTube 歌单 ${data.listId}`,
      coverOf: (data, tracks) => httpsCover(data.cover || '') || tracks[0]?.al?.picUrl || '',
      creatorOf: (data) => data.creator || 'YouTube',
    })
  }

  // 网易云单曲导入：?song= 分享链与顶栏粘贴 music.163.com/song?id=N 同走此路。
  // 幂等壳 single_song_<id>——重复导入复用壳、原地补齐空壳曲目
  const importNeteaseSongById = async (songId) => {
    try {
      // 检查是否已经存在相同的临时歌单
      const tempPlaylistId = `single_song_${songId}`
      let existingPlaylist = userPlaylists.value.find(p => p.id === tempPlaylistId)
      // 壳在但曲目空（脏数据/旧版本剥离壳）：原地补曲目——不 unshift 同 id 双壳
      if (existingPlaylist && !existingPlaylist.tracks?.length) {
        const songDetail = await musicApi.getSongDetail(songId)
        existingPlaylist.tracks = [songDetail]
        existingPlaylist.trackCount = 1
        savePlaylistsToStorage()
      }

      if (existingPlaylist && existingPlaylist.tracks?.length) {
        console.log('🎵 找到已存在的单曲分享歌单，直接使用')
        // 使用已存在的歌单
        selectedPlaylist.value = existingPlaylist
        currentSong.value = existingPlaylist.tracks[0]
        songs.value = existingPlaylist.tracks || []

        // 自动播放并进入 watch 播放页
        await playSong(existingPlaylist.tracks[0])
        enterWatch()
      } else {
        console.log('🎵 创建新的单曲分享歌单')
        // 获取歌曲详情
        const songDetail = await musicApi.getSongDetail(songId)
        console.log('🎵 获取到歌曲详情:', songDetail)

        // 创建一个临时歌单包含这首歌
        const tempPlaylist = {
          id: tempPlaylistId,
          name: `单曲分享 - ${songDetail.name}`,
          coverImgUrl: songDetail.al?.picUrl || songDetail.album?.picUrl || '',
          creator: { nickname: '分享歌曲' },
          trackCount: 1,
          tracks: [songDetail]
        }

        // 添加到用户歌单列表；临时分享歌单数量设上限，每分享一首
        // 永久长一个歌单会把列表无限撑长——保留最近 10 个
        userPlaylists.value.unshift(tempPlaylist)
        pruneSingleSongShells()
        savePlaylistsToStorage()

        // 设置当前歌曲（selectedPlaylist 同步指向临时歌单：
        // 播放快照与刷新恢复都靠它定位队列归属）
        selectedPlaylist.value = tempPlaylist
        currentSong.value = songDetail
        songs.value = tempPlaylist.tracks || []

        // 自动播放并进入 watch 播放页
        await playSong(songDetail)
        enterWatch()
      }

      console.log('✅ 单首歌曲分享加载完成并开始播放')
    } catch (error) {
      console.error('❌ 加载单首歌曲失败:', error)
      toast('分享的歌曲加载失败，请稍后重试', 'error')
    }
  }

  // mix 内容分享导入：?mix=<name>~<id,id,...> 逐 id 解析成曲，
  // 确定性壳 id（fnv-1a32）让同一链接重复打开复用壳而非复制
  const importMixPlaylist = async (mix) => {
    const sep = mix.lastIndexOf('~')
    // [...str] 按码点切——slice 按 code unit 会斩断 emoji 代理对留孤代理
    const name = [...(mix.slice(0, sep).trim() || '分享歌单')].slice(0, 60).join('')
    const seen = new Set()
    const ids = []
    for (const raw of mix.slice(sep + 1).split(',')) {
      const id = raw.trim()
      if (!isResolvableTrackId(id)) continue
      if (seen.has(id)) continue
      seen.add(id)
      ids.push(id)
      if (ids.length >= MIX_IMPORT_CAP) break
    }
    if (!ids.length) {
      toast('分享链接里没有可导入的歌曲', 'info')
      return
    }

    // 确定性壳 id（fnv-1a32）：同一链接重复打开复用壳而非复制
    let h = 0x811c9dc5
    for (const ch of ids.join(',')) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0 }
    const mixId = `local_pl_mix_${h.toString(36)}`
    const existing = userPlaylists.value.find(p => String(p.id) === mixId)
    if (existing?.tracks?.length) {
      // 同 ids 改名重分享：壳 id 锚内容，名字跟随最新链接自愈
      if (name !== '分享歌单' && existing.name !== name) {
        existing.name = name
        savePlaylistsToStorage()
      }
      selectPlaylistAndShow(existing)
      toast(`歌单「${existing.name}」已在库中`, 'info')
      return
    }

    const myReq = gates.mediaImport.claim()
    gates.select.invalidate()
    loadingSongs.value = false
    toast(`正在导入分享歌单「${name}」…`, 'info', 30000)
    try {
      const numericIds = ids.filter(id => /^\d+$/.test(id))
      const detailMap = new Map()
      // 批量详情按 50/块切分——上游单请求 ids 串过长会被截断
      for (let i = 0; i < numericIds.length; i += 50) {
        const chunk = await musicApi.getSongsDetail(numericIds.slice(i, i + 50))
        for (const s of chunk) detailMap.set(String(s.id), s)
      }
      const tracks = []
      let resolveCount = 0
      let skipped = 0
      for (const id of ids) {
        if (!gates.mediaImport.isCurrent(myReq)) return
        if (/^\d+$/.test(id)) {
          const s = detailMap.get(id)
          if (s) tracks.push(s); else skipped++
          continue
        }
        // bv_/yt_/qq_ 共用客户端 resolve 预算——同链混排外部曲总数封顶（服务端三端点分桶各 12/min）
        if (++resolveCount > MIX_RESOLVE_CAP) { skipped++; continue }
        const ym = YT_TRACK_ID_RE.exec(id)
        if (ym) {
          try {
            // 传 ?yt= 形态而非裸 id——服务端 [?&]yt= 分支无 \D 要求，
            // 全数字 videoId（理论存在）也能解
            tracks.push(buildYouTubeSong(await musicApi.resolveYouTube(`?yt=${ym[1]}`)))
          } catch { skipped++ }
          continue
        }
        const qm = QQ_SONG_ID_RE.exec(id)
        if (qm) {
          try {
            tracks.push(buildQQSong(await musicApi.resolveQQ(`?qq=${qm[1]}`)))
          } catch { skipped++ }
          continue
        }
        const m = BV_TRACK_ID_RE.exec(id)
        if (!m) { skipped++; continue }
        try {
          const input = m[2] ? `${m[1]}?p=${m[2]}` : m[1]
          tracks.push(buildBilibiliSong(await musicApi.resolveBilibili(input)))
        } catch { skipped++ }
      }
      if (!gates.mediaImport.isCurrent(myReq)) return
      if (!tracks.length) {
        toast('歌单曲目全部解析失败，请稍后重试', 'error')
        return
      }
      const pl = existing || {
        id: mixId, name,
        coverImgUrl: tracks[0]?.al?.picUrl || '',
        creator: { nickname: '分享导入' },
        trackCount: 0, tracks: [], isLocal: true
      }
      pl.tracks = tracks
      pl.trackCount = tracks.length
      if (name !== '分享歌单') pl.name = name
      if (!pl.coverImgUrl) pl.coverImgUrl = tracks[0]?.al?.picUrl || ''
      if (existing) {
        // 空壳重建也要提头——留在原位的旧壳可能被下面的封顶剪枝当场剪掉
        const idx = userPlaylists.value.findIndex(p => String(p.id) === mixId)
        if (idx > 0) {
          userPlaylists.value.splice(idx, 1)
          userPlaylists.value.unshift(pl)
        }
      } else {
        userPlaylists.value.unshift(pl)
      }
      // mix 壳是分享导入的快照，封顶 20 个（最新的在头）——防长期累积撞配额。
      // 被剪掉的壳可能已建过服务端镜像——剪枝时同步级联清，防孤儿行+文件泄漏
      let mixSeen = 0
      const pruned = []
      userPlaylists.value = userPlaylists.value.filter(p => {
        if (!String(p.id).startsWith('local_pl_mix_')) return true
        if (++mixSeen <= MIX_SHELL_CAP) return true
        pruned.push(p.id)
        return false
      })
      for (const pid of pruned) downloadsApi.removeLocalMirror(pid).catch(() => {})
      savePlaylistsToStorage()
      // force：existing 空壳可能正被选中——同 id 短路会留下陈旧空列表视图
      selectPlaylistAndShow(pl, { force: true })
      toast(`已导入「${name}」（${tracks.length} 首${skipped ? `，跳过 ${skipped} 首` : ''}）`, 'success')
    } catch (error) {
      if (!gates.mediaImport.isCurrent(myReq)) return
      console.error('mix 导入失败:', error)
      toast(`导入分享歌单失败：${error.message || '请稍后重试'}`, 'error', 5000)
    }
  }

  return {
    importExternalMedia,
    importBilibili, importYouTube, importQQ,
    importBilibiliOrFav, importYouTubeOrPlaylist,
    importQQPlaylist, importBiliFavlist, importYouTubePlaylist,
    importNeteaseSongById, importMixPlaylist,
  }
}

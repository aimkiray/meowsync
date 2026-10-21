import { ref, computed, watch, nextTick } from 'vue'
import { musicApi } from '../api/music.js'
import { downloadsApi } from '../api/downloads.js'
import { readJSON, writeJSON, LS_KEYS } from '../lib/storage.js'
import { onRemoteApply } from '../lib/sync.js'
import { toast } from '../lib/feedback.js'
import { isLocalPlaylistId, isSingleSongShellId, externalArtistName, externalCoverUrl, applyTrackOverrides, slimTrack } from '../lib/song.js'
import { SAVED_QUEUE_PREFIX, providerPlaylistShellId } from '../shared/predicates.js'
import { applyTrackOrder, groupTracksByArtist, moveTrackByIds } from '../lib/track-order.js'
import { httpsCover } from '../lib/url.js'
import { buildQQSong, upsertProviderShell } from '../lib/external-songs.js'

const PLAYLISTS_STORAGE_KEY = LS_KEYS.PLAYLISTS
const REMOVED_DEFAULT_PLAYLISTS_KEY = LS_KEYS.REMOVED_DEFAULT_PLAYLISTS
// saved_queue_ 队列存盘双封顶：个数 FIFO 修剪（队列快照是临时产物，
// 长期累积纯属配额浪费）；单条 tracks 封顶——saveQueueAsPlaylist 对
// 五千曲歌单快照一份就是 ~10MB 原始对象，单条即撞爆 QuotaExceededError
const SAVED_QUEUE_CAP = 5
export const SAVED_QUEUE_TRACK_CAP = 500

// 歌单库域：库 CRUD / 本地持久化 / selectPlaylist 单向同步合并 / 行级增删。
//
// deps（App 注入的跨域共享）：
//   gates.select        — selectPlaylist 竞态闸（慢响应不得覆盖新选择）
//   gates.mediaImport   — 外部导入闸（选单作废在途导入，导入也反向占住本闸）
//   gates.preview       — id 预览闸（选单作废在途预览）
//   playingPlaylistId   — 播放队列归属歌单 id（播放器域 ref；移除歌单时清归属）
//   loading             — 侧栏整板 spinner（App 持；URL 歌单首载期间置位）
export function usePlaylistLibrary({ gates, playingPlaylistId, loading }) {
  const userPlaylists = ref([]) // 用户添加的歌单
  const selectedPlaylist = ref(null)
  const songs = ref([])
  const loadingSongs = ref(false)
  // 歌单下载徽章刷新信号：SongList 内子域下载任务删除后 bump 让英雄区计数重拉
  const playlistDownloadsRefreshKey = ref(0)
  const playlistSyncing = ref(false)

  const getRemovedDefaultPlaylists = () => {
    const removed = readJSON(REMOVED_DEFAULT_PLAYLISTS_KEY, [])
    return Array.isArray(removed) ? removed.map(String) : []
  }

  // saved_queue_ 个数 FIFO 修剪（与 single_song_ 壳的 SINGLE_SHELL_CAP 同律）——
  // 内嵌进 savePlaylistsToStorage：一切新增路径都过它，「最多 N 个队列存盘」
  // 的不变量不依赖调用方自觉
  const pruneSavedQueues = () => {
    const queueIndexes = []
    userPlaylists.value.forEach((p, i) => {
      if (String(p?.id || '').startsWith(SAVED_QUEUE_PREFIX)) queueIndexes.push(i)
    })
    const pruned = []
    for (const i of queueIndexes.slice(SAVED_QUEUE_CAP).reverse()) {
      pruned.push(userPlaylists.value[i].id)
      userPlaylists.value.splice(i, 1)
    }
    if (!pruned.length) return
    // 被剪的队列可能建过服务端镜像（镜像行+下载任务+下载档）——与
    // local_pl_mix_ 剪枝同律级联清，否则孤儿行+文件永久泄漏。
    // file_ 上传资产不动：那是用户原档，静默删是真数据丢失
    for (const pid of pruned) downloadsApi.removeLocalMirror(pid).catch(() => {})
    // 悬空引用照 removePlaylistFromLibrary 同口径清：selectedPlaylist 残留
    // 会让行级写路径对脱库对象落盘谎称成功；playingPlaylistId 残留会持续
    // 写进 player-state，恢复时 find 落空还盖死 selectedPlaylistId 回落
    for (const pid of pruned) {
      if (String(selectedPlaylist.value?.id) === String(pid)) {
        gates.select.invalidate()
        loadingSongs.value = false
        selectedPlaylist.value = null
        songs.value = []
      }
      if (String(playingPlaylistId.value) === String(pid)) {
        playingPlaylistId.value = null
      }
    }
  }

  // 多端同步打点：持久化形态剔 updatedAt 逐单指纹比对——内容真变才抬
  // updatedAt。全量同刻盖章会推高 LWW 平局率、还会让没动过的旧单以
  // 「当前刻」压掉远端新值，所以必须按指纹逐个判
  const playlistFingerprints = new Map() // playlistId → 上轮持久化形态指纹
  const storedFingerprint = (stored) => {
    // 指纹只认用户可编辑面——剔除两类簿记：
    //   lastRemoteIds/lastSyncedAt — selectPlaylist/syncPlaylist 写的内部
    //     簿记（远端成员基线/同步时刻）非用户内容——参与指纹会让「打开远端
    //     单」变成「编辑」抬 updatedAt，拿浏览戳在 LWW 里压死他端真实编辑；
    //     他端簿记值漂了但内容相同的单同样不打点
    //   playCount/updateTime 等 — detail 回包整摊进库对象的上游漂移簿记
    //    （播放/收藏/分享/评论计数与上游时间戳），每次拉取都在动——上游
    //     计数漂移不打点，否则浏览远端单同样抬戳抢 LWW
    // name/description/coverImgUrl/trackCount 与本地差量字段
    //（addedTracks/removedTrackIds/trackOrder/trackOverrides/custom…）
    // 留在指纹内——它们是内容本身，真变照旧抬戳
    const {
      updatedAt, lastRemoteIds, lastSyncedAt,
      playCount, subscribedCount, shareCount, commentCount,
      updateTime, trackNumberUpdateTime, cloudTrackCount,
      ...rest
    } = stored || {}
    return JSON.stringify(rest)
  }
  // 登记存量/远端落盘形态的基线：load/远端重建后首个 save 不该把没动的
  // 旧单全盖成当前刻（那才是 LWW 语义里的「没改过」）
  const registerFingerprints = (rawList) => {
    for (const p of rawList || []) {
      if (p && p.id != null) playlistFingerprints.set(String(p.id), storedFingerprint(p))
    }
  }

  let saveFailWarned = false
  const savePlaylistsToStorage = () => {
    pruneSavedQueues()
    // 持久化时剥离大体积 tracks（selectedPlaylist 切回时会重新拉取详情），
    // 本地内存态歌单（单曲分享/队列存盘）无法从接口重拉，tracks 必须保留——
    // 但过 slimTrack 白名单：接口原对象 ~2-4KB/曲，瘦身后 ~400-700B
    const toStore = userPlaylists.value.map(p => {
      if (isLocalPlaylistId(p.id)) {
        return Array.isArray(p.tracks) ? { ...p, tracks: p.tracks.map(slimTrack) } : p
      }
      // trackIds 是 detail 响应带进的完整成员表（千曲单 ~10KB+），客户端不读它——
      // 与 lastRemoteIds 职责重复，持久化剥掉
      const { tracks, trackIds, ...rest } = p
      // addedTracks 同走瘦身白名单——接口返回的全对象（alia/嵌套 privilege 等）
      // 长期累积会撞 localStorage 配额
      if (Array.isArray(rest.addedTracks)) {
        rest.addedTracks = rest.addedTracks.map(slimTrack)
      }
      return { ...rest, trackCount: rest.trackCount ?? (Array.isArray(tracks) ? tracks.length : 0) }
    })
    // 指纹比对打点：一切增删/重排/编辑路径都汇到这个持久化收口，
    // 内容真变的单盖当前刻 updatedAt（库对象同源打点，内存态也是判据源）
    const now = Date.now()
    const liveIds = new Set()
    for (let i = 0; i < toStore.length; i++) {
      const stored = toStore[i]
      if (!stored || stored.id == null) continue
      const id = String(stored.id)
      liveIds.add(id)
      const fp = storedFingerprint(stored)
      if (playlistFingerprints.get(id) !== fp) {
        playlistFingerprints.set(id, fp)
        stored.updatedAt = now
        userPlaylists.value[i].updatedAt = now
      }
    }
    // 出库 id 的指纹基线清掉（id 理论不复用——防手工数据复活旧基线误判未变）
    for (const id of playlistFingerprints.keys()) {
      if (!liveIds.has(id)) playlistFingerprints.delete(id)
    }
    // 配额写爆一次性提示——静默失败=刷新后歌单库消失，比提示烦人严重得多
    if (!writeJSON(PLAYLISTS_STORAGE_KEY, toStore) && !saveFailWarned) {
      saveFailWarned = true
      toast('歌单库存储空间已满，本次修改刷新后可能丢失', 'error')
    }
  }

  // 存量歌单净化：滤脏条目 + healExternalAr 自愈（远端重建共用同一读盘
  // 口径——远端落盘的库同样要走这道净化才进内存）
  const sanitizeStoredPlaylists = (savedPlaylists) => {
    let healedAny = false
    const healExternalAr = (t) => {
      // custom 位=用户显式编辑过的曲——自愈会还原 provider 口径覆盖用户意图，停手
      if (t?.custom) return t
      const ext = t && externalArtistName(t)
      // 只在确实偏离口径时改写——无病曲不动引用，也不触发无意义回写
      if (ext && !(t.ar?.length === 1 && t.ar[0]?.name === ext)) {
        t.ar = [{ name: ext }]
        healedAny = true
      }
      const extCover = t && externalCoverUrl(t)
      // al 也可能是字符串形态（旧数据/上游简化对象）——只对对象形态自愈
      if (extCover && t.al && typeof t.al === 'object' && t.al.picUrl !== extCover) {
        t.al = { ...t.al, picUrl: extCover }
        healedAny = true
      }
      return t
    }
    const list = savedPlaylists
      .filter(p => p && p.id != null)
      .map(p => ({
        ...p,
        tracks: Array.isArray(p.tracks) ? p.tracks.map(healExternalAr) : p.tracks,
        addedTracks: Array.isArray(p.addedTracks) ? p.addedTracks.map(healExternalAr) : undefined,
        removedTrackIds: Array.isArray(p.removedTrackIds) ? p.removedTrackIds : undefined,
        lastRemoteIds: Array.isArray(p.lastRemoteIds) ? p.lastRemoteIds : undefined,
        // 曲序覆盖层同净化：非数组/脏条目（旧数据/手工改坏）清掉而不是带病进合并
        trackOrder: Array.isArray(p.trackOrder) ? p.trackOrder.map(String) : undefined
      }))
    return { list, healedAny }
  }

  const loadPlaylistsFromStorage = () => {
    const savedPlaylists = readJSON(PLAYLISTS_STORAGE_KEY)
    if (Array.isArray(savedPlaylists)) {
      // 存量形态先登指纹基线——首个 save 只给真变单盖戳，旧单不带新戳
      registerFingerprints(savedPlaylists)
      const { list, healedAny } = sanitizeStoredPlaylists(savedPlaylists)
      userPlaylists.value.push(...list)
      if (healedAny) savePlaylistsToStorage() // 自愈结果落盘——下次启动不再依赖重算
    }
  }

  // 远端歌单库应用（同步引擎 per-playlist LWW 已合进 LS）：把内存态重建到
  // 同一事实源。选中单仍在库则刷成库对象新值；被远端墓碑删掉则按本地删除
  // 同口径收掉选中态。songs 行表是 selectPlaylist 拉取的详情视图，不动——
  // 下次选中自然重拉
  const applyRemoteLibrary = () => {
    const raw = readJSON(PLAYLISTS_STORAGE_KEY)
    if (!Array.isArray(raw)) return
    const wasMember = !!selectedPlaylist.value
      && userPlaylists.value.some(p => String(p.id) === String(selectedPlaylist.value.id))
    registerFingerprints(raw)
    const { list, healedAny } = sanitizeStoredPlaylists(raw)
    userPlaylists.value = list
    const sel = selectedPlaylist.value
    if (sel && wasMember) {
      const hit = list.find(p => String(p.id) === String(sel.id))
      if (hit) {
        // hit 是持久化形态（远端单无 tracks 缓存）——摊开合并不丢
        // 选中快照上的详情字段，同时让远端字段（名/封面/同步字段）生效
        selectedPlaylist.value = { ...sel, ...hit }
      } else {
        gates.select.invalidate()
        loadingSongs.value = false
        selectedPlaylist.value = null
        songs.value = []
      }
    }
    // 播放归属悬空同口径清（本地 removePlaylistFromLibrary 同款收尾）
    if (playingPlaylistId.value != null
        && !list.some(p => String(p.id) === String(playingPlaylistId.value))) {
      playingPlaylistId.value = null
    }
    if (healedAny) savePlaylistsToStorage()
  }
  onRemoteApply(PLAYLISTS_STORAGE_KEY, applyRemoteLibrary)

  const addPlaylistToLibrary = async (playlist) => {
    try {
      // 防御无 id 的脏数据（如详情接口返回空壳对象/null）进入歌单库
      if (!playlist || playlist.id == null) {
        console.warn('⚠️ 歌单数据无效，跳过添加')
        return
      }

      // 检查是否已存在（确保ID类型一致）
      const exists = userPlaylists.value.find(p => String(p.id) === String(playlist.id))
      if (exists) {
        return
      }

      // QQ 歌单卡（provider:'qq' + disstid）：id 是 local_pl_qq_ 壳 id 不在
      // 网易云 id 空间——走下方 getPlaylistDetail 链必落空，产出的是无
      // tracks 的死壳（点开即空列表且 selectPlaylist 走 local 分支永不再拉）。
      // 改走 /qq/playlist 导入链产完整壳——与 useSearchNav.openQqPlaylistCard
      // 同一归并（external-songs.upsertProviderShell）：幂等 upsert 自带
      // 重查语义，await 期间并发入库合流同一壳行不复制
      if (playlist.provider === 'qq' && playlist.disstid != null) {
        const disstid = String(playlist.disstid).trim()
        if (!/^\d{1,15}$/.test(disstid)) return // 卡面脏数据不烧上游
        try {
          const data = await musicApi.getQQPlaylist(disstid)
          const tracks = (data.tracks || []).map(buildQQSong)
          if (!tracks.length) return // 上游空回不入库——与点卡导入同闸
          upsertProviderShell(userPlaylists.value, {
            shellId: providerPlaylistShellId('qq', disstid),
            tracks,
            name: data.name || playlist.name || `QQ 歌单 ${disstid}`,
            // data.cover 与 useExternalImport.coverOf 同口径：httpsCover 包封
            //（https 页防 http 混拦），缺席才落卡面/首曲封面
            coverImgUrl: httpsCover(data.cover || '') || playlist.coverImgUrl || tracks[0]?.al?.picUrl || '',
            creator: data.creator || playlist.creator?.nickname || 'QQ 音乐',
          })
          savePlaylistsToStorage()
        } catch (error) {
          console.error('❌ QQ 歌单收藏失败:', error)
        }
        return
      }

      // 确保歌单包含完整的tracks数据
      let fullPlaylist = playlist
      if (!playlist.tracks || playlist.tracks.length === 0) {
        try {
          const detail = await musicApi.getPlaylistDetail(playlist.id)
          // 详情可能为 null 或缺字段的空壳对象：与原始数据合并，保留原 id/name，杜绝 push(null)
          fullPlaylist = detail ? { ...playlist, ...detail } : playlist
        } catch (error) {
          console.error('❌ 获取完整歌单数据失败，使用原始数据:', error)
          fullPlaylist = playlist
        }
      }

      // await 期间同一歌单可能已被并行添加，push 前再查一次重（与 loadDefaultPlaylists 一致）
      if (userPlaylists.value.some(p => String(p.id) === String(playlist.id))) {
        return
      }

      userPlaylists.value.push(fullPlaylist)
      savePlaylistsToStorage()
    } catch (error) {
      console.error('❌ 添加歌单失败:', error)
    }
  }

  const removePlaylistFromLibrary = (playlistId) => {
    const index = userPlaylists.value.findIndex(p => String(p.id) === String(playlistId))
    if (index > -1) {
      const playlist = userPlaylists.value[index]
      userPlaylists.value.splice(index, 1)

      // 如果是默认歌单，记录到已移除列表中（统一存字符串，与 URL 参数类型一致）
      if (playlist.isDefault) {
        const removedIds = getRemovedDefaultPlaylists()
        if (!removedIds.includes(String(playlistId))) {
          removedIds.push(String(playlistId))
          writeJSON(REMOVED_DEFAULT_PLAYLISTS_KEY, removedIds)
        }
      }

      // 本地单可能有服务端镜像产物（镜像行+下载任务+文件）——通知服务端级联清；
      // 失败仅留孤儿行，本地删除照常生效。single_song_ 壳从不镜像，不发空炮
      if (isLocalPlaylistId(playlist.id) && !isSingleSongShellId(playlist.id)) {
        downloadsApi.removeLocalMirror(playlist.id).catch(err =>
          console.warn('镜像清理失败（留孤儿行）:', playlist.id, err?.message))
      }

      savePlaylistsToStorage()

      // 如果移除的是当前选中（或在途加载中——claim 时已写 selectedPlaylist）
      // 的歌单：作废其 select 闸，迟到回包才不会盖写回来「复活」视图。
      // 只对当前目标作废——误杀无关的在途选择会把 loadingSongs 悬住
      // （它由最新认领者复位），作废后要手动收掉
      if (String(selectedPlaylist.value?.id) === String(playlistId)) {
        gates.select.invalidate()
        loadingSongs.value = false
        selectedPlaylist.value = null
        songs.value = []
      }

      // 若移除的是正在播放的歌单：快照保留（会话内续播不受影响——上一首/下一首
      // 继续走 playingSongs，清空反而会让它们劫持到浏览列表）。只清归属 id，
      // 否则持久化会一直写入无效 playingPlaylistId，刷新恢复时 find 落空
      if (String(playingPlaylistId.value) === String(playlistId)) {
        playingPlaylistId.value = null
      }
    }
  }

  const handlePlaylistDownloadsDeleted = (playlistId) => {
    // playlistId 可能经路由/JSON 变成 string，统一 String 比较防静默失配
    if (String(selectedPlaylist.value?.id) === String(playlistId)) {
      playlistDownloadsRefreshKey.value += 1
    }
  }

  const loadPlaylistById = async (id) => {
    try {
      const playlist = await musicApi.getPlaylistDetail(id)
      return playlist
    } catch (error) {
      console.error('❌ 加载歌单详情失败:', error)
      return null
    }
  }

  // 歌单选择（请求序号守卫：快速连点时丢弃过期响应）
  // 返回 true=选择生效且歌曲已就绪，false=被更新的选择抢占/加载失败；供 restorePlaybackState 判断是否继续
  const selectPlaylist = async (playlist, { force = false, silent = false } = {}) => {
    if (!playlist || playlist.id == null) return false
    if (!force && String(selectedPlaylist.value?.id) === String(playlist.id)) return true

    gates.mediaImport.invalidate() // 用户选了别的歌单——在途外部媒体解析回包不得抢播放/强跳视图
    gates.preview.invalidate()     // 同上，作废在途的 id 预览（防回包强跳视图）
    const myReq = gates.select.claim()
    try {
      // silent（手动同步复跑）：不闪 loading，行表直接热替换
      if (!silent) loadingSongs.value = true
      selectedPlaylist.value = playlist

      // 本地内存态歌单（单曲分享/队列存盘）没有接口数据——直接用内嵌 tracks
      if (isLocalPlaylistId(playlist.id)) {
        songs.value = playlist.tracks || []
      } else {
        // 对于正常歌单，从服务器重新获取最新的歌单信息和歌曲数据
        const fullPlaylist = await musicApi.getPlaylistDetail(playlist.id)
        if (!gates.select.isCurrent(myReq)) return false // 已被更新的选择取代，丢弃过期数据
        const fetchedTracks = fullPlaylist?.tracks || []
        // 读库对象而非调用方传入的 playlist——搜索结果/stub 打开同一库中单时
        // 参数对象上没有 addedTracks/removedTrackIds（视图会丢追加曲且 trackCount 被回写成远端值）
        const libPl = userPlaylists.value.find(p => String(p.id) === String(playlist.id))
        // 空拉取防御：上游抖动/接口错误返空时照常合并会整批净化墓碑+清同步基线
        //（不可逆数据丢失）——歌单声称有曲却拉到空 = 按失败处理（服务端 playlist-sync 同款判定）
        if (!fetchedTracks.length && (
          (fullPlaylist?.trackCount ?? 0) > 0
          || (fullPlaylist?.trackIds?.length ?? 0) > 0
          || (libPl?.lastRemoteIds?.length ?? 0) > 0
        )) {
          throw new Error('歌单曲目接口返回为空')
        }
        const fetchedIds = new Set(fetchedTracks.map(t => String(t.id)))
        // 权威远端成员集：trackIds 是 detail 响应自带的完整成员表；
        // fetchedTracks 可能被分页/漂移截断——墓碑净化与同步基线都按权威集判，
        // 否则截断页会把"还在远端"的墓碑误净化、把半截列表记成基线
        const authoritativeIds = new Set(
          (fullPlaylist?.trackIds?.length ? fullPlaylist.trackIds : fetchedTracks)
            .map(t => String(t.id))
        )
        // 单向同步合并：远端曲 − 本地墓碑 + 本地追加排尾
        const removedSet = new Set((libPl?.removedTrackIds ?? playlist.removedTrackIds ?? []).map(String))
        // 墓碑净化：远端已不含的墓碑剪掉（远端删曲后墓碑失效；远端重加同 id 自然复活 = 镜像语义）
        const keptRemoved = [...removedSet].filter(id => authoritativeIds.has(id))
        // 本地追加曲目（addedTracks）排在远端曲目尾；撞 id 的以远端为准自然消歧——
        // 对 fetchedIds 消歧而非权威集：远端有但本页没拉到的曲保留追加条目仍能渲染
        const addedTracks = (libPl?.addedTracks ?? playlist.addedTracks ?? [])
          .filter(t => t && !fetchedIds.has(String(t.id)))
        if (libPl) {
          if (removedSet.size !== keptRemoved.length) libPl.removedTrackIds = keptRemoved
          // 净化回写：远端已含的追加条目永久清掉，堵幻影持久化/僵尸复活通道
          if (libPl.addedTracks && libPl.addedTracks.length !== addedTracks.length) {
            libPl.addedTracks = addedTracks
          }
          // 同步基线：最近一次远端成员集——手动同步 diff/墓碑恢复判重都靠它
          libPl.lastRemoteIds = [...authoritativeIds]
          libPl.lastSyncedAt = Date.now()
        }
        const visibleTracks = fetchedTracks.filter(t => !removedSet.has(String(t.id)))
        // trackOverrides：远端曲目的本地编辑覆盖层（远端单不可就地改写——下次
        // detail 拉取即覆盖）。addedTracks 成员是本地对象就地编辑不走这层
        const overrides = libPl?.trackOverrides ?? playlist.trackOverrides
        // trackOrder 覆盖层在墓碑过滤/追加/override 之后应用——成员集是远端裁决
        // 的，顺序才归本地；未登记成员（远端新曲/追加）按合并序落尾
        songs.value = applyTrackOrder(
          [...visibleTracks, ...addedTracks].map(t => applyTrackOverrides(t, overrides)),
          libPl?.trackOrder
        )

        // hero 同步详情——否则侧栏种子行（只有 id+name）会让 hero 永久显示占位元数据。
        // 本地增删（addedTracks/墓碑）要计入 trackCount——远端计数不含它们
        // 剥掉 playlist 参数上的同步键——传入的陈旧快照不能回退 libPl 刚写的值
        // trackOrder/trackOverrides 同剥：陈旧快照经 merged 摊回库对象会回退
        // libPl 刚写入的新值（force 重选快照路径是未来的地雷引信）
        const { addedTracks: _a, removedTrackIds: _r, lastRemoteIds: _l, lastSyncedAt: _s,
          trackOrder: _t, trackOverrides: _o, ...plBase } = playlist
        const merged = { ...plBase, ...(fullPlaylist || {}) }
        const localDelta = addedTracks.length - keptRemoved.length
        if (localDelta) {
          // 基数取实际拉到的行数——远端 trackCount 是展示计数会滞后
          merged.trackCount = Math.max(0, fetchedTracks.length + localDelta)
        }
        // 快照也带基线：搜索结果直开的非库歌单没有 libPl，
        // syncPlaylist 的 `|| pl` 回退靠它做增量 diff
        merged.lastRemoteIds = [...authoritativeIds]
        merged.lastSyncedAt = Date.now()
        if (!libPl) {
          // 非库预览单：merged 快照自身就是存储——净化后的墓碑/追加要随它传下去。
          // 剥离不带（plBase 剥键是防陈旧快照回退 libPl 刚写的值），非库单没有
          // libPl 可挡——丢了就是「本次同步消费一次墓碑，二次同步复活已删曲」
          merged.removedTrackIds = keptRemoved
          merged.addedTracks = addedTracks
        }
        selectedPlaylist.value = merged

        // 更新本地歌单库中的数据
        const playlistIndex = userPlaylists.value.findIndex(p => String(p.id) === String(playlist.id))
        if (playlistIndex !== -1) {
          // addedTracks 是库对象自己的键（fullPlaylist 没有）——展开合并天然保留
          userPlaylists.value[playlistIndex] = {
            ...userPlaylists.value[playlistIndex],
            ...merged
          }
          savePlaylistsToStorage()
        }
      }
      return true
    } catch (error) {
      if (!gates.select.isCurrent(myReq)) return false
      console.error('❌ 加载歌曲失败:', error)
      // 复位选中态：否则再次点击同一歌单会被“已选中”提前返回，永远无法重试；
      // silent 是手动同步复跑——失败保留旧视图，不清空已渲染的行表
      if (!silent) {
        selectedPlaylist.value = null
        songs.value = []
      }
      return false
    } finally {
      // 仅最新请求负责复位 loading——silent 同步也要复位：它可能顶掉了置起
      // loading 的非 silent 请求，那个请求已被抢占不会再来收尾
      if (gates.select.isCurrent(myReq)) loadingSongs.value = false
    }
  }

  // 当前选中单是否已在库（hero「收藏歌单」显隐依据）
  const selectedPlaylistInLibrary = computed(() =>
    !!selectedPlaylist.value
      && userPlaylists.value.some(p => String(p.id) === String(selectedPlaylist.value.id)))

  let collectingPl = false
  const collectSelectedPlaylist = async () => {
    const pl = selectedPlaylist.value
    if (!pl || pl.id == null || isLocalPlaylistId(pl.id)) return
    if (selectedPlaylistInLibrary.value || collectingPl) return // 在途闸：双击不重复 toast
    collectingPl = true
    try {
      await addPlaylistToLibrary(pl)
      // 按捕获的 pl.id 直查库——await（空 tracks 会 refetch）期间用户切单
      // 不能让「当前选中」computed 把真实的入库成功误报成失败
      if (userPlaylists.value.some(p => String(p.id) === String(pl.id))) {
        toast(`已收藏《${pl.name}》到歌单库`, 'success')
      } else {
        toast('收藏失败', 'error')
      }
    } finally {
      collectingPl = false
    }
  }

  // 追加核心：pl 必须是歌单库对象（远端 merge 快照上的写入不落库）。
  // 返回 'restored' | 'added' | 'exists' | 'invalid'——toast/关窗由调用方决定
  const appendSongToLibraryPlaylist = (pl, song) => {
    if (!song || song.id == null || !pl || pl.id == null) return 'invalid'
    const sid = String(song.id)
    // 命中墓碑 = 恢复被本地移除的远端曲：清墓碑即可，不进 addedTracks（曲归远端所有）。
    // 但只在远端仍含该曲时（lastRemoteIds 基线命中）——远端已删的陈旧墓碑清了也恢复不了，
    // 那种情况应落入常规添加分支进 addedTracks
    const remoteHas = (pl.lastRemoteIds || []).map(String).includes(sid)
    if ((pl.removedTrackIds || []).map(String).includes(sid) && remoteHas) {
      pl.removedTrackIds = pl.removedTrackIds.filter(id => String(id) !== sid)
      pl.trackCount = (pl.trackCount ?? pl.tracks?.length ?? 0) + 1 // 与 added 支路同兜底
      if (String(selectedPlaylist.value?.id) === String(pl.id)) {
        // 墓碑恢复的远端成员可能有历史 override（删除不清 override）——
        // 渲染行即应用，不等下次 selectPlaylist 合并
        // applyTrackOrder：id 还在覆盖层登记位的恢复曲回到原槽而非坠尾
        // （本地单无 trackOrder——恒等返回，两系同一条写路径）
        songs.value = applyTrackOrder(
          [...songs.value, applyTrackOverrides({ ...song }, pl.trackOverrides)],
          pl.trackOrder
        )
        if (selectedPlaylist.value !== pl) {
          selectedPlaylist.value = { ...selectedPlaylist.value, trackCount: pl.trackCount }
        }
      }
      savePlaylistsToStorage()
      return 'restored'
    }
    const inList = (list) => (list || []).some(t => t && String(t.id) === sid)
    // lastRemoteIds 是远端曲基线——开过单的歌单能拦下「远端已有」的幻影添加；
    // 墓碑曲会先走上面的恢复分支，不会误进这里被拒
    if (inList(pl.tracks) || inList(pl.addedTracks) || remoteHas) return 'exists'
    const entry = { ...song }
    // 正打开着这张单——行表即时追加，不等下次拉取。
    // 本地单必须走这里：selectPlaylist 的 `songs = pl.tracks` 共享引用会被
    // 下面的 [...] 重赋值断开，不追加则本会话内该单永远少这首
    const isOpenTarget = String(selectedPlaylist.value?.id) === String(pl.id)
    if (isLocalPlaylistId(pl.id)) {
      pl.tracks = [...(pl.tracks || []), entry]
    } else {
      pl.addedTracks = [...(pl.addedTracks || []), entry]
      // 同 id 的历史 override 不随新追加复活（远端删过的曲重加进 addedTracks，
      // merge 期旧 override 会遮蔽新对象——僵尸编辑复活）
      if (pl.trackOverrides?.[sid] != null) {
        const { [sid]: _drop, ...rest } = pl.trackOverrides
        pl.trackOverrides = rest
      }
    }
    pl.trackCount = (pl.trackCount ?? pl.tracks?.length ?? 0) + 1
    if (isOpenTarget) {
      // applyTrackOrder 同 restored 分支口径：还在登记位的 id（远端删过又
      // 回来的曲）回原槽而非坠尾；未登记恒等落尾（本地单无覆盖层=恒等）
      songs.value = applyTrackOrder([...songs.value, entry], pl.trackOrder)
      // 远端单的 selectedPlaylist 是 merge 快照（非库对象代理），hero 计数手动同步
      if (selectedPlaylist.value !== pl) {
        selectedPlaylist.value = { ...selectedPlaylist.value, trackCount: pl.trackCount }
      }
    }
    savePlaylistsToStorage()
    return 'added'
  }

  // 从歌单移除：本地单剪 tracks；远端单的本地追加曲剪 addedTracks；
  // 远端单的原生曲写 removedTrackIds 墓碑——否则下次单向同步（拉取合并）会复活它。
  // 纯库视图编辑：不动播放队列/当前曲（队列是快照语义）
  const removeSongFromPlaylist = (song) => {
    const pl = selectedPlaylist.value
    if (!song || song.id == null || !pl || pl.id == null) return false
    // 未入库预览单没有持久化落点——墓碑/追加写进 merge 快照会报假成功、
    // 重开即复活（与 applyTrackEdit/applySongsOrder 的入库闸同口径）
    const libPl = userPlaylists.value.find(p => String(p.id) === String(pl.id))
    if (!libPl) {
      toast('歌单未入库，移除无法持久保存——请先收藏该歌单', 'error')
      return false
    }
    const sid = String(song.id)
    if (isLocalPlaylistId(libPl.id)) {
      libPl.tracks = (libPl.tracks || []).filter(t => String(t.id) !== sid)
    } else if ((libPl.addedTracks || []).some(t => String(t.id) === sid)) {
      libPl.addedTracks = libPl.addedTracks.filter(t => String(t.id) !== sid)
      // 远端在本地追加后也收录了同 id 时，光删追加下次同步会被远端副本复活——补墓碑
      if ((libPl.lastRemoteIds || []).map(String).includes(sid)) {
        libPl.removedTrackIds = [...(libPl.removedTrackIds || []), sid]
      }
    } else {
      const removed = libPl.removedTrackIds || []
      if (!removed.map(String).includes(sid)) libPl.removedTrackIds = [...removed, sid]
    }
    libPl.trackCount = Math.max(0, (libPl.trackCount ?? songs.value.length) - 1)
    songs.value = songs.value.filter(t => String(t.id) !== sid)
    if (selectedPlaylist.value !== libPl) {
      selectedPlaylist.value = { ...selectedPlaylist.value, trackCount: libPl.trackCount }
    }
    savePlaylistsToStorage()
    toast(`已从《${libPl.name}》移除「${song.name}」`, 'success')
    return true
  }

  // ── 曲序 ──
  // 持久化落点两系：本地单重排 pl.tracks（数组本身就是序；镜像上传按此序落
  // 服务端 position，下载队列跟随）；远端单写 trackOrder 覆盖层（成员归远端、
  // 顺序归本地）。非库预览单没有持久化落点——与 applyTrackEdit 同口径拒绝。
  // ordered 须是当前渲染的全量曲目对象列（排序模式绕 VIP 过滤/渐进窗渲染）
  const applySongsOrder = (ordered) => {
    const pl = selectedPlaylist.value
    if (!pl || pl.id == null || !Array.isArray(ordered)) return false
    const libPl = userPlaylists.value.find(p => String(p.id) === String(pl.id))
    if (!libPl) return false
    songs.value = ordered
    if (isLocalPlaylistId(libPl.id)) {
      libPl.tracks = [...ordered]
    } else {
      // 空安全：脏行（null/无 id）不写覆盖层——落未登记类下次合并沉尾
      libPl.trackOrder = ordered
        .map(t => t?.id)
        .filter(id => id != null && String(id) !== '')
        .map(String)
    }
    savePlaylistsToStorage()
    return true
  }

  // 行级位移（SongList 排序模式的拖拽/↑↓ emit）：行对象引用锚定——同 id 重复
  // 行裸 id 锚定恒中第一份（拖第二份会移第一份）；排序态期间静默同步/行追加
  // 整体替换 songs 时旧引用 indexOf=-1 天然 no-op（下标载荷会移错行）。
  // {dragId,targetId} 旧形载荷兜底按 id 锚首份——id 序持久化本就不区分
  // 重复项（track-order.js 头注口径），同 id 两份行互为等效副本
  const moveSongInPlaylist = ({ dragRef, targetRef, dragId, targetId } = {}) => {
    let ordered = songs.value
    if (dragRef && targetRef) {
      const from = songs.value.indexOf(dragRef)
      const to = songs.value.indexOf(targetRef)
      if (from !== -1 && to !== -1 && from !== to) {
        ordered = [...songs.value]
        ordered.splice(to, 0, ordered.splice(from, 1)[0])
      }
    } else {
      ordered = moveTrackByIds(songs.value, dragId, targetId)
    }
    if (ordered !== songs.value) applySongsOrder(ordered)
  }

  // 「相同作者归拢」：主唱名聚类排序（组间拼音序、组内保原序）后落同一写通道
  const groupSongsByArtist = () => {
    if (songs.value.length < 2) return
    if (applySongsOrder(groupTracksByArtist(songs.value))) {
      toast('已按歌手归拢排序', 'success')
    }
  }

  // 手动同步：静默重拉远端歌单并报告增量。每次拉取都刷新 lastRemoteIds 基线，
  // 故 diff 的是「上次同步以来」的净变化——单向语义：只收远端增量，本地增删不回传
  const syncPlaylist = async () => {
    const pl = selectedPlaylist.value
    if (!pl || pl.id == null || isLocalPlaylistId(pl.id) || playlistSyncing.value) return
    const libPl = userPlaylists.value.find(p => String(p.id) === String(pl.id)) || pl
    const before = new Set((libPl.lastRemoteIds || []).map(String))
    playlistSyncing.value = true
    const ok = await selectPlaylist(libPl, { force: true, silent: true })
    playlistSyncing.value = false
    if (!ok) {
      // 被更新的选择抢占（同步途中用户点了别的歌单）≠ 真失败——不报错
      if (String(selectedPlaylist.value?.id) === String(pl.id)) {
        toast('同步失败：远端歌单暂时拉不到', 'error')
      }
      return
    }
    // 用户中途换了单——diff 报告没有意义，静默收
    if (String(selectedPlaylist.value?.id) !== String(pl.id)) return
    // after 读 selectedPlaylist 的新 merged——非库预览单的新基线只写在那里
    // （libPl 的 `|| pl` 回退拿到的是旧快照对象，重读它恒等于 before）
    const after = new Set((selectedPlaylist.value.lastRemoteIds || []).map(String))
    const added = [...after].filter(id => !before.has(id)).length
    const gone = [...before].filter(id => !after.has(id)).length
    if (!added && !gone) {
      toast('已同步：与远端一致', 'info')
    } else {
      const parts = []
      if (added) parts.push(`新增 ${added} 首`)
      if (gone) parts.push(`远端移除 ${gone} 首`)
      toast(`已同步：${parts.join('，')}`, 'success')
    }
  }

  // ── 新建空白歌单 ──
  // local_pl_<ts> 与导入壳/mix 链同族：isLocalPlaylistId 全链路现成正确
  //（持久化保留 tracks / 内嵌加载 / ?mix= 内容分享链 / 服务端镜像下载），
  // 又不继承 saved_queue_ 的「播放上下文物件」语义（随机键等歌单级操作正常可用）。
  // 弹窗态也放本域——创建是库行为，冻结/焦点逻辑与 atp/点歌台同款集中管
  const createPlaylistOpen = ref(false)
  const createPlaylistName = ref('')
  const createPlaylistInput = ref(null)
  // 触发键在 open 同步段捕获——不能挪进 watcher 里读 document.activeElement：
  // 互斥收口（如 atp-over-create）时兄弟窗的 cleanup 归还先跑（watcher id 序），
  // watcher 内读到的会是被污染的旧窗触发键而非本次真实触发键
  let createPrevFocus = null

  const openCreatePlaylist = () => {
    if (createPlaylistOpen.value) return // 重入不清空已输入名
    createPrevFocus = document.activeElement
    createPlaylistName.value = ''
    createPlaylistOpen.value = true
  }
  const closeCreatePlaylist = () => { createPlaylistOpen.value = false }

  // 焦点进出与 atp 弹窗同款：开时进输入框、关时归还触发键。
  // 归还推迟到 rAF（本帧渲染之后）：提交路径上 selectPlaylistAndShow 会合上
  // 移动端抽屉/切视图，其 DOM patch 排在 watcher flush 之后的独立 flush——
  // 同步或 microtask 归还都会赶在 patch 前，把焦点落到随后才隐藏的元素上。
  // visibilityProperty 覆盖抽屉的 visibility:hidden 关闭态
  watch(createPlaylistOpen, async (v, _prev, onCleanup) => {
    if (!v) return
    const prevFocus = createPrevFocus
    createPrevFocus = null
    onCleanup(() => {
      if (!(prevFocus instanceof HTMLElement)) return
      requestAnimationFrame(() => {
        if (prevFocus.checkVisibility?.({ visibilityProperty: true }) === false) return
        prevFocus.focus({ preventScroll: true })
      })
    })
    await nextTick()
    createPlaylistInput.value?.focus()
  })

  // 建空白本地单。返回库内响应式代理——调用方再写字段/追加曲才走依赖追踪；
  // 空名返回 null（toast/关窗由调用方决定）。名长截 40（与远端单显示
  // 口径同档，侧栏/hero 不留超长名）；重名自动编号「名(2)/(3)…」——
  // 库内唯一（含远端单），否则侧栏两同名单分不清哪张是新建的空单
  const createLocalPlaylist = (name, { coverImgUrl = '' } = {}) => {
    // [...str] 按码点切——code-unit slice 会在 emoji 边界斩断代理对留孤代理
    const trimmed = [...String(name || '').trim()].slice(0, 40).join('')
    if (!trimmed) return null
    let resolved = trimmed
    if (userPlaylists.value.some(p => p.name === resolved)) {
      let i = 2
      // 编号名同受 40 上限：后缀占位从主体里扣，不留超档名
      const numbered = () => `${[...trimmed].slice(0, 40 - `(${i})`.length).join('')}(${i})`
      while (userPlaylists.value.some(p => p.name === numbered())) i++
      resolved = numbered()
      toast(`已存在同名歌单，已命名为「${resolved}」`, 'info', 3000)
    }
    // Date.now 同毫秒双建会撞号——撞上就后错一毫秒（撞率≈0，一次自增即收敛）
    let id = `local_pl_${Date.now()}`
    while (userPlaylists.value.some(p => p.id === id)) {
      id = `local_pl_${Number(id.slice(9)) + 1}`
    }
    const pl = {
      id,
      name: resolved,
      coverImgUrl,
      creator: { nickname: '我' },
      trackCount: 0,
      tracks: [],
      isLocal: true
    }
    userPlaylists.value.unshift(pl)
    savePlaylistsToStorage()
    return userPlaylists.value.find(p => p.id === pl.id) || pl
  }

    // URL歌单加载（playlistIds 由 readShareParams 在挂载处一趟解析后传入）
    const loadDefaultPlaylists = async (urlPlaylistIds) => {
      try {
        // 如果没有URL参数，跳过加载
        if (urlPlaylistIds.length === 0) {
          return
        }

        const defaultPlaylistIds = urlPlaylistIds
        
        const removedIds = getRemovedDefaultPlaylists()
        
        // 过滤掉已移除的歌单ID和已存在的歌单ID；URL 内重复ID先去重，避免并行加载后重复push
        const validIds = [...new Set(defaultPlaylistIds)].filter(id => {
          if (removedIds.includes(id)) {
            return false
          }

          // 检查是否已存在相同ID的歌单（确保ID类型一致）
          const exists = userPlaylists.value.find(p => String(p.id) === String(id))
          if (exists) {
            return false
          }
          
          return true
        })
        
        if (validIds.length === 0) {
          return
        }

        // 侧栏整板 spinner 亮起——URL 歌单首载是唯一真正吃 loading 的路径
        loading.value = true

        // 并行加载所有歌单
        const playlistPromises = validIds.map(async (id) => {
          try {
            const playlist = await loadPlaylistById(id)
            if (playlist) {
              playlist.isDefault = true
              return playlist
            }
          } catch (error) {
            console.error('❌ 加载默认歌单失败:', id, error)
            return null
          }
        })
        
        // 等待所有歌单加载完成
        const playlists = await Promise.all(playlistPromises)
        
        // 将成功加载的歌单添加到用户歌单列表
        // push 前再查一次重：加载 await 期间用户可能已通过其他途径添加同一歌单
        playlists.forEach(playlist => {
          if (playlist && !userPlaylists.value.some(p => String(p.id) === String(playlist.id))) {
            userPlaylists.value.push(playlist)
          }
        })
        
        // 保存到本地存储
        if (playlists.some(p => p)) {
          savePlaylistsToStorage()
        }
      } catch (error) {
        console.error('❌ 加载URL歌单失败:', error)
      } finally {
        loading.value = false
      }
    }

    // ── 曲目编辑 ──
    // 落点三分支：local_pl_ 成员改 pl.tracks；远端单 addedTracks 成员改追加表；
    // 远端成员（detail 拉来的）写 trackOverrides 覆盖层——远端对象不可就地改写
    // （下次 detail 即覆盖）。统一打 custom 位挡 healExternalAr 还原。就地改时
    // 若该单正开着，同步 songs.value 里的渲染对象
    const applyTrackEdit = (playlistId, songId, meta, filePatch) => {
      const pl = userPlaylists.value.find(p => String(p.id) === String(playlistId))
      const sid = String(songId)
      const apply = (t) => {
        if (!t) return false
        // custom 位=「用户改过」挡 healExternalAr 还原——但用户开了编辑窗
        // 什么也没动就保存不该打这个位（会永久冻住 provider 自愈）
        const nextArtist = meta.artist !== undefined ? (meta.artist || '未知艺术家') : undefined
        const changed =
          (meta.name != null && t.name !== meta.name) ||
          (nextArtist !== undefined && (t.ar || []).map(a => a?.name).filter(Boolean).join(', ') !== nextArtist) ||
          (meta.album !== undefined && (t.al?.name || '') !== meta.album) ||
          (meta.durationMs != null && (t.dt || 0) !== meta.durationMs) ||
          (filePatch && Object.entries(filePatch).some(([k, v]) => t.file?.[k] !== v))
        if (meta.name != null) t.name = meta.name
        if (nextArtist !== undefined) t.ar = [{ name: nextArtist }]
        if (meta.album !== undefined) {
          t.al = typeof t.al === 'object' && t.al ? { ...t.al, name: meta.album } : { name: meta.album }
        }
        if (meta.durationMs != null) t.dt = meta.durationMs // 0=清空回「自动」
        if (filePatch) t.file = { ...(t.file || {}), ...filePatch }
        if (changed) t.custom = true
        return true
      }
      let hit = false
      if (pl) {
        // pl.tracks 分支只收本地单：远端单的 tracks 是 detail 合并回来的
        // 展示缓存（savePlaylistsToStorage 会剥掉它）——就地改=写进不持久化的
        // 字段，刷新即丢。远端成员必须落到下面的 trackOverrides 覆盖层
        if (isLocalPlaylistId(pl.id) && pl.tracks?.some(t => String(t.id) === sid && apply(t))) hit = true
        if (!hit && pl.addedTracks?.some(t => String(t.id) === sid && apply(t))) {
          // 曲落进 addedTracks 后若还留着旧 override 键，merge 期它会遮蔽
          // 这份就地编辑——进追加表即摘 override
          if (pl.trackOverrides?.[sid] != null) {
            const { [sid]: _drop, ...rest } = pl.trackOverrides
            pl.trackOverrides = rest
          }
          hit = true
        }
        if (!hit) {
          // 远端成员：覆盖层 merge（不重建对象——其他曲的 override 不动）。
          // 归属闸：sid 必须真在这张单（远端缓存成员或 lastRemoteIds 基线），
          // 否则 override 键就是死数据——本地单到这儿更不该写（本地分支不消费
          // overrides），直接 miss
          if (isLocalPlaylistId(pl.id)) return false
          const raw = pl.tracks?.find(t => String(t.id) === sid)
          const memberOf = !!raw || (pl.lastRemoteIds || []).map(String).includes(sid)
          if (!memberOf) return false
          const prev = pl.trackOverrides?.[sid] || {}
          // 无改动不落 override——远端成员开编辑窗原样保存不该把字段钉死、
          // 挡住远端口径的后续更新（与就地分支「无改动不打 custom」同口径）
          const eff = raw ? applyTrackOverrides(raw, { [sid]: prev }) : null
          const effArtist = (eff?.ar || []).map(a => a?.name).filter(Boolean).join(', ')
          const overrideUnchanged = eff
            && eff.name === meta.name
            && effArtist === (meta.artist || '未知艺术家')
            && (eff.al?.name || '') === meta.album
            && (eff.dt || 0) === meta.durationMs
          // meta={} 的纯 filePatch 调用（catch 部分回放）不该在远端成员上
          // 写 {name:undefined,...} 死 override 键——当前不可达，留闸防未来
          const hasMeta = meta.name != null || meta.artist != null || meta.album != null
            || meta.durationMs != null || filePatch?.coverUrl != null
          if (!overrideUnchanged && hasMeta) {
            pl.trackOverrides = {
              ...(pl.trackOverrides || {}),
              [sid]: {
                ...prev,
                name: meta.name, artist: meta.artist, album: meta.album,
                durationMs: meta.durationMs,
                // coverUrl 是预留通道（filePatch 暂无产出）——undefined 死键会
                // 清掉假想旧值，只在有值时写
                ...(filePatch?.coverUrl ? { coverUrl: filePatch.coverUrl } : {}),
              },
            }
          }
          hit = true
        }
        savePlaylistsToStorage()
      }
      // 渲染层同步：hit 才动视图（未入库单编辑失败时既弹「无法持久」又改
      // 渲染行是自相矛盾）。就地落点时库对象与渲染对象同引用——apply 幂等
      const viewIdx = songs.value.findIndex(t => String(t.id) === sid)
      if (hit && viewIdx !== -1 && String(selectedPlaylist.value?.id) === String(playlistId)) {
        const cur = songs.value[viewIdx]
        // 远端成员（pl.tracks 是 detail 缓存、成员来自远端）绝不就地 apply——
        // cur 与缓存对象同引用，写了=写脏共享快照（ar 摊平/custom 位都会被
        // 下次 detail 冲掉，纯隐藏双写）。有 override 换渲染行，没有就不碰
        const isRemoteMember = pl && !isLocalPlaylistId(pl.id)
          && !(pl.addedTracks || []).some(t => String(t.id) === sid)
        if (isRemoteMember) {
          if (pl.trackOverrides?.[sid]) {
            songs.value[viewIdx] = applyTrackOverrides(cur, pl.trackOverrides)
          }
        } else {
          apply(cur)
          if (pl?.trackOverrides?.[sid]) {
            songs.value[viewIdx] = applyTrackOverrides(cur, pl.trackOverrides)
          }
        }
      }
      return hit
    }

  return {
    // state
    userPlaylists,
    selectedPlaylist,
    songs,
    loadingSongs,
    playlistSyncing,
    playlistDownloadsRefreshKey,
    // 持久化
    savePlaylistsToStorage,
    loadPlaylistsFromStorage,
    getRemovedDefaultPlaylists,
    // 库 CRUD
    addPlaylistToLibrary,
    removePlaylistFromLibrary,
    handlePlaylistDownloadsDeleted,
    loadPlaylistById,
    collectSelectedPlaylist,
    selectedPlaylistInLibrary,
    // 新建空白歌单（侧栏 + 弹窗）
    createPlaylistOpen, createPlaylistName, createPlaylistInput,
    openCreatePlaylist, closeCreatePlaylist, createLocalPlaylist,
    // URL 默认歌单加载
    loadDefaultPlaylists,
    // 选择与同步
    selectPlaylist,
    appendSongToLibraryPlaylist,
    removeSongFromPlaylist,
    applyTrackEdit,
    moveSongInPlaylist,
    groupSongsByArtist,
    syncPlaylist,
  }
}

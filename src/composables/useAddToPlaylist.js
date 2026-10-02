import { ref, computed, watch, nextTick } from 'vue'
import { musicApi } from '../api/music'
import { apiErrorMessage } from '../api/http'
import { toast } from '../lib/feedback'
import { isSingleSongShellId } from '../lib/song'
import {
  extractBiliFavlistId, isBilibiliInput, extractYouTubePlaylistId,
  isYouTubeInput, extractYouTubeId, extractQQPlaylistId, isQQInput,
  isSongmidLike, extractNeteaseSongId,
} from '../lib/url'
import { buildBilibiliSong, buildYouTubeSong, buildQQSong } from '../lib/external-songs'

// 「加入歌单」域：atp 弹窗（把指定曲加进某单）与点歌台弹窗（往当前单搜/粘曲）
// 两弹窗显式互斥（openAddToPlaylist 关 picker、openSongPicker 清 addTargetSong）
//
// deps（App 注入的跨域共享）：
//   gates.picker — 点歌台内搜索/解析竞态闸
//   userPlaylists / selectedPlaylist / songs — 库域 state
//   addPlaylistToLibrary / appendSongToLibraryPlaylist / createLocalPlaylist — 库域动作
//   closeCreatePlaylist — 库域弹窗互斥收口（三弹窗显式互斥，不指望 UI 不可达兜底）
export function useAddToPlaylist({
  gates,
  userPlaylists, selectedPlaylist, songs,
  addPlaylistToLibrary, appendSongToLibraryPlaylist, createLocalPlaylist,
  closeCreatePlaylist,
}) {

  // ── 添加到歌单（待播/相关/歌单页/搜索结果行尾键共用入口） ──
  // 远端歌单不能整表存 tracks——本地追加记 addedTracks，selectPlaylist 拉取后合并；
  // 本地歌单（local_pl_/saved_queue_ 系）tracks 直接追加，持久化整条保留
  const addTargetSong = ref(null)
  const newPlaylistName = ref('')
  const atpInput = ref(null)
  // 触发键在 open 同步段捕获——不能挪进 watcher 里读 document.activeElement：
  // 互斥收口（如 picker-over-atp）时兄弟窗的 cleanup 归还先跑（watcher id 序），
  // watcher 内读到的会是被污染的旧窗触发键而非本次真实触发键
  let atpPrevFocus = null
  // 可选目标排除 single_song_ 分享壳：它会被「超 10 个剪枝」自动销毁，
  // 用户加进去的曲会随壳静默消失（数据丢失通道）
  const addablePlaylists = computed(() =>
    userPlaylists.value.filter(p => !isSingleSongShellId(p.id))
  )
  const openAddToPlaylist = (song) => {
    // 校验先于互斥收口（与 openSongPicker 同律）：无效曲不该碰弹窗态
    if (!song || song.id == null) {
      toast('这首歌无法加入歌单', 'error')
      return
    }
    atpPrevFocus = document.activeElement
    closeSongPicker() // 与点歌台显式互斥（行菜单在模态外层但防御性收口）
    closeCreatePlaylist() // 与新建歌单弹窗同款互斥
    newPlaylistName.value = ''
    addTargetSong.value = song
  }
  // 对话框开启期间：焦点移入输入框（键盘流可立即输入新歌单名）；
  // Esc 由 onGlobalKeydown 统一冻结处理，此处只管焦点归还（还给触发键）
  watch(addTargetSong, async (v, _prev, onCleanup) => {
    if (!v) return
    const prevFocus = atpPrevFocus
    atpPrevFocus = null
    // preventScroll：归还不该滚页面（互斥关闭路径上归还的只是中间态，滚了是闪动）
    onCleanup(() => { if (prevFocus instanceof HTMLElement) prevFocus.focus({ preventScroll: true }) })
    await nextTick()
    atpInput.value?.focus()
  })

  const addSongToPlaylist = (pl) => {
    const song = addTargetSong.value
    const res = appendSongToLibraryPlaylist(pl, song)
    if (res === 'invalid') return
    if (res === 'exists') toast(`「${song.name}」已在《${pl.name}》里`, 'info')
    else toast(`已加入《${pl.name}》`, 'success')
    addTargetSong.value = null
  }

  // 「新建歌单并加入」：建单收口在库域 createLocalPlaylist（壳构造/持久化单源），
  // 封面取被加曲的图——空壳比封面兜底音符更有辨识度
  const createPlaylistAndAdd = () => {
    const name = newPlaylistName.value.trim()
    const song = addTargetSong.value
    if (!name || !song) return
    const pl = createLocalPlaylist(name, {
      coverImgUrl: song.al?.picUrl || song.album?.picUrl || ''
    })
    // pl 已是库内响应式代理——addSongToPlaylist 的字段赋值走依赖追踪
    if (pl) addSongToPlaylist(pl)
  }

  // ── 点歌台（歌单 hero「添加歌曲」）：搜索网易云 / 粘歌曲链接/ID / B 站、YouTube 链接，
  // 向当前打开的单一连追加。single_song_ 壳不开（壳=单曲容器，SongList 已藏键）。
  // 逐首追加不关窗——加多首是常态；每行带封面与「已在单」态
  const songPickerOpen = ref(false)
  const songPickerQuery = ref('')
  const songPickerResults = ref([])
  const songPickerSearching = ref(false)
  const songPickerAdded = ref(new Set())    // 本窗已加入的 id（行态「✓」）
  const songPickerPending = ref(new Set())  // 添加在途的 id——非库单 collect 慢，双击会并发双 toast
  const songPickerInput = ref(null)

  let pickerAbort = null // 挂在窗生命周期的 AbortController——关窗中止在途 resolve
  let pickerPrevFocus = null // 触发键（open 同步段捕获，同 atpPrevFocus 之理）

  // 目标单的库对象（远端 merge 快照上的 addedTracks 不落库，必须落在库行上）
  const pickerLibPlaylist = computed(() =>
    userPlaylists.value.find(p =>
      selectedPlaylist.value && String(p.id) === String(selectedPlaylist.value.id)))

  // 已在单 id 集：库对象的 tracks+addedTracks ∪ lastRemoteIds 基线 ∪ 当前展示行，
  // 减去墓碑——本地移除的远端曲还在 pl.tracks 快照里，但它视觉上是「不在单」，
  // 标「已在单」会把恢复路径（append 的墓碑分支）从点歌台彻底挡掉。
  // lastRemoteIds 必须与 append 的 remoteHas 同判决：trackIds 基线 ⊋ 拉取页时，
  // 基线内曲显「添加」点下去却弹「已在单」，按钮态与判决不能分叉
  const pickerTakenIds = computed(() => {
    const ids = new Set()
    const lib = pickerLibPlaylist.value
    const tombstoned = new Set((lib?.removedTrackIds || []).map(String))
    for (const t of lib?.tracks || []) {
      if (t?.id != null && !tombstoned.has(String(t.id))) ids.add(String(t.id))
    }
    for (const t of lib?.addedTracks || []) t?.id != null && ids.add(String(t.id))
    for (const t of songs.value || []) t?.id != null && ids.add(String(t.id))
    for (const id of lib?.lastRemoteIds || []) {
      if (!tombstoned.has(String(id))) ids.add(String(id))
    }
    return ids
  })

  const openSongPicker = () => {
    const pl = selectedPlaylist.value
    if (!pl || isSingleSongShellId(pl.id)) return
    // 触发键在互斥收口前的同步段捕获（watcher 内读会被兄弟窗的 cleanup 归还污染）
    pickerPrevFocus = document.activeElement
    gates.picker.invalidate() // 上一窗在途的搜索/解析作废
    pickerAbort?.abort()   // 连带中止在途 resolve 的 HTTP（服务端级联断上游）
    pickerAbort = null
    addTargetSong.value = null // 与 atp 弹窗显式互斥——不指望 UI 不可达兜底
    closeCreatePlaylist()      // 与新建歌单弹窗同款互斥
    songPickerQuery.value = ''
    songPickerResults.value = []
    songPickerSearching.value = false
    songPickerAdded.value = new Set()
    songPickerPending.value = new Set()
    songPickerOpen.value = true
  }
  const closeSongPicker = () => {
    songPickerOpen.value = false
    gates.picker.invalidate()
    pickerAbort?.abort()
    pickerAbort = null
  }

  // 目标单失活（selectPlaylist catch 置 null / popstate 换单）→ 弹窗语义目标
  // 消失，关窗防「标题空白 + 加到意外单」
  watch(selectedPlaylist, (v) => {
    if (!v && songPickerOpen.value) closeSongPicker()
  })

  // Esc 由 onGlobalKeydown 统一冻结；焦点归还与 atp 同款
  watch(songPickerOpen, async (v, _prev, onCleanup) => {
    if (!v) return
    const prevFocus = pickerPrevFocus
    pickerPrevFocus = null
    onCleanup(() => { if (prevFocus instanceof HTMLElement) prevFocus.focus({ preventScroll: true }) })
    await nextTick()
    songPickerInput.value?.focus()
  })

  const addPickedSong = async (song) => {
    const pl = selectedPlaylist.value
    const sid = String(song?.id ?? '')
    if (!pl || isSingleSongShellId(pl.id)) { closeSongPicker(); return }
    if (songPickerPending.value.has(sid)) return // collect 途中行按钮还没 disabled，挡双击并发
    songPickerPending.value = new Set([...songPickerPending.value, sid])
    const plId = pl.id // 捕获进入时的目标——await 期间 selectedPlaylist 可能被 popstate 换掉
    try {
      // 按捕获的 plId 找库对象——不走 pickerLibPlaylist 重算（await/popstate
      // 换掉 selectedPlaylist 后不能错加到新单）
      let libPl = userPlaylists.value.find(p => String(p.id) === String(plId))
      let collected = false
      if (!libPl) {
        // 非库远端单（搜索结果直接打开）：addedTracks 必须挂在库对象上才持久化——
        // 先把单收进库再追加，否则刷新后加的歌全丢
        await addPlaylistToLibrary(pl)
        libPl = userPlaylists.value.find(p => String(p.id) === String(plId))
        collected = !!libPl
      }
      if (!libPl) { toast('歌单入库失败，无法添加', 'error'); return }
      const res = appendSongToLibraryPlaylist(libPl, song)
      if (res === 'exists') {
        songPickerAdded.value = new Set([...songPickerAdded.value, sid])
        if (songPickerOpen.value) toast(`「${song.name}」已在《${libPl.name}》里`, 'info')
      } else if (res === 'added' || res === 'restored') {
        songPickerAdded.value = new Set([...songPickerAdded.value, sid])
        if (songPickerOpen.value) toast(`${collected ? '已收藏歌单，' : ''}已加入《${libPl.name}》`, 'success')
      } else if (songPickerOpen.value) {
        toast('这首歌无法加入歌单', 'error')
      }
    } finally {
      const next = new Set(songPickerPending.value)
      next.delete(sid)
      songPickerPending.value = next
    }
  }

  // 直加分支共用收尾：结果置顶展示（同 id 去重防 :key 撞键告警）→ 清框 → 入单
  const resolveToPickedSong = async (song) => {
    songPickerResults.value = [song,
      ...songPickerResults.value.filter(r => String(r.id) !== String(song.id))]
    songPickerQuery.value = ''
    await addPickedSong(song)
  }

  const songPickerSearch = async () => {
    const q = songPickerQuery.value.trim()
    if (!q || songPickerSearching.value) return
    const mySeq = gates.picker.claim()
    songPickerSearching.value = true
    let action = '搜索' // 失败 toast 名头按分支换——直加路径挂「搜索失败」误导
    try {
      // 收藏夹链接在点歌台无落点（整单导入走顶栏）——先于 isBilibiliInput
      // 判，否则 favlist URL 会被当单曲送去 resolve 再弹回
      if (extractBiliFavlistId(q)) {
        toast('这是 B 站收藏夹链接，请在顶部搜索框粘贴导入', 'info')
        return
      }
      if (isBilibiliInput(q)) {
        action = '解析'
        // 裸 BV(+可选 ?p=N) 能本地推出确定 id——已在单就短路，省下 resolve 的上游
        // 扇出与限流配额（/resolve 12/min 与顶栏导入、mix 导入共用一桶）
        const bvM = q.match(/\b(BV[0-9A-Za-z]{10})\b/i)
        const pvM = q.match(/[?&]p=(\d+)/i)
        if (bvM) {
          // 大小写不敏感比对——buildBilibiliSong 的 id 大小写随服务端回显走，
          // 本地候选串按用户输入形态生成，两边可能差大小写
          const candLow = `bv_${bvM[1]}${(+pvM?.[1] || 0) > 1 ? `_p${+pvM[1]}` : ''}`.toLowerCase()
          if ([...pickerTakenIds.value].some(id => id.toLowerCase() === candLow)) {
            toast('该视频已在歌单里', 'info')
            songPickerQuery.value = ''
            return
          }
        }
        // B 站输入是单一目标——解析完直接入单，不经结果列表中转
        toast('正在解析 B 站视频…', 'info', 30000) // 覆盖 resolve 最坏耗时
        pickerAbort = new AbortController()
        const data = await musicApi.resolveBilibili(q, pickerAbort.signal)
        if (!gates.picker.isCurrent(mySeq) || !songPickerOpen.value) return
        await resolveToPickedSong(buildBilibiliSong(data))
        return
      }
      // 歌单链接在点歌台无落点（整单导入走顶栏）——先于 isYouTubeInput
      // 判，否则 watch?v=&list= 会被当单曲解析
      if (extractYouTubePlaylistId(q)) {
        toast('这是 YouTube 歌单链接，请在顶部搜索框粘贴导入', 'info')
        return
      }
      if (isYouTubeInput(q)) {
        action = '解析'
        // URL 形态可本地推出 yt_<id>（isYouTubeInput 收窄后裸 id 不入此分支）——
        // 已在单短路省 resolve
        const vid = extractYouTubeId(q)
        if (vid && pickerTakenIds.value.has(`yt_${vid}`)) {
          toast('该视频已在歌单里', 'info')
          songPickerQuery.value = ''
          return
        }
        toast('正在解析 YouTube 视频…', 'info', 30000)
        pickerAbort = new AbortController()
        const data = await musicApi.resolveYouTube(q, pickerAbort.signal)
        if (!gates.picker.isCurrent(mySeq) || !songPickerOpen.value) return
        await resolveToPickedSong(buildYouTubeSong(data))
        return
      }
      // QQ 歌单链接在点歌台无落点（歌单导入走顶栏）——给指向性提示而非噪声搜索
      if (extractQQPlaylistId(q)) {
        toast('这是 QQ 歌单链接，请在顶部搜索框粘贴导入', 'info')
        return
      }
      if (isQQInput(q)) {
        action = '解析'
        toast('正在解析 QQ 音乐…', 'info', 30000)
        pickerAbort = new AbortController()
        const data = await musicApi.resolveQQ(q, pickerAbort.signal)
        if (!gates.picker.isCurrent(mySeq) || !songPickerOpen.value) return
        await resolveToPickedSong(buildQQSong(data))
        return
      }
      // qq: 前缀触发 QQ 曲库搜索——补「网易云没有的那首歌」缺口。
      // 结果经 buildQQSong 归一成 qq_* 曲（歌词/下载/分享链全通）。
      // qq:<mid 形态>先试 resolve（显式 mid 直解），失败才回落关键词搜索；
      // mid 判定收紧为「字母数字混合」——纯字母英文关键词不值得烧 resolve 配额
      if (/^qq[:：]/i.test(q)) {
        action = 'QQ 搜索'
        const kw = q.replace(/^qq[:：]/i, '').trim()
        if (!kw) return
        if (isQQInput(kw) || isSongmidLike(kw)) {
          try {
            pickerAbort = new AbortController()
            const data = await musicApi.resolveQQ(isQQInput(kw) ? kw : `qq:${kw}`, pickerAbort.signal)
            if (!gates.picker.isCurrent(mySeq) || !songPickerOpen.value) return
            await resolveToPickedSong(buildQQSong(data))
            return
          } catch { /* mid 形态的关键词——resolve 失败按搜索处理 */ }
        }
        if (!pickerAbort || pickerAbort.signal.aborted) pickerAbort = new AbortController()
        const list = await musicApi.searchQQSongs(kw, pickerAbort.signal)
        if (!gates.picker.isCurrent(mySeq) || !songPickerOpen.value) return
        songPickerResults.value = (list || []).map(buildQQSong)
        if (!songPickerResults.value.length) toast('QQ 音乐没有找到相关歌曲', 'info')
        return
      }
      const songId = extractNeteaseSongId(q)
      if (songId) {
        action = '添加'
        // 已在单本地短路——不打详情接口（裸数字大概率是歌单 id 误粘时也省一趟）
        if (pickerTakenIds.value.has(songId)) {
          toast('该歌曲已在歌单里', 'info')
          songPickerQuery.value = ''
          return
        }
        // 歌曲 ID 是单一目标——直加。getSongDetail 未命中抛错走 catch
        const song = await musicApi.getSongDetail(songId)
        if (!gates.picker.isCurrent(mySeq) || !songPickerOpen.value) return
        await resolveToPickedSong(song)
        return
      }
      const list = await musicApi.searchSongs(q, 30)
      if (!gates.picker.isCurrent(mySeq) || !songPickerOpen.value) return
      songPickerResults.value = list || []
      if (!list?.length) toast('没有找到相关歌曲', 'info')
    } catch (error) {
      if (!gates.picker.isCurrent(mySeq) || !songPickerOpen.value) return
      // b23 短链跳解出收藏夹时服务端回 favlist 字段——点歌台无导入
      // 落点，服务端文案「正在为你导入歌单」在此语境是误导，换指向性提示
      const errData = error?.data || error?.response?.data
      if (errData?.favlist) {
        toast('这是 B 站收藏夹链接，请在顶部搜索框粘贴导入', 'info')
        return
      }
      if (errData?.playlist) {
        toast('这是 YouTube 歌单链接，请在顶部搜索框粘贴导入', 'info')
        return
      }
      if (errData?.disstid) {
        toast('这是 QQ 歌单链接，请在顶部搜索框粘贴导入', 'info')
        return
      }
      console.error('点歌台失败:', error)
      toast(`${action}失败: ` + (apiErrorMessage(error)), 'error')
    } finally {
      if (gates.picker.isCurrent(mySeq)) songPickerSearching.value = false
    }
  }

  return {
    // atp 弹窗
    addTargetSong, newPlaylistName, atpInput, addablePlaylists,
    openAddToPlaylist, addSongToPlaylist, createPlaylistAndAdd,
    // 点歌台弹窗
    songPickerOpen, songPickerQuery, songPickerResults, songPickerSearching,
    songPickerAdded, songPickerPending, songPickerInput, pickerTakenIds,
    openSongPicker, closeSongPicker, addPickedSong, songPickerSearch,
  }
}

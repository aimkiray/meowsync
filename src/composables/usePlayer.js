import { ref, computed, watch, onBeforeUnmount, nextTick } from 'vue'
import { Howl, Howler } from 'howler'
import { musicApi, parseLyrics, mergeTranslations } from '../api/music.js'
import { downloadsApi } from '../api/downloads.js'
import { apiErrorMessage } from '../api/http.js'
import { aiApi } from '../api/ai.js'
import { readJSON, writeJSON, LS_KEYS } from '../lib/storage.js'
import { onRemoteApply } from '../lib/sync.js'
import { formatTime } from '../lib/format.js'
import { toast } from '../lib/feedback.js'
import { glitchBurst } from '../lib/theme.js'
import { httpsCover, isResolvableTrackId, NETEASE_ID_RE, YT_TRACK_ID_RE, BV_TRACK_ID_RE, QQ_SONG_ID_RE } from '../lib/url.js'
import { isEphemeralPlaylistId, isLocalPlaylistId, isFileTrackId, fileArtifactUrl, songCoverUrl, isUgcExternalTrack, externalArtistName, proxiedCoverUrl } from '../lib/song.js'
import { applyMatchResult } from '../lib/external-songs.js'
// MIRROR_PLAYLIST_ID_RE/isLikelyChineseLyric 未走 lib 转口（lib/url.js 转口表无它们）——直引共享层
import { MIRROR_PLAYLIST_ID_RE, isLikelyChineseLyric } from '../shared/predicates.js'
import { plainLyricLines } from '../shared/lrc.js'
import { LYRIC_ALIGN_MAX_LINES, LYRIC_ALIGN_MAX_LINE_CHARS } from '../shared/contracts.js'
import { SAVED_QUEUE_TRACK_CAP } from './usePlaylistLibrary.js'

// html5 池是全局常驻的 <audio> 元素组——预垫节点未置 src 不占媒体缓冲区，
// 成本仅 DOM 桩；单流播放没有并发需求，8 位余量只兜失败重试/快速切歌期
// 的在途节点
Howler.html5PoolSize = 8
// 池只在首个文档手势里由 howler 的 unlock 监听填充，且 _releaseHtml5Audio
// 只回收标了 _unlocked 的节点——存档恢复（autoplay:false 冷启即建 Howl）与
// ?mode=host 远端遥控都是零手势取流：空池 checkout 每次必打
// 「HTML5 Audio pool exhausted」伪警告，回退节点 unload 时又被弃置、池永远
// 填不上。照 unlock() 同构手法预垫满池：_unlocked 仅是「可回池」记账位，
// 播放可行性仍由 node.play() 现场判定（移动端真锁照旧走 onplayerror→手势
// 重试路径），垫池不改变解锁语义，只消伪警告噪音。
// 守卫即升级熔断：howler 私有面改名则静默退回现状
if (typeof Audio !== 'undefined' && typeof Howler._releaseHtml5Audio === 'function') {
  for (let i = Howler._html5AudioPool?.length ?? 0; i < Howler.html5PoolSize; i++) {
    // unlock() 填池同款防御：畸形 webview 的 new Audio() 构造抛错中止垫池
    // ——不该穿透模块 eval 杀 app
    try {
      const node = new Audio()
      node._unlocked = true
      Howler._releaseHtml5Audio(node)
    } catch { break }
  }
}

// 行菜单「重新匹配歌词」换绑/解绑通知：SongList 改写曲对象后调
// notifyLyricRematch 通知播放器（emit 接线表没有 rematch 通道且组件域不
// 许动 App.vue——跨组件通知走模块级单槽回调）。单槽而非订阅者集：usePlayer
// 仅 App 一处实例化，后注册覆盖旧槽即够；测试多次实例化也只有最新一只
// 响应，跨实例不串话。载荷捎词源 id（null=菜单侧解绑：用户显式否决错配
// 且无更准替代）、被换下/解绑的旧词源 id（vetoedId——进 matchVetoedIds
// 否决簿，供 rematchUnbound 并入 excludeIds 防它复活）与命中的 matched
// 回包本体（第 4 参可缺省——命中时正播侧曲对象经 applyMatchResult 整组
// 重建 name/al/证据，与菜单侧口径齐）：正播的曲对象与菜单侧写过的对象
// 不一定是同一引用（搜索队列/快照来源不同），播放器侧那份要单独补写
let lyricRematchHandler = null
export const notifyLyricRematch = (trackId, neteaseId, vetoedId, matched) => {
  lyricRematchHandler?.(trackId, neteaseId, vetoedId, matched)
}

// 遥控 seek 的「已播完」销账口（上行 notifyLyricRematch 同款模块级单槽）：
// useRemoteControl 的 seek 指令直写 howl.seek+currentTime、不走 seekTo——
// pendingSeekTime 是 usePlayer 闭包私有值，而 deps 接线表在 App.vue（不含
// 本通道且该文件不在改动域）。usePlayer 仅 App 一处实例化，后注册覆盖旧槽
// 即够；调用语义=「外部显式 seek 已落地，销挂账让落盘写真播放位」
let remoteSeekSettleHandler = null
export const notifyRemoteSeek = () => {
  remoteSeekSettleHandler?.()
}

// 播放器内核域：Howler 生命周期（看门狗/中止/竞态陈旧）、播放队列
// （shuffle 物理打乱+原序备份/插播/拖拽/清空）、上一首/下一首/播完接续、
// 歌词管线（拉取/CJK 判定/AI 校验翻译/时间校准持久化）、进度与音量、
// MediaSession、播放状态 localStorage 存档与恢复。
//
// deps（App 注入的跨域共享）：
//   gates / playingPlaylistId — 竞态闸与队列归属（库域同持）
//   userPlaylists / selectedPlaylist / selectPlaylist / savePlaylistsToStorage — 库域
//   filteredSongs — App computed（当前歌单可见曲集，播放上下文快照源）
//   showVipSongs / fullscreenLyricMode — UI 偏好（存档写回）
//   recordPlayHistory / recordPlaylistHistory — useHomeFeed
//   nav — useSearchNav 惰性转发（nav 实例化在本 composable 之后，必须 thunk）：
//     enterWatch / openWatchSong / selectPlaylistAndShow / setSidebarOpen / getSearchSongResults
export function usePlayer({
  gates,
  playingPlaylistId,
  userPlaylists, selectedPlaylist,
  selectPlaylist, savePlaylistsToStorage,
  filteredSongs,
  showVipSongs, fullscreenLyricMode,
  recordPlayHistory, recordPlaylistHistory,
  enterWatch, openWatchSong, selectPlaylistAndShow,
  setSidebarOpen, getSearchSongResults,
}) {
    const currentSong = ref(null)

    const playMode = ref('list') // 播放模式：'list'(列表播放), 'loop'(列表循环), 'single'(单曲循环)
    // 随机播放是独立于 playMode 的正交开关（YTM 同款：shuffle 直接物理打乱播放队列）
    const shuffleOn = ref(false)
    let queueOriginalOrder = null // 打乱前的队列原序——关掉随机时还原

    const lyrics = ref([])
    const currentLyricIndex = ref(0)
    // 歌词时间校准（ms，正值=提前显示，同 LRC [offset:] 约定）——
    // 按歌词源 id 存服务端 song_lyric_meta，跨歌单/跨壳共享同一词源的校准
    const lyricOffsetMs = ref(0)

    const autoplayOn = ref(false)

    const songSwitching = ref(false) // 歌曲切换提示
    const isPlaying = ref(false)
    const isFullscreenPlayerOpen = ref(false)
    const currentTime = ref(0)
    const duration = ref(0)
    const volume = ref(80)
    const durationWarning = ref('')
    const playbackError = ref('') // 播放失败的可见错误（解锁失败/加载超时/被自动播放策略拦截）
    const loadingLyrics = ref(false)
    // 手动词务在途闸（「获取歌词」/「生成滚动词」共用一把）：防重入 +
    // 工具条 busy 态。与 loadingLyrics（自动加载态）分立——手动链自己
    // 管终态文案，不借自动加载的空态框
    const lyricFetching = ref(false)
    // 播放上下文快照：播 A 歌单时浏览 B 歌单不应劫持上一首/下一首/播完接续。
    // playSong 默认把当时的 filteredSongs 定格为播放队列，歌单内导航传 preserveContext 复用
    const playingSongs = ref([])

    // Howler 加载看门狗：CDN 黑洞时 onload/onloaderror 都不会触发，
    // 没有它 songSwitching 会永久卡住播放键
    const PLAYBACK_LOAD_TIMEOUT_MS = 20000

    const PLAYER_STATE_STORAGE_KEY = LS_KEYS.PLAYER_STATE

    let lastSavedWholeSecond = -1

    let howl = null
    let lyricTimer = null
    // 词同步计时器唯一清表口（暂停/切歌/无戳词/卸载共用）——暂停期间
    // 100ms 空转 tick 是无谓唤醒，清表+onplay 重建（startLyricSync 处）
    const stopLyricSync = () => {
      if (lyricTimer) {
        clearInterval(lyricTimer)
        lyricTimer = null
      }
    }
    let progressRafId = null
    let howlWatchdog = null // 加载看门狗定时器（随每个新 Howl 重置）
    let currentAbortController = null // 用于取消正在进行的网络请求
    let currentPlayingId = null // 当前正在播放的歌曲ID，用于防止竞态条件
    // playSong 代次戳（lyricLoadSeq 同构手法）：同曲连点/兜底链递归续播时
    // currentPlayingId 不变、controller 也可能已被正常解绑，都分不开两代
    // ——兜底链各处闸用它判「本代仍是最新」（seq===playSeq 蕴含
    // currentPlayingId===song.id，比 id 判严格）
    let playSeq = 0

    let volumeSaveTimer = null
    // 待落地 seek 挂账：playSong 先把 currentTime 清 0，恢复用的 seekTime 要等
    // onload 才写回——挂账期内一切落盘仍写挂账值，否则存档续播点被 0 覆盖
    let pendingSeekTime = null
    // 远端续播位挂账（pendingSeekTime 同款「写盘写挂账不写内存」手法）：
    // 远端 player-state 落 LS 后只灌了 UI 偏好，恢复位（currentSongId/
    // currentTime/歌单归属）留在存档里待重启/下次恢复消费——消费前任何
    // 本地整文写盘（音量/偏好写回等）会把这些字段抹成空值还广播出去；
    // 挂了账就照账补写，本地真起播即销账
    let pendingRemoteResume = null
    // 恢复窗口（restoreUiState→restorePlaybackState）内禁止持久化：UI 态
    // 还原会触发 prefs watcher 冲刷 savePlayerStateToStorage，此刻
    // currentSong 尚为 null——写出 {currentSongId:null,currentTime:0}
    // 会把存档续播点整个抹掉。App.vue 初始化用 try/finally 包住该窗口
    let playerPersistSuspended = false
    const setPlayerPersistSuspended = (v) => { playerPersistSuspended = !!v }

    const savePlayerStateToStorage = () => {
      if (playerPersistSuspended) return
      const state = {
        selectedPlaylistId: selectedPlaylist.value?.id ?? null,
        // 播放队列归属歌单：播 A 浏览 B 时刷新恢复应回到 A，
        // 存浏览态 id 会让恢复在 B 里找不到这首歌而静默放弃
        playingPlaylistId: playingPlaylistId.value ?? selectedPlaylist.value?.id ?? null,
        currentSongId: currentSong.value?.id ?? null,
        currentTime: pendingSeekTime ?? (Number.isFinite(currentTime.value) ? currentTime.value : 0),
        volume: Number.isFinite(volume.value) ? volume.value : 80,
        playMode: playMode.value,
        shuffleOn: shuffleOn.value,
        showVipSongs: showVipSongs.value,
        autoplayOn: autoplayOn.value,
        isFullscreenPlayerOpen: isFullscreenPlayerOpen.value,
        fullscreenLyricMode: fullscreenLyricMode.value
      }
      // 无正播曲且有远端续播挂账：恢复位四字段照账写——否则此刻的本地
      // 存档会以 currentSongId:null 把远端续播位整文抹掉（还广播空值）
      if (!currentSong.value && pendingRemoteResume) {
        state.selectedPlaylistId = pendingRemoteResume.selectedPlaylistId
        state.playingPlaylistId = pendingRemoteResume.playingPlaylistId
        state.currentSongId = pendingRemoteResume.currentSongId
        state.currentTime = pendingRemoteResume.currentTime
      }

      writeJSON(PLAYER_STATE_STORAGE_KEY, state)
    }

    const loadPlayerStateFromStorage = () => {
      const parsed = readJSON(PLAYER_STATE_STORAGE_KEY)
      return parsed && typeof parsed === 'object' ? parsed : null
    }

    const savePlaybackTimeIfNeeded = (force = false) => {
      if (!currentSong.value) return

      const wholeSecond = Math.floor(currentTime.value || 0)
      if (!force && wholeSecond === lastSavedWholeSecond) return

      lastSavedWholeSecond = wholeSecond
      savePlayerStateToStorage()
    }

    const restoreUiState = (savedState) => {
      if (!savedState) return

      // 拦截 Infinity/越界脏数据（如 1e999 经 JSON.parse 还原为 Infinity），避免 howl.volume() 抛异常
      if (Number.isFinite(savedState.volume)) {
        volume.value = Math.max(0, Math.min(100, savedState.volume))
        // 音量是「ref + 实例」双写才生效——远端应用只落 ref 会出现
        // 「界面 33 实际 80」两张皮（冷恢复 howl 未建无操作，实例音量
        // 由 playSong 建 Howl 时按 volume.value 初始化接管）
        if (howl) howl.volume(volume.value / 100)
      }
      if (typeof savedState.playMode === 'string') playMode.value = savedState.playMode
      // 远端 shuffle 翻转要与 toggleShuffle 同构真重排——只落 flag 是
      // 「界面随机/队列顺序」两张皮；flag 无变化跳过（同值重排是白洗牌）
      if (typeof savedState.shuffleOn === 'boolean' && savedState.shuffleOn !== shuffleOn.value) {
        applyShuffleState(savedState.shuffleOn)
      }
      if (typeof savedState.showVipSongs === 'boolean') showVipSongs.value = savedState.showVipSongs
      if (typeof savedState.autoplayOn === 'boolean') autoplayOn.value = savedState.autoplayOn
      if (typeof savedState.fullscreenLyricMode === 'string') fullscreenLyricMode.value = savedState.fullscreenLyricMode
    }

    const restorePlaybackState = async (savedState) => {
      if (!savedState?.currentSongId) return
      // 优先按播放队列所属歌单恢复（播 A 浏览 B 的场景），兼容旧存档回落
      // 浏览态；死 id（被 FIFO 修剪/手动删的 saved_queue_ 等）要跳过而非
      // 挡死回落——按序逐个 resolve 到库里真实存在的单
      const playlist = [savedState?.playingPlaylistId, savedState?.selectedPlaylistId]
        .map(id => id != null && userPlaylists.value.find(p => String(p.id) === String(id)))
        .find(Boolean)
      if (!playlist) return

      const selected = await selectPlaylist(playlist)
      if (!selected) return // 恢复被更新的选择抢占或歌单加载失败，不继续播放

      // 在 filteredSongs（= 将要被拍进播放快照的列表）中定位，保证恢复的
      // 歌曲一定在播放队列里；用 songs 会漏掉 VIP 过滤，导致快照里没有当前歌、
      // 下一首跳回队首
      const restoredSongs = filteredSongs.value
      if (!restoredSongs.length) return

      // 仅按歌曲ID定位：索引兜底会在歌曲被移除后错播同位置的其他歌
      const restoredIndex = restoredSongs.findIndex(song => String(song.id) === String(savedState.currentSongId))
      if (restoredIndex === -1) {
        console.log('⏭️ 上次播放的歌曲已不在该歌单中（或被 VIP 过滤隐藏），放弃恢复播放')
        return
      }

      const restoredSong = restoredSongs[restoredIndex]

      // 沉浸层 flag 先于 playSong 落地：恢复路径含网络跳（getSongUrl/loadLyrics），
      // 落地晚会让 watch 页在层盖上前先挂一次 <video> 白拉流
      if (savedState.isFullscreenPlayerOpen) {
        isFullscreenPlayerOpen.value = true
      }

      await playSong(restoredSong, {
        autoplay: false,
        seekTime: Number.isFinite(savedState.currentTime) ? savedState.currentTime : 0
      })
    }

    const clearHowlWatchdog = () => {
      if (howlWatchdog) {
        clearTimeout(howlWatchdog)
        howlWatchdog = null
      }
    }

    // 当前生效的播放队列：优先播放快照（播放中浏览其他歌单不串台），
    // 无快照时回退当前浏览列表（播放前导航路径）
    const playbackList = () =>
      playingSongs.value.length > 0 ? playingSongs.value : filteredSongs.value

    // ── 队列管理（YTM UP NEXT 语义） ──
    // playingSongs 即"播放中的队列"：shuffle 物理打乱它，下一首播放直接往里面插，
    // 恢复/广播/上下首都复用同一份数据，不需要第二套队列概念

    const shuffleArray = (arr) => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]]
      }
      return arr
    }

    // 建立新队列：shuffle 开着时把 anchor（点的那首）放队首、其余打乱；
    // queueOriginalOrder 存打乱前原序供还原
    const setQueue = (list, anchorSong = null) => {
      const base = list.slice()
      queueOriginalOrder = base.slice()
      if (shuffleOn.value) {
        if (anchorSong && base.some(s => String(s.id) === String(anchorSong.id))) {
          const rest = base.filter(s => String(s.id) !== String(anchorSong.id))
          playingSongs.value = [anchorSong, ...shuffleArray(rest)]
        } else {
          playingSongs.value = shuffleArray(base)
        }
      } else {
        playingSongs.value = base
      }
    }

    // shuffle 置位/复位的同构重排：toggleShuffle 手动切换与 restoreUiState
    // 远端置位共用——远端快照说 shuffleOn=true 时当前队列须真打乱，否则
    // UI 显示随机态而队列仍顺序播（「只写 ref 不落副作用」病灶）。空队列
    // 不把当前曲塞进队列变成"只有一首"——next 会误判队列耗尽停播
    const applyShuffleState = (on) => {
      shuffleOn.value = !!on
      if (!playingSongs.value.length) {
        queueOriginalOrder = null
        return
      }
      if (shuffleOn.value) {
        queueOriginalOrder = playingSongs.value.slice()
        const cur = currentSong.value
        if (cur) {
          const rest = playingSongs.value.filter(s => String(s.id) !== String(cur.id))
          playingSongs.value = [cur, ...shuffleArray(rest)]
        } else {
          playingSongs.value = shuffleArray(playingSongs.value.slice())
        }
      } else if (queueOriginalOrder?.length) {
        playingSongs.value = queueOriginalOrder.slice()
        // 当前曲不在备份里（队列外来源等）——按 setQueue 锚定语义插回队首，
        // 两表同步维持同 id 集；丢了它 currentPlayingIndex=-1，
        // 高亮/上下首/播完接续全失据
        const cur = currentSong.value
        if (cur && !playingSongs.value.some(s => String(s.id) === String(cur.id))) {
          playingSongs.value.unshift(cur)
          queueOriginalOrder.unshift(cur)
        }
      }
    }

    const toggleShuffle = () => {
      applyShuffleState(!shuffleOn.value)
      savePlayerStateToStorage()
    }

    // 队列抽屉点歌：快照内导航（preserveContext 保住队列不被重拍）
    const queueJump = (index) => {
      const song = playingSongs.value[index]
      if (song) playSong(song, { preserveContext: true })
    }

    // 从队列移除（当前播放行不可删——WatchView 已隐藏按钮，这里兜底）
    const queueRemove = (index) => {
      const list = playingSongs.value
      if (index < 0 || index >= list.length) return
      if (index === currentPlayingIndex()) return
      const removed = list[index]
      list.splice(index, 1)
      // 原序备份同步删：否则关掉随机后被删的歌会复活
      if (queueOriginalOrder) {
        const oi = queueOriginalOrder.findIndex(s => String(s.id) === String(removed.id))
        if (oi !== -1) queueOriginalOrder.splice(oi, 1)
      }
      playingSongs.value = list.slice() // 触发 watch → 远端广播
    }

    // ⋯ 菜单「下一首播放」：插到当前曲之后（已在队列里的先挪走——移动语义，避免同 id 双份）
    const playNextInQueue = (song) => {
      if (!song || song.id == null) return
      if (!currentSong.value || playingSongs.value.length === 0) {
        openWatchSong(song)
        return
      }
      if (String(song.id) === String(currentSong.value.id)) return
      const oldIdx = playingSongs.value.findIndex(s => String(s.id) === String(song.id))
      if (oldIdx !== -1) playingSongs.value.splice(oldIdx, 1)
      const cur = currentPlayingIndex()
      // 当前曲不在快照里（id 被移出/队列是外部来源）时插到队尾而非 splice(-1+1) 队首
      playingSongs.value.splice(cur === -1 ? playingSongs.value.length : cur + 1, 0, song)
      if (queueOriginalOrder) {
        const oi = queueOriginalOrder.findIndex(s => String(s.id) === String(song.id))
        if (oi !== -1) queueOriginalOrder.splice(oi, 1)
        const curOrig = queueOriginalOrder.findIndex(s => String(s.id) === String(currentSong.value.id))
        queueOriginalOrder.splice(curOrig === -1 ? queueOriginalOrder.length : curOrig + 1, 0, song)
      }
      playingSongs.value = playingSongs.value.slice()
    }

    // ⋯ 菜单「加入队列末尾」
    const addToQueueEnd = (song) => {
      if (!song || song.id == null) return
      if (!currentSong.value || playingSongs.value.length === 0) {
        openWatchSong(song)
        return
      }
      // id 唯一性：currentPlayingIndex 按 id 定位，同 id 双份会让高亮/接续错乱
      const oldIdx = playingSongs.value.findIndex(s => String(s.id) === String(song.id))
      if (oldIdx !== -1) playingSongs.value.splice(oldIdx, 1)
      playingSongs.value.push(song)
      if (queueOriginalOrder) {
        const oi = queueOriginalOrder.findIndex(s => String(s.id) === String(song.id))
        if (oi !== -1) queueOriginalOrder.splice(oi, 1)
        queueOriginalOrder.push(song)
      }
      playingSongs.value = playingSongs.value.slice()
    }

    // 「播放全部/随机」hero 按钮：队首（或随机锚点）起播，快照当前过滤列表。
    // 空单返回 false——调用方据此不跳 watch（否则落在空 watch 页死胡同）
    const playPlaylist = (shuffle = false) => {
      const list = filteredSongs.value
      if (!list.length) {
        toast('歌单还没有歌曲，先添加几首吧', 'info')
        return false
      }
      if (shuffle) shuffleOn.value = true
      const anchor = shuffle ? list[Math.floor(Math.random() * list.length)] : list[0]
      playSong(anchor) // 非 preserveContext → playSong 内 setQueue 重拍快照
      return true
    }

    // 搜索结果页点歌：队列 = 本次搜索的单曲结果，而非当前浏览歌单
    const playSongFromSearch = (song) => {
      setQueue(getSearchSongResults(), shuffleOn.value ? song : null)
      playingPlaylistId.value = null // 队列不归属任何歌单
      playSong(song, { preserveContext: true })
    }

    // 侧栏歌单行悬停 ▶：选歌单（不换主区视图），加载完即播
    const playPlaylistFromSidebar = async (playlist) => {
      const ok = await selectPlaylist(playlist)
      if (!ok) return
      // 判空早于关抽屉/进 watch——no-op 点击不该带着合上抽屉的副作用
      if (!playPlaylist(false)) return // 空单：toast 在 playPlaylist 内
      setSidebarOpen(false)
      enterWatch() // 点歌单播放即进入 watch 页（YTM 同款导航）
    }

    // 队列抽屉「正在播放：X」来源名——队列无归属（搜索结果/删库歌单）时
    // 不冒用浏览中的歌单名
    const queueTitle = computed(() => {
      const owner = userPlaylists.value.find(p => String(p.id) === String(playingPlaylistId.value))
      if (owner) return owner.name
      return playingPlaylistId.value ? '未知歌单' : '当前队列'
    })

    // YTM「Playing from」来源名可点回歌单页——归属歌单仍在库时才给链接
    const queueOwner = computed(() =>
      userPlaylists.value.find(p => String(p.id) === String(playingPlaylistId.value)) || null
    )
    const openQueueSource = () => {
      if (queueOwner.value) selectPlaylistAndShow(queueOwner.value)
    }

    // 队列归属播放上下文物件（单曲分享壳/saved_queue_* 队列快照）——底栏据此禁用随机键；
    // local_pl_* 用户歌单不在此列（是正经歌单，随机可用）
    const playerIsTemp = computed(() => isEphemeralPlaylistId(playingPlaylistId.value))


    // 队列拖拽排序：from→to 实时移动；原序备份做同构移动（关随机后顺序不回弹）
    const queueMove = ({ from, to }) => {
      const list = playingSongs.value
      if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return
      const [moved] = list.splice(from, 1)
      list.splice(to, 0, moved)
      if (queueOriginalOrder && queueOriginalOrder.length) {
        const oi = queueOriginalOrder.findIndex(s => String(s.id) === String(moved.id))
        if (oi !== -1) {
          const [m] = queueOriginalOrder.splice(oi, 1)
          // 邻居锚定：to 是打乱坐标系，当下标插进原序表是两套坐标混用
          // （原序下标与打乱下标无语义对应）。moved 在打乱序里的新前驱
          // 是谁，它在原序里就跟在谁后面——两表邻里关系同构，关随机后
          // 顺序不回弹错位。拖到队首无前驱（或前驱不在备份）→ 插原序头
          const prevId = to > 0 ? list[to - 1]?.id : null
          const ai = prevId == null ? -1
            : queueOriginalOrder.findIndex(s => String(s.id) === String(prevId))
          queueOriginalOrder.splice(ai === -1 ? 0 : ai + 1, 0, m)
        }
      }
      playingSongs.value = list.slice()
    }

    // 清空队列（保留当前播放曲）
    const clearQueue = () => {
      if (!currentSong.value) { playingSongs.value = []; queueOriginalOrder = null; return }
      playingSongs.value = [currentSong.value]
      if (queueOriginalOrder) {
        queueOriginalOrder = queueOriginalOrder.filter(s => String(s.id) === String(currentSong.value.id))
      }
      savePlayerStateToStorage()
    }

    // 把当前队列存成新歌单（本地内存态——网易侧无持久行，id 用 saved_queue_ 前缀）
    const saveQueueAsPlaylist = () => {
      if (!playingSongs.value.length) return
      const first = playingSongs.value[0]
      // tracks 封顶防单条爆配额——长歌单全量快照一份就是 MB 级持久化负载
      const capped = playingSongs.value.length > SAVED_QUEUE_TRACK_CAP
      const pl = {
        id: `saved_queue_${Date.now()}`,
        name: `${queueTitle.value} · 队列`,
        coverImgUrl: songCoverUrl(first) || '',
        creator: { nickname: '我的队列' },
        trackCount: capped ? SAVED_QUEUE_TRACK_CAP : playingSongs.value.length,
        tracks: playingSongs.value.slice(0, SAVED_QUEUE_TRACK_CAP),
        isLocal: true
      }
      userPlaylists.value.unshift(pl)
      savePlaylistsToStorage()
      toast(capped ? `已存为歌单「${pl.name}」（截取前 ${SAVED_QUEUE_TRACK_CAP} 首）` : `已存为歌单「${pl.name}」`, 'success')
    }


    // 相关 tab 点歌：YTM 以相关流接续——整个相关列表进队列（autoplay off 时队尾也有下一首）
    const playSongFromRelated = (song, list) => {
      const seed = Array.isArray(list) && list.length ? list.slice() : [song]
      setQueue(seed, null)
      playingPlaylistId.value = null
      playSong(song, { preserveContext: true })
    }

    // 队尾追加的统一写点：playingSongs 与 shuffle 原序备份同步追加——
    // 只写一边的话，关随机时旧备份整体替换会把追加曲（含正在播放的）抹掉
    const pushTail = (list) => {
      playingSongs.value = [...playingSongs.value, ...list]
      if (queueOriginalOrder) queueOriginalOrder.push(...list)
    }

    // autoplay：自然播完且队列耗尽时，拉当前艺人相关歌接进队列继续播。
    // in-flight 去重只合流同代调用：自动/手动两入口或队尾连点在一代内
    // 共享一张票，各发各的 RTT 落地会双份 pushTail。票的种子（当前艺人）
    // 在立案那刻读取——换代后旧票种子已属旧曲，绝不能「收养」进新代
    // （落地会拿旧艺人的相关歌劫持新队列）；新代来调用则另立新票新种子，
    // 旧票随其 RTT 落地被代次闸弃。代次闸：落地前复查 ticket.seq——RTT
    // 窗内用户切歌/卸载（playSeq 换代）时 pushTail+playSong 会劫持新代
    // 队列复活出声；seq 失配返回 true 抑制调用方的 stopAtQueueEnd——
    // 此刻停下的是新代实例，不是本代该收的尾
    let relatedContinuation = null
    const continueWithRelated = () => {
      if (relatedContinuation && relatedContinuation.seq === playSeq) {
        return relatedContinuation.p
      }
      const ticket = { seq: playSeq, p: null }
      const p = (async () => {
        try {
          const artist = (currentSong.value?.ar || currentSong.value?.artists || [])[0]?.name
          if (!artist) return false
          const list = await musicApi.searchSongs(artist, 15)
          // 换代即弃：不得动 playingSongs（可能已是新代重拍的队列），也不得
          // playSong 把人拉回旧代——true 让调用方静默收尾（世界已归新代）
          if (ticket.seq !== playSeq) return true
          const exist = new Set(playingSongs.value.map(s => String(s.id)))
          const fresh = (list || []).filter(s => s?.id != null && !exist.has(String(s.id)))
          if (!fresh.length) return false
          pushTail(fresh)
          playSong(fresh[0], { preserveContext: true })
          return true
        } catch {
          return false
        } finally {
          if (relatedContinuation === ticket) relatedContinuation = null
        }
      })()
      ticket.p = p
      relatedContinuation = ticket
      return p
    }

    // 下载寻址兜底单扫描（downloadCurrentSong 与 playDownloadedCopy 成员
    // 预检共用口径）：队列插入/相关接续曲只进 playingSongs 不落户歌单，拿
    // 归属单提交服务端按单查曲必 404「歌曲不存在」——全库找一张曲目含该
    // 曲且 id 形态可提交的单顶替寻址。数字 id 与镜像形态 local_pl_/
    // saved_queue_ 服务端 resolvePlaylistId/findExistingPlaylistId 都解得
    // 出；single_song_ 壳与杂形被形态闸滤掉，扫到也没用
    const findDownloadAddrPlaylist = (song) =>
      userPlaylists.value.find(p =>
        (NETEASE_ID_RE.test(String(p.id)) || MIRROR_PLAYLIST_ID_RE.test(String(p.id)))
        && p.tracks?.some(t => String(t.id) === String(song.id)))

    // 静音切换：记住静音前的音量，恢复时回填
    let mutedVolume = 0
    const toggleMute = () => {
      if (volume.value > 0) {
        mutedVolume = volume.value
        updateVolume(0)
      } else {
        updateVolume(mutedVolume > 0 ? mutedVolume : 80)
      }
    }

    // 在线流彻底失效后的兜底（SABR 闸控的 YouTube 自适应流/签名批量耗尽、
    // 本地档解码再败的实际救法）：先查服务器有没有已下载工件，没有就触发
    // 服务器下载、完成后续播本地文件——用户口径「不能在线放就先下载下来」。
    // 只对自有源外部曲开放（onloaderror 的 ownSource 闸收编，yt 在内——
    // /youtube/stream 经 YT_PROXY 恢复在线位后，本链仍是它两级败亡的退路）；
    // 新一代 playSong 起锚（切歌或同曲重进，playSeq 换代）即整链作废——
    // seq 判比 currentPlayingId 严，同 id 两代连点也压得住旧代。
    // 声明序在 playSong 之前只是历史位置：调用点如今全是惰性回调，不再依赖
    const playDownloadedCopy = async (song, playlistId, options, seq) => {
      if (seq !== playSeq) return
      songSwitching.value = true // 下载等待期维持切换态——底栏别装死
      try {
        // audioReady 是工件维度判定（音频档在盘即可）——比全工件合取的
        // downloaded 松：歌词/封面档缺失不该挡住在盘的 mp3/m4a；跨歌单
        // 寻址回带命中行的 audioPlaylistId 作 /file 寻址键（暂存/搜索
        // 队列的播放没有归属单也能找到别单的档）
        const st = await downloadsApi.getSongDownloadStatus(playlistId, song.id).catch(() => null)
        // 等状态期间播放已换代（切歌/同曲重进）：静默弃——不得再落
        // toast/镜像/真提交下载任务（下载任务最长跑几分钟，没人等的提交是纯浪费）
        if (seq !== playSeq) return
        // audioPlaylistId != null 闸与播放探测同口径：audioReady 为真但寻址键
        // 缺席时按「没档」走提交下载路径，绝不能把 undefined 钉进 _localFile
        // （undefined 的 _localFile 等于没钉——在线链再败会无限回环本函数）。
        // _localTried 命中的同一行档不重钉——刚败过的坏档直连只会再败一次，
        // 转交提交下载路径还有重下/别单档自愈的机会
        let audioPlId = st?.data?.audioReady === true && st.data.audioPlaylistId != null
          && st.data.audioPlaylistId !== options._localTried
          ? st.data.audioPlaylistId : null
        if (audioPlId === null) {
          // 成员预检（downloadCurrentSong 同口径）：寻址单曲目表在而在播曲
          // 不在（「下一首播放/队尾加入/相关接续」只进 playingSongs 不落户
          // 歌单）时提交必 404——扫全库找一张曲目含该曲的可提交单顶替寻址；
          // 扫不到直落失败终态（本链是自愈兜底不另发 toast），不白跑必败
          // 提交。寻址对象缺席/缺 tracks 按无法验证放行，交下方形态闸与
          // 服务端成员校验兜底
          let pl = (selectedPlaylist.value && String(selectedPlaylist.value.id) === String(playlistId))
            ? selectedPlaylist.value
            : userPlaylists.value.find(p => String(p.id) === String(playlistId))
          if (Array.isArray(pl?.tracks) && !pl.tracks.some(t => String(t.id) === String(song.id))) {
            pl = findDownloadAddrPlaylist(song) ?? null
            if (!pl) {
              songSwitching.value = false
              playbackError.value = '音频加载失败，点击播放键或重新点歌可重试'
              return
            }
            playlistId = pl.id // 顶替寻址：探测/提交/轮询全换这张单
          }
          // 提交前先验寻址键形态：服务端 resolvePlaylistId 只接数字 id
          // （库行命中/走上游导入）与镜像形态 local_pl_/saved_queue_
          // （下方补镜像后按 neteasePlaylistId 命中）。空值/single_song_
          // 壳/其它杂形提交必 400——「先下载再播」预告完紧接着报错是
          // 自相矛盾，直落失败终态不白跑。探测命中档不受此限：
          // audioPlaylistId 跨歌单寻址本就不消费 playlistId
          const plKey = String(playlistId ?? '')
          if (!NETEASE_ID_RE.test(plKey) && !MIRROR_PLAYLIST_ID_RE.test(plKey)) {
            songSwitching.value = false
            playbackError.value = '音频加载失败，点击播放键或重新点歌可重试'
            return
          }
          toast('在线源不可用，先下载到服务器再播…', 'info')
          // 未镜像的本地单先补镜像（幂等：内容签名未变时服务端直接短路
          // 返回）。过了形态闸只剩 local_pl_/saved_queue_ 可能配到 pl——
          // 数字 id 的 isLocalPlaylistId=false 不镜像，服务端自有导入路径；
          // 顶替寻址命中的兜底单同样要把曲目表镜像上去服务端才认得出成员
          if (pl && isLocalPlaylistId(pl.id)) await downloadsApi.mirrorLocalPlaylist(pl).catch(() => null)
          // mirror RTT 窗内播放可能已换代——旧代不替没人等的歌提交孤儿下载任务
          if (seq !== playSeq) return
          let submitted = null
          try {
            submitted = await downloadsApi.downloadSongToServer(playlistId, song.id, {
              bitrate: 320000,
              // yt 可视曲连视频档一起下——本地档仍是 WatchView 视频位的首选源
              // （不撞 CDN 闸控，在线流只是其缺席时的回落位）。谓词与
              // useServerDownloads.canServerVideo 的 yt 支同口径：
              // hasDownloadableVideo 兜住 vp9/av01 独占稿（服务端下载链能合流
              // mp4），hasVideo 兼容无新字段的旧数据；song.youtube?. 天然限定
              // YT 域，bv_/qq_ 曲该位恒 false，行为不变
              downloadVideo: song.youtube?.hasDownloadableVideo === true
                || song.youtube?.hasVideo === true
            })
          } catch (e) {
            // 409 = 该曲任务已在跑（含队列挡牌/歌单删除窗）——不是失败：
            // 既有任务继续下，直接进下方轮询等档落；轮询里 task===null 会
            // 自然 break 到「服务器下载仍在进行」文案。其余错误照常穿透
            if (e?.response?.status !== 409) throw e
          }
          audioPlId = submitted?.data?.status === 'completed' ? playlistId : null
          // 提交即返回——终态轮询确认（音频档秒级完事，封顶 3min 防无限挂起）
          const deadline = Date.now() + 3 * 60 * 1000
          // 连续失联按停机收束、单抖不判死：探测抛错（停机/断网）只得 null，
          // 攒满 4 次（≈6s）即 break 落「仍在进行」文案，不硬撑到 deadline
          let nullPolls = 0
          while (audioPlId === null && Date.now() < deadline && seq === playSeq) {
            await new Promise(r => setTimeout(r, 1500))
            const st2 = await downloadsApi.getSongDownloadStatus(playlistId, song.id).catch(() => null)
            // data 缺省的 200 回包（网关掐 body/代理截断）与探测失联同计——
            // 内容不可读即失联，攒满阈值收束而非空轮撑到 deadline
            if (st2?.data == null) { if (++nullPolls >= 4) break; continue }
            nullPolls = 0
            if (st2.data.audioReady === true) { audioPlId = st2.data.audioPlaylistId ?? playlistId; break }
            const ts = st2.data.task?.status
            if (ts === 'failed' || st2.data.task === null) break
          }
        }
        if (seq !== playSeq) return // 等下载期间播放已换代——静默弃
        if (audioPlId === null) {
          songSwitching.value = false
          playbackError.value = '在线源不可用，服务器下载仍在进行——完成后可重播'
          return
        }
        toast('已切换本地已下载文件播放', 'info')
        // void 标弃返 promise（与两处 playDownloadedCopy 调用点同口径）：新代
        // playSong 同步前缀抛错不挂 void 会成 unhandled rejection
        void playSong(song, { ...options, preserveContext: true, _streamRetried: true, _localFile: audioPlId })
      } catch {
        // 代次闸：同 id 连点的旧代 catch 不得把错误文案写进新代的界面
        if (seq === playSeq) {
          songSwitching.value = false
          playbackError.value = '音频加载失败，点击播放键或重新点歌可重试'
        }
      }
    }

    // 歌曲播放逻辑
    // 注意竞态防护：controller/howl 均使用局部引用，所有回调只操作自己的实例，
    // 每个 await 之后都必须重新检查 abortSignal.aborted / currentPlayingId。
    // preserveContext=true 表示本次切歌属于播放队列内导航（上一首/下一首/远端点歌），
    // 沿用已有快照；默认则从当前浏览列表拍新快照。
    const playSong = async (song, options = {}) => {
      if (!song || song.id == null) return
      gates.mediaImport.invalidate() // 用户点了别的歌——同上，作废在途外部媒体解析
      gates.preview.invalidate()     // 同上，作废在途的 id 预览
      let { autoplay = true, seekTime = 0, preserveContext = false } = options
      // resumeSeek（远端 play 的实例重建路径走它）：与本地 togglePlay 的
      // !howl 分支同口径——续播 seek 尚未落地实例就死了，挂账值优先于已被
      // 清零的 currentTime。在入口就地换算成 seekTime，739 挂账与 858
      // 落地两处下游零改动
      if (options.resumeSeek) seekTime = pendingSeekTime ?? currentTime.value

      console.log('🎵 播放歌曲:', song.name)

      // 设置当前播放的歌曲ID，用于防止竞态条件
      currentPlayingId = song.id
      // 代次升号：同 id 连点/递归续播靠它区分新旧链（currentPlayingId 分不开）
      const mySeq = ++playSeq
      // 词务代次快照：本代若走不到 loadLyrics（其 ++lyricLoadSeq 处即复
      // 位），终态补清 lyricFetching 前先确认锁仍属旧代——期间新开的手
      // 动词务（代次已升）的锁由它自己 finally 管，抢清会提前解新代的锁
      const lyricSeqAtEntry = lyricLoadSeq

      // 取消上一个正在进行的网络请求
      if (currentAbortController) {
        console.log('🚫 取消上一个歌曲的网络请求')
        currentAbortController.abort()
      }
      const myController = new AbortController()
      currentAbortController = myController
      const abortSignal = myController.signal

      try {
        // 设置歌曲切换状态
        songSwitching.value = true
        durationWarning.value = ''
        playbackError.value = ''

        // 拍播放队列快照：之后用户浏览/切换歌单不影响上一首/下一首/播完接续。
        // 快照为空时即使 preserveContext 也要补拍——否则远端点歌作为首次播放
        // 会让队列永远退化成 live filteredSongs，浏览切单照样劫持接续
        if (!preserveContext || playingSongs.value.length === 0) {
          // shuffle 开着时快照即被打乱（点的那首锚定队首）
          setQueue(filteredSongs.value, shuffleOn.value ? song : null)
          playingPlaylistId.value = selectedPlaylist.value?.id ?? null
        }

        // 播即收藏：播放认领了某歌单上下文（playingPlaylistId 指向它）才入库——
        // restorePlaybackState 只查库，不入库则刷新后播放位置随 selectedPlaylistId
        // 蒸发。preserveContext 的队列跳转（下一首/远端遥控）不认领当前预览单——
        // 「浏览+动队列」不应等于收藏
        if (
          selectedPlaylist.value &&
          playingPlaylistId.value != null &&
          String(playingPlaylistId.value) === String(selectedPlaylist.value.id) &&
          !userPlaylists.value.some(p => String(p.id) === String(selectedPlaylist.value.id))
        ) {
          userPlaylists.value.push(selectedPlaylist.value)
          savePlaylistsToStorage()
          // 预览制下入库不再静默——告诉用户它已落侧栏（一次性的强意图动作）
          toast(`已收藏《${selectedPlaylist.value.name}》到歌单库`, 'info')
        }

        // 立即停止当前播放，防止多首歌同时播放
        if (howl) {
          howl.stop()
          howl.unload()
          howl = null
        }
        clearHowlWatchdog()

        // 清除歌词定时器
        stopLyricSync()
        // 重置歌词加载态：上一次被 abort 的 loadLyrics 不会进 finally 复位，
        // 若本次请求随后提前返回（如无URL），loadingLyrics 会一直卡 true
        loadingLyrics.value = false

        // 立即设置播放状态为false
        isPlaying.value = false
        currentTime.value = 0
        duration.value = 0
        // 恢复续播挂账：本次带 seekTime 时（刷新恢复/重建路径）在 onload 落地
        // 前，持久化层写挂账值而非刚清零的 currentTime——正常切歌 seekTime=0
        // 即 null，currentTime 清零持久化不受影响
        pendingSeekTime = Number.isFinite(seekTime) && seekTime > 0 ? seekTime : null

        currentSong.value = song
        pendingRemoteResume = null // 本地真起播即销账——恢复位归属本地播放事实

        // 本地已下载音频工件优先于在线流（与 watch 页视频档同律）：盘上
        // 有档就不打上游玩一遍。audioReady 跨歌单寻址——暂存/搜索队列或
        // 别单借源的播放没有归属上下文也能命中，回带的 audioPlaylistId
        // 是 /file 寻址键。_localTried 是本地档解码失败后的回落戳（值=
        // 失败档的寻址歌单，真值即可跳过探测）——不重蹈同一份坏档；
        // _localFile 是兜底链显式钉档，不探。
        // isResolvableTrackId 即服务端下载白名单（数字/qq_/bv_/yt_）——
        // 不可能有任务行的 id 形态不白打探测
        let localPlId = options._localFile ?? null
        if (localPlId === null && isResolvableTrackId(song.id) && !options._localTried) {
          const plHint = playingPlaylistId.value || selectedPlaylist.value?.id || null
          const st = await downloadsApi.getSongDownloadStatus(plHint, song.id, abortSignal).catch(() => null)
          if (abortSignal.aborted || currentPlayingId !== song.id) return
          if (st?.data?.audioReady === true && st.data.audioPlaylistId != null) {
            localPlId = st.data.audioPlaylistId
          }
        }

        // 自有源轨道 id 解形：与服务端 file-downloader 的 bvM/ytM/qqM 分发
        // 同一张 shared RE 表——provider 对象缺失的老持久化行只剩前缀 id，
        // id 即真理来源（bv_ 内嵌 bvid/_pN 分P、yt_ 内嵌 videoId、qq_ 内嵌
        // mid），下方下载闸/在线位选择/onloaderror 兜底资格共用这一组 match
        const bvM = String(song.id).match(BV_TRACK_ID_RE)
        const ytM = !bvM && String(song.id).match(YT_TRACK_ID_RE)
        const qqM = !bvM && !ytM && String(song.id).match(QQ_SONG_ID_RE)
        // 「自有源外部曲」判定收敛一处：provider 对象或裸前缀 id 任一命中——
        // onload 时长差文案口径与 onloaderror 在线全灭的下载兜底资格共用，
        // 别在各回调里重撒形态判断
        const ownSource = !!(song.bilibili || song.youtube || song.qq || bvM || ytM || qqM)

        // 获取歌曲播放URL：自有源端点每次重解签名再 302 进 audio-proxy，URL
        // 不落库——B 站 /bilibili/stream 重解 playurl、YouTube /youtube/stream
        // 重解 Innertube（YT_PROXY 恢复后在线位可用；败亡经 onloaderror→
        // ownSource 回落 playDownloadedCopy 下载兜底）、QQ /qq/stream 重取 vkey。
        // 本地档（探测命中/_localFile 钉档）优先级最高——文件在盘上；
        // file_ 上传曲没有在线链——资产就是服务端 uploads/ 工件，直连 file 端点。
        // provider 对象缺失的裸前缀 id（老持久化行）按上面的解形重建在线链：
        // bv_ 的 cid 缺省由 /bilibili/stream 走 view 自愈、分P 序号从 _pN 段
        // 还原；yt_ 的 videoId 即 id 内嵌段；qq_ 的 mediaMid 缺省由服务端
        // pickStreamUrl 详情回填兜底——三源参数面都能从 id 单解，放过去会落
        // getSongUrl(前缀id) 死路（网易云端点不吃这形态）
        const songUrlData = localPlId !== null
          ? { url: downloadsApi.songFileUrl(localPlId, song.id, 'audio') }
          : isFileTrackId(song.id)
            ? { url: fileArtifactUrl(song.id) }
            // _streamRetried 重试统一带 retry=1 尾参：旁路服务端流解析正
            // 缓存读（yt 还旁路 gateCache 闸控判定缓存——缓存的误判/死档不
            // 再把重试钉在同一份产物上），强制重解拿新产物；服务端照常写回
            // 常规键治愈旧档——三源同口径
            : song.bilibili || bvM
            ? { url: musicApi.bilibiliStreamUrl(song.bilibili?.bvid || bvM?.[1], 'audio',
                song.bilibili?.cid, song.bilibili?.page || +bvM?.[2] || 1,
                '', options._streamRetried ? 1 : 0) }
            : song.youtube || ytM
              ? { url: musicApi.youtubeStreamUrl(song.youtube?.videoId || ytM?.[1],
                  'audio', '', options._streamRetried ? 1 : 0) }
            : song.qq || qqM
              ? { url: musicApi.qqStreamUrl(song.qq?.mid || qqM?.[1], '',
                  song.qq?.mediaMid, options._streamRetried ? 1 : 0) }
              : await musicApi.getSongUrl(song.id, abortSignal)

        // 检查请求是否被取消
        if (abortSignal.aborted) {
          console.log('🚫 歌曲加载被取消:', song.name)
          return
        }

        if (!songUrlData || !songUrlData.url) {
          console.error('❌ 无法获取歌曲播放链接')
          songSwitching.value = false
          playbackError.value = '无法获取播放链接（所有音源均未命中），请稍后重试或换一首'
          // 终态同补手动词务锁：本代不进 loadLyrics（其顶部复位是常规清
          // 锁点）——早退不补则 lyricFetching 卡 true 到旧请求自然超时，
          // 新曲工具条锁死。代次闸：期间新开的词务（lyricLoadSeq 已升）
          // 的锁归它自己 finally 管，本代只清旧代残余
          if (lyricSeqAtEntry === lyricLoadSeq) lyricFetching.value = false
          if (currentAbortController === myController) currentAbortController = null
          return
        }

        // 判断本次加载是否已失效（被取消或已被更新的播放请求取代）
        const isStale = () => abortSignal.aborted || currentPlayingId !== song.id || howl !== newHowl

        // 创建Howler实例；回调一律操作局部 newHowl，绝不间接引用共享变量 howl，
        // 否则过期回调会误销毁后来创建的实例
        const newHowl = new Howl({
          src: [songUrlData.url],
          format: ['mp4', 'mp3', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'webm'],
          html5: true,
          preload: true,
          onload: () => {
            if (isStale()) {
              // 过期回调不清共享看门狗——它现在属于更新的那次播放
              console.log('🚫 歌曲加载完成但已被取消/切换，不开始播放:', song.name)
              newHowl.unload()
              if (howl === newHowl) howl = null
              return
            }
            clearHowlWatchdog()

            console.log('✅ 歌曲加载完成')
            duration.value = newHowl.duration()

            // 检查时长
            const expectedDuration = (song.dt || song.duration) / 1000
            const actualDuration = newHowl.duration()

            // dt=0 是「时长未知」（上传曲留空/老数据缺字段）而非「预期 0:00」——
            // 不比较，否则每首没填时长的上传曲都误报 VIP 试听横幅
            if (expectedDuration > 0 && Math.abs(expectedDuration - actualDuration) > 5) {
              // 外部导入曲的时长差是稿件换源/分P错位而非 VIP 试听，文案区分避免误报
              durationWarning.value = isFileTrackId(song.id)
                ? `填写的时长与实际音轨不一致：预期 ${formatTime(expectedDuration)}，实际 ${formatTime(actualDuration)}`
                : ownSource
                ? `音画时长不一致：预期 ${formatTime(expectedDuration)}，实际 ${formatTime(actualDuration)}`
                : `VIP 歌曲试听版本：预期 ${formatTime(expectedDuration)}，实际 ${formatTime(actualDuration)}`
            }

            songSwitching.value = false

            // -0.5s 缓冲：恢复的进度若恰好在末尾（上次播完时持久化的 currentTime≈duration），
            // seek 到精确结尾会立刻触发 'end' 又跳下一首，回退半秒让用户能从结尾续播
            const safeSeekTime = Math.max(0, Math.min(seekTime || 0, (duration.value || 0) - 0.5))
            if (safeSeekTime > 0) {
              newHowl.seek(safeSeekTime)
              currentTime.value = safeSeekTime
            }
            // 续播点已落地（或本就没有）——结清挂账，持久化交还实时 currentTime
            pendingSeekTime = null

            if (autoplay) {
              newHowl.play()
            }
          },
          onplay: () => {
            if (isStale()) {
              console.log('🚫 开始播放但已切换到其他歌曲，停止播放:', song.name)
              newHowl.stop()
              newHowl.unload()
              if (howl === newHowl) howl = null
              return
            }

            isPlaying.value = true
            playbackError.value = '' // 重试成功后清掉"播放被阻止"等提示
            recordPlayHistory(song) // 真实起播才计入最近播放（加载失败/恢复态不记）
            recordPlaylistHistory() // 同口径记归属歌单——首页「最近播放的歌单」数据源
            startProgressLoop()
            // 起播重建词同步表（暂停已清表——100ms 空 tick 是无谓唤醒）；
            // 内部 isPlaying/syncable 双闸自行兜「无词/无戳词」不建的情形
            startLyricSync()
          },
          onpause: () => {
            if (isStale()) return
            isPlaying.value = false
            stopLyricSync() // 暂停清表——空转 tick 白耗电，起播经 onplay 重建
            savePlaybackTimeIfNeeded(true)
          },
          onstop: () => {
            // 过期实例的 stop（如 onplay stale 分支里 newHowl.stop() 同步触发）
            // 不得改写新歌的共享状态
            if (isStale()) return
            isPlaying.value = false
            // 不再重置 currentTime：非 stale 的 stop 只会发生在卸载等收尾场景，
            // 归零后 watch(currentTime) 会把已保存的续播位置覆盖成 0
            savePlaybackTimeIfNeeded(true)
          },
          onend: () => {
            if (isStale()) return
            handleSongEnd()
          },
          onloaderror: (id, error) => {
            console.error('❌ 歌曲加载错误:', error)
            // 无论是否过期都回收实例；过期时不得触碰新歌的共享状态（含看门狗）
            newHowl.unload()
            if (isStale()) return
            // 探测命中的本地档失败（档坏/探测后被删）→ 转在线链：_localTried
            // 跳过本地探测不重蹈同一份坏档；在线预算照常（_streamRetried 按
            // 链上原值继承）。_localFile 钉档是链尾——败了不重探在线
            if (localPlId !== null && !options._localFile) {
              console.log('🔁 本地已下载档加载失败，回落在线流:', song.name)
              clearHowlWatchdog()
              if (howl === newHowl) howl = null
              // _localTried 捎带失败档的寻址歌单：playDownloadedCopy 凭它避开
              // 再钉同一份坏档（真值语义不变——探测门照常跳过）
              playSong(song, { ...options, _localTried: localPlId, preserveContext: true })
              return
            }
            // 流地址失效自愈：vault token 随服务重启蒸发（404）/上游签名
            // 过期或风控（403）都让浏览器拿到 4xx → MEDIA_ERR_SRC_NOT_SUPPORTED。
            // 重解一次拿新链（各源端点本就每次重解签名）——单发闸防死循环，
            // 二次再败才落报错路径
            if (!options._streamRetried) {
              console.log('🔁 流地址可能已失效，重解重试:', song.name)
              if (howl === newHowl) howl = null
              clearHowlWatchdog()
              playSong(song, { ...options, preserveContext: true, _streamRetried: true })
              return
            }
            // 在线链全灭（SABR 闸控/签名耗尽）→ 外部源兜底：播服务器已下载
            // 工件；没下过则先触发下载、完成后续播本地文件。_localFile 档
            // 再败说明工件本体坏了——不再兜，走正常报错出口。
            // ownSource 判据含裸前缀 id——bv_/qq_ 老行在线重建败亡后同有资格
            // 进下载兜底（服务端按 id 前缀自解 provider 参数）
            if (ownSource && !options._localFile) {
              const plId = playingPlaylistId.value || selectedPlaylist.value?.id
              if (plId) {
                // 转入下载兜底前必须解除看门狗+置空 howl——下载轮询最长 ~3min，
                // 20s 看门狗到时会把兜底误判成加载超时（abort 歌词请求/报超时文案）
                clearHowlWatchdog()
                if (howl === newHowl) howl = null
                void playDownloadedCopy(song, plId, options, mySeq)
                return
              }
            }
            clearHowlWatchdog()
            // 'error' 事件也可能在播放中途触发（CDN 断流），isPlaying 必须复位，
            // 否则 UI/MediaSession/远端都停在假播放态
            isPlaying.value = false
            songSwitching.value = false
            playbackError.value = '音频加载失败，点击播放键或重新点歌可重试'
            if (currentAbortController === myController) currentAbortController = null
            if (howl === newHowl) howl = null
            savePlayerStateToStorage()
          },
          onplayerror: (id, error) => {
            // 常见于移动端自动播放被拦。绝不 unload：保留实例后用户手势点击
            // 播放键即可重试（unload 会让 howl=null、播放键只剩重建路径），
            // 这也是分享链接首访曾经的死锁根因
            console.error('❌ 播放错误:', error)
            if (isStale()) {
              // 与其他过期分支一致回收自己的实例（不碰新歌共享状态/看门狗）
              newHowl.unload()
              if (howl === newHowl) howl = null
              return
            }
            clearHowlWatchdog()
            songSwitching.value = false
            isPlaying.value = false
            playbackError.value = '播放被阻止，点击播放键重试'
            if (currentAbortController === myController) currentAbortController = null
            savePlayerStateToStorage()
          }
        })

        howl = newHowl
        newHowl.volume(volume.value / 100)

        // CDN 黑洞/握手挂死时 onload/onloaderror 均不触发，songSwitching 会永久
        // 卡死播放键——看门狗兜底：超时按加载失败收尾（仅未过期时动共享状态）。
        // 必须在 howl 赋值后武装，否则 Howl 构造同步抛错时计时器会撞上 newHowl TDZ
        howlWatchdog = setTimeout(() => {
          howlWatchdog = null
          if (isStale()) return
          // 移动端首次访问：在用户手势之前 node.load() 根本不会真正发起——
          // 这不是挂死。松开切换锁让用户点播放键完成手势加载。
          // 注意绝不能 abort myController：signal.aborted 会杀掉本曲尾随的
          // 歌词请求（词属本曲，不该陪葬）
          if (navigator.userActivation && !navigator.userActivation.hasBeenActive) {
            console.log('⏸️ 等待用户手势后再加载音频（移动端自动播放限制）')
            songSwitching.value = false
            isPlaying.value = false
            playbackError.value = '点击播放键开始播放'
            // 实例必须回收：留着它 state 停 'loading'，togglePlay 的加载窗闸
            // 会把后续点击全吞掉——播放键成死键。置空后 !howl 分支接管，
            // 用户点播放键走 playSong 重建（手势内 node.load() 才真正发起）
            newHowl.unload()
            if (howl === newHowl) howl = null
            if (currentAbortController === myController) currentAbortController = null
            return
          }
          // 真挂死：中止尾随的歌词请求（写共享态有 currentPlayingId 守卫，只为省请求）
          myController.abort()
          console.error('❌ 歌曲加载超时:', song.name)
          newHowl.unload()
          if (howl === newHowl) howl = null
          songSwitching.value = false
          isPlaying.value = false
          loadingLyrics.value = false
          playbackError.value = '歌曲加载超时，请检查网络后重试'
          if (currentAbortController === myController) currentAbortController = null
        }, PLAYBACK_LOAD_TIMEOUT_MS)

        // 加载歌词（可随播放请求一起被取消）
        await loadLyrics(song, abortSignal)

        if (abortSignal.aborted) return

        // 仅清除仍属于本次请求的 controller 引用
        if (currentAbortController === myController) currentAbortController = null
        savePlayerStateToStorage()

      } catch (error) {
        // 检查是否是因为请求被取消
        if (error.name === 'AbortError' || abortSignal.aborted) {
          console.log('🚫 歌曲加载请求被取消')
          return
        }
        console.error('❌ 播放歌曲失败:', error)
        songSwitching.value = false
        playbackError.value = '播放请求失败，请稍后重试'
        // 终态同补手动词务锁（与无 URL 早退同代次口径）：本代可能没走
        // 到 loadLyrics 的顶部复位——期间新开的词务锁归它自己 finally 管
        if (lyricSeqAtEntry === lyricLoadSeq) lyricFetching.value = false
        // 清掉上一首歌的残留歌词，避免在新歌标题下渲染旧歌词
        lyrics.value = []
        currentLyricIndex.value = 0
        lyricOffsetMs.value = 0
        lyricOwnerKey.value = null
        if (currentAbortController === myController) currentAbortController = null
        savePlayerStateToStorage()
      }
    }

    // 歌词加载和同步（支持取消 + 过期响应不落盘，防止旧歌歌词覆盖新歌）。
    // 外部导入曲（B 站/YouTube）的歌词源：匹配到的网易云曲 id（neteaseId）
    // 优先，缺席或绑定词源行集为空时走 /lyric/external 外源级联兜底
    // （extId 作词属主键）——绑错/绑了无词源不该把已在显示的外源词丢掉。
    // 播放本体仍是 bv_*/yt_* id——过期判定锚 song.id，不锚歌词请求的 id
    // lyricLoadSeq：同曲两次并发 load 的单调闸（播放路径 fetch 在飞 + 歌词热
    // 重载再发——同 id 同 signal 域里 currentPlayingId/abort 都分不开，后到者
    // 赢；无它时旧响应晚落地会覆盖新词）
    let lyricLoadSeq = 0
    // 词务代次陈旧判定的单份组装——loadLyrics/手动获取/补轴三处同一份
    // 语义（切断 signal + 曲 id 换号 + 加载代次失配）；postProcess 的
    // ownsLyric 用的是 lyricProcSeq 另一张账，刻意不共用
    const makeLyricStale = (song, signal, seq) => () =>
      signal?.aborted || currentPlayingId !== song.id || seq !== lyricLoadSeq
    // 「词文本 → 行集 + 是否滚动」单份口径：滚动解析（parseLyrics）出空集
    // 则纯文本剥戳落成 time:Infinity 静态行（同步循环恒不匹配、渲染层照常
    // 显行——「有字无轴」仍是可读词稿不是无词；补轴入口也靠这批非有限戳
    // 行现身）。file_ 上传词与外源 hit 落地共用
    const lyricRowsOf = (text) => {
      const rows = parseLyrics(text || '')
      return rows.length
        ? { rows, synced: true }
        : { rows: plainLyricLines(text), synced: false }
    }
    // 外源级联/匹配链的检索喂料单份组装（fetchApplyExternal/
    // rematchLyricSource/rematchUnbound/manualFetchLyrics 四处共用）：
    // provider 块（youtube/bilibili）的标题/作者优先，艺人缺省回退曲面
    // ar/artists——qq_ 无 provider 块，ar 即曲库真实署名（具名轮要用）
    const lyricSearchFeed = (song) => {
      const ext = song?.youtube || song?.bilibili || null
      const durationMs = song?.dt || song?.duration
      return {
        extTitle: ext?.title || '',
        extAuthor: ext?.author || '',
        extAuthorClean: ext?.authorClean || '',
        name: song?.name || '',
        artistsJoined: (song?.ar || song?.artists || [])
          .map(a => a?.name).filter(Boolean).join('/'),
        durationSec: Number.isFinite(durationMs) ? Math.round(durationMs / 1000) : undefined,
        // 源媒体发布日（epoch ms）：retry/verify 回喂的时间证据——provider
        // 块缺字段/脏值归 undefined，axios 丢 undefined 键不进 body；
        // qq 槽位与 bv/yt 同轴（buildQQSong 归一 publishTime 而来）
        publishedAt: ext?.publishedAt || song?.qq?.publishedAt || undefined,
      }
    }
    const loadLyrics = async (song, signal = null) => {
      const mySeq = ++lyricLoadSeq
      // 新加载代接管词 UI 态：顺带清掉悬挂的手动锁——切歌/热重载时旧
      // 「获取歌词/生成滚动词」代可能仍在途（无 signal 自然跑完，外源
      // 80s/对齐 300s 超时）；其 finally 按 mySeq===lyricLoadSeq 判已
      // 失配不再碰锁，这里不清则 lyricFetching 卡 true，新曲工具条
      // 死锁到旧请求 settle 才放
      lyricFetching.value = false
      // loadingLyrics 顶部置位（旧版散在各支 try 内）：hydrateMatchBinding
      // 的 RTT 窗内旧词仍挂屏上且无加载态——顶置让窗内即进 loading。
      // 终态各支 try/finally 照旧复位；stale 早退留给新代（或看门狗
      // 显式清）——本代被顶替时绝不能抢新代的旗
      loadingLyrics.value = true
      const stale = makeLyricStale(song, signal, mySeq)
      // file_ 曲：词源=用户上传的 .lrc 工件（file 端点 kind=lyrics）。无资产时 404 → 空词。
      // 词属主键用 song.id——file 词与曲同生死，offset 校准也挂它（song_lyric_meta 按 id 存）
      if (isFileTrackId(song?.id)) {
        lyricOffsetMs.value = 0
        lyricOwnerKey.value = null
        try {
          const metaPromise = downloadsApi.getSongMeta(song.id).catch(() => null)
          const res = await fetch(fileArtifactUrl(song.id, 'lyrics'), { signal, credentials: 'include' })
          const text = res.ok ? await res.text() : null
          const meta = await metaPromise
          if (stale()) return
          lyricOffsetMs.value = meta?.offsetMs ?? 0
          lyricOwnerKey.value = song.id
          // 上传的可能是纯文本词（无时间戳）——lyricRowsOf 兜底成
          // time:Infinity 静态行（与外源 hit 落地同口径）：仍可读且
          // 「生成滚动词」补轴入口靠非有限戳行现身；旧口径 parseLyrics
          // 全空按无词处理把补轴入口永久锁死
          const { rows, synced } = lyricRowsOf(text)
          lyrics.value = rows
          currentLyricIndex.value = synced ? 0 : -1
          if (synced && rows.length) startLyricSync()
          else stopLyricSync()
        } catch (error) {
          if (stale() || error.name === 'AbortError') return
          lyrics.value = []; currentLyricIndex.value = 0; lyricOwnerKey.value = null
        } finally {
          if (!stale()) loadingLyrics.value = false
        }
        return
      }
      // 外源级联「取词+落屏」核：未绑定支（无 neteaseId 直走外源）与绑后
      // 词空兜底支（网易/QQ 词源终态行集为空）共用，不复制定理。含校准归
      // 零/词属主清理/getExternalLyric 级联取词/applyExternalLyricHit 落
      // 屏；loadingLyrics 由外层调用点的 try/finally 管。stale 谓词沿用
      // 本代 loadLyrics 的域——两个调用点同代同 signal，不另组
      const fetchApplyExternal = async (song, signal) => {
        lyricOffsetMs.value = 0 // meta 回包前先归零——旧曲校准值不挂新曲界面
        lyricOwnerKey.value = null
        console.log('📝 加载外源歌词:', song.id)
        const feed = lyricSearchFeed(song)
        // artist 缺省回退曲面艺人表：UGC 行 ar 本空（口径不变），qq_ 曲的
        // ar 是曲库真实署名——具名轮检索要它
        const hit = await musicApi.getExternalLyric({
          id: song.id,
          title: feed.extTitle || feed.name,
          artist: feed.extAuthor || feed.artistsJoined || '',
          durationSec: feed.durationSec,
        }, signal).catch(() => null) // 级联全灭(404)/网络错同终态：照旧空词
        if (stale()) return
        await applyExternalLyricHit(song, hit, { signal, stale })
      }
      // 绑定态水合（hydrateMatchBinding 头注）：yt_/bv_ 曲本地 neteaseId
      // 缺席 ≠ 服务端 song_match 无正绑——读口补绑成功则下方外源支谓词
      // 自然变 false，落回常规网易词支拿官方译文
      await hydrateMatchBinding(song, signal)
      if (stale()) return
      // 外部导入曲（B 站/YouTube）无 neteaseId 时走服务端外源词兜底
      // /lyric/external（YTM→LRCLIB→酷狗级联）。provider 对象缺失的老持久
      // 化行按 bv_/yt_ id 形态同判（对象与形态任一命中）——服务端按 id 前缀
      // 自解定位，title/artist 只是检索喂料，缺了降级不致死。
      // qq_ 不在此列——QQ 曲有自家权威词源（/qq/lyric），无匹配也能出词
      if (isUgcExternalTrack(song) && !song.neteaseId) {
        try {
          await fetchApplyExternal(song, signal)
          // 外源终态仍无滚动词（级联全灭/hit=null/行集剥空，或只命中纯文
          // 本词——time 全非有限的静态行只算「有字」不算「有词」：绑上网
          // 易词源换滚动词是严格升级）且曲仍未绑网易词源——外源三源对
          // VOCALOID 翻唱等曲天然缺收录，而这些曲网易云本体常有：未绑定
          // 曲自动重匹配一次兜底（每曲每会话限一次，详见 rematchUnbound
          // 头注）。neteaseId 复查防御——applyExternalLyricHit 不改它，
          // 但 RTT 窗内菜单换绑等别路可能已补绑
          if (!stale() && !lyrics.value.some(l => Number.isFinite(l.time))
              && song.neteaseId == null) {
            void rematchUnbound(song, signal)
          }
        } catch (error) {
          if (stale() || error.name === 'AbortError' || error.code === 'ERR_CANCELED') return
          console.error('❌ 加载外源歌词失败:', error)
          lyrics.value = []
          currentLyricIndex.value = 0
          lyricOwnerKey.value = null
        } finally {
          if (!stale()) loadingLyrics.value = false
        }
        return
      }
      // 词源选择：qq_ 曲首选 QQ 自带词（qq_<mid> 作词源 id——AI 翻译/校准
      // 缓存都认这个键）；QQ 词源空且匹配到网易云时回落网易云词源（嫁接词，
      // postProcess 会走归属核验）。裸 qq_<mid> id（缺 provider 对象的老行）
      // 同样自解 mid——/qq/lyric 只吃 mid，不落网易云 /lyric 死路
      const qqMid = song?.qq?.mid || String(song?.id ?? '').match(QQ_SONG_ID_RE)?.[1] || null
      // lyricId 恒非空——playSong 保证 song.id（旧 lyricId==null 早退是
      // 不可达分支）：qq_ 支取 `qq_<mid>`，其余取 neteaseId ?? song.id
      let lyricId = qqMid ? `qq_${qqMid}` : (song?.neteaseId ?? song?.id)
      lyricOffsetMs.value = 0 // meta 回包前先归零——旧曲校准值不挂新曲界面
      try {
        console.log('📝 加载歌词:', lyricId)

        // 校准随词源走（neteaseId 优先）：同一网易云词源在本地单/远端单/壳间共享。
        // meta 查询失败不阻塞歌词——校准只是修饰，降级为 0。
        // qq 词源要等 fetch 后才知道是否回落，meta 延到词源定稿再查
        const metaPromise = qqMid ? null : downloadsApi.getSongMeta(lyricId).catch(() => null)
        let lyricsData = qqMid
          ? await musicApi.getQQLyric(qqMid, signal).catch((e) => {
            // abort/取消穿透给外层分诊（切歌打断在途请求不是失败）；
            // 其余故障降级空词照旧走回落链
            if (e?.name === 'AbortError' || e?.name === 'CanceledError'
                || e?.code === 'ERR_CANCELED') throw e
            console.warn('QQ 歌词获取失败，回落兜底:', e?.message || e)
            return null
          })
          : await musicApi.getLyrics(lyricId, signal)
        // 切歌/取消/同曲再载后直接丢弃，不写回共享状态
        if (stale()) return
        if (qqMid && !lyricsData?.lyrics?.length && song.neteaseId) {
          lyricId = song.neteaseId
          lyricsData = await musicApi.getLyrics(lyricId, signal)
          if (stale()) return
        }
        // qq_ 链全灭（QQ 词空 + 无/空网易回落）：与下载链同口径接外源级联
        // 兜底（服务端对 qq_ 曲库 id 按 AI 在位与否分保守/开放两态，不再走
        // 宽检硬滤）。不触 rematchUnbound——那是 UGC 未绑定曲的首配面，
        // qq_ 有自家权威词源不进匹配链
        if (!lyricsData?.lyrics?.length && qqMid) {
          await fetchApplyExternal(song, signal)
          return
        }
        // 绑后词空兜底：词源终态行集为空（含 qq→netease 回落后仍空）且曲
        // 是 UGC 形态（isUgcExternalTrack——与上方未绑定支同谓词）→ 再走
        // 一遍外源级联。曲绑上 neteaseId 后 !song.neteaseId 闸使外源支本
        // 不再进——若绑定的词源无词，本在显示的外源词（如首配前命中的纯
        // 文本词）会永久消失：绑错=丢词。数字纯曲库 id 不进——外源宽检
        // 对目录曲是误导通道（qq_ 词空由上方独立支接走）。外源也空则 lyrics=[]
        // 与现状同终态；rematchUnbound 的 neteaseId==null 闸天然防环——
        // 绑后兜底不回触首配
        if (!lyricsData?.lyrics?.length && isUgcExternalTrack(song)) {
          await fetchApplyExternal(song, signal)
          return
        }
        const meta = qqMid
          ? await downloadsApi.getSongMeta(lyricId).catch(() => null)
          : await metaPromise
        if (stale()) return

        lyricOffsetMs.value = meta?.offsetMs ?? 0
        lyricOwnerKey.value = lyricId // 词属主与值同源——见 lyricOwnerKey 注释
        lyrics.value = lyricsData?.lyrics || []
        currentLyricIndex.value = 0
        // 同 lyricId 往返（A→B→A 快切）时旧 postProcess 会随 lyricOwnerKey/
        // currentPlayingId 双双回正而「复活」重获写权——加单调序号区分同 id
        // 的两次加载，旧批次的 ownsLyric 永久失效
        const seq = ++lyricProcSeq

        console.log('✅ 歌词加载完成，共', lyrics.value.length, '行')

        // 开始歌词同步
        if (lyrics.value.length > 0) {
          startLyricSync()
        }

        // AI 后处理挂后台不阻塞显示：外部曲核验歌词归属 + 无官方译文的
        // 自动翻译。结果回来时词属主可能已换——写回前逐项复查
        void postProcessLyrics(song, lyricId, seq, signal)
          .catch(e => console.warn('AI 歌词后处理异常:', e))
      } catch (error) {
        if (stale() || error.name === 'AbortError' || error.code === 'ERR_CANCELED') return
        console.error('❌ 加载歌词失败:', error)
        lyrics.value = []
        currentLyricIndex.value = 0
        lyricOwnerKey.value = null
      } finally {
        if (!stale()) {
          loadingLyrics.value = false
        }
      }
    }

    // 外源命中落地段（loadLyrics 外源支与手动「获取歌词」共用收口）：
    // hit→行集（synced 判定 + 纯文本→静态行兜底）→ extId 词属主键 →
    // meta 校准 → 同步循环/AI 后处理触发。stale 谓词由调用方供（各自域
    // 的 seq/abort 组法不同），写共享态前统一复查；admit 是提交前否决闸
    // （手动路径的防降级用）——返回 { applied, synced, rows } 供调用方
    // 区分「落地/被陈旧丢/被闸拦」出文案
    const applyExternalLyricHit = async (song, hit, { signal = null, stale = () => false, admit = null } = {}) => {
      // 纯文本→静态行：parseLyrics 只吃带时间戳的行，synced=false 的
      // lrc 会全空——plainLyricLines（共享层 lrc.js，先剥行首时间戳再判
      // [tag:] 元行）逐行落 time:Infinity：WatchView 照常渲行、同步循环
      // 恒不匹配（currentLyricIndex 停 -1 不滚动）、TextAlive 画布滤非
      // 有限戳。「不滚动」正是无戳词的正确行为；synced lrc 解空时拿
      // plain 兜底重切
      let synced = !!hit?.synced
      let rows = synced ? parseLyrics(hit.lrc) : []
      if (!rows.length) { synced = false; rows = plainLyricLines(hit?.plain || hit?.lrc) }
      // 词属主键挂 extId（ytm_/lrclib_/kugou_ 前缀）——meta 校准表与
      // verify/translate 白名单对该形态均已放开；extId 缺席降级到
      // song.id（词仍可见，校准行挂曲 id 不写串台）
      const extLyricId = hit?.extId || song.id
      const meta = rows.length
        ? await downloadsApi.getSongMeta(extLyricId).catch(() => null)
        : null
      if (stale()) return { applied: false, synced, rows }
      // 提交前否决闸（手动路径防降级）：此刻旧词还挂在屏上，admit 读的
      // lyrics.value 是「当下显示的那份」——闸不许通过就一行不写
      if (admit && !admit({ synced, rows })) return { applied: false, synced, rows }
      lyricOffsetMs.value = meta?.offsetMs ?? 0
      lyricOwnerKey.value = rows.length ? extLyricId : null
      lyrics.value = rows
      currentLyricIndex.value = synced ? 0 : -1
      const seq = ++lyricProcSeq
      if (synced && rows.length > 0) {
        startLyricSync()
      } else {
        // 防御（热重载/菜单换绑不经 playSong 的计时器清理）：旧 synced
        // 计时器若在会把无戳词的 currentLyricIndex 恒压回 0
        stopLyricSync()
      }
      // extId 缺席时词属主键已降级成轨道 id（bv_/yt_）——该形态不在
      // /ai/lyric-verify 与 /ai/lyric-translate 白名单内，postProcess
      // 去了必吃 400 白打两跳，整条跳过（词照常可见，只是无核验/翻译）
      if (hit?.extId) {
        void postProcessLyrics(song, extLyricId, seq, signal)
          .catch(e => console.warn('AI 歌词后处理异常:', e))
      }
      return { applied: true, synced, rows }
    }

    // 已是中文语境歌词就不再翻译——判定收敛在共享层 isLikelyChineseLyric
    // （与服务端 lyric-translate 的 already-zh 跳翻同一份口径）：汉字占比
    // ≥阈值只是必要非充分，假名/谚文在场即「需要翻译」硬证据——日文词
    // 汉字密度 30-50% 是常态，旧占比闸把它误判中文语境跳翻（少女レイ
    // 实案：CJK 0.365 被跳）；拉丁文不构成豁免
    const lyricCjkDominant = (lines) =>
      isLikelyChineseLyric(lines.map(l => l.text).join(''))

    // AI 歌词后处理：① 外部导入曲核验配到的网易云歌词确实属于这首（错配时
    // 「错歌词比没歌词更糟」→ 整组隐藏）；② 无官方译文且非中文语境 → 自动
    // 生成中文译文并按时间戳合并。全程后台异步，写回前复查词属主+加载序号。
    // 会话级缓存：判定/译文结果按 (词源,来源)/(词源) 记忆——重播/往返不再
    // 重复请求，也避免「错词短暂闪现再被隐藏」。容量帽防长会话只涨不消：
    // 译文值是整段 LRC 文本（数 KB），无界 Map 随 AI 曲数线性涨
    const AI_LYRIC_CACHE_CAP = 256
    // FIFO 挤出（仅在 miss 后写入，Map 键序=插入序）；被挤条目重播时
    // 重打一次服务端——verdict 服务端有落库缓存，translate 只多一跳
    const cacheSet = (map, key, val) => {
      if (map.size >= AI_LYRIC_CACHE_CAP && !map.has(key)) {
        map.delete(map.keys().next().value)
      }
      map.set(key, val)
    }
    const aiLyricVerdicts = new Map()   // `${lyricId}|${title}|${author}` -> boolean
    const aiLyricTranslations = new Map() // `${lyricId}|${model}` -> tlyric 字符串
    let lyricProcSeq = 0 // 每次歌词落盘 +1；postProcess 捕获，ownsLyric 比对

    // verify 判否后的自动换绑：判否等于「当前词源错配」的强信号，把该
    // neteaseId 否进 excludeIds 让服务端 /match/retry 换绑重跑。每曲每
    // 会话限一次（Map 键 trackId——有键即算 tried）——新词源若仍被判否，
    // 不加闸会 verify→rematch→verify 无限套娃。换绑只认「判否的词源就是
    // 当前 neteaseId」的场景：qq_ 自源词判否（lyricId 是 qq_ 键不是
    // neteaseId）否决错了对象——去重键仍记 song.id 防环。
    // Map 值是该曲的累积否决集：频率闸挡住的后续判否（换绑新源又被否）
    // 仍把 lyricId 并进集合——同会话内已否词源不再复活进候选；首次发起
    // 时 excludeIds 发当下累积全量。跨会话收敛靠服务端 song_match 行，
    // 前端不持久化否决集
    const rematchTried = new Map()
    // 菜单显式否决簿：行菜单解绑/换绑否掉的旧词源 id 按曲记账
    // （onLyricRematch 写入、rematchUnbound 并入 excludeIds 消费、
    // hydrateMatchBinding 否决闸消费）——显式解绑后服务端 skipCache
    // 重跑会把刚否决的确定性高分原样送回，不记否等于反噬用户纠正。
    // 簿内统一 String 记账（neteaseId 数字与字符串词源 id 同键域，
    // 消费端按 String 口径比对/外发）。会话级，与 rematchTried 同寿命
    // 语义：跨会话收敛靠服务端 song_match 行，前端不持久化
    const matchVetoedIds = new Map()
    const rematchLyricSource = async (song, lyricId, signal = null) => {
      // 形闸对齐 isUgcExternalTrack 裸 id 口径（与各词务形闸同一张谓
      // 词）：provider 对象在 verify→rematch 的 RTT 窗内被剥走（持久化
      // 裁剪/旧行形态）只剩 bv_/yt_ 形态 id 时，换绑资格不该跟着蒸发
      const extTrack = isUgcExternalTrack(song)
      if (!extTrack || song.neteaseId == null
          || String(lyricId) !== String(song.neteaseId)) {
        // 曲未绑定（neteaseId==null）时判否的是外源词——lyricId 是 extId
        // 不是 neteaseId，无可否对象不进 excludeIds：此刻词已藏、曲仍
        // 未绑，把歌接上 rematchUnbound 首配兜底。槽位独立不冲突——
        // 「词全灭」触发点当时 lyrics 非空，没消费过槽位
        if (song?.neteaseId == null) void rematchUnbound(song, signal)
        return
      }
      const key = String(song.id)
      const vetoed = rematchTried.get(key)
      if (vetoed) {
        vetoed.add(lyricId) // 频率闸已锁——判否仍记账（同会话内不复活）
        return
      }
      const freshVetoed = new Set([lyricId])
      rematchTried.set(key, freshVetoed)
      // provider 块可缺席（裸 id 过闸）：检索喂料回退 song.name/ar，与
      // rematchUnbound 同口径——缺了降级不致死，服务端按 id 前缀自解
      const feed = lyricSearchFeed(song)
      // 判否累积集之外再并入菜单显式否决簿（与 rematchUnbound 同一张
      // 账）——自动换绑不许复活用户显式解绑/换绑否掉的词源
      const excludeIds = [...new Set([...freshVetoed, ...(matchVetoedIds.get(key) ?? [])])]
      try {
        const matched = await musicApi.retryMatch({
          trackId: song.id,
          title: feed.extTitle || feed.name,
          author: feed.extAuthor,
          // provider 块从不存 artists 字段（external-songs.js 只落 author/
          // authorClean）——authorClean 是剥 ' - Topic'/'VEVO' 后的真艺人名，
          // 一并喂服务端打分器 sourceInfo.artists（YT Topic 频道场景 retry
          // 不再比首配更瞎）
          artists: [feed.extAuthor, feed.extAuthorClean].filter(Boolean),
          durationSec: feed.durationSec,
          excludeIds,
          publishedAt: feed.publishedAt,
        }, signal)
        // 完成型 miss（matched===null——异常走 catch 不进这里）且本次外发
        // 的 excludeIds 含当前绑定 id（RTT 窗内被别路改绑则不含，显式选择
        // 优先不动它）：镜像服务端负行终态——判否词源不再留绑。客户端不
        // 解绑的话本地 raw_json 残绑会让每会话重走「词闪→藏→retry」振荡；
        // applyMatchResult(null) 顺带把错配烘进的 name/al 洗回 provider 态。
        // 写回+落盘不因 stale 弃写（持久属性，与下方换绑同口径）；仍正播且
        // 未 abort 则热重载走未绑定支接外源兜底（外源再全灭时 rematchUnbound
        // 首配兜底自带否决集接续）。静默无 toast——「疑似不匹配已隐藏」
        // 提示先行已解释，后台自愈不配打扰；console.info 留痕
        if (matched === null) {
          const boundVetoed = song.neteaseId != null
            && excludeIds.some(id => String(id) === String(song.neteaseId))
          if (!boundVetoed) return
          applyMatchResult(song, null)
          savePlaylistsToStorage()
          console.info('词源判否后重匹配未命中，已解除错配绑定:', song.id)
          if (currentPlayingId !== song.id || signal?.aborted) return
          void loadLyrics(song, signal)
          return
        }
        // 同 id 命中回包早退：服务端把现绑定原样送回——不写不重载；
        // 其余空回包形态（undefined/空对象）同归不写
        if (!matched?.id || String(matched.id) === String(song.neteaseId)) return
        // 换绑走共享修复器整组重建 name/al/证据（不只换 neteaseId）——
        // 错配的专辑身份是持久化元信息残留，要连根修。写回曲对象+显式
        // 落盘：savePlaylistsToStorage 是显式调用制（非 watch），只变异
        // 要等下一次任意歌单写才经 slimTrack 落盘——用户直接关页则下
        // 会话重走判否→藏词→rematch 循环。服务端 song_match 行已被
        // /match/retry 覆写兜底，两端同写才算闭环
        applyMatchResult(song, matched, { matchedBy: matched.matchedBy, matchScore: matched.score })
        savePlaylistsToStorage()
        // RTT 期间歌可能已切走（signal 随切歌 abort 通常已把请求打断；
        // 陈旧序未 abort 时靠这层再兜）：写回/落盘照做（那是曲的持久
        // 属性），只给仍正播的曲补 toast+热重载，别替没人看的歌刷词
        if (currentPlayingId !== song.id || signal?.aborted) return
        toast('词源已自动重匹配', 'success')
        await loadLyrics(song, signal)
      } catch (e) {
        // abort（切歌打断在途请求）与 429 限流不消费额度——前者是本曲
        // 「下次播放再试」的机会，后者是「稍后再试」语义（烧槽位会让
        // 限流期的一单永不自愈）；与 rematchUnbound/hydrateMatchBinding
        // 同口径。其它错误保留占位防每播一次刷 match-retry 限流桶
        if (signal?.aborted || e?.code === 'ERR_CANCELED'
            || e?.name === 'AbortError' || e?.name === 'CanceledError'
            || e?.response?.status === 429) {
          rematchTried.delete(key)
        }
      }
    }

    // 外源词全灭后的未绑定曲首配（与 rematchLyricSource 对偶：那边是已
    // 绑定曲判否换绑，这边是 yt_/bv_ 未绑定曲「词落空自动重匹配一次」）。
    // 动机：外源三源（YTM/LRCLIB/酷狗）对 VOCALOID 翻唱等曲天然缺收录，
    // 而这些曲网易云本体常有——拿 provider 材料重跑服务端匹配链，命中经
    // applyMatchResult 整组重建（name/al/证据同口径），热重载走常规网易
    // 词支。rematchUnboundTried 是独立 Map——与 rematchTried 不串账
    // （那边记已绑定曲换绑额度与否决集，这边只记未绑定曲首配），每曲每
    // 会话限一次。excludeIds 按需捎——判否累积集（rematchTried）与菜单
    // 显式否决簿（matchVetoedIds）有账则并入：显式解绑/换绑否掉的 id
    // 不送回候选，否则服务端 skipCache 重跑会把刚否决的确定性高分原样
    // 送回反噬用户纠正；空集则保持首配契约不捎该字段。matched=null
    // 不留痕（无匹配仍是事实，不写曲对象）；错误静默 warn 级——后台
    // 自愈不配打扰用户
    const rematchUnboundTried = new Map()
    const rematchUnbound = async (song, signal = null) => {
      // 形闸与外源支同一张谓词（isUgcExternalTrack：provider 对象或裸
      // 前缀 id 任一命中——老持久化行只剩 id 形态）。neteaseId/id 合法
      // 复查——触发点到本函数入口间别路（菜单换绑等）可能已补绑，
      // 已绑定的曲由常规词支接管不该到这
      if (!isUgcExternalTrack(song) || song?.id == null || song.neteaseId != null) return
      const key = String(song.id)
      if (rematchUnboundTried.has(key)) return
      rematchUnboundTried.set(key, true)
      const feed = lyricSearchFeed(song)
      // 否决集 = 判否累积（rematchTried 同键域）∪ 菜单显式否决簿——
      // 解绑/换绑否掉的 id 不进候选（防自动首配复活用户纠正）
      const excludeIds = [...new Set([
        ...(rematchTried.get(key) ?? []),
        ...(matchVetoedIds.get(key) ?? []),
      ])]
      try {
        const matched = await musicApi.retryMatch({
          trackId: song.id,
          title: feed.extTitle || feed.name,
          author: feed.extAuthor,
          // provider 块无 artists 字段（同 rematchLyricSource 口径）——
          // authorClean 是剥 ' - Topic'/'VEVO' 后的真艺人名，一并喂打分器
          artists: [feed.extAuthor, feed.extAuthorClean].filter(Boolean),
          durationSec: feed.durationSec || undefined,
          // 空集不捎字段——保持首配契约干净（有否决账才发 excludeIds）
          ...(excludeIds.length ? { excludeIds } : {}),
          publishedAt: feed.publishedAt,
        }, signal)
        // matched=null 不留痕（无匹配仍是事实，不写曲对象）；RTT 窗内
        // 被别路补绑也不再覆写——用户显式选择优先
        if (!matched?.id || song.neteaseId != null) return
        // 首配与判否换绑同走共享修复器整组重建；savePlaylistsToStorage
        // 是显式调用制——只变异不落盘会把绑定丢在关页前。写回+落盘是曲的
        // 持久属性修正（与 rematchLyricSource 同口径：曲对象是歌单里的
        // 共享引用，写它不打扰当前播放），不因 stale 弃写——已到手的匹配
        // 白丢会让 rematchUnboundTried 已记账的本曲拖到下次会话才愈
        applyMatchResult(song, matched, { matchedBy: matched.matchedBy, matchScore: matched.score })
        savePlaylistsToStorage()
        // stale（切走/信号作废）只闸歌词重载与提示——别替没人看的歌刷词
        if (signal?.aborted || currentPlayingId !== song.id) return
        toast('词源已自动重匹配', 'success') // 与判否换绑同文案——人还在看才发
        void loadLyrics(song, signal) // neteaseId 已写——本次走常规网易词支
      } catch (e) {
        // abort（切歌打断在途请求）与 429 限流不消费额度——前者是本曲
        // 下次播放再试的机会，后者是「稍后再试」语义（烧槽位会让整单
        // autoplay 下永不自愈）；其它错误保留占位防每播一次刷
        // match-retry 限流桶，静默 warn
        if (signal?.aborted || e?.code === 'ERR_CANCELED'
            || e?.name === 'AbortError' || e?.name === 'CanceledError'
            || e?.response?.status === 429) {
          rematchUnboundTried.delete(key)
        } else {
          console.warn('未绑定曲自动重匹配失败:', e?.message || e)
        }
      }
    }

    // 绑定态水合（loadLyrics 未绑定支前的读口自愈）：yt_/bv_ 曲对象
    // neteaseId 缺席只代表「本端没记到」——服务端 song_match 可能已有
    // 正向绑定（别会话/服务端侧写入的行不回推客户端持久化）。不补这
    // 一跳，客户端会一直走外源词，丢掉网易侧官方译文（少女レイ ver.EMA
    // 实案：服务端绑 2068956580 带 44 行官方译文，raw_json.neteaseId=
    // undefined 播的却是无译文 lrclib 词）。形闸与未绑定支同口径
    // （provider 对象或裸前缀 id 任一）；每曲每会话只查一次——状态查
    // 询是幂等读，abort/429 释槽（与 rematchUnbound 同口径）其余记账，
    // 防快速重播刷 /match/state。命中前先过 matchVetoedIds 否决簿——
    // 菜单解绑/换绑否掉的 id 不被水合复活；否决簿仅会话内存，跨会话
    // 复活残面在服务端（retry 传输失败不落负行、正行无 TTL），留作
    // 已知残面。命中经 applyMatchResult 整组重建并显式落盘（绑定是
    // 持久属性，与 rematchLyricSource/rematchUnbound 同口径）；
    // match=null 什么都不写。静默自愈不配 toast；读段异常静默吞、
    // 写回段 warn 留痕——后台链路不配打扰用户但缺陷不该没痕迹
    const hydrateTried = new Set()
    const hydrateMatchBinding = async (song, signal = null) => {
      // id 合法复查与 rematchUnbound 同口径；已绑定（neteaseId 在）直接
      // 早退——别路已写回的曲不再查
      if (!isUgcExternalTrack(song) || song?.id == null || song.neteaseId != null) return
      const key = String(song.id)
      if (hydrateTried.has(key)) return
      hydrateTried.add(key)
      let match = null
      try {
        match = await musicApi.getMatchState(song.id, signal)
      } catch (e) {
        // 读失败分诊与 rematchUnbound 同构：abort（切歌打断在途请求）与
        // 429 限流释放槽位——RTT 窗内切歌/「稍后再试」不该烧掉本曲下次
        // 播放的水合机会；其它错误保留记账防每播一次刷读口限流桶
        if (signal?.aborted || e?.code === 'ERR_CANCELED'
            || e?.name === 'AbortError' || e?.name === 'CanceledError'
            || e?.response?.status === 429) {
          hydrateTried.delete(key)
        }
        return
      }
      // match=null（无正绑/负缓存行）不留痕；RTT 窗内被别路补绑
      // （菜单换绑等）也不覆写——用户显式选择优先
      if (!match?.id || song.neteaseId != null) return
      // 否决闸对两簿取并集（与 rematchUnbound 组 excludeIds 同一张账）：
      // matchVetoedIds 只记菜单显式否决，判否否决记 rematchTried——判否
      // 触发的镜像解绑（rematchLyricSource miss 支）后 neteaseId==null
      // 使本读口变可达，服务端正行残存窗口（mergeVetoed fail-soft 没落
      // 账/旧服务端无否决簿）会把刚判否的词源原样送回，漏查判否簿等于
      // 水合复活刚否决的绑定。rematchTried 按 lyricId 原类型记账
      // （neteaseId 多为数字），比对两侧归一 String
      const matchId = String(match.id)
      const vetoed = matchVetoedIds.get(key)?.has(matchId)
        || [...(rematchTried.get(key) ?? [])].some(id => String(id) === matchId)
      if (vetoed) return
      // 写回段与读段分 try：applyMatchResult/落盘的缺陷不许静默吞成
      // 「请求失败」——后台自愈不打扰用户照旧，但留 warn 可查
      try {
        applyMatchResult(song, match, { matchedBy: match.matchedBy, matchScore: match.score })
        savePlaylistsToStorage() // 显式调用制——只变异不落盘会丢「关页前刚水合的绑定」
      } catch (e) {
        console.warn('绑定态水合写回失败:', e?.message || e)
      }
    }

    // 行菜单换绑通知槽（模块级单槽，见 notifyLyricRematch 头注）：vetoedId
    // 先记否决簿（不限正播曲——Map 记账无写入成本，非正播曲的否决留到
    // 它下次播放时由 rematchUnbound 消费）；正播同曲才把新词源 id 补写进
    // 本侧曲对象并重载词——非当前曲的改动留给下次播放的 loadLyrics 自然
    // 消费
    const onLyricRematch = (trackId, neteaseId, vetoedId, matched) => {
      if (vetoedId != null) {
        const key = String(trackId)
        let vetoed = matchVetoedIds.get(key)
        if (!vetoed) matchVetoedIds.set(key, (vetoed = new Set()))
        vetoed.add(String(vetoedId)) // 簿内 String 记账——数字 neteaseId 与字符串词源 id 同键域
      }
      if (!currentSong.value || String(currentSong.value.id) !== String(trackId)) return
      // neteaseId=null 是菜单侧解绑信号（用户显式否决错配且无更准替代）：
      // 清绑与换绑同一收口。本侧对象与菜单侧写过的对象不一定是同一引用
      // ——补写后显式落盘（同 rematchLyricSource：savePlaylistsToStorage
      // 是显式调用制，只变异不落盘会丢「关页前最后一次换绑/解绑」）。
      // matched 为对象（菜单侧换绑命中回包捎来——matchedBy/score 是同层
      // 平铺字段）时经 applyMatchResult 整组重建 name/al/证据，而非只补
      // neteaseId：异引用对象的错配元信息残留要连根修，与菜单侧口径齐；
      // matched 缺席（解绑或旧调用方不捎第 4 参）维持裸写原口径
      if (matched && typeof matched === 'object') {
        applyMatchResult(currentSong.value, matched,
          { matchedBy: matched.matchedBy, matchScore: matched.score })
      } else {
        currentSong.value.neteaseId = neteaseId ?? null
      }
      savePlaylistsToStorage()
      void loadLyrics(currentSong.value)
    }
    lyricRematchHandler = onLyricRematch
    // 遥控 seek 销账槽注册：与 lyricRematchHandler 同生命周期口径——卸载只摘
    // 自己的槽（测试多实例共存时不误摘新实例的注册）
    const onRemoteSeek = () => { pendingSeekTime = null }
    remoteSeekSettleHandler = onRemoteSeek
    onBeforeUnmount(() => {
      if (lyricRematchHandler === onLyricRematch) lyricRematchHandler = null
      if (remoteSeekSettleHandler === onRemoteSeek) remoteSeekSettleHandler = null
    })

    const postProcessLyrics = async (song, lyricId, seq, signal = null) => {
      if (!lyrics.value.length) return
      // 直调 aiApi.status()——它自带「只缓存成功」的会话 memoize 与
      // invalidateStatus（SettingsPanel 改配置即失效），本层不再另挂第二份
      const st = await aiApi.status()
      // 词属主复查：每个 await 后都可能已切歌/重载——写回前必须确认
      const ownsLyric = () => lyricProcSeq === seq
        && lyricOwnerKey.value === lyricId && currentPlayingId === song.id

      // ① 外部曲歌词归属核验（bilibili/youtube 经匹配才来的词源有风险；
      //    qq 曲用自家词源时不验——词曲同属一台天然正确；仅当回落到匹配的
      //    网易云词源（lyricId==neteaseId）才是嫁接词，照样过核验）。
      //    不因 enabled=false 跳过：服务端先回已落库的判定缓存，命中即生效
      //    ——AI 关停后旧否决仍能挡住错词；未命中才 503 由 catch 放行
      const ext = song?.youtube
        ? { title: song.youtube.title, author: song.youtube.author || '',
            publishedAt: song.youtube.publishedAt }
        : song?.bilibili
          ? { title: song.bilibili.title, author: song.bilibili.author || '',
              publishedAt: song.bilibili.publishedAt }
          : ((song?.qq || QQ_SONG_ID_RE.test(String(song?.id)))
              && String(lyricId) === String(song.neteaseId))
            ? { title: song.name, author: song.ar?.map(a => a.name).join(' ') || '',
                // 与 bv/yt 两支同轴——发行日喂服务端 chrono 判据
                publishedAt: song.qq?.publishedAt }
            // provider 块缺席的裸 bv_/yt_ 老行（isUgcExternalTrack 形态命
            // 中）也可能经 hydrateMatchBinding 补绑吃上嫁接词——一样要验：
            // 曲面元数据喂判定（externalArtistName 复剥 Topic/VEVO 后缀）
            : isUgcExternalTrack(song)
              ? {
                title: song?.name || '',
                author: externalArtistName(song)
                  || (song?.ar || song?.artists || []).map(a => a?.name).filter(Boolean).join(' '),
              }
              : null
      if (ext?.title && ownsLyric()) {
        // 含模型维度——与服务端 vkey 同口径：换模型后旧判定不应再挡路
        const vkey = JSON.stringify([lyricId, ext.title, ext.author, st.model || ''])
        let ok = aiLyricVerdicts.get(vkey)
        const fresh = ok === undefined // 缓存命中的否决静默生效，不重复打扰
        if (fresh) {
          try {
            // verify 秒级任务随切歌一起 abort；translate 刻意不接 signal——
            // 切歌不断连，服务端仍可完成并落库（页面关闭则连服务端一起中止）。
            // 第 5 参携来源轨道 id：yt_ 时服务端反解投稿自署本家进判定语境
            // （非 yt_ 形态服务端正则直接放过，不产生额外上行）；第 6 参携
            // 源发布日——稿日倒挂判据的时间证据，缺席按未知不扰判定
            const v = await aiApi.verifyLyric(lyricId, ext.title, ext.author, signal, song?.id,
              ext.publishedAt)
            ok = v?.ok !== false
            // inconclusive（服务端故障放行）不缓存——恢复后重播要能重验，
            // 与服务端不落库 inconclusive 的口径一致
            if (v && typeof v.ok === 'boolean' && !v.inconclusive) {
              cacheSet(aiLyricVerdicts, vkey, v.ok)
            }
          } catch { ok = true /* 核验通道故障放行——AI 是增强不是门禁 */ }
        }
        if (!ok) {
          if (ownsLyric()) {
            lyrics.value = []
            currentLyricIndex.value = 0
            lyricOwnerKey.value = null
            if (fresh) toast('歌词与歌曲疑似不匹配，已隐藏', 'info')
          }
          // 判否是词源错配信号——外源曲把当前 neteaseId 否进 excludeIds
          // 重跑服务端匹配链，命中即换绑+热重载（每曲每会话限一次，见
          // rematchLyricSource）。词已藏才发：不在判否原地等匹配 RTT
          await rematchLyricSource(song, lyricId, signal)
          return // 词源错了就不必再翻译错词
        }
      }

      // ② 无官方译文 + 非中文语境 → 自动翻译（普通网易云外语曲同样受益）。
      //    AI 关时不再短路：服务端缓存查询先于 aiEnabled 闸——已落库译文
      //    （含官方译文镜像）照常回，要新产译文才 503；会话缓存兜住「每
      //    词源只问一次」，disabled 负结果同样落账不再重打
      if (!ownsLyric() || !lyrics.value.length) return
      if (lyrics.value.some(l => l.translation)) return
      // 无时间戳的纯文本词不翻——译文靠时间戳回贴（mergeTranslations 0.5s
      // 合并窗），无戳行没有挂载点，打了也合不进
      if (!lyrics.value.some(l => Number.isFinite(l.time))) return
      if (lyricCjkDominant(lyrics.value)) return
      // 缓存键含模型——与服务端 getCachedTranslation(id, aiModel()) 同口径：
      // 换模型后旧译文不再命中重贴（verify vkey 早已同规）
      const tkey = `${lyricId}|${st?.model || ''}`
      try {
        let tlyric = aiLyricTranslations.get(tkey)
        let lines = null
        if (tlyric === undefined) {
          try {
            const r = await aiApi.translateLyric(lyricId)
            tlyric = r?.tlyric || null
            lines = r?.lines
            // 负结果也入会期缓存（skip 哨兵/already-zh/无词）——否则每播
            // 一次同首歌都重打一次 translate；请求异常走 catch 不缓存
            cacheSet(aiLyricTranslations, tkey, tlyric)
          } catch (e) {
            // AI 未配置（503 enabled:false）是确定负结果——缓存 null 防每
            // 播重打；其余通道故障不固化（恢复后重播要能重试）
            if (e?.response?.data?.enabled === false) {
              cacheSet(aiLyricTranslations, tkey, null)
            } else { throw e }
          }
        }
        if (!tlyric || !ownsLyric()) return
        // 服务端 tlyric 已回贴原时间戳并透传 [offset:] 标签——parse 后时序
        // 与主歌词天然对齐（与 getLyrics 的官方译文合并同一约定）
        const merged = mergeTranslations(lyrics.value, parseLyrics(tlyric))
        if (ownsLyric()) {
          lyrics.value = merged
          if (lines != null) console.log(`🌐 AI 译文已合并（${lines} 行）`)
        }
      } catch { /* 翻译失败静默——原文歌词照常可用 */ }
    }

    // 建表双闸：暂停不建（加载窗内用户已暂停——onpause 早已跑过，没人
    // 清就得靠本闸；起播经 onplay 重建）、无可滚词不建（无戳行 time 全
    // Infinity，建表只会把 currentLyricIndex 从 -1 恒压回 0）
    const lyricsSyncable = () =>
      lyrics.value.some(l => Number.isFinite(l?.time))

    const startLyricSync = () => {
      stopLyricSync()
      if (!isPlaying.value || !lyricsSyncable()) return

      lyricTimer = setInterval(() => {
        if (!howl || !isPlaying.value || lyrics.value.length === 0) return

        // lyricOffsetMs>0（提前）⇔ 播放时钟拨快 offset 再比时间戳
        const rawSeek = howl.seek()
        if (!Number.isFinite(rawSeek)) return
        const currentTimeSeconds = rawSeek + lyricOffsetMs.value / 1000

        // 找到当前时间对应的歌词行
        let newIndex = 0
        for (let i = lyrics.value.length - 1; i >= 0; i--) {
          if (currentTimeSeconds >= lyrics.value[i].time) {
            newIndex = i
            break
          }
        }

        if (newIndex !== currentLyricIndex.value) {
          currentLyricIndex.value = newIndex
        }
      }, 100)
    }

    // 歌词时间校准：±0.5s 步进（步进值在 WatchView 工具条），±300s 封顶（对齐服务端 MAX_OFFSET_MS）。
    // 词属主与值同源——lyricOwnerKey 由 loadLyrics 与 lyrics/offset 一起写入，
    // 不从 currentSong 推导：切歌到 meta 回包之间 key 仍属旧词源，此时调节
    // 写的是「正在显示的这份词」的校准，不会跨歌写污。无词源曲不给校准
    const LYRIC_OFFSET_MAX = 5 * 60 * 1000
    const lyricOwnerKey = ref(null)
    let lyricOffsetSaveTimer = null
    let pendingLyricSave = null
    const flushLyricOffsetSave = () => {
      clearTimeout(lyricOffsetSaveTimer)
      const p = pendingLyricSave
      pendingLyricSave = null
      if (!p) return
      downloadsApi.saveLyricOffset(p.key, p.ms)
        .catch(err => toast(`时间校准保存失败：${err?.message || '网络错误'}`, 'error'))
    }
    const scheduleLyricOffsetSave = () => {
      const key = lyricOwnerKey.value
      const ms = lyricOffsetMs.value
      if (key == null) return
      // 换词源前先冲刷上一首的待发写——共享 timer 被顶替会静默丢写
      if (pendingLyricSave && pendingLyricSave.key !== key) flushLyricOffsetSave()
      pendingLyricSave = { key, ms }
      clearTimeout(lyricOffsetSaveTimer)
      lyricOffsetSaveTimer = setTimeout(flushLyricOffsetSave, 400)
    }
    const adjustLyricOffset = (deltaMs) => {
      // 切歌/歌词在途期间禁调——显示的词与 offset 还是旧曲的
      if (lyricOwnerKey.value == null || !lyrics.value.length
          || songSwitching.value || loadingLyrics.value) return
      lyricOffsetMs.value = Math.max(-LYRIC_OFFSET_MAX,
        Math.min(LYRIC_OFFSET_MAX, lyricOffsetMs.value + deltaMs))
      scheduleLyricOffsetSave()
    }
    const resetLyricOffset = () => {
      if (lyricOwnerKey.value == null || lyricOffsetMs.value === 0
          || songSwitching.value || loadingLyrics.value) return
      lyricOffsetMs.value = 0
      scheduleLyricOffsetSave() // PUT 0 = 服务端删行复位
    }

    // 外源名上屏表：hit.source 是 /lyric/external 级联回带的源标记
    const EXTERNAL_LYRIC_SOURCE_NAME = { ytm: 'YouTube Music', lrclib: 'LRCLIB', kugou: '酷狗' }

    // 「获取歌词/重新获取」手动闸（watch 歌词工具条）：自动外源支的静默
    // 兜底（404/网络错同归空词）在手动路径改成显式终态文案。检索料序按
    // song.custom 位分家——custom=true 才是「SongFormDialog 手改过名」
    // 的真信号，手改曲 song.name 优先；非 custom 一律 provider 原标题
    // （ext.title）优先——错绑烘进 name 的 matched 残留名是污染不是用户
    // 意图，不再当查询料。ar 补 artist 缺省。
    // ++lyricLoadSeq 升号挤掉在途自动加载（其晚到回包走 stale 丢弃，
    // finally 见 stale 不复位 loadingLyrics——本代接管后自己清）；
    // 本代被切歌/重进顶替时（currentPlayingId 换号或 seq 再升）静默不写
    const manualFetchLyrics = async () => {
      const song = currentSong.value
      if (!song || lyricFetching.value || songSwitching.value) return
      // file_ 曲词源是上传的 .lrc 工件——外部级联里没有它的条目，换词
      // 走重新上传（编辑弹窗换 .lrc 后 reloadLyrics 热重载），不打
      // /lyric/external 白跑一条级联
      if (isFileTrackId(song.id)) {
        toast('本地上传曲的歌词来自上传的 .lrc 文件，请重新上传更换歌词', 'info')
        return
      }
      const mySeq = ++lyricLoadSeq
      const stale = makeLyricStale(song, null, mySeq)
      lyricFetching.value = true
      loadingLyrics.value = false // 本代接管词态——被挤掉的在途自动加载不再复位它
      try {
        // 无 signal——与 reloadLyrics/换绑热重载同口径：写共享态靠
        // stale 闸（切歌后回包落不了），请求本体让它自然跑完。
        // 检索料序按 custom 位分家（头注）：custom 曲保留「手改名优先」
        // 设计意图；非 custom 取 provider 原标题，extTitle 缺席回退 name
        const feed = lyricSearchFeed(song)
        const hit = await musicApi.getExternalLyric({
          id: song.id,
          title: song.custom ? (feed.name || feed.extTitle) : (feed.extTitle || feed.name),
          artist: feed.extAuthor || feed.artistsJoined || '',
          durationSec: feed.durationSec,
        })
        if (stale()) return
        if (!hit) { // 404 已被 api 归一成 null——「外面确实没词」
          toast('外部词源暂无这首歌的歌词', 'info')
          return
        }
        const res = await applyExternalLyricHit(song, hit, {
          stale,
          // 防降级：屏上已是滚动词（有有限 time 行）时纯文本命中不许盖掉
          // ——反向的纯文本→滚动词升级照常放行（synced 真直接过闸）
          admit: ({ synced }) => synced || !lyrics.value.some(l => Number.isFinite(l.time)),
        })
        if (stale()) return
        if (!res.applied) {
          toast('外源仅有纯文本歌词，保留现有滚动词', 'info')
          return
        }
        // 命中但行集为空（lrc 剥完行首元行/空行后一行不剩）：屏上已被
        // 清空，归「暂无歌词」话术——不报「已获取」假成功
        if (!res.rows.length) {
          toast('外部词源暂无这首歌的歌词', 'info')
          return
        }
        toast(`已从 ${EXTERNAL_LYRIC_SOURCE_NAME[hit.source] || '外部词源'} 获取歌词`, 'success')
      } catch (e) {
        // abort/切歌（本代 seq 已被顶替）静默——不写界面
        if (stale() || e?.name === 'AbortError' || e?.name === 'CanceledError'
            || e?.code === 'ERR_CANCELED') return
        // 429 分诊与 alignCurrentLyrics 同口径——级联限流桶专属文案
        toast(e?.response?.status === 429 ? '请求过于频繁，稍后再试' : '歌词源暂时不可用，稍后重试', 'error')
      } finally {
        // 锁代次化：本代被切歌/重载顶替（seq 失配）时不抢新代的锁——
        // 悬挂锁已由新加载代在 ++lyricLoadSeq 处自清
        if (mySeq === lyricLoadSeq) lyricFetching.value = false
      }
    }

    // 「生成滚动词」手动闸：纯文本词（无有限时间戳）借服务端
    // /lyric-align 补轴——ffmpeg 抽已下载音频包络 + 行首映射产滚动
    // LRC。songId 寻址（服务端跨歌单查 download_tasks completed 工件），
    // 行集直传当下屏上词。音频缺失/ffmpeg 缺席/限流按 status 分诊文案；
    // 结果不落 lyricOwnerKey——同一份词只是补了轴，校准/词属照旧
    const alignCurrentLyrics = async () => {
      const song = currentSong.value
      // songSwitching 闸与 manualFetchLyrics 同口径——切歌窗内 currentSong
      // 已换新曲而屏上词/音频仍是旧曲，此时放过去会拿新曲音频对旧词打轴
      if (!song || lyricFetching.value || songSwitching.value) return
      // 仅纯文本词有补轴意义——滚动词再对齐是降级（入口显隐同口径）
      if (!lyrics.value.length || !lyrics.value.every(l => !Number.isFinite(l.time))) return
      const rawLines = lyrics.value.map(l => l.text).filter(Boolean)
      if (!rawLines.length) return
      // lyricAlignBody 契约上限（shared/contracts.js 同一份常量）：超限
      // 原样发只会吃笼统 400；就地截断，成功文案补注对齐范围
      const truncated = rawLines.length > LYRIC_ALIGN_MAX_LINES
        || rawLines.some(l => l.length > LYRIC_ALIGN_MAX_LINE_CHARS)
      const lines = rawLines.map(t => t.slice(0, LYRIC_ALIGN_MAX_LINE_CHARS)).slice(0, LYRIC_ALIGN_MAX_LINES)
      const mySeq = ++lyricLoadSeq
      const stale = makeLyricStale(song, null, mySeq)
      lyricFetching.value = true
      loadingLyrics.value = false
      try {
        const res = await musicApi.lyricAlign({ songId: song.id, lines })
        if (stale()) return
        const rows = parseLyrics(res?.lrc || '')
        if (!rows.length) { toast('生成滚动歌词失败', 'error'); return }
        lyrics.value = rows
        currentLyricIndex.value = 0
        // 词面换代：在途 postProcess（旧行集的核验/翻译批次）seq 失配
        // 自然失效，不得再往新行集写回；词属主键不变（同词仅补轴）
        const seq = ++lyricProcSeq
        startLyricSync()
        // 纯文本批次此前在 postProcess「无有限戳无挂载点」闸早退，AI
        // 核验/翻译永久错过——补轴成行集有戳后按原词属主键重发一轮补位。
        // ownsLyric 归属闸要求 lyricOwnerKey 非空：已 null 化就不发
        if (lyricOwnerKey.value) {
          void postProcessLyrics(song, lyricOwnerKey.value, seq)
            .catch(e => console.warn('AI 歌词后处理异常:', e))
        }
        toast(truncated ? '已生成滚动歌词（超出上限部分已截断）' : '已生成滚动歌词', 'success')
      } catch (e) {
        if (stale() || e?.name === 'AbortError' || e?.name === 'CanceledError'
            || e?.code === 'ERR_CANCELED') return
        const st = e?.response?.status
        toast(st === 404 ? '该歌曲还没有已下载的音频，无法生成滚动歌词'
          : st === 503 ? 'ffmpeg 不可用，无法生成滚动歌词'
          : st === 429 ? '请求过于频繁，稍后再试'
          : '生成滚动歌词失败', 'error')
      } finally {
        // 同 manualFetchLyrics：本代被顶替时不抢新代的锁
        if (mySeq === lyricLoadSeq) lyricFetching.value = false
      }
    }

    // ── watch 顶行「下载」键：当前正播曲下载到服务器 ──
    // 归属寻址与 playDownloadedCopy 同一张形态闸：纯数字 id 服务端直解
    // （库行/上游导入），local_pl_/saved_queue_ 先镜像再提交，null/
    // single_song_ 壳/杂形不提交必 400 的裸 id——早退给指引。
    // 任务在服务端跑：切歌/换代不打断在途下载——只挡结果 toast 与终态
    // 写回（stale 判 currentPlayingId）；busy 闸按曲锚定（downloadingSongId），
    // 换回在途曲仍显下载中、同曲连点不重复提交
    const downloadingSongId = ref(null)
    const songDownloading = computed(() => downloadingSongId.value != null
      && String(downloadingSongId.value) === String(currentSong.value?.id))
    const downloadCurrentSong = async () => {
      const song = currentSong.value
      // file_ 上传曲资产本就在服务端（键面也不亮）；busy 闸挡同曲连点
      if (!song || songDownloading.value || isFileTrackId(song.id)) return
      // 成员预检先于形态闸：归属单曲目表在而在播曲不在（「下一首播放/
      // 队尾加入/相关接续」只进 playingSongs 不落户歌单）时，服务端按单
      // 查曲必 404「歌曲不存在」——先扫全库找一张曲目含该曲的可提交单
      // 顶替寻址；扫不到给指引早退，不白跑一次必败提交。库行缺 tracks
      // （远端单详情未摊进库/离库悬空 id）按无法验证放行，交服务端兜底
      let pl = queueOwner.value
      if (Array.isArray(pl?.tracks) && !pl.tracks.some(t => String(t.id) === String(song.id))) {
        pl = findDownloadAddrPlaylist(song) ?? null
        if (!pl) {
          toast('该歌曲不在任何歌单中，请先加入歌单再下载', 'info')
          return
        }
      }
      const playlistId = pl?.id ?? playingPlaylistId.value ?? null
      // 服务端 resolvePlaylistId 只接数字 id 与镜像形态 local_pl_/
      // saved_queue_；null/single_song_ 壳/其它杂形提交必 400——早退给指引
      const plKey = String(playlistId ?? '')
      if (!NETEASE_ID_RE.test(plKey) && !MIRROR_PLAYLIST_ID_RE.test(plKey)) {
        toast('当前队列未归属歌单，点「存为歌单」后再下载', 'info')
        return
      }
      // 结果 toast/终态写回的归属闸：任务本体不受切歌影响（服务端继续跑）
      const stale = () => currentPlayingId !== song.id
      downloadingSongId.value = song.id
      try {
        // 本地单先补镜像（幂等：内容签名未变服务端短路返回）——顶替寻址的
        // 兜底单同样要先把曲目表镜像上去，服务端才认得出该曲成员。寻址对象
        // 缺席时跳镜像——服务端若留有旧镜像行仍按 neteasePlaylistId 命中，
        // 解不出由服务端报错透传
        if (isLocalPlaylistId(playlistId) && pl) {
          await downloadsApi.mirrorLocalPlaylist(pl).catch(() => null)
        }
        let submitted = null
        try {
          submitted = await downloadsApi.downloadSongToServer(playlistId, song.id, {
            bitrate: 320000,
            downloadAudio: true,
            downloadLyrics: true,
            downloadCover: true,
            // 可视曲连视频档一起下：yt 支与 canServerVideo 同口径收
            // hasDownloadableVideo（兜 vp9/av01 独占稿）+hasVideo（旧数据），
            // bv 支沿用 hasVideo；两域各自限定，qq_/file_ 到不了这里
            downloadVideo: song.youtube?.hasDownloadableVideo === true
              || song.youtube?.hasVideo === true
              || song.bilibili?.hasVideo === true,
          })
        } catch (e) {
          // 409 = 该曲任务已在跑——瞬时态不是失败：既有任务继续下，进轮询等终态
          if (e?.response?.status !== 409) throw e
        }
        if (submitted?.data?.status === 'completed') {
          if (!stale()) toast('下载成功', 'success')
          return
        }
        if (!stale()) toast('已加入下载队列', 'info')
        // 终态轮询（useServerDownloads 同款范式）：1.5s 间隔、连续 3 次探测
        // 失联才弃、封顶 3min——超时任务在服务端照跑，只少一枚成功 toast
        const deadline = Date.now() + 3 * 60 * 1000
        let pollErrors = 0
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 1500))
          let st = null
          try {
            st = (await downloadsApi.getSongDownloadStatus(playlistId, song.id))?.data
          } catch { /* 探测抛错与下方 data 缺省同归失联计数 */ }
          // data 缺省的 200 回包（网关掐 body/代理截断）与抛错同计——
          // 探测内容不可读即失联，攒满阈值收束而非空轮撑到 deadline
          if (st == null) { if (++pollErrors >= 3) break; continue }
          pollErrors = 0
          if (st.downloaded === true || st.audioReady === true) {
            if (!stale()) toast('下载成功', 'success')
            return
          }
          if (st.task?.status === 'failed') {
            if (!stale()) toast(`下载失败：${st.task?.errorMessage || '未知原因'}`, 'error')
            return
          }
          // 任务行被外部清掉（下载页手动清理）——没有可等的终态
          if (st.task === null) {
            if (!stale()) toast('下载失败：下载任务已不存在（可能在下载页中被清理）', 'error')
            return
          }
        }
        if (!stale()) toast('下载仍在后台进行中，可稍后在下载页里查看结果', 'info')
      } catch (e) {
        if (!stale()) toast(`下载失败：${apiErrorMessage(e) || '网络错误'}`, 'error')
      } finally {
        // 闸按曲锚定：期间别曲下载把标记换走了不能误解别人的锁
        if (String(downloadingSongId.value) === String(song.id)) downloadingSongId.value = null
      }
    }

    // 播放进度更新（单条 rAF 循环：startProgressLoop 幂等，避免重复并发循环）
    const updateProgress = () => {
      progressRafId = null
      if (howl && isPlaying.value) {
        const t = howl.seek()
        if (Number.isFinite(t)) currentTime.value = t
        progressRafId = requestAnimationFrame(updateProgress)
      }
    }

    const startProgressLoop = () => {
      if (progressRafId === null) {
        progressRafId = requestAnimationFrame(updateProgress)
      }
    }

    // 播放控制
    const togglePlay = () => {
      // 实例已销毁（加载失败/超时后）但歌曲仍在：原地重走 playSong 恢复，
      // 不再让播放键变成永久摆设
      if (!howl) {
        if (currentSong.value && !songSwitching.value) {
          playSong(currentSong.value, {
            preserveContext: true,
            // 续播 seek 未落地实例就死了（加载失败/等手势回收）：重试仍从
            // 挂账续播点起，而不是被清零的 currentTime
            seekTime: pendingSeekTime ?? currentTime.value
          })
        }
        return
      }

      // 检查当前Howler实例是否对应当前歌曲
      if (currentSong.value && currentPlayingId !== currentSong.value.id) {
        console.log('🚫 播放控制被忽略，当前Howler实例不匹配当前歌曲')
        return
      }

      // 加载窗（howl 已建、onload 未至，最长看门狗 ~20s）：此时 howl.play()
      // 走 Howler 内部 _queue 排队，onload 的 autoplay 分支又补一次 play——
      // 两条 _inactiveSound 各起一个轨道叠加成双音轨。加载中本就无声可听，
      // 播放键按了也无可闻反馈——吞掉这次点击是唯一不叠轨的口径
      if (howl.state?.() === 'loading') return

      if (isPlaying.value) {
        howl.pause()
      } else {
        howl.play()
      }
    }

    // 以歌曲ID在播放快照中实时定位，避免 VIP 过滤/浏览切单导致索引漂移。
    // computed 记忆化：底栏 :current-index 与远端广播每帧调用不再线性扫全队列，
    // 仅 currentSong/playingSongs/filteredSongs 变化时才重算
    const currentPlayingIndexMemo = computed(() => {
      if (!currentSong.value) return -1
      // 与 playSong 一致用 String 比较：不同接口返回的 id 可能是 number 或 string
      return playbackList().findIndex(s => String(s.id) === String(currentSong.value.id))
    })
    const currentPlayingIndex = () => currentPlayingIndexMemo.value

    const previousSong = () => {
      const list = playbackList()
      if (list.length === 0) {
        // 兜底：列表为空且音频确已停止时复位播放态（正常播放中则保持 true）
        if (!howl || !howl.playing()) isPlaying.value = false
        return
      }

      const cur = currentPlayingIndex()
      if (playMode.value === 'single' && cur >= 0) {
        // 单曲循环重播：实例还在就直接 seek 重播，不必重走 getSongUrl+加载全流程
        if (howl && currentSong.value && String(currentSong.value.id) === String(list[cur].id)) {
          howl.seek(0)
          if (!howl.playing()) howl.play()
        } else {
          playSong(list[cur], { preserveContext: true })
        }
        return
      }

      let newIndex = cur >= 0 ? cur - 1 : 0
      if (cur >= 0 && newIndex < 0) {
        if (playMode.value === 'loop') {
          newIndex = list.length - 1
        } else {
          return // 列表播放模式下，到达第一首就停止
        }
      }

      const song = list[newIndex]
      if (song) {
        playSong(song, { preserveContext: true })
      }
    }

    const nextSong = (opts = {}) => {
      const list = playbackList()
      if (list.length === 0) {
        if (!howl || !howl.playing()) isPlaying.value = false
        return
      }

      const cur = currentPlayingIndex()
      if (playMode.value === 'single' && cur >= 0) {
        // 与 previousSong 同款：实例存活则就地重播
        if (howl && currentSong.value && String(currentSong.value.id) === String(list[cur].id)) {
          howl.seek(0)
          if (!howl.playing()) howl.play()
        } else {
          playSong(list[cur], { preserveContext: true })
        }
        return
      }

      let newIndex = cur >= 0 ? cur + 1 : 0
      if (newIndex >= list.length) {
        if (playMode.value === 'loop') {
          newIndex = 0
        } else if (opts.autoplay && autoplayOn.value) {
          // YTM 自动播放：队列耗尽时接相关歌曲续播；拉不到才落到停止分支
          continueWithRelated().then(ok => { if (!ok) stopAtQueueEnd() })
          return
        } else if (!opts.autoplay) {
          // 手动点「下一首」在队尾：autoplay 开着就接相关曲续播（YTM 队列无尽头），
          // 关了才静默无效——该键不该变成"停止"键
          if (autoplayOn.value) {
            continueWithRelated().then(ok => { if (!ok) stopAtQueueEnd() })
          }
          return
        } else {
          stopAtQueueEnd()
          return
        }
      }

      const song = list[newIndex]
      if (song) {
        playSong(song, { preserveContext: true })
      }
    }

    // 队列播尽的停止收尾（抽出共用：直接停止路径与 autoplay 拉取失败路径）
    const stopAtQueueEnd = () => {
      // 列表播放到末尾：显式停止播放态，否则 isPlaying 残留 true、rAF 空转。
      // 手动点下一首到末尾时音频其实还在响——必须真停 howl，
      // 否则 UI/MediaSession 显示暂停但声音继续（自然播完路径的 stop 无害空转）
      if (howl?.playing()) howl.pause()
      isPlaying.value = false
      currentTime.value = duration.value
      // 「已播完」记 0 而非尾刻：存档续播点落 currentTime=duration 的话，
      // 重启恢复 seek 会被 onload 的 -0.5s 尾钳钉回最后半秒（已播完的曲
      // 不该再送用户回结尾）。UI 进度照常显示走满——落盘写挂账与播放位
      // 续播同一机制（pendingSeekTime），用户显式 seek/下次起播时销账
      pendingSeekTime = 0
      savePlaybackTimeIfNeeded(true)
    }

    const handleSongEnd = () => {
      if (playMode.value === 'single') {
        // 单曲循环：延迟到下一拍再重播。Howler 的 _ended 在 emit('end') 之后还会
        // 对当前 sound 执行内部 stop()，若在此同步 seek+play，刚发起的 play()
        // Promise 会被内部 stop 打断并触发 playerror，单曲循环失效。
        const endedHowl = howl
        const endedSongId = currentPlayingId
        setTimeout(() => {
          // 期间若已切歌/卸载/被暂停则放弃重播（onend 本身不重置 isPlaying）
          if (endedHowl && howl === endedHowl && currentPlayingId === endedSongId && isPlaying.value) {
            endedHowl.seek(0)
            endedHowl.play()
          }
        }, 0)
      } else {
        // 列表播放和列表循环：播放下一首（队列耗尽时走 autoplay 接续）
        nextSong({ autoplay: true })
      }
    }

    // 播放模式切换
    const togglePlayMode = () => {
      const modes = ['list', 'loop', 'single']
      const currentIndex = modes.indexOf(playMode.value)
      const nextIndex = (currentIndex + 1) % modes.length
      playMode.value = modes[nextIndex]
      console.log('🔄 播放模式切换为:', getPlayModeText())
      savePlayerStateToStorage()
    }

    const getPlayModeText = () => {
      switch (playMode.value) {
        case 'list': return '顺序'
        case 'loop': return '循环'
        case 'single': return '单曲'
        default: return '顺序'
      }
    }

    // 进度条点击跳转（子组件传来归一化比例 0-1）
    const seekTo = (ratio) => {
      if (!howl || !Number.isFinite(duration.value) || duration.value <= 0 || !Number.isFinite(ratio)) return

      const clamped = Math.max(0, Math.min(1, ratio))
      const seekTime = clamped * duration.value

      // 显式 seek 销「已播完」挂账——下拍落盘写用户选的新播放位而非 0
      pendingSeekTime = null
      howl.seek(seekTime)
      currentTime.value = seekTime
      // 拖拽中高频 seek：走非强制路径，整秒去重限制 localStorage 写入频率
      savePlaybackTimeIfNeeded()
    }

    // 音量控制（拖动滑块高频触发，持久化做防抖）
    const updateVolume = (newVolume) => {
      const v = Number(newVolume)
      if (!Number.isFinite(v)) return
      const volumeValue = Math.max(0, Math.min(100, v))
      volume.value = volumeValue

      if (howl) {
        howl.volume(volumeValue / 100)
      }

      clearTimeout(volumeSaveTimer)
      volumeSaveTimer = setTimeout(savePlayerStateToStorage, 300)
    }

    const openFullscreenPlayer = () => {
      if (!currentSong.value) return
      // 元素级全屏（watch 视频全屏键）激活时：overlay 开在 top layer 之下
      // 完全不可见，退出视频全屏后用户会意外落在沉浸层——此时拒开
      if (typeof document !== 'undefined'
        && (document.fullscreenElement || document.webkitFullscreenElement)) return
      isFullscreenPlayerOpen.value = true // 由 watch 统一持久化
    }

    const closeFullscreenPlayer = () => {
      isFullscreenPlayerOpen.value = false
    }

    watch(currentTime, () => {
      savePlaybackTimeIfNeeded()
    })

    watch(autoplayOn, () => savePlayerStateToStorage())
    // 播放错误在 watch 视图走 toast（toast('error') 内已推表盘）——
    // 此 watcher 兜非 watch 视图落地时的 glitch 信号：
    // 错误出现瞬间全屏腐蚀字符同代闪回（其他主题零成本 no-op）
    watch(playbackError, v => { if (v) glitchBurst() })

    // MediaSession：锁屏/耳机线控/系统媒体键。action handler 在挂载时注册一次，
    // 元数据与 playbackState 随播放状态同步；不支持的环境静默跳过
    const updateMediaSession = () => {
      if (!('mediaSession' in navigator)) return
      const song = currentSong.value
      if (song) {
        const artists = (song.ar || song.artists || [])
          .map(a => a?.name).filter(Boolean).join(', ')
        const pic = songCoverUrl(song) // file_ 上传曲封面走 file 端点，不只认 al.picUrl
        // 门控判加工后值：proxiedCoverUrl fail-closed 对非白名单/非标端口回 ''——
        // 裸 pic 守卫会把空 artwork 或源站裸链塞进锁屏元数据（后者破零外联不变式）
        const art = pic ? httpsCover(proxiedCoverUrl(pic)) : ''
        try {
          navigator.mediaSession.metadata = new MediaMetadata({
            title: song.name || '',
            artist: artists,
            album: song.al?.name || song.album?.name || '',
            artwork: art ? [{ src: art, sizes: '512x512' }] : []
          })
        } catch { /* 旧浏览器 MediaMetadata 构造可能抛错，忽略 */ }
      } else {
        // 歌曲清空时同步清元数据，否则锁屏残留上一首的标题/封面
        navigator.mediaSession.metadata = null
      }
      navigator.mediaSession.playbackState =
        isPlaying.value ? 'playing' : (song ? 'paused' : 'none')
    }

    const setupMediaSessionHandlers = () => {
      if (!('mediaSession' in navigator)) return
      const handlers = {
        play: () => togglePlay(),
        pause: () => { if (howl && isPlaying.value) howl.pause() },
        previoustrack: () => previousSong(),
        nexttrack: () => nextSong(),
        seekto: (d) => {
          if (howl && typeof d?.seekTime === 'number' && Number.isFinite(d.seekTime)) {
            const t = Math.max(0, Math.min(d.seekTime, duration.value || 0))
            pendingSeekTime = null // 显式 seek 销「已播完」挂账（同 seekTo 口径）
            howl.seek(t)
            currentTime.value = t
          }
        }
      }
      for (const [action, handler] of Object.entries(handlers)) {
        try { navigator.mediaSession.setActionHandler(action, handler) } catch { /* 个别动作不受支持 */ }
      }
    }

    const teardownMediaSession = () => {
      if (!('mediaSession' in navigator)) return
      for (const action of ['play', 'pause', 'previoustrack', 'nexttrack', 'seekto']) {
        try { navigator.mediaSession.setActionHandler(action, null) } catch { /* 忽略 */ }
      }
      navigator.mediaSession.metadata = null
      navigator.mediaSession.playbackState = 'none'
    }

    watch([currentSong, isPlaying], updateMediaSession)

    // 后台标签页 rAF 冻结，watch(currentTime) 停转 → 进度持久化滞后；
    // 切回前台/离开前补一次强制落盘。pagehide 兜底 iOS Safari 杀页/bfcache
    // 路径——那里 visibilitychange 不保证触发
    const onVisibilityFlush = () => {
      if (document.visibilityState === 'hidden') savePlaybackTimeIfNeeded(true)
    }
    const onPageHide = () => savePlaybackTimeIfNeeded(true)
    document.addEventListener('visibilitychange', onVisibilityFlush)
    window.addEventListener('pagehide', onPageHide)

    // ←→ 键盘进退：直接作用 howl（等价于拖进度条），5s 步长对齐 YTM
    const seekBy = (delta) => {
      if (!howl || !Number.isFinite(duration.value) || duration.value <= 0) return
      const t = Math.max(0, Math.min((howl.seek() ?? 0) + delta, duration.value))
      pendingSeekTime = null // 显式 seek 销「已播完」挂账（同 seekTo 口径）
      howl.seek(t)
      currentTime.value = t
      savePlaybackTimeIfNeeded(true)
    }
    // 组件卸载：清理定时器/rAF/音频，避免泄漏与卸载后重连
    onBeforeUnmount(() => {
      if (currentAbortController) {
        currentAbortController.abort()
        currentAbortController = null
      }
      // 卸载换代：下载兜底链可能正睡在 ~3min 轮询中途——abort 只断在途
      // fetch，sleep+查状态循环不断；升号让兜底链各处 seq 闸认本代已旧，
      // 轮询走完也不会递归 playSong 在卸载后出声
      playSeq++
      if (progressRafId !== null) {
        cancelAnimationFrame(progressRafId)
        progressRafId = null
      }
      stopLyricSync()
      clearHowlWatchdog()
      clearTimeout(volumeSaveTimer)
      flushLyricOffsetSave() // 卸载前把待发的校准写出去
      document.removeEventListener('visibilitychange', onVisibilityFlush)
      window.removeEventListener('pagehide', onPageHide)
      teardownMediaSession()
      if (howl) {
        howl.stop()
        howl.unload()
        howl = null
      }
    })

    const getHowl = () => howl

    // 多端同步：远端 player-state 已由引擎落进 LS。活动播放中的会话不被
    // 远端队列/进度覆盖（值只落存档，正在播的不强切）；空闲时回读 UI
    // 偏好（音量/循环/随机/自动播放等），续播位留给下次 playSong/重启
    // 恢复自然消费——不主动重建播放
    onRemoteApply(LS_KEYS.PLAYER_STATE, () => {
      if (howl && isPlaying.value) return
      const applied = loadPlayerStateFromStorage()
      // UI 态恢复触发 prefs watcher 冲刷 savePlayerStateToStorage：挂起窗
      // 要盖过 post-flush（nextTick 回调排在 watcher 冲刷后），volume 的
      // 300ms 防抖写盘另算——一并清掉，否则远端续播位（currentSongId/
      // currentTime）还没被消费就被本地内存态重写盖掉
      setPlayerPersistSuspended(true)
      try {
        restoreUiState(applied)
        clearTimeout(volumeSaveTimer)
      } finally {
        void nextTick(() => setPlayerPersistSuspended(false))
      }
      // 远端续播位挂账：本次远端 state 的恢复位原样记账——消费（重启
      // 恢复/本地起播）前 savePlayerStateToStorage 在无正播曲时照账补写。
      // 远端不带续播位（currentSongId 空）即销账——空值也是远端真相
      pendingRemoteResume = applied?.currentSongId != null
        ? {
            selectedPlaylistId: applied.selectedPlaylistId ?? null,
            playingPlaylistId: applied.playingPlaylistId ?? null,
            currentSongId: applied.currentSongId,
            currentTime: Number.isFinite(applied.currentTime) ? applied.currentTime : 0,
          }
        : null
    })

    return {
      // 播放态
      currentSong, playMode, shuffleOn, autoplayOn,
      songSwitching, isPlaying, isFullscreenPlayerOpen,
      currentTime, duration, volume, durationWarning, playbackError,
      playingSongs, queueTitle, queueOwner, playerIsTemp,
      // 歌词态
      lyrics, currentLyricIndex, lyricOffsetMs, loadingLyrics, lyricFetching,
      adjustLyricOffset, resetLyricOffset, scheduleLyricOffsetSave,
      // 手动词务（watch 工具条）：外源重取 / 纯文本补轴成滚动词
      manualFetchLyrics, alignCurrentLyrics,
      // watch 顶行下载键：busy 按曲锚定的在途态 + 提交/轮询动作
      songDownloading, downloadCurrentSong,
      // file_ 曲换歌词文件后热重载：song.id 没变不会触发切歌路径的 loadLyrics，
      // 编辑弹窗传完 .lrc 调它重拉。无 signal——靠 currentPlayingId 守卫丢弃过期回包
      reloadLyrics: () => { if (currentSong.value) loadLyrics(currentSong.value) },
      // 队列操作
      playbackList, currentPlayingIndex, setQueue, toggleShuffle,
      queueJump, queueRemove, queueMove, clearQueue,
      playNextInQueue, addToQueueEnd, saveQueueAsPlaylist, openQueueSource,
      // 播放控制
      playSong, playPlaylist, playPlaylistFromSidebar, playSongFromSearch,
      playSongFromRelated,
      togglePlay, togglePlayMode, getPlayModeText,
      previousSong, nextSong, seekTo, seekBy, updateVolume, toggleMute,
      openFullscreenPlayer, closeFullscreenPlayer,
      // 持久化/会话
      savePlayerStateToStorage, loadPlayerStateFromStorage,
      restoreUiState, restorePlaybackState, savePlaybackTimeIfNeeded,
      setPlayerPersistSuspended,
      setupMediaSessionHandlers, teardownMediaSession, getHowl,
    }
}

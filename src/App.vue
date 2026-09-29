<template>
  <!-- 手机控制器模式 -->
  <RemoteController v-if="remoteMode === 'controller'" :ws-url="remoteControllerWsUrl" :ws-protocols="remoteWsProtocols" />

  <!-- 应用壳：纸面顶栏 / 左库侧栏+全宽主区（每视图一张饱和纸色） / 墨色底条 -->
  <div v-else class="app-shell" :data-view="centerView">
    <!-- 顶部导航（含歌单搜索） -->
    <TopNavigation
      ref="topNavRef"
      :is-downloads-view="centerView === 'downloads'"
      v-model:search-query="searchQuery"
      :sidebar-open="sidebarOpen"
      :remote-mode="remoteMode"
      @toggle-center-view="toggleCenterView"
      @toggle-sidebar="sidebarOpen = !sidebarOpen"
      @search="handlePlaylistSearch"
      @search-by-id="loadPlaylistByIdAndAdd"
    />

    <div class="app-body">
      <!-- 移动端侧栏抽屉遮罩 -->
      <div v-if="sidebarOpen" class="sidebar-scrim lg:hidden" @click="sidebarOpen = false"></div>

      <!-- 左侧：歌单库（桌面常驻 / 移动端抽屉） -->
      <aside class="app-sidebar" :class="{ 'app-sidebar--open': sidebarOpen }" aria-label="歌单库">
        <PlaylistPanel
          :loading="loading"
          :selected-playlist="selectedPlaylist"
          :user-playlists="userPlaylists"
          :home-active="centerView === 'home'"
          @select-playlist="selectPlaylistAndShow"
          @play-playlist="playPlaylistFromSidebar"
          @remove-playlist="removePlaylistFromLibrary"
          @nav-home="navHome"
          @playlist-downloads-deleted="handlePlaylistDownloadsDeleted"
        />
      </aside>

      <!-- 主区：首页发现流 / 歌曲列表 / 搜索结果 / watch 播放页 / 下载管理 -->
      <main class="app-main">
        <HomeFeed
          v-if="centerView === 'home'"
          :toplists="homeToplists"
          :personalized="homePersonalized"
          :hots="homeHots"
          :loading="homeLoading"
          @open="openSearchPlaylist"
          @search="handlePlaylistSearch"
        />
        <SongList
          v-else-if="centerView === 'songs'"
          :songs="songs"
          :loading-songs="loadingSongs"
          :current-song="currentSong"
          :is-playing="isPlaying"
          :show-vip-songs="showVipSongs"
          :current-page="currentPage"
          :page-size="pageSize"
          :selected-playlist="selectedPlaylist"
          :playlist-downloads-refresh-key="playlistDownloadsRefreshKey"
          @play-song="openWatchSong"
          @play-all="playPlaylistAndWatch(false)"
          @play-shuffle="playPlaylistAndWatch(true)"
          @play-next="playNextInQueue"
          @add-to-queue="addToQueueEnd"
          @toggle-vip-songs="showVipSongs = !showVipSongs"
          @go-to-page="goToPage"
          @prev-page="prevPage"
          @next-page="nextPage"
        />
        <PlaylistGrid
          v-else-if="centerView === 'search'"
          :results="searchResults"
          :songs="searchSongResults"
          :current-song="currentSong"
          :user-playlists="userPlaylists"
          :loading="searching"
          @open="openSearchPlaylist"
          @add="addPlaylistToLibrary"
          @play-song="openWatchSearchSong"
          @close="closeSearchView"
        />
        <!-- YTM watch 播放页：点单曲进入；歌词/待播/相关都在页内右栏，不遮主区 -->
        <WatchView
          v-else-if="centerView === 'watch'"
          :current-song="currentSong"
          :is-playing="isPlaying"
          :duration="duration"
          :song-switching="songSwitching"
          :queue="playingSongs"
          :queue-title="queueTitle"
          :lyrics="lyrics"
          :current-lyric-index="currentLyricIndex"
          :loading-lyrics="loadingLyrics"
          :playback-error="playbackError"
          :duration-warning="durationWarning"
          v-model:tab="watchTab"
          v-model:autoplay="autoplayOn"
          @back="watchBack"
          @open-fullscreen="openFullscreenPlayer"
          @queue-jump="queueJump"
          @queue-remove="queueRemove"
          @queue-move="queueMove"
          @save-queue="saveQueueAsPlaylist"
          @clear-queue="clearQueue"
          @play-song="playSongFromRelated"
        />
        <AdminPanel v-else />
      </main>
    </div>

    <!-- 底部播放器（文档流内嵌；无歌曲时渲染待机墨条，全屏沉浸时隐藏） -->
    <BottomPlayer
      v-if="!isFullscreenPlayerOpen"
      :current-song="currentSong"
      :is-playing="isPlaying"
      :current-time="currentTime"
      :duration="duration"
      :volume="volume"
      :muted="volume === 0"
      :song-switching="songSwitching"
      :playback-list="playingSongs"
      :current-index="currentPlayingIndex()"
      :is-temp-playlist="playerIsTemp"
      :side-panel-open="centerView === 'watch'"
      :panel-tab="watchTab"
      :play-mode="playMode"
      :play-mode-text="getPlayModeText()"
      :shuffle-on="shuffleOn"
      @toggle-play="togglePlay"
      @previous="previousSong"
      @next="nextSong"
      @seek="seekTo"
      @update-volume="updateVolume"
      @toggle-mute="toggleMute"
      @toggle-play-mode="togglePlayMode"
      @toggle-shuffle="toggleShuffle"
      @open-watch="openWatchPanel"
      @enter-fullscreen="openFullscreenPlayer"
    />


    <!-- 全局 toast + 确认模态宿主（替代原生 alert/confirm） -->
    <FeedbackHost />

    <FullscreenPlayer
      v-if="isFullscreenPlayerOpen && currentSong"
      :current-song="currentSong"
      :is-playing="isPlaying"
      :current-time="currentTime"
      :duration="duration"
      :volume="volume"
      :lyrics="lyrics"
      :song-switching="songSwitching"
      :lyric-mode="fullscreenLyricMode"
      :interaction-mode="fullscreenInteractionMode"
      @close="closeFullscreenPlayer"
      @toggle-play="togglePlay"
      @previous-song="previousSong"
      @next-song="nextSong"
      @seek-to="seekTo"
      @update-volume="updateVolume"
      @update:lyric-mode="fullscreenLyricMode = $event"
      @update:interaction-mode="fullscreenInteractionMode = $event"
    />
  </div>
</template>

<script>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { Howl } from 'howler'
import { musicApi } from './api/music'
import { resolveApiBaseUrl } from './lib/api-base'
import { formatTime } from './lib/format'
import { isVipSong, isLocalPlaylistId } from './lib/song'
import { toast, isConfirmOpen, resolveConfirm } from './lib/feedback'
import { glitchBurst } from './lib/theme'
import { httpsCover } from './lib/url'
import TopNavigation from './components/TopNavigation.vue'
import PlaylistPanel from './components/PlaylistPanel.vue'
import PlaylistGrid from './components/PlaylistGrid.vue'
import HomeFeed from './components/HomeFeed.vue'
import SongList from './components/SongList.vue'
import WatchView from './components/WatchView.vue'
import FeedbackHost from './components/FeedbackHost.vue'
import BottomPlayer from './components/BottomPlayer.vue'
import FullscreenPlayer from './components/FullscreenPlayer.vue'
import RemoteController from './components/RemoteController.vue'
import AdminPanel from './components/AdminPanel.vue'

export default {
  name: 'App',
  components: {
    TopNavigation,
    PlaylistPanel,
    PlaylistGrid,
    HomeFeed,
    SongList,
    WatchView,
    FeedbackHost,
    BottomPlayer,
    FullscreenPlayer,
    RemoteController,
    AdminPanel
  },
  setup() {
    // 响应式数据
    const searchQuery = ref('')
    const loading = ref(false)
    const loadingSongs = ref(false)
    const searchResults = ref([]) // 搜索结果
    const userPlaylists = ref([]) // 用户添加的歌单
    const selectedPlaylist = ref(null)
    const songs = ref([])
    const currentSong = ref(null)
    const showVipSongs = ref(true) // 控制VIP歌曲显示，默认显示
    const playMode = ref('list') // 播放模式：'list'(列表播放), 'loop'(列表循环), 'single'(单曲循环)
    // 随机播放是独立于 playMode 的正交开关（YTM 同款：shuffle 直接物理打乱播放队列）
    const shuffleOn = ref(false)
    let queueOriginalOrder = null // 打乱前的队列原序——关掉随机时还原
    const lyrics = ref([])
    const currentLyricIndex = ref(0)
    // watch 播放页：右栏 tab（待播/歌词/相关）与 YTM UP NEXT 自动播放开关
    const watchTab = ref('queue')
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
    // 播放上下文快照：播 A 歌单时浏览 B 歌单不应劫持上一首/下一首/播完接续。
    // playSong 默认把当时的 filteredSongs 定格为播放队列，歌单内导航传 preserveContext 复用
    const playingSongs = ref([])
    const playingPlaylistId = ref(null) // 快照所属歌单 id——持久化恢复用它而非浏览态 id
    // Howler 加载看门狗：CDN 黑洞时 onload/onloaderror 都不会触发，
    // 没有它 songSwitching 会永久卡住播放键
    const PLAYBACK_LOAD_TIMEOUT_MS = 20000
    const fullscreenLyricMode = ref('original')
    const fullscreenInteractionMode = ref('auto')
    const PLAYER_STATE_STORAGE_KEY = 'meowsync-player-state'
    const PLAYLISTS_STORAGE_KEY = 'userPlaylists'
    const REMOVED_DEFAULT_PLAYLISTS_KEY = 'removedDefaultPlaylists'
    let restorePlayerState = null
    let lastSavedWholeSecond = -1

    // 分页相关数据（仅歌曲列表保留分页；歌单库是全滚动）
    const currentPage = ref(1)
    const pageSize = ref(10)

    // YTM 式布局状态：主区视图（首页/歌曲/搜索结果/下载管理）+ 两个按需抽屉
    const centerView = ref('home') // 'home' | 'songs' | 'search' | 'watch' | 'downloads'
    const sidebarOpen = ref(false) // 移动端歌单库抽屉
    const searching = ref(false) // 仅驱动搜索结果网格的加载态（勿与歌单库 loading 混用）
    const searchSongResults = ref([]) // 单曲搜索结果（与歌单结果同区展示）
    const playlistDownloadsRefreshKey = ref(0)
    const topNavRef = ref(null) // 「/」快捷键聚焦搜索框

    // 首页发现流数据（toplist/personalized/search_hot）
    const homeToplists = ref([])
    const homePersonalized = ref([])
    const homeHots = ref([])
    const homeLoading = ref(false)
    
    let howl = null
    let lyricTimer = null
    let progressRafId = null
    let howlWatchdog = null // 加载看门狗定时器（随每个新 Howl 重置）
    let currentAbortController = null // 用于取消正在进行的网络请求
    let currentPlayingId = null // 当前正在播放的歌曲ID，用于防止竞态条件
    let selectReqId = 0 // selectPlaylist 请求序号，防止慢响应覆盖新选择
    let searchReqId = 0 // searchPlaylists 请求序号，同上

    // 远程控制模式
    const urlParams = new URLSearchParams(window.location.search)
    const rawMode = urlParams.get('mode')
    // 'remote' 是 'controller' 的别名——用户/旧链接手滑写 remote 时应进控制器而非普通应用
    const normalizedMode = rawMode === 'remote' ? 'controller' : rawMode
    const remoteMode = ref(['host', 'controller'].includes(normalizedMode) ? normalizedMode : 'off') // 'off' | 'host' | 'controller'

    const apiBase = resolveApiBaseUrl()
    const remoteToken = import.meta.env.VITE_REMOTE_TOKEN || ''
    // token 优先走 Sec-WebSocket-Protocol 子协议——?token= 会落进反代 access log
    // 与浏览器历史。协议值须为 RFC7230 token 字符集，含其他字符时回退 URL 参数
    const tokenSafeForProto = /^[A-Za-z0-9._~-]+$/.test(remoteToken)
    const remoteWsProtocols = remoteToken && tokenSafeForProto ? [`remote.${remoteToken}`] : undefined
    const remoteTokenParam = remoteToken && !tokenSafeForProto
      ? `&token=${encodeURIComponent(remoteToken)}` : ''
    const remoteWsUrl = apiBase.replace(/^http/, 'ws') + '/remote'
    const remoteHostWsUrl = `${remoteWsUrl}?role=host${remoteTokenParam}`
    const remoteControllerWsUrl = `${remoteWsUrl}?role=controller${remoteTokenParam}`
    let remoteWs = null
    let remoteStateTimer = null
    let remoteReconnectTimer = null
    let volumeSaveTimer = null

    // state_update 只保留 controller 端用到的字段，避免整个 song 对象
    // （含 alias/privilege 等大字段）每 2s 全量序列化并广播
    function serializeRemoteSong(song) {
      if (!song) return null
      const artistList = song.ar || song.artists || []
      return {
        id: song.id,
        name: song.name,
        al: { picUrl: song.al?.picUrl ?? song.album?.picUrl ?? '' },
        ar: artistList.map(a => ({ name: a?.name ?? '' }))
      }
    }

    function sendRemoteState() {
      if (!remoteWs || remoteWs.readyState !== WebSocket.OPEN) return
      remoteWs.send(JSON.stringify({
        type: 'state_update',
        payload: {
          isPlaying: isPlaying.value,
          currentSong: serializeRemoteSong(currentSong.value),
          currentTime: currentTime.value,
          duration: duration.value,
          volume: volume.value,
          // 待播队列广播：封顶 50 条防止大歌单撑爆 64KB 帧限制；
          // 当前曲在截断窗外时发 -1——否则服务端 clamp 到 49 会点亮错误的行
          queue: playingSongs.value.slice(0, 50).map(serializeRemoteSong),
          queueIndex: (i => (i >= 0 && i < 50 ? i : -1))(currentPlayingIndex())
        }
      }))
    }

    // 远端控制命令：play/pause 幂等执行（controller 端状态有延迟，不能用 toggle）
    function handleRemoteMessage(msg) {
      switch (msg.type) {
        case 'play':
          // 与 togglePlay 同款的恢复路径：实例已被错误处理销毁时重走 playSong，
          // 否则远端 play 在加载失败后静默失效
          if (!howl) {
            if (currentSong.value && !songSwitching.value) {
              playSong(currentSong.value, { preserveContext: true, seekTime: currentTime.value })
            }
          } else if (!isPlaying.value) {
            howl.play()
          }
          break
        case 'pause':
          if (howl && isPlaying.value) howl.pause()
          break
        case 'next':
          nextSong()
          break
        case 'prev':
          previousSong()
          break
        case 'seek': {
          // 严格校验：null/true/'' 会被 Number() 强转成 0/1 蒙混过 isFinite
          const t = msg.payload
          if (howl && typeof t === 'number' && Number.isFinite(t)) {
            const clamped = Math.max(0, Math.min(t, duration.value || 0))
            howl.seek(clamped)
            currentTime.value = clamped
          }
          break
        }
        case 'volume':
          updateVolume(msg.payload)
          break
        case 'play_song': {
          // 先在播放快照中定位（队列内导航）；命中浏览列表则视为用户跨歌单点歌，
          // 拍新快照；两边都没有则记录日志便于排查，不静默吞掉
          let list = playbackList()
          let targetIndex = list.findIndex(s => String(s.id) === String(msg.payload))
          if (targetIndex !== -1) {
            playSong(list[targetIndex], { preserveContext: true })
          } else {
            list = filteredSongs.value
            targetIndex = list.findIndex(s => String(s.id) === String(msg.payload))
            if (targetIndex !== -1) {
              playSong(list[targetIndex])
            } else {
              console.warn('[remote] play_song 目标不在播放队列或当前列表:', msg.payload)
            }
          }
          break
        }
        case 'request_state':
          sendRemoteState()
          break
      }
    }

    let remoteRetries = 0
    function connectRemoteHost() {
      if (remoteMode.value !== 'host') return
      // 回调一律操作局部 ws：迟到的 onerror/onclose 若引用共享 remoteWs，
      // 会把已被取代的新 socket 误关/清空
      const ws = remoteWs = new WebSocket(remoteHostWsUrl, remoteWsProtocols)
      ws.onopen = () => {
        remoteRetries = 0
        console.log('[remote] host WS connected')
        remoteStateTimer = setInterval(sendRemoteState, 2000)
      }
      ws.onmessage = (e) => {
        try {
          handleRemoteMessage(JSON.parse(e.data))
        } catch { /* 忽略畸形消息 */ }
      }
      ws.onclose = (e) => {
        if (remoteWs === ws) remoteWs = null
        clearInterval(remoteStateTimer)
        remoteStateTimer = null
        // 被新 host 顶替（服务端 close code 4000）：不再重连，
        // 否则两端会反复互踢形成踢皮球循环。这是夺权事件——静默停在 console
        // 会让用户以为遥控还在生效，必须可见提示
        if (e && e.code === 4000) {
          console.warn('[remote] 已有新的 host 接管，本端停止远程控制')
          toast('远程控制已被另一设备接管，本端已退出主机模式（刷新页面可重新接管）', 'error', 5000)
          return
        }
        // 该 socket 已被更新的连接取代，不重连（新连接自己负责）
        if (remoteWs && remoteWs !== ws) return
        // 断线重连有上限：握手即被拒（token/Origin 不通过）时避免无限重试
        remoteRetries++
        if (remoteRetries > 5) {
          // 与 4000 顶替路径对称：遥控静默失效会让用户误以为还在生效
          console.warn('[remote] host 重连次数超限，停止重连（请检查 REMOTE_TOKEN/服务状态）')
          toast('远程控制连接多次失败，已停止重连（刷新页面可重试）', 'error', 5000)
          return
        }
        remoteReconnectTimer = setTimeout(connectRemoteHost, 3000)
      }
      ws.onerror = () => ws.close()
    }

    // 过滤后的歌曲列表（根据VIP显示设置）
    const filteredSongs = computed(() => {
      if (showVipSongs.value) {
        return songs.value // 显示所有歌曲
      } else {
        return songs.value.filter(song => !isVipSong(song)) // 隐藏VIP歌曲
      }
    })
    
    // 分页计算属性
    const totalPages = computed(() => {
      return Math.ceil(filteredSongs.value.length / pageSize.value)
    })

    // 列表缩短时页码收敛，避免空白页
    watch(() => filteredSongs.value.length, () => {
      const max = Math.max(1, totalPages.value)
      if (currentPage.value > max) currentPage.value = max
    })
    // 分页控制函数
    const goToPage = (page) => {
      if (page >= 1 && page <= totalPages.value) {
        currentPage.value = page
      }
    }
    
    const prevPage = () => {
      if (currentPage.value > 1) {
        currentPage.value--
      }
    }
    
    const nextPage = () => {
      if (currentPage.value < totalPages.value) {
        currentPage.value++
      }
    }

    // ── URL 导航（YTM 式：视图/歌单可寻址，浏览器前进后退生效） ──
    const NAV_VIEWS = new Set(['home', 'songs', 'search', 'watch', 'downloads'])
    let suppressNavPush = false // popstate 回放时不再重复入栈

    // 导航 URL 构造：push 与初始化 normalize 共用，保证 pl 语义一致。
    // playlist 显式传入——调用处先 push 再 selectPlaylist，读 selectedPlaylist
    // 会记成"上一个"歌单（off-by-one 历史错位）
    const buildNavUrl = (playlist = selectedPlaylist.value) => {
      const url = new URL(window.location.href)
      url.searchParams.delete('view')
      url.searchParams.delete('pl')
      url.searchParams.set('view', centerView.value)
      // 本地内存态歌单（single_song_/saved_queue_）不进 URL——id 非数字，刷新也无法按歌单恢复
      if (
        centerView.value === 'songs' &&
        playlist?.id != null &&
        !isLocalPlaylistId(playlist.id)
      ) {
        url.searchParams.set('pl', String(playlist.id))
      }
      return url
    }

    const pushNavState = (playlist) => {
      if (suppressNavPush) return
      const url = buildNavUrl(playlist)
      // 同视图重复操作（重搜/重点同一歌单）不堆历史，否则 Back 显得失灵
      if (url.toString() === window.location.href) return
      // 打标记供 watchBack 判断：冷启动直达页（无站内历史）按「返回」应回首页而非退站
      window.history.pushState({ meowsyncNav: 1 }, '', url.toString())
    }

    // popstate → 按 URL 还原视图；view=songs&pl= 时回选对应歌单
    const applyUrlNav = () => {
      const params = new URLSearchParams(window.location.search)
      const view = params.get('view')
      if (!view || !NAV_VIEWS.has(view)) {
        centerView.value = 'home'
        return
      }
      if (view === 'songs') {
        const plId = params.get('pl')
        const target = plId
          ? userPlaylists.value.find(p => String(p.id) === String(plId))
          : null
        // pl 无效/歌单已被删：有选中歌单则仅切视图，否则退回首页
        if (target) selectPlaylist(target)
        else if (!selectedPlaylist.value) { centerView.value = 'home'; return }
      }
      // 冷加载的 ?view=search 没有任何结果，落在空网格上不如回首页
      if (view === 'search' && !searchResults.value.length
          && !searchSongResults.value.length && !searching.value) {
        centerView.value = 'home'
        return
      }
      // watch 页必须有正在播放的歌——冷加载空 watch 没有意义
      if (view === 'watch' && !currentSong.value) {
        centerView.value = selectedPlaylist.value ? 'songs' : 'home'
        return
      }
      centerView.value = view
    }

    // 顶栏搜索：并行搜 歌单 + 单曲（YTM 分区结果）；序号守卫防连搜覆盖
    const handlePlaylistSearch = async (query) => {
      centerView.value = 'search'
      pushNavState()
      const myReq = ++searchReqId
      searching.value = true
      searchSongResults.value = []
      try {
        const [plRes, songRes] = await Promise.allSettled([
          musicApi.searchPlaylists(query),
          musicApi.searchSongs(query, 20)
        ])
        if (myReq !== searchReqId) return
        searchResults.value = plRes.status === 'fulfilled' ? (plRes.value.playlists || []) : []
        searchSongResults.value = songRes.status === 'fulfilled' ? (songRes.value || []) : []
      } finally {
        if (myReq === searchReqId) searching.value = false
      }
    }

    // 点搜索结果卡片 = 打开歌单（不入库）；「+ 收藏」才进侧栏库
    const openSearchPlaylist = async (playlist) => {
      centerView.value = 'songs'
      pushNavState(playlist)
      await selectPlaylist(playlist)
    }

    // 搜索结果返回键：回首页（YTM 语义）而不是硬跳歌曲视图
    const closeSearchView = () => {
      centerView.value = 'home'
      pushNavState()
    }

    // 侧栏「首页」导航项
    const navHome = () => {
      centerView.value = 'home'
      sidebarOpen.value = false
      pushNavState()
    }

    // 侧栏选歌单：回歌曲视图 + 移动端收起抽屉
    const selectPlaylistAndShow = async (playlist) => {
      centerView.value = 'songs'
      sidebarOpen.value = false
      pushNavState(playlist)
      await selectPlaylist(playlist)
    }

    const loadPlaylistByIdAndAdd = async (id) => {
      try {
        loading.value = true
        console.log('🔍 通过ID加载歌单:', id)
        
        // 检查是否已存在（确保ID类型一致）
        const exists = userPlaylists.value.find(p => String(p.id) === String(id))
        if (exists) {
          console.log('ℹ️ 歌单已存在于库中:', exists.name)
          searchQuery.value = ''
          return
        }
        
        const playlist = await musicApi.getPlaylistDetail(id)
        // 接口对不存在的歌单返回无 id 的空壳对象（{ tracks: [] }），须校验后再入库
        if (playlist && playlist.id != null) {
          console.log('✅ 歌单加载成功:', playlist.name)
          await addPlaylistToLibrary(playlist)
          console.log('✅ 歌单已添加到库中')
          
          // 清空搜索框
          searchQuery.value = ''
        } else {
          console.warn('⚠️ 未找到歌单或返回数据无效:', id)
        }
      } catch (error) {
        console.error('❌ 加载歌单失败:', error)
      } finally {
        loading.value = false
      }
    }

    const loadPlaylistById = async (id) => {
      try {
        console.log('🔍 加载歌单详情:', id)
        const playlist = await musicApi.getPlaylistDetail(id)
        return playlist
      } catch (error) {
        console.error('❌ 加载歌单详情失败:', error)
        return null
      }
    }

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
          console.log('ℹ️ 歌单已存在:', exists.name)
          return
        }
        
        // 确保歌单包含完整的tracks数据
        let fullPlaylist = playlist
        if (!playlist.tracks || playlist.tracks.length === 0) {
          console.log('🔄 歌单缺少tracks数据，从服务器获取完整信息...')
          try {
            const detail = await musicApi.getPlaylistDetail(playlist.id)
            // 详情可能为 null 或缺字段的空壳对象：与原始数据合并，保留原 id/name，杜绝 push(null)
            fullPlaylist = detail ? { ...playlist, ...detail } : playlist
            console.log('✅ 获取完整歌单数据成功，歌曲数量:', fullPlaylist.tracks?.length || 0)
          } catch (error) {
            console.error('❌ 获取完整歌单数据失败，使用原始数据:', error)
            fullPlaylist = playlist
          }
        }
        
        // await 期间同一歌单可能已被并行添加，push 前再查一次重（与 loadDefaultPlaylists 一致）
        if (userPlaylists.value.some(p => String(p.id) === String(playlist.id))) {
          console.log('ℹ️ 歌单已存在:', fullPlaylist.name)
          return
        }

        userPlaylists.value.push(fullPlaylist)
        savePlaylistsToStorage()
        console.log('✅ 歌单已添加:', fullPlaylist.name)
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

        savePlaylistsToStorage()
        console.log('✅ 歌单已移除:', playlist.name)

        // 如果移除的是当前选中的歌单，清空选择
        if (String(selectedPlaylist.value?.id) === String(playlistId)) {
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

    // 本地存储操作（全部带异常防护，脏数据不再阻断初始化）
    const readJSON = (key, fallback = null) => {
      try {
        const raw = localStorage.getItem(key)
        return raw === null ? fallback : JSON.parse(raw)
      } catch (e) {
        console.warn(`localStorage 读取 ${key} 失败，已重置:`, e.message)
        return fallback
      }
    }

    const writeJSON = (key, value) => {
      try {
        localStorage.setItem(key, JSON.stringify(value))
      } catch (e) {
        console.warn(`localStorage 写入 ${key} 失败:`, e.message)
      }
    }

    const getRemovedDefaultPlaylists = () => {
      const removed = readJSON(REMOVED_DEFAULT_PLAYLISTS_KEY, [])
      return Array.isArray(removed) ? removed.map(String) : []
    }

    const savePlaylistsToStorage = () => {
      // 持久化时剥离大体积 tracks（selectedPlaylist 切回时会重新拉取详情），
      // 本地内存态歌单（单曲分享/队列存盘）无法从接口重拉，tracks 必须保留
      const toStore = userPlaylists.value.map(p => {
        if (isLocalPlaylistId(p.id)) return p
        const { tracks, ...rest } = p
        return { ...rest, trackCount: rest.trackCount ?? (Array.isArray(tracks) ? tracks.length : 0) }
      })
      writeJSON(PLAYLISTS_STORAGE_KEY, toStore)
    }

    const loadPlaylistsFromStorage = () => {
      const savedPlaylists = readJSON(PLAYLISTS_STORAGE_KEY)
      if (Array.isArray(savedPlaylists)) {
        // 过滤 null/无 id 的脏条目，避免后续 String(p.id) 访问抛异常
        const validPlaylists = savedPlaylists.filter(p => p && p.id != null)
        userPlaylists.value.push(...validPlaylists)
        console.log('✅ 从本地存储加载歌单:', validPlaylists.length, '个')
      }
    }

    const savePlayerStateToStorage = () => {
      const state = {
        selectedPlaylistId: selectedPlaylist.value?.id ?? null,
        // 播放队列归属歌单：播 A 浏览 B 时刷新恢复应回到 A，
        // 存浏览态 id 会让恢复在 B 里找不到这首歌而静默放弃
        playingPlaylistId: playingPlaylistId.value ?? selectedPlaylist.value?.id ?? null,
        currentSongId: currentSong.value?.id ?? null,
        currentTime: Number.isFinite(currentTime.value) ? currentTime.value : 0,
        volume: Number.isFinite(volume.value) ? volume.value : 80,
        playMode: playMode.value,
        shuffleOn: shuffleOn.value,
        showVipSongs: showVipSongs.value,
        autoplayOn: autoplayOn.value,
        isFullscreenPlayerOpen: isFullscreenPlayerOpen.value,
        fullscreenLyricMode: fullscreenLyricMode.value,
        fullscreenInteractionMode: fullscreenInteractionMode.value
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
      if (Number.isFinite(savedState.volume)) volume.value = Math.max(0, Math.min(100, savedState.volume))
      if (typeof savedState.playMode === 'string') playMode.value = savedState.playMode
      if (typeof savedState.shuffleOn === 'boolean') shuffleOn.value = savedState.shuffleOn
      if (typeof savedState.showVipSongs === 'boolean') showVipSongs.value = savedState.showVipSongs
      if (typeof savedState.autoplayOn === 'boolean') autoplayOn.value = savedState.autoplayOn
      if (typeof savedState.fullscreenLyricMode === 'string') fullscreenLyricMode.value = savedState.fullscreenLyricMode
      if (typeof savedState.fullscreenInteractionMode === 'string') fullscreenInteractionMode.value = savedState.fullscreenInteractionMode
    }

    const restorePlaybackState = async (savedState) => {
      // 优先按播放队列所属歌单恢复（播 A 浏览 B 的场景），兼容旧存档回落浏览态
      const targetPlaylistId = savedState?.playingPlaylistId ?? savedState?.selectedPlaylistId
      if (!targetPlaylistId || !savedState?.currentSongId) return

      const playlist = userPlaylists.value.find(p => String(p.id) === String(targetPlaylistId))
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

      await playSong(restoredSong, {
        autoplay: false,
        seekTime: Number.isFinite(savedState.currentTime) ? savedState.currentTime : 0
      })

      if (savedState.isFullscreenPlayerOpen) {
        isFullscreenPlayerOpen.value = true
      }
    }

    // 歌单选择（请求序号守卫：快速连点时丢弃过期响应）
    // 返回 true=选择生效且歌曲已就绪，false=被更新的选择抢占/加载失败；供 restorePlaybackState 判断是否继续
    const selectPlaylist = async (playlist) => {
      if (!playlist || playlist.id == null) return false
      if (String(selectedPlaylist.value?.id) === String(playlist.id)) return true

      const myReq = ++selectReqId
      try {
        loadingSongs.value = true
        selectedPlaylist.value = playlist
        currentPage.value = 1 // 重置分页

        console.log('🎵 加载歌单歌曲:', playlist.name)

        // 本地内存态歌单（单曲分享/队列存盘）没有接口数据——直接用内嵌 tracks
        if (isLocalPlaylistId(playlist.id)) {
          songs.value = playlist.tracks || []
          console.log('✅ 临时歌单加载完成，共', songs.value.length, '首')
        } else {
          // 对于正常歌单，从服务器重新获取最新的歌单信息和歌曲数据
          console.log('🔄 从服务器获取最新歌单数据...')
          const fullPlaylist = await musicApi.getPlaylistDetail(playlist.id)
          if (myReq !== selectReqId) return false // 已被更新的选择取代，丢弃过期数据
          songs.value = fullPlaylist?.tracks || []
          console.log('✅ 获取最新歌曲完成，共', songs.value.length, '首')

          // hero 同步详情——否则侧栏种子行（只有 id+name）会让 hero 永久显示占位元数据
          selectedPlaylist.value = { ...playlist, ...(fullPlaylist || {}) }

          // 更新本地歌单库中的数据
          const playlistIndex = userPlaylists.value.findIndex(p => String(p.id) === String(playlist.id))
          if (playlistIndex !== -1) {
            userPlaylists.value[playlistIndex] = { ...userPlaylists.value[playlistIndex], ...fullPlaylist }
            savePlaylistsToStorage()
            console.log('✅ 已更新本地歌单数据')
          }
        }
        return true
      } catch (error) {
        if (myReq !== selectReqId) return false
        console.error('❌ 加载歌曲失败:', error)
        // 复位选中态：否则再次点击同一歌单会被“已选中”提前返回，永远无法重试
        selectedPlaylist.value = null
        songs.value = []
        return false
      } finally {
        // 仅最新请求负责复位 loading；过期请求直接跳过，loading 由新请求收尾
        if (myReq === selectReqId) loadingSongs.value = false
      }
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

    const toggleShuffle = () => {
      shuffleOn.value = !shuffleOn.value
      // 空队列开随机不能把当前曲塞进队列变成"只有一首"——next 会误判队列耗尽停播
      if (!playingSongs.value.length) {
        queueOriginalOrder = null
        savePlayerStateToStorage()
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
      }
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

    // 「播放全部/随机」hero 按钮：队首（或随机锚点）起播，快照当前过滤列表
    const playPlaylist = (shuffle = false) => {
      const list = filteredSongs.value
      if (!list.length) return
      if (shuffle) shuffleOn.value = true
      const anchor = shuffle ? list[Math.floor(Math.random() * list.length)] : list[0]
      playSong(anchor) // 非 preserveContext → playSong 内 setQueue 重拍快照
    }

    // 搜索结果页点歌：队列 = 本次搜索的单曲结果，而非当前浏览歌单
    const playSongFromSearch = (song) => {
      setQueue(searchSongResults.value, shuffleOn.value ? song : null)
      playingPlaylistId.value = null // 队列不归属任何歌单
      playSong(song, { preserveContext: true })
    }

    // 侧栏歌单行悬停 ▶：选歌单（不换主区视图），加载完即播
    const playPlaylistFromSidebar = async (playlist) => {
      const ok = await selectPlaylist(playlist)
      if (!ok) return
      sidebarOpen.value = false
      enterWatch() // 点歌单播放即进入 watch 页（YTM 同款导航）
      playPlaylist(false)
    }

    // 队列抽屉「正在播放：X」来源名——队列无归属（搜索结果/删库歌单）时
    // 不冒用浏览中的歌单名
    const queueTitle = computed(() => {
      const owner = userPlaylists.value.find(p => String(p.id) === String(playingPlaylistId.value))
      if (owner) return owner.name
      return playingPlaylistId.value ? '未知歌单' : '当前队列'
    })

    // 队列归属本地临时歌单（单曲分享/saved_queue_*）——底栏据此禁用随机键
    const playerIsTemp = computed(() => isLocalPlaylistId(playingPlaylistId.value))

    // 播放条 ☰/词 开关 → 打开 watch 页对应 tab（YTM：UP NEXT/歌词都是页内栏位）
    const openWatchPanel = (tab) => {
      if (!currentSong.value) return // 没在播的歌：空 watch 页无意义
      watchTab.value = tab
      if (centerView.value !== 'watch') {
        centerView.value = 'watch'
        pushNavState()
      }
    }

    // 点歌进入 watch 播放页（YTM：任何地方点歌都导航到 /watch）。
    // 调用处紧跟着就是 playSong——不能用 currentSong 做守卫，冷启动点歌时它还是 null
    const enterWatch = () => {
      if (centerView.value !== 'watch') {
        centerView.value = 'watch'
        pushNavState()
      }
    }

    const openWatchSong = (song) => {
      enterWatch()
      playSong(song)
    }

    const openWatchSearchSong = (song) => {
      enterWatch()
      playSongFromSearch(song)
    }

    const playPlaylistAndWatch = (shuffle) => {
      enterWatch()
      playPlaylist(shuffle)
    }

    const watchBack = () => {
      // 当前条目是我们 push 的 → 站内还有上一页可回；否则（分享链冷启动）回首页
      if (window.history.state?.meowsyncNav) window.history.back()
      else {
        centerView.value = 'home'
        // 同步地址栏——否则 UI 在首页而 URL 停在 ?view=watch，刷新又回 watch
        window.history.replaceState(null, '', buildNavUrl())
      }
    }

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
          const toOrig = Math.min(to, queueOriginalOrder.length)
          queueOriginalOrder.splice(toOrig, 0, m)
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
      const pl = {
        id: `saved_queue_${Date.now()}`,
        name: `${queueTitle.value} · 队列`,
        coverImgUrl: first?.al?.picUrl || first?.album?.picUrl || '',
        creator: { nickname: '我的队列' },
        trackCount: playingSongs.value.length,
        tracks: playingSongs.value.slice(),
        isLocal: true
      }
      userPlaylists.value.unshift(pl)
      savePlaylistsToStorage()
      toast(`已存为歌单「${pl.name}」`, 'success')
    }

    // 相关 tab 点歌：单曲独立成队（与搜索结果点歌同构）
    const playSongFromRelated = (song) => {
      setQueue([song], null)
      playingPlaylistId.value = null
      playSong(song, { preserveContext: true })
    }

    // autoplay：自然播完且队列耗尽时，拉当前艺人相关歌接进队列继续播
    const continueWithRelated = async () => {
      const artist = (currentSong.value?.ar || currentSong.value?.artists || [])[0]?.name
      if (!artist) return false
      try {
        const list = await musicApi.searchSongs(artist, 15)
        const exist = new Set(playingSongs.value.map(s => String(s.id)))
        const fresh = (list || []).filter(s => s?.id != null && !exist.has(String(s.id)))
        if (!fresh.length) return false
        playingSongs.value = [...playingSongs.value, ...fresh]
        playSong(fresh[0], { preserveContext: true })
        return true
      } catch {
        return false
      }
    }

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

    // 首页发现流：三路独立加载互不阻塞，单路失败只空自己那格；
    // 货架渐进渲染（HomeFeed 按数组到达上架），loading 只负责「全空态」的转圈。
    // 8s 软上限：上游挂起时不让用户盯满 15s axios 超时——先到点落失败态，
    // 晚到的数据经响应式照常补位替换失败文案
    let homeLoaded = false
    const loadHomeFeed = () => {
      if (homeLoaded) return
      homeLoaded = true
      homeLoading.value = true
      const settled = Promise.allSettled([
        musicApi.getToplists().then(list => { homeToplists.value = list.slice(0, 12) }),
        musicApi.getPersonalized(12).then(list => { homePersonalized.value = list }),
        musicApi.getSearchHot().then(list => { homeHots.value = list.slice(0, 12) })
      ])
      settled.then(results => {
        // allSettled 吞掉每路报错——留个脚印，否则全挂时控制台静默
        results.forEach(r => {
          if (r.status === 'rejected') console.warn('[home]', r.reason?.message || r.reason)
        })
        // 三路全空（全失败/全空数组）解开一次性闩锁——回到首页或网络恢复时可重试
        if (!homeToplists.value.length && !homePersonalized.value.length && !homeHots.value.length) {
          homeLoaded = false
        }
      })
      Promise.race([settled, new Promise(resolve => setTimeout(resolve, 8000))])
        .finally(() => { homeLoading.value = false })
    }
    // 回到首页即重试（上一趟有货则闩锁短路零成本）；断网恢复同理
    watch(centerView, v => { if (v === 'home') loadHomeFeed() })
    window.addEventListener('online', loadHomeFeed)

    // 歌曲播放逻辑
    // 注意竞态防护：controller/howl 均使用局部引用，所有回调只操作自己的实例，
    // 每个 await 之后都必须重新检查 abortSignal.aborted / currentPlayingId。
    // preserveContext=true 表示本次切歌属于播放队列内导航（上一首/下一首/远端点歌），
    // 沿用已有快照；默认则从当前浏览列表拍新快照。
    const playSong = async (song, options = {}) => {
      if (!song || song.id == null) return
      const { autoplay = true, seekTime = 0, preserveContext = false } = options

      console.log('🎵 播放歌曲:', song.name)

      // 设置当前播放的歌曲ID，用于防止竞态条件
      currentPlayingId = song.id

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

        // 播即收藏：打开搜索结果歌单（不入库）后若真在播放，说明用户认可它——
        // 静默入库，否则刷新恢复会找不到该歌单（restorePlaybackState 只查库），
        // 播放位置随 selectedPlaylistId 一起蒸发
        if (
          selectedPlaylist.value &&
          !userPlaylists.value.some(p => String(p.id) === String(selectedPlaylist.value.id))
        ) {
          userPlaylists.value.push(selectedPlaylist.value)
          savePlaylistsToStorage()
        }

        // 立即停止当前播放，防止多首歌同时播放
        if (howl) {
          howl.stop()
          howl.unload()
          howl = null
        }
        clearHowlWatchdog()

        // 清除歌词定时器
        if (lyricTimer) {
          clearInterval(lyricTimer)
          lyricTimer = null
        }
        // 重置歌词加载态：上一次被 abort 的 loadLyrics 不会进 finally 复位，
        // 若本次请求随后提前返回（如无URL），loadingLyrics 会一直卡 true
        loadingLyrics.value = false

        // 立即设置播放状态为false
        isPlaying.value = false
        currentTime.value = 0
        duration.value = 0

        currentSong.value = song

        // 获取歌曲播放URL
        const songUrlData = await musicApi.getSongUrl(song.id, abortSignal)

        // 检查请求是否被取消
        if (abortSignal.aborted) {
          console.log('🚫 歌曲加载被取消:', song.name)
          return
        }

        if (!songUrlData || !songUrlData.url) {
          console.error('❌ 无法获取歌曲播放链接')
          songSwitching.value = false
          playbackError.value = '无法获取播放链接（所有音源均未命中），请稍后重试或换一首'
          if (currentAbortController === myController) currentAbortController = null
          return
        }

        // 判断本次加载是否已失效（被取消或已被更新的播放请求取代）
        const isStale = () => abortSignal.aborted || currentPlayingId !== song.id || howl !== newHowl

        // 创建Howler实例；回调一律操作局部 newHowl，绝不间接引用共享变量 howl，
        // 否则过期回调会误销毁后来创建的实例
        const newHowl = new Howl({
          src: [songUrlData.url],
          format: ['mp4', 'mp3', 'flac'],
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

            if (Math.abs(expectedDuration - actualDuration) > 5) {
              durationWarning.value = `VIP 歌曲试听版本：预期 ${formatTime(expectedDuration)}，实际 ${formatTime(actualDuration)}`
            }

            songSwitching.value = false

            // -0.5s 缓冲：恢复的进度若恰好在末尾（上次播完时持久化的 currentTime≈duration），
            // seek 到精确结尾会立刻触发 'end' 又跳下一首，回退半秒让用户能从结尾续播
            const safeSeekTime = Math.max(0, Math.min(seekTime || 0, (duration.value || 0) - 0.5))
            if (safeSeekTime > 0) {
              newHowl.seek(safeSeekTime)
              currentTime.value = safeSeekTime
            }

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
            startProgressLoop()
          },
          onpause: () => {
            if (isStale()) return
            isPlaying.value = false
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
          // 这不是挂死。保留实例+松开切换锁，用户点播放键即可完成手势加载。
          // 注意绝不能 abort myController：signal.aborted 会让后续 onload 被判
          // 过期而销毁实例，手势白等
          if (navigator.userActivation && !navigator.userActivation.hasBeenActive) {
            console.log('⏸️ 等待用户手势后再加载音频（移动端自动播放限制）')
            songSwitching.value = false
            isPlaying.value = false
            playbackError.value = '点击播放键开始播放'
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
        await loadLyrics(song.id, abortSignal)

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
        // 清掉上一首歌的残留歌词，避免在新歌标题下渲染旧歌词
        lyrics.value = []
        currentLyricIndex.value = 0
        if (currentAbortController === myController) currentAbortController = null
        savePlayerStateToStorage()
      }
    }

    // 歌词加载和同步（支持取消 + 过期响应不落盘，防止旧歌歌词覆盖新歌）
    const loadLyrics = async (songId, signal = null) => {
      try {
        loadingLyrics.value = true
        console.log('📝 加载歌词:', songId)

        const lyricsData = await musicApi.getLyrics(songId, signal)
        // 切歌/取消后直接丢弃，不写回共享状态
        if (signal?.aborted || currentPlayingId !== songId) return

        lyrics.value = lyricsData?.lyrics || []
        currentLyricIndex.value = 0

        console.log('✅ 歌词加载完成，共', lyrics.value.length, '行')

        // 开始歌词同步
        if (lyrics.value.length > 0) {
          startLyricSync()
        }
      } catch (error) {
        if (signal?.aborted || error.name === 'AbortError' || error.code === 'ERR_CANCELED') return
        console.error('❌ 加载歌词失败:', error)
        if (currentPlayingId === songId) lyrics.value = []
      } finally {
        if (!signal?.aborted && currentPlayingId === songId) {
          loadingLyrics.value = false
        }
      }
    }

    const startLyricSync = () => {
      if (lyricTimer) {
        clearInterval(lyricTimer)
      }

      lyricTimer = setInterval(() => {
        if (!howl || !isPlaying.value || lyrics.value.length === 0) return

        const currentTimeSeconds = howl.seek()

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
            seekTime: currentTime.value
          })
        }
        return
      }

      // 检查当前Howler实例是否对应当前歌曲
      if (currentSong.value && currentPlayingId !== currentSong.value.id) {
        console.log('🚫 播放控制被忽略，当前Howler实例不匹配当前歌曲')
        return
      }

      if (isPlaying.value) {
        howl.pause()
      } else {
        howl.play()
      }
    }

    // 以歌曲ID在播放快照中实时定位，避免 VIP 过滤/浏览切单导致索引漂移
    const currentPlayingIndex = () => {
      if (!currentSong.value) return -1
      // 与 playSong 一致用 String 比较：不同接口返回的 id 可能是 number 或 string
      return playbackList().findIndex(s => String(s.id) === String(currentSong.value.id))
    }

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
          // 手动点「下一首」但已在队尾（list 模式）：静默无效——该键不该变成"停止"键
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
      isFullscreenPlayerOpen.value = true // 由 watch 统一持久化
    }

    const closeFullscreenPlayer = () => {
      isFullscreenPlayerOpen.value = false
    }

    watch(currentTime, () => {
      savePlaybackTimeIfNeeded()
    })

    watch(autoplayOn, () => savePlayerStateToStorage())
    // 播放错误是行内 banner（不经 toast）——补进 glitch 张力表盘，
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
        const pic = song.al?.picUrl || song.album?.picUrl || ''
        try {
          navigator.mediaSession.metadata = new MediaMetadata({
            title: song.name || '',
            artist: artists,
            album: song.al?.name || song.album?.name || '',
            artwork: pic ? [{ src: httpsCover(pic), sizes: '512x512' }] : []
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
    // 切回前台/离开前补一次强制落盘
    const onVisibilityFlush = () => {
      if (document.visibilityState === 'hidden') savePlaybackTimeIfNeeded(true)
    }
    document.addEventListener('visibilitychange', onVisibilityFlush)

    // 键盘快捷键（YTM 式）：空格播放暂停、←→ 进退、↑↓ 音量、M 静音、
    // F 全屏、Q 待播队列、/ 聚焦搜索；输入态/修饰键组合全部放行
    const onGlobalKeydown = (e) => {
      // 确认框未决时全局快捷键全部冻结（/ 偷焦点会破焦点陷阱，F 会在遮罩下隐形切全屏）
      if (isConfirmOpen()) {
        if (e.key === 'Escape') resolveConfirm(false) // 兜底：焦点逃出 overlay 时仍能关
        return
      }
      if (e.key === 'Escape') {
        if (sidebarOpen.value) sidebarOpen.value = false
        return
      }
      const el = e.target
      if (e.defaultPrevented) return // 组件已处理（如 role=button 行的 space.prevent）
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return
      if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return
      switch (e.key) {
        case ' ':
          // 焦点在原生按钮/role=button/链接上时空格属于它自己的激活语义，不抢
          if (el?.tagName === 'BUTTON' || el?.closest?.('[role="button"], [role="tab"], [role="menuitem"], [role="option"], a[href]')) return
          e.preventDefault() // 阻止页面滚动
          togglePlay()
          break
        case 'ArrowLeft':
          seekBy(-5)
          break
        case 'ArrowRight':
          seekBy(5)
          break
        case 'ArrowUp':
          e.preventDefault()
          updateVolume(volume.value + 5)
          break
        case 'ArrowDown':
          e.preventDefault()
          updateVolume(volume.value - 5)
          break
        case 'm': case 'M':
          toggleMute()
          break
        case 'f': case 'F':
          if (currentSong.value) isFullscreenPlayerOpen.value = !isFullscreenPlayerOpen.value
          break
        case 'q': case 'Q':
          if (currentSong.value) openWatchPanel('queue')
          break
        case '/':
          e.preventDefault()
          topNavRef.value?.focusSearch()
          break
      }
    }
    window.addEventListener('keydown', onGlobalKeydown)

    // ←→ 键盘进退：直接作用 howl（等价于拖进度条），5s 步长对齐 YTM
    const seekBy = (delta) => {
      if (!howl || !Number.isFinite(duration.value) || duration.value <= 0) return
      const t = Math.max(0, Math.min((howl.seek() ?? 0) + delta, duration.value))
      howl.seek(t)
      currentTime.value = t
      savePlaybackTimeIfNeeded(true)
    }

    watch([
      showVipSongs,
      isFullscreenPlayerOpen,
      fullscreenLyricMode,
      fullscreenInteractionMode
    ], () => {
      savePlayerStateToStorage()
    })

    // 监听VIP歌曲显示状态变化，重置分页
    watch(showVipSongs, () => {
      currentPage.value = 1
    })

    // host 模式：状态变化时立即推送
    watch([isPlaying, currentSong, volume], () => {
      if (remoteMode.value === 'host') sendRemoteState()
    })

    // 队列快照变更（shuffle/增删/换单）也要即时推送——2s 轮询兜底但点歌不该等
    watch(playingSongs, () => {
      if (remoteMode.value === 'host') sendRemoteState()
    })

    // 从URL参数获取歌单ID列表
    const getPlaylistIdsFromUrl = () => {
      const urlParams = new URLSearchParams(window.location.search)
      const playlistParam = urlParams.get('playlists') || urlParams.get('playlist')
      
      if (!playlistParam) {
        // 如果没有URL参数，返回空数组
        return []
      }
      
      // 支持多种格式：
      // ?playlist=123456 (单个歌单)
      // ?playlists=123456,789012 (多个歌单，逗号分隔)
      // ?playlists=123456|789012 (多个歌单，竖线分隔)
      const ids = playlistParam.split(/[,|]/).map(id => id.trim()).filter(id => /^\d+$/.test(id))
      
      console.log('🔗 从URL获取歌单ID:', ids)
      return ids
    }

    // 从URL参数获取单首歌曲ID
    const getSongIdFromUrl = () => {
      const urlParams = new URLSearchParams(window.location.search)
      const songParam = urlParams.get('song')
      
      if (!songParam || !/^\d+$/.test(songParam.trim())) {
        return null
      }
      
      console.log('🎵 从URL获取歌曲ID:', songParam.trim())
      return songParam.trim()
    }


    // 消费掉一次性 URL 参数：不清理的话每次刷新都会重新劫持恢复逻辑
    // （?song= 会永久抢占 restorePlaybackState；?playlists= 会重复尝试导入）
    const consumeUrlShareParams = () => {
      const url = new URL(window.location.href)
      let changed = false
      for (const key of ['song', 'playlist', 'playlists']) {
        if (url.searchParams.has(key)) {
          url.searchParams.delete(key)
          changed = true
        }
      }
      if (changed) window.history.replaceState(null, '', url.toString())
    }

    // URL歌单加载
    const loadDefaultPlaylists = async () => {
      try {
        console.log('🎵 检查是否需要加载URL歌单...')

        // 获取URL参数中的歌单ID
        const urlPlaylistIds = getPlaylistIdsFromUrl()

        // 如果没有URL参数，跳过加载
        if (urlPlaylistIds.length === 0) {
          console.log('✅ 无URL歌单参数，跳过加载')
          return
        }

        console.log('🔗 检测到URL歌单参数，加载指定歌单:', urlPlaylistIds)
        const defaultPlaylistIds = urlPlaylistIds
        
        const removedIds = getRemovedDefaultPlaylists()
        
        // 过滤掉已移除的歌单ID和已存在的歌单ID；URL 内重复ID先去重，避免并行加载后重复push
        const validIds = [...new Set(defaultPlaylistIds)].filter(id => {
          if (removedIds.includes(id)) {
            console.log('⏭️ 跳过已移除的默认歌单:', id)
            return false
          }
          
          // 检查是否已存在相同ID的歌单（确保ID类型一致）
          const exists = userPlaylists.value.find(p => String(p.id) === String(id))
          if (exists) {
            console.log('⏭️ 跳过已存在的歌单:', id, exists.name)
            return false
          }
          
          return true
        })
        
        if (validIds.length === 0) {
          console.log('✅ 所有默认歌单都已被用户删除，跳过加载')
          return
        }
        
        console.log('🌐 加载歌单:', validIds)
        
        // 并行加载所有歌单
        const playlistPromises = validIds.map(async (id) => {
          try {
            const playlist = await loadPlaylistById(id)
            if (playlist) {
              playlist.isDefault = true
              console.log('✅ 默认歌单加载成功:', playlist.name)
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

        console.log('✅ URL歌单加载完成')
      } catch (error) {
        console.error('❌ 加载URL歌单失败:', error)
      }
    }

    // 顶栏「管理」键：在 下载管理 ⇄ 上一视图 之间往返；搜索态点它应进下载管理
    const toggleCenterView = () => {
      centerView.value = centerView.value === 'downloads'
        ? (selectedPlaylist.value ? 'songs' : 'home')
        : 'downloads'
      pushNavState()
    }

    // 浏览器前进/后退：按 URL 回放视图（不重入栈）
    const onPopState = () => {
      suppressNavPush = true
      try { applyUrlNav() } finally { suppressNavPush = false }
    }
    window.addEventListener('popstate', onPopState)

    // 组件挂载
    onMounted(async () => {
      console.log('🚀 App组件挂载完成')

      // 遥控器模式：不初始化播放器/歌单/播放状态恢复，纯控制端
      if (remoteMode.value === 'controller') {
        console.log('📱 遥控器模式，跳过播放器初始化')
        return
      }

      setupMediaSessionHandlers()

      // 启动远程控制 host 连接
      if (remoteMode.value === 'host') {
        connectRemoteHost()
      }

      // 单曲分享：侧栏抽屉默认收起，主区直接呈现歌曲——无需额外处理

      // 加载保存的歌单
      loadPlaylistsFromStorage()
      restorePlayerState = loadPlayerStateFromStorage()
      restoreUiState(restorePlayerState)

      // 首页发现流（后台加载，不阻塞首屏）——必须早于下面的恢复 await：
      // 否则 restorePlaybackState/分享链路动辄数十秒期间 HomeFeed 已挂载而
      // loading=false，空态会先把「加载失败」闪上屏
      loadHomeFeed()

      // 加载默认歌单
      await loadDefaultPlaylists()
      
      // 如果有单首歌曲ID，尝试加载并播放
      const songId = getSongIdFromUrl()
      // 所有参数读取已完毕——消费掉，避免下次刷新重新劫持恢复逻辑
      consumeUrlShareParams()
      if (songId) {
        console.log('🎵 检测到单首歌曲分享，歌曲ID:', songId)
        try {
          // 检查是否已经存在相同的临时歌单
          const tempPlaylistId = `single_song_${songId}`
          let existingPlaylist = userPlaylists.value.find(p => p.id === tempPlaylistId)

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
            const tempIndexes = userPlaylists.value
              .map((p, i) => String(p.id).startsWith('single_song_') ? i : -1)
              .filter(i => i !== -1)
            // 倒序删除：升序 splice 会让后续下标前移错位
            for (const i of tempIndexes.slice(10).reverse()) {
              userPlaylists.value.splice(i, 1)
            }
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
      } else if (restorePlayerState) {
        await restorePlaybackState(restorePlayerState)
      }

      // 恢复路径失败（歌单被删/网络抖动）时不落盘：否则会拿全空状态覆盖掉
      // 存档里仍可用的续播点。无恢复存档时正常写入初始态
      if (!restorePlayerState || currentSong.value) {
        savePlayerStateToStorage()
      }

      // URL 导航意图最后生效：view/pl 参数压在恢复逻辑之上（用户显式给的地址优先）
      applyUrlNav()
      // 规范化当前历史条目：回退到首个条目时不会退出应用。
      // 与 pushNavState 共用 buildNavUrl——pl 也要同步（applyUrlNav 兜底
      // 后 URL 里可能留着失效 pl，或 view=songs 缺 pl）
      suppressNavPush = true
      try {
        window.history.replaceState(null, '', buildNavUrl().toString())
      } finally { suppressNavPush = false }

      console.log('✅ 初始化完成，用户歌单数量:', userPlaylists.value.length)
    })

    // 组件卸载：清理 WS/定时器/rAF/音频，避免泄漏与卸载后重连
    onBeforeUnmount(() => {
      window.removeEventListener('online', loadHomeFeed)
      remoteReconnectTimer && clearTimeout(remoteReconnectTimer)
      remoteReconnectTimer = null
      // onclose 被置 null 后不会再清 remoteStateTimer，这里必须手动清，否则 interval 泄漏
      remoteStateTimer && clearInterval(remoteStateTimer)
      remoteStateTimer = null
      if (remoteWs) {
        remoteWs.onclose = null
        remoteWs.close()
        remoteWs = null
      }
      if (currentAbortController) {
        currentAbortController.abort()
        currentAbortController = null
      }
      if (progressRafId !== null) {
        cancelAnimationFrame(progressRafId)
        progressRafId = null
      }
      if (lyricTimer) {
        clearInterval(lyricTimer)
        lyricTimer = null
      }
      clearHowlWatchdog()
      clearTimeout(volumeSaveTimer)
      document.removeEventListener('visibilitychange', onVisibilityFlush)
      window.removeEventListener('keydown', onGlobalKeydown)
      window.removeEventListener('popstate', onPopState)
      teardownMediaSession()
      if (howl) {
        howl.stop()
        howl.unload()
        howl = null
      }
    })

    return {
      // 响应式数据
      remoteMode,
      remoteControllerWsUrl,
      remoteWsProtocols,
      searchQuery,
      loading,
      loadingSongs,
      searchResults,
      userPlaylists,
      selectedPlaylist,
      songs,
      currentSong,
      showVipSongs,
      lyrics,
      currentLyricIndex,
      songSwitching,
      isPlaying,
      currentTime,
      duration,
      volume,
      isFullscreenPlayerOpen,
      fullscreenLyricMode,
      fullscreenInteractionMode,
      durationWarning,
      playbackError,
      loadingLyrics,
      currentPage,
      pageSize,
      centerView,
      sidebarOpen,
      watchTab,
      autoplayOn,
      searching,
      searchSongResults,
      playlistDownloadsRefreshKey,
      shuffleOn,
      playMode,
      playingSongs,
      queueTitle,
      topNavRef,
      homeToplists,
      homePersonalized,
      homeHots,
      homeLoading,

      // 方法
      goToPage,
      prevPage,
      nextPage,
      loadPlaylistByIdAndAdd,
      loadPlaylistById,
      addPlaylistToLibrary,
      removePlaylistFromLibrary,
      handlePlaylistDownloadsDeleted,
      selectPlaylist,
      selectPlaylistAndShow,
      openSearchPlaylist,
      closeSearchView,
      navHome,
      handlePlaylistSearch,
      playSong,
      playPlaylist,
      playPlaylistFromSidebar,
      playSongFromSearch,
      playNextInQueue,
      addToQueueEnd,
      queueJump,
      queueRemove,
      queueMove,
      clearQueue,
      saveQueueAsPlaylist,
      openWatchPanel,
      enterWatch,
      openWatchSong,
      openWatchSearchSong,
      playPlaylistAndWatch,
      watchBack,
      playSongFromRelated,
      toggleShuffle,
      toggleMute,
      togglePlay,
      previousSong,
      nextSong,
      togglePlayMode,
      getPlayModeText,
      currentPlayingIndex,
      playerIsTemp,
      seekTo,
      updateVolume,
      openFullscreenPlayer,
      closeFullscreenPlayer,
      toggleCenterView
    }
  }
}
</script>
<template>
  <!-- 手机控制器模式 -->
  <RemoteController v-if="remoteMode === 'controller'" :ws-url="remoteControllerWsUrl" :ws-protocols="remoteWsProtocols" />

  <!-- YTM 式应用壳：细顶栏 / 左库侧栏+全宽主区 / 底部播放条；歌词为按需右侧抽屉 -->
  <div v-else class="app-shell">
    <!-- 顶部导航（含歌单搜索） -->
    <TopNavigation
      :is-downloads-view="centerView === 'downloads'"
      v-model:search-query="searchQuery"
      :sidebar-open="sidebarOpen"
      @toggle-center-view="toggleCenterView"
      @toggle-sidebar="sidebarOpen = !sidebarOpen"
      @search="handlePlaylistSearch"
      @search-by-id="loadPlaylistByIdAndAdd"
    />

    <div class="app-body">
      <!-- 移动端侧栏抽屉遮罩 -->
      <div v-if="sidebarOpen" class="sidebar-scrim lg:hidden" @click="sidebarOpen = false"></div>

      <!-- 左侧：歌单库（桌面常驻 / 移动端抽屉） -->
      <aside class="app-sidebar" :class="{ 'app-sidebar--open': sidebarOpen }">
        <PlaylistPanel
          :loading="loading"
          :selected-playlist="selectedPlaylist"
          :user-playlists="userPlaylists"
          :current-page="playlistCurrentPage"
          :page-size="playlistPageSize"
          @select-playlist="selectPlaylistAndShow"
          @remove-playlist="removePlaylistFromLibrary"
          @playlist-downloads-deleted="handlePlaylistDownloadsDeleted"
          @go-to-page="goToPlaylistPage"
          @prev-page="prevPlaylistPage"
          @next-page="nextPlaylistPage"
        />
      </aside>

      <!-- 主区：歌曲列表 / 搜索结果 / 下载管理 -->
      <main class="app-main">
        <SongList
          v-if="centerView === 'songs'"
          :songs="songs"
          :loading-songs="loadingSongs"
          :current-song="currentSong"
          :is-playing="isPlaying"
          :show-vip-songs="showVipSongs"
          :play-mode-text="getPlayModeText()"
          :current-page="currentPage"
          :page-size="pageSize"
          :selected-playlist="selectedPlaylist"
          :playlist-downloads-refresh-key="playlistDownloadsRefreshKey"
          @play-song="playSong"
          @toggle-play-mode="togglePlayMode"
          @toggle-vip-songs="showVipSongs = !showVipSongs"
          @go-to-page="goToPage"
          @prev-page="prevPage"
          @next-page="nextPage"
        />
        <PlaylistGrid
          v-else-if="centerView === 'search'"
          :results="searchResults"
          :user-playlists="userPlaylists"
          :loading="searching"
          @open="openSearchPlaylist"
          @add="addPlaylistToLibrary"
          @close="centerView = 'songs'"
        />
        <AdminPanel v-else />
      </main>
    </div>

    <!-- 底部播放器（文档流内嵌） -->
    <BottomPlayer
      v-if="currentSong && !isFullscreenPlayerOpen"
      :current-song="currentSong"
      :is-playing="isPlaying"
      :current-time="currentTime"
      :duration="duration"
      :volume="volume"
      :song-switching="songSwitching"
      :lyrics-open="lyricsDrawerOpen"
      @toggle-play="togglePlay"
      @previous-song="previousSong"
      @next-song="nextSong"
      @seek-to="seekTo"
      @update-volume="updateVolume"
      @open-fullscreen="openFullscreenPlayer"
      @toggle-lyrics="lyricsDrawerOpen = !lyricsDrawerOpen"
    />

    <!-- 歌词抽屉（右侧浮层，不占常驻栏位） -->
    <LyricsPanel
      :open="lyricsDrawerOpen"
      :current-song="currentSong"
      :lyrics="lyrics"
      :current-lyric-index="currentLyricIndex"
      :auto-follow-lyrics="autoFollowLyrics"
      :loading-lyrics="loadingLyrics"
      :song-switching="songSwitching"
      :duration-warning="durationWarning"
      :playback-error="playbackError"
      @toggle-auto-follow-lyrics="toggleAutoFollowLyrics"
      @close="lyricsDrawerOpen = false"
    />

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
import { isVipSong } from './lib/song'
import { httpsCover } from './lib/url'
import TopNavigation from './components/TopNavigation.vue'
import PlaylistPanel from './components/PlaylistPanel.vue'
import PlaylistGrid from './components/PlaylistGrid.vue'
import SongList from './components/SongList.vue'
import LyricsPanel from './components/LyricsPanel.vue'
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
    SongList,
    LyricsPanel,
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
    const lyrics = ref([])
    const currentLyricIndex = ref(0)
    const autoFollowLyrics = ref(true) // 歌词自动跟随，默认开启
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

    // 分页相关数据
    const currentPage = ref(1)
    const pageSize = ref(10)
    
    // 歌单分页相关数据
    const playlistCurrentPage = ref(1)
    const playlistPageSize = ref(10)
    
    // YTM 式布局状态：主区视图（歌曲/搜索结果/下载管理）+ 两个按需抽屉
    const centerView = ref('songs') // 'songs' | 'search' | 'downloads'
    const sidebarOpen = ref(false) // 移动端歌单库抽屉
    const lyricsDrawerOpen = ref(false) // 右侧歌词抽屉（播放条「词」键呼出）
    const searching = ref(false) // 仅驱动搜索结果网格的加载态（勿与歌单库 loading 混用）
    const playlistDownloadsRefreshKey = ref(0)
    
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
    const remoteMode = ref(['host', 'controller'].includes(rawMode) ? rawMode : 'off') // 'off' | 'host' | 'controller'

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
          volume: volume.value
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
          alert('远程控制已被另一设备接管，本端已退出主机模式（刷新页面可重新接管）')
          return
        }
        // 该 socket 已被更新的连接取代，不重连（新连接自己负责）
        if (remoteWs && remoteWs !== ws) return
        // 断线重连有上限：握手即被拒（token/Origin 不通过）时避免无限重试
        remoteRetries++
        if (remoteRetries > 5) {
          // 与 4000 顶替路径对称：遥控静默失效会让用户误以为还在生效
          console.warn('[remote] host 重连次数超限，停止重连（请检查 REMOTE_TOKEN/服务状态）')
          alert('远程控制连接多次失败，已停止重连（刷新页面可重试）')
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
    watch(() => userPlaylists.value.length, () => {
      const max = Math.max(1, playlistMaxPages())
      if (playlistCurrentPage.value > max) playlistCurrentPage.value = max
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

    // 歌单分页控制函数
    // 侧栏分页只管"我的歌单"库（搜索结果在主区网格全量渲染）
    const playlistMaxPages = () => Math.ceil(userPlaylists.value.length / playlistPageSize.value)

    const goToPlaylistPage = (page) => {
      if (page >= 1 && page <= playlistMaxPages()) {
        playlistCurrentPage.value = page
      }
    }

    const prevPlaylistPage = () => {
      if (playlistCurrentPage.value > 1) {
        playlistCurrentPage.value--
      }
    }

    const nextPlaylistPage = () => {
      if (playlistCurrentPage.value < playlistMaxPages()) {
        playlistCurrentPage.value++
      }
    }

    // 顶栏搜索：搜歌单 → 主区切换为结果网格；ID/URL 走 search-by-id 直接入库
    const handlePlaylistSearch = async (query) => {
      centerView.value = 'search'
      await searchPlaylists(query)
    }

    // 点搜索结果卡片 = 打开歌单（不入库）；「+ 收藏」才进侧栏库
    const openSearchPlaylist = async (playlist) => {
      centerView.value = 'songs'
      await selectPlaylist(playlist)
    }

    // 侧栏选歌单：回歌曲视图 + 移动端收起抽屉
    const selectPlaylistAndShow = async (playlist) => {
      centerView.value = 'songs'
      sidebarOpen.value = false
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

    // 与 selectReqId 同款序号守卫：快速连搜时丢弃过期响应，
    // 防止慢响应覆盖新查询的结果
    const searchPlaylists = async (query) => {
      const myReq = ++searchReqId
      try {
        searching.value = true
        console.log('🔍 搜索歌单:', query)

        const results = await musicApi.searchPlaylists(query)
        if (myReq !== searchReqId) return
        searchResults.value = results.playlists || []

        console.log('✅ 搜索完成，找到', searchResults.value.length, '个歌单')
      } catch (error) {
        if (myReq !== searchReqId) return
        console.error('❌ 搜索歌单失败:', error)
        searchResults.value = []
      } finally {
        if (myReq === searchReqId) searching.value = false
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

        // 列表缩短后收敛页码
        const maxPages = Math.max(1, Math.ceil(userPlaylists.value.length / playlistPageSize.value))
        if (playlistCurrentPage.value > maxPages) playlistCurrentPage.value = maxPages

        // 如果移除的是当前选中的歌单，清空选择
        if (String(selectedPlaylist.value?.id) === String(playlistId)) {
          selectedPlaylist.value = null
          songs.value = []
        }

        // 若移除的是正在播放的歌单：本会话靠快照续播不受影响，但播放快照的
        // 归属 id 已死——清空它，否则持久化会一直写入无效 playingPlaylistId，
        // 刷新恢复时 userPlaylists.find 落空、续播点永久作废
        if (String(playingPlaylistId.value) === String(playlistId)) {
          playingPlaylistId.value = null
          playingSongs.value = []
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
      // 仅保留单曲分享临时歌单的 tracks 供下次直接复用
      const toStore = userPlaylists.value.map(p => {
        if (String(p.id).startsWith('single_song_')) return p
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
        showVipSongs: showVipSongs.value,
        autoFollowLyrics: autoFollowLyrics.value,
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
      if (typeof savedState.showVipSongs === 'boolean') showVipSongs.value = savedState.showVipSongs
      if (typeof savedState.autoFollowLyrics === 'boolean') autoFollowLyrics.value = savedState.autoFollowLyrics
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

        // 检查是否为临时歌单（单曲分享）
        // 某些歌单ID为数字，直接调用 startsWith 会报错，先转换为字符串
        if (playlist.id && String(playlist.id).startsWith('single_song_')) {
          // 对于临时歌单，直接使用已有的歌曲数据
          songs.value = playlist.tracks || []
          console.log('✅ 临时歌单加载完成，共', songs.value.length, '首')
        } else {
          // 对于正常歌单，从服务器重新获取最新的歌单信息和歌曲数据
          console.log('🔄 从服务器获取最新歌单数据...')
          const fullPlaylist = await musicApi.getPlaylistDetail(playlist.id)
          if (myReq !== selectReqId) return false // 已被更新的选择取代，丢弃过期数据
          songs.value = fullPlaylist?.tracks || []
          console.log('✅ 获取最新歌曲完成，共', songs.value.length, '首')

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
          playingSongs.value = filteredSongs.value.slice()
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

    const nextSong = () => {
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
        } else {
          // 列表播放到末尾：显式停止播放态，否则 isPlaying 残留 true、rAF 空转。
          // 手动点下一首到末尾时音频其实还在响——必须真停 howl，
          // 否则 UI/MediaSession 显示暂停但声音继续（自然播完路径的 stop 无害空转）
          if (howl?.playing()) howl.pause()
          isPlaying.value = false
          currentTime.value = duration.value
          savePlaybackTimeIfNeeded(true)
          return
        }
      }

      const song = list[newIndex]
      if (song) {
        playSong(song, { preserveContext: true })
      }
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
        // 列表播放和列表循环：播放下一首
        nextSong()
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
      savePlaybackTimeIfNeeded(true)
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

    // 歌词自动跟随切换
    const toggleAutoFollowLyrics = () => {
      autoFollowLyrics.value = !autoFollowLyrics.value
      console.log('🎯 歌词自动跟随:', autoFollowLyrics.value ? '开启' : '关闭')
      savePlayerStateToStorage()
    }

    watch(currentTime, () => {
      savePlaybackTimeIfNeeded()
    })

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

    // Esc 关闭两个抽屉（全屏播放器自带 Esc 处理，先一步接管）
    const onGlobalKeydown = (e) => {
      if (e.key !== 'Escape') return
      if (lyricsDrawerOpen.value) lyricsDrawerOpen.value = false
      if (sidebarOpen.value) sidebarOpen.value = false
    }
    window.addEventListener('keydown', onGlobalKeydown)

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

    // 顶栏「管理」键：只在 下载管理 ⇄ 歌曲 之间往返；搜索态点它应进下载管理
    const toggleCenterView = () => {
      centerView.value = centerView.value === 'downloads' ? 'songs' : 'downloads'
    }

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

            // 自动播放
            await playSong(existingPlaylist.tracks[0])
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

            // 自动播放
            await playSong(songDetail)
          }

          console.log('✅ 单首歌曲分享加载完成并开始播放')
        } catch (error) {
          console.error('❌ 加载单首歌曲失败:', error)
        }
      } else if (restorePlayerState) {
        await restorePlaybackState(restorePlayerState)
      }

      // 恢复路径失败（歌单被删/网络抖动）时不落盘：否则会拿全空状态覆盖掉
      // 存档里仍可用的续播点。无恢复存档时正常写入初始态
      if (!restorePlayerState || currentSong.value) {
        savePlayerStateToStorage()
      }

      console.log('✅ 初始化完成，用户歌单数量:', userPlaylists.value.length)
    })

    // 组件卸载：清理 WS/定时器/rAF/音频，避免泄漏与卸载后重连
    onBeforeUnmount(() => {
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
      autoFollowLyrics,
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
      playlistCurrentPage,
      playlistPageSize,
      centerView,
      sidebarOpen,
      lyricsDrawerOpen,
      searching,
      playlistDownloadsRefreshKey,

      // 方法
      goToPage,
      prevPage,
      nextPage,
      goToPlaylistPage,
      prevPlaylistPage,
      nextPlaylistPage,
      loadPlaylistByIdAndAdd,
      loadPlaylistById,
      searchPlaylists,
      addPlaylistToLibrary,
      removePlaylistFromLibrary,
      handlePlaylistDownloadsDeleted,
      selectPlaylist,
      selectPlaylistAndShow,
      openSearchPlaylist,
      handlePlaylistSearch,
      playSong,
      togglePlay,
      previousSong,
      nextSong,
      togglePlayMode,
      getPlayModeText,
      seekTo,
      updateVolume,
      openFullscreenPlayer,
      closeFullscreenPlayer,
      toggleAutoFollowLyrics,
      toggleCenterView
    }
  }
}
</script>
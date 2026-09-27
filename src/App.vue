<template>
  <!-- 手机控制器模式 -->
  <RemoteController v-if="remoteMode === 'controller'" :ws-url="remoteControllerWsUrl" :ws-protocols="remoteWsProtocols" />

  <div v-else id="app" class="min-h-screen lg:h-screen lg:flex lg:flex-col">
    <!-- 顶部导航 -->
    <TopNavigation :is-downloads-view="centerView === 'downloads'" @toggle-center-view="toggleCenterView" />

    <div class="max-w-[1440px] mx-auto w-full px-4 sm:px-6 lg:px-16 pt-6 pb-32 md:pb-32 lg:pt-10 lg:pb-10 desktop-content lg:flex-1 lg:min-h-0">
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <!-- 左侧：歌单列表 -->
        <div v-if="centerView === 'songs'" class="lg:col-span-1">
          <PlaylistPanel
            :active-tab="activeTab"
            v-model:search-query="searchQuery"
            :loading="loading"
            :selected-playlist="selectedPlaylist"
            :user-playlists="userPlaylists"
            :search-results="searchResults"
            :current-page="playlistCurrentPage"
            :page-size="playlistPageSize"
            :collapsed="playlistCollapsed"
            @update:active-tab="activeTab = $event"
            @search="searchPlaylists"
            @search-by-id="loadPlaylistByIdAndAdd"
            @select-playlist="selectPlaylist"
            @add-playlist="addPlaylistToLibrary"
            @remove-playlist="removePlaylistFromLibrary"
            @playlist-downloads-deleted="handlePlaylistDownloadsDeleted"
            @go-to-page="goToPlaylistPage"
            @prev-page="prevPlaylistPage"
            @next-page="nextPlaylistPage"
            @toggle-collapse="togglePlaylistCollapse"
          />
        </div>

        <!-- 中间：歌曲列表 / 下载管理 -->
        <div :class="centerView === 'downloads' ? 'lg:col-span-3 min-h-0' : 'lg:col-span-1'">
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
            :collapsed="songListCollapsed"
            :selected-playlist="selectedPlaylist"
            :playlist-downloads-refresh-key="playlistDownloadsRefreshKey"
            @play-song="playSong"
            @toggle-play-mode="togglePlayMode"
            @toggle-vip-songs="showVipSongs = !showVipSongs"
            @go-to-page="goToPage"
            @prev-page="prevPage"
            @next-page="nextPage"
            @toggle-collapse="toggleSongListCollapse"
          />
          <AdminPanel
            v-else
            :selected-playlist="selectedPlaylist"
          />
        </div>

        <!-- 右侧：歌词面板 -->
        <div v-if="centerView === 'songs'" class="lg:col-span-1">
          <LyricsPanel
            :current-song="currentSong"
            :is-playing="isPlaying"
            :lyrics="lyrics"
            :current-lyric-index="currentLyricIndex"
            :auto-follow-lyrics="autoFollowLyrics"
            :loading-lyrics="loadingLyrics"
            :song-switching="songSwitching"
            :duration-warning="durationWarning"
            :collapsed="lyricsCollapsed"
            @toggle-auto-follow-lyrics="toggleAutoFollowLyrics"
            @toggle-collapse="toggleLyricsCollapse"
          />
        </div>
      </div>

      <!-- 底部播放器 -->
      <BottomPlayer
        v-if="currentSong && !isFullscreenPlayerOpen"
        :current-song="currentSong"
        :is-playing="isPlaying"
        :current-time="currentTime"
        :duration="duration"
        :volume="volume"
        :song-switching="songSwitching"
        @toggle-play="togglePlay"
        @previous-song="previousSong"
        @next-song="nextSong"
        @seek-to="seekTo"
        @update-volume="updateVolume"
        @open-fullscreen="openFullscreenPlayer"
        v-model:player-hidden="playerHidden"
      />
    </div>

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

    <!-- 页脚 -->
    <Footer :style="currentSong && !playerHidden && !isFullscreenPlayerOpen ? { visibility: 'hidden' } : {}" />
  </div>
</template>

<script>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { Howl } from 'howler'
import { musicApi } from './api/music'
import { resolveApiBaseUrl } from './lib/api-base'
import { formatTime } from './lib/format'
import { isVipSong } from './lib/song'
import TopNavigation from './components/TopNavigation.vue'
import PlaylistPanel from './components/PlaylistPanel.vue'
import SongList from './components/SongList.vue'
import LyricsPanel from './components/LyricsPanel.vue'
import BottomPlayer from './components/BottomPlayer.vue'
import FullscreenPlayer from './components/FullscreenPlayer.vue'
import Footer from './components/Footer.vue'
import RemoteController from './components/RemoteController.vue'
import AdminPanel from './components/AdminPanel.vue'

export default {
  name: 'App',
  components: {
    TopNavigation,
    PlaylistPanel,
    SongList,
    LyricsPanel,
    BottomPlayer,
    FullscreenPlayer,
    Footer,
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
    const activeTab = ref('my') // 控制选项卡：'my' 或 'discover'
    const showVipSongs = ref(true) // 控制VIP歌曲显示，默认显示
    const playMode = ref('list') // 播放模式：'list'(列表播放), 'loop'(列表循环), 'single'(单曲循环)
    const lyrics = ref([])
    const currentLyricIndex = ref(0)
    const autoFollowLyrics = ref(true) // 歌词自动跟随，默认开启
    const songSwitching = ref(false) // 歌曲切换提示
    const isPlaying = ref(false)
    const playerHidden = ref(false)
    const isFullscreenPlayerOpen = ref(false)
    const currentTime = ref(0)
    const duration = ref(0)
    const volume = ref(80)
    const durationWarning = ref('')
    const loadingLyrics = ref(false)
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
    
    // 面板折叠状态
    const playlistCollapsed = ref(false)
    const songListCollapsed = ref(false)
    const lyricsCollapsed = ref(false)
    const centerView = ref('songs')
    const playlistDownloadsRefreshKey = ref(0)
    
    let howl = null
    let lyricTimer = null
    let progressRafId = null
    let currentAbortController = null // 用于取消正在进行的网络请求
    let currentPlayingId = null // 当前正在播放的歌曲ID，用于防止竞态条件
    let selectReqId = 0 // selectPlaylist 请求序号，防止慢响应覆盖新选择

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
          if (howl && !isPlaying.value) howl.play()
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
          const targetIndex = filteredSongs.value.findIndex(s => String(s.id) === String(msg.payload))
          if (targetIndex !== -1) playSong(filteredSongs.value[targetIndex])
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
    watch([() => userPlaylists.value.length, () => searchResults.value.length], () => {
      const list = activeTab.value === 'my' ? userPlaylists.value : searchResults.value
      const max = Math.max(1, Math.ceil(list.length / playlistPageSize.value))
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
    const goToPlaylistPage = (page) => {
      const maxPages = activeTab.value === 'my' 
        ? Math.ceil(userPlaylists.value.length / playlistPageSize.value)
        : Math.ceil(searchResults.value.length / playlistPageSize.value)
      if (page >= 1 && page <= maxPages) {
        playlistCurrentPage.value = page
      }
    }
    
    const prevPlaylistPage = () => {
      if (playlistCurrentPage.value > 1) {
        playlistCurrentPage.value--
      }
    }
    
    const nextPlaylistPage = () => {
      const maxPages = activeTab.value === 'my' 
        ? Math.ceil(userPlaylists.value.length / playlistPageSize.value)
        : Math.ceil(searchResults.value.length / playlistPageSize.value)
      if (playlistCurrentPage.value < maxPages) {
        playlistCurrentPage.value++
      }
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

    const searchPlaylists = async (query) => {
      try {
        loading.value = true
        console.log('🔍 搜索歌单:', query)
        
        const results = await musicApi.searchPlaylists(query)
        searchResults.value = results.playlists || []
        playlistCurrentPage.value = 1 // 新搜索结果重置歌单分页

        console.log('✅ 搜索完成，找到', searchResults.value.length, '个歌单')
      } catch (error) {
        console.error('❌ 搜索歌单失败:', error)
        searchResults.value = []
      } finally {
        loading.value = false
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
        currentSongId: currentSong.value?.id ?? null,
        currentTime: Number.isFinite(currentTime.value) ? currentTime.value : 0,
        volume: Number.isFinite(volume.value) ? volume.value : 80,
        playMode: playMode.value,
        showVipSongs: showVipSongs.value,
        autoFollowLyrics: autoFollowLyrics.value,
        playlistCollapsed: playlistCollapsed.value,
        songListCollapsed: songListCollapsed.value,
        lyricsCollapsed: lyricsCollapsed.value,
        playerHidden: playerHidden.value,
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
      if (typeof savedState.playlistCollapsed === 'boolean') playlistCollapsed.value = savedState.playlistCollapsed
      if (typeof savedState.songListCollapsed === 'boolean') songListCollapsed.value = savedState.songListCollapsed
      if (typeof savedState.lyricsCollapsed === 'boolean') lyricsCollapsed.value = savedState.lyricsCollapsed
      if (typeof savedState.playerHidden === 'boolean') playerHidden.value = savedState.playerHidden
      if (typeof savedState.fullscreenLyricMode === 'string') fullscreenLyricMode.value = savedState.fullscreenLyricMode
      if (typeof savedState.fullscreenInteractionMode === 'string') fullscreenInteractionMode.value = savedState.fullscreenInteractionMode
    }

    const restorePlaybackState = async (savedState) => {
      if (!savedState?.selectedPlaylistId || !savedState?.currentSongId) return

      const playlist = userPlaylists.value.find(p => String(p.id) === String(savedState.selectedPlaylistId))
      if (!playlist) return

      const selected = await selectPlaylist(playlist)
      if (!selected) return // 恢复被更新的选择抢占或歌单加载失败，不继续播放

      const restoredSongs = songs.value
      if (!restoredSongs.length) return

      // 仅按歌曲ID定位：索引兜底会在歌曲被移除后错播同位置的其他歌
      const restoredIndex = restoredSongs.findIndex(song => String(song.id) === String(savedState.currentSongId))
      if (restoredIndex === -1) {
        console.log('⏭️ 上次播放的歌曲已不在该歌单中，放弃恢复播放')
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

    // 歌曲播放逻辑
    // 注意竞态防护：controller/howl 均使用局部引用，所有回调只操作自己的实例，
    // 每个 await 之后都必须重新检查 abortSignal.aborted / currentPlayingId。
    const playSong = async (song, options = {}) => {
      const { autoplay = true, seekTime = 0 } = options

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

        // 立即停止当前播放，防止多首歌同时播放
        if (howl) {
          howl.stop()
          howl.unload()
          howl = null
        }

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
              console.log('🚫 歌曲加载完成但已被取消/切换，不开始播放:', song.name)
              newHowl.unload()
              if (howl === newHowl) howl = null
              return
            }

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
            // 无论是否过期都回收实例；过期时不得触碰新歌的共享状态
            newHowl.unload()
            if (isStale()) return
            songSwitching.value = false
            if (currentAbortController === myController) currentAbortController = null
            if (howl === newHowl) howl = null
            savePlayerStateToStorage()
          },
          onplayerror: (id, error) => {
            console.error('❌ 播放错误:', error)
            newHowl.unload()
            if (isStale()) return
            songSwitching.value = false
            if (currentAbortController === myController) currentAbortController = null
            if (howl === newHowl) howl = null
            savePlayerStateToStorage()
          }
        })

        howl = newHowl
        newHowl.volume(volume.value / 100)

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
      if (!howl) return
      
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

    // 以歌曲ID实时定位索引，避免 VIP 过滤/换歌单导致 currentSongIndex 漂移
    const currentFilteredIndex = () => {
      if (!currentSong.value) return -1
      // 与 playSong 一致用 String 比较：不同接口返回的 id 可能是 number 或 string
      return filteredSongs.value.findIndex(s => String(s.id) === String(currentSong.value.id))
    }

    const previousSong = () => {
      if (filteredSongs.value.length === 0) {
        // 兜底：列表为空且音频确已停止时复位播放态（正常播放中则保持 true）
        if (!howl || !howl.playing()) isPlaying.value = false
        return
      }

      const cur = currentFilteredIndex()
      if (playMode.value === 'single' && cur >= 0) {
        // 单曲循环模式下，重新播放当前歌曲
        playSong(filteredSongs.value[cur])
        return
      }

      let newIndex = cur >= 0 ? cur - 1 : 0
      if (cur >= 0 && newIndex < 0) {
        if (playMode.value === 'loop') {
          newIndex = filteredSongs.value.length - 1
        } else {
          return // 列表播放模式下，到达第一首就停止
        }
      }

      const song = filteredSongs.value[newIndex]
      if (song) {
        playSong(song)
      }
    }

    const nextSong = () => {
      if (filteredSongs.value.length === 0) {
        if (!howl || !howl.playing()) isPlaying.value = false
        return
      }

      const cur = currentFilteredIndex()
      if (playMode.value === 'single' && cur >= 0) {
        // 单曲循环模式下，重新播放当前歌曲
        playSong(filteredSongs.value[cur])
        return
      }

      let newIndex = cur >= 0 ? cur + 1 : 0
      if (newIndex >= filteredSongs.value.length) {
        if (playMode.value === 'loop') {
          newIndex = 0
        } else {
          // 列表播放到末尾：显式停止播放态，否则 isPlaying 残留 true、rAF 空转
          isPlaying.value = false
          currentTime.value = duration.value
          savePlaybackTimeIfNeeded(true)
          return
        }
      }

      const song = filteredSongs.value[newIndex]
      if (song) {
        playSong(song)
      }
    }

    const handleSongEnd = () => {
      if (playMode.value === 'single') {
        // 单曲循环：延迟到下一拍再重播。Howler 的 _ended 在 emit('end') 之后还会
        // 对当前 sound 执行内部 stop()，若在此同步 seek+play，刚发起的 play()
        // Promise 会被内部 stop 打断并触发 playerror（把 howl 置空），单曲循环失效。
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

    watch([
      showVipSongs,
      playerHidden,
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

    // 监听选项卡切换，重置歌单分页
    watch(activeTab, () => {
      playlistCurrentPage.value = 1
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

    // 检查是否为单首歌曲分享
    const isSingleSongShare = () => {
      return getSongIdFromUrl() !== null
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

    // 处理面板折叠
    const togglePlaylistCollapse = () => {
      playlistCollapsed.value = !playlistCollapsed.value
      savePlayerStateToStorage()
    }

    const toggleSongListCollapse = () => {
      songListCollapsed.value = !songListCollapsed.value
      savePlayerStateToStorage()
    }

    const toggleLyricsCollapse = () => {
      lyricsCollapsed.value = !lyricsCollapsed.value
      savePlayerStateToStorage()
    }

    const toggleCenterView = () => {
      centerView.value = centerView.value === 'songs' ? 'downloads' : 'songs'
    }

    // 组件挂载
    onMounted(async () => {
      console.log('🚀 App组件挂载完成')

      // 遥控器模式：不初始化播放器/歌单/播放状态恢复，纯控制端
      if (remoteMode.value === 'controller') {
        console.log('📱 遥控器模式，跳过播放器初始化')
        return
      }

      // 启动远程控制 host 连接
      if (remoteMode.value === 'host') {
        connectRemoteHost()
      }

      // 检查是否为单首歌曲分享，如果是则默认折叠歌单面板（仅移动端）
      if (isSingleSongShare() && window.innerWidth < 1024) {
        playlistCollapsed.value = true
        console.log('📱 检测到单首歌曲分享，移动端默认折叠歌单面板')
      }

      // 加载保存的歌单
      loadPlaylistsFromStorage()
      restorePlayerState = loadPlayerStateFromStorage()
      restoreUiState(restorePlayerState)

      // 加载默认歌单
      await loadDefaultPlaylists()
      
      // 如果有单首歌曲ID，尝试加载并播放
      const songId = getSongIdFromUrl()
      if (songId) {
        console.log('🎵 检测到单首歌曲分享，歌曲ID:', songId)
        try {
          // 检查是否已经存在相同的临时歌单
          const tempPlaylistId = `single_song_${songId}`
          let existingPlaylist = userPlaylists.value.find(p => p.id === tempPlaylistId)

          if (existingPlaylist && existingPlaylist.tracks?.length) {
            console.log('🎵 找到已存在的单曲分享歌单，直接使用')
            // 使用已存在的歌单
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

            // 添加到用户歌单列表
            userPlaylists.value.unshift(tempPlaylist)

            // 设置当前歌曲
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

      savePlayerStateToStorage()

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
      clearTimeout(volumeSaveTimer)
      if (howl) {
        howl.stop()
        howl.unload()
        howl = null
      }
    })

    return {
      // 响应式数据
      remoteMode,
      playerHidden,
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
      activeTab,
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
      loadingLyrics,
      currentPage,
      pageSize,
      playlistCurrentPage,
      playlistPageSize,
      playlistCollapsed,
      centerView,
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
      togglePlaylistCollapse,
      toggleSongListCollapse,
      toggleLyricsCollapse,
      toggleCenterView,
      songListCollapsed,
      lyricsCollapsed
    }
  }
}
</script>
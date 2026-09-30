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
      @nav-home="navHome"
      @search="handlePlaylistSearch"
      @search-by-id="previewPlaylistById"
      @search-bili="importBilibili"
      @search-yt="importYouTube"
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
          @select-playlist="selectPlaylistAndShow"
          @play-playlist="playPlaylistFromSidebar"
          @remove-playlist="removePlaylistFromLibrary"
          @playlist-downloads-deleted="handlePlaylistDownloadsDeleted"
        />
      </aside>

      <!-- 主区：首页发现流 / 歌曲列表 / 搜索结果 / watch 播放页 / 下载管理 -->
      <main class="app-main">
        <HomeFeed
          v-if="centerView === 'home'"
          :toplists="homeToplists"
          :recent-playlists="playlistHistory"
          :recents="playHistory"
          :loading="homeLoading"
          @open="openShelfPlaylist"
          @play-song="openWatchRecent"
        />
        <SongList
          v-else-if="centerView === 'songs'"
          :songs="songs"
          :loading-songs="loadingSongs"
          :current-song="currentSong"
          :is-playing="isPlaying"
          :show-vip-songs="showVipSongs"
          :selected-playlist="selectedPlaylist"
          :playlist-downloads-refresh-key="playlistDownloadsRefreshKey"
          :playlist-in-library="selectedPlaylistInLibrary"
          @play-song="openWatchSong"
          @play-all="playPlaylistAndWatch(false)"
          @play-shuffle="playPlaylistAndWatch(true)"
          @play-next="playNextInQueue"
          @add-to-queue="addToQueueEnd"
          @add-to-playlist="openAddToPlaylist"
          @add-songs="openSongPicker"
          @remove-from-playlist="removeSongFromPlaylist"
          @sync-playlist="syncPlaylist"
          @collect-playlist="collectSelectedPlaylist"
          @toggle-vip-songs="showVipSongs = !showVipSongs"
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
          @add-to-playlist="openAddToPlaylist"
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
          :queue-owner="queueOwner"
          :current-time="currentTime"
          :lyrics="lyrics"
          :current-lyric-index="currentLyricIndex"
          :loading-lyrics="loadingLyrics"
          :lyric-offset-ms="lyricOffsetMs"
          :playback-error="playbackError"
          :duration-warning="durationWarning"
          v-model:tab="watchTab"
          v-model:autoplay="autoplayOn"
          @lyric-offset-adjust="adjustLyricOffset"
          @lyric-offset-reset="resetLyricOffset"
          @back="watchBack"
          @open-fullscreen="openFullscreenPlayer"
          @queue-jump="queueJump"
          @queue-remove="queueRemove"
          @queue-move="queueMove"
          @save-queue="saveQueueAsPlaylist"
          @clear-queue="clearQueue"
          @play-song="playSongFromRelated"
          @open-source="openQueueSource"
          @add-to-playlist="openAddToPlaylist"
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
      :autoplay-on="autoplayOn"
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


    <!-- 添加到歌单选择器（待播/相关/歌单页/搜索结果四处行共用入口）。
         居中模态复用 pg-menu 皮：歌单列表 + 底部新建行 -->
    <Teleport to="body">
      <div
        v-if="addTargetSong"
        class="atp-overlay"
        @click="addTargetSong = null"
      >
        <div
          class="atp-dialog"
          role="dialog"
          aria-modal="true"
          :aria-label="`添加 ${addTargetSong.name} 到歌单`"
          @click.stop
        >
          <div class="pg-menu-head">添加到歌单 · {{ addTargetSong.name }}</div>
          <div class="atp-list">
            <button
              v-for="pl in addablePlaylists"
              :key="pl.id"
              class="pg-menu-item atp-item"
              :title="`加入《${pl.name}》`"
              @click="addSongToPlaylist(pl)"
            >
              <PixelIcon name="m-list" :size="13" />
              <span class="atp-name">{{ pl.name }}</span>
              <span class="atp-count">{{ pl.trackCount ?? pl.tracks?.length ?? 0 }} 首</span>
            </button>
            <p v-if="!addablePlaylists.length" class="atp-empty">还没有歌单，在下面建一个</p>
          </div>
          <div class="atp-new">
            <input
              ref="atpInput"
              v-model="newPlaylistName"
              placeholder="新建歌单…"
              maxlength="40"
              aria-label="新歌单名称"
              @keydown.enter="createPlaylistAndAdd"
            />
            <button
              class="ink-btn ink-btn--sm"
              :disabled="!newPlaylistName.trim()"
              @click="createPlaylistAndAdd"
            ><PixelIcon name="plus" :size="12" /> 新建</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 点歌台：搜索网易云 / 粘歌曲链接或 ID / B 站、YouTube 链接，向当前歌单一连追加。
         复用 atp 模态皮，加宽成 asp-dialog 容纳结果行 -->
    <Teleport to="body">
      <div
        v-if="songPickerOpen"
        class="atp-overlay"
        @click="closeSongPicker"
      >
        <div
          class="atp-dialog asp-dialog"
          role="dialog"
          aria-modal="true"
          :aria-label="`添加歌曲到 ${selectedPlaylist?.name}`"
          @click.stop
        >
          <div class="pg-menu-head">添加歌曲 · {{ selectedPlaylist?.name }}</div>
          <div class="atp-new asp-search">
            <input
              ref="songPickerInput"
              v-model="songPickerQuery"
              placeholder="搜歌名 / 粘歌曲链接、ID 或 B 站/YouTube 链接"
              aria-label="搜索或粘贴歌曲"
              @keydown.enter="!$event.isComposing && songPickerSearch()"
            />
            <button
              class="ink-btn ink-btn--sm"
              :disabled="!songPickerQuery.trim() || songPickerSearching"
              @click="songPickerSearch"
            ><PixelIcon name="search" :size="12" /> {{ songPickerSearching ? '…' : '搜索' }}</button>
          </div>
          <div class="atp-list" role="list" aria-label="搜索结果">
            <div
              v-for="song in songPickerResults"
              :key="song.id"
              class="asp-row"
              role="listitem"
            >
              <img
                v-if="song.al?.picUrl"
                class="asp-cover"
                :src="httpsCover(song.al.picUrl)"
                alt=""
                loading="lazy"
              />
              <div class="asp-text">
                <div class="asp-name" :title="song.name">{{ song.name }}</div>
                <div class="asp-artist">{{ (song.ar || []).map(a => a?.name).filter(Boolean).join('/') || '未知歌手' }}</div>
              </div>
              <button
                class="ink-btn ink-btn--sm asp-add"
                :disabled="pickerTakenIds.has(String(song.id)) || songPickerAdded.has(String(song.id)) || songPickerPending.has(String(song.id))"
                :aria-label="`添加 ${song.name}`"
                @click="addPickedSong(song)"
              >{{ pickerTakenIds.has(String(song.id)) || songPickerAdded.has(String(song.id)) ? '已在单' : '添加' }}</button>
            </div>
            <p v-if="!songPickerResults.length && !songPickerSearching" class="atp-empty">
              输入歌名搜索，或直接粘贴歌曲链接 / ID / B 站 BV 号 / YouTube 链接
            </p>
            <p v-if="songPickerSearching" class="atp-empty">搜索中…</p>
          </div>
        </div>
      </div>
    </Teleport>

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
      :lyric-offset-ms="lyricOffsetMs"
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
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { Howl } from 'howler'
import { musicApi, parseLyrics, mergeTranslations } from './api/music'
import { downloadsApi } from './api/downloads'
import { aiApi } from './api/ai'
import { resolveApiBaseUrl } from './lib/api-base'
import { formatTime } from './lib/format'
import { isVipSong, isLocalPlaylistId, isEphemeralPlaylistId, isSingleSongShellId } from './lib/song'
import { toast, isConfirmOpen, resolveConfirm } from './lib/feedback'
import { glitchBurst } from './lib/theme'
import { httpsCover, isBilibiliInput, isYouTubeInput, extractNeteaseSongId, extractYouTubeId } from './lib/url'
import TopNavigation from './components/TopNavigation.vue'
import PlaylistPanel from './components/PlaylistPanel.vue'
import PlaylistGrid from './components/PlaylistGrid.vue'
import HomeFeed from './components/HomeFeed.vue'
import SongList from './components/SongList.vue'
import WatchView from './components/WatchView.vue'
import FeedbackHost from './components/FeedbackHost.vue'
import BottomPlayer from './components/BottomPlayer.vue'
import PixelIcon from './components/PixelIcon.vue'
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
    AdminPanel,
    PixelIcon
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
    // 歌词时间校准（ms，正值=提前显示，同 LRC [offset:] 约定）——
    // 按歌词源 id 存服务端 song_lyric_meta，跨歌单/跨壳共享同一词源的校准
    const lyricOffsetMs = ref(0)
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
    const PLAY_HISTORY_STORAGE_KEY = 'meowsync-play-history'
    const PLAYLIST_HISTORY_STORAGE_KEY = 'meowsync-playlist-history'
    const REMOVED_DEFAULT_PLAYLISTS_KEY = 'removedDefaultPlaylists'
    let restorePlayerState = null
    let lastSavedWholeSecond = -1

    // YTM 式布局状态：主区视图（首页/歌曲/搜索结果/下载管理）+ 两个按需抽屉
    const centerView = ref('home') // 'home' | 'songs' | 'search' | 'watch' | 'downloads'
    const sidebarOpen = ref(false) // 移动端歌单库抽屉
    const searching = ref(false) // 仅驱动搜索结果网格的加载态（勿与歌单库 loading 混用）
    const searchSongResults = ref([]) // 单曲搜索结果（与歌单结果同区展示）
    const playlistDownloadsRefreshKey = ref(0)
    const topNavRef = ref(null) // 「/」快捷键聚焦搜索框

    // 首页发现流数据（toplist）+ 最近播放历史（歌曲/歌单两条线）
    const homeToplists = ref([])
    const playHistory = ref([])
    const playlistHistory = ref([])
    const homeLoading = ref(false)
    
    let howl = null
    let lyricTimer = null
    let progressRafId = null
    let howlWatchdog = null // 加载看门狗定时器（随每个新 Howl 重置）
    let currentAbortController = null // 用于取消正在进行的网络请求
    let currentPlayingId = null // 当前正在播放的歌曲ID，用于防止竞态条件
    let selectReqId = 0 // selectPlaylist 请求序号，防止慢响应覆盖新选择
    let previewSeq = 0 // 顶栏 id 预览序闸：selectPlaylist/playSong/新搜索都会顶掉它
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
    
    // ── URL 导航（YTM 式：视图/歌单可寻址，浏览器前进后退生效） ──
    const NAV_VIEWS = new Set(['home', 'songs', 'search', 'watch', 'downloads'])
    let suppressNavPush = false // popstate 回放时不再重复入栈

    // 首帧视图种子：onMounted 的恢复链是 await 串行（歌单详情/续播动辄秒级），
    // 等 applyUrlNav 落定会先渲一帧首页再跳回刷新前视图——此处按 ?view= 预置，
    // 合法性（pl 存在/歌曲恢复成功）仍由 applyUrlNav 终局修正；
    // search 冷加载必无结果必弹回首页，不预置
    const initialView = urlParams.get('view')
    if (['songs', 'watch', 'downloads'].includes(initialView)) centerView.value = initialView

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
        // pl 无效/歌单已被删：有选中歌单则仅切视图，否则退回首页。
        // 库外数字 pl = 预览单地址栏态——回落预览路径让 ?pl= 可刷新/可回退
        //（分享链 ?playlist=X&view=songs&pl=X 的接收端若删过默认单也能预览兜底）
        if (target) selectPlaylist(target)
        else if (plId && /^\d+$/.test(plId)) { previewPlaylistById(plId); return }
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
      previewSeq++ // 新搜索意图作废在途 id 预览
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

    // 顶栏标题/首页键：回发现流
    const navHome = () => {
      centerView.value = 'home'
      sidebarOpen.value = false
      pushNavState()
    }

    // 侧栏选歌单：回歌曲视图 + 移动端收起抽屉
    const selectPlaylistAndShow = async (playlist, opts) => {
      centerView.value = 'songs'
      sidebarOpen.value = false
      pushNavState(playlist)
      await selectPlaylist(playlist, opts)
    }

    // 顶栏数字 id 搜索：只预览不自动入库——入库与否由用户决定
    // （hero「收藏歌单」/搜索结果卡 + 键/点歌台直加自动收藏），
    // 避免「搜过一次 = 永久长进侧栏」的噪音积累。已入库则直接打开。
    const previewPlaylistById = async (id, rawQuery) => {
      const myReq = ++previewSeq
      try {
        // loadingSongs 而非 loading——loading 是侧栏整板 spinner，预览期间侧栏全空闪
        loadingSongs.value = true
        console.log('🔍 通过ID预览歌单:', id)
        const lib = userPlaylists.value.find(p => String(p.id) === String(id))
        if (lib) {
          await selectPlaylistAndShow(lib)
          if (!rawQuery || searchQuery.value.trim() === rawQuery.trim()) searchQuery.value = ''
          return
        }
        const playlist = await musicApi.getPlaylistDetail(id)
        // 在途间用户做了别的（新搜索/点歌/选单）→ 预览作废，不得抢视图
        if (myReq !== previewSeq) return
        // 接口对不存在的歌单返回无 id 的空壳对象（{ tracks: [] }），须校验后再打开
        if (playlist && playlist.id != null) {
          await openSearchPlaylist(playlist)
          // 只在框里还是本次提交的输入时才清——预览途中用户新敲的字不抹
          if (!rawQuery || searchQuery.value.trim() === rawQuery.trim()) searchQuery.value = ''
        } else {
          toast('未找到该歌单', 'info')
        }
      } catch (error) {
        if (myReq !== previewSeq) return
        console.error('❌ 加载歌单预览失败:', error)
        toast('歌单加载失败: ' + (error.response?.data?.message || error.message), 'error')
      } finally {
        if (myReq === previewSeq) loadingSongs.value = false
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

    // B 站导入曲对象：id 用 bv_ 前缀与网易云数值 id 隔离；歌曲名/封面/歌手
    // 优先吃网易云匹配（封面与双语歌词的正主），标题/UP主兜底；
    // bilibili 字段挂播放所需的源信息（bvid/cid/hasVideo），neteaseId 仅作歌词源
    const buildBilibiliSong = (data) => ({
      id: `bv_${data.bvid}${(data.page || 1) > 1 ? `_p${data.page}` : ''}`,
      name: data.matched?.name || data.songName || data.title,
      ar: data.matched?.ar?.length ? data.matched.ar : [{ name: data.owner || 'Bilibili' }],
      al: {
        id: data.matched?.al?.id ?? null,
        name: data.matched?.al?.name || data.title,
        picUrl: data.matched?.al?.picUrl || httpsCover(data.cover || '')
      },
      dt: (data.duration || 0) * 1000,
      bilibili: {
        bvid: data.bvid, cid: data.cid, page: data.page || 1,
        hasVideo: !!data.hasVideo, title: data.title,
        author: data.owner || '', matchedBy: data.matchedBy || null
      },
      neteaseId: data.matched?.id || null
    })

    // YouTube 导入曲对象：id 用 yt_ 前缀与 bv_/网易云数值隔离；youtube 字段
    // 挂播放源（videoId/hasVideo），neteaseId 仍仅作歌词源。封面走 ytimg
    // 服务端回链（matched 的网易云封面优先——高清且无防盗链风险）
    const buildYouTubeSong = (data) => ({
      id: `yt_${data.videoId}`,
      name: data.matched?.name || data.songName || data.title,
      // 未匹配时频道名兜底——authorClean 已剥 ' - Topic'/'VEVO' 后缀；
      // 频道名被整体剥光（如恰叫 'VEVO'）时回 'YouTube' 而非脏原值
      ar: data.matched?.ar?.length ? data.matched.ar : [{ name: data.authorClean || 'YouTube' }],
      al: {
        id: data.matched?.al?.id ?? null,
        name: data.matched?.al?.name || data.title,
        picUrl: data.matched?.al?.picUrl || httpsCover(data.cover || '')
      },
      dt: (data.duration || 0) * 1000,
      youtube: {
        videoId: data.videoId, hasVideo: !!data.hasVideo,
        title: data.title, author: data.author, matchedBy: data.matchedBy || null
      },
      neteaseId: data.matched?.id || null
    })

    // 外部媒体导入共用骨架：B 站/YouTube 同一形态「resolve → 幂等壳 → 开播进
    // watch」，差异只在解析端点/壳 id/显示名——收进 spec 防两份逻辑漂移
    const MEDIA_IMPORT_SPECS = {
      bilibili: {
        tag: 'B 站', icon: '📺',
        resolve: input => musicApi.resolveBilibili(input),
        build: buildBilibiliSong,
        shellIdOf: d => `single_song_bv_${d.bvid}${(d.page || 1) > 1 ? `_p${d.page}` : ''}`,
        shellNameOf: (song, d) => `B站导入 - ${song.name}${(d.page || 1) > 1 ? ` (P${d.page})` : ''}`,
        creator: 'B 站导入'
      },
      youtube: {
        tag: 'YouTube', icon: '▶️',
        resolve: input => musicApi.resolveYouTube(input),
        build: buildYouTubeSong,
        shellIdOf: d => `single_song_yt_${d.videoId}`,
        shellNameOf: song => `YouTube导入 - ${song.name}`,
        creator: 'YouTube 导入'
      }
    }
    let mediaImportSeq = 0
    const importExternalMedia = async (input, kind) => {
      const spec = MEDIA_IMPORT_SPECS[kind]
      const myReq = ++mediaImportSeq
      // 占住 selectReqId：resolve 慢（远端多跳），期间在途的 selectPlaylist
      // 回包不得在落壳之后盖掉 selectedPlaylist/songs
      selectReqId++
      loadingSongs.value = false // 被顶的 selectPlaylist 不会再复位 loading——收掉
      searchQuery.value = '' // 提前清框——防用户重复回车并发多个 resolve
      try {
        console.log(`${spec.icon} 解析 ${spec.tag} 视频:`, input)
        toast(`正在解析 ${spec.tag} 视频…`, 'info', 30000) // 覆盖 resolve 最坏耗时（~25s 匹配预算）
        const data = await spec.resolve(input)
        // 解析期间用户点了别的歌/再导入——过期意图不得抢播放+强跳视图
        if (myReq !== mediaImportSeq) return
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
          // 与单曲分享壳同一个上限桶（保留最近 10 个），倒序 splice 防下标错位
          const tempIndexes = userPlaylists.value
            .map((p, i) => isSingleSongShellId(p.id) ? i : -1)
            .filter(i => i !== -1)
          for (const i of tempIndexes.slice(10).reverse()) {
            userPlaylists.value.splice(i, 1)
          }
          savePlaylistsToStorage()
        }

        selectedPlaylist.value = shell
        currentSong.value = song
        songs.value = shell.tracks || []

        await playSong(song)
        enterWatch()
      } catch (error) {
        if (myReq !== mediaImportSeq) return // 过期请求的失败不打扰用户
        console.error(`❌ ${spec.tag} 导入失败:`, error)
        searchQuery.value = input // 失败还原输入——用户可直接回车重试
        toast(`${spec.tag} 导入失败：${error.message || '请检查链接后重试'}`, 'error', 5000)
      }
    }
    const importBilibili = (input) => importExternalMedia(input, 'bilibili')
    const importYouTube = (input) => importExternalMedia(input, 'youtube')

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

        // 本地单可能有服务端镜像产物（镜像行+下载任务+文件）——通知服务端级联清；
        // 失败仅留孤儿行，本地删除照常生效。single_song_ 壳从不镜像，不发空炮
        if (isLocalPlaylistId(playlist.id) && !isSingleSongShellId(playlist.id)) {
          downloadsApi.removeLocalMirror(playlist.id).catch(err =>
            console.warn('镜像清理失败（留孤儿行）:', playlist.id, err?.message))
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
        // trackIds 是 detail 响应带进的完整成员表（千曲单 ~10KB+），客户端不读它——
        // 与 lastRemoteIds 职责重复，持久化剥掉
        const { tracks, trackIds, ...rest } = p
        // addedTracks 瘦身到渲染+播放所需字段——接口返回的全对象（alia/嵌套 privilege 等）
        // 单曲 ~2-3KB，长期累积会撞 localStorage 配额
        if (Array.isArray(rest.addedTracks)) {
          rest.addedTracks = rest.addedTracks.map(t => t && ({
            // bilibili/neteaseId 是 B 站导入曲的播放源与歌词源——剥掉就退化成不可播对象
            id: t.id, name: t.name, ar: t.ar, al: t.al, dt: t.dt, fee: t.fee, privilege: t.privilege,
            bilibili: t.bilibili, neteaseId: t.neteaseId,
            youtube: t.youtube // YouTube 导入曲的播放源——与 bilibili/neteaseId 同理不可剥
          }))
        }
        return { ...rest, trackCount: rest.trackCount ?? (Array.isArray(tracks) ? tracks.length : 0) }
      })
      writeJSON(PLAYLISTS_STORAGE_KEY, toStore)
    }

    const loadPlaylistsFromStorage = () => {
      const savedPlaylists = readJSON(PLAYLISTS_STORAGE_KEY)
      if (Array.isArray(savedPlaylists)) {
        // 过滤 null/无 id 的脏条目，避免后续 String(p.id) 访问抛异常；
        // 同步字段若非数组（旧数据/手工改坏）会在合并/添加路径抛异常——load 时净化
        const validPlaylists = savedPlaylists
          .filter(p => p && p.id != null)
          .map(p => ({
            ...p,
            addedTracks: Array.isArray(p.addedTracks) ? p.addedTracks : undefined,
            removedTrackIds: Array.isArray(p.removedTrackIds) ? p.removedTrackIds : undefined,
            lastRemoteIds: Array.isArray(p.lastRemoteIds) ? p.lastRemoteIds : undefined
          }))
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
    const selectPlaylist = async (playlist, { force = false, silent = false } = {}) => {
      if (!playlist || playlist.id == null) return false
      if (!force && String(selectedPlaylist.value?.id) === String(playlist.id)) return true

      mediaImportSeq++ // 用户选了别的歌单——在途外部媒体解析回包不得抢播放/强跳视图
      previewSeq++     // 同上，作废在途的 id 预览（防回包强跳视图）
      const myReq = ++selectReqId
      try {
        // silent（手动同步复跑）：不闪 loading，行表直接热替换
        if (!silent) loadingSongs.value = true
        selectedPlaylist.value = playlist

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
          songs.value = [...visibleTracks, ...addedTracks]
          console.log('✅ 获取最新歌曲完成，共', songs.value.length, '首')

          // hero 同步详情——否则侧栏种子行（只有 id+name）会让 hero 永久显示占位元数据。
          // 本地增删（addedTracks/墓碑）要计入 trackCount——远端计数不含它们
          // 剥掉 playlist 参数上的同步键——传入的陈旧快照不能回退 libPl 刚写的值
          const { addedTracks: _a, removedTrackIds: _r, lastRemoteIds: _l, lastSyncedAt: _s, ...plBase } = playlist
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
            console.log('✅ 已更新本地歌单数据')
          }
        }
        return true
      } catch (error) {
        if (myReq !== selectReqId) return false
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

    // 播放条 ☰/词 开关 → 打开 watch 页对应 tab（YTM：UP NEXT/歌词都是页内栏位）。
    // 已在 watch 且同 tab 再点 = 收起回上一页（YTM miniplayer 同款开合）
    const openWatchPanel = (tab) => {
      if (!currentSong.value) return // 没在播的歌：空 watch 页无意义
      if (centerView.value === 'watch') {
        if (watchTab.value === tab) return watchBack()
        watchTab.value = tab
        return
      }
      watchTab.value = tab
      centerView.value = 'watch'
      pushNavState()
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

    // 首页最近播放：队列上下文就是历史列表本身（连播沿着记录往下走）
    const openWatchRecent = (song, list) => {
      enterWatch()
      playSongFromRelated(song, list)
    }

    // 货架卡片（榜单/最近歌单共用）：歌单还在库时用活副本——
    // 本地歌单（saved_queue_*）的 tracks 只在库里，stub 打开会空列表
    const openShelfPlaylist = (pl) => {
      const live = userPlaylists.value.find(p => String(p.id) === String(pl.id))
      openSearchPlaylist(live || pl)
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

    // ── 添加到歌单（待播/相关/歌单页/搜索结果行尾键共用入口） ──
    // 远端歌单不能整表存 tracks——本地追加记 addedTracks，selectPlaylist 拉取后合并；
    // 本地歌单（local_pl_/saved_queue_ 系）tracks 直接追加，持久化整条保留
    const addTargetSong = ref(null)
    const newPlaylistName = ref('')
    const atpInput = ref(null)
    // 可选目标排除 single_song_ 分享壳：它会被「超 10 个剪枝」自动销毁，
    // 用户加进去的曲会随壳静默消失（数据丢失通道）
    const addablePlaylists = computed(() =>
      userPlaylists.value.filter(p => !isSingleSongShellId(p.id))
    )
    const openAddToPlaylist = (song) => {
      closeSongPicker() // 与点歌台显式互斥（行菜单在模态外层但防御性收口）
      if (!song || song.id == null) {
        toast('这首歌无法加入歌单', 'error')
        return
      }
      newPlaylistName.value = ''
      addTargetSong.value = song
    }
    // 对话框开启期间：焦点移入输入框（键盘流可立即输入新歌单名）；
    // Esc 由 onGlobalKeydown 统一冻结处理，此处只管焦点归还（还给触发键）
    watch(addTargetSong, async (v, _prev, onCleanup) => {
      if (!v) return
      const prevFocus = document.activeElement
      onCleanup(() => { if (prevFocus instanceof HTMLElement) prevFocus.focus() })
      await nextTick()
      atpInput.value?.focus()
    })

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
          songs.value = [...songs.value, { ...song }]
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
      }
      pl.trackCount = (pl.trackCount ?? pl.tracks?.length ?? 0) + 1
      if (isOpenTarget) {
        songs.value = [...songs.value, entry]
        // 远端单的 selectedPlaylist 是 merge 快照（非库对象代理），hero 计数手动同步
        if (selectedPlaylist.value !== pl) {
          selectedPlaylist.value = { ...selectedPlaylist.value, trackCount: pl.trackCount }
        }
      }
      savePlaylistsToStorage()
      return 'added'
    }

    const addSongToPlaylist = (pl) => {
      const song = addTargetSong.value
      const res = appendSongToLibraryPlaylist(pl, song)
      if (res === 'invalid') return
      if (res === 'exists') toast(`「${song.name}」已在《${pl.name}》里`, 'info')
      else toast(`已加入《${pl.name}》`, 'success')
      addTargetSong.value = null
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
    let pickerSeq = 0
    let pickerAbort = null // 挂在窗生命周期的 AbortController——关窗中止在途 resolve

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
      pickerSeq++ // 上一窗在途的搜索/解析作废
      pickerAbort?.abort()   // 连带中止在途 resolve 的 HTTP（服务端级联断上游）
      pickerAbort = null
      addTargetSong.value = null // 与 atp 弹窗显式互斥——不指望 UI 不可达兜底
      songPickerQuery.value = ''
      songPickerResults.value = []
      songPickerSearching.value = false
      songPickerAdded.value = new Set()
      songPickerPending.value = new Set()
      songPickerOpen.value = true
    }
    const closeSongPicker = () => {
      songPickerOpen.value = false
      pickerSeq++
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
      const prevFocus = document.activeElement
      onCleanup(() => { if (prevFocus instanceof HTMLElement) prevFocus.focus() })
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

    const songPickerSearch = async () => {
      const q = songPickerQuery.value.trim()
      if (!q || songPickerSearching.value) return
      const mySeq = ++pickerSeq
      songPickerSearching.value = true
      let action = '搜索' // 失败 toast 名头按分支换——直加路径挂「搜索失败」误导
      try {
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
          if (mySeq !== pickerSeq || !songPickerOpen.value) return
          const song = buildBilibiliSong(data)
          // 同 id 重复解析不能进列表——:key 撞键会刷 Vue 警告
          songPickerResults.value = [song,
            ...songPickerResults.value.filter(r => String(r.id) !== String(song.id))]
          songPickerQuery.value = ''
          await addPickedSong(song)
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
          if (mySeq !== pickerSeq || !songPickerOpen.value) return
          const song = buildYouTubeSong(data)
          songPickerResults.value = [song,
            ...songPickerResults.value.filter(r => String(r.id) !== String(song.id))]
          songPickerQuery.value = ''
          await addPickedSong(song)
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
          if (mySeq !== pickerSeq || !songPickerOpen.value) return
          songPickerResults.value = [song,
            ...songPickerResults.value.filter(r => String(r.id) !== String(song.id))]
          songPickerQuery.value = ''
          await addPickedSong(song)
          return
        }
        const list = await musicApi.searchSongs(q, 30)
        if (mySeq !== pickerSeq || !songPickerOpen.value) return
        songPickerResults.value = list || []
        if (!list?.length) toast('没有找到相关歌曲', 'info')
      } catch (error) {
        if (mySeq !== pickerSeq || !songPickerOpen.value) return
        console.error('点歌台失败:', error)
        toast(`${action}失败: ` + (error.response?.data?.message || error.message), 'error')
      } finally {
        if (mySeq === pickerSeq) songPickerSearching.value = false
      }
    }

    // 用户新建歌单用 local_pl_ 前缀：isLocalPlaylistId 全链路（持久化保留 tracks /
    // 内嵌加载 / ?mix= 内容分享链 / 镜像服务端下载）现成正确，且不继承 saved_queue_
    // 的「播放上下文物件」语义（playerIsTemp 不禁随机）
    const createPlaylistAndAdd = () => {
      const name = newPlaylistName.value.trim()
      const song = addTargetSong.value
      if (!name || !song) return
      const pl = {
        id: `local_pl_${Date.now()}`,
        name,
        coverImgUrl: song.al?.picUrl || song.album?.picUrl || '',
        creator: { nickname: '我' },
        trackCount: 0,
        tracks: [],
        isLocal: true
      }
      userPlaylists.value.unshift(pl)
      // 传回库内响应式代理而非裸字面量——addSongToPlaylist 的字段赋值才走依赖
      addSongToPlaylist(userPlaylists.value.find(p => p.id === pl.id) || pl)
    }

    // 从歌单移除：本地单剪 tracks；远端单的本地追加曲剪 addedTracks；
    // 远端单的原生曲写 removedTrackIds 墓碑——否则下次单向同步（拉取合并）会复活它。
    // 纯库视图编辑：不动播放队列/当前曲（队列是快照语义）
    const removeSongFromPlaylist = (song) => {
      const pl = selectedPlaylist.value
      if (!song || song.id == null || !pl || pl.id == null) return
      // 读写都落库对象——selectedPlaylist 是 merge 快照，写它会丢持久化
      const libPl = userPlaylists.value.find(p => String(p.id) === String(pl.id)) || pl
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
    }

    // 手动同步：静默重拉远端歌单并报告增量。每次拉取都刷新 lastRemoteIds 基线，
    // 故 diff 的是「上次同步以来」的净变化——单向语义：只收远端增量，本地增删不回传
    const playlistSyncing = ref(false)
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

    // 相关 tab 点歌：YTM 以相关流接续——整个相关列表进队列（autoplay off 时队尾也有下一首）
    const playSongFromRelated = (song, list) => {
      const seed = Array.isArray(list) && list.length ? list.slice() : [song]
      setQueue(seed, null)
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
        musicApi.getToplists().then(list => { homeToplists.value = list.slice(0, 12) })
      ])
      settled.then(results => {
        // allSettled 吞掉每路报错——留个脚印，否则全挂时控制台静默
        results.forEach(r => {
          if (r.status === 'rejected') console.warn('[home]', r.reason?.message || r.reason)
        })
        // 全空（失败/空数组）解开一次性闩锁——回到首页或网络恢复时可重试
        if (!homeToplists.value.length) {
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
    // 最近播放：按 id 去重置顶、截 20 首；只存渲染/重播需要的字段，
    // 接口原始对象（含 alia 等大字段）整只塞 storage 会撑爆配额
    const recordPlayHistory = (song) => {
      if (!song || song.id == null) return
      const entry = {
        id: song.id, name: song.name,
        ar: song.ar || song.artists, al: song.al || song.album,
        dt: song.dt ?? song.duration, fee: song.fee, privilege: song.privilege,
        // B 站导入曲的播放源/歌词源字段——丢了从历史点回会退成不可播
        bilibili: song.bilibili, neteaseId: song.neteaseId,
        youtube: song.youtube // YouTube 导入曲同理——丢了从历史点回会退成不可播
      }
      playHistory.value = [entry, ...playHistory.value.filter(s => String(s.id) !== String(song.id))].slice(0, 20)
      writeJSON(PLAY_HISTORY_STORAGE_KEY, playHistory.value)
    }

    // 最近播放的歌单：记播放上下文的归属歌单（playingPlaylistId，已在快照时锁死）。
    // single_song_ 单曲分享是临时壳不算歌单；saved_queue_ 是用户歌单照记。
    // 对象优先查 userPlaylists 活副本（本地歌单的 tracks 只有那里有），查不到才落 stub
    const recordPlaylistHistory = () => {
      const pid = playingPlaylistId.value
      if (pid == null || isSingleSongShellId(pid)) return
      const pl = userPlaylists.value.find(p => String(p.id) === String(pid))
        || (String(selectedPlaylist.value?.id) === String(pid) ? selectedPlaylist.value : null)
      if (!pl) return
      const entry = {
        id: pl.id, name: pl.name,
        coverImgUrl: pl.coverImgUrl || pl.picUrl || '',
        trackCount: pl.trackCount ?? pl.tracks?.length
      }
      playlistHistory.value = [entry, ...playlistHistory.value.filter(p => String(p.id) !== String(pid))].slice(0, 20)
      writeJSON(PLAYLIST_HISTORY_STORAGE_KEY, playlistHistory.value)
    }

    const playSong = async (song, options = {}) => {
      if (!song || song.id == null) return
      mediaImportSeq++ // 用户点了别的歌——同上，作废在途外部媒体解析
      previewSeq++     // 同上，作废在途的 id 预览
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

        // 获取歌曲播放URL：B 站导入曲走 /bilibili/stream 端点——服务端每次
        // 重解 playurl（CDN 签名会过期）再 302 进 audio-proxy，URL 不落库
        const songUrlData = song.bilibili
          ? { url: musicApi.bilibiliStreamUrl(song.bilibili.bvid, 'audio', song.bilibili.cid, song.bilibili.page) }
          : song.youtube
            ? { url: musicApi.youtubeStreamUrl(song.youtube.videoId, 'audio') }
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
              // 外部导入曲的时长差是稿件换源/分P错位而非 VIP 试听，文案区分避免误报
              durationWarning.value = (song.bilibili || song.youtube)
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
    // 外部导入曲（B 站/YouTube）的歌词走匹配到的网易云曲 id（neteaseId），播放本体仍是 bv_*/yt_* id
    // ——过期判定锚 song.id，不锚歌词请求的 id
    const loadLyrics = async (song, signal = null) => {
      // 外部导入曲未匹配到网易云时无歌词源——bv_*/yt_* id 打 /lyric 必死还拖三重试，直接置空
      if ((song?.bilibili || song?.youtube) && !song.neteaseId) {
        lyrics.value = []
        currentLyricIndex.value = 0
        lyricOffsetMs.value = 0
        lyricOwnerKey.value = null
        return
      }
      const lyricId = song?.neteaseId ?? song?.id
      if (lyricId == null) return
      lyricOffsetMs.value = 0 // meta 回包前先归零——旧曲校准值不挂新曲界面
      try {
        loadingLyrics.value = true
        console.log('📝 加载歌词:', lyricId)

        // 校准随词源走（neteaseId 优先）：同一网易云词源在本地单/远端单/壳间共享。
        // meta 查询失败不阻塞歌词——校准只是修饰，降级为 0
        const metaPromise = downloadsApi.getSongMeta(lyricId).catch(() => null)
        const lyricsData = await musicApi.getLyrics(lyricId, signal)
        // 切歌/取消后直接丢弃，不写回共享状态
        if (signal?.aborted || currentPlayingId !== song.id) return
        const meta = await metaPromise
        if (signal?.aborted || currentPlayingId !== song.id) return

        lyricOffsetMs.value = meta?.data?.offsetMs ?? 0
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
        void postProcessLyrics(song, lyricId, seq, signal).catch(() => {})
      } catch (error) {
        if (signal?.aborted || error.name === 'AbortError' || error.code === 'ERR_CANCELED') return
        console.error('❌ 加载歌词失败:', error)
        if (currentPlayingId === song.id) {
          lyrics.value = []
          currentLyricIndex.value = 0
          lyricOwnerKey.value = null
        }
      } finally {
        if (!signal?.aborted && currentPlayingId === song.id) {
          loadingLyrics.value = false
        }
      }
    }

    // 已是中文语境歌词就不再翻译（CJK 字符占比 ≥30%——日汉混排宁误判跳过
    // 也不错翻；日文假名/韩文谚文计入分母，它们正是需要翻译的对象）
    const lyricCjkDominant = (lines) => {
      const text = lines.map(l => l.text).join('')
      const cjk = (text.match(/[一-鿿㐀-䶿]/g) || []).length
      const other = (text.match(/[A-Za-z぀-ヿ가-힯]/g) || []).length
      return cjk / (cjk + other || 1) >= 0.3
    }

    // AI 歌词后处理：① 外部导入曲核验配到的网易云歌词确实属于这首（错配时
    // 「错歌词比没歌词更糟」→ 整组隐藏）；② 无官方译文且非中文语境 → 自动
    // 生成中文译文并按时间戳合并。全程后台异步，写回前复查词属主+加载序号。
    // 会话级缓存：判定/译文结果按 (词源,来源)/(词源) 记忆——重播/往返不再
    // 重复请求，也避免「错词短暂闪现再被隐藏」
    const aiLyricVerdicts = new Map()   // `${lyricId}|${title}|${author}` -> boolean
    const aiLyricTranslations = new Map() // lyricId -> tlyric 字符串
    let lyricProcSeq = 0 // 每次歌词落盘 +1；postProcess 捕获，ownsLyric 比对
    const postProcessLyrics = async (song, lyricId, seq, signal = null) => {
      if (!lyrics.value.length) return
      const st = await aiApi.status()
      if (!st?.enabled) return
      // 词属主复查：每个 await 后都可能已切歌/重载——写回前必须确认
      const ownsLyric = () => lyricProcSeq === seq
        && lyricOwnerKey.value === lyricId && currentPlayingId === song.id

      // ① 外部曲歌词归属核验（bilibili/youtube 经匹配才来的词源有风险；
      //    纯网易云曲的词源天然属本曲，不验）
      const ext = song?.youtube
        ? { title: song.youtube.title, author: song.youtube.author || '' }
        : song?.bilibili
          ? { title: song.bilibili.title, author: song.bilibili.author || '' }
          : null
      if (ext?.title && ownsLyric()) {
        const vkey = `${lyricId}|${ext.title}|${ext.author}`
        let ok = aiLyricVerdicts.get(vkey)
        if (ok === undefined) {
          try {
            // verify 秒级任务随切歌一起 abort；translate 则刻意不接 signal——
            // 服务端完成后按词源落库，中断只会丢掉本次缓存收益
            const v = await aiApi.verifyLyric(lyricId, ext.title, ext.author, signal)
            ok = v?.ok !== false
            if (v && typeof v.ok === 'boolean') aiLyricVerdicts.set(vkey, v.ok)
          } catch { ok = true /* 核验通道故障放行——AI 是增强不是门禁 */ }
        }
        if (!ok) {
          if (ownsLyric()) {
            lyrics.value = []
            currentLyricIndex.value = 0
            lyricOwnerKey.value = null
            toast('歌词与歌曲疑似不匹配，已隐藏', 'info')
          }
          return // 词源错了就不必再翻译错词
        }
      }

      // ② 无官方译文 + 非中文语境 → 自动翻译（普通网易云外语曲同样受益）
      if (!ownsLyric() || !lyrics.value.length) return
      if (lyrics.value.some(l => l.translation)) return
      if (lyricCjkDominant(lyrics.value)) return
      try {
        let tlyric = aiLyricTranslations.get(lyricId)
        let lines = null
        if (tlyric === undefined) {
          const r = await aiApi.translateLyric(lyricId)
          tlyric = r?.tlyric || null
          lines = r?.lines
          if (tlyric) aiLyricTranslations.set(lyricId, tlyric)
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

    const startLyricSync = () => {
      if (lyricTimer) {
        clearInterval(lyricTimer)
      }

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
      // 添加到歌单模态同款冻结——否则 Tab 到框外后 /、f、空格全部穿透生效
      if (addTargetSong.value) {
        if (e.key === 'Escape') addTargetSong.value = null
        return
      }
      // 点歌台模态同款冻结。Esc 连框内焦点也收（输入态下 Esc 的直觉就是关窗）；
      // 非 Esc 键直接 return——空格/斜杠不会穿透到全局快捷键
      if (songPickerOpen.value) {
        if (e.key === 'Escape') closeSongPicker()
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
        case 'k': case 'K':
          // YTM 键序：k=播放/暂停（k 无原生激活语义，不必像空格那样让位按钮焦点）
          togglePlay()
          break
        case 'j': case 'J':
          seekBy(-10) // YTM：j/l = ±10s
          break
        case 'l': case 'L':
          seekBy(10)
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

    // 从URL参数获取 B 站导入标识（?bili=BVxxx 分享链）
    const getBiliFromUrl = () => {
      const urlParams = new URLSearchParams(window.location.search)
      const bili = urlParams.get('bili')
      if (!bili || !/^(BV[0-9A-Za-z]{10}|av\d+)$/i.test(bili.trim())) return null
      // 分P分享链 ?bili=BV&p=N——拼回 input 串让服务端 pickPageParam 接住
      const p = /^\d+$/.test(urlParams.get('p') || '') ? Number(urlParams.get('p')) : 0
      const input = p > 1 ? `${bili.trim()}?p=${p}` : bili.trim()
      console.log('📺 从URL获取 B 站视频:', input)
      return input
    }


    // 从URL参数获取 YouTube 导入标识（?yt=<videoId> 分享链）
    const getYtFromUrl = () => {
      const urlParams = new URLSearchParams(window.location.search)
      const yt = urlParams.get('yt')
      if (!yt || !/^[A-Za-z0-9_-]{11}$/.test(yt.trim())) return null
      console.log('▶️ 从URL获取 YouTube 视频:', yt.trim())
      // 传 ?yt= 形态而非裸 id：服务端 [?&]yt= 分支无 \D 要求（全数字 videoId
      // 也可解），且 resolve 失败还原进搜索框后仍是 isYouTubeInput 形态——
      // 回车重试不会退化关键词搜索（isYouTubeInput 收窄后裸 id 不再命中）
      return `?yt=${yt.trim()}`
    }

    // ?mix=<name>~id1,id2,bv_X_pN,yt_<vid> 本地歌单内容携带链：数字 id 走网易云
    // 批量详情，bv_/yt_ 段逐个 resolve。~ 用 lastIndexOf 取——name 里本身可以含 ~
    const getMixFromUrl = () => {
      const urlParams = new URLSearchParams(window.location.search)
      const mix = urlParams.get('mix')
      if (!mix || !mix.includes('~')) return null
      return mix
    }

    const MIX_IMPORT_CAP = 300      // 与生成侧 shareUrlFor 的截断对齐
    const MIX_RESOLVE_CAP = 10      // bv_/yt_ 逐项 resolve——客户端预算共桶（服务端两端点各 12/min 分桶）
    const importMixPlaylist = async (mix) => {
      const sep = mix.lastIndexOf('~')
      // [...str] 按码点切——slice 按 code unit 会斩断 emoji 代理对留孤代理
      const name = [...(mix.slice(0, sep).trim() || '分享歌单')].slice(0, 60).join('')
      const seen = new Set()
      const ids = []
      for (const raw of mix.slice(sep + 1).split(',')) {
        const id = raw.trim()
        if (!(/^\d+$/.test(id) || /^bv_BV[0-9A-Za-z]{10}(_p\d+)?$/i.test(id)
          || /^yt_[A-Za-z0-9_-]{11}$/.test(id))) continue
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

      const myReq = ++mediaImportSeq
      selectReqId++
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
          if (myReq !== mediaImportSeq) return
          if (/^\d+$/.test(id)) {
            const s = detailMap.get(id)
            if (s) tracks.push(s); else skipped++
            continue
          }
          // bv_/yt_ 共用客户端 resolve 预算——同链混排外部曲总数封顶（服务端两端点分桶各 12/min）
          if (++resolveCount > MIX_RESOLVE_CAP) { skipped++; continue }
          const ym = /^yt_([A-Za-z0-9_-]{11})$/.exec(id)
          if (ym) {
            try {
              // 传 ?yt= 形态而非裸 id——服务端 [?&]yt= 分支无 \D 要求，
              // 全数字 videoId（理论存在）也能解
              tracks.push(buildYouTubeSong(await musicApi.resolveYouTube(`?yt=${ym[1]}`)))
            } catch { skipped++ }
            continue
          }
          const m = /^bv_(BV[0-9A-Za-z]{10})(?:_p(\d+))?$/i.exec(id)
          if (!m) { skipped++; continue }
          try {
            const input = m[2] ? `${m[1]}?p=${m[2]}` : m[1]
            tracks.push(buildBilibiliSong(await musicApi.resolveBilibili(input)))
          } catch { skipped++ }
        }
        if (myReq !== mediaImportSeq) return
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
          if (++mixSeen <= 20) return true
          pruned.push(p.id)
          return false
        })
        for (const pid of pruned) downloadsApi.removeLocalMirror(pid).catch(() => {})
        savePlaylistsToStorage()
        // force：existing 空壳可能正被选中——同 id 短路会留下陈旧空列表视图
        selectPlaylistAndShow(pl, { force: true })
        toast(`已导入「${name}」（${tracks.length} 首${skipped ? `，跳过 ${skipped} 首` : ''}）`, 'success')
      } catch (error) {
        if (myReq !== mediaImportSeq) return
        console.error('mix 导入失败:', error)
        toast(`导入分享歌单失败：${error.message || '请稍后重试'}`, 'error', 5000)
      }
    }

    // 消费掉一次性 URL 参数：不清理的话每次刷新都会重新劫持恢复逻辑
    // （?song= 会永久抢占 restorePlaybackState；?playlists= 会重复尝试导入）
    const consumeUrlShareParams = () => {
      const url = new URL(window.location.href)
      let changed = false
      for (const key of ['song', 'playlist', 'playlists', 'bili', 'yt', 'p', 'mix']) {
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

      // 加载保存的歌单与最近播放历史（首页 recent/history 区块数据源）
      loadPlaylistsFromStorage()
      const savedHistory = readJSON(PLAY_HISTORY_STORAGE_KEY)
      if (Array.isArray(savedHistory)) {
        playHistory.value = savedHistory.filter(s => s && s.id != null)
      }
      const savedPlHistory = readJSON(PLAYLIST_HISTORY_STORAGE_KEY)
      if (Array.isArray(savedPlHistory)) {
        playlistHistory.value = savedPlHistory.filter(p => p && p.id != null)
      }
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
      const biliInput = getBiliFromUrl()
      const ytInput = getYtFromUrl()
      const mixInput = getMixFromUrl()
      // 所有参数读取已完毕——消费掉，避免下次刷新重新劫持恢复逻辑
      consumeUrlShareParams()
      if (biliInput) {
        // ?bili= 分享链：走与搜索框导入同一条路
        await importBilibili(biliInput)
      } else if (ytInput) {
        // ?yt= 分享链同理
        await importYouTube(ytInput)
      } else if (mixInput) {
        // ?mix= 本地歌单内容链：重建 local_pl_mix_ 壳
        await importMixPlaylist(mixInput)
      } else if (songId) {
        console.log('🎵 检测到单首歌曲分享，歌曲ID:', songId)
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
            const tempIndexes = userPlaylists.value
              .map((p, i) => isSingleSongShellId(p.id) ? i : -1)
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
      flushLyricOffsetSave() // 卸载前把待发的校准写出去
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
      lyricOffsetMs,
      adjustLyricOffset,
      resetLyricOffset,
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
      queueOwner,
      topNavRef,
      homeToplists,
      playlistHistory,
      playHistory,
      homeLoading,

      // 方法
      previewPlaylistById,
      loadPlaylistById,
      selectedPlaylistInLibrary,
      collectSelectedPlaylist,
      importBilibili,
      importYouTube,
      importMixPlaylist,
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
      openWatchRecent,
      openShelfPlaylist,
      playPlaylistAndWatch,
      watchBack,
      playSongFromRelated,
      openQueueSource,
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
      toggleCenterView,
      addTargetSong,
      newPlaylistName,
      atpInput,
      songPickerOpen,
      songPickerQuery,
      songPickerResults,
      songPickerSearching,
      songPickerAdded,
      songPickerPending,
      songPickerInput,
      pickerTakenIds,
      openSongPicker,
      closeSongPicker,
      addPickedSong,
      songPickerSearch,
      addablePlaylists,
      openAddToPlaylist,
      addSongToPlaylist,
      createPlaylistAndAdd,
      removeSongFromPlaylist,
      syncPlaylist,
      httpsCover
    }
  }
}
</script>
<template>
  <!-- 登录门：探活完成前不渲染任何业务壳（否则 RemoteController 会抢在
       状态判定前发起未认证 WS）；需要登录而未认证时 AuthGate 接管全屏；
       登录成功整页重载重走初始化 -->
  <div v-if="!authState.booted" style="position:fixed;inset:0;background:#f4f1ea;z-index:999"></div>
  <AuthGate
    v-else-if="authRequired()"
    :is-setup="authState.setupRequired"
    :expired="authState.expired"
    @authed="onAuthed"
    @skip="dismissSetup"
  />

  <!-- 手机控制器模式 -->
  <RemoteController v-else-if="remoteMode === 'controller'" :ws-url="remoteControllerWsUrl" :ws-protocols="remoteWsProtocols" />

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
      @search-song="importNeteaseSongById"
      @search-bili="importBilibiliOrFav"
      @search-yt="importYouTubeOrPlaylist"
      @search-qq="importQQ"
      @search-qq-pl="importQQPlaylist"
      @search-qq-songs="handleQQSongSearch"
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
          :recent-playlists="playlistHistory"
          :recents="playHistory"
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
          :song-total="searchSongTotal"
          :song-loading-more="searchSongLoadingMore"
          :current-song="currentSong"
          :user-playlists="userPlaylists"
          :loading="searching"
          @open="openSearchPlaylist"
          @add="addPlaylistToLibrary"
          @play-song="openWatchSearchSong"
          @add-to-playlist="openAddToPlaylist"
          @close="closeSearchView"
          @load-more-songs="loadMoreSearchSongs"
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
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { Howl, Howler } from 'howler'
// HTML5 音频池默认 10 太小：失败重试/快速切歌期间，在途 fetch 的节点
// 来不及释放就被判 locked，报「Audio pool exhausted」伪错误——扩到 24
Howler.html5PoolSize = 24
import { musicApi, parseLyrics, mergeTranslations } from './api/music'
import { downloadsApi } from './api/downloads'
import { aiApi } from './api/ai'
import { authApi } from './api/auth'
import { authState, authRequired, dismissSetup } from './lib/auth-state'
import AuthGate from './components/AuthGate.vue'
import { useRemoteControl } from './composables/useRemoteControl'
import { useHomeFeed } from './composables/useHomeFeed'
import { readJSON, writeJSON } from './lib/storage'
import { formatTime } from './lib/format'
import { isEphemeralPlaylistId, visibleSongs } from './lib/song'
import { serverCaps, loadServerCaps } from './lib/caps'
import { toast, isConfirmOpen, resolveConfirm } from './lib/feedback'
import { glitchBurst } from './lib/theme'
import { httpsCover } from './lib/url'
import { readShareParams, consumeUrlShareParams } from './lib/share-params'
import { createReqGate } from './lib/req-gate'
import { usePlaylistLibrary } from './composables/usePlaylistLibrary'
import { useSearchNav } from './composables/useSearchNav'
import { useExternalImport } from './composables/useExternalImport'
import { useAddToPlaylist } from './composables/useAddToPlaylist'
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
    AuthGate,
    PixelIcon
  },
  setup() {
    // 响应式数据
    const searchQuery = ref('')
    const loading = ref(false)
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
    let restorePlayerState = null
    let lastSavedWholeSecond = -1

    // YTM 式布局状态：主区视图（首页/歌曲/搜索结果/下载管理）+ 两个按需抽屉
    const topNavRef = ref(null) // 「/」快捷键聚焦搜索框

    // 最近播放历史收敛在 composables/useHomeFeed.js
    // （recordPlayHistory/recordPlaylistHistory/restoreHistory 同迁）

    let howl = null
    let lyricTimer = null
    let progressRafId = null
    let howlWatchdog = null // 加载看门狗定时器（随每个新 Howl 重置）
    let currentAbortController = null // 用于取消正在进行的网络请求
    let currentPlayingId = null // 当前正在播放的歌曲ID，用于防止竞态条件
    // 请求序号闸（lib/req-gate.js）：跨域互作废（选单顶掉在途导入/预览、导入顶掉在途选单）
    // 要求闸是共享对象而非局部 let——composable 化后各域注入同一组 gate 语义等价
    const gates = {
      select: createReqGate(),      // selectPlaylist 竞态：慢响应不得覆盖新选择
      preview: createReqGate(),     // 顶栏 id 预览：selectPlaylist/playSong/新搜索顶掉
      search: createReqGate(),      // 顶栏搜索
      mediaImport: createReqGate(), // 外部媒体/歌单导入竞态
      picker: createReqGate(),      // 点歌台弹窗内竞态
    }

    // 歌单库域（composables/usePlaylistLibrary.js）：库 CRUD / localStorage 持久化 /
    // selectPlaylist 单向同步合并（远端曲 − 墓碑 + 本地追加）/ 行级增删
    const {
      userPlaylists, selectedPlaylist, songs, loadingSongs,
      playlistDownloadsRefreshKey,
      savePlaylistsToStorage, loadPlaylistsFromStorage, getRemovedDefaultPlaylists,
      addPlaylistToLibrary, removePlaylistFromLibrary, handlePlaylistDownloadsDeleted,
      loadPlaylistById, collectSelectedPlaylist, selectedPlaylistInLibrary,
      selectPlaylist, appendSongToLibraryPlaylist, removeSongFromPlaylist, syncPlaylist,
    } = usePlaylistLibrary({ gates, playingPlaylistId })

    // 导航+搜索域（composables/useSearchNav.js）：URL 可寻址视图/history 栈、
    // 顶栏双区搜索与单曲深挖、id 预览、watch 页进出。playSong 族惰性转发防 TDZ
    const {
      centerView, sidebarOpen, searching,
      searchResults, searchSongResults,
      searchSongQuery, searchSongTotal, searchSongLoadingMore,
      buildNavUrl, pushNavState, applyUrlNav, normalizeNavEntry,
      navHome, closeSearchView, toggleCenterView, watchBack,
      enterWatch, openWatchPanel,
      selectPlaylistAndShow, openSearchPlaylist, openShelfPlaylist,
      previewPlaylistById,
      openWatchSong, openWatchSearchSong, openWatchRecent, playPlaylistAndWatch,
      handlePlaylistSearch, handleQQSongSearch, loadMoreSearchSongs,
    } = useSearchNav({
      gates,
      searchQuery, currentSong, watchTab,
      userPlaylists, selectedPlaylist, loadingSongs, selectPlaylist,
      playSong: (s, o) => playSong(s, o),
      playSongFromSearch: (s) => playSongFromSearch(s),
      playSongFromRelated: (s, l) => playSongFromRelated(s, l),
      playPlaylist: (sh) => playPlaylist(sh),
    })

    // 外部导入域（composables/useExternalImport.js）：单曲 resolve 导入 / 三源整单导入 /
    // mix 内容分享导入 / 网易云单曲壳。playSong 声明在后部——惰性转发让闭包在
    // 调用时才取值（实例化于 TDZ 之前的等价语义）
    const {
      importExternalMedia, importBilibili, importYouTube, importQQ,
      importBilibiliOrFav, importYouTubeOrPlaylist,
      importQQPlaylist, importBiliFavlist, importYouTubePlaylist,
      importNeteaseSongById, importMixPlaylist,
    } = useExternalImport({
      gates,
      userPlaylists, selectedPlaylist, songs, loadingSongs, savePlaylistsToStorage,
      searchQuery, currentSong,
      playSong: (s, o) => playSong(s, o),
      enterWatch: () => enterWatch(),
      selectPlaylistAndShow: (p, o) => selectPlaylistAndShow(p, o),
    })

    // 「加入歌单」域（composables/useAddToPlaylist.js）：atp 弹窗（指定曲→选单）+
    // 点歌台弹窗（当前单内搜/粘曲追加），两弹窗显式互斥
    const {
      addTargetSong, newPlaylistName, atpInput, addablePlaylists,
      openAddToPlaylist, addSongToPlaylist, createPlaylistAndAdd,
      songPickerOpen, songPickerQuery, songPickerResults, songPickerSearching,
      songPickerAdded, songPickerPending, songPickerInput, pickerTakenIds,
      openSongPicker, closeSongPicker, addPickedSong, songPickerSearch,
    } = useAddToPlaylist({
      gates,
      userPlaylists, selectedPlaylist, songs,
      addPlaylistToLibrary, appendSongToLibraryPlaylist,
    })

    let volumeSaveTimer = null

    // 远程控制（host 广播 + 指令执行 + 重连）收敛在 composables/useRemoteControl.js——
    // 依赖 refs/函数定义在下方，实例化点见 updateVolume 之后
    const filteredSongs = computed(() =>
      visibleSongs(songs.value, showVipSongs.value, serverCaps.value)
    )
    


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

    // 歌曲播放逻辑
    // 注意竞态防护：controller/howl 均使用局部引用，所有回调只操作自己的实例，
    // 每个 await 之后都必须重新检查 abortSignal.aborted / currentPlayingId。
    // preserveContext=true 表示本次切歌属于播放队列内导航（上一首/下一首/远端点歌），
    // 沿用已有快照；默认则从当前浏览列表拍新快照。
    const playSong = async (song, options = {}) => {
      if (!song || song.id == null) return
      gates.mediaImport.invalidate() // 用户点了别的歌——同上，作废在途外部媒体解析
      gates.preview.invalidate()     // 同上，作废在途的 id 预览
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
        // 重解 playurl（CDN 签名会过期）再 302 进 audio-proxy，URL 不落库。
        // _localFile：在线链全灭后的本地工件兜底（onloaderror 兜底链写入），
        // 优先级最高——文件在盘上，不再打上游玩一遍注定失败的链
        const songUrlData = options._localFile
          ? { url: downloadsApi.songFileUrl(options._localFile, song.id) }
          : song.bilibili
            ? { url: musicApi.bilibiliStreamUrl(song.bilibili.bvid, 'audio', song.bilibili.cid, song.bilibili.page) }
            : song.youtube
              ? { url: musicApi.youtubeStreamUrl(song.youtube.videoId, 'audio') }
              : song.qq
                ? { url: musicApi.qqStreamUrl(song.qq.mid, '', song.qq.mediaMid) }
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
              durationWarning.value = (song.bilibili || song.youtube || song.qq)
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
            // 再败说明工件本体坏了——不再兜，走正常报错出口
            if ((song.youtube || song.bilibili || song.qq) && !options._localFile) {
              const plId = playingPlaylistId.value || selectedPlaylist.value?.id
              if (plId) {
                void playDownloadedCopy(song, plId, options)
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

    // 在线流彻底失效后的兜底（SABR 闸控的 YouTube 自适应流/签名批量耗尽的
    // 实际救法）：先查服务器有没有已下载工件，没有就触发服务器下载、完成后
    // 续播本地文件——用户口径「不能在线放就先下载下来」。只对自有源外部曲
    // 开放；切歌（currentPlayingId 换人）即整链作废
    const playDownloadedCopy = async (song, playlistId, options) => {
      if (currentPlayingId !== song.id) return
      songSwitching.value = true // 下载等待期维持切换态——底栏别装死
      try {
        const st = await downloadsApi.getSongDownloadStatus(playlistId, song.id).catch(() => null)
        let downloaded = st?.data?.downloaded === true
        if (!downloaded) {
          toast('在线源不可用，先下载到服务器再播…', 'info')
          // 未镜像的本地单先补镜像（幂等：内容签名未变时服务端直接短路返回）
          const pl = (selectedPlaylist.value && String(selectedPlaylist.value.id) === String(playlistId))
            ? selectedPlaylist.value
            : userPlaylists.value.find(p => String(p.id) === String(playlistId))
          if (pl) await downloadsApi.mirrorLocalPlaylist(pl).catch(() => null)
          const submitted = await downloadsApi.downloadSongToServer(playlistId, song.id, { bitrate: 320000 })
          downloaded = submitted?.data?.status === 'completed'
          // 提交即返回——终态轮询确认（音频档秒级完事，封顶 3min 防无限挂起）
          const deadline = Date.now() + 3 * 60 * 1000
          while (!downloaded && Date.now() < deadline && currentPlayingId === song.id) {
            await new Promise(r => setTimeout(r, 1500))
            const st2 = await downloadsApi.getSongDownloadStatus(playlistId, song.id).catch(() => null)
            if (st2?.data?.downloaded) { downloaded = true; break }
            const ts = st2?.data?.task?.status
            if (ts === 'failed' || (st2?.data && st2.data.task === null)) break
          }
        }
        if (currentPlayingId !== song.id) return // 等下载期间用户切了歌——静默弃
        if (!downloaded) {
          songSwitching.value = false
          playbackError.value = '在线源不可用，服务器下载仍在进行——完成后可重播'
          return
        }
        toast('已切换本地已下载文件播放', 'info')
        playSong(song, { ...options, preserveContext: true, _streamRetried: true, _localFile: playlistId })
      } catch {
        if (currentPlayingId === song.id) {
          songSwitching.value = false
          playbackError.value = '音频加载失败，点击播放键或重新点歌可重试'
        }
      }
    }

    // 歌词加载和同步（支持取消 + 过期响应不落盘，防止旧歌歌词覆盖新歌）。
    // 外部导入曲（B 站/YouTube）的歌词走匹配到的网易云曲 id（neteaseId），播放本体仍是 bv_*/yt_* id
    // ——过期判定锚 song.id，不锚歌词请求的 id
    const loadLyrics = async (song, signal = null) => {
      // 外部导入曲未匹配到网易云时无歌词源——bv_*/yt_* id 打 /lyric 必死还拖三重试，直接置空；
      // qq_ 不在此列——QQ 曲有自家权威词源（/qq/lyric），无匹配也能出词
      if ((song?.bilibili || song?.youtube) && !song.neteaseId) {
        lyrics.value = []
        currentLyricIndex.value = 0
        lyricOffsetMs.value = 0
        lyricOwnerKey.value = null
        return
      }
      // 词源选择：qq_ 曲首选 QQ 自带词（qq_<mid> 作词源 id——AI 翻译/校准
      // 缓存都认这个键）；QQ 词源空且匹配到网易云时回落网易云词源（嫁接词，
      // postProcess 会走归属核验）
      let lyricId = song?.qq ? `qq_${song.qq.mid}` : (song?.neteaseId ?? song?.id)
      if (lyricId == null) return
      lyricOffsetMs.value = 0 // meta 回包前先归零——旧曲校准值不挂新曲界面
      try {
        loadingLyrics.value = true
        console.log('📝 加载歌词:', lyricId)

        // 校准随词源走（neteaseId 优先）：同一网易云词源在本地单/远端单/壳间共享。
        // meta 查询失败不阻塞歌词——校准只是修饰，降级为 0。
        // qq 词源要等 fetch 后才知道是否回落，meta 延到词源定稿再查
        const metaPromise = song?.qq ? null : downloadsApi.getSongMeta(lyricId).catch(() => null)
        let lyricsData = song?.qq
          ? await musicApi.getQQLyric(song.qq.mid, signal).catch(() => null)
          : await musicApi.getLyrics(lyricId, signal)
        // 切歌/取消后直接丢弃，不写回共享状态
        if (signal?.aborted || currentPlayingId !== song.id) return
        if (song?.qq && !lyricsData?.lyrics?.length && song.neteaseId) {
          lyricId = song.neteaseId
          lyricsData = await musicApi.getLyrics(lyricId, signal)
          if (signal?.aborted || currentPlayingId !== song.id) return
        }
        const meta = song?.qq
          ? await downloadsApi.getSongMeta(lyricId).catch(() => null)
          : await metaPromise
        if (signal?.aborted || currentPlayingId !== song.id) return

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
      // 词属主复查：每个 await 后都可能已切歌/重载——写回前必须确认
      const ownsLyric = () => lyricProcSeq === seq
        && lyricOwnerKey.value === lyricId && currentPlayingId === song.id

      // ① 外部曲歌词归属核验（bilibili/youtube 经匹配才来的词源有风险；
      //    qq 曲用自家词源时不验——词曲同属一台天然正确；仅当回落到匹配的
      //    网易云词源（lyricId==neteaseId）才是嫁接词，照样过核验）。
      //    不因 enabled=false 跳过：服务端先回已落库的判定缓存，命中即生效
      //    ——AI 关停后旧否决仍能挡住错词；未命中才 503 由 catch 放行
      const ext = song?.youtube
        ? { title: song.youtube.title, author: song.youtube.author || '' }
        : song?.bilibili
          ? { title: song.bilibili.title, author: song.bilibili.author || '' }
          : (song?.qq && String(lyricId) === String(song.neteaseId))
            ? { title: song.name, author: song.ar?.map(a => a.name).join(' ') || '' }
            : null
      if (ext?.title && ownsLyric()) {
        // 含模型维度——与服务端 vkey 同口径：换模型后旧判定不应再挡路
        const vkey = JSON.stringify([lyricId, ext.title, ext.author, st.model || ''])
        let ok = aiLyricVerdicts.get(vkey)
        const fresh = ok === undefined // 缓存命中的否决静默生效，不重复打扰
        if (fresh) {
          try {
            // verify 秒级任务随切歌一起 abort；translate 刻意不接 signal——
            // 切歌不断连，服务端仍可完成并落库（页面关闭则连服务端一起中止）
            const v = await aiApi.verifyLyric(lyricId, ext.title, ext.author, signal)
            ok = v?.ok !== false
            // inconclusive（服务端故障放行）不缓存——恢复后重播要能重验，
            // 与服务端不落库 inconclusive 的口径一致
            if (v && typeof v.ok === 'boolean' && !v.inconclusive) {
              aiLyricVerdicts.set(vkey, v.ok)
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
          return // 词源错了就不必再翻译错词
        }
      }

      // ② 无官方译文 + 非中文语境 → 自动翻译（普通网易云外语曲同样受益）
      //    AI 未配置时 503 会每首歌重发，这里直接早退省一跳
      if (!st?.enabled || !ownsLyric() || !lyrics.value.length) return
      if (lyrics.value.some(l => l.translation)) return
      if (lyricCjkDominant(lyrics.value)) return
      try {
        let tlyric = aiLyricTranslations.get(lyricId)
        let lines = null
        if (tlyric === undefined) {
          const r = await aiApi.translateLyric(lyricId)
          tlyric = r?.tlyric || null
          lines = r?.lines
          // 负结果也入会期缓存（skip 哨兵/already-zh/无词）——否则每播
          // 一次同首歌都重打一次 translate；请求异常走 catch 不缓存
          aiLyricTranslations.set(lyricId, tlyric)
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

    // 远程控制：host 模式 state_update 广播 + 指令执行 + 断线重连。
    // 必须放在全部依赖（refs/playbackList/updateVolume 等）定义之后实例化；
    // 模式判定要在播放器初始化前生效——controller 分支在下方 init 里提前 return
    const { remoteMode, remoteControllerWsUrl, remoteWsProtocols, connectRemoteHost } = useRemoteControl({
      getHowl: () => howl,
      isPlaying, currentSong, currentTime, duration, volume,
      playingSongs, songSwitching, filteredSongs,
      playSong, nextSong, previousSong, updateVolume, currentPlayingIndex, playbackList
    })

    // 最近播放历史（storage 持久化；首页货架全由本地历史派生，零网络）
    // ——收敛 composables/useHomeFeed.js
    const {
      playHistory, playlistHistory,
      recordPlayHistory, recordPlaylistHistory, restoreHistory
    } = useHomeFeed({ userPlaylists, selectedPlaylist, playingPlaylistId })

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

    // 从URL参数获取歌单ID列表
    // 分享链参数解析已收敛到 lib/share-params.js:readShareParams——
    // 一趟解析出 { playlistIds, songId, bili, yt, qq, qqpl, mix }

    // URL歌单加载（playlistIds 由 readShareParams 在挂载处一趟解析后传入）
    const loadDefaultPlaylists = async (urlPlaylistIds) => {
      try {
        console.log('🎵 检查是否需要加载URL歌单...')

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


    // 登录/建号成功：cookie 已落盘，整页重载以干净状态重走 onMounted 管线
    const onAuthed = () => window.location.reload()

    onMounted(async () => {
      console.log('🚀 App组件挂载完成')

      // 登录探活先行：需要登录而未认证时 AuthGate 接管，跳过全部初始化
      // （遥控端同样被门——WS 握手也要带登录 cookie）
      try {
        const st = await authApi.status()
        const d = st?.data || {}
        authState.enabled = !!d.authEnabled
        authState.setupRequired = !!d.setupRequired
        authState.authenticated = !!d.authenticated
        authState.username = d.username || null
      } catch { /* 探活失败按未启用处理——离线单机的旧行为 */ }
      authState.booted = true
      if (authRequired()) return

      // 遥控器模式：不初始化播放器/歌单/播放状态恢复，纯控制端
      if (remoteMode.value === 'controller') {
        console.log('📱 遥控器模式，跳过播放器初始化')
        return
      }

      setupMediaSessionHandlers()
      loadServerCaps() // 源凭据状态（qq loggedIn 等）——VIP 可见性等判定消费，无需 await

      // 启动远程控制 host 连接
      if (remoteMode.value === 'host') {
        connectRemoteHost()
      }

      // 单曲分享：侧栏抽屉默认收起，主区直接呈现歌曲——无需额外处理

      // 加载保存的歌单与最近播放历史（首页 recent/history 区块数据源）
      loadPlaylistsFromStorage()
      restoreHistory()
      restorePlayerState = loadPlayerStateFromStorage()
      restoreUiState(restorePlayerState)

      // 分享参数一趟读完再消费掉——不消费的话每次刷新都会重新劫持
      // 恢复逻辑（?song= 会永久抢占 restorePlaybackState）
      const share = readShareParams()
      consumeUrlShareParams()

      // 加载默认歌单
      await loadDefaultPlaylists(share.playlistIds)

      if (share.bili) {
        // ?bili= 分享链：走与搜索框导入同一条路（收藏夹链也经此转 favlist 导入）
        await importBilibiliOrFav(share.bili)
      } else if (share.yt) {
        // ?yt= 分享链同理（歌单链也经此转 playlist 导入）
        await importYouTubeOrPlaylist(share.yt)
      } else if (share.qq) {
        // ?qq= 分享链同理
        await importQQ(share.qq)
      } else if (share.qqpl) {
        // ?qqpl= 歌单按引用分享链——整单重拉
        await importQQPlaylist(share.qqpl)
      } else if (share.mix) {
        // ?mix= 本地歌单内容链：重建 local_pl_mix_ 壳
        await importMixPlaylist(share.mix)
      } else if (share.songId) {
        console.log('🎵 检测到单首歌曲分享，歌曲ID:', share.songId)
        await importNeteaseSongById(share.songId)
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
      normalizeNavEntry()
      console.log('✅ 初始化完成，用户歌单数量:', userPlaylists.value.length)
    })

    // 组件卸载：清理 WS/定时器/rAF/音频，避免泄漏与卸载后重连
    onBeforeUnmount(() => {
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
      teardownMediaSession()
      if (howl) {
        howl.stop()
        howl.unload()
        howl = null
      }
    })

    return {
      // 响应式数据
      authState,
      authRequired,
      dismissSetup,
      onAuthed,
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
      searchSongTotal,
      searchSongLoadingMore,
      loadMoreSearchSongs,
      playlistDownloadsRefreshKey,
      shuffleOn,
      playMode,
      playingSongs,
      queueTitle,
      queueOwner,
      topNavRef,
      playlistHistory,
      playHistory,

      // 方法
      previewPlaylistById,
      loadPlaylistById,
      selectedPlaylistInLibrary,
      collectSelectedPlaylist,
      importBilibili,
      importBilibiliOrFav,
      importBiliFavlist,
      importYouTube,
      importYouTubeOrPlaylist,
      importYouTubePlaylist,
      importQQ,
      importQQPlaylist,
      importNeteaseSongById,
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
      handleQQSongSearch,
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
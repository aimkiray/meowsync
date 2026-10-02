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
import { authApi } from './api/auth'
import { authState, authRequired, dismissSetup } from './lib/auth-state'
import AuthGate from './components/AuthGate.vue'
import { useRemoteControl } from './composables/useRemoteControl'
import { useHomeFeed } from './composables/useHomeFeed'
import { visibleSongs } from './lib/song'
import { serverCaps, loadServerCaps } from './lib/caps'
import { isConfirmOpen, resolveConfirm } from './lib/feedback'
import { httpsCover } from './lib/url'
import { readShareParams, consumeUrlShareParams } from './lib/share-params'
import { createReqGate } from './lib/req-gate'
import { usePlaylistLibrary } from './composables/usePlaylistLibrary'
import { usePlayer } from './composables/usePlayer'
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
    const showVipSongs = ref(true) // 控制VIP歌曲显示，默认显示
    // watch 播放页：右栏 tab（待播/歌词/相关）与 YTM UP NEXT 自动播放开关
    const watchTab = ref('queue')
    const playingPlaylistId = ref(null) // 快照所属歌单 id——持久化恢复用它而非浏览态 id
    const fullscreenLyricMode = ref('original')
    const fullscreenInteractionMode = ref('auto')
    let restorePlayerState = null

    // YTM 式布局状态：主区视图（首页/歌曲/搜索结果/下载管理）+ 两个按需抽屉
    const topNavRef = ref(null) // 「/」快捷键聚焦搜索框

    // 最近播放历史收敛在 composables/useHomeFeed.js
    // （recordPlayHistory/recordPlaylistHistory/restoreHistory 同迁）

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
      loadDefaultPlaylists,
    } = usePlaylistLibrary({ gates, playingPlaylistId })

    const filteredSongs = computed(() =>
      visibleSongs(songs.value, showVipSongs.value, serverCaps.value)
    )

    // 最近播放历史（storage 持久化；首页货架全由本地历史派生，零网络）
    // ——收敛 composables/useHomeFeed.js
    const {
      playHistory, playlistHistory,
      recordPlayHistory, recordPlaylistHistory, restoreHistory
    } = useHomeFeed({ userPlaylists, selectedPlaylist, playingPlaylistId })

    // 播放器内核域（composables/usePlayer.js）：Howler 生命周期 / 队列
    // （shuffle 物理打乱+原序备份）/ 歌词管线（AI 校验翻译+校准持久化）/
    // MediaSession / 播放状态存档恢复
    const {
      currentSong, playMode, shuffleOn, autoplayOn,
      songSwitching, isPlaying, isFullscreenPlayerOpen,
      currentTime, duration, volume, durationWarning, playbackError,
      playingSongs, queueTitle, queueOwner, playerIsTemp,
      lyrics, currentLyricIndex, lyricOffsetMs, loadingLyrics,
      adjustLyricOffset, resetLyricOffset, scheduleLyricOffsetSave,
      playbackList, currentPlayingIndex, setQueue, toggleShuffle,
      queueJump, queueRemove, queueMove, clearQueue,
      playNextInQueue, addToQueueEnd, saveQueueAsPlaylist, openQueueSource,
      playSong, playPlaylist, playPlaylistFromSidebar, playSongFromSearch,
      playSongFromRelated,
      togglePlay, togglePlayMode, getPlayModeText,
      previousSong, nextSong, seekTo, seekBy, updateVolume, toggleMute,
      openFullscreenPlayer, closeFullscreenPlayer,
      savePlayerStateToStorage, loadPlayerStateFromStorage,
      restoreUiState, restorePlaybackState, savePlaybackTimeIfNeeded,
      setupMediaSessionHandlers, teardownMediaSession, getHowl,
    } = usePlayer({
      gates,
      playingPlaylistId,
      userPlaylists, selectedPlaylist,
      selectPlaylist, savePlaylistsToStorage,
      filteredSongs,
      showVipSongs, fullscreenLyricMode, fullscreenInteractionMode,
      recordPlayHistory, recordPlaylistHistory, restoreHistory,
    })

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

    // 远程控制：host 模式 state_update 广播 + 指令执行 + 断线重连（composables/
    // useRemoteControl.js）。必须放在 usePlayer 之后实例化——依赖全部来自播放器域；
    // 模式判定要在播放器初始化前生效——controller 分支在下方 init 里提前 return
    const { remoteMode, remoteControllerWsUrl, remoteWsProtocols, connectRemoteHost } = useRemoteControl({
      getHowl,
      isPlaying, currentSong, currentTime, duration, volume,
      playingSongs, songSwitching, filteredSongs,
      playSong, nextSong, previousSong, updateVolume, currentPlayingIndex, playbackList
    })

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

    watch([
      showVipSongs,
      isFullscreenPlayerOpen,
      fullscreenLyricMode,
      fullscreenInteractionMode
    ], () => {
      savePlayerStateToStorage()
    })

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

    // 组件卸载：音频/定时器/WS 由各 composable 自收；此处只摘全局键盘监听
    onBeforeUnmount(() => {
      window.removeEventListener('keydown', onGlobalKeydown)
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
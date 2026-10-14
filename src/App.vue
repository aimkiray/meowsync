<template>
  <!-- 登录门：探活完成前不渲染任何业务壳（否则 RemoteController 会抢在
       状态判定前发起未认证 WS）；需要登录而未认证时 AuthGate 接管全屏；
       登录成功整页重载重走初始化 -->
  <div v-if="!authState.booted" style="position:fixed;inset:0;background:var(--page);z-index:var(--z-menu)"></div>
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
      :is-settings-view="centerView === 'settings'"
      v-model:search-query="searchQuery"
      :sidebar-open="sidebarOpen"
      :remote-mode="remoteMode"
      @toggle-center-view="toggleCenterView"
      @open-settings="toggleSettings"
      @toggle-sidebar="sidebarOpen = !sidebarOpen"
      @nav-home="navHome"
      @search="handlePlaylistSearch"
      @search-by-id="previewPlaylistById"
      @search-song="importNeteaseSongById"
      @search-bili="importBilibiliOrFav"
      @search-bili-songs="handleBiliSongSearch"
      @search-yt="importYouTubeOrPlaylist"
      @search-yt-songs="handleYTSongSearch"
      @search-qq="importQQ"
      @search-qq-pl="importQQPlaylist"
      @search-qq-songs="handleQQSongSearch"
    />

    <div class="app-body">
      <!-- 移动端侧栏抽屉遮罩 -->
      <div v-if="sidebarOpen" class="sidebar-scrim" @click="sidebarOpen = false"></div>

      <!-- 左侧：歌单库（桌面常驻 / 移动端抽屉） -->
      <aside class="app-sidebar" :class="{ 'app-sidebar--open': sidebarOpen }" aria-label="歌单库">
        <PlaylistPanel
          :loading="loading"
          :selected-playlist="selectedPlaylist"
          :user-playlists="userPlaylists"
          @select-playlist="selectPlaylistAndShow"
          @play-playlist="playPlaylistFromSidebar"
          @remove-playlist="handleRemovePlaylist"
          @open-create-playlist="handleOpenCreatePlaylist"
          @playlist-downloads-deleted="handlePlaylistDownloadsDeleted"
          @view-download-progress="openDownloadsForPlaylist"
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
          @add-to-playlist="handleOpenAddToPlaylist"
          @add-songs="handleOpenSongPicker"
          @edit-song="openSongForm"
          @remove-from-playlist="handleRemoveSongFromPlaylist"
          @sync-playlist="syncPlaylist"
          @collect-playlist="collectSelectedPlaylist"
          @toggle-vip-songs="showVipSongs = !showVipSongs"
          @move-song="moveSongInPlaylist"
          @group-by-artist="groupSongsByArtist"
          @open-downloads="openDownloadsForPlaylist(selectedPlaylist?.id)"
          @song-meta-updated="savePlaylistsToStorage"
        />
        <PlaylistGrid
          v-else-if="centerView === 'search'"
          :results="searchResults"
          :songs="searchSongResults"
          :query="searchQuery"
          :song-total="searchSongTotal"
          :song-has-more="searchSongHasMore"
          :song-loading-more="searchSongLoadingMore"
          :current-song="currentSong"
          :user-playlists="userPlaylists"
          :loading="searching"
          @open="openSearchPlaylist"
          @add="addPlaylistToLibrary"
          @play-song="openWatchSearchSong"
          @add-to-playlist="handleOpenAddToPlaylist"
          @close="closeSearchView"
          @load-more-songs="loadMoreSearchSongs"
        />
        <!-- YTM watch 播放页：点单曲进入；歌词/待播/相关都在页内右栏，不遮主区 -->
        <WatchView
          v-else-if="centerView === 'watch'"
          :current-song="currentSong"
          :is-playing="isPlaying"
          :song-switching="songSwitching"
          :queue="playingSongs"
          :queue-title="queueTitle"
          :queue-owner="queueOwner"
          :current-time="currentTime"
          :lyrics="lyrics"
          :current-lyric-index="currentLyricIndex"
          :loading-lyrics="loadingLyrics"
          :lyric-offset-ms="lyricOffsetMs"
          :lyric-fetching="lyricFetching"
          :playback-error="playbackError"
          :duration-warning="durationWarning"
          :fullscreen-player-open="isFullscreenPlayerOpen"
          :shuffle-on="shuffleOn"
          :play-mode="playMode"
          :play-mode-text="getPlayModeText()"
          :song-downloading="songDownloading"
          :song-downloaded="songDownloaded"
          v-model:tab="watchTab"
          v-model:autoplay="autoplayOn"
          @lyric-offset-adjust="adjustLyricOffset"
          @lyric-offset-reset="resetLyricOffset"
          @lyric-fetch="manualFetchLyrics"
          @lyric-align="alignCurrentLyrics"
          @download-song="onWatchDownloadSong"
          @back="watchBack"
          @open-fullscreen="openFullscreenPlayer"
          @toggle-play="togglePlay"
          @toggle-shuffle="toggleShuffle"
          @toggle-play-mode="togglePlayMode"
          @queue-jump="queueJump"
          @queue-remove="queueRemove"
          @queue-move="queueMove"
          @save-queue="saveQueueAsPlaylist"
          @clear-queue="clearQueue"
          @play-song="playSongFromRelated"
          @open-source="openQueueSource"
          @add-to-playlist="handleOpenAddToPlaylist"
        />
        <SettingsPanel v-else-if="centerView === 'settings'" />
        <DownloadsPanel
          v-else-if="centerView === 'downloads'"
          :preselect-playlist-id="downloadsPl"
          :preselect-seq="downloadsPlSeq"
          @preselect-expired="clearDownloadsPl"
        />
        <!-- 未知 centerView 不落任何分支——旧 v-else 兜底会把陌生/脏值视图
             静默渲成下载页（还顺手激活其轮询），显式空分支更诚实 -->
        <template v-else></template>
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
        @mousedown="onOverlayDown"
        @mouseup="onOverlayUp"
        @click="onAtpOverlayClick"
      >
        <div
          class="atp-dialog"
          role="dialog"
          aria-modal="true"
          :aria-label="`添加 ${addTargetSong.name} 到歌单`"
          @click.stop
          @keydown="onDialogTrapKeydown"
        >
          <div class="pg-menu-head flex items-center justify-between gap-2">
            <span class="truncate min-w-0">添加到歌单 · {{ addTargetSong.name }}</span>
            <button
              type="button"
              class="pg-icobtn pg-icobtn--bare pg-icobtn--sm shrink-0"
              aria-label="关闭"
              title="关闭"
              @click="addTargetSong = null"
            ><PixelIcon name="close" :size="13" /></button>
          </div>
          <div class="atp-list">
            <button
              v-for="pl in addablePlaylists"
              :key="pl.id"
              class="pg-menu-item"
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
              @keydown.enter="!($event.isComposing || $event.keyCode === 229) && createPlaylistAndAdd()"
            />
            <button
              class="ink-btn ink-btn--sm"
              :disabled="!newPlaylistName.trim()"
              @click="createPlaylistAndAdd"
            >新建</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 新建空白歌单（侧栏头 + 键触发）：复用 atp 模态皮，仅头 + 命名行 -->
    <Teleport to="body">
      <div
        v-if="createPlaylistOpen"
        class="atp-overlay"
        @mousedown="onOverlayDown"
        @mouseup="onOverlayUp"
        @click="onCreateOverlayClick"
      >
        <div
          class="atp-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="新建歌单"
          @click.stop
          @keydown="onDialogTrapKeydown"
        >
          <div class="pg-menu-head flex items-center justify-between gap-2">
            <span class="truncate min-w-0">新建歌单</span>
            <button
              type="button"
              class="pg-icobtn pg-icobtn--bare pg-icobtn--sm shrink-0"
              aria-label="关闭"
              title="关闭"
              @click="closeCreatePlaylist()"
            ><PixelIcon name="close" :size="13" /></button>
          </div>
          <div class="atp-new atp-new--flush">
            <input
              ref="createPlaylistInput"
              v-model="createPlaylistName"
              placeholder="歌单名…"
              maxlength="40"
              aria-label="歌单名称"
              @keydown.enter="!($event.isComposing || $event.keyCode === 229) && submitCreatePlaylist()"
            />
            <button
              class="ink-btn ink-btn--sm"
              :disabled="!createPlaylistName.trim()"
              @click="submitCreatePlaylist"
            >创建</button>
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
        @mousedown="onOverlayDown"
        @mouseup="onOverlayUp"
        @click="onPickerOverlayClick"
      >
        <div
          class="atp-dialog asp-dialog"
          role="dialog"
          aria-modal="true"
          :aria-label="`添加歌曲到 ${selectedPlaylist?.name}`"
          @click.stop
          @keydown="onDialogTrapKeydown"
        >
          <div class="pg-menu-head flex items-center justify-between gap-2">
            <span class="truncate min-w-0">添加歌曲 · {{ selectedPlaylist?.name }}</span>
            <button
              type="button"
              class="pg-icobtn pg-icobtn--bare pg-icobtn--sm shrink-0"
              aria-label="关闭"
              title="关闭"
              @click="closeSongPicker()"
            ><PixelIcon name="close" :size="13" /></button>
          </div>
          <div class="atp-new asp-search">
            <input
              ref="songPickerInput"
              v-model="songPickerQuery"
              placeholder="搜歌名 / 粘歌曲链接、ID 或 B 站/YouTube 链接"
              aria-label="搜索或粘贴歌曲"
              @keydown.enter="!($event.isComposing || $event.keyCode === 229) && songPickerSearch()"
            />
            <button
              class="ink-btn ink-btn--sm"
              :disabled="!songPickerQuery.trim() || songPickerSearching"
              @click="songPickerSearch"
            ><PixelIcon name="search" :size="12" /> {{ songPickerSearching ? '…' : '搜索' }}</button>
          </div>
          <div class="atp-list" role="list" aria-label="搜索结果">
            <!-- 「从 0 新建」入口：上传音频/视频/歌词/封面组成本地 file_ 曲，
                 与搜歌并列是点歌台的第二条进曲通道 -->
            <div v-if="canCreateLocalSong" class="asp-row asp-row--create" role="listitem">
              <div class="asp-text">
                <div class="asp-name">新建歌曲</div>
                <div class="asp-artist">上传本地音频/视频文件</div>
              </div>
              <button
                class="ink-btn ink-btn--sm asp-add"
                aria-haspopup="dialog"
                aria-label="新建歌曲（上传本地文件）"
                @click="openSongForm()"
              >创建</button>
            </div>
            <div
              v-for="(song, index) in songPickerResults"
              :key="`asp-${index}-${song.id}`"
              class="asp-row"
              role="listitem"
            >
              <img
                v-if="coverSizeUrl(song.al?.picUrl, 80)"
                class="asp-cover"
                :src="httpsCover(coverSizeUrl(song.al.picUrl, 80))"
                alt=""
                loading="lazy"
                decoding="async"
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

    <!-- 歌曲表单：新建（song=null）/编辑（song=对象）双模——互斥由 open 侧收口，
         四窗冻结链见 onGlobalKeydown -->
    <!-- v-if 懒挂载：组件自身 v-if="open"+Teleport 渲染不变；async chunk
         未到时整个标签不渲（首次开窗一次 chunk fetch 的代价换它离开 index 包） -->
    <SongFormDialog
      v-if="songFormOpen"
      :open="songFormOpen"
      :song="songFormSong"
      :busy="songFormBusy"
      @close="closeSongForm"
      @submit="submitSongForm"
      @abort="abortSongFormUpload"
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
      :lyric-offset-ms="lyricOffsetMs"
      :song-switching="songSwitching"
      :lyric-mode="fullscreenLyricMode"
      @close="closeFullscreenPlayer"
      @toggle-play="togglePlay"
      @previous-song="previousSong"
      @next-song="nextSong"
      @seek-to="seekTo"
      @update-volume="updateVolume"
      @update:lyric-mode="fullscreenLyricMode = $event"
    />
  </div>
</template>

<script>
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick, defineAsyncComponent } from 'vue'
import { authApi } from './api/auth'
import { authState, authRequired, dismissSetup } from './lib/auth-state'
import AuthGate from './components/AuthGate.vue'
import { useRemoteControl } from './composables/useRemoteControl'
import { useHomeFeed } from './composables/useHomeFeed'
import { visibleSongs } from './lib/song'
import { serverCaps, loadServerCaps } from './lib/caps'
import { isConfirmOpen, resolveConfirm, toast, pixelConfirm } from './lib/feedback'
import { httpsCover, isResolvableTrackId } from './lib/url'
import { readShareParams, consumeUrlShareParams } from './lib/share-params'
import { LS_KEYS, readJSON, writeJSON } from './lib/storage'
import { initSync, pullFromServer, markDirty, onRemoteApply, attachWriteHook } from './lib/sync'
import { createReqGate } from './lib/req-gate'
import { trapTabKeydown } from './lib/focus-trap'
import { usePlaylistLibrary } from './composables/usePlaylistLibrary'
import { usePlayer } from './composables/usePlayer'
import { useSearchNav } from './composables/useSearchNav'
import { useExternalImport } from './composables/useExternalImport'
import { useAddToPlaylist } from './composables/useAddToPlaylist'
import TopNavigation from './components/TopNavigation.vue'
import PlaylistPanel from './components/PlaylistPanel.vue'
import HomeFeed from './components/HomeFeed.vue'
import { uploadFile, deleteUploadedSong } from './api/uploads'
import { downloadsApi } from './api/downloads'
import { isFileTrackId, isLocalPlaylistId, isEphemeralPlaylistId, coverSizeUrl } from './lib/song'
import FeedbackHost from './components/FeedbackHost.vue'
import BottomPlayer from './components/BottomPlayer.vue'
import PixelIcon from './components/PixelIcon.vue'

// 视图级代码分块：非首屏/动作后挂载的重组件按 chunk 懒取（Vite 自动连
// 带各自 scoped CSS 与独有依赖离开 index 包；FullscreenPlayer 还拖着
// 664 行的 canvas 歌词渲染器）。组件均经 v-if/v-else-if 分支挂载，
// chunk 未到时该分支不渲——无 Suspense 需求。
// chunk 拉取失败兜底：「旧页面+新部署」错配时 import() 打到的 hash 档
// 已不存在，且浏览器模块表会把失败记忆化（会话内重试瞬拒）——除整页
// 重载没有恢复路径。reload 时 index.html 走 no-cache 拿到新 hash 自愈；
// 挂起 promise 防 loader resolve undefined 触发 Vue 警告
const lazyView = (loader) => defineAsyncComponent(() =>
  loader().catch(() => { location.reload(); return new Promise(() => {}) }))
// WatchView/SongList 是热路径：挂载后 idle 预取同名模块暖 chunk 缓存，
// 首次导航命中内存模块表零等待
const PlaylistGrid = lazyView(() => import('./components/PlaylistGrid.vue'))
const SongList = lazyView(() => import('./components/SongList.vue'))
const SongFormDialog = lazyView(() => import('./components/SongFormDialog.vue'))
const WatchView = lazyView(() => import('./components/WatchView.vue'))
const FullscreenPlayer = lazyView(() => import('./components/FullscreenPlayer.vue'))
const RemoteController = lazyView(() => import('./components/RemoteController.vue'))
const DownloadsPanel = lazyView(() => import('./components/DownloadsPanel.vue'))
const SettingsPanel = lazyView(() => import('./components/SettingsPanel.vue'))

export default {
  name: 'App',
  components: {
    TopNavigation,
    PlaylistPanel,
    PlaylistGrid,
    HomeFeed,
    SongList,
    SongFormDialog,
    WatchView,
    FeedbackHost,
    BottomPlayer,
    FullscreenPlayer,
    RemoteController,
    DownloadsPanel,
    SettingsPanel,
    AuthGate,
    PixelIcon
  },
  setup() {
    // 同步写钩尽早挂（src/lib/sync.js）：initSync 在 onMounted 尾才注册，
    // 之前的白名单写（loadDefaultPlaylists/分享导入/恢复路径）会被引擎
    // 未就绪闸接住——钩内只进 pending 集，initSync 完成时统一回放记脏
    attachWriteHook()
    // 响应式数据
    const searchQuery = ref('')
    const loading = ref(false)
    const showVipSongs = ref(true) // 控制VIP歌曲显示，默认显示
    // watch 播放页：右栏 tab（待播/歌词/相关）与 YTM UP NEXT 自动播放开关。
    // tab 记忆进 localStorage——刷新回到上次停留的面板（脏值/越界键回落 queue）
    const WATCH_TABS = ['queue', 'lyrics', 'related']
    const savedWatchTab = readJSON(LS_KEYS.WATCH_TAB)
    const watchTab = ref(WATCH_TABS.includes(savedWatchTab) ? savedWatchTab : 'queue')
    // 远端应用窗（prefs.js remoteApplying 同型）：远端落盘后回填 ref 带起
    // 的 watcher 写盘要跳过——远端非法 tab 回落 queue 是本机口径降级，写回
    // LS 会被记脏推上去，等于本机拿新戳把远端新版数据降级；LS 原文保持，
    // 重启读回同口径归一（与 theme.js「不回写」同口径）
    let watchTabRemoteApplying = false
    watch(watchTab, t => { if (!watchTabRemoteApplying) writeJSON(LS_KEYS.WATCH_TAB, t) })
    // 多端同步：远端 doc 落 LS 后按 key 回本。watchTab 越界值回落 queue
    // ——与初始读同口径。关窗 nextTick 必须挂在 ref 赋值**之后**：watcher 是
    // pre-flush 任务，ref 一变才入队；若先挂 nextTick 再改 ref，关窗回调会
    // 排在 watcher job 前面跑，窗口提前关上，降级值照样被回写推回去
    onRemoteApply(LS_KEYS.WATCH_TAB, () => {
      watchTabRemoteApplying = true
      const t = readJSON(LS_KEYS.WATCH_TAB)
      watchTab.value = WATCH_TABS.includes(t) ? t : 'queue'
      void nextTick(() => { watchTabRemoteApplying = false })
    })
    // 建号略过标记跨端跟随（auth-state.js 裸写不经钩，拉取侧照常能落地）
    onRemoteApply(LS_KEYS.SETUP_DISMISSED, () => {
      try { authState.setupDismissed = localStorage.getItem(LS_KEYS.SETUP_DISMISSED) === '1' } catch { /* 隐私模式 */ }
    })
    // 对称地：运行时 dismissSetup() 的裸 setItem 也绕过写钩——补脏随下趟推出
    watch(() => authState.setupDismissed, v => { if (v) markDirty(LS_KEYS.SETUP_DISMISSED) })
    const playingPlaylistId = ref(null) // 快照所属歌单 id——持久化恢复用它而非浏览态 id
    const fullscreenLyricMode = ref('original')
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
      savePlaylistsToStorage, loadPlaylistsFromStorage,
      addPlaylistToLibrary, removePlaylistFromLibrary, handlePlaylistDownloadsDeleted,
      collectSelectedPlaylist, selectedPlaylistInLibrary,
      selectPlaylist, appendSongToLibraryPlaylist, removeSongFromPlaylist, applyTrackEdit, syncPlaylist,
      moveSongInPlaylist, groupSongsByArtist,
      loadDefaultPlaylists,
      createPlaylistOpen, createPlaylistName, createPlaylistInput,
      openCreatePlaylist, closeCreatePlaylist, createLocalPlaylist,
    } = usePlaylistLibrary({ gates, playingPlaylistId, loading })

    // 新建空白歌单提交：建库对象 → 直接打开（空态与「添加歌曲」入口即见，
    // YTM 建单即落的同款行为）。selectPlaylistAndShow 处理 view 切换/导航栈
    const submitCreatePlaylist = async () => {
      const pl = createLocalPlaylist(createPlaylistName.value)
      if (!pl) return // 空名静默——与 atp 新建行同律（disabled 态已表达）
      closeCreatePlaylist()
      toast(`已创建歌单《${pl.name}》`, 'success')
      await selectPlaylistAndShow(pl)
    }

    // ── 歌曲表单域：SongFormDialog 的 open/close/submit 编排 ──
    // 双模：song=null → 从 0 新建（点歌台「新建歌曲」入口进来，落到当前单）；
    // song=对象 → 编辑（file_ 曲可换源文件；其他曲只改元数据）。
    // 上传编排在这层而非组件内——组件只管表单，资产上送/落库是域职责
    const songFormOpen = ref(false)
    const songFormSong = ref(null)
    const songFormBusy = ref(false)
    let songFormPrevFocus = null

    const openSongForm = (song = null, returnFocus = null) => {
      if (songFormOpen.value) return
      // busy 也挡：关窗不中止在途 submit（async 还在跑），此时重开会让旧
      // submit 的成功路径 closeSongForm() 误杀新窗、finally 吞新 abort 句柄。
      // 静默 return 不行——用户点了没反应比报错更糟
      if (songFormBusy.value) { toast('有上传处理中，请稍候', 'info'); return }
      // 焦点锚三条路：菜单路径 emit 带的 ⋯键 ＞ 点歌台路径的 hero「添加歌曲」
      // 键（pickerPrevFocus）＞ 兜底 activeElement。两条直达路径的触发元素
      // （menuitem/创建键）随后都随弹层卸载——抓它们等于没抓
      songFormPrevFocus = returnFocus
        || (songPickerOpen.value ? getPickerPrevFocus() : null)
        || document.activeElement
      // 互斥收口：四窗无叠加态
      addTargetSong.value = null
      closeSongPicker()
      closeCreatePlaylist()
      songFormSong.value = song
      songFormOpen.value = true
    }

    const closeSongForm = () => {
      // busy 期关窗连坐在途上传——否则 async submit 成僵尸（写对单但 toast
      // 落在切走的视图上+中止通道消失）。abort 幂等：已在 abort 路径再来无碍
      if (songFormBusy.value) abortSongFormUpload()
      songFormOpen.value = false
      songFormSong.value = null
    }

    // 歌单被切走/置空时收口（picker 在 useAddToPlaylist 有同款 watcher）——
    // 不关的话提交按「切换后的 selectedPlaylist」写错单的 trackOverrides。
    // 按 id 判切单：selectPlaylist 完成后 selectedPlaylist 同 id 重赋值
    // （merged 新引用），按引用比对会把开着表单的窗误杀
    watch(selectedPlaylist, (v, prev) => {
      if (songFormOpen.value && String(v?.id) !== String(prev?.id)) {
        // closeSongForm 内建 busy→abort（与互斥 handler 的裸关窗同一条收路径）
        closeSongForm()
      }
    })

    // atp/create/picker 三姊妹弹层的遮罩闸——同 SongFormDialog 三点自证
    // （down/up/click 全落遮罩才算主动关；「按在遮罩拖回弹窗」不许误关）。
    // 互斥不变量保证同时只有一扇窗，共享 state 够用
    let overlayDownSelf = false
    let overlayUpSelf = false
    const onOverlayDown = (e) => { overlayDownSelf = e.target === e.currentTarget }
    const onOverlayUp = (e) => { overlayUpSelf = e.target === e.currentTarget }
    const overlayDismiss = (onClose) => (e) => {
      const ok = overlayDownSelf && overlayUpSelf && e.target === e.currentTarget
      overlayDownSelf = overlayUpSelf = false
      if (ok) onClose()
    }
    const onAtpOverlayClick = overlayDismiss(() => { addTargetSong.value = null })
    const onCreateOverlayClick = overlayDismiss(() => closeCreatePlaylist())
    const onPickerOverlayClick = overlayDismiss(() => closeSongPicker())

    // aria-modal 契约：Tab/Shift+Tab 把焦点钳在窗内首尾互跳（共享实现
    // lib/focus-trap.js——SongFormDialog/确认框同源）。Esc 不接：走
    // onGlobalKeydown 的四窗冻结链，语义比窗内自收更全（busy→abort 等）
    const onDialogTrapKeydown = (e) => trapTabKeydown(e)

    // 焦点归还：rAF（本帧渲染 patch 全落地后）+ 可见性门槛——同三窗不变量
    watch(songFormOpen, (open) => {
      if (open) return
      const el = songFormPrevFocus
      songFormPrevFocus = null
      if (!el?.focus) return
      requestAnimationFrame(() => {
        if (typeof el.checkVisibility === 'function'
            && !el.checkVisibility({ visibilityProperty: true })) return
        el.focus({ preventScroll: true })
      })
    })

    // create：逐个上传拿 songId（音频先行——它决定 songId 归属）→ 组装 file_ 曲落单
    // edit file_：同 songId 复传=服务端换源语义 → 就地改元数据 + file 位更新
    // edit 其他曲：纯元数据——远端成员走 trackOverrides，本地成员就地+custom
    // 新建入口显隐与 submit 目标校验同源——壳单（single_song_/saved_queue_）
    // 与未收藏远端单都不是创建位，入口直接不亮（而不是点了才报错）
    const canCreateLocalSong = computed(() => {
      const pl = selectedPlaylist.value
      return !!pl && !isEphemeralPlaylistId(pl.id)
        && (isLocalPlaylistId(pl.id) || selectedPlaylistInLibrary.value)
    })

    // 在途上传的 abort 句柄——「中止上传」键/Esc(busy) 走它断 xhr
    let songFormAbort = null
    const abortSongFormUpload = () => songFormAbort?.()
    const runUpload = (args) => {
      const up = uploadFile(args)
      songFormAbort = up.abort
      return up.promise.finally(() => { if (songFormAbort === up.abort) songFormAbort = null })
    }

    const submitSongForm = async ({ song, meta, files, setProgress, setError }) => {
      // 自重入闸：组件 props.busy 经调度器异步刷新，同 tick 双击可穿组件内闸
      if (songFormBusy.value) return
      songFormBusy.value = true
      let createdSongId = null
      // 目标单按提交时刻锁定——上传可能跑数秒，期间切单（watcher 关窗但
      // async 继续跑）后读 selectedPlaylist 会把编辑写进新歌单的 overrides
      const submitPlId = selectedPlaylist.value?.id
      // filePatch 提出 try 块：edit 中途失败/中止时已传完的 kind 服务端已换源，
      // catch 里要把已成功的位照样应用（file 位与盘上漂移 = 换的封面永不显示）
      const filePatch = {}
      try {
        const KIND_ORDER = ['audio', 'video', 'cover', 'lyrics']
        if (!song) {
          const pl = selectedPlaylist.value
          // 目标=当前打开的歌单：local_pl_ 直接落 tracks；远端单走 addedTracks
          // 追加位（file 块已进持久化白名单）。闸与 asp-row--create 显隐同源
          if (!canCreateLocalSong.value) {
            toast('请先打开一个本地歌单或已收藏歌单再新建歌曲', 'error')
            return
          }
          // songId 客户端预生成（服务端认 FILE_TRACK_ID_RE 形态）：首个上传
          // 「服务端已登记行但响应被 abort/断网截断」的窗口里 createdSongId 必须
          // 已持真值——等响应才赋值那窗会漏掉孤儿行的回滚
          const songId = `file_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`
          createdSongId = songId
          const uploaded = {}
          for (const kind of KIND_ORDER) {
            const f = files[kind]
            if (!f) continue
            await runUpload({ kind, file: f, songId, onProgress: v => setProgress(kind, v) })
            uploaded[kind] = true
          }
          const track = {
            id: songId,
            name: meta.name,
            ar: [{ name: meta.artist || '未知艺术家' }],
            al: { name: meta.album || '' },
            dt: meta.durationMs || 0,
            custom: true,
            file: {
              hasAudio: !!uploaded.audio, // video-only 曲此位 false——音频位不该谎称「已有」
              hasVideo: !!uploaded.video,
              hasCover: !!uploaded.cover,
              hasLyrics: !!uploaded.lyrics,
              // 封面版本戳：img 缓存按 URL 键，换源不戳 URL 视图滞留旧图
              ...(uploaded.cover ? { coverV: Date.now() } : {}),
            },
          }
          // 必须传库对象而非 selectedPlaylist 快照——远端单的快照写了不落库
          //（addPickedSong 同款先解库对象再追加）
          const libPl = userPlaylists.value.find(p => String(p.id) === String(pl.id))
          const res = libPl && appendSongToLibraryPlaylist(libPl, track)
          // 早退也要回滚已传资产（理论难撞 exists，但库对象窗口期消失可达）——
          // 留着就是 uploads/ 下无收割者的孤儿文件
          if (res === 'exists') {
            if (createdSongId) deleteUploadedSong(createdSongId).catch(() => {})
            toast('该曲目已在歌单中', 'info'); return
          }
          if (!res) {
            if (createdSongId) deleteUploadedSong(createdSongId).catch(() => {})
            toast('歌单入库失败，无法添加', 'error'); return
          }
          toast(`已添加《${track.name}》`, 'success')
        } else {
          const sid = song.id
          if (isFileTrackId(sid)) {
            for (const kind of KIND_ORDER) {
              const f = files[kind]
              if (!f) continue
              await runUpload({ kind, file: f, songId: sid, onProgress: v => setProgress(kind, v) })
              if (kind === 'audio') filePatch.hasAudio = true
              // videoV/coverV 版本戳：<video>/<img> 按 URL 键缓存，同 URL 换源不重载
              if (kind === 'video') { filePatch.hasVideo = true; filePatch.videoV = Date.now() }
              if (kind === 'cover') { filePatch.hasCover = true; filePatch.coverV = Date.now() }
              if (kind === 'lyrics') filePatch.hasLyrics = true
            }
            // 正在播的曲换了词文件：主动热重载（切歌路径的 loadLyrics 不触发，
            // 词源变了但 song.id 没变）
            if (files.lyrics && String(currentSong.value?.id) === String(sid)) {
              reloadLyrics()
            }
          }
          // 未入库的歌单（未收藏远端单）没有可持久化的落点——applyTrackEdit
          // 静默 miss 不能配「已保存」的 toast，明说让用户先收藏
          if (!submitPlId || !applyTrackEdit(submitPlId, sid, meta, Object.keys(filePatch).length ? filePatch : null)) {
            toast('歌单未入库，编辑无法持久保存——请先收藏该歌单', 'error')
            return
          }
          toast(`已保存《${meta.name}》`, 'success')
        }
        closeSongForm()
      } catch (e) {
        // create 中途失败：首个上传已建了登记行+工件——留着就是隐形孤儿资产
        //（reapOrphanFiles 只扫数字目录够不到 uploads/），回滚删掉
        if (!song && createdSongId) {
          deleteUploadedSong(createdSongId).catch(() => {})
        }
        // edit 中途失败/中止：已传完的 kind 服务端已换源（事实先行），
        // filePatch 不落库的话 file 位与盘上漂移——把已成功的位照样应用
        if (song && isFileTrackId(song.id) && submitPlId && Object.keys(filePatch).length) {
          try { applyTrackEdit(submitPlId, song.id, {}, filePatch) } catch { /* 落库失败不再级联 */ }
        }
        const msg = e?.message || '保存失败'
        // 错误钉回表单（窗还活着时——abort 场景窗可能已被切单 watcher 关了）
        if (e?.message !== '已取消') setError?.(msg)
        toast(e?.message === '已取消' ? '已取消上传' : msg, e?.message === '已取消' ? 'info' : 'error')
      } finally {
        songFormBusy.value = false
        songFormAbort = null
      }
    }

    // file_ 曲从歌单移除时追问是否删资产——曲删了文件还在盘上挂着
    //（uploads 伪歌单的登记行不归歌单生命周期管）。在其他歌单仍被引用的
    // 曲不删资产（登记行是按 songId 的，一删全灭）
    const fileTrackRefCount = (songId) => {
      const inLists = userPlaylists.value.reduce((n, pl) => {
        const inTracks = pl.tracks?.some(t => String(t.id) === String(songId))
        const inAdded = pl.addedTracks?.some(t => String(t.id) === String(songId))
        return n + (inTracks || inAdded ? 1 : 0)
      }, 0)
      // 播放队列/历史里的 file_ 也算活引用——曲还在播/可点回就把资产删了必 404
      const inQueue = playingSongs.value?.some(t => String(t.id) === String(songId)) ? 1 : 0
      const inHistory = playHistory.value?.some(t => String(t.id) === String(songId)) ? 1 : 0
      return inLists + inQueue + inHistory
    }

    const handleRemoveSongFromPlaylist = async (song) => {
      const wasFile = isFileTrackId(song?.id)
      // 未入库预览单/无效输入被拒（false）——曲还在单里，不追问删资产
      if (removeSongFromPlaylist(song) === false) return
      // 移除后全库零引用才追问删资产——登记行按 songId，一删所有歌单都断源
      if (!wasFile || fileTrackRefCount(song.id) > 0) return
      if (!await pixelConfirm(`「${song.name}」已不再被任何歌单引用。连服务器上的文件（音频/视频/歌词/封面）一起删掉吗？`, { confirmText: '删除文件', danger: true })) return
      await deleteUploadedSong(song.id)
        .then(() => toast('已删除服务器上的文件', 'success'))
        .catch(e => toast(e?.message || '删除文件失败', 'error'))
    }

    // 整单删除后清扫孤儿 file_ 资产：单没了登记行/文件还挂在 uploads 伪歌单
    //（reapOrphanFiles 够不到 uploads/）——先在删前快照本单的 file_ 引用，
    // 删后全库零引用的才追问（仍在别单/队列里的不删）
    const handleRemovePlaylist = async (playlistId) => {
      const pl = userPlaylists.value.find(p => String(p.id) === String(playlistId))
      const fileIds = new Set()
      for (const t of pl?.tracks || []) if (isFileTrackId(t?.id)) fileIds.add(String(t.id))
      for (const t of pl?.addedTracks || []) if (isFileTrackId(t?.id)) fileIds.add(String(t.id))
      removePlaylistFromLibrary(playlistId)
      const orphans = [...fileIds].filter(id => fileTrackRefCount(id) === 0)
      if (!orphans.length) return
      if (!await pixelConfirm(`歌单已删除。其中 ${orphans.length} 个本地上传曲目的服务器文件（音频/视频/歌词/封面）要一起删掉吗？`, { confirmText: '删除文件', danger: true })) return
      let ok = 0, failed = 0
      for (const id of orphans) await deleteUploadedSong(id).then(() => { ok++ }).catch(() => { failed++ })
      // 成败分报——全吞再报「已删除」是破坏性操作谎报（在途 409/限流 429 都可能）
      toast(
        failed ? `已删除 ${ok} 个文件，${failed} 个失败（可能在传输中或被限流）` : '已删除服务器上的文件',
        failed ? 'error' : 'success'
      )
    }


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
      lyrics, currentLyricIndex, lyricOffsetMs, loadingLyrics, lyricFetching,
      adjustLyricOffset, resetLyricOffset, reloadLyrics,
      manualFetchLyrics, alignCurrentLyrics,
      songDownloading, downloadCurrentSong,
      playbackList, currentPlayingIndex, toggleShuffle,
      queueJump, queueRemove, queueMove, clearQueue,
      playNextInQueue, addToQueueEnd, saveQueueAsPlaylist, openQueueSource,
      playSong, playPlaylist, playPlaylistFromSidebar, playSongFromSearch,
      playSongFromRelated,
      togglePlay, togglePlayMode, getPlayModeText,
      previousSong, nextSong, seekTo, seekBy, updateVolume, toggleMute,
      openFullscreenPlayer, closeFullscreenPlayer,
      savePlayerStateToStorage, loadPlayerStateFromStorage,
      restoreUiState, restorePlaybackState, setPlayerPersistSuspended,
      setupMediaSessionHandlers, teardownMediaSession, getHowl,
    } = usePlayer({
      gates,
      playingPlaylistId,
      userPlaylists, selectedPlaylist,
      selectPlaylist, savePlaylistsToStorage,
      filteredSongs,
      showVipSongs, fullscreenLyricMode,
      recordPlayHistory, recordPlaylistHistory,
      // nav 域（useSearchNav）实例化在本 composable 之后——全部惰性转发
      enterWatch: () => enterWatch(),
      openWatchSong: (s) => openWatchSong(s),
      selectPlaylistAndShow: (p, o) => selectPlaylistAndShow(p, o),
      setSidebarOpen: (v) => { sidebarOpen.value = v },
      getSearchSongResults: () => searchSongResults.value,
    })

    // 导航+搜索域（composables/useSearchNav.js）：URL 可寻址视图/history 栈、
    // 顶栏双区搜索与单曲深挖、id 预览、watch 页进出。playSong 族惰性转发——
    // 与 player→nav 反向注入（上）同型，实例化顺序无关的防御写法
    const {
      centerView, sidebarOpen, searching,
      searchResults, searchSongResults,
      searchSongTotal, searchSongHasMore, searchSongLoadingMore,
      applyUrlNav, normalizeNavEntry,
      navHome, closeSearchView, toggleCenterView, toggleSettings, watchBack,
      downloadsPl, downloadsPlSeq, openDownloadsForPlaylist, clearDownloadsPl,
      enterWatch, openWatchPanel,
      selectPlaylistAndShow, openSearchPlaylist, openShelfPlaylist,
      previewPlaylistById,
      openWatchSong, openWatchSearchSong, openWatchRecent, playPlaylistAndWatch,
      handlePlaylistSearch, handleQQSongSearch, handleYTSongSearch, handleBiliSongSearch,
      loadMoreSearchSongs,
    } = useSearchNav({
      gates,
      searchQuery, currentSong, watchTab, isFullscreenPlayerOpen,
      userPlaylists, selectedPlaylist, loadingSongs, selectPlaylist,
      savePlaylistsToStorage,
      playSong: (s, o) => playSong(s, o),
      playSongFromSearch: (s) => playSongFromSearch(s),
      playSongFromRelated: (s, l) => playSongFromRelated(s, l),
      playPlaylist: (sh) => playPlaylist(sh),
    })

    // Watch 沉浸舞台令牌层（style.css :root[data-stage="watch"]）：挂在
    // <html> 上才能让 teleport 到 body 的菜单/对话框/toast 同走舞台令牌；
    // 离场与卸载都摘除——页面之外是 print-grid 世界
    watch(centerView, (v) => {
      if (v === 'watch') document.documentElement.dataset.stage = 'watch'
      else delete document.documentElement.dataset.stage
    }, { immediate: true })
    onBeforeUnmount(() => { delete document.documentElement.dataset.stage })

    // watch 顶行「下载」键的已下载态：探测挂在 App 侧而非 usePlayer——
    // 播放链的本地档探测在 usePlayer 内部有严格的调用序契约（同曲连点/
    // 兜底链各代精确计次），不往里塞第二路同端点调用。这里只在 watch
    // 页可见时随换曲/进页探一次，寻址口径与播放探测同（audioReady 跨歌单
    // 命中也算下过——重复提交只会撞 409/幂等短路）。file_ 曲不探：资产
    // 本就在服务端（按钮也不亮）；下载动作落地后复探归真值
    const songDownloaded = ref(false)
    let dlStatusProbeSeq = 0
    const probeSongDownloaded = async () => {
      const seq = ++dlStatusProbeSeq
      songDownloaded.value = false
      const song = currentSong.value
      if (!song || isFileTrackId(song.id) || !isResolvableTrackId(song.id)) return
      const plHint = playingPlaylistId.value || selectedPlaylist.value?.id || null
      const st = await downloadsApi.getSongDownloadStatus(plHint, song.id).catch(() => null)
      if (seq !== dlStatusProbeSeq) return
      songDownloaded.value = !!(st?.data?.downloaded === true || st?.data?.audioReady === true)
    }
    watch([() => currentSong.value?.id, centerView], () => {
      if (centerView.value === 'watch') probeSongDownloaded()
    })
    const onWatchDownloadSong = async () => {
      await downloadCurrentSong()
      probeSongDownloaded() // 幂等短路/轮询完成/失败都归探测真值
    }

    // 外部导入域（composables/useExternalImport.js）：单曲 resolve 导入 / 三源整单导入 /
    // mix 内容分享导入 / 网易云单曲壳。跨域回调沿用惰性转发惯例（顺序无关）
    const {
      importQQ,
      importBilibiliOrFav, importYouTubeOrPlaylist,
      importQQPlaylist,
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
      getPickerPrevFocus,
    } = useAddToPlaylist({
      gates,
      userPlaylists, selectedPlaylist, songs,
      addPlaylistToLibrary, appendSongToLibraryPlaylist, createLocalPlaylist,
      closeCreatePlaylist,
    })

    // 侧栏「+」开新建弹窗：跨域互斥收口——atp/点歌台/歌曲表单若因 Tab 逃逸还开着，
    // 先收掉再开（双层模态时 Esc 会关掉看不见的底层窗——顺序与视觉堆叠相反）
    const handleOpenCreatePlaylist = () => {
      addTargetSong.value = null
      closeSongPicker()
      closeSongForm()
      openCreatePlaylist()
    }

    // 点歌台同款互斥收口（模板唯一入口——裸 openSongPicker 不再直绑）
    const handleOpenSongPicker = () => {
      addTargetSong.value = null
      closeCreatePlaylist()
      closeSongForm()
      openSongPicker()
    }

    // atp 同款（行菜单「添加到歌单」/队列面板等三处 emit 共用此口）。
    // 第二参 trigger 是行 ⋯ 菜单捎来的归还锚（edit-song→openSongForm 同款
    // 传参形）；PlaylistGrid/WatchView 直达键 emit 无此参——缺省回落
    // activeElement 由 openAddToPlaylist 兜底
    const handleOpenAddToPlaylist = (song, trigger = null) => {
      if (!song) return // 无效曲不误关其他窗（与 openSongPicker 同律）
      closeSongPicker()
      closeCreatePlaylist()
      closeSongForm()
      openAddToPlaylist(song, trigger)
    }

    // 远程控制：host 模式 state_update 广播 + 指令执行 + 断线重连（composables/
    // useRemoteControl.js）。必须放在 usePlayer 之后实例化——依赖全部来自播放器域；
    // 模式判定要在播放器初始化前生效——controller 分支在下方 init 里提前 return
    const { remoteMode, remoteControllerWsUrl, remoteWsProtocols, connectRemoteHost, disconnectRemoteHost } = useRemoteControl({
      getHowl,
      isPlaying, currentSong, currentTime, duration, volume,
      playingSongs, songSwitching, filteredSongs,
      playSong, nextSong, previousSong, updateVolume, currentPlayingIndex, playbackList
    })
    // 控制器页首屏：mode 在 useRemoteControl 内同步定出——此处立即并发拉
    // chunk，不等 auth 探活 RTT（否则首帧=auth RTT+chunk RTT 串行相加）；
    // 与 lazyView 的 loader 同源 import，模块表去重不重复拉取
    if (remoteMode.value === 'controller') {
      import('./components/RemoteController.vue').catch(() => {})
    }

    // 会话过期弹门清场（F2）：http.js 401 → authState.expired → AuthGate 接管、
    // .app-shell 卸载——但 usePlayer/useRemoteControl 挂在 App 根作用域不随壳
    // 卸载：音频续播、remote WS 继续收发指令、锁屏 MediaSession/全局热键仍控
    // 播放、悬挂的 pixelConfirm 永不结算。门起即全部收掉；
    // 重新登录走 @authed 整页 reload，无需恢复路径
    watch(() => authRequired(), (required) => {
      if (!required) return
      const h = getHowl()
      // 无条件 pause（含 loading 态）：isPlaying=false 的加载中 Howl 若漏闸，
      // 其 onload 的 autoplay 分支会在门后出声；对已停实例 pause 是 no-op，
      // 重新登录本就整页 reload，无需恢复路径
      if (h) h.pause() // 暂停而非销毁——门后不留声
      disconnectRemoteHost()
      teardownMediaSession()
      resolveConfirm(false) // 无悬挂框是 no-op；有则按「取消」结算不悬挂
    })

    // 键盘快捷键（YTM 式）：空格播放暂停、←→ 进退、↑↓ 音量、M 静音、
    // F 全屏、Q 待播队列、/ 聚焦搜索；输入态/修饰键组合全部放行
    const onGlobalKeydown = (e) => {
      // 弹门期壳已卸载——热键不得在门后控播放（F2 同一场景的窗口侧闸）
      if (authRequired()) return
      // 确认框未决时全局快捷键全部冻结（/ 偷焦点会破焦点陷阱，F 会在遮罩下隐形切全屏）
      if (isConfirmOpen()) {
        // 兜底：焦点逃出 overlay 时仍能关。Esc 消费一律 preventDefault 打戳——
        // 后注册的 window 监听（沉浸层 handleKeydown 等）见 defaultPrevented
        // 让位，保证同一发按键只结算一层，不一键双关
        if (e.key === 'Escape') { e.preventDefault(); resolveConfirm(false) }
        return
      }
      // 四弹窗冻结：互斥本无叠加态，但防线按堆叠序顶层优先
      //（模板序 atp < create < picker < songForm——万一叠加，Esc 先关看得见的）
      if (songFormOpen.value) {
        // busy 期 Esc 映射到中止上传——大文件在飞时 Escape 的直觉就是「停」
        if (e.key === 'Escape') { e.preventDefault(); songFormBusy.value ? abortSongFormUpload() : closeSongForm() }
        return
      }
      // 点歌台模态冻结。Esc 连框内焦点也收（输入态下 Esc 的直觉就是关窗）；
      // 非 Esc 键直接 return——空格/斜杠不会穿透到全局快捷键
      if (songPickerOpen.value) {
        if (e.key === 'Escape') { e.preventDefault(); closeSongPicker() }
        return
      }
      // 新建歌单模态同款冻结
      if (createPlaylistOpen.value) {
        if (e.key === 'Escape') { e.preventDefault(); closeCreatePlaylist() }
        return
      }
      // 添加到歌单模态同款冻结——否则 Tab 到框外后 /、f、空格全部穿透生效
      if (addTargetSong.value) {
        if (e.key === 'Escape') { e.preventDefault(); addTargetSong.value = null }
        return
      }
      if (e.key === 'Escape') {
        // 真收了侧栏才打戳——无可收层时 Esc 不打戳放行，沉浸层照常结算
        if (sidebarOpen.value) { e.preventDefault(); sidebarOpen.value = false }
        return
      }
      const el = e.target
      if (e.defaultPrevented) return // 组件已处理（如 role=button 行的 space.prevent）
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable
        || el.closest?.('[role="menu"]'))) return // 菜单内焦点：↑↓/字母键属于菜单语义，不穿透全局热键
      if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return
      switch (e.key) {
        case ' ':
          // 焦点在原生按钮/role=button/链接上时空格属于它自己的激活语义，不抢
          if (el?.tagName === 'BUTTON' || el?.closest?.('[role="button"], [role="tab"], [role="menuitem"], [role="option"], a[href]')) return
          e.preventDefault() // 阻止页面滚动
          if (e.repeat) return // 长按连打会以 repeat 速率反复 toggle（f/q 同款闸）
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
          if (e.repeat) return // 与空格同律：长按不反复 toggle
          togglePlay()
          break
        case 'j': case 'J':
          seekBy(-10) // YTM：j/l = ±10s
          break
        case 'l': case 'L':
          seekBy(10)
          break
        case 'm': case 'M':
          if (e.repeat) return // 同 toggle 类键：长按反复静音/取消爆音
          toggleMute()
          break
        case 'f': case 'F':
          // 元素级全屏（watch 视频）激活中：沉浸层是 top layer 之下的 Vue
          // overlay——开着完全不可见，退出视频全屏后落在沉浸式层是事故。
          // e.repeat 闸：按住连打会以 repeat 速率反复开闭，每次关→开都让
          // watch 视频卸载重挂（白烧流地址解析，限流是 60/min 量级）
          if (currentSong.value && !e.repeat
            && !(document.fullscreenElement || document.webkitFullscreenElement)) {
            isFullscreenPlayerOpen.value = !isFullscreenPlayerOpen.value
          }
          break
        case 'q': case 'Q':
          // 元素全屏期间禁导航——在 top layer 下隐形拆页（watchBack 会
          // 卸载 WatchView 顺带退全屏）；沉浸层开着同理——遮罩下换视图
          // 用户看不见，关层落在意外页面。e.repeat 闸：同 tab 开合语义下
          // 连打=反复进出 watch 页（视频重解流地址+history 栈灌水）
          if (currentSong.value && !e.repeat && !isFullscreenPlayerOpen.value
            && !(document.fullscreenElement || document.webkitFullscreenElement)) {
            openWatchPanel('queue')
          }
          break
        case '/':
          e.preventDefault()
          // 沉浸层/元素全屏开着时搜索框在遮罩下不可见——接焦后 INPUT 守卫
          // 吞掉全部热键且零视觉反馈，是比"没反应"更糟的静默失能
          if (!isFullscreenPlayerOpen.value
            && !(document.fullscreenElement || document.webkitFullscreenElement)) {
            topNavRef.value?.focusSearch()
          }
          break
      }
    }
    window.addEventListener('keydown', onGlobalKeydown)

    watch([
      showVipSongs,
      isFullscreenPlayerOpen,
      fullscreenLyricMode
    ], () => {
      savePlayerStateToStorage()
    })

    // 登录/建号成功：cookie 已落盘，整页重载以干净状态重走 onMounted 管线
    const onAuthed = () => window.location.reload()

    // 完整初始化链（F1）：onMounted 与「暂不设置」补跑共用同一份——
    // appInited 一次性闸让两路不重入（登录成功是整页 reload 不经过这里）
    let appInited = false
    const initApp = async () => {
      if (appInited) return
      appInited = true

      // 遥控器模式：不初始化播放器/歌单/播放状态恢复，纯控制端
      if (remoteMode.value === 'controller') return

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
      // 恢复窗口内禁持久化——restoreUiState/分享导入会触发 prefs watcher
      // 冲刷写盘，此刻 currentSong 还是 null，会把存档续播点抹成 0
      setPlayerPersistSuspended(true)
      try {
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
          await importNeteaseSongById(share.songId)
        } else if (restorePlayerState) {
          await restorePlaybackState(restorePlayerState)
        }
      } finally {
        setPlayerPersistSuspended(false)
      }

      // 恢复路径失败（歌单被删/网络抖动）时不落盘：否则会拿全空状态覆盖掉
      // 存档里仍可用的续播点。无恢复存档时正常写入初始态
      if (!restorePlayerState || currentSong.value) {
        savePlayerStateToStorage()
      }

      // URL 导航意图最后生效：view/pl 参数压在恢复逻辑之上（用户显式给的地址优先）
      applyUrlNav()
      normalizeNavEntry()

      // 多端同步：注册写钩 + 首趟增量拉取。放在 init 尾部——composable 内
      // 的远端应用订阅须先就位；引擎内部全静默退避，绝不阻塞本地功能
      initSync()
      void pullFromServer()

      // 热视图 chunk 闲时预取：WatchView/SongList 是点播/歌单两条主路径——
      // 浏览器空闲期把模块拉进内存表，首次导航时 defineAsyncComponent 同步
      // 命中不转圈。放初始化尾部执行，不与首屏关键请求争带宽；catch 吞掉
      // 断网/部署错配的 rejection——真 demand-load 时 lazyView 兜底重载
      const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1200))
      idle(() => {
        import('./components/WatchView.vue').catch(() => {})
        import('./components/SongList.vue').catch(() => {})
      })
    }

    onMounted(async () => {
      // 登录探活先行：需要登录而未认证时 AuthGate 接管，初始化整段押后
      // （遥控端同样被门——WS 握手也要带登录 cookie）。
      // 两条出门：@authed 整页 reload 重走全链；@skip 只翻标记留在会话内，
      // 靠下方 authRequired watcher 就地补跑同一 initApp
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
      await initApp()
    })

    // 「暂不设置」补跑（F1）：skip 只翻 setupDismissed 标记——authRequired()
    // 翻假瞬间把押后的初始化就地补上。此前壳会以未初始化状态挂载：
    // initSync 唯一调用点在 onMounted，没有任何补跑路径
    watch(() => authRequired(), (required) => {
      // initApp 的 promise 不能 void 裸丢：回调返回 undefined 后 rejection
      // 无人接会成 unhandled rejection，且 appInited 已闩不再重试——
      // 就地捕获并明示用户刷新重进（重走 onMounted 干净初始化链）
      if (!required) {
        initApp().catch((e) => {
          console.error('初始化失败:', e)
          toast('初始化失败，请刷新页面重试', 'error')
        })
      }
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
      durationWarning,
      playbackError,
      loadingLyrics,
      lyricOffsetMs,
      adjustLyricOffset,
      resetLyricOffset,
      lyricFetching,
      manualFetchLyrics,
      alignCurrentLyrics,
      songDownloading,
      songDownloaded,
      onWatchDownloadSong,
      centerView,
      sidebarOpen,
      watchTab,
      autoplayOn,
      searching,
      searchSongResults,
      searchSongTotal,
      searchSongHasMore,
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
      selectedPlaylistInLibrary,
      collectSelectedPlaylist,
      importBilibiliOrFav,
      importYouTubeOrPlaylist,
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
      handleYTSongSearch,
      handleBiliSongSearch,
      playPlaylistFromSidebar,
      playNextInQueue,
      addToQueueEnd,
      // 歌曲表单域（新建/编辑 + 上传编排）
      songFormOpen, songFormSong, songFormBusy,
      openSongForm, closeSongForm, submitSongForm, abortSongFormUpload,
      canCreateLocalSong, handleRemovePlaylist,
      onOverlayDown, onOverlayUp,
      onAtpOverlayClick, onCreateOverlayClick, onPickerOverlayClick,
      onDialogTrapKeydown,
      handleOpenSongPicker, handleOpenAddToPlaylist, handleRemoveSongFromPlaylist,
      queueJump,
      queueRemove,
      queueMove,
      clearQueue,
      saveQueueAsPlaylist,
      openWatchPanel,
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
      toggleSettings,
      downloadsPl,
      downloadsPlSeq,
      openDownloadsForPlaylist,
      clearDownloadsPl,
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
      createPlaylistOpen,
      createPlaylistName,
      createPlaylistInput,
      closeCreatePlaylist,
      submitCreatePlaylist,
      // 裸 openCreatePlaylist 不导出——唯一入口必须过 handleOpenCreatePlaylist 的互斥收口
      handleOpenCreatePlaylist,
      removeSongFromPlaylist,
      moveSongInPlaylist,
      groupSongsByArtist,
      syncPlaylist,
      httpsCover,
      coverSizeUrl
    }
  }
}
</script>
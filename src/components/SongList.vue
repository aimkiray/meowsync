<template>
  <div class="song-list-main card-songlist flex flex-col h-full min-h-0">
    <!-- 歌单页头：YTM 播放页头部（封面+元信息），未选歌单时不占位 -->
    <div v-if="selectedPlaylist" class="playlist-hero">
      <img
        v-if="selectedPlaylist.coverImgUrl"
        :src="httpsCover(selectedPlaylist.coverImgUrl)"
        :alt="selectedPlaylist.name"
        class="playlist-hero-cover"
        style="image-rendering: pixelated;"
      />
      <div v-else class="playlist-hero-cover playlist-hero-fallback text-pink-300">♪</div>
      <div class="playlist-hero-meta">
        <h2 class="playlist-hero-name">{{ selectedPlaylist.name }}</h2>
        <p class="playlist-hero-sub">
          {{ selectedPlaylist.creator?.nickname || '神秘创建者' }} · {{ selectedPlaylist.trackCount || songs.length }} 首
        </p>
        <!-- YTM hero 主按钮组：播放全部 + 随机；VIP 过滤收敛为次级开关 -->
        <div class="playlist-hero-actions">
          <button
            @click="$emit('play-all')"
            class="jirai-button-primary text-sm px-4 py-2 flex items-center gap-1"
            style="border-radius: 0;"
            title="播放全部"
          >▶ 播放</button>
          <button
            @click="$emit('play-shuffle')"
            class="jirai-button text-sm px-4 py-2"
            style="border-radius: 0;"
            title="随机播放"
          >🔀 随机</button>
          <button
            @click="$emit('toggle-vip-songs')"
            class="text-xs px-2 py-1 border transition-colors"
            :class="showVipSongs ? 'bg-pink-500 text-white border-pink-400' : 'bg-gray-700 text-gray-300 border-gray-500 hover:bg-gray-600'"
            style="border-radius: 0;"
            title="切换VIP歌曲显示"
          >
            {{ showVipSongs ? '隐藏VIP' : '显示VIP' }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="loadingSongs" class="text-center py-16">
      <div class="pixel-loading mx-auto mb-4"></div>
      <p class="text-pink-300 flex justify-center items-center">加载歌曲中喵...</p>
    </div>

    <div v-else-if="songs.length === 0" class="song-empty">
      <p class="song-empty-icon">🎵</p>
      <p class="text-gray-600">从左侧选择歌单，或在顶部搜索发现新歌单喵~</p>
    </div>

    <div v-else class="flex-1 min-h-0 overflow-y-auto song-rows">
      <div
        v-for="(song, index) in paginatedSongs"
        :key="song.id"
        class="music-card cursor-pointer p-3 jirai-card transition-all w-full relative group"
        :class="{
          'playing-song': isCurrent(song),
          'opacity-50 grayscale': isVipSong(song)
        }"
      >
        <div
          @click="$emit('play-song', song)"
          @keydown.enter="$emit('play-song', song)"
          @keydown.space.prevent="$emit('play-song', song)"
          class="flex items-center space-x-3"
          tabindex="0"
          role="button"
          :aria-label="`播放 ${song.name}`"
        >
          <!-- 曲序号：悬停时换成播放符号（YTM 行首交互） -->
          <span class="song-row-index">
            <span class="song-row-index-num">{{ (currentPage - 1) * pageSize + index + 1 }}</span>
            <span class="song-row-index-play">▶</span>
          </span>
          <div class="relative">
            <img
              v-if="song.al?.picUrl || song.album?.picUrl"
              :src="httpsCover(song.al?.picUrl || song.album?.picUrl)"
              :alt="song.name"
              class="w-12 h-12 object-cover border-2 border-pink-400"
              style="border-radius: 0; image-rendering: pixelated;"
            />
            <div
              v-else
              class="w-12 h-12 border-2 border-pink-400 flex items-center justify-center text-pink-300"
              style="border-radius: 0;"
            >♪</div>
            <div v-if="isCurrent(song) && isPlaying" class="absolute inset-0 flex items-center justify-center">
              <div class="text-pink-300 text-sm animate-pulse flex items-center justify-center">♡</div>
            </div>
          </div>
          <div class="flex-1 min-w-0">
            <h4 class="font-medium truncate flex items-center"
              :class="isCurrent(song) ? 'text-pink-500 font-bold' : 'text-pink-300'"
            >
              {{ song.name }}
              <span v-if="isVipSong(song)" class="ml-2 text-xs bg-yellow-500 text-black px-1 rounded">VIP</span>
            </h4>
            <p class="text-sm text-purple-300 truncate">
              {{ song.ar?.map(artist => artist.name).join(', ') || song.artists?.map(a => a.name).join(', ') }}
            </p>
          </div>
          <div class="text-xs text-gray-400 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
            {{ formatDuration(song.dt || song.duration) }}
          </div>
        </div>

        <!-- 操作按钮组 - 右上角：合并为 YTM 式 ⋯ 溢出菜单，悬停/聚焦时露出 -->
        <div class="absolute top-0 right-0 flex">
          <button
            class="song-menu-btn p-1 transition-all text-gray-400 hover:text-pink-300 flex items-center justify-center"
            @click.stop="toggleDownloadMenu(song.id, $event)"
            title="更多操作"
            aria-label="更多操作"
            aria-haspopup="menu"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 22 22"><path fill="currentColor" d="M10 6h2v2h-2V6zm0 4h2v2h-2v-2zm0 4h2v2h-2v-2z"/></svg>
          </button>
        </div>
      </div>

      <!-- 统计 + 分页合并为一行 -->
      <div class="song-list-footer">
        <span class="text-pink-300 text-xs">
          {{ filteredSongs.length === 0 ? 0 : (currentPage - 1) * pageSize + 1 }}-{{ Math.min(currentPage * pageSize, filteredSongs.length) }} / 共 {{ filteredSongs.length }} 首<template v-if="!showVipSongs && songs.length > filteredSongs.length">（隐藏 {{ songs.length - filteredSongs.length }} 首VIP）</template>
        </span>
        <PaginationControls
          v-if="totalPages > 1"
          :current-page="currentPage"
          :total-pages="totalPages"
          :bar-style="paginationStyle"
          @go-to-page="$emit('go-to-page', $event)"
          @prev-page="$emit('prev-page')"
          @next-page="$emit('next-page')"
        />
      </div>
    </div>

    <!-- 下载菜单 - 使用 Teleport 确保显示在外部 -->
    <Teleport to="body">
      <div
        v-if="showDownloadMenu"
        class="download-menu-overlay"
        @click="closeDownloadMenu"
      >
        <div
          class="download-menu"
          role="menu"
          :style="getMenuPosition(showDownloadMenu)"
          @click.stop
        >
          <div class="download-option download-option-header">
            {{ menuSong?.name || '歌曲操作' }}
          </div>

          <!-- YTM 行内 ⋯ 菜单：队列操作与分享/下载合一 -->
          <div
            class="download-option"
            role="menuitem"
            tabindex="0"
            @click="playNextFromMenu"
            @keydown.enter="playNextFromMenu"
            @keydown.space.prevent="playNextFromMenu"
          >
            ⏭ 下一首播放
          </div>
          <div
            class="download-option"
            role="menuitem"
            tabindex="0"
            @click="addToQueueFromMenu"
            @keydown.enter="addToQueueFromMenu"
            @keydown.space.prevent="addToQueueFromMenu"
          >
            📋 加入队列末尾
          </div>
          <div
            class="download-option"
            role="menuitem"
            tabindex="0"
            @click="shareFromMenu"
            @keydown.enter="shareFromMenu"
            @keydown.space.prevent="shareFromMenu"
          >
            🔗 分享歌曲
          </div>

          <!-- 获取源文件（浏览器下载）。菜单跨分页时 paginatedSongs 里找不到目标，必须查全量 props.songs -->
          <div
            class="download-option"
            role="menuitem"
            tabindex="0"
            @click="downloadSongDirect(menuSong, 320000)"
            @keydown.enter="downloadSongDirect(menuSong, 320000)"
            @keydown.space.prevent="downloadSongDirect(menuSong, 320000)"
          >
            📄 获取源文件 (320k)
          </div>

          <!-- 下载到服务器 / 删除已下载（临时单曲歌单没有服务端持久化意义，隐藏；
               未选歌单时选了也只会 alert，同样不渲染） -->
          <div
            v-if="!isSingleSongPlaylist && selectedPlaylist"
            class="download-option"
            role="menuitem"
            tabindex="0"
            @click="toggleServerDownload(menuSong)"
            @keydown.enter="toggleServerDownload(menuSong)"
            @keydown.space.prevent="toggleServerDownload(menuSong)"
          >
            <span v-if="serverDownloadingStates[showDownloadMenu]">⏳ 处理中...</span>
            <span v-else-if="serverDownloadedStates[showDownloadMenu]">🗑️ 删除已下载文件</span>
            <span v-else>💾 下载到服务器</span>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.song-list-main {
  padding: 16px 20px;
}

/* 歌单页头 */
.playlist-hero {
  display: flex;
  align-items: center;
  gap: 14px;
  padding-bottom: 14px;
  margin-bottom: 12px;
  border-bottom: 2px solid rgba(240, 179, 192, 0.2);
  flex-shrink: 0;
}

.playlist-hero-cover {
  width: 112px;
  height: 112px;
  object-fit: cover;
  border: 2px solid #f472b6;
  flex-shrink: 0;
}

.playlist-hero-fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 26px;
}

.playlist-hero-meta {
  flex: 1;
  min-width: 0;
}

.playlist-hero-name {
  font-size: 17px;
  font-weight: bold;
  /* 主题变量：pixel-retro 浅色底下硬编码粉 (#f9a8d4) 对比度不足 */
  color: var(--pixel-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.playlist-hero-sub {
  font-size: 12px;
  color: var(--pixel-text-dim);
  margin-top: 4px;
}

.playlist-hero-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 12px;
  align-items: center;
}

/* 行首序号：常态显示数字，悬停换 ▶（YTM 同款） */
.song-row-index {
  width: 24px;
  flex-shrink: 0;
  text-align: center;
  font-size: 12px;
  color: var(--pixel-text-dim);
  position: relative;
}

.song-row-index-play {
  display: none;
  color: var(--pixel-accent-fg, #f472b6);
}

.music-card:hover .song-row-index-num {
  display: none;
}

.music-card:hover .song-row-index-play {
  display: inline;
}

/* ⋯ 菜单键：悬停/聚焦才露出，常显时保持行面干净（键盘可达性保留 focus-visible） */
.song-menu-btn {
  opacity: 0;
}

.music-card:hover .song-menu-btn,
.song-menu-btn:focus-visible,
.music-card:focus-within .song-menu-btn {
  opacity: 1;
}

/* 触屏无 hover——隐形但可点的 ⋯ 键会误触，常显 */
@media (hover: none) {
  .song-menu-btn {
    opacity: 1;
  }
}

.song-rows {
  scrollbar-gutter: stable;
}

.song-rows > * + * {
  margin-top: 8px;
}

.song-empty {
  text-align: center;
  padding: 64px 0;
}

.song-empty-icon {
  font-size: 40px;
  margin-bottom: 12px;
}

.song-list-footer {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 10px 0;
  flex-wrap: wrap;
}

/* 下载菜单覆盖层 */
.download-menu-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: var(--z-overlay);
  background: transparent;
}

/* 下载菜单（原先引用未定义的 --bg-color/--border-color 等变量导致透明背景，直接写死像素风配色） */
.download-menu {
  position: fixed;
  background: #1a1a2e;
  border: 1px solid #c084fc;
  border-radius: 0;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
  z-index: var(--z-menu);
  min-width: 140px;
  overflow: hidden;
}

.download-option {
  padding: 10px 12px;
  cursor: pointer;
  transition: background-color 0.2s;
  font-size: 14px;
  color: #d8b4fe;
  border-bottom: 1px solid #374151;
}

.download-option:last-child {
  border-bottom: none;
}

.download-option-header {
  cursor: default;
  color: #a78bfa;
}

.download-option-header:hover {
  background: transparent;
  color: #a78bfa;
}

.download-option:hover {
  background-color: #6b21a8;
  color: #fff;
}
</style>

<script>
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { musicApi } from '../api/music.js'
import { downloadsApi } from '../api/downloads.js'
import { httpsCover } from '../lib/url'
import PaginationControls from './PaginationControls.vue'
import { useTheme } from '../composables/useTheme'
import { formatDuration } from '../lib/format'
import { isVipSong, isLocalPlaylistId } from '../lib/song'
import { shareOrCopy } from '../lib/share'
import { toast, pixelConfirm } from '../lib/feedback'

export default {
  name: 'SongList',
  components: {
    PaginationControls
  },
  props: {
    songs: {
      type: Array,
      default: () => []
    },
    currentSong: {
      type: Object,
      default: null
    },
    isPlaying: {
      type: Boolean,
      default: false
    },
    loadingSongs: {
      type: Boolean,
      default: false
    },
    showVipSongs: {
      type: Boolean,
      default: false
    },
    currentPage: {
      type: Number,
      default: 1
    },
    pageSize: {
      type: Number,
      default: 10
    },
    selectedPlaylist: {
      type: Object,
      default: null
    },
    playlistDownloadsRefreshKey: {
      type: Number,
      default: 0
    }
  },
  emits: ['play-song', 'play-all', 'play-shuffle', 'play-next', 'add-to-queue', 'toggle-vip-songs', 'go-to-page', 'prev-page', 'next-page'],
  setup(props, { emit }) {
    const { currentTheme } = useTheme()
    const showDownloadMenu = ref(null)
    const downloadingStates = ref({})
    const menuPositions = ref({})

    // 服务器下载状态
    const serverDownloadedStates = ref({})  // 是否已下载
    const serverDownloadingStates = ref({}) // 是否正在下载
    // 组件卸载标志：单曲下载轮询挂在 v-if 挂载的组件上，切到管理面板即卸载——
    // props 卸载后仍持旧值，stillCurrent 永真会让孤儿轮询空转 10min 还跨视图弹窗
    let viewDisposed = false

    // 动态样式
    const paginationStyle = computed(() => {
      if (currentTheme.value === 'pixel-retro') {
        return {
          background: 'rgba(240, 179, 192, 0.2)',
          boxShadow: 'inset 0 0 0 2px rgba(240, 179, 192, 0.4)',
          borderRadius: '0'
        }
      } else {
        return {
          background: 'rgba(255, 192, 203, 0.2)',
          boxShadow: 'inset 0 0 0 2px rgba(255, 182, 193, 0.4)',
          borderRadius: '0'
        }
      }
    })

    // 过滤后的歌曲列表（根据VIP显示设置）
    const filteredSongs = computed(() => {
      if (props.showVipSongs) {
        return props.songs // 显示所有歌曲
      } else {
        return props.songs.filter(song => !isVipSong(song)) // 隐藏VIP歌曲
      }
    })

    // 分页计算属性
    const totalPages = computed(() => {
      return Math.ceil(filteredSongs.value.length / props.pageSize)
    })

    const paginatedSongs = computed(() => {
      const start = (props.currentPage - 1) * props.pageSize
      const end = start + props.pageSize
      return filteredSongs.value.slice(start, end)
    })

    // 菜单打开的目标歌曲：从全量 songs 里查——菜单跨分页/重渲染时 paginatedSongs 已换页会拿到 undefined
    const menuSong = computed(() =>
      props.songs.find(s => String(s.id) === String(showDownloadMenu.value)) || null
    )

    // 本地内存态歌单（单曲分享/队列存盘）服务端没有对应持久行，不提供服务器下载
    const isSingleSongPlaylist = computed(() =>
      isLocalPlaylistId(props.selectedPlaylist?.id)
    )

    // 切换下载菜单显示
    const toggleDownloadMenu = (songId, event) => {
      if (showDownloadMenu.value === songId) {
        closeDownloadMenu()
      } else {
        // 切到另一首歌：旧歌的位置缓存即弃，直接删——否则 map 只增不减
        if (showDownloadMenu.value !== null) {
          delete menuPositions.value[showDownloadMenu.value]
        }
        // 计算菜单位置：下方空间不足时翻到按钮上方，左右越界时收回视口内
        const button = event.target.closest('button')
        const rect = button.getBoundingClientRect()
        const menuWidth = 140
        // 菜单高度按实际项数算：固定项=头部+下一首+队尾+分享+源文件 5 项；
        // 临时/未选歌单时"下载到服务器"项不渲染少一项（~42px/项，偏小会被裁）
        const menuHeight = (!isSingleSongPlaylist.value && props.selectedPlaylist) ? 252 : 212
        const vw = window.innerWidth
        const vh = window.innerHeight
        const belowFits = rect.bottom + 4 + menuHeight <= vh
        menuPositions.value[songId] = {
          top: (belowFits ? rect.bottom + 4 : Math.max(8, rect.top - menuHeight - 4)) + 'px',
          left: Math.max(8, Math.min(rect.right - menuWidth, vw - menuWidth - 8)) + 'px'
        }
        showDownloadMenu.value = songId
      }
    }

    // 获取菜单位置
    const getMenuPosition = (songId) => {
      return menuPositions.value[songId] || { top: '0px', left: '0px' }
    }

    // 关闭菜单：所有关闭路径收口到这里，顺带清位置缓存（只增不减会泄漏）
    const closeDownloadMenu = () => {
      if (showDownloadMenu.value !== null) {
        delete menuPositions.value[showDownloadMenu.value]
      }
      showDownloadMenu.value = null
    }

    // ⋯ 菜单操作：下一首播放 / 队尾追加 / 分享——先关菜单再派发给父组件
    const playNextFromMenu = () => {
      const song = menuSong.value
      closeDownloadMenu()
      if (song) emit('play-next', song)
    }

    const addToQueueFromMenu = () => {
      const song = menuSong.value
      closeDownloadMenu()
      if (song) emit('add-to-queue', song)
    }

    const shareFromMenu = () => {
      const song = menuSong.value
      closeDownloadMenu()
      if (song) shareSong(song)
    }

    // 分享歌曲
    const shareSong = async (song) => {
      const artistNames = song.ar?.map(artist => artist.name).join(', ') || song.artists?.map(a => a.name).join(', ') || '未知艺术家'
      // 带 view=watch：冷启动打开分享链后落在播放页（YTM watch 同款直达）
      const shareUrl = `${window.location.origin}/?song=${song.id}&view=watch`

      const result = await shareOrCopy({
        title: `🎵 ${song.name} - ${artistNames}`,
        text: `来听听这首歌：${song.name} - ${artistNames}`,
        url: shareUrl
      })
      if (result === 'copied') toast('分享链接已复制到剪贴板', 'success')
      else if (result === 'failed') toast('分享失败，请手动复制链接', 'error')
    }

    // 服务端错误统一返回 { code, message }，优先取 message 展示
    const extractErrorMessage = (error) => {
      return error.response?.data?.message || error.message
    }

    // 直接下载（浏览器下载，最高码率）
    const downloadSongDirect = async (song, bitrate = 320000) => {
      if (!song) {
        // 菜单目标已不在当前歌单（翻页/换单后残留）——关菜单而不是静默无效
        closeDownloadMenu()
        return
      }
      // 点击即关菜单：直接下载要等整个 fetch+blob（可能数十秒），
      // 留着透明 overlay 罩全屏会阻塞一切点击
      closeDownloadMenu()
      try {
        downloadingStates.value[song.id] = true
        await musicApi.downloadSong(song, bitrate)
      } catch (error) {
        console.error('下载失败:', error)
        toast('下载失败: ' + extractErrorMessage(error), 'error')
      } finally {
        downloadingStates.value[song.id] = false
      }
    }

    // 批量查询所有歌曲的下载状态：一次 listTasks 拉回该歌单全部任务本地映射，
    // 避免逐曲 N+1 请求（歌单未导入时服务端返回空数组，天然无副作用）
    // 请求序号守卫：切歌单时旧歌单的 in-flight 响应不能写状态（跨歌单同 songId 会串标）
    let statusCheckSeq = 0
    const checkAllSongsDownloadStatus = async () => {
      const seq = ++statusCheckSeq
      const playlistId = props.selectedPlaylist?.id
      if (!playlistId || !props.songs.length || isSingleSongPlaylist.value) {
        serverDownloadedStates.value = {}
        serverDownloadingStates.value = {} // 在途标记同属旧歌单，一并清
        return
      }

      try {
        const response = await downloadsApi.listTasks({ playlistId })
        if (seq !== statusCheckSeq) return // 已有更新的请求在飞，丢弃本次结果
        // 畸形响应（如反代把 API 误指到静态服返回 HTML 200）必须当失败处理，
        // 否则 || [] 会把全部"已下载"标记静默清成未下载
        const tasks = response.data?.data
        if (!Array.isArray(tasks)) {
          throw new Error('任务列表响应格式异常')
        }
        const downloadedIds = new Set(
          // completed 但文件已被外部删除的行（filesIntact=false）不算已下载——
          // 与单曲状态口径一致，重新露出下载入口走自愈重跑
          tasks.filter(t => t.status === 'completed' && t.filesIntact !== false)
            .map(t => String(t.songId))
        )
        for (const song of props.songs) {
          serverDownloadedStates.value[song.id] = downloadedIds.has(String(song.id))
        }
      } catch (error) {
        if (seq !== statusCheckSeq) return
        // 查询失败必须清空旧状态：否则切歌单/服务重启后残留上一歌单的"已下载"标记
        serverDownloadedStates.value = {}
        console.error('查询下载状态失败:', error)
      }
    }

    // 下载到服务器或删除
    const toggleServerDownload = async (song) => {
      if (!song) {
        closeDownloadMenu()
        return
      }
      // 在途守卫：处理中再点会发出重复请求撞服务端 409，
      // 用户看到的却是"下载失败"——直接关菜单静默返回
      if (song && serverDownloadingStates.value[song.id]) {
        closeDownloadMenu()
        return
      }
      if (!props.selectedPlaylist) {
        toast('请先选择歌单', 'error')
        closeDownloadMenu()
        return
      }

      const isDownloaded = serverDownloadedStates.value[song.id]
      // 请求在途时用户可能已切换歌单——响应落地后写状态会污染新歌单的同 id 歌曲
      // （状态 map 是"当前歌单"的视图，写前必须确认归属未变）
      const ownerPlaylistId = props.selectedPlaylist.id
      const stillCurrent = () =>
        !viewDisposed
        && String(props.selectedPlaylist?.id) === String(ownerPlaylistId)

      if (isDownloaded) {
        // 删除已下载文件
        if (!await pixelConfirm(`确定要删除 "${song.name}" 的已下载文件吗？`, { confirmText: '删除', danger: true })) {
          closeDownloadMenu()
          return
        }

        try {
          serverDownloadingStates.value[song.id] = true
          await downloadsApi.deleteSongDownload(ownerPlaylistId, song.id)
          if (stillCurrent()) serverDownloadedStates.value[song.id] = false
          toast('删除成功', 'success')
        } catch (error) {
          console.error('删除失败:', error)
          toast('删除失败: ' + extractErrorMessage(error), 'error')
        } finally {
          if (stillCurrent()) {
            serverDownloadingStates.value[song.id] = false
          }
          closeDownloadMenu()
        }
      } else {
        // 下载到服务器：提交即返回任务行，终态靠状态轮询（不再同步挂起 HTTP——
        // 长下载不会被反代/浏览器超时切断，重试也不会撞出脏响应）
        try {
          serverDownloadingStates.value[song.id] = true
          const response = await downloadsApi.downloadSongToServer(ownerPlaylistId, song.id, {
            bitrate: 320000,
            downloadAudio: true,
            downloadLyrics: true,
            downloadCover: true
          })
          const submittedTask = response.data?.data
          // completed 短路（幂等返回）才跳过轮询；pending/downloading 进入轮询
          if (submittedTask?.status !== 'completed') {
            // 轮询窗口封顶 10min：超时只报"仍在后台"，任务在服务端继续跑
            const deadline = Date.now() + 10 * 60 * 1000
            let terminal = null
            // 单次轮询失败（网络抖动/超时）不该判死下载——容忍连续 3 次再放弃，
            // 服务端任务不受影响
            let pollErrors = 0
            while (stillCurrent() && Date.now() < deadline) {
              await new Promise(resolve => setTimeout(resolve, 1500))
              let stData
              try {
                const st = await downloadsApi.getSongDownloadStatus(ownerPlaylistId, song.id)
                stData = st.data?.data
                pollErrors = 0
              } catch (pollErr) {
                if (++pollErrors >= 3) throw pollErr
                continue
              }
              if (stData?.downloaded) {
                terminal = 'completed'
                break
              }
              const taskStatus = stData?.task?.status
              if (taskStatus === 'failed') {
                throw new Error(stData.task.errorMessage || '下载失败')
              }
              // 任务行被外部删掉（管理面板清理）：没有可等的目标，快速退出
              if (stData && stData.task === null) {
                throw new Error('下载任务已不存在（可能在下载管理中被清理）')
              }
            }
            // 用户已切走歌单：静默结束（状态不属于当前视图，不该弹窗打扰）
            if (!stillCurrent()) return
            if (terminal !== 'completed') {
              // 非失败语义的提示单独提示——混进"下载失败:"前缀是误导
              toast('下载仍在后台进行中，可稍后在下载管理里查看结果')
              return
            }
          }
          if (!stillCurrent()) return // 幂等命中也走同一出口：视图已换即静默
          serverDownloadedStates.value[song.id] = true
          toast('下载成功', 'success')
        } catch (error) {
          console.error('下载失败:', error)
          if (stillCurrent()) toast('下载失败: ' + extractErrorMessage(error), 'error')
        } finally {
          if (stillCurrent()) {
            serverDownloadingStates.value[song.id] = false
          }
          closeDownloadMenu()
        }
      }
    }

    // 监听歌曲列表/歌单变化，自动查询状态；切歌单先清旧状态防止串标
    watch(() => props.selectedPlaylist?.id, () => {
      serverDownloadedStates.value = {}
      serverDownloadingStates.value = {} // 处理中标记同样属于旧歌单，一并清
      closeDownloadMenu() // 菜单目标已随歌单失效，不留悬空菜单
      checkAllSongsDownloadStatus()
    })

    watch(() => props.songs, () => {
      checkAllSongsDownloadStatus()
    }, { immediate: true })

    watch(() => props.playlistDownloadsRefreshKey, () => {
      checkAllSongsDownloadStatus()
    })

    // fixed 菜单不随滚动移动——滚动/翻页时直接关，避免菜单悬空指错歌；Escape 同关
    if (typeof window !== 'undefined') {
      const closeOnScroll = () => { closeDownloadMenu() }
      const closeOnEscape = (e) => { if (e.key === 'Escape') closeDownloadMenu() }
      window.addEventListener('scroll', closeOnScroll, true)
      window.addEventListener('keydown', closeOnEscape)
      onBeforeUnmount(() => {
        viewDisposed = true // 终止下载轮询并屏蔽其状态写/弹窗
        window.removeEventListener('scroll', closeOnScroll, true)
        window.removeEventListener('keydown', closeOnEscape)
      })
    }

    // 歌曲 id 类型混用（数字/字符串）——统一 String 比较，否则当前曲高亮会丢
    const isCurrent = (song) => String(song.id) === String(props.currentSong?.id)

    return {
      filteredSongs,
      totalPages,
      paginatedSongs,
      menuSong,
      isSingleSongPlaylist,
      formatDuration,
      isVipSong,
      isCurrent,
      paginationStyle,
      showDownloadMenu,
      downloadingStates,
      serverDownloadedStates,
      serverDownloadingStates,
      toggleDownloadMenu,
      playNextFromMenu,
      addToQueueFromMenu,
      shareFromMenu,
      shareSong,
      downloadSongDirect,
      toggleServerDownload,
      getMenuPosition,
      closeDownloadMenu,
      httpsCover
    }
  }
}
</script>

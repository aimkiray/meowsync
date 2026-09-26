<template>
  <div class="lg:col-span-1">
    <div ref="panelContainer" class="jirai-card card-songlist flex flex-col relative" :class="collapsed ? 'p-4 min-h-[3rem]' : 'p-6 max-h-96 overflow-y-auto'">
      <!-- 移动端折叠按钮 -->
      <button 
        v-if="isMobile" 
        @click="toggleCollapse"
        ref="collapseButtonRef"
        class="absolute z-10 w-6 h-6 flex justify-center items-center text-pink-300 hover:text-pink-200 transition-colors rounded-md hover:bg-pink-900/20 left-2"
        :class="collapsed ? 'top-1/2 -translate-y-1/2' : ''"
        :style="!collapsed && fixedButtonTop ? { top: fixedButtonTop } : null"
      >
        <span class="text-sm">{{ collapsed ? '▼' : '▲' }}</span>
      </button>
      
      <div v-show="!collapsed || !isMobile" class="song-content">
        <h2 class="text-xl font-bold mb-4 flex items-center justify-between text-pink-300 sticky top-0 backdrop-blur-md z-10 py-2 px-4" :style="headerStyle">
          <span class="flex items-center">歌曲</span>
          <div class="flex items-center space-x-2">
            <button
              @click="$emit('toggle-play-mode')"
              class="text-xs px-2 py-1 border transition-colors bg-pink-600 text-white border-pink-400 hover:bg-pink-500"
              style="border-radius: 0;"
              :title="playModeText"
            >
              {{ playModeText }}
            </button>
            <button
              @click="$emit('toggle-vip-songs')"
              class="text-xs px-2 py-1 border transition-colors"
              :class="showVipSongs ? 'bg-pink-500 text-white border-pink-400' : 'bg-gray-700 text-gray-300 border-gray-500 hover:bg-gray-600'"
              style="border-radius: 0;"
              title="切换VIP歌曲显示"
            >
              {{ showVipSongs ? '隐藏' : '显示' }}
            </button>
          </div>
        </h2>
      
      <div v-if="loadingSongs" class="text-center py-8">
        <div class="pixel-loading mx-auto mb-4"></div>
        <p class="text-pink-300 flex justify-center items-center">加载歌曲中喵...</p>
      </div>
      
      <div v-else-if="songs.length === 0" class="text-center py-8">
        <p class="text-gray-600 flex justify-center items-center">请选择一个歌单喵~</p>
      </div>
      
      <div v-else class="flex-1 flex flex-col">
        <div class="space-y-2 mb-4 -mx-6 px-6">
          <div
            v-for="song in paginatedSongs"
            :key="song.id"
            class="music-card cursor-pointer p-4 jirai-card transition-all w-full relative group"
            :class="{
              'playing-song': currentSong?.id === song.id,
              'opacity-50 grayscale': isVipSong(song)
            }"
          >
            <div @click="$emit('play-song', song)" class="flex items-center space-x-3">
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
                <div v-if="currentSong?.id === song.id && isPlaying" class="absolute inset-0 flex items-center justify-center">
                  <div class="text-pink-300 text-sm animate-pulse flex items-center justify-center">♡</div>
                </div>
              </div>
              <div class="flex-1 min-w-0">
                <h4 class="font-medium truncate flex items-center"
                  :class="currentSong?.id === song.id ? 'text-pink-500 font-bold' : 'text-pink-300'"
                >
                  {{ song.name }}
                  <span v-if="isVipSong(song)" class="ml-2 text-xs bg-yellow-500 text-black px-1 rounded">VIP</span>
                </h4>
                <p class="text-sm text-purple-300 truncate">
                  {{ song.ar?.map(artist => artist.name).join(', ') || song.artists?.map(a => a.name).join(', ') }}
                </p>
              </div>
              <div class="text-xs text-gray-400">
                {{ formatDuration(song.dt || song.duration) }}
              </div>
            </div>
            
            <!-- 操作按钮组 - 右上角 -->
            <div class="absolute top-0 right-0 flex">
              <!-- 分享按钮 -->
              <button 
                class="p-1 transition-all text-gray-400 hover:text-pink-300 flex items-center justify-center" 
                @click.stop="shareSong(song)"
                title="分享歌曲"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22"><path fill="currentColor" d="M9 15H8v-1H7v-1h1v-1h1v-1h1v-1h1V9H8V7h7v7h-2v-3h-1v1h-1v1h-1v1H9m9 6H4v-1H3v-1H2V4h1V3h1V2h14v1h1v1h1v14h-1v1h-1m-1-1v-1h1V5h-1V4H5v1H4v12h1v1Z"/></svg>
              </button>
              
              <!-- 下载按钮 -->
              <button 
                class="p-1 transition-all text-gray-400 hover:text-pink-300 flex items-center justify-center" 
                @click.stop="toggleDownloadMenu(song.id, $event)"
                :disabled="downloadingStates[song.id]"
                title="下载歌曲"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 22 22"><path fill="currentColor" d="M15 21H8v-1H7v-1H6V3h1V2h1V1h4v1h1v1h1v14h-1v1h-3v-1H9V5h2v11h1V4h-1V3H9v1H8v14h1v1h5v-1h1V5h2v14h-1v1h-1Z"/></svg>
              </button>
            </div>
            
            
          </div>
        </div>
        
        <!-- 歌曲统计信息 -->
        <div class="text-center mt-4 mb-2">
          <span class="text-pink-300 text-sm">
            显示第 {{ filteredSongs.length ? (currentPage - 1) * pageSize + 1 : 0 }}-{{ Math.min(currentPage * pageSize, filteredSongs.length) }} 首歌曲
          </span>
        </div>
        
        <!-- 分页控件 -->
        <PaginationControls
          v-if="totalPages > 1"
          :current-page="currentPage"
          :total-pages="totalPages"
          :bar-style="paginationStyle"
          @go-to-page="$emit('go-to-page', $event)"
          @prev-page="$emit('prev-page')"
          @next-page="$emit('next-page')"
        />
        
        <!-- 当只有一页时的提示 -->
        <div v-else-if="filteredSongs.length > 0" class="text-center mt-4 mb-2">
          <span class="text-pink-300 text-sm">
            共 {{ filteredSongs.length }} 首歌曲
            <span v-if="!showVipSongs && songs.length > filteredSongs.length" class="text-gray-400">
              （已隐藏 {{ songs.length - filteredSongs.length }} 首VIP歌曲）
            </span>
          </span>
        </div>
      </div>
      </div>
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
        :style="getMenuPosition(showDownloadMenu)"
        @click.stop
      >
        <div class="download-option download-option-header">
          下载选项
        </div>

        <!-- 获取源文件（浏览器下载）。菜单跨分页时 paginatedSongs 里找不到目标，必须查全量 props.songs -->
        <div
          class="download-option"
          @click="downloadSongDirect(menuSong, 320000)"
        >
          📄 获取源文件 (320k)
        </div>

        <!-- 下载到服务器 / 删除已下载（临时单曲歌单没有服务端持久化意义，隐藏；
             未选歌单时选了也只会 alert，同样不渲染） -->
        <div
          v-if="!isSingleSongPlaylist && selectedPlaylist"
          class="download-option"
          @click="toggleServerDownload(menuSong)"
        >
          <span v-if="serverDownloadingStates[showDownloadMenu]">⏳ 处理中...</span>
          <span v-else-if="serverDownloadedStates[showDownloadMenu]">🗑️ 删除已下载文件</span>
          <span v-else>💾 下载到服务器</span>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* 下载菜单覆盖层 */
.download-menu-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 9999;
  background: transparent;
}

/* 下载菜单（原先引用未定义的 --bg-color/--border-color 等变量导致透明背景，直接写死像素风配色） */
.download-menu {
  position: fixed;
  background: #1a1a2e;
  border: 1px solid #c084fc;
  border-radius: 0;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
  z-index: 10000;
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
import { useCollapseButton } from '../composables/useCollapseButton'
import { useMediaQuery } from '../composables/useMediaQuery'
import { formatDuration } from '../lib/format'
import { isVipSong } from '../lib/song'
import { shareOrCopy } from '../lib/share'

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
    playModeText: {
      type: String,
      default: '顺序播放'
    },
    currentPage: {
      type: Number,
      default: 1
    },
    pageSize: {
      type: Number,
      default: 10
    },
    collapsed: {
      type: Boolean,
      default: false
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
  emits: ['play-song', 'toggle-play-mode', 'toggle-vip-songs', 'go-to-page', 'prev-page', 'next-page', 'toggle-collapse'],
  setup(props, { emit }) {
    const { currentTheme } = useTheme()
    const showDownloadMenu = ref(null)
    const downloadingStates = ref({})
    const menuPositions = ref({})

    // 服务器下载状态
    const serverDownloadedStates = ref({})  // 是否已下载
    const serverDownloadingStates = ref({}) // 是否正在下载

    // 移动端检测
    const isMobile = useMediaQuery()

    // 折叠功能
    const toggleCollapse = () => {
      emit('toggle-collapse')
    }

    // 折叠按钮位置：折叠居中，展开保持固定像素
    const panelContainer = ref(null)
    const { collapseButtonRef, fixedButtonTop } = useCollapseButton(panelContainer, () => props.collapsed)

    // 动态样式
    const headerStyle = computed(() => {
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

    // 单曲分享生成的 single_song_* 是内存态临时歌单，服务端没有对应持久行，不提供服务器下载
    const isSingleSongPlaylist = computed(() =>
      String(props.selectedPlaylist?.id ?? '').startsWith('single_song_')
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
        const menuHeight = 120 // 3 个选项的大致高度，用于翻转判断
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
    
    // 分享歌曲
    const shareSong = async (song) => {
      const artistNames = song.ar?.map(artist => artist.name).join(', ') || song.artists?.map(a => a.name).join(', ') || '未知艺术家'
      const shareUrl = `${window.location.origin}/?song=${song.id}`

      const result = await shareOrCopy({
        title: `🎵 ${song.name} - ${artistNames}`,
        text: `来听听这首歌：${song.name} - ${artistNames}`,
        url: shareUrl
      })
      if (result === 'copied') alert('分享链接已复制到剪贴板！')
      else if (result === 'failed') alert('分享失败，请手动复制链接')
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
        alert('下载失败: ' + extractErrorMessage(error))
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
          tasks.filter(t => t.status === 'completed').map(t => String(t.songId))
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
        alert('请先选择歌单')
        closeDownloadMenu()
        return
      }

      const isDownloaded = serverDownloadedStates.value[song.id]
      // 请求在途时用户可能已切换歌单——响应落地后写状态会污染新歌单的同 id 歌曲
      // （状态 map 是"当前歌单"的视图，写前必须确认归属未变）
      const ownerPlaylistId = props.selectedPlaylist.id
      const stillCurrent = () =>
        String(props.selectedPlaylist?.id) === String(ownerPlaylistId)

      if (isDownloaded) {
        // 删除已下载文件
        if (!confirm(`确定要删除 "${song.name}" 的已下载文件吗？`)) {
          closeDownloadMenu()
          return
        }

        try {
          serverDownloadingStates.value[song.id] = true
          await downloadsApi.deleteSongDownload(ownerPlaylistId, song.id)
          if (stillCurrent()) serverDownloadedStates.value[song.id] = false
          alert('删除成功！')
        } catch (error) {
          console.error('删除失败:', error)
          alert('删除失败: ' + extractErrorMessage(error))
        } finally {
          if (stillCurrent()) {
            serverDownloadingStates.value[song.id] = false
          }
          closeDownloadMenu()
        }
      } else {
        // 下载到服务器
        try {
          serverDownloadingStates.value[song.id] = true
          await downloadsApi.downloadSongToServer(ownerPlaylistId, song.id, {
            bitrate: 320000,
            downloadAudio: true,
            downloadLyrics: true,
            downloadCover: true
          })
          if (stillCurrent()) serverDownloadedStates.value[song.id] = true
          alert('下载成功！')
        } catch (error) {
          console.error('下载失败:', error)
          alert('下载失败: ' + extractErrorMessage(error))
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
        window.removeEventListener('scroll', closeOnScroll, true)
        window.removeEventListener('keydown', closeOnEscape)
      })
    }

    return {
      filteredSongs,
      totalPages,
      paginatedSongs,
      menuSong,
      isSingleSongPlaylist,
      formatDuration,
      isVipSong,
      headerStyle,
      paginationStyle,
      showDownloadMenu,
      downloadingStates,
      serverDownloadedStates,
      serverDownloadingStates,
      toggleDownloadMenu,
      shareSong,
      downloadSongDirect,
      toggleServerDownload,
      getMenuPosition,
      closeDownloadMenu,
      httpsCover,
      isMobile,
      toggleCollapse,
      panelContainer,
      collapseButtonRef,
      fixedButtonTop
    }
  }
}
</script>
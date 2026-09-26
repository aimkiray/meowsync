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
                  :src="song.al?.picUrl || song.album?.picUrl"
                  :alt="song.name"
                  class="w-12 h-12 object-cover border-2 border-pink-400"
                  style="border-radius: 0; image-rendering: pixelated;"
                />
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

        <!-- 下载到服务器 / 删除已下载（临时单曲歌单没有服务端持久化意义，隐藏） -->
        <div
          v-if="!isSingleSongPlaylist"
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
        showDownloadMenu.value = null
      } else {
        // 计算菜单位置
        const button = event.target.closest('button')
        const rect = button.getBoundingClientRect()
        menuPositions.value[songId] = {
          top: rect.bottom + 4 + 'px',
          left: rect.right - 140 + 'px' // 140px是菜单宽度
        }
        showDownloadMenu.value = songId
      }
    }
    
    // 获取菜单位置
    const getMenuPosition = (songId) => {
      return menuPositions.value[songId] || { top: '0px', left: '0px' }
    }
    
    // 关闭菜单
    const closeDownloadMenu = () => {
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
      if (!song) return
      try {
        downloadingStates.value[song.id] = true
        await musicApi.downloadSong(song, bitrate)
        showDownloadMenu.value = null
      } catch (error) {
        console.error('下载失败:', error)
        alert('下载失败: ' + extractErrorMessage(error))
      } finally {
        downloadingStates.value[song.id] = false
      }
    }

    // 批量查询所有歌曲的下载状态：一次 listTasks 拉回该歌单全部任务本地映射，
    // 避免逐曲 N+1 请求（歌单未导入时服务端返回空数组，天然无副作用）
    const checkAllSongsDownloadStatus = async () => {
      if (!props.selectedPlaylist || !props.songs.length || isSingleSongPlaylist.value) {
        serverDownloadedStates.value = {}
        return
      }

      try {
        const response = await downloadsApi.listTasks({ playlistId: props.selectedPlaylist.id })
        const tasks = response.data?.data || []
        const downloadedIds = new Set(
          tasks.filter(t => t.status === 'completed').map(t => String(t.songId))
        )
        for (const song of props.songs) {
          serverDownloadedStates.value[song.id] = downloadedIds.has(String(song.id))
        }
      } catch (error) {
        // 查询失败必须清空旧状态：否则切歌单/服务重启后残留上一歌单的"已下载"标记
        serverDownloadedStates.value = {}
        console.error('查询下载状态失败:', error)
      }
    }

    // 下载到服务器或删除
    const toggleServerDownload = async (song) => {
      if (!song) return
      if (!props.selectedPlaylist) {
        alert('请先选择歌单')
        return
      }

      const isDownloaded = serverDownloadedStates.value[song.id]

      if (isDownloaded) {
        // 删除已下载文件
        if (!confirm(`确定要删除 "${song.name}" 的已下载文件吗？`)) {
          return
        }

        try {
          serverDownloadingStates.value[song.id] = true
          await downloadsApi.deleteSongDownload(props.selectedPlaylist.id, song.id)
          serverDownloadedStates.value[song.id] = false
          alert('删除成功！')
        } catch (error) {
          console.error('删除失败:', error)
          alert('删除失败: ' + extractErrorMessage(error))
        } finally {
          serverDownloadingStates.value[song.id] = false
          showDownloadMenu.value = null
        }
      } else {
        // 下载到服务器
        try {
          serverDownloadingStates.value[song.id] = true
          await downloadsApi.downloadSongToServer(props.selectedPlaylist.id, song.id, {
            bitrate: 320000,
            downloadAudio: true,
            downloadLyrics: true,
            downloadCover: true
          })
          serverDownloadedStates.value[song.id] = true
          alert('下载成功！')
        } catch (error) {
          console.error('下载失败:', error)
          alert('下载失败: ' + extractErrorMessage(error))
        } finally {
          serverDownloadingStates.value[song.id] = false
          showDownloadMenu.value = null
        }
      }
    }

    // 监听歌曲列表/歌单变化，自动查询状态；切歌单先清旧状态防止串标
    watch(() => props.selectedPlaylist?.id, () => {
      serverDownloadedStates.value = {}
      checkAllSongsDownloadStatus()
    })

    watch(() => props.songs, () => {
      checkAllSongsDownloadStatus()
    }, { immediate: true })

    watch(() => props.playlistDownloadsRefreshKey, () => {
      checkAllSongsDownloadStatus()
    })

    // fixed 菜单不随滚动移动——滚动/翻页时直接关，避免菜单悬空指错歌
    if (typeof window !== 'undefined') {
      const closeOnScroll = () => { showDownloadMenu.value = null }
      window.addEventListener('scroll', closeOnScroll, true)
      onBeforeUnmount(() => window.removeEventListener('scroll', closeOnScroll, true))
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
      isMobile,
      toggleCollapse,
      panelContainer,
      collapseButtonRef,
      fixedButtonTop
    }
  }
}
</script>
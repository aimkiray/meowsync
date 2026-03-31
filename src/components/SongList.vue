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
            v-for="(song, index) in paginatedSongs"
            :key="song.id"
            class="music-card cursor-pointer p-4 jirai-card transition-all w-full relative group"
            :class="{
              'playing-song': currentSong?.id === song.id,
              'opacity-50 grayscale': song.fee === 1 || song.privilege?.fee === 1
            }"
          >
            <div @click="$emit('play-song', song, filteredSongs.findIndex(s => s.id === song.id))" class="flex items-center space-x-3">
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
                  <span v-if="song.fee === 1 || song.privilege?.fee === 1" class="ml-2 text-xs bg-yellow-500 text-black px-1 rounded">VIP</span>
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
            
            
            <!-- 下载菜单 - 使用 Teleport 确保显示在外部 -->
            <Teleport to="body">
              <div
                v-if="showDownloadMenu === song.id"
                class="fixed bg-gray-900 border border-purple-400 shadow-lg z-[9999] w-[140px] max-w-[140px]"
                style="border-radius: 0;"
                :style="getMenuPosition(song.id)"
              >
                <div class="px-3 py-2 text-xs text-purple-300 border-b border-gray-700">
                  选择码率
                </div>
                <button
                  v-for="bitrate in bitrateOptions"
                  :key="bitrate.value"
                  @click.stop="downloadSong(song, bitrate.value)"
                  class="w-full text-left px-3 py-2 text-xs text-purple-300 hover:bg-purple-800 hover:text-white transition-colors border-b border-gray-700 truncate last:border-b-0"
                  :disabled="downloadingStates[song.id]"
                  :class="{ 'opacity-50 cursor-not-allowed': downloadingStates[song.id] }"
                >
                  {{ downloadingStates[song.id] ? '下载中...' : bitrate.label }}
                </button>
              </div>
            </Teleport>
          </div>
        </div>
        
        <!-- 歌曲统计信息 -->
        <div class="text-center mt-4 mb-2">
          <span class="text-pink-300 text-sm">
            显示第 {{ (currentPage - 1) * pageSize + 1 }}-{{ Math.min(currentPage * pageSize, filteredSongs.length) }} 首歌曲
          </span>
        </div>
        
        <!-- 分页控件 -->
        <div v-if="totalPages > 1" class="flex justify-center items-center space-x-1 mt-4 mb-4 p-3 backdrop-blur-md" :style="paginationStyle">
          <button 
            @click="$emit('go-to-page', 1)" 
            :disabled="currentPage === 1"
            class="pixel-button text-xs px-2 py-1 text-white font-bold flex items-center justify-center min-w-[32px]"
            :class="currentPage === 1 ? 'opacity-50 cursor-not-allowed bg-gray-600' : 'bg-purple-600 hover:bg-purple-500'"
          >
            ⇤
          </button>
          
          <button 
            @click="$emit('prev-page')" 
            :disabled="currentPage === 1"
            class="pixel-button text-xs px-2 py-1 text-white font-bold flex items-center justify-center min-w-[32px]"
            :class="currentPage === 1 ? 'opacity-50 cursor-not-allowed bg-gray-600' : 'bg-purple-600 hover:bg-purple-500'"
          >
            ←
          </button>
          
          <span class="text-pink-300 text-xs px-2 py-1 min-w-[48px] text-center">
            {{ currentPage }}/{{ totalPages }}
          </span>
          
          <button 
            @click="$emit('next-page')" 
            :disabled="currentPage === totalPages"
            class="pixel-button text-xs px-2 py-1 text-white font-bold flex items-center justify-center min-w-[32px]"
            :class="currentPage === totalPages ? 'opacity-50 cursor-not-allowed bg-gray-600' : 'bg-purple-600 hover:bg-purple-500'"
          >
            →
          </button>
          
          <button 
            @click="$emit('go-to-page', totalPages)" 
            :disabled="currentPage === totalPages"
            class="pixel-button text-xs px-2 py-1 text-white font-bold flex items-center justify-center min-w-[32px]"
            :class="currentPage === totalPages ? 'opacity-50 cursor-not-allowed bg-gray-600' : 'bg-purple-600 hover:bg-purple-500'"
          >
            ⇥
          </button>
        </div>
        
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
        <div 
          v-for="option in bitrateOptions" 
          :key="option.value"
          class="download-option"
          @click="downloadSong(paginatedSongs.find(s => s.id === showDownloadMenu), option.value)"
        >
          {{ option.label }}
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

/* 下载菜单 */
.download-menu {
  position: fixed;
  background: var(--bg-color);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  z-index: 10000;
  min-width: 140px;
  overflow: hidden;
}

.download-option {
  padding: 10px 12px;
  cursor: pointer;
  transition: background-color 0.2s;
  font-size: 14px;
  color: var(--text-color);
}

.download-option:hover {
  background-color: var(--hover-color);
  color: #ff69b4;
}
</style>

<script>
import { computed, ref, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { musicApi } from '../api/music.js'

export default {
  name: 'SongList',
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
    }
  },
  emits: ['play-song', 'toggle-play-mode', 'toggle-vip-songs', 'go-to-page', 'prev-page', 'next-page', 'toggle-collapse'],
  setup(props, { emit }) {
    const currentTheme = ref('default')
    const showDownloadMenu = ref(null)
    const downloadingStates = ref({})
    const menuPositions = ref({})
    
    // 移动端检测
    const isMobile = ref(false)
    
    const checkMobile = () => {
      isMobile.value = window.innerWidth <= 768
    }
    
    // 折叠功能
    const toggleCollapse = () => {
      emit('toggle-collapse')
    }

    // 折叠按钮位置：折叠居中，展开保持固定像素
    const panelContainer = ref(null)
    const collapseButtonRef = ref(null)
    const fixedButtonTop = ref(null)

    const computeCollapsedCenterTop = () => {
      nextTick(() => {
        if (!collapseButtonRef.value) return
        const buttonHeight = collapseButtonRef.value.offsetHeight || 24
        const clone = document.createElement('div')
        clone.className = 'jirai-card flex flex-col relative p-4 min-h-[3rem]'
        clone.style.position = 'absolute'
        clone.style.visibility = 'hidden'
        clone.style.left = '-9999px'
        clone.style.top = '-9999px'
        if (panelContainer.value) {
          clone.style.width = panelContainer.value.offsetWidth + 'px'
        }
        document.body.appendChild(clone)
        const collapsedHeight = clone.offsetHeight
        document.body.removeChild(clone)
        const topValue = (collapsedHeight / 2) - (buttonHeight / 2)
        fixedButtonTop.value = Math.round(topValue) + 'px'
      })
    }

    const handleResizeForButton = () => {
      computeCollapsedCenterTop()
    }
    
    // 码率选项
    const bitrateOptions = [
      { label: '320kbps (高品质)', value: 320000 },
      { label: '192kbps (标准)', value: 192000 },
      { label: '128kbps (普通)', value: 128000 },
      { label: '96kbps (节省流量)', value: 96000 }
    ]
    
    // 检测当前主题
    const detectTheme = () => {
      const root = document.documentElement
      currentTheme.value = root.getAttribute('data-theme') === 'pixel-retro' ? 'pixel-retro' : 'default'
    }
    
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
    
    // 监听主题变化
    const observer = new MutationObserver(() => {
      detectTheme()
    })
    
    onMounted(() => {
      detectTheme()
      checkMobile()
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme']
      })
      // 添加点击外部事件监听
      document.addEventListener('click', handleClickOutside)
      // 添加窗口大小变化监听
      window.addEventListener('resize', checkMobile)
      window.addEventListener('resize', handleResizeForButton)

      // 初始计算折叠居中位置，即使默认展开也避免首跳
      computeCollapsedCenterTop()
    })
    
    onUnmounted(() => {
      observer.disconnect()
      // 移除点击外部事件监听
      document.removeEventListener('click', handleClickOutside)
      // 移除窗口大小变化监听
      window.removeEventListener('resize', checkMobile)
      window.removeEventListener('resize', handleResizeForButton)
    })

    watch(() => props.collapsed, () => {
      computeCollapsedCenterTop()
    })
    
    // 过滤后的歌曲列表（根据VIP显示设置）
    const filteredSongs = computed(() => {
      if (props.showVipSongs) {
        return props.songs // 显示所有歌曲
      } else {
        return props.songs.filter(song => !(song.fee === 1 || song.privilege?.fee === 1)) // 隐藏VIP歌曲
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

    const formatDuration = (ms) => {
      const seconds = Math.floor(ms / 1000)
      const mins = Math.floor(seconds / 60)
      const secs = Math.floor(seconds % 60)
      return `${mins}:${secs.toString().padStart(2, '0')}`
    }
    
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
      const shareText = `🎵 ${song.name} - ${artistNames}`
      
      try {
        // 尝试使用Web Share API（移动端支持更好）
        if (navigator.share) {
          await navigator.share({
            title: shareText,
            text: `来听听这首歌：${shareText}`,
            url: shareUrl
          })
          console.log('歌曲分享成功')
        } else {
          // 降级到复制链接
          await navigator.clipboard.writeText(shareUrl)
          console.log('分享链接已复制到剪贴板:', shareUrl)
          // 这里可以添加一个提示消息
          alert('分享链接已复制到剪贴板！')
        }
      } catch (err) {
        console.error('分享失败:', err)
        // 最后的降级方案
        try {
          const textArea = document.createElement('textarea')
          textArea.value = shareUrl
          document.body.appendChild(textArea)
          textArea.select()
          document.execCommand('copy')
          document.body.removeChild(textArea)
          alert('分享链接已复制到剪贴板！')
        } catch (copyErr) {
          console.error('复制失败:', copyErr)
          alert('分享失败，请手动复制链接')
        }
      }
    }
    
    // 下载歌曲
    const downloadSong = async (song, bitrate) => {
      try {
        // 关闭下载菜单
        showDownloadMenu.value = null
        
        // 设置下载状态
        downloadingStates.value[song.id] = true
        
        console.log('开始下载歌曲:', song.name, '码率:', bitrate)
        
        // 调用API下载歌曲
        const result = await musicApi.downloadSong(song, bitrate)
        
        if (result.success) {
          // 可以在这里添加成功提示
          console.log('下载成功:', result.fileName)
        }
      } catch (error) {
        console.error('下载失败:', error.message)
        // 可以在这里添加错误提示
        alert(`下载失败: ${error.message}`)
      } finally {
        // 清除下载状态
        delete downloadingStates.value[song.id]
      }
    }
    
    // 点击外部关闭下载菜单
    const handleClickOutside = (event) => {
      if (!event.target.closest('.relative')) {
        showDownloadMenu.value = null
      }
    }

    return {
      filteredSongs,
      totalPages,
      paginatedSongs,
      formatDuration,
      headerStyle,
      paginationStyle,
      showDownloadMenu,
      downloadingStates,
      bitrateOptions,
      toggleDownloadMenu,
      shareSong,
      downloadSong,
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
<template>
  <!-- 歌单库侧栏：YTM 左栏语义——顶部导航项 + "我的歌单"媒体库列表 -->
  <div class="playlist-panel flex flex-col h-full min-h-0">
    <!-- YTM mini-guide 导航项：首页（发现流） -->
    <button
      class="side-nav-item"
      :class="{ 'side-nav-item--active': homeActive }"
      @click="$emit('nav-home')"
      title="首页"
    >
      <span class="side-nav-icon">🏠</span>
      <span>首页</span>
    </button>

    <h2 class="panel-title">我的歌单</h2>

    <div v-if="loading" class="text-center py-8">
      <div class="pixel-loading mx-auto mb-4"></div>
      <p class="text-pink-300 flex justify-center items-center">加载中喵...</p>
    </div>

    <div v-else-if="userPlaylists.length === 0" class="text-center py-8">
      <p class="text-gray-600 flex justify-center items-center">还没有添加歌单喵~</p>
      <p class="text-sm text-purple-300 mt-2">用顶部搜索框找歌单吧！</p>
    </div>

    <div v-else class="playlist-scroll flex-1 min-h-0 overflow-y-auto space-y-2">
      <div
        v-for="playlist in userPlaylists"
        :key="playlist.id"
        class="music-card cursor-pointer p-3 jirai-card transition-all w-full relative group"
        :class="{ 'border-purple-400': String(selectedPlaylist?.id) === String(playlist.id) }"
      >
        <div @click="$emit('select-playlist', playlist)" class="flex items-center space-x-3">
          <div class="relative">
            <img
              v-if="playlist.coverImgUrl"
              :src="httpsCover(playlist.coverImgUrl)"
              :alt="playlist.name"
              class="w-12 h-12 object-cover border-2 border-pink-400"
              style="border-radius: 0; image-rendering: pixelated;"
            />
            <div
              v-else
              class="w-12 h-12 flex items-center justify-center border-2 border-pink-400 text-pink-300"
              style="border-radius: 0;"
            >♪</div>
            <!-- 悬停 ▶ 直接播放整个歌单 -->
            <button
              class="playlist-play-overlay"
              title="播放歌单"
              @click.stop="$emit('play-playlist', playlist)"
            >▶</button>
          </div>
          <div class="flex-1 min-w-0">
            <h3 class="font-semibold text-pink-300 truncate">{{ playlist.name }}</h3>
            <p class="text-sm text-purple-300 truncate">{{ playlist.creator?.nickname || '神秘创建者' }}</p>
          </div>
          <div class="text-xs text-gray-400">
            {{ playlist.trackCount }} 首
          </div>
        </div>
        <!-- 菜单与分享按钮 -->
        <div class="playlist-menu absolute top-0 right-0 flex">
          <!-- 分享按钮（与歌曲一致的样式与图标）；临时歌单的 id 非数字，
               接收端 getPlaylistIdsFromUrl 只认 \d+ → 分享链接必死，隐藏 -->
          <button
            v-if="!isTempPlaylist(playlist)"
            @click.stop="sharePlaylist(playlist)"
            class="p-1 transition-all text-gray-400 hover:text-pink-300 flex items-center justify-center"
            style="border-radius: 0;"
            title="分享歌单"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22"><path fill="currentColor" d="M9 15H8v-1H7v-1h1v-1h1v-1h1v-1h1V9H8V7h7v7h-2v-3h-1v1h-1v1h-1v1H9m9 6H4v-1H3v-1H2V4h1V3h1V2h14v1h1v1h1v14h-1v1h-1m-1-1v-1h1V5h-1V4H5v1H4v12h1v1Z"/></svg>
          </button>

          <!-- 更多菜单按钮 -->
          <button
            @click.stop="toggleMenu(playlist.id, $event)"
            class="p-1 transition-all text-gray-400 hover:text-pink-300 flex items-center justify-center"
            style="border-radius: 0;"
            title="更多操作"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22"><path fill="currentColor" d="M15 21H8v-1H7v-1H6V3h1V2h1V1h4v1h1v1h1v14h-1v1h-3v-1H9V5h2v11h1V4h-1V3H9v1H8v14h1v1h5v-1h1V5h2v14h-1v1h-1Z"/></svg>
          </button>
        </div>

        <!-- 下拉菜单 - 使用 Teleport 确保显示在外部 -->
        <Teleport to="body">
          <div
            v-if="openMenuId === playlist.id"
            class="playlist-menu fixed bg-gray-900 border border-purple-400 shadow-lg z-[var(--z-menu)] w-[140px] max-w-[140px]"
            style="border-radius: 0;"
            :style="getMenuPosition(playlist.id)"
          >
            <button
              v-if="!isTempPlaylist(playlist)"
              @click.stop="downloadPlaylist(playlist)"
              class="w-full text-left px-3 py-2 text-xs text-purple-300 hover:bg-purple-800 hover:text-white transition-colors border-b border-gray-700 truncate"
            >
              📥 下载歌单
            </button>
            <button
              v-if="!isTempPlaylist(playlist)"
              @click.stop="openInNetease(playlist)"
              class="w-full text-left px-3 py-2 text-xs text-purple-300 hover:bg-purple-800 hover:text-white transition-colors border-b border-gray-700 truncate"
            >
              🎵 打开网易云
            </button>
            <button
              v-if="!isTempPlaylist(playlist)"
              @click.stop="copyShareLink(playlist)"
              class="w-full text-left px-3 py-2 text-xs text-purple-300 hover:bg-purple-800 hover:text-white transition-colors border-b border-gray-700 truncate"
            >
              🔗 复制分享链接
            </button>
            <button
              v-if="!isTempPlaylist(playlist)"
              @click.stop="deletePlaylistDownloads(playlist)"
              class="w-full text-left px-3 py-2 text-xs text-orange-300 hover:bg-orange-800 hover:text-white transition-colors border-b border-gray-700 truncate"
            >
              🧹 删除已下载歌曲
            </button>
            <button
              @click.stop="removePlaylist(playlist.id)"
              class="w-full text-left px-3 py-2 text-xs text-red-300 hover:bg-red-800 hover:text-white transition-colors truncate"
            >
              🗑️ 删除歌单
            </button>
          </div>
        </Teleport>
      </div>

      <div class="text-center py-2">
        <span class="text-pink-300 text-xs">共 {{ userPlaylists.length }} 个歌单</span>
      </div>
    </div>
  </div>
</template>

<script>
import { ref, onMounted, onUnmounted } from 'vue'
import { downloadsApi } from '../api/downloads'
import { copyText, shareOrCopy } from '../lib/share'
import { httpsCover as sharedHttpsCover } from '../lib/url'

export default {
  name: 'PlaylistPanel',
  props: {
    userPlaylists: {
      type: Array,
      default: () => []
    },
    selectedPlaylist: {
      type: Object,
      default: null
    },
    loading: {
      type: Boolean,
      default: false
    },
    // 首页导航项的激活态（centerView === 'home'）
    homeActive: {
      type: Boolean,
      default: false
    }
  },
  emits: ['select-playlist', 'play-playlist', 'remove-playlist', 'nav-home', 'playlist-downloads-deleted'],
  setup(props, { emit }) {
    const openMenuId = ref(null)
    const menuPositions = ref({})

    // HTTPS 部署下 http: 封面会被浏览器混拦——网易图床均支持 TLS，显式升级
    // （共享 helper 见 lib/url.js，歌曲封面/歌单封面/任务封面同一来源）
    const httpsCover = sharedHttpsCover

    const closeOnEscape = (e) => { if (e.key === 'Escape') closeMenu() }

    onMounted(() => {
      document.addEventListener('click', handleClickOutside)
      // 菜单是 fixed 定位，面板滚动后位置脱节——滚动时直接关闭
      window.addEventListener('scroll', closeMenu, true)
      window.addEventListener('keydown', closeOnEscape)
    })

    onUnmounted(() => {
      document.removeEventListener('click', handleClickOutside)
      window.removeEventListener('scroll', closeMenu, true)
      window.removeEventListener('keydown', closeOnEscape)
    })

    // 菜单相关方法
    const toggleMenu = (playlistId, event) => {
      if (openMenuId.value === playlistId) {
        closeMenu()
      } else {
        // 切到另一个歌单：旧菜单位置缓存即弃，否则 map 只增不减
        if (openMenuId.value != null) delete menuPositions.value[openMenuId.value]
        // 计算菜单位置（event.target 可能是内部 svg/path，须定位到按钮本身）；
        // 下方空间不足翻到上方、左侧越界收回视口内——面板可滚动而菜单 fixed，
        // 开出视口后 scroll-close 又挡住滚动，菜单就永远不可达
        const button = event.target.closest('button') || event.target
        const rect = button.getBoundingClientRect()
        const menuWidth = 140
        // 菜单高度按可见项数算：临时歌单隐藏 4 项只剩"删除歌单"，
        // 按全量 5 项翻转会把菜单顶到按钮上方 150px 悬空。
        // find miss（点击瞬间列表刷新）兜底按 1 项算——比按 5 项悬空更安全
        const currentPlaylist = props.userPlaylists.find(p => p.id === playlistId)
        const itemCount = !currentPlaylist || isTempPlaylist(currentPlaylist) ? 1 : 5
        const menuHeight = itemCount * 38 + 4
        const vw = window.innerWidth
        const vh = window.innerHeight
        const belowFits = rect.bottom + 4 + menuHeight <= vh
        menuPositions.value[playlistId] = {
          top: (belowFits ? rect.bottom + 4 : Math.max(8, rect.top - menuHeight - 4)) + 'px',
          left: Math.max(8, Math.min(rect.right - menuWidth, vw - menuWidth - 8)) + 'px'
        }
        openMenuId.value = playlistId
      }
    }

    const getMenuPosition = (playlistId) => {
      return menuPositions.value[playlistId] || { top: '0px', left: '0px' }
    }

    const closeMenu = () => {
      if (openMenuId.value != null) delete menuPositions.value[openMenuId.value]
      openMenuId.value = null
    }

    const openInNetease = (playlist) => {
      const url = `https://music.163.com/#/playlist?id=${playlist.id}`
      window.open(url, '_blank', 'noopener')
      closeMenu()
    }

    // 分享链带 view=songs&pl=ID：冷启动后主区直接落在该歌单歌曲页，不停在首页
    const copyShareLink = async (playlist) => {
      const url = `${window.location.origin}/?playlist=${playlist.id}&view=songs&pl=${playlist.id}`
      const ok = await copyText(url)
      if (!ok) {
        alert('复制失败，请手动复制链接')
      }
      closeMenu()
    }

    // 分享歌单（与歌曲分享一致的逻辑：Web Share API + 复制降级）
    const sharePlaylist = async (playlist) => {
      const shareUrl = `${window.location.origin}/?playlist=${playlist.id}&view=songs&pl=${playlist.id}`
      const result = await shareOrCopy({
        title: `🎵 歌单：${playlist.name}`,
        text: `来看看这个歌单：${playlist.name}`,
        url: shareUrl
      })
      if (result === 'copied') alert('分享链接已复制到剪贴板！')
      else if (result === 'failed') alert('分享失败，请手动复制链接')
    }

    const removePlaylist = (playlistId) => {
      // 与其他删除项保持一致的确认（本地库移除，误删可重加但易误触）
      if (!confirm('确定要从库中移除该歌单吗？')) {
        closeMenu()
        return
      }
      emit('remove-playlist', playlistId)
      closeMenu()
    }

    // 单曲分享生成的 single_song_* 是本地内存态临时歌单，服务端无对应持久行——不提供下载入口
    const isTempPlaylist = (playlist) => String(playlist?.id ?? '').startsWith('single_song_')

    // 下载歌单
    const downloadPlaylist = async (playlist) => {
      try {
        await downloadsApi.quickDownloadPlaylist(playlist.id, {
          bitrate: 320000,
          downloadAudio: true,
          downloadLyrics: true,
          downloadCover: true,
          concurrentLimit: 3
        })

        alert('下载队列已创建！正在后台下载...')
      } catch (error) {
        console.error('创建下载队列失败:', error)
        const message = error.response?.data?.message || error.message
        alert('下载失败: ' + message)
      } finally {
        closeMenu() // 失败也要关菜单——否则菜单挂着看似还能点
      }
    }

    const deletePlaylistDownloads = async (playlist) => {
      // confirm 取消分支与 removePlaylist 行为一致：也关菜单
      if (!confirm(`确定要删除歌单 "${playlist.name}" 的已下载歌曲吗？`)) {
        closeMenu()
        return
      }

      try {
        const response = await downloadsApi.deletePlaylistDownloads(playlist.id)
        // 畸形响应（反代返回 HTML 200 等）不该吞成"0 首"假提示
        const deletedSongs = response.data?.data?.deletedSongs
        if (typeof deletedSongs !== 'number') {
          throw new Error('接口返回异常')
        }
        alert(deletedSongs > 0 ? `已删除 ${deletedSongs} 首已下载歌曲` : '这个歌单没有可删除的已下载歌曲')
        // 0 首时不必触发父组件刷新——只会多发一轮无效任务轮询
        if (deletedSongs > 0) emit('playlist-downloads-deleted', playlist.id)
      } catch (error) {
        console.error('批量删除已下载歌曲失败:', error)
        const message = error.response?.data?.message || error.message
        alert('删除失败: ' + message)
      } finally {
        closeMenu()
      }
    }

    // 点击外部关闭菜单
     const handleClickOutside = (event) => {
       if (!event.target.closest('.playlist-menu')) {
         closeMenu()
       }
     }

    return {
       openMenuId,
       toggleMenu,
       closeMenu,
       openInNetease,
       copyShareLink,
       removePlaylist,
       sharePlaylist,
       downloadPlaylist,
       deletePlaylistDownloads,
       isTempPlaylist,
       getMenuPosition,
       httpsCover
     }
  }
}
</script>

<style scoped>
.playlist-panel {
  padding: 14px 12px;
}

.panel-title {
  font-size: 13px;
  font-weight: bold;
  color: var(--pixel-text, #f9a8d4);
  opacity: 0.85;
  letter-spacing: 0.05em;
  padding: 0 4px 10px;
  flex-shrink: 0;
}

.playlist-scroll {
  scrollbar-gutter: stable;
}

/* YTM mini-guide 导航项 */
.side-nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  font-size: 13px;
  font-weight: 600;
  color: var(--pixel-text-dim);
  background: transparent;
  border: 2px solid transparent;
  cursor: pointer;
  text-align: left;
  margin-bottom: 4px;
  flex-shrink: 0;
  transition: background 0.12s, color 0.12s;
}

.side-nav-item:hover {
  background: rgba(236, 72, 153, 0.1);
  color: var(--pixel-text);
}

.side-nav-item--active {
  color: var(--pixel-text);
  border-color: var(--pixel-accent-fg, #f472b6);
  background: rgba(236, 72, 153, 0.14);
}

.side-nav-icon {
  font-size: 15px;
  line-height: 1;
}

/* 侧栏歌单行悬停 ▶ 播放键（浮于封面上） */
.playlist-play-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  color: #fff;
  background: rgba(0, 0, 0, 0.45);
  opacity: 0;
  border: none;
  cursor: pointer;
  transition: opacity 0.12s;
}

.music-card:hover .playlist-play-overlay,
.playlist-play-overlay:focus-visible {
  opacity: 1;
}
</style>

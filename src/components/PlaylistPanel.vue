<template>
  <div class="lg:col-span-1">
    <div ref="panelContainer" class="jirai-card card-playlist flex flex-col relative" :class="collapsed ? 'p-4 min-h-[3rem]' : 'p-6 max-h-96 overflow-y-auto'">
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
      
      <!-- 歌单内容 -->
      <div v-show="!collapsed || !isMobile" class="flex flex-col" :class="collapsed ? '' : 'flex-1'">
        <!-- 选项卡导航 -->
        <div class="flex mb-4 sticky top-0 backdrop-blur-md z-10 -px-12">
        <button
          @click="$emit('update:activeTab', 'my')"
          class="flex-1 py-2 px-4 text-center transition-all duration-200 border-2 relative overflow-hidden group"
          :class="!showAddPlaylist ? 'bg-pink-900 border-pink-500 text-pink-100 shadow-inner' : 'bg-gray-900 border-gray-600 text-gray-300 hover:bg-pink-950 hover:border-pink-600 hover:text-pink-200 border-r-0'"
          :style="{ borderRadius: '0', boxShadow: tabButtonStyle }"
        >
          <span class="relative z-10 font-bold tracking-wide text-sm uppercase">我的歌单</span>
          <div class="absolute inset-0 bg-pink-800/20 opacity-0 group-hover:opacity-100 transition-opacity duration-200"></div>
        </button>
        <button
          @click="$emit('update:activeTab', 'discover')"
          class="flex-1 py-2 px-4 text-center transition-all duration-200 border-2 relative overflow-hidden group"
          :class="showAddPlaylist ? 'bg-pink-900 border-pink-500 text-pink-100 shadow-inner' : 'bg-gray-900 border-gray-600 text-gray-300 hover:bg-pink-950 hover:border-pink-600 hover:text-pink-200 border-l-0'"
          :style="{ borderRadius: '0', boxShadow: tabButtonStyle }"
        >
          <span class="relative z-10 font-bold tracking-wide text-sm uppercase">发现歌单</span>
          <div class="absolute inset-0 bg-pink-800/20 opacity-0 group-hover:opacity-100 transition-opacity duration-200"></div>
        </button>
      </div>
      
      <!-- 搜索框（仅在发现歌单选项卡显示） -->
      <div v-if="showAddPlaylist" class="mb-4 -mx-6 px-6">
        <div class="flex items-center space-x-1">
          <input
            :value="searchQuery"
            @input="$emit('update:searchQuery', $event.target.value)"
            @keyup.enter="handleSearch"
            type="text"
            placeholder="搜索歌单或输入ID/URL"
            class="pixel-input flex-1 py-2 px-3 h-10"
            style="border-radius: 0; position: relative; z-index: 1;"
          />
          <button
            @click="handleSearch"
            class="pixel-button py-2 px-3 h-10 flex items-center justify-center"
            :disabled="!searchQuery.trim()"
            style="border-radius: 0; flex-shrink: 0;"
          >
            {{ extractPlaylistId(searchQuery) ? '添加' : '搜索' }}
          </button>
        </div>
      </div>
      
      <div v-if="loading" class="text-center py-8">
        <div class="pixel-loading mx-auto mb-4"></div>
        <p class="text-pink-300 flex justify-center items-center">加载中喵...</p>
      </div>
      
      <!-- 我的歌单库 -->
      <div v-else-if="!showAddPlaylist" class="flex-1 flex flex-col">
        <div v-if="userPlaylists.length === 0" class="text-center py-8">
          <p class="text-gray-600 flex justify-center items-center">还没有添加歌单喵~</p>
          <p class="text-sm text-purple-300 mt-2">点击上方"发现歌单"标签开始搜索吧！</p>
        </div>
        <div class="space-y-2 mb-4 -mx-6 px-6" v-else>
          <div
            v-for="playlist in currentPlaylists"
            :key="playlist.id"
            class="music-card cursor-pointer p-4 jirai-card transition-all w-full relative group"
            :class="{ 'border-purple-400': selectedPlaylist?.id === playlist.id }"
          >
            <div @click="$emit('select-playlist', playlist)" class="flex items-center space-x-3">
              <div class="relative">
                <img
                  :src="httpsCover(playlist.coverImgUrl)"
                  :alt="playlist.name"
                  class="w-12 h-12 object-cover border-2 border-pink-400"
                  style="border-radius: 0; image-rendering: pixelated;"
                />
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
              <!-- 分享按钮（与歌曲一致的样式与图标） -->
              <button 
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
                class="playlist-menu fixed bg-gray-900 border border-purple-400 shadow-lg z-[9999] w-[140px] max-w-[140px]"
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
        </div>
        
        <!-- 歌单统计信息 -->
        <div v-if="userPlaylists.length > 0" class="text-center mt-4 mb-2">
          <span class="text-pink-300 text-sm">
            显示第 {{ userPlaylists.length ? (currentPage - 1) * pageSize + 1 : 0 }}-{{ Math.min(currentPage * pageSize, userPlaylists.length) }} 个歌单
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
        <div v-else-if="userPlaylists.length > 0" class="text-center mt-4 mb-2">
          <span class="text-pink-300 text-sm">
            共 {{ userPlaylists.length }} 个歌单
          </span>
        </div>
      </div>
      
      <!-- 搜索结果 -->
      <div v-else class="flex-1 flex flex-col">
        <div v-if="searchResults.length === 0 && !loading" class="text-center py-8">
          <p class="text-gray-600 flex justify-center items-center">搜索歌单来添加到你的库中喵~</p>
        </div>
        <div class="space-y-2 mb-4 -mx-6 px-6" v-else>
          <div
              v-for="playlist in currentPlaylists"
              :key="playlist.id"
              class="music-card cursor-pointer p-4 jirai-card transition-all w-full relative group"
            >
              <div class="flex items-center space-x-3">
                <div class="relative">
                  <img
                    :src="httpsCover(playlist.coverImgUrl)"
                    :alt="playlist.name"
                    class="w-12 h-12 object-cover border-2 border-pink-400"
                    style="border-radius: 0; image-rendering: pixelated;"
                  />
                  <div class="absolute -top-1 -right-1 text-xs flex items-center justify-center">🌟</div>
                </div>
                <div class="flex-1 min-w-0">
                  <h3 class="font-semibold text-pink-300 truncate">{{ playlist.name }}</h3>
                  <p class="text-sm text-purple-300 truncate">{{ playlist.creator?.nickname || '神秘创建者' }}</p>
                </div>
                <div class="text-xs text-gray-400">
                  {{ playlist.trackCount }} 首
                </div>
              </div>
              <!-- 发现歌单：分享与添加按钮 -->
              <div class="absolute top-0 right-0 flex">
                <button 
                  @click.stop="sharePlaylist(playlist)"
                  class="transition-all p-1 flex items-center justify-center text-gray-400 hover:text-pink-300"
                  style="border-radius: 0;"
                  title="分享歌单"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22"><path fill="currentColor" d="M9 15H8v-1H7v-1h1v-1h1v-1h1v-1h1V9H8V7h7v7h-2v-3h-1v1h-1v1h-1v1H9m9 6H4v-1H3v-1H2V4h1V3h1V2h14v1h1v1h1v14h-1v1h-1m-1-1v-1h1V5h-1V4H5v1H4v12h1v1Z"/></svg>
                </button>
                <button
                  @click.stop="handleAddPlaylist(playlist)"
                  class="transition-all p-1 flex items-center justify-center"
                  style="border-radius: 0;"
                  :class="{
                    'text-pink-500 hover:text-pink-600': userPlaylists.find(p => p.id === playlist.id),
                    'text-orange-500 hover:text-orange-600': isPlaylistAdding(playlist.id),
                    'text-gray-400 hover:text-pink-300': !userPlaylists.find(p => p.id === playlist.id) && !isPlaylistAdding(playlist.id)
                  }"
                  :disabled="userPlaylists.find(p => p.id === playlist.id) || isPlaylistAdding(playlist.id)"
                  title="添加到我的歌单"
                >
                  <svg v-if="!userPlaylists.find(p => p.id === playlist.id)" xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">
                    <path fill="currentColor" d="M12 16h-2v-4H6v-2h4V6h2v4h4v2h-4Zm6 4H4v-1H3v-1H2V4h1V3h1V2h14v1h1v1h1v14h-1v1h-1Zm-1-2v-1h1V5h-1V4H5v1H4v12h1v1Z"/>
                  </svg>
                  <svg v-else xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">
                    <path fill="currentColor" d="M18 20H4v-1H3v-1H2V4h1V3h1V2h14v1h1v1h1v14h-1v1h-1Zm-6-4v-4h4v-2h-4V6h-2v4H6v2h4v4Z"/>
                  </svg>
                </button>
              </div>
            </div>
        </div>
        
        <!-- 搜索结果统计信息 -->
        <div v-if="searchResults.length > 0" class="text-center mt-4 mb-2">
          <span class="text-pink-300 text-sm">
            显示第 {{ searchResults.length ? (currentPage - 1) * pageSize + 1 : 0 }}-{{ Math.min(currentPage * pageSize, searchResults.length) }} 个歌单
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
        <div v-else-if="searchResults.length > 0" class="text-center mt-4 mb-2">
          <span class="text-pink-300 text-sm">
            共 {{ searchResults.length }} 个歌单
          </span>
        </div>
      </div>
      </div> <!-- 歌单内容结束 -->
    </div>
  </div>
</template>

<script>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { downloadsApi } from '../api/downloads'
import PaginationControls from './PaginationControls.vue'
import { useTheme } from '../composables/useTheme'
import { useCollapseButton } from '../composables/useCollapseButton'
import { useMediaQuery } from '../composables/useMediaQuery'
import { copyText, shareOrCopy } from '../lib/share'
import { httpsCover as sharedHttpsCover } from '../lib/url'

export default {
  name: 'PlaylistPanel',
  components: {
    PaginationControls
  },
  props: {
    activeTab: {
      type: String,
      default: 'my'
    },
    searchQuery: {
      type: String,
      default: ''
    },
    userPlaylists: {
      type: Array,
      default: () => []
    },
    searchResults: {
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
  emits: ['select-playlist', 'add-playlist', 'remove-playlist', 'search', 'search-by-id', 'update:searchQuery', 'update:activeTab', 'go-to-page', 'prev-page', 'next-page', 'toggle-collapse', 'playlist-downloads-deleted'],
  setup(props, { emit }) {
    const { currentTheme } = useTheme()
    const openMenuId = ref(null)
    const menuPositions = ref({})
    const addingPlaylists = ref(new Set()) // 正在添加的歌单ID集合
    const addingTimeouts = ref(new Map()) // 防抖定时器

    // HTTPS 部署下 http: 封面会被浏览器混拦——网易图床均支持 TLS，显式升级
    // （共享 helper 见 lib/url.js，歌曲封面/歌单封面/任务封面同一来源）
    const httpsCover = sharedHttpsCover

    // 移动端检测（该面板用 lg 断点折叠）
    const isMobile = useMediaQuery('(max-width: 1023px)')

    // 折叠按钮位置计算：折叠时居中，展开后保持同一像素位置
    const panelContainer = ref(null)
    const { collapseButtonRef, fixedButtonTop } = useCollapseButton(panelContainer, () => props.collapsed)

    // 折叠功能
    const toggleCollapse = () => {
      emit('toggle-collapse')
    }

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
    
    const tabButtonStyle = computed(() => {
      if (currentTheme.value === 'pixel-retro') {
        return 'inset 0 2px 4px rgba(240, 179, 192, 0.3)'
      } else {
        return 'inset 0 2px 4px rgba(0,0,0,0.3)'
      }
    })
    
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
      // 清理所有定时器
      addingTimeouts.value.forEach(timeoutId => clearTimeout(timeoutId))
      addingTimeouts.value.clear()
      addingPlaylists.value.clear()
    })

    const showAddPlaylist = computed(() => props.activeTab === 'discover')

    // 分页计算属性 - 我的歌单库
    const totalPagesMyPlaylists = computed(() => {
      return Math.ceil(props.userPlaylists.length / props.pageSize)
    })
    
    const paginatedMyPlaylists = computed(() => {
      const start = (props.currentPage - 1) * props.pageSize
      const end = start + props.pageSize
      return props.userPlaylists.slice(start, end)
    })

    // 分页计算属性 - 搜索结果
    const totalPagesSearchResults = computed(() => {
      return Math.ceil(props.searchResults.length / props.pageSize)
    })
    
    const paginatedSearchResults = computed(() => {
      const start = (props.currentPage - 1) * props.pageSize
      const end = start + props.pageSize
      return props.searchResults.slice(start, end)
    })

    // 当前显示的总页数
    const totalPages = computed(() => {
      return showAddPlaylist.value ? totalPagesSearchResults.value : totalPagesMyPlaylists.value
    })

    // 当前显示的歌单列表
    const currentPlaylists = computed(() => {
      return showAddPlaylist.value ? paginatedSearchResults.value : paginatedMyPlaylists.value
    })

    // 从URL或文本中提取歌单ID
    const extractPlaylistId = (input) => {
      // 匹配网易云音乐歌单URL中的ID
      const urlMatch = input.match(/[?&]id=(\d+)/)
      if (urlMatch) {
        return urlMatch[1]
      }
      
      // 检查是否是纯数字ID
      if (/^\d+$/.test(input.trim())) {
        return input.trim()
      }
      
      return null
    }

    // 处理搜索或直接加载歌单
    const handleSearch = () => {
      if (!props.searchQuery.trim()) {
        return
      }
      
      const playlistId = extractPlaylistId(props.searchQuery)
      
      if (playlistId) {
        // 直接加载歌单并添加到库中
        emit('search-by-id', playlistId)
      } else {
        // 搜索歌单
        emit('search', props.searchQuery)
      }
    }

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
        const currentPlaylist = currentPlaylists.value.find(p => p.id === playlistId)
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

    const copyShareLink = async (playlist) => {
      const url = `${window.location.origin}/?playlist=${playlist.id}`
      const ok = await copyText(url)
      if (!ok) {
        alert('复制失败，请手动复制链接')
      }
      closeMenu()
    }

    // 分享歌单（与歌曲分享一致的逻辑：Web Share API + 复制降级）
    const sharePlaylist = async (playlist) => {
      const shareUrl = `${window.location.origin}/?playlist=${playlist.id}`
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
        emit('playlist-downloads-deleted', playlist.id)
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

    // 处理添加歌单（带防抖）
    const handleAddPlaylist = (playlist) => {
      const playlistId = playlist.id
      
      // 如果已经在添加中或已经添加过，直接返回
      if (addingPlaylists.value.has(playlistId) || props.userPlaylists.find(p => String(p.id) === String(playlistId))) {
        return
      }
      
      // 清除之前的定时器
      if (addingTimeouts.value.has(playlistId)) {
        clearTimeout(addingTimeouts.value.get(playlistId))
      }
      
      // 立即标记为添加中
      addingPlaylists.value.add(playlistId)
      
      // 设置防抖定时器
      const timeoutId = setTimeout(() => {
        emit('add-playlist', playlist)
        
        // 设置10秒超时清理机制，防止添加状态永久保持
        const cleanupTimeoutId = setTimeout(() => {
          if (addingPlaylists.value.has(playlistId)) {
            addingPlaylists.value.delete(playlistId)
            addingTimeouts.value.delete(playlistId)
          }
        }, 10000) // 10秒超时
        
        addingTimeouts.value.set(playlistId, cleanupTimeoutId)
      }, 300) // 300ms防抖
      
      addingTimeouts.value.set(playlistId, timeoutId)
    }

    // 检查歌单是否正在添加中
    const isPlaylistAdding = (playlistId) => {
      return addingPlaylists.value.has(playlistId)
    }

    // 监听userPlaylists变化，清除已添加歌单的添加状态
    watch(() => props.userPlaylists, (newPlaylists, oldPlaylists) => {
      if (newPlaylists && oldPlaylists) {
        // 找出新添加的歌单
        const newPlaylistIds = newPlaylists.map(p => p.id)
        const oldPlaylistIds = oldPlaylists.map(p => p.id)
        
        newPlaylistIds.forEach(playlistId => {
          if (!oldPlaylistIds.includes(playlistId) && addingPlaylists.value.has(playlistId)) {
            // 歌单已成功添加，清除添加状态
            addingPlaylists.value.delete(playlistId)
            if (addingTimeouts.value.has(playlistId)) {
              clearTimeout(addingTimeouts.value.get(playlistId))
              addingTimeouts.value.delete(playlistId)
            }
          }
        })
      }
    }, { deep: true })

    return {
       showAddPlaylist,
       totalPages,
       currentPlaylists,

       extractPlaylistId,
       handleSearch,
       paginationStyle,
       tabButtonStyle,
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
       handleAddPlaylist,
       isPlaylistAdding,
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
<template>
  <div class="lg:col-span-1">
    <div class="jirai-card p-6 max-h-96 overflow-y-auto flex flex-col">
      <!-- 选项卡导航 -->
      <div class="flex mb-4 sticky top-0 backdrop-blur-md z-10 -mx-6 px-6">
        <button
          @click="$emit('update:activeTab', 'my')"
          class="flex-1 py-2 px-4 text-center transition-all duration-200 border-2 relative overflow-hidden group"
          :class="!showAddPlaylist ? 'bg-pink-900 border-pink-500 text-pink-100 shadow-inner' : 'bg-gray-900 border-gray-600 text-gray-300 hover:bg-pink-950 hover:border-pink-600 hover:text-pink-200 border-r-0'"
          style="border-radius: 0; box-shadow: inset 0 2px 4px rgba(0,0,0,0.3);"
        >
          <span class="relative z-10 font-bold tracking-wide text-sm uppercase">我的歌单</span>
          <div class="absolute inset-0 bg-pink-800/20 opacity-0 group-hover:opacity-100 transition-opacity duration-200"></div>
        </button>
        <button
          @click="$emit('update:activeTab', 'discover')"
          class="flex-1 py-2 px-4 text-center transition-all duration-200 border-2 relative overflow-hidden group"
          :class="showAddPlaylist ? 'bg-pink-900 border-pink-500 text-pink-100 shadow-inner' : 'bg-gray-900 border-gray-600 text-gray-300 hover:bg-pink-950 hover:border-pink-600 hover:text-pink-200 border-l-0'"
          style="border-radius: 0; box-shadow: inset 0 2px 4px rgba(0,0,0,0.3);"
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
                  :src="playlist.coverImgUrl"
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
            <button
              @click.stop="$emit('remove-playlist', playlist.id)"
              class="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity bg-red-600 hover:bg-red-700 text-white text-xs px-2 py-1 border border-red-400"
              style="border-radius: 0;"
            >
              🗑️
            </button>
          </div>
        </div>
        
        <!-- 歌单统计信息 -->
        <div class="text-center mt-4 mb-2">
          <span class="text-pink-300 text-sm">
            显示第 {{ (currentPage - 1) * pageSize + 1 }}-{{ Math.min(currentPage * pageSize, userPlaylists.length) }} 个歌单
          </span>
        </div>
        
        <!-- 分页控件 -->
        <div v-if="totalPages > 1" class="flex justify-center items-center space-x-1 mt-4 mb-4 p-3 backdrop-blur-md bg-black/30">
          <button 
            @click="$emit('go-to-page', 1)" 
            :disabled="currentPage === 1"
            class="pixel-button text-xs px-2 py-1 bg-pink-600 hover:bg-pink-500 text-white font-bold flex items-center justify-center min-w-[32px]"
            :class="{ 'opacity-50 cursor-not-allowed bg-gray-600': currentPage === 1 }"
          >
            ⇤
          </button>
          
          <button 
            @click="$emit('prev-page')" 
            :disabled="currentPage === 1"
            class="pixel-button text-xs px-2 py-1 bg-pink-600 hover:bg-pink-500 text-white font-bold flex items-center justify-center min-w-[32px]"
            :class="{ 'opacity-50 cursor-not-allowed bg-gray-600': currentPage === 1 }"
          >
            ←
          </button>
          
          <span class="text-pink-300 text-xs px-2 py-1 min-w-[48px] text-center">
            {{ currentPage }}/{{ totalPages }}
          </span>
          
          <button 
            @click="$emit('next-page')" 
            :disabled="currentPage === totalPages"
            class="pixel-button text-xs px-2 py-1 bg-pink-600 hover:bg-pink-500 text-white font-bold flex items-center justify-center min-w-[32px]"
            :class="{ 'opacity-50 cursor-not-allowed bg-gray-600': currentPage === totalPages }"
          >
            →
          </button>
          
          <button 
            @click="$emit('go-to-page', totalPages)" 
            :disabled="currentPage === totalPages"
            class="pixel-button text-xs px-2 py-1 bg-pink-600 hover:bg-pink-500 text-white font-bold flex items-center justify-center min-w-[32px]"
            :class="{ 'opacity-50 cursor-not-allowed bg-gray-600': currentPage === totalPages }"
          >
            ⇥
          </button>
        </div>
        
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
                    :src="playlist.coverImgUrl"
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
              <button
                @click.stop="$emit('add-playlist', playlist)"
                class="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity bg-green-600 hover:bg-green-700 text-white text-xs px-2 py-1 border border-green-400"
                style="border-radius: 0;"
                :disabled="userPlaylists.find(p => p.id === playlist.id)"
                :class="{ 'opacity-50 cursor-not-allowed bg-gray-600': userPlaylists.find(p => p.id === playlist.id) }"
              >
                {{ userPlaylists.find(p => p.id === playlist.id) ? '✅' : '➕' }}
              </button>
            </div>
        </div>
        
        <!-- 搜索结果统计信息 -->
        <div class="text-center mt-4 mb-2">
          <span class="text-pink-300 text-sm">
            显示第 {{ (currentPage - 1) * pageSize + 1 }}-{{ Math.min(currentPage * pageSize, searchResults.length) }} 个歌单
          </span>
        </div>
        
        <!-- 分页控件 -->
        <div v-if="totalPages > 1" class="flex justify-center items-center space-x-1 mt-4 mb-4 p-3 backdrop-blur-md bg-black/30">
          <button 
            @click="$emit('go-to-page', 1)" 
            :disabled="currentPage === 1"
            class="pixel-button text-xs px-2 py-1 bg-pink-600 hover:bg-pink-500 text-white font-bold flex items-center justify-center min-w-[32px]"
            :class="{ 'opacity-50 cursor-not-allowed bg-gray-600': currentPage === 1 }"
          >
            ⇤
          </button>
          
          <button 
            @click="$emit('prev-page')" 
            :disabled="currentPage === 1"
            class="pixel-button text-xs px-2 py-1 bg-pink-600 hover:bg-pink-500 text-white font-bold flex items-center justify-center min-w-[32px]"
            :class="{ 'opacity-50 cursor-not-allowed bg-gray-600': currentPage === 1 }"
          >
            ←
          </button>
          
          <span class="text-pink-300 text-xs px-2 py-1 min-w-[48px] text-center">
            {{ currentPage }}/{{ totalPages }}
          </span>
          
          <button 
            @click="$emit('next-page')" 
            :disabled="currentPage === totalPages"
            class="pixel-button text-xs px-2 py-1 bg-pink-600 hover:bg-pink-500 text-white font-bold flex items-center justify-center min-w-[32px]"
            :class="{ 'opacity-50 cursor-not-allowed bg-gray-600': currentPage === totalPages }"
          >
            →
          </button>
          
          <button 
            @click="$emit('go-to-page', totalPages)" 
            :disabled="currentPage === totalPages"
            class="pixel-button text-xs px-2 py-1 bg-pink-600 hover:bg-pink-500 text-white font-bold flex items-center justify-center min-w-[32px]"
            :class="{ 'opacity-50 cursor-not-allowed bg-gray-600': currentPage === totalPages }"
          >
            ⇥
          </button>
        </div>
        
        <!-- 当只有一页时的提示 -->
        <div v-else-if="searchResults.length > 0" class="text-center mt-4 mb-2">
          <span class="text-pink-300 text-sm">
            共 {{ searchResults.length }} 个歌单
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { ref, computed } from 'vue'

export default {
  name: 'PlaylistPanel',
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
    playlists: {
      type: Array,
      default: () => []
    },
    currentPage: {
      type: Number,
      default: 1
    },
    pageSize: {
      type: Number,
      default: 10
    }
  },
  emits: ['select-playlist', 'add-playlist', 'remove-playlist', 'search', 'search-by-id', 'update:searchQuery', 'update:activeTab', 'go-to-page', 'prev-page', 'next-page'],
  setup(props, { emit }) {
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

    // 当前显示的总数量
    const totalCount = computed(() => {
      return showAddPlaylist.value ? props.searchResults.length : props.userPlaylists.length
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

    return {
      showAddPlaylist,
      totalPages,
      currentPlaylists,
      totalCount,
      extractPlaylistId,
      handleSearch
    }
  }
}
</script>
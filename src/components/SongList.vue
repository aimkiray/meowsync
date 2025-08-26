<template>
  <div class="lg:col-span-1">
    <div class="jirai-card p-6 max-h-96 overflow-y-auto flex flex-col">
      <h2 class="text-xl font-bold mb-4 flex items-center justify-between text-pink-300 sticky top-0 backdrop-blur-md z-10 py-2 px-2" style="background: rgba(26, 26, 46, 0.9);">
        <span class="flex items-center">歌曲列表</span>
        <div class="flex items-center space-x-2">
          <button
            @click="$emit('toggle-play-mode')"
            class="text-xs px-2 py-1 border transition-colors bg-blue-600 text-white border-blue-400 hover:bg-blue-500"
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
            {{ showVipSongs ? '隐藏VIP' : '显示VIP' }}
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
        <div class="space-y-2 mb-4 -mx-6 px-6 flex-1 overflow-y-auto">
          <div
            v-for="(song, index) in paginatedSongs"
            :key="song.id"
            @click="$emit('play-song', song, filteredSongs.findIndex(s => s.id === song.id))"
            class="music-card cursor-pointer p-4 jirai-card transition-all w-full"
            :class="{ 
              'border-purple-400': currentSong?.id === song.id,
              'opacity-50 grayscale': song.fee === 1 || song.privilege?.fee === 1
            }"
          >
            <div class="flex items-center space-x-3">
              <div class="relative">
                <img
                  :src="song.al?.picUrl || song.album?.picUrl"
                  :alt="song.name"
                  class="w-12 h-12 object-cover border-2 border-pink-400"
                  style="border-radius: 0; image-rendering: pixelated;"
                />
                <div v-if="currentSong?.id === song.id && isPlaying" class="absolute inset-0 flex items-center justify-center bg-black/50">
                  <div class="text-pink-300 text-sm animate-pulse flex items-center justify-center">♡</div>
                </div>
              </div>
              <div class="flex-1 min-w-0">
                <h4 class="font-medium text-pink-300 truncate flex items-center">
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
          </div>
        </div>
        
        <!-- 歌曲统计信息 -->
        <div class="text-center mt-4 mb-2">
          <span class="text-pink-300 text-sm">
            显示第 {{ (currentPage - 1) * pageSize + 1 }}-{{ Math.min(currentPage * pageSize, filteredSongs.length) }} 首歌曲
          </span>
        </div>
        
        <!-- 分页控件 -->
        <div v-if="totalPages > 1" class="flex justify-center items-center space-x-1 mt-4 mb-4 p-3 backdrop-blur-md bg-black/30 sticky bottom-0 z-10">
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
          
          <span class="text-pink-300 text-xs px-2 py-1 bg-black/50 min-w-[48px] text-center">
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
</template>

<script>
import { computed } from 'vue'

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
    }
  },
  emits: ['play-song', 'toggle-play-mode', 'toggle-vip-songs', 'go-to-page', 'prev-page', 'next-page'],
  setup(props) {
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

    return {
      filteredSongs,
      totalPages,
      paginatedSongs,
      formatDuration
    }
  }
}
</script>
<template>
  <div class="lg:col-span-1">
    <div ref="playerContainer" class="jirai-card p-6 max-h-96 overflow-y-auto flex flex-col">
      <h2 class="text-xl font-bold mb-4 flex items-center justify-between text-pink-300 sticky top-0 backdrop-blur-md z-10 py-2 px-2" style="background: rgba(26, 26, 46, 0.9);">
        <span class="flex items-center">歌词</span>
        <button 
          @click="$emit('toggle-auto-follow-lyrics')" 
          class="text-xs px-2 py-1 border transition-colors"
          :class="{
            'bg-gray-700 text-gray-300 border-gray-500 hover:bg-gray-600': autoFollowLyrics,
            'bg-pink-500 text-white border-pink-400': !autoFollowLyrics
          }"
          :title="autoFollowLyrics ? '关闭自动跟随' : '开启自动跟随'"
        >
          {{ autoFollowLyrics ? '跟随' : '手动' }}
        </button>
      </h2>
      
      <div v-if="!currentSong" class="text-center py-8">
        <p class="text-gray-600">选择一首歌开始播放喵~</p>
      </div>
      
      <div v-else class="-mx-6 px-6 flex-1 flex flex-col">
        <!-- 当前播放歌曲信息 -->
        <div class="text-center mb-6">
          <!-- 时长警告提示 -->
          <div v-if="durationWarning" class="mb-3 p-2 bg-yellow-100 border-2 border-yellow-400 text-yellow-800 text-xs">
            ⚠️ {{ durationWarning }}
          </div>
          
          <div class="relative mx-auto w-32 h-32">
            <img
              :src="currentSong.al?.picUrl || currentSong.album?.picUrl"
              :alt="currentSong.name"
              class="w-full h-full object-cover border-4 border-pink-400"
              :class="{ 'playing-animation': isPlaying }"
              style="border-radius: 0; image-rendering: pixelated;"
            />
          </div>
          <h3 class="mt-3 text-lg font-bold text-pink-300">{{ currentSong.name }}</h3>
          <p class="text-purple-300">
            {{ currentSong.ar?.map(a => a.name).join(', ') || currentSong.artists?.map(a => a.name).join(', ') }}
          </p>
        </div>
        
        <div v-if="songSwitching" class="text-center py-8">
          <div class="pixel-loading mx-auto mb-4"></div>
          <p class="text-yellow-300 flex justify-center items-center font-bold">正在切换歌曲喵...</p>
        </div>
        
        <div v-else-if="loadingLyrics" class="text-center py-8">
          <div class="pixel-loading mx-auto mb-4"></div>
          <p class="text-pink-300 flex justify-center items-center">加载歌词中喵...</p>
        </div>
        
        <div v-else ref="lyricsContainer" class="space-y-2 jirai-lyrics flex-1">
          <div
            v-for="(lyric, index) in lyrics"
            :key="index"
            :data-lyric-index="index"
            class="text-center py-1 transition-all duration-300 lyric-line"
            :class="{
              'text-pink-300 font-bold text-lg glow-text': index === currentLyricIndex,
              'text-purple-300': index !== currentLyricIndex
            }"
          >
            <p>{{ lyric.text }}</p>
            <p v-if="lyric.translation" class="text-sm mt-1">
              {{ lyric.translation }}
            </p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { ref, watch, nextTick } from 'vue'

export default {
  name: 'LyricsPanel',
  props: {
    currentSong: {
      type: Object,
      default: null
    },
    lyrics: {
      type: Array,
      default: () => []
    },
    currentLyricIndex: {
      type: Number,
      default: 0
    },
    isPlaying: {
      type: Boolean,
      default: false
    },
    songSwitching: {
      type: Boolean,
      default: false
    },
    loadingLyrics: {
      type: Boolean,
      default: false
    },
    durationWarning: {
      type: String,
      default: ''
    },
    autoFollowLyrics: {
      type: Boolean,
      default: true
    }
  },
  emits: ['toggle-auto-follow-lyrics'],
  setup(props) {
    const playerContainer = ref(null)
    const lyricsContainer = ref(null)

    // 监听当前歌词索引变化，实现自动滚动
    watch(() => props.currentLyricIndex, async (newIndex) => {
      if (newIndex >= 0 && playerContainer.value && props.autoFollowLyrics) {
        await nextTick()
        const container = playerContainer.value
        const currentLyricElement = container.querySelector(`[data-lyric-index="${newIndex}"]`)
        
        if (currentLyricElement && container) {
          // 计算当前歌词元素相对于播放器容器的位置
          const containerRect = container.getBoundingClientRect()
          const lyricRect = currentLyricElement.getBoundingClientRect()
          
          // 计算需要滚动的距离，使当前歌词居中显示
          const containerCenter = containerRect.height / 2
          const lyricCenter = lyricRect.top - containerRect.top + lyricRect.height / 2
          const scrollOffset = lyricCenter - containerCenter
          
          // 平滑滚动到目标位置
          container.scrollTo({
            top: container.scrollTop + scrollOffset,
            behavior: 'smooth'
          })
        }
      }
    })

    return {
      playerContainer,
      lyricsContainer
    }
  }
}
</script>
<template>
  <div
    v-if="currentSong"
    class="fixed bottom-0 left-0 right-0 jirai-card z-50 backdrop-blur-md"
    style="margin: 0; border-radius: 0; border-bottom: none; border-left: none; border-right: none; background: rgba(26, 26, 46, 0.9); border-top: 4px solid var(--jirai-pink);"
  >
    <div class="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8">
      <!-- 移动端布局 -->
      <div class="block md:hidden">
        <!-- 进度条 - 移动端顶部 -->
        <div class="py-2">
          <div class="flex items-center space-x-2">
            <span class="text-xs text-pink-300 w-10 text-center">{{ formatTime(currentTime) }}</span>
            <div class="flex-1 pixel-progress cursor-pointer" @click="$emit('seek-to', $event)">
              <div
                class="pixel-progress-fill transition-all duration-300"
                :style="{ width: progressPercentage + '%' }"
              ></div>
            </div>
            <span class="text-xs text-pink-300 w-10 text-center">{{ formatTime(duration) }}</span>
          </div>
        </div>
        
        <!-- 主要控制区域 -->
        <div class="flex items-center justify-between pb-3">
          <!-- 歌曲信息 -->
          <div class="flex items-center space-x-3 flex-1 min-w-0">
            <img
              :src="currentSong.al?.picUrl"
              :alt="currentSong.name"
              class="w-12 h-12 object-cover flex-shrink-0 border-2 border-pink-400"
              :class="{ 'playing-animation': isPlaying }"
              style="border-radius: 0; image-rendering: pixelated;"
            />
            <div class="min-w-0 flex-1">
              <h4 class="font-medium text-pink-300 truncate text-sm">{{ currentSong.name }}</h4>
              <p class="text-xs text-purple-300 truncate">
                {{ currentSong.ar?.map(artist => artist.name).join(', ') }}
              </p>
            </div>
          </div>

          <!-- 播放控制 -->
          <div class="flex items-center space-x-1 flex-shrink-0">
            <button
              @click="$emit('previous-song')"
              class="jirai-button p-1 text-sm w-8 h-8 flex items-center justify-center"
            >
              ◀◀
            </button>
            <button
              @click="$emit('toggle-play')"
              class="jirai-button-primary p-1 text-sm w-8 h-8 flex items-center justify-center"
            >
              {{ isPlaying ? '■' : '▶' }}
            </button>
            <button
              @click="$emit('next-song')"
              class="jirai-button p-1 text-sm w-8 h-8 flex items-center justify-center"
            >
              ▶▶
            </button>
          </div>
        </div>
      </div>

      <!-- 桌面端布局 -->
      <div class="hidden md:block py-4">
        <!-- 进度条 - 桌面端顶部 -->
        <div class="mb-4">
          <div class="flex items-center space-x-2">
            <span class="text-xs text-pink-300 w-12 text-center">{{ formatTime(currentTime) }}</span>
            <div class="flex-1 pixel-progress cursor-pointer" @click="$emit('seek-to', $event)">
              <div
                class="pixel-progress-fill transition-all duration-300"
                :style="{ width: progressPercentage + '%' }"
              ></div>
            </div>
            <span class="text-xs text-pink-300 w-12 text-center">{{ formatTime(duration) }}</span>
          </div>
        </div>
        
        <!-- 主要控制区域 -->
        <div class="flex items-center">
          <!-- 歌曲信息 -->
          <div class="flex items-center space-x-4 flex-1 min-w-0">
            <img
              :src="currentSong.al?.picUrl"
              :alt="currentSong.name"
              class="w-12 h-12 object-cover border-2 border-pink-400"
              :class="{ 'playing-animation': isPlaying }"
              style="border-radius: 0; image-rendering: pixelated;"
            />
            <div class="min-w-0 flex-1">
              <h4 class="font-medium text-pink-300 truncate">{{ currentSong.name }}</h4>
              <p class="text-sm text-purple-300 truncate">
                {{ currentSong.ar?.map(artist => artist.name).join(', ') }}
              </p>
            </div>
          </div>

          <!-- 中央控制区域：播放控制 + 音量控制 -->
          <div class="flex items-center space-x-6">
            <!-- 播放控制 -->
            <div class="flex items-center space-x-4">
              <button
                @click="$emit('previous-song')"
                class="jirai-button p-3 text-xl w-12 h-12 flex items-center justify-center"
              >
                ◀◀
              </button>
              <button
                @click="$emit('toggle-play')"
                class="jirai-button-primary p-3 text-xl w-12 h-12 flex items-center justify-center"
              >
                {{ isPlaying ? '■' : '▶' }}
              </button>
              <button
                @click="$emit('next-song')"
                class="jirai-button p-3 text-xl w-12 h-12 flex items-center justify-center"
              >
                ▶▶
              </button>
            </div>

            <!-- 音量控制 -->
            <div class="flex items-center space-x-2">
              <span class="text-lg text-pink-300">♪</span>
              <input
                :value="volume"
                type="range"
                min="0"
                max="100"
                class="w-20 jirai-slider"
                @input="$emit('update-volume', $event.target.value)"
              />
              <span class="text-sm text-pink-300 w-8">{{ volume }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { computed } from 'vue'

export default {
  name: 'BottomPlayer',
  props: {
    currentSong: {
      type: Object,
      default: null
    },
    isPlaying: {
      type: Boolean,
      default: false
    },
    currentTime: {
      type: Number,
      default: 0
    },
    duration: {
      type: Number,
      default: 0
    },
    volume: {
      type: Number,
      default: 80
    }
  },
  emits: ['toggle-play', 'previous-song', 'next-song', 'seek-to', 'update-volume'],
  setup(props) {
    const progressPercentage = computed(() => {
      return props.duration > 0 ? (props.currentTime / props.duration) * 100 : 0
    })

    // 格式化时间
    const formatTime = (seconds) => {
      const mins = Math.floor(seconds / 60)
      const secs = Math.floor(seconds % 60)
      return `${mins}:${secs.toString().padStart(2, '0')}`
    }

    return {
      progressPercentage,
      formatTime
    }
  }
}
</script>
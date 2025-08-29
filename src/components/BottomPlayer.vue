<template>
  <div
    v-if="currentSong"
    class="fixed bottom-0 left-0 right-0 jirai-card z-50 backdrop-blur-md transition-transform duration-300"
    :class="{ 'translate-y-full': isHidden }"
    style="margin: 0; border-radius: 0; border-bottom: none; border-left: none; border-right: none; background: rgba(240, 192, 192, 0.2); border-top: 4px solid var(--jirai-pink);"
  >
    <div class="px-3 sm:px-6 lg:px-8">
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
              :disabled="songSwitching"
              class="jirai-button-primary p-1 text-sm w-8 h-8 flex items-center justify-center"
              :class="{ 'opacity-50 cursor-not-allowed': songSwitching }"
            >
              {{ songSwitching ? '⏳' : (isPlaying ? '■' : '▶') }}
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
        <div class="max-w-7xl px-4 sm:px-6 lg:px-8 mx-auto">
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
            <div class="flex items-center justify-between">
              <!-- 歌曲信息 -->
              <div class="flex items-center space-x-4 min-w-0 flex-1">
                <img
                  :src="currentSong.al?.picUrl"
                  :alt="currentSong.name"
                  class="w-12 h-12 object-cover border-2 border-pink-400 flex-shrink-0"
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

              <!-- 右侧控制区域 -->
              <div class="flex items-center space-x-6 flex-shrink-0">
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

                <!-- 播放控制 -->
                <div class="flex items-center space-x-3">
                  <button
                    @click="$emit('previous-song')"
                    class="jirai-button p-3 text-xl w-12 h-12 flex items-center justify-center"
                  >
                    ◀◀
                  </button>
                  <button
                    @click="$emit('toggle-play')"
                    :disabled="songSwitching"
                    class="jirai-button-primary p-3 text-xl w-12 h-12 flex items-center justify-center"
                    :class="{ 'opacity-50 cursor-not-allowed': songSwitching }"
                  >
                    {{ songSwitching ? '⏳' : (isPlaying ? '■' : '▶') }}
                  </button>
                  <button
                    @click="$emit('next-song')"
                    class="jirai-button p-3 text-xl w-12 h-12 flex items-center justify-center"
                  >
                    ▶▶
                  </button>
                </div>
              </div>
            </div>
        </div>
      </div>
    </div>
  </div>
  
  <!-- 隐藏按钮 - 浮动在播放器外部右上角 -->
  <div
    v-if="currentSong && !isHidden"
    class="fixed right-4 z-50 bottom-[100px] md:bottom-[140px]"
  >
    <button
      @click="toggleHidden"
      class="jirai-button p-1 text-xs w-6 h-6 flex items-center justify-center backdrop-blur-md"
      :style="hideButtonStyle"
      title="隐藏播放器"
    >
      ▼
    </button>
  </div>
  
  <!-- 当播放器隐藏时显示的小按钮 -->
  <div
    v-if="currentSong && isHidden"
    class="fixed bottom-4 right-4 z-50"
  >
    <button
      @click="toggleHidden"
      class="jirai-button-primary p-2 text-sm w-10 h-10 flex items-center justify-center backdrop-blur-md"
      :style="showButtonStyle"
      title="显示播放器"
    >
      ♪
    </button>
  </div>
</template>

<script>
import { computed, ref, onMounted, onUnmounted } from 'vue'

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
    },
    songSwitching: {
      type: Boolean,
      default: false
    }
  },
  emits: ['toggle-play', 'previous-song', 'next-song', 'seek-to', 'update-volume'],
  setup(props) {
    const isHidden = ref(false)
    const currentTheme = ref('default')
    
    // 检测当前主题
    const detectTheme = () => {
      const root = document.documentElement
      currentTheme.value = root.getAttribute('data-theme') === 'pixel-retro' ? 'pixel-retro' : 'default'
    }
    
    // 动态样式
    const hideButtonStyle = computed(() => {
      if (currentTheme.value === 'pixel-retro') {
        return {
          background: 'rgba(240, 179, 192, 0.8)',
          border: '2px solid var(--jirai-pink)'
        }
      } else {
        return {
          background: 'rgba(255, 192, 203, 0.8)',
          border: '2px solid var(--jirai-pink)'
        }
      }
    })
    
    const showButtonStyle = computed(() => {
      if (currentTheme.value === 'pixel-retro') {
        return {
          background: 'rgba(240, 179, 192, 0.8)',
          border: '2px solid var(--jirai-pink)'
        }
      } else {
        return {
          background: 'rgba(255, 192, 203, 0.8)',
          border: '2px solid var(--jirai-pink)'
        }
      }
    })
    
    // 监听主题变化
    const observer = new MutationObserver(() => {
      detectTheme()
    })
    
    onMounted(() => {
      detectTheme()
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme']
      })
    })
    
    onUnmounted(() => {
      observer.disconnect()
    })

    const toggleHidden = () => {
      isHidden.value = !isHidden.value
    }
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
      formatTime,
      isHidden,
      toggleHidden,
      hideButtonStyle,
      showButtonStyle
    }
  }
}
</script>
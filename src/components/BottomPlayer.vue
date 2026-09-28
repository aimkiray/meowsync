<template>
  <div
    v-if="currentSong"
    class="jirai-card card-player bottom-player"
  >
    <!-- 顶部进度条（兼作上边框） -->
    <div
      class="player-progress-bar cursor-pointer absolute top-0 left-0 right-0"
      @click="onSeekClick"
    >
      <div
        class="player-progress-fill"
        :style="{ width: progressPercentage + '%' }"
      ></div>
    </div>
    <div class="px-3 sm:px-6 lg:px-8">
      <!-- 移动端布局 -->
      <div class="block md:hidden">
        <!-- 控制区域（含时间） -->
        <div class="flex items-center justify-between py-3">
          <!-- 歌曲信息 -->
          <div class="flex items-center space-x-3 flex-1 min-w-0 mr-2">
            <img
              v-if="currentSong.al?.picUrl || currentSong.album?.picUrl"
              :src="httpsCover(currentSong.al?.picUrl || currentSong.album?.picUrl)"
              :alt="currentSong.name"
              class="w-12 h-12 object-cover flex-shrink-0 border-2 border-pink-400"
              :class="{ 'playing-animation': isPlaying }"
              style="border-radius: 0; image-rendering: pixelated;"
            />
            <div
              v-else
              class="w-12 h-12 flex items-center justify-center flex-shrink-0 border-2 border-pink-400 text-pink-300"
              style="border-radius: 0;"
            >♪</div>
            <div class="min-w-0 flex-1">
              <h4 class="font-medium text-pink-300 truncate text-sm">{{ currentSong.name }}</h4>
              <p class="text-xs text-purple-300 truncate">
                {{ currentSong.ar?.map(artist => artist.name).join(', ') }}
              </p>
            </div>
          </div>

          <!-- 播放控制 + 时间 -->
          <div class="flex items-center space-x-1 flex-shrink-0">
            <button
              @click="$emit('toggle-lyrics')"
              class="jirai-button bottom-player__icon-button p-1 text-sm w-8 h-8 flex items-center justify-center"
              :class="{ 'bottom-player__toggle--active': lyricsOpen }"
              title="歌词"
            >词</button>
            <button @click="$emit('open-fullscreen')" class="jirai-button bottom-player__icon-button p-1 text-sm w-8 h-8 flex items-center justify-center" title="全屏">
              <svg class="bottom-player__icon bottom-player__icon--mobile" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M8 4H4v4M16 4h4v4M20 16v4h-4M8 20H4v-4" />
              </svg>
            </button>
            <button @click="$emit('previous-song')" class="jirai-button p-1 text-sm w-8 h-8 flex items-center justify-center">◀◀</button>
            <button
              @click="$emit('toggle-play')"
              :disabled="songSwitching"
              class="jirai-button-primary p-1 text-sm w-8 h-8 flex items-center justify-center"
              :class="{ 'opacity-50 cursor-not-allowed': songSwitching }"
            >{{ songSwitching ? '⏳' : (isPlaying ? '■' : '▶') }}</button>
            <button @click="$emit('next-song')" class="jirai-button p-1 text-sm w-8 h-8 flex items-center justify-center">▶▶</button>
            <span class="text-xs text-pink-300 ml-2 whitespace-nowrap">{{ formatTime(currentTime) }} / {{ formatTime(duration) }}</span>
          </div>
        </div>
      </div>

      <!-- 桌面端布局 -->
      <div class="hidden md:block py-4">
        <div class="max-w-[1440px] px-4 sm:px-6 lg:px-8 mx-auto">
            <!-- 主要控制区域（含时间） -->
            <div class="flex items-center justify-between">
              <!-- 左：歌曲信息 -->
              <div class="flex items-center space-x-3 min-w-0 flex-1">
                <img
                  v-if="currentSong.al?.picUrl || currentSong.album?.picUrl"
                  :src="httpsCover(currentSong.al?.picUrl || currentSong.album?.picUrl)"
                  :alt="currentSong.name"
                  class="w-12 h-12 object-cover border-2 border-pink-400 flex-shrink-0"
                  :class="{ 'playing-animation': isPlaying }"
                  style="border-radius: 0; image-rendering: pixelated;"
                />
                <div
                  v-else
                  class="w-12 h-12 flex items-center justify-center border-2 border-pink-400 flex-shrink-0 text-pink-300"
                  style="border-radius: 0;"
                >♪</div>
                <div class="min-w-0 flex-1">
                  <h4 class="font-medium text-pink-300 truncate">{{ currentSong.name }}</h4>
                  <p class="text-sm text-purple-300 truncate">
                    {{ currentSong.ar?.map(artist => artist.name).join(', ') }}
                  </p>
                </div>
              </div>

              <!-- 右侧控制区域 -->
              <div class="flex items-center space-x-4 flex-shrink-0">
                <!-- 时间 + 音量控制 -->
                <div class="flex items-center space-x-4">
                  <span class="text-xs text-pink-300">{{ formatTime(currentTime) }} / {{ formatTime(duration) }}</span>
                  <div class="flex items-center space-x-2">
                    <svg class="w-4 h-4 text-pink-300 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/>
                    </svg>
                    <input
                      :value="Number(volume)"
                      type="range"
                      min="0"
                      max="100"
                      step="1"
                      class="w-20 jirai-slider"
                      @input="$emit('update-volume', Number($event.target.value))"
                    />
                  </div>
                </div>

                <!-- 播放控制 -->
                <div class="flex items-center space-x-3">
                  <!-- YTM 式歌词抽屉开关 -->
                  <button
                    @click="$emit('toggle-lyrics')"
                    class="jirai-button p-3 text-xl w-12 h-12 flex items-center justify-center bottom-player__icon-button"
                    :class="{ 'bottom-player__toggle--active': lyricsOpen }"
                    title="歌词"
                  >词</button>
                  <button @click="$emit('open-fullscreen')" class="jirai-button bottom-player__icon-button p-3 text-xl w-12 h-12 flex items-center justify-center" title="全屏">
                    <svg class="bottom-player__icon bottom-player__icon--desktop" viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M8 4H4v4M16 4h4v4M20 16v4h-4M8 20H4v-4" />
                    </svg>
                  </button>
                  <button @click="$emit('previous-song')" class="jirai-button p-3 text-xl w-12 h-12 flex items-center justify-center">◀◀</button>
                  <button
                    @click="$emit('toggle-play')"
                    :disabled="songSwitching"
                    class="jirai-button-primary p-3 text-xl w-12 h-12 flex items-center justify-center"
                    :class="{ 'opacity-50 cursor-not-allowed': songSwitching }"
                  >{{ songSwitching ? '⏳' : (isPlaying ? '■' : '▶') }}</button>
                  <button @click="$emit('next-song')" class="jirai-button p-3 text-xl w-12 h-12 flex items-center justify-center">▶▶</button>
                </div>
              </div>
            </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { computed } from 'vue'
import { formatTime } from '../lib/format'
import { httpsCover } from '../lib/url'

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
    },
    lyricsOpen: {
      type: Boolean,
      default: false
    }
  },
  emits: ['toggle-play', 'previous-song', 'next-song', 'seek-to', 'update-volume', 'open-fullscreen', 'toggle-lyrics'],
  setup(props, { emit }) {
    // 进度条点击 → 归一化比例 0-1（父组件负责换算为秒）
    const onSeekClick = (event) => {
      const rect = event.currentTarget.getBoundingClientRect()
      emit('seek-to', (event.clientX - rect.left) / rect.width)
    }

    const progressPercentage = computed(() => {
      return props.duration > 0
        ? Math.max(0, Math.min(100, (props.currentTime / props.duration) * 100))
        : 0
    })

    return {
      progressPercentage,
      formatTime,
      httpsCover,
      onSeekClick
    }
  }
}
</script>

<style scoped>
/* 文档流内嵌：应用壳 flex 列的最后一个子项，不再 fixed */
.bottom-player {
  position: relative;
  flex-shrink: 0;
  z-index: var(--z-player);
  margin: 0;
  border-radius: 0;
  border-bottom: none;
  border-left: none;
  border-right: none;
  border-top: none;
  /* 底色由全局 .card-player 提供（!important），scoped 再写是死代码 */
}

.bottom-player__icon-button {
  padding-left: 0;
  padding-right: 0;
}

/* 歌词抽屉开关的激活态 */
.bottom-player__toggle--active {
  background: #f472b6;
  color: #1a1a2e;
}

.bottom-player__icon {
  display: block;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: square;
  stroke-linejoin: miter;
}

.bottom-player__icon--mobile {
  width: 14px;
  height: 14px;
}

.bottom-player__icon--desktop {
  width: 18px;
  height: 18px;
}
</style>

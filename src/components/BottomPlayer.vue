<template>
  <div
    v-if="currentSong"
    class="jirai-card card-player bottom-player"
  >
    <!-- 顶部进度条：点击 + 拖拽 seek（pointer capture） -->
    <div
      ref="progressBar"
      class="player-progress-bar absolute top-0 left-0 right-0"
      :class="{ 'player-progress-bar--dragging': seeking }"
      @pointerdown="onSeekStart"
    >
      <div
        class="player-progress-fill"
        :style="{ width: progressPercentage + '%' }"
      ></div>
      <div
        class="player-progress-thumb"
        :style="{ left: progressPercentage + '%' }"
      ></div>
    </div>
    <div class="px-3 sm:px-6 lg:px-8">
      <!-- 移动端布局（lg 以下都用紧凑行——768~1023 桌面簇会把歌名挤没） -->
      <div class="block lg:hidden">
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
                {{ (currentSong.ar || currentSong.artists)?.map(artist => artist.name).join(', ') }}
              </p>
            </div>
          </div>

          <!-- 播放控制 + 时间 -->
          <div class="flex items-center space-x-1 flex-shrink-0">
            <button
              @click="$emit('toggle-side-panel', 'queue')"
              class="jirai-button bottom-player__icon-button p-1 text-sm w-8 h-8 flex items-center justify-center"
              :class="{ 'bottom-player__toggle--active': sidePanelOpen && panelTab === 'queue' }"
              title="待播队列"
            >☰</button>
            <button
              @click="$emit('toggle-side-panel', 'lyrics')"
              class="jirai-button bottom-player__icon-button p-1 text-sm w-8 h-8 flex items-center justify-center"
              :class="{ 'bottom-player__toggle--active': sidePanelOpen && panelTab === 'lyrics' }"
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
            <span class="text-xs text-pink-300 ml-2 whitespace-nowrap max-[420px]:hidden">{{ formatTime(currentTime) }} / {{ formatTime(duration) }}</span>
          </div>
        </div>
      </div>

      <!-- 桌面端布局：YTM 右簇 音量→循环→随机→队列→歌词→全屏 -->
      <div class="hidden lg:block py-4">
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
                    {{ (currentSong.ar || currentSong.artists)?.map(artist => artist.name).join(', ') }}
                  </p>
                </div>
              </div>

              <!-- 右侧控制区域 -->
              <div class="flex items-center space-x-4 flex-shrink-0">
                <!-- 播放控制 -->
                <div class="flex items-center space-x-3">
                  <button @click="$emit('previous-song')" class="jirai-button p-3 text-xl w-12 h-12 flex items-center justify-center">◀◀</button>
                  <button
                    @click="$emit('toggle-play')"
                    :disabled="songSwitching"
                    class="jirai-button-primary p-3 text-xl w-12 h-12 flex items-center justify-center"
                    :class="{ 'opacity-50 cursor-not-allowed': songSwitching }"
                  >{{ songSwitching ? '⏳' : (isPlaying ? '■' : '▶') }}</button>
                  <button @click="$emit('next-song')" class="jirai-button p-3 text-xl w-12 h-12 flex items-center justify-center">▶▶</button>
                </div>

                <!-- 时间 + 音量 + 辅助控制（YTM 右簇顺序） -->
                <div class="flex items-center space-x-3">
                  <span class="text-xs text-pink-300 whitespace-nowrap">{{ formatTime(currentTime) }} / {{ formatTime(duration) }}</span>
                  <!-- 音量：点击喇叭静音/恢复，滑块调量 -->
                  <div class="flex items-center space-x-2">
                    <button
                      @click="$emit('toggle-mute')"
                      class="jirai-button bottom-player__icon-button p-1 w-8 h-8 flex items-center justify-center"
                      :title="volume === 0 ? '取消静音' : '静音'"
                    >
                      <svg v-if="volume === 0" class="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M3 9v6h4l5 5V4L7 9H3zm13.59 3l2.7-2.7-1.41-1.42-2.71 2.71-2.7-2.71-1.42 1.42 2.71 2.7-2.71 2.71 1.42 1.41 2.7-2.7 2.71 2.7 1.41-1.41z"/>
                      </svg>
                      <svg v-else class="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/>
                      </svg>
                    </button>
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

                  <button
                    @click="$emit('toggle-repeat')"
                    class="jirai-button bottom-player__icon-button p-1 text-sm w-8 h-8 flex items-center justify-center"
                    :class="{ 'bottom-player__toggle--active': playMode !== 'list' }"
                    :title="`循环：${playModeText}`"
                  >{{ playMode === 'single' ? '↻1' : (playMode === 'loop' ? '↻' : '→') }}</button>
                  <button
                    @click="$emit('toggle-shuffle')"
                    class="jirai-button bottom-player__icon-button p-1 text-sm w-8 h-8 flex items-center justify-center"
                    :class="{ 'bottom-player__toggle--active': shuffleOn }"
                    :title="shuffleOn ? '关闭随机播放' : '随机播放'"
                  >🔀</button>
                  <button
                    @click="$emit('toggle-side-panel', 'queue')"
                    class="jirai-button bottom-player__icon-button p-1 text-sm w-8 h-8 flex items-center justify-center"
                    :class="{ 'bottom-player__toggle--active': sidePanelOpen && panelTab === 'queue' }"
                    title="待播队列"
                  >☰</button>
                  <button
                    @click="$emit('toggle-side-panel', 'lyrics')"
                    class="jirai-button bottom-player__icon-button p-1 text-sm w-8 h-8 flex items-center justify-center"
                    :class="{ 'bottom-player__toggle--active': sidePanelOpen && panelTab === 'lyrics' }"
                    title="歌词"
                  >词</button>
                  <button @click="$emit('open-fullscreen')" class="jirai-button bottom-player__icon-button p-1 text-sm w-8 h-8 flex items-center justify-center" title="全屏">
                    <svg class="bottom-player__icon bottom-player__icon--desktop" viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M8 4H4v4M16 4h4v4M20 16v4h-4M8 20H4v-4" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { computed, ref } from 'vue'
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
    // 右侧面板状态（待播/歌词 tab 各自高亮）
    sidePanelOpen: {
      type: Boolean,
      default: false
    },
    panelTab: {
      type: String,
      default: 'queue'
    },
    playMode: {
      type: String,
      default: 'list'
    },
    playModeText: {
      type: String,
      default: '顺序'
    },
    shuffleOn: {
      type: Boolean,
      default: false
    }
  },
  emits: ['toggle-play', 'previous-song', 'next-song', 'seek-to', 'update-volume', 'open-fullscreen', 'toggle-side-panel', 'toggle-repeat', 'toggle-shuffle', 'toggle-mute'],
  setup(props, { emit }) {
    const progressBar = ref(null)
    const seeking = ref(false)

    const ratioFromEvent = (event) => {
      const rect = progressBar.value?.getBoundingClientRect()
      if (!rect || rect.width === 0) return null
      return (event.clientX - rect.left) / rect.width
    }

    // 按下即 seek + 捕获指针进入拖拽；拖动中持续 seek，松手收尾。
    // window 级兜底 + lostpointercapture + blur/隐藏页清理——元素捕获失败
    // 或指针在元素外松手时 seeking 不会卡死
    const onSeekStart = (event) => {
      if (event.button !== undefined && event.button !== 0) return
      const bar = progressBar.value
      if (!bar) return
      const pid = event.pointerId
      seeking.value = true
      const ratio = ratioFromEvent(event)
      if (ratio !== null) emit('seek-to', ratio)
      bar.setPointerCapture?.(pid)

      const onMove = (e) => {
        if (e.pointerId !== pid) return
        const r = ratioFromEvent(e)
        if (r !== null) emit('seek-to', r)
      }
      const onEnd = (e) => {
        if (e?.pointerId !== undefined && e.pointerId !== pid) return
        seeking.value = false
        bar.removeEventListener('pointermove', onMove)
        bar.removeEventListener('pointerup', onEnd)
        bar.removeEventListener('pointercancel', onEnd)
        bar.removeEventListener('lostpointercapture', onEnd)
        window.removeEventListener('pointerup', onEnd)
        window.removeEventListener('pointercancel', onEnd)
        window.removeEventListener('blur', onEnd)
        document.removeEventListener('visibilitychange', onVisibility)
      }
      const onVisibility = () => { if (document.hidden) onEnd() }
      bar.addEventListener('pointermove', onMove)
      bar.addEventListener('pointerup', onEnd)
      bar.addEventListener('pointercancel', onEnd)
      bar.addEventListener('lostpointercapture', onEnd)
      window.addEventListener('pointerup', onEnd)
      window.addEventListener('pointercancel', onEnd)
      window.addEventListener('blur', onEnd)
      document.addEventListener('visibilitychange', onVisibility)
    }

    const progressPercentage = computed(() => {
      return props.duration > 0
        ? Math.max(0, Math.min(100, (props.currentTime / props.duration) * 100))
        : 0
    })

    return {
      progressBar,
      seeking,
      progressPercentage,
      formatTime,
      httpsCover,
      onSeekStart
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

/* 歌词/队列抽屉开关的激活态 */
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

/* 进度条拖拽旋钮：平时细线，悬停/拖拽时露头（YTM 同款交互） */
.player-progress-thumb {
  position: absolute;
  top: 50%;
  width: 10px;
  height: 10px;
  transform: translate(-50%, -50%);
  background: var(--pixel-accent-fg, #f472b6);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.12s;
}

.player-progress-bar:hover .player-progress-thumb,
.player-progress-bar--dragging .player-progress-thumb {
  opacity: 1;
}

.player-progress-bar {
  cursor: pointer;
  touch-action: none; /* 拖拽时不让浏览器接管滚动手势 */
}
</style>

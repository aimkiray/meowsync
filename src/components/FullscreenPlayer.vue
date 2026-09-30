<template>
  <div class="fullscreen-player fixed inset-0 z-[var(--z-fullscreen)]">
    <TextAliveLyricCanvas
      class="fullscreen-player__canvas"
      :lyrics="lyrics"
      :current-time="currentTime"
      :duration="duration"
      :is-playing="isPlaying"
      :lyric-mode="lyricMode"
      :interaction-mode="interactionMode"
    />

    <div class="fullscreen-player__overlay"></div>

    <div class="fullscreen-player__content">
      <div class="fullscreen-player__topbar">
        <div class="min-w-0">
          <p class="fullscreen-player__eyebrow">Now Playing</p>
          <h2 class="fullscreen-player__title">{{ currentSong?.name || '未播放' }}</h2>
          <p class="fullscreen-player__artist">
            {{ (currentSong?.ar || currentSong?.artists)?.map(artist => artist.name).join(', ') || '未知艺术家' }}
          </p>
        </div>

        <div class="fullscreen-player__topbar-actions">
          <button
            class="fullscreen-player__topbar-button"
            @click="$emit('update:lyric-mode', lyricMode === 'original' ? 'translation' : 'original')"
          >
            {{ lyricMode === 'original' ? '原文' : '译文' }}
          </button>
          <button
            class="fullscreen-player__topbar-button"
            @click="$emit('update:interaction-mode', interactionMode === 'auto' ? 'pointer' : 'auto')"
          >
            {{ interactionMode === 'auto' ? '自动' : '鼠标' }}
          </button>
          <button class="fullscreen-player__topbar-button fullscreen-player__close" @click="$emit('close')">退出</button>
        </div>
      </div>

      <div class="fullscreen-player__bottom">
        <div class="fullscreen-player__controls">
          <div class="fullscreen-player__buttons">
            <button @click="$emit('previous-song')" class="fullscreen-player__control-button" title="上一首" aria-label="上一首"><PixelIcon name="prev" :size="22" /></button>
            <button
              @click="$emit('toggle-play')"
              class="fullscreen-player__control-button fullscreen-player__control-button--primary"
              :class="{ 'opacity-50 cursor-progress': songSwitching }"
              :title="songSwitching ? '切换歌曲中' : (isPlaying ? '暂停' : '播放')"
              :aria-label="songSwitching ? '切换歌曲中' : (isPlaying ? '暂停' : '播放')"
            ><PixelIcon :name="isPlaying ? 'pause' : 'play'" :size="isPlaying ? 28 : 32" /></button>
            <button @click="$emit('next-song')" class="fullscreen-player__control-button" title="下一首" aria-label="下一首"><PixelIcon name="next" :size="22" /></button>
          </div>

          <div class="fullscreen-player__info-row">
            <div class="fullscreen-player__meta">
              <span>{{ formatTime(currentTime) }}</span>
              <span class="fullscreen-player__meta-separator">/</span>
              <span>{{ formatTime(duration) }}</span>
            </div>

            <div class="fullscreen-player__volume">
              <span class="fullscreen-player__volume-icon" aria-hidden="true"><PixelIcon name="vol" :size="16" /></span>
              <input
                :value="Number(volume)"
                type="range"
                min="0"
                max="100"
                step="1"
                class="w-full jirai-slider"
                aria-label="音量"
                @input="$emit('update-volume', Number($event.target.value))"
              />
            </div>
          </div>
        </div>

        <img
          v-if="currentSong?.al?.picUrl || currentSong?.album?.picUrl"
          :src="httpsCover(currentSong.al?.picUrl || currentSong.album?.picUrl)"
          :alt="currentSong.name"
          class="fullscreen-player__cover"
          :class="{ 'playing-animation': isPlaying }"
        />
        <div
          v-else
          class="fullscreen-player__cover flex items-center justify-center text-pink-300"
        ><PixelIcon name="note" :size="40" /></div>
      </div>

      <div
        class="player-progress-bar fullscreen-player__progress"
        @click="onSeekClick"
      >
        <div class="player-progress-fill" :style="{ '--p': progressPercentage }"></div>
      </div>
    </div>
  </div>
</template>

<script>
import { computed, onMounted, onUnmounted } from 'vue'
import TextAliveLyricCanvas from './TextAliveLyricCanvas.vue'
import PixelIcon from './PixelIcon.vue'
import { formatTime } from '../lib/format'
import { httpsCover } from '../lib/url'

export default {
  name: 'FullscreenPlayer',
  components: {
    TextAliveLyricCanvas,
    PixelIcon
  },
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
    lyrics: {
      type: Array,
      default: () => []
    },
    songSwitching: {
      type: Boolean,
      default: false
    },
    lyricMode: {
      type: String,
      default: 'original'
    },
    interactionMode: {
      type: String,
      default: 'auto'
    }
  },
  emits: ['close', 'toggle-play', 'previous-song', 'next-song', 'seek-to', 'update-volume', 'update:lyric-mode', 'update:interaction-mode'],
  setup(props, { emit }) {

    const progressPercentage = computed(() => {
      // seek 漂移/duration 修正会让 currentTime 短暂越过 duration——钳制
      return props.duration > 0
        ? Math.max(0, Math.min(100, (props.currentTime / props.duration) * 100))
        : 0
    })

    // 进度条点击 → 归一化比例 0-1（父组件负责换算为秒）
    const onSeekClick = (event) => {
      const rect = event.currentTarget.getBoundingClientRect()
      emit('seek-to', (event.clientX - rect.left) / rect.width)
    }

    const handleKeydown = (event) => {
      if (event.key === 'Escape') {
        emit('close')
      }
    }

    onMounted(() => {
      document.body.style.overflow = 'hidden'
      window.addEventListener('keydown', handleKeydown)
    })

    onUnmounted(() => {
      document.body.style.overflow = ''
      window.removeEventListener('keydown', handleKeydown)
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
.fullscreen-player {
  background-color: var(--pixel-bg);
  background-image: var(--fullscreen-background-image, url('/qb.png'));
  background-repeat: repeat;
  background-size: auto;
  background-position: top left;
}

.fullscreen-player::before {
  content: '';
  position: absolute;
  inset: 0;
  background: rgba(255, 244, 248, 0.52);
  pointer-events: none;
}

.fullscreen-player__canvas,
.fullscreen-player__overlay {
  position: absolute;
  inset: 0;
}

.fullscreen-player__overlay {
  background: radial-gradient(circle at center, rgba(255, 255, 255, 0.18), rgba(255, 255, 255, 0) 45%);
  pointer-events: none;
}

.fullscreen-player__content {
  position: relative;
  z-index: 1;
  min-height: 100%;
  padding: 24px;
}

.fullscreen-player__topbar {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
}

.fullscreen-player__topbar-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 14px;
}

.fullscreen-player__eyebrow {
  font-size: 12px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: rgba(110, 70, 100, 0.8);
}

.fullscreen-player__title {
  font-size: clamp(28px, 4vw, 52px);
  line-height: 1.05;
  color: rgb(126, 49, 88);
  text-shadow: 2px 2px 0 rgba(255, 255, 255, 0.8);
}

.fullscreen-player__artist {
  margin-top: 8px;
  color: rgb(110, 82, 120);
}

.fullscreen-player__bottom {
  position: absolute;
  left: 24px;
  right: 24px;
  bottom: 38px;
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 24px;
}

.fullscreen-player__controls {
  width: min(100%, 520px);
}

.fullscreen-player__progress {
  position: absolute;
  left: 24px;
  right: 24px;
  bottom: 16px;
  margin: 0;
  height: 4px;
  border-radius: 999px;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.45);
}

.fullscreen-player__info-row {
  display: flex;
  align-items: center;
  gap: 18px;
  margin-top: 14px;
}

.fullscreen-player__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  color: rgb(126, 49, 88);
}

.fullscreen-player__meta-separator {
  opacity: 0.7;
}

.fullscreen-player__volume {
  display: flex;
  align-items: center;
  gap: 6px;
  color: rgb(126, 49, 88);
  min-width: 0;
  width: 140px;
  justify-content: flex-start;
}

.fullscreen-player__volume-icon {
  font-size: 16px;
  line-height: 1;
}

.fullscreen-player__buttons {
  display: flex;
  justify-content: flex-start;
  align-items: center;
  gap: 16px;
  margin: 14px 0 0;
}

.fullscreen-player__topbar-button,
.fullscreen-player__topbar-button:hover,
.fullscreen-player__topbar-button:active,
.fullscreen-player__control-button,
.fullscreen-player__control-button:hover,
.fullscreen-player__control-button:active,
.fullscreen-player__close,
.fullscreen-player__close:hover,
.fullscreen-player__close:active,
.fullscreen-player__progress,
.fullscreen-player__volume :deep(.jirai-slider),
.fullscreen-player__volume :deep(.jirai-slider:hover),
.fullscreen-player__volume :deep(.jirai-slider:active) {
  box-shadow: none !important;
  text-shadow: none !important;
  filter: none !important;
  transform: none !important;
  appearance: none;
  -webkit-appearance: none;
}
/* 厂商伪元素不可混写进同一选择器列表——浏览器遇到不认识的伪元素
   会让整条规则作废（Chrome 不认 -moz，Firefox 不认 -webkit）；
   伪类写宿主上也最稳（:hover::thumb 对 input 任意处 hover 生效） */
.fullscreen-player__volume :deep(.jirai-slider::-webkit-slider-thumb),
.fullscreen-player__volume :deep(.jirai-slider:hover::-webkit-slider-thumb),
.fullscreen-player__volume :deep(.jirai-slider:active::-webkit-slider-thumb) {
  box-shadow: none !important;
  text-shadow: none !important;
  filter: none !important;
  transform: none !important;
  appearance: none;
  -webkit-appearance: none;
}
.fullscreen-player__volume :deep(.jirai-slider::-moz-range-thumb),
.fullscreen-player__volume :deep(.jirai-slider:hover::-moz-range-thumb),
.fullscreen-player__volume :deep(.jirai-slider:active::-moz-range-thumb) {
  box-shadow: none !important;
  text-shadow: none !important;
  filter: none !important;
  transform: none !important;
  appearance: none;
}
/* Firefox 专有：track/progress 伪元素盖在 input 半透明底之上——
   必须透明化，否则露出基类的像素黑条旧皮肤 */
.fullscreen-player__volume :deep(.jirai-slider::-moz-range-track),
.fullscreen-player__volume :deep(.jirai-slider::-moz-range-progress) {
  background: transparent !important;
  border: none !important;
}

/* 进度填充不在上面的 transform 重置里——scaleX 就是它的进度值 */
.fullscreen-player__progress :deep(.player-progress-fill) {
  box-shadow: none !important;
  text-shadow: none !important;
  filter: none !important;
}

.fullscreen-player__control-button {
  width: 52px;
  height: 52px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  font-size: 20px;
  background: rgba(182, 125, 158, 0.32);
  border: none;
  backdrop-filter: none;
}

.fullscreen-player__volume :deep(.jirai-slider) {
  border: 1px solid rgba(255, 255, 255, 0.22) !important;
  background: rgba(255, 255, 255, 0.18) !important;
}

.fullscreen-player__volume :deep(.jirai-slider::-webkit-slider-thumb) {
  border: 1px solid rgba(255, 255, 255, 0.3) !important;
  background: rgba(196, 102, 145, 0.72) !important;
}

.fullscreen-player__volume :deep(.jirai-slider::-moz-range-thumb) {
  border: 1px solid rgba(255, 255, 255, 0.3) !important;
  background: rgba(196, 102, 145, 0.72) !important;
}

.fullscreen-player__control-button--primary {
  background: rgba(196, 102, 145, 0.4);
  color: white;
}

/* 顶栏三键与播放键同族底色（control-button 粉 tint），退出键同档 */
.fullscreen-player__topbar-button {
  background: rgba(182, 125, 158, 0.32);
  color: white;
  border: 1px solid rgba(255, 255, 255, 0.22);
}

.fullscreen-player__cover {
  width: min(20vw, 200px);
  aspect-ratio: 1;
  object-fit: cover;
  border: 4px solid rgba(255, 255, 255, 0.9);
  box-shadow: none;
  image-rendering: pixelated;
  opacity: 0.5;
}

.fullscreen-player__close {
  flex-shrink: 0;
  border: 1px solid rgba(255, 255, 255, 0.22);
  backdrop-filter: none;
}

@media (max-width: 768px) {
  .fullscreen-player__content {
    padding: 16px;
  }

  .fullscreen-player__topbar {
    align-items: stretch;
    flex-direction: column;
  }

  .fullscreen-player__topbar-actions {
    justify-content: flex-end;
  }

  .fullscreen-player__close {
    align-self: auto;
  }

  .fullscreen-player__bottom {
    left: 16px;
    right: 16px;
    bottom: 40px;
    flex-direction: column-reverse;
    align-items: stretch;
  }

  .fullscreen-player__controls {
    width: 100%;
  }

  .fullscreen-player__info-row {
    align-items: flex-start;
    flex-direction: column;
    margin-top: 10px;
  }

  .fullscreen-player__volume {
    width: 120px;
    justify-content: flex-start;
  }

  .fullscreen-player__cover {
    align-self: flex-end;
    width: min(32vw, 160px);
  }

  .fullscreen-player__progress {
    left: 16px;
    right: 16px;
    bottom: 12px;
  }
}
</style>

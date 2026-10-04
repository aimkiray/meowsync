<template>
  <div
    class="fullscreen-player fixed inset-0 z-[var(--z-fullscreen)]"
    :class="{ 'fullscreen-player--idle': chromeHidden }"
    @mousemove="wake"
    @pointerdown="wake"
  >
    <TextAliveLyricCanvas
      class="fullscreen-player__canvas"
      :lyrics="lyrics"
      :current-time="currentTime"
      :duration="duration"
      :is-playing="isPlaying"
      :lyric-mode="lyricMode"
      :interaction-mode="interactionMode"
      :lyric-offset-ms="lyricOffsetMs"
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
                class="jirai-slider"
                aria-label="音量"
                @input="$emit('update-volume', Number($event.target.value))"
              />
            </div>
          </div>
        </div>

        <img
          v-if="songCoverUrl(currentSong)"
          :src="httpsCover(songCoverUrl(currentSong))"
          :alt="currentSong.name"
          class="fullscreen-player__cover"
          :class="{ 'playing-animation': isPlaying }"
        />
        <div
          v-else
          class="fullscreen-player__cover flex items-center justify-center text-pink-300"
        ><PixelIcon name="note" :size="40" /></div>
      </div>

      <!-- 命中壳 24px（触屏可点）+ 内层 4px 视觉轨道（pill 裁切保留） -->
      <div class="fullscreen-player__progress-hit" @click="onSeekClick">
        <div class="player-progress-bar fullscreen-player__progress">
          <div class="player-progress-fill" :style="{ '--p': progressPercentage }"></div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import TextAliveLyricCanvas from './TextAliveLyricCanvas.vue'
import PixelIcon from './PixelIcon.vue'
import { formatTime } from '../lib/format'
import { httpsCover } from '../lib/url'
import { songCoverUrl } from '../lib/song'

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
    // 歌词时间校准（ms，正=提前）——TextAliveLyricCanvas 用它偏移渲染时钟
    lyricOffsetMs: { type: Number, default: 0 },
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

    // 沉浸页 idle 自隐：2.6s 无输入 → 光标+全部 chrome（顶栏/底栏/进度条）
    // 淡出；mousemove/pointerdown/任意键戳醒。暂停态常显——画面静止时
    // 控件是唯一状态读数（与 WatchView 视频控制层同一语义、同一时长）
    const chromeOn = ref(true)
    let chromeHideTimer = null
    const wake = () => {
      chromeOn.value = true
      clearTimeout(chromeHideTimer)
      if (props.isPlaying) chromeHideTimer = setTimeout(() => { chromeOn.value = false }, 2600)
    }
    const chromeHidden = computed(() => !chromeOn.value && props.isPlaying)
    watch(() => props.isPlaying, (p) => {
      if (p) wake()                        // 恢复播放→亮一轮重新计自隐
      else clearTimeout(chromeHideTimer)   // 暂停→常显（computed 的 !isPlaying 兜底）
    })

    const handleKeydown = (event) => {
      wake()
      if (event.key === 'Escape') {
        emit('close')
      }
    }

    onMounted(() => {
      document.body.style.overflow = 'hidden'
      window.addEventListener('keydown', handleKeydown)
      wake() // 挂载即亮一轮；播放中挂上自隐计时
    })

    onUnmounted(() => {
      document.body.style.overflow = ''
      window.removeEventListener('keydown', handleKeydown)
      clearTimeout(chromeHideTimer)
    })

    return {
      progressPercentage,
      formatTime,
      httpsCover,
      songCoverUrl,
      onSeekClick,
      chromeHidden,
      wake
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

/* idle 自隐：光标与全部 chrome 一起收（流媒体播放器同手势）。
   光标须 * 通配——按钮/滑杆自带 UA 游标不吃祖先继承 */
.fullscreen-player--idle,
.fullscreen-player--idle * { cursor: none !important; }

.fullscreen-player__topbar,
.fullscreen-player__bottom,
.fullscreen-player__progress-hit {
  transition: opacity .3s ease;
}
.fullscreen-player--idle .fullscreen-player__topbar,
.fullscreen-player--idle .fullscreen-player__bottom,
.fullscreen-player--idle .fullscreen-player__progress-hit {
  opacity: 0;
  pointer-events: none;
}
/* 键盘焦点露出用 :has(:focus-visible) 而非 :focus-within——鼠标点过的键
   持 :focus 不持 :focus-visible：focus-within 会把栏钉成恒显（配合
   cursor:none 形成「恒显 chrome+消失光标」的最坏组合）；音量 range 拖
   杆点击持 :focus-visible——焦点在可操作件上就该常显，语义正确。
   pointer-events 一并归还：露出的栏必须可点（idle 规则把它收走过）。
   无 :has 的老浏览器退 focus-within：宁恒显勿键盘陷阱 */
.fullscreen-player__topbar:has(:focus-visible),
.fullscreen-player__bottom:has(:focus-visible) {
  opacity: 1;
  pointer-events: auto;
}
@supports not (selector(:has(:focus-visible))) {
  .fullscreen-player__topbar:focus-within,
  .fullscreen-player__bottom:focus-within {
    opacity: 1;
    pointer-events: auto;
  }
}
/* 键盘露出栏内的光标一并归还——idle 的 *{cursor:none!important} 覆盖到
   栏内子键，要靠更高特异度+!important 才能翻：露出 chrome 后鼠标悬停
   不该无光标（不动鼠标的键盘用户无感，一动鼠标也会经 wake 自愈） */
.fullscreen-player--idle .fullscreen-player__topbar:has(:focus-visible),
.fullscreen-player--idle .fullscreen-player__topbar:has(:focus-visible) *,
.fullscreen-player--idle .fullscreen-player__bottom:has(:focus-visible),
.fullscreen-player--idle .fullscreen-player__bottom:has(:focus-visible) * {
  cursor: auto !important;
}
@media (prefers-reduced-motion: reduce) {
  .fullscreen-player__topbar,
  .fullscreen-player__bottom,
  .fullscreen-player__progress-hit {
    transition: none;
  }
}

.fullscreen-player__content {
  position: relative;
  z-index: 1;
  min-height: 100%;
  /* 刘海/Home 指示条：沉浸层是 viewport-fit:cover 下的全 bleed 面，
     顶栏键与底部进度条必须让出安全区，否则退出键压在状态栏下、
     进度条落进 Home 手势热区 */
  padding: calc(24px + env(safe-area-inset-top, 0px)) calc(24px + env(safe-area-inset-right, 0px))
    calc(24px + env(safe-area-inset-bottom, 0px)) calc(24px + env(safe-area-inset-left, 0px));
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
  /* 超长曲名防无限增高——fixed 层不可滚，标题吃高会把底部控件顶出视口 */
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  overflow: hidden;
}

.fullscreen-player__artist {
  margin-top: 8px;
  color: rgb(110, 82, 120);
}

.fullscreen-player__bottom {
  position: absolute;
  left: 24px;
  right: 24px;
  /* 命中壳顶沿 ≈16+env+24=40+env——本行底沿 46+env，留 6px 气隙
     （≤768 档壳顶 36+env / 行底 44+env → 8px） */
  bottom: calc(46px + env(safe-area-inset-bottom, 0px));
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 24px;
}

.fullscreen-player__controls {
  width: min(100%, 520px);
}

/* 命中壳：定位与触控语义在这层——click 读的是壳 rect（与轨道同宽，比例不变）。
   抬高让出 Home 指示条热区（iOS ~34px），否则点按触发系统手势 */
.fullscreen-player__progress-hit {
  position: absolute;
  left: 24px;
  right: 24px;
  bottom: calc(16px + env(safe-area-inset-bottom, 0px));
  height: 24px;
  display: flex;
  align-items: center;
  cursor: pointer;
  touch-action: none;
}
.fullscreen-player__progress {
  position: static;
  width: 100%;
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

/* 顶栏三键与播放键同族底色（control-button 粉 tint），退出键同档。
   全局 reset 剥光 padding 后命中盒只剩字形高 ~20px——退出是触屏唯一
   关闭路径（无 Esc/下滑手势），补内距到 40px 档 */
.fullscreen-player__topbar-button {
  background: rgba(182, 125, 158, 0.32);
  color: white;
  border: 1px solid rgba(255, 255, 255, 0.22);
  padding: 8px 14px;
  min-height: 40px;
}

/* 全局环是 currentColor——本页键色 white 落粉底上偏虚，换深色环
   （box-shadow 晕环被上方 !important 重置剥光，只能走 outline 本身）。
   音量 range 同样待遇：它的环色是全局 --pixel-highlight 白 30%，而
   range 恰是「焦点钉显」语义的依赖件——环不可见则钉显得不到解释 */
.fullscreen-player__topbar-button:focus-visible,
.fullscreen-player__control-button:focus-visible,
.fullscreen-player__close:focus-visible,
.fullscreen-player__volume :deep(.jirai-slider:focus-visible) {
  outline-color: rgba(0, 0, 0, .85);
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
    bottom: calc(44px + env(safe-area-inset-bottom, 0px));
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

  .fullscreen-player__progress-hit {
    left: 16px;
    right: 16px;
    bottom: calc(12px + env(safe-area-inset-bottom, 0px));
  }
}

/* 手机横屏/矮视口：装饰封面退场——absolute 底块不占流，内容堆栈
   ~320px 高时封面会压住标题区、控件叠上顶栏文字 */
@media (max-height: 500px) {
  .fullscreen-player__cover { display: none; }
  /* 续收几何：标题钳单行+字号随视口高缩（4vw 在横屏取长边，须换 vh
     分母），顶/底内容槽与底堆间距一并收紧——320px 高窗口顶栏
     （eyebrow+3 行标题+artist ≈150）与底堆（按钮 52+info 行 ≈100）曾相叠 */
  .fullscreen-player__title {
    font-size: clamp(18px, 6vh, 28px);
    -webkit-line-clamp: 1;
  }
  .fullscreen-player__artist { margin-top: 4px; }
  .fullscreen-player__buttons { margin-top: 8px; }
  .fullscreen-player__info-row { margin-top: 8px; }
  .fullscreen-player__content {
    padding-top: calc(12px + env(safe-area-inset-top, 0px));
    padding-bottom: calc(12px + env(safe-area-inset-bottom, 0px));
  }
}
</style>

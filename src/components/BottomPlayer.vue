<template>
  <div class="bottom-player" role="region" aria-label="播放器">
    <!-- 当前播放歌曲的迷你信息与走带（仅在有歌曲时显示完整控制区） -->
    <div class="player-content" v-if="currentSong">
      <!-- 进度条：沉在墨条顶缘，按下即 seek + 拖拽（按 .1s 量化读数） -->
      <div
        class="player-progress-bar bp-progress"
        @click="seekTo"
        role="slider"
        aria-label="播放进度"
        :aria-valuenow="Math.round((currentTime / (duration || 1)) * 100)"
        :aria-valuetext="`${formatTime(currentTime)} / ${formatTime(duration)}`"
        aria-valuemin="0"
        aria-valuemax="100"
        tabindex="0"
        @keydown.arrow-right.prevent="nudgeSeek(5)"
        @keydown.arrow-left.prevent="nudgeSeek(-5)"
        @keydown.home.prevent="seekToPosition(0)"
        @keydown.end.prevent="seekToPosition(1)"
        @keydown.enter.prevent="$emit('toggle-play')"
        @keydown.space.prevent="$emit('toggle-play')"
        @pointerdown="onProgressPointerDown"
        @pointermove="onProgressPointerMove"
        @pointerup="onProgressPointerUp"
        @pointercancel="onProgressPointerUp"
        @lostpointercapture="onProgressPointerUp"
      >
        <div class="player-progress-fill bp-progress-fill" :style="{ '--p': seekProgress }"></div>
      </div>

      <div class="player-inner">
        <!-- 当前歌曲缩略信息（左列） -->
        <div class="track-meta">
          <div class="cover-wrap">
            <img
              v-if="coverUrl"
              :src="httpsCover(coverUrl)"
              :alt="`封面：${currentSong.name}`"
              class="track-cover"
              :class="{ 'playing-animation': isPlaying }"
            />
            <div v-else class="track-cover track-cover--fallback"><PixelIcon name="note" :size="16" /></div>
          </div>
          <div class="track-text">
            <p class="track-name">{{ currentSong.name }}</p>
            <p class="track-artist">{{ songArtists(currentSong) }} · {{ currentSong.al?.name || '未知专辑' }}</p>
          </div>
        </div>

        <!-- 走带控制（中列）：YTM 顺序 —— 随机/上一首/播放/下一首/循环 -->
        <div class="player-controls">
          <button
            @click="$emit('toggle-shuffle')"
            class="transport"
            :class="{ 'transport--active': shuffleOn }"
            :aria-pressed="shuffleOn"
            :disabled="isTempPlaylist"
            aria-label="随机播放"
            title="随机播放"
          ><PixelIcon name="shuffle" :size="16" /></button>
          <button
            @click="$emit('previous')"
            class="transport"
            :disabled="atQueueStart"
            aria-label="上一首"
            title="上一首"
          ><PixelIcon name="prev" :size="16" /></button>
          <button
            @click="$emit('toggle-play')"
            class="transport transport--play"
            :aria-label="songSwitching ? '切换歌曲中' : (isPlaying ? '暂停' : '播放')"
            :title="songSwitching ? '切换歌曲中…' : (isPlaying ? '暂停' : '播放')"
          ><PixelIcon v-if="!songSwitching" :name="isPlaying ? 'pause' : 'play'" :size="18" /><span v-else class="switching-glyph">…</span></button>
          <button
            @click="$emit('next')"
            class="transport"
            :disabled="atQueueEnd"
            aria-label="下一首"
            title="下一首"
          ><PixelIcon name="next" :size="16" /></button>
          <button
            @click="$emit('toggle-play-mode')"
            class="transport"
            :aria-label="`切换播放模式，当前：${playModeText || '顺序'}`"
            :title="`播放模式：${playModeText || '列表循环'}`"
          ><PixelIcon :name="playModeIcon" :size="15" /></button>
        </div>

        <!-- 时间与右簇（音量 + watch/词/沉浸入口） -->
        <div class="player-right">
          <span class="player-time hidden lg:inline">
            {{ formatTime(currentTime) }} / {{ formatTime(duration) }}
          </span>
          <div class="vol-wrap">
            <button
              @click="$emit('toggle-mute')"
              class="pg-icobtn pg-icobtn--on-ink"
              :class="{ 'pg-icobtn--pressed': muted }"
              :aria-pressed="muted"
              :aria-label="muted ? '取消静音' : '静音'"
              :title="muted ? '取消静音' : '静音'"
            ><PixelIcon :name="muted ? 'vol-mute' : 'vol'" :size="15" /></button>
            <input
              type="range"
              min="0"
              max="100"
              step="1"
              :value="volume"
              @input="$emit('update-volume', parseFloat($event.target.value))"
              class="pg-range pg-range--on-ink vol-range"
              aria-label="音量"
            />
          </div>
          <button
            class="pg-icobtn pg-icobtn--on-ink"
            :class="{ 'pg-icobtn--pressed': sidePanelOpen && panelTab === 'queue' }"
            :aria-pressed="sidePanelOpen && panelTab === 'queue'"
            @click="$emit('open-watch', 'queue')"
            aria-label="待播队列"
            title="待播队列"
          >
            <PixelIcon name="menu" :size="14" />
          </button>
          <button
            class="pg-icobtn pg-icobtn--on-ink bp-xtra"
            :class="{ 'pg-icobtn--pressed': sidePanelOpen && panelTab === 'lyrics' }"
            :aria-pressed="sidePanelOpen && panelTab === 'lyrics'"
            @click="$emit('open-watch', 'lyrics')"
            aria-label="歌词"
            title="歌词"
          >
            <PixelIcon name="note" :size="14" />
          </button>
          <button
            class="pg-icobtn pg-icobtn--on-ink bp-xtra"
            @click="$emit('enter-fullscreen')"
            aria-label="沉浸模式"
            title="沉浸模式"
          >
            <PixelIcon name="expand" :size="14" />
          </button>
        </div>
      </div>
    </div>

    <!-- 无歌曲时的待机条：品牌戳 + 进度占位 -->
    <div class="player-idle" v-else>
      <span class="pg-label pg-label--on-ink">meowsync</span>
      <span class="pg-label pg-label--on-ink player-idle-hint">选择歌曲开始播放</span>
      <span class="pg-label pg-label--on-ink player-idle-ver">ms.os1</span>
    </div>
  </div>
</template>

<script>
import { ref, computed } from 'vue'
import { formatTime } from '../lib/format'
import { songArtists } from '../lib/song'
import { httpsCover } from '../lib/url'
import PixelIcon from './PixelIcon.vue'

export default {
  name: 'BottomPlayer',
  components: { PixelIcon },
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
      default: 0.5
    },
    muted: {
      type: Boolean,
      default: false
    },
    playbackList: {
      type: Array,
      default: () => []
    },
    currentIndex: {
      type: Number,
      default: -1
    },
    isTempPlaylist: {
      type: Boolean,
      default: false
    },
    shuffleOn: {
      type: Boolean,
      default: false
    },
    playMode: {
      type: String,
      default: 'list'
    },
    playModeText: {
      type: String,
      default: ''
    },
    songSwitching: {
      type: Boolean,
      default: false
    },
    sidePanelOpen: {
      type: Boolean,
      default: false
    },
    panelTab: {
      type: String,
      default: 'queue'
    }
  },
  emits: ['toggle-play', 'previous', 'next', 'update-volume', 'toggle-mute', 'toggle-shuffle', 'toggle-play-mode', 'open-watch', 'enter-fullscreen', 'seek'],
  setup(props, { emit }) {
    // 搜索结果曲目常无 picUrl（字段在 al/album 上）——三路兜底防裂图
    const coverUrl = computed(() =>
      props.currentSong?.picUrl || props.currentSong?.al?.picUrl || props.currentSong?.album?.picUrl || ''
    )

    // 进度条拖拽状态：按下期间 UI 播放在这里走，不跟随 props.currentTime 抢
    const dragActive = ref(false)
    const dragProgress = ref(0)

    const seekProgress = computed(() => {
      if (dragActive.value) return dragProgress.value * 100
      return props.duration ? (props.currentTime / props.duration) * 100 : 0
    })

    // 队尾判定：仅 list 顺序模式在队尾时禁「下一首」——loop 回卷 / single 自循环始终有效。
    // 临时歌单（single_song/saved_queue）不豁免：它们队尾点下一首只会静默空转
    const atQueueEnd = computed(() =>
      props.playMode === 'list' &&
      props.playbackList.length > 0 &&
      props.currentIndex >= props.playbackList.length - 1
    )
    // 队首同款：list 模式在第一首时禁「上一首」（点了也是静默 return）
    const atQueueStart = computed(() =>
      props.playMode === 'list' &&
      props.playbackList.length > 0 &&
      props.currentIndex === 0
    )

    const playModeIcon = computed(() =>
      ({ list: 'm-list', loop: 'm-loop', single: 'm-single' })[props.playMode] || 'm-list'
    )

    const positionFromEvent = (e, bar) => {
      const rect = bar.getBoundingClientRect()
      const x = e.clientX - rect.left
      return Math.min(1, Math.max(0, x / rect.width))
    }

    // seek 契约：emit 归一化比例 0-1（App.seekTo 负责换算秒）
    const seekTo = (e) => {
      emit('seek', positionFromEvent(e, e.currentTarget))
    }

    const seekToPosition = (pos) => {
      emit('seek', pos)
    }

    const nudgeSeek = (sec) => {
      const target = Math.max(0, Math.min(props.duration || 0, props.currentTime + sec))
      emit('seek', props.duration ? target / props.duration : 0)
    }

    const onProgressPointerDown = (e) => {
      if (e.button !== 0) return
      const bar = e.currentTarget
      bar.setPointerCapture?.(e.pointerId)
      dragActive.value = true
      dragProgress.value = positionFromEvent(e, bar)
    }

    const onProgressPointerMove = (e) => {
      if (!dragActive.value) return
      dragProgress.value = positionFromEvent(e, e.currentTarget)
    }

    const onProgressPointerUp = (e) => {
      if (!dragActive.value) return
      dragActive.value = false
      emit('seek', dragProgress.value)
    }

    return {
      formatTime,
      songArtists,
      httpsCover,
      coverUrl,
      seekProgress,
      atQueueEnd,
      atQueueStart,
      playModeIcon,
      seekTo,
      seekToPosition,
      nudgeSeek,
      onProgressPointerDown,
      onProgressPointerMove,
      onProgressPointerUp
    }
  }
}
</script>

<style scoped>
/* ── 墨条（底栏唯一配色：ink 面 + paper 字）── */
.bottom-player {
  position: relative;
  flex-shrink: 0;
  background: var(--ink);
  color: var(--paper);
  border-top: var(--hairline);
}

.bp-progress {
  position: absolute;
  top: -1px;
  left: 0;
  right: 0;
  background: var(--white-16);
  cursor: pointer;
  z-index: 2;
}
.bp-progress-fill { background: var(--paper); }

.player-content { position: relative; }

.player-inner {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px 16px;
  max-width: 1440px;
  margin: 0 auto;
}

/* 左列：封面 + 文字 */
.track-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex: 1;
}
.cover-wrap { width: 40px; height: 40px; flex-shrink: 0; }
.track-cover {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border: 1.2px solid var(--white-40);
  image-rendering: pixelated;
  display: block;
}
.track-cover--fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--label-grey);
}
.track-text { min-width: 0; }
.track-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--paper);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.track-artist {
  font-size: 11px;
  color: var(--label-grey);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 1px;
}

/* 中列：走带 */
.player-controls {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
.transport {
  width: 34px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--paper);
  border: 1.2px solid transparent;
  cursor: pointer;
  transition: color .2s, border-color .2s;
}
/* hover 统一语言：墨色底上纸色发丝框 + 品红字（play 键常驻框只是强调主键） */
.transport:hover:not(:disabled) { color: var(--accent-magenta-on-ink); border-color: var(--paper); }
.transport:disabled { opacity: .45; cursor: default; }
.transport--active { color: var(--accent-magenta-on-ink); }
.transport--play {
  border-color: var(--paper);
  width: 40px;
  height: 40px;
}
.transport--play:hover:not(:disabled) { border-color: var(--accent-magenta); }

.switching-glyph {
  font-family: var(--font-mono);
  font-size: 16px;
  line-height: 1;
  animation: bpBlink 1s steps(2) infinite;
}
@keyframes bpBlink { 50% { opacity: .3; } }
@media (prefers-reduced-motion: reduce) {
  .switching-glyph { animation: none; }
}

/* watch 页已打开对应 tab 时的按下态（纸面反白） */
.pg-icobtn--pressed {
  background: var(--paper);
  color: var(--ink);
}

/* 右列：时间 + 音量 + watch/沉浸入口 */
.player-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  justify-content: flex-end;
  flex-shrink: 0;
}
.player-time {
  font-family: var(--font-mono);
  font-weight: 400; /* 数值档——标签才是 300 */
  font-size: 12px;
  color: var(--label-grey);
  white-space: nowrap;
}

.vol-wrap {
  display: flex;
  align-items: center;
  gap: 4px;
}
.vol-range { width: 76px; }

/* 墨条上的图标键：透明底白字（无发丝盒——墨条自身即是铬） */
.pg-icobtn--on-ink {
  border-color: transparent;
  color: var(--paper);
}
.pg-icobtn--on-ink:hover:not(:disabled) { color: var(--accent-magenta-on-ink); }

.queue-glyph {
  font-family: var(--font-mono);
  font-size: 15px;
  line-height: 1;
}

/* 待机条：与激活条同高（40 内容 + 10×2 padding + 1.2 顶线 = 61.2），首次点歌不跳主区 */
.player-idle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: 61.2px;
  padding: 0 16px;
  max-width: 1440px;
  margin: 0 auto;
}
.pg-label--on-ink { color: var(--label-grey); }
.player-idle-hint { color: var(--white-80); }

@media (max-width: 640px) {
  .player-inner { gap: 10px; padding: 8px 10px; }
  .vol-wrap, .player-time { display: none; }
}

/* ≤420px：墨条塞不下全簇——词/沉浸键收进 watch 页路径可达，保队列入口 */
@media (max-width: 420px) {
  .bp-xtra { display: none; }
  .transport { width: 30px; height: 30px; }
  .transport--play { width: 36px; height: 36px; }
  .player-controls { gap: 2px; }
  .player-inner { gap: 6px; padding: 8px; }
  .track-text { max-width: 34vw; }
}
</style>

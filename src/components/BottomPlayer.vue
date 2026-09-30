<template>
  <div class="bottom-player" role="region" aria-label="播放器">
    <!-- 当前播放歌曲的迷你信息与走带（无歌曲时同构骨架：控件禁用、占位兜底） -->
    <div class="player-content">
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
        <!-- 当前歌曲缩略信息（左列）——YTM：点击回 watch 播放页（肌肉记忆入口） -->
        <div
          class="track-meta"
          role="button"
          tabindex="0"
          title="打开播放页"
          @click="$emit('open-watch', 'queue')"
          @keydown.enter="$emit('open-watch', 'queue')"
          @keydown.space.prevent="$emit('open-watch', 'queue')"
        >
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
            <p class="track-name">{{ currentSong?.name || '选择歌曲开始播放' }}</p>
            <p class="track-artist">{{ currentSong ? `${songArtists(currentSong)} · ${currentSong.al?.name || '未知专辑'}` : 'meowsync' }}</p>
          </div>
        </div>

        <!-- 走带控制（中列）：YTM 顺序 —— 随机/上一首/播放/下一首/循环 -->
        <div class="player-controls">
          <button
            @click="$emit('toggle-shuffle')"
            class="transport"
            :class="{ 'transport--active': shuffleOn }"
            :aria-pressed="shuffleOn"
            :disabled="!currentSong || isTempPlaylist"
            aria-label="随机播放"
            title="随机播放"
          ><PixelIcon name="shuffle" :size="16" /></button>
          <button
            @click="$emit('previous')"
            class="transport"
            :disabled="!currentSong || atQueueStart"
            aria-label="上一首"
            title="上一首"
          ><PixelIcon name="prev" :size="16" /></button>
          <button
            @click="$emit('toggle-play')"
            class="transport transport--play"
            :class="{ 'transport--switching': songSwitching }"
            :disabled="!currentSong"
            :aria-label="songSwitching ? '切换歌曲中' : (isPlaying ? '暂停' : '播放')"
            :title="songSwitching ? '切换歌曲中…' : (isPlaying ? '暂停' : '播放')"
          ><PixelIcon :name="isPlaying ? 'pause' : 'play'" :size="isPlaying ? 18 : 22" /></button>
          <button
            @click="$emit('next')"
            class="transport"
            :disabled="!currentSong || atQueueEnd"
            aria-label="下一首"
            title="下一首"
          ><PixelIcon name="next" :size="16" /></button>
          <button
            @click="$emit('toggle-play-mode')"
            class="transport"
            :disabled="!currentSong"
            :aria-label="`切换播放模式，当前：${playModeText || '顺序'}`"
            :title="`播放模式：${playModeText || '列表循环'}`"
          ><PixelIcon :name="playModeIcon" :size="16" /></button>
          <!-- YTM：time-info 在中列走带簇尾部（repeat 之后），不在右簇 -->
          <span class="player-time hidden lg:inline">
            {{ formatTime(currentTime) }} / {{ formatTime(duration) }}
          </span>
        </div>

        <!-- 右簇（音量 + watch/词/沉浸入口） -->
        <div class="player-right">
          <div class="vol-wrap">
            <button
              @click="$emit('toggle-mute')"
              class="pg-icobtn pg-icobtn--on-ink"
              :class="{ 'pg-icobtn--pressed': muted }"
              :aria-pressed="muted"
              :aria-label="muted ? '取消静音' : '静音'"
              :title="muted ? '取消静音' : '静音'"
            ><PixelIcon :name="muted ? 'vol-mute' : 'vol'" :size="14" /></button>
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
            :disabled="!currentSong"
            :aria-pressed="sidePanelOpen && panelTab === 'queue'"
            @click="$emit('open-watch', 'queue')"
            aria-label="待播队列"
            title="待播队列"
          >
            <PixelIcon name="menu" :size="15" />
          </button>
          <button
            class="pg-icobtn pg-icobtn--on-ink bp-xtra"
            :class="{ 'pg-icobtn--pressed': sidePanelOpen && panelTab === 'lyrics' }"
            :disabled="!currentSong"
            :aria-pressed="sidePanelOpen && panelTab === 'lyrics'"
            @click="$emit('open-watch', 'lyrics')"
            aria-label="歌词"
            title="歌词"
          >
            <PixelIcon name="note" :size="14" />
          </button>
          <button
            class="pg-icobtn pg-icobtn--on-ink bp-xtra"
            :disabled="!currentSong"
            @click="$emit('enter-fullscreen')"
            aria-label="沉浸模式"
            title="沉浸模式"
          >
            <PixelIcon name="expand" :size="14" />
          </button>
        </div>
      </div>
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
    },
    autoplayOn: {
      type: Boolean,
      default: false
    }
  },
  emits: ['toggle-play', 'previous', 'next', 'update-volume', 'toggle-mute', 'toggle-shuffle', 'toggle-play-mode', 'open-watch', 'enter-fullscreen', 'seek'],
  setup(props, { emit }) {
    // 封面三路兜底：picUrl / al.picUrl（cloudsearch）/ album.picUrl（legacy search 与详情态）防裂图
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
    // autoplay 开启时队尾可续播相关曲，不锁键（YTM：Up next 永远有下一首）。
    // 临时歌单（single_song/saved_queue）不豁免：它们队尾点下一首只会静默空转
    const atQueueEnd = computed(() =>
      props.playMode === 'list' &&
      props.playbackList.length > 0 &&
      props.currentIndex >= props.playbackList.length - 1 &&
      !props.autoplayOn
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

    // seek 契约：emit 归一化比例 0-1（App.seekTo 负责换算秒）。无歌曲时进度条仅作骨架占位
    const seekTo = (e) => {
      if (!props.currentSong) return
      emit('seek', positionFromEvent(e, e.currentTarget))
    }

    const seekToPosition = (pos) => {
      if (!props.currentSong) return
      emit('seek', pos)
    }

    const nudgeSeek = (sec) => {
      if (!props.currentSong) return
      const target = Math.max(0, Math.min(props.duration || 0, props.currentTime + sec))
      emit('seek', props.duration ? target / props.duration : 0)
    }

    const onProgressPointerDown = (e) => {
      if (e.button !== 0 || !props.currentSong) return
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
.bp-progress-fill { background: var(--accent-magenta); } /* 已播部分=accent 本色（retro 火烈鸟粉 / glitch teal 同覆写） */

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
  cursor: pointer;
}
.track-meta:focus-visible { outline: 1.2px solid var(--paper); outline-offset: 2px; }
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
  transition: color .2s, border-color .2s, opacity .15s;
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

/* 切换中：不换字形，整键灰化。busy≠disabled——仍可按（togglePlay 内有
   howl 守卫），用 progress 光标区分于死键；opacity .15s 柔化瞬闪 */
.transport--switching { opacity: .45; cursor: progress; }

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
/* 墨条上的按下态=变色图标：纸底白块会与 --on-ink 纸字叠成空白方块，改 accent 字色无底色 */
.pg-icobtn--on-ink.pg-icobtn--pressed,
.pg-icobtn--on-ink.pg-icobtn--pressed:hover:not(:disabled) {
  background: transparent;
  color: var(--accent-magenta-on-ink);
}

@media (max-width: 640px) {
  .player-inner { gap: 10px; padding: 8px 10px; }
  .vol-wrap { display: none; }
}

/* ≤420px：YTM miniplayer 稀疏化——shuffle/repeat 藏入，
   留 prev/play/next 三键；词/沉浸键收进 watch 页路径可达，保队列入口 */
@media (max-width: 420px) {
  .player-controls .transport:first-child,
  .player-controls .transport:nth-child(5) { display: none; }
  .bp-xtra { display: none; }
  .transport { width: 30px; height: 30px; }
  .transport--play { width: 36px; height: 36px; }
  .pg-icobtn--on-ink { width: 30px; height: 30px; } /* 与 transport 同收——否则 30<32 倒挂 */
  .player-controls { gap: 2px; }
  .player-inner { gap: 6px; padding: 8px; }
  .track-text { max-width: 34vw; }
}
</style>

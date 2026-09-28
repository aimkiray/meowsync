<template>
  <!-- 右侧面板抽屉：YTM「待播 | 歌词」双 tab——不占常驻栏位，播放条呼出 -->
  <div
    class="lyrics-drawer jirai-card card-lyrics"
    :class="{ 'lyrics-drawer--open': open }"
    role="complementary"
    aria-label="待播与歌词面板"
  >
    <div class="lyrics-drawer-header">
      <!-- YTM 式 tab 条：待播(UP NEXT) / 歌词(LYRICS) -->
      <div class="panel-tabs" role="tablist">
        <button
          class="panel-tab"
          :class="{ 'panel-tab--active': panelTab === 'queue' }"
          role="tab"
          aria-controls="panel-queue"
          :aria-selected="panelTab === 'queue'"
          @click="setTab('queue')"
        >待播</button>
        <button
          class="panel-tab"
          :class="{ 'panel-tab--active': panelTab === 'lyrics' }"
          role="tab"
          aria-controls="panel-lyrics"
          :aria-selected="panelTab === 'lyrics'"
          @click="setTab('lyrics')"
        >歌词</button>
      </div>
      <div class="flex items-center gap-2">
        <button
          v-if="panelTab === 'lyrics'"
          @click="$emit('toggle-auto-follow-lyrics')"
          class="text-xs px-2 py-1 border transition-colors"
          :class="{
            'bg-pink-500 text-white border-pink-400': autoFollowLyrics,
            'bg-gray-700 text-gray-300 border-gray-500 hover:bg-gray-600': !autoFollowLyrics
          }"
          :title="autoFollowLyrics ? '关闭自动跟随' : '开启自动跟随'"
        >
          {{ autoFollowLyrics ? '跟随' : '手动' }}
        </button>
        <button
          @click="$emit('close')"
          class="text-xs px-2 py-1 border border-gray-500 bg-gray-700 text-gray-300 hover:bg-gray-600 transition-colors"
          title="关闭面板"
        >✕</button>
      </div>
    </div>

    <!-- ── 待播队列 ── -->
    <div id="panel-queue" role="tabpanel" v-show="panelTab === 'queue'" class="lyrics-drawer-body queue-body" ref="queueContainer">
      <div v-if="!currentSong" class="text-center py-8">
        <p class="text-gray-600">选择一首歌开始播放喵~</p>
      </div>
      <template v-else>
        <p class="queue-source">正在播放：{{ queueTitle }}</p>
        <div v-if="queue.length === 0" class="text-center py-8">
          <p class="text-gray-600">队列为空喵~</p>
        </div>
        <div v-else>
          <div
            v-for="(song, index) in queue"
            :key="`${song.id}-${index}`"
            class="queue-row"
            :class="{ 'queue-row--current': String(song.id) === String(currentSong.id) }"
            @click="jumpTo(song, index)"
            @keydown.enter="jumpTo(song, index)"
            tabindex="0"
            role="button"
          >
            <span class="queue-row-index">
              <template v-if="String(song.id) === String(currentSong.id)">▶</template>
              <template v-else>{{ index + 1 }}</template>
            </span>
            <div class="queue-row-info">
              <p class="queue-row-title">{{ song.name }}</p>
              <p class="queue-row-artist">{{ songArtist(song) }}</p>
            </div>
            <span class="queue-row-duration">{{ formatDuration(song) }}</span>
            <button
              v-if="String(song.id) !== String(currentSong.id)"
              class="queue-row-remove"
              title="从队列移除"
              aria-label="从队列移除"
              @click.stop="$emit('queue-remove', index)"
            >✕</button>
          </div>
        </div>
      </template>
    </div>

    <!-- ── 歌词 ── -->
    <div id="panel-lyrics" role="tabpanel" v-show="panelTab === 'lyrics'" ref="playerContainer" class="lyrics-drawer-body">
      <div v-if="!currentSong" class="text-center py-8">
        <p class="text-gray-600">选择一首歌开始播放喵~</p>
      </div>

      <template v-else>
        <!-- 时长警告提示 -->
        <div v-if="durationWarning" class="mb-3 p-2 bg-yellow-100 border-2 border-yellow-400 text-yellow-800 text-xs">
          ⚠️ {{ durationWarning }}
        </div>
        <!-- 播放错误提示 -->
        <div v-if="playbackError" class="mb-3 p-2 bg-red-100 border-2 border-red-400 text-red-800 text-xs">
          ❌ {{ playbackError }}
        </div>

        <div v-if="songSwitching" class="text-center py-8">
          <div class="pixel-loading mx-auto mb-4"></div>
          <p class="text-pink-300 flex justify-center items-center font-bold">正在切换歌曲喵...</p>
        </div>

        <div v-else-if="loadingLyrics" class="text-center py-8">
          <div class="pixel-loading mx-auto mb-4"></div>
          <p class="text-pink-300 flex justify-center items-center">加载歌词中喵...</p>
        </div>

        <div v-else class="space-y-2 jirai-lyrics">
          <div
            v-for="(lyric, index) in lyrics"
            :key="index"
            :data-lyric-index="index"
            class="text-center py-1 transition-all duration-300 lyric-line"
            :class="{
              'text-pink-300 font-bold glow-text': index === currentLyricIndex,
              'text-purple-300': index !== currentLyricIndex
            }"
          >
            <p :class="{ 'text-base': index === currentLyricIndex }">{{ lyric.text }}</p>
            <p v-if="lyric.translation" class="mt-1" :class="index === currentLyricIndex ? 'text-base' : 'text-sm'">
              {{ lyric.translation }}
            </p>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script>
import { ref, watch, nextTick } from 'vue'
import { formatTime } from '../lib/format'

export default {
  name: 'LyricsPanel',
  props: {
    open: {
      type: Boolean,
      default: false
    },
    // 受控 tab：'queue' | 'lyrics'（父组件决定按钮呼出到哪个 tab）
    panelTab: {
      type: String,
      default: 'queue'
    },
    currentSong: {
      type: Object,
      default: null
    },
    queue: {
      type: Array,
      default: () => []
    },
    queueTitle: {
      type: String,
      default: ''
    },
    lyrics: {
      type: Array,
      default: () => []
    },
    currentLyricIndex: {
      type: Number,
      default: 0
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
    playbackError: {
      type: String,
      default: ''
    },
    autoFollowLyrics: {
      type: Boolean,
      default: true
    }
  },
  emits: ['toggle-auto-follow-lyrics', 'close', 'queue-jump', 'queue-remove', 'update:panelTab'],
  setup(props, { emit }) {
    const playerContainer = ref(null)
    const queueContainer = ref(null)

    const setTab = (tab) => emit('update:panelTab', tab)

    // 队列点歌：当前行即重播同曲？点击当前行无操作（已在播）
    const jumpTo = (song, index) => {
      if (String(song.id) === String(props.currentSong?.id)) return
      emit('queue-jump', index)
    }

    const songArtist = (song) =>
      (song.ar || song.artists || []).map(a => a?.name).filter(Boolean).join('/') || '未知艺人'

    const formatDuration = (song) => formatTime((song.dt || song.duration || 0) / 1000)

    // 监听当前歌词索引变化，实现自动滚动
    watch(() => props.currentLyricIndex, async (newIndex) => {
      if (props.panelTab !== 'lyrics') return
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

          // 平滑滚动到目标位置（reduced-motion 用户直接跳，JS smooth 不吃 CSS 的 auto 降级）
          const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches
          container.scrollTo({
            top: container.scrollTop + scrollOffset,
            behavior: smooth ? 'smooth' : 'auto'
          })
        }
      }
    })

    // 打开抽屉/切 tab 时把当前行滚到中间（否则永远停在顶部）
    const centerCurrentRow = async () => {
      if (!props.open) return
      await nextTick()
      if (props.panelTab === 'lyrics') {
        const el = playerContainer.value?.querySelector(`[data-lyric-index="${props.currentLyricIndex}"]`)
        el?.scrollIntoView({ block: 'center' })
      } else {
        const el = queueContainer.value?.querySelector('.queue-row--current')
        el?.scrollIntoView({ block: 'center' })
      }
    }

    watch(() => props.open, (isOpen) => { if (isOpen) centerCurrentRow() })
    watch(() => props.panelTab, centerCurrentRow)

    return {
      playerContainer,
      queueContainer,
      setTab,
      jumpTo,
      songArtist,
      formatDuration
    }
  }
}
</script>

<style scoped>
/* 抽屉：右侧浮层，层位居 fullscreen(70) 之下、内容之上；
   bottom 避让文档流内的播放条（~72px），滚到底部时末行歌词不被遮住 */
.lyrics-drawer {
  position: fixed;
  top: 0;
  right: 0;
  bottom: calc(88px + env(safe-area-inset-bottom));
  width: min(400px, 100vw);
  z-index: var(--z-drawer);
  display: flex;
  flex-direction: column;
  margin: 0;
  border-radius: 0;
  border-top: none;
  border-right: none;
  border-bottom: none;
  transform: translateX(100%);
  /* visibility 延迟到滑出动画结束后才隐藏——立即切换会吞掉关闭动画 */
  transition: transform 0.28s cubic-bezier(0.32, 0.72, 0, 1), visibility 0s 0.28s;
  /* 抽屉关闭态仍在渲染（歌索引 watch 依赖 DOM），移出可交互/可命中域 */
  pointer-events: none;
  visibility: hidden;
}

.lyrics-drawer--open {
  transform: translateX(0);
  transition: transform 0.28s cubic-bezier(0.32, 0.72, 0, 1), visibility 0s 0s;
  pointer-events: auto;
  visibility: visible;
}

@media (prefers-reduced-motion: reduce) {
  .lyrics-drawer {
    transition: none;
  }
}

.lyrics-drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-bottom: 2px solid rgba(240, 179, 192, 0.2);
  flex-shrink: 0;
  gap: 8px;
}

/* YTM 式 tab 条：文字 tab + 激活下划线 */
.panel-tabs {
  display: flex;
  gap: 14px;
}

.panel-tab {
  font-size: 13px;
  font-weight: bold;
  padding: 4px 2px;
  color: var(--pixel-text-dim);
  border-bottom: 2px solid transparent;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}

.panel-tab:hover {
  color: var(--pixel-text);
}

.panel-tab--active {
  color: var(--pixel-text);
  border-bottom-color: var(--pixel-accent-fg, #f472b6);
}

.lyrics-drawer-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 16px;
  scrollbar-gutter: stable;
}

/* ── 待播队列 ── */
.queue-source {
  font-size: 11px;
  color: var(--pixel-text-dim);
  margin-bottom: 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.queue-body {
  padding-top: 10px;
}

.queue-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 6px;
  cursor: pointer;
  border-left: 3px solid transparent;
  transition: background 0.12s;
}

.queue-row:hover {
  background: rgba(236, 72, 153, 0.08);
}

.queue-row--current {
  border-left-color: var(--pixel-accent-fg, #f472b6);
  background: rgba(236, 72, 153, 0.12);
}

.queue-row-index {
  width: 18px;
  flex-shrink: 0;
  font-size: 11px;
  color: var(--pixel-text-dim);
  text-align: center;
}

.queue-row--current .queue-row-index {
  color: var(--pixel-accent-fg, #f472b6);
}

.queue-row-info {
  flex: 1;
  min-width: 0;
}

.queue-row-title {
  font-size: 12px;
  color: var(--pixel-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.queue-row-artist {
  font-size: 11px;
  color: var(--pixel-text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.queue-row-duration {
  font-size: 11px;
  color: var(--pixel-text-dim);
  flex-shrink: 0;
}

.queue-row-remove {
  flex-shrink: 0;
  font-size: 11px;
  padding: 2px 5px;
  color: var(--pixel-text-dim);
  opacity: 0;
  transition: opacity 0.12s;
}

.queue-row:hover .queue-row-remove,
.queue-row:focus-within .queue-row-remove,
.queue-row-remove:focus-visible {
  opacity: 1;
}

/* 触屏设备无 hover——隐藏但可点的移除键会误删，直接常显 */
@media (hover: none) {
  .queue-row-remove {
    opacity: 1;
  }
}

.queue-row-remove:hover {
  color: #f87171;
}
</style>

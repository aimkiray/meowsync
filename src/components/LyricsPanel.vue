<template>
  <!-- 歌词抽屉：YTM 式按需浮层——不占常驻栏位，底部播放条「歌词」键呼出 -->
  <div
    class="lyrics-drawer jirai-card card-lyrics"
    :class="{ 'lyrics-drawer--open': open }"
    role="complementary"
    aria-label="歌词面板"
  >
    <div class="lyrics-drawer-header">
      <span class="lyrics-drawer-title">歌词</span>
      <div class="flex items-center gap-2">
        <button
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
          title="关闭歌词"
        >✕</button>
      </div>
    </div>

    <div ref="playerContainer" class="lyrics-drawer-body">
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

export default {
  name: 'LyricsPanel',
  props: {
    open: {
      type: Boolean,
      default: false
    },
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
  emits: ['toggle-auto-follow-lyrics', 'close'],
  setup(props) {
    const playerContainer = ref(null)

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

    // 打开抽屉时把当前行滚到中间（否则永远停在顶部）
    watch(() => props.open, async (isOpen) => {
      if (isOpen) {
        await nextTick()
        const container = playerContainer.value
        const el = container?.querySelector(`[data-lyric-index="${props.currentLyricIndex}"]`)
        el?.scrollIntoView({ block: 'center' })
      }
    })

    return {
      playerContainer
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
  bottom: 80px;
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
  padding: 14px 16px;
  border-bottom: 2px solid rgba(240, 179, 192, 0.2);
  flex-shrink: 0;
}

.lyrics-drawer-title {
  font-size: 15px;
  font-weight: bold;
  /* 跟随主题变量而非硬编码粉——pixel-retro 浅色底下 #f9a8d4 对比度不够 */
  color: var(--pixel-text);
}

.lyrics-drawer-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 16px;
  scrollbar-gutter: stable;
}
</style>

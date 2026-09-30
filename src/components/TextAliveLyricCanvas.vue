<template>
  <div ref="container" class="textalive-canvas-host"></div>
</template>

<script>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { CanvasManager } from '../lib/textalive-local/canvas-manager'

// 适配器只在打开全屏播放时才需要，按需加载（多次并发调用共享同一 Promise）
let adapterModule = null
let adapterPromise = null
const loadAdapter = () => {
  if (adapterModule) return Promise.resolve(adapterModule)
  adapterPromise ??= import('../lib/textalive-local/local-textalive-adapter')
    .then(m => (adapterModule = m))
    .catch(err => {
      // 失败不落缓存：重置后下一次 syncLyrics 会重新发起 import，
      // 否则 chunk 拉取偶发失败后歌词将永久空白（rejected promise 被 ??= 永久缓存）
      adapterPromise = null
      throw err
    })
  return adapterPromise
}

export default {
  name: 'TextAliveLyricCanvas',
  props: {
    lyrics: {
      type: Array,
      default: () => []
    },
    currentTime: {
      type: Number,
      default: 0
    },
    duration: {
      type: Number,
      default: 0
    },
    isPlaying: {
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
    },
    // 歌词时间校准（ms，正=提前）：等效把渲染时钟拨快 offset——
    // 与 startLyricSync 里 seek()+offset/1000 同一约定
    lyricOffsetMs: {
      type: Number,
      default: 0
    }
  },
  setup(props) {
    const container = ref(null)
    let manager = null

    const displayLyrics = computed(() => {
      if (props.lyricMode !== 'translation') return props.lyrics
      return (props.lyrics || []).map(line => ({
        ...line,
        text: line.translation?.trim() || line.text
      }))
    })

    const syncLyrics = () => {
      if (!manager) return
      loadAdapter()
        .then(({ createLocalTextAliveLyrics }) => {
          if (!manager) return
          const { lyrics } = createLocalTextAliveLyrics(displayLyrics.value, props.duration)
          manager.setLyrics(lyrics)
          manager.update(lyricClockMs())
        })
        // 兜底 catch：加载失败已重置缓存可重试，这里避免 unhandledrejection 噪音
        .catch(err => console.warn('[textalive] lyric sync failed:', err))
    }

    // 渲染时钟 = 播放时钟 + 校准（秒→ms）
    const lyricClockMs = () => ((props.currentTime || 0) + props.lyricOffsetMs / 1000) * 1000

    const syncPosition = () => {
      if (!manager) return
      manager.update(lyricClockMs())
    }

    const syncInteractionMode = () => {
      if (!manager) return
      manager.setInteractionMode(props.interactionMode)
    }

    onMounted(() => {
      if (!container.value) return
      manager = new CanvasManager(container.value)
      syncInteractionMode()
      syncLyrics()
    })

    onUnmounted(() => {
      manager?.destroy()
      manager = null
    })

    watch(displayLyrics, syncLyrics)
    watch(() => props.duration, syncLyrics)
    watch(() => props.currentTime, syncPosition)
    // 校准值变化即时重同步——暂停/全屏中调节也要生效，不能等下一个播放 tick
    watch(() => props.lyricOffsetMs, syncPosition)
    watch(() => props.isPlaying, syncPosition)
    watch(() => props.interactionMode, syncInteractionMode)

    return {
      container
    }
  }
}
</script>

<style scoped>
.textalive-canvas-host {
  position: absolute;
  inset: 0;
  overflow: hidden;
  cursor: default;
}

.textalive-canvas-host :deep(canvas) {
  width: 100%;
  height: 100%;
}
</style>

<template>
  <div ref="container" class="textalive-canvas-host"></div>
</template>

<script>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { CanvasManager } from '../lib/textalive-local/canvas-manager'
import { createLocalTextAliveLyrics } from '../lib/textalive-local/local-textalive-adapter'

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
      const { lyrics } = createLocalTextAliveLyrics(displayLyrics.value, props.duration)
      manager.setLyrics(lyrics)
      manager.update((props.currentTime || 0) * 1000)
    }

    const syncPosition = () => {
      if (!manager) return
      manager.update((props.currentTime || 0) * 1000)
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

    watch(displayLyrics, syncLyrics, { deep: true })
    watch(() => props.duration, syncLyrics)
    watch(() => props.currentTime, syncPosition)
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

<template>
  <!-- 印刷装饰件：裁切角标 / ∵⩆ 套准符 / 版本戳 -->
  <svg
    v-if="variant === 'hash'"
    class="pg-hash"
    viewBox="0 0 1240 10"
    fill="none"
    stroke="currentColor"
    stroke-width="1.2"
    stroke-linejoin="round"
    style="image-rendering: pixelated"
    preserveAspectRatio="none"
    aria-hidden="true"
  >
    <path d="M10 0H0V10"/><path d="M1230 0H1240V10"/>
  </svg>

  <div v-else-if="variant === 'reg'" class="regmarks" aria-hidden="true">
    <span>∵ ⩆</span><span>⩆ ∵</span>
  </div>

  <div v-else-if="variant === 'stamp'" class="pg-stamp">
    <p><GlitchText text="MeowSync · Version 1.0.0" /></p>
    <p><GlitchText text="©2026 · All rights reserved" /></p>
    <p><GlitchText text="Made with Love" /></p>
  </div>
</template>

<script>
import GlitchText from './GlitchText.vue'

export default {
  name: 'PrintMarks',
  components: { GlitchText },
  props: {
    variant: {
      type: String,
      default: 'hash',
      validator: (v) => ['hash', 'reg', 'stamp'].includes(v)
    }
  }
}
</script>

<style scoped>
.pg-hash {
  display: block;
  width: 100%;
  height: 10px;
  color: var(--ink-86); /* stroke=currentColor：描边色收编进令牌 */
}
</style>

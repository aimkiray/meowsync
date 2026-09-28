<template>
  <!-- 印刷装饰件：裁切角标 / ∵⩆ 套准符 / 版本戳 / [b.64] 彩蛋 -->
  <svg
    v-if="variant === 'hash'"
    class="pg-hash"
    :class="{ 'pg-hash--flip': flip }"
    viewBox="0 0 1240 10"
    fill="none"
    stroke="rgba(30,30,30,.86)"
    stroke-width="1.2"
    stroke-linejoin="round"
    style="image-rendering: pixelated"
    preserveAspectRatio="none"
    aria-hidden="true"
  >
    <template v-if="!flip">
      <path d="M10 0H0V10"/><path d="M1230 0H1240V10"/>
    </template>
    <template v-else>
      <path d="M10 10H0V0"/><path d="M1230 10H1240V0"/>
    </template>
  </svg>

  <div v-else-if="variant === 'reg'" class="regmarks" aria-hidden="true">
    <span>∵ ⩆</span><span>⩆ ∵</span>
  </div>

  <div v-else-if="variant === 'stamp'" class="pg-stamp">
    <p>MeowSync · Version 1.0.0</p>
    <p>©2026 · All rights reserved</p>
    <p>Made with Love · MS.OS1</p>
  </div>

  <div v-else-if="variant === 'b64'" class="pg-b64">
    <span class="pg-b64-label" aria-hidden="true">[b.64]</span>
    <span class="pg-b64-body">{{ payload }}</span>
  </div>
</template>

<script>
export default {
  name: 'PrintMarks',
  props: {
    variant: {
      type: String,
      default: 'hash',
      validator: (v) => ['hash', 'reg', 'stamp', 'b64'].includes(v)
    },
    flip: { type: Boolean, default: false },
    // 解码即 "MeowSync: cats love music. ms.os1"
    payload: { type: String, default: 'TWVvd1N5bmM6IGNhdHMgbG92ZSBtdXNpYy4gbXMub3Mx' }
  }
}
</script>

<style scoped>
.pg-hash {
  display: block;
  width: 100%;
  height: 10px;
}
.pg-b64-body { font-weight: 300; }
</style>

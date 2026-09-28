<template>
  <!-- 分页条：仅被 SongList 消费 → 同落 sage 纸色画布（--canvas-sage #abbab9）。
       发丝方格翻页键 + 墨底反白当前页读数；
       barStyle 是 retro 主题遗留接口，print-grid 条不再消费它（prop 保留兼容父组件传参） -->
  <div class="pg-pagination">
    <button
      @click="$emit('go-to-page', 1)"
      :disabled="currentPage === 1"
      class="pg-icobtn pg-pagination-btn"
      title="第一页"
      aria-label="第一页"
    ><PixelIcon name="first" :size="14" /></button>

    <button
      @click="$emit('prev-page')"
      :disabled="currentPage === 1"
      class="pg-icobtn pg-pagination-btn"
      title="上一页"
      aria-label="上一页"
    ><PixelIcon name="chev-l" :size="14" /></button>

    <span class="pg-label pg-label--dim pg-pagination-label">
      第 <span class="pg-page-cur">{{ currentPage }}</span> 页 / 共 {{ totalPages }} 页
    </span>

    <button
      @click="$emit('next-page')"
      :disabled="currentPage === totalPages"
      class="pg-icobtn pg-pagination-btn"
      title="下一页"
      aria-label="下一页"
    ><PixelIcon name="chev-r" :size="14" /></button>

    <button
      @click="$emit('go-to-page', totalPages)"
      :disabled="currentPage === totalPages"
      class="pg-icobtn pg-pagination-btn"
      title="最后一页"
      aria-label="最后一页"
    ><PixelIcon name="last" :size="14" /></button>
  </div>
</template>

<script>
import PixelIcon from './PixelIcon.vue'

export default {
  components: { PixelIcon },
  name: 'PaginationControls',
  props: {
    currentPage: { type: Number, default: 1 },
    totalPages: { type: Number, default: 1 },
    barStyle: { type: Object, default: null }
  },
  emits: ['go-to-page', 'prev-page', 'next-page']
}
</script>

<style scoped>
.pg-pagination {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
}

.pg-pagination-btn {
  font-size: 13px;
}

/* "第 ■ 页 / 共 y 页"读数：■ 为墨底反白的当前页 */
.pg-pagination-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  white-space: nowrap;
}

.pg-page-cur {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  background: var(--ink);
  color: var(--paper);
}
</style>

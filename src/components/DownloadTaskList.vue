<template>
  <!-- 下载任务列：纸面发丝盒 + 统计格 + 分组任务卡 -->
  <div class="pg-panel dtl-panel h-full flex flex-col">
    <div class="dtl-head">
      <div class="dtl-head-info">
        <h2 class="dtl-title"><GlitchText text="下载任务" /></h2>
        <p v-if="selectedQueue" class="pg-label pg-label--dim dtl-sub">
          {{ selectedQueue.name }} · {{ tasks.length }} 条任务
        </p>
        <p v-else class="pg-label pg-label--dim dtl-sub">
          选择左侧队列后，这里会显示任务详情喵~
        </p>
      </div>
      <span v-if="selectedQueue" class="pg-chip pg-chip--static dtl-count">
        队列 #{{ selectedQueue.id }}
      </span>
    </div>

    <div v-if="selectedQueue" class="dtl-stats grid grid-cols-2 xl:grid-cols-4 gap-2">
      <div class="dtl-stat">
        <p class="pg-label pg-label--dim">总任务</p>
        <p class="dtl-stat-num">{{ taskStats.total }}</p>
      </div>
      <div class="dtl-stat">
        <p class="pg-label pg-label--dim">下载中</p>
        <p class="dtl-stat-num">{{ taskStats.downloading }}</p>
      </div>
      <div class="dtl-stat">
        <p class="pg-label pg-label--dim">已完成</p>
        <p class="dtl-stat-num dtl-stat-num--ok">{{ taskStats.completed }}</p>
      </div>
      <div class="dtl-stat">
        <p class="pg-label pg-label--dim">失败</p>
        <p class="dtl-stat-num dtl-stat-num--fail">{{ taskStats.failed }}</p>
      </div>
    </div>

    <div v-if="!selectedQueue" class="dtl-empty">
      <div class="dtl-empty-icon"><PixelIcon name="note" :size="34" /></div>
      <p class="dtl-empty-title">先从左侧挑一个下载队列喵</p>
      <p class="dtl-empty-sub">选中后就能看到每首歌的下载状态、进度和失败原因。</p>
    </div>

    <div v-else-if="loading" class="dtl-state">
      <div class="pixel-loading" aria-hidden="true"></div>
      <p class="dtl-state-text">加载任务中喵...</p>
    </div>

    <div v-else-if="tasks.length === 0" class="dtl-empty">
      <p class="dtl-empty-title">这条队列里还没有任务喵~</p>
      <p class="dtl-empty-sub">如果这是新建队列，稍等一下就会开始填充任务列表。</p>
    </div>

    <div v-else ref="scrollEl" class="dtl-scroll flex-1 min-h-0">
      <section v-if="groupedTasks.failed.length" class="dtl-group">
        <div class="dtl-group-head">
          <span class="dtl-group-tag dtl-group-tag--fail">failed:</span>
          <span class="pg-label pg-label--dim">{{ groupedTasks.failed.length }} 条</span>
        </div>
        <div
          v-for="task in pgFailed.rows.value"
          :key="task.id"
          class="dtl-task"
        >
          <TaskRow :task="task" :retrying-task-id="retryingTaskId" :get-status-class="getStatusClass" :get-status-text="getStatusText" @retry-task="$emit('retry-task', $event)" />
        </div>
        <button
          v-if="pgFailed.hasMore.value"
          :ref="pgFailed.bindSentinel"
          class="ink-btn ink-btn--ghost ink-btn--sm dtl-more"
          @click="pgFailed.loadMore()"
        >加载更多 · {{ pgFailed.renderedCount.value }} / {{ groupedTasks.failed.length }}</button>
      </section>

      <section v-if="groupedTasks.downloading.length" class="dtl-group">
        <div class="dtl-group-head">
          <span class="dtl-group-tag">downloading:</span>
          <span class="pg-label pg-label--dim">{{ groupedTasks.downloading.length }} 条</span>
        </div>
        <div
          v-for="task in pgDownloading.rows.value"
          :key="task.id"
          class="dtl-task"
        >
          <TaskRow :task="task" :get-status-class="getStatusClass" :get-status-text="getStatusText" />
        </div>
        <button
          v-if="pgDownloading.hasMore.value"
          :ref="pgDownloading.bindSentinel"
          class="ink-btn ink-btn--ghost ink-btn--sm dtl-more"
          @click="pgDownloading.loadMore()"
        >加载更多 · {{ pgDownloading.renderedCount.value }} / {{ groupedTasks.downloading.length }}</button>
      </section>

      <section v-if="groupedTasks.pending.length" class="dtl-group">
        <div class="dtl-group-head">
          <span class="dtl-group-tag">pending:</span>
          <span class="pg-label pg-label--dim">{{ groupedTasks.pending.length }} 条</span>
        </div>
        <div
          v-for="task in pgPending.rows.value"
          :key="task.id"
          class="dtl-task"
        >
          <TaskRow :task="task" :get-status-class="getStatusClass" :get-status-text="getStatusText" />
        </div>
        <button
          v-if="pgPending.hasMore.value"
          :ref="pgPending.bindSentinel"
          class="ink-btn ink-btn--ghost ink-btn--sm dtl-more"
          @click="pgPending.loadMore()"
        >加载更多 · {{ pgPending.renderedCount.value }} / {{ groupedTasks.pending.length }}</button>
      </section>

      <section v-if="groupedTasks.completed.length" class="dtl-group">
        <button
          type="button"
          class="dtl-group-toggle"
          :aria-expanded="showCompleted"
          @click="showCompleted = !showCompleted"
        >
          <span class="dtl-group-toggle-left">
            <span class="dtl-group-tag dtl-group-tag--ok">completed:</span>
            <span class="pg-label pg-label--dim">{{ groupedTasks.completed.length }} 条</span>
          </span>
          <span class="dtl-group-toggle-note">{{ showCompleted ? '收起' : '展开' }}</span>
        </button>
        <template v-if="showCompleted">
          <div
            v-for="task in pgCompleted.rows.value"
            :key="task.id"
            class="dtl-task"
          >
            <TaskRow :task="task" :get-status-class="getStatusClass" :get-status-text="getStatusText" />
          </div>
          <button
            v-if="pgCompleted.hasMore.value"
            :ref="pgCompleted.bindSentinel"
            class="ink-btn ink-btn--ghost ink-btn--sm dtl-more"
            @click="pgCompleted.loadMore()"
          >加载更多 · {{ pgCompleted.renderedCount.value }} / {{ groupedTasks.completed.length }}</button>
        </template>
      </section>
    </div>
  </div>
</template>

<script setup>
import { computed, h, ref, watch } from 'vue';
import { usePagedList } from '../composables/usePagedList.js';
import { httpsCover } from '../lib/url';
import PixelIcon from './PixelIcon.vue';
import GlitchText from './GlitchText.vue';

const props = defineProps({
  tasks: {
    type: Array,
    default: () => []
  },
  loading: {
    type: Boolean,
    default: false
  },
  selectedQueue: {
    type: Object,
    default: null
  },
  retryingTaskId: {
    type: Number,
    default: null
  }
});

defineEmits(['retry-task']);

const showCompleted = ref(false);

watch(() => props.selectedQueue?.id, () => {
  showCompleted.value = false;
});

// 全量下载成功的队列默认展开 completed 组——否则右栏只剩一条收起行，面板是空的。
// watch 只在 allDone false→true 时触发，用户手动收起后不打扰
watch(
  () => props.tasks.length > 0 && props.tasks.every(t => t.status === 'completed'),
  (allDone) => { if (allDone) showCompleted.value = true; },
  { immediate: true }
);

const taskStats = computed(() => ({
  total: props.tasks.length,
  pending: props.tasks.filter(task => task.status === 'pending').length,
  downloading: props.tasks.filter(task => task.status === 'downloading').length,
  completed: props.tasks.filter(task => task.status === 'completed').length,
  failed: props.tasks.filter(task => task.status === 'failed').length
}));

const groupedTasks = computed(() => ({
  failed: props.tasks.filter(task => task.status === 'failed'),
  downloading: props.tasks.filter(task => task.status === 'downloading'),
  pending: props.tasks.filter(task => task.status === 'pending'),
  completed: props.tasks.filter(task => task.status === 'completed')
}));

// 每组独立渐进渲染窗——大队列的 pending/completed 都可上千，全量渲卡。
// 复位只认队列身份（与 showCompleted 复位同 watch 键）；
// 2s 轮询换 tasks 引用不回卷（前缀窗自夹，不丢滚动位置）
const scrollEl = ref(null);
const mkGroupWindow = (get) => usePagedList({
  source: computed(get),
  pageSize: 100,
  resetWhen: () => props.selectedQueue?.id,
  scrollRoot: () => scrollEl.value
});
// pgXxx 是普通对象——模板里 pgXxx.rows.value 的 .value 是必须的：
// Vue 只自动解包渲染上下文顶层 ref，嵌套在普通对象内的 ref 永不自动解包
const pgFailed = mkGroupWindow(() => groupedTasks.value.failed);
const pgDownloading = mkGroupWindow(() => groupedTasks.value.downloading);
const pgPending = mkGroupWindow(() => groupedTasks.value.pending);
const pgCompleted = mkGroupWindow(() => groupedTasks.value.completed);

function getStatusText(status) {
  const statusMap = {
    pending: '等待',
    downloading: '下载中',
    completed: '完成',
    failed: '失败'
  };
  return statusMap[status] || status;
}

// 状态 → 芯片修饰类（print-grid 配色）：downloading=墨底反白，completed=绿戳，
// failed=危险红，pending 淡墨。只换类名不改映射结构
function getStatusClass(status) {
  const classMap = {
    pending: 'dtr-chip--dim',
    downloading: 'pg-chip--on',
    completed: 'dtr-chip--ok',
    failed: 'dtr-chip--fail'
  };
  return classMap[status] || 'dtr-chip--dim';
}

// TaskRow 是内联渲染函数组件：产出的内层元素没有父组件 scopeId，
// 其样式只能走本文件 <style scoped> 里的 :deep() 通道（见下方样式注释）
const TaskRow = {
  props: {
    task: {
      type: Object,
      required: true
    },
    getStatusClass: {
      type: Function,
      required: true
    },
    getStatusText: {
      type: Function,
      required: true
    },
    retryingTaskId: {
      type: Number,
      default: null
    }
  },
  emits: ['retry-task'],
  setup(rowProps, { emit }) {
    return () => h('div', { class: 'dtr' }, [
      h('div', { class: 'dtr-cover' }, rowProps.task.coverUrl
        ? h('img', {
          // coverPath 是服务器相对路径（无对应文件路由），当 img src 只会 404——不兜底。
          // coverUrl 是上游 http 明文 CDN 地址：HTTPS 部署下被动混合内容
          // 会被浏览器拦截，显式升级 https（*.music.126.net 均支持 TLS）
          src: httpsCover(rowProps.task.coverUrl),
          alt: rowProps.task.songName,
          class: 'dtr-cover-img'
        })
        : h('div', { class: 'dtr-cover-fb' }, [h(PixelIcon, { name: 'note', size: 14 })])),
      h('div', { class: 'dtr-body' }, [
        h('div', { class: 'dtr-top' }, [
          h('div', { class: 'dtr-headcell' }, [
            h('div', { class: 'dtr-namerow' }, [
              h('h4', { class: 'dtr-name' }, rowProps.task.songName),
              h('span', {
                class: `pg-chip pg-chip--static dtr-chip ${rowProps.getStatusClass(rowProps.task.status)}`
              }, rowProps.getStatusText(rowProps.task.status))
            ]),
            h('p', { class: 'dtr-artist' }, rowProps.task.artist)
          ]),
          h('div', { class: 'dtr-id' }, `#${rowProps.task.id}`)
        ]),
        h('div', { class: 'dtr-flags' }, [
          rowProps.task.downloadAudio ? h('span', { class: 'dtr-flag' }, '音频') : null,
          rowProps.task.downloadLyrics ? h('span', { class: 'dtr-flag' }, '歌词') : null,
          rowProps.task.downloadCover ? h('span', { class: 'dtr-flag' }, '封面') : null
        ].filter(Boolean)),
        rowProps.task.status === 'downloading'
          ? h('div', { class: 'dtr-progress-wrap' }, [
            h('div', {
              class: 'dtr-progress',
              role: 'progressbar',
              'aria-valuenow': Math.max(0, Math.min(100, rowProps.task.progress || 0)),
              'aria-valuemin': 0, 'aria-valuemax': 100,
              'aria-label': '下载进度'
            }, [
              h('div', {
                class: 'dtr-progress-fill',
                // undefined/>100 会产生非法/溢出样式
                style: `--p: ${Math.max(0, Math.min(100, rowProps.task.progress || 0))}`
              })
            ]),
            h('div', { class: 'dtr-progress-num' }, `${Math.max(0, Math.min(100, rowProps.task.progress || 0))}%`)
          ])
          : null,
        rowProps.task.status === 'failed'
          ? h('div', { class: 'dtr-err' }, [
            h('p', { class: 'dtr-err-line' }, [
              h('span', { class: 'dtr-err-tag' }, 'error:'),
              ` ${rowProps.task.errorMessage || '下载失败喵'}`
            ]),
            rowProps.task.retryCount > 0
              ? h('p', { class: 'dtr-retry-note' }, `已重试 ${rowProps.task.retryCount} 次`)
              : null,
            h('button', {
              class: 'ink-btn ink-btn--ghost ink-btn--sm dtr-retry-btn',
              disabled: rowProps.retryingTaskId === rowProps.task.id,
              onClick: () => emit('retry-task', rowProps.task.id)
            }, rowProps.retryingTaskId === rowProps.task.id ? '重试中...' : '重试任务')
          ].filter(Boolean))
          : null,
        rowProps.task.status === 'completed'
          ? h('div', { class: 'dtr-done' }, [h(PixelIcon, { name: 'check', size: 11 }), '下载完成喵'])
          : null
      ])
    ]);
  }
};
</script>

<style scoped>
/* 纸面发丝盒：头部/统计内收，任务区贴边滚动 */
.dtl-panel {
  padding: 14px 0 0;
}

.dtl-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 0 16px 12px;
  flex-shrink: 0;
}

.dtl-head-info { min-width: 0; }

.dtl-title {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 15px;
  line-height: 1.2;
  color: var(--ink);
}

.dtl-sub { margin-top: 5px; }

.dtl-count { flex-shrink: 0; }

/* 统计格：发丝格 + display 大数字（完成=绿戳，失败=danger 红） */
.dtl-stats {
  padding: 0 16px 12px;
  flex-shrink: 0;
}

.dtl-stat {
  border: var(--hairline);
  padding: 8px 10px;
}

.dtl-stat-num {
  margin-top: 4px;
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 18px;
  line-height: 1;
  color: var(--ink);
}

.dtl-stat-num--ok { color: var(--ink); text-decoration: underline 1.2px var(--accent-green); text-underline-offset: 3px; }
.dtl-stat-num--fail { color: var(--ink); text-decoration: underline 1.2px var(--accent-danger); text-underline-offset: 3px; }

.dtl-state {
  border-top: var(--hairline-soft); /* 与 .dtl-scroll 同位，空态不断线 */
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 32px 16px;
  flex: 1;
  justify-content: center;
}

.dtl-state-text {
  font-size: 12px;
  color: var(--ink-64);
}

.dtl-empty {
  border-top: var(--hairline-soft); /* 与 .dtl-scroll 同位，空态不断线 */
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 32px 24px;
  text-align: center;
}

.dtl-empty-icon { color: var(--ink-64); }

.dtl-empty-title {
  font-size: 13px;
  color: var(--ink);
}

.dtl-empty-sub {
  font-size: 12px;
  color: var(--ink-64);
  max-width: 32ch;
}

.dtl-scroll {
  overflow-y: auto;
  border-top: var(--hairline-soft);
  padding: 12px 16px;
}
/* 同 .dql-scroll：<xl 滚动器在外层网格，本列不内滚——车道只在 ≥xl 常驻 */
@media (min-width: 1280px) {
  .dtl-scroll { scrollbar-gutter: stable; }
}

.dtl-group + .dtl-group { margin-top: 14px; }

.dtl-group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

/* 分组签：等宽小写，状态即签名（failed/completed 上色） */
.dtl-group-tag {
  font-family: var(--font-mono);
  font-weight: 300;
  font-size: 12px;
  letter-spacing: .05em;
  color: var(--ink);
}

.dtl-group-tag--fail { color: var(--accent-danger-ink); }
.dtl-group-tag--ok { color: var(--accent-green-ink); }

/* 任务卡：发丝盒 */
.dtl-task {
  border: var(--hairline);
  padding: 10px;
}

.dtl-task + .dtl-task { margin-top: 8px; }

/* 已完成折叠头：整行发丝盒可点 */
.dtl-group-toggle {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 10px;
  margin-bottom: 8px;
  border: var(--hairline);
  background: transparent;
  color: var(--ink);
  cursor: pointer;
  text-align: left;
  transition: background .12s;
}

.dtl-group-toggle:hover { background: var(--ink-06); }

.dtl-group-toggle-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.dtl-group-toggle-note {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-64);
  flex-shrink: 0;
}

/* 组内渐进渲染哨兵：居中 ghost 键，IO 命中或点按扩窗 */
.dtl-more {
  display: flex;
  margin: 10px auto 2px;
}

/* ── TaskRow 内部件：内联组件元素无本文件 scopeId，须 :deep() 命中 ── */
.dtl-task :deep(.dtr) {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.dtl-task :deep(.dtr-cover) {
  width: 40px;
  height: 40px;
  border: var(--hairline);
  flex-shrink: 0;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ink-64);
  background: var(--paper);
}

.dtl-task :deep(.dtr-cover-img) {
  width: 100%;
  height: 100%;
  object-fit: cover;
  image-rendering: pixelated;
  display: block;
}

.dtl-task :deep(.dtr-body) { flex: 1; min-width: 0; }

.dtl-task :deep(.dtr-top) {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.dtl-task :deep(.dtr-headcell) { flex: 1; min-width: 0; }

.dtl-task :deep(.dtr-namerow) {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.dtl-task :deep(.dtr-name) {
  font-size: 13px;
  font-weight: 500;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.dtl-task :deep(.dtr-artist) {
  margin-top: 2px;
  font-size: 11px;
  color: var(--ink-64);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dtl-task :deep(.dtr-id) {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-64);
  flex-shrink: 0;
  text-align: right;
}

.dtl-task :deep(.dtr-flags) {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin-top: 4px;
}

.dtl-task :deep(.dtr-flag) {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-64);
}

.dtl-task :deep(.dtr-chip) {
  height: 20px;
  padding: 0 8px;
  font-size: 10px;
  flex-shrink: 0;
}

.dtl-task :deep(.dtr-chip.dtr-chip--dim) { color: var(--ink-64); }
.dtl-task :deep(.dtr-chip.dtr-chip--ok) { color: var(--accent-green-ink); border-color: var(--accent-green); }
.dtl-task :deep(.dtr-chip.dtr-chip--fail) { color: var(--accent-danger-ink); border-color: var(--accent-danger); }

.dtl-task :deep(.dtr-progress-wrap) {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}

.dtl-task :deep(.dtr-progress) {
  flex: 1;
  height: 4px;
  background: var(--ink-10);
  overflow: hidden;
}

.dtl-task :deep(.dtr-progress-fill) {
  height: 100%;
  width: 100%;
  transform: scaleX(calc(var(--p, 0) / 100));
  transform-origin: left;
  background: var(--ink);
  transition: transform .3s var(--ease-ink);
}

.dtl-task :deep(.dtr-progress-num) {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-64);
  width: 36px;
  text-align: right;
  flex-shrink: 0;
}

.dtl-task :deep(.dtr-err) { margin-top: 5px; }

.dtl-task :deep(.dtr-err-line) {
  font-size: 11px;
  color: var(--ink);
  word-break: break-word;
}

.dtl-task :deep(.dtr-err-tag) {
  font-family: var(--font-mono);
  font-weight: 300;
  letter-spacing: .05em;
  color: var(--accent-danger-ink);
}

.dtl-task :deep(.dtr-retry-note) {
  margin-top: 4px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-64);
}

.dtl-task :deep(.dtr-retry-btn) { margin-top: 6px; }

.dtl-task :deep(.dtr-done) {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 5px;
  font-size: 11px;
  color: var(--ink-86);
}

.dtl-task :deep(.dtr-done svg) { color: var(--accent-green); }
</style>

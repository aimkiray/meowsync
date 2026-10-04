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

    <!-- 错误态优先于 standalone 非空短路：队列任务首载失败时 standalone
         分节照常能加载，双空判定会把失败吞成正常列表误导用户 -->
    <div v-else-if="emptyError || (tasks.length === 0 && standaloneTasks.length === 0)" class="dtl-empty">
      <p class="dtl-empty-title">{{ emptyError || '这条队列里还没有任务喵~' }}</p>
      <p v-if="!emptyError" class="dtl-empty-sub">如果这是新建队列，稍等一下就会开始填充任务列表。</p>
    </div>

    <div v-else ref="scrollEl" class="dtl-scroll flex-1 min-h-0">
      <!-- failed/downloading/pending 三段同构，描述数组驱动；completed 可折叠单列 -->
      <template v-for="grp in taskGroups" :key="grp.key">
        <section v-if="groupedTasks[grp.key].length" class="dtl-group">
          <div class="dtl-group-head">
            <span class="dtl-group-tag" :class="grp.tagClass">{{ grp.tag }}</span>
            <span class="pg-label pg-label--dim">{{ groupedTasks[grp.key].length }} 条</span>
          </div>
          <div
            v-for="task in grp.pg.rows.value"
            :key="task.id"
            class="dtl-task"
          >
            <DownloadTaskRow :task="task" :retrying-task-ids="retryingTaskIds" @retry-task="$emit('retry-task', $event)" />
          </div>
          <button
            v-if="grp.pg.hasMore.value"
            :ref="grp.pg.bindSentinel"
            class="ink-btn ink-btn--ghost ink-btn--sm dtl-more"
            @click="grp.pg.loadMore()"
          >加载更多 · {{ grp.pg.renderedCount.value }} / {{ groupedTasks[grp.key].length }}</button>
        </section>
      </template>

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
            <!-- 重试钮只在 failed 渲染，completed 组转发是死路径——与上段对称保留，防未来动作漏接 -->
            <DownloadTaskRow :task="task" :retrying-task-ids="retryingTaskIds" @retry-task="$emit('retry-task', $event)" />
          </div>
          <button
            v-if="pgCompleted.hasMore.value"
            :ref="pgCompleted.bindSentinel"
            class="ink-btn ink-btn--ghost ink-btn--sm dtl-more"
            @click="pgCompleted.loadMore()"
          >加载更多 · {{ pgCompleted.renderedCount.value }} / {{ groupedTasks.completed.length }}</button>
        </template>
      </section>

      <!-- 未入队单曲：同歌单 queue_id=NULL 的 standalone 下载——不属于队列
           调度（暂停/取消语义不适用），但重试/删除要可见 -->
      <section v-if="standaloneTasks.length" class="dtl-group">
        <div class="dtl-group-head">
          <span class="dtl-group-tag">standalone:</span>
          <span class="pg-label pg-label--dim">未入队单曲 · {{ standaloneTasks.length }} 条</span>
        </div>
        <div
          v-for="task in pgStandalone.rows.value"
          :key="task.id"
          class="dtl-task"
        >
          <DownloadTaskRow
            :task="task"
            :retrying-task-ids="retryingTaskIds"
            :deleting="deletingTaskIds.includes(task.id)"
            deletable
            @retry-task="$emit('retry-task', $event)"
            @delete-task="$emit('delete-task', $event)"
          />
        </div>
        <button
          v-if="pgStandalone.hasMore.value"
          :ref="pgStandalone.bindSentinel"
          class="ink-btn ink-btn--ghost ink-btn--sm dtl-more"
          @click="pgStandalone.loadMore()"
        >加载更多 · {{ pgStandalone.renderedCount.value }} / {{ standaloneTasks.length }}</button>
      </section>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { usePagedList } from '../composables/usePagedList.js'
import PixelIcon from './PixelIcon.vue'
import GlitchText from './GlitchText.vue'
import DownloadTaskRow from './DownloadTaskRow.vue'

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
  retryingTaskIds: {
    type: Array,
    default: () => []
  },
  // 首载失败与"真的为空"要区分——否则任务接口挂掉时显示假空态误导
  emptyError: {
    type: String,
    default: ''
  },
  // 未入队单曲分节：同歌单 queue_id=NULL 的 standalone 任务（与队列任务不同属）
  standaloneTasks: {
    type: Array,
    default: () => []
  },
  deletingTaskIds: {
    type: Array,
    default: () => []
  }
})

defineEmits(['retry-task', 'delete-task'])

const showCompleted = ref(false)

watch(() => props.selectedQueue?.id, () => {
  showCompleted.value = false
})

// 全量下载成功的队列默认展开 completed 组——否则右栏只剩一条收起行，面板是空的。
// watch 只在 allDone false→true 时触发，用户手动收起后不打扰
watch(
  () => props.tasks.length > 0 && props.tasks.every(t => t.status === 'completed'),
  (allDone) => { if (allDone) showCompleted.value = true },
  { immediate: true }
)

const taskStats = computed(() => ({
  total: props.tasks.length,
  downloading: props.tasks.filter(task => task.status === 'downloading').length,
  completed: props.tasks.filter(task => task.status === 'completed').length,
  failed: props.tasks.filter(task => task.status === 'failed').length
}))

const groupedTasks = computed(() => ({
  failed: props.tasks.filter(task => task.status === 'failed'),
  downloading: props.tasks.filter(task => task.status === 'downloading'),
  pending: props.tasks.filter(task => task.status === 'pending'),
  completed: props.tasks.filter(task => task.status === 'completed')
}))

// 每组独立渐进渲染窗——大队列的 pending/completed 都可上千，全量渲卡。
// 复位只认队列身份（与 showCompleted 复位同 watch 键）；
// 2s 轮询换 tasks 引用不回卷（前缀窗自夹，不丢滚动位置）
const scrollEl = ref(null)
const mkGroupWindow = (get) => usePagedList({
  source: computed(get),
  pageSize: 100,
  resetWhen: () => props.selectedQueue?.id,
  scrollRoot: () => scrollEl.value
})
// pgXxx 是普通对象——模板里 pgXxx.rows.value 的 .value 是必须的：
// Vue 只自动解包渲染上下文顶层 ref，嵌套在普通对象内的 ref 永不自动解包
const pgFailed = mkGroupWindow(() => groupedTasks.value.failed)
const pgDownloading = mkGroupWindow(() => groupedTasks.value.downloading)
const pgPending = mkGroupWindow(() => groupedTasks.value.pending)
const pgCompleted = mkGroupWindow(() => groupedTasks.value.completed)
const pgStandalone = mkGroupWindow(() => props.standaloneTasks)

// 同构三段的组描述数组：key 对 groupedTasks，pg 是该组的渐进窗
const taskGroups = [
  { key: 'failed', tag: 'failed:', tagClass: 'dtl-group-tag--fail', pg: pgFailed },
  { key: 'downloading', tag: 'downloading:', tagClass: '', pg: pgDownloading },
  { key: 'pending', tag: 'pending:', tagClass: '', pg: pgPending }
]
</script>

<style scoped>
/* 纸面发丝盒：头部/统计内收，任务区贴边滚动 */
.dtl-panel {
  padding: 14px 0 0;
}

.dtl-head {
  display: flex;
  align-items: center; /* chip 顶对会悬在标题块中段——中对齐整块更稳 */
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
</style>

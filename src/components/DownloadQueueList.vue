<template>
  <!-- 下载队列列：纸面发丝盒，队列发丝行；行尾 ⋯ 菜单 teleport 到 body -->
  <div class="pg-panel dql-panel h-full flex flex-col">
    <div class="dql-head">
      <div class="dql-head-info">
        <h2 class="dql-title"><GlitchText text="下载队列" /></h2>
        <p class="pg-label pg-label--dim dql-sub">左侧选队列，右侧看详情喵~</p>
      </div>
      <span class="pg-chip pg-chip--static dql-count">{{ queues.length }} 条</span>
    </div>

    <div class="dql-filters">
      <div class="pg-field">
        <input
          :value="searchQuery"
          type="text"
          placeholder="搜索队列名..."
          @input="$emit('update:search-query', $event.target.value)"
        />
        <select
          :value="statusFilter"
          @change="$emit('update:status-filter', $event.target.value)"
        >
          <option v-for="opt in queueStatusFilterOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
        </select>
      </div>
    </div>

    <div v-if="loading" class="dql-state">
      <div class="pixel-loading" aria-hidden="true"></div>
      <p class="dql-state-text">加载队列中喵...</p>
    </div>

    <div v-else-if="queues.length === 0" class="dql-state">
      <p class="dql-state-text">{{ emptyText }}</p>
    </div>

    <div v-else class="dql-scroll flex-1 min-h-0">
      <div
        v-for="queue in queues"
        :key="queue.id"
        class="dql-row"
        :class="{ 'dql-row--sel': selectedQueueId === queue.id }"
      >
        <div
          class="dql-row-main"
          @click="$emit('select', queue)"
          @keydown.enter="$emit('select', queue)"
          @keydown.space.prevent="$emit('select', queue)"
          tabindex="0"
          role="button"
          :aria-label="`查看队列 ${queue.name}`"
        >
        <div class="dql-cover-wrap">
          <img
            v-if="getQueueCover(queue)"
            :src="getQueueCover(queue)"
            :alt="queue.name"
            class="dql-cover"
            loading="lazy"
            decoding="async"
          />
          <div v-else class="dql-cover dql-cover--fb"><PixelIcon name="note" :size="18" /></div>
        </div>

        <div class="dql-info">
          <div class="dql-namerow">
            <h3 class="dql-name">{{ queue.name }}</h3>
            <span
              class="pg-chip pg-chip--static dql-chip"
              :class="getStatusClass(queue.status)"
            >{{ getStatusText(queue.status) }}</span>
            <span
              v-if="queue.failedTasks > 0"
              class="pg-chip pg-chip--static dql-chip pg-chip--fail"
            >失败 {{ queue.failedTasks }}</span>
          </div>
          <p class="dql-meta">
            #{{ queue.id }} · 歌单 {{ queue.playlistId }} · {{ queue.completedTasks }}/{{ queue.totalTasks }} · {{ getProgress(queue) }}%
          </p>
          <div class="dql-progress" role="progressbar" :aria-valuenow="getProgress(queue)" aria-valuemin="0" aria-valuemax="100" :aria-label="`队列 ${queue.id} 下载进度`">
            <div
              class="dql-progress-fill"
              :class="{ 'dql-progress-fill--fail': queue.status === 'failed' }"
              :style="{ '--p': getProgress(queue) }"
            ></div>
          </div>
        </div>
        </div>

        <button
          class="queue-menu-trigger pg-icobtn pg-icobtn--bare pg-icobtn--sm dql-kebab"
          title="更多操作"
          aria-label="更多操作"
          aria-haspopup="menu"
          :aria-expanded="openMenuId === queue.id"
          @click.stop="toggleMenu(queue.id, $event)"
        >
          <PixelIcon name="kebab" :size="15" />
        </button>

        <Teleport to="body">
          <div
            v-if="openMenuId === queue.id"
            class="pg-menu queue-menu"
            role="menu"
            :style="getMenuPosition(queue.id)"
          >
            <button
              v-if="['pending', 'cancelled'].includes(queue.status)"
              @click.stop="runQueueAction('start', queue.id)"
              class="pg-menu-item"
              role="menuitem"
            >启动</button>
            <button
              v-if="queue.status === 'running'"
              @click.stop="runQueueAction('pause', queue.id)"
              class="pg-menu-item"
              role="menuitem"
            >暂停</button>
            <button
              v-if="queue.status === 'paused'"
              @click.stop="runQueueAction('resume', queue.id)"
              class="pg-menu-item"
              role="menuitem"
            >恢复</button>
            <button
              v-if="['pending', 'running', 'paused'].includes(queue.status)"
              @click.stop="runQueueAction('cancel', queue.id)"
              class="pg-menu-item"
              role="menuitem"
            >取消</button>
            <button
              @click.stop="runQueueAction('select', queue)"
              class="pg-menu-item"
              role="menuitem"
            >详情</button>
            <button
              v-if="canRetry(queue)"
              @click.stop="runQueueAction('retry', queue.id)"
              class="pg-menu-item"
              role="menuitem"
            >重试</button>
            <button
              v-if="canDelete(queue)"
              @click.stop="runQueueAction('delete', queue.id)"
              class="pg-menu-item pg-menu-item--danger"
              role="menuitem"
            >删除</button>
          </div>
        </Teleport>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onBeforeUnmount, ref, watch } from 'vue'
import { httpsCover } from '../lib/url'
import { coverSizeUrl } from '../lib/song'
import { queueStatusMeta, statusChipClass, queueProgress, queueStatusFilterOptions } from '../lib/downloadStatus.js'
import PixelIcon from './PixelIcon.vue'
import GlitchText from './GlitchText.vue'

const props = defineProps({
  queues: {
    type: Array,
    default: () => []
  },
  loading: {
    type: Boolean,
    default: false
  },
  selectedQueueId: {
    type: Number,
    default: null
  },
  emptyText: {
    type: String,
    default: '还没有下载队列喵~'
  },
  searchQuery: {
    type: String,
    default: ''
  },
  statusFilter: {
    type: String,
    default: 'all'
  }
})

const emit = defineEmits(['start', 'pause', 'resume', 'cancel', 'retry', 'delete', 'select', 'update:search-query', 'update:status-filter'])

const openMenuId = ref(null)
const menuPosition = ref({ top: '0px', left: '0px' })
// 最近开菜单的 ⋯键本体——Esc 解散菜单时焦点归还它，不落 body
let menuTriggerEl = null

function closeMenu(restoreFocus = false) {
  const wasOpen = openMenuId.value !== null
  openMenuId.value = null
  if (restoreFocus && wasOpen && menuTriggerEl?.isConnected) {
    menuTriggerEl.focus({ preventScroll: true })
  }
}

function toggleMenu(queueId, event) {
  if (openMenuId.value === queueId) {
    closeMenu()
    return
  }

  menuTriggerEl = event.currentTarget
  const rect = event.currentTarget.getBoundingClientRect()
  const menuWidth = 132
  // 按该队列实际渲染的菜单项数估高（实测每项 ≈39px）——写死 180px 会让短菜单无谓上翻
  const queue = props.queues?.find(q => q.id === queueId)
  const itemCount = queue
    ? 1
      + (['pending', 'cancelled'].includes(queue.status) ? 1 : 0)
      + (queue.status === 'running' ? 1 : 0)
      + (queue.status === 'paused' ? 1 : 0)
      + (['pending', 'running', 'paused'].includes(queue.status) ? 1 : 0)
      + (canRetry(queue) ? 1 : 0)
      + (canDelete(queue) ? 1 : 0)
    : 6
  const menuHeight = itemCount * 39 + 4 // 实测项高 ≈39，不足时上翻避免出视口底
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  const left = Math.max(8, Math.min(rect.right - menuWidth, viewportWidth - menuWidth - 8))
  const top = rect.bottom + 4 + menuHeight > viewportHeight
    ? Math.max(8, rect.top - menuHeight - 4)
    : rect.bottom + 4

  menuPosition.value = {
    top: `${top}px`,
    left: `${left}px`
  }
  openMenuId.value = queueId
}

function getMenuPosition(queueId) {
  if (openMenuId.value !== queueId) {
    return { top: '0px', left: '0px' }
  }
  return menuPosition.value
}

function runQueueAction(action, payload) {
  emit(action, payload)
  closeMenu()
}

function canRetry(queue) {
  // paused 仍在服务端 activeQueues 里，retryQueue 会 409"请先取消"——不显示入口
  return queue.failedTasks > 0 && queue.status !== 'running' && queue.status !== 'paused'
}

function canDelete(queue) {
  return queue.status !== 'running'
}

function handleWindowPointerDown(event) {
  const target = event.target
  // 菜单是 Teleport 到 body 的——不在 .dql-row 内，必须单独豁免；
  // 否则 pointerdown（先于 click）就把菜单关了，菜单项点击永远不触发
  // 豁免收窄到菜单本体与触发钮：.dql-row 整行豁免会让"点另一行不关菜单"，
  // 选中置顶排序后旧菜单悬空指向错误卡片
  if (target instanceof Element && target.closest('.queue-menu, .queue-menu-trigger')) {
    return
  }
  closeMenu()
}

function handleWindowKeydown(event) {
  if (event.key === 'Escape') {
    closeMenu(true)
  }
}

// 轮询驱动重排（状态翻转改排序）会让 fixed 菜单悬空指错行——
// 成员/次序真的变了才关（只 watch 数组引用则每次 selectedQueue 刷新都误关）
watch(() => props.queues.map(queue => queue.id).join(','), () => closeMenu())

// 任何滚动（含嵌套滚动容器）都会让 fixed 菜单与触发按钮脱节——捕获阶段监听直接关；
// resize 同理（位置点击时按 innerWidth/Height 算死，视口变即过期）
function handleScroll() {
  closeMenu()
}

if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', handleWindowPointerDown)
  window.addEventListener('keydown', handleWindowKeydown)
  window.addEventListener('scroll', handleScroll, true)
  window.addEventListener('resize', handleScroll)
}

onBeforeUnmount(() => {
  if (typeof window !== 'undefined') {
    window.removeEventListener('pointerdown', handleWindowPointerDown)
    window.removeEventListener('keydown', handleWindowKeydown)
    window.removeEventListener('scroll', handleScroll, true)
    window.removeEventListener('resize', handleScroll)
  }
})

function getStatusText(status) {
  return queueStatusMeta(status).label
}

// 状态 → 芯片修饰类：running=墨底反白（激活），completed=绿戳，failed=危险红，
// 其余淡墨。词表与色档收口在 lib/downloadStatus.js
function getStatusClass(status) {
  return statusChipClass(queueStatusMeta(status).tier)
}

function getProgress(queue) {
  return queueProgress(queue)
}

function getQueueCover(queue) {
  return httpsCover(coverSizeUrl(queue.coverImgUrl || '', 96))
}
</script>

<style scoped>
/* 纸面发丝盒：头部/筛选内收，行列表贴边到盒缘 */
.dql-panel {
  padding: 14px 0 0;
}

.dql-head {
  display: flex;
  align-items: center; /* chip 顶对会悬在标题块中段——中对齐整块更稳 */
  justify-content: space-between;
  gap: 12px;
  padding: 0 16px 12px;
  flex-shrink: 0;
}

.dql-head-info { min-width: 0; }

.dql-title {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 15px;
  line-height: 1.2;
  color: var(--ink);
}

.dql-sub { margin-top: 5px; }

.dql-count { flex-shrink: 0; }

.dql-filters {
  padding: 0 16px 12px;
  flex-shrink: 0;
}

/* 加载/空态同一锚点：都纵向居中，加载→空态切换不跳位。
   border-top 兜住列表态 .dql-scroll 的分隔线，空态不断线 */
.dql-state {
  flex: 1;
  border-top: var(--hairline-soft);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 32px 16px;
}

.dql-state-text {
  font-size: 12px;
  color: var(--ink-64);
}

/* 队列行：留白节奏，选中行墨底浅衬 + 内收发丝框 */
.dql-scroll {
  overflow-y: auto;
  border-top: var(--hairline-soft);
}
/* <xl 时滚动器是外层 DownloadsPanel 网格（本列随内容撑高不内滚）——车道只在 ≥xl 常驻 */
@media (min-width: 1280px) {
  .dql-scroll { scrollbar-gutter: stable; }
}

.dql-row {
  position: relative;
}

/* 点击区是 row-main——kebab 是它的兄弟节点，消灭嵌套可交互 */
.dql-row-main {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 44px 10px 16px; /* 与 dtl 卡左缘 16 同轴 */
  cursor: pointer;
  transition: background .12s;
}

.dql-row-main:hover { background: var(--ink-06); }

.dql-row--sel .dql-row-main {
  background: var(--ink-10);
}

.dql-row--sel {
  outline: var(--hairline);
  outline-offset: -2.4px; /* 四缘留等量 moat，不与邻线相贴 */
}

/* 选中行获焦仍可辨——选中态的 1.2px outline 会压掉全局焦点环 */
.dql-row-main:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: -4px;
}

.dql-cover-wrap {
  width: 48px;
  height: 48px;
  flex-shrink: 0;
}

.dql-cover {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border: var(--hairline);
  image-rendering: pixelated;
  display: block;
}

.dql-cover--fb {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ink-64);
  background: var(--paper);
}

.dql-info { flex: 1; min-width: 0; }

.dql-namerow {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.dql-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

/* 芯片紧凑化（队列行密度高于标签云）；色档走全局 pg-chip--ok/fail/dim */
.dql-chip {
  height: 20px;
  padding: 0 8px;
  font-size: 10px;
  flex-shrink: 0;
}

.dql-meta {
  margin-top: 3px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-64);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 进度：发丝底槽 + 墨块填充（失败列用 danger 块） */
.dql-progress {
  margin-top: 7px;
  height: 4px;
  background: var(--ink-10);
  overflow: hidden;
}

.dql-progress-fill {
  height: 100%;
  width: 100%;
  transform: scaleX(calc(var(--p, 0) / 100));
  transform-origin: left;
  background: var(--ink);
  transition: transform .3s var(--ease-ink);
}

.dql-progress-fill--fail { background: var(--accent-danger); }

.dql-kebab {
  position: absolute;
  top: 50%;
  right: 6px;
  transform: translateY(-50%);
}

/* teleport 菜单：宽度与 toggleMenu 的 132 估宽对齐（全局 pg-menu min-width 160 偏大） */
.queue-menu { min-width: 132px; }
</style>

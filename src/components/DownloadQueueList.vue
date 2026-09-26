<template>
  <div class="jirai-card card-songlist p-4 h-full flex flex-col">
    <div class="flex items-start justify-between gap-3 mb-3 pb-2 border-b border-pink-900/30">
      <div>
        <h2 class="text-base font-semibold text-pink-300 leading-none">{{ title }}</h2>
        <p class="text-[11px] text-gray-400 mt-1.5">左侧选队列，右侧看详情喵~</p>
      </div>
      <span class="px-2 py-1 text-[11px] border bg-gray-900/80 text-gray-300 border-gray-700" style="border-radius: 0;">
        {{ queues.length }} 条
      </span>
    </div>

    <div class="-mx-3 px-3 mb-4">
      <div class="flex items-center gap-2 rounded-none border border-pink-900/40 bg-pink-950/10 py-2 px-3">
        <input
          :value="searchQuery"
          type="text"
          placeholder="搜索队列名..."
          class="flex-1 min-w-[160px] h-9 px-3 text-xs border bg-gray-900/80 text-pink-200 border-gray-700 focus:outline-none focus:border-pink-500"
          style="border-radius: 0;"
          @input="$emit('update:search-query', $event.target.value)"
        />
        <select
          :value="statusFilter"
          class="h-9 px-3 text-xs border bg-gray-900/80 text-pink-200 border-gray-700 focus:outline-none focus:border-pink-500"
          style="border-radius: 0;"
          @change="$emit('update:status-filter', $event.target.value)"
        >
          <option value="all">全部状态</option>
          <option value="running">运行中</option>
          <option value="paused">已暂停</option>
          <option value="pending">等待中</option>
          <option value="failed">失败</option>
          <option value="completed">已完成</option>
        </select>
      </div>
    </div>

    <div v-if="loading" class="text-center py-8">
      <div class="pixel-loading mx-auto mb-4"></div>
      <p class="text-purple-300">加载队列中喵...</p>
    </div>

    <div v-else-if="queues.length === 0" class="text-center py-8 text-gray-400 flex-1 flex items-center justify-center">
      {{ emptyText }}
    </div>

    <div v-else class="space-y-2 overflow-y-auto -mx-3 px-3 flex-1 min-h-0">
      <div
        v-for="queue in queues"
        :key="queue.id"
        class="music-card cursor-pointer p-4 jirai-card transition-all w-full relative"
        :class="selectedQueueId === queue.id ? 'border-pink-400 shadow-[0_0_0_1px_rgba(244,114,182,0.35)]' : 'border-transparent hover:border-pink-900'"
        @click="$emit('select', queue)"
      >
        <div class="flex items-center space-x-3 pr-12">
          <div class="relative">
            <div class="w-12 h-12 border-2 border-pink-400 bg-gray-900 overflow-hidden flex items-center justify-center" style="border-radius: 0;">
              <img
                v-if="getQueueCover(queue)"
                :src="getQueueCover(queue)"
                :alt="queue.name"
                class="w-full h-full object-cover"
                style="image-rendering: pixelated;"
              />
              <div v-else class="w-full h-full flex items-center justify-center text-pink-300 text-[10px]">
                ♪
              </div>
            </div>
          </div>

          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <h3 class="font-medium truncate text-pink-300">{{ queue.name }}</h3>
              <span
                :class="[
                  'px-2 py-0.5 text-[11px] border shrink-0',
                  getStatusClass(queue.status)
                ]"
                style="border-radius: 0;"
              >
                {{ getStatusText(queue.status) }}
              </span>
              <span
                v-if="queue.failedTasks > 0"
                class="px-2 py-0.5 text-[11px] border shrink-0 bg-red-950 text-red-200 border-red-700"
                style="border-radius: 0;"
              >
                失败 {{ queue.failedTasks }}
              </span>
            </div>
            <p class="text-sm text-purple-300 truncate mt-0.5">
              #{{ queue.id }} · 歌单 {{ queue.playlistId }} · {{ queue.completedTasks }}/{{ queue.totalTasks }} · {{ getProgress(queue) }}%
            </p>
            <div class="mt-2 w-full h-1.5 bg-gray-800 border border-gray-700">
              <div
                :style="{ width: getProgress(queue) + '%' }"
                :class="[
                  'h-full transition-all',
                  queue.status === 'failed' ? 'bg-red-500' : 'bg-pink-500'
                ]"
              ></div>
            </div>
          </div>
        </div>

        <div class="absolute top-0 right-0 flex">
          <button
            class="p-1 transition-all text-gray-400 hover:text-pink-300 flex items-center justify-center"
            style="border-radius: 0;"
            title="更多操作"
            @click.stop="toggleMenu(queue.id, $event)"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 22 22"><path fill="currentColor" d="M15 21H8v-1H7v-1H6V3h1V2h1V1h4v1h1v1h1v14h-1v1h-1Z"/></svg>
          </button>
        </div>

        <Teleport to="body">
          <div
            v-if="openMenuId === queue.id"
            class="fixed bg-gray-900 border border-purple-400 shadow-lg z-[9999] w-[132px]"
            style="border-radius: 0;"
            :style="getMenuPosition(queue.id)"
          >
            <button
              v-if="queue.status === 'pending'"
              @click.stop="runQueueAction('start', queue.id)"
              class="w-full text-left px-3 py-2 text-xs text-green-200 hover:bg-green-800 hover:text-white transition-colors border-b border-gray-700"
            >
              启动
            </button>
            <button
              v-if="queue.status === 'running'"
              @click.stop="runQueueAction('pause', queue.id)"
              class="w-full text-left px-3 py-2 text-xs text-yellow-200 hover:bg-yellow-800 hover:text-white transition-colors border-b border-gray-700"
            >
              暂停
            </button>
            <button
              v-if="queue.status === 'paused'"
              @click.stop="runQueueAction('resume', queue.id)"
              class="w-full text-left px-3 py-2 text-xs text-blue-200 hover:bg-blue-800 hover:text-white transition-colors border-b border-gray-700"
            >
              恢复
            </button>
            <button
              @click.stop="runQueueAction('select', queue)"
              class="w-full text-left px-3 py-2 text-xs text-purple-200 hover:bg-purple-800 hover:text-white transition-colors"
              :class="canRetry(queue) || canDelete(queue) ? 'border-b border-gray-700' : ''"
            >
              详情
            </button>
            <button
              v-if="canRetry(queue)"
              @click.stop="runQueueAction('retry', queue.id)"
              class="w-full text-left px-3 py-2 text-xs text-orange-200 hover:bg-orange-800 hover:text-white transition-colors"
              :class="canDelete(queue) ? 'border-b border-gray-700' : ''"
            >
              重试
            </button>
            <button
              v-if="canDelete(queue)"
              @click.stop="runQueueAction('delete', queue.id)"
              class="w-full text-left px-3 py-2 text-xs text-red-200 hover:bg-red-800 hover:text-white transition-colors"
            >
              删除
            </button>
          </div>
        </Teleport>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onBeforeUnmount, ref } from 'vue';

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
  title: {
    type: String,
    default: '下载队列'
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
});

const emit = defineEmits(['start', 'pause', 'resume', 'retry', 'delete', 'select', 'update:search-query', 'update:status-filter']);

const openMenuId = ref(null);
const menuPosition = ref({ top: '0px', left: '0px' });

function closeMenu() {
  openMenuId.value = null;
}

function toggleMenu(queueId, event) {
  if (openMenuId.value === queueId) {
    closeMenu();
    return;
  }

  const rect = event.currentTarget.getBoundingClientRect();
  const menuWidth = 132;
  const viewportWidth = window.innerWidth;
  const left = Math.max(8, Math.min(rect.right - menuWidth, viewportWidth - menuWidth - 8));

  menuPosition.value = {
    top: `${rect.bottom + 6}px`,
    left: `${left}px`
  };
  openMenuId.value = queueId;
}

function getMenuPosition(queueId) {
  if (openMenuId.value !== queueId) {
    return { top: '0px', left: '0px' };
  }
  return menuPosition.value;
}

function runQueueAction(action, payload) {
  emit(action, payload);
  closeMenu();
}

function canRetry(queue) {
  return queue.failedTasks > 0 && queue.status !== 'running';
}

function canDelete(queue) {
  return queue.status !== 'running';
}

function handleWindowPointerDown(event) {
  const target = event.target;
  if (target instanceof Element && target.closest('.music-card, [title="更多操作"]')) {
    return;
  }
  closeMenu();
}

function handleWindowKeydown(event) {
  if (event.key === 'Escape') {
    closeMenu();
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', handleWindowPointerDown);
  window.addEventListener('keydown', handleWindowKeydown);
}

onBeforeUnmount(() => {
  if (typeof window !== 'undefined') {
    window.removeEventListener('pointerdown', handleWindowPointerDown);
    window.removeEventListener('keydown', handleWindowKeydown);
  }
});

function getStatusText(status) {
  const statusMap = {
    pending: '等待中',
    running: '运行中',
    paused: '已暂停',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消'
  };
  return statusMap[status] || status;
}

function getStatusClass(status) {
  const classMap = {
    pending: 'bg-gray-800 text-gray-300 border-gray-600',
    running: 'bg-blue-900 text-blue-200 border-blue-500',
    paused: 'bg-yellow-900 text-yellow-200 border-yellow-500',
    completed: 'bg-green-900 text-green-200 border-green-500',
    failed: 'bg-red-900 text-red-200 border-red-500',
    cancelled: 'bg-gray-900 text-gray-400 border-gray-700'
  };
  return classMap[status] || 'bg-gray-800 text-gray-300 border-gray-600';
}

function getProgress(queue) {
  if (queue.totalTasks === 0) return 0;
  return Math.round((queue.completedTasks / queue.totalTasks) * 100);
}

function getQueueCover(queue) {
  return queue.coverImgUrl || queue.coverUrl || queue.cover_img_url || '';
}
</script>

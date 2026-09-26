<template>
  <div class="lg:col-span-1">
    <div class="jirai-card card-songlist flex flex-col relative p-6 max-h-96 overflow-y-auto">
      <div class="grid grid-cols-1 xl:grid-cols-[400px_minmax(0,1fr)] gap-4 flex-1 min-h-0">
        <div class="min-h-0 flex flex-col">
          <DownloadQueueList
            :queues="displayQueues"
            :loading="loadingQueues"
            :selected-queue-id="selectedQueue?.id ?? null"
            :title="queueListTitle"
            :empty-text="queueEmptyText"
            :search-query="queueSearch"
            :status-filter="queueStatusFilter"
            @update:search-query="queueSearch = $event"
            @update:status-filter="queueStatusFilter = $event"
            @start="startQueue"
            @pause="pauseQueue"
            @resume="resumeQueue"
            @retry="retryQueue"
            @delete="deleteQueue"
            @select="selectQueue"
          />
        </div>

        <div class="min-h-0 flex flex-col">
        <DownloadTaskList
          :tasks="tasks"
          :loading="loadingTasks"
          :selected-queue="selectedQueue"
          :retrying-task-id="retryingTaskId"
          @retry-task="retryTask"
        />
      </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, onMounted, onUnmounted, watch } from 'vue';
import { downloadsApi } from '../api/downloads';
import DownloadQueueList from './DownloadQueueList.vue';
import DownloadTaskList from './DownloadTaskList.vue';

const props = defineProps({
  selectedPlaylist: {
    type: Object,
    default: null
  }
});

const queues = ref([]);
const selectedQueue = ref(null);
const tasks = ref([]);
const loadingQueues = ref(false);
const loadingTasks = ref(false);
const retryingTaskId = ref(null);
const queueSearch = ref('');
const queueStatusFilter = ref('all');
const hasLoadedQueues = ref(false);
const hasLoadedTasks = ref(false);

let pollInterval = null;

const displayQueues = computed(() => {
  const priority = {
    running: 0,
    paused: 1,
    pending: 2,
    failed: 3,
    completed: 4,
    cancelled: 5
  };

  const normalizedQuery = queueSearch.value.trim().toLowerCase();

  const filteredQueues = queues.value.filter(queue => {
    if (queueStatusFilter.value !== 'all' && queue.status !== queueStatusFilter.value) {
      return false;
    }

    if (normalizedQuery) {
      const haystacks = [queue.name, String(queue.id), String(queue.playlistId)].filter(Boolean).map(value => value.toLowerCase());
      if (!haystacks.some(value => value.includes(normalizedQuery))) {
        return false;
      }
    }

    return true;
  });

  const sortedQueues = [...filteredQueues].sort((left, right) => {
    const leftSelected = selectedQueue.value && left.id === selectedQueue.value.id ? 0 : 1;
    const rightSelected = selectedQueue.value && right.id === selectedQueue.value.id ? 0 : 1;

    if (leftSelected !== rightSelected) {
      return leftSelected - rightSelected;
    }

    const leftPriority = priority[left.status] ?? 99;
    const rightPriority = priority[right.status] ?? 99;

    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }

    const leftProgress = getQueueProgress(left);
    const rightProgress = getQueueProgress(right);

    if (leftProgress !== rightProgress) {
      return rightProgress - leftProgress;
    }

    return right.id - left.id;
  });

  return sortedQueues;
});

const queueListTitle = computed(() => {
  return `下载列队 (${displayQueues.value.length})`;
});

const queueEmptyText = computed(() => {
  return '还没有下载队列喵~';
});

function getQueueStatusText(status) {
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

function getQueueStatusClass(status) {
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

function getQueueProgress(queue) {
  if (!queue || queue.totalTasks === 0) {
    return 0;
  }
  return Math.round((queue.completedTasks / queue.totalTasks) * 100);
}

function hasQueueChanged(currentQueue, nextQueue) {
  if (!currentQueue || !nextQueue) {
    return currentQueue !== nextQueue;
  }

  return currentQueue.id !== nextQueue.id
    || currentQueue.playlistId !== nextQueue.playlistId
    || currentQueue.name !== nextQueue.name
    || currentQueue.coverUrl !== nextQueue.coverUrl
    || currentQueue.coverImgUrl !== nextQueue.coverImgUrl
    || currentQueue.cover_img_url !== nextQueue.cover_img_url
    || currentQueue.status !== nextQueue.status
    || currentQueue.totalTasks !== nextQueue.totalTasks
    || currentQueue.completedTasks !== nextQueue.completedTasks
    || currentQueue.failedTasks !== nextQueue.failedTasks
    || currentQueue.concurrentLimit !== nextQueue.concurrentLimit
    || currentQueue.bitrate !== nextQueue.bitrate
    || currentQueue.downloadAudio !== nextQueue.downloadAudio
    || currentQueue.downloadLyrics !== nextQueue.downloadLyrics
    || currentQueue.downloadCover !== nextQueue.downloadCover
    || currentQueue.updatedAt !== nextQueue.updatedAt
    || currentQueue.completedAt !== nextQueue.completedAt;
}

function hasTaskChanged(currentTask, nextTask) {
  if (!currentTask || !nextTask) {
    return currentTask !== nextTask;
  }

  return currentTask.id !== nextTask.id
    || currentTask.playlistId !== nextTask.playlistId
    || currentTask.songId !== nextTask.songId
    || currentTask.songName !== nextTask.songName
    || currentTask.artist !== nextTask.artist
    || currentTask.album !== nextTask.album
    || currentTask.coverUrl !== nextTask.coverUrl
    || currentTask.coverPath !== nextTask.coverPath
    || currentTask.status !== nextTask.status
    || currentTask.progress !== nextTask.progress
    || currentTask.errorMessage !== nextTask.errorMessage
    || currentTask.retryCount !== nextTask.retryCount
    || currentTask.downloadAudio !== nextTask.downloadAudio
    || currentTask.downloadLyrics !== nextTask.downloadLyrics
    || currentTask.downloadCover !== nextTask.downloadCover
    || currentTask.audioPath !== nextTask.audioPath
    || currentTask.lyricsPath !== nextTask.lyricsPath
    || currentTask.completedAt !== nextTask.completedAt
    || currentTask.updatedAt !== nextTask.updatedAt;
}

function hasCollectionChanged(currentItems, nextItems, compareItem) {
  if (currentItems.length !== nextItems.length) {
    return true;
  }

  for (let index = 0; index < currentItems.length; index += 1) {
    if (compareItem(currentItems[index], nextItems[index])) {
      return true;
    }
  }

  return false;
}

function selectQueue(queue) {
  selectedQueue.value = queue;
  hasLoadedTasks.value = false;
  loadTasks(queue.id);
}

async function loadQueues(options = {}) {
  const { silent = false } = options;

  try {
    if (!silent && !hasLoadedQueues.value) {
      loadingQueues.value = true;
    }
    const response = await downloadsApi.listQueues();
    if (response.data && response.data.data) {
      const nextQueues = response.data.data;
      const previousSelectedQueueId = selectedQueue.value?.id ?? null;
      const queuesChanged = hasCollectionChanged(queues.value, nextQueues, hasQueueChanged);

      if (queuesChanged) {
        queues.value = nextQueues;
      }

      const activeQueues = queuesChanged ? nextQueues : queues.value;

      if (previousSelectedQueueId != null) {
        const matchedQueue = activeQueues.find(queue => queue.id === previousSelectedQueueId);
        if (matchedQueue) {
          selectedQueue.value = matchedQueue;
        } else {
          selectedQueue.value = null;
          tasks.value = [];
          hasLoadedTasks.value = false;
        }
      }

      hasLoadedQueues.value = true;
    }
  } catch (error) {
    console.error('加载队列失败:', error);
  } finally {
    if (!silent) {
      loadingQueues.value = false;
    }
  }
}

async function loadTasks(queueId, options = {}) {
  const { silent = false } = options;

  try {
    if (!silent && !hasLoadedTasks.value) {
      loadingTasks.value = true;
    }
    const response = await downloadsApi.listTasks({ queueId });
    if (response.data && response.data.data) {
      const nextTasks = response.data.data;
      if (hasCollectionChanged(tasks.value, nextTasks, hasTaskChanged)) {
        tasks.value = nextTasks;
      }
      hasLoadedTasks.value = true;
    }
  } catch (error) {
    console.error('加载任务失败:', error);
  } finally {
    if (!silent) {
      loadingTasks.value = false;
    }
  }
}

async function startQueue(queueId) {
  try {
    await downloadsApi.startQueue(queueId);
    await loadQueues();
  } catch (error) {
    console.error('启动队列失败:', error);
    alert('启动队列失败: ' + error.message);
  }
}

async function pauseQueue(queueId) {
  try {
    await downloadsApi.pauseQueue(queueId);
    await loadQueues();
  } catch (error) {
    console.error('暂停队列失败:', error);
    alert('暂停队列失败: ' + error.message);
  }
}

async function resumeQueue(queueId) {
  try {
    await downloadsApi.resumeQueue(queueId);
    await loadQueues();
  } catch (error) {
    console.error('恢复队列失败:', error);
    alert('恢复队列失败: ' + error.message);
  }
}

async function retryTask(taskId) {
  try {
    retryingTaskId.value = taskId;
    await downloadsApi.retryTask(taskId);
    if (selectedQueue.value) {
      await Promise.all([
        loadQueues(),
        loadTasks(selectedQueue.value.id)
      ]);
    } else {
      await loadQueues();
    }
  } catch (error) {
    console.error('重试任务失败:', error);
    alert('重试任务失败: ' + error.message);
  } finally {
    retryingTaskId.value = null;
  }
}

async function retryQueue(queueId) {
  try {
    await downloadsApi.retryQueue(queueId);
    await loadQueues();
    if (selectedQueue.value?.id === queueId) {
      await loadTasks(queueId);
    }
  } catch (error) {
    console.error('重试队列失败:', error);
    alert('重试队列失败: ' + error.message);
  }
}

async function deleteQueue(queueId) {
  if (!confirm('确定要删除这个队列吗？')) return;

  try {
    await downloadsApi.deleteQueue(queueId);
    await loadQueues();
    if (selectedQueue.value?.id === queueId) {
      selectedQueue.value = null;
      tasks.value = [];
    }
  } catch (error) {
    console.error('删除队列失败:', error);
    alert('删除队列失败: ' + error.message);
  }
}

function startPolling() {
  pollInterval = setInterval(async () => {
    // 标签页不可见时跳过轮询：隐藏页面的进度刷新用户看不到，白耗请求
    if (document.hidden) return;
    await loadQueues({ silent: true });
    if (selectedQueue.value) {
      await loadTasks(selectedQueue.value.id, { silent: true });
    }
  }, 2000);
}

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

watch(() => selectedQueue.value?.id, (queueId) => {
  if (!queueId) {
    tasks.value = [];
    hasLoadedTasks.value = false;
  }
});

onMounted(async () => {
  await loadQueues();
  startPolling();
});

onUnmounted(() => {
  stopPolling();
});
</script>

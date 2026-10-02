<template>
  <!-- 主区全宽：管理视图占用整个内容列（YTM 式页面切换而非面板挤压）。
       sage 画布上两张纸面发丝盒（队列列 / 任务列） -->
  <div class="admin-panel flex flex-col relative m-3 sm:m-5 flex-1 min-h-0 overflow-hidden">
    <!-- <xl 单列时两行各按内容撑高会超出面板——给网格自身加纵向滚动兜底 -->
    <div class="grid grid-cols-1 xl:grid-cols-[400px_minmax(0,1fr)] gap-4 flex-1 min-h-0 overflow-y-auto xl:overflow-visible"
      style="scrollbar-gutter: stable"><!-- <xl 时本格是唯一滚动器；≥xl overflow:visible 时 gutter 自动失效 -->
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
          @cancel="cancelQueue"
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
</template>

<script setup>
import { computed, ref, onMounted, onUnmounted, watch } from 'vue';
import { toast, pixelConfirm } from '../lib/feedback'
import { downloadsApi } from '../api/downloads';
import { apiErrorMessage } from '../api/http';
import DownloadQueueList from './DownloadQueueList.vue';
import DownloadTaskList from './DownloadTaskList.vue';

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
  return `下载队列 (${displayQueues.value.length})`;
});

// 首次加载失败与"真的为空"要区分开——否则服务挂掉时 UI 显示空态误导
const loadError = ref('');
const queueEmptyText = computed(() => {
  return loadError.value || '还没有下载队列喵~';
});

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
    || currentQueue.coverImgUrl !== nextQueue.coverImgUrl
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
    // filesIntact/fileSize 是完成态唯二的"文件变了"信号——不比会让幻影行永久滞留
    || currentTask.filesIntact !== nextTask.filesIntact
    || currentTask.fileSize !== nextTask.fileSize
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
  selectionMissCount = 0;
  // 立即清空旧队列任务——加载/轮询间隙不应在 B 名下展示 A 的任务列表
  tasks.value = [];
  hasLoadedTasks.value = false;
  loadTasks(queue.id);
}

// 选中项"在快照里缺席"的连续计数：请求发出到响应落地之间用户新选的队列
// 不在旧快照里是正常竞态——一轮缺席可能恰是窗口，两轮都不在才是真删除
let selectionMissCount = 0;

async function loadQueues(options = {}) {
  const { silent = false } = options;

  try {
    if (!silent && !hasLoadedQueues.value) {
      loadingQueues.value = true;
    }
    const response = await downloadsApi.listQueues();
    // 响应体非 envelope（如同源静态服的 index.html 200）：不能当空列表吞掉，
    // 抛错走 catch → 首载显示错误态而不是"还没有下载队列"假象
    if (!response || !Array.isArray(response.data)) {
      throw new Error('接口返回了非预期内容（可能打到了静态服务器）');
    }
    const nextQueues = response.data;
    const previousSelectedQueueId = selectedQueue.value?.id ?? null;
    const queuesChanged = hasCollectionChanged(queues.value, nextQueues, hasQueueChanged);

    if (queuesChanged) {
      queues.value = nextQueues;
    }

    const activeQueues = queuesChanged ? nextQueues : queues.value;

    if (previousSelectedQueueId != null) {
      const matchedQueue = activeQueues.find(queue => queue.id === previousSelectedQueueId);
      if (matchedQueue) {
        selectionMissCount = 0;
        selectedQueue.value = matchedQueue;
      } else if (++selectionMissCount >= 2) {
        // 连续两轮快照都缺席才判定删除——单轮缺席可能只是"响应快照早于用户点击"
        selectionMissCount = 0;
        selectedQueue.value = null;
        tasks.value = [];
        hasLoadedTasks.value = false;
      }
    }

    hasLoadedQueues.value = true;
    loadError.value = '';
  } catch (error) {
    console.error('加载队列失败:', error);
    // 首次加载失败给用户可见的错误态；轮询静默失败不打断界面
    if (!hasLoadedQueues.value) {
      loadError.value = '加载失败: ' + (apiErrorMessage(error));
    }
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
    // 单端点拿 队列+任务 原子快照——队列行与任务列表同一时刻，不会出现
    // "队列显示完成而任务还在下载中"的中间帧（分离请求各自的延迟会交错）
    const response = await downloadsApi.getQueue(queueId);
    // 响应可能属于上一个选中队列（并发 selectQueue 交错）——归属校验防错写
    if (String(selectedQueue.value?.id) !== String(queueId)) return;
    // 与 loadQueues 对齐：打错部署（静态服务器返回 HTML）不能让任务面板
    // 永远显示"还没有任务"
    if (!response || !Array.isArray(response.data?.tasks)) {
      throw new Error('任务列表响应格式异常');
    }
    const nextTasks = response.data.tasks;
    if (hasCollectionChanged(tasks.value, nextTasks, hasTaskChanged)) {
      tasks.value = nextTasks;
    }
    // 顺手用同一快照刷新选中队列行（避免等下一轮 listQueues 才更新状态）
    const freshQueue = response.data.queue;
    if (freshQueue && selectedQueue.value) {
      selectedQueue.value = freshQueue;
    }
    hasLoadedTasks.value = true;
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
    toast('启动队列失败: ' + (apiErrorMessage(error)), 'error');
  }
}

async function pauseQueue(queueId) {
  try {
    await downloadsApi.pauseQueue(queueId);
    await loadQueues();
  } catch (error) {
    console.error('暂停队列失败:', error);
    toast('暂停队列失败: ' + (apiErrorMessage(error)), 'error');
  }
}

async function resumeQueue(queueId) {
  try {
    await downloadsApi.resumeQueue(queueId);
    await loadQueues();
  } catch (error) {
    console.error('恢复队列失败:', error);
    toast('恢复队列失败: ' + (apiErrorMessage(error)), 'error');
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
    toast('重试任务失败: ' + (apiErrorMessage(error)), 'error');
  } finally {
    retryingTaskId.value = null;
  }
}

async function cancelQueue(queueId) {
  if (!await pixelConfirm('确定要取消这个队列吗？未完成的任务将停止下载', { confirmText: '取消队列', danger: true })) return;

  try {
    await downloadsApi.cancelQueue(queueId);
    await loadQueues();
    if (selectedQueue.value?.id === queueId) {
      await loadTasks(queueId);
    }
  } catch (error) {
    console.error('取消队列失败:', error);
    toast('取消队列失败: ' + (apiErrorMessage(error)), 'error');
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
    toast('重试队列失败: ' + (apiErrorMessage(error)), 'error');
  }
}

async function deleteQueue(queueId) {
  if (!await pixelConfirm('确定要删除这个队列吗？', { confirmText: '删除', danger: true })) return;

  try {
    await downloadsApi.deleteQueue(queueId);
    await loadQueues();
    if (selectedQueue.value?.id === queueId) {
      selectionMissCount = 0; // 手动清选中同样要归零——loadQueues 内缺席计数会留下惰性 =1
      selectedQueue.value = null;
      tasks.value = [];
    }
  } catch (error) {
    console.error('删除队列失败:', error);
    toast('删除队列失败: ' + (apiErrorMessage(error)), 'error');
  }
}

let pollInFlight = false;
function startPolling() {
  pollInterval = setInterval(async () => {
    // 标签页不可见时跳过轮询：隐藏页面的进度刷新用户看不到，白耗请求；
    // in-flight 防 RTT>间隔时的请求重叠交错写
    if (document.hidden || pollInFlight) return;
    pollInFlight = true;
    try {
      await loadQueues({ silent: true });
      // 选中队列缺席窗口内（连续两轮未命中才清选中）不轮询任务——
      // 那两行快照里队列已删，任务接口会返回 [] 闪一帧"已删队列+空任务"
      if (selectedQueue.value && selectionMissCount === 0) {
        await loadTasks(selectedQueue.value.id, { silent: true });
      }
    } finally {
      pollInFlight = false;
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

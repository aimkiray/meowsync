<template>
  <div class="jirai-card p-4 h-full flex flex-col">
    <div class="flex items-start justify-between gap-3 mb-3 pb-2 border-b border-pink-900/30">
      <div>
        <h2 class="text-base font-semibold text-pink-300 leading-none">下载任务</h2>
        <p v-if="selectedQueue" class="text-[11px] text-purple-300 mt-1.5 truncate">
          {{ selectedQueue.name }} · {{ tasks.length }} 条任务
        </p>
        <p v-else class="text-[11px] text-gray-400 mt-1.5">
          选择左侧队列后，这里会显示任务详情喵~
        </p>
      </div>
      <span
        v-if="selectedQueue"
        class="px-2 py-1 text-[11px] border bg-purple-900/80 text-purple-200 border-purple-500"
        style="border-radius: 0;"
      >
        队列 #{{ selectedQueue.id }}
      </span>
    </div>

    <div v-if="selectedQueue" class="grid grid-cols-2 xl:grid-cols-4 gap-2 mb-4">
      <div class="border border-gray-700 bg-gray-900/60 px-2.5 py-2">
        <div class="text-[11px] text-gray-400">总任务</div>
        <div class="text-sm font-semibold text-pink-300 mt-0.5">{{ taskStats.total }}</div>
      </div>
      <div class="border border-blue-700 bg-blue-950/40 px-3 py-2">
        <div class="text-[11px] text-blue-200">下载中</div>
        <div class="text-sm font-semibold text-blue-200 mt-0.5">{{ taskStats.downloading }}</div>
      </div>
      <div class="border border-green-700 bg-green-950/40 px-3 py-2">
        <div class="text-[11px] text-green-200">已完成</div>
        <div class="text-sm font-semibold text-green-200 mt-0.5">{{ taskStats.completed }}</div>
      </div>
      <div class="border border-red-700 bg-red-950/40 px-3 py-2">
        <div class="text-[11px] text-red-200">失败</div>
        <div class="text-sm font-semibold text-red-200 mt-0.5">{{ taskStats.failed }}</div>
      </div>
    </div>

    <div v-if="!selectedQueue" class="flex-1 flex items-center justify-center text-center px-6">
      <div>
        <div class="text-4xl text-pink-300 mb-3">♪</div>
        <p class="text-sm text-pink-300">先从左侧挑一个下载队列喵</p>
        <p class="text-xs text-gray-400 mt-2">选中后就能看到每首歌的下载状态、进度和失败原因。</p>
      </div>
    </div>

    <div v-else-if="loading" class="flex-1 text-center py-8 flex flex-col items-center justify-center">
      <div class="pixel-loading mx-auto mb-4"></div>
      <p class="text-purple-300">加载任务中喵...</p>
    </div>

    <div v-else-if="tasks.length === 0" class="flex-1 flex items-center justify-center text-center px-6">
      <div>
        <p class="text-sm text-pink-300">这条队列里还没有任务喵~</p>
        <p class="text-xs text-gray-400 mt-2">如果这是新建队列，稍等一下就会开始填充任务列表。</p>
      </div>
    </div>

    <div v-else class="flex-1 min-h-0 overflow-y-auto -mx-3 px-3">
      <div class="space-y-3.5">
        <section v-if="groupedTasks.failed.length" class="space-y-2">
          <div class="flex items-center justify-between gap-2 mb-1.5">
            <div class="flex items-center gap-2">
              <span class="text-[11px] px-2 py-0.5 border bg-red-900 text-red-200 border-red-500" style="border-radius: 0;">失败</span>
              <span class="text-[11px] text-gray-400">{{ groupedTasks.failed.length }} 条</span>
            </div>
          </div>
          <div class="space-y-2">
            <div
              v-for="task in groupedTasks.failed"
              :key="task.id"
              class="music-card px-3 py-2.5 jirai-card transition-all border border-red-900/60 hover:border-red-700"
            >
              <TaskRow :task="task" :retrying-task-id="retryingTaskId" :get-status-class="getStatusClass" :get-status-text="getStatusText" @retry-task="$emit('retry-task', $event)" />
            </div>
          </div>
        </section>

        <section v-if="groupedTasks.downloading.length" class="space-y-2">
          <div class="flex items-center gap-2 mb-1.5">
            <span class="text-[11px] px-2 py-0.5 border bg-blue-900 text-blue-200 border-blue-500" style="border-radius: 0;">下载中</span>
            <span class="text-[11px] text-gray-400">{{ groupedTasks.downloading.length }} 条</span>
          </div>
          <div class="space-y-2">
            <div
              v-for="task in groupedTasks.downloading"
              :key="task.id"
              class="music-card px-3 py-2.5 jirai-card transition-all border border-blue-900/60 hover:border-blue-700"
            >
              <TaskRow :task="task" :get-status-class="getStatusClass" :get-status-text="getStatusText" />
            </div>
          </div>
        </section>

        <section v-if="groupedTasks.pending.length" class="space-y-2">
          <div class="flex items-center gap-2 mb-1.5">
            <span class="text-[11px] px-2 py-0.5 border bg-gray-800 text-gray-300 border-gray-600" style="border-radius: 0;">等待中</span>
            <span class="text-[11px] text-gray-400">{{ groupedTasks.pending.length }} 条</span>
          </div>
          <div class="space-y-2">
            <div
              v-for="task in groupedTasks.pending"
              :key="task.id"
              class="music-card px-3 py-2.5 jirai-card transition-all border border-transparent hover:border-pink-900"
            >
              <TaskRow :task="task" :get-status-class="getStatusClass" :get-status-text="getStatusText" />
            </div>
          </div>
        </section>

        <section v-if="groupedTasks.completed.length" class="space-y-2">
          <button
            type="button"
            class="w-full flex items-center justify-between gap-3 mb-1.5 px-2 py-1 border border-green-900/70 bg-green-950/20 text-left hover:bg-green-950/30 transition-colors"
            style="border-radius: 0;"
            @click="showCompleted = !showCompleted"
          >
            <div class="flex items-center gap-2">
              <span class="text-[11px] px-2 py-0.5 border bg-green-900 text-green-200 border-green-500" style="border-radius: 0;">已完成</span>
              <span class="text-[11px] text-gray-400">{{ groupedTasks.completed.length }} 条</span>
            </div>
            <span class="text-[11px] text-green-200">{{ showCompleted ? '收起' : '展开' }}</span>
          </button>
          <div v-if="showCompleted" class="space-y-2">
            <div
              v-for="task in groupedTasks.completed"
              :key="task.id"
              class="music-card px-3 py-2.5 jirai-card transition-all border border-transparent hover:border-pink-900"
            >
              <TaskRow :task="task" :get-status-class="getStatusClass" :get-status-text="getStatusText" />
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, h, ref, watch } from 'vue';
import { httpsCover } from '../lib/url';

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

function getStatusText(status) {
  const statusMap = {
    pending: '等待',
    downloading: '下载中',
    completed: '完成',
    failed: '失败'
  };
  return statusMap[status] || status;
}

function getStatusClass(status) {
  const classMap = {
    pending: 'bg-gray-800 text-gray-300 border-gray-600',
    downloading: 'bg-blue-900 text-blue-200 border-blue-500',
    completed: 'bg-green-900 text-green-200 border-green-500',
    failed: 'bg-red-900 text-red-200 border-red-500'
  };
  return classMap[status] || 'bg-gray-800 text-gray-300 border-gray-600';
}

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
    return () => h('div', { class: 'flex items-start gap-2.5' }, [
      h('div', {
        class: 'w-10 h-10 border-2 border-pink-400 bg-gray-900 overflow-hidden flex-shrink-0',
        style: 'border-radius: 0;'
      }, rowProps.task.coverUrl
        ? h('img', {
          // coverPath 是服务器相对路径（无对应文件路由），当 img src 只会 404——不兜底。
          // coverUrl 是上游 http 明文 CDN 地址：HTTPS 部署下被动混合内容
          // 会被浏览器拦截，显式升级 https（*.music.126.net 均支持 TLS）
          src: httpsCover(rowProps.task.coverUrl),
          alt: rowProps.task.songName,
          class: 'w-full h-full object-cover',
          style: 'image-rendering: pixelated;'
        })
        : h('div', { class: 'w-full h-full flex items-center justify-center text-pink-300 text-[10px]' }, '♫')),
      h('div', { class: 'flex-1 min-w-0' }, [
        h('div', { class: 'flex items-start justify-between gap-3' }, [
          h('div', { class: 'min-w-0 flex-1' }, [
            h('div', { class: 'flex items-center gap-2 flex-wrap' }, [
              h('h4', { class: 'font-medium text-sm truncate text-pink-300' }, rowProps.task.songName),
              h('span', {
                class: `px-2 py-0.5 text-[11px] border shrink-0 ${rowProps.getStatusClass(rowProps.task.status)}`,
                style: 'border-radius: 0;'
              }, rowProps.getStatusText(rowProps.task.status))
            ]),
            h('p', { class: 'text-xs text-purple-300 mt-0.5 truncate' }, rowProps.task.artist)
          ]),
          h('div', { class: 'text-[11px] text-gray-400 shrink-0 text-right' }, `#${rowProps.task.id}`)
        ]),
        h('div', { class: 'flex items-center flex-wrap gap-x-2.5 gap-y-1 mt-1 text-[11px] text-gray-400' }, [
          rowProps.task.downloadAudio ? h('span', '🎵 音频') : null,
          rowProps.task.downloadLyrics ? h('span', '📝 歌词') : null,
          rowProps.task.downloadCover ? h('span', '🖼️ 封面') : null
        ].filter(Boolean)),
        rowProps.task.status === 'downloading'
          ? h('div', { class: 'mt-1.5' }, [
            h('div', { class: 'flex items-center gap-2' }, [
              h('div', { class: 'flex-1 h-1.5 bg-gray-800 border border-gray-700' }, [
                h('div', {
                  class: 'h-full bg-pink-500 transition-all',
                  // undefined/>100 会产生非法/溢出样式
                  style: `width: ${Math.max(0, Math.min(100, rowProps.task.progress || 0))}%`
                })
              ]),
              h('div', { class: 'text-[11px] text-gray-400 w-10 text-right' }, `${Math.max(0, Math.min(100, rowProps.task.progress || 0))}%`)
            ])
          ])
          : null,
        rowProps.task.status === 'failed'
          ? h('div', { class: 'mt-1' }, [
            rowProps.task.errorMessage
              ? h('p', { class: 'text-[11px] text-red-300 break-words' }, `下载失败喵：${rowProps.task.errorMessage}`)
              : h('p', { class: 'text-[11px] text-red-300 break-words' }, '下载失败喵'),
            rowProps.task.retryCount > 0
              ? h('p', { class: 'text-[11px] text-gray-400 mt-1' }, `已重试 ${rowProps.task.retryCount} 次`)
              : null,
            h('button', {
              class: 'mt-1 text-[11px] px-2 py-1 border bg-orange-700 text-white border-orange-500 hover:bg-orange-600 transition-colors',
              style: 'border-radius: 0;',
              disabled: rowProps.retryingTaskId === rowProps.task.id,
              onClick: () => emit('retry-task', rowProps.task.id)
            }, rowProps.retryingTaskId === rowProps.task.id ? '重试中...' : '重试任务')
          ].filter(Boolean))
          : null,
        rowProps.task.status === 'completed'
          ? h('div', { class: 'mt-1.5 text-[11px] text-green-300' }, '✓ 下载完成喵')
          : null
      ])
    ]);
  }
};
</script>

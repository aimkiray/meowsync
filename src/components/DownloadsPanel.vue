<template>
  <!-- 主区全宽：下载管理视图占用整个内容列（YTM 式页面切换而非面板挤压）。
       sage 画布上两张纸面发丝盒（队列列 / 任务列） -->
  <div class="downloads-panel flex flex-col relative m-3 sm:m-5 flex-1 min-h-0 overflow-hidden">
    <!-- <xl 单列时两行各按内容撑高会超出面板——给网格自身加纵向滚动兜底 -->
    <div class="grid grid-cols-1 xl:grid-cols-[400px_minmax(0,1fr)] gap-4 flex-1 min-h-0 overflow-y-auto overscroll-contain xl:overflow-visible"
      style="scrollbar-gutter: stable"><!-- <xl 时本格是唯一滚动器；≥xl overflow:visible 时 gutter 自动失效 -->
      <div class="min-h-0 flex flex-col">
        <DownloadQueueList
          :queues="displayQueues"
          :loading="loadingQueues"
          :selected-queue-id="selectedQueue?.id ?? null"
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
          :retrying-task-ids="retryingTaskIds"
          :empty-error="tasksError"
          :standalone-tasks="standaloneTasks"
          :deleting-task-ids="deletingTaskIds"
          @retry-task="retryTask"
          @delete-task="deleteTask"
        />
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, onMounted, onUnmounted, watch } from 'vue'
import { toast, pixelConfirm } from '../lib/feedback'
import { downloadsApi } from '../api/downloads'
import { apiErrorMessage } from '../api/http'
import { createReqGate } from '../lib/req-gate'
import { queueProgress } from '../lib/downloadStatus.js'
import DownloadQueueList from './DownloadQueueList.vue'
import DownloadTaskList from './DownloadTaskList.vue'

const props = defineProps({
  // 深链预选意图（?view=downloads&pl=<侧栏歌单id>，由 App 从 useSearchNav 下发）。
  // 侧栏身份 = 远端单数字 id / 本地镜像 local_pl_*，与服务端队列透出的
  // neteasePlaylistId 恒等可比；local_pl_* 经 String() 归一不丢形
  preselectPlaylistId: {
    type: [String, Number],
    default: null
  }
})

const queues = ref([])
const selectedQueue = ref(null)
const tasks = ref([])
const loadingQueues = ref(false)
const loadingTasks = ref(false)
const retryingTaskIds = ref([])
const queueSearch = ref('')
const queueStatusFilter = ref('all')
const hasLoadedQueues = ref(false)
const hasLoadedTasks = ref(false)
// 未入队单曲（queue_id NULL 的 standalone 单曲下载）：队列任务接口看不见它们，
// 删除/重试需要可见入口——按选中队列的歌单顺带拉全量任务滤出
const standaloneTasks = ref([])
const deletingTaskIds = ref([])

let pollInterval = null

const displayQueues = computed(() => {
  const priority = {
    running: 0,
    paused: 1,
    pending: 2,
    failed: 3,
    completed: 4,
    cancelled: 5
  }

  const normalizedQuery = queueSearch.value.trim().toLowerCase()

  const filteredQueues = queues.value.filter(queue => {
    if (queueStatusFilter.value !== 'all' && queue.status !== queueStatusFilter.value) {
      return false
    }

    if (normalizedQuery) {
      const haystacks = [queue.name, String(queue.id), String(queue.playlistId)].filter(Boolean).map(value => value.toLowerCase())
      if (!haystacks.some(value => value.includes(normalizedQuery))) {
        return false
      }
    }

    return true
  })

  const sortedQueues = [...filteredQueues].sort((left, right) => {
    const leftSelected = selectedQueue.value && left.id === selectedQueue.value.id ? 0 : 1
    const rightSelected = selectedQueue.value && right.id === selectedQueue.value.id ? 0 : 1

    if (leftSelected !== rightSelected) {
      return leftSelected - rightSelected
    }

    const leftPriority = priority[left.status] ?? 99
    const rightPriority = priority[right.status] ?? 99

    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority
    }

    const leftProgress = queueProgress(left)
    const rightProgress = queueProgress(right)

    if (leftProgress !== rightProgress) {
      return rightProgress - leftProgress
    }

    return right.id - left.id
  })

  return sortedQueues
})

// 首次加载失败与"真的为空"要区分开——否则服务挂掉时 UI 显示空态误导
const loadError = ref('')
const tasksError = ref('')
const queueEmptyText = computed(() => {
  return loadError.value || '还没有下载队列喵~'
})

// diff 收窄前提（不变量）：download_queues/download_tasks 的一切运行期写都收口在
// updateQueue/updateTask/recountQueueCounters——三者无条件 bump updated_at；
// 旁路只有 DELETE（行消失由长度/id 维兜住）。新增裸写 UPDATE 路径必须先 bump
// updated_at，否则这里漏判变更。
// updated_at 是毫秒精度：同毫秒两次写会产同戳——比较集内的高变列（status/计数/
// progress/errorMessage）直接比，把别名窗收窄到"同毫秒且比较集全同"（该窗口内
// 只有未入集列的变化，它们仍靠 updatedAt 兜底）。
// coverImgUrl（JOIN playlists 外来列，封面随歌单行变而本行戳不动）与
// filesIntact（盘上文件实时判定，外部删文件无任何 DB 写）不随 updated_at——单列。
function hasQueueChanged(currentQueue, nextQueue) {
  if (!currentQueue || !nextQueue) return currentQueue !== nextQueue
  return currentQueue.id !== nextQueue.id
    || currentQueue.updatedAt !== nextQueue.updatedAt
    || currentQueue.coverImgUrl !== nextQueue.coverImgUrl
    || currentQueue.status !== nextQueue.status
    || currentQueue.totalTasks !== nextQueue.totalTasks
    || currentQueue.completedTasks !== nextQueue.completedTasks
    || currentQueue.failedTasks !== nextQueue.failedTasks
}

function hasTaskChanged(currentTask, nextTask) {
  if (!currentTask || !nextTask) return currentTask !== nextTask
  return currentTask.id !== nextTask.id
    || currentTask.updatedAt !== nextTask.updatedAt
    || currentTask.filesIntact !== nextTask.filesIntact
    || currentTask.status !== nextTask.status
    || currentTask.progress !== nextTask.progress
    || currentTask.errorMessage !== nextTask.errorMessage
}

function hasCollectionChanged(currentItems, nextItems, compareItem) {
  if (currentItems.length !== nextItems.length) {
    return true
  }

  for (let index = 0; index < currentItems.length; index += 1) {
    if (compareItem(currentItems[index], nextItems[index])) {
      return true
    }
  }

  return false
}

// 选中项"在快照里缺席"的连续计数：请求发出到响应落地之间用户新选的队列
// 不在旧快照里是正常竞态——一轮缺席可能恰是窗口，两轮都不在才是真删除
let selectionMissCount = 0

function selectQueue(queue) {
  selectedQueue.value = queue
  selectionMissCount = 0
  // 立即清空旧队列任务——加载/轮询间隙不应在 B 名下展示 A 的任务列表
  tasks.value = []
  standaloneTasks.value = []
  hasLoadedTasks.value = false
  tasksError.value = ''
  loadTasks(queue.id)
}

// 手动刷新（action 后 await loadQueues）与轮询 tick 可并发：认领闸保后发者赢，
// 晚出发的旧响应不覆盖新快照；loadTasks 另有选中队列归属校验兜跨队列竞态
const queuesGate = createReqGate()
const tasksGate = createReqGate()
const standaloneGate = createReqGate()

// 深链预选（?view=downloads&pl=）：消费即焚——同一值只预选一次，轮询不再
// 重抢用户后续手选；同值返回导航是已知边界（prop 不变不重发）
let preselectConsumed = null

function applyPreselect(list) {
  const pl = props.preselectPlaylistId
  if (pl == null || String(pl) === preselectConsumed) return
  preselectConsumed = String(pl)
  const matches = list.filter(
    queue => queue.neteasePlaylistId != null && String(queue.neteasePlaylistId) === String(pl)
  )
  if (!matches.length) {
    // 该歌单没建过队列（或队列已级联清掉）——给用户一句交代而不是静默落地
    toast('该歌单还没有下载队列', 'info')
    return
  }
  // 一歌单可有多条兄弟队列（终态壳收养未净）：运行中优先，其次最新行
  const target = matches.find(queue => queue.status === 'running')
    ?? matches.reduce((latest, queue) => (queue.id > latest.id ? queue : latest))
  // 选中行可能被现有搜索/状态过滤藏掉——预选意图明确，清回全集
  queueSearch.value = ''
  queueStatusFilter.value = 'all'
  selectionMissCount = 0
  selectedQueue.value = target
  tasks.value = []
  standaloneTasks.value = []
  hasLoadedTasks.value = false
  tasksError.value = ''
  loadTasks(target.id)
}

async function loadQueues(options = {}) {
  const { silent = false } = options
  const my = queuesGate.claim()
  // 谁置旗谁收旗：被 gate 丢弃的超期响应 finally 不再够着 isCurrent——
  // 若按 isCurrent 决定清旗，"非静默在途 + 静默新认领"组合会让 loading 永真卡死
  const showSpinner = !silent && !hasLoadedQueues.value

  try {
    if (showSpinner) {
      loadingQueues.value = true
    }
    const response = await downloadsApi.listQueues()
    // 超期响应先丢——被新认领顶掉的旧快照连校验都不该做（与 loadTasks 同口径），
    // 否则"超期+畸形"的组合会进 catch 打噪音甚至误写首载错误态
    if (!queuesGate.isCurrent(my)) return
    // 响应体非 envelope（如同源静态服的 index.html 200）：不能当空列表吞掉，
    // 抛错走 catch → 首载显示错误态而不是"还没有下载队列"假象
    if (!response || !Array.isArray(response.data)) {
      throw new Error('接口返回了非预期内容（可能打到了静态服务器）')
    }
    const nextQueues = response.data
    const previousSelectedQueueId = selectedQueue.value?.id ?? null
    const queuesChanged = hasCollectionChanged(queues.value, nextQueues, hasQueueChanged)

    if (queuesChanged) {
      queues.value = nextQueues
    }

    const activeQueues = queuesChanged ? nextQueues : queues.value

    if (previousSelectedQueueId != null) {
      const matchedQueue = activeQueues.find(queue => queue.id === previousSelectedQueueId)
      if (matchedQueue) {
        selectionMissCount = 0
        // 无实质变化不换对象引用——否则每轮 tick 都触发 displayQueues
        // 全量重过滤排序 + 子树重渲（mapQueueRow 每响应都产新对象）
        if (hasQueueChanged(selectedQueue.value, matchedQueue)) {
          selectedQueue.value = matchedQueue
        }
      } else if (++selectionMissCount >= 2) {
        // 连续两轮快照都缺席才判定删除——单轮缺席可能只是"响应快照早于用户点击"
        selectionMissCount = 0
        selectedQueue.value = null
        tasks.value = []
        standaloneTasks.value = []
        hasLoadedTasks.value = false
      }
    }

    // 深链预选在真实快照上跑——预置假行会被上面的两轮缺席判定清掉
    applyPreselect(activeQueues)

    hasLoadedQueues.value = true
    loadError.value = ''
  } catch (error) {
    console.error('加载队列失败:', error)
    // 首次加载失败给用户可见的错误态；轮询静默失败不打断界面
    if (!hasLoadedQueues.value) {
      loadError.value = '加载失败: ' + (apiErrorMessage(error))
    }
  } finally {
    if (showSpinner) {
      loadingQueues.value = false
    }
  }
}

async function loadTasks(queueId, options = {}) {
  const { silent = false } = options
  const my = tasksGate.claim()
  const showSpinner = !silent && !hasLoadedTasks.value

  try {
    if (showSpinner) {
      loadingTasks.value = true
    }
    // 单端点拿 队列+任务 原子快照——队列行与任务列表同一时刻，不会出现
    // "队列显示完成而任务还在下载中"的中间帧（分离请求各自的延迟会交错）
    const response = await downloadsApi.getQueue(queueId)
    if (!tasksGate.isCurrent(my)) return
    // 响应可能属于上一个选中队列（并发 selectQueue 交错）——归属校验防错写
    if (String(selectedQueue.value?.id) !== String(queueId)) return
    // 与 loadQueues 对齐：打错部署（静态服务器返回 HTML）不能让任务面板
    // 永远显示"还没有任务"
    if (!response || !Array.isArray(response.data?.tasks)) {
      throw new Error('任务列表响应格式异常')
    }
    const nextTasks = response.data.tasks
    if (hasCollectionChanged(tasks.value, nextTasks, hasTaskChanged)) {
      tasks.value = nextTasks
    }
    // 顺手用同一快照刷新选中队列行（避免等下一轮 listQueues 才更新状态）；
    // 同上：无实质变化不换引用，防每 tick 重排重渲
    const freshQueue = response.data.queue
    if (freshQueue && selectedQueue.value
        && hasQueueChanged(selectedQueue.value, freshQueue)) {
      selectedQueue.value = freshQueue
    }
    hasLoadedTasks.value = true
    tasksError.value = ''
    // standalone 附属分节跟同一节拍刷新——自带 gate 且静默容错，不阻塞主链
    loadStandaloneTasks(selectedQueue.value?.playlistId)
  } catch (error) {
    console.error('加载任务失败:', error)
    // 与队列侧同口径：首载失败给可见错误态，轮询静默失败不打断
    if (!hasLoadedTasks.value) {
      tasksError.value = '加载失败: ' + (apiErrorMessage(error))
    }
  } finally {
    if (showSpinner) {
      loadingTasks.value = false
    }
  }
}

// 队列动作统一入口：双击/快连点的并发闸（服务端对重复动作回 409，先拦掉
// 无意义往返）；refreshTasks 只对"会动任务列表"的动作多刷一份任务
const busyQueueIds = new Set()

async function runQueueAction(queueId, label, call, { refreshTasks = false } = {}) {
  if (busyQueueIds.has(queueId)) return
  busyQueueIds.add(queueId)
  try {
    await call(queueId)
    await loadQueues()
    if (refreshTasks && String(selectedQueue.value?.id) === String(queueId)) {
      await loadTasks(queueId)
    }
  } catch (error) {
    console.error(`${label}失败:`, error)
    toast(`${label}失败: ` + (apiErrorMessage(error)), 'error')
  } finally {
    busyQueueIds.delete(queueId)
  }
}

const startQueue = (queueId) => runQueueAction(queueId, '启动队列', downloadsApi.startQueue)
const pauseQueue = (queueId) => runQueueAction(queueId, '暂停队列', downloadsApi.pauseQueue)
const resumeQueue = (queueId) => runQueueAction(queueId, '恢复队列', downloadsApi.resumeQueue)
const retryQueue = (queueId) => runQueueAction(queueId, '重试队列', downloadsApi.retryQueue, { refreshTasks: true })

async function cancelQueue(queueId) {
  if (!await pixelConfirm('确定要取消这个队列吗？未完成的任务将停止下载', { confirmText: '取消队列', danger: true })) return
  // 已确认的意图不能静默吞——runQueueAction 的 busy 静默退适合无确认的点击，
  // 走过 confirm 的必须给交代
  if (busyQueueIds.has(queueId)) {
    toast('该队列有操作进行中，请稍后再取消', 'info')
    return
  }
  await runQueueAction(queueId, '取消队列', downloadsApi.cancelQueue, { refreshTasks: true })
}

async function retryTask(taskId) {
  if (retryingTaskIds.value.includes(taskId)) return
  retryingTaskIds.value.push(taskId)

  try {
    await downloadsApi.retryTask(taskId)
    if (selectedQueue.value) {
      await Promise.all([
        loadQueues(),
        loadTasks(selectedQueue.value.id)
      ])
    } else {
      await loadQueues()
    }
  } catch (error) {
    console.error('重试任务失败:', error)
    toast('重试任务失败: ' + (apiErrorMessage(error)), 'error')
  } finally {
    retryingTaskIds.value = retryingTaskIds.value.filter(id => id !== taskId)
  }
}

// standalone 分节：按歌单 id 拉全量任务滤 queueId==null。附属面失败静默——
// 主任务列的 tasksError 语义专属队列任务，不背它的锅
async function loadStandaloneTasks(playlistId) {
  if (playlistId == null) {
    standaloneTasks.value = []
    return
  }
  const my = standaloneGate.claim()
  try {
    const response = await downloadsApi.listTasks({ playlistId })
    if (!standaloneGate.isCurrent(my)) return
    // 与主链同口径：畸形响应静默丢弃，不吞成"没有 standalone"假象——
    // 但 standalone 无独立错误态，保留旧数据比清空更诚实
    if (!response || !Array.isArray(response.data)) return
    const nextStandalone = response.data.filter(task => task.queueId == null)
    if (hasCollectionChanged(standaloneTasks.value, nextStandalone, hasTaskChanged)) {
      standaloneTasks.value = nextStandalone
    }
  } catch (error) {
    if (standaloneGate.isCurrent(my)) {
      console.warn('[downloads] 未入队任务加载失败:', error?.message || error)
    }
  }
}

async function deleteTask(taskId) {
  if (deletingTaskIds.value.includes(taskId)) return
  const task = standaloneTasks.value.find(t => t.id === taskId)
  // 服务端会连盘上文件一起删；进行中任务 409 拒删走错误 toast
  if (!await pixelConfirm(
    `确定要删除「${task?.songName || '该任务'}」的下载任务吗？已下载的文件将一并移除`,
    { confirmText: '删除', danger: true }
  )) return
  deletingTaskIds.value.push(taskId)
  try {
    await downloadsApi.deleteTask(taskId)
    toast('已删除下载任务', 'success')
    await loadStandaloneTasks(selectedQueue.value?.playlistId)
  } catch (error) {
    console.error('删除任务失败:', error)
    toast('删除失败: ' + (apiErrorMessage(error)), 'error')
  } finally {
    deletingTaskIds.value = deletingTaskIds.value.filter(id => id !== taskId)
  }
}

async function deleteQueue(queueId) {
  // 服务端把队列删除升级为歌单级联：清掉该歌单全部下载足迹（单曲任务、其他
  // 队列、登记行与盘上文件），进行中的下载也会中止——确认文案必须说清爆炸半径
  const doomed = queues.value.find(q => q.id === queueId)
  if (!await pixelConfirm(
    `确定要删除${doomed?.name ? `「${doomed.name}」` : '这个歌单'}吗？其全部下载任务与已下载资源将一并清理，进行中的下载也会中止`,
    { confirmText: '删除', danger: true }
  )) return
  // 已确认的意图不能静默吞——busy 命中（同队列动作在途）给用户交代再退
  if (busyQueueIds.has(queueId)) {
    toast('该队列有操作进行中，请稍后再删', 'info')
    return
  }
  busyQueueIds.add(queueId)

  try {
    await downloadsApi.deleteQueue(queueId)
    await loadQueues()
    // 级联连坐删同歌单兄弟队列——选中项落在同一歌单上即清，别等两轮缺席判定
    if (String(selectedQueue.value?.id) === String(queueId)
        || (doomed?.playlistId != null && selectedQueue.value?.playlistId === doomed.playlistId)) {
      selectionMissCount = 0 // 手动清选中同样要归零——loadQueues 内缺席计数会留下惰性 =1
      selectedQueue.value = null
      tasks.value = []
      hasLoadedTasks.value = false
    }
    toast(doomed?.name ? `已删除「${doomed.name}」及其下载资源` : '已删除歌单及其下载资源', 'success')
  } catch (error) {
    console.error('删除歌单下载足迹失败:', error)
    toast('删除失败: ' + (apiErrorMessage(error)), 'error')
  } finally {
    busyQueueIds.delete(queueId)
  }
}

let pollInFlight = false

async function pollTick() {
  // 标签页不可见时跳过轮询：隐藏页面的进度刷新用户看不到，白耗请求；
  // in-flight 防 RTT>间隔时的请求重叠交错写
  if (document.hidden || pollInFlight) return
  pollInFlight = true
  try {
    await loadQueues({ silent: true })
    // 选中队列缺席窗口内（连续两轮未命中才清选中）不轮询任务——
    // 那两行快照里队列已删，任务接口会返回 [] 闪一帧"已删队列+空任务"
    if (selectedQueue.value && selectionMissCount === 0) {
      await loadTasks(selectedQueue.value.id, { silent: true })
    }
  } finally {
    pollInFlight = false
  }
}

function startPolling() {
  pollInterval = setInterval(pollTick, 2000)
}

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval)
    pollInterval = null
  }
}

// 回前台立即补一轮——否则要等下一个 2s 节拍才看到最新状态
function handleVisibilityChange() {
  if (!document.hidden) pollTick()
}

watch(() => selectedQueue.value?.id, (queueId) => {
  if (!queueId) {
    tasks.value = []
    standaloneTasks.value = []
    hasLoadedTasks.value = false
    tasksError.value = ''
  }
})

// 深链意图晚到（面板已挂载后从菜单/toast 再导航）：队列已载即就地预选
watch(() => props.preselectPlaylistId, () => {
  if (hasLoadedQueues.value) applyPreselect(queues.value)
})

onMounted(async () => {
  await loadQueues()
  startPolling()
  document.addEventListener('visibilitychange', handleVisibilityChange)
})

onUnmounted(() => {
  stopPolling()
  document.removeEventListener('visibilitychange', handleVisibilityChange)
})
</script>

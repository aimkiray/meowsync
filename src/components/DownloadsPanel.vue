<template>
  <!-- 主区全宽：下载管理视图占用整个内容列（YTM 式页面切换而非面板挤压）。
       sage 画布上两张纸面发丝盒（队列列 / 任务列） -->
  <div class="downloads-panel flex flex-col relative m-3 sm:m-5 flex-1 min-h-0 overflow-hidden">
    <!-- <xl 单列时两行各按内容撑高会超出面板——给网格自身加纵向滚动兜底 -->
    <div ref="gridEl" class="grid grid-cols-1 xl:grid-cols-[400px_minmax(0,1fr)] gap-4 flex-1 min-h-0 overflow-y-auto overscroll-contain xl:overflow-visible"
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

<script>
// 跨挂载会话快照：本页经 v-if 换页即整卸——队列/任务数据、选中队列、过滤器
// 抬到模块域，回场先渲旧值再由 onMounted 静默重拉（hasLoaded* 已立→无
// spinner 闪、右栏不空）；选中项若已失效由既有 miss-2 机制清选
const pageMem = {
  queues: [], tasks: [], standaloneTasks: [], selectedQueue: null,
  hasLoadedQueues: false, hasLoadedTasks: false,
  queueSearch: '', queueStatusFilter: 'all',
}
</script>

<script setup>
import { computed, ref, onMounted, onBeforeUnmount, onUnmounted, nextTick, watch } from 'vue'
import { readScrollMem, writeScrollMem, restoreScrollTop } from '../lib/scroll-mem'
import { toast, pixelConfirm } from '../lib/feedback'
import { downloadsApi } from '../api/downloads'
import { apiErrorMessage } from '../api/http'
import { createReqGate } from '../lib/req-gate'
import { queueProgress, pickQueueForPlaylist, preselectOutcome, PRESELECT_OUTCOME } from '../lib/downloadStatus.js'
import DownloadQueueList from './DownloadQueueList.vue'
import DownloadTaskList from './DownloadTaskList.vue'

const props = defineProps({
  // 深链预选意图（?view=downloads&pl=<侧栏歌单id>，由 App 从 useSearchNav 下发）。
  // 侧栏身份 = 远端单数字 id / 本地镜像 local_pl_*，与服务端队列透出的
  // neteasePlaylistId 恒等可比；local_pl_* 经 String() 归一不丢形
  preselectPlaylistId: {
    type: [String, Number],
    default: null
  },
  // 意图序号：同 pl 值重发「查看进度」时唯一变化位——消费键是 pl::seq 对，
  // 序号 bump 使已消费过的同值意图重新可预选
  preselectSeq: {
    type: Number,
    default: 0
  }
})

// 预选意图失效上报：父级据此清 downloadsPl 并同步地址栏——否则
// &pl= 死链残留 URL，刷新/回放每次都重放一次"还没有下载队列"
const emit = defineEmits(['preselect-expired'])

const queues = ref(pageMem.queues)
const selectedQueue = ref(pageMem.selectedQueue)
const tasks = ref(pageMem.tasks)
const loadingQueues = ref(false)
const loadingTasks = ref(false)
const retryingTaskIds = ref([])
const queueSearch = ref(pageMem.queueSearch)
const queueStatusFilter = ref(pageMem.queueStatusFilter)
const hasLoadedQueues = ref(pageMem.hasLoadedQueues)
const hasLoadedTasks = ref(pageMem.hasLoadedTasks)
// 未入队单曲（queue_id NULL 的 standalone 单曲下载）：队列任务接口看不见它们，
// 删除/重试需要可见入口——按选中队列的歌单走 standalone=1 服务端收窄查询
const standaloneTasks = ref(pageMem.standaloneTasks)
const deletingTaskIds = ref([])
const gridEl = ref(null)

// 卸载时把可复现的数据态回写快照（loading/轮询/序号闸等瞬态不存）；
// 顺带记外层滚动位（<xl 单列时唯一滚动器）。必须 onBeforeUnmount——
// 模板 ref 在子树拆除时已 detach，onUnmounted 里 gridEl.value 恒 null
let cancelScrollRestore = null
onBeforeUnmount(() => {
  cancelScrollRestore?.() // 等待窗内卸载即停轮询
  Object.assign(pageMem, {
    queues: queues.value, tasks: tasks.value, standaloneTasks: standaloneTasks.value,
    selectedQueue: selectedQueue.value,
    hasLoadedQueues: hasLoadedQueues.value, hasLoadedTasks: hasLoadedTasks.value,
    queueSearch: queueSearch.value, queueStatusFilter: queueStatusFilter.value,
  })
  writeScrollMem('downloads', { top: gridEl.value?.scrollTop ?? 0 })
})

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
// coverImgUrl/neteasePlaylistId/playlistId（JOIN playlists 外来列，歌单行变
// 而本行戳不动——neteasePlaylistId 还是预选/失效判定所键的列，漏了会让
// 旧快照把活的深链判死）与 filesIntact（盘上文件实时判定）不随 updated_at——单列。
function hasQueueChanged(currentQueue, nextQueue) {
  if (!currentQueue || !nextQueue) return currentQueue !== nextQueue
  return currentQueue.id !== nextQueue.id
    || currentQueue.updatedAt !== nextQueue.updatedAt
    || currentQueue.coverImgUrl !== nextQueue.coverImgUrl
    || currentQueue.neteasePlaylistId !== nextQueue.neteasePlaylistId
    || currentQueue.playlistId !== nextQueue.playlistId
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

// 深链预选（?view=downloads&pl=）：消费键是 pl::seq 对，用 Set 记账——
// 历史回放会把 seq 倒带到旧值，单键记账会让"已结算的旧意图"漏过判重
// 重新抢手选；seq bump（再点查看进度）产生新键，正常重发。
// 焚毁先于匹配是真缺席防刷屏闸——但调用方必须喂"当时最新快照"
// （watcher 路径走 loadQueues 现拉，不在陈旧 queues 上空判）
const preselectConsumed = new Set()

function applyPreselect(list) {
  const pl = props.preselectPlaylistId
  if (pl == null) return
  const target = pickQueueForPlaylist(list, pl)
  const outcome = preselectOutcome({
    consumed: preselectConsumed,
    consumeKey: `${String(pl)}::${props.preselectSeq}`,
    target
  })
  if (outcome === PRESELECT_OUTCOME.EXPIRED) {
    // 已结算意图的失效复检：队列在面板外死亡（侧栏删本地单级联/别端
    // DELETE）时主动把 &pl= 死链清掉——否则刷新重放缺席 toast
    emit('preselect-expired')
    return
  }
  if (outcome === PRESELECT_OUTCOME.MISS) {
    // 该歌单没建过队列（或队列已级联清掉）——给用户一句交代而不是静默落地；
    // 顺手把死意图回报掉：&pl= 死链留地址栏会每次刷新都重放这条 toast
    toast('该歌单还没有下载队列', 'info')
    emit('preselect-expired')
    return
  }
  if (outcome !== PRESELECT_OUTCOME.SELECT) return
  // 选中行可能被现有搜索/状态过滤藏掉——预选意图明确，清回全集
  queueSearch.value = ''
  queueStatusFilter.value = 'all'
  // 已在本队列上的重复点击不 reloadTasks——选中语义幂等，没必要清空重拉
  if (target.id !== selectedQueue.value?.id) selectQueue(target)
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

// standalone 分节：standalone=1 服务端收窄（queue_id IS NULL）+ 客户端
// 复核作收养窗口双保险。附属面失败静默——主任务列的 tasksError 语义
// 专属队列任务，不背它的锅
async function loadStandaloneTasks(playlistId) {
  // claim 必须在 null 早退之前：清空/孤儿路径不认领会放跑在途旧响应
  const my = standaloneGate.claim()
  if (playlistId == null) {
    standaloneTasks.value = []
    return
  }
  try {
    // standalone=1 服务端收窄——不再每 2s 把全歌单任务行搬过来客户端滤；
    // 客户端仍复核 queueId==null：查询落地到应用之间的收养窗口会混入
    // 刚被建队列收走的行，双保险成本是一次内存 filter
    const response = await downloadsApi.listTasks({ playlistId, standalone: 1 })
    if (!standaloneGate.isCurrent(my)) return
    // 归属校验与 loadTasks 同口径：selectQueue 交错时旧歌单的响应不写新名分
    if (String(selectedQueue.value?.playlistId) !== String(playlistId)) return
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
  // 守门：删除入口只露在 standalone 分节——队列任务生命周期归队列调度器
  // 管，行级删除会绕开状态机（未来新分节误接此 emit 不越权）
  if (!task) return
  // 服务端会连盘上文件一起删；进行中任务 409 拒删走错误 toast
  if (!await pixelConfirm(
    `确定要删除「${task.songName || '该任务'}」的下载任务吗？已下载的文件将一并移除`,
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
    // 删的正是预选目标所属歌单：先把意图键预焚——loadQueues 内的
    // applyPreselect 走已结算分支只清死链不报"还没有下载队列"
    //（队列明明刚被自己删掉，那句 toast 时机是误导）；失败不焚，
    // 队列还在的意图理应继续生效
    if (doomed?.neteasePlaylistId != null && props.preselectPlaylistId != null
        && String(doomed.neteasePlaylistId) === String(props.preselectPlaylistId)) {
      preselectConsumed.add(`${String(props.preselectPlaylistId)}::${props.preselectSeq}`)
    }
    await loadQueues()
    // 级联连坐删同歌单兄弟队列——选中项落在同一歌单上即清，别等两轮缺席判定
    if (String(selectedQueue.value?.id) === String(queueId)
        || (doomed?.playlistId != null
            && String(selectedQueue.value?.playlistId) === String(doomed.playlistId))) {
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

// 深链意图晚到（面板已挂载后从菜单/toast 再导航）：必须 loadQueues 现拉
// 鲜快照再判——刚建的队列可能还没进上一轮轮询快照，用旧集匹配会
// 误报「还没有下载队列」并把意图焚毁（查看进度恰是"建完即点"的场景）
watch(
  () => [props.preselectPlaylistId, props.preselectSeq],
  () => {
    if (props.preselectPlaylistId != null && hasLoadedQueues.value) loadQueues()
  }
)

onMounted(async () => {
  // 回场还位外层滚动（快照数据已先渲一帧，再后台重拉）
  nextTick(() => {
    const m = readScrollMem('downloads')
    if (m) cancelScrollRestore = restoreScrollTop(gridEl.value, m.top)
  })
  await loadQueues()
  // 快照恢复的选中态下 tasks/standaloneTasks 也是旧值——立即静默重拉，
  // 不等首个 pollTick（2s 节拍）才刷新
  if (selectedQueue.value?.id != null) {
    void loadTasks(selectedQueue.value.id, { silent: true })
  }
  startPolling()
  document.addEventListener('visibilitychange', handleVisibilityChange)
})

onUnmounted(() => {
  stopPolling()
  document.removeEventListener('visibilitychange', handleVisibilityChange)
  // 三道 gate 全部作废——卸载后落地的响应不该再跑 applyPreselect：
  // 深链落空 toast 会打在已离开的页面上，preselect-expired 也会改错历史条目
  queuesGate.claim()
  tasksGate.claim()
  standaloneGate.claim()
})
</script>

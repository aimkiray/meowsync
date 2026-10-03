// 下载状态元数据收口——DownloadQueueList / DownloadTaskList / DownloadTaskRow
// 原本三处各自抄写文案表与芯片类名映射（queue 侧「等待中」、task 侧「等待」
// 这类词汇漂移 + dql-chip--*/dtr-chip--* 两套私有色档的源头）。
// 色档四态：on=激活墨底（pg-chip--on 全局已有）/ ok=绿戳 / fail=危险红 / dim=淡墨。

const CHIP_CLASS = {
  on: 'pg-chip--on',
  ok: 'pg-chip--ok',
  fail: 'pg-chip--fail',
  dim: 'pg-chip--dim'
}

const QUEUE_STATUS_META = {
  pending: { label: '等待中', tier: 'dim' },
  running: { label: '运行中', tier: 'on' },
  paused: { label: '已暂停', tier: 'dim' },
  completed: { label: '已完成', tier: 'ok' },
  failed: { label: '失败', tier: 'fail' },
  cancelled: { label: '已取消', tier: 'dim' }
}

const TASK_STATUS_META = {
  pending: { label: '等待', tier: 'dim' },
  downloading: { label: '下载中', tier: 'on' },
  completed: { label: '完成', tier: 'ok' },
  failed: { label: '失败', tier: 'fail' }
}

export function queueStatusMeta(status) {
  return QUEUE_STATUS_META[status] || { label: status, tier: 'dim' }
}

export function taskStatusMeta(status) {
  return TASK_STATUS_META[status] || { label: status, tier: 'dim' }
}

export function statusChipClass(tier) {
  return CHIP_CLASS[tier] || CHIP_CLASS.dim
}

// 队列完成度百分比——DownloadsPanel 排序键与 DownloadQueueList 行展示共用
export function queueProgress(queue) {
  if (!queue || !queue.totalTasks) return 0
  // 计数漂移防御：completed>total 时仍钳 100（aria-valuenow 合法性）
  return Math.min(100, Math.round((queue.completedTasks / queue.totalTasks) * 100))
}

// 深链预选挑队列：一歌单可有多条兄弟队列（终态壳收养未净）——
// running 优先，否则取 id 最新行。侧栏歌单 id（数字/local_pl_*）经 String 归一
export function pickQueueForPlaylist(queues, sidebarPlaylistId) {
  if (sidebarPlaylistId == null || !Array.isArray(queues)) return null
  const pl = String(sidebarPlaylistId)
  const matches = queues.filter(
    queue => queue?.neteasePlaylistId != null && String(queue.neteasePlaylistId) === pl
  )
  if (!matches.length) return null
  return matches.find(queue => queue.status === 'running')
    ?? matches.reduce((latest, queue) => (queue.id > latest.id ? queue : latest))
}

// 状态过滤 select 的选项单：标签与 QUEUE_STATUS_META 同源（第四处抄写收编），
// 顺序按交互习惯排——活跃态在前。加/改状态只需动 META 表与这里的顺序数组
export const queueStatusFilterOptions = [
  { value: 'all', label: '全部状态' },
  ...['running', 'paused', 'pending', 'failed', 'completed', 'cancelled']
    .map(value => ({ value, label: QUEUE_STATUS_META[value].label }))
]

// 深链预选的判定核（纯函数面）：消费键账本 + 命中结果 → 四种裁决。
// 副作用（emit/toast/选中）留在组件；判定的三态区分是失效上报的承重语义——
// 已结算意图复检缺席只清死链不报「还没有下载队列」（自删/外部级联路径），
// 首次落空才给那句交代性 toast。
export const PRESELECT_OUTCOME = {
  SKIP: 'skip',       // 已结算且队列仍在——什么都不做
  EXPIRED: 'expired', // 已结算但队列已死——只上报失效清意图
  MISS: 'miss',       // 首次结算落空——报错 toast + 上报失效
  SELECT: 'select'    // 首次结算命中——选中该队列
}
export function preselectOutcome({ consumed, consumeKey, target }) {
  if (consumed.has(consumeKey)) {
    return target ? PRESELECT_OUTCOME.SKIP : PRESELECT_OUTCOME.EXPIRED
  }
  consumed.add(consumeKey)
  return target ? PRESELECT_OUTCOME.SELECT : PRESELECT_OUTCOME.MISS
}

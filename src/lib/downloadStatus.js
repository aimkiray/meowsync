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

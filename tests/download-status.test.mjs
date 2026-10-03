import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  queueStatusMeta,
  taskStatusMeta,
  statusChipClass,
  queueProgress,
  queueStatusFilterOptions,
  pickQueueForPlaylist
} from '../src/lib/downloadStatus.js'

// 词表与色档收编面：队列/任务状态 meta、tier→芯片类、进度、过滤选项。
// 这些值曾是三处抄写漂移的源头——锁定即防再漂。

test('queueStatusMeta：六值词表与色档锁定', () => {
  assert.deepEqual(queueStatusMeta('pending'), { label: '等待中', tier: 'dim' })
  assert.deepEqual(queueStatusMeta('running'), { label: '运行中', tier: 'on' })
  assert.deepEqual(queueStatusMeta('paused'), { label: '已暂停', tier: 'dim' })
  assert.deepEqual(queueStatusMeta('completed'), { label: '已完成', tier: 'ok' })
  assert.deepEqual(queueStatusMeta('failed'), { label: '失败', tier: 'fail' })
  assert.deepEqual(queueStatusMeta('cancelled'), { label: '已取消', tier: 'dim' })
})

test('taskStatusMeta：四值词表与色档锁定（与队列词汇分化）', () => {
  // 「等待中」vs「等待」是两表刻意的词汇分化——合并会改 UI 文案
  assert.deepEqual(taskStatusMeta('pending'), { label: '等待', tier: 'dim' })
  assert.deepEqual(taskStatusMeta('downloading'), { label: '下载中', tier: 'on' })
  assert.deepEqual(taskStatusMeta('completed'), { label: '完成', tier: 'ok' })
  assert.deepEqual(taskStatusMeta('failed'), { label: '失败', tier: 'fail' })
})

test('statusMeta 未知值回落：透传原串 + dim 档', () => {
  assert.deepEqual(queueStatusMeta('weird'), { label: 'weird', tier: 'dim' })
  assert.deepEqual(taskStatusMeta(''), { label: '', tier: 'dim' })
})

test('statusChipClass：四档发牌与未知回落', () => {
  assert.equal(statusChipClass('on'), 'pg-chip--on')
  assert.equal(statusChipClass('ok'), 'pg-chip--ok')
  assert.equal(statusChipClass('fail'), 'pg-chip--fail')
  assert.equal(statusChipClass('dim'), 'pg-chip--dim')
  assert.equal(statusChipClass('bogus'), 'pg-chip--dim')
})

test('queueProgress：空值/零总/正常/超界钳位', () => {
  assert.equal(queueProgress(null), 0)
  assert.equal(queueProgress({ totalTasks: 0, completedTasks: 0 }), 0)
  assert.equal(queueProgress({ totalTasks: 10, completedTasks: 3 }), 30)
  // 计数漂移防御：completed>total 时输出仍钳在 100 内（aria-valuenow 合法性）
  assert.equal(queueProgress({ totalTasks: 3, completedTasks: 5 }), 100)
})

test('pickQueueForPlaylist：深链预选匹配与挑队列规则', () => {
  const queues = [
    { id: 10, status: 'completed', neteasePlaylistId: '777' },
    { id: 12, status: 'cancelled', neteasePlaylistId: '777' },  // 同单兄弟壳→取最新 id
    { id: 20, status: 'running', neteasePlaylistId: 'local_pl_x' },
    { id: 30, status: 'running', neteasePlaylistId: null },    // 孤儿行不参与匹配
  ]
  // 数字侧栏 id 与 TEXT 列经 String 归一互命中
  assert.equal(pickQueueForPlaylist(queues, 777)?.id, 12)
  assert.equal(pickQueueForPlaylist(queues, '777')?.id, 12)
  assert.equal(pickQueueForPlaylist(queues, 'local_pl_x')?.id, 20)
  // 多匹配时 running 优先于最新 id——且 running 项不靠在数组末位，
  // 否则"取末位"的错误实现也能混过断言
  const withRunning = [
    ...queues,
    { id: 5, status: 'running', neteasePlaylistId: '777' },
    { id: 99, status: 'completed', neteasePlaylistId: '777' }
  ]
  assert.equal(pickQueueForPlaylist(withRunning, '777')?.id, 5)
  // 未命中/空入参归 null；'null'/'undefined' 字面串不得误配孤儿行
  assert.equal(pickQueueForPlaylist(queues, 'no-such'), null)
  assert.equal(pickQueueForPlaylist(queues, null), null)
  assert.equal(pickQueueForPlaylist(queues, 'null'), null)
  assert.equal(pickQueueForPlaylist(queues, 'undefined'), null)
  assert.equal(pickQueueForPlaylist(null, '777'), null)
})

test('queueStatusFilterOptions：all 居首 + 六个 META 键恰好各一次（反向漂移闸）', () => {
  assert.equal(queueStatusFilterOptions[0].value, 'all')
  const keys = queueStatusFilterOptions.slice(1).map(o => o.value).sort()
  assert.deepEqual(keys, ['cancelled', 'completed', 'failed', 'paused', 'pending', 'running'])
  // 标签与词表同源——META 改文案这里必须跟着变
  for (const opt of queueStatusFilterOptions.slice(1)) {
    assert.equal(opt.label, queueStatusMeta(opt.value).label)
  }
})

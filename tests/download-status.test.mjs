import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  queueStatusMeta,
  taskStatusMeta,
  statusChipClass,
  queueProgress,
  queueStatusFilterOptions,
  pickQueueForPlaylist,
  preselectOutcome,
  PRESELECT_OUTCOME
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

test('queueProgress：completedTasks 缺位/非数值不产 NaN', () => {
  // undefined/total 会算成 NaN——aria-valuenow=NaN 比显示 0 更糟
  assert.equal(queueProgress({ totalTasks: 10 }), 0)
  assert.equal(queueProgress({ totalTasks: 10, completedTasks: undefined }), 0)
  assert.equal(queueProgress({ totalTasks: 10, completedTasks: NaN }), 0)
  assert.equal(queueProgress({ totalTasks: 10, completedTasks: -3 }), 0)
  // 数值串宽容计数（服务端偶发字符串列）
  assert.equal(queueProgress({ totalTasks: 10, completedTasks: '5' }), 50)
})

test('queueProgress：totalTasks 非数值同样不产 NaN', () => {
  // 与 completedTasks 同口径：'abc'/NaN 一律按 0 计而非裸除出门
  assert.equal(queueProgress({ totalTasks: 'abc', completedTasks: 5 }), 0)
  assert.equal(queueProgress({ totalTasks: NaN, completedTasks: 5 }), 0)
  assert.equal(queueProgress({ totalTasks: undefined, completedTasks: 5 }), 0)
  assert.equal(queueProgress({ totalTasks: 'abc', completedTasks: 'abc' }), 0)
  // total 侧数值串同样宽容计数
  assert.equal(queueProgress({ totalTasks: '10', completedTasks: 5 }), 50)
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

test('preselectOutcome：四态裁决与账本一次性焚毁', () => {
  // 深链预选的判定核——三态区分是失效上报的承重语义：
  // 已结算复检缺席只清死链（EXPIRED），首次落空才报错（MISS）
  const q = { id: 7 }
  const consumed = new Set()
  // 首次命中 → SELECT 且键焚毁
  assert.equal(preselectOutcome({ consumed, consumeKey: '777::0', target: q }), PRESELECT_OUTCOME.SELECT)
  assert.ok(consumed.has('777::0'))
  // 已结算且队列仍在 → SKIP（重复快照不重复选中）
  assert.equal(preselectOutcome({ consumed, consumeKey: '777::0', target: q }), PRESELECT_OUTCOME.SKIP)
  // 已结算但队列已死（自删/外部级联）→ EXPIRED：只清死链不报「还没有下载队列」
  assert.equal(preselectOutcome({ consumed, consumeKey: '777::0', target: null }), PRESELECT_OUTCOME.EXPIRED)
  // 不同 seq 是新键——同歌单再点「查看进度」正常重发
  assert.equal(preselectOutcome({ consumed, consumeKey: '777::1', target: q }), PRESELECT_OUTCOME.SELECT)
  // 首次落空 → MISS 且键焚毁（真缺席防刷屏闸：后续快照不重报 toast）
  const c2 = new Set()
  assert.equal(preselectOutcome({ consumed: c2, consumeKey: '888::0', target: null }), PRESELECT_OUTCOME.MISS)
  assert.ok(c2.has('888::0'))
  // MISS 之后队列仍缺席 → EXPIRED 而非再 MISS——「报错只报一次」就靠这条边
  assert.equal(preselectOutcome({ consumed: c2, consumeKey: '888::0', target: null }), PRESELECT_OUTCOME.EXPIRED)
})

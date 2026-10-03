import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ref, computed, nextTick } from 'vue'
import { usePagedList } from '../src/composables/usePagedList.js'

// usePagedList 是 SongList/PlaylistGrid×2/DownloadTaskList/WatchView 四处
// 共用的前缀渲染窗原语——此前零覆盖。node 环境无 IntersectionObserver，
// bindSentinel 走「无 IO 早退」分支，onBeforeUnmount 在裸调用下发 warn 无害。

const make = (n, extra = {}) => ref(Array.from({ length: n }, (_, i) => ({ id: i })))

test('前缀窗：loadMore 按页扩、hasMore 边界、rows slice 截断', () => {
  const source = make(70)
  const pg = usePagedList({ source, pageSize: 30 })
  assert.equal(pg.rows.value.length, 30)
  assert.equal(pg.hasMore.value, true)
  pg.loadMore()
  assert.equal(pg.rows.value.length, 60)
  pg.loadMore() // renderedCount=90 超过长度——slice 截断不越界
  assert.equal(pg.rows.value.length, 70)
  assert.equal(pg.hasMore.value, false)
  pg.loadMore() // 无货静默——不涨
  assert.equal(pg.rows.value.length, 70)
})

test('ensureRendered：仅目标在窗外才扩窗，窗内不动', () => {
  const source = make(50)
  const pg = usePagedList({ source, pageSize: 10 })
  pg.ensureRendered(5)   // 已在窗内——不动
  assert.equal(pg.renderedCount.value, 10)
  pg.ensureRendered(34)  // 窗外 → 扩到 35（物化目标行所需最小窗）
  assert.equal(pg.renderedCount.value, 35)
  pg.ensureRendered(12)  // 回指窗内不收缩
  assert.equal(pg.renderedCount.value, 35)
})

test('resetWhen：键变回卷+滚动归零；同键 append 不回卷', async () => {
  const source = make(60)
  const key = ref('pl_a')
  const scrollRoot = { scrollTop: 999 }
  const pg = usePagedList({
    source, pageSize: 20,
    resetWhen: () => key.value,
    scrollRoot: () => scrollRoot,
  })
  pg.loadMore() // → 40
  // 同源数组 append（不碰 resetWhen 键）→ 窗保持、滚动位置不踢
  source.value = [...source.value, { id: 60 }, { id: 61 }]
  await nextTick()
  assert.equal(pg.renderedCount.value, 40)
  assert.equal(scrollRoot.scrollTop, 999)
  // 身份键切换（切单/新搜索）→ 回卷到 pageSize + 置顶
  key.value = 'pl_b'
  await nextTick()
  assert.equal(pg.renderedCount.value, 20)
  assert.equal(scrollRoot.scrollTop, 0)
})

test('空源/无源与哨兵兜底：裸值不炸、无 IO 环境 bindSentinel 静默', () => {
  const empty = usePagedList({ source: ref([]), pageSize: 10 })
  assert.equal(empty.rows.value.length, 0)
  assert.equal(empty.hasMore.value, false)
  empty.loadMore() // 空源不涨
  assert.equal(empty.renderedCount.value, 10)
  // bindSentinel：null 卸载与无 IO 环境都是静默早退——不抛
  const pg = usePagedList({ source: make(5), pageSize: 3 })
  pg.bindSentinel(null)
  assert.equal(typeof IntersectionObserver === 'undefined', true) // node 环境钉死前提
  pg.bindSentinel({})
})

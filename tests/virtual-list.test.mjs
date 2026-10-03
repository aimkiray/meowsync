import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeVirtualWindow } from '../src/composables/useVirtualList.js'

// computeVirtualWindow 是 useVirtualList 的纯窗数学——SongList/WatchView
// 队列/PlaylistGrid 曲列三处滑窗的边界正确性全押在它身上。无 DOM 可测：
// scrollTop/listTop/viewH/rowH/total/overscan/pin → [start,end)。

const w = (o) => computeVirtualWindow({ overscan: 0, pin: null, ...o })

test('窗数学：视口中部——overscan 向两侧扩窗', () => {
  // listTop=200, scrollTop=1200, viewH=600, rowH=60, total=100
  // 首视行=floor((1200-200)/60)=16，末视行=ceil((1800-200)/60)=27
  const r = w({ scrollTop: 1200, listTop: 200, viewH: 600, rowH: 60, total: 100, overscan: 4 })
  assert.deepEqual(r, { start: 12, end: 31 })
})

test('窗数学：顶部钳位——scrollTop<listTop 不产负下标', () => {
  const r = w({ scrollTop: 0, listTop: 300, viewH: 500, rowH: 60, total: 50, overscan: 8 })
  assert.equal(r.start, 0)
  // 末视行=ceil((500-300)/60)=4，+overscan → 12
  assert.equal(r.end, 12)
})

test('窗数学：底部钳位——end 不越 total，start 不越界回拉', () => {
  const r = w({ scrollTop: 6000, listTop: 0, viewH: 600, rowH: 60, total: 100, overscan: 6 })
  assert.equal(r.end, 100)
  assert.equal(r.start, 94)
})

test('窗数学：空列表——start=end=0 不产幽灵窗', () => {
  const r = w({ scrollTop: 500, listTop: 0, viewH: 600, rowH: 60, total: 0, overscan: 8 })
  assert.deepEqual(r, { start: 0, end: 0 })
})

test('窗数学：listTop 偏移——列表上方内容（表头/英雄区）折进锚位', () => {
  // 同一 scrollTop，listTop 大 → 视口内行号整体后移
  const a = w({ scrollTop: 1000, listTop: 0, viewH: 300, rowH: 50, total: 100 })
  const b = w({ scrollTop: 1000, listTop: 500, viewH: 300, rowH: 50, total: 100 })
  assert.equal(b.start, a.start - 10) // 500px 偏移 = 10 行
})

test('窗数学：pin 行并入窗——拖拽行在视口下方时窗下沿被拉开', () => {
  const r = w({ scrollTop: 0, listTop: 0, viewH: 300, rowH: 60, total: 100, pin: 40 })
  assert.equal(r.start, 0)
  assert.equal(r.end, 41)
})

test('窗数学：pin 行并入窗——拖拽行在视口上方时窗上沿被拉开', () => {
  const r = w({ scrollTop: 3000, listTop: 0, viewH: 300, rowH: 60, total: 100, pin: 10 })
  assert.equal(r.start, 10)
  // 末视行=ceil(3300/60)=55
  assert.equal(r.end, 55)
})

test('窗数学：pin 越界/缺席被忽略——pin=-1 与 pin≥total 不生效', () => {
  const base = { scrollTop: 0, listTop: 0, viewH: 300, rowH: 60, total: 100 }
  assert.deepEqual(w({ ...base, pin: -1 }), w(base))
  assert.deepEqual(w({ ...base, pin: 100 }), w(base))
  assert.deepEqual(w({ ...base, pin: null }), w(base))
})

test('窗数学：非整视口——scrollTop 落在行中间时首行按 floor 含入', () => {
  // scrollTop-listTop=95（第 2 行中段，rowH=60）→ first=floor(95/60)=1
  const r = w({ scrollTop: 95, listTop: 0, viewH: 120, rowH: 60, total: 10 })
  assert.equal(r.start, 1)
  assert.equal(r.end, 4) // ceil(215/60)=4
})

test('窗数学：极小 total——end≥start 且窗不越界', () => {
  const r = w({ scrollTop: 0, listTop: 100, viewH: 800, rowH: 60, total: 3, overscan: 8 })
  assert.deepEqual(r, { start: 0, end: 3 })
})

// ── 深越界不变式（源塌缩钉：曾 start>end → 空窗+虚 spacer 逐帧回爬）──

test('窗数学：scrollTop 深越列表底——start≤end 且一帧落末段', () => {
  const r = w({ scrollTop: 100000, listTop: 0, viewH: 600, rowH: 60, total: 100, overscan: 8 })
  assert.ok(r.start <= r.end, `start(${r.start}) 不得大于 end(${r.end})`)
  assert.equal(r.end, 100)      // 末行必在窗
  assert.ok(r.start >= 91)      // 末段附近而非空窗（收敛于一帧）
  assert.ok(r.start < 100)
})

test('窗数学：scrollTop 恰越列表底——total=1 退化不崩', () => {
  const r = w({ scrollTop: 9999, listTop: 0, viewH: 600, rowH: 60, total: 1, overscan: 8 })
  assert.deepEqual(r, { start: 0, end: 1 })
})

test('窗数学：负 scrollTop（iOS 回弹）——start 钳 0 不产负窗', () => {
  const r = w({ scrollTop: -500, listTop: 0, viewH: 600, rowH: 60, total: 100, overscan: 4 })
  assert.equal(r.start, 0)
  assert.ok(r.end > 0 && r.end <= 100)
})

test('窗数学：小数行高 55.5（WatchView 实测档）——floor/ceil 不漂窗', () => {
  // scrollTop=1110 → first=floor(1110/55.5)=20；末视行=ceil(1770/55.5)=32
  const r = w({ scrollTop: 1110, listTop: 0, viewH: 660, rowH: 55.5, total: 500, overscan: 6 })
  assert.deepEqual(r, { start: 14, end: 38 })
})

test('窗数学：pin 边界——pin=0 与 pin=total-1 恰被纳入', () => {
  const base = { scrollTop: 3000, listTop: 0, viewH: 300, rowH: 60, total: 100 }
  assert.equal(w({ ...base, pin: 0 }).start, 0)
  assert.equal(w({ ...base, pin: 99 }).end, 100)
})

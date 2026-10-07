// 「接下来」分节线的滑窗归位：dividerPadAdjust/dividerRowShift 纯数学
// （三态互斥 + scrollHeight 不变式 + 行位连续）+ WatchView 挂载层的
// spacer 实写与 scrollToIndex/ensureVisible 含 sec 的落点校正。
// jsdom 无布局——滚动口几何（getClientRects/clientHeight/scrollHeight/
// overflow）与锚位 rect 全部桩定；.queue-sec 的 offsetHeight=0 → 恒吃
// fallback 28，实测路径用 bindQueueSec 直注
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'

// 组件图依赖桩——与 watch-view.spec.mjs 同组（挂载不打真服务端）
vi.mock('../../src/api/music.js', () => ({
  musicApi: {
    searchSongs: vi.fn(async () => []),
    bilibiliStreamUrl: vi.fn(() => 'https://x/bili'),
    youtubeStreamUrl: vi.fn(() => 'https://x/yt'),
  },
  parseLyrics: vi.fn(() => []),
  mergeTranslations: vi.fn((l) => l),
}))
vi.mock('../../src/api/downloads.js', () => ({
  downloadsApi: {
    getSongDownloadStatus: vi.fn(async () => null),
    songFileUrl: vi.fn(() => 'http://api/dl'),
  },
}))
vi.mock('../../src/lib/feedback.js', () => ({ toast: vi.fn() }))

import { dividerPadAdjust, dividerRowShift } from '../../src/composables/useVirtualList.js'
import WatchView from '../../src/components/WatchView.vue'

// jsdom 缺口补丁（同 watch-view.spec.mjs 口径）
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
}
if (typeof Element !== 'undefined') {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {}
}

const ROW = 55.5   // WatchView useVirtualList rowHeight
const SEC = 28     // QUEUE_SEC_FALLBACK（jsdom offsetHeight=0 → 恒走兜底）

const songs = (n) => Array.from({ length: n }, (_, i) => ({
  id: i + 1, name: `歌${i + 1}`, ar: [{ name: '艺人' }], al: { picUrl: 'https://c/p.jpg' }, dt: 200000,
}))

// attachTo 入文档：scrollToIndex 有 anchorEl.isConnected 闸——分离挂载的
// 锚永远 not connected 会静默早退，滚动落点用例必须真挂
const mounted = []
const mountQueue = (queue, currentSong, props = {}) => {
  const w = mount(WatchView, { attachTo: document.body, props: { queue, currentSong, tab: 'queue', ...props } })
  mounted.push(w)
  return w
}
afterEach(() => { while (mounted.length) mounted.pop().unmount() })

// 面板内两块 spacer（顶/底）的实写高度——DOM 层断言归位结果
const spacerHeights = (w) => [...w.find('#watch-panel-queue').element.children]
  .filter((el) => el.getAttribute('aria-hidden') === 'true')
  .map((el) => el.style.height)

// 把面板体桩成真滚动口：pickScroller 的 computed overflow + getClientRects
// + scrollHeight>clientHeight 三闸全过（jsdom 全零/visible 默认不命中）
const stubScrollport = (el, { viewH = 600 } = {}) => {
  el.style.overflowY = 'auto'
  Object.defineProperties(el, {
    getClientRects: { value: () => [{}], configurable: true },
    clientHeight: { value: viewH, configurable: true },
    scrollHeight: { value: 60000, configurable: true },
  })
}
// 顶 spacer 锚的 rect 随 scrollTop 反向平移（真实布局里锚钉在列表起点）——
// listTopOf 据此算出 0，scrollTop→行号换算才有意义。锚=首个 aria-hidden
// 直属子（裸 [aria-hidden] 选择器会先命中 queue-head 里 PixelIcon 的 svg）
const patchAnchorRect = (w, sc) => {
  const anchor = [...sc.children].find((el) => el.getAttribute('aria-hidden') === 'true')
  Object.defineProperty(anchor, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ top: -sc.scrollTop, right: 0, bottom: 0, left: 0, width: 0, height: 0 }),
  })
}
const scrollTo = async (w, sc, y) => {
  sc.scrollTop = y
  sc.dispatchEvent(new Event('scroll'))
  await nextTick()
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  window.scrollTo = vi.fn() // sc=null 兜底路径的 window.scrollTo 吞掉不写 scrollY
})

describe('dividerPadAdjust：分节线垫片归位（纯数学）', () => {
  const pads = (start, end, total) => ({ topPad: start * ROW, bottomPad: (total - end) * ROW })

  it('线在窗内（start≤di<end）：垫片原样——线已随 DOM 渲染', () => {
    const r = dividerPadAdjust({ ...pads(10, 30, 100), start: 10, end: 30, dividerIndex: 15, dividerH: SEC })
    expect(r).toEqual({ topPad: 555, bottomPad: 3885 })
  })

  it('线在窗上沿之上（di<start）：高度并进 topPad', () => {
    const r = dividerPadAdjust({ ...pads(10, 30, 100), start: 10, end: 30, dividerIndex: 5, dividerH: SEC })
    expect(r).toEqual({ topPad: 555 + SEC, bottomPad: 3885 })
  })

  it('线在窗下沿之下（di≥end）：高度并进 bottomPad', () => {
    const r = dividerPadAdjust({ ...pads(10, 30, 100), start: 10, end: 30, dividerIndex: 40, dividerH: SEC })
    expect(r).toEqual({ topPad: 555, bottomPad: 3885 + SEC })
  })

  it('线缺席：di=-1（曲不在队/末行）与 dividerH=0 都不动垫片', () => {
    const base = { ...pads(10, 30, 100), start: 10, end: 30 }
    expect(dividerPadAdjust({ ...base, dividerIndex: -1, dividerH: SEC })).toEqual({ topPad: 555, bottomPad: 3885 })
    expect(dividerPadAdjust({ ...base, dividerIndex: 15, dividerH: 0 })).toEqual({ topPad: 555, bottomPad: 3885 })
  })

  it('不变式：任意窗位+线位下 垫片+行区+已渲线 合计恒 = total*rowH+secH', () => {
    const total = 100
    for (const [start, end] of [[0, 12], [10, 30], [40, 60], [88, 100]]) {
      // 界值随窗扫 start-1/end-1/end——三态分支的 </>= 边界误写只在贴界
      // 线位上现形，固定散点可能全落在同侧漏检（Set 去重：start=0 时
      // start-1 与 -1 撞值等重叠）
      for (const di of new Set([-1, 0, 10, 25, 55, 98, start - 1, end - 1, end])) {
        const r = dividerPadAdjust({ ...pads(start, end, total), start, end, dividerIndex: di, dividerH: SEC })
        const renderedSec = di >= start && di < end ? SEC : 0 // 线在窗内已随 DOM 渲染
        const sum = r.topPad + (end - start) * ROW + renderedSec + r.bottomPad
        expect(sum).toBeCloseTo(total * ROW + (di >= 0 ? SEC : 0), 6)
      }
    }
  })
})

describe('dividerRowShift：分节线的行位偏移（纯数学）', () => {
  it('线下行整体 +dividerH；线行自身与线上行不偏移；线缺席全零', () => {
    expect(dividerRowShift(20, 10, SEC)).toBe(SEC)
    expect(dividerRowShift(10, 10, SEC)).toBe(0) // 线挂在该行之后，行自身不动
    expect(dividerRowShift(0, 10, SEC)).toBe(0)
    expect(dividerRowShift(20, -1, SEC)).toBe(0)
    expect(dividerRowShift(20, 10, 0)).toBe(0)
  })

  it('行位连续：跨线行距 = rowH+secH，其余相邻行距 = rowH', () => {
    const y = (i) => i * ROW + dividerRowShift(i, 10, SEC)
    for (let i = 1; i <= 30; i++) {
      expect(y(i) - y(i - 1)).toBeCloseTo(i === 11 ? ROW + SEC : ROW, 6)
    }
  })
})

describe('WatchView 队列：.queue-sec 的滑窗归位（DOM 层）', () => {
  // 默认无滚动口（jsdom getClientRects=空）→ sc=null 走 viewport：
  // viewH=window.innerHeight=768 → end=min(N, ceil(768/55.5)+overscan12)=26

  it('线在窗内：.queue-sec 渲出，垫片不加补偿', async () => {
    const queue = songs(100)
    const w = mountQueue(queue, queue[5])
    await vi.waitFor(() => expect(w.vm.queueRows.length).toBe(26))
    expect(w.vm.queueSecIndex).toBe(5)
    expect(w.find('.queue-sec').exists()).toBe(true)
    expect(w.find('.queue-sec').text()).toContain('接下来 · 94 首')
    expect(spacerHeights(w)).toEqual(['0px', `${(100 - 26) * ROW}px`]) // 0 / 4107px
  })

  it('线在窗下沿之下：线不渲，bottomPad 吃进 fallback 28', async () => {
    const queue = songs(100)
    const w = mountQueue(queue, queue[60])
    await vi.waitFor(() => expect(w.vm.queueRows.length).toBe(26))
    expect(w.vm.queueSecIndex).toBe(60)
    expect(w.find('.queue-sec').exists()).toBe(false)
    expect(spacerHeights(w)).toEqual(['0px', `${(100 - 26) * ROW + SEC}px`]) // 4135px
  })

  it('线在窗上沿之上：线不渲，topPad 吃进 fallback 28', async () => {
    const queue = songs(100)
    const w = mountQueue(queue, queue[5])
    // 等挂载期 update + 立即档 tab watch 的 centerCurrentRow 落定再接管
    // 滚动——否则 centerCurrentRow 会把 scrollTop 拽回当前行
    await vi.waitFor(() => expect(w.vm.queueRows.length).toBe(26))
    await nextTick()
    const sc = w.find('#watch-panel-queue').element
    stubScrollport(sc)
    patchAnchorRect(w, sc)
    // scrollTop=1300 → first=floor(1300/55.5)=23 → start=23-12=11 > si=5
    await scrollTo(w, sc, 1300)
    expect(w.vm.queueStartIndex).toBe(11)
    expect(w.vm.queueSecIndex).toBe(5)
    expect(w.find('.queue-sec').exists()).toBe(false)
    // end = min(100, ceil((1300+600)/55.5)+12) = 47 → bottom=(100-47)*55.5
    expect(spacerHeights(w)).toEqual([`${11 * ROW + SEC}px`, `${(100 - 47) * ROW}px`]) // 638.5 / 2941.5
  })

  it('线缺席两态：当前曲不在队（ci=-1）与当前是末行（ci=total-1）都无线无补偿', async () => {
    const queue = songs(100)
    const w1 = mountQueue(queue, { id: 9999, name: '外', ar: [], al: {}, dt: 0 })
    await vi.waitFor(() => expect(w1.vm.queueRows.length).toBe(26))
    expect(w1.vm.queueSecIndex).toBe(-1)
    expect(w1.find('.queue-sec').exists()).toBe(false)
    expect(spacerHeights(w1)).toEqual(['0px', `${(100 - 26) * ROW}px`])

    const w2 = mountQueue(queue, queue[99])
    await vi.waitFor(() => expect(w2.vm.queueRows.length).toBe(26))
    expect(w2.vm.queueSecIndex).toBe(-1)
    expect(w2.find('.queue-sec').exists()).toBe(false)
    expect(spacerHeights(w2)).toEqual(['0px', `${(100 - 26) * ROW}px`])
  })

  it('实测线高覆盖 fallback：bindQueueSec 注入 40 后补偿吃 40', async () => {
    const queue = songs(100)
    const w = mountQueue(queue, queue[60]) // si=60 在窗下 → bottomPad+secH
    await vi.waitFor(() => expect(w.vm.queueRows.length).toBe(26))
    expect(w.vm.queueSecH).toBe(28) // jsdom offsetHeight=0 → fallback
    w.vm.bindQueueSec({ offsetHeight: 40 })
    await nextTick()
    expect(spacerHeights(w)).toEqual(['0px', `${(100 - 26) * ROW + 40}px`]) // 4147px
  })

  it('scrollToIndex/ensureVisible 落点含 sec：线下行 +secH、线上行不加、nearest 已在视口不滚', async () => {
    const queue = songs(100)
    const w = mountQueue(queue, queue[10]) // si=10
    await vi.waitFor(() => expect(w.vm.queueRows.length).toBe(26))
    await nextTick()
    const sc = w.find('#watch-panel-queue').element
    stubScrollport(sc) // viewH=600
    patchAnchorRect(w, sc)
    await scrollTo(w, sc, 0)
    // align:'start' —— 行 50 在线之下：50*55.5+28 = 2803
    w.vm.queueScrollToIndex(50, { align: 'start' })
    expect(sc.scrollTop).toBe(2803)
    // 行 5 在线之上：5*55.5 = 277.5，不加 secH
    w.vm.queueScrollToIndex(5, { align: 'start' })
    expect(sc.scrollTop).toBe(277.5)
    // nearest（ensureVisible 同路径）：行 30 在视口下沿之外 → 压到行底沿
    // rowY=30*55.5+28=1693 → y=1693+55.5-600=1148.5
    w.vm.queueScrollToIndex(30, { align: 'nearest' })
    expect(sc.scrollTop).toBe(1148.5)
    // 行 30 现在恰充满视口 [1148.5, 1748.5] —— 再 ensureVisible 不动
    w.vm.queueScrollToIndex(30, { align: 'nearest' })
    expect(sc.scrollTop).toBe(1148.5)
    // align:'center'：行 50 → 2803-(600-55.5)/2 = 2530.75
    w.vm.queueScrollToIndex(50, { align: 'center' })
    expect(sc.scrollTop).toBe(2530.75)
  })
})

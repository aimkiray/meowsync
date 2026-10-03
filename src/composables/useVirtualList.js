import { computed, ref, watch, watchEffect } from 'vue'

// ── 纯窗数学（导出供无 DOM 测试）：视口行区间 ±overscan、钳入 [0,total]、
// pin 行并入窗口；topPad/bottomPad 由调用方 start*rowH / (total-end)*rowH 算
export const computeVirtualWindow = ({ scrollTop, listTop, viewH, rowH, total, overscan, pin = null }) => {
  const first = Math.max(0, Math.floor((scrollTop - listTop) / rowH))
  const last = Math.min(total, Math.ceil((scrollTop + viewH - listTop) / rowH))
  // 深越界钳制：源塌缩（隐藏VIP/清空队列）而 scrollTop 还停在旧深度时
  // first 可远超 total——start 若越出列表，空窗+虚 topPad 会让 scrollHeight
  // 虚高、浏览器逐帧回爬 ~overscan 行/帧形成长抖。start 钳进 [0,total-1]、
  // end 保底 start+1（total>0 永渲至少一行），一帧收敛到末行附近
  let start = Math.min(Math.max(0, first - overscan), Math.max(0, total - 1))
  let end = Math.min(total, Math.max(last + overscan, start + 1))
  if (pin != null && pin >= 0 && pin < total) {
    start = Math.min(start, pin)
    end = Math.max(end, pin + 1)
  }
  return { start, end }
}

// 真虚拟滚动：滑窗渲染原语——usePagedList 的「前缀窗无上界」补集。
// 前缀窗消的是首屏摊销，但滚到底时 DOM 与全量同构（万曲单=万行+万封面
// img）。本原语渲染 viewport±overscan 的有界窗，上下用等高空洞 spacer
// 撑起真实 scrollHeight——DOM 恒定 ~viewport 量级，滚动位置/index 语义
// 照旧精确（行高均匀时 y=i*rowH 是纯算术）。
//
// 适用判定（不满足请留 usePagedList 前缀分页）：
//   - 行高均匀（border-box 固定值；±1px 内的边框差由 overscan 吸收）
//   - 单列纵向列表（多列卡片格请走行切片，本原语不建模）
//   - source 全量在内存（与 usePagedList 同前提）
//
// 消费者要接的三件事：模板 spacer 对（:style height）、序号加 startIndex、
// ensureRendered→ensureVisible/scrollToIndex 语义切换（不再物化目标行，
// 直接改 scrollTop 让窗滑过去）。
//
// 滚动根：scrollRoots 返回候选数组——breakpoint 会换真滚动器（如 watch 页
// 侧栏 ≥901px 内滚、<901px 整页滚），每帧 update 重新挑「此刻实际会滚的」
// 不用 matchMedia；全不命中退化 viewport。listTop 每帧实测（anchor spacer
// 的 getBoundingClientRect）——列表上方内容（英雄区/表头/队列头）怎么变
// 都自校准，不用簿记。
export function useVirtualList({
  source,               // Ref<Array>：全量源（裸数组会静默渲空）
  rowHeight,            // number：行 border-box 均匀高（px）
  overscan = 8,         // 视口两侧各多渲行数——滚动一帧的容错+焦点行存活域
  scrollRoots = null,   // () => (Element|null)[] —— 滚动器候选（按优先序）；
                        // 空数组/全不命中 → viewport
  pinIndex = null,      // Ref<number|null>：强制留在窗内的行号（拖拽中行
                        // 滚出窗会丢 --dragging 节点断手势）
  resetWhen = null,     // () => key —— 身份变化才回卷（同 usePagedList 口径）
} = {}) {
  const startIndex = ref(0)
  const endIndex = ref(0)
  let anchorEl = null

  const total = computed(() => source?.value?.length || 0)

  const rows = computed(() => (source?.value || []).slice(startIndex.value, endIndex.value))
  const topPad = computed(() => startIndex.value * rowHeight)
  const bottomPad = computed(() => Math.max(0, (total.value - endIndex.value) * rowHeight))

  // 挑「此刻实际会滚的」滚动根：样式可滚且内容真溢出者优先；内容还短
  // （装不满）时首个可滚样式即唯一会滚的；全不命中 → null 走 viewport。
  // getClientRects 可见性闸：display:none 元素 computed overflowY 仍
  // 报 auto（v-show 隐态面板会被误选——scrollTop 写读全哑、viewH=0
  // 窗退化成顶部几行，且隐藏期的 scrollToIndex 会静默写丢）
  const pickScroller = () => {
    const els = (scrollRoots?.() || []).filter(Boolean)
    for (const el of els) {
      if (!el.getClientRects().length) continue
      const oy = getComputedStyle(el).overflowY
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) return el
    }
    for (const el of els) {
      if (!el.getClientRects().length) continue
      const oy = getComputedStyle(el).overflowY
      if (oy === 'auto' || oy === 'scroll') return el
    }
    return null
  }

  // anchor（顶 spacer）在滚动器坐标系里的 y——列表上沿位置，上方任何
  // 前置内容的高度都折进这个实测值，无需单独建模
  const listTopOf = (sc) => {
    if (!anchorEl || !anchorEl.isConnected) return 0
    if (sc) return anchorEl.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop
    return anchorEl.getBoundingClientRect().top + window.scrollY
  }

  const update = () => {
    const sc = pickScroller()
    const w = computeVirtualWindow({
      scrollTop: sc ? sc.scrollTop : window.scrollY,
      viewH: sc ? sc.clientHeight : window.innerHeight,
      listTop: listTopOf(sc),
      rowH: rowHeight,
      total: total.value,
      overscan,
      pin: pinIndex?.value ?? null,
    })
    // 不变不赋值——滚动事件的 60Hz 热路径别触发无谓依赖通知
    if (w.start !== startIndex.value) startIndex.value = w.start
    if (w.end !== endIndex.value) endIndex.value = w.end
  }

  const scrollToIndex = (i, { align = 'nearest' } = {}) => {
    // 越界下标静默不滚——currentQueueIndex=-1（曲不在队）/清空瞬间的调用方
    // 不该被拽到列表外；锚未挂载时 listTop=0 会把落点算到列表上方去
    if (!Number.isFinite(i) || i < 0 || i >= total.value) return
    if (!anchorEl || !anchorEl.isConnected) return
    const sc = pickScroller()
    const viewH = sc ? sc.clientHeight : window.innerHeight
    const listTop = listTopOf(sc)
    const cur = sc ? sc.scrollTop : window.scrollY
    const rowY = listTop + i * rowHeight
    let y
    if (align === 'center') {
      y = rowY - (viewH - rowHeight) / 2
    } else if (align === 'start') {
      y = rowY
    } else {
      // nearest：已在视口内不动；上偏抬到行顶，下偏压到行底沿
      if (rowY >= cur && rowY + rowHeight <= cur + viewH) return
      y = rowY < cur ? rowY : rowY + rowHeight - viewH
    }
    if (sc) sc.scrollTop = y
    else window.scrollTo(0, y)
    // 同步重算窗：下一拍 Vue flush 时行已物化——深跳/还位不会闪空白
    update()
  }

  const ensureVisible = (i) => scrollToIndex(i, { align: 'nearest' })

  // 顶 spacer 锚 ref——模板 :ref="vl.bindAnchor"。元素迟挂（v-else 分支
  // 晚于 setup 挂载）时 bind 当下即补一帧窗算
  const bindAnchor = (el) => {
    anchorEl = el
    if (el) update()
  }

  const reset = () => {
    // 注意多根语义：所有候选根一并归零（含整页滚候选）——多根消费方
    // 若只要「当前真滚动器」回卷，应自行挑根而非直接用本函数
    for (const el of (scrollRoots?.() || []).filter(Boolean)) el.scrollTop = 0
    startIndex.value = 0
    update()
  }

  // 滚动器/尺寸/可见性变化的统一归口：候选元素集合变化（迟挂 ref 落地/
  // v-if 分支切换）由 watchEffect 依赖跟踪自动重绑；ResizeObserver 接
  // breakpoint 翻转与 v-show 显隐（display:none→block 会触发 RO）。
  // 首帧窗算走 microtask——update() 同步跑会把 total/pinIndex 读进
  // watchEffect 依赖，源每动一次就重绑一轮监听
  watchEffect((onCleanup) => {
    const els = (scrollRoots?.() || []).filter(Boolean)
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null
    for (const el of els) {
      el.addEventListener('scroll', update, { passive: true })
      ro?.observe(el)
    }
    window.addEventListener('resize', update)
    queueMicrotask(update)
    onCleanup(() => {
      for (const el of els) el.removeEventListener('scroll', update)
      ro?.disconnect()
      window.removeEventListener('resize', update)
    })
  })

  // 源长度塌缩/增长重算（VIP 过滤/队列抽行会让 bottomPad 收缩，
  // 浏览器钳 scrollTop 后的 scroll 事件也会兜——这里先把窗对齐）
  watch(() => total.value, update)
  // pin 起落（拖拽开始/结束）主动重算——上条同因不能靠 watchEffect 顺路
  if (pinIndex) watch(pinIndex, update)

  if (resetWhen) {
    watch(resetWhen, () => reset())
  }

  return {
    rows, startIndex, topPad, bottomPad,
    bindAnchor, scrollToIndex, ensureVisible, update, reset,
  }
}

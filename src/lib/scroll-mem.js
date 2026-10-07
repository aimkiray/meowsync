// 会话级滚动记忆：主区视图切换是 v-if 整页卸载（无 KeepAlive），scrollTop
// 与前缀渲染窗全灭——各滚动器卸载前按键快照，重挂时先物化回原窗深再还位。
// 键须含数据身份（歌单 id 等）防旧列表位置错配新内容；会话态不落 LS，
// 刷新从头是预期
const mem = new Map()
const MEM_CAP = 60 // 键含身份会随浏览增长——FIFO 封顶

export const writeScrollMem = (key, entry) => {
  mem.delete(key) // 重插提鲜：淘汰按插入序
  mem.set(key, entry)
  if (mem.size > MEM_CAP) mem.delete(mem.keys().next().value)
}

export const readScrollMem = (key) => mem.get(key) ?? null

// 键盘滚动键集：还位等待窗内这些按键滚动同样算用户显式意图——
// 只盯 wheel/touch 会漏掉键盘用户（PageUp/Down、方向键、Home/End、空格），
// 还位落笔会跟他抢滚动
const SCROLL_INTENT_KEYS = new Set([
  'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '
])

// 还位滚动：内容异步灌入时 scrollHeight 尚未长够，直接写 scrollTop 会被
// 钳 0——轮询到内容够高再落笔；已够高立即写（同步列表零等待）。等待窗内
// 用户先动滚轮/手指/键盘滚动键 = 显式意图，放弃还位不抢滚动。返回取消
// 函数——调用方在 onBeforeUnmount 调用，避免等待窗内卸载后 interval 对
// 游离节点空转
export const restoreScrollTop = (el, top, { timeoutMs = 2500 } = {}) => {
  let iv = null
  let fallbackTimer = null
  // 键盘滚动的目标不一定是 el 本身（焦点在子元素/文档上也滚得动它）——
  // 监听挂到 window 层；非滚动键不结算，所以不能 once，done 时摘除
  const view = el?.ownerDocument?.defaultView
    || (typeof window !== 'undefined' ? window : null)
  // 可编辑目标内的按键不算滚动意图——输入框/文本域里的空格与方向键是
  // 文本编辑行为，误杀还位会让视图在用户打字时抢滚
  const onKeydown = (e) => {
    if (e.target?.closest?.('input,textarea,select,[contenteditable]')) return
    if (SCROLL_INTENT_KEYS.has(e.key)) done()
  }
  const done = () => {
    if (iv) clearInterval(iv)
    iv = null
    // 兜底超时也要随取消清掉——否则卸载后 timer 仍持有游离元素直到自燃
    if (fallbackTimer) clearTimeout(fallbackTimer)
    fallbackTimer = null
    el?.removeEventListener('wheel', done)
    el?.removeEventListener('touchstart', done)
    view?.removeEventListener('keydown', onKeydown)
  }
  if (!el || !(top > 0)) return done
  const enough = () => el.scrollHeight >= top + el.clientHeight - 4
  if (enough()) { el.scrollTop = top; return done }
  el.addEventListener('wheel', done, { once: true, passive: true })
  el.addEventListener('touchstart', done, { once: true, passive: true })
  view?.addEventListener('keydown', onKeydown)
  iv = setInterval(() => {
    if (enough()) { el.scrollTop = top; done() }
  }, 120)
  fallbackTimer = setTimeout(done, timeoutMs)
  return done
}

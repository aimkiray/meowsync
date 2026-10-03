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

// 还位滚动：内容异步灌入时 scrollHeight 尚未长够，直接写 scrollTop 会被
// 钳 0——轮询到内容够高再落笔；已够高立即写（同步列表零等待）。等待窗内
// 用户先动滚轮/手指 = 显式意图，放弃还位不抢滚动。返回取消函数——调用方
// 在 onBeforeUnmount 调用，避免等待窗内卸载后 interval 对游离节点空转
export const restoreScrollTop = (el, top, { timeoutMs = 2500 } = {}) => {
  const done = () => {
    if (iv) clearInterval(iv)
    iv = null
    el?.removeEventListener('wheel', done)
    el?.removeEventListener('touchstart', done)
  }
  let iv = null
  if (!el || !(top > 0)) return done
  const enough = () => el.scrollHeight >= top + el.clientHeight - 4
  if (enough()) { el.scrollTop = top; return done }
  el.addEventListener('wheel', done, { once: true, passive: true })
  el.addEventListener('touchstart', done, { once: true, passive: true })
  iv = setInterval(() => {
    if (enough()) { el.scrollTop = top; done() }
  }, 120)
  setTimeout(done, timeoutMs)
  return done
}

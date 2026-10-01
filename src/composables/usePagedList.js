import { computed, ref, watch, nextTick, onBeforeUnmount } from 'vue'

// 统一分页原语：前缀渲染窗。source 全量已在内存，分页的本质是「渲染窗」——
// slice(0, renderedCount) 前缀增长，消 vnode/DOM/封面请求摊销，对序号、
// id 键控、播放快照零侵入（rendered index 恒等于全局 index）。
//
// 刻意不做 server 模式：本仓第一个真实服务端翻页场景（搜索深挖）要求父级
// 持有结果数组当播放队列——数组所有权不在 composable 里的场景请勿套用本形。
//
// 哨兵纪律：IntersectionObserver 自动扩窗，但哨兵行本身必须是可聚焦的
// 「加载更多」按钮（键盘可达；无 IO 环境兜底）——模板里：
//   <button v-if="pg.hasMore" :ref="pg.bindSentinel" @click="pg.loadMore()">
// IO root 传内层滚动器（() => el）；该元素必须是哨兵的裁剪祖先
// （有真实可滚溢出），否则自动退化 viewport——不传也是 viewport。
// 契约：source 必须是 Ref/computed；pageSize>0；须在 setup 同步栈内调用。
export function usePagedList({
  source,               // Ref<Array>：全量源（裸数组会静默渲空）
  pageSize = 150,
  resetWhen = null,     // () => key —— 身份变化（歌单id/搜索词）才回卷，
                        // 不 watch 数组引用（轮询/静默同步换引用不该踢滚动位置）
  scrollRoot = null,    // () => Element | null —— 复位置顶 + IO root
} = {}) {
  const renderedCount = ref(pageSize)

  let observer = null
  let sentinelEl = null

  const rows = computed(() => (source?.value || []).slice(0, renderedCount.value))

  const hasMore = computed(() => renderedCount.value < (source?.value?.length || 0))

  const loadMore = () => {
    if (hasMore.value) renderedCount.value += pageSize
  }

  // 「跳到当前曲」等场景前置：扩窗至物化目标行再 scrollIntoView
  const ensureRendered = (globalIndex) => {
    if (globalIndex >= renderedCount.value) {
      renderedCount.value = globalIndex + 1
    }
  }

  const reset = () => {
    renderedCount.value = pageSize
    const root = scrollRoot?.()
    if (root) root.scrollTop = 0
  }

  // 哨兵行 ref 回调——模板 :ref="pg.bindSentinel"。
  // nextTick 再建 IO：父容器 ref（scrollRoot 的目标）在 Vue 的挂载序里
  // 晚于子元素 ref 回调——同步建会拿到 null 退化成 viewport root
  const bindSentinel = (el) => {
    sentinelEl = el
    observer?.disconnect()
    observer = null
    if (!el || typeof IntersectionObserver === 'undefined') return
    nextTick(() => {
      if (sentinelEl !== el) return // 已卸载/换绑
      // scrollRoot 必须是哨兵的「裁剪祖先」才有效：窄屏等布局里容器
      // max-height:none 随内容生长（scrollHeight==clientHeight 不裁剪），
      // 用它当 root 会让哨兵矩形恒在 root 矩形内 → 恒相交 → 级联渲完全部。
      // 检测到非裁剪容器即退化 viewport（相交仍被 overflow 链正确裁算）
      const root = scrollRoot?.()
      const clips = root && root.scrollHeight > root.clientHeight
      observer = new IntersectionObserver((entries) => {
        if (entries.some(e => e.isIntersecting)) loadMore()
      }, { root: clips ? root : null, rootMargin: '400px 0px' })
      observer.observe(el)
    })
  }

  if (resetWhen) {
    watch(resetWhen, () => reset())
  }

  onBeforeUnmount(() => observer?.disconnect())

  return {
    rows, hasMore, renderedCount,
    loadMore, ensureRendered, reset, bindSentinel,
  }
}

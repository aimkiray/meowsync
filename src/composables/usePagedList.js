import { computed, ref, watch, onBeforeUnmount } from 'vue'

// 统一分页原语：数据层只关心「可见多少行」，表现层只负责放哨兵行。
//
// 两种数据源：
//   client（本项目主形态）——source: Ref<Array>，全量已在内存，分页的本质是
//     「渲染窗」：slice(0, renderedCount) 前缀增长，消 vnode/DOM/封面请求摊销。
//     语义上对序号、id 键控、播放快照零侵入。
//   server（预留协议）——fetchPage({offset,limit,signal}) →
//     {items, total?, hasMore?}，供给未来搜索深挖/tasks 分页。
//
// 哨兵纪律：IntersectionObserver 自动扩窗，但哨兵行本身必须是可聚焦的
// 「加载更多」按钮（键盘可达；无 IO 环境兜底）——模板里 :
//   <button v-if="pg.hasMore" :ref="pg.bindSentinel" @click="pg.loadMore()">
// IO root 传内层滚动器（() => el），不传退 viewport。
export function usePagedList({
  source = null,          // Ref<Array>：client 模式
  fetchPage = null,       // ({offset,limit,signal}) => Promise<{items,total?,hasMore?}>：server 模式
  pageSize = 150,
  resetWhen = null,       // () => key —— 身份变化（歌单id/搜索词）才回卷，
                          // 不 watch 数组引用（silent 同步换引用不该踢滚动位置）
  scrollRoot = null,      // () => Element | null —— 复位置顶 + IO root
  keyOf = (it) => it?.id, // server 模式翻页间上游漂移重叠行去重
} = {}) {
  const renderedCount = ref(pageSize)
  const items = ref([])          // server 模式累积行
  const total = ref(null)        // server 模式上游总数（有则可算页数）
  const serverHasMore = ref(null)
  const loading = ref(false)
  const error = ref(null)

  let seq = 0                    // 序号守卫：慢响应不盖新页（全站惯例）
  let controller = null          // server 模式在途请求
  let observer = null
  let sentinelEl = null

  const isServer = typeof fetchPage === 'function'

  const rows = computed(() => isServer
    ? items.value
    : (source?.value || []).slice(0, renderedCount.value))

  const hasMore = computed(() => {
    if (!isServer) return renderedCount.value < (source?.value?.length || 0)
    if (serverHasMore.value != null) return serverHasMore.value
    if (total.value != null) return items.value.length < total.value
    // 无 total/hasMore 时按「末页满员即可能还有」试探
    return items.value.length > 0 && items.value.length % pageSize === 0
  })

  const fetchServerPage = async () => {
    const mySeq = ++seq
    controller?.abort()
    controller = new AbortController()
    loading.value = true
    error.value = null
    try {
      const out = await fetchPage({
        offset: items.value.length,
        limit: pageSize,
        signal: controller.signal,
      })
      if (mySeq !== seq) return // 已被 reset/新请求顶替
      const seen = new Set(items.value.map(keyOf))
      for (const it of out.items || []) {
        const k = keyOf(it)
        if (k == null || !seen.has(k)) { seen.add(k); items.value.push(it) }
      }
      if (out.total != null) total.value = out.total
      if (out.hasMore != null) serverHasMore.value = out.hasMore
    } catch (e) {
      if (e?.name === 'AbortError' || mySeq !== seq) return
      error.value = e
    } finally {
      if (mySeq === seq) loading.value = false
    }
  }

  const loadMore = () => {
    if (isServer) {
      if (!loading.value) fetchServerPage()
    } else if (hasMore.value) {
      renderedCount.value += pageSize
    }
  }

  // 「跳到当前曲」等场景前置：扩窗至物化目标行再 scrollIntoView
  const ensureRendered = (globalIndex) => {
    if (!isServer && globalIndex >= renderedCount.value) {
      renderedCount.value = globalIndex + 1
    }
  }

  const reset = () => {
    seq++
    controller?.abort()
    controller = null
    renderedCount.value = pageSize
    if (isServer) {
      items.value = []
      total.value = null
      serverHasMore.value = null
      fetchServerPage()
    }
    const root = scrollRoot?.()
    if (root) root.scrollTop = 0
  }

  // 哨兵行 ref 回调——模板 :ref="pg.bindSentinel"
  const bindSentinel = (el) => {
    sentinelEl = el
    observer?.disconnect()
    observer = null
    if (!el || typeof IntersectionObserver === 'undefined') return
    observer = new IntersectionObserver((entries) => {
      if (entries.some(e => e.isIntersecting)) loadMore()
    }, { root: scrollRoot?.() || null, rootMargin: '400px 0px' })
    observer.observe(el)
  }

  if (resetWhen) {
    watch(resetWhen, () => reset())
  }
  if (isServer) fetchServerPage()

  onBeforeUnmount(() => {
    observer?.disconnect()
    controller?.abort()
  })

  return {
    rows, hasMore, loading, error,
    renderedCount, total,
    loadMore, ensureRendered, reset, bindSentinel,
  }
}

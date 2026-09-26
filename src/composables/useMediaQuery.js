import { ref, onMounted, onUnmounted } from 'vue'

/** 响应式媒体查询（默认 '(max-width: 768px)'，即移动端断点） */
export function useMediaQuery(query = '(max-width: 768px)') {
  const matches = ref(false)
  let mql = null

  const update = (e) => {
    matches.value = e ? e.matches : mql.matches
  }

  onMounted(() => {
    mql = window.matchMedia(query)
    update()
    mql.addEventListener('change', update)
  })

  onUnmounted(() => {
    mql?.removeEventListener('change', update)
  })

  return matches
}

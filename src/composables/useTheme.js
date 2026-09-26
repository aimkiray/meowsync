import { ref, onMounted, onUnmounted } from 'vue'

/**
 * 监听 <html data-theme> 的响应式主题名（'pixel-retro' | 'default'）。
 * 实际切换逻辑在 TopNavigation，这里只做只读跟踪。
 */
export function useTheme() {
  const currentTheme = ref('default')

  const detectTheme = () => {
    currentTheme.value =
      document.documentElement.getAttribute('data-theme') === 'pixel-retro'
        ? 'pixel-retro'
        : 'default'
  }

  const observer = new MutationObserver(detectTheme)

  onMounted(() => {
    detectTheme()
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    })
  })

  onUnmounted(() => {
    observer.disconnect()
  })

  return { currentTheme }
}

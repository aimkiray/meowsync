<template>
  <nav class="pt-2">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="jirai-card py-6">
        <div class="flex justify-between items-center">
          <div class="flex-1 px-2"></div>
          <div class="flex items-center justify-center flex-1">
            <h1 class="jirai-title flex items-center text-2xl md:text-2xl lg:text-2xl font-bold">
              MeowSync
            </h1>
          </div>
          <div class="flex-1 flex justify-end px-2">
            <button 
              @click="toggleTheme"
              class="pixel-button theme-toggle-btn"
              :title="currentTheme === 'pixel-retro' ? '切换到默认主题' : '切换到像素风格'"
            >
              <!-- 默认主题图标 -->
              <svg v-if="currentTheme === 'pixel-retro'" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
                <path fill="currentColor" d="M6 2h8v2h-2v2h-2V4H6zM4 6V4h2v2zm0 10H2V6h2zm2 2H4v-2h2zm2 2H6v-2h2zm10 0v2H8v-2zm2-2v2h-2v-2zm-2-4h2v4h2v-8h-2v2h-2zm-6 0v2h6v-2zm-2-2h2v2h-2zm0 0V6H8v6z"/>
              </svg>
              <!-- 像素主题图标 -->
              <svg v-else xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
                <path fill="currentColor" d="M17 10v4h-1v1h-1v1h-1v1h-4v-1H9v-1H8v-1H7v-4h1V9h1V8h1V7h4v1h1v1h1v1z"/><path fill="currentColor" d="M21 11v-1h1V9h1V7h-3V6h-2V4h-1V1h-2v1h-1v1h-1v1h-2V3h-1V2H9V1H7v3H6v2H4v1H1v2h1v1h1v1h1v2H3v1H2v1H1v2h3v1h2v2h1v3h2v-1h1v-1h1v-1h2v1h1v1h1v1h2v-3h1v-2h2v-1h3v-2h-1v-1h-1v-1h-1v-2zm-3 4h-1v1h-1v1h-1v1H9v-1H8v-1H7v-1H6V9h1V8h1V7h1V6h6v1h1v1h1v1h1z"/>
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  </nav>
</template>

<script>
import { ref, onMounted } from 'vue'

export default {
  name: 'TopNavigation',
  setup() {
    const currentTheme = ref('pixel-retro')
    
    // 从localStorage加载主题
    const loadTheme = () => {
      const savedTheme = localStorage.getItem('pixel-theme') || 'pixel-retro'
      currentTheme.value = savedTheme
      applyTheme(savedTheme)
    }
    
    // 应用主题
    const applyTheme = (theme) => {
      const root = document.documentElement
      if (theme === 'pixel-retro') {
        root.setAttribute('data-theme', 'pixel-retro')
      } else {
        root.removeAttribute('data-theme')
      }
    }
    
    // 切换主题
    const toggleTheme = () => {
      const newTheme = currentTheme.value === 'default' ? 'pixel-retro' : 'default'
      currentTheme.value = newTheme
      localStorage.setItem('pixel-theme', newTheme)
      applyTheme(newTheme)
    }
    
    onMounted(() => {
      loadTheme()
    })
    
    return {
      currentTheme,
      toggleTheme
    }
  }
}
</script>
<template>
  <nav class="pt-2">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="jirai-card py-6">
        <div class="flex justify-between items-center">
          <div class="flex-1"></div>
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
              {{ currentTheme === 'pixel-retro' ? '🌙' : '🎨' }}
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
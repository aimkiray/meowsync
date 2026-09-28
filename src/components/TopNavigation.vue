<template>
  <nav class="topnav">
    <div class="topnav-inner">
      <!-- 移动端：汉堡键呼出歌单库抽屉 -->
      <button
        class="pixel-button topnav-hamburger lg:hidden"
        @click="$emit('toggle-sidebar')"
        :aria-expanded="sidebarOpen"
        aria-label="歌单库"
        title="打开歌单库"
      >☰</button>

      <h1 class="jirai-title topnav-title">MeowSync</h1>

      <!-- YTM 式居中搜索：歌单名 / 歌单ID / 分享URL 三合一 -->
      <div class="topnav-search">
        <input
          :value="searchQuery"
          @input="$emit('update:searchQuery', $event.target.value)"
          @keyup.enter="onSearchEnter"
          type="text"
          placeholder="搜索歌单或粘贴歌单ID/链接"
          class="pixel-input topnav-search-input"
        />
        <button
          @click="handleSearch"
          class="pixel-button topnav-search-btn"
          :disabled="!searchQuery.trim()"
        >{{ extractPlaylistId(searchQuery.trim()) ? '添加' : '搜索' }}</button>
      </div>

      <div class="topnav-actions">
        <!-- 管理页面入口 -->
        <button
          v-if="remoteMode === 'off'"
          @click="$emit('toggle-center-view')"
          class="pixel-button topnav-action"
          :title="isDownloadsView ? '返回歌曲列表' : '打开下载管理'"
        >{{ isDownloadsView ? '🎵 歌曲' : '⚙️ 管理' }}</button>

        <!-- 远程控制模式指示 -->
        <a
          v-if="remoteMode === 'host'"
          :href="controllerUrl"
          target="_blank"
          rel="noopener"
          class="pixel-button topnav-action"
          title="在新标签页打开手机控制器"
        >📱 控制器</a>
        <span
          v-else-if="remoteMode === 'off'"
          class="topnav-remote-hint"
          title="添加 ?mode=host 启用远程控制"
        >远程:关</span>
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
            <path fill="currentColor" d="M17 10v4h-1v1h-1v1h-1v1h-4v-1H9v-1H8v-1H7v-4h1V9h1V8h1V7h4v1h1v1h1v1z"/><path fill="currentColor" d="M21 11v-1h1V9h1V7h-3V6h-2V4h-1V1h-2v1h-1v1h-1v1h-2V3h-1V2H9V1H7v3H6v2H4v1H1v2h1v1h1v1h1v2H3v1H2v1H1v2h3v1h2v2h1v3h2v-1h1v-1h1v-1h2v1h1v1h1v1h2v-3h1v-2h2v-1h3v-2h-1v-1h-1v-1h-1v-2zm-3 4h-1v1h-1v1h-1v1H9v-1H8v-1H7v-1H6V9h1V8h1V7h4v1h1v1h1v1h1z"/>
          </svg>
        </button>
      </div>
    </div>
  </nav>
</template>

<script>
import { ref, onMounted } from 'vue'

export default {
  name: 'TopNavigation',
  props: {
    isDownloadsView: {
      type: Boolean,
      default: false
    },
    searchQuery: {
      type: String,
      default: ''
    },
    sidebarOpen: {
      type: Boolean,
      default: false
    }
  },
  emits: ['toggle-center-view', 'toggle-sidebar', 'search', 'search-by-id', 'update:searchQuery'],
  setup(props, { emit }) {
    const currentTheme = ref('pixel-retro')
    const urlParams = new URLSearchParams(window.location.search)
    const rawMode = urlParams.get('mode')
    const remoteMode = ref(['host', 'controller'].includes(rawMode) ? rawMode : 'off')
    const controllerUrl = window.location.origin + window.location.pathname + '?mode=controller'

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

    // 从URL或文本中提取歌单ID：网易云 ?id= / 本站分享链 ?playlist(s)=|?song= / 纯数字
    const extractPlaylistId = (input) => {
      const urlMatch = input.match(/[?&](?:id|playlist|playlists|song)=(\d+)/)
      if (urlMatch) return urlMatch[1]
      if (/^\d+$/.test(input.trim())) return input.trim()
      return null
    }

    // 搜索或直接按ID/URL加载歌单
    const handleSearch = () => {
      const query = props.searchQuery.trim()
      if (!query) return
      const playlistId = extractPlaylistId(query)
      emit(playlistId ? 'search-by-id' : 'search', playlistId || query)
    }

    // IME 合成中（拼音选词）按 Enter 不应触发搜索
    const onSearchEnter = (e) => {
      if (e.isComposing || e.keyCode === 229) return
      handleSearch()
    }

    onMounted(() => {
      loadTheme()
    })

    return {
      currentTheme,
      toggleTheme,
      remoteMode,
      controllerUrl,
      extractPlaylistId,
      handleSearch,
      onSearchEnter
    }
  }
}
</script>

<style scoped>
/* 细顶栏：一行高度，无卡片包装（YTM 式） */
.topnav {
  flex-shrink: 0;
  padding: 0 12px;
  border-bottom: 2px solid rgba(240, 179, 192, 0.25);
  background: rgba(20, 16, 28, 0.72);
  backdrop-filter: blur(8px);
}

:root[data-theme="pixel-retro"] .topnav {
  border-bottom-color: rgba(210, 100, 130, 0.5);
  background: rgba(240, 179, 192, 0.28);
}

.topnav-inner {
  max-width: 1440px;
  margin: 0 auto;
  height: 52px;
  display: flex;
  align-items: center;
  gap: 12px;
}

.topnav-hamburger {
  padding: 4px 10px;
  font-size: 16px;
  flex-shrink: 0;
}

.topnav-title {
  font-size: 18px;
  font-weight: bold;
  white-space: nowrap;
  flex-shrink: 0;
}

.topnav-search {
  flex: 1;
  display: flex;
  justify-content: center;
  gap: 6px;
  min-width: 0;
}

.topnav-search-input {
  width: min(480px, 100%);
  height: 34px;
  padding: 0 10px;
  font-size: 13px;
}

.topnav-search-btn {
  height: 34px;
  padding: 0 14px;
  font-size: 12px;
  flex-shrink: 0;
}

.topnav-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.topnav-action {
  font-size: 12px;
  padding: 4px 8px;
}

.topnav-remote-hint {
  font-size: 11px;
  opacity: 0.5;
  cursor: default;
  white-space: nowrap;
}

/* 窄屏：标题让位给搜索框（移动端搜索仍是主入口） */
@media (max-width: 640px) {
  .topnav-title {
    display: none;
  }
  .topnav-remote-hint {
    display: none;
  }
}
</style>

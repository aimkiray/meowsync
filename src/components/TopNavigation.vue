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

      <!-- YTM 式居中搜索：歌单名 / 歌单ID / 分享URL 三合一 + 输入建议 -->
      <div class="topnav-search">
        <div class="topnav-search-field">
          <input
            ref="searchInput"
            :value="searchQuery"
            @input="onInput"
            @keydown="onKeydown"
            @focus="onSearchFocus"
            @blur="onSearchBlur"
            type="text"
            placeholder="搜索歌曲、歌单，或粘贴ID/链接"
            class="pixel-input topnav-search-input"
            autocomplete="off"
            spellcheck="false"
            role="combobox"
            aria-autocomplete="list"
            :aria-expanded="suggestOpen && suggestions.length > 0"
            :aria-activedescendant="activeIndex >= 0 ? `suggest-item-${activeIndex}` : undefined"
            aria-controls="topnav-suggest-list"
          />
          <button
            v-if="searchQuery"
            class="topnav-search-clear"
            title="清除"
            @mousedown.prevent="clearQuery"
          >✕</button>
          <!-- typeahead 下拉：搜索建议（文本+实体名），↑↓ 可选 -->
          <div v-if="suggestOpen && suggestions.length" class="topnav-suggest" id="topnav-suggest-list" role="listbox">
            <div
              v-for="(item, i) in suggestions"
              :key="`${i}-${item.label}`"
              :id="`suggest-item-${i}`"
              class="topnav-suggest-item"
              :class="{ 'topnav-suggest-item--active': i === activeIndex }"
              role="option"
              :aria-selected="i === activeIndex"
              @mousedown.prevent="pickSuggestion(item)"
              @mousemove="activeIndex = i"
            >
              <span class="topnav-suggest-icon">{{ item.icon }}</span>
              <span class="topnav-suggest-text">{{ item.label }}</span>
              <span v-if="item.kindText" class="topnav-suggest-kind">{{ item.kindText }}</span>
            </div>
          </div>
        </div>
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
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { musicApi } from '../api/music.js'

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
      // 提交即废弃建议——否则在途 fetch 回包会把已关的下拉重新顶开遮挡结果
      cancelSuggest()
      suggestions.value = []
      suggestOpen.value = false
      const playlistId = extractPlaylistId(query)
      emit(playlistId ? 'search-by-id' : 'search', playlistId || query)
    }

    // ── 搜索建议（YTM typeahead） ──
    const searchInput = ref(null)
    const suggestions = ref([])
    const suggestOpen = ref(false)
    const activeIndex = ref(-1)
    let suggestTimer = null
    let suggestAbort = null
    let suggestSeq = 0

    // 各实体组的标签与图标；allMatch 文本建议置顶
    const SUGGEST_KINDS = [
      ['songs', '歌曲', '🎵', 'name'],
      ['artists', '艺人', '🎤', 'name'],
      ['albums', '专辑', '💿', 'name'],
      ['playlists', '歌单', '📻', 'name']
    ]

    const mapSuggestions = (result) => {
      const items = []
      if (Array.isArray(result?.allMatch)) {
        for (const m of result.allMatch.slice(0, 6)) {
          if (m?.keyword) items.push({ label: m.keyword, icon: '🔍', kindText: '' })
        }
      }
      for (const [key, kindText, icon, field] of SUGGEST_KINDS) {
        if (!Array.isArray(result?.[key])) continue
        for (const e of result[key].slice(0, 3)) {
          const label = e?.[field]
          if (label && !items.some(it => it.label === label)) {
            items.push({ label, icon, kindText })
          }
        }
      }
      return items.slice(0, 8)
    }

    // 建议取消闸：清定时器 + 断在途请求 + 序号+1——
    // clear/submit/ID输入后，在途响应不得再把下拉弹回来
    const cancelSuggest = () => {
      clearTimeout(suggestTimer)
      suggestAbort?.abort()
      suggestAbort = null
      suggestSeq++
      activeIndex.value = -1
    }

    const fetchSuggestions = async (query) => {
      suggestAbort?.abort()
      const seq = ++suggestSeq
      const ctrl = new AbortController()
      suggestAbort = ctrl
      try {
        const result = await musicApi.searchSuggest(query, ctrl.signal)
        if (seq !== suggestSeq) return
        suggestions.value = mapSuggestions(result)
        activeIndex.value = -1
        suggestOpen.value = suggestions.value.length > 0
      } catch {
        if (seq === suggestSeq) suggestions.value = []
      }
    }

    const onInput = (e) => {
      emit('update:searchQuery', e.target.value)
      const q = e.target.value.trim()
      cancelSuggest()
      // 纯数字/链接走"添加歌单"路径，不弹建议
      if (!q || extractPlaylistId(q)) {
        suggestions.value = []
        suggestOpen.value = false
        return
      }
      suggestTimer = setTimeout(() => fetchSuggestions(q), 250)
    }

    const onSearchFocus = () => {
      if (suggestions.value.length) suggestOpen.value = true
    }

    // blur 延迟由 @mousedown.prevent 承担——mousedown 先于 blur 且不转移焦点
    const onSearchBlur = () => {
      suggestOpen.value = false
      cancelSuggest() // 在途请求回包不得重开下拉
    }

    const pickSuggestion = (item) => {
      cancelSuggest()
      suggestions.value = []
      suggestOpen.value = false
      emit('update:searchQuery', item.label)
      emit('search', item.label)
    }

    const clearQuery = () => {
      cancelSuggest()
      emit('update:searchQuery', '')
      suggestions.value = []
      suggestOpen.value = false
      searchInput.value?.focus()
    }

    const focusSearch = () => searchInput.value?.focus()

    // IME 合成中（拼音选词）按 Enter 不应触发搜索
    const onSearchEnter = (e) => {
      if (e.isComposing || e.keyCode === 229) return
      cancelSuggest()
      suggestOpen.value = false
      handleSearch()
    }

    // combobox 键盘交互：↓↑ 在建议间移动，Enter 选中或搜索，Esc 关下拉
    const onKeydown = (e) => {
      if (suggestOpen.value && suggestions.value.length) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          activeIndex.value = (activeIndex.value + 1) % suggestions.value.length
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          activeIndex.value = (activeIndex.value - 1 + suggestions.value.length) % suggestions.value.length
          return
        }
        if (e.key === 'Enter' && activeIndex.value >= 0 && suggestions.value[activeIndex.value]) {
          e.preventDefault()
          pickSuggestion(suggestions.value[activeIndex.value])
          return
        }
      }
      if (e.key === 'Enter') onSearchEnter(e)
      else if (e.key === 'Escape') {
        suggestOpen.value = false
        activeIndex.value = -1
      }
    }

    onMounted(() => {
      loadTheme()
    })

    onBeforeUnmount(() => {
      clearTimeout(suggestTimer)
      suggestAbort?.abort()
    })

    return {
      currentTheme,
      toggleTheme,
      remoteMode,
      controllerUrl,
      extractPlaylistId,
      handleSearch,
      onKeydown,
      activeIndex,
      searchInput,
      suggestions,
      suggestOpen,
      onInput,
      onSearchFocus,
      onSearchBlur,
      pickSuggestion,
      clearQuery,
      focusSearch
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

/* 输入框 + 清除键 + 建议下拉的定位容器 */
.topnav-search-field {
  position: relative;
  width: min(480px, 100%);
}

.topnav-search-input {
  width: 100%;
  height: 34px;
  padding: 0 32px 0 10px;
  font-size: 13px;
}

.topnav-search-clear {
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 12px;
  padding: 2px 6px;
  color: var(--pixel-text-dim);
  background: transparent;
  border: none;
  cursor: pointer;
}

.topnav-search-clear:hover {
  color: var(--pixel-text);
}

/* typeahead 下拉 */
.topnav-suggest {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: var(--z-menu);
  background: #1a1a2e;
  border: 1px solid #c084fc;
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.45);
  overflow: hidden;
}

:root[data-theme="pixel-retro"] .topnav-suggest {
  background: #fff7f8;
  border-color: #d26482;
  box-shadow: 4px 4px 0 rgba(210, 100, 130, 0.3);
}

.topnav-suggest-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  cursor: pointer;
  font-size: 12px;
  color: #e9d5ff;
}

.topnav-suggest-item:hover,
.topnav-suggest-item--active {
  background: rgba(236, 72, 153, 0.18);
}

:root[data-theme="pixel-retro"] .topnav-suggest-item {
  color: #831843;
}

.topnav-suggest-icon {
  flex-shrink: 0;
  font-size: 12px;
}

.topnav-suggest-text {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.topnav-suggest-kind {
  flex-shrink: 0;
  font-size: 10px;
  opacity: 0.6;
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

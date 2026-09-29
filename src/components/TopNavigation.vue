<template>
  <nav class="topnav">
    <div class="topnav-inner">
      <!-- 移动端：汉堡键呼出歌单库抽屉 -->
      <button
        class="pg-icobtn pg-icobtn--bare topnav-hamburger lg:hidden"
        @click="$emit('toggle-sidebar')"
        :aria-expanded="sidebarOpen"
        aria-label="歌单库"
        title="打开歌单库"
      ><PixelIcon name="menu" :size="15" /></button>

      <h1 class="topnav-title"><GlitchText text="MeowSync" /></h1>

      <!-- 居中搜索：歌单名 / 歌单ID / 分享URL 三合一 + 输入建议 -->
      <div class="topnav-search">
        <div class="pg-field topnav-search-field">
          <PixelIcon name="search" :size="14" class="topnav-search-icon" />
          <input
            ref="searchInput"
            :value="searchQuery"
            @input="onInput"
            @keydown="onKeydown"
            @focus="onSearchFocus"
            @blur="onSearchBlur"
            type="text"
            placeholder="搜索歌曲、歌单，或粘贴ID/链接"
            class="topnav-search-input"
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
            aria-label="清除搜索"
            @mousedown.prevent="clearQuery"
          ><PixelIcon name="close" :size="12" /></button>
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
              <span class="topnav-suggest-text">{{ item.label }}</span>
              <span v-if="item.kindText" class="topnav-suggest-kind">{{ item.kindText }}</span>
            </div>
          </div>
        </div>
        <button
          @click="handleSearch"
          class="ink-btn topnav-search-btn"
          :disabled="!searchQuery.trim()"
        >{{ extractPlaylistId(searchQuery.trim()) ? '添加' : '搜索' }}</button>
      </div>

      <div class="topnav-actions">
        <!-- 管理页面入口 -->
        <button
          v-if="remoteMode === 'off'"
          @click="$emit('toggle-center-view')"
          class="pg-link topnav-action"
          :title="isDownloadsView ? '返回歌曲列表' : '打开下载管理'"
        >{{ isDownloadsView ? '歌曲' : '管理' }}</button>

        <!-- 远程控制模式指示 -->
        <a
          v-if="remoteMode === 'host'"
          :href="controllerUrl"
          target="_blank"
          rel="noopener"
          class="pg-link topnav-action"
          title="在新标签页打开手机控制器"
        >控制器</a>
        <span
          v-else-if="remoteMode === 'off'"
          class="pg-label pg-label--dim topnav-remote-hint"
          title="添加 ?mode=host 启用远程控制"
        >remote: off</span>

        <!-- 主题切换：lang-pill 滑动胶囊（三段态 = radio index），注册表见 lib/theme.js -->
        <div class="theme-pill topnav-theme" role="radiogroup" aria-label="切换主题" :title="`主题：${themeLabel}`">
          <span class="theme-pill-glider" :style="{ transform: `translateX(${themeIndex * 100}%)` }" aria-hidden="true"></span>
          <label
            v-for="t in THEMES" :key="t.id"
            class="theme-pill-tab"
            :class="{ 'theme-pill-tab--on': t.id === currentTheme }"
          ><input
            type="radio" class="theme-pill-radio" name="ms-theme"
            :value="t.id" :checked="t.id === currentTheme"
            @change="setTheme(t.id)"
          ><span>{{ t.pill }}</span></label>
        </div>
      </div>
    </div>
  </nav>
</template>

<script>
import { ref, computed, onBeforeUnmount } from 'vue'
import { musicApi } from '../api/music.js'
import { THEMES, currentTheme, setTheme } from '../lib/theme.js'
import PixelIcon from './PixelIcon.vue'
import GlitchText from './GlitchText.vue'

export default {
  name: 'TopNavigation',
  components: { PixelIcon, GlitchText },
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
    },
    remoteMode: {
      type: String,
      default: 'off'
    }
  },
  emits: ['toggle-center-view', 'toggle-sidebar', 'search', 'search-by-id', 'update:searchQuery'],
  setup(props, { emit }) {
    const controllerUrl = window.location.origin + window.location.pathname + '?mode=controller'
    const themeLabel = computed(() => THEMES.find(t => t.id === currentTheme.value)?.label || currentTheme.value)

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

    // 各实体组的标签（纯文本——印刷稿里图标让位给字排）
    const SUGGEST_KINDS = [
      ['songs', '歌曲', 'name'],
      ['artists', '艺人', 'name'],
      ['albums', '专辑', 'name'],
      ['playlists', '歌单', 'name']
    ]

    const mapSuggestions = (result) => {
      const items = []
      if (Array.isArray(result?.allMatch)) {
        for (const m of result.allMatch.slice(0, 6)) {
          if (m?.keyword) items.push({ label: m.keyword, kindText: '' })
        }
      }
      for (const [key, kindText, field] of SUGGEST_KINDS) {
        if (!Array.isArray(result?.[key])) continue
        for (const e of result[key].slice(0, 3)) {
          const label = e?.[field]
          if (label && !items.some(it => it.label === label)) {
            items.push({ label, kindText })
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

    onBeforeUnmount(() => {
      clearTimeout(suggestTimer)
      suggestAbort?.abort()
    })

    const themeIndex = computed(() => Math.max(0, THEMES.findIndex(t => t.id === currentTheme.value)))

    return {
      controllerUrl,
      themeLabel,
      themeIndex,
      THEMES,
      currentTheme,
      setTheme,
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
/* 纸面 masthead：一行高度 + 墨色发丝下缘 */
.topnav {
  flex-shrink: 0;
  padding: 0 16px;
  border-bottom: var(--hairline);
  background: var(--paper);
}

.topnav-inner {
  max-width: 1440px;
  margin: 0 auto;
  height: 56px;
  display: flex;
  align-items: center;
  gap: 16px;
}

.topnav-hamburger {
  flex-shrink: 0;
}

.topnav-title {
  font-family: var(--font-display);
  font-size: 20px;
  font-weight: 700;
  letter-spacing: .01em;
  color: var(--ink);
  white-space: nowrap;
  flex-shrink: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.topnav-search {
  flex: 1;
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

/* 输入框 + 图标 + 清除键 + 建议下拉的定位容器 */
.topnav-search-field {
  position: relative;
  width: min(480px, 100%);
}

.topnav-search-icon {
  margin-left: 10px;
  color: var(--ink-64);
  pointer-events: none;
}

.topnav-search-input {
  width: 100%;
  padding: 0 30px 0 8px;
  font-size: 13px;
}

.topnav-search-clear {
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 12px;
  padding: 2px 6px;
  color: var(--ink-86);
  background: transparent;
  border: none;
  cursor: pointer;
  transition: color .2s;
}

.topnav-search-clear:hover { color: var(--ink); }

/* typeahead 下拉：纸面发丝盒（pg-menu 同族，绝对定位版） */
.topnav-suggest {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: var(--z-menu);
  background: var(--paper);
  border: var(--hairline);
  overflow: hidden;
}

.topnav-suggest-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  cursor: pointer;
  font-size: 12px;
  color: var(--ink);
  border-bottom: var(--hairline-soft);
}
.topnav-suggest-item:last-child { border-bottom: none; }

.topnav-suggest-item:hover,
.topnav-suggest-item--active {
  background: var(--ink-06);
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
  font-family: var(--font-mono);
  font-weight: 300;
  font-size: 10px;
  letter-spacing: .05em;
  color: var(--ink-64);
  border: var(--hairline);
  padding: 1px 6px;
}

.topnav-search-btn {
  height: 36px;
  flex-shrink: 0;
}

.topnav-actions {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-shrink: 0;
}

.topnav-action {
  font-size: 13px;
  font-weight: 500;
}

.topnav-remote-hint {
  cursor: default;
  white-space: nowrap;
}

/* 窄屏：标题让位给搜索框（移动端搜索仍是主入口） */
@media (max-width: 640px) {
  .topnav { padding: 0 12px; }
  .topnav-title { display: none; }
  .topnav-remote-hint { display: none; }
  .topnav-theme { display: none; }
}
</style>

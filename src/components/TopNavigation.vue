<template>
  <nav class="topnav">
    <div class="topnav-inner">
      <div class="topnav-left">
        <!-- 移动端：汉堡键呼出歌单库抽屉（lg:hidden 死声明——pg-icobtn 的
             display 在 utilities 层后同特异度胜出，隐藏须走 scoped media） -->
        <button
          class="pg-icobtn pg-icobtn--bare topnav-hamburger"
          @click="$emit('toggle-sidebar')"
          :aria-expanded="sidebarOpen"
          aria-label="歌单库"
          title="打开歌单库"
        ><PixelIcon name="menu" :size="18" /></button>

        <h1 class="topnav-title">
          <button class="topnav-home" @click="$emit('nav-home')" title="回到首页" aria-label="回到首页">
            <GlitchText text="MeowSync" />
          </button>
        </h1>
      </div>

      <!-- 居中搜索：歌单名 / 歌单ID / 分享URL 三合一 + 输入建议 -->
      <div class="topnav-search">
        <div class="pg-field topnav-search-field">
          <PixelIcon name="search" :size="16" class="topnav-search-icon" />
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
          ><PixelIcon name="close" :size="14" /></button>
          <!-- YTM：提交收进框内右缘（歌单名/ID/链接三合一由 handler 分流） -->
          <button
            class="topnav-search-go"
            :disabled="!searchQuery.trim()"
            title="搜索 / 按ID打开歌单"
            aria-label="搜索"
            @click="handleSearch"
          ><PixelIcon name="chev-r" :size="16" /></button>
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
      </div>

      <div class="topnav-actions">
        <!-- 右簇全量收进单个 ⋯ 菜单：下载/控制器/主题/退出——顶栏只留
             一个触发键；菜单走 pg-menu 族（PlaylistPanel 同口径：
             pointerdown 外关、Esc 焦点归还、fixed 翻上兜底）。
             顺带解开 640px 以下主题胶囊被隐藏后无处可切的死角 -->
        <button
          ref="menuBtn"
          class="pg-icobtn pg-icobtn--bare topnav-menu-btn"
          title="菜单"
          aria-label="打开菜单"
          aria-haspopup="menu"
          :aria-expanded="menuOpen"
          aria-controls="topnav-menu"
          @click="toggleMenu"
        ><PixelIcon name="kebab" :size="18" /></button>

        <Teleport to="body">
          <div
            v-if="menuOpen"
            id="topnav-menu"
            class="pg-menu topnav-menu"
            role="menu"
            aria-label="导航菜单"
            :style="menuPos"
          >
            <!-- 下载页入口（与 toast「查看进度」/歌单菜单「下载进度」同视图）；
                 host 模式藏入口但深链仍可切进来——downloads 视图下保留「返回」逃生 -->
            <button
              v-if="remoteMode === 'off' || isDownloadsView"
              class="pg-menu-item" role="menuitem"
              @click="pickCenterView"
            >{{ isDownloadsView ? '返回' : '下载' }}</button>
            <!-- 设置页入口：AI/凭据服务端配置 + 本机偏好集中面；
                 视图内再点变「返回」（与下载入口同型往返） -->
            <button
              class="pg-menu-item" role="menuitem"
              @click="pickSettings"
            >{{ isSettingsView ? '返回' : '设置' }}</button>
            <a
              v-if="remoteMode === 'host'"
              class="pg-menu-item" role="menuitem"
              :href="controllerUrl" target="_blank" rel="noopener"
              title="在新标签页打开手机控制器"
              @click="closeMenu()"
              @auxclick="closeMenu()"
            >控制器</a>
            <div
              v-else-if="remoteMode === 'off'"
              class="pg-menu-head topnav-menu-remote"
              role="presentation"
              title="添加 ?mode=host 启用远程控制"
            >remote: off</div>

            <div role="group" aria-label="主题">
              <div class="pg-menu-head" role="presentation">主题</div>
              <button
                v-for="t in THEMES" :key="t.id"
                class="pg-menu-item"
                role="menuitemradio"
                :aria-checked="t.id === currentTheme"
                @click="pickTheme(t.id)"
              ><span class="topnav-theme-check" aria-hidden="true"><PixelIcon
                v-if="t.id === currentTheme" name="check" :size="12"
              /></span>{{ t.name }}</button>
            </div>

            <button
              v-if="authState.enabled && authState.authenticated"
              class="pg-menu-item" role="menuitem"
              @click="pickLogout"
            >退出登录</button>
          </div>
        </Teleport>
      </div>
    </div>
  </nav>
</template>

<script>
import { ref, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { musicApi } from '../api/music.js'
import { isBilibiliInput, isYouTubeInput, isQQInput, extractQQPlaylistId, extractBiliFavlistId, extractYouTubePlaylistId, isSongmidLike, extractNeteaseSongId } from '../lib/url.js'
import { THEMES, currentTheme, setTheme } from '../lib/theme.js'
import { authState } from '../lib/auth-state.js'
import { authApi } from '../api/auth.js'
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
    },
    isSettingsView: {
      type: Boolean,
      default: false
    }
  },
  emits: ['toggle-center-view', 'toggle-sidebar', 'nav-home', 'open-settings', 'search', 'search-by-id', 'search-song', 'search-bili', 'search-yt', 'search-qq', 'search-qq-pl', 'search-qq-songs', 'update:searchQuery'],
  setup(props, { emit }) {
    const controllerUrl = window.location.origin + window.location.pathname + '?mode=controller'

    // 从URL或文本中提取歌单ID：网易云 ?id= / 本站歌单分享链 ?playlist(s)= / 纯数字。
    // 不收 song=——那是本站单曲分享参数（SongList/WatchView 生成 ?song=<id>&view=watch），
    // 收进来会把单曲链错当歌单去预览
    const extractPlaylistId = (input) => {
      const urlMatch = input.match(/[?&](?:id|playlist|playlists)=(\d+)/)
      if (urlMatch) return urlMatch[1]
      if (/^\d+$/.test(input.trim())) return input.trim()
      return null
    }

    // B 站输入识别先收口到 lib/url（点歌框与顶栏同一条判定，防两处漂移）
    // 搜索或直接按ID/URL加载歌单
    const handleSearch = () => {
      const query = props.searchQuery.trim()
      if (!query) return
      // 提交即废弃建议——否则在途 fetch 回包会把已关的下拉重新顶开遮挡结果
      cancelSuggest()
      suggestions.value = []
      suggestOpen.value = false
      // B 站收藏夹链接先于视频判定——favlist/medialist URL 也含 bilibili.com，
      // 顺序错了会被单曲导入抢走再被服务端弹回
      if (extractBiliFavlistId(query)) {
        emit('search-bili', query) // 载荷原样透传——App 层 importBilibiliOrFav 再分单曲/收藏夹
        return
      }
      if (isBilibiliInput(query)) {
        emit('search-bili', query)
        return
      }
      // YouTube 歌单链先于单曲判定——watch?v=&list= 复合链的歌单语境
      // 更具体（载荷原样透传，App 层 importYouTubeOrPlaylist 再分单曲/歌单）
      if (extractYouTubePlaylistId(query)) {
        emit('search-yt', query)
        return
      }
      if (isYouTubeInput(query)) {
        emit('search-yt', query)
        return
      }
      // QQ 歌单链接先于单曲/网易云判定——taoge.html?id=N 的 ?id= 会被
      // extractPlaylistId 当网易云歌单 id 抢走
      const qqPlaylistId = extractQQPlaylistId(query)
      if (qqPlaylistId) {
        emit('search-qq-pl', qqPlaylistId)
        return
      }
      if (isQQInput(query)) {
        emit('search-qq', query)
        return
      }
      // qq: 前缀=QQ 语法（与点歌台同记号）：mid 形态/链接走 resolve 直解，
      // 其余关键词走 QQ 曲库搜索（结果落顶部搜索的 songs 结果区）
      if (/^qq[:：]\s*$/i.test(query)) return
      const qqPref = query.match(/^qq[:：](.+)$/i)
      if (qqPref) {
        const kw = qqPref[1].trim()
        if (!kw) return
        const qqPlInPref = extractQQPlaylistId(kw)
        if (qqPlInPref) {
          emit('search-qq-pl', qqPlInPref)
          return
        }
        if (isQQInput(kw) || isSongmidLike(kw)) {
          emit('search-qq', isQQInput(kw) ? kw : `qq:${kw}`)
          return
        }
        emit('search-qq-songs', kw)
        return
      }
      // 单曲链接先于歌单 id 提取——music.163.com/song?id=N 的 ?id= 会撞
      // extractPlaylistId 的歌单兜底；裸数字仍按歌单惯例走（限含 song 的输入）
      if (/song/i.test(query)) {
        const songId = extractNeteaseSongId(query)
        if (songId) {
          emit('search-song', songId)
          return
        }
      }
      const playlistId = extractPlaylistId(query)
      emit(playlistId ? 'search-by-id' : 'search', playlistId || query, query)
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
      // 纯数字/歌单链接/B站（视频与收藏夹）/YouTube（视频与歌单）/QQ 输入走直达路径，不弹建议
      if (!q || extractPlaylistId(q) || isBilibiliInput(q) || isYouTubeInput(q)
        || isQQInput(q) || extractQQPlaylistId(q) || extractBiliFavlistId(q)
        || extractYouTubePlaylistId(q) || /^qq[:：]/i.test(q)) {
        suggestions.value = []
        suggestOpen.value = false
        return
      }
      suggestTimer = setTimeout(() => fetchSuggestions(q), 250)
    }

    const onSearchFocus = () => {
      closeMenu() // 「/」快捷键开着菜单聚焦搜索：建议下拉会与菜单同窗叠盖
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
        // aria-activedescendant 语义要求激活项可见——下拉限高内滚后须跟随滚动
        const scrollActiveIntoView = () => {
          nextTick(() => {
            document.getElementById(`suggest-item-${activeIndex.value}`)?.scrollIntoView({ block: 'nearest' })
          })
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          activeIndex.value = (activeIndex.value + 1) % suggestions.value.length
          scrollActiveIntoView()
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          activeIndex.value = (activeIndex.value - 1 + suggestions.value.length) % suggestions.value.length
          scrollActiveIntoView()
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

    // ── 右簇 ⋯ 菜单 ──
    const menuBtn = ref(null)
    const menuOpen = ref(false)
    const menuPos = ref({})

    const toggleMenu = () => {
      if (menuOpen.value) { closeMenu(); return }
      const rect = menuBtn.value?.getBoundingClientRect?.()
      if (!rect) return
      // 菜单高按可见行数估（item≈39/head≈36）：下方放不下翻到上方
      const rows = (props.remoteMode === 'off' || props.isDownloadsView ? 1 : 0)
        + 1 // 设置项恒在
        + (props.remoteMode === 'host' || props.remoteMode === 'off' ? 1 : 0)
        + 1 + THEMES.length
        + (authState.enabled && authState.authenticated ? 1 : 0)
      const h = rows * 39 + 8
      menuPos.value = {
        top: (rect.bottom + 4 + h <= window.innerHeight
          ? rect.bottom + 4 : Math.max(8, rect.top - h - 4)) + 'px',
        // 右缘对齐触发键右缘——菜单从顶栏右簇向左展开
        right: Math.max(8, window.innerWidth - rect.right) + 'px'
      }
      menuOpen.value = true
      // 菜单 teleport 到 body 末尾——不主动移焦，键盘 Tab 会穿进菜单底下
      // 的页面内容；开菜单即聚焦第一项（.pg-menu-item 均真实 button/a，
      // 编程聚焦在鼠标点击后不出 :focus-visible 环，鼠标用户无感）
      nextTick(() => document.querySelector('#topnav-menu .pg-menu-item')?.focus())
    }

    const closeMenu = (restoreFocus = false) => {
      const was = menuOpen.value
      menuOpen.value = false
      if (restoreFocus && was) menuBtn.value?.focus({ preventScroll: true })
    }

    const pickCenterView = () => { emit('toggle-center-view'); closeMenu() }
    const pickSettings = () => { emit('open-settings'); closeMenu() }
    // 主题切换没有「下一跳」接管焦点——与 Esc 同为解散语义，归还触发键
    const pickTheme = (id) => { setTheme(id); closeMenu(true) }
    const pickLogout = () => { closeMenu(); logout() }

    // pointerdown 先于 click 且不受 @click.stop 影响——豁免菜单本体与触发键
    const onDocPointerDown = (e) => {
      if (!(e.target instanceof Element)) return
      if (!e.target.closest('.topnav-menu, .topnav-menu-btn')) closeMenu()
    }
    // Esc 解散菜单；焦点归还仅在焦点还在菜单/触发键内时进行——
    // 用户已把焦点挪去搜索框等别处时不得强拽（/ 快捷键开着菜单聚焦
    // 搜索的场景，Esc 关菜单不应夺走输入焦点）
    const onMenuKeydown = (e) => {
      if (e.key !== 'Escape' || !menuOpen.value) return
      const ae = document.activeElement
      closeMenu(ae === menuBtn.value || !!ae?.closest?.('#topnav-menu'))
    }

    // 直传 closeMenu 会把 Event 对象塞进 restoreFocus 形参（真事件源→真值
    // →resize 时强拽焦点）——必须包箭头，同 PlaylistPanel closeOnScroll 注释坑
    const onResizeClose = () => closeMenu()

    onMounted(() => {
      document.addEventListener('pointerdown', onDocPointerDown)
      document.addEventListener('keydown', onMenuKeydown)
      // ≥1472 时 inner 居中、触发键距右缘随视口漂移；resize 菜单位置即过期
      window.addEventListener('resize', onResizeClose)
    })
    onBeforeUnmount(() => {
      clearTimeout(suggestTimer)
      suggestAbort?.abort()
      document.removeEventListener('pointerdown', onDocPointerDown)
      document.removeEventListener('keydown', onMenuKeydown)
      window.removeEventListener('resize', onResizeClose)
    })

    // 登出：作废服务端 session 后整页重载（与登录成功同一收束路径）。
    // 网络失败时 HttpOnly cookie 前端删不掉——重载后 status 若仍认证会
    // 直接回应用（登出未生效），而非误以为已登出，这比重载进死门好
    const logout = async () => {
      try { await authApi.logout() } catch { /* 服务端登出可能未生效 */ }
      authState.authenticated = false
      window.location.reload()
    }

    return {
      controllerUrl,
      authState,
      THEMES,
      currentTheme,
      menuBtn,
      menuOpen,
      menuPos,
      toggleMenu,
      closeMenu,
      pickCenterView,
      pickSettings,
      pickTheme,
      pickLogout,
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
  /* 横屏刘海侧让位：viewport-fit=cover 下左缘 ~47px 死区 */
  padding: 0 max(16px, env(safe-area-inset-right, 0px)) 0 max(16px, env(safe-area-inset-left, 0px));
  border-bottom: var(--hairline);
  background: var(--paper);
}

/* 三栏 grid：左右各占 1fr，中栏 auto——搜索组锚定真中线，
   不再随右簇宽度漂移（旧 flex:1 居中的是"剩余空间"不是整栏）。
   侧列不设 min-width:0：列宽下限=内容 min-content，空间不足时
   中列先收缩（字段 max-width:100%），侧簇永不溢出侵入中列 */
.topnav-inner {
  /* 与底栏内列/player-inner 同帽同轴（style.css 注释：顶栏内列同轴消费） */
  max-width: var(--content-max, 1440px);
  margin: 0 auto;
  height: 56px;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 16px;
}

/* ≥1024：搜索框左缘钉死在内容列左缘（=侧栏 280 + 主区 padding 20），
   全视图同位——顶栏是跨视图锚，切进 watch（无侧栏）搜索位置不许跳。
   左列吃"内容缘 − gap − 顶栏 pad"的定宽，中列改 minmax(0,480) 让字段贴列左缘。
   定宽轨代价：左簇若增肥超定宽会溢出侵入中列（fr/auto 轨的 min-content
   防侵承诺对定宽轨不成立）——当前左簇 ~186px，裕量充足但改簇时记着。
   顶栏 padding 16 只在 inner 未达 1440 上限时把 inner 推离 app-body 左缘，
   故列宽分两档：<1472 扣 16，≥1472（inner 居中后与 app-body 同缘）不扣。
   窄轨(768-1023)侧栏 64 + padding 20 = 84 目标缘 < 左簇 min-content(~186)，
   对齐必然重叠 logo——窄轨维持居中搜索。 */
@media (min-width: 1024px) {
  .topnav-inner {
    /* 268 = 侧栏 280 + 页缘 pad 20 − 顶栏外槽 16 − gap 16 → 搜索左缘钉 300 */
    grid-template-columns: 268px minmax(0, 480px) 1fr;
  }
}
@media (min-width: 1472px) {
  .topnav-inner {
    /* 284 = 同式减外槽——≥1472 inner 居中，外槽 16 被 1440 帽抵进两侧 margin */
    grid-template-columns: 284px minmax(0, 480px) 1fr;
  }
}

.topnav-left {
  display: flex;
  align-items: center;
  gap: 16px;
}

.topnav-hamburger {
  flex-shrink: 0;
}
/* ≥lg 侧栏是常驻静态列，抽屉键退场——不能用 lg:hidden：
   .pg-icobtn{display:inline-flex} 在 utilities 层后同特异度后序胜出 */
@media (min-width: 1024px) {
  .topnav-hamburger { display: none; }
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

/* 标题即回首页键：剥掉 button UA 皮，只吃排版继承 */
.topnav-home {
  font: inherit;
  letter-spacing: inherit;
  color: inherit;
  background: none;
  border: 0;
  padding: 0;
  cursor: pointer;
  transition: color .5s var(--ease-ink);
}
.topnav-home:hover { color: var(--accent-magenta-ink); } /* 文字键 hover = accent 字色 */

.topnav-search {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

/* 输入框 + 图标 + 清除键 + 建议下拉的定位容器 */
.topnav-search-field {
  position: relative;
  width: 480px;
  max-width: 100%; /* 大于可用中列时收缩；width:min() 的 % 与 auto 列宽循环依赖会塌成 input 固有宽 */
}

.topnav-search-icon {
  margin-left: 10px;
  color: var(--ink-64);
  pointer-events: none;
}

.topnav-search-input {
  width: 100%;
  /* 右侧两枚内嵌键都要让位：go（在流 26+6）贴框右缘，clear 再往左挪——
     文本区须收在 clear 左缘之外（输入右缘 go−32 + clear 占位 26 + 4 余隙） */
  padding: 0 36px 0 8px;
  font-size: 13px;
}

.topnav-search-clear {
  position: absolute;
  /* 坐进 go 左侧（go 在流占右 6..32）：绝对定位的 clear 若也贴右缘
     会整枚压在 go 上——有字时 ✕ 把 › 遮得不可见不可点 */
  right: 38px;
  top: 50%;
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
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
  /* 8 条建议 ~300px + 窄屏双行顶栏 ~93px——手机横屏会顶出视口底缘，
     限高内滚兜底 */
  max-height: calc(100vh - var(--topnav-h, 57.2px) - 8px);
  max-height: calc(100dvh - var(--topnav-h, 57.2px) - 8px);
  overflow-y: auto;
}

.topnav-suggest-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px; /* 与 pg-menu-item 同档 */
  cursor: pointer;
  font-size: 12px;
  color: var(--ink);
  border-bottom: var(--hairline-soft);
  transition: background .12s;
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

/* 框内提交键：与清除键同族裸字，禁用态降淡 */
.topnav-search-go {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  margin-right: 6px;
  flex-shrink: 0;
  color: var(--ink);
  background: none;
  border: 0;
  cursor: pointer;
}
.topnav-search-go:disabled { color: var(--ink-64); cursor: default; }
.topnav-search-go:hover:not(:disabled) { color: var(--accent-magenta-ink); }

.topnav-actions {
  display: flex;
  align-items: center;
  gap: 14px;
  justify-self: end; /* grid 右列贴右缘 */
}

/* ⋯ 菜单：fixed 定位由 :style 给出（右缘对齐触发键）；
   remote 提示沿用 pg-menu-head 的 mono 小字档 */
.topnav-menu-remote { cursor: default; }

/* 主题组与后续项的分隔：组内末项命中 .pg-menu-item:last-child 无底线，
   组后还有项时由组级发丝线补上（无后续项则不画，末缘不叠双线） */
.topnav-menu [role="group"]:not(:last-child) {
  border-bottom: var(--hairline-soft);
}

/* 主题 radio 项：check 槽定宽对齐，选中态 accent 色 */
.topnav-theme-check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  color: var(--accent-magenta-ink);
}

/* 窄屏两行布局：一行塞不下"导航+搜索+动作"——
   row1 = 汉堡+标题(home入口) | 动作簇，row2 = 搜索占满整行 */
@media (max-width: 768px) {
  .topnav-inner {
    grid-template-columns: 1fr auto;
    grid-template-areas:
      "left actions"
      "search search";
    height: auto;
    padding: 8px 0;
    row-gap: 8px;
  }
  .topnav-left { grid-area: left; }
  .topnav-actions { grid-area: actions; }
  .topnav-search { grid-area: search; }
  .topnav-search-field { flex: 1; width: auto; }
}

@media (max-width: 640.98px) {
  .topnav { padding: 0 12px; }
}
</style>

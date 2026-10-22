# 主页 HomeFeed 优雅化重构 — 可执行技术规格（cto-flow v1.3.0）

- **目标分支**：`feature/download-manager`
- **涉及仓库文件**：
  1. `src/components/HomeFeed.vue`
  2. `src/App.vue`
  3. `src/style.css`
  4. `src/components/PlaylistPanel.vue`
  5. `src/components/GlitchText.vue`
  6. `src/components/PrintMarks.vue`
  7. `tests/ui/feed-downloads-ui.spec.mjs`
  8. `tests/ui/playlist-panel.spec.mjs`
  9. `tests/ui/glitch-text.spec.mjs`

---

## 0. 全局共享契约（Canonical Rules）

1. **`[canonical:左缘基准线]`**：主区 `.home-feed` 内所有一级区块（`.home-head`、`.home-section-head`、首列 `.home-songrow` 外框左缘、`.home-shelf` 首张 `.grid-card` 外框左缘）必须严格对齐同一内容左轴（桌面侧栏 280px 展开时 `x = 300px`，侧栏收起时 `x = var(--page-pad-x)`）；左侧栏 `.panel-label` 顶缘与主区 `.home-head .pg-label` 顶缘必须对齐全站首行顶轴（`y = var(--topnav-h) + 20px ≈ 77.2px`，`Δy = 0px`）。
2. **`[canonical:alt=""]`**：凡容器内紧邻已有同名可见标题（`song.name`、`pl.name`、`al.name`）的封面 `<img>`（含 `.home-songrow-cover`、歌单货架 `.grid-card-cover img`、专辑货架 `.grid-card-cover img`），一律设静态 `alt=""`，严禁把标题写入 `alt` 导致屏幕阅读器在同一可交互节点内双读。
3. **`[canonical:aria-current]`**：主页内命中当前播放上下文的条目——单曲行 `String(song.id) === String(currentSongId)`、歌单卡 `String(pl.id) === String(playingPlaylistId)`、专辑卡 `al.tracks.some(s => String(s.id) === String(currentSongId))`——必须同时挂状态类（`.home-songrow--playing` / `.grid-card--playing`）与 `:aria-current="... ? 'true' : undefined"`（未命中时传 `undefined` 不落属性）。
4. **`[canonical:零网络]`**：`HomeFeed` 的全部展示与动作（单曲网格、「随机漫游」洗牌起播、歌单货架及 `userPlaylists.slice(0, 8)` 空态回退、专辑货架去重与同 `al.key` 队列聚合）100% 由本地传入的 `recents` / `recentPlaylists` / `userPlaylists` 纯内存派生，组件内部严禁发起任何网络请求。

---

## 1. 动机（已实机诊断的 15 项缺陷）

1. **左轴 x=300/308/304 三段错位**：`.home-head` 与 `.home-section-head` 左缘在 `x=300`；`.home-songrow` 常态无边框且 `padding: 6px 8px`，导致视觉首件（封面）缩进至 `x=308`；`.home-shelf` 设 `padding: 4px 4px 8px` 而无负 margin 补偿，导致首张 `.grid-card` 左缘落在 `x=304`，违反 `[canonical:左缘基准线]`。
2. **左右栏首行 y 差 6px**：`PlaylistPanel.vue` 的 `.panel-head` 采用 `align-items: center`，右侧 `.panel-create-btn`（`--ctrl-h-sm: 32px` + `margin: 4px 0 6px` = 42px）把 30px 高的 `.panel-label`（`padding: 8px 12px 10px`）向下居中推了 `(42 - 30) / 2 = 6px`，致 `library 我的歌单` 标签顶缘 `y≈83` 与主区 `.home-head .pg-label` 顶缘 `y≈77` 错位 6px。
3. **货架右缘半卡硬裁切且无翻页控件**：`.home-shelf` 受限于 `.home-feed` 的 `padding: 0 var(--page-pad-x, 20px)`，横向溢出卡在距离视口右缘 20px 处被硬裁切，且 `.home-section-head` 右缘无 `[‹][›]` 翻页键，桌面鼠标用户横向滚动费力。
4. **`grid-card` 单行标题下方 ~18px 空洞**：`src/style.css` 中 `.grid-card-name` 硬写 `min-height: 2.7em` 强制占两行高度，导致单行歌单名/专辑名与下方 `.grid-card-meta` 之间出现约 18px 空白死区。
5. **单曲行大列宽下中部断裂**：`.home-songrow` 常态无外框，大视口下 `repeat(auto-fill, minmax(230px, 1fr))` 列宽拉长后，左侧封面/歌名与右侧行尾之间缺乏容器边界束缚，视觉中部断裂。
6. **来源 chip 黑框喧宾夺主**：每条 `.home-songrow` 行尾挂 `.pg-chip.pg-chip--static.home-src-tag`（1.2px 实墨框），12 个黑框在网格中抢夺视觉焦点，压过歌名本身。
7. **移动端 12 行单列霸屏**：`≤640px` 下 `.home-songs` 退化为单列 12 行纵向堆叠（高逾 640px），将下方歌单货架与专辑货架彻底挤出首屏。
8. **「发现音乐」与三个「最近播放」语义矛盾重复**：页头标榜 `discover / 发现音乐` 实则全为本地历史；下方三节副标题依次为「最近播放」「最近播放的歌单」「最近播放的专辑」，「最近播放」三连复读。
9. **桌面歌单货架与侧栏全量重复**：当 `sidebarOpen && ≥901px` 时左侧歌单库已展开常驻，主区歌单货架在同屏重复陈列；而当 `recentPlaylists` 为空时冷启动又无 `userPlaylists` 回退。
10. **伪专辑卡只播单曲**：专辑货架卡 `.grid-card-meta` 仅显示歌手名，未诚实交代其从本地历史单曲派生（`含《song.name》`）；且当 `recents` 内有多首同 `al.key` 曲目时，点击仍未聚合为该专辑曲目队列。
11. **主页对正在播放零反馈**：`HomeFeed` 未接收 `currentSongId` 与 `playingPlaylistId`，正在播放的单曲行、歌单卡、专辑卡无反白/角标，亦无 `aria-current`。
12. **单曲行缺收藏键、歌单卡缺直接播放键**：主页单曲行无行尾 `+`（`row-add-btn`）加入歌单入口；歌单卡封面无右下 `▶` 直接播放整单入口。
13. **`GlitchText` 高频跳「锟斤拷烫烫烫」视觉疲劳**：`HAN_POOL` 高权重塞入 `烫/屯/锟斤拷/锘` 等重度乱码汉字，且 `setInterval(tick, 1100)` 每 1.1s 持续腐蚀，页脚 `PrintMarks` 三行版本戳也套 `GlitchText` 持续跳动，引发视觉疲劳。
14. **照片封面强制 `pixelated` 锯齿**：`.home-songrow-cover` 与全局 `.grid-card-cover img` 均声明 `image-rendering: pixelated`，将 96px/320px 照片封面渲染出明显锯齿。
15. **货架卡 `alt=标题` 致屏幕阅读器双读**：歌单卡 `:alt="pl.name"`、专辑卡 `:alt="al.name"` 与紧邻的 `<h3 class="grid-card-name">` 文本完全重复，导致屏幕阅读器双读，违反 `[canonical:alt=""]`。

---

## 2. 逐文件改动清单（内容定位引文 + 验收标准）

### 2.1 `src/components/HomeFeed.vue`

#### 定位引文 A：页头与单曲网格模板
```html
    <header class="home-head">
      <p class="pg-label">discover</p>
      <h2 class="home-title" data-nosnippet><GlitchText text="发现音乐" /></h2>
    </header>
```
及
```html
    <section v-if="recents.length" class="home-section">
      <div class="home-section-head">
        <p class="pg-label">recent</p>
        <span class="home-section-sub">最近播放</span>
      </div>
      <div class="home-songs">
        <button
          v-for="song in visibleRecents"
          :key="song.id"
          type="button"
          class="home-songrow"
          :title="`${song.name} - ${songArtists(song)}`"
          @click="$emit('play-song', song, recents)"
        >
```

#### 改动规格 A：
1. **页头重构（方向 7）**：
   - 左侧包裹 `<div class="home-head-text">`，内含 `<p class="pg-label">overview</p>` 与 `<h2 class="home-title" data-nosnippet><GlitchText text="音乐概览" /></h2>`。
   - 右侧新增「随机漫游」按钮：
     ```html
     <button
       type="button"
       class="ink-btn ink-btn--ghost ink-btn--sm home-roam-btn"
       :disabled="!recents.length"
       title="从最近记录随机漫游"
       @click="roamRecents"
     ><PixelIcon name="shuffle" :size="14" /> 随机漫游</button>
     ```
   - `roamRecents()` 方法遵守 `[canonical:零网络]`：对 `this.recents.slice()` 做 Fisher-Yates 洗牌得 `shuffled`，若非空则 `this.$emit('play-song', shuffled[0], shuffled)`。
2. **单曲区副标题与行结构重构（方向 1、5、6、10、11）**：
   - `.home-section-sub` 文案改为 `最近单曲`。
   - `.home-songrow` 根节点由 `<button>` 改为 `<div role="button" tabindex="0">`（避免嵌套行尾 `<button class="row-add-btn">` 违反 HTML5 规范），保留整行 `@click="$emit('play-song', song, recents)"`、`@keydown.enter="$emit('play-song', song, recents)"`、`@keydown.space.prevent="$emit('play-song', song, recents)"`：
     ```html
     <div
       v-for="song in visibleRecents"
       :key="song.id"
       class="home-songrow"
       :class="{ 'home-songrow--playing': isPlayingSong(song) }"
       role="button"
       tabindex="0"
       :aria-current="isPlayingSong(song) ? 'true' : undefined"
       :title="`${song.name} - ${songArtists(song)}`"
       @click="$emit('play-song', song, recents)"
       @keydown.enter="$emit('play-song', song, recents)"
       @keydown.space.prevent="$emit('play-song', song, recents)"
     >
     ```
   - 封面保持 `alt=""`（遵守 `[canonical:alt=""]`）。
   - 第二行 `.home-songrow-artist` 合并歌手与来源无框文本（方向 5）：`{{ songRowMeta(song) }}`，其中 `songRowMeta(song)` 在 `songArtists(song)` 与 `songSourceTag(song)` 均非空时返回 `` `${songArtists(song)} · ${songSourceTag(song)}` ``，否则返回非空者。移除原 `<span v-if="songSourceTag(song)" class="pg-chip pg-chip--static home-src-tag">`。
   - 行尾新增收藏快捷按钮（方向 11）：
     ```html
     <button
       type="button"
       class="row-add-btn pg-icobtn pg-icobtn--bare pg-icobtn--sm"
       title="添加到歌单"
       aria-label="添加到歌单"
       aria-haspopup="dialog"
       @click.stop="$emit('add-to-playlist', song, $event.currentTarget)"
       @keydown.enter.stop
       @keydown.space.stop
     ><PixelIcon name="plus" :size="14" /></button>
     ```

#### 定位引文 B：歌单货架与专辑货架模板
```html
    <!-- 最近播放的歌单货架 -->
    <section v-if="recentPlaylists.length" class="home-section">
      <div class="home-section-head">
        <p class="pg-label">history</p>
        <span class="home-section-sub">最近播放的歌单</span>
      </div>
      <div class="home-shelf">
```
及
```html
    <!-- 最近播放的专辑货架（从最近播放歌曲的 al 派生，按专辑去重） -->
    <section v-if="recentAlbums.length" class="home-section">
      <div class="home-section-head">
        <p class="pg-label">albums</p>
        <span class="home-section-sub">最近播放的专辑</span>
      </div>
      <div class="home-shelf">
```

#### 改动规格 B：
1. **歌单货架门控、回退、翻页、播放态与直接播放键（方向 2、3、7、8、10、11、15）**：
   - 显隐条件改为 `v-if="showPlaylistShelf"`：
     - `displayPlaylists`：若 `this.recentPlaylists.length > 0` 取 `this.recentPlaylists`，否则回退 `this.userPlaylists.slice(0, 8)`（遵守 `[canonical:零网络]`）。
     - `showPlaylistShelf`：`this.displayPlaylists.length > 0 && !(this.sidebarOpen && this.isWide)`，其中 `isWide` 由 `window.matchMedia('(min-width: 901px)')` 同步初始化并监听 `change` 更新。
     - `hasShelves` 更新为 `this.showPlaylistShelf || this.recentAlbums.length > 0`。
   - 节头副标题改为 `<span class="home-section-sub">常听歌单</span>`。
   - 节头右缘挂载翻页控件（仅 `plShelfNav.overflow` 即 `scrollWidth > clientWidth` 时渲染）：
     ```html
     <div v-if="plShelfNav.overflow" class="home-shelf-nav">
       <button
         type="button"
         class="pg-icobtn pg-icobtn--sm home-shelf-btn"
         aria-label="上一页"
         title="上一页"
         :disabled="!plShelfNav.canPrev"
         @click="scrollShelf('pl', -1)"
       ><PixelIcon name="chev-l" :size="14" /></button>
       <button
         type="button"
         class="pg-icobtn pg-icobtn--sm home-shelf-btn"
         aria-label="下一页"
         title="下一页"
         :disabled="!plShelfNav.canNext"
         @click="scrollShelf('pl', 1)"
       ><PixelIcon name="chev-r" :size="14" /></button>
     </div>
     ```
   - `.home-shelf` 绑 `ref="plShelfEl"` 与 `@scroll.passive="updateShelfNav(plShelfEl, plShelfNav)"`。
   - 歌单 `.grid-card` 绑 `:class="{ 'grid-card--playing': isPlayingPlaylist(pl) }"` 与 `:aria-current="isPlayingPlaylist(pl) ? 'true' : undefined"`（遵守 `[canonical:aria-current]`）。
   - 歌单封面 `<img>` 的 `:alt="pl.name"` 改为 `alt=""`（遵守 `[canonical:alt=""]`）。
   - `.grid-card-cover` 内新增播放态角标与右下 `▶` 浮层按钮：
     ```html
     <span
       v-if="isPlayingPlaylist(pl)"
       class="grid-card-playing-badge"
       aria-hidden="true"
     ><PixelIcon name="play" :size="12" /></span>
     <button
       type="button"
       class="grid-card-play pg-icobtn pg-icobtn--sm"
       title="播放歌单"
       :aria-label="`播放歌单 ${pl.name}`"
       @click.stop="$emit('play-playlist', pl)"
       @keydown.enter.stop="$emit('play-playlist', pl)"
       @keydown.space.stop.prevent="$emit('play-playlist', pl)"
     ><PixelIcon name="play" :size="14" /></button>
     ```
2. **专辑货架副标题、翻页、meta、同 `al.key` 聚合与播放态（方向 2、3、7、9、10、15）**：
   - 节头副标题改为 `<span class="home-section-sub">涉猎专辑</span>`。
   - 节头右缘挂载同构翻页控件（`v-if="alShelfNav.overflow"`，`scrollShelf('al', -1)` / `scrollShelf('al', 1)`）；`.home-shelf` 绑 `ref="alShelfEl"` 与 `@scroll.passive="updateShelfNav(alShelfEl, alShelfNav)"`。
   - `recentAlbums` 计算属性：在保持既有两道准入闸（`key` 非空且 `norm(al?.name) !== norm(song?.name)`）的基础上，为每张入架专辑收集 `recents` 中所有同 `key` 的曲目数组 `tracks`（按 `recents` 原序），并在对象上附带 `tracks` 字段：
     `{ key, name: al?.name ?? '', picUrl: songCoverUrl(song) || '', artist: songArtists(song), song, tracks }`。
   - 专辑 `.grid-card` 点击与键盘激活调用 `playAlbum(al)`：
     ```js
     playAlbum(al) {
       const queue = al.tracks && al.tracks.length >= 2 ? al.tracks : [al.song]
       this.$emit('play-song', al.song, queue)
     }
     ```
   - 专辑 `.grid-card` 绑 `:class="{ 'grid-card--playing': isPlayingAlbum(al) }"` 与 `:aria-current="isPlayingAlbum(al) ? 'true' : undefined"`（其中 `isPlayingAlbum(al)` 判 `this.currentSongId != null && al.tracks.some(s => String(s.id) === String(this.currentSongId))`）。
   - 专辑 `.grid-card` 的 `:title` 改为 `` `播放《${al.name}》· 含《${al.song.name}》` ``，封面 `<img>` 的 `:alt="al.name"` 改为 `alt=""`（遵守 `[canonical:alt=""]`），`.grid-card-cover` 内在 `isPlayingAlbum(al)` 时同样渲染 `<span v-if="isPlayingAlbum(al)" class="grid-card-playing-badge" aria-hidden="true"><PixelIcon name="play" :size="12" /></span>`。
   - 专辑 `.grid-card-meta` 改为：`{{ al.artist ? `${al.artist} · 含《${al.song.name}》` : `含《${al.song.name}》` }}`。

#### 定位引文 C：`<script>` props/emits/setup 与 `<style scoped>`
```js
  props: {
    recentPlaylists: {
      type: Array,
      default: () => []
    },
    recents: {
      type: Array,
      default: () => []
    }
  },
  emits: ['open', 'play-song'],
```
及样式块中 `.home-head`、`.home-songs`、`.home-songrow`、`.home-songrow-cover`、`.home-src-tag`、`.home-shelf`。

#### 改动规格 C：
1. **Props 与 Emits 扩展**：
   - 新增 props：`userPlaylists: { type: Array, default: () => [] }`、`sidebarOpen: { type: Boolean, default: false }`、`currentSongId: { type: [String, Number], default: null }`、`playingPlaylistId: { type: [String, Number], default: null }`。
   - `emits` 扩为：`['open', 'play-song', 'play-playlist', 'add-to-playlist']`。
2. **Scoped 样式更新（方向 1、2、3、5、6、10、11、12）**：
   - `.home-head`：`display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; padding: 0 0 16px; position: relative;`；`.home-head-text { min-width: 0; }`。
   - `.home-section-head`：`display: flex; align-items: center; gap: 10px; margin-bottom: 12px;`；`.home-shelf-nav { margin-left: auto; display: inline-flex; align-items: center; gap: 4px; }`。
   - `.home-songrow`：
     ```css
     .home-songrow {
       display: flex;
       align-items: center;
       gap: 10px;
       min-width: 0;
       padding: 6px 8px;
       border: var(--hairline-soft);
       background: var(--paper);
       text-align: left;
       cursor: pointer;
       transition: background .12s, border-color .12s;
     }
     .home-songrow:not(.home-songrow--playing):hover {
       border: var(--hairline);
       background: var(--ink-06);
     }
     .home-songrow--playing {
       background: var(--ink);
       border: var(--hairline);
       color: var(--paper);
     }
     .home-songrow--playing:focus-visible {
       outline-color: var(--paper);
     }
     .home-songrow--playing .home-songrow-name { color: var(--paper); }
     .home-songrow--playing .home-songrow-artist { color: var(--label-grey); }
     .home-songrow--playing .home-songrow-cover { border-color: var(--paper); }
     .home-songrow--playing .row-add-btn { color: var(--label-grey); }
     ```
   - `.home-songrow-cover`：**删除 `image-rendering: pixelated;`**（方向 12）。
   - 删除 `.home-src-tag` 规则块（方向 5）。
   - 移动端 `≤640px` 横滑三行快照网格（方向 6）：
     ```css
     @media (max-width: 640.98px) {
       .home-songs {
         grid-template-columns: none;
         grid-auto-flow: column;
         grid-template-rows: repeat(3, auto);
         grid-auto-columns: 88vw;
         overflow-x: auto;
         scroll-snap-type: x mandatory;
         margin-right: calc(-1 * var(--page-pad-x, 12px));
         padding-right: var(--page-pad-x, 12px);
       }
       .home-songrow {
         scroll-snap-align: start;
       }
     }
     ```
   - `.home-shelf` 边距补偿与右缘出血（方向 2，遵守 `[canonical:左缘基准线]`）：
     ```css
     .home-shelf {
       display: grid;
       grid-auto-flow: column;
       grid-auto-columns: 160px;
       gap: 16px;
       overflow-x: auto;
       padding: 4px 12px 8px;
       margin-inline: -12px;
       margin-right: calc(-1 * var(--page-pad-x, 20px));
       padding-right: var(--page-pad-x, 20px);
     }
     ```
   - 歌单卡/专辑卡播放态角标与右下 `▶` 浮层（方向 10、11）：
     ```css
     .grid-card--playing {
       border-color: var(--ink);
       box-shadow: inset 0 0 0 1.2px var(--ink);
     }
     .grid-card-playing-badge {
       position: absolute;
       top: 6px;
       left: 6px;
       width: 22px;
       height: 22px;
       display: inline-flex;
       align-items: center;
       justify-content: center;
       background: var(--ink);
       color: var(--paper);
       border: 1.2px solid var(--paper);
       pointer-events: none;
     }
     .grid-card-play {
       position: absolute;
       right: 6px;
       bottom: 6px;
       background: var(--ink);
       color: var(--paper);
       border: 1.2px solid var(--paper);
       opacity: 0;
       pointer-events: none;
       transition: opacity .12s, color .2s;
     }
     .grid-card-play:hover:not(:disabled) {
       color: var(--accent-magenta-on-ink);
     }
     .grid-card:hover .grid-card-play,
     .grid-card:focus-within .grid-card-play,
     .grid-card-play:focus-visible {
       opacity: 1;
       pointer-events: auto;
     }
     @media (hover: none) {
       .grid-card-play {
         opacity: 1;
         pointer-events: auto;
       }
     }
     ```

#### 验收标准（`HomeFeed.vue`）：
- **HF-1**：页头渲染 `overview` + `音乐概览` + 右侧 `随机漫游` 按钮；`recents` 为空时按钮 `disabled`；非空点击时 emit `play-song`，第 2 参为洗牌后的全量 `recents` 副本且不修改原数组，零网络请求。`[验证：jsdom]`
- **HF-2**：三节副标题依次为 `最近单曲`、`常听歌单`、`涉猎专辑`。`[验证：jsdom]`
- **HF-3**：`.home-songrow` 常态带 `border: var(--hairline-soft)`，hover 切 `var(--hairline)` + `var(--ink-06)`；第二行 `.home-songrow-artist` 渲染 `artist · source`，无 `.home-src-tag` 黑框 chip；行尾 `.row-add-btn` 点击 emit `add-to-playlist(song, trigger)` 且不冒泡触发 `play-song`。`[验证：jsdom + 实机]`
- **HF-4**：`currentSongId` 匹配时 `.home-songrow` 挂 `.home-songrow--playing`（墨底反白）及 `aria-current="true"`；`playingPlaylistId` 匹配时歌单 `.grid-card` 挂 `.grid-card--playing`、封面左上角标及 `aria-current="true"`；`currentSongId` 命中 `al.tracks` 时专辑 `.grid-card` 挂 `.grid-card--playing`、封面角标及 `aria-current="true"`。`[验证：jsdom + 实机]`
- **HF-5**：歌单卡封面右下 `.grid-card-play` 点击 emit `play-playlist(pl)` 且不触发 `open`。`[验证：jsdom]`
- **HF-6**：`sidebarOpen=true` 且视口 `≥901px` 时歌单货架整段隐藏；`<901px` 或 `sidebarOpen=false` 时正常显示；`recentPlaylists` 为空时回退 `userPlaylists.slice(0, 8)`。`[验证：jsdom + 实机]`
- **HF-7**：专辑卡 `.grid-card-meta` 渲染 `${al.artist} · 含《${al.song.name}》`；当 `recents` 内同 `al.key` 曲目 `≥2` 首时点击 emit `play-song(al.song, al.tracks)`（聚合队列），仅 1 首时 emit `play-song(al.song, [al.song])`；歌单卡与专辑卡封面 `<img>` 均为 `alt=""`。`[验证：jsdom]`
- **HF-8**：货架节头 `[‹][›]` 仅在 `scrollWidth > clientWidth` 时渲染，首端禁用 `‹`、末端禁用 `›`，点击调用 `scrollBy({ left: ±clientWidth, behavior: 'smooth' })`。`[验证：jsdom + 实机]`
- **HF-9**：桌面展开侧栏时 `.home-head`、`.home-section-head`、首列 `.home-songrow` 外框左缘、`.home-shelf` 首卡外框左缘同落 `x = 300px`（`Δx = 0`），右缘出血至容器边；`≤640px` 下 `.home-songs` 呈 3 行横滑 snap 网格；`.home-songrow-cover` 无 `image-rendering: pixelated`。`[验证：jsdom(源码/类名) + 实机(几何)]`

---

### 2.2 `src/App.vue`

#### 定位引文
```html
        <HomeFeed
          v-if="centerView === 'home'"
          :recent-playlists="playlistHistory"
          :recents="playHistory"
          @open="openShelfPlaylist"
          @play-song="openWatchRecent"
        />
```

#### 改动规格
1. 为 `<HomeFeed>` 补齐新增 props 与事件接线：
   ```html
        <HomeFeed
          v-if="centerView === 'home'"
          :recent-playlists="playlistHistory"
          :recents="playHistory"
          :user-playlists="userPlaylists"
          :sidebar-open="sidebarOpen"
          :current-song-id="currentSong?.id ?? null"
          :playing-playlist-id="playingPlaylistId"
          @open="openShelfPlaylist"
          @play-song="openWatchRecent"
          @play-playlist="playShelfPlaylist"
          @add-to-playlist="handleOpenAddToPlaylist"
        />
   ```
2. 新增 `playShelfPlaylist` 包装函数（或在 `App.vue` setup 中定义并导出）：
   ```js
   // 货架歌单卡 ▶ 直播：recentPlaylists 存的是轻量 stub（无内嵌 tracks），
   // 本地歌单（local_pl_*/saved_queue_*）须先回 userPlaylists 取活副本再走 playPlaylistFromSidebar
   const playShelfPlaylist = (pl) => {
     if (!pl) return
     const live = userPlaylists.value.find(p => String(p.id) === String(pl.id))
     return playPlaylistFromSidebar(live || pl)
   }
   ```
   并在 `setup()` 返回对象中导出 `playShelfPlaylist`。

#### 验收标准（`App.vue`）：
- **APP-1**：`<HomeFeed>` 接收 `:user-playlists`、`:sidebar-open`、`:current-song-id`、`:playing-playlist-id`，并绑定 `@play-playlist="playShelfPlaylist"` 与 `@add-to-playlist="handleOpenAddToPlaylist"`；`playShelfPlaylist` 对库中本地歌单能解析出带 `tracks` 的活副本并启动播放。`[验证：jsdom + 实机]`

---

### 2.3 `src/style.css`

#### 定位引文 A：`.row-add-btn` 悬停显隐与反白行配色
```css
/* 反白行上的行尾键改纸色（排在统一律之后才不被压） */
.app-shell .song-row--playing .song-menu-btn:hover {
  color: var(--paper);
  outline-color: var(--paper);
}
```
及
```css
:root[data-theme="glitch-restoration"] .app-shell .song-row--playing .song-menu-btn:hover {
  color: var(--accent-magenta-on-ink);
  outline-color: var(--paper);
}
```
及
```css
.queue-row:hover .row-add-btn,
.queue-row:focus-within .row-add-btn,
.song-result-row:hover .row-add-btn,
.song-result-row:focus-within .row-add-btn,
.row-add-btn:focus-visible { opacity: 1; pointer-events: auto; }
```

#### 改动规格 A：
1. 在 `.row-add-btn` 显隐规则中并入 `.home-songrow`：
   ```css
   .queue-row:hover .row-add-btn,
   .queue-row:focus-within .row-add-btn,
   .song-result-row:hover .row-add-btn,
   .song-result-row:focus-within .row-add-btn,
   .home-songrow:hover .row-add-btn,
   .home-songrow:focus-within .row-add-btn,
   .row-add-btn:focus-visible { opacity: 1; pointer-events: auto; }
   ```
2. 在反白行行尾键 hover 规则中并入 `.home-songrow--playing .row-add-btn:hover`（默认主题与 `glitch-restoration` 主题各一处）：
   ```css
   .app-shell .song-row--playing .song-menu-btn:hover,
   .app-shell .home-songrow--playing .row-add-btn:hover {
     color: var(--paper);
     outline-color: var(--paper);
   }
   ```
   与
   ```css
   :root[data-theme="glitch-restoration"] .app-shell .song-row--playing .song-menu-btn:hover,
   :root[data-theme="glitch-restoration"] .app-shell .home-songrow--playing .row-add-btn:hover {
     color: var(--accent-magenta-on-ink);
     outline-color: var(--paper);
   }
   ```
3. 在 `@media (forced-colors: active)` 状态选择器表中加入 `.home-songrow--playing, .grid-card--playing`；在 `:root[data-theme="glitch-restoration"]` 小封面圆角表（`.song-cover, ...`）中加入 `.home-songrow-cover`。

#### 定位引文 B：`.grid-card` 家族样式（方向 4、11、12）
```css
.grid-card-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.grid-card-cover {
  width: 100%;
  aspect-ratio: 1;
  overflow: hidden;
  border: var(--hairline);
}
.grid-card-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  image-rendering: pixelated;
}
```
及
```css
.grid-card-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  line-height: 1.35;
  min-height: 2.7em;
}
.grid-card-meta {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-64);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
```

#### 改动规格 B：
1. `.grid-card-body` 增加 `flex: 1;`；`.grid-card-meta` 增加 `margin-top: auto;`（方向 4：同行混排单/双行标题时 meta 仍底锚对齐）。
2. `.grid-card-name` **删除 `min-height: 2.7em;`**（方向 4：消灭单行标题下方 ~18px 空洞）。
3. `.grid-card-cover` 增加 `position: relative;`（供播放角标与右下 `▶` 浮层定位）。
4. `.grid-card-cover img` **删除 `image-rendering: pixelated;`**（方向 12）。

#### 验收标准（`src/style.css`）：
- **CSS-1**：`.grid-card-name` 不再含 `min-height: 2.7em`；`.grid-card-body` 含 `flex: 1` 且 `.grid-card-meta` 含 `margin-top: auto`。`[验证：jsdom(源码断言) + 实机]`
- **CSS-2**：`.grid-card-cover img` 不再含 `image-rendering: pixelated`。`[验证：jsdom(源码断言) + 实机]`
- **CSS-3**：桌面悬停 `.home-songrow` 时 `.row-add-btn` 显现，且在 `.home-songrow--playing` 反白底上悬停保持纸色/亮青高对比。`[验证：实机]`

---

### 2.4 `src/components/PlaylistPanel.vue`

#### 定位引文
模板：
```html
    <div class="panel-head">
      <!-- h2 补层级链：topnav h1 → 侧栏 h2 → 歌单名 .pl-name h3（裸 p 断链） -->
      <h2 class="pg-label panel-label"><GlitchText text="library 我的歌单" /></h2>
      <button
        class="pg-icobtn pg-icobtn--bare panel-create-btn"
        title="新建歌单"
        aria-label="新建歌单"
        aria-haspopup="dialog"
        @click="$emit('open-create-playlist')"
      ><PixelIcon name="plus" :size="15" /></button>
    </div>
```
样式：
```css
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-right: 22px;
  flex-shrink: 0;
}

.panel-label {
  padding: 8px 12px 10px; /* 与行块内收缘同轴（12px；封面左缘再内进 16px） */
  flex-shrink: 0;
}

.panel-create-btn { margin: 4px 0 6px; }
```

#### 改动规格（方向 14，遵守 `[canonical:左缘基准线]`）
1. 模板中 `.panel-create-btn` 加入 `pg-icobtn--sm` 类（由 32px 收至 24px 行内尾键档）：
   `class="pg-icobtn pg-icobtn--bare pg-icobtn--sm panel-create-btn"`。
2. 样式调整使 `.panel-label` 顶缘落在 `.playlist-panel` 的 `padding-top: 20px` 基准线上（`y = var(--topnav-h) + 20px ≈ 77.2px`），与 `.home-head .pg-label` 完全同轴：
   ```css
   .panel-head {
     display: flex;
     align-items: flex-start;
     justify-content: space-between;
     padding-right: 22px;
     flex-shrink: 0;
   }

   .panel-label {
     padding: 0 12px 10px; /* 顶距 0：与主区 .home-head .pg-label 严格同轴（y = topnav + 20） */
     flex-shrink: 0;
   }

   .panel-create-btn { margin: -6px 0 4px; }
   ```
   并在 `@media (min-width: 768px) and (max-width: 1023.98px)` 窄轨段补充：
   `.app-sidebar:not(.app-sidebar--open) .panel-create-btn { margin: 0 0 6px; }`（窄轨隐藏 `.panel-label` 时 `+` 键不往上提）。

#### 验收标准（`PlaylistPanel.vue`）：
- **PP-1**：`.panel-create-btn` 挂 `pg-icobtn--sm`（24×24px）；`.panel-label` 声明 `padding: 0 12px 10px` 且 `.panel-head` 声明 `align-items: flex-start`，桌面实机下 `.panel-label` 与 `.home-head .pg-label` 的 `getBoundingClientRect().top` 差值为 `0px`。`[验证：jsdom(类名/源码断言) + 实机(几何)]`

---

### 2.5 `src/components/GlitchText.vue`

#### 定位引文
```js
const HAN_POOL = [...'烫烫烫烫屯屯屯屯锟斤拷锟斤拷锟斤拷锘锘浣犲ソ娴嬭瘯鏄鐨鎴戜滑鍙戝ぇ瀹闂ㄨ瘯鐮佸織榧犺阿鐢熸妸鍚庡湴鍧戝潃鍧\uFFFD▓░▒█▓░▒█']
```
及 `tick` / `burst` / `stop` / `watch(active)` 块：
```js
    let timer = 0
    function tick() {
      // 先快照再腐蚀——新腐蚀的字符不得成为本代恢复候选
      // （skill 原版即此序：glitched 在 add 之前取样）
      const glitched = [...corrupt.value.keys()]
      const clean = []
      let total = 0
      words.value.forEach((word, wi) =>
        word.chars.forEach((ch, ci) => { total++; if (!corrupt.value.has(keyOf(wi, ci))) clean.push({ k: keyOf(wi, ci), ch }) })
      )
      // 短文本并发腐蚀封顶 ~1/6（至少 1 个）——4 字标题不会近半句皆替身
      if (clean.length && corrupt.value.size < Math.max(1, Math.ceil(total / 6))) {
        const { k, ch } = clean[Math.random() * clean.length | 0]
        corrupt.value.set(k, pickFor(ch))
      }
      // 每代随机恢复 2-3 个存量——稳态来回腐蚀而非单向累积
      glitched.slice(0, 2 + (Math.random() * 2 | 0)).forEach(k => corrupt.value.delete(k))
    }
    // burst：全 scramble 闪回（错误张力峰值）——规范是同帧 scramble→复原，
    // 我们持留 ~480ms 肉眼可辨再整批回净，DOM 文本始终干净（比规范
    // textContent 改写更守 a11y）。错误连发时重定时，闪回不打叠
    let burstTimer = 0
    function burst() {
      words.value.forEach((word, wi) =>
        word.chars.forEach((ch, ci) =>
          corrupt.value.set(keyOf(wi, ci), pickFor(ch))
        )
      )
      clearTimeout(burstTimer)
      burstTimer = setTimeout(() => { corrupt.value.clear() }, 480)
    }
    function stop() {
      clearInterval(timer)
      clearTimeout(burstTimer)
      timer = 0
      corrupt.value.clear()
    }

    watch(active, on => {
      if (on) { stop(); timer = setInterval(tick, 1100) }
      else stop()
    }, { immediate: true })
    // text 变更连 burst 回净表一起清——否则旧 timer 会误抹新文本的 tick 腐蚀
    watch(() => props.text, () => { clearTimeout(burstTimer); corrupt.value.clear() })
```

#### 改动规格（方向 13）
1. **净化 `HAN_POOL`**：彻底剔除 `烫`、`屯`、`锟`、`斤`、`拷`、`锘` 及一切错读汉字与 `\uFFFD`，替换为几何块与半角片假名符号（首元钉 `'█'`，与 `POOL` 首元 `'▓'` 区分以保留 Han/非 Han 分流可测性）：
   ```js
   const HAN_POOL = [...'█▓▒░▀▄▌▐■□▪▫▲△▼▽◆◇○●◎◇◆◇◆▓░▒█ﾂﾎﾃﾄﾅﾌﾑﾒﾓﾘﾚﾖﾊﾋﾍﾐﾕﾗﾆﾇ']
   ```
2. **脉冲式 `tick`（3.5~5s 静默 + ~200ms 1-2 字符微闪）**：
   - 常量定义：
     ```js
     const PULSE_QUIET_MIN_MS = 3500
     const PULSE_QUIET_SPAN_MS = 1500
     const PULSE_FLASH_MS = 200
     ```
   - `tick()` 每次触发时：收集全部字符槽位 `clean`，计算本次闪烁字符数 `count = Math.min(clean.length, Math.max(1, Math.ceil(total / 6)), 1 + (Math.random() * 2 | 0))`（1~2 个字符，且受 `ceil(total / 6)` 短文本上限约束），写入 `corrupt.value`，并设 `pulseTimer = setTimeout(() => { corrupt.value.clear() }, PULSE_FLASH_MS)` 在 `200ms` 后回净归零。
   - `scheduleTick()`：以 `delay = PULSE_QUIET_MIN_MS + (Math.random() * PULSE_QUIET_SPAN_MS | 0)`（即 `3500~5000ms`）设 `timer = setTimeout(() => { tick(); if (active.value) scheduleTick() }, delay)`。
   - `burst()`：触发前先 `clearTimeout(pulseTimer)`，防微闪回收定时器提前抹掉 `480ms` 的全量 burst。
   - `stop()` 与 `watch(() => props.text)`：一并清理 `clearTimeout(timer)`、`clearTimeout(pulseTimer)`、`clearTimeout(burstTimer)`。

#### 验收标准（`GlitchText.vue`）：
- **GT-1**：`HAN_POOL` 不含任何 `烫/屯/锟/斤/拷/锘` 字符；`Math.random() === 0` 时汉字分流取 `HAN_POOL[0]`（`'█'`），拉丁字符取 `POOL[0]`（`'▓'`）。`[验证：jsdom]`
- **GT-2**：激活态下经历 `3500~5000ms` 静默期后触发微闪（1~2 字符），持续 `200ms` 后自动清空回静默态；`stop()` / 卸载时无残留定时器。`[验证：jsdom]`

---

### 2.6 `src/components/PrintMarks.vue`

#### 定位引文
```html
  <div v-else-if="variant === 'stamp'" class="pg-stamp">
    <p><GlitchText text="MeowSync · Version 1.0.0" /></p>
    <p><GlitchText text="©2026 · All rights reserved" /></p>
    <p><GlitchText text="Made with Love" /></p>
  </div>
</template>

<script>
import GlitchText from './GlitchText.vue'

export default {
  name: 'PrintMarks',
  components: { GlitchText },
```

#### 改动规格（方向 13）
- 将 `variant === 'stamp'` 内的三行 `<p>` 改为纯静态文本：
  ```html
  <div v-else-if="variant === 'stamp'" class="pg-stamp">
    <p>MeowSync · Version 1.0.0</p>
    <p>©2026 · All rights reserved</p>
    <p>Made with Love</p>
  </div>
  ```
- 移除 `import GlitchText from './GlitchText.vue'` 及 `components: { GlitchText }`。

#### 验收标准（`PrintMarks.vue`）：
- **PM-1**：`PrintMarks` 在 `variant="stamp"` 下渲染静态三行 `<p>`，不挂载 `GlitchText` 实例（无 `.glitch-text` / `.corruptible` 节点）。`[验证：jsdom]`

---

## 3. 测试契约（Test Contract）

### 3.1 `tests/ui/feed-downloads-ui.spec.mjs`
1. **既有测试同步更新**：
   - `songrow 渲封面/歌名/歌手/来源徽标，点击发 play-song`：
     - `.home-src-tag` 已移除，改为断言 `rows.map(r => r.find('.home-songrow-artist').text())` 等于 `['艺人A · 网易云', 'UP主 · YouTube', 'UP乙 · B站', '艺 · QQ音乐', '艺丙 · QQ音乐']`。
   - `过滤后无真专辑时专辑 section 整段不渲染`：
     - 断言文案由 `'最近播放的专辑'` 更新为 `'涉猎专辑'`。
2. **新增测试覆盖**：
   - **页头与随机漫游**：断言 `.home-head .pg-label` 为 `'overview'`、标题含 `'音乐概览'`、三节副标题依次为 `'最近单曲'`/`'常听歌单'`/`'涉猎专辑'`；`recents=[]` 时 `.home-roam-btn` 为 `disabled`；`recents` 非空点击 `.home-roam-btn` 时 emit `play-song`，曲目与队列长度为 `RECENTS.length`。
   - **歌单货架门控与回退**：
     - `recentPlaylists=[]` 且 `userPlaylists` 含 10 个歌单时，货架回退渲染前 8 个（`userPlaylists.slice(0, 8)`）。
     - 当 `window.matchMedia('(min-width: 901px)')` 返回 `matches: true` 且 `sidebarOpen: true` 时，歌单货架不渲染；`sidebarOpen: false` 或 `matches: false` 时正常渲染。
   - **专辑卡 meta 与同 `al.key` 聚合队列**：
     - 断言专辑卡 `.grid-card-meta` 为 `'艺人A · 含《真曲》'`；歌单卡与专辑卡 `img` 的 `attributes('alt')` 均为 `''`。
     - 当 `recents` 含 2 首同 `al.id=42` 的曲目时，点击该专辑卡 emit `play-song` 的第 2 参为长度 2 的同专辑曲目数组；当仅含 1 首时第 2 参为 `[al.song]`。
   - **播放态与 `aria-current`**：传入 `currentSongId: 1`、`playingPlaylistId: 77`，断言对应 `.home-songrow` 含 `.home-songrow--playing` 与 `aria-current="true"`，对应歌单卡与专辑卡含 `.grid-card--playing`、`.grid-card-playing-badge` 与 `aria-current="true"`，其余条目无 `aria-current` 属性。
   - **快捷动作键**：
     - 点击单曲行 `.row-add-btn` emit `add-to-playlist(song, buttonEl)`，且不触发 `play-song`。
     - 点击歌单卡 `.grid-card-play` emit `play-playlist(pl)`，且不触发 `open`。
   - **货架翻页键 `[‹][›]`**：模拟 `.home-shelf` 的 `scrollWidth=600, clientWidth=300, scrollLeft=0` 并触发 `scroll`，断言 `.home-shelf-nav` 显现、上一页 `disabled`、下一页可用，点击下一页调用 `scrollBy({ left: 300, behavior: 'smooth' })`。
   - **去 `pixelated` 与单行卡高源码断言**：断言 `HomeFeed.vue` 的 `.home-songrow-cover` 与 `style.css` 的 `.grid-card-cover img` 不含 `image-rendering: pixelated`，`style.css` 的 `.grid-card-name` 不含 `min-height: 2.7em`；断言 `PrintMarks.vue` `variant="stamp"` 不含 `.glitch-text`。

### 3.2 `tests/ui/glitch-text.spec.mjs`
1. **腐蚀分流首元更新**：
   - 将原断言中 `HAN_POOL[0]` 的字面量 `'烫'` 更新为 `'█'`（`'漢'` → `'█'`，`'𠮷'` → `'█'`，`'a'` → `'▓'`），并新增断言确认 `GlitchText.vue` 源码不含 `[烫屯锟斤拷]`。
2. **脉冲 `tick` 周期断言**：
   - 在 `tick 主路径同走分流` 用例中：推进 `3500ms`（`Math.random() === 0` 下静默期下限）断言 `corrupt.get('0:0') === '█'` 且 `corrupt.size === 1`；再推进 `200ms`（微闪结束）断言 `corrupt.size === 0`（回归静默干净态）。

### 3.3 `tests/ui/playlist-panel.spec.mjs`
- 新增 1 条用例钉住 `.panel-create-btn` 含 `pg-icobtn--sm` 类，且 `.panel-label` 与 `.panel-head` 顶轴对齐样式生效。

---

## 4. 风险边界与注意事项

1. **避免 `<button>` 嵌套 `<button>`**：`HomeFeed.vue` 原 `.home-songrow` 是 `<button>`，直接塞入 `<button class="row-add-btn">` 会导致 HTML5 解析器自动闭合外层 `<button>` 破坏 DOM 树。必须将 `.home-songrow` 改为 `<div role="button" tabindex="0">`，并在内部 `<button class="row-add-btn">` 上加 `@click.stop @keydown.enter.stop @keydown.space.stop`，同时保留 `.home-songrow` 根节点的 `@click` 以兼容既有测试 `rows[0].trigger('click')`。
2. **货架歌单 `stub` 播放空单陷阱**：`playlistHistory`（即 `recentPlaylists`）持久化时仅保存 `{ id, name, coverImgUrl, trackCount }` 轻量摘要，不含 `tracks`。若用户在歌单货架上对本地歌单（`local_pl_*` / `saved_queue_*`）点击 `▶`，`App.vue` 的 `playShelfPlaylist` 必须先 `userPlaylists.value.find(p => String(p.id) === String(pl.id))` 取回完整活副本再调用 `playPlaylistFromSidebar`，与 `openShelfPlaylist` 保持同口径。
3. **jsdom 环境下的 DOM 几何模拟**：jsdom 中 `scrollWidth` / `clientWidth` / `scrollLeft` 恒为 `0` 且无 `Element.prototype.scrollBy`。`HomeFeed.vue` 的 `scrollShelf` 必须对 `el.scrollBy` 做 `typeof el.scrollBy === 'function'` 守卫（回退 `el.scrollLeft += ...`），确保单测与老内核不抛异常。
4. **反白行上 `.row-add-btn` 的对比度**：`style.css` 全局 `.app-shell .app-body .row-add-btn:hover` 特异度为 `(0,4,0)` 且置墨色，在 `.home-songrow--playing` 墨底上会隐形，必须在 `style.css` 中紧随 `.song-row--playing .song-menu-btn:hover` 补齐 `.app-shell .home-songrow--playing .row-add-btn:hover` 的纸色/亮青覆盖。
5. **窄轨侧栏（768–1023px 未展开）兼容性**：`PlaylistPanel.vue` 的 `.panel-create-btn` 设 `margin: -6px 0 4px` 用以与 `.panel-label` 居中对齐，但在 `768–1023.98px` 窄轨未展开态下 `.panel-label` 被 `display: none`，须在该媒体查询内复位 `.panel-create-btn { margin: 0 0 6px; }` 防止 `+` 键上移越界。

---

## 5. 实施单元划分建议（互不重叠文件域）

| 单元 | 执行代理 | 负责文件域（严格互斥） | 核心职责 |
| :--- | :--- | :--- | :--- |
| **Unit 1：主页视图与全局卡片样式** | `subagent_general` #1 | `src/components/HomeFeed.vue`<br>`src/App.vue`<br>`src/style.css` | 落地 CTO 方向 1–12 & 15（页头概览+随机漫游、单曲微框+合并来源+收藏键+播放态+移动端三行横滑、货架出血+翻页键+歌单门控回退+右下 `▶`+专辑卡 meta/同 key 聚合、去 `min-height:2.7em`、去 `pixelated`、`alt=""`、`aria-current`） |
| **Unit 2：侧栏顶轴与故障文本降噪** | `subagent_general` #2 | `src/components/PlaylistPanel.vue`<br>`src/components/GlitchText.vue`<br>`src/components/PrintMarks.vue` | 落地 CTO 方向 13 & 14（`.panel-head` 顶轴对齐 + `pg-icobtn--sm`、`HAN_POOL` 去乱码汉字改几何/半角符、`tick` 改 3.5~5s 静默 + 200ms 脉冲、`PrintMarks` 页脚静态化） |
| **Unit 3：全套单测契约更新与扩充** | `subagent_general` #3 | `tests/ui/feed-downloads-ui.spec.mjs`<br>`tests/ui/playlist-panel.spec.mjs`<br>`tests/ui/glitch-text.spec.mjs` | 同步更新既有断言，新增 14 项重构特性的 jsdom 行为与源码回归测试 |

*(注：Unit 1 与 Unit 2 文件域完全正交可并行执行；Unit 3 可在 Unit 1 & 2 完成后运行或并行编写后统一跑 `npx vitest run` 验证。)*

---

## 6. 复审关注点（Review Checklist）

1. **左缘与顶缘几何对齐（`[canonical:左缘基准线]`）**：
   - `.home-shelf` 是否同时具备 `padding: 4px 12px 8px; margin-inline: -12px;` 与右出血 `margin-right: calc(-1 * var(--page-pad-x, 20px)); padding-right: var(--page-pad-x, 20px);`（注意属性先后顺序，`margin-right` / `padding-right` 须在简写之后以防被覆盖）。
   - `PlaylistPanel.vue` 的 `.panel-label` 是否 `padding-top: 0` 且 `.panel-head` 为 `align-items: flex-start`。
2. **无障碍与嵌套合法性（`[canonical:alt=""]`、`[canonical:aria-current]`）**：
   - `.home-songrow` 与 `.grid-card` 内是否存在 `<button>` 嵌套 `<button>`。
   - 子按钮（`.row-add-btn`、`.grid-card-play`）是否阻断了 `click` / `keydown.enter` / `keydown.space` 冒泡。
   - 歌单卡、专辑卡、单曲行三处封面 `<img>` 是否全部为 `alt=""`。
   - 未命中播放态时 `:aria-current` 是否返回 `undefined`（而非 `"false"`）。
3. **定时器与观察器清理**：
   - `HomeFeed.vue` 的 `window` `resize` 监听与 `matchMedia` `change` 监听是否在 `onBeforeUnmount` 中配对卸载。
   - `GlitchText.vue` 的 `timer` 与 `pulseTimer` 是否在 `stop()`、`burst()`、`watch(() => props.text)`、`onBeforeUnmount` 中全部清理无泄漏。

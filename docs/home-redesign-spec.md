# 主页 HomeFeed 优雅化重构 — 唯一权威可执行规格（Canonical Spec）

- **协议版本**：cto-flow v1.3.0
- **目标仓库**：`/Users/meow/Code/meowsync`（分支 `feature/download-manager`）
- **综合来源**：候选规格 A（`/tmp/cto-spec-a/home-redesign.md`）与候选规格 B（`/tmp/cto-spec-b/home-redesign.md`）择优合流定稿
- **涉及文件域（8 个文件，3 个正交并行单元）**：
  - **U1（主页发现流与宿主接线域）**：`src/components/HomeFeed.vue`、`src/App.vue`、`tests/ui/feed-downloads-ui.spec.mjs`
  - **U2（全局卡片/行样式与侧栏首行同轴域）**：`src/style.css`、`src/components/PlaylistPanel.vue`、`tests/ui/playlist-panel.spec.mjs`
  - **U3（GlitchText 脉冲降噪与页脚静态化域）**：`src/components/GlitchText.vue`、`src/components/PrintMarks.vue`、`tests/ui/glitch-text.spec.mjs`

---

## 一、动机（实机诊断 15 项缺陷与根因闭环）

1. **左轴 `x=300 / 308 / 304` 三段错位**：桌面常驻侧栏宽 `280px` + `.home-feed` 内边距 `--page-pad-x: 20px`，页头 `.home-head` 与节头 `.home-section-head` 左起 `x = 300px`；`.home-songrow` 常态无边框且 `padding: 6px 8px` 致首张 38px 封面左缘退至 `x = 308px`；`.home-shelf` 设 `padding: 4px 4px 8px` 且无负向 margin 抵消，首张 `.grid-card` 左缘落在 `x = 304px`，三段视觉左轴参差。
2. **左右栏首行 `y` 差 6px**：顶栏高 `57.2px`，主区 `.home-feed` 经 `border-top: 20px solid transparent` 下推，`.home-head .pg-label` 顶缘在 `y ≈ 77.2px`；侧栏 `.playlist-panel` 虽有 `padding: 20px 0 0`，但 `.panel-head` 设 `align-items: center` 且 `.panel-label`（`padding: 8px 12px 10px`）与 `32px` 高 `.panel-create-btn`（`margin: 4px 0 6px`）将 `library 我的歌单` 顶缘推低至 `y ≈ 83.2px`。
3. **货架右缘半卡硬裁切且无翻页控件**：`.home-shelf` 局限于内容盒宽度内未向右出血跨过 `--page-pad-x`，横向溢出时末卡在距视口右缘 `20px` 处被突兀硬切；且桌面端无显式 `[‹][›]` 翻页按钮。
4. **`.grid-card` 单行标题下方 `~18px` 空洞**：`src/style.css` 中 `.grid-card-name` 硬写 `min-height: 2.7em`（强留两行高），单行歌单/专辑名与 `.grid-card-meta` 之间出现约 `18px` 死白。
5. **单曲行在大列宽下中部视觉断裂**：`.home-songrow` 常态无边框、无底色，在 `280~340px` 列宽下左侧歌名/歌手与右侧徽标之间缺乏容器边界连接。
6. **来源 chip 黑框喧宾夺主**：每行 `.home-songrow` 尾部挂 `1.2px` 实墨框 `.pg-chip.home-src-tag`，12 个黑框在网格中形成强烈视觉噪音并挤占行尾操作键空间。
7. **移动端 12 行单列纵向霸屏**：`≤640px` 下 `.home-songs` 退化为 12 行单列垂直堆叠（约 `650px` 高），把下方歌单与专辑货架完全挤出首屏视口。
8. **「发现音乐」与三个「最近播放」语义矛盾重复**：页头叫 `discover / 发现音乐`，底下全是本地历史；三节副标题连用 `最近播放`、`最近播放的歌单`、`最近播放的专辑`，机械重复。
9. **歌单货架桌面展开侧栏时重复、冷启动又为空**：中宽/桌面展开侧栏时歌单货架与侧栏信息重叠；而 `recentPlaylists` 仅记录播放过的歌单（新用户或刚导入未播时为空），且历史快照未与 `userPlaylists` 活副本同步。
10. **伪专辑卡只播单曲、曲目预期落空**：专辑卡 meta 仅显示歌手名，掩盖了「从最近单曲派生」的事实；且当本地（`recents` + `userPlaylists`）已有同专辑多首曲目时未聚合播放。
11. **主页对「正在播放」零视觉与无障碍反馈**：`HomeFeed` 未接收 `currentSongId` / `playingPlaylistId`，正在播放的单曲行、歌单卡、专辑卡无高亮或 `aria-current` 状态。
12. **单曲行缺收藏键、歌单卡缺直接播放键**：首页单曲行无法一键 `+` 添加到歌单；歌单货架卡必须点进详情页才能播放，缺少封面右下 `▶` 浮层直播键。
13. **`GlitchText` 高频跳「锟斤拷烫烫烫」造成视觉疲劳**：`GlitchText.vue` 的 `HAN_POOL` 高权重塞入 `烫屯锟斤拷锘\uFFFD`，配合 `setInterval(tick, 1100)` 持续驻留腐蚀，连 `PrintMarks.vue` 页脚三行版本戳也常驻跳变。
14. **照片封面强制 `image-rendering: pixelated` 锯齿**：`.home-songrow-cover` 与 `.grid-card-cover img` 声明了 `image-rendering: pixelated`，导致高分辨率照片封面缩放时出现劣质锯齿。
15. **货架卡封面 `alt=标题` 致屏幕阅读器双读**：歌单卡 `:alt="pl.name"`、专辑卡 `:alt="al.name"` 与紧邻 `<h3 class="grid-card-name">` 重复，导致屏幕阅读器连续朗读两遍名称。

---

## 二、`[canonical]` 共享规则句

- **[canonical] 双栏首行同轴律**：`.app-body` 内左右分栏的首行微标签（左侧 `.playlist-panel .panel-label` 与右侧主区 `.home-head .pg-label`）顶缘必须严格同轴对齐在距 `.app-body` 顶缘 `20px` 处（`y = 77.2px`）；同行附属图标按钮通过 `align-items: flex-start` + 负顶距与微标签中心同心，不得撑高微标签顶距。
- **[canonical] 左缘同轴与货架出血律**：主区 `.home-head`、`.home-section-head`、`.home-songrow` 微框外缘、`.home-shelf` 首张 `.grid-card` 外缘必须严格对齐同一垂直基准线（`--page-pad-x` 轴，桌面 `x = 300px`）；横向货架容器通过 `padding-left: 12px; margin-left: -12px` 容纳卡片阴影且对齐左轴，通过 `margin-right: calc(-1 * var(--page-pad-x)); padding-right: var(--page-pad-x)` 向右出血至容器右界。
- **[canonical] 可交互容器反嵌套与零死区律**：严禁 `<button>` 嵌套 `<button>` 或在 `[role="button"]` 祖先内嵌套 `<button>`（`find('button button').exists() === false` 且 `find('[role="button"] button').exists() === false`）。含附属按钮的行/卡片（`.home-songrow`、`.grid-card`）以非交互 `<div>` 为外壳并挂载整卡 `@click`（消除内边距点击死区），主激活区（`.home-songrow-main`、`.grid-card-main`）与附属动作按钮（`.row-add-btn`、`.grid-card-play`）互不包含，附属按钮使用 `@click.stop` 隔离冒泡。
- **[canonical] 封面装饰图静音律**：凡紧邻同行/同卡可见标题（歌名/歌单名/专辑名）的 `<img class="home-songrow-cover">` 及 `.grid-card-cover img`，一律设 `alt=""`，防止屏幕阅读器双读标题。
- **[canonical] `aria-current` 播放态与彩布反白对比度律**：当前播放命中的单曲触发器（`.home-songrow-main`）及歌单/专辑卡（`.grid-card` 与 `.grid-card-main`）设 `aria-current="true"`（未命中为 `undefined`），外壳挂 `.home-songrow--playing` / `.grid-card--playing`；所有 `var(--ink-64)` 次级文本类必须登记入 `src/style.css` 的 `.app-shell .app-body` 升档白名单，并在白名单补丁带显式声明反白容器内回退 `var(--label-grey)` / `var(--paper)`。
- **[canonical] 零网络纯本地派生律**：主页一切渲染与交互（含「随机漫游」、专辑同键曲目聚合、歌单货架活副本富化与 `userPlaylists` 空回退）均由本地内存/历史派生，不得在 `HomeFeed.vue` 发起任何网络请求。

---

## 三、A/B 关键分歧裁决表

| 分歧维度 | 候选 A 方案 | 候选 B 方案 | 最终权威裁决（Canonical 方案） | 裁决理由 |
| :--- | :--- | :--- | :--- | :--- |
| **1. `.home-songrow` 反嵌套与点击死区** | 外层 `<div class="home-songrow">`，`@click` 仅绑内层 `<button class="home-songrow-main">` | 外层 `<div class="home-songrow" @click>`，内层 `<div class="home-songrow-main" role="button" tabindex="0">` | 外层 `<div class="home-songrow" @click="$emit('play-song', song, recents)">` + 内层原生 `<button type="button" class="home-songrow-main">`（不重复绑 `@click`，靠原生点击/键盘事件冒泡至外层） + 同级 `<button type="button" class="row-add-btn" @click.stop>` | 兼得 A 的原生 `<button>` 键盘/读屏语义与 B 的整卡无死区（`6px 8px` 内边距可点、兼容既有 `rows[0].trigger('click')` 与 `.home-songrow-main` 点击且只触发一次） |
| **2. 歌单货架桌面重复与空回退（#9）** | `sidebarOpen && ≥901px` 时隐藏；空回退 `userPlaylists.slice(0, 8)`（漏滤 `single_song_` 且无活副本富化） | 常显不隐藏；有历史时用 `userPlaylists` 活副本富化，无历史回退 `userPlaylists` 滤除 `isSingleSongShellId` 前 8 项 | **合流**：① 门控保留 `hidePlaylistShelf = sidebarOpen && wideViewport`（`min-width: 901px`；桌面 `≥1024px` 常态 `sidebarOpen=false` 故货架常显，仅展开侧栏态收起）；② 数据源采用 `displayPlaylists`（非空时用 `userPlaylists` 活副本同步字段，为空时回退 `userPlaylists.filter(p => p && !isSingleSongShellId(p.id)).slice(0, 8)`） | 既满足 `sidebarOpen && ≥901px` 门控契约，又防止单曲分享壳 `single_song_*` 混入歌单货架，且保证桌面常态下货架、翻页键与直播键可用、改名/曲数实时同步 |
| **3. 专辑同 `al.key` 曲目聚合范围与单曲回退** | 仅聚合 `recents`；仅 1 首时 emit `[al.song]`（播完 1 首即停） | 聚合 `recents` + `userPlaylists`（`tracks`/`addedTracks` 按 `id` 去重）；仅 1 首时回退 emit `this.recents` | 采用 **B**：先扫 `recents` 再扫 `userPlaylists` 各歌单 `tracks`/`addedTracks`（按 `String(s.id)` 去重）聚合 `al.tracks`；点击时若 `al.tracks.length >= 2` 则 emit `(al.song, al.tracks)`，否则 emit `(al.song, this.recents)` | `userPlaylists` 已传入组件，跨库聚合零网络开销且大幅提高凑齐多曲专辑的概率；单曲专辑回退 `this.recents` 保持连播不断流 |
| **4. 歌单卡 `▶` 浮层 DOM 结构** | `<div class="grid-card" role="button">` 内嵌 `<button class="grid-card-play">`（ARIA 违规，且漏写 `@keydown.enter.stop`） | 虽加了 `@keydown.enter.stop`，但模板仍把 `<button class="grid-card-play">` 套在 `<div class="grid-card" role="button">` 内 | 外层 `<div class="grid-card" @click="$emit('open', pl)">`（无 `role="button"`）；上层 `.grid-card-cover` 含 `img[alt=""]`、`.grid-card-badge` 与 `<button type="button" class="grid-card-play" @click.stop="$emit('play-playlist', pl)">`；下层 `<div class="grid-card-body grid-card-main" role="button" tabindex="0" @keydown.enter="..." @keydown.space.prevent="...">` | 彻底根除 `[role="button"] button` 的 ARIA 嵌套违规与键盘 Enter/Space 冒泡冲突，同时保持 `.grid-card-play` 在 `.grid-card-cover` 右下角 `right:6px; bottom:6px` 精确锚定且整卡点击无死区 |
| **5. `GlitchText` 脉冲与 `PrintMarks` 页脚** | `HAN_POOL[0]='▒'`，静默 `3500~5000ms`；`PrintMarks` 直接删掉 `GlitchText` 组件 | `HAN_POOL[0]='█'`，静默 `3800~5000ms` + `200ms` 微闪；新增 `ambient` prop，`PrintMarks` 传 `:ambient="false"` | 采用 **B**：`HAN_POOL[0]='█'`，静默 `3800 + random*1200 ms`、微闪 `200ms`；`GlitchText` 新增 `ambient: { type: Boolean, default: true }`，`PrintMarks` 页脚三行传 `:ambient="false"` | `:ambient="false"` 使页脚常态 0 定时器、完全静止，但在全局错误触发 `glitchBurst()` 时仍参与 480ms 全屏叙事闪回，不破坏主题设计语言 |
| **6. `.panel-head` 首行 y 轴对齐 CSS** | 把 `.panel-create-btn` 缩小为 `pg-icobtn--sm`（24px）+ `margin: -6px 0 0` | 保持 `.panel-create-btn` 标准 `32px` 尺寸，`.panel-head { align-items: flex-start }` + `.panel-label { padding: 0 12px 12px }` + `.panel-create-btn { margin: -10px 0 4px }` | 采用 **B**：`.panel-head` 设 `align-items: flex-start`，`.panel-label` 设 `padding: 0 12px 12px`（顶距 0），`.panel-create-btn` 保持 32px 并设 `margin: -10px 0 4px`（窄轨未展开态复位 `margin: 0 0 6px`） | 无需牺牲「新建歌单」按钮的 32×32px 触控热区；`-10 + 16 = 6px` 与 `12px` 行高标签中心 `6px` 精确同心，且标签顶缘严丝合缝落在 `y = 77.2px` |
| **7. 3 个实施单元文件边界** | U1/U2 只改生产代码，U3 单独改全部 3 个测试文件（U3 必须串行等待） | 每个单元绑定「生产文件 + 对应 spec 文件」（但 U1 的 spec 读了 U2 的 `style.css`） | 采用 **B 的「生产+测试同域绑定」并剥离跨单元断言**：U1 的 `feed-downloads-ui.spec.mjs` 只断言 `HomeFeed.vue`；`src/style.css` 源码断言收归 U2 的 `playlist-panel.spec.mjs`；U3 独占 `glitch-text.spec.mjs` | 3 个单元文件集完全互斥且无跨单元断言依赖，可同时并行派发 3 个 `subagent_general` 各自独立跑绿单测 |

---

## 四、逐文件改动清单与精确规格

### 4.1 `src/components/HomeFeed.vue`（归属单元 U1）

#### 定位引文 1：模板区（第 1–132 行）
```vue
    <header class="home-head">
      <p class="pg-label">discover</p>
      <h2 class="home-title" data-nosnippet><GlitchText text="发现音乐" /></h2>
    </header>
```
以及 `.home-songs` 单曲网格、歌单货架（`v-if="recentPlaylists.length"`）、专辑货架（`v-if="recentAlbums.length"`）。

#### 改动规格 1：模板重构
1. **页头重构与「随机漫游」按钮（修复 #8）**：
   ```vue
    <header class="home-head">
      <div class="home-head-text">
        <p class="pg-label">overview</p>
        <h2 class="home-title" data-nosnippet><GlitchText text="音乐概览" /></h2>
      </div>
      <button
        type="button"
        class="ink-btn ink-btn--ghost ink-btn--sm home-roam-btn"
        :disabled="!recents.length"
        title="随机漫游最近单曲"
        @click="roamRecents"
      ><PixelIcon name="shuffle" :size="14" /> 随机漫游</button>
    </header>
   ```
2. **最近单曲节（修复 #1、#5、#6、#7、#8、#11、#12、#14）**：
   - 节头左文改为 `<div class="home-section-title"><p class="pg-label">recent</p><span class="home-section-sub">最近单曲</span></div>`（移动端采用横向 scroll-snap，不挂翻页按钮）。
   - 单曲行反嵌套零死区结构：
     ```vue
      <div class="home-songs">
        <div
          v-for="song in visibleRecents"
          :key="song.id"
          class="home-songrow"
          :class="{ 'home-songrow--playing': isSongPlaying(song) }"
          @click="$emit('play-song', song, recents)"
        >
          <button
            type="button"
            class="home-songrow-main"
            :title="`${song.name} - ${songArtists(song)}`"
            :aria-current="isSongPlaying(song) ? 'true' : undefined"
          >
            <!-- alt 留空：封面与紧邻歌名同源——命名会让 SR 把歌名报两遍 -->
            <img
              v-if="songThumbUrl(song, 96) && !coverErrs.has(`s:${song.id}`)"
              :src="httpsCover(songThumbUrl(song, 96))"
              alt=""
              class="home-songrow-cover"
              loading="lazy"
              decoding="async"
              @error="coverErrs.add(`s:${song.id}`)"
            />
            <span v-else class="home-songrow-cover home-songrow-fb" aria-hidden="true"><PixelIcon name="note" :size="14" /></span>
            <span class="home-songrow-info">
              <span class="home-songrow-name">{{ song.name }}</span>
              <span class="home-songrow-artist">{{ songSubline(song) }}</span>
            </span>
          </button>
          <button
            type="button"
            class="row-add-btn pg-icobtn pg-icobtn--bare pg-icobtn--sm"
            title="添加到歌单"
            aria-label="添加到歌单"
            aria-haspopup="dialog"
            @click.stop="$emit('add-to-playlist', song, $event.currentTarget)"
          ><PixelIcon name="plus" :size="14" /></button>
        </div>
      </div>
     ```
     - 删除原 `.home-src-tag` 节点。
3. **常听歌单货架（修复 #1、#3、#8、#9、#11、#12、#15）**：
   ```vue
    <!-- 常听歌单货架：优先 recentPlaylists（活副本富化），空时回退 userPlaylists 前 8 项；
         sidebarOpen && ≥901px 时收起避免与展开侧栏重复 -->
    <section v-if="showPlaylistShelf" class="home-section">
      <div class="home-section-head">
        <div class="home-section-title">
          <p class="pg-label">playlists</p>
          <span class="home-section-sub">常听歌单</span>
        </div>
        <div v-if="shelfNav.pl.canScroll" class="home-shelf-nav">
          <button
            type="button"
            class="pg-icobtn pg-icobtn--sm home-shelf-btn"
            title="上一页"
            aria-label="常听歌单上一页"
            :disabled="!shelfNav.pl.canPrev"
            @click="scrollShelf('pl', -1)"
          ><PixelIcon name="chev-l" :size="14" /></button>
          <button
            type="button"
            class="pg-icobtn pg-icobtn--sm home-shelf-btn"
            title="下一页"
            aria-label="常听歌单下一页"
            :disabled="!shelfNav.pl.canNext"
            @click="scrollShelf('pl', 1)"
          ><PixelIcon name="chev-r" :size="14" /></button>
        </div>
      </div>
      <div ref="plShelfEl" class="home-shelf" @scroll.passive="updateShelfNav('pl')">
        <div
          v-for="pl in displayPlaylists"
          :key="pl.id"
          class="grid-card"
          :class="{ 'grid-card--playing': isPlaylistPlaying(pl) }"
          :aria-current="isPlaylistPlaying(pl) ? 'true' : undefined"
          @click="$emit('open', pl)"
        >
          <div class="grid-card-cover">
            <img
              v-if="coverSizeUrl(pl.coverImgUrl, 320) && !coverErrs.has(`pl:${pl.id}`)"
              :src="httpsCover(coverSizeUrl(pl.coverImgUrl, 320))"
              alt=""
              loading="lazy"
              decoding="async"
              @error="coverErrs.add(`pl:${pl.id}`)"
            />
            <div v-else class="grid-card-cover-fallback"><PixelIcon name="note" :size="22" /></div>
            <span v-if="isPlaylistPlaying(pl)" class="grid-card-badge" aria-hidden="true"><PixelIcon name="vol" :size="11" /> 播放中</span>
            <button
              type="button"
              class="grid-card-play"
              title="播放歌单"
              :aria-label="`播放歌单 ${pl.name}`"
              @click.stop="$emit('play-playlist', pl)"
            ><PixelIcon name="play" :size="14" /></button>
          </div>
          <div
            class="grid-card-body grid-card-main"
            role="button"
            tabindex="0"
            :aria-current="isPlaylistPlaying(pl) ? 'true' : undefined"
            :title="`打开《${pl.name}》`"
            @keydown.enter="$emit('open', pl)"
            @keydown.space.prevent="$emit('open', pl)"
          >
            <h3 class="grid-card-name">{{ pl.name }}</h3>
            <p class="grid-card-meta">{{ pl.trackCount ? `${pl.trackCount} 首` : '歌单' }}</p>
          </div>
        </div>
      </div>
    </section>
   ```
4. **涉猎专辑货架（修复 #1、#3、#8、#10、#11、#15）**：
   ```vue
    <!-- 涉猎专辑货架（从最近播放歌曲的 al 派生，按专辑去重并聚合本地同键曲目） -->
    <section v-if="recentAlbums.length" class="home-section">
      <div class="home-section-head">
        <div class="home-section-title">
          <p class="pg-label">albums</p>
          <span class="home-section-sub">涉猎专辑</span>
        </div>
        <div v-if="shelfNav.al.canScroll" class="home-shelf-nav">
          <button
            type="button"
            class="pg-icobtn pg-icobtn--sm home-shelf-btn"
            title="上一页"
            aria-label="涉猎专辑上一页"
            :disabled="!shelfNav.al.canPrev"
            @click="scrollShelf('al', -1)"
          ><PixelIcon name="chev-l" :size="14" /></button>
          <button
            type="button"
            class="pg-icobtn pg-icobtn--sm home-shelf-btn"
            title="下一页"
            aria-label="涉猎专辑下一页"
            :disabled="!shelfNav.al.canNext"
            @click="scrollShelf('al', 1)"
          ><PixelIcon name="chev-r" :size="14" /></button>
        </div>
      </div>
      <div ref="alShelfEl" class="home-shelf" @scroll.passive="updateShelfNav('al')">
        <div
          v-for="al in recentAlbums"
          :key="al.key"
          class="grid-card"
          :class="{ 'grid-card--playing': isAlbumPlaying(al) }"
          :aria-current="isAlbumPlaying(al) ? 'true' : undefined"
          @click="playAlbum(al)"
        >
          <div class="grid-card-cover">
            <img
              v-if="coverSizeUrl(al.picUrl, 320) && !coverErrs.has(`al:${al.key}`)"
              :src="httpsCover(coverSizeUrl(al.picUrl, 320))"
              alt=""
              loading="lazy"
              decoding="async"
              @error="coverErrs.add(`al:${al.key}`)"
            />
            <div v-else class="grid-card-cover-fallback"><PixelIcon name="note" :size="22" /></div>
            <span v-if="isAlbumPlaying(al)" class="grid-card-badge" aria-hidden="true"><PixelIcon name="vol" :size="11" /> 播放中</span>
          </div>
          <div
            class="grid-card-body grid-card-main"
            role="button"
            tabindex="0"
            :aria-current="isAlbumPlaying(al) ? 'true' : undefined"
            :title="`播放《${al.name}》来源曲 ${al.song.name}`"
            @keydown.enter="playAlbum(al)"
            @keydown.space.prevent="playAlbum(al)"
          >
            <h3 class="grid-card-name">{{ al.name }}</h3>
            <p class="grid-card-meta">{{ `${al.artist} · 含《${al.song.name}》` }}</p>
          </div>
        </div>
      </div>
    </section>
   ```

#### 定位引文 2：脚本区（第 134–217 行）
```js
import { ref, reactive, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { httpsCover } from '../lib/url'
import { readScrollMem, writeScrollMem, restoreScrollTop } from '../lib/scroll-mem'
import { songArtists, songCoverUrl, coverSizeUrl, songThumbUrl, songSourceTag } from '../lib/song'
```

#### 改动规格 2：脚本逻辑
1. **导入扩充**：
   - 从 `'vue'` 补充导入 `watch`；
   - 从 `'../lib/song'` 补充导入 `isSingleSongShellId`。
2. **辅助纯函数 `albumKeyOf(song)`**：
   ```js
   const albumKeyOf = (song) => {
     const al = song?.al || song?.album
     const rawId = al?.id
     return (rawId != null && String(rawId) !== '0' ? rawId : null)
       || (song?.qq?.albummid ? `qq:${song.qq.albummid}` : null)
   }
   ```
3. **Props 与 Emits 扩充**：
   ```js
   props: {
     recentPlaylists: { type: Array, default: () => [] },
     userPlaylists: { type: Array, default: () => [] },
     recents: { type: Array, default: () => [] },
     currentSongId: { type: [String, Number], default: null },
     playingPlaylistId: { type: [String, Number], default: null },
     sidebarOpen: { type: Boolean, default: false }
   },
   emits: ['open', 'play-song', 'play-playlist', 'add-to-playlist'],
   ```
4. **Computed 属性**：
   - `displayPlaylists()`：
     - 若 `this.recentPlaylists.length > 0`：遍历 `this.recentPlaylists`，在 `this.userPlaylists` 中查找 `String(p?.id) === String(pl?.id)` 的活副本 `live`；若命中则返回 `{ ...pl, ...live, coverImgUrl: live.coverImgUrl || live.picUrl || pl.coverImgUrl || '', trackCount: live.trackCount ?? live.tracks?.length ?? pl.trackCount }`，否则返回 `pl`。
     - 若 `this.recentPlaylists.length === 0`：返回 `this.userPlaylists.filter(p => p && p.id != null && !isSingleSongShellId(p.id)).slice(0, 8)`。
   - `showPlaylistShelf()`：
     - `return !(this.sidebarOpen && this.wideViewport) && this.displayPlaylists.length > 0`
   - `hasShelves()`：
     - `return this.showPlaylistShelf || this.recentAlbums.length > 0`
   - `visibleRecents()`：保持 `this.recents.slice(0, RECENT_DISPLAY_CAP)`。
   - `recentAlbums()`：
     - 先收集本地同专辑候选池：遍历 `this.recents` 及 `this.userPlaylists` 中各歌单的 `tracks` 与 `addedTracks`，按 `albumKeyOf(s)` 分桶并按 `String(s.id)` 去重。
     - 再按既有准入两闸（`key = albumKeyOf(song)` 非空 ∧ `norm(al?.name) !== norm(song?.name)`）从 `this.recents` 顺序选出前 12 张去重专辑，每项结构为：
       `{ key, name: al?.name ?? '', picUrl: songCoverUrl(song) || '', artist: songArtists(song), song, tracks: bucket.get(key) || [song] }`。
5. **Methods / Setup 交互方法**：
   - `songSubline(song)`：
     ```js
     const artist = songArtists(song)
     const src = songSourceTag(song)
     return src ? `${artist} · ${src}` : artist
     ```
   - `roamRecents()`：
     ```js
     if (!this.recents.length) return
     const pool = this.recents.slice()
     for (let i = pool.length - 1; i > 0; i--) {
       const j = Math.floor(Math.random() * (i + 1))
       ;[pool[i], pool[j]] = [pool[j], pool[i]]
     }
     this.$emit('play-song', pool[0], pool)
     ```
   - `playAlbum(al)`：
     ```js
     const queue = Array.isArray(al?.tracks) && al.tracks.length >= 2 ? al.tracks : this.recents
     this.$emit('play-song', al.song, queue)
     ```
   - `isSongPlaying(song)`：
     `this.currentSongId != null && song?.id != null && String(song.id) === String(this.currentSongId)`
   - `isPlaylistPlaying(pl)`：
     `this.playingPlaylistId != null && pl?.id != null && String(pl.id) === String(this.playingPlaylistId)`
   - `isAlbumPlaying(al)`：
     `this.currentSongId != null && Array.isArray(al?.tracks) && al.tracks.some(s => String(s?.id) === String(this.currentSongId))`
   - **视口门控与货架翻页状态机（`setup(props)` 内）**：
     - `wideViewport = ref(false)`：通过 `window.matchMedia?.('(min-width: 901px)')` 初始化 `wideViewport.value = !!mq?.matches`，监听 `change` 事件并在 `onBeforeUnmount` 解绑。
     - `plShelfEl = ref(null)`、`alShelfEl = ref(null)`。
     - `shelfNav = reactive({ pl: { canScroll: false, canPrev: false, canNext: false }, al: { canScroll: false, canPrev: false, canNext: false } })`。
     - `updateShelfNav(kind)`：
       ```js
       const el = kind === 'pl' ? plShelfEl.value : alShelfEl.value
       const nav = shelfNav[kind]
       if (!el) { nav.canScroll = false; nav.canPrev = false; nav.canNext = false; return }
       const max = el.scrollWidth - el.clientWidth
       nav.canScroll = max > 1
       nav.canPrev = nav.canScroll && el.scrollLeft > 1
       nav.canNext = nav.canScroll && el.scrollLeft < max - 1
       ```
     - `updateAllShelfNav()`：同时更新 `'pl'` 与 `'al'`；在 `onMounted`（`nextTick`）、`window` `resize`、以及 `watch(() => [props.recentPlaylists.length, props.userPlaylists.length, props.recents.length, props.sidebarOpen, wideViewport.value], () => nextTick(updateAllShelfNav))` 中触发。
     - `scrollShelf(kind, dir)`：
       ```js
       const el = kind === 'pl' ? plShelfEl.value : alShelfEl.value
       if (!el) return
       const delta = dir * (el.clientWidth || 320)
       if (typeof el.scrollBy === 'function') {
         el.scrollBy({ left: delta, behavior: 'smooth' })
       } else {
         el.scrollLeft += delta
       }
       updateShelfNav(kind)
       ```

#### 改动规格 3：`HomeFeed.vue` Scoped CSS
1. **`.home-head` 与 `.home-section-head`**：
   ```css
   .home-head {
     display: flex;
     align-items: flex-end;
     justify-content: space-between;
     gap: 16px;
     padding: 0 0 16px;
     position: relative;
   }
   .home-section-head {
     display: flex;
     align-items: baseline;
     justify-content: space-between;
     gap: 10px;
     margin-bottom: 12px;
   }
   .home-section-title {
     display: flex;
     align-items: baseline;
     gap: 10px;
     min-width: 0;
   }
   .home-shelf-nav {
     margin-left: auto;
     display: flex;
     align-items: center;
     gap: 4px;
     flex-shrink: 0;
     align-self: center;
   }
   ```
2. **`.home-songrow` 微框、反白播放态与移动端三行横滑**：
   ```css
   .home-songrow {
     display: flex;
     align-items: center;
     gap: 6px;
     min-width: 0;
     padding: 6px 8px;
     border: var(--hairline-soft);
     background: var(--paper);
     cursor: pointer;
     transition: background .12s, border-color .12s;
   }
   .home-songrow:hover {
     background: var(--ink-06);
     border: var(--hairline);
   }
   .home-songrow-main {
     flex: 1;
     min-width: 0;
     display: flex;
     align-items: center;
     gap: 10px;
     text-align: left;
     cursor: pointer;
   }
   .home-songrow--playing,
   .home-songrow--playing:hover {
     background: var(--ink);
     border: var(--hairline);
   }
   .home-songrow--playing .home-songrow-name { color: var(--paper); }
   .home-songrow--playing .home-songrow-artist { color: var(--label-grey); }
   .home-songrow--playing .home-songrow-cover { border-color: var(--paper); }
   .home-songrow--playing .row-add-btn { color: var(--label-grey); }
   .home-songrow--playing .row-add-btn:hover {
     color: var(--paper);
     outline-color: var(--paper);
   }
   ```
3. **封面去锯齿与废弃样式清理**：
   - `.home-songrow-cover`：**删除** `image-rendering: pixelated;`。
   - **删除** `.home-src-tag` 规则块。
4. **移动端 `≤640.98px` 三行横向 scroll-snap 滑轨**：
   ```css
   @media (max-width: 640.98px) {
     .home-songs {
       grid-template-columns: none;
       grid-auto-flow: column;
       grid-template-rows: repeat(3, auto);
       grid-auto-columns: min(88vw, 320px);
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
5. **`.home-shelf` 左轴对齐与右缘出血**：
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

---

### 4.2 `src/App.vue`（归属单元 U1）

#### 定位引文（第 78–84 行）
```vue
        <HomeFeed
          v-if="centerView === 'home'"
          :recent-playlists="playlistHistory"
          :recents="playHistory"
          @open="openShelfPlaylist"
          @play-song="openWatchRecent"
        />
```

#### 改动规格
1. 将 `<HomeFeed>` 绑定扩充为：
   ```vue
        <HomeFeed
          v-if="centerView === 'home'"
          :recent-playlists="playlistHistory"
          :user-playlists="userPlaylists"
          :recents="playHistory"
          :current-song-id="currentSong?.id ?? null"
          :playing-playlist-id="playingPlaylistId"
          :sidebar-open="sidebarOpen"
          @open="openShelfPlaylist"
          @play-song="openWatchRecent"
          @play-playlist="playShelfPlaylist"
          @add-to-playlist="handleOpenAddToPlaylist"
        />
   ```
2. 在 `App.vue` `setup()` 内新增 `playShelfPlaylist` 并导出到返回对象：
   ```js
   const playShelfPlaylist = (pl) => {
     if (!pl) return
     const live = userPlaylists.value.find(p => String(p.id) === String(pl.id))
     return playPlaylistFromSidebar(live || pl)
   }
   ```
   （与 `openShelfPlaylist` 同律：当 `pl` 来自 `playlistHistory` 快照 stub 且歌单仍在 `userPlaylists` 库中时，优先以带完整本地 `tracks`/`addedTracks` 的活副本调 `playPlaylistFromSidebar`）。

---

### 4.3 `src/style.css`（归属单元 U2）

#### 定位引文 1：焦点环、高对比模式、彩布白名单与反白行尾键（第 559–740 行）
```css
.song-result-main:focus-visible, .home-songrow:focus-visible,
```
```css
@media (forced-colors: active) {
  .pl-row--active, .pg-tab--active, .pg-chip--on, .dql-row--sel,
  .queue-row--current, .song-row--playing, .song-result-row--playing,
```
```css
.app-shell .app-body .grid-state-text, .app-shell .app-body .home-section-sub, .app-shell .app-body .home-state-text,
```
```css
.app-shell .song-row--playing .song-menu-btn:hover {
  color: var(--paper);
  outline-color: var(--paper);
}
```
```css
:root[data-theme="glitch-restoration"] .app-shell .song-row--playing .song-menu-btn:hover {
  color: var(--accent-magenta-on-ink);
  outline-color: var(--paper);
}
```

#### 定位引文 2：`.row-add-btn` 与 `.grid-card` 家族（第 1440–1522 行）
```css
.queue-row:hover .row-add-btn,
.queue-row:focus-within .row-add-btn,
.song-result-row:hover .row-add-btn,
.song-result-row:focus-within .row-add-btn,
.row-add-btn:focus-visible { opacity: 1; pointer-events: auto; }
```
```css
.grid-card-main { cursor: pointer; }
...
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
...
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
```

#### 改动规格
1. **焦点环与 `forced-colors` 登记**：
   - 第 563 行增加 `.home-songrow-main:focus-visible, .grid-card-play:focus-visible`。
   - 第 594 行 `@media (forced-colors: active)` 增加 `.home-songrow--playing, .grid-card--playing`。
2. **彩布次级文字白名单与反白补丁带**：
   - 第 683 行 `.app-shell .app-body` 白名单加入 `.app-shell .app-body .home-songrow-artist`。
   - 第 707 行白名单补丁带新增：
     ```css
     .app-shell .app-body .home-songrow--playing .home-songrow-artist {
       color: var(--label-grey);
     }
     ```
   - 第 721 行与第 735 行反白行尾键 hover 扩充 `.app-shell .home-songrow--playing .row-add-btn:hover`（默认主题 `color: var(--paper); outline-color: var(--paper)`，`glitch-restoration` 主题 `color: var(--accent-magenta-on-ink); outline-color: var(--paper)`）。
3. **`.row-add-btn` 悬停/聚焦显隐接入 `.home-songrow`**：
   - 第 1451 行后加入：
     ```css
     .home-songrow:hover .row-add-btn,
     .home-songrow:focus-within .row-add-btn,
     ```
4. **`.grid-card` 去 `min-height: 2.7em`、去 `pixelated`、新增 `.grid-card-play` / `.grid-card-badge` / `.grid-card--playing`**：
   - `.grid-card-main` 改为 `cursor: pointer; flex: 1; display: flex; flex-direction: column; gap: 8px;`（兼顾 `PlaylistGrid.vue` 与 `HomeFeed.vue`）。
   - `.grid-card-body` 增加 `flex: 1;`；`.grid-card-meta` 增加 `margin-top: auto;`。
   - `.grid-card-name` **删除** `min-height: 2.7em;`。
   - `.grid-card-cover` 增加 `position: relative;`；`.grid-card-cover img` **删除** `image-rendering: pixelated;`。
   - 新增 `.grid-card--playing`、`.grid-card-badge`、`.grid-card-play` 全局规则：
     ```css
     .grid-card--playing {
       border-color: var(--accent-magenta-ink, var(--ink));
       box-shadow: inset 0 0 0 1.2px var(--accent-magenta-ink, var(--ink));
     }
     .grid-card-badge {
       position: absolute;
       top: 6px;
       left: 6px;
       display: inline-flex;
       align-items: center;
       gap: 4px;
       padding: 2px 6px;
       background: var(--ink);
       color: var(--paper);
       border: 1px solid var(--paper);
       font-family: var(--font-mono);
       font-size: 10px;
       line-height: 1.2;
       pointer-events: none;
     }
     .grid-card-play {
       position: absolute;
       right: 6px;
       bottom: 6px;
       width: 28px;
       height: 28px;
       display: inline-flex;
       align-items: center;
       justify-content: center;
       background: var(--ink);
       color: var(--paper);
       border: 1.2px solid var(--paper);
       opacity: 0;
       pointer-events: none;
       transition: opacity .12s, color .2s;
     }
     .grid-card:hover .grid-card-play,
     .grid-card:focus-within .grid-card-play,
     .grid-card-play:focus-visible {
       opacity: 1;
       pointer-events: auto;
     }
     .grid-card-play:hover {
       color: var(--accent-magenta-on-ink, var(--paper));
     }
     @media (hover: none) {
       .grid-card-play {
         opacity: 1;
         pointer-events: auto;
       }
     }
     ```

---

### 4.4 `src/components/PlaylistPanel.vue`（归属单元 U2）

#### 定位引文（第 550–600 行）
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
及窄轨 `@media (min-width: 768px) and (max-width: 1023.98px)` 块。

#### 改动规格（修复 #2）
1. 将 `.panel-head`、`.panel-label`、`.panel-create-btn` 更新为：
   ```css
   .panel-head {
     display: flex;
     align-items: flex-start;
     justify-content: space-between;
     padding-right: 22px;
     flex-shrink: 0;
   }

   .panel-label {
     padding: 0 12px 12px; /* 顶距 0：严格落在 20px 首行轴，与主区 .home-head .pg-label 同轴 */
     flex-shrink: 0;
   }

   /* 32px 按钮上收 10px 进入 .playlist-panel 的 20px 顶留白带：
      按钮中心 (-10 + 16 = 6px) 与 12px 高 .panel-label 中心 (6px) 同心，且不撑高首行 */
   .panel-create-btn { margin: -10px 0 4px; }
   ```
2. 在 `@media (min-width: 768px) and (max-width: 1023.98px)` 中新增窄轨未展开态复位：
   ```css
   .app-sidebar:not(.app-sidebar--open) .panel-create-btn { margin: 0 0 6px; }
   ```

---

### 4.5 `src/components/GlitchText.vue` 与 `src/components/PrintMarks.vue`（归属单元 U3）

#### 定位引文 1：`src/components/GlitchText.vue`（第 38–164 行）
```js
const HAN_POOL = [...'烫烫烫烫屯屯屯屯锟斤拷锟斤拷锟斤拷锘锘浣犲ソ娴嬭瘯鏄鐨鎴戜滑鍙戝ぇ瀹闂ㄨ瘯鐮佸織榧犺阿鐢熸妸鍚庡湴鍧戝潃鍧\uFFFD▓░▒█▓░▒█']
```

#### 改动规格 1：`GlitchText.vue`（修复 #13）
1. **替换 `HAN_POOL`（去 `烫屯锟斤拷锘\uFFFD` 等乱码汉字，首元定为 `'█'`）**：
   ```js
   const HAN_POOL = [...'█▓░▒▛▜▟▙▪▫◇◆◈╋╂┼┤├┬┴─│ﾂﾎﾃﾄﾅﾌﾑﾒﾓﾘﾚﾖﾊﾋﾍﾐﾕﾗﾆﾇ∆∑§¤†‡']
   ```
2. **新增 `ambient` prop**：
   ```js
   props: {
     text: { type: String, required: true },
     ambient: { type: Boolean, default: true }
   },
   ```
3. **改 `setInterval(tick, 1100)` 为「长静默 + 短微闪」脉冲状态机**：
   - 定义常数：`const PULSE_IDLE_MIN_MS = 3800`、`const PULSE_IDLE_JITTER_MS = 1200`、`const PULSE_HOLD_MS = 200`。
   - 定义定时器句柄：`let timer = 0`、`let pulseTimer = 0`、`let burstTimer = 0`。
   - `schedulePulse()`：
     ```js
     clearTimeout(timer)
     const delay = PULSE_IDLE_MIN_MS + (Math.random() * PULSE_IDLE_JITTER_MS | 0)
     timer = setTimeout(tick, delay)
     ```
   - `tick()`：
     ```js
     const clean = []
     words.value.forEach((word, wi) =>
       word.chars.forEach((ch, ci) => clean.push({ k: keyOf(wi, ci), ch }))
     )
     if (clean.length) {
       corrupt.value.clear()
       const count = clean.length > 6 ? 1 + (Math.random() * 2 | 0) : 1
       const pool = clean.slice()
       for (let i = 0; i < count && pool.length; i++) {
         const idx = Math.random() * pool.length | 0
         const [{ k, ch }] = pool.splice(idx, 1)
         corrupt.value.set(k, pickFor(ch))
       }
       clearTimeout(pulseTimer)
       pulseTimer = setTimeout(() => { corrupt.value.clear() }, PULSE_HOLD_MS)
     }
     if (active.value && props.ambient) schedulePulse()
     ```
   - `stop()`：
     ```js
     clearTimeout(timer)
     clearTimeout(pulseTimer)
     clearTimeout(burstTimer)
     timer = 0
     pulseTimer = 0
     corrupt.value.clear()
     ```
   - `watch([active, () => props.ambient], ([on, amb]) => { stop(); if (on && amb) schedulePulse() }, { immediate: true })`。
   - `watch(() => props.text, () => { clearTimeout(burstTimer); clearTimeout(pulseTimer); corrupt.value.clear() })`。
   - `watch(glitchGen, () => { if (active.value) burst() })` 保持只看 `active.value`（使 `:ambient="false"` 的实例在全局错误 burst 时依然参与 480ms 闪回）。

#### 改动规格 2：`src/components/PrintMarks.vue`（修复 #13）
- 将 `variant === 'stamp'` 下的三行 `<GlitchText>` 加上 `:ambient="false"`：
  ```vue
  <div v-else-if="variant === 'stamp'" class="pg-stamp">
    <p><GlitchText text="MeowSync · Version 1.0.0" :ambient="false" /></p>
    <p><GlitchText text="©2026 · All rights reserved" :ambient="false" /></p>
    <p><GlitchText text="Made with Love" :ambient="false" /></p>
  </div>
  ```

---

## 五、测试契约（按正交单元隔离）

### 5.1 `tests/ui/feed-downloads-ui.spec.mjs`（归属单元 U1，仅断言 `HomeFeed.vue`）
1. **适配既有断言**：
   - 原 `songrow 渲封面/歌名/歌手/来源徽标，点击发 play-song`：断言 `r.find('.home-src-tag').exists() === false`，且 `rows.map(r => r.find('.home-songrow-artist').text())` 等于 `['艺人A · 网易云', 'UP主 · YouTube', 'UP乙 · B站', '艺 · QQ音乐', '艺丙 · QQ音乐']`。
   - 原 `过滤后无真专辑时专辑 section 整段不渲染`：断言 `expect(w.text()).not.toContain('涉猎专辑')`。
2. **新增 `HomeFeed` 专项用例**：
   - **页头与随机漫游**：断言 `.home-head .pg-label` 为 `'overview'`、`.home-title` 含 `'音乐概览'`；`recents=[]` 时 `.home-roam-btn` 为 `disabled`；非空点击触发 `play-song(pool[0], pool)`，队列含全量 `recents` 成员且不篡改原数组。
   - **歌单货架门控、空回退（滤 `single_song_`）与活副本富化**：
     - `recentPlaylists=[]` 且传入含 `single_song_1` 的 10 项 `userPlaylists` 时，渲染 8 张 `.grid-card` 且不含 `single_song_1`；
     - `recentPlaylists` 含旧歌单名而 `userPlaylists` 含同 `id` 新歌单名/曲数时，渲染最新名称与曲数；
     - `sidebarOpen=true` 且 `window.matchMedia('(min-width: 901px)').matches=true` 时，歌单货架不渲染。
   - **专辑卡诚实 meta、跨 `recents`+`userPlaylists` 同键曲目聚合与封面 `alt=""`**：
     - 专辑卡 `.grid-card-meta` 为 `'艺人A · 含《真曲》'`；所有 `.grid-card-cover img` 的 `alt` 为 `""`；
     - 同 `al.key` 有 `≥2` 首曲目（无论在 `recents` 还是 `userPlaylists`）时，点击专辑卡 emit 的队列参数为去重后的该专辑曲目数组；仅 1 首时回退为 `recents`。
   - **播放态高亮与 `aria-current`**：传入 `currentSongId` / `playingPlaylistId` 时，命中单曲行挂 `.home-songrow--playing` 且 `.home-songrow-main` 的 `aria-current="true"`；命中歌单卡与专辑卡挂 `.grid-card--playing`、渲染 `.grid-card-badge` 且 `aria-current="true"`。
   - **快捷操作与反嵌套零违规**：断言 `w.find('button button').exists() === false` 且 `w.find('[role="button"] button').exists() === false`；点击 `.row-add-btn` 触发 `add-to-playlist(song, btnEl)` 且不触发 `play-song`；点击 `.grid-card-play` 触发 `play-playlist(pl)` 且不触发 `open`。
   - **货架翻页按钮 `[‹][›]`**：模拟 `.home-shelf` 的 `clientWidth: 360, scrollWidth: 900, scrollLeft: 0` 并触发 `resize`，断言 `.home-shelf-nav` 出现、上一页 `disabled`、下一页可用，点击下一页调用 `scrollBy`；`scrollLeft: 540` 触发 `scroll` 后上一页可用、下一页 `disabled`。
   - **`HomeFeed.vue` 封面去 `pixelated` 源码断言**：断言 `HomeFeed.vue` 的 `.home-songrow-cover` 不含 `image-rendering: pixelated`。

### 5.2 `tests/ui/playlist-panel.spec.mjs`（归属单元 U2，断言 `PlaylistPanel.vue` 与 `src/style.css`）
1. 新增断言 `PlaylistPanel.vue` 的 `.panel-head` 使用 `align-items: flex-start`、`.panel-label` 顶内边距为 `0`、`.panel-create-btn` 含负顶距 `-10px`。
2. 新增断言 `src/style.css` 中 `.grid-card-name` 不含 `min-height: 2.7em`、`.grid-card-cover img` 不含 `image-rendering: pixelated`、`.app-shell .app-body` 白名单含 `.home-songrow-artist`。

### 5.3 `tests/ui/glitch-text.spec.mjs`（归属单元 U3，断言 `GlitchText.vue` 与 `PrintMarks.vue`）
1. 将 `'漢'` 与 `'𠮷'` 的 `HAN_POOL[0]` 期望值从 `'烫'` 更新为 `'█'`；新增断言 `GlitchText.vue` 源码不含 `'烫'`、`'屯'`、`'锟'`、`'斤'`、`'拷'`、`'锘'`、`'\uFFFD'`。
2. 更新 `tick 主路径同走分流` 为脉冲时序测试：`vi.advanceTimersByTime(3799)` 时 `corrupt.size === 0`；再推进 `1ms`（达 `3800ms`）命中脉冲，`corrupt.get('0:0') === '█'` 且 `corrupt.size === 1`；再推进 `200ms` 微闪结束，`corrupt.size === 0`。
3. 新增 `:ambient="false"` 与 `PrintMarks` 测试：挂载 `<GlitchText text="MeowSync" :ambient="false" />` 推进 `10000ms` 恒 `corrupt.size === 0`，调用 `glitchBurst()` 后正常响应全闪；`PrintMarks.vue` 中 `variant="stamp"` 的三处 `GlitchText` 均绑定 `:ambient="false"`。

---

## 六、3 个正交实施单元切分表（可同时并行派发 `subagent_general`）

| 实施单元 | 独占修改文件（互不重叠） | 覆盖缺陷编号 | 单元内自验命令 |
| :--- | :--- | :--- | :--- |
| **U1：主页发现流与宿主接线域** | `src/components/HomeFeed.vue`<br>`src/App.vue`<br>`tests/ui/feed-downloads-ui.spec.mjs` | #1, #3, #5, #6, #7, #8, #9, #10, #11, #12, #14(组件侧), #15 | `npx vitest run tests/ui/feed-downloads-ui.spec.mjs` |
| **U2：全局卡片/行样式与侧栏首行同轴域** | `src/style.css`<br>`src/components/PlaylistPanel.vue`<br>`tests/ui/playlist-panel.spec.mjs` | #2, #4, #11(全局态/对比度), #12(浮层显隐), #14(全局侧) | `npx vitest run tests/ui/playlist-panel.spec.mjs` |
| **U3：GlitchText 脉冲降噪与页脚静态化域** | `src/components/GlitchText.vue`<br>`src/components/PrintMarks.vue`<br>`tests/ui/glitch-text.spec.mjs` | #13 | `npx vitest run tests/ui/glitch-text.spec.mjs` |

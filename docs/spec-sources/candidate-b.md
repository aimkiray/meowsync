# 主页 HomeFeed 优雅化重构 — 可执行技术规格

- **协议版本**：cto-flow v1.3.0
- **目标分支**：`feature/download-manager`
- **涉及文件域**：
  - 视图与组件：`src/components/HomeFeed.vue`、`src/components/PlaylistPanel.vue`、`src/components/GlitchText.vue`、`src/components/PrintMarks.vue`、`src/App.vue`
  - 全局样式：`src/style.css`
  - 单元与回归测试：`tests/ui/feed-downloads-ui.spec.mjs`、`tests/ui/glitch-text.spec.mjs`、`tests/ui/playlist-panel.spec.mjs`

---

## 一、动机（实机诊断 15 项缺陷与根因分析）

经桌面端与移动端实机勘察及源码走查，当前首页发现流（`HomeFeed.vue`）及周边关联组件存在以下 **15 项结构与体验缺陷**：

1. **左轴 `x=300 / 308 / 304` 三段错位**：
   - 桌面常驻侧栏宽 `280px`，`.home-feed` 水平内边距 `--page-pad-x: 20px`，故页头 `.home-head` 与各节头 `.home-section-head` 左缘位于 `x = 300px`。
   - `.home-songrow` 常态无边框且设 `padding: 6px 8px`，导致单曲行视觉起点（38px 封面左缘）内缩至 `x = 308px`。
   - `.home-shelf` 设 `padding: 4px 4px 8px` 且无负边距补偿，导致货架首卡 `.grid-card` 左缘落在 `x = 304px`。三类内容块左缘互不同轴。
2. **左右栏首行 `y` 坐标错位 6px**：
   - 顶栏高 `57.2px`。主区 `.home-feed` 靠 `border-top: 20px solid transparent` 下推，`.home-head .pg-label` 顶缘落在 `y ≈ 77.2px`。
   - 侧栏 `.playlist-panel` 虽有 `padding: 20px 0 0`，但 `.panel-head` 为 `align-items: center` 且内含 `.panel-label`（`padding: 8px 12px 10px`）与 `.panel-create-btn`（`32px` 高 + `margin: 4px 0 6px`），将 `library 我的歌单` 标签顶缘推低至 `y ≈ 83.2px`，与主区首行错位 `6px`。
3. **货架右缘半卡硬裁切且无翻页控件**：
   - `.home-shelf` 局限于内容盒宽度内（未向右出血跨过 `--page-pad-x`），横向溢出时末卡在距视口右缘 `20px` 处被突兀硬裁；且桌面端隐藏/细化滚动条下没有任何 `[‹][›]` 翻页按钮。
4. **`.grid-card` 单行标题下方 `~18px` 空洞**：
   - `src/style.css` 中 `.grid-card-name` 硬写 `min-height: 2.7em`（强占两行高），当歌单/专辑名为单行时，标题与 `.grid-card-meta` 之间出现约 `18px` 的空白断层。
5. **单曲行在大列宽下中部视觉断裂**：
   - `.home-songs` 采用 `repeat(auto-fill, minmax(230px, 1fr))`，当列宽撑到 `280~340px` 且单曲行无外框时，左侧歌名/歌手与最右侧来源 chip 之间出现大片无边界白底，行体松散断裂。
6. **来源 chip 黑框喧宾夺主**：
   - 每条 `.home-songrow` 行尾均挂一个 `1.2px` 实墨框 `.pg-chip.home-src-tag`（`网易云`/`B站`/`YouTube`/`QQ音乐`），12 个黑框在网格中形成强烈视觉噪音，抢走封面与歌名的注意力，还挤占了行尾操作键空间。
7. **移动端 12 行单列纵向霸屏**：
   - `≤640px` 下 `.home-songs` 退化为单列 12 行垂直堆叠（约 `650px` 高），用户在手机首屏只能看到单曲列表，下方的歌单与专辑货架被完全推出首屏之外。
8. **「发现音乐」与三个「最近播放」语义矛盾且重复**：
   - 页头叫 `discover / 发现音乐`，但全页没有任何远端推荐流，全是本地历史；三个分节又连续复读 `最近播放`、`最近播放的歌单`、`最近播放的专辑`，信息命名机械重复。
9. **桌面歌单货架与左侧栏重复、冷启动又为空**：
   - `recentPlaylists` 仅记录播放过的歌单历史（未播过则为空，移动端抽屉收起时用户看不到任何已有歌单）；而一旦播过，其信息又与左侧栏歌单库高度重叠且缺乏历史快照与活副本的同步富化。
10. **伪专辑卡只播单曲、曲目预期落空**：
    - `recentAlbums` 从 `recents` 派生，卡片 meta 仅显示歌手名，与真整张专辑无异；但点击只触发 `$emit('play-song', al.song, recents)` 播放一首代表曲并把 `recents` 当队列，即使本地有多首同专辑歌曲也未聚合。
11. **主页对「正在播放」零视觉与无障碍反馈**：
    - `HomeFeed` 未接收 `currentSong` 或 `playingPlaylistId`，无论当前正在播放哪首歌或哪个歌单，主页单曲行与货架卡均无高亮态或 `aria-current` 标记。
12. **单曲行缺收藏键、歌单卡缺直接播放键**：
    - 首页单曲行无法像搜索页/队列那样一键 `+` 添加到歌单；歌单货架卡只能点进详情页再点播放，缺少封面右下角 `▶` 一键起播能力。
13. **`GlitchText` 高频跳「锟斤拷烫烫烫」造成视觉疲劳**：
    - `GlitchText.vue` 的 `HAN_POOL` 高权重塞入 `烫屯锟斤拷`，且以 `setInterval(tick, 1100)` 每 1.1 秒持续驻留腐蚀，连页脚 `PrintMarks` 三行版权戳也在不停跳动，长期停留在主页极其刺眼。
14. **照片封面强制 `image-rendering: pixelated` 产生锯齿**：
    - `.home-songrow-cover` 与 `.grid-card-cover img` 均声明了 `image-rendering: pixelated`，导致三次元人像与渐变专辑封面在缩放时呈现劣质马赛克锯齿。
15. **货架卡封面 `alt=标题` 导致屏幕阅读器双读**：
    - `.home-songrow-cover` 已正确设置 `alt=""` 并在注释写明防双读，但歌单卡（`:alt="pl.name"`）与专辑卡（`:alt="al.name"`）仍把标题填进 `alt`，致屏幕阅读器对同一张卡连续朗读两遍名称。

---

## 二、共享设计规则（Canonical Rules）

- `[canonical]` **首行同轴律**：`.app-body` 内左右分栏的首行微标签（左侧 `.playlist-panel .panel-label` 与右侧主区 `.home-head .pg-label` / `.grid-head .pg-label`）顶缘必须同轴对齐在主区内容顶起点（距 `.app-body` 顶缘 `20px`），任何同行附属图标按钮不得通过 flex 居中撑高首行微标签的顶部偏移。
- `[canonical]` **左缘同轴与货架出血律**：主区视图内页头、节头、单曲网格微框外缘与横向货架首卡左缘必须严格同轴对齐在 `--page-pad-x` 轴线上；横向货架容器通过对称左内垫抵消负外边距（`padding-left: 12px; margin-left: -12px`）容纳卡片阴影，并通过右缘负外边距出血至容器右界（`margin-right: calc(-1 * var(--page-pad-x)); padding-right: var(--page-pad-x)`）。
- `[canonical]` **可交互容器反嵌套律**：凡内含独立操作按钮（如 `.row-add-btn`、`.grid-card-play`）的行或卡片，外层容器一律使用非交互语义标签（`<div>`），禁止使用 `<button>` 嵌套 `<button>`；主激活区与附属按钮必须互为同级兄弟节点，或附属按钮显式阻断冒泡（`@click.stop` 及键盘 `@keydown.enter.stop` / `@keydown.space.stop`）。
- `[canonical]` **封面装饰图静音律**：凡卡片/行内紧邻 `<h3 class="grid-card-name">` 或歌名文本的封面 `<img>`，一律设置 `alt=""`，防止屏幕阅读器重复播报同一标题。
- `[canonical]` **彩布与反白对比度登记律**：所有使用 `var(--ink-64)` 的次级文本类必须登记入 `src/style.css` 的 `.app-shell .app-body` 升档白名单；同时若该元素处于墨底反白容器（如 `.home-songrow--playing`）内，必须在白名单补丁带显式覆写为 `var(--label-grey)` 或 `var(--paper)`，防止 `(0,3,0)` 全局白名单吃掉反白态字色。

---

## 三、歌单货架设计取舍（CTO 方向 8 专项论证）

针对「桌面歌单货架与左侧栏重复、冷启动 `recentPlaylists` 为空」问题，对比三种候选方案：

| 维度 | 方案 A：侧栏打开时隐藏歌单货架 | 方案 B：升级为封面+曲目双联卡 | 方案 C：移动优先回退 `userPlaylists` + 活副本富化（**推荐**） |
| :--- | :--- | :--- | :--- |
| **核心机制** | `≥1024px` 或 `sidebarOpen` 时隐藏歌单货架，仅在窄屏侧栏收起时渲染 | 每张歌单卡拓宽为 `320px`，左封面右列前 3 首曲目 | 保持 `grid-card` 货架；有播放历史时按 `recentPlaylists` 最近序展示并用 `userPlaylists` 活副本同步字段；无历史时回退 `userPlaylists` 前 8 项（滤除单曲壳） |
| **零网络请求铁律** | 满足 | **违背或残缺**：`playlistHistory` 仅存 `{id,name,coverImgUrl,trackCount}`，远端歌单未点开前内存无 `tracks`，双联卡右栏大部分为空 | 满足（纯内存派生，零额外请求） |
| **桌面/移动一致性** | 差：桌面端当无真专辑时主页只剩 12 首单曲，下半屏大片留白；跨断点显隐跳变 | 中：双联卡与下方专辑 `grid-card` 栅格模数冲突 | 优：桌面按「最近常听时间序 + 大封面 + 一键直播」与侧栏「全量库目录」职责互补；移动端抽屉收起时提供首屏直达歌单入口 |
| **冷启动体验** | 桌面无感知，移动端新用户未播歌单前仍空缺 | 无历史时仍空缺 | **彻底解决**：新用户或刚导入歌单未播放时，货架自动回退展示库内前 8 个歌单 |

**结论与推荐契约**：采用 **方案 C**。
1. `HomeFeed.vue` 接收 `userPlaylists` prop（默认 `[]`）。
2. 定义计算属性 `displayPlaylists`：
   - 若 `recentPlaylists.length > 0`：遍历 `recentPlaylists`，若在 `userPlaylists` 中找到同 `id` 活副本 `live`（`String(p.id) === String(pl.id)`），则合并返回 `{ ...pl, ...live, coverImgUrl: live.coverImgUrl || live.picUrl || pl.coverImgUrl || '', trackCount: live.trackCount ?? live.tracks?.length ?? pl.trackCount }`；否则返回 `pl`。
   - 若 `recentPlaylists.length === 0`：从 `userPlaylists` 中过滤掉 `isSingleSongShellId(p?.id)` 的临时单曲分享壳，取前 8 项（`.slice(0, 8)`）。
3. `hasShelves` 改为 `this.displayPlaylists.length > 0 || this.recentAlbums.length > 0`。

---

## 四、逐文件改动清单与验收标准

### 4.1 `src/components/HomeFeed.vue`

#### 定位引文 1：页头与单曲网格模板
```vue
    <header class="home-head">
      <p class="pg-label">discover</p>
      <h2 class="home-title" data-nosnippet><GlitchText text="发现音乐" /></h2>
    </header>

    <!-- 最近播放：紧凑单曲卡网格（封面+两行信息+来源徽标）——纯文本胶囊
         不带封面辨识度低。行即 <button>，Enter/Space 天然可激活 -->
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
...
          <span class="home-songrow-info">
            <span class="home-songrow-name">{{ song.name }}</span>
            <span class="home-songrow-artist">{{ songArtists(song) }}</span>
          </span>
          <span
            v-if="songSourceTag(song)"
            class="pg-chip pg-chip--static home-src-tag"
          >{{ songSourceTag(song) }}</span>
        </button>
      </div>
    </section>
```

#### 改动规格 1（对应 CTO 方向 1、5、6、7、10、11、12）
1. **页头改为 `overview / 音乐概览` + `随机漫游` 按钮**：
   - `.home-head` 内左列包裹 `<div class="home-head-text"><p class="pg-label">overview</p><h2 class="home-title" data-nosnippet><GlitchText text="音乐概览" /></h2></div>`。
   - 右侧新增 `<button type="button" class="ink-btn ink-btn--ghost ink-btn--sm home-roam-btn" :disabled="!recents.length" title="随机漫游最近单曲" @click="roamRecents"><PixelIcon name="shuffle" :size="14" /> 随机漫游</button>`。
   - `roamRecents()` 方法：当 `!this.recents.length` 时直接返回；否则拷贝 `const pool = this.recents.slice()`，经 Fisher-Yates 洗牌后取 `pool[0]`，调用 `this.$emit('play-song', pool[0], pool)`。
2. **第一节副标题改为 `最近单曲`**：
   - `<span class="home-section-sub">最近单曲</span>`。
3. **单曲行解除 `<button>` 嵌套、并入来源文本、支持播放态与行尾 `+` 键**：
   - 外层改为 `<div v-for="song in visibleRecents" :key="song.id" class="home-songrow" :class="{ 'home-songrow--playing': isSongPlaying(song) }" @click="$emit('play-song', song, recents)">`。
   - 主激活区为 `<div class="home-songrow-main" role="button" tabindex="0" :aria-current="isSongPlaying(song) ? 'true' : undefined" :title="`${song.name} - ${songArtists(song)}`" @keydown.enter="$emit('play-song', song, recents)" @keydown.space.prevent="$emit('play-song', song, recents)">`，内含封面（`img.home-songrow-cover` 或 `.home-songrow-fb`）与 `.home-songrow-info`。
   - 第二行 `<span class="home-songrow-artist">{{ songSubline(song) }}</span>`，其中 `songSubline(song)` 返回 `songSourceTag(song) ? `${songArtists(song)} · ${songSourceTag(song)}` : songArtists(song)`。
   - 删除原 `<span v-if="songSourceTag(song)" class="pg-chip pg-chip--static home-src-tag">` 节点及 `.home-src-tag` 样式。
   - 在 `.home-songrow` 行尾（与 `.home-songrow-main` 同级）新增收藏按钮：
     ```vue
     <button
       type="button"
       class="row-add-btn pg-icobtn pg-icobtn--bare pg-icobtn--sm"
       title="添加到歌单"
       aria-label="添加到歌单"
       aria-haspopup="dialog"
       @click.stop="$emit('add-to-playlist', song, $event.currentTarget)"
     ><PixelIcon name="plus" :size="14" /></button>
     ```

---

#### 定位引文 2：两个横向货架模板
```vue
    <!-- 最近播放的歌单货架 -->
    <section v-if="recentPlaylists.length" class="home-section">
      <div class="home-section-head">
        <p class="pg-label">history</p>
        <span class="home-section-sub">最近播放的歌单</span>
      </div>
      <div class="home-shelf">
        <div
          v-for="pl in recentPlaylists"
          :key="pl.id"
          class="grid-card"
          @click="$emit('open', pl)"
          @keydown.enter="$emit('open', pl)"
          @keydown.space.prevent="$emit('open', pl)"
          tabindex="0"
          role="button"
          :title="`打开《${pl.name}》`"
        >
          <div class="grid-card-cover">
            <img
              v-if="coverSizeUrl(pl.coverImgUrl, 320) && !coverErrs.has(`pl:${pl.id}`)"
              :src="httpsCover(coverSizeUrl(pl.coverImgUrl, 320))"
              :alt="pl.name"
              loading="lazy"
              decoding="async"
              @error="coverErrs.add(`pl:${pl.id}`)"
            />
            <div v-else class="grid-card-cover-fallback"><PixelIcon name="note" :size="22" /></div>
          </div>
          <div class="grid-card-body">
            <h3 class="grid-card-name">{{ pl.name }}</h3>
            <p class="grid-card-meta">{{ pl.trackCount ? `${pl.trackCount} 首` : '歌单' }}</p>
          </div>
        </div>
      </div>
    </section>

    <!-- 最近播放的专辑货架（从最近播放歌曲的 al 派生，按专辑去重） -->
    <section v-if="recentAlbums.length" class="home-section">
      <div class="home-section-head">
        <p class="pg-label">albums</p>
        <span class="home-section-sub">最近播放的专辑</span>
      </div>
      <div class="home-shelf">
        <div
          v-for="al in recentAlbums"
          :key="al.key"
          class="grid-card"
          @click="$emit('play-song', al.song, recents)"
          @keydown.enter="$emit('play-song', al.song, recents)"
          @keydown.space.prevent="$emit('play-song', al.song, recents)"
          tabindex="0"
          role="button"
          :title="`播放《${al.name}》来源曲 ${al.song.name}`"
        >
          <div class="grid-card-cover">
            <img
              v-if="coverSizeUrl(al.picUrl, 320) && !coverErrs.has(`al:${al.key}`)"
              :src="httpsCover(coverSizeUrl(al.picUrl, 320))"
              :alt="al.name"
              loading="lazy"
              decoding="async"
              @error="coverErrs.add(`al:${al.key}`)"
            />
            <div v-else class="grid-card-cover-fallback"><PixelIcon name="note" :size="22" /></div>
          </div>
          <div class="grid-card-body">
            <h3 class="grid-card-name">{{ al.name }}</h3>
            <p class="grid-card-meta">{{ al.artist }}</p>
          </div>
        </div>
      </div>
    </section>
```

#### 改动规格 2（对应 CTO 方向 2、3、7、8、9、10、11）
1. **歌单货架（`displayPlaylists`）**：
   - `v-if="displayPlaylists.length"`，遍历 `v-for="pl in displayPlaylists"`。
   - 节头左文：`<p class="pg-label">playlists</p><span class="home-section-sub">常听歌单</span>`。
   - 节头右缘翻页按钮组（仅 `shelfNav.pl.canScroll` 为真时渲染）：
     ```vue
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
     ```
   - 货架容器绑 `ref="plShelfEl"` 与 `@scroll.passive="updateShelfNav('pl')"`。
   - `.grid-card` 绑定 `:class="{ 'grid-card--playing': isPlaylistPlaying(pl) }"` 与 `:aria-current="isPlaylistPlaying(pl) ? 'true' : undefined"`。
   - 封面 `<img>` 的 `:alt="pl.name"` 改为 `alt=""`。
   - 封面容器 `.grid-card-cover` 内新增：
     - 播放态角标：`<span v-if="isPlaylistPlaying(pl)" class="grid-card-badge" aria-hidden="true"><PixelIcon name="vol" :size="11" /> 播放中</span>`
     - 右下角直播按钮：
       ```vue
       <button
         type="button"
         class="grid-card-play"
         title="播放歌单"
         :aria-label="`播放歌单 ${pl.name}`"
         @click.stop="$emit('play-playlist', pl)"
         @keydown.enter.stop="$emit('play-playlist', pl)"
         @keydown.space.stop.prevent="$emit('play-playlist', pl)"
       ><PixelIcon name="play" :size="16" /></button>
       ```
2. **专辑货架（`recentAlbums`）**：
   - 节头左文：`<p class="pg-label">albums</p><span class="home-section-sub">涉猎专辑</span>`。
   - 节头右缘翻页按钮组（仅 `shelfNav.al.canScroll` 为真时渲染）：同构绑定 `shelfNav.al.canPrev` / `shelfNav.al.canNext` 与 `scrollShelf('al', -1 | 1)`，`aria-label="涉猎专辑上一页"` / `"涉猎专辑下一页"`。
   - 货架容器绑 `ref="alShelfEl"` 与 `@scroll.passive="updateShelfNav('al')"`。
   - `.grid-card` 绑定 `:class="{ 'grid-card--playing': isAlbumPlaying(al) }"`、`:aria-current="isAlbumPlaying(al) ? 'true' : undefined"`。
   - 点击/键盘激活改为调用 `playAlbum(al)`：
     - `playAlbum(al)`：当 `al.tracks.length >= 2` 时调用 `this.$emit('play-song', al.song, al.tracks)`；否则调用 `this.$emit('play-song', al.song, this.recents)`。
   - 封面 `<img>` 的 `:alt="al.name"` 改为 `alt=""`；若 `isAlbumPlaying(al)` 为真，封面左上角同样渲染 `.grid-card-badge`。
   - 专辑卡副行 `.grid-card-meta` 改为：`{{ al.artist }} · 含《{{ al.song.name }}》`。

---

#### 定位引文 3：`HomeFeed.vue` 脚本与样式区
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
```css
.home-songs {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 8px;
}

.home-songrow {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 6px 8px;
  text-align: left;
  transition: background .12s;
}
.home-songrow:hover { background: var(--ink-06); }

.home-songrow-cover {
  width: 38px;
  height: 38px;
  object-fit: cover;
  border: var(--hairline);
  image-rendering: pixelated;
  flex-shrink: 0;
  display: block;
}
...
.home-shelf {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 160px;
  gap: 16px;
  overflow-x: auto;
  padding: 4px 4px 8px;
}
```

#### 改动规格 3（脚本逻辑与 Scoped CSS）
1. **Props 与 Emits 扩充**：
   - 新增 props：
     - `userPlaylists: { type: Array, default: () => [] }`
     - `currentSongId: { type: [String, Number], default: null }`
     - `playingPlaylistId: { type: [String, Number], default: null }`
   - `emits: ['open', 'play-song', 'play-playlist', 'add-to-playlist']`
2. **专辑键提取 helper 与多曲聚合**：
   - 提纯函数 `albumKeyOf(song)`：
     ```js
     const al = song?.al || song?.album
     const rawId = al?.id
     return (rawId != null && String(rawId) !== '0' ? rawId : null)
       || (song?.qq?.albummid ? `qq:${song.qq.albummid}` : null)
     ```
   - `recentAlbums` 计算属性：
     - 先按既有准入两闸（`key` 非空 ∧ `norm(al?.name) !== norm(song?.name)`）从 `this.recents` 选出前 12 张去重专辑壳。
     - 为每张入选专辑聚合本地同 `key` 曲目数组 `tracks`（按 `String(s.id)` 去重）：先扫 `this.recents`，再扫 `this.userPlaylists` 各歌单的 `tracks` 与 `addedTracks`。
     - 每项结构：`{ key, name: al?.name ?? '', picUrl: songCoverUrl(song) || '', artist: songArtists(song), song, tracks }`。
3. **货架翻页状态机（`setup` 内）**：
   - `plShelfEl = ref(null)`、`alShelfEl = ref(null)`。
   - `shelfNav = reactive({ pl: { canScroll: false, canPrev: false, canNext: false }, al: { canScroll: false, canPrev: false, canNext: false } })`。
   - `updateShelfNav(kind)`：读取对应 `el`（`kind === 'pl' ? plShelfEl.value : alShelfEl.value`）；若 `!el` 则三态置 `false`；否则：
     - `const maxScroll = el.scrollWidth - el.clientWidth`
     - `canScroll = maxScroll > 1`
     - `canPrev = canScroll && el.scrollLeft > 1`
     - `canNext = canScroll && el.scrollLeft < maxScroll - 1`
   - `scrollShelf(kind, dir)`：取对应 `el`，调用 `el.scrollBy?.({ left: dir * el.clientWidth, behavior: 'smooth' })`，并补充同步/微任务更新（兼顾不支持平滑滚动的测试环境：若 `scrollBy` 未改变 `scrollLeft` 或在 jsdom 中，回退 `el.scrollLeft += dir * el.clientWidth` 并立即调 `updateShelfNav(kind)`）。
   - 在 `onMounted`、`window` `resize` 事件、以及 `watch(() => [props.recentPlaylists.length, props.userPlaylists.length, props.recents.length], () => nextTick(updateAllShelfNav))` 中触发更新；`onBeforeUnmount` 移除 `resize` 监听。
4. **Scoped CSS 精确变更**：
   - `.home-head`：`display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; padding: 0 0 16px; position: relative;`。
   - `.home-section-head`：`display: flex; align-items: baseline; gap: 10px; margin-bottom: 12px;`；`.home-shelf-nav`：`margin-left: auto; display: flex; align-items: center; gap: 4px; align-self: center;`。
   - `.home-songrow`：
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
     }
     ```
   - `.home-songrow--playing` 反白态：
     ```css
     .home-songrow--playing,
     .home-songrow--playing:hover {
       background: var(--ink);
       border: var(--hairline);
     }
     .home-songrow--playing .home-songrow-name { color: var(--paper); }
     .home-songrow--playing .home-songrow-artist { color: var(--label-grey); }
     .home-songrow--playing .home-songrow-cover { border-color: var(--paper); }
     .home-songrow--playing .row-add-btn { color: var(--label-grey); }
     ```
   - `.home-songrow-cover`：**删除** `image-rendering: pixelated;`。
   - 移动端 `≤640px` `.home-songs` 横向三行分页滑轨：
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
   - `.home-shelf` 阴影缓冲与右缘出血：
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
   - 歌单卡 `▶` 浮层按钮 `.grid-card-play` 与播放角标 `.grid-card-badge`：
     ```css
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
       color: var(--accent-magenta-on-ink);
     }
     @media (hover: none) {
       .grid-card-play {
         opacity: 1;
         pointer-events: auto;
       }
     }
     ```

---

### 4.2 `src/App.vue`

#### 定位引文
```vue
        <HomeFeed
          v-if="centerView === 'home'"
          :recent-playlists="playlistHistory"
          :recents="playHistory"
          @open="openShelfPlaylist"
          @play-song="openWatchRecent"
        />
```
以及 `useSearchNav` 中 `openShelfPlaylist` 附近（或 `App.vue` 模板绑定）。

#### 改动规格（对应 CTO 方向 8、10、11）
1. `<HomeFeed>` 模板绑定扩充为：
   ```vue
        <HomeFeed
          v-if="centerView === 'home'"
          :recent-playlists="playlistHistory"
          :user-playlists="userPlaylists"
          :recents="playHistory"
          :current-song-id="currentSong?.id ?? null"
          :playing-playlist-id="playingPlaylistId"
          @open="openShelfPlaylist"
          @play-song="openWatchRecent"
          @play-playlist="playShelfPlaylist"
          @add-to-playlist="handleOpenAddToPlaylist"
        />
   ```
2. 在 `App.vue`（或委托给 `playPlaylistFromSidebar`）定义 `playShelfPlaylist(pl)`：
   ```js
   const playShelfPlaylist = (pl) => {
     if (!pl) return
     const live = userPlaylists.value.find(p => String(p.id) === String(pl.id))
     return playPlaylistFromSidebar(live || pl)
   }
   ```
   并在 `setup()` 返回对象中导出 `playShelfPlaylist`（这确保当 `pl` 来自 `playlistHistory` 快照 stub 时，若该歌单仍在 `userPlaylists` 库中，优先用带完整 `tracks`/`addedTracks` 的活副本调 `playPlaylistFromSidebar`）。

---

### 4.3 `src/style.css`

#### 定位引文 1：焦点环、高对比模式、彩布白名单与反白行尾键（全局样式中段）
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
/* 反白行上的行尾键改纸色（排在统一律之后才不被压） */
.app-shell .song-row--playing .song-menu-btn:hover {
  color: var(--paper);
  outline-color: var(--paper);
}
```
```css
/* glitch 反白行尾键：accent-on-ink 字色 + 纸色环（与默认主题的 paper 法则同构） */
:root[data-theme="glitch-restoration"] .app-shell .song-row--playing .song-menu-btn:hover {
  color: var(--accent-magenta-on-ink);
  outline-color: var(--paper);
}
```

#### 改动规格 1
1. 盒件内环选择器列表增加 `.home-songrow-main:focus-visible, .grid-card-play:focus-visible`。
2. `@media (forced-colors: active)` 状态选择器列表增加 `.home-songrow--playing, .grid-card--playing`。
3. `.app-shell .app-body` 次级文字白名单增加 `.app-shell .app-body .home-songrow-artist`；并在下方白名单补丁带增加反白态还原：
   ```css
   .app-shell .app-body .home-songrow--playing .home-songrow-artist {
     color: var(--label-grey);
   }
   ```
4. 反白行上的行尾键 hover 规则扩充覆盖 `.home-songrow--playing .row-add-btn:hover`：
   ```css
   .app-shell .song-row--playing .song-menu-btn:hover,
   .app-shell .home-songrow--playing .row-add-btn:hover {
     color: var(--paper);
     outline-color: var(--paper);
   }
   ```
   以及 glitch 主题对应规则扩充：
   ```css
   :root[data-theme="glitch-restoration"] .app-shell .song-row--playing .song-menu-btn:hover,
   :root[data-theme="glitch-restoration"] .app-shell .home-songrow--playing .row-add-btn:hover {
     color: var(--accent-magenta-on-ink);
     outline-color: var(--paper);
   }
   ```
5. `glitch-restoration` 封面圆角表（`:root[data-theme="glitch-restoration"] .song-cover, ...`）增加 `:root[data-theme="glitch-restoration"] .home-songrow-cover` 与 `:root[data-theme="glitch-restoration"] .home-songrow`（`border-radius: 6px`）和 `:root[data-theme="glitch-restoration"] .grid-card-play`（`border-radius: 4px`）。

#### 定位引文 2：`.row-add-btn` 与 `.grid-card` 家族（`src/style.css` 下半段）
```css
.queue-row:hover .row-add-btn,
.queue-row:focus-within .row-add-btn,
.song-result-row:hover .row-add-btn,
.song-result-row:focus-within .row-add-btn,
.row-add-btn:focus-visible { opacity: 1; pointer-events: auto; }
```
```css
.grid-card-main { cursor: pointer; }

@media (prefers-reduced-motion: no-preference) {
  .grid-card:hover { transform: translateY(-2px); }
}

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
.grid-card-meta {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-64);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
```

#### 改动规格 2（对应 CTO 方向 4、10、11、12）
1. `.row-add-btn` 显现规则补充 `.home-songrow:hover .row-add-btn, .home-songrow:focus-within .row-add-btn`。
2. `.grid-card-main` 增加 `flex: 1; display: flex; flex-direction: column; gap: 8px;`（使 `PlaylistGrid.vue` 中包在 `.grid-card-main` 内的 `.grid-card-body` 同样能撑满高度）。
3. `.grid-card-body` 增加 `flex: 1;`；`.grid-card-meta` 增加 `margin-top: auto;`。
4. `.grid-card-name` **删除** `min-height: 2.7em;`。
5. `.grid-card-cover` 增加 `position: relative;`（供 `.grid-card-badge` 与 `.grid-card-play` 绝对定位锚定）。
6. `.grid-card-cover img` **删除** `image-rendering: pixelated;`。
7. 新增 `.grid-card--playing` 全局规则：
   ```css
   .grid-card--playing {
     box-shadow: inset 0 0 0 1.2px var(--ink);
   }
   ```

---

### 4.4 `src/components/PlaylistPanel.vue`

#### 定位引文
```css
.playlist-panel {
  padding: 20px 0 0; /* 与主区首行同轴：全站 masthead→内容 = 20 */
}

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
以及窄轨媒体查询块：
```css
  .app-sidebar:not(.app-sidebar--open) .panel-head { justify-content: center; padding-right: 0; }
```

#### 改动规格（对应 CTO 方向 14）
1. 将 `.panel-head` 改为顶对齐（`align-items: flex-start`），消除 `.panel-label` 的 `8px` 顶部内边距，使 `.panel-label`（`font-size: 12px; line-height: 1`）顶缘直接贴在 `.playlist-panel` 的 `20px` 顶内边距线（`y = 57.2 + 20 = 77.2px`），与 `.home-head .pg-label` 顶缘（`y = 57.2 + 20 = 77.2px`）严格同轴：
   ```css
   .panel-head {
     display: flex;
     align-items: flex-start;
     justify-content: space-between;
     padding-right: 22px;
     flex-shrink: 0;
   }

   .panel-label {
     padding: 0 12px 12px; /* 顶距 0：严格落在 20px 首行轴，与主区 .pg-label 同轴 */
     flex-shrink: 0;
   }

   /* 32px 图标盒向上收 10px（进入 .playlist-panel 的 20px 顶留白带），
      使 + 号中心（-10 + 16 = 6px）与 12px 高的 .panel-label 中心（6px）同心，
      且不往下顶高 .panel-label */
   .panel-create-btn { margin: -10px 0 4px; }
   ```
2. 窄轨媒体查询（`@media (min-width: 768px) and (max-width: 1023.98px)`）中，当 `.panel-label` 隐藏时复位 `.panel-create-btn` 的负顶距：
   ```css
   .app-sidebar:not(.app-sidebar--open) .panel-create-btn { margin: 0 0 6px; }
   ```

---

### 4.5 `src/components/GlitchText.vue` 与 `src/components/PrintMarks.vue`

#### 定位引文 1：`src/components/GlitchText.vue`
```js
const POOL = [...'▓░▒ﾂﾎﾃﾄﾅﾌﾑﾒﾓﾘﾚﾖﾊﾋﾍﾐﾕﾗﾆﾇ℮†‡ΓŘ®₥§¤¥šмλθτþÐÑØÅЯИƧγÿýξ∑縺繝€∆ⅯﾉﾙΞë|+×01345!$']

const HAN_POOL = [...'烫烫烫烫屯屯屯屯锟斤拷锟斤拷锟斤拷锘锘浣犲ソ娴嬭瘯鏄鐨鎴戜滑鍙戝ぇ瀹闂ㄨ瘯鐮佸織榧犺阿鐢熸妸鍚庡湴鍧戝潃鍧\uFFFD▓░▒█▓░▒█']
const HAN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]|[\u{20000}-\u{2FA1F}]/u

const pickFor = (ch) => {
  const pool = HAN.test(ch) ? HAN_POOL : POOL
  return pool[Math.random() * pool.length | 0]
}

export default {
  name: 'GlitchText',
  props: { text: { type: String, required: true } },
```
以及定时器部分：
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
        const { k, ch} = clean[Math.random() * clean.length | 0]
        corrupt.value.set(k, pickFor(ch))
      }
      // 每代随机恢复 2-3 个存量——稳态来回腐蚀而非单向累积
      glitched.slice(0, 2 + (Math.random() * 2 | 0)).forEach(k => corrupt.value.delete(k))
    }
...
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
```

#### 定位引文 2：`src/components/PrintMarks.vue`
```vue
  <div v-else-if="variant === 'stamp'" class="pg-stamp">
    <p><GlitchText text="MeowSync · Version 1.0.0" /></p>
    <p><GlitchText text="©2026 · All rights reserved" /></p>
    <p><GlitchText text="Made with Love" /></p>
  </div>
```

#### 改动规格（对应 CTO 方向 13）
1. **`HAN_POOL` 去经典乱码汉字（`烫屯锟斤拷锘\uFFFD` 等）**：
   - 将 `HAN_POOL` 替换为几何块、制表符与半角假名池，首元固定为 `'█'`（与 `POOL` 首元 `'▓'` 区分，保持 `Math.random() === 0` 下双池路由分流的可检验性）：
     ```js
     const HAN_POOL = [...'█▓░▒▛▜▟▙▪▫◇◆◈╋╂┼┤├┬┴─│ﾂﾎﾃﾄﾅﾌﾑﾒﾓﾘﾚﾖﾊﾋﾍﾐﾕﾗﾆﾇ∆∑§¤†‡']
     ```
2. **新增 `ambient` prop 并改 `tick` 为「长静默 + 短微闪」脉冲循环**：
   - `props` 扩充为：
     ```js
     props: {
       text: { type: String, required: true },
       ambient: { type: Boolean, default: true }
     }
     ```
   - 脉冲时间常数：
     - 静默间隔：`const PULSE_IDLE_MIN_MS = 3800`，随机抖动 `const PULSE_IDLE_JITTER_MS = 1200`（即静默窗 `3800 ~ 5000ms`；当测试桩 `Math.random() === 0` 时精确为 `3800ms`）。
     - 微闪持续：`const PULSE_HOLD_MS = 200`（闪烁 `200ms` 后自动清空恢复原文）。
   - `tick()` 逻辑：
     - 收集所有清洁字符 `clean`；若 `clean.length` 为空则直接排期下一轮。
     - 随机挑 `1 ~ 2` 个字符（短文本 `total <= 6` 固定挑 `1` 个，长文本 `1 + (Math.random() * 2 | 0)` 个，且不重位）写入 `corrupt.value.set(k, pickFor(ch))`。
     - 启动 `pulseTimer = setTimeout(() => { corrupt.value.clear() }, PULSE_HOLD_MS)` 在 `200ms` 后恢复干净文本，并调用 `schedulePulse()` 进入下一段 `3.8~5s` 静默。
   - `stop()` 清理 `clearTimeout(timer)`、`clearTimeout(pulseTimer)`、`clearTimeout(burstTimer)` 并清空 `corrupt.value.clear()`。
   - `watch([active, () => props.ambient], ([on, amb]) => { stop(); if (on && amb) schedulePulse() }, { immediate: true })`。
   - 注意：全局错误触发的 `watch(glitchGen)` 仍只看 `active.value`（不看 `ambient`），即 `ambient: false` 的静态实例在全局错误 burst 时依然参与 480ms 全屏闪回！
3. **`PrintMarks.vue` 页脚静态化**：
   - 将 `variant === 'stamp'` 下的三处 `<GlitchText ... />` 全部加上 `:ambient="false"`：
     ```vue
     <div v-else-if="variant === 'stamp'" class="pg-stamp">
       <p><GlitchText text="MeowSync · Version 1.0.0" :ambient="false" /></p>
       <p><GlitchText text="©2026 · All rights reserved" :ambient="false" /></p>
       <p><GlitchText text="Made with Love" :ambient="false" /></p>
     </div>
     ```

---

### 4.6 逐项验收标准与验证手段对照表

| 编号 | 验收标准 | 验证手段 |
| :--- | :--- | :--- |
| AC-1 | `.home-songrow` 常态带 `border: var(--hairline-soft)`，hover 切换为 `border: var(--hairline)` + `background: var(--ink-06)`，无布局跳动 | `[jsdom]` 源码样式断言 + `[实机]` 桌面悬停检视 |
| AC-2 | `.home-head`、`.home-section-head`、`.home-songrow` 外框左缘与 `.home-shelf` 首张 `.grid-card` 左缘同轴对齐（桌面 `x = 300px`）；`.home-shelf` 右缘出血至视口右界 | `[实机]` 浏览器 `getBoundingClientRect().left` 四点同值校验 |
| AC-3 | 两个货架节头右缘在 `scrollWidth > clientWidth` 时显示 `[‹][›]`，左端左键 `disabled`、右端右键 `disabled`，点击滚动一个可视宽 | `[jsdom]` 模拟 `scrollWidth/clientWidth/scrollLeft` 断言显隐、禁用与滚动调用 + `[实机]` 缩窄窗口点按翻页 |
| AC-4 | `.grid-card-name` 无 `min-height: 2.7em`；单行标题卡紧凑无空洞，同行混排单/双行标题时 `.grid-card-meta` 底锚对齐 | `[jsdom]` `style.css` 源码断言 + `[实机]` 货架单/双行卡片并排检视 |
| AC-5 | 单曲行移除 `.home-src-tag` chip，第二行 `.home-songrow-artist` 渲染 `artist · source` 无框文本 | `[jsdom]` 断言 `.home-src-tag` 不存在且 `.home-songrow-artist` 文本为 `'UP主 · YouTube'` 等 |
| AC-6 | `≤640px` 下 `.home-songs` 变为 `grid-template-rows: repeat(3, auto)` + `grid-auto-flow: column` 横向 scroll-snap 滑轨 | `[jsdom]` 媒体查询样式断言 + `[实机]` 375×812 视口横滑验证 |
| AC-7 | 页头显示 `overview` / `音乐概览` 与右侧 `随机漫游` 按钮；点击对 `recents` 洗牌后 emit `play-song(shuffled[0], shuffled)`，空 `recents` 时按钮 `disabled`；三节副标题分别为 `最近单曲` / `常听歌单` / `涉猎专辑` | `[jsdom]` 组件挂载触发点击断言 emit 载荷与 disabled 态 |
| AC-8 | `recentPlaylists` 为空时歌单货架回退展示 `userPlaylists`（滤除 `single_song_` 壳）前 8 项；非空时用 `userPlaylists` 活副本富化 | `[jsdom]` 传入空 `recentPlaylists` + 10 项 `userPlaylists`（含 1 个 `single_song_`）断言渲染 8 张卡 |
| AC-9 | 专辑卡 `.grid-card-meta` 显示 `${artist} · 含《${song.name}》`；同 `al.key` 本地曲目 `≥2` 首时点击 emit 聚合曲目队列，否则 emit `recents`；两个货架封面 `img` 的 `alt` 均为 `""` | `[jsdom]` 构造同专辑 2 首曲目断言点击专辑卡 emit 长度为 2 的专属队列，且 `img.attributes('alt') === ''` |
| AC-10 | 传入 `currentSongId` / `playingPlaylistId` 时，命中单曲行挂 `.home-songrow--playing` 且主区 `aria-current="true"`；命中歌单/专辑卡挂 `.grid-card--playing`、渲染 `.grid-card-badge` 且 `aria-current="true"` | `[jsdom]` props 切换断言 class、badge 与 `aria-current` + `[实机]` 播放时回首页检视墨底反白 |
| AC-11 | 单曲行尾渲染 `.row-add-btn`（点击 emit `add-to-playlist(song, trigger)` 不触发 `play-song`），歌单卡封面右下渲染 `.grid-card-play`（点击 emit `play-playlist(pl)` 不触发 `open`）；全组件无 `<button>` 嵌套 `<button>` | `[jsdom]` 断言 `find('button button').exists() === false` 及点击事件隔离 |
| AC-12 | `.home-songrow-cover` 与 `.grid-card-cover img` 均无 `image-rendering: pixelated` | `[jsdom]` 源码断言两处规则块不含 `pixelated` + `[实机]` 封面清晰度检视 |
| AC-13 | `GlitchText` 的 `HAN_POOL` 不含 `烫/屯/锟/斤/拷/锘/\uFFFD`，脉冲静默 `3.8~5s` 后微闪 `200ms` 即复原；`PrintMarks` 页脚三行传 `:ambient="false"` 常态不腐蚀、仅响应全局 `glitchBurst()` | `[jsdom]` fakeTimers 推进 `3800ms` 断言腐蚀出现、再推进 `200ms` 断言清空复原，以及 `ambient=false` 断言 |
| AC-14 | 侧栏 `.panel-label` 顶缘与主区 `.home-head .pg-label` 顶缘同轴（`y` 差 `0px`） | `[jsdom]` 样式断言 `.panel-label` top padding 为 `0` + `[实机]` 双栏顶缘 `getBoundingClientRect().top` 对比 |

---

## 五、测试契约（Test Contract）

### 5.1 `tests/ui/feed-downloads-ui.spec.mjs` 更新与新增用例
1. **适配既有断言（第 111–162 行）**：
   - 原用例 `songrow 渲封面/歌名/歌手/来源徽标，点击发 play-song` 中：
     - 将查询 `.home-src-tag` 改为断言 `r.find('.home-src-tag').exists() === false`，并断言 `.home-songrow-artist` 文本分别为 `'艺人A · 网易云'`、`'UP主 · YouTube'`、`'UP乙 · B站'`、`'艺 · QQ音乐'`、`'艺丙 · QQ音乐'`。
   - 原用例 `过滤后无真专辑时专辑 section 整段不渲染` 中：
     - 将 `expect(w.text()).not.toContain('最近播放的专辑')` 更新为 `expect(w.text()).not.toContain('涉猎专辑')`。
2. **新增 `HomeFeed` 专项测试集（不少于 7 条新 `it`）**：
   - **页头与随机漫游**：断言渲染 `overview`、`音乐概览`；`recents` 为空时 `.home-roam-btn` `disabled`；`recents` 非空时点击 `.home-roam-btn` 触发 `play-song`，首参为洗牌后首曲，次参为包含全量 `recents` 成员的新数组且不修改原 `RECENTS` 顺序。
   - **歌单货架 `userPlaylists` 回退与活副本富化**：当 `recentPlaylists=[]` 且传入 10 个 `userPlaylists`（含 1 个 `single_song_1`）时，渲染 8 张 `.grid-card` 且不含 `single_song_1`；当 `recentPlaylists` 含旧名快照而 `userPlaylists` 含同 `id` 新名与新 `trackCount` 时，卡片渲染最新名称与曲数。
   - **专辑卡代表曲 meta、多曲队列聚合与封面 `alt=""`**：当 `recents`（或 `userPlaylists`）含同一 `al.id=42` 的 2 首不同歌曲时，专辑卡 `.grid-card-meta` 包含 `'艺人A · 含《真曲》'`，点击该专辑卡触发 `play-song` 的第二参数长度为 2（仅含该专辑的 2 首曲）；仅 1 首曲的专辑卡点击第二参数仍为全量 `recents`；所有 `.grid-card-cover img` 的 `alt` 属性恒为 `""`。
   - **播放态高亮与 `aria-current`**：传入 `currentSongId: 1, playingPlaylistId: 77` 时，对应 `.home-songrow` 含 `.home-songrow--playing` 且 `.home-songrow-main` 的 `aria-current="true"`；对应歌单卡与含 `id:1` 的专辑卡均含 `.grid-card--playing`、`aria-current="true"` 及 `.grid-card-badge`。
   - **快捷动作与反嵌套 HTML 合法性**：断言 `w.find('button button').exists() === false`；点击单曲行 `.row-add-btn` 触发 `add-to-playlist`（携带 `[song, buttonElement]`）且**不**触发 `play-song`；点击歌单卡 `.grid-card-play` 触发 `play-playlist`（携带 `[pl]`）且**不**触发 `open`。
   - **货架翻页按钮 `[‹][›]`**：通过 `Object.defineProperty` 在 `.home-shelf` 元素上模拟 `clientWidth: 360, scrollWidth: 900, scrollLeft: 0`，触发 `resize` 后断言 `.home-shelf-nav` 渲染、上一页 `disabled=true`、下一页 `disabled=false`；点击下一页调用 `scrollBy({ left: 360, behavior: 'smooth' })`；当 `scrollLeft` 设为 `540` 触发 `scroll` 事件后，上一页 `disabled=false`、下一页 `disabled=true`。
   - **封面去 `pixelated` 源码钉板**：读取 `HomeFeed.vue` 与 `src/style.css`，断言 `.home-songrow-cover` 与 `.grid-card-cover img` 规则块不含 `image-rendering: pixelated`。

### 5.2 `tests/ui/glitch-text.spec.mjs` 更新与新增用例
1. **更新首元字面量钉板**：
   - 将原断言中 `HAN_POOL[0]` 的字面量从 `'烫'` 更新为 `'█'`（`'漢'` 与 `'𠮷'` 路由到 `'█'`，`'a'` 路由到 `'▓'`，继续严格检验 `HAN` 与 `POOL` 的分流）。
   - 新增源码/运行时断言：`GlitchText.vue` 的 `HAN_POOL` 不含 `'烫'`、`'屯'`、`'锟'`、`'斤'`、`'拷'`、`'锘'`、`'\uFFFD'`。
2. **更新脉冲时序测试**：
   - 在 `tick 主路径同走分流` 用例中：挂载后初始 `corrupt.size === 0`；`vi.advanceTimersByTime(3800)`（`Math.random() === 0` 下的静默窗）后触发脉冲，`corrupt.get('0:0') === '█'`；再 `vi.advanceTimersByTime(200)`（微闪窗结束）后 `corrupt.size === 0` 自动恢复干净文本。
   - 新增 `ambient: false` 用例：挂载 `<GlitchText text="MeowSync" :ambient="false" />`，推进定时器 `10000ms` 断言 `corrupt.size === 0` 恒不自跳；调用 `glitchBurst()` 后 `corrupt.size > 0` 正常响应全局错误闪回，`480ms` 后清空。

### 5.3 `tests/ui/playlist-panel.spec.mjs` 新增用例
- 新增源码/结构回归断言：`PlaylistPanel.vue` 的 `.panel-head` 使用 `align-items: flex-start` 且 `.panel-label` 顶内边距为 `0`，确保与主区 `.pg-label` 首行同轴。

---

## 六、风险边界与防回归护栏

1. **禁止 `<button>` 套 `<button>` 与点击死区防范**：
   - `.home-songrow` 从 `<button>` 改为 `<div>` 后，若仅把 `@click` 绑在 `.home-songrow-main` 上，卡片四周 `6px 8px` 的内边距环会变成点击无反应的死区，且破坏既有测试 `rows[0].trigger('click')`。
   - **护栏**：`@click="$emit('play-song', song, recents)"` 挂在外层 `.home-songrow` 上，键盘 `@keydown.enter` / `@keydown.space.prevent` 与 `role="button" tabindex="0"` 挂在 `.home-songrow-main` 上，而右侧兄弟节点 `.row-add-btn` 使用 `@click.stop`。这样整张单曲卡无死区、无嵌套 `<button>`、键盘 Tab 序清晰（先主区后 `+` 键）。
2. **彩布次级文字白名单与反白行的特异度碰撞**：
   - `src/style.css` 中 `.app-shell .app-body .home-songrow-artist` 特异度为 `(0,3,0)`，若 `HomeFeed.vue` scoped 样式仅写 `.home-songrow--playing .home-songrow-artist`（特异度同为 `0,3,0`），一旦加载顺序变化会被压死成深墨色导致墨底上字隐形。
   - **护栏**：在 `src/style.css` 的白名单补丁带（L704 附近）显式声明 `.app-shell .app-body .home-songrow--playing .home-songrow-artist { color: var(--label-grey); }`（特异度 `0,4,0`）。
3. **`PlaylistGrid.vue` 共用 `.grid-card` 的回归防护**：
   - `.grid-card` 同时被 `HomeFeed.vue` 与 `PlaylistGrid.vue`（搜索结果歌单卡，内含 `.grid-card-main` + `.grid-card-actions`）使用。
   - **护栏**：去掉 `.grid-card-name` 的 `min-height: 2.7em` 后，同步给 `.grid-card-main` 补 `flex: 1; display: flex; flex-direction: column; gap: 8px;`，给 `.grid-card-body` 补 `flex: 1;`，给 `.grid-card-meta` 补 `margin-top: auto;`，确保搜索结果页的 `.grid-card-actions`（「+ 收藏」行）依然稳固底锚对齐。
4. **jsdom 环境缺 `scrollBy` / `ResizeObserver` 防护**：
   - jsdom 默认未实现 `Element.prototype.scrollBy`。
   - **护栏**：`scrollShelf` 中若 `typeof el.scrollBy === 'function'` 则调用 `el.scrollBy({ left: delta, behavior: 'smooth' })`，否则回退 `el.scrollLeft += delta`；并在测试或实现中安全降级，不因 API 缺席抛异常。

---

## 七、实施单元划分建议（按互不重叠文件域并行派发）

为契合 CTO 子代理分工制，建议拆分为 **3 个文件域完全正交的实现单元** 并行派发 `subagent_general`：

1. **单元 U1 — 主页发现流与宿主接线域**
   - **独占修改文件**：`src/components/HomeFeed.vue`、`src/App.vue`、`tests/ui/feed-downloads-ui.spec.mjs`
   - **职责**：完成 `HomeFeed.vue` 的模板/脚本/scoped 样式重构（页头 `overview / 音乐概览` + 随机漫游、单曲行微框+去 chip 并入副行+行尾 `+` 键+移动三行横滑、双货架出血+`[‹][›]` 翻页、`displayPlaylists` 回退与富化、专辑多曲聚合与诚实 meta、播放态反白/角标、封面去 `pixelated` 与 `alt=""`）、`App.vue` props/事件接线，以及 `feed-downloads-ui.spec.mjs` 测试更新与扩充。
2. **单元 U2 — 全局卡片/行样式与侧栏首行同轴域**
   - **独占修改文件**：`src/style.css`、`src/components/PlaylistPanel.vue`、`tests/ui/playlist-panel.spec.mjs`
   - **职责**：完成 `src/style.css` 中 `.grid-card` 去 `min-height: 2.7em` 与 flex 底锚、`.grid-card-cover` 相对定位与去 `pixelated`、`.row-add-btn` 在 `.home-songrow` 下的显现与反白 hover、彩布白名单与 `forced-colors` 登记；完成 `PlaylistPanel.vue` 的 `.panel-head` / `.panel-label` 首行同轴对齐及对应测试。
3. **单元 U3 — GlitchText 脉冲降噪与页脚静态化域**
   - **独占修改文件**：`src/components/GlitchText.vue`、`src/components/PrintMarks.vue`、`tests/ui/glitch-text.spec.mjs`
   - **职责**：完成 `GlitchText.vue` 的 `HAN_POOL` 去 `烫屯锟斤拷`、`:ambient` prop、3.8~5s 静默 + 200ms 微闪脉冲状态机；完成 `PrintMarks.vue` 页脚 `:ambient="false"` 静态化，以及 `glitch-text.spec.mjs` 测试同步与扩充。

---

## 八、复审关注点（Review Checklist）

1. **DOM 合法性与焦点可访问性**：确认 `HomeFeed.vue` 编译后不存在任何 `button > button` 或 `role="button"` 嵌套未隔断事件冒泡的 `<button>`；Tab 键能依次聚焦随机漫游键、单曲行主区、单曲行 `+` 键、货架翻页键、歌单卡主区、歌单卡 `▶` 键。
2. **特异度与双主题兼容性**：在 `default`（print-grid）与 `glitch-restoration` 两个主题、以及 `forced-colors` 下，核查 `.home-songrow--playing` 的歌名、歌手/来源副行、封面边框和 `.row-add-btn` hover 对比度是否全部达标。
3. **定时器生命周期**：确认 `GlitchText.vue` 在组件卸载、`active` 切换、`ambient` 切换、`text` 变更时，`timer`、`pulseTimer`、`burstTimer` 三路定时器全部清零且 `corrupt` Map 清空，无卸载后残留回调。
4. **货架边界与空态**：确认当 `recents` 与 `userPlaylists` 均为空时，空态提示正常显示、随机漫游键处于 `disabled`、不渲染任何空货架或翻页键。

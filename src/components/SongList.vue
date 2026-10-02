<template>
  <!-- 歌曲列表：songs 视图，落在 sage 纸色画布上（.app-shell[data-view="songs"] → --canvas-sage #abbab9） -->
  <div class="song-list-main flex flex-col h-full min-h-0">
    <!-- 歌单页头：裁切角标封面 + 元信息 + 墨块按钮组，未选歌单时不占位 -->
    <div v-if="selectedPlaylist" class="playlist-hero">
      <div class="playlist-hero-cover-wrap pg-corners">
        <img
          v-if="selectedPlaylist.coverImgUrl"
          :src="httpsCover(selectedPlaylist.coverImgUrl)"
          :alt="selectedPlaylist.name"
          class="playlist-hero-cover"
        />
        <div v-else class="playlist-hero-cover playlist-hero-fallback"><PixelIcon name="note" :size="34" /></div>
      </div>
      <div class="playlist-hero-meta">
        <h2 class="playlist-hero-name" data-nosnippet><GlitchText :text="selectedPlaylist.name || ''" /></h2>
        <p class="playlist-hero-sub">
          {{ selectedPlaylist.creator?.nickname || '神秘创建者' }} · {{ selectedPlaylist.trackCount || songs.length }} 首
        </p>
        <!-- 主按钮墨块 / 随机、VIP 过滤同为幽灵键；on 态 accent 字 + ✓ 前缀。
             loadingSongs 期 disabled：远端单拉取未落地时点播放会把旧单曲目拍进
             队列却冠新单 playingPlaylistId（queueTitle/历史/刷新恢复全错位） -->
        <div class="playlist-hero-actions">
          <button
            @click="$emit('play-all')"
            class="ink-btn"
            :disabled="loadingSongs"
            title="播放全部"
          ><PixelIcon name="play" :size="18" /> 播放</button>
          <button
            @click="$emit('play-shuffle')"
            class="ink-btn ink-btn--ghost"
            :disabled="loadingSongs"
            title="随机播放"
          ><PixelIcon name="shuffle" :size="15" /> 随机</button>
          <button
            @click="$emit('toggle-vip-songs')"
            class="ink-btn ink-btn--ghost hero-vip-toggle"
            :aria-pressed="showVipSongs"
            title="切换VIP歌曲显示"
          >
            <PixelIcon v-if="showVipSongs" name="check" :size="13" />
            {{ showVipSongs ? '隐藏VIP' : '显示VIP' }}
          </button>
          <!-- 单向同步：静默重拉远端并合并本地增删（本地单没有远端可拉，隐藏） -->
          <button
            v-if="!isLocalPlaylist"
            @click="$emit('sync-playlist')"
            class="ink-btn ink-btn--ghost"
            title="与远端同步曲目：远端增删会生效，本地添加/移除保留"
          ><PixelIcon name="m-loop" :size="14" /> 同步</button>
          <!-- 收藏：预览态远端单（搜索/链接打开未入库）显式入库入口——
               搜索只预览不自动加，用户自主选择（本地单无远端实体，天然在库） -->
          <button
            v-if="!isLocalPlaylist && !playlistInLibrary"
            @click="$emit('collect-playlist')"
            class="ink-btn ink-btn--ghost"
            title="收藏到歌单库（预览单刷新后即丢失）"
          ><PixelIcon name="plus" :size="15" /> 收藏歌单</button>
          <!-- 点歌台：搜索网易云/粘 B 站、YouTube 链接向本单追加。single_song_ 壳是单曲
               容器，加第二首会改其语义——保持隐藏（与行级菜单同口径） -->
          <button
            v-if="!isShareShell"
            @click="$emit('add-songs')"
            class="ink-btn ink-btn--ghost"
            title="搜索歌曲加入本歌单（支持 B 站/YouTube 链接）"
          ><PixelIcon name="plus" :size="15" /> 添加歌曲</button>
        </div>
      </div>
    </div>

    <div v-if="loadingSongs" class="song-state">
      <div class="pixel-loading" aria-hidden="true"></div>
      <p class="song-state-text">加载歌曲中喵...</p>
    </div>

    <div v-else-if="songs.length === 0" class="song-state">
      <PixelIcon name="note" :size="36" class="song-state-icon" />
      <!-- 空歌单与未选歌单分文案：前者指路「添加歌曲」入口 -->
      <p class="song-state-text">{{ selectedPlaylist ? '歌单还是空的喵~' : '从左侧选择歌单，或在顶部搜索发现新歌单喵~' }}</p>
      <p v-if="selectedPlaylist && !isShareShell" class="song-state-sub">点上方「添加歌曲」搜歌/粘链接进来</p>
    </div>

    <div v-else ref="rowsEl" class="flex-1 min-h-0 overflow-y-auto song-rows">
      <div
        v-for="(song, index) in pagedRows"
        :key="song.id"
        class="song-row"
        :class="{
          'song-row--playing': isCurrent(song),
          'song-row--vip': isVipSong(song)
        }"
      >
        <div
          @click="$emit('play-song', song)"
          @keydown.enter="$emit('play-song', song)"
          @keydown.space.prevent="$emit('play-song', song)"
          class="song-row-main"
          tabindex="0"
          role="button"
          :aria-label="`播放 ${song.name}`"
        >
          <!-- 行首序号：常态等宽数字，悬停/当前曲换 ▶ -->
          <span class="song-row-index">
            <span class="song-row-index-num">{{ index + 1 }}</span>
            <span class="song-row-index-play"><PixelIcon name="play" :size="16" /></span>
          </span>
          <div
            class="song-cover-wrap"
            :class="{ 'playing-animation': isCurrent(song) && isPlaying }"
          >
            <img
              v-if="songCoverUrl(song)"
              :src="httpsCover(songCoverUrl(song))"
              :alt="song.name"
              class="song-cover"
              loading="lazy"
            />
            <div v-else class="song-cover song-cover--fallback"><PixelIcon name="note" :size="16" /></div>
          </div>
          <div class="song-info">
            <h4 class="song-title">
              <span class="song-title-text">{{ song.name }}</span>
              <span
                v-if="songSource(song)"
                class="pg-chip pg-chip--static song-tag"
                :title="`来源：${songSource(song)} 导入`"
              >{{ songSource(song) }}</span>
              <span v-if="isVipSong(song)" class="pg-chip pg-chip--static song-tag">VIP</span>
              <span
                v-if="serverDownloadedStates[song.id]"
                class="pg-chip pg-chip--static song-tag"
                title="已下载到服务器"
                aria-label="已下载到服务器"
              ><PixelIcon name="check" :size="11" /></span>
            </h4>
            <p class="song-artist">
              {{ song.ar?.map(artist => artist.name).join(', ') || song.artists?.map(a => a.name).join(', ') }}
            </p>
          </div>
          <!-- YTM 曲目行第四列：专辑名（窄屏让位） -->
          <div class="song-album">{{ song.al?.name || song.album?.name || '—' }}</div>
          <div class="song-duration">{{ formatDuration(song.dt || song.duration) }}</div>
        </div>

        <!-- 行尾 ⋯ 菜单键：悬停/聚焦时露出，触屏常显 -->
        <div class="song-actions">
          <button
            class="song-menu-btn pg-icobtn pg-icobtn--bare pg-icobtn--sm"
            @click.stop="toggleDownloadMenu(song.id, $event)"
            title="更多操作"
            aria-label="更多操作"
            aria-haspopup="menu"
            :aria-expanded="showDownloadMenu === song.id"
          >
            <PixelIcon name="kebab" :size="15" />
          </button>
        </div>
      </div>

      <!-- 渐进渲染哨兵：IO 命中自动扩窗，也是键盘可达的「加载更多」键 -->
      <button
        v-if="pgHasMore"
        :ref="bindSentinel"
        class="song-list-more ink-btn ink-btn--ghost"
        @click="loadMoreRows()"
      >加载更多 · 已显示 {{ renderedCount }} / {{ filteredSongs.length }}</button>

      <!-- YTM 曲目列表全滚动：底部只留计数（分页器拆除） -->
      <div class="song-list-footer">
        <span class="pg-label pg-label--dim">
          共 {{ filteredSongs.length }} 首<template v-if="!showVipSongs && songs.length > filteredSongs.length">（隐藏 {{ songs.length - filteredSongs.length }} 首VIP）</template>
        </span>
      </div>
    </div>

    <!-- 歌曲 ⋯ 菜单 - Teleport 到 body，容器走全局 .pg-menu（菜单类必须是全局类） -->
    <Teleport to="body">
      <div
        v-if="showDownloadMenu"
        class="download-menu-overlay"
        @click.self="closeDownloadMenu(true)"
      >
        <div
          class="pg-menu"
          role="menu"
          :style="getMenuPosition(showDownloadMenu)"
          @click.stop
        >
          <div class="pg-menu-head">
            {{ menuSong?.name || '歌曲操作' }}
          </div>

          <!-- 行内 ⋯ 菜单：队列操作与分享/下载合一 -->
          <div
            class="pg-menu-item"
            role="menuitem"
            tabindex="0"
            @click="playNextFromMenu"
            @keydown.enter="playNextFromMenu"
            @keydown.space.prevent="playNextFromMenu"
          >
            <PixelIcon name="next" :size="15" /> 下一首播放
          </div>
          <div
            class="pg-menu-item"
            role="menuitem"
            tabindex="0"
            @click="addToQueueFromMenu"
            @keydown.enter="addToQueueFromMenu"
            @keydown.space.prevent="addToQueueFromMenu"
          >
            <PixelIcon name="plus" :size="13" /> 加入队列末尾
          </div>
          <div
            class="pg-menu-item"
            role="menuitem"
            tabindex="0"
            @click="addToPlaylistFromMenu"
            @keydown.enter="addToPlaylistFromMenu"
            @keydown.space.prevent="addToPlaylistFromMenu"
          >
            <PixelIcon name="m-list" :size="13" /> 添加到歌单
          </div>
          <!-- 编辑：元数据（名字/艺人/专辑/时长）对所有曲开放；file_ 上传曲
               另可换音频/视频/封面/歌词源文件。分享壳隐藏——壳不持久化，编辑
               写了也没处落 -->
          <div
            v-if="selectedPlaylist && !isShareShell"
            class="pg-menu-item"
            role="menuitem"
            tabindex="0"
            @click="editFromMenu"
            @keydown.enter="editFromMenu"
            @keydown.space.prevent="editFromMenu"
          >
            <PixelIcon name="edit" :size="13" /> 编辑歌曲
          </div>
          <!-- 从歌单移除：远端曲写墓碑防同步复活，本地追加/本地单曲直接删。
               分享壳（single_song_）隐藏——移除唯一曲只会留个待剪枝的空壳 -->
          <div
            v-if="selectedPlaylist && !isShareShell"
            class="pg-menu-item pg-menu-item--danger"
            role="menuitem"
            tabindex="0"
            @click="removeFromPlaylistFromMenu"
            @keydown.enter="removeFromPlaylistFromMenu"
            @keydown.space.prevent="removeFromPlaylistFromMenu"
          >
            <PixelIcon name="close" :size="13" /> 从歌单移除
          </div>
          <!-- file_ 曲没有可分享的源链接（?song= 只收数字 id）——死链不亮 -->
          <div
            v-if="!isFileTrackId(menuSong?.id)"
            class="pg-menu-item"
            role="menuitem"
            tabindex="0"
            @click="shareFromMenu"
            @keydown.enter="shareFromMenu"
            @keydown.space.prevent="shareFromMenu"
          >
            <PixelIcon name="share" :size="13" /> 分享歌曲
          </div>

          <!-- 回源：新页打开曲目在源站的原页面（B站/YouTube/QQ/网易云）。
               分享壳也亮——纯外链跳转无服务端语义 -->
          <div
            v-if="menuSourceUrl"
            class="pg-menu-item"
            role="menuitem"
            tabindex="0"
            @click="openSourceFromMenu"
            @keydown.enter="openSourceFromMenu"
            @keydown.space.prevent="openSourceFromMenu"
          >
            <PixelIcon name="external" :size="13" /> {{ menuSourceName }}
          </div>

          <!-- 获取源文件（浏览器下载）。菜单目标从全量 props.songs 查，不依赖渲染切片 -->
          <div
            class="pg-menu-item"
            role="menuitem"
            tabindex="0"
            @click="downloadSongDirect(menuSong, 320000)"
            @keydown.enter="downloadSongDirect(menuSong, 320000)"
            @keydown.space.prevent="downloadSongDirect(menuSong, 320000)"
          >
            <PixelIcon name="download" :size="13" /> {{ isFileTrackId(menuSong?.id) ? '下载文件' : (menuSong?.bilibili || menuSong?.youtube || menuSong?.qq) ? '获取源文件（最优音质）' : '获取源文件 (320k)' }}
          </div>

          <!-- 下载到服务器 / 删除已下载：single_song_ 分享壳无服务端持久化意义隐藏；
               qq_/bv_/yt_ 只在本地歌单显示（镜像链投影 provider 定位字段进曲目表
               后 file-downloader 前缀分发可达），远端单里这些 id 必 404 -->
          <div
            v-if="!isShareShell && selectedPlaylist && canServerDownload(menuSong)"
            class="pg-menu-item"
            :class="{ 'pg-menu-item--danger': serverDownloadedStates[showDownloadMenu] }"
            role="menuitem"
            tabindex="0"
            @click="toggleServerDownload(menuSong)"
            @keydown.enter="toggleServerDownload(menuSong)"
            @keydown.space.prevent="toggleServerDownload(menuSong)"
          >
            <template v-if="serverDownloadingStates[showDownloadMenu]"><span class="pixel-loading" aria-hidden="true"></span> 处理中...</template>
            <template v-else-if="serverDownloadedStates[showDownloadMenu]"><PixelIcon name="warn" :size="13" /> 删除已下载文件</template>
            <template v-else><PixelIcon name="download" :size="13" /> 下载到服务器</template>
          </div>

          <!-- 源站视频下载（仅 bv_/yt_ 且确认有浏览器可放视频流的曲目）——
               服务端 ffmpeg 合流出真·最高画质 mp4；已下过音频的任务翻 pending
               只补视频相位 -->
          <div
            v-if="!isShareShell && selectedPlaylist && canServerDownload(menuSong) && canServerVideo(menuSong)"
            class="pg-menu-item"
            role="menuitem"
            tabindex="0"
            @click="downloadServerVideo(menuSong)"
            @keydown.enter="downloadServerVideo(menuSong)"
            @keydown.space.prevent="downloadServerVideo(menuSong)"
          >
            <template v-if="serverDownloadingStates[showDownloadMenu]"><span class="pixel-loading" aria-hidden="true"></span> 处理中...</template>
            <template v-else><PixelIcon name="play" :size="13" /> 下载视频到服务器</template>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.song-list-main {
  padding: 20px;
}
/* 窄屏让利：360px 视口 40px 边距吃掉 11% 屏宽——行信息列优先 */
@media (max-width: 640px) {
  .song-list-main { padding: 12px; }
}

.song-rows { scrollbar-gutter: stable; }

/* ── 歌单页头：裁切角标封面 + 墨块按钮组 ── */
.playlist-hero {
  display: flex;
  align-items: center;
  gap: 16px;
  padding-bottom: 18px;
  border-bottom: var(--hairline-soft);
  flex-shrink: 0;
}

.playlist-hero-cover-wrap {
  width: 112px;
  height: 112px;
  flex-shrink: 0;
  /* pg-corners 角标外扩 7px，竖向留呼吸位防贴邻；
     横向左缘与歌曲行条带（song-row 盒缘）齐平——角标左标线伸进页内边距属标线正常悬出 */
  margin: 8px 8px 8px 0;
}

.playlist-hero-cover {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border: var(--hairline);
  display: block;
  image-rendering: pixelated;
}

.playlist-hero-fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ink-64);
  background: var(--paper);
}

.playlist-hero-meta {
  flex: 1;
  min-width: 0;
}

.playlist-hero-name {
  font-family: var(--font-display);
  font-size: 20px;
  font-weight: 600;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.playlist-hero-sub {
  font-family: var(--font-mono);
  font-weight: 300;
  font-size: 11px;
  letter-spacing: .05em;
  color: var(--ink-64);
  margin-top: 6px;
}

.playlist-hero-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 14px;
  align-items: center;
}

/* VIP 开关 on 态：accent 字色 + ✓ 前缀表达 toggle；缩写词豁免 CTA 小写规则 */
.hero-vip-toggle { text-transform: none; }
.hero-vip-toggle[aria-pressed="true"] { color: var(--accent-magenta-ink); }

/* ── 加载 / 空态 ── */
.song-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  /* 与 grid-state/home-state 同规约：64 竖 + 16 横；
     无顶线——hero 底缘已承担分区，无线时孤儿线没有可分隔的对象 */
  padding: 64px 16px;
}

.song-state-icon {
  color: var(--ink-64);
}

.song-state-text {
  font-size: 12px;
  color: var(--ink-86);
}

.song-state-sub {
  font-size: 11px; /* 站内次级信息行档（pl-meta/song-artist/panel-state-sub 同规约） */
  color: var(--ink-64);
}

/* ── 歌曲行：留白节奏（无分隔线）+ 悬停浅墨 + 当前曲墨底反白 ── */
.song-row {
  position: relative;
  /* 全滚动大歌单的渲染摊销：屏外行跳布局/绘制（YTM 虚拟列表的廉价版） */
  content-visibility: auto;
  contain-intrinsic-size: auto 60px;
}

/* VIP 曲弱化：不压整行透明度（.55 让歌名掉到 3.01:1），改降级文字色 + VIP 戳记 */
.song-row--vip .song-title { color: var(--ink-86); }
.song-row--vip .song-artist, .song-row--vip .song-duration,
.song-row--vip .song-row-index { color: var(--ink-64); }

.song-row-main {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  cursor: pointer;
  transition: background .12s;
}

.song-row:not(.song-row--playing):hover .song-row-main {
  background: var(--ink-06);
}

.song-row--playing .song-row-main {
  background: var(--ink);
}

.song-row--playing .song-row-main:focus-visible {
  outline-color: var(--paper);
}

/* 行首序号：常态等宽数字，悬停/当前曲换 ▶ */
.song-row-index {
  width: 26px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-64);
}

.song-row-index-play {
  display: none;
  color: var(--ink);
}

.song-row:hover .song-row-index-num,
.song-row:focus-within .song-row-index-num,
.song-row--playing .song-row-index-num {
  display: none;
}

.song-row:hover .song-row-index-play,
.song-row:focus-within .song-row-index-play,
.song-row--playing .song-row-index-play {
  display: inline;
}

.song-row--playing .song-row-index-play {
  color: var(--paper);
}

.song-cover-wrap {
  position: relative;
  width: 44px;
  height: 44px;
  flex-shrink: 0;
  margin-inline: 6px;
}

.song-cover {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border: var(--hairline);
  display: block;
  image-rendering: pixelated;
}

.song-cover--fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ink-64);
  background: var(--paper);
}

.song-row--playing .song-cover {
  border-color: var(--paper);
}

.song-info {
  flex: 1;
  min-width: 0;
}

.song-title {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 12px;
  font-weight: 500;
  color: var(--ink);
}

.song-title-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 行内小牌（VIP / 已下载勾）：pg-chip 的紧凑变体 */
.song-tag {
  height: 20px;
  padding: 0 8px;
  font-size: 10px;
  flex-shrink: 0;
}

.song-row--playing .song-tag {
  border-color: var(--paper);
  color: var(--paper);
}

.song-artist {
  font-size: 11px;
  color: var(--ink-64);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 2px;
}

/* YTM 曲目行第四列：专辑名——与信息列均分剩余，窄屏让位 */
.song-album {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--ink-64);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.song-row--playing .song-album { color: var(--label-grey); }
@media (max-width: 700px) {
  .song-album { display: none; }
}

.song-duration {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-64);
  flex-shrink: 0;
  transition: opacity .12s;
}

.song-row:hover .song-duration,
.song-row:focus-within .song-duration,
.song-row:has(.song-menu-btn[aria-expanded="true"]) .song-duration { /* 菜单浮空期行已失 hover，时长仍须让位给可见的 ⋯ */
  opacity: 0;
}

/* 当前曲反白：文字/标签全换纸色与标签灰 */
.song-row--playing .song-title,
.song-row--playing .song-duration {
  color: var(--paper);
}

.song-row--playing .song-artist,
.song-row--playing .song-row-index-num {
  color: var(--label-grey);
}

/* 行尾 ⋯ 菜单键：时长常态贴右缘，悬停/聚焦时时长淡出、⋯ 原位替换——
   不再为隐形键预留 44px 死区（YTM 同款 reveal-swap） */
.song-actions {
  position: absolute;
  top: 50%;
  right: 12px;
  transform: translateY(-50%);
  display: flex;
}

.song-menu-btn {
  color: var(--ink-64);
  opacity: 0;
  pointer-events: none; /* 隐形时不吃点击——此区已还给时长，点击应放行到行播放 */
  transition: opacity .12s, color .2s;
  /* hover 走全局行尾键统一律（墨字+内陷盒环） */
}

.song-row:hover .song-menu-btn,
.song-row:focus-within .song-menu-btn,
.song-menu-btn:focus-visible,
.song-menu-btn[aria-expanded="true"] { /* 菜单浮空期间触发键保持可见——菜单 teleport 到 body，聚焦菜单项时行会失焦 */
  opacity: 1;
  pointer-events: auto;
}

.song-row--playing .song-menu-btn {
  color: var(--label-grey);
}

/* 触屏无 hover——隐形但可点的 ⋯ 键会误触，常显。
   常显后须给时长让位：右 padding 把时长推到 ⋯ 键左侧，
   否则透明底图标永远压在 "3:45" 上 */
@media (hover: none) {
  .song-row-main { padding-right: 44px; }
  .song-menu-btn {
    opacity: 1;
    pointer-events: auto;
  }
}

/* 窄屏 hero 单列化：与 watch 页同向（YTM 歌单头双栏→单列折叠） */
@media (max-width: 640px) {
  .playlist-hero {
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }
  .playlist-hero-cover-wrap { width: 88px; height: 88px; margin: 4px; }
}

/* ── 统计脚 ── */
.song-list-footer {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 12px 0;
  flex-wrap: wrap;
}

/* 渐进渲染哨兵行：与 footer 同款居中位，按钮几何走 ink-btn 原子不另造 */
.song-list-more {
  display: flex;
  margin: 4px auto;
}

/* ── ⋯ 菜单点击捕手（菜单本体走全局 .pg-menu——teleport 出 scoped 域） ── */
.download-menu-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-overlay);
  background: transparent;
}
</style>

<script>
import { computed, ref, onBeforeUnmount } from 'vue'
import { usePagedList } from '../composables/usePagedList.js'
import { useServerDownloads } from '../composables/useServerDownloads.js'
import { httpsCover } from '../lib/url'
import PixelIcon from './PixelIcon.vue'
import GlitchText from './GlitchText.vue'
import { formatDuration } from '../lib/format'
import { isVipSong, visibleSongs, isLocalPlaylistId, isSingleSongShellId, isFileTrackId, songSource, songSourceName, songSourceUrl, songCoverUrl } from '../lib/song'
import { serverCaps } from '../lib/caps'
import { shareOrCopy, songShareUrl } from '../lib/share'
import { toast } from '../lib/feedback'

export default {
  name: 'SongList',
  components: {
    PixelIcon,
    GlitchText
  },
  props: {
    songs: {
      type: Array,
      default: () => []
    },
    currentSong: {
      type: Object,
      default: null
    },
    isPlaying: {
      type: Boolean,
      default: false
    },
    loadingSongs: {
      type: Boolean,
      default: false
    },
    showVipSongs: {
      type: Boolean,
      default: false
    },
    selectedPlaylist: {
      type: Object,
      default: null
    },
    playlistDownloadsRefreshKey: {
      type: Number,
      default: 0
    },
    // 选中远端单是否已在库——hero「收藏歌单」显隐（本地单恒在库，模板侧已挡）
    playlistInLibrary: {
      type: Boolean,
      default: true
    }
  },
  emits: ['play-song', 'play-all', 'play-shuffle', 'play-next', 'add-to-queue', 'add-to-playlist', 'add-songs', 'edit-song', 'collect-playlist', 'remove-from-playlist', 'sync-playlist', 'toggle-vip-songs'],
  setup(props, { emit }) {
    const showDownloadMenu = ref(null)
    const menuPositions = ref({})
    let menuTriggerBtn = null // 最近开菜单的 ⋯键——edit-song emit 的焦点归还目标


    // 过滤后的歌曲列表（根据VIP显示设置）——谓词与 App.vue 同一份（lib/song.js）
    const filteredSongs = computed(() =>
      visibleSongs(props.songs, props.showVipSongs, serverCaps.value)
    )

    // 渐进渲染窗：千曲歌单不再一次渲全量 DOM——前缀窗 150 起步，
    // 哨兵行（IO 命中或手动点按）扩窗。复位只认歌单身份：
    // silent 同步/单曲增删换 songs 引用时不回卷（不踢滚动位置）；
    // showVipSongs 过滤开关同理不回卷（前缀窗自夹）。
    // 已签收代价：窗外行不在 DOM——Ctrl+F/读屏只能覆盖已渲段
    // （虚拟化常态代价；哨兵键可聚焦，键盘仍能扩窗触达全表）
    const rowsEl = ref(null)
    const {
      rows: pagedRows, hasMore: pgHasMore, renderedCount,
      loadMore: loadMoreRows, bindSentinel,
    } = usePagedList({
      source: filteredSongs,
      pageSize: 150,
      resetWhen: () => props.selectedPlaylist?.id,
      scrollRoot: () => rowsEl.value,
    })

    // 菜单打开的目标歌曲：从全量 songs 里查（不依赖渲染切片）
    const menuSong = computed(() =>
      props.songs.find(s => String(s.id) === String(showDownloadMenu.value)) || null
    )

    // 本地内存态歌单：local_pl_/saved_queue_ 经镜像链有服务端下载能力，
    // 同步等远端专属能力仍按本谓词隐藏
    const isLocalPlaylist = computed(() =>
      isLocalPlaylistId(props.selectedPlaylist?.id)
    )
    // 单曲分享壳：本地态但语义是"一张曲的分享容器"——不提供移除/服务器下载入口

    const isShareShell = computed(() =>
      isSingleSongShellId(props.selectedPlaylist?.id)
    )

    // 服务端下载子域（composables/useServerDownloads.js）：状态批量映射 +
    // 行级下载/删除/视频补件 + 轮询生命周期（切单/卸载守卫全内置）
    const {
      serverDownloadedStates, serverDownloadingStates,
      canServerDownload, canServerVideo,
      downloadSongDirect, toggleServerDownload, downloadServerVideo,
    } = useServerDownloads({
      props, closeDownloadMenu: () => closeDownloadMenu(), isLocalPlaylist, isShareShell,
    })

    // 切换下载菜单显示
    const toggleDownloadMenu = (songId, event) => {
      if (showDownloadMenu.value === songId) {
        closeDownloadMenu()
      } else {
        // 切到另一首歌：旧歌的位置缓存即弃，直接删——否则 map 只增不减
        if (showDownloadMenu.value !== null) {
          delete menuPositions.value[showDownloadMenu.value]
        }
        // 计算菜单位置：下方空间不足时翻到按钮上方，左右越界时收回视口内
        const button = event.target.closest('button')
        menuTriggerBtn = button // ⋯键本体——菜单项要归还焦点时它是活着的锚
        const rect = button.getBoundingClientRect()
        // 估宽按最长项实测 ~200px（「获取源文件（最优音质）」「回源·源名」），
        // 不是 min-width 160——估低会把右缘钳点放错，长菜单右端出视口。
        // .pg-menu 另有 max-width:calc(100vw-16px) 双保险
        const menuWidth = 200
        // 菜单高度按实际项数算：实测 .pg-menu-item ≈39px（含发丝分隔），头部 ≈40px。
        // 固定项=下一首+队尾+添歌单+源文件 4 项；可分享（非 file_）多"分享歌曲"，
        // 可回源多"回源"，有已选歌单（除分享壳）多"编辑歌曲"+"从歌单移除"两项，
        // 可达服务端下载链多"下载到服务器"，外部有视频流的再多"下载视频到服务器"。
        // 注意 menuSong 此刻还是上一次的值（showDownloadMenu 未赋值）——按 songId 直查
        const targetSong = props.songs.find(s => String(s.id) === String(songId))
        const serverOk = !isShareShell.value && props.selectedPlaylist && canServerDownload(targetSong)
        const itemCount = 4
          + (!isFileTrackId(targetSong?.id) ? 1 : 0)
          + (songSourceUrl(targetSong) ? 1 : 0)
          + ((props.selectedPlaylist && !isShareShell.value) ? 2 : 0)
          + (serverOk ? 1 : 0)
          + (serverOk && canServerVideo(targetSong) ? 1 : 0)
        const menuHeight = 40 + itemCount * 39 + 4
        const vw = window.innerWidth
        const vh = window.innerHeight
        const belowFits = rect.bottom + 4 + menuHeight <= vh
        menuPositions.value[songId] = {
          top: (belowFits ? rect.bottom + 4 : Math.max(8, rect.top - menuHeight - 4)) + 'px',
          left: Math.max(8, Math.min(rect.right - menuWidth, vw - menuWidth - 8)) + 'px'
        }
        showDownloadMenu.value = songId
      }
    }

    // 获取菜单位置
    const getMenuPosition = (songId) => {
      return menuPositions.value[songId] || { top: '0px', left: '0px' }
    }

    // 关闭菜单：所有关闭路径收口到这里，顺带清位置缓存（只增不减会泄漏）。
    // restoreFocus=true（Esc/遮罩点击解散）：焦点归还 ⋯触发键——菜单散了焦点
    // 不落 body。菜单项激活路径不传——下一跳（弹窗/动作）自己管焦点。
    // wasOpen 前置闸：menuTriggerBtn 缓存常驻——菜单没开时按 Esc 不许偷焦点
    const closeDownloadMenu = (restoreFocus = false) => {
      const wasOpen = showDownloadMenu.value !== null
      if (wasOpen) {
        delete menuPositions.value[showDownloadMenu.value]
      }
      showDownloadMenu.value = null
      if (restoreFocus && wasOpen && menuTriggerBtn?.isConnected) {
        menuTriggerBtn.focus({ preventScroll: true })
      }
    }

    // ⋯ 菜单操作：下一首播放 / 队尾追加 / 分享——先关菜单再派发给父组件
    const playNextFromMenu = () => {
      const song = menuSong.value
      closeDownloadMenu()
      if (song) emit('play-next', song)
    }

    const addToQueueFromMenu = () => {
      const song = menuSong.value
      closeDownloadMenu()
      if (song) emit('add-to-queue', song)
    }

    // 添加到歌单：emit 给 App 统一弹选择器（歌单库与持久化都在 App 侧）
    const addToPlaylistFromMenu = () => {
      const song = menuSong.value
      closeDownloadMenu()
      if (song) emit('add-to-playlist', song)
    }

    // 编辑：emit 给 App 开 SongFormDialog（表单态/上传编排在 App 侧）。
    // 第二参带 ⋯触发键——menuitem 在菜单卸载时就死了，关窗焦点要还到 ⋯上
    const editFromMenu = () => {
      const song = menuSong.value
      const trigger = menuTriggerBtn
      closeDownloadMenu()
      if (song) emit('edit-song', song, trigger)
    }

    // 从歌单移除：远端曲走墓碑、本地曲真删——合并语义在 App 侧统一
    const removeFromPlaylistFromMenu = () => {
      const song = menuSong.value
      closeDownloadMenu()
      if (song) emit('remove-from-playlist', song)
    }

    const shareFromMenu = () => {
      const song = menuSong.value
      closeDownloadMenu()
      if (song) shareSong(song)
    }

    // 回源：menuSong 维度的源站 URL 与来源名（菜单项显隐+文案）
    const menuSourceUrl = computed(() => songSourceUrl(menuSong.value))
    const menuSourceName = computed(() => songSourceName(menuSong.value) || '源站')
    const openSourceFromMenu = () => {
      const url = menuSourceUrl.value
      closeDownloadMenu()
      // noreferrer：不给源站带去本站 Referer（自托管实例域名属于用户资产信息）
      if (url) window.open(url, '_blank', 'noopener,noreferrer')
    }

    // 分享歌曲——链形态（?bili/?yt/?qq/?song + view=watch 直达）统一在 lib/share.js
    const shareSong = async (song) => {
      const artistNames = song.ar?.map(artist => artist.name).join(', ') || song.artists?.map(a => a.name).join(', ') || '未知艺术家'
      const shareUrl = songShareUrl(song)

      const result = await shareOrCopy({
        title: `🎵 ${song.name} - ${artistNames}`,
        text: `来听听这首歌：${song.name} - ${artistNames}`,
        url: shareUrl
      })
      if (result === 'copied') toast('分享链接已复制到剪贴板', 'success')
      else if (result === 'failed') toast('分享失败，请手动复制链接', 'error')
    }


    // fixed 菜单不随滚动移动——滚动/翻页时直接关，避免菜单悬空指错歌；Escape 同关
    if (typeof window !== 'undefined') {
      const closeOnScroll = () => { closeDownloadMenu() }
      const closeOnEscape = (e) => { if (e.key === 'Escape') closeDownloadMenu(true) }
      window.addEventListener('scroll', closeOnScroll, true)
      window.addEventListener('keydown', closeOnEscape)
      onBeforeUnmount(() => {
        window.removeEventListener('scroll', closeOnScroll, true)
        window.removeEventListener('keydown', closeOnEscape)
      })
    }

    // 歌曲 id 类型混用（数字/字符串）——统一 String 比较，否则当前曲高亮会丢
    const isCurrent = (song) => String(song.id) === String(props.currentSong?.id)

    return {
      filteredSongs,
      pagedRows,
      pgHasMore,
      renderedCount,
      loadMoreRows,
      bindSentinel,
      rowsEl,
      menuSong,
      isLocalPlaylist,
      isShareShell,
      formatDuration,
      isVipSong,
      songSource,
      isCurrent,

      showDownloadMenu,
      serverDownloadedStates,
      serverDownloadingStates,
      toggleDownloadMenu,
      playNextFromMenu,
      addToQueueFromMenu,
      addToPlaylistFromMenu,
      removeFromPlaylistFromMenu,
      shareFromMenu,
      menuSourceUrl,
      menuSourceName,
      openSourceFromMenu,
      shareSong,
      downloadSongDirect,
      editFromMenu,
      canServerDownload,
      toggleServerDownload,
      downloadServerVideo,
      canServerVideo,
      getMenuPosition,
      closeDownloadMenu,
      httpsCover,
      isFileTrackId,
      songCoverUrl
    }
  }
}
</script>

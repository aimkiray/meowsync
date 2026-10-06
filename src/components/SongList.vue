<template>
  <!-- 歌曲列表：songs 视图，落在 sage 纸色画布上（.app-shell[data-view="songs"] → --canvas-sage #abbab9） -->
  <div class="song-list-main flex flex-col h-full min-h-0">
    <!-- 歌单页头：裁切角标封面 + 元信息 + 墨块按钮组，未选歌单时不占位 -->
    <div v-if="selectedPlaylist" class="playlist-hero">
      <div class="playlist-hero-cover-wrap pg-corners">
        <img
          v-if="selectedPlaylist.coverImgUrl"
          :src="httpsCover(coverSizeUrl(selectedPlaylist.coverImgUrl, 240))"
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
          <!-- 排序态 VIP 开关虚设（displayRows 绕过滤）——禁用避免假动作 -->
          <button
            @click="$emit('toggle-vip-songs')"
            class="ink-btn ink-btn--ghost hero-vip-toggle"
            :aria-pressed="showVipSongs"
            :disabled="reorderMode"
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
            :disabled="loadingSongs || reorderMode"
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
            :disabled="loadingSongs || reorderMode"
            title="搜索歌曲加入本歌单（支持 B 站/YouTube 链接）"
          ><PixelIcon name="plus" :size="15" /> 添加歌曲</button>
          <!-- 下载管理：复用顶栏 ⋯「下载」同视图；当前歌单有队列时深链预选直达 -->
          <button
            @click="$emit('open-downloads')"
            class="ink-btn ink-btn--ghost"
            title="下载队列与任务管理"
          ><PixelIcon name="download" :size="15" /> 下载管理</button>
          <!-- 排序模式入口：本地单重排 tracks 本序，已入库远端单落 trackOrder
               覆盖层；未入库预览单无持久化落点（与 applyTrackEdit 同口径）不出入口 -->
          <button
            v-if="canReorder && !reorderMode"
            ref="sortBtn"
            @click="reorderMode = true"
            class="ink-btn ink-btn--ghost"
            :disabled="loadingSongs"
            title="拖拽或逐行移动调整歌曲顺序"
          ><PixelIcon name="grip" :size="15" /> 排序</button>
        </div>
      </div>
    </div>

    <!-- 排序模式工具条：归拢一键整理 + 完成收态。常态 hero 键不动 -->
    <div v-if="reorderMode" class="reorder-bar">
      <span class="pg-label pg-label--dim reorder-bar-hint">拖拽行或用行尾 ↑ ↓ 调整顺序</span>
      <button
        class="ink-btn ink-btn--ghost"
        @click="$emit('group-by-artist')"
        title="相同作者的歌曲自动归拢到一起"
      ><PixelIcon name="m-list" :size="14" /> 按歌手归拢</button>
      <button class="ink-btn" @click="exitReorderMode">完成</button>
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

    <div v-else ref="rowsEl" class="flex-1 min-h-0 overflow-y-auto song-rows" @dragleave="onRowsDragLeave">
      <!-- 虚拟滚动上沿 spacer：高度=窗外行数×行高，撑起真实 scrollHeight；
           bindAnchor 是窗数学的列表上沿实测锚（本列表第一子元素） -->
      <div v-if="!reorderMode" :ref="bindVAnchor" :style="{ height: vTopPad + 'px' }" aria-hidden="true"></div>
      <!-- 拖拽监听器只在排序态挂载（v-on 对象）：常挂=每行 4 个永不触发的死监听 -->
      <div
        v-for="(song, index) in displayRows"
        :key="song.id"
        class="song-row"
        :class="{
          'song-row--playing': isCurrent(song),
          'song-row--vip': isVipSong(song),
          'song-row--reorder': reorderMode,
          'song-row--dragging': reorderMode && dragIndex === index,
          'song-row--dragover': reorderMode && dragOverIndex === index && dragIndex !== index,
          'song-row--dragover-above': reorderMode && dragOverIndex === index && dragIndex > index
        }"
        :draggable="reorderMode"
        v-on="reorderMode ? {
          dragstart: (e) => onRowDragStart(index, e),
          dragover: (e) => onRowDragOver(index, e),
          drop: (e) => onRowDrop(index, e),
          dragend: onRowDragEnd,
        } : {}"
      >
        <div
          @click="onRowActivate(song)"
          @keydown.enter="onRowActivate(song)"
          @keydown.space.prevent="onRowActivate(song)"
          class="song-row-main"
          :tabindex="reorderMode ? -1 : 0"
          :role="reorderMode ? undefined : 'button'"
          :aria-label="reorderMode ? undefined : `播放 ${song.name}`"
        >
          <!-- 行首序号：常态等宽数字，悬停/当前曲换 ▶；排序模式换 grip 把手+位次 -->
          <span class="song-row-index">
            <PixelIcon v-if="reorderMode" name="grip" :size="13" class="song-row-grip" />
            <span class="song-row-index-num">{{ rowNumber(index) }}</span>
            <span v-if="!reorderMode" class="song-row-index-play"><PixelIcon name="play" :size="16" /></span>
          </span>
          <div
            class="song-cover-wrap"
            :class="{ 'playing-animation': isCurrent(song) && isPlaying }"
          >
            <img
              v-if="songCoverUrl(song)"
              :src="httpsCover(songThumbUrl(song, 96))"
              :alt="song.name"
              class="song-cover"
              loading="lazy"
              decoding="async"
              draggable="false"
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

        <!-- 行尾 ⋯ 菜单键：悬停/聚焦时露出，触屏常显；排序模式换 ↑↓ 位移键 -->
        <div class="song-actions">
          <template v-if="reorderMode">
            <button
              class="song-move-btn pg-icobtn pg-icobtn--bare pg-icobtn--sm"
              @click.stop="$emit('move-song', { dragId: song.id, targetId: displayRows[index - 1]?.id })"
              :disabled="index === 0"
              title="上移"
              aria-label="上移"
            >↑</button>
            <button
              class="song-move-btn pg-icobtn pg-icobtn--bare pg-icobtn--sm"
              @click.stop="$emit('move-song', { dragId: song.id, targetId: displayRows[index + 1]?.id })"
              :disabled="index === displayRows.length - 1"
              title="下移"
              aria-label="下移"
            >↓</button>
          </template>
          <button
            v-else
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

      <!-- 虚拟滚动下沿 spacer：撑出窗外余量（排序态渲全量不需要 spacer 对） -->
      <div v-if="!reorderMode" :style="{ height: vBottomPad + 'px' }" aria-hidden="true"></div>

      <!-- YTM 曲目列表全滚动：底部只留计数（分页器拆除） -->
      <div class="song-list-footer">
        <span class="pg-label pg-label--dim">
          共 {{ reorderMode ? displayRows.length : filteredSongs.length }} 首<template v-if="!reorderMode && !showVipSongs && songs.length > filteredSongs.length">（隐藏 {{ songs.length - filteredSongs.length }} 首VIP）</template>
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

          <!-- 外源曲词源纠错：自动匹配判错词（verify 否决）或没配上时重打
               服务端匹配链，命中把新 neteaseId 写回曲对象。分享壳不开放
               （壳对象不持久化——与「编辑歌曲」等 !isShareShell 项同口径） -->
          <div
            v-if="!isShareShell && (menuSong?.youtube || menuSong?.bilibili)"
            class="pg-menu-item"
            role="menuitem"
            tabindex="0"
            @click="rematchLyricFromMenu"
            @keydown.enter="rematchLyricFromMenu"
            @keydown.space.prevent="rematchLyricFromMenu"
          >
            <PixelIcon name="m-loop" :size="13" /> 重新匹配歌词
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.song-list-main {
  /* 全向走全站页缘档 --page-pad-x（≤640 收成 12px，见 style.css）：
     360px 视口 40px 边距吃掉 11% 屏宽——行信息列优先 */
  padding: var(--page-pad-x, 20px);
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

/* YTM 曲目行第四列：专辑名——与信息列均分剩余，≤640 compact 档让位
   （641+ 列表列宽 ≥577px，专辑列塞得下） */
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
@media (max-width: 640.98px) {
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
  gap: 2px; /* 同 .pl-actions 惯例——两个 24px 尾键贴死命中区会连成一片 */
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

/* ── 排序模式：工具条 + 拖拽态 + 行尾位移键 ── */
.reorder-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  border-bottom: var(--hairline-soft);
  flex-shrink: 0;
}
.reorder-bar-hint { flex: 1; }

/* 整行即把手：主区 grab 光标；激活语义已被 onRowActivate 拦住 */
.song-row--reorder .song-row-main { cursor: grab; }
.song-row--dragging { opacity: .45; }
/* drop 指示线：目标行底缘 accent 发丝——向下拖落在目标行下方（insert-at-index
   语义即目标位）；向上拖时落点在目标行上方，指示线换顶缘否则指错位 */
.song-row--dragover .song-row-main { box-shadow: inset 0 -2px 0 var(--accent-magenta-on-ink); }
.song-row--dragover-above .song-row-main { box-shadow: inset 0 2px 0 var(--accent-magenta-on-ink); }

/* 排序态行首：grip 把手 + 位次数字并排，悬停不再切 ▶（播放已禁用）；
   48px 容 13 图标 + 4 位等宽数字（千曲单 11px mono 约 27px）留 1px 余量 */
.song-row--reorder .song-row-index { width: 48px; gap: 3px; }
.song-row--reorder .song-row-index-num,
.song-row--reorder:hover .song-row-index-num,
.song-row--reorder:focus-within .song-row-index-num { display: inline; }
.song-row-grip { color: var(--ink-64); flex-shrink: 0; }

/* 排序态行尾：↑↓ 常显（不走 reveal-swap），时长固隐防叠字 */
.song-row--reorder .song-duration { opacity: 0; }
.song-move-btn {
  opacity: 1;
  pointer-events: auto;
  color: var(--ink-64);
  font-family: var(--font-mono);
  font-size: 12px;
}
.song-move-btn:disabled { opacity: .3; cursor: default; }
/* 当前曲墨底反白：grip/位移键跟随 ⋯键同款 label-grey 对比度 */
.song-row--reorder.song-row--playing .song-row-grip,
.song-row--reorder.song-row--playing .song-move-btn { color: var(--label-grey); }

/* 窄屏 hero 单列化：与 watch 页同向（YTM 歌单头双栏→单列折叠） */
@media (max-width: 640.98px) {
  .playlist-hero {
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }
  .playlist-hero-cover-wrap { width: 88px; height: 88px; margin: 4px; }
}

/* 矮视口（横屏手机 ~360px 高）：固定 hero 连封面~140px 吃掉近半屏——
   封面再收一档给行列表让位 */
@media (max-height: 540px) {
  .playlist-hero-cover-wrap { width: 56px; height: 56px; }
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

/* ── ⋯ 菜单点击捕手（菜单本体走全局 .pg-menu——teleport 出 scoped 域） ── */
.download-menu-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-overlay);
  background: transparent;
}
</style>

<script>
import { computed, ref, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import { useVirtualList } from '../composables/useVirtualList.js'
import { useServerDownloads } from '../composables/useServerDownloads.js'
import { readScrollMem, writeScrollMem, restoreScrollTop } from '../lib/scroll-mem'
import { httpsCover } from '../lib/url'
import PixelIcon from './PixelIcon.vue'
import GlitchText from './GlitchText.vue'
import { formatDuration } from '../lib/format'
import { isVipSong, visibleSongs, isLocalPlaylistId, isSingleSongShellId, isFileTrackId, songSource, songSourceName, songSourceUrl, songCoverUrl, songThumbUrl, coverSizeUrl } from '../lib/song'
import { serverCaps } from '../lib/caps'
import { shareOrCopy, songShareUrl } from '../lib/share'
import { toast } from '../lib/feedback'
import { musicApi } from '../api/music.js'
import { notifyLyricRematch } from '../composables/usePlayer.js'
import { applyMatchResult } from '../lib/external-songs.js'

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
  emits: ['play-song', 'play-all', 'play-shuffle', 'play-next', 'add-to-queue', 'add-to-playlist', 'add-songs', 'edit-song', 'collect-playlist', 'remove-from-playlist', 'sync-playlist', 'toggle-vip-songs', 'move-song', 'open-downloads', 'group-by-artist', 'song-meta-updated'],
  setup(props, { emit }) {
    const showDownloadMenu = ref(null)
    const menuPositions = ref({})
    let menuTriggerBtn = null // 最近开菜单的 ⋯键——edit-song emit 的焦点归还目标


    // 过滤后的歌曲列表（根据VIP显示设置）——谓词与 App.vue 同一份（lib/song.js）
    const filteredSongs = computed(() =>
      visibleSongs(props.songs, props.showVipSongs, serverCaps.value)
    )

    // 真虚拟滚动：滑窗渲染替代前缀窗——DOM 恒定 ~视口量级（前缀窗滚到
    // 底是全量同构，万曲单=万行+万封面 img）。行高 60px 均匀（.song-row-
    // main 8px×2 padding + 44px 封面）→ y=i*60 纯算术可算。复位只认歌单
    // 身份：silent 同步/单曲增删换 songs 引用时不回卷（不踢滚动位置）；
    // showVipSongs 过滤开关同理不回卷（长度 watch 自夹窗）。
    // 已签收代价：窗外行不在 DOM——Ctrl+F/读屏只能覆盖已渲段
    // （虚拟化常态代价；此前缀窗同款限制）
    const rowsEl = ref(null)
    const {
      rows: vRows, startIndex: vStartIndex, topPad: vTopPad, bottomPad: vBottomPad,
      bindAnchor: bindVAnchor,
    } = useVirtualList({
      source: filteredSongs,
      rowHeight: 60,
      scrollRoots: () => [rowsEl.value],
      resetWhen: () => props.selectedPlaylist?.id,
    })

    // 离场滚动记忆：点歌进 watch 即整卸——回来还在原行附近，不塌回顶部。
    // 键绑歌单身份（换内容不还原）；spacer 让全量 scrollHeight 首帧就
    // 真实存在——不再需要 ensureRendered 先物化前缀窗，直接还位
    const scrollMemKey = () => `songs:${props.selectedPlaylist?.id ?? ''}`
    let cancelScrollRestore = null
    onMounted(() => {
      const m = readScrollMem(scrollMemKey())
      if (!m) return
      // 挂载期 loading/空态下 rowsEl 尚未渲出（v-else 分支）——只试一次会
      // 把还位永久丢弃；挂一次性 watcher 等滚动器首渲后再还位。
      // isConnected 挡 nextTick 间隙里整卸后对游离节点空转。
      // （不能 watch+immediate 里自闭 stop：immediate 回调同步跑在 watch()
      // 返回之前，句柄还在 TDZ——已渲路径只能手动分流）
      const restore = (el) => nextTick(() => {
        if (el.isConnected) cancelScrollRestore = restoreScrollTop(el, m.top)
      })
      if (rowsEl.value) {
        restore(rowsEl.value)
      } else {
        const stop = watch(rowsEl, (el) => {
          if (!el) return
          stop()
          restore(el)
        })
      }
    })
    onBeforeUnmount(() => {
      cancelScrollRestore?.() // 等待窗内卸载即停轮询
      writeScrollMem(scrollMemKey(), { top: rowsEl.value?.scrollTop ?? 0 })
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
        // 可达服务端下载链多"下载到服务器"，外部有视频流的再多"下载视频到服务器"，
        // 外源曲（bv_/yt_ provider 对象在，分享壳除外）再多"重新匹配歌词"。
        // 注意 menuSong 此刻还是上一次的值（showDownloadMenu 未赋值）——按 songId 直查
        const targetSong = props.songs.find(s => String(s.id) === String(songId))
        const serverOk = !isShareShell.value && props.selectedPlaylist && canServerDownload(targetSong)
        const itemCount = 4
          + (!isFileTrackId(targetSong?.id) ? 1 : 0)
          + (songSourceUrl(targetSong) ? 1 : 0)
          + ((props.selectedPlaylist && !isShareShell.value) ? 2 : 0)
          + (serverOk ? 1 : 0)
          + (serverOk && canServerVideo(targetSong) ? 1 : 0)
          + ((!isShareShell.value && (targetSong?.youtube || targetSong?.bilibili)) ? 1 : 0)
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

    // 重新匹配歌词（外源曲词源纠错）：把错配的 neteaseId 否进 excludeIds
    // 让服务端 /match/retry 换绑重跑（无匹配史则空否决集跑首配）。写回走
    // applyMatchResult 整组重建（name/al/匹配证据随行）而非只换
    // neteaseId——错配烘进 al 的专辑名/封面是持久化元信息残留，光换绑
    // 洗不掉。命中/解绑两路都 emit 'song-meta-updated' 让 App 立即落盘：
    // 改的是库 pl.tracks 元素，等下一次歌单写捎带会丢「关页前最后一次
    // 纠错」（服务端 song_match 行已被 retry 覆写，两端同写才算闭环）。
    // 正播的曲再 notifyLyricRematch 让播放器侧补写引用+热重载词
    const rematchInflight = new Set()
    const rematchLyricFromMenu = async () => {
      const song = menuSong.value
      closeDownloadMenu()
      if (!song || rematchInflight.has(song.id)) return
      rematchInflight.add(song.id)
      const ext = song.youtube || song.bilibili
      const durationMs = song.dt || song.duration
      // /match/retry 最坏 ~55s——关菜单后没有任何反馈会像点了死键，先落
      // in-flight 提示；终态（命中/解绑/失败）由下方 toast 接管
      toast('正在重新匹配歌词…', 'info')
      try {
        const matched = await musicApi.retryMatch({
          trackId: song.id,
          title: ext?.title || song.name || '',
          author: ext?.author || '',
          // provider 块只持久化 author/authorClean，没有 artists 字段
          // （见 external-songs.js）——authorClean 是剥 ' - Topic'/'VEVO'
          // 后的真艺人名，一并喂服务端 sourceInfo.artists 打分器
          artists: [ext?.author, ext?.authorClean].filter(Boolean),
          durationSec: Number.isFinite(durationMs) ? Math.round(durationMs / 1000) : undefined,
          excludeIds: song.neteaseId != null ? [song.neteaseId] : [],
        })
        if (matched?.id) {
          // retryMatch 回包已把同层诊断字段并进 matched 返回（matchedBy/
          // score，见 music.js）——extras 直接喂修复器落 provider 块
          applyMatchResult(song, matched, { matchedBy: matched.matchedBy, matchScore: matched.score })
          emit('song-meta-updated', song)
          toast(`词源已重匹配为《${matched.name || matched.id}》`, 'success')
          // 菜单侧对象与正播对象不一定是同一引用（搜索/快照来源不同）——
          // 通知里捎上新词源 id，播放器侧幂等补写
          notifyLyricRematch(song.id, matched.id)
        } else {
          // 用户显式否决后的空回包按解绑处理而非「没找到」败象：词源与
          // 派生字段回 provider 态——「这不是」是强信号，留错绑不如没绑
          const hadBinding = song.neteaseId != null
          applyMatchResult(song, null)
          emit('song-meta-updated', song)
          toast(hadBinding ? '已解除错配，暂无更准的词源' : '没找到更准的匹配', 'info')
          notifyLyricRematch(song.id, null) // 解绑信号：正播曲清绑+热重载词
        }
      } catch (e) {
        toast(`重新匹配失败：${e?.response?.data?.message || e?.message || '网络错误'}`, 'error')
      } finally {
        rematchInflight.delete(song.id)
      }
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


    // fixed 菜单不随滚动移动——滚动/翻页时直接关，避免菜单悬空指错歌；
    // resize 同理（菜单位置点击时算死，视口变了即过期）；Escape 同关
    if (typeof window !== 'undefined') {
      const closeOnScroll = () => { closeDownloadMenu() }
      const closeOnEscape = (e) => {
        if (e.key !== 'Escape') return
        // 菜单优先：开着菜单时 Esc 归菜单（焦点归还触发键）；否则收排序态
        if (showDownloadMenu.value !== null) { closeDownloadMenu(true); return }
        if (reorderMode.value) exitReorderMode()
      }
      window.addEventListener('scroll', closeOnScroll, true)
      window.addEventListener('resize', closeOnScroll)
      window.addEventListener('keydown', closeOnEscape)
      onBeforeUnmount(() => {
        window.removeEventListener('scroll', closeOnScroll, true)
        window.removeEventListener('resize', closeOnScroll)
        window.removeEventListener('keydown', closeOnEscape)
      })
    }

    // 歌曲 id 类型混用（数字/字符串）——统一 String 比较，否则当前曲高亮会丢
    const isCurrent = (song) => String(song.id) === String(props.currentSong?.id)

    // ── 排序模式 ──
    // 入口闸：单曲分享壳无歌单语义；未入库预览单无持久化落点（与 applyTrackEdit
    // 同口径——做了也只活到下次选单）。模式内渲全量 props.songs 绕开 VIP 过滤
    // 与渐进窗：隐藏曲被排除会错落 trackOrder 尾部，分页窗外行无法被拖——
    // 全量 DOM 是瞬态编辑态的可签收代价（千曲单偏重但功能正确优先）
    const reorderMode = ref(false)
    const dragIndex = ref(-1)
    const dragOverIndex = ref(-1)
    const canReorder = computed(() =>
      !isShareShell.value
      && (isLocalPlaylist.value || props.playlistInLibrary)
      && props.songs.length > 1
    )
    // displayRows 是行渲染的唯一入口——排序态绕过 filteredSongs/虚拟窗
    // （排序需要全量行在位：隐藏曲被排除会错落 trackOrder 尾部，且拖放
    // 的几何语义是全表；全量 DOM 是排序态的已签收瞬时成本——滑窗与全量
    // 等高，进出排序 scrollTop 原位保持）
    const displayRows = computed(() => reorderMode.value ? props.songs : vRows.value)
    // 行号：排序态 index 即全局序；滑窗态补 startIndex 偏移
    const rowNumber = (i) => (reorderMode.value ? i : vStartIndex.value + i) + 1

    // 焦点归还锚：退出排序态（完成/Esc）把焦点还给入口键——键盘用户不落 body。
    // 入口键在排序态被 v-if 卸载、退出后才重挂载：当下 sortBtn 恒 null（旧代码
    // 因此是死路径），须等重渲一帧再聚焦；canReorder 同帧翻 false 时无锚可还
    const sortBtn = ref(null)

    const exitReorderMode = () => {
      const wasActive = reorderMode.value
      reorderMode.value = false
      dragIndex.value = -1
      dragOverIndex.value = -1
      dragSong = null // 程序化退出无 dragend 兜底，拖中快照一并清
      if (wasActive) {
        nextTick(() => sortBtn.value?.focus({ preventScroll: true }))
      }
    }
    // 切单/曲数塌缩自动收态：滞留排序态会让新单继承错位的 displayRows 口径
    watch(() => props.selectedPlaylist?.id, exitReorderMode)
    watch(() => props.songs.length <= 1 && reorderMode.value, (collapsed) => {
      if (collapsed) exitReorderMode()
    })
    // 排序态行点击不播放（拖拽与点击共享同一热区，激活语义让位给位移）
    const onRowActivate = (song) => {
      if (!reorderMode.value) emit('play-song', song)
    }

    // HTML5 DnD：MIME 标记隔外来内容 drop（桌面文件/页内文本），曲对象在
    // dragstart 捕获——排序态间列表被外部替换时，emit 仍带真实曲 id，
    // 落点 id 在 drop 当下重解析（App 侧双端 id 锚定再保险）
    const MOVE_MIME = 'application/x-meowsync-track-move'
    let dragSong = null
    const isMoveDrag = (e) => !!e.dataTransfer?.types?.includes(MOVE_MIME)
    const onRowDragStart = (index, e) => {
      if (!reorderMode.value) return
      dragIndex.value = index
      dragSong = props.songs[index] || null
      e.dataTransfer.effectAllowed = 'move'
      // Firefox 无 setData 不启拖拽；MIME 标记即 payload
      try { e.dataTransfer.setData(MOVE_MIME, '1') } catch { /* 个别宿主禁写——ref 侧已锚定 */ }
    }
    const onRowDragOver = (index, e) => {
      if (dragIndex.value < 0 || !isMoveDrag(e)) return
      e.preventDefault() // 必须 prevent 才允许 drop
      e.dataTransfer.dropEffect = 'move'
      dragOverIndex.value = index
    }
    const onRowDrop = (index, e) => {
      e.preventDefault()
      const dragId = dragSong?.id
      const targetId = displayRows.value[index]?.id
      if (dragId != null && targetId != null && dragIndex.value !== index) {
        emit('move-song', { dragId, targetId })
      }
      onRowDragEnd()
    }
    // dragleave 上容器：离开整个行列表（含飘到 footer/工具条死区）清指示线；
    // 行间迁移的 dragleave 由 relatedTarget 仍在容器内过滤掉
    const onRowsDragLeave = (e) => {
      if (dragIndex.value < 0) return
      if (e.relatedTarget && rowsEl.value?.contains(e.relatedTarget)) return
      dragOverIndex.value = -1
    }
    const onRowDragEnd = () => {
      dragIndex.value = -1
      dragOverIndex.value = -1
      dragSong = null
    }
    // 外部整体换表（静默同步/追加撞库等）清在途拖拽态——下标已错位；
    // 自身位移的写也走这里，无碍（drop 时已显式收尾）
    watch(() => props.songs, onRowDragEnd)

    return {
      filteredSongs,
      displayRows,
      rowNumber,
      reorderMode,
      canReorder,
      dragIndex,
      dragOverIndex,
      sortBtn,
      exitReorderMode,
      onRowActivate,
      onRowDragStart,
      onRowDragOver,
      onRowDrop,
      onRowDragEnd,
      onRowsDragLeave,
      vTopPad,
      vBottomPad,
      bindVAnchor,
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
      rematchLyricFromMenu,
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
      songCoverUrl,
      songThumbUrl,
      coverSizeUrl
    }
  }
}
</script>

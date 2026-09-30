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
        <!-- 主按钮墨块 / 随机、VIP 过滤同为幽灵键；on 态 accent 字 + ✓ 前缀 -->
        <div class="playlist-hero-actions">
          <button
            @click="$emit('play-all')"
            class="ink-btn"
            title="播放全部"
          ><PixelIcon name="play" :size="18" /> 播放</button>
          <button
            @click="$emit('play-shuffle')"
            class="ink-btn ink-btn--ghost"
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
        </div>
      </div>
    </div>

    <div v-if="loadingSongs" class="song-state">
      <div class="pixel-loading" aria-hidden="true"></div>
      <p class="song-state-text">加载歌曲中喵...</p>
    </div>

    <div v-else-if="songs.length === 0" class="song-state">
      <PixelIcon name="note" :size="36" class="song-state-icon" />
      <p class="song-state-text">从左侧选择歌单，或在顶部搜索发现新歌单喵~</p>
    </div>

    <div v-else class="flex-1 min-h-0 overflow-y-auto song-rows">
      <div
        v-for="(song, index) in filteredSongs"
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
              v-if="song.al?.picUrl || song.album?.picUrl"
              :src="httpsCover(song.al?.picUrl || song.album?.picUrl)"
              :alt="song.name"
              class="song-cover"
            />
            <div v-else class="song-cover song-cover--fallback"><PixelIcon name="note" :size="16" /></div>
          </div>
          <div class="song-info">
            <h4 class="song-title">
              <span class="song-title-text">{{ song.name }}</span>
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
        @click="closeDownloadMenu"
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
          <div
            class="pg-menu-item"
            role="menuitem"
            tabindex="0"
            @click="shareFromMenu"
            @keydown.enter="shareFromMenu"
            @keydown.space.prevent="shareFromMenu"
          >
            <PixelIcon name="share" :size="13" /> 分享歌曲
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
            <PixelIcon name="download" :size="13" /> {{ menuSong?.bilibili ? '获取源文件 (m4a)' : '获取源文件 (320k)' }}
          </div>

          <!-- 下载到服务器 / 删除已下载：single_song_ 分享壳无服务端持久化意义隐藏；
               local_pl_/saved_queue_ 经镜像链走既有路由。B 站曲无服务端下载源不渲染 -->
          <div
            v-if="!isShareShell && selectedPlaylist && !menuSong?.bilibili && !String(menuSong?.id ?? '').startsWith('bv_')"
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
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.song-list-main {
  padding: 20px;
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

/* 触屏无 hover——隐形但可点的 ⋯ 键会误触，常显 */
@media (hover: none) {
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

/* ── ⋯ 菜单点击捕手（菜单本体走全局 .pg-menu——teleport 出 scoped 域） ── */
.download-menu-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-overlay);
  background: transparent;
}
</style>

<script>
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { musicApi } from '../api/music.js'
import { downloadsApi } from '../api/downloads.js'
import { httpsCover } from '../lib/url'
import PixelIcon from './PixelIcon.vue'
import GlitchText from './GlitchText.vue'
import { formatDuration } from '../lib/format'
import { isVipSong, isLocalPlaylistId, isSingleSongShellId } from '../lib/song'
import { shareOrCopy } from '../lib/share'
import { toast, pixelConfirm } from '../lib/feedback'

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
    }
  },
  emits: ['play-song', 'play-all', 'play-shuffle', 'play-next', 'add-to-queue', 'add-to-playlist', 'remove-from-playlist', 'sync-playlist', 'toggle-vip-songs'],
  setup(props, { emit }) {
    const showDownloadMenu = ref(null)
    const downloadingStates = ref({})
    const menuPositions = ref({})

    // 服务器下载状态
    const serverDownloadedStates = ref({})  // 是否已下载
    const serverDownloadingStates = ref({}) // 是否正在下载
    // 组件卸载标志：单曲下载轮询挂在 v-if 挂载的组件上，切到管理面板即卸载——
    // props 卸载后仍持旧值，stillCurrent 永真会让孤儿轮询空转 10min 还跨视图弹窗
    let viewDisposed = false

    // 过滤后的歌曲列表（根据VIP显示设置）
    const filteredSongs = computed(() => {
      if (props.showVipSongs) {
        return props.songs // 显示所有歌曲
      } else {
        return props.songs.filter(song => !isVipSong(song)) // 隐藏VIP歌曲
      }
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
        const rect = button.getBoundingClientRect()
        const menuWidth = 160 // 与 .pg-menu min-width 一致，防止右缘溢出视口
        // 菜单高度按实际项数算：实测 .pg-menu-item ≈39px（含发丝分隔），头部 ≈40px。
        // 固定项=下一首+队尾+添歌单+分享+源文件 5 项；有已选歌单（除分享壳）多"从歌单移除"，
        // 除分享壳的歌单且非 B 站曲再多"下载到服务器"——合计 5/6/7 三档。
        // 注意 menuSong 此刻还是上一次的值（showDownloadMenu 未赋值）——按 songId 直查
        const targetSong = props.songs.find(s => String(s.id) === String(songId))
        const itemCount = 5
          + ((props.selectedPlaylist && !isShareShell.value) ? 1 : 0)
          + ((!isShareShell.value && props.selectedPlaylist && !targetSong?.bilibili && !String(targetSong?.id ?? '').startsWith('bv_')) ? 1 : 0)
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

    // 关闭菜单：所有关闭路径收口到这里，顺带清位置缓存（只增不减会泄漏）
    const closeDownloadMenu = () => {
      if (showDownloadMenu.value !== null) {
        delete menuPositions.value[showDownloadMenu.value]
      }
      showDownloadMenu.value = null
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

    // 分享歌曲
    const shareSong = async (song) => {
      const artistNames = song.ar?.map(artist => artist.name).join(', ') || song.artists?.map(a => a.name).join(', ') || '未知艺术家'
      // 带 view=watch：冷启动打开分享链后落在播放页（YTM watch 同款直达）；
      // B 站导入曲走 ?bili=BV 链——?song= 只认网易云数值 id；分P带 p 参数
      const shareUrl = song.bilibili?.bvid
        ? `${window.location.origin}/?bili=${song.bilibili.bvid}${song.bilibili.page > 1 ? `&p=${song.bilibili.page}` : ''}&view=watch`
        : `${window.location.origin}/?song=${song.id}&view=watch`

      const result = await shareOrCopy({
        title: `🎵 ${song.name} - ${artistNames}`,
        text: `来听听这首歌：${song.name} - ${artistNames}`,
        url: shareUrl
      })
      if (result === 'copied') toast('分享链接已复制到剪贴板', 'success')
      else if (result === 'failed') toast('分享失败，请手动复制链接', 'error')
    }

    // 服务端错误统一返回 { code, message }，优先取 message 展示
    const extractErrorMessage = (error) => {
      return error.response?.data?.message || error.message
    }

    // 直接下载（浏览器下载，最高码率）
    const downloadSongDirect = async (song, bitrate = 320000) => {
      if (!song) {
        // 菜单目标已不在当前歌单（翻页/换单后残留）——关菜单而不是静默无效
        closeDownloadMenu()
        return
      }
      // 点击即关菜单：直接下载要等整个 fetch+blob（可能数十秒），
      // 留着透明 overlay 罩全屏会阻塞一切点击
      closeDownloadMenu()
      try {
        downloadingStates.value[song.id] = true
        // blob 下载全程无浏览器自带进度提示——先给一个开始戳记，终点由浏览器下载栏呈现
        toast(`正在获取「${song.name}」…`, 'info')
        // B 站导入曲没有网易云下载链——拉自己的 /bilibili/stream（m4a）
        if (song.bilibili?.bvid) await musicApi.downloadBilibiliSong(song)
        else await musicApi.downloadSong(song, bitrate)
      } catch (error) {
        console.error('下载失败:', error)
        toast('下载失败: ' + extractErrorMessage(error), 'error')
      } finally {
        downloadingStates.value[song.id] = false
      }
    }

    // 批量查询所有歌曲的下载状态：一次 listTasks 拉回该歌单全部任务本地映射，
    // 避免逐曲 N+1 请求（歌单未导入/未镜像时服务端返回空数组，天然无副作用）
    // 请求序号守卫：切歌单时旧歌单的 in-flight 响应不能写状态（跨歌单同 songId 会串标）
    let statusCheckSeq = 0
    const checkAllSongsDownloadStatus = async () => {
      const seq = ++statusCheckSeq
      const playlistId = props.selectedPlaylist?.id
      // single_song_ 壳无服务端镜像面；local_pl_/saved_queue_ 经镜像行
      // findExistingPlaylistId 自然解析——无需前置镜像
      if (!playlistId || !props.songs.length || isShareShell.value) {
        serverDownloadedStates.value = {}
        serverDownloadingStates.value = {} // 在途标记同属旧歌单，一并清
        return
      }

      try {
        const response = await downloadsApi.listTasks({ playlistId })
        if (seq !== statusCheckSeq) return // 已有更新的请求在飞，丢弃本次结果
        // 畸形响应（如反代把 API 误指到静态服返回 HTML 200）必须当失败处理，
        // 否则 || [] 会把全部"已下载"标记静默清成未下载
        const tasks = response.data?.data
        if (!Array.isArray(tasks)) {
          throw new Error('任务列表响应格式异常')
        }
        const downloadedIds = new Set(
          // completed 但文件已被外部删除的行（filesIntact=false）不算已下载——
          // 与单曲状态口径一致，重新露出下载入口走自愈重跑
          tasks.filter(t => t.status === 'completed' && t.filesIntact !== false)
            .map(t => String(t.songId))
        )
        for (const song of props.songs) {
          serverDownloadedStates.value[song.id] = downloadedIds.has(String(song.id))
        }
      } catch (error) {
        if (seq !== statusCheckSeq) return
        // 查询失败必须清空旧状态：否则切歌单/服务重启后残留上一歌单的"已下载"标记
        serverDownloadedStates.value = {}
        console.error('查询下载状态失败:', error)
      }
    }

    // 下载到服务器或删除
    const toggleServerDownload = async (song) => {
      if (!song) {
        closeDownloadMenu()
        return
      }
      // 在途守卫：处理中再点会发出重复请求撞服务端 409，
      // 用户看到的却是"下载失败"——直接关菜单静默返回
      if (song && serverDownloadingStates.value[song.id]) {
        closeDownloadMenu()
        return
      }
      if (!props.selectedPlaylist) {
        toast('请先选择歌单', 'error')
        closeDownloadMenu()
        return
      }

      // 本地单下载前先镜像——服务端任务按歌单行组织，镜像后 playlist.id
      // 经 findExistingPlaylistId 解析即可复用全部既有路由
      const isDownloaded = serverDownloadedStates.value[song.id]
      // 请求在途时用户可能已切换歌单——响应落地后写状态会污染新歌单的同 id 歌曲
      // （状态 map 是"当前歌单"的视图，写前必须确认归属未变）
      const ownerPlaylistId = props.selectedPlaylist.id
      const stillCurrent = () =>
        !viewDisposed
        && String(props.selectedPlaylist?.id) === String(ownerPlaylistId)

      if (isDownloaded) {
        // 删除已下载文件
        if (!await pixelConfirm(`确定要删除 "${song.name}" 的已下载文件吗？`, { confirmText: '删除', danger: true })) {
          closeDownloadMenu()
          return
        }

        try {
          serverDownloadingStates.value[song.id] = true
          await downloadsApi.deleteSongDownload(ownerPlaylistId, song.id)
          if (stillCurrent()) serverDownloadedStates.value[song.id] = false
          toast('删除成功', 'success')
        } catch (error) {
          console.error('删除失败:', error)
          toast('删除失败: ' + extractErrorMessage(error), 'error')
        } finally {
          if (stillCurrent()) {
            serverDownloadingStates.value[song.id] = false
          }
          closeDownloadMenu()
        }
      } else {
        // 下载到服务器：提交即返回任务行，终态靠状态轮询（不再同步挂起 HTTP——
        // 长下载不会被反代/浏览器超时切断，重试也不会撞出脏响应）
        try {
          serverDownloadingStates.value[song.id] = true
          if (isLocalPlaylist.value) {
            await downloadsApi.mirrorLocalPlaylist(props.selectedPlaylist)
          }
          const response = await downloadsApi.downloadSongToServer(ownerPlaylistId, song.id, {
            bitrate: 320000,
            downloadAudio: true,
            downloadLyrics: true,
            downloadCover: true
          })
          const submittedTask = response.data?.data
          // completed 短路（幂等返回）才跳过轮询；pending/downloading 进入轮询
          if (submittedTask?.status !== 'completed') {
            // 轮询窗口封顶 10min：超时只报"仍在后台"，任务在服务端继续跑
            const deadline = Date.now() + 10 * 60 * 1000
            let terminal = null
            // 单次轮询失败（网络抖动/超时）不该判死下载——容忍连续 3 次再放弃，
            // 服务端任务不受影响
            let pollErrors = 0
            while (stillCurrent() && Date.now() < deadline) {
              await new Promise(resolve => setTimeout(resolve, 1500))
              let stData
              try {
                const st = await downloadsApi.getSongDownloadStatus(ownerPlaylistId, song.id)
                stData = st.data?.data
                pollErrors = 0
              } catch (pollErr) {
                if (++pollErrors >= 3) throw pollErr
                continue
              }
              if (stData?.downloaded) {
                terminal = 'completed'
                break
              }
              const taskStatus = stData?.task?.status
              if (taskStatus === 'failed') {
                throw new Error(stData.task.errorMessage || '下载失败')
              }
              // 任务行被外部删掉（管理面板清理）：没有可等的目标，快速退出
              if (stData && stData.task === null) {
                throw new Error('下载任务已不存在（可能在下载管理中被清理）')
              }
            }
            // 用户已切走歌单：静默结束（状态不属于当前视图，不该弹窗打扰）
            if (!stillCurrent()) return
            if (terminal !== 'completed') {
              // 非失败语义的提示单独提示——混进"下载失败:"前缀是误导
              toast('下载仍在后台进行中，可稍后在下载管理里查看结果')
              return
            }
          }
          if (!stillCurrent()) return // 幂等命中也走同一出口：视图已换即静默
          serverDownloadedStates.value[song.id] = true
          toast('下载成功', 'success')
        } catch (error) {
          console.error('下载失败:', error)
          if (stillCurrent()) toast('下载失败: ' + extractErrorMessage(error), 'error')
        } finally {
          if (stillCurrent()) {
            serverDownloadingStates.value[song.id] = false
          }
          closeDownloadMenu()
        }
      }
    }

    // 监听歌曲列表/歌单变化，自动查询状态；切歌单先清旧状态防止串标
    watch(() => props.selectedPlaylist?.id, () => {
      serverDownloadedStates.value = {}
      serverDownloadingStates.value = {} // 处理中标记同样属于旧歌单，一并清
      closeDownloadMenu() // 菜单目标已随歌单失效，不留悬空菜单
      checkAllSongsDownloadStatus()
    })

    watch(() => props.songs, () => {
      checkAllSongsDownloadStatus()
    }, { immediate: true })

    watch(() => props.playlistDownloadsRefreshKey, () => {
      checkAllSongsDownloadStatus()
    })

    // fixed 菜单不随滚动移动——滚动/翻页时直接关，避免菜单悬空指错歌；Escape 同关
    if (typeof window !== 'undefined') {
      const closeOnScroll = () => { closeDownloadMenu() }
      const closeOnEscape = (e) => { if (e.key === 'Escape') closeDownloadMenu() }
      window.addEventListener('scroll', closeOnScroll, true)
      window.addEventListener('keydown', closeOnEscape)
      onBeforeUnmount(() => {
        viewDisposed = true // 终止下载轮询并屏蔽其状态写/弹窗
        window.removeEventListener('scroll', closeOnScroll, true)
        window.removeEventListener('keydown', closeOnEscape)
      })
    }

    // 歌曲 id 类型混用（数字/字符串）——统一 String 比较，否则当前曲高亮会丢
    const isCurrent = (song) => String(song.id) === String(props.currentSong?.id)

    return {
      filteredSongs,
      menuSong,
      isLocalPlaylist,
      isShareShell,
      formatDuration,
      isVipSong,
      isCurrent,

      showDownloadMenu,
      downloadingStates,
      serverDownloadedStates,
      serverDownloadingStates,
      toggleDownloadMenu,
      playNextFromMenu,
      addToQueueFromMenu,
      addToPlaylistFromMenu,
      removeFromPlaylistFromMenu,
      shareFromMenu,
      shareSong,
      downloadSongDirect,
      toggleServerDownload,
      getMenuPosition,
      closeDownloadMenu,
      httpsCover
    }
  }
}
</script>

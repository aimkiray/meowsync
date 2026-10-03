<template>
  <!-- 搜索结果页（粉纸画布）：上"歌曲"发丝行、下"歌单"纸面卡片。
       点击卡片=打开试听（不入库），+ 收藏=收进侧栏歌单库 -->
  <div ref="wrapEl" class="playlist-grid-wrap">
    <header class="grid-head">
      <div class="grid-head-text">
        <p class="pg-label">search results</p>
        <h2 class="grid-title" data-nosnippet><GlitchText text="搜索结果" /></h2>
      </div>
      <button class="pg-icobtn" @click="$emit('close')" title="返回首页" aria-label="返回首页"><PixelIcon name="close" :size="16" /></button>
    </header>

    <div v-if="loading" class="grid-state">
      <div class="pixel-loading" aria-hidden="true"></div>
      <p class="grid-state-text">搜索中喵...</p>
    </div>

    <div v-else-if="results.length === 0 && songs.length === 0" class="grid-state">
      <p class="grid-state-text">没有找到相关内容喵~</p>
    </div>

    <template v-else>
      <!-- YTM 分区结果：歌曲行在前（可直接播放），歌单卡片区在后 -->
      <section v-if="songs.length" class="result-section">
        <div class="result-section-head">
          <p class="pg-label">songs</p>
          <span class="result-section-sub">歌曲 · 点击即播</span>
        </div>
        <div
          v-for="(song, i) in pagedSongs"
          :key="song.id"
          class="song-result-row"
          :class="{ 'song-result-row--playing': String(currentSong?.id) === String(song.id) }"
        >
          <!-- 点击区收进 -main：行是容器，避免 button 嵌 role=button -->
          <div
            class="song-result-main"
            role="button"
            tabindex="0"
            :title="`播放 ${song.name}`"
            @click="$emit('play-song', song)"
            @keydown.enter="$emit('play-song', song)"
            @keydown.space.prevent="$emit('play-song', song)"
          >
            <span class="song-result-index">
              <span class="song-result-index-num">{{ i + 1 }}</span>
              <span class="song-result-index-play"><PixelIcon name="play" :size="16" /></span>
            </span>
            <img
              v-if="songCoverUrl(song)"
              :src="httpsCover(songThumbUrl(song, 96))"
              :alt="song.name"
              class="song-result-cover"
              loading="lazy"
              decoding="async"
            />
            <div v-else class="song-result-cover song-result-cover--fallback"><PixelIcon name="note" :size="16" /></div>
            <div class="song-result-info">
              <p class="song-result-name">{{ song.name }}</p>
              <p class="song-result-meta">{{ songArtist(song) }}<template v-if="songAlbum(song)"> · {{ songAlbum(song) }}</template></p>
            </div>
            <span class="song-result-duration">{{ formatSongDuration(song) }}</span>
          </div>
          <button
            type="button"
            class="row-add-btn pg-icobtn pg-icobtn--bare pg-icobtn--sm"
            title="添加到歌单"
            aria-label="添加到歌单"
            aria-haspopup="dialog"
            @click.stop="$emit('add-to-playlist', song)"
          ><PixelIcon name="plus" :size="14" /></button>
        </div>
        <!-- 本地渲染窗扩窗：append 不换引用故认首行 id 当身份——
             点服务端加载更多后窗不回卷，换新搜索才回卷 -->
        <button
          v-if="songHasMore"
          :ref="bindSongSentinel"
          class="ink-btn ink-btn--ghost ink-btn--sm grid-more"
          @click="loadMoreSongs()"
        >显示更多 · {{ songRendered }} / {{ songs.length }}</button>
        <!-- 单曲深挖：服务端翻页（cloudsearch offset+songCount）——
             20 首封顶的时代结束；QQ 源结果（songTotal=null）不亮此键。
             刻意只点按不接 IO 哨兵：每次点击=一次上游请求，
             滚动到底自动连发会打爆上游配额/风控 -->
        <button
          v-if="songTotal != null && songs.length < songTotal"
          class="ink-btn ink-btn--ghost ink-btn--sm grid-more"
          :disabled="songLoadingMore"
          @click="$emit('load-more-songs')"
        >{{ songLoadingMore ? '加载中喵…' : `加载更多歌曲 · ${songs.length} / ${songTotal}` }}</button>
      </section>

      <section v-if="results.length" class="result-section">
        <div class="result-section-head">
          <p class="pg-label">playlists</p>
          <span class="result-section-sub">歌单</span>
        </div>
        <div class="playlist-grid">
          <div
            v-for="playlist in pagedResults"
            :key="playlist.id"
            class="grid-card"
          >
            <div
              class="grid-card-main"
              @click="$emit('open', playlist)"
              @keydown.enter="$emit('open', playlist)"
              @keydown.space.prevent="$emit('open', playlist)"
              tabindex="0"
              role="button"
              :title="`打开《${playlist.name}》`"
            >
            <div class="grid-card-cover">
              <img
                v-if="playlist.coverImgUrl"
                :src="httpsCover(coverSizeUrl(playlist.coverImgUrl, 320))"
                :alt="playlist.name"
                loading="lazy"
                decoding="async"
              />
              <div v-else class="grid-card-cover-fallback"><PixelIcon name="note" :size="22" /></div>
            </div>
            <div class="grid-card-body">
              <h3 class="grid-card-name">{{ playlist.name }}</h3>
              <p class="grid-card-meta">{{ playlist.creator?.nickname || '神秘创建者' }} · {{ playlist.trackCount }} 首</p>
            </div>
            </div>
            <div class="grid-card-actions">
              <!-- 已入库的歌单换成静态戳记（语义同原 disabled 态，只是不再伪装成按钮） -->
              <button
                v-if="!inLibrary(playlist)"
                class="ink-btn ink-btn--sm grid-add"
                :disabled="adding.has(playlist.id)"
                @click.stop="handleAdd(playlist)"
                title="收藏到我的歌单"
              >{{ adding.has(playlist.id) ? '…' : '+ 收藏' }}</button>
              <span v-else class="pg-chip pg-chip--static grid-added" title="已在歌单库中"><PixelIcon name="check" :size="11" /> 已收藏</span>
              <button
                class="pg-icobtn grid-share"
                @click.stop="sharePlaylist(playlist)"
                title="分享歌单"
                aria-label="分享歌单"
              >
                <PixelIcon name="share" :size="14" />
              </button>
            </div>
          </div>
        </div>
        <!-- 渐进渲染哨兵：IO 命中或点按扩窗（歌单卡上限 100，40/批） -->
        <button
          v-if="gridHasMore"
          :ref="bindSentinel"
          class="ink-btn ink-btn--ghost ink-btn--sm grid-more"
          @click="loadMoreGrid()"
        >加载更多 · {{ gridRendered }} / {{ results.length }}</button>
      </section>

      <div class="grid-foot">
        <span class="pg-label pg-label--dim">{{ songs.length }} songs · {{ results.length }} playlists</span>
      </div>
    </template>
  </div>
</template>

<script>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { usePagedList } from '../composables/usePagedList.js'
import { readScrollMem, writeScrollMem, restoreScrollTop } from '../lib/scroll-mem'
import { shareOrCopy, playlistShareUrl } from '../lib/share'
import { toast } from '../lib/feedback'
import { httpsCover } from '../lib/url'
import { songCoverUrl, songThumbUrl, coverSizeUrl } from '../lib/song'
import { formatTime } from '../lib/format'
import PixelIcon from './PixelIcon.vue'
import GlitchText from './GlitchText.vue'

export default {
  name: 'PlaylistGrid',
  components: { PixelIcon, GlitchText },
  props: {
    results: {
      type: Array,
      default: () => []
    },
    // 单曲结果（type=1 搜索），点击即播并构成待播队列
    songs: {
      type: Array,
      default: () => []
    },
    // 服务端分页契约：null=本批不可深挖（QQ 源）；数字=上游 songCount
    songTotal: {
      type: Number,
      default: null
    },
    songLoadingMore: {
      type: Boolean,
      default: false
    },
    currentSong: {
      type: Object,
      default: null
    },
    userPlaylists: {
      type: Array,
      default: () => []
    },
    loading: {
      type: Boolean,
      default: false
    }
  },
  emits: ['open', 'add', 'close', 'play-song', 'add-to-playlist', 'load-more-songs'],
  setup(props, { emit }) {
    const httpsCoverUrl = httpsCover
    // 添加中的歌单 id：立即禁用按钮防连点，10s 兜底清（父组件入库后由 watch 提前清）
    const adding = ref(new Set())
    const addingTimeouts = new Map()

    const inLibrary = (playlist) =>
      props.userPlaylists.some(p => String(p.id) === String(playlist.id))

    const handleAdd = (playlist) => {
      const id = playlist.id
      if (adding.value.has(id) || inLibrary(playlist)) return
      adding.value.add(id)
      emit('add', playlist)
      // 兜底：父组件添加失败不会改 userPlaylists，10s 后恢复可重试
      addingTimeouts.set(id, setTimeout(() => {
        adding.value.delete(id)
        addingTimeouts.delete(id)
      }, 10000))
    }

    watch(() => props.userPlaylists, (list) => {
      const ids = new Set(list.map(p => String(p.id)))
      for (const id of [...adding.value]) {
        if (ids.has(String(id))) {
          adding.value.delete(id)
          clearTimeout(addingTimeouts.get(id))
          addingTimeouts.delete(id)
        }
      }
    }, { deep: true })

    onBeforeUnmount(() => {
      addingTimeouts.forEach(clearTimeout)
      addingTimeouts.clear()
    })

    const sharePlaylist = async (playlist) => {
      // 链形态与 PlaylistPanel 同一份（lib/share.js，含导入壳按引用分享分支）
      const shareUrl = playlistShareUrl(playlist)
      const result = await shareOrCopy({
        title: `🎵 歌单：${playlist.name}`,
        text: `来看看这个歌单：${playlist.name}`,
        url: shareUrl
      })
      if (result === 'copied') toast('分享链接已复制到剪贴板', 'success')
      else if (result === 'failed') toast('分享失败，请手动复制链接', 'error')
    }

    const songArtist = (song) =>
      (song.ar || song.artists || []).map(a => a?.name).filter(Boolean).join('/') || '未知艺人'

    const songAlbum = (song) => song.al?.name || song.album?.name || ''

    const formatSongDuration = (song) => formatTime((song.dt || song.duration || 0) / 1000)

    // 歌单卡渐进渲染窗：搜索结果一次换整块 results（新查询=新引用=身份变化），
    // 故 resetWhen 直接认数组引用——这不是 silent 刷新场景，回卷正确
    const wrapEl = ref(null)
    const {
      rows: pagedResults, hasMore: gridHasMore, renderedCount: gridRendered,
      loadMore: loadMoreGrid, ensureRendered: ensureGridRendered, bindSentinel,
    } = usePagedList({
      source: computed(() => props.results),
      pageSize: 40,
      resetWhen: () => props.results,
      scrollRoot: () => wrapEl.value,
    })
    // 单曲结果渲染窗：服务端「加载更多」append 时数组整体换引用，
    // 故 resetWhen 认首行 id——append 首行不变→窗不回卷；新搜索回卷。
    // 不变式依赖：useSearchNav 的整组替换路径（新搜索/QQ 导入）总是先
    // 清空 [] 再填，空写会先把 key 刷成 undefined 触发 reset——若未来
    // 出现「不清空直接覆盖」的写入路径，同首行 id 的新搜索会漏回卷，
    // 届时要换显式身份键（searchQuery/搜索序号）
    const {
      rows: pagedSongs, hasMore: songHasMore, renderedCount: songRendered,
      loadMore: loadMoreSongs, ensureRendered: ensureSongRendered, bindSentinel: bindSongSentinel,
    } = usePagedList({
      source: computed(() => props.songs),
      pageSize: 100,
      resetWhen: () => props.songs[0]?.id,
      scrollRoot: () => wrapEl.value,
    })

    // 离场滚动记忆：搜索结果数据在 nav 层不丢，丢的是滚动位与两个前缀窗——
    // 重挂先把两窗物化回各自深度再还 scrollTop，否则被窗高钳在首页处
    const SEARCH_SCROLL_KEY = 'search-grid'
    onMounted(() => {
      const m = readScrollMem(SEARCH_SCROLL_KEY)
      if (!m) return
      ensureGridRendered((m.grid || 0) - 1)
      ensureSongRendered((m.songs || 0) - 1)
      nextTick(() => restoreScrollTop(wrapEl.value, m.top))
    })
    onBeforeUnmount(() => writeScrollMem(SEARCH_SCROLL_KEY, {
      top: wrapEl.value?.scrollTop ?? 0,
      grid: gridRendered.value,
      songs: songRendered.value,
    }))

    return {
      httpsCover: httpsCoverUrl,
      songCoverUrl,
      songThumbUrl,
      coverSizeUrl,
      adding,
      inLibrary,
      handleAdd,
      sharePlaylist,
      songArtist,
      songAlbum,
      formatSongDuration,
      wrapEl,
      pagedResults,
      gridHasMore,
      gridRendered,
      loadMoreGrid,
      bindSentinel,
      pagedSongs,
      songHasMore,
      songRendered,
      loadMoreSongs,
      bindSongSentinel,
    }
  }
}
</script>

<style scoped>
.playlist-grid-wrap {
  /* 同 .home-feed：透明 border 抬滚动条车道离页缘，内容轴不动 */
  padding: 0 20px;
  border-block: 20px solid transparent;
  height: 100%;
  overflow-y: auto;
  scrollbar-gutter: stable;
}

/* 歌单卡渐进渲染哨兵：居中 ghost 键 */
.grid-more {
  display: flex;
  margin: 14px auto 0;
}

/* 页头：等宽微标签 + 大字标题 + 发丝方键关闭 */
.grid-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  padding-bottom: 16px;
  margin-bottom: 8px;
}

/* 关闭键落在 --canvas-pink 上：accent-magenta 与画布同值（hover 0 对比），用实墨保证反馈可见 */
.grid-head .pg-icobtn:hover { color: var(--ink); }

.grid-title {
  margin-top: 6px;
  font-family: var(--font-display);
  font-size: 28px;
  font-weight: 700;
  line-height: 1.15;
  color: var(--ink);
}

.grid-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 64px 16px;
  border-top: var(--hairline-soft);
}

.grid-state-text {
  font-size: 12px;
  color: var(--ink-64);
}

/* 分区：发丝线起头 + 微标签节题 */
.result-section {
  border-top: var(--hairline-soft);
  padding-top: 12px;
  margin-bottom: 26px;
}

.result-section-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 8px;
}

.result-section-sub {
  font-size: 12px;
  color: var(--ink-64);
}

/* 歌曲行：留白节奏（无分隔线），点击区收进 -main（行是容器，行尾 + 键不落播放） */
.song-result-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 8px;
  transition: background 0.12s;
}

.song-result-main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
}

.song-result-row:hover {
  background: var(--ink-06);
}

.song-result-row--playing {
  background: var(--ink-10);
}
/* 同上：hover(0,2,0)会压过--playing(0,1,0)把当前行调暗——钉住 */
.song-result-row--playing:hover {
  background: var(--ink-10);
}

.song-result-index {
  width: 18px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-64);
}

.song-result-index-play {
  display: none;
  color: var(--ink);
}

/* 序号 ↔ ▶ 互换（与 song-row 同构）；用行级 :focus-within——焦点移到 + 键时
   ▶ 保持（SongList 同构选择器语义），焦点在 -main 上时同样命中 */
.song-result-row:hover .song-result-index-num,
.song-result-row:focus-within .song-result-index-num,
.song-result-row--playing .song-result-index-num {
  display: none;
}
.song-result-row:hover .song-result-index-play,
.song-result-row:focus-within .song-result-index-play,
.song-result-row--playing .song-result-index-play {
  display: inline-flex;
}

.song-result-cover {
  width: 40px;
  height: 40px;
  object-fit: cover;
  border: var(--hairline);
  flex-shrink: 0;
}

.song-result-cover--fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ink-64);
  background: var(--paper);
}

.song-result-info {
  flex: 1;
  min-width: 0;
}

.song-result-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.song-result-meta {
  font-size: 11px;
  color: var(--ink-64);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.song-result-duration {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-64);
  flex-shrink: 0;
}

/* 卡片网格：自适应列数。minmax 下限 140px——360px 视口（内容宽 320px）
   恰好转 2 列；160 会让 360/375 档塌成单列巨卡，一屏只见一张 */
.playlist-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 16px;
}

/* 卡片外壳/cover/-name/-meta 均已上收全局 style.css。
   .grid-card-main 是 role=button 点击区——动作键是它兄弟节点，消灭嵌套可交互 */
.grid-card-main {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.grid-card-actions {
  display: flex;
  align-items: stretch; /* chip 戳记拉伸到与 ink-btn--sm 同高，入库瞬间不跳行高 */
  gap: 8px;
  margin-top: auto;
  min-height: var(--ctrl-h-sm); /* 行位恒占一档——30px 是钉高前的过时余量 */
}
.grid-add {
  flex: 1;
}

.grid-added {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: var(--ctrl-h-sm); /* pg-chip(24) 顶对齐会下缘悬空——钉到 ink-btn--sm 同高 */
}

.grid-share {
  flex-shrink: 0;
}

.grid-foot {
  border-top: var(--hairline-soft);
  padding: 12px 0;
  text-align: center;
}
</style>

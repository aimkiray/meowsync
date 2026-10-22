<template>
  <!-- 搜索结果页（粉纸画布）：上"歌曲"发丝行、下"歌单"纸面卡片。
       点击卡片=打开试听（不入库），+ 收藏=收进侧栏歌单库 -->
  <div ref="wrapEl" class="playlist-grid-wrap">
    <header class="grid-head">
      <div class="grid-head-text">
        <p class="pg-label">search results</p>
        <h2 class="grid-title" data-nosnippet><GlitchText text="搜索结果" /></h2>
        <!-- 上下文行：「"词" · 源名」——多源时代结果页要自报口径，
             不然切源重搜后用户分不清眼前是哪一库的产物。
             query/source 任一缺席即无完整语境，整行不渲 -->
        <p v-if="query && sourceName" class="pg-label pg-label--dim grid-head-ctx">“{{ query }}” · {{ sourceName }}</p>
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
        <!-- 虚拟滚动上沿 spacer（行高 56px 均匀）；曲列深挖可累积数千行 -->
        <div :ref="bindSongAnchor" :style="{ height: songTopPad + 'px' }" aria-hidden="true"></div>
        <div
          v-for="(song, i) in pagedSongs"
          :key="pagedSongKeys[i]"
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
              <span class="song-result-index-num">{{ songStartIndex + i + 1 }}</span>
              <span class="song-result-index-play"><PixelIcon name="play" :size="16" /></span>
            </span>
            <!-- 封面是紧邻歌名的装饰图：alt 置空防 SR 把歌名报两遍；
                 @error 按曲 id 记进 failedThumbs——裂图直接落音符占位，
                 同曲不再反复重发必 404 的请求 -->
            <img
              v-if="pagedSongThumbs[i] && !failedThumbs.has(String(song.id))"
              :src="httpsCover(pagedSongThumbs[i])"
              alt=""
              class="song-result-cover"
              loading="lazy"
              decoding="async"
              @error="failedThumbs.add(String(song.id))"
            />
            <div v-else class="song-result-cover song-result-cover--fallback"><PixelIcon name="note" :size="16" /></div>
            <div class="song-result-info">
              <!-- 歌名行：标题+来源角标同一 flex 行——name 收缩截断、
                   tag（B站/YouTube/QQ音乐/网易云/本地上传）恒完整钉在右缘内侧 -->
              <div class="song-result-title">
                <p class="song-result-name">{{ song.name }}</p>
                <span v-if="songSourceTag(song)" class="pg-chip pg-chip--static song-result-tag">{{ songSourceTag(song) }}</span>
              </div>
              <!-- 副行去重：songMeta 在专辑名=歌名时省略专辑段
                   （外源曲库常把标题回填成专辑名，复读一遍是噪声） -->
              <p class="song-result-meta">{{ songMeta(song) }}</p>
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
        <!-- 虚拟滚动下沿 spacer -->
        <div :style="{ height: songBottomPad + 'px' }" aria-hidden="true"></div>
        <!-- 单曲深挖：服务端翻页（cloudsearch offset+songCount）——
             20 首封顶的时代结束。亮灯口径收在父级 songHasMore：
             total 源（网易云/QQ）按 已载/total 判定，YT 无总数走
             continuation 游标在场即亮。刻意只点按不接 IO 哨兵：
             每次点击=一次上游请求，滚动到底自动连发会打爆上游配额/风控 -->
        <button
          v-if="songHasMore"
          class="ink-btn ink-btn--ghost ink-btn--sm grid-more"
          :disabled="songLoadingMore"
          @click="$emit('load-more-songs')"
        >{{ songLoadingMore ? '加载中喵…' : songMoreLabel }}</button>
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
                v-if="coverSizeUrl(playlist.coverImgUrl, 320)"
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

      <!-- 单腿源（yt/bili 本无歌单搜索腿）有曲无单时给指路行——
           空区沉默会被读成漏抓；整单导入入口在顶栏搜索框（粘链接） -->
      <p v-else-if="showPlaylistHint" class="pg-label pg-label--dim grid-hint">
        该源结果不含歌单——整单导入请把歌单链接粘到顶部搜索框
      </p>

      <div class="grid-foot">
        <span class="pg-label pg-label--dim">{{ songs.length }} songs · {{ results.length }} playlists</span>
      </div>
    </template>
  </div>
</template>

<script>
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { usePagedList } from '../composables/usePagedList.js'
import { useVirtualList } from '../composables/useVirtualList.js'
import { readScrollMem, writeScrollMem, restoreScrollTop } from '../lib/scroll-mem'
import { shareOrCopy, playlistShareUrl } from '../lib/share'
import { toast } from '../lib/feedback'
import { httpsCover } from '../lib/url'
import { songCoverUrl, songThumbUrl, coverSizeUrl, songSourceTag } from '../lib/song'
import { SEARCH_SOURCES } from '../lib/prefs.js'
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
    // 当前搜索词——滚动记忆键的身份段：换词重挂不还旧词的位置
    query: {
      type: String,
      default: ''
    },
    // 服务源戳（useSearchNav.searchSource）：哪个搜索 handler 立案记的
    // 哪个源——页头「"词" · 源名」与单腿源歌单 hint 都吃它；不读
    // prefSearchSource——搜完再切源会把旧结果误报成新源产物
    searchSource: {
      type: String,
      default: ''
    },
    // 服务端分页契约：null=无总数源（YT 恒 null；total 源失败回退）；
    // 数字=上游 songCount——只喂按钮文案的「n / total」，亮灯归 songHasMore
    songTotal: {
      type: Number,
      default: null
    },
    // 深挖键亮灯闸（useSearchNav.searchSongHasMore）：三口径合一——
    // total 源按已载<total，YT 按 continuation 游标非 null
    songHasMore: {
      type: Boolean,
      default: false
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

    // 回调只读成员 id——深监听整个歌单库（含所有 tracks）太重；
    // 收窄到与 PlaylistPanel 同款的 id 串口径，成员/次序变了才跑
    watch(() => props.userPlaylists.map(p => p.id).join(','), () => {
      const ids = new Set(props.userPlaylists.map(p => String(p.id)))
      for (const id of [...adding.value]) {
        if (ids.has(String(id))) {
          adding.value.delete(id)
          clearTimeout(addingTimeouts.get(id))
          addingTimeouts.delete(id)
        }
      }
    })

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

    // 副行去重：外源曲库常把标题回填成专辑名（yt/bili 无专辑概念，
    // build*Song 拿 title/songName 填 al.name）——「艺人 · 同名专辑」
    // 是复读；归一两侧再比：NFKC 折全角/兼容形 + 连空白塌单空格 +
    // 大小写不敏感（外源回填常夹全角空格/ＡＢＣ兼容形，裸 trim+lower 挡不住）
    const metaNorm = (s) =>
      String(s ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
    const songMeta = (song) => {
      const artist = songArtist(song)
      const album = songAlbum(song)
      if (album && metaNorm(album) === metaNorm(song?.name)) {
        return artist
      }
      return album ? `${artist} · ${album}` : artist
    }

    // 裂图登记（按曲 id 不按行键 id#n）：滑窗序号随深挖追加/回卷漂移，
    // 行键会换；同 id 两行共享一份登记恰是去重目的——封面 URL 本就同一个，
    // 一处裂图全行落音符占位。img @error 后该行永久落占位——同键不反复
    // 重发请求；新搜索换批（id 集全换）旧登记自然够不着新行，无需主动清
    const failedThumbs = reactive(new Set())

    // 页头源名：源 id 经 SEARCH_SOURCES 映全名；未知/缺席 = 无源语境
    // （id 预览等非搜索入口进的结果页），页头上下文行不渲
    const sourceName = computed(() =>
      SEARCH_SOURCES.find(s => s.id === props.searchSource)?.name || '')

    // 单腿源指路行：yt/bili 的搜索本就没有歌单腿——有曲无单时明示
    // 「源口径如此」并指路整单导入，别把空区读成漏抓/加载坏
    const showPlaylistHint = computed(() =>
      props.songs.length > 0 && props.results.length === 0
      && (props.searchSource === 'yt' || props.searchSource === 'bili'))

    const formatSongDuration = (song) => formatTime((song.dt || song.duration || 0) / 1000)

    // 深挖键文案：total 源带「n / total」进度；YT 无总数只报已载数
    const songMoreLabel = computed(() => props.songTotal != null
      ? `加载更多歌曲 · ${props.songs.length} / ${props.songTotal}`
      : `加载更多歌曲 · ${props.songs.length}`)

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
    // 单曲结果真虚拟滚动：滑窗替代前缀窗（深挖可累积数千行，前缀窗
    // 滚到底全量同构）。行高 56px 均匀（8px padding + 40px 封面）。
    // resetWhen 认首行 id——append 不换首行→窗不回卷；新搜索回卷。
    // 不变式依赖：useSearchNav 的整组替换路径（新搜索/QQ 导入）总是先
    // 清空 [] 再填，空写会先把 key 刷成 undefined 触发 reset——若未来
    // 出现「不清空直接覆盖」的写入路径，同首行 id 的新搜索会漏回卷，
    // 届时要换显式身份键（searchQuery/搜索序号）
    const {
      rows: pagedSongs, startIndex: songStartIndex,
      topPad: songTopPad, bottomPad: songBottomPad, bindAnchor: bindSongAnchor,
    } = useVirtualList({
      source: computed(() => props.songs),
      rowHeight: 56,
      scrollRoots: () => [wrapEl.value],
      resetWhen: () => props.songs[0]?.id,
    })

    // 行键：搜索结果可含重复曲 id（云村/QQ 多源同曲、深挖去重只挡跨页），
    // 裸 song.id 会撞 :key（duplicate-key 告警）。同 id 第 n 次出现给
    // `id#n`；键随渲染位走——同 id 两份行内容等效，与 SongList 同口径
    const pagedSongKeys = computed(() => {
      const seen = new Map()
      return pagedSongs.value.map(s => {
        const k = String(s?.id)
        const n = seen.get(k) ?? 0
        seen.set(k, n + 1)
        return `${k}#${n}`
      })
    })

    // 行封面缩略图：与 pagedSongKeys 同构的并行 computed——模板里
    // v-if/:src 两处消费同一值，收进数组一处求值（滑窗重算时按行序对齐），
    // 空 URL 归一成 '' 让 v-if 直接判真
    const pagedSongThumbs = computed(() =>
      pagedSongs.value.map(s => songThumbUrl(s, 96) || ''))

    // 离场滚动记忆：搜索结果数据在 nav 层不丢，丢的是滚动位与卡片窗——
    // 重挂先把卡片前缀窗物化回深度再还 scrollTop（曲列 spacer 天然全高）。
    // 键编查询词：别处（watch 页顶栏）发起的新搜索重挂本组件时，旧词位置
    // 不会串进新词结果（结果落地前 reset 回卷，但还位轮询还活着会误写）
    const scrollMemKey = () => `search-grid:${props.query ?? ''}`
    let cancelScrollRestore = null
    onMounted(() => {
      const m = readScrollMem(scrollMemKey())
      if (!m) return
      ensureGridRendered((m.grid || 0) - 1)
      nextTick(() => { cancelScrollRestore = restoreScrollTop(wrapEl.value, m.top) })
    })
    onBeforeUnmount(() => {
      cancelScrollRestore?.() // 等待窗内卸载即停轮询
      writeScrollMem(scrollMemKey(), {
        top: wrapEl.value?.scrollTop ?? 0,
        grid: gridRendered.value,
      })
    })

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
      songMeta,
      songSourceTag,
      failedThumbs,
      sourceName,
      showPlaylistHint,
      formatSongDuration,
      songMoreLabel,
      wrapEl,
      pagedResults,
      gridHasMore,
      gridRendered,
      loadMoreGrid,
      bindSentinel,
      pagedSongs,
      pagedSongKeys,
      pagedSongThumbs,
      songStartIndex,
      songTopPad,
      songBottomPad,
      bindSongAnchor,
    }
  }
}
</script>

<style scoped>
.playlist-grid-wrap {
  /* 同 .home-feed：border-top 抬滚动条车道离顶页缘，底缘滚齐
     播放器发丝线；横向页缘走 --page-pad-x 全站档（≤640 收 12px） */
  padding: 0 var(--page-pad-x, 20px);
  border-top: 20px solid transparent;
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

/* 页头上下文行（"词" · 源名）：贴标题下缘的次级注脚——
   pg-label--dim 供 12px/mono/淡墨，这里只管间距与防溢出 */
.grid-head-ctx {
  margin-top: 8px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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

/* 歌名行 flex：name 项重获省略语义须先松 min-width:auto 闸（flex
   项默认不肯缩到内容宽以下）；tag 恒完整不缩 */
.song-result-title {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.song-result-title .song-result-name { min-width: 0; }

.song-result-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 来源角标：chip 皮缩到 20px/11px 档——行内戳记不该与 24px 控件档同高
   （行高 56 虚拟滚动恒定，戳记超档会顶破行距假设） */
.song-result-tag {
  height: 20px;
  padding: 0 8px;
  font-size: 11px;
  flex-shrink: 0;
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
/* ≥641 卡片地板向 YTM 180 档半收：≥140 保 360px 双列；160 是 641+
   的更宽呼吸位（YTM new_releases 160/180 阶梯同构） */
@media (min-width: 641px) {
  .playlist-grid { grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); }
}
/* ≥901 向 YTM gap 24 档（16→24 @936 同型） */
@media (min-width: 901px) { .playlist-grid { gap: 24px; } }

/* 卡片外壳/cover/-name/-meta/.grid-card-main 均已上收全局 style.css。
   .grid-card-main 是 role=button 点击区——动作键是它兄弟节点，消灭嵌套可交互 */

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

/* 单腿源无歌单腿的指路行：与分区同发丝起头，占位在歌单 section 原位 */
.grid-hint {
  border-top: var(--hairline-soft);
  padding: 12px 0;
  margin-bottom: 26px;
  line-height: 1.6; /* pg-label 的 1 倍行高经不起窄屏折行 */
}

.grid-foot {
  border-top: var(--hairline-soft);
  padding: 12px 0;
  text-align: center;
}
</style>

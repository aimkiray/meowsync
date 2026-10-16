<template>
  <!-- 首页发现流（白纸画布）：最近播放 chips + 最近歌单/专辑横向货架。
       货架全部由本地播放历史派生，零网络请求。页脚版本戳收版（print-grid 签名） -->
  <div ref="feedEl" class="home-feed">
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
            <span class="home-songrow-artist">{{ songArtists(song) }}</span>
          </span>
          <span
            v-if="songSourceTag(song)"
            class="pg-chip pg-chip--static home-src-tag"
          >{{ songSourceTag(song) }}</span>
        </button>
      </div>
    </section>

    <div v-if="!hasShelves && !recents.length" class="home-state" role="status">
      <p class="home-state-text">还没有播放记录，去顶部搜索试试喵~</p>
    </div>

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

    <!-- 页脚收版：版本戳 -->
    <footer class="home-foot">
      <PrintMarks variant="stamp" />
    </footer>
  </div>
</template>

<script>
import { ref, reactive, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { httpsCover } from '../lib/url'
import { readScrollMem, writeScrollMem, restoreScrollTop } from '../lib/scroll-mem'
import { songArtists, songCoverUrl, coverSizeUrl, songThumbUrl, songSourceTag } from '../lib/song'
import PrintMarks from './PrintMarks.vue'
import PixelIcon from './PixelIcon.vue'
import GlitchText from './GlitchText.vue'

// 最近播放网格展示上限：桌面 4 列×3 行=12；移动窄列行数随之浮动——
// 限的是展示数不是数据（play-song 队列种子仍传全量 recents）
const RECENT_DISPLAY_CAP = 12

export default {
  name: 'HomeFeed',
  components: { PrintMarks, PixelIcon, GlitchText },
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
  computed: {
    hasShelves() {
      return this.recentPlaylists.length > 0 || this.recentAlbums.length > 0
    },
    // 单曲卡网格只渲前 RECENT_DISPLAY_CAP 条（截尾部保原序）；
    // 不影响 @click emit 的队列种子——那边仍给 this.recents 全量
    visibleRecents() {
      return this.recents.slice(0, RECENT_DISPLAY_CAP)
    },
    /* 最近播放的专辑：按专辑键去重，保留最近次序，截 12 上货架。
       伪专辑准入两闸：① 专辑键非空——netease al.id 真值才计（'0'/0/空
       都是源站"无专辑"占位）；QQ 曲的 al.id 只在 netease 匹配成功时非
       null（buildQQSong），未匹配时退 provider 权威 qq.albummid——'qq:'
       域前缀防字符串 albummid 与数值 netease id 撞键；bv_/yt_ 的
       provider 块只存视频凭据无专辑 id（buildBilibiliSong/buildYouTubeSong
       可查），此退路仅 QQ 侧有。② 专辑名 ≠ 歌名（trim+lowercase 归一）——
       YouTube/B 站曲的 al.name 恒等歌名，网易云同名「单曲专辑」也一并
       滤掉（点击只放单曲，挂着「专辑」名不诚实——可接受代价）。
       去重键与准入键同一合成值——name 不作键也不兜底：无 id 又无
       albummid 的行不入架，同名不同 id 的专辑也不坍缩 */
    recentAlbums() {
      const norm = (s) => String(s ?? '').trim().toLowerCase()
      const seen = new Set()
      const list = []
      for (const song of this.recents) {
        const al = song?.al || song?.album
        // 合成专辑键：al.id（'0' 占位归一成 null 不计）优先，QQ 回退 albummid
        const rawId = al?.id
        const key = (rawId != null && String(rawId) !== '0' ? rawId : null)
          || (song?.qq?.albummid ? `qq:${song.qq.albummid}` : null)
        if (!key || seen.has(key)) continue
        if (norm(al?.name) === norm(song?.name)) continue
        seen.add(key)
        // songCoverUrl 收口：file_ 上传曲封面走 file 端点，provider 曲走 al.picUrl
        list.push({ key, name: al?.name ?? '', picUrl: songCoverUrl(song) || '', artist: songArtists(song), song })
      }
      return list.slice(0, 12)
    }
  },
  setup() {
    // 离场滚动记忆：换页即整卸——回首页还停在原货架位置（数据全本地，首帧即完整）
    const feedEl = ref(null)
    // 封面 @error 簿记：裂图位换回图标兜底（前缀键 s:/pl:/al: 防 id 撞名）
    const coverErrs = reactive(new Set())
    let cancelScrollRestore = null
    onMounted(() => nextTick(() => {
      const m = readScrollMem('home')
      if (m) cancelScrollRestore = restoreScrollTop(feedEl.value, m.top)
    }))
    onBeforeUnmount(() => {
      cancelScrollRestore?.() // 等待窗内卸载即停轮询
      writeScrollMem('home', { top: feedEl.value?.scrollTop ?? 0 })
    })
    return { httpsCover, songArtists, coverSizeUrl, songThumbUrl, songSourceTag, feedEl, coverErrs }
  }
}
</script>

<style scoped>
.home-feed {
  /* 滚动条车道顶部内缩：透明 border-top 把轨道抬离页缘 20px，
     与内容首行轴齐平；底部不缩——border 落在 scrollport 外会
     留出页底色死缝，底缘滚齐播放器发丝线。
     横向页缘走 --page-pad-x 全站档（≤640 收 12px） */
  padding: 0 var(--page-pad-x, 20px);
  border-top: 20px solid transparent;
  height: 100%;
  overflow-y: auto;
  scrollbar-gutter: stable;
  position: relative;
}

/* 页头：等宽微标签 + 大字标题。顶距 0——pg-label 落在全站 20 首行轴 */
.home-head {
  padding: 0 0 16px;
  position: relative;
}

.home-title {
  margin-top: 6px;
  font-family: var(--font-display);
  font-size: 28px;
  font-weight: 700;
  line-height: 1.15;
  color: var(--ink);
}

/* 区块：发丝线起头 + 微标签节题 */
.home-section {
  border-top: var(--hairline-soft);
  padding: 12px 0 18px;
}

.home-section-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 12px;
}

.home-section-sub {
  font-size: 12px;
  color: var(--ink-64);
}

/* 最近播放单曲卡网格：auto-fill 自适应列数，230px 地板收两行信息+来源徽标 */
.home-songs {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 8px;
}

/* 单曲行：<button> 天然 Enter/Space——点击区即整行（无嵌套可交互件，
   行尾来源徽标是 static chip 不吃点） */
.home-songrow {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 6px 8px;
  text-align: left;
  transition: background .12s;
}
/* 行 hover 走浅墨——song-result-row:hover 同档 */
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
.home-songrow-fb {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ink-64);
  background: var(--paper);
}

.home-songrow-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.home-songrow-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.home-songrow-artist {
  font-size: 11px;
  color: var(--ink-64);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 行尾来源徽标：song-tag 同型紧凑档（hairline 边 11px）。
   static chip 自带 cursor:default——悬在 button 行内时继承行的 pointer，
   否则徽标上空出现一小块「不可点」光标区误导 */
.home-src-tag {
  height: 20px;
  padding: 0 8px;
  font-size: 11px;
  flex-shrink: 0;
  cursor: inherit;
}

.home-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 64px 16px;
  border-top: var(--hairline-soft);
}

.home-state-text {
  font-size: 12px;
  color: var(--ink-64);
}

/* 横向货架：滚动条行（YTM carousel 语义）。顶/左右垫 4px、底垫 8px——
   glitch 圆角卡的 box-shadow 会被 scrollport 硬裁（首末卡左/右缘阴影
   缺角），垫白让阴影落在滚动盒内；底向多垫的 4px 吃卡影下展。
   grid-auto-columns 是轨道宽不受 padding 影响 */
.home-shelf {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 160px;
  gap: 16px;
  overflow-x: auto;
  padding: 4px 4px 8px;
}
/* ≥641 货架卡 160→180（YTM carousel ≤615=160/mid=180 阶梯） */
@media (min-width: 641px) { .home-shelf { grid-auto-columns: 180px; gap: 24px; } }

/* 卡片外壳已上收全局 style.css——这里只留「整卡可点」语义 */
.grid-card { cursor: pointer; }

/* 页脚收版（pg-stamp 自带 text-align:center，无需再排栅） */
.home-foot {
  border-top: var(--hairline-soft);
  margin-top: 8px;
  padding: 18px 0 12px;
}
</style>

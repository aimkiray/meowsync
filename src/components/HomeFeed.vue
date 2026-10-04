<template>
  <!-- 首页发现流（白纸画布）：最近播放 chips + 最近歌单/专辑横向货架。
       货架全部由本地播放历史派生，零网络请求。页脚版本戳收版（print-grid 签名） -->
  <div ref="feedEl" class="home-feed">
    <header class="home-head">
      <p class="pg-label">home · discover</p>
      <h2 class="home-title" data-nosnippet><GlitchText text="发现音乐" /></h2>
    </header>

    <!-- 最近播放 chips（点击直接续播并进 watch 页，队列=历史列表） -->
    <section v-if="recents.length" class="home-section">
      <div class="home-section-head">
        <p class="pg-label">recent</p>
        <span class="home-section-sub">最近播放</span>
      </div>
      <div class="home-chips">
        <button
          v-for="song in recents"
          :key="song.id"
          class="pg-chip"
          :title="`${song.name} - ${songArtists(song)}`"
          @click="$emit('play-song', song, recents)"
        ><span class="truncate min-w-0">{{ song.name }}</span></button>
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
              v-if="pl.coverImgUrl"
              :src="httpsCover(coverSizeUrl(pl.coverImgUrl, 320))"
              :alt="pl.name"
              loading="lazy"
              decoding="async"
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
              v-if="al.picUrl"
              :src="httpsCover(coverSizeUrl(al.picUrl, 320))"
              :alt="al.name"
              loading="lazy"
              decoding="async"
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
import { ref, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { httpsCover } from '../lib/url'
import { readScrollMem, writeScrollMem, restoreScrollTop } from '../lib/scroll-mem'
import { songArtists, songCoverUrl, coverSizeUrl } from '../lib/song'
import PrintMarks from './PrintMarks.vue'
import PixelIcon from './PixelIcon.vue'
import GlitchText from './GlitchText.vue'

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
    /* 最近播放的专辑：按专辑去重（无 id 退 name），保留最近次序，截 12 上货架 */
    recentAlbums() {
      const seen = new Set()
      const list = []
      for (const song of this.recents) {
        const al = song?.al || song?.album
        const key = al?.id ?? al?.name
        if (!key || seen.has(key)) continue
        seen.add(key)
        // songCoverUrl 收口：file_ 上传曲封面走 file 端点，provider 曲走 al.picUrl
        list.push({ key, name: al.name, picUrl: songCoverUrl(song) || '', artist: songArtists(song), song })
      }
      return list.slice(0, 12)
    }
  },
  setup() {
    // 离场滚动记忆：换页即整卸——回首页还停在原货架位置（数据全本地，首帧即完整）
    const feedEl = ref(null)
    let cancelScrollRestore = null
    onMounted(() => nextTick(() => {
      const m = readScrollMem('home')
      if (m) cancelScrollRestore = restoreScrollTop(feedEl.value, m.top)
    }))
    onBeforeUnmount(() => {
      cancelScrollRestore?.() // 等待窗内卸载即停轮询
      writeScrollMem('home', { top: feedEl.value?.scrollTop ?? 0 })
    })
    return { httpsCover, songArtists, coverSizeUrl, feedEl }
  }
}
</script>

<style scoped>
.home-feed {
  /* 滚动条车道上下内缩：透明 border 把轨道抬离页缘 20px，
     与内容首行轴齐平；padding-block 让位同量，内容几何不动。
     横向页缘走 --page-pad-x 全站档（≤640 收 12px） */
  padding: 0 var(--page-pad-x, 20px);
  border-block: 20px solid transparent;
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

/* 最近播放 chips（.pg-chip 全局类） */
.home-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
/* 歌名比热搜词长得多——截断兜底，别让单条 chip 撑满整行 */
.home-chips .pg-chip {
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

/* 横向货架：滚动条行（YTM carousel 语义） */
.home-shelf {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 160px;
  gap: 16px;
  overflow-x: auto;
  padding-bottom: 8px;
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

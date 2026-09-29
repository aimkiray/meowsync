<template>
  <!-- 首页发现流（白纸画布）：热搜 chips + 榜单/推荐歌单横向货架。
       顶部裁切标线、页脚套准符+版本戳收版（print-grid 签名） -->
  <div class="home-feed">
    <PrintMarks variant="hash" />

    <header class="home-head">
      <p class="pg-label">home · discover</p>
      <h2 class="home-title" data-nosnippet>发现音乐</h2>
    </header>

    <!-- 热搜 chips（点击直接搜） -->
    <section v-if="hots.length" class="home-section">
      <div class="home-section-head">
        <p class="pg-label">trending</p>
        <span class="home-section-sub">热搜</span>
      </div>
      <div class="home-chips">
        <button
          v-for="hot in hots"
          :key="hot.first"
          class="pg-chip"
          @click="$emit('search', hot.first)"
        >{{ hot.first }}</button>
      </div>
    </section>

    <div v-if="loading" class="home-state">
      <div class="pixel-loading" aria-hidden="true"></div>
      <p class="home-state-text">加载推荐中喵...</p>
    </div>

    <template v-else>
      <!-- 榜单货架 -->
      <section v-if="toplists.length" class="home-section">
        <div class="home-section-head">
          <p class="pg-label">charts</p>
          <span class="home-section-sub">榜单</span>
        </div>
        <div class="home-shelf">
          <div
            v-for="pl in toplists"
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
                :src="httpsCover(pl.coverImgUrl)"
                :alt="pl.name"
                loading="lazy"
              />
              <div v-else class="grid-card-cover-fallback"><PixelIcon name="note" :size="22" /></div>
            </div>
            <div class="grid-card-body">
              <h3 class="grid-card-name">{{ pl.name }}</h3>
              <p class="grid-card-meta">{{ pl.updateFrequency || '榜单' }}</p>
            </div>
          </div>
        </div>
      </section>

      <!-- 推荐歌单货架 -->
      <section v-if="personalized.length" class="home-section">
        <div class="home-section-head">
          <p class="pg-label">for you</p>
          <span class="home-section-sub">推荐歌单</span>
        </div>
        <div class="home-shelf">
          <div
            v-for="pl in personalized"
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
                v-if="pl.picUrl || pl.coverImgUrl"
                :src="httpsCover(pl.picUrl || pl.coverImgUrl)"
                :alt="pl.name"
                loading="lazy"
              />
              <div v-else class="grid-card-cover-fallback"><PixelIcon name="note" :size="22" /></div>
            </div>
            <div class="grid-card-body">
              <h3 class="grid-card-name">{{ pl.name }}</h3>
              <p class="grid-card-meta">{{ formatPlayCount(pl.playCount) }} 次播放</p>
            </div>
          </div>
        </div>
      </section>

      <div v-if="!toplists.length && !personalized.length" class="home-state">
        <p class="home-state-text">推荐加载失败，去顶部搜索试试喵~</p>
      </div>
    </template>

    <!-- 页脚收版：∵⩆ 套准符 + 版本戳 -->
    <footer class="home-foot">
      <PrintMarks variant="reg" />
      <div class="home-foot-grid">
        <PrintMarks variant="stamp" class="home-foot-stamp" />
      </div>
    </footer>
  </div>
</template>

<script>
import { httpsCover } from '../lib/url'
import PrintMarks from './PrintMarks.vue'
import PixelIcon from './PixelIcon.vue'

export default {
  name: 'HomeFeed',
  components: { PrintMarks, PixelIcon },
  props: {
    toplists: {
      type: Array,
      default: () => []
    },
    personalized: {
      type: Array,
      default: () => []
    },
    hots: {
      type: Array,
      default: () => []
    },
    loading: {
      type: Boolean,
      default: false
    }
  },
  emits: ['open', 'search'],
  setup() {
    const formatPlayCount = (n) => {
      if (!n || typeof n !== 'number') return ''
      return n >= 10000 ? `${(n / 10000).toFixed(1)}万` : String(n)
    }
    return { httpsCover, formatPlayCount }
  }
}
</script>

<style scoped>
.home-feed {
  padding: 20px;
  height: 100%;
  overflow-y: auto;
  scrollbar-gutter: stable;
  position: relative;
}

/* hash 裁切标线贴画布顶缘（typesafe 的页缘签名），不占文档流——
   否则它把页头标签推到 y≈42，与其它视图的 20 首行轴跳位 */
.home-feed > .pg-hash {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
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
  border-top: var(--hairline);
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

/* 热搜 chips（.pg-chip 全局类） */
.home-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.home-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 64px 16px;
  border-top: var(--hairline);
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
  scrollbar-gutter: stable;
}

/* 卡片外壳已上收全局 style.css——这里只留「整卡可点」语义 */
.grid-card { cursor: pointer; }

/* 页脚收版 */
.home-foot {
  border-top: var(--hairline);
  margin-top: 8px;
  padding: 18px 0 12px;
}

.home-foot-grid {
  margin-top: 16px;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: end;
  gap: 16px;
}

.home-foot-stamp {
  grid-column: 2;
}

@media (max-width: 640px) {
  .home-foot-grid {
    display: flex;
    flex-direction: column;
    align-items: center;
  }
}
</style>

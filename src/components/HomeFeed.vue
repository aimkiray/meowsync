<template>
  <!-- 首页发现流（白纸画布）：热搜 chips + 榜单/推荐歌单横向货架。
       顶部裁切标线、页脚套准符+版本戳收版（print-grid 签名） -->
  <div class="home-feed">
    <PrintMarks variant="hash" />

    <header class="home-head">
      <p class="pg-label">home · discover</p>
      <h2 class="home-title">发现音乐</h2>
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

    <!-- 页脚收版：∵⩆ 套准符 + 版本戳 + [b.64] 彩蛋块。
         窗口玩具落在收版区右上——不压任何可点内容（原在页头悬着会盖住末位热搜 chip） -->
    <footer class="home-foot">
      <PrintMarks variant="reg" />
      <div class="home-foot-grid">
        <PrintMarks variant="stamp" class="home-foot-stamp" />
        <PrintMarks variant="b64" class="home-b64" />
      </div>
      <ToyWindow
        class="home-toy"
        title="MEOWSYNC"
        :lines="['netease music player']"
        tag="<meow approved>"
        num="001"
        rotate="-3deg"
      />
    </footer>
  </div>
</template>

<script>
import { httpsCover } from '../lib/url'
import PrintMarks from './PrintMarks.vue'
import PixelIcon from './PixelIcon.vue'
import ToyWindow from './ToyWindow.vue'

export default {
  name: 'HomeFeed',
  components: { PrintMarks, PixelIcon, ToyWindow },
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

/* 页头：等宽微标签 + 大字标题 */
.home-head {
  padding: 12px 0 16px;
  position: relative;
}

/* 窗口玩具钉在收版区右缘——印刷稿角落掉落的小玩具（窄屏隐藏） */
.home-toy {
  position: absolute;
  bottom: 8px;
  right: 0;
}
@media (max-width: 860px) {
  .home-toy { display: none; }
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
  position: relative; /* home-toy 的定位参照 */
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

.home-b64 {
  grid-column: 3;
  justify-self: end;
  width: 220px;
}

@media (max-width: 640px) {
  .home-foot-grid {
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .home-b64 {
    width: min(220px, 100%);
  }
}
</style>

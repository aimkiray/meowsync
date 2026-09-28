<template>
  <!-- 首页发现流：YTM 式 热搜 chips + 横向歌单货架 -->
  <div class="home-feed">
    <h2 class="home-feed-title">发现音乐</h2>

    <!-- 热搜 chips（点击直接搜） -->
    <section v-if="hots.length" class="home-section">
      <div class="home-chips">
        <button
          v-for="hot in hots"
          :key="hot.first"
          class="home-chip"
          @click="$emit('search', hot.first)"
        >{{ hot.first }}</button>
      </div>
    </section>

    <div v-if="loading" class="text-center py-16">
      <div class="pixel-loading mx-auto mb-4"></div>
      <p class="text-pink-300 flex justify-center items-center">加载推荐中喵...</p>
    </div>

    <template v-else>
      <!-- 榜单货架 -->
      <section v-if="toplists.length" class="home-section">
        <h3 class="home-section-title">榜单</h3>
        <div class="home-shelf">
          <div
            v-for="pl in toplists"
            :key="pl.id"
            class="grid-card jirai-card home-card"
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
                style="image-rendering: pixelated;"
              />
              <div v-else class="grid-card-cover-fallback text-pink-300">♪</div>
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
        <h3 class="home-section-title">推荐歌单</h3>
        <div class="home-shelf">
          <div
            v-for="pl in personalized"
            :key="pl.id"
            class="grid-card jirai-card home-card"
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
                style="image-rendering: pixelated;"
              />
              <div v-else class="grid-card-cover-fallback text-pink-300">♪</div>
            </div>
            <div class="grid-card-body">
              <h3 class="grid-card-name">{{ pl.name }}</h3>
              <p class="grid-card-meta">{{ formatPlayCount(pl.playCount) }} 次播放</p>
            </div>
          </div>
        </div>
      </section>

      <div v-if="!toplists.length && !personalized.length" class="text-center py-16">
        <p class="text-gray-600">推荐加载失败，去顶部搜索试试喵~</p>
      </div>
    </template>
  </div>
</template>

<script>
import { httpsCover } from '../lib/url'

export default {
  name: 'HomeFeed',
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
  padding: 20px 24px;
  height: 100%;
  overflow-y: auto;
}

.home-feed-title {
  font-size: 17px;
  font-weight: bold;
  color: var(--pixel-text);
  margin-bottom: 14px;
}

.home-section {
  margin-bottom: 26px;
}

.home-section-title {
  font-size: 14px;
  font-weight: bold;
  color: var(--pixel-text);
  margin-bottom: 10px;
  padding-bottom: 6px;
  border-bottom: 2px solid rgba(240, 179, 192, 0.2);
}

/* 热搜 chips */
.home-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.home-chip {
  font-size: 12px;
  padding: 5px 12px;
  color: var(--pixel-text);
  background: rgba(236, 72, 153, 0.1);
  border: 2px solid var(--pixel-accent-fg, #f472b6);
  cursor: pointer;
  transition: background 0.12s;
}

.home-chip:hover {
  background: rgba(236, 72, 153, 0.25);
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

.home-card {
  cursor: pointer;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  transition: transform 0.15s;
}

.home-card:hover {
  transform: translateY(-2px);
}
</style>

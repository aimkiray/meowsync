<template>
  <!-- 搜索结果页（粉纸画布）：上"歌曲"发丝行、下"歌单"纸面卡片。
       点击卡片=打开试听（不入库），+ 收藏=收进侧栏歌单库 -->
  <div class="playlist-grid-wrap">
    <header class="grid-head">
      <div class="grid-head-text">
        <p class="pg-label">search results</p>
        <h2 class="grid-title" data-nosnippet>搜索结果</h2>
      </div>
      <button class="pg-icobtn" @click="$emit('close')" title="返回首页" aria-label="返回首页"><PixelIcon name="close" :size="14" /></button>
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
          v-for="(song, i) in songs"
          :key="song.id"
          class="song-result-row"
          :class="{ 'song-result-row--playing': String(currentSong?.id) === String(song.id) }"
          @click="$emit('play-song', song)"
          @keydown.enter="$emit('play-song', song)"
          @keydown.space.prevent="$emit('play-song', song)"
          tabindex="0"
          role="button"
          :title="`播放 ${song.name}`"
        >
          <span class="song-result-index">
            <span class="song-result-index-num">{{ i + 1 }}</span>
            <span class="song-result-index-play"><PixelIcon name="play" :size="11" /></span>
          </span>
          <img
            v-if="song.al?.picUrl || song.album?.picUrl"
            :src="httpsCover(song.al?.picUrl || song.album?.picUrl)"
            :alt="song.name"
            class="song-result-cover"
            loading="lazy"
          />
          <div v-else class="song-result-cover song-result-cover--fallback"><PixelIcon name="note" :size="16" /></div>
          <div class="song-result-info">
            <p class="song-result-name">{{ song.name }}</p>
            <p class="song-result-meta">{{ songArtist(song) }}<template v-if="songAlbum(song)"> · {{ songAlbum(song) }}</template></p>
          </div>
          <span class="song-result-duration">{{ formatSongDuration(song) }}</span>
        </div>
      </section>

      <section v-if="results.length" class="result-section">
        <div class="result-section-head">
          <p class="pg-label">playlists</p>
          <span class="result-section-sub">歌单</span>
        </div>
        <div class="playlist-grid">
          <div
            v-for="playlist in results"
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
                :src="httpsCover(playlist.coverImgUrl)"
                :alt="playlist.name"
                loading="lazy"
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
      </section>

      <div class="grid-foot">
        <span class="pg-label pg-label--dim">{{ songs.length }} songs · {{ results.length }} playlists</span>
      </div>
    </template>
  </div>
</template>

<script>
import { ref, watch, onBeforeUnmount } from 'vue'
import { shareOrCopy } from '../lib/share'
import { toast } from '../lib/feedback'
import { httpsCover } from '../lib/url'
import { formatTime } from '../lib/format'
import PixelIcon from './PixelIcon.vue'

export default {
  name: 'PlaylistGrid',
  components: { PixelIcon },
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
  emits: ['open', 'add', 'close', 'play-song'],
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
      const shareUrl = `${window.location.origin}/?playlist=${playlist.id}`
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

    return {
      httpsCover: httpsCoverUrl,
      adding,
      inLibrary,
      handleAdd,
      sharePlaylist,
      songArtist,
      songAlbum,
      formatSongDuration
    }
  }
}
</script>

<style scoped>
.playlist-grid-wrap {
  padding: 20px;
  height: 100%;
  overflow-y: auto;
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

/* 关闭键落在 --canvas-pink 上：accent-magenta hover 仅 ~1.4:1，用实墨保证反馈可见 */
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
  border-top: var(--hairline);
}

.grid-state-text {
  font-size: 12px;
  color: var(--ink-64);
}

/* 分区：发丝线起头 + 微标签节题 */
.result-section {
  border-top: var(--hairline);
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

/* 歌曲行：发丝下缘分隔，整行可点播放（YTM 行交互） */
.song-result-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 8px;
  cursor: pointer;
  border-bottom: var(--hairline-soft);
  transition: background 0.12s;
}

.song-result-row:hover {
  background: var(--ink-06);
}

.song-result-row--playing {
  background: var(--ink-10);
}

.song-result-index {
  width: 18px;
  flex-shrink: 0;
  text-align: center;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-64);
}

.song-result-index-play {
  display: none;
  color: var(--ink);
}

/* 序号 ↔ ▶ 互换（与 song-row 同构） */
.song-result-row:hover .song-result-index-num,
.song-result-row:focus-visible .song-result-index-num,
.song-result-row--playing .song-result-index-num {
  display: none;
}
.song-result-row:hover .song-result-index-play,
.song-result-row:focus-visible .song-result-index-play,
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

/* 卡片网格：自适应列数 */
.playlist-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
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
  min-height: 30px;
}
.grid-added { display: inline-flex; align-items: center; }

.grid-add {
  flex: 1;
}

.grid-added {
  flex: 1;
  justify-content: center;
}

.grid-share {
  flex-shrink: 0;
}

.grid-foot {
  border-top: var(--hairline);
  padding: 12px 0;
  text-align: center;
}
</style>

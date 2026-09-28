<template>
  <!-- 搜索结果：YTM 式歌单卡片网格。点击卡片=打开试听（不入库），+ 按钮=收藏到侧栏 -->
  <div class="playlist-grid-wrap">
    <div class="grid-header">
      <span class="grid-title">搜索结果</span>
      <button class="pixel-button grid-back" @click="$emit('close')" title="返回歌曲列表">✕ 返回</button>
    </div>

    <div v-if="loading" class="text-center py-16">
      <div class="pixel-loading mx-auto mb-4"></div>
      <p class="text-pink-300 flex justify-center items-center">搜索中喵...</p>
    </div>

    <div v-else-if="results.length === 0 && songs.length === 0" class="text-center py-16">
      <p class="text-gray-600">没有找到相关内容喵~</p>
    </div>

    <template v-else>
      <!-- YTM 分区结果：歌曲行在前（可直接播放），歌单卡片区在后 -->
      <section v-if="songs.length" class="result-section">
        <h3 class="result-section-title">歌曲</h3>
        <div
          v-for="song in songs"
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
            <span class="song-result-index-play">▶</span>
          </span>
          <img
            v-if="song.al?.picUrl || song.album?.picUrl"
            :src="httpsCover(song.al?.picUrl || song.album?.picUrl)"
            :alt="song.name"
            class="song-result-cover"
            loading="lazy"
            style="image-rendering: pixelated;"
          />
          <div v-else class="song-result-cover song-result-cover--fallback">♪</div>
          <div class="song-result-info">
            <p class="song-result-name">{{ song.name }}</p>
            <p class="song-result-meta">{{ songArtist(song) }}<template v-if="songAlbum(song)"> · {{ songAlbum(song) }}</template></p>
          </div>
          <span class="song-result-duration">{{ formatSongDuration(song) }}</span>
        </div>
      </section>

      <section v-if="results.length" class="result-section">
        <h3 class="result-section-title">歌单</h3>
        <div class="playlist-grid">
      <div
        v-for="playlist in results"
        :key="playlist.id"
        class="grid-card jirai-card"
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
            style="image-rendering: pixelated;"
          />
          <div v-else class="grid-card-cover-fallback text-pink-300">♪</div>
        </div>
        <div class="grid-card-body">
          <h3 class="grid-card-name">{{ playlist.name }}</h3>
          <p class="grid-card-meta">{{ playlist.creator?.nickname || '神秘创建者' }} · {{ playlist.trackCount }} 首</p>
        </div>
        <div class="grid-card-actions">
          <button
            class="grid-action"
            :class="inLibrary(playlist) ? 'grid-action--done' : ''"
            :disabled="inLibrary(playlist) || adding.has(playlist.id)"
            @click.stop="handleAdd(playlist)"
            :title="inLibrary(playlist) ? '已在歌单库中' : '收藏到我的歌单'"
          >{{ inLibrary(playlist) ? '✓ 已收藏' : (adding.has(playlist.id) ? '…' : '+ 收藏') }}</button>
          <button
            class="grid-action grid-action--icon"
            @click.stop="sharePlaylist(playlist)"
            title="分享歌单"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 22 22"><path fill="currentColor" d="M9 15H8v-1H7v-1h1v-1h1v-1h1v-1h1V9H8V7h7v7h-2v-3h-1v1h-1v1h-1v1H9m9 6H4v-1H3v-1H2V4h1V3h1V2h14v1h1v1h1v14h-1v1h-1m-1-1v-1h1V5h-1V4H5v1H4v12h1v1Z"/></svg>
          </button>
        </div>
      </div>
        </div>
      </section>
    </template>
  </div>
</template>

<script>
import { ref, watch, onBeforeUnmount } from 'vue'
import { shareOrCopy } from '../lib/share'
import { toast } from '../lib/feedback'
import { httpsCover } from '../lib/url'
import { formatTime } from '../lib/format'

export default {
  name: 'PlaylistGrid',
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
  padding: 20px 24px;
  height: 100%;
  overflow-y: auto;
}

.grid-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 18px;
}

.grid-title {
  font-size: 15px;
  font-weight: bold;
  /* 主题变量：pixel-retro 浅色底下硬编码粉 (#f9a8d4) 对比度不足 */
  color: var(--pixel-text);
}

.grid-back {
  font-size: 12px;
  padding: 4px 10px;
}

/* 卡片网格：YTM 式封面大卡，自适应列数 */
.playlist-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 16px;
}

.grid-card {
  cursor: pointer;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  transition: transform 0.15s, box-shadow 0.15s;
}

.grid-card:hover {
  transform: translateY(-2px);
}

/* grid-card-cover/name/meta 等卡片内部件样式已提为全局（与 HomeFeed 货架共用，
   scoped 选择器带 data-v 只对自家模板生效） */
.grid-card-actions {
  display: flex;
  gap: 6px;
  margin-top: auto;
}

.grid-action {
  flex: 1;
  font-size: 11px;
  padding: 4px 6px;
  background: #701a75;
  color: #fce7f3;
  border: 1px solid #f472b6;
  cursor: pointer;
  transition: background 0.15s;
}

.grid-action:hover:not(:disabled) {
  background: #a21caf;
}

.grid-action:disabled {
  cursor: default;
  opacity: 0.7;
}

.grid-action--done {
  background: #3b0764;
  color: #c084fc;
}

.grid-action--icon {
  flex: 0 0 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #9ca3af;
}

/* ── 分区结果（YTM：歌曲区 + 歌单区） ── */
.result-section {
  margin-bottom: 24px;
}

.result-section-title {
  font-size: 14px;
  font-weight: bold;
  color: var(--pixel-text);
  margin-bottom: 10px;
  padding-bottom: 6px;
  border-bottom: 2px solid rgba(240, 179, 192, 0.2);
}

/* 歌曲行：悬停显 ▶、可整行点击播放 */
.song-result-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  cursor: pointer;
  transition: background 0.12s;
}

.song-result-row:hover {
  background: rgba(236, 72, 153, 0.08);
}

.song-result-row--playing {
  background: rgba(236, 72, 153, 0.14);
}

.song-result-index {
  width: 20px;
  flex-shrink: 0;
  text-align: center;
  font-size: 12px;
}

.song-result-index-play {
  display: none;
  color: var(--pixel-accent-fg, #f472b6);
}

.song-result-row:hover .song-result-index-play {
  display: inline;
}

.song-result-cover {
  width: 40px;
  height: 40px;
  object-fit: cover;
  border: 2px solid #f472b6;
  flex-shrink: 0;
}

.song-result-cover--fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--pixel-text-dim);
}

.song-result-info {
  flex: 1;
  min-width: 0;
}

.song-result-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--pixel-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.song-result-meta {
  font-size: 11px;
  color: var(--pixel-text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.song-result-duration {
  font-size: 11px;
  color: var(--pixel-text-dim);
  flex-shrink: 0;
}
</style>

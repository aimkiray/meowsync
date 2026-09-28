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

    <div v-else-if="results.length === 0" class="text-center py-16">
      <p class="text-gray-600">没有找到相关歌单喵~</p>
    </div>

    <div v-else class="playlist-grid">
      <div
        v-for="playlist in results"
        :key="playlist.id"
        class="grid-card jirai-card"
        @click="$emit('open', playlist)"
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
  </div>
</template>

<script>
import { ref, watch, onBeforeUnmount } from 'vue'
import { shareOrCopy } from '../lib/share'
import { httpsCover } from '../lib/url'

export default {
  name: 'PlaylistGrid',
  props: {
    results: {
      type: Array,
      default: () => []
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
  emits: ['open', 'add', 'close'],
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
      if (result === 'copied') alert('分享链接已复制到剪贴板！')
      else if (result === 'failed') alert('分享失败，请手动复制链接')
    }

    return {
      httpsCover: httpsCoverUrl,
      adding,
      inLibrary,
      handleAdd,
      sharePlaylist
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

.grid-card-cover {
  width: 100%;
  aspect-ratio: 1;
  overflow: hidden;
  border: 2px solid #f472b6;
}

.grid-card-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.grid-card-cover-fallback {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 36px;
}

.grid-card-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--pixel-text);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  line-height: 1.35;
  min-height: 2.7em;
}

.grid-card-meta {
  font-size: 11px;
  color: var(--pixel-text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

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
</style>

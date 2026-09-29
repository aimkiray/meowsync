<template>
  <!-- 歌单库侧栏："library" 媒体库列表，发丝线行排 -->
  <div class="playlist-panel flex flex-col h-full min-h-0">
    <p class="pg-label panel-label">library 我的歌单</p>

    <div v-if="loading" class="panel-state">
      <div class="pixel-loading" aria-hidden="true"></div>
      <p class="panel-state-text">加载中喵...</p>
    </div>

    <div v-else-if="userPlaylists.length === 0" class="panel-state">
      <p class="panel-state-text">还没有添加歌单喵~</p>
      <p class="panel-state-sub">用顶部搜索框找歌单吧！</p>
    </div>

    <div v-else class="playlist-scroll flex-1 min-h-0 overflow-y-auto">
      <div
        v-for="playlist in userPlaylists"
        :key="playlist.id"
        class="pl-row"
        :class="{ 'pl-row--active': String(selectedPlaylist?.id) === String(playlist.id) }"
        :aria-current="String(selectedPlaylist?.id) === String(playlist.id) ? 'true' : undefined"
      >
        <div
          @click="$emit('select-playlist', playlist)"
          @keydown.enter="$emit('select-playlist', playlist)"
          @keydown.space.prevent="$emit('select-playlist', playlist)"
          class="pl-row-main"
          tabindex="0"
          role="button"
          :aria-label="`打开歌单 ${playlist.name}`"
        >
          <div class="pl-cover-wrap">
            <img
              v-if="playlist.coverImgUrl"
              :src="httpsCover(playlist.coverImgUrl)"
              :alt="playlist.name"
              class="pl-cover"
            />
            <div v-else class="pl-cover pl-cover--fallback"><PixelIcon name="note" :size="16" /></div>
            <!-- 悬停 ▶ 直接播放整个歌单 -->
            <button
              class="playlist-play-overlay"
              title="播放歌单"
              aria-label="播放歌单"
              @click.stop="$emit('play-playlist', playlist)"
            ><PixelIcon name="play" :size="14" /></button>
          </div>
          <div class="pl-info">
            <h3 class="pl-name">{{ playlist.name }}</h3>
            <p class="pl-meta">{{ playlist.creator?.nickname || '神秘创建者' }}</p>
          </div>
          <div class="pl-count">{{ playlist.trackCount }}</div>
        </div>
        <!-- 菜单与分享按钮 -->
        <div class="pl-actions">
          <!-- 临时歌单的 id 非数字，接收端 getPlaylistIdsFromUrl 只认 \d+ → 分享链接必死，隐藏 -->
          <button
            v-if="!isTempPlaylist(playlist)"
            @click.stop="sharePlaylist(playlist)"
            class="pl-action pg-icobtn pg-icobtn--bare pg-icobtn--sm"
            title="分享歌单"
            aria-label="分享歌单"
          >
            <PixelIcon name="share" :size="15" />
          </button>

          <!-- 更多菜单按钮 -->
          <button
            @click.stop="toggleMenu(playlist.id, $event)"
            class="pl-action pg-icobtn pg-icobtn--bare pg-icobtn--sm"
            title="更多操作"
            aria-label="更多操作"
            aria-haspopup="menu"
            :aria-expanded="openMenuId === playlist.id"
          >
            <PixelIcon name="kebab" :size="15" />
          </button>
        </div>

        <!-- 下拉菜单 - 使用 Teleport 确保显示在外部 -->
        <Teleport to="body">
          <div
            v-if="openMenuId === playlist.id"
            class="pg-menu playlist-menu"
            role="menu"
            :style="getMenuPosition(playlist.id)"
          >
            <button
              v-if="!isTempPlaylist(playlist)"
              @click.stop="downloadPlaylist(playlist)"
              class="pg-menu-item"
              role="menuitem"
            >
              下载歌单
            </button>
            <button
              v-if="!isTempPlaylist(playlist)"
              @click.stop="openInNetease(playlist)"
              class="pg-menu-item"
              role="menuitem"
            >
              打开网易云
            </button>
            <button
              v-if="!isTempPlaylist(playlist)"
              @click.stop="copyShareLink(playlist)"
              class="pg-menu-item"
              role="menuitem"
            >
              复制分享链接
            </button>
            <button
              v-if="!isTempPlaylist(playlist)"
              @click.stop="deletePlaylistDownloads(playlist)"
              class="pg-menu-item"
              role="menuitem"
            >
              删除已下载歌曲
            </button>
            <button
              @click.stop="removePlaylist(playlist.id)"
              class="pg-menu-item pg-menu-item--danger"
              role="menuitem"
            >
              删除歌单
            </button>
          </div>
        </Teleport>
      </div>

      <div class="pl-foot">
        <span class="pg-label pg-label--dim">{{ userPlaylists.length }} playlists</span>
      </div>
    </div>
  </div>
</template>

<script>
import { ref, onMounted, onUnmounted } from 'vue'
import { downloadsApi } from '../api/downloads'
import { copyText, shareOrCopy } from '../lib/share'
import { httpsCover as sharedHttpsCover } from '../lib/url'
import { isLocalPlaylistId } from '../lib/song'
import { toast, pixelConfirm } from '../lib/feedback'
import PixelIcon from './PixelIcon.vue'

export default {
  name: 'PlaylistPanel',
  components: { PixelIcon },
  props: {
    userPlaylists: {
      type: Array,
      default: () => []
    },
    selectedPlaylist: {
      type: Object,
      default: null
    },
    loading: {
      type: Boolean,
      default: false
    }
  },
  emits: ['select-playlist', 'play-playlist', 'remove-playlist', 'playlist-downloads-deleted'],
  setup(props, { emit }) {
    const openMenuId = ref(null)
    const menuPositions = ref({})

    // HTTPS 部署下 http: 封面会被浏览器混拦——网易图床均支持 TLS，显式升级
    // （共享 helper 见 lib/url.js，歌曲封面/歌单封面/任务封面同一来源）
    const httpsCover = sharedHttpsCover

    const closeOnEscape = (e) => { if (e.key === 'Escape') closeMenu() }

    onMounted(() => {
      document.addEventListener('click', handleClickOutside)
      // 菜单是 fixed 定位，面板滚动后位置脱节——滚动时直接关闭
      window.addEventListener('scroll', closeMenu, true)
      window.addEventListener('keydown', closeOnEscape)
    })

    onUnmounted(() => {
      document.removeEventListener('click', handleClickOutside)
      window.removeEventListener('scroll', closeMenu, true)
      window.removeEventListener('keydown', closeOnEscape)
    })

    // 菜单相关方法
    const toggleMenu = (playlistId, event) => {
      if (openMenuId.value === playlistId) {
        closeMenu()
      } else {
        // 切到另一个歌单：旧菜单位置缓存即弃，否则 map 只增不减
        if (openMenuId.value != null) delete menuPositions.value[openMenuId.value]
        // 计算菜单位置（event.target 可能是内部 svg/path，须定位到按钮本身）；
        // 下方空间不足翻到上方、左侧越界收回视口内——面板可滚动而菜单 fixed，
        // 开出视口后 scroll-close 又挡住滚动，菜单就永远不可达
        const button = event.target.closest('button') || event.target
        const rect = button.getBoundingClientRect()
        const menuWidth = 160
        // 菜单高度按可见项数算：临时歌单隐藏 4 项只剩"删除歌单"，
        // 按全量 5 项翻转会把菜单顶到按钮上方 150px 悬空。
        // find miss（点击瞬间列表刷新）兜底按 1 项算——比按 5 项悬空更安全
        const currentPlaylist = props.userPlaylists.find(p => p.id === playlistId)
        const itemCount = !currentPlaylist || isTempPlaylist(currentPlaylist) ? 1 : 5
        const menuHeight = itemCount * 39 + 4 // 实测项高 ≈39（含发丝分隔）
        const vw = window.innerWidth
        const vh = window.innerHeight
        const belowFits = rect.bottom + 4 + menuHeight <= vh
        menuPositions.value[playlistId] = {
          top: (belowFits ? rect.bottom + 4 : Math.max(8, rect.top - menuHeight - 4)) + 'px',
          left: Math.max(8, Math.min(rect.right - menuWidth, vw - menuWidth - 8)) + 'px'
        }
        openMenuId.value = playlistId
      }
    }

    const getMenuPosition = (playlistId) => {
      return menuPositions.value[playlistId] || { top: '0px', left: '0px' }
    }

    const closeMenu = () => {
      if (openMenuId.value != null) delete menuPositions.value[openMenuId.value]
      openMenuId.value = null
    }

    const openInNetease = (playlist) => {
      const url = `https://music.163.com/#/playlist?id=${playlist.id}`
      window.open(url, '_blank', 'noopener')
      closeMenu()
    }

    // 分享链带 view=songs&pl=ID：冷启动后主区直接落在该歌单歌曲页，不停在首页
    const copyShareLink = async (playlist) => {
      const url = `${window.location.origin}/?playlist=${playlist.id}&view=songs&pl=${playlist.id}`
      const ok = await copyText(url)
      // 与歌曲分享同款的反馈闭环：成功也要给戳记，否则用户不知道复制生效
      toast(ok ? '分享链接已复制到剪贴板' : '复制失败，请手动复制链接', ok ? 'success' : 'error')
      closeMenu()
    }

    // 分享歌单（与歌曲分享一致的逻辑：Web Share API + 复制降级）
    const sharePlaylist = async (playlist) => {
      const shareUrl = `${window.location.origin}/?playlist=${playlist.id}&view=songs&pl=${playlist.id}`
      const result = await shareOrCopy({
        title: `🎵 歌单：${playlist.name}`,
        text: `来看看这个歌单：${playlist.name}`,
        url: shareUrl
      })
      if (result === 'copied') toast('分享链接已复制到剪贴板', 'success')
      else if (result === 'failed') toast('分享失败，请手动复制链接', 'error')
    }

    const removePlaylist = async (playlistId) => {
      // 与其他删除项保持一致的确认（本地库移除，误删可重加但易误触）
      if (!await pixelConfirm('确定要从库中移除该歌单吗？', { confirmText: '移除', danger: true })) {
        closeMenu()
        return
      }
      emit('remove-playlist', playlistId)
      closeMenu()
    }

    // 本地内存态歌单（单曲分享/队列存盘）服务端无对应持久行——不提供分享/下载入口
    const isTempPlaylist = (playlist) => isLocalPlaylistId(playlist?.id)

    // 下载歌单
    const downloadPlaylist = async (playlist) => {
      try {
        await downloadsApi.quickDownloadPlaylist(playlist.id, {
          bitrate: 320000,
          downloadAudio: true,
          downloadLyrics: true,
          downloadCover: true,
          concurrentLimit: 3
        })

        toast('下载队列已创建，正在后台下载', 'success')
      } catch (error) {
        console.error('创建下载队列失败:', error)
        const message = error.response?.data?.message || error.message
        toast('下载失败: ' + message, 'error')
      } finally {
        closeMenu() // 失败也要关菜单——否则菜单挂着看似还能点
      }
    }

    const deletePlaylistDownloads = async (playlist) => {
      // confirm 取消分支与 removePlaylist 行为一致：也关菜单
      if (!await pixelConfirm(`确定要删除歌单 "${playlist.name}" 的已下载歌曲吗？`, { confirmText: '删除', danger: true })) {
        closeMenu()
        return
      }

      try {
        const response = await downloadsApi.deletePlaylistDownloads(playlist.id)
        // 畸形响应（反代返回 HTML 200 等）不该吞成"0 首"假提示
        const deletedSongs = response.data?.data?.deletedSongs
        if (typeof deletedSongs !== 'number') {
          throw new Error('接口返回异常')
        }
        toast(deletedSongs > 0 ? `已删除 ${deletedSongs} 首已下载歌曲` : '这个歌单没有可删除的已下载歌曲', deletedSongs > 0 ? 'success' : 'info')
        // 0 首时不必触发父组件刷新——只会多发一轮无效任务轮询
        if (deletedSongs > 0) emit('playlist-downloads-deleted', playlist.id)
      } catch (error) {
        console.error('批量删除已下载歌曲失败:', error)
        const message = error.response?.data?.message || error.message
        toast('删除失败: ' + message, 'error')
      } finally {
        closeMenu()
      }
    }

    // 点击外部关闭菜单
     const handleClickOutside = (event) => {
       if (!event.target.closest('.playlist-menu')) {
         closeMenu()
       }
     }

    return {
       openMenuId,
       toggleMenu,
       closeMenu,
       openInNetease,
       copyShareLink,
       removePlaylist,
       sharePlaylist,
       downloadPlaylist,
       deletePlaylistDownloads,
       isTempPlaylist,
       getMenuPosition,
       httpsCover
     }
  }
}
</script>

<style scoped>
.playlist-panel {
  padding: 20px 0 0; /* 与主区首行同轴：全站 masthead→内容 = 20 */
}

.panel-label {
  padding: 8px 12px 10px; /* 与栏内 12px 内容轴同缘（封面左缘） */
  flex-shrink: 0;
}

.panel-state {
  border-top: var(--hairline); /* 与列表态 .playlist-scroll 同位不断线 */
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 32px 16px;
}

.panel-state-text {
  font-size: 12px;
  color: var(--ink-86);
}

.panel-state-sub {
  font-size: 11px;
  color: var(--ink-64);
}

.playlist-scroll {
  border-top: var(--hairline);
}

/* 歌单行：发丝下缘分隔，整行可点 */
.pl-row {
  position: relative;
  border-bottom: var(--hairline-soft);
}

.pl-row-main {
  display: flex;
  align-items: center;
  gap: 10px;
  /* 右侧 56px 留给常显的 .pl-actions（分享+⋯）——否则与 .pl-count 交叠 */
  padding: 9px 56px 9px 12px;
  cursor: pointer;
  transition: background .12s;
}

.pl-row-main:hover { background: var(--ink-06); }

.pl-row--active .pl-row-main {
  background: var(--ink);
}
.pl-row--active .pl-name,
.pl-row--active .pl-meta,
.pl-row--active .pl-count { color: var(--paper); }
.pl-row--active .pl-meta,
.pl-row--active .pl-count { color: var(--label-grey); }

.pl-cover-wrap {
  position: relative;
  width: 44px;
  height: 44px;
  flex-shrink: 0;
}

.pl-cover {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border: var(--hairline);
  image-rendering: pixelated;
  display: block;
}

.pl-cover--fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ink-64);
  background: var(--paper);
}

.pl-row--active .pl-cover { border-color: var(--paper); }

.pl-info {
  flex: 1;
  min-width: 0;
}

.pl-name {
  font-size: 12px;
  font-weight: 500;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pl-meta {
  font-size: 11px;
  color: var(--ink-64);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 2px;
}

.pl-count {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--ink-64);
  flex-shrink: 0;
}

/* 行尾操作组（分享 + ⋯）：垂直居中，与 dql 行尾键同法则 */
.pl-actions {
  position: absolute;
  top: 50%;
  right: 6px;
  transform: translateY(-50%);
  display: flex;
  gap: 2px;
}

.pl-action {
  transition: color .2s; /* 尺寸交给 pg-icobtn--sm（24px 行内尾键档）；hover 走全局行尾键统一律 */
}
.pl-row--active .pl-action { color: var(--label-grey); }

/* 侧栏歌单行悬停 ▶ 播放键（浮于封面上） */
.playlist-play-overlay {
  position: absolute;
  inset: 1.2px; /* 不压 .pl-cover 的墨框 */
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  color: var(--paper);
  background: var(--scrim-strong);
  opacity: 0;
  pointer-events: none; /* 隐形时不吃点击——封面点击应放行到行（song-menu-btn 同纪律） */
  border: none;
  cursor: pointer;
  transition: opacity .12s;
}

.pl-row:hover .playlist-play-overlay,
.pl-row:focus-within .playlist-play-overlay,
.playlist-play-overlay:focus-visible {
  opacity: 1;
  pointer-events: auto;
}

/* 触屏无 hover——隐形可点的播放键会误触，常显（半透明遮罩版） */
@media (hover: none) {
  .playlist-play-overlay {
    opacity: .85;
    pointer-events: auto;
  }
}

.pl-foot {
  text-align: center;
  padding: 12px 0;
}
</style>

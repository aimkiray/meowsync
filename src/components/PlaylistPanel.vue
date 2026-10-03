<template>
  <!-- 歌单库侧栏："library" 媒体库列表，发丝线行排 -->
  <div class="playlist-panel flex flex-col h-full min-h-0">
    <div class="panel-head">
      <p class="pg-label panel-label"><GlitchText text="library 我的歌单" /></p>
      <button
        class="pg-icobtn pg-icobtn--bare panel-create-btn"
        title="新建歌单"
        aria-label="新建歌单"
        aria-haspopup="dialog"
        @click="$emit('open-create-playlist')"
      ><PixelIcon name="plus" :size="15" /></button>
    </div>

    <div v-if="loading" class="panel-state">
      <div class="pixel-loading" aria-hidden="true"></div>
      <p class="panel-state-text">加载中喵...</p>
    </div>

    <div v-else-if="userPlaylists.length === 0" class="panel-state">
      <p class="panel-state-text">还没有添加歌单喵~</p>
      <p class="panel-state-sub">点上方 + 新建一个，或用顶部搜索框找歌单吧！</p>
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
              @click.stop="$emit('play-playlist', playlist); closeMenu()"
            ><PixelIcon name="play" :size="22" /></button>
          </div>
          <div class="pl-info">
            <h3 class="pl-name">{{ playlist.name }}</h3>
            <p class="pl-meta">{{ playlist.creator?.nickname || '神秘创建者' }} · {{ playlist.trackCount ?? 0 }} 首</p>
          </div>
        </div>
        <!-- 菜单与分享按钮 -->
        <div class="pl-actions">
          <!-- single_song_ 壳是单曲分享容器非歌单，藏分享/下载；local_pl_ 走 ?mix= 内容链 -->
          <button
            v-if="!isShareShell(playlist)"
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
              v-if="!isShareShell(playlist)"
              @click.stop="downloadPlaylist(playlist)"
              class="pg-menu-item"
              role="menuitem"
            >
              下载歌单
            </button>
            <button
              v-if="!isShareShell(playlist)"
              @click.stop="viewDownloadProgress(playlist)"
              class="pg-menu-item"
              role="menuitem"
            >
              下载进度
            </button>
            <button
              v-if="isNeteasePlaylist(playlist)"
              @click.stop="openInNetease(playlist)"
              class="pg-menu-item"
              role="menuitem"
            >
              打开网易云
            </button>
            <button
              v-if="!isShareShell(playlist)"
              @click.stop="copyShareLink(playlist)"
              class="pg-menu-item"
              role="menuitem"
            >
              复制分享链接
            </button>
            <button
              v-if="!isShareShell(playlist)"
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
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { downloadsApi } from '../api/downloads'
import { apiErrorMessage } from '../api/http'
import { copyText, shareOrCopy, playlistShareUrl, mixShareIds, isEmptyMixShareUrl } from '../lib/share'
import { httpsCover as sharedHttpsCover } from '../lib/url'
import { isLocalPlaylistId, isSingleSongShellId } from '../lib/song'
import { isNeteasePlaylist } from '../shared/predicates.js'
import { toast, pixelConfirm } from '../lib/feedback'
import PixelIcon from './PixelIcon.vue'
import GlitchText from './GlitchText.vue'

export default {
  name: 'PlaylistPanel',
  components: { PixelIcon, GlitchText },
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
  emits: ['select-playlist', 'play-playlist', 'remove-playlist', 'playlist-downloads-deleted', 'open-create-playlist', 'view-download-progress'],
  setup(props, { emit }) {
    const openMenuId = ref(null)
    const menuPositions = ref({})
    // 最近开菜单的 ⋯键本体——Esc 解散菜单时焦点归还它，不落 body
    let menuTriggerEl = null

    // HTTPS 部署下 http: 封面会被浏览器混拦——网易图床均支持 TLS，显式升级
    // （共享 helper 见 lib/url.js，歌曲封面/歌单封面/任务封面同一来源）
    const httpsCover = sharedHttpsCover

    const closeOnEscape = (e) => { if (e.key === 'Escape') closeMenu(null, true) }
    // 滚动监听必须包箭头：直传 closeMenu 会把 Event 对象塞进 playlistId 形参，
    // 定点判定 String(event) 与任何歌单 id 不等 → 滚动关菜单静默失效
    const closeOnScroll = () => closeMenu()

    // 列表重排（同步回写/增删）会让 fixed 菜单悬空指错行——
    // 成员或次序真的变了才关（与 DownloadQueueList 同口径）
    watch(() => props.userPlaylists.map(p => p.id).join(','), () => closeMenu())

    onMounted(() => {
      document.addEventListener('pointerdown', handleClickOutside)
      // 菜单是 fixed 定位，面板滚动后位置脱节——滚动时直接关闭
      window.addEventListener('scroll', closeOnScroll, true)
      window.addEventListener('keydown', closeOnEscape)
    })

    onUnmounted(() => {
      document.removeEventListener('pointerdown', handleClickOutside)
      window.removeEventListener('scroll', closeOnScroll, true)
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
        menuTriggerEl = button
        const rect = button.getBoundingClientRect()
        const menuWidth = 160 // 本菜单全是短项，实际宽恒等于 pg-menu 的 min-width
        // 菜单高度按可见项数算：临时歌单隐藏 5 项只剩"删除歌单"，
        // 按全量 6 项翻转会把菜单顶到按钮上方悬空。
        // find miss（点击瞬间列表刷新）兜底按 1 项算——比按 6 项悬空更安全
        const currentPlaylist = props.userPlaylists.find(p => p.id === playlistId)
        const itemCount = !currentPlaylist ? 1
          : isShareShell(currentPlaylist) ? 1
          : isNeteasePlaylist(currentPlaylist) ? 6 : 5
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

    const closeMenu = (playlistId = null, restoreFocus = false) => {
      // 带 id 定点关：长 await（下载/删除）后的 finally 落地时用户可能已点开
      // 另一歌单的菜单——无条件全清会把新菜单误杀
      if (playlistId != null && String(openMenuId.value) !== String(playlistId)) return
      const wasOpen = openMenuId.value != null
      if (wasOpen) delete menuPositions.value[openMenuId.value]
      openMenuId.value = null
      // Esc 解散时焦点归还 ⋯触发键——菜单散了焦点不落 body（菜单项激活路径
      // 不传 restoreFocus，下一跳自己管焦点）
      if (restoreFocus && wasOpen && menuTriggerEl?.isConnected) {
        menuTriggerEl.focus({ preventScroll: true })
      }
    }

    const openInNetease = (playlist) => {
      const url = `https://music.163.com/#/playlist?id=${playlist.id}`
      window.open(url, '_blank', 'noopener')
      closeMenu()
    }

    // 分享链带 view=songs&pl=ID：冷启动后主区直接落在该歌单歌曲页，不停在首页。
    // URL 构造（远端单 ?playlist= / 导入壳按引用 / 本地单 ?mix= 内容链）
    // 与字节预算截断都收敛在 lib/share.js——参数名与接收端 readShareParams 对表
    const overBudget = (playlist) => isLocalPlaylistId(playlist.id)
      && mixShareIds(playlist).length < (playlist.tracks?.length || 0)

    const copyShareLink = async (playlist) => {
      const url = playlistShareUrl(playlist)
      if (isEmptyMixShareUrl(url)) {
        toast('歌单里没有可分享的歌曲', 'info'); closeMenu(playlist.id); return
      }
      const ok = await copyText(url)
      // 与歌曲分享同款的反馈闭环：成功也要给戳记，否则用户不知道复制生效
      toast(ok
        ? `分享链接已复制到剪贴板${overBudget(playlist) ? '（部分曲目因链接过长未包含）' : ''}`
        : '复制失败，请手动复制链接', ok ? 'success' : 'error')
      closeMenu(playlist.id)
    }

    // 分享歌单（与歌曲分享一致的逻辑：Web Share API + 复制降级）
    const sharePlaylist = async (playlist) => {
      // .stop 阻断了 document click 外关——本行按钮点按也要关已开着的别行菜单
      closeMenu()
      const shareUrl = playlistShareUrl(playlist)
      if (isEmptyMixShareUrl(shareUrl)) {
        toast('歌单里没有可分享的歌曲', 'info')
        return
      }
      const result = await shareOrCopy({
        title: `🎵 歌单：${playlist.name}`,
        text: `来看看这个歌单：${playlist.name}`,
        url: shareUrl
      })
      if (result === 'copied') toast(`分享链接已复制到剪贴板${overBudget(playlist) ? '（部分曲目因链接过长未包含）' : ''}`, 'success')
      else if (result === 'failed') toast('分享失败，请手动复制链接', 'error')
    }

    const removePlaylist = async (playlistId) => {
      // 语义分岔要说清：本地单移除连带清服务端镜像与已下载文件；远端单只从
      // 列表移除，服务器上的已下载资源保留（要清走下载管理页删歌单）
      const pl = props.userPlaylists.find(p => String(p.id) === String(playlistId))
      const confirmText = isLocalPlaylistId(pl?.id)
        ? '确定要删除该歌单吗？其已下载资源将一并清理'
        : isSingleSongShellId(pl?.id)
          ? '确定要从库中移除该歌单吗？'
          : '确定要从库中移除该歌单吗？已下载文件保留在服务器（可在下载管理中清理）'
      if (!await pixelConfirm(confirmText, { confirmText: '移除', danger: true })) {
        closeMenu(playlistId)
        return
      }
      emit('remove-playlist', playlistId)
      closeMenu(playlistId)
    }

    // 本地内存态歌单（单曲分享/队列存盘）服务端无对应持久行——不提供分享/下载入口
    // 歌单级入口门槛：single_song_ 壳不显示分享/下载（单曲级分享已覆盖）；
    // local_pl_/saved_queue_ 经 ?mix= 内容链与服务端镜像拿到远端单同款能力；
    // 打开网易云仅远端数字 id 单有意义
    const isShareShell = (playlist) => isSingleSongShellId(playlist?.id)
    // isNeteasePlaylist 实现收敛进 shared/predicates（纯数字 id）

    // 下载歌单——同一歌单在途请求合并：双击/连点不发第二个 POST，
    // 服务端对活跃队列本就 409，这里省掉那条注定失败的往返与错误 toast
    const downloadingIds = new Set()
    const downloadPlaylist = async (playlist) => {
      const pid = String(playlist.id)
      if (downloadingIds.has(pid)) {
        toast('该歌单下载已在进行中', 'info')
        closeMenu(pid)
        return
      }
      // 空本地单的 tracks 是权威空集——镜像建空壳+建 0 任务队列是纯空炮
      if (isLocalPlaylistId(playlist.id) && !(playlist.tracks?.length)) {
        toast('歌单还没有歌曲，先添加几首吧', 'info')
        closeMenu(pid)
        return
      }
      downloadingIds.add(pid)
      try {
        let mirrorNote = ''
        if (isLocalPlaylistId(playlist.id)) {
          try {
            const mirror = await downloadsApi.mirrorLocalPlaylist(playlist)
            const d = mirror?.data || {}
            if (d.skipped) mirrorNote += `（跳过 ${d.skipped} 首不支持下载的曲目）`
            if (d.truncated) mirrorNote += `（超出 ${2000} 首上限的部分未包含）`
          } catch (mirrorErr) {
            // 墓碑 409：本地单删除后 130s 内重导同 mix 链再点下载会撞
            // 「该歌单正在删除中」——对刚加回的单观感相反，改写可重试语义。
            // 注意只改镜像这一路——quick 的 409（已有队列/收尾中）要透原文
            if (mirrorErr.response?.status === 409) {
              toast('歌单清理中，请稍候重试', 'info')
              return
            }
            throw mirrorErr
          }
        }
        const res = await downloadsApi.quickDownloadPlaylist(playlist.id, {
          bitrate: 320000,
          downloadAudio: true,
          downloadLyrics: true,
          downloadCover: true,
          concurrentLimit: 3
        })

        // 服务端对终态队列原地复活而非另立行——按复用标记与完成度分文案：
        // 复活且任务全数完好 = 没有东西要下，"继续下载"的文案会误导。
        // 「查看进度」动作键补发现性闭环：toast 是后台下载的确认位，
        // 进度在哪的问题正产生于此——action toast 驻留自动翻倍
        const queue = res?.data
        toast(!queue?.reused
          ? `下载队列已创建，正在后台下载${mirrorNote}`
          : queue.totalTasks > 0 && queue.completedTasks === queue.totalTasks
            ? `该歌单已全部下载${mirrorNote}`
            : `继续下载该歌单的已有队列${mirrorNote}`,
          'success', null, {
            label: '查看进度',
            onAction: () => emit('view-download-progress', playlist.id)
          })
      } catch (error) {
        console.error('创建下载队列失败:', error)
        const message = apiErrorMessage(error)
        // 409 过载：删除墓碑窗（管理页级联删/镜像删后 ~130s 重下会撞）改写为
        // 可重试语义；"已有进行中的队列"等冲突原文透传
        toast(
          error.response?.status === 409 && /正在删除中/.test(message)
            ? '歌单清理中，请稍候重试'
            : '下载失败: ' + message, 'error')
      } finally {
        downloadingIds.delete(pid)
        closeMenu(pid) // 失败也要关菜单——否则菜单挂着看似还能点（定点关：别误杀新菜单）
      }
    }

    // 「下载进度」深链：交给 App 切下载页并预选本单队列（emit 只带 id——
    // 侧栏身份即深链身份，local_pl_*/数字 id 都直接可寻址）
    const viewDownloadProgress = (playlist) => {
      emit('view-download-progress', playlist.id)
      closeMenu()
    }

    const deletePlaylistDownloads = async (playlist) => {
      // confirm 取消分支与 removePlaylist 行为一致：也关菜单
      if (!await pixelConfirm(`确定要删除歌单 "${playlist.name}" 的已下载歌曲吗？`, { confirmText: '删除', danger: true })) {
        closeMenu(playlist.id)
        return
      }

      try {
        // 本地单先尝试镜像再删：镜像只是让行存在的手段——删除按歌单行清任务+文件，
        // 与曲目集无关。镜像任何失败（400 全 bv_/网络抖动）都继续删——旧镜像行
        // 还在就照样清得掉；只有 404（从未镜像）才是真的没有可删
        if (isLocalPlaylistId(playlist.id)) {
          await downloadsApi.mirrorLocalPlaylist(playlist).catch(() => {})
        }
        let response
        try {
          response = await downloadsApi.deletePlaylistDownloads(playlist.id)
        } catch (delErr) {
          if (delErr.response?.status === 404) {
            toast('这个歌单没有可删除的已下载歌曲', 'info')
            return
          }
          throw delErr
        }
        // 畸形响应（反代返回 HTML 200 等）不该吞成"0 首"假提示
        const deletedSongs = response?.data?.deletedSongs
        if (typeof deletedSongs !== 'number') {
          throw new Error('接口返回异常')
        }
        toast(deletedSongs > 0 ? `已删除 ${deletedSongs} 首已下载歌曲` : '这个歌单没有可删除的已下载歌曲', deletedSongs > 0 ? 'success' : 'info')
        // 0 首时不必触发父组件刷新——只会多发一轮无效任务轮询
        if (deletedSongs > 0) emit('playlist-downloads-deleted', playlist.id)
      } catch (error) {
        console.error('批量删除已下载歌曲失败:', error)
        const message = apiErrorMessage(error)
        toast('删除失败: ' + message, 'error')
      } finally {
        closeMenu(playlist.id)
      }
    }

    // 点击外部关闭菜单
     // pointerdown 先于 click 且不受 @click.stop 影响——用 click 会在别处
     // .stop 控件的点击下漏关（queue 菜单项点击后 playlist 菜单残留）。
     // 豁免菜单本体与触发键 .pl-action：同一行的 ⋯ 先 pointerdown 关再
     // click 重开会变"关不掉"；分享键自身 closeMenu 兜底不影响
     const handleClickOutside = (event) => {
       if (!event.target.closest('.playlist-menu, .pl-action')) {
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
       viewDownloadProgress,
       deletePlaylistDownloads,
       isShareShell,
       isNeteasePlaylist,
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

/* 头行：label 左 + 新建键右。右缘 22px 的取舍：overlay 滚动条平台（macOS 默认）
   对齐行内 ⋯ 列缘（行块内收 12 + .pl-actions right:10）；经典滚动条平台
   （scrollbar-gutter 车道 10px 把整行左推）恰好对齐行块可视缘——两平台都落在
   真实可视缘上，而非追逐随 gutter 漂移的同一坐标 */
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-right: 22px;
  flex-shrink: 0;
}

.panel-label {
  padding: 8px 12px 10px; /* 与行块内收缘同轴（12px；封面左缘再内进 16px） */
  flex-shrink: 0;
}

.panel-create-btn { margin: 4px 0 6px; }

.panel-state {
  /* 与列表态 .playlist-scroll 同律：标题下方纯留白，无分隔线 */
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
  scrollbar-gutter: stable;
}

/* 窄轨（768-1023 未展开）只剩 64px 封面列——10px 死车道会把居中封面掰偏，此处回收；
   行块内收也回收（64px 轨里 12px×2 放不下 44px 封面） */
@media (min-width: 768px) and (max-width: 1023.98px) {
  .app-sidebar:not(.app-sidebar--open) .playlist-scroll { scrollbar-gutter: auto; }
  .app-sidebar:not(.app-sidebar--open) .pl-row { margin: 0 4px; }
  /* 窄轨行块 ~55px：操作簇在该态已 display:none（style.css ~:738），
     64px 保留位无物可让——回收为对称 6px 让封面居中 */
  .app-sidebar:not(.app-sidebar--open) .pl-row-main { padding: 9px 6px; }
  /* 窄轨 label/行内件全藏后头行只剩 + 键——与居中封面列对位
     （经典滚动条平台 scrollbar-gutter:auto 吐车道，封面心漂 ~5px，可接受） */
  .app-sidebar:not(.app-sidebar--open) .panel-head { justify-content: center; padding-right: 0; }
}

/* 歌单行：留白节奏（无分隔线），整行可点；
   行块左右内收 12px——淡底/accent 尺的可视边缘与 panel-label 标题同轴起落 */
.pl-row {
  position: relative;
  margin: 0 12px;
}

.pl-row-main {
  display: flex;
  align-items: center;
  gap: 10px;
  /* 卡内节奏：封面左右各 +6 margin（左缘→封面 16 = 封面→歌名 16）；
     右 64px 留给常显 .pl-actions（right:10 + 双 24px 键 + 2gap = 60，+4 气隙） */
  padding: 9px 64px 9px 10px;
  cursor: pointer;
  transition: background .12s;
}

.pl-row-main:hover { background: var(--ink-06); }

/* 激活行：ink-10 淡底 + 内嵌 accent 左缘标尺——与队列当前行同族的轻量选中语言 */
.pl-row--active .pl-row-main {
  background: var(--ink-10);
  box-shadow: inset 2.4px 0 0 var(--accent-magenta-ink);
}
.pl-row--active .pl-name { color: var(--ink); font-weight: 600; }

.pl-cover-wrap {
  position: relative;
  width: 44px;
  height: 44px;
  flex-shrink: 0;
  margin-inline: 6px;
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

/* 行尾操作组（分享 + ⋯）：垂直居中，与 dql 行尾键同法则 */
.pl-actions {
  position: absolute;
  top: 50%;
  /* 与封面侧同档：块内右 10px（块外 margin 12 两侧对称 → 栏缘到内容左右各 22px） */
  right: 10px;
  transform: translateY(-50%);
  display: flex;
  gap: 2px;
}

.pl-action {
  transition: color .2s; /* 尺寸交给 pg-icobtn--sm（24px 行内尾键档）；hover 走全局行尾键统一律 */
}

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

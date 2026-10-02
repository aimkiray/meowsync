import { ref, watch, onBeforeUnmount } from 'vue'
import { musicApi } from '../api/music.js'
import { downloadsApi } from '../api/downloads.js'
import { apiErrorMessage } from '../api/http.js'
import { isResolvableTrackId } from '../lib/url'
import { toast, pixelConfirm } from '../lib/feedback'

// SongList 的服务端下载子域：状态批量映射、行级下载/删除/视频补件、
// 轮询生命周期（切单/卸载守卫）。deps 全注入——菜单开合留在组件侧。
//
//   props — SongList props（selectedPlaylist / songs / playlistDownloadsRefreshKey）
//   closeDownloadMenu — 行菜单 UI 关闭回调
//   isLocalPlaylist / isShareShell — 组件侧已有 computed（多处共用，注入不搬）
export function useServerDownloads({ props, closeDownloadMenu, isLocalPlaylist, isShareShell }) {
  const serverDownloadedStates = ref({})  // 是否已下载
  const serverDownloadingStates = ref({}) // 是否正在下载
  // 组件卸载标志：单曲下载轮询挂在 v-if 挂载的组件上，切到管理面板即卸载——
  // props 卸载后仍持旧值，stillCurrent 永真会让孤儿轮询空转 10min 还跨视图弹窗
  let viewDisposed = false
  onBeforeUnmount(() => { viewDisposed = true }) // 终止下载轮询并屏蔽其状态写/弹窗

  // 「下载到服务器」可见性：网易云数字 id 全场景可下；qq_/bv_/yt_ 自有源
  // 曲只在本地歌单可下（镜像链带 provider 定位字段投影进曲目表），
  // 远端歌单里的追曲不在服务端曲目表必 404
  const canServerDownload = (song) => {
    if (!song) return false
    const id = String(song.id ?? '')
    if (/^\d+$/.test(id)) return true
    if (!isLocalPlaylist.value) return false
    // 非数字 id 只收外部源形态（qq_/bv_/yt_）——与镜像/分享链同一份白名单
    return isResolvableTrackId(id)
  }

  // 「下载视频到服务器」可见性：只有导入时确认有可放视频流（hasVideo）的
  // 外部曲才亮——无流曲点了必失败，不亮比亮着报错诚实
  const canServerVideo = (song) =>
    Boolean(song?.bilibili?.hasVideo || song?.youtube?.hasVideo)

  // 直接下载（浏览器下载，最高码率）
  const downloadSongDirect = async (song, bitrate = 320000) => {
    if (!song) {
      // 菜单目标已不在当前歌单（翻页/换单后残留）——关菜单而不是静默无效
      closeDownloadMenu()
      return
    }
    // 点击即关菜单：直接下载要等整个 fetch+blob（可能数十秒），
    // 留着透明 overlay 罩全屏会阻塞一切点击
    closeDownloadMenu()
    try {
      // blob 下载全程无浏览器自带进度提示——先给一个开始戳记，终点由浏览器下载栏呈现
      toast(`正在获取「${song.name}」…`, 'info')
      // 外部导入曲没有网易云下载链——拉自己的 /bilibili|youtube|qq/stream
      // （prefer=best：B 站可拿 Hi-Res FLAC/杜比，YouTube 拿 Opus 251，
      // QQ 可拿 RS01/F000 无损档）
      if (song.bilibili?.bvid) await musicApi.downloadBilibiliSong(song)
      else if (song.youtube?.videoId) await musicApi.downloadYouTubeSong(song)
      else if (song.qq?.mid) await musicApi.downloadQQSong(song)
      else await musicApi.downloadSong(song, bitrate)
    } catch (error) {
      console.error('下载失败:', error)
      toast('下载失败: ' + apiErrorMessage(error), 'error')
    }
  }

  // 批量查询所有歌曲的下载状态：一次 listTasks 拉回该歌单全部任务本地映射，
  // 避免逐曲 N+1 请求（歌单未导入/未镜像时服务端返回空数组，天然无副作用）
  // 请求序号守卫：切歌单时旧歌单的 in-flight 响应不能写状态（跨歌单同 songId 会串标）
  let statusCheckSeq = 0
  const checkAllSongsDownloadStatus = async () => {
    const seq = ++statusCheckSeq
    const playlistId = props.selectedPlaylist?.id
    // single_song_ 壳无服务端镜像面；local_pl_/saved_queue_ 经镜像行
    // findExistingPlaylistId 自然解析——无需前置镜像
    if (!playlistId || !props.songs.length || isShareShell.value) {
      serverDownloadedStates.value = {}
      serverDownloadingStates.value = {} // 在途标记同属旧歌单，一并清
      return
    }

    try {
      const response = await downloadsApi.listTasks({ playlistId })
      if (seq !== statusCheckSeq) return // 已有更新的请求在飞，丢弃本次结果
      // 畸形响应（如反代把 API 误指到静态服返回 HTML 200）必须当失败处理，
      // 否则 || [] 会把全部"已下载"标记静默清成未下载
      const tasks = response?.data
      if (!Array.isArray(tasks)) {
        throw new Error('任务列表响应格式异常')
      }
      const downloadedIds = new Set(
        // completed 但文件已被外部删除的行（filesIntact=false）不算已下载——
        // 与单曲状态口径一致，重新露出下载入口走自愈重跑
        tasks.filter(t => t.status === 'completed' && t.filesIntact !== false)
          .map(t => String(t.songId))
      )
      for (const song of props.songs) {
        serverDownloadedStates.value[song.id] = downloadedIds.has(String(song.id))
      }
    } catch (error) {
      if (seq !== statusCheckSeq) return
      // 查询失败必须清空旧状态：否则切歌单/服务重启后残留上一歌单的"已下载"标记
      serverDownloadedStates.value = {}
      console.error('查询下载状态失败:', error)
    }
  }

  // 下载到服务器或删除
  // wantVideo：补源站视频工件（仅外部曲）——跳过"已下载→删除"分支，
  // 已下载音频的任务由服务端翻 pending 只补视频相位
  const toggleServerDownload = async (song, wantVideo = false) => {
    if (!song) {
      closeDownloadMenu()
      return
    }
    // 在途守卫：处理中再点会发出重复请求撞服务端 409，
    // 用户看到的却是"下载失败"——直接关菜单静默返回
    if (song && serverDownloadingStates.value[song.id]) {
      closeDownloadMenu()
      return
    }
    if (!props.selectedPlaylist) {
      toast('请先选择歌单', 'error')
      closeDownloadMenu()
      return
    }

    // 本地单下载前先镜像——服务端任务按歌单行组织，镜像后 playlist.id
    // 经 findExistingPlaylistId 解析即可复用全部既有路由
    const isDownloaded = serverDownloadedStates.value[song.id]
    // 请求在途时用户可能已切换歌单——响应落地后写状态会污染新歌单的同 id 歌曲
    // （状态 map 是"当前歌单"的视图，写前必须确认归属未变）
    const ownerPlaylistId = props.selectedPlaylist.id
    const stillCurrent = () =>
      !viewDisposed
      && String(props.selectedPlaylist?.id) === String(ownerPlaylistId)

    if (isDownloaded && !wantVideo) {
      // 删除已下载文件
      if (!await pixelConfirm(`确定要删除 "${song.name}" 的已下载文件吗？`, { confirmText: '删除', danger: true })) {
        closeDownloadMenu()
        return
      }

      try {
        serverDownloadingStates.value[song.id] = true
        await downloadsApi.deleteSongDownload(ownerPlaylistId, song.id)
        if (stillCurrent()) serverDownloadedStates.value[song.id] = false
        toast('删除成功', 'success')
      } catch (error) {
        console.error('删除失败:', error)
        toast('删除失败: ' + apiErrorMessage(error), 'error')
      } finally {
        if (stillCurrent()) {
          serverDownloadingStates.value[song.id] = false
        }
        closeDownloadMenu()
      }
    } else {
      // 下载到服务器：提交即返回任务行，终态靠状态轮询（不再同步挂起 HTTP——
      // 长下载不会被反代/浏览器超时切断，重试也不会撞出脏响应）
      try {
        serverDownloadingStates.value[song.id] = true
        if (isLocalPlaylist.value) {
          await downloadsApi.mirrorLocalPlaylist(props.selectedPlaylist)
        }
        const response = await downloadsApi.downloadSongToServer(ownerPlaylistId, song.id, {
          bitrate: 320000,
          downloadAudio: true,
          downloadLyrics: true,
          downloadCover: true,
          downloadVideo: wantVideo
        })
        const submittedTask = response?.data
        // completed 短路（幂等返回）才跳过轮询；pending/downloading 进入轮询
        if (submittedTask?.status !== 'completed') {
          // 轮询窗口封顶 10min：超时只报"仍在后台"，任务在服务端继续跑
          const deadline = Date.now() + 10 * 60 * 1000
          let terminal = null
          // 单次轮询失败（网络抖动/超时）不该判死下载——容忍连续 3 次再放弃，
          // 服务端任务不受影响
          let pollErrors = 0
          while (stillCurrent() && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 1500))
            let stData
            try {
              const st = await downloadsApi.getSongDownloadStatus(ownerPlaylistId, song.id)
              stData = st?.data
              pollErrors = 0
            } catch (pollErr) {
              if (++pollErrors >= 3) throw pollErr
              continue
            }
            if (stData?.downloaded) {
              terminal = 'completed'
              break
            }
            const taskStatus = stData?.task?.status
            if (taskStatus === 'failed') {
              throw new Error(stData.task.errorMessage || '下载失败')
            }
            // 任务行被外部删掉（管理面板清理）：没有可等的目标，快速退出
            if (stData && stData.task === null) {
              throw new Error('下载任务已不存在（可能在下载管理中被清理）')
            }
          }
          // 用户已切走歌单：静默结束（状态不属于当前视图，不该弹窗打扰）
          if (!stillCurrent()) return
          if (terminal !== 'completed') {
            // 非失败语义的提示单独提示——混进"下载失败:"前缀是误导
            toast('下载仍在后台进行中，可稍后在下载管理里查看结果')
            return
          }
        }
        if (!stillCurrent()) return // 幂等命中也走同一出口：视图已换即静默
        serverDownloadedStates.value[song.id] = true
        toast(wantVideo ? '视频下载成功' : '下载成功', 'success')
      } catch (error) {
        console.error('下载失败:', error)
        // 本地单 409 = 撞删除墓碑（镜像/级联途中）——与 PlaylistPanel 同款改写
        if (stillCurrent()) toast(
          isLocalPlaylist.value && error.response?.status === 409
            ? '歌单清理中，请稍候重试'
            : '下载失败: ' + apiErrorMessage(error), 'error')
      } finally {
        if (stillCurrent()) {
          serverDownloadingStates.value[song.id] = false
        }
        closeDownloadMenu()
      }
    }
  }

  // 「下载视频到服务器」= 同一生命周期，只多传 wantVideo
  const downloadServerVideo = (song) => toggleServerDownload(song, true)

  // 监听歌曲列表/歌单变化，自动查询状态；切歌单先清旧状态防止串标
  watch(() => props.selectedPlaylist?.id, () => {
    serverDownloadedStates.value = {}
    serverDownloadingStates.value = {} // 处理中标记同样属于旧歌单，一并清
    closeDownloadMenu() // 菜单目标已随歌单失效，不留悬空菜单
    checkAllSongsDownloadStatus()
  })

  watch(() => props.songs, () => {
    checkAllSongsDownloadStatus()
  }, { immediate: true })

  watch(() => props.playlistDownloadsRefreshKey, () => {
    checkAllSongsDownloadStatus()
  })

  return {
    serverDownloadedStates, serverDownloadingStates,
    canServerDownload, canServerVideo,
    downloadSongDirect, toggleServerDownload, downloadServerVideo,
    checkAllSongsDownloadStatus,
  }
}

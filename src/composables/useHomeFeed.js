import { ref, watch, onBeforeUnmount } from 'vue'
import { musicApi } from '../api/music'
import { readJSON, writeJSON } from '../lib/storage'
import { isSingleSongShellId } from '../lib/song'

const PLAY_HISTORY_STORAGE_KEY = 'meowsync-play-history'
const PLAYLIST_HISTORY_STORAGE_KEY = 'meowsync-playlist-history'

// 首页发现流 + 最近播放历史：榜单一次加载闩锁、断网恢复重试、
// localStorage 持久化历史（20 条去重置顶）。
// deps 由宿主注入：centerView 驱动懒加载，三张 ref 服务 recordPlaylistHistory 查单
export function useHomeFeed({ centerView, userPlaylists, selectedPlaylist, playingPlaylistId }) {
  const homeToplists = ref([])
  const playHistory = ref([])
  const playlistHistory = ref([])
  const homeLoading = ref(false)

  // 8s 软上限：上游挂起时不让用户盯满 15s axios 超时——先到点落失败态，
  // 晚到的数据经响应式照常补位替换失败文案
  let homeLoaded = false
  const loadHomeFeed = () => {
    if (homeLoaded) return
    homeLoaded = true
    homeLoading.value = true
    const settled = Promise.allSettled([
      musicApi.getToplists().then(list => { homeToplists.value = list.slice(0, 12) })
    ])
    settled.then(results => {
      // allSettled 吞掉每路报错——留个脚印，否则全挂时控制台静默
      results.forEach(r => {
        if (r.status === 'rejected') console.warn('[home]', r.reason?.message || r.reason)
      })
      // 全空（失败/空数组）解开一次性闩锁——回到首页或网络恢复时可重试
      if (!homeToplists.value.length) {
        homeLoaded = false
      }
    })
    Promise.race([settled, new Promise(resolve => setTimeout(resolve, 8000))])
      .finally(() => { homeLoading.value = false })
  }
  // 回到首页即重试（上一趟有货则闩锁短路零成本）；断网恢复同理
  watch(centerView, v => { if (v === 'home') loadHomeFeed() })
  window.addEventListener('online', loadHomeFeed)

  // 最近播放：按 id 去重置顶、截 20 首；只存渲染/重播需要的字段，
  // 接口原始对象（含 alia 等大字段）整只塞 storage 会撑爆配额
  const recordPlayHistory = (song) => {
    if (!song || song.id == null) return
    const entry = {
      id: song.id, name: song.name,
      ar: song.ar || song.artists, al: song.al || song.album,
      dt: song.dt ?? song.duration, fee: song.fee, privilege: song.privilege,
      // B 站导入曲的播放源/歌词源字段——丢了从历史点回会退成不可播
      bilibili: song.bilibili, neteaseId: song.neteaseId,
      youtube: song.youtube, // YouTube 导入曲同理——丢了从历史点回会退成不可播
      qq: song.qq // qq_<mid> 同理——播放源与词源键都在里面
    }
    playHistory.value = [entry, ...playHistory.value.filter(s => String(s.id) !== String(song.id))].slice(0, 20)
    writeJSON(PLAY_HISTORY_STORAGE_KEY, playHistory.value)
  }

  // 最近播放的歌单：记播放上下文的归属歌单（playingPlaylistId，已在快照时锁死）。
  // single_song_ 单曲分享是临时壳不算歌单；saved_queue_ 是用户歌单照记。
  // 对象优先查 userPlaylists 活副本（本地歌单的 tracks 只有那里有），查不到才落 stub
  const recordPlaylistHistory = () => {
    const pid = playingPlaylistId.value
    if (pid == null || isSingleSongShellId(pid)) return
    const pl = userPlaylists.value.find(p => String(p.id) === String(pid))
      || (String(selectedPlaylist.value?.id) === String(pid) ? selectedPlaylist.value : null)
    if (!pl) return
    const entry = {
      id: pl.id, name: pl.name,
      coverImgUrl: pl.coverImgUrl || pl.picUrl || '',
      trackCount: pl.trackCount ?? pl.tracks?.length
    }
    playlistHistory.value = [entry, ...playlistHistory.value.filter(p => String(p.id) !== String(pid))].slice(0, 20)
    writeJSON(PLAYLIST_HISTORY_STORAGE_KEY, playlistHistory.value)
  }

  // init 恢复：脏条目（无 id）滤掉
  const restoreHistory = () => {
    const savedHistory = readJSON(PLAY_HISTORY_STORAGE_KEY)
    if (Array.isArray(savedHistory)) {
      playHistory.value = savedHistory.filter(s => s && s.id != null)
    }
    const savedPlHistory = readJSON(PLAYLIST_HISTORY_STORAGE_KEY)
    if (Array.isArray(savedPlHistory)) {
      playlistHistory.value = savedPlHistory.filter(p => p && p.id != null)
    }
  }

  onBeforeUnmount(() => {
    window.removeEventListener('online', loadHomeFeed)
  })

  return {
    homeToplists, playHistory, playlistHistory, homeLoading,
    loadHomeFeed, recordPlayHistory, recordPlaylistHistory, restoreHistory
  }
}

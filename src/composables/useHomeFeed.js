import { ref } from 'vue'
import { readJSON, writeJSON, LS_KEYS } from '../lib/storage.js'
import { isSingleSongShellId } from '../lib/song.js'

const PLAY_HISTORY_STORAGE_KEY = LS_KEYS.PLAY_HISTORY
const PLAYLIST_HISTORY_STORAGE_KEY = LS_KEYS.PLAYLIST_HISTORY

// 最近播放历史：localStorage 持久化（20 条去重置顶）。
// 首页货架全部由本地历史派生，无网络请求。
// deps 由宿主注入：三张 ref 服务 recordPlaylistHistory 查单
export function useHomeFeed({ userPlaylists, selectedPlaylist, playingPlaylistId }) {
  const playHistory = ref([])
  const playlistHistory = ref([])

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
      qq: song.qq, // qq_<mid> 同理——播放源与词源键都在里面
      file: song.file, // file_ 上传曲的资产位——丢了历史回放的封面/视频/歌词标志全灭
      custom: song.custom, // 用户编辑位——同 addedTracks 白名单之理
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

  return {
    playHistory, playlistHistory,
    recordPlayHistory, recordPlaylistHistory, restoreHistory
  }
}

// useAddToPlaylist 点歌台 yt: 前缀钉板（vitest+jsdom，musicApi mock）：
//   yt:<关键词>        → searchYouTubeSongs → buildYouTubeSong 归一 yt_ 行
//   yt:<裸 id/URL>     → resolve 直解先行（与 isYouTubeInput 分支同链）——
//                        resolve 失败回落关键词搜索；已在单本地短路省 resolve
//   yt:<纯数字 11 位>  → resolve 直解（?yt= 分享链形态送达——裸分支拒纯
//                        数字防撞网易云，yt: 显式前缀内绕开）
//   yt:<歌单链>        → 指向性提示（整单导入走顶栏，点歌台无落点）
//   yt:<空>            → 静默吞
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'

const { musicApi, toast } = vi.hoisted(() => ({
  musicApi: {
    searchYouTubeSongs: vi.fn(),
    resolveYouTube: vi.fn(),
    searchSongs: vi.fn(),
    getSongDetail: vi.fn(),
  },
  toast: vi.fn(() => 1),
}))
vi.mock('../../src/api/music.js', () => ({ musicApi }))
vi.mock('../../src/lib/feedback.js', () => ({ toast, toastDismiss: vi.fn() }))

const { createReqGate } = await import('../../src/lib/req-gate.js')
const { useAddToPlaylist } = await import('../../src/composables/useAddToPlaylist.js')

const ROW = (videoId, over = {}) => ({
  videoId, title: `曲-${videoId}`, author: `频道-${videoId} - Topic`,
  authorClean: `频道-${videoId}`, duration: 200,
  cover: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  songName: `曲-${videoId}`, matched: null, publishedAt: null,
  hasVideo: true, hasDownloadableVideo: true,
  ...over,
})
// resolve 回包形（/youtube/resolve extractYtSong 剥洗后的 buildYouTubeSong 输入）
const RESOLVED = (videoId) => ({
  videoId, title: `解析曲-${videoId}`, author: `频道-${videoId}`,
  authorClean: `频道-${videoId}`, duration: 210,
  cover: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  songName: `解析曲-${videoId}`, matched: null, publishedAt: null,
  hasVideo: true, hasDownloadableVideo: true,
})

const PL = { id: 'local_pl_1', name: '目标单', isLocal: true, tracks: [] }

const makeAtp = (plTracks = []) => {
  const libPl = { ...PL, tracks: plTracks }
  const deps = {
    gates: { picker: createReqGate() },
    userPlaylists: ref([libPl]),
    selectedPlaylist: ref({ id: 'local_pl_1', name: '目标单', tracks: plTracks }),
    songs: ref([]),
    addPlaylistToLibrary: vi.fn(),
    appendSongToLibraryPlaylist: vi.fn(() => 'added'),
    createLocalPlaylist: vi.fn(),
    closeCreatePlaylist: vi.fn(),
  }
  const atp = useAddToPlaylist(deps)
  atp.openSongPicker()
  return { atp, deps }
}
const search = async (atp, q) => {
  atp.songPickerQuery.value = q
  await atp.songPickerSearch()
}

beforeEach(() => {
  vi.clearAllMocks()
  toast.mockReturnValue(1)
  musicApi.searchYouTubeSongs.mockResolvedValue({ items: [ROW('vid00000001')], continuation: 'tok-1' })
  musicApi.resolveYouTube.mockResolvedValue(RESOLVED('dQw4w9WgXcQ'))
})

describe('useAddToPlaylist：yt: 前缀', () => {
  it('yt:<关键词> → searchYouTubeSongs 直搜，行形归一 yt_ 曲', async () => {
    const { atp } = makeAtp()
    await search(atp, 'yt:lofi beats')
    expect(musicApi.searchYouTubeSongs).toHaveBeenCalledWith('lofi beats', { signal: expect.any(AbortSignal) })
    expect(musicApi.resolveYouTube).not.toHaveBeenCalled()
    const s = atp.songPickerResults.value[0]
    expect(s.id).toBe('yt_vid00000001')
    expect(s.youtube.videoId).toBe('vid00000001')
  })

  it('yt:<裸 videoId> → resolve 直解入单（不烧搜索配额）', async () => {
    const { atp, deps } = makeAtp()
    await search(atp, 'yt:dQw4w9WgXcQ')
    expect(musicApi.resolveYouTube).toHaveBeenCalledWith('dQw4w9WgXcQ', expect.any(AbortSignal))
    expect(musicApi.searchYouTubeSongs).not.toHaveBeenCalled()
    // resolveToPickedSong：结果置顶 + 入单收口
    expect(atp.songPickerResults.value[0].id).toBe('yt_dQw4w9WgXcQ')
    expect(deps.appendSongToLibraryPlaylist).toHaveBeenCalled()
    expect(atp.songPickerAdded.value.has('yt_dQw4w9WgXcQ')).toBe(true)
  })

  it('yt:<纯数字 videoId> → resolve 直解（?yt= 包装送达服务端）', async () => {
    const { atp } = makeAtp()
    await search(atp, 'yt:12345678901')
    // extractYouTubeId 裸分支拒纯数字——yt: 前缀显式声明源，改写 ?yt= 形态
    // 送达（服务端同表可解）；摘了 YT_ID_RE 分支会直走关键词搜索即红
    expect(musicApi.resolveYouTube).toHaveBeenCalledWith('?yt=12345678901', expect.any(AbortSignal))
    expect(musicApi.searchYouTubeSongs).not.toHaveBeenCalled()
  })

  it('yt:<id 形> resolve 失败 → 回落关键词搜索', async () => {
    const { atp } = makeAtp()
    musicApi.resolveYouTube.mockRejectedValue(new Error('视频不存在'))
    await search(atp, 'yt:dQw4w9WgXcQ')
    expect(musicApi.resolveYouTube).toHaveBeenCalled()
    expect(musicApi.searchYouTubeSongs).toHaveBeenCalledWith('dQw4w9WgXcQ', { signal: expect.any(AbortSignal) })
    expect(atp.songPickerResults.value[0].id).toBe('yt_vid00000001')
  })

  it('yt:<已在单 videoId> → 本地短路，resolve/搜索都不打', async () => {
    const { atp } = makeAtp([{ id: 'yt_dQw4w9WgXcQ', name: '已有' }])
    await search(atp, 'yt:dQw4w9WgXcQ')
    expect(musicApi.resolveYouTube).not.toHaveBeenCalled()
    expect(musicApi.searchYouTubeSongs).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith('该视频已在歌单里', 'info')
  })

  it('yt:<歌单链> → 指向性提示，无上游请求', async () => {
    const { atp } = makeAtp()
    await search(atp, 'yt:https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf')
    expect(musicApi.resolveYouTube).not.toHaveBeenCalled()
    expect(musicApi.searchYouTubeSongs).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith('这是 YouTube 歌单链接，请在顶部搜索框粘贴导入', 'info')
  })

  it('yt:<空>/空结果 → 静默/提示，不出错', async () => {
    const { atp } = makeAtp()
    await search(atp, 'yt:   ')
    expect(musicApi.searchYouTubeSongs).not.toHaveBeenCalled()
    musicApi.searchYouTubeSongs.mockResolvedValue({ items: [], continuation: null })
    await search(atp, 'yt:不存在zzz')
    expect(atp.songPickerResults.value).toEqual([])
    expect(toast).toHaveBeenCalledWith('YouTube 没有找到相关歌曲', 'info')
  })
})

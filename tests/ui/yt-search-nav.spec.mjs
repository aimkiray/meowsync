// useSearchNav YouTube 源钉板（vitest+jsdom，musicApi/http/feedback 全 mock）：
//   handleYTSongSearch — {items,continuation} 落地、行形经 buildYouTubeSong
//     归一成 yt_ 曲、total 恒 null（YT 无总数）、ytContinuation 游标亮灯、
//     失败 toast（单腿搜索无半幅容错）
//   loadMoreSearchSongs — YT 走不透明 continuation 游标（与 QQ 页码/网易云
//     offset 三口径隔离）、按 id 去重追加、null 收键见底、零进展灭键、
//     失败游标不动可重试、query/reqId 双代次守卫
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'

const { musicApi, toast } = vi.hoisted(() => ({
  musicApi: {
    searchQQSongs: vi.fn(),
    searchQQPlaylists: vi.fn(),
    getQQPlaylist: vi.fn(),
    searchSongsPage: vi.fn(),
    searchPlaylists: vi.fn(),
    getPlaylistDetail: vi.fn(),
    searchYouTubeSongs: vi.fn(),
  },
  toast: vi.fn(() => 1),
}))
vi.mock('../../src/api/music.js', () => ({ musicApi }))
vi.mock('../../src/api/http.js', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  API_BASE_URL: 'http://api.test',
  apiErrorMessage: (e, fb) => e?.message || fb || '接口异常',
}))
vi.mock('../../src/lib/feedback.js', () => ({ toast, toastDismiss: vi.fn() }))

const { createReqGate } = await import('../../src/lib/req-gate.js')
const { useSearchNav } = await import('../../src/composables/useSearchNav.js')

// 服务端 /youtube/search 行形（ytSearchRow 产出）——buildYouTubeSong 直喂形
const ROW = (videoId, over = {}) => ({
  videoId, title: `曲-${videoId} (Official Video)`, author: `频道-${videoId} - Topic`,
  authorClean: `频道-${videoId}`, duration: 200,
  cover: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  songName: `曲-${videoId}`, matched: null, publishedAt: null,
  hasVideo: true, hasDownloadableVideo: true,
  channelId: `UC${videoId}`, publishedTimeText: '3 年前',
  ...over,
})
const T = (mid, extra = {}) => ({
  mid, songId: 1, name: `歌${mid}`, artists: ['艺人'], album: '专',
  albummid: '', duration: 200, cover: '', mediaMid: mid, payPlay: false,
  vipOnly: false, ...extra,
})

const makeNav = () => {
  const deps = {
    gates: {
      select: createReqGate(), preview: createReqGate(), search: createReqGate(),
      mediaImport: createReqGate(), picker: createReqGate(),
    },
    searchQuery: ref(''), currentSong: ref(null), watchTab: ref('upnext'),
    isFullscreenPlayerOpen: ref(false),
    userPlaylists: ref([]), selectedPlaylist: ref(null), loadingSongs: ref(false),
    playSong: vi.fn(), playSongFromSearch: vi.fn(),
    playSongFromRelated: vi.fn(), playPlaylist: vi.fn(),
  }
  deps.selectPlaylist = vi.fn(async (pl) => { deps.selectedPlaylist.value = pl; return true })
  deps.savePlaylistsToStorage = vi.fn()
  const nav = useSearchNav(deps)
  return { nav, deps }
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  toast.mockReturnValue(1)
  musicApi.searchYouTubeSongs.mockResolvedValue({ items: [ROW('vid00000001')], continuation: 'tok-1' })
  musicApi.searchQQSongs.mockResolvedValue({ songs: [T('001AAAaaa00001')], total: 600 })
  musicApi.searchQQPlaylists.mockResolvedValue({ playlists: [], total: 0 })
  musicApi.searchSongsPage.mockResolvedValue({ songs: [{ id: 7 }], total: 61 })
  musicApi.searchPlaylists.mockResolvedValue({ playlists: [] })
})

describe('useSearchNav：YouTube 搜索', () => {
  it('handleYTSongSearch：行形归一 yt_ 曲 + continuation 亮灯 + total 恒 null', async () => {
    const { nav } = makeNav()
    await nav.handleYTSongSearch('lofi beats')
    expect(musicApi.searchYouTubeSongs).toHaveBeenCalledWith('lofi beats', { limit: 20 })
    const s = nav.searchSongResults.value[0]
    expect(s.id).toBe('yt_vid00000001')
    expect(s.name).toBe('曲-vid00000001')
    expect(s.ar[0].name).toBe('频道-vid00000001')
    expect(s.youtube.videoId).toBe('vid00000001')
    expect(nav.ytContinuation.value).toBe('tok-1')
    expect(nav.searchSongTotal.value).toBeNull() // YT 无总数——深挖全看游标
    expect(nav.searchSongQuery.value).toBe('lofi beats')
    expect(nav.searchResults.value).toEqual([]) // YT 无歌单搜索腿
    expect(nav.centerView.value).toBe('search')
  })

  it('handleYTSongSearch：无 token 回包 → 游标灭；失败 toast', async () => {
    const { nav } = makeNav()
    musicApi.searchYouTubeSongs.mockResolvedValue({ items: [ROW('vid00000001')], continuation: null })
    await nav.handleYTSongSearch('x')
    expect(nav.ytContinuation.value).toBeNull()

    musicApi.searchYouTubeSongs.mockRejectedValue(new Error('HTTP 502'))
    await nav.handleYTSongSearch('y')
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('YouTube 搜索失败'), 'error')
    expect(nav.searchSongResults.value).toEqual([])
  })

  it('handleYTSongSearch：新搜索作废在途——迟到回包不落旧结果', async () => {
    const { nav } = makeNav()
    let resolveFirst
    musicApi.searchYouTubeSongs.mockImplementationOnce(() => new Promise(r => { resolveFirst = r }))
    const p1 = nav.handleYTSongSearch('first')
    await nav.handleQQSongSearch('second') // 认领同一张搜索闸——first 已过期
    resolveFirst({ items: [ROW('vid00000009')], continuation: 'tok-stale' })
    await p1
    expect(nav.searchSongResults.value.map(s => s.id)).toEqual(['qq_001AAAaaa00001'])
    expect(nav.ytContinuation.value).toBeNull() // 旧游标不复活
    expect(nav.searchSongQuery.value).toBe('second')
  })

  it('loadMoreSearchSongs：continuation 原样回传 + 去重追加 + 游标推进', async () => {
    const { nav } = makeNav()
    await nav.handleYTSongSearch('lofi')
    // 深挖第 2 页：新歌 + 重复（上游漂移重叠须去重）+ 新 token
    musicApi.searchYouTubeSongs.mockResolvedValueOnce({
      items: [ROW('vid00000002'), ROW('vid00000001')], continuation: 'tok-2',
    })
    await nav.loadMoreSearchSongs()
    expect(musicApi.searchYouTubeSongs).toHaveBeenLastCalledWith('lofi', { limit: 20, continuation: 'tok-1' })
    expect(nav.searchSongResults.value.map(s => s.id)).toEqual(['yt_vid00000001', 'yt_vid00000002'])
    expect(nav.ytContinuation.value).toBe('tok-2')

    musicApi.searchYouTubeSongs.mockResolvedValueOnce({ items: [ROW('vid00000003')], continuation: null })
    await nav.loadMoreSearchSongs()
    expect(musicApi.searchYouTubeSongs).toHaveBeenLastCalledWith('lofi', { limit: 20, continuation: 'tok-2' })
    expect(nav.ytContinuation.value).toBeNull() // null 收键见底
    musicApi.searchYouTubeSongs.mockClear()
    await nav.loadMoreSearchSongs()
    expect(musicApi.searchYouTubeSongs).not.toHaveBeenCalled() // 通道关闭直接短路
  })

  it('loadMoreSearchSongs：整页撞重 → 零进展灭键（游标尚在也收）', async () => {
    const { nav } = makeNav()
    await nav.handleYTSongSearch('lofi')
    musicApi.searchYouTubeSongs.mockResolvedValueOnce({ items: [ROW('vid00000001')], continuation: 'tok-2' })
    await nav.loadMoreSearchSongs()
    expect(nav.ytContinuation.value).toBeNull() // 页页撞重续拉只烧配额
    expect(nav.searchSongResults.value).toHaveLength(1)
  })

  it('loadMoreSearchSongs：失败游标不动可重试 + toast', async () => {
    const { nav } = makeNav()
    await nav.handleYTSongSearch('lofi')
    musicApi.searchYouTubeSongs.mockRejectedValueOnce(new Error('网络抖动'))
    await nav.loadMoreSearchSongs()
    expect(toast).toHaveBeenCalledWith('加载更多失败，点按重试', 'error')
    expect(nav.ytContinuation.value).toBe('tok-1', '失败游标不推进')
    expect(nav.searchSongResults.value).toHaveLength(1)
    // 重试成功——游标从 tok-1 正常推进
    musicApi.searchYouTubeSongs.mockResolvedValueOnce({ items: [ROW('vid00000002')], continuation: 'tok-2' })
    await nav.loadMoreSearchSongs()
    expect(nav.searchSongResults.value.map(s => s.id)).toEqual(['yt_vid00000001', 'yt_vid00000002'])
    expect(nav.ytContinuation.value).toBe('tok-2')
  })

  it('searchSongHasMore：YT 游标在场即亮/收 null 即灭；total 源口径不变', async () => {
    const { nav } = makeNav()
    // YT：continuation 非 null 即亮（total 恒 null 不参与）
    await nav.handleYTSongSearch('lofi')
    expect(nav.searchSongHasMore.value).toBe(true)
    musicApi.searchYouTubeSongs.mockResolvedValueOnce({ items: [ROW('vid00000002')], continuation: null })
    await nav.loadMoreSearchSongs()
    expect(nav.searchSongHasMore.value).toBe(false) // 游标收 null=见底灭键
    // 网易云 total 源：已载<total 亮、零进展灭键收 total 即灭——与旧
    // 模板闸 `songTotal != null && songs.length < songTotal` 同真值表
    await nav.handlePlaylistSearch('x')
    expect(nav.searchSongHasMore.value).toBe(true)
    musicApi.searchSongsPage.mockResolvedValueOnce({ songs: [], total: 99 })
    await nav.loadMoreSearchSongs()
    expect(nav.searchSongHasMore.value).toBe(false) // total 被收编到已载数
    // QQ total 源同口径：total=600 亮、空页灭键即灭
    await nav.handleQQSongSearch('周杰伦')
    expect(nav.searchSongHasMore.value).toBe(true)
    musicApi.searchQQSongs.mockResolvedValueOnce({ songs: [], total: 600 })
    await nav.loadMoreSearchSongs()
    expect(nav.searchSongHasMore.value).toBe(false)
  })

  it('loadMoreSearchSongs：QQ/网易云口径互不误用 YT 游标', async () => {
    const { nav } = makeNav()
    // YT 结果集被 QQ 新搜索接管——游标复位，深挖走 QQ 页码
    await nav.handleYTSongSearch('lofi')
    await nav.handleQQSongSearch('周杰伦')
    expect(nav.ytContinuation.value).toBeNull()
    await nav.loadMoreSearchSongs()
    expect(musicApi.searchQQSongs).toHaveBeenLastCalledWith('周杰伦', { limit: 20, page: 2 })
    expect(musicApi.searchYouTubeSongs).toHaveBeenCalledTimes(1) // 只打过头页
    // 网易云口径同样隔离——searchSongsPage offset 不吃 YT 游标
    await nav.handlePlaylistSearch('x')
    musicApi.searchYouTubeSongs.mockClear()
    await nav.loadMoreSearchSongs()
    expect(musicApi.searchSongsPage).toHaveBeenLastCalledWith('x', { limit: 20, offset: 1 })
    expect(musicApi.searchYouTubeSongs).not.toHaveBeenCalled()
  })
})

// useSearchNav QQ 源钉板（vitest+jsdom，musicApi/http/feedback 全 mock）：
//   handleQQSongSearch — 单曲+歌单双腿并行、{songs,total} 落地、深挖 total 亮灯
//   loadMoreSearchSongs — QQ 走页码游标 p=N+1（与网易云 offset 口径隔离），
//                         按 id 去重追加、零进展灭键
//   openSearchPlaylist  — provider:'qq' 卡走 /qq/playlist 导入链（幂等壳
//                         local_pl_qq_ + 落盘 + force 选中），非 QQ 卡原路不变
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'

const { musicApi, toast, qqLoggedIn } = vi.hoisted(() => ({
  musicApi: {
    searchQQSongs: vi.fn(),
    searchQQPlaylists: vi.fn(),
    getQQPlaylist: vi.fn(),
    searchSongsPage: vi.fn(),
    searchPlaylists: vi.fn(),
    getPlaylistDetail: vi.fn(),
  },
  toast: vi.fn(() => 1),
  // 卡路径 Cookie 引导消费的惰性单飞——缺省 null=「态未知」不触发引导
  qqLoggedIn: vi.fn(async () => null),
}))
vi.mock('../../src/api/music.js', () => ({ musicApi, qqLoggedIn }))
vi.mock('../../src/api/http.js', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  API_BASE_URL: 'http://api.test',
  apiErrorMessage: (e, fb) => e?.message || fb || '接口异常',
}))
vi.mock('../../src/lib/feedback.js', () => ({ toast, toastDismiss: vi.fn() }))

const { createReqGate } = await import('../../src/lib/req-gate.js')
const { useSearchNav } = await import('../../src/composables/useSearchNav.js')
const { LS_KEYS } = await import('../../src/lib/storage.js')

// 归一曲目（routes/qq.js trackJson 形）→ buildQQSong 产出 qq_ 曲对象
const T = (mid, extra = {}) => ({
  mid, songId: 1, name: `歌${mid}`, artists: ['艺人'], album: '专',
  albummid: '', duration: 200, cover: '', mediaMid: mid, payPlay: false,
  vipOnly: false, ...extra,
})
const CARD = {
  id: 'local_pl_qq_7097197259', disstid: '7097197259', name: '催专累了',
  coverImgUrl: 'https://y.gtimg.cn/x.jpg', creator: { nickname: '念安娜' },
  trackCount: 108, playCount: 91998486, provider: 'qq',
}

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
  // M2 契约：nav 域不自写库持久化——注入库域 savePlaylistsToStorage；
  // harness 桩做最小真写，让落盘断言仍走真实 localStorage 面
  deps.savePlaylistsToStorage = vi.fn(() => {
    localStorage.setItem(LS_KEYS.PLAYLISTS, JSON.stringify(deps.userPlaylists.value))
  })
  const nav = useSearchNav(deps)
  return { nav, deps }
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  toast.mockReturnValue(1)
  qqLoggedIn.mockResolvedValue(null) // mockResolvedValue 跨用例残留——归位「态未知」缺省
  musicApi.searchQQSongs.mockResolvedValue({ songs: [T('001AAAaaa00001')], total: 600 })
  musicApi.searchQQPlaylists.mockResolvedValue({ playlists: [CARD], total: 46689 })
  musicApi.getQQPlaylist.mockResolvedValue({
    name: '催专累了', creator: '念安娜', cover: 'https://c/pl.jpg', desc: '',
    tracks: [T('002BBBbbb00002')], truncated: false,
  })
  musicApi.searchSongsPage.mockResolvedValue({ songs: [{ id: 7 }], total: 61 })
  musicApi.searchPlaylists.mockResolvedValue({ playlists: [{ id: 9, name: 'P' }] })
})

describe('useSearchNav：QQ 搜索', () => {
  it('handleQQSongSearch：单曲+歌单双腿落地，total 真值点亮深挖', async () => {
    const { nav } = makeNav()
    await nav.handleQQSongSearch('周杰伦')
    expect(musicApi.searchQQSongs).toHaveBeenCalledWith('周杰伦', { limit: 20, page: 1 })
    expect(musicApi.searchQQPlaylists).toHaveBeenCalledWith('周杰伦', { limit: 20 })
    expect(nav.searchSongTotal.value).toBe(600)
    expect(nav.searchSongResults.value[0].id).toBe('qq_001AAAaaa00001')
    expect(nav.searchResults.value).toEqual([CARD]) // provider:'qq' 卡进歌单结果区
  })

  it('handleQQSongSearch：双腿全败才 toast，单腿败留半幅结果', async () => {
    const { nav } = makeNav()
    musicApi.searchQQPlaylists.mockRejectedValue(new Error('歌单腿挂'))
    await nav.handleQQSongSearch('x')
    expect(nav.searchSongResults.value).toHaveLength(1)
    expect(nav.searchResults.value).toEqual([])

    musicApi.searchQQSongs.mockRejectedValue(new Error('单曲腿挂'))
    await nav.handleQQSongSearch('x')
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('QQ 音乐搜索失败'), 'error')
  })

  it('loadMoreSearchSongs：QQ 走页码游标 p=N+1 并按 id 去重追加', async () => {
    const { nav } = makeNav()
    await nav.handleQQSongSearch('周杰伦')
    // 深挖第 2 页：一页新歌 + 一页重复（上游漂移重叠须去重）
    musicApi.searchQQSongs.mockResolvedValueOnce({
      songs: [T('003CCCccc00003'), T('001AAAaaa00001')], total: 600,
    })
    await nav.loadMoreSearchSongs()
    expect(musicApi.searchQQSongs).toHaveBeenLastCalledWith('周杰伦', { limit: 20, page: 2 })
    expect(nav.searchSongResults.value.map(s => s.id))
      .toEqual(['qq_001AAAaaa00001', 'qq_003CCCccc00003'])

    musicApi.searchQQSongs.mockResolvedValueOnce({ songs: [T('004DDDddd00004')], total: 600 })
    await nav.loadMoreSearchSongs()
    expect(musicApi.searchQQSongs).toHaveBeenLastCalledWith('周杰伦', { limit: 20, page: 3 })
  })

  it('loadMoreSearchSongs：QQ 空页回包 → 深挖灭键（total 收口到已载数）', async () => {
    const { nav } = makeNav()
    await nav.handleQQSongSearch('周杰伦')
    musicApi.searchQQSongs.mockResolvedValueOnce({ songs: [], total: 600 })
    await nav.loadMoreSearchSongs()
    expect(nav.searchSongTotal.value).toBe(1) // 零进展灭键
    musicApi.searchQQSongs.mockClear()
    await nav.loadMoreSearchSongs()
    expect(musicApi.searchQQSongs).not.toHaveBeenCalled() // results>=total 直接短路
  })

  it('loadMoreSearchSongs：网易云口径仍走 offset——QQ 游标互不误用', async () => {
    const { nav } = makeNav()
    musicApi.searchSongsPage.mockResolvedValue({ songs: [{ id: 7 }], total: 61 })
    await nav.handlePlaylistSearch('x')
    expect(nav.searchSongTotal.value).toBe(61)
    await nav.loadMoreSearchSongs()
    expect(musicApi.searchSongsPage).toHaveBeenLastCalledWith('x', { limit: 20, offset: 1 })
    expect(musicApi.searchQQSongs).not.toHaveBeenCalled()
  })
})

describe('useSearchNav：QQ 歌单卡打开（导入链）', () => {
  it('provider=qq 卡 → getQQPlaylist 拉全量 → 幂等壳入库+落盘+选中', async () => {
    const { nav, deps } = makeNav()
    await nav.openSearchPlaylist(CARD)

    expect(musicApi.getQQPlaylist).toHaveBeenCalledWith('7097197259')
    expect(deps.userPlaylists.value[0].id).toBe('local_pl_qq_7097197259')
    expect(deps.userPlaylists.value[0].isLocal).toBe(true)
    expect(deps.userPlaylists.value[0].tracks.map(t => t.id)).toEqual(['qq_002BBBbbb00002'])
    expect(deps.selectPlaylist).toHaveBeenCalled()
    expect(deps.selectedPlaylist.value?.id).toBe('local_pl_qq_7097197259')
    // M2：落盘收口委托注入的 savePlaylistsToStorage——不再走本地第二实现
    expect(deps.savePlaylistsToStorage).toHaveBeenCalled()
    const stored = JSON.parse(localStorage.getItem(LS_KEYS.PLAYLISTS))
    expect(stored[0].id).toBe('local_pl_qq_7097197259')
    expect(stored[0].tracks[0].id).toBe('qq_002BBBbbb00002')
  })

  it('幂等壳原地刷新：同名壳已存在时不复制第二份、本地追加保尾', async () => {
    const { nav, deps } = makeNav()
    deps.userPlaylists.value = [{
      id: 'local_pl_qq_7097197259', name: '旧名', creator: { nickname: 'x' },
      isLocal: true, tracks: [{ id: 'local_keep', name: '本地追加' }], trackCount: 1,
    }]
    await nav.openSearchPlaylist(CARD)
    expect(deps.userPlaylists.value).toHaveLength(1)
    const pl = deps.userPlaylists.value[0]
    expect(pl.name).toBe('催专累了') // 元信息被远端刷新
    // applyTrackOrder 语义：旧成员（本地追加）各回其序位，远端新集落尾——
    // 重导入不抹用户排布（与 useExternalImport.upsertImportedShell 同款）
    expect(pl.tracks.map(t => t.id)).toEqual(['local_keep', 'qq_002BBBbbb00002'])
    expect(pl.trackCount).toBe(2)
  })

  it('导入成功 toast 透出词源匹配数——与 importProviderPlaylist 同口径', async () => {
    const { nav } = makeNav()
    musicApi.getQQPlaylist.mockResolvedValue({
      name: '催专累了', creator: 'x', cover: '', desc: '',
      tracks: [T('003EEEeee00003'), T('004FFFfff00004')],
      truncated: true, matchedCount: 2,
    })
    await nav.openSearchPlaylist(CARD)
    expect(toast).toHaveBeenCalledWith(
      '已导入 QQ 歌单「催专累了」（2 首，词源匹配 2，超出上限部分未导入）', 'success', 6000)
  })

  it('壳封面：data.cover 经 httpsCover 升格（https 页注入断言），缺席落卡面封面', async () => {
    // httpsCover 仅 https 页升级——openQqPlaylistCard 真走 selectPlaylistAndShow
    // →pushNavState→buildNavUrl 读 window.location.href，桩 location 必须
    // 带可读 href（缺 href 会在 new URL 炸掉，把成功路径误收进 catch）
    vi.stubGlobal('location', { protocol: 'https:', href: window.location.href })
    try {
      musicApi.getQQPlaylist.mockResolvedValue({
        name: 'x', creator: 'x', cover: 'http://y.gtimg.cn/pl.jpg', tracks: [T('005GGGggg00005')],
      })
      const { nav, deps } = makeNav()
      await nav.openSearchPlaylist(CARD)
      expect(deps.userPlaylists.value[0].coverImgUrl).toBe('https://y.gtimg.cn/pl.jpg')

      // data.cover 缺席/空串：落卡面 coverImgUrl（兜底链不动）
      deps.userPlaylists.value = []
      musicApi.getQQPlaylist.mockResolvedValue({
        name: 'x', creator: 'x', cover: '', tracks: [T('005GGGggg00005')],
      })
      await nav.openSearchPlaylist({ ...CARD, coverImgUrl: 'http://card/c.jpg' })
      expect(deps.userPlaylists.value[0].coverImgUrl).toBe('http://card/c.jpg')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('导入成功 + 明确未登录 → Cookie 引导 toast（与成功 toast 叠放同发）', async () => {
    qqLoggedIn.mockResolvedValue(false)
    const { nav } = makeNav()
    await nav.openSearchPlaylist(CARD)
    // 与 importQQPlaylist 同政策：成功 toast 与引导 info 叠放是既有观感
    expect(toast).toHaveBeenCalledWith(
      '已导入 QQ 歌单「催专累了」（1 首）', 'success', 6000)
    expect(toast).toHaveBeenCalledWith(
      expect.stringContaining('未配置 QQ Cookie'), 'info', 8000)
  })

  it('已登录/态未知/导入失败不发引导——按真成功门控', async () => {
    const { nav } = makeNav()
    qqLoggedIn.mockResolvedValue(true)
    await nav.openSearchPlaylist(CARD)
    expect(toast).not.toHaveBeenCalledWith(expect.stringContaining('Cookie'), 'info', 8000)

    qqLoggedIn.mockResolvedValue(null) // 探测失败按「可能有」——不谎报配置指引
    await nav.openSearchPlaylist(CARD)
    expect(toast).not.toHaveBeenCalledWith(expect.stringContaining('Cookie'), 'info', 8000)

    qqLoggedIn.mockResolvedValue(false) // 明确未登录但导入失败——壳未落地不发
    musicApi.getQQPlaylist.mockRejectedValueOnce(new Error('上游挂'))
    await nav.openSearchPlaylist(CARD)
    expect(toast).not.toHaveBeenCalledWith(expect.stringContaining('Cookie'), 'info', 8000)
  })

  it('非 qq 卡走原 selectPlaylist 路径——不打 QQ 接口', async () => {
    const { nav, deps } = makeNav()
    const neteaseCard = { id: 12345, name: '网易单', provider: undefined }
    await nav.openSearchPlaylist(neteaseCard)
    expect(musicApi.getQQPlaylist).not.toHaveBeenCalled()
    expect(deps.selectPlaylist).toHaveBeenCalledWith(neteaseCard)
  })

  it('disstid 脏数据不烧上游；拉取失败 toast 且不入库', async () => {
    const { nav, deps } = makeNav()
    await nav.openSearchPlaylist({ provider: 'qq', disstid: 'abc!!' })
    expect(musicApi.getQQPlaylist).not.toHaveBeenCalled()

    musicApi.getQQPlaylist.mockRejectedValue(new Error('上游挂'))
    await nav.openSearchPlaylist(CARD)
    expect(deps.userPlaylists.value).toHaveLength(0)
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('QQ 歌单导入失败'), 'error', 5000)
  })
})

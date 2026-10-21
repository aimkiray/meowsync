// 顶栏单曲/单视频链接「结果行化」钉板（vitest+jsdom，musicApi/http/feedback 全 mock）：
//   useSearchNav.showSingleResult — resolve 曲目落搜索视图单行结果：
//     立案段与四搜索 handler 同构（centerView/search 闸/双区清理/源戳/立案词），
//     total=1 深挖键天然灭；压死在途关键词搜索——迟到回包不盖本结果
//   useExternalImport — opts.asResult：不建 single_song_ 壳、不自动播、不
//     enterWatch；缺省（分享链 ?song=/?bili=/?yt=/?qq=）走原壳+即播契约；
//     favlist/歌单输入带 asResult 仍走收藏夹/歌单导入；
//     select 闸 invalidate 代收 loadingSongs（被顶选单的 finally 闸失配不自收）
//   App.vue 接线 — TopNav 四事件（search-song/search-bili/search-yt/search-qq）
//     带 {asResult:true}；分享链段不带 flag 回归由缺省路径用例兜底
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, nextTick } from 'vue'

const { musicApi, toast } = vi.hoisted(() => ({
  musicApi: {
    resolveYouTube: vi.fn(),
    resolveBilibili: vi.fn(),
    resolveQQ: vi.fn(),
    getSongDetail: vi.fn(),
    getSongsDetail: vi.fn(async () => []),
    getPlaylistDetail: vi.fn(async () => null),
    getQQPlaylist: vi.fn(async () => ({ tracks: [] })),
    getBiliFavlist: vi.fn(async () => ({ tracks: [] })),
    getYouTubePlaylist: vi.fn(async () => ({ tracks: [] })),
    getQqStatus: vi.fn(async () => null),
    retryMatch: vi.fn(async () => null),
    searchSongs: vi.fn(async () => []),
    searchSongsPage: vi.fn(async () => ({ songs: [], total: 0 })),
    searchPlaylists: vi.fn(async () => ({ playlists: [] })),
    searchQQSongs: vi.fn(async () => ({ songs: [], total: 0 })),
    searchQQPlaylists: vi.fn(async () => ({ playlists: [] })),
    searchYouTubeSongs: vi.fn(async () => ({ items: [], continuation: null })),
    searchBiliSongs: vi.fn(async () => ({ items: [] })),
    bilibiliStreamUrl: vi.fn(() => 'https://x/bili'),
    youtubeStreamUrl: vi.fn(() => 'https://x/yt'),
  },
  toast: vi.fn(() => 1),
}))
vi.mock('../../src/api/music.js', () => ({
  musicApi,
  // useExternalImport 导入后引导消费的惰性单飞——缺省 null=「态未知」不触发
  qqLoggedIn: vi.fn(async () => null),
}))
vi.mock('../../src/api/auth.js', () => ({
  authApi: {
    status: vi.fn(async () => ({ data: {} })),
    logout: vi.fn(async () => ({})),
    me: vi.fn(async () => ({ data: null })),
  },
}))
vi.mock('../../src/api/downloads.js', () => ({
  downloadsApi: {
    removeLocalMirror: vi.fn(async () => ({})),
    mirrorLocalPlaylist: vi.fn(async () => ({})),
    quickDownloadPlaylist: vi.fn(async () => ({})),
    deletePlaylistDownloads: vi.fn(async () => ({})),
    listTasks: vi.fn(async () => ({ data: [] })),
    getSongDownloadStatus: vi.fn(async () => null),
    songFileUrl: vi.fn(() => 'http://api/dl'),
  },
}))
vi.mock('../../src/api/http.js', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
  API_BASE_URL: 'http://api.test',
  apiErrorMessage: (e, fb) => e?.message || fb || '接口异常',
}))
vi.mock('../../src/api/sync.js', () => ({
  syncApi: { pull: vi.fn(async () => ({ code: 200, items: [] })), push: vi.fn() },
}))
vi.mock('../../src/api/ai.js', () => ({
  aiApi: {
    status: vi.fn(async () => ({ enabled: false })),
    translateLyric: vi.fn(async () => null),
    verifyLyric: vi.fn(async () => ({ ok: true })),
  },
}))
vi.mock('../../src/api/uploads.js', () => ({
  uploadFile: vi.fn(),
  deleteUploadedSong: vi.fn(async () => ({})),
}))
vi.mock('howler', () => ({
  Howl: class {},
  Howler: { html5PoolSize: 0, volume: vi.fn(), mute: vi.fn() },
}))
vi.mock('../../src/lib/feedback.js', () => ({
  toast, toastDismiss: vi.fn(), toastHold: vi.fn(), toastRelease: vi.fn(),
  pixelConfirm: vi.fn(async () => false), isConfirmOpen: vi.fn(() => false),
  resolveConfirm: vi.fn(),
  useFeedbackState: vi.fn(() => ({ toasts: [], confirm: null })),
}))

import { mount, shallowMount } from '@vue/test-utils'
import { toastDismiss } from '../../src/lib/feedback.js'
import { createReqGate } from '../../src/lib/req-gate.js'
import { useSearchNav } from '../../src/composables/useSearchNav.js'
import { useExternalImport } from '../../src/composables/useExternalImport.js'
import { authState } from '../../src/lib/auth-state.js'
import { resetSyncState } from '../../src/lib/sync.js'
import App from '../../src/App.vue'
import TopNavigation from '../../src/components/TopNavigation.vue'

// jsdom 无 matchMedia——TopNav/App 挂载期裸调（nav-search-ui 同款补丁）
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
}

// App 的 useSearchNav→useExternalImport 注入拓扑（同闸同 ref，惰性转发同款）
const makeStack = (over = {}) => {
  const gates = {
    select: createReqGate(), preview: createReqGate(), search: createReqGate(),
    mediaImport: createReqGate(), picker: createReqGate(),
  }
  const deps = {
    searchQuery: ref(''), currentSong: ref(null), watchTab: ref('queue'),
    isFullscreenPlayerOpen: ref(false),
    userPlaylists: ref([]), selectedPlaylist: ref(null), songs: ref([]),
    loadingSongs: ref(false),
    selectPlaylist: vi.fn(async () => true),
    savePlaylistsToStorage: vi.fn(),
    playSong: vi.fn(async () => {}), playSongFromSearch: vi.fn(),
    playSongFromRelated: vi.fn(), playPlaylist: vi.fn(),
    enterWatch: vi.fn(), selectPlaylistAndShow: vi.fn(async () => {}),
    ...over,
  }
  const nav = useSearchNav({
    gates,
    searchQuery: deps.searchQuery, currentSong: deps.currentSong,
    watchTab: deps.watchTab, isFullscreenPlayerOpen: deps.isFullscreenPlayerOpen,
    userPlaylists: deps.userPlaylists, selectedPlaylist: deps.selectedPlaylist,
    loadingSongs: deps.loadingSongs, selectPlaylist: deps.selectPlaylist,
    savePlaylistsToStorage: deps.savePlaylistsToStorage,
    playSong: deps.playSong, playSongFromSearch: deps.playSongFromSearch,
    playSongFromRelated: deps.playSongFromRelated, playPlaylist: deps.playPlaylist,
  })
  const imp = useExternalImport({
    gates,
    userPlaylists: deps.userPlaylists, selectedPlaylist: deps.selectedPlaylist,
    songs: deps.songs, loadingSongs: deps.loadingSongs,
    savePlaylistsToStorage: deps.savePlaylistsToStorage,
    searchQuery: deps.searchQuery, currentSong: deps.currentSong,
    playSong: deps.playSong, enterWatch: deps.enterWatch,
    selectPlaylistAndShow: deps.selectPlaylistAndShow,
    showSingleResult: (s, src) => nav.showSingleResult(s, src),
  })
  return { nav, imp, deps, gates }
}

const YT_RESOLVE = (over = {}) => ({
  videoId: 'abcdefghijk', title: 'EMA - 乐园(粤)', author: 'EMA',
  authorClean: 'EMA', duration: 210,
  cover: 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg',
  songName: '乐园', hasVideo: true, matched: null,
  ...over,
})
const BV_RESOLVE = (over = {}) => ({
  bvid: 'BV1xx411c7XE', title: '【UP主】翻唱 乐园', owner: 'UP主',
  cover: 'http://i0.hdslb.com/bfs/cover.jpg', duration: 200,
  songName: '乐园', page: 1, matched: null,
  ...over,
})
const QQ_RESOLVE = (over = {}) => ({
  mid: 'mid1234abc', name: 'Q歌', artists: ['Q艺人'], album: 'Q专',
  cover: 'http://q/c.jpg', duration: 100, matched: null,
  ...over,
})
const NE_DETAIL = {
  id: 555, name: '网曲', ar: [{ name: 'N艺人' }],
  al: { name: '网专', picUrl: '' }, dt: 200000,
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  toast.mockReturnValue(1)
  window.history.replaceState(null, '', '/')
})
afterEach(() => {
  window.history.replaceState(null, '', '/')
  document.body.innerHTML = ''
})

// ═══ useSearchNav.showSingleResult ═══
describe('useSearchNav：showSingleResult 单行结果立案', () => {
  it('落搜索视图单行：结果区/立案词/源戳/total=1 立案，深挖键天然灭', () => {
    const { nav } = makeStack()
    const song = { id: 'yt_a1', name: '落地曲', ar: [{ name: 'a' }], al: {}, dt: 1 }
    nav.showSingleResult(song, 'yt')
    expect(nav.centerView.value).toBe('search')
    expect(nav.searchSongResults.value).toEqual([song]) // 恰一行
    expect(nav.searchResults.value).toEqual([])         // 歌单腿区清空
    expect(nav.searchSongQuery.value).toBe('落地曲')     // 立案词=曲名
    expect(nav.searchSongTotal.value).toBe(1)
    expect(nav.searchSongHasMore.value).toBe(false)     // len==total 深挖灭
    expect(nav.ytContinuation.value).toBeNull()
    expect(nav.searchSource.value).toBe('yt')
    expect(nav.searching.value).toBe(false)
    // search 视图可寻址——pushNavState 落 ?view=search
    expect(window.location.search).toContain('view=search')
  })

  it('各源戳透传口径与四 handler 同词表（netease/qq/yt/bili）', () => {
    const { nav } = makeStack()
    const song = { id: 1, name: 'x', ar: [], al: {}, dt: 1 }
    for (const src of ['netease', 'qq', 'yt', 'bili']) {
      nav.showSingleResult(song, src)
      expect(nav.searchSource.value).toBe(src)
    }
  })

  it('立案时压死在途关键词搜索——迟到回包不盖结果行', async () => {
    let resolveSearch
    musicApi.searchYouTubeSongs.mockImplementationOnce(
      () => new Promise(r => { resolveSearch = r }))
    const { nav } = makeStack()
    const pending = nav.handleYTSongSearch('lofi')
    expect(nav.searching.value).toBe(true)

    const song = { id: 'yt_a1', name: '落地曲', ar: [], al: {}, dt: 1 }
    nav.showSingleResult(song, 'yt')
    expect(nav.searching.value).toBe(false) // 被顶搜索的 finally 闸失配不复位，这里代收
    expect(nav.searchSongResults.value).toEqual([song])

    resolveSearch({ items: [{ videoId: 'zzzzzzzzzzz', title: '迟到' }], continuation: 'tok' })
    await pending
    // search 闸已换代：旧批结果与游标都不得落地
    expect(nav.searchSongResults.value).toEqual([song])
    expect(nav.ytContinuation.value).toBeNull()
    expect(nav.searching.value).toBe(false)
  })

  it('立案压死在途 loadMoreSearchSongs——迟到深挖页不得拼上单行结果', async () => {
    let resolveMore
    musicApi.searchSongsPage.mockImplementationOnce(
      () => new Promise(r => { resolveMore = r }))
    const { nav } = makeStack()
    // 造「可深挖结果集」立案态（等价于搜完词、total 未到顶）——立案词/total/
    // 结果区都是立案位，直接写与走 handler 同效
    nav.searchSongQuery.value = '旧词'
    nav.searchSongTotal.value = 50
    nav.searchSongResults.value = [{ id: 1, name: '已有行', ar: [], al: {}, dt: 1 }]
    const pending = nav.loadMoreSearchSongs()
    expect(nav.searchSongLoadingMore.value).toBe(true)

    const song = { id: 'bv_x', name: '落地曲', ar: [], al: {}, dt: 1 }
    nav.showSingleResult(song, 'bili')

    resolveMore({ songs: [{ id: 2, name: '迟到曲', ar: [], al: {}, dt: 1 }], total: 50 })
    await pending
    // query 快照 + search 闸双守卫都失配——迟到页不得落地
    expect(nav.searchSongResults.value).toEqual([song])
    expect(nav.searchSongLoadingMore.value).toBe(false) // finally 复位不带闸
  })
})

// ═══ useExternalImport：opts.asResult ═══
describe('useExternalImport：asResult 单行结果路径', () => {
  it('importYouTubeOrPlaylist + asResult → yt 戳单行；不建壳/不自动播/不进 watch', async () => {
    musicApi.resolveYouTube.mockResolvedValue(YT_RESOLVE())
    const { nav, imp, deps } = makeStack()
    deps.searchQuery.value = 'https://youtu.be/abcdefghijk'
    await imp.importYouTubeOrPlaylist('https://youtu.be/abcdefghijk', { asResult: true })
    expect(musicApi.resolveYouTube).toHaveBeenCalledWith('https://youtu.be/abcdefghijk')
    expect(nav.searchSongResults.value.map(s => s.id)).toEqual(['yt_abcdefghijk'])
    expect(nav.searchSource.value).toBe('yt')
    expect(nav.centerView.value).toBe('search')
    expect(deps.userPlaylists.value).toEqual([])          // 无 single_song_ 壳
    expect(deps.selectedPlaylist.value).toBeNull()
    expect(deps.currentSong.value).toBeNull()
    expect(deps.songs.value).toEqual([])
    expect(deps.playSong).not.toHaveBeenCalled()
    expect(deps.enterWatch).not.toHaveBeenCalled()
    expect(deps.searchQuery.value).toBe('')               // 立案清框照旧
  })

  it('importBilibiliOrFav 单曲链 + asResult → bili 戳单行', async () => {
    musicApi.resolveBilibili.mockResolvedValue(BV_RESOLVE())
    const { nav, imp } = makeStack()
    await imp.importBilibiliOrFav('https://www.bilibili.com/video/BV1xx411c7XE', { asResult: true })
    expect(nav.searchSongResults.value.map(s => s.id)).toEqual(['bv_BV1xx411c7XE'])
    expect(nav.searchSource.value).toBe('bili')
  })

  it('importQQ + asResult → qq 戳单行', async () => {
    musicApi.resolveQQ.mockResolvedValue(QQ_RESOLVE())
    const { nav, imp } = makeStack()
    await imp.importQQ('https://y.qq.com/n/ryqq/song/mid1234abc.html', { asResult: true })
    expect(nav.searchSongResults.value.map(s => s.id)).toEqual(['qq_mid1234abc'])
    expect(nav.searchSource.value).toBe('qq')
  })

  it('qq: 前缀裸 mid + asResult → 载荷原样送 resolve，落 qq 单行', async () => {
    musicApi.resolveQQ.mockResolvedValue(QQ_RESOLVE())
    const { nav, imp } = makeStack()
    // TopNav qq: 前缀内 isSongmidLike 命中 → emit('search-qq', `qq:${mid}`) 同款载荷
    await imp.importQQ('qq:mid1234abc', { asResult: true })
    expect(musicApi.resolveQQ).toHaveBeenCalledWith('qq:mid1234abc')
    expect(nav.searchSongResults.value.map(s => s.id)).toEqual(['qq_mid1234abc'])
    expect(nav.searchSource.value).toBe('qq')
  })

  it('importNeteaseSongById + asResult → netease 戳单行；既有历史壳不被消费', async () => {
    musicApi.getSongDetail.mockResolvedValue(NE_DETAIL)
    const { nav, imp, deps } = makeStack()
    // 库里留存量壳：asResult 路径不查/不建/不选中它
    const staleShell = { id: 'single_song_555', name: '旧壳', trackCount: 1, tracks: [NE_DETAIL] }
    deps.userPlaylists.value.push(staleShell)
    await imp.importNeteaseSongById('555', { asResult: true })
    expect(musicApi.getSongDetail).toHaveBeenCalledTimes(1)
    expect(nav.searchSongResults.value).toEqual([NE_DETAIL])
    expect(nav.searchSource.value).toBe('netease')
    expect(nav.searchSongQuery.value).toBe('网曲')
    expect(deps.userPlaylists.value).toEqual([staleShell]) // 壳原样留存
    expect(deps.selectedPlaylist.value).toBeNull()         // 不选中旧壳
    expect(deps.playSong).not.toHaveBeenCalled()
    expect(deps.enterWatch).not.toHaveBeenCalled()
  })

  it('选单在途时粘单曲链 → loadingSongs 被代收归 false（被顶 select 不自收）', async () => {
    musicApi.getSongDetail.mockResolvedValue(NE_DETAIL)
    const { imp, deps, gates } = makeStack()
    // 在途 selectPlaylist 的行为级等价：已 claim 且 loading 置起、回包未落
    const staleSelect = gates.select.claim()
    deps.loadingSongs.value = true
    await imp.importNeteaseSongById('555', { asResult: true })
    // select 闸已换代——被顶请求的 finally 闸失配不会复位 loading，
    // import 侧必须代收（漏收则 flag 永挂，歌曲区停在转圈态）
    expect(gates.select.isCurrent(staleSelect)).toBe(false)
    expect(deps.loadingSongs.value).toBe(false)
  })

  it('asResult 期间 mediaImport 闸被顶 → resolve 迟到不落结果行', async () => {
    let resolveIt
    musicApi.resolveYouTube.mockImplementationOnce(
      () => new Promise(r => { resolveIt = r }))
    const { nav, imp, gates } = makeStack()
    const p = imp.importYouTubeOrPlaylist('https://youtu.be/abcdefghijk', { asResult: true })
    gates.mediaImport.invalidate() // 用户在途做了别的——本次导入过期
    resolveIt(YT_RESOLVE())
    await p
    expect(nav.searchSongResults.value).toEqual([])
    // isCurrent 早退在 showSingleResult 之前——搜索视图从未立案
    expect(nav.centerView.value).toBe('home')
  })

  it('B 站收藏夹输入带 asResult → 仍走收藏夹导入（歌单语义不变）', async () => {
    musicApi.getBiliFavlist.mockResolvedValue({
      fid: '456789', name: '收藏夹', cover: '', creator: 'UP',
      tracks: [{ bvid: 'BV1xx411c7XE', title: 't', owner: 'o', cover: '', duration: 10 }],
    })
    const { nav, imp, deps } = makeStack()
    await imp.importBilibiliOrFav(
      'https://space.bilibili.com/123/favlist?fid=456789', { asResult: true })
    expect(musicApi.getBiliFavlist).toHaveBeenCalled()
    expect(musicApi.resolveBilibili).not.toHaveBeenCalled()
    expect(nav.searchSongResults.value).toEqual([]) // 不落结果行
    expect(deps.userPlaylists.value.map(p => p.id)).toEqual(['local_pl_bili_456789'])
    expect(deps.selectPlaylistAndShow).toHaveBeenCalled()
  })

  it('YouTube 歌单输入带 asResult → 仍走歌单导入', async () => {
    musicApi.getYouTubePlaylist.mockResolvedValue({
      listId: 'PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf', name: '单', cover: '', creator: 'ch',
      tracks: [YT_RESOLVE()],
    })
    const { nav, imp, deps } = makeStack()
    await imp.importYouTubeOrPlaylist(
      'https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf',
      { asResult: true })
    expect(musicApi.getYouTubePlaylist).toHaveBeenCalled()
    expect(musicApi.resolveYouTube).not.toHaveBeenCalled()
    expect(nav.searchSongResults.value).toEqual([])
    expect(deps.userPlaylists.value.map(p => p.id)).toEqual(['local_pl_yt_PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf'])
  })

  it('进度 toast 终态回收不因 asResult 分支 return 泄漏', async () => {
    musicApi.resolveYouTube.mockResolvedValue(YT_RESOLVE())
    const { imp } = makeStack()
    await imp.importYouTubeOrPlaylist('https://youtu.be/abcdefghijk', { asResult: true })
    const idx = toast.mock.calls.findIndex(c => String(c[0]).includes('正在解析'))
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(toastDismiss).toHaveBeenCalledWith(toast.mock.results[idx].value)
  })
})

describe('useExternalImport：缺省路径回归（分享契约不变）', () => {
  it('importYouTubeOrPlaylist 无 flag → 幂等壳入库 + 自动播 + enterWatch', async () => {
    musicApi.resolveYouTube.mockResolvedValue(YT_RESOLVE())
    const { imp, deps } = makeStack()
    await imp.importYouTubeOrPlaylist('https://youtu.be/abcdefghijk')
    const shell = deps.userPlaylists.value.find(p => p.id === 'single_song_yt_abcdefghijk')
    expect(shell).toBeTruthy()
    expect(shell.tracks.map(t => t.id)).toEqual(['yt_abcdefghijk'])
    expect(deps.selectedPlaylist.value).toBe(shell)
    expect(deps.currentSong.value?.id).toBe('yt_abcdefghijk')
    expect(deps.playSong).toHaveBeenCalled()
    expect(deps.enterWatch).toHaveBeenCalled()
  })

  it('importNeteaseSongById 无 flag → single_song_ 壳 + 自动播 + enterWatch', async () => {
    musicApi.getSongDetail.mockResolvedValue(NE_DETAIL)
    const { imp, deps } = makeStack()
    await imp.importNeteaseSongById('555')
    const shell = deps.userPlaylists.value.find(p => p.id === 'single_song_555')
    expect(shell).toBeTruthy()
    expect(deps.selectedPlaylist.value).toBe(shell)
    expect(deps.playSong).toHaveBeenCalledWith(NE_DETAIL)
    expect(deps.enterWatch).toHaveBeenCalled()
  })

  it('无 flag 路径同样代收 loadingSongs（invalidate 在 asResult 分支之前的共享头）', async () => {
    musicApi.getSongDetail.mockResolvedValue(NE_DETAIL)
    const { imp, deps, gates } = makeStack()
    const staleSelect = gates.select.claim()
    deps.loadingSongs.value = true
    await imp.importNeteaseSongById('555')
    expect(gates.select.isCurrent(staleSelect)).toBe(false)
    expect(deps.loadingSongs.value).toBe(false)
  })
})

// ═══ App.vue 接线：TopNav 事件带 asResult flag ═══
const resetAuthState = () => {
  authState.booted = false
  authState.enabled = false
  authState.setupRequired = false
  authState.authenticated = false
  authState.username = null
  authState.expired = false
  authState.setupDismissed = false
}
let wrapper = null
const mountApp = async () => {
  wrapper = shallowMount(App)
  await vi.waitFor(() => expect(authState.booted).toBe(true))
  await nextTick()
  return wrapper
}
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  resetSyncState()
  resetAuthState()
})

describe('App.vue：顶栏链接导入 → 单行结果接线', () => {
  beforeEach(() => { resetAuthState() })

  it('search-song → getSongDetail → netease 单行结果（不建壳不自动播）', async () => {
    musicApi.getSongDetail.mockResolvedValue(NE_DETAIL)
    await mountApp()
    await wrapper.findComponent(TopNavigation).vm.$emit('search-song', '555')
    await vi.waitFor(() => expect(wrapper.vm.searchSongResults.length).toBe(1))
    expect(musicApi.getSongDetail).toHaveBeenCalledWith('555')
    expect(wrapper.vm.centerView).toBe('search')
    expect(wrapper.vm.searchSource).toBe('netease')
    expect(wrapper.vm.searchSongQuery).toBe('网曲')
    expect(wrapper.vm.userPlaylists.some(p => String(p.id).startsWith('single_song_'))).toBe(false)
    expect(wrapper.vm.currentSong).toBeNull()
  })

  it('search-bili 视频链 → bili 单行结果', async () => {
    musicApi.resolveBilibili.mockResolvedValue(BV_RESOLVE())
    await mountApp()
    await wrapper.findComponent(TopNavigation).vm.$emit(
      'search-bili', 'https://www.bilibili.com/video/BV1xx411c7XE')
    await vi.waitFor(() => expect(wrapper.vm.searchSongResults.length).toBe(1))
    expect(wrapper.vm.searchSongResults[0].id).toBe('bv_BV1xx411c7XE')
    expect(wrapper.vm.searchSource).toBe('bili')
    expect(wrapper.vm.userPlaylists.some(p => String(p.id).startsWith('single_song_'))).toBe(false)
    expect(wrapper.vm.currentSong).toBeNull()
  })

  it('search-yt 视频链 → yt 单行结果', async () => {
    musicApi.resolveYouTube.mockResolvedValue(YT_RESOLVE())
    await mountApp()
    await wrapper.findComponent(TopNavigation).vm.$emit('search-yt', 'https://youtu.be/abcdefghijk')
    await vi.waitFor(() => expect(wrapper.vm.searchSongResults.length).toBe(1))
    expect(wrapper.vm.searchSongResults[0].id).toBe('yt_abcdefghijk')
    expect(wrapper.vm.searchSource).toBe('yt')
    expect(wrapper.vm.currentSong).toBeNull()
  })

  it('search-qq 单曲链 → qq 单行结果', async () => {
    musicApi.resolveQQ.mockResolvedValue(QQ_RESOLVE())
    await mountApp()
    await wrapper.findComponent(TopNavigation).vm.$emit(
      'search-qq', 'https://y.qq.com/n/ryqq/song/mid1234abc.html')
    await vi.waitFor(() => expect(wrapper.vm.searchSongResults.length).toBe(1))
    expect(wrapper.vm.searchSongResults[0].id).toBe('qq_mid1234abc')
    expect(wrapper.vm.searchSource).toBe('qq')
  })

  it('search-bili 收藏夹链 → asResult 不拦歌单分支：仍走收藏夹导入', async () => {
    musicApi.getBiliFavlist.mockResolvedValue({
      fid: '456789', name: '收藏夹', cover: '', creator: 'UP',
      tracks: [{ bvid: 'BV1xx411c7XE', title: 't', owner: 'o', cover: '', duration: 10 }],
    })
    await mountApp()
    await wrapper.findComponent(TopNavigation).vm.$emit(
      'search-bili', 'https://space.bilibili.com/123/favlist?fid=456789')
    await vi.waitFor(() =>
      expect(wrapper.vm.userPlaylists.some(p => p.id === 'local_pl_bili_456789')).toBe(true))
    expect(musicApi.getBiliFavlist).toHaveBeenCalled()
    expect(musicApi.resolveBilibili).not.toHaveBeenCalled()
    expect(wrapper.vm.centerView).toBe('songs') // 歌单导入照旧选中落壳
  })
})

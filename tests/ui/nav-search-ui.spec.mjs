// 「导航与多源搜索域」UI 修复钉板（vitest+jsdom）：
//   TopNavigation — pickSource 在搜索视图+有词时重发 handleSearch（裸词走
//                   'search' emit 由 App 按新偏好分派）；同源点选不重发；
//                   前缀词先剥壳再按裸词重搜；sidebarOpen 闸搜索键/openSearch；
//                   钮上源短标徽牌；⋯ 菜单 remote:off 双行中文指路
//   PlaylistGrid  — 页头「"词" · 源名」上下文行（立案词 searchSongQuery）；
//                   行内来源角标 chip；副行专辑名==歌名去重（NFKC 归一）；
//                   yt/bili 无歌单腿指路行；封面 alt="" + @error 按曲 id 落占位
//   useSearchNav  — searchSource/searchSongQuery 随 handler 立案定调
//   useAddToPlaylist — 裸关键词按 prefSearchSource 分派 qq/yt/bili/网易云
//   App.vue       — :is-search-view/:search-source/:watch-open 绑定透传；
//                   @open-watch → openWatchOrBack 双态（页内回退/页外开 tab）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick, ref } from 'vue'
import { mount, shallowMount } from '@vue/test-utils'

const { musicApi, toast } = vi.hoisted(() => ({
  musicApi: {
    // 建议/搜索/点歌台全端点立桩——本文件覆盖 TopNav 挂载、useSearchNav
    // 四 handler、useAddToPlaylist 分派与 App 集成四条消耗链
    searchSuggest: vi.fn(async () => ({ allMatch: [] })),
    searchQQSuggest: vi.fn(async () => ({ allMatch: [] })),
    getYouTubeSuggest: vi.fn(async () => ({ allMatch: [] })),
    getBiliSuggest: vi.fn(async () => ({ allMatch: [] })),
    searchSongs: vi.fn(async () => []),
    searchSongsPage: vi.fn(async () => ({ songs: [], total: 0 })),
    searchPlaylists: vi.fn(async () => ({ playlists: [] })),
    searchQQSongs: vi.fn(async () => ({ songs: [], total: 0 })),
    searchQQPlaylists: vi.fn(async () => ({ playlists: [] })),
    searchYouTubeSongs: vi.fn(async () => ({ items: [], continuation: null })),
    searchBiliSongs: vi.fn(async () => ({ items: [] })),
    resolveBilibili: vi.fn(async () => ({})),
    resolveYouTube: vi.fn(async () => ({})),
    resolveQQ: vi.fn(async () => ({})),
    getSongDetail: vi.fn(async () => ({})),
    getSongsDetail: vi.fn(async () => []),
    getPlaylistDetail: vi.fn(async () => null),
    getQqStatus: vi.fn(async () => null),
    retryMatch: vi.fn(async () => null),
    bilibiliStreamUrl: vi.fn(() => 'https://x/bili'),
    youtubeStreamUrl: vi.fn(() => 'https://x/yt'),
  },
  toast: vi.fn(() => 1),
}))
vi.mock('../../src/api/music.js', () => ({ musicApi }))
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

const { prefSearchSource } = await import('../../src/lib/prefs.js')
const { createReqGate } = await import('../../src/lib/req-gate.js')
const { useSearchNav } = await import('../../src/composables/useSearchNav.js')
const { useAddToPlaylist } = await import('../../src/composables/useAddToPlaylist.js')
const { authState } = await import('../../src/lib/auth-state.js')
const { resetSyncState } = await import('../../src/lib/sync.js')
const { default: TopNavigation } = await import('../../src/components/TopNavigation.vue')
const { default: PlaylistGrid } = await import('../../src/components/PlaylistGrid.vue')
const { default: BottomPlayer } = await import('../../src/components/BottomPlayer.vue')
const { default: App } = await import('../../src/App.vue')

// jsdom 无 matchMedia——TopNav/GlitchText 挂载期裸调（topnav-src-switch 同款补丁）
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
}
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {}
}

const mounted = []
const track = (w) => { mounted.push(w); return w }
const flush = async () => { await nextTick(); await new Promise(r => setTimeout(r, 0)); await nextTick() }

const resetAuthState = () => {
  authState.booted = false
  authState.enabled = false
  authState.setupRequired = false
  authState.authenticated = false
  authState.username = null
  authState.expired = false
  authState.setupDismissed = false
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  toast.mockReturnValue(1)
  prefSearchSource.value = 'netease'
  resetSyncState()
  resetAuthState()
})
afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  resetSyncState()
  resetAuthState()
  document.body.innerHTML = '' // teleport 到 body 的菜单不随 wrapper 清除
})

// ═══ TopNavigation：切源重搜 + 源短标 + remote 双行文案 ═══
const mountNav = async (props = {}) => {
  const w = mount(TopNavigation, {
    attachTo: document.body,
    props: { remoteMode: 'off', searchQuery: '', ...props },
    global: { stubs: { GlitchText: true, PixelIcon: true } },
  })
  await nextTick()
  return track(w)
}

describe('TopNavigation：pickSource 结果页重搜', () => {
  it('搜索视图+有词：切源 → pref 落定 + emit(search) 重发（App 按新偏好分派）', async () => {
    const w = await mountNav({ searchQuery: '周杰伦', isSearchView: true })
    w.vm.pickSource('qq')
    await nextTick()
    expect(prefSearchSource.value).toBe('qq')
    expect(w.emitted('search')).toEqual([['周杰伦', '周杰伦']])
    // 重发走了 handleSearch——清空链同步执行：建议面收拢
    expect(w.vm.suggestOpen).toBe(false)
  })

  it('非搜索视图：切源只改偏好不重发——不打扰 watch/歌单等当前屏', async () => {
    const w = await mountNav({ searchQuery: '周杰伦', isSearchView: false })
    w.vm.pickSource('yt')
    await nextTick()
    expect(prefSearchSource.value).toBe('yt')
    expect(w.emitted('search')).toBeUndefined()
    expect(w.emitted('search-yt-songs')).toBeUndefined()
  })

  it('词为空：搜索视图下也不重发（没搜过就无「重搜」语义）', async () => {
    const w = await mountNav({ searchQuery: '   ', isSearchView: true })
    w.vm.pickSource('bili')
    await nextTick()
    expect(prefSearchSource.value).toBe('bili')
    expect(w.emitted('search')).toBeUndefined()
  })

  it('缺省 prop（未接 is-search-view）不重发——向后兼容旧消费方', async () => {
    const w = await mountNav({ searchQuery: '周杰伦' })
    w.vm.pickSource('qq')
    await nextTick()
    expect(w.emitted('search')).toBeUndefined()
  })

  it('同源点选：pref 已是目标源 → 关菜单但不重发（同词同源重搜=空转烧上游）', async () => {
    prefSearchSource.value = 'qq'
    const w = await mountNav({ searchQuery: '晴天', isSearchView: true })
    w.vm.pickSource('qq')
    await nextTick()
    expect(prefSearchSource.value).toBe('qq')
    expect(w.emitted('search')).toBeUndefined()
    expect(w.emitted('search-qq-songs')).toBeUndefined()
  })

  it('前缀词切源：qq:晴天 结果页换 yt → 框词剥壳 + 裸词走 search 按新偏好分派，不回落旧源分支', async () => {
    prefSearchSource.value = 'qq'
    const w = await mountNav({ searchQuery: 'qq:晴天', isSearchView: true })
    w.vm.pickSource('yt')
    await nextTick()
    expect(prefSearchSource.value).toBe('yt')
    // 框词同步剥壳成裸词（v-model 上行），重搜按裸词发 'search'——
    // App 的 handleSearch 拿裸词按新偏好 yt 分派；若照旧走前缀分支
    // 会 emit('search-qq-songs','晴天') 拿旧源重搜=空转
    expect(w.emitted('update:searchQuery')).toEqual([['晴天']])
    expect(w.emitted('search')).toEqual([['晴天', '晴天']])
    expect(w.emitted('search-qq-songs')).toBeUndefined()
    // 清空链照走（剥壳重搜复用 handleSearch 的 cancelSuggest+closeSearch）
    expect(w.vm.suggestOpen).toBe(false)
    expect(w.vm.searchOpen).toBe(false)
  })

  it('空壳前缀（qq:）剥完无词：框词清空但不发搜索', async () => {
    prefSearchSource.value = 'qq'
    const w = await mountNav({ searchQuery: 'qq：', isSearchView: true }) // 全角冒号同口径
    w.vm.pickSource('yt')
    await nextTick()
    expect(w.emitted('update:searchQuery')).toEqual([['']])
    expect(w.emitted('search')).toBeUndefined()
  })
})

describe('TopNavigation：抽屉开着时搜索键禁用', () => {
  it('sidebarOpen=true → ≤768 搜索钮 disabled 且 openSearch 早退（遮罩盖住展开层，开了也看不见还偷焦点）', async () => {
    const w = await mountNav({ sidebarOpen: true })
    expect(w.find('.topnav-search-btn').attributes('disabled')).toBeDefined()
    w.vm.openSearch() // 程序路径同样被闸（/ 快捷键 → focusSearch → openSearch）
    await nextTick()
    expect(w.vm.searchOpen).toBe(false)
  })

  it('sidebarOpen=false 回归：钮可点、openSearch 正常展开', async () => {
    const w = await mountNav({ sidebarOpen: false })
    expect(w.find('.topnav-search-btn').attributes('disabled')).toBeUndefined()
    w.vm.openSearch()
    await nextTick()
    expect(w.vm.searchOpen).toBe(true)
  })
})

describe('TopNavigation：源短标徽牌', () => {
  it.each([
    ['netease', '163'], ['qq', 'QQ'], ['yt', 'YT'], ['bili', 'B站'],
  ])('源=%s → 徽牌 %s（title/aria-label 仍报全名）', async (src, short) => {
    prefSearchSource.value = src
    const w = await mountNav()
    const btn = w.find('.topnav-src-btn')
    expect(btn.find('.topnav-src-tag').text()).toBe(short)
    const nameMap = { netease: '网易云', qq: 'QQ 音乐', yt: 'YouTube', bili: 'Bilibili' }
    expect(btn.attributes('title')).toBe(`搜索源：${nameMap[src]}`)
    expect(btn.find('.topnav-src-tag').attributes('aria-hidden')).toBe('true')
  })
})

describe('TopNavigation：⋯ 菜单 remote 指路文案', () => {
  it('remote=off → 「远程控制 · 未启用」+「地址栏加 ?mode=host 启用」双行可见', async () => {
    const w = await mountNav({ remoteMode: 'off' })
    await w.find('.topnav-menu-btn').trigger('click')
    await nextTick()
    const block = document.querySelector('#topnav-menu .topnav-menu-remote')
    expect(block).toBeTruthy()
    expect(block.textContent).toContain('远程控制 · 未启用')
    expect(block.textContent).toContain('?mode=host')
    expect(block.querySelector('.topnav-menu-remote-note')).toBeTruthy()
  })

  it('remote=host → 「控制器」外链项，不出未启用提示块', async () => {
    const w = await mountNav({ remoteMode: 'host' })
    await w.find('.topnav-menu-btn').trigger('click')
    await nextTick()
    expect(document.querySelector('.topnav-menu-remote')).toBeNull()
    expect(document.querySelector('#topnav-menu .pg-menu-item[href]')?.textContent).toContain('控制器')
  })
})

// ═══ PlaylistGrid ═══
const NE_SONG = { id: 777, name: '晴天花海', ar: [{ name: '艺人甲' }], al: { name: '花海专辑', picUrl: 'https://p1.music.126.net/x.jpg' }, dt: 200000 }
const YT_SONG = {
  id: 'yt_vid00000001', name: '曲-vid', ar: [{ name: '频道' }],
  al: { name: '', picUrl: 'https://i.ytimg.com/vi/vid00000001/hqdefault.jpg' },
  dt: 200000, youtube: { videoId: 'vid00000001' },
}
const BILI_SONG = {
  id: 'bv_BV1xx411c7XE', name: 'B曲', ar: [{ name: 'UP主' }],
  al: { name: '', picUrl: '' }, dt: 180000,
  bilibili: { bvid: 'BV1xx411c7XE' },
}
const QQ_SONG = {
  id: 'qq_mid123', name: 'Q曲', ar: [{ name: '歌手' }],
  al: { name: 'Q专', picUrl: '' }, dt: 190000,
  qq: { mid: 'mid123' },
}

const mountGrid = async (props = {}) => {
  const w = mount(PlaylistGrid, {
    attachTo: document.body,
    props: { results: [], songs: [], query: 'kw', ...props },
    global: { stubs: { GlitchText: true, PixelIcon: true } },
  })
  await flush() // 滑窗首帧走 queueMicrotask——一拍真时钟落定窗算再断言行
  return track(w)
}

describe('PlaylistGrid：页头上下文行', () => {
  it('query+searchSource 俱在 → 「"词" · 源全名」', async () => {
    const w = await mountGrid({ songs: [NE_SONG], query: '晴天', searchSource: 'qq' })
    const ctx = w.find('.grid-head-ctx')
    expect(ctx.exists()).toBe(true)
    expect(ctx.text()).toBe('“晴天” · QQ 音乐')
  })

  it('searchSource 缺席/未知 → 上下文行不渲', async () => {
    let w = await mountGrid({ songs: [NE_SONG], query: '晴天', searchSource: '' })
    expect(w.find('.grid-head-ctx').exists()).toBe(false)
    w.unmount()
    w = await mountGrid({ songs: [NE_SONG], query: '晴天', searchSource: 'future-src' })
    expect(w.find('.grid-head-ctx').exists()).toBe(false)
  })
})

describe('PlaylistGrid：歌曲行', () => {
  it.each([
    ['B站', BILI_SONG], ['YouTube', YT_SONG], ['QQ音乐', QQ_SONG],
  ])('来源角标 %s 渲染在歌名行内', async (label, song) => {
    const w = await mountGrid({ songs: [song] })
    const tag = w.find('.song-result-tag')
    expect(tag.exists()).toBe(true)
    expect(tag.text()).toBe(label)
    // 与歌名同一 flex 行（song-result-title 内），不是塞进 meta 行
    expect(tag.element.parentElement.classList.contains('song-result-title')).toBe(true)
  })

  it('网易云数字曲（无 provider 块）→ 无角标', async () => {
    const w = await mountGrid({ songs: [NE_SONG] })
    expect(w.find('.song-result-tag').exists()).toBe(false)
  })

  it('专辑名==歌名（trim+大小写不敏感）→ meta 只留艺人不复读', async () => {
    const same = { id: 1, name: 'Song Name', ar: [{ name: 'A' }], al: { name: '  song name  ' }, dt: 1 }
    const diff = { id: 2, name: 'Song Name', ar: [{ name: 'A' }], al: { name: '真专辑' }, dt: 1 }
    const w = await mountGrid({ songs: [same, diff] })
    const metas = w.findAll('.song-result-meta')
    expect(metas[0].text()).toBe('A')
    expect(metas[1].text()).toBe('A · 真专辑')
  })

  it('归一升级：全角兼容形+全角空格的同名校验同样判重（NFKC+连空白塌一）', async () => {
    // 外源回填常夹全角形——'ＳＯＮＧ　ＮＡＭＥ'（全角字符+U+3000）归一后
    // 与 'Song Name' 同词，裸 trim+lower 挡不住会复读一遍专辑段
    const full = { id: 3, name: 'Song Name', ar: [{ name: 'A' }], al: { name: 'ＳＯＮＧ　ＮＡＭＥ' }, dt: 1 }
    const w = await mountGrid({ songs: [full] })
    expect(w.find('.song-result-meta').text()).toBe('A')
  })

  it('封面 img alt 为空；@error 后落音符占位且不再回 img', async () => {
    const w = await mountGrid({ songs: [NE_SONG] })
    const img = w.find('img.song-result-cover')
    expect(img.exists()).toBe(true)
    expect(img.attributes('alt')).toBe('')
    expect(w.find('.song-result-cover--fallback').exists()).toBe(false)

    await img.trigger('error')
    await nextTick()
    expect(w.find('img.song-result-cover').exists()).toBe(false)
    expect(w.find('.song-result-cover--fallback').exists()).toBe(true)
  })

  it('裂图登记按曲 id（非行键 id#n）：同 id 两行共享一份失败登记', async () => {
    // 多源结果可含重复曲 id——同 id 两行封面 URL 同一个，
    // 一处裂图即全行落占位（跨批撞键恰是去重目的，不是误伤）
    const dup = { ...NE_SONG }
    const w = await mountGrid({ songs: [NE_SONG, dup] })
    const imgs = w.findAll('img.song-result-cover')
    expect(imgs.length).toBe(2)

    await imgs[0].trigger('error')
    await nextTick()
    expect(w.findAll('img.song-result-cover').length).toBe(0)
    expect(w.findAll('.song-result-cover--fallback').length).toBe(2)
  })
})

describe('PlaylistGrid：单腿源歌单 hint', () => {
  it.each(['yt', 'bili'])('源=%s 有曲无单 → 指路行出现', async (src) => {
    const w = await mountGrid({ songs: [YT_SONG], results: [], searchSource: src })
    const hint = w.find('.grid-hint')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toContain('歌单链接粘到顶部搜索框')
  })

  it.each(['netease', 'qq'])('源=%s 有曲无单 → 不出指路行（双腿源无腿残是真空态）', async (src) => {
    const w = await mountGrid({ songs: [NE_SONG], results: [], searchSource: src })
    expect(w.find('.grid-hint').exists()).toBe(false)
  })

  it('yt 源但曲也空 → 整页空态接管，不叠指路行', async () => {
    const w = await mountGrid({ songs: [], results: [], searchSource: 'yt' })
    expect(w.find('.grid-state-text').exists()).toBe(true)
    expect(w.find('.grid-hint').exists()).toBe(false)
  })
})

// ═══ useSearchNav：searchSource 源戳 ═══
const makeNav = () => {
  const deps = {
    gates: {
      select: createReqGate(), preview: createReqGate(), search: createReqGate(),
      mediaImport: createReqGate(), picker: createReqGate(),
    },
    searchQuery: ref(''), currentSong: ref(null), watchTab: ref('queue'),
    isFullscreenPlayerOpen: ref(false),
    userPlaylists: ref([]), selectedPlaylist: ref(null), loadingSongs: ref(false),
    playSong: vi.fn(), playSongFromSearch: vi.fn(),
    playSongFromRelated: vi.fn(), playPlaylist: vi.fn(),
    selectPlaylist: vi.fn(async () => true),
    savePlaylistsToStorage: vi.fn(),
  }
  return useSearchNav(deps)
}

describe('useSearchNav：searchSource 随 handler 立案定调', () => {
  it('四 handler 各记各源', async () => {
    const nav = makeNav()
    await nav.handlePlaylistSearch('k')
    expect(nav.searchSource.value).toBe('netease')
    await nav.handleQQSongSearch('k')
    expect(nav.searchSource.value).toBe('qq')
    await nav.handleYTSongSearch('k')
    expect(nav.searchSource.value).toBe('yt')
    await nav.handleBiliSongSearch('k')
    expect(nav.searchSource.value).toBe('bili')
  })

  it('handleSearch 裸词按偏好分派后源戳即偏好源；搜完再切偏好不改写旧戳', async () => {
    prefSearchSource.value = 'yt'
    const nav = makeNav()
    await nav.handleSearch('lofi')
    expect(nav.searchSource.value).toBe('yt')
    expect(musicApi.searchYouTubeSongs).toHaveBeenCalled()
    // 偏好漂移不追写——旧批结果的来源是立案时刻的事实
    prefSearchSource.value = 'qq'
    expect(nav.searchSource.value).toBe('yt')
  })
})

// ═══ useAddToPlaylist：裸关键词按偏好源分派 ═══
const PL_PICKER = { id: 'local_pl_1', name: '目标单', isLocal: true, tracks: [] }
const makePicker = () => {
  const atp = useAddToPlaylist({
    gates: { picker: createReqGate() },
    userPlaylists: ref([{ ...PL_PICKER }]),
    selectedPlaylist: ref({ ...PL_PICKER }),
    songs: ref([]),
    addPlaylistToLibrary: vi.fn(),
    appendSongToLibraryPlaylist: vi.fn(() => 'added'),
    createLocalPlaylist: vi.fn(),
    closeCreatePlaylist: vi.fn(),
  })
  atp.openSongPicker()
  return atp
}
const pickSearch = (atp, q) => {
  atp.songPickerQuery.value = q
  return atp.songPickerSearch()
}

describe('useAddToPlaylist：裸关键词按 prefSearchSource 分派', () => {
  it('qq → searchQQSongs + buildQQSong 归一 qq_ 行；空结果点名 QQ', async () => {
    musicApi.searchQQSongs.mockResolvedValueOnce({ songs: [
      { mid: 'm001', name: '晴天', artists: ['周杰伦'] },
    ], total: 1 })
    prefSearchSource.value = 'qq'
    const atp = makePicker()
    await pickSearch(atp, '周杰伦')
    expect(musicApi.searchQQSongs).toHaveBeenCalledWith('周杰伦', { signal: expect.any(AbortSignal) })
    expect(musicApi.searchSongs).not.toHaveBeenCalled()
    expect(atp.songPickerResults.value[0].id).toBe('qq_m001')

    musicApi.searchQQSongs.mockResolvedValueOnce({ songs: [], total: 0 })
    await pickSearch(atp, '空词')
    expect(toast).toHaveBeenCalledWith('QQ 音乐没有找到相关歌曲', 'info')
  })

  it('yt → searchYouTubeSongs + buildYouTubeSong 归一 yt_ 行；空结果点名 YouTube', async () => {
    musicApi.searchYouTubeSongs.mockResolvedValueOnce({ items: [
      { videoId: 'abc12345678', title: 'lofi', author: 'ch', duration: 60, cover: '' },
    ] })
    prefSearchSource.value = 'yt'
    const atp = makePicker()
    await pickSearch(atp, 'lofi')
    expect(musicApi.searchYouTubeSongs).toHaveBeenCalledWith('lofi', { signal: expect.any(AbortSignal) })
    expect(musicApi.searchSongs).not.toHaveBeenCalled()
    expect(atp.songPickerResults.value[0].id).toBe('yt_abc12345678')

    musicApi.searchYouTubeSongs.mockResolvedValueOnce({ items: [] })
    await pickSearch(atp, '空词')
    expect(toast).toHaveBeenCalledWith('YouTube 没有找到相关歌曲', 'info')
  })

  it('bili → searchBiliSongs + buildBilibiliSong 归一 bv_ 行；空结果点名 B 站', async () => {
    musicApi.searchBiliSongs.mockResolvedValueOnce({ items: [
      { bvid: 'BV1xx411c7XE', title: 'B稿', owner: 'up', duration: 30, cover: '' },
    ] })
    prefSearchSource.value = 'bili'
    const atp = makePicker()
    await pickSearch(atp, 'b稿关键词')
    expect(musicApi.searchBiliSongs).toHaveBeenCalledWith('b稿关键词', { signal: expect.any(AbortSignal) })
    expect(musicApi.searchSongs).not.toHaveBeenCalled()
    expect(atp.songPickerResults.value[0].id).toBe('bv_BV1xx411c7XE')

    musicApi.searchBiliSongs.mockResolvedValueOnce({ items: [] })
    await pickSearch(atp, '空词')
    expect(toast).toHaveBeenCalledWith('B 站没有找到相关歌曲', 'info')
  })

  it.each(['netease', 'future-src'])('源=%s → 照旧 searchSongs(q,30) 网易云腿', async (src) => {
    // 'future-src'：白名单外值直写 ref（prefSearchSource 的归一化只在
    // LS/远端读取侧——写入不设闸），分派必须落默认网易云腿
    prefSearchSource.value = src
    musicApi.searchSongs.mockResolvedValueOnce([{ id: 5, name: 'hit' }])
    const atp = makePicker()
    await pickSearch(atp, '关键词')
    expect(musicApi.searchSongs).toHaveBeenCalledWith('关键词', 30)
    expect(musicApi.searchQQSongs).not.toHaveBeenCalled()
    expect(musicApi.searchYouTubeSongs).not.toHaveBeenCalled()
    expect(atp.songPickerResults.value[0].id).toBe(5)
  })
})

// ═══ App.vue 集成：绑定透传 + openWatchOrBack 双态 ═══
describe('App.vue：导航与多源搜索域接线', () => {
  it('TopNavigation 收 :is-search-view；PlaylistGrid 收 :search-source（立案源戳）', async () => {
    const w = track(shallowMount(App))
    await vi.waitFor(() => expect(authState.booted).toBe(true))
    await flush()

    const nav = w.findComponent(TopNavigation)
    expect(nav.props('isSearchView')).toBe(false)

    // 驱动一次真搜索：pref=bili → search emit → handleBiliSongSearch 立案
    prefSearchSource.value = 'bili'
    w.vm.searchQuery = '晚安曲'
    await nav.vm.$emit('search', '晚安曲')
    await vi.waitFor(() => expect(w.vm.centerView).toBe('search'))
    await flush()

    expect(nav.props('isSearchView')).toBe(true)
    expect(w.vm.searchSource).toBe('bili')
    // PlaylistGrid 是 lazyView 异步件——浅桩未挂已声明 props，绑定落 attrs
    const grid = w.findComponent(PlaylistGrid)
    expect(grid.exists()).toBe(true)
    expect(grid.attributes('search-source')).toBe('bili')
    // ctx 行吃立案词 searchSongQuery（handler 立案时写）而非框内活词
    expect(w.vm.searchSongQuery).toBe('晚安曲')
    expect(grid.attributes('query')).toBe('晚安曲')
    // 框里改打未提交的新词：页头不翻旧账——query 绑定仍报立案词
    w.vm.searchQuery = 'abc'
    await flush()
    expect(grid.attributes('query')).toBe('晚安曲')
  })

  it('@open-watch → openWatchOrBack：页外进 watch 对应 tab；页内再点回上一视图', async () => {
    const w = track(shallowMount(App))
    await vi.waitFor(() => expect(authState.booted).toBe(true))
    await flush()

    // 页外（home）+ 在播曲 → BottomPlayer emit open-watch → openWatchPanel('queue')
    w.vm.currentSong = { id: 12345, name: '曲', dt: 200000 }
    const bp = w.findComponent(BottomPlayer)
    await bp.vm.$emit('open-watch', 'lyrics')
    await nextTick()
    expect(w.vm.centerView).toBe('watch')
    expect(w.vm.watchTab).toBe('lyrics')
    expect(bp.props('watchOpen')).toBe(true) // :watch-open 绑定同步翻过（BottomPlayer 已声明该 prop——收起键态消费方）

    // watch 页内再点 → watchBack 分支：本次入栈由 pushNavState 打过
    // meowsyncNav 戳——应走站内 history.back 回放（jsdom 的 popstate
    // 派发不可靠，桩掉 back 直接钉调用面）
    const backSpy = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    w.vm.openWatchOrBack('queue')
    expect(backSpy).toHaveBeenCalledTimes(1)

    // 无站内历史的直达形态：state=null → watchBack 确定性落 home + replaceState
    // （URL 用相对形式——jsdom origin 带端口，绝对写会撞同源闸 SecurityError；
    // back 桩留着——分支若走 navBack 会再调 back，正好一并钉住没走岔路）
    window.history.replaceState(null, '', '?view=watch')
    w.vm.openWatchOrBack('queue')
    expect(w.vm.centerView).toBe('home')
    expect(backSpy).toHaveBeenCalledTimes(1) // 还是那一发——没再走 back
    backSpy.mockRestore()
  })
})

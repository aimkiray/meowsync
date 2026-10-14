// 「搜索源」偏好钉板（vitest+jsdom）：
//   prefs      — LS 白名单归一（非法/缺席→netease）、applyRemote 不回写远端值、
//                远端墓碑位不回写归一值
//   useSearchNav — handleSearch 裸关键词按源分派（视同打了源前缀）、跨源重搜
//                游标/歌单残清
//   TopNavigation — fetchSuggestions 建议源跟随偏好（四源同归一消费面）、
//                netease:/163:/wy: 前缀逃生口（显式源声明优先于偏好）、
//                前缀簇先于整串判别（异源链不被错源谓词抢道）
//   useAddToPlaylist — 点歌台 netease:/163:/wy: 前缀（同义显式声明→searchSongs）、
//                qq:/yt: 前缀同型前移（前缀内歌单链保指向性提示、异源链不抢道）
//   related.js  — relatedFetch 分派矩阵（bv_/yt_ 上游相似、qq_ 艺人降级、
//                数值/file_ 网易照旧）、id 解形兜底、哨兵艺人拒发、种曲 _pN 剔除
//   WatchView  — loadRelated 走 relatedFetch（缺 provider 块照拉）、
//                bv_/yt_ 刊头只报规模不挂假艺人归属、qq_/网易云刊头挂艺人归属
//   sync       — SEARCH_SOURCE 在白名单（换设备习惯偏好要随行）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'

const { musicApi, syncApi, toast } = vi.hoisted(() => ({
  musicApi: {
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
    getBiliRelated: vi.fn(async () => ({ items: [] })),
    getYouTubeRelated: vi.fn(async () => ({ items: [], mixPlaylistId: null })),
    // 点歌台分支可达的 resolve/详情腿——前缀分派用例断言「未被打到」用
    resolveBilibili: vi.fn(async () => ({})),
    resolveYouTube: vi.fn(async () => ({})),
    resolveQQ: vi.fn(async () => ({})),
    getSongDetail: vi.fn(async () => ({})),
    bilibiliStreamUrl: vi.fn(() => 'https://x/bili'),
    youtubeStreamUrl: vi.fn(() => 'https://x/yt'),
  },
  syncApi: {
    pull: vi.fn(async () => ({ code: 200, since: 0, items: [] })),
    push: vi.fn(async () => ({ code: 200, applied: [], conflicts: [], rejected: [] })),
  },
  toast: vi.fn(() => 1),
}))
vi.mock('../../src/api/music.js', () => ({ musicApi }))
vi.mock('../../src/api/sync.js', () => ({ syncApi }))
vi.mock('../../src/api/auth.js', () => ({ authApi: {} }))
vi.mock('../../src/api/downloads.js', () => ({
  downloadsApi: {
    getSongDownloadStatus: vi.fn(async () => null),
    songFileUrl: vi.fn(() => 'http://api/dl'),
  },
}))
vi.mock('../../src/api/http.js', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  API_BASE_URL: 'http://api.test',
  apiErrorMessage: (e, fb) => e?.message || fb || '接口异常',
}))
vi.mock('../../src/lib/feedback.js', () => ({ toast, toastDismiss: vi.fn() }))

const { LS_KEYS, notifyStorageWrite } = await import('../../src/lib/storage.js')
const { prefSearchSource, SEARCH_SOURCES, applyRemoteSearchSource } = await import('../../src/lib/prefs.js')
const { createReqGate } = await import('../../src/lib/req-gate.js')
const { useSearchNav } = await import('../../src/composables/useSearchNav.js')
const { initSync, resetSyncState } = await import('../../src/lib/sync.js')
const { relatedSourceOf, relatedFetch } = await import('../../src/lib/related.js')
const { useAddToPlaylist } = await import('../../src/composables/useAddToPlaylist.js')
const { default: TopNavigation } = await import('../../src/components/TopNavigation.vue')
const { default: WatchView } = await import('../../src/components/WatchView.vue')

// jsdom 缺口补丁（topnav-yt/watch-view 同款）
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
}
if (typeof Element !== 'undefined') {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {}
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  prefSearchSource.value = 'netease'
})
afterEach(() => {
  document.body.innerHTML = ''
})

// ── prefs：值域白名单与远端回填 ──
describe('prefs：prefSearchSource', () => {
  it('写合法源值落 LS；非法 LS 值归 netease', async () => {
    prefSearchSource.value = 'yt'
    await nextTick()
    expect(localStorage.getItem(LS_KEYS.SEARCH_SOURCE)).toBe('yt')
    expect(SEARCH_SOURCES.map(s => s.id)).toEqual(['netease', 'qq', 'yt', 'bili'])
    // 非法值归一发生在读取侧——重灌模拟
    localStorage.setItem(LS_KEYS.SEARCH_SOURCE, 'future-src')
    applyRemoteSearchSource()
    expect(prefSearchSource.value).toBe('netease')
  })

  it('applyRemote 不记脏回写：远端推未知源值，LS 保留远端原文', async () => {
    // 远端推来新客户端才有的源值——归一只灌 ref，不得把 netease 回写进
    // LS 记脏推回（否则本机拿新戳把远端新版数据降级）
    localStorage.setItem(LS_KEYS.SEARCH_SOURCE, 'yt-v2')
    applyRemoteSearchSource()
    await nextTick(); await nextTick()
    expect(prefSearchSource.value).toBe('netease')
    expect(localStorage.getItem(LS_KEYS.SEARCH_SOURCE)).toBe('yt-v2')
  })

  it('远端墓碑：LS 删键后 ref 归一 netease，但不回写墓碑位', async () => {
    // 先用远端真值把 ref 顶离 netease——第二段的归一才有 watcher 可压
    localStorage.setItem(LS_KEYS.SEARCH_SOURCE, 'yt')
    applyRemoteSearchSource()
    await nextTick()
    expect(prefSearchSource.value).toBe('yt')
    // 远端墓碑落地：引擎侧已删键（remoteDeleted 回声抑制在引擎内），叶模块
    // handler 读缺席键归一 netease 灌 ref——归一值若写回 LS 会盖上本地
    // 新戳，压过远端真实墓碑（与 video/lyric-fs 远端应用窗同口径）
    localStorage.removeItem(LS_KEYS.SEARCH_SOURCE)
    applyRemoteSearchSource()
    await nextTick(); await nextTick()
    expect(prefSearchSource.value).toBe('netease')
    expect(localStorage.getItem(LS_KEYS.SEARCH_SOURCE)).toBe(null)
  })
})

// ── useSearchNav：handleSearch 裸关键词分派 ──
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
    selectPlaylist: vi.fn(async () => true),
    savePlaylistsToStorage: vi.fn(),
    closeSearchView: vi.fn(), navHome: vi.fn(), openSettingsPanel: vi.fn(),
  }
  return useSearchNav(deps)
}

describe('useSearchNav：handleSearch 按源分派', () => {
  it('netease → 网易云双腿（歌单+单曲 offset 翻页）', async () => {
    const nav = makeNav()
    await nav.handleSearch('关键词')
    expect(musicApi.searchPlaylists).toHaveBeenCalled()
    expect(musicApi.searchSongsPage).toHaveBeenCalled()
    expect(musicApi.searchQQSongs).not.toHaveBeenCalled()
  })

  it('qq → QQ 双腿（同 qq: 前缀 handler：soso 单曲+QQ 歌单）', async () => {
    prefSearchSource.value = 'qq'
    const nav = makeNav()
    await nav.handleSearch('关键词')
    expect(musicApi.searchQQSongs).toHaveBeenCalled()
    expect(musicApi.searchQQPlaylists).toHaveBeenCalled()
    expect(musicApi.searchSongsPage).not.toHaveBeenCalled()
  })

  it('yt → YouTube 单腿（continuation 游标落地）', async () => {
    prefSearchSource.value = 'yt'
    musicApi.searchYouTubeSongs.mockResolvedValueOnce({
      items: [{ videoId: 'dQw4w9WgXcQ', title: 't', author: 'a', duration: 200, cover: '' }],
      continuation: 'CTOK',
    })
    const nav = makeNav()
    await nav.handleSearch('关键词')
    expect(musicApi.searchYouTubeSongs).toHaveBeenCalled()
    expect(musicApi.searchPlaylists).not.toHaveBeenCalled()
    expect(nav.ytContinuation?.value ?? null).toBe('CTOK')
  })

  it('bili → B 站单腿（SSR 无续页，深挖键恒灭）', async () => {
    prefSearchSource.value = 'bili'
    musicApi.searchBiliSongs.mockResolvedValueOnce({
      items: [{ bvid: 'BV1xx411c7XE', title: 't', owner: 'u', duration: 60, cover: '' }],
    })
    const nav = makeNav()
    await nav.handleSearch('关键词')
    expect(musicApi.searchBiliSongs).toHaveBeenCalled()
    expect(musicApi.searchPlaylists).not.toHaveBeenCalled()
    expect(nav.searchSongResults.value[0]?.id).toBe('bv_BV1xx411c7XE')
    expect(nav.searchSongTotal.value).toBe(null)
  })

  it('跨源重搜复位：yt 游标清零、hasMore 不误亮、旧源歌单残即刻清', async () => {
    const nav = makeNav()
    // yt 源搜出 continuation 游标——结果集深挖通道亮灯
    prefSearchSource.value = 'yt'
    musicApi.searchYouTubeSongs.mockResolvedValueOnce({
      items: [{ videoId: 'dQw4w9WgXcQ', title: 't', author: 'a', duration: 200, cover: '' }],
      continuation: 'CTOK',
    })
    await nav.handleSearch('k1')
    expect(nav.ytContinuation.value).toBe('CTOK')
    expect(nav.searchSongHasMore.value).toBe(true)

    // 塞一张旧源歌单卡（qq 双腿的歌单腿产物）
    prefSearchSource.value = 'qq'
    musicApi.searchQQPlaylists.mockResolvedValueOnce({
      playlists: [{ id: 'pl-qq', disstid: '7', provider: 'qq', name: 'Q单' }],
    })
    await nav.handleSearch('k2')
    expect(nav.searchResults.value.length).toBe(1)

    // 切回 netease 重搜：handlePlaylistSearch 立案即双清——歌单腿在途窗内
    // 不得残留旧源卡片区；yt 游标同步收键（跨源结果集的深挖通道互不相干）
    prefSearchSource.value = 'netease'
    let release
    musicApi.searchPlaylists.mockImplementationOnce(() => new Promise(r => { release = r }))
    const p = nav.handleSearch('k3')
    await nextTick()
    expect(nav.ytContinuation.value).toBe(null)
    expect(nav.searchResults.value).toEqual([])
    release({ playlists: [] })
    await p
    // 网易云空回包（total=0）且无游标——深挖键不因旧游标误亮
    expect(nav.searchSongHasMore.value).toBe(false)
  })
})

// ── TopNavigation：建议源跟随偏好 ──
const mountNavWithInput = async (q) => {
  const w = mount(TopNavigation, {
    attachTo: document.body,
    props: { remoteMode: 'off', searchQuery: q },
    global: { stubs: { GlitchText: true, PixelIcon: true } },
  })
  await nextTick()
  return w
}

describe('TopNavigation：建议跟随搜索源', () => {
  // 250ms 防抖——真时钟短等比 fake timers 穿 axios/promise 链更稳
  const typeAndWait = async (w, q) => {
    const input = w.find('input')
    input.element.value = q
    await input.trigger('input')
    await new Promise(r => setTimeout(r, 400))
    await nextTick()
  }

  it.each([
    ['netease', 'searchSuggest'], ['qq', 'searchQQSuggest'],
    ['yt', 'getYouTubeSuggest'], ['bili', 'getBiliSuggest'],
  ])('源=%s → %s', async (src, api) => {
    prefSearchSource.value = src
    const w = await mountNavWithInput('')
    await typeAndWait(w, 'lofi')
    expect(musicApi[api]).toHaveBeenCalledWith('lofi', expect.anything())
    w.unmount()
  })

  it('bili: 前缀输入不弹建议（抑制表不随源变）', async () => {
    prefSearchSource.value = 'bili'
    const w = await mountNavWithInput('')
    await typeAndWait(w, 'bili:周杰伦')
    expect(musicApi.getBiliSuggest).not.toHaveBeenCalled()
    w.unmount()
  })

  it.each(['netease', '163', 'wy'])('%s: 前缀 emit search-netease（去前缀关键词）', async (pfx) => {
    prefSearchSource.value = 'yt' // 偏好非 netease 时前缀仍直达——显式源声明
    const w = await mountNavWithInput(`${pfx}:周杰伦`)
    w.vm.handleSearch()
    expect(w.emitted('search-netease')).toEqual([['周杰伦']])
    expect(w.emitted('search')).toBeUndefined()
    w.unmount()
  })

  it.each(['netease:', 'netease：', '163：'])('空前缀 %s 静默吞（与各源同律）', async (q) => {
    const w = await mountNavWithInput(q)
    w.vm.handleSearch()
    expect(w.emitted('search-netease')).toBeUndefined()
    expect(w.emitted('search')).toBeUndefined()
    w.unmount()
  })
})

// ── TopNavigation：源前缀簇先于整串判别（前缀=显式源声明，异源链不抢道）──
// 摘修即红：netease:/qq:/yt: 块挪回整串判别之后，下列各例即刻被错源谓词
// 抢走——'netease:b23.tv/x' 落 search-bili（连壳 resolve 必死 400）、
// 前缀内 y.qq.com 歌单链落 search-qq-pl
describe('TopNavigation：源前缀簇先于整串判别', () => {
  const QQ_PL_URL = 'https://y.qq.com/n/ryqq/playlist/8313'
  const dispatch = async (q) => {
    const w = await mountNavWithInput(q)
    w.vm.handleSearch()
    const emitted = w.emitted()
    w.unmount()
    return emitted
  }

  it('netease:<b23 短链> → search-netease（不被 b23.tv 域名判抢走）', async () => {
    const e = await dispatch('netease:b23.tv/abc123')
    expect(e['search-netease']).toEqual([['b23.tv/abc123']])
    expect(e['search-bili']).toBeUndefined()
    expect(e['search']).toBeUndefined()
  })

  it('netease:<QQ 歌单链> → search-netease（不被 extractQQPlaylistId 抢走）', async () => {
    const e = await dispatch(`netease:${QQ_PL_URL}`)
    expect(e['search-netease']).toEqual([[QQ_PL_URL]])
    expect(e['search-qq-pl']).toBeUndefined()
  })

  it.each(['163', 'wy'])('%s:<b23 短链> 同义别名同口径 → search-netease', async (pfx) => {
    const e = await dispatch(`${pfx}:b23.tv/abc123`)
    expect(e['search-netease']).toEqual([['b23.tv/abc123']])
    expect(e['search-bili']).toBeUndefined()
  })

  it('qq:<b23/异源短链> → search-qq-songs（异源形态按本域关键词搜）', async () => {
    const e = await dispatch('qq:b23.tv/abc123')
    expect(e['search-qq-songs']).toEqual([['b23.tv/abc123']])
    expect(e['search-bili']).toBeUndefined()
  })

  it('qq:<youtu.be 链> → search-qq-songs（不被 isYouTubeInput 抢走）', async () => {
    const e = await dispatch('qq:https://youtu.be/dQw4w9WgXcQ')
    expect(e['search-qq-songs']).toEqual([['https://youtu.be/dQw4w9WgXcQ']])
    expect(e['search-yt']).toBeUndefined()
  })

  it('yt:<b23 短链> → search-yt-songs（不被 b23.tv 域名判抢走）', async () => {
    const e = await dispatch('yt:b23.tv/abc123')
    expect(e['search-yt-songs']).toEqual([['b23.tv/abc123']])
    expect(e['search-bili']).toBeUndefined()
  })

  it('yt:<QQ 歌单链> → search-yt-songs（不被 extractQQPlaylistId 抢走）', async () => {
    const e = await dispatch(`yt:${QQ_PL_URL}`)
    expect(e['search-yt-songs']).toEqual([[QQ_PL_URL]])
    expect(e['search-qq-pl']).toBeUndefined()
  })

  it('bili:<QQ 歌单链> → search-bili-songs（同律不被抢走）', async () => {
    const e = await dispatch(`bili:${QQ_PL_URL}`)
    expect(e['search-bili-songs']).toEqual([[QQ_PL_URL]])
    expect(e['search-qq-pl']).toBeUndefined()
  })

  it('前缀内本域链照旧各自 resolve：qq:<歌单链> → search-qq-pl；qq:<单曲链>/yt:<youtu.be> → 剥前缀送达', async () => {
    const e = await dispatch(`qq:${QQ_PL_URL}`)
    expect(e['search-qq-pl']).toEqual([['8313']])
    const songUrl = 'https://y.qq.com/n/ryqq/song/0034M8WL3V4oHC.html'
    const e2 = await dispatch(`qq:${songUrl}`)
    expect(e2['search-qq']).toEqual([[songUrl]]) // 剥前缀送达——不再连壳送进 resolve
    const e3 = await dispatch('yt:https://youtu.be/dQw4w9WgXcQ')
    expect(e3['search-yt']).toEqual([['https://youtu.be/dQw4w9WgXcQ']])
  })

  it('无前缀回归：QQ 歌单链/单曲链/网易云歌单链/歌曲链/关键词照旧分派', async () => {
    const e = await dispatch(QQ_PL_URL)
    expect(e['search-qq-pl']).toEqual([['8313']])
    const songUrl = 'https://y.qq.com/n/ryqq/song/0034M8WL3V4oHC.html'
    const e2 = await dispatch(songUrl)
    expect(e2['search-qq']).toEqual([[songUrl]]) // 无前缀照旧整串原样透传
    const e3 = await dispatch('https://music.163.com/playlist?id=12345')
    expect(e3['search-by-id']).toEqual([['12345', 'https://music.163.com/playlist?id=12345']])
    const e4 = await dispatch('music.163.com/song?id=678')
    expect(e4['search-song']).toEqual([['678']])
    const e5 = await dispatch('普通关键词')
    expect(e5.search).toEqual([['普通关键词', '普通关键词']])
  })
})

// ── 点歌台：netease: 前缀 + 前缀簇同型前移 ──
const PL_PICKER = { id: 'local_pl_1', name: '目标单', isLocal: true, tracks: [] }
const makePicker = () => {
  const deps = {
    gates: { picker: createReqGate() },
    userPlaylists: ref([{ ...PL_PICKER }]),
    selectedPlaylist: ref({ ...PL_PICKER }),
    songs: ref([]),
    addPlaylistToLibrary: vi.fn(),
    appendSongToLibraryPlaylist: vi.fn(() => 'added'),
    createLocalPlaylist: vi.fn(),
    closeCreatePlaylist: vi.fn(),
  }
  const atp = useAddToPlaylist(deps)
  atp.openSongPicker()
  return atp
}
const pickSearch = (atp, q) => {
  atp.songPickerQuery.value = q
  return atp.songPickerSearch()
}

describe('useAddToPlaylist：源前缀簇', () => {
  it.each(['netease', '163', 'wy'])('%s:<关键词> → 剥前缀走默认网易云 searchSongs', async (pfx) => {
    const atp = makePicker()
    await pickSearch(atp, `${pfx}:周杰伦`)
    expect(musicApi.searchSongs).toHaveBeenCalledWith('周杰伦', 30)
  })

  it('netease:<b23 短链> → searchSongs（不被 b23.tv 域名判抢进 resolveBilibili）', async () => {
    const atp = makePicker()
    await pickSearch(atp, 'netease:b23.tv/abc123')
    expect(musicApi.resolveBilibili).not.toHaveBeenCalled()
    expect(musicApi.searchSongs).toHaveBeenCalledWith('b23.tv/abc123', 30)
  })

  it('netease:<空> → 静默吞不发上游', async () => {
    const atp = makePicker()
    await pickSearch(atp, 'netease：   ')
    expect(musicApi.searchSongs).not.toHaveBeenCalled()
  })

  it('yt:<QQ 歌单链> → searchYouTubeSongs（不被 extractQQPlaylistId 抢出 QQ 提示）', async () => {
    const atp = makePicker()
    await pickSearch(atp, 'yt:https://y.qq.com/n/ryqq/playlist/8313')
    expect(musicApi.searchYouTubeSongs).toHaveBeenCalledWith(
      'https://y.qq.com/n/ryqq/playlist/8313', { signal: expect.any(AbortSignal) })
    expect(musicApi.resolveQQ).not.toHaveBeenCalled()
    expect(toast).not.toHaveBeenCalledWith('这是 QQ 歌单链接，请在顶部搜索框粘贴导入', 'info')
  })

  it('qq:<QQ 歌单链> → 指向性提示（前缀块内补判，保整串判别原口径）', async () => {
    const atp = makePicker()
    await pickSearch(atp, 'qq:https://y.qq.com/n/ryqq/playlist/8313')
    expect(toast).toHaveBeenCalledWith('这是 QQ 歌单链接，请在顶部搜索框粘贴导入', 'info')
    expect(musicApi.searchQQSongs).not.toHaveBeenCalled()
    expect(musicApi.resolveQQ).not.toHaveBeenCalled()
  })

  it('qq:<youtu.be 链> → searchQQSongs（异源形态按本域关键词搜，不被 isYouTubeInput 抢）', async () => {
    const atp = makePicker()
    await pickSearch(atp, 'qq:https://youtu.be/dQw4w9WgXcQ')
    expect(musicApi.resolveYouTube).not.toHaveBeenCalled()
    expect(musicApi.searchQQSongs).toHaveBeenCalledWith(
      'https://youtu.be/dQw4w9WgXcQ', { signal: expect.any(AbortSignal) })
  })
})

// ── WatchView：相关面板按曲源分派 ──
const mountedWv = []
const mountRelated = (song) => {
  const w = mount(WatchView, {
    attachTo: document.body,
    props: { currentSong: song, tab: 'related' },
  })
  mountedWv.push(w)
  return w
}
afterEach(() => { while (mountedWv.length) mountedWv.pop().unmount() })

const flush = async () => { await nextTick(); await new Promise(r => setTimeout(r, 0)); await nextTick() }

describe('WatchView：相关按曲源分派', () => {
  it('bv_ → archive/related（相似稿非艺人搜），种曲剔除', async () => {
    musicApi.getBiliRelated.mockResolvedValueOnce({
      items: [
        { bvid: 'BV2xx411c7XF', title: '相关稿', owner: 'u', duration: 30, cover: '' },
        { bvid: 'BV1xx411c7XE', title: '种曲本体', owner: 'u', duration: 30, cover: '' },
      ],
    })
    const w = mountRelated({ id: 'bv_BV1xx411c7XE', name: '曲', ar: [{ name: 'up' }], bilibili: { bvid: 'BV1xx411c7XE' } })
    await flush()
    expect(musicApi.getBiliRelated).toHaveBeenCalledWith('BV1xx411c7XE')
    expect(musicApi.searchSongs).not.toHaveBeenCalled()
    const ids = w.findAll('.watch-related-row').length
    expect(ids).toBe(1) // 种曲本体被剔
  })

  it('bv_ 缺 provider 块的老行：bvid 从 id 解形兜底照打相似接口', async () => {
    // 存量持久化曲只剩前缀 id——与 usePlayer bvM/songSourceUrl 同一条
    // 「provider 块优先、id 解形兜底」惯例，不空不回落艺人搜
    mountRelated({ id: 'bv_BV1xx411c7XE', name: '曲', ar: [{ name: 'up' }] })
    await flush()
    expect(musicApi.getBiliRelated).toHaveBeenCalledWith('BV1xx411c7XE')
    expect(musicApi.searchSongs).not.toHaveBeenCalled()
  })

  it('yt_ → /next 相关；缺 youtube 块的老行从 id 解形兜底照拉', async () => {
    const w = mountRelated({ id: 'yt_abc12345678', name: '曲', ar: [{ name: 'a' }], youtube: { videoId: 'abc12345678' } })
    await flush()
    expect(musicApi.getYouTubeRelated).toHaveBeenCalledWith('abc12345678')
    w.unmount()
    const w2 = mountRelated({ id: 'yt_abc12345679', name: '曲', ar: [{ name: 'a' }] })
    await flush()
    expect(musicApi.getYouTubeRelated).toHaveBeenCalledWith('abc12345679')
    expect(musicApi.searchSongs).not.toHaveBeenCalled()
  })

  it('bv_/yt_ 刊头只报规模——相似稿口径不挂假艺人归属', async () => {
    musicApi.getBiliRelated.mockResolvedValueOnce({
      items: [{ bvid: 'BV9yy511d7YF', title: '相关稿', owner: 'v', duration: 30, cover: '' }],
    })
    const w = mountRelated({ id: 'bv_BV1xx411c7XE', name: '曲', ar: [{ name: 'up' }], bilibili: { bvid: 'BV1xx411c7XE' } })
    await flush()
    const meta = w.find('.queue-head-meta')
    expect(meta.exists()).toBe(true)
    expect(meta.text()).toBe('1 首') // 不是「up · 1 首」——相关非艺人搜产物
  })

  it('qq_/网易云刊头挂「艺人 · N 首」——艺人搜口径归属如实上刊（双口径另一侧钉）', async () => {
    musicApi.searchQQSongs.mockResolvedValueOnce({ songs: [
      { mid: 'rel7654321', name: '相关', artists: ['周杰伦'] },
    ], total: 1 })
    const w = mountRelated({ id: 'qq_mid1234567', name: '曲', ar: [{ name: '周杰伦' }], qq: { mid: 'mid1234567' } })
    await flush()
    expect(w.find('.queue-head-meta').text()).toBe('周杰伦 · 1 首')
    w.unmount()
    musicApi.searchSongs.mockResolvedValueOnce([{ id: 678, name: '相关' }])
    const w2 = mountRelated({ id: 12345, name: '曲', ar: [{ name: '艺人' }] })
    await flush()
    expect(w2.find('.queue-head-meta').text()).toBe('艺人 · 1 首')
  })

  it('qq_ → QQ 艺人搜索降级（相似接口登录墙的既有口径）', async () => {
    const w = mountRelated({ id: 'qq_mid1234567', name: '曲', ar: [{ name: '周杰伦' }], qq: { mid: 'mid1234567' } })
    await flush()
    expect(musicApi.searchQQSongs).toHaveBeenCalledWith('周杰伦', expect.objectContaining({ limit: 15 }))
    expect(musicApi.searchSongs).not.toHaveBeenCalled()
  })

  it('网易云数值曲 → 照旧艺人搜索；file_ 无艺人 → 空', async () => {
    mountRelated({ id: 12345, name: '曲', ar: [{ name: '艺人' }] })
    await flush()
    expect(musicApi.searchSongs).toHaveBeenCalledWith('艺人', 15)
    const w = mountRelated({ id: 'file_abc', name: '本机' })
    await flush()
    expect(musicApi.searchSongs).toHaveBeenCalledTimes(1)
    expect(w.findAll('.watch-related-row').length).toBe(0)
  })
})

// ── related.js：分派矩阵 + 解形兜底 + 缺料 null ──
describe('related.js：relatedFetch', () => {
  it('relatedSourceOf 按 id 前缀定源（provider 块不参与判源）', () => {
    expect(relatedSourceOf({ id: 'bv_BV1xx411c7XE' })).toBe('bili')
    expect(relatedSourceOf({ id: 'bv_BV1xx411c7XE_p3' })).toBe('bili')
    expect(relatedSourceOf({ id: 'yt_abc12345678' })).toBe('yt')
    expect(relatedSourceOf({ id: 'qq_mid1234567' })).toBe('qq')
    expect(relatedSourceOf({ id: 12345 })).toBe('netease')
    expect(relatedSourceOf({ id: 'file_abcd1234' })).toBe('netease')
  })

  it('bv_：id 解形兜底；种曲按 bvid 剔除兜 _pN 形态', async () => {
    musicApi.getBiliRelated.mockResolvedValueOnce({ items: [
      // 种曲 bv_X_p2 的上游回包常带 bv_X（P1 本体）与同 bvid 分P——整 id 比对会漏
      { bvid: 'BV1xx411c7XE', title: '本体P1', owner: 'u', duration: 1, cover: '' },
      { bvid: 'BV1xx411c7XE', page: 2, title: '本体P2', owner: 'u', duration: 1, cover: '' },
      { bvid: 'BV9yy511d7YF', title: '真相关', owner: 'v', duration: 1, cover: '' },
    ] })
    const r = await relatedFetch({ id: 'bv_BV1xx411c7XE_p2', name: 'x', ar: [{ name: 'u' }] })
    expect(musicApi.getBiliRelated).toHaveBeenCalledWith('BV1xx411c7XE')
    expect(r.source).toBe('bili')
    expect(r.items.map(s => s.id)).toEqual(['bv_BV9yy511d7YF'])
  })

  it('yt_：videoId id 解形兜底 + 种曲剔除', async () => {
    musicApi.getYouTubeRelated.mockResolvedValueOnce({ items: [
      { videoId: 'abc12345678', title: '本体', author: 'c', duration: 1, cover: '' },
      { videoId: 'zzz98765432', title: '真相关', author: 'c', duration: 1, cover: '' },
    ] })
    const r = await relatedFetch({ id: 'yt_abc12345678', name: 'x' })
    expect(musicApi.getYouTubeRelated).toHaveBeenCalledWith('abc12345678')
    expect(r.source).toBe('yt')
    expect(r.items.map(s => s.id)).toEqual(['yt_zzz98765432'])
  })

  it('qq_：哨兵艺人/艺人缺席 → null 拒发上游；正常艺人按整 id 剔种', async () => {
    // 'QQ 音乐' 是 buildQQSong 的无艺人兜底哨兵——字面上游必返垃圾
    expect(await relatedFetch({ id: 'qq_mid1234567', ar: [{ name: 'QQ 音乐' }] })).toBe(null)
    expect(await relatedFetch({ id: 'qq_mid1234567', name: 'x' })).toBe(null)
    expect(musicApi.searchQQSongs).not.toHaveBeenCalled()

    musicApi.searchQQSongs.mockResolvedValueOnce({ songs: [
      { mid: 'mid1234567', name: '本体', artists: ['周杰伦'] },
      { mid: 'rel7654321', name: '相关', artists: ['周杰伦'] },
    ], total: 2 })
    const r = await relatedFetch({ id: 'qq_mid1234567', ar: [{ name: '周杰伦' }] })
    expect(musicApi.searchQQSongs).toHaveBeenCalledWith('周杰伦', { limit: 15, page: 1 })
    expect(r.items.map(s => s.id)).toEqual(['qq_rel7654321'])
  })

  it('数值/file_：网易云艺人搜按整 id 剔种；无艺人/无曲 → null', async () => {
    musicApi.searchSongs.mockResolvedValueOnce([{ id: 12345 }, { id: 678 }])
    const r = await relatedFetch({ id: 12345, ar: [{ name: '艺人' }] })
    expect(musicApi.searchSongs).toHaveBeenCalledWith('艺人', 15)
    expect(r.source).toBe('netease')
    expect(r.items.map(s => s.id)).toEqual([678])
    expect(await relatedFetch({ id: 'file_abcd1234', name: '本机' })).toBe(null)
    expect(await relatedFetch(null)).toBe(null)
  })
})

// ── sync：SEARCH_SOURCE 进白名单 ──
describe('sync：搜索源跨端同步', () => {
  // initSync 挂全局写钩 + window/document 监听——模块级引擎态按用例复位
  //（与 use-player/yt-search-wiring 同款 resetSyncState 逃生口）
  beforeEach(() => resetSyncState())
  afterEach(() => resetSyncState())
  it('SEARCH_SOURCE 写产生 doc: 推送', async () => {
    vi.useFakeTimers()
    try {
      initSync()
      localStorage.setItem(LS_KEYS.SEARCH_SOURCE, 'yt')
      notifyStorageWrite(LS_KEYS.SEARCH_SOURCE)
      await vi.advanceTimersByTimeAsync(1600)
      const keys = syncApi.push.mock.calls.flatMap(c => c[0].map(i => i.key))
      expect(keys).toContain(`doc:${LS_KEYS.SEARCH_SOURCE}`)
    } finally {
      vi.useRealTimers()
    }
  })
})

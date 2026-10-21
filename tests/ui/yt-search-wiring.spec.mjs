// YouTube 搜索接线钉板（vitest+jsdom）——YT 批次两条跨层接缝：
//   缺口1 TopNavigation search-yt-songs → App 监听 → handleYTSongSearch →
//     searchSongResults 填充 + centerView=search（此前 emit 悬空无人接）
//   缺口2 PlaylistGrid 深挖键亮灯改吃 songHasMore（useSearchNav 三口径闸）：
//     YT 结果集 songTotal 恒 null 但 continuation 在场须亮且推进游标；
//     total 源（网易云/QQ）文案带 n/total、灭键语义不变
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick } from 'vue'

vi.mock('../../src/api/auth.js', () => ({
  authApi: {
    status: vi.fn(async () => ({ data: {} })),
    logout: vi.fn(async () => ({})),
    me: vi.fn(async () => ({ data: null })),
  },
}))
const { musicApi } = vi.hoisted(() => ({
  musicApi: {
    resolveYouTube: vi.fn(),
    resolveBilibili: vi.fn(),
    resolveQQ: vi.fn(),
    getSongDetail: vi.fn(),
    getSongsDetail: vi.fn(async () => []),
    getPlaylistDetail: vi.fn(async () => null),
    getQqStatus: vi.fn(async () => null),
    retryMatch: vi.fn(async () => null),
    searchSongs: vi.fn(async () => []),
    searchSongsPage: vi.fn(async () => ({ songs: [], total: 0 })),
    searchPlaylists: vi.fn(async () => ({ playlists: [] })),
    searchQQSongs: vi.fn(async () => ({ songs: [], total: 0 })),
    searchQQPlaylists: vi.fn(async () => ({ playlists: [], total: 0 })),
    searchYouTubeSongs: vi.fn(),
  },
}))
vi.mock('../../src/api/music.js', () => ({
  musicApi,
  // App.vue→usePlayer/useExternalImport 图按名链接——缺省 null=「态未知」
  qqLoggedIn: vi.fn(async () => null),
}))
vi.mock('../../src/api/downloads.js', () => ({
  downloadsApi: {
    removeLocalMirror: vi.fn(async () => ({})),
    mirrorLocalPlaylist: vi.fn(async () => ({})),
    quickDownloadPlaylist: vi.fn(async () => ({})),
    deletePlaylistDownloads: vi.fn(async () => ({})),
    listTasks: vi.fn(async () => ({ data: [] })),
    getSongDownloadStatus: vi.fn(async () => null),
  },
}))
vi.mock('../../src/api/http.js', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
  API_BASE_URL: 'http://api.test',
  apiErrorMessage: (e, fb) => e?.message || fb || '接口异常',
}))
vi.mock('../../src/api/sync.js', () => ({
  syncApi: { pull: vi.fn(), push: vi.fn() },
  openSyncEvents: vi.fn(() => null),
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
  toast: vi.fn(), toastDismiss: vi.fn(), toastHold: vi.fn(), toastRelease: vi.fn(),
  pixelConfirm: vi.fn(async () => false), isConfirmOpen: vi.fn(() => false),
  resolveConfirm: vi.fn(),
  useFeedbackState: vi.fn(() => ({ toasts: [], confirm: null })),
}))

import { mount, shallowMount } from '@vue/test-utils'
import App from '../../src/App.vue'
import TopNavigation from '../../src/components/TopNavigation.vue'
import PlaylistGrid from '../../src/components/PlaylistGrid.vue'
import { authState } from '../../src/lib/auth-state.js'
import { resetSyncState } from '../../src/lib/sync.js'

// jsdom 无 matchMedia——挂载期裸调模块补丁（menu-focus 同款）
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
}

// 服务端 /youtube/search 行形（与 yt-search-nav.spec 同一直喂形）
const ROW = (videoId, over = {}) => ({
  videoId, title: `曲-${videoId} (Official Video)`, author: `频道-${videoId} - Topic`,
  authorClean: `频道-${videoId}`, duration: 200,
  cover: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  songName: `曲-${videoId}`, matched: null, publishedAt: null,
  hasVideo: true, hasDownloadableVideo: true,
  channelId: `UC${videoId}`, publishedTimeText: '3 年前',
  ...over,
})
const YT_SONG = (id) => ({ // buildYouTubeSong 产出形（组件层只读 id/name/ar/al/dt）
  id, name: `曲-${id}`, ar: [{ name: '频道' }], al: { name: '', picUrl: '' }, dt: 200000,
})

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
beforeEach(() => {
  localStorage.clear()
  resetSyncState()
  resetAuthState()
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  resetSyncState()
  resetAuthState()
  document.body.innerHTML = ''
})

describe('App.vue：search-yt-songs 接线（缺口1）', () => {
  it('TopNavigation emit → handleYTSongSearch → searchSongResults 填充 + 深挖闸亮', async () => {
    musicApi.searchYouTubeSongs.mockResolvedValue({ items: [ROW('vid00000001')], continuation: 'tok-1' })
    wrapper = shallowMount(App)
    await vi.waitFor(() => expect(authState.booted).toBe(true))

    await wrapper.findComponent(TopNavigation).vm.$emit('search-yt-songs', 'lofi beats')
    await vi.waitFor(() => expect(wrapper.vm.searchSongResults.length).toBe(1))

    expect(musicApi.searchYouTubeSongs).toHaveBeenCalledWith('lofi beats', { limit: 20 })
    expect(wrapper.vm.searchSongResults[0].id).toBe('yt_vid00000001')
    expect(wrapper.vm.centerView).toBe('search')
    // 缺口2 透传面：YT 结果集 total 恒 null，但游标在场 → hasMore 亮灯
    expect(wrapper.vm.searchSongTotal).toBeNull()
    expect(wrapper.vm.searchSongHasMore).toBe(true)
    // 深挖键对 YT 结果集亮灯——PlaylistGrid 是 lazy 异步组件，shallowMount
    // 下 stub 未挂已解析 props 声明，绑定值落在 stub attrs 上断言
    const grid = wrapper.findComponent(PlaylistGrid)
    expect(grid.exists()).toBe(true)
    expect(grid.attributes('song-has-more')).toBe('true')
  })
})

describe('PlaylistGrid：songHasMore 深挖闸（缺口2）', () => {
  const mountGrid = (props) => mount(PlaylistGrid, {
    props: { results: [], query: 'kw', ...props },
    global: { stubs: { GlitchText: true, PixelIcon: true } },
  })

  it('YT 结果集（songTotal=null + songHasMore）→ 键亮、文案不带总数、点击 emit', async () => {
    wrapper = mountGrid({
      songs: [YT_SONG('yt_a')], songTotal: null, songHasMore: true,
    })
    await nextTick()
    const btn = wrapper.find('.grid-more')
    expect(btn.exists()).toBe(true)
    expect(btn.text()).toBe('加载更多歌曲 · 1') // 无总数源不报「n / null」
    await btn.trigger('click')
    expect(wrapper.emitted('load-more-songs')).toHaveLength(1)
  })

  it('游标收键（songHasMore=false + total=null）→ 不亮；total 源回归「n / total」', async () => {
    wrapper = mountGrid({
      songs: [YT_SONG('yt_a')], songTotal: null, songHasMore: false,
    })
    await nextTick()
    expect(wrapper.find('.grid-more').exists()).toBe(false) // YT 见底灭键
    await wrapper.unmount()

    wrapper = mountGrid({
      songs: [{ id: 7, name: 'n', ar: [{ name: 'a' }], al: {}, dt: 1000 }],
      songTotal: 61, songHasMore: true,
    })
    await nextTick()
    const btn = wrapper.find('.grid-more')
    expect(btn.exists()).toBe(true)
    expect(btn.text()).toBe('加载更多歌曲 · 1 / 61') // total 源文案不变
  })
})

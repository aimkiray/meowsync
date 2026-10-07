// WatchView 歌词工具条「歌词获取」组：获取/重取键恒在、生成滚动词键只在
// 纯文本词（全行非有限 time）时露脸；busy 文案与 disabled 由
// lyricFetching/songSwitching/loadingLyrics 透传；点击只发 emit（逻辑在
// usePlayer 侧，见 use-player.spec.mjs 手动词务用例）
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'

// 组件图依赖桩——挂载不打真服务端；相关曲/下载视频探测这两路
// （searchSongs/getSongDownloadStatus）在普通曲目 + queue tab 下本就不到，
// 桩只为防万一并接 import 链接
vi.mock('../../src/api/music.js', () => ({
  musicApi: {
    searchSongs: vi.fn(async () => []),
    bilibiliStreamUrl: vi.fn(() => 'https://x/bili'),
    youtubeStreamUrl: vi.fn(() => 'https://x/yt'),
  },
  parseLyrics: vi.fn(() => []),
  mergeTranslations: vi.fn((l) => l),
}))
vi.mock('../../src/api/downloads.js', () => ({
  downloadsApi: {
    getSongDownloadStatus: vi.fn(async () => null),
    songFileUrl: vi.fn(() => 'http://api/dl'),
  },
}))
vi.mock('../../src/lib/feedback.js', () => ({ toast: vi.fn() }))

import WatchView from '../../src/components/WatchView.vue'
import PixelIcon from '../../src/components/PixelIcon.vue'
import { musicApi } from '../../src/api/music.js'
import { downloadsApi } from '../../src/api/downloads.js'
import { prefVideoOn } from '../../src/lib/prefs.js'

// jsdom 缺口补丁：matchMedia（歌词跟随 watcher）、scrollIntoView/scrollTo
// （行居中）在生产浏览器都有，这里只保证存在不报错
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
}
if (typeof Element !== 'undefined') {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {}
}

const SONG = { id: 1, name: '歌1', ar: [{ name: '艺人' }], al: { picUrl: 'https://c/p.jpg' }, dt: 200000 }
const PLAIN_LYRICS = [{ time: Infinity, text: '一行' }, { time: Infinity, text: '二行' }]
const SYNCED_LYRICS = [{ time: 1, text: '一行' }, { time: 4, text: '二行' }]

const mountWatch = (props = {}) => mount(WatchView, {
  props: { currentSong: SONG, tab: 'lyrics', ...props },
})

// 工具条组按 aria-label 定位——字号/校准/获取三组并存，文案会改版，
// role=group 名是稳定锚
const fetchGroup = (w) => w.find('.lyric-tools-group[aria-label="歌词获取"]')
const fetchBtn = (w) => fetchGroup(w).findAll('button')[0]
const alignBtn = (w) => fetchGroup(w).findAll('button').find(b => b.text().includes('滚动词') || b.text().includes('生成中'))

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks() // 只清调用记录——vi.fn(impl) 的桩实现不受影响
  downloadsApi.getSongDownloadStatus.mockImplementation(async () => null)
  musicApi.youtubeStreamUrl.mockImplementation(() => 'https://x/yt')
})

describe('WatchView：歌词获取工具组', () => {
  it('无词时显「获取歌词」，点击发 lyric-fetch', async () => {
    const w = mountWatch({ lyrics: [] })
    const btn = fetchBtn(w)
    expect(btn.exists()).toBe(true)
    expect(btn.text()).toContain('获取歌词')
    expect(btn.attributes('disabled')).toBeUndefined()
    await btn.trigger('click')
    expect(w.emitted('lyric-fetch')).toHaveLength(1)
  })

  it('已有词时显「重新获取」', () => {
    const w = mountWatch({ lyrics: SYNCED_LYRICS })
    expect(fetchBtn(w).text()).toContain('重新获取')
  })

  it('纯文本词（无有限时间戳）→「生成滚动词」露脸，点击发 lyric-align', async () => {
    const w = mountWatch({ lyrics: PLAIN_LYRICS })
    const btn = alignBtn(w)
    expect(btn).toBeTruthy()
    expect(btn.text()).toContain('生成滚动词')
    await btn.trigger('click')
    expect(w.emitted('lyric-align')).toHaveLength(1)
  })

  it('滚动词在屏→生成滚动词键不渲染（再对齐是降级，入口直接消失）', () => {
    const w = mountWatch({ lyrics: SYNCED_LYRICS })
    expect(fetchGroup(w).exists()).toBe(true) // 组仍在（获取键恒在）
    expect(alignBtn(w)).toBeUndefined()
  })

  it('无词→生成滚动词键不渲染', () => {
    const w = mountWatch({ lyrics: [] })
    expect(alignBtn(w)).toBeUndefined()
  })

  it('lyricFetching busy：双键禁用 + busy 文案', () => {
    const w = mountWatch({ lyrics: PLAIN_LYRICS, lyricFetching: true })
    expect(fetchBtn(w).attributes('disabled')).toBeDefined()
    expect(fetchBtn(w).text()).toContain('获取中…')
    const btn = alignBtn(w)
    expect(btn.attributes('disabled')).toBeDefined()
    expect(btn.text()).toContain('生成中…')
  })

  it('songSwitching/loadingLyrics 期间禁用（透传同一切歌词在途语义）', () => {
    for (const flag of ['songSwitching', 'loadingLyrics']) {
      const w = mountWatch({ lyrics: PLAIN_LYRICS, [flag]: true })
      expect(fetchBtn(w).attributes('disabled')).toBeDefined()
      expect(alignBtn(w).attributes('disabled')).toBeDefined()
    }
  })

  it('无当前曲（currentSong=null）→整条工具条不渲染', () => {
    const w = mountWatch({ currentSong: null, lyrics: [] })
    expect(fetchGroup(w).exists()).toBe(false)
  })
})

describe('WatchView：顶行下载键', () => {
  // 键在 watch-actions 组内、分享键之后；busy/已下载态由 App 侧 props 透传，
  // 点击只发 emit——提交/镜像/轮询全在 usePlayer（见 use-player.spec.mjs）
  const dlBtn = (w) => w.find('.watch-actions button[title*="下载到服务器"]')

  it('当前曲可下载即亮键，点击发 download-song', async () => {
    const w = mountWatch({ tab: 'queue' })
    const btn = dlBtn(w)
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('disabled')).toBeUndefined()
    await btn.trigger('click')
    expect(w.emitted('download-song')).toHaveLength(1)
  })

  it('file_ 上传曲不亮键（资产本就在服务端）', () => {
    const w = mountWatch({
      tab: 'queue',
      currentSong: { id: 'file_abcd1234', name: 'f', ar: [], al: {}, dt: 0, file: { hasAudio: true } },
    })
    expect(dlBtn(w).exists()).toBe(false)
  })

  it('songDownloading busy：禁用 + 转圈 + 文案', () => {
    const w = mountWatch({ tab: 'queue', songDownloading: true })
    const btn = dlBtn(w)
    expect(btn.attributes('disabled')).toBeDefined()
    expect(btn.text()).toContain('下载中')
    expect(btn.find('.pixel-loading').exists()).toBe(true)
  })

  it('songDownloaded：✓态禁用', () => {
    const w = mountWatch({ tab: 'queue', songDownloaded: true })
    const btn = w.find('.watch-actions button[title="已下载到服务器"]')
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('disabled')).toBeDefined()
    expect(btn.text()).toContain('已下载')
  })
})

describe('WatchView：顶行沉浸键', () => {
  // 与底栏沉浸键同字形（同开 FullscreenPlayer）——钉键名防回退成只表
  // 「缩放」的 expand；path 非空顺带钉住 ICONS 注册
  it('渲染 fullscreen 图标，点击发 open-fullscreen', async () => {
    const w = mountWatch({ tab: 'queue' })
    const btn = w.find('.watch-actions button[title="全屏歌词模式"]')
    expect(btn.exists()).toBe(true)
    expect(btn.findComponent(PixelIcon).props('name')).toBe('fullscreen')
    expect(btn.find('svg path').attributes('d')).toBeTruthy()
    await btn.trigger('click')
    expect(w.emitted('open-fullscreen')).toHaveLength(1)
  })
})

describe('WatchView：yt 视频位在线流', () => {
  const YT_SONG = {
    id: 'yt_abcdefghijk', name: 'yt', ar: [{ name: 'a' }], al: {}, dt: 0,
    youtube: { videoId: 'abcdefghijk', hasVideo: true },
  }

  it('本地档缺席挂 /youtube/stream 在线流；探测未落地前不上屏', async () => {
    const w = mountWatch({ currentSong: YT_SONG, tab: 'queue' })
    await vi.waitFor(() =>
      expect(musicApi.youtubeStreamUrl).toHaveBeenCalledWith('abcdefghijk', 'video', '', 0))
    expect(w.vm.mediaVideoUrl).toBe('https://x/yt')
    expect(w.find('video').exists()).toBe(true)
    expect(w.find('video').attributes('src')).toBe('https://x/yt')
  })

  it('探测未落地时 yt 支返回空串（不提前撞 CDN）', async () => {
    let release
    downloadsApi.getSongDownloadStatus.mockImplementation(
      () => new Promise(r => { release = () => r(null) }))
    const w = mountWatch({ currentSong: YT_SONG, tab: 'queue' })
    await new Promise(r => setTimeout(r, 0)) // 让 watcher 跑到探测 await
    expect(w.vm.mediaVideoUrl).toBe('')
    expect(w.find('video').exists()).toBe(false)
    release()
    await vi.waitFor(() => expect(w.vm.mediaVideoUrl).toBe('https://x/yt'))
  })

  it('已下载视频档优先于在线流', async () => {
    downloadsApi.getSongDownloadStatus.mockResolvedValue(
      { data: { videoReady: true, videoPlaylistId: 7 } })
    downloadsApi.songFileUrl.mockImplementation(() => 'http://api/dl/7/yt_abcdefghijk')
    const w = mountWatch({ currentSong: YT_SONG, tab: 'queue' })
    await vi.waitFor(() => expect(w.vm.mediaVideoUrl).toBe('http://api/dl/7/yt_abcdefghijk'))
    expect(musicApi.youtubeStreamUrl).not.toHaveBeenCalled()
  })

  it('本地档视频错误 → 清档重探 → 回落在线流', async () => {
    downloadsApi.getSongDownloadStatus.mockResolvedValue(
      { data: { videoReady: true, videoPlaylistId: 7 } })
    downloadsApi.songFileUrl.mockImplementation(() => 'http://api/dl/7/yt_abcdefghijk')
    const w = mountWatch({ currentSong: YT_SONG, tab: 'queue' })
    await vi.waitFor(() => expect(w.vm.mediaVideoUrl).toBe('http://api/dl/7/yt_abcdefghijk'))
    // 本地档解码败 → onMediaVideoError 清档重探——探测再报无档 → yt 支落在线流
    downloadsApi.getSongDownloadStatus.mockResolvedValue(null)
    w.find('video').element.dispatchEvent(new Event('error'))
    await vi.waitFor(() => expect(w.vm.mediaVideoUrl).toBe('https://x/yt'))
    expect(musicApi.youtubeStreamUrl).toHaveBeenCalledWith('abcdefghijk', 'video', '', 0)
  })

  it('hasPlayableVideo：yt 有 videoId 即计入可放（与 bv 乐观放行同口径）', async () => {
    const w = mountWatch({ currentSong: YT_SONG, tab: 'queue' })
    await vi.waitFor(() => expect(w.vm.hasPlayableVideo).toBe(true))
    // 音画切换 title 只在 videoOn=false 时落到「切到视频模式」支——
    // 直接翻模块级偏好 ref（localStorage 换名不回读），用毕归位
    const prev = prefVideoOn.value
    prefVideoOn.value = false
    await nextTick()
    const toggle = w.find('.watch-actions button[title*="切到视频模式"]')
    expect(toggle.exists()).toBe(true)
    expect(toggle.attributes('title')).not.toContain('需已下载视频档')
    prefVideoOn.value = prev
  })
})

describe('WatchView：yt_ 裸 id（缺 provider 对象老行）视频位', () => {
  // videoId 内嵌在 id 里——切换键/键值/可放判定/探测门/在线位五处与
  // bv_ 裸 id 同型防御（usePlayer 音频链同款 ytM）
  const BARE_YT = { id: 'yt_abcdefghijk', name: 'yt', ar: [{ name: 'a' }], al: {}, dt: 0 }

  it('音画切换键按 id 形态出键，可点', async () => {
    const w = mountWatch({ currentSong: BARE_YT, tab: 'queue' })
    const toggle = w.find('.watch-actions button[title*="切到"]')
    expect(toggle.exists()).toBe(true)
    await toggle.trigger('click')
    expect(prefVideoOn.value).toBe(false) // 键活着：点击翻转共享偏好
    prefVideoOn.value = true              // 归位默认开
  })

  it('音画切换键：文案=目标动作，aria-label 自带当前态（pressed 已撤）', async () => {
    const prev = prefVideoOn.value
    prefVideoOn.value = true // 显式视频态（不赌模块序默认值）
    const w = mountWatch({ currentSong: BARE_YT, tab: 'queue' })
    const toggle = w.find('.watch-actions button[title*="切到"]')
    // 视频态：文案=目标「音频」，态指示由 --on/aria-label 承担
    expect(toggle.text()).toContain('音频')
    expect(toggle.attributes('aria-pressed')).toBeUndefined() // pressed 报态+目标文案=播报矛盾
    expect(toggle.attributes('aria-label')).toBe('音画切换，当前视频模式，切到纯音频（省流量）')
    prefVideoOn.value = false // 翻音频态：文案转目标「视频」
    await nextTick()
    expect(toggle.text()).toContain('视频')
    expect(toggle.attributes('aria-label')).toContain('当前音频模式')
    prefVideoOn.value = prev // 归位
  })

  it('mediaVideoKey/hasPlayableVideo 按 id 内嵌 videoId 成立', async () => {
    const w = mountWatch({ currentSong: BARE_YT, tab: 'queue' })
    await vi.waitFor(() => expect(w.vm.mediaVideoKey).toBe('yt:abcdefghijk'))
    expect(w.vm.hasPlayableVideo).toBe(true)
  })

  it('探测门放行且在线位 URL 用 id 内嵌 videoId（ytM[1]）', async () => {
    const w = mountWatch({ currentSong: BARE_YT, tab: 'queue' })
    await vi.waitFor(() =>
      expect(musicApi.youtubeStreamUrl).toHaveBeenCalledWith('abcdefghijk', 'video', '', 0))
    // probeable 过闸才打 status 探测——缺这环等于探测门没认裸 id
    expect(downloadsApi.getSongDownloadStatus).toHaveBeenCalled()
    expect(w.vm.mediaVideoUrl).toBe('https://x/yt')
    expect(w.find('video').attributes('src')).toBe('https://x/yt')
  })
})

describe('WatchView：音画切换降级支（hasPlayableVideo=false 残余形）', () => {
  // bilibili 对象在但 hasVideo=false、无本地视频档（探测桩回 null）——
  // 键照出（按 bvid 存在性出键），可放判定却五支全空：title/label 落
  // 第三支「需已下载视频档」降级提示，不乐观放行
  const BV_NO_VIDEO = {
    id: 2, name: 'bv', ar: [{ name: 'a' }], al: {}, dt: 0,
    bilibili: { bvid: 'BV1xx411c7mD', cid: 100, hasVideo: false },
  }

  it('音频态 → title/aria-label 含「需已下载视频档」', () => {
    const prev = prefVideoOn.value
    prefVideoOn.value = false // 降级支只在音频态（目标=视频）落到 title
    const w = mountWatch({ currentSong: BV_NO_VIDEO, tab: 'queue' })
    expect(w.vm.hasPlayableVideo).toBe(false) // 钉住残余形本身（非只测文案串）
    const toggle = w.find('.watch-actions button[title*="切到"]')
    expect(toggle.exists()).toBe(true)
    expect(toggle.attributes('title')).toBe('切到视频模式（需已下载视频档）')
    expect(toggle.attributes('aria-label')).toBe('音画切换，当前音频模式，切到视频模式（需已下载视频档）')
    prefVideoOn.value = prev // 归位
  })
})

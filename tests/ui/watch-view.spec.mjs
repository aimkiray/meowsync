// WatchView 歌词工具条「歌词获取」组：获取/重取键恒在、生成滚动词键只在
// 纯文本词（全行非有限 time）时露脸；busy 文案与 disabled 由
// lyricFetching/songSwitching/loadingLyrics 透传；点击只发 emit（逻辑在
// usePlayer 侧，见 use-player.spec.mjs 手动词务用例）
import { describe, it, expect, vi, beforeEach } from 'vitest'
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

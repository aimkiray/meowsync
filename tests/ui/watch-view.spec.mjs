// WatchView 歌词工具条「歌词获取」组：获取/重取键恒在、生成滚动词键只在
// 纯文本词（全行非有限 time）时露脸；busy 文案与 disabled 由
// lyricFetching/songSwitching/loadingLyrics 透传；点击只发 emit（逻辑在
// usePlayer 侧，见 use-player.spec.mjs 手动词务用例）。
// 另钉 ⋯ 溢出菜单：触发键常驻页头行 .watch-head 右端（舞台化后不再叠
// 媒体角标），操作项全量收进 teleport 菜单（音画 radio 组/沉浸/分享/
// 下载/回源），落位/开合/焦点/条件闸断言见下方各 describe
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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

// attachTo 入文档：菜单 Teleport 到 body + 开即焦首项，焦点断言要真挂载；
// 每例可挂多枚 wrapper（透传循环用例），统一收进 mounted 逐个 unmount
const mounted = []
const mountWatch = (props = {}) => {
  const w = mount(WatchView, {
    attachTo: document.body,
    props: { currentSong: SONG, tab: 'lyrics', ...props },
  })
  mounted.push(w)
  return w
}
afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  document.body.innerHTML = '' // teleport 菜单兜底清场（unmount 本就该收走）
})

// ⋯ 菜单 teleport 到 body——菜单/菜单项查询一律走 document；触发键在组件内
const menuTrigger = (w) => w.find('.watch-menu-btn')
const openActionsMenu = async (w) => {
  await menuTrigger(w).trigger('click')
  await nextTick()
  return document.querySelector('#watch-actions-menu')
}
const menuEl = () => document.querySelector('#watch-actions-menu')
const menuItems = () => [...document.querySelectorAll('#watch-actions-menu .pg-menu-item')]
const menuItemByTitle = (t) => document.querySelector(`#watch-actions-menu [title*="${t}"]`)
const menuItemByText = (txt) => menuItems().find(el => el.textContent.includes(txt))
const avRadios = () => [...document.querySelectorAll('#watch-actions-menu [role="menuitemradio"]')]
const clickEl = async (el) => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await nextTick()
}

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

describe('WatchView：⋯ 菜单开合与焦点', () => {
  // 范式对表 TopNav ⋯ 菜单（menu-focus.spec.mjs 同套断言口径）：
  // 触发键 aria 契约、开即焦首项、Esc/外点关、焦点归还
  it('触发键 aria-haspopup/controls/expanded 契约 + 开即焦首项', async () => {
    const w = mountWatch({ tab: 'queue' })
    const trigger = menuTrigger(w)
    expect(trigger.exists()).toBe(true)
    expect(trigger.attributes('aria-haspopup')).toBe('menu')
    expect(trigger.attributes('aria-controls')).toBe('watch-actions-menu')
    expect(trigger.attributes('aria-expanded')).toBe('false')
    expect(trigger.attributes('aria-label')).toBe('更多操作')

    const menu = await openActionsMenu(w)
    expect(menu).toBeTruthy()
    expect(trigger.attributes('aria-expanded')).toBe('true')
    // SONG（网易id）无视频位——音画组缺席，首项=沉浸
    expect(document.activeElement).toBe(menu.querySelector('.pg-menu-item'))
    expect(document.activeElement.textContent).toContain('沉浸')
  })

  it('Esc 关菜单并归还焦点触发键（焦点在菜单内时）', async () => {
    const w = mountWatch({ tab: 'queue' })
    const trigger = menuTrigger(w)
    await openActionsMenu(w)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()
    expect(menuEl()).toBeNull()
    expect(document.activeElement).toBe(trigger.element)
  })

  it('焦点已挪出菜单时 Esc 只关菜单、不强拽回 ⋯键', async () => {
    const w = mountWatch({ tab: 'queue' })
    await openActionsMenu(w)
    const out = document.createElement('button')
    document.body.appendChild(out)
    out.focus()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()
    expect(menuEl()).toBeNull()
    expect(document.activeElement).toBe(out)
  })

  it('已消费 Esc（defaultPrevented 戳）不收菜单——一键只收一层', async () => {
    const stamp = (e) => { if (e.key === 'Escape') e.preventDefault() }
    // stamp 先于挂载注册——序与 App onGlobalKeydown 一致（先注册先跑）
    window.addEventListener('keydown', stamp)
    try {
      const w = mountWatch({ tab: 'queue' })
      await openActionsMenu(w)
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      await nextTick()
      expect(menuEl()).toBeTruthy() // 让位不双收
    } finally { window.removeEventListener('keydown', stamp) }
  })

  it('pointerdown 落在菜单/触发键之外即关', async () => {
    const w = mountWatch({ tab: 'queue' })
    await openActionsMenu(w)
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    await nextTick()
    expect(menuEl()).toBeNull()
  })

  it('menuitemradio 点选：切偏好 + 关菜单归还焦点（主题 pick 同型）', async () => {
    const prev = prefVideoOn.value
    try {
      prefVideoOn.value = true
      const w = mountWatch({
        tab: 'queue',
        currentSong: { id: 'yt_abcdefghijk', name: 'yt', ar: [{ name: 'a' }], al: {}, dt: 0, youtube: { videoId: 'abcdefghijk', hasVideo: true } },
      })
      const trigger = menuTrigger(w)
      const menu = await openActionsMenu(w)
      const group = menu.querySelector('[role="group"][aria-label="音画模式"]')
      expect(group).toBeTruthy()
      const audio = avRadios().find(el => el.textContent.includes('音频'))
      await clickEl(audio)
      expect(prefVideoOn.value).toBe(false) // 点选翻共享偏好
      expect(menuEl()).toBeNull()           // 不能只切态不关菜单
      expect(document.activeElement).toBe(trigger.element)
    } finally { prefVideoOn.value = prev } // 断言挂也归位，不污染后续用例
  })
})

describe('WatchView：⋯ 触发键落位', () => {
  const YT_SONG = {
    id: 'yt_abcdefghijk', name: 'yt', ar: [{ name: 'a' }], al: {}, dt: 0,
    youtube: { videoId: 'abcdefghijk', hasVideo: true },
  }

  it('常驻页头行 .watch-head 右端——全态可见、不叠媒体（舞台化后的固定触发位）', () => {
    const w = mountWatch({ tab: 'queue' })
    const head = w.find('.watch-head')
    expect(head.exists()).toBe(true)
    const btn = head.find('.watch-menu-btn')
    expect(btn.exists()).toBe(true)
    // 媒体区不再叠触发键——旧 wrap 角标位（三形态共用一枚）退役
    expect(w.find('.watch-cover-wrap .watch-menu-btn').exists()).toBe(false)
    // 返回键同处页头行（左右各一）
    expect(head.find('.watch-back').exists()).toBe(true)
  })

  it('视频态仍驻页头、不随 controlsVisible 消隐（旧 --video/--on 键族退役）', async () => {
    const prev = prefVideoOn.value
    try {
      prefVideoOn.value = true
      const w = mountWatch({ currentSong: YT_SONG, tab: 'queue' })
      await vi.waitFor(() => expect(w.find('video').exists()).toBe(true))
      const btn = w.find('.watch-head .watch-menu-btn')
      expect(btn.exists()).toBe(true)
      // 键族修饰类不再挂——页头触发键常显，无模式变体
      expect(btn.classes()).not.toContain('watch-menu-btn--video')
      expect(btn.classes()).not.toContain('watch-menu-btn--on')
    } finally { prefVideoOn.value = prev }
  })
})

describe('WatchView：⋯菜单下载项', () => {
  // 项在 teleport 菜单内、分享项之后；busy/已下载态由 App 侧 props 透传，
  // 点击只发 emit——提交/镜像/轮询全在 usePlayer（见 use-player.spec.mjs）
  const dlItem = () => menuItemByTitle('下载到服务器') // title 子串同吃「已下载到服务器」

  it('当前曲可下载即亮项，点击发 download-song 并关菜单', async () => {
    const w = mountWatch({ tab: 'queue' })
    await openActionsMenu(w)
    const item = dlItem()
    expect(item).toBeTruthy()
    expect(item.hasAttribute('disabled')).toBe(false)
    await clickEl(item)
    expect(w.emitted('download-song')).toHaveLength(1)
    expect(menuEl()).toBeNull()
  })

  it('file_ 上传曲不亮项（资产本就在服务端）；分享同挂 file_ 闸', async () => {
    const w = mountWatch({
      tab: 'queue',
      currentSong: { id: 'file_abcd1234', name: 'f', ar: [], al: {}, dt: 0, file: { hasAudio: true } },
    })
    await openActionsMenu(w)
    expect(dlItem()).toBeNull()
    expect(menuItemByText('分享歌曲')).toBeUndefined()
    expect(avRadios().length).toBe(0) // hasAudio-only 曲也无音画组
  })

  it('songDownloading busy：禁用 + 转圈 + 文案', async () => {
    const w = mountWatch({ tab: 'queue', songDownloading: true })
    await openActionsMenu(w)
    const item = dlItem()
    expect(item.hasAttribute('disabled')).toBe(true)
    expect(item.textContent).toContain('下载中')
    expect(item.querySelector('.pixel-loading')).toBeTruthy()
  })

  it('songDownloaded：✓态禁用', async () => {
    const w = mountWatch({ tab: 'queue', songDownloaded: true })
    await openActionsMenu(w)
    const item = document.querySelector('#watch-actions-menu [title="已下载到服务器"]')
    expect(item).toBeTruthy()
    expect(item.hasAttribute('disabled')).toBe(true)
    expect(item.textContent).toContain('已下载')
  })
})

describe('WatchView：⋯菜单沉浸项', () => {
  // 与底栏沉浸键同字形（同开 FullscreenPlayer）——钉键名防回退成只表
  // 「缩放」的 expand；path 非空顺带钉住 ICONS 注册
  it('渲染 fullscreen 图标，点击发 open-fullscreen 并关菜单', async () => {
    const w = mountWatch({ tab: 'queue' })
    await openActionsMenu(w)
    const el = document.querySelector('#watch-actions-menu [title="全屏歌词模式"]')
    expect(el).toBeTruthy()
    // findComponent 跨 teleport 仍认组件树——按 DOM 归属过滤出菜单里那枚
    const icon = w.findAllComponents(PixelIcon).find(c => el.contains(c.element))
    expect(icon.props('name')).toBe('fullscreen')
    expect(el.querySelector('svg path').getAttribute('d')).toBeTruthy()
    await clickEl(el)
    expect(w.emitted('open-fullscreen')).toHaveLength(1)
    expect(menuEl()).toBeNull()
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
    // 「切到视频模式」提示只落在 videoOn=false 时视频 radio 项的 title——
    // 直接翻模块级偏好 ref（localStorage 换名不回读），用毕归位
    const prev = prefVideoOn.value
    try {
      prefVideoOn.value = false
      await openActionsMenu(w)
      const video = avRadios().find(el => el.textContent.includes('视频'))
      expect(video).toBeTruthy()
      expect(video.getAttribute('title')).toContain('切到视频模式')
      expect(video.getAttribute('title')).not.toContain('需已下载视频档')
    } finally { prefVideoOn.value = prev }
  })
})

describe('WatchView：yt_ 裸 id（缺 provider 对象老行）视频位', () => {
  // videoId 内嵌在 id 里——音画组/键值/可放判定/探测门/在线位五处与
  // bv_ 裸 id 同型防御（usePlayer 音频链同款 ytM）
  const BARE_YT = { id: 'yt_abcdefghijk', name: 'yt', ar: [{ name: 'a' }], al: {}, dt: 0 }

  it('音画模式组按 id 形态出组，radio 可点选', async () => {
    try {
      const w = mountWatch({ currentSong: BARE_YT, tab: 'queue' })
      await openActionsMenu(w)
      const radios = avRadios()
      expect(radios).toHaveLength(2)
      const audio = radios.find(el => el.textContent.includes('音频'))
      await clickEl(audio)
      expect(prefVideoOn.value).toBe(false) // 组活着：点选翻转共享偏好
    } finally { prefVideoOn.value = true } // 归位默认开（断言挂也不污染后续用例）
  })

  it('音画 radio 双项：键面=模式名，aria-checked 报当前态', async () => {
    const prev = prefVideoOn.value
    try {
      prefVideoOn.value = true // 显式视频态（不赌模块序默认值）
      const w = mountWatch({ currentSong: BARE_YT, tab: 'queue' })
      await openActionsMenu(w)
      const audio = avRadios().find(el => el.textContent.includes('音频'))
      const video = avRadios().find(el => el.textContent.includes('视频'))
      // 视频态：态指示由 aria-checked/✓ 槽承担，动作提示落目标项 title
      expect(audio.getAttribute('aria-checked')).toBe('false')
      expect(video.getAttribute('aria-checked')).toBe('true')
      expect(audio.getAttribute('title')).toBe('切到纯音频（省流量）')
      expect(video.getAttribute('title')).toBeNull() // 当前态项不给「切到」动作提示
      prefVideoOn.value = false // 翻音频态：✓ 转音频项，「切到视频」提示换位
      await nextTick()
      expect(audio.getAttribute('aria-checked')).toBe('true')
      expect(video.getAttribute('aria-checked')).toBe('false')
      expect(audio.getAttribute('title')).toBeNull()
      expect(video.getAttribute('title')).toContain('切到视频模式')
    } finally { prefVideoOn.value = prev } // 归位
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

describe('WatchView：音画组降级支（hasPlayableVideo=false 残余形）', () => {
  // bilibili 对象在但 hasVideo=false、无本地视频档（探测桩回 null）——
  // 组照出（按 bvid 存在性出组），可放判定却五支全空：视频项 title 落
  // 第三支「需已下载视频档」降级提示，不乐观放行
  const BV_NO_VIDEO = {
    id: 2, name: 'bv', ar: [{ name: 'a' }], al: {}, dt: 0,
    bilibili: { bvid: 'BV1xx411c7mD', cid: 100, hasVideo: false },
  }

  it('音频态 → 视频 radio 项 title 含「需已下载视频档」', async () => {
    const prev = prefVideoOn.value
    try {
      prefVideoOn.value = false // 降级支只在音频态（目标=视频）落到该项 title
      const w = mountWatch({ currentSong: BV_NO_VIDEO, tab: 'queue' })
      expect(w.vm.hasPlayableVideo).toBe(false) // 钉住残余形本身（非只测文案串）
      await openActionsMenu(w)
      const video = avRadios().find(el => el.textContent.includes('视频'))
      expect(video).toBeTruthy()
      expect(video.getAttribute('title')).toBe('切到视频模式（需已下载视频档）')
    } finally { prefVideoOn.value = prev } // 归位
  })
})

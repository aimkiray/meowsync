// WatchView 歌词工具条「歌词获取」组：获取/重取键恒在、生成滚动词键只在
// 纯文本词（全行非有限 time）时露脸；busy 文案与 disabled 由
// lyricFetching/songSwitching/loadingLyrics 透传；点击只发 emit（逻辑在
// usePlayer 侧，见 use-player.spec.mjs 手动词务用例）。
// 另钉 ⋯ 溢出菜单：触发键常驻页头行 .watch-head（舞台化后不再叠媒体
// 角标；页头序=返回→⋯→音画分段，分段居右缘角位），操作项全量收进
// teleport 菜单（沉浸/分享/收藏到歌单/下载/回源——音画组已上移顶栏
// 常驻 .watch-av 分段，菜单只剩一次性操作项），落位/开合/焦点/条件闸
// 断言见下方各 describe
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
    // 「换源」弹层四件——SourcePicker 挂载即发前两件；默认空池未绑
    getUnlockCandidates: vi.fn(async () => ({ keyword: '', candidates: [], errors: [] })),
    getManualUnlock: vi.fn(async () => null),
    pickManualUnlock: vi.fn(async () => ({ code: 200, hit: {} })),
    clearManualUnlock: vi.fn(async () => ({ code: 200 })),
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
// usePlayer 半桩：WatchView 的 picker applied 回调走动态 import 单槽
// （notifyUnlockManualChange）——桩成 vi.fn() 断言载荷，同 menu-focus
// 谱先例；静态图不挂 howler/api 依赖
vi.mock('../../src/composables/usePlayer.js', () => ({
  notifyUnlockManualChange: vi.fn(),
}))

import WatchView from '../../src/components/WatchView.vue'
import PixelIcon from '../../src/components/PixelIcon.vue'
import { musicApi } from '../../src/api/music.js'
import { downloadsApi } from '../../src/api/downloads.js'
import { prefVideoOn } from '../../src/lib/prefs.js'
import { toast } from '../../src/lib/feedback.js'
import { notifyUnlockManualChange } from '../../src/composables/usePlayer.js'

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
// 顶栏音画分段键（原 ⋯ 菜单 menuitemradio 组上移——菜单内已无 radio 项）
const avSegBtns = (w) => w.findAll('.watch-av-btn')
const menuRadios = () => [...document.querySelectorAll('#watch-actions-menu [role="menuitemradio"]')]
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
  prefVideoOn.value = true // 模块级偏好显式归位——上游用例归还漏不致真空断言
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
    // SONG（网易id）无视频位——顶栏分段与菜单音画组双缺席，首项=沉浸
    expect(w.find('.watch-av').exists()).toBe(false)
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

  it('音画分段即点即切：顶栏常驻、不涉菜单开合；菜单内已无音画组', async () => {
    const prev = prefVideoOn.value
    try {
      prefVideoOn.value = true
      const w = mountWatch({
        tab: 'queue',
        currentSong: { id: 'yt_abcdefghijk', name: 'yt', ar: [{ name: 'a' }], al: {}, dt: 0, youtube: { videoId: 'abcdefghijk', hasVideo: true } },
      })
      // 分段常驻页头行——开不开菜单都在；互斥单选语义=radiogroup/radio
      const seg = w.find('.watch-head .watch-av')
      expect(seg.exists()).toBe(true)
      expect(seg.attributes('role')).toBe('radiogroup')
      expect(seg.attributes('aria-label')).toBe('音画模式')
      const audio = avSegBtns(w).find(b => b.text().includes('音频'))
      expect(audio.attributes('role')).toBe('radio')
      await audio.trigger('click')
      expect(prefVideoOn.value).toBe(false) // 点选翻共享偏好
      await nextTick()
      expect(audio.attributes('aria-checked')).toBe('true')
      // 单一归属：菜单里不再有音画 radio 组，开菜单首项=沉浸
      const menu = await openActionsMenu(w)
      expect(menu.querySelector('[aria-label="音画模式"]')).toBeNull()
      expect(menuRadios()).toHaveLength(0)
      expect(document.activeElement.textContent).toContain('沉浸')
    } finally { prefVideoOn.value = prev } // 断言挂也归位，不污染后续用例
  })
})

describe('WatchView：⋯ 触发键落位', () => {
  const YT_SONG = {
    id: 'yt_abcdefghijk', name: 'yt', ar: [{ name: 'a' }], al: {}, dt: 0,
    youtube: { videoId: 'abcdefghijk', hasVideo: true },
  }

  it('常驻页头行 .watch-head——⋯ 居分段左、分段居右缘角位；全态可见、不叠媒体（舞台化后的固定触发位）', () => {
    // YT 曲出分段——次序钉要有 .watch-av 在场（默认曲无视频位不出组）
    const w = mountWatch({ tab: 'queue', currentSong: YT_SONG })
    const head = w.find('.watch-head')
    expect(head.exists()).toBe(true)
    const btn = head.find('.watch-menu-btn')
    expect(btn.exists()).toBe(true)
    // 次序钉：分段是 head 末位元素（右缘角位）、⋯ 触发键紧贴其左
    const seg = head.find('.watch-av')
    expect(seg.exists()).toBe(true)
    expect(seg.element.nextElementSibling).toBeNull()
    expect(btn.element.nextElementSibling).toBe(seg.element)
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
    expect(menuRadios().length).toBe(0) // hasAudio-only 曲顶栏也不出分段
    expect(w.find('.watch-av').exists()).toBe(false)
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
  // 与底栏沉浸键同字形（同开 FullscreenPlayer）——钉 flask 键名防回退成只表
  // 「缩放」的 expand；path 非空顺带钉住 ICONS 注册
  it('渲染 flask 图标，点击发 open-fullscreen 并关菜单', async () => {
    const w = mountWatch({ tab: 'queue' })
    await openActionsMenu(w)
    const el = document.querySelector('#watch-actions-menu [title="全屏歌词模式"]')
    expect(el).toBeTruthy()
    // findComponent 跨 teleport 仍认组件树——按 DOM 归属过滤出菜单里那枚
    const icon = w.findAllComponents(PixelIcon).find(c => el.contains(c.element))
    expect(icon.props('name')).toBe('flask')
    expect(el.querySelector('svg path').getAttribute('d')).toBeTruthy()
    await clickEl(el)
    expect(w.emitted('open-fullscreen')).toHaveLength(1)
    expect(menuEl()).toBeNull()
  })
})

describe('WatchView：⋯菜单收藏到歌单项', () => {
  // 当前曲入本地歌单：项恒在只按 currentSong 禁能——file_ 上传曲也能进本地
  // 歌单（分享/下载的 file_ 遮挡是「无源链/无上游可下」硬限制，收藏无此限；
  // SongList 行级入口同律）。载荷=整曲对象，App 侧弹 atp 选单窗
  it('落位分享与下载之间（当前曲操作簇内聚），渲染 playlist 图标', async () => {
    const w = mountWatch({ tab: 'queue' })
    await openActionsMenu(w)
    const el = menuItemByTitle('收藏到歌单')
    expect(el).toBeTruthy()
    expect(el.hasAttribute('disabled')).toBe(false)
    const icon = w.findAllComponents(PixelIcon).find(c => el.contains(c.element))
    expect(icon.props('name')).toBe('playlist')
    const texts = menuItems().map(i => i.textContent)
    const at = texts.findIndex(t => t.includes('收藏到歌单'))
    expect(texts.findIndex(t => t.includes('分享歌曲'))).toBeLessThan(at)
    expect(at).toBeLessThan(texts.findIndex(t => t.includes('下载')))
  })

  it('点击发 add-to-playlist（载荷=currentSong 整曲 + ⋯触发键归还锚）并关菜单', async () => {
    const w = mountWatch({ tab: 'queue' })
    await openActionsMenu(w)
    await clickEl(menuItemByTitle('收藏到歌单'))
    expect(w.emitted('add-to-playlist')).toHaveLength(1)
    // 载荷须就是 currentSong 本体（VTU 挂载 props 走 reactive——与挂载入参
    // 同指是代理对代理比，故比锚 vm.currentSong 而非 SONG 字面量）
    expect(w.emitted('add-to-playlist')[0][0]).toBe(w.vm.currentSong)
    // 第二参=⋅⋅⋅触发键：menuitem 随菜单卸载即死，openAddToPlaylist 的
    // activeElement 兜底会吃死锚——SongList 行菜单同款传参形
    expect(w.emitted('add-to-playlist')[0][1]).toBe(menuTrigger(w).element)
    expect(menuEl()).toBeNull()
    expect(document.activeElement).toBe(menuTrigger(w).element) // 焦点已还触发键
  })

  it('currentSong=null → 项仍渲染但禁用（与沉浸项同律只禁不藏）', async () => {
    const w = mountWatch({ tab: 'queue', currentSong: null })
    await openActionsMenu(w)
    const el = menuItemByTitle('收藏到歌单')
    expect(el).toBeTruthy()
    expect(el.hasAttribute('disabled')).toBe(true)
  })

  it('file_ 上传曲仍亮项可点（本地歌单可收）——与分享/下载的 file_ 遮挡不同', async () => {
    const FILE_SONG = { id: 'file_abcd1234', name: 'f', ar: [], al: {}, dt: 0, file: { hasAudio: true } }
    const w = mountWatch({ tab: 'queue', currentSong: FILE_SONG })
    await openActionsMenu(w)
    const el = menuItemByTitle('收藏到歌单')
    expect(el).toBeTruthy()
    expect(el.hasAttribute('disabled')).toBe(false)
    await clickEl(el)
    expect(w.emitted('add-to-playlist')[0][0]).toBe(w.vm.currentSong)
    expect(w.emitted('add-to-playlist')[0][0].id).toBe(FILE_SONG.id)
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
    // 「切到视频模式」提示只落在 videoOn=false 时视频分段键的 title——
    // 直接翻模块级偏好 ref（localStorage 换名不回读），用毕归位
    const prev = prefVideoOn.value
    try {
      prefVideoOn.value = false
      await nextTick()
      const video = avSegBtns(w).find(b => b.text().includes('视频'))
      expect(video).toBeTruthy()
      expect(video.attributes('title')).toContain('切到视频模式')
      expect(video.attributes('title')).not.toContain('需已下载视频档')
    } finally { prefVideoOn.value = prev }
  })
})

describe('WatchView：yt_ 裸 id（缺 provider 对象老行）视频位', () => {
  // videoId 内嵌在 id 里——音画分段/键值/可放判定/探测门/在线位五处与
  // bv_ 裸 id 同型防御（usePlayer 音频链同款 ytM）
  const BARE_YT = { id: 'yt_abcdefghijk', name: 'yt', ar: [{ name: 'a' }], al: {}, dt: 0 }

  it('音画分段按 id 形态出组，双档可点选', async () => {
    try {
      const w = mountWatch({ currentSong: BARE_YT, tab: 'queue' })
      await nextTick()
      const btns = avSegBtns(w)
      expect(btns).toHaveLength(2)
      const audio = btns.find(b => b.text().includes('音频'))
      await audio.trigger('click')
      expect(prefVideoOn.value).toBe(false) // 分段活着：点选翻转共享偏好
    } finally { prefVideoOn.value = true } // 归位默认开（断言挂也不污染后续用例）
  })

  it('音画分段双档：键面=模式名，radio/aria-checked 报当前态', async () => {
    const prev = prefVideoOn.value
    try {
      prefVideoOn.value = true // 显式视频态（不赌模块序默认值）
      const w = mountWatch({ currentSong: BARE_YT, tab: 'queue' })
      await nextTick()
      const audio = avSegBtns(w).find(b => b.text().includes('音频'))
      const video = avSegBtns(w).find(b => b.text().includes('视频'))
      // 互斥单选语义：两键 role=radio，aria-checked 互斥（无 aria-pressed）
      expect(audio.attributes('role')).toBe('radio')
      expect(video.attributes('role')).toBe('radio')
      // 视频态：态指示由 aria-checked/--on 承担，动作提示落目标项 title
      expect(audio.attributes('aria-checked')).toBe('false')
      expect(video.attributes('aria-checked')).toBe('true')
      expect(audio.attributes('aria-pressed')).toBeUndefined()
      expect(video.attributes('aria-pressed')).toBeUndefined()
      expect(audio.attributes('title')).toBe('切到纯音频（省流量）')
      expect(video.attributes('title')).toBeUndefined() // 当前态项不给「切到」动作提示
      prefVideoOn.value = false // 翻音频态：on 转音频键，「切到视频」提示换位
      await nextTick()
      expect(audio.attributes('aria-checked')).toBe('true')
      expect(video.attributes('aria-checked')).toBe('false')
      expect(audio.attributes('title')).toBeUndefined()
      expect(video.attributes('title')).toContain('切到视频模式')
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

describe('WatchView：音画分段降级支（hasPlayableVideo=false 残余形）', () => {
  // bilibili 对象在但 hasVideo=false、无本地视频档（探测桩回 null）——
  // 组照出（按 bvid 存在性出组），可放判定却五支全空：视频键 title 落
  // 第三支「需已下载视频档」降级提示，不乐观放行
  const BV_NO_VIDEO = {
    id: 2, name: 'bv', ar: [{ name: 'a' }], al: {}, dt: 0,
    bilibili: { bvid: 'BV1xx411c7mD', cid: 100, hasVideo: false },
  }

  it('音频态 → 视频分段键 title 含「需已下载视频档」', async () => {
    const prev = prefVideoOn.value
    try {
      prefVideoOn.value = false // 降级支只在音频态（目标=视频）落到该键 title
      const w = mountWatch({ currentSong: BV_NO_VIDEO, tab: 'queue' })
      expect(w.vm.hasPlayableVideo).toBe(false) // 钉住残余形本身（非只测文案串）
      await nextTick()
      const video = avSegBtns(w).find(b => b.text().includes('视频'))
      expect(video).toBeTruthy()
      expect(video.attributes('title')).toBe('切到视频模式（需已下载视频档）')
    } finally { prefVideoOn.value = prev } // 归位
  })
})

describe('WatchView：播放错误/时长警告走全局 toast', () => {
  // 行内 banner 退役（桌面容器裁口下被切半）——prop 落地即弹一次；
  // 清空是状态复位不追弹，挂载残留不重复弹（无 immediate）
  it('playbackError 落地弹 error toast，清空不追弹', async () => {
    const w = mountWatch({ tab: 'queue' })
    expect(toast).not.toHaveBeenCalled()
    await w.setProps({ playbackError: '音频加载失败，点击播放键或重新点歌可重试' })
    expect(toast).toHaveBeenCalledWith('音频加载失败，点击播放键或重新点歌可重试', 'error')
    await w.setProps({ playbackError: '' })
    expect(toast).toHaveBeenCalledTimes(1)
  })

  it('durationWarning 落地弹 info toast（feedback 无 warn 类型）', async () => {
    const w = mountWatch({ tab: 'queue' })
    await w.setProps({ durationWarning: '在线源仍在下载——完成后可重播' })
    expect(toast).toHaveBeenCalledWith('在线源仍在下载——完成后可重播', 'info')
    expect(toast).not.toHaveBeenCalledWith(expect.anything(), 'error')
  })

  it('挂载即带残留值不弹（横幅是状态语义，toast 是事件语义）', () => {
    mountWatch({ tab: 'queue', playbackError: '残留错误', durationWarning: '残留警告' })
    expect(toast).not.toHaveBeenCalled()
  })
})

describe('WatchView：⋯菜单换源项', () => {
  // 「换源」=手动媒体源绑定入口——数值曲修「解锁链错配」（resolveOne
  // 手动步消费），qq_/bv_/yt_ 自有源曲修「自有源败亡」（三个自有源
  // 流端点失败触发步消费）：isUnlockManualTrackId 四形态同露面；
  // file_ 上传资产无可顶替的在线链不收、无曲不露面。落位「下载」
  // 动作群后、回源外链前；菜单高估算随行数 +1
  const sourceItem = () => menuItemByText('换源')
  // 菜单高估算断言要真翻顶——jsdom getBoundingClientRect 恒 0，钉触发键
  // 落位近视口底（top:690/bottom:700，innerHeight 768 放不下往下展的菜单）
  const pinTriggerNearBottom = (w) => {
    menuTrigger(w).element.getBoundingClientRect = () =>
      ({ top: 690, bottom: 700, left: 780, right: 800, width: 20, height: 10, x: 780, y: 690 })
  }

  it('网易数值 id → 「换源」项渲染 broadcast 图标，落位下载与回源之间', async () => {
    const w = mountWatch({ tab: 'queue', currentSong: { ...SONG, id: '12345' } })
    await openActionsMenu(w)
    const el = sourceItem()
    expect(el).toBeTruthy()
    expect(el.getAttribute('title')).toContain('解锁链选错源或自有源失效时手动挑播放媒体')
    const icon = w.findAllComponents(PixelIcon).find(c => el.contains(c.element))
    expect(icon.props('name')).toBe('broadcast')
    const texts = menuItems().map(i => i.textContent)
    const at = texts.findIndex(t => t.includes('换源'))
    expect(texts.findIndex(t => t.includes('下载'))).toBeLessThan(at)
    // 回源锚是网易云链接项（数值曲 sourceUrl 在场）
    expect(texts.findIndex(t => t.includes('网易云'))).toBeGreaterThan(at)
  })

  it('网易数值曲菜单高多算 1 行：数值 id 顶翻 6 项 242px', async () => {
    const w = mountWatch({ tab: 'queue', currentSong: { ...SONG, id: '12345' } })
    pinTriggerNearBottom(w)
    await openActionsMenu(w)
    // 数值曲：沉浸/收藏/分享/下载/换源/回源(网易云)=6 项 → h=6*39+8=242；
    // 底 700+4+242 放不下 768 → 顶翻 top=690-242-4=444
    expect(menuEl().style.top).toBe('444px')
    expect(menuItems()).toHaveLength(6)
  })

  it('qq_/bv_/bv_分P/yt_ 外源轨道 id →「换源」项同露面（自有源败亡顶替语义）', async () => {
    for (const [label, song] of [
      ['qq_', { id: 'qq_0034M8WL3V4oHC', name: 'q', ar: [{ name: 'a' }], al: {}, dt: 0 }],
      ['bv_', { id: 'bv_BV1xx411c7mD', name: 'b', ar: [{ name: 'a' }], al: {}, dt: 0 }],
      ['bv__p3', { id: 'bv_BV1xx411c7mD_p3', name: 'b3', ar: [{ name: 'a' }], al: {}, dt: 0 }],
      ['yt_', { id: 'yt_abcdefghijk', name: 'y', ar: [{ name: 'a' }], al: {}, dt: 0 }],
    ]) {
      const w = mountWatch({ tab: 'queue', currentSong: song })
      await openActionsMenu(w)
      const el = sourceItem()
      expect(el, label).toBeTruthy()
      expect(el.getAttribute('title')).toBe('解锁链选错源或自有源失效时手动挑播放媒体')
      mounted.pop().unmount()
      document.body.innerHTML = ''
    }
  })

  it('外源曲菜单高同样多算 1 行：bv_ 顶翻同高 242px；file_ 对照无此项', async () => {
    // bv_ 曲含「换源」：沉浸/收藏/分享/下载/换源/回源(B站)=6 项 → h=242
    // → 顶翻 top=690-242-4=444——高估算漏 +1 的话 bv_ 会落成 483/底项被裁
    const w = mountWatch({
      tab: 'queue',
      currentSong: { id: 'bv_BV1xx411c7mD', name: 'bv', ar: [{ name: 'a' }], al: {}, dt: 0 },
    })
    pinTriggerNearBottom(w)
    await openActionsMenu(w)
    expect(sourceItem()).toBeTruthy()
    expect(menuEl().style.top).toBe('444px')
    expect(menuItems()).toHaveLength(6)
    mounted.pop().unmount()
    document.body.innerHTML = ''

    // file_ 曲：分享/下载/换源/回源四闸全隐（上传资产无源链无可顶替）
    // → 只剩沉浸/收藏 2 项 → h=2*39+8=86 → 顶翻 top=690-86-4=600
    const w2 = mountWatch({
      tab: 'queue',
      currentSong: { id: 'file_abcd1234', name: 'f', ar: [], al: {}, dt: 0 },
    })
    pinTriggerNearBottom(w2)
    await openActionsMenu(w2)
    expect(sourceItem()).toBeUndefined()
    expect(menuEl().style.top).toBe('600px')
    expect(menuItems()).toHaveLength(2)
  })

  it('file_/无 currentSong → 项恒隐（上传资产无可顶替的在线链）', async () => {
    for (const [label, song] of [
      ['file_', { id: 'file_abcd1234', name: 'f', ar: [], al: {}, dt: 0 }],
      ['null', null],
    ]) {
      const w = mountWatch({ tab: 'queue', currentSong: song })
      await openActionsMenu(w)
      expect(sourceItem(), label).toBeUndefined()
      mounted.pop().unmount()
      document.body.innerHTML = ''
    }
  })

  it('点击「换源」→ SourcePicker 挂载 + 菜单关闭 + 焦点入弹层；applied → notifyUnlockManualChange', async () => {
    musicApi.getUnlockCandidates.mockResolvedValue({
      keyword: 'kw', errors: [],
      candidates: [{ source: 'youtube', mediaId: 'abcdefghijk', title: '候选源', durationSec: 200 }],
    })
    const w = mountWatch({ tab: 'queue', currentSong: { ...SONG, id: '12345' } })
    await openActionsMenu(w)
    await clickEl(sourceItem())
    await nextTick()
    // 菜单已关；弹层 teleport 挂 body（sp-dialog 自收焦点——menuitem 已死，
    // closeMenu(true) 先把焦点还给 ⋯ 触发键再交弹层 _prevFocus 记账）
    expect(menuEl()).toBeNull()
    const dialog = document.querySelector('.sp-dialog')
    expect(dialog).toBeTruthy()
    await new Promise(r => setTimeout(r, 0)) // 首载两条腿落地
    expect(musicApi.getUnlockCandidates).toHaveBeenCalled()
    expect(musicApi.getManualUnlock).toHaveBeenCalledWith('12345', expect.any(AbortSignal))

    // 点候选行 → POST → applied 上行 → 动态 import 单槽收到 trackId；
    // picker emit close 后弹层卸载，焦点沿 _prevFocus（=⋯触发键）归还
    const row = document.querySelector('.sp-row')
    expect(row).toBeTruthy()
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise(r => setTimeout(r, 0))
    await nextTick()
    expect(musicApi.pickManualUnlock).toHaveBeenCalledWith(
      expect.objectContaining({ id: '12345', source: 'youtube', mediaId: 'abcdefghijk' }))
    expect(notifyUnlockManualChange).toHaveBeenCalledWith('12345')
    expect(document.querySelector('.sp-dialog')).toBeNull()
    expect(document.activeElement).toBe(menuTrigger(w).element)
  })
})

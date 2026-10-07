// F2 复审修复轮回归（菜单焦点链）：
//   M1 DownloadQueueList ⋯ 菜单补同构键盘行为——开即焦首项 + ↑↓ 循环 + Esc 归还
//      （与 PlaylistPanel/TopNav 同一份 focus-trap 方案）；TopNav #topnav-menu
//      补 ↑↓ 循环（聚焦/Esc 归还此前已有）
//   L2 SongList/PlaylistPanel/DownloadQueueList Esc 归还加「焦点仍在菜单内」闸：
//      Tab 挪出菜单后 Esc 只关菜单，不得把焦点强拽回 ⋯触发键
//   L3 usePlaylistLibrary 名截 40 改码点切——code-unit slice 在 emoji 边界
//      斩断代理对留孤代理（createLocalPlaylist/自动编号两路）
//   L4 useAddToPlaylist openAddToPlaylist 接显式 returnFocus 锚——行 ⋯ 菜单
//      路径的 activeElement 是将随菜单卸载的 menuitem（openSongForm 同款传参形）；
//      调用侧两扣：SongList addToPlaylistFromMenu emit 第二参带 ⋯键、
//      App.vue handleOpenAddToPlaylist 透传 trigger
//   Esc 一键只收一层：App onGlobalKeydown 消费的 Esc 打 defaultPrevented 戳，
//      四个菜单 Esc 监听（SongList/PlaylistPanel/DQL/TopNav）见戳让位不双收
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, nextTick } from 'vue'
import { mount } from '@vue/test-utils'

vi.mock('../../src/api/music.js', () => ({
  musicApi: {
    searchSuggest: vi.fn(async () => ({})),
    getSongDetail: vi.fn(),
    getSongsDetail: vi.fn(async () => []),
    getPlaylistDetail: vi.fn(async () => null),
    resolveYouTube: vi.fn(),
    resolveBilibili: vi.fn(),
    resolveQQ: vi.fn(),
    retryMatch: vi.fn(async () => null),
    searchSongs: vi.fn(async () => []),
    searchQQSongs: vi.fn(async () => []),
  },
}))
vi.mock('../../src/api/downloads.js', () => ({
  downloadsApi: {
    mirrorLocalPlaylist: vi.fn(async () => ({})),
    quickDownloadPlaylist: vi.fn(async () => ({})),
    deletePlaylistDownloads: vi.fn(async () => ({})),
    removeLocalMirror: vi.fn(async () => ({})),
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
}))
vi.mock('../../src/api/auth.js', () => ({
  authApi: { status: vi.fn(async () => ({ data: {} })), logout: vi.fn(async () => ({})) },
}))
vi.mock('../../src/lib/feedback.js', () => ({
  toast: vi.fn(),
  toastDismiss: vi.fn(),
  toastHold: vi.fn(), toastRelease: vi.fn(),
  pixelConfirm: vi.fn(async () => true),
  isConfirmOpen: vi.fn(() => false),
  resolveConfirm: vi.fn(),
  useFeedbackState: vi.fn(() => ({ toasts: [], confirm: null })),
}))
vi.mock('../../src/composables/usePlayer.js', () => ({
  notifyLyricRematch: vi.fn(),
}))

import DownloadQueueList from '../../src/components/DownloadQueueList.vue'
import TopNavigation from '../../src/components/TopNavigation.vue'
import SongList from '../../src/components/SongList.vue'
import PlaylistPanel from '../../src/components/PlaylistPanel.vue'
import { usePlaylistLibrary } from '../../src/composables/usePlaylistLibrary.js'
import { useAddToPlaylist } from '../../src/composables/useAddToPlaylist.js'

// jsdom 无 matchMedia——TopNav/GlitchText 挂载期裸调，补最小形（watch-view 同款）
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
}

const STUBS = { stubs: { GlitchText: true, PixelIcon: true } }
let wrapper = null
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

const pressEscOn = (target) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
const pressArrowOn = (el, key) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))

// 焦点挪出菜单的「用户」锚点——页面任意可聚焦处
const outsideButton = () => {
  const b = document.createElement('button')
  document.body.appendChild(b)
  return b
}

describe('M1：DownloadQueueList ⋯ 菜单键盘同构', () => {
  const QUEUE = {
    id: 7, name: 'Q7', status: 'pending', playlistId: 1,
    completedTasks: 0, totalTasks: 3, failedTasks: 0, coverImgUrl: '',
  }
  const mountDql = () => mount(DownloadQueueList, {
    attachTo: document.body,
    props: { queues: [QUEUE] },
    global: STUBS,
  })

  it('开菜单焦首项 → ↓ 次项 → ↑ 回绕末项 → Esc 归还 ⋯触发键', async () => {
    wrapper = mountDql()
    await nextTick()
    const trigger = wrapper.find('.queue-menu-trigger')
    await trigger.trigger('click')
    await nextTick()

    const menu = document.querySelector('.queue-menu')
    expect(menu).toBeTruthy()
    const items = [...menu.querySelectorAll('.pg-menu-item')]
    expect(items.length).toBeGreaterThan(1)
    // 开即焦首项——Enter 开菜单不再把焦点滞留触发键
    expect(document.activeElement).toBe(items[0])

    pressArrowOn(menu, 'ArrowDown')
    expect(document.activeElement).toBe(items[1])
    pressArrowOn(menu, 'ArrowUp')
    expect(document.activeElement).toBe(items[0])
    pressArrowOn(menu, 'ArrowUp') // 首项再上移回绕末项
    expect(document.activeElement).toBe(items[items.length - 1])

    pressEscOn(window)
    await nextTick()
    expect(document.querySelector('.queue-menu')).toBeNull()
    expect(document.activeElement).toBe(trigger.element)
  })

  it('Esc 归还闸：焦点已挪出菜单时只关菜单，不强拽回 ⋯键', async () => {
    wrapper = mountDql()
    await nextTick()
    await wrapper.find('.queue-menu-trigger').trigger('click')
    await nextTick()
    expect(document.querySelector('.queue-menu')).toBeTruthy()

    const out = outsideButton()
    out.focus()
    pressEscOn(window)
    await nextTick()
    expect(document.querySelector('.queue-menu')).toBeNull()
    expect(document.activeElement).toBe(out)
  })
})

describe('M1：TopNavigation ⋯ 菜单补 ↑↓ 循环', () => {
  it('开菜单焦首项 → ↓/↑ 循环移焦 → Esc 归还触发键', async () => {
    wrapper = mount(TopNavigation, {
      attachTo: document.body,
      props: { remoteMode: 'off' },
      global: STUBS,
    })
    await nextTick()
    const trigger = wrapper.find('.topnav-menu-btn')
    await trigger.trigger('click')
    await nextTick()

    const menu = document.querySelector('#topnav-menu')
    const items = [...menu.querySelectorAll('.pg-menu-item')]
    expect(items.length).toBeGreaterThan(1)
    expect(document.activeElement).toBe(items[0])

    pressArrowOn(menu, 'ArrowDown')
    expect(document.activeElement).toBe(items[1])
    pressArrowOn(menu, 'ArrowUp')
    expect(document.activeElement).toBe(items[0])
    pressArrowOn(menu, 'ArrowUp')
    expect(document.activeElement).toBe(items[items.length - 1])

    // TopNav Esc 监听已迁 window 相位（document 相位读不到 App 的戳）——
    // document 上 bubbles 派发照样冒到 window，归还闸是既有行为顺带钉回归
    pressEscOn(document)
    await nextTick()
    expect(document.querySelector('#topnav-menu')).toBeNull()
    expect(document.activeElement).toBe(trigger.element)
  })
})

describe('L2：Esc 归还「焦点仍在菜单内」闸', () => {
  const songA = () => ({ id: 1, name: '歌A', ar: [{ name: 'a' }], al: {}, dt: 1000 })

  it('SongList：Tab 挪出菜单后 Esc 关菜单但不夺走焦点', async () => {
    wrapper = mount(SongList, {
      attachTo: document.body,
      props: {
        songs: [songA()],
        selectedPlaylist: { id: 'local_pl_1', name: 'P', tracks: [], isLocal: true },
        playlistInLibrary: true,
      },
      global: STUBS,
    })
    await nextTick()
    await wrapper.find('.song-menu-btn').trigger('click')
    await nextTick()
    expect(document.querySelector('.download-menu-overlay')).toBeTruthy()

    const out = outsideButton()
    out.focus()
    pressEscOn(window)
    await nextTick()
    expect(document.querySelector('.download-menu-overlay')).toBeNull()
    expect(document.activeElement).toBe(out)
  })

  it('PlaylistPanel：同上——焦点外移时 Esc 不归还 ⋯键', async () => {
    const pl = { id: 123, name: 'P', trackCount: 0, creator: { nickname: 'x' } }
    wrapper = mount(PlaylistPanel, {
      attachTo: document.body,
      props: { userPlaylists: [pl] },
      global: STUBS,
    })
    await nextTick()
    const trigger = wrapper.find('button[aria-label="更多操作"]')
    await trigger.trigger('click')
    await nextTick()
    expect(document.querySelector('.playlist-menu')).toBeTruthy()

    const out = outsideButton()
    out.focus()
    pressEscOn(window)
    await nextTick()
    expect(document.querySelector('.playlist-menu')).toBeNull()
    expect(document.activeElement).toBe(out)
  })

  it('PlaylistPanel：焦点仍在菜单内时 Esc 照常归还 ⋯键', async () => {
    const pl = { id: 123, name: 'P', trackCount: 0, creator: { nickname: 'x' } }
    wrapper = mount(PlaylistPanel, {
      attachTo: document.body,
      props: { userPlaylists: [pl] },
      global: STUBS,
    })
    await nextTick()
    const trigger = wrapper.find('button[aria-label="更多操作"]')
    await trigger.trigger('click')
    await nextTick()
    // 焦点在菜单首项（开即焦）——归还路径不变
    pressEscOn(window)
    await nextTick()
    expect(document.querySelector('.playlist-menu')).toBeNull()
    expect(document.activeElement).toBe(trigger.element)
  })
})

describe('L3：createLocalPlaylist 名截 40 按码点切', () => {
  const makeLib = () => usePlaylistLibrary({
    gates: {
      select: { claim: () => 0, isCurrent: () => true, invalidate: () => {} },
      mediaImport: { claim: () => 0, isCurrent: () => true, invalidate: () => {} },
      preview: { claim: () => 0, isCurrent: () => true, invalidate: () => {} },
    },
    playingPlaylistId: ref(null), loading: ref(false),
  })
  beforeEach(() => { localStorage.clear() })

  it('emoji 骑在截断边界不留孤代理——40 码点整取', () => {
    const lib = makeLib()
    // 39 ascii + 😀 + 尾巴：code-unit slice(0,40) 会斩在 😀 高位代理后
    const pl = lib.createLocalPlaylist('x'.repeat(39) + '😀' + 'zzz')
    expect([...pl.name].length).toBe(40)
    expect(pl.name.endsWith('😀')).toBe(true)
  })

  it('自动编号路同受码点切——后缀占位不从 emoji 中间扣', () => {
    const lib = makeLib()
    // trimmed 落 'a'*36+'😀'+'bcd'（40 码点/41 code unit）；编号取前 37 码点
    // code-unit slice(0,37) 会切成 'a'*36+孤高位代理
    const name = 'a'.repeat(36) + '😀' + 'bcde'
    lib.createLocalPlaylist(name)
    const p2 = lib.createLocalPlaylist(name)
    expect(p2.name).toBe('a'.repeat(36) + '😀(2)')
  })
})

describe('L4：openAddToPlaylist 显式 returnFocus 锚', () => {
  const makeAtp = () => useAddToPlaylist({
    gates: { picker: { claim: () => 0, isCurrent: () => true, invalidate: () => {} } },
    userPlaylists: ref([]), selectedPlaylist: ref(null), songs: ref([]),
    addPlaylistToLibrary: vi.fn(),
    appendSongToLibraryPlaylist: vi.fn(),
    createLocalPlaylist: vi.fn(),
    closeCreatePlaylist: vi.fn(),
  })

  it('显式锚优先于 activeElement——行 menuitem 不作归还目标', async () => {
    const atp = makeAtp()
    // 行菜单路径现场：焦点停在将随菜单卸载的 menuitem 上
    const menuitem = document.createElement('div')
    menuitem.tabIndex = 0
    document.body.appendChild(menuitem)
    menuitem.focus()
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    const triggerSpy = vi.spyOn(trigger, 'focus')
    const menuitemSpy = vi.spyOn(menuitem, 'focus')

    atp.openAddToPlaylist({ id: 1, name: 's' }, trigger)
    await nextTick()
    atp.addTargetSong.value = null // 关窗 → watcher cleanup 归还
    await nextTick()
    expect(triggerSpy).toHaveBeenCalled()
    expect(menuitemSpy).not.toHaveBeenCalled()
  })

  it('缺省回落 activeElement；锚已卸载时静默略过', async () => {
    const atp = makeAtp()
    const btn = document.createElement('button')
    document.body.appendChild(btn)
    btn.focus()
    const btnSpy = vi.spyOn(btn, 'focus')
    atp.openAddToPlaylist({ id: 2, name: 's2' })
    await nextTick()
    atp.addTargetSong.value = null
    await nextTick()
    expect(btnSpy).toHaveBeenCalled()

    // 锚已不在 DOM（行被删/菜单卸载后才轮到归还）——focus 是静默空炮，先闸
    const dead = document.createElement('button')
    const deadSpy = vi.spyOn(dead, 'focus')
    atp.openAddToPlaylist({ id: 3, name: 's3' }, dead)
    await nextTick()
    atp.addTargetSong.value = null
    await nextTick()
    expect(deadSpy).not.toHaveBeenCalled()
  })

  it('行菜单实接线：⋯→添加到歌单→关窗，焦点归还 ⋯触发键', async () => {
    const atp = makeAtp()
    // App.vue 模板接线同形：@add-to-playlist="handleOpenAddToPlaylist" 尾段即
    // openAddToPlaylist(song, trigger)——第二参是 SongList emit 捎来的 ⋯键
    wrapper = mount(SongList, {
      attachTo: document.body,
      props: {
        songs: [{ id: 1, name: '歌A', ar: [{ name: 'a' }], al: {}, dt: 1000 }],
        selectedPlaylist: { id: 'local_pl_1', name: 'P', tracks: [], isLocal: true },
        playlistInLibrary: true,
      },
      attrs: {
        onAddToPlaylist: (song, trigger) => atp.openAddToPlaylist(song, trigger),
      },
      global: STUBS,
    })
    await nextTick()
    const trigger = wrapper.find('.song-menu-btn')
    await trigger.trigger('click')
    await nextTick()

    const menu = document.querySelector('.download-menu-overlay .pg-menu')
    const atpItem = [...menu.querySelectorAll('.pg-menu-item')]
      .find(el => el.textContent.includes('添加到歌单'))
    expect(atpItem).toBeTruthy()
    atpItem.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()

    // emit 载荷第二参须是 ⋯键本体——menuitem 已随菜单卸载，作锚会落空炮
    const emitted = wrapper.emitted('add-to-playlist')
    expect(emitted[0][0].id).toBe(1)
    expect(emitted[0][1]).toBe(trigger.element)
    expect(atp.addTargetSong.value?.id).toBe(1)
    expect(document.querySelector('.download-menu-overlay')).toBeNull()

    atp.addTargetSong.value = null // 关窗 → watcher cleanup 归还 ⋯键
    await nextTick()
    expect(document.activeElement).toBe(trigger.element)
  })
})

describe('Esc 一键只收一层：defaultPrevented 戳让位', () => {
  // App onGlobalKeydown 在 setup 同步段注册 window keydown——先于一切子组件
  // 挂载期监听。confirm/弹窗结算 Esc 时打 preventDefault 戳；菜单监听见戳
  // 须让位，否则同一发按键收两层。stamp 先于 mount 注册，序与 App 一致；
  // 派发须 cancelable——非可取消事件 preventDefault 是空炮
  const stamp = (e) => { if (e.key === 'Escape') e.preventDefault() }
  const pressConsumedEscOn = (target) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  const SONG = { id: 1, name: '歌A', ar: [{ name: 'a' }], al: {}, dt: 1000 }
  const PL = { id: 123, name: 'P', trackCount: 0, creator: { nickname: 'x' } }
  const QUEUE = {
    id: 7, name: 'Q7', status: 'pending', playlistId: 1,
    completedTasks: 0, totalTasks: 3, failedTasks: 0, coverImgUrl: '',
  }

  it('SongList：已消费 Esc 不收 ⋯菜单', async () => {
    window.addEventListener('keydown', stamp)
    try {
      wrapper = mount(SongList, {
        attachTo: document.body,
        props: {
          songs: [SONG],
          selectedPlaylist: { id: 'local_pl_1', name: 'P', tracks: [], isLocal: true },
          playlistInLibrary: true,
        },
        global: STUBS,
      })
      await nextTick()
      await wrapper.find('.song-menu-btn').trigger('click')
      await nextTick()
      expect(document.querySelector('.download-menu-overlay')).toBeTruthy()

      pressConsumedEscOn(window)
      await nextTick()
      expect(document.querySelector('.download-menu-overlay')).toBeTruthy() // 让位不双收
    } finally { window.removeEventListener('keydown', stamp) }
  })

  it('PlaylistPanel：已消费 Esc 不收 ⋯菜单', async () => {
    window.addEventListener('keydown', stamp)
    try {
      wrapper = mount(PlaylistPanel, {
        attachTo: document.body,
        props: { userPlaylists: [PL] },
        global: STUBS,
      })
      await nextTick()
      await wrapper.find('button[aria-label="更多操作"]').trigger('click')
      await nextTick()
      expect(document.querySelector('.playlist-menu')).toBeTruthy()

      pressConsumedEscOn(window)
      await nextTick()
      expect(document.querySelector('.playlist-menu')).toBeTruthy()
    } finally { window.removeEventListener('keydown', stamp) }
  })

  it('DownloadQueueList：已消费 Esc 不收 ⋯菜单', async () => {
    window.addEventListener('keydown', stamp)
    try {
      wrapper = mount(DownloadQueueList, {
        attachTo: document.body,
        props: { queues: [QUEUE] },
        global: STUBS,
      })
      await nextTick()
      await wrapper.find('.queue-menu-trigger').trigger('click')
      await nextTick()
      expect(document.querySelector('.queue-menu')).toBeTruthy()

      pressConsumedEscOn(window)
      await nextTick()
      expect(document.querySelector('.queue-menu')).toBeTruthy()
    } finally { window.removeEventListener('keydown', stamp) }
  })

  it('TopNavigation：已消费 Esc 不收 ⋯菜单（document 派发也冒到 window）', async () => {
    window.addEventListener('keydown', stamp)
    try {
      wrapper = mount(TopNavigation, {
        attachTo: document.body,
        props: { remoteMode: 'off' },
        global: STUBS,
      })
      await nextTick()
      await wrapper.find('.topnav-menu-btn').trigger('click')
      await nextTick()
      expect(document.querySelector('#topnav-menu')).toBeTruthy()

      // document 相位派发：先经 document 再到 window——stamp（先注册）
      // 打戳后 onMenuKeydown 见 defaultPrevented 让位；未迁相位前读不到
      pressConsumedEscOn(document)
      await nextTick()
      expect(document.querySelector('#topnav-menu')).toBeTruthy()
    } finally { window.removeEventListener('keydown', stamp) }
  })
})

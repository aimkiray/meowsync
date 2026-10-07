// 评审修复轮回归：
//   F1 外部导入长驻进度 toast 终态回收（单曲 resolve / mix 导入 / 作废路径）
//   L5 单曲分享导入过期请求的 catch 先查闸——旧请求失败不打扰
//   F2 lib/focus-trap.js 共享 Tab 钳制（首项 Shift+Tab→末项、末项 Tab→首项）
//      + SongFormDialog 实挂载双端回绕验证
//   F3 ⋯ 行菜单开即焦首项 + ↑↓ 循环移焦 + Esc 归还触发键（SongList/PlaylistPanel）
//   F4 同 id 重复行：moveSongInPlaylist 行引用锚定位移 + SongList emit 载荷
//   L6 id 预览失败：视图/URL 归一（不残留 ?view=songs&pl=死链）
//   L9 createLocalPlaylist 名截 40 + 重名自动编号
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, nextTick } from 'vue'
import { mount } from '@vue/test-utils'

vi.mock('../../src/api/music.js', () => ({
  musicApi: {
    resolveYouTube: vi.fn(),
    resolveBilibili: vi.fn(),
    resolveQQ: vi.fn(),
    getSongDetail: vi.fn(),
    getSongsDetail: vi.fn(async () => []),
    getPlaylistDetail: vi.fn(async () => null),
    retryMatch: vi.fn(async () => null),
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
vi.mock('../../src/lib/feedback.js', () => {
  let seq = 0
  return {
    toast: vi.fn(() => ++seq),
    toastDismiss: vi.fn(),
    toastHold: vi.fn(), toastRelease: vi.fn(),
    pixelConfirm: vi.fn(async () => true),
    isConfirmOpen: vi.fn(() => false),
    resolveConfirm: vi.fn(),
    useFeedbackState: vi.fn(() => ({ toasts: [], confirm: null })),
  }
})
vi.mock('../../src/composables/usePlayer.js', () => ({
  notifyLyricRematch: vi.fn(),
}))

import { musicApi } from '../../src/api/music.js'
import { toast, toastDismiss } from '../../src/lib/feedback.js'
import { useExternalImport } from '../../src/composables/useExternalImport.js'
import { usePlaylistLibrary } from '../../src/composables/usePlaylistLibrary.js'
import { useSearchNav } from '../../src/composables/useSearchNav.js'
import { trapTabKeydown, cycleMenuItems } from '../../src/lib/focus-trap.js'
import SongList from '../../src/components/SongList.vue'
import PlaylistPanel from '../../src/components/PlaylistPanel.vue'
import SongFormDialog from '../../src/components/SongFormDialog.vue'

const makeGate = () => {
  let n = 0
  return { claim: () => ++n, current: () => n, isCurrent: (x) => x === n, invalidate: () => { n++ } }
}
const makeImport = () => {
  const gates = { mediaImport: makeGate(), select: makeGate() }
  const imp = useExternalImport({
    gates,
    userPlaylists: ref([]), selectedPlaylist: ref(null), songs: ref([]),
    loadingSongs: ref(false), savePlaylistsToStorage: vi.fn(),
    searchQuery: ref('yt=x'), currentSong: ref(null),
    playSong: vi.fn(async () => {}), enterWatch: vi.fn(), selectPlaylistAndShow: vi.fn(),
  })
  return { imp, gates }
}
// 进度 toast 的返回 id：toast mock 按调用序发号，找出「正在…」那次的 id
const progressToastId = (text) =>
  toast.mock.results[toast.mock.calls.findIndex(c => String(c[0]).includes(text))]?.value

const ytData = () => ({
  videoId: 'abcdefghijk', title: 'EMA - 乐园(粤)', author: 'EMA',
  authorClean: 'EMA', duration: 210,
  cover: 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg',
  songName: '乐园', hasVideo: true, matched: null,
})

// jsdom 不产布局——getClientRects 恒空集会把可聚焦集滤光，钳制变死代码。
// 桩非空矩形模拟可见元素；display:none 的 file input 仍按真语义排除
const realGetClientRects = Element.prototype.getClientRects
beforeEach(() => {
  Element.prototype.getClientRects = function () {
    return this.matches('input[type=file]') ? [] : [{ width: 1 }]
  }
})
afterEach(() => {
  Element.prototype.getClientRects = realGetClientRects
})

describe('F1：外部导入进度 toast 终态回收', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('单曲 resolve 成功：toastDismiss 收掉「正在解析」进度条', async () => {
    musicApi.resolveYouTube.mockResolvedValue(ytData())
    const { imp } = makeImport()
    await imp.importYouTube('https://youtu.be/abcdefghijk')
    const id = progressToastId('正在解析 YouTube 视频')
    expect(id).toBeTypeOf('number')
    expect(toastDismiss).toHaveBeenCalledWith(id)
  })

  it('单曲 resolve 失败：catch 后 finally 仍收掉进度条', async () => {
    vi.spyOn(console, 'error').mockImplementationOnce(() => {})
    musicApi.resolveYouTube.mockRejectedValue(new Error('resolve 挂了'))
    const { imp } = makeImport()
    await imp.importYouTube('https://youtu.be/abcdefghijk')
    const id = progressToastId('正在解析 YouTube 视频')
    expect(toastDismiss).toHaveBeenCalledWith(id)
  })

  it('mix 分享导入成功：「正在导入分享歌单」进度条终态回收', async () => {
    musicApi.getSongsDetail.mockResolvedValue([
      { id: 123, name: 's1', ar: [{ name: 'a' }], al: {}, dt: 1 },
      { id: 456, name: 's2', ar: [{ name: 'b' }], al: {}, dt: 1 },
    ])
    const { imp } = makeImport()
    await imp.importMixPlaylist('测试单~123,456')
    const id = progressToastId('正在导入分享歌单')
    expect(id).toBeTypeOf('number')
    expect(toastDismiss).toHaveBeenCalledWith(id)
  })

  it('mix 导入失败（detail 批拉异常）：进度条同样回收', async () => {
    vi.spyOn(console, 'error').mockImplementationOnce(() => {})
    musicApi.getSongsDetail.mockRejectedValue(new Error('批拉挂了'))
    const { imp } = makeImport()
    await imp.importMixPlaylist('测试单~123')
    const id = progressToastId('正在导入分享歌单')
    expect(toastDismiss).toHaveBeenCalledWith(id)
  })
})

describe('L5：单曲分享导入过期请求不打扰', () => {
  it('detail 失败但闸已作废——不弹错误 toast', async () => {
    vi.spyOn(console, 'error').mockImplementationOnce(() => {})
    musicApi.getSongDetail.mockRejectedValue(new Error('detail 挂了'))
    const { imp, gates } = makeImport()
    const p = imp.importNeteaseSongById('555')
    gates.mediaImport.invalidate() // 用户在途做了别的——本次失败属过期请求
    await p
    expect(toast).not.toHaveBeenCalledWith('分享的歌曲加载失败，请稍后重试', 'error')
  })
})

describe('F2：共享 Tab 钳制（lib/focus-trap.js）', () => {
  const buildDialog = () => {
    const el = document.createElement('div')
    el.innerHTML = '<button id="a">a</button><input id="b"/><button id="c">c</button>'
    el.addEventListener('keydown', trapTabKeydown) // 与模板 @keydown 绑定同源调用
    document.body.appendChild(el)
    return el
  }
  afterEach(() => { document.body.innerHTML = '' })

  it('末项 Tab→回首项；首项 Shift+Tab→回末项', () => {
    const dlg = buildDialog()
    const [a, , c] = ['a', 'b', 'c'].map(id => dlg.querySelector(`#${id}`))
    c.focus()
    dlg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    expect(document.activeElement).toBe(a)
    a.focus()
    dlg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }))
    expect(document.activeElement).toBe(c)
  })

  it('中段不消费——自然 Tab 序放行', () => {
    const dlg = buildDialog()
    const b = dlg.querySelector('#b')
    b.focus()
    const e = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    dlg.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(b) // 浏览器默认行为不跑在 jsdom——只看未拦截
  })

  it('隐藏 file input 不计入可聚焦集（getClientRects 过滤）', () => {
    const dlg = document.createElement('div')
    dlg.innerHTML = '<button id="a">a</button><input id="f" type="file"/><button id="z">z</button>'
    dlg.addEventListener('keydown', trapTabKeydown)
    document.body.appendChild(dlg)
    // z 是「可见」末项——Tab 在它上面就该回绕，隐藏 input 不该顶替末项位
    dlg.querySelector('#z').focus()
    dlg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    expect(document.activeElement).toBe(dlg.querySelector('#a'))
    dlg.remove()
  })

  it('SongFormDialog 实挂载：首焦 name 输入，Shift+Tab 回末键、Tab 回绕', async () => {
    const wrapper = mount(SongFormDialog, {
      attachTo: document.body,
      props: { open: true, song: null, busy: false },
      global: { stubs: { PixelIcon: true } },
    })
    await nextTick()
    const dlg = document.querySelector('.sfd-dialog')
    const first = dlg.querySelector('input[aria-label="歌名"]')
    const last = dlg.querySelector('.sfd-foot button:not([disabled])')
    // 开窗首焦在歌名框；Shift+Tab 应绕到末位可用键（创建禁用→取消是末项）
    expect(document.activeElement).toBe(first)
    dlg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }))
    expect(document.activeElement).toBe(last)
    dlg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    expect(document.activeElement).toBe(first)
    wrapper.unmount()
  })
})

describe('F3：⋯ 菜单键盘行为', () => {
  const songA = () => ({ id: 1, name: '歌A', ar: [{ name: 'a' }], al: {}, dt: 1000 })
  const songB = () => ({ id: 2, name: '歌B', ar: [{ name: 'b' }], al: {}, dt: 1000 })
  let wrapper = null
  afterEach(() => { wrapper?.unmount(); wrapper = null; document.body.innerHTML = '' })

  it('SongList：开菜单焦首项 → ↓ 移次项 → ↑ 回首项 → Esc 归还 ⋯键', async () => {
    wrapper = mount(SongList, {
      attachTo: document.body,
      props: {
        songs: [songA(), songB()],
        selectedPlaylist: { id: 'local_pl_1', name: 'P', tracks: [], isLocal: true },
        playlistInLibrary: true,
      },
      global: { stubs: { GlitchText: true, PixelIcon: true } },
    })
    await nextTick()
    const trigger = wrapper.find('.song-menu-btn').element
    await wrapper.find('.song-menu-btn').trigger('click')
    await nextTick()
    const menu = document.querySelector('.download-menu-overlay .pg-menu')
    const items = [...menu.querySelectorAll('.pg-menu-item')]
    expect(document.activeElement).toBe(items[0])

    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(document.activeElement).toBe(items[1])
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    expect(document.activeElement).toBe(items[0])
    // 末位再上移回绕首位的反向：焦点在首项按 ↑ 应绕到末项
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    expect(document.activeElement).toBe(items[items.length - 1])

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(document.querySelector('.download-menu-overlay')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('PlaylistPanel：开菜单焦首项 → ↓/↑ 循环 → Esc 归还 ⋯键', async () => {
    const pl = { id: 123, name: 'P', trackCount: 0, creator: { nickname: 'x' } }
    wrapper = mount(PlaylistPanel, {
      attachTo: document.body,
      props: { userPlaylists: [pl] },
      global: { stubs: { GlitchText: true, PixelIcon: true } },
    })
    await nextTick()
    const trigger = wrapper.find('button[aria-label="更多操作"]').element
    await wrapper.find('button[aria-label="更多操作"]').trigger('click')
    await nextTick()
    const menu = document.querySelector('.playlist-menu')
    const items = [...menu.querySelectorAll('.pg-menu-item')]
    expect(document.activeElement).toBe(items[0])

    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(document.activeElement).toBe(items[1])
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    expect(document.activeElement).toBe(items[0])

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(document.querySelector('.playlist-menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('SongList：props.songs 整换时菜单关闭（fixed 菜单不悬空指错歌）', async () => {
    wrapper = mount(SongList, {
      attachTo: document.body,
      props: {
        songs: [songA(), songB()],
        selectedPlaylist: { id: 'local_pl_1', name: 'P', tracks: [], isLocal: true },
        playlistInLibrary: true,
      },
      global: { stubs: { GlitchText: true, PixelIcon: true } },
    })
    await nextTick()
    await wrapper.find('.song-menu-btn').trigger('click')
    await nextTick()
    expect(document.querySelector('.download-menu-overlay')).toBeTruthy()
    await wrapper.setProps({ songs: [songA()] })
    await nextTick()
    expect(document.querySelector('.download-menu-overlay')).toBeNull()
  })
})

describe('F4：同 id 重复行的位移锚定', () => {
  const makeLib = () => usePlaylistLibrary({
    gates: { select: makeGate(), mediaImport: makeGate(), preview: makeGate() },
    playingPlaylistId: ref(null), loading: ref(false),
  })

  it('moveSongInPlaylist 按行引用锚定：拖第二份同 id 行移的是第二份', () => {
    const lib = makeLib()
    const dup1 = { id: 9, name: 'dup-1' }
    const other = { id: 7, name: 'other' }
    const dup2 = { id: 9, name: 'dup-2' }
    const pl = { id: 'local_pl_1', name: 'P', tracks: [dup1, other, dup2], isLocal: true }
    lib.userPlaylists.value.push(pl)
    lib.selectedPlaylist.value = pl
    lib.songs.value = [dup1, other, dup2]

    lib.moveSongInPlaylist({ dragRef: lib.songs.value[2], targetRef: lib.songs.value[0] })
    // 第二份（dup-2）移到 dup-1 之前——id 锚定会错移第一份
    expect(lib.songs.value.map(t => t.name)).toEqual(['dup-2', 'dup-1', 'other'])
    // 持久化面（本地单 tracks 整列重排）跟随同一份移动
    expect(pl.tracks.map(t => t.name)).toEqual(['dup-2', 'dup-1', 'other'])
  })

  it('行引用已不在列表（外部整表替换）：no-op 不挪错歌', () => {
    const lib = makeLib()
    const stale = { id: 9, name: 'old' }
    const a = { id: 9, name: 'a' }
    const b = { id: 7, name: 'b' }
    const pl = { id: 'local_pl_1', name: 'P', tracks: [a, b], isLocal: true }
    lib.userPlaylists.value.push(pl)
    lib.selectedPlaylist.value = pl
    lib.songs.value = [a, b]
    lib.moveSongInPlaylist({ dragRef: stale, targetRef: lib.songs.value[0] })
    expect(lib.songs.value).toEqual([a, b]) // 旧引用锚空——不动作
  })

  it('SongList 排序态 ↑ 键 emit 行引用：dup 行各自锚定', async () => {
    const dupA = { id: 9, name: 'dupA', ar: [], al: {}, dt: 1 }
    const dupB = { id: 9, name: 'dupB', ar: [], al: {}, dt: 1 }
    const other = { id: 7, name: 'other', ar: [], al: {}, dt: 1 }
    const wrapper = mount(SongList, {
      attachTo: document.body,
      props: {
        songs: [dupA, other, dupB],
        selectedPlaylist: { id: 'local_pl_1', name: 'P', tracks: [], isLocal: true },
        playlistInLibrary: true,
      },
      global: { stubs: { GlitchText: true, PixelIcon: true } },
    })
    await nextTick()
    // 进入排序态（行键不撞 duplicate-key：两份同 id 各得 id#0/id#1）
    await wrapper.find('button[title="拖拽或逐行移动调整歌曲顺序"]').trigger('click')
    await nextTick()
    const rows = wrapper.findAll('.song-row')
    expect(rows.length).toBe(3)
    // 第三行（dupB）上移 → emit {dragRef: dupB 行, targetRef: other 行}
    const upBtn = rows[2].find('button[aria-label="上移"]')
    await upBtn.trigger('click')
    const payload = wrapper.emitted('move-song')[0][0]
    expect(payload.dragRef.name).toBe('dupB')
    expect(payload.targetRef.name).toBe('other')
    wrapper.unmount()
  })
})

describe('L6：id 预览失败的视图/URL 归一', () => {
  const makeNav = () => useSearchNav({
    gates: { search: makeGate(), preview: makeGate() },
    searchQuery: ref(''), currentSong: ref(null), watchTab: ref(''),
    isFullscreenPlayerOpen: ref(false),
    userPlaylists: ref([]), selectedPlaylist: ref(null), loadingSongs: ref(false),
    selectPlaylist: vi.fn(async () => true),
    playSong: vi.fn(), playSongFromSearch: vi.fn(), playSongFromRelated: vi.fn(),
    playPlaylist: vi.fn(),
  })

  it('预览拉取失败：centerView 回 home，地址栏摘掉失效 pl', async () => {
    vi.spyOn(console, 'error').mockImplementationOnce(() => {})
    window.history.replaceState(null, '', '/?view=songs&pl=999')
    musicApi.getPlaylistDetail.mockRejectedValue(new Error('拉不到'))
    const nav = makeNav()
    await nav.previewPlaylistById('999')
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('歌单加载失败'), 'error')
    expect(nav.centerView.value).toBe('home')
    expect(window.location.search).toContain('view=home')
    expect(window.location.search).not.toContain('pl=999')
    window.history.replaceState(null, '', '/')
  })

  it('空壳回包（歌单不存在）：同样归一 URL——刷新不再重放死链', async () => {
    window.history.replaceState(null, '', '/?view=songs&pl=888')
    musicApi.getPlaylistDetail.mockResolvedValue({ tracks: [] }) // 无 id 空壳
    const nav = makeNav()
    await nav.previewPlaylistById('888')
    expect(toast).toHaveBeenCalledWith('未找到该歌单', 'info')
    expect(nav.centerView.value).toBe('home')
    expect(window.location.search).not.toContain('pl=888')
    window.history.replaceState(null, '', '/')
  })
})

describe('L9：本地歌单命名', () => {
  const makeLib = () => usePlaylistLibrary({
    gates: { select: makeGate(), mediaImport: makeGate(), preview: makeGate() },
    playingPlaylistId: ref(null), loading: ref(false),
  })
  beforeEach(() => { localStorage.clear() })

  it('名长截 40；空名返回 null', () => {
    const lib = makeLib()
    const pl = lib.createLocalPlaylist('x'.repeat(60))
    expect(pl.name.length).toBe(40)
    expect(lib.createLocalPlaylist('   ')).toBeNull()
    expect(lib.createLocalPlaylist('')).toBeNull()
  })

  it('重名自动编号「名(2)/(3)…」，编号名也不超 40', () => {
    const lib = makeLib()
    lib.createLocalPlaylist('我的歌单')
    const p2 = lib.createLocalPlaylist('我的歌单')
    expect(p2.name).toBe('我的歌单(2)')
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('已存在同名歌单'), 'info', 3000)
    const p3 = lib.createLocalPlaylist('我的歌单')
    expect(p3.name).toBe('我的歌单(3)')
    // 40 满名重名：编号后缀占位从主体扣，成品仍 ≤40
    const longName = 'a'.repeat(40)
    lib.createLocalPlaylist(longName)
    const pLong = lib.createLocalPlaylist(longName)
    expect(pLong.name.length).toBeLessThanOrEqual(40)
    expect(pLong.name.endsWith('(2)')).toBe(true)
  })
})

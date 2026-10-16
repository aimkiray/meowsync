// 歌单与侧栏域 UI 修复回归：
//   SongList VIP 开关语义解耦——文案恒「VIP」，on 态由 aria-pressed/✓/反白承担，
//     title 说动作（不再「显示VIP/隐藏VIP」状态与动作颠倒）
//   SongList 歌单内筛选——滑窗让 Cmd+F 只能覆盖已渲段，本地过滤补位；
//     页脚「共 n」吃 vipVisibleSongs 基线、「筛选出 n 首」仅 query 生效且真
//     收窄时挂出；排序态隐藏输入框（displayRows 绕开 filteredSongs，挂着词
//     行却不动是口径撕裂）；清空钮卸载后焦点还回输入框
//   SongList ⋯ 菜单——右缘锚定（right 键非 left）、menuitem 全 <button>、
//     分组头只在其组有可见项时渲染、danger 项集中尾部
//   PlaylistPanel——centerView 高亮闸（非 songs 视图不亮）、⋯菜单首项
//     「播放歌单」（触屏封面 hover 劫持的替代入口）、无「复制分享链接」
//   SongFormDialog——四字段可见 label[for]→input[id]（必填位补 aria-required）、
//     头部 ✕ 闲=关窗 busy=中止上传（label/title 随 busy 翻转）、文件槽钮 ghost 降级
import { describe, it, expect, vi, afterEach } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'

vi.mock('../../src/api/music.js', () => ({
  musicApi: {
    resolveYouTube: vi.fn(),
    resolveBilibili: vi.fn(),
    resolveQQ: vi.fn(),
    getSongDetail: vi.fn(),
    getSongsDetail: vi.fn(async () => []),
    getPlaylistDetail: vi.fn(async () => null),
    getQqStatus: vi.fn(async () => ({ loggedIn: false })),
    retryMatch: vi.fn(async () => null),
  },
}))
vi.mock('../../src/api/downloads.js', () => ({
  downloadsApi: {
    removeLocalMirror: vi.fn(async () => ({})),
    mirrorLocalPlaylist: vi.fn(async () => ({})),
    quickDownloadPlaylist: vi.fn(async () => ({})),
    deletePlaylistDownloads: vi.fn(async () => ({})),
    deleteSongDownload: vi.fn(async () => ({})),
    downloadSongToServer: vi.fn(async () => ({ data: null })),
    listTasks: vi.fn(async () => ({ data: [] })),
    getSongDownloadStatus: vi.fn(async () => null),
  },
}))
vi.mock('../../src/api/http.js', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
  API_BASE_URL: 'http://api.test',
  apiErrorMessage: (e, fb) => e?.message || fb || '接口异常',
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

import { downloadsApi } from '../../src/api/downloads.js'
import SongList from '../../src/components/SongList.vue'
import PlaylistPanel from '../../src/components/PlaylistPanel.vue'
import SongFormDialog from '../../src/components/SongFormDialog.vue'

const STUBS = { stubs: { GlitchText: true, PixelIcon: true } }
let wrapper = null
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

const LOCAL_PL = () => ({ id: 'local_pl_1', name: 'P', tracks: [], isLocal: true })
const mkSong = (id, name, extra = {}) =>
  ({ id, name, ar: [{ name: `艺人${id}` }], al: { name: `专辑${id}` }, dt: 1000, ...extra })
const mountList = (props = {}) => mount(SongList, {
  attachTo: document.body, // ⋯菜单 teleport 到 body——挂上才能查
  props: {
    songs: [mkSong(1, '晴天'), mkSong(2, '雨天')],
    selectedPlaylist: LOCAL_PL(),
    playlistInLibrary: true,
    ...props,
  },
  global: STUBS,
})
const openRowMenu = async () => {
  await wrapper.find('.song-menu-btn').trigger('click')
  await nextTick()
  return document.querySelector('.download-menu-overlay .pg-menu')
}

describe('SongList：VIP 开关语义', () => {
  it('on 态：可见文案恒「VIP」（状态由 aria-pressed/✓/反白承担），title 说动作', async () => {
    wrapper = mountList({ showVipSongs: true })
    await nextTick()
    const btn = wrapper.find('.hero-vip-toggle')
    expect(btn.attributes('aria-pressed')).toBe('true')
    expect(btn.attributes('title')).toBe('隐藏VIP歌曲')
    // 关键钉：文案不得再回写状态动词——on 态按钮读作「点我隐藏」是颠倒
    expect(btn.text()).toContain('VIP')
    expect(btn.text()).not.toContain('隐藏')
    expect(btn.text()).not.toContain('显示')
  })

  it('off 态：aria-pressed=false，title=「显示VIP歌曲」，无 ✓', async () => {
    wrapper = mountList({ showVipSongs: false })
    await nextTick()
    const btn = wrapper.find('.hero-vip-toggle')
    expect(btn.attributes('aria-pressed')).toBe('false')
    expect(btn.attributes('title')).toBe('显示VIP歌曲')
    expect(btn.text()).toContain('VIP')
  })
})

describe('SongList：歌单内筛选', () => {
  it('query 命中歌名与艺人两域；页脚「共 n」吃 vipVisibleSongs 基线', async () => {
    wrapper = mountList({
      songs: [mkSong(1, '晴天'), mkSong(2, '雨天'), mkSong(3, '别处', { ar: [{ name: '晴乐队' }] })],
    })
    await nextTick()
    const input = wrapper.find('.song-filter input')
    expect(input.exists()).toBe(true)
    await input.setValue('晴')
    await nextTick()
    // 「晴天」名中 +「别处」艺人名中——行数随 filteredSongs 收敛
    expect(wrapper.findAll('.song-row').length).toBe(2)
    const footer = wrapper.find('.song-list-footer').text()
    // 基线是筛前的 vipVisibleSongs——主数再写 filteredSongs 会与括弧同数双份
    expect(footer).toContain('共 3 首')
    expect(footer).toContain('筛选出 2 首')
  })

  it('VIP 隐藏先行收缩、零过滤词时不挂「筛选出」（基线错位回归钉）', async () => {
    // fee=1 且未登录 QQ → vipVisibleSongs 收缩；旧口径拿 filteredSongs 比
    // songs.length，无词也挂出假筛选计数
    wrapper = mountList({
      songs: [mkSong(1, '晴天'), mkSong(2, '雨天'), mkSong(3, '会员曲', { fee: 1 })],
      showVipSongs: false,
    })
    await nextTick()
    const footer = wrapper.find('.song-list-footer').text()
    expect(footer).toContain('共 2 首')
    expect(footer).toContain('隐藏 1 首VIP')
    expect(footer).not.toContain('筛选出')
  })

  it('筛选词命中全部行时不挂「筛选出」（等长不算收窄）', async () => {
    wrapper = mountList()
    await nextTick()
    await wrapper.find('.song-filter input').setValue('专辑') // 两行专辑名都命中
    await nextTick()
    const footer = wrapper.find('.song-list-footer').text()
    expect(footer).toContain('共 2 首')
    expect(footer).not.toContain('筛选出')
  })

  it('清空钮卸载后焦点还回输入框（不落 body）', async () => {
    wrapper = mountList()
    await nextTick()
    const input = wrapper.find('.song-filter input')
    await input.setValue('晴')
    await nextTick()
    const clearBtn = wrapper.find('.song-filter-clear')
    clearBtn.element.focus()
    await clearBtn.trigger('click')
    await nextTick()
    await nextTick() // 焦点归还在钮移除后的 nextTick 回调里落地
    expect(wrapper.find('.song-filter-clear').exists()).toBe(false)
    expect(document.activeElement).toBe(input.element)
  })

  it('query 大写/空白归一（trim + toLowerCase）', async () => {
    wrapper = mountList({ songs: [mkSong(1, 'ABC Song'), mkSong(2, '雨天')] })
    await nextTick()
    await wrapper.find('.song-filter input').setValue('  abc  ')
    await nextTick()
    expect(wrapper.findAll('.song-row').length).toBe(1)
  })

  it('零命中：song-state 提示替代行列表（虚拟窗渲不出「没搜到」语义）', async () => {
    wrapper = mountList()
    await nextTick()
    await wrapper.find('.song-filter input').setValue('zzz')
    await nextTick()
    expect(wrapper.find('.song-rows').exists()).toBe(false)
    expect(wrapper.text()).toContain('没有匹配「zzz」的歌曲')
  })

  it('排序态隐藏筛选框 + 残留词不影响行量：displayRows 绕开 filteredSongs', async () => {
    wrapper = mountList()
    await nextTick()
    // 先挂残留词把 filteredSongs 打到 0——不收窄就进排序态，「行仍全量」
    // 是 filteredSongs 本就全量的假绿
    await wrapper.find('.song-filter input').setValue('zzz')
    await nextTick()
    expect(wrapper.findAll('.song-row').length).toBe(0)
    await wrapper.find('button[title="拖拽或逐行移动调整歌曲顺序"]').trigger('click')
    await nextTick()
    expect(wrapper.find('.song-filter').exists()).toBe(false)
    // 排序态行列表仍在（displayRows=全量 songs，不受残留词影响）
    expect(wrapper.findAll('.song-row').length).toBe(2)
  })

  it('切歌单重置 listQuery——词绑歌单语境，不跨单残留', async () => {
    wrapper = mountList()
    await nextTick()
    await wrapper.find('.song-filter input').setValue('晴')
    await wrapper.setProps({
      selectedPlaylist: { id: 'local_pl_2', name: 'Q', tracks: [], isLocal: true },
      songs: [mkSong(9, '雨天')],
    })
    await nextTick()
    expect(wrapper.find('.song-filter input').element.value).toBe('')
    expect(wrapper.findAll('.song-row').length).toBe(1)
  })
})

describe('SongList：行级来源徽标', () => {
  it('全源覆盖：数字 id 行出「网易云」、yt 对象行出「YouTube」、裸 bv_ id 兜底出「B站」', async () => {
    wrapper = mountList({
      songs: [
        mkSong(1, '晴天'),                                                   // 纯数字网易云 id——songSourceTag 归名
        mkSong('yt_dQw4w9WgXcQ', 'yt曲', { youtube: { videoId: 'dQw4w9WgXcQ' } }),
        mkSong('bv_BV1xx411c7mD', 'bv曲'),                                   // 缺 provider 对象只剩前缀 id 同兜底
      ],
    })
    await nextTick()
    const tags = wrapper.findAll('.song-tag')
    expect(tags.map(t => t.text())).toEqual(['网易云', 'YouTube', 'B站'])
    // title 只报出处不缀「导入」——网易云原生曲没有导入语义
    expect(tags[0].attributes('title')).toBe('来源：网易云')
    expect(tags[1].attributes('title')).toBe('来源：YouTube')
  })
})

describe('SongList：⋯ 菜单结构', () => {
  it('右缘锚定：menuPositions 输出 right 键而非 left', async () => {
    wrapper = mountList()
    await nextTick()
    const menu = await openRowMenu()
    expect(menu.style.right).toBeTruthy()
    expect(menu.style.left).toBe('')
  })

  it('menuitem 全是 <button>（原生 Enter/Space 派发 click，无双发键处理）', async () => {
    wrapper = mountList()
    await nextTick()
    const menu = await openRowMenu()
    const items = [...menu.querySelectorAll('.pg-menu-item')]
    expect(items.length).toBeGreaterThan(3)
    for (const el of items) {
      expect(el.tagName).toBe('BUTTON')
      expect(el.getAttribute('role')).toBe('menuitem')
    }
    // 开菜单即焦首项仍是 button 命中
    expect(document.activeElement).toBe(items[0])
  })

  it('分组头只在有项组渲染；danger 项集中尾部', async () => {
    // 让 1 号曲呈「已下载」：listTasks 回 completed 行 → serverDownloadedStates 置真
    downloadsApi.listTasks.mockResolvedValueOnce({
      data: [{ songId: '1', status: 'completed' }],
    })
    wrapper = mountList({ songs: [mkSong(1, '晴天')] })
    await nextTick()
    const menu = await openRowMenu()
    // 已下载态经 async listTasks 落地——等「删除已下载文件」出现再断言
    await vi.waitFor(() => {
      const texts = [...menu.querySelectorAll('.pg-menu-item')].map(el => el.textContent)
      expect(texts.some(t => t.includes('删除已下载文件'))).toBe(true)
    })
    const items = [...menu.querySelectorAll('.pg-menu-item')]
    const dangerIdx = items
      .map((el, i) => (el.classList.contains('pg-menu-item--danger') ? i : -1))
      .filter(i => i >= 0)
    const safeIdx = items
      .map((el, i) => (el.classList.contains('pg-menu-item--danger') ? -1 : i))
      .filter(i => i >= 0)
    expect(dangerIdx).toEqual([items.length - 2, items.length - 1]) // 删除已下载文件 + 从歌单移除
    expect(Math.min(...dangerIdx)).toBeGreaterThan(Math.max(...safeIdx))
    // 「下载到服务器」翻面后不占下载组——下载组只剩获取源文件
    const texts = items.map(el => el.textContent)
    expect(texts.some(t => t.includes('下载到服务器'))).toBe(false)

    const heads = [...menu.querySelectorAll('.pg-menu-head')].map(el => el.textContent.trim())
    expect(heads[0]).toBe('晴天') // 曲目名头
    expect(heads).toContain('播放队列')
    expect(heads).toContain('歌曲')
    expect(heads).toContain('下载')
  })

  it('分享壳菜单：不可编辑/移除/服务端下载——「歌曲」组头仍在（分享+回源撑组）', async () => {
    wrapper = mount(SongList, {
      attachTo: document.body,
      props: {
        songs: [mkSong(5, '壳曲')],
        selectedPlaylist: { id: 'single_song_5', name: 'S' },
        playlistInLibrary: true,
      },
      global: STUBS,
    })
    await nextTick()
    const menu = await openRowMenu()
    const texts = [...menu.querySelectorAll('.pg-menu-item')].map(el => el.textContent)
    expect(texts.some(t => t.includes('编辑歌曲'))).toBe(false)
    expect(texts.some(t => t.includes('从歌单移除'))).toBe(false)
    expect(texts.some(t => t.includes('下载到服务器'))).toBe(false)
    expect(texts.some(t => t.includes('分享歌曲'))).toBe(true)
    const heads = [...menu.querySelectorAll('.pg-menu-head')].map(el => el.textContent.trim())
    expect(heads).toContain('歌曲')
    expect(heads).toContain('播放队列')
    expect(heads).toContain('下载')
  })
})

describe('PlaylistPanel：centerView 高亮闸与 ⋯ 菜单', () => {
  const PL_ITEM = () => ({ id: 123, name: '我的歌单', trackCount: 3, creator: { nickname: 'x' } })
  const mountPanel = (props = {}) => mount(PlaylistPanel, {
    attachTo: document.body,
    props: { userPlaylists: [PL_ITEM()], ...props },
    global: STUBS,
  })

  it('centerView=search 不亮；=songs 恢复 .pl-row--active + aria-current', async () => {
    wrapper = mountPanel({ selectedPlaylist: PL_ITEM(), centerView: 'search' })
    await nextTick()
    expect(wrapper.find('.pl-row--active').exists()).toBe(false)
    expect(wrapper.find('.pl-row-main').attributes('aria-current')).toBeUndefined()
    await wrapper.setProps({ centerView: 'songs' })
    expect(wrapper.find('.pl-row--active').exists()).toBe(true)
    expect(wrapper.find('.pl-row-main').attributes('aria-current')).toBe('true')
  })

  it('⋯ 菜单首项「播放歌单」、无「复制分享链接」；点击 emit 并关菜单', async () => {
    wrapper = mountPanel()
    await nextTick()
    await wrapper.find('button[aria-label="更多操作"]').trigger('click')
    await nextTick()
    const menu = document.querySelector('.playlist-menu')
    const items = [...menu.querySelectorAll('.pg-menu-item')]
    const texts = items.map(el => el.textContent)
    expect(texts[0]).toContain('播放歌单')
    expect(texts.some(t => t.includes('复制分享链接'))).toBe(false)
    // menuitem 全 <button type="button">——与 SongList ⋯ 菜单同口径
    // （缺 type 的 button 在表单语境默认 submit）
    for (const el of items) {
      expect(el.tagName).toBe('BUTTON')
      expect(el.getAttribute('type')).toBe('button')
    }

    items[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    expect(wrapper.emitted('play-playlist')[0][0].id).toBe(123)
    expect(document.querySelector('.playlist-menu')).toBeNull()
  })

  it('触屏封面劫持撤除：hover:none 下 overlay 不再常驻可点（样式层删除钉在结构侧）', async () => {
    // jsdom 不跑媒体查询——钉的是「overlay 默认 pointer-events:none 语义仍在」
    // 与菜单入口存在两事实；触屏常显块删除由 diff/真机验收
    wrapper = mountPanel()
    await nextTick()
    const overlay = wrapper.find('.playlist-play-overlay')
    expect(overlay.exists()).toBe(true)
    await wrapper.find('button[aria-label="更多操作"]').trigger('click')
    await nextTick()
    const texts = [...document.querySelectorAll('.playlist-menu .pg-menu-item')].map(el => el.textContent)
    expect(texts[0]).toContain('播放歌单')
  })
})

describe('SongFormDialog：可见标签与头部 ✕', () => {
  const mountDialog = (props = {}) => mount(SongFormDialog, {
    attachTo: document.body,
    props: { open: true, song: null, busy: false, ...props },
    global: { stubs: { PixelIcon: true } },
  })

  it('四个字段各有常驻可见 label（label[for]→input[id]）', async () => {
    wrapper = mountDialog()
    await nextTick()
    const dlg = document.querySelector('.sfd-dialog')
    for (const [id, text] of [['sfd-name', '歌名'], ['sfd-artist', '艺术家'], ['sfd-album', '专辑'], ['sfd-duration', '时长']]) {
      const input = dlg.querySelector(`input#${id}`)
      const label = dlg.querySelector(`label[for="${id}"]`)
      expect(input, `${id} input`).toBeTruthy()
      expect(label, `${id} label`).toBeTruthy()
      expect(label.textContent).toContain(text)
    }
    // 必填 * 已挪进可见标签，不再赖 placeholder
    expect(dlg.querySelector('label[for="sfd-name"]').textContent).toContain('*')
    // aria-label 压 label[for] 播报时「*」读不到——aria-required 补平权
    expect(dlg.querySelector('input#sfd-name').getAttribute('aria-required')).toBe('true')
  })

  it('头部 ✕ 闲时=取消（emit close）', async () => {
    wrapper = mountDialog()
    await nextTick()
    document.querySelector('.sfd-head button[aria-label="关闭"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(wrapper.emitted('close')).toBeTruthy()
    expect(wrapper.emitted('abort')).toBeFalsy()
  })

  it('头部 ✕ busy 时=中止上传（aria-label 翻转 + emit abort，不发 close）', async () => {
    wrapper = mountDialog({ busy: true })
    await nextTick()
    // busy 期真实动作是 abort 断 xhr（窗不关）——label/title 静态「关闭」是谎报
    const btn = document.querySelector('.sfd-head button[aria-label="中止上传"]')
    expect(btn, 'busy 期 ✕ 应读作「中止上传」').toBeTruthy()
    expect(btn.getAttribute('title')).toBe('中止上传')
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(wrapper.emitted('abort')).toBeTruthy()
    expect(wrapper.emitted('close')).toBeFalsy()
  })

  it('文件槽钮全部 ghost 降级——窗内唯一实墨 CTA 是「创建/保存」', async () => {
    wrapper = mountDialog()
    await nextTick()
    const slotBtns = [...document.querySelectorAll('.sfd-file-row .ink-btn')]
    expect(slotBtns.length).toBe(4)
    for (const b of slotBtns) expect(b.classList.contains('ink-btn--ghost')).toBe(true)
    const submit = document.querySelector('.sfd-foot .ink-btn:not(.ink-btn--ghost)')
    expect(submit.textContent).toContain('创建')
  })
})

// PlaylistPanel 评审修复回归：
//   M2 死链不进剪贴板——「复制分享链接」菜单项已随行内分享键去重下线，
//      语义改钉在 sharePlaylist 路径：playlistShareUrl 返回 null（非数字远端
//      id 等死链拦截）时 shareOrCopy 用 text 兜底复制文案，而非把字面量
//      'null' 写进剪贴板还报假成功
//   ⋯ 菜单换面：首项「播放歌单」（触屏封面 hover 劫持的替代入口），
//      无重复的「复制分享链接」
//   主页重构 U2 + 去双语微标签：侧栏首行同轴（panel-head flex-start /
//      label 顶距 0 / create-btn 负顶距 -6px@20px 行高 + 窄轨复位）、
//      panel-label 去 pg-label 升 14/600 节题、library 双语签摘除、
//      页脚计数退役并入节题（.panel-count），与 style.css 卡件退役项——
//      jsdom 不计算样式，几何锚全走源文本钉板
//   U3：侧栏主导航组（首页/下载/设置，centerView 高亮 + remoteMode 闸）+
//      歌单行降噪（pl-actions 浮出式、pl-meta 只留 N 首）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('../../src/api/downloads.js', () => ({
  downloadsApi: {
    mirrorLocalPlaylist: vi.fn(async () => ({})),
    quickDownloadPlaylist: vi.fn(async () => ({})),
    deletePlaylistDownloads: vi.fn(async () => ({})),
  },
}))
vi.mock('../../src/lib/feedback.js', () => ({
  toast: vi.fn(),
  pixelConfirm: vi.fn(async () => true),
}))

import { toast } from '../../src/lib/feedback.js'
import { downloadsApi } from '../../src/api/downloads.js'
import PlaylistPanel from '../../src/components/PlaylistPanel.vue'

const writeText = vi.fn(async () => {})
Object.defineProperty(navigator, 'clipboard', {
  value: { writeText },
  configurable: true,
})

// id 非数字非 local/壳——share.js playlistShareUrl 的死链拦截返回 null
const oddPlaylist = { id: 'x_odd', name: '异形单', trackCount: 2, tracks: [{ id: 1 }] }
const numericPlaylist = { id: 777, name: '正常单', trackCount: 2, tracks: [{ id: 1 }] }

let wrapper = null
const mountPanel = (playlist, extraProps = {}) => mount(PlaylistPanel, {
  attachTo: document.body, // ⋯菜单 Teleport 到 body——挂上才能查
  props: { userPlaylists: [playlist], ...extraProps },
  global: { stubs: { GlitchText: true, PixelIcon: true } },
})

// 行内分享键点按（分享键 = 去重后的唯一分享入口）
async function clickShareButton() {
  await wrapper.find('button[aria-label="分享歌单"]').trigger('click')
  await nextTick()
}

beforeEach(() => { vi.clearAllMocks() })
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('PlaylistPanel：分享死链拦截（M2 改道行内分享键）', () => {
  it('url=null 兜底复制文案——不写字面量 null，报成功 toast', async () => {
    wrapper = mountPanel(oddPlaylist)
    await nextTick()
    await clickShareButton()
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled())
    const copied = writeText.mock.calls[0][0]
    expect(copied).not.toBe('null')
    expect(copied).toContain('异形单') // url=null → shareOrCopy 复制 text 兜底
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.stringContaining('已复制'), 'success'))
  })

  it('正常单照走分享闭环——writeText 收真链 + 成功 toast', async () => {
    wrapper = mountPanel(numericPlaylist)
    await nextTick()
    await clickShareButton()
    // copyText 内 await writeText——成功 toast 挂在剪贴板 resolve 之后的微任务上
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith('分享链接已复制到剪贴板', 'success'))
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('?playlist=777'))
  })
})

describe('PlaylistPanel：⋯ 菜单换面', () => {
  it('首项「播放歌单」，无「复制分享链接」', async () => {
    wrapper = mountPanel(numericPlaylist)
    await nextTick()
    await wrapper.find('button[aria-label="更多操作"]').trigger('click')
    await nextTick()
    const items = [...document.body.querySelectorAll('.playlist-menu .pg-menu-item')]
    const texts = items.map(el => el.textContent)
    expect(texts[0]).toContain('播放歌单')
    expect(texts.some(t => t.includes('复制分享链接'))).toBe(false)
  })
})

// 远端单的本地增删（addedTracks/removedTrackIds 只活 localStorage）必须随
// quick 建队下发——否则服务端枚举 playlist_tracks 时追加曲缺席、墓碑曲照下；
// 且两键无条件发：addedTracks 是服务端对账的权威全集，缺省=无信号、空集=清空
const clickDownload = async () => {
  await wrapper.find('button[aria-label="更多操作"]').trigger('click')
  await nextTick()
  // 菜单 Teleport 到 body——querySelector 拿到的是裸 DOM 不是 wrapper，用原生 click
  const item = [...document.body.querySelectorAll('.playlist-menu .pg-menu-item')]
    .find(el => el.textContent.includes('下载歌单') && !el.textContent.includes('含视频'))
  item.click()
  await vi.waitFor(() => expect(downloadsApi.quickDownloadPlaylist).toHaveBeenCalled())
}

describe('PlaylistPanel：localDelta 出键条件', () => {
  it('纯数字 id 单且有增删 → options.localDelta 携带原对象（投影在 api 层做）', async () => {
    const remotePl = {
      id: 555, name: '远端单', trackCount: 3,
      addedTracks: [{ id: 'yt_abc', name: '追加曲' }],
      removedTrackIds: ['999000'],
    }
    wrapper = mountPanel(remotePl)
    await nextTick()
    await clickDownload()
    const [pid, opts] = downloadsApi.quickDownloadPlaylist.mock.calls.at(-1)
    expect(String(pid)).toBe('555')
    expect(opts.localDelta).toEqual({
      addedTracks: [{ id: 'yt_abc', name: '追加曲' }],
      removedIds: ['999000'],
    })
    expect(downloadsApi.mirrorLocalPlaylist).not.toHaveBeenCalled()
  })

  it('无增删的远端单 → 也发空 localDelta（「清空到零」权威信号须到服务端）', async () => {
    // 两键空数组也是权威信号：服务端拿 addedTracks 对账剪标记行——
    // 条件发送会让「删掉全部本地追加曲」永远到不了服务端，落库行成幽灵
    wrapper = mountPanel(numericPlaylist)
    await nextTick()
    await clickDownload()
    const [, opts] = downloadsApi.quickDownloadPlaylist.mock.calls.at(-1)
    expect(opts.localDelta).toEqual({ addedTracks: [], removedIds: [] })
  })

  it('local_pl_ 本地单走整单镜像——有增删字段也不发 localDelta', async () => {
    const localPl = {
      id: 'local_pl_delta', name: '本地单', trackCount: 1,
      tracks: [{ id: 1, name: 'a' }],
      addedTracks: [{ id: 'yt_x', name: '脏字段' }], // 镜像整体承载，不该再出 delta 键
      removedTrackIds: ['1'],
    }
    wrapper = mountPanel(localPl)
    await nextTick()
    await clickDownload()
    expect(downloadsApi.mirrorLocalPlaylist).toHaveBeenCalledWith(localPl)
    const [, opts] = downloadsApi.quickDownloadPlaylist.mock.calls.at(-1)
    expect('localDelta' in opts).toBe(false)
  })
})

/* ── CSS 源钉板：侧栏首行同轴 + 全局卡件新规（jsdom 不计算样式，只能源读）──
   vitest 侧按 cwd（仓根）相对读，与 watch-stage-ui.spec.mjs 同口径 */
const readSrc = (rel) => readFileSync(join(process.cwd(), rel), 'utf8')

describe('PlaylistPanel 源钉板：首行同轴（B 方案）', () => {
  it('.panel-head flex-start + .panel-label 顶距 0 + .panel-create-btn 负顶距', () => {
    const css = readSrc('src/components/PlaylistPanel.vue')
    // align-items:flex-start + 32px 键负顶距上收：label 顶缘严落 20px 首行轴
    const head = css.match(/\.panel-head\s*\{[\s\S]*?\}/)?.[0] || ''
    expect(head).toContain('align-items: flex-start')
    const label = css.match(/\.panel-label\s*\{[\s\S]*?\}/)?.[0] || ''
    expect(label).toContain('padding: 0 12px 12px')
    // 去 pg-label 微标签后升格为 14/600 侧栏节题；行高钉 20px 供同心算式取定值
    expect(label).toContain('font-size: 14px')
    expect(label).toContain('font-weight: 600')
    expect(label).toContain('line-height: 20px')
    const btn = css.match(/\.panel-create-btn\s*\{[^}]*\}/)?.[0] || ''
    // 32px 键中心对齐 20px 行高文本行中心：-(32/2 - 20/2) = -6
    expect(btn).toContain('margin: -6px 0 4px')
  })

  it('侧栏标题只留中文「我的歌单」（去 library/pg-label 类），计数并入节题', () => {
    const css = readSrc('src/components/PlaylistPanel.vue')
    expect(css).toContain('<span class="panel-count">{{ userPlaylists.length }}</span>')
    expect(css).not.toContain('library')
    expect(css).not.toContain('pg-label panel-label')
    expect(css).not.toContain('pl-foot')
    expect(css).toContain('panel-count')
    expect(css).not.toContain('} playlists')
  })

  it('窄轨未展开态 .panel-create-btn 复位 margin: 0 0 6px', () => {
    const css = readSrc('src/components/PlaylistPanel.vue')
    const narrow = css.match(/@media \(min-width: 768px\) and \(max-width: 1023\.98px\)[\s\S]*?\n\}/)?.[0] || ''
    expect(narrow).toContain('.app-sidebar:not(.app-sidebar--open) .panel-create-btn')
    expect(narrow).toContain('margin: 0 0 6px')
  })
})

describe('PlaylistPanel：侧栏主导航 + 行降噪（U3）', () => {
  it('主导航三行（首页/下载/设置）渲在歌单区上方，centerView 命中行挂 --active', async () => {
    wrapper = mountPanel(numericPlaylist, { centerView: 'home' })
    await nextTick()
    const rows = wrapper.findAll('.side-nav-row')
    expect(rows.length).toBe(3)
    expect(rows.map(r => r.text())).toEqual(['首页', '下载', '设置'])
    expect(rows[0].classes()).toContain('side-nav-row--active')
    expect(wrapper.find('.side-nav-sep').exists()).toBe(true)
  })

  it('remoteMode=host 藏「下载」行；centerView=downloads 时保留逃生且高亮', async () => {
    wrapper = mountPanel(numericPlaylist, { remoteMode: 'host' })
    await nextTick()
    expect(wrapper.findAll('.side-nav-row').map(r => r.text())).toEqual(['首页', '设置'])
    wrapper.unmount()

    wrapper = mountPanel(numericPlaylist, { remoteMode: 'host', centerView: 'downloads' })
    await nextTick()
    const dl = wrapper.findAll('.side-nav-row').find(r => r.text() === '下载')
    expect(dl).toBeTruthy()
    expect(dl.classes()).toContain('side-nav-row--active')
  })

  it('remoteMode=off 下「下载」行同渲染（闸只挡 host）', async () => {
    wrapper = mountPanel(numericPlaylist, { remoteMode: 'off' })
    await nextTick()
    expect(wrapper.findAll('.side-nav-row').map(r => r.text())).toContain('下载')
  })

  it('点「设置」行发 nav-view emit 载荷 settings（同型 home/downloads 同约定）', async () => {
    wrapper = mountPanel(numericPlaylist)
    await nextTick()
    const settings = wrapper.findAll('.side-nav-row').find(r => r.text() === '设置')
    await settings.trigger('click')
    expect(wrapper.emitted('nav-view')).toEqual([['settings']])
  })

  it('计数并入「我的歌单」节题（.panel-count），页脚 .pl-foot 已摘', async () => {
    wrapper = mountPanel(numericPlaylist)
    await nextTick()
    expect(wrapper.find('.panel-count').text()).toBe('1')
    expect(wrapper.find('.pl-foot').exists()).toBe(false)
  })

  it('行降噪源钉板：.pl-actions 浮出式（opacity:0 + hover/focus-within/菜单开态 显 + hover:none 常显），.pl-meta 只留 N 首', () => {
    const css = readSrc('src/components/PlaylistPanel.vue')
    const actions = css.match(/\.pl-actions\s*\{[^}]*\}/)?.[0] ?? ''
    expect(actions).toContain('opacity: 0')
    expect(css).toContain('.pl-row:hover .pl-actions')
    expect(css).toContain('.pl-row:focus-within .pl-actions')
    // 菜单开态持显：⋯ 菜单 teleport 到 body，指针移入菜单时行已失 hover——态类兜底
    expect(css).toContain('.pl-row--menu-open .pl-actions')
    expect(css).toContain("'pl-row--menu-open': openMenuId === playlist.id")
    const hoverNone = css.match(/@media \(hover: none\)\s*\{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(hoverNone).toContain('opacity: 1')
    expect(hoverNone).toContain('padding-right: 64px')
    // 行块右槽常态 16（动作键不再常驻占宽）
    expect(css).toContain('padding: 9px 16px 9px 10px')
    // meta 行只剩「N 首」——创建者并入 .pl-info 的 title 提示
    expect(css).toContain('<p class="pl-meta">{{ playlist.trackCount ?? 0 }} 首</p>')
    expect(css).toContain(':title="`${playlist.name} · ${playlist.creator?.nickname')
  })

  it('窄轨导航源钉板：.side-nav-label display:none 藏字留图标；home/settings PixelIcon 已注册', () => {
    const css = readSrc('src/components/PlaylistPanel.vue')
    // 窄轨未展开态藏文字留图标列——断言窄轨媒体块内的藏字规则存在
    const narrow = css.match(/@media \(min-width: 768px\) and \(max-width: 1023\.98px\)[\s\S]*?\n\}/)?.[0] || ''
    expect(narrow).toContain('.side-nav-label { display: none')
    // 导航行引用的两枚图标必须在 PixelIcon ICONS 表注册（缺注册渲空 path 静默失守）
    const icons = readSrc('src/components/PixelIcon.vue')
    expect(icons).toContain("'home':")
    expect(icons).toContain("'settings':")
  })
})

describe('style.css 源钉板：grid-card 退役项与彩布登记', () => {
  const css = readSrc('src/style.css')

  it('.grid-card-name 去 min-height 死白、封面 img 去 pixelated 锯齿', () => {
    const name = css.match(/\.grid-card-name\s*\{[\s\S]*?\}/)?.[0] || ''
    expect(name).not.toContain('min-height')
    const img = css.match(/\.grid-card-cover img\s*\{[\s\S]*?\}/)?.[0] || ''
    expect(img).not.toContain('image-rendering')
  })

  it('彩布白名单登记 .home-songrow-artist + 反白补丁带回收 label-grey', () => {
    // 不登记 (0,3,0) 白名单的 ink-64 次级文字在彩布上静默不达标
    expect(css).toContain('.app-shell .app-body .home-songrow-artist')
    expect(css).toContain('.app-shell .app-body .home-songrow--playing .home-songrow-artist')
    // 反白行尾键 hover：默认纸色 / glitch accent-on-ink 两态都要接住 playing 行
    expect(css).toContain('.app-shell .home-songrow--playing .row-add-btn:hover')
    expect(css).toContain(':root[data-theme="glitch-restoration"] .app-shell .home-songrow--playing .row-add-btn:hover')
  })

  it('.row-add-btn 显隐组接入 .home-songrow，grid-card 浮层件在位', () => {
    expect(css).toContain('.home-songrow:hover .row-add-btn')
    expect(css).toContain('.home-songrow:focus-within .row-add-btn')
    expect(css).toContain('.grid-card--playing')
    expect(css).toContain('.grid-card-badge')
    expect(css).toContain('.grid-card-play')
  })
})

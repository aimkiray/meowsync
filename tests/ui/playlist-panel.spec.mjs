// PlaylistPanel 评审修复回归：
//   M2 死链不进剪贴板——「复制分享链接」菜单项已随行内分享键去重下线，
//      语义改钉在 sharePlaylist 路径：playlistShareUrl 返回 null（非数字远端
//      id 等死链拦截）时 shareOrCopy 用 text 兜底复制文案，而非把字面量
//      'null' 写进剪贴板还报假成功
//   ⋯ 菜单换面：首项「播放歌单」（触屏封面 hover 劫持的替代入口），
//      无重复的「复制分享链接」
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'

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
const mountPanel = (playlist) => mount(PlaylistPanel, {
  attachTo: document.body, // ⋯菜单 Teleport 到 body——挂上才能查
  props: { userPlaylists: [playlist] },
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

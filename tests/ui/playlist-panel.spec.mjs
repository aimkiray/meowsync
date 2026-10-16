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

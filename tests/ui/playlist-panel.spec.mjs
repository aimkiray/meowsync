// PlaylistPanel 评审修复回归：
//   M2 copyShareLink——playlistShareUrl 返回 null（非数字远端 id 等死链拦截
//      语义）时不得走 copyText：clipboard.writeText(null) 会被归一成字面量
//      'null' 还报假成功 toast。复制按钮没有 shareOrCopy 的 text 兜底，
//      null 要拦在复制前给交代
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

// 开 ⋯ 菜单 → 点「复制分享链接」menuitem（teleport 落 body）
async function clickCopyShareLink() {
  await wrapper.find('button[aria-label="更多操作"]').trigger('click')
  await nextTick()
  const item = [...document.body.querySelectorAll('.playlist-menu .pg-menu-item')]
    .find(el => el.textContent.includes('复制分享链接'))
  expect(item).toBeTruthy()
  item.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await nextTick()
}

beforeEach(() => { vi.clearAllMocks() })
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('PlaylistPanel：复制分享链接', () => {
  it('M2：url=null 拦在复制前——不写剪贴板、报 info 而非假成功', async () => {
    wrapper = mountPanel(oddPlaylist)
    await nextTick()
    await clickCopyShareLink()
    expect(writeText).not.toHaveBeenCalled() // 关键钉：不得把字面量 'null' 复制出去
    expect(toast).toHaveBeenCalledWith('该歌单暂无可用分享链接', 'info')
  })

  it('正常单照走复制闭环——writeText 收真链 + 成功 toast', async () => {
    wrapper = mountPanel(numericPlaylist)
    await nextTick()
    await clickCopyShareLink()
    // copyText 内 await writeText——成功 toast 挂在剪贴板 resolve 之后的微任务上
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith('分享链接已复制到剪贴板', 'success'))
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('?playlist=777'))
  })
})

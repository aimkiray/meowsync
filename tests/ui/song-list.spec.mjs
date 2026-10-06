// SongList 行菜单「重新匹配歌词」：/match/retry 命中 → applyMatchResult
// 整组重建 + emit 'song-meta-updated' 落盘 + notifyLyricRematch 通知播放器；
// 空回包（用户显式否决后无替代）→ 解绑 provider 态而非报「没找到」败象
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'

vi.mock('../../src/api/music.js', () => ({
  musicApi: { retryMatch: vi.fn(async () => null) },
}))
vi.mock('../../src/api/downloads.js', () => ({
  downloadsApi: {
    listTasks: vi.fn(async () => ({ data: [] })),
    getSongDownloadStatus: vi.fn(async () => null),
  },
}))
vi.mock('../../src/lib/feedback.js', () => ({
  toast: vi.fn(),
  pixelConfirm: vi.fn(async () => true),
}))
// 行菜单换绑通知槽是模块级单例——桩成 vi.fn() 断言载荷
vi.mock('../../src/composables/usePlayer.js', () => ({
  notifyLyricRematch: vi.fn(),
}))

import { musicApi } from '../../src/api/music.js'
import { toast } from '../../src/lib/feedback.js'
import { notifyLyricRematch } from '../../src/composables/usePlayer.js'
import SongList from '../../src/components/SongList.vue'

// 残留形态：旧错配把 matched.al 烘进曲对象（provider 块完好）
const dirtyYtSong = () => ({
  id: 'yt_abcdefghijk', name: '乐园', ar: [{ name: 'EMA' }],
  al: { id: 1, name: '10乐园', picUrl: 'http://n/dirty.jpg' },
  dt: 200000, neteaseId: 390558,
  youtube: { videoId: 'abcdefghijk', title: 'EMA - 乐园(粤)', author: 'EMA', authorClean: 'EMA' },
})
const bvSong = () => ({
  id: 'bv_BV1xx411c7mD', name: '视频标题', ar: [{ name: 'UP主' }],
  al: { id: 99, name: '脏专辑', picUrl: 'http://n/dirty.jpg' },
  dt: 200000, neteaseId: 111,
  bilibili: { bvid: 'BV1xx411c7mD', title: '视频标题', author: 'UP主', cover: 'http://i0.hdslb.com/bfs/c.jpg' },
})

let wrapper = null
const mountList = (song) => mount(SongList, {
  attachTo: document.body, // Teleport 菜单落 body——挂上才能查
  props: {
    songs: [song],
    selectedPlaylist: { id: 'local_pl_1', name: 'P', tracks: [song], isLocal: true },
    playlistInLibrary: true,
  },
  global: {
    // GlitchText 依赖 jsdom 没有的 matchMedia（prefers-reduced-motion
    // 探测）——桩成渲染壳，菜单行为用例不消费动画层
    stubs: { GlitchText: true, PixelIcon: true },
  },
})

// ⋯ 键开菜单（teleport 到 body）→ 点「重新匹配歌词」menuitem
async function clickRematchItem() {
  await wrapper.find('.song-menu-btn').trigger('click')
  await nextTick()
  const item = [...document.body.querySelectorAll('.pg-menu-item')]
    .find(el => el.textContent.includes('重新匹配歌词'))
  expect(item).toBeTruthy()
  item.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

beforeEach(() => {
  vi.clearAllMocks()
  musicApi.retryMatch.mockResolvedValue(null)
})
afterEach(() => {
  wrapper?.unmount() // teleport 残骸随 unmount 清掉
  wrapper = null
})

describe('SongList：行菜单重匹配', () => {
  it('命中：applyMatchResult 整组重建（al 跟新匹配走）+ emit 落盘 + 通知播放器', async () => {
    const song = bvSong()
    musicApi.retryMatch.mockResolvedValue({
      id: 222, name: '对的歌', ar: [{ name: 'UP主' }],
      al: { id: 9, name: '对的专辑', picUrl: 'http://n/9.jpg' },
    })
    wrapper = mountList(song)
    await nextTick()
    await clickRematchItem()
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith('词源已重匹配为《对的歌》', 'success'))
    expect(song.neteaseId).toBe(222)
    // 命中后 al.name 跟着新匹配走（艺人重合→采纳），不再留脏专辑名
    expect(song.al.name).toBe('对的专辑')
    expect(song.al.id).toBe(9)
    // provider 封面优先——matched.picUrl 不抢位
    expect(song.al.picUrl).toBe('http://i0.hdslb.com/bfs/c.jpg')
    // 持久化收口：菜单侧拿不到 savePlaylistsToStorage——emit 上抛 App 落盘
    expect(wrapper.emitted('song-meta-updated')).toBeTruthy()
    expect(notifyLyricRematch).toHaveBeenCalledWith('bv_BV1xx411c7mD', 222)
  })

  it('空回包=解绑：neteaseId 置 null、al 回 provider 态，emit+通知照常发', async () => {
    const song = dirtyYtSong()
    wrapper = mountList(song)
    await nextTick()
    await clickRematchItem()
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith('已解除错配，暂无更准的词源', 'info'))
    expect(song.neteaseId).toBeNull()
    // 错配烘进的专辑名/封面被清掉——回 provider 展示态
    expect(song.al.name).toBe('EMA - 乐园(粤)')
    expect(song.al.id).toBeNull()
    expect(song.al.picUrl).toBe('https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg')
    expect(song.name).toBe('EMA - 乐园(粤)')
    expect(wrapper.emitted('song-meta-updated')).toBeTruthy()
    // 解绑信号也通知播放器（neteaseId=null）——正播曲清绑+热重载词
    expect(notifyLyricRematch).toHaveBeenCalledWith('yt_abcdefghijk', null)
  })

  it('请求失败：不改曲对象，落错误 toast', async () => {
    const song = dirtyYtSong()
    musicApi.retryMatch.mockRejectedValue(new Error('网络错误'))
    wrapper = mountList(song)
    await nextTick()
    await clickRematchItem()
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.stringContaining('重新匹配失败'), 'error'))
    expect(song.neteaseId).toBe(390558) // 失败不动绑定
    expect(wrapper.emitted('song-meta-updated')).toBeFalsy()
  })
})

// useAddToPlaylist 点歌台 bili: 前缀钉板（vitest+jsdom，musicApi mock）：
//   bili:<b23 短链>   → resolveBilibili 剥前缀送达——整串 'bili:b23.tv/x'
//                        会被 isBilibiliInput 的 b23 域名判连壳送进 resolve，
//                        服务端 ^b23\.tv/ 锚被前缀挡必死 400；bili: 块提到
//                        整串 B 站判别之前即为此
//   bili:<BV/av/链接>  → resolve 直解先行（与 isBilibiliInput 分支同链）——
//                        resolve 失败回落关键词搜索；裸 BV 已在单本地短路
//   bili:<收藏夹链>     → 指向性提示（整单导入走顶栏，点歌台无落点）
//   bili:<关键词>       → searchBiliSongs → buildBilibiliSong 归一 bv_ 行
//   bili:<bili2233 短链> → resolveBilibili 剥前缀送达（官方短链域与 b23 同档）
//   bili:<空>           → 静默吞
//   无前缀回归：b23.tv/bili2233.cn/BV 裸输入照旧走整串 isBilibiliInput resolve 分支
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'

const { musicApi, toast } = vi.hoisted(() => ({
  musicApi: {
    resolveBilibili: vi.fn(),
    searchBiliSongs: vi.fn(),
    searchSongs: vi.fn(),
    getSongDetail: vi.fn(),
  },
  toast: vi.fn(() => 1),
}))
vi.mock('../../src/api/music.js', () => ({ musicApi }))
vi.mock('../../src/lib/feedback.js', () => ({ toast, toastDismiss: vi.fn() }))

const { createReqGate } = await import('../../src/lib/req-gate.js')
const { useAddToPlaylist } = await import('../../src/composables/useAddToPlaylist.js')

// 服务端行形 / resolve 回包形——同 buildBilibiliSong 输入孔径
const ROW = (bvid, over = {}) => ({
  bvid, cid: null, page: 1, title: `曲-${bvid}`, songName: `曲-${bvid}`,
  owner: 'UP主', cover: 'https://i0.hdslb.com/x.jpg', duration: 180,
  hasVideo: true, hasDownloadableVideo: true,
  matched: null, matchedBy: null, matchScore: null, publishedAt: null,
  ...over,
})
const RESOLVED = (bvid) => ROW(bvid, { cid: 100, title: `解析-${bvid}`, songName: `解析-${bvid}` })

const PL = { id: 'local_pl_1', name: '目标单', isLocal: true, tracks: [] }

const makeAtp = (plTracks = []) => {
  const libPl = { ...PL, tracks: plTracks }
  const deps = {
    gates: { picker: createReqGate() },
    userPlaylists: ref([libPl]),
    selectedPlaylist: ref({ id: 'local_pl_1', name: '目标单', tracks: plTracks }),
    songs: ref([]),
    addPlaylistToLibrary: vi.fn(),
    appendSongToLibraryPlaylist: vi.fn(() => 'added'),
    createLocalPlaylist: vi.fn(),
    closeCreatePlaylist: vi.fn(),
  }
  const atp = useAddToPlaylist(deps)
  atp.openSongPicker()
  return { atp, deps }
}
const search = async (atp, q) => {
  atp.songPickerQuery.value = q
  await atp.songPickerSearch()
}

beforeEach(() => {
  vi.clearAllMocks()
  toast.mockReturnValue(1)
  musicApi.searchBiliSongs.mockResolvedValue({ items: [ROW('BV1xx411c7XJ')] })
  musicApi.resolveBilibili.mockResolvedValue(RESOLVED('BV1xx411c7XE'))
})

describe('useAddToPlaylist：bili: 前缀', () => {
  it('bili:<b23 短链> → resolveBilibili 剥前缀送达（整串连壳送进必死 400）', async () => {
    const { atp } = makeAtp()
    await search(atp, 'bili:b23.tv/abc123')
    expect(musicApi.resolveBilibili).toHaveBeenCalledWith('b23.tv/abc123', expect.any(AbortSignal))
    expect(musicApi.searchBiliSongs).not.toHaveBeenCalled()
  })

  it('bili:<bili2233 短链> → resolveBilibili 剥前缀送达（官方短链域与 b23 同档）', async () => {
    const { atp } = makeAtp()
    await search(atp, 'bili:bili2233.cn/abc123')
    expect(musicApi.resolveBilibili).toHaveBeenCalledWith('bili2233.cn/abc123', expect.any(AbortSignal))
    expect(musicApi.searchBiliSongs).not.toHaveBeenCalled()
  })

  it('bili:<BV/av> → resolve 直解入单（剥前缀，不烧搜索配额）', async () => {
    const { atp, deps } = makeAtp()
    await search(atp, 'bili:BV1xx411c7XE')
    expect(musicApi.resolveBilibili).toHaveBeenCalledWith('BV1xx411c7XE', expect.any(AbortSignal))
    expect(musicApi.searchBiliSongs).not.toHaveBeenCalled()
    expect(atp.songPickerResults.value[0].id).toBe('bv_BV1xx411c7XE')
    expect(deps.appendSongToLibraryPlaylist).toHaveBeenCalled()
    await search(atp, 'bili:av170001')
    expect(musicApi.resolveBilibili).toHaveBeenCalledWith('av170001', expect.any(AbortSignal))
  })

  it('bili:<收藏夹链> → 指向性提示，无上游请求', async () => {
    const { atp } = makeAtp()
    await search(atp, 'bili:https://space.bilibili.com/42/favlist?fid=123456')
    expect(musicApi.resolveBilibili).not.toHaveBeenCalled()
    expect(musicApi.searchBiliSongs).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith('这是 B 站收藏夹链接，请在顶部搜索框粘贴导入', 'info')
  })

  it('bili:<关键词> → searchBiliSongs 直搜，行形归一 bv_ 曲', async () => {
    const { atp } = makeAtp()
    await search(atp, 'bili:周杰伦 青花瓷')
    expect(musicApi.searchBiliSongs).toHaveBeenCalledWith('周杰伦 青花瓷', { signal: expect.any(AbortSignal) })
    expect(musicApi.resolveBilibili).not.toHaveBeenCalled()
    expect(atp.songPickerResults.value[0].id).toBe('bv_BV1xx411c7XJ')
  })

  it('bili:<id 形> resolve 失败 → 回落关键词搜索', async () => {
    const { atp } = makeAtp()
    musicApi.resolveBilibili.mockRejectedValue(new Error('视频不存在'))
    await search(atp, 'bili:BV1xx411c7XE')
    expect(musicApi.resolveBilibili).toHaveBeenCalled()
    expect(musicApi.searchBiliSongs).toHaveBeenCalledWith('BV1xx411c7XE', { signal: expect.any(AbortSignal) })
    expect(atp.songPickerResults.value[0].id).toBe('bv_BV1xx411c7XJ')
  })

  it('bili:<已在单 BV> → 本地短路，resolve/搜索都不打', async () => {
    const { atp } = makeAtp([{ id: 'bv_BV1xx411c7XE', name: '已有' }])
    await search(atp, 'bili:BV1xx411c7XE')
    expect(musicApi.resolveBilibili).not.toHaveBeenCalled()
    expect(musicApi.searchBiliSongs).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith('该视频已在歌单里', 'info')
  })

  it('bili:<空> → 静默吞；无前缀 b23.tv/bili2233.cn/BV 裸输入照旧整串 resolve 分支', async () => {
    const { atp } = makeAtp()
    await search(atp, 'bili:   ')
    expect(musicApi.resolveBilibili).not.toHaveBeenCalled()
    expect(musicApi.searchBiliSongs).not.toHaveBeenCalled()
    await search(atp, 'b23.tv/abc123')
    expect(musicApi.resolveBilibili).toHaveBeenCalledWith('b23.tv/abc123', expect.any(AbortSignal))
    await search(atp, 'bili2233.cn/abc123')
    expect(musicApi.resolveBilibili).toHaveBeenCalledWith('bili2233.cn/abc123', expect.any(AbortSignal))
    await search(atp, 'BV1xx411c7XE')
    expect(musicApi.resolveBilibili).toHaveBeenCalledWith('BV1xx411c7XE', expect.any(AbortSignal))
  })
})

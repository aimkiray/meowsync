// usePlayer 状态机：Howl 全桩捕获回调，驱动 onload/onplay/onloaderror
// 断言——本地档优先 / 本地档坏转在线 / 竞态切歌 / 队列快照 / 持久化恢复。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, nextTick } from 'vue'

// ── Howler 桩：实例入册，回调手动触发（模拟真实异步事件序）──
const { howls } = vi.hoisted(() => ({ howls: [] }))
vi.mock('howler', () => {
  class FakeHowl {
    constructor(opts) { this.opts = opts; this._seek = 0; this._vol = 1; this.unloaded = false; howls.push(this) }
    play() { this.opts.onplay?.() }
    pause() { this.opts.onpause?.() }
    stop() { this.opts.onstop?.() }
    unload() { this.unloaded = true }
    duration() { return this.opts._duration ?? 200 }
    seek(v) { if (v === undefined) return this._seek; this._seek = v; return this._seek }
    volume(v) { if (v === undefined) return this._vol; this._vol = v }
    rate(v) { return v === undefined ? 1 : undefined }
    playing() { return false }
    state() { return 'loaded' }
    fire(name, ...args) { this.opts[name]?.(...args) }
  }
  return { Howl: FakeHowl, Howler: { html5PoolSize: 0, volume: vi.fn(), mute: vi.fn() } }
})

vi.mock('../../src/api/music.js', () => ({
  musicApi: {
    getSongUrl: vi.fn(async () => ({ url: 'https://cdn.example/online.mp3', br: 320000 })),
    searchSongs: vi.fn(async () => []),
    bilibiliStreamUrl: vi.fn(() => 'https://x/bili'),
    youtubeStreamUrl: vi.fn(() => 'https://x/yt'),
    qqStreamUrl: vi.fn(() => 'https://x/qq'),
    // 返回形与生产一致：http.js 拦截器已剥 axios 壳，getLyrics 回 {lyrics}
    getLyrics: vi.fn(async () => ({ lyrics: [] })),
    getQQLyric: vi.fn(async () => ({ lyrics: [] })),
    getExternalLyric: vi.fn(async () => null),
    retryMatch: vi.fn(async () => null),
  },
  parseLyrics: vi.fn(() => []),
  mergeTranslations: vi.fn((l) => l),
}))
vi.mock('../../src/api/downloads.js', () => ({
  downloadsApi: {
    getSongDownloadStatus: vi.fn(async () => null),
    songFileUrl: vi.fn((plId, songId) => `http://api/dl/${plId}/${songId}`),
    // /song-meta/:id 回平铺 {code,songId,offsetMs}——生产读 meta?.offsetMs
    getSongMeta: vi.fn(async () => ({ offsetMs: 0 })),
    saveLyricOffset: vi.fn(async () => ({})),
    mirrorLocalPlaylist: vi.fn(async () => ({})),
    downloadSongToServer: vi.fn(async () => ({ data: { status: 'completed' } })),
  },
}))
vi.mock('../../src/api/ai.js', () => ({
  aiApi: {
    status: vi.fn(async () => ({ enabled: false })),
    translateLyric: vi.fn(async () => null),
    verifyLyric: vi.fn(async () => ({ ok: true })),
  },
}))
vi.mock('../../src/lib/feedback.js', () => ({ toast: vi.fn() }))
vi.mock('../../src/lib/theme.js', () => ({ glitchBurst: vi.fn() }))

import { musicApi, parseLyrics } from '../../src/api/music.js'
import { downloadsApi } from '../../src/api/downloads.js'
import { aiApi } from '../../src/api/ai.js'
import { toast } from '../../src/lib/feedback.js'
import { usePlayer } from '../../src/composables/usePlayer.js'
import { LS_KEYS } from '../../src/lib/storage.js'

const song = (id, extra = {}) => ({
  id, name: `歌${id}`, ar: [{ name: '艺人' }], al: { picUrl: 'https://c/p.jpg' }, dt: 200000, ...extra,
})

function makeGate() {
  let n = 0
  return { claim: () => ++n, current: () => n, isCurrent: (x) => x === n, invalidate: () => { n++ } }
}

function makePlayer({ songs = [] } = {}) {
  const deps = {
    gates: { mediaImport: makeGate(), preview: makeGate(), search: makeGate() },
    playingPlaylistId: ref(null),
    userPlaylists: ref([]),
    selectedPlaylist: ref(null),
    selectPlaylist: vi.fn(async () => true),
    savePlaylistsToStorage: vi.fn(),
    filteredSongs: ref(songs),
    showVipSongs: ref(true),
    fullscreenLyricMode: ref('lyric'),
    fullscreenInteractionMode: ref('drag'),
    recordPlayHistory: vi.fn(),
    recordPlaylistHistory: vi.fn(),
    enterWatch: vi.fn(), openWatchSong: vi.fn(), selectPlaylistAndShow: vi.fn(),
    setSidebarOpen: vi.fn(), getSearchSongResults: vi.fn(() => []),
  }
  return { player: usePlayer(deps), deps }
}

beforeEach(() => {
  howls.length = 0
  vi.clearAllMocks()
  localStorage.clear()
  musicApi.getSongUrl.mockImplementation(async () => ({ url: 'https://cdn.example/online.mp3', br: 320000 }))
  downloadsApi.getSongDownloadStatus.mockImplementation(async () => null)
  // clearAllMocks 只清调用记录不清实现——逐用例覆写的 mock 全部归位
  parseLyrics.mockImplementation(() => [])
  musicApi.getLyrics.mockResolvedValue({ lyrics: [] })
  musicApi.getExternalLyric.mockResolvedValue(null)
  musicApi.retryMatch.mockResolvedValue(null)
  aiApi.status.mockResolvedValue({ enabled: false })
  aiApi.verifyLyric.mockResolvedValue({ ok: true })
})

describe('usePlayer：播放主链', () => {
  it('playSong 取在线链 → Howl 建实例 → onplay 置 isPlaying 并记历史', async () => {
    const { player, deps } = makePlayer({ songs: [song(1)] })
    await player.playSong(song(1))
    expect(musicApi.getSongUrl).toHaveBeenCalledWith(1, expect.anything())
    expect(howls).toHaveLength(1)
    expect(howls[0].opts.src).toEqual(['https://cdn.example/online.mp3'])

    howls[0].fire('onload')
    expect(player.duration.value).toBe(200)
    howls[0].fire('onplay')
    expect(player.isPlaying.value).toBe(true)
    expect(deps.recordPlayHistory).toHaveBeenCalled()
    expect(player.currentSong.value.id).toBe(1)
  })

  it('切歌即回收旧实例；陈旧 onload 晚到被 isStale 守卫丢弃', async () => {
    const { player } = makePlayer()
    await player.playSong(song(1))
    expect(howls).toHaveLength(1)

    await player.playSong(song(2))
    expect(howls).toHaveLength(2)
    expect(howls[0].unloaded).toBe(true) // 第二次 playSong 同步回收旧实例

    // 陈旧实例的 onload 晚到——isStale 守卫（howl !== newHowl）丢弃，不碰共享态
    howls[0].fire('onload')
    howls[0].fire('onplay')
    expect(player.isPlaying.value).toBe(false)
    expect(player.duration.value).toBe(0)

    howls[1].fire('onload')
    howls[1].fire('onplay')
    expect(player.currentSong.value.id).toBe(2)
    expect(player.isPlaying.value).toBe(true)
  })

  it('并发 playSong：在途请求被 abort，不产生第二个 Howl', async () => {
    const { player } = makePlayer()
    const p1 = player.playSong(song(1))
    const p2 = player.playSong(song(2))
    await Promise.all([p1, p2])
    // p1 在 getSongDownloadStatus await 点被 p2 顶掉——未走到建实例即返回
    expect(howls).toHaveLength(1)
    expect(howls[0].opts.src).toEqual(['https://cdn.example/online.mp3'])
    expect(player.currentSong.value.id).toBe(2)
  })

  it('本地档优先：audioReady 探测命中 → 不打在线链、src 用 /file', async () => {
    downloadsApi.getSongDownloadStatus.mockResolvedValue({
      data: { audioReady: true, audioPlaylistId: 7 },
    })
    const { player } = makePlayer()
    await player.playSong(song(55))
    expect(musicApi.getSongUrl).not.toHaveBeenCalled()
    expect(downloadsApi.songFileUrl).toHaveBeenCalledWith(7, 55, 'audio')
    expect(howls[0].opts.src).toEqual(['http://api/dl/7/55'])
  })

  it('本地档解码失败回落在线流（_localTried 不再重探）', async () => {
    downloadsApi.getSongDownloadStatus.mockResolvedValue({
      data: { audioReady: true, audioPlaylistId: 7 },
    })
    const { player } = makePlayer()
    await player.playSong(song(55))
    expect(howls[0].opts.src).toEqual(['http://api/dl/7/55'])

    howls[0].fire('onloaderror', 0, 'MEDIA_ERR')
    await nextTick()
    await vi.waitFor(() => expect(howls.length).toBe(2))
    // 回落链走在线 getSongUrl，且不再探测本地档（call 仍 1 次）
    expect(musicApi.getSongUrl).toHaveBeenCalled()
    expect(downloadsApi.getSongDownloadStatus).toHaveBeenCalledTimes(1)
    expect(howls[1].opts.src).toEqual(['https://cdn.example/online.mp3'])
  })

  it('yt 曲不打在线流：无本地档直转下载链，completed 短路后递归钉 _localFile', async () => {
    const yt = song('yt_abcdefghijk', { youtube: { videoId: 'abcdefghijk', hasVideo: true } })
    const { player, deps } = makePlayer()
    deps.selectedPlaylist.value = { id: 'local_pl_1', name: 'P', tracks: [yt], isLocal: true }
    await player.playSong(yt)
    // completed 短路 → playDownloadedCopy 递归 playSong(_localFile) → Howl 挂 /file
    await vi.waitFor(() => expect(howls).toHaveLength(1))
    // 在线位全程零请求——不打 /youtube/stream，也不走网易云 getSongUrl
    expect(musicApi.youtubeStreamUrl).not.toHaveBeenCalled()
    expect(musicApi.getSongUrl).not.toHaveBeenCalled()
    // hasVideo 的 yt 曲提交下载连视频档一起下（WatchView 本地视频档的来源）
    expect(downloadsApi.downloadSongToServer).toHaveBeenCalledWith(
      'local_pl_1', 'yt_abcdefghijk',
      expect.objectContaining({ downloadVideo: true }))
    expect(downloadsApi.songFileUrl).toHaveBeenCalledWith('local_pl_1', 'yt_abcdefghijk', 'audio')
    expect(howls[0].opts.src).toEqual(['http://api/dl/local_pl_1/yt_abcdefghijk'])
  })

  it('在线链返回空 → playbackError 上屏、不建 Howl', async () => {
    downloadsApi.getSongDownloadStatus.mockResolvedValue(null)
    musicApi.getSongUrl.mockResolvedValue({ url: null })
    const { player } = makePlayer()
    await player.playSong(song(9))
    expect(howls).toHaveLength(0)
    expect(player.playbackError.value).toMatch(/无法获取播放链接/)
    expect(player.songSwitching.value).toBe(false)
  })
})

describe('usePlayer：YT 下载兜底链', () => {
  // 'abcdefghijk' 是合法 11 位 videoId 形态，yt_ 前缀走 YT_TRACK_ID_RE 判定
  const ytSong = (extra) => song('yt_abcdefghijk', extra)
  const localPl = (t) => ({ id: 'local_pl_1', name: 'P', tracks: [t], isLocal: true })

  it('yt_ 形态 id 缺 provider 对象（老持久化行）仍进下载链，不落 getSongUrl 死路', async () => {
    const yt = ytSong() // 无 youtube 对象——id 形态是全部凭据
    const { player, deps } = makePlayer()
    deps.selectedPlaylist.value = localPl(yt)
    await player.playSong(yt)
    await vi.waitFor(() => expect(howls).toHaveLength(1))
    expect(musicApi.getSongUrl).not.toHaveBeenCalled()
    // 无 provider 对象 → downloadVideo 保持 false（服务端按 id 前缀自解 videoId）
    expect(downloadsApi.downloadSongToServer).toHaveBeenCalledWith(
      'local_pl_1', 'yt_abcdefghijk', expect.objectContaining({ downloadVideo: false }))
    expect(howls[0].opts.src).toEqual(['http://api/dl/local_pl_1/yt_abcdefghijk'])
  })

  it('yt 曲仅 hasDownloadableVideo（vp9/av01 独占稿）也带视频相位', async () => {
    const yt = ytSong({ youtube: { videoId: 'abcdefghijk', hasVideo: false, hasDownloadableVideo: true } })
    const { player, deps } = makePlayer()
    deps.selectedPlaylist.value = localPl(yt)
    await player.playSong(yt)
    await vi.waitFor(() => expect(downloadsApi.downloadSongToServer).toHaveBeenCalled())
    expect(downloadsApi.downloadSongToServer).toHaveBeenCalledWith(
      'local_pl_1', 'yt_abcdefghijk', expect.objectContaining({ downloadVideo: true }))
  })

  it('mirror RTT 窗内切歌：旧代压死，不替没人等的歌提交孤儿任务', async () => {
    const yt = ytSong({ youtube: { videoId: 'abcdefghijk' } })
    const { player, deps } = makePlayer()
    deps.selectedPlaylist.value = localPl(yt)
    let releaseMirror
    downloadsApi.mirrorLocalPlaylist.mockImplementationOnce(
      () => new Promise(r => { releaseMirror = () => r({}) }))
    const p1 = player.playSong(yt)
    // 旧代兜底链停在 mirrorLocalPlaylist 的 await 上
    await vi.waitFor(() => expect(downloadsApi.mirrorLocalPlaylist).toHaveBeenCalled())
    const p2 = player.playSong(song(2)) // 切歌落在镜像在途窗内
    releaseMirror()
    await Promise.all([p1, p2])
    await new Promise(r => setTimeout(r, 0)) // 让旧代 mirror 回落跑完代次闸
    expect(downloadsApi.downloadSongToServer).not.toHaveBeenCalled()
    expect(howls).toHaveLength(1) // 新歌在线链照常建实例
  })

  it('无歌单上下文探测又无档：跳过 toast/镜像/提交，直落失败终态', async () => {
    const yt = ytSong({ youtube: { videoId: 'abcdefghijk' } })
    const { player } = makePlayer() // playingPlaylistId/selectedPlaylist 皆空 → playlistId=undefined
    await player.playSong(yt)
    await vi.waitFor(() => expect(player.playbackError.value).toMatch(/音频加载失败/))
    expect(downloadsApi.mirrorLocalPlaylist).not.toHaveBeenCalled()
    expect(downloadsApi.downloadSongToServer).not.toHaveBeenCalled()
    expect(player.songSwitching.value).toBe(false)
  })

  it('single_song_ 壳不可镜像：同跳提交直落失败终态', async () => {
    const yt = ytSong({ youtube: { videoId: 'abcdefghijk' } })
    const { player, deps } = makePlayer()
    deps.selectedPlaylist.value = { id: 'single_song_9', name: 'S', tracks: [yt] }
    await player.playSong(yt)
    await vi.waitFor(() => expect(player.playbackError.value).toMatch(/音频加载失败/))
    expect(downloadsApi.mirrorLocalPlaylist).not.toHaveBeenCalled()
    expect(downloadsApi.downloadSongToServer).not.toHaveBeenCalled()
  })

  it('无歌单上下文但探测命中别单档：跨歌单寻址仍可直播', async () => {
    const yt = ytSong({ youtube: { videoId: 'abcdefghijk' } })
    const { player } = makePlayer()
    downloadsApi.getSongDownloadStatus
      .mockImplementationOnce(async () => null)                            // 主链探测无档
      .mockResolvedValue({ data: { audioReady: true, audioPlaylistId: 7 } }) // 兜底探测命中别单
    await player.playSong(yt)
    await vi.waitFor(() => expect(howls).toHaveLength(1))
    expect(downloadsApi.downloadSongToServer).not.toHaveBeenCalled()
    expect(howls[0].opts.src).toEqual(['http://api/dl/7/yt_abcdefghijk'])
  })

  it('同曲连点：旧代兜底链被代次闸压死，不重复提交', async () => {
    const yt = ytSong({ youtube: { videoId: 'abcdefghijk' } })
    const { player, deps } = makePlayer()
    deps.selectedPlaylist.value = localPl(yt)
    let releaseStale
    downloadsApi.getSongDownloadStatus
      .mockImplementationOnce(async () => null)                                         // 一代主链探测
      .mockImplementationOnce(() => new Promise(r => { releaseStale = () => r(null) })) // 一代兜底探测挂起
      .mockImplementation(async () => null)                                             // 其余一律无档
    const p1 = player.playSong(yt)
    // 一代兜底链停在探测 await 上（主链探测+兜底探测共 2 次）
    await vi.waitFor(() => expect(downloadsApi.getSongDownloadStatus).toHaveBeenCalledTimes(2))
    const p2 = player.playSong(yt) // 同 id 重进——currentPlayingId 分不开两代
    await Promise.all([p1, p2])
    await vi.waitFor(() => expect(howls).toHaveLength(1)) // 二代 completed 短路→递归钉档建实例
    releaseStale() // 一代探测落地时世界已属三代
    await new Promise(r => setTimeout(r, 0))
    expect(downloadsApi.downloadSongToServer).toHaveBeenCalledTimes(1)
    expect(player.playbackError.value).toBe('')
  })

  it('提交撞 409（任务已在跑）：不判失败，轮询等档落后钉本地档续播', async () => {
    const yt = ytSong({ youtube: { videoId: 'abcdefghijk' } })
    const { player, deps } = makePlayer()
    deps.selectedPlaylist.value = localPl(yt)
    // 服务端 409 语义：该歌曲正在下载中——瞬时态不是失败，既有任务继续下
    downloadsApi.downloadSongToServer.mockRejectedValueOnce(
      { response: { status: 409, data: { message: '该歌曲正在下载中' } } })
    downloadsApi.getSongDownloadStatus
      .mockImplementationOnce(async () => null)                                    // 主链探测无档
      .mockImplementationOnce(async () => null)                                    // 兜底探测无档
      .mockImplementationOnce(async () => ({ data: { audioReady: false, task: { status: 'downloading' } } })) // 轮询1：仍在下
      .mockResolvedValue({ data: { audioReady: true, audioPlaylistId: 'local_pl_1' } })                      // 轮询2：档落
    await player.playSong(yt)
    // 轮询档 1500ms/轮是真实时钟——waitFor 窗放宽罩住两轮
    await vi.waitFor(() => expect(howls).toHaveLength(1), { timeout: 8000 })
    expect(player.playbackError.value).toBe('')
    expect(howls[0].opts.src).toEqual(['http://api/dl/local_pl_1/yt_abcdefghijk'])
    howls[0].fire('onload') // 切歌锁在 onload 才松——换链全程不弹失败文案
    expect(player.songSwitching.value).toBe(false)
  })

  it('提交撞 409 且轮询见 task:null：break 落「仍在进行」文案而非崩溃', async () => {
    const yt = ytSong({ youtube: { videoId: 'abcdefghijk' } })
    const { player, deps } = makePlayer()
    deps.selectedPlaylist.value = localPl(yt)
    downloadsApi.downloadSongToServer.mockRejectedValueOnce(
      { response: { status: 409, data: { message: '该歌曲正在下载中' } } })
    downloadsApi.getSongDownloadStatus
      .mockImplementationOnce(async () => null)                          // 主链探测无档
      .mockImplementationOnce(async () => null)                          // 兜底探测无档
      .mockResolvedValue({ data: { audioReady: false, task: null } })    // 轮询见任务行空
    await player.playSong(yt)
    await vi.waitFor(() => expect(player.playbackError.value).toMatch(/仍在进行/), { timeout: 8000 })
    expect(player.songSwitching.value).toBe(false)
    expect(howls).toHaveLength(0)
  })

  it('提交撞非 409（500）：穿透判失败终态，不进轮询', async () => {
    const yt = ytSong({ youtube: { videoId: 'abcdefghijk' } })
    const { player, deps } = makePlayer()
    deps.selectedPlaylist.value = localPl(yt)
    // 只吞 409：500 走 throw → 外层 catch 落失败文案，轮询段一行不跑
    downloadsApi.downloadSongToServer.mockRejectedValueOnce(
      { response: { status: 500, data: { message: 'x' } } })
    await player.playSong(yt)
    await vi.waitFor(() => expect(player.playbackError.value).toMatch(/音频加载失败/))
    expect(player.songSwitching.value).toBe(false)
    // 探测调用钉死在 2（主链 1 + 兜底 1）即证明没进轮询段——若 500 也被
    // 误吞，calls 会随轮询轮次继续涨
    expect(downloadsApi.getSongDownloadStatus).toHaveBeenCalledTimes(2)
    expect(howls).toHaveLength(0)
  })

  it('轮询连续 4 次探测失联：按停机收束 break，落「仍在进行」文案', async () => {
    const yt = ytSong({ youtube: { videoId: 'abcdefghijk' } })
    const { player, deps } = makePlayer()
    deps.selectedPlaylist.value = localPl(yt)
    // 409 进轮询 → 服务端随即停机：探测全灭（.catch → null 连攒）
    downloadsApi.downloadSongToServer.mockRejectedValueOnce(
      { response: { status: 409, data: { message: '该歌曲正在下载中' } } })
    downloadsApi.getSongDownloadStatus
      .mockImplementationOnce(async () => null)      // 主链探测无档
      .mockImplementationOnce(async () => null)      // 兜底探测无档
      .mockRejectedValue(new Error('server down'))   // 轮询段全灭
    await player.playSong(yt)
    // 4 轮 × 1500ms 真实时钟 ≈6s 收束——waitFor 窗放宽罩住
    await vi.waitFor(() => expect(player.playbackError.value).toMatch(/仍在进行/), { timeout: 12000 })
    expect(player.songSwitching.value).toBe(false)
    expect(howls).toHaveLength(0)
    // 主链+兜底 2 次探测 + 恰好 4 次失联轮询即 break——不撑满 3min deadline
    expect(downloadsApi.getSongDownloadStatus).toHaveBeenCalledTimes(6)
  })
})

describe('usePlayer：裸前缀 id（缺 provider 对象的老持久化行）', () => {
  // 'BV1xx411c7mD' 合 BV_TRACK_ID_RE 的 BV+10 位形态；'0034M8WL3V4oHC' 合
  // QQ_SONG_ID_RE 的 10-20 位 mid 形态——这些行的 id 形态就是全部凭据
  const localPl = (t) => ({ id: 'local_pl_1', name: 'P', tracks: [t], isLocal: true })

  it('bv_ 裸 id 按形态自解在线链：bvid/_pN 从 id 还原，不落 getSongUrl 死路', async () => {
    const bv = song('bv_BV1xx411c7mD_p3') // 无 bilibili 对象——bvid/分P 全在 id 里
    const { player } = makePlayer()
    await player.playSong(bv)
    expect(musicApi.getSongUrl).not.toHaveBeenCalled()
    // cid 缺省留给服务端 view 自愈；分P 序号从 _pN 段还原
    expect(musicApi.bilibiliStreamUrl).toHaveBeenCalledWith('BV1xx411c7mD', 'audio', undefined, 3)
    expect(howls[0].opts.src).toEqual(['https://x/bili'])
  })

  it('qq_ 裸 id 按形态自解在线链：mid 从 id 还原，mediaMid 缺省走服务端回填', async () => {
    const qq = song('qq_0034M8WL3V4oHC')
    const { player } = makePlayer()
    await player.playSong(qq)
    expect(musicApi.getSongUrl).not.toHaveBeenCalled()
    expect(musicApi.qqStreamUrl).toHaveBeenCalledWith('0034M8WL3V4oHC', '', undefined)
    expect(howls[0].opts.src).toEqual(['https://x/qq'])
  })

  it('bv_/yt_ 裸 id 无 neteaseId：歌词走 /lyric/external 外源兜底，不打网易云 /lyric', async () => {
    const { player, deps } = makePlayer()
    const bv = song('bv_BV1xx411c7mD')
    deps.selectedPlaylist.value = localPl(bv)
    await player.playSong(bv) // bv_ 在线链 + loadLyrics 外源兜底（mock 归 null=级联全灭）
    const yt = song('yt_abcdefghijk')
    deps.selectedPlaylist.value = localPl(yt)
    await player.playSong(yt) // yt_ 下载兜底链里 loadLyrics 同样走外源
    await vi.waitFor(() => expect(howls).toHaveLength(2))
    expect(musicApi.getLyrics).not.toHaveBeenCalled()
    const ids = musicApi.getExternalLyric.mock.calls.map(c => c[0].id)
    expect(ids).toEqual(expect.arrayContaining(['bv_BV1xx411c7mD', 'yt_abcdefghijk']))
    expect(player.lyrics.value).toEqual([])
  })

  it('bv_ 裸 id 有 neteaseId：照常嫁接网易云词源', async () => {
    const bv = song('bv_BV1xx411c7mD', { neteaseId: 777 })
    const { player } = makePlayer()
    await player.playSong(bv)
    expect(musicApi.getLyrics).toHaveBeenCalledWith(777, expect.anything())
  })

  it('qq_ 裸 id 词源走 /qq/lyric（mid 自解），不打网易云 /lyric', async () => {
    const qq = song('qq_0034M8WL3V4oHC')
    const { player } = makePlayer()
    await player.playSong(qq)
    expect(musicApi.getQQLyric).toHaveBeenCalledWith('0034M8WL3V4oHC', expect.anything())
    expect(musicApi.getLyrics).not.toHaveBeenCalled()
  })

  it('qq_ 裸 id 的 QQ 词源空且有 neteaseId：回落嫁接词', async () => {
    const qq = song('qq_0034M8WL3V4oHC', { neteaseId: 555 })
    const { player } = makePlayer()
    await player.playSong(qq)
    expect(musicApi.getQQLyric).toHaveBeenCalledWith('0034M8WL3V4oHC', expect.anything())
    expect(musicApi.getLyrics).toHaveBeenCalledWith(555, expect.anything())
  })

  it('bv_ 裸 id 在线链全灭：兜底资格按形态命中，转下载续播本地档', async () => {
    const bv = song('bv_BV1xx411c7mD')
    const { player, deps } = makePlayer()
    deps.selectedPlaylist.value = localPl(bv)
    await player.playSong(bv)
    expect(howls[0].opts.src).toEqual(['https://x/bili'])
    // 首败 → _streamRetried 重解同链再建一例；二败 → ownSource 判定含形态
    // 命中 → playDownloadedCopy 接管（提交下载→completed 短路→钉 _localFile）
    howls[0].fire('onloaderror', 0, 'MEDIA_ERR')
    await vi.waitFor(() => expect(howls).toHaveLength(2))
    howls[1].fire('onloaderror', 0, 'MEDIA_ERR')
    await vi.waitFor(() => expect(howls).toHaveLength(3))
    expect(musicApi.getSongUrl).not.toHaveBeenCalled()
    expect(downloadsApi.downloadSongToServer).toHaveBeenCalledWith(
      'local_pl_1', 'bv_BV1xx411c7mD', expect.objectContaining({ downloadVideo: false }))
    expect(howls[2].opts.src).toEqual(['http://api/dl/local_pl_1/bv_BV1xx411c7mD'])
  })
})

describe('usePlayer：队列与接续', () => {
  it('playSong 拍 filteredSongs 为播放快照；nextSong 按序接续', async () => {
    const list = [song(1), song(2), song(3)]
    const { player, deps } = makePlayer({ songs: list })
    await player.playSong(list[0])
    expect(player.playingSongs.value.map(s => s.id)).toEqual([1, 2, 3])

    // 浏览态换成别的列表——播放上下文不被劫持
    deps.filteredSongs.value = [song(99)]
    player.nextSong() // 同步包装：内部 playSong 不返 promise，等实例落册
    await vi.waitFor(() => expect(howls).toHaveLength(2))
    expect(player.currentSong.value.id).toBe(2)
  })

  it('queueRemove/queueMove：当前曲不可删，原序备份同步', async () => {
    const list = [song(1), song(2), song(3)]
    const { player } = makePlayer({ songs: list })
    await player.playSong(list[0])
    player.queueRemove(0) // 当前曲下标——拒绝
    expect(player.playingSongs.value).toHaveLength(3)
    player.queueRemove(2)
    expect(player.playingSongs.value.map(s => s.id)).toEqual([1, 2])
    player.queueMove({ from: 1, to: 0 })
    expect(player.playingSongs.value.map(s => s.id)).toEqual([2, 1])
  })
})

describe('usePlayer：持久化与恢复', () => {
  it('savePlayerStateToStorage 快照字段齐', async () => {
    const list = [song(1), song(2)]
    const { player, deps } = makePlayer({ songs: list })
    deps.selectedPlaylist.value = { id: 'pl_a', name: 'A' }
    await player.playSong(list[1])
    player.volume.value = 42
    player.savePlayerStateToStorage()
    const saved = JSON.parse(localStorage.getItem(LS_KEYS.PLAYER_STATE))
    expect(saved).toMatchObject({
      currentSongId: 2, volume: 42, playMode: 'list', shuffleOn: false,
    })
  })

  it('restorePlaybackState：按歌单+曲 id 恢复，seekTime 落到 Howl', async () => {
    const { player, deps } = makePlayer({ songs: [song(1), song(2)] })
    deps.userPlaylists.value = [{ id: 'pl_a', name: 'A' }]
    deps.filteredSongs.value = [song(1), song(2)]
    const saved = { playingPlaylistId: 'pl_a', selectedPlaylistId: 'pl_a', currentSongId: 2, currentTime: 33 }
    await player.restorePlaybackState(saved)
    expect(deps.selectPlaylist).toHaveBeenCalled()
    expect(howls).toHaveLength(1)
    howls[0].fire('onload')
    expect(howls[0].seek()).toBe(33)
    expect(player.currentTime.value).toBe(33)
    expect(player.isPlaying.value).toBe(false) // autoplay=false 恢复态不起播
  })

  it('restorePlaybackState：存档曲已不在歌单 → 放弃恢复', async () => {
    const { player } = makePlayer({ songs: [song(1)] })
    await player.restorePlaybackState({
      playingPlaylistId: 'pl_a', selectedPlaylistId: 'pl_a', currentSongId: 404,
    })
    expect(howls).toHaveLength(0)
  })
})

describe('usePlayer：外源歌词兜底与自动重匹配', () => {
  const bvSong = (extra) => song('bv_BV1xx411c7mD', {
    bilibili: { bvid: 'BV1xx411c7mD', title: '视频标题', author: 'UP主' },
    ...extra,
  })

  it('无 neteaseId：/lyric/external 命中 → 词落 lyrics、词属主键挂 extId', async () => {
    musicApi.getExternalLyric.mockResolvedValue({
      lrc: '[00:01.00]外源词', source: 'lrclib', extId: 'lrclib_42', synced: true,
    })
    parseLyrics.mockImplementation(() => [{ time: 1, text: '外源词' }])
    const { player } = makePlayer()
    await player.playSong(bvSong())
    expect(musicApi.getExternalLyric).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'bv_BV1xx411c7mD', title: '视频标题', artist: 'UP主', durationSec: 200,
      }), expect.anything())
    expect(player.lyrics.value).toEqual([{ time: 1, text: '外源词' }])
    // extId 即词属主键：校准 meta 与归属核验都拿它，不碰网易云 /lyric
    expect(downloadsApi.getSongMeta).toHaveBeenCalledWith('lrclib_42')
    await vi.waitFor(() =>
      expect(aiApi.verifyLyric).toHaveBeenCalledWith('lrclib_42', '视频标题', 'UP主', expect.anything()))
    expect(musicApi.getLyrics).not.toHaveBeenCalled()
  })

  it('无 neteaseId 且 synced=false：纯文本按行落静态词，不滚动（无有限时间戳）', async () => {
    musicApi.getExternalLyric.mockResolvedValue({
      lrc: '第一行词\n第二行词', source: 'lrclib', extId: 'lrclib_9', synced: false,
    })
    const { player } = makePlayer()
    await player.playSong(bvSong())
    expect(player.lyrics.value).toEqual([
      { time: Infinity, text: '第一行词' },
      { time: Infinity, text: '第二行词' },
    ])
    expect(player.currentLyricIndex.value).toBe(-1)
  })

  it('verify 判否 → /match/retry 命中换新 neteaseId 并重载词（excludeIds 含旧词源）', async () => {
    const bv = bvSong({ neteaseId: 111 })
    musicApi.getLyrics.mockResolvedValue({ lyrics: [{ time: 1, text: '错词' }] })
    aiApi.verifyLyric
      .mockResolvedValueOnce({ ok: false }) // 111 词源判否
      .mockResolvedValue({ ok: true })      // 222 新词源过审
    musicApi.retryMatch.mockResolvedValue({ id: 222, name: '对的歌', ar: [], al: {} })
    const { player, deps } = makePlayer()
    await player.playSong(bv)
    await vi.waitFor(() => expect(musicApi.retryMatch).toHaveBeenCalled())
    expect(musicApi.retryMatch.mock.calls[0][0]).toMatchObject({
      trackId: 'bv_BV1xx411c7mD', title: '视频标题', author: 'UP主',
      // provider 块无 artists 字段——发的是 [author, authorClean] 过滤产物
      artists: ['UP主'], durationSec: 200, excludeIds: [111],
    })
    await vi.waitFor(() => expect(bv.neteaseId).toBe(222))
    // 换绑结果显式落盘：savePlaylistsToStorage 是显式调用制，不写会丢
    expect(deps.savePlaylistsToStorage).toHaveBeenCalled()
    await vi.waitFor(() => expect(musicApi.getLyrics).toHaveBeenCalledWith(222, expect.anything()))
    await vi.waitFor(() => expect(player.lyrics.value.length).toBeGreaterThan(0))
    expect(toast).toHaveBeenCalledWith('词源已自动重匹配', 'success')
  })

  it('verify 判否但 /match/retry 未命中：维持藏词与提示，neteaseId 不动', async () => {
    const bv = bvSong({ neteaseId: 111 })
    musicApi.getLyrics.mockResolvedValue({ lyrics: [{ time: 1, text: '错词' }] })
    aiApi.verifyLyric.mockResolvedValue({ ok: false })
    musicApi.retryMatch.mockResolvedValue(null)
    const { player } = makePlayer()
    await player.playSong(bv)
    await vi.waitFor(() => expect(musicApi.retryMatch).toHaveBeenCalled())
    await new Promise(r => setTimeout(r, 0))
    expect(player.lyrics.value).toEqual([])
    expect(bv.neteaseId).toBe(111)
    expect(toast).toHaveBeenCalledWith('歌词与歌曲疑似不匹配，已隐藏', 'info')
    expect(toast).not.toHaveBeenCalledWith('词源已自动重匹配', 'success')
  })

  it('换绑后的新词源仍被判否：rematchTried 每曲限一次，不再发起重匹配', async () => {
    const bv = bvSong({ neteaseId: 111 })
    musicApi.getLyrics.mockResolvedValue({ lyrics: [{ time: 1, text: '错词' }] })
    aiApi.verifyLyric.mockResolvedValue({ ok: false }) // 两轮词源都判否
    musicApi.retryMatch.mockResolvedValue({ id: 222, name: '对的歌', ar: [], al: {} })
    const { player } = makePlayer()
    await player.playSong(bv)
    // 换绑 222 后新词源同样被 verify 否决——等它发生再断言无二次重试
    await vi.waitFor(() =>
      expect(aiApi.verifyLyric).toHaveBeenCalledWith(222, '视频标题', 'UP主', expect.anything()))
    await vi.waitFor(() => expect(player.lyrics.value).toEqual([]))
    await new Promise(r => setTimeout(r, 0))
    expect(musicApi.retryMatch).toHaveBeenCalledTimes(1)
    expect(bv.neteaseId).toBe(222) // 换绑结果仍写回曲对象（持久化随曲走）
  })

  it('行菜单换绑信号：正播同曲补写 neteaseId 并重载词，异曲信号被丢弃', async () => {
    const { notifyLyricRematch } = await import('../../src/composables/usePlayer.js')
    const bv = bvSong({ neteaseId: 111 })
    musicApi.getLyrics.mockResolvedValue({ lyrics: [{ time: 1, text: 'x' }] })
    const { player } = makePlayer()
    await player.playSong(bv)
    expect(musicApi.getLyrics).toHaveBeenCalledWith(111, expect.anything())
    musicApi.getLyrics.mockClear()
    notifyLyricRematch('yt_abcdefghijk', 999) // 非当前曲——信号被丢弃
    await new Promise(r => setTimeout(r, 0))
    expect(musicApi.getLyrics).not.toHaveBeenCalled()
    notifyLyricRematch('bv_BV1xx411c7mD', 333)
    await vi.waitFor(() => expect(musicApi.getLyrics).toHaveBeenCalledWith(333, null))
    expect(bv.neteaseId).toBe(333)
  })

  it('retryMatch RTT 期间切歌：写回+落盘照做，但不 toast 不重载词', async () => {
    const bv = bvSong({ neteaseId: 111 })
    musicApi.getLyrics.mockResolvedValue({ lyrics: [{ time: 1, text: '错词' }] })
    aiApi.verifyLyric.mockResolvedValue({ ok: false })
    let releaseMatch
    musicApi.retryMatch.mockImplementation(
      () => new Promise(r => { releaseMatch = () => r({ id: 222, name: '对的歌' }) }))
    const { player, deps } = makePlayer()
    await player.playSong(bv)
    await vi.waitFor(() => expect(musicApi.retryMatch).toHaveBeenCalled())
    // RTT 窗内切歌：signal 随之 abort，但 mock 仍按正常 resolve 走完回包路径
    await player.playSong(song(2))
    releaseMatch()
    await vi.waitFor(() => expect(bv.neteaseId).toBe(222))
    // 换绑是曲的持久属性——写回对象+显式落盘不因切歌跳过
    expect(deps.savePlaylistsToStorage).toHaveBeenCalled()
    // 但没人看的歌不刷词：无成功 toast、不为新词源重载
    expect(toast).not.toHaveBeenCalledWith('词源已自动重匹配', 'success')
    expect(musicApi.getLyrics).not.toHaveBeenCalledWith(222, expect.anything())
  })

  it('retryMatch 在途被 abort（ERR_CANCELED）：不烧 rematch 槽位，重播同曲可再试', async () => {
    const bv = bvSong({ neteaseId: 111 })
    musicApi.getLyrics.mockResolvedValue({ lyrics: [{ time: 1, text: '错词' }] })
    aiApi.verifyLyric.mockResolvedValue({ ok: false })
    // signal 随切歌/看门狗 abort 时 axios 的真实表现：reject CanceledError
    // （ERR_CANCELED）——生产上 postProcess 链路起跑晚于 playSong 收尾清
    // controller，abort 主要由加载看门狗的 myController.abort() 触发
    musicApi.retryMatch.mockRejectedValue(
      Object.assign(new Error('canceled'), { name: 'CanceledError', code: 'ERR_CANCELED' }))
    const { player } = makePlayer()
    await player.playSong(bv)
    await vi.waitFor(() => expect(musicApi.retryMatch).toHaveBeenCalledTimes(1))
    await new Promise(r => setTimeout(r, 0)) // 让 catch 的槽位释放跑完
    // 重播同曲：判否缓存即刻生效（不重发 verify），闸已释放 → 二次重试
    await player.playSong(bv)
    await vi.waitFor(() => expect(musicApi.retryMatch).toHaveBeenCalledTimes(2))
  })

  it('retryMatch 非 abort 失败（502 等）：槽位保留，同会话不再重试', async () => {
    const bv = bvSong({ neteaseId: 111 })
    musicApi.getLyrics.mockResolvedValue({ lyrics: [{ time: 1, text: '错词' }] })
    aiApi.verifyLyric.mockResolvedValue({ ok: false })
    // 服务端故障类错误：保留占位——否则每播一次同曲都刷一次 match-retry 限流桶
    musicApi.retryMatch.mockRejectedValue(
      Object.assign(new Error('重匹配失败'), { response: { status: 502 } }))
    const { player } = makePlayer()
    await player.playSong(bv)
    await vi.waitFor(() => expect(musicApi.retryMatch).toHaveBeenCalledTimes(1))
    await player.playSong(song(2))
    await player.playSong(bv)
    await new Promise(r => setTimeout(r, 0))
    expect(musicApi.retryMatch).toHaveBeenCalledTimes(1)
  })

  it('外源（extId）词判否：藏词但不发 retryMatch——判否对象不是 neteaseId', async () => {
    musicApi.getExternalLyric.mockResolvedValue({
      lrc: '[00:01.00]外源词', source: 'lrclib', extId: 'lrclib_9', synced: true,
    })
    parseLyrics.mockImplementation(() => [{ time: 1, text: '外源词' }])
    aiApi.verifyLyric.mockResolvedValue({ ok: false })
    const { player } = makePlayer()
    await player.playSong(bvSong()) // 无 neteaseId → 外源词路
    await vi.waitFor(() =>
      expect(aiApi.verifyLyric).toHaveBeenCalledWith('lrclib_9', '视频标题', 'UP主', expect.anything()))
    await vi.waitFor(() => expect(player.lyrics.value).toEqual([]))
    await new Promise(r => setTimeout(r, 0))
    expect(musicApi.retryMatch).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith('歌词与歌曲疑似不匹配，已隐藏', 'info')
  })

  it('notifyLyricRematch 在无正播曲（currentSong==null）时丢弃', async () => {
    const { notifyLyricRematch } = await import('../../src/composables/usePlayer.js')
    const { player } = makePlayer() // 实例化即注册槽位，但没播过任何曲
    expect(player.currentSong.value).toBeNull()
    notifyLyricRematch('bv_BV1xx411c7mD', 333)
    await new Promise(r => setTimeout(r, 0))
    expect(musicApi.getLyrics).not.toHaveBeenCalled()
    expect(player.currentSong.value).toBeNull()
  })
})

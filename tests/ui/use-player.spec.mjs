// usePlayer 状态机：Howl 全桩捕获回调，驱动 onload/onplay/onloaderror
// 断言——本地档优先 / 本地档坏转在线 / 竞态切歌 / 队列快照 / 持久化恢复。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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
    lyricAlign: vi.fn(async () => null),
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
// http.js 只被 usePlayer 的 apiErrorMessage 引用（music/downloads/ai 三只
// api 已全桩，拦截器/axios 实例不进用例图）
vi.mock('../../src/api/http.js', () => ({
  default: {},
  API_BASE_URL: 'http://api',
  apiErrorMessage: (e) => e?.response?.data?.message || e?.message,
}))
vi.mock('../../src/lib/feedback.js', () => ({ toast: vi.fn() }))
// theme.js 全替桩：usePlayer 消费 glitchBurst；lib/sync.js（usePlayer 引入）
// 还 import applyRemoteTheme——缺导出名会让整个 import 图链接失败
vi.mock('../../src/lib/theme.js', () => ({ glitchBurst: vi.fn(), applyRemoteTheme: vi.fn() }))
// 同步引擎的传输层桩——远端应用用例经真 pullFromServer 送达 player-state
vi.mock('../../src/api/sync.js', () => ({
  syncApi: { pull: vi.fn(), push: vi.fn() },
}))

import { musicApi, parseLyrics } from '../../src/api/music.js'
import { downloadsApi } from '../../src/api/downloads.js'
import { aiApi } from '../../src/api/ai.js'
import { syncApi } from '../../src/api/sync.js'
import { toast } from '../../src/lib/feedback.js'
import { usePlayer } from '../../src/composables/usePlayer.js'
import { initSync, pullFromServer, resetSyncState } from '../../src/lib/sync.js'
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
  resetSyncState() // 引擎模块级状态跨用例隔离（远端应用用例会 init）
  musicApi.getSongUrl.mockImplementation(async () => ({ url: 'https://cdn.example/online.mp3', br: 320000 }))
  musicApi.youtubeStreamUrl.mockImplementation(() => 'https://x/yt')
  downloadsApi.getSongDownloadStatus.mockImplementation(async () => null)
  // clearAllMocks 只清调用记录不清实现——逐用例覆写的 mock 全部归位
  parseLyrics.mockImplementation(() => [])
  downloadsApi.downloadSongToServer.mockImplementation(async () => ({ data: { status: 'completed' } }))
  downloadsApi.mirrorLocalPlaylist.mockImplementation(async () => ({}))
  musicApi.getLyrics.mockResolvedValue({ lyrics: [] })
  musicApi.getExternalLyric.mockResolvedValue(null)
  musicApi.lyricAlign.mockResolvedValue(null)
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

  it('yt 曲恢复在线链：直挂 /youtube/stream，本地档探测命中仍优先', async () => {
    // 在线位用回真形态 URL——断言 URL 含 /youtube/stream 而非桩串
    musicApi.youtubeStreamUrl.mockImplementation(
      (v, kind) => `http://api/youtube/stream?v=${v}&kind=${kind}`)
    const yt = song('yt_abcdefghijk', { youtube: { videoId: 'abcdefghijk', hasVideo: true } })
    const { player, deps } = makePlayer()
    deps.selectedPlaylist.value = { id: 'local_pl_1', name: 'P', tracks: [yt], isLocal: true }
    await player.playSong(yt)
    expect(musicApi.getSongUrl).not.toHaveBeenCalled()
    expect(musicApi.youtubeStreamUrl).toHaveBeenCalledWith('abcdefghijk', 'audio', '', 0)
    expect(howls).toHaveLength(1)
    expect(howls[0].opts.src[0]).toContain('/youtube/stream')

    // audioReady 探测命中时本地档仍优先——在线链一次都不打
    downloadsApi.getSongDownloadStatus.mockResolvedValue({
      data: { audioReady: true, audioPlaylistId: 7 },
    })
    await player.playSong(yt)
    expect(musicApi.youtubeStreamUrl).toHaveBeenCalledTimes(1)
    expect(howls).toHaveLength(2)
    expect(howls[1].opts.src).toEqual(['http://api/dl/7/yt_abcdefghijk'])
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

describe('usePlayer：YT 在线链与下载兜底', () => {
  // 'abcdefghijk' 是合法 11 位 videoId 形态，yt_ 前缀走 YT_TRACK_ID_RE 判定
  const ytSong = (extra) => song('yt_abcdefghijk', extra)
  const localPl = (t) => ({ id: 'local_pl_1', name: 'P', tracks: [t], isLocal: true })

  // yt 在线位两级败亡驱动：当前末例首败 → _streamRetried 重解（retry=1）
  // 再建一例，再败 → ownSource 闸落 playDownloadedCopy 兜底链
  const driveToDownloadFallback = async () => {
    const len = howls.length
    howls.at(-1).fire('onloaderror', 0, 'MEDIA_ERR')
    await vi.waitFor(() => expect(howls.length).toBeGreaterThan(len))
    howls.at(-1).fire('onloaderror', 0, 'MEDIA_ERR')
  }

  it('yt_ 裸 id（缺 provider 对象老行）按形态自解在线链，不落 getSongUrl 死路', async () => {
    const yt = ytSong() // 无 youtube 对象——videoId 从 id 还原
    const { player, deps } = makePlayer()
    deps.selectedPlaylist.value = localPl(yt)
    await player.playSong(yt)
    expect(musicApi.getSongUrl).not.toHaveBeenCalled()
    expect(musicApi.youtubeStreamUrl).toHaveBeenCalledWith('abcdefghijk', 'audio', '', 0)
    expect(howls[0].opts.src).toEqual(['https://x/yt'])
  })

  it('在线两级败亡回落下载兜底：retry=1 重解→提交→completed 短路钉 _localFile', async () => {
    const yt = ytSong({ youtube: { videoId: 'abcdefghijk', hasVideo: true } })
    const { player, deps } = makePlayer()
    deps.selectedPlaylist.value = localPl(yt)
    await player.playSong(yt)
    expect(howls[0].opts.src).toEqual(['https://x/yt'])
    await driveToDownloadFallback()
    // 重解代带 retry=1 旁路服务端 gateCache 判定缓存
    expect(musicApi.youtubeStreamUrl).toHaveBeenLastCalledWith('abcdefghijk', 'audio', '', 1)
    await vi.waitFor(() => expect(howls).toHaveLength(3))
    // hasVideo 的 yt 曲提交下载连视频档一起下（WatchView 本地视频档的来源）
    expect(downloadsApi.downloadSongToServer).toHaveBeenCalledWith(
      'local_pl_1', 'yt_abcdefghijk', expect.objectContaining({ downloadVideo: true }))
    expect(howls[2].opts.src).toEqual(['http://api/dl/local_pl_1/yt_abcdefghijk'])
  })

  it('yt 曲仅 hasDownloadableVideo（vp9/av01 独占稿）也带视频相位', async () => {
    const yt = ytSong({ youtube: { videoId: 'abcdefghijk', hasVideo: false, hasDownloadableVideo: true } })
    const { player, deps } = makePlayer()
    deps.selectedPlaylist.value = localPl(yt)
    await player.playSong(yt)
    await driveToDownloadFallback()
    await vi.waitFor(() => expect(downloadsApi.downloadSongToServer).toHaveBeenCalled())
    expect(downloadsApi.downloadSongToServer).toHaveBeenCalledWith(
      'local_pl_1', 'yt_abcdefghijk', expect.objectContaining({ downloadVideo: true }))
  })

  it('mirror RTT 窗内切歌：旧代压死，不替没人等的歌提交孤儿任务', async () => {
    const yt = ytSong({ youtube: { videoId: 'abcdefghijk' } })
    const { player, deps } = makePlayer()
    deps.selectedPlaylist.value = localPl(yt)
    await player.playSong(yt)
    let releaseMirror
    downloadsApi.mirrorLocalPlaylist.mockImplementationOnce(
      () => new Promise(r => { releaseMirror = () => r({}) }))
    await driveToDownloadFallback()
    // 旧代兜底链停在 mirrorLocalPlaylist 的 await 上
    await vi.waitFor(() => expect(downloadsApi.mirrorLocalPlaylist).toHaveBeenCalled())
    const p2 = player.playSong(song(2)) // 切歌落在镜像在途窗内
    releaseMirror()
    await p2
    await new Promise(r => setTimeout(r, 0)) // 让旧代 mirror 回落跑完代次闸
    expect(downloadsApi.downloadSongToServer).not.toHaveBeenCalled()
    expect(howls.at(-1).opts.src).toEqual(['https://cdn.example/online.mp3']) // 新歌在线链照常建实例
  })

  it('无歌单上下文探测又无档：在线败亡后兜底链形态闸直落失败终态', async () => {
    const yt = ytSong({ youtube: { videoId: 'abcdefghijk' } })
    const { player } = makePlayer() // playingPlaylistId/selectedPlaylist 皆空 → playlistId=undefined
    await player.playSong(yt)
    await driveToDownloadFallback()
    await vi.waitFor(() => expect(player.playbackError.value).toMatch(/音频加载失败/))
    expect(downloadsApi.mirrorLocalPlaylist).not.toHaveBeenCalled()
    expect(downloadsApi.downloadSongToServer).not.toHaveBeenCalled()
    expect(player.songSwitching.value).toBe(false)
    expect(howls).toHaveLength(2) // 在线两例（首试+retry）——兜底链未建实例
  })

  it('single_song_ 壳不可镜像：同跳提交直落失败终态', async () => {
    const yt = ytSong({ youtube: { videoId: 'abcdefghijk' } })
    const { player, deps } = makePlayer()
    deps.selectedPlaylist.value = { id: 'single_song_9', name: 'S', tracks: [yt] }
    await player.playSong(yt)
    await driveToDownloadFallback()
    await vi.waitFor(() => expect(player.playbackError.value).toMatch(/音频加载失败/))
    expect(downloadsApi.mirrorLocalPlaylist).not.toHaveBeenCalled()
    expect(downloadsApi.downloadSongToServer).not.toHaveBeenCalled()
  })

  it('无歌单上下文但探测命中别单档：跨歌单寻址仍可直播', async () => {
    const yt = ytSong({ youtube: { videoId: 'abcdefghijk' } })
    const { player } = makePlayer()
    downloadsApi.getSongDownloadStatus
      .mockImplementationOnce(async () => null)                            // 主链探测无档
      .mockResolvedValue({ data: { audioReady: true, audioPlaylistId: 7 } }) // 重解代探测命中别单
    await player.playSong(yt)
    await vi.waitFor(() => expect(howls).toHaveLength(1))
    expect(howls[0].opts.src).toEqual(['https://x/yt']) // 首挂在线链
    // 在线首败 → 重解代再探即命中别单档——不等下载链，直接换播本地档
    howls[0].fire('onloaderror', 0, 'MEDIA_ERR')
    await vi.waitFor(() => expect(howls).toHaveLength(2))
    expect(downloadsApi.downloadSongToServer).not.toHaveBeenCalled()
    expect(howls[1].opts.src).toEqual(['http://api/dl/7/yt_abcdefghijk'])
  })

  it('同曲连点：旧代兜底链被代次闸压死，不重复提交', async () => {
    const yt = ytSong({ youtube: { videoId: 'abcdefghijk' } })
    const { player, deps } = makePlayer()
    deps.selectedPlaylist.value = localPl(yt)
    let releaseStale
    downloadsApi.getSongDownloadStatus
      .mockImplementationOnce(async () => null)                                         // 一代主链探测
      .mockImplementationOnce(() => new Promise(r => { releaseStale = () => r(null) })) // 一代重解探测挂起
      .mockImplementation(async () => null)                                             // 其余一律无档
    const p1 = player.playSong(yt)
    await vi.waitFor(() => expect(howls).toHaveLength(1))
    howls[0].fire('onloaderror', 0, 'MEDIA_ERR') // → 二代重解代，探测挂起
    await vi.waitFor(() => expect(downloadsApi.getSongDownloadStatus).toHaveBeenCalledTimes(2))
    const p2 = player.playSong(yt) // 同 id 重进三代——controller 换代压死二代
    await Promise.all([p1, p2])
    // 三代在线链两级败亡进兜底：completed 短路 → 递归钉 _localFile 建实例
    await driveToDownloadFallback()
    await vi.waitFor(() =>
      expect(howls.at(-1).opts.src).toEqual(['http://api/dl/local_pl_1/yt_abcdefghijk']))
    releaseStale() // 二代探测落地时世界已属三代——abortSignal 已废，不再建实例
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
      .mockImplementationOnce(async () => null)                                    // 重解代探测无档
      .mockImplementationOnce(async () => null)                                    // 兜底探测无档
      .mockImplementationOnce(async () => ({ data: { audioReady: false, task: { status: 'downloading' } } })) // 轮询1：仍在下
      .mockResolvedValue({ data: { audioReady: true, audioPlaylistId: 'local_pl_1' } })                      // 轮询2：档落
    await player.playSong(yt)
    await driveToDownloadFallback()
    // 轮询档 1500ms/轮是真实时钟——waitFor 窗放宽罩住两轮
    await vi.waitFor(() => expect(howls).toHaveLength(3), { timeout: 8000 })
    expect(player.playbackError.value).toBe('')
    expect(howls[2].opts.src).toEqual(['http://api/dl/local_pl_1/yt_abcdefghijk'])
    howls[2].fire('onload') // 切歌锁在 onload 才松——换链全程不弹失败文案
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
      .mockImplementationOnce(async () => null)                          // 重解代探测无档
      .mockImplementationOnce(async () => null)                          // 兜底探测无档
      .mockResolvedValue({ data: { audioReady: false, task: null } })    // 轮询见任务行空
    await player.playSong(yt)
    await driveToDownloadFallback()
    await vi.waitFor(() => expect(player.playbackError.value).toMatch(/仍在进行/), { timeout: 8000 })
    expect(player.songSwitching.value).toBe(false)
    expect(howls).toHaveLength(2) // 在线两例——兜底链未建实例
  })

  it('提交撞非 409（500）：穿透判失败终态，不进轮询', async () => {
    const yt = ytSong({ youtube: { videoId: 'abcdefghijk' } })
    const { player, deps } = makePlayer()
    deps.selectedPlaylist.value = localPl(yt)
    // 只吞 409：500 走 throw → 外层 catch 落失败文案，轮询段一行不跑
    downloadsApi.downloadSongToServer.mockRejectedValueOnce(
      { response: { status: 500, data: { message: 'x' } } })
    await player.playSong(yt)
    await driveToDownloadFallback()
    await vi.waitFor(() => expect(player.playbackError.value).toMatch(/音频加载失败/))
    expect(player.songSwitching.value).toBe(false)
    // 探测调用钉死在 3（主链+重解代+兜底各 1）即证明没进轮询段——若 500
    // 也被误吞，calls 会随轮询轮次继续涨
    expect(downloadsApi.getSongDownloadStatus).toHaveBeenCalledTimes(3)
    expect(howls).toHaveLength(2)
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
      .mockImplementationOnce(async () => null)      // 重解代探测无档
      .mockImplementationOnce(async () => null)      // 兜底探测无档
      .mockRejectedValue(new Error('server down'))   // 轮询段全灭
    await player.playSong(yt)
    await driveToDownloadFallback()
    // 4 轮 × 1500ms 真实时钟 ≈6s 收束——waitFor 窗放宽罩住
    await vi.waitFor(() => expect(player.playbackError.value).toMatch(/仍在进行/), { timeout: 12000 })
    expect(player.songSwitching.value).toBe(false)
    expect(howls).toHaveLength(2)
    // 主链+重解+兜底 3 次探测 + 恰好 4 次失联轮询即 break——不撑满 3min deadline
    expect(downloadsApi.getSongDownloadStatus).toHaveBeenCalledTimes(7)
  })

  // 成员预检同 downloadCurrentSong：队列插入曲不落归属单 tracks，拿归属单
  // 提交必 404——兜底链先扫全库找含该曲的可提交单顶替寻址
  const driveQueueInsertedFallback = async (fallbackPl) => {
    const yt = ytSong({ youtube: { videoId: 'abcdefghijk' } })
    const a = song(1)
    const plA = { id: 'local_pl_a', name: 'A', tracks: [a], isLocal: true }
    const { player, deps } = makePlayer({ songs: [a] })
    deps.userPlaylists.value = fallbackPl ? [plA, fallbackPl] : [plA]
    deps.selectedPlaylist.value = plA
    await player.playSong(a)       // playingPlaylistId=local_pl_a
    player.playNextInQueue(yt)     // yt 只进 playingSongs 不落户 local_pl_a
    const howlCount = howls.length
    player.queueJump(1)            // preserveContext 跳播——归属仍 local_pl_a
    // currentSong 先于 Howl 构造落地——等实例落册才算 yt 代起播完成
    await vi.waitFor(() => expect(howls.length).toBeGreaterThan(howlCount))
    await driveToDownloadFallback()
    return { player, plA }
  }

  it('队列插入曲不在归属单：兜底链扫到别单顶替寻址提交', async () => {
    const plB = { id: 'local_pl_b', name: 'B', tracks: [ytSong()] , isLocal: true }
    const { player } = await driveQueueInsertedFallback(plB)
    await vi.waitFor(() => expect(downloadsApi.downloadSongToServer).toHaveBeenCalled())
    // 顶替寻址：镜像/提交都走含该曲的 local_pl_b 而非归属单 local_pl_a
    expect(downloadsApi.mirrorLocalPlaylist).toHaveBeenCalledWith(plB)
    expect(downloadsApi.downloadSongToServer).toHaveBeenCalledWith(
      'local_pl_b', 'yt_abcdefghijk', expect.anything())
    await vi.waitFor(() =>
      expect(howls.at(-1).opts.src).toEqual(['http://api/dl/local_pl_b/yt_abcdefghijk']))
    expect(player.playbackError.value).toBe('')
  })

  it('队列插入曲无任何可解归属：兜底链直落失败终态不白跑', async () => {
    const { player } = await driveQueueInsertedFallback(null)
    await vi.waitFor(() => expect(player.playbackError.value).toMatch(/音频加载失败/))
    expect(downloadsApi.mirrorLocalPlaylist).not.toHaveBeenCalled()
    expect(downloadsApi.downloadSongToServer).not.toHaveBeenCalled()
    expect(player.songSwitching.value).toBe(false)
    // 全册 3 例 = a 起播 + yt 在线两例（首试+retry）——兜底链未建实例
    expect(howls).toHaveLength(3)
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
    await player.playSong(yt) // yt_ 在线链里 loadLyrics 同样走外源
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

  it('换绑命中走 applyMatchResult：al 按艺人重合闸重建（不只换 neteaseId）', async () => {
    const bv = bvSong({ neteaseId: 111 })
    bv.al = { id: 99, name: '错配残留专辑', picUrl: 'http://n/dirty.jpg' }
    musicApi.getLyrics.mockResolvedValue({ lyrics: [{ time: 1, text: '错词' }] })
    aiApi.verifyLyric
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValue({ ok: true })
    // 艺人重合（bilibili.author='UP主' ∈ matched.ar）→ 新匹配专辑被采纳，
    // 脏 al 连根修而非只换个词源 id
    musicApi.retryMatch.mockResolvedValue({
      id: 222, name: '对的歌', ar: [{ name: 'UP主' }],
      al: { id: 9, name: '对的专辑', picUrl: 'http://n/9.jpg' },
    })
    const { player } = makePlayer()
    await player.playSong(bv)
    await vi.waitFor(() => expect(bv.neteaseId).toBe(222))
    expect(bv.name).toBe('对的歌')
    expect(bv.al.name).toBe('对的专辑')
    expect(bv.al.id).toBe(9)
    // bv.cover 未持久化（bvSong 没给）→ provider 封面空，重合兜底吃匹配封面
    expect(bv.al.picUrl).toBe('http://n/9.jpg')
    expect(player.lyrics.value.length).toBeGreaterThan(0)
  })

  it('行菜单解绑信号（neteaseId=null）：清绑+落盘+热重载走外源词路', async () => {
    const { notifyLyricRematch } = await import('../../src/composables/usePlayer.js')
    const bv = bvSong({ neteaseId: 111 })
    musicApi.getLyrics.mockResolvedValue({ lyrics: [{ time: 1, text: 'x' }] })
    const { player, deps } = makePlayer()
    await player.playSong(bv)
    expect(musicApi.getLyrics).toHaveBeenCalledWith(111, expect.anything())
    musicApi.getLyrics.mockClear()
    deps.savePlaylistsToStorage.mockClear()
    notifyLyricRematch('bv_BV1xx411c7mD', null)
    // 解绑后热重载走 /lyric/external 外源兜底，不再打网易云 /lyric
    await vi.waitFor(() => expect(musicApi.getExternalLyric).toHaveBeenCalled())
    expect(bv.neteaseId).toBeNull()
    expect(deps.savePlaylistsToStorage).toHaveBeenCalled()
    expect(musicApi.getLyrics).not.toHaveBeenCalled()
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

  it('外源（extId）词判否且曲未绑定：藏词 + 接首配兜底（extId 不进 excludeIds）', async () => {
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
    expect(toast).toHaveBeenCalledWith('歌词与歌曲疑似不匹配，已隐藏', 'info')
    // 判否对象是外源词源（lrclib_9 非 neteaseId）——不走换绑否决记账，
    // 但词已藏、曲仍裸着：rematchUnbound 首配兜底接管把歌接上匹配链
    await vi.waitFor(() => expect(musicApi.retryMatch).toHaveBeenCalledTimes(1))
    const payload = musicApi.retryMatch.mock.calls[0][0]
    expect(payload).toMatchObject({ trackId: 'bv_BV1xx411c7mD', title: '视频标题', author: 'UP主' })
    expect(payload.excludeIds ?? []).not.toContain('lrclib_9')
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

  // ── rematchUnbound：外源词全灭后的未绑定曲自动首配 ──
  // yt_/bv_ 未绑 neteaseId 且外源词落空（级联全灭/hit=null/行集剥空）时
  // 自动重跑一次 /match/retry——VOCALOID 翻唱等曲外源三源缺收录而网易本体常有
  const ytUnbound = (extra) => song('yt_abcdefghijk', {
    youtube: {
      videoId: 'abcdefghijk', title: 'sasayakuを歌いました',
      author: 'rei sirose - Topic', authorClean: 'rei sirose', hasVideo: true,
    },
    ...extra,
  })

  it('外源全灭（hit=null）+ 未绑定 yt_ 曲：自动首配一次，材料取 provider 块', async () => {
    musicApi.retryMatch.mockResolvedValue(null) // 服务端也没配到——不留痕
    const yt = ytUnbound()
    const { player } = makePlayer()
    await player.playSong(yt)
    await vi.waitFor(() => expect(musicApi.retryMatch).toHaveBeenCalledTimes(1))
    const payload = musicApi.retryMatch.mock.calls[0][0]
    expect(payload).toMatchObject({
      trackId: 'yt_abcdefghijk',
      title: 'sasayakuを歌いました',
      author: 'rei sirose - Topic',
      // provider 块无 artists 字段——发的是 [author, authorClean] 过滤产物
      artists: ['rei sirose - Topic', 'rei sirose'],
      durationSec: 200,
    })
    // 首配语义：无否决对象不发 excludeIds
    expect(payload).not.toHaveProperty('excludeIds')
    // matched=null 不留痕——无匹配仍是事实，曲对象一个字不写
    await new Promise(r => setTimeout(r, 0))
    expect(yt.neteaseId).toBeUndefined()
    expect(musicApi.getLyrics).not.toHaveBeenCalled()
    expect(player.lyrics.value).toEqual([])
  })

  it('首配命中：applyMatchResult 重建 neteaseId/name，热重载走常规网易词支', async () => {
    musicApi.retryMatch.mockResolvedValue({
      id: 1316563227, name: 'sasayaku', matchedBy: 'title+artist', score: 0.98,
      ar: [{ name: 'rei sirose' }],
      al: { id: 9, name: '对的专辑', picUrl: 'http://n/9.jpg' },
    })
    musicApi.getLyrics.mockResolvedValue({ lyrics: [{ time: 1, text: '网易词' }] })
    const yt = ytUnbound()
    const { player, deps } = makePlayer()
    await player.playSong(yt)
    await vi.waitFor(() => expect(yt.neteaseId).toBe(1316563227))
    // 修复器整组重建：name 吃匹配名、证据随绑定落 provider 块
    expect(yt.name).toBe('sasayaku')
    expect(yt.youtube.matchedBy).toBe('title+artist')
    expect(yt.youtube.matchScore).toBe(0.98)
    expect(deps.savePlaylistsToStorage).toHaveBeenCalled()
    // 热重载：neteaseId 已写 → 常规网易词支，不重打外源；人还在看这首
    // → 补 toast（与判否换绑同文案）
    await vi.waitFor(() =>
      expect(musicApi.getLyrics).toHaveBeenCalledWith(1316563227, expect.anything()))
    await vi.waitFor(() =>
      expect(player.lyrics.value).toEqual([{ time: 1, text: '网易词' }]))
    expect(toast).toHaveBeenCalledWith('词源已自动重匹配', 'success')
    expect(musicApi.getExternalLyric).toHaveBeenCalledTimes(1)
  })

  it('首配 RTT 期间切歌：写回+落盘照做（持久属性），但不重载词', async () => {
    const yt = ytUnbound()
    let releaseMatch
    musicApi.retryMatch.mockImplementation(
      () => new Promise(r => { releaseMatch = () => r({ id: 1316563227, name: 'sasayaku' }) }))
    const { player, deps } = makePlayer()
    await player.playSong(yt)
    await vi.waitFor(() => expect(musicApi.retryMatch).toHaveBeenCalled())
    // RTT 窗内切走：signal 随之 abort，但 mock 仍按正常 resolve 走完回包路径
    await player.playSong(song(2))
    releaseMatch()
    // 绑定是曲的持久属性——写回对象+显式落盘不因切歌丢弃
    // （旧口径 stale 弃写会让已记账的本曲拖到下次会话才愈）
    await vi.waitFor(() => expect(yt.neteaseId).toBe(1316563227))
    expect(deps.savePlaylistsToStorage).toHaveBeenCalled()
    // stale 只闸歌词重载与 toast——没人看的歌不刷词不弹提示
    expect(musicApi.getLyrics).not.toHaveBeenCalledWith(1316563227, expect.anything())
    expect(toast).not.toHaveBeenCalledWith('词源已自动重匹配', 'success')
  })

  it('外源已命中（lyrics 非空）：不触发自动首配', async () => {
    musicApi.getExternalLyric.mockResolvedValue({
      lrc: '[00:01.00]外源词', source: 'lrclib', extId: 'lrclib_42', synced: true,
    })
    parseLyrics.mockImplementation(() => [{ time: 1, text: '外源词' }])
    const { player } = makePlayer()
    await player.playSong(bvSong())
    await vi.waitFor(() => expect(player.lyrics.value.length).toBeGreaterThan(0))
    await new Promise(r => setTimeout(r, 0))
    expect(musicApi.retryMatch).not.toHaveBeenCalled()
  })

  it('已绑定曲（neteaseId 在）且网易词源有词：走常规网易词支，不触发', async () => {
    const yt = ytUnbound({ neteaseId: 777 })
    // 词源非空——不进绑后词空的外源兜底支（该支自有用例覆盖）
    musicApi.getLyrics.mockResolvedValue({ lyrics: [{ time: 1, text: '网易词' }] })
    const { player } = makePlayer()
    await player.playSong(yt)
    await vi.waitFor(() => expect(musicApi.getLyrics).toHaveBeenCalledWith(777, expect.anything()))
    await vi.waitFor(() => expect(player.lyrics.value).toEqual([{ time: 1, text: '网易词' }]))
    expect(musicApi.getExternalLyric).not.toHaveBeenCalled()
    expect(musicApi.retryMatch).not.toHaveBeenCalled()
  })

  it('每曲每会话限一次：同曲重播外源照打但 retryMatch 不再发', async () => {
    const yt = ytUnbound()
    const { player } = makePlayer()
    await player.playSong(yt)
    await vi.waitFor(() => expect(musicApi.retryMatch).toHaveBeenCalledTimes(1))
    await player.playSong(song(2))
    await player.playSong(yt) // 槽位已消费——外源兜底照走，首配不重试
    await vi.waitFor(() => expect(musicApi.getExternalLyric).toHaveBeenCalledTimes(2))
    await new Promise(r => setTimeout(r, 0))
    expect(musicApi.retryMatch).toHaveBeenCalledTimes(1)
    expect(yt.neteaseId).toBeUndefined()
  })

  it('裸 yt_ id（缺 provider 对象的老行）：形态闸同走首配，材料回退 song.name', async () => {
    const yt = song('yt_abcdefghijk') // 无 youtube 对象——闸按 id 前缀命中
    const { player } = makePlayer()
    await player.playSong(yt)
    await vi.waitFor(() => expect(musicApi.retryMatch).toHaveBeenCalledTimes(1))
    const payload = musicApi.retryMatch.mock.calls[0][0]
    expect(payload).toMatchObject({
      trackId: 'yt_abcdefghijk', title: '歌yt_abcdefghijk',
      author: '', artists: [], durationSec: 200,
    })
    expect(payload).not.toHaveProperty('excludeIds')
  })

  it('非外链曲（网易云原生 id）：形闸拦在门外，不触发', async () => {
    const { player } = makePlayer()
    await player.playSong(song(7)) // getLyrics 空词终态——但不是外链曲：
    // 数字纯曲库 id 既不回首配，也不进绑后词空的外源宽检兜底（负向闸）
    await vi.waitFor(() => expect(musicApi.getLyrics).toHaveBeenCalledWith(7, expect.anything()))
    await new Promise(r => setTimeout(r, 0))
    expect(musicApi.getExternalLyric).not.toHaveBeenCalled()
    expect(musicApi.retryMatch).not.toHaveBeenCalled()
  })

  // ── matchVetoedIds 否决簿（B1）：菜单解绑/换绑否掉的旧词源 id 随
  // notifyLyricRematch 第三参记账，rematchUnbound 首配兜底并入
  // excludeIds——否则服务端 skipCache 重跑把刚否决的确定性高分原样
  // 送回，用户纠正被反噬 ──
  it('显式解绑后外源落空：retryMatch 的 excludeIds 含被否决 id', async () => {
    const { notifyLyricRematch } = await import('../../src/composables/usePlayer.js')
    const bv = bvSong({ neteaseId: 111 })
    musicApi.getLyrics.mockResolvedValue({ lyrics: [{ time: 1, text: 'x' }] })
    const { player } = makePlayer()
    await player.playSong(bv)
    await vi.waitFor(() => expect(musicApi.getLyrics).toHaveBeenCalledWith(111, expect.anything()))
    // 菜单「重新匹配歌词」空回包 → 解绑：prevId 作 vetoedId 捎进通知
    notifyLyricRematch('bv_BV1xx411c7mD', null, 111)
    // 清绑后热重载走外源路 → 全灭触发 rematchUnbound——刚否决的 111
    // 必须并进 excludeIds，否则确定性高分原样复活
    await vi.waitFor(() => expect(musicApi.retryMatch).toHaveBeenCalledTimes(1))
    expect(musicApi.retryMatch.mock.calls[0][0].excludeIds).toEqual([111])
    expect(bv.neteaseId).toBeNull()
  })

  it('换绑路捎旧 id 同记否：111→333 换绑再解绑，excludeIds 两否决俱在', async () => {
    const { notifyLyricRematch } = await import('../../src/composables/usePlayer.js')
    const bv = bvSong({ neteaseId: 111 })
    musicApi.getLyrics.mockResolvedValue({ lyrics: [{ time: 1, text: 'x' }] })
    const { player } = makePlayer()
    await player.playSong(bv)
    await vi.waitFor(() => expect(musicApi.getLyrics).toHaveBeenCalledWith(111, expect.anything()))
    // 换绑 111→333：用户选了新词源即对旧源的否决——111 记进否决簿
    notifyLyricRematch('bv_BV1xx411c7mD', 333, 111)
    await vi.waitFor(() => expect(musicApi.getLyrics).toHaveBeenCalledWith(333, null))
    // 再解绑 333 → 外源空 → rematchUnbound：两次否决都进 excludeIds
    notifyLyricRematch('bv_BV1xx411c7mD', null, 333)
    await vi.waitFor(() => expect(musicApi.retryMatch).toHaveBeenCalledTimes(1))
    const ids = musicApi.retryMatch.mock.calls[0][0].excludeIds
    expect(ids).toHaveLength(2)
    expect(ids).toEqual(expect.arrayContaining([111, 333]))
  })

  it('非正播曲的否决也记账：留给它下次播放时的首配兜底消费', async () => {
    const { notifyLyricRematch } = await import('../../src/composables/usePlayer.js')
    const bv = bvSong() // 菜单侧已 applyMatchResult(song,null) 解绑——曲对象 neteaseId 空
    const { player } = makePlayer()
    await player.playSong(song(2)) // 正播的是别的曲
    // 对非正播曲的解绑通知：只记否决簿（neteaseId 写回被异曲闸丢弃）
    notifyLyricRematch('bv_BV1xx411c7mD', null, 111)
    await player.playSong(bv) // 轮到它开播：外源空 → 首配兜底捎上早前否决
    await vi.waitFor(() => expect(musicApi.retryMatch).toHaveBeenCalledTimes(1))
    expect(musicApi.retryMatch.mock.calls[0][0].excludeIds).toEqual([111])
  })

  it('hit 非空但行集剥空（lrc 全是元行）：同算词全灭，触发 rematchUnbound', async () => {
    musicApi.getExternalLyric.mockResolvedValue({
      lrc: '[ti:歌名]\n[ar:某人]\n[offset:0]', source: 'lrclib', extId: 'lrclib_7', synced: false,
    })
    const yt = ytUnbound()
    const { player } = makePlayer()
    await player.playSong(yt)
    // plain 兜底剥行首时间戳+滤元行后一行不剩——与 hit=null 同终态
    await vi.waitFor(() => expect(musicApi.retryMatch).toHaveBeenCalledTimes(1))
    const payload = musicApi.retryMatch.mock.calls[0][0]
    expect(payload.trackId).toBe('yt_abcdefghijk')
    expect(payload).not.toHaveProperty('excludeIds') // 无否决账不捎字段
    await new Promise(r => setTimeout(r, 0))
    expect(player.lyrics.value).toEqual([])
    expect(yt.neteaseId).toBeUndefined()
  })

  it('首配在途被 abort（ERR_CANCELED）：释放槽位，重播同曲可再试', async () => {
    const yt = ytUnbound()
    musicApi.retryMatch.mockRejectedValue(
      Object.assign(new Error('canceled'), { name: 'CanceledError', code: 'ERR_CANCELED' }))
    const { player } = makePlayer()
    await player.playSong(yt)
    await vi.waitFor(() => expect(musicApi.retryMatch).toHaveBeenCalledTimes(1))
    await new Promise(r => setTimeout(r, 0)) // 让 catch 的槽位释放跑完
    await player.playSong(song(2))
    await player.playSong(yt) // 槽位已释放——重播再试一次
    await vi.waitFor(() => expect(musicApi.retryMatch).toHaveBeenCalledTimes(2))
  })

  it('首配撞 429 限流：同 abort 列释放槽位——「稍后再试」不该烧掉自愈机会', async () => {
    const yt = ytUnbound()
    musicApi.retryMatch
      .mockRejectedValueOnce({ response: { status: 429 } })
      .mockResolvedValue({ id: 1316563227, name: 'sasayaku' })
    musicApi.getLyrics.mockResolvedValue({ lyrics: [{ time: 1, text: '网易词' }] })
    const { player } = makePlayer()
    await player.playSong(yt)
    await vi.waitFor(() => expect(musicApi.retryMatch).toHaveBeenCalledTimes(1))
    await new Promise(r => setTimeout(r, 0))
    await player.playSong(song(2))
    await player.playSong(yt) // 槽位已释放——重播重试命中即自愈
    await vi.waitFor(() => expect(musicApi.retryMatch).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(yt.neteaseId).toBe(1316563227))
  })

  it('首配非 abort/限流失败（502 等）：槽位保留，同会话不再重试', async () => {
    const yt = ytUnbound()
    musicApi.retryMatch.mockRejectedValue(
      Object.assign(new Error('重匹配失败'), { response: { status: 502 } }))
    const { player } = makePlayer()
    await player.playSong(yt)
    await vi.waitFor(() => expect(musicApi.retryMatch).toHaveBeenCalledTimes(1))
    await player.playSong(song(2))
    await player.playSong(yt) // 槽位已消费——重播不再发 retryMatch
    await vi.waitFor(() => expect(musicApi.getExternalLyric).toHaveBeenCalledTimes(2))
    await new Promise(r => setTimeout(r, 0))
    expect(musicApi.retryMatch).toHaveBeenCalledTimes(1)
    expect(yt.neteaseId).toBeUndefined()
  })

  // ── 纯文本命中也算「无滚动词」：触发闸口径放宽的回归 ──
  // 病灶实证：yt_RmNWbFWykLw 外源级联命中 lrclib 纯文本词（synced:false）
  // → 行集非空使旧闸 !lyrics.length 不满足 → rematchUnbound 永不触发，
  // 曲永远绑不上有滚动词的网易词源。新闸看「有无限 time 行」不看行数
  it('外源命中纯文本词（行集非空但 time 全非有限）：同算落空，触发自动首配', async () => {
    musicApi.getExternalLyric.mockResolvedValue({
      lrc: '一行\n二行', source: 'lrclib', extId: 'lrclib_36066431', synced: false,
    })
    musicApi.retryMatch.mockResolvedValue(null) // 只验触发——服务端配不配到另说
    const yt = ytUnbound()
    const { player } = makePlayer()
    await player.playSong(yt)
    // 纯文本行照常在屏（静态行不因触发首配而丢）
    expect(player.lyrics.value).toEqual([
      { time: Infinity, text: '一行' },
      { time: Infinity, text: '二行' },
    ])
    await vi.waitFor(() => expect(musicApi.retryMatch).toHaveBeenCalledTimes(1))
    expect(musicApi.retryMatch.mock.calls[0][0]).toMatchObject({
      trackId: 'yt_abcdefghijk', title: 'sasayakuを歌いました',
    })
  })

  // synced 命中的反向用例由上方「外源已命中（lyrics 非空）：不触发自动
  // 首配」覆盖——有有限 time 行时闸不成立

  // ── 绑后词空兜底：已绑定曲的词源无词时回落外源级联（绑定安全的另一半）──
  // 曲绑上 neteaseId 后 !song.neteaseId 闸使外源支不再进——不加兜底的话
  // 绑定词源无词时本在显示的外源词会永久消失（绑错=丢词）
  it('已绑定 yt_ 曲网易词空：回落外源级联，hit 落屏词属主键挂 extId', async () => {
    const yt = ytUnbound({ neteaseId: 777 })
    musicApi.getLyrics.mockResolvedValue({ lyrics: [] }) // 网易侧无词
    musicApi.getExternalLyric.mockResolvedValue({
      lrc: '[00:01.00]外源词', source: 'lrclib', extId: 'lrclib_5', synced: true,
    })
    parseLyrics.mockImplementation(() => [{ time: 1, text: '外源词' }])
    const { player } = makePlayer()
    await player.playSong(yt)
    await vi.waitFor(() => expect(musicApi.getLyrics).toHaveBeenCalledWith(777, expect.anything()))
    await vi.waitFor(() => expect(musicApi.getExternalLyric).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(player.lyrics.value).toEqual([{ time: 1, text: '外源词' }]))
    // 词属主键挂 extId：校准 meta 与归属核验都拿它（与未绑定支同口径）
    expect(downloadsApi.getSongMeta).toHaveBeenCalledWith('lrclib_5')
    await vi.waitFor(() =>
      expect(aiApi.verifyLyric).toHaveBeenCalledWith(
        'lrclib_5', 'sasayakuを歌いました', 'rei sirose - Topic', expect.anything()))
    // 已绑定曲不回首配——rematchUnbound 的 neteaseId==null 闸天然防环
    expect(musicApi.retryMatch).not.toHaveBeenCalled()
  })

  it('已绑定 yt_ 曲网易词空且外源也全灭：lyrics=[] 正常终态，不回首配', async () => {
    const yt = ytUnbound({ neteaseId: 777 })
    musicApi.getLyrics.mockResolvedValue({ lyrics: [] })
    musicApi.getExternalLyric.mockResolvedValue(null) // 级联全灭
    const { player } = makePlayer()
    await player.playSong(yt)
    await vi.waitFor(() => expect(musicApi.getExternalLyric).toHaveBeenCalledTimes(1))
    await new Promise(r => setTimeout(r, 0))
    expect(player.lyrics.value).toEqual([])
    expect(player.loadingLyrics.value).toBe(false)
    expect(musicApi.retryMatch).not.toHaveBeenCalled()
  })

  it('端到端回归：纯文本触发首配→绑上→网易词空→外源兜底接住，纯文本词不丢', async () => {
    // 病灶全链回放：yt_ 曲外源命中纯文本（synced:false）→ 放宽闸触发
    // rematchUnbound → 绑上网易词源 → 热重载走常规支 → 网易侧无词 →
    // UGC 形态回落外源 → 同一份纯文本词重新落屏（绑定不再等于丢词）
    musicApi.getExternalLyric.mockResolvedValue({
      lrc: '一行\n二行', source: 'lrclib', extId: 'lrclib_36066431', synced: false,
    })
    musicApi.retryMatch.mockResolvedValue({
      id: 1396945969, name: 'シルバーワープ', matchedBy: 'title+artist', score: 0.9,
      ar: [{ name: 'rei sirose' }], al: { id: 9, name: '专', picUrl: 'http://n/9.jpg' },
    })
    musicApi.getLyrics.mockResolvedValue({ lyrics: [] }) // 网易侧无词
    const yt = ytUnbound()
    const { player } = makePlayer()
    await player.playSong(yt)
    // 首配命中 → 绑定 → 热重载走常规网易词支
    await vi.waitFor(() => expect(yt.neteaseId).toBe(1396945969))
    await vi.waitFor(() =>
      expect(musicApi.getLyrics).toHaveBeenCalledWith(1396945969, expect.anything()))
    // 网易词空 → 外源兜底第二跳：同一份纯文本词重新落屏
    await vi.waitFor(() => expect(musicApi.getExternalLyric).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(player.lyrics.value).toEqual([
      { time: Infinity, text: '一行' },
      { time: Infinity, text: '二行' },
    ]))
    expect(player.currentLyricIndex.value).toBe(-1) // 静态行不滚动
    expect(downloadsApi.getSongMeta).toHaveBeenCalledWith('lrclib_36066431')
    expect(toast).toHaveBeenCalledWith('词源已自动重匹配', 'success')
  })
})

describe('usePlayer：远端 player-state 续播位挂账', () => {
  afterEach(() => resetSyncState())

  it('远端 state 应用后、消费前：本地整文写盘保留远端续播位不抹掉', async () => {
    const { player } = makePlayer()
    initSync()
    syncApi.pull.mockResolvedValue({
      code: 200,
      items: [{
        key: `doc:${LS_KEYS.PLAYER_STATE}`,
        value: JSON.stringify({
          selectedPlaylistId: 'pl_remote', playingPlaylistId: 'pl_remote',
          currentSongId: 77, currentTime: 45, volume: 33,
        }),
        updatedAt: Date.now() + 1000, seq: 1,
      }],
    })
    await pullFromServer()
    await nextTick()
    // 远端 UI 偏好灌进内存态；续播位挂账待消费
    expect(player.volume.value).toBe(33)
    // 消费前任何本地整文写盘（音量/偏好写回等）不得把续播位抹成空值
    player.savePlayerStateToStorage()
    const saved = JSON.parse(localStorage.getItem(LS_KEYS.PLAYER_STATE))
    expect(saved).toMatchObject({
      selectedPlaylistId: 'pl_remote', playingPlaylistId: 'pl_remote',
      currentSongId: 77, currentTime: 45, volume: 33,
    })
    // 本地真起播即销账——存档回归本地播放事实
    await player.playSong(song(9))
    player.savePlayerStateToStorage()
    expect(JSON.parse(localStorage.getItem(LS_KEYS.PLAYER_STATE)).currentSongId).toBe(9)
  })
})

describe('usePlayer：手动词务（获取歌词 / 生成滚动词）', () => {
  const bvSong = (extra) => song('bv_BV1xx411c7mD', {
    bilibili: { bvid: 'BV1xx411c7mD', title: '视频标题', author: 'UP主' },
    ...extra,
  })

  it('manualFetchLyrics 命中：行集落地 + extId 词属主键 + 源名 toast；曲名取 song.name 优先', async () => {
    const { player } = makePlayer()
    await player.playSong(bvSong()) // 自动支 mock 归 null → 空词
    howls.at(-1).fire('onload') // 切歌锁在 onload 才松——手动支有 songSwitching 闸
    expect(player.lyrics.value).toEqual([])

    parseLyrics.mockImplementation(() => [{ time: 1, text: '外源词' }])
    musicApi.getExternalLyric.mockResolvedValue({
      lrc: '[00:01.00]外源词', source: 'lrclib', extId: 'lrclib_42', synced: true,
    })
    await player.manualFetchLyrics()
    // 手动支检索口径：song.name 优先于 ext.title（手改名生效），artist 用 ext.author
    expect(musicApi.getExternalLyric).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: 'bv_BV1xx411c7mD', title: '歌bv_BV1xx411c7mD', artist: 'UP主', durationSec: 200,
      }))
    expect(player.lyrics.value).toEqual([{ time: 1, text: '外源词' }])
    expect(downloadsApi.getSongMeta).toHaveBeenCalledWith('lrclib_42')
    expect(toast).toHaveBeenCalledWith('已从 LRCLIB 获取歌词', 'success')
    expect(player.lyricFetching.value).toBe(false)
  })

  it('manualFetchLyrics 外源全灭（null）：「暂无歌词」toast 且不清空已有词', async () => {
    // 先经自动支落一份纯文本词
    musicApi.getExternalLyric.mockResolvedValue({
      lrc: '一行\n二行', source: 'kugou', extId: 'kugou_1', synced: false,
    })
    const { player } = makePlayer()
    await player.playSong(bvSong())
    howls.at(-1).fire('onload')
    expect(player.lyrics.value).toHaveLength(2)

    musicApi.getExternalLyric.mockResolvedValue(null)
    await player.manualFetchLyrics()
    expect(toast).toHaveBeenCalledWith('外部词源暂无这首歌的歌词', 'info')
    expect(player.lyrics.value).toHaveLength(2) // 旧词原样保留
    expect(player.lyricFetching.value).toBe(false)
  })

  it('manualFetchLyrics 防降级：滚动词在屏时纯文本命中被闸拦，只 toast 不换词', async () => {
    parseLyrics.mockImplementation(() => [{ time: 1, text: '滚动词' }])
    musicApi.getExternalLyric.mockResolvedValue({
      lrc: '[00:01.00]滚动词', source: 'lrclib', extId: 'lrclib_1', synced: true,
    })
    const { player } = makePlayer()
    await player.playSong(bvSong())
    howls.at(-1).fire('onload')
    expect(player.lyrics.value).toEqual([{ time: 1, text: '滚动词' }])

    // 手动再拉：外源这次只给纯文本——不许盖掉现有滚动词
    musicApi.getExternalLyric.mockResolvedValue({
      lrc: '纯文本词', source: 'kugou', extId: 'kugou_2', synced: false,
    })
    await player.manualFetchLyrics()
    expect(player.lyrics.value).toEqual([{ time: 1, text: '滚动词' }])
    expect(toast).toHaveBeenCalledWith('外源仅有纯文本歌词，保留现有滚动词', 'info')
  })

  it('manualFetchLyrics 升级放行：纯文本词在屏时滚动命中照常落地', async () => {
    musicApi.getExternalLyric.mockResolvedValue({
      lrc: '一行\n二行', source: 'lrclib', extId: 'lrclib_1', synced: false,
    })
    const { player } = makePlayer()
    await player.playSong(bvSong())
    howls.at(-1).fire('onload')
    expect(player.lyrics.value.every(l => !Number.isFinite(l.time))).toBe(true)

    parseLyrics.mockImplementation(() => [{ time: 1, text: '滚动词' }])
    musicApi.getExternalLyric.mockResolvedValue({
      lrc: '[00:01.00]滚动词', source: 'ytm', extId: 'ytm_abcdefghijk', synced: true,
    })
    await player.manualFetchLyrics()
    expect(player.lyrics.value).toEqual([{ time: 1, text: '滚动词' }])
    expect(toast).toHaveBeenCalledWith('已从 YouTube Music 获取歌词', 'success')
  })

  it('manualFetchLyrics 词源抛错（非 abort）：「暂时不可用」toast，词不动', async () => {
    const { player } = makePlayer()
    await player.playSong(bvSong())
    howls.at(-1).fire('onload')
    musicApi.getExternalLyric.mockRejectedValue(new Error('timeout'))
    await player.manualFetchLyrics()
    expect(toast).toHaveBeenCalledWith('歌词源暂时不可用，稍后重试', 'error')
    expect(player.lyrics.value).toEqual([])
    expect(player.lyricFetching.value).toBe(false)
  })

  it('manualFetchLyrics 在途防重入：闸锁期第二次调用不新发请求', async () => {
    const { player } = makePlayer()
    await player.playSong(bvSong())
    howls.at(-1).fire('onload')
    musicApi.getExternalLyric.mockClear()
    let release
    musicApi.getExternalLyric.mockImplementation(() => new Promise(r => { release = r }))
    const p1 = player.manualFetchLyrics()
    const p2 = player.manualFetchLyrics() // lyricFetching 已锁——直退
    release(null)
    await Promise.all([p1, p2])
    expect(musicApi.getExternalLyric).toHaveBeenCalledTimes(1)
    expect(toast).toHaveBeenCalledWith('外部词源暂无这首歌的歌词', 'info')
  })

  it('manualFetchLyrics 中途切歌：回包晚落不写新歌界面（seq 陈旧闸）', async () => {
    const { player } = makePlayer()
    await player.playSong(bvSong())
    howls.at(-1).fire('onload')
    let release
    musicApi.getExternalLyric.mockImplementation(() => new Promise(r => { release = r }))
    const p = player.manualFetchLyrics()
    await new Promise(r => setTimeout(r, 0)) // 让手动请求确实发出（release 赋值）
    await player.playSong(song(2)) // 切歌——lyricLoadSeq 再升，本代作废
    howls.at(-1).fire('onload')
    release({ lrc: '[00:01.00]晚到词', source: 'lrclib', extId: 'lrclib_9', synced: true })
    parseLyrics.mockImplementation(() => [{ time: 1, text: '晚到词' }])
    await p
    await new Promise(r => setTimeout(r, 0))
    expect(player.lyrics.value).toEqual([]) // song(2) 的词没被晚到回包盖掉
    expect(toast).not.toHaveBeenCalledWith(expect.stringContaining('已从'), 'success')
    expect(player.lyricFetching.value).toBe(false)
  })

  it('alignCurrentLyrics 成功：纯文本词换成解析后的滚动行 + toast', async () => {
    musicApi.getExternalLyric.mockResolvedValue({
      lrc: '一行\n二行', source: 'kugou', extId: 'kugou_1', synced: false,
    })
    const { player } = makePlayer()
    await player.playSong(bvSong())
    howls.at(-1).fire('onload') // 切歌锁在 onload 才松——手动支有 songSwitching 闸
    expect(player.lyrics.value).toEqual([
      { time: Infinity, text: '一行' },
      { time: Infinity, text: '二行' },
    ])

    musicApi.lyricAlign.mockResolvedValue({
      code: 200, lrc: '[00:01.00]一行\n[00:04.00]二行', alignedBy: 'llm',
    })
    parseLyrics.mockImplementation(() => [{ time: 1, text: '一行' }, { time: 4, text: '二行' }])
    await player.alignCurrentLyrics()
    expect(musicApi.lyricAlign).toHaveBeenCalledWith({
      songId: 'bv_BV1xx411c7mD', lines: ['一行', '二行'],
    })
    expect(player.lyrics.value).toEqual([{ time: 1, text: '一行' }, { time: 4, text: '二行' }])
    expect(player.currentLyricIndex.value).toBe(0)
    expect(toast).toHaveBeenCalledWith('已生成滚动歌词', 'success')
    expect(player.lyricFetching.value).toBe(false)
  })

  it('alignCurrentLyrics 404（无已下载音频）：专属文案，纯文本词原样保留', async () => {
    musicApi.getExternalLyric.mockResolvedValue({
      lrc: '一行', source: 'kugou', extId: 'kugou_1', synced: false,
    })
    const { player } = makePlayer()
    await player.playSong(bvSong())
    howls.at(-1).fire('onload')
    musicApi.lyricAlign.mockRejectedValue({
      response: { status: 404, data: { message: '该曲目没有已下载的音频文件' } },
    })
    await player.alignCurrentLyrics()
    expect(toast).toHaveBeenCalledWith('该歌曲还没有已下载的音频，无法生成滚动歌词', 'error')
    expect(player.lyrics.value).toEqual([{ time: Infinity, text: '一行' }])
    expect(player.lyricFetching.value).toBe(false)
  })

  it('alignCurrentLyrics 429/503 分诊文案', async () => {
    musicApi.getExternalLyric.mockResolvedValue({
      lrc: '一行', source: 'kugou', extId: 'kugou_1', synced: false,
    })
    const { player } = makePlayer()
    await player.playSong(bvSong())
    howls.at(-1).fire('onload')
    musicApi.lyricAlign.mockRejectedValueOnce({ response: { status: 503 } })
    await player.alignCurrentLyrics()
    expect(toast).toHaveBeenCalledWith('ffmpeg 不可用，无法生成滚动歌词', 'error')
    musicApi.lyricAlign.mockRejectedValueOnce({ response: { status: 429 } })
    await player.alignCurrentLyrics()
    expect(toast).toHaveBeenCalledWith('请求过于频繁，稍后再试', 'error')
    musicApi.lyricAlign.mockRejectedValueOnce({ response: { status: 502 } })
    await player.alignCurrentLyrics()
    expect(toast).toHaveBeenCalledWith('生成滚动歌词失败', 'error')
  })

  it('alignCurrentLyrics 已是滚动词/无词：直退不打请求', async () => {
    parseLyrics.mockImplementation(() => [{ time: 1, text: 'x' }])
    musicApi.getExternalLyric.mockResolvedValue({
      lrc: '[00:01.00]x', source: 'lrclib', extId: 'lrclib_1', synced: true,
    })
    const { player } = makePlayer()
    await player.playSong(bvSong())
    howls.at(-1).fire('onload') // 松开切歌锁——否则走的是 songSwitching 闸而非词态闸
    await player.alignCurrentLyrics()
    expect(musicApi.lyricAlign).not.toHaveBeenCalled()
    // 无词态同样直退
    parseLyrics.mockImplementation(() => [])
    musicApi.getExternalLyric.mockResolvedValue(null)
    await player.playSong(song(3))
    howls.at(-1).fire('onload')
    await player.alignCurrentLyrics()
    expect(musicApi.lyricAlign).not.toHaveBeenCalled()
  })

  it('手动代在途被切歌顶替：loadLyrics 升号即清悬挂锁，旧代 finally 不抢新代的锁', async () => {
    const { player } = makePlayer()
    await player.playSong(bvSong())
    howls.at(-1).fire('onload')
    let releaseA
    musicApi.getExternalLyric.mockImplementation(() => new Promise(r => { releaseA = r }))
    const pA = player.manualFetchLyrics()
    await new Promise(r => setTimeout(r, 0)) // A 代请求确实发出（releaseA 赋值）
    expect(player.lyricFetching.value).toBe(true)

    // 切歌：loadLyrics 升号接管词态——悬挂锁当场清，不等 A 代 80s 超时 settle
    await player.playSong(song(2))
    howls.at(-1).fire('onload')
    expect(player.lyricFetching.value).toBe(false)

    // 新曲手动代照常进（旧锁不挡），重入闸语义：B 代在途再点仍被早退挡
    let releaseB
    musicApi.getExternalLyric.mockImplementation(() => new Promise(r => { releaseB = r }))
    const callsBefore = musicApi.getExternalLyric.mock.calls.length
    const pB = player.manualFetchLyrics()
    await new Promise(r => setTimeout(r, 0))
    expect(musicApi.getExternalLyric).toHaveBeenCalledTimes(callsBefore + 1)
    expect(player.lyricFetching.value).toBe(true)

    // A 代迟到回包：seq 失配 stale 丢弃，finally 也不抢 B 代持有的锁
    releaseA({ lrc: '[00:01.00]晚到词', source: 'lrclib', extId: 'lrclib_9', synced: true })
    await pA
    await new Promise(r => setTimeout(r, 0))
    expect(player.lyricFetching.value).toBe(true) // 仍属 B 代——没被 A 清掉

    releaseB(null)
    await pB
    expect(player.lyricFetching.value).toBe(false)
  })

  it('manualFetchLyrics 命中但行集为空（lrc 全是元行被滤光）：归「暂无歌词」不报假成功', async () => {
    const { player } = makePlayer()
    await player.playSong(bvSong())
    howls.at(-1).fire('onload')
    // hit 非 null 但剥完行首元行后一行不剩——applied=true、rows=[]
    musicApi.getExternalLyric.mockResolvedValue({
      lrc: '[ti:歌名]\n[ar:某人]\n[offset:0]', source: 'lrclib', extId: 'lrclib_7', synced: false,
    })
    await player.manualFetchLyrics()
    expect(toast).toHaveBeenCalledWith('外部词源暂无这首歌的歌词', 'info')
    expect(toast).not.toHaveBeenCalledWith(expect.stringContaining('已从'), 'success')
    expect(player.lyrics.value).toEqual([])
  })

  it('manualFetchLyrics 撞 429：限流专属文案（与生成滚动词分诊同口径）', async () => {
    const { player } = makePlayer()
    await player.playSong(bvSong())
    howls.at(-1).fire('onload')
    musicApi.getExternalLyric.mockRejectedValue({ response: { status: 429 } })
    await player.manualFetchLyrics()
    expect(toast).toHaveBeenCalledWith('请求过于频繁，稍后再试', 'error')
    expect(player.lyricFetching.value).toBe(false)
  })

  it('alignCurrentLyrics 切歌锁未松（songSwitching）时直退：不拿新曲音频对旧词打轴', async () => {
    musicApi.getExternalLyric.mockResolvedValue({
      lrc: '一行', source: 'kugou', extId: 'kugou_1', synced: false,
    })
    const { player } = makePlayer()
    await player.playSong(bvSong())
    // 不 fire onload——songSwitching 仍 true（旧词还挂在屏上、音频是旧曲的）
    expect(player.lyrics.value).toEqual([{ time: Infinity, text: '一行' }])
    await player.alignCurrentLyrics()
    expect(musicApi.lyricAlign).not.toHaveBeenCalled()
  })

  it('alignCurrentLyrics 行集超契约上限：≤600 行/单行 ≤500 字截断发送，成功文案补注', async () => {
    // 650 行纯文本词（首行 600 字长行）——走真实 plainRowsOf 落 Infinity 行
    musicApi.getExternalLyric.mockResolvedValue({
      lrc: ['长'.repeat(600), ...Array(649).fill('词')].join('\n'),
      source: 'kugou', extId: 'kugou_1', synced: false,
    })
    const { player } = makePlayer()
    await player.playSong(bvSong())
    howls.at(-1).fire('onload')
    expect(player.lyrics.value).toHaveLength(650)

    musicApi.lyricAlign.mockResolvedValue({ code: 200, lrc: '[00:01.00]x' })
    parseLyrics.mockImplementation(() => [{ time: 1, text: 'x' }])
    await player.alignCurrentLyrics()
    const payload = musicApi.lyricAlign.mock.calls.at(-1)[0]
    expect(payload.lines).toHaveLength(600)
    expect(payload.lines.every(l => l.length <= 500)).toBe(true)
    expect(payload.lines[0]).toHaveLength(500) // 600 字长行被切到契约上限
    expect(toast).toHaveBeenCalledWith('已生成滚动歌词（超出上限部分已截断）', 'success')
  })

  it('alignCurrentLyrics 落地后补发 postProcess：无戳批次跳过的 AI 翻译补位', async () => {
    aiApi.status.mockResolvedValue({ enabled: true })
    // 网易云曲拿到无戳纯文本词（getLyrics 直接回行集）
    musicApi.getLyrics.mockResolvedValue({
      lyrics: [{ time: Infinity, text: 'line one' }, { time: Infinity, text: 'line two' }],
    })
    const { player } = makePlayer()
    await player.playSong(song(7))
    howls.at(-1).fire('onload')
    // 自动支 postProcess 确实跑过，但在「无有限戳无挂载点」闸早退——translate 未发
    await vi.waitFor(() => expect(aiApi.status).toHaveBeenCalled())
    await new Promise(r => setTimeout(r, 0))
    expect(aiApi.translateLyric).not.toHaveBeenCalled()

    musicApi.lyricAlign.mockResolvedValue({
      code: 200, lrc: '[00:01.00]line one\n[00:04.00]line two',
    })
    parseLyrics.mockImplementation(() => [{ time: 1, text: 'line one' }, { time: 4, text: 'line two' }])
    await player.alignCurrentLyrics()
    // 补轴成行集有戳后重发一轮后处理——翻译按词属主键（=lyricId 7）补位
    await vi.waitFor(() => expect(aiApi.translateLyric).toHaveBeenCalledWith(7))
  })
})

describe('usePlayer：downloadCurrentSong（watch 顶行键）', () => {
  // 归属性注入靠 selectedPlaylist→playSong 快照落 playingPlaylistId；镜像
  // 对象解析靠 userPlaylists 里同名行（queueOwner 同一张闸）
  const localPl = (t) => ({ id: 'local_pl_1', name: 'P', tracks: [t], isLocal: true })

  it('数字归属 id 直提（不镜像），completed 短路即成功 toast', async () => {
    const { player, deps } = makePlayer()
    deps.selectedPlaylist.value = { id: 12345 }
    await player.playSong(song(7))
    await player.downloadCurrentSong()
    expect(downloadsApi.mirrorLocalPlaylist).not.toHaveBeenCalled()
    expect(downloadsApi.downloadSongToServer).toHaveBeenCalledWith(12345, 7, expect.objectContaining({
      bitrate: 320000, downloadAudio: true, downloadLyrics: true,
      downloadCover: true, downloadVideo: false,
    }))
    expect(toast).toHaveBeenCalledWith('下载成功', 'success')
    expect(player.songDownloading.value).toBe(false)
  })

  it('yt 可视曲带视频相位（hasVideo 命中）', async () => {
    const { player, deps } = makePlayer()
    const yt = song('yt_abcdefghijk', { youtube: { videoId: 'abcdefghijk', hasVideo: true } })
    deps.selectedPlaylist.value = { id: 12345 }
    await player.playSong(yt)
    await player.downloadCurrentSong()
    expect(downloadsApi.downloadSongToServer).toHaveBeenCalledWith(
      12345, 'yt_abcdefghijk', expect.objectContaining({ downloadVideo: true }))
  })

  it('bv 可视曲沿用 hasVideo 判视频相位', async () => {
    const { player, deps } = makePlayer()
    const bv = song('bv_BV1xx411c7mD', { bilibili: { bvid: 'BV1xx411c7mD', hasVideo: true } })
    deps.selectedPlaylist.value = { id: 12345 }
    await player.playSong(bv)
    await player.downloadCurrentSong()
    expect(downloadsApi.downloadSongToServer).toHaveBeenCalledWith(
      12345, 'bv_BV1xx411c7mD', expect.objectContaining({ downloadVideo: true }))
  })

  it('local_pl_ 归属先镜像再提交；file_ 与 in-flight 连点被闸', async () => {
    const { player, deps } = makePlayer()
    const t = song(7)
    deps.userPlaylists.value = [localPl(t)]
    deps.selectedPlaylist.value = localPl(t)
    await player.playSong(t) // playingPlaylistId=local_pl_1
    downloadsApi.downloadSongToServer.mockImplementation(async () => ({ data: { status: 'pending' } }))
    downloadsApi.getSongDownloadStatus.mockResolvedValue({ data: { downloaded: true } })
    let release
    downloadsApi.downloadSongToServer.mockImplementationOnce(
      () => new Promise(r => { release = () => r({ data: { status: 'pending' } }) }))
    const p1 = player.downloadCurrentSong()
    expect(player.songDownloading.value).toBe(true)   // busy 按曲锚定
    await player.downloadCurrentSong()                // 同曲连点被 busy 闸弹回
    // 镜像 .catch 多一跳微任务——等提交真到（挂起 impl 就位）再放行
    await vi.waitFor(() => expect(downloadsApi.downloadSongToServer).toHaveBeenCalledTimes(1))
    release()
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('下载成功', 'success'), { timeout: 8000 })
    await p1
    expect(downloadsApi.mirrorLocalPlaylist).toHaveBeenCalledWith(localPl(t))
    expect(downloadsApi.downloadSongToServer).toHaveBeenCalledTimes(1)
    expect(player.songDownloading.value).toBe(false)

    // file_ 上传曲资产本就在服务端——键面不亮，误调也直接弹回
    toast.mockClear()
    const ft = song('file_abcd1234')
    deps.userPlaylists.value = [localPl(ft)]
    deps.selectedPlaylist.value = localPl(ft)
    await player.playSong(ft)
    await player.downloadCurrentSong()
    expect(downloadsApi.downloadSongToServer).toHaveBeenCalledTimes(1)
  })

  it('local_pl_ 归属：镜像先于提交，playlistId 直传 local_pl_1', async () => {
    const { player, deps } = makePlayer()
    const t = song(7)
    deps.userPlaylists.value = [localPl(t)]
    deps.selectedPlaylist.value = localPl(t)
    await player.playSong(t) // playingPlaylistId=local_pl_1
    await player.downloadCurrentSong()
    // 调用序钉死：镜像先于提交——服务端须先落镜像行才解得出 local_pl_ 寻址
    expect(downloadsApi.mirrorLocalPlaylist).toHaveBeenCalledWith(localPl(t))
    expect(downloadsApi.mirrorLocalPlaylist.mock.invocationCallOrder[0])
      .toBeLessThan(downloadsApi.downloadSongToServer.mock.invocationCallOrder[0])
    expect(downloadsApi.downloadSongToServer).toHaveBeenCalledWith(
      'local_pl_1', 7, expect.objectContaining({ bitrate: 320000 }))
    expect(toast).toHaveBeenCalledWith('下载成功', 'success')
  })

  it('saved_queue_ 归属同走镜像+提交（镜像形态白名单一员）', async () => {
    const { player, deps } = makePlayer()
    const t = song(7)
    const q = { id: 'saved_queue_1', name: '队列单', tracks: [t], isLocal: true }
    deps.userPlaylists.value = [q]
    deps.selectedPlaylist.value = q
    await player.playSong(t) // playingPlaylistId=saved_queue_1
    await player.downloadCurrentSong()
    expect(downloadsApi.mirrorLocalPlaylist).toHaveBeenCalledWith(q)
    expect(downloadsApi.downloadSongToServer).toHaveBeenCalledWith(
      'saved_queue_1', 7, expect.anything())
  })

  it('队列无归属（playingPlaylistId=null）→ toast 指引早退，不提交', async () => {
    const { player } = makePlayer()
    await player.playSong(song(7)) // 搜索/暂存语境：playingPlaylistId 快照为 null
    await player.downloadCurrentSong()
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('未归属歌单'), 'info')
    expect(downloadsApi.mirrorLocalPlaylist).not.toHaveBeenCalled()
    expect(downloadsApi.downloadSongToServer).not.toHaveBeenCalled()
  })

  it('single_song_ 壳同按无归属早退', async () => {
    const { player, deps } = makePlayer()
    const t = song(7)
    deps.selectedPlaylist.value = { id: 'single_song_9', name: 'S', tracks: [t] }
    await player.playSong(t) // playingPlaylistId=single_song_9
    await player.downloadCurrentSong()
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('未归属歌单'), 'info')
    expect(downloadsApi.downloadSongToServer).not.toHaveBeenCalled()
  })

  it('提交成功 → 队列 toast；轮询见 downloaded → 成功 toast', async () => {
    const { player, deps } = makePlayer()
    deps.selectedPlaylist.value = { id: 777 }
    await player.playSong(song(7))
    downloadsApi.downloadSongToServer.mockImplementation(async () => ({ data: { status: 'pending' } }))
    let st = { data: { audioReady: false, task: { status: 'downloading' } } }
    downloadsApi.getSongDownloadStatus.mockImplementation(async () => st)
    const p = player.downloadCurrentSong()
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('已加入下载队列', 'info'))
    st = { data: { downloaded: true, audioReady: true, task: { status: 'completed' } } }
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('下载成功', 'success'), { timeout: 8000 })
    await p
  })

  it('提交撞 409（任务已在跑）：不误判失败，进轮询等终态', async () => {
    const { player, deps } = makePlayer()
    deps.selectedPlaylist.value = { id: 777 }
    await player.playSong(song(7))
    downloadsApi.downloadSongToServer.mockRejectedValue(
      { response: { status: 409, data: { message: '该歌曲正在下载中' } } })
    downloadsApi.getSongDownloadStatus.mockResolvedValue({ data: { downloaded: true } })
    await player.downloadCurrentSong()
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('下载成功', 'success'), { timeout: 8000 })
    expect(toast).not.toHaveBeenCalledWith(expect.stringContaining('下载失败'), expect.anything())
  })

  it('切歌静默：服务端任务照跑，终态 toast 按归属曲压制', async () => {
    const { player, deps } = makePlayer()
    const a = song(7)
    deps.selectedPlaylist.value = { id: 777 }
    await player.playSong(a)
    downloadsApi.downloadSongToServer.mockImplementation(async () => ({ data: { status: 'pending' } }))
    let st = { data: { audioReady: false, task: { status: 'downloading' } } }
    downloadsApi.getSongDownloadStatus.mockImplementation(async () => st)
    const p = player.downloadCurrentSong()
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('已加入下载队列', 'info'))
    // 切走：任务在服务端继续跑（轮询不打断），但终态 toast 不再弹
    await player.playSong(song(8))
    st = { data: { downloaded: true, audioReady: true, task: { status: 'completed' } } }
    await p // 轮询至多 3min——mock 已落 downloaded，一轮即收
    expect(toast).not.toHaveBeenCalledWith('下载成功', 'success')
    expect(player.songDownloading.value).toBe(false)
  })

  it('提交报文被拒（非 409）：失败原因 toast', async () => {
    const { player, deps } = makePlayer()
    deps.selectedPlaylist.value = { id: 777 }
    await player.playSong(song(7))
    downloadsApi.downloadSongToServer.mockRejectedValue({ response: { status: 500, data: { message: 'boom' } } })
    await player.downloadCurrentSong()
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('boom'), 'error')
    expect(player.songDownloading.value).toBe(false)
  })

  // 「下一首播放」插入曲只进 playingSongs 快照、不落户归属单 tracks——拿归属单
  // 提交服务端按单查曲必 404；成员预检应改扫全库找含该曲的单顶替寻址
  const queueInsertedDownload = async (fallbackPl) => {
    const a = song(1)
    const x = song(99)
    const plA = { id: 'local_pl_a', name: 'A', tracks: [a, song(2)], isLocal: true }
    const { player, deps } = makePlayer({ songs: [a, song(2)] })
    deps.userPlaylists.value = fallbackPl ? [plA, fallbackPl] : [plA]
    deps.selectedPlaylist.value = plA
    await player.playSong(a)   // playingPlaylistId=local_pl_a，队列=[a,b]
    player.playNextInQueue(x)  // x 插队尾邻——不落 local_pl_a.tracks
    const howlCount = howls.length
    player.queueJump(1)        // 快照内导航：playingPlaylistId 保持 local_pl_a
    // currentSong 先于 Howl 构造落地——等实例落册才算 x 代起播完成
    await vi.waitFor(() => expect(howls.length).toBeGreaterThan(howlCount))
    expect(player.currentSong.value?.id).toBe(99)
    return { player, deps, plA, x }
  }

  it('在播曲不在归属单曲目表（队列插入曲）：扫到兜底单顶替寻址直提', async () => {
    const x = song(99)
    const plB = { id: 'local_pl_b', name: 'B', tracks: [x], isLocal: true }
    const { player } = await queueInsertedDownload(plB)
    await player.downloadCurrentSong()
    // 顶替寻址：镜像/提交都走含该曲的 local_pl_b，而非归属单 local_pl_a
    expect(downloadsApi.mirrorLocalPlaylist).toHaveBeenCalledWith(plB)
    expect(downloadsApi.mirrorLocalPlaylist.mock.invocationCallOrder[0])
      .toBeLessThan(downloadsApi.downloadSongToServer.mock.invocationCallOrder[0])
    expect(downloadsApi.downloadSongToServer).toHaveBeenCalledWith(
      'local_pl_b', 99, expect.anything())
    expect(toast).toHaveBeenCalledWith('下载成功', 'success')
  })

  it('兜底单命中数字 id 歌单：直提不镜像（服务端自有导入路径）', async () => {
    const x = song(99)
    const plNum = { id: 888, name: 'N', tracks: [x] } // 库行已摊曲目表的远端单
    const { player } = await queueInsertedDownload(plNum)
    await player.downloadCurrentSong()
    expect(downloadsApi.mirrorLocalPlaylist).not.toHaveBeenCalled()
    expect(downloadsApi.downloadSongToServer).toHaveBeenCalledWith(888, 99, expect.anything())
  })

  it('在播曲不在任何歌单：toast 指引早退，不白跑必败提交', async () => {
    const { player } = await queueInsertedDownload(null)
    await player.downloadCurrentSong()
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('不在任何歌单'), 'info')
    expect(downloadsApi.mirrorLocalPlaylist).not.toHaveBeenCalled()
    expect(downloadsApi.downloadSongToServer).not.toHaveBeenCalled()
    expect(player.songDownloading.value).toBe(false)
  })
})

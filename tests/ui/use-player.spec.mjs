// usePlayer 状态机：Howl 全桩捕获回调，驱动 onload/onplay/onloaderror
// 断言——本地档优先 / 本地档坏转在线 / 竞态切歌 / 队列快照 / 持久化恢复。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, nextTick } from 'vue'

// ── Howler 桩：实例入册，回调手动触发（模拟真实异步事件序）──
const { howls } = vi.hoisted(() => ({ howls: [] }))
vi.mock('howler', () => {
  class FakeHowl {
    constructor(opts) {
      this.opts = opts; this._seek = 0; this._vol = 1; this.unloaded = false
      // _playing/_state 可控：play/pause/stop 真翻转（playing() 语义闸——
      // 单曲就地重播、stopAtQueueEnd 收声都吃它）；_state 改 'loading'
      // 驱动 togglePlay 加载窗吞键闸与看门狗回收用例
      this._playing = false
      this._state = 'loaded'
      howls.push(this)
    }
    play() { this._playing = true; this.opts.onplay?.() }
    pause() { this._playing = false; this.opts.onpause?.() }
    stop() { this._playing = false; this.opts.onstop?.() }
    unload() { this.unloaded = true }
    duration() { return this.opts._duration ?? 200 }
    seek(v) { if (v === undefined) return this._seek; this._seek = v; return this._seek }
    volume(v) { if (v === undefined) return this._vol; this._vol = v }
    rate(v) { return v === undefined ? 1 : undefined }
    playing() { return this._playing }
    state() { return this._state }
    fire(name, ...args) { this.opts[name]?.(...args) }
  }
  return { Howl: FakeHowl, Howler: { html5PoolSize: 0, volume: vi.fn(), mute: vi.fn() } }
})

vi.mock('../../src/api/music.js', () => ({
  musicApi: {
    getSongUrl: vi.fn(async () => ({ url: 'https://cdn.example/online.mp3', br: 320000 })),
    searchSongs: vi.fn(async () => []),
    // continueWithRelated 改走 lib/related.js 同源分派后按曲源可达的三条腿
    getBiliRelated: vi.fn(async () => ({ items: [] })),
    getYouTubeRelated: vi.fn(async () => ({ items: [], mixPlaylistId: null })),
    searchQQSongs: vi.fn(async () => ({ songs: [], total: 0 })),
    bilibiliStreamUrl: vi.fn(() => 'https://x/bili'),
    youtubeStreamUrl: vi.fn(() => 'https://x/yt'),
    qqStreamUrl: vi.fn(() => 'https://x/qq'),
    // 返回形与生产一致：http.js 拦截器已剥 axios 壳，getLyrics 回 {lyrics}
    getLyrics: vi.fn(async () => ({ lyrics: [] })),
    getQQLyric: vi.fn(async () => ({ lyrics: [] })),
    getExternalLyric: vi.fn(async () => null),
    // 手动绑定词读口（/lyric/manual）——默认未绑归 null 落回自动链
    getManualLyric: vi.fn(async () => null),
    lyricAlign: vi.fn(async () => null),
    retryMatch: vi.fn(async () => null),
    // /match/state 绑定态读口——默认无正绑（match=null）
    getMatchState: vi.fn(async () => null),
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
import { usePlayer, notifyRemoteSeek } from '../../src/composables/usePlayer.js'
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
  musicApi.searchSongs.mockImplementation(async () => [])
  // related 三腿新桩同样归位——用例内 mockResolvedValue 覆写会残留到次例
  musicApi.getBiliRelated.mockResolvedValue({ items: [] })
  musicApi.getYouTubeRelated.mockResolvedValue({ items: [], mixPlaylistId: null })
  musicApi.searchQQSongs.mockResolvedValue({ songs: [], total: 0 })
  downloadsApi.getSongDownloadStatus.mockImplementation(async () => null)
  // clearAllMocks 只清调用记录不清实现——逐用例覆写的 mock 全部归位
  parseLyrics.mockImplementation(() => [])
  downloadsApi.downloadSongToServer.mockImplementation(async () => ({ data: { status: 'completed' } }))
  downloadsApi.mirrorLocalPlaylist.mockImplementation(async () => ({}))
  musicApi.getLyrics.mockResolvedValue({ lyrics: [] })
  musicApi.getExternalLyric.mockResolvedValue(null)
  musicApi.getManualLyric.mockResolvedValue(null)
  musicApi.lyricAlign.mockResolvedValue(null)
  musicApi.retryMatch.mockResolvedValue(null)
  musicApi.getMatchState.mockResolvedValue(null)
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

  // L9：200 壳 data 缺省（网关掐 body）与探测抛错同计——不可读即失联，
  // 旧口径 pollErrors=0 重置会把失联轮空转撑满 3min deadline
  it('轮询回 200 但 data 缺省：与抛错同计失联，4 次收束「仍在进行」', async () => {
    const yt = ytSong({ youtube: { videoId: 'abcdefghijk' } })
    const { player, deps } = makePlayer()
    deps.selectedPlaylist.value = localPl(yt)
    downloadsApi.downloadSongToServer.mockRejectedValueOnce(
      { response: { status: 409, data: { message: '该歌曲正在下载中' } } })
    downloadsApi.getSongDownloadStatus
      .mockImplementationOnce(async () => null)      // 主链探测无档
      .mockImplementationOnce(async () => null)      // 重解代探测无档
      .mockImplementationOnce(async () => null)      // 兜底探测无档
      .mockResolvedValue({})                         // 轮询段：200 壳无 data 连击
    await player.playSong(yt)
    await driveToDownloadFallback()
    await vi.waitFor(() => expect(player.playbackError.value).toMatch(/仍在进行/), { timeout: 12000 })
    expect(player.songSwitching.value).toBe(false)
    expect(howls).toHaveLength(2)
    // 与抛错失联同账：3 次探测 + 恰好 4 次 data 缺省轮询即 break
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

  // 远端单的本地追加曲只落 addedTracks 不落 tracks（上游曲目表没有它们）——
  // 成员预检与兜底扫描两表并查才寻址得到；命中数字单后提交还要带 track
  // 载荷，服务端枚举成员前增量补行才认得出这个上游没有的成员
  it('追加曲只在远端单 addedTracks：顶替寻址命中数字单，提交带 track 落库', async () => {
    const plR = { id: 888, name: 'R', tracks: [song(5)], addedTracks: [ytSong()] }
    const { player } = await driveQueueInsertedFallback(plR)
    await vi.waitFor(() => expect(downloadsApi.downloadSongToServer).toHaveBeenCalled())
    // 数字单不镜像——曲对象随 track 载荷下发，服务端按增量补行落库
    expect(downloadsApi.mirrorLocalPlaylist).not.toHaveBeenCalled()
    expect(downloadsApi.downloadSongToServer).toHaveBeenCalledWith(
      888, 'yt_abcdefghijk',
      expect.objectContaining({ track: expect.objectContaining({ id: 'yt_abcdefghijk' }) }))
    await vi.waitFor(() =>
      expect(howls.at(-1).opts.src).toEqual(['http://api/dl/888/yt_abcdefghijk']))
    expect(player.playbackError.value).toBe('')
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
    expect(musicApi.bilibiliStreamUrl).toHaveBeenCalledWith('BV1xx411c7mD', 'audio', undefined, 3, '', 0)
    expect(howls[0].opts.src).toEqual(['https://x/bili'])
  })

  it('qq_ 裸 id 按形态自解在线链：mid 从 id 还原，mediaMid 缺省走服务端回填', async () => {
    const qq = song('qq_0034M8WL3V4oHC')
    const { player } = makePlayer()
    await player.playSong(qq)
    expect(musicApi.getSongUrl).not.toHaveBeenCalled()
    expect(musicApi.qqStreamUrl).toHaveBeenCalledWith('0034M8WL3V4oHC', '', undefined, 0)
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

  it('qq_ 裸 id 词源空且无 neteaseId：回落外源级联兜底，不进首配链', async () => {
    const qq = song('qq_0034M8WL3V4oHC')
    const { player, deps } = makePlayer()
    deps.selectedPlaylist.value = localPl(qq)
    await player.playSong(qq)
    expect(musicApi.getQQLyric).toHaveBeenCalledWith('0034M8WL3V4oHC', expect.anything())
    expect(musicApi.getLyrics).not.toHaveBeenCalled()
    // 与下载链同口径接外源级联；qq_ 无 provider 块，ar 即曲库真实署名
    expect(musicApi.getExternalLyric).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'qq_0034M8WL3V4oHC', title: '歌qq_0034M8WL3V4oHC', artist: '艺人', durationSec: 200,
      }), expect.anything())
    // 不触 rematchUnbound——那是 UGC 未绑定曲的首配面，qq_ 有自家权威词源
    expect(musicApi.retryMatch).not.toHaveBeenCalled()
  })

  it('file_ 上传词是纯文本（无时间戳）：剥戳落静态行不滚动，补轴入口可现身', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, text: async () => '第一段词\n第二段词',
    })))
    try {
      const ft = song('file_abcd1234')
      const { player } = makePlayer()
      await player.playSong(ft)
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('file_abcd1234'), expect.anything())
      // 与外源 hit 纯文本落地同口径：time:Infinity 静态行——可读不滚动，
      // 「生成滚动词」补轴入口靠非有限戳行现身（旧口径全空锁死入口）
      expect(player.lyrics.value).toEqual([
        { time: Infinity, text: '第一段词' },
        { time: Infinity, text: '第二段词' },
      ])
      expect(player.currentLyricIndex.value).toBe(-1)
    } finally {
      vi.unstubAllGlobals()
    }
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
      expect(aiApi.verifyLyric).toHaveBeenCalledWith('lrclib_42', '视频标题', 'UP主', expect.anything(), 'bv_BV1xx411c7mD', undefined))
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

  it('verify 判否且 /match/retry 完成型 miss：镜像服务端负行解绑，正播曲走外源兜底', async () => {
    // name/al 已被错配烘脏（matched 残留名残留专辑）——解绑顺带洗回 provider 态
    const bv = bvSong({ neteaseId: 111, name: '乐园(粤)', al: { id: 99, name: '脏专辑' } })
    musicApi.getLyrics.mockResolvedValue({ lyrics: [{ time: 1, text: '错词' }] })
    aiApi.verifyLyric.mockResolvedValue({ ok: false })
    musicApi.retryMatch.mockResolvedValue(null) // 完成型 miss——异常是 reject 不是 null
    const { player, deps } = makePlayer()
    await player.playSong(bv)
    // 本次外发 excludeIds 含当前绑定 111 → 客户端镜像负行终态：解绑
    await vi.waitFor(() => expect(bv.neteaseId).toBeNull())
    expect(musicApi.retryMatch.mock.calls[0][0].excludeIds).toEqual([111])
    // applyMatchResult(null)：name 回 provider 原标题、al 回 provider 态、
    // 匹配证据随绑定清掉——错配烘进的元信息残留连根自愈
    expect(bv.name).toBe('视频标题')
    expect(bv.al.name).toBe('视频标题')
    expect(bv.al.id).toBeNull()
    expect(bv.bilibili.matchedBy).toBeNull()
    expect(deps.savePlaylistsToStorage).toHaveBeenCalled()
    // 仍正播 → 热重载走 /lyric/external 外源兜底支（当会话接词不等下会话）
    await vi.waitFor(() => expect(musicApi.getExternalLyric).toHaveBeenCalled())
    expect(player.lyrics.value).toEqual([]) // 外源全灭——屏上维持藏词后空词
    // 外源终态全灭且曲已解绑 → 级联 rematchUnbound 发第二发 retryMatch：
    // excludeIds 仍带判否累积集（rematchTried 记账的 111）——漏并会让服务端
    // 把刚否决的确定性高分原样送回（防 ping-pong 不变量钉板）
    await vi.waitFor(() => expect(musicApi.retryMatch).toHaveBeenCalledTimes(2))
    expect(musicApi.retryMatch.mock.calls[1][0]).toMatchObject({
      trackId: 'bv_BV1xx411c7mD', title: '视频标题', author: 'UP主',
    })
    expect(musicApi.retryMatch.mock.calls[1][0].excludeIds).toEqual([111])
    expect(bv.neteaseId).toBeNull() // 第二发也 miss——解绑终态不回弹
    expect(toast).toHaveBeenCalledWith('歌词与歌曲疑似不匹配，已隐藏', 'info')
    expect(toast).not.toHaveBeenCalledWith('词源已自动重匹配', 'success') // 解绑静默
  })

  it('retryMatch 同 id 回包（服务端原样送回现绑定）：不换绑、不覆写、不重载词', async () => {
    // name/al 已被错配烘脏——same-id 早退不过 applyMatchResult，一个字不写
    const bv = bvSong({ neteaseId: 111, name: '乐园(粤)', al: { id: 99, name: '脏专辑' } })
    musicApi.getLyrics.mockResolvedValue({ lyrics: [{ time: 1, text: '错词' }] })
    aiApi.verifyLyric.mockResolvedValue({ ok: false })
    // 服务端把现绑定 111 原样送回（matched.id === song.neteaseId）——
    // 同 id 命中不等于新匹配：不写回对象、不落盘、不热重载
    musicApi.retryMatch.mockResolvedValue({ id: 111, name: '别的名', ar: [], al: {} })
    const { player, deps } = makePlayer()
    await player.playSong(bv)
    await vi.waitFor(() => expect(musicApi.retryMatch).toHaveBeenCalledTimes(1))
    await new Promise(r => setTimeout(r, 0)) // 让回包路径 settle 完再断言无副作用
    expect(bv.neteaseId).toBe(111)          // 绑定原地不动（判否语义未镜像解绑）
    expect(bv.name).toBe('乐园(粤)')         // 不过修复器——错配名不洗也不覆写
    expect(bv.al.name).toBe('脏专辑')
    expect(musicApi.getExternalLyric).not.toHaveBeenCalled() // 不重载词路
    expect(musicApi.getLyrics).toHaveBeenCalledTimes(1)      // 词也不重打
    expect(deps.savePlaylistsToStorage).not.toHaveBeenCalled()
    expect(player.lyrics.value).toEqual([]) // 藏词终态保持——错词不回屏
  })

  it('判否 miss 解绑→级联首配第二发命中新 id：完成换绑并重载词', async () => {
    // 第一发（判否换绑）miss → 镜像解绑 → 外源兜底全灭 → rematchUnbound
    // 首配兜底发第二发命中——判否累积集没白记：同会话内自愈完成换绑
    const bv = bvSong({ neteaseId: 111 })
    musicApi.getLyrics.mockResolvedValue({ lyrics: [{ time: 1, text: '网易词' }] })
    aiApi.verifyLyric
      .mockResolvedValueOnce({ ok: false }) // 111 词源判否
      .mockResolvedValue({ ok: true })      // 222 新词源过审
    musicApi.retryMatch
      .mockResolvedValueOnce(null) // 判否换绑完成型 miss → 解绑
      .mockResolvedValue({         // 级联 rematchUnbound 第二发命中替代词源
        id: 222, name: '对的歌', matchedBy: 'title+artist', score: 0.9,
        ar: [{ name: 'UP主' }], al: { id: 9, name: '对的专辑', picUrl: 'http://n/9.jpg' },
      })
    const { player } = makePlayer()
    await player.playSong(bv)
    // 两发 retryMatch：判否换绑一发 + 解绑后未绑定支首配兜底一发，
    // 第二发 excludeIds 仍带判否累积集 111（刚否决的词源不回锅）
    await vi.waitFor(() => expect(musicApi.retryMatch).toHaveBeenCalledTimes(2))
    expect(musicApi.retryMatch.mock.calls[0][0].excludeIds).toEqual([111])
    expect(musicApi.retryMatch.mock.calls[1][0].excludeIds).toEqual([111])
    // 完成换绑：neteaseId=222，applyMatchResult 整组重建（author 重合
    // → name/al/证据吃 matched）
    await vi.waitFor(() => expect(bv.neteaseId).toBe(222))
    expect(bv.name).toBe('对的歌')
    expect(bv.al.name).toBe('对的专辑')
    expect(bv.bilibili.matchedBy).toBe('title+artist')
    // 热重载走常规网易词支——词落屏
    await vi.waitFor(() =>
      expect(musicApi.getLyrics).toHaveBeenCalledWith(222, expect.anything()))
    await vi.waitFor(() =>
      expect(player.lyrics.value).toEqual([{ time: 1, text: '网易词' }]))
  })

  it('判否+miss 解绑后外源命中：当会话接上词落屏（不等下一会话）', async () => {
    const bv = bvSong({ neteaseId: 111 })
    musicApi.getLyrics.mockResolvedValue({ lyrics: [{ time: 1, text: '错词' }] })
    aiApi.verifyLyric
      .mockResolvedValueOnce({ ok: false }) // 111 词源判否
      .mockResolvedValue({ ok: true })      // 解绑后外源词源过审
    musicApi.retryMatch.mockResolvedValue(null)
    musicApi.getExternalLyric.mockResolvedValue({
      lrc: '[00:01.00]外源词', source: 'lrclib', extId: 'lrclib_7', synced: true,
    })
    parseLyrics.mockImplementation(() => [{ time: 1, text: '外源词' }])
    const { player } = makePlayer()
    await player.playSong(bv)
    await vi.waitFor(() => expect(bv.neteaseId).toBeNull())
    // 解绑热重载走外源支：命中词照常落屏、词属主键挂 extId
    await vi.waitFor(() =>
      expect(player.lyrics.value).toEqual([{ time: 1, text: '外源词' }]))
    expect(downloadsApi.getSongMeta).toHaveBeenCalledWith('lrclib_7')
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
      expect(aiApi.verifyLyric).toHaveBeenCalledWith(222, '视频标题', 'UP主', expect.anything(), 'bv_BV1xx411c7mD', undefined))
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

  it('行菜单换绑捎 matched 回包（第 4 参）：正播对象 name/al/证据经 applyMatchResult 整组重建', async () => {
    const { notifyLyricRematch } = await import('../../src/composables/usePlayer.js')
    // 正播侧对象带着错配烘进的脏 name/al——菜单侧那份已 applyMatchResult
    // 整组修好，本侧异引用对象要靠捎来的 matched 回包走同一修复器
    const bv = bvSong({ neteaseId: 111, name: '乐园(粤)', al: { id: 99, name: '脏专辑' } })
    musicApi.getLyrics.mockResolvedValue({ lyrics: [{ time: 1, text: 'x' }] })
    const { player } = makePlayer()
    await player.playSong(bv)
    await vi.waitFor(() => expect(musicApi.getLyrics).toHaveBeenCalledWith(111, expect.anything()))
    musicApi.getLyrics.mockClear()
    // matchedBy/score 是回包同层平铺字段（SongList 调用点用法）
    const matched = {
      id: 333, name: '对的歌', matchedBy: 'manual', score: 0.9,
      ar: [{ name: 'UP主' }], al: { id: 9, name: '对的专辑', picUrl: 'http://n/9.jpg' },
    }
    notifyLyricRematch('bv_BV1xx411c7mD', 333, 111, matched)
    await vi.waitFor(() => expect(musicApi.getLyrics).toHaveBeenCalledWith(333, null))
    // 艺人重合（bilibili.author='UP主' ∈ matched.ar）→ name/al/证据整组采纳
    expect(bv.neteaseId).toBe(333)
    expect(bv.name).toBe('对的歌')
    expect(bv.al.name).toBe('对的专辑')
    expect(bv.al.id).toBe(9)
    expect(bv.bilibili.matchedBy).toBe('manual')
    expect(bv.bilibili.matchScore).toBe(0.9)
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

  it('retryMatch 撞 429 限流：同 abort 列释放 rematch 槽位，重播同曲可再试并换绑', async () => {
    const bv = bvSong({ neteaseId: 111 })
    musicApi.getLyrics.mockResolvedValue({ lyrics: [{ time: 1, text: '错词' }] })
    aiApi.verifyLyric
      .mockResolvedValueOnce({ ok: false }) // 111 判否（vkey 落缓存——重播不重打 verify）
      .mockResolvedValue({ ok: true })      // 换绑后 222 过审
    musicApi.retryMatch
      .mockRejectedValueOnce({ response: { status: 429 } }) // 限流「稍后再试」不烧槽位
      .mockResolvedValue({ id: 222, name: '对的歌', ar: [], al: {} })
    const { player } = makePlayer()
    await player.playSong(bv)
    await vi.waitFor(() => expect(musicApi.retryMatch).toHaveBeenCalledTimes(1))
    await new Promise(r => setTimeout(r, 0)) // 让 catch 的槽位释放跑完
    await player.playSong(song(2))
    await player.playSong(bv) // 槽位已释放：判否缓存即刻生效，再发 retry 换绑成功
    await vi.waitFor(() => expect(bv.neteaseId).toBe(222))
    expect(musicApi.retryMatch).toHaveBeenCalledTimes(2)
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
      expect(aiApi.verifyLyric).toHaveBeenCalledWith('lrclib_9', '视频标题', 'UP主', expect.anything(), 'bv_BV1xx411c7mD', undefined))
    await vi.waitFor(() => expect(player.lyrics.value).toEqual([]))
    expect(toast).toHaveBeenCalledWith('歌词与歌曲疑似不匹配，已隐藏', 'info')
    // 判否对象是外源词源（lrclib_9 非 neteaseId）——不走换绑否决记账，
    // 但词已藏、曲仍裸着：rematchUnbound 首配兜底接管把歌接上匹配链
    await vi.waitFor(() => expect(musicApi.retryMatch).toHaveBeenCalledTimes(1))
    const payload = musicApi.retryMatch.mock.calls[0][0]
    expect(payload).toMatchObject({ trackId: 'bv_BV1xx411c7mD', title: '视频标题', author: 'UP主' })
    expect(payload.excludeIds ?? []).not.toContain('lrclib_9')
  })

  it('裸 yt_ 老行（无 provider 块）绑后词源：核验材料回退曲面 name/ar', async () => {
    const yt = song('yt_abcdefghijk', { neteaseId: 111 }) // 裸 id——youtube 块缺席
    musicApi.getLyrics.mockResolvedValue({ lyrics: [{ time: 1, text: '嫁接词' }] })
    const { player } = makePlayer()
    await player.playSong(yt)
    // provider 块缺席不等于豁免核验——hydrateMatchBinding 补绑的嫁接词同
    // 样过归属判定；材料回退 song.name + ar 拼名（裸 yt_ 的
    // externalArtistName 回 null）
    await vi.waitFor(() =>
      expect(aiApi.verifyLyric).toHaveBeenCalledWith(
        111, '歌yt_abcdefghijk', '艺人', expect.anything(), 'yt_abcdefghijk', undefined))
  })

  it('判否换绑并入菜单显式否决簿：已否词源不进 retryMatch 候选', async () => {
    const { notifyLyricRematch } = await import('../../src/composables/usePlayer.js')
    const bv = bvSong({ neteaseId: 111 })
    musicApi.getLyrics.mockResolvedValue({ lyrics: [{ time: 1, text: '词' }] })
    const { player } = makePlayer()
    await player.playSong(bv) // 111 词源过审（默认 verify ok:true）
    // 行菜单换绑 111→555 并捎否 999（簿按 trackId 记账，正播同曲触发热重载）
    notifyLyricRematch('bv_BV1xx411c7mD', 555, 999)
    aiApi.verifyLyric.mockResolvedValue({ ok: false }) // 新词源 555 被判否
    await vi.waitFor(() => expect(musicApi.retryMatch).toHaveBeenCalled())
    // 判否累积集（555）∪ 菜单否决簿（999，String 记账）——显式否决不复活
    expect(musicApi.retryMatch.mock.calls[0][0].excludeIds)
      .toEqual(expect.arrayContaining([555, '999']))
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
    expect(musicApi.getMatchState).not.toHaveBeenCalled() // 已绑定曲水合闸早退
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
    expect(musicApi.getMatchState).not.toHaveBeenCalled() // 纯曲库 id 不过水合形闸
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
    // 必须并进 excludeIds，否则确定性高分原样复活（簿内 String 记账）
    await vi.waitFor(() => expect(musicApi.retryMatch).toHaveBeenCalledTimes(1))
    expect(musicApi.retryMatch.mock.calls[0][0].excludeIds).toEqual(['111'])
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
    expect(ids).toEqual(expect.arrayContaining(['111', '333']))
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
    expect(musicApi.retryMatch.mock.calls[0][0].excludeIds).toEqual(['111'])
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
        'lrclib_5', 'sasayakuを歌いました', 'rei sirose - Topic', expect.anything(), 'yt_abcdefghijk', undefined))
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

  // ── hydrateMatchBinding：本地未绑但服务端 song_match 有正绑 → 水合落回
  //    网易词支。少女レイ ver.EMA 实案：服务端绑 2068956580（44 行官方译
  //    文），客户端 raw_json.neteaseId=undefined 却在播无译文 lrclib 词 ──
  it('match/state 回正绑：水合 neteaseId 落回网易词支，外源级联与首配都不触发', async () => {
    const yt = ytUnbound() // 客户端 neteaseId 缺席（未水合的持久化行形态）
    musicApi.getMatchState.mockResolvedValue({
      id: 2068956580, name: '少女レイ', matchedBy: 'title+artist', score: 0.92,
      ar: [{ name: 'EMA' }], al: { id: 9, name: '专', picUrl: 'http://n/9.jpg' },
    })
    musicApi.getLyrics.mockResolvedValue({ lyrics: [{ time: 1, text: '网易词' }] })
    const { player, deps } = makePlayer()
    await player.playSong(yt)
    // 读口先于外源支被问（每曲一次，signal 透传）
    expect(musicApi.getMatchState).toHaveBeenCalledWith('yt_abcdefghijk', expect.anything())
    // 绑定是持久属性：applyMatchResult 整组重建 + 显式落盘
    expect(yt.neteaseId).toBe(2068956580)
    expect(yt.youtube.matchedBy).toBe('title+artist')
    expect(yt.youtube.matchScore).toBe(0.92)
    expect(deps.savePlaylistsToStorage).toHaveBeenCalled()
    // 谓词翻正 → 常规网易词支；外源级联与首配兜底都不该再跑
    expect(musicApi.getLyrics).toHaveBeenCalledWith(2068956580, expect.anything())
    expect(player.lyrics.value).toEqual([{ time: 1, text: '网易词' }])
    expect(musicApi.getExternalLyric).not.toHaveBeenCalled()
    expect(musicApi.retryMatch).not.toHaveBeenCalled()
    expect(toast).not.toHaveBeenCalledWith('词源已自动重匹配', 'success') // 静默自愈
  })

  it('match/state 回 null：照旧走外源级联；每曲每会话只查一次（重播不重查）', async () => {
    const yt = ytUnbound()
    const { player } = makePlayer()
    await player.playSong(yt)
    await vi.waitFor(() => expect(musicApi.getExternalLyric).toHaveBeenCalledTimes(1))
    expect(musicApi.getMatchState).toHaveBeenCalledTimes(1)
    expect(yt.neteaseId).toBeUndefined() // match=null 不留痕，曲对象一字不写
    // 同曲重播：槽位已消费——外源照打但读口不再发（幂等读也防刷）
    await player.playSong(song(2))
    await player.playSong(yt)
    await vi.waitFor(() => expect(musicApi.getExternalLyric).toHaveBeenCalledTimes(2))
    expect(musicApi.getMatchState).toHaveBeenCalledTimes(1)
  })

  it('match/state 抛错（网络/abort 类）：静默吞，外源支照常接管词路', async () => {
    musicApi.getMatchState.mockRejectedValue(new Error('network down'))
    const yt = ytUnbound()
    const { player } = makePlayer()
    await player.playSong(yt)
    await vi.waitFor(() => expect(musicApi.getExternalLyric).toHaveBeenCalledTimes(1))
    expect(yt.neteaseId).toBeUndefined()
    expect(player.playbackError.value).toBe('')
  })

  it('水合 RTT 窗内被别路补绑：读口回包不覆写显式选择', async () => {
    const yt = ytUnbound()
    let releaseState
    musicApi.getMatchState.mockImplementation(
      () => new Promise(r => { releaseState = () => r({ id: 222, name: '读口回来的歌' }) }))
    // 补绑的 555 有词——不进绑后词空的外源兜底支
    musicApi.getLyrics.mockResolvedValue({ lyrics: [{ time: 1, text: 'x' }] })
    const { player } = makePlayer()
    const p = player.playSong(yt)
    await vi.waitFor(() => expect(musicApi.getMatchState).toHaveBeenCalled())
    yt.neteaseId = 555 // RTT 窗内菜单换绑等别路已补绑——显式选择优先
    releaseState()
    await p
    expect(yt.neteaseId).toBe(555)
    expect(yt.name).toBe('歌yt_abcdefghijk') // applyMatchResult 未跑——name 不被覆写
    expect(musicApi.getLyrics).toHaveBeenCalledWith(555, expect.anything())
    expect(musicApi.getExternalLyric).not.toHaveBeenCalled()
  })

  it('显式解绑后 match/state 回同一否决 id：水合不复活用户纠正（S1 回归）', async () => {
    const { notifyLyricRematch } = await import('../../src/composables/usePlayer.js')
    const bv = bvSong({ neteaseId: 111 })
    musicApi.getLyrics.mockResolvedValue({ lyrics: [{ time: 1, text: 'x' }] })
    const { player, deps } = makePlayer()
    await player.playSong(bv)
    await vi.waitFor(() => expect(musicApi.getLyrics).toHaveBeenCalledWith(111, expect.anything()))
    deps.savePlaylistsToStorage.mockClear()
    // 服务端 song_match 旧正行仍存活（retry 传输失败不落负行）——读口
    // 会把刚否决的 111 原样送回；不查否决簿等于静默绑回
    musicApi.getMatchState.mockResolvedValue({ id: 111, name: '错配歌', ar: [], al: {} })
    // 菜单「重新匹配歌词」空回包 → 解绑：prevId 捎进否决簿，热重载触水合
    notifyLyricRematch('bv_BV1xx411c7mD', null, 111)
    // 热重载走 loadLyrics（无 signal——与换绑热重载同口径）触发水合读口
    await vi.waitFor(() =>
      expect(musicApi.getMatchState).toHaveBeenCalledWith('bv_BV1xx411c7mD', null))
    await vi.waitFor(() => expect(musicApi.getExternalLyric).toHaveBeenCalled()) // 走完外源支再断言
    await new Promise(r => setTimeout(r, 0))
    expect(bv.neteaseId).toBeNull() // 否决闸拦下——不被水合复活
    expect(bv.name).toBe('歌bv_BV1xx411c7mD') // applyMatchResult 未跑——name 不被覆写
    // 唯一一次落盘是 onLyricRematch 的解绑写——水合否决不另写持久化
    expect(deps.savePlaylistsToStorage).toHaveBeenCalledTimes(1)
  })

  it('判否解绑后 match/state 回同一判否 id：水合不复活判否词源（判否簿闸）', async () => {
    // 判否否决记 rematchTried（不是 matchVetoedIds）——上例只钉了菜单簿；
    // 本例走 F3 镜像解绑使 neteaseId==null、水合变可达，正行残存窗口
    // （mergeVetoed fail-soft/旧服务端无否决簿）读口把刚判否的 111 原样送回
    const bv = bvSong({ neteaseId: 111 })
    musicApi.getLyrics.mockResolvedValue({ lyrics: [{ time: 1, text: '错词' }] })
    aiApi.verifyLyric.mockResolvedValue({ ok: false })
    musicApi.retryMatch.mockResolvedValue(null) // 判否换绑 miss → 镜像解绑
    musicApi.getMatchState.mockResolvedValue({ id: 111, name: '错配歌', ar: [], al: {} })
    const { player } = makePlayer()
    await player.playSong(bv)
    // 解绑热重载 → 水合读口被问（neteaseId 已空、形闸过）——回的恰是判否 id
    await vi.waitFor(() =>
      expect(musicApi.getMatchState).toHaveBeenCalledWith('bv_BV1xx411c7mD', expect.anything()))
    // 判否簿闸拦下后走外源兜底 → 级联 rematchUnbound 第二发（111 仍记账）
    await vi.waitFor(() => expect(musicApi.retryMatch).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(musicApi.getExternalLyric).toHaveBeenCalled())
    await new Promise(r => setTimeout(r, 0))
    expect(bv.neteaseId).toBeNull()      // 判否簿拦下——不被水合复活回 111
    expect(bv.name).toBe('视频标题')      // applyMatchResult(null) 洗的 provider 态未被覆写
    expect(musicApi.getLyrics).toHaveBeenCalledTimes(1) // 不曾为复活的 111 重打词
  })

  it('match/state 在途被 abort（ERR_CANCELED）：释放水合槽位，重播同曲再查', async () => {
    const yt = ytUnbound()
    // signal 随切歌/看门狗 abort 时 axios 的真实表现：reject CanceledError
    // （与首配/换绑两支同款写法）——槽位是「下次播放再水合」的机会，
    // RTT 窗内切歌不该烧掉它
    musicApi.getMatchState.mockRejectedValue(
      Object.assign(new Error('canceled'), { name: 'CanceledError', code: 'ERR_CANCELED' }))
    const { player } = makePlayer()
    await player.playSong(yt)
    await vi.waitFor(() => expect(musicApi.getMatchState).toHaveBeenCalledTimes(1))
    await new Promise(r => setTimeout(r, 0)) // 让 catch 的槽位释放跑完
    await player.playSong(song(2))
    await player.playSong(yt) // 槽位已释放——重播再问一次读口
    await vi.waitFor(() => expect(musicApi.getMatchState).toHaveBeenCalledTimes(2))
  })

  it('match/state 非 abort/限流失败（502 等）：槽位保留，同会话不再重查', async () => {
    const yt = ytUnbound()
    // 服务端故障类错误：保留记账——否则每播一次同曲都刷一次读口限流桶
    musicApi.getMatchState.mockRejectedValue(
      Object.assign(new Error('boom'), { response: { status: 502 } }))
    const { player } = makePlayer()
    await player.playSong(yt)
    await vi.waitFor(() => expect(musicApi.getMatchState).toHaveBeenCalledTimes(1))
    await player.playSong(song(2))
    await player.playSong(yt)
    await new Promise(r => setTimeout(r, 0))
    expect(musicApi.getMatchState).toHaveBeenCalledTimes(1)
  })

  it('裸 yt_ id（无 provider 对象的老行）：形态闸同走水合读口', async () => {
    const yt = song('yt_abcdefghijk') // 持久化行只剩 id 形态——按前缀命中
    const { player } = makePlayer()
    await player.playSong(yt)
    await vi.waitFor(() =>
      expect(musicApi.getMatchState).toHaveBeenCalledWith('yt_abcdefghijk', expect.anything()))
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

  it('manualFetchLyrics 命中：行集落地 + extId 词属主键 + 源名 toast；非 custom 曲检索料取 provider 原标题', async () => {
    const { player } = makePlayer()
    await player.playSong(bvSong()) // 自动支 mock 归 null → 空词
    howls.at(-1).fire('onload') // 切歌锁在 onload 才松——手动支有 songSwitching 闸
    expect(player.lyrics.value).toEqual([])

    parseLyrics.mockImplementation(() => [{ time: 1, text: '外源词' }])
    musicApi.getExternalLyric.mockResolvedValue({
      lrc: '[00:01.00]外源词', source: 'lrclib', extId: 'lrclib_42', synced: true,
    })
    await player.manualFetchLyrics()
    // 非 custom：song.name 不是手改名（可能是错配烘进的污染名）——provider
    // 原标题优先，artist 用 ext.author
    expect(musicApi.getExternalLyric).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: 'bv_BV1xx411c7mD', title: '视频标题', artist: 'UP主', durationSec: 200,
      }))
    expect(player.lyrics.value).toEqual([{ time: 1, text: '外源词' }])
    expect(downloadsApi.getSongMeta).toHaveBeenCalledWith('lrclib_42')
    expect(toast).toHaveBeenCalledWith('已从 LRCLIB 获取歌词', 'success')
    expect(player.lyricFetching.value).toBe(false)
  })

  it('manualFetchLyrics 检索料序 custom 分家：手改名曲 song.name 优先，裸 id 行 name 兜底', async () => {
    const { player } = makePlayer()
    // custom=true 才是「SongFormDialog 手改过名」的真信号——手改曲保留
    // song.name 优先的设计意图
    await player.playSong(bvSong({ custom: true }))
    howls.at(-1).fire('onload')
    await player.manualFetchLyrics()
    expect(musicApi.getExternalLyric).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'bv_BV1xx411c7mD', title: '歌bv_BV1xx411c7mD' }))
    // provider 块缺席的裸 bv_ 老行：非 custom 且 extTitle 空——name 兜底照旧
    await player.playSong(song('bv_BV2xx411c7mE'))
    howls.at(-1).fire('onload')
    await player.manualFetchLyrics()
    expect(musicApi.getExternalLyric).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'bv_BV2xx411c7mE', title: '歌bv_BV2xx411c7mE' }))
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

describe('usePlayer：手动绑定词支（loadLyrics 置顶覆盖层）', () => {
  const bvSong = (extra) => song('bv_BV1xx411c7mD', {
    bilibili: { bvid: 'BV1xx411c7mD', title: '视频标题', author: 'UP主' },
    ...extra,
  })

  it('读口命中压过自动链：已绑 neteaseId 的曲也直落手动词，网易/外源腿全不发', async () => {
    parseLyrics.mockImplementation(() => [{ time: 1, text: '手挑词' }])
    musicApi.getManualLyric.mockResolvedValue({
      lrc: '[00:01.00]手挑词', source: 'kugou', extId: 'kugou_9', synced: true,
    })
    const { player } = makePlayer()
    // neteaseId 在场——手动支缺席时本曲必走 getLyrics(99) 网易词腿
    await player.playSong(bvSong({ neteaseId: 99 }))
    expect(player.lyrics.value).toEqual([{ time: 1, text: '手挑词' }])
    expect(musicApi.getManualLyric).toHaveBeenCalledWith('bv_BV1xx411c7mD', expect.anything())
    expect(musicApi.getLyrics).not.toHaveBeenCalled()     // 网易词腿没走
    expect(musicApi.getQQLyric).not.toHaveBeenCalled()
    expect(musicApi.getExternalLyric).not.toHaveBeenCalled() // 外源级联没走
    expect(downloadsApi.getSongMeta).toHaveBeenCalledWith('kugou_9') // 词属主键挂 extId
  })

  it('读口归 null（404 在 api 层已归一）落回既有自动链：绑定曲走 netease 腿', async () => {
    musicApi.getManualLyric.mockResolvedValue(null)
    musicApi.getLyrics.mockResolvedValue({ lyrics: [{ time: 1, text: '网易词' }] })
    const { player } = makePlayer()
    await player.playSong(bvSong({ neteaseId: 99 }))
    expect(musicApi.getManualLyric).toHaveBeenCalledWith('bv_BV1xx411c7mD', expect.anything())
    expect(musicApi.getLyrics).toHaveBeenCalledWith(99, expect.anything())
    expect(musicApi.getExternalLyric).not.toHaveBeenCalled()
    expect(player.lyrics.value).toEqual([{ time: 1, text: '网易词' }])
  })

  it('读口在途被切歌顶替：晚到的手动绑定回包不写新歌界面（stale 闸）', async () => {
    let release
    musicApi.getManualLyric.mockImplementation((id) =>
      String(id).startsWith('bv_') ? new Promise(r => { release = r }) : Promise.resolve(null))
    const { player } = makePlayer()
    const p = player.playSong(bvSong())
    await new Promise(r => setTimeout(r, 0)) // 让 A 代读口确实发出（release 赋值）
    await player.playSong(song(2)) // 切歌：abort 旧 signal + lyricLoadSeq 升号
    howls.at(-1).fire('onload')
    parseLyrics.mockImplementation(() => [{ time: 1, text: '晚到词' }])
    release({ lrc: '[00:01.00]晚到词', source: 'lrclib', extId: 'lrclib_9', synced: true })
    await p
    await new Promise(r => setTimeout(r, 0))
    expect(player.lyrics.value).toEqual([]) // song(2) 的空词态没被晚到回包盖掉
  })

  it('手动词落地段抛错：归空词终态不冒 playbackError（词务故障≠播放失败）', async () => {
    musicApi.getManualLyric.mockResolvedValue({
      lrc: '[00:01.00]x', source: 'lrclib', extId: 'lrclib_5', synced: true,
    })
    // applyExternalLyricHit 内部抛错（行集解析故障）——修前会冒到 playSong
    // 的 catch 被写成「播放请求失败」playbackError
    parseLyrics.mockImplementation(() => { throw new Error('parse boom') })
    const { player } = makePlayer()
    await player.playSong(bvSong())
    expect(player.playbackError.value).toBe('')
    expect(player.lyrics.value).toEqual([])
    expect(player.loadingLyrics.value).toBe(false)
  })

  it('手动命中跳 AI 归属核验（用户显式选定不吃否决），翻译腿照常跑', async () => {
    aiApi.status.mockResolvedValue({ enabled: true })
    parseLyrics.mockImplementation(() => [{ time: 1, text: 'line one' }])
    musicApi.getManualLyric.mockResolvedValue({
      lrc: '[00:01.00]line one', source: 'lrclib', extId: 'lrclib_5', synced: true,
    })
    const { player } = makePlayer()
    // bv_ 形态曲——postProcess ①的归属核验腿本会打 /ai/lyric-verify；
    // 用户显式挑的词不许被 AI 否决藏掉，核验腿跳过、翻译腿照常
    await player.playSong(bvSong())
    await vi.waitFor(() => expect(aiApi.translateLyric).toHaveBeenCalledWith('lrclib_5'))
    expect(aiApi.verifyLyric).not.toHaveBeenCalled()
  })
})

describe('usePlayer：AI 自动翻译的中文语境闸（isLikelyChineseLyric）', () => {
  // 病灶 B 回归：旧 lyricCjkDominant 只看 cjk/(cjk+other)≥0.3——日文词
  // 汉字密度 30-50% 是常态，被误判「中文语境」跳过翻译（少女レイ实案）。
  // 共享判定里假名/谚文在场即「需要翻译」硬证据
  it('日文汉字+假名混排词不再误判中文语境：假名硬证据放行翻译', async () => {
    aiApi.status.mockResolvedValue({ enabled: true })
    // 汉字占比 ~0.4 的日文词——旧占比闸会误判跳翻，新判定见假名即放行
    musicApi.getLyrics.mockResolvedValue({
      lyrics: [
        { time: 1, text: '少女レイのような' },
        { time: 4, text: '透明な声で歌う' },
      ],
    })
    const { player } = makePlayer()
    await player.playSong(song(7))
    await vi.waitFor(() => expect(aiApi.translateLyric).toHaveBeenCalledWith(7))
  })

  it('纯中文词仍跳过翻译：汉字高占比且无假名/谚文 → already-zh 语境', async () => {
    aiApi.status.mockResolvedValue({ enabled: true })
    musicApi.getLyrics.mockResolvedValue({
      lyrics: [
        { time: 1, text: '我们隔着屏幕相望' },
        { time: 4, text: '把思念唱成一首歌' },
      ],
    })
    const { player } = makePlayer()
    await player.playSong(song(7))
    // postProcess 确实跑过（status 问过）但闸拦在 translate 前
    await vi.waitFor(() => expect(aiApi.status).toHaveBeenCalled())
    await new Promise(r => setTimeout(r, 0))
    expect(aiApi.translateLyric).not.toHaveBeenCalled()
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

  // L9 另一处轮询：downloadCurrentSong 终态轮询——data 缺省的 200 回包
  // 与抛错同计失联（旧口径进 catch 旁路重置 pollErrors=0，失联轮空转）
  it('终态轮询回 200 但 data 缺省：同计失联，3 次收束「仍在进行」', async () => {
    const { player, deps } = makePlayer()
    deps.selectedPlaylist.value = { id: 777 }
    await player.playSong(song(7))
    downloadsApi.downloadSongToServer.mockImplementation(async () => ({ data: { status: 'pending' } }))
    // 清掉 playSong 主链探测的一次调用——计数只钉终态轮询段
    downloadsApi.getSongDownloadStatus.mockClear()
    downloadsApi.getSongDownloadStatus.mockResolvedValue({}) // 200 壳无 data
    const p = player.downloadCurrentSong()
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('已加入下载队列', 'info'))
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith('下载仍在后台进行中，可稍后在下载页里查看结果', 'info'),
      { timeout: 10000 })
    await p
    expect(player.songDownloading.value).toBe(false)
    // 恰好 3 次缺省即收——不空轮撑满 3min deadline
    expect(downloadsApi.getSongDownloadStatus).toHaveBeenCalledTimes(3)
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

  // 远端单的本地追加曲只落 addedTracks 不落 tracks（上游曲目表没有它们）——
  // 成员预检两表并查才算命中；数字单直提不镜像，曲对象随 track 载荷下发，
  // 服务端枚举成员前增量补行才认得出这个上游没有的成员
  it('yt_ 追加曲在归属远端单 addedTracks：数字单直提且 body 带 track', async () => {
    const yt = song('yt_abcdefghijk', { youtube: { videoId: 'abcdefghijk' } })
    const plR = { id: 888, name: 'R', tracks: [song(5)], addedTracks: [yt] }
    const { player, deps } = makePlayer()
    deps.userPlaylists.value = [plR]
    deps.selectedPlaylist.value = plR
    await player.playSong(yt) // playingPlaylistId=888——queueOwner 即远端库行
    await player.downloadCurrentSong()
    // 成员预检命中 addedTracks——旧口径只查 tracks 会误报「不在任何歌单」
    expect(toast).not.toHaveBeenCalledWith(expect.stringContaining('不在任何歌单'), expect.anything())
    expect(downloadsApi.mirrorLocalPlaylist).not.toHaveBeenCalled()
    expect(downloadsApi.downloadSongToServer).toHaveBeenCalledWith(
      888, 'yt_abcdefghijk', expect.objectContaining({ track: yt }))
    expect(toast).toHaveBeenCalledWith('下载成功', 'success')
  })

  // 顶替寻址同款：队列插入曲只在别单 addedTracks 命中——扫到数字单顶替，
  // 提交同样要带 track（服务端曲目表里没有这个本地追加成员）
  it('队列插入曲仅命中别单 addedTracks：顶替寻址到数字单，提交带 track', async () => {
    const plR = { id: 888, name: 'R', tracks: [song(5)], addedTracks: [song(99)] }
    const { player } = await queueInsertedDownload(plR)
    await player.downloadCurrentSong()
    expect(downloadsApi.mirrorLocalPlaylist).not.toHaveBeenCalled()
    expect(downloadsApi.downloadSongToServer).toHaveBeenCalledWith(
      888, 99, expect.objectContaining({ track: expect.objectContaining({ id: 99 }) }))
    expect(toast).toHaveBeenCalledWith('下载成功', 'success')
  })

  // queueOwner 缺 tracks 键是远端库行的持久化常态形态（持久化剥 tracks
  // 只留 addedTracks 等壳字段）——成员预检的 Array.isArray 守卫对缺表行
  // 放行：缺表只能证成员不能否成员，曲可能是上游成员（服务端有全表），
  // 交服务端成员校验兜底；若守卫失效去扫兜底单，曲查无落点会误报早退
  it('queueOwner 无 tracks 键（持久化剥壳形态）：预检放行，track 正常下发', async () => {
    const x = song(99)
    const plR = { id: 888, name: 'R', addedTracks: [song(5)] } // 无 tracks 键
    const { player, deps } = makePlayer()
    deps.userPlaylists.value = [plR]
    deps.selectedPlaylist.value = plR
    await player.playSong(x) // playingPlaylistId=888——queueOwner 命中剥壳行
    await player.downloadCurrentSong()
    // 守卫放行直提交：「不在任何歌单」早退是预检误伤路径
    expect(toast).not.toHaveBeenCalledWith(expect.stringContaining('不在任何歌单'), expect.anything())
    expect(downloadsApi.mirrorLocalPlaylist).not.toHaveBeenCalled()
    expect(downloadsApi.downloadSongToServer).toHaveBeenCalledWith(
      888, 99, expect.objectContaining({ track: expect.objectContaining({ id: 99 }) }))
    expect(toast).toHaveBeenCalledWith('下载成功', 'success')
  })

  it('镜像形态归属（local_pl_）：提交不带 track——镜像已承载全表', async () => {
    const { player, deps } = makePlayer()
    const t = song(7)
    deps.userPlaylists.value = [localPl(t)]
    deps.selectedPlaylist.value = localPl(t)
    await player.playSong(t) // playingPlaylistId=local_pl_1
    await player.downloadCurrentSong()
    expect(downloadsApi.mirrorLocalPlaylist).toHaveBeenCalledWith(localPl(t))
    expect(downloadsApi.downloadSongToServer).toHaveBeenCalledWith(
      'local_pl_1', 7, expect.not.objectContaining({ track: expect.anything() }))
  })
})

// ═══ 评审回归（F1–F6 中项 + 轻项 L7/L9/L10/L11/L13/L15）═══
describe('usePlayer：F1 continueWithRelated 代次闸与在途去重', () => {
  it('同代连入合流一票；换代后旧票落地被弃，新票按新曲艺人另立种子', async () => {
    const a = song(1)
    const b = song(2, { ar: [{ name: '甲' }] }) // 种子取当前播放曲的艺人——队尾是 b
    const { player, deps } = makePlayer({ songs: [a, b] })
    player.autoplayOn.value = true
    await player.playSong(a)
    await player.playSong(b, { preserveContext: true }) // 队列=[a,b]，b 为队尾
    const resolvers = []
    musicApi.searchSongs.mockImplementation(() => new Promise(r => resolvers.push(r)))

    howls.at(-1).fire('onend') // 队尾自然播完 → continueWithRelated 票1
    expect(musicApi.searchSongs).toHaveBeenCalledTimes(1)
    expect(musicApi.searchSongs.mock.calls[0][0]).toBe('甲')
    howls.at(-1).fire('onend') // 同代第二入口合流——仍一票，不双发
    expect(musicApi.searchSongs).toHaveBeenCalledTimes(1)

    // 换代：重拍队列成 [c] 并播它——旧票种子（甲）属旧曲，不得收养进新代
    const c = song(3, { ar: [{ name: '乙' }] })
    deps.filteredSongs.value = [c]
    await player.playSong(c)
    howls.at(-1).fire('onend') // 新代队尾 → 另立新票新种子
    expect(musicApi.searchSongs).toHaveBeenCalledTimes(2)
    expect(musicApi.searchSongs.mock.calls[1][0]).toBe('乙')

    // 旧票晚到落地：代次闸丢弃——队列/实例皆不动，也不误收 stopAtQueueEnd
    const howlCount = howls.length
    resolvers[0]([song(50), song(51)])
    await new Promise(r => setTimeout(r, 0))
    expect(player.playingSongs.value.map(s => s.id)).toEqual([3])
    expect(howls).toHaveLength(howlCount)

    // 新票落地：pushTail+playSong 照常续播
    resolvers[1]([song(60)])
    await vi.waitFor(() =>
      expect(player.playingSongs.value.map(s => s.id)).toEqual([3, 60]))
    expect(player.currentSong.value.id).toBe(60)
  })

  it('RTT 窗内切歌（换代）：旧票落地被代次闸弃，不劫持新队列复活出声', async () => {
    const a = song(1, { ar: [{ name: '甲' }] })
    const { player, deps } = makePlayer({ songs: [a] })
    player.autoplayOn.value = true
    await player.playSong(a)
    let release
    musicApi.searchSongs.mockImplementation(() => new Promise(r => { release = r }))
    howls.at(-1).fire('onend')
    expect(musicApi.searchSongs).toHaveBeenCalledTimes(1)

    const c = song(9)
    deps.filteredSongs.value = [c]
    await player.playSong(c) // 换代——旧票 seq 失配
    const howlCount = howls.length
    release([song(70)])
    await new Promise(r => setTimeout(r, 0))
    // 落地被弃：队列仍 [9]、无新实例、当前曲不被拉回
    expect(player.playingSongs.value.map(s => s.id)).toEqual([9])
    expect(howls).toHaveLength(howlCount)
    expect(player.currentSong.value.id).toBe(9)
  })

  it('bv_ 种曲接续走 relatedFetch 同源口径：打相似接口而非艺人搜', async () => {
    // 与 WatchView 相关面板同一分派（lib/related.js）——B 站曲队列播完续的
    // 是上游相似稿，不是拿 UP 主名去搜网易云曲库
    const a = song('bv_BV1xx411c7XE', { bilibili: { bvid: 'BV1xx411c7XE' } })
    const { player } = makePlayer({ songs: [a] })
    player.autoplayOn.value = true
    await player.playSong(a)
    musicApi.getBiliRelated.mockResolvedValue({ items: [
      // 上游回包混种曲本体（bvid 同）——relatedFetch 内剔除后只剩真相关
      { bvid: 'BV1xx411c7XE', title: '本体', owner: 'u', duration: 60, cover: '' },
      { bvid: 'BV9yy511d7YF', title: '相关稿', owner: 'v', duration: 60, cover: '' },
    ] })
    howls.at(-1).fire('onend')
    await vi.waitFor(() => expect(musicApi.getBiliRelated).toHaveBeenCalledWith('BV1xx411c7XE'))
    expect(musicApi.searchSongs).not.toHaveBeenCalled()
    await vi.waitFor(() =>
      expect(player.playingSongs.value.map(s => s.id)).toEqual(['bv_BV1xx411c7XE', 'bv_BV9yy511d7YF']))
    expect(player.currentSong.value.id).toBe('bv_BV9yy511d7YF')
  })

  it('缺料曲（无艺人 file_）接续落停止分支——relatedFetch null 不假造相关', async () => {
    const a = song('file_abcd1234', { ar: [] })
    const { player } = makePlayer({ songs: [a] })
    player.autoplayOn.value = true
    await player.playSong(a)
    howls.at(-1).fire('onload')
    howls.at(-1).fire('onplay')
    expect(player.isPlaying.value).toBe(true)
    howls.at(-1).fire('onend')
    await new Promise(r => setTimeout(r, 0))
    expect(musicApi.searchSongs).not.toHaveBeenCalled()
    expect(player.isPlaying.value).toBe(false) // 真停止收尾，不是挂起
  })
})

describe('usePlayer：F2 restoreUiState 副作用', () => {
  it('远端音量落到活跃 Howl 实例（ref+实例双写），越界钳 0-100', async () => {
    const { player } = makePlayer({ songs: [song(1)] })
    await player.playSong(song(1))
    player.restoreUiState({ volume: 33 })
    expect(player.volume.value).toBe(33)
    expect(howls[0]._vol).toBeCloseTo(0.33) // 只写 ref 的旧病灶=界面 33 实例 80 两张皮
    player.restoreUiState({ volume: 1e999 }) // 脏数据不炸 howl.volume
    expect(player.volume.value).toBe(33)
  })

  it('远端置 shuffleOn：与 toggleShuffle 同构真重排——当前曲锚队首、复位还原原序', async () => {
    const list = [song(1), song(2), song(3), song(4)]
    const { player } = makePlayer({ songs: list })
    await player.playSong(list[0]) // 原序 [1,2,3,4]
    player.restoreUiState({ shuffleOn: true })
    expect(player.shuffleOn.value).toBe(true)
    const ids = player.playingSongs.value.map(s => s.id)
    expect(ids[0]).toBe(1) // 当前曲锚定队首（与 toggleShuffle 同口径）
    expect(new Set(ids)).toEqual(new Set([1, 2, 3, 4]))
    player.restoreUiState({ shuffleOn: false }) // 复位还的是原序备份
    expect(player.playingSongs.value.map(s => s.id)).toEqual([1, 2, 3, 4])
    expect(player.shuffleOn.value).toBe(false)
  })
})

describe('usePlayer：F3 悬挂词务锁终态补清', () => {
  it('无 URL 早退：旧代 lyricFetching 残余被补清，工具条不卡死', async () => {
    const { player } = makePlayer()
    await player.playSong(song(1))
    howls.at(-1).fire('onload')
    // 旧代手动词务永不 settle——锁持着（复现病灶：新代早退不清锁）
    musicApi.getExternalLyric.mockImplementation(() => new Promise(() => {}))
    void player.manualFetchLyrics()
    await new Promise(r => setTimeout(r, 0))
    expect(player.lyricFetching.value).toBe(true)

    musicApi.getSongUrl.mockResolvedValue({ url: null })
    await player.playSong(song(2)) // 无 URL 终态——代次闸见锁属旧代，补清
    expect(player.playbackError.value).toMatch(/无法获取播放链接/)
    expect(player.lyricFetching.value).toBe(false)
  })
})

describe('usePlayer：F4 shuffle 态 queueMove 邻居锚定', () => {
  it('打乱序里拖动：原序备份按新前驱锚定，关随机落锚定序非坐标错位', async () => {
    const list = [song(1), song(2), song(3), song(4), song(5)]
    const { player } = makePlayer({ songs: list })
    await player.playSong(list[0])
    player.toggleShuffle() // 备份=[1,2,3,4,5]，可视=[1,...打乱]
    const vis = player.playingSongs.value.map(s => s.id)
    expect(vis[0]).toBe(1)
    const movedId = vis.at(-1)
    // 打乱序末位拖到第 1 位：新前驱=vis[0]=1——原序里 movedId 应插到 1 之后
    player.queueMove({ from: vis.length - 1, to: 1 })
    expect(player.playingSongs.value.map(s => s.id)[1]).toBe(movedId)
    player.toggleShuffle() // 关随机——还的应是邻居锚定后的原序
    const expected = [1, movedId, ...[2, 3, 4, 5].filter(id => id !== movedId)]
    expect(player.playingSongs.value.map(s => s.id)).toEqual(expected)
  })

  it('拖到队首（无前驱）：moved 落原序备份头', async () => {
    const list = [song(1), song(2), song(3)]
    const { player } = makePlayer({ songs: list })
    await player.playSong(list[0])
    player.toggleShuffle()
    const vis = player.playingSongs.value.map(s => s.id)
    const movedId = vis.at(-1)
    player.queueMove({ from: vis.length - 1, to: 0 }) // 拖到队首——前驱缺席插原序头
    player.toggleShuffle()
    const expected = [movedId, ...[1, 2, 3].filter(id => id !== movedId)]
    expect(player.playingSongs.value.map(s => s.id)).toEqual(expected)
  })
})

describe('usePlayer：L7 loadingLyrics 顶置', () => {
  it('hydrateMatchBinding RTT 窗内即进加载态——旧词不再裸挂无指示窗', async () => {
    let releaseState
    musicApi.getMatchState.mockImplementation(
      () => new Promise(r => { releaseState = () => r(null) }))
    const bv = song('bv_BV1xx411c7mD', {
      bilibili: { bvid: 'BV1xx411c7mD', title: 't', author: 'a' },
    })
    const { player } = makePlayer()
    const p = player.playSong(bv)
    // 水合读口已发出、RTT 未完成——窗内 loadingLyrics 必须已置位
    await vi.waitFor(() => expect(musicApi.getMatchState).toHaveBeenCalled())
    expect(player.loadingLyrics.value).toBe(true)
    releaseState()
    await p
    expect(player.loadingLyrics.value).toBe(false)
  })
})

describe('usePlayer：L10 判否换绑形闸对齐裸 id', () => {
  it('verify→rematch RTT 窗内 provider 块被剥：bv_ 裸 id 仍走 /match/retry', async () => {
    const bv = song('bv_BV1xx411c7mD', {
      neteaseId: 111,
      bilibili: { bvid: 'BV1xx411c7mD', title: '视频标题', author: 'UP主' },
    })
    musicApi.getLyrics.mockResolvedValue({ lyrics: [{ time: 1, text: '错词' }] })
    // 判否回包前把 provider 块剥走（持久化裁剪/旧行形态）——形闸若只认
    // 对象则换绑资格随块蒸发；isUgcExternalTrack 裸 id 口径保住它
    aiApi.verifyLyric.mockImplementation(async () => {
      delete bv.bilibili
      return { ok: false }
    })
    musicApi.retryMatch.mockResolvedValue(null) // 完成型 miss → 镜像解绑
    const { player } = makePlayer()
    await player.playSong(bv)
    await vi.waitFor(() => expect(musicApi.retryMatch).toHaveBeenCalled())
    const payload = musicApi.retryMatch.mock.calls[0][0]
    // provider 块缺席：检索喂料回退 song.name/ar（与 rematchUnbound 同口径）
    expect(payload).toMatchObject({
      trackId: 'bv_BV1xx411c7mD', title: '歌bv_BV1xx411c7mD', author: '',
      excludeIds: [111],
    })
    // miss 且 excludeIds 含当前绑定 → 客户端镜像负行解绑；热重载走未绑定
    // 支，外源全灭触发 rematchUnbound 首配兜底再发一次——否决簿里的 111
    // 照旧排除不回锅（每曲每会话限一次，不重试循环）
    await vi.waitFor(() => expect(bv.neteaseId).toBeNull())
    await vi.waitFor(() => expect(musicApi.retryMatch).toHaveBeenCalledTimes(2))
    expect(musicApi.retryMatch.mock.calls[1][0].excludeIds).toEqual([111])
  })
})

describe('usePlayer：L11 队列播尽「已播完」语义', () => {
  it('stopAtQueueEnd：UI 进度走满但落盘续播位写 0——重启不回最后半秒', async () => {
    const list = [song(1), song(2)]
    const { player } = makePlayer({ songs: list })
    await player.playSong(list[1]) // 队列=[1,2]，播队尾 2
    const h = howls.at(-1)
    h.fire('onload')
    h._state = 'loaded'
    h.fire('onend') // list 模式 + autoplay 关 → stopAtQueueEnd
    expect(player.isPlaying.value).toBe(false)
    expect(player.currentTime.value).toBe(200) // UI 进度照常走满
    const saved = JSON.parse(localStorage.getItem(LS_KEYS.PLAYER_STATE))
    expect(saved.currentTime).toBe(0) // 落盘记「已播完」= 从头，不是尾刻
  })

  it('播尽后显式 seek：销「已播完」挂账，落盘写用户选的新位', async () => {
    const list = [song(1), song(2)]
    const { player } = makePlayer({ songs: list })
    await player.playSong(list[1])
    const h = howls.at(-1)
    h.fire('onload')
    h.fire('onend')
    expect(JSON.parse(localStorage.getItem(LS_KEYS.PLAYER_STATE)).currentTime).toBe(0)
    player.seekTo(0.5) // 比例 0-1：拖到正中——挂账销，下拍写 100
    const saved = JSON.parse(localStorage.getItem(LS_KEYS.PLAYER_STATE))
    expect(saved.currentTime).toBe(100)
  })

  // F-L1：遥控 seek 不走 seekTo——销账经模块级口（notifyRemoteSeek）
  it('遥控 seek 销账口：不销账落盘仍写挂账 0；销账后写遥控选的新位', async () => {
    const list = [song(1), song(2)]
    const { player } = makePlayer({ songs: list })
    await player.playSong(list[1])
    const h = howls.at(-1)
    h.fire('onload')
    h.fire('onend') // → stopAtQueueEnd 挂账 pendingSeekTime=0
    expect(JSON.parse(localStorage.getItem(LS_KEYS.PLAYER_STATE)).currentTime).toBe(0)

    // 病灶臂（复现 F-L1）：遥控 seek 直写 howl+currentTime 不销账——
    // 落盘被挂账 0 吞掉
    h.seek(60)
    player.currentTime.value = 60
    await nextTick()
    expect(JSON.parse(localStorage.getItem(LS_KEYS.PLAYER_STATE)).currentTime).toBe(0)

    // 修复臂：useRemoteControl case 'seek' 先销账再写位——落盘写新位
    notifyRemoteSeek()
    player.currentTime.value = 90
    await nextTick()
    expect(JSON.parse(localStorage.getItem(LS_KEYS.PLAYER_STATE)).currentTime).toBe(90)
  })
})

describe('usePlayer：L13 词同步计时器与 AI status 共账', () => {
  it('lyricTimer 暂停清表停走、onplay 重建续走（playing() 可控桩驱动）', async () => {
    vi.useFakeTimers()
    try {
      musicApi.getLyrics.mockResolvedValue({
        lyrics: [{ time: 1, text: '一' }, { time: 5, text: '二' }],
      })
      const { player } = makePlayer()
      await player.playSong(song(7))
      const h = howls.at(-1)
      h.fire('onload')
      h.play() // _playing=true → onplay → isPlaying → 建表
      expect(player.isPlaying.value).toBe(true)
      h._seek = 5.2 // 越过第二行戳
      vi.advanceTimersByTime(150)
      expect(player.currentLyricIndex.value).toBe(1)

      h.pause() // onpause → isPlaying=false + 清表——暂停期不再空转 tick
      expect(player.isPlaying.value).toBe(false)
      h._seek = 1.2
      vi.advanceTimersByTime(600)
      expect(player.currentLyricIndex.value).toBe(1) // 表已清：seek 挪回也不动

      h.play() // onplay 重建——按当下 seek 归位
      vi.advanceTimersByTime(150)
      expect(player.currentLyricIndex.value).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('aiApi.status 会话级共账：后处理直调共享口，会话 memoize 在 api 层', async () => {
    aiApi.status.mockResolvedValue({ enabled: true })
    musicApi.getLyrics.mockResolvedValue({ lyrics: [{ time: 1, text: 'x' }] })
    const { player } = makePlayer()
    await player.playSong(song(7))
    await player.playSong(song(8))
    // usePlayer 不自持第二缓存——每批 postProcess 都直问 aiApi.status()；
    // 「只缓存成功」的会话共账收敛在 api/ai.js 的 statusPromise 里
    // （invalidateStatus 供设置页失效），桩层口径=每批一次调用
    await vi.waitFor(() => expect(aiApi.status).toHaveBeenCalledTimes(2))
  })

  it('aiApi.status 首问失败销账重抛——下曲后处理重新探测', async () => {
    aiApi.status
      .mockRejectedValueOnce(new Error('ai down'))
      .mockResolvedValue({ enabled: true })
    musicApi.getLyrics.mockResolvedValue({ lyrics: [{ time: 1, text: 'x' }] })
    const { player } = makePlayer()
    await player.playSong(song(7))
    await vi.waitFor(() => expect(aiApi.status).toHaveBeenCalledTimes(1))
    await player.playSong(song(8))
    await vi.waitFor(() => expect(aiApi.status).toHaveBeenCalledTimes(2))
  })
})

describe('usePlayer：L15 看门狗与加载窗（state 可控桩驱动）', () => {
  it('loading 态实例 20s 未 onload：看门狗回收置空，加载窗吞键闸先行验证', async () => {
    vi.useFakeTimers()
    try {
      const { player } = makePlayer()
      await player.playSong(song(7))
      const h = howls.at(-1)
      h._state = 'loading' // 实例已建、onload 未至——加载窗语义
      // 加载窗内播放键被吞（防 _queue+onload autoplay 双音轨）
      player.togglePlay()
      expect(h._playing).toBe(false)
      expect(player.isPlaying.value).toBe(false)

      vi.advanceTimersByTime(20000) // PLAYBACK_LOAD_TIMEOUT_MS
      expect(h.unloaded).toBe(true)
      expect(player.getHowl()).toBeNull() // 实例回收——播放键交还 !howl 重建路径
      expect(player.playbackError.value).toMatch(/加载超时/)
      expect(player.songSwitching.value).toBe(false)

      // 键复活：!howl 分支原地重走 playSong 建实例
      player.togglePlay()
      await vi.waitFor(() => expect(howls.length).toBeGreaterThan(1))
    } finally {
      vi.useRealTimers()
    }
  })
})

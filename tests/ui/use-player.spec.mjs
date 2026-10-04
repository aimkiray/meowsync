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
    getLyrics: vi.fn(async () => ({ lrc: '', tlyric: '' })),
  },
  parseLyrics: vi.fn(() => []),
  mergeTranslations: vi.fn((l) => l),
}))
vi.mock('../../src/api/downloads.js', () => ({
  downloadsApi: {
    getSongDownloadStatus: vi.fn(async () => null),
    songFileUrl: vi.fn((plId, songId) => `http://api/dl/${plId}/${songId}`),
    getSongMeta: vi.fn(async () => ({ data: { offsetMs: 0 } })),
    saveLyricOffset: vi.fn(async () => ({})),
  },
}))
vi.mock('../../src/api/ai.js', () => ({
  aiApi: {
    getStatus: vi.fn(async () => ({ enabled: false })),
    lyricTranslate: vi.fn(async () => null),
    lyricVerify: vi.fn(async () => ({ ok: true })),
  },
}))
vi.mock('../../src/lib/feedback.js', () => ({ toast: vi.fn() }))
vi.mock('../../src/lib/theme.js', () => ({ glitchBurst: vi.fn() }))

import { musicApi } from '../../src/api/music.js'
import { downloadsApi } from '../../src/api/downloads.js'
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

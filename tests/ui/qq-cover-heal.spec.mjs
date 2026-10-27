// usePlaylistLibrary：qq_ 无专辑曲封面惰性回填（healMissingQqCovers）。
// 背景：QQ 上游对无专辑单曲回 album/albummid/cover 全空——buildQQSong 三条
// 封面腿全灭落占位图。库加载/远端采纳/导入落库收尾跑一次异步 pass，对
// 「qq_ 前缀 + al 对象 + picUrl 空 + 非 custom」的曲打 GET /cover 回填。
// 钉：命中写 al.picUrl + PRESERVE_TS 簿记落盘不抬 updatedAt；负结果/失败
// 进程内 memo 不重打；custom/al 字符串形态跳过；请求静默不打扰 UI。
// 竞态钉：heal 在途期间 applyRemoteLibrary 整单重建（换壳）后回包——写回
// 按 id 现查活对象而非扫描期捕获的 detached 引用。
// 接线钉：库外导入域（useExternalImport 整单导入）经 dep 注入拿真身，
// 落库收尾即触发——新导入的 qq_ 无专辑曲不等下次整页加载。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'

vi.mock('../../src/api/music.js', () => ({
  musicApi: {
    getPlaylistDetail: vi.fn(async () => null),
    getQQPlaylist: vi.fn(async () => ({})),
  },
  qqLoggedIn: vi.fn(async () => null),
}))
vi.mock('../../src/api/downloads.js', () => ({
  downloadsApi: { removeLocalMirror: vi.fn(async () => ({})) },
}))
// /cover 调用面收口在 http 默认实例——get 桩返回体即服务端 {code,cover}
vi.mock('../../src/api/http.js', () => ({
  default: { get: vi.fn(async () => ({ code: 200, cover: null })) },
  API_BASE_URL: 'http://api.test',
  apiErrorMessage: (e, fb) => e?.message || fb || '接口异常',
}))
// onRemoteApply 回调录下来——applyRemoteLibrary 触发路径靠它驱动
vi.mock('../../src/lib/sync.js', () => ({ onRemoteApply: vi.fn() }))
vi.mock('../../src/lib/feedback.js', () => ({
  toast: vi.fn(), toastDismiss: vi.fn(), toastHold: vi.fn(), toastRelease: vi.fn(),
  pixelConfirm: vi.fn(async () => false), isConfirmOpen: vi.fn(() => false),
  resolveConfirm: vi.fn(),
  useFeedbackState: vi.fn(() => ({ toasts: [], confirm: null })),
}))

import http from '../../src/api/http.js'
import { musicApi } from '../../src/api/music.js'
import { onRemoteApply } from '../../src/lib/sync.js'
import { readJSON, writeJSON, LS_KEYS } from '../../src/lib/storage.js'
import { usePlaylistLibrary } from '../../src/composables/usePlaylistLibrary.js'
import { useExternalImport } from '../../src/composables/useExternalImport.js'

const makeGate = () => {
  let n = 0
  return { claim: () => ++n, isCurrent: (x) => x === n, invalidate: () => { n++ } }
}
const makeLib = () => usePlaylistLibrary({
  gates: { select: makeGate(), mediaImport: makeGate(), preview: makeGate() },
  playingPlaylistId: ref(null),
  loading: ref(false),
})

const qqTrack = (id, extra = {}) => ({
  id, name: '目标曲', ar: [{ name: 'EMA' }],
  al: { id: null, name: '', picUrl: '' }, dt: 200000,
  qq: { mid: id.slice(3), mediaMid: 'mm', albummid: '' },
  ...extra,
})
const flushHeal = () => vi.waitFor(() => expect(http.get).toHaveBeenCalled())

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  http.get.mockResolvedValue({ code: 200, cover: null })
})

describe('usePlaylistLibrary：qq_ 空封面惰性回填', () => {
  it('加载库时对 qq_+al 对象+空 picUrl 曲打 /cover，命中回填且簿记写不抬 updatedAt', async () => {
    const track = qqTrack('qq_003HEAL0000001')
    writeJSON(LS_KEYS.PLAYLISTS, [{
      id: 'local_pl_heal', name: 'QQ单', updatedAt: 100, tracks: [track],
    }])
    http.get.mockResolvedValue({ code: 200, cover: 'https://y.gtimg.cn/x.jpg' })

    const lib = makeLib()
    lib.loadPlaylistsFromStorage()

    // 等整条链落定：回填 → Promise.all 收尾 → PRESERVE_TS 簿记落盘——
    // 断言锚在持久化形态上（内存态先行一步，锚落盘不竞态）
    await vi.waitFor(() => {
      expect(readJSON(LS_KEYS.PLAYLISTS)[0].tracks[0].al.picUrl)
        .toBe('https://y.gtimg.cn/x.jpg')
    })
    expect(lib.userPlaylists.value[0].tracks[0].al.picUrl)
      .toBe('https://y.gtimg.cn/x.jpg')
    expect(http.get).toHaveBeenCalledWith('/cover',
      expect.objectContaining({ params: { id: 'qq_003HEAL0000001' }, timeout: 15000 }))
    // PRESERVE_TS 簿记写：封面回填落盘但 updatedAt 保原戳（不参与 LWW）
    const stored = readJSON(LS_KEYS.PLAYLISTS)[0]
    expect(stored.updatedAt).toBe(100)
  })

  it('负结果/不收的曲形不发请求：cover:null 不回填；custom/al 字符串/非 qq_ 全跳过', async () => {
    writeJSON(LS_KEYS.PLAYLISTS, [{
      id: 'local_pl_skip', name: '混合', updatedAt: 100,
      tracks: [
        qqTrack('qq_003NULL0000001'),                          // cover:null 负面
        qqTrack('qq_003CUST00000001', { custom: { name: 'x' } }), // custom 跳过
        { ...qqTrack('qq_003STR00000001'), al: '专辑名' },       // al 字符串形态跳过
        { id: 'yt_abcdefghijk', name: 'Y', al: {} },             // 非 qq_ 跳过
        qqTrack('qq_003HAS00000001', { al: { picUrl: 'https://x/y.jpg' } }), // 已有封面
      ],
    }])
    const lib = makeLib()
    lib.loadPlaylistsFromStorage()

    await flushHeal()
    // 只有负面那首发了请求；其余四个收口径全挡下
    expect(http.get).toHaveBeenCalledTimes(1)
    expect(http.get).toHaveBeenCalledWith('/cover',
      expect.objectContaining({ params: { id: 'qq_003NULL0000001' } }))
    // 等 worker 收尾落定（负结果无可观测事件，一个宏任务排空微任务链）
    await new Promise(r => setTimeout(r, 30))
    // 静默断言：负结果不写回、其他曲目原样、不落多余持久化差异
    const tracks = readJSON(LS_KEYS.PLAYLISTS)[0].tracks
    expect(tracks[0].al.picUrl).toBe('')
    expect(tracks[1].al.picUrl).toBe('')
    expect(tracks[2].al).toBe('专辑名')
  })

  it('远端采纳（applyRemoteLibrary）同跑回填；同 id 多歌单共享一次上行', async () => {
    const lib = makeLib()
    lib.loadPlaylistsFromStorage()
    // 远端落盘的两张单各持同 id 一份对象——一次请求双方回写
    const remoteApply = onRemoteApply.mock.calls
      .find(c => c[0] === LS_KEYS.PLAYLISTS)?.[1]
    expect(remoteApply).toBeTypeOf('function')

    writeJSON(LS_KEYS.PLAYLISTS, [
      { id: 'local_pl_a', name: 'A', updatedAt: 100, tracks: [qqTrack('qq_003DUP00000001')] },
      { id: 'local_pl_b', name: 'B', updatedAt: 200, tracks: [qqTrack('qq_003DUP00000001')] },
    ])
    http.get.mockResolvedValue({ code: 200, cover: 'https://i.ytimg.com/vi/v/mqdefault.jpg' })
    remoteApply()

    // 锚在持久化形态上——簿记落盘是链尾（见上一用例同口径说明）
    await vi.waitFor(() => {
      expect(readJSON(LS_KEYS.PLAYLISTS)[1].tracks[0].al.picUrl)
        .toBe('https://i.ytimg.com/vi/v/mqdefault.jpg')
    })
    expect(http.get).toHaveBeenCalledTimes(1)
    expect(lib.userPlaylists.value[0].tracks[0].al.picUrl)
      .toBe('https://i.ytimg.com/vi/v/mqdefault.jpg')
    expect(lib.userPlaylists.value[1].tracks[0].al.picUrl)
      .toBe('https://i.ytimg.com/vi/v/mqdefault.jpg')
    const stored = readJSON(LS_KEYS.PLAYLISTS)
    expect(stored[0].updatedAt).toBe(100)
    expect(stored[1].updatedAt).toBe(200)
  })

  it('负结果进进程 memo——远端采纳再触发不重打同曲', async () => {
    writeJSON(LS_KEYS.PLAYLISTS, [{
      id: 'local_pl_neg', name: 'N', updatedAt: 100,
      tracks: [qqTrack('qq_003NEG00000001')],
    }])
    const lib = makeLib()
    const remoteApply = onRemoteApply.mock.calls
      .find(c => c[0] === LS_KEYS.PLAYLISTS)?.[1]
    lib.loadPlaylistsFromStorage()
    await flushHeal()
    expect(http.get).toHaveBeenCalledTimes(1)

    // 远端采纳再触发一轮——同曲已在 memo，零新增请求
    remoteApply()
    await new Promise(r => setTimeout(r, 30))
    expect(http.get).toHaveBeenCalledTimes(1)
    expect(lib.userPlaylists.value[0].tracks[0].al.picUrl).toBe('')
  })

  it('竞态：heal 在途期间远端采纳换壳——回包写回活对象而非 detached 旧引用', async () => {
    writeJSON(LS_KEYS.PLAYLISTS, [{
      id: 'local_pl_race', name: 'R', updatedAt: 100,
      tracks: [qqTrack('qq_003RACE0000001')],
    }])
    const lib = makeLib()
    const remoteApply = onRemoteApply.mock.calls
      .find(c => c[0] === LS_KEYS.PLAYLISTS)?.[1]
    // /cover 挂起——拿住「请求已发出、回包未落」的在途窗口
    let resolveCover
    http.get.mockImplementation(() => new Promise(r => { resolveCover = r }))
    lib.loadPlaylistsFromStorage()
    await flushHeal()
    const stale = lib.userPlaylists.value[0].tracks[0]

    // heal 在途期间远端采纳：readJSON 重新解析→整单重建，旧引用 detach。
    // （applyRemoteLibrary 内部也再跑一遍 heal——id 已在 asked，零新增请求）
    writeJSON(LS_KEYS.PLAYLISTS, [{
      id: 'local_pl_race', name: 'R', updatedAt: 100,
      tracks: [qqTrack('qq_003RACE0000001')],
    }])
    remoteApply()
    const live = lib.userPlaylists.value[0].tracks[0]
    expect(live).not.toBe(stale) // 换壳成立
    expect(http.get).toHaveBeenCalledTimes(1)

    // 回包落达——写回必须命中换壳后的活对象，不是 detached 旧引用
    resolveCover({ code: 200, cover: 'https://i.ytimg.com/vi/v/mqdefault.jpg' })
    await vi.waitFor(() => {
      expect(readJSON(LS_KEYS.PLAYLISTS)[0].tracks[0].al.picUrl)
        .toBe('https://i.ytimg.com/vi/v/mqdefault.jpg')
    })
    expect(live.al.picUrl).toBe('https://i.ytimg.com/vi/v/mqdefault.jpg')
    expect(stale.al.picUrl).toBe('') // 脱壳旧对象无幽灵写回
  })

  it('neteaseId 词源绑定作 ne 参随请求发出；无绑定的曲不发参', async () => {
    writeJSON(LS_KEYS.PLAYLISTS, [{
      id: 'local_pl_nehint', name: 'H', updatedAt: 100,
      tracks: [
        qqTrack('qq_003NEHINT00001', { neteaseId: 26130076 }), // 数值形态 String 化
        qqTrack('qq_003NEHINT00002'),                        // 无绑定 → 空值不发参
      ],
    }])
    const lib = makeLib()
    lib.loadPlaylistsFromStorage()

    await vi.waitFor(() => expect(http.get).toHaveBeenCalledTimes(2))
    const paramsOf = (id) =>
      http.get.mock.calls.find(call => call[1]?.params?.id === id)?.[1]?.params
    // 绑定作 hint 上行——服务端绑定腿官封比外源池权威
    expect(paramsOf('qq_003NEHINT00001'))
      .toEqual({ id: 'qq_003NEHINT00001', ne: '26130076' })
    // 无绑定不发 ne 参——服务端 song_match 行仍兜
    expect(paramsOf('qq_003NEHINT00002')).toEqual({ id: 'qq_003NEHINT00002' })
  })

  it('同 id 跨歌单任一持有方有绑定即随参发出（无绑副本不吞 hint）', async () => {
    // A 单副本无 neteaseId、B 单副本有——id 聚合上行时 hint 取非空者
    writeJSON(LS_KEYS.PLAYLISTS, [
      { id: 'local_pl_nea', name: 'A', updatedAt: 100, tracks: [qqTrack('qq_003NEDUP000001')] },
      { id: 'local_pl_neb', name: 'B', updatedAt: 200, tracks: [qqTrack('qq_003NEDUP000001', { neteaseId: '777' })] },
    ])
    const lib = makeLib()
    lib.loadPlaylistsFromStorage()

    await vi.waitFor(() => expect(http.get).toHaveBeenCalledTimes(1))
    expect(http.get).toHaveBeenCalledWith('/cover',
      expect.objectContaining({
        params: { id: 'qq_003NEDUP000001', ne: '777' },
      }))
  })

  it('响应带 album：al.name 空同补专辑名，name 在场不覆盖（只补不夺）', async () => {
    writeJSON(LS_KEYS.PLAYLISTS, [{
      id: 'local_pl_alname', name: '官封单', updatedAt: 100,
      tracks: [
        qqTrack('qq_003ALNAMEFILL'),                          // al.name '' → 补
        { ...qqTrack('qq_003ALNAMEKEEP'), al: { id: 9, name: '已有专', picUrl: '' } },
      ],
    }])
    http.get.mockResolvedValue({
      code: 200, cover: 'https://p2.music.126.net/x.jpg', album: '告白 - Original Soundtrack',
    })
    const lib = makeLib()
    lib.loadPlaylistsFromStorage()

    // 锚在持久化形态——slimTrack 白名单留 al.name（song.js 同口径）
    await vi.waitFor(() => {
      const tracks = readJSON(LS_KEYS.PLAYLISTS)[0].tracks
      expect(tracks[0].al.name).toBe('告白 - Original Soundtrack')
      expect(tracks[1].al.name).toBe('已有专')
    })
    const live = lib.userPlaylists.value[0].tracks
    expect(live[0].al.picUrl).toBe('https://p2.music.126.net/x.jpg')
    expect(live[1].al.picUrl).toBe('https://p2.music.126.net/x.jpg',
      'name 在场的曲 picUrl 照常愈——补名不抢补图位')
    const stored = readJSON(LS_KEYS.PLAYLISTS)[0]
    expect(stored.updatedAt).toBe(100)
  })

  it('导入落库收尾即触发回填——addPlaylistToLibrary → upsertProviderShell 后的 qq_ 曲即问 /cover', async () => {
    const lib = makeLib()
    lib.loadPlaylistsFromStorage()
    // QQ 歌单卡「+ 收藏」链：/qq/playlist → buildQQSong（无专辑曲 picUrl 空）
    // → upsertProviderShell 幂等壳 → save 收尾触发 heal——不等下次整页加载
    musicApi.getQQPlaylist.mockResolvedValue({
      name: 'QQ 单', creator: 'QQ 音乐',
      tracks: [{ mid: '003QQIMPORT001', name: '目标曲', artists: ['EMA'], duration: 200 }],
    })
    // PlaylistGrid provider:'qq' 归一卡形态（review-fixes.spec QQ_CARD 同款）——
    // id 是壳 id 不在网易云 id 空间，走 /qq/playlist 导入链
    await lib.addPlaylistToLibrary({
      id: 'local_pl_qq_12345', provider: 'qq', disstid: '12345', name: 'QQ 单',
    })

    await vi.waitFor(() => {
      expect(http.get).toHaveBeenCalledWith('/cover',
        expect.objectContaining({ params: { id: 'qq_003QQIMPORT001' } }))
    })
    expect(lib.userPlaylists.value[0].id).toBe('local_pl_qq_12345')
    expect(lib.userPlaylists.value[0].tracks[0].id).toBe('qq_003QQIMPORT001')
  })

  it('外部导入链同触发——useExternalImport.importQQPlaylist → upsertImportedShell 落库后即问 /cover', async () => {
    // App.vue 同款装配：healMissingQqCovers 由库域实例作 dep 注入导入域——
    // 注真身而非 vi.fn 桩：断言锚在 http.get 发问面上（heal 真跑了），
    // 桩只能证明「调用了 dep」证明不了回填链通
    const lib = makeLib()
    const imp = useExternalImport({
      gates: { select: makeGate(), mediaImport: makeGate() },
      userPlaylists: lib.userPlaylists, selectedPlaylist: lib.selectedPlaylist,
      songs: lib.songs, loadingSongs: lib.loadingSongs,
      savePlaylistsToStorage: lib.savePlaylistsToStorage,
      searchQuery: ref(''), currentSong: ref(null),
      playSong: vi.fn(async () => {}), enterWatch: vi.fn(),
      selectPlaylistAndShow: vi.fn(async () => {}),
      healMissingQqCovers: lib.healMissingQqCovers,
    })
    // 顶栏/转跳整单导入：/qq/playlist → buildQQSong（无专辑曲 picUrl 空）→
    // upsertProviderShell 幂等壳 → save 收尾触发 heal
    musicApi.getQQPlaylist.mockResolvedValue({
      name: 'QQ 单', creator: 'QQ 音乐',
      tracks: [{ mid: '003QQIMPORT002', name: '目标曲', artists: ['EMA'], duration: 200 }],
    })
    await imp.importQQPlaylist('54321')

    await vi.waitFor(() => {
      expect(http.get).toHaveBeenCalledWith('/cover',
        expect.objectContaining({ params: { id: 'qq_003QQIMPORT002' } }))
    })
    expect(lib.userPlaylists.value[0].id).toBe('local_pl_qq_54321')
    expect(lib.userPlaylists.value[0].tracks[0].id).toBe('qq_003QQIMPORT002')
  })
})

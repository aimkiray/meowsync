// 多端同步引擎（src/lib/sync.js）：增量拉取应用 / LWW 双向判优 / conflicts
// 采纳 / 墓碑传播 / 歌单炸开 diff 推送 / 回声抑制 / 离线退避。
// api/sync.js 全桩；防抖与退避走 fake timers；Date.now 用 setSystemTime 钉死
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, nextTick } from 'vue'

vi.mock('../../src/api/sync.js', () => ({
  syncApi: { pull: vi.fn(), push: vi.fn() },
}))
// usePlaylistLibrary 的上游依赖桩——本 spec 只用它验证 updatedAt 打点与远端重建
vi.mock('../../src/api/music.js', () => ({
  musicApi: {
    getPlaylistDetail: vi.fn(async () => null),
    getQqStatus: vi.fn(async () => null),
  },
  // App.vue→usePlayer/useExternalImport 图按名链接——缺省 null=「态未知」
  qqLoggedIn: vi.fn(async () => null),
}))
vi.mock('../../src/api/downloads.js', () => ({
  downloadsApi: { removeLocalMirror: vi.fn(async () => ({})) },
}))
// App.vue 挂载用例的其余上游桩（模块图链接完整性；同名导出缺省会炸 import）
vi.mock('../../src/api/auth.js', () => ({
  authApi: { status: vi.fn(async () => ({ data: {} })) },
}))
vi.mock('../../src/api/http.js', () => ({
  default: {
    get: vi.fn(async () => ({ code: 200 })),
    post: vi.fn(async () => ({ code: 200 })),
    put: vi.fn(async () => ({ code: 200 })),
    delete: vi.fn(async () => ({ code: 200 })),
  },
  API_BASE_URL: 'http://api.test',
  apiErrorMessage: (e, fb) => e?.message || fb || '接口异常',
}))
vi.mock('../../src/api/ai.js', () => ({
  aiApi: {
    status: vi.fn(async () => ({ enabled: false })),
    translateLyric: vi.fn(async () => null),
    verifyLyric: vi.fn(async () => ({ ok: true })),
  },
}))
vi.mock('../../src/api/uploads.js', () => ({
  uploadFile: vi.fn(),
  deleteUploadedSong: vi.fn(async () => ({})),
}))
vi.mock('howler', () => ({
  Howl: class {},
  Howler: { html5PoolSize: 0, volume: vi.fn(), mute: vi.fn() },
}))
// feedback 全名导出——App/composable 模块图按名链接
vi.mock('../../src/lib/feedback.js', () => ({
  toast: vi.fn(), toastDismiss: vi.fn(), toastHold: vi.fn(), toastRelease: vi.fn(),
  pixelConfirm: vi.fn(async () => false), isConfirmOpen: vi.fn(() => false),
  resolveConfirm: vi.fn(),
  useFeedbackState: vi.fn(() => ({ toasts: [], confirm: null })),
}))

import { shallowMount } from '@vue/test-utils'
import { syncApi } from '../../src/api/sync.js'
import { musicApi } from '../../src/api/music.js'
import {
  initSync, pullFromServer, onRemoteApply, markDirty, resetSyncState, attachWriteHook,
} from '../../src/lib/sync.js'
import { writeJSON, readJSON, notifyStorageWrite, LS_KEYS } from '../../src/lib/storage.js'
import { usePlaylistLibrary } from '../../src/composables/usePlaylistLibrary.js'
import App from '../../src/App.vue'

const T0 = 1_700_000_000_000
const docKey = (lsKey) => `doc:${lsKey}`

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  localStorage.clear()
  resetSyncState()
  syncApi.pull.mockReset()
  syncApi.pull.mockResolvedValue({ code: 200, items: [], serverTime: T0 })
  syncApi.push.mockReset()
  syncApi.push.mockResolvedValue({ code: 200, applied: [], conflicts: [], rejected: [] })
})

afterEach(() => {
  resetSyncState()
  vi.useRealTimers()
})

const makeGate = () => {
  let n = 0
  return { claim: () => ++n, current: () => n, isCurrent: (x) => x === n, invalidate: () => { n++ } }
}
const makeLib = () => usePlaylistLibrary({
  gates: { select: makeGate(), mediaImport: makeGate(), preview: makeGate() },
  playingPlaylistId: ref(null),
  loading: ref(false),
})

describe('sync 引擎：推送', () => {
  it('白名单键写入进脏集，~1.5s 防抖聚合一趟 push；歌单按单炸开 + lib:index 随行', async () => {
    initSync()
    const pl1 = { id: 'local_pl_1690000000000', name: 'A', tracks: [], updatedAt: 1690000000000 }
    const pl2 = { id: '991', name: 'B', updatedAt: 2000 }
    writeJSON(LS_KEYS.PLAYLISTS, [pl1, pl2])
    writeJSON(LS_KEYS.PLAY_HISTORY, []) // 同窗聚合进同一趟
    await vi.advanceTimersByTimeAsync(1600)

    expect(syncApi.push).toHaveBeenCalledTimes(1)
    const keys1 = syncApi.push.mock.calls[0][0].map(c => c.key)
    expect(keys1).toContain('playlist:local_pl_1690000000000')
    expect(keys1).toContain('playlist:991')
    expect(keys1).toContain('lib:index')
    expect(keys1).toContain(docKey(LS_KEYS.PLAY_HISTORY))
    const idx = syncApi.push.mock.calls[0][0].find(c => c.key === 'lib:index')
    expect(idx.value.order).toEqual(['local_pl_1690000000000', '991'])

    // 第二趟只动 pl2：diff 按 updatedAt——未变的 pl1 不再上行
    const pl2v2 = { ...pl2, name: 'B2', updatedAt: 3000 }
    writeJSON(LS_KEYS.PLAYLISTS, [pl1, pl2v2])
    await vi.advanceTimersByTimeAsync(1600)
    expect(syncApi.push).toHaveBeenCalledTimes(2)
    const keys2 = syncApi.push.mock.calls[1][0].map(c => c.key).sort()
    expect(keys2).toEqual(['lib:index', 'playlist:991'].sort())

    // 删单 → deleted 墓碑随下一趟出行
    writeJSON(LS_KEYS.PLAYLISTS, [pl1])
    await vi.advanceTimersByTimeAsync(1600)
    const tomb = syncApi.push.mock.calls[2][0].find(c => c.key === 'playlist:991')
    expect(tomb.deleted).toBe(true)
    expect(tomb.value).toBe(null)
  })

  it('doc 键推 LS 原始串（value=raw string）；本地删除产出 deleted 墓碑', async () => {
    initSync()
    writeJSON(LS_KEYS.PLAYER_STATE, { volume: 42 })
    await vi.advanceTimersByTimeAsync(1600)
    const put = syncApi.push.mock.calls[0][0].find(c => c.key === docKey(LS_KEYS.PLAYER_STATE))
    expect(put.value).toBe(JSON.stringify({ volume: 42 }))
    expect(put.updatedAt).toBe(T0)
    expect(put.deleted).toBe(false)

    localStorage.removeItem(LS_KEYS.PLAYER_STATE)
    notifyStorageWrite(LS_KEYS.PLAYER_STATE) // 裸删路径走同一脏标记口
    await vi.advanceTimersByTimeAsync(1600)
    const tomb = syncApi.push.mock.calls[1][0].find(c => c.key === docKey(LS_KEYS.PLAYER_STATE))
    expect(tomb.deleted).toBe(true)
    expect(tomb.value).toBe(null)
  })

  it('非白名单键与 init 之前的写都不产生推送', async () => {
    writeJSON('not-a-sync-key', { a: 1 }) // init 前钩子未挂——写白名单键也不记
    writeJSON(LS_KEYS.THEME === 'x' ? 'x' : 'unrelated', 'y')
    initSync()
    writeJSON('still-unrelated', { b: 2 })
    // 钉板：GLITCH_MOTION 是设备级减动豁免键——显式非白名单（storage.js
    // 注释），裸写+脏标记不得进推送链；本键入白名单即红（私有 Set 唯一行为钉板）
    localStorage.setItem(LS_KEYS.GLITCH_MOTION, '1')
    notifyStorageWrite(LS_KEYS.GLITCH_MOTION)
    await vi.advanceTimersByTimeAsync(4000)
    expect(syncApi.push).not.toHaveBeenCalled()
  })

  it('推送失败静默退避：脏集保留 + 指数退避重试，本地写全程不受影响', async () => {
    initSync()
    syncApi.push
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ code: 200, applied: [], conflicts: [], rejected: [] })
    writeJSON(LS_KEYS.PLAYER_STATE, { volume: 7 })
    await vi.advanceTimersByTimeAsync(1600)
    expect(syncApi.push).toHaveBeenCalledTimes(1)
    // 退避底数 2s 后自动重试——脏集回收语义，丢推送不等于丢数据
    await vi.advanceTimersByTimeAsync(2100)
    expect(syncApi.push).toHaveBeenCalledTimes(2)
    expect(readJSON(LS_KEYS.PLAYER_STATE)).toEqual({ volume: 7 })
  })

  it('超服务端 MAX_CHANGES=500 硬顶的批次分块出行', async () => {
    initSync()
    const list = Array.from({ length: 501 }, (_, i) =>
      ({ id: `pl${i}`, name: `P${i}`, updatedAt: 100 + i }))
    writeJSON(LS_KEYS.PLAYLISTS, list)
    await vi.advanceTimersByTimeAsync(1600)
    // 501 单 + lib:index = 502 条 → 500+2 两趟
    expect(syncApi.push).toHaveBeenCalledTimes(2)
    expect(syncApi.push.mock.calls[0][0].length).toBe(500)
    expect(syncApi.push.mock.calls[1][0].length).toBe(2)
  })

  it('整批 value 字节预算切块：大 value 批按字节开新块，不整批撞服务端 4MB 闸', async () => {
    initSync()
    // 20 单 × ~220KB ≈ 4.4MB——条数远未到 500，纯字节预算必须开新块；
    // 不切块会撞服务端 MAX_BATCH_VALUE_BYTES=4MB 整批 400 + 无限退避
    const pad = 'x'.repeat(220 * 1024)
    writeJSON(LS_KEYS.PLAYLISTS, Array.from({ length: 20 }, (_, i) =>
      ({ id: `big${i}`, name: `B${i}`, pad, updatedAt: 100 + i })))
    await vi.advanceTimersByTimeAsync(1600)
    expect(syncApi.push).toHaveBeenCalledTimes(2)
    // 每块 value 总字节压进客户端 3.5MB 切块阈（服务端 4MB 硬顶留余量）——
    // 与服务端 valueJsonOf 同口径计量：墓碑 'null'、undefined 归一 null
    for (const call of syncApi.push.mock.calls) {
      const bytes = call[0].reduce((sum, c) =>
        sum + Buffer.byteLength(c.deleted ? 'null' : JSON.stringify(c.value ?? null), 'utf8'), 0)
      expect(bytes).toBeLessThanOrEqual(3.5 * 1024 * 1024)
    }
    // 切块不重不漏：20 单 + lib:index 全送达
    const sentKeys = syncApi.push.mock.calls.flatMap(c => c[0].map(x => x.key))
    expect(sentKeys.length).toBe(21)
    expect(sentKeys).toContain('lib:index')
  })
})

describe('sync 引擎：拉取与 LWW', () => {
  it('远端 doc 应用：落 LS + 通知订阅者 + since 水位线逐页推进（hasMore 翻页）', async () => {
    initSync()
    const spy = vi.fn()
    onRemoteApply(LS_KEYS.PLAY_HISTORY, spy)
    syncApi.pull
      .mockResolvedValueOnce({
        code: 200,
        items: [{ key: docKey(LS_KEYS.PLAY_HISTORY), value: JSON.stringify([{ id: 1 }]), updatedAt: 100, seq: 41 }],
        serverTime: 5000, hasMore: true,
      })
      .mockResolvedValueOnce({
        code: 200,
        items: [{ key: docKey(LS_KEYS.PLAYLIST_HISTORY), value: JSON.stringify([{ id: 2 }]), updatedAt: 200, seq: 47 }],
        serverTime: 6000,
      })
    await pullFromServer()
    expect(syncApi.pull).toHaveBeenCalledTimes(2)
    // 续拉 since=上页最大 seq（天然 keyset）——serverTime 纯诊断不回喂；
    // cursor/nextCursor 已退役，pull 只有 since 一参
    expect(syncApi.pull.mock.calls[1][0]).toBe(41)
    expect(syncApi.pull.mock.calls[1].length).toBe(1)
    expect(readJSON(LS_KEYS.PLAY_HISTORY)).toEqual([{ id: 1 }])
    expect(readJSON(LS_KEYS.PLAYLIST_HISTORY)).toEqual([{ id: 2 }])
    expect(spy).toHaveBeenCalledTimes(1)
    // 水位线=已应用项的最大 seq，不是 serverTime
    expect(readJSON(LS_KEYS.SYNC_SINCE)).toBe(47)
  })

  it('水位线不变量：全部页应用完 since 才落盘——拉到≠消化', async () => {
    initSync()
    // 订阅回调在 apply 期间执行——此刻水位线必须还是拉取前的旧值，
    // 否则 apply 失败/中断后的重拉会跳过这批「已拉未应用」的项
    let sinceDuringApply = null
    onRemoteApply(LS_KEYS.PLAY_HISTORY, () => {
      sinceDuringApply = readJSON(LS_KEYS.SYNC_SINCE, 0)
    })
    syncApi.pull
      .mockResolvedValueOnce({
        code: 200, hasMore: true, serverTime: 11,
        items: [{ key: docKey(LS_KEYS.PLAY_HISTORY), value: '[]', updatedAt: 1, seq: 7 }],
      })
      .mockResolvedValueOnce({
        code: 200, serverTime: 12,
        items: [{ key: docKey(LS_KEYS.PLAYLIST_HISTORY), value: '[]', updatedAt: 2, seq: 9 }],
      })
    await pullFromServer()
    expect(sinceDuringApply).toBe(0) // apply 进行中水位线未动——收集 loop 不落盘
    expect(readJSON(LS_KEYS.SYNC_SINCE)).toBe(9) // 全页应用完一次性落 max(seq)
  })

  it('翻页中途请求失败：已收集页不应用、水位线不推进（下趟重拉补齐）', async () => {
    initSync()
    syncApi.pull
      .mockResolvedValueOnce({
        code: 200, hasMore: true,
        items: [{ key: docKey(LS_KEYS.THEME), value: 'glitch-restoration', updatedAt: 1, seq: 3 }],
      })
      .mockRejectedValueOnce(new Error('offline'))
    await pullFromServer()
    expect(localStorage.getItem(LS_KEYS.THEME)).toBe(null) // 拉到未应用——不落盘
    expect(readJSON(LS_KEYS.SYNC_SINCE, 0)).toBe(0) // 水位线原地——下趟重拉同批
    // apply 幂等：seq 重发项落地且水位线照常推进
    syncApi.pull.mockResolvedValue({
      code: 200,
      items: [{ key: docKey(LS_KEYS.THEME), value: 'glitch-restoration', updatedAt: 1, seq: 3 }],
    })
    await pullFromServer()
    expect(localStorage.getItem(LS_KEYS.THEME)).toBe('glitch-restoration')
    expect(readJSON(LS_KEYS.SYNC_SINCE)).toBe(3)
  })

  it('LWW 本地赢：写戳更高的本地 doc 不被远端旧值覆盖，且随后回推收敛', async () => {
    initSync()
    localStorage.setItem(LS_KEYS.THEME, 'glitch-restoration')
    notifyStorageWrite(LS_KEYS.THEME) // 写戳打在 T0
    syncApi.pull.mockResolvedValue({
      code: 200,
      items: [{ key: docKey(LS_KEYS.THEME), value: 'retro-x', updatedAt: T0 - 1000, seq: 60 }],
      serverTime: T0 + 10,
    })
    const spy = vi.fn()
    onRemoteApply(LS_KEYS.THEME, spy)
    await pullFromServer()
    expect(localStorage.getItem(LS_KEYS.THEME)).toBe('glitch-restoration')
    expect(spy).not.toHaveBeenCalled() // 未落地不派发
    await vi.advanceTimersByTimeAsync(1600)
    const sent = syncApi.push.mock.calls.at(-1)[0].find(c => c.key === docKey(LS_KEYS.THEME))
    expect(sent.value).toBe('glitch-restoration')
  })

  it('LWW 远端赢：远端戳更高覆盖本地 doc 并派发订阅', async () => {
    initSync()
    localStorage.setItem(LS_KEYS.THEME, 'retro-old')
    notifyStorageWrite(LS_KEYS.THEME)
    const spy = vi.fn()
    onRemoteApply(LS_KEYS.THEME, spy)
    syncApi.pull.mockResolvedValue({
      code: 200,
      items: [{ key: docKey(LS_KEYS.THEME), value: 'glitch-restoration', updatedAt: T0 + 1000, seq: 61 }],
      serverTime: T0 + 1000,
    })
    await pullFromServer()
    expect(localStorage.getItem(LS_KEYS.THEME)).toBe('glitch-restoration')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('playlist 项：远端赢替换 / 本地赢留存回推 / 平局远端赢 / 墓碑按戳删 / 缺席插入', async () => {
    writeJSON(LS_KEYS.PLAYLISTS, [
      { id: 'a', name: '老A', updatedAt: 100 },
      { id: 'b', name: '老B', updatedAt: 100 },
      { id: 'c', name: '本地C', updatedAt: 300 },
      { id: 'e', name: '本地E', updatedAt: 300 },
    ])
    initSync()
    syncApi.pull.mockResolvedValue({
      code: 200,
      items: [
        { key: 'playlist:a', value: { id: 'a', name: '新A' }, updatedAt: 200, seq: 11 },        // 200>100 替换
        { key: 'playlist:b', value: null, updatedAt: 200, deleted: true, seq: 12 },             // 墓碑 200>100 删
        { key: 'playlist:c', value: { id: 'c', name: '远端C' }, updatedAt: 200, seq: 13 },      // 本地 300 赢留存
        { key: 'playlist:d', value: { id: 'd', name: '新D' }, updatedAt: 50, seq: 14 },         // 缺席插入
        { key: 'playlist:e', value: { id: 'e', name: '远端E' }, updatedAt: 300, seq: 15 },      // 平局 300=300 远端赢
      ],
      serverTime: 400,
    })
    await pullFromServer()
    const byId = Object.fromEntries(readJSON(LS_KEYS.PLAYLISTS).map(p => [p.id, p]))
    expect(byId.a.name).toBe('新A')
    expect(byId.b).toBeUndefined()
    expect(byId.c.name).toBe('本地C')
    expect(byId.d.name).toBe('新D')
    // 平局远端赢——与服务端平局留旧+conflicts 采纳同向收敛
    expect(byId.e.name).toBe('远端E')
    expect(byId.e.updatedAt).toBe(300)
    // 本地赢的 c 回推让服务端收敛；a/d 基线已被远端戳同步不再上行
    await vi.advanceTimersByTimeAsync(1600)
    const keys = syncApi.push.mock.calls.at(-1)[0].map(c => c.key)
    expect(keys).toContain('playlist:c')
    expect(keys).toContain('lib:index')
    expect(keys).not.toContain('playlist:a')
    expect(keys).not.toContain('playlist:d')
    expect(keys).not.toContain('playlist:b') // 墓碑既已采纳不再回推
    expect(keys).not.toContain('playlist:e') // 平局采纳远端——不产回声回推
  })

  it('lib:index：远端 order 重排本地库 + removedDefaultPlaylists 落地', async () => {
    writeJSON(LS_KEYS.PLAYLISTS, [
      { id: 'a', name: 'A', updatedAt: 100 },
      { id: 'b', name: 'B', updatedAt: 100 },
    ])
    initSync()
    syncApi.pull.mockResolvedValue({
      code: 200,
      items: [{
        key: 'lib:index',
        value: { order: ['b', 'a'], removedDefaultPlaylists: ['def1'] },
        updatedAt: 500, seq: 20,
      }],
      serverTime: 500,
    })
    await pullFromServer()
    expect(readJSON(LS_KEYS.PLAYLISTS).map(p => p.id)).toEqual(['b', 'a'])
    expect(readJSON(LS_KEYS.REMOVED_DEFAULT_PLAYLISTS)).toEqual(['def1'])
  })

  it('远端 doc 墓碑：删键 + 订阅者 removeItem 回声不回推墓碑、不二次盖戳', async () => {
    initSync()
    writeJSON(LS_KEYS.THEME, 'glitch')
    await vi.advanceTimersByTimeAsync(1600)
    expect(syncApi.push).toHaveBeenCalledTimes(1)
    // 远端墓碑到达（theme 'default' 的 removeItem 语义跨端传播）：
    // 订阅者照 theme.js 同口径 removeItem+notify——墓碑态抑制该回声
    onRemoteApply(LS_KEYS.THEME, () => {
      localStorage.removeItem(LS_KEYS.THEME)
      notifyStorageWrite(LS_KEYS.THEME)
    })
    syncApi.pull.mockResolvedValue({
      code: 200,
      items: [{ key: docKey(LS_KEYS.THEME), value: null, updatedAt: T0 + 5000, deleted: true, seq: 62 }],
      serverTime: T0 + 5000,
    })
    await pullFromServer()
    expect(localStorage.getItem(LS_KEYS.THEME)).toBe(null)
    await vi.advanceTimersByTimeAsync(4000)
    expect(syncApi.push).toHaveBeenCalledTimes(1) // 不产伪墓碑回推
    // 随后本地真删/真写仍正常工作：写值脱离墓碑态
    localStorage.setItem(LS_KEYS.THEME, 'retro-x')
    notifyStorageWrite(LS_KEYS.THEME)
    await vi.advanceTimersByTimeAsync(1600)
    const sent = syncApi.push.mock.calls.at(-1)[0].find(c => c.key === docKey(LS_KEYS.THEME))
    expect(sent.value).toBe('retro-x')
    expect(sent.deleted).toBe(false)
  })

  it('回声抑制：远端应用落盘后的同值重写不触发推送', async () => {
    initSync()
    syncApi.pull.mockResolvedValue({
      code: 200,
      items: [
        { key: docKey(LS_KEYS.THEME), value: 'glitch-restoration', updatedAt: T0 + 5, seq: 70 },
        { key: 'playlist:p1', value: { id: 'p1', name: 'P' }, updatedAt: T0 + 5, seq: 71 },
      ],
      serverTime: T0 + 5,
    })
    await pullFromServer()
    // 订阅者同值重写——prefs watcher/库重建的同形态回写必须被回声判据挡下
    localStorage.setItem(LS_KEYS.THEME, 'glitch-restoration')
    notifyStorageWrite(LS_KEYS.THEME)
    writeJSON(LS_KEYS.PLAYLISTS, readJSON(LS_KEYS.PLAYLISTS))
    await vi.advanceTimersByTimeAsync(4000)
    expect(syncApi.push).not.toHaveBeenCalled()
  })
})

describe('sync 引擎：push 回包处理', () => {
  it('conflicts 采纳远端值：item 无内层 key 也以外层 c.key 落地，基线推进不回推', async () => {
    initSync()
    localStorage.setItem(LS_KEYS.THEME, 'mine')
    notifyStorageWrite(LS_KEYS.THEME)
    const spy = vi.fn()
    onRemoteApply(LS_KEYS.THEME, spy)
    syncApi.push.mockResolvedValue({
      code: 200, applied: [],
      // 服务端真形状：item 内层 key 是冗余可缺字段——主测无 key 形逼出
      //「外层 c.key 为准」的真路径（旧实现直接喂 c.item，缺 key 被形状闸丢光）
      conflicts: [{
        key: docKey(LS_KEYS.THEME),
        item: { value: 'server-wins', updatedAt: T0 + 5000, deleted: false, seq: 88 },
      }],
      rejected: [],
    })
    await vi.advanceTimersByTimeAsync(1600)
    expect(localStorage.getItem(LS_KEYS.THEME)).toBe('server-wins')
    expect(spy).toHaveBeenCalledTimes(1)
    // 采纳把 doc LWW 基线推进到远端戳——同戳/旧戳再拉不再覆盖
    expect(readJSON(LS_KEYS.SYNC_META)[LS_KEYS.THEME]).toBe(T0 + 5000)
    await vi.advanceTimersByTimeAsync(4000)
    expect(syncApi.push).toHaveBeenCalledTimes(1) // 采纳落盘不产回声回推
  })

  it('conflicts 采纳 playlist 项同样走外层 key；本地落后值被远端覆盖', async () => {
    writeJSON(LS_KEYS.PLAYLISTS, [{ id: 'a', name: '本地A', updatedAt: 100 }])
    initSync()
    syncApi.push.mockResolvedValue({
      code: 200, applied: [],
      conflicts: [{
        key: 'playlist:a',
        item: { value: { id: 'a', name: '服务端A' }, updatedAt: 200, deleted: false, seq: 91 },
      }],
      rejected: [],
    })
    // 本地改动触发推送（updatedAt 100<200 服务端留旧→conflict 回包采纳）
    writeJSON(LS_KEYS.PLAYLISTS, [{ id: 'a', name: '本地A改', updatedAt: 150 }])
    await vi.advanceTimersByTimeAsync(1600)
    const byId = Object.fromEntries(readJSON(LS_KEYS.PLAYLISTS).map(p => [p.id, p]))
    expect(byId.a.name).toBe('服务端A')
    expect(byId.a.updatedAt).toBe(200) // 基线记远端戳——同值不再回推
    await vi.advanceTimersByTimeAsync(4000)
    expect(syncApi.push).toHaveBeenCalledTimes(1)
  })
})

describe('usePlaylistLibrary：歌单 updatedAt 打点与远端重建', () => {
  it('持久化形态真变才抬 updatedAt；未动单保持原戳', () => {
    const lib = makeLib()
    lib.userPlaylists.value.push({ id: 'local_pl_1690000000000', name: 'P', tracks: [], isLocal: true })
    lib.savePlaylistsToStorage()
    expect(readJSON(LS_KEYS.PLAYLISTS)[0].updatedAt).toBe(T0)

    // 无变化再存——戳不动（指纹比对挡下）
    vi.setSystemTime(T0 + 1000)
    lib.savePlaylistsToStorage()
    expect(readJSON(LS_KEYS.PLAYLISTS)[0].updatedAt).toBe(T0)

    // 真改字段 → 抬到当前刻
    vi.setSystemTime(T0 + 2000)
    lib.userPlaylists.value[0].name = 'P2'
    lib.savePlaylistsToStorage()
    expect(readJSON(LS_KEYS.PLAYLISTS)[0].updatedAt).toBe(T0 + 2000)
  })

  it('load 登记的存量形态不在首存被冤枉盖戳', () => {
    const lib = makeLib()
    writeJSON(LS_KEYS.PLAYLISTS, [
      { id: 'old1', name: '旧单', updatedAt: 100, trackCount: 0 },
    ])
    lib.loadPlaylistsFromStorage()
    vi.setSystemTime(T0 + 500)
    lib.savePlaylistsToStorage()
    // updatedAt=100 的存量单纹丝不动——不是「本次改过」
    expect(readJSON(LS_KEYS.PLAYLISTS)[0].updatedAt).toBe(100)
  })

  it('selectPlaylist 簿记写（lastRemoteIds/lastSyncedAt）不抬 updatedAt', async () => {
    writeJSON(LS_KEYS.PLAYLISTS, [{ id: '991', name: '远端单', updatedAt: 100, trackCount: 0 }])
    const lib = makeLib()
    lib.loadPlaylistsFromStorage() // 指纹基线登记存量形态
    vi.setSystemTime(T0 + 5000)
    // getPlaylistDetail 回 null：selectPlaylist 照样走簿记合并（空拉防御三项皆空不炸）
    const ok = await lib.selectPlaylist(lib.userPlaylists.value[0])
    expect(ok).toBe(true)
    const stored = readJSON(LS_KEYS.PLAYLISTS)[0]
    expect(stored.lastSyncedAt).toBe(T0 + 5000) // 簿记真写了
    expect(stored.updatedAt).toBe(100)          // 但浏览≠编辑——戳不抬
    // 簿记值漂移（他端 select 产生的基线差）同样不算内容变更
    lib.userPlaylists.value[0].lastRemoteIds = ['111', '222']
    lib.savePlaylistsToStorage()
    expect(readJSON(LS_KEYS.PLAYLISTS)[0].updatedAt).toBe(100)
    // 真改内容才抬戳
    lib.userPlaylists.value[0].name = '改名'
    lib.savePlaylistsToStorage()
    expect(readJSON(LS_KEYS.PLAYLISTS)[0].updatedAt).toBe(T0 + 5000)
  })

  it('上游漂移簿记（playCount/updateTime 等计数戳）不抬 updatedAt；改 name 仍抬', async () => {
    // 库中远端单的持久化形态带全量上游字段（selectPlaylist 把 detail 回包
    // 整摊进库对象；持久化只剥 tracks/trackIds）
    writeJSON(LS_KEYS.PLAYLISTS, [{
      id: '991', name: '远端单', updatedAt: 100, trackCount: 1,
      playCount: 10, subscribedCount: 2, shareCount: 1, commentCount: 3,
      updateTime: 111, trackNumberUpdateTime: 222, cloudTrackCount: 0,
    }])
    const lib = makeLib()
    lib.loadPlaylistsFromStorage() // 指纹基线登记存量形态
    // detail 回包：同一单但上游簿记全漂移（他人播放/收藏/评论推动的计数）
    musicApi.getPlaylistDetail.mockResolvedValueOnce({
      id: '991', name: '远端单', trackCount: 1,
      playCount: 9999, subscribedCount: 88, shareCount: 7, commentCount: 44,
      updateTime: 333, trackNumberUpdateTime: 444, cloudTrackCount: 1,
      trackIds: [{ id: 't1' }],
      tracks: [{ id: 't1', name: 'S', ar: [{ name: 'a' }], al: { name: 'b' }, dt: 1 }],
    })
    vi.setSystemTime(T0 + 5000)
    const ok = await lib.selectPlaylist(lib.userPlaylists.value[0])
    expect(ok).toBe(true)
    const stored = readJSON(LS_KEYS.PLAYLISTS)[0]
    expect(stored.playCount).toBe(9999) // 上游簿记真落库了
    expect(stored.updateTime).toBe(333)
    expect(stored.updatedAt).toBe(100)  // 但漂移不算编辑——戳不抬不抢 LWW
    // 用户可编辑面（name 等）照常打点
    lib.userPlaylists.value[0].name = '改名'
    lib.savePlaylistsToStorage()
    expect(readJSON(LS_KEYS.PLAYLISTS)[0].updatedAt).toBe(T0 + 5000)
  })

  it('远端 playlist 落 LS 后内存库重建到同一事实源', async () => {
    const lib = makeLib()
    writeJSON(LS_KEYS.PLAYLISTS, [{ id: 'x', name: '旧X', updatedAt: 1 }])
    lib.loadPlaylistsFromStorage()
    expect(lib.userPlaylists.value[0].name).toBe('旧X')
    initSync()
    syncApi.pull.mockResolvedValue({
      code: 200,
      items: [
        { key: 'playlist:x', value: { id: 'x', name: '远端X' }, updatedAt: 999, seq: 30 },
        { key: 'playlist:y', value: { id: 'y', name: '新Y' }, updatedAt: 999, seq: 31 },
      ],
      serverTime: 999,
    })
    await pullFromServer()
    const byId = Object.fromEntries(lib.userPlaylists.value.map(p => [p.id, p]))
    expect(byId.x.name).toBe('远端X')
    expect(byId.y.name).toBe('新Y')
  })

  it('markDirty 显式补记：绕钩写点也能上推送链', async () => {
    initSync()
    localStorage.setItem(LS_KEYS.SETUP_DISMISSED, '1')
    markDirty(LS_KEYS.SETUP_DISMISSED)
    await vi.advanceTimersByTimeAsync(1600)
    const sent = syncApi.push.mock.calls.at(-1)[0].find(c => c.key === docKey(LS_KEYS.SETUP_DISMISSED))
    expect(sent.value).toBe('1')
  })
})

describe('usePlaylistLibrary：存量封面协议相对形自愈（healCoverUrl）', () => {
  // 旧部署导入时服务端 logo 原样透传 '//host/...' 落进 coverImgUrl——
  // proxiedCoverUrl 对 '//' 恒归 ''（fail-closed），存量封面恒落 fallback；
  // 读盘 sanitize 升格 https 并经 healedAny→savePlaylistsToStorage 落盘一次到位
  it("coverImgUrl '//host' 升格 https：内存态与落盘态同愈，干净单不冤枉抬戳", () => {
    // 种子故意不带 trackCount——存根多出的 trackCount:0 即「回写发生过」的观测口
    writeJSON(LS_KEYS.PLAYLISTS, [
      { id: 'q1', name: 'QQ单', coverImgUrl: '//music-file.y.qq.com/x.jpg', updatedAt: 100 },
      { id: 'n1', name: '好单', coverImgUrl: 'https://ok.jpg', updatedAt: 100, trackCount: 3 },
    ])
    const lib = makeLib()
    lib.loadPlaylistsFromStorage()
    expect(lib.userPlaylists.value[0].coverImgUrl).toBe('https://music-file.y.qq.com/x.jpg')
    const stored = readJSON(LS_KEYS.PLAYLISTS)
    expect(stored[0].coverImgUrl).toBe('https://music-file.y.qq.com/x.jpg')
    expect(stored[0].trackCount).toBe(0)   // 回写走的真是 savePlaylistsToStorage 投影
    expect(stored[0].updatedAt).toBe(T0)   // 自愈=内容真变→抬戳，愈合形态随同步收敛他端
    expect(stored[1].coverImgUrl).toBe('https://ok.jpg')
    expect(stored[1].updatedAt).toBe(100)  // 无病单指纹不变——同批回写不冤枉盖戳
  })

  it('http/https/空串封面原样透传；无 heal 不触发回写', () => {
    writeJSON(LS_KEYS.PLAYLISTS, [
      { id: 'h1', name: 'A', coverImgUrl: 'http://qpic.y.qq.com/x', updatedAt: 100 },
      { id: 'e1', name: 'B', coverImgUrl: '', updatedAt: 100 },
      { id: 'u1', name: 'C', updatedAt: 100 }, // 封面字段缺席
    ])
    const lib = makeLib()
    lib.loadPlaylistsFromStorage()
    // http 形态不动——display 层 httpsCover/img-proxy 管；空串照常判死
    expect(lib.userPlaylists.value[0].coverImgUrl).toBe('http://qpic.y.qq.com/x')
    expect(lib.userPlaylists.value[1].coverImgUrl).toBe('')
    expect(lib.userPlaylists.value[2].coverImgUrl).toBeUndefined()
    const stored = readJSON(LS_KEYS.PLAYLISTS)
    // healedAny 假 → 无回写：缺席字段没被注入 '' 死键、种子原样（连 trackCount 都没补）
    expect('coverImgUrl' in stored[2]).toBe(false)
    expect('trackCount' in stored[0]).toBe(false)
    expect(stored.map(p => p.updatedAt)).toEqual([100, 100, 100])
  })

  it("picUrl 历史别名 '//' 同愈（外围空白先剥）；track 内 al.picUrl 不被误碰", () => {
    writeJSON(LS_KEYS.PLAYLISTS, [
      { id: 'p1', name: 'P', picUrl: '  //y.gtimg.cn/m.jpg  ', updatedAt: 100 },
      {
        id: 'local_pl_1', name: '本地单', isLocal: true, updatedAt: 100,
        tracks: [{ id: 1, name: 's', ar: [{ name: 'a' }], al: { name: 'b', picUrl: '//x/y.jpg' }, dt: 1 }],
      },
    ])
    const lib = makeLib()
    lib.loadPlaylistsFromStorage()
    expect(lib.userPlaylists.value[0].picUrl).toBe('https://y.gtimg.cn/m.jpg')
    expect(readJSON(LS_KEYS.PLAYLISTS)[0].picUrl).toBe('https://y.gtimg.cn/m.jpg')
    // 曲目封面归 healExternalAr 管：非 yt/bili 曲的 '//' al.picUrl 原样透传——
    // playlist 级 heal 不误碰，回写链的 slimTrack 投影同样留不住改写
    expect(lib.userPlaylists.value[1].tracks[0].al.picUrl).toBe('//x/y.jpg')
    expect(readJSON(LS_KEYS.PLAYLISTS)[1].tracks[0].al.picUrl).toBe('//x/y.jpg')
  })

  it('远端落盘的 // 封面同样自愈——applyRemoteLibrary 共用 sanitize 口径', async () => {
    writeJSON(LS_KEYS.PLAYLISTS, [{ id: 'x', name: '旧X', updatedAt: 1 }])
    const lib = makeLib()
    lib.loadPlaylistsFromStorage()
    initSync()
    syncApi.pull.mockResolvedValue({
      code: 200,
      items: [{
        key: 'playlist:x',
        value: { id: 'x', name: '远端X', coverImgUrl: '//y.gtimg.cn/r.jpg' },
        updatedAt: 999, seq: 30,
      }],
      serverTime: 999,
    })
    await pullFromServer()
    expect(lib.userPlaylists.value[0].coverImgUrl).toBe('https://y.gtimg.cn/r.jpg')
    expect(readJSON(LS_KEYS.PLAYLISTS)[0].coverImgUrl).toBe('https://y.gtimg.cn/r.jpg')
  })
})

describe('sync 引擎：歌单持久墓碑表（plTomb）', () => {
  it('删单推送失败+重启：持久表续发墓碑，远端旧值不复活', async () => {
    initSync()
    writeJSON(LS_KEYS.PLAYLISTS, [{ id: 'a', name: 'A', updatedAt: 100 }])
    await vi.advanceTimersByTimeAsync(1600)
    expect(syncApi.push).toHaveBeenCalledTimes(1)

    // 删单→推送失败（离线）：墓碑产入 plTomb 持久表但没能上服务端；
    // 墓碑戳=删除发生的那次写刻（打在脏标记，重试/延迟 flush 不漂）
    writeJSON(LS_KEYS.PLAYLISTS, [])
    const deleteTs = Date.now()
    syncApi.push.mockRejectedValueOnce(new Error('offline'))
    await vi.advanceTimersByTimeAsync(1600)
    expect(readJSON(LS_KEYS.SYNC_META).plTomb.a).toBe(deleteTs) // 删除戳已跨会话落盘

    // 重启：会话基线（pushedPlStamps）归零、持久表还在盘上；
    // 服务端那行僵尸值随下一趟 pull 回来
    resetSyncState()
    initSync()
    syncApi.pull.mockResolvedValue({
      code: 200,
      items: [{ key: 'playlist:a', value: { id: 'a', name: '僵尸A' }, updatedAt: 150, seq: 9 }],
      serverTime: 500,
    })
    await pullFromServer()
    // plTomb 戳（真实删除刻 deleteTs）比远端旧值 150 新——拒收不复活
    expect(readJSON(LS_KEYS.PLAYLISTS)).toEqual([])
    // 且标脏回推墓碑——以墓碑赢回删除
    await vi.advanceTimersByTimeAsync(1600)
    const tomb = syncApi.push.mock.calls.at(-1)[0].find(c => c.key === 'playlist:a')
    expect(tomb.deleted).toBe(true)
    expect(tomb.updatedAt).toBe(deleteTs) // 墓碑戳=真实删除刻，重试/跨会话不漂

    // 远端若拿出比墓碑更新的真值（删除后真改过）：复活合法，表项作废
    syncApi.pull.mockResolvedValue({
      code: 200,
      items: [{ key: 'playlist:a', value: { id: 'a', name: '远端真改A' }, updatedAt: T0 + 9000, seq: 10 }],
      serverTime: 500,
    })
    await pullFromServer()
    expect(readJSON(LS_KEYS.PLAYLISTS)[0].name).toBe('远端真改A')
    expect(readJSON(LS_KEYS.SYNC_META).plTomb?.a).toBeUndefined()
  })
})

describe('sync 引擎：首同步播种戳', () => {
  it('firstSync 存量 doc/歌单盖极小戳——远端只要有真实戳就经 conflicts 采纳', async () => {
    // 存量数据 + 无任何同步态（无 since 无 meta）→ firstSync 播种
    localStorage.setItem(LS_KEYS.THEME, 'local-old')
    writeJSON(LS_KEYS.PLAYLISTS, [{ id: 'a', name: '本地A' }]) // 无 updatedAt 存量单
    initSync()
    syncApi.push.mockResolvedValue({
      code: 200, applied: [],
      conflicts: [
        { key: docKey(LS_KEYS.THEME), item: { value: 'remote-new', updatedAt: T0 - 1000, deleted: false, seq: 5 } },
        { key: 'playlist:a', item: { value: { id: 'a', name: '远端A' }, updatedAt: 200, deleted: false, seq: 6 } },
      ],
      rejected: [],
    })
    await vi.advanceTimersByTimeAsync(1600)
    const sent = syncApi.push.mock.calls[0][0]
    expect(sent.find(c => c.key === docKey(LS_KEYS.THEME)).updatedAt).toBe(1)
    expect(sent.find(c => c.key === 'playlist:a').updatedAt).toBe(1) // 存量单同盖小戳
    // 远端戳比「现在」旧也照样赢——小戳不拿首同步刻压人
    expect(localStorage.getItem(LS_KEYS.THEME)).toBe('remote-new')
    expect(readJSON(LS_KEYS.PLAYLISTS)[0].name).toBe('远端A')
  })

  it('init 前 pendingWrites 回放不污染 firstSync：其余存量键仍盖 SEED_TS 播种', async () => {
    // 生产链：App.vue setup 顶挂写钩→initSync 前 savePlayerStateToStorage
    // 几乎必跑→PLAYER_STATE 进 pendingWrites→回放盖 meta。firstSync 判定
    // 若排在回放后，META_KEY 已被建→存量播种恒不触发（旧实现即此 bug）
    attachWriteHook()
    writeJSON(LS_KEYS.PLAYER_STATE, { volume: 1 }) // init 前白名单写→pending 集
    localStorage.setItem(LS_KEYS.THEME, 'local-old') // 存量键：裸写不沾 pending
    initSync()
    await vi.advanceTimersByTimeAsync(1600)
    const sent = syncApi.push.mock.calls[0][0]
    // 回放键按「刚写过」拿 now 戳；存量 THEME 走 firstSync 播种盖 SEED_TS
    expect(sent.find(c => c.key === docKey(LS_KEYS.PLAYER_STATE)).updatedAt).toBe(T0)
    expect(sent.find(c => c.key === docKey(LS_KEYS.THEME)).updatedAt).toBe(1)
  })
})

describe('sync 引擎：防抖截尾与补拉', () => {
  it('连续脏写（播放中 ~1/s 存档档）超 maxWait 窗必发——防抖不饿死', async () => {
    initSync()
    // 每 1s 一写永远踩在 1.5s 防抖窗内重排；15s 截尾从首脏起算必 flush
    for (let i = 0; i < 16; i++) {
      writeJSON(LS_KEYS.PLAYER_STATE, { t: i })
      await vi.advanceTimersByTimeAsync(1000)
    }
    expect(syncApi.push).toHaveBeenCalledTimes(1) // 写不停也发出去了
    // 写停后恢复 trailing 语义：1.5s 聚合窗口照常
    writeJSON(LS_KEYS.PLAYER_STATE, { t: 99 })
    await vi.advanceTimersByTimeAsync(1600)
    expect(syncApi.push).toHaveBeenCalledTimes(2)
  })

  it('flush 在途期撞闸耗散的防抖定时器：完成后重排补发，新脏不停摆', async () => {
    initSync()
    let release
    syncApi.push.mockImplementationOnce(() => new Promise(r => { release = r }))
    writeJSON(LS_KEYS.PLAYER_STATE, { t: 1 })
    await vi.advanceTimersByTimeAsync(1600) // flush#1 发出并挂起在 push
    expect(syncApi.push).toHaveBeenCalledTimes(1)
    // 在途期新脏：scheduleFlush 排的 1.5s 定时器触发时撞 flushing 闸早退——
    // 定时器已耗散，flush#1 收尾必须重排，否则这批脏停摆到下一写事件
    writeJSON(LS_KEYS.PLAY_HISTORY, [{ id: 1 }])
    await vi.advanceTimersByTimeAsync(1600)
    expect(syncApi.push).toHaveBeenCalledTimes(1) // 定时器被吞——不并发双推
    release({ code: 200, applied: [], conflicts: [], rejected: [] })
    // flush#1 的 finally 在微任务里收尾重排——先放两拍再拨防抖窗
    await Promise.resolve()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(1600)
    expect(syncApi.push).toHaveBeenCalledTimes(2)
    const keys2 = syncApi.push.mock.calls[1][0].map(c => c.key)
    expect(keys2).toContain(docKey(LS_KEYS.PLAY_HISTORY))
    expect(keys2).not.toContain(docKey(LS_KEYS.PLAYER_STATE)) // 已成功不回声
  })

  it('init 前的白名单写进 pending 集：initSync 统一回放记脏推送', async () => {
    writeJSON(LS_KEYS.SYNC_SINCE, 5) // 已有同步态——非 firstSync 不补种
    attachWriteHook() // 生产在 App.vue setup 顶挂钩
    writeJSON(LS_KEYS.PLAY_HISTORY, [{ id: 1 }])
    writeJSON(LS_KEYS.PLAYLISTS, [{ id: 'p1', name: 'P', updatedAt: 100 }])
    initSync()
    await vi.advanceTimersByTimeAsync(1600)
    const keys = syncApi.push.mock.calls[0][0].map(c => c.key)
    expect(keys).toContain(docKey(LS_KEYS.PLAY_HISTORY))
    expect(keys).toContain('playlist:p1')
  })

  it('播放上下文壳（single_song_/saved_queue_）不主动推，正常单照推', async () => {
    initSync()
    writeJSON(LS_KEYS.PLAYLISTS, [
      { id: 'single_song_9', name: '壳', tracks: [], updatedAt: 100 },
      { id: `saved_queue_${T0}`, name: '队列', tracks: [], updatedAt: 100 },
      { id: 'local_pl_1690000000000', name: '正常单', tracks: [], updatedAt: 1690000000000 },
    ])
    await vi.advanceTimersByTimeAsync(1600)
    const keys = syncApi.push.mock.calls[0][0].map(c => c.key)
    expect(keys).toContain('playlist:local_pl_1690000000000')
    expect(keys).toContain('lib:index')
    expect(keys).not.toContain('playlist:single_song_9')
    expect(keys).not.toContain(`playlist:saved_queue_${T0}`)
  })
})

describe('App.vue：WATCH_TAB 远端应用窗', () => {
  it('远端非法 tab 值：内存回落 queue 但不回写 LS、不记脏推回降级值', async () => {
    writeJSON(LS_KEYS.WATCH_TAB, 'lyrics') // 本机停在合法 tab
    const wrapper = shallowMount(App)
    // onMounted 链跑到 initSync+pullFromServer 为止（pull 被调即初始化完成）
    await vi.waitFor(() => expect(syncApi.pull).toHaveBeenCalled())
    // 首拉在途时 pullFromServer 返回同一 Promise——等它消化完再换 mock，
    // 否则下面那次调用拿到的是旧 pull，新 mock 永远不会被调
    await pullFromServer()
    syncApi.pull.mockResolvedValue({
      code: 200,
      items: [{
        key: docKey(LS_KEYS.WATCH_TAB),
        value: JSON.stringify('bogus'), // 远端存着本版不认识的 tab
        updatedAt: T0 + 6000, seq: 3,
      }],
      serverTime: T0 + 6000,
    })
    await pullFromServer()
    await nextTick()
    // ref 已回落 queue（内存归一），但 LS 保持远端原文——降级值不写盘
    expect(localStorage.getItem(LS_KEYS.WATCH_TAB)).toBe(JSON.stringify('bogus'))
    await vi.advanceTimersByTimeAsync(4000)
    const sentTab = syncApi.push.mock.calls
      .flatMap(c => c[0])
      .filter(c => c.key === docKey(LS_KEYS.WATCH_TAB))
    // 推回的（若有）只能是远端原文/初始值回声——绝不能是本机降级出的 'queue'
    expect(sentTab.every(c => c.value !== JSON.stringify('queue'))).toBe(true)
    wrapper.unmount()
  })
})

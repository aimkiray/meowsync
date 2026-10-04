// src/api/* 客户端契约：axios 实例全 mock（拦截器仍走真实现——剥壳/踢门
// 逻辑是被测面），断言 unwrapBody 抛错、data 提取、分页/URL 拼接形状。
import { describe, it, expect, vi, beforeEach } from 'vitest'

// axios mock：保留拦截器注册面（http.js 的 req/res 拦截器要真跑），
// 动词函数按调用逐个 stub
const httpCalls = []
const { interceptors, mockInstance } = vi.hoisted(() => {
  const interceptors = { req: [], res: [] }
  const mockInstance = {
    interceptors: {
      request: { use: (f, e) => interceptors.req.push([f, e]) },
      response: { use: (f, e) => interceptors.res.push([f, e]) },
    },
    get: null, post: null, put: null, delete: null,
  }
  return { interceptors, mockInstance }
})
vi.mock('axios', () => ({ default: { create: () => mockInstance } }))

import axios from 'axios'
const http = axios.create()
// vi.fn() 不可在 hoisted 阶段创建——模块体运行期再替换占位
for (const m of ['get', 'post', 'put', 'delete']) http[m] = vi.fn()
import { API_BASE_URL } from '../../src/api/http.js'
import { musicApi } from '../../src/api/music.js'
import { downloadsApi } from '../../src/api/downloads.js'
import { settingsApi } from '../../src/api/settings.js'
import { authState } from '../../src/lib/auth-state.js'

beforeEach(() => {
  vi.clearAllMocks()
  httpCalls.length = 0
  for (const m of ['get', 'post', 'put', 'delete']) {
    http[m].mockImplementation(async (url, cfg) => {
      httpCalls.push({ method: m, url, cfg })
      return mockResponses[m]?.[url] ?? { code: 200 }
    })
  }
})
let mockResponses = {}
const setResponses = (r) => { mockResponses = r }

// 响应拦截器剥 r.data——mock 返回的就是服务端 body {code,...}

describe('musicApi：歌单详情两段请求 + 字段形状', () => {
  it('getPlaylistDetail：trackIds 全长做 limit，合并 tracks 返回', async () => {
    setResponses({
      get: {
        '/playlist_detail': { code: 200, playlist: { id: 42, name: '歌单', trackIds: [1, 2, 3], trackCount: 3 } },
        '/playlist_track_all': { code: 200, songs: [{ id: 1 }, { id: 2 }, { id: 3 }] },
      },
    })
    const pl = await musicApi.getPlaylistDetail(42)
    expect(pl.name).toBe('歌单')
    expect(pl.tracks).toHaveLength(3)
    const trackReq = httpCalls.find(c => c.url === '/playlist_track_all')
    expect(trackReq.cfg.params).toMatchObject({ id: 42, limit: 3 }) // limit=trackIds.length 而非 trackCount
  })

  it('getPlaylistDetail：track_all 上游业务码非 200 抛错（不吞成空歌单）', async () => {
    setResponses({
      get: {
        '/playlist_detail': { code: 200, playlist: { id: 42, trackIds: [1] } },
        '/playlist_track_all': { code: 400 },
      },
    })
    await expect(musicApi.getPlaylistDetail(42)).rejects.toThrow('歌单曲目接口返回 code=400')
  })

  it('getSongUrl：data[0] 提取 + 实际码率回落', async () => {
    setResponses({
      get: { '/song_url': { code: 200, data: [{ url: 'https://cdn/x.mp3', br: 256000 }] } },
    })
    const s = await musicApi.getSongUrl(99)
    expect(s.url).toBe('https://cdn/x.mp3')
    expect(s.bitrate).toBe(256000) // 记录实际 br 而非请求值
  })

  it('getSongUrl：freeTrialInfo 试听档判不可用', async () => {
    setResponses({
      get: { '/song_url': { code: 200, data: [{ url: 'https://cdn/trial.mp3', freeTrialInfo: { start: 0, end: 30 } }] } },
    })
    await expect(musicApi.getSongUrl(99)).rejects.toThrow(/版权限制/)
  })

  it('unwrapBody：反代误返 HTML 串判形态错误', async () => {
    setResponses({ get: { '/cloudsearch': '<!DOCTYPE html><html></html>' } })
    await expect(musicApi.searchSongs('x')).rejects.toThrow('接口返回异常')
  })

  it('searchSongsPage：返回 {songs,total} 分页形状', async () => {
    setResponses({
      get: { '/cloudsearch': { code: 200, result: { songs: [{ id: 7 }], songCount: 61 } } },
    })
    const r = await musicApi.searchSongsPage('q', { limit: 20, offset: 40 })
    expect(r).toEqual({ songs: [{ id: 7 }], total: 61 })
    expect(httpCalls.at(-1).cfg.params).toMatchObject({ keywords: 'q', type: 1, limit: 20, offset: 40 })
  })
})

describe('downloadsApi：队列/任务形状', () => {
  it('createQueue：默认选项序列化 + 60s 超时通道', async () => {
    setResponses({ post: { '/downloads/queues': { code: 200, data: { id: 5, status: 'pending' } } } })
    const r = await downloadsApi.createQueue(9)
    expect(r.data.id).toBe(5)
    // axios post(url, data, config)——data 是第二参
    const [, data, cfg] = http.post.mock.calls.at(-1)
    expect(data).toMatchObject({
      playlistId: 9, bitrate: 320000, downloadAudio: true,
      downloadLyrics: true, downloadCover: true, downloadVideo: false,
    })
    expect(cfg.timeout).toBe(60000)
  })

  it('getSongDownloadStatus：playlistId 进 params，signal 透传', async () => {
    const sig = new AbortController().signal
    setResponses({ get: { '/downloads/songs/s1/status': { code: 200, data: { downloaded: true, task: { audioPath: 'p' } } } } })
    const r = await downloadsApi.getSongDownloadStatus(3, 's1', sig)
    expect(r.data.downloaded).toBe(true)
    const [, cfg] = http.get.mock.calls.at(-1)
    expect(cfg.params).toEqual({ playlistId: 3 })
    expect(cfg.signal).toBe(sig)
  })

  it('songFileUrl：拼 API_BASE_URL + encodeURIComponent + kind', () => {
    const u = downloadsApi.songFileUrl(7, 'bv_ABC def', 'video')
    expect(u.startsWith(`${API_BASE_URL}/downloads/songs/`)).toBe(true)
    expect(u).toContain('bv_ABC%20def')
    expect(u).toContain('playlistId=7')
    expect(u).toContain('kind=video')
  })

  it('deleteQueue：级联删除用 90s 超时', async () => {
    setResponses({ delete: { '/downloads/queues/5': { code: 200, data: { success: true } } } })
    await downloadsApi.deleteQueue(5)
    const [, cfg] = http.delete.mock.calls.at(-1)
    expect(cfg.timeout).toBe(90000)
  })
})

describe('settingsApi：GET/PUT/ai-test 通道', () => {
  it('get/save/testAi 端点与载荷', async () => {
    setResponses({
      get: { '/settings': { code: 200, fields: { ai_model: { source: 'env' } }, ai: { enabled: true } } },
      put: { '/settings': { code: 200, fields: {} } },
      post: { '/settings/ai-test': { code: 200, ok: true, modelCount: 2 } },
    })
    const g = await settingsApi.get()
    expect(g.fields.ai_model.source).toBe('env')
    await settingsApi.save({ ai_model: 'm1' })
    const [, body, cfg] = http.put.mock.calls.at(-1)
    expect(body).toEqual({ ai_model: 'm1' })
    expect(cfg.timeout).toBe(10000)
    const t = await settingsApi.testAi({ baseUrl: 'http://x' })
    expect(t.ok).toBe(true)
    expect(http.post.mock.calls.at(-1)[0]).toBe('/settings/ai-test')
  })
})

describe('http.js 拦截器', () => {
  it('401 + x-ms-auth:required → authState 踢门标记；裸 401 不动', async () => {
    const [okFn, errFn] = interceptors.res[0]
    authState.enabled = false; authState.authenticated = true; authState.expired = false

    const kickErr = {
      response: { status: 401, headers: { 'x-ms-auth': 'required' } },
      config: { url: '/downloads/queues' },
    }
    await expect(errFn(kickErr)).rejects.toBe(kickErr)
    expect(authState.expired).toBe(true)
    expect(authState.authenticated).toBe(false)
    expect(authState.enabled).toBe(true)

    // 上游透传裸 401（无标记头）不误触登出；/auth/* 自身 401 也不踢
    authState.expired = false; authState.authenticated = true
    const bare401 = { response: { status: 401, headers: {} }, config: { url: '/song_url' } }
    await expect(errFn(bare401)).rejects.toBe(bare401)
    expect(authState.expired).toBe(false)
    const authSelf = { response: { status: 401, headers: { 'x-ms-auth': 'required' } }, config: { url: '/auth/login' } }
    await expect(errFn(authSelf)).rejects.toBe(authSelf)
    expect(authState.expired).toBe(false)
  })

  it('请求拦截器注入 _t 防缓存参数', () => {
    const [reqFn] = interceptors.req[0]
    const cfg = reqFn({ url: '/x', headers: {}, params: { a: 1 } })
    expect(cfg.params.a).toBe(1)
    expect(typeof cfg.params._t).toBe('number')
  })
})

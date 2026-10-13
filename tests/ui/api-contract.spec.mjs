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

describe('musicApi：QQ 源端点契约', () => {
  it('searchQQSongs：{songs,total} 形 + p/limit 页码参数进 params', async () => {
    setResponses({
      get: { '/qq/search': { code: 200, list: [{ mid: 'm1' }], total: 600, page: 2 } },
    })
    const r = await musicApi.searchQQSongs('x', { limit: 5, page: 2 })
    expect(r).toEqual({ songs: [{ mid: 'm1' }], total: 600 })
    expect(httpCalls.at(-1).cfg.params).toMatchObject({ q: 'x', p: 2, limit: 5 })
    expect(httpCalls.at(-1).cfg.timeout).toBe(30000) // 三跳最坏 ~45s 内的客户端上限
  })

  it('searchQQSongs：total 缺席 → null（深挖灭灯语义）', async () => {
    setResponses({ get: { '/qq/search': { code: 200, list: [] } } })
    const r = await musicApi.searchQQSongs('x')
    expect(r).toEqual({ songs: [], total: null })
  })

  it('searchQQSuggest/getQQHot/searchQQPlaylists/getQQSimilar 形状与 params', async () => {
    setResponses({
      get: {
        '/qq/suggest': { code: 200, result: { allMatch: [{ keyword: 'k' }], songs: [{ name: 's' }] } },
        '/qq/hot': { code: 200, result: { hots: [{ first: 'h' }] } },
        '/qq/search-playlists': { code: 200, playlists: [{ disstid: '1', provider: 'qq' }], total: 9 },
        '/qq/similar': { code: 200, list: [{ mid: 'm2' }], degraded: true },
      },
    })
    expect(await musicApi.searchQQSuggest('k')).toMatchObject({ allMatch: [{ keyword: 'k' }] })
    expect(httpCalls.at(-1).cfg.params).toMatchObject({ key: 'k' })
    expect(await musicApi.getQQHot()).toEqual([{ first: 'h' }])
    const pl = await musicApi.searchQQPlaylists('q', { page: 3, limit: 10 })
    expect(pl).toEqual({ playlists: [{ disstid: '1', provider: 'qq' }], total: 9 })
    expect(httpCalls.at(-1).cfg.params).toMatchObject({ q: 'q', p: 3, limit: 10 })
    expect(httpCalls.at(-1).cfg.timeout).toBe(20000)
    const sim = await musicApi.getQQSimilar('001mid00000xx')
    expect(sim).toEqual({ songs: [{ mid: 'm2' }], degraded: true })
    expect(httpCalls.at(-1).cfg.params).toMatchObject({ songmid: '001mid00000xx' })
  })

  it('getQQPlaylist：id 进 params + 90s 串行拉页超时', async () => {
    setResponses({ get: { '/qq/playlist': { code: 200, name: 'P', tracks: [] } } })
    const r = await musicApi.getQQPlaylist('777')
    expect(r.name).toBe('P')
    expect(httpCalls.at(-1).cfg.params).toEqual({ id: '777' })
    expect(httpCalls.at(-1).cfg.timeout).toBe(90000) // 串行分页上界 ~75s 上留余
  })

  it('QQ 端点 code!==200 抛错透服务端 message', async () => {
    setResponses({
      get: {
        '/qq/search': { code: 502, message: 'QQ 音乐搜索失败: x' },
        '/qq/suggest': { code: 500, message: 'QQ 搜索建议失败: y' },
        '/qq/hot': { code: 500, message: 'QQ 热搜获取失败: z' },
        '/qq/search-playlists': { code: 502, message: 'QQ 歌单搜索失败: w' },
        '/qq/similar': { code: 502, message: 'QQ 相似歌曲获取失败: v' },
      },
    })
    await expect(musicApi.searchQQSongs('x')).rejects.toThrow('QQ 音乐搜索失败')
    await expect(musicApi.searchQQSuggest('x')).rejects.toThrow('QQ 搜索建议失败')
    await expect(musicApi.getQQHot()).rejects.toThrow('QQ 热搜获取失败')
    await expect(musicApi.searchQQPlaylists('x')).rejects.toThrow('QQ 歌单搜索失败')
    await expect(musicApi.getQQSimilar('m')).rejects.toThrow('QQ 相似歌曲获取失败')
  })
})

describe('musicApi：上游业务码 code!==200 不吞成空态', () => {
  it('搜索系（歌单/建议/单曲/深挖/推荐/热搜）code!==200 抛错', async () => {
    setResponses({
      get: {
        '/search': { code: 301 },
        '/search_suggest': { code: 460 },
        '/cloudsearch': { code: 301 },
        '/personalized': { code: 400 },
        '/search_hot': { code: 500 },
      },
    })
    await expect(musicApi.searchPlaylists('x')).rejects.toThrow(/code 301/)
    await expect(musicApi.searchSuggest('x')).rejects.toThrow(/code 460/)
    await expect(musicApi.searchSongs('x')).rejects.toThrow(/code 301/)
    await expect(musicApi.searchSongsPage('x')).rejects.toThrow(/code 301/)
    await expect(musicApi.getPersonalized()).rejects.toThrow(/code 400/)
    await expect(musicApi.getSearchHot()).rejects.toThrow(/code 500/)
  })

  it('getLyrics：code!==200 抛错而非归一「没词」', async () => {
    setResponses({ get: { '/lyric': { code: 460 } } })
    await expect(musicApi.getLyrics(1)).rejects.toThrow(/code 460/)
  })

  it('getSongUrl：双码率都 code!==200——透出业务码而非塌缩成版权限制', async () => {
    setResponses({ get: { '/song_url': { code: 301 } } })
    await expect(musicApi.getSongUrl(1)).rejects.toThrow(/code 301/)
  })

  it('getSongDetail：code!==200 先于「歌曲不存在」抛错', async () => {
    setResponses({ get: { '/song_detail': { code: 400 } } })
    await expect(musicApi.getSongDetail(1)).rejects.toThrow(/code 400/)
  })

  it('getMatchState：code!==200 抛错（match:null 才归 null）', async () => {
    setResponses({ get: { '/match/state': { code: 400 } } })
    await expect(musicApi.getMatchState('yt_x')).rejects.toThrow(/code 400/)
    setResponses({ get: { '/match/state': { code: 200, match: null } } })
    expect(await musicApi.getMatchState('yt_x')).toBeNull()
  })

  it('getExternalLyric：body code:404 归 null；其它业务码抛错', async () => {
    setResponses({ get: { '/lyric/external': { code: 404, message: '无匹配' } } })
    expect(await musicApi.getExternalLyric({ id: 'yt_x', title: 't', artist: 'a', durationSec: 10 })).toBeNull()
    setResponses({ get: { '/lyric/external': { code: 502, message: '上游挂' } } })
    await expect(musicApi.getExternalLyric({ id: 'yt_x', title: 't', artist: 'a', durationSec: 10 }))
      .rejects.toThrow(/code 502/)
  })

  it('getDownloadUrl：code!==200 透出业务码（err.bizCode）而非塌缩成「无法获取」', async () => {
    setResponses({ get: { '/song_url': { code: 404 } } })
    await expect(musicApi.getDownloadUrl(1)).rejects.toThrow(/code 404/)
    setResponses({ get: { '/song_url': { code: 301 } } })
    await expect(musicApi.getDownloadUrl(1)).rejects.toMatchObject({ bizCode: 301 })
  })

  it('getDownloadUrl：正常回包提取 url/br/size/type', async () => {
    setResponses({ get: { '/song_url': { code: 200, data: [{ url: 'https://cdn/a.mp3', br: 320000, size: 1024 }] } } })
    const r = await musicApi.getDownloadUrl(9)
    expect(r).toMatchObject({ url: 'https://cdn/a.mp3', bitrate: 320000, size: 1024, type: 'mp3' })
    // purpose=download 是服务端路由分流键——丢了会按 playback 语义走解锁链
    expect(httpCalls.at(-1).cfg.params.purpose).toBe('download')
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

  it('mirrorLocalPlaylist：非数组 artists/字符串专辑名归一不丢不炸', async () => {
    setResponses({ post: { '/downloads/local/mirror': { code: 200, data: {} } } })
    await downloadsApi.mirrorLocalPlaylist({
      id: 'local_pl_x', name: 'P',
      tracks: [
        // artists 非数组（脏数据）：旧实现 .map 直接 TypeError
        { id: 1, name: 'a', artists: 42, al: { name: '专辑A', picUrl: 'p' } },
        // 字符串专辑名：obj?.name 读不到会静默丢名
        { id: 2, name: 'b', artists: '某艺人', al: '字符串专辑' },
        null, // 空槽原样透传
      ],
    })
    const [, body] = http.post.mock.calls.at(-1)
    expect(body.tracks[0].ar).toEqual([])
    expect(body.tracks[0].al).toMatchObject({ name: '专辑A', picUrl: 'p' })
    expect(body.tracks[1].ar).toEqual([{ name: '某艺人' }])
    expect(body.tracks[1].al.name).toBe('字符串专辑')
    expect(body.tracks[2]).toBeNull()
  })

  it('mirrorLocalPlaylist：ar 数组成员是裸字符串不丢艺人名', async () => {
    // ar:['Jay'] 若只读 a?.name 会产 {name:undefined}——slimTrack 同口径：
    // 对象取 name、字符串透传
    setResponses({ post: { '/downloads/local/mirror': { code: 200, data: {} } } })
    await downloadsApi.mirrorLocalPlaylist({
      id: 'local_pl_x', name: 'P',
      tracks: [
        { id: 1, name: 'a', ar: ['周杰伦', '方文山'] },
        { id: 2, name: 'b', artists: ['裸串也收'] },
        { id: 3, name: 'c', ar: [{ name: '对象形' }, '混排串'] },
      ],
    })
    const [, body] = http.post.mock.calls.at(-1)
    expect(body.tracks[0].ar).toEqual([{ name: '周杰伦' }, { name: '方文山' }])
    expect(body.tracks[1].ar).toEqual([{ name: '裸串也收' }])
    expect(body.tracks[2].ar).toEqual([{ name: '对象形' }, { name: '混排串' }])
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

// 「手动匹配歌词」钉板（vitest+jsdom）：
//   LyricPicker — 开屏并行拉「外部词源候选 + 现有绑定」（检索喂料与
//                 usePlayer.lyricSearchFeed 同口径）、词源徽标/时长/滚动性/
//                 预览行渲染、选定→POST 绑定→applied+关窗、词源失效 404
//                 「该词源已失效」内联留窗、恢复自动匹配解绑、Esc/遮罩三点
//                 关窗（busy 期失效）、卸载/重载断在飞请求
//   musicApi 契约 — 真 wrapper 走假 http 层：getManualLyric HTTP 404→null、
//                 pick/clear 调用形状与业务码闸（与 api-contract 谱同型，
//                 收本文件避开其文件域）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'

const { musicApi, toast } = vi.hoisted(() => ({
  musicApi: {
    getLyricCandidates: vi.fn(async () => []),
    getManualLyric: vi.fn(async () => null),
    pickManualLyric: vi.fn(async () => ({})),
    clearManualLyric: vi.fn(async () => ({})),
  },
  toast: vi.fn(() => 1),
}))
vi.mock('../../src/api/music.js', () => ({ musicApi }))
vi.mock('../../src/lib/feedback.js', () => ({ toast }))
// http 层替身：组件报错文案走 apiErrorMessage；契约用例借 importActual
// 拿到真 musicApi，其 api.* 调用落在这个假 axios 面上
vi.mock('../../src/api/http.js', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
  API_BASE_URL: 'http://api.test',
  apiErrorMessage: (e) => e?.response?.data?.message || e?.message || '接口异常',
  downloadTokenHeaders: () => ({}),
}))

import http from '../../src/api/http.js'
import LyricPicker from '../../src/components/LyricPicker.vue'

const flush = () => new Promise(r => setTimeout(r, 0))

// youtube 块在场时检索喂料以 provider 块为准（lyricSearchFeed 同口径）
const SONG = {
  id: 'yt_abc',
  name: '手改曲名',
  ar: [{ name: '甲' }, { name: '乙' }],
  dt: 205000,
  youtube: { title: 'YT Title', author: 'YT Artist' }
}

const CANDIDATES = [
  {
    extId: 'lrclib_1', source: 'lrclib', title: 'Song', artist: 'Artist',
    durationSec: 200, synced: true, preview: 'first line of lrc'
  },
  {
    extId: 'kugou_2', source: 'kugou', title: 'Song', artist: 'Artist',
    durationSec: 203, synced: false, preview: '', token: 'tk-1'
  },
  {
    extId: 'ytm_3', source: 'ytm', title: 'Song Alt', artist: '',
    durationSec: 0, synced: true, preview: 'ytm preview'
  }
]

// Teleport 到 body——DOM 断言/派发一律走 document，wrapper 只收 emitted
const mounted = []
const mountPicker = (props = {}) => {
  const w = mount(LyricPicker, { attachTo: document.body, props: { song: SONG, ...props } })
  mounted.push(w)
  return w
}
const dialogEl = () => document.querySelector('.lp-dialog')
const overlayEl = () => document.querySelector('.atp-overlay')
const rowEls = () => [...document.querySelectorAll('.lp-row')]
const keydown = (el, key) => el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))

beforeEach(() => {
  vi.clearAllMocks()
  musicApi.getLyricCandidates.mockResolvedValue([...CANDIDATES])
  musicApi.getManualLyric.mockResolvedValue(null)
  musicApi.pickManualLyric.mockResolvedValue({ code: 200 })
  musicApi.clearManualLyric.mockResolvedValue({ code: 200 })
})
afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  document.body.innerHTML = ''
})

describe('LyricPicker：候选列表', () => {
  it('开屏并行拉候选+现有绑定；行渲染徽标/标题/时长/滚动性/预览', async () => {
    mountPicker()
    await flush()
    // 喂料：provider 块标题作者优先，dt(ms)→durationSec 换算
    expect(musicApi.getLyricCandidates).toHaveBeenCalledWith(
      { id: 'yt_abc', title: 'YT Title', artist: 'YT Artist', durationSec: 205 },
      expect.any(AbortSignal)
    )
    expect(musicApi.getManualLyric).toHaveBeenCalledWith('yt_abc', expect.any(AbortSignal))

    const rows = rowEls()
    expect(rows).toHaveLength(3)
    const badges = [...document.querySelectorAll('.lp-badge')].map(b => b.textContent)
    expect(badges).toEqual(['LRC', 'KGM', 'YTM'])
    expect(rows[0].textContent).toContain('Song — Artist')
    expect(rows[0].textContent).toContain('3:20')   // 200s → m:ss
    expect(rows[0].textContent).toContain('滚动')
    expect(rows[0].querySelector('.lp-preview')?.textContent).toBe('first line of lrc')
    // kugou 的 synced:false 是「接口不回报滚动性」的未知，不是纯文本——不谎标
    expect(rows[1].querySelector('.lp-tag').textContent).toBe('未知')
    expect(rows[1].querySelector('.lp-preview')).toBeNull() // 空预览不出第二行
    expect(rows[2].querySelector('.lp-dur')).toBeNull()     // durationSec 缺席不出时长
    // 无手动绑定 → 页脚「恢复自动匹配」不出
    expect(document.querySelector('.lp-clear')).toBeNull()
  })

  it('无 youtube/bilibili 块时喂料回落曲面字段（name + ar 艺人拼 /）', async () => {
    mountPicker({ song: { id: 7, name: '曲', artists: [{ name: 'A' }, { name: 'B' }], duration: 60000 } })
    await flush()
    expect(musicApi.getLyricCandidates).toHaveBeenCalledWith(
      { id: 7, title: '曲', artist: 'A/B', durationSec: 60 },
      expect.any(AbortSignal)
    )
  })

  it('song.custom 手改曲：检索标题以手改名 song.name 优先（manualFetchLyrics 同口径）', async () => {
    mountPicker({ song: { ...SONG, custom: true } })
    await flush()
    // custom=true 是「SongFormDialog 手改过名」信号——手改曲名优先于 provider 原标题
    expect(musicApi.getLyricCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'yt_abc', title: '手改曲名', artist: 'YT Artist' }),
      expect.any(AbortSignal)
    )
  })

  it('滚动性标签分源：kugou 的 synced:false 是「未知」，lrclib 仍标纯文本', async () => {
    musicApi.getLyricCandidates.mockResolvedValue([
      { extId: 'kugou_1', source: 'kugou', title: 'A', synced: false },
      { extId: 'lrclib_2', source: 'lrclib', title: 'B', synced: false },
      { extId: 'ytm_3', source: 'ytm', title: 'C', synced: true },
    ])
    mountPicker()
    await flush()
    const tags = [...document.querySelectorAll('.lp-tag')].map(t => t.textContent)
    expect(tags).toEqual(['未知', '纯文本', '滚动'])
  })

  it('候选检索失败 → 错误态文案 + 「重试」键再发一轮', async () => {
    musicApi.getLyricCandidates.mockRejectedValueOnce(new Error('boom'))
    mountPicker()
    await flush()
    expect(document.querySelector('.lp-state')?.textContent).toContain('检索失败')
    expect(document.querySelector('.lp-state')?.textContent).toContain('boom')
    expect(rowEls()).toHaveLength(0)
    document.querySelector('.lp-retry button')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(musicApi.getLyricCandidates).toHaveBeenCalledTimes(2)
    // 第二轮回默认实现的候选列表——错误态退场
    expect(rowEls()).toHaveLength(3)
    expect(document.querySelector('.lp-state')).toBeNull()
  })

  it('加载中与空候选两态文案', async () => {
    musicApi.getLyricCandidates.mockReturnValue(new Promise(() => {})) // 挂起停在加载态
    mountPicker()
    await flush()
    expect(document.querySelector('.lp-state')?.textContent).toContain('正在检索外部词源')
    mounted.pop().unmount()
    document.body.innerHTML = ''

    musicApi.getLyricCandidates.mockResolvedValue([])
    mountPicker()
    await flush()
    expect(document.querySelector('.lp-state')?.textContent).toContain('没有这首歌的候选歌词')
    expect(rowEls()).toHaveLength(0)
  })
})

describe('LyricPicker：选定/解绑', () => {
  it('点候选 → POST {id,extId,token} → applied+close+成功 toast', async () => {
    const w = mountPicker()
    await flush()
    rowEls()[1].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(musicApi.pickManualLyric).toHaveBeenCalledWith({ id: 'yt_abc', extId: 'kugou_2', token: 'tk-1' })
    expect(w.emitted('applied')).toEqual([['yt_abc']])
    expect(w.emitted('close')).toHaveLength(1)
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('KGM'), 'success')
  })

  it('绑定 404 → 内联「该词源已失效」留窗，不 applied 不关窗', async () => {
    const err = new Error('gone')
    err.response = { status: 404 }
    musicApi.pickManualLyric.mockRejectedValue(err)
    const w = mountPicker()
    await flush()
    rowEls()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(document.querySelector('.lp-pickerr')?.textContent).toBe('该词源已失效')
    expect(w.emitted('applied')).toBeUndefined()
    expect(w.emitted('close')).toBeUndefined()
    expect(dialogEl()).toBeTruthy() // 窗还在
  })

  it('绑定其它错误 → error toast 留窗重挑', async () => {
    musicApi.pickManualLyric.mockRejectedValue(new Error('boom'))
    const w = mountPicker()
    await flush()
    rowEls()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(toast).toHaveBeenCalledWith('boom', 'error')
    expect(w.emitted('applied')).toBeUndefined()
    expect(dialogEl()).toBeTruthy()
  })

  it('开窗后 prop 换歌不串绑：pick 仍提交开窗曲 id（song0 快照钉死）', async () => {
    // 媒体键/遥控切歌会换 currentSong——prop 是活引用，本窗语义钉在 song0
    const w = mountPicker() // SONG.id = 'yt_abc'
    await flush()
    await w.setProps({ song: { id: 'yt_other', name: '切走的新歌', ar: [] } })
    rowEls()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(musicApi.pickManualLyric).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'yt_abc', extId: 'lrclib_1' }))
    expect(w.emitted('applied')).toEqual([['yt_abc']])
  })

  it('已有手动绑定 → 页脚「恢复自动匹配」→ DELETE → applied+close', async () => {
    musicApi.getManualLyric.mockResolvedValue({ lrc: '[00:01]x', source: 'ytm' })
    const w = mountPicker()
    await flush()
    const clearBtn = document.querySelector('.lp-clear')
    expect(clearBtn?.textContent).toContain('恢复自动匹配')
    clearBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(musicApi.clearManualLyric).toHaveBeenCalledWith('yt_abc')
    expect(w.emitted('applied')).toEqual([['yt_abc']])
    expect(w.emitted('close')).toHaveLength(1)
  })
})

describe('LyricPicker：关闭与中止', () => {
  it('Esc 关窗（idle）；绑定在飞期 Esc/遮罩全熄', async () => {
    let resolvePick
    musicApi.pickManualLyric.mockReturnValue(new Promise(r => { resolvePick = r }))
    const w = mountPicker()
    await flush()
    // busy：提交在飞——Esc 与遮罩关窗都忽略
    rowEls()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    keydown(dialogEl(), 'Escape')
    for (const type of ['mousedown', 'mouseup', 'click']) {
      overlayEl().dispatchEvent(new MouseEvent(type, { bubbles: true }))
    }
    expect(w.emitted('close')).toBeUndefined()
    // 落地后 applied+close 正常出
    resolvePick({ code: 200 })
    await flush()
    expect(w.emitted('applied')).toEqual([['yt_abc']])
    expect(w.emitted('close')).toHaveLength(1)
  })

  it('焦点漏出窗（落在 body）时 Esc 仍关窗；其余键照旧被吞不放行', async () => {
    const w = mountPicker()
    await flush()
    // 点过遮罩焦点洗回 body——window capture 段在吞「漏出窗的键」防穿透到
    // App 全局热键，但 Esc 是唯一例外：要路由去 requestClose 而非吞掉
    keydown(document.body, 'k')
    expect(w.emitted('close')).toBeUndefined()
    keydown(document.body, 'Escape')
    expect(w.emitted('close')).toHaveLength(1)
  })

  it('idle 态 Esc 与遮罩三点关窗各出一枚 close', async () => {
    const w = mountPicker()
    await flush()
    keydown(dialogEl(), 'Escape')
    expect(w.emitted('close')).toHaveLength(1)
    mounted.pop().unmount()
    document.body.innerHTML = ''

    const w2 = mountPicker()
    mounted.push(w2)
    await flush()
    for (const type of ['mousedown', 'mouseup', 'click']) {
      overlayEl().dispatchEvent(new MouseEvent(type, { bubbles: true }))
    }
    expect(w2.emitted('close')).toHaveLength(1)
  })

  it('卸载断开在飞请求（abort 信号送达两个读口）', async () => {
    const w = mountPicker()
    await flush()
    const candSignal = musicApi.getLyricCandidates.mock.calls[0][1]
    const manualSignal = musicApi.getManualLyric.mock.calls[0][1]
    w.unmount()
    expect(candSignal.aborted).toBe(true)
    expect(manualSignal.aborted).toBe(true)
  })
})

// ── musicApi 真 wrapper 契约（importActual 绕上层桩，http 动词桩在本文件）──
describe('musicApi：手动词绑定契约', () => {
  it('getManualLyric：HTTP 404 归 null；命中归一 {lrc,plain,source,extId,synced}', async () => {
    const real = (await vi.importActual('../../src/api/music.js')).musicApi
    const nf = new Error('not found')
    nf.response = { status: 404 }
    http.get.mockRejectedValueOnce(nf)
    expect(await real.getManualLyric('s1')).toBeNull()

    http.get.mockResolvedValueOnce({
      code: 200,
      hit: { lrc: '[00:01]一行', plain: '', source: 'lrclib', extId: 'lrclib_1', synced: true }
    })
    const hit = await real.getManualLyric('s1')
    expect(hit).toMatchObject({ extId: 'lrclib_1', source: 'lrclib', synced: true })
    expect(http.get).toHaveBeenLastCalledWith('/lyric/manual',
      expect.objectContaining({ params: { id: 's1' } }))
  })

  it('getManualLyric：body code:404 与双空槽均归 null（契约漂移防御）', async () => {
    const real = (await vi.importActual('../../src/api/music.js')).musicApi
    http.get.mockResolvedValueOnce({ code: 404 })
    expect(await real.getManualLyric('s2')).toBeNull()
    http.get.mockResolvedValueOnce({ code: 200, hit: { lrc: '', plain: '  ' } })
    expect(await real.getManualLyric('s2')).toBeNull()
  })

  it('pickManualLyric：POST 体 {id,extId,token}；code!==200 抛错带 bizCode', async () => {
    const real = (await vi.importActual('../../src/api/music.js')).musicApi
    http.post.mockResolvedValueOnce({
      code: 200,
      hit: { lrc: null, plain: '纯文本词', source: 'kugou', extId: 'k_1', synced: false }
    })
    const hit = await real.pickManualLyric({ id: 's1', extId: 'k_1', token: 'tk' })
    expect(http.post).toHaveBeenLastCalledWith('/lyric/manual',
      { id: 's1', extId: 'k_1', token: 'tk' }, expect.anything())
    expect(hit).toMatchObject({ extId: 'k_1', plain: '纯文本词', synced: false })

    http.post.mockResolvedValueOnce({ code: 400 })
    await expect(real.pickManualLyric({ id: 's1', extId: 'x' }))
      .rejects.toMatchObject({ bizCode: 400 })
  })

  it('clearManualLyric：DELETE ?id= 形状；getLyricCandidates：duration 参数名', async () => {
    const real = (await vi.importActual('../../src/api/music.js')).musicApi
    http.delete.mockResolvedValueOnce({ code: 200 })
    await real.clearManualLyric('s9')
    expect(http.delete).toHaveBeenCalledWith('/lyric/manual',
      expect.objectContaining({ params: { id: 's9' } }))

    http.get.mockResolvedValueOnce({ code: 200, candidates: [{ extId: 'c1' }] })
    const list = await real.getLyricCandidates({ id: 's9', title: 't', artist: 'a', durationSec: 61 })
    expect(list).toEqual([{ extId: 'c1' }])
    expect(http.get).toHaveBeenLastCalledWith('/lyric/candidates',
      expect.objectContaining({ params: { id: 's9', title: 't', artist: 'a', duration: 61 } }))
  })
})

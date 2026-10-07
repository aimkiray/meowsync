// 评审修复轮回归（lib 层）：
//   F1 prefs.js 远端应用关窗时机——关窗 nextTick 必须挂在 ref 赋值之后，
//      否则归一值被 watcher 回写上行（App.vue watchTab 同款坑）
//   M1 prefs.js remoteApplying 改键级独立旗标——多键同步连发时先到键
//      （同值无 watcher job）的关窗回调不得抢在后到键 watcher 前跑
//   L  scroll-mem.js 键盘滚动键纳入「用户显式意图」判据
//   L  scroll-mem.js 可编辑目标内的按键不算滚动意图（输入框空格不误杀）
//   L  share.js 分享链 id encodeURIComponent + 无可用 id 拦截死链
//   L  api-base.js userinfo 剥离 + 端口 '0' 视同未配
import { describe, it, expect, vi, afterEach } from 'vitest'
import { nextTick } from 'vue'

import { prefVideoOn, prefLyricFontSize, applyRemoteVideoPref, applyRemoteLyricFs } from '../../src/lib/prefs.js'
import { LS_KEYS } from '../../src/lib/storage.js'
import { restoreScrollTop } from '../../src/lib/scroll-mem.js'
import { songShareUrl, playlistShareUrl } from '../../src/lib/share.js'
import { resolveApiBaseUrl } from '../../src/lib/api-base.js'

describe('F1：prefs 远端应用窗——watcher 回写必须在窗内被跳过', () => {
  it('远端 lyric-fs=30 归一成 24 回填 ref，LS 原文不被归一值回写', async () => {
    localStorage.setItem(LS_KEYS.LYRIC_FONT_SIZE, '30')
    applyRemoteLyricFs()
    expect(prefLyricFontSize.value).toBe(24) // 本机口径钳位照常
    // watcher job 与关窗回调同微任务批——两拍确保全跑完。
    // 若关窗抢在 watcher 前跑（旧序），watcher 会把 24 写回 LS 顶掉远端 30
    await nextTick()
    await nextTick()
    expect(localStorage.getItem(LS_KEYS.LYRIC_FONT_SIZE)).toBe('30')
  })

  it('远端 video=0 回填 false，LS 原文保持', async () => {
    localStorage.setItem(LS_KEYS.VIDEO_MODE, '0')
    applyRemoteVideoPref()
    expect(prefVideoOn.value).toBe(false)
    await nextTick()
    await nextTick()
    expect(localStorage.getItem(LS_KEYS.VIDEO_MODE)).toBe('0')
  })

  it('窗关后本机写照常落盘（窗口不是永久粘贴）', async () => {
    prefLyricFontSize.value = 20
    prefVideoOn.value = true
    await nextTick()
    expect(localStorage.getItem(LS_KEYS.LYRIC_FONT_SIZE)).toBe('20')
    expect(localStorage.getItem(LS_KEYS.VIDEO_MODE)).toBe('1')
  })

  it('M1：连发键级独立——同值 video 先到的关窗不得提前关掉 lyric-fs 的窗', async () => {
    // applyRemoteItems 同步 for 循环连发场景：远端 video 值与本机相同→
    // ref 不变→无 watcher job→video 的关窗 nextTick 直接排在 lyric 的
    // watcher job 前。共用单旗标时 lyric 归一值 24 会被回写顶掉远端 30
    prefVideoOn.value = false
    await nextTick() // 先结算本机写（watcher 会写 '0'——与下面远端值同口径）
    localStorage.setItem(LS_KEYS.VIDEO_MODE, '0')    // 远端值 == 当前 ref(false)
    localStorage.setItem(LS_KEYS.LYRIC_FONT_SIZE, '30')
    applyRemoteVideoPref()  // ref 不变——无 job，关窗回调先入微任务队
    applyRemoteLyricFs()    // ref 20→24——watcher job 排在 video 关窗回调后
    expect(prefLyricFontSize.value).toBe(24)
    await nextTick()
    await nextTick()
    // 键级旗标下 lyric 窗由自己的关窗回调负责——watcher 跑时窗仍开
    expect(localStorage.getItem(LS_KEYS.LYRIC_FONT_SIZE)).toBe('30')
    expect(localStorage.getItem(LS_KEYS.VIDEO_MODE)).toBe('0')
  })
})

describe('scroll-mem：键盘滚动键算用户显式意图', () => {
  const makeEl = () => {
    const el = document.createElement('div')
    // jsdom 无布局——scrollHeight/clientHeight 恒 0，桩成可控值模拟内容灌入
    let h = 0
    Object.defineProperty(el, 'scrollHeight', { get: () => h, configurable: true })
    Object.defineProperty(el, 'clientHeight', { get: () => 50, configurable: true })
    document.body.appendChild(el)
    return { el, grow: (v) => { h = v } }
  }
  const tick = (ms) => new Promise(r => setTimeout(r, ms))
  afterEach(() => { document.body.innerHTML = '' })

  it('等待窗内按 PageDown：放弃还位不抢滚动', async () => {
    const { el, grow } = makeEl()
    const cancel = restoreScrollTop(el, 100, { timeoutMs: 2000 })
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }))
    grow(1000) // 内容随后灌够——若没被取消，下个 interval 拍会写 scrollTop=100
    await tick(300)
    expect(el.scrollTop).not.toBe(100)
    cancel() // 幂等
  })

  it('非滚动键不结算——窗口保持，内容灌够后正常还位', async () => {
    const { el, grow } = makeEl()
    restoreScrollTop(el, 100, { timeoutMs: 2000 })
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    grow(1000)
    await tick(300)
    expect(el.scrollTop).toBe(100)
  })

  it('可编辑目标内的按键不算滚动意图——输入框空格不误杀还位', async () => {
    const { el, grow } = makeEl()
    restoreScrollTop(el, 100, { timeoutMs: 2000 })
    const input = document.createElement('input')
    document.body.appendChild(input)
    // 空格是滚动意图键，但目标是输入框时是文本编辑——不得取消还位
    input.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    grow(1000)
    await tick(300)
    expect(el.scrollTop).toBe(100)
  })
})

describe('share.js：分享链 id 编码与死链拦截', () => {
  it('provider id 过 encodeURIComponent——带 & 的脏 id 不截断参数', () => {
    const url = songShareUrl({ bilibili: { bvid: 'BV&x=1', page: 2 } })
    expect(url).toContain('?bili=BV%26x%3D1&p=2&view=watch')
    expect(songShareUrl({ youtube: { videoId: 'abc_def-123' } })).toContain('?yt=abc_def-123&view=watch')
    expect(songShareUrl({ qq: { mid: 'aB123xYzMn' } })).toContain('?qq=aB123xYzMn&view=watch')
  })

  it('无可用 id 返回 null——不产 ?song=undefined 死链', () => {
    expect(songShareUrl(null)).toBeNull()
    expect(songShareUrl({})).toBeNull()
    expect(songShareUrl({ name: 'x' })).toBeNull()
    expect(songShareUrl({ id: 'bv_noId' })).toBeNull() // 接收端只收数字 id
    expect(songShareUrl({ id: 123 })).toContain('?song=123&view=watch')
    expect(songShareUrl({ id: '456' })).toContain('?song=456&view=watch')
  })

  it('远端歌单链 id 编码；非数字/缺席 id 拦截', () => {
    expect(playlistShareUrl({ id: 777, name: 'P' })).toContain('?playlist=777&view=songs&pl=777')
    expect(playlistShareUrl({ id: 'x_odd', name: 'P' })).toBeNull()  // 非本地非数字壳——死链拦截
    expect(playlistShareUrl({})).toContain('?mix=')                   // 无 id 落 mix 内容链
    // 本地单照走 mix 链
    expect(playlistShareUrl({ id: 'local_pl_a', name: '本地', tracks: [] }))
      .toContain('?mix=' + encodeURIComponent('本地') + '~')
  })
})

describe('api-base：配置地址净化', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  it('userinfo 凭据剥离并告警', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubEnv('VITE_API_BASE_URL', 'http://user:secret@api.example.com:8080')
    expect(resolveApiBaseUrl()).toBe('http://api.example.com:8080')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('userinfo'), expect.anything())
  })

  it('端口 0 视同未配——退回推断地址而非打到必死端口', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubEnv('VITE_API_BASE_URL', 'http://api.example.com:0')
    // dev 环境 devFallback：页面 host + 兜底端口 3101
    expect(resolveApiBaseUrl()).toBe('http://localhost:3101')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('端口为 0'), expect.anything())
  })
})

// proxiedCoverUrl 收紧后的放行矩阵钉板（jsdom 环境——resolveApiBaseUrl 走
// devFallback，包装形以它为前缀断言）：异 scheme（javascript:/vbscript:/
// file:）与协议相对 //host/x 一律 ''；data:/blob:/同源相对/白名单 http(s)
// 维持既有放行与包装口径。node 侧 tests/song.test.mjs 是全量矩阵，本件只
// 钉安全面边界（曾透传 javascript:/file: 的回归网）
import { describe, it, expect, vi, afterEach } from 'vitest'
import { proxiedCoverUrl, coverHdUrl, resolveStageCover } from '../../src/lib/song.js'
import { resolveApiBaseUrl } from '../../src/lib/api-base.js'

const base = resolveApiBaseUrl()
const proxied = (u) => `${base}/img-proxy?url=${encodeURIComponent(u)}`

describe('proxiedCoverUrl：异 scheme 与协议相对全拒，同源/白名单放行', () => {
  it('javascript:/vbscript:/file:/mailto: 等异 scheme 一律归空串', () => {
    for (const s of [
      'javascript:alert(1)',
      'JAVASCRIPT:alert(document.domain)',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'file:///c:/windows/win.ini',
      'mailto:a@b.c',
      'tel:12345',
    ]) {
      expect(proxiedCoverUrl(s)).toBe('')
    }
  })

  it('协议相对 //host/x 恒拒——图床白名单宿主也不升格', () => {
    expect(proxiedCoverUrl('//i.ytimg.com/vi/x/hqdefault.jpg')).toBe('')
    expect(proxiedCoverUrl('//p1.music.126.net/x.jpg')).toBe('')
    expect(proxiedCoverUrl('//evil.example/x.jpg')).toBe('')
  })

  it('放行面不变：data:/blob:/同源相对/裸相对透传', () => {
    expect(proxiedCoverUrl('data:image/png;base64,AAA')).toBe('data:image/png;base64,AAA')
    expect(proxiedCoverUrl('blob:https://x/abc')).toBe('blob:https://x/abc')
    expect(proxiedCoverUrl('/downloads/songs/f/file?playlistId=local_uploads'))
      .toBe('/downloads/songs/f/file?playlistId=local_uploads')
    expect(proxiedCoverUrl('covers/x.jpg')).toBe('covers/x.jpg')
    expect(proxiedCoverUrl('')).toBe('')
  })

  it('白名单 http(s) 域名走 /img-proxy 包装；非白名单/非标端口/凭据形仍拒', () => {
    expect(proxiedCoverUrl('https://i.ytimg.com/vi/x/hqdefault.jpg'))
      .toBe(proxied('https://i.ytimg.com/vi/x/hqdefault.jpg'))
    expect(proxiedCoverUrl('http://i0.hdslb.com/x.jpg')).toBe(proxied('http://i0.hdslb.com/x.jpg'))
    expect(proxiedCoverUrl('https://example.com/x.jpg')).toBe('')
    expect(proxiedCoverUrl('https://i.ytimg.com:8443/x')).toBe('')
    expect(proxiedCoverUrl('https://u:p@i.ytimg.com/x')).toBe('')
  })
})

describe('coverHdUrl：舞台位反向升档改写', () => {
  it('126：剥 param 缩放 query 键（独存剥净/夹链保其余参数），无 param 原样', () => {
    expect(coverHdUrl('https://p1.music.126.net/a/b.jpg?param=200y200'))
      .toBe('https://p1.music.126.net/a/b.jpg')
    expect(coverHdUrl('https://p1.music.126.net/a/b.jpg?x=1&param=200y200'))
      .toBe('https://p1.music.126.net/a/b.jpg?x=1')
    expect(coverHdUrl('https://p1.music.126.net/a/b.jpg?param=200y200&x=1'))
      .toBe('https://p1.music.126.net/a/b.jpg?x=1')
    expect(coverHdUrl('https://p1.music.126.net/a/b.jpg'))
      .toBe('https://p1.music.126.net/a/b.jpg')
  })

  it('hdslb：剥 path 末段 @ 变换尾缀（query/hash 逐字节保留）', () => {
    expect(coverHdUrl('https://i0.hdslb.com/bfs/x.jpg@300w_300h_1c.jpg'))
      .toBe('https://i0.hdslb.com/bfs/x.jpg')
    expect(coverHdUrl('https://i0.hdslb.com/bfs/x.jpg@300w_300h_1c.jpg?f=1'))
      .toBe('https://i0.hdslb.com/bfs/x.jpg?f=1')
    // 末段无 @ 尾缀 → 原样；中段 @ 不在末段不剥（hdslb 实链不会有，防御钉板）
    expect(coverHdUrl('https://i0.hdslb.com/bfs/x.jpg')).toBe('https://i0.hdslb.com/bfs/x.jpg')
    expect(coverHdUrl('https://i0.hdslb.com/a@b/c.jpg')).toBe('https://i0.hdslb.com/a@b/c.jpg')
  })

  it('hdslb：@ 后须紧跟 @\\d+w 变换语法——x@2x.jpg 文件名内 @ 不剥', () => {
    // '@2x' 是数字+x 不是数字+w——剥了连扩展名都丢（必 404）
    expect(coverHdUrl('https://i0.hdslb.com/bfs/x@2x.jpg'))
      .toBe('https://i0.hdslb.com/bfs/x@2x.jpg')
    // 变换形仍剥回原名——与 coverSizeUrl /@\d+w_/ 同口径
    expect(coverHdUrl('https://i0.hdslb.com/bfs/abc.jpg@100w_100h_1c.webp'))
      .toBe('https://i0.hdslb.com/bfs/abc.jpg')
  })

  it('gtimg/qpic：path 内 T002R{w}x{h} 令牌升 800 档；非该令牌/无令牌透传', () => {
    expect(coverHdUrl('https://y.gtimg.cn/music/photo_new/T002R300x300M000abc.jpg'))
      .toBe('https://y.gtimg.cn/music/photo_new/T002R800x800M000abc.jpg')
    expect(coverHdUrl('https://p.qpic.cn/music_cover/T002R168x168x.jpg'))
      .toBe('https://p.qpic.cn/music_cover/T002R800x800x.jpg')
    expect(coverHdUrl('https://y.gtimg.cn/music/photo_new/T001R300x300M000x.jpg'))
      .toBe('https://y.gtimg.cn/music/photo_new/T001R300x300M000x.jpg')
  })

  it('ytimg：/vi/{id}/ 下任意 {grade}default.jpg 档名归 maxresdefault（幂等）', () => {
    for (const g of ['default', 'mqdefault', 'hqdefault', 'sddefault', 'maxresdefault']) {
      expect(coverHdUrl(`https://i.ytimg.com/vi/x/${g}.jpg`))
        .toBe('https://i.ytimg.com/vi/x/maxresdefault.jpg')
    }
    // 非档位末段（编号档）不动；i 子域同族升档
    expect(coverHdUrl('https://i.ytimg.com/vi/x/0.jpg')).toBe('https://i.ytimg.com/vi/x/0.jpg')
    expect(coverHdUrl('https://i1.ytimg.com/vi/x/hqdefault.jpg'))
      .toBe('https://i1.ytimg.com/vi/x/maxresdefault.jpg')
  })

  it('透传面：已代理形/非 http(s)/不上表域/相对串/空值一律原样', () => {
    // 防腐化闸：url= 编码内明文 hdslb 的 @ 尾缀不被剥
    const wrapped = proxied('https://i0.hdslb.com/bfs/x.jpg@300w_300h_1c.jpg')
    expect(coverHdUrl(wrapped)).toBe(wrapped)
    const wrapped126 = proxied('https://p1.music.126.net/a.jpg?param=200y200')
    expect(coverHdUrl(wrapped126)).toBe(wrapped126)
    expect(coverHdUrl('data:image/png;base64,AAA')).toBe('data:image/png;base64,AAA')
    expect(coverHdUrl('blob:https://x/abc')).toBe('blob:https://x/abc')
    expect(coverHdUrl('/downloads/songs/f/file?playlistId=local_uploads&kind=cover'))
      .toBe('/downloads/songs/f/file?playlistId=local_uploads&kind=cover')
    expect(coverHdUrl('covers/x.jpg')).toBe('covers/x.jpg')
    // 不上表域：query 里的 param=/@ 明文都不属于本表改写面——原样
    expect(coverHdUrl('https://example.com/x.jpg?param=1y1')).toBe('https://example.com/x.jpg?param=1y1')
    expect(coverHdUrl('')).toBe('')
    expect(coverHdUrl(null)).toBe('')
    expect(coverHdUrl(undefined)).toBe('')
  })
})

describe('resolveStageCover：yt 档位实探链 + 其余源纯改写 + memo', () => {
  // FakeImage 桩：构造计数 + set src 按 URL 内档名结算成败。探测链过
  // proxiedCoverUrl——包进的 url= 编码串里档名仍是明文可读（
  // encodeURIComponent 不编字母数字），按 includes 判档
  let imgCount = 0
  const installFakeImage = (deadGrades = []) => {
    imgCount = 0
    vi.stubGlobal('Image', class {
      constructor() { imgCount++ }
      set src(v) {
        queueMicrotask(() => {
          if (deadGrades.some(g => v.includes(g))) this.onerror?.()
          else this.onload?.()
        })
      }
    })
  }
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  const ytSong = (vid, grade = 'hq') =>
    ({ id: `yt_${vid}`, al: { picUrl: `https://i.ytimg.com/vi/${vid}/${grade}default.jpg` } })

  it('yt：maxres 档在位 → 单次探测直取 maxres', async () => {
    installFakeImage([])
    await expect(resolveStageCover(ytSong('stgok00001')))
      .resolves.toBe('https://i.ytimg.com/vi/stgok00001/maxresdefault.jpg')
    expect(imgCount).toBe(1)
  })

  it('yt：maxres 404 → 降 sd 档（第二候选胜出）', async () => {
    installFakeImage(['maxresdefault'])
    await expect(resolveStageCover(ytSong('stgsd00002')))
      .resolves.toBe('https://i.ytimg.com/vi/stgsd00002/sddefault.jpg')
    expect(imgCount).toBe(2)
  })

  it('yt：maxres/sd 全灭 → 回落 base hq（必有档兜底）', async () => {
    installFakeImage(['maxresdefault', 'sddefault'])
    await expect(resolveStageCover(ytSong('stghq00003')))
      .resolves.toBe('https://i.ytimg.com/vi/stghq00003/hqdefault.jpg')
    expect(imgCount).toBe(3)
  })

  it('yt：同 videoId 二次调用吃 memo——不重建 Image', async () => {
    installFakeImage(['maxresdefault'])
    const song = ytSong('stgmemo004')
    await expect(resolveStageCover(song))
      .resolves.toBe('https://i.ytimg.com/vi/stgmemo004/sddefault.jpg')
    const n = imgCount
    await expect(resolveStageCover(song))
      .resolves.toBe('https://i.ytimg.com/vi/stgmemo004/sddefault.jpg')
    expect(imgCount).toBe(n)
  })

  it('非 yt 曲：纯改写零探测——不建 Image 直接得升档裸 URL', async () => {
    installFakeImage([])
    await expect(resolveStageCover({
      id: '1', al: { picUrl: 'https://y.gtimg.cn/m/T002R300x300M000x.jpg' },
    })).resolves.toBe('https://y.gtimg.cn/m/T002R800x800M000x.jpg')
    await expect(resolveStageCover({
      id: '2', al: { picUrl: 'https://i0.hdslb.com/bfs/x.jpg@300w_300h_1c.jpg' },
    })).resolves.toBe('https://i0.hdslb.com/bfs/x.jpg')
    expect(imgCount).toBe(0)
  })

  it('Image 缺席（SSR 形）跳过探测回 coverHdUrl 改写；空封面归空串', async () => {
    vi.stubGlobal('Image', undefined)
    await expect(resolveStageCover(ytSong('stgnoi0005')))
      .resolves.toBe('https://i.ytimg.com/vi/stgnoi0005/maxresdefault.jpg')
    await expect(resolveStageCover({ id: 'x' })).resolves.toBe('')
    await expect(resolveStageCover(null)).resolves.toBe('')
  })

  it('yt：base 已是 sd 形——maxres/sd 全灭回落 hq 恒在档，不吐已探死 URL', async () => {
    installFakeImage(['maxresdefault', 'sddefault'])
    await expect(resolveStageCover(ytSong('stgbase006', 'sd')))
      .resolves.toBe('https://i.ytimg.com/vi/stgbase006/hqdefault.jpg')
  })

  it('yt：显式默认端口 :443 的合法形同进实探链——探改两闸同口径', async () => {
    installFakeImage([])
    await expect(resolveStageCover({
      id: 'yt_stgport007',
      al: { picUrl: 'https://i.ytimg.com:443/vi/stgport007/hqdefault.jpg' },
    })).resolves.toBe('https://i.ytimg.com:443/vi/stgport007/maxresdefault.jpg')
    expect(imgCount).toBe(1)
  })

  it('yt：同 videoId 并发双调吃同一份在途探测——Image 数不翻倍', async () => {
    installFakeImage(['maxresdefault'])
    const song = ytSong('stgcon0008')
    const [a, b] = await Promise.all([resolveStageCover(song), resolveStageCover(song)])
    expect(a).toBe('https://i.ytimg.com/vi/stgcon0008/sddefault.jpg')
    expect(b).toBe(a)
    expect(imgCount).toBe(2)                    // 单链 maxres+sd 两探，非 4
  })

  it('yt：Image 缺席的同步结果不记 memo——环境恢复后照实探', async () => {
    vi.stubGlobal('Image', undefined)
    const song = ytSong('stgnoimg09')
    await expect(resolveStageCover(song))
      .resolves.toBe('https://i.ytimg.com/vi/stgnoimg09/maxresdefault.jpg')
    vi.unstubAllGlobals()
    // 若缺席结果进了 memo，这里会直回未验证的 maxres 且不建 Image
    installFakeImage(['maxresdefault'])
    await expect(resolveStageCover(song))
      .resolves.toBe('https://i.ytimg.com/vi/stgnoimg09/sddefault.jpg')
    expect(imgCount).toBeGreaterThan(0)
  })

  it('yt：6s 探测超时按失败进下一档——CDN 黑洞不钉死整条链', async () => {
    vi.useFakeTimers()
    imgCount = 0
    vi.stubGlobal('Image', class {
      constructor() { imgCount++ }
      set src(v) { /* 永不结算——模拟握手挂死的 CDN 黑洞 */ }
    })
    const p = resolveStageCover(ytSong('stgtout010'))
    expect(imgCount).toBe(1)                    // maxres 开探
    await vi.advanceTimersByTimeAsync(6000)
    expect(imgCount).toBe(2)                    // maxres 超时 → sd 开探
    await vi.advanceTimersByTimeAsync(12000)    // sd、hq 相继超时 → 链尽回落 base
    await expect(p).resolves.toBe('https://i.ytimg.com/vi/stgtout010/hqdefault.jpg')
    expect(imgCount).toBe(3)
  })

  it('file_ 曲：工件 URL 含 coverV 版本戳且不进实探链——纯透传', async () => {
    installFakeImage([])
    const url = await resolveStageCover({ id: 'file_s1', file: { hasCover: true, coverV: 3 } })
    expect(url).toContain('/downloads/songs/file_s1/file')
    expect(url).toContain('kind=cover')
    expect(url).toContain('v=3')
    expect(imgCount).toBe(0)
  })
})

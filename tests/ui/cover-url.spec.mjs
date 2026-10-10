// proxiedCoverUrl 收紧后的放行矩阵钉板（jsdom 环境——resolveApiBaseUrl 走
// devFallback，包装形以它为前缀断言）：异 scheme（javascript:/vbscript:/
// file:）与协议相对 //host/x 一律 ''；data:/blob:/同源相对/白名单 http(s)
// 维持既有放行与包装口径。node 侧 tests/song.test.mjs 是全量矩阵，本件只
// 钉安全面边界（曾透传 javascript:/file: 的回归网）
import { describe, it, expect } from 'vitest'
import { proxiedCoverUrl } from '../../src/lib/song.js'
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

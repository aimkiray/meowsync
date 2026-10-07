// uploads.js 上传客户端回归：
//   L  令牌头与 http.js 拦截器同一收口（downloadTokenHeaders）
//   L  上行停滞看门狗——无进度满 120s 判死中止（裸 XHR 悬挂永不 settle），
//      onprogress 喂狗续命；看门狗 abort 与用户 abort 在 onabort 分流
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// XHR 可控桩：捕获 open/头/send，事件由用例手动驱动
const { xhrs, FakeXHR } = vi.hoisted(() => {
  const xhrs = []
  class FakeXHR {
    constructor() { this.headers = {}; this.upload = {}; xhrs.push(this) }
    open(method, url) { this.method = method; this.url = url }
    setRequestHeader(k, v) { this.headers[k] = v }
    send() { this.sent = true }
    abort() { this.onabort?.() }
  }
  return { xhrs, FakeXHR }
})

vi.stubEnv('VITE_DOWNLOAD_TOKEN', 'up-token-9')
vi.stubGlobal('XMLHttpRequest', FakeXHR)

const { uploadFile } = await import('../../src/api/uploads.js')

beforeEach(() => { vi.useFakeTimers(); xhrs.length = 0 })
afterEach(() => { vi.useRealTimers() })

const settle = (p) => p.then(v => ({ v }), e => ({ e }))

describe('uploadFile', () => {
  it('令牌头与 http.js 同口径注入；query 携带 kind/filename/songId', () => {
    uploadFile({ kind: 'audio', file: new Blob(['x']), filename: 'f.mp3', songId: 's1' })
    const xhr = xhrs[0]
    expect(xhr.headers['x-download-token']).toBe('up-token-9')
    expect(xhr.headers['Content-Type']).toBe('application/octet-stream')
    expect(xhr.url).toContain('kind=audio')
    expect(xhr.url).toContain('filename=f.mp3')
    expect(xhr.url).toContain('songId=s1')
    expect(xhr.sent).toBe(true)
  })

  it('无上行进度满 120s：看门狗判死——reject 停滞超时（非「已取消」）', async () => {
    const { promise } = uploadFile({ kind: 'audio', file: new Blob(['x']) })
    const raced = settle(promise)
    await vi.advanceTimersByTimeAsync(120000)
    const { e } = await raced
    expect(e?.message).toBe('上传停滞超时，已中止')
  })

  it('onprogress 喂狗续命：持续进度不判死，onload 正常结算', async () => {
    const seen = []
    const { promise } = uploadFile({
      kind: 'audio', file: new Blob(['x']),
      onProgress: (r) => seen.push(r),
    })
    const xhr = xhrs[0]
    await vi.advanceTimersByTimeAsync(60000)
    xhr.upload.onprogress({ lengthComputable: true, loaded: 5, total: 10 })
    await vi.advanceTimersByTimeAsync(60000) // 距上次进度仅 60s——看门狗未满
    xhr.status = 200
    xhr.responseText = JSON.stringify({ code: 200, data: { songId: 's1' } })
    xhr.onload()
    await expect(promise).resolves.toEqual({ songId: 's1' })
    expect(seen).toEqual([0.5])
  })

  it('用户 abort：reject「已取消」与停滞分流', async () => {
    const { promise, abort } = uploadFile({ kind: 'audio', file: new Blob(['x']) })
    const raced = settle(promise)
    abort()
    const { e } = await raced
    expect(e?.message).toBe('已取消')
    // 看门狗已随 onabort 摘除——推进时间不再二次 settle
    await vi.advanceTimersByTimeAsync(130000)
  })
})

// useRemoteControl host 端行为：远端 play 重建的 pendingSeekTime 口径
// （resumeSeek）、被顶替（4000）降级自愈重连、file_ 封面相对路径化、
// queueIndex 按已发队列重定位。WebSocket 全桩捕获实例手动驱动事件。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'

const { sockets } = vi.hoisted(() => ({ sockets: [] }))
// 最小 WebSocket 桩：实例入册，事件由用例手动触发（open/recv/close4000）
class FakeWs {
  static OPEN = 1
  static CLOSED = 3
  constructor(url, protocols) {
    this.url = url
    this.protocols = protocols
    this.readyState = 0 // CONNECTING
    this.sent = []
    sockets.push(this)
  }
  get OPEN() { return 1 }
  send(d) { this.sent.push(d) }
  close(code = 1000) { this.readyState = 3; this.onclose?.({ code }) }
  open() { this.readyState = 1; this.onopen?.() }
  recv(msg) { this.onmessage?.({ data: typeof msg === 'string' ? msg : JSON.stringify(msg) }) }
  kick() { this.readyState = 3; this.onclose?.({ code: 4000 }) } // 服务端顶替
}
vi.stubGlobal('WebSocket', FakeWs)

vi.mock('../../src/lib/feedback.js', () => ({ toast: vi.fn() }))

import { toast } from '../../src/lib/feedback.js'
import { useRemoteControl } from '../../src/composables/useRemoteControl.js'

function makeDeps() {
  const deps = {
    isPlaying: ref(false),
    currentSong: ref(null),
    currentTime: ref(0),
    duration: ref(200),
    volume: ref(80),
    playingSongs: ref([]),
    songSwitching: ref(false),
    filteredSongs: ref([]),
    playSong: vi.fn(),
    nextSong: vi.fn(),
    previousSong: vi.fn(),
    updateVolume: vi.fn(),
    playbackList: () => deps.playingSongs.value,
  }
  let howl = null
  deps.getHowl = () => howl
  deps.setHowl = (h) => { howl = h }
  return deps
}

const hostMode = () => window.history.pushState({}, '', '/?mode=host')
const lastSentPayload = (ws) => JSON.parse(ws.sent.at(-1)).payload

beforeEach(() => {
  sockets.length = 0
  vi.clearAllMocks()
  localStorage.clear()
  hostMode()
})
afterEach(() => {
  window.history.pushState({}, '', '/')
  vi.useRealTimers()
})

describe('useRemoteControl：远端 play 重建与续播挂账', () => {
  it('howl 已死时远端 play 走 resumeSeek——与本地 !howl 重建分支同口径（挂账优先于清零的 currentTime）', () => {
    const deps = makeDeps()
    deps.currentSong.value = { id: 1, name: 'x', ar: [] }
    deps.currentTime.value = 0 // playSong 清零后的状态——挂账值在 playSong 内部读
    const rc = useRemoteControl(deps)
    rc.connectRemoteHost()
    const ws = sockets.at(-1)
    ws.open()
    ws.recv({ type: 'play' })
    expect(deps.playSong).toHaveBeenCalledWith(
      deps.currentSong.value,
      { preserveContext: true, resumeSeek: true })
  })

  it('howl 活着时远端 play 不重建——直接 play()', () => {
    const deps = makeDeps()
    const fakeHowl = { play: vi.fn(), state: () => 'loaded' }
    deps.setHowl(fakeHowl)
    const rc = useRemoteControl(deps)
    rc.connectRemoteHost()
    const ws = sockets.at(-1)
    ws.open()
    ws.recv({ type: 'play' })
    expect(fakeHowl.play).toHaveBeenCalled()
    expect(deps.playSong).not.toHaveBeenCalled()
  })
})

describe('useRemoteControl：被顶替降级自愈', () => {
  it('4000 顶替 → toast 保留 + 降级 controller 重连；见 host 空缺自愈回接管', async () => {
    const deps = makeDeps()
    const rc = useRemoteControl(deps)
    rc.connectRemoteHost()
    const host = sockets.at(-1)
    expect(host.url).toContain('role=host')
    host.open()

    host.kick() // 服务端 4000 收编
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('接管'), 'error', 5000)

    // 降级重连走 800ms 定时器
    await new Promise(r => setTimeout(r, 900))
    const demoted = sockets.at(-1)
    expect(demoted).not.toBe(host)
    expect(demoted.url).toContain('role=controller')
    demoted.open()

    // host 位空缺信号 → 关闭观望连接并回接管为 host
    demoted.recv({ type: 'host_absent' })
    const promoted = sockets.at(-1)
    expect(promoted).not.toBe(demoted)
    expect(promoted.url).toContain('role=host')
    // 回接管成功补一条恢复回执
    promoted.open()
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('恢复'), 'info')
  })

  it('迟到的 4000（socket 已被新连接取代）不弹顶替提示', async () => {
    const deps = makeDeps()
    const rc = useRemoteControl(deps)
    rc.connectRemoteHost()
    const ws1 = sockets.at(-1)
    const staleOnclose = ws1.onclose
    rc.connectRemoteHost() // 幂等重进——ws1 被取代（remoteWs 指向 ws2）
    staleOnclose({ code: 4000 }) // 迟到顶替帧落旧 socket
    expect(toast).not.toHaveBeenCalled()
  })
})

describe('useRemoteControl：state_update 上行', () => {
  it('file_ 封面发 apiBase 相对路径；外部 http(s) 链原样透传', () => {
    const deps = makeDeps()
    const rc = useRemoteControl(deps)
    rc.connectRemoteHost()
    const ws = sockets.at(-1)
    ws.open()

    deps.currentSong.value = { id: 'file_abc', name: 'f', file: { hasCover: true, coverV: 3 }, ar: [] }
    ws.recv({ type: 'request_state' })
    // 剥掉 host 端 apiBase——异机 controller 用自身基址拼回（localhost 对它无义）
    expect(lastSentPayload(ws).currentSong.al.picUrl)
      .toMatch(/^\/downloads\/songs\/file_abc\/file\?/)

    deps.currentSong.value = { id: 2, name: 'n', al: { picUrl: 'https://cdn.example/p.jpg' }, ar: [] }
    ws.recv({ type: 'request_state' })
    expect(lastSentPayload(ws).currentSong.al.picUrl).toBe('https://cdn.example/p.jpg')
  })

  it('queueIndex 在已发送 queue 内按 id 重定位（快照截断不漂移）', () => {
    const deps = makeDeps()
    const list = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, name: `歌${i}`, ar: [] }))
    deps.playingSongs.value = list
    deps.currentSong.value = list[2]
    const rc = useRemoteControl(deps)
    rc.connectRemoteHost()
    const ws = sockets.at(-1)
    ws.open()
    ws.recv({ type: 'request_state' })
    const p = lastSentPayload(ws)
    expect(p.queue).toHaveLength(5)
    expect(p.queueIndex).toBe(2)
    // 当前曲不在已发队列（截断窗外）→ -1 而非错位点亮
    deps.currentSong.value = { id: 999, name: 'x', ar: [] }
    ws.recv({ type: 'request_state' })
    expect(lastSentPayload(ws).queueIndex).toBe(-1)
  })
})

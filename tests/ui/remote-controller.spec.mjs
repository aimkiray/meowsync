// RemoteController 接收端封面还原：host 把 file_ 工件封面剥成 apiBase
// 相对路径上线（协议见 shared/protocol.js 注释），本端用自身
// resolveApiBaseUrl 拼回；外部 http(s) 链原样透传。顺带钉 connect 幂等。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'

const { sockets } = vi.hoisted(() => ({ sockets: [] }))
class FakeWs {
  static OPEN = 1
  constructor(url, protocols) {
    this.url = url
    this.readyState = 0
    this.sent = []
    sockets.push(this)
  }
  get OPEN() { return 1 }
  send(d) { this.sent.push(d) }
  close() { this.readyState = 3; this.onclose?.({ code: 1000 }) }
  open() { this.readyState = 1; this.onopen?.() }
  recv(msg) { this.onmessage?.({ data: JSON.stringify(msg) }) }
}
vi.stubGlobal('WebSocket', FakeWs)

import { resolveApiBaseUrl } from '../../src/lib/api-base.js'
import RemoteController from '../../src/components/RemoteController.vue'

const mountCtl = () => mount(RemoteController, {
  props: { wsUrl: 'ws://example.test/remote?role=controller' },
})
const feedState = (ws, payload) => ws.recv({ type: 'state_update', payload })

let wrapper
beforeEach(() => { sockets.length = 0 })
afterEach(() => { wrapper?.unmount(); wrapper = null })

describe('RemoteController：封面 apiBase 相对路径还原', () => {
  it('/downloads 相对路径用本端 apiBase 拼回；外部 http(s) 链原样', async () => {
    wrapper = mountCtl()
    const ws = sockets.at(-1)
    ws.open()
    feedState(ws, { currentSong: { id: 'file_abc', name: 'f',
      al: { picUrl: '/downloads/songs/file_abc/file?kind=cover' }, ar: [] } })
    await nextTick()
    const img = wrapper.find('img.rc-cover')
    expect(img.exists()).toBe(true)
    // 异机 controller 的 apiBase 是它自己的——localhost 对端死链就此消解
    expect(img.attributes('src'))
      .toBe(`${resolveApiBaseUrl()}/downloads/songs/file_abc/file?kind=cover`)

    feedState(ws, { currentSong: { id: 2, name: 'n',
      al: { picUrl: 'https://cdn.example/p.jpg' }, ar: [] } })
    await nextTick()
    expect(wrapper.find('img.rc-cover').attributes('src'))
      .toBe('https://cdn.example/p.jpg')
  })

  it('connect 幂等：在途 socket 被 detach+close 收编，迟到 close 不再叠连', async () => {
    vi.useFakeTimers()
    wrapper = mountCtl()
    const ws1 = sockets.at(-1)
    ws1.open()
    // 旧 socket 还活着时 connect 重进（手动 retry/重连挂单在途同形态）：
    // 必须先摘它的回调再关——否则旧 close 会再叠一条重连定时器
    wrapper.vm.retry()
    const ws2 = sockets.at(-1)
    expect(ws2).not.toBe(ws1)
    expect(ws1.readyState).toBe(3)
    expect(ws1.onclose).toBeNull()
    // 跨过一轮重连窗口：旧 socket 的迟到 close 没再叠出新连接
    vi.advanceTimersByTime(3500)
    expect(sockets).toHaveLength(2)
    vi.useRealTimers()
  })
})

// 客户端 SSE 同步信号消费（src/lib/sync.js × src/api/sync.js）：
//   - initSync 挂 EventSource（幂等不重复挂；reset 后重挂新订阅）
//   - changed 帧 → 主动拉（pullFromServer 本体的在途去重，绕前台节流窗）；
//     1s 最小间隔把连发帧合并成窗尾一趟；在途 pull 期到帧顺延补拉不丢
//   - error 连击 ≥3 或 readyState=CLOSED（非 2xx 弃连，只发一次 error）
//     → close 放弃；open/收帧清零连击；close 后死流残帧不理会（死流
//     晚发 open 不清新订阅簿记）；放弃后回前台/回网自动重挂自愈
//   - closeSyncEvents 关流+清排程；openSyncEvents 返回 null（无 ES 环境）不挂不炸
// api 层真身经 importActual 测：URL=<base>/sync/events、withCredentials、
// changed 帧解析转调、无 EventSource 返回 null。
// PTR（createPullRefresh）手势机同文件直测：起手闸/阈值/方向锁/离顶作废。
// openSyncEvents 桩回假 ES——changed 走引擎传入的回调，open/error 走
// addEventListener 注册面，两侧都是可控派发。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../src/api/sync.js', () => ({
  syncApi: { pull: vi.fn(), push: vi.fn() },
  openSyncEvents: vi.fn(() => null),
}))
vi.mock('../../src/api/http.js', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
  API_BASE_URL: 'http://api.test',
  apiErrorMessage: (e) => e?.message || '接口异常',
}))
// App.vue 挂载用例的模块图桩（与 sync.spec.mjs 同套——按名链接完整性）
vi.mock('../../src/api/music.js', () => ({
  musicApi: {
    getPlaylistDetail: vi.fn(async () => null),
    getQqStatus: vi.fn(async () => null),
  },
  qqLoggedIn: vi.fn(async () => null),
}))
vi.mock('../../src/api/downloads.js', () => ({
  downloadsApi: { removeLocalMirror: vi.fn(async () => ({})) },
}))
vi.mock('../../src/api/auth.js', () => ({
  authApi: { status: vi.fn(async () => ({ data: {} })) },
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
vi.mock('../../src/lib/feedback.js', () => ({
  toast: vi.fn(), toastDismiss: vi.fn(), toastHold: vi.fn(), toastRelease: vi.fn(),
  pixelConfirm: vi.fn(async () => false), isConfirmOpen: vi.fn(() => false),
  resolveConfirm: vi.fn(),
  useFeedbackState: vi.fn(() => ({ toasts: [], confirm: null })),
}))

import { nextTick } from 'vue'
import { shallowMount } from '@vue/test-utils'
import App from '../../src/App.vue'
import { syncApi, openSyncEvents } from '../../src/api/sync.js'
import {
  initSync, pullFromServer, resetSyncState, closeSyncEvents,
  createPullRefresh, PTR_THRESHOLD_PX, PTR_TOP_ZONE_PX,
} from '../../src/lib/sync.js'

const T0 = 1_700_000_000_000

// 可控假 EventSource：记录注册面 + emit 派发 + close 观测
const makeFakeEs = () => {
  const listeners = new Map()
  return {
    closed: false,
    readyState: 0, // EventSource.CONNECTING——用例改写 2(CLOSED) 模拟弃连
    addEventListener: vi.fn((t, fn) => {
      const set = listeners.get(t) || []
      set.push(fn)
      listeners.set(t, set)
    }),
    close: vi.fn(function () { this.closed = true }),
    emit: (t, e = {}) => { for (const fn of listeners.get(t) || []) fn(e) },
    has: (t) => listeners.has(t),
  }
}
// 引擎经 openSyncEvents(cb) 传入的 changed 回调
const onChangedOf = () => openSyncEvents.mock.calls.at(-1)[0]

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  localStorage.clear()
  resetSyncState()
  syncApi.pull.mockReset()
  syncApi.pull.mockResolvedValue({ code: 200, items: [], serverTime: T0 })
  syncApi.push.mockReset()
  openSyncEvents.mockReset()
})

afterEach(() => {
  resetSyncState()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('SSE：订阅生命周期', () => {
  it('initSync 挂 EventSource；幂等重入不重复挂；reset 收走旧订阅后可重挂', () => {
    const es = makeFakeEs()
    openSyncEvents.mockReturnValue(es)
    initSync()
    expect(openSyncEvents).toHaveBeenCalledTimes(1)
    // 引擎在返回值上挂 open/error 连击管理
    expect(es.addEventListener).toHaveBeenCalledWith('open', expect.any(Function))
    expect(es.addEventListener).toHaveBeenCalledWith('error', expect.any(Function))

    initSync() // 幂等早退——不重复开
    expect(openSyncEvents).toHaveBeenCalledTimes(1)

    resetSyncState() // 收走旧订阅
    expect(es.close).toHaveBeenCalledTimes(1)
    const es2 = makeFakeEs()
    openSyncEvents.mockReturnValue(es2)
    initSync()
    expect(openSyncEvents).toHaveBeenCalledTimes(2)
  })

  it('openSyncEvents 返回 null（无 EventSource 环境）：initSync 不挂不炸', () => {
    openSyncEvents.mockReturnValue(null)
    expect(() => initSync()).not.toThrow()
    expect(openSyncEvents).toHaveBeenCalledTimes(1)
  })

  it('回前台自愈：被放弃的订阅在 online 时重挂一次；活流回前台不重复挂', () => {
    const es1 = makeFakeEs()
    openSyncEvents.mockReturnValue(es1)
    initSync()
    es1.readyState = 2 // 非 2xx 弃连——一次 error 即放弃，syncEvents=null
    es1.emit('error')
    expect(es1.close).toHaveBeenCalledTimes(1)

    const es2 = makeFakeEs()
    openSyncEvents.mockReturnValue(es2)
    window.dispatchEvent(new Event('online')) // 回前台/回网补拉口
    expect(openSyncEvents).toHaveBeenCalledTimes(2) // 死订阅重获一次握手
    expect(es2.addEventListener).toHaveBeenCalledWith('error', expect.any(Function))

    window.dispatchEvent(new Event('online')) // 活流再回前台——attach 幂等闸不叠加
    expect(openSyncEvents).toHaveBeenCalledTimes(2)
  })
})

describe('SSE：changed→主动拉', () => {
  it('changed 帧触发 pullFromServer（主动拉：不经 60s 前台节流窗）', async () => {
    openSyncEvents.mockReturnValue(makeFakeEs())
    initSync()
    onChangedOf()({ seq: 9 })
    await vi.advanceTimersByTimeAsync(0) // 排程 wait=0——帧到即拉
    expect(syncApi.pull).toHaveBeenCalledTimes(1)
    // 数据面仍是增量 pull（since 走 LS 水位线，不吃帧内 seq）
    expect(syncApi.pull).toHaveBeenCalledWith(0)
  })

  it('1s 最小间隔：窗内连发合并成窗尾一趟（trailing 不丢末条）', async () => {
    openSyncEvents.mockReturnValue(makeFakeEs())
    initSync()
    await pullFromServer() // pullLastTry=T0——节流以此为钟
    expect(syncApi.pull).toHaveBeenCalledTimes(1)

    onChangedOf()({ seq: 1 }) // wait=1000
    await vi.advanceTimersByTimeAsync(500)
    onChangedOf()({ seq: 2 }) // 已排程——连发不叠加第二趟
    await vi.advanceTimersByTimeAsync(400)
    expect(syncApi.pull).toHaveBeenCalledTimes(1) // 窗内未到不拉
    await vi.advanceTimersByTimeAsync(150)        // 过窗尾（T0+1000 已排）
    expect(syncApi.pull).toHaveBeenCalledTimes(2)
    // 窗尾落地一趟后，距上次 pull 间隔不足的帧仍走 trailing 合并
    onChangedOf()({ seq: 3 }) // 距 pull#2 发起 50ms → wait≈950
    await vi.advanceTimersByTimeAsync(1000)
    expect(syncApi.pull).toHaveBeenCalledTimes(3)
  })

  it('在途 pull 期到帧：dedup 吃不掉的变更顺延整窗补拉——不丢', async () => {
    openSyncEvents.mockReturnValue(makeFakeEs())
    initSync()
    let release
    syncApi.pull.mockImplementationOnce(() => new Promise(r => { release = r }))
    const inflight = pullFromServer() // 挂起在途（pullLastTry=T0）
    expect(syncApi.pull).toHaveBeenCalledTimes(1)

    onChangedOf()({ seq: 4 })
    await vi.advanceTimersByTimeAsync(1000) // 窗尾到点仍在途→顺延 +1s 整窗
    expect(syncApi.pull).toHaveBeenCalledTimes(1) // 不自旋不并发
    release({ code: 200, items: [] })
    await inflight
    await vi.advanceTimersByTimeAsync(1100)
    expect(syncApi.pull).toHaveBeenCalledTimes(2) // 顺延窗尾补拉落地
  })

  it('定时器到点复核 pullLastTry：窗内别路 pull 刚跑完则顺延剩余窗——不产 <1s 冗余拉', async () => {
    openSyncEvents.mockReturnValue(makeFakeEs())
    initSync()
    await pullFromServer() // pullLastTry=T0
    expect(syncApi.pull).toHaveBeenCalledTimes(1)

    onChangedOf()({ seq: 1 }) // 排窗尾 T0+1000
    await vi.advanceTimersByTimeAsync(500) // T0+500
    await pullFromServer() // PTR/前台来源的拉——pullLastTry 推进到 T0+500
    expect(syncApi.pull).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(500) // T0+1000——原排程到点
    // 复核发现距 pull#2 才 500ms → 顺延剩余窗，不贴脸发第二趟
    expect(syncApi.pull).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(500) // T0+1500——顺延窗尾落地
    expect(syncApi.pull).toHaveBeenCalledTimes(3)
  })
})

describe('SSE：error 连击与 teardown', () => {
  it('error 连击 ≥3 即 close 放弃；open/收帧各清零一次连击', async () => {
    const es = makeFakeEs()
    openSyncEvents.mockReturnValue(es)
    initSync()
    es.emit('error')
    es.emit('error')
    expect(es.close).not.toHaveBeenCalled()
    es.emit('open') // 回连成功——连击清零
    es.emit('error')
    es.emit('error')
    expect(es.close).not.toHaveBeenCalled()
    onChangedOf()({ seq: 1 }) // 收帧同口径清零
    es.emit('error')
    es.emit('error')
    expect(es.close).not.toHaveBeenCalled()
    es.emit('error') // 第 3 连击——放弃
    expect(es.close).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(0) // 顺带消化 pending 排程
  })

  it('close 后死流残帧不理会——不再产拉取', async () => {
    const es = makeFakeEs()
    openSyncEvents.mockReturnValue(es)
    initSync()
    es.emit('error')
    es.emit('error')
    es.emit('error') // 连击自闭
    expect(es.close).toHaveBeenCalledTimes(1)
    onChangedOf()({ seq: 5 }) // 已 close 的流又来帧——忽略
    await vi.advanceTimersByTimeAsync(3000)
    expect(syncApi.pull).not.toHaveBeenCalled()
  })

  it('非 2xx 弃连（readyState=CLOSED）：一次 error 即 close 放弃——等连击上限永远等不来', async () => {
    const es = makeFakeEs()
    openSyncEvents.mockReturnValue(es)
    initSync()
    es.readyState = 2 // 401/429 拒流——浏览器只发一次 error 不再回连
    es.emit('error')
    expect(es.close).toHaveBeenCalledTimes(1) // 一次即放弃，errStreak 不恒 1
    onChangedOf()({ seq: 9 }) // 订阅已清——残帧也不理
    await vi.advanceTimersByTimeAsync(2000)
    expect(syncApi.pull).not.toHaveBeenCalled()
  })

  it('死流守卫：已 close 的旧 ES 晚发 open 不清新订阅的连击簿记', () => {
    const es1 = makeFakeEs()
    openSyncEvents.mockReturnValue(es1)
    initSync()
    closeSyncEvents() // 旧订阅收走（errStreak 归零、syncEvents=null）
    const es2 = makeFakeEs()
    openSyncEvents.mockReturnValue(es2)
    window.dispatchEvent(new Event('online')) // 回前台重挂新订阅
    expect(openSyncEvents).toHaveBeenCalledTimes(2)

    es2.emit('error') // 新订阅连击 1
    es1.emit('open')  // 死流晚发——不清零（若清了下方只到 2，永不放弃）
    es2.emit('error')
    es2.emit('error') // 真实第 3 连击——放弃
    expect(es2.close).toHaveBeenCalledTimes(1)
  })

  it('closeSyncEvents：关流 + 清排程 + 幂等（测试 teardown 口）', async () => {
    const es = makeFakeEs()
    openSyncEvents.mockReturnValue(es)
    initSync()
    onChangedOf()({ seq: 1 }) // 排一趟待发的拉
    closeSyncEvents()
    expect(es.close).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(3000)
    expect(syncApi.pull).not.toHaveBeenCalled() // 排程被清——teardown 后无残响
    expect(() => closeSyncEvents()).not.toThrow() // 幂等
  })
})

describe('api：openSyncEvents 形态（真身）', () => {
  it('无 EventSource 返回 null；有则开 <base>/sync/events withCredentials，changed 解析转调', async () => {
    // importActual 拿真模块——其 ./http.js 依赖仍走本文件桩（API_BASE_URL 钉死）
    const { openSyncEvents: realOpen } = await vi.importActual('../../src/api/sync.js')
    expect(realOpen(() => {})).toBe(null) // jsdom 无 EventSource

    class FakeES {
      constructor(url, opts) { this.url = url; this.opts = opts; this.listeners = {} }
      addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn) }
      close() {}
    }
    vi.stubGlobal('EventSource', FakeES)
    const onMessage = vi.fn()
    const es = realOpen(onMessage)
    expect(es.url).toBe('http://api.test/sync/events')
    expect(es.opts).toEqual({ withCredentials: true })
    // 契约帧 event:changed——data 解析转调
    es.listeners.changed[0]({ data: '{"seq":7}' })
    expect(onMessage).toHaveBeenCalledWith({ seq: 7 }, { data: '{"seq":7}' })
    // 坏帧按空提示转调——不抛不挡
    es.listeners.changed[0]({ data: 'bad' })
    expect(onMessage).toHaveBeenLastCalledWith(null, { data: 'bad' })
    // onMessage 可缺省——不挂监听不炸
    const bare = realOpen()
    expect(bare.listeners.changed).toBeUndefined()
  })
})

describe('PTR 手势机（createPullRefresh）', () => {
  it('起手闸：触点在容器顶 60px 内且 scrollTop≤0 才武装', () => {
    const g = createPullRefresh()
    expect(g.start({ x: 10, y: 20, topOffset: PTR_TOP_ZONE_PX - 1, scrollTop: 0 })).toBe(true)
    g.end()
    expect(g.start({ topOffset: PTR_TOP_ZONE_PX + 1, scrollTop: 0 })).toBe(false) // 超顶缘区
    expect(g.start({ topOffset: 10, scrollTop: 40 })).toBe(false)                // 不在容器顶
    expect(g.start({ topOffset: -5, scrollTop: 0 })).toBe(false)                 // 容器外触点
  })

  it('位移跟随与阈值：<64 释放回弹 cancel，≥64 判 refresh', () => {
    const g = createPullRefresh()
    g.start({ x: 0, y: 100, topOffset: 0, scrollTop: 0 })
    expect(g.move({ x: 0, y: 130 })).toBe(30)
    expect(g.end()).toBe('cancel')
    g.start({ x: 0, y: 100, topOffset: 0, scrollTop: 0 })
    g.move({ x: 0, y: 140 })
    expect(g.move({ x: 0, y: 100 + PTR_THRESHOLD_PX })).toBe(PTR_THRESHOLD_PX)
    expect(g.end()).toBe('refresh')
  })

  it('方向锁：首段横滑判负弃手势——列表行内横滑不被截胡', () => {
    const g = createPullRefresh()
    g.start({ x: 0, y: 0, topOffset: 0, scrollTop: 0 })
    expect(g.move({ x: 40, y: 5 })).toBe(0) // 横向主导
    expect(g.active).toBe(false)
    expect(g.move({ x: 0, y: 100 })).toBe(0)
    expect(g.end()).toBe('cancel')
  })

  it('容器被拖离顶（scrollTop>0）：手势即作废不回拉', () => {
    const g = createPullRefresh()
    g.start({ x: 0, y: 0, topOffset: 0, scrollTop: 0 })
    expect(g.move({ x: 0, y: 70, scrollTop: 0 })).toBe(70)
    expect(g.move({ x: 0, y: 90, scrollTop: 12 })).toBe(0)
    expect(g.active).toBe(false)
    expect(g.end()).toBe('cancel')
  })

  it('上滑钳 0、未达锁程小幅位移不武装方向；cancel 与 end 幂等', () => {
    const g = createPullRefresh()
    g.start({ x: 0, y: 100, topOffset: 0, scrollTop: 0 })
    expect(g.move({ x: 0, y: 60 })).toBe(0)  // dy<0 钳 0——上滑不显示
    expect(g.move({ x: 0, y: 103 })).toBe(3) // 未达 8px 锁程仍跟随
    expect(g.end()).toBe('cancel')
    expect(g.end()).toBe('cancel') // 重复 end 不误触发
    g.cancel()
    expect(g.active).toBe(false)
  })
})

describe('App.vue：下拉刷新触层（document 委托集成）', () => {
  // 触屏标记：listeners 只在 'ontouchstart' in window 时挂——jsdom
  // 没有该属性，挂前先 stub（setup 内判定发生在挂载期）。
  // attachTo:document.body 必需——shallowMount 默认 detached，触摸事件
  // 冒泡到不了 document 的委托监听。首拉等待同 sync.spec.mjs 的次序：
  // initApp 尾部 void pullFromServer() 可能晚于壳渲染落定，先等它被调
  // 再 mockClear，否则首拉计数飘进手势断言里
  const mountApp = async () => {
    vi.stubGlobal('ontouchstart', null)
    const wrapper = shallowMount(App, { attachTo: document.body })
    await vi.waitFor(() => expect(wrapper.find('.app-main').exists()).toBe(true))
    await vi.waitFor(() => expect(syncApi.pull).toHaveBeenCalled())
    await pullFromServer() // 首拉落定（在途即复用同一 Promise）
    syncApi.pull.mockClear()
    return wrapper
  }

  it('列表视图顶部下拉 ≥64px → 释放触发 pull；指示器随动与复位', async () => {
    const wrapper = await mountApp()

    // shallowMount 下视图是 stub——.app-main 首视图子元素充当真滚动口；
    // jsdom 无布局，overflowY 走内联注入（getComputedStyle 照常读出）
    const main = wrapper.find('.app-main').element
    const scroller = [...main.children].find(el => !el.classList.contains('ptr-indicator'))
    scroller.style.overflowY = 'auto'
    const fire = (type, touches) => {
      const e = new Event(type, { bubbles: true })
      e.touches = touches
      scroller.dispatchEvent(e)
    }
    fire('touchstart', [{ clientX: 10, clientY: 20 }]) // 顶缘 60px 内 + scrollTop 0
    fire('touchmove', [{ clientX: 10, clientY: 90 }])  // dy=70 ≥64——指示器跟随
    await nextTick()
    expect(wrapper.find('.ptr-indicator').attributes('style')).toContain('height: 70px')
    fire('touchend', [])
    expect(syncApi.pull).toHaveBeenCalledTimes(1) // 释放=主动拉
    await vi.waitFor(() => {
      // 刷新落定回弹收拢
      expect(wrapper.find('.ptr-indicator').attributes('style')).toContain('height: 0px')
    })
    wrapper.unmount()
  })

  it('非顶缘起手与容器非顶：手势不武装——不产拉取', async () => {
    const wrapper = await mountApp()

    const main = wrapper.find('.app-main').element
    const scroller = [...main.children].find(el => !el.classList.contains('ptr-indicator'))
    scroller.style.overflowY = 'auto'
    const fire = (type, touches) => {
      const e = new Event(type, { bubbles: true })
      e.touches = touches
      scroller.dispatchEvent(e)
    }
    // 起手点超顶缘区（clientY-rect.top>60，jsdom rect.top=0）
    fire('touchstart', [{ clientX: 10, clientY: 200 }])
    fire('touchmove', [{ clientX: 10, clientY: 400 }])
    fire('touchend', [])
    // 容器非顶（scrollTop>0）同样不武装
    scroller.scrollTop = 30
    fire('touchstart', [{ clientX: 10, clientY: 20 }])
    scroller.scrollTop = 0
    fire('touchmove', [{ clientX: 10, clientY: 120 }])
    fire('touchend', [])
    await vi.advanceTimersByTimeAsync(2000)
    expect(syncApi.pull).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})

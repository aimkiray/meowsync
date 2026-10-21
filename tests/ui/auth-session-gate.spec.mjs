// 认证门控评审轮回归：
//   F1 「暂不设置」翻 setupDismissed → authRequired 翻假 → watcher 就地补跑
//      initApp（钉：initSync/pullFromServer 必须被调到——此前没有任何补跑路径）
//   F2 会话过期弹门清场：resolveConfirm(false) 结算悬挂框 + 全局热键在门后
//      彻底失能（钉：'m' 静音键不再写 PLAYER_STATE.volume）
//   F4 AuthGate 输入可访问名 / 错误 role=alert / aria-invalid 随 error 联动
//   F3+F5 DownloadQueueList：行容器 role=group 且摘要标签含状态/失败/进度、
//      搜索框与状态 select 有可访问名、封面装饰图 alt 为空、菜单有标签
//   F3-M1 过期门起清场须盖 loading 态 Howl（isPlaying=false 也 pause——
//      漏闸则其 onload 的 autoplay 分支在门后出声）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick } from 'vue'

vi.mock('../../src/api/auth.js', () => ({
  authApi: {
    status: vi.fn(async () => ({ data: {} })),
    setup: vi.fn(async () => ({ code: 500, message: '建号失败' })),
    login: vi.fn(async () => ({ code: 401, message: '用户名或密码错误' })),
    logout: vi.fn(async () => ({})),
    me: vi.fn(async () => ({ data: null })),
  },
}))
vi.mock('../../src/api/music.js', () => ({
  musicApi: {
    resolveYouTube: vi.fn(),
    resolveBilibili: vi.fn(),
    resolveQQ: vi.fn(),
    getSongDetail: vi.fn(),
    getSongsDetail: vi.fn(async () => []),
    getPlaylistDetail: vi.fn(async () => null),
    getQqStatus: vi.fn(async () => null),
    retryMatch: vi.fn(async () => null),
  },
  // App.vue→usePlayer/useExternalImport 图按名链接——缺省 null=「态未知」
  qqLoggedIn: vi.fn(async () => null),
}))
vi.mock('../../src/api/downloads.js', () => ({
  downloadsApi: {
    removeLocalMirror: vi.fn(async () => ({})),
    mirrorLocalPlaylist: vi.fn(async () => ({})),
    quickDownloadPlaylist: vi.fn(async () => ({})),
    deletePlaylistDownloads: vi.fn(async () => ({})),
    listTasks: vi.fn(async () => ({ data: [] })),
    getSongDownloadStatus: vi.fn(async () => null),
  },
}))
vi.mock('../../src/api/http.js', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
  API_BASE_URL: 'http://api.test',
  // 与真实现同链（response.data.message → message → '未知错误'）——AuthGate/
  // SongList 的 apiErrorMessage 收编面在本文件桩下钉的仍是真实链语义
  apiErrorMessage: (e) => e?.response?.data?.message || e?.message || '未知错误',
}))
vi.mock('../../src/api/sync.js', () => ({
  syncApi: { pull: vi.fn(), push: vi.fn() },
  openSyncEvents: vi.fn(() => null),
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
// Howl 全桩：实例入册 + pause 痕迹。构造即停 'loading' 态（真实 Howl 要
// onload 才转 'loaded'）——F3-M1 用例靠它钉「未起播的加载中实例」形态
const { howls } = vi.hoisted(() => ({ howls: [] }))
vi.mock('howler', () => {
  class FakeHowl {
    constructor(opts) {
      this.opts = opts
      this._state = 'loading'
      this._playing = false
      this.paused = false
      this.unloaded = false
      howls.push(this)
    }
    play() { this._playing = true; this.opts.onplay?.() }
    pause() { this.paused = true; this._playing = false; this.opts.onpause?.() }
    stop() { this._playing = false; this.opts.onstop?.() }
    unload() { this.unloaded = true }
    duration() { return 200 }
    seek(v) { if (v === undefined) return 0; return v }
    volume(v) { if (v === undefined) return 1; return this }
    rate() { return 1 }
    playing() { return this._playing }
    state() { return this._state }
    fire(name, ...args) { this.opts[name]?.(...args) }
  }
  return { Howl: FakeHowl, Howler: { html5PoolSize: 0, volume: vi.fn(), mute: vi.fn() } }
})
vi.mock('../../src/lib/feedback.js', () => ({
  toast: vi.fn(), toastDismiss: vi.fn(), toastHold: vi.fn(), toastRelease: vi.fn(),
  pixelConfirm: vi.fn(async () => false), isConfirmOpen: vi.fn(() => false),
  resolveConfirm: vi.fn(),
  useFeedbackState: vi.fn(() => ({ toasts: [], confirm: null })),
}))

import { mount, shallowMount } from '@vue/test-utils'
import { authApi } from '../../src/api/auth.js'
import { syncApi } from '../../src/api/sync.js'
import { resolveConfirm, isConfirmOpen } from '../../src/lib/feedback.js'
import { authState, dismissSetup } from '../../src/lib/auth-state.js'
import { readJSON, LS_KEYS } from '../../src/lib/storage.js'
import { resetSyncState } from '../../src/lib/sync.js'
import App from '../../src/App.vue'
import AuthGate from '../../src/components/AuthGate.vue'
import DownloadQueueList from '../../src/components/DownloadQueueList.vue'

const resetAuthState = () => {
  authState.booted = false
  authState.enabled = false
  authState.setupRequired = false
  authState.authenticated = false
  authState.username = null
  authState.expired = false
  authState.setupDismissed = false
}

beforeEach(() => {
  vi.useFakeTimers()
  howls.length = 0
  localStorage.clear()
  resetSyncState()
  resetAuthState()
  authApi.status.mockReset()
  authApi.status.mockResolvedValue({ data: {} })
  syncApi.pull.mockReset()
  syncApi.pull.mockResolvedValue({ code: 200, items: [], serverTime: 1 })
  syncApi.push.mockReset()
  syncApi.push.mockResolvedValue({ code: 200, applied: [], conflicts: [], rejected: [] })
  resolveConfirm.mockReset()
})

afterEach(() => {
  resetSyncState()
  resetAuthState()
  vi.useRealTimers()
})

// ── F1：skip 只翻标记时 watcher 必须就地补跑完整初始化 ──

describe('App.vue：「暂不设置」补跑初始化（F1）', () => {
  it('setupRequired 门内不初始化；dismissSetup 后 initSync/pullFromServer 补跑到位', async () => {
    authApi.status.mockResolvedValue({ data: { setupRequired: true } })
    const wrapper = shallowMount(App)
    // 等 onMounted 的 status 探活落地——门起，初始化整段押后
    await vi.waitFor(() => expect(authState.booted).toBe(true))
    await vi.advanceTimersByTimeAsync(50)
    expect(syncApi.pull).not.toHaveBeenCalled() // 钉：门内绝不能抢跑

    dismissSetup() // 「暂不设置」只翻 setupDismissed——authRequired() 翻假
    await vi.waitFor(() => expect(syncApi.pull).toHaveBeenCalled())
    wrapper.unmount()
  })
})

// ── F2：会话过期弹门清场 ──

describe('App.vue：会话过期清场（F2）', () => {
  it('弹门瞬间结算悬挂确认框；门后全局热键不再写播放状态', async () => {
    const wrapper = shallowMount(App)
    await vi.waitFor(() => expect(syncApi.pull).toHaveBeenCalled())

    // 门内期热键仍活着：'m' → toggleMute → updateVolume(0) → 300ms 落盘
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm' }))
    await vi.advanceTimersByTimeAsync(400)
    expect(readJSON(LS_KEYS.PLAYER_STATE).volume).toBe(0)

    // http.js 401 标记的落账形态：enabled + unauthenticated + expired
    authState.enabled = true
    authState.authenticated = false
    authState.expired = true
    await nextTick()
    expect(resolveConfirm).toHaveBeenCalledWith(false)
    // 门渲染接管：主壳退场（shallowMount 下 AuthGate 是 stub，壳块消失即可钉）
    expect(wrapper.find('.app-shell').exists()).toBe(false)

    // 门后再按 'm'：toggleMute 会把 volume 弹回 80——闸住则落盘值不变
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm' }))
    await vi.advanceTimersByTimeAsync(400)
    expect(readJSON(LS_KEYS.PLAYER_STATE).volume).toBe(0)
    wrapper.unmount()
  })
})

// ── R1：Esc 消费打戳——一键只收一层 ──

describe('App.vue：Esc 消费分支打 defaultPrevented 戳（R1）', () => {
  it('确认框未决时 Esc 结算 confirm 并 preventDefault——下层沉浸层据此让位', async () => {
    const wrapper = shallowMount(App)
    await vi.waitFor(() => expect(syncApi.pull).toHaveBeenCalled())
    isConfirmOpen.mockReturnValueOnce(true) // 当发事件报开——工厂默认 false 不被污染
    const e = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    window.dispatchEvent(e)
    expect(resolveConfirm).toHaveBeenCalledWith(false)
    expect(e.defaultPrevented).toBe(true) // 戳即「本层已收」——后跑监听据此让位
    wrapper.unmount()
  })

  it('侧栏开着时 Esc 关栏同打戳；无可收层不打戳放行', async () => {
    const wrapper = shallowMount(App)
    await vi.waitFor(() => expect(syncApi.pull).toHaveBeenCalled())
    wrapper.vm.sidebarOpen = true
    const e = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    window.dispatchEvent(e)
    expect(wrapper.vm.sidebarOpen).toBe(false)
    expect(e.defaultPrevented).toBe(true)
    // 栏已关——下一发 Esc 无可结算层：不打戳放行，沉浸层等后跑监听照常收
    const e2 = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    window.dispatchEvent(e2)
    expect(e2.defaultPrevented).toBe(false)
    wrapper.unmount()
  })
})

// ── F3-M1：过期门起清场须盖 loading 态 Howl ──

describe('App.vue：过期门起暂停 loading 态 Howl（F3-M1）', () => {
  it('存档恢复建的 loading 态 Howl（isPlaying=false）在弹门时也被 pause', async () => {
    // 种存档：本地歌单含一首 file_ 上传曲 → initApp 恢复链走
    // playSong(autoplay:false) 建 Howl；不等 onload——实例停 loading 态、
    // isPlaying 仍 false，正是 F3-M1「isPlaying 闸漏暂停」的形态
    const SONG = { id: 'file_abcdef1234', name: '上传曲', dt: 200000 }
    localStorage.setItem(LS_KEYS.PLAYLISTS, JSON.stringify([
      { id: 'local_pl_gate', name: '本地单', tracks: [SONG] },
    ]))
    localStorage.setItem(LS_KEYS.PLAYER_STATE, JSON.stringify({
      selectedPlaylistId: 'local_pl_gate', playingPlaylistId: 'local_pl_gate',
      currentSongId: SONG.id, currentTime: 12, volume: 80,
    }))
    const wrapper = shallowMount(App)
    await vi.waitFor(() => expect(howls).toHaveLength(1))
    expect(wrapper.vm.isPlaying).toBe(false) // 形态钉：实例在但从未起播
    expect(howls[0].paused).toBe(false)

    // http.js 401 标记的落账形态：enabled + unauthenticated + expired
    authState.enabled = true
    authState.authenticated = false
    authState.expired = true
    await nextTick()
    expect(howls[0].paused).toBe(true) // 含 loading 态的无条件 pause
    wrapper.unmount()
  })
})

// ── F4：AuthGate 可访问性 ──

describe('AuthGate 可访问性（F4）', () => {
  it('输入有可访问名；提交失败时错误段落带 role=alert 且输入翻 aria-invalid', async () => {
    const wrapper = mount(AuthGate)
    const inputs = wrapper.findAll('.auth-input')
    expect(inputs[0].attributes('aria-label')).toBe('用户名')
    expect(inputs[1].attributes('aria-label')).toBe('密码')
    expect(inputs[0].attributes('aria-invalid')).toBe('false')
    expect(inputs[1].attributes('aria-invalid')).toBe('false')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false) // 无错误不出 alert

    await inputs[0].setValue('admin')
    await inputs[1].setValue('wrong-password')
    await wrapper.find('form.auth-card').trigger('submit')
    await vi.waitFor(() => expect(wrapper.find('.auth-error').exists()).toBe(true))

    const err = wrapper.find('.auth-error')
    expect(err.attributes('role')).toBe('alert')
    expect(err.text()).toContain('错误')
    expect(wrapper.findAll('.auth-input')[0].attributes('aria-invalid')).toBe('true')
    wrapper.unmount()
  })

  it('提交抛出异常：服务端文案经 apiErrorMessage 链上屏（非手写链）', async () => {
    // axios 形态错误——response.data.message 是三级链首档，必须透出
    authApi.login.mockRejectedValue({ response: { data: { message: '密码错误次数过多' } } })
    const wrapper = mount(AuthGate)
    const inputs = wrapper.findAll('.auth-input')
    await inputs[0].setValue('admin')
    await inputs[1].setValue('password-123')
    await wrapper.find('form.auth-card').trigger('submit')
    await vi.waitFor(() => expect(wrapper.find('.auth-error').text()).toBe('密码错误次数过多'))

    // 无 response 的裸错走 message 档——链尾不再手写兜底串
    authApi.login.mockRejectedValue(new Error('连接被重置'))
    await wrapper.find('form.auth-card').trigger('submit')
    await vi.waitFor(() => expect(wrapper.find('.auth-error').text()).toBe('连接被重置'))
    wrapper.unmount()
  })
})

// ── F3+F5：DownloadQueueList 可访问性 ──

// 封面用图床白名单域（proxiedCoverUrl fail-closed 后非白名单 → '' →
// 走的是 .dql-cover--fb 占位 div 而非 <img alt="">，用例钉的正是 img 形）
const QUEUE = {
  id: 7, name: '周更歌单', status: 'running',
  failedTasks: 2, completedTasks: 1, totalTasks: 4,
  coverImgUrl: 'https://i.ytimg.com/vi/x/hqdefault.jpg',
}

// GlitchText 挂载期裸调 matchMedia——jsdom 无此 API，用例只钉宿主标签，stub 掉
const DQL_OPTS = { global: { stubs: { GlitchText: true } } }

describe('DownloadQueueList 可访问性（F3/F5）', () => {
  it('行容器 role=group 摘要标签含状态/失败数/进度；子级语义不被 button 吃掉', () => {
    const wrapper = mount(DownloadQueueList, { ...DQL_OPTS, props: { queues: [QUEUE] } })
    const row = wrapper.find('.dql-row-main')
    expect(row.attributes('role')).toBe('group') // button 会把行内 progressbar/元信息整段抹出 a11y 树
    const label = row.attributes('aria-label')
    expect(label).toContain('周更歌单')
    expect(label).toContain('运行中')
    expect(label).toContain('失败 2')
    expect(label).toContain('1/4')
    expect(label).toContain('25%')
    // 行内 progressbar 仍可浏览（group 语义保住子级）
    expect(wrapper.find('[role="progressbar"]').exists()).toBe(true)
    // 封面与紧邻队列名同源——装饰图 alt 置空不报两遍
    expect(wrapper.find('.dql-cover').attributes('alt')).toBe('')
    wrapper.unmount()
  })

  it('搜索框与状态 select 有可访问名；kebab 触发钮与浮出菜单均有标签', async () => {
    const wrapper = mount(DownloadQueueList, { ...DQL_OPTS, props: { queues: [QUEUE] } })
    expect(wrapper.find('.pg-field input').attributes('aria-label')).toBeTruthy()
    expect(wrapper.find('.pg-field select').attributes('aria-label')).toBeTruthy()
    const trigger = wrapper.find('.queue-menu-trigger')
    expect(trigger.attributes('aria-label')).toBeTruthy()
    expect(trigger.attributes('aria-haspopup')).toBe('menu')

    await trigger.trigger('click')
    const menu = document.body.querySelector('.queue-menu') // Teleport 到 body
    expect(menu).toBeTruthy()
    expect(menu.getAttribute('role')).toBe('menu')
    expect(menu.getAttribute('aria-label')).toBeTruthy()
    wrapper.unmount()
  })
})

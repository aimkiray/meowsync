// 发现流/下载域/系统令牌 修复轮回归：
//   HomeFeed 最近播放单曲卡（封面/歌手/来源徽标/@error 兜底）+
//     网格展示截 RECENT_DISPLAY_CAP=12（emit 队列种子仍全量）+
//     recentAlbums 伪专辑准入（al.id 真值或 QQ albummid 合成键 ∧ 名≠歌名）
//   Downloads：DQL meta 去内部 id/progressbar 具名、DTL 文案去「左侧」、
//     DTR 去 #id/.dtr-done、err-tag 本地化、封面 @error；
//     DownloadsPanel <xl 选中滚任务列
//   SettingsPanel：pg-panel 化、未配置三连去重、src--none 提对比
//   AuthGate：ink-btn 收编、去 Courier New 飞地（源码断言）
//   RemoteController：.remote-controller font-family 落地（源码断言）、
//     rc-exit 逃生链 href=origin+pathname、rc-cover @error
//   FeedbackHost：toast 英文枚举戳本地化
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ── 组件图依赖桩：挂载不打真服务端 ──
vi.mock('../../src/api/downloads.js', () => ({
  downloadsApi: {
    listQueues: vi.fn(async () => ({ data: [] })),
    getQueue: vi.fn(async () => ({ data: { queue: null, tasks: [] } })),
    listTasks: vi.fn(async () => ({ data: [] })),
    startQueue: vi.fn(), pauseQueue: vi.fn(), resumeQueue: vi.fn(),
    cancelQueue: vi.fn(), retryQueue: vi.fn(), deleteQueue: vi.fn(),
    retryTask: vi.fn(), deleteTask: vi.fn(),
  },
}))
vi.mock('../../src/api/settings.js', () => ({
  settingsApi: {
    get: vi.fn(async () => ({ fields: {}, ai: { enabled: false, model: null } })),
    save: vi.fn(async () => ({ fields: {} })),
    testAi: vi.fn(async () => ({})),
  },
}))
vi.mock('../../src/api/ai.js', () => ({ aiApi: { invalidateStatus: vi.fn() } }))
vi.mock('../../src/lib/caps.js', () => ({ refreshServerCaps: vi.fn() }))

import { settingsApi } from '../../src/api/settings.js'
import HomeFeed from '../../src/components/HomeFeed.vue'
import DownloadQueueList from '../../src/components/DownloadQueueList.vue'
import DownloadTaskList from '../../src/components/DownloadTaskList.vue'
import DownloadTaskRow from '../../src/components/DownloadTaskRow.vue'
import DownloadsPanel from '../../src/components/DownloadsPanel.vue'
import SettingsPanel from '../../src/components/SettingsPanel.vue'
import AuthGate from '../../src/components/AuthGate.vue'
import RemoteController from '../../src/components/RemoteController.vue'
import FeedbackHost from '../../src/components/FeedbackHost.vue'
import { toast } from '../../src/lib/feedback.js'

// jsdom 缺口补丁：matchMedia（DownloadsPanel <xl 判定）在生产浏览器有，
// 这里只保证存在——需要断言的分支自行 vi.stubGlobal 覆写
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
}
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {}
}

// RemoteController 建连桩（与 remote-controller.spec.mjs 同形）
const { sockets } = vi.hoisted(() => ({ sockets: [] }))
class FakeWs {
  static OPEN = 1
  constructor(url, protocols) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this) }
  get OPEN() { return 1 }
  send(d) { this.sent.push(d) }
  close() { this.readyState = 3; this.onclose?.({ code: 1000 }) }
  open() { this.readyState = 1; this.onopen?.() }
  recv(msg) { this.onmessage?.({ data: JSON.stringify(msg) }) }
}
vi.stubGlobal('WebSocket', FakeWs)

const vueSrc = (name) =>
  readFileSync(join(process.cwd(), 'src/components', name), 'utf8')

const mounted = []
const track = (w) => { mounted.push(w); return w }
afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  vi.restoreAllMocks()
})

/* ═══ HomeFeed ═══ */
const RECENTS = [
  // 网易云真专辑：al.id 真值 + 名≠歌名 → 上货架
  { id: 1, name: '真曲', ar: [{ name: '艺人A' }], al: { id: 42, name: '真专辑', picUrl: 'https://p1.music.126.net/cover.jpg' } },
  // YouTube 曲：al.name==歌名 → 伪专辑滤除；来源徽标 YouTube
  { id: 'yt_abcdefghijk', name: '视频歌', youtube: { videoId: 'abcdefghijk' }, ar: [{ name: 'UP主' }], al: { name: '视频歌', picUrl: 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg' } },
  // 无 al.id 的 provider 伪专辑 → 滤除；来源徽标 B站
  { id: 'bv_BV1xx411c7mD', name: 'B曲', bilibili: { bvid: 'BV1xx411c7mD' }, ar: [{ name: 'UP乙' }], al: { name: '另名专辑' } },
  // QQ 曲 al.id=null（netease 未匹配）但 qq.albummid 是 provider 权威专辑 id →
  // 合成键 'qq:abc123' 上货架（钉 should-fix：!al?.id 闸误杀 QQ 真专辑的边缘形态）
  { id: 'qq_002abc3defg', name: '曲', ar: [{ name: '艺' }], al: { id: null, name: 'QQ真专辑' }, qq: { albummid: 'abc123' } },
  // QQ 曲专辑名==歌名（同名「单曲专辑」）→ 名闸对 albummid 退路同律，仍滤
  { id: 'qq_004hij5klmn', name: '同名曲', ar: [{ name: '艺丙' }], al: { id: null, name: '同名曲' }, qq: { albummid: 'def456' } },
]

describe('HomeFeed：最近播放单曲卡 + 伪专辑过滤', () => {
  it('recentAlbums 只放行真专辑（al.id 真值或 QQ albummid 兜底 ∧ 名≠歌名）', () => {
    const w = track(mount(HomeFeed, { props: { recents: RECENTS, recentPlaylists: [] } }))
    const names = w.findAll('.grid-card .grid-card-name').map(n => n.text())
    expect(names).toEqual(['真专辑', 'QQ真专辑'])
    const albums = w.vm.recentAlbums
    expect(albums).toHaveLength(2)
    // 钉合成键形态：netease 数值 id 直用 / QQ albummid 带 'qq:' 域前缀
    // （防字符串 albummid 与数值 id 撞键）；同名 QQ 行被名闸滤掉不入列
    expect(albums.map(a => a.key)).toEqual([42, 'qq:abc123'])
  })

  it('songrow 渲封面/歌名/歌手/来源徽标，点击发 play-song', async () => {
    const w = track(mount(HomeFeed, { props: { recents: RECENTS, recentPlaylists: [] } }))
    const rows = w.findAll('.home-songrow')
    expect(rows).toHaveLength(5)
    // 徽标全源覆盖：数字 id 网易曲也出「网易云」，yt→YouTube，bv→B站，qq→QQ音乐
    const tagText = (r) => r.find('.home-src-tag').exists() ? r.find('.home-src-tag').text() : null
    const tags = rows.map(tagText)
    expect(tags).toEqual(['网易云', 'YouTube', 'B站', 'QQ音乐', 'QQ音乐'])
    expect(rows[1].find('.home-songrow-name').text()).toBe('视频歌')
    expect(rows[1].find('.home-songrow-artist').text()).toBe('UP主')
    expect(rows[0].find('img.home-songrow-cover').exists()).toBe(true)
    await rows[0].trigger('click')
    expect(w.emitted('play-song')[0][0].id).toBe(1)
    expect(w.emitted('play-song')[0][1]).toEqual(RECENTS)
  })

  it('网格只渲前 12 条（RECENT_DISPLAY_CAP），play-song 队列种子仍给全量 recents', async () => {
    // 15 条 > 展示上限 12；al.name==歌名 → 不上专辑架，断言面隔离在 songrow
    const MANY = Array.from({ length: 15 }, (_, i) => ({
      id: 1000 + i, name: `队列歌${i}`, ar: [{ name: '艺人' }],
      al: { name: `队列歌${i}` },
    }))
    const w = track(mount(HomeFeed, { props: { recents: MANY, recentPlaylists: [] } }))
    const rows = w.findAll('.home-songrow')
    expect(rows).toHaveLength(12)
    // 截的是尾部保原序：末位可见是第 12 条（index 11）
    expect(rows.at(-1).find('.home-songrow-name').text()).toBe('队列歌11')
    await rows[0].trigger('click')
    expect(w.emitted('play-song')[0][0].id).toBe(1000)
    // 展示截断不碰 emit 实参——队列种子仍是全量 15 条
    expect(w.emitted('play-song')[0][1]).toEqual(MANY)
    expect(w.emitted('play-song')[0][1]).toHaveLength(15)
  })

  it('封面 @error 落图标兜底（songrow 与货架卡同簿记）', async () => {
    const w = track(mount(HomeFeed, { props: { recents: RECENTS, recentPlaylists: [] } }))
    const rows = w.findAll('.home-songrow')
    await rows[1].find('img.home-songrow-cover').trigger('error')
    expect(rows[1].find('.home-songrow-fb').exists()).toBe(true)
    // 货架专辑卡同口径：裂图换 fallback 格（取有封面的首张——qq_ 曲无 picUrl 本就走占位）
    const albumCard = w.findAll('.grid-card').at(0)
    await albumCard.find('img').trigger('error')
    expect(albumCard.find('.grid-card-cover-fallback').exists()).toBe(true)
  })

  it('过滤后无真专辑时专辑 section 整段不渲染', () => {
    const w = track(mount(HomeFeed, {
      props: { recents: [RECENTS[1], RECENTS[2]], recentPlaylists: [] },
    }))
    expect(w.text()).not.toContain('最近播放的专辑')
  })
})

/* ═══ Downloads 域 ═══ */
const QUEUE = {
  id: 7, name: '我的歌单队', playlistId: 99, status: 'running',
  completedTasks: 2, totalTasks: 5, failedTasks: 0,
}

describe('Downloads：队列/任务行去内部 id + 文案本地化', () => {
  it('DQL meta 无 #id/歌单 pid；progressbar aria-label 具名', () => {
    const w = track(mount(DownloadQueueList, { props: { queues: [QUEUE], selectedQueueId: 7 } }))
    const meta = w.find('.dql-meta').text()
    expect(meta).toContain('2/5 首 · 40%')
    expect(meta).not.toContain('#')
    expect(meta).not.toContain('歌单')
    expect(w.find('[role="progressbar"]').attributes('aria-label')).toBe('「我的歌单队」下载进度')
    expect(w.find('.dql-sub').text()).toBe('选择一个队列查看任务详情喵~')
  })

  it('DTL：无「队列 #id」chip；文案去「左侧」', () => {
    const w = track(mount(DownloadTaskList, {
      props: { selectedQueue: QUEUE, tasks: [], standaloneTasks: [] },
    }))
    expect(w.find('.dtl-count').exists()).toBe(false)
    expect(w.find('.dtl-sub').text()).toContain('我的歌单队')
    expect(w.text()).not.toContain('左侧')
    w.unmount()
    const w2 = track(mount(DownloadTaskList, {
      props: { selectedQueue: null, tasks: [], standaloneTasks: [] },
    }))
    expect(w2.find('.dtl-sub').text()).toBe('选择一个队列查看任务详情喵~')
    expect(w2.find('.dtl-empty-title').text()).toBe('先挑一个下载队列喵')
  })

  it('DTR：无 .dtr-id/.dtr-done；err-tag「失败原因」；名=h3；封面 @error 兜底', async () => {
    const mkTask = (over) => ({
      id: 5, songName: '歌甲', artist: '艺人', coverUrl: 'https://p1.music.126.net/c.jpg',
      status: 'completed', downloadAudio: true, downloadVideo: false,
      downloadLyrics: false, downloadCover: true, progress: 100, retryCount: 0, ...over,
    })
    const w = track(mount(DownloadTaskRow, { props: { task: mkTask() } }))
    expect(w.find('.dtr-id').exists()).toBe(false)
    expect(w.find('.dtr-done').exists()).toBe(false)
    expect(w.find('h3.dtr-name').exists()).toBe(true)
    // 封面裂图 → 占位格
    await w.find('img.dtr-cover-img').trigger('error')
    expect(w.find('.dtr-cover-fb').exists()).toBe(true)

    const wErr = track(mount(DownloadTaskRow, {
      props: { task: mkTask({ id: 6, status: 'failed', errorMessage: '网络超时', progress: 30 }) },
    }))
    expect(wErr.find('.dtr-err-tag').text()).toBe('失败原因')
    expect(wErr.find('.dtr-err-line').text()).toContain('网络超时')
  })

  it('DownloadsPanel <xl 选中队列后任务列滚入视野', async () => {
    const siv = vi.fn()
    const origMM = window.matchMedia
    const realSiv = Element.prototype.scrollIntoView
    window.matchMedia = (q) => ({
      matches: String(q).includes('1279.98'),
      addEventListener() {}, removeEventListener() {},
    })
    Element.prototype.scrollIntoView = siv
    try {
      const w = track(mount(DownloadsPanel, { props: {} }))
      await nextTick(); await nextTick()
      w.findComponent(DownloadQueueList).vm.$emit('select', QUEUE)
      await nextTick(); await nextTick()
      expect(siv).toHaveBeenCalled()
      // 滚动调用必须落在任务列 div 上（ref=taskColEl）
      const taskCol = w.findAll('.min-h-0.flex.flex-col').at(-1)
      expect(siv.mock.instances.at(-1)).toBe(taskCol.element)
    } finally {
      Element.prototype.scrollIntoView = realSiv
      window.matchMedia = origMM
    }
  })
})

/* ═══ SettingsPanel ═══ */
describe('SettingsPanel：pg-panel 化 + 未配置去重', () => {
  it('三张 section 挂 pg-panel；cookie-state 消失；src--none 戳仍在', async () => {
    settingsApi.get.mockResolvedValue({
      fields: {
        yt_cookie: { set: true, source: 'override', hint: '…尾号42' },
        bili_cookie: { set: false },
      },
      ai: { enabled: false, model: null },
    })
    const w = track(mount(SettingsPanel))
    await flushPromises()
    const cards = w.findAll('section.settings-card')
    expect(cards).toHaveLength(3)
    for (const c of cards) expect(c.classes()).toContain('pg-panel')
    expect(w.find('.settings-cookie-state').exists()).toBe(false)
    // 「未配置」唯一戳是 src 徽标；已配置 hint 并入 placeholder
    const srcs = w.findAll('.settings-src')
    expect(srcs.some(s => s.classes().includes('settings-src--none'))).toBe(true)
    const tas = w.findAll('textarea.settings-textarea')
    const ytTa = tas.find(t => t.attributes('placeholder')?.includes('已配置'))
    expect(ytTa?.attributes('placeholder')).toContain('尾号42')
    expect(tas.some(t => t.attributes('placeholder') === '输入以设置')).toBe(true)
  })
})

/* ═══ AuthGate ═══ */
describe('AuthGate：令牌化', () => {
  it('auth-btn 带 ink-btn 类', () => {
    const w = track(mount(AuthGate, { props: {} }))
    const btn = w.find('button.auth-btn')
    expect(btn.exists()).toBe(true)
    expect(btn.classes()).toContain('ink-btn')
  })
  it('auth-card 源码无 Courier New 字族飞地', () => {
    expect(vueSrc('AuthGate.vue')).not.toContain("font-family: 'Courier New'")
    expect(vueSrc('AuthGate.vue')).toContain("font-family: var(--font-body)")
  })
})

/* ═══ RemoteController ═══ */
describe('RemoteController：字族落地 + 逃生链', () => {
  beforeEach(() => { sockets.length = 0 })

  it('.remote-controller pin 住的 --font-body 真正应用（源码断言）', () => {
    const src = vueSrc('RemoteController.vue')
    const block = src.match(/\.remote-controller\s*\{[^}]*\}/s)?.[0] ?? ''
    expect(block).toContain('font-family: var(--font-body)')
  })

  it('rc-exit 常驻：href=origin+pathname（剥 ?mode=controller），断连态也在', async () => {
    const w = track(mount(RemoteController, { props: { wsUrl: 'ws://x/remote?role=controller' } }))
    // 未连接空态下逃生口已渲染
    const exit = w.find('a.rc-exit')
    expect(exit.exists()).toBe(true)
    expect(exit.attributes('href')).toBe(`${window.location.origin}${window.location.pathname}`)
    expect(exit.attributes('aria-label')).toBe('退出遥控模式')
    // 连接后封面裂图 → 占位格
    const ws = sockets.at(-1)
    ws.open()
    ws.recv({ type: 'state_update', payload: { currentSong: { id: 9, name: '歌', al: { picUrl: 'https://i.ytimg.com/vi/x/hqdefault.jpg' }, ar: [] } } })
    await nextTick()
    const img = w.find('img.rc-cover')
    expect(img.exists()).toBe(true)
    await img.trigger('error')
    expect(w.find('.rc-cover-placeholder').exists()).toBe(true)
  })
})

/* ═══ FeedbackHost ═══ */
describe('FeedbackHost：toast 枚举戳本地化', () => {
  it("type='error' 渲「错误」、success 渲「完成」，未知类型原样透出", async () => {
    track(mount(FeedbackHost, { attachTo: document.body }))
    toast('出错了喵', 'error')
    toast('好了', 'success')
    await nextTick()
    const tags = [...document.querySelectorAll('.fb-toast-tag')].map(el => el.textContent)
    expect(tags).toContain('错误:')
    expect(tags).toContain('完成:')
    // 样式类仍走英文枚举——文案与皮肤解耦
    expect(document.querySelector('.fb-toast--error')).not.toBeNull()
  })
})

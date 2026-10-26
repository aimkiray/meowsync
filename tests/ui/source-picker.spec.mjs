// 「换源」手动媒体源绑定钉板（vitest+jsdom）：
//   SourcePicker — 开屏并行拉「媒体源候选 + 现有绑定」（检索词=客户端
//                 KWFORM 镜像派生显式传 keyword——服务端在场跳过 detail
//                 兜底）、源徽标/封面 img-proxy/时长贴近排序（客户端持
//                 song0.dt 自排）/当前绑定标、选定→POST→applied+关窗、
//                 404「已失效或不可播」内联留窗、errors 单源故障部行、
//                 恢复自动匹配解绑、sp-direct 粘贴直绑：本地净形零出站
//                 先解（BV/B站链/youtu.be/裸 id 直 POST 不带快照），av 号/
//                 b23·bili2233 短链/包裹分享文本交远端 resolve→同一条
//                 POST（快照透传、kind 分诊内联、busy/abort 同闸），谓词
//                 不收照旧内联错、空串禁按；Esc/遮罩三点/busy 闸/卸载断链；
//                 检索条改词重检/恢复默认/失败重试复打手动词/幂等闸
//   musicApi 契约 — 真 wrapper 走假 http 层：getManualUnlock HTTP 404→
//                 null、getUnlockCandidates 参数形与 keyword 省略、
//                 pick/clear 调用形状与业务码闸（与 api-contract 谱同型，
//                 收本文件避开其文件域）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const { musicApi, toast } = vi.hoisted(() => ({
  musicApi: {
    getUnlockCandidates: vi.fn(async () => ({ keyword: '', candidates: [], errors: [] })),
    getManualUnlock: vi.fn(async () => null),
    resolveUnlockMedia: vi.fn(async () => ({ code: 200, source: 'bilibili', mediaId: 'BV1xx411c7mD' })),
    pickManualUnlock: vi.fn(async () => ({})),
    clearManualUnlock: vi.fn(async () => ({})),
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
import SourcePicker from '../../src/components/SourcePicker.vue'

const flush = () => new Promise(r => setTimeout(r, 0))

// 网易数值曲（解锁链只服务此形态）——派生词=name - artists.join(' / ')
const SONG = { id: '12345', name: '歌名', ar: [{ name: '甲' }, { name: '乙' }], dt: 205000 }
const DERIVED_KW = '歌名 - 甲 / 乙'

// dt=205s：按时长贴近排序应为 BV(206s)→yt(300s)→无时长殿后（源序见下）
const CANDIDATES = [
  {
    source: 'youtube', mediaId: 'abcdefghijk', title: '错配翻唱', owner: 'UP-A',
    durationSec: 300, cover: 'https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg',
    publishedTimeText: '3 年前'
  },
  {
    source: 'bilibili', mediaId: 'BV1xx411c7mD', title: '官方源', owner: 'UP-B',
    durationSec: 206, cover: 'https://i0.hdslb.com/bfs/c.jpg'
  },
  {
    source: 'youtube', mediaId: 'klmnopqrstu', title: '无时长稿', owner: '',
    cover: ''
  },
]

const feed = (list = CANDIDATES, extra = {}) =>
  ({ keyword: DERIVED_KW, candidates: [...list], errors: [], ...extra })

// Teleport 到 body——DOM 断言/派发一律走 document，wrapper 只收 emitted
const mounted = []
const mountPicker = (props = {}) => {
  const w = mount(SourcePicker, { attachTo: document.body, props: { song: SONG, ...props } })
  mounted.push(w)
  return w
}
const dialogEl = () => document.querySelector('.sp-dialog')
const overlayEl = () => document.querySelector('.atp-overlay')
const rowEls = () => [...document.querySelectorAll('.sp-row')]
const keydown = (el, key) => el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
const searchInput = () => document.querySelector('.sp-search input')
const searchGo = () => document.querySelector('.sp-search-go')
const resetBtn = () => document.querySelector('.sp-search-reset')
const directInput = () => document.querySelector('.sp-direct input')
const directGo = () => document.querySelector('.sp-direct-go')
// v-model 直喂：设值+input 事件（组件内部 trim，原始串留在框里作读数）
const typeIn = (el, q) => {
  el.value = q
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
const submitSearch = () => keydown(searchInput(), 'Enter')
const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }))

beforeEach(() => {
  vi.clearAllMocks()
  // 回显如实回传提交词——服务端 keyword=实际用掉的词（显式传词则原样回显）；
  // lastFeed 以回显为锚，回显改写词（契约漂移面）由「keyword 回显校正」例专钉
  musicApi.getUnlockCandidates.mockImplementation(async ({ keyword }) => feed(CANDIDATES, { keyword }))
  musicApi.getManualUnlock.mockResolvedValue(null)
  musicApi.resolveUnlockMedia.mockResolvedValue({
    code: 200, source: 'bilibili', mediaId: 'BV1xx411c7mD',
    title: '远端标题', owner: 'UP-C', durationSec: 200
  })
  musicApi.pickManualUnlock.mockResolvedValue({ code: 200, hit: {} })
  musicApi.clearManualUnlock.mockResolvedValue({ code: 200 })
})
afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  document.body.innerHTML = ''
})

describe('SourcePicker：候选列表', () => {
  it('开屏并行拉候选+现有绑定（显式传派生 keyword）；徽标/标题—频道/时长/封面/img-proxy/发布档渲染', async () => {
    mountPicker()
    await flush()
    // 首载显式传客户端镜像派生词——服务端 keyword 在场跳过 detail 兜底
    expect(musicApi.getUnlockCandidates).toHaveBeenCalledWith(
      { id: '12345', keyword: DERIVED_KW },
      expect.any(AbortSignal)
    )
    expect(musicApi.getManualUnlock).toHaveBeenCalledWith('12345', expect.any(AbortSignal))

    // 预填词=派生词公式；词未偏离不露「恢复默认」
    expect(searchInput().value).toBe(DERIVED_KW)
    expect(resetBtn()).toBeNull()

    // 时长贴近排序（|durationSec - dt/1000| 升序，缺值殿后）：
    // 源序是 yt(300)→bv(206)→yt(无时长)，渲染序是 bv(差1s)→yt(差95s)→无时长
    const rows = rowEls()
    expect(rows).toHaveLength(3)
    const badges = [...document.querySelectorAll('.sp-badge')].map(b => b.textContent)
    expect(badges).toEqual(['B站', 'YT', 'YT'])
    // a11y：徽标是 aria-hidden 视觉缩写——行按钮 aria-label 自报源名，
    // SR 用户据此分清这是 YouTube 还是 B站候选（R2-N1）
    expect(rows[0].getAttribute('aria-label')).toBe('B站 候选：官方源 — UP-B')
    expect(rows[1].getAttribute('aria-label')).toBe('YouTube 候选：错配翻唱 — UP-A')
    expect(rows[2].getAttribute('aria-label')).toBe('YouTube 候选：无时长稿')
    expect(rows[0].textContent).toContain('官方源 — UP-B')
    expect(rows[0].textContent).toContain('3:26')   // 206s → m:ss
    expect(rows[1].textContent).toContain('错配翻唱 — UP-A')
    expect(rows[1].textContent).toContain('5:00')   // 300s
    expect(rows[1].textContent).toContain('3 年前')  // publishedTimeText 灰字小标
    expect(rows[2].textContent).toContain('无时长稿')
    expect(rows[2].querySelector('.sp-dur')).toBeNull() // durationSec 缺席不出时长

    // 封面 src 经 /img-proxy 包装（i.ytimg/hdslb 均在白名单）；cover 缺席
    // 落 fallback 音符块
    const thumbs = [...document.querySelectorAll('img.sp-thumb')]
    expect(thumbs).toHaveLength(2)
    expect(thumbs[0].getAttribute('src')).toContain('/img-proxy?url=')
    expect(thumbs[0].getAttribute('src')).toContain(encodeURIComponent('https://i0.hdslb.com/bfs/c.jpg'))
    expect(thumbs[1].getAttribute('src')).toContain('/img-proxy?url=')
    expect(rows[2].querySelector('.sp-thumb--fallback')).toBeTruthy()

    // 无手动绑定 → 页脚「恢复自动匹配」不出
    expect(document.querySelector('.sp-clear')).toBeNull()
    expect(dialogEl().getAttribute('aria-label')).toBe('手动选择播放源')
  })

  it('keyword 回显校正 defaultKeyword：默认判定与恢复默认认服务端回显词', async () => {
    musicApi.getUnlockCandidates.mockResolvedValue(feed(CANDIDATES, { keyword: '服务端校正词' }))
    const w = mountPicker()
    await flush()
    // 回包 keyword 是「实际用掉的词」——回显为锚校正默认口径
    expect(w.vm.defaultKeyword).toBe('服务端校正词')
    // 框里还是派生词（与校正后默认口径不同）→ 「恢复默认」露面；
    // 点击回填校正词并以它重检
    expect(resetBtn()).toBeTruthy()
    click(resetBtn())
    await flush()
    expect(searchInput().value).toBe('服务端校正词')
    expect(musicApi.getUnlockCandidates).toHaveBeenLastCalledWith(
      { id: '12345', keyword: '服务端校正词' }, expect.anything())
  })

  it('artists 空回落裸 name 派生词（KWFORM 回落支）', async () => {
    mountPicker({ song: { id: '999', name: '裸名曲', ar: [], dt: 60000 } })
    await flush()
    expect(musicApi.getUnlockCandidates).toHaveBeenCalledWith(
      { id: '999', keyword: '裸名曲' }, expect.anything())
    expect(searchInput().value).toBe('裸名曲')
  })

  it('song.custom 无影响——词公式只认 name+ar（与 KWFORM 同一条规则句）', async () => {
    mountPicker({ song: { ...SONG, artists: [{ name: 'A' }], ar: undefined } })
    await flush()
    // ar 缺席吃 artists 槽（同一份 (ar||artists) 回落）
    expect(musicApi.getUnlockCandidates).toHaveBeenCalledWith(
      { id: '12345', keyword: '歌名 - A' }, expect.anything())
  })

  it('单源故障部行：errors 在场渲染 sp-partial 不挡候选列表', async () => {
    musicApi.getUnlockCandidates.mockResolvedValue(
      feed(CANDIDATES, { errors: [{ source: 'youtube', msg: 'yt 风控' }] }))
    mountPicker()
    await flush()
    const partial = document.querySelector('.sp-partial')
    expect(partial?.textContent).toContain('部分源检索失败')
    expect(partial?.textContent).toContain('youtube')
    expect(rowEls().length).toBe(3) // 他源照常下发不挡列表
  })

  it('候选检索失败 → 错误态文案 + 「重试」键再发一轮', async () => {
    musicApi.getUnlockCandidates.mockRejectedValueOnce(new Error('boom'))
    mountPicker()
    await flush()
    expect(document.querySelector('.sp-state')?.textContent).toContain('检索失败')
    expect(document.querySelector('.sp-state')?.textContent).toContain('boom')
    expect(rowEls()).toHaveLength(0)
    click(document.querySelector('.sp-retry button'))
    await flush()
    expect(musicApi.getUnlockCandidates).toHaveBeenCalledTimes(2)
    expect(rowEls()).toHaveLength(3)
    expect(document.querySelector('.sp-state')).toBeNull()
  })

  it('加载中与空候选两态文案；手动空池念用户词', async () => {
    musicApi.getUnlockCandidates.mockReturnValue(new Promise(() => {})) // 挂起停在加载态
    mountPicker()
    await flush()
    expect(document.querySelector('.sp-state')?.textContent).toContain('正在检索媒体源')
    mounted.pop().unmount()
    document.body.innerHTML = ''

    musicApi.getUnlockCandidates.mockImplementation(async ({ keyword }) => feed([], { keyword }))
    mountPicker()
    await flush()
    expect(document.querySelector('.sp-state')?.textContent)
      .toBe('YouTube / B 站都没有这首歌的候选媒体源')
    // 手动检索空池念用户词（分口径空态文案——lastFeed 以回显为锚，回显=提交词）
    typeIn(searchInput(), '无果词')
    submitSearch()
    await flush()
    expect(document.querySelector('.sp-state')?.textContent).toBe('「无果词」没有候选媒体源')
  })
})

describe('SourcePicker：检索条', () => {
  it('改词 Enter 提交：{id, keyword:整串用户词} 重检并替换候选', async () => {
    mountPicker()
    await flush()
    musicApi.getUnlockCandidates.mockResolvedValueOnce(feed([
      { source: 'youtube', mediaId: 'zzzzzzzzzzz', title: '手动命中', durationSec: 10 }
    ]))
    typeIn(searchInput(), ' 新词 ')
    submitSearch()
    await flush()
    expect(musicApi.getUnlockCandidates).toHaveBeenCalledTimes(2)
    expect(musicApi.getUnlockCandidates).toHaveBeenLastCalledWith(
      { id: '12345', keyword: '新词' }, expect.any(AbortSignal))
    // 输入框保留原始串作「当前检索词」读数；候选整体替换
    expect(searchInput().value).toBe(' 新词 ')
    const rows = rowEls()
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('手动命中')
    expect(resetBtn()).toBeTruthy() // 词偏离默认口径 → 「恢复默认」露面
  })

  it('幂等闸：同词重复提交不再扇出；空串钮禁用+Enter 忽略', async () => {
    mountPicker()
    await flush()
    typeIn(searchInput(), '新词')
    submitSearch()
    await flush()
    expect(musicApi.getUnlockCandidates).toHaveBeenCalledTimes(2)
    // 同词 Enter / 点钮都静默跳过——与上次实际提交同口径且非失败态
    submitSearch()
    click(searchGo())
    await flush()
    expect(musicApi.getUnlockCandidates).toHaveBeenCalledTimes(2)
    // 词 trim 回默认口径=真打一发默认检索（lastFeed 是手动词非默认支，
    // 幂等闸只盖「同口径重提」不盖「口径切换」）——预填词回车语义
    // 是重打默认检索
    typeIn(searchInput(), ` ${DERIVED_KW} `)
    submitSearch()
    await flush()
    expect(musicApi.getUnlockCandidates).toHaveBeenCalledTimes(3)
    expect(musicApi.getUnlockCandidates).toHaveBeenLastCalledWith(
      { id: '12345', keyword: DERIVED_KW }, expect.any(AbortSignal))
    // 空串无意义：提交钮 disabled + Enter 忽略
    typeIn(searchInput(), '   ')
    await flush()
    expect(searchGo().disabled).toBe(true)
    submitSearch()
    await flush()
    expect(musicApi.getUnlockCandidates).toHaveBeenCalledTimes(3)
  })

  it('手动词失败：失败态放行同词再提交；「重试」复打手动词不回落默认词', async () => {
    mountPicker()
    await flush()
    musicApi.getUnlockCandidates.mockRejectedValueOnce(new Error('boom'))
    typeIn(searchInput(), '手动词')
    submitSearch()
    await flush()
    expect(document.querySelector('.sp-state')?.textContent).toContain('检索失败')
    expect(musicApi.getUnlockCandidates).toHaveBeenLastCalledWith(
      expect.objectContaining({ keyword: '手动词' }), expect.anything())
    // 失败态幂等闸放行：同词 Enter 是真发一发（不是静默跳过）
    musicApi.getUnlockCandidates.mockRejectedValueOnce(new Error('boom2'))
    submitSearch()
    await flush()
    expect(musicApi.getUnlockCandidates).toHaveBeenCalledTimes(3)
    // 重试键复打「最后一次实际提交的口径」——手动词不回落默认词
    click(document.querySelector('.sp-retry button'))
    await flush()
    expect(musicApi.getUnlockCandidates).toHaveBeenCalledTimes(4)
    expect(musicApi.getUnlockCandidates).toHaveBeenLastCalledWith(
      { id: '12345', keyword: '手动词' }, expect.any(AbortSignal))
    expect(rowEls()).toHaveLength(3) // 落默认候选 → 错误态退场
  })

  it('恢复默认：回填默认词并立即以默认口径重检', async () => {
    mountPicker()
    await flush()
    typeIn(searchInput(), '新词')
    submitSearch()
    await flush()
    expect(searchInput().value).toBe('新词')
    click(resetBtn())
    await flush()
    // 回填默认词 + 立即以默认口径重检——不是只填不搜
    expect(searchInput().value).toBe(DERIVED_KW)
    expect(musicApi.getUnlockCandidates).toHaveBeenCalledTimes(3)
    expect(musicApi.getUnlockCandidates).toHaveBeenLastCalledWith(
      { id: '12345', keyword: DERIVED_KW }, expect.any(AbortSignal))
    expect(resetBtn()).toBeNull() // 回到默认词 → 钮收起
  })

  it('busy（绑定在飞）期检索条/直绑行整体禁用（与关窗通道同闸）', async () => {
    let resolvePick
    musicApi.pickManualUnlock.mockReturnValue(new Promise(r => { resolvePick = r }))
    mountPicker()
    await flush()
    typeIn(searchInput(), '新词') // 让恢复默认露出
    typeIn(directInput(), 'BV1xx411c7mD')
    await flush()
    rowEls()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(searchInput().disabled).toBe(true)
    expect(searchGo().disabled).toBe(true)
    expect(resetBtn().disabled).toBe(true)
    expect(directInput().disabled).toBe(true)
    expect(directGo().disabled).toBe(true)
    resolvePick({ code: 200, hit: {} })
    await flush()
  })

  it('检索在飞期再提交：前一发的 AbortSignal 被掐断（load 重铸 _aborter）', async () => {
    musicApi.getUnlockCandidates.mockReturnValue(new Promise(() => {})) // 首载挂起
    mountPicker()
    await flush()
    const firstSignal = musicApi.getUnlockCandidates.mock.calls[0][1]
    expect(firstSignal.aborted).toBe(false)
    typeIn(searchInput(), '重入词')
    submitSearch()
    await flush()
    expect(musicApi.getUnlockCandidates).toHaveBeenCalledTimes(2)
    expect(firstSignal.aborted).toBe(true) // 第一发被掐——新旧两发不串话
  })

  it('候选检索 loading 不锁检索条（busy 闸只盖提交面（pick/clear/resolve），不盖 loading）', async () => {
    musicApi.getUnlockCandidates.mockReturnValue(new Promise(() => {})) // 挂起停在检索态
    mountPicker()
    await flush()
    expect(document.querySelector('.sp-state')?.textContent).toContain('正在检索媒体源')
    expect(searchInput().disabled).toBe(false)
    expect(searchGo().disabled).toBe(false)
    expect(directInput().disabled).toBe(false)
  })
})

describe('SourcePicker：选定/解绑', () => {
  it('点候选 → POST {id,source,mediaId,title,owner,durationSec} → applied+close+成功 toast', async () => {
    const w = mountPicker()
    await flush()
    rowEls()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(musicApi.pickManualUnlock).toHaveBeenCalledWith({
      id: '12345', source: 'bilibili', mediaId: 'BV1xx411c7mD',
      title: '官方源', owner: 'UP-B', durationSec: 206
    })
    expect(w.emitted('applied')).toEqual([['12345']])
    expect(w.emitted('close')).toHaveLength(1)
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('B站'), 'success')
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('媒体源'), 'success')
  })

  it('绑定 404 → 内联「已失效或不可播」留窗，不 applied 不关窗', async () => {
    const err = new Error('gone')
    err.response = { status: 404 }
    musicApi.pickManualUnlock.mockRejectedValue(err)
    const w = mountPicker()
    await flush()
    rowEls()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(document.querySelector('.sp-pickerr')?.textContent).toBe('该媒体源已失效或不可播')
    expect(w.emitted('applied')).toBeUndefined()
    expect(w.emitted('close')).toBeUndefined()
    expect(dialogEl()).toBeTruthy() // 窗还在
  })

  it('绑定业务码 404（HTTP 200 下发）同内联留窗', async () => {
    const err = new Error('gone')
    err.bizCode = 404
    musicApi.pickManualUnlock.mockRejectedValue(err)
    const w = mountPicker()
    await flush()
    rowEls()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(document.querySelector('.sp-pickerr')?.textContent).toBe('该媒体源已失效或不可播')
    expect(w.emitted('close')).toBeUndefined()
  })

  it('绑定其它错误 → error toast 留窗重挑', async () => {
    musicApi.pickManualUnlock.mockRejectedValue(new Error('boom'))
    const w = mountPicker()
    await flush()
    rowEls()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(toast).toHaveBeenCalledWith('boom', 'error')
    expect(w.emitted('applied')).toBeUndefined()
    expect(dialogEl()).toBeTruthy()
  })

  it('开窗后 prop 换歌不串绑：pick 仍提交开窗曲 id（song0 快照钉死）', async () => {
    const w = mountPicker() // SONG.id = '12345'
    await flush()
    await w.setProps({ song: { id: '67890', name: '切走的新歌', ar: [] } })
    rowEls()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(musicApi.pickManualUnlock).toHaveBeenCalledWith(
      expect.objectContaining({ id: '12345', mediaId: 'BV1xx411c7mD' }))
    expect(w.emitted('applied')).toEqual([['12345']])
  })

  it('已有手动绑定 → 页脚绑定摘要+「恢复自动匹配」→ DELETE → applied+close；绑定行高亮打「当前绑定」', async () => {
    musicApi.getManualUnlock.mockResolvedValue({
      source: 'bilibili', mediaId: 'BV1xx411c7mD',
      title: '官方源', owner: 'UP-B', durationSec: 206, updatedAt: 'x'
    })
    const w = mountPicker()
    await flush()
    // 绑定摘要：徽标 + 源名文本 + title — owner + mediaId 括注（徽标
    // aria-hidden——摘要文本本身必须含源名，R2-N1）
    const manual = document.querySelector('.sp-manual')
    expect(manual?.textContent).toContain('当前绑定')
    expect(manual?.textContent).toContain('B站 · 官方源')
    expect(manual?.textContent).toContain('BV1xx411c7mD')
    // 同 source+mediaId 的候选行高亮 + 「当前绑定」小标——aria-label
    // 同样补标（小标是视觉件）
    const current = rowEls().find(r => r.querySelector('.sp-current'))
    expect(current?.classList.contains('sp-row--current')).toBe(true)
    expect(current?.getAttribute('aria-label')).toBe('B站 候选：官方源 — UP-B（当前绑定）')
    expect(current?.textContent).toContain('官方源')

    const clearBtn = document.querySelector('.sp-clear')
    expect(clearBtn?.textContent).toContain('恢复自动匹配（解除手动绑定）')
    click(clearBtn)
    await flush()
    expect(musicApi.clearManualUnlock).toHaveBeenCalledWith('12345')
    expect(toast).toHaveBeenCalledWith('已恢复自动匹配', 'success')
    expect(w.emitted('applied')).toEqual([['12345']])
    expect(w.emitted('close')).toHaveLength(1)
  })

  it('R2-SF：当前行底色走 --ink-10 令牌（暗色主题随动），不存在令牌 --accent-soft 不再出场', async () => {
    // scoped CSS 不注入 jsdom——读 SFC 源文本直接钉样式令牌口径
    //（vitest cwd=仓库根）
    const sfc = readFileSync(resolve('src/components/SourcePicker.vue'), 'utf8')
    expect(sfc).toMatch(/\.sp-row--current\s*\{[^}]*--ink-10/)
    expect(sfc).not.toContain('--accent-soft')
  })
})

describe('SourcePicker：外源轨道（qq_/bv_/yt_）', () => {
  // 外源曲同享换源设施（自有源败亡时绑定点名媒体顶替——服务端
  // isUnlockManualTrackId 的外源三段）。派生词基值取 provider 原标题：
  // bv_/yt_ 的 song.name 可能被匹配覆写，bilibili.title/youtube.title
  // 才是源站真锚；qq_ 无 provider title 字段、name 即权威曲名自然回落。
  // 页脚解绑口与 toast 分形态——外源无「自动匹配」可恢复，回落的是自有
  // 源腿；数值曲回归由「开屏并行拉候选」谱的 DERIVED_KW 断言盖着
  it('bv_ 曲首载 keyword=<bilibili.title> - <UP主>（name 被匹配覆写不取）', async () => {
    mountPicker({
      song: {
        id: 'bv_BV1xx411c7mD', name: '匹配覆写名', ar: [{ name: 'UP主甲' }],
        bilibili: { bvid: 'BV1xx411c7mD', title: 'B站原标题' }, dt: 205000,
      },
    })
    await flush()
    expect(musicApi.getUnlockCandidates).toHaveBeenCalledWith(
      { id: 'bv_BV1xx411c7mD', keyword: 'B站原标题 - UP主甲' },
      expect.any(AbortSignal))
    expect(searchInput().value).toBe('B站原标题 - UP主甲')
  })

  it('bv_ 裸 id（缺 bilibili 对象老行）→ 基值回落 name', async () => {
    mountPicker({ song: { id: 'bv_BV1xx411c7mD', name: '裸bv名', ar: [{ name: 'UP乙' }], dt: 0 } })
    await flush()
    expect(musicApi.getUnlockCandidates).toHaveBeenCalledWith(
      { id: 'bv_BV1xx411c7mD', keyword: '裸bv名 - UP乙' }, expect.anything())
  })

  it('yt_ 曲基值取 youtube.title（频道净名挂副词位）', async () => {
    mountPicker({
      song: {
        id: 'yt_abcdefghijk', name: '匹配名', ar: [{ name: '频道净名' }],
        youtube: { videoId: 'abcdefghijk', title: 'YT 原标题' }, dt: 0,
      },
    })
    await flush()
    expect(musicApi.getUnlockCandidates).toHaveBeenCalledWith(
      { id: 'yt_abcdefghijk', keyword: 'YT 原标题 - 频道净名' }, expect.anything())
  })

  it('qq_ 曲=name - 真实艺人表（qq 无 provider title 字段、name 即权威曲名）', async () => {
    mountPicker({
      song: {
        id: 'qq_0034M8WL3V4oHC', name: 'QQ曲名', ar: [{ name: '艺人丙' }, { name: '艺人丁' }],
        qq: { mid: '0034M8WL3V4oHC' }, dt: 0,
      },
    })
    await flush()
    expect(musicApi.getUnlockCandidates).toHaveBeenCalledWith(
      { id: 'qq_0034M8WL3V4oHC', keyword: 'QQ曲名 - 艺人丙 / 艺人丁' }, expect.anything())
  })

  it('外源页脚：解绑钮=「恢复原始源（解除手动绑定）」、toast=「已解除手动绑定」', async () => {
    // 跨源绑合法（bv_ 曲绑 youtube 媒体）——页脚/toast 分形态认轨道 id
    // 不认绑定源
    musicApi.getManualUnlock.mockResolvedValue({
      source: 'youtube', mediaId: 'abcdefghijk',
      title: '绑定媒体', owner: 'O', durationSec: 200, updatedAt: 'x'
    })
    const w = mountPicker({
      song: {
        id: 'bv_BV1xx411c7mD', name: 'bv', ar: [{ name: 'UP' }],
        bilibili: { bvid: 'BV1xx411c7mD', title: 'B站原标题' }, dt: 0,
      },
    })
    await flush()
    const clearBtn = document.querySelector('.sp-clear')
    expect(clearBtn?.textContent).toBe('恢复原始源（解除手动绑定）')
    click(clearBtn)
    await flush()
    expect(musicApi.clearManualUnlock).toHaveBeenCalledWith('bv_BV1xx411c7mD')
    expect(toast).toHaveBeenCalledWith('已解除手动绑定', 'success')
    expect(toast).not.toHaveBeenCalledWith('已恢复自动匹配', expect.anything())
    expect(w.emitted('applied')).toEqual([['bv_BV1xx411c7mD']])
    expect(w.emitted('close')).toHaveLength(1)
  })
})

describe('SourcePicker：sp-direct 粘贴直绑', () => {
  it('裸 BV 号与 B 站视频链接 → bilibili POST（不带 title/owner）', async () => {
    const w = mountPicker()
    await flush()
    typeIn(directInput(), 'BV1xx411c7mD')
    click(directGo())
    await flush()
    expect(musicApi.pickManualUnlock).toHaveBeenLastCalledWith(
      { id: '12345', source: 'bilibili', mediaId: 'BV1xx411c7mD' })
    expect(w.emitted('applied')).toEqual([['12345']])

    mounted.pop().unmount()
    document.body.innerHTML = ''
    const w2 = mountPicker()
    await flush()
    typeIn(directInput(), 'https://www.bilibili.com/video/BV1xx411c7mD/?spm_id=1')
    click(directGo())
    await flush()
    expect(musicApi.pickManualUnlock).toHaveBeenLastCalledWith(
      { id: '12345', source: 'bilibili', mediaId: 'BV1xx411c7mD' })
    expect(w2.emitted('applied')).toEqual([['12345']])
  })

  it('小写 bv 粘贴 → POST mediaId 归一 BV 大写前缀（后 9 位大小写敏感不动）', async () => {
    const w = mountPicker()
    await flush()
    typeIn(directInput(), 'bv1xx411c7md')
    click(directGo())
    await flush()
    // BVID_IN_TEXT_RE /i 宽松形命中小写——POST 前只正前缀，否则服务端
    // BVID_RE 放形收但 B 站接口对 bvid 大小写敏感、验流必 404（R2-N3）
    expect(musicApi.pickManualUnlock).toHaveBeenLastCalledWith(
      { id: '12345', source: 'bilibili', mediaId: 'BV1xx411c7md' })
    expect(w.emitted('applied')).toEqual([['12345']])
  })

  it('直绑输入框 Enter 键触发 bindDirect（与点击同一 POST 路径）', async () => {
    mountPicker()
    await flush()
    typeIn(directInput(), 'BV1xx411c7mD')
    keydown(directInput(), 'Enter')
    await flush()
    expect(musicApi.pickManualUnlock).toHaveBeenLastCalledWith(
      { id: '12345', source: 'bilibili', mediaId: 'BV1xx411c7mD' })
  })

  it('youtu.be 短链与裸 11 位含字母 id → youtube POST（不带 title/owner）', async () => {
    const w = mountPicker()
    await flush()
    typeIn(directInput(), 'https://youtu.be/abcdefghijk')
    click(directGo())
    await flush()
    expect(musicApi.pickManualUnlock).toHaveBeenLastCalledWith(
      { id: '12345', source: 'youtube', mediaId: 'abcdefghijk' })
    expect(w.emitted('applied')).toEqual([['12345']])

    mounted.pop().unmount()
    document.body.innerHTML = ''
    const w2 = mountPicker()
    await flush()
    // 裸 11 位含字母 id（纯数字与网易云 id 撞型由 extractYouTubeId 拒收）
    typeIn(directInput(), 'klmnopqrstu')
    click(directGo())
    await flush()
    expect(musicApi.pickManualUnlock).toHaveBeenLastCalledWith(
      { id: '12345', source: 'youtube', mediaId: 'klmnopqrstu' })
    expect(w2.emitted('applied')).toEqual([['12345']])
  })

  it('av 号/b23·bili2233 短链/bilibili 视频链（无 BV 段）→ 远端解析 → 快照随 POST 透传', async () => {
    const w = mountPicker()
    await flush()
    for (const s of ['av170001', 'AV1', 'https://b23.tv/abc123', 'b23.tv/abc123', 'bili2233.cn/xyz9', 'https://bili2233.cn/xyz9', 'bilibili.com/video/av170001']) {
      typeIn(directInput(), s)
      click(directGo())
      await flush()
      // 本地净形 miss → 远端解析（整串原样送 input 参数）→ 回包净形
      // mediaId+展示快照逐键进同一条 POST
      expect(musicApi.resolveUnlockMedia).toHaveBeenLastCalledWith(s, expect.any(AbortSignal))
      expect(musicApi.pickManualUnlock).toHaveBeenLastCalledWith({
        id: '12345', source: 'bilibili', mediaId: 'BV1xx411c7mD',
        title: '远端标题', owner: 'UP-C', durationSec: 200
      })
      expect(w.emitted('applied')?.length).toBeTruthy()
    }
  })

  it('包裹分享文本（【标题】+短链+尾巴）→ 整串送远端解析再 POST', async () => {
    const w = mountPicker()
    await flush()
    const wrapped = '【某标题】 https://b23.tv/xyz999 快来围观'
    typeIn(directInput(), wrapped)
    click(directGo())
    await flush()
    expect(musicApi.resolveUnlockMedia).toHaveBeenLastCalledWith(wrapped, expect.any(AbortSignal))
    expect(musicApi.pickManualUnlock).toHaveBeenLastCalledWith(
      expect.objectContaining({ source: 'bilibili', mediaId: 'BV1xx411c7mD' }))
    expect(w.emitted('applied')).toEqual([['12345']])
  })

  it('本地净形（BV 裸号/B 站视频链/youtu.be/裸 YT id）→ 本地直解 POST，resolve 零调用', async () => {
    mountPicker()
    await flush()
    for (const s of ['BV1xx411c7mD', 'https://www.bilibili.com/video/BV1xx411c7mD/', 'https://youtu.be/abcdefghijk', 'klmnopqrstu']) {
      typeIn(directInput(), s)
      click(directGo())
      await flush()
      // 本地支先行——零出站优先，远端解析不该被碰
      expect(musicApi.resolveUnlockMedia).not.toHaveBeenCalled()
      expect(musicApi.pickManualUnlock).toHaveBeenCalled()
    }
  })

  it('degraded 回包（无快照键）→ 三键 undefined 透传进 POST（schema optional 容忍缺席）', async () => {
    musicApi.resolveUnlockMedia.mockResolvedValue({ code: 200, source: 'bilibili', mediaId: 'BV1xx411c7mD', degraded: true })
    mountPicker()
    await flush()
    typeIn(directInput(), 'av170001')
    click(directGo())
    await flush()
    const call = musicApi.pickManualUnlock.mock.calls.at(-1)[0]
    expect(call).toMatchObject({ id: '12345', source: 'bilibili', mediaId: 'BV1xx411c7mD' })
    expect(call.title).toBeUndefined()
    expect(call.owner).toBeUndefined()
    expect(call.durationSec).toBeUndefined()
  })

  it('谓词不收的输入（随机文本/裸数字/异源 URL/av 尾巴/qq 系）→ 内联不识别，resolve/POST 零调用', async () => {
    const w = mountPicker()
    await flush()
    for (const s of ['random text', '12345678901', 'example.com/av123', 'foo?av=1', 'notbilibili.com/x', 'xb23.tv/x', 'qq:av1', 'av170001 尾巴']) {
      typeIn(directInput(), s)
      click(directGo())
      await flush()
      expect(document.querySelector('.sp-pickerr')?.textContent).toBe('无法识别的链接或 ID')
      expect(musicApi.resolveUnlockMedia).not.toHaveBeenCalled()
      expect(musicApi.pickManualUnlock).not.toHaveBeenCalled()
      expect(w.emitted('applied')).toBeUndefined()
    }
  })

  it('远端解析 kind 分诊：七值各出专属内联文案、不 POST；kind 缺席回落通用报错', async () => {
    mountPicker()
    await flush()
    const KIND_MSG = {
      invalid: '无法识别的链接或 ID',
      favlist: '这是收藏夹链接，请到顶部搜索框粘贴导入',
      live: '直播间链接不支持绑定媒体源',
      bangumi: '番剧链接不支持绑定媒体源',
      other: '链接指向的内容不支持绑定为媒体源',
      unresolved: '无法解析该链接（短链失效或内容不可读）',
      gone: '该视频不存在或已失效',
    }
    for (const [kind, msg] of Object.entries(KIND_MSG)) {
      const err = new Error('server msg')
      err.kind = kind
      musicApi.resolveUnlockMedia.mockRejectedValueOnce(err)
      typeIn(directInput(), 'av170001')
      click(directGo())
      await flush()
      expect(document.querySelector('.sp-pickerr')?.textContent).toBe(msg)
      expect(musicApi.pickManualUnlock).not.toHaveBeenCalled()
    }
    // kind 缺席（429/502/瞬断）：回落 apiErrorMessage 透出服务端/原生 message
    musicApi.resolveUnlockMedia.mockRejectedValueOnce(new Error('B 站解析失败：上游 503'))
    typeIn(directInput(), 'av170001')
    click(directGo())
    await flush()
    expect(document.querySelector('.sp-pickerr')?.textContent).toBe('B 站解析失败：上游 503')
    expect(musicApi.pickManualUnlock).not.toHaveBeenCalled()
  })

  it('解析在飞期 busy 闸全包：关窗/输入全熄，signal 透传 _aborter；落地后照常 POST', async () => {
    let resolveResolve
    musicApi.resolveUnlockMedia.mockReturnValue(new Promise(r => { resolveResolve = r }))
    const w = mountPicker()
    await flush()
    typeIn(directInput(), 'av170001')
    click(directGo())
    await flush()
    // resolve 已发、POST 未发——「解析→绑定」视作一次提交
    expect(musicApi.resolveUnlockMedia).toHaveBeenCalledWith('av170001', expect.any(AbortSignal))
    expect(musicApi.pickManualUnlock).not.toHaveBeenCalled()
    // busy：Esc/遮罩三点关窗全熄；检索条/直绑行/关闭钮同闸禁用
    keydown(dialogEl(), 'Escape')
    for (const type of ['mousedown', 'mouseup', 'click']) {
      overlayEl().dispatchEvent(new MouseEvent(type, { bubbles: true }))
    }
    expect(w.emitted('close')).toBeUndefined()
    expect(searchInput().disabled).toBe(true)
    expect(directInput().disabled).toBe(true)
    expect(directGo().disabled).toBe(true)
    // 解析落地 → 快照透传 POST → applied+close 正常出
    resolveResolve({ code: 200, source: 'bilibili', mediaId: 'BV1xx411c7mD', title: '远端标题', owner: 'UP-C', durationSec: 200 })
    await flush()
    expect(musicApi.pickManualUnlock).toHaveBeenLastCalledWith({
      id: '12345', source: 'bilibili', mediaId: 'BV1xx411c7mD',
      title: '远端标题', owner: 'UP-C', durationSec: 200
    })
    expect(w.emitted('applied')).toEqual([['12345']])
    expect(w.emitted('close')).toHaveLength(1)
  })

  it('解析在飞期卸载 → abort 送达 resolveUnlockMedia；CanceledError 拒绝静默不留文案', async () => {
    musicApi.resolveUnlockMedia.mockReturnValue(new Promise(() => {})) // 挂起
    const w = mountPicker()
    await flush()
    typeIn(directInput(), 'av170001')
    click(directGo())
    await flush()
    const sig = musicApi.resolveUnlockMedia.mock.calls[0][1]
    expect(sig.aborted).toBe(false)
    mounted.pop() // 手动接管 unmount，避免 afterEach 二次卸
    w.unmount()
    expect(sig.aborted).toBe(true)

    // 窗仍在时 abort 型拒绝：静默 return 不出 pickError
    const w2 = mountPicker()
    await flush()
    const cancel = new Error('canceled')
    cancel.name = 'CanceledError'
    cancel.code = 'ERR_CANCELED'
    musicApi.resolveUnlockMedia.mockRejectedValue(cancel)
    typeIn(directInput(), 'av170001')
    click(directGo())
    await flush()
    expect(document.querySelector('.sp-pickerr')).toBeNull()
    expect(musicApi.pickManualUnlock).not.toHaveBeenCalled()
    expect(w2.emitted('applied')).toBeUndefined()
  })

  it('resolve 回包与 unmount-abort 同 tick 竞态：迟到的成功产物不落 POST（signal.aborted 守卫支）', async () => {
    let resolveResolve
    musicApi.resolveUnlockMedia.mockReturnValue(new Promise(r => { resolveResolve = r }))
    const w = mountPicker()
    await flush()
    typeIn(directInput(), 'av170001')
    click(directGo())
    await flush()
    expect(musicApi.resolveUnlockMedia).toHaveBeenCalledWith('av170001', expect.any(AbortSignal))
    mounted.pop() // 手动接管 unmount，避免 afterEach 二次卸
    w.unmount() // abort 送达——resolve 在飞期间窗已拆
    // 回包迟到落在 aborted 信号上：守卫判 return，不碰 submitPick/POST
    resolveResolve({ code: 200, source: 'bilibili', mediaId: 'BV1xx411c7mD', title: '远端标题', owner: 'UP-C', durationSec: 200 })
    await flush()
    expect(musicApi.pickManualUnlock).not.toHaveBeenCalled()
    expect(w.emitted('applied')).toBeUndefined()
  })

  it('resolve 回包缺 mediaId（契约漂移）→ fail-fast 内联「解析结果异常」留窗，不发空 POST', async () => {
    musicApi.resolveUnlockMedia.mockResolvedValue({ code: 200, source: 'bilibili' })
    const w = mountPicker()
    await flush()
    typeIn(directInput(), 'av170001')
    click(directGo())
    await flush()
    expect(document.querySelector('.sp-pickerr')?.textContent).toBe('解析结果异常，请重试')
    expect(musicApi.pickManualUnlock).not.toHaveBeenCalled()
    expect(w.emitted('applied')).toBeUndefined()
    expect(dialogEl()).toBeTruthy() // 留窗重试
  })

  it('空串禁按；busy 期直绑行同闸', async () => {
    mountPicker()
    await flush()
    typeIn(directInput(), '   ')
    await flush()
    expect(directGo().disabled).toBe(true)
    click(directGo())
    await flush()
    expect(musicApi.pickManualUnlock).not.toHaveBeenCalled()
  })

  it('解析在飞期出「正在解析链接…」状态行（busy 全熄期的读数）；resolve/reject 落地即收', async () => {
    let resolveResolve
    musicApi.resolveUnlockMedia.mockReturnValue(new Promise(r => { resolveResolve = r }))
    const w = mountPicker()
    await flush()
    const hint = () => document.querySelector('.sp-resolving')
    expect(hint()).toBeNull() // idle 不出
    typeIn(directInput(), 'av170001')
    click(directGo())
    await flush()
    // resolve 挂起在飞：状态行在场——全熄期不再是静默弹层；role=status
    // 礼貌档（进度读数非错误，不上 alert/magenta）+ pixel-loading 同语言
    expect(hint()?.textContent).toContain('正在解析链接')
    expect(hint()?.getAttribute('role')).toBe('status')
    expect(hint()?.querySelector('.pixel-loading')).toBeTruthy()
    expect(document.querySelector('.sp-pickerr')).toBeNull()
    // resolve 落地 → 快照透传 POST → 状态行随 finally 双复位收
    resolveResolve({ code: 200, source: 'bilibili', mediaId: 'BV1xx411c7mD', title: '远端标题', owner: 'UP-C', durationSec: 200 })
    await flush()
    expect(hint()).toBeNull()
    expect(w.emitted('applied')).toEqual([['12345']])

    // reject 支：在飞期状态行同样在场 → 落地收 + kind 分诊内联文案在场
    let resolveReject
    musicApi.resolveUnlockMedia.mockReturnValue(new Promise((_, rj) => { resolveReject = rj }))
    typeIn(directInput(), 'av170001')
    click(directGo())
    await flush()
    expect(hint()?.textContent).toContain('正在解析链接')
    const err = new Error('server msg')
    err.kind = 'gone'
    resolveReject(err)
    await flush()
    expect(hint()).toBeNull()
    expect(document.querySelector('.sp-pickerr')?.textContent).toBe('该视频不存在或已失效')
  })

  it('直绑输入 maxlength=500：与服务端 str(input,500) 截断同口径，超长包裹文本两侧不劈叉', async () => {
    mountPicker()
    await flush()
    expect(directInput().getAttribute('maxlength')).toBe('500')
  })
})

describe('SourcePicker：关闭与中止', () => {
  it('Esc 关窗（idle）；绑定在飞期 Esc/遮罩全熄', async () => {
    let resolvePick
    musicApi.pickManualUnlock.mockReturnValue(new Promise(r => { resolvePick = r }))
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
    resolvePick({ code: 200, hit: {} })
    await flush()
    expect(w.emitted('applied')).toEqual([['12345']])
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
    await flush()
    for (const type of ['mousedown', 'mouseup', 'click']) {
      overlayEl().dispatchEvent(new MouseEvent(type, { bubbles: true }))
    }
    expect(w2.emitted('close')).toHaveLength(1)
  })

  it('卸载断开在飞请求（abort 信号送达两个读口）', async () => {
    const w = mountPicker()
    await flush()
    const candSignal = musicApi.getUnlockCandidates.mock.calls[0][1]
    const manualSignal = musicApi.getManualUnlock.mock.calls[0][1]
    w.unmount()
    expect(candSignal.aborted).toBe(true)
    expect(manualSignal.aborted).toBe(true)
  })
})

// ── musicApi 真 wrapper 契约（importActual 绕上层桩，http 动词桩在本文件）──
describe('musicApi：手动媒体源绑定契约', () => {
  it('getManualUnlock：HTTP 404 归 null；命中回 hit 本体（source/mediaId 真值对）', async () => {
    const real = (await vi.importActual('../../src/api/music.js')).musicApi
    const nf = new Error('not found')
    nf.response = { status: 404 }
    http.get.mockRejectedValueOnce(nf)
    expect(await real.getManualUnlock('s1')).toBeNull()

    http.get.mockResolvedValueOnce({
      code: 200,
      hit: { source: 'youtube', mediaId: 'abcdefghijk', title: 'T', owner: 'O', durationSec: 200, updatedAt: 'x' }
    })
    const hit = await real.getManualUnlock('s1')
    expect(hit).toMatchObject({ source: 'youtube', mediaId: 'abcdefghijk', durationSec: 200 })
    expect(http.get).toHaveBeenLastCalledWith('/unlock/manual',
      expect.objectContaining({ params: { id: 's1' } }))
  })

  it('getManualUnlock：body code:404 与缺 source/mediaId 残行均归 null（契约漂移防御）', async () => {
    const real = (await vi.importActual('../../src/api/music.js')).musicApi
    http.get.mockResolvedValueOnce({ code: 404 })
    expect(await real.getManualUnlock('s2')).toBeNull()
    http.get.mockResolvedValueOnce({ code: 200, hit: { title: '只有快照没有真值对' } })
    expect(await real.getManualUnlock('s2')).toBeNull()
  })

  it('getUnlockCandidates：params {id,keyword} + 45s 超时；回包 {keyword,candidates,errors} 形', async () => {
    const real = (await vi.importActual('../../src/api/music.js')).musicApi
    http.get.mockResolvedValueOnce({
      code: 200, keyword: 'kw',
      candidates: [{ source: 'youtube', mediaId: 'm1' }],
      errors: [{ source: 'bilibili', msg: '挂' }]
    })
    const res = await real.getUnlockCandidates({ id: 's9', keyword: 'kw' })
    expect(http.get).toHaveBeenLastCalledWith('/unlock/candidates',
      expect.objectContaining({ params: { id: 's9', keyword: 'kw' }, timeout: 45000 }))
    expect(res).toEqual({
      keyword: 'kw',
      candidates: [{ source: 'youtube', mediaId: 'm1' }],
      errors: [{ source: 'bilibili', msg: '挂' }]
    })

    // keyword 缺席不进 params（服务端兜底派生通道）；errors 缺席归一空数组
    http.get.mockResolvedValueOnce({ code: 200, keyword: 'x', candidates: [] })
    const res2 = await real.getUnlockCandidates({ id: 's9' })
    expect(http.get).toHaveBeenLastCalledWith('/unlock/candidates',
      expect.objectContaining({ params: { id: 's9' } }))
    expect(http.get.mock.calls.at(-1)[1].params.keyword).toBeUndefined()
    expect(res2.errors).toEqual([])
  })

  it('pickManualUnlock：POST 体 {id,source,mediaId,title,owner,durationSec}；code!==200 抛错带 bizCode', async () => {
    const real = (await vi.importActual('../../src/api/music.js')).musicApi
    http.post.mockResolvedValueOnce({
      code: 200,
      hit: { source: 'bilibili', mediaId: 'BV1xx411c7mD', title: '', owner: '', durationSec: null, updatedAt: 'x' }
    })
    const hit = await real.pickManualUnlock({
      id: 's1', source: 'bilibili', mediaId: 'BV1xx411c7mD', title: 'T', owner: 'O', durationSec: 200
    })
    expect(http.post).toHaveBeenLastCalledWith('/unlock/manual',
      { id: 's1', source: 'bilibili', mediaId: 'BV1xx411c7mD', title: 'T', owner: 'O', durationSec: 200 },
      expect.objectContaining({ timeout: 35000 }))
    expect(hit).toMatchObject({ source: 'bilibili', mediaId: 'BV1xx411c7mD' })

    http.post.mockResolvedValueOnce({ code: 404 })
    await expect(real.pickManualUnlock({ id: 's1', source: 'youtube', mediaId: 'x' }))
      .rejects.toMatchObject({ bizCode: 404 })
  })

  it('clearManualUnlock：DELETE ?id= 形状；code!==200 照常抛', async () => {
    const real = (await vi.importActual('../../src/api/music.js')).musicApi
    http.delete.mockResolvedValueOnce({ code: 200 })
    await real.clearManualUnlock('s9')
    expect(http.delete).toHaveBeenCalledWith('/unlock/manual',
      expect.objectContaining({ params: { id: 's9' } }))

    http.delete.mockResolvedValueOnce({ code: 500 })
    await expect(real.clearManualUnlock('s9')).rejects.toThrow(/code 500/)
  })

  it('resolveUnlockMedia：GET /unlock/resolve-media {input}+35s；err.kind 冻结附件两路同达', async () => {
    const real = (await vi.importActual('../../src/api/music.js')).musicApi
    // 成功：回包平铺原样返回（source/mediaId+快照键），signal 透传 axios
    const ac = new AbortController()
    http.get.mockResolvedValueOnce({
      code: 200, source: 'bilibili', mediaId: 'BV1xx411c7mD',
      title: 'T', owner: 'O', durationSec: 200
    })
    const res = await real.resolveUnlockMedia('av170001', ac.signal)
    expect(http.get).toHaveBeenLastCalledWith('/unlock/resolve-media',
      expect.objectContaining({ params: { input: 'av170001' }, signal: ac.signal, timeout: 35000 }))
    expect(res).toMatchObject({ source: 'bilibili', mediaId: 'BV1xx411c7mD', durationSec: 200 })

    // 200 体内业务码（契约漂移防御）：bizCode+kind 双挂
    http.get.mockResolvedValueOnce({ code: 400, message: '输入不是支持的 B 站链接或 ID', kind: 'invalid' })
    await expect(real.resolveUnlockMedia('x'))
      .rejects.toMatchObject({ bizCode: 400, kind: 'invalid', message: '输入不是支持的 B 站链接或 ID' })
    // kind 缺席不挂键
    http.get.mockResolvedValueOnce({ code: 500, message: 'x' })
    const noKind = await real.resolveUnlockMedia('x').catch(e => e)
    expect(noKind.bizCode).toBe(500)
    expect('kind' in noKind).toBe(false)

    // HTTP 错体（kind 主路径）：resolveRethrow 透出 message+e.data，kind 镜像 err.kind
    const nf = new Error('Request failed with status code 404')
    nf.response = { status: 404, data: { code: 404, message: '该视频不存在或已失效', kind: 'gone' } }
    http.get.mockRejectedValueOnce(nf)
    await expect(real.resolveUnlockMedia('https://b23.tv/dead'))
      .rejects.toMatchObject({
        message: '该视频不存在或已失效', kind: 'gone',
        data: { code: 404, message: '该视频不存在或已失效', kind: 'gone' }
      })

    // 漂移角：错体有 kind 缺 message——kind 独立镜像不丢，message 落原生 axios 文案
    const drift = new Error('Request failed with status code 400')
    drift.response = { status: 400, data: { code: 400, kind: 'other' } }
    http.get.mockRejectedValueOnce(drift)
    const driftErr = await real.resolveUnlockMedia('x').catch(e => e)
    expect(driftErr.kind).toBe('other')
    expect(driftErr.message).toBe('Request failed with status code 400')
    // kind/message 双缺的错体不挂 kind 键
    const bare = new Error('Request failed with status code 500')
    bare.response = { status: 500, data: {} }
    http.get.mockRejectedValueOnce(bare)
    const bareErr = await real.resolveUnlockMedia('x').catch(e => e)
    expect('kind' in bareErr).toBe(false)
  })
})

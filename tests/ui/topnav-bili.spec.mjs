// TopNavigation bili: 前缀分派钉板（vitest+jsdom，真实挂载走 handleSearch）：
//   bili:<BV/av/链接/短链> → search-bili（剥前缀后送达 resolve 链——
//     'bili:b23.tv/x' 整串会被 b23 域名判连壳送进 resolve，服务端
//     ^b23\.tv/ 锚被前缀挡必死 400；bili: 块提到整串 B 站判别之前即为此）
//   bili:<收藏夹链>        → search-bili（kw 内 favlist 判，App 层再分）
//   bili:<关键词>          → search-bili-songs（曲库搜索，落顶部 songs 结果区）
//   bili: / bili：<空>     → 静默吞（裸前缀不发事件）
//   无前缀回归：b23.tv/x 裸链、BV 裸号、收藏夹 URL、普通关键词、
//   yt:/qq: 邻源前缀——全部原口径不受影响
//   bili:<异源 URL> → search-bili-songs（前缀=显式源声明，非 B 站形态
//   一律按关键词搜——异源 URL 不送进 resolve 链）
//   已知降级（记录在案不修）：picker 侧 'bili:b23.tv/<收藏夹短链>' 走
//   search-bili resolve 链——服务端把短链跳解到 favlist 落进口导入页，
//   比「bili: 本意搜曲库」的意图回落体验劣化一档
import { describe, it, expect, vi } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'

// musicApi 只在建议拉取等异步路径被触——handleSearch 同步分派不碰它，
// 但模块顶层 import 链要立起来，mock 掉防真 axios 进 jsdom
vi.mock('../../src/api/music.js', () => ({ musicApi: {} }))
vi.mock('../../src/api/auth.js', () => ({ authApi: {} }))

const { default: TopNavigation } = await import('../../src/components/TopNavigation.vue')

// jsdom 无 matchMedia——GlitchText/TopNav 挂载期裸调（menu-focus 同款补丁）
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
}

const mountNav = async (searchQuery) => {
  const wrapper = mount(TopNavigation, {
    attachTo: document.body,
    props: { remoteMode: 'off', searchQuery },
    global: { stubs: { GlitchText: true, PixelIcon: true } },
  })
  await nextTick()
  wrapper.vm.handleSearch()
  await nextTick()
  const emitted = wrapper.emitted()
  wrapper.unmount()
  return emitted
}

const FAV_URL = 'https://space.bilibili.com/42/favlist?fid=123456'

describe('TopNavigation：bili: 前缀分派', () => {
  it('bili:<b23 短链> → search-bili（剥前缀送达——整串连壳送进 resolve 必死）', async () => {
    const e = await mountNav('bili:b23.tv/abc123')
    expect(e['search-bili']).toEqual([['b23.tv/abc123']])
    expect(e['search-bili-songs']).toBeUndefined()
    expect(e.search).toBeUndefined()
  })

  it('bili:<BV/av> → search-bili（剥前缀 BV/av 形态直达 resolve 链）', async () => {
    const e1 = await mountNav('bili:BV1xx411c7XE')
    expect(e1['search-bili']).toEqual([['BV1xx411c7XE']])
    expect(e1['search-bili-songs']).toBeUndefined()
    const e2 = await mountNav('bili:av170001')
    expect(e2['search-bili']).toEqual([['av170001']])
    expect(e2['search-bili-songs']).toBeUndefined()
  })

  it('bili:<bilibili 视频链/收藏夹链> → search-bili（kw 内 URL 形态）', async () => {
    const e = await mountNav('bili:https://www.bilibili.com/video/BV1xx411c7XE')
    expect(e['search-bili']).toEqual([['https://www.bilibili.com/video/BV1xx411c7XE']])
    const e2 = await mountNav(`bili:${FAV_URL}`)
    expect(e2['search-bili']).toEqual([[FAV_URL]]) // favlist 判在 kw 内先行
    expect(e2['search-bili-songs']).toBeUndefined()
  })

  it('bili:<关键词> → search-bili-songs（载荷为去前缀关键词）', async () => {
    const e = await mountNav('bili:周杰伦 青花瓷')
    expect(e['search-bili-songs']).toEqual([['周杰伦 青花瓷']])
    expect(e['search-bili']).toBeUndefined()
    expect(e.search).toBeUndefined()
  })

  it('bili:<异源 URL> → search-bili-songs（前缀=显式源声明，非 B 站形态按关键词搜）', async () => {
    // bili: 前缀内的 URL 若不在 B 站域系（无 BV/bilibili.com/b23.tv/favlist
    // 信号）不进 resolve 链——整串按关键词落曲库搜索
    const e = await mountNav('bili:https://evil.example.com/x')
    expect(e['search-bili-songs']).toEqual([['https://evil.example.com/x']])
    expect(e['search-bili']).toBeUndefined()
    expect(e.search).toBeUndefined()
  })

  it('bili: 裸前缀/空白 → 静默吞不发事件', async () => {
    const e = await mountNav('bili:')
    expect(e['search-bili']).toBeUndefined()
    expect(e['search-bili-songs']).toBeUndefined()
    const e2 = await mountNav('bili：   ')
    expect(e2['search-bili-songs']).toBeUndefined()
    expect(e2.search).toBeUndefined()
  })

  it('bili：<全角冒号>同记号识别', async () => {
    const e = await mountNav('bili：周杰伦')
    expect(e['search-bili-songs']).toEqual([['周杰伦']])
  })

  it('无前缀回归：b23.tv 裸链/BV 裸号/收藏夹 URL 照旧 search-bili', async () => {
    const e1 = await mountNav('b23.tv/abc123')
    expect(e1['search-bili']).toEqual([['b23.tv/abc123']])
    const e2 = await mountNav('BV1xx411c7XE')
    expect(e2['search-bili']).toEqual([['BV1xx411c7XE']])
    const e3 = await mountNav('av170001')
    expect(e3['search-bili']).toEqual([['av170001']])
    const e4 = await mountNav(FAV_URL)
    expect(e4['search-bili']).toEqual([[FAV_URL]])
  })

  it('邻源回归：普通关键词 → search；yt:/qq: 前缀原口径', async () => {
    const e = await mountNav('普通关键词')
    expect(e.search).toEqual([['普通关键词', '普通关键词']])
    const e2 = await mountNav('yt:lofi')
    expect(e2['search-yt-songs']).toEqual([['lofi']])
    const e3 = await mountNav('qq:周杰伦')
    expect(e3['search-qq-songs']).toEqual([['周杰伦']])
  })
})

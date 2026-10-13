// TopNavigation yt: 前缀分派钉板（vitest+jsdom，真实挂载走 handleSearch）：
//   yt:<关键词>            → search-yt-songs（曲库搜索，落顶部 songs 结果区）
//   yt:<裸 videoId/URL>    → search-yt（前缀内可解析输入仍走既有 resolve 链）
//   yt:<纯数字 11 位 id>   → search-yt（载荷改写 ?yt= 分享链形态——
//                            extractYouTubeId 裸分支拒纯数字防撞网易云，
//                            yt: 前缀是显式源声明可绕开；谓词本体不动）
//   yt:<歌单链/裸 listId>  → search-yt（App 层 importYouTubeOrPlaylist 分歌单）
//   yt: / yt：<空>         → 静默吞（裸前缀不发事件）
//   yt：<全角冒号>         → 同记号识别
//   不带前缀的 YouTube URL/歌单链 → 照旧 search-yt（上游判定先于前缀块）
//   普通关键词/qq: 前缀    → 原口径不受影响（search / search-qq-songs 回归钉）
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

describe('TopNavigation：yt: 前缀分派', () => {
  it('yt:<关键词> → search-yt-songs（载荷为去前缀关键词）', async () => {
    const e = await mountNav('yt:lofi beats')
    expect(e['search-yt-songs']).toEqual([['lofi beats']])
    expect(e['search-yt']).toBeUndefined()
    expect(e.search).toBeUndefined()
  })

  it('yt:<裸 videoId> → search-yt（resolve 链接管，不烧搜索配额）', async () => {
    const e = await mountNav('yt:dQw4w9WgXcQ')
    expect(e['search-yt']).toEqual([['dQw4w9WgXcQ']])
    expect(e['search-yt-songs']).toBeUndefined()
  })

  it('yt:<纯数字 videoId> → search-yt（?yt= 形态送达，不落关键词）', async () => {
    // extractYouTubeId 裸分支拒纯数字（防与网易云 id 撞型）——前缀剥壳后
    // 改写 ?yt= 分享链形态，服务端同表可解；摘了 YT_ID_RE 分支即红
    const e = await mountNav('yt:12345678901')
    expect(e['search-yt']).toEqual([['?yt=12345678901']])
    expect(e['search-yt-songs']).toBeUndefined()
  })

  it('yt:<youtu.be 短链> → search-yt（上游 URL 判定先收，载荷带前缀原样透传）', async () => {
    // 带前缀的 URL 先被整串 isYouTubeInput 命中——payload 是含 yt: 的整串，
    // 服务端 extractYouTubeId 非锚定匹配照样解出 id（与 yt:<playlist URL> 同口径）
    const q = 'yt:https://youtu.be/dQw4w9WgXcQ'
    const e = await mountNav(q)
    expect(e['search-yt']).toEqual([[q]])
    expect(e['search-yt-songs']).toBeUndefined()
  })

  it('yt:<裸歌单 id> → search-yt（App 层歌单导入链）', async () => {
    const e = await mountNav('yt:PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf')
    expect(e['search-yt']).toEqual([['PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf']])
    expect(e['search-yt-songs']).toBeUndefined()
  })

  it('yt:<playlist URL> → search-yt（歌单语境先于单曲）', async () => {
    const q = 'yt:https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf'
    const e = await mountNav(q)
    expect(e['search-yt']).toEqual([[q]]) // 载荷原样透传——整串已在上游 playlist 判定命中
    expect(e['search-yt-songs']).toBeUndefined()
  })

  it('yt: 裸前缀/空白 → 静默吞不发事件', async () => {
    expect((await mountNav('yt:'))['search-yt-songs']).toBeUndefined()
    const e = await mountNav('yt：   ')
    expect(e['search-yt-songs']).toBeUndefined()
    expect(e.search).toBeUndefined()
  })

  it('yt：<全角冒号>同记号识别', async () => {
    const e = await mountNav('yt：周杰伦')
    expect(e['search-yt-songs']).toEqual([['周杰伦']])
  })

  it('不带前缀的 YouTube URL/歌单链 → 照旧 search-yt（回归钉）', async () => {
    const e1 = await mountNav('https://youtu.be/dQw4w9WgXcQ')
    expect(e1['search-yt']).toEqual([['https://youtu.be/dQw4w9WgXcQ']])
    const pl = 'https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf'
    const e2 = await mountNav(pl)
    expect(e2['search-yt']).toEqual([[pl]])
  })

  it('普通关键词 → search；qq: 前缀 → search-qq-songs（邻源回归钉）', async () => {
    const e = await mountNav('普通关键词')
    expect(e.search).toEqual([['普通关键词', '普通关键词']])
    const e2 = await mountNav('qq:周杰伦')
    expect(e2['search-qq-songs']).toEqual([['周杰伦']])
    expect(e2['search-yt-songs']).toBeUndefined()
  })
})

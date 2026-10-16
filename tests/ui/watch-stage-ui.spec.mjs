// 播放舞台/底栏域收口用例谱（与 watch-view.spec.mjs 同桩骨架）：
//   - 顶栏 .watch-av 音画分段：出组/双档/aria-pressed/即点即切
//   - 视频缓冲衬底 img（alt=""）+ --wait 透明底 + 「缓冲中」读数章，
//     loadeddata 置位后同步退场
//   - 队列行来源徽标 .queue-src 全源覆盖（bv_/yt_/qq_ 对象+裸 id 兜底、
//     file_ 上传、网易云数字 id 也出「网易云」——songSourceTag 展示档），
//     缩略图 @error 记黑换 fallback（403/坏源不再每次重渲染白打请求）
//   - 校准键面方向词：延后 .5s / 提前 .5s（title/aria 口径不变）
//   - BottomPlayer watchOpen 双向键面 + 方向 cue 翻转 + 唯一 open-watch 入口
//   - jsdom 算不出的 CSS 锚（命中带几何/功能字地板线）走源文本钉板
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// 组件图依赖桩——挂载不打真服务端（与 watch-view.spec.mjs 同组口径）
vi.mock('../../src/api/music.js', () => ({
  musicApi: {
    searchSongs: vi.fn(async () => []),
    bilibiliStreamUrl: vi.fn(() => 'https://x/bili'),
    youtubeStreamUrl: vi.fn(() => 'https://x/yt'),
  },
  parseLyrics: vi.fn(() => []),
  mergeTranslations: vi.fn((l) => l),
}))
vi.mock('../../src/api/downloads.js', () => ({
  downloadsApi: {
    getSongDownloadStatus: vi.fn(async () => null),
    songFileUrl: vi.fn(() => 'http://api/dl'),
  },
}))
vi.mock('../../src/lib/feedback.js', () => ({ toast: vi.fn() }))

import WatchView from '../../src/components/WatchView.vue'
import BottomPlayer from '../../src/components/BottomPlayer.vue'
import { prefVideoOn } from '../../src/lib/prefs.js'

// jsdom 缺口补丁（同 watch-view.spec.mjs 口径）
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
}
if (typeof Element !== 'undefined') {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {}
}

const SONG = { id: 1, name: '歌1', ar: [{ name: '艺人' }], al: { picUrl: '/cover.jpg' }, dt: 200000 }
// YouTube 导入曲：youtube 对象即来源凭据；al.picUrl 用同源相对形——
// proxiedCoverUrl 对非白名单域 fail-closed 回 ''（衬底/缩略图要真 URL）
const YT_SONG = {
  id: 'yt_abcdefghijk', name: 'yt歌', ar: [{ name: 'a' }], al: { picUrl: '/yt.jpg' }, dt: 0,
  youtube: { videoId: 'abcdefghijk', hasVideo: true },
}

const mounted = []
const mountWatch = (props = {}) => {
  const w = mount(WatchView, { attachTo: document.body, props: { currentSong: SONG, tab: 'lyrics', ...props } })
  mounted.push(w)
  return w
}
const mountBottom = (props = {}) => {
  const w = mount(BottomPlayer, { attachTo: document.body, props: { currentSong: SONG, ...props } })
  mounted.push(w)
  return w
}
afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  document.body.innerHTML = ''
})
beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  prefVideoOn.value = true
})

describe('WatchView：顶栏音画分段', () => {
  it('showAvGroup 真 → 双档分段渲染，aria-pressed 报当前态', async () => {
    const w = mountWatch({ currentSong: YT_SONG, tab: 'queue' })
    const seg = w.find('.watch-head .watch-av')
    expect(seg.exists()).toBe(true)
    const btns = w.findAll('.watch-av-btn')
    expect(btns).toHaveLength(2)
    expect(btns[0].text()).toBe('音频')
    expect(btns[1].text()).toBe('视频')
    expect(btns[0].attributes('aria-pressed')).toBe('false')
    expect(btns[1].attributes('aria-pressed')).toBe('true')
  })

  it('无视频位曲不出分段；即点即切翻转共享偏好', async () => {
    const w = mountWatch({ tab: 'queue' })
    expect(w.find('.watch-av').exists()).toBe(false)
    const w2 = mountWatch({ currentSong: YT_SONG, tab: 'queue' })
    await w2.findAll('.watch-av-btn')[0].trigger('click')
    expect(prefVideoOn.value).toBe(false)
    await nextTick()
    expect(w2.findAll('.watch-av-btn')[0].attributes('aria-pressed')).toBe('true')
  })
})

describe('WatchView：视频缓冲衬底与读数章', () => {
  // mediaVideoActive 需要：videoOn + videoId + dl 探测落地（桩回 null→
  // 在线流位）——等 mediaVideoUrl 落地再断言 DOM
  const mountVideo = async () => {
    const w = mountWatch({ currentSong: YT_SONG, tab: 'queue' })
    await vi.waitFor(() => expect(w.vm.mediaVideoUrl).toBe('https://x/yt'))
    await nextTick()
    return w
  }

  it('衬底 img：alt="" + aria-hidden，视频 --wait 底透明期叠在画面下', async () => {
    const w = await mountVideo()
    const under = w.find('.watch-cover--under')
    expect(under.exists()).toBe(true)
    expect(under.attributes('alt')).toBe('')
    expect(under.attributes('aria-hidden')).toBe('true')
    expect(under.attributes('src')).toBe('/yt.jpg')
    const video = w.find('video.watch-cover--video')
    expect(video.exists()).toBe(true)
    expect(video.classes()).toContain('watch-cover--video--wait') // 首帧未达=缓冲期
    expect(w.find('.watch-buffering').exists()).toBe(true)
    expect(w.find('.watch-buffering').text()).toContain('视频缓冲中')
  })

  it('loadeddata 置位：--wait 档与读数章同步退场', async () => {
    const w = await mountVideo()
    const video = w.find('video.watch-cover--video')
    await video.trigger('loadeddata')
    await nextTick()
    expect(w.vm.videoReady).toBe(true)
    expect(w.find('video.watch-cover--video').classes()).not.toContain('watch-cover--video--wait')
    expect(w.find('.watch-buffering').exists()).toBe(false)
  })

  it('playing 事件同样置位（流恢复链兜底）；衬底仍在画面下', async () => {
    const w = await mountVideo()
    await w.find('video.watch-cover--video').trigger('playing')
    await nextTick()
    expect(w.vm.videoReady).toBe(true)
    expect(w.find('.watch-cover--under').exists()).toBe(true)
  })

  it('音频态（videoOn=false）不挂视频也不挂衬底', async () => {
    prefVideoOn.value = false
    const w = mountWatch({ currentSong: YT_SONG, tab: 'queue' })
    await nextTick()
    expect(w.find('video').exists()).toBe(false)
    expect(w.find('.watch-cover--under').exists()).toBe(false)
  })
})

describe('WatchView：队列来源徽标与缩略图记黑', () => {
  it('来源徽标全源覆盖：yt 行出「YouTube」，网易云数字行也出「网易云」', async () => {
    const w = mountWatch({ queue: [SONG, YT_SONG], currentSong: SONG, tab: 'queue' })
    await nextTick()
    const badges = w.findAll('.queue-src')
    expect(badges).toHaveLength(2)
    expect(badges.map(b => b.text())).toEqual(['网易云', 'YouTube'])
    // title 只报出处不缀「导入」——网易云原生曲没有导入语义，外源行同口径免双文案
    expect(badges[0].attributes('title')).toBe('来源：网易云')
    expect(badges[1].attributes('title')).toBe('来源：YouTube')
    // 徽标内联在标题行——不抬虚拟行高（行高仍由 .queue-row 56px 样式承担）
    const title = w.findAll('.queue-row-title')[1]
    expect(title.find('.queue-row-title-text').text()).toBe('yt歌')
    expect(title.find('.queue-src').exists()).toBe(true)
  })

  it('bv_/yt_/qq_ 裸 id 历史行（缺 provider 对象）同出徽标——songSourceTag id 兜底', async () => {
    // 与 SongList .song-tag 同一条 songSourceTag 收口：旧持久化行只剩前缀 id
    // 也出徽标（lib 层全矩阵断言见 tests/song.test.mjs）；纯数字行出「网易云」
    const rows = [
      { id: 'bv_BV1xx411c7mD', name: '裸bv', ar: [], al: {}, dt: 0 },
      { id: 'yt_abcdefghijk', name: '裸yt', ar: [], al: {}, dt: 0 },
      { id: 'qq_004abc123def', name: '裸qq', ar: [], al: {}, dt: 0 },
      SONG, // 纯数字网易云 id——展示档归名「网易云」
    ]
    const w = mountWatch({ queue: rows, currentSong: SONG, tab: 'queue' })
    await nextTick()
    expect(w.findAll('.queue-src').map(b => b.text())).toEqual(['B站', 'YouTube', 'QQ音乐', '网易云'])
  })

  it('缩略图 @error 记黑换 fallback 音符壳，alt="" 读屏去重', async () => {
    const w = mountWatch({ queue: [SONG, YT_SONG], currentSong: SONG, tab: 'queue' })
    await nextTick()
    const rows = w.findAll('.queue-row')
    const thumb = rows[0].find('img.watch-queue-thumb')
    expect(thumb.exists()).toBe(true)
    expect(thumb.attributes('alt')).toBe('')
    await thumb.trigger('error')
    await nextTick()
    // 出错行记黑换 fallback 壳；第二行未出错——各行独立记账
    expect(rows[0].find('img.watch-queue-thumb').exists()).toBe(false)
    expect(rows[0].find('.watch-queue-thumb--fallback').exists()).toBe(true)
    expect(rows[1].find('img.watch-queue-thumb').exists()).toBe(true)
  })
})

describe('WatchView：歌词校准键面方向词', () => {
  it('延后/提前键面带方向词，title/aria 口径不变', () => {
    const w = mountWatch({ lyrics: [{ time: 1, text: '一' }], tab: 'lyrics' })
    const group = w.find('.lyric-tools-group[aria-label="歌词时间校准"]')
    const btns = group.findAll('button')
    expect(btns[0].text()).toBe('延后 .5s')
    expect(btns[0].attributes('title')).toBe('歌词延后 0.5 秒')
    expect(btns[0].attributes('aria-label')).toBe('歌词延后 0.5 秒')
    expect(btns[2].text()).toBe('提前 .5s')
    expect(btns[2].attributes('title')).toBe('歌词提前 0.5 秒')
    expect(btns[2].attributes('aria-label')).toBe('歌词提前 0.5 秒')
  })
})

describe('BottomPlayer：watchOpen 双向键面', () => {
  it('watchOpen=false → 打开播放页 + 向上 cue；true → 收起播放页 + 向下 cue', async () => {
    const w = mountBottom({ watchOpen: false })
    const meta = w.find('.track-meta')
    expect(meta.attributes('title')).toBe('打开播放页')
    expect(meta.attributes('aria-label')).toBe('打开播放页')
    const cue = w.find('.track-open-cue')
    expect(cue.exists()).toBe(true)
    expect(cue.classes()).not.toContain('track-open-cue--open')
    await w.setProps({ watchOpen: true })
    expect(meta.attributes('title')).toBe('收起播放页')
    expect(meta.attributes('aria-label')).toBe('收起播放页')
    expect(w.find('.track-open-cue').classes()).toContain('track-open-cue--open')
  })

  it('track-meta 仍是唯一 open-watch 入口，emit 载荷=queue', async () => {
    const w = mountBottom({ watchOpen: true })
    await w.find('.track-meta').trigger('click')
    expect(w.emitted('open-watch')).toEqual([['queue']])
  })
})

// ── CSS 源文本钉板：jsdom 不计算媒体查询/伪元素，几何与字号锚只能源读 ──
// vitest 侧 import.meta.url 不是 file 形——源钉板按 cwd（仓根）相对读
const readSrc = (name) => readFileSync(resolve(process.cwd(), 'src/components', name), 'utf8')

describe('CSS 源钉板：命中带/字号地板/分段锚', () => {
  it('bp-progress 命中带并入本体：桌面 5px 上探、触屏 3px，::before 退役', () => {
    const css = readSrc('BottomPlayer.vue')
    // 桌面档：盒体上探到 y=-6（轨道仍钉 y=-1）= 9px 命中带，垫层不吃轨道色
    expect(css).toContain('top: -6px')
    expect(css).toContain('padding-top: 5px')
    expect(css).toContain('background-clip: content-box')
    // 触屏档：上探 3px（带 7px）
    const touchBlock = css.match(/@media \(hover: none\)[\s\S]*?bp-progress[\s\S]*?\n\}/)?.[0] || ''
    expect(touchBlock).toContain('top: -4px')
    expect(touchBlock).toContain('padding-top: 3px')
    // 旧 ::before 隐形带退役——命中域=盒体单一事实源
    expect(css).not.toContain('.bp-progress::before')
  })

  it('功能字地板线：三改件无 <11px 字号', () => {
    for (const name of ['LyricPicker.vue', 'BottomPlayer.vue', 'WatchView.vue']) {
      const css = readSrc(name)
      expect(css.match(/font-size:\s*(?:[0-9]|10)px/), `${name} 仍有 <11px 功能字`).toBeNull()
    }
  })

  it('WatchView 分段/衬底/徽标锚在位，菜单 radio 组退役', () => {
    const css = readSrc('WatchView.vue')
    expect(css).toContain('.watch-av-btn--on')
    // 分段键 36px 触控地板（页头 40px 行内满高胶囊）
    const btnBlock = css.match(/\.watch-av-btn\s*\{[\s\S]*?\}/)?.[0] || ''
    expect(btnBlock).toContain('height: 36px')
    expect(css).toContain('.watch-cover--under')
    expect(css).toContain('.watch-cover--video--wait')
    expect(css).toContain('.watch-buffering')
    expect(css).toContain('.queue-src')
    // 旧菜单音画组特件随上移退役
    expect(css).not.toContain('menuitemradio')
    expect(css).not.toContain('.watch-menu-check')
  })
})

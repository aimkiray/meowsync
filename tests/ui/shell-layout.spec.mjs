// 主页重构 U2（A）源钉板：全宽壳切分 + 逐视图限宽 + chrome 对齐
//   .app-body 去 1440 帽全宽化、侧栏贴左缘 --sidebar-w 令牌化、
//   逐视图 max(--page-pad-x, (100cqw−帽)/2) 限宽公式、
//   顶栏/底栏三列 chrome 对齐、--content-max 与 ≥1472 派生边模型整体退役
//   ——jsdom 不计算样式，几何锚全走源文本钉板（与 playlist-panel.spec.mjs 同口径）
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const readSrc = (rel) => readFileSync(join(process.cwd(), rel), 'utf8')
const vueSrc = (name) => readSrc(join('src/components', name))

describe('style.css 源钉板：全宽壳 + --content-max 退役', () => {
  const css = readSrc('src/style.css')

  it('.app-body 去帽：块内无 max-width/margin auto，width 仍 100%', () => {
    const body = css.match(/\.app-body\s*\{[^}]*\}/)?.[0] || ''
    expect(body).not.toContain('max-width')
    expect(body).not.toContain('margin')
    expect(body).toContain('width: 100%')
  })

  it('.app-sidebar 基规则宽度令牌化 var(--sidebar-w, 260px)', () => {
    const sidebar = css.match(/\.app-sidebar\s*\{[^}]*\}/)?.[0] || ''
    expect(sidebar).toContain('width: var(--sidebar-w, 260px)')
  })

  it('--content-max 两处声明与消费点全删（全文件零命中）', () => {
    expect(css).not.toContain('content-max')
  })

  it('壳列令牌：--sidebar-w:260 + ≥1600 覆写 300/--feed-max 1360', () => {
    expect(css).toContain('--sidebar-w: 260px')
    expect(css).toContain('--view-max: 1120px')
    expect(css).toContain('--feed-max: 1280px')
    const wide = css.match(/@media \(min-width: 1600px\)\s*\{[^}]*\}[^}]*\}/)?.[0] || ''
    expect(wide).toContain('--sidebar-w: 300px')
    expect(wide).toContain('--feed-max: 1360px')
  })

  it('下载页 ≥641 margin 挂点：--view-max 同式内容帽（100cqw）', () => {
    // 挂点走 compact 档 641/640.98 对——直接钉 .downloads-panel 所在媒体块
    // （style.css 另有 asp-dialog 的 641 块，须按内容锁定防误锚）
    const block = css.match(/@media \(min-width: 641px\)\s*\{\s*\.downloads-panel\s*\{[^}]*\}\s*\}/)?.[0] || ''
    expect(block).toContain('margin: 20px max(20px, calc((100cqw - var(--view-max, 1120px)) / 2))')
  })
})

describe('TopNavigation.vue 源钉板：三列 chrome 对齐', () => {
  const src = vueSrc('TopNavigation.vue')

  it('.topnav-inner 去帽：无 max-width/margin: 0 auto', () => {
    const inner = src.match(/\.topnav-inner\s*\{[^}]*\}/)?.[0] || ''
    expect(inner).not.toContain('max-width')
    expect(inner).not.toContain('margin: 0 auto')
  })

  it('≥1024 三列：--sidebar-w minmax(0,480) 1fr + column-gap 归零', () => {
    expect(src).toContain('grid-template-columns: var(--sidebar-w, 260px) minmax(0, 480px) 1fr')
    expect(src).toContain('column-gap: 0')
    expect(src).toContain('.topnav { padding-left: 0; }')
    expect(src).toContain('.topnav-search { justify-content: flex-start; padding-left: var(--page-pad-x, 20px); }')
  })

  it('≥1472 派生边档整体退役（全文件零命中）', () => {
    expect(src).not.toContain('1472')
  })
})

describe('BottomPlayer.vue 源钉板：全宽墨条', () => {
  const src = vueSrc('BottomPlayer.vue')

  it('.player-inner 去帽：无 max-width/margin: 0 auto', () => {
    const inner = src.match(/\.player-inner\s*\{[^}]*\}/)?.[0] || ''
    expect(inner).not.toContain('max-width')
    expect(inner).not.toContain('margin: 0 auto')
  })

  it('≥1024：track-meta 吃 --sidebar-w、走带簇锚主区中线、外层槽归零', () => {
    const dock = src.match(/@media \(min-width: 1024px\)[\s\S]*?\n\}/)?.[0] || ''
    expect(dock).toContain('.bottom-player { padding-left: 0; padding-right: 0; }')
    expect(dock).toContain('flex: 0 0 var(--sidebar-w, 260px)')
    expect(dock).toContain('left: calc(50% + var(--sidebar-w, 260px) / 2)')
    expect(dock).toContain('transform: translate(-50%, -50%)')
    expect(dock).not.toContain('content-max')
  })

  it('碰撞窗护挡：1024–1130 隐藏 .player-time（走带簇出流尾与右簇叠字）', () => {
    const win = src.match(/@media \(min-width: 1024px\) and \(max-width: 1130px\)[\s\S]*?\n\}/)?.[0] || ''
    expect(win).toContain('.player-time')
    expect(win).toContain('display: none')
  })
})

describe('逐视图限宽挂点（100cqw → .app-main 容器）', () => {
  it('SongList.vue .song-list-main 横向 --view-max 帽公式', () => {
    const main = vueSrc('SongList.vue').match(/\.song-list-main\s*\{[^}]*\}/)?.[0] || ''
    expect(main).toContain('padding: var(--page-pad-x, 20px) max(var(--page-pad-x, 20px), calc((100cqw - var(--view-max, 1120px)) / 2))')
  })

  it('PlaylistGrid.vue .playlist-grid-wrap 横向 --view-max 帽公式', () => {
    const wrap = vueSrc('PlaylistGrid.vue').match(/\.playlist-grid-wrap\s*\{[^}]*\}/)?.[0] || ''
    expect(wrap).toContain('padding: 0 max(var(--page-pad-x, 20px), calc((100cqw - var(--view-max, 1120px)) / 2))')
  })

  it('HomeFeed.vue .home-feed padding + .home-shelf 右出血同式 --feed-max', () => {
    const src = vueSrc('HomeFeed.vue')
    const feed = src.match(/\.home-feed\s*\{[^}]*\}/)?.[0] || ''
    expect(feed).toContain('padding: 0 max(var(--page-pad-x, 20px), calc((100cqw - var(--feed-max, 1280px)) / 2))')
    const shelf = src.match(/\.home-shelf\s*\{[\s\S]*?\n\}/)?.[0] || ''
    expect(shelf).toContain('margin-right: calc(-1 * max(var(--page-pad-x, 20px), (100cqw - var(--feed-max, 1280px)) / 2))')
    expect(shelf).toContain('padding-right: max(var(--page-pad-x, 20px), (100cqw - var(--feed-max, 1280px)) / 2)')
  })

  it('DownloadsPanel.vue 根 class 删 sm:m-5（≥640 交 style.css 帽公式）', () => {
    expect(vueSrc('DownloadsPanel.vue')).not.toContain('sm:m-5')
  })
})

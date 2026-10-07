import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// 钉：useVirtualList 滑窗消费方的滚动容器必须关 Chrome scroll anchoring
// （overflow-anchor: none）。机制：窗滑动时 spacer 高随 update() 重算，
// 浏览器锚定把 spacer 伸缩当「视口上方内容增删」调 scrollTop 补偿→scroll
// 事件→update() 再改 spacer→锚定再补偿；触底钳制区叠自由滚轮/触控板惯性
// 即成不断自生的 scroll 事件流=主线程死锁（待播队列滚到底卡死根因）。
// 规则集中登记在 src/style.css 滚动器清单块；误删规则或漏登记新消费方
// 本钉即红。纯文本断言即可——不依赖 DOM。

const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8')

// 剥注释后按 `选择器 { 声明体 }` 切块；@media 内层规则同样被逐条拾出
// （外层 at-rule 的「选择器段」因声明体遇嵌套 { 无法闭合而不成匹配，
// 扫描推进后内部规则仍命中）——断言按「选择器成员」粒度判，不绑书写序
const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map(([, sel, body]) => ({ members: sel.split(',').map((s) => s.trim()), body }))

const anchorless = (cls) =>
  rules.some((r) => r.members.includes(cls) && /overflow-anchor\s*:\s*none\b/.test(r.body))

// useVirtualList 现消费方：WatchView 队列双根（栏内滚 .watch-side-body +
// 单列整页滚 .watch-view）、SongList 行容器、PlaylistGrid 曲列滑窗口。
// 新增消费方=此处补类名+style.css 清单同步登记
const VIRTUAL_SCROLLERS = [
  '.watch-side-body',
  '.watch-view',
  '.song-rows',
  '.playlist-grid-wrap',
]

for (const cls of VIRTUAL_SCROLLERS) {
  test(`scroll anchoring 关闭登记：${cls}`, () => {
    assert.ok(
      anchorless(cls),
      `${cls} 须在 style.css 含 overflow-anchor:none（滑窗 spacer 锚定反馈循环钉）`
    )
  })
}

// 反向闸：清单外滚动器不得顺手关锚定——静态内容锚定无害，滥关徒增认知面；
// 若确有新消费方，走上方 VIRTUAL_SCROLLERS 显式登记
test('overflow-anchor:none 仅落在滑窗滚动器登记册', () => {
  const stray = rules.filter(
    (r) => /overflow-anchor\s*:\s*none\b/.test(r.body) &&
      !r.members.every((m) => VIRTUAL_SCROLLERS.includes(m))
  )
  assert.deepEqual(stray.map((r) => r.members.join(', ')), [])
})

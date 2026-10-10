// 减动豁免 CSS 源文本钉板（node:test）：jsdom/vitest 侧不计算媒体查询，
// style.css 的豁免锚规则只能靠源文本钉进 CI——
//   - 两条 .char-glitch reduce 规则带 :not([data-glitch-motion]) 豁免锚，
//     且 :not() 挂在 :root 复合选择器上（属性在 <html>——挂 .char-glitch
//     上恒匹配，豁免成死代码）
//   - 豁免不外溢：:not([data-glitch-motion]) 全文件恰 2 处
//   - 同块 body/app-shell transition:none 原状保留——色温渐变是真 motion
//     仍守系统闸，豁免只让渡字符腐蚀（prefs.js applyGlitchMotionAttr 是
//     DOM 侧对应闸，JS/CSS 双轨缺一不可）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8')

test('豁免锚：两条 .char-glitch reduce 规则改挂 :root:not([data-glitch-motion])', () => {
  assert.ok(css.includes(
    ':root[data-theme="glitch-restoration"]:not([data-glitch-motion]) .char-glitch { visibility: visible; }'))
  assert.ok(css.includes(
    ':root[data-theme="glitch-restoration"]:not([data-glitch-motion]) .char-glitch::after { content: none; }'))
})

test('豁免不外溢：:not([data-glitch-motion]) 全文件恰 2 处', () => {
  assert.equal(css.match(/:not\(\[data-glitch-motion\]\)/g)?.length, 2)
})

test('同块保留：豁免钉所在 reduce 块内 body/app-shell transition:none 原状', () => {
  // 豁免锚所在媒体块=含 .char-glitch::after 规则的那个 reduce 块（块尾是
  // 行首 }——块内规则的 } 都在行内，\n\} 首个命中即块界）
  const block = css.match(
    /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?char-glitch::after[\s\S]*?\n\}/)?.[0] || ''
  assert.ok(block.includes(':not([data-glitch-motion])'), '豁免锚应在该块内')
  assert.ok(block.includes(':root[data-theme="glitch-restoration"] body,'), 'body 规则原状保留')
  assert.ok(block.includes('.app-shell { transition: none; }'), 'app-shell 规则原状保留')
})

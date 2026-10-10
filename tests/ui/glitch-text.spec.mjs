// GlitchText 分词回归钉板：
//   - 连续空白累加进前 token 的 gap（"a  b" 不塌缩成 "a b"——曾覆盖赋值只留末段）
//   - 行首空白以 gap-only token（chars:[] + gap）保留（曾在 out 为空时整丢）
//   - CJK 逐字独立 token 的既有行为
// 断言走 element.textContent 原值——text() 便捷方法会压/trim 空白，不适用
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import GlitchText from '../../src/components/GlitchText.vue'

// jsdom 无 matchMedia——组件挂载期裸调（menu-focus/queue-virtual-sec 同款最小形）
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
}

// aria-hidden 视觉层——glitch-sr 是屏幕阅读器正本（恒定干净文本），不在断言面
const visualText = w => w.find('span[aria-hidden]').element.textContent

describe('GlitchText 分词', () => {
  it('连续空白累加进前 token 的 gap，不塌缩', () => {
    const w = mount(GlitchText, { props: { text: 'a  b' } })
    expect(visualText(w)).toBe('a  b')
  })

  it('行首空白以 gap-only token 保留', () => {
    const w = mount(GlitchText, { props: { text: ' x' } })
    expect(visualText(w)).toBe(' x')
    // 两个行首空白——钉 gap-only token 的 gap 累加路径（' x' 仅钉建 token）
    expect(visualText(mount(GlitchText, { props: { text: '  x' } }))).toBe('  x')
  })

  it('CJK 逐字独立 token（可字间断行）', () => {
    const w = mount(GlitchText, { props: { text: '发现音乐' } })
    expect(w.findAll('.glitch-word')).toHaveLength(4)
    expect(visualText(w)).toBe('发现音乐')
  })
})

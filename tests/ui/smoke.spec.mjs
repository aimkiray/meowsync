// vitest+jsdom 链路冒烟：ESM 导入 src/、import.meta.env 可用、jsdom DOM、
// Vue 响应式与 @vue/test-utils 挂载全通——后续用例的地基验证
import { describe, it, expect } from 'vitest'
import { ref, computed } from 'vue'
import { mount } from '@vue/test-utils'

describe('vitest 前端通道', () => {
  it('jsdom DOM 可用', () => {
    const el = document.createElement('div')
    el.textContent = 'meowsync'
    document.body.appendChild(el)
    expect(document.body.textContent).toContain('meowsync')
    el.remove()
  })

  it('import.meta.env 经 Vite 管线可用', () => {
    expect(import.meta.env).toBeTypeOf('object')
    expect(import.meta.env.MODE).toBe('test')
  })

  it('Vue 响应式 + src/ 内纯函数可导入', async () => {
    const { formatTime } = await import('../../src/lib/format.js')
    const n = ref(0)
    const doubled = computed(() => n.value * 2)
    n.value = 21
    expect(doubled.value).toBe(42)
    expect(formatTime(65)).toBe('1:05')
  })

  it('@vue/test-utils 可挂载渲染组件', () => {
    const wrapper = mount({
      template: '<button class="b">hi</button>'
    })
    expect(wrapper.find('button.b').exists()).toBe(true)
    expect(wrapper.text()).toBe('hi')
  })
})

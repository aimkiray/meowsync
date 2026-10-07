// FullscreenPlayer F6 回归：dialog 语义 + 焦点进出闭环 + Tab 钳制（aria-modal
// 契约）+ Esc 与确认弹层互斥 + 滑杆 a11y/键盘/pointer 拖拽链（与
// BottomPlayer 同契约）+ 顶栏 aria-pressed + 画布 aria-hidden
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import FullscreenPlayer from '../../src/components/FullscreenPlayer.vue'
import { pixelConfirm, isConfirmOpen, resolveConfirm } from '../../src/lib/feedback.js'

const song = { id: 1, name: '测试曲', ar: [{ name: '艺人' }], al: { picUrl: '' } }

// TextAliveLyricCanvas 是视觉通道——桩成裸 div，断言 aria-hidden 落宿主根
const mountPlayer = (props = {}) => mount(FullscreenPlayer, {
  attachTo: document.body,
  props: {
    currentSong: song,
    isPlaying: true,
    currentTime: 50,
    duration: 200,
    volume: 80,
    lyrics: [],
    lyricMode: 'original',
    interactionMode: 'auto',
    ...props,
  },
  global: {
    stubs: {
      TextAliveLyricCanvas: { template: '<div class="canvas-stub" />' },
      PixelIcon: { template: '<i />' },
    },
  },
})

// jsdom 不产布局——getClientRects 恒空集会把可聚焦集滤光，Tab 钳制变死代码
// （review-fixes F2 同款桩）。本组件无 file input，一律回非空矩形即可
const realGetClientRects = Element.prototype.getClientRects
beforeEach(() => {
  Element.prototype.getClientRects = function () { return [{ width: 1 }] }
})

let wrapper = null
afterEach(() => {
  resolveConfirm(false) // 防用例中断残留 confirm 泄漏到下一只
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  document.body.style.overflow = ''
  Element.prototype.getClientRects = realGetClientRects
})

describe('FullscreenPlayer：dialog 语义与焦点闭环', () => {
  it('根是 aria-modal dialog：role/aria-modal/可访问名齐备', () => {
    wrapper = mountPlayer()
    const root = wrapper.element
    expect(root.getAttribute('role')).toBe('dialog')
    expect(root.getAttribute('aria-modal')).toBe('true')
    expect(root.getAttribute('aria-label')).toBe('全屏播放器')
    expect(root.getAttribute('tabindex')).toBe('-1') // 只收程序焦点不入 Tab 序
  })

  it('开层焦点收进根；关层归还到打开前的活动元素', async () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()
    expect(document.activeElement).toBe(trigger)

    wrapper = mountPlayer()
    await nextTick()
    await nextTick()
    expect(document.activeElement).toBe(wrapper.element) // 焦点已收进 dialog 根

    wrapper.unmount()
    wrapper = null
    expect(document.activeElement).toBe(trigger) // 归还触发键而非落 body
  })

  it('Escape 发 close', async () => {
    wrapper = mountPlayer()
    const evt = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    window.dispatchEvent(evt)
    await nextTick()
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('Tab 钳制：末项 Tab 回首项、首项 Shift+Tab 回末项、中段放行自然序', async () => {
    wrapper = mountPlayer()
    await nextTick()
    const root = wrapper.element
    const focusables = [...root.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), ' +
      'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    // 可聚焦集自证闭合：首=顶栏模式键、末=进度滑杆（DOM 序即 Tab 序）
    const first = focusables[0]
    const last = focusables.at(-1)
    expect(first.className).toContain('fullscreen-player__topbar-button')
    expect(last.getAttribute('role')).toBe('slider')

    last.focus()
    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    expect(document.activeElement).toBe(first) // 末项 Tab 不逃出遮罩，回绕首项

    first.focus()
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }))
    expect(document.activeElement).toBe(last)

    // 中段不消费——自然 Tab 序放行（jsdom 不走默认导航，只看未拦截不移焦）
    const mid = focusables[1]
    mid.focus()
    const pass = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    mid.dispatchEvent(pass)
    expect(pass.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(mid)
  })

  it('确认弹层叠在沉浸层上时 Esc 归确认框结算——本层不抢关、不一键双关', async () => {
    wrapper = mountPlayer()
    const p = pixelConfirm('确定删除？')
    expect(isConfirmOpen()).toBe(true)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(wrapper.emitted('close') ?? []).toHaveLength(0)
    resolveConfirm(false)
    await p
    // 弹层收掉后 Esc 恢复关层语义
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('body overflow 存旧还原：挂载压 hidden、卸载写回旧值而非清空', async () => {
    document.body.style.overflow = 'scroll'
    wrapper = mountPlayer()
    expect(document.body.style.overflow).toBe('hidden')
    wrapper.unmount()
    wrapper = null
    expect(document.body.style.overflow).toBe('scroll') // 裸写 '' 会冲掉上游值
  })
})

describe('FullscreenPlayer：进度滑杆（BottomPlayer 同契约）', () => {
  const sliderOf = () => wrapper.find('[role="slider"]')

  it('role=slider + aria 值域齐备：valuenow 按进度百分比折算', () => {
    wrapper = mountPlayer() // currentTime 50 / duration 200 → 25
    const s = sliderOf()
    expect(s.exists()).toBe(true)
    expect(s.attributes('aria-label')).toBe('播放进度')
    expect(s.attributes('aria-valuenow')).toBe('25')
    expect(s.attributes('aria-valuemin')).toBe('0')
    expect(s.attributes('aria-valuemax')).toBe('100')
    expect(s.attributes('aria-valuetext')).toBe('0:50 / 3:20')
    expect(s.attributes('tabindex')).toBe('0')
  })

  it('方向键 ±5s / Home / End 换算成归一化 seek-to', async () => {
    wrapper = mountPlayer()
    const s = sliderOf()
    await s.trigger('keydown', { key: 'ArrowRight' }) // 50+5=55 → 0.275
    await s.trigger('keydown', { key: 'ArrowLeft' })  // 50-5=45 → 0.225
    await s.trigger('keydown', { key: 'Home' })       // → 0
    await s.trigger('keydown', { key: 'End' })        // → 1
    const seeks = wrapper.emitted('seek-to')
    expect(seeks).toHaveLength(4)
    expect(seeks[0][0]).toBeCloseTo(0.275)
    expect(seeks[1][0]).toBeCloseTo(0.225)
    expect(seeks[2][0]).toBe(0)
    expect(seeks[3][0]).toBe(1)
  })

  it('pointer 拖拽链：down 定锚、move 跟手、up 发 up 点实况 seek-to', async () => {
    wrapper = mountPlayer()
    const s = sliderOf()
    // jsdom rect 全 0——钉 200px 宽便于折算比例
    s.element.getBoundingClientRect = () => ({
      left: 0, top: 0, right: 200, bottom: 24, width: 200, height: 24,
    })
    await s.trigger('pointerdown', { button: 0, pointerId: 7, clientX: 100 })
    await s.trigger('pointermove', { pointerId: 7, clientX: 40 })
    // 拖拽中 valuenow 跟拖拽位（20%）而非 props 播放位——UI 不被 currentTime 抢
    expect(s.attributes('aria-valuenow')).toBe('20')
    await s.trigger('pointerup', { pointerId: 7, clientX: 150 })
    const seeks = wrapper.emitted('seek-to')
    expect(seeks).toHaveLength(1)
    expect(seeks[0][0]).toBeCloseTo(0.75)
    // 松手后 valuenow 回跟 props
    expect(sliderOf().attributes('aria-valuenow')).toBe('25')
  })

  it('pointercancel 只收拖拽态不 emit——竖滑被浏览器接管不是 seek', async () => {
    wrapper = mountPlayer()
    const s = sliderOf()
    s.element.getBoundingClientRect = () => ({
      left: 0, top: 0, right: 200, bottom: 24, width: 200, height: 24,
    })
    await s.trigger('pointerdown', { button: 0, pointerId: 3, clientX: 100 })
    await s.trigger('pointercancel', { pointerId: 3 })
    expect(wrapper.emitted('seek-to') ?? []).toHaveLength(0)
  })

  it('多指隔离：第二指 pointerdown 不劫持进行中的拖拽', async () => {
    wrapper = mountPlayer()
    const s = sliderOf()
    s.element.getBoundingClientRect = () => ({
      left: 0, top: 0, right: 200, bottom: 24, width: 200, height: 24,
    })
    await s.trigger('pointerdown', { button: 0, pointerId: 1, clientX: 100 })
    await s.trigger('pointerdown', { button: 0, pointerId: 2, clientX: 190 }) // 第二指
    await s.trigger('pointermove', { pointerId: 2, clientX: 0 })            // 异指 move 无效
    await s.trigger('pointerup', { pointerId: 1, clientX: 50 })             // 原指 up 才结算
    const seeks = wrapper.emitted('seek-to')
    expect(seeks).toHaveLength(1)
    expect(seeks[0][0]).toBeCloseTo(0.25)
  })
})

describe('FullscreenPlayer：控件语义', () => {
  it('顶栏模式键 aria-pressed 随态翻转', async () => {
    wrapper = mountPlayer({ lyricMode: 'translation', interactionMode: 'pointer' })
    const [lyricBtn, modeBtn] = wrapper.findAll('.fullscreen-player__topbar-button')
    expect(lyricBtn.attributes('aria-pressed')).toBe('true')
    expect(modeBtn.attributes('aria-pressed')).toBe('true')

    await lyricBtn.trigger('click')
    await modeBtn.trigger('click')
    expect(wrapper.emitted('update:lyric-mode')[0]).toEqual(['original']) // translation→original
    expect(wrapper.emitted('update:interaction-mode')[0]).toEqual(['auto'])

    await wrapper.setProps({ lyricMode: 'original', interactionMode: 'auto' })
    expect(lyricBtn.attributes('aria-pressed')).toBe('false')
    expect(modeBtn.attributes('aria-pressed')).toBe('false')
  })

  it('TextAlive 画布宿主 aria-hidden——读屏词走 DOM 词列不吃画布噪音', () => {
    wrapper = mountPlayer()
    const canvas = wrapper.find('.canvas-stub')
    expect(canvas.exists()).toBe(true)
    expect(canvas.attributes('aria-hidden')).toBe('true')
  })
})

// TopNavigation 搜索源切换钮钉板（vitest+jsdom，真实挂载）：
//   钮位/aria — .topnav-search 内、字段之后；title/aria-label 报当前源名，
//               切 prefSearchSource 重挂即变名（computed 直读模块级 ref）
//   菜单      — 4 项 menuitemradio（SEARCH_SOURCES 全量）、当前项
//               aria-checked=true 且 check 槽有标、开即焦首项（⋯ 菜单同律）
//   切源      — pick 即写 prefSearchSource + LS 'meowsync-search-src' 落盘
//               + 菜单收 + 焦点归还切换钮（与 pickTheme 同解散语义）
//   互斥      — 菜单开着时输入框打字收菜单（输入意图优先，建议照常弹）；
//               建议开时开菜单收建议；与 ⋯ 菜单互开即关对侧不并存
//   外关      — pointerdown 菜单内豁免不收、菜单外收（⋯ 同一份豁免串）
//   Esc       — window 相位收菜单归还切换钮（⋯ 同一份 onMenuKeydown）
//   再点/↑↓  — 开着再点触发钮收菜单（toggleSrcMenu 早退分支）；
//               菜单 keydown 接 cycleMenuItems，↑↓ 焦点项间循环回绕
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'

const { musicApi } = vi.hoisted(() => ({
  musicApi: {
    // 「建议开着时开菜单」用例要真拉取——allMatch 一条即够 mapSuggestions 出项；
    // 其余用例不触异步路径，但模块顶层 import 链要立起来（topnav-yt 同款注）
    searchSuggest: vi.fn(async () => ({ allMatch: [{ keyword: 'lofi' }] })),
  },
}))
vi.mock('../../src/api/music.js', () => ({ musicApi }))
vi.mock('../../src/api/auth.js', () => ({ authApi: {} }))

const { default: TopNavigation } = await import('../../src/components/TopNavigation.vue')
const { prefSearchSource } = await import('../../src/lib/prefs.js')

// jsdom 无 matchMedia——TopNav 挂载期裸调（menu-focus 同款补丁）
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
}

let wrapper = null
const mountNav = async (searchQuery = '') => {
  wrapper = mount(TopNavigation, {
    attachTo: document.body,
    props: { remoteMode: 'off', searchQuery },
    global: { stubs: { GlitchText: true, PixelIcon: true } },
  })
  await nextTick()
  return wrapper
}

beforeEach(() => {
  prefSearchSource.value = 'netease'
  localStorage.clear()
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  // 菜单 teleport 到 body——不随 wrapper.element 一起被清，残留会串场
  document.body.innerHTML = ''
})

const srcMenu = () => document.querySelector('#topnav-src-menu')
const srcItems = () => [...document.querySelectorAll('#topnav-src-menu .pg-menu-item')]
const pointerdownOn = (el) =>
  el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
// window 相位监听（menu-focus 同款）：document 上派发照样冒到 window
const pressEsc = () =>
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
// ↑↓ 走菜单容器 keydown（@keydown="cycleMenuItems"）——menu-focus 同款直发菜单
const pressArrowOn = (el, key) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))

describe('TopNavigation：搜索源切换钮', () => {
  it('钮在 .topnav-search 内字段之后；title/aria 报当前源名，切源重挂变名', async () => {
    await mountNav()
    const btn = wrapper.find('.topnav-src-btn')
    expect(btn.exists()).toBe(true)
    // 钮在搜索容器内、紧跟输入字段之后
    expect(wrapper.find('.topnav-search').element.contains(btn.element)).toBe(true)
    expect(btn.element.previousElementSibling?.classList.contains('topnav-search-field')).toBe(true)
    expect(btn.attributes('title')).toBe('搜索源：网易云')
    expect(btn.attributes('aria-label')).toBe('搜索源：网易云')
    expect(btn.attributes('aria-haspopup')).toBe('menu')

    // 切源重挂——srcName 直读模块级 ref，名字跟着偏好变脸
    wrapper.unmount(); wrapper = null
    prefSearchSource.value = 'yt'
    await mountNav()
    expect(wrapper.find('.topnav-src-btn').attributes('title')).toBe('搜索源：YouTube')
  })

  it('点击开菜单：4 项 menuitemradio、当前项 aria-checked + check 标、开即焦首项', async () => {
    await mountNav()
    const btn = wrapper.find('.topnav-src-btn')
    await btn.trigger('click')
    await nextTick()

    expect(srcMenu()).toBeTruthy()
    expect(btn.attributes('aria-expanded')).toBe('true')
    const items = srcItems()
    expect(items.map(el => el.getAttribute('role'))).toEqual(
      ['menuitemradio', 'menuitemradio', 'menuitemradio', 'menuitemradio'])
    expect(items.map(el => el.textContent.trim()))
      .toEqual(['网易云', 'QQ 音乐', 'YouTube', 'Bilibili'])
    expect(items.map(el => el.getAttribute('aria-checked')))
      .toEqual(['true', 'false', 'false', 'false'])
    // check 标只渲染在选中项的槽里（PixelIcon stub 也占节点）
    expect(items.map(el => el.querySelector('.topnav-theme-check').children.length))
      .toEqual([1, 0, 0, 0])
    expect(document.activeElement).toBe(items[0]) // 开即焦首项——⋯ 菜单同律
  })

  it('点 QQ 音乐项 → pref=qq + LS 落盘 + 菜单收 + 焦点归还切换钮', async () => {
    await mountNav()
    const btn = wrapper.find('.topnav-src-btn')
    await btn.trigger('click')
    await nextTick()

    const qqItem = srcItems().find(el => el.textContent.includes('QQ 音乐'))
    qqItem.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()

    expect(prefSearchSource.value).toBe('qq')
    expect(localStorage.getItem('meowsync-search-src')).toBe('qq')
    expect(srcMenu()).toBeNull()
    expect(document.activeElement).toBe(btn.element) // 解散语义归还触发键
  })

  it('互斥：菜单开着时输入框打字 → 菜单收（输入意图优先，建议照常弹）', async () => {
    await mountNav()
    await wrapper.find('.topnav-src-btn').trigger('click')
    await nextTick()
    expect(srcMenu()).toBeTruthy()

    const input = wrapper.find('input')
    input.element.value = 'lofi'
    await input.trigger('input')
    await nextTick()
    expect(srcMenu()).toBeNull()

    // 建议不受源菜单牵连——250ms 防抖到点照弹（真时钟等，search-source 同律）
    await new Promise(r => setTimeout(r, 400))
    await nextTick()
    expect(wrapper.vm.suggestOpen).toBe(true)
  })

  it('互斥：建议下拉开着时开菜单 → 建议收（两浮层不叠）', async () => {
    await mountNav()
    const input = wrapper.find('input')
    input.element.value = 'lofi'
    await input.trigger('input')
    await new Promise(r => setTimeout(r, 400))
    await nextTick()
    expect(wrapper.vm.suggestOpen).toBe(true)

    await wrapper.find('.topnav-src-btn').trigger('click')
    await nextTick()
    expect(wrapper.vm.suggestOpen).toBe(false)
    expect(srcMenu()).toBeTruthy()
  })

  it('互斥：与 ⋯ 菜单不并存——互开即关对侧', async () => {
    await mountNav()
    await wrapper.find('.topnav-src-btn').trigger('click')
    await nextTick()
    expect(srcMenu()).toBeTruthy()

    await wrapper.find('.topnav-menu-btn').trigger('click')
    await nextTick()
    expect(srcMenu()).toBeNull()
    expect(document.querySelector('#topnav-menu')).toBeTruthy()

    await wrapper.find('.topnav-src-btn').trigger('click')
    await nextTick()
    expect(document.querySelector('#topnav-menu')).toBeNull()
    expect(srcMenu()).toBeTruthy()
  })

  it('pointerdown 外关：菜单内落点豁免不收、菜单外落点收', async () => {
    await mountNav()
    await wrapper.find('.topnav-src-btn').trigger('click')
    await nextTick()

    pointerdownOn(srcItems()[0])
    await nextTick()
    expect(srcMenu()).toBeTruthy() // 菜单内落点在豁免串——不收

    pointerdownOn(document.body)
    await nextTick()
    expect(srcMenu()).toBeNull()
  })

  it('Esc 收菜单归还切换钮（window 相位，⋯ 同一份 onMenuKeydown）', async () => {
    await mountNav()
    const btn = wrapper.find('.topnav-src-btn')
    await btn.trigger('click')
    await nextTick()
    expect(document.activeElement).toBe(srcItems()[0])

    pressEsc()
    await nextTick()
    expect(srcMenu()).toBeNull()
    expect(document.activeElement).toBe(btn.element)
  })

  it('开着再点触发钮收菜单（aria-expanded 回落）；↑↓ 焦点项间循环回绕', async () => {
    await mountNav()
    const btn = wrapper.find('.topnav-src-btn')
    await btn.trigger('click')
    await nextTick()
    const items = srcItems()
    expect(document.activeElement).toBe(items[0])

    // 菜单容器 keydown 接 cycleMenuItems——↓ 次项、↑ 回、首项再 ↑ 回绕末项
    pressArrowOn(srcMenu(), 'ArrowDown')
    expect(document.activeElement).toBe(items[1])
    pressArrowOn(srcMenu(), 'ArrowUp')
    expect(document.activeElement).toBe(items[0])
    pressArrowOn(srcMenu(), 'ArrowUp')
    expect(document.activeElement).toBe(items[items.length - 1])

    // 再点 = toggleSrcMenu「开着即收」早退分支——缺它会重走开路径闪收闪开
    await btn.trigger('click')
    await nextTick()
    expect(srcMenu()).toBeNull()
    expect(btn.attributes('aria-expanded')).toBe('false')
  })
})

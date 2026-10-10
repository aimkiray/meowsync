// GlitchText 分词回归钉板：
//   - 连续空白累加进前 token 的 gap（"a  b" 不塌缩成 "a b"——曾覆盖赋值只留末段）
//   - 行首空白以 gap-only token（chars:[] + gap）保留（曾在 out 为空时整丢）
//   - CJK 逐字独立 token 的既有行为
// 断言走 element.textContent 原值——text() 便捷方法会压/trim 空白，不适用
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import GlitchText from '../../src/components/GlitchText.vue'
import { setTheme, glitchBurst } from '../../src/lib/theme.js'
import { prefGlitchMotion } from '../../src/lib/prefs.js'
import { LS_KEYS } from '../../src/lib/storage.js'

// jsdom 无 matchMedia——组件挂载期裸调（menu-focus/queue-virtual-sec 同款）。
// 可配形：mqReduce 变量供 matches（挂载前摆设系统减动态），change 监听落
// mqChange 供用例手动派发「系统解除/恢复 reduce」事件
let mqReduce = false
let mqChange = null
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = () => ({
    get matches() { return mqReduce },
    addEventListener: (_type, fn) => { mqChange = fn },
    removeEventListener: (_type, fn) => { if (mqChange === fn) mqChange = null },
  })
}

// aria-hidden 视觉层——glitch-sr 是屏幕阅读器正本（恒定干净文本），不在断言面
const visualText = w => w.find('span[aria-hidden]').element.textContent
const hasMotionAttr = () =>
  document.documentElement.hasAttribute('data-glitch-motion')

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

// 减动豁免：prefGlitchMotion（'1' 强制开 / 其余跟随系统）应同时放行 JS 侧
// 腐蚀生成（active 判据）与 DOM 侧豁免锚（<html>[data-glitch-motion]——
// style.css 两条 .char-glitch reduce 规则的 :not() 锚点）
describe('GlitchText 减动豁免', () => {
  beforeEach(() => setTheme('glitch-restoration'))
  afterEach(async () => {
    mqReduce = false
    mqChange = null
    prefGlitchMotion.value = false
    // watcher 是 pre-flush：先等它结清（落 LS '0' + 摘属性）再清 LS——
    // 先 removeItem 会被迟到的 watcher 写回 '0' 把键复活
    await nextTick()
    localStorage.removeItem(LS_KEYS.GLITCH_MOTION)
    setTheme('default')
    document.documentElement.removeAttribute('data-glitch-motion')
  })

  it('基线：reduce 命中 + 跟随系统 → active=false 不产腐蚀', () => {
    mqReduce = true
    const w = mount(GlitchText, { props: { text: '蚀刻' } })
    expect(w.vm.active).toBe(false)
    expect(w.findAll('.char-glitch')).toHaveLength(0)
    expect(hasMotionAttr()).toBe(false)
    w.unmount()
  })

  it('reduce 命中 + 强制开启 → active=true 且 <html> 挂豁免属性', async () => {
    mqReduce = true
    prefGlitchMotion.value = true
    await nextTick() // watcher 落盘 + 挂属性走 pre-flush——结清再断言
    const w = mount(GlitchText, { props: { text: '蚀刻' } })
    expect(w.vm.active).toBe(true)
    expect(hasMotionAttr()).toBe(true)
    w.unmount() // active=true 起了 interval——收掉
  })

  it('运行中切档：active 即时双向翻，豁免属性随 watcher 生灭', async () => {
    mqReduce = true
    const w = mount(GlitchText, { props: { text: '蚀刻' } })
    expect(w.vm.active).toBe(false) // 跟随系统 reduce——基线态

    prefGlitchMotion.value = true
    expect(w.vm.active).toBe(true) // computed 即时放行——不等 watcher/tick
    await nextTick()
    expect(hasMotionAttr()).toBe(true)

    prefGlitchMotion.value = false
    expect(w.vm.active).toBe(false) // 切回跟随——立即收回
    await nextTick()
    expect(hasMotionAttr()).toBe(false)
    w.unmount()
  })

  it('LS 落盘裸串：强制开启写 "1"、切回跟随写 "0"（非 JSON 串）', async () => {
    prefGlitchMotion.value = true
    await nextTick()
    expect(localStorage.getItem(LS_KEYS.GLITCH_MOTION)).toBe('1')
    prefGlitchMotion.value = false
    await nextTick()
    expect(localStorage.getItem(LS_KEYS.GLITCH_MOTION)).toBe('0')
  })

  it('mqChange 派发：follow 态下系统解除 reduce → active 放行（mq 监听接线未丢）', async () => {
    mqReduce = true
    const w = mount(GlitchText, { props: { text: '蚀刻' } })
    expect(w.vm.active).toBe(false)
    expect(typeof mqChange).toBe('function') // 挂载即登记 change 监听

    mqReduce = false
    mqChange({ matches: false }) // 系统解除减动
    expect(w.vm.active).toBe(true)
    await nextTick() // active 翻 true 后 watcher 起 interval——放行路跑通再收

    mqReduce = true
    mqChange({ matches: true }) // 系统恢复减动——收回
    expect(w.vm.active).toBe(false)
    w.unmount()
  })

  it('非 reduce + 强制开启 → 与系统无关时豁免无差别（active 照常 true）', async () => {
    mqReduce = false
    prefGlitchMotion.value = true
    await nextTick()
    const w = mount(GlitchText, { props: { text: '蚀刻' } })
    expect(w.vm.active).toBe(true)
    w.unmount()
  })

  it("LS='1' 存量：prefs 模块求值期读——新模块实例 ref=true 且属性即挂", async () => {
    localStorage.setItem(LS_KEYS.GLITCH_MOTION, '1')
    vi.resetModules()
    const { prefGlitchMotion: fresh } = await import('../../src/lib/prefs.js')
    expect(fresh.value).toBe(true)
    expect(hasMotionAttr()).toBe(true)
  })
})

// 替身符按源字符脚本分流：Han 表意文字→HAN_POOL（经典乱码签名池），
// 其余（拉丁/假名/谚文等）→共享 POOL。Math.random 恒 0 取池首元——
// '烫'/'▓' 分别是两池首元的字面量钉板（HAN_POOL/POOL 未导出，钉首元即
// 钉路由；首元若改需同步改断言）
describe('GlitchText 腐蚀分流', () => {
  beforeEach(() => setTheme('glitch-restoration'))
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    setTheme('default')
  })

  it('burst 全 scramble：汉字键→HAN_POOL 首元、拉丁键→POOL 首元', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    // '漢a'：漢=CJK 独立 token（0:0），a=Latin token（1:0）
    const w = mount(GlitchText, { props: { text: '漢a' } })
    glitchBurst() // 共享世代 +1 → watch(glitchGen) 触发全字符 scramble
    await nextTick() // watch flush:pre——世代变更落地为 corrupt 写入
    expect(w.vm.corrupt.get('0:0')).toBe('烫') // '漢' → HAN_POOL[0]
    expect(w.vm.corrupt.get('1:0')).toBe('▓') // 'a' → POOL[0]
    w.unmount() // active=true 起了 interval + burst 回净表——收掉
  })

  it('astral 汉字路由进 HAN_POOL——判据 astral 段（20000–2FA1F）钉板', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    // '𠮷a'：𠮷=U+20BB7（Ext B）——tokenizer 的 CJK astral 段命中
    // 产单字 token（0:0），a=Latin token（1:0）
    const w = mount(GlitchText, { props: { text: '𠮷a' } })
    glitchBurst()
    await nextTick()
    expect(w.vm.corrupt.get('0:0')).toBe('烫') // '𠮷' → HAN astral 段 → HAN_POOL[0]
    expect(w.vm.corrupt.get('1:0')).toBe('▓') // 'a' → POOL[0]
    w.unmount() // active=true 起了 interval + burst 回净表——收掉
  })

  it('tick 主路径同走分流（interval 驱动）', () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const w = mount(GlitchText, { props: { text: '漢a' } })
    vi.advanceTimersByTime(1100) // 首个 tick——随机=0 命中 clean[0]='漢'
    expect(w.vm.corrupt.get('0:0')).toBe('烫')
    expect(w.vm.corrupt.size).toBe(1) // 封顶 ceil(2/6)=1——只腐蚀一键
    w.unmount()
  })
})

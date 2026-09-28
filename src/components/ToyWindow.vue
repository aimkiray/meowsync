<template>
  <!-- 窗口玩具：墨条标题 + 纸面体。可拖拽（松手回弹），键盘方向键可移。
       装饰件不承载内容——印刷稿上掉落的小玩具 -->
  <div
    class="toy-window"
    :style="{ ...(x ? { left: x } : {}), ...(y ? { top: y } : {}), '--r': rotate }"
    tabindex="0"
    role="img"
    :aria-label="`${title} 装饰窗口，可拖拽`"
    @pointerdown="onDown"
    @keydown="onKey"
  >
    <span v-if="num" class="toy-window__num" aria-hidden="true">{{ num }}</span>
    <div class="toy-window__title">{{ title }}</div>
    <div class="toy-window__body">
      <p v-for="(line, i) in lines" :key="i" class="toy-window__sub">{{ line }}</p>
      <span v-if="tag" class="toy-window__tag" aria-hidden="true">{{ tag }}</span>
    </div>
  </div>
</template>

<script>
export default {
  name: 'ToyWindow',
  props: {
    title: { type: String, default: 'MEOWSYNC' },
    lines: { type: Array, default: () => ['netease music player'] },
    tag: { type: String, default: '<meow approved>' },
    num: { type: String, default: '' },
    // x/y 空串时不写行内 left/top——交给外层 scoped 定位（top/right 自由组合）
    x: { type: String, default: '' },
    y: { type: String, default: '' },
    rotate: { type: String, default: '0deg' }
  },
  setup() {
    // 拖拽：translate 驱动（不改 left/top），松手回弹原位
    const onDown = (e) => {
      const w = e.currentTarget
      if (e.button !== undefined && e.button !== 0) return
      w.setPointerCapture?.(e.pointerId)
      const sx = e.clientX, sy = e.clientY
      const pid = e.pointerId
      const move = (ev) => {
        if (ev.pointerId !== pid) return
        w.style.translate = `${ev.clientX - sx}px ${ev.clientY - sy}px`
      }
      const up = () => {
        w.removeEventListener('pointermove', move)
        w.removeEventListener('pointercancel', up)
        w.removeEventListener('lostpointercapture', up)
        if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
          w.style.transition = 'translate .4s cubic-bezier(.5,0,.88,.77)'
        }
        w.style.translate = '0px 0px'
        setTimeout(() => { w.style.transition = '' }, 400)
      }
      w.addEventListener('pointermove', move)
      w.addEventListener('pointerup', up, { once: true })
      w.addEventListener('pointercancel', up, { once: true })
      w.addEventListener('lostpointercapture', up, { once: true })
    }

    // 键盘等价：方向键挪 8px，Enter 归位
    const onKey = (e) => {
      const w = e.currentTarget
      const cur = (w.style.translate || '0px 0px').split(' ').map(v => parseFloat(v) || 0)
      const step = 8
      if (e.key === 'ArrowLeft') cur[0] -= step
      else if (e.key === 'ArrowRight') cur[0] += step
      else if (e.key === 'ArrowUp') cur[1] -= step
      else if (e.key === 'ArrowDown') cur[1] += step
      else if (e.key === 'Enter') { w.style.translate = '0px 0px'; return }
      else return
      e.preventDefault()
      w.style.translate = `${cur[0]}px ${cur[1]}px`
    }

    return { onDown, onKey }
  }
}
</script>

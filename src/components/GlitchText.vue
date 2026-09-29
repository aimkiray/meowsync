<template>
  <!-- 字符腐蚀签名件（glitch-restoration 主题）：DOM 文本保持原文，
       替身符走 data-glitch 伪元素——屏幕阅读器读到的是干净文本。
       仅 glitch 主题激活且非 reduced-motion 时 tick；其余状态静态透传 -->
  <span class="glitch-text" :data-glitched="gen || undefined">
    <span
      v-for="(ch, i) in chars"
      :key="i"
      class="corruptible"
      :class="{ 'char-glitch': corrupt.has(i) }"
      :data-glitch="corrupt.get(i)"
    >{{ ch }}</span>
  </span>
</template>

<script>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { currentTheme } from '../lib/theme.js'

// mojibake 字形池：半角片假名/西里尔/希腊/制表符/数字——形近真字，
// 替换读起来是「腐蚀」而非乱码（取自 glitch-restoration-ui skill）
const POOL = [...'▓░▒ﾂﾎﾃﾄﾅﾌﾑﾒﾓﾘﾚﾖﾊﾋﾍﾐﾕﾗﾆﾇ℮†‡ΓŘ®₥§¤¥šмλθτþÐÑØÅЯИƧγÿýξ∑∆ⅯﾉﾙΞë|+×01345!$']

export default {
  name: 'GlitchText',
  props: { text: { type: String, required: true } },
  setup(props) {
    const chars = computed(() => [...props.text])
    const corrupt = ref(new Map()) // charIndex → 替身字形
    const gen = ref(0)             // 世代计数：每次 tick +1，归 0 即移除属性
    const reduced = ref(false)

    const active = computed(() =>
      currentTheme.value === 'glitch-restoration' && !reduced.value
    )

    let timer = 0
    function tick() {
      // 先快照再腐蚀——新腐蚀的字符不得成为本代恢复候选
      // （skill 原版即此序：glitched 在 add 之前取样）
      const glitched = [...corrupt.value.keys()]
      const clean = []
      chars.value.forEach((ch, i) => { if (ch !== ' ' && !corrupt.value.has(i)) clean.push(i) })
      if (clean.length) {
        const i = clean[Math.random() * clean.length | 0]
        corrupt.value.set(i, POOL[Math.random() * POOL.length | 0])
      }
      // 每代随机恢复 2-3 个存量——稳态来回腐蚀而非单向累积
      glitched.slice(0, 2 + (Math.random() * 2 | 0)).forEach(k => corrupt.value.delete(k))
      gen.value++
    }
    function stop() {
      clearInterval(timer)
      timer = 0
      corrupt.value.clear()
      gen.value = 0
    }

    watch(active, on => {
      if (on) { stop(); timer = setInterval(tick, 1100) }
      else stop()
    }, { immediate: true })
    watch(() => props.text, () => { corrupt.value.clear() })

    let mq
    const onMq = e => { reduced.value = e.matches }
    onMounted(() => {
      mq = matchMedia('(prefers-reduced-motion: reduce)')
      reduced.value = mq.matches
      mq.addEventListener('change', onMq)
    })
    onBeforeUnmount(() => { stop(); mq?.removeEventListener('change', onMq) })

    return { chars, corrupt, gen }
  }
}
</script>

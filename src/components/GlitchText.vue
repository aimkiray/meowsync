<template>
  <!-- 字符腐蚀签名件（glitch-restoration 主题）：DOM 文本保持原文，
       替身符走 data-glitch 伪元素——屏幕阅读器读到的是干净文本。
       仅 glitch 主题激活且非 reduced-motion 时 tick；其余状态静态透传。
       data-glitched 读共享计数（theme.js glitchGen）——错误事件触发
       burst 时全屏所有实例同代同闪，规范语义是共享叙事计数 -->
  <span class="glitch-text" :data-glitched="active && glitchGen ? String(glitchGen) : undefined">
    <template v-for="(word, wi) in words" :key="wi"><span class="glitch-word"><span
      v-for="(ch, ci) in word.chars"
      :key="ci"
      class="corruptible"
      :class="{ 'char-glitch': corrupt.has(keyOf(wi, ci)) }"
      :data-glitch="corrupt.get(keyOf(wi, ci))"
    >{{ ch }}</span></span>{{ ' ' }}</template>
  </span>
</template>

<script>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { currentTheme, glitchGen } from '../lib/theme.js'

// mojibake 字形池：半角片假名/西里尔/希腊/制表符/数字——形近真字，
// 替换读起来是「腐蚀」而非乱码（取自 glitch-restoration-ui skill；
// 縺繝€ 三连保留——Fusion Pixel 有 CJK 字形覆盖）
const POOL = [...'▓░▒ﾂﾎﾃﾄﾅﾌﾑﾒﾓﾘﾚﾖﾊﾋﾍﾐﾕﾗﾆﾇ℮†‡ΓŘ®₥§¤¥šмλθτþÐÑØÅЯИƧγÿýξ∑縺繝€∆ⅯﾉﾙΞë|+×01345!$']

export default {
  name: 'GlitchText',
  props: { text: { type: String, required: true } },
  setup(props) {
    // 按词分组包 .glitch-word（nowrap 保证词组不断行拆散）——规范 recipe 形态
    const words = computed(() => props.text.split(' ').map(w => ({ chars: [...w] })))
    const keyOf = (wi, ci) => wi * 256 + ci
    const corrupt = ref(new Map()) // keyOf(wi,ci) → 替身字形
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
      words.value.forEach((word, wi) =>
        word.chars.forEach((_, ci) => { if (!corrupt.value.has(keyOf(wi, ci))) clean.push(keyOf(wi, ci)) })
      )
      if (clean.length) {
        const i = clean[Math.random() * clean.length | 0]
        corrupt.value.set(i, POOL[Math.random() * POOL.length | 0])
      }
      // 每代随机恢复 2-3 个存量——稳态来回腐蚀而非单向累积
      glitched.slice(0, 2 + (Math.random() * 2 | 0)).forEach(k => corrupt.value.delete(k))
    }
    // burst：全 scramble 一瞬（错误张力）；re-wrap 源文本天然回净由 tick 完成
    function burst() {
      words.value.forEach((word, wi) =>
        word.chars.forEach((_, ci) =>
          corrupt.value.set(keyOf(wi, ci), POOL[Math.random() * POOL.length | 0])
        )
      )
    }
    function stop() {
      clearInterval(timer)
      timer = 0
      corrupt.value.clear()
    }

    watch(active, on => {
      if (on) { stop(); timer = setInterval(tick, 1100) }
      else stop()
    }, { immediate: true })
    watch(() => props.text, () => { corrupt.value.clear() })
    // 共享世代爬升 → 全屏所有实例同代 burst（主题外激活也无副作用，
    // 但仍在 active 下才做 DOM 写入）
    watch(glitchGen, (n, o) => { if (n > o && active.value) burst() })

    let mq
    const onMq = e => { reduced.value = e.matches }
    onMounted(() => {
      mq = matchMedia('(prefers-reduced-motion: reduce)')
      reduced.value = mq.matches
      mq.addEventListener('change', onMq)
    })
    onBeforeUnmount(() => { stop(); mq?.removeEventListener('change', onMq) })

    return { words, corrupt, glitchGen, keyOf, active }
  }
}
</script>

<template>
  <!-- 字符腐蚀签名件（glitch-restoration 主题）：DOM 文本保持原文，
       替身符走 data-glitch 伪元素——屏幕阅读器读到的是干净文本。
       仅 glitch 主题激活且非 reduced-motion 时 tick；其余状态静态透传。
       data-glitched 读共享计数（theme.js glitchGen）——错误事件触发
       burst 时全屏所有实例同代同闪，规范语义是共享叙事计数 -->
  <span class="glitch-text" :data-glitched="active && glitchGen ? String(glitchGen) : undefined">
    <!-- 屏幕阅读器正本：visibility:hidden 的腐蚀字符会整段出 a11y 树，
         且 ::after 替身符可能被朗读——视觉层整体 aria-hidden，SR 恒读本行 -->
    <span class="glitch-sr">{{ text }}</span><span aria-hidden="true"><template
      v-for="(word, wi) in words" :key="wi"><span class="glitch-word"><span
        v-for="(ch, ci) in word.chars"
        :key="ci"
        class="corruptible"
        :class="{ 'char-glitch': corrupt.has(keyOf(wi, ci)) }"
        :data-glitch="corrupt.get(keyOf(wi, ci))"
      >{{ ch }}</span></span>{{ word.gap || '' }}</template></span>
  </span>
</template>

<script>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { currentTheme, glitchGen } from '../lib/theme.js'

// mojibake 字形池：半角片假名/西里尔/希腊/shade 方块(▓░▒)/数字——形近真字，
// 替换读起来是「腐蚀」而非乱码（取自 glitch-restoration-ui skill）。
// 注意：多数替身符在 Fusion Pixel 的 unicode-range 外，会回落
// Noto Sans SC 非像素字形——质感更杂，对「损坏」语义反而是加分
const POOL = [...'▓░▒ﾂﾎﾃﾄﾅﾌﾑﾒﾓﾘﾚﾖﾊﾋﾍﾐﾕﾗﾆﾇ℮†‡ΓŘ®₥§¤¥šмλθτþÐÑØÅЯИƧγÿýξ∑縺繝€∆ⅯﾉﾙΞë|+×01345!$']

export default {
  name: 'GlitchText',
  props: { text: { type: String, required: true } },
  setup(props) {
    // 按「断行单元」分词：字素簇粒度（Intl.Segmenter——ZWJ emoji/肤色修饰/
    // 组合符保持整簇，腐蚀不落半字符）；CJK 系（汉字/假名/谚文/注音/增补
    // 平面）逐字独立 token 可字间断行，长东亚标题不被 nowrap 顶住溢出；
    // 空白符（含全角空格）不入腐蚀池：累加进前 token 的 gap 原样渲染；
    // 行首无前 token 时落成 chars 为空的 gap-only token——渲染空
    // .glitch-word + gap 文本保空白，空 chars 不产生 corruptible 键
    const CJK = /[\u2E80-\u2FDF\u3005-\u303B\u3040-\u30FF\u31A0-\u31BF\u31C0-\u31EF\u31F0-\u31FF\u3100-\u312F\u3130-\u318F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF\u1100-\u11FF\uFF66-\uFF9F\uFF01-\uFF65\uFFE0-\uFFE6]|[\u{20000}-\u{2FA1F}]/u
    const grapheme = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    const words = computed(() => {
      const out = []
      let buf = [] // 连续非 CJK 字素簇 → 一个 Latin 词 token（nowrap 保词形）
      const flush = () => { if (buf.length) { out.push({ chars: buf, gap: null }); buf = [] } }
      for (const { segment } of grapheme.segment(props.text)) {
        if (/^\s$/u.test(segment)) {
          flush()
          if (out.length) out[out.length - 1].gap = (out[out.length - 1].gap || '') + segment
          else out.push({ chars: [], gap: segment }) // 行首空白：gap-only token
        } else if (CJK.test(segment)) {
          flush()
          out.push({ chars: [segment], gap: null })
        } else {
          buf.push(segment)
        }
      }
      flush()
      return out
    })
    const keyOf = (wi, ci) => `${wi}:${ci}` // 字符串 key——杜绝长词串位碰撞
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
      let total = 0
      words.value.forEach((word, wi) =>
        word.chars.forEach((_, ci) => { total++; if (!corrupt.value.has(keyOf(wi, ci))) clean.push(keyOf(wi, ci)) })
      )
      // 短文本并发腐蚀封顶 ~1/6（至少 1 个）——4 字标题不会近半句皆替身
      if (clean.length && corrupt.value.size < Math.max(1, Math.ceil(total / 6))) {
        const i = clean[Math.random() * clean.length | 0]
        corrupt.value.set(i, POOL[Math.random() * POOL.length | 0])
      }
      // 每代随机恢复 2-3 个存量——稳态来回腐蚀而非单向累积
      glitched.slice(0, 2 + (Math.random() * 2 | 0)).forEach(k => corrupt.value.delete(k))
    }
    // burst：全 scramble 闪回（错误张力峰值）——规范是同帧 scramble→复原，
    // 我们持留 ~480ms 肉眼可辨再整批回净，DOM 文本始终干净（比规范
    // textContent 改写更守 a11y）。错误连发时重定时，闪回不打叠
    let burstTimer = 0
    function burst() {
      words.value.forEach((word, wi) =>
        word.chars.forEach((_, ci) =>
          corrupt.value.set(keyOf(wi, ci), POOL[Math.random() * POOL.length | 0])
        )
      )
      clearTimeout(burstTimer)
      burstTimer = setTimeout(() => { corrupt.value.clear() }, 480)
    }
    function stop() {
      clearInterval(timer)
      clearTimeout(burstTimer)
      timer = 0
      corrupt.value.clear()
    }

    watch(active, on => {
      if (on) { stop(); timer = setInterval(tick, 1100) }
      else stop()
    }, { immediate: true })
    // text 变更连 burst 回净表一起清——否则旧 timer 会误抹新文本的 tick 腐蚀
    watch(() => props.text, () => { clearTimeout(burstTimer); corrupt.value.clear() })
    // 共享世代爬升 → 全屏所有实例同代 burst（主题外激活也无副作用，
    // 但仍在 active 下才做 DOM 写入）
    watch(glitchGen, (n, o) => { if (n > o && active.value) burst() })
    // 注意：若宿主视图未来改用 keep-alive/v-show，active 只看主题不看
    // 可见性——隐藏期间 interval 照跑，届时需补 onDeactivated 停表

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

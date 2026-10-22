<template>
  <!-- 字符腐蚀签名件（glitch-restoration 主题）：DOM 文本保持原文，
       替身符走 data-glitch 伪元素——屏幕阅读器读到的是干净文本。
       仅 glitch 主题激活且（非 reduced-motion 或用户强制豁免）时走脉冲
       腐蚀：3.8–5s 静默 → 腐蚀 1–2 字 → 200ms 复原（文字 ~95% 时间干净）；
       ambient=false 的降噪区实例常驻零定时器、仅响应共享 burst。
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
import { prefGlitchMotion } from '../lib/prefs.js'

// mojibake 字形池：半角片假名/西里尔/希腊/shade 方块(▓░▒)/数字——形近真字，
// 替换读起来是「腐蚀」而非乱码（取自 glitch-restoration-ui skill）。
// 注意：多数替身符在 Fusion Pixel 的 unicode-range 外，会回落
// Noto Sans SC 非像素字形——质感更杂，对「损坏」语义反而是加分
const POOL = [...'▓░▒ﾂﾎﾃﾄﾅﾌﾑﾒﾓﾘﾚﾖﾊﾋﾍﾐﾕﾗﾆﾇ℮†‡ΓŘ®₥§¤¥šмλθτþÐÑØÅЯИƧγÿýξ∑縺繝€∆ⅯﾉﾙΞë|+×01345!$']

// 汉字专用几何/半角符池：块面符 █▓░▒▉▊▋▌ 作腐蚀主笔（观感是
// 「字形被雪花块遮蔽」而非编码事故），几何形 ◆◇■□▲△●○◢◣◤◥▚▞
// 与半角记号 ｱｲｳ 补杂讯——原乱码汉字残片签名整池退役。
// 首元 '█' 是 spec 钉板（tests/ui/glitch-text.spec.mjs 断言路由）。
// 重复项即权重，块面符刻意压过几何形。
// 仅 Han 表意文字走此池（「中文」窄口径：假名/谚文
// 仍走共享池，混排文本乱得更杂）
const HAN_POOL = [...'████▓▓▓░░▒▒▉▊▋▌▚▞◆◇■□▲△●○◢◣◤◥ｱｲｳ']
// Han 窄判据：表意文字三区+扩展 A+兼容区——不含假名/谚文/全角标点；
// astral 段（U+20000–U+2FA1F）实覆盖扩展 B–F/I 及兼容增补区
// （tokenizer 的 CJK 是分行类判据，口径比本判据宽，各司其职不复用）
const HAN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]|[\u{20000}-\u{2FA1F}]/u

// 替身符按源脚本分流：Han→几何/半角符池，其余→共享池
const pickFor = (ch) => {
  const pool = HAN.test(ch) ? HAN_POOL : POOL
  return pool[Math.random() * pool.length | 0]
}

export default {
  name: 'GlitchText',
  props: {
    text: { type: String, required: true },
    // ambient=false → 降噪区实例（页脚戳等装饰位）：常驻零定时器，
    // 仅共享 glitchGen burst 仍响应；缺省 true 走脉冲腐蚀
    ambient: { type: Boolean, default: true }
  },
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
    const mqMatches = ref(false) // 系统 reduce 闸镜像（matchMedia 挂载期接线）
    // 用户「强制开启」无视系统 reduce——设备级豁免位（prefs.js 同步写
    // <html>[data-glitch-motion]，CSS 侧豁免锚同生同灭）
    const reduced = computed(() => mqMatches.value && !prefGlitchMotion.value)

    const active = computed(() =>
      currentTheme.value === 'glitch-restoration' && !reduced.value
    )
    // pulsing = active ∩ ambient：active 过主题/减动闸，ambient 把
    // 降噪区实例排除在常驻脉冲外（burst 响应不看 ambient）
    const pulsing = computed(() => active.value && props.ambient)

    // 脉冲状态机：长静默（3800 + random*1200ms）→ 瞬发腐蚀 1–2 字 →
    // 200ms 后复原——文字 ~95% 时间干净（4–5s 静默对 200ms 显影）。
    // 原常驻 setInterval(tick,1100) 退役：噪声节奏换成脉冲节拍
    let pulseTimer = 0    // 静默期计时
    let restoreTimer = 0  // 显影期计时
    function schedulePulse() {
      clearTimeout(pulseTimer) // 防御重入：watch 连发/burst 落定接力不叠静默表
      pulseTimer = setTimeout(pulse, 3800 + Math.random() * 1200)
    }
    function pulse() {
      // 净字集取样靶位（splice 去重——同键不重复腐蚀）。spec §4.5 门控：
      // 净字 >6 才摇 1–2 个，≤6 恒蚀 1——短文本（2 字标题等）不再整段蚀空
      const clean = []
      words.value.forEach((word, wi) =>
        word.chars.forEach((ch, ci) => { if (!corrupt.value.has(keyOf(wi, ci))) clean.push({ k: keyOf(wi, ci), ch }) })
      )
      const count = clean.length > 6 ? 1 + (Math.random() * 2 | 0) : 1
      const hits = []
      for (let n = Math.min(clean.length, count); n > 0; n--) {
        const { k, ch } = clean.splice(Math.random() * clean.length | 0, 1)[0]
        corrupt.value.set(k, pickFor(ch))
        hits.push(k)
      }
      // 空文本早退：无靶可蚀不续排静默 timer——text 回填时
      // watch(props.text) 会重排，脉冲链不在空转中烧定时器
      if (!hits.length) return
      restoreTimer = setTimeout(() => {
        // 只撤本脉冲写入的键——与 burst 交叠时不误抹 scramble 全景
        hits.forEach(k => corrupt.value.delete(k))
        if (pulsing.value) schedulePulse() // 复原后接力下一静默周期
      }, 200)
    }
    // burst：全 scramble 闪回（错误张力峰值）——规范是同帧 scramble→复原，
    // 我们持留 ~480ms 肉眼可辨再整批回净，DOM 文本始终干净（比规范
    // textContent 改写更守 a11y）。错误连发时重定时，闪回不打叠
    let burstTimer = 0
    function burst() {
      // 先掐脉冲时钟防串扰：显影中的复原表一并作废——脉冲键并入
      // 全 scramble，由 burstTimer 统一回净
      clearTimeout(pulseTimer)
      clearTimeout(restoreTimer)
      words.value.forEach((word, wi) =>
        word.chars.forEach((ch, ci) =>
          corrupt.value.set(keyOf(wi, ci), pickFor(ch))
        )
      )
      clearTimeout(burstTimer)
      burstTimer = setTimeout(() => {
        corrupt.value.clear()
        if (pulsing.value) schedulePulse() // 落定后接力下一静默周期
      }, 480)
    }
    function stop() {
      clearTimeout(pulseTimer)
      clearTimeout(restoreTimer)
      clearTimeout(burstTimer)
      pulseTimer = restoreTimer = burstTimer = 0
      corrupt.value.clear()
    }

    // 任一闸门翻动都先全停再按 pulsing 重排——主题/减动切走即净，
    // ambient 切换也不残留显影表
    watch([active, pulsing], () => {
      stop()
      if (pulsing.value) schedulePulse()
    }, { immediate: true })
    // text 变更整表重置——否则旧脉冲/回净表会误抹或误蚀新文本
    watch(() => props.text, () => { stop(); if (pulsing.value) schedulePulse() })
    // 共享世代爬升 → 全屏所有实例同代 burst（主题外激活也无副作用，
    // 但仍在 active 下才做 DOM 写入）
    watch(glitchGen, (n, o) => { if (n > o && active.value) burst() })
    // 注意：若宿主视图未来改用 keep-alive/v-show，active 只看主题不看
    // 可见性——隐藏期间脉冲表照跑，届时需补 onDeactivated 停表

    let mq
    const onMq = e => { mqMatches.value = e.matches }
    onMounted(() => {
      mq = matchMedia('(prefers-reduced-motion: reduce)')
      mqMatches.value = mq.matches
      mq.addEventListener('change', onMq)
    })
    onBeforeUnmount(() => { stop(); mq?.removeEventListener('change', onMq) })

    return { words, corrupt, glitchGen, keyOf, active, pulsing }
  }
}
</script>

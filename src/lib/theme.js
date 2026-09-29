/**
 * 主题注册表与持久化——data-theme 的两个写点之一
 * （另一处是 index.html 内联脚本，负责首帧前恢复；两处的
 *   STORAGE_KEY/LEGACY_KEY 键名必须保持同步）。
 *
 * 新增主题只需四步：
 *   1. 在 THEMES 注册 { id, label }（id 即 data-theme 值）
 *   2. 在 style.css 追加 `:root[data-theme="<id>"]` 令牌块，按需覆盖语义令牌
 *      （--ink 系/--paper/--label-grey/--white 系/--canvas 系/--accent 系/--scrim 等；
 *        视图画布色只改 --canvas-* 令牌值，无需复制 data-view 映射表；
 *        暗色主题另加 `color-scheme: dark`）
 *   3. 如需让 index.html 启动闪屏跟随主题，在其 <style> 内加同名钩子
 *   4. 画布或墨色改向时复核 style.css 的 .app-body 次级文字升档白名单
 *      （ink-64→86 档是全局规则；暗色下只需保证 --ink-* 仍是同色相
 *        高对比 alpha 阶梯）。注意两组极性配对：
 *        --accent-magenta-on-ink（墨面文字用，暗色下指向深档值）与
 *        --scrim-strong（罩上压 --paper 图标，极性随 --paper 翻面）。
 *
 * 'default' 不写属性（:root 基线即默认主题）；未知/非法 id 一律回落 default。
 * 'pixel-retro' 当前只承载全屏歌词页的 --pixel-* 调色变体，不改 print-grid 应用令牌。
 */
import { ref, readonly } from 'vue'

export const THEMES = [
  { id: 'default', label: 'print-grid' },
  { id: 'glitch-restoration', label: 'glitch' },
  { id: 'pixel-retro', label: 'pixel-retro' },
]

// 与 index.html 内联脚本共用键名，改动须同步
const STORAGE_KEY = 'meowsync-theme'
const LEGACY_KEY = 'pixel-theme' // 旧键历史写值域已确认只有 'default'/'pixel-retro'
const VALID = new Set(THEMES.map(t => t.id))

function readStoredTheme() {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v && VALID.has(v)) return v
    if (localStorage.getItem(LEGACY_KEY) === 'pixel-retro') return 'pixel-retro'
  } catch { /* localStorage 不可用（隐私模式等） */ }
  return 'default'
}

const stored = ref(readStoredTheme())
// 只读导出：外部一律经 setTheme 写入，防止 ref 与 data-theme 属性分叉
export const currentTheme = readonly(stored)

export function applyTheme(id) {
  const root = document.documentElement
  if (id === 'default') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', id)
}

export function setTheme(id) {
  if (!VALID.has(id)) id = 'default'
  stored.value = id
  try {
    // 先清旧键再写新键——setItem 抛异常时不会跳过旧键清理
    localStorage.removeItem(LEGACY_KEY)
    if (id === 'default') localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, id)
  } catch { /* 持久化失败不阻断应用 */ }
  applyTheme(id)
}

export function cycleTheme() {
  const i = THEMES.findIndex(t => t.id === stored.value)
  setTheme(THEMES[(i + 1) % THEMES.length].id)
}

// main.js 启动时调用一次：应用持久化主题 + 自愈存储 + 跨标签页同步
// （storage 事件只在其他同源文档触发；e.key===null 表示 localStorage.clear()）
export function initTheme() {
  setTheme(stored.value) // 经 setTheme 规范化+回写：非法值/旧键残留在此自愈
  window.addEventListener('storage', (e) => {
    if (e.key === null || e.key === STORAGE_KEY || e.key === LEGACY_KEY) {
      stored.value = readStoredTheme()
      applyTheme(stored.value)
    }
  })
}

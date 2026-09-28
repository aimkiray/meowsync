/**
 * 主题注册表与持久化——data-theme 的唯一读写入口。
 *
 * 新增主题只需三步：
 *   1. 在 THEMES 注册 { id, label }（id 即 data-theme 值）
 *   2. 在 style.css 追加 `:root[data-theme="<id>"]` 令牌块，按需覆盖语义令牌
 *      （--ink 系/--paper/--label-grey/--white 系/--canvas 系/--accent 系/--scrim 等；
 *        视图画布色只改 --canvas-* 令牌值，无需复制 data-view 映射表；
 *        暗色主题另加 `color-scheme: dark`）
 *   3. 如需让 index.html 启动闪屏跟随主题，在其 <style> 内加同名钩子
 *
 * 'default' 不写属性（:root 基线即默认主题）；未知/非法 id 一律回落 default。
 * 'pixel-retro' 当前只承载全屏歌词页的 --pixel-* 调色变体，不改 print-grid 应用令牌。
 */
import { ref } from 'vue'

export const THEMES = [
  { id: 'default', label: 'print-grid' },
  { id: 'pixel-retro', label: 'pixel-retro' },
]

const STORAGE_KEY = 'meowsync-theme'
const LEGACY_KEY = 'pixel-theme' // 旧键仅可能存过 'pixel-retro'
const VALID = new Set(THEMES.map(t => t.id))

function readStoredTheme() {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v && VALID.has(v)) return v
    if (localStorage.getItem(LEGACY_KEY) === 'pixel-retro') return 'pixel-retro'
  } catch { /* localStorage 不可用（隐私模式等） */ }
  return 'default'
}

export const currentTheme = ref(readStoredTheme())

export function applyTheme(id) {
  const root = document.documentElement
  if (id === 'default') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', id)
}

export function setTheme(id) {
  if (!VALID.has(id)) id = 'default'
  currentTheme.value = id
  try {
    if (id === 'default') localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, id)
    localStorage.removeItem(LEGACY_KEY)
  } catch { /* 持久化失败不阻断应用 */ }
  applyTheme(id)
}

export function cycleTheme() {
  const i = THEMES.findIndex(t => t.id === currentTheme.value)
  setTheme(THEMES[(i + 1) % THEMES.length].id)
}

// main.js 启动时调用一次：应用持久化主题 + 跨标签页同步
export function initTheme() {
  applyTheme(currentTheme.value)
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY && e.key !== LEGACY_KEY) return
    currentTheme.value = readStoredTheme()
    applyTheme(currentTheme.value)
  })
}

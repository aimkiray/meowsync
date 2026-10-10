/**
 * 主题注册表与持久化——data-theme 的两个写点之一
 * （另一处是 index.html 内联脚本，负责首帧前恢复；两处的
 *   STORAGE_KEY 键名必须保持同步）。
 *
 * 新增主题只需四步：
 *   1. 在 THEMES 注册 { id, name }（id 即 data-theme 值；name 是顶栏菜单里的展示名）
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
 * 'default' 不写属性（:root 基线即默认主题，UI 显示名 retro）；未知/非法 id 一律回落 default。
 */
import { ref, readonly } from 'vue'
import { LS_KEYS, notifyStorageWrite } from './storage.js'

export const THEMES = [
  { id: 'default', name: 'retro' },
  { id: 'glitch-restoration', name: 'glitch' },
]

// 与 index.html 内联脚本共用键名，改动须同步
const STORAGE_KEY = LS_KEYS.THEME
const VALID = new Set(THEMES.map(t => t.id))

// 导出给同步引擎远端回填用（src/lib/sync.js 的远端订阅调它）——
// 叶模块不许反向 import sync.js：会把 api/http 链拖进 node:test 裸跑面
export function readStoredTheme() {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v && VALID.has(v)) return v
  } catch { /* localStorage 不可用（隐私模式等） */ }
  return 'default'
}

const stored = ref(readStoredTheme())
// 只读导出：外部一律经 setTheme 写入，防止 ref 与 data-theme 属性分叉
export const currentTheme = readonly(stored)

/* glitch-restoration 的「张力表盘」：全屏共享的腐蚀世代计数——
   规范语义是叙事驱动（我们映射到「错误事件」）：每次 +1，
   所有 GlitchText 实例读到同值并触发一次 burst 全 scramble，
   短暂闪回后回净（corruption 是张力不是装饰纹理）。
   覆盖边界：反馈服务错误（toast error / danger confirm）经
   feedback.js 接入；播放错误经 usePlayer 的 watch(playbackError)
   接入——WatchView 侧 error toast 同拍再 +1，同代合并为一发
   burst；下载轮询出的行内失败
   是「状态」而非「事件」，不推表盘。 */
const gen = ref(0)
export const glitchGen = readonly(gen)
export function glitchBurst() { gen.value++ }

function applyTheme(id) {
  const root = document.documentElement
  if (id === 'default') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', id)
}

export function setTheme(id) {
  if (!VALID.has(id)) id = 'default'
  stored.value = id
  try {
    if (id === 'default') localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, id)
    // 同步脏标记（含 'default' 的 removeItem 墓碑）——引擎未 init 时 no-op
    notifyStorageWrite(STORAGE_KEY)
  } catch { /* 持久化失败不阻断应用 */ }
  applyTheme(id)
}

// 多端同步远端落地（订阅在同步侧 sync.js initSync 注册——本文件保持叶
// 模块不反向依赖引擎）。只做内存/DOM 侧归一，不回写 LS：远端可能存着
// 新版客户端才有、本机 VALID 不认的主题 id——经 setTheme 归一会把 LS
// 原文重写成 default/removeItem，同步层再把它当本地删除推成墓碑，
// 等于旧版客户端把新版数据从服务端抹掉
export function applyRemoteTheme() {
  let raw = null
  try { raw = localStorage.getItem(STORAGE_KEY) } catch { /* 隐私模式 */ }
  const id = raw && VALID.has(raw) ? raw : 'default'
  stored.value = id
  applyTheme(id)
}

// main.js 启动时调用一次：应用持久化主题 + 自愈存储 + 跨标签页同步
// （storage 事件只在其他同源文档触发；e.key===null 表示 localStorage.clear()）
export function initTheme() {
  setTheme(stored.value) // 经 setTheme 规范化+回写：非法值/旧键残留在此自愈
  window.addEventListener('storage', (e) => {
    if (e.key === null || e.key === STORAGE_KEY) {
      stored.value = readStoredTheme()
      applyTheme(stored.value)
    }
  })
}

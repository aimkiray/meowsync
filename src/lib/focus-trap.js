// 弹层/菜单的焦点管理共享实现：aria-modal 的 Tab 钳制（可聚焦集首尾互跳）
// 与 role=menu 的 ↑↓ 循环移焦。抽自 SongFormDialog/FeedbackHost 的原地实现——
// App 三弹层（atp/新建歌单/点歌台）与两个行级 ⋯ 菜单同用这一份，不新造三份。
//
// 用法（options API 模板直绑）：
//   <div role="dialog" @keydown="onDialogKeydown">  // 内调 trapTabKeydown(e)
//   <div role="menu" @keydown="cycleMenuItems">

// Tab 序可聚焦集——display:none 的元素能命中选择器但不可聚焦，
// getClientRects 过滤是首尾判定不落空的关键（隐藏 file input 是实例坑）
export const FOCUSABLE_SEL = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Tab/Shift+Tab 焦点钳制：焦点在容器内可聚焦集首项时 Shift+Tab 跳末项、
 * 在末项时 Tab 跳回首项——其余位置放行自然 Tab 序（容器内 DOM 序即 Tab 序）。
 * 焦点不在可聚焦集（容器根本体——FullscreenPlayer 根 tabindex=-1 开层即焦、
 * 点非聚焦面落 body、被程序挪出层外）时浏览器默认序会穿出遮罩落进下层——
 * 钳回端点封洞而不是放行，保「aria-modal 无洞」。
 * @param {KeyboardEvent} e 容器上的 keydown（currentTarget 即容器时可省第二参；
 *   window 监听补网根外焦点事件时须显式传容器——currentTarget 是 window）
 * @param {Element} [container] 钳制范围（默认 e.currentTarget）
 * @returns {boolean} 已消费（preventDefault+移焦）则 true
 */
export function trapTabKeydown(e, container = e.currentTarget) {
  if (e.key !== 'Tab' || !container) return false
  const focusables = [...container.querySelectorAll(FOCUSABLE_SEL)]
    .filter(el => el.getClientRects().length > 0)
  if (!focusables.length) return false
  const first = focusables[0]
  const last = focusables[focusables.length - 1]
  const ae = document.activeElement
  // 端点外逃逸口：ae 不在可聚焦集即「焦点已不在该走的序里」——Tab 收进首项、
  // Shift+Tab 收进末项，两个方向都钳回层内而不是让默认序落出遮罩
  if (!focusables.includes(ae)) {
    e.preventDefault()
    ;(e.shiftKey ? last : first).focus()
    return true
  }
  if (e.shiftKey && ae === first) {
    e.preventDefault()
    last.focus()
    return true
  }
  if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault()
    first.focus()
    return true
  }
  return false
}

/**
 * role=menu 的 ↑↓ 循环移焦：焦点不在任何项上时 ↓ 落首项 / ↑ 落末项，
 * 在项上时按位循环。Esc 关菜单与各组件的归还逻辑各自负责，不在本函数域。
 * @param {KeyboardEvent} e 菜单容器上的 keydown
 * @param {string} [itemSel] 菜单项选择器（默认 .pg-menu-item:not([disabled])——
 *   div[tabindex=0] 项无 disabled 属性天然命中，button 项被禁则跳过）
 * @returns {boolean} 已消费则 true
 */
export function cycleMenuItems(e, itemSel = '.pg-menu-item:not([disabled])') {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return false
  const items = [...e.currentTarget.querySelectorAll(itemSel)]
  if (!items.length) return false
  e.preventDefault()
  const i = items.indexOf(document.activeElement)
  const dir = e.key === 'ArrowDown' ? 1 : -1
  const next = i === -1
    ? (dir === 1 ? 0 : items.length - 1)
    : (i + dir + items.length) % items.length
  items[next].focus()
  return true
}

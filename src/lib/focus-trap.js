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
 * @param {KeyboardEvent} e 容器上的 keydown（currentTarget 即容器时可省第二参）
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
  if (e.shiftKey && document.activeElement === first) {
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

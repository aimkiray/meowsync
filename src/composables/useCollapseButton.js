import { ref, watch, nextTick, onMounted, onUnmounted } from 'vue'

/**
 * 折叠按钮垂直居中定位。
 * 面板的"折叠态高度"不可直接从 DOM 读（当前处于展开态），因此克隆一个
 * 折叠态 class 的隐藏节点测量其高度，算出按钮应有的 top 偏移。
 *
 * @param {Ref<HTMLElement>} panelContainer 面板根元素的 ref
 * @param {() => boolean} collapsed 是否折叠的 getter（通常 () => props.collapsed）
 */
export function useCollapseButton(panelContainer, collapsed) {
  const collapseButtonRef = ref(null)
  const fixedButtonTop = ref(null)

  const computeCollapsedCenterTop = () => {
    nextTick(() => {
      if (!collapseButtonRef.value) return
      const buttonHeight = collapseButtonRef.value.offsetHeight || 24
      const clone = document.createElement('div')
      clone.className = 'jirai-card flex flex-col relative p-4 min-h-[3rem]'
      clone.style.position = 'absolute'
      clone.style.visibility = 'hidden'
      clone.style.left = '-9999px'
      clone.style.top = '-9999px'
      if (panelContainer.value) {
        clone.style.width = panelContainer.value.offsetWidth + 'px'
      }
      document.body.appendChild(clone)
      const collapsedHeight = clone.offsetHeight
      document.body.removeChild(clone)
      const topValue = (collapsedHeight / 2) - (buttonHeight / 2)
      fixedButtonTop.value = Math.round(topValue) + 'px'
    })
  }

  onMounted(() => {
    // 初始计算折叠居中位置，避免首屏展开位置跳变
    computeCollapsedCenterTop()
    window.addEventListener('resize', computeCollapsedCenterTop)
  })

  onUnmounted(() => {
    window.removeEventListener('resize', computeCollapsedCenterTop)
  })

  watch(collapsed, computeCollapsedCenterTop)

  return { collapseButtonRef, fixedButtonTop }
}

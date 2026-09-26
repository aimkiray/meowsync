/** 复制文本到剪贴板：Clipboard API → textarea+execCommand 降级。返回是否成功。 */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // 降级方案（非安全上下文 / 旧浏览器）
    const textArea = document.createElement('textarea')
    textArea.value = text
    textArea.setAttribute('readonly', '') // 避免 iOS 聚焦时弹出键盘
    textArea.style.position = 'fixed'
    textArea.style.opacity = '0'
    document.body.appendChild(textArea)
    try {
      textArea.select()
      // iOS Safari 需要显式选区，execCommand 才有内容可复制
      textArea.setSelectionRange(0, textArea.value.length)
      // execCommand 返回 false 代表复制失败，不能再当成功上报
      return document.execCommand('copy')
    } catch {
      return false
    } finally {
      // 放在 finally：select/execCommand 抛错时不能把 textarea 遗留在 DOM 里
      textArea.remove()
    }
  }
}

/**
 * 分享：Web Share API → 复制链接降级。
 * @returns {'shared'|'copied'|'cancelled'|'failed'}
 */
export async function shareOrCopy({ title, text, url }) {
  if (navigator.share) {
    try {
      await navigator.share({ title, text, url })
      return 'shared'
    } catch (err) {
      // 用户主动取消不算失败，也不再降级复制
      if (err?.name === 'AbortError') return 'cancelled'
      // 其余错误（如不支持的内容）继续走复制降级
    }
  }
  // url 为空时复制 text，避免把 "undefined" 写进剪贴板
  return (await copyText(url || text || '')) ? 'copied' : 'failed'
}

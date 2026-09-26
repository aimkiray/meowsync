/** 复制文本到剪贴板：Clipboard API → textarea+execCommand 降级。返回是否成功。 */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // 降级方案（非安全上下文 / 旧浏览器）
    try {
      const textArea = document.createElement('textarea')
      textArea.value = text
      textArea.style.position = 'fixed'
      textArea.style.opacity = '0'
      document.body.appendChild(textArea)
      textArea.select()
      document.execCommand('copy')
      document.body.removeChild(textArea)
      return true
    } catch {
      return false
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
  return (await copyText(url)) ? 'copied' : 'failed'
}

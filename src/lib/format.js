/** 秒 → "m:ss" */
export function formatTime(seconds) {
  if (!seconds || !Number.isFinite(seconds) || seconds < 0) return '0:00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

/** 毫秒 → "m:ss" */
export function formatDuration(ms) {
  if (!ms || !Number.isFinite(ms)) return '0:00'
  return formatTime(ms / 1000)
}

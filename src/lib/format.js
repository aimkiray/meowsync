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

/**
 * 时长输入宽松解析 → 毫秒：mm:ss / 纯秒 / m:ss.ms 都收，空=0（=「自动」语义，
 * 服务端/播放器按 0 判未知时长不走 VIP 试听误报）。非法返回 NaN（调用方
 * Number.isNaN 判）。分钟上限 5 位（99999min≈69 天，再长视为误输入）
 */
export function parseDurationMs(s) {
  const t = String(s || '').trim()
  if (!t) return 0
  const m = /^(\d{1,5})(?::([0-5]?\d)(?:\.(\d{1,2}))?)?$/.exec(t)
  if (!m) return NaN
  return (+m[1]) * (m[2] != null ? 60000 : 1000)
    + (m[2] ? +m[2] * 1000 : 0)
    + (m[3] ? +m[3].padEnd(2, '0') * 10 : 0)
}

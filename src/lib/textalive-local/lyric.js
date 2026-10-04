// grapheme 粒度切分：ZWJ/keycap emoji 序列（👨‍👩‍👧、1️⃣）按码点切会劈碎成
// 豆腐块/空白格——与 local-textalive-adapter.js 的 splitGraphemes 同策略，
// 不支持 Intl.Segmenter 的老内核回退 Array.from（码点切，行为同旧版）
let graphemeSegmenter = null
let graphemeSegmenterTried = false

function splitGraphemes(text) {
  if (!graphemeSegmenterTried) {
    graphemeSegmenterTried = true
    try {
      graphemeSegmenter = typeof Intl?.Segmenter === 'function'
        ? new Intl.Segmenter('zh', { granularity: 'grapheme' })
        : null
    } catch {
      graphemeSegmenter = null
    }
  }
  if (!graphemeSegmenter) {
    return Array.from(text)
  }
  try {
    return [...graphemeSegmenter.segment(text)].map(part => part.segment)
  } catch {
    return Array.from(text)
  }
}

export class Lyric {
  constructor(data) {
    this.text = data.text
    this.startTime = data.startTime
    this.endTime = data.endTime
    this.duration = data.duration
    this.lineId = data.lineId // 同源歌词行 id：同句词块共享行轴方向
    this.lineLength = data.lineLength // 整句字数：锚点居中反推用

    // Character-level layout state
    this.glyphs = splitGraphemes(this.text) // Split text into grapheme clusters
    this.glyphPositions = [] // Array of {x, y} for each grapheme
    this.anchorX = 0 // Starting position for first glyph
    this.anchorY = 0
    this.lastGlyphX = 0 // Position of last glyph
    this.lastGlyphY = 0

    this.isDraw = false
    this.slotKeys = [] // Now stores glyph-level slot keys
  }
}

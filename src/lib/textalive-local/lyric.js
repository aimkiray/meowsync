export class Lyric {
  constructor(data) {
    this.text = data.text
    this.startTime = data.startTime
    this.endTime = data.endTime
    this.duration = data.duration
    this.lineId = data.lineId // 同源歌词行 id：同句词块共享行轴方向
    this.lineLength = data.lineLength // 整句字数：锚点居中反推用

    // Character-level layout state
    this.glyphs = Array.from(this.text) // Split text into individual characters
    this.glyphPositions = [] // Array of {x, y} for each character
    this.anchorX = 0 // Starting position for first character
    this.anchorY = 0
    this.lastGlyphX = 0 // Position of last character
    this.lastGlyphY = 0

    this.isDraw = false
    this.slotKeys = [] // Now stores character-level slot keys
  }
}

const AUTO_DRIFT_SPEED = 680
const TOUCH_DRIFT_SPEED_MULTIPLIER = 0.5
const MAX_DELTA_SECONDS = 0.08
const INTRO_ANIMATION_MS = 560
const CAMERA_BASE_SMOOTHING = 0.012
const CAMERA_REVEAL_BOOST = 0.004
const MIN_GLYPH_DURATION_MS = 80
const LYRIC_PERSIST_MS = 1800
const SPAWN_RADIUS_X = 3
const SPAWN_RADIUS_Y = 2
const CAMERA_LOOKAHEAD = 0.08
const CAMERA_WORD_CENTER_PULL = 0.7
const CAMERA_SETTLED_PULL = 0.58
const CAMERA_IDLE_AMPLITUDE_X = 0.16
const CAMERA_IDLE_AMPLITUDE_Y = 0.12
const CAMERA_IDLE_SPEED_X = 0.00024
const CAMERA_IDLE_SPEED_Y = 0.00017

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

function lerp(start, end, amount) {
  return start + (end - start) * amount
}

export class CanvasManager {
  constructor(container) {
    this._container = container
    this._px = 0
    this._py = 0
    this._rx = 0
    this._ry = 0
    this._space = 160
    this._speed = AUTO_DRIFT_SPEED
    this._position = 0
    this._isOver = false
    this._interactionMode = 'auto'
    this._lyrics = []
    this._activeLyricIndex = -1

    this._can = document.createElement('canvas')
    this._ctx = this._can.getContext('2d')
    this._can.className = 'textalive-local-canvas'
    this._container.append(this._can)

    this._handleMove = (event) => this._move(event)
    this._handleLeave = () => this._leave()
    this._handleResize = () => this.resize()

    window.addEventListener('mousemove', this._handleMove)
    window.addEventListener('mouseleave', this._handleLeave)
    window.addEventListener('resize', this._handleResize)

    if ('ontouchstart' in window) {
      this._space *= 0.5
      this._speed *= TOUCH_DRIFT_SPEED_MULTIPLIER
      window.addEventListener('touchmove', this._handleMove, { passive: true })
      window.addEventListener('touchend', this._handleLeave)
    }

    this.resize()
  }

  setLyrics(lyrics) {
    this._lyrics = Array.isArray(lyrics) ? lyrics : []
    this.resetLayout()
    this._drawBg()
    this._drawLyrics()
  }

  resetLayout() {
    this._px = 0
    this._py = 0
    this._position = 0
    this._activeLyricIndex = -1
    this._lyrics.forEach((lyric) => {
      lyric.anchorX = 0
      lyric.anchorY = 0
      lyric.lastGlyphX = 0
      lyric.lastGlyphY = 0
      lyric.isDraw = false
      lyric.slotKeys = []
      lyric.glyphPositions = []
    })
  }

  setInteractionMode(mode) {
    this._interactionMode = mode === 'pointer' ? 'pointer' : 'auto'
    this._isOver = false
  }

  update(position) {
    if (this._interactionMode !== 'pointer') {
      this._isOver = false
    }

    if (!this._isOver) {
      const followTarget = this._findCameraTarget(position)
      const idleOffset = this._getIdleCameraOffset(position, followTarget?.idleStrength ?? 1)

      if (followTarget) {
        const targetPx = -(followTarget.x + idleOffset.x) * this._space + this._stw / 2
        const targetPy = -(followTarget.y + idleOffset.y) * this._space + this._sth / 2
        const smoothing = CAMERA_BASE_SMOOTHING + followTarget.revealStrength * CAMERA_REVEAL_BOOST

        this._px += (targetPx - this._px) * smoothing
        this._py += (targetPy - this._py) * smoothing
      } else {
        const targetPx = -idleOffset.x * this._space
        const targetPy = -idleOffset.y * this._space

        this._px += (targetPx - this._px) * CAMERA_BASE_SMOOTHING
        this._py += (targetPy - this._py) * CAMERA_BASE_SMOOTHING
      }

      this._mouseX = this._stw / 2
      this._mouseY = this._sth / 2
    }

    this._drawBg()
    this._drawLyrics()

    this._position = position
  }

  resize() {
    const rect = this._container.getBoundingClientRect()
    this._can.width = this._stw = Math.max(Math.floor(rect.width || window.innerWidth), 1)
    this._can.height = this._sth = Math.max(Math.floor(rect.height || window.innerHeight), 1)
    this._drawBg()
    this._drawLyrics()
  }

  destroy() {
    window.removeEventListener('mousemove', this._handleMove)
    window.removeEventListener('mouseleave', this._handleLeave)
    window.removeEventListener('resize', this._handleResize)
    window.removeEventListener('touchmove', this._handleMove)
    window.removeEventListener('touchend', this._handleLeave)
    this._can.remove()
  }

  _move(event) {
    if (this._interactionMode !== 'pointer') {
      return
    }

    let mx = 0
    let my = 0

    if (event.touches?.length) {
      mx = event.touches[0].clientX
      my = event.touches[0].clientY
    } else {
      mx = event.clientX
      my = event.clientY
    }

    const rect = this._container.getBoundingClientRect()
    this._mouseX = mx - rect.left
    this._mouseY = my - rect.top
    this._rx = (this._mouseX / this._stw) * 2 - 1
    this._ry = (this._mouseY / this._sth) * 2 - 1
    this._isOver = this._mouseX >= 0 && this._mouseX <= this._stw && this._mouseY >= 0 && this._mouseY <= this._sth
  }

  _leave() {
    this._isOver = false
  }

  _drawBg() {
    const space = this._space
    const ox = this._px % space
    const oy = this._py % space
    const nx = this._stw / space + 1
    const ny = this._sth / space + 1
    const ctx = this._ctx

    ctx.clearRect(0, 0, this._stw, this._sth)
    ctx.strokeStyle = 'rgba(30, 25, 35, 0.85)'
    ctx.lineWidth = 1
    ctx.beginPath()

    for (let y = 0; y <= ny; y += 1) {
      for (let x = 0; x <= nx; x += 1) {
        const tx = x * space + ox
        const ty = y * space + oy
        ctx.moveTo(tx - 8, ty)
        ctx.lineTo(tx + 8, ty)
        ctx.moveTo(tx, ty - 8)
        ctx.lineTo(tx, ty + 8)
      }
    }

    ctx.stroke()
  }

  _findActiveLyricIndex(position) {
    const lyrics = this._lyrics
    if (!lyrics.length) {
      this._activeLyricIndex = -1
      return -1
    }

    let index = clamp(this._activeLyricIndex, 0, lyrics.length - 1)

    if (this._activeLyricIndex === -1) {
      while (index < lyrics.length && lyrics[index].endTime + LYRIC_PERSIST_MS < position) {
        index += 1
      }
    } else {
      while (index > 0 && lyrics[index].startTime > position) {
        index -= 1
      }

      while (index < lyrics.length && lyrics[index].endTime + LYRIC_PERSIST_MS < position) {
        index += 1
      }
    }

    this._activeLyricIndex = index < lyrics.length ? index : -1
    return this._activeLyricIndex
  }

  _getVisibleLyricRange(position) {
    const lyrics = this._lyrics
    const activeIndex = this._findActiveLyricIndex(position)
    if (activeIndex === -1) {
      return { start: lyrics.length, end: lyrics.length }
    }

    let start = activeIndex
    while (start > 0 && lyrics[start - 1].endTime + LYRIC_PERSIST_MS >= position) {
      start -= 1
    }

    let end = activeIndex
    while (end + 1 < lyrics.length && lyrics[end + 1].startTime <= position) {
      end += 1
    }

    return { start, end: end + 1 }
  }

  _getIdleCameraOffset(position, strength = 1) {
    return {
      x: Math.sin(position * CAMERA_IDLE_SPEED_X) * CAMERA_IDLE_AMPLITUDE_X * strength,
      y: Math.cos(position * CAMERA_IDLE_SPEED_Y) * CAMERA_IDLE_AMPLITUDE_Y * strength
    }
  }

  _findCameraTarget(position) {
    const { start, end } = this._getVisibleLyricRange(position)
    if (start >= end) {
      return null
    }

    let settledTarget = null

    for (let i = start; i < end; i++) {
      const lyric = this._lyrics[i]
      if (!lyric.isDraw || lyric.glyphPositions.length === 0) {
        continue
      }

      const wordCenter = this._getWordCenter(lyric)
      const lyricVisibleUntil = lyric.endTime + LYRIC_PERSIST_MS

      if (position <= lyric.endTime) {
        for (let g = 0; g < lyric.glyphs.length; g++) {
          const glyphPos = lyric.glyphPositions[g]
          if (!glyphPos) {
            continue
          }

          const timing = this._getGlyphTiming(lyric, g)
          const progress = this._getGlyphProgress(position, timing)

          if (progress > 0 && progress < 1) {
            const nextGlyphPos = lyric.glyphPositions[g + 1] || glyphPos
            const leadX = lerp(glyphPos.x, nextGlyphPos.x, CAMERA_LOOKAHEAD * progress)
            const leadY = lerp(glyphPos.y, nextGlyphPos.y, CAMERA_LOOKAHEAD * progress)

            return {
              x: lerp(leadX, wordCenter.x, CAMERA_WORD_CENTER_PULL),
              y: lerp(leadY, wordCenter.y, CAMERA_WORD_CENTER_PULL),
              revealStrength: progress * 0.6,
              idleStrength: 0.2
            }
          }
        }
      }

      if (position <= lyricVisibleUntil) {
        const settleProgress = clamp((position - lyric.endTime) / LYRIC_PERSIST_MS, 0, 1)
        const settleStrength = 1 - settleProgress

        settledTarget = {
          x: wordCenter.x,
          y: wordCenter.y,
          revealStrength: 0.12 * settleStrength,
          idleStrength: 0.35 * settleProgress
        }
      }
    }

    return settledTarget
  }

  _getWordCenter(lyric) {
    const first = lyric.glyphPositions[0]
    const last = lyric.glyphPositions[lyric.glyphPositions.length - 1]

    if (!first || !last) {
      return { x: 0, y: 0 }
    }

    return {
      x: (first.x + last.x) / 2,
      y: (first.y + last.y) / 2
    }
  }

  _getGlyphTiming(lyric, glyphIndex) {
    const glyphCount = Math.max(lyric.glyphs.length, 1)
    const glyphDuration = Math.max(lyric.duration / glyphCount, MIN_GLYPH_DURATION_MS)
    const glyphStartTime = lyric.startTime + glyphDuration * glyphIndex
    const isLastGlyph = glyphIndex === glyphCount - 1
    const glyphEndTime = isLastGlyph
      ? lyric.endTime
      : Math.min(lyric.startTime + glyphDuration * (glyphIndex + 1), lyric.endTime)

    return {
      startTime: glyphStartTime,
      endTime: Math.max(glyphEndTime, glyphStartTime + 1)
    }
  }

  _getGlyphProgress(position, timing) {
    if (position <= timing.startTime) {
      return 0
    }

    if (position >= timing.endTime) {
      return 1
    }

    return clamp((position - timing.startTime) / (timing.endTime - timing.startTime), 0, 1)
  }

  _easeOutCubic(x) {
    return 1 - Math.pow(1 - x, 3)
  }

  _drawLyrics() {
    if (!this._lyrics?.length) return

    const position = this._position
    const { start, end } = this._getVisibleLyricRange(position)
    if (start >= end) return

    const space = this._space
    const ctx = this._ctx
    const occupiedSlots = new Set()
    ctx.textAlign = 'center'
    ctx.fillStyle = '#241827'

    const getSlotKeys = (positions) => {
      return positions.map(pos => `${pos.x}:${pos.y}`)
    }

    const buildSpawnCandidates = (nx, ny) => {
      const candidates = []
      for (let y = -SPAWN_RADIUS_Y; y <= SPAWN_RADIUS_Y; y += 1) {
        for (let x = -SPAWN_RADIUS_X; x <= SPAWN_RADIUS_X; x += 1) {
          candidates.push({ x: nx + x, y: ny + y })
        }
      }

      for (let i = candidates.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[candidates[i], candidates[j]] = [candidates[j], candidates[i]]
      }

      return candidates
    }

    const tryPlaceWord = (startX, startY, lyric) => {
      const positions = []
      for (let i = 0; i < lyric.glyphs.length; i++) {
        positions.push({ x: startX + i, y: startY })
      }

      const slotKeys = getSlotKeys(positions)
      const isOk = slotKeys.every(key => !occupiedSlots.has(key))

      if (isOk) {
        return { positions, slotKeys }
      }
      return null
    }

    for (let i = start; i < end; i += 1) {
      const lyric = this._lyrics[i]

      if (lyric.startTime < position) {
        if (position < lyric.endTime) {
          if (!Number.isNaN(this._mouseX) && !lyric.isDraw) {
            const nx = Math.floor((-this._px + this._mouseX) / space)
            const ny = Math.floor((-this._py + this._mouseY) / space)

            const candidates = buildSpawnCandidates(nx, ny)
            let placed = false

            for (const candidate of candidates) {
              const result = tryPlaceWord(candidate.x, candidate.y, lyric)
              if (result) {
                lyric.glyphPositions = result.positions
                lyric.slotKeys = result.slotKeys
                lyric.anchorX = candidate.x
                lyric.anchorY = candidate.y
                lyric.lastGlyphX = result.positions[result.positions.length - 1].x
                lyric.lastGlyphY = result.positions[result.positions.length - 1].y
                lyric.isDraw = true
                placed = true
                break
              }
            }

            if (!placed) {
              hitcheck: for (let n = 0; n <= 100; n += 1) {
                let tx = n
                let ty = 0
                let mx = -1
                let my = 1
                const rn = n === 0 ? 1 : n * 4

                for (let r = 0; r < rn; r += 1) {
                  const result = tryPlaceWord(nx + tx, ny + ty, lyric)
                  if (result) {
                    lyric.glyphPositions = result.positions
                    lyric.slotKeys = result.slotKeys
                    lyric.anchorX = nx + tx
                    lyric.anchorY = ny + ty
                    lyric.lastGlyphX = result.positions[result.positions.length - 1].x
                    lyric.lastGlyphY = result.positions[result.positions.length - 1].y
                    lyric.isDraw = true
                    break hitcheck
                  }

                  tx += mx
                  if (tx === n || tx === -n) mx = -mx
                  ty += my
                  if (ty === n || ty === -n) my = -my
                }
              }
            }
          }
        }

        const isVisible = position <= lyric.endTime + LYRIC_PERSIST_MS

        if (lyric.isDraw && isVisible) {
          if (!lyric.slotKeys?.length) {
            const result = tryPlaceWord(lyric.anchorX, lyric.anchorY, lyric)
            if (result) {
              lyric.glyphPositions = result.positions
              lyric.slotKeys = result.slotKeys
            }
          }

          if (lyric.slotKeys.some(slotKey => occupiedSlots.has(slotKey))) {
            lyric.isDraw = false
            lyric.slotKeys = []
            lyric.glyphPositions = []
            continue
          }

          lyric.slotKeys.forEach(slotKey => occupiedSlots.add(slotKey))

          for (let g = 0; g < lyric.glyphs.length; g++) {
            const glyph = lyric.glyphs[g]
            const glyphPos = lyric.glyphPositions[g]
            if (!glyphPos) continue

            const timing = this._getGlyphTiming(lyric, g)
            const revealProgress = this._getGlyphProgress(position, timing)
            const isSettledGlyph = position > lyric.endTime && position <= lyric.endTime + LYRIC_PERSIST_MS
            if (revealProgress <= 0 && !isSettledGlyph) continue

            let px = glyphPos.x * space
            let py = glyphPos.y * space

            if (px + space < -this._px || -this._px + this._stw < px) continue
            if (py + space < -this._py || -this._py + this._sth < py) continue

            px = this._px + px + space / 2
            py = this._py + py + space / 2

            const introDuration = Math.min(INTRO_ANIMATION_MS, timing.endTime - timing.startTime + INTRO_ANIMATION_MS * 0.45)
            const introProgress = clamp((position - timing.startTime) / Math.max(introDuration, 1), 0, 1)
            const easedIntro = this._easeOutCubic(introProgress)
            const settleProgress = clamp((position - lyric.endTime) / LYRIC_PERSIST_MS, 0, 1)
            const settledAlpha = 1 - settleProgress * 0.82
            const scale = 0.82 + 0.18 * easedIntro
            const alpha = (0.42 + 0.58 * easedIntro) * settledAlpha
            const verticalOffset = (1 - easedIntro) * space * 0.02
            const fontSize = space * 0.5 * scale

            ctx.save()
            ctx.globalAlpha = alpha
            ctx.translate(px, py + fontSize * 0.37 + verticalOffset)
            ctx.font = `bold ${fontSize}px Fusion Pixel, Noto Sans SC, sans-serif`
            ctx.fillText(glyph, 0, 0)
            ctx.restore()
          }
        }
      } else {
        lyric.isDraw = false
        lyric.slotKeys = []
        lyric.glyphPositions = []
      }
    }
  }
}

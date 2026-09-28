const AUTO_DRIFT_SPEED = 120
const TOUCH_DRIFT_SPEED_MULTIPLIER = 0.5
const MAX_DELTA_SECONDS = 0.08
const INTRO_ANIMATION_MS = 560
const MIN_GLYPH_DURATION_MS = 80
const LYRIC_PERSIST_MS = 1800
const SPAWN_RADIUS_X = 3
const SPAWN_RADIUS_Y = 2
const DRIFT_DIRECTION_CHANGE_MIN_MS = 2000
const DRIFT_DIRECTION_CHANGE_MAX_MS = 6000
const DRIFT_ROTATION_RATE = 0.8
// 行轴方向：每句歌词抽一个，同句词块沿该轴链式排布（随机感靠句间切换）。
// 只收可读方向：右/下/斜下——逆行（←↑↖）在格点上排布会破坏阅读顺序
const LINE_DIRECTIONS = [
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: 1, y: 1 }
]
// 可视区安全边距（格）：歌词锚点与吐字头都约束在屏幕内缩这个范围内
const VIEW_MARGIN_CELLS = 0.8

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
    this._space = 160
    this._speed = AUTO_DRIFT_SPEED
    this._position = 0
    this._isOver = false
    this._interactionMode = 'auto'
    this._lyrics = []
    this._activeLyricIndex = -1
    this._lastUpdateTime = 0
    this._driftAngle = Math.random() * Math.PI * 2
    this._driftTargetAngle = this._driftAngle
    this._nextDriftChange = 0
    // lineId -> { dir, tailX, tailY }：行轴方向与该句已排布链的末端
    this._lineState = new Map()
    // 当前激活歌词的吐字头格坐标：相机漂移的软牵引目标
    this._focusCell = null

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

    // 容器尺寸变化不一定伴随 window resize（全屏开关、布局变化等），
    // 只靠 window.resize 会让 backing store 停在旧尺寸导致拉伸模糊
    this._resizeObserver = null
    if (typeof ResizeObserver === 'function') {
      this._resizeObserver = new ResizeObserver(this._handleResize)
      this._resizeObserver.observe(this._container)
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
    this._lineState.clear()
    this._lyrics.forEach((lyric) => {
      lyric.anchorX = 0
      lyric.anchorY = 0
      lyric.lastGlyphX = 0
      lyric.lastGlyphY = 0
      lyric.dir = null
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
    // NaN/Infinity 参与相机插值后 _px/_py 永久变成 NaN，之后所有帧都无法恢复，
    // 非有限输入一律回退到上一帧的 position
    if (!Number.isFinite(position)) {
      position = this._position
    }

    if (this._interactionMode !== 'pointer') {
      this._isOver = false
    }

    if (!this._isOver) {
      const now = performance.now()
      if (!this._lastUpdateTime) this._lastUpdateTime = now
      const dt = Math.min((now - this._lastUpdateTime) / 1000, MAX_DELTA_SECONDS)
      this._lastUpdateTime = now

      if (now >= this._nextDriftChange) {
        this._driftAngle = this._driftTargetAngle
        this._driftTargetAngle = Math.random() * Math.PI * 2
        this._nextDriftChange = now + DRIFT_DIRECTION_CHANGE_MIN_MS + Math.random() * (DRIFT_DIRECTION_CHANGE_MAX_MS - DRIFT_DIRECTION_CHANGE_MIN_MS)
      }

      let angleDiff = this._driftTargetAngle - this._driftAngle
      while (angleDiff > Math.PI) angleDiff -= Math.PI * 2
      while (angleDiff < -Math.PI) angleDiff += Math.PI * 2
      const maxRotation = DRIFT_ROTATION_RATE * dt
      this._driftAngle += Math.max(-maxRotation, Math.min(maxRotation, angleDiff))

      // 触屏设备 _speed 已按 TOUCH_DRIFT_SPEED_MULTIPLIER 折半（构造器），
      // 这里必须读实例值而非常量，否则触屏漂移与桌面同速
      this._px += Math.cos(this._driftAngle) * this._speed * dt
      this._py += Math.sin(this._driftAngle) * this._speed * dt

      // 相机弹簧牵引：越出安全区的量按指数平滑回拉（~4/s 收敛），
      // 视觉上是被轻轻推回而非硬拽；冲出屏幕硬边才瞬时钳制兜底
      if (this._focusCell) {
        const space = this._space
        const pad = space * VIEW_MARGIN_CELLS
        const fx = this._px + this._focusCell.x * space + space / 2
        const fy = this._py + this._focusCell.y * space + space / 2
        const ease = 1 - Math.exp(-dt * 4)
        this._px += (clamp(fx, pad, this._stw - pad) - fx) * ease
        this._py += (clamp(fy, pad, this._sth - pad) - fy) * ease
        const edge = space * 0.3
        const hx = this._px + this._focusCell.x * space + space / 2
        const hy = this._py + this._focusCell.y * space + space / 2
        this._px += clamp(hx, edge, this._stw - edge) - hx
        this._py += clamp(hy, edge, this._sth - edge) - hy
      }

      this._mouseX = this._stw / 2
      this._mouseY = this._sth / 2
    }

    // 先更新 position 再绘制：否则本帧用的是上一帧的时间戳（seek 后首帧画旧位置）
    this._position = position

    this._drawBg()
    this._drawLyrics()
  }

  resize() {
    const rect = this._container.getBoundingClientRect()
    this._stw = Math.max(Math.floor(rect.width || window.innerWidth), 1)
    this._sth = Math.max(Math.floor(rect.height || window.innerHeight), 1)
    // devicePixelRatio：backing store 按 DPR 放大并用 setTransform 恢复逻辑像素，
    // 否则高分屏/手机上文字全模糊（上限 2 控制显存占用）
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    this._can.width = Math.floor(this._stw * dpr)
    this._can.height = Math.floor(this._sth * dpr)
    this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    this._drawBg()
    this._drawLyrics()
  }

  destroy() {
    window.removeEventListener('mousemove', this._handleMove)
    window.removeEventListener('mouseleave', this._handleLeave)
    window.removeEventListener('resize', this._handleResize)
    window.removeEventListener('touchmove', this._handleMove)
    window.removeEventListener('touchend', this._handleLeave)
    this._resizeObserver?.disconnect()
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
    this._focusCell = null
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

    // 视口安全区：歌词落位只允许在屏幕内缩 VIEW_MARGIN_CELLS 的范围内，
    // 否则长句尾部会被排进永远看不见的位置
    const viewPad = space * VIEW_MARGIN_CELLS
    const inView = (pos) => {
      const sx = this._px + pos.x * space + space / 2
      const sy = this._py + pos.y * space + space / 2
      return sx >= viewPad && sx <= this._stw - viewPad &&
        sy >= viewPad && sy <= this._sth - viewPad
    }

    const tryPlaceWord = (startX, startY, lyric, dir, strict = true) => {
      const positions = []
      for (let i = 0; i < lyric.glyphs.length; i++) {
        positions.push({ x: startX + dir.x * i, y: startY + dir.y * i })
      }

      const slotKeys = getSlotKeys(positions)
      const isOk = slotKeys.every(key => !occupiedSlots.has(key)) &&
        (!strict || positions.every(inView))

      if (isOk) {
        return { positions, slotKeys }
      }
      return null
    }

    const lineStateOf = (lyric) => {
      let state = this._lineState.get(lyric.lineId)
      if (!state) {
        state = {
          dir: LINE_DIRECTIONS[Math.floor(Math.random() * LINE_DIRECTIONS.length)],
          tailX: null,
          tailY: null
        }
        this._lineState.set(lyric.lineId, state)
      }
      return state
    }

    const commitPlacement = (lyric, state, result, anchorX, anchorY) => {
      lyric.glyphPositions = result.positions
      lyric.slotKeys = result.slotKeys
      lyric.anchorX = anchorX
      lyric.anchorY = anchorY
      lyric.dir = state.dir
      lyric.lastGlyphX = result.positions[result.positions.length - 1].x
      lyric.lastGlyphY = result.positions[result.positions.length - 1].y
      // 链尾 = 末字格沿行轴再延一格：下一块从这里接着排，同句连成字链
      state.tailX = lyric.lastGlyphX + state.dir.x
      state.tailY = lyric.lastGlyphY + state.dir.y
      lyric.isDraw = true
    }

    for (let i = start; i < end; i += 1) {
      const lyric = this._lyrics[i]

      if (lyric.startTime < position) {
        if (position < lyric.endTime) {
          // Number.isFinite 才能挡住 undefined（Number.isNaN(undefined) 为 false 会放行）
          if (Number.isFinite(this._mouseX) && !lyric.isDraw) {
            const state = lineStateOf(lyric)
            const dir = state.dir
            // 行轴是单向延伸的（→↓↘），以焦点为锚点会让长句尾部探出屏幕。
            // 锚点沿行轴反推半个"行长"（非块长），让整句大致以焦点为中心展开；
            // 链式候选不受影响（tailX 已是精确链尾）
            const backstep = Math.min(Math.floor((lyric.lineLength || lyric.glyphs.length) / 2), 8)
            const nx = Math.floor((-this._px + this._mouseX) / space) - dir.x * backstep
            const ny = Math.floor((-this._py + this._mouseY) / space) - dir.y * backstep

            // 链式候选优先：同句下一块从上一块链尾沿行轴延伸（含垂直向
            // 折行备选），占满才退回焦点散布——阅读顺序由相邻性保持
            const candidates = []
            if (state.tailX !== null) {
              const perpX = -dir.y
              const perpY = dir.x
              candidates.push(
                { x: state.tailX, y: state.tailY },
                { x: state.tailX + perpX, y: state.tailY + perpY },
                { x: state.tailX - perpX, y: state.tailY - perpY }
              )
            }
            candidates.push(...buildSpawnCandidates(nx, ny))

            let placed = false
            for (const candidate of candidates) {
              const result = tryPlaceWord(candidate.x, candidate.y, lyric, dir)
              if (result) {
                commitPlacement(lyric, state, result, candidate.x, candidate.y)
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
                  const result = tryPlaceWord(nx + tx, ny + ty, lyric, dir)
                  if (result) {
                    commitPlacement(lyric, state, result, nx + tx, ny + ty)
                    break hitcheck
                  }

                  tx += mx
                  if (tx === n || tx === -n) mx = -mx
                  ty += my
                  if (ty === n || ty === -n) my = -my
                }
              }
            }

            // 兜底：行比视口长或候选全撞时，放宽视口约束（保留占位检查）
            // 把锚点钳进安全区，宁可部分出屏也不让整句消失
            if (!lyric.isDraw) {
              const len = lyric.glyphs.length - 1
              const cx0 = Math.ceil((viewPad - this._px - space / 2) / space)
              const cx1 = Math.floor((this._stw - viewPad - this._px - space / 2) / space)
              const cy0 = Math.ceil((viewPad - this._py - space / 2) / space)
              const cy1 = Math.floor((this._sth - viewPad - this._py - space / 2) / space)
              const ax = clamp(nx, Math.min(cx0, cx1 - dir.x * len), Math.max(cx0, cx1 - dir.x * len))
              const ay = clamp(ny, Math.min(cy0, cy1 - dir.y * len), Math.max(cy0, cy1 - dir.y * len))
              const result = tryPlaceWord(ax, ay, lyric, dir, false)
              if (result) {
                commitPlacement(lyric, state, result, ax, ay)
              }
            }
          }
        }

        const isVisible = position <= lyric.endTime + LYRIC_PERSIST_MS

        if (lyric.isDraw && isVisible) {
          if (!lyric.slotKeys?.length) {
            // 重建走原锚点不验视口：落位时已验过，漂移途中重验会误杀
            const result = tryPlaceWord(lyric.anchorX, lyric.anchorY, lyric, lyric.dir || LINE_DIRECTIONS[0], false)
            if (result) {
              lyric.glyphPositions = result.positions
              lyric.slotKeys = result.slotKeys
            } else {
              // 重建失败必须清掉 isDraw：否则空 glyphPositions 永远画不出来，
              // 且生成逻辑（!lyric.isDraw）不会再重试，这句歌词将永久不可见
              lyric.isDraw = false
              continue
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

            // 吐字头 = 激活歌词最远已揭示的格：相机软牵引的目标。
            // 含淡出期（isSettledGlyph），让整句在消散前都留在屏内
            this._focusCell = glyphPos

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
            // 淡入淡出：入场 alpha 0→1，存续尾段整体渐隐到 0
            const alpha = easedIntro * (1 - settleProgress)
            const fontSize = space * 0.5

            ctx.save()
            ctx.globalAlpha = alpha
            ctx.translate(px, py + fontSize * 0.37)
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

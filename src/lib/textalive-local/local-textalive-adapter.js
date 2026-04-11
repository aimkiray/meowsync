import { Segment, useDefault } from 'segmentit'
import { Lyric } from './lyric'

const MIN_LINE_DURATION_MS = 900
const MAX_LINE_DURATION_MS = 5200
const MAX_GAP_LINE_DURATION_MS = 4200
const MAX_ENDING_LINE_DURATION_MS = 5600
const MIN_CHAR_DURATION_MS = 140
const TARGET_CHAR_DURATION_MS = 360
const MIN_LINE_PADDING_MS = 140
const GAP_THRESHOLD_MS = 3200
const MAX_REVEAL_STEPS = 6
const PER_CHAR_REVEAL_LIMIT = 4
const DEFAULT_GROUP_SIZE = 2
const MAX_LATIN_SEGMENT_LENGTH = 18
const MAX_CJK_SEGMENT_LENGTH = 2
const PUNCTUATION_PATTERN = /[，。、“”‘’？！；：,.!?;:、】【（）()《》〈〉…—\s]/
const LATIN_TOKEN_PATTERN = /^[A-Za-z0-9]+(?:[A-Za-z0-9'’-]*[A-Za-z0-9]+)*$/
const JAPANESE_CHAR_PATTERN = /[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9f々〆〤]/
const HIRAGANA_PATTERN = /[\u3040-\u309f]/
const KATAKANA_PATTERN = /[\u30a0-\u30ff\u31f0-\u31ff\uff66-\uff9f]/
const JAPANESE_PARTICLE_PATTERN = /^(は|が|を|に|へ|で|と|や|も|の|ね|よ|か|な|さ|ぞ|ぜ|わ|し|て|で|た|だ|ら|り|る|れ|ろ|う|ん|ゃ|ゅ|ょ)$/
const NON_SEGMENTABLE_PATTERN = /^[，。、“”‘’？！；：,.!?;:、】【（）()《》〈〉…—\s]+$/

let segmentit = null

function getSegmentit() {
  if (segmentit) {
    return segmentit
  }

  try {
    segmentit = useDefault(new Segment())
  } catch {
    segmentit = null
  }

  return segmentit
}

function createCharNode(text, startTime, endTime) {
  return {
    text,
    startTime,
    endTime,
    duration: Math.max(endTime - startTime, 1),
    next: null
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

function getLineDurationMs({ text, startMs, nextStartMs, durationSeconds }) {
  const charCount = Math.max(Array.from(text).length, 1)
  const targetDurationMs = Math.max(charCount * TARGET_CHAR_DURATION_MS, MIN_LINE_DURATION_MS)
  const minimumDurationMs = Math.max(charCount * MIN_CHAR_DURATION_MS, MIN_LINE_DURATION_MS)
  const songDurationMs = durationSeconds > 0 ? durationSeconds * 1000 : null

  if (typeof nextStartMs === 'number') {
    const availableDurationMs = Math.max(nextStartMs - startMs, minimumDurationMs)
    const safeWindowMs = Math.max(availableDurationMs - MIN_LINE_PADDING_MS, minimumDurationMs)
    const capMs = availableDurationMs >= GAP_THRESHOLD_MS ? MAX_GAP_LINE_DURATION_MS : MAX_LINE_DURATION_MS
    return clamp(Math.max(targetDurationMs, safeWindowMs * 0.92), minimumDurationMs, Math.min(safeWindowMs, capMs))
  }

  const endingCapMs = songDurationMs
    ? Math.max(Math.min(songDurationMs - startMs, MAX_ENDING_LINE_DURATION_MS), minimumDurationMs)
    : MAX_ENDING_LINE_DURATION_MS

  return clamp(Math.max(targetDurationMs, endingCapMs * 0.94), minimumDurationMs, endingCapMs)
}

function fallbackChunkGlyphs(text) {
  const glyphs = Array.from(text)
  if (glyphs.length <= PER_CHAR_REVEAL_LIMIT) {
    return glyphs.map(glyph => glyph)
  }

  const groups = []
  let buffer = ''

  glyphs.forEach((glyph) => {
    if (!buffer) {
      buffer = glyph
      return
    }

    if (PUNCTUATION_PATTERN.test(glyph)) {
      buffer += glyph
      groups.push(buffer)
      buffer = ''
      return
    }

    buffer += glyph

    if (buffer.length >= DEFAULT_GROUP_SIZE) {
      groups.push(buffer)
      buffer = ''
    }
  })

  if (buffer) {
    if (PUNCTUATION_PATTERN.test(buffer) && groups.length > 0) {
      groups[groups.length - 1] += buffer
    } else {
      groups.push(buffer)
    }
  }

  return groups.filter(Boolean)
}

function normalizeLatinSpacing(text) {
  return text.replace(/\s+/g, ' ').trim()
}

function hasJapaneseChars(text) {
  return JAPANESE_CHAR_PATTERN.test(text)
}

function splitJapaneseRun(text, maxLength = 2) {
  const glyphs = Array.from(text)
  if (glyphs.length <= maxLength) {
    return [text]
  }

  const result = []
  for (let i = 0; i < glyphs.length; i += maxLength) {
    result.push(glyphs.slice(i, i + maxLength).join(''))
  }
  return result
}

function mergeJapaneseParticles(segments) {
  return segments.reduce((result, segment) => {
    if (!segment) {
      return result
    }

    if (
      result.length > 0 &&
      JAPANESE_PARTICLE_PATTERN.test(segment) &&
      Array.from(result[result.length - 1]).length < MAX_CJK_SEGMENT_LENGTH
    ) {
      result[result.length - 1] += segment
      return result
    }

    result.push(segment)
    return result
  }, [])
}

function segmentJapaneseToken(text) {
  const glyphs = Array.from(text)
  if (glyphs.length <= 1) {
    return [text]
  }

  const segments = []
  let buffer = ''
  let bufferType = ''

  const flushBuffer = () => {
    if (!buffer) {
      return
    }

    if (bufferType === 'katakana') {
      segments.push(...splitJapaneseRun(buffer, 2))
    } else if (bufferType === 'hiragana') {
      segments.push(...splitJapaneseRun(buffer, 2))
    } else if (bufferType === 'kanji') {
      segments.push(...splitJapaneseRun(buffer, 2))
    } else {
      segments.push(buffer)
    }

    buffer = ''
    bufferType = ''
  }

  glyphs.forEach((glyph) => {
    if (NON_SEGMENTABLE_PATTERN.test(glyph)) {
      flushBuffer()
      segments.push(glyph)
      return
    }

    if (KATAKANA_PATTERN.test(glyph)) {
      if (bufferType !== 'katakana') {
        flushBuffer()
      }
      buffer += glyph
      bufferType = 'katakana'
      return
    }

    if (HIRAGANA_PATTERN.test(glyph)) {
      if (bufferType === 'kanji') {
        buffer += glyph
        return
      }
      if (bufferType !== 'hiragana') {
        flushBuffer()
      }
      buffer += glyph
      bufferType = 'hiragana'
      return
    }

    if (hasJapaneseChars(glyph) || /[一-龯々]/.test(glyph)) {
      if (bufferType && bufferType !== 'kanji') {
        flushBuffer()
      }
      buffer += glyph
      bufferType = 'kanji'
      return
    }

    flushBuffer()
    segments.push(glyph)
  })

  flushBuffer()
  return mergeJapaneseParticles(segments.filter(Boolean))
}

function splitLongSegment(segment) {
  const text = String(segment || '')
  if (!text) {
    return []
  }

  if (NON_SEGMENTABLE_PATTERN.test(text)) {
    return [text]
  }

  const normalizedLatin = normalizeLatinSpacing(text)
  if (/^[A-Za-z0-9][A-Za-z0-9’’\-\s]*$/.test(normalizedLatin)) {
    return [normalizedLatin]
  }

  const glyphs = Array.from(text)
  if (glyphs.length <= MAX_CJK_SEGMENT_LENGTH) {
    return [text]
  }

  const result = []
  for (let i = 0; i < glyphs.length; i += MAX_CJK_SEGMENT_LENGTH) {
    result.push(glyphs.slice(i, i + MAX_CJK_SEGMENT_LENGTH).join(''))
  }
  return result
}

function tokenizeMixedText(text) {
  const tokens = []
  let lastIndex = 0

  const latinWordPattern = /[A-Za-z0-9]+(?:[A-Za-z0-9'’-]*[A-Za-z0-9]+)*/g
  text.replace(latinWordPattern, (match, offset) => {
    if (offset > lastIndex) {
      tokens.push(text.slice(lastIndex, offset))
    }
    tokens.push(match)
    lastIndex = offset + match.length
    return match
  })

  if (lastIndex < text.length) {
    tokens.push(text.slice(lastIndex))
  }

  return tokens.filter(Boolean)
}

function segmentCjkToken(text) {
  const engine = getSegmentit()
  if (!engine) {
    return fallbackChunkGlyphs(text)
  }

  try {
    const result = engine.doSegment(text, {
      simple: true,
      stripPunctuation: false
    })

    return result
      .map((part) => String(part || '').trim())
      .filter(Boolean)
  } catch {
    return fallbackChunkGlyphs(text)
  }
}

function segmentLyricText(text) {
  return tokenizeMixedText(text).flatMap((token) => {
    if (NON_SEGMENTABLE_PATTERN.test(token)) {
      return [token]
    }

    if (LATIN_TOKEN_PATTERN.test(token)) {
      return [normalizeLatinSpacing(token)]
    }

    if (hasJapaneseChars(token)) {
      return segmentJapaneseToken(token)
    }

    return segmentCjkToken(token)
  })
}

function mergePunctuationSegments(segments) {
  return segments.reduce((result, segment) => {
    if (!segment) {
      return result
    }

    if (result.length === 0) {
      result.push(segment)
      return result
    }

    if (NON_SEGMENTABLE_PATTERN.test(segment)) {
      result[result.length - 1] += segment
      return result
    }

    result.push(segment)
    return result
  }, [])
}

function limitRevealSteps(groups) {
  if (groups.length <= MAX_REVEAL_STEPS) {
    return groups
  }

  const merged = []
  const mergeSize = Math.ceil(groups.length / MAX_REVEAL_STEPS)
  for (let i = 0; i < groups.length; i += mergeSize) {
    merged.push(groups.slice(i, i + mergeSize).join(''))
  }
  return merged
}

function chunkGlyphs(text) {
  const glyphs = Array.from(text)
  if (glyphs.length <= PER_CHAR_REVEAL_LIMIT) {
    return glyphs.map(glyph => glyph)
  }

  const segmented = segmentLyricText(text)
  const groups = mergePunctuationSegments(segmented.flatMap(splitLongSegment).filter(Boolean))

  if (groups.length === 0) {
    return limitRevealSteps(fallbackChunkGlyphs(text))
  }

  return limitRevealSteps(groups)
}

export function createLocalTextAliveVideo(lines = [], durationSeconds = 0) {
  const normalized = Array.isArray(lines)
    ? lines.filter(line => line && typeof line.text === 'string' && line.text.trim())
    : []

  const chars = []

  normalized.forEach((line, index) => {
    const text = line.text
    const lineStartMs = Math.max((Number(line.time) || 0) * 1000, 0)
    const nextTimeSeconds = normalized[index + 1]?.time
    const nextStartMs = typeof nextTimeSeconds === 'number' ? nextTimeSeconds * 1000 : null
    const lineDurationMs = getLineDurationMs({
      text,
      startMs: lineStartMs,
      nextStartMs,
      durationSeconds
    })
    const lineEndMs = lineStartMs + lineDurationMs

    const groups = chunkGlyphs(text)
    const stepDuration = Math.max(lineDurationMs / Math.max(groups.length, 1), MIN_CHAR_DURATION_MS)

    groups.forEach((group, groupIndex) => {
      const startTime = lineStartMs + stepDuration * groupIndex
      const endTime = groupIndex === groups.length - 1
        ? lineEndMs
        : Math.min(lineStartMs + stepDuration * (groupIndex + 1), lineEndMs)
      const node = createCharNode(
        typeof group === 'string' ? group : group.text,
        startTime,
        endTime
      )
      chars.push(node)
    })
  })

  for (let i = 0; i < chars.length - 1; i += 1) {
    chars[i].next = chars[i + 1]
  }

  return {
    firstChar: chars[0] || null,
    chars
  }
}

export function createLocalTextAliveLyrics(lines = [], durationSeconds = 0) {
  const video = createLocalTextAliveVideo(lines, durationSeconds)
  const lyrics = []
  let current = video.firstChar

  while (current) {
    lyrics.push(new Lyric(current))
    current = current.next
  }

  return {
    video,
    lyrics
  }
}

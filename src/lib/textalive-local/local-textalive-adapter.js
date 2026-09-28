import { Lyric } from './lyric.js'

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
// 标点/符号类字符集：歌词常见的 ASCII 撇号/连字符、日式括号「」、
// 中点・、音符记号等都要并入前组而非独立成 reveal 步
// 注意：'-' 必须放字符类末尾——夹在中间会形成范围（如 "-– 覆盖全部 ASCII）
const PUNCT_CHARS = '，。、“”‘’？！；：,.!?;:、】【（）()《》〈〉…—\\s\'"‐‑―–「」『』・~～〜．·♪♥★☆♡♢-'
const PUNCTUATION_PATTERN = new RegExp(`[${PUNCT_CHARS}]`)
// 拉丁 token 用 Script=Latin + 数字判定：café/naïve 等带符拉丁词不再被劈开
const LATIN_CHARS = '\\p{Script=Latin}\\p{Nd}'
const LATIN_TOKEN_PATTERN = new RegExp(`^[${LATIN_CHARS}]+(?:[${LATIN_CHARS}'’-]*[${LATIN_CHARS}]+)*$`, 'u')
const LATIN_TOKEN_SCAN = new RegExp(`[${LATIN_CHARS}]+(?:[${LATIN_CHARS}'’-]*[${LATIN_CHARS}]+)*`, 'gu')
const LATIN_TEXT_PATTERN = new RegExp(`^[${LATIN_CHARS}][${LATIN_CHARS}’'\\-\\s]*$`, 'u')
const LATIN_GROUP_PATTERN = new RegExp(`[${LATIN_CHARS}]`, 'u')
const JAPANESE_CHAR_PATTERN = /[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9f々〆〤]/
const HIRAGANA_PATTERN = /[\u3040-\u309f]/
const KATAKANA_PATTERN = /[\u30a0-\u30ff\u31f0-\u31ff\uff66-\uff9f]/
const JAPANESE_PARTICLE_PATTERN = /^(は|が|を|に|へ|で|と|や|も|の|ね|よ|か|な|さ|ぞ|ぜ|わ|し|て|で|た|だ|ら|り|る|れ|ろ|う|ん|ゃ|ゅ|ょ)$/
const NON_SEGMENTABLE_PATTERN = new RegExp(`^[${PUNCT_CHARS}]+$`)

// 原生 Intl.Segmenter（ICU 词库级中日文分词，零依赖）取代 segmentit——
// 15MB 词典包 + 懒加载机器都省掉；不支持的旧浏览器（FF<125）回退按字切
let wordSegmenter = null
let wordSegmenterTried = false

function getWordSegmenter() {
  if (wordSegmenterTried) {
    return wordSegmenter
  }
  wordSegmenterTried = true
  try {
    wordSegmenter = typeof Intl?.Segmenter === 'function'
      ? new Intl.Segmenter('zh', { granularity: 'word' })
      : null
    // 引擎缺 zh 词典时不抛错而是静默回落默认 locale（≈逐字切）——
    // resolvedOptions 验明正身，没生效就当不可用走 fallback
    if (wordSegmenter && !wordSegmenter.resolvedOptions().locale.startsWith('zh')) {
      wordSegmenter = null
    }
  } catch {
    wordSegmenter = null
  }
  return wordSegmenter
}

// grapheme 粒度切分：emoji ZWJ/keycap 序列（👨‍👩‍👧、1️⃣）按码点切会劈碎成 tofu
let graphemeSegmenter = null
let graphemeSegmenterTried = false

function splitGraphemes(text) {
  if (!graphemeSegmenterTried) {
    graphemeSegmenterTried = true
    try {
      graphemeSegmenter = typeof Intl?.Segmenter === 'function'
        ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
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

function createCharNode(text, startTime, endTime, lineId, lineLength) {
  return {
    text,
    startTime,
    endTime,
    duration: Math.max(endTime - startTime, 1),
    lineId,
    lineLength,
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

// 超长拉丁段按空格分组到 MAX_LATIN_SEGMENT_LENGTH 内，避免整句一次性点亮；
// 单个单词超过限制时保留整词（词中截断会破坏可读性）
function splitLatinSegment(text) {
  if (text.length <= MAX_LATIN_SEGMENT_LENGTH) {
    return [text]
  }

  const chunks = []
  let buffer = ''
  for (const word of text.split(' ')) {
    if (buffer && `${buffer} ${word}`.length > MAX_LATIN_SEGMENT_LENGTH) {
      // 边界空格挂到前一段：否则分段后 chunks.join('') 丢空格，渲染出连写词
      chunks.push(buffer + ' ')
      buffer = word
    } else {
      buffer = buffer ? `${buffer} ${word}` : word
    }
  }
  if (buffer) {
    chunks.push(buffer)
  }
  return chunks
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
  if (LATIN_TEXT_PATTERN.test(normalizedLatin)) {
    return splitLatinSegment(normalizedLatin)
  }

  // grapheme 切分：emoji 组合序列（👨‍👩‍👧 5 码点、1️⃣ 3 码点）不能被码点上限劈碎
  const glyphs = splitGraphemes(text)
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

  text.replace(LATIN_TOKEN_SCAN, (match, offset) => {
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
  const engine = getWordSegmenter()
  if (!engine) {
    return fallbackChunkGlyphs(text)
  }

  try {
    // 标点/空白段保留（isWordLike=false 不过滤）——下游
    // mergePunctuationSegments 负责把它们并入前一词
    return [...engine.segment(text)]
      .map(part => part.segment.trim())
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

// 无任何文字/数字/emoji 的段（孤儿组合符如 keycap 尾缀 ️⃣、杂散记号）
// 独立成组会渲染成豆腐块——与标点同处理并入前组
const WORDLIKE_PATTERN = /[\p{L}\p{N}\p{Extended_Pictographic}]/u

function mergePunctuationSegments(segments) {
  const result = []
  // 行首标点暂存并入下一组（"「你好」" 的「不该独占一个 reveal 步）；
  // 行尾全是标点时兜底自成一组
  let pending = ''

  for (const segment of segments) {
    if (!segment) {
      continue
    }

    if (NON_SEGMENTABLE_PATTERN.test(segment) || !WORDLIKE_PATTERN.test(segment)) {
      if (result.length) {
        result[result.length - 1] += segment
      } else {
        pending += segment
      }
      continue
    }

    result.push(pending + segment)
    pending = ''
  }

  if (pending) {
    result.push(pending)
  }
  return result
}

// 归并只在同文种内进行：拉丁词与 CJK 直接 join 会产生 "you我的" 这种
// 无空格粘连，先把分组切成同文种 run，再在 run 内按步数上限归并
const isLatinGroup = (group) => LATIN_GROUP_PATTERN.test(group)

function limitRevealSteps(groups) {
  if (groups.length <= MAX_REVEAL_STEPS) {
    return groups
  }

  const runs = []
  for (const group of groups) {
    const last = runs[runs.length - 1]
    if (last && isLatinGroup(last[0]) === isLatinGroup(group)) {
      last.push(group)
    } else {
      runs.push([group])
    }
  }

  const merged = []
  const mergeSize = Math.ceil(groups.length / MAX_REVEAL_STEPS)
  for (const run of runs) {
    for (let i = 0; i < run.length; i += mergeSize) {
      merged.push(run.slice(i, i + mergeSize).join(''))
    }
  }

  // 硬上限兜底：run 数过多（全交替混排）时 merged 仍可能超限，
  // 对同文种相邻组二次归并——宁可同文种组更粗也不跨文种粘连
  while (merged.length > MAX_REVEAL_STEPS) {
    const pairIndex = merged.findIndex(
      (group, i) => i + 1 < merged.length && isLatinGroup(group) === isLatinGroup(merged[i + 1])
    )
    if (pairIndex === -1) break
    merged.splice(pairIndex, 2, merged[pairIndex] + merged[pairIndex + 1])
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

// null/''/false 会被 Number() 静默当成 0 → 缺时间戳的行漏进 0:00 遮挡首句；
// 先按类型收窄再校验有限性（数字字符串如 '12.5' 仍兼容）
const isValidLineTime = (time) =>
  typeof time === 'number'
    ? Number.isFinite(time)
    : typeof time === 'string' && time.trim() !== '' && Number.isFinite(Number(time))

export function createLocalTextAliveVideo(lines = [], durationSeconds = 0) {
  const normalized = Array.isArray(lines)
    ? lines.filter(line =>
      line &&
      typeof line.text === 'string' &&
      line.text.trim() &&
      // 时间戳无效（NaN/Infinity/缺失）的行无法定位，显示在 0:00 只会遮挡首句
      isValidLineTime(line.time))
    : []

  // 画布按时间单调递增做增量扫描，乱序输入会卡死激活索引；
  // 排序基准必须与 lineStartMs 一致（负数时间同样 clamp 到 0）
  const lineStartOf = (line) => Math.max(Number(line.time) * 1000, 0)
  normalized.sort((a, b) => lineStartOf(a) - lineStartOf(b))

  const chars = []

  normalized.forEach((line, index) => {
    const text = line.text.trim()
    const lineStartMs = lineStartOf(line)
    // 下一行起点同样走 lineStartOf，保证与排序键/负值 clamp 语义一致
    const nextStartMs = index + 1 < normalized.length ? lineStartOf(normalized[index + 1]) : null
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
      // stepDuration 有 140ms 地板，组数过多时末组 startTime 会越过 lineEndMs
      // 生成永不渲染的退化块——钳在行内保证时序单调
      const startTime = Math.min(lineStartMs + stepDuration * groupIndex, lineEndMs - 1)
      const endTime = groupIndex === groups.length - 1
        ? lineEndMs
        : Math.min(lineStartMs + stepDuration * (groupIndex + 1), lineEndMs)
      const node = createCharNode(
        group,
        startTime,
        endTime,
        // 行标识 + 行总长：画布按行标识把同一句词块沿同一方向链式排布，
        // 行总长用于锚点反推——长句以焦点为中心展开而非单向探出屏幕
        index,
        Array.from(text).length
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

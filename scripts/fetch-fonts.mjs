#!/usr/bin/env node
// scripts/fetch-fonts.mjs — Google Fonts 本地化抓取（U4 / 方案 B-assets）
//
// 管线：css2 API（Chrome UA）→ 逐 @font-face 解析 family/style/weight/
//   unicode-range/src → 下载 woff2 到
//   src/fonts/<family-slug>-<wght>-<sliceIdx>-<sha8>.woff2
//   （sha8 = 内容 sha256 前 8 hex；sliceIdx = 该族第几个唯一文件，按 css 首现序）
//   → 生成 src/fonts/fonts.css + fonts.lock.json + LICENSE/<family>.txt
//
// 幂等：fonts.lock.json 记录「gstatic src URL → 本地文件名」映射；映射命中且
//   文件在盘即跳过下载（woff2 URL 本身内容寻址，同 URL 即同字节）。fonts.css
//   头注「快照」= 抓取日期(UTC) + css2 体 sha256——同日重跑产物逐字节一致，
//   上游 css 一变 hash 即变（Last-Modified 头逐请求漂移，不可作快照凭据）。
//
// 事实备注：四族在 gstatic 均为可变字体单文件——不同 weight 的 @font-face
//   共享同一 woff2 URL（全 css 241 面 ↔ 117 唯一文件）；文件名取自首个
//   引用面的 family/weight，不意味该文件仅服务此 weight。
//
// fonts.css 头注刻意不写完整 googleapis URL：tests/fonts.test.mjs 钉死该文件
//   不得含 googleapis/gstatic 字面量；完整来源 URL 存于 fonts.lock.json 及
//   本脚本 CSS_URL 常量。
//
// 用法：node scripts/fetch-fonts.mjs

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const CSS_URL =
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@300;500&family=Space+Grotesk:wght@500;700&family=Noto+Sans+SC:wght@400;700&display=swap'

// 许可文本源：google/fonts 仓各 family 目录下的官方 OFL.txt（四族全 OFL-1.1）
const LICENSE_BASE = 'https://raw.githubusercontent.com/google/fonts/main/'
const LICENSE_PATHS = {
  Inter: 'ofl/inter/OFL.txt',
  'JetBrains Mono': 'ofl/jetbrainsmono/OFL.txt',
  'Space Grotesk': 'ofl/spacegrotesk/OFL.txt',
  'Noto Sans SC': 'ofl/notosanssc/OFL.txt',
}

const FONTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../src/fonts')
const CSS_OUT = join(FONTS_DIR, 'fonts.css')
const LOCK_FILE = join(FONTS_DIR, 'fonts.lock.json')
const CONCURRENCY = 8
const TIMEOUT_MS = 30_000

const slugify = (family) => family.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

async function getBuffer(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': CHROME_UA },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

async function getCss(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': CHROME_UA },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`)
  return { text: await res.text(), lastModified: res.headers.get('last-modified') }
}

// 逐 @font-face 解析；紧贴块前的 /* subset */ 注释一并带出（latin 族有、CJK 无）
function parseFaces(css) {
  const faces = []
  const re = /(?:\/\*\s*([^*]+?)\s*\*\/\s*)?@font-face\s*\{([^}]*)\}/g
  for (const m of css.matchAll(re)) {
    const body = m[2]
    const pick = (r) => (body.match(r) || [])[1]
    const family = pick(/font-family:\s*'([^']+)'/)
    const style = pick(/font-style:\s*([^;\s]+)/)
    const weight = pick(/font-weight:\s*(\d+)/)
    const src = pick(/src:\s*url\((https:[^)]+?)\)\s*format\('woff2'\)/)
    const unicodeRange = pick(/unicode-range:\s*([^;]+);/)
    if (!family || !weight || !src) {
      throw new Error(`@font-face 解析失败（缺 family/weight/src）：${body.slice(0, 120)}…`)
    }
    faces.push({
      comment: m[1] ?? null,
      family,
      style: style ?? 'normal',
      weight,
      src,
      unicodeRange: unicodeRange?.trim() ?? null,
    })
  }
  return faces
}

// 小并发池：queue 为 [srcUrl] 唯一集，worker 逐条取
async function downloadAll(queue, resolveOne) {
  const errors = []
  let next = 0
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (next < queue.length) {
      const item = queue[next++]
      try {
        await resolveOne(item)
      } catch (e) {
        errors.push(e)
      }
    }
  })
  await Promise.all(workers)
  if (errors.length) throw errors[0]
}

async function main() {
  mkdirSync(join(FONTS_DIR, 'LICENSE'), { recursive: true })

  const { text: css, lastModified } = await getCss(CSS_URL)
  const faces = parseFaces(css)
  if (!faces.length) throw new Error('css2 响应中未解析到任何 @font-face')
  console.log(`css2 快照 ${lastModified ?? '(no last-modified)'} — ${faces.length} 个 @font-face`)

  // 唯一 URL 集（首现序）+ 每族 sliceIdx 计数；共享 URL 的非首个面
  // 沿用首个面的 sliceIdx（即其所引用文件的序号）
  const lock = existsSync(LOCK_FILE) ? JSON.parse(readFileSync(LOCK_FILE, 'utf8')) : { files: {} }
  const urlToFile = { ...lock.files }
  const sliceCounter = {}
  const uniqueUrls = []
  const firstFace = {}
  for (const f of faces) {
    if (!firstFace[f.src]) {
      firstFace[f.src] = f
      const slug = slugify(f.family)
      f.fileIdx = sliceCounter[slug] ?? 0
      sliceCounter[slug] = f.fileIdx + 1
      uniqueUrls.push(f.src)
    }
    f.sliceIdx = firstFace[f.src].fileIdx
  }
  console.log(`唯一 woff2：${uniqueUrls.length}`)

  // 下载：lockfile 命中且在盘 → 跳过；否则抓、hash、落盘
  let fetched = 0
  let cached = 0
  await downloadAll(uniqueUrls, async (src) => {
    const prev = urlToFile[src]
    if (prev && existsSync(join(FONTS_DIR, prev))) {
      cached++
      return
    }
    const buf = await getBuffer(src)
    if (buf.length < 4 || buf.toString('latin1', 0, 4) !== 'wOF2') {
      throw new Error(`${src} 非 woff2 魔数（${buf.length}B）`)
    }
    const sha8 = createHash('sha256').update(buf).digest('hex').slice(0, 8)
    const f = firstFace[src]
    const name = `${slugify(f.family)}-${f.weight}-${f.sliceIdx}-${sha8}.woff2`
    writeFileSync(join(FONTS_DIR, name), buf)
    urlToFile[src] = name
    fetched++
  })
  console.log(`下载 ${fetched} / 复用 ${cached}`)

  // fonts.css：保持源 css 面序（unicode-range 交叠时后者优先语义不变）。
  // 头注「快照」= css2 响应体 sha256（内容寻址，跨日重跑同 css 即同产物）+
  // 抓取日期（UTC，日粒度）；不写响应 Last-Modified——gstatic 该头逐请求漂移
  const cssHash = createHash('sha256').update(css).digest('hex').slice(0, 12)
  const fetchDate = new Date().toISOString().slice(0, 10)
  const header = [
    '/* ═══════════════════════════════════════════════════════════════',
    '   Google Fonts 自托管表 —— 由 scripts/fetch-fonts.mjs 生成，勿手改',
    `   来源: Google Fonts css2 API · ${CSS_URL.split('?')[1]}`,
    `   快照: ${fetchDate} · css2 sha256:${cssHash} · UA: Chrome/126 (macOS)`,
    '   完整来源 URL 见 fonts.lock.json · 许可文本见 LICENSE/（四族全 OFL-1.1）',
    '   ═══════════════════════════════════════════════════════════════ */',
    '',
  ].join('\n')
  const blocks = faces.map((f) => {
    const lines = []
    lines.push(`/* ${f.comment ?? `${slugify(f.family)} 切片 #${f.sliceIdx}`} */`)
    lines.push('@font-face {')
    lines.push(`  font-family: '${f.family}';`)
    lines.push(`  font-style: ${f.style};`)
    lines.push(`  font-weight: ${f.weight};`)
    lines.push('  font-display: swap;')
    lines.push(`  src: url('./${urlToFile[f.src]}') format('woff2');`)
    if (f.unicodeRange) lines.push(`  unicode-range: ${f.unicodeRange};`)
    lines.push('}')
    return lines.join('\n')
  })
  writeFileSync(CSS_OUT, header + blocks.join('\n\n') + '\n')

  // lockfile：键序 = css 首现序，重跑字节一致
  const ordered = { version: 1, source: CSS_URL, files: {} }
  for (const src of uniqueUrls) ordered.files[src] = urlToFile[src]
  writeFileSync(LOCK_FILE, JSON.stringify(ordered, null, 2) + '\n')

  // GC：清掉本族命名模式但不再被引用的旧 hash 文件（Fusion Pixel 等不在模式内）
  const keep = new Set(Object.values(ordered.files))
  const familyRe = new RegExp(`^(${Object.keys(LICENSE_PATHS).map(slugify).join('|')})-\\d+-\\d+-[0-9a-f]{8}\\.woff2$`)
  for (const name of readdirSync(FONTS_DIR)) {
    if (familyRe.test(name) && !keep.has(name)) {
      unlinkSync(join(FONTS_DIR, name))
      console.log(`清理过期文件 ${name}`)
    }
  }

  // 许可文本：已落盘（含已提交进仓）即跳过——离线重跑不依赖 GitHub
  for (const [family, rel] of Object.entries(LICENSE_PATHS)) {
    const out = join(FONTS_DIR, 'LICENSE', `${slugify(family)}.txt`)
    if (existsSync(out)) continue
    const buf = await getBuffer(LICENSE_BASE + rel)
    writeFileSync(out, buf.toString('utf8').replace(/\r\n/g, '\n'))
    console.log(`许可写入 LICENSE/${slugify(family)}.txt`)
  }

  // 汇总
  const files = [...keep]
  const total = files.reduce((s, n) => s + readFileSync(join(FONTS_DIR, n)).length, 0)
  console.log(`完成：${files.length} 个 woff2，共 ${(total / 1024 / 1024).toFixed(2)} MB`)
}

main().catch((e) => {
  console.error(`fetch-fonts 失败：${e.message}`)
  process.exit(1)
})

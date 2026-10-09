import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 钉：U4 字体本地化（方案 B-assets）。页面链路与字族表一律同源资产——
// index.html 与 src 客户端面（全部 vue/js/css）不得再出现 googleapis/gstatic
// 字面量；fonts.css 引用的每个 url() woff2 必须真实落盘（漏文件=生产静默缺
// 字重）；四族七 weight 覆盖与 css2 原请求一致；每个 @font-face 带
// unicode-range（缺它则浏览器退化为全量下载，切片惰性加载机制作废）。
//
// 字面量扫描豁免（合法含域名的位置，按面排除而非放宽断言）：
// - src/server/ 整棵——服务端出站白名单与 CSP 注释合法点名这些域
//   （yt-proxy.js 的 youtubei.googleapis.com、secure-headers.js 移除注记），
//   且该目录不进客户端 bundle，不产生浏览器被动子资源请求；
// - src/fonts/fonts.lock.json——fetch-fonts 幂等键数据文件合法含 gstatic URL
//   （.json 本不在扩展面，显式列出防扫描面漂移误伤）；
// - scripts/ 不入面——fetch-fonts.mjs 的 css2 api 端点是合法来源。

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url))
const styleCss = read('../src/style.css')
const fontsCss = read('../src/fonts/fonts.css')

// index.html + src/**/*.vue|js|css（src/server 与 fonts.lock.json 按上注豁免）
function clientSurfaceFiles() {
  const files = ['index.html']
  const walk = (absDir, relDir) => {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const rel = `${relDir}/${entry.name}`
      if (entry.isDirectory()) {
        if (rel === 'src/server') continue
        walk(join(absDir, entry.name), rel)
      } else if (/\.(vue|js|css)$/.test(entry.name) && rel !== 'src/fonts/fonts.lock.json') {
        files.push(rel)
      }
    }
  }
  walk(SRC_DIR, 'src')
  return files
}

test('页面链路零 Google Fonts 外链字面量（index.html + src 客户端面全扫）', () => {
  const files = clientSurfaceFiles()
  assert.ok(files.length > 20, `扫描面异常收窄（仅 ${files.length} 个文件）`)
  for (const rel of files) {
    assert.ok(!/googleapis|gstatic/.test(read(`../${rel}`)), `${rel} 不得含 googleapis/gstatic`)
  }
})

test('style.css 首行引入本地字族表', () => {
  assert.match(styleCss, /^@import\s+'\.\/fonts\/fonts\.css';/)
})

test('fonts.css 引用的 woff2 全部在盘', () => {
  const refs = [...fontsCss.matchAll(/url\('\.\/([^']+)'\)\s*format\('woff2'\)/g)].map((m) => m[1])
  assert.ok(refs.length > 0, 'fonts.css 未解析到任何 woff2 引用')
  const missing = [...new Set(refs)].filter(
    (f) => !existsSync(new URL(`../src/fonts/${f}`, import.meta.url))
  )
  assert.deepEqual(missing, [])
})

const FAMILY_WEIGHTS = {
  Inter: [400, 500, 600],
  'JetBrains Mono': [300, 500],
  'Space Grotesk': [500, 700],
  'Noto Sans SC': [400, 700],
}

test('@font-face 覆盖四族七 weight 且 unicode-range 非空', () => {
  const bodies = [...fontsCss.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1])
  for (const [family, weights] of Object.entries(FAMILY_WEIGHTS)) {
    for (const w of weights) {
      const hit = bodies.some(
        (b) =>
          new RegExp(`font-family:\\s*'${family}'`).test(b) &&
          new RegExp(`font-weight:\\s*${w}\\s*;`).test(b)
      )
      assert.ok(hit, `${family} w${w} 缺 @font-face`)
    }
  }
  for (const b of bodies) {
    assert.match(b, /unicode-range:\s*U\+[0-9a-f]/i, '存在缺 unicode-range 的 @font-face')
  }
})

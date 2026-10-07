// vite.config.js 构建期 define 钉死回归：
//   F4  shell/.env 残留的 NODE_ENV=development 会把 Vue dev 警告烘进
//       产物——build 命令必须把 process.env.NODE_ENV 一并钳到 production
//   L   __APP_VERSION__/__BUILD_TIME__ 全仓无消费方已删（SettingsPanel 无
//       关于区）——别留悬置 define，需要版本展示时在接入点重挂
// 放 node:test 而非 vitest：import 'vite' 会拉起 esbuild——其自检
// （TextEncoder/Uint8Array invariant）在 jsdom 环境下必炸
import { test } from 'node:test'
import assert from 'node:assert/strict'
import configFactory from '../vite.config.js'

const build = (command, mode = 'production') =>
  typeof configFactory === 'function' ? configFactory({ command, mode }) : configFactory

test('build：process.env.NODE_ENV 钉死 production，PROD/DEV 同钳', async () => {
  const cfg = await build('build')
  assert.equal(cfg.define['process.env.NODE_ENV'], JSON.stringify('production'))
  assert.equal(cfg.define['import.meta.env.PROD'], 'true')
  assert.equal(cfg.define['import.meta.env.DEV'], 'false')
})

test('serve：不钳 NODE_ENV/PROD/DEV——dev server 保持开发态', async () => {
  const cfg = await build('serve', 'development')
  assert.equal(cfg.define['process.env.NODE_ENV'], undefined)
  assert.equal(cfg.define['import.meta.env.PROD'], undefined)
})

test('无悬置版本 define——接入点缺席不白占', async () => {
  const cfg = await build('build')
  assert.equal(cfg.define['__APP_VERSION__'], undefined)
  assert.equal(cfg.define['__BUILD_TIME__'], undefined)
})

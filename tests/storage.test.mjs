// lib/storage.js readJSON 脏值告警后清除回归——不清则每次读取重复 warn
// 且坏数据永久占位。node:test 环境无 localStorage，与 tests/ui/setup.mjs
// 同款内存 Storage 顶替（须在 storage.js 首次使用前装好——其 API 调用期
// 才触 globalThis.localStorage，import 时机不敏感）
import { test } from 'node:test'
import assert from 'node:assert/strict'

class MemoryStorage {
  #map = new Map()
  get length() { return this.#map.size }
  key(i) { return [...this.#map.keys()][i] ?? null }
  getItem(k) { const v = this.#map.get(String(k)); return v === undefined ? null : v }
  setItem(k, v) { this.#map.set(String(k), String(v)) }
  removeItem(k) { this.#map.delete(String(k)) }
  clear() { this.#map.clear() }
}

Object.defineProperty(globalThis, 'localStorage', {
  value: new MemoryStorage(),
  configurable: true,
  writable: true,
})

const { readJSON, writeJSON } = await import('../src/lib/storage.js')

test('readJSON：正常 JSON 读出，缺席回 fallback', () => {
  localStorage.clear()
  assert.equal(readJSON('k_absent', 'fb'), 'fb')
  writeJSON('k1', { a: 1 })
  assert.deepEqual(readJSON('k1'), { a: 1 })
})

test('readJSON：脏值告警后清除——重读不再重复 warn、不再留坏数据', (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  localStorage.clear()
  localStorage.setItem('k_dirty', '{bad json')
  assert.equal(readJSON('k_dirty', 'fb'), 'fb')   // 首读：warn + 回退
  assert.equal(warn.mock.callCount(), 1)
  assert.equal(localStorage.getItem('k_dirty'), null) // 脏值已清
  assert.equal(readJSON('k_dirty', 'fb'), 'fb')   // 重读：直接 fallback
  assert.equal(warn.mock.callCount(), 1)          // 不重复告警
})

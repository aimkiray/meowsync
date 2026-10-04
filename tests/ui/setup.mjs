// vitest 环境补丁：Node ≥22 自带 localStorage 访问器（未配 --localstorage-file
// 时 getter 回 undefined），而 vitest 0.34 的 jsdom 环境同样不给 window
// .localStorage 供值——src 代码走裸 localStorage 会静默落空。装内存 Storage
// 顶替（与 Web Storage API 同形，各用例间自行 clear）
class MemoryStorage {
  #map = new Map()
  get length() { return this.#map.size }
  key(i) { return [...this.#map.keys()][i] ?? null }
  getItem(k) { const v = this.#map.get(String(k)); return v === undefined ? null : v }
  setItem(k, v) { this.#map.set(String(k), String(v)) }
  removeItem(k) { this.#map.delete(String(k)) }
  clear() { this.#map.clear() }
}

const storage = new MemoryStorage()
Object.defineProperty(globalThis, 'localStorage', {
  value: storage,
  configurable: true,
  writable: true,
})
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  })
}

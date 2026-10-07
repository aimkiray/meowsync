// http.js 令牌注入守卫与 params 展开闸回归：
//   F2  token 只发根相对 URL——协议相对 '//evil.com/x' 会被 axios 当绝对
//       地址直飞，旧的 /^https?:/i 负判定拦不住，令牌随之裸泄
//   L   config.params 非 plain object（URLSearchParams/FormData）展开即丢参
//       ——URLSearchParams 走 append，plain object 展开合 _t
//   L   apiErrorMessage 三级兜底到非空串
// VITE_DOWNLOAD_TOKEN 是模块求值期捕获的常量——必须 stubEnv 后动态 import
import { describe, it, expect, vi } from 'vitest'

const { interceptors } = vi.hoisted(() => {
  const interceptors = { req: [], res: [] }
  return { interceptors }
})
vi.mock('axios', () => ({
  default: {
    create: () => ({
      interceptors: {
        request: { use: (f, e) => interceptors.req.push([f, e]) },
        response: { use: (f, e) => interceptors.res.push([f, e]) },
      },
    }),
  },
}))

vi.stubEnv('VITE_DOWNLOAD_TOKEN', 'test-token-abc')

const { apiErrorMessage } = await import('../../src/api/http.js')
const [reqFn] = interceptors.req[0]
const run = (cfg) => reqFn({ headers: {}, ...cfg })

describe('http.js 令牌注入守卫', () => {
  it('根相对路径注入 x-download-token', () => {
    const cfg = run({ url: '/downloads/queues' })
    expect(cfg.headers['x-download-token']).toBe('test-token-abc')
  })

  it('协议相对 //host 不注入——F2 回归：令牌不外泄给异源', () => {
    const cfg = run({ url: '//evil.com/x' })
    expect(cfg.headers['x-download-token']).toBeUndefined()
  })

  it('绝对 https?:// URL 不注入', () => {
    for (const url of ['https://api.example.com/x', 'http://api.example.com/x']) {
      expect(run({ url }).headers['x-download-token']).toBeUndefined()
    }
  })

  it('无前导斜杠的相对路径不注入（fail-safe 收窄）', () => {
    expect(run({ url: 'downloads/queues' }).headers['x-download-token']).toBeUndefined()
  })

  it('url 缺席不注入，_t 防缓存参数照加', () => {
    const cfg = run({})
    expect(cfg.headers['x-download-token']).toBeUndefined()
    expect(typeof cfg.params._t).toBe('number')
  })
})

describe('http.js params 展开闸', () => {
  it('plain object params：展开合 _t 且不污染调用方对象', () => {
    const src = { a: 1 }
    const cfg = run({ url: '/x', params: src })
    expect(src._t).toBeUndefined()
    expect(cfg.params.a).toBe(1)
    expect(typeof cfg.params._t).toBe('number')
  })

  it('URLSearchParams：append _t 而非展开销毁——原参数不丢', () => {
    const cfg = run({ url: '/x', params: new URLSearchParams('a=1&b=2') })
    expect(cfg.params.get('a')).toBe('1')
    expect(cfg.params.get('b')).toBe('2')
    expect(cfg.params.get('_t')).toBeTruthy()
  })
})

describe('apiErrorMessage：三级兜底', () => {
  it('response.data.message > error.message > 未知错误', () => {
    expect(apiErrorMessage({ response: { data: { message: '服务端原因' } } })).toBe('服务端原因')
    expect(apiErrorMessage(new Error('裸错'))).toBe('裸错')
    expect(apiErrorMessage({})).toBe('未知错误')
    expect(apiErrorMessage(null)).toBe('未知错误')
  })
})

// caps.js F5 回归：loadServerCaps 初载失败必须释闩（loaded=false），
// 后调用可重试——旧版 loaded=true 先行落闩，失败把闩咬死整会话，
// QQ 凭据态永久按无凭据保守（vip 曲被误隐）。loaded 闩是模块级状态，
// 各用例经 vi.resetModules + 动态 import 拿全新模块图隔离
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/api/music.js', () => ({
  musicApi: {
    getQqStatus: vi.fn(),
  },
  // qqLoggedIn 会话级 memo 复位口——refreshServerCaps 挂接（设置页存 Cookie
  // 后播放选腿不吃陈旧 false）；caps 用例只验挂接，memo 语义在 api-contract
  qqStatusReset: vi.fn(),
}))

// resetModules 后须连 api mock 一起重拿——vi.mock 工厂对新模块图重跑，
// 顶层 import 绑的还是旧图实例
const fresh = async () => {
  vi.resetModules()
  const { musicApi, qqStatusReset } = await import('../../src/api/music.js')
  const caps = await import('../../src/lib/caps.js')
  return { musicApi, caps, qqStatusReset }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('serverCaps：F5 初载失败释闩可重试', () => {
  it('首跳失败释闩：下次 load 重发请求并落真实凭据态', async () => {
    const { musicApi, caps } = await fresh()
    musicApi.getQqStatus
      .mockRejectedValueOnce(new Error('server down'))
      .mockResolvedValue({ loggedIn: true })

    await caps.loadServerCaps()
    // 失败保守默认——不把闩咬死，凭据态维持无凭据缺省
    expect(caps.serverCaps.value).toEqual({ qq: { loggedIn: false } })

    await caps.loadServerCaps() // 闩已释——真重试而非早退
    expect(musicApi.getQqStatus).toHaveBeenCalledTimes(2)
    expect(caps.serverCaps.value).toEqual({ qq: { loggedIn: true } })
  })

  it('成功落闩：重复 load 不重发（闩防的是重复拉）', async () => {
    const { musicApi, caps } = await fresh()
    musicApi.getQqStatus.mockResolvedValue({ loggedIn: true })
    await caps.loadServerCaps()
    await caps.loadServerCaps()
    expect(musicApi.getQqStatus).toHaveBeenCalledTimes(1)
    expect(caps.serverCaps.value).toEqual({ qq: { loggedIn: true } })
  })

  it('refreshServerCaps 换代重取：旧代失败不抢新代的闩', async () => {
    const { musicApi, caps } = await fresh()
    let releaseFirst
    musicApi.getQqStatus
      .mockImplementationOnce(
        () => new Promise((_, rej) => { releaseFirst = () => rej(new Error('first attempt down')) }))
      .mockResolvedValue({ loggedIn: true })
    const p1 = caps.loadServerCaps()
    const p2 = caps.refreshServerCaps() // 换代：capsSeq++ 释闩再拉
    releaseFirst()
    await Promise.all([p1, p2])
    // 旧代失败 seq 失配不动闩；新代凭据已落
    expect(musicApi.getQqStatus).toHaveBeenCalledTimes(2)
    expect(caps.serverCaps.value).toEqual({ qq: { loggedIn: true } })
  })

  it('首跳失败后再 refresh：闩已释 + 换代双通道都能恢复', async () => {
    const { musicApi, caps } = await fresh()
    musicApi.getQqStatus
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue({ loggedIn: true })
    await caps.loadServerCaps()
    await caps.refreshServerCaps()
    expect(musicApi.getQqStatus).toHaveBeenCalledTimes(2)
    expect(caps.serverCaps.value).toEqual({ qq: { loggedIn: true } })
  })

  it('refreshServerCaps 挂接 qqStatusReset：播放侧登录态 memo 一并清', async () => {
    const { musicApi, caps, qqStatusReset } = await fresh()
    musicApi.getQqStatus.mockResolvedValue({ loggedIn: true })
    // loadServerCaps 不复位（初载不是凭据变更）；refresh 才挂 reset——
    // 存完 Cookie 后 usePlayer 选腿/死腿文案/引导 toast 不再吃陈旧 false
    await caps.loadServerCaps()
    expect(qqStatusReset).not.toHaveBeenCalled()
    await caps.refreshServerCaps()
    expect(qqStatusReset).toHaveBeenCalledTimes(1)
    expect(musicApi.getQqStatus).toHaveBeenCalledTimes(2)
  })
})

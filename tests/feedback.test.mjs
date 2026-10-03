import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  toast, toastDismiss, toastHold, toastRelease, useFeedbackState
} from '../src/lib/feedback.js'

// toast 计时簿记状态机：hold/release 多源占用暂停续跑是 WCAG 2.2.1 的
// 承重语义（action toast 6s 对键盘 Tab 序不友好）——剩余时间用
// performance.now() 单调钟，mock 只接管 setTimeout，状态断言全真值。

const state = useFeedbackState()
const has = (id) => state.toasts.some(t => t.id === id)

test('toast：基础退场与 dismiss 簿记清理', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const id = toast('hello')
  assert.ok(has(id))
  t.mock.timers.tick(2600)
  assert.ok(!has(id))                 // 默认 2600ms 退场
  toastDismiss(id)                    // 二次 dismiss 幂等不炸
  assert.ok(!has(id))
})

test('toast：action 默认驻留翻倍到 6000ms', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const id = toast('x', 'info', null, { label: '查看', onAction: () => {} })
  t.mock.timers.tick(2600)
  assert.ok(has(id))                  // 非 action 早已退场，action 仍在
  t.mock.timers.tick(3400)
  assert.ok(!has(id))                 // 6000 到点退
})

test('toastHold/toastRelease：暂停不超时、释放后续跑', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const id = toast('x')
  toastHold(id, 'pointer:1')
  t.mock.timers.tick(99999)           // 暂停中永不超时
  assert.ok(has(id))
  toastRelease(id, 'pointer:1')       // 续跑——remaining≈全额（perf 真钟≈0 流逝）
  t.mock.timers.tick(2599)
  assert.ok(has(id))
  t.mock.timers.tick(2)
  assert.ok(!has(id))                 // 续跑到点退
})

test('toastHold/toastRelease：多源占用要全部释放才续跑', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const id = toast('x')
  toastHold(id, 'pointer:1')
  toastHold(id, 'focus')
  toastRelease(id, 'pointer:1')       // focus 还占着——不续跑
  t.mock.timers.tick(99999)
  assert.ok(has(id))
  toastRelease(id, 'focus')
  t.mock.timers.tick(2600)
  assert.ok(!has(id))
})

test('toastHold/toastRelease：多指针实例各自计源', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const id = toast('x')
  toastHold(id, 'pointer:1')          // 鼠标
  toastHold(id, 'pointer:2')          // 触控笔同时悬停
  toastRelease(id, 'pointer:1')       // 鼠标走了但触控笔还在
  t.mock.timers.tick(99999)
  assert.ok(has(id))                  // 源集未空不续跑（早期单一 'pointer' 源会漏）
  toastRelease(id, 'pointer:2')
  t.mock.timers.tick(2600)
  assert.ok(!has(id))
})

test('toastRelease：无对应 hold 的 release 无副作用', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const id = toast('x')
  toastRelease(id, 'focus')           // 从没 hold 过——不该重置计时
  t.mock.timers.tick(2600)
  assert.ok(!has(id))                 // 按原 2600ms 退，未被放生
})

test('toast：暂停中手动 dismiss 后迟到的 release 不误伤', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const id = toast('x', 'info', null, { label: '查看', onAction: () => {} })
  toastHold(id, 'focus')
  toastDismiss(id)                    // 动作点击路径：暂停态被手动回收
  assert.ok(!has(id))
  toastRelease(id, 'focus')           // 迟到的 release 撞已删记录——no-op
  assert.ok(!has(id))
  const id2 = toast('y')
  t.mock.timers.tick(2600)
  assert.ok(!has(id2))                // 后续 toast 计时簿记不受污染
})

test('toast：非数值 duration 退化取默认，簿记不产 NaN', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const id = toast('x', 'info', {})   // 传对象当毫秒——契约误用按默认收敛
  t.mock.timers.tick(2599)
  assert.ok(has(id))                  // NaN→0ms 即退的旧行为不再发生
  t.mock.timers.tick(2)
  assert.ok(!has(id))
})

test('toast：暂停冻结预算——release 后按剩余续跑而非即死（真钟验证）', async () => {
  const id = toast('x', 'info', 30)
  toastHold(id, 'focus')                    // 同步扣住——remaining 冻结在 ~30
  await new Promise(r => setTimeout(r, 60)) // 真钟流逝远超 30ms——暂停中不结算
  assert.ok(has(id))                        // 暂停保护成立（WCAG 2.2.1 语义本体）
  toastRelease(id, 'focus')
  assert.ok(has(id))                        // 冻结的剩余续跑，不即死
  await new Promise(r => setTimeout(r, 60)) // ~30ms 余量耗尽退场
  assert.ok(!has(id))
})

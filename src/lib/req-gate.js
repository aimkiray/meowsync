// 请求序号闸的显式对象化。
//
// 原形态是「模块内 let seq = 0」：认领 `++seq`、校验 `my !== seq`、
// 裸 `seq++` 作废他方在途。拆 composable 后各域不再共享同一闭包 let——
// 但跨域互作废语义必须保留（选歌单作废在途导入、导入作废在途选单），
// 所以闸要做成可注入的共享对象。
//
//   const gate = createReqGate()
//   const my = gate.claim()              // 认领本次请求
//   if (!gate.isCurrent(my)) return      // 过期丢弃
//   gate.invalidate()                    // 作废一切在途（含未认领的下一次）
export function createReqGate() {
  let seq = 0
  return {
    claim: () => ++seq,
    invalidate: () => { seq++ },
    isCurrent: (t) => t === seq,
    current: () => seq, // 不认领的快照——「期间有没有新认领」的比对基线
  }
}

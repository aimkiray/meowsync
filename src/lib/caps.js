import { ref } from 'vue'
import { musicApi } from '../api/music.js'

// 服务端能力投影（MA provider status 同思路）：持凭据的一侧算好布尔事实，
// 前端只消费不猜测。缺省=无凭据（保守方向——误判不可播好过展示死链）
export const serverCaps = ref({ qq: { loggedIn: false } })

let loaded = false
// 世代戳：初载与 refresh 并发时旧响应后着陆会把新凭据态盖回陈值
let capsSeq = 0
export async function loadServerCaps() {
  if (loaded) return
  loaded = true
  const seq = capsSeq
  try {
    const caps = { qq: await musicApi.getQqStatus() }
    if (seq === capsSeq) serverCaps.value = caps
  } catch {
    // 保守默认 + 释闩：初载失败（网络抖/服务未起）不该把闩咬死整会话——
    // 否则 QQ 凭据态永久按无凭据保守，vip 曲被误隐到刷新。seq 失配
    // 说明 refresh 已换代接管在途请求，闩归它处置，本代不插手
    if (seq === capsSeq) loaded = false
  }
}

// 设置页改完 cookie 类凭据后重取——loaded 闩防的是重复拉，不是终身一次
export function refreshServerCaps() {
  loaded = false
  capsSeq++
  return loadServerCaps()
}

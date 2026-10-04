import { ref } from 'vue'
import { musicApi } from '../api/music.js'

// 服务端能力投影（MA provider status 同思路）：持凭据的一侧算好布尔事实，
// 前端只消费不猜测。缺省=无凭据（保守方向——误判不可播好过展示死链）
export const serverCaps = ref({ qq: { loggedIn: false } })

let loaded = false
export async function loadServerCaps() {
  if (loaded) return
  loaded = true
  try {
    serverCaps.value = { qq: await musicApi.getQqStatus() }
  } catch { /* 保守默认 */ }
}

// 设置页改完 cookie 类凭据后重取——loaded 闩防的是重复拉，不是终身一次
export function refreshServerCaps() {
  loaded = false
  return loadServerCaps()
}

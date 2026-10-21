import http, { API_BASE_URL } from './http.js'

// 多端同步端点。响应已被 http 拦截器剥到 {code,...} body——
// pull 读 body.items/serverTime/hasMore，push 读 body.applied/conflicts/rejected。
// 均走共享实例默认超时：同步是叠加层，挂起由调用方（sync.js 引擎）退避兜底
export const syncApi = {
  // 增量拉取：since=交付水位线（服务端单调 seq 域，0=全量首同步）。
  // 服务端截页回 hasMore——续拉游标就是回包项的最大 seq 喂回 since
  //（seq 序天然 keyset，独立 cursor/nextCursor 已退役）；serverTime
  // 仅诊断，不回喂
  pull: (since) => http.get('/sync/pull', {
    params: { since },
  }),
  // 变更推送：changes 每项 {key,value,updatedAt,deleted}；conflicts 回包
  // {key,item:{key?,value,updatedAt,deleted,seq}}——item 内层 key/seq 是
  // 服务端冗余字段，采纳一律以外层 key 为准
  push: (changes) => http.post('/sync/push', { changes }),
}

// ── /sync/events 实时失效通知（SSE）──
// 服务端 push 落地向同桶广播 `event: changed` + `data:{seq}`——帧只是
// 「去拉」提示，不载条目数据（丢了不丢正确性：前台/在线补拉照常收敛）。
// withCredentials 带会话 cookie——登录端落用户桶，只收本端桶事件。
// DOWNLOAD_TOKEN 部署下 EventSource 带不了 x-download-token 自定义头：
// 无凭据的 SSE 握手被服务端 syncUserId 归 'default' 桶——而该部署的
// pull/push 同样无 cookie 也走 'default'，两侧天然同桶，不需额外参数。
// EventSource 缺席的环境（node/旧内核）返回 null——调用方退化为仅靠
// 补拉收敛，语义不变只慢一拍
export const openSyncEvents = (onMessage) => {
  if (typeof EventSource === 'undefined') return null
  const es = new EventSource(`${API_BASE_URL}/sync/events`, { withCredentials: true })
  if (typeof onMessage === 'function') {
    // 契约帧只有一种命名事件 'changed'；data={seq} 是水位线提示。
    // 解析失败照样转调（data=null）——坏帧不挡后续帧，帧义本就只有「有变更」
    es.addEventListener('changed', (e) => {
      let data = null
      try { data = JSON.parse(e.data) } catch { /* 坏帧按空提示处理 */ }
      onMessage(data, e)
    })
  }
  return es
}

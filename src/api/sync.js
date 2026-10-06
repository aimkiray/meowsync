import http from './http.js'

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

import http from './http.js'

// 运行时配置端点：键白名单/校验/掩码都在服务端——前端只透传表单值。
// 留空（''）即清覆盖回落服务端 env，是「读服务端配置」语义的写口
export const settingsApi = {
  // {fields: {key: {source,set,hint|value}}, ai: {enabled, model}}
  get: () => http.get('/settings', { timeout: 8000 }),

  // 增量写：只送有值的键；要清的键显式传 ''（null 语义同）
  save: (patch) => http.put('/settings', patch, { timeout: 10000 }),

  // 连通性探测（可送未保存的草稿值——服务端先取用参后回落生效配置）
  testAi: ({ baseUrl, apiKey, model } = {}) =>
    http.post('/settings/ai-test', { baseUrl, apiKey, model }, { timeout: 15000 })
}

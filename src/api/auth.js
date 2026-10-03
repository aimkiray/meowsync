import http from './http.js'

// 认证端点。响应已被 http 拦截器剥到 {code,data}——读 body.data
export const authApi = {
  status: () => http.get('/auth/status'),
  setup: (username, password) => http.post('/auth/setup', { username, password }),
  login: (username, password) => http.post('/auth/login', { username, password }),
  logout: () => http.post('/auth/logout'),
  me: () => http.get('/auth/me')
}

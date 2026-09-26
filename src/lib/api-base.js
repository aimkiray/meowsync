// 解析 API 基础地址（前端 api/music.js 与 App.vue 共用）
//
// 规则：
// 1. VITE_API_BASE_URL 显式配置时优先使用（保留配置端口）；
//    若配置的是 localhost 类地址而页面实际从其他主机打开（如手机访问局域网 IP），
//    则将主机替换为页面主机以便跨设备访问 API。
// 2. 未配置时：页面端口等于 API 端口（单进程部署/反代）或页面走标准端口（80/443）
//    时使用同源地址；否则推断为开发环境，使用 当前主机:API端口。

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1']

// URL/location.hostname 对 IPv6 返回带括号形式（[::1]），.localhost 子域同样指向本机
const isLocalHost = (host) => LOCAL_HOSTS.includes(host) || host.endsWith('.localhost')

export function resolveApiBaseUrl() {
  const configuredBase = import.meta.env.VITE_API_BASE_URL?.trim()
  const envPort = String(import.meta.env.VITE_API_PORT ?? '').trim()
  // 端口必须是纯数字：空白/非法值会让拼接或 URL.port 赋值产出畸形地址
  const fallbackPort = /^\d{1,5}$/.test(envPort) ? envPort : '3002'
  // 页面可能不是 http(s)（file://、扩展页、opaque origin），此时 origin 是 'null'、
  // protocol 也无法复用，只能退回 http://localhost:端口
  const pageIsHttp = /^https?:$/.test(window.location.protocol)
  const devFallback = () =>
    `${pageIsHttp ? window.location.protocol : 'http:'}//${window.location.hostname || 'localhost'}:${fallbackPort}`

  if (configuredBase) {
    try {
      // 必须带 scheme，否则视为无效配置（大小写不敏感，HTTP:// 同样合法）
      if (!/^https?:\/\//i.test(configuredBase)) {
        console.warn('[api] VITE_API_BASE_URL 缺少 http(s):// 前缀，已忽略:', configuredBase)
        return devFallback()
      }
      const configuredUrl = new URL(configuredBase)
      const configuredHost = configuredUrl.hostname
      const currentHost = window.location.hostname

      // 配置了本机地址但页面从其他主机打开 → 替换主机为页面主机（保留端口），支持局域网访问
      if (isLocalHost(configuredHost) && currentHost && !isLocalHost(currentHost)) {
        configuredUrl.hostname = currentHost
        if (!configuredUrl.port) configuredUrl.port = fallbackPort
      }

      return configuredUrl.toString().replace(/\/$/, '')
    } catch {
      return devFallback()
    }
  }

  const pagePort = window.location.port
  const standardPorts = ['', '80', '443']
  // 单进程部署：前端与 API 同端口（或经反代标准端口）→ 同源请求
  if (pageIsHttp && (standardPorts.includes(pagePort) || pagePort === fallbackPort)) {
    return window.location.origin
  }
  // 开发环境：vite 端口 + 独立 API 端口
  return devFallback()
}

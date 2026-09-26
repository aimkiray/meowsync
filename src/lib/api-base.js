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
  // 端口必须是合法 TCP 端口：非数字、0、>65535（new URL 直接抛错、请求必失败）都回退默认
  const fallbackPort = /^\d{1,5}$/.test(envPort) && Number(envPort) >= 1 && Number(envPort) <= 65535
    ? envPort
    : '3002'
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

      // HTTPS 页面请求 HTTP API 会被浏览器按混合内容拦截，提前告警便于定位
      if (window.location.protocol === 'https:' && configuredUrl.protocol === 'http:') {
        console.warn('[api] 页面为 HTTPS 但 API 地址是 HTTP，浏览器将拦截混合内容请求:', configuredBase)
      }

      // toString() 会给空路径补 '/'；去掉全部尾部斜杠，否则 App.vue 拼 '/remote' 出现 '//remote'
      return configuredUrl.toString().replace(/\/+$/, '')
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

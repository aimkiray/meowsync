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
  // 端口必须是合法 TCP 端口：非数字、0、>65535（new URL 直接抛错、请求必失败）都回退默认。
  // 默认 3101 = 开发环境 API 端口（Docker 生产是构建期 PROD → 走同源，不依赖此兜底）
  const fallbackPort = /^\d{1,5}$/.test(envPort) && Number(envPort) >= 1 && Number(envPort) <= 65535
    ? envPort
    : '3101'
  // 页面可能不是 http(s)（file://、扩展页、opaque origin），此时 origin 是 'null'、
  // protocol 也无法复用，只能退回 http://localhost:端口
  const pageIsHttp = /^https?:$/.test(window.location.protocol)
  const devFallback = () => {
    // https 页面配 http API 会被混合内容拦截——devFallback 分支也要告警
    const base = `${pageIsHttp ? window.location.protocol : 'http:'}//${window.location.hostname || 'localhost'}:${fallbackPort}`
    if (window.location.protocol === 'https:') {
      console.warn('[api] 页面为 HTTPS，推断的 API 地址是 HTTP，浏览器将拦截混合内容请求:', base)
    }
    return base
  }

  if (configuredBase) {
    try {
      // 必须带 scheme，否则视为无效配置（大小写不敏感，HTTP:// 同样合法）
      if (!/^https?:\/\//i.test(configuredBase)) {
        console.warn('[api] VITE_API_BASE_URL 缺少 http(s):// 前缀，已忽略:', configuredBase)
        return devFallback()
      }
      const configuredUrl = new URL(configuredBase)
      // 配置带 query/hash 多半是误配（如带了 '?' 或 '#'）——剥掉并告警而不是
      // 让拼出的 '/downloads?x=1/queues' 静默打错端点
      if (configuredUrl.search || configuredUrl.hash) {
        console.warn('[api] VITE_API_BASE_URL 不应包含 query/hash，已忽略:', configuredBase)
        configuredUrl.search = ''
        configuredUrl.hash = ''
      }
      const configuredHost = configuredUrl.hostname
      const currentHost = window.location.hostname
      // 显式写了默认端口（:80/:443）时 URL.port 归一化为空——只有原串没写
      // 端口时才补 fallbackPort，别把用户显式配置吞掉
      const hasExplicitPort = /^https?:\/\/[^/]*:\d+/i.test(configuredBase)

      // 配置了本机地址但页面从其他主机打开 → 替换主机为页面主机（保留端口），支持局域网访问
      if (isLocalHost(configuredHost) && currentHost && !isLocalHost(currentHost)) {
        configuredUrl.hostname = currentHost
        if (!configuredUrl.port && !hasExplicitPort) configuredUrl.port = fallbackPort
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
  // vite preview 服务的是生产产物（PROD 已烘焙）但监听 VITE_PORT，API 在独立端口——
  // 必须排除，否则 preview 模式下所有 API 请求打到静态服务器拿 HTML。
  // 收窄到 localhost：生产部署若恰好也跑在 3100（如 docker -p 3100:3002），
  // 远端访问不该被误判成 preview 而打到不存在的 3101
  const vitePreviewPort = String(import.meta.env.VITE_PORT || '3100')
  const isVitePreview = import.meta.env.PROD && pagePort === vitePreviewPort
    && isLocalHost(window.location.hostname)
  if (isVitePreview) {
    console.warn(`[api] 检测到 vite preview（${window.location.origin}），API 推断为 ${fallbackPort} 端口；非 preview 部署请配置 VITE_API_BASE_URL`)
  } else if (import.meta.env.PROD && pagePort === vitePreviewPort) {
    // 歧义场景无法静态区分：vite preview --host 的局域网访问 与 恰好跑在 3100 的
    // 生产部署。preview 时同源请求会拿到 index.html（200）被 axios 当成功解析——
    // 至少留告警便于定位；部署方请显式配置 VITE_API_BASE_URL 消除歧义
    console.warn(`[api] 页面端口 ${pagePort} 与 vite preview 端口相同：若这是 vite preview --host 的局域网访问，API 请求会打到静态服务器；若是生产部署请忽略（可用 VITE_API_BASE_URL 显式指定）`)
  }
  // 单进程部署/反代：生产构建产物与 API 同源——Docker 里没有 VITE_API_PORT，
  // 用 import.meta.env.PROD 区分（构建产物恒为 PROD），不能再靠端口反推
  if (pageIsHttp && !isVitePreview && (import.meta.env.PROD || standardPorts.includes(pagePort) || pagePort === fallbackPort)) {
    return window.location.origin
  }
  // 开发环境：vite 端口 + 独立 API 端口（默认 3101）
  return devFallback()
}

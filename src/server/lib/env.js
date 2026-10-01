// 环境变量单一解析点：同一开关多处解析会随时间漂移（TRUST_PROXY 曾散在
// music.js/rate-limit.js/remote.js 三处各写一遍）。
// 懒读函数形态而非启动快照——进程内改 env 的测试/续期场景不拿陈值。
function trustProxyEnabled() {
  return ['1', 'true'].includes((process.env.TRUST_PROXY || '').toLowerCase());
}

// CORS 白名单（origin 归一化）：HTTP cors 中间件、WS Origin 校验、
// /auth/* 的 CSRF Origin 纵深三处共用——三处口径漂移会互相拆台。
// 默认只留 localhost——credentials:true 下白名单里的任何公网域名都能跨站
// 读写本实例；局域网/公网部署必须显式配 CORS_ORIGINS
function corsOrigins() {
  // 不缓存：单请求解析成本 µs 级，换来测试内改 env 即时生效（与头注释
  // 「懒读不拿陈值」的承诺一致）
  return (process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',')
    : ['http://localhost:3100', 'http://127.0.0.1:3100', 'http://localhost:3101', 'http://127.0.0.1:3101']
  ).map(o => o.trim()).filter(Boolean)
    // 归一化到 origin：'https://x.com/' 尾斜杠永不匹配 Origin 头；
    // 只收 http(s)——file:/data:/chrome-extension: 等非标 scheme 的
    // URL.origin 是 'null'，进白名单等于放行 Origin:null 请求
    .map(o => {
      try {
        const u = new URL(o);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          console.warn(`[config] CORS_ORIGINS 项 '${o}' 不是 http(s) origin（也不支持通配符），已忽略`);
          return null;
        }
        return u.origin;
      } catch {
        console.warn(`[config] CORS_ORIGINS 项 '${o}' 不是合法 URL，已忽略`);
        return null;
      }
    }).filter(Boolean);
}

module.exports = { trustProxyEnabled, corsOrigins };

// 安全响应头：手写而非 hono/secure-headers——后者默认 CORP: same-origin 会掐死
// /audio-proxy 的中继语义（proxy.js 故意发 ACAO:*），全局 CSP 也会覆盖回源
// HTML 的 sandbox 防线。/audio-proxy 响应整条跳过（它自己的头已就位）。
const { trustProxyEnabled } = require('./env');

function secureHeaders() {
  return async (c, next) => {
    await next();
    const p = c.req.path;
    if (p === '/audio-proxy' || p.startsWith('/audio-proxy/')) return;
    const h = c.res.headers;
    if (!h.has('X-Content-Type-Options')) h.set('X-Content-Type-Options', 'nosniff');
    if (!h.has('Referrer-Policy')) h.set('Referrer-Policy', 'no-referrer');
    if (!h.has('X-Frame-Options')) h.set('X-Frame-Options', 'DENY'); // 与 CSP frame-ancestors 'none' 同口径
    if (!h.has('Permissions-Policy')) h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    // HSTS 只在 https 请求上下发——http 局域网部署下发会粘住域名
    const isHttps = c.req.url.startsWith('https:')
      || (trustProxyEnabled()
        && c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() === 'https');
    if (isHttps && !h.has('Strict-Transport-Security')) {
      h.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    }
    // CSP 只加在 HTML 文档（index.html/SPA 兜底），JSON API 不需要
    const type = h.get('content-type') || '';
    if (type.includes('text/html') && !h.has('Content-Security-Policy')) {
      h.set('Content-Security-Policy', [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'", // :style 绑定/进度条/菜单位置
        "img-src 'self' https: data: blob:",  // 封面直链上游 CDN
        "media-src 'self' blob: https:",      // <audio> 同源 + blob + 上游直链兜底
        "font-src 'self' data:",
        "connect-src 'self' https: wss: ws:", // saveStreamAsFile 直连上游 + dev ws
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'"
      ].join('; '));
    }
  };
}

module.exports = { secureHeaders };

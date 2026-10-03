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
        && c.req.header('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase() === 'https');
    if (isHttps && !h.has('Strict-Transport-Security')) {
      h.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    }
    // CSP 只加在 HTML 文档（index.html/SPA 兜底），JSON API 不需要。
    // script-src 的 sha256 对应 index.html 内联主题+字体翻转脚本——改那段
    // 脚本必须同步重算（node -e "crypto…update(脚本体)"），否则首帧被掐死；
    // 同理 index.html 里任何 onload/on* 内联处理器都会被本指令拒执
    const type = h.get('content-type') || '';
    if (type.includes('text/html') && !h.has('Content-Security-Policy')) {
      h.set('Content-Security-Policy', [
        "default-src 'self'",
        "script-src 'self' 'sha256-vpTmUE2u7N3JRUoytqzyaqhplbVzDyuIp3nr6+OBOBE='",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", // :style 绑定 + 内联启动样式 + 字体表
        // http: 必须保留——HTTP 部署（自托管常态）下网易图床/解锁源 CDN 的
        // http 封面与直链若被 CSP 掐死会全灭；https 页面里浏览器本就自动升级
        // 被动 http 资源，放开 http: 不实质削弱 https 部署的防线
        "img-src 'self' http: https: data: blob:",  // 封面直链上游 CDN
        // data: 是 Howler 的 unlock 占位 wav（data:audio/wav;base64,…）——
        // 缺它 audio pool 预热被掐报 "pool exhausted"
        "media-src 'self' blob: data: http: https:", // <audio> 同源 + blob/data + 上游直链兜底
        "font-src 'self' data: https://fonts.gstatic.com",
        "connect-src 'self' http: https: wss: ws:", // API 同源 + 跨域 http(s) 部署 + dev ws
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'"
      ].join('; '));
    }
  };
}

module.exports = { secureHeaders };

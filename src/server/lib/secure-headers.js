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
    // script-src 的 sha256 对应 index.html 内联主题恢复脚本——改那段
    // 脚本必须同步重算（node -e "crypto…update(脚本体)"），否则首帧被掐死；
    // 同理 index.html 里任何 onload/on* 内联处理器都会被本指令拒执
    const type = h.get('content-type') || '';
    // !has 判即是逃逸口：反代预置自定义 CSP 时本表整段不写入（混合部署
    // 边界见 DEPLOYMENT.md「安全响应头与 CSP」——跨源烘焙 API +
    // media-src 'self' 会拦跨源 <audio>，需由反代下发放宽表覆盖）
    if (type.includes('text/html') && !h.has('Content-Security-Policy')) {
      h.set('Content-Security-Policy', [
        "default-src 'self'",
        "script-src 'self' 'sha256-pADVm4OreZWjbx4BMy3eguDHGUp6u17ELX/GgnIjmfQ='",
        "style-src 'self' 'unsafe-inline'", // :style 绑定 + index.html 内联启动样式（字族表已自托管进 vite 管线）
        // 零被动外联口径：img/media/font 不再放行 http:/https: 源站字面量——
        // 外部封面统一经 /img-proxy 同源化（非白名单域客户端侧已 fail-closed），
        // 音频走 /audio-proxy vault 链，字体全量自托管（googleapis/gstatic 移除）
        "img-src 'self' data: blob:",       // 自定义封面 data: 直传 + blob 余量
        // data: 是 Howler 的 unlock 占位 wav（data:audio/wav;base64,…）——
        // 缺它 audio pool 预热被掐报 "pool exhausted"
        "media-src 'self' blob: data:",     // <audio> 同源 vault 链 + blob/data
        // data: 留位——vite 会把 <4KB 的 woff2 烘成 data:font/woff2 内联进 CSS
        "font-src 'self' data:",
        // connect-src 保留 http:/https:/ws:/wss: 四协议宽口径：
        // VITE_API_BASE_URL 可烘焙任意跨源 API 地址（跨源部署兼容位），
        // ws:/wss: 同义留给 /remote 遥控与 dev server。connect 是 fetch/WS
        // 主动请求通道，不产生被动子资源加载——不触碰不变式语义
        "connect-src 'self' http: https: ws: wss:",
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'"
      ].join('; '));
    }
  };
}

module.exports = { secureHeaders };

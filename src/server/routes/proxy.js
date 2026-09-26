const dns = require('dns').promises;
const { Hono } = require('hono');

const app = new Hono();

const ALLOWED_HOST = 'googlevideo.com';
const MAX_REDIRECTS = 5;
const UPSTREAM_TIMEOUT_MS = 15000;
// DNS 检查缓存 TTL：googlevideo 子域有限，但播放会发大量 Range 请求，
// 短缓存避免每条请求都多走一次 getaddrinfo 线程池
const DNS_CACHE_TTL_OK_MS = 60000;
const DNS_CACHE_TTL_ERR_MS = 5000;
const DNS_CACHE_MAX = 256;

// 只允许 googlevideo.com 及其子域（endsWith 前缀点避免误伤 xgooglevideo.com 这类域名）
// 安全性依赖 URL parser 的规范化：hostname 已小写化、IPv4 数字形式（0x7f000001/2130706433）
// 归一化为点分十进制、IDN 转 punycode、Unicode 点（。）归一化为 '.'——因此通过校验的
// 必然是以 googlevideo.com 结尾的真实域名，其 DNS 由 Google 控制，攻击者无法借此打内网
function isAllowedHost(hostname) {
  return hostname === ALLOWED_HOST || hostname.endsWith('.' + ALLOWED_HOST);
}

// 私有/保留/非路由地址段：合法 *.googlevideo.com 只应解析到 Google 公网地址。
// 命中这些段说明 DNS 被劫持/投毒或 hosts 被篡改，拒绝代理
function isPrivateIPv4(ip) {
  const o = ip.split('.').map(Number);
  const [a, b] = o;
  return (
    a === 0 || a === 10 || a === 127 || // 0/8 本机、10/8 RFC1918、127/8 loopback
    (a === 100 && b >= 64 && b <= 127) || // 100.64/10 CGNAT
    (a === 169 && b === 254) || // link-local
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12 RFC1918
    (a === 192 && b === 0) || // 192.0/24（含 192.0.0/24 与 192.0.2/24 文档段）
    (a === 192 && b === 168) || // RFC1918
    (a === 198 && (b === 18 || b === 19)) || // 198.18/15 基准测试段
    (a === 198 && b === 51 && o[2] === 100) || // 198.51.100/24 文档段
    (a === 203 && b === 0 && o[2] === 113) || // 203.0.113/24 文档段
    a >= 224 // 224/4 multicast、240/4 reserved（含 255 广播）
  );
}

function isPrivateIPv6(ip) {
  const s = ip.toLowerCase();
  if (s === '::' || s === '::1') return true; // unspecified / loopback
  const mapped = s.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isPrivateIPv4(mapped[1]); // IPv4-mapped 按内嵌 v4 判定
  if (s.startsWith('::')) return true; // 其它 ::/96 兼容/映射形式一律拒绝（公网 v6 不以 :: 开头）
  const first = parseInt(s.split(':')[0] || '0', 16);
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique-local
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link-local（覆盖 fe80–febf）
    (first & 0xff00) === 0xff00 // ff00::/8 multicast
  );
}

function isPrivateIp(address, family) {
  return family === 6 ? isPrivateIPv6(address) : isPrivateIPv4(address);
}

// hostname → { ok, expires }；有界 Map 防长期运行内存膨胀
const dnsCache = new Map();

/**
 * DNS 解析兜底校验：hostname 白名单已限定 *.googlevideo.com（Google 控制的 zone，
 * 攻击者无法自创其子域），本检查防御的是 DNS rebinding/本地 hosts 篡改把
 * 合法域名指到内网地址的场景——纵深防御。
 * 注意 TOCTOU：fetch 会自行再解析一次，两次解析可能不同，本检查是缓解而非硬保证。
 * fail closed：解析失败时 fetch 同样会失败，直接拒绝不改变可用性。
 */
async function resolvesToPublicIp(hostname) {
  const cached = dnsCache.get(hostname);
  if (cached && cached.expires > Date.now()) return cached.ok;

  let ok = false;
  try {
    const addrs = await dns.lookup(hostname, { all: true });
    ok = addrs.length > 0 && addrs.every((a) => !isPrivateIp(a.address, a.family));
  } catch {
    ok = false;
  }

  if (dnsCache.size >= DNS_CACHE_MAX) dnsCache.clear();
  dnsCache.set(hostname, {
    ok,
    expires: Date.now() + (ok ? DNS_CACHE_TTL_OK_MS : DNS_CACHE_TTL_ERR_MS),
  });
  return ok;
}

// 音频代理：用于转发 googlevideo 等需要服务端 IP 的音频流
app.get('/audio-proxy', async (c) => {
  let targetUrl = c.req.query('url');
  if (!targetUrl) return c.json({ error: 'missing url' }, 400);

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch {
      return c.json({ error: 'invalid url' }, 400);
    }

    // googlevideo 正式 URL 本就是 https；禁掉 http 消除明文回源被链路篡改的残余面
    if (parsed.protocol !== 'https:') {
      return c.json({ error: 'forbidden protocol' }, 403);
    }
    if (!isAllowedHost(parsed.hostname)) {
      return c.json({ error: 'forbidden host' }, 403);
    }
    // 非默认端口（URL parser 会把 :443/:80 归一化为空）对 googlevideo 没有实际用途，
    // 拦截防止代理被用来探测 Google 主机上的任意端口
    if (parsed.port !== '') {
      return c.json({ error: 'forbidden port' }, 403);
    }
    // 域名解析出的地址必须是公网 IP（SSRF/DNS-rebinding 兜底，见 resolvesToPublicIp 注释）
    if (!(await resolvesToPublicIp(parsed.hostname))) {
      return c.json({ error: 'forbidden address' }, 403);
    }
    // 剥离 credentials：合法 host 内嵌 userinfo 会使 undici fetch 抛 TypeError，
    // 且相对重定向会从 base URL 继承 username/password，统一清除后再作为请求/解析基准
    parsed.username = '';
    parsed.password = '';
    targetUrl = parsed.href;

    const proxyHeaders = {
      'User-Agent': 'Mozilla/5.0',
      // 强制 identity：undici 会按响应 Content-Encoding 透明解压但不改写上游 header，
      // 若上游返回压缩响应，透传的 Content-Length/Content-Range 描述的是压缩字节，
      // 与实际发送的解压字节不符会截断流；音频本身已压缩，identity 无任何损失
      'Accept-Encoding': 'identity',
    };
    const range = c.req.header('range');
    if (range) proxyHeaders['Range'] = range;

    // 超时仅覆盖连接+响应头阶段：AbortSignal 在 fetch resolve 后仍对 body 流生效，
    // 若使用 AbortSignal.timeout 会在 15s 时掐断正在传输的音频流。
    // 因此用 AbortController+setTimeout，拿到响应头后立即 clearTimeout；
    // 中途停滞由 undici 自身 bodyTimeout（默认 300s）兜底
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), UPSTREAM_TIMEOUT_MS);
    timeout.unref?.();
    const signals = [timeoutController.signal];
    // c.req.raw.signal 在客户端断开（socket close 且响应未写完）时由
    // @hono/node-server 触发 abort——流式传输全程保持生效，确保客户端断开
    // 能级联中止 upstream fetch、释放连接
    if (c.req.raw.signal) signals.push(c.req.raw.signal);

    let upstream;
    try {
      upstream = await fetch(targetUrl, {
        headers: proxyHeaders,
        redirect: 'manual',
        signal: AbortSignal.any(signals),
      });
    } catch {
      clearTimeout(timeout);
      const status = timeoutController.signal.aborted ? 504 : 502;
      return c.json({ error: status === 504 ? 'upstream timeout' : 'upstream request failed' }, status);
    }
    clearTimeout(timeout);

    const location = upstream.headers.get('location');
    if (upstream.status >= 300 && upstream.status < 400 && location) {
      // cancel 释放 keep-alive 连接；流已出错时 cancel 会 reject，吞掉避免 unhandledRejection
      upstream.body?.cancel().catch(() => {});
      // 解析相对重定向；每一跳都会重新校验协议/域名/端口
      try {
        targetUrl = new URL(location, targetUrl).toString();
      } catch {
        return c.json({ error: 'invalid redirect location' }, 502);
      }
      continue;
    }

    const resHeaders = {
      'Content-Type': upstream.headers.get('content-type') || 'audio/mp4',
      'Accept-Ranges': upstream.headers.get('accept-ranges') || 'bytes',
      'Access-Control-Allow-Origin': '*',
    };
    // 上游若无视 identity 仍返回压缩响应，undici 已解压 body——此时
    // Content-Length/Content-Range 描述编码字节流，与实际不符，丢弃交给
    // node-server 用 chunked 编码；Content-Encoding 不透传（body 已是明文）
    const encoded = upstream.headers.has('content-encoding');
    const contentLength = upstream.headers.get('content-length');
    if (contentLength && !encoded) resHeaders['Content-Length'] = contentLength;
    const contentRange = upstream.headers.get('content-range');
    if (contentRange && !encoded) resHeaders['Content-Range'] = contentRange;

    return c.body(upstream.body, upstream.status, resHeaders);
  }

  return c.json({ error: 'too many redirects' }, 502);
});

module.exports = app;

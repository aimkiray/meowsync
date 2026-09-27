const { Hono } = require('hono');
// 私网/保留段判定与 DNS 解析校验抽在 src/server/lib/net-guard.js，
// 与 file-downloader 的下载地址校验共用同一份实现
const { resolvesToPublicIp } = require('../lib/net-guard');

const app = new Hono();

// 可代理的上行域白名单（收窄到实际 CDN 子域，整棵后缀域放行会把网易 NOS
// 对象存储等用户可控内容面也纳入可代理范围）：googlevideo（ytdlp 解锁回链）、
// music.126.net（官方曲库 CDN m*/p* 子域）、kuwo.cn（kuwo 解锁源，sycdn/kwcdn
// 等 CDN 子域均在其下——域属酷我自营音乐平台）——前端"获取源文件"的解锁链
// CDN 不带 ACAO 必须走同源代理。白名单只决定"能代理谁"，SSRF 防线由下方
// 逐跳 resolvesToPublicIp 兜底
const ALLOWED_HOSTS = ['googlevideo.com', 'music.126.net', 'kuwo.cn'];
const MAX_REDIRECTS = 5;
const UPSTREAM_TIMEOUT_MS = 15000;

// endsWith 前缀点避免误伤 xgooglevideo.com 这类域名。
// 安全性依赖 URL parser 的规范化：hostname 已小写化、IPv4 数字形式（0x7f000001/2130706433）
// 归一化为点分十进制、IDN 转 punycode、Unicode 点（。）归一化为 '.'——因此通过校验的
// 必然是以白名单域结尾的真实域名；最终仍由每跳公网 IP 校验兜底
function isAllowedHost(hostname) {
  return ALLOWED_HOSTS.some(h => hostname === h || hostname.endsWith('.' + h));
}

// 音频代理：用于转发 googlevideo 等需要服务端 IP 的音频流
app.get('/audio-proxy', async (c) => {
  let targetUrl = c.req.query('url');
  if (!targetUrl) return c.json({ code: 400, message: 'missing url' }, 400);

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch {
      return c.json({ code: 400, message: 'invalid url' }, 400);
    }

    // http/https 都放：HTTP 部署下 kuwo/官方链多是 http——浏览器直连又死在
    // CORS，代理是唯一通道；明文回源的篡改面是音频内容本身（本来就不可信），
    // SSRF 仍由域名白名单+逐跳公网 IP 校验兜底
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return c.json({ code: 403, message: 'forbidden protocol' }, 403);
    }
    // FQDN 尾点归一化：'kuwo.cn.' 是合法写法但 endsWith 后缀匹配会误拒
    const hostname = parsed.hostname.replace(/\.$/, '');
    if (!isAllowedHost(hostname)) {
      return c.json({ code: 403, message: 'forbidden host' }, 403);
    }
    // 非默认端口（URL parser 会把 :443/:80 归一化为空）对 googlevideo 没有实际用途，
    // 拦截防止代理被用来探测 Google 主机上的任意端口
    if (parsed.port !== '') {
      return c.json({ code: 403, message: 'forbidden port' }, 403);
    }
    // 域名解析出的地址必须是公网 IP（SSRF/DNS-rebinding 兜底，见 resolvesToPublicIp 注释）
    if (!(await resolvesToPublicIp(hostname))) {
      return c.json({ code: 403, message: 'forbidden address' }, 403);
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
      return c.json({ code: status, message: status === 504 ? 'upstream timeout' : 'upstream request failed' }, status);
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
        return c.json({ code: 502, message: 'invalid redirect location' }, 502);
      }
      continue;
    }

    const resHeaders = {
      'Content-Type': upstream.headers.get('content-type') || 'audio/mp4',
      'Accept-Ranges': upstream.headers.get('accept-ranges') || 'bytes',
      'Access-Control-Allow-Origin': '*',
      // 白名单域回 text/html 时会以本服务 origin 渲染（借可信域钓鱼）——
      // nosniff 阻 MIME 猜测，sandbox 阻脚本执行
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': 'sandbox',
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

  return c.json({ code: 502, message: 'too many redirects' }, 502);
});

module.exports = app;

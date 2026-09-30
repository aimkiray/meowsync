const { Hono } = require('hono');
const { Agent } = require('undici');
const { rateLimit } = require('../lib/rate-limit');
// 私网/保留段判定与 DNS 解析校验抽在 src/server/lib/net-guard.js，
// 与 file-downloader 的下载地址校验共用同一份实现
const { resolvesToPublicIp, normalizeOutboundUrl, makeGuardedLookup } = require('../lib/net-guard');

const app = new Hono();

// 可代理的上行域白名单（收窄到实际 CDN 子域，整棵后缀域放行会把网易 NOS
// 对象存储等用户可控内容面也纳入可代理范围）：googlevideo（ytdlp 解锁回链）、
// music.126.net（官方曲库 CDN m*/p* 子域）、kuwo.cn（kuwo 解锁源，sycdn/kwcdn
// 等 CDN 子域均在其下——域属酷我自营音乐平台）、bilivideo.com/.cn（B 站
// DASH 音画分流 CDN，playurl 回链即此族；hdslb.com 为其封面图床）——前端
// "获取源文件"的解锁链 CDN 不带 ACAO 必须走同源代理。白名单只决定"能代理谁"，
// SSRF 防线由下方逐跳 resolvesToPublicIp 兜底
const ALLOWED_HOSTS = ['googlevideo.com', 'music.126.net', 'kuwo.cn',
  'bilivideo.com', 'bilivideo.cn', 'hdslb.com',
  // QQ 音流：qqmusic.qq.com 全族（ws./isure./dl./cc.stream.qqmusic.qq.com 等
  // sip 宿主）+ tc.qq.com 只收音乐子族——tc.qq.com 是腾讯通用 CDN（视频/小程序
  // /广告都在其下），整棵后缀放行会把开放代理面扩到无关业务；sip 偶发返回裸 IP
  // 宿主——后缀匹配天然拒绝 IP 字面量，候选自动降级
  'qqmusic.qq.com', 'aqqmusic.tc.qq.com', 'qqmusic.tc.qq.com', 'music.tc.qq.com'];
// B 站 CDN 防盗链要求 Referer 头——只对 bilivideo 系注入，不给无关域透信息
const BILI_CDN_HOSTS = ['bilivideo.com', 'bilivideo.cn', 'hdslb.com'];
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
  // 全站唯一"任意人可让服务器代发大流量"的端点——白名单域也是开放中转面，
  // 补 per-IP 限流（一次播放=1 次请求，seek 重试量级小，300/min 宽裕）
  if (!rateLimit(c, 'audio-proxy', 300)) {
    return c.json({ code: 429, message: '请求太频繁，稍后再试' }, 429);
  }
  let targetUrl = c.req.query('url');
  if (!targetUrl) return c.json({ code: 400, message: 'missing url' }, 400);

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    // 协议/端口/credentials/FQDN 尾点与下载路径共用同一归一化（net-guard）：
    // http/https 都放——HTTP 部署下 kuwo/官方链多是 http，浏览器直连又死在
    // CORS，代理是唯一通道；明文回源的篡改面是音频内容本身（本来就不可信）
    const checked = normalizeOutboundUrl(targetUrl);
    if (!checked.ok) {
      // 语法错误是客户端参数错误(400)，协议/端口违例是策略拒绝(403)
      const status = checked.code === 'BAD_URL' ? 400 : 403;
      const message = { BAD_URL: 'invalid url', BAD_SCHEME: 'forbidden protocol', BAD_PORT: 'forbidden port' }[checked.code];
      return c.json({ code: status, message }, status);
    }
    const parsed = checked.url;
    const hostname = parsed.hostname;
    if (!isAllowedHost(hostname)) {
      return c.json({ code: 403, message: 'forbidden host' }, 403);
    }
    // 域名解析出的地址必须是公网 IP（SSRF/DNS-rebinding 兜底，见 resolvesToPublicIp 注释）
    if (!(await resolvesToPublicIp(hostname))) {
      return c.json({ code: 403, message: 'forbidden address' }, 403);
    }
    targetUrl = parsed.href;

    const proxyHeaders = {
      // B 站 CDN 防盗链校验 Referer（缺它 403）；真实浏览器 UA——裸 'Mozilla/5.0'
      // 会被部分 CDN 判机器人拦下
      'User-Agent': BILI_CDN_HOSTS.some(h => hostname === h || hostname.endsWith('.' + h))
        ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
        : 'Mozilla/5.0',
      // 强制 identity：undici 会按响应 Content-Encoding 透明解压但不改写上游 header，
      // 若上游返回压缩响应，透传的 Content-Length/Content-Range 描述的是压缩字节，
      // 与实际发送的解压字节不符会截断流；音频本身已压缩，identity 无任何损失
      'Accept-Encoding': 'identity',
    };
    if (BILI_CDN_HOSTS.some(h => hostname === h || hostname.endsWith('.' + h))) {
      proxyHeaders['Referer'] = 'https://www.bilibili.com/';
    }
    const range = c.req.header('range');
    if (range) {
      // 多段 Range（bytes=0-1,3-5）上游会回 multipart/byteranges——与透传的
      // 单段 Content-Range 语义不兼容，浏览器请求也绝不会产生它，直接拒绝。
      // unit 大小写不敏感（RFC 7233）；两端至少给一个数字（bytes=- 是空区间）
      const m = /^bytes=(\d*)-(\d*)$/i.exec(range.trim());
      if (!m || (!m[1] && !m[2])) {
        return c.json({ code: 400, message: 'unsupported range' }, 400);
      }
      // 反向区间（5-3）上游会回 416 透传，无注入面但没必要放行
      if (m[1] && m[2] && BigInt(m[1]) > BigInt(m[2])) {
        return c.json({ code: 400, message: 'unsupported range' }, 400);
      }
      proxyHeaders['Range'] = range;
    }

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

    // socket 层钉扎：URL 阶段 resolvesToPublicIp 与 undici 建连是两次独立解析
    // （TOCTOU）——dispatcher 注入 guarded lookup，本跳每次建连的解析强制全
    // 公网且复用钉住集。keepAliveTimeout 短池化：代理是一次性转发，空闲
    // socket 1s 后自关，pin 表随 agent GC（web ReadableStream 无 close 事件）
    const dispatcher = new Agent({
      connect: { lookup: makeGuardedLookup() },
      keepAliveTimeout: 1000,
    });
    let upstream;
    try {
      upstream = await fetch(targetUrl, {
        headers: proxyHeaders,
        redirect: 'manual',
        signal: AbortSignal.any(signals),
        dispatcher,
      });
    } catch {
      dispatcher.destroy().catch(() => {});
      clearTimeout(timeout);
      // 客户端断开触发的 abort：响应已无法送达，区分出来避免把正常断流
      // 记成上游故障语义（同样返回即可，状态码对死连接无意义）
      if (c.req.raw.signal?.aborted) return c.body(null, 499);
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
      // Accept-Ranges 只在上游真实声明时透传——上游不支持却还回 'bytes'
      // 会让浏览器误判可断点续传，发出 Range 请求后被上游无视又回 200
      'Access-Control-Allow-Origin': '*',
      // 白名单域回 text/html 时会以本服务 origin 渲染（借可信域钓鱼）——
      // nosniff 阻 MIME 猜测，sandbox 阻脚本执行
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': 'sandbox',
    };
    // 上游若无视 identity 仍返回压缩响应，undici 已解压 body——此时
    // Content-Length/Content-Range 描述编码字节流，与实际不符，丢弃交给
    // node-server 用 chunked 编码；Content-Encoding 不透传（body 已是明文）。
    // identity 是合法 token（显式声明无编码）不算 encoded，不该丢字节对账头
    const encoded = (() => {
      const enc = (upstream.headers.get('content-encoding') || '').trim().toLowerCase();
      return enc !== '' && enc !== 'identity';
    })();
    const acceptRanges = upstream.headers.get('accept-ranges');
    if (acceptRanges && !encoded) resHeaders['Accept-Ranges'] = acceptRanges;
    const contentLength = upstream.headers.get('content-length');
    if (contentLength && !encoded) resHeaders['Content-Length'] = contentLength;
    const contentRange = upstream.headers.get('content-range');
    if (contentRange && !encoded) resHeaders['Content-Range'] = contentRange;

    // encoded 时 Content-Range 已丢弃——206 无 Content-Range 是畸形响应，
    // 降级为 200 全量语义（body 已解压为完整流，客户端按 200 消费即正确）
    const status = encoded && upstream.status === 206 ? 200 : upstream.status;
    return c.body(upstream.body, status, resHeaders);
  }

  return c.json({ code: 502, message: 'too many redirects' }, 502);
});

module.exports = app;
// 白名单判定导出给 bilibili/youtube 路由：/bilibili|youtube/stream 挑候选 CDN
// 回链时用同一谓词预筛，避免选中代理必拒的域导致 302 落地后 403
module.exports.isAllowedHost = isAllowedHost;

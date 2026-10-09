const { Hono } = require('hono');
const { Agent } = require('undici');
const { rateLimit } = require('../lib/rate-limit');
// 私网/保留段判定、DNS 解析校验与出站 URL 归一化都在 src/server/lib/net-guard.js，
// 与 proxy.js（音频代理）共用同一份实现——本路由不重复造 SSRF 防线
const { resolvesToPublicIp, normalizeOutboundUrl, makeGuardedLookup } = require('../lib/net-guard');
// YouTube 出站代理（yt_proxy）：ytimg/ggpht 封面回源与 googlevideo 同走
// undici ProxyAgent——未配时 ytDispatcher() 回 null 短路走直连
const { isYoutubeHost, ytDispatcher } = require('../lib/yt-proxy');
// 封面图床白名单：与客户端 song.js:proxiedCoverUrl 共用同一张表（双端漂移
// 会出现「没包 → 直连裂图」或「包了 → 服务端 403」的静默错位）——
// 名单口径与收窄理由见 shared/img-proxy-hosts.js 头注
const { isImgProxyHost } = require('../../shared/img-proxy-hosts.js'); // CJS require(ESM)

const app = new Hono();

// 重定向手工跟随上限：每跳重跑「归一化→白名单→公网 IP」全链，落非白名单域
// 即 403——本端点永不充当开放重定向器/通用 fetch
const MAX_REDIRECTS = 3;
// 图片是小对象：双层体积闸（头侧早拒 + 流侧兜底）卡住即断，8MiB 对封面宽裕
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
// 超时仅覆盖连接+响应头阶段（与 proxy.js 同姿态）：拿到响应头即 clear，
// body 传输停滞由体积闸上界 + undici bodyTimeout + 客户端 abort 兜底
const UPSTREAM_TIMEOUT_MS = 10000;
// 成功响应显式声明可缓存：内容对 URL 唯一确定、不含会话私有数据——
// 压住 authGate 会话态缺省补的 no-store（它只在 header 缺席时补）
const CACHE_POLICY = 'public, max-age=86400';
// 全域真实浏览器 UA——裸 'Mozilla/5.0' 会被部分 CDN 判机器人拦下
// （proxy.js 同款串；图床没有 googlevideo 那种按请求形态记账的毒化面）
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
  + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
// B 站图床防盗链要求 Referer——只对 hdslb 系注入，不给无关域透信息
const HDSLB = (h) => h === 'hdslb.com' || h.endsWith('.hdslb.com');

// 错误响应统一 JSON + no-store——浏览器对无缓存头的错误响应有启发式缓存面，收掉
const failJson = (c, status, message) =>
  c.json({ code: status, message }, status, { 'Cache-Control': 'no-store' });

// 有界读体：头侧 content-length 可谎报/缺省（chunked），流侧逐块累计超界即
// cancel 断流。全量缓冲换「响应头发出后不再翻供」的确定性——不边下边发。
// 返回 {state:'ok',buffer} / {state:'too-large'} / {state:'interrupted'}
async function readBoundedBody(stream, max) {
  if (!stream) return { state: 'ok', buffer: new Uint8Array(0) };
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => {});
        return { state: 'too-large' };
      }
      chunks.push(value);
    }
  } catch {
    return { state: 'interrupted' };
  }
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  return { state: 'ok', buffer };
}

// 封面图代理：白名单图床由服务端代取回源——客户端网络不能直连 YouTube 时
// （国内直连手机），音频已走 /audio-proxy 能播，封面不再裂图。
// 安全链逐跳复用 proxy.js 同款形态：归一化 → 白名单 → 公网 IP/YT 换道 →
// 钉扎建连 → manual 重定向（每跳重验）→ 类型闸 → 体积闸 → 透传
app.get('/img-proxy', async (c) => {
  // Hono 会把 HEAD 派发给 GET 处理器——本端点只服务 GET，其它命中者早退
  // 不回源；POST/PUT 等未注册方法由框架 404 兜底，根本到不了这里
  if (c.req.method !== 'GET') {
    return failJson(c, 405, 'method not allowed');
  }
  // 「任意人可让服务器代取图」的开放中转面——与 audio-proxy 同档 per-IP 限流，
  // 桶 key 隔离（封面是 <img> 子资源，批量加载量级仍远小于 300/min）
  if (!rateLimit(c, 'img-proxy', 300)) {
    return failJson(c, 429, '请求太频繁，稍后再试');
  }
  const firstUrl = c.req.query('url');
  if (!firstUrl) return failJson(c, 400, 'missing url');

  let targetUrl = firstUrl;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    // 协议/端口/credentials/FQDN 尾点与 proxy.js/下载链共用同一归一化：
    // http/https 都放——HTTP 部署下图床明文回链是合法面，篡改面是图片
    // 内容本身（本就不进可信上下文；svg 在下方类型闸另拒）
    const checked = normalizeOutboundUrl(targetUrl);
    if (!checked.ok) {
      // 语法错误是客户端参数错误(400)，协议/端口违例是策略拒绝(403)
      const status = checked.code === 'BAD_URL' ? 400 : 403;
      const message = { BAD_URL: 'invalid url', BAD_SCHEME: 'forbidden protocol', BAD_PORT: 'forbidden port' }[checked.code];
      return failJson(c, status, message);
    }
    const parsed = checked.url;
    const hostname = parsed.hostname;
    // 白名单闸在任何上游 fetch 之前——非白名单域零出站，不透 location 不代跳；
    // IP 字面量天然不命中后缀表，不必单独判
    if (!isImgProxyHost(hostname)) {
      return failJson(c, 403, 'forbidden host');
    }
    // YT 族目标且代理在位 → 走共享 ProxyAgent（跨请求缓存资产，错误路径不
    // destroy）：代理 host 常是私网字面量，本机 DNS 答案对墙内 googlevideo
    // 族域也常是污染结果——公网校验随之跳过，SSRF 面收敛在上方归一化+白名单
    const viaYtProxy = isYoutubeHost(hostname) ? ytDispatcher() : null;
    // 域名解析出的地址必须全公网（SSRF/DNS-rebinding 兜底，见 net-guard 注释）
    if (!viaYtProxy && !(await resolvesToPublicIp(hostname))) {
      return failJson(c, 403, 'forbidden address');
    }
    targetUrl = parsed.href;

    const proxyHeaders = {
      'User-Agent': BROWSER_UA,
      // 强制 identity：undici 透明解压但不改写上游 header，压缩响应会让
      // Content-Length 描述的字节与实际不符；图片本身已压缩，identity 无损失
      'Accept-Encoding': 'identity',
    };
    if (HDSLB(hostname)) proxyHeaders['Referer'] = 'https://www.bilibili.com/';
    // 条件请求透传：上游 304 回客户端 304——浏览器 revalidate 不重拉字节；
    // 客户端 Range/Cookie/其余入站头一律不透（不透出会话、不支持分段）
    const ifNoneMatch = c.req.header('if-none-match');
    if (ifNoneMatch) proxyHeaders['If-None-Match'] = ifNoneMatch;
    const ifModifiedSince = c.req.header('if-modified-since');
    if (ifModifiedSince) proxyHeaders['If-Modified-Since'] = ifModifiedSince;

    // AbortController+setTimeout 而非 AbortSignal.timeout：signal 在 fetch
    // resolve 后仍对 body 流生效，固定超时会把传输中的图片掐断——拿到响应头
    // 即 clearTimeout（proxy.js L122-124 同款模式）
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), UPSTREAM_TIMEOUT_MS);
    timeout.unref?.();
    const signals = [timeoutController.signal];
    // 客户端断开由 @hono/node-server 触发 abort——级联中止 upstream fetch
    if (c.req.raw.signal) signals.push(c.req.raw.signal);

    // socket 层钉扎：URL 阶段校验与建连是两次独立解析（TOCTOU）——guarded
    // lookup 强制每次建连落在钉住的全公网集。keepAliveTimeout 短池化：
    // 代理是一次性转发，空闲 socket 1s 后自关，pin 表随 agent GC
    const dispatcher = viaYtProxy || new Agent({
      connect: { lookup: makeGuardedLookup() },
      keepAliveTimeout: 1000,
    });
    let upstream;
    try {
      upstream = await fetch(targetUrl, {
        method: 'GET',
        headers: proxyHeaders,
        redirect: 'manual',
        signal: AbortSignal.any(signals),
        dispatcher,
      });
    } catch {
      if (!viaYtProxy) dispatcher.destroy().catch(() => {});
      clearTimeout(timeout);
      // 客户端断开触发的 abort：响应已无法送达，区分出来避免把正常断流
      // 记成上游故障（状态码对死连接无意义）
      if (c.req.raw.signal?.aborted) return c.body(null, 499);
      const status = timeoutController.signal.aborted ? 504 : 502;
      return failJson(c, status, status === 504 ? 'upstream timeout' : 'upstream request failed');
    }
    clearTimeout(timeout);

    // 304 直通：空体 + 同款 Cache-Control——条件请求的校验结果原样回客户端
    if (upstream.status === 304) {
      upstream.body?.cancel().catch(() => {});
      return c.body(null, 304, { 'Cache-Control': CACHE_POLICY });
    }

    const location = upstream.headers.get('location');
    if (upstream.status >= 300 && upstream.status < 400) {
      // cancel 释放 keep-alive 连接；流已出错时 cancel 会 reject，吞掉
      upstream.body?.cancel().catch(() => {});
      if (!location) {
        return failJson(c, 502, 'upstream redirect without location');
      }
      // 解析相对重定向；下一跳循环头重跑归一化/白名单/公网 IP 全链
      try {
        targetUrl = new URL(location, targetUrl).toString();
      } catch {
        return failJson(c, 502, 'invalid redirect location');
      }
      continue;
    }

    // 上游 ≥400：透传状态码、空响应体——不透上游错误页（HTML 进本服务
    // origin 是钓鱼面），no-store 收掉启发式缓存
    if (upstream.status >= 400) {
      const status = upstream.status;
      upstream.body?.cancel().catch(() => {});
      return c.body(null, status, { 'Cache-Control': 'no-store' });
    }

    // 类型闸：缺头/非 image/* 一律拒。svg 单列拒收——直开 /img-proxy?…svg
    // 会以本服务 origin 渲染 SVG 文档（脚本化上下文），真实封面链路从不产 svg。
    // 大小写不敏感、';' 参数归一（'image/jpeg; charset=…' 合规）
    const contentType = upstream.headers.get('content-type');
    const mime = (contentType || '').split(';', 1)[0].trim().toLowerCase();
    if (!mime.startsWith('image/') || mime === 'image/svg+xml') {
      upstream.body?.cancel().catch(() => {});
      return failJson(c, 502, 'upstream not an image');
    }

    // 体积闸·头侧：声明超限早拒，不拉字节
    const declared = Number(upstream.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
      upstream.body?.cancel().catch(() => {});
      return failJson(c, 502, 'image too large');
    }

    // 体积闸·流侧：无 content-length 或谎报小值时兜底，超界断流
    const result = await readBoundedBody(upstream.body, MAX_IMAGE_BYTES);
    if (result.state === 'too-large') {
      return failJson(c, 502, 'image too large');
    }
    if (result.state === 'interrupted') {
      if (c.req.raw.signal?.aborted) return c.body(null, 499);
      return failJson(c, 502, 'upstream request failed');
    }
    const buffer = result.buffer;

    const resHeaders = {
      // 上游 content-type 已验 image/*——原值透传（含合法参数）
      'Content-Type': contentType,
      // 不信任上游声明值：encoded 体经 undici 透明解压后与声明不符，
      // 按实际缓冲字节数重计天然正确
      'Content-Length': String(buffer.byteLength),
      'Cache-Control': CACHE_POLICY,
      // 图片子资源不需要 Referer 链——掐断页面 URL 外溢通道；
      // nosniff 阻 MIME 猜测，sandbox 兜直开导航的脚本执行
      'Access-Control-Allow-Origin': '*',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': 'sandbox',
    };
    const etag = upstream.headers.get('etag');
    if (etag) resHeaders['ETag'] = etag;
    const lastModified = upstream.headers.get('last-modified');
    if (lastModified) resHeaders['Last-Modified'] = lastModified;
    return c.body(buffer, 200, resHeaders);
  }

  return failJson(c, 502, 'too many redirects');
});

module.exports = app;

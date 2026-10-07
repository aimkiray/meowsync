const { Hono } = require('hono');
const { Agent } = require('undici');
const { rateLimit } = require('../lib/rate-limit');
const streamVault = require('../lib/stream-vault');
// 私网/保留段判定、DNS 解析校验与代理白名单都抽在 src/server/lib/net-guard.js，
// 与 file-downloader/netease-api（选源预筛）共用同一份实现
const { resolvesToPublicIp, normalizeOutboundUrl, makeGuardedLookup, isProxyAllowedHost } = require('../lib/net-guard');
// YouTube 出站代理（yt_proxy）：googlevideo 转发换道 undici ProxyAgent——
// 判定与懒建缓存在 lib/yt-proxy.js，未配时所有分支 null 短路走原样
const { isYoutubeHost, ytDispatcher } = require('../lib/yt-proxy');
// 播放字节本地缓存：vault 条目带 cacheKey 时先查盘（完整档直喂，签名
// 过期无所谓），未命中照常回源并 tee 旁路落盘。缓存是优化路径——
// 任何环节失败只落空，绝不拖累响应流
const mediaCache = require('../services/media-cache');

const app = new Hono();

// 白名单只决定"能代理谁"，SSRF 防线由下方逐跳 resolvesToPublicIp 兜底；
// 域枚举与收窄理由见 net-guard.js PROXY_ALLOWED_HOSTS 注释
const isAllowedHost = isProxyAllowedHost;
// B 站 CDN 防盗链要求 Referer 头——只对 bilivideo 系注入，不给无关域透信息
const BILI_CDN_HOSTS = ['bilivideo.com', 'bilivideo.cn', 'hdslb.com'];
const MAX_REDIRECTS = 5;
const UPSTREAM_TIMEOUT_MS = 15000;

// 单候选逐跳回源：白名单→公网IP→钉扎建连→302 手动跟随（每跳重验）。
// 返回结构化结果而非直接回客户端——候选链调度层据 kind 决定换档/透出：
//   {kind:'ok', send}      上游给了可用响应（含非 2xx 透传？否——见下）
//   {kind:'halt', send}    客户端自身错误（坏 Range/断连 499）——非候选之罪，立即透出
//   {kind:'reject', send}  该候选被拒（校验失败/上游 ≥400/请求抛错）——调度层可换档
// send(c) 是真正写响应的闭包——推迟到「这是最终结论」时才执行，换档候选的
// 上游 body 在返回前已 cancel，不会挂着悬空 socket
// cacheKey 在位时 ok 响应旁路落盘（见下方 tee 分支）
async function fetchCandidate(c, firstUrl, cacheKey, cacheMeta) {
  const clientRange = c.req.header('range');
  // 多段 Range（bytes=0-1,3-5）上游会回 multipart/byteranges——与透传的
  // 单段 Content-Range 语义不兼容，浏览器请求也绝不会产生它，直接拒绝。
  // 校验在候选循环外做一次：客户端错误与具体候选无关
  if (clientRange) {
    // unit 大小写不敏感（RFC 7233）；两端至少给一个数字（bytes=- 是空区间）
    const m = /^bytes=(\d*)-(\d*)$/i.exec(clientRange.trim());
    if (!m || (!m[1] && !m[2])) {
      return { kind: 'halt', send: () => c.json({ code: 400, message: 'unsupported range' }, 400) };
    }
    // 反向区间（5-3）上游会回 416 透传，无注入面但没必要放行
    if (m[1] && m[2] && BigInt(m[1]) > BigInt(m[2])) {
      return { kind: 'halt', send: () => c.json({ code: 400, message: 'unsupported range' }, 400) };
    }
  }

  let targetUrl = firstUrl;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    // 协议/端口/credentials/FQDN 尾点与下载路径共用同一归一化（net-guard）：
    // http/https 都放——HTTP 部署下 kuwo/官方链多是 http，浏览器直连又死在
    // CORS，代理是唯一通道；明文回源的篡改面是音频内容本身（本来就不可信）
    const checked = normalizeOutboundUrl(targetUrl);
    if (!checked.ok) {
      // 语法错误是客户端参数错误(400)，协议/端口违例是策略拒绝(403)。
      // 归候选侧拒绝（换档可能救活——下一候选 URL 形态不同）
      const status = checked.code === 'BAD_URL' ? 400 : 403;
      const message = { BAD_URL: 'invalid url', BAD_SCHEME: 'forbidden protocol', BAD_PORT: 'forbidden port' }[checked.code];
      return { kind: 'reject', send: () => c.json({ code: status, message }, status) };
    }
    const parsed = checked.url;
    const hostname = parsed.hostname;
    if (!isAllowedHost(hostname)) {
      return { kind: 'reject', send: () => c.json({ code: 403, message: 'forbidden host' }, 403) };
    }
    // YouTube 族目标且代理在位 → 走 ProxyAgent：代理 host 常是 127.0.0.1
    // 私网字面量，公网钉扎会误杀操作员自配代理；且代理通道下目标域由
    // 代理端解析，本机 DNS 答案（墙内对 googlevideo 常是污染的 fake-IP/
    // 私网结果）无关且会拦死本就要绕道的流量——本跳公网校验随之跳过，
    // SSRF 面收敛在上方 normalizeOutboundUrl 协议/端口 + isAllowedHost 域名单
    const viaYtProxy = isYoutubeHost(hostname) ? ytDispatcher() : null;
    // 域名解析出的地址必须是公网 IP（SSRF/DNS-rebinding 兜底，见 resolvesToPublicIp 注释）
    if (!viaYtProxy && !(await resolvesToPublicIp(hostname))) {
      return { kind: 'reject', send: () => c.json({ code: 403, message: 'forbidden address' }, 403) };
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
    // 部分 googlevideo 流按「无 Range 的全量 GET」策略拒客（403），而媒体元素
    // 的探测性首连并不总带 Range——代理代为注入 bytes=0-（语义=全文，走 206
    // 通道绕开）。下游响应同步把 206 降回 200：客户端没请求 Range，按规范
    // 不该收到 Partial Content（Howler/audio 元素都能消化，但守规矩更稳）
    let injectedRange = false;
    if (clientRange) {
      proxyHeaders['Range'] = clientRange;
    } else if (hostname === 'googlevideo.com' || hostname.endsWith('.googlevideo.com')) {
      proxyHeaders['Range'] = 'bytes=0-';
      injectedRange = true;
    }

    // HEAD 探测只透传给 HEAD 安全的宿主；googlevideo 签名链例外——上游
    // 按请求形态记账，裸 HEAD 会毒化该 URL 的后续 Range 请求
    // （services/youtube-resolve probeGated、netease-api getContentLength
    // 的同源告警，两处都对 googlevideo 刻意避开裸 HEAD）。对它翻成 GET
    // 取响应头：上方 Range 注入照旧生效（bytes=0- 正是客户端首连的真实
    // 形态，且 HEAD-unfriendly 上游对带 Range 的 GET 才回正常头），body
    // 在 send() 里立即 cancel 不拉字节——带宽语义与裸 HEAD 一致。
    // 其余白名单宿主（126/kuwo/bili/qq CDN）无毒化记录，HEAD 原样透传
    const headAsGet = c.req.method === 'HEAD'
      && (hostname === 'googlevideo.com' || hostname.endsWith('.googlevideo.com'));

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
    // socket 1s 后自关，pin 表随 agent GC（web ReadableStream 无 close 事件）。
    // YT 代理跳用共享 ProxyAgent 顶替：它是跨请求的缓存资产而非一次性
    // socket——错误路径不 destroy（误杀会波及并发在途转发）
    const dispatcher = viaYtProxy || new Agent({
      connect: { lookup: makeGuardedLookup() },
      keepAliveTimeout: 1000,
    });
    let upstream;
    try {
      upstream = await fetch(targetUrl, {
        // HEAD 探测原样走 HEAD——客户端只要头部（Content-Length/类型探活），
        // 发 GET 会把整段音频字节白拉回源（缓存未命中时纯烧带宽）。上游对
        // HEAD 回无 body 响应：下方 body?.cancel() 的 ?. 与 send() 里
        // c.body(null,...) 天然兼容；hono 对 HEAD 本就会剥 body，双保险。
        // 例外是 headAsGet 命中的 HEAD 敏感宿主（googlevideo）——见上方注释
        method: c.req.method === 'HEAD' && !headAsGet ? 'HEAD' : 'GET',
        headers: proxyHeaders,
        redirect: 'manual',
        signal: AbortSignal.any(signals),
        dispatcher,
      });
    } catch {
      if (!viaYtProxy) dispatcher.destroy().catch(() => {});
      clearTimeout(timeout);
      // 客户端断开触发的 abort：响应已无法送达，区分出来避免把正常断流
      // 记成上游故障语义（同样返回即可，状态码对死连接无意义）
      if (c.req.raw.signal?.aborted) {
        return { kind: 'halt', send: () => c.body(null, 499) };
      }
      const status = timeoutController.signal.aborted ? 504 : 502;
      return { kind: 'reject', send: () => c.json({ code: status, message: status === 504 ? 'upstream timeout' : 'upstream request failed' }, status) };
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
        return { kind: 'reject', send: () => c.json({ code: 502, message: 'invalid redirect location' }, 502) };
      }
      continue;
    }

    // 上游 ≥400：候选拒绝——调度层还有候选就换档（SABR 闸控的 googlevideo
    // 自适应流即此形态）；body 先 cancel 释放 keep-alive 连接
    if (upstream.status >= 400) {
      const status = upstream.status;
      upstream.body?.cancel().catch(() => {});
      return { kind: 'reject', send: () => c.json({ code: status, message: `上游返回 ${status}` }, status) };
    }

    const resHeaders = {
      'Content-Type': upstream.headers.get('content-type') || 'audio/mp4',
      // Accept-Ranges 只在上游真实声明时透传——上游不支持却还回 'bytes'
      // 会让浏览器误判可断点续传，发出 Range 请求后被上游无视又回 200
      'Access-Control-Allow-Origin': '*',
      // 音频子资源不需要 Referer 链——顺手掐断页面 URL 外溢的通道
      'Referrer-Policy': 'no-referrer',
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
    if (contentRange && !encoded && !injectedRange) resHeaders['Content-Range'] = contentRange;

    // encoded 时 Content-Range 已丢弃——206 无 Content-Range 是畸形响应，
    // 降级为 200 全量语义（body 已解压为完整流，客户端按 200 消费即正确）。
    // injectedRange 同理：客户端未请求 Range 却收 206 属协议噪音，body
    // 是全量流，按 200 透传语义最诚实
    const status = (encoded || injectedRange) && upstream.status === 206 ? 200 : upstream.status;
    return { kind: 'ok', send: () => {
      let body = upstream.body;
      // headAsGet 的 HEAD 翻译探测只要响应头——body 立即 cancel 释放
      // socket，整段音频字节不回拉；body=null 同时天然跳过下方 tee 捕获
      if (headAsGet) {
        body?.cancel().catch(() => {});
        body = null;
      }
      // 旁路捕获：键在位 + 总量可判 + 非编码字节流才 tee——206 从
      // Content-Range `bytes s-e/total` 取偏移与总长（injectedRange 的
      // bytes=0- 天然落在同一条解析路），200 即 offset=0 全量；
      // encoded 时透传字节与盘语义不符，不捕获
      if (cacheKey && body && !encoded) {
        const rm = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(String(contentRange || '').trim());
        const total = upstream.status === 206
          ? (rm ? parseInt(rm[3], 10) : 0)
          : (contentLength ? parseInt(contentLength, 10) : 0);
        const startOffset = upstream.status === 206 ? (rm ? parseInt(rm[1], 10) : 0) : 0;
        const capture = total > 0 && mediaCache.beginCapture(cacheKey, {
          contentType: resHeaders['Content-Type'],
          size: total,
          startOffset,
          ...(cacheMeta || {}),
        });
        if (capture) body = mediaCache.teeStream(body, capture);
      }
      return c.body(body, status, resHeaders);
    } };
  }

  return { kind: 'reject', send: () => c.json({ code: 502, message: 'too many redirects' }, 502) };
}

// 候选链调度：vault 条目可挂多候选——契约是「同一字节实体的镜像」
//（bilibili 的 baseUrl/backup_url 组），跨分辨率/编码的不同文件混排会让
// 换档把同一 offset 的另一文件字节当答案回给客户端（静默解码错乱）——
// 生产侧（routes/youtube、bilibili 档选择、unlock）负责只 mint 同实体候选。
// 从上次成功位 idx 起绕行一圈：单候选条目行为与旧版逐跳管线完全一致；
// 多候选时 4xx/断连换下一镜像，成功后把 idx 钉住，seek 的后续 Range 直吃
// 可用镜像不再白探死链。
// 已知取舍——这里不做在途合流：同一 vault 条目/同一 cacheKey 的并发
// 请求仍会各自打一条上游字节泵。字节流合流需要一条上流扇出到 N 个
// 响应 socket（tee 多播 + 各消费方独立 abort/backpressure 语义 +
// Range 起点各异的对账），复杂度与错误面远超收益——mediaCache 完整档
// 供给已把「二次起放」压成零上游往返，剩余重复扇出只是首次冷取窗口内
// 的并发，量级可接受
async function proxyUpstream(c, entry) {
  const urls = entry.urls;
  // 完整字节已在盘上：连上游都不打——签名过期/被闸/离线都无所谓。
  // 缓存层自身故障只 warn 回落原代理链，播放绝不能被优化路径挡死
  if (entry.cacheKey) {
    try {
      const served = await mediaCache.serveComplete(c, entry.cacheKey);
      if (served) return served;
    } catch (e) {
      console.warn(`[media-cache] 完整档供给失败（${entry.cacheKey}），回落上游:`, e?.message || e);
    }
  }
  const start = Math.min(entry.idx || 0, urls.length - 1);
  let lastReject = null;
  for (let n = 0; n < urls.length; n++) {
    const i = (start + n) % urls.length;
    const r = await fetchCandidate(c, urls[i], entry.cacheKey, entry.cacheMeta);
    if (r.kind === 'halt') return r.send();
    if (r.kind === 'ok') {
      entry.idx = i;
      return r.send();
    }
    lastReject = r;
  }
  return lastReject.send();
}

// 音频代理：用于转发 googlevideo 等需要服务端 IP 的音频流
app.get('/audio-proxy', async (c) => {
  // 全站唯一"任意人可让服务器代发大流量"的端点——白名单域也是开放中转面，
  // 补 per-IP 限流（一次播放=1 次请求，seek 重试量级小，300/min 宽裕）
  if (!rateLimit(c, 'audio-proxy', 300)) {
    return c.json({ code: 429, message: '请求太频繁，稍后再试' }, 429);
  }
  const targetUrl = c.req.query('url');
  if (!targetUrl) return c.json({ code: 400, message: 'missing url' }, 400);
  return proxyUpstream(c, { urls: [targetUrl], idx: 0 });
});

// vault 入口：上游签名 URL 经 stream-vault 换成 opaque token——QQ purl 的
// uin/vkey、B 站登录态的 mid/uipk、googlevideo 的 ip= 不出进程；
// token 有效期内多次可用（seek=并发 Range），滑动 TTL 上限对齐上游签名寿命
app.get('/audio-proxy/t/:token', async (c) => {
  if (!rateLimit(c, 'audio-proxy', 300)) {
    return c.json({ code: 429, message: '请求太频繁，稍后再试' }, 429);
  }
  const entry = streamVault.resolve(c.req.param('token'));
  if (!entry) return c.json({ code: 404, message: 'stream token expired' }, 404);
  return proxyUpstream(c, entry);
});

module.exports = app;

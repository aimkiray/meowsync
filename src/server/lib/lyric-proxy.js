// 外源歌词检索出站代理（LYRIC_PROXY）：LRCLIB / 酷狗两条 fetch 链的
// dispatcher 位——上游限流（LRCLIB 429/503 抖动）时给部署侧一条绕行通道。
// 刻意取舍：本键只读 process.env，不进 settings DEFS/设置页——它是本地
// 部署档（换出口是运维绕行闸，不是终端用户配置项），DB 覆盖层不收；
// 也无需像 yt_proxy 那样进设置页——LRCLIB/酷狗无账号态可护，配置面收窄。
// 未配置或值非法一律 null 短路——各消费点行为与直连逐字节一致。
// 代理凭据不出进程：不落日志、不进错误消息（与 yt-proxy 同口径——URL
// 可内嵌 user:pass@）。
//
// 只收 http/https 代理 URL，socks5:// 不收：与 yt-proxy 同口径——undici
// ProxyAgent 虽能把 socks 委派到 Socks5ProxyAgent，但下载链的
// http(s)-proxy-agent 只懂 HTTP 代理形态，三面口径不齐（Innertube 走通、
// 下载静默直连）比直接不收更难排查，要开先把三面开齐（详 yt-proxy.js
// 头注）。
const { ProxyAgent } = require('undici');

// 懒读而非启动快照：process.env 直读，调用方每次取现值——测试改 env 即
// 刻生效，重启不追陈值。trim + ASCII 消毒与 yt-proxy 同口径——带进
// 换行/中文的粘贴串会被 URL parser 拒或静默改写 host。畸形/scheme 非
// http(s) → 按值记一次 warn（值不落日志）后按未配置处理
let proxyWarned = '';
function lyricProxy() {
  const raw = (process.env.LYRIC_PROXY || '').trim();
  if (!raw) return null;
  const ascii = raw.replace(/[^\x20-\x7e]/g, '');
  let u = null;
  try {
    const p = new URL(ascii);
    if (p.protocol === 'http:' || p.protocol === 'https:') u = p;
    // userinfo percent 形态验真：'%zz' 类裸百分号能过 URL parser（原样
    // 保留），到拨号期才炸 URIError；验不过按非法值降级（yt-proxy 同款）
    if (u && (u.username || u.password)) {
      decodeURIComponent(u.username);
      decodeURIComponent(u.password);
    }
  } catch {
    u = null; // 落 null 分支统一告警
  }
  if ((ascii !== raw || !u) && proxyWarned !== raw) {
    proxyWarned = raw;
    console.warn(u
      ? '[lyric-proxy] LYRIC_PROXY 含控制字符/非 ASCII，已剔除后使用'
      : '[lyric-proxy] LYRIC_PROXY 不是合法 http(s) 代理地址——按未配置处理');
  }
  return u;
}

// 懒建缓存 ProxyAgent，以消毒后完整 URL（href 含 userinfo——凭据缓在
// agent 内不出面）为键：值变即重建并 destroy 旧池释放连接；值不变复用——
// 级联里 LRCLIB→酷狗是连续串，keep-alive 对代理端友好。清除配置同样销毁
// 旧池，不留孤儿 socket（与 ytDispatcher 同口径）
let cachedKey = '';
let cachedAgent = null;
function lyricDispatcher() {
  const u = lyricProxy();
  const key = u ? u.href : '';
  // key=''（未配置）时 cachedAgent 必为 null——快路径不重建也不误命中
  if (cachedAgent && cachedKey === key) return cachedAgent;
  const prev = cachedAgent;
  cachedAgent = null;
  cachedKey = '';
  if (u) {
    cachedAgent = new ProxyAgent(u);
    cachedKey = key;
  }
  prev?.destroy().catch(() => {}); // 旧池异步关——吞错防 unhandledRejection
  return cachedAgent;
}

// 代理「不可达」的 socket/dial 错误码族：undici fetch 把传输层错误包成
// TypeError('fetch failed') 真因挂 cause（Happy Eyeballs 多址聚合在
// cause.errors）——配了 LYRIC_PROXY 但代理进程没跑/端口死/域名解析
// 失败时首发 100% 炸在这一族：
//   ECONNREFUSED 拨代理端口被拒    ENOTFOUND/EAI_* 代理域名解析失败
//   ETIMEDOUT/UND_ERR_CONNECT_TIMEOUT  TCP 连接超时
//   ECONNRESET/UND_ERR_SOCKET/EPIPE    socket 中段断开——RST 面含隧道传导
//     歧义：keep-alive 池化 socket 被 RST 与上游 RST 经隧道回传不可区分，
//     取舍为优先可用性（代理进程死后池化连接复用恰产 ECONNRESET，收窄会
//     丢「代理死后」场景）——本键本就是绕行闸
//   EHOSTUNREACH/ENETUNREACH           路由不可达
// 刻意不收「代理活着的对端行为」：UND_ERR_ABORTED（CONNECT 回非 200——
// 明拒隧道，含 407 鉴权拒绝）、UND_ERR_PRX_TLS（代理 TLS 握手拒）、
// 响应期超时（UND_ERR_HEADERS/BODY_TIMEOUT）——部署侧刻意拒流/代理
// 劣化是运维语义，静默直连绕行等于架空闸本身
const PROXY_CONN_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NODATA',
  'EAI_NONAME', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH',
  'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
]);
// 沿 cause 链下钻（AggregateError 的 errors 面同查）——真因套几层都认
const isProxyConnFail = (e) => {
  if (!(e instanceof TypeError) || e.message !== 'fetch failed') return false;
  const seen = new Set();
  for (const stack = [e]; stack.length;) {
    const c = stack.pop();
    if (!c || typeof c !== 'object' || seen.has(c)) continue;
    seen.add(c);
    if (PROXY_CONN_CODES.has(c.code)) return true;
    if (Array.isArray(c.errors)) stack.push(...c.errors);
    if (c.cause) stack.push(c.cause);
  }
  return false;
};

// LYRIC_PROXY 在位时的 fetch 包装：代理是「限流绕行闸」不是硬依赖——闸死
// （配了但进程没跑/端口拒连/主机黑洞 DROP）时带 dispatcher 的首发必炸在
// 传输面，剥掉 dispatcher 直连重发一次兜底，而不是整链 fetch failed 判死。
// 仅幂等无 body 调用（GET）——回退跳原样重放首发 init，body 重放未支持。
//   · 首发跳单挂一道 3s 拨号探针（PROXY_DIAL_PROBE_MS）：黑洞型死代理
//     （主机宕机/防火墙 DROP，不回 RST/ICMP）不产连接级错，而 undici
//     connect timeout 与调用方 timedSignal 伞同为 10s 且起点更晚——总是
//     伞先掐，TimeoutError 撞「真时限」闸永不回退。探针与 opts.signal
//     并联进 AbortSignal.any：探针先掐（opts.signal 无恙而合成信号已
//     aborted）即「拨号无应答」视作代理不可达走回退；拨号预算与 10s 伞
//     预算共享——回退跳只吃到伞的剩余额度，总时限不放大
//   · 只在连接级失败回退：isProxyConnFail 族外（HTTP 错误码是 response
//     不是 throw 天然不触发；CONNECT 非 200/TLS 拒等对端行为）原样抛
//   · 调用方时限不回退：opts.signal 已 aborted——调用方取消与伞超时都是
//     真时限，回退重发会穿透预算；非探针所掐的中止（AbortError/伞外
//     TimeoutError 等族外形态）同样上抛
//   · 回退发生记 warn 一次（同代理值生命周期内 warn-once，与非法值告警
//     同口径——代理 URL 可内嵌凭据不落日志）；无 dispatcher 纯透传零分支
const PROXY_DIAL_PROBE_MS = 3000;
let fallbackWarnedKey = '';
async function lyricFetch(url, opts) {
  const d = lyricDispatcher();
  if (!d) return fetch(url, opts);
  // 探针只挂首发跳（带 dispatcher 那发）：直连重发与未配置形态都不加预算
  const probeSignal = opts?.signal
    ? AbortSignal.any([opts.signal, AbortSignal.timeout(PROXY_DIAL_PROBE_MS)])
    : AbortSignal.timeout(PROXY_DIAL_PROBE_MS);
  try {
    return await fetch(url, { ...opts, dispatcher: d, signal: probeSignal });
  } catch (e) {
    // 谁掐谁的责：opts.signal 已 aborted = 调用方伞超时/取消——真时限，
    // 回退会穿透预算，原样上抛
    if (opts?.signal?.aborted) throw e;
    // 走到这 opts.signal 无恙：合成信号已 aborted ⇒ 是 3s 探针掐的（拨号
    // 无应答的黑洞面）→ 回退；否则按连接级码族判——族外（对端行为/
    // AbortError/族外 TypeError）上抛
    if (!probeSignal.aborted && !isProxyConnFail(e)) throw e;
    if (fallbackWarnedKey !== cachedKey) {
      fallbackWarnedKey = cachedKey;
      console.warn('[lyric-proxy] LYRIC_PROXY 代理连接级失败——本请求起剥代理直连重试');
    }
    return fetch(url, opts);
  }
}

module.exports = { lyricProxy, lyricDispatcher, lyricFetch };

// YouTube 出站代理通道（yt_proxy / YT_PROXY，secret 键——URL 可内嵌
// user:pass@ 凭据位）：YouTube 系域名的服务端外联统一经这里判定出口。
// 三面消费方：
//   lib/youtube.js          Innertube 四发 fetch 的 dispatcher 位
//   routes/proxy.js         /audio-proxy googlevideo 转发的 dispatcher 位
//   services/download-io.js 下载链 fetchStream（googlevideo 拉流/SABR Range
//                           探测/ytimg 封面）的隧道型 agent 对
// 未配置或值非法一律 null 短路——各消费点行为与旧版逐字节一致。
// 代理凭据不出进程：不落日志、不进错误消息（同 YT_COOKIE 口径）。
//
// 只收 http/https 代理 URL，socks5:// 不收：undici ProxyAgent 虽能把
// socks 委派到 Socks5ProxyAgent，但下载链的 http(s)-proxy-agent 只懂
// HTTP 代理形态——三面口径不齐（Innertube 走通、下载静默直连）比直接
// 不收更难排查，要开先把三面开齐。
const { ProxyAgent } = require('undici');
const { HttpProxyAgent } = require('http-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
// 懒读而非启动快照：app_settings 覆盖/env 经 lib/settings 解析——设置页
// 热改即刻生效，重启不追陈值（ytCookie 同口径）
const { effectiveValue } = require('./settings');

// YouTube 系域名族：Innertube 端点（*.youtube.com / youtubei.googleapis.com）、
// YouTube Music 歌词页（music.youtube.com——'youtube.com' 后缀判定本就覆盖，
// 显式列出是防判定口径收窄后静默丢词源代理）、媒体回链（*.googlevideo.com）、
// 封面图床（*.ytimg.com / *.ggpht.com）。
// 判定口径与 net-guard.isProxyAllowedHost 同款（=== 或 .endsWith('.'+h)）——
// 挡 xgooglevideo.com / googlevideo.com.evil.com 式蹭名
const YT_HOSTS = ['youtube.com', 'music.youtube.com', 'googlevideo.com',
  'youtubei.googleapis.com', 'ytimg.com', 'ggpht.com'];

function isYoutubeHost(hostname) {
  return YT_HOSTS.some((h) => hostname === h || hostname.endsWith('.' + h));
}

// 生效代理 URL：DB 覆盖 > env（effectiveValue 层）。trim + ASCII 消毒与
// ytCookie 同口径——写入侧 secretAscii 已挡非 ASCII，这里是 env 直配/脏
// 库行双保险（带进换行/中文的粘贴串会被 URL parser 拒或静默改写 host）。
// 畸形/scheme 非 http(s) → 按值记一次 warn（值不落日志）后按未配置处理
let proxyWarned = '';
function youtubeProxy() {
  const raw = (effectiveValue('yt_proxy') || '').trim();
  if (!raw) return null;
  const ascii = raw.replace(/[^\x20-\x7e]/g, '');
  let u = null;
  try {
    const p = new URL(ascii);
    if (p.protocol === 'http:' || p.protocol === 'https:') u = p;
    // userinfo percent 形态验真：undici/axios 两侧都靠 decodeURIComponent
    // 拆 Basic——'%zz' 类裸百分号能过 URL parser（原样保留），到拨号/
    // config 期才炸 URIError；验不过按非法值降级
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
      ? '[yt-proxy] yt_proxy 含控制字符/非 ASCII，已剔除后使用'
      : '[yt-proxy] yt_proxy 不是合法 http(s) 代理地址——按未配置处理');
  }
  return u;
}

// 懒建缓存 ProxyAgent，以消毒后完整 URL（href 含 userinfo——凭据缓在
// agent 内不出面）为键：值变即重建并 destroy 旧 agent 释放连接池；
// 值不变复用——Innertube 取流→googlevideo 拉流是连续串，keep-alive 对
// 代理端友好。清除配置同样销毁旧池，不留孤儿 socket
let cachedKey = '';
let cachedAgent = null;
function ytDispatcher() {
  const u = youtubeProxy();
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

// axios 出口（下载链 fetchStream 消费）：YT 族 host 且代理在位 → 隧道型
// agent 对 + proxy:false；其余 → null（调用方维持 guarded-agent 现状）。
// 不走 axios proxy 选项：它对 https 目标发 absolute-form 明文请求行
// （'GET https://…'），严格 CONNECT-only 代理回 400 拒收（axios#6320 形态，
// 实测确认）。隧道 agent 是全代理通用形态：https 目标走 CONNECT 隧道后
// 端到端 TLS，http 目标发 absolute-form（http 转发的标准形态，无人不收）。
// 凭据整 URL 进 agent——CONNECT 期 agent 自行 decode 拼 Proxy-Authorization，
// 与旧 proxy.auth 拆分/undici ProxyAgent 同口径；host 拆分与 IPv6 括号、
// 缺省端口补全都在 agent 内部完成，不再手拆。
// proxy:false 必须显式——否则 axios 会再读 env 代理变量叠加出口；
// 凭据缓在 agent.proxy/connectOpts 内不出进程（消费侧错误路径剥
// error.config/request 防失败日志整对象 inspect 带出去）。
// agent 每跳新建不复用：下载是一次性长流不留池（keepAlive:false 与
// 钉扎 agent 同口径），跳数少，新建开销可忽略
function ytAxiosProxyFor(hostname) {
  if (!isYoutubeHost(hostname)) return null;
  const u = youtubeProxy();
  if (!u) return null;
  const opts = { keepAlive: false };
  return {
    httpAgent: new HttpProxyAgent(u, opts),
    httpsAgent: new HttpsProxyAgent(u, opts),
    proxy: false,
  };
}

module.exports = { isYoutubeHost, youtubeProxy, ytDispatcher, ytAxiosProxyFor };

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

module.exports = { lyricProxy, lyricDispatcher };

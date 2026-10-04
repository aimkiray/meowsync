// 环境变量单一解析点：同一开关多处解析会随时间漂移（TRUST_PROXY 曾散在
// music.js/rate-limit.js/remote.js 三处各写一遍）。
// 懒读函数形态而非启动快照——进程内改 env 的测试/续期场景不拿陈值。
// TRUST_PROXY 语义=可信反代跳数：'1'/'true'/'yes' → 1（单层反代，最常见）；
// 数字 N → N 跳可信链（CDN→nginx→app）。0/false/未设 → 不采信任何转发头
function trustProxyHops() {
  const v = (process.env.TRUST_PROXY || '').trim().toLowerCase();
  if (!v || v === '0' || v === 'false') return 0;
  if (['1', 'true', 'yes'].includes(v)) return 1;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n <= 10 ? n : 0;
}

function trustProxyEnabled() {
  return trustProxyHops() > 0;
}

// 客户端 IP（限流分桶/日志共用——auth.js 与 rate-limit.js 曾各抄一份）。
// XFF 语义：每层反代把自己看到的对端追加到右侧（$proxy_add_x_forwarded_for）。
// 右起第 N 个 = 最内层可信反代的直连对端——TCP 层事实，客户端伪造不了；
// 左起第一跳永远是客户端自填值，TRUST_PROXY 下取 [0] 等于把限流桶交给
// 攻击者命名。链短于跳数（直连/链路异常）回落 socket 对端——共享桶退化
// 但 fail-closed，不会把伪造值当身份。
// headers 为 http.IncomingMessage.headers 形态（小写键 plain object）——
// HTTP（clientIp 包装）与 WS upgrade（remote.js 限流）共用同一实现，
// TRUST_PROXY 语义两侧同源不漂移
function clientIpFromHeaders(headers, remoteAddress) {
  const hops = trustProxyHops();
  if (hops > 0) {
    const xff = headers?.['x-forwarded-for'];
    if (xff) {
      const ips = String(xff).split(',').map(s => s.trim()).filter(Boolean);
      if (ips.length >= hops) return ips[ips.length - hops];
    }
  }
  return remoteAddress || 'local';
}

function clientIp(c) {
  return clientIpFromHeaders(
    { 'x-forwarded-for': c.req.header('x-forwarded-for') },
    c.env?.incoming?.socket?.remoteAddress
  );
}

// CORS 白名单（origin 归一化）：HTTP cors 中间件、WS Origin 校验、
// /auth/* 的 CSRF Origin 纵深三处共用——三处口径漂移会互相拆台。
// 默认只留 localhost——credentials:true 下白名单里的任何公网域名都能跨站
// 读写本实例；局域网/公网部署必须显式配 CORS_ORIGINS
// 非法项告警按值去重：corsOrigins() 每请求重解析（csrfOriginOk 对每个写请求
// 都调），不去重会把同一个错配项随流量刷进日志。env 运行期可变，改值后
// 新值仍会各告警一次
const warnedCorsItems = new Set();
function warnCorsItemOnce(item, reason) {
  const key = `${item}${reason}`;
  if (warnedCorsItems.has(key)) return;
  warnedCorsItems.add(key);
  console.warn(`[config] CORS_ORIGINS 项 '${item}' ${reason}，已忽略`);
}

function corsOrigins() {
  // 不缓存：单请求解析成本 µs 级，换来测试内改 env 即时生效（与头注释
  // 「懒读不拿陈值」的承诺一致）
  return (process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',')
    : ['http://localhost:3100', 'http://127.0.0.1:3100', 'http://localhost:3101', 'http://127.0.0.1:3101']
  ).map(o => o.trim()).filter(Boolean)
    // 归一化到 origin：'https://x.com/' 尾斜杠永不匹配 Origin 头；
    // 只收 http(s)——file:/data:/chrome-extension: 等非标 scheme 的
    // URL.origin 是 'null'，进白名单等于放行 Origin:null 请求
    .map(o => {
      try {
        const u = new URL(o);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          warnCorsItemOnce(o, '不是 http(s) origin（也不支持通配符）');
          return null;
        }
        return u.origin;
      } catch {
        warnCorsItemOnce(o, '不是合法 URL');
        return null;
      }
    }).filter(Boolean);
}

module.exports = { trustProxyEnabled, trustProxyHops, clientIp, clientIpFromHeaders, corsOrigins };

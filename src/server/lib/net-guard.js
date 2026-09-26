const dns = require('dns').promises;
const net = require('net');

// 私有/保留/非路由地址段判定。被 proxy.js（音频代理）与 file-downloader.js（下载落盘）共用：
// 任何由"服务端代发"的外联请求都必须先过这层，否则等于开放 SSRF 通道
function isPrivateIPv4(ip) {
  const o = ip.split('.').map(Number);
  const [a, b, c] = o;
  return (
    a === 0 || a === 10 || a === 127 || // 0/8 本机、10/8 RFC1918、127/8 loopback
    (a === 100 && b >= 64 && b <= 127) || // 100.64/10 CGNAT
    (a === 169 && b === 254) || // link-local（含 169.254.169.254 云元数据）
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12 RFC1918
    (a === 192 && b === 0 && c === 0) || // 192.0.0/24 IETF 协议分配
    (a === 192 && b === 0 && c === 2) || // 192.0.2/24 文档段 TEST-NET-1
    (a === 192 && b === 31 && c === 196) || // 192.31.196/24 AS112
    (a === 192 && b === 52 && c === 193) || // 192.52.193/24 AMT
    (a === 192 && b === 88 && c === 99) || // 192.88.99/24 6to4 relay anycast
    (a === 192 && b === 168) || // RFC1918
    (a === 192 && b === 175 && c === 48) || // 192.175.48/24 AS112 direct delegation
    (a === 198 && (b === 18 || b === 19)) || // 198.18/15 基准测试段
    (a === 198 && b === 51 && c === 100) || // 198.51.100/24 文档段
    (a === 203 && b === 0 && c === 113) || // 203.0.113/24 文档段
    a >= 224 // 224/4 multicast、240/4 reserved（含 255 广播）
  );
}

function isPrivateIPv6(ip) {
  const s = ip.toLowerCase();
  if (s === '::' || s === '::1') return true; // unspecified / loopback
  // 注意顺序：::ffff:a.b.c.d 映射地址必须先按内嵌 v4 判定，
  // 再落入下面的"首段为 0"兜底；该正则必须在 first===0 检查之前运行
  const mapped = s.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isPrivateIPv4(mapped[1]); // IPv4-mapped 按内嵌 v4 判定
  const parts = s.split(':');
  const first = parseInt(parts[0] || '0', 16);
  const second = parseInt(parts[1] || '0', 16);
  return (
    first === 0 || // ::/16 全域：unspecified、::/96 兼容地址、展开式映射
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique-local
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link-local（覆盖 fe80–febf）
    (first & 0xffc0) === 0xfec0 || // fec0::/10 site-local（已废弃但仍可能被路由）
    (first & 0xff00) === 0xff00 || // ff00::/8 multicast
    first === 0x2002 || // 2002::/16 6to4（内嵌 v4，可指向私网地址）
    (first === 0x2001 && second === 0) || // 2001::/32 Teredo（内嵌 v4）
    (first === 0x2001 && second === 0xdb8) || // 2001:db8::/32 文档段
    (first === 0x2001 && second === 0x0002) || // 2001:2::/48 基准测试段
    (first === 0x2001 && (second & 0xfff0) === 0x0010) || // 2001:10::/28 ORCHIDv1
    (first === 0x2001 && (second & 0xfff0) === 0x0020) || // 2001:20::/28 ORCHIDv2
    (first & 0xfff0) === 0x3ff0 || // 3fff::/20 文档段（RFC 9637）
    (first === 0x64 && second === 0xff9b) // 64:ff9b::/96 + 64:ff9b:1::/48 NAT64（内嵌 v4）
  );
}

function isPrivateIp(address, family) {
  return family === 6 ? isPrivateIPv6(address) : isPrivateIPv4(address);
}

// WHATWG URL parser 保留 IPv6 字面量的方括号（hostname === '[::1]'），
// net.isIP 不认带括号形式——判段前先剥掉，否则 IPv6 字面量全走 DNS 必然 ENOTFOUND
function stripIpv6Brackets(hostname) {
  return hostname.replace(/^\[|\]$/g, '');
}

// net.isIp：URL hostname 已是 IP 字面量时无需 DNS
function isIpLiteral(hostname) {
  return net.isIP(stripIpv6Brackets(hostname)) !== 0;
}

// hostname → { ok, expires }；有界 Map 防长期运行内存膨胀
// ok 缓存只留 10s：校验与最终连接是两次独立解析（TOCTOU），缓存窗口越长
// DNS rebinding 的缓解就越弱；短 TTL 只为削掉并发瞬时重复解析
const DNS_CACHE_TTL_OK_MS = 10000;
const DNS_CACHE_TTL_ERR_MS = 5000;
const DNS_CACHE_MAX = 256;
const dnsCache = new Map();
// 同 hostname 并发 miss 各自发 lookup 是重复放大——缓存 pending promise 做合并
const dnsInflight = new Map();

/**
 * hostname → 公网 IP 校验。防御两类场景：
 * - 代理/下载的域名指向被篡改到内网（DNS rebinding、hosts 投毒）
 * - URL 直接是内网 IP 字面量（绕过域名白名单的场景）
 * TOCTOU：实际连接会再解析一次，两次解析可能不同，本检查是缓解而非硬保证。
 * fail closed：解析失败时下游请求同样会失败，直接拒绝不改变可用性。
 */
async function resolvesToPublicIp(hostname) {
  // IP 字面量直接判段，不走 DNS；先剥 WHATWG parser 保留的 IPv6 方括号
  const bare = stripIpv6Brackets(hostname);
  const literalFamily = net.isIP(bare);
  if (literalFamily !== 0) {
    return !isPrivateIp(bare, literalFamily);
  }

  const cached = dnsCache.get(hostname);
  if (cached && cached.expires > Date.now()) return cached.ok;

  let pending = dnsInflight.get(hostname);
  if (!pending) {
    pending = (async () => {
      let ok = false;
      try {
        const addrs = await dns.lookup(hostname, { all: true });
        ok = addrs.length > 0 && addrs.every((a) => !isPrivateIp(a.address, a.family));
      } catch {
        ok = false;
      }
      // 满时淘汰最旧条目而非全清——突发多 host 时全清会造成缓存抖动
      if (dnsCache.size >= DNS_CACHE_MAX) {
        dnsCache.delete(dnsCache.keys().next().value);
      }
      dnsCache.set(hostname, {
        ok,
        expires: Date.now() + (ok ? DNS_CACHE_TTL_OK_MS : DNS_CACHE_TTL_ERR_MS),
      });
      return ok;
    })().finally(() => dnsInflight.delete(hostname));
    dnsInflight.set(hostname, pending);
  }
  return pending;
}

module.exports = {
  isPrivateIPv4,
  isPrivateIPv6,
  isPrivateIp,
  isIpLiteral,
  stripIpv6Brackets,
  resolvesToPublicIp
};

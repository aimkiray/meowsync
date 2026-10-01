// 流地址保管库：上游签名 URL（QQ purl 明文 uin/vkey、B 站 mid/uipk、
// googlevideo ip= 出口地址）不直接进 302 Location——换成 opaque token，
// 客户端只见 /audio-proxy/t/<token>。PeerTube videoFileToken/Jellyfin
// OpenToken/Navidrome share JWT 同款思路：单进程自托管场景用进程内 Map
// 足够，多实例部署才需要换成共享存储。代价：进程重启即全表作废——
// 在途播放的下一次 Range 会 404，客户端需重取流地址恢复。
// 语义：有效期内多次可用（浏览器 seek=同 URL 多次 Range 请求，一次性
// token 与可 seek 媒体不兼容）；每次命中滑动续期但有绝对上限（不晚于
// 上游签名寿命——QQ vkey ~22h，封顶 24h）。
const { randomBytes } = require('crypto');

const SLIDING_TTL_MS = 2 * 3600e3;   // 活跃播放不会中途过期
const MAX_TTL_MS = 24 * 3600e3;      // 绝对上限：对齐最长上游签名寿命
const MAX_ENTRIES = 2048;
const SWEEP_INTERVAL_MS = 10 * 60e3;

const vault = new Map(); // token -> { url, expiresAt, notAfter }

function mint(url, { ttlMs = SLIDING_TTL_MS } = {}) {
  const token = randomBytes(24).toString('base64url');
  const now = Date.now();
  // 容量上限淘汰最旧条目——长期运行防内存膨胀
  if (vault.size >= MAX_ENTRIES) vault.delete(vault.keys().next().value);
  vault.set(token, {
    url: String(url),
    expiresAt: now + ttlMs,
    notAfter: now + MAX_TTL_MS,
  });
  return token;
}

function resolve(token) {
  const e = vault.get(token);
  if (!e) return null;
  const now = Date.now();
  if (e.expiresAt < now || e.notAfter < now) {
    vault.delete(token);
    return null;
  }
  e.expiresAt = Math.min(now + SLIDING_TTL_MS, e.notAfter); // 滑动续期
  // LRU touch：Map 迭代序=插入序，delete+set 把活跃 token 挪到末尾——
  // 否则满容淘汰按"最早插入"先杀掉正在播放的旧 token（net-guard dnsCache 同款）
  vault.delete(token);
  vault.set(token, e);
  return e.url;
}

// 惰性过期之外加周期清扫：mint 的突发批次没人命中也要释放
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [k, e] of vault) {
    if (e.expiresAt < now || e.notAfter < now) vault.delete(k);
  }
}, SWEEP_INTERVAL_MS);
sweeper.unref?.();

module.exports = { mint, resolve };

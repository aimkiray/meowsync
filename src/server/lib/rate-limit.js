// 滑动窗限流（进程内）：resolve/stream 类未鉴权扇出端点共用——防循环刷量
// 把服务端 IP 送进上游风控。桶 key：TRUST_PROXY 下采信 XFF 首跳（与
// requestOrigin 同语义）；否则用 socket 真实地址——不信客户端自带 XFF
// （可伪造轮换绕过），也不让 LAN 全员挤 'local' 桶
const rateBuckets = new Map();

function rateLimit(c, key, limit) {
  const trustProxy = ['1', 'true'].includes((process.env.TRUST_PROXY || '').toLowerCase());
  const ip = (trustProxy && c.req.header('x-forwarded-for')?.split(',')[0]?.trim())
    || c.env?.incoming?.socket?.remoteAddress
    || 'local';
  const bucketKey = `${key}:${ip}`;
  const now = Date.now();
  const hits = (rateBuckets.get(bucketKey) || []).filter(t => now - t < 60000);
  if (hits.length >= limit) return false;
  hits.push(now);
  rateBuckets.set(bucketKey, hits);
  if (rateBuckets.size > 5000) rateBuckets.clear(); // 防内存膨胀
  return true;
}

module.exports = { rateLimit };

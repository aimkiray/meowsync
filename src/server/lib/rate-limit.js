// 滑动窗限流（进程内）：resolve/stream 类未鉴权扇出端点共用——防循环刷量
// 把服务端 IP 送进上游风控。桶 key：TRUST_PROXY 下采信 XFF 首跳（与
// requestOrigin 同语义）；否则用 socket 真实地址——不信客户端自带 XFF
// （可伪造轮换绕过），也不让 LAN 全员挤 'local' 桶
const { trustProxyEnabled } = require('./env');
const rateBuckets = new Map();
// rateLimitByKey 走独立 Map：与 IP 桶共用一张表时，灌满 5000 触发清扫/全清
// 会把分钟级登录桶（key 存活窗口不同）提前抹掉——攻击者能用垃圾 key 灌桶
// 把 per-account 爆破限额冲回零。两张表互不清对方
const keyBuckets = new Map();

function rateLimit(c, key, limit) {
  const trustProxy = trustProxyEnabled();
  const ip = (trustProxy && c.req.header('x-forwarded-for')?.split(',')[0]?.trim())
    || c.env?.incoming?.socket?.remoteAddress
    || 'local';
  const bucketKey = `${key}:${ip}`;
  const now = Date.now();
  const hits = (rateBuckets.get(bucketKey) || []).filter(t => now - t < 60000);
  if (hits.length >= limit) return false;
  hits.push(now);
  rateBuckets.set(bucketKey, hits);
  if (rateBuckets.size > 5000) {
    // 先扫过期键再整表清——共享 map 的粗粒度 clear 会把别的路由的活桶连坐清掉
    for (const [k, v] of rateBuckets) {
      if (!v.some(t => now - t < 60000)) rateBuckets.delete(k);
    }
    if (rateBuckets.size > 5000) rateBuckets.clear();
  }
  return true;
}

// 不带 IP 的按键限流：登录接口的 per-account 桶——防「换 IP 轮喷同一账号」
// 绕过 per-IP 限流。windowMs 可配（登录桶要分钟级窗，不只 60s）。
// 满容清扫按每桶自身窗口判定存活——绝不用别的路由的窗口套这张表
function rateLimitByKey(key, limit, windowMs = 60000) {
  const now = Date.now();
  const entry = keyBuckets.get(key);
  const hits = (entry ? entry.hits : []).filter(t => now - t < windowMs);
  if (hits.length >= limit) return false;
  hits.push(now);
  keyBuckets.set(key, { hits, windowMs });
  if (keyBuckets.size > 5000) {
    for (const [k, v] of keyBuckets) {
      if (!v.hits.some(t => now - t < v.windowMs)) keyBuckets.delete(k);
    }
    // 兜底仍超上限：逐最旧 key（Map 有序）而非 clear()——攻击者灌桶最多
    // 挤掉别的键控桶，自己的限流语义不被全表清空绕过
    while (keyBuckets.size > 5000) {
      const oldest = keyBuckets.keys().next().value;
      keyBuckets.delete(oldest);
    }
  }
  return true;
}

module.exports = { rateLimit, rateLimitByKey };

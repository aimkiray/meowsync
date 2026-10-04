// 滑动窗限流（进程内）：resolve/stream 类未鉴权扇出端点共用——防循环刷量
// 把服务端 IP 送进上游风控。桶 key 的 IP 来自共享 clientIp——TRUST_PROXY
// 下取 XFF 右起第 N 跳（可信反代追加位，客户端伪造不了）；直连用 socket
// 真实地址——不信客户端自带 XFF（可伪造轮换绕过），也不让 LAN 全员挤
// 'local' 桶
const { clientIp } = require('./env');
const rateBuckets = new Map();
// rateLimitByKey 走独立 Map：与 IP 桶共用一张表时，灌满 5000 触发清扫/全清
// 会把分钟级登录桶（key 存活窗口不同）提前抹掉——攻击者能用垃圾 key 灌桶
// 把 per-account 爆破限额冲回零。两张表互不清对方
const keyBuckets = new Map();

// 满容策略（两表共用语义）：先按各表窗口扫过期键，仍超上限则拒绝为新 key
// 建桶——灌桶方的每个新 key 都被拒（自食其果），存量桶的限流语义不受洪泛
// 影响。绝不能用「逐最旧 key」：Map 插入序下受害者桶（先插入）比攻击者的
// 新鲜 key 先被逐——洪泛反而成了洗限流计数的工具
const MAX_BUCKETS = 5000;

// 纯函数核心（key+IP → 滑动窗判定）：HTTP 经 rateLimit 包装走 Hono ctx；
// WS upgrade 没有 ctx，remote.js 用 clientIpFromHeaders 取 IP 后直调本函数——
// 两侧桶表/满容策略/TRUST_PROXY 取 IP 语义完全同源
function rateLimitForIp(key, ip, limit) {
  const bucketKey = `${key}:${ip}`;
  const now = Date.now();
  const hits = (rateBuckets.get(bucketKey) || []).filter(t => now - t < 60000);
  if (hits.length >= limit) return false;
  hits.push(now);
  if (!rateBuckets.has(bucketKey) && rateBuckets.size >= MAX_BUCKETS) {
    for (const [k, v] of rateBuckets) {
      if (!v.some(t => now - t < 60000)) rateBuckets.delete(k);
    }
    if (rateBuckets.size >= MAX_BUCKETS) return false; // 满容拒新——存量桶不受影响
  }
  rateBuckets.set(bucketKey, hits);
  return true;
}

function rateLimit(c, key, limit) {
  return rateLimitForIp(key, clientIp(c), limit);
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
  if (!entry && keyBuckets.size >= MAX_BUCKETS) {
    for (const [k, v] of keyBuckets) {
      if (!v.hits.some(t => now - t < v.windowMs)) keyBuckets.delete(k);
    }
    if (keyBuckets.size >= MAX_BUCKETS) return false; // 满容拒新：洪泛的随机 key 全部自限
  }
  keyBuckets.set(key, { hits, windowMs });
  return true;
}

// 成功回退一记：rateLimitByKey 先计后验（含成功请求）——登录成功把
// 账号桶的最新一拍退回，防「反复失会话的合法用户 8 次登录即自锁」；
// 只退 acct 桶，IP 桶保持全量计数（20/10min 对单人是宽上限）
function refundByKey(key) {
  const entry = keyBuckets.get(key);
  if (!entry || !entry.hits.length) return;
  entry.hits.pop();
}

module.exports = { rateLimit, rateLimitForIp, rateLimitByKey, refundByKey };

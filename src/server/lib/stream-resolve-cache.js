// 播放流端点（/youtube/stream /bilibili/stream /qq/stream）共用的短 TTL
// 正缓存小工具：上游签名 URL 寿命以小时计（googlevideo ~6h、playurl ~2h、
// vkey ~22h），而每次播放重解是最坏多跳扇出——分钟级复用把客户端预热/
// 重复 open 的冷跳打成一次内存读。调用方负责只存「可复用产物」普通对象
// （resolve 结果集），不存 promise/响应体——命中同步返回，await 后即产物。
// 纯同步、无外部依赖、无定时器——过期靠读取时惰性判定（stream-vault/
// gateCache 同款口径），冷键最多占满 max 个槽位，量上有界不拖进程
function createTtlCache({ max = 256, ttlMs = 60000 } = {}) {
  const map = new Map(); // key -> { value, expiresAt }；插入序即 LRU 序
  return {
    get(key) {
      const e = map.get(key);
      if (e === undefined) return undefined;
      if (e.expiresAt <= Date.now()) {
        // 命中过期即删——过期产物（签名 URL 可能已死）不许流出，
        // 顺手摘键让槽位还给活跃键
        map.delete(key);
        return undefined;
      }
      // 命中挪尾成真 LRU——只读不挪会退化成 FIFO：热键照样按插入序被
      // 满容淘汰（gateCache/stream-vault resolve 同款 touch）。不刷
      // expiresAt——签名 URL 寿命钉死在写入时刻，读触延寿等于给死签名
      // 续期，超期放出的产物代理回源才 403
      map.delete(key);
      map.set(key, e);
      return e.value;
    },
    set(key, value) {
      // 已存在键先删再插做 LRU 挪尾——Map.set 对已存在 key 保留原插入位，
      // 刷新的热键不挪尾会被满容淘汰按「最早插入」先挤掉（gateCache 同款）
      if (map.has(key)) {
        map.delete(key);
      } else if (map.size >= max) {
        // 满容淘汰最旧——只删插入序头一个；过期键惰性读删已兜住量，
        // 不为省槽在写路径全表扫
        map.delete(map.keys().next().value);
      }
      map.set(key, { value, expiresAt: Date.now() + ttlMs });
    },
    delete(key) {
      return map.delete(key);
    },
    // 活迭代器——前缀扫键类调用方（forgetManualStream 的 `trackId|` 扫）
    // 自行 [...] 拍快照再消费，别在迭代中删键
    keys: () => map.keys(),
    get size() {
      return map.size;
    },
  };
}

module.exports = { createTtlCache };

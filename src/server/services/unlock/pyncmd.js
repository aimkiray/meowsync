// pyncmd 解锁源：GD Studio 的网易聚合 API——按网易 song id 直解回链
// （非搜索，零错配面），回链指向网易自家 *.music.126.net（已在代理白名单）。
// 替代 unm provider/pyncmd.js——原版即 ~30 行单请求，无保留库的必要。
// 注意这是第三方服务：回链属「攻击者可影响数据」，调用方的
// normalizeOutboundUrl + resolvesToPublicIp + 时长对账必须全套生效
const PYN_TIMEOUT_MS = 15000;
// 第三方 API 无合法跳转语义——redirect:'manual' 把 3xx 显式露给上层
// （res.ok=false → 「源失败换下一源」），不裸 follow 到被劫持的落点。
// 响应体量闸 2MB：{url,br,size} 合理上限远低于此——上游异常/被劫持回
// 大体积响应时不让它整坨进内存（lyric-external.js readJsonCapped 同款；
// 那边未导出故本地留一份最小实现）。无 stream 面（测试桩）退 res.json()
const PYN_MAX_BODY_BYTES = 2 * 1024 * 1024;
async function readJsonCapped(res) {
  const reader = res.body?.getReader?.();
  if (!reader) return res.json();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value?.byteLength || 0;
    if (size > PYN_MAX_BODY_BYTES) {
      try { await reader.cancel(); } catch { /* 拒收尽力而为 */ }
      throw new Error('pyncmd 响应体超限');
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8'));
}

/**
 * @param {{id: number|string}} info
 * @returns {{url: string, br: number|null}|null}
 */
async function resolve(info, { signal } = {}) {
  const res = await fetch(
    `https://music-api.gdstudio.xyz/api.php?types=url&source=netease&id=${encodeURIComponent(info.id)}&br=999`,
    {
      redirect: 'manual',
      signal: signal
        ? AbortSignal.any([AbortSignal.timeout(PYN_TIMEOUT_MS), signal])
        : AbortSignal.timeout(PYN_TIMEOUT_MS),
    },
  );
  if (!res.ok) throw new Error(`pyncmd HTTP ${res.status}`);
  const body = await readJsonCapped(res);
  if (body && typeof body === 'object' && body.br > 0 && typeof body.url === 'string' && body.url) {
    // size 一并透传：有它则下游时长对账免一次 HEAD RTT
    const size = Number.isFinite(body.size) && body.size > 0 ? body.size : undefined;
    return { url: body.url, br: body.br * 1000, size };
  }
  return null;
}

module.exports = { resolve, readJsonCapped };

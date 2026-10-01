// pyncmd 解锁源：GD Studio 的网易聚合 API——按网易 song id 直解回链
// （非搜索，零错配面），回链指向网易自家 *.music.126.net（已在代理白名单）。
// 替代 unm provider/pyncmd.js——原版即 ~30 行单请求，无保留库的必要。
// 注意这是第三方服务：回链属「攻击者可影响数据」，调用方的
// normalizeOutboundUrl + resolvesToPublicIp + 时长对账必须全套生效
const PYN_TIMEOUT_MS = 15000;

/**
 * @param {{id: number|string}} info
 * @returns {{url: string, br: number|null}|null}
 */
async function resolve(info, { signal } = {}) {
  const res = await fetch(
    `https://music-api.gdstudio.xyz/api.php?types=url&source=netease&id=${encodeURIComponent(info.id)}&br=999`,
    {
      signal: signal
        ? AbortSignal.any([AbortSignal.timeout(PYN_TIMEOUT_MS), signal])
        : AbortSignal.timeout(PYN_TIMEOUT_MS),
    },
  );
  if (!res.ok) throw new Error(`pyncmd HTTP ${res.status}`);
  const body = await res.json();
  if (body && typeof body === 'object' && body.br > 0 && typeof body.url === 'string' && body.url) {
    return { url: body.url, br: body.br * 1000 };
  }
  return null;
}

module.exports = { resolve };

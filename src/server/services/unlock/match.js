// 候选时长匹配——替代 unm provider/select.js 的弱实现
// （原版：前 5 条里第一个 |duration差|<5s 的，全不中退回 list[0]——
// 兜底形态正是错配主源）。本版：不达标直接不中选，错配风险由
// resolveSongUrls 的时长对账 + 下载端 durationLooksTruncated 双闸兜底
const DURATION_MATCH_TOLERANCE_SEC = 5;

/**
 * 候选按目标时长过滤（≤5s 差），全部不命中时若 durationMs 缺失才放行
 * 原序首条——未知基准下的「拿不到对账依据」比「随便选一条」更有信息量
 * @param {Array} cands
 * @param {number|null|undefined} durationMs 网易原始曲目时长（毫秒）
 * @param {(cand: any) => number|null|undefined} getSec 取候选秒数
 * @returns {Array} 按时长匹配过滤后的候选（保持原序）
 */
function pickByDuration(cands, durationMs, getSec) {
  if (!Array.isArray(cands) || !cands.length) return [];
  const targetSec = durationMs > 0 ? durationMs / 1000 : null;
  if (targetSec == null) return cands.slice(0, 3);
  const matched = cands.filter(c => {
    const sec = getSec(c);
    return Number.isFinite(sec) && Math.abs(sec - targetSec) <= DURATION_MATCH_TOLERANCE_SEC;
  });
  return matched;
}

module.exports = { pickByDuration, DURATION_MATCH_TOLERANCE_SEC };

// 候选时长匹配——替代 unm provider/select.js 的弱实现
// （原版：前 5 条里第一个 |duration差|<5s 的，全不中退回 list[0]——
// 兜底形态正是错配主源）。本版：不达标直接不中选，错配风险由
// resolveSongUrls 的时长对账 + 下载端 durationLooksTruncated 双闸兜底
const DURATION_MATCH_TOLERANCE_SEC = 5;

/**
 * 候选按目标时长过滤（≤5s 差），durationMs 缺失（无对账基准）时放行
 * 原序前 3 条——多候选交由下游时长对账/逐源试错兜底；基准存在但全部
 * 不命中则返回空（不回退首条——unm 的 list[0] 兜底是错配主源）
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

// ── 搜索真空降级词（youtube/bilibili 共用，勿双份复刻）───────────────
// 剥 info.name 尾段连续括号群（全/半角圆方尖）——
// 「ぱられループ を歌ってみた (2024 Radio Edit)」→「ぱられループ を歌ってみた」。
// 日系术力口/anisong 带版本后缀的检索词实测零命中，剥版本后缀后有命中希望。
// 只剥尾缀：词中括号是合法本名成分（feat./原名标注），剥中段反而跑偏；
// 括号群内不许再出现闭括号——嵌套/混排形态不匹配即不剥（保守）
const TRAIL_BRACKET_RE = /\s*[(\[（【][^)\]）】]*[)\]）】]\s*$/;
function degradedKeyword(info) {
  let name = String(info.name || '');
  for (;;) {
    const stripped = name.replace(TRAIL_BRACKET_RE, '');
    if (stripped === name) break;
    name = stripped;
  }
  // 剥掉括号后残留的分隔符（「曲名 - (Live)」→「曲名 -」→「曲名」）
  name = name.replace(/[\s\-–—]+$/, '');
  if (!name) return '';
  const artists = Array.isArray(info.artists) ? info.artists : [];
  return artists.length ? `${name} - ${artists.join(' / ')}` : name;
}

module.exports = { pickByDuration, degradedKeyword, DURATION_MATCH_TOLERANCE_SEC };

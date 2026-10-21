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

/**
 * 时长选候选的三态池（youtube/bilibili 共用的 pickByDuration 上层入口）：
 * - ±5s 筛命中 → {pool:命中集, arbitrated:false}——首选语义不变
 * - 筛空但候选在场 → {pool:全候选, arbitrated:true}——不弃池：±5s 硬筛
 *   比编排层真正的错配闸 DURATION_TOLERANCE（netease-api.js，youtube 0.4/
 *   其余 0.2 比例闸）严一个量级，官方 MV/搬运稿带几秒~十几秒片头尾常超窗
 *   却是真命候选（实机确诊假阴性：dt=258.5s 曲配 279s 官方上传——7.7%
 *   偏差过 0.4 闸却死在 ±5s）。全候选交 aiRankCandidates 语义仲裁——AI 的
 *   「官方音源/MV 可算，live/remix/翻唱/卡拉OK/短剪辑不算」判定本就是错配
 *   正主闸；下游时长对账仍是最终硬墙。pool 即 cands 本体，保 provider
 *   现有截断上限（youtube 5/bilibili 8），此处不再加闸
 * - cands 空 → {pool:[], arbitrated:false}——搜索真空无池可兜
 * - durationMs 缺席（无对账基准）→ pickByDuration 已回前 3 条，走首支
 *   arbitrated:false——仲裁语义不适用，行为与旧路径一致
 * @param {Array} cands
 * @param {number|null|undefined} durationMs 网易原始曲目时长（毫秒）
 * @param {(cand: any) => number|null|undefined} getSec 取候选秒数
 * @returns {{pool: Array, arbitrated: boolean}}
 *   arbitrated=true 时调用方须打一行留痕（诊断链不撒谎）并把全候选喂
 *   aiRankCandidates——verdict 记忆/死簿/全否冷却对该池照常生效
 */
function durationPool(cands, durationMs, getSec) {
  const pool = pickByDuration(cands, durationMs, getSec);
  if (pool.length) return { pool, arbitrated: false };
  // 走到这 = 时长筛产出空集。cands 空是搜索真空无池可兜；cands 非空则
  // durationMs 基准必定在场（缺席时 pickByDuration 回前 3 条非空，已在上行
  // 返回）——即 ±5s 全灭而候选在场，全候选兜底交 AI 仲裁
  if (!Array.isArray(cands) || !cands.length) return { pool: [], arbitrated: false };
  return { pool: cands, arbitrated: true };
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

module.exports = { pickByDuration, durationPool, degradedKeyword, DURATION_MATCH_TOLERANCE_SEC };

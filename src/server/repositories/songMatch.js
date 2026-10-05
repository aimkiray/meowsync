// song_match：外部源曲目 → 网易云词源的匹配缓存。track_id 即客户端曲目 id
// （bv_<bvid>[_pN] / yt_<videoId> / qq_<mid>）。
// netease_id NULL = 负缓存（「搜过但没中」），只在 TTL 内命中——上游曲库
// 会增补，永久负缓存会把后来入库的正主挡在门外；正向行永久（错配纠正走
// /match/retry 覆写而非自然过期）。
// model 键控与 lyricAi 同思路但读路径不对称：正行 ''=纯启发式永命中、AI
// 结果只在同模型下复用（换模型后旧判定作废重跑——模型升级正是为了改判定）；
// 负行必须 model 精确同模——无 AI 期攒的「搜不到」不该挡住配上 AI 后
// 本可救回的匹配，反之亦然（判定能力不同，负结论不互认）
const { getDb } = require('../db/client');

const NEGATIVE_TTL_DAYS = 7;

// 命中条件：正行 model='' OR model=?（currentModel 缺省=未配 AI）；负行
// model=? 精确同模且附加 updated_at freshness 闸
function getMatch(trackId, currentModel = '') {
  return getDb().prepare(`
    SELECT netease_id, matched_by, score, model, updated_at FROM song_match
    WHERE track_id = ?
      AND ((netease_id IS NOT NULL AND (model = '' OR model = ?))
           OR (netease_id IS NULL AND model = ?
               AND updated_at >= datetime('now', '-${NEGATIVE_TTL_DAYS} days')))
  `).get(trackId, currentModel || '', currentModel || '');
}

// 正/负统一 upsert：neteaseId null 即负缓存行；matchedBy 诊断列（值域同
// matchNeteaseSong 返回的 query）；score 取整落列
function upsertMatch(trackId, neteaseId, matchedBy, score, model = '') {
  getDb().prepare(`
    INSERT INTO song_match (track_id, netease_id, matched_by, score, model, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(track_id) DO UPDATE SET
      netease_id = excluded.netease_id,
      matched_by = excluded.matched_by,
      score = excluded.score,
      model = excluded.model,
      updated_at = excluded.updated_at
  `).run(trackId, neteaseId ?? null, matchedBy || '', score ?? null, model || '');
}

module.exports = { getMatch, upsertMatch, NEGATIVE_TTL_DAYS };

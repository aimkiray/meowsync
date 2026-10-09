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
// matchNeteaseSong 返回的 query）；score 取整落列。
// vetoed_json 刻意不出现在 INSERT 显式列与 UPDATE 清单——正/负行覆写
// 天然保留否决簿（新行吃 DEFAULT '[]'，冲突更新不动该列）；否决账的
// 写通道只有 mergeVetoed
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

// ── 跨会话否决簿（vetoed_json）────────────────────────────────────
// 「(源,候选) 判否不经任何路径复活」从单次运行升级为跨会话——会话级
// veto 簿蒸散导致的 A→B→A 乒乓（verify 判否→retry 换绑→下会话旧绑
// 复活）由持久簿收敛。条目 [{id:String, m:model, t:epoch秒}]：
//   id 一律 String 归一；m=否决落账时的匹配模型（''=无 AI 期，永生效——
//   verdict 本就 model 键控，换模重判是新判定窗口，旧 AI 否决随模失效）；
//   t 供 cap 挤出——按 t 降序截断留 50，同 (id,m) 复否只刷 t 不增条目
const VETOED_CAP = 50;

// 原始行直读：不套 getMatch 命中条件——写决策（条件化负行）要见「任何
// 形态的行」，含跨模/陈旧正行与 stub 行
function getMatchRow(trackId) {
  return getDb().prepare(`
    SELECT netease_id, vetoed_json, model, updated_at FROM song_match
    WHERE track_id = ?
  `).get(trackId);
}

// 坏 JSON/非数组归空簿——脏数据不炸读路径（mergeVetoed 写侧同口径，
// 遇脏直接重开一簿）
const parseVetoed = (json) => {
  try {
    const arr = JSON.parse(json || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
};

// 生效否决集：m===''（无 AI 期否决）永生效，m===currentModel 同模生效；
// currentModel 与 cachedMatch 读侧同口径（aiEnabled()?aiModel():''）
function getVetoedIds(trackId, currentModel = '') {
  const out = new Set();
  for (const e of parseVetoed(getMatchRow(trackId)?.vetoed_json)) {
    const id = e && e.id != null ? String(e.id) : '';
    const m = e?.m || '';   // 缺 m 的畸形条目按 '' 计——宁可生效不放过
    if (id && (m === '' || m === currentModel)) out.add(id);
  }
  return out;
}

// 否决落账：只动 vetoed_json——updated_at 绝不在 UPDATE 清单（负行
// freshness 闸靠它计时，刷它会搅浑负行 TTL 语义）；无匹配史的行插
// stub（netease_id NULL + updated_at=''——'' 不过负行 freshness 闸，
// 纯否决账永不作负行命中，无副作用）
function mergeVetoed(trackId, ids, model = '') {
  const add = [...new Set((Array.isArray(ids) ? ids : [])
    .map(x => String(x ?? '')).filter(Boolean))];
  if (!add.length) return;   // 空集落账=纯写放大——连 stub 行都不该产
  // 读侧回滤畸形条目：缺 id/t 的脏条不进合并集也不占 cap 位（t 是 cap
  // 挤出序的唯一依据）——与 getVetoedIds 读侧「缺 id 不生效」同口径
  const entries = parseVetoed(getMatchRow(trackId)?.vetoed_json)
    .filter(e => e && e.id != null && String(e.id) !== '' && Number.isFinite(e.t));
  const now = Math.floor(Date.now() / 1000);
  const m = model || '';
  for (const id of add) {
    // '' 覆盖全模型，簿内同 id 至多一条生效条目：
    //   - '' 到来时同化掉同 id 的 m≠'' 影子（上位语义吞并）；
    //   - '' 在簿时 m≠'' 落账被吸收为 '' 复否刷 t，不另立影子。
    // 否则影子凭新 t 会在 cap 截断（t 降序）时把 '' 永生效条目先挤出，
    // 换模后该否决整组蒸散——影子既冗余又有害
    if (m === '') {
      for (let i = entries.length - 1; i >= 0; i--) {
        if (String(entries[i].id) === id && (entries[i].m || '') !== '') {
          entries.splice(i, 1);
        }
      }
    }
    const hit = m === ''
      ? entries.find(e => String(e.id) === id)     // 影子已同化——剩 '' 或无
      : entries.find(e => String(e.id) === id && !(e.m || ''))
          || entries.find(e => String(e.id) === id && (e.m || '') === m);
    if (hit) hit.t = now;                     // 同生效位复否只刷 t
    else entries.push({ id, m, t: now });
  }
  entries.sort((a, b) => (b?.t || 0) - (a?.t || 0));
  getDb().prepare(`
    INSERT INTO song_match (track_id, netease_id, vetoed_json, updated_at)
    VALUES (?, NULL, ?, '')
    ON CONFLICT(track_id) DO UPDATE SET vetoed_json = excluded.vetoed_json
  `).run(trackId, JSON.stringify(entries.slice(0, VETOED_CAP)));
}

module.exports = {
  getMatch, upsertMatch, getMatchRow, getVetoedIds, mergeVetoed,
  NEGATIVE_TTL_DAYS, VETOED_CAP,
};

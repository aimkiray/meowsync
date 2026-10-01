// AI 歌词两张表的持久层：song_lyric_translation（译文/哨兵缓存，按词源 id）
// 与 song_ai_verdict（核验判定缓存，song_id 列存 vkey=<词源id>@<模型>@<源签名>）
const { getDb } = require('../db/client');

// 行存在即命中——skip 哨兵（tlyric=''）也是有效缓存项，防止 already-zh/
// 无词曲每次重播都重打上游 lyric。但 skip 是启发式判定的结果，给 7 天 TTL：
// 过期按未命中重判一次，避免一次瞬时误判被永久固化
function getCachedTranslation(songId) {
  return getDb().prepare(
    `SELECT tlyric FROM song_lyric_translation WHERE song_id = ?
     AND NOT (model LIKE 'skip:%' AND updated_at < datetime('now', '-7 days'))`
  ).get(songId);
}

function upsertTranslation(songId, tlyric, model) {
  getDb().prepare(`INSERT INTO song_lyric_translation (song_id, tlyric, model)
    VALUES (?, ?, ?) ON CONFLICT(song_id) DO UPDATE SET
    tlyric = excluded.tlyric, model = excluded.model, updated_at = CURRENT_TIMESTAMP`
  ).run(songId, tlyric, model);
}

// skip 哨兵写入：只在旧行也是 skip 时刷新续期——AI 产出的真译文不被哨兵覆盖
function markTranslationSkip(songId, reason) {
  getDb().prepare(
    `INSERT INTO song_lyric_translation (song_id, tlyric, model)
     VALUES (?, '', ?) ON CONFLICT(song_id) DO UPDATE SET
     model = excluded.model, updated_at = CURRENT_TIMESTAMP
     WHERE song_lyric_translation.model LIKE 'skip:%'`).run(songId, `skip:${reason}`);
}

function getLyricVerdict(vkey) {
  return getDb().prepare(
    "SELECT ok FROM song_ai_verdict WHERE song_id = ? AND kind = 'lyric'"
  ).get(vkey);
}

function upsertLyricVerdict(vkey, ok, detail) {
  getDb().prepare(`INSERT INTO song_ai_verdict (song_id, kind, ok, detail)
    VALUES (?, 'lyric', ?, ?) ON CONFLICT(song_id, kind) DO UPDATE SET
    ok = excluded.ok, detail = excluded.detail, updated_at = CURRENT_TIMESTAMP`
  ).run(vkey, ok ? 1 : 0, detail);
}

module.exports = {
  getCachedTranslation, upsertTranslation, markTranslationSkip,
  getLyricVerdict, upsertLyricVerdict,
};

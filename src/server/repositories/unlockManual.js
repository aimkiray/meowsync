// song_unlock_manual：手选播放源绑定表——用户在 /unlock/candidates 候选池
// 里点名挑的那条媒体（修「解锁链自动匹配到错翻唱/剪辑」），一首歌一条
// 当前绑定、重挑覆盖。只存指针不存回链：googlevideo/bilivideo 链是带签名
// +ip 绑定的易失品，落库即死链——每次播放经 provider.resolveById 现解。
// title/owner/duration_sec 是「绑定那一刻」的展示快照（媒体本体随时可能
// 下架/改题），非消费端真值
const { getDb } = require('../db/client');

// 返回 camelCase 行；无行 → null（调用方映射「未绑定」）
function getManual(songId) {
  const row = getDb()
    .prepare('SELECT source, media_id, title, owner, duration_sec, updated_at FROM song_unlock_manual WHERE song_id = ?')
    .get(songId);
  return row ? {
    source: row.source,
    mediaId: row.media_id,
    title: row.title,
    owner: row.owner,
    durationSec: row.duration_sec,
    updatedAt: row.updated_at,
  } : null;
}

function upsertManual(songId, { source, mediaId, title, owner, durationSec }) {
  getDb().prepare(`
    INSERT INTO song_unlock_manual (song_id, source, media_id, title, owner, duration_sec, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(song_id) DO UPDATE SET
      source = excluded.source, media_id = excluded.media_id,
      title = excluded.title, owner = excluded.owner,
      duration_sec = excluded.duration_sec,
      updated_at = excluded.updated_at
  `).run(songId, String(source), String(mediaId), String(title || ''),
    String(owner || ''),
    // duration_sec 非有限正数落 NULL——展示快照不谎报
    Number.isFinite(durationSec) && durationSec > 0 ? Math.round(durationSec) : null);
}

function deleteManual(songId) {
  getDb().prepare('DELETE FROM song_unlock_manual WHERE song_id = ?').run(songId);
}

module.exports = { getManual, upsertManual, deleteManual };

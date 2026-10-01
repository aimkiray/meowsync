// song_lyric_meta：歌词偏移校准表——只有「真正校准过」的歌有行
// （offsetMs=0 即恢复默认，走删行而非写 0）
const { getDb } = require('../db/client');

function getOffsetMs(songId) {
  const row = getDb()
    .prepare('SELECT offset_ms FROM song_lyric_meta WHERE song_id = ?')
    .get(songId);
  return row?.offset_ms ?? 0;
}

function upsertOffsetMs(songId, offsetMs) {
  getDb().prepare(`
    INSERT INTO song_lyric_meta (song_id, offset_ms, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(song_id) DO UPDATE SET
      offset_ms = excluded.offset_ms, updated_at = excluded.updated_at
  `).run(songId, offsetMs);
}

function deleteOffsetMs(songId) {
  getDb().prepare('DELETE FROM song_lyric_meta WHERE song_id = ?').run(songId);
}

module.exports = { getOffsetMs, upsertOffsetMs, deleteOffsetMs };

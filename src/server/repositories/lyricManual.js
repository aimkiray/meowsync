// song_lyric_manual：手选词源绑定表——用户在 /lyric/candidates 候选池里
// 点名挑的那条词（修同名错配/错词），一首歌一条当前绑定、重挑覆盖。
// 词文随绑定整存：kugou_ 词源的 accesskey 不落 ext_id（无 refetch 通道），
// 只存指针会在重读时拿不出词——与级联结果同构的 {lrc, plain, source,
// extId, synced} 全量落库
const { getDb } = require('../db/client');

// 返回与级联结果同构的 camelCase 行；无行 → null（调用方映射「未绑定」）
function getManual(songId) {
  const row = getDb()
    .prepare('SELECT ext_id, source, lrc, plain, synced FROM song_lyric_manual WHERE song_id = ?')
    .get(songId);
  return row ? {
    extId: row.ext_id,
    source: row.source,
    lrc: row.lrc,
    plain: row.plain,
    synced: Boolean(row.synced),
  } : null;
}

function upsertManual(songId, { extId, source, lrc, plain, synced }) {
  getDb().prepare(`
    INSERT INTO song_lyric_manual (song_id, ext_id, source, lrc, plain, synced, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(song_id) DO UPDATE SET
      ext_id = excluded.ext_id, source = excluded.source,
      lrc = excluded.lrc, plain = excluded.plain, synced = excluded.synced,
      updated_at = excluded.updated_at
  `).run(songId, String(extId), String(source), String(lrc || ''),
    String(plain || ''), synced ? 1 : 0);
}

function deleteManual(songId) {
  getDb().prepare('DELETE FROM song_lyric_manual WHERE song_id = ?').run(songId);
}

module.exports = { getManual, upsertManual, deleteManual };

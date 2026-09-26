const { getDb } = require('../db/client');

function replaceTracksForPlaylist(playlistId, tracks) {
  const db = getDb();
  const deleteStmt = db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ?');
  const insertStmt = db.prepare(`
    INSERT INTO playlist_tracks (
      playlist_id, song_id, name, artist_json, album_json, duration_ms, position, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const transaction = db.transaction(() => {
    deleteStmt.run(playlistId);
    // 上游曲目缺 id 时 String(undefined) 会写入 'undefined' 脏行——直接跳过
    const validTracks = tracks.filter(t => t && t.id !== undefined && t.id !== null);
    validTracks.forEach((track, index) => {
      insertStmt.run(
        playlistId,
        String(track.id),
        track.name || '未知歌曲',
        JSON.stringify(track.ar || track.artists || []),
        JSON.stringify(track.al || track.album || {}),
        track.dt || track.duration || 0,
        index,
        JSON.stringify(track)
      );
    });
  });

  transaction();
}

function listTracksByPlaylistId(playlistId) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT *
    FROM playlist_tracks
    WHERE playlist_id = ?
    ORDER BY position ASC
  `).all(playlistId);

  return rows.map(row => {
    // 单行 raw_json 损坏不该让整个歌单/建队列 500——退化到列字段重建
    let raw = {};
    try {
      raw = JSON.parse(row.raw_json || '{}');
    } catch { /* 损坏行用列字段兜底 */ }
    if (typeof raw !== 'object' || raw === null) raw = {};
    return {
      ...raw,
      id: raw.id ?? row.song_id,
      name: raw.name ?? row.name,
      ar: raw.ar || JSON.parse(row.artist_json || '[]'),
      al: raw.al || JSON.parse(row.album_json || '{}'),
      dt: raw.dt ?? row.duration_ms
    };
  });
}

module.exports = {
  replaceTracksForPlaylist,
  listTracksByPlaylistId
};
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
    // 上游曲目缺 id/空 id 会写入 'undefined'/'' 脏行——直接跳过
    const validTracks = tracks.filter(
      t => t && t.id !== undefined && t.id !== null && String(t.id) !== ''
    );
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

  const parseJsonColumn = (text, fallback) => {
    try {
      const parsed = JSON.parse(text || '');
      return parsed ?? fallback;
    } catch {
      return fallback;
    }
  };

  return rows.map(row => {
    // 单行 JSON 损坏不该让整个歌单/建队列 500——退化到列字段重建；
    // 非对象/非数组形态同理（下游会对 ar 跑 .filter 之类数组方法）
    const rawObj = parseJsonColumn(row.raw_json, {});
    const raw = typeof rawObj === 'object' ? rawObj : {};
    const artists = Array.isArray(raw.ar) ? raw.ar : parseJsonColumn(row.artist_json, []);
    const album = (raw.al && typeof raw.al === 'object') ? raw.al : parseJsonColumn(row.album_json, {});
    return {
      ...raw,
      id: raw.id ?? row.song_id,
      name: raw.name ?? row.name,
      ar: Array.isArray(artists) ? artists : [],
      al: (album && typeof album === 'object') ? album : {},
      dt: raw.dt ?? row.duration_ms
    };
  });
}

module.exports = {
  replaceTracksForPlaylist,
  listTracksByPlaylistId
};
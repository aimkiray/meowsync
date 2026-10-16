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

const parseJsonColumn = (text, fallback) => {
  try {
    const parsed = JSON.parse(text || '');
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
};

function trackFromRow(row) {
  // 单行 JSON 损坏不该让整个歌单/建队列 500——退化到列字段重建；
  // 非对象/非数组形态同理（下游会对 ar 跑 .filter 之类数组方法）
  const rawObj = parseJsonColumn(row.raw_json, {});
  const raw = typeof rawObj === 'object' ? rawObj : {};
  const artists = Array.isArray(raw.ar) ? raw.ar : parseJsonColumn(row.artist_json, []);
  const rawAlbum = (raw.al && typeof raw.al === 'object' && !Array.isArray(raw.al))
    ? raw.al : parseJsonColumn(row.album_json, {});
  const album = (rawAlbum && typeof rawAlbum === 'object' && !Array.isArray(rawAlbum))
    ? rawAlbum : {};
  return {
    ...raw,
    id: raw.id ?? row.song_id,
    name: raw.name ?? row.name,
    ar: Array.isArray(artists) ? artists : [],
    al: album,
    dt: raw.dt ?? row.duration_ms
  };
}

// 单条查询：retry 类路径只需要一首歌的镜像行，全表 list+parse 是 N+1
function findTrackBySongId(playlistId, songId) {
  const db = getDb();
  const row = db.prepare(`
    SELECT *
    FROM playlist_tracks
    WHERE playlist_id = ? AND song_id = ?
    ORDER BY position ASC
    LIMIT 1
  `).get(playlistId, String(songId));
  return row ? trackFromRow(row) : null;
}

function listTracksByPlaylistId(playlistId) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT *
    FROM playlist_tracks
    WHERE playlist_id = ?
    ORDER BY position ASC
  `).all(playlistId);

  return rows.map(trackFromRow);
}

// localDelta（远端单本地增删）落库原语——调用方负责包进事务：
// 同 (playlist_id, song_id) 行存在则刷新投影列、position 原位保留——
// 远端曲被本地编辑/补 provider 字段后重放不该把它挪到尾部；上游单可能重复
// 含同曲，同 id 行全刷保持投影一致。不存在则 append 到当前最大 position
// 之后——客户端渲染序即「追加尾」（[...visibleTracks, ...addedTracks]）
function upsertTrackForPlaylist(playlistId, track) {
  const db = getDb();
  const songId = String(track.id);
  const name = track.name || '未知歌曲';
  const artistJson = JSON.stringify(track.ar || track.artists || []);
  const albumJson = JSON.stringify(track.al || track.album || {});
  const durationMs = track.dt || track.duration || 0;
  const rawJson = JSON.stringify(track);
  // UPDATE 命中不改 local_added：撞同 id 的上游行（导入/镜像写入，标 0）
  // 仍是上游行——改标会让对账剪枝把远端曲当本地追加扫掉；已标 1 的
  // 追加行被重放也只刷新投影，标记照旧
  const updated = db.prepare(`
    UPDATE playlist_tracks
    SET name = ?, artist_json = ?, album_json = ?, duration_ms = ?, raw_json = ?
    WHERE playlist_id = ? AND song_id = ?
  `).run(name, artistJson, albumJson, durationMs, rawJson, playlistId, songId);
  if (updated.changes > 0) return false;
  const { nextPos } = db.prepare(`
    SELECT COALESCE(MAX(position), -1) + 1 AS nextPos
    FROM playlist_tracks
    WHERE playlist_id = ?
  `).get(playlistId);
  db.prepare(`
    INSERT INTO playlist_tracks (
      playlist_id, song_id, name, artist_json, album_json, duration_ms, position, local_added, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(playlistId, songId, name, artistJson, albumJson, durationMs, nextPos, rawJson);
  return true;
}

// localDelta 对账剪枝：addedTracks 是客户端本地追加面的权威全集——标过
// local_added=1 却不在本批 keep 集里的行即「用户已删掉的追加曲」（客户端
// 只剪数组不补墓碑），物理删行清出队列枚举。上游行（标 0）永不在打击面。
// 不碰 download_tasks/盘上文件——已下完的工件归文件域管
function pruneLocalAddedTracks(playlistId, keepSongIds) {
  const db = getDb();
  const keep = (Array.isArray(keepSongIds) ? keepSongIds : []).map(String);
  // NOT IN () 是非法 SQL——空集语义=清掉全部标记行，单独分支
  if (!keep.length) {
    return db.prepare(`
      DELETE FROM playlist_tracks
      WHERE playlist_id = ? AND local_added = 1
    `).run(playlistId).changes;
  }
  const placeholders = keep.map(() => '?').join(',');
  return db.prepare(`
    DELETE FROM playlist_tracks
    WHERE playlist_id = ? AND local_added = 1 AND song_id NOT IN (${placeholders})
  `).run(playlistId, ...keep).changes;
}

module.exports = {
  replaceTracksForPlaylist,
  listTracksByPlaylistId,
  findTrackBySongId,
  upsertTrackForPlaylist,
  pruneLocalAddedTracks
};

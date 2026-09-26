const { getDb } = require('../db/client');

function mapPlaylistRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    neteasePlaylistId: row.netease_playlist_id,
    name: row.name,
    coverImgUrl: row.cover_img_url,
    creator: { nickname: row.creator_nickname || '未知创建者' },
    trackCount: row.track_count,
    source: row.source,
    isDefault: Boolean(row.is_default),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSyncedAt: row.last_synced_at
  };
}

function listPlaylists() {
  const db = getDb();
  const rows = db.prepare(`
    SELECT *
    FROM playlists
    ORDER BY datetime(updated_at) DESC, id DESC
  `).all();
  return rows.map(mapPlaylistRow);
}

function findPlaylistById(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM playlists WHERE id = ?').get(id);
  return mapPlaylistRow(row);
}

function findPlaylistByNeteaseId(neteasePlaylistId) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM playlists WHERE netease_playlist_id = ?').get(String(neteasePlaylistId));
  return mapPlaylistRow(row);
}

function upsertPlaylist(input) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO playlists (
      netease_playlist_id, name, cover_img_url, creator_nickname, track_count, source, is_default, updated_at, last_synced_at
    ) VALUES (
      @netease_playlist_id, @name, @cover_img_url, @creator_nickname, @track_count, @source, @is_default, @updated_at, @last_synced_at
    )
    ON CONFLICT(netease_playlist_id) DO UPDATE SET
      name = excluded.name,
      cover_img_url = excluded.cover_img_url,
      creator_nickname = excluded.creator_nickname,
      track_count = excluded.track_count,
      source = excluded.source,
      -- 重复导入/刷新不带 isDefault 时不得清掉已有的默认标记
      is_default = CASE WHEN excluded.is_default = 1 THEN 1 ELSE playlists.is_default END,
      updated_at = excluded.updated_at,
      last_synced_at = excluded.last_synced_at
  `).run({
    netease_playlist_id: String(input.neteasePlaylistId),
    name: input.name,
    cover_img_url: input.coverImgUrl || '',
    creator_nickname: input.creatorNickname || '',
    track_count: input.trackCount || 0,
    source: input.source || 'netease',
    is_default: input.isDefault ? 1 : 0,
    updated_at: now,
    last_synced_at: now
  });

  return findPlaylistByNeteaseId(input.neteasePlaylistId);
}

function deletePlaylist(id) {
  const db = getDb();
  const result = db.prepare('DELETE FROM playlists WHERE id = ?').run(id);
  return result.changes > 0;
}

module.exports = {
  listPlaylists,
  findPlaylistById,
  findPlaylistByNeteaseId,
  upsertPlaylist,
  deletePlaylist
};
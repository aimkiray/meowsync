const { getDb } = require('../db/client');

function mapQueueRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    playlistId: row.playlist_id,
    name: row.name,
    status: row.status,
    totalTasks: row.total_tasks,
    completedTasks: row.completed_tasks,
    failedTasks: row.failed_tasks,
    concurrentLimit: row.concurrent_limit,
    bitrate: row.bitrate,
    downloadAudio: Boolean(row.download_audio),
    downloadLyrics: Boolean(row.download_lyrics),
    downloadCover: Boolean(row.download_cover),
    // 歌单封面 URL（前端 getQueueCover 直接用作 img src）
    coverImgUrl: row.cover_img_url || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at
  };
}

function createQueue(input) {
  const db = getDb();
  const now = new Date().toISOString();

  const result = db.prepare(`
    INSERT INTO download_queues (
      playlist_id, name, status, total_tasks,
      concurrent_limit, bitrate, download_audio, download_lyrics, download_cover,
      created_at, updated_at
    ) VALUES (
      @playlist_id, @name, @status, @total_tasks,
      @concurrent_limit, @bitrate, @download_audio, @download_lyrics, @download_cover,
      @created_at, @updated_at
    )
  `).run({
    playlist_id: input.playlistId,
    name: input.name,
    status: input.status || 'pending',
    total_tasks: input.totalTasks || 0,
    concurrent_limit: input.concurrentLimit || 3,
    bitrate: input.bitrate || 320000,
    download_audio: input.downloadAudio ? 1 : 0,
    download_lyrics: input.downloadLyrics ? 1 : 0,
    download_cover: input.downloadCover ? 1 : 0,
    created_at: now,
    updated_at: now
  });

  return findQueueById(result.lastInsertRowid);
}

function updateQueue(id, updates) {
  const db = getDb();
  const now = new Date().toISOString();

  const fields = [];
  const params = { id };

  if (updates.status !== undefined) {
    fields.push('status = @status');
    params.status = updates.status;
  }
  // 计数列刻意不接受写入：total/completed/failed 一律由
  // download-manager 的 recountQueueCounters 从任务行状态派生，
  // 手工写计数正是这批重构消除的漂移面
  if (updates.completedAt !== undefined) {
    fields.push('completed_at = @completed_at');
    params.completed_at = updates.completedAt;
  }

  fields.push('updated_at = @updated_at');
  params.updated_at = now;

  if (fields.length === 1) return findQueueById(id);

  db.prepare(`
    UPDATE download_queues
    SET ${fields.join(', ')}
    WHERE id = @id
  `).run(params);

  return findQueueById(id);
}

function findQueueById(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM download_queues WHERE id = ?').get(id);
  return mapQueueRow(row);
}

function listQueues() {
  const db = getDb();
  const rows = db.prepare(`
    SELECT q.*, p.cover_img_url
    FROM download_queues q
    LEFT JOIN playlists p ON p.id = q.playlist_id
    ORDER BY datetime(q.created_at) DESC
  `).all();
  return rows.map(mapQueueRow);
}

function deleteQueue(id) {
  const db = getDb();
  db.prepare('DELETE FROM download_queues WHERE id = ?').run(id);
}

function listQueuesByPlaylist(playlistId) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT q.*, p.cover_img_url
    FROM download_queues q
    LEFT JOIN playlists p ON p.id = q.playlist_id
    WHERE q.playlist_id = ?
    ORDER BY datetime(q.created_at) DESC
  `).all(playlistId);
  return rows.map(mapQueueRow);
}

function deleteQueuesByPlaylist(playlistId) {
  const db = getDb();
  db.prepare('DELETE FROM download_queues WHERE playlist_id = ?').run(playlistId);
}

// 任务计数器无手工增减 API：一律由 download-manager 的 recountQueueCounters
// 用状态派生的子查询重算（手工配对增减在任何异常路径漏配即永久漂移）
module.exports = {
  createQueue,
  updateQueue,
  findQueueById,
  listQueues,
  listQueuesByPlaylist,
  deleteQueue,
  deleteQueuesByPlaylist
};

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
  if (updates.totalTasks !== undefined) {
    fields.push('total_tasks = @total_tasks');
    params.total_tasks = updates.totalTasks;
  }
  if (updates.completedTasks !== undefined) {
    fields.push('completed_tasks = @completed_tasks');
    params.completed_tasks = updates.completedTasks;
  }
  if (updates.failedTasks !== undefined) {
    fields.push('failed_tasks = @failed_tasks');
    params.failed_tasks = updates.failedTasks;
  }
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

function decrementCompleted(id, amount = 1) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE download_queues
    SET completed_tasks = MAX(completed_tasks - ?, 0),
        updated_at = ?
    WHERE id = ?
  `).run(amount, now, id);
  return findQueueById(id);
}

function decrementTotal(id, amount = 1) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE download_queues
    SET total_tasks = MAX(total_tasks - ?, 0),
        updated_at = ?
    WHERE id = ?
  `).run(amount, now, id);
  return findQueueById(id);
}

function incrementCompleted(id) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE download_queues
    SET completed_tasks = completed_tasks + 1,
        updated_at = ?
    WHERE id = ?
  `).run(now, id);
  return findQueueById(id);
}

function incrementFailed(id) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE download_queues
    SET failed_tasks = failed_tasks + 1,
        updated_at = ?
    WHERE id = ?
  `).run(now, id);
  return findQueueById(id);
}

function decrementFailed(id, amount = 1) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE download_queues
    SET failed_tasks = MAX(failed_tasks - ?, 0),
        updated_at = ?
    WHERE id = ?
  `).run(amount, now, id);
  return findQueueById(id);
}

module.exports = {
  createQueue,
  updateQueue,
  findQueueById,
  listQueues,
  deleteQueue,
  incrementCompleted,
  decrementCompleted,
  decrementTotal,
  incrementFailed,
  decrementFailed
};

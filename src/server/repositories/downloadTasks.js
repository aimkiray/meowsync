const { getDb } = require('../db/client');

function mapTaskRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    playlistId: row.playlist_id,
    queueId: row.queue_id,
    songId: row.song_id,
    songName: row.song_name,
    artist: row.artist,
    album: row.album,
    coverUrl: row.cover_url,
    status: row.status,
    progress: row.progress,
    errorMessage: row.error_message,
    retryCount: row.retry_count,
    downloadAudio: Boolean(row.download_audio),
    downloadLyrics: Boolean(row.download_lyrics),
    downloadCover: Boolean(row.download_cover),
    audioPath: row.audio_path,
    lyricsPath: row.lyrics_path,
    coverPath: row.cover_path,
    bitrate: row.bitrate,
    fileSize: row.file_size,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at
  };
}

function createTask(input) {
  const db = getDb();
  const now = new Date().toISOString();

  const result = db.prepare(`
    INSERT INTO download_tasks (
      playlist_id, queue_id, song_id, song_name, artist, album, cover_url,
      status, progress, download_audio, download_lyrics, download_cover,
      bitrate, duration_ms, created_at, updated_at
    ) VALUES (
      @playlist_id, @queue_id, @song_id, @song_name, @artist, @album, @cover_url,
      @status, @progress, @download_audio, @download_lyrics, @download_cover,
      @bitrate, @duration_ms, @created_at, @updated_at
    )
  `).run({
    playlist_id: input.playlistId,
    queue_id: input.queueId || null,
    song_id: input.songId,
    song_name: input.songName,
    artist: input.artist,
    album: input.album || null,
    cover_url: input.coverUrl || null,
    status: input.status || 'pending',
    progress: input.progress || 0,
    download_audio: input.downloadAudio ? 1 : 0,
    download_lyrics: input.downloadLyrics ? 1 : 0,
    download_cover: input.downloadCover ? 1 : 0,
    bitrate: input.bitrate || 320000,
    duration_ms: input.durationMs || 0,
    created_at: now,
    updated_at: now
  });

  return findTaskById(result.lastInsertRowid);
}

function updateTask(id, updates) {
  const db = getDb();
  const now = new Date().toISOString();

  const fields = [];
  const params = { id };

  if (updates.queueId !== undefined) {
    fields.push('queue_id = @queue_id');
    params.queue_id = updates.queueId;
  }
  if (updates.status !== undefined) {
    fields.push('status = @status');
    params.status = updates.status;
  }
  if (updates.progress !== undefined) {
    fields.push('progress = @progress');
    params.progress = updates.progress;
  }
  if (updates.errorMessage !== undefined) {
    fields.push('error_message = @error_message');
    params.error_message = updates.errorMessage;
  }
  if (updates.retryCount !== undefined) {
    fields.push('retry_count = @retry_count');
    params.retry_count = updates.retryCount;
  }
  if (updates.audioPath !== undefined) {
    fields.push('audio_path = @audio_path');
    params.audio_path = updates.audioPath;
  }
  if (updates.lyricsPath !== undefined) {
    fields.push('lyrics_path = @lyrics_path');
    params.lyrics_path = updates.lyricsPath;
  }
  if (updates.coverPath !== undefined) {
    fields.push('cover_path = @cover_path');
    params.cover_path = updates.coverPath;
  }
  if (updates.fileSize !== undefined) {
    fields.push('file_size = @file_size');
    params.file_size = updates.fileSize;
  }
  if (updates.completedAt !== undefined) {
    fields.push('completed_at = @completed_at');
    params.completed_at = updates.completedAt;
  }

  fields.push('updated_at = @updated_at');
  params.updated_at = now;

  if (fields.length === 1) return findTaskById(id);

  db.prepare(`
    UPDATE download_tasks
    SET ${fields.join(', ')}
    WHERE id = @id
  `).run(params);

  return findTaskById(id);
}

function findTaskById(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM download_tasks WHERE id = ?').get(id);
  return mapTaskRow(row);
}

function listTasksByPlaylist(playlistId) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM download_tasks
    WHERE playlist_id = ?
    ORDER BY id ASC
  `).all(playlistId);
  return rows.map(mapTaskRow);
}

function listTasksByQueue(queueId) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM download_tasks
    WHERE queue_id = ?
    ORDER BY id ASC
  `).all(queueId);
  return rows.map(mapTaskRow);
}

function listStandaloneTasksByPlaylist(playlistId) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM download_tasks
    WHERE playlist_id = ? AND queue_id IS NULL
    ORDER BY id ASC
  `).all(playlistId);
  return rows.map(mapTaskRow);
}

function listTasksByStatus(status) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM download_tasks
    WHERE status = ?
    ORDER BY id ASC
  `).all(status);
  return rows.map(mapTaskRow);
}

function deleteTask(id) {
  const db = getDb();
  db.prepare('DELETE FROM download_tasks WHERE id = ?').run(id);
}

function deleteTasksByQueue(queueId) {
  const db = getDb();
  db.prepare('DELETE FROM download_tasks WHERE queue_id = ?').run(queueId);
}

function findTaskByQueueAndSongId(queueId, songId) {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM download_tasks
    WHERE queue_id = ? AND song_id = ?
  `).get(queueId, songId);
  return mapTaskRow(row);
}

function findTaskByPlaylistAndSongId(playlistId, songId) {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM download_tasks
    WHERE playlist_id = ? AND queue_id IS NULL AND song_id = ?
  `).get(playlistId, songId);
  return mapTaskRow(row);
}

function countTasksByQueueAndStatus(queueId) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT status, COUNT(*) as count
    FROM download_tasks
    WHERE queue_id = ?
    GROUP BY status
  `).all(queueId);

  const result = {
    pending: 0,
    downloading: 0,
    completed: 0,
    failed: 0
  };

  rows.forEach(row => {
    result[row.status] = row.count;
  });

  return result;
}

module.exports = {
  createTask,
  updateTask,
  findTaskById,
  listTasksByPlaylist,
  listStandaloneTasksByPlaylist,
  listTasksByQueue,
  listTasksByStatus,
  deleteTask,
  deleteTasksByQueue,
  findTaskByQueueAndSongId,
  findTaskByPlaylistAndSongId,
  countTasksByQueueAndStatus
};

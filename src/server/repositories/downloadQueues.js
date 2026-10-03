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
    downloadVideo: Boolean(row.download_video),
    // 歌单封面 URL（前端 getQueueCover 直接用作 img src）
    coverImgUrl: row.cover_img_url || '',
    // 侧栏歌单身份：远端单=网易云数字 id，本地镜像单=local_pl_* 原文——
    // 前端深链 ?view=downloads&pl= 按它把队列映射回侧栏歌单
    neteasePlaylistId: row.netease_playlist_id ?? null,
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
      concurrent_limit, bitrate, download_audio, download_lyrics, download_cover, download_video,
      created_at, updated_at
    ) VALUES (
      @playlist_id, @name, @status, @total_tasks,
      @concurrent_limit, @bitrate, @download_audio, @download_lyrics, @download_cover, @download_video,
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
    download_video: input.downloadVideo ? 1 : 0,
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
  // 队列复活（终态行原地重用）需要回写名称与下载选项——
  // 计数列仍刻意不接受写入：total/completed/failed 一律由
  // download-manager 的 recountQueueCounters 从任务行状态派生，
  // 手工写计数正是这批重构消除的漂移面
  if (updates.name !== undefined) {
    fields.push('name = @name');
    params.name = updates.name;
  }
  if (updates.bitrate !== undefined) {
    if (!Number.isInteger(updates.bitrate) || updates.bitrate <= 0) {
      throw new Error('bitrate 必须是正整数');
    }
    fields.push('bitrate = @bitrate');
    params.bitrate = updates.bitrate;
  }
  if (updates.downloadAudio !== undefined) {
    fields.push('download_audio = @download_audio');
    params.download_audio = updates.downloadAudio ? 1 : 0;
  }
  if (updates.downloadLyrics !== undefined) {
    fields.push('download_lyrics = @download_lyrics');
    params.download_lyrics = updates.downloadLyrics ? 1 : 0;
  }
  if (updates.downloadCover !== undefined) {
    fields.push('download_cover = @download_cover');
    params.download_cover = updates.downloadCover ? 1 : 0;
  }
  if (updates.downloadVideo !== undefined) {
    fields.push('download_video = @download_video');
    params.download_video = updates.downloadVideo ? 1 : 0;
  }
  if (updates.concurrentLimit !== undefined) {
    if (!Number.isInteger(updates.concurrentLimit) || updates.concurrentLimit <= 0) {
      throw new Error('concurrentLimit 必须是正整数');
    }
    fields.push('concurrent_limit = @concurrent_limit');
    params.concurrent_limit = updates.concurrentLimit;
  }
  if (updates.completedAt !== undefined) {
    fields.push('completed_at = @completed_at');
    params.completed_at = updates.completedAt;
  }
  // 复活视作"新活动"：刷新 created_at 让行在 created_at DESC 的列表里浮顶
  if (updates.createdAt !== undefined) {
    fields.push('created_at = @created_at');
    params.created_at = updates.createdAt;
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
  // 与 listQueues 同形 JOIN：selectedQueue 快照若缺 cover_img_url/
  // netease_playlist_id，DownloadsPanel 轮询刷新会把封面冲空、深链预选失锚
  const row = db.prepare(`
    SELECT q.*, p.cover_img_url, p.netease_playlist_id
    FROM download_queues q
    LEFT JOIN playlists p ON p.id = q.playlist_id
    WHERE q.id = ?
  `).get(id);
  return mapQueueRow(row);
}

function listQueues() {
  const db = getDb();
  const rows = db.prepare(`
    SELECT q.*, p.cover_img_url, p.netease_playlist_id
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
  deleteQueue,
  deleteQueuesByPlaylist
};

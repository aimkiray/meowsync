const { Hono } = require('hono');
const downloadManager = require('../services/download-manager');
const downloadQueuesRepo = require('../repositories/downloadQueues');
const downloadTasksRepo = require('../repositories/downloadTasks');

const app = new Hono();

app.post('/downloads/queues', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { playlistId, bitrate, downloadAudio, downloadLyrics, downloadCover, concurrentLimit } = body;

    if (!playlistId) {
      return c.json({ error: '缺少 playlistId 参数' }, 400);
    }

    const queue = await downloadManager.createDownloadQueue(playlistId, {
      bitrate: bitrate || 320000,
      downloadAudio: downloadAudio !== false,
      downloadLyrics: downloadLyrics !== false,
      downloadCover: downloadCover !== false,
      concurrentLimit: concurrentLimit || 3
    });

    return c.json({ code: 200, data: queue });
  } catch (error) {
    console.error('创建下载队列失败:', error);
    return c.json({ error: error.message }, 500);
  }
});

app.get('/downloads/queues', async (c) => {
  try {
    const queues = downloadQueuesRepo.listQueues();
    return c.json({ code: 200, data: queues });
  } catch (error) {
    console.error('获取队列列表失败:', error);
    return c.json({ error: error.message }, 500);
  }
});

app.get('/downloads/queues/:id', async (c) => {
  try {
    const queueId = parseInt(c.req.param('id'));
    const progress = downloadManager.getQueueProgress(queueId);
    return c.json({ code: 200, data: progress });
  } catch (error) {
    console.error('获取队列详情失败:', error);
    return c.json({ error: error.message }, 500);
  }
});

app.post('/downloads/queues/:id/start', async (c) => {
  try {
    const queueId = parseInt(c.req.param('id'));
    const queue = await downloadManager.startQueue(queueId);
    return c.json({ code: 200, data: queue });
  } catch (error) {
    console.error('启动队列失败:', error);
    return c.json({ error: error.message }, 500);
  }
});

app.post('/downloads/queues/:id/pause', async (c) => {
  try {
    const queueId = parseInt(c.req.param('id'));
    const queue = await downloadManager.pauseQueue(queueId);
    return c.json({ code: 200, data: queue });
  } catch (error) {
    console.error('暂停队列失败:', error);
    return c.json({ error: error.message }, 500);
  }
});

app.post('/downloads/queues/:id/resume', async (c) => {
  try {
    const queueId = parseInt(c.req.param('id'));
    const queue = await downloadManager.resumeQueue(queueId);
    return c.json({ code: 200, data: queue });
  } catch (error) {
    console.error('恢复队列失败:', error);
    return c.json({ error: error.message }, 500);
  }
});

app.post('/downloads/queues/:id/retry', async (c) => {
  try {
    const queueId = parseInt(c.req.param('id'));
    const queue = await downloadManager.retryQueue(queueId);
    return c.json({ code: 200, data: queue });
  } catch (error) {
    console.error('重试队列失败:', error);
    return c.json({ error: error.message }, 500);
  }
});

app.delete('/downloads/queues/:id', async (c) => {
  try {
    const queueId = parseInt(c.req.param('id'));
    await downloadManager.cancelQueue(queueId);
    downloadQueuesRepo.deleteQueue(queueId);
    return c.json({ code: 200, message: '队列已删除' });
  } catch (error) {
    console.error('删除队列失败:', error);
    return c.json({ error: error.message }, 500);
  }
});

app.get('/downloads/tasks', async (c) => {
  try {
    const { playlistId, queueId, status } = c.req.query();

    let tasks;
    if (queueId) {
      tasks = downloadTasksRepo.listTasksByQueue(parseInt(queueId));
    } else if (playlistId) {
      tasks = downloadTasksRepo.listTasksByPlaylist(parseInt(playlistId));
    } else if (status) {
      tasks = downloadTasksRepo.listTasksByStatus(status);
    } else {
      return c.json({ error: '需要提供 playlistId、queueId 或 status 参数' }, 400);
    }

    return c.json({ code: 200, data: tasks });
  } catch (error) {
    console.error('获取任务列表失败:', error);
    return c.json({ error: error.message }, 500);
  }
});

app.get('/downloads/tasks/:id', async (c) => {
  try {
    const taskId = parseInt(c.req.param('id'));
    const task = downloadTasksRepo.findTaskById(taskId);

    if (!task) {
      return c.json({ error: '任务不存在' }, 404);
    }

    return c.json({ code: 200, data: task });
  } catch (error) {
    console.error('获取任务详情失败:', error);
    return c.json({ error: error.message }, 500);
  }
});

app.post('/downloads/tasks/:id/retry', async (c) => {
  try {
    const taskId = parseInt(c.req.param('id'));
    const task = await downloadManager.retryTask(taskId);
    return c.json({ code: 200, data: task });
  } catch (error) {
    console.error('重试任务失败:', error);
    return c.json({ error: error.message }, 500);
  }
});

app.delete('/downloads/tasks/:id', async (c) => {
  try {
    const taskId = parseInt(c.req.param('id'));
    downloadTasksRepo.deleteTask(taskId);
    return c.json({ code: 200, message: '任务已删除' });
  } catch (error) {
    console.error('删除任务失败:', error);
    return c.json({ error: error.message }, 500);
  }
});

// 下载单首歌曲到服务器
app.post('/downloads/songs/:songId', async (c) => {
  try {
    const songId = c.req.param('songId');
    const body = await c.req.json().catch(() => ({}));
    const { playlistId, bitrate, downloadAudio, downloadLyrics, downloadCover } = body;

    if (!playlistId) {
      return c.json({ error: '缺少 playlistId 参数' }, 400);
    }

    const task = await downloadManager.downloadSingleSong(playlistId, songId, {
      bitrate: bitrate || 320000,
      downloadAudio: downloadAudio !== false,
      downloadLyrics: downloadLyrics !== false,
      downloadCover: downloadCover !== false
    });

    return c.json({ code: 200, data: task });
  } catch (error) {
    console.error('下载歌曲失败:', error);
    return c.json({ error: error.message }, 500);
  }
});

// 查询歌曲下载状态
app.get('/downloads/songs/:songId/status', async (c) => {
  try {
    const songId = c.req.param('songId');
    const { playlistId } = c.req.query();

    if (!playlistId) {
      return c.json({ error: '缺少 playlistId 参数' }, 400);
    }

    const status = await downloadManager.getSongDownloadStatus(parseInt(playlistId), songId);
    return c.json({ code: 200, data: status });
  } catch (error) {
    console.error('查询下载状态失败:', error);
    return c.json({ error: error.message }, 500);
  }
});

// 删除已下载的歌曲文件
app.delete('/downloads/songs/:songId', async (c) => {
  try {
    const songId = c.req.param('songId');
    const { playlistId } = c.req.query();

    if (!playlistId) {
      return c.json({ error: '缺少 playlistId 参数' }, 400);
    }

    const result = await downloadManager.deleteSongFiles(parseInt(playlistId), songId);
    return c.json({ code: 200, data: result });
  } catch (error) {
    console.error('删除文件失败:', error);
    return c.json({ error: error.message }, 500);
  }
});

// 删除歌单已下载歌曲文件
app.delete('/downloads/playlists/:playlistId/files', async (c) => {
  try {
    const playlistId = parseInt(c.req.param('playlistId'));
    const result = await downloadManager.deletePlaylistDownloadedFiles(playlistId);
    return c.json({ code: 200, data: result });
  } catch (error) {
    console.error('批量删除歌单已下载文件失败:', error);
    return c.json({ error: error.message }, 500);
  }
});

// 快速创建并启动歌单下载
app.post('/downloads/playlists/:playlistId/quick', async (c) => {
  try {
    const playlistId = parseInt(c.req.param('playlistId'));
    const body = await c.req.json().catch(() => ({}));
    const { bitrate, downloadAudio, downloadLyrics, downloadCover, concurrentLimit } = body;

    // 创建队列
    const queue = await downloadManager.createDownloadQueue(playlistId, {
      bitrate: bitrate || 320000,
      downloadAudio: downloadAudio !== false,
      downloadLyrics: downloadLyrics !== false,
      downloadCover: downloadCover !== false,
      concurrentLimit: concurrentLimit || 3
    });

    // 立即启动
    await downloadManager.startQueue(queue.id);

    return c.json({ code: 200, data: queue });
  } catch (error) {
    console.error('快速下载失败:', error);
    return c.json({ error: error.message }, 500);
  }
});

module.exports = app;

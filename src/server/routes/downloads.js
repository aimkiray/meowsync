const { Hono } = require('hono');
const downloadManager = require('../services/download-manager');
const downloadQueuesRepo = require('../repositories/downloadQueues');
const downloadTasksRepo = require('../repositories/downloadTasks');
// 读流按字节硬截断：chunked/无 Content-Length 请求不会被声明值检查拦住
const { readJsonBody } = require('../lib/http-body');
const { fail, handleError } = require('../lib/http-error');

const app = new Hono();

// 路由 :id 参数统一校验：只收纯十进制数字——Number() 会放过 '1e5'/'0x10'/' 3 '
// 这类脏输入，parseInt 又会截断 '12abc'，两者都得拦
function parseIdParam(c, name = 'id') {
  const raw = c.req.param(name);
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}



// 队列/单曲下载的可选参数规范化：脏值回落默认，concurrentLimit 限定 1-10
function normalizeDownloadOptions(body) {
  const { bitrate, downloadAudio, downloadLyrics, downloadCover, concurrentLimit } = body;
  return {
    // 网易云端常见码率 128k-999k：越界值静默回落默认（上游要么忽略要么产空文件）
    bitrate: Number.isInteger(bitrate) && bitrate >= 64000 && bitrate <= 999000 ? bitrate : 320000,
    downloadAudio: downloadAudio !== false,
    downloadLyrics: downloadLyrics !== false,
    downloadCover: downloadCover !== false,
    concurrentLimit: Number.isInteger(concurrentLimit)
      ? Math.min(Math.max(concurrentLimit, 1), 10)
      : 3
  };
}

app.post('/downloads/queues', async (c) => {
  try {
    const body = await readJsonBody(c);
    if (body.playlistId === undefined || body.playlistId === null || body.playlistId === '') {
      return fail(c, 400, '缺少 playlistId 参数');
    }

    const queue = await downloadManager.createDownloadQueue(body.playlistId, normalizeDownloadOptions(body));
    return c.json({ code: 200, data: queue });
  } catch (error) {
    return handleError(c, error, '创建下载队列失败');
  }
});

app.get('/downloads/queues', async (c) => {
  try {
    const queues = downloadQueuesRepo.listQueues();
    return c.json({ code: 200, data: queues });
  } catch (error) {
    return handleError(c, error, '获取队列列表失败');
  }
});

app.get('/downloads/queues/:id', async (c) => {
  try {
    const queueId = parseIdParam(c);
    if (queueId === null) {
      return fail(c, 400, '无效的队列 ID');
    }
    const progress = downloadManager.getQueueProgress(queueId);
    // 任务对象的路径字段透出前相对化——见 download-manager.toPublicTask
    return c.json({ code: 200, data: {
      ...progress,
      tasks: progress.tasks.map(downloadManager.toPublicTask)
    } });
  } catch (error) {
    return handleError(c, error, '获取队列详情失败');
  }
});

app.post('/downloads/queues/:id/start', async (c) => {
  try {
    const queueId = parseIdParam(c);
    if (queueId === null) {
      return fail(c, 400, '无效的队列 ID');
    }
    const queue = await downloadManager.startQueue(queueId);
    return c.json({ code: 200, data: queue });
  } catch (error) {
    return handleError(c, error, '启动队列失败');
  }
});

app.post('/downloads/queues/:id/pause', async (c) => {
  try {
    const queueId = parseIdParam(c);
    if (queueId === null) {
      return fail(c, 400, '无效的队列 ID');
    }
    const queue = await downloadManager.pauseQueue(queueId);
    return c.json({ code: 200, data: queue });
  } catch (error) {
    return handleError(c, error, '暂停队列失败');
  }
});

app.post('/downloads/queues/:id/resume', async (c) => {
  try {
    const queueId = parseIdParam(c);
    if (queueId === null) {
      return fail(c, 400, '无效的队列 ID');
    }
    const queue = await downloadManager.resumeQueue(queueId);
    return c.json({ code: 200, data: queue });
  } catch (error) {
    return handleError(c, error, '恢复队列失败');
  }
});

app.post('/downloads/queues/:id/cancel', async (c) => {
  try {
    const queueId = parseIdParam(c);
    if (queueId === null) {
      return fail(c, 400, '无效的队列 ID');
    }
    const queue = await downloadManager.cancelQueue(queueId);
    return c.json({ code: 200, data: queue });
  } catch (error) {
    return handleError(c, error, '取消队列失败');
  }
});

app.post('/downloads/queues/:id/retry', async (c) => {
  try {
    const queueId = parseIdParam(c);
    if (queueId === null) {
      return fail(c, 400, '无效的队列 ID');
    }
    const queue = await downloadManager.retryQueue(queueId);
    return c.json({ code: 200, data: queue });
  } catch (error) {
    return handleError(c, error, '重试队列失败');
  }
});

app.delete('/downloads/queues/:id', async (c) => {
  try {
    const queueId = parseIdParam(c);
    if (queueId === null) {
      return fail(c, 400, '无效的队列 ID');
    }
    await downloadManager.deleteQueue(queueId);
    return c.json({ code: 200, data: { success: true } });
  } catch (error) {
    return handleError(c, error, '删除队列失败');
  }
});

app.get('/downloads/tasks', async (c) => {
  try {
    const { playlistId, queueId, status } = c.req.query();
    // playlistId 原样透传：download-manager 同时接受本地 id 与网易云 id
    const tasks = downloadManager.listTasks({ playlistId, queueId, status });
    return c.json({ code: 200, data: tasks.map(downloadManager.toPublicTask) });
  } catch (error) {
    return handleError(c, error, '获取任务列表失败');
  }
});

app.get('/downloads/tasks/:id', async (c) => {
  try {
    const taskId = parseIdParam(c);
    if (taskId === null) {
      return fail(c, 400, '无效的任务 ID');
    }
    const task = downloadTasksRepo.findTaskById(taskId);

    if (!task) {
      return fail(c, 404, '任务不存在');
    }

    return c.json({ code: 200, data: downloadManager.toPublicTask(task) });
  } catch (error) {
    return handleError(c, error, '获取任务详情失败');
  }
});

app.post('/downloads/tasks/:id/retry', async (c) => {
  try {
    const taskId = parseIdParam(c);
    if (taskId === null) {
      return fail(c, 400, '无效的任务 ID');
    }
    const task = await downloadManager.retryTask(taskId);
    return c.json({ code: 200, data: downloadManager.toPublicTask(task) });
  } catch (error) {
    return handleError(c, error, '重试任务失败');
  }
});

app.delete('/downloads/tasks/:id', async (c) => {
  try {
    const taskId = parseIdParam(c);
    if (taskId === null) {
      return fail(c, 400, '无效的任务 ID');
    }
    const result = downloadManager.deleteTask(taskId);
    return c.json({ code: 200, data: result });
  } catch (error) {
    return handleError(c, error, '删除任务失败');
  }
});

// 下载单首歌曲到服务器
app.post('/downloads/songs/:songId', async (c) => {
  try {
    const songId = c.req.param('songId');
    const body = await readJsonBody(c);

    if (body.playlistId === undefined || body.playlistId === null || body.playlistId === '') {
      return fail(c, 400, '缺少 playlistId 参数');
    }

    const task = await downloadManager.downloadSingleSong(body.playlistId, songId, normalizeDownloadOptions(body));
    return c.json({ code: 200, data: downloadManager.toPublicTask(task) });
  } catch (error) {
    return handleError(c, error, '下载歌曲失败');
  }
});

// 查询歌曲下载状态（读操作：未导入歌单返回 downloaded:false，不触发远端导入）
app.get('/downloads/songs/:songId/status', async (c) => {
  try {
    const songId = c.req.param('songId');
    const { playlistId } = c.req.query();

    if (!playlistId) {
      return fail(c, 400, '缺少 playlistId 参数');
    }

    const status = await downloadManager.getSongDownloadStatus(playlistId, songId);
    return c.json({ code: 200, data: status });
  } catch (error) {
    return handleError(c, error, '查询下载状态失败');
  }
});

// 删除已下载的歌曲文件
app.delete('/downloads/songs/:songId', async (c) => {
  try {
    const songId = c.req.param('songId');
    const { playlistId } = c.req.query();

    if (!playlistId) {
      return fail(c, 400, '缺少 playlistId 参数');
    }

    const result = await downloadManager.deleteSongFiles(playlistId, songId);
    return c.json({ code: 200, data: result });
  } catch (error) {
    return handleError(c, error, '删除文件失败');
  }
});

// 删除歌单已下载歌曲文件（playlistId 接受本地 id 或网易云 id）
app.delete('/downloads/playlists/:playlistId/files', async (c) => {
  try {
    const playlistId = c.req.param('playlistId');
    const result = await downloadManager.deletePlaylistDownloadedFiles(playlistId);
    return c.json({ code: 200, data: result });
  } catch (error) {
    return handleError(c, error, '批量删除歌单已下载文件失败');
  }
});

// 快速创建并启动歌单下载
app.post('/downloads/playlists/:playlistId/quick', async (c) => {
  try {
    const playlistId = c.req.param('playlistId');
    const body = await readJsonBody(c);

    const queue = await downloadManager.createDownloadQueue(playlistId, normalizeDownloadOptions(body));
    await downloadManager.startQueue(queue.id);

    // startQueue 已把 status 推进到 running——回传创建时快照的 'pending' 是脏响应
    return c.json({ code: 200, data: downloadManager.getQueueProgress(queue.id).queue });
  } catch (error) {
    return handleError(c, error, '快速下载失败');
  }
});

module.exports = app;

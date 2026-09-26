const { Hono } = require('hono');
const downloadManager = require('../services/download-manager');
const downloadQueuesRepo = require('../repositories/downloadQueues');
const downloadTasksRepo = require('../repositories/downloadTasks');

const app = new Hono();

// 请求体上限：下载接口只需小 JSON 配置，大包只会消耗内存（与 music.js 同策略）
const MAX_BODY_BYTES = 1024 * 1024;

function fail(c, status, message) {
  return c.json({ code: status, message }, status);
}

// 业务错误统一映射：err.status 由 download-manager 的 httpError() 标记；
// 未标记的异常一律 500（并记录日志），不向前端泄漏内部细节之外的堆栈
function handleError(c, error, tag) {
  const status = Number.isInteger(error.status) ? error.status : 500;
  if (status >= 500) {
    console.error(`${tag}:`, error);
  }
  return fail(c, status, error.message || '服务器错误');
}

// 路由 :id 参数统一校验：拒绝 NaN 与 parseInt 截断（"12abc" → 12 这类脏输入）
function parseIdParam(c, name = 'id') {
  const n = Number(c.req.param(name));
  return Number.isInteger(n) && n > 0 ? n : null;
}

// JSON body 容错解析 + 长度上限：声明超限直接 413；畸形 JSON 按空对象处理
async function readJsonBody(c) {
  const declaredLength = Number(c.req.header('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    const err = new Error('Payload Too Large');
    err.status = 413;
    throw err;
  }
  try {
    const parsed = await c.req.json();
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch {
    return {};
  }
}

// 队列/单曲下载的可选参数规范化：脏值回落默认，concurrentLimit 限定 1-10
function normalizeDownloadOptions(body) {
  const { bitrate, downloadAudio, downloadLyrics, downloadCover, concurrentLimit } = body;
  return {
    bitrate: Number.isInteger(bitrate) && bitrate > 0 ? bitrate : 320000,
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
    return c.json({ code: 200, data: progress });
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
    downloadManager.deleteQueue(queueId);
    return c.json({ code: 200, message: '队列已删除' });
  } catch (error) {
    return handleError(c, error, '删除队列失败');
  }
});

app.get('/downloads/tasks', async (c) => {
  try {
    const { playlistId, queueId, status } = c.req.query();
    // playlistId 原样透传：download-manager 同时接受本地 id 与网易云 id
    const tasks = downloadManager.listTasks({ playlistId, queueId, status });
    return c.json({ code: 200, data: tasks });
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

    return c.json({ code: 200, data: task });
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
    return c.json({ code: 200, data: task });
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
    downloadManager.deleteTask(taskId);
    return c.json({ code: 200, message: '任务已删除' });
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
    return c.json({ code: 200, data: task });
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

    return c.json({ code: 200, data: queue });
  } catch (error) {
    return handleError(c, error, '快速下载失败');
  }
});

module.exports = app;

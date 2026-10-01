const { Hono } = require('hono');
const downloadManager = require('../services/download-manager');
const { mirrorLocalPlaylist } = require('../services/local-mirror');
const downloadQueuesRepo = require('../repositories/downloadQueues');
const downloadTasksRepo = require('../repositories/downloadTasks');
const playlistsRepo = require('../repositories/playlists');
// 读流按字节硬截断：chunked/无 Content-Length 请求不会被声明值检查拦住
const { readJsonBody } = require('../lib/http-body');
const { fail, handleError } = require('../lib/http-error');
const { isNeteasePlaylistDeleting } = require('../lib/deletion-locks');
const { MIRROR_PLAYLIST_ID_RE, parseNumericId } = require('../../shared/predicates.js');

const app = new Hono();

// 路由 :id 参数统一校验：只收纯十进制数字——Number() 会放过 '1e5'/'0x10'/' 3 '
// 这类脏输入，parseInt 又会截断 '12abc'，两者都得拦（实现收敛进 shared/predicates）
function parseIdParam(c, name = 'id') {
  return parseNumericId(c.req.param(name));
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
    try {
      await downloadManager.startQueue(queue.id);
    } catch (error) {
      // create→start 窗口被并发抢先启动：409"已在运行中"其实就是目标态——
      // 照常返回 progress 而非误报失败
      if (error.status !== 409) throw error;
    }

    // startQueue 已把 status 推进到 running——回传创建时快照的 'pending' 是脏响应；
    // reused 是 create 阶段的瞬时标记（不落库），getQueueProgress 重取的对象上没有，手动透传
    const progress = downloadManager.getQueueProgress(queue.id).queue;
    return c.json({ code: 200, data: queue.reused ? { ...progress, reused: true } : progress });
  } catch (error) {
    return handleError(c, error, '快速下载失败');
  }
});

// 本地歌单（local_pl_*/saved_queue_*）镜像上传：客户端 tracks 活在 localStorage，
// 服务端下载链要求 DB 行——把本地单落成 netease_playlist_id=local_<id> 的镜像行，
// 之后既有路由（quick 建队 / 状态查询 / 文件删除）经 findExistingPlaylistId 的
// netease_playlist_id 分支全部自然解析，零路由改动。
// tracks 只收网易云数字 id 与 qq_<songmid>——bv_*/yt_* 等无服务端下载源的条目跳过并计数回传。
const LOCAL_MIRROR_ID_MAX = 80;
app.post('/downloads/local/mirror', async (c) => {
  try {
    // 前端按瘦身投影上载（~300B/曲，2000 曲 ≈600KB）；上限放宽到 8MB
    // 兜底未瘦身的旧端/手工调用发全量对象（~2-3KB/曲）——1MB 默认上限会在
    // ~400 曲处截死整个歌单
    const body = await readJsonBody(c, 8 * 1024 * 1024);
    const localId = String(body.localId || '').trim();
    if (!MIRROR_PLAYLIST_ID_RE.test(localId)
        || localId.length > LOCAL_MIRROR_ID_MAX) {
      return fail(c, 400, '无效的本地歌单 ID');
    }
    // 级联删除窗口内的镜像会以同 netease_playlist_id 复活刚删的行——与
    // playlist-sync 同款前置拒绝
    if (isNeteasePlaylistDeleting(localId)) {
      return fail(c, 409, '该歌单正在删除中');
    }
    const allTracks = Array.isArray(body.tracks) ? body.tracks : [];
    if (!allTracks.length) return fail(c, 400, '歌单中没有歌曲');
    // 只留服务端可下载的曲目（网易云数字 id + qq_<songmid> 直链源）；bv_/yt_
    // 等跳过并回传计数让前端提示。
    // 先过滤后截断：前 2000 个可下载曲进入镜像；skipped=不支持 id，truncated=超上限截尾
    const numeric = allTracks.filter(t => t && (/^\d+$/.test(String(t.id ?? ''))
      || /^qq_[0-9A-Za-z]{10,20}$/.test(String(t.id ?? ''))));
    const tracks = numeric.slice(0, 2000)
      .map(t => ({
        id: String(t.id),
        name: String(t.name || '未知歌曲').slice(0, 200),
        ar: Array.isArray(t.ar || t.artists) ? (t.ar || t.artists).slice(0, 20) : [],
        al: (t.al && typeof t.al === 'object') ? t.al
          : (t.album && typeof t.album === 'object') ? t.album : {},
        dt: Number.isFinite(+t.dt) ? +t.dt : (+t.duration || 0),
        // qq 源私有字段只收 mediaMid（vkey filename 键）——其余下载链用不上；
        // 形态校验防任意对象进 raw_json
        ...(t.qq && /^[0-9A-Za-z]{10,20}$/.test(String(t.qq.mediaMid || ''))
          ? { qq: { mediaMid: String(t.qq.mediaMid) } } : {})
      }));
    const skipped = allTracks.length - numeric.length;
    const truncated = numeric.length - tracks.length;
    if (!tracks.length) return fail(c, 400, `没有可下载的歌曲（跳过 ${skipped} 首不支持下载的曲目）`);
    const name = String(body.name || '本地歌单').slice(0, 200);
    // 落库事务收敛在 services/local-mirror.js（upsert+整表替换原子性、
    // 内容签名短路、墓碑复查都在那层）
    const pl = mirrorLocalPlaylist(localId, name,
      String(body.coverImgUrl || '').slice(0, 500), tracks);
    return c.json({ code: 200, data: { playlistId: pl.id, mirrored: tracks.length, skipped, truncated } });
  } catch (error) {
    return handleError(c, error, '本地歌单镜像失败');
  }
});

// 本地歌单从库中移除时清服务端镜像产物（镜像行 + 任务 + 已下载文件）。
// 没有这一步镜像行会成永久孤儿——reapOrphanFiles 只清无行目录，镜像行还在就不扫
app.delete('/downloads/local/mirror/:localId', async (c) => {
  try {
    const localId = String(c.req.param('localId') || '').trim();
    if (!MIRROR_PLAYLIST_ID_RE.test(localId)
        || localId.length > LOCAL_MIRROR_ID_MAX) {
      return fail(c, 400, '无效的本地歌单 ID');
    }
    const pl = playlistsRepo.findPlaylistByNeteaseId(localId);
    // 幂等：未镜像过视为"无可清"。localId 前缀与数字 id 命名空间天然不相交——
    // 能以前缀命中即镜像产物，source 字段仅作冗余旁证不门槛
    if (!pl) {
      return c.json({ code: 200, data: { deleted: false } });
    }
    const deleted = await downloadManager.deletePlaylistCascade(pl.id);
    return c.json({ code: 200, data: { deleted: !!deleted } });
  } catch (error) {
    return handleError(c, error, '本地歌单镜像删除失败');
  }
});

module.exports = app;

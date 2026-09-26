const path = require('path');
const fs = require('fs');
const downloadTasksRepo = require('../repositories/downloadTasks');
const downloadQueuesRepo = require('../repositories/downloadQueues');
const playlistTracksRepo = require('../repositories/playlistTracks');
const playlistsRepo = require('../repositories/playlists');
const { dataDir } = require('../db/client');
const { importPlaylistFromNetease } = require('./playlist-sync');
const fileDownloader = require('./file-downloader');
const { getDb } = require('../db/client');
const { httpError } = require('../lib/http-error');

// 下载文件根目录：<dataDir>/downloads，可用 DOWNLOAD_DIR 覆盖（容器内指到挂载卷）
// resolve 归一化：路径安全比较依赖绝对路径
const DOWNLOAD_BASE_DIR = path.resolve(process.env.DOWNLOAD_DIR || path.join(dataDir, 'downloads'));

// 运行中队列的控制器集合：queueId -> { paused, cancelled, abort, done }
// done = processQueue 协程的 settle promise：删除/停机时先 abort 再 await done 排空在途任务，
// 否则"任务行已删但流还在写"会产生永远无人认领的孤儿文件
const activeQueues = new Map();
// 在途文件写入锁：同一目标路径只允许一个下载（歌单重复入队/并发单曲防交叉写坏文件）
const activePaths = new Set();
// 独立单曲任务的在跑集合：taskId -> { abort, done }。并发重复点击不得并发跑同一行；
// abort/done 让停机与歌单删除能中止并排空 standalone 下载（原先 null signal 完全不可中止）
const standaloneRunning = new Map();
// 已 cancel 但协程仍在排空收尾的控制器：deleteQueue/deletePlaylistFiles/shutdownAll
// 必须连它们一起排空——否则 cancel 后立即 delete 会跳过排空，"删后落盘"留孤儿文件
const drainingQueues = new Map();
// 正在做文件级联删除的歌单：删除窗口内拒绝新建下载，否则排空竞态产生孤儿文件
const deletingPlaylists = new Set();
// 停机期间拒绝新建/启动下载，避免半途任务留下脏状态
let shuttingDown = false;

// 排空等待上限：上游解锁/取链等不可中止阶段可能卡住（无 signal 无超时），
// 排空不能无限等——超时后放行清扫，残余写入由后续孤儿文件清理兜底
const DRAIN_TIMEOUT_MS = 30000;
function drainWithTimeout(promise, ms = DRAIN_TIMEOUT_MS) {
  return Promise.race([
    Promise.resolve(promise).catch(() => {}),
    new Promise(resolve => setTimeout(resolve, ms))
  ]);
}

// 仅查本地、绝不触发远端导入：GET/DELETE 等读/删操作不允许产生写副作用
function findExistingPlaylistId(playlistId) {
  if (playlistId === undefined || playlistId === null) return null;
  const str = String(playlistId).trim();
  if (!str) return null;
  const numericId = Number(str);
  if (Number.isInteger(numericId)) {
    const byLocalId = playlistsRepo.findPlaylistById(numericId);
    if (byLocalId) return byLocalId.id;
  }
  const byNeteaseId = playlistsRepo.findPlaylistByNeteaseId(str);
  return byNeteaseId ? byNeteaseId.id : null;
}

// 写操作（创建队列/下载单曲）专用：本地未命中时尝试从网易云导入
async function resolvePlaylistId(playlistId) {
  const localId = findExistingPlaylistId(playlistId);
  if (localId !== null) return localId;
  if (playlistId === undefined || playlistId === null || !String(playlistId).trim()) {
    throw httpError(400, '无效的歌单 ID');
  }
  const imported = await importPlaylistFromNetease(String(playlistId).trim());
  if (imported?.id) {
    return imported.id;
  }
  throw httpError(404, '歌单不存在');
}

// 防路径逃逸：任务记录的文件路径来自 DB，只允许删除 DOWNLOAD_BASE_DIR 内的文件
// 用 path.relative 判断逃逸（".." 开头或在盘外即越界），比字符串前缀更稳
function isUnderDownloadDir(filePath) {
  const relative = path.relative(DOWNLOAD_BASE_DIR, path.resolve(filePath));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

// errorMessage 会经 API 透出——剥掉下载根目录绝对路径，避免把服务器文件系统布局暴露给客户端
function sanitizeErrorMessage(message) {
  return String(message || '').split(DOWNLOAD_BASE_DIR).join('<downloads>');
}

// 任务对象经 API 透出前把绝对路径相对化（audio/xxx.mp3）：与 sanitizeErrorMessage 同一
// 意图——错误消息剥了路径，任务字段却把服务器布局明文发给客户端说不通。
// 相对路径对前端 diff 语义无损（比较一致性保持不变）
function toPublicTask(task) {
  if (!task) return task;
  // path.relative 在 Windows 宿主会产反斜杠——API 字段统一归一为 '/'
  const rel = p => (
    typeof p === 'string' && p && isUnderDownloadDir(p)
      ? path.relative(DOWNLOAD_BASE_DIR, p).split(path.sep).join('/')
      : null
  );
  return {
    ...task,
    audioPath: rel(task.audioPath),
    lyricsPath: rel(task.lyricsPath),
    coverPath: rel(task.coverPath)
  };
}

function deleteFiles(filePaths) {
  let deletedFiles = 0;

  for (const filePath of filePaths.filter(Boolean)) {
    if (!isUnderDownloadDir(filePath)) continue;
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        deletedFiles += 1;
      }
    } catch {
      // 文件被在途流持有（Windows EPERM）等：跳过不中断批量删除
    }
  }

  return deletedFiles;
}

async function createDownloadQueue(playlistId, options = {}) {
  if (shuttingDown) {
    throw httpError(409, '服务正在停机');
  }

  const resolvedPlaylistId = await resolvePlaylistId(playlistId);
  if (deletingPlaylists.has(resolvedPlaylistId)) {
    throw httpError(409, '该歌单正在删除中');
  }
  const playlist = playlistsRepo.findPlaylistById(resolvedPlaylistId);
  if (!playlist) {
    throw httpError(404, '歌单不存在');
  }

  const tracks = playlistTracksRepo.listTracksByPlaylistId(resolvedPlaylistId);
  if (tracks.length === 0) {
    throw httpError(400, '歌单中没有歌曲');
  }

  // 同歌单已有 pending/running/paused 队列时拒绝再建——重复队列会并发写同一批文件
  const active = downloadQueuesRepo.listQueues().find(
    q => q.playlistId === resolvedPlaylistId && ['pending', 'running', 'paused'].includes(q.status)
  );
  if (active) {
    throw httpError(409, `该歌单已有进行中的下载队列 (#${active.id})`);
  }

  // 队列行 + 全部任务行在同一个事务里写入：半途抛错不留"有队列没任务"的脏数据
  const db = getDb();
  const createWithTasks = db.transaction(() => {
    const queue = downloadQueuesRepo.createQueue({
      playlistId: resolvedPlaylistId,
      name: playlist.name,
      totalTasks: 0,
      bitrate: options.bitrate || 320000,
      downloadAudio: options.downloadAudio !== false,
      downloadLyrics: options.downloadLyrics !== false,
      downloadCover: options.downloadCover !== false,
      concurrentLimit: options.concurrentLimit || 3
    });

    // 歌单内可能重复含同一首歌：按 songId 去重，totalTasks 以实际任务数为准
    const seen = new Set();
    let taskCount = 0;
    let adoptedCompleted = 0;
    for (const track of tracks) {
      const songId = String(track.id);
      if (seen.has(songId)) continue;
      seen.add(songId);

      // (playlist_id, song_id) 有唯一约束：standalone 单曲任务、以及归属
      // "已完结"旧队列（completed/cancelled/failed）的任务收养进本队列——
      // completed 计入完成数，failed/pending 重置重跑。仍属活跃队列的任务跳过：
      // 旧队列还在调度该歌，不在本队列重复计
      const existing = downloadTasksRepo.findAnyTaskByPlaylistAndSongId(resolvedPlaylistId, songId);
      if (existing) {
        // 内存态在跑的 standalone 收养会造成队列/单曲协程互踢路径锁——跳过，留给
        // 原执行者跑完。只看 standaloneRunning：DB 里 status='downloading' 但不在
        // map 里的是崩溃/异常残留的孤儿行，收养重置才是自愈路径
        const standaloneActive = standaloneRunning.has(existing.id);
        const owner = existing.queueId
          ? downloadQueuesRepo.findQueueById(existing.queueId)
          : null;
        const ownerActive = owner
          && ['pending', 'running', 'paused'].includes(owner.status);
        // owner 为 null = queue_id 指向已消失队列的孤儿行，同样收养
        if (!standaloneActive && (existing.queueId == null || !ownerActive)) {
          const keepCompleted = existing.status === 'completed';
          downloadTasksRepo.updateTask(existing.id, {
            queueId: queue.id,
            status: keepCompleted ? 'completed' : 'pending',
            progress: keepCompleted ? existing.progress : 0,
            errorMessage: null,
            retryCount: 0,
            // 重置重跑的任务同步新队列的下载选项——否则按旧行开关/码率跑，
            // "completed" 的歌可能实际没有音频/封面
            ...(keepCompleted ? {} : {
              bitrate: queue.bitrate,
              downloadAudio: queue.downloadAudio,
              downloadLyrics: queue.downloadLyrics,
              downloadCover: queue.downloadCover,
              // 旧路径字段一并清掉：残留的路径可能已指向别的任务的文件，
              // 后续 deleteTask/deleteSongFiles 会按它误删
              audioPath: null,
              lyricsPath: null,
              coverPath: null,
              fileSize: null,
              completedAt: null
            })
          });
          taskCount += 1;
          if (keepCompleted) adoptedCompleted += 1;
        }
        continue;
      }

      const artists = track.ar || track.artists || [];
      const album = track.al || track.album || {};
      const artistName = artists.filter(Boolean).map(a => a.name).join(', ') || '未知艺术家';
      const albumName = album.name || '未知专辑';
      const coverUrl = album.picUrl || album.pic_str || null;

      downloadTasksRepo.createTask({
        playlistId: resolvedPlaylistId,
        queueId: queue.id,
        songId,
        songName: track.name,
        artist: artistName,
        album: albumName,
        coverUrl,
        bitrate: queue.bitrate,
        durationMs: track.dt || track.duration || 0,
        downloadAudio: queue.downloadAudio,
        downloadLyrics: queue.downloadLyrics,
        downloadCover: queue.downloadCover
      });
      taskCount += 1;
    }

    // 收养的 completed 任务直接计入完成数——否则队列启动前进度显示 0/N
    downloadQueuesRepo.updateQueue(queue.id, {
      totalTasks: taskCount,
      completedTasks: adoptedCompleted
    });
    return downloadQueuesRepo.findQueueById(queue.id);
  });

  return createWithTasks();
}

async function startQueue(queueId) {
  if (shuttingDown) {
    throw httpError(409, '服务正在停机');
  }

  const queue = downloadQueuesRepo.findQueueById(queueId);
  if (!queue) {
    throw httpError(404, '队列不存在');
  }

  if (activeQueues.has(queueId)) {
    throw httpError(409, '队列已在运行中');
  }
  // 旧控制器还在排空（cancel 后的收尾窗口）——此时 start 会让新旧协程对同一批
  // 任务双重调度，且 deleteQueue 的双 Map 排空语义被破坏；要求等排空结束
  if (drainingQueues.has(queueId)) {
    throw httpError(409, '队列正在收尾，请稍后再试');
  }
  // 歌单删除窗口内不许起新协程：行级联删除后在途流会继续写孤儿文件
  if (deletingPlaylists.has(queue.playlistId)) {
    throw httpError(409, '该歌单正在删除中');
  }

  // failed/completed 队列没有 pending 任务可跑——直接启动会走正常收尾把它们
  // 覆写成 completed，失败痕迹被掩盖（重试应走 /retry 接口而非 /start）
  if (queue.status === 'failed' || queue.status === 'completed') {
    throw httpError(409, '队列已完结，请使用重试接口');
  }

  downloadQueuesRepo.updateQueue(queueId, { status: 'running' });

  const controller = {
    paused: false,
    cancelled: false,
    abort: new AbortController(),
    done: null
  };
  activeQueues.set(queueId, controller);

  // done 供 deleteQueue/deletePlaylistFiles/shutdownAll 排空等待：
  // abort 之后必须等在途 processTask 全部收尾（含路径记录、removePartial），
  // 再做文件清扫，否则"删后落盘"留下孤儿文件
  controller.done = processQueue(queueId, controller).catch(error => {
    console.error(`队列 ${queueId} 处理失败:`, error);
    try {
      downloadQueuesRepo.updateQueue(queueId, { status: 'failed' });
    } catch { /* 行可能已删 */ }
  }).finally(() => {
    if (activeQueues.get(queueId) === controller) {
      activeQueues.delete(queueId);
    }
  });

  return downloadQueuesRepo.findQueueById(queueId);
}

async function processQueue(queueId, controller) {
  const queue = downloadQueuesRepo.findQueueById(queueId);
  // 队列可能已被 DELETE 移除：控制器取消即可返回，避免对空行裸取字段
  if (!queue) {
    activeQueues.delete(queueId);
    return;
  }
  // 历史脏数据兜底：concurrent_limit 为 NULL 时 null>=n 恒真 → Promise.race([]) 死等
  const concurrentLimit = Number.isInteger(queue.concurrentLimit) && queue.concurrentLimit > 0
    ? queue.concurrentLimit
    : 3;
  const runningTasks = [];
  // 路径锁 409 的延迟重试集合：持锁方（其他任务/standalone 下载）可能写几十秒，
  // 每轮立即重捞重试等于全速空转打 DB。记入 deferred 本轮跳过重试；
  // 任一在途任务 settle（说明有锁释放）或全卡死时 sleep 退避后清空重试。
  // deferredSince 记录首次延迟时间——锁泄漏/不可中止的卡死任务会让队列永远
  // 空转不收尾，超过上限按失败处理
  const deferred = new Set();
  // deferredSince 只覆盖"连续等锁"区间：任务被取去执行时清除（见下方 push 前），
  // 否则已完成/在途的任务会被过期逻辑误伤覆写成 failed
  const deferredSince = new Map();
  const DEFER_LIMIT_MS = 5 * 60 * 1000;
  const expireDeferred = () => {
    const now = Date.now();
    // 只迭代当前真正在等锁的 deferred（deferredSince 里的历史条目不算数），
    // 且判失败前复查行仍 pending、锁仍被持有——持锁方若还活着就续期，
    // 锁已不在则按失败收敛（锁泄漏场景兜底）
    for (const taskId of deferred) {
      const since = deferredSince.get(taskId);
      if (!since || now - since <= DEFER_LIMIT_MS) continue;
      const row = downloadTasksRepo.findTaskById(taskId);
      if (!row || row.status !== 'pending') {
        deferredSince.delete(taskId);
        deferred.delete(taskId);
        continue;
      }
      const keys = taskLockKeys(row);
      if (keys.some(k => activePaths.has(k))) {
        deferredSince.set(taskId, now); // 锁仍被持有：续期，不误杀正常等待
        continue;
      }
      deferredSince.delete(taskId);
      deferred.delete(taskId);
      try {
        downloadTasksRepo.updateTask(taskId, {
          status: 'failed',
          errorMessage: '等待文件写入锁超时'
        });
        downloadQueuesRepo.incrementFailed(queueId);
      } catch { /* 任务行可能已被删 */ }
    }
  };
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  const waitWhilePaused = async () => {
    // 取消在暂停等待中也要生效——否则 cancelled 队列的协程永久自旋
    while (controller.paused && !controller.cancelled) {
      await sleep(1000);
    }
  };

  // 每轮重新捞 pending：processTask 失败后会把 retryCount<3 的任务置回 pending，
  // 开头取一次快照的写法会让任务内重试永不发生；退出条件是"无 pending 且无在途"——
  // Promise.all 之后在途任务仍可能把失败任务复位 pending，不能捞完一轮就收尾
  while (true) {
    if (controller.cancelled) break;
    await waitWhilePaused();
    if (controller.cancelled) break;

    const pendingTasks = downloadTasksRepo.listTasksByQueue(queueId)
      .filter(t => t.status === 'pending' && !deferred.has(t.id));
    if (pendingTasks.length === 0) {
      if (runningTasks.length === 0) {
        expireDeferred();
        if (deferred.size === 0) break;
        // 全部剩余任务都在等路径锁：退避后重试一轮
        deferred.clear();
        await sleep(400);
        continue;
      }
      // 在途任务可能把失败任务复位 pending 或释放路径锁——等一个 settle 再重查。
      // race 加超时：在途任务全卡在不可中止的上游调用（解锁/取链无超时）时
      // race 永不返回，expireDeferred 会被饿死
      await Promise.race([...runningTasks, sleep(60000)]);
      expireDeferred();
      deferred.clear();
      continue;
    }

    for (const task of pendingTasks) {
      if (controller.cancelled) break;
      await waitWhilePaused();
      if (controller.cancelled) break;

      while (runningTasks.length >= concurrentLimit && !controller.cancelled) {
        await Promise.race(runningTasks);
        deferred.clear(); // 有任务 settle = 可能有锁释放，给 deferred 再试机会
      }
      if (controller.cancelled) break;

      // 取去执行即离开"等锁"状态——清掉首次延迟时间戳，否则完成后会被
      // expireDeferred 按旧时间戳误伤（覆写 completed → failed）
      deferredSince.delete(task.id);
      const taskPromise = processTask(task, queueId, controller.abort.signal)
        .catch(error => {
          // processTask 内部已自吞常规失败；走到这里的是 try 之前的早期抛错。
          // 路径锁冲突(409)是瞬时态（另一任务正在写同路径），任务保持 pending 留给下一轮重试，
          // 只有真正的启动失败才标 failed——否则会让 Promise.all 砸掉整个队列
          if (error.status === 409) {
            deferred.add(task.id);
            if (!deferredSince.has(task.id)) {
              deferredSince.set(task.id, Date.now());
            }
            return;
          }
          console.error(`任务 ${task.id} 启动失败:`, error.message);
          try {
            downloadTasksRepo.updateTask(task.id, {
              status: 'failed',
              errorMessage: sanitizeErrorMessage(error.message)
            });
            downloadQueuesRepo.incrementFailed(queueId);
          } catch {
            // 任务行可能已随队列删除
          }
        })
        .finally(() => {
          const index = runningTasks.indexOf(taskPromise);
          if (index > -1) {
            runningTasks.splice(index, 1);
          }
        });
      runningTasks.push(taskPromise);
    }
  }

  await Promise.all(runningTasks);

  // cancel→start 竞态：本协程的控制器可能已被新 startQueue 替换——
  // 收尾写库前必须确认所有权还在自己手里，否则会把新运行写回 cancelled 并从 map 删掉新控制器
  if (activeQueues.get(queueId) !== controller) {
    return;
  }

  // 收尾窗口内队列可能被删除或被取消：已删则直接返回，cancelled 不得改写为 completed
  const finalQueue = downloadQueuesRepo.findQueueById(queueId);
  if (!finalQueue) {
    activeQueues.delete(queueId);
    return;
  }

  const allTasks = downloadTasksRepo.listTasksByQueue(queueId);
  const completedCount = allTasks.filter(t => t.status === 'completed').length;
  const failedCount = allTasks.filter(t => t.status === 'failed').length;

  // 有失败任务的队列不应标 completed——"完成但缺歌"会掩盖失败痕迹，
  // failed 终态让前端露出"重试"入口（retryQueue 正是为它设计的）
  downloadQueuesRepo.updateQueue(queueId, controller.cancelled
    ? { status: 'cancelled', completedTasks: completedCount, failedTasks: failedCount }
    : {
        status: failedCount > 0 ? 'failed' : 'completed',
        completedTasks: completedCount,
        failedTasks: failedCount,
        completedAt: new Date().toISOString()
      });

  activeQueues.delete(queueId);
}

// songId 来自上游元数据，直接拼路径（消歧后缀/covers 文件名）必须消毒——
// '../' 之类可逃出 covers/ 甚至 DOWNLOAD_BASE_DIR；纯数字也截断防 ENAMETOOLONG
const getSafeSongId = (task) => {
  const raw = String(task.songId);
  return /^\d+$/.test(raw) ? raw.slice(0, 40) : `task-${task.id}`;
};

// 计算一个任务会占用的写路径——processTask 用它取锁，expireDeferred 用它判断
// 锁是否仍被持有（续期 vs 判失败）。两处必须用同一套逻辑，否则判定不一致
const taskLockKeys = (task) => {
  const outputDir = path.join(DOWNLOAD_BASE_DIR, task.playlistId.toString());
  // 每段各留预算：文件名总长（含 ' - '/songId 后缀/扩展名）不得超 ext4 的 255B
  const sanitizedArtist = fileDownloader.sanitizeFilename(task.artist, 90);
  const sanitizedSongName = fileDownloader.sanitizeFilename(task.songName, 110);
  // 同歌单内不同 songId 可能消毒后撞名：原始名不同（如 "x?" vs "x<"、"x." vs "x"）
  // 会被 sanitizeFilename 坍缩成同一文件名互相覆盖——碰撞检测必须比较消毒后的名字
  const siblings = downloadTasksRepo.listTasksByPlaylist(task.playlistId);
  const nameCollision = siblings.some(
    t => t.id !== task.id
      && fileDownloader.sanitizeFilename(t.artist, 90) === sanitizedArtist
      && fileDownloader.sanitizeFilename(t.songName, 110) === sanitizedSongName
  );
  const safeSongId = getSafeSongId(task);
  const baseFilename = nameCollision
    ? `${sanitizedArtist} - ${sanitizedSongName} (${safeSongId})`
    : `${sanitizedArtist} - ${sanitizedSongName}`;
  return [
    task.downloadAudio ? path.join(outputDir, 'audio', `${baseFilename}.mp3`) : null,
    task.downloadLyrics ? path.join(outputDir, 'lyrics', `${baseFilename}.lrc`) : null,
    (task.downloadCover && task.coverUrl)
      ? path.join(outputDir, 'covers', `${safeSongId}.jpg`)
      : null
  ].filter(Boolean);
};

async function processTask(task, queueId, signal) {
  const outputDir = path.join(DOWNLOAD_BASE_DIR, task.playlistId.toString());
  const lockKeys = taskLockKeys(task);
  const audioPath = task.downloadAudio
    ? lockKeys.find(k => k.endsWith('.mp3'))
    : null;
  const lyricsPath = task.downloadLyrics
    ? lockKeys.find(k => k.endsWith('.lrc'))
    : null;
  const coverPath = (task.downloadCover && task.coverUrl)
    ? lockKeys.find(k => k.endsWith('.jpg'))
    : null;

  // 同路径并发写锁：两个写者同时 createWriteStream 会交错 truncate 写坏文件
  if (lockKeys.some(key => activePaths.has(key))) {
    throw httpError(409, '该歌曲已有下载任务进行中');
  }
  lockKeys.forEach(key => activePaths.add(key));

  const throwIfAborted = () => {
    if (signal?.aborted) {
      const err = new Error('已取消');
      err.aborted = true;
      throw err;
    }
  };

  try {
    // 任务行可能在入队快照后被 DELETE——复查存在性再动工，否则写出无人认领的孤儿文件。
    // 必须在 try 内执行：此处 updateTask 抛错（SQLITE_BUSY 等）若越过 try，
    // 锁键会永久残留在 activePaths，该路径之后所有任务恒 409
    const current = downloadTasksRepo.updateTask(task.id, {
      status: 'downloading',
      progress: 0,
      errorMessage: null
    });
    if (!current) return;

    let totalProgress = 0;
    let lastReported = -1;
    const reportProgress = (value) => {
      // progress 回调每 chunk 触发一次——按百分点节流，且 DB 写入失败不得穿透 'data' 监听器
      const rounded = Math.floor(value);
      if (rounded === lastReported) return;
      lastReported = rounded;
      try {
        downloadTasksRepo.updateTask(task.id, { progress: rounded });
      } catch { /* 行可能已被删 */ }
    };
    const weights = {
      audio: task.downloadAudio ? 70 : 0,
      lyrics: task.downloadLyrics ? 15 : 0,
      cover: task.downloadCover ? 15 : 0
    };

    if (audioPath) {
      const result = await fileDownloader.downloadAudio(
        task.songId,
        audioPath,
        task.bitrate,
        (progress) => reportProgress(totalProgress + Math.floor(progress * weights.audio / 100)),
        signal
      );
      totalProgress += weights.audio;
      downloadTasksRepo.updateTask(task.id, {
        audioPath,
        fileSize: result.size,
        progress: totalProgress
      });
    }

    // 段间补一次显式 signal 检查：上一段完成后队列可能已被取消，
    // 取消不必等下一段请求自然超时才生效
    throwIfAborted();

    if (lyricsPath) {
      try {
        await fileDownloader.downloadLyrics(task.songId, lyricsPath, signal);
        totalProgress += weights.lyrics;
        downloadTasksRepo.updateTask(task.id, {
          lyricsPath,
          progress: totalProgress
        });
      } catch (error) {
        if (error.message !== '歌词不存在') {
          throw error;
        }
      }
    }

    throwIfAborted();

    if (coverPath) {
      try {
        await fileDownloader.downloadCover(task.coverUrl, coverPath, signal);
        totalProgress += weights.cover;
        downloadTasksRepo.updateTask(task.id, {
          coverPath,
          progress: totalProgress
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        console.warn(`封面下载失败 (${task.songId}):`, error.message);
      }
    }

    try {
      downloadTasksRepo.updateTask(task.id, {
        status: 'completed',
        progress: 100,
        completedAt: new Date().toISOString()
      });
    } catch {
      // 行已被删：不再给队列计数
      return;
    }

    if (queueId !== null && queueId !== undefined) {
      try {
        downloadQueuesRepo.incrementCompleted(queueId);
      } catch { /* 队列行可能已删，收尾重算兜底 */ }
    }

  } catch (error) {
    if (signal?.aborted || error.aborted) {
      // 取消/停机中止：残文件由 downloader 清理；任务复位 pending 供下次重跑
      try {
        downloadTasksRepo.updateTask(task.id, {
          status: 'pending',
          progress: 0,
          errorMessage: '已取消'
        });
      } catch {
        // 任务行可能已随队列级联删除
      }
      return;
    }

    console.error(`任务 ${task.id} 失败:`, error);

    // fatal（解锁失败/试听片段）是确定性失败，重试只会重复打上游；可重试错误走 retryCount 路径。
    // 每步 DB 写独立兜底：行/队列可能已被并发删除，局部失败不得把行卡在 downloading
    if (!error.fatal && task.retryCount < 3) {
      try {
        downloadTasksRepo.updateTask(task.id, {
          retryCount: task.retryCount + 1,
          status: 'pending',
          errorMessage: sanitizeErrorMessage(error.message)
        });
      } catch { /* 行已删 */ }
    } else {
      try {
        downloadTasksRepo.updateTask(task.id, {
          status: 'failed',
          errorMessage: sanitizeErrorMessage(error.message)
        });
      } catch { /* 行已删 */ }
      if (queueId !== null && queueId !== undefined) {
        try {
          downloadQueuesRepo.incrementFailed(queueId);
        } catch { /* 队列行已删，收尾重算兜底 */ }
      }
    }
  } finally {
    lockKeys.forEach(key => activePaths.delete(key));
  }
}

async function pauseQueue(queueId) {
  const controller = activeQueues.get(queueId);
  if (!controller) {
    throw httpError(409, '队列未运行');
  }

  controller.paused = true;
  downloadQueuesRepo.updateQueue(queueId, { status: 'paused' });

  return downloadQueuesRepo.findQueueById(queueId);
}

async function resumeQueue(queueId) {
  const controller = activeQueues.get(queueId);
  if (!controller) {
    throw httpError(409, '队列未运行');
  }

  controller.paused = false;
  downloadQueuesRepo.updateQueue(queueId, { status: 'running' });

  return downloadQueuesRepo.findQueueById(queueId);
}

// 中止运行中控制器：置 cancelled + 解除暂停自旋 + abort 在途下载流
function abortController(controller) {
  controller.cancelled = true;
  controller.paused = false;
  controller.abort?.abort();
}

// 取消路径跳过 processQueue 收尾 recount，draining 收尾时补算计数器
function recountQueueCounters(queueId) {
  const q = downloadQueuesRepo.findQueueById(queueId);
  if (!q) return;
  try {
    const tasks = downloadTasksRepo.listTasksByQueue(queueId);
    downloadQueuesRepo.updateQueue(queueId, {
      completedTasks: tasks.filter(t => t.status === 'completed').length,
      failedTasks: tasks.filter(t => t.status === 'failed').length
    });
  } catch { /* 队列行可能已删 */ }
}

async function cancelQueue(queueId) {
  const queue = downloadQueuesRepo.findQueueById(queueId);
  if (!queue) {
    throw httpError(404, '队列不存在');
  }

  const controller = activeQueues.get(queueId);
  if (controller) {
    abortController(controller);
    // 控制器移入 draining：协程仍在排空收尾，deleteQueue 等路径必须连它一起等
    activeQueues.delete(queueId);
    drainingQueues.set(queueId, controller);
    const release = () => {
      // 身份校验：cancel→start→cancel 会让旧控制器的 done 回调抹掉新条目
      if (drainingQueues.get(queueId) === controller) drainingQueues.delete(queueId);
      // 若无新控制器接管（未重启/未删除），补一次计数重算——取消路径跳过
      // processQueue 收尾 recount，incrementFailed 漂移会长期残留
      if (!activeQueues.has(queueId) && !drainingQueues.has(queueId)) {
        recountQueueCounters(queueId);
      }
    };
    Promise.resolve(controller.done).finally(release).catch(() => {});
    // done 若卡死在不可中止的上游调用永不 settle——超时兜底清理，
    // 否则条目永久残留，deleteTask 对相关任务永久 409
    setTimeout(release, DRAIN_TIMEOUT_MS + 5000).unref?.();
  }

  // 终态队列不应被改写为 cancelled（completed/failed 是有意义的终态）
  if (queue.status === 'pending' || queue.status === 'running' || queue.status === 'paused') {
    downloadQueuesRepo.updateQueue(queueId, { status: 'cancelled' });
  }
  activeQueues.delete(queueId);

  return downloadQueuesRepo.findQueueById(queueId);
}

// DELETE /queues/:id：中止运行中的控制器、排空在途任务、清掉已落盘文件，再删行——
// 不做这些会留下永远失联的孤儿文件；排空尤其关键：abort 后 processTask 的收尾
// （路径写库/removePartial）是异步的，直接扫文件会漏掉"写完未记档"的落盘
async function deleteQueue(queueId) {
  const queue = downloadQueuesRepo.findQueueById(queueId);
  if (!queue) {
    throw httpError(404, '队列不存在');
  }

  // 排空覆盖 activeQueues 与 drainingQueues（刚 cancel 的队列协程还在收尾，
  // 跳过排空会漏"写完未记档"的落盘）；排空有时限——不可中止的上游调用
  // 不能让整个 HTTP 请求死等。
  // cancel→start→delete 会让两个 Map 各持一个控制器——必须全部排空而非 || 取一
  const controllers = new Set();
  for (const map of [activeQueues, drainingQueues]) {
    const c = map.get(queueId);
    if (c) controllers.add(c);
  }
  for (const c of controllers) abortController(c);
  await Promise.all(
    [...controllers].map(c => drainWithTimeout(c.done))
  );
  activeQueues.delete(queueId);
  drainingQueues.delete(queueId);

  const tasks = downloadTasksRepo.listTasksByQueue(queueId);
  for (const task of tasks) {
    // 在途任务的流已被 abort：正在写的那段残片由 downloader 的 removePartial 清，
    // 已落盘的前段（如 audio 已完成、歌词在途）仍要删——行级联删除后无人再管
    deleteFiles([task.audioPath, task.lyricsPath, task.coverPath]);
  }

  downloadQueuesRepo.deleteQueue(queueId);
}

function getQueueProgress(queueId) {
  const queue = downloadQueuesRepo.findQueueById(queueId);
  if (!queue) {
    throw httpError(404, '队列不存在');
  }

  const tasks = downloadTasksRepo.listTasksByQueue(queueId);
  const statusCounts = downloadTasksRepo.countTasksByQueueAndStatus(queueId);

  return {
    queue,
    tasks,
    statusCounts,
    isActive: activeQueues.has(queueId) || drainingQueues.has(queueId)
  };
}

const VALID_TASK_STATUSES = new Set(['pending', 'downloading', 'completed', 'failed']);

// 任务列表查询：playlistId 支持本地 id 或网易云 id（未导入则空数组，不触发导入）
function listTasks({ playlistId, queueId, status } = {}) {
  if (queueId !== undefined && queueId !== null && queueId !== '') {
    const n = Number(queueId);
    if (!Number.isInteger(n) || n <= 0) {
      throw httpError(400, '无效的 queueId');
    }
    return downloadTasksRepo.listTasksByQueue(n);
  }
  if (playlistId !== undefined && playlistId !== null && playlistId !== '') {
    const resolved = findExistingPlaylistId(playlistId);
    return resolved === null ? [] : downloadTasksRepo.listTasksByPlaylist(resolved);
  }
  if (status) {
    if (!VALID_TASK_STATUSES.has(status)) {
      throw httpError(400, '无效的 status');
    }
    return downloadTasksRepo.listTasksByStatus(status);
  }
  throw httpError(400, '需要提供 playlistId、queueId 或 status 参数');
}

// 删除任务记录及其已落盘文件（进行中的任务拒绝删除——下载流仍持有句柄）
function deleteTask(taskId) {
  const task = downloadTasksRepo.findTaskById(taskId);
  if (!task) {
    throw httpError(404, '任务不存在');
  }
  // 只看内存态：DB status='downloading' 但不在 standaloneRunning/任何队列控制器
  // 里的是残留行（下次启动 recoverStaleStates 才复位），不应永远挡住删除
  if (standaloneRunning.has(task.id)
    || (task.status === 'downloading' && task.queueId
        && (activeQueues.has(task.queueId) || drainingQueues.has(task.queueId)))) {
    throw httpError(409, '任务正在下载中，请先取消所在队列');
  }

  const deletedFiles = deleteFiles([task.audioPath, task.lyricsPath, task.coverPath]);
  downloadTasksRepo.deleteTask(taskId);
  // 计数对齐：completed 任务删了要减 completedTasks；failed 同理；
  // pending 被删则总任务数也要减——否则队列进度永远差一格
  if (task.queueId) {
    if (task.status === 'completed') downloadQueuesRepo.decrementCompleted(task.queueId);
    else if (task.status === 'failed') downloadQueuesRepo.decrementFailed(task.queueId);
    else downloadQueuesRepo.decrementTotal(task.queueId);
  }
  return { success: true, deletedFiles };
}

// 独立任务（queueId=null）没有队列调度器消费 pending：原地循环执行，
// processTask 内部会把 retryCount<3 的失败者置回 pending，循环即真实重试。
// 间错 300ms 防止路径锁冲突等瞬时失败时紧循环空转。
// 挂 AbortController：停机/歌单删除必须能中止并排空，否则在途流继续落盘成孤儿文件
async function runStandaloneTask(task) {
  if (standaloneRunning.has(task.id)) {
    throw httpError(409, '该任务正在下载中');
  }
  const entry = { abort: new AbortController(), done: null };
  standaloneRunning.set(task.id, entry);
  entry.done = (async () => {
    let current = task;
    do {
      if (current !== task) {
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      // abort 后不把复位 pending 的任务再跑一遍——那是取消语义不是重试
      if (entry.abort.signal.aborted) break;
      await processTask(current, null, entry.abort.signal);
      current = downloadTasksRepo.findTaskById(current.id);
    } while (current && current.status === 'pending' && !entry.abort.signal.aborted);

    // 先判完成：下载恰好跑完时撞上 abort（如并发歌单删除）文件已完整落盘，
    // 此时报"已取消"是错误语义——completed 优先
    if (current?.status === 'completed') {
      return current;
    }
    if (entry.abort.signal.aborted) {
      throw httpError(409, '下载已取消');
    }
    throw httpError(502, current?.errorMessage || '下载失败');
  })().finally(() => {
    standaloneRunning.delete(task.id);
  });
  return entry.done;
}

// 下载单首歌曲到服务器
async function downloadSingleSong(playlistId, songId, options = {}) {
  if (shuttingDown) {
    throw httpError(409, '服务正在停机');
  }

  const resolvedPlaylistId = await resolvePlaylistId(playlistId);
  if (deletingPlaylists.has(resolvedPlaylistId)) {
    throw httpError(409, '该歌单正在删除中');
  }
  const tracks = playlistTracksRepo.listTracksByPlaylistId(resolvedPlaylistId);
  const track = tracks.find(t => String(t.id) === String(songId));

  if (!track) {
    throw httpError(404, '歌曲不存在');
  }

  const artists = track.ar || track.artists || [];
  const album = track.al || track.album || {};
  const artistName = artists.filter(Boolean).map(a => a.name).join(', ') || '未知艺术家';
  const albumName = album.name || '未知专辑';
  const coverUrl = album.picUrl || album.pic_str || null;

  // 任务查询覆盖全部任务（含队列任务）：同一首歌经队列下载过就不再重复下载；
  // 队列拥有的任务不能代跑——standalone 执行会往别的队列写计数
  const existing = downloadTasksRepo.listTasksByPlaylist(resolvedPlaylistId)
    .filter(t => t.songId === String(songId));
  const queueTask = existing.find(t => t.queueId !== null && t.queueId !== undefined);

  if (queueTask) {
    if (queueTask.status === 'completed') {
      return queueTask; // 幂等：队列已下载，直接返回
    }
    const owner = downloadQueuesRepo.findQueueById(queueTask.queueId);
    const ownerActive = owner && ['pending', 'running', 'paused'].includes(owner.status);
    if (ownerActive) {
      throw httpError(409, '该歌曲已在下载队列中');
    }
    // 属主队列已终结（cancelled/failed）或行已消失：接管该行原地重跑——
    // 否则被弃队列的歌从此永远无法单曲下载。置回 standalone 语义，不给死队列写计数
    downloadTasksRepo.updateTask(queueTask.id, {
      queueId: null,
      status: 'pending',
      progress: 0,
      errorMessage: null,
      retryCount: 0
    });
    return runStandaloneTask(downloadTasksRepo.findTaskById(queueTask.id));
  }

  let task = existing.find(t => !t.queueId && t.status === 'completed') || existing.find(t => !t.queueId);

  if (task && task.status === 'completed') {
    return task;
  }
  // 只看内存态：DB 里残留的 downloading 孤儿行不在 standaloneRunning 里，
  // 不挡下载（原地重跑即自愈）；真正在跑的任务才冲突
  if (task && task.status === 'downloading' && standaloneRunning.has(task.id)) {
    throw httpError(409, '该歌曲正在下载中');
  }

  if (!task) {
    task = downloadTasksRepo.createTask({
      playlistId: resolvedPlaylistId,
      queueId: null,
      songId: String(songId),
      songName: track.name,
      artist: artistName,
      album: albumName,
      coverUrl,
      bitrate: options.bitrate || 320000,
      durationMs: track.dt || track.duration || 0,
      downloadAudio: options.downloadAudio !== false,
      downloadLyrics: options.downloadLyrics !== false,
      downloadCover: options.downloadCover !== false
    });
  }

  return runStandaloneTask(task);
}

// 查询歌曲下载状态（读操作：歌单未导入时返回未下载，不触发远端导入；
// 队列任务与独立任务统一口径——状态显示与删除路径一致）
async function getSongDownloadStatus(playlistId, songId) {
  const resolvedPlaylistId = findExistingPlaylistId(playlistId);
  const all = resolvedPlaylistId === null
    ? []
    : downloadTasksRepo.listTasksByPlaylist(resolvedPlaylistId)
        .filter(t => t.songId === String(songId));
  const task = all.find(t => t.status === 'completed') || all[0] || null;

  return {
    downloaded: Boolean(task && task.status === 'completed'),
    task: toPublicTask(task || null)
  };
}

// 删除歌曲文件：同一首歌可能同时有独立任务和队列任务（队列全量重跑会重复落盘同一文件），
// 必须清掉全部任务行——否则删了一条后另一条仍报"已下载"指到已删文件
async function deleteSongFiles(playlistId, songId) {
  const resolvedPlaylistId = findExistingPlaylistId(playlistId);
  if (resolvedPlaylistId === null) {
    throw httpError(404, '歌单不存在');
  }

  const tasks = downloadTasksRepo.listTasksByPlaylist(resolvedPlaylistId)
    .filter(t => t.songId === String(songId));

  if (tasks.length === 0) {
    throw httpError(404, '任务不存在');
  }
  // 同上：只拒真实在跑的任务（内存控制器），孤儿 downloading 行不挡删除
  if (tasks.some(t => standaloneRunning.has(t.id)
    || (t.status === 'downloading' && t.queueId && (activeQueues.has(t.queueId) || drainingQueues.has(t.queueId))))) {
    throw httpError(409, '任务正在下载中，请先取消所在队列');
  }

  const allPaths = [...new Set(tasks.flatMap(t => [t.audioPath, t.lyricsPath, t.coverPath]))];
  const deletedFiles = deleteFiles(allPaths);
  for (const task of tasks) {
    downloadTasksRepo.deleteTask(task.id);
    if (!task.queueId) continue;
    if (task.status === 'completed') downloadQueuesRepo.decrementCompleted(task.queueId);
    else if (task.status === 'failed') downloadQueuesRepo.decrementFailed(task.queueId);
    else downloadQueuesRepo.decrementTotal(task.queueId);
  }

  return { success: true, deletedFiles };
}

// 删除歌单全部已下载文件：独立任务与队列任务都处理，进行中的任务跳过
async function deletePlaylistDownloadedFiles(playlistId) {
  const resolvedPlaylistId = findExistingPlaylistId(playlistId);
  if (resolvedPlaylistId === null) {
    throw httpError(404, '歌单不存在');
  }
  const tasks = downloadTasksRepo.listTasksByPlaylist(resolvedPlaylistId);
  const downloadedTasks = tasks.filter(
    task => !standaloneRunning.has(task.id)
      && !(task.status === 'downloading' && task.queueId && (activeQueues.has(task.queueId) || drainingQueues.has(task.queueId)))
      && (task.status === 'completed' || task.audioPath || task.lyricsPath || task.coverPath)
  );

  let deletedSongs = 0;
  let deletedFiles = 0;

  for (const task of downloadedTasks) {
    deletedFiles += deleteFiles([task.audioPath, task.lyricsPath, task.coverPath]);
    downloadTasksRepo.deleteTask(task.id);
    if (!task.queueId) continue;
    if (task.status === 'completed') downloadQueuesRepo.decrementCompleted(task.queueId);
    else if (task.status === 'failed') downloadQueuesRepo.decrementFailed(task.queueId);
    else downloadQueuesRepo.decrementTotal(task.queueId);
    deletedSongs += 1;
  }

  return {
    success: true,
    deletedSongs,
    deletedFiles
  };
}

// 删除歌单前清理：中止该歌单的活跃队列与 standalone 任务、排空后再删全部任务文件
// （行由 FK 级联删）。排空保证 "写完未记档" 的文件也被后续整目录清除覆盖。
// 本函数不管 deletingPlaylists 锁——由 deletePlaylistCascade 在外层持有到行删除后
async function deletePlaylistFiles(playlistId) {
  {
    const drains = [];
    for (const map of [activeQueues, drainingQueues]) {
      for (const [queueId, controller] of map) {
        const queue = downloadQueuesRepo.findQueueById(queueId);
        if (queue && queue.playlistId === playlistId) {
          abortController(controller);
          map.delete(queueId);
          drains.push(controller.done);
        }
      }
    }

    // 该歌单的 standalone 单曲下载同样要中止并排空——原先这些任务无 signal，
    // 歌单删了流还继续写，产出整套孤儿文件
    const playlistTasks = downloadTasksRepo.listTasksByPlaylist(playlistId);
    const playlistTaskIds = new Set(playlistTasks.map(t => t.id));
    for (const [taskId, entry] of standaloneRunning) {
      if (playlistTaskIds.has(taskId)) {
        entry.abort.abort();
        drains.push(entry.done);
      }
    }

    // 排空有时限：不可中止的上游调用（解锁/取链）不能让 HTTP 请求死等
    await Promise.all(drains.map(d => drainWithTimeout(d)));

    // 等待窗口内漏网者重扫：并发 cancelQueue 会把控制器新搬进 drainingQueues，
    // startQueue/retryTask 虽已拦 deletingPlaylists，仍兜底重扫三个 Map
    for (const map of [activeQueues, drainingQueues]) {
      for (const [queueId, controller] of map) {
        const queue = downloadQueuesRepo.findQueueById(queueId);
        if (queue && queue.playlistId === playlistId) {
          abortController(controller);
          map.delete(queueId);
          await drainWithTimeout(controller.done);
        }
      }
    }
    const freshTaskIds = new Set(
      downloadTasksRepo.listTasksByPlaylist(playlistId).map(t => t.id)
    );
    for (const [taskId, entry] of standaloneRunning) {
      if (freshTaskIds.has(taskId)) {
        entry.abort.abort();
        await drainWithTimeout(entry.done);
      }
    }

    // 排空后再取一次任务快照：窗口内漏网的新建行也一并清文件
    const finalTasks = downloadTasksRepo.listTasksByPlaylist(playlistId);
    for (const task of finalTasks) {
      // downloading 任务的流已 abort：正在写的那段由 downloader 的 removePartial 清，
      // 但已落盘的前段（audio 完成/正在下歌词）必须照删，否则级联删行后成孤儿文件
      deleteFiles([task.audioPath, task.lyricsPath, task.coverPath]);
    }

    // 剪掉空的子目录骨架（audio/lyrics/covers + 歌单目录本身），不留残壳
    const playlistDir = path.join(DOWNLOAD_BASE_DIR, String(playlistId));
    try {
      if (isUnderDownloadDir(playlistDir)) {
        for (const sub of ['audio', 'lyrics', 'covers']) {
          const subDir = path.join(playlistDir, sub);
          if (fs.existsSync(subDir) && fs.readdirSync(subDir).length === 0) {
            fs.rmdirSync(subDir);
          }
        }
        if (fs.existsSync(playlistDir) && fs.readdirSync(playlistDir).length === 0) {
          fs.rmdirSync(playlistDir);
        }
      }
    } catch {
      // 目录清理失败无害——跳过不阻塞删除流程
    }
  }
}

// 歌单删除的完整级联：deletingPlaylists 锁必须持到 playlist 行级联删除之后才释放——
// 否则锁释放到行删除之间的窗口里 downloadSingleSong/createDownloadQueue 可过检查
// 建新行，行随即被级联删掉，在途流成孤儿。路由只调本函数，不单独调 deletePlaylist
async function deletePlaylistCascade(playlistId) {
  deletingPlaylists.add(playlistId);
  try {
    await deletePlaylistFiles(playlistId);
    return playlistsRepo.deletePlaylist(playlistId);
  } finally {
    deletingPlaylists.delete(playlistId);
  }
}

async function retryTask(taskId) {
  if (shuttingDown) {
    throw httpError(409, '服务正在停机');
  }

  const task = downloadTasksRepo.findTaskById(taskId);
  if (!task) {
    throw httpError(404, '任务不存在');
  }
  // 失败任务可重试；standalone 崩溃残留的 pending（无人消费）也允许就地重跑。
  // 在跑任务排除——standalone 协程的 300ms 重试间隙 status 恰为 pending，
  // 放行会先动行再被 runStandaloneTask 409，状态已被污染
  const retriable = (task.status === 'failed' || (!task.queueId && task.status === 'pending'))
    && !standaloneRunning.has(taskId);
  if (!retriable) {
    throw httpError(409, '只能重试失败的任务');
  }

  // 歌单删除窗口内重跑 standalone 会让在途流在行级联删除后继续写孤儿文件。
  // 必须在写库前置检——否则先复位 pending 再抛错，留一次无意义写
  if (deletingPlaylists.has(task.playlistId)) {
    throw httpError(409, '该歌单正在删除中');
  }

  const queue = task.queueId ? downloadQueuesRepo.findQueueById(task.queueId) : null;

  downloadTasksRepo.updateTask(taskId, {
    status: 'pending',
    progress: 0,
    errorMessage: null,
    completedAt: null,
    retryCount: 0
  });

  if (queue) {
    downloadQueuesRepo.decrementFailed(queue.id);
    if (queue.status === 'failed' || queue.status === 'completed' || queue.status === 'cancelled') {
      downloadQueuesRepo.updateQueue(queue.id, {
        status: 'pending',
        completedAt: null
      });
    }
    return downloadTasksRepo.findTaskById(taskId);
  }

  // 独立任务没有队列消费 pending——就地重跑
  return runStandaloneTask(downloadTasksRepo.findTaskById(taskId));
}

async function retryQueue(queueId) {
  if (shuttingDown) {
    throw httpError(409, '服务正在停机');
  }

  const queue = downloadQueuesRepo.findQueueById(queueId);
  if (!queue) {
    throw httpError(404, '队列不存在');
  }

  // 运行中队列重置 failed→pending 会产生两套调度来源（活控制器与新协程），
  // 且 status=pending 覆写 running 造成状态漂移——要求先取消再重试。
  // draining 同理：排空协程的 abort-reset 会与新调度来源交错
  if (activeQueues.has(queueId) || drainingQueues.has(queueId)) {
    throw httpError(409, '队列正在运行中，请先取消');
  }
  if (deletingPlaylists.has(queue.playlistId)) {
    throw httpError(409, '该歌单正在删除中');
  }

  const tasks = downloadTasksRepo.listTasksByQueue(queueId);
  const failedTasks = tasks.filter(task => task.status === 'failed');

  if (failedTasks.length === 0) {
    throw httpError(400, '没有可重试的失败任务');
  }

  for (const task of failedTasks) {
    downloadTasksRepo.updateTask(task.id, {
      status: 'pending',
      progress: 0,
      errorMessage: null,
      completedAt: null,
      retryCount: 0  // 重置次数，否则 retryCount=3 的任务重试一次又判死
    });
  }

  // completedTasks 不动：失败任务从未计入完成数
  downloadQueuesRepo.updateQueue(queueId, {
    status: 'pending',
    failedTasks: 0,
    completedAt: null
  });

  return downloadQueuesRepo.findQueueById(queueId);
}

// 停机：abort 全部活跃控制器（队列 + standalone）并排空在途任务收尾，
// 否则被 SIGKILL 窗口截断的半成品文件无人清理
async function shutdownAll() {
  shuttingDown = true;
  const drains = [];
  for (const map of [activeQueues, drainingQueues]) {
    for (const [queueId, controller] of map) {
      abortController(controller);
      drains.push(controller.done);
      try {
        downloadQueuesRepo.updateQueue(queueId, { status: 'cancelled' });
      } catch { /* 停机路径尽力而为 */ }
    }
  }
  activeQueues.clear();
  drainingQueues.clear();

  for (const entry of standaloneRunning.values()) {
    entry.abort.abort();
    drains.push(entry.done);
  }

  // 停机有外层强退兜底，但排空仍加时限——不可中止的上游调用不能拖住停机路径
  await Promise.all(drains.map(d => drainWithTimeout(d)));

  for (const task of downloadTasksRepo.listTasksByStatus('downloading')) {
    downloadTasksRepo.updateTask(task.id, {
      status: 'pending',
      errorMessage: '服务停机中断'
    });
  }
}

// 启动恢复：上次崩溃/强杀残留的 running/paused 队列与 downloading 任务
// 没有任何内存控制器了，复位为 pending 让用户可再次启动
function recoverStaleStates() {
  for (const queue of downloadQueuesRepo.listQueues()) {
    if (queue.status === 'running' || queue.status === 'paused') {
      downloadQueuesRepo.updateQueue(queue.id, { status: 'pending' });
    }
  }
  for (const task of downloadTasksRepo.listTasksByStatus('downloading')) {
    downloadTasksRepo.updateTask(task.id, {
      status: 'pending',
      progress: 0,
      errorMessage: '服务重启中断'
    });
  }
}

module.exports = {
  createDownloadQueue,
  startQueue,
  pauseQueue,
  resumeQueue,
  cancelQueue,
  deleteQueue,
  deleteTask,
  deletePlaylistFiles,
  deletePlaylistCascade,
  retryTask,
  retryQueue,
  getQueueProgress,
  listTasks,
  downloadSingleSong,
  getSongDownloadStatus,
  toPublicTask,
  deleteSongFiles,
  deletePlaylistDownloadedFiles,
  recoverStaleStates,
  shutdownAll
};

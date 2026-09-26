const path = require('path');
const downloadTasksRepo = require('../repositories/downloadTasks');
const downloadQueuesRepo = require('../repositories/downloadQueues');
const playlistTracksRepo = require('../repositories/playlistTracks');
const playlistsRepo = require('../repositories/playlists');
const { dataDir } = require('../db/client');
const { importPlaylistFromNetease } = require('./playlist-sync');
const fileDownloader = require('./file-downloader');

// 下载文件根目录：<dataDir>/downloads，可用 DOWNLOAD_DIR 覆盖（容器内指到挂载卷）
const DOWNLOAD_BASE_DIR = process.env.DOWNLOAD_DIR || path.join(dataDir, 'downloads');

// 运行中队列的控制器集合：queueId -> { paused, cancelled }
const activeQueues = new Map();

async function resolvePlaylistId(playlistId) {
  const numericId = Number(playlistId);
  if (Number.isNaN(numericId)) {
    throw new Error('无效的歌单 ID');
  }

  const byLocalId = playlistsRepo.findPlaylistById(numericId);
  if (byLocalId) {
    return byLocalId.id;
  }

  const byNeteaseId = playlistsRepo.findPlaylistByNeteaseId(String(playlistId));
  if (byNeteaseId) {
    return byNeteaseId.id;
  }

  const imported = await importPlaylistFromNetease(String(playlistId));
  if (imported?.id) {
    return imported.id;
  }

  throw new Error('歌单不存在');
}

function deleteFiles(filePaths) {
  const fs = require('fs');
  let deletedFiles = 0;

  for (const filePath of filePaths.filter(Boolean)) {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      deletedFiles += 1;
    }
  }

  return deletedFiles;
}

async function createDownloadQueue(playlistId, options = {}) {
  const resolvedPlaylistId = await resolvePlaylistId(playlistId);
  const playlist = playlistsRepo.findPlaylistById(resolvedPlaylistId);
  if (!playlist) {
    throw new Error('歌单不存在');
  }

  const tracks = playlistTracksRepo.listTracksByPlaylistId(resolvedPlaylistId);
  if (tracks.length === 0) {
    throw new Error('歌单中没有歌曲');
  }

  const queue = downloadQueuesRepo.createQueue({
    playlistId: resolvedPlaylistId,
    name: playlist.name,
    totalTasks: tracks.length,
    bitrate: options.bitrate || 320000,
    downloadAudio: options.downloadAudio !== false,
    downloadLyrics: options.downloadLyrics !== false,
    downloadCover: options.downloadCover !== false,
    concurrentLimit: options.concurrentLimit || 3
  });

  for (const track of tracks) {
    const artists = track.ar || track.artists || [];
    const album = track.al || track.album || {};

    const artistName = artists.map(a => a.name).join(', ') || '未知艺术家';
    const albumName = album.name || '未知专辑';
    const coverUrl = album.picUrl || album.pic_str || null;

    const existingTask = downloadTasksRepo.findTaskByQueueAndSongId(queue.id, String(track.id));
    if (!existingTask) {
      downloadTasksRepo.createTask({
        playlistId: resolvedPlaylistId,
        queueId: queue.id,
        songId: String(track.id),
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
    }
  }

  return queue;
}

async function startQueue(queueId) {
  const queue = downloadQueuesRepo.findQueueById(queueId);
  if (!queue) {
    throw new Error('队列不存在');
  }

  if (activeQueues.has(queueId)) {
    throw new Error('队列已在运行中');
  }

  downloadQueuesRepo.updateQueue(queueId, { status: 'running' });

  const controller = {
    paused: false,
    cancelled: false
  };
  activeQueues.set(queueId, controller);

  processQueue(queueId, controller).catch(error => {
    console.error(`队列 ${queueId} 处理失败:`, error);
    downloadQueuesRepo.updateQueue(queueId, { status: 'failed' });
    activeQueues.delete(queueId);
  });

  return downloadQueuesRepo.findQueueById(queueId);
}

async function processQueue(queueId, controller) {
  const queue = downloadQueuesRepo.findQueueById(queueId);
  const tasks = downloadTasksRepo.listTasksByQueue(queueId);

  const pendingTasks = tasks.filter(t => t.status === 'pending');
  const concurrentLimit = queue.concurrentLimit;

  const runningTasks = [];

  for (const task of pendingTasks) {
    if (controller.cancelled) {
      downloadQueuesRepo.updateQueue(queueId, { status: 'cancelled' });
      activeQueues.delete(queueId);
      return;
    }

    while (controller.paused) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    while (runningTasks.length >= concurrentLimit) {
      await Promise.race(runningTasks);
    }

    const taskPromise = processTask(task, queueId)
      .finally(() => {
        const index = runningTasks.indexOf(taskPromise);
        if (index > -1) {
          runningTasks.splice(index, 1);
        }
      });

    runningTasks.push(taskPromise);
  }

  await Promise.all(runningTasks);

  const finalQueue = downloadQueuesRepo.findQueueById(queueId);
  const allTasks = downloadTasksRepo.listTasksByQueue(queueId);
  const completedCount = allTasks.filter(t => t.status === 'completed').length;
  const failedCount = allTasks.filter(t => t.status === 'failed').length;

  downloadQueuesRepo.updateQueue(queueId, {
    status: 'completed',
    completedTasks: completedCount,
    failedTasks: failedCount,
    completedAt: new Date().toISOString()
  });

  activeQueues.delete(queueId);
}

async function processTask(task, queueId) {
  try {
    downloadTasksRepo.updateTask(task.id, {
      status: 'downloading',
      progress: 0,
      errorMessage: null
    });

    const outputDir = path.join(DOWNLOAD_BASE_DIR, task.playlistId.toString());
    const sanitizedArtist = fileDownloader.sanitizeFilename(task.artist);
    const sanitizedSongName = fileDownloader.sanitizeFilename(task.songName);
    const baseFilename = `${sanitizedArtist} - ${sanitizedSongName}`;

    let totalProgress = 0;
    const weights = {
      audio: task.downloadAudio ? 70 : 0,
      lyrics: task.downloadLyrics ? 15 : 0,
      cover: task.downloadCover ? 15 : 0
    };

    if (task.downloadAudio) {
      const audioPath = path.join(outputDir, 'audio', `${baseFilename}.mp3`);
      await fileDownloader.downloadAudio(
        task.songId,
        audioPath,
        task.bitrate,
        (progress) => {
          const audioProgress = Math.floor(progress * weights.audio / 100);
          downloadTasksRepo.updateTask(task.id, {
            progress: totalProgress + audioProgress
          });
        }
      );
      totalProgress += weights.audio;
      downloadTasksRepo.updateTask(task.id, {
        audioPath,
        progress: totalProgress
      });
    }

    if (task.downloadLyrics) {
      try {
        const lyricsPath = path.join(outputDir, 'lyrics', `${baseFilename}.lrc`);
        await fileDownloader.downloadLyrics(task.songId, lyricsPath);
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

    if (task.downloadCover && task.coverUrl) {
      try {
        const coverPath = path.join(outputDir, 'covers', `${task.songId}.jpg`);
        await fileDownloader.downloadCover(task.coverUrl, coverPath);
        totalProgress += weights.cover;
        downloadTasksRepo.updateTask(task.id, {
          coverPath,
          progress: totalProgress
        });
      } catch (error) {
        console.warn(`封面下载失败 (${task.songId}):`, error.message);
      }
    }

    downloadTasksRepo.updateTask(task.id, {
      status: 'completed',
      progress: 100,
      completedAt: new Date().toISOString()
    });

    downloadQueuesRepo.incrementCompleted(queueId);

  } catch (error) {
    console.error(`任务 ${task.id} 失败:`, error);

    if (task.retryCount < 3) {
      downloadTasksRepo.updateTask(task.id, {
        retryCount: task.retryCount + 1,
        status: 'pending',
        errorMessage: error.message
      });
    } else {
      downloadTasksRepo.updateTask(task.id, {
        status: 'failed',
        errorMessage: error.message
      });
      downloadQueuesRepo.incrementFailed(queueId);
    }
  }
}

async function pauseQueue(queueId) {
  const controller = activeQueues.get(queueId);
  if (!controller) {
    throw new Error('队列未运行');
  }

  controller.paused = true;
  downloadQueuesRepo.updateQueue(queueId, { status: 'paused' });

  return downloadQueuesRepo.findQueueById(queueId);
}

async function resumeQueue(queueId) {
  const controller = activeQueues.get(queueId);
  if (!controller) {
    throw new Error('队列未运行');
  }

  controller.paused = false;
  downloadQueuesRepo.updateQueue(queueId, { status: 'running' });

  return downloadQueuesRepo.findQueueById(queueId);
}

async function cancelQueue(queueId) {
  const controller = activeQueues.get(queueId);
  if (controller) {
    controller.cancelled = true;
  }

  downloadQueuesRepo.updateQueue(queueId, { status: 'cancelled' });
  activeQueues.delete(queueId);

  return downloadQueuesRepo.findQueueById(queueId);
}

function getQueueProgress(queueId) {
  const queue = downloadQueuesRepo.findQueueById(queueId);
  if (!queue) {
    throw new Error('队列不存在');
  }

  const tasks = downloadTasksRepo.listTasksByQueue(queueId);
  const statusCounts = downloadTasksRepo.countTasksByQueueAndStatus(queueId);

  return {
    queue,
    tasks,
    statusCounts,
    isActive: activeQueues.has(queueId)
  };
}

// 下载单首歌曲到服务器
async function downloadSingleSong(playlistId, songId, options = {}) {
  const resolvedPlaylistId = await resolvePlaylistId(playlistId);
  const tracks = playlistTracksRepo.listTracksByPlaylistId(resolvedPlaylistId);
  const track = tracks.find(t => String(t.id) === String(songId));

  if (!track) {
    throw new Error('歌曲不存在');
  }

  const artists = track.ar || track.artists || [];
  const album = track.al || track.album || {};
  const artistName = artists.map(a => a.name).join(', ') || '未知艺术家';
  const albumName = album.name || '未知专辑';
  const coverUrl = album.picUrl || album.pic_str || null;

  let task = downloadTasksRepo.findTaskByPlaylistAndSongId(resolvedPlaylistId, String(songId));

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

  await processTask(task, null);

  return downloadTasksRepo.findTaskById(task.id);
}

// 查询歌曲下载状态
async function getSongDownloadStatus(playlistId, songId) {
  const resolvedPlaylistId = await resolvePlaylistId(playlistId);
  const task = downloadTasksRepo.findTaskByPlaylistAndSongId(resolvedPlaylistId, String(songId));

  return {
    downloaded: task && task.status === 'completed',
    task: task || null
  };
}

// 删除歌曲文件
async function deleteSongFiles(playlistId, songId) {
  const resolvedPlaylistId = await resolvePlaylistId(playlistId);
  const task = downloadTasksRepo.findTaskByPlaylistAndSongId(resolvedPlaylistId, String(songId));

  if (!task) {
    throw new Error('任务不存在');
  }

  const deletedFiles = deleteFiles([task.audioPath, task.lyricsPath, task.coverPath]);

  downloadTasksRepo.deleteTask(task.id);

  return { success: true, deletedFiles };
}

async function deletePlaylistDownloadedFiles(playlistId) {
  const resolvedPlaylistId = await resolvePlaylistId(playlistId);
  const tasks = downloadTasksRepo.listStandaloneTasksByPlaylist(resolvedPlaylistId);
  const downloadedTasks = tasks.filter(task => task.status === 'completed' || task.audioPath || task.lyricsPath || task.coverPath);

  let deletedSongs = 0;
  let deletedFiles = 0;

  for (const task of downloadedTasks) {
    deletedFiles += deleteFiles([task.audioPath, task.lyricsPath, task.coverPath]);
    downloadTasksRepo.deleteTask(task.id);
    deletedSongs += 1;
  }

  return {
    success: true,
    deletedSongs,
    deletedFiles
  };
}

async function retryTask(taskId) {
  const task = downloadTasksRepo.findTaskById(taskId);
  if (!task) {
    throw new Error('任务不存在');
  }

  const queue = task.queueId ? downloadQueuesRepo.findQueueById(task.queueId) : null;

  downloadTasksRepo.updateTask(taskId, {
    status: 'pending',
    progress: 0,
    errorMessage: null,
    completedAt: null
  });

  if (queue) {
    downloadQueuesRepo.decrementFailed(queue.id);
    if (queue.status === 'failed' || queue.status === 'completed') {
      downloadQueuesRepo.updateQueue(queue.id, {
        status: 'pending',
        completedAt: null
      });
    }
  }

  return downloadTasksRepo.findTaskById(taskId);
}

async function retryQueue(queueId) {
  const queue = downloadQueuesRepo.findQueueById(queueId);
  if (!queue) {
    throw new Error('队列不存在');
  }

  const tasks = downloadTasksRepo.listTasksByQueue(queueId);
  const failedTasks = tasks.filter(task => task.status === 'failed');

  if (failedTasks.length === 0) {
    throw new Error('没有可重试的失败任务');
  }

  for (const task of failedTasks) {
    downloadTasksRepo.updateTask(task.id, {
      status: 'pending',
      progress: 0,
      errorMessage: null,
      completedAt: null
    });
  }

  downloadQueuesRepo.updateQueue(queueId, {
    status: 'pending',
    failedTasks: 0,
    completedTasks: Math.max(queue.completedTasks - failedTasks.length, 0),
    completedAt: null
  });

  return downloadQueuesRepo.findQueueById(queueId);
}

module.exports = {
  createDownloadQueue,
  startQueue,
  pauseQueue,
  resumeQueue,
  cancelQueue,
  retryTask,
  retryQueue,
  getQueueProgress,
  downloadSingleSong,
  getSongDownloadStatus,
  deleteSongFiles,
  deletePlaylistDownloadedFiles
};

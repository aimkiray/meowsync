import axios from 'axios';
import { resolveApiBaseUrl } from '../lib/api-base';

const API_BASE_URL = resolveApiBaseUrl();

// DOWNLOAD_TOKEN（构建期注入）：服务端开了写鉴权时前端请求自动带令牌
const DOWNLOAD_TOKEN = import.meta.env.VITE_DOWNLOAD_TOKEN || '';

// 默认超时：轮询/查询类请求挂起时必须能 settle——裸 axios 无超时会让
// AdminPanel 的 pollInFlight 标志永久卡住、轮询停摆。单曲下载/任务重试
// 都是"提交即返回"的异步语义，终态由状态轮询确认——不再需要长超时通道
const http = axios.create({
  timeout: Number(import.meta.env.VITE_API_TIMEOUT) || 10000,
  headers: DOWNLOAD_TOKEN ? { 'x-download-token': DOWNLOAD_TOKEN } : {}
});

export const downloadsApi = {
  createQueue: (playlistId, options = {}) => {
    // 歌单未导入时服务端会先走两次上游往返（detail+tracks），慢网可超默认 15s——
    // 超时后服务端仍建成队列，重试只会撞 409，给足 60s
    return http.post(`${API_BASE_URL}/downloads/queues`, {
      playlistId,
      bitrate: options.bitrate || 320000,
      downloadAudio: options.downloadAudio !== false,
      downloadLyrics: options.downloadLyrics !== false,
      downloadCover: options.downloadCover !== false,
      concurrentLimit: options.concurrentLimit || 3
    }, { timeout: 60000 });
  },

  listQueues: () => {
    return http.get(`${API_BASE_URL}/downloads/queues`);
  },

  getQueue: (id) => {
    return http.get(`${API_BASE_URL}/downloads/queues/${id}`);
  },

  startQueue: (id) => {
    return http.post(`${API_BASE_URL}/downloads/queues/${id}/start`);
  },

  pauseQueue: (id) => {
    return http.post(`${API_BASE_URL}/downloads/queues/${id}/pause`);
  },

  resumeQueue: (id) => {
    return http.post(`${API_BASE_URL}/downloads/queues/${id}/resume`);
  },

  cancelQueue: (id) => {
    return http.post(`${API_BASE_URL}/downloads/queues/${id}/cancel`);
  },

  retryQueue: (id) => {
    return http.post(`${API_BASE_URL}/downloads/queues/${id}/retry`);
  },

  deleteQueue: (id) => {
    // 服务端要等中止+排空在途下载（排空上限 30s），15s 默认超时会让客户端
    // 先报"失败"而服务端实际删完——重试拿到 404 体验错乱，给 60s
    return http.delete(`${API_BASE_URL}/downloads/queues/${id}`, {
      timeout: 60000
    });
  },

  listTasks: (params = {}) => {
    return http.get(`${API_BASE_URL}/downloads/tasks`, { params });
  },

  retryTask: (id) => {
    // 重试即提交即返回（后台协程跑），终态由任务轮询确认
    return http.post(`${API_BASE_URL}/downloads/tasks/${id}/retry`);
  },

  // 提交单曲下载到服务器（返回 pending/completed 任务行，不阻塞等下载完成——
  // 终态用 getSongDownloadStatus 轮询；completed 行是幂等短路返回）。
  // 超时仍要给足：歌单未导入时服务端先走两次上游往返才提交任务
  downloadSongToServer: (playlistId, songId, options = {}) => {
    return http.post(`${API_BASE_URL}/downloads/songs/${songId}`, {
      playlistId,
      bitrate: options.bitrate || 320000,
      downloadAudio: options.downloadAudio !== false,
      downloadLyrics: options.downloadLyrics !== false,
      downloadCover: options.downloadCover !== false
    }, { timeout: 60000 });
  },

  // 查询歌曲下载状态
  getSongDownloadStatus: (playlistId, songId) => {
    return http.get(`${API_BASE_URL}/downloads/songs/${songId}/status`, {
      params: { playlistId }
    });
  },

  // 删除已下载的歌曲
  deleteSongDownload: (playlistId, songId) => {
    return http.delete(`${API_BASE_URL}/downloads/songs/${songId}`, {
      params: { playlistId }
    });
  },

  // 删除歌单全部已下载歌曲（排空在途下载可能耗数秒，给足超时）
  deletePlaylistDownloads: (playlistId) => {
    return http.delete(`${API_BASE_URL}/downloads/playlists/${playlistId}/files`, {
      timeout: 60000
    });
  },

  // 本地歌单（local_pl_*/saved_queue_*）先镜像到服务端 DB，之后所有下载路由
  // 用 playlist.id 直调（服务端 findExistingPlaylistId 按 netease_playlist_id 解析镜像）。
  // 返回 {playlistId, mirrored, skipped}——skipped = 无服务端下载源的曲目（bv_*/yt_*）数
  mirrorLocalPlaylist: (playlist) => {
    // 瘦身投影：服务端只消费 id/name/ar/al/dt。本地 tracks 存的是全量曲对象
    // （~2-3KB/首），原样上载 ~400 首就撞 1MB body 上限；投影后 2000 曲 ≈600KB
    const tracks = (playlist.tracks || []).map(t => t && ({
      id: t.id,
      name: t.name,
      ar: (Array.isArray(t.ar) ? t.ar : t.artists || []).map(a => ({ name: a?.name })),
      al: {
        name: t.al?.name || t.album?.name || '',
        picUrl: t.al?.picUrl || t.album?.picUrl || '',
        // pic_str 是上游专辑对象的双生字段——有些专辑只有它没有 picUrl，
        // 下载管理器取封面会先试 picUrl 再兜 pic_str，丢了会让封面静默缺失
        pic_str: t.al?.pic_str || t.album?.pic_str || ''
      },
      dt: t.dt || t.duration || 0,
      // qq mediaMid 是 vkey filename 键——带过去下载链可省一次 detail 回填往返
      ...(t.qq?.mediaMid ? { qq: { mediaMid: t.qq.mediaMid } } : {})
    }))
    return http.post(`${API_BASE_URL}/downloads/local/mirror`, {
      localId: playlist.id,
      name: playlist.name,
      coverImgUrl: playlist.coverImgUrl || '',
      tracks
    }, { timeout: 30000 });
  },

  // 本地单从库中移除时清服务端镜像（行+任务+文件级联）。fire-and-forget 即可——
  // 失败仅留孤儿行，不阻塞前端删除
  removeLocalMirror: (localId) => {
    return http.delete(`${API_BASE_URL}/downloads/local/mirror/${encodeURIComponent(localId)}`);
  },

  // 歌曲级歌词时间校准：GET 无行时返回 offsetMs:0；PUT 写绝对值（0=删行复位）
  getSongMeta: (songId) => {
    return http.get(`${API_BASE_URL}/song-meta/${encodeURIComponent(songId)}`);
  },
  saveLyricOffset: (songId, offsetMs) => {
    return http.put(`${API_BASE_URL}/song-meta/${encodeURIComponent(songId)}`, { offsetMs });
  },

  // 快速下载歌单（建队列 + 启动即返回，后台跑）；歌单未导入时同样要先走上游
  // 导入（detail+tracks 两次往返），超时后重试会撞"已有进行中队列"的 409——给 60s
  quickDownloadPlaylist: (playlistId, options = {}) => {
    return http.post(`${API_BASE_URL}/downloads/playlists/${playlistId}/quick`, {
      bitrate: options.bitrate || 320000,
      downloadAudio: options.downloadAudio !== false,
      downloadLyrics: options.downloadLyrics !== false,
      downloadCover: options.downloadCover !== false,
      concurrentLimit: options.concurrentLimit || 3
    }, { timeout: 60000 });
  }
};

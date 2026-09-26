import axios from 'axios';
import { resolveApiBaseUrl } from '../lib/api-base';

const API_BASE_URL = resolveApiBaseUrl();

// DOWNLOAD_TOKEN（构建期注入）：服务端开了写鉴权时前端请求自动带令牌
const DOWNLOAD_TOKEN = import.meta.env.VITE_DOWNLOAD_TOKEN || '';

// 默认超时：轮询/查询类请求挂起时必须能 settle——裸 axios 无超时会让
// AdminPanel 的 pollInFlight 标志永久卡住、轮询停摆
const http = axios.create({
  timeout: Number(import.meta.env.VITE_API_TIMEOUT) || 15000,
  headers: DOWNLOAD_TOKEN ? { 'x-download-token': DOWNLOAD_TOKEN } : {}
});

// 同步阻塞型操作（单曲下载原地跑完、standalone 重试）：单曲最坏要数分钟
const httpLong = axios.create({
  timeout: 10 * 60 * 1000,
  headers: DOWNLOAD_TOKEN ? { 'x-download-token': DOWNLOAD_TOKEN } : {}
});

export const downloadsApi = {
  createQueue: (playlistId, options = {}) => {
    return http.post(`${API_BASE_URL}/downloads/queues`, {
      playlistId,
      bitrate: options.bitrate || 320000,
      downloadAudio: options.downloadAudio !== false,
      downloadLyrics: options.downloadLyrics !== false,
      downloadCover: options.downloadCover !== false,
      concurrentLimit: options.concurrentLimit || 3
    });
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
    return http.delete(`${API_BASE_URL}/downloads/queues/${id}`);
  },

  listTasks: (params = {}) => {
    return http.get(`${API_BASE_URL}/downloads/tasks`, { params });
  },

  getTask: (id) => {
    return http.get(`${API_BASE_URL}/downloads/tasks/${id}`);
  },

  retryTask: (id) => {
    // standalone 任务重试是同步跑完的（阻塞到下载结束），必须长超时
    return httpLong.post(`${API_BASE_URL}/downloads/tasks/${id}/retry`);
  },

  deleteTask: (id) => {
    return http.delete(`${API_BASE_URL}/downloads/tasks/${id}`);
  },

  // 下载单首歌曲到服务器（同步阻塞到下载完成，长超时）
  downloadSongToServer: (playlistId, songId, options = {}) => {
    return httpLong.post(`${API_BASE_URL}/downloads/songs/${songId}`, {
      playlistId,
      bitrate: options.bitrate || 320000,
      downloadAudio: options.downloadAudio !== false,
      downloadLyrics: options.downloadLyrics !== false,
      downloadCover: options.downloadCover !== false
    });
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

  // 快速下载歌单（建队列 + 启动即返回，后台跑；不需要长超时）
  quickDownloadPlaylist: (playlistId, options = {}) => {
    return http.post(`${API_BASE_URL}/downloads/playlists/${playlistId}/quick`, {
      bitrate: options.bitrate || 320000,
      downloadAudio: options.downloadAudio !== false,
      downloadLyrics: options.downloadLyrics !== false,
      downloadCover: options.downloadCover !== false,
      concurrentLimit: options.concurrentLimit || 3
    });
  }
};

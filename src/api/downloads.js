import axios from 'axios';
import { resolveApiBaseUrl } from '../lib/api-base';

const API_BASE_URL = resolveApiBaseUrl();

export const downloadsApi = {
  createQueue: (playlistId, options = {}) => {
    return axios.post(`${API_BASE_URL}/downloads/queues`, {
      playlistId,
      bitrate: options.bitrate || 320000,
      downloadAudio: options.downloadAudio !== false,
      downloadLyrics: options.downloadLyrics !== false,
      downloadCover: options.downloadCover !== false,
      concurrentLimit: options.concurrentLimit || 3
    });
  },

  listQueues: () => {
    return axios.get(`${API_BASE_URL}/downloads/queues`);
  },

  getQueue: (id) => {
    return axios.get(`${API_BASE_URL}/downloads/queues/${id}`);
  },

  startQueue: (id) => {
    return axios.post(`${API_BASE_URL}/downloads/queues/${id}/start`);
  },

  pauseQueue: (id) => {
    return axios.post(`${API_BASE_URL}/downloads/queues/${id}/pause`);
  },

  resumeQueue: (id) => {
    return axios.post(`${API_BASE_URL}/downloads/queues/${id}/resume`);
  },

  retryQueue: (id) => {
    return axios.post(`${API_BASE_URL}/downloads/queues/${id}/retry`);
  },

  deleteQueue: (id) => {
    return axios.delete(`${API_BASE_URL}/downloads/queues/${id}`);
  },

  listTasks: (params = {}) => {
    return axios.get(`${API_BASE_URL}/downloads/tasks`, { params });
  },

  getTask: (id) => {
    return axios.get(`${API_BASE_URL}/downloads/tasks/${id}`);
  },

  retryTask: (id) => {
    return axios.post(`${API_BASE_URL}/downloads/tasks/${id}/retry`);
  },

  deleteTask: (id) => {
    return axios.delete(`${API_BASE_URL}/downloads/tasks/${id}`);
  },

  // 下载单首歌曲到服务器
  downloadSongToServer: (playlistId, songId, options = {}) => {
    return axios.post(`${API_BASE_URL}/downloads/songs/${songId}`, {
      playlistId,
      bitrate: options.bitrate || 320000,
      downloadAudio: options.downloadAudio !== false,
      downloadLyrics: options.downloadLyrics !== false,
      downloadCover: options.downloadCover !== false
    });
  },

  // 查询歌曲下载状态
  getSongDownloadStatus: (playlistId, songId) => {
    return axios.get(`${API_BASE_URL}/downloads/songs/${songId}/status`, {
      params: { playlistId }
    });
  },

  // 删除已下载的歌曲
  deleteSongDownload: (playlistId, songId) => {
    return axios.delete(`${API_BASE_URL}/downloads/songs/${songId}`, {
      params: { playlistId }
    });
  },

  // 删除歌单全部已下载歌曲
  deletePlaylistDownloads: (playlistId) => {
    return axios.delete(`${API_BASE_URL}/downloads/playlists/${playlistId}/files`);
  },

  // 快速下载歌单
  quickDownloadPlaylist: (playlistId, options = {}) => {
    return axios.post(`${API_BASE_URL}/downloads/playlists/${playlistId}/quick`, {
      bitrate: options.bitrate || 320000,
      downloadAudio: options.downloadAudio !== false,
      downloadLyrics: options.downloadLyrics !== false,
      downloadCover: options.downloadCover !== false,
      concurrentLimit: options.concurrentLimit || 3
    });
  }
};

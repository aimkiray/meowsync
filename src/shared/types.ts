// 边界契约类型：API 包络 / Track / provider_data / 下载任务 / WS 遥控消息。
// 纯类型文件——不产生运行时产物；JS 侧以 JSDoc `@type {import('../shared/types').X}`
// 消费，本文件是阶段 4 TS 化的锚点（形状口径与 predicates/protocol/contracts 对齐）。

/** 成功响应包络（服务端主导形态 {code:200, data}；少数端点平铺字段） */
export interface ApiOk<T = unknown> {
  code: 200;
  data?: T;
  [k: string]: unknown;
}

/** 失败响应包络（lib/http-error.js fail() 产出） */
export interface ApiErr {
  code: number;
  message: string;
  [k: string]: unknown;
}

export type ApiEnvelope<T = unknown> = ApiOk<T> | ApiErr;

/** 跨源歌曲 id：网易云数字 | 'qq_<songmid>' | 'bv_<bvid>' | 'yt_<id>' | 'local_*' */
export type SongId = string | number;

/** QQ 源私有元数据（download_tasks.provider_data.qq → vkey filename 键） */
export interface QqProviderData {
  mediaMid?: string;
  [k: string]: unknown;
}

/** B 站源私有元数据（download_tasks.provider_data.bilibili → 流定位 + 核验签名） */
export interface BiliProviderData {
  bvid: string;
  cid?: string | null;
  page?: number;
  /** 来源视频标题/UP 主——歌词归属核验的 verdict 签名输入 */
  title?: string | null;
  author?: string | null;
}

/** YouTube 源私有元数据（provider_data.youtube → 流定位 + 核验签名） */
export interface YouTubeProviderData {
  videoId: string;
  title?: string | null;
  author?: string | null;
}

export interface ProviderData {
  qq?: QqProviderData;
  bilibili?: BiliProviderData;
  youtube?: YouTubeProviderData;
  /** 匹配到的网易云词源 id——外部曲的歌词/核验都经它寻址 */
  neteaseId?: string | null;
  /** qq 嫁接网易词源的核验签名（曲自身名/艺人） */
  title?: string | null;
  author?: string | null;
  [k: string]: unknown;
}

export interface Artist { name?: string; [k: string]: unknown }
export interface Album { picUrl?: string; [k: string]: unknown }

/** 轨道对象：网易云原生字段 + 各源私有挂载点（播放源/词源键全在其中） */
export interface Track {
  id: SongId;
  name: string;
  ar?: Artist[];
  artists?: Artist[];
  al?: Album;
  album?: Album;
  dt?: number;
  duration?: number;
  fee?: number;
  privilege?: unknown;
  neteaseId?: SongId;
  qq?: QqProviderData;
  bilibili?: { bvid?: string; cid?: number | string; [k: string]: unknown };
  youtube?: { videoId?: string; [k: string]: unknown };
  [k: string]: unknown;
}

/** download_tasks.status 实际值域（download-manager VALID_TASK_STATUSES） */
export type DownloadTaskStatus = 'pending' | 'downloading' | 'completed' | 'failed';

/** download_queues.status 实际值域（队列级状态机） */
export type DownloadQueueStatus =
  | 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

/** 任务 API 透出对象（repositories/downloadTasks mapTaskRow + toPublicTask 投影） */
export interface DownloadTask {
  id: number;
  playlistId: number;
  queueId: number | null;
  songId: string;
  songName: string;
  artist?: string;
  album?: string | null;
  coverUrl?: string | null;
  status: DownloadTaskStatus;
  progress?: number;
  errorMessage?: string | null;
  retryCount?: number;
  downloadAudio?: boolean;
  downloadLyrics?: boolean;
  downloadCover?: boolean;
  downloadVideo?: boolean;
  // toPublicTask：DOWNLOAD_BASE_DIR 内相对路径或 null（站外路径不泄）
  audioPath?: string | null;
  lyricsPath?: string | null;
  coverPath?: string | null;
  videoPath?: string | null;
  /** 视频实际到手档位（file-downloader metaOf）：h/w 像素、codec、br 码率、source=progressive|adaptive */
  videoMeta?: { h?: number; w?: number; codec?: string | null; br?: number | null; source?: string } | null;
  // bitrate/progress/retryCount/timestamps 列有默认值兜底，但老库补列前的
  // 存量行可为 NULL——消费方按 | null 防御（类型是意图声明，非运行时保证）
  bitrate?: number;
  fileSize?: number | null;
  durationMs?: number | null;
  /** completed 但文件被外部删除 → false（前端据此重露下载入口） */
  filesIntact?: boolean;
  providerData?: ProviderData | null;
  // 老库补列前的存量行：created_at/updated_at 无 DEFAULT，可为 NULL
  createdAt?: string | null;
  updatedAt?: string | null;
  completedAt?: string | null;
  [k: string]: unknown;
}

// ── WS 遥控（与 shared/protocol.js 常量一一对应）──────────────────────────

export type RemoteControlType =
  | 'play' | 'pause' | 'next' | 'prev' | 'seek' | 'volume' | 'play_song';

/** controller→server→host */
export interface RemoteControlMessage {
  type: RemoteControlType;
  payload?: number | string | null;
}

export interface RemoteSongSnapshot {
  /** currentSong 的 id 可 null（queue 条目被过滤，currentSong 不过滤） */
  id: SongId | null;
  name: string;
  al: { picUrl: string };
  ar: { name: string }[];
}

/** host→server→controller 的播放器状态广播 */
export interface RemoteStatePayload {
  isPlaying: boolean;
  currentSong: RemoteSongSnapshot | null;
  currentTime: number;
  duration: number;
  volume: number;
  /** sanitizeStatePayload 只收数组——host 不送/送畸形时整键缺席 */
  queue?: RemoteSongSnapshot[];
  queueIndex: number;
}

export type RemoteServerToHost =
  | RemoteControlMessage
  | { type: 'request_state' }
  | { type: 'info'; payload: { controllers: number } };

export type RemoteServerToController =
  | { type: 'state_update'; payload: RemoteStatePayload }
  | { type: 'host_joined' }
  | { type: 'host_disconnected' }
  | { type: 'host_absent' };

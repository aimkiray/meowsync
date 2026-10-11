// 自有写接口的入参契约（zod schema 即文档）：服务端经 lib/validate.js 执行，
// 前端可直接 import 做发送前校验。业务规则（id 正则、墓碑窗、配额）仍在路由
// 层——这里只收「形状与量纲」：类型、必填、上限。
// looseObject 放行未知键（与历史行为一致：多余字段被忽略而非 400）。
import { z } from 'zod';

const PLAYLIST_ID = z.union([
  z.number().int().positive(),
  z.string().min(1).max(120)
]);

// 下载队列可选参数（normalizeDownloadOptions 仍做脏值回落——schema 是硬边界）
const DOWNLOAD_OPTIONS = {
  bitrate: z.number().int().min(64000).max(999000).optional(),
  downloadAudio: z.boolean().optional(),
  downloadLyrics: z.boolean().optional(),
  downloadCover: z.boolean().optional(),
  // 视频工件 opt-in：只对 bv_/yt_ 外部曲生效（网易云/QQ 无源站视频可下）
  downloadVideo: z.boolean().optional(),
  concurrentLimit: z.number().int().min(1).max(10).optional()
};

// POST /downloads/queues 与 /downloads/songs/:songId 同构
export const downloadTaskBody = z.looseObject({
  playlistId: PLAYLIST_ID,
  ...DOWNLOAD_OPTIONS
});

// POST /downloads/playlists/:playlistId/quick（playlistId 走路径参数）
export const quickDownloadBody = z.looseObject({ ...DOWNLOAD_OPTIONS });

// POST /downloads/local/mirror：tracks 逐项整形在路由层（瘦身投影容错过滤），
// schema 只管顶层形状与体量上限
export const mirrorBody = z.looseObject({
  localId: z.string().min(1).max(80),
  name: z.string().max(400).optional(),
  coverImgUrl: z.string().max(2000).optional(),
  tracks: z.array(z.unknown()).max(5000).optional()
});

// POST /playlists/import（neteasePlaylistId 允许 query 兜底，body 内可选）
export const importPlaylistBody = z.looseObject({
  neteasePlaylistId: z.union([z.string().max(40), z.number().int().positive()]).optional()
});

// PUT /song-meta/:id：±5 分钟偏移校准上限
export const songMetaBody = z.looseObject({
  offsetMs: z.number().int().refine(
    (v) => Math.abs(v) <= 300000,
    '须为 ±300000 内的整数'
  )
});

// POST /auth/setup 与 /auth/login：登录凭据契约。
// username 白名单字符集（防注入展示/HTML），password 8-128（OWASP 建议下限 8，
// 上限防 bcrypt 式截断语义与超长 DoS——argon2/scrypt 无截断问题但超长输入
// 会拉满 KDF 内存参数耗时，收 128 够任何口令管理器生成的串）
export const authCredentialsBody = z.looseObject({
  username: z.string().min(1).max(64).regex(/^[\w.@-]+$/u, '用户名只能含字母数字与 . @ _ -'),
  password: z.string().min(8, '密码至少 8 位').max(128)
});

// POST /ai/lyric-translate 与 /ai/lyric-verify：id 形态（数字/qq_/bv_/yt_ 前缀）
// 由路由层正则把关——这里只收「存在且是标量」
export const aiLyricBody = z.looseObject({
  id: z.union([z.string(), z.number()]),
  sourceTitle: z.string().optional(),
  sourceAuthor: z.string().optional(),
  // lyric-verify 可选：来源轨道 id——yt_ 形态时服务端反解投稿自署本家
  // 作判定语境（声明位进 vkey 分键）；缺席与旧 body 行为逐位同
  trackId: z.string().max(200).optional(),
  // lyric-verify 可选：源媒体发布日（epoch ms）——稿日倒挂判据的时间
  // 证据；客户端只送有限正数，缺席/脏值按未知处理不拒
  publishedAt: z.number().int().positive().optional()
});

// PUT /settings：键白名单与值整形在 lib/settings.js（含 ASCII/长度/归一化）；
// schema 只挡体量与类型——null/'' 是「清覆盖回落 env」语义而非空值校验错
export const settingsBody = z.looseObject({
  ai_base_url: z.union([z.string().max(1000), z.null()]).optional(),
  ai_api_key: z.union([z.string().max(1000), z.null()]).optional(),
  ai_model: z.union([z.string().max(500), z.null()]).optional(),
  ai_timeout_ms: z.union([z.string().max(20), z.number().int(), z.null()]).optional(),
  bili_cookie: z.union([z.string().max(8000), z.null()]).optional(),
  qq_cookie: z.union([z.string().max(8000), z.null()]).optional(),
  yt_cookie: z.union([z.string().max(8000), z.null()]).optional(),
  // 代理 URL（可内嵌 user:pass@）——上限对齐 lib/settings DEFS.maxLen
  yt_proxy: z.union([z.string().max(500), z.null()]).optional()
});

// POST /settings/ai-test：三段均可选——留空字段用已生效配置补位
export const aiTestBody = z.looseObject({
  baseUrl: z.string().max(1000).optional(),
  apiKey: z.string().max(1000).optional(),
  model: z.string().max(500).optional()
});

// /lyric-align 歌词行上限的唯一真相源：schema 校验、路由层取词截断、
// 客户端发送前截断（usePlayer alignCurrentLyrics）、下载链纯文本补轴
// 截断（file-downloader alignPlainLrc）共用同一份数——单行 ≤500 字、
// 行数 ≤600，超了原样发只会吃笼统 400
export const LYRIC_ALIGN_MAX_LINE_CHARS = 500;
export const LYRIC_ALIGN_MAX_LINES = 600;

// POST /lyric-align：音频定位（audioPath 直指或 songId 查 download_tasks）
// 与歌词行来源（lines 直传或 songId 拉词源）的组合判定在路由层——
// schema 只收形状与上限
export const lyricAlignBody = z.looseObject({
  songId: z.union([z.string().min(1).max(120), z.number().int().positive()]).optional(),
  audioPath: z.string().min(1).max(1000).optional(),
  lines: z.array(z.string().max(LYRIC_ALIGN_MAX_LINE_CHARS)).max(LYRIC_ALIGN_MAX_LINES).optional()
});

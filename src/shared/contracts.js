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
  sourceAuthor: z.string().optional()
});

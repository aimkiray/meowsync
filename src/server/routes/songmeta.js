const { Hono } = require('hono');
const songMetaRepo = require('../repositories/songLyricMeta');
const { parseJsonBody } = require('../lib/validate');
const { csrfOriginOk } = require('../lib/auth-gate');
const { fail } = require('../lib/http-error');
const { rateLimit } = require('../lib/rate-limit');
const { songMetaBody } = require('../../shared/contracts.js');
const {
  NETEASE_ID_RE, FILE_TRACK_ID_RE, QQ_SONG_ID_RE,
  BV_TRACK_ID_RE, YT_TRACK_ID_RE, EXT_LYRIC_ID_STRICT_RE,
} = require('../../shared/predicates.js');

const app = new Hono();

// song_id 是词归属键：数字网易云、qq_<mid>、file_ 上传、bv_/yt_ 导入轨道、
// 外源词源 id（lrclib_+120 也合法——旧 64 字符通用正则会把外源键 400 掉）。
// 一律复用共享谓词，形态集合跟词源 id 族同步演进不散养
const SONG_ID_RES = [
  NETEASE_ID_RE, FILE_TRACK_ID_RE, QQ_SONG_ID_RE,
  BV_TRACK_ID_RE, YT_TRACK_ID_RE, EXT_LYRIC_ID_STRICT_RE,
];
const songIdOk = (id) => SONG_ID_RES.some(re => re.test(id));

// GET /song-meta/:id —— 无校准行返回 offsetMs:0（200 而非 404：
// 「未校准」是正常状态，不该走前端错误通道）
app.get('/song-meta/:id', (c) => {
  if (!rateLimit(c, 'songmeta', 60)) {
    return c.json({ code: 429, message: '请求太频繁' }, 429);
  }
  const id = c.req.param('id');
  if (!songIdOk(id)) {
    return c.json({ code: 400, message: '非法 songId' }, 400);
  }
  return c.json({ code: 200, songId: id, offsetMs: songMetaRepo.getOffsetMs(id) });
});

// PUT /song-meta/:id  {offsetMs} —— 绝对值 upsert（客户端防抖后只发终值，
// 并发两写按到达顺序后者胜，语义与「最后看到的校准值」一致）。
// offsetMs=0 即恢复默认：直接删行，表保持「只有真正校准过的歌」
app.put('/song-meta/:id', async (c) => {
  // 写请求 CSRF 纵深（与 routes/sync.js 同口径）：session 写 authGate 已查，
  // 但 DOWNLOAD_TOKEN 旁路/开放部署不经那一道——无登录态下跨站 PUT 也能改库
  if (!csrfOriginOk(c)) return fail(c, 403, 'Forbidden');
  // 写端点独立桶更紧（与 music/music:unlock 分桶同口径）：offset upsert
  // 直写库，客户端防抖后正常每分钟几次；GET 读流量不占写配额
  if (!rateLimit(c, 'songmeta:write', 30)) {
    return c.json({ code: 429, message: '请求太频繁' }, 429);
  }
  const id = c.req.param('id');
  if (!songIdOk(id)) {
    return c.json({ code: 400, message: '非法 songId' }, 400);
  }
  // ±300000 区间校验在 shared/contracts.js 的 songMetaBody schema 里
  const { data: body, error } = await parseJsonBody(c, songMetaBody, 16 * 1024);
  if (error) return error;
  const offsetMs = body.offsetMs;
  if (offsetMs === 0) {
    songMetaRepo.deleteOffsetMs(id);
  } else {
    songMetaRepo.upsertOffsetMs(id, offsetMs);
  }
  return c.json({ code: 200, songId: id, offsetMs });
});

module.exports = app;

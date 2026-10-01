const { Hono } = require('hono');
const songMetaRepo = require('../repositories/songLyricMeta');
const { parseJsonBody } = require('../lib/validate');
const { songMetaBody } = require('../../shared/contracts.js');

const app = new Hono();

// song_id 覆盖数字网易云 id 与 bv_/yt_ 系列（外部导入曲有 neteaseId 时前端按词源 id 存，
// 无 neteaseId 的纯导入曲没有歌词源也不会走到这里——仍放行不误伤）
const SONG_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// GET /song-meta/:id —— 无校准行返回 offsetMs:0（200 而非 404：
// 「未校准」是正常状态，不该走前端错误通道）
app.get('/song-meta/:id', (c) => {
  const id = c.req.param('id');
  if (!SONG_ID_RE.test(id)) {
    return c.json({ code: 400, message: '非法 songId' }, 400);
  }
  return c.json({ code: 200, songId: id, offsetMs: songMetaRepo.getOffsetMs(id) });
});

// PUT /song-meta/:id  {offsetMs} —— 绝对值 upsert（客户端防抖后只发终值，
// 并发两写按到达顺序后者胜，语义与「最后看到的校准值」一致）。
// offsetMs=0 即恢复默认：直接删行，表保持「只有真正校准过的歌」
app.put('/song-meta/:id', async (c) => {
  const id = c.req.param('id');
  if (!SONG_ID_RE.test(id)) {
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

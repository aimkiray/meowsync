const { Hono } = require('hono');
const songMetaRepo = require('../repositories/songLyricMeta');
const { readJsonBody } = require('../lib/http-body');

const app = new Hono();

// song_id 覆盖数字网易云 id 与 bv_/yt_ 系列（外部导入曲有 neteaseId 时前端按词源 id 存，
// 无 neteaseId 的纯导入曲没有歌词源也不会走到这里——仍放行不误伤）
const SONG_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// 歌词整体错位超过 ±5min 多半不是校准而是词源错了——限制在一个有意义的区间
const MAX_OFFSET_MS = 5 * 60 * 1000;

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
  let body;
  try {
    body = await readJsonBody(c, 16 * 1024);
  } catch (error) {
    // 与 music.js 同口径：显式 413 透出，断流等其余读错按空 body → 400
    if (error.exposed === true && error.status === 413) {
      return c.json({ code: 413, message: 'Payload Too Large' }, 413);
    }
    console.warn('[song-meta] 请求体读取失败，按空 body 处理:', error.message);
    body = {};
  }
  const offsetMs = body.offsetMs;
  if (!Number.isSafeInteger(offsetMs) || Math.abs(offsetMs) > MAX_OFFSET_MS) {
    return c.json({ code: 400, message: 'offsetMs 须为 ±300000 内的整数' }, 400);
  }
  if (offsetMs === 0) {
    songMetaRepo.deleteOffsetMs(id);
  } else {
    songMetaRepo.upsertOffsetMs(id, offsetMs);
  }
  return c.json({ code: 200, songId: id, offsetMs });
});

module.exports = app;

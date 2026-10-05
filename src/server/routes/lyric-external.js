// 外部滚动词兜底路由：GET /lyric/external?id=<trackId>&title=&artist=&duration=<秒>
// ——网易云无词源/未匹配曲的 YTM→LRCLIB→酷狗级联查询（services/lyric-external）。
// 挂在 /lyric 子路径而非并列 /lyric-external：首段 'lyric' 在 ALLOWED_APIS
// 白名单内，isApiPath 命中即拿到「API 语义」全家桶——authGate 按 API 鉴权
// （裸 /lyric-external 会落入「非 API GET」静态语义，登录部署下白开一条
// 未鉴权外联扇出）、SPA 兜底不喂 HTML。/:apiName 路由只匹配单段路径，
// /lyric/external 两段不冲突。
const { Hono } = require('hono');
const { rateLimit } = require('../lib/rate-limit');
const { fetchExternalLyric } = require('../services/lyric-external');

const app = new Hono();

app.get('/lyric/external', async (c) => {
  // 未鉴权即直连上游扇出——限流防把服务端 IP 刷进上游风控（与 /qq/* 同档）
  if (!rateLimit(c, 'lyric-ext', 30)) {
    return c.json({ code: 429, message: '请求太频繁，稍后再试' }, 429);
  }
  // id：本站轨道 id（yt_/bv_/qq_/数字 id 都收）——yt_ 给 YTM 支路供
  // videoId；其余值只作缓存键成分，形态不收敛（服务层自行抽源私有定位）
  const id = String(c.req.query('id') || '').trim();
  if (id && !/^[\w-]{1,80}$/.test(id)) {
    return c.json({ code: 400, message: '非法 id' }, 400);
  }
  const title = String(c.req.query('title') || '').trim();
  const artist = String(c.req.query('artist') || '').trim();
  if (title.length > 300 || artist.length > 200) {
    return c.json({ code: 400, message: 'title/artist 超长' }, 400);
  }
  const dur = Number(c.req.query('duration'));
  const durationSec = Number.isFinite(dur) && dur > 0 && dur <= 7200 ? dur : null;
  // 无 id 又无检索词 = 无米下锅（yt_ 的 videoId 只从 id 里抽）
  if (!id && !title) {
    return c.json({ code: 400, message: '缺少 id 或 title' }, 400);
  }
  try {
    const res = await fetchExternalLyric({
      songId: id, title, artist, durationSec, signal: c.req.raw.signal,
    });
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    if (!res) return c.json({ code: 404, message: '外部词源均无匹配歌词' }, 404);
    return c.json({ code: 200, ...res });
  } catch (e) {
    // abort 归一双查：错误携带 aborted 标记（服务层 abortErr）或请求自身
    // 已断连都归一成 499——与 routes/lyric-align.js 同口径
    if (e?.aborted || c.req.raw.signal?.aborted) return c.body(null, 499);
    console.error('[lyric-ext] 查询失败:', e?.message || e);
    return c.json({ code: 502, message: '外部歌词源查询失败' }, 502);
  }
});

module.exports = app;

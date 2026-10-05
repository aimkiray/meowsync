const { Hono } = require('hono');
const { matchWithBudget, toMatchedJson } = require('../services/netease-match');
const { rateLimit } = require('../lib/rate-limit');
const { csrfOriginOk } = require('../lib/auth-gate');
const { readJsonBody } = require('../lib/http-body');

const app = new Hono();

// POST /match/retry —— 错配纠正口：客户端拿持久化的 provider 字段重建
// sourceInfo（不回源重取——视频可能已删/慢，纠错不该被上游可用性绑架），
// excludeIds 并入请求级否决集重跑匹配，命中即 upsert 覆写 song_match 行
// （正负缓存都刷——纠正前的错配/负缓存不能挡纠正结果）

// trackId 覆盖 bv_/yt_/qq_ 前缀与数字词源 id（与 SONG_ID_RE 同口径）
const TRACK_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const strList = (v, count, max) => (Array.isArray(v) ? v : [])
  .map(x => str(x, max)).filter(Boolean).slice(0, count);

app.post('/match/retry', async (c) => {
  // 写请求 CSRF 纵深（与 auth.js POST 同口径）+ 通用桶——重跑匹配会扇出
  // 云搜/AI，裸奔可被循环刷成上游风控
  if (!csrfOriginOk(c)) {
    return c.json({ code: 403, message: 'Forbidden' }, 403);
  }
  if (!rateLimit(c, 'match-retry', 12)) {
    return c.json({ code: 429, message: '请求太频繁，稍后再试' }, 429);
  }
  let body = {};
  try {
    body = await readJsonBody(c, 64 * 1024);
  } catch (e) {
    if (e?.exposed === true && e?.status === 413) {
      return c.json({ code: 413, message: 'Payload Too Large' }, 413);
    }
    body = {};
  }
  const trackId = str(body?.trackId, 80);
  if (!TRACK_ID_RE.test(trackId)) {
    return c.json({ code: 400, message: '非法 trackId' }, 400);
  }
  const title = str(body?.title, 500);
  const author = str(body?.author, 300);
  const artists = strList(body?.artists, 10, 200);
  const candidates = [...new Set(strList(body?.candidates, 5, 200))];
  const durationSec = Number.isFinite(body?.durationSec)
    ? Math.min(Math.max(body.durationSec, 0), 86400) : 0;
  // excludeIds 并入 vetoedIds：「不是这首」的纠错信号请求级生效，
  // 与 AI 否决同规则——不持久化否决本身（缓存行会被命中结果覆写）
  const excludeIds = (Array.isArray(body?.excludeIds) ? body.excludeIds : [])
    .filter(x => ['string', 'number'].includes(typeof x))
    .slice(0, 50).map(String);
  // 候选串：调用方给则照用；否则按「艺人 歌名 → 裸歌名」从 provider 字段组
  const queries = candidates.length ? candidates
    : [...new Set([author ? `${author} ${title}` : '', title].filter(Boolean))];
  if (!queries.length) {
    return c.json({ code: 400, message: '缺少匹配材料（title 或 candidates）' }, 400);
  }
  try {
    const { song, query, score } = await matchWithBudget({
      candidates: queries, durationSec, tag: 'match-retry',
      reqSignal: c.req.raw.signal,
      sourceInfo: { title, author, artists, trackId },
      skipCache: true, excludeIds,
    });
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    return c.json({
      code: 200,
      matched: toMatchedJson(song),
      matchedBy: query ?? null,
      score: score ?? null,
    });
  } catch (e) {
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    console.error('[match] retry 失败:', e?.message || e);
    return c.json({ code: 502, message: `重匹配失败: ${e?.message || '未知错误'}` }, 502);
  }
});

module.exports = app;

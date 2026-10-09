const { Hono } = require('hono');
const { matchWithBudget, toMatchedJson } = require('../services/netease-match');
const { rateLimit } = require('../lib/rate-limit');
const { csrfOriginOk } = require('../lib/auth-gate');
const { stripAbsolutePaths } = require('../lib/sanitize');
const { readJsonBody } = require('../lib/http-body');
const { callNeteaseApi } = require('../services/netease-api');
const { aiEnabled, aiModel } = require('../lib/ai');
const songMatchRepo = require('../repositories/songMatch');

const app = new Hono();

// GET /match/state?trackId= —— song_match 绑定态只读取口：客户端拿「这首
// 外部轨当前生效的网易词源绑定」去直接取词，不必付一次带预算的重跑匹配。
// 本端点只读不写——与 POST /match/retry（skipCache 重跑+覆写）职责分离：
// 读口零云搜/AI 上行（至多一跳 song_detail 回水化），改绑定只能走 retry。
// GET 只读不挂 csrfOriginOk 纵深（与全站 GET 同口径）。回包键名读口
// `match`（绑定态投影，matchedBy/score 内嵌其中）与写口 `matched`
// （重跑命中，matchedBy/score 同级平铺）刻意不对称——键位即职责记号
//
// POST /match/retry —— 错配纠正口：客户端拿持久化的 provider 字段重建
// sourceInfo（不回源重取——视频可能已删/慢，纠错不该被上游可用性绑架），
// excludeIds 先落账进持久否决簿（vetoed_json，跨会话不再复活）再并入
// 本次运行否决集重跑匹配，命中即 upsert 覆写 song_match 行
// （正负缓存都刷——纠正前的错配/负缓存不能挡纠正结果）

// trackId 形闸：本文件局部口径（非共享谓词，也不指 songmeta.js 的
// SONG_ID_RE——那边 {1,64} 是别界）——bv_/yt_/qq_ 前缀与数字词源 id
// 都落在 [A-Za-z0-9_-] 字符集内；{1,80} 上界与下方 str() 截断同长
const TRACK_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const strList = (v, count, max) => (Array.isArray(v) ? v : [])
  .map(x => str(x, max)).filter(Boolean).slice(0, count);

app.get('/match/state', async (c) => {
  // 只读也要限流：客户端每轨首播都会问，裸奔可被批量轨道 id 刷成
  // song_detail 扇出（与 match-retry 同思路，桶宽松一档——这是热路径）
  if (!rateLimit(c, 'match-state', 60)) {
    return c.json({ code: 429, message: '请求太频繁，稍后再试' }, 429);
  }
  const trackId = str(c.req.query('trackId'), 80);
  if (!TRACK_ID_RE.test(trackId)) {
    return c.json({ code: 400, message: '非法 trackId' }, 400);
  }
  // 读侧模型键与写侧 cachedMatch 同口径（AI 此刻不可用等价纯启发式 ''）——
  // 回的就是「匹配管线现在会认的那行」：跨模型的 AI 判定行、异模负行
  // 读出来都是谎言（管线根本不会采纳它），按未命中回 match:null
  const model = aiEnabled() ? (aiModel() || '') : '';
  const row = songMatchRepo.getMatch(trackId, model);
  if (!row || row.netease_id == null) {
    return c.json({ code: 200, match: null });
  }
  // 被否正行不下发——本地解绑后靠本端点水合复活的通路要堵（模型键与
  // 读侧同口径）：客户端拿 match:null 走解绑终态而不是复活错配
  if (songMatchRepo.getVetoedIds(trackId, model).has(String(row.netease_id))) {
    return c.json({ code: 200, match: null });
  }
  // 正行只存 netease_id——song_detail 单跳回水化出 matched 投影（与
  // cachedMatch 同款）；回水化失败退裸 id 壳，客户端只补 neteaseId 也能用
  const rawId = String(row.netease_id);
  let song = { id: /^\d+$/.test(rawId) ? Number(rawId) : rawId };
  try {
    const res = await callNeteaseApi('song_detail', { ids: rawId }, { signal: c.req.raw.signal });
    const s = res.body?.songs?.[0];
    if (s && typeof s === 'object') song = s;
  } catch { /* 回水化失败——裸 id 壳仍保住词源 */ }
  if (c.req.raw.signal?.aborted) return c.body(null, 499);
  return c.json({
    code: 200,
    match: { ...toMatchedJson(song), matchedBy: row.matched_by || null, score: row.score ?? null },
  });
});

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
  const excludeIds = (Array.isArray(body?.excludeIds) ? body.excludeIds : [])
    .filter(x => ['string', 'number'].includes(typeof x))
    .slice(0, 50).map(String);
  // 候选串：调用方给则照用；否则按「艺人 歌名 → 裸歌名」从 provider 字段组
  const queries = candidates.length ? candidates
    : [...new Set([author ? `${author} ${title}` : '', title].filter(Boolean))];
  if (!queries.length) {
    return c.json({ code: 400, message: '缺少匹配材料（title 或 candidates）' }, 400);
  }
  // excludeIds 并入 vetoedIds：「不是这首」的纠错信号与 AI 否决同规则。
  // 且先于匹配运行落账进持久否决簿——请求 abort/预算耗尽也把否决留下
  // （堵「传输失败不落负行→被否 id 下会话复活」的残面）；落账失败
  // fail-soft 不挡 retry——否决账是增强不是门禁。
  // 落账点在材料 400 校验之后：注定被拒的请求不该污染否决簿
  try {
    songMatchRepo.mergeVetoed(trackId, excludeIds,
      aiEnabled() ? (aiModel() || '') : '');
  } catch (e) {
    console.warn('[match] veto 落账失败:', e?.message || e);
  }
  try {
    const { song, query, score } = await matchWithBudget({
      candidates: queries, durationSec, tag: 'match-retry',
      reqSignal: c.req.raw.signal,
      sourceInfo: { title, author, artists, trackId },
      skipCache: true, excludeIds,
      // 单曲重匹配是用户显式触发——客户端 axios 超时 60s（src/api/music.js
      // retryMatch），服务端预算取 55s 留 5s 头：覆盖「≤8 串云搜（~0.5s/串）
      // + AI_CALL_BUDGET 内数发慢模型调用（实测 ~16s/发、单发上限走
      // AI_TIMEOUT_MS 默认 30s；askAiJson 对不兼容 response_format 的
      // 后端会裸重试一发，单发最坏 ~2× 该值——见 lib/ai.js:116-127）」
      // 的典型路径；matchWithBudget 默认 25s 会在 AI 复核中途把整链
      // abort 成空结果。最坏情形（数发 × ~2×30s 串行）预算照样先到点——
      // 耗尽按无匹配回落，不超客户端时限。
      // 其它 matchWithBudget 调用方（yt/bv/qq resolve 单曲路径）刻意不跟进：
      // 解析链要快，AI 是增强不是门禁，25s 预算耗尽按无匹配回落即可
      budgetMs: 55000,
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
    // 裸异常消息直回会泄部署面信息（绝对路径里的用户名/目录布局）——
    // 过 stripAbsolutePaths 再下发（console.error 记原文不受影响）
    return c.json({ code: 502, message: `重匹配失败: ${stripAbsolutePaths(e?.message || '未知错误')}` }, 502);
  }
});

module.exports = app;

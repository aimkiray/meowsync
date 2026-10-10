const { Hono } = require('hono');
const { fail } = require('../lib/http-error');
const { tokenMatches } = require('../lib/token-eq');
const { stripAbsolutePaths } = require('../lib/sanitize');
const { rateLimit } = require('../lib/rate-limit');
const { createTtlCache } = require('../lib/stream-resolve-cache');
const streamVault = require('../lib/stream-vault');
// 外发 Location 必须拼回部署前缀——entryFetch 剥前缀后路由按根路径工作，
// 裸 /audio-proxy/t/… 在 BASE_PATH 子目录部署下回客户端即 404
const { withBasePath } = require('../lib/base-path');
const { matchWithBudget, toMatchedJson } = require('../services/netease-match');
const {
  hasQqCookie, PLAY_LADDER, BEST_LADDER, SONGMID_RE,
  getSongDetail, pickStreamUrl, getLyric, getPlaylist, searchSongs,
  resolveQqInput,
} = require('../lib/qq');

const app = new Hono();

// QQ 音源：qq_<songmid> 外部源形态（与 bv_/yt_ 同构），差异是 QQ 自带真实元
// 数据与权威双语歌词——网易云匹配只做封面/歌词源兜底而非主要元数据来源。
// 法务面：腾讯对第三方抓取有明确律师函史（lx-music/MusicFree）——本路由是
// 自托管个人工具实现，QQ_COOKIE 由部署者自带（强烈建议小号，勿用主力号）

// 曲目归一 → 前端歌单元件（buildQQSong 与下载器共用口径）
const trackJson = (t) => ({
  mid: t.mid,
  songId: t.songId,
  name: t.name,
  artists: t.artists,
  album: t.album,
  albummid: t.albummid,
  duration: t.intervalSec,
  cover: t.cover,
  mediaMid: t.mediaMid,
  payPlay: t.payPlay,
  vipOnly: t.vipOnly,
});

// vkey 档梯挑选：与 file-downloader 共用 lib/qq.js 的 pickStreamUrl
// （midurlinfo 逐档 purl 为空即无权限；sip 逐条过 normalizeOutboundUrl+
// QQ_STREAM_HOST_OK——sip 可能回裸 IP 条目，后缀判定天然拒绝自动降级）。
// 短 TTL 正缓存叠在 lib 的 pickStreamInflight 单飞之上：inflight 只挡
// 并发重复，正缓存挡「下一次播放重取」——vkey ~22h 寿命，10min 复用把
// 客户端冷跳/重复 open 的 vkey 回源打成一次内存读。命中先于 inflight：
// 有成品直接出，不进共享链。prefer 用令牌门之后的终值——best（VIP/
// 无损档）与常规档产不同字节实体，绝不共键（bilibili 令牌门同口径）
const qqResolveCache = createTtlCache({ max: 256, ttlMs: 10 * 60_000 });
const pickStream = (mid, mediaMid, prefer, extraSignal) => {
  const cacheKey = `${mid}|${mediaMid}|${prefer || ''}`;
  const hit = qqResolveCache.get(cacheKey);
  if (hit) return hit;
  return pickStreamUrl(mid, {
    mediaMid, signal: extraSignal,
    ladder: prefer === 'best' ? BEST_LADDER : PLAY_LADDER,
  }).then((h) => {
    // 只缓存非空 hit——null（无权限/地域限制）不写，负结果不固化；
    // 等待方 abort 穿透（pickStreamUrl 抛 'aborted'）同样不写，
    // 与共享链「产物归未断连的搭车者」同口径
    if (h) qqResolveCache.set(cacheKey, h);
    return h;
  });
};

// 凭据状态透出（MA provider status 同款只读事实）：前端据此调整 VIP 曲的
// 可播性判定——配了 VIP cookie 的部署里 payPlay 曲实际可播。只回布尔
// 枚举不回任何凭据本体
app.get('/qq/status', (c) => c.json({ code: 200, loggedIn: hasQqCookie() }));

app.get('/qq/resolve', async (c) => {
  if (!rateLimit(c, 'qq-resolve', 12)) {
    return c.json({ code: 429, message: '请求太频繁，稍后再试' }, 429);
  }
  const parsed = await resolveQqInput(c.req.query('input') || '', c.req.raw.signal);
  if (c.req.raw.signal?.aborted) return c.body(null, 499);
  if (!parsed?.mid && !parsed?.songid) {
    // disstid 带字段下发——前端收到后自动转歌单导入（编码 p= 形态前端谓词看不穿，
    // 只能由服务端跳解兜底；裸提示会让已粘顶栏的用户陷入死循环指引）
    if (parsed?.disstid) return fail(c, 400, '这是 QQ 歌单链接，正在为你导入歌单', { disstid: parsed.disstid });
    if (parsed?.albummid) return c.json({ code: 400, message: '这是专辑链接，暂不支持（可用单曲/歌单链接）' }, 400);
    return c.json({ code: 400, message: '无法从输入解析 QQ 音乐歌曲（支持 songDetail/分享链接/songmid/songid）' }, 400);
  }
  try {
    const t = await getSongDetail(parsed.mid || parsed.songid, c.req.raw.signal,
      parsed.mid ? 'mid' : 'songid');
    // QQ 自带真实元数据——网易云匹配只当封面/歌词兜底源：候选串从精准到宽
    const candidates = [...new Set([
      `${t.artists.join(' ')} ${t.name}`.trim(), t.name,
    ].filter(Boolean))].slice(0, 3);
    // 匹配预算收敛进 services/netease-match.js:matchWithBudget
    const { song: matched, query: matchedBy, score: matchScore } = await matchWithBudget({
      candidates, durationSec: t.intervalSec, tag: 'qq',
      reqSignal: c.req.raw.signal,
      // QQ 自带真实元数据——artists 数组直接喂打分器（比 join 的作者串更准）；
      // trackId 与客户端 buildQQSong 的 id 同构（qq_<mid>）接 song_match 缓存键
      sourceInfo: {
        title: t.name, author: t.artists.join(' '),
        artists: t.artists, trackId: `qq_${t.mid}`,
      },
    });
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    return c.json({
      code: 200,
      ...trackJson(t),
      matched: toMatchedJson(matched),
      matchedBy,
      matchScore: matchScore ?? null,
    });
  } catch (e) {
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    console.error('[qq] resolve 失败:', e.message);
    return c.json({ code: 502, message: `QQ 音乐解析失败: ${stripAbsolutePaths(e?.message || '未知错误')}` }, 502);
  }
});

// 播放流地址：vkey 与 (guid,uin,请求方IP) 绑定且 ~22h 过期——每次播放重取，
// 302 进 audio-proxy 由代理回源（白名单 stream.qqmusic.qq.com 系已放行）
app.get('/qq/stream', async (c) => {
  if (!rateLimit(c, 'qq-stream', 60)) {
    return c.json({ code: 429, message: '请求太频繁，稍后再试' }, 429);
  }
  const mid = c.req.query('mid') || '';
  if (!SONGMID_RE.test(mid)) {
    return c.json({ code: 400, message: 'invalid songmid' }, 400);
  }
  const mmid = SONGMID_RE.test(c.req.query('mmid') || '') ? c.req.query('mmid') : '';
  // prefer=best 消耗登录态 VIP/无损档——与 bilibili 同款令牌门：配了
  // QQ_COOKIE+DOWNLOAD_TOKEN 时要求 x-download-token，匿名请求静默回落常规档。
  // 已登录会话（c.get('user')，authGate 验过）与令牌等效——启用登录的部署
  // 里浏览器不带 x-download-token，否则会话用户被静默降档
  const wantBest = c.req.query('prefer') === 'best';
  const token = process.env.DOWNLOAD_TOKEN || '';
  const prefer = wantBest && (!hasQqCookie() || !token || c.get('user')
    || tokenMatches(c.req.header('x-download-token'), token)) ? 'best' : '';
  try {
    const hit = await pickStream(mid, mmid, prefer, c.req.raw.signal);
    if (!hit) {
      return c.json({ code: 404, message: '该歌曲没有可用的播放流（可能需要 VIP 权限或存在地域限制）' }, 404);
    }
    // 经 vault 换 opaque token——purl 明文带 uin/vkey/guid，不进 Location/前端可见面
    return c.redirect(withBasePath(`/audio-proxy/t/${streamVault.mint(hit.url)}`), 302);
  } catch (e) {
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    console.error('[qq] stream 失败:', e.message);
    return c.json({ code: 502, message: `QQ 音乐流地址获取失败: ${stripAbsolutePaths(e?.message || '未知错误')}` }, 502);
  }
});

// QQ 自带权威歌词（base64 LRC + 翻译）——qq_ 曲无需走网易云词源嫁接
app.get('/qq/lyric', async (c) => {
  if (!rateLimit(c, 'qq-lyric', 30)) {
    return c.json({ code: 429, message: '请求太频繁，稍后再试' }, 429);
  }
  const mid = c.req.query('mid') || '';
  if (!SONGMID_RE.test(mid)) return c.json({ code: 400, message: 'invalid songmid' }, 400);
  try {
    const { lyric, trans } = await getLyric(mid, c.req.raw.signal);
    return c.json({ code: 200, lyric, trans });
  } catch (e) {
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    console.error('[qq] lyric 失败:', e.message);
    return c.json({ code: 502, message: `QQ 歌词获取失败: ${stripAbsolutePaths(e?.message || '未知错误')}` }, 502);
  }
});

// 曲库搜索——点歌台 qq: 前缀搜索用
app.get('/qq/search', async (c) => {
  if (!rateLimit(c, 'qq-search', 20)) {
    return c.json({ code: 429, message: '请求太频繁，稍后再试' }, 429);
  }
  const q = (c.req.query('q') || '').trim();
  if (!q || q.length > 100) return c.json({ code: 400, message: 'invalid query' }, 400);
  try {
    const list = await searchSongs(q, 20, c.req.raw.signal);
    return c.json({ code: 200, list: list.map(trackJson) });
  } catch (e) {
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    console.error('[qq] search 失败:', e.message);
    return c.json({ code: 502, message: `QQ 音乐搜索失败: ${stripAbsolutePaths(e?.message || '未知错误')}` }, 502);
  }
});

// 歌单导入：disstid → 归一歌单元件（前端落成 local_pl_ 本地歌单——
// 与手动创建歌单同等待遇：mix 分享/服务端镜像下载全链复用）
app.get('/qq/playlist', async (c) => {
  if (!rateLimit(c, 'qq-playlist', 12)) {
    return c.json({ code: 429, message: '请求太频繁，稍后再试' }, 429);
  }
  const id = c.req.query('id') || '';
  if (!/^\d{1,15}$/.test(id)) return c.json({ code: 400, message: 'invalid disstid' }, 400);
  try {
    const pl = await getPlaylist(id, c.req.raw.signal);
    if (!pl) return c.json({ code: 404, message: '歌单不存在或无权限' }, 404);
    return c.json({
      code: 200,
      ...pl,
      tracks: pl.tracks.map(trackJson),
      // 与 bili/yt 歌单同型契约——超上限截断必须透出，不然前端按完整列表渲染
      truncated: pl.truncated === true,
    });
  } catch (e) {
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    console.error('[qq] playlist 失败:', e.message);
    return c.json({ code: 502, message: `QQ 歌单获取失败: ${stripAbsolutePaths(e?.message || '未知错误')}` }, 502);
  }
});

module.exports = app;

const { Hono } = require('hono');
const { normalizeOutboundUrl } = require('../lib/net-guard');
const { isAllowedHost } = require('./proxy');
const { rateLimit } = require('../lib/rate-limit');
const { matchNeteaseSong } = require('../lib/netease-match');
const {
  QQ_COOKIE, PLAY_LADDER, BEST_LADDER, SONGMID_RE,
  getSongDetail, getStreamCandidates, getLyric, getPlaylist, searchSongs,
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

// vkey 档梯挑选：midurlinfo 逐档 purl 为空即无权限，跳过；
// sip 逐条过代理校验（normalizeOutboundUrl+host 白名单——sip 可能回裸 IP
// 条目，isAllowedHost 对 IP 字面量天然拒绝，自动降到下一条域名 sip）
async function pickStream(mid, mediaMid, prefer, extraSignal) {
  const tryLadder = async (mm) => {
    const cands = await getStreamCandidates(mid, mm, prefer === 'best' ? BEST_LADDER : PLAY_LADDER, extraSignal);
    for (const cand of cands) {
      const usable = cand.urls.find(u => {
        const checked = normalizeOutboundUrl(u);
        return checked.ok && isAllowedHost(checked.url.hostname);
      });
      if (usable) return { url: usable, tier: cand.tier };
    }
    return null;
  };
  let hit = await tryLadder(mediaMid);
  if (!hit && !mediaMid) {
    // filename 需 media_mid——多数歌 media_mid==songmid，不等时拿详情回填重试
    const detail = await getSongDetail(mid, extraSignal);
    if (detail?.mediaMid && detail.mediaMid !== mid) hit = await tryLadder(detail.mediaMid);
  }
  return hit;
}

app.get('/qq/resolve', async (c) => {
  if (!rateLimit(c, 'qq-resolve', 12)) {
    return c.json({ code: 429, message: '请求太频繁，稍后再试' }, 429);
  }
  const parsed = await resolveQqInput(c.req.query('input') || '', c.req.raw.signal);
  if (!parsed?.mid && !parsed?.songid) {
    if (parsed?.disstid) return c.json({ code: 400, message: '这是 QQ 歌单链接，请在顶部搜索框粘贴导入' }, 400);
    return c.json({ code: 400, message: '无法从输入解析 QQ 音乐歌曲（支持 songDetail/分享链接/songmid/songid）' }, 400);
  }
  try {
    const t = await getSongDetail(parsed.mid || parsed.songid, c.req.raw.signal);
    // QQ 自带真实元数据——网易云匹配只当封面/歌词兜底源：候选串从精准到宽
    const candidates = [...new Set([
      `${t.artists.join(' ')} ${t.name}`.trim(), t.name,
    ].filter(Boolean))].slice(0, 3);
    let budgetTimer;
    const budgetCtrl = new AbortController();
    const matchBudget = new Promise(resolve => {
      budgetTimer = setTimeout(() => {
        budgetCtrl.abort();
        resolve({ song: null, query: null });
      }, 25000);
      budgetTimer.unref?.();
    });
    const { song: matched, query: matchedBy } = await Promise.race([
      matchNeteaseSong(candidates, t.intervalSec, 'qq',
        AbortSignal.any([c.req.raw.signal, budgetCtrl.signal]),
        { title: t.name, author: t.artists.join(' ') }),
      matchBudget,
    ]);
    clearTimeout(budgetTimer);
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    return c.json({
      code: 200,
      ...trackJson(t),
      matched: matched ? {
        id: matched.id,
        name: matched.name,
        ar: matched.ar || matched.artists || [],
        al: matched.al || matched.album || {},
      } : null,
      matchedBy,
    });
  } catch (e) {
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    console.error('[qq] resolve 失败:', e.message);
    return c.json({ code: 502, message: `QQ 音乐解析失败: ${e.message}` }, 502);
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
  // QQ_COOKIE+DOWNLOAD_TOKEN 时要求 x-download-token，匿名请求静默回落常规档
  const wantBest = c.req.query('prefer') === 'best';
  const token = process.env.DOWNLOAD_TOKEN || '';
  const prefer = wantBest && (!QQ_COOKIE || !token
    || c.req.header('x-download-token') === token) ? 'best' : '';
  try {
    const hit = await pickStream(mid, mmid, prefer, c.req.raw.signal);
    if (!hit) {
      return c.json({ code: 404, message: '该歌曲没有可用的播放流（可能需要 VIP 权限或存在地域限制）' }, 404);
    }
    return c.redirect(`/audio-proxy?url=${encodeURIComponent(hit.url)}`, 302);
  } catch (e) {
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    console.error('[qq] stream 失败:', e.message);
    return c.json({ code: 502, message: `QQ 音乐流地址获取失败: ${e.message}` }, 502);
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
    return c.json({ code: 502, message: `QQ 歌词获取失败: ${e.message}` }, 502);
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
    return c.json({ code: 502, message: `QQ 音乐搜索失败: ${e.message}` }, 502);
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
    });
  } catch (e) {
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    console.error('[qq] playlist 失败:', e.message);
    return c.json({ code: 502, message: `QQ 歌单获取失败: ${e.message}` }, 502);
  }
});

module.exports = app;

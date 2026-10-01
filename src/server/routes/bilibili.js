const { Hono } = require('hono');
const { normalizeOutboundUrl, isProxyAllowedHost: isAllowedHost } = require('../lib/net-guard');
const streamVault = require('../lib/stream-vault');
const { rateLimit } = require('../lib/rate-limit');
const { matchNeteaseSong } = require('../services/netease-match');
const { tokenMatches } = require('../lib/token-eq');
const { BVID_RE } = require('../../shared/predicates.js');
// 上游交互原语（cookie 头/biliFetch/选流/分P/bvid 解析）在 lib/bilibili.js——
// file-downloader 的 bv_* 分发共用同一实现，不维护两份客户端
const { biliFetch, pickStreamList, pickStreams, pickPageParam, pickCidFromView, viewQuery, parseBvid, BILI_COOKIE } = require('../lib/bilibili');

const app = new Hono();

// 歌名提取：标签优先——B 站音乐识别标签形如「发现《歌名》」/「发现歌名」；
// 其次《歌名》式样标签；最后落到清洗后的标题（去【UP主】前缀、- 后缀、常见修饰词）
function extractSongName(tagNames, title) {
  for (const t of tagNames) {
    const m = String(t).match(/发现《?(.+?)》?$/);
    if (m) return m[1].trim();
  }
  for (const t of tagNames) {
    const m = String(t).match(/^《(.+)》$/);
    if (m) return m[1].trim();
  }
  let t = String(title || '')
    .replace(/【[^】]*】/g, ' ')            // 【UP主】【翻唱】等角标前缀
    .replace(/（[^（）]*(?:翻唱|cover|翻弹|演奏)[^（）]*）/gi, ' ')
    .replace(/\([^()]*(?:翻唱|cover|翻弹|演奏)[^()]*\)/gi, ' ')
    .replace(/[-—–_|~～].*$/u, '')          // 首个分隔符后的修饰尾巴
    .replace(/《|》/g, ' ')
    .trim();
  return t || String(title || '').trim();
}

// 限流/匹配实现：src/server/lib/rate-limit.js + src/server/services/netease-match.js——
// 与 youtube.js 共用同一桶表与同一 sanity 判据，防两处漂移

app.get('/bilibili/resolve', async (c) => {
  if (!rateLimit(c, 'resolve', 12)) {
    return c.json({ code: 429, message: '解析太频繁，稍后再试' }, 429);
  }
  const input = c.req.query('input') || c.req.query('bvid');
  const id = await parseBvid(input, c.req.raw.signal);
  if (!id) return c.json({ code: 400, message: '无法从输入解析 BV/av 号' }, 400);
  try {
    const view = await biliFetch(`/x/web-interface/view?${viewQuery(id)}`, c.req.raw.signal);
    // 分P定位：?p=N 时取 pages[N-1] 的 cid/时长/分P名——不然导 P2 会静默播 P1
    const pages = Array.isArray(view.pages) ? view.pages : [];
    const pageIdx = Math.min(pickPageParam(input), Math.max(pages.length, 1)) - 1;
    const page = pages[pageIdx] || null;
    const cid = page?.cid ?? view.cid;
    const duration = page?.duration ?? view.duration;
    const [tagRes, playurl] = await Promise.all([
      biliFetch(`/x/tag/archive/tags?bvid=${view.bvid}`, c.req.raw.signal).catch(() => []),
      biliFetch(`/x/player/playurl?bvid=${view.bvid}&cid=${cid}&fnval=4048&fourk=1`, c.req.raw.signal),
    ]);
    const tagNames = Array.isArray(tagRes) ? tagRes.map(t => t.tag_name).filter(Boolean) : [];
    const songName = extractSongName(tagNames, view.title);
    // 候选搜索串：提取名 → 分P名（多分P合集里 page.part 常是精准歌名，主标题反是噪声）
    // → 清洗标题。原标题纯噪声不入列；整条匹配链设预算，超了当无匹配不阻塞解析
    const cleanTitle = extractSongName([], view.title);
    // 先 trim 再去重——page.part 带空白会带脏串进云搜（与 youtube.js 同口径）
    const candidates = [...new Set([songName, page?.part, cleanTitle]
      .map(c => (c || '').trim()).filter(Boolean))].slice(0, 3);
    let budgetTimer;
    const budgetCtrl = new AbortController();
    const matchBudget = new Promise(resolve => {
      // 预算耗尽不只让 race 判负——abort 停掉在途的云搜/AI 复核，
      // 否则孤儿流程继续烧上游请求与 AI 额度
      budgetTimer = setTimeout(() => {
        budgetCtrl.abort();
        resolve({ song: null, query: null });
      }, 25000);
      budgetTimer.unref?.();
    });
    const { song: matched, query: matchedBy } = await Promise.race([
      matchNeteaseSong(candidates, duration, 'bilibili',
        AbortSignal.any([c.req.raw.signal, budgetCtrl.signal]),
        { title: view.title || '', author: view.owner?.name || '' }),
      matchBudget,
    ]);
    clearTimeout(budgetTimer);
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    const { audio, video } = pickStreams(playurl);
    // hasVideo 只给「浏览器解得动的 avc1」——hevc/av01 流存在也不能宣称可视频
    const avcStreams = (playurl?.dash?.video || []).filter(v => (v.codecs || '').startsWith('avc1'));
    // 无损/杜比轨可用性回给前端展示（下载 prefer=best 会实际命中）
    const dashAudio = playurl?.dash || {};
    const hasHiRes = [].concat(dashAudio.flac?.audio || [])
      .some(f => f && (f.baseUrl || f.base_url));
    const hasDolby = (dashAudio.dolby?.type || 0) > 0
      && (Array.isArray(dashAudio.dolby?.audio) ? dashAudio.dolby.audio.length > 0 : !!dashAudio.dolby?.audio);
    return c.json({
      code: 200,
      bvid: view.bvid,
      aid: view.aid,
      cid,
      title: view.title,
      pagePart: page?.part || null,
      page: pageIdx + 1,
      cover: view.pic,
      duration,
      owner: view.owner?.name || '',
      songName,
      tags: tagNames,
      matched: matched ? {
        id: matched.id,
        name: matched.name,
        ar: matched.ar || matched.artists || [],
        al: matched.al || matched.album || {},
      } : null,
      matchedBy,
      hasVideo: avcStreams.length > 0,
      hasHiRes,
      hasDolby,
      audioQuality: audio ? { id: audio.id, bandwidth: audio.bandwidth } : null,
      videoQuality: video ? { id: video.id, width: video.width, height: video.height } : null,
    });
  } catch (e) {
    // 客户端已断连：静默 499，不写错误日志（正常断连不算服务端错误）
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    console.error('[bilibili] resolve 失败:', e.message);
    return c.json({ code: 502, message: `B 站解析失败: ${e.message}` }, 502);
  }
});

// 播放流地址：每次重解 playurl（CDN 签名 ~2h 过期），302 到 audio-proxy
// 走统一代理（Referer 注入 + Range 透传 + SSRF 校验），不在此直接透流
app.get('/bilibili/stream', async (c) => {
  // 同样未鉴权且每次最多 3 次 B 站扇出——限流放宽些（每次播放触发一次，
  // 音频+视频分开计），只挡异常刷量
  if (!rateLimit(c, 'stream', 60)) {
    return c.json({ code: 429, message: '请求太频繁，稍后再试' }, 429);
  }
  const bvid = c.req.query('bvid');
  const kind = c.req.query('kind') === 'video' ? 'video' : 'audio';
  if (!BVID_RE.test(String(bvid || ''))) {
    return c.json({ code: 400, message: 'invalid bvid' }, 400);
  }
  try {
    const pageWanted = pickPageParam(`?p=${c.req.query('p') || 1}`);
    let cid = c.req.query('cid');
    if (!cid || !/^\d+$/.test(cid)) {
      const view = await biliFetch(`/x/web-interface/view?bvid=${bvid}`, c.req.raw.signal);
      cid = pickCidFromView(view, pageWanted);
    }
    let playurl;
    try {
      playurl = await biliFetch(`/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=4048&fourk=1`, c.req.raw.signal);
    } catch (e) {
      // cid 过期自愈：稿件被 UP 主换源/调 P 后库存 cid 失效——按 p 重查对应分P
      // 的 cid（不能回落 view.cid——那是 P1，会把分P导入的曲静默拉回第一P）。
      // 仅对「调用方传了合法数字 cid」自愈——刚查来的 cid 失败重试无意义
      if (!/^\d+$/.test(c.req.query('cid') || '')) throw e;
      const view = await biliFetch(`/x/web-interface/view?bvid=${bvid}`, c.req.raw.signal);
      playurl = await biliFetch(`/x/player/playurl?bvid=${bvid}&cid=${pickCidFromView(view, pageWanted)}&fnval=4048&fourk=1`, c.req.raw.signal);
    }
    // 候选 CDN 回链按质量降序逐档铺开：mcdn 等边缘节点会带非标端口（:4483），
    // audio-proxy 端口策略会拒——用同一校验器预筛，拿第一个能过代理的地址
    // prefer=best 消耗的是运营者大会员轨——配了 DOWNLOAD_TOKEN 的部署里
    // 要求带令牌才放行，匿名访客按常规档处理（不报错，静默回落）。
    // 已登录会话与令牌等效（c.get('user') 由 authGate 验过）
    const wantBest = c.req.query('prefer') === 'best';
    const token = process.env.DOWNLOAD_TOKEN || '';
    const prefer = wantBest && (!BILI_COOKIE || !token || c.get('user')
      || tokenMatches(c.req.header('x-download-token'), token)) ? 'best' : '';
    const streams = pickStreamList(playurl, kind, prefer);
    // hasVideo 语义 = 「存在浏览器解得动的 avc1」——kind=video 下若整档只有
    // hevc/av01，302 过去也是黑屏，按无流 404（与 resolve 的 hasVideo 口径一致）
    if (kind === 'video' && !streams.some(s => (s.codecs || '').startsWith('avc1'))) {
      return c.json({ code: 404, message: 'no playable (avc1) video stream' }, 404);
    }
    const candidates = streams.flatMap(s => {
      const backups = Array.isArray(s?.backupUrl) ? s.backupUrl
        : (Array.isArray(s?.backup_url) ? s.backup_url : []);
      return [s?.baseUrl, s?.base_url, ...backups];
    }).filter(u => typeof u === 'string' && u);
    // 与 audio-proxy 放行业务对齐：归一化 + host 白名单（DNS/端口已由
    // normalizeOutboundUrl 覆盖端口面，建连 IP 钉扎在代理层再查一次）
    const usable = candidates.find(u => {
      const checked = normalizeOutboundUrl(u);
      return checked.ok && isAllowedHost(checked.url.hostname);
    });
    if (!usable) {
      return c.json({ code: 404, message: `该视频没有可代理的${kind === 'video' ? '视频' : '音频'}流` }, 404);
    }
    // vault token 化——登录态 baseUrl 带 mid/uipk/deadline，不出进程
    return c.redirect(`/audio-proxy/t/${streamVault.mint(usable)}`, 302);
  } catch (e) {
    // 客户端断连不算服务端错误（与 resolve/audio-proxy 同口径）
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    console.error('[bilibili] stream 失败:', e.message);
    return c.json({ code: 502, message: `B 站流地址获取失败: ${e.message}` }, 502);
  }
});

module.exports = app;

const { Hono } = require('hono');
const { normalizeOutboundUrl, isProxyAllowedHost: isAllowedHost } = require('../lib/net-guard');
const streamVault = require('../lib/stream-vault');
const { rateLimit } = require('../lib/rate-limit');
const { matchNeteaseSong } = require('../services/netease-match');
const { tokenMatches } = require('../lib/token-eq');
const { BVID_RE } = require('../../shared/predicates.js');
// 上游交互原语（cookie 头/biliFetch/选流/分P/bvid 解析）在 lib/bilibili.js——
// file-downloader 的 bv_* 分发共用同一实现，不维护两份客户端
const { biliFetch, pickStreamList, pickStreams, pickPageParam, pickCidFromView, viewQuery, parseBvid, resolveBiliLink, BILI_COOKIE, QN_HEIGHT } = require('../lib/bilibili');

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
    .replace(/[-—–_|~～┃│｜▏].*$/u, '')     // 首个分隔符后的修饰尾巴（含韩翻 ┃）
    .replace(/《|》/g, ' ')                 // 《》先化空格——「Title《COVER》」要让 COVER 露出成尾巴
    .replace(/\s+(?:cover(?:\s+by\s+.+)?|커버|翻唱|翻弹|演奏)\s*$/i, '') // 尾巴裸标记
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
  // 收藏夹链（含 b23 跳解出来的 medialist/favlist 落地页）走歌单导入——
  // favlist 字段带下去前端自动转 /bilibili/favlist，与 disstid 同口径
  const link = await resolveBiliLink(input, c.req.raw.signal);
  if (link?.kind === 'favlist') {
    return c.json({ code: 400, message: '这是 B 站收藏夹链接，正在为你导入歌单', favlist: link.fid }, 400);
  }
  const id = link?.kind === 'video' ? link.id : null;
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

// 收藏夹导入：favlist?fid=/medialist/mlN/b23 短链 → 归一曲目列表。
// x/v3/fav/resource/list 公开夹匿名可读（私有/隐藏夹上游拒——确定性错误）；
// ps 上限 20 逐页拉全，截断到 FAV_MAX_ITEMS。词源匹配是预算制并发池：
// 收藏夹动辄上百条，串行匹配不可行——预算耗尽剩余曲目 matched=null
// 照常可播可下（词源缺失按 NO_LYRICS 已降级，非任务失败）
const FAV_PAGE_SIZE = 20;
const FAV_MAX_ITEMS = 200;
const FAV_MATCH_BUDGET_MS = 45000;
const FAV_MATCH_CONCURRENCY = 3;

app.get('/bilibili/favlist', async (c) => {
  if (!rateLimit(c, 'favlist', 6)) {
    return c.json({ code: 429, message: '导入太频繁，稍后再试' }, 429);
  }
  const signal = c.req.raw.signal;
  const raw = c.req.query('input') || c.req.query('fid') || '';
  const link = await resolveBiliLink(raw, signal);
  // resolveBiliLink 不识别的裸数字按 fid 兜底（直达 API 用）——顶栏裸数字
  // 走网易云歌单，到不了这里
  const fid = link?.kind === 'favlist' ? link.fid
    : (/^\d{1,15}$/.test(raw.trim()) ? raw.trim() : null);
  if (!fid) return c.json({ code: 400, message: '无法从输入解析收藏夹（支持 space favlist?fid=/medialist/mlN 链接）' }, 400);
  try {
    let info = null;
    let skipped = 0;
    const tracks = [];
    for (let pn = 1; pn <= Math.ceil(FAV_MAX_ITEMS / FAV_PAGE_SIZE); pn++) {
      if (signal?.aborted) return c.body(null, 499);
      const data = await biliFetch(
        `/x/v3/fav/resource/list?media_id=${fid}&ps=${FAV_PAGE_SIZE}&pn=${pn}&platform=web`, signal);
      info = info || data?.info || null;
      const medias = Array.isArray(data?.medias) ? data.medias : [];
      if (!medias.length) break;
      for (const m of medias) {
        if (tracks.length >= FAV_MAX_ITEMS) break;
        // 非视频条目/已失效（无 bvid 或标题哨兵）跳过——计数透出给前端
        if (m?.type !== 2 || !m.bvid || m.title === '已失效视频') { skipped++; continue; }
        tracks.push({
          bvid: m.bvid,
          cid: null,                    // cid 由播放/下载链自愈（view 兜底）
          page: 1,                      // 收藏夹条目对整稿——多分P取P1与单曲导入同口径
          pageCount: m.page || 1,
          title: m.title || '',
          cover: m.cover || '',
          duration: m.duration || 0,
          owner: m.upper?.name || '',
          songName: extractSongName([], m.title),
          hasVideo: true,               // favlist 不给 playurl——avc1 可用性按乐观值，流链兜底降级
          matched: null,
          matchedBy: null,
        });
      }
      const total = info?.media_count ?? tracks.length;
      if (medias.length < FAV_PAGE_SIZE || tracks.length + skipped >= total) break;
    }
    if (!info) {
      return c.json({ code: 404, message: '收藏夹不存在或不可公开访问' }, 404);
    }

    // 词源匹配并发池：总预算到点 abort，在途判定被掐断的曲目按无匹配回落
    const budgetCtrl = new AbortController();
    const matchSignal = AbortSignal.any([signal, budgetCtrl.signal]);
    const budgetTimer = setTimeout(() => budgetCtrl.abort(), FAV_MATCH_BUDGET_MS);
    budgetTimer.unref?.();
    let cursor = 0;
    let matchedCount = 0;
    const worker = async () => {
      while (cursor < tracks.length && !matchSignal.aborted) {
        const t = tracks[cursor++];
        const candidates = [...new Set([t.songName, t.title]
          .map(x => (x || '').trim()).filter(Boolean))].slice(0, 3);
        const { song: matched, query } = await matchNeteaseSong(
          candidates, t.duration, 'bilibili-fav', matchSignal,
          { title: t.title, author: t.owner }).catch(() => ({ song: null }));
        if (matched && !matchSignal.aborted) {
          t.matched = { id: matched.id, name: matched.name, ar: matched.ar || matched.artists || [], al: matched.al || matched.album || {} };
          t.matchedBy = query;
          matchedCount++;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(FAV_MATCH_CONCURRENCY, tracks.length) }, worker));
    clearTimeout(budgetTimer);
    if (signal?.aborted) return c.body(null, 499);

    return c.json({
      code: 200,
      fid,
      name: info.title || '',
      cover: info.cover || '',
      creator: info.upper?.name || '',
      mediaCount: info.media_count ?? tracks.length,
      skipped,
      matchedCount,
      truncated: tracks.length >= FAV_MAX_ITEMS,
      tracks,
    });
  } catch (e) {
    if (signal?.aborted) return c.body(null, 499);
    console.error('[bilibili] favlist 失败:', e.message);
    // 上游业务码透出（私有夹/风控有可识别的 -400/-403/112xx 形态）
    return c.json({ code: 502, message: `收藏夹获取失败: ${e.message}` }, 502);
  }
});

// 播放流地址：每次重解 playurl（CDN 签名 ~2h 过期），302 到 audio-proxy
// 走统一代理（Referer 注入 + Range 透传 + SSRF 校验），不在此直接透流
app.get('/bilibili/stream', async (c) => {
  // 同样未鉴权；kind=video 最坏扇出 5 跳（view+playurl+cid 自愈两跳+durl 探测），
  // 限流放宽些（每次播放触发一次，音频+视频分开计），只挡异常刷量
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
      // 仅对「调用方传了合法数字 cid」自愈——刚查来的 cid 失败重试无意义。
      // 新 cid 必须赋回——下方 durl 探测要复用同一 cid
      if (!/^\d+$/.test(c.req.query('cid') || '')) throw e;
      const view = await biliFetch(`/x/web-interface/view?bvid=${bvid}`, c.req.raw.signal);
      cid = pickCidFromView(view, pageWanted);
      playurl = await biliFetch(`/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=4048&fourk=1`, c.req.raw.signal);
    }
    // 候选 CDN 回链按质量降序逐档铺开：mcdn 等边缘节点会带非标端口（:4483），
    // audio-proxy 端口策略会拒——用同一校验器预筛
    // prefer=best 消耗的是运营者大会员轨——配了 DOWNLOAD_TOKEN 的部署里
    // 要求带令牌才放行，匿名访客按常规档处理（不报错，静默回落）。
    // 已登录会话与令牌等效（c.get('user') 由 authGate 验过）
    const wantBest = c.req.query('prefer') === 'best';
    const token = process.env.DOWNLOAD_TOKEN || '';
    const prefer = wantBest && (!BILI_COOKIE || !token || c.get('user')
      || tokenMatches(c.req.header('x-download-token'), token)) ? 'best' : '';
    const streams = pickStreamList(playurl, kind, prefer);
    // 匿名 DASH 在低热度稿封顶 480p——durl 合流档（fnval=1&qn=80）能反超到
    // 720p，且它是恒 avc1 的完整 mp4（dash 无 avc1 的稿件也由它救活——
    // 所以探测排在「无 avc1 判死」之前，判死交给最终 usable 为空）。
    // 只在自适应最优低于 1080p 时多打这一跳；反超则只用合流组。
    // durl 是分段数组——length>1 时各段是顺序拼接而非镜像，不能用
    const dashBestH = streams[0]?.height || 0;
    let durlUrls = [];
    if (kind === 'video' && dashBestH < 1080) {
      try {
        const pd = await biliFetch(`/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=1&qn=80&fourk=1`, c.req.raw.signal);
        const durl = Array.isArray(pd.durl) ? pd.durl : [];
        if (durl.length === 1 && (QN_HEIGHT[pd.quality] || 0) > dashBestH) {
          durlUrls = [durl[0]?.url, ...(Array.isArray(durl[0]?.backup_url) ? durl[0].backup_url : [])]
            .filter(u => typeof u === 'string' && u);
        }
      } catch (e) {
        if (c.req.raw.signal?.aborted) throw e;
        // 合流档拉取失败不挡自适应主链
      }
    }
    // 与 audio-proxy 放行业务对齐：归一化 + host 白名单（DNS/端口已由
    // normalizeOutboundUrl 覆盖端口面，建连 IP 钉扎在代理层再查一次）。
    // 换档只在同一字节实体内成立——跨档（durl vs dash m4s、不同分辨率
    // dash 档）字节布局不同，播放中段换档会静默错乱：所以合流赢了就只用
    // 合流镜像组，否则只用首选自适应档自己的镜像组（baseUrl/backup_url
    // 是同字节镜像，组内换档安全）
    const passesWhitelist = (u) => {
      const checked = normalizeOutboundUrl(u);
      return checked.ok && isAllowedHost(checked.url.hostname);
    };
    let usable = [...new Set(durlUrls)].filter(passesWhitelist);
    if (!usable.length) {
      // dash 无 avc1 且 durl 没接住——hevc/av01 原样塞给 <video> 是黑屏，
      // 按无流 404（与 resolve 的 hasVideo 口径一致）
      if (kind === 'video' && !streams.some(s => (s.codecs || '').startsWith('avc1'))) {
        return c.json({ code: 404, message: 'no playable (avc1) video stream' }, 404);
      }
      const preferred = kind === 'video'
        ? (streams.find(s => (s.codecs || '').startsWith('avc1')) || streams[0])
        : streams[0];
      const backups = Array.isArray(preferred?.backupUrl) ? preferred.backupUrl
        : (Array.isArray(preferred?.backup_url) ? preferred.backup_url : []);
      usable = [...new Set([preferred?.baseUrl, preferred?.base_url, ...backups]
        .filter(u => typeof u === 'string' && u))].filter(passesWhitelist);
    }
    if (!usable.length) {
      return c.json({ code: 404, message: `该视频没有可代理的${kind === 'video' ? '视频' : '音频'}流` }, 404);
    }
    // 写响应前的终态断连检查——durl/view/playurl 多跳 await 期间客户端可能已走
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
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

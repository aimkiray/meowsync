const { Hono } = require('hono');
const { Agent } = require('undici');
const { normalizeOutboundUrl, resolvesToPublicIp, makeGuardedLookup } = require('../lib/net-guard');
const { isAllowedHost } = require('./proxy');
const { rateLimit } = require('../lib/rate-limit');
const { matchNeteaseSong } = require('../lib/netease-match');

const app = new Hono();

// B 站 API 统一请求头：Referer 是防盗链硬门槛（缺它 403），UA 伪造浏览器。
// BILI_COOKIE 可选登录态——杜比/Hi-Res 音轨只对有权限的账号下发
// （Hi-Res 通常需大会员），Cookie 只发给 api.bilibili.com 不外泄
const BILI_COOKIE = (() => {
  const raw = (process.env.BILI_COOKIE || '').trim();
  if (!raw) return '';
  // header 值要求 latin1——粘贴串带进换行/中文会让 undici 抛头校验错，
  // 全部 B 站请求静默 502；剔除控制字符并显式告警
  const ascii = raw.replace(/[^\x20-\x7e]/g, '');
  if (ascii !== raw) {
    console.warn('[bilibili] BILI_COOKIE 含控制字符/非 ASCII，已剔除——cookie 值应为纯 ASCII');
  }
  // 登录态下 B 站校验 Cookie 内 CURRENT_FNVAL 与请求 fnval 一致——浏览器
  // 导出的 cookie 里该值是用户最后播放的格式（常是 16），原样带上会被
  // 静默扣发杜比/Hi-Res 轨；剥掉重写成与请求一致的 4048
  const parts = ascii.split(';').map(s => s.trim())
    .filter(s => s && s.split('=')[0].trim().toLowerCase() !== 'current_fnval');
  parts.push('CURRENT_FNVAL=4048');
  return parts.join('; ');
})();
const BILI_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Referer': 'https://www.bilibili.com',
  ...(BILI_COOKIE ? { Cookie: BILI_COOKIE } : {}),
};
// 短链跳解只需要公共头——UA/Referer 足够拿 location，Cookie 不发 b23.tv
const BILI_PUBLIC_HEADERS = {
  'User-Agent': BILI_HEADERS['User-Agent'],
  'Referer': BILI_HEADERS['Referer'],
};
const BILI_TIMEOUT_MS = 15000;

// 允许发起重定向解析的域：仅 b23.tv 短链与 bilibili.com 本系。
// 严格 hostname 判定（等值或带点分隔后缀）——userinfo/尾界欺骗
// （b23.tv@内网、bilibili.com.evil.com）在 URL parse 层挡掉
const BILI_LINK_HOSTS = ['b23.tv', 'bilibili.com'];
const isBiliLinkHost = (h) => BILI_LINK_HOSTS.some(x => h === x || h.endsWith('.' + x));

function pickBvidFromUrl(href) {
  // 大小写宽容：三层口径统一（前端 isBilibiliInput/?bili= 都收小写）——
  // bvid 本身大小写敏感，错大小写交给上游 view API 判（-404 照常报错）
  const m = href.match(/BV[0-9A-Za-z]{10}/i);
  if (m) return m[0];
  const av = href.match(/(?:^|[/?&=])av(\d+)/i);
  if (av) return { aid: Number(av[1]) };
  return null;
}

// bvid 解析：BV 号 / av 号 / 完整 URL。b23.tv 短链本身不含 BV——
// 手动逐跳跟随（redirect:manual），每一跳都重新过 normalizeOutboundUrl
// （限 80/443/剥 credentials）+ B 站域白名单 + 公网 IP 校验 + 钉扎建连
// （audio-proxy 同款防线），重定向到任何非 B 站域即拒绝——防 SSRF 绕道
async function parseBvid(input, extraSignal) {
  const s = String(input || '').trim();
  if (!s) return null;
  const direct = pickBvidFromUrl(s);
  if (direct) return direct;
  // 裸短链补协议头（b23.tv/xxx 无 scheme 时 new URL 抛错直接拒）
  let href = /^https?:\/\//i.test(s) ? s : (/^b23\.tv\//i.test(s) ? `https://${s}` : null);
  if (!href) return null;
  for (let hop = 0; hop <= 3; hop++) {
    if (extraSignal?.aborted) return null;
    const checked = normalizeOutboundUrl(href);
    if (!checked.ok) return null;
    const u = checked.url;
    if (!isBiliLinkHost(u.hostname)) return null;
    if (!(await resolvesToPublicIp(u.hostname))) return null;
    const found = pickBvidFromUrl(u.href);
    if (found) return found;
    const dispatcher = new Agent({
      connect: { lookup: makeGuardedLookup() },
      keepAliveTimeout: 1000,
    });
    try {
      const res = await fetch(u.href, {
        headers: BILI_PUBLIC_HEADERS,
        redirect: 'manual',
        signal: extraSignal
          ? AbortSignal.any([AbortSignal.timeout(10000), extraSignal])
          : AbortSignal.timeout(10000),
        dispatcher,
      });
      await res.body?.cancel().catch(() => {});
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        href = new URL(loc, u.href).toString();
        continue;
      }
      return null;
    } catch {
      return null;
    } finally {
      dispatcher.destroy().catch(() => {});
    }
  }
  return null;
}

// extraSignal 级联客户端断连——上游请求不随客户端断开变僵尸（audio-proxy 同款语义）
async function biliFetch(path, extraSignal) {
  const res = await fetch(`https://api.bilibili.com${path}`, {
    headers: BILI_HEADERS,
    signal: extraSignal
      ? AbortSignal.any([AbortSignal.timeout(BILI_TIMEOUT_MS), extraSignal])
      : AbortSignal.timeout(BILI_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`bilibili ${path.split('?')[0]} HTTP ${res.status}`);
  const body = await res.json();
  if (body.code !== 0) throw new Error(`bilibili ${path.split('?')[0]} code=${body.code} ${body.message || ''}`);
  return body.data;
}

const viewQuery = (id) => typeof id === 'string' ? `bvid=${id}` : `aid=${id.aid}`;

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

// playurl 选流：音频按 bandwidth 降序（30280≈192k > 30232≈108k > 30216≈64k）；
// prefer='best'（下载档）把 dash.flac.audio（Hi-Res 无损）与 dash.dolby.audio
// （杜比）排在常规 AAC 前——flac > dolby > aac：无损严格优于有损空间音频，
// 这两条轨需要 fnval 相应位标志且大多要登录态，缺席时自然回落常规档。
// 视频优先 avc1（H.264 全浏览器可放）再按分辨率降序——hevc/av01 老设备放不了。
// 返回排序后的完整数组——单档流的备份 URL 全被端口策略拒时还能降级到下一档
function pickStreamList(data, kind, prefer = '') {
  const dash = data?.dash || {};
  if (kind === 'audio') {
    const audioArr = Array.isArray(dash.audio) ? dash.audio : [];
    const regular = audioArr.slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
    if (prefer === 'best') {
      // hasUrl 认全部四个地址字段——只带 backupUrl 的条目不该被预过滤丢档
      const hasUrl = (f) => f && (f.baseUrl || f.base_url
        || (Array.isArray(f.backupUrl) && f.backupUrl.length)
        || (Array.isArray(f.backup_url) && f.backup_url.length));
      // flac.audio 文档形态是单对象；上游若改成多档数组 concat 也兼容
      const flac = [].concat(dash.flac?.audio || []).filter(hasUrl);
      const dolby = (Array.isArray(dash.dolby?.audio) ? dash.dolby.audio : [])
        .filter(hasUrl).sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
      return [...flac, ...dolby, ...regular];
    }
    return regular;
  }
  const avc = (dash.video || []).filter(v => (v.codecs || '').startsWith('avc1'));
  return (avc.length ? avc : dash.video || [])
    .slice().sort((a, b) => (b.height * b.width) - (a.height * a.width));
}
const pickStreams = (data) => ({
  audio: pickStreamList(data, 'audio')[0] || null,
  video: pickStreamList(data, 'video')[0] || null,
});

// 分P参数：?p=N 从输入 URL 提取（多分P稿件导哪P播哪P，默认P1）
function pickPageParam(input) {
  const m = String(input || '').match(/[?&]p=(\d+)/);
  return m ? Math.max(1, parseInt(m[1], 10)) : 1;
}

// 限流/匹配实现移入 src/server/lib（rate-limit.js / netease-match.js）——
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
  if (!/^BV[0-9A-Za-z]{10}$/.test(String(bvid || ''))) {
    return c.json({ code: 400, message: 'invalid bvid' }, 400);
  }
  try {
    const pageWanted = pickPageParam(`?p=${c.req.query('p') || 1}`);
    // 分P cid 定位器：pages[p-1].cid ?? view.cid——无 cid 与 cid 自愈两处共用
    const pickCidFromView = (view) => {
      const pages = Array.isArray(view?.pages) ? view.pages : [];
      const idx = Math.min(pageWanted, Math.max(pages.length, 1)) - 1;
      return pages[idx]?.cid ?? view.cid;
    };
    let cid = c.req.query('cid');
    if (!cid || !/^\d+$/.test(cid)) {
      const view = await biliFetch(`/x/web-interface/view?bvid=${bvid}`, c.req.raw.signal);
      cid = pickCidFromView(view);
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
      playurl = await biliFetch(`/x/player/playurl?bvid=${bvid}&cid=${pickCidFromView(view)}&fnval=4048&fourk=1`, c.req.raw.signal);
    }
    // 候选 CDN 回链按质量降序逐档铺开：mcdn 等边缘节点会带非标端口（:4483），
    // audio-proxy 端口策略会拒——用同一校验器预筛，拿第一个能过代理的地址
    // prefer=best 消耗的是运营者大会员轨——配了 DOWNLOAD_TOKEN 的部署里
    // 要求带令牌才放行，匿名访客按常规档处理（不报错，静默回落）
    const wantBest = c.req.query('prefer') === 'best';
    const token = process.env.DOWNLOAD_TOKEN || '';
    const prefer = wantBest && (!BILI_COOKIE || !token
      || c.req.header('x-download-token') === token) ? 'best' : '';
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
    return c.redirect(`/audio-proxy?url=${encodeURIComponent(usable)}`, 302);
  } catch (e) {
    // 客户端断连不算服务端错误（与 resolve/audio-proxy 同口径）
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    console.error('[bilibili] stream 失败:', e.message);
    return c.json({ code: 502, message: `B 站流地址获取失败: ${e.message}` }, 502);
  }
});

module.exports = app;

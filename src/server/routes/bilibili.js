const { Hono } = require('hono');
const { Agent } = require('undici');
const { callNeteaseApi } = require('../services/netease-api');
const { normalizeOutboundUrl, resolvesToPublicIp, makeGuardedLookup } = require('../lib/net-guard');
const { isAllowedHost } = require('./proxy');

const app = new Hono();

// B 站 API 统一请求头：Referer 是防盗链硬门槛（缺它 403），UA 伪造浏览器
const BILI_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Referer': 'https://www.bilibili.com',
};
const BILI_TIMEOUT_MS = 15000;

// 允许发起重定向解析的域：仅 b23.tv 短链与 bilibili.com 本系。
// 严格 hostname 判定（等值或带点分隔后缀）——userinfo/尾界欺骗
// （b23.tv@内网、bilibili.com.evil.com）在 URL parse 层挡掉
const BILI_LINK_HOSTS = ['b23.tv', 'bilibili.com'];
const isBiliLinkHost = (h) => BILI_LINK_HOSTS.some(x => h === x || h.endsWith('.' + x));

function pickBvidFromUrl(href) {
  const m = href.match(/BV[0-9A-Za-z]{10}/);
  if (m) return m[0];
  const av = href.match(/(?:^|[/?&=])av(\d+)/i);
  if (av) return { aid: Number(av[1]) };
  return null;
}

// bvid 解析：BV 号 / av 号 / 完整 URL。b23.tv 短链本身不含 BV——
// 手动逐跳跟随（redirect:manual），每一跳都重新过 normalizeOutboundUrl
// （限 80/443/剥 credentials）+ B 站域白名单 + 公网 IP 校验 + 钉扎建连
// （audio-proxy 同款防线），重定向到任何非 B 站域即拒绝——防 SSRF 绕道
async function parseBvid(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  const direct = pickBvidFromUrl(s);
  if (direct) return direct;
  // 裸短链补协议头（b23.tv/xxx 无 scheme 时 new URL 抛错直接拒）
  let href = /^https?:\/\//i.test(s) ? s : (/^b23\.tv\//i.test(s) ? `https://${s}` : null);
  if (!href) return null;
  for (let hop = 0; hop <= 3; hop++) {
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
        headers: BILI_HEADERS,
        redirect: 'manual',
        signal: AbortSignal.timeout(10000),
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

// 网易云匹配：候选串逐个搜，第一条通过 sanity 校验的为准（提取名 → 清洗标题）。
// sanity = 时长差 ≤45s 或歌名与查询串有公共子串——纯「有结果就取」会把噪声标题
// 的错配永久固化进壳与历史（错歌词比没歌词更糟），校验不过就放弃匹配用 B 站元数据
const MATCH_DUR_TOLERANCE_SEC = 45;
const shareName = (a, b) => {
  const na = String(a || '').toLowerCase().replace(/[\s《》【】（）()\-—–_~～·]/g, '');
  const nb = String(b || '').toLowerCase().replace(/[\s《》【】（）()\-—–_~～·]/g, '');
  return na.length >= 2 && nb.length >= 2 && (na.includes(nb) || nb.includes(na));
};
async function matchNeteaseSong(candidates, durationSec) {
  for (const q of candidates) {
    if (!q) continue;
    try {
      const res = await callNeteaseApi('cloudsearch', { keywords: q, type: '1', limit: '5' });
      const songs = res.body?.result?.songs;
      if (!Array.isArray(songs) || !songs.length) continue;
      const hit = songs.find(s => {
        const durOk = Number.isFinite(durationSec)
          && Math.abs((s.dt || s.duration || 0) / 1000 - durationSec) <= MATCH_DUR_TOLERANCE_SEC;
        return durOk || shareName(s.name, q);
      });
      if (hit) return { song: hit, query: q };
      // 有结果但全不过 sanity：继续试下一个候选，整条候选链不过才算无匹配
    } catch (e) {
      console.warn(`[bilibili] 网易云搜索「${q}」失败:`, e.message);
    }
  }
  return { song: null, query: null };
}

// playurl 选流：音频按 bandwidth 降序（30280≈192k > 30232≈108k > 30216≈64k）；
// 视频优先 avc1（H.264 全浏览器可放）再按分辨率降序——hevc/av01 老设备放不了。
// 返回排序后的完整数组——单档流的备份 URL 全被端口策略拒时还能降级到下一档
function pickStreamList(data, kind) {
  const dash = data?.dash || {};
  if (kind === 'audio') {
    return (dash.audio || []).slice().sort((a, b) => b.bandwidth - a.bandwidth);
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

// resolve 是未鉴权扇出端点（每次最多 4 次 B 站 API + 2 次云搜）——
// 简单滑动窗限流防循环刷量把服务端 IP 送进 B 站风控
const resolveHits = new Map();
const RESOLVE_LIMIT = 12; // 每 IP 每分钟
function rateLimitResolve(ip) {
  const now = Date.now();
  const hits = (resolveHits.get(ip) || []).filter(t => now - t < 60000);
  if (hits.length >= RESOLVE_LIMIT) return false;
  hits.push(now);
  resolveHits.set(ip, hits);
  if (resolveHits.size > 5000) resolveHits.clear(); // 防内存膨胀
  return true;
}

app.get('/bilibili/resolve', async (c) => {
  const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
  if (!rateLimitResolve(ip)) {
    return c.json({ code: 429, message: '解析太频繁，稍后再试' }, 429);
  }
  const input = c.req.query('input') || c.req.query('bvid');
  const id = await parseBvid(input);
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
      biliFetch(`/x/player/playurl?bvid=${view.bvid}&cid=${cid}&fnval=16`, c.req.raw.signal),
    ]);
    const tagNames = Array.isArray(tagRes) ? tagRes.map(t => t.tag_name).filter(Boolean) : [];
    const songName = extractSongName(tagNames, view.title);
    // 候选搜索串：提取名、清洗后的标题——去重后最多两条（原标题纯噪声、
    // 只拉长最坏耗时）；整条匹配链设预算，超了就当无匹配不阻塞解析
    const cleanTitle = extractSongName([], view.title);
    const candidates = [...new Set([songName, cleanTitle])].slice(0, 2);
    const matchBudget = new Promise(resolve => setTimeout(() => resolve({ song: null, query: null }), 25000));
    const { song: matched, query: matchedBy } = await Promise.race([
      matchNeteaseSong(candidates, duration), matchBudget,
    ]);
    const { audio, video } = pickStreams(playurl);
    // hasVideo 只给「浏览器解得动的 avc1」——hevc/av01 流存在也不能宣称可视频
    const avcStreams = (playurl?.dash?.video || []).filter(v => (v.codecs || '').startsWith('avc1'));
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
      audioQuality: audio ? { id: audio.id, bandwidth: audio.bandwidth } : null,
      videoQuality: video ? { id: video.id, width: video.width, height: video.height } : null,
    });
  } catch (e) {
    console.error('[bilibili] resolve 失败:', e.message);
    return c.json({ code: 502, message: `B 站解析失败: ${e.message}` }, 502);
  }
});

// 播放流地址：每次重解 playurl（CDN 签名 ~2h 过期），302 到 audio-proxy
// 走统一代理（Referer 注入 + Range 透传 + SSRF 校验），不在此直接透流
app.get('/bilibili/stream', async (c) => {
  const bvid = c.req.query('bvid');
  const kind = c.req.query('kind') === 'video' ? 'video' : 'audio';
  if (!/^BV[0-9A-Za-z]{10}$/.test(String(bvid || ''))) {
    return c.json({ code: 400, message: 'invalid bvid' }, 400);
  }
  try {
    let cid = c.req.query('cid');
    if (!cid || !/^\d+$/.test(cid)) {
      const view = await biliFetch(`/x/web-interface/view?bvid=${bvid}`, c.req.raw.signal);
      cid = view.cid;
    }
    let playurl;
    try {
      playurl = await biliFetch(`/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=16`, c.req.raw.signal);
    } catch (e) {
      // cid 过期自愈：稿件被 UP 主换源/调 P 后库存 cid 失效——重查 view 拿新 cid 再试
      if (!c.req.query('cid')) throw e;
      const view = await biliFetch(`/x/web-interface/view?bvid=${bvid}`, c.req.raw.signal);
      playurl = await biliFetch(`/x/player/playurl?bvid=${bvid}&cid=${view.cid}&fnval=16`, c.req.raw.signal);
    }
    // 候选 CDN 回链按质量降序逐档铺开：mcdn 等边缘节点会带非标端口（:4483），
    // audio-proxy 端口策略会拒——用同一校验器预筛，拿第一个能过代理的地址
    const streams = pickStreamList(playurl, kind);
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
    console.error('[bilibili] stream 失败:', e.message);
    return c.json({ code: 502, message: `B 站流地址获取失败: ${e.message}` }, 502);
  }
});

module.exports = app;

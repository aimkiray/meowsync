const { Hono } = require('hono');
const { callNeteaseApi } = require('../services/netease-api');
const { normalizeOutboundUrl } = require('../lib/net-guard');

const app = new Hono();

// B 站 API 统一请求头：Referer 是防盗链硬门槛（缺它 403），UA 伪造浏览器
const BILI_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Referer': 'https://www.bilibili.com',
};
const BILI_TIMEOUT_MS = 15000;

// bvid 解析：BV 号 / av 号 / 完整 URL。b23.tv 短链本身不含 BV——
// 跟随重定向取最终地址再解析（fetch 默认 follow 后 res.url 即落地页）
async function parseBvid(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  const m = s.match(/BV[0-9A-Za-z]{10}/);
  if (m) return m[0];
  const av = s.match(/(?:^|[/?&=])av(\d+)/i);
  if (av) return { aid: Number(av[1]) };
  if (/^https?:\/\/(b23\.tv|[\w.-]*bilibili\.com)/i.test(s)) {
    try {
      const res = await fetch(s, { headers: BILI_HEADERS, signal: AbortSignal.timeout(10000) });
      await res.body?.cancel().catch(() => {});
      const m2 = res.url.match(/BV[0-9A-Za-z]{10}/);
      if (m2) return m2[0];
      const av2 = res.url.match(/(?:^|[/?&=])av(\d+)/i);
      if (av2) return { aid: Number(av2[1]) };
    } catch {
      return null;
    }
  }
  return null;
}

async function biliFetch(path) {
  const res = await fetch(`https://api.bilibili.com${path}`, {
    headers: BILI_HEADERS,
    signal: AbortSignal.timeout(BILI_TIMEOUT_MS),
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

// 网易云匹配：候选串逐个搜，第一条出结果的为准（提取名 → 清洗标题 → 原标题）
async function matchNeteaseSong(candidates) {
  for (const q of candidates) {
    if (!q) continue;
    try {
      const res = await callNeteaseApi('cloudsearch', { keywords: q, type: '1', limit: '5' });
      const songs = res.body?.result?.songs;
      if (Array.isArray(songs) && songs.length) return { song: songs[0], query: q };
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

app.get('/bilibili/resolve', async (c) => {
  const id = await parseBvid(c.req.query('input') || c.req.query('bvid'));
  if (!id) return c.json({ code: 400, message: '无法从输入解析 BV/av 号' }, 400);
  try {
    const view = await biliFetch(`/x/web-interface/view?${viewQuery(id)}`);
    const [tagRes, playurl] = await Promise.all([
      biliFetch(`/x/tag/archive/tags?bvid=${view.bvid}`).catch(() => []),
      biliFetch(`/x/player/playurl?bvid=${view.bvid}&cid=${view.cid}&fnval=16`),
    ]);
    const tagNames = (tagRes || []).map(t => t.tag_name).filter(Boolean);
    const songName = extractSongName(tagNames, view.title);
    // 候选搜索串：提取名、清洗后的标题、原标题——逐序试出第一个有命中的
    const cleanTitle = extractSongName([], view.title);
    const candidates = [...new Set([songName, cleanTitle, view.title])];
    const { song: matched, query: matchedBy } = await matchNeteaseSong(candidates);
    const { audio, video } = pickStreams(playurl);
    return c.json({
      code: 200,
      bvid: view.bvid,
      aid: view.aid,
      cid: view.cid,
      title: view.title,
      cover: view.pic,
      duration: view.duration,
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
      hasVideo: !!video,
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
      const view = await biliFetch(`/x/web-interface/view?bvid=${bvid}`);
      cid = view.cid;
    }
    const playurl = await biliFetch(`/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=16`);
    // 候选 CDN 回链按质量降序逐档铺开：mcdn 等边缘节点会带非标端口（:4483），
    // audio-proxy 端口策略会拒——用同一校验器预筛，拿第一个能过代理的地址
    const streams = pickStreamList(playurl, kind);
    const candidates = streams.flatMap(s =>
      [s?.baseUrl, s?.base_url, ...(s?.backupUrl || s?.backup_url || [])])
      .filter(u => typeof u === 'string' && u);
    const usable = candidates.find(u => normalizeOutboundUrl(u).ok);
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

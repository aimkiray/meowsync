const { Hono } = require('hono');
const { normalizeOutboundUrl } = require('../lib/net-guard');
const { isAllowedHost } = require('./proxy');
const { rateLimit } = require('../lib/rate-limit');
const { matchNeteaseSong } = require('../lib/netease-match');

const app = new Hono();

const YT_TIMEOUT_MS = 15000;
const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;

// ── Innertube ──
// 公开 web 客户端 key（嵌在 youtube.com 前端里，供匿名访客调 youtubei）。
// ANDROID/IOS 客户端的 streamingData 直返可播 url（无 signatureCipher 混淆
// 签名）——正是不需要 yt-dlp 的原因；ANDROID 优先，被风控/改版时退 IOS
const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const INNERTUBE_CLIENTS = [
  {
    name: 'ANDROID',
    client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, hl: 'zh' },
    headers: { 'User-Agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip' },
  },
  {
    name: 'IOS',
    client: { clientName: 'IOS', clientVersion: '20.10.4', deviceModel: 'iPhone16,2', hl: 'zh' },
    headers: { 'User-Agent': 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_4 like Mac OS X)' },
  },
];

// 播放器响应：依次尝试客户端形态，第一个给出可用流的为准。
// extraSignal 级联客户端断连——上游请求不随客户端断开变僵尸（audio-proxy 同款语义）
async function fetchPlayer(videoId, extraSignal) {
  let lastErr = null;
  for (const form of INNERTUBE_CLIENTS) {
    if (extraSignal?.aborted) throw new Error('aborted');
    try {
      const res = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...form.headers },
        body: JSON.stringify({ context: { client: form.client }, videoId }),
        signal: extraSignal
          ? AbortSignal.any([AbortSignal.timeout(YT_TIMEOUT_MS), extraSignal])
          : AbortSignal.timeout(YT_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`innertube HTTP ${res.status}`);
      const body = await res.json();
      const ps = body?.playabilityStatus;
      // OK / LIVE_EDGE 才有流；LOGIN_REQUIRED/ERROR 等直接带 reason 抛
      if (ps?.status && !['OK', 'LIVE_EDGE'].includes(ps.status)) {
        throw new Error(`不可播放: ${ps.reason || ps.status}`);
      }
      if (!body?.streamingData) throw new Error('无流数据');
      return body;
    } catch (e) {
      lastErr = e;
      console.warn(`[youtube] ${form.name} 客户端取流失败:`, e.message);
    }
  }
  throw lastErr || new Error('所有客户端形态均失败');
}

// videoId 提取：watch?v= / youtu.be/ / shorts/ / embed/ / live/ / 本站 ?yt= 分享链 /
// 裸 11 位 id。URL 形态优先，裸 id 最后——顺序敏感（裸 id 也吃 youtu.be 路径）
function pickYouTubeId(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  const m = s.match(/(?:youtube(?:-nocookie)?\.com|music\.youtube\.com)\/(?:watch\?[^ ]*?\bv=|shorts\/|embed\/|live\/|v\/)([A-Za-z0-9_-]{11})/i)
    || s.match(/youtu\.be\/([A-Za-z0-9_-]{11})/i)
    || s.match(/[?&]yt=([A-Za-z0-9_-]{11})/i);
  if (m) return m[1];
  // 裸 id 须含非数字字符——纯数字 11 位与网易云 id 撞型
  return (YT_ID_RE.test(s) && /\D/.test(s)) ? s : null;
}

// 歌名提取：YouTube 标题约定形如「Artist - Title (Official Video)」。
// 先剥括号修饰串，再按 ' - ' 切——左侧是歌手；无分隔符时用频道名兜底
// （Topic/VEVO 系自动投稿频道名即歌手名，'Title' 单独已是歌名）
function extractYtSong(title, author) {
  const cleanTitle = String(title || '')
    .replace(/[[(][^\])]*(?:official|lyrics?|audio|visuali[sz]er|video|mv|hd|4k|8k|remaster(?:ed)?|mono|explicit|live|color coded|lyric)[^\])]*[\])]/gi, ' ')
    .replace(/《|》/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // 频道名后缀剥皮：'Artist - Topic'（自动投稿）/'ArtistVEVO'（官方频道）
  const artistFromAuthor = String(author || '')
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/VEVO$/i, '')
    .trim();

  const parts = cleanTitle.split(/\s+[-—–]\s+/);
  let songName;
  let candidates;
  if (parts.length >= 2) {
    const artist = parts[0].trim();
    const name = parts.slice(1).join(' - ').trim();
    songName = name;
    candidates = [`${artist} ${name}`, name, `${artistFromAuthor} ${name}`];
  } else {
    songName = cleanTitle;
    // 无 ' - ' 分隔时频道名是唯一的歌手线索——组合串优先于裸标题
    candidates = [`${artistFromAuthor} ${cleanTitle}`, cleanTitle];
  }
  return { songName, candidates: [...new Set(candidates.filter(c => c && c.trim()))].slice(0, 3) };
}

// 选流：音频优先 mp4a/m4a 容器（audio/mp4——webm opus 在 Safari 的 <audio>
// 不通）；video 取 adaptive avc1（H.264 全浏览器可放），itag 从高到低。
// signatureCipher 混淆流（无 url 只有签名参数）跳过——本服务不做签名反解
function pickStreamList(data, kind) {
  const adaptive = Array.isArray(data?.adaptiveFormats) ? data.adaptiveFormats : [];
  const progressive = Array.isArray(data?.formats) ? data.formats : [];
  const usable = (f) => typeof f?.url === 'string' && f.url;
  if (kind === 'audio') {
    const audios = adaptive.filter(f => usable(f) && (f.mimeType || '').startsWith('audio/'));
    const mp4 = audios.filter(f => (f.mimeType || '').startsWith('audio/mp4'));
    return (mp4.length ? mp4 : audios).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  }
  const avc = adaptive.filter(f =>
    usable(f) && (f.mimeType || '').startsWith('video/mp4')
    && (f.mimeType || '').includes('avc1'));
  return (avc.length ? avc : progressive.filter(usable))
    .sort((a, b) => ((b.height || 0) * (b.width || 0)) - ((a.height || 0) * (a.width || 0)));
}

app.get('/youtube/resolve', async (c) => {
  if (!rateLimit(c, 'yt-resolve', 12)) {
    return c.json({ code: 429, message: '解析太频繁，稍后再试' }, 429);
  }
  const input = c.req.query('input') || c.req.query('v');
  const videoId = pickYouTubeId(input);
  if (!videoId) return c.json({ code: 400, message: '无法从输入解析 YouTube 视频 id' }, 400);
  try {
    const player = await fetchPlayer(videoId, c.req.raw.signal);
    const vd = player.videoDetails || {};
    const duration = parseInt(vd.lengthSeconds, 10) || 0;
    const author = vd.author || '';
    const { songName, candidates } = extractYtSong(vd.title, author);

    // 匹配预算与 bilibili 同款：整条链超时当无匹配，不阻塞解析返回
    let budgetTimer;
    const matchBudget = new Promise(resolve => {
      budgetTimer = setTimeout(() => resolve({ song: null, query: null }), 25000);
      budgetTimer.unref?.();
    });
    const { song: matched, query: matchedBy } = await Promise.race([
      matchNeteaseSong(candidates, duration, 'youtube'), matchBudget,
    ]);
    clearTimeout(budgetTimer);

    // hasVideo 只给「浏览器解得动的 avc1」——vp9/av01 流存在也不能宣称可视频；
    // progressive（formats 里的合并流）兜底也认——含音画的 360p 比没有强
    const videoFormats = pickStreamList(player.streamingData, 'video');
    const hasVideo = videoFormats.length > 0;
    const audio = pickStreamList(player.streamingData, 'audio')[0] || null;
    const video = videoFormats[0] || null;

    return c.json({
      code: 200,
      videoId,
      title: vd.title || '',
      author,
      duration,
      cover: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      songName,
      matched: matched ? {
        id: matched.id,
        name: matched.name,
        ar: matched.ar || matched.artists || [],
        al: matched.al || matched.album || {},
      } : null,
      matchedBy,
      hasVideo,
      audioQuality: audio ? { itag: audio.itag, bitrate: audio.bitrate, mimeType: audio.mimeType } : null,
      videoQuality: video ? { itag: video.itag, width: video.width, height: video.height } : null,
    });
  } catch (e) {
    // 客户端已断连：静默 499，不写错误日志（正常断连不算服务端错误）
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    console.error('[youtube] resolve 失败:', e.message);
    return c.json({ code: 502, message: `YouTube 解析失败: ${e.message}` }, 502);
  }
});

// 播放流地址：每次重解 player（googlevideo 签名 ~6h 过期）→ 302 进
// audio-proxy 走统一代理（SSRF 校验 + Range 透传），不在此直接透流
app.get('/youtube/stream', async (c) => {
  if (!rateLimit(c, 'yt-stream', 60)) {
    return c.json({ code: 429, message: '请求太频繁，稍后再试' }, 429);
  }
  const videoId = c.req.query('v');
  const kind = c.req.query('kind') === 'video' ? 'video' : 'audio';
  if (!YT_ID_RE.test(String(videoId || ''))) {
    return c.json({ code: 400, message: 'invalid video id' }, 400);
  }
  try {
    const player = await fetchPlayer(videoId, c.req.raw.signal);
    const streams = pickStreamList(player.streamingData, kind);
    // 候选回链逐个过代理白名单——signatureCipher 跳过、非 googlevideo
    // 域拒；第一个能过代理的地址即 302 目标
    const usable = streams
      .map(f => f.url)
      .find(u => {
        const checked = normalizeOutboundUrl(u);
        return checked.ok && isAllowedHost(checked.url.hostname);
      });
    if (!usable) {
      return c.json({ code: 404, message: `该视频没有可代理的${kind === 'video' ? '视频' : '音频'}流` }, 404);
    }
    return c.redirect(`/audio-proxy?url=${encodeURIComponent(usable)}`, 302);
  } catch (e) {
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    console.error('[youtube] stream 失败:', e.message);
    return c.json({ code: 502, message: `YouTube 流地址获取失败: ${e.message}` }, 502);
  }
});

module.exports = app;

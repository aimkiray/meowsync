const { Hono } = require('hono');
const { normalizeOutboundUrl, isProxyAllowedHost: isAllowedHost } = require('../lib/net-guard');
const streamVault = require('../lib/stream-vault');
const { rateLimit } = require('../lib/rate-limit');
const { matchNeteaseSong } = require('../services/netease-match');
const { extractYouTubeId, YT_ID_RE } = require('../../shared/predicates.js');

const app = new Hono();

// Innertube 原语（fetchPlayer/pickStreamList/innertubeSearch）在 lib/youtube.js
// ——解锁层 services/unlock/youtube.js 复用同一实现，不维护两份客户端表
const { fetchPlayer, pickStreamList } = require('../lib/youtube');

// videoId 提取委托共享形态表 extractYouTubeId（src/shared/predicates.js）：
// watch?v= / youtu.be/ / shorts/ / embed/ / live/ / 本站 ?yt= 分享链 / 裸 11 位 id。
// URL 形态优先，裸 id 最后（须含非数字——纯数字 11 位与网易云 id 撞型）
const pickYouTubeId = extractYouTubeId;

// 歌名提取：YouTube 标题约定形如「Artist - Title (Official Video)」。
// 先剥括号修饰串，再按 ' - ' 切——左侧是歌手；无分隔符时用频道名兜底
// （Topic/VEVO 系自动投稿频道名即歌手名，'Title' 单独已是歌名）
function extractYtSong(title, author) {
  // 括号修饰剥离：词边界防误伤——(Alive)/(Olive)/(Monochrome) 内嵌 live/mono
  // 词干不该剥；内容禁含括号保证配对（嵌套/不配对的留原样总比切残片强）；
  // 回调校验开合括号同型——`(…]`/`【…)` 跨界不配对的留原样；全角括号同规则
  const BRACKET_PAIR = { '(': ')', '（': '）', '[': ']', '【': '】' };
  const cleanTitle = String(title || '')
    .replace(/[[(（【][^\[\]()（）【】]{0,80}?\b(?:official|lyrics?|audio|visuali[sz]er|video|mv|hd|4k|8k|remaster(?:ed)?|mono|explicit|live|color coded)\b[^\[\]()（）【】]{0,80}?[\])）】]/gi,
      m => BRACKET_PAIR[m[0]] === m[m.length - 1] ? ' ' : m)
    .replace(/《|》/g, ' ')
    .replace(/\s+/g, ' ')
    // 剥括号可能留下悬空分隔符（'Artist - (Explicit)' → 'Artist -'）
    .replace(/^[-—–~～·|\s]+|[-—–~～·|\s]+$/g, '')
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
  // 先 trim 再去重——author 为空时组合串退化成 ' name' 会与 name 判异白占一席
  candidates = [...new Set(candidates.map(c => c.trim()).filter(Boolean))].slice(0, 3);
  return { songName, candidates, artistFromAuthor };
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
    // artistFromAuthor 是剥掉 ' - Topic'/'VEVO' 后的干净歌手名——前端兜底显示用
    const { songName, candidates, artistFromAuthor } = extractYtSong(vd.title, author);

    // 匹配预算与 bilibili 同款：整条链超时当无匹配，不阻塞解析返回
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
      matchNeteaseSong(candidates, duration, 'youtube',
        AbortSignal.any([c.req.raw.signal, budgetCtrl.signal]),
        { title: vd.title || '', author }),
      matchBudget,
    ]);
    clearTimeout(budgetTimer);
    // matchNeteaseSong 因断连早退后，继续构造响应只是写给死 socket
    if (c.req.raw.signal?.aborted) return c.body(null, 499);

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
      authorClean: artistFromAuthor || null,
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
    const sd = player.streamingData;
    const streams = pickStreamList(sd, kind, c.req.query('prefer'));
    // 部分视频的自适应流被 SABR 闸控：全量 GET 与越过首段窗的 Range 一律
    // 403，只有 formats 里的 progressive 合流档能拉全——把它挂进候选链尾
    // 兜底。audio kind 同样放：合流 mp4 含 AAC 轨，<audio> 按容器嗅探照播。
    // 正常视频首候选即通（idx 钉住），progressive 只在闸控时被触及
    const progressive = (Array.isArray(sd?.formats) ? sd.formats : [])
      .filter(f => typeof f?.url === 'string' && f.url
        && (f.mimeType || '').startsWith('video/mp4'))
      .sort((a, b) => ((b.height || 0) * (b.width || 0)) - ((a.height || 0) * (a.width || 0)));
    // 候选回链逐个过代理白名单——signatureCipher 跳过、非 googlevideo
    // 域拒；整条链随 token 下发，代理侧试到第一个能通的档
    const urls = [...new Set([...streams, ...progressive]
      .map(f => f.url)
      .filter(u => {
        const checked = normalizeOutboundUrl(u);
        return checked.ok && isAllowedHost(checked.url.hostname);
      }))];
    if (!urls.length) {
      return c.json({ code: 404, message: `该视频没有可代理的${kind === 'video' ? '视频' : '音频'}流` }, 404);
    }
    // vault token 化——googlevideo 链 ip= 即本机出口地址，不下发给访客
    return c.redirect(`/audio-proxy/t/${streamVault.mint(urls)}`, 302);
  } catch (e) {
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    console.error('[youtube] stream 失败:', e.message);
    return c.json({ code: 502, message: `YouTube 流地址获取失败: ${e.message}` }, 502);
  }
});

module.exports = app;

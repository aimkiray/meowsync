const { Hono } = require('hono');
const { normalizeOutboundUrl, isProxyAllowedHost: isAllowedHost } = require('../lib/net-guard');
const streamVault = require('../lib/stream-vault');
const { rateLimit } = require('../lib/rate-limit');
const { matchNeteaseSong } = require('../services/netease-match');
const { extractYouTubeId, YT_ID_RE } = require('../../shared/predicates.js');

const app = new Hono();

// Innertube 原语（fetchPlayer/pickStreamList/innertubeSearch）在 lib/youtube.js
// ——解锁层 services/unlock/youtube.js 复用同一实现，不维护两份客户端表
const { fetchPlayer, fetchPlayerWith, pickStreamList } = require('../lib/youtube');
const { fetchStream } = require('../services/file-downloader');

// 「SABR 闸控」探测缓存：videoId → {gated, ts}。自适应流被闸时签名批
// 寿命 ~6h，探测结果缓存 30min 同量级——连播/重试不重复白打上游
const GATE_TTL_MS = 30 * 60e3;
const GATE_CACHE_MAX = 512;
const gateCache = new Map();

// 闸控指纹：自适应流首段窗内的 Range 放行、窗外有界 Range 一律 403、全量
// GET 同拒。窗口不是精确 1MiB——实测紧贴 1MiB 边界的 1KiB 探测会假阴，
// 2MiB 深处才稳定 403。返回三态：false=未闸（2xx/416），true=闸控（403），
// null=无定论（超时/5xx/白名单外——不写缓存，逐请求退化照常走兜底链）。
// abort 穿透不写缓存：断连被吞成"未闸"会污染 30min 判定
async function probeGated(url, signal) {
  const checked = normalizeOutboundUrl(url);
  if (!checked.ok || !isAllowedHost(checked.url.hostname)) return null;
  try {
    const resp = await fetchStream(url, {
      timeout: 10000, signal,
      headers: { Range: 'bytes=2097152-2098175' }
    });
    resp.data.destroy();
    return false;
  } catch (e) {
    if (signal?.aborted) throw e;
    // 按机读状态码判（fetchStream 在 err.upstreamStatus 上挂的）——
    // 403=闸控；416=探针越过 EOF 但 Range 通道畅通，恰证明未闸（短文件
    // 场景），归 null 会让短流每次请求都白打探测
    if (e?.upstreamStatus === 403) return true;
    if (e?.upstreamStatus === 416) return false;
    return null;
  }
}

// formats 里的 progressive mp4 合流档——闸控视频唯一确定能拉全的形态，
// 也是 VISIONOS 批不保证回的部分；两处候选链拼尾共用同一挑选口径
function pickProgressiveMp4(sd) {
  return (Array.isArray(sd?.formats) ? sd.formats : [])
    .filter(f => typeof f?.url === 'string' && f.url
      && (f.mimeType || '').startsWith('video/mp4'))
    .sort((a, b) => ((b.height || 0) * (b.width || 0)) - ((a.height || 0) * (a.width || 0)));
}

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
  const cleanTitle = (String(title || '')
    .replace(/[[(（【][^\[\]()（）【】]{0,80}?\b(?:official|lyrics?|audio|visuali[sz]er|video|mv|hd|4k|8k|remaster(?:ed)?|mono|explicit|live|color coded|covers?)\b[^\[\]()（）【】]{0,80}?[\])）】]/gi,
      m => BRACKET_PAIR[m[0]] === m[m.length - 1] ? ' ' : m)
    // \b 对 CJK 不生效——cover 系中/韩词走独立括号剥（与 bilibili 侧同口径）
    .replace(/[（(【][^（）()【】]{0,40}?(?:커버|翻唱|翻弹|演奏)[^（）()【】]{0,40}?[)）】]/gu, ' ')
    // 韩翻/搬运号常见竖线分隔「歌名┃频道 COVER」「歌名｜频道」——首个即截，
    // 尾段是频道与标记噪声（Mela!┃미녕이 COVER → Mela!）
    .replace(/\s*[┃│｜▏|].*$/u, ' ')
    // 《》先化成空格再剥尾——「Title《COVER》」要先让 COVER 露出成尾巴
    .replace(/《|》/g, ' ')
    // 尾巴上的翻唱标记：'COVER by xx'、裸 'COVER'/'커버'/'翻唱'/'cover'
    .replace(/\s+(?:cover(?:\s+by\s+.+)?|커버|翻唱|翻弹|演奏)\s*$/i, ' ')
    .replace(/\s+/g, ' ')
    // 剥括号可能留下悬空分隔符（'Artist - (Explicit)' → 'Artist -'）
    .replace(/^[-—–~～·|\s]+|[-—–~～·|\s]+$/g, '')
    .trim()) || String(title || '');
  // ^ 行首竖线/括号剥光后 cleanTitle 可能为空——退回原始标题（与 bilibili
  // 侧 `t || title` 兜底同口径）；空标题会让 candidates 只剩频道名，
  // 退化成纯时长窗匹配，错歌词静默固化
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
    let sd = (await fetchPlayer(videoId, c.req.raw.signal)).streamingData;
    let streams = pickStreamList(sd, kind, c.req.query('prefer'));
    // progressive 合流档是闸控视频的保底命——无条件拼链尾；audio kind
    // 同样放：合流 mp4 含 AAC 轨，<audio> 按容器嗅探照播
    let progressive = pickProgressiveMp4(sd);

    // SABR 闸控探测（结果缓存）：被闸的视频换 VISIONOS 客户端重解——
    // 同一批自适应流它签的 URL 完全不受限，能放回真最高档（实测 itag251
    // 全量 200）。只有确定性判定（2xx/403/416）才写缓存——超时/断连等
    // 无定论结果落缓存会把一次抖动放大成 30min 的误判。
    // 探测目标限定自适应流：pickStreamList('video') 在缺 avc1 时会回落
    // progressive——那恰是闸控下畅通的物料，探它只能得假阴。
    // 且必须挑够长的流（最大 contentLength）：小档全长可能 < 探针起点
    // 2MiB，越界得 416 会被误判成「未闸」（实测 itag139 全长 ~1.5MB）
    const probeTarget = (Array.isArray(sd?.adaptiveFormats) ? sd.adaptiveFormats : [])
      .filter(f => typeof f?.url === 'string' && f.url
        && (f.mimeType || '').startsWith(kind === 'video' ? 'video/' : 'audio/'))
      .sort((a, b) => (parseInt(b.contentLength) || 0) - (parseInt(a.contentLength) || 0))
      .map(f => f.url)
      .find(u => {
        const chk = normalizeOutboundUrl(u);
        return chk.ok && isAllowedHost(chk.url.hostname);
      });
    let gated = null;
    const gate = gateCache.get(videoId);
    if (gate && Date.now() - gate.ts <= GATE_TTL_MS) {
      gated = gate.gated;
    } else if (probeTarget) {
      gated = await probeGated(probeTarget, c.req.raw.signal);
      if (gated !== null) {
        if (gateCache.size >= GATE_CACHE_MAX) {
          gateCache.delete(gateCache.keys().next().value);
        }
        gateCache.set(videoId, { gated, ts: Date.now() });
      }
    }
    if (gated) {
      console.info(`[youtube] ${videoId} SABR 闸控命中——VISIONOS 客户端重解`);
      try {
        const vp = await fetchPlayerWith(videoId, c.req.raw.signal, 'VISIONOS');
        if (vp?.streamingData) {
          sd = vp.streamingData;
          streams = pickStreamList(sd, kind, c.req.query('prefer'));
          const prog = pickProgressiveMp4(sd);
          if (prog.length) progressive = prog;
        }
      } catch (e) {
        // VISIONOS 也拿不到就用原批——链尾合流档照样能播；abort 穿透
        if (c.req.raw.signal?.aborted) throw e;
        console.warn(`[youtube] ${videoId} VISIONOS 重解失败，回落原批:`, e.message);
      }
    }
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
    // 探测/升级段的最后一个 await 与写响应之间仍可能断连——302 打死 socket
    // 前再查一次（与 /resolve 的 134 行同口径）
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    // vault token 化——googlevideo 链 ip= 即本机出口地址，不下发给访客
    return c.redirect(`/audio-proxy/t/${streamVault.mint(urls)}`, 302);
  } catch (e) {
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    console.error('[youtube] stream 失败:', e.message);
    return c.json({ code: 502, message: `YouTube 流地址获取失败: ${e.message}` }, 502);
  }
});

module.exports = app;

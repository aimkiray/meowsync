const { Hono } = require('hono');
const streamVault = require('../lib/stream-vault');
const mediaCache = require('../services/media-cache');
const { rateLimit } = require('../lib/rate-limit');
const { matchWithBudget, matchTracksPool, toMatchedJson } = require('../services/netease-match');
const { resolveYoutubeStreams } = require('../services/youtube-resolve');
const { extractYouTubeId, extractYouTubePlaylistId, YT_ID_RE } = require('../../shared/predicates.js');

const app = new Hono();

// Innertube 原语在 lib/youtube.js；本路由消费 fetchPlayer/pickStreamList
//（/resolve 元数据）与 fetchYtPlaylistPage（歌单页）——/stream 的闸控感知
// 取流走 services/youtube-resolve.js，搜索原语 innertubeSearch 归解锁层
const { fetchPlayer, pickStreamList, fetchYtPlaylistPage } = require('../lib/youtube');

// SABR 闸控探测/gateCache/VISIONOS 升级/progressive 结转已下沉到
// services/youtube-resolve.js——/stream 与解锁链共用同一份判定，
// 修一处全链生效，别在这里复制第二份

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
  candidates = [...new Set(candidates.map(c => c.trim()).filter(Boolean))];
  // VTuber/翻唱投稿常挂 'ver.<歌姬>' 检索噪声尾（'Dream Play Sick ver.EMA'）——
  // 每个已有候选补一条剥缀腿给匹配器；songName 不动（显示层保持诚实）。
  // 与 shared/title-variants.js titleVariantsOf 的 VER_TAIL_RE 同口径，
  // 正则改动要两边同步
  const VER_TAIL_RE = /\s*[-–—~\/|：:]?\s*(?<![\p{L}\p{N}])ver(?:sion)?[\.。]\s*[\p{L}\p{N}][\p{L}\p{N}\s_'&·-]{0,30}$/iu;
  const verStripped = [...new Set(
    candidates.map(c => c.replace(VER_TAIL_RE, '').replace(/\s+/g, ' ').trim()))]
    .filter(c => c && !candidates.includes(c));
  candidates = [...candidates, ...verStripped].slice(0, 4);
  return { songName, candidates, artistFromAuthor };
}



app.get('/youtube/resolve', async (c) => {
  if (!rateLimit(c, 'yt-resolve', 12)) {
    return c.json({ code: 429, message: '解析太频繁，稍后再试' }, 429);
  }
  const input = c.req.query('input') || c.req.query('v');
  // 歌单链（watch?v=&list= 复合形态、playlist?list=、裸 PL 前缀）走歌单导入——
  // playlist 字段带下去前端自动转 /youtube/playlist，与 bilibili favlist 同口径
  const playlistId = extractYouTubePlaylistId(input);
  if (playlistId) {
    return c.json({ code: 400, message: '这是 YouTube 歌单链接，正在为你导入歌单', playlist: playlistId }, 400);
  }
  const videoId = pickYouTubeId(input);
  if (!videoId) return c.json({ code: 400, message: '无法从输入解析 YouTube 视频 id' }, 400);
  try {
    const player = await fetchPlayer(videoId, c.req.raw.signal);
    const vd = player.videoDetails || {};
    const duration = parseInt(vd.lengthSeconds, 10) || 0;
    const author = vd.author || '';
    // artistFromAuthor 是剥掉 ' - Topic'/'VEVO' 后的干净歌手名——前端兜底显示用
    const { songName, candidates, artistFromAuthor } = extractYtSong(vd.title, author);

    // 匹配预算收敛进 services/netease-match.js:matchWithBudget——
    // 整条链超时当无匹配，不阻塞解析返回
    const { song: matched, query: matchedBy, score: matchScore } = await matchWithBudget({
      candidates, durationSec: duration, tag: 'youtube',
      reqSignal: c.req.raw.signal,
      // artists 喂打分器（频道名 + 剥皮后净名两参照）；trackId 与客户端
      // buildYouTubeSong 的 id 同构（yt_<videoId>）接 song_match 缓存键
      sourceInfo: {
        title: vd.title || '', author,
        artists: [...new Set([author, artistFromAuthor].filter(Boolean))],
        trackId: `yt_${videoId}`,
        // 描述在手交给匹配器的本家声明惰性解析——命中 utaite/翻唱稿的
        // 自署出处链时省一跳 self player 回源（lib/youtube resolveOriginalInfo）
        description: vd.shortDescription || '',
      },
    });
    // matchNeteaseSong 因断连早退后，继续构造响应只是写给死 socket
    if (c.req.raw.signal?.aborted) return c.body(null, 499);

    // hasVideo 只给「浏览器解得动的 avc1」——vp9/av01 流存在也不能宣称可视频；
    // progressive（formats 里的合并流）兜底也认——含音画的 360p 比没有强
    const videoFormats = pickStreamList(player.streamingData, 'video');
    const hasVideo = videoFormats.length > 0;
    // 下载口径独立于浏览器直放口径：下载链收全编码自适应轨（vp9/av01 合
    // 流进 mp4 合法），只发 webm 的稿件同样可下载
    const hasDownloadableVideo = hasVideo
      || (Array.isArray(player.streamingData?.adaptiveFormats)
        && player.streamingData.adaptiveFormats.some(f =>
          (f?.mimeType || '').startsWith('video/') && typeof f?.url === 'string' && f.url));
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
      matched: toMatchedJson(matched),
      matchedBy,
      matchScore: matchScore ?? null,
      hasVideo,
      hasDownloadableVideo,
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

// 歌单导入：playlist?list=/watch?v=&list=/裸 PL 前缀 → 归一曲目列表。
// Innertube browse 公开单匿名可读（私有/不存在回 ERROR alert——确定性
// 失败映射 404）；continuation 翻页，截断到 PL_MAX_ITEMS。词源匹配是
// 预算制并发池：预算耗尽剩余曲目 matched=null 照常可播可下
const PL_MAX_ITEMS = 200;
const PL_MAX_PAGES = 8;
const PL_MATCH_BUDGET_MS = 45000;
const PL_MATCH_CONCURRENCY = 3;

app.get('/youtube/playlist', async (c) => {
  if (!rateLimit(c, 'yt-playlist', 6)) {
    return c.json({ code: 429, message: '导入太频繁，稍后再试' }, 429);
  }
  const signal = c.req.raw.signal;
  const raw = c.req.query('input') || c.req.query('list') || '';
  const listId = extractYouTubePlaylistId(raw)
    // 谓词不收的形态按裸 id 兜底（VL 前缀写法/未知前缀——browseId 直拼；
    // 真实 listId ≥13 位，短 token 必是垃圾不浪费一跳）
    || (/^[A-Za-z0-9_-]{13,80}$/.test(raw.trim()) ? raw.trim() : null);
  if (!listId) {
    return c.json({ code: 400, message: '无法从输入解析歌单（支持 playlist?list=/watch?list= 链接）' }, 400);
  }
  try {
    let name = '', cover = '', creator = '', mediaCount = null;
    let skipped = 0;
    let exhausted = false; // 上游无续页——truncated 的权威判据
    const tracks = [];
    const seenIds = new Set();
    let continuation = null;
    for (let page = 0; page < PL_MAX_PAGES && tracks.length < PL_MAX_ITEMS; page++) {
      if (signal?.aborted) return c.body(null, 499);
      let data;
      try {
        data = await fetchYtPlaylistPage({ listId, continuation, extraSignal: signal });
      } catch (e) {
        if (!tracks.length && page === 0) throw e; // 首页即挂——整体失败走 catch
        break;                                     // 续页翻车：保住已扫部分按截断返回
      }
      if (page === 0) {
        name = data.title; cover = data.cover; creator = data.owner;
        mediaCount = data.mediaCount;
      }
      skipped += data.skipped;
      for (const it of data.items) {
        if (tracks.length >= PL_MAX_ITEMS) break;
        if (seenIds.has(it.videoId)) continue;
        seenIds.add(it.videoId);
        const { songName, candidates, artistFromAuthor } = extractYtSong(it.title, it.owner);
        tracks.push({
          videoId: it.videoId,
          title: it.title || '',
          author: it.owner || '',
          authorClean: artistFromAuthor || null,
          duration: it.durationSec || 0,
          cover: `https://i.ytimg.com/vi/${it.videoId}/hqdefault.jpg`, // 与 resolve 同款确定性缩略图
          songName,
          candidates,
          hasVideo: true,          // browse 不给 streamingData——avc1 可用性乐观值，流链兜底降级
          hasDownloadableVideo: true, // 同口径乐观值——纯 webm/非 avc1 稿件也亮下载入口
          matched: null,
          matchedBy: null,
          matchScore: null,
        });
      }
      continuation = data.continuation;
      // 见底只看上游续页 token——整页条目全失效的页不该误标 exhausted
      if (!continuation) { exhausted = true; break; }
    }
    // info 缺省=不可用（与 favlist 同口径）；首页空且无续页=空单
    if (!name && !tracks.length) {
      return c.json({ code: 404, message: '歌单不存在或不可公开访问' }, 404);
    }

    // 词源匹配并发池收敛进 services/netease-match.js:matchTracksPool
    const matchedCount = await matchTracksPool(tracks, {
      signal, budgetMs: PL_MATCH_BUDGET_MS, concurrency: PL_MATCH_CONCURRENCY,
      tag: 'youtube-pl',
      candidatesOf: (t) => t.candidates,
      durationOf: (t) => t.duration,
      infoOf: (t) => ({
        title: t.title, author: t.author,
        artists: [...new Set([t.author, t.authorClean].filter(Boolean))],
        trackId: `yt_${t.videoId}`,
      }),
    });
    if (signal?.aborted) return c.body(null, 499);

    return c.json({
      code: 200,
      listId,
      name,
      cover,
      creator,
      mediaCount: mediaCount ?? tracks.length,
      skipped,
      matchedCount,
      truncated: !exhausted,
      tracks: tracks.map(({ candidates, ...t }) => t), // 内部匹配用字段不下发
    });
  } catch (e) {
    if (signal?.aborted) return c.body(null, 499);
    console.error('[youtube] playlist 失败:', e.message);
    // 分档：私有/不存在 alert 与上游 400/404 是「不可访问」→404；
    // ALERT_AUTH（登录/风控）、EMPTY_SHELL、5xx/网络/超时是上游故障 →502
    if (e.upstreamCode === 'ALERT_ERROR' || /HTTP (400|404)/.test(e.message || '')) {
      return c.json({ code: 404, message: '歌单不存在或不可公开访问' }, 404);
    }
    return c.json({ code: 502, message: `歌单获取失败: ${e.message}` }, 502);
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
    // 闸控感知解析下沉 services/youtube-resolve.js：探测/VISIONOS 升级/
    // progressive 结转/白名单去重一份实现，解锁链共用同一判定
    // skipCache（?retry=1）：前端重试时旁路 gateCache 读——缓存的误判
    // 不再把第二次请求钉死在同一个错误判定上（缓存仍照常写入新判定）
    const { streams } = await resolveYoutubeStreams(videoId, {
      kind, prefer: c.req.query('prefer'), signal: c.req.raw.signal,
      skipCache: c.req.query('retry') === '1'
    });

    const head = streams[0];
    if (!head) {
      return c.json({ code: 404, message: `该视频没有可代理的${kind === 'video' ? '视频' : '音频'}流` }, 404);
    }
    // 探测/升级段的最后一个 await 与写响应之间仍可能断连——302 打死 socket
    // 前再查一次（与 /resolve 的 134 行同口径）
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    // vault 单实体：跨分辨率/编码的候选是不同字节文件，混排换档会把同一
    // offset 的另一文件字节拼给客户端（bilibili 链同字节镜像先例的反面）——
    // 只 mint 首链；次优档不是活链而是错位毒源。死档由前端重试触发重解
    // 缓存键挂同一字节实体的指纹（codec+br+itag）——重解换签名/IP 段
    // 不变键：播过的完整档直接命中，签名过期也能播。itag 段防同 codec
    // 同 br 的不同上游流撞键（googlevideo URL 恒带 itag 参数——取不到
    // 时指纹退化为旧格式，旧键档自然淘汰不迁移）
    let itag = '';
    try { itag = new URL(head.url).searchParams.get('itag') || ''; } catch { /* 畸形 URL 不落指纹段 */ }
    const cacheKey = mediaCache.keyOf('yt', videoId, kind === 'video' ? 'v' : 'a',
      mediaCache.fingerprintOf(head.mimeType, head.br, null, itag));
    const cacheMeta = {
      muxed: mediaCache.muxedOf(head.mimeType),
      codec: mediaCache.codecOf(head.mimeType) || null,
      br: head.br ?? null,
    };
    return c.redirect(`/audio-proxy/t/${streamVault.mint(head.url, { cacheKey, cacheMeta })}`, 302);
  } catch (e) {
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    console.error('[youtube] stream 失败:', e.message);
    return c.json({ code: 502, message: `YouTube 流地址获取失败: ${e.message}` }, 502);
  }
});

module.exports = app;

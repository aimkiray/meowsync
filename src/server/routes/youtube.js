const { Hono } = require('hono');
const streamVault = require('../lib/stream-vault');
// 外发 Location 必须拼回部署前缀——entryFetch 剥前缀后路由按根路径工作，
// 裸 /audio-proxy/t/… 在 BASE_PATH 子目录部署下回客户端即 404
const { withBasePath } = require('../lib/base-path');
const mediaCache = require('../services/media-cache');
const { stripAbsolutePaths } = require('../lib/sanitize');
const { rateLimit } = require('../lib/rate-limit');
const { matchWithBudget, matchTracksPool, toMatchedJson } = require('../services/netease-match');
const { resolveYoutubeStreams } = require('../services/youtube-resolve');
const { createTtlCache } = require('../lib/stream-resolve-cache');
const { extractYouTubeId, extractYouTubePlaylistId, YT_ID_RE } = require('../../shared/predicates.js');
// 手选媒体源绑定消费步：自有源腿败亡时绑定点名媒体顶替——只闸
// kind==='audio'（绑定语义是音源顶替，resolveById 只产音频流，视频模式
// 恒为自有媒体）；绑媒体 mint 裸 urls 不蹭播过路缓存键
const { manualStreamOverride } = require('../services/unlock/manual-stream');

const app = new Hono();

// Innertube 原语在 lib/youtube.js；本路由消费 fetchPlayer/pickStreamList
//（/resolve 元数据）、fetchYtPlaylistPage（歌单页）与 innertubeSearch/
// fetchWatchNext/ytSuggest（曲库搜索/相关/建议）——/stream 的闸控感知
// 取流走 services/youtube-resolve.js。
// resolvePublishedAt 走 ?. 调用：旧桩面缺导出归 null 不炸（与
// netease-match/lyric-verify 的 ytLib 模块对象消费口径同型）
const { fetchPlayer, pickStreamList, fetchYtPlaylistPage, resolvePublishedAt,
  innertubeSearch, fetchWatchNext, ytSuggest } = require('../lib/youtube');

// SABR 闸控探测/gateCache/VISIONOS 升级/progressive 结转已下沉到
// services/youtube-resolve.js——/stream 与解锁链共用同一份判定，
// 修一处全链生效，别在这里复制第二份

// videoId 提取委托共享形态表 extractYouTubeId（src/shared/predicates.js）：
// watch?v= / youtu.be/ / shorts/ / embed/ / live/ / 本站 ?yt= 分享链 / 裸 11 位 id。
// URL 形态优先，裸 id 最后（须含非数字——纯数字 11 位与网易云 id 撞型）
const pickYouTubeId = extractYouTubeId;

// /youtube/stream 在途单飞：同 (videoId, kind, prefer, retry) 并发取流共享
// 一条 resolveYoutubeStreams 链——签名解析含 SABR 探测/形态升级最坏多跳
// 扇出，播放页音频+视频双发与前端重试叠放是纯放大。共享链不吃调用方
// signal（首调用方断连不陪绑搭车者；链内各跳带 YT_TIMEOUT_MS 自净上限），
// 等待方 await 后自查自己的 signal 再消费结果。
// retry=1（skipCache）必须入键：重试刻意旁路 gateCache 读——若与常规请求
// 合流，重试会吃到它正要绕开的缓存误判
const ytStreamInflight = new Map();
// 解析产物短 TTL 正缓存：googlevideo 签名 ~6h 寿命，10min 复用让客户端
// 上一曲/下一曲冷跳与 ExoPlayer 重复 open 吃到上次产物，不再各付一遍
// player+SABR 探测扇出（预热请求打满缓存、真实播放命中才真降延迟）。
// 命中先于 inflight 检查：已有成品不搭车、不等在途链
const ytResolveCache = createTtlCache({ max: 256, ttlMs: 10 * 60_000 });
const resolveStreamsShared = (videoId, { kind, prefer, skipCache }) => {
  const key = `${videoId}|${kind}|${prefer || ''}|${skipCache ? 1 : 0}`;
  // 正缓存键把 retry 段钉 0：retry=1 绕过读、照常写（gateCache「缓存仍
  // 照常写入新判定」同口径）——重试解出的新产物落在常规键上才能治好
  // 可能已死的旧档；写进 |1 段是死写（retry 永不读缓存）
  const cacheKey = `${videoId}|${kind}|${prefer || ''}|0`;
  if (!skipCache) {
    const hit = ytResolveCache.get(cacheKey);
    if (hit) return hit;
  }
  let gate = ytStreamInflight.get(key);
  if (!gate) {
    gate = resolveYoutubeStreams(videoId, { kind, prefer, skipCache })
      .then((res) => {
        // 只缓存可播成品——空 streams 在路由层就是 404，负结果不写
        // （bilibili 侧 noAvc1/空 usable 同口径），reject 自然不写，
        // 一次上游抖动不该把「无流」钉满 TTL
        if (res?.streams?.length) ytResolveCache.set(cacheKey, res);
        return res;
      })
      .finally(() => ytStreamInflight.delete(key));
    ytStreamInflight.set(key, gate);
  }
  return gate;
};

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

// 搜索/相关行 → buildYouTubeSong 直喂形（与 /resolve 同口径 extractYtSong
// 剥洗；search/next 不给 streamingData——hasVideo/hasDownloadableVideo
// 乐观值与歌单导入同口径，流链兜底降级）。channelId/publishedTimeText
// 上游在场才挂键；publishedAt 恒 null——搜索/相关页只有相对时间文本，
// ISO 发布日另走 resolve 的 microformat 轴
const ytSearchRow = (it) => {
  const { songName, artistFromAuthor } = extractYtSong(it.title, it.owner);
  return {
    videoId: it.videoId,
    title: it.title || '',
    author: it.owner || '',
    authorClean: artistFromAuthor || null,
    duration: it.durationSec || 0,
    cover: `https://i.ytimg.com/vi/${it.videoId}/hqdefault.jpg`, // 与 resolve 同款确定性缩略图
    songName: songName || null,
    matched: null,
    publishedAt: null,
    hasVideo: true,
    hasDownloadableVideo: true,
    ...(it.channelId ? { channelId: it.channelId } : {}),
    ...(it.publishedTimeText ? { publishedTimeText: it.publishedTimeText } : {}),
  };
};

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
    // 源视频发布日（epoch ms）：player 在手直给提取零上行，且写穿
    // basicsMemo 焐热——后续 match/verify 的惰性日期解析命中同一本
    // memo 不再回源。提取失败/字段缺席归 null（?. + ?? null 对旧桩
    // 缺导出面双保险）——日期是增强证据不是门禁
    const publishedAt = await resolvePublishedAt?.({ videoId, player, signal: c.req.raw.signal }).catch(() => null) ?? null;
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
        // 发布日同槽注入：匹配器消费「稿日倒挂」判据时零回源取数
        publishedAt,
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
      // 源视频发布日（epoch ms|null）——客户端持久化与核验链的时间证据
      publishedAt: publishedAt || null,
      audioQuality: audio ? { itag: audio.itag, bitrate: audio.bitrate, mimeType: audio.mimeType } : null,
      videoQuality: video ? { itag: video.itag, width: video.width, height: video.height } : null,
    });
  } catch (e) {
    // 客户端已断连：静默 499，不写错误日志（正常断连不算服务端错误）
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    console.error('[youtube] resolve 失败:', e.message);
    return c.json({ code: 502, message: `YouTube 解析失败: ${stripAbsolutePaths(e?.message || '未知错误')}` }, 502);
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
    return c.json({ code: 502, message: `歌单获取失败: ${stripAbsolutePaths(e?.message || '未知错误')}` }, 502);
  }
});

// ── 曲库搜索 / 相关 / 建议 ─────────────────────────────────────────────
// yt: 前缀与深挖游标的服务端面：搜索续页走不透明 continuation token
// （原样透传——格式即上游私有契约，格式校验只会随改版误杀）；
// 相关走 /next secondaryResults；建议是 suggestqueries 纯 JSON 归一成
// 网易 search_suggest 同款 {allMatch:[{keyword}]}——切源面板（P5）直消费
app.get('/youtube/search', async (c) => {
  if (!rateLimit(c, 'yt-search', 20)) {
    return c.json({ code: 429, message: '搜索太频繁，稍后再试' }, 429);
  }
  const q = (c.req.query('q') || '').trim();
  if (!q || q.length > 200) {
    return c.json({ code: 400, message: 'invalid query' }, 400);
  }
  const limit = Math.min(30, Math.max(5, Math.floor(+c.req.query('limit')) || 20));
  // 翻页游标原样透传——长度钳防滥用（真 token 是 KB 级 base64 串）。
  // 注：续页请求上游只认 token——continuation 自含 query，这里 q 必填是保守契约
  const continuation = (c.req.query('continuation') || '').slice(0, 2000) || null;
  try {
    const { items, continuation: next } = await innertubeSearch(q, {
      signal: c.req.raw.signal, limit, continuation,
    });
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    return c.json({ code: 200, items: items.map(ytSearchRow), continuation: next || null });
  } catch (e) {
    // 客户端已断连：静默 499，不写错误日志（正常断连不算服务端错误）
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    console.error('[youtube] search 失败:', e.message);
    return c.json({ code: 502, message: `YouTube 搜索失败: ${stripAbsolutePaths(e?.message || '未知错误')}` }, 502);
  }
});

// 相关视频：/next secondaryResults → 同搜索行形。mixPlaylistId 是
// YouTube Mix 自动生成单（radioRenderer.playlistId）——单列不混 items
app.get('/youtube/related', async (c) => {
  if (!rateLimit(c, 'yt-related', 30)) {
    return c.json({ code: 429, message: '请求太频繁，稍后再试' }, 429);
  }
  const videoId = c.req.query('v') || '';
  if (!YT_ID_RE.test(videoId)) {
    return c.json({ code: 400, message: 'invalid video id' }, 400);
  }
  try {
    const { items, mixPlaylistId } = await fetchWatchNext(videoId, c.req.raw.signal);
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    return c.json({
      code: 200,
      // 种子稿混进相关栏是上游常态噪声——剔除防相关面板自环
      items: items.filter(it => it.videoId !== videoId).map(ytSearchRow),
      mixPlaylistId: mixPlaylistId || null,
    });
  } catch (e) {
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    console.error('[youtube] related 失败:', e.message);
    return c.json({ code: 502, message: `YouTube 相关获取失败: ${stripAbsolutePaths(e?.message || '未知错误')}` }, 502);
  }
});

// 搜索建议：suggestqueries → {allMatch:[{keyword}]}（网易 search_suggest
// 归一形——前端 search_suggest 消费面直接可切）
app.get('/youtube/suggest', async (c) => {
  if (!rateLimit(c, 'yt-suggest', 30)) {
    return c.json({ code: 429, message: '请求太频繁，稍后再试' }, 429);
  }
  const q = (c.req.query('q') || '').trim();
  if (!q || q.length > 200) {
    return c.json({ code: 400, message: 'invalid query' }, 400);
  }
  try {
    const { suggestions } = await ytSuggest(q, c.req.raw.signal);
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    return c.json({ code: 200, result: { allMatch: (suggestions || []).map(k => ({ keyword: k })) } });
  } catch (e) {
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    console.error('[youtube] suggest 失败:', e.message);
    return c.json({ code: 502, message: `YouTube 搜索建议失败: ${stripAbsolutePaths(e?.message || '未知错误')}` }, 502);
  }
});

// 播放流地址：每次重解 player（googlevideo 签名 ~6h 过期）→ 302 进
// audio-proxy 走统一代理（SSRF 校验 + Range 透传），不在此直接透流。
// kind=audio 自有源腿败亡（空流/抛错）时查 song_unlock_manual 顶替
//（与数值域「官方直解→手动→推导回链」同序）；kind=video 恒自有源
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
    // 不再把第二次请求钉死在同一个错误判定上（缓存仍照常写入新判定）。
    // 经 ytStreamInflight 合流——共享链不带本请求 signal，断连由下方
    // await 后的 signal 自查兜底
    // prefer 归一后再入键与传 resolve：lib 只认 'best'（pickStreamList 的
    // 位标志），垃圾值与空值产同一批候选——原样入键只会白占键基数
    const prefer = c.req.query('prefer') === 'best' ? 'best' : '';
    let streams = null;
    let ownErr = null; // 自有源错误存外侧——绑定腿也空/死时回原分档路径
    try {
      ({ streams } = await resolveStreamsShared(videoId, {
        kind, prefer,
        skipCache: c.req.query('retry') === '1'
      }));
    } catch (e) {
      if (e?.aborted || c.req.raw.signal?.aborted) throw e; // 走外层 499
      ownErr = e;
    }
    // 搭车等待期间本客户端可能已断连——产物是共享的，写响应按自己的
    // signal 判（bilibili/stream 同位同口径）：abort 请求不白烧绑定步的
    // repo 读+resolveById
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    const head = streams?.[0];
    // 自有源腿败亡→kind=audio 查手动绑定顶替（轨道键 yt_<videoId> 与
    // buildYouTubeSong id 同构）；retry=1 旁路手动缓存读照常写
    if (!head && kind === 'audio') {
      const manual = await manualStreamOverride(`yt_${videoId}`, {
        purpose: prefer === 'best' ? 'download' : 'playback',
        signal: c.req.raw.signal,
        skipCache: c.req.query('retry') === '1',
      });
      if (manual) {
        console.info(`[youtube/stream] yt_${videoId} → 手动绑定 ${manual.source}/${manual.mediaId}`);
        c.header('x-manual-source', manual.source);
        // mint 不带 cacheKey/cacheMeta——resolveById 产物无 mimeType/codec
        // 指纹材料，绑媒体不蹭播过路缓存键
        return c.redirect(withBasePath(`/audio-proxy/t/${streamVault.mint(manual.urls)}`), 302);
      }
    }
    if (ownErr) throw ownErr; // 回外层既有分档（499/502）
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
    return c.redirect(withBasePath(`/audio-proxy/t/${streamVault.mint(head.url, { cacheKey, cacheMeta })}`), 302);
  } catch (e) {
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    console.error('[youtube] stream 失败:', e.message);
    return c.json({ code: 502, message: `YouTube 流地址获取失败: ${stripAbsolutePaths(e?.message || '未知错误')}` }, 502);
  }
});

module.exports = app;

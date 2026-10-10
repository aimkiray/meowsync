const { Hono } = require('hono');
const { normalizeOutboundUrl, isProxyAllowedHost: isAllowedHost } = require('../lib/net-guard');
const { stripAbsolutePaths } = require('../lib/sanitize');
const streamVault = require('../lib/stream-vault');
// 外发 Location 必须拼回部署前缀——entryFetch 剥前缀后路由按根路径工作，
// 裸 /audio-proxy/t/… 在 BASE_PATH 子目录部署下回客户端即 404
const { withBasePath } = require('../lib/base-path');
const mediaCache = require('../services/media-cache');
const { rateLimit } = require('../lib/rate-limit');
const { matchWithBudget, matchTracksPool, toMatchedJson } = require('../services/netease-match');
const { tokenMatches } = require('../lib/token-eq');
const { createTtlCache } = require('../lib/stream-resolve-cache');
const { BVID_RE } = require('../../shared/predicates.js');
// 上游交互原语（cookie 头/biliFetch/选流/分P/bvid 解析）在 lib/bilibili.js——
// file-downloader 的 bv_* 分发共用同一实现，不维护两份客户端
const { biliFetch, pickStreamList, pickStreams, pickPageParam, pickCidFromView, flatUrls, viewQuery, resolveBiliLink, hasBiliCookie, QN_HEIGHT } = require('../lib/bilibili');

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
  // favlist 字段带下去前端自动转 /bilibili/favlist，与 disstid 同口径。
  // catch 防跳解途中同步抛（URL 构造/agent 异常）漏成裸 500——解析失败
  // 按「无法解析」400 处理更贴用户语义
  const link = await resolveBiliLink(input, c.req.raw.signal).catch(() => null);
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
      biliFetch(`/x/player/playurl?bvid=${view.bvid}&cid=${cid}&fnval=4048&fourk=1&qn=127`, c.req.raw.signal),
    ]);
    const tagNames = Array.isArray(tagRes) ? tagRes.map(t => t.tag_name).filter(Boolean) : [];
    const songName = extractSongName(tagNames, view.title);
    // 候选搜索串：提取名 → 分P名（多分P合集里 page.part 常是精准歌名，主标题反是噪声）
    // → 清洗标题。原标题纯噪声不入列；整条匹配链设预算，超了当无匹配不阻塞解析
    const cleanTitle = extractSongName([], view.title);
    // 先 trim 再去重——page.part 带空白会带脏串进云搜（与 youtube.js 同口径）
    const candidates = [...new Set([songName, page?.part, cleanTitle]
      .map(c => (c || '').trim()).filter(Boolean))].slice(0, 3);
    // 匹配预算收敛进 services/netease-match.js:matchWithBudget——
    // 整条链超时当无匹配不阻塞解析；预算耗尽 abort 在途云搜/AI 复核
    const { song: matched, query: matchedBy, score: matchScore } = await matchWithBudget({
      candidates, durationSec: duration, tag: 'bilibili',
      reqSignal: c.req.raw.signal,
      // artists/trackId 喂打分器与 song_match 缓存键——trackId 与客户端
      // buildBilibiliSong 的 id 同构（bv_<bvid>[_pN]）
      sourceInfo: {
        title: view.title || '', author: view.owner?.name || '',
        artists: view.owner?.name ? [view.owner.name] : [],
        trackId: `bv_${view.bvid}${pageIdx + 1 > 1 ? `_p${pageIdx + 1}` : ''}`,
      },
    });
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    const { audio, video } = pickStreams(playurl);
    // hasVideo 只给「浏览器解得动的 avc1」——hevc/av01 流存在也不能宣称可视频；
    // hasDownloadableVideo 口径放宽到「有任何视频轨」——下载链能合流非 avc1
    // 档进 mp4，纯 hev1/av01 稿件（4K 独占编码）不该拿不到下载入口
    const allVideo = Array.isArray(playurl?.dash?.video) ? playurl.dash.video : [];
    // 原始上游数组可能含 null 条目——与 lib 侧同口径 ?.（裸 .codecs
    // 会 TypeError 炸穿 502）
    const avcStreams = allVideo.filter(v => (v?.codecs || '').startsWith('avc1'));
    // 无损/杜比轨可用性回给前端展示（下载 prefer=best 会实际命中）——
    // URL 判定与 lib hasUrl 同口径：只带 backup_url 的轨也算可用
    const dashAudio = playurl?.dash || {};
    const hasAnyUrl = (f) => f && (f.baseUrl || f.base_url
      || (Array.isArray(f.backupUrl) && f.backupUrl.length)
      || (Array.isArray(f.backup_url) && f.backup_url.length));
    const hasHiRes = [].concat(dashAudio.flac?.audio || []).some(hasAnyUrl);
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
      matched: toMatchedJson(matched),
      matchedBy,
      matchScore: matchScore ?? null,
      hasVideo: avcStreams.length > 0,
      // 含 URL 的条目才算可下载——null/无地址脏条目不亮假入口
      hasDownloadableVideo: allVideo.some(v => v && (v.baseUrl || v.base_url)),
      hasHiRes,
      hasDolby,
      audioQuality: audio ? { id: audio.id, bandwidth: audio.bandwidth } : null,
      videoQuality: video ? { id: video.id, width: video.width, height: video.height } : null,
    });
  } catch (e) {
    // 客户端已断连：静默 499，不写错误日志（正常断连不算服务端错误）
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    console.error('[bilibili] resolve 失败:', e.message);
    return c.json({ code: 502, message: `B 站解析失败: ${stripAbsolutePaths(e?.message || '未知错误')}` }, 502);
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
  const link = await resolveBiliLink(raw, signal).catch(() => null);
  // resolveBiliLink 不识别的裸数字按 fid 兜底（resolve 重定向回喂走这条）——
  // 顶栏裸数字走网易云歌单，到不了这里
  const fid = link?.kind === 'favlist' ? link.fid
    : (/^\d{1,20}$/.test(raw.trim()) ? raw.trim() : null);
  if (!fid) return c.json({ code: 400, message: '无法从输入解析收藏夹（支持 space favlist?fid=/medialist/mlN 链接）' }, 400);
  try {
    let info = null;
    let skipped = 0;
    let exhausted = false; // 上游已见底——truncated 的权威判据（纯计数会漏报/误报）
    const tracks = [];
    for (let pn = 1; pn <= Math.ceil(FAV_MAX_ITEMS / FAV_PAGE_SIZE); pn++) {
      if (signal?.aborted) return c.body(null, 499);
      let data;
      try {
        data = await biliFetch(
          `/x/v3/fav/resource/list?media_id=${fid}&ps=${FAV_PAGE_SIZE}&pn=${pn}&platform=web`, signal);
      } catch (e) {
        if (!info && !tracks.length) throw e; // 首页即挂——整体失败走 catch
        break;                                // 中途翻车：保住已扫部分按截断返回
      }
      info = info || data?.info || null;
      const medias = Array.isArray(data?.medias) ? data.medias : [];
      if (!medias.length) { exhausted = true; break; }
      for (const m of medias) {
        if (tracks.length >= FAV_MAX_ITEMS) break;
        // 非视频/失效条目跳过计数透出：attr≠0 是 UP 自删/下架位
        // （失效项标题不恒为哨兵），标题哨兵作兜底
        if (m?.type !== 2 || !m.bvid || m.title === '已失效视频' || (m.attr ?? 0) !== 0) {
          skipped++;
          continue;
        }
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
          hasDownloadableVideo: true,   // 同口径乐观值——纯非 avc1 稿件也能亮下载入口
          matched: null,
          matchedBy: null,
          matchScore: null,
        });
      }
      // has_more 是上游权威翻页信号；缺省回落「短页即底 + 计数已扫满」
      // 推断——media_count 缺省时按未见底继续翻（宁多打一跳不漏页）。
      // 见底判定必须先于上限 break：恰好第 200 条就是末条时 exhausted 要置位
      const hasMore = data?.has_more ?? (medias.length >= FAV_PAGE_SIZE
        && (info?.media_count == null || tracks.length + skipped < info.media_count));
      if (!hasMore) { exhausted = true; break; }
      if (tracks.length >= FAV_MAX_ITEMS) break;
    }
    if (!info) {
      return c.json({ code: 404, message: '收藏夹不存在或不可公开访问' }, 404);
    }

    // 词源匹配并发池收敛进 services/netease-match.js:matchTracksPool——
    // 总预算到点 abort，在途判定被掐断的曲目按无匹配回落
    const matchedCount = await matchTracksPool(tracks, {
      signal, budgetMs: FAV_MATCH_BUDGET_MS, concurrency: FAV_MATCH_CONCURRENCY,
      tag: 'bilibili-fav',
      candidatesOf: (t) => [...new Set([t.songName, t.title]
        .map(x => (x || '').trim()).filter(Boolean))].slice(0, 3),
      durationOf: (t) => t.duration,
      infoOf: (t) => ({
        title: t.title, author: t.owner,
        artists: t.owner ? [t.owner] : [], trackId: `bv_${t.bvid}`,
      }),
    });
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
      truncated: !exhausted,
      tracks,
    });
  } catch (e) {
    if (signal?.aborted) return c.body(null, 499);
    console.error('[bilibili] favlist 失败:', e.message);
    // 上游业务码分档：-400/-403/-404 系（私有夹/不存在/无权限）对用户是
    // 「不可访问」而非网关故障——映射 404；风控（-352/-412）等仍 502
    const code = Number(e.message?.match(/code=(-?\d+)/)?.[1]);
    if ([-400, -403, -404].includes(code)) {
      return c.json({ code: 404, message: '收藏夹不存在或不可公开访问' }, 404);
    }
    return c.json({ code: 502, message: `收藏夹获取失败: ${stripAbsolutePaths(e?.message || '未知错误')}` }, 502);
  }
});

// /bilibili/stream 上游解析段（view→playurl→cid 自愈→durl 反超→白名单
// 预筛→分P 键段反解）收敛成纯数据产物：{usable, cacheTier, cacheMuxed,
// pagePart, noAvc1}。并发同参请求（播放页音频+视频各一次、进度条重试
// 叠放、多客户端同曲）此前各跑一遍最坏 5 跳扇出——按
// (bvid, cid|p, kind, prefer) 键在途合流。共享链不吃调用方 signal
// （首调用方断连不陪绑搭车者；每跳 biliFetch 的 15s 内部超时是自净
// 上限），等待方 await 后自查自己的 signal 再消费结果
const streamSetInflight = new Map();
// 解析产物短 TTL 正缓存：playurl 签名 ~2h 寿命，10min 复用把客户端冷跳/
// 重复 open 的多跳扇出（view+playurl+cid 自愈+durl 探测最坏 5 跳）打成
// 一次内存读。命中先于 inflight 检查：已有成品不搭车、不等在途链
const biliResolveCache = createTtlCache({ max: 256, ttlMs: 10 * 60_000 });
const resolveStreamSetShared = ({ bvid, cidParam, pageWanted, kind, prefer }) => {
  const key = `${bvid}|${cidParam ? `c${cidParam}` : `p${pageWanted}`}|${kind}|${prefer || '-'}`;
  // 正缓存键按请求参数原样排（cidParam/pageWanted 各占一段）——与
  // inflight 的 c<cid>/p<page> 折叠段不同源：合流只管并发复用，缓存管
  // 跨请求复用，cid 显式请求的产物本就按真实分P 算 pagePart，分键各自正确。
  // prefer 用令牌门之后的终值——best 与常规档是不同字节实体，绝不共键
  const cacheKey = `${bvid}|${cidParam}|${pageWanted}|${kind}|${prefer || ''}`;
  const hit = biliResolveCache.get(cacheKey);
  if (hit) return hit;
  let gate = streamSetInflight.get(key);
  if (!gate) {
    gate = resolveStreamSet({ bvid, cidParam, pageWanted, kind, prefer })
      .then((set) => {
        // 只缓存可播成品：noAvc1/空 usable 的 404 形态不写——cid 自愈
        // 与上游抖动留重试余地，一次抖动不该把「无流」钉满 TTL
        if (set && !set.noAvc1 && set.usable?.length) {
          biliResolveCache.set(cacheKey, set);
        }
        return set;
      })
      .finally(() => streamSetInflight.delete(key));
    streamSetInflight.set(key, gate);
  }
  return gate;
};

async function resolveStreamSet({ bvid, cidParam, pageWanted, kind, prefer }) {
  // 显式 cid 在位时实际播放内容由 cid 决定而非 ?p——mint 缓存键前要把
  // cid 反解回真实分P 序（下方 pagePart），否则 ?p=1&cid=<P2的cid> 会
  // 把 P2 字节写进 p1 键，正常 P1 请求吃到 P2 档
  let cid = cidParam;
  let cidExplicit = /^\d+$/.test(String(cidParam || ''));
  if (!cidExplicit) {
    const view = await biliFetch(`/x/web-interface/view?bvid=${bvid}`);
    cid = pickCidFromView(view, pageWanted);
  }
  let playurl;
  try {
    playurl = await biliFetch(`/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=4048&fourk=1&qn=127`);
  } catch (e) {
    // cid 过期自愈：稿件被 UP 主换源/调 P 后库存 cid 失效——按 p 重查对应分P
    // 的 cid（不能回落 view.cid——那是 P1，会把分P导入的曲静默拉回第一P）。
    // 仅对「调用方传了合法数字 cid」自愈——刚查来的 cid 失败重试无意义。
    // 新 cid 必须赋回——下方 durl 探测要复用同一 cid
    if (!cidExplicit) throw e;
    const view = await biliFetch(`/x/web-interface/view?bvid=${bvid}`);
    cid = pickCidFromView(view, pageWanted);
    cidExplicit = false; // 自愈后内容跟分P 序走——键段回到 p<pageWanted>
    playurl = await biliFetch(`/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=4048&fourk=1&qn=127`);
  }
  // 候选 CDN 回链按质量降序逐档铺开：mcdn 等边缘节点会带非标端口（:4483），
  // audio-proxy 端口策略会拒——用同一校验器预筛
  const streams = pickStreamList(playurl, kind, prefer);
  // 匿名 DASH 在低热度稿封顶 480p——durl 合流档（fnval=1&qn=80）能反超到
  // 720p，且它是恒 avc1 的完整 mp4（dash 无 avc1 的稿件也由它救活——
  // 所以探测排在「无 avc1 判死」之前，判死交给最终 usable 为空）。
  // 只在 avc1 最优低于 1080p 时多打这一跳；反超则只用合流组。
  // 门挡必须按 avc1 档算而非列表首项——无 avc1 时 lib 兜底回全编码
  // 列表，首项可能是 2160p hev1/av01，会挡住 durl 探测把纯非 avc1
  // 稿件直接 404（avcBestH=0 时必然去探）
  // durl 是分段数组——length>1 时各段是顺序拼接而非镜像，不能用
  const avcBestH = streams.find(s => (s?.codecs || '').startsWith('avc1'))?.height || 0;
  let durlUrls = [];
  if (kind === 'video' && avcBestH < 1080) {
    try {
      const pd = await biliFetch(`/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=1&qn=80&fourk=1`);
      const durl = Array.isArray(pd.durl) ? pd.durl : [];
      if (durl.length === 1 && (QN_HEIGHT[pd.quality] || 0) > avcBestH) {
        // durl 的主链字段是 .url 而非 baseUrl——与 flatUrls 形态不同，不复用
        durlUrls = [durl[0]?.url, ...(Array.isArray(durl[0]?.backup_url) ? durl[0].backup_url : [])]
          .filter(u => typeof u === 'string' && u);
      }
    } catch {
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
  // 缓存键材料随胜出集走：durl 合流整段 mp4（无档对象）→ muxed 直标；
  // 自适应镜像组挂所在 tier 的 codecs/bandwidth 指纹
  let cacheTier = null;
  let cacheMuxed = usable.length > 0;
  if (!usable.length) {
    // dash 无 avc1 且 durl 没接住——hevc/av01 原样塞给 <video> 是黑屏，
    // 按无流 404（与 resolve 的 hasVideo 口径一致）。此形态早退省掉
    // 下方 pagePart 的 view 反查一跳
    if (kind === 'video' && !streams.some(s => (s?.codecs || '').startsWith('avc1'))) {
      return { usable: [], noAvc1: true };
    }
    // 顶档镜像全被白名单拒（mcdn 非标端口等）时按档降级——preferred 取
    // 「首个有可过白名单 URL 的档」而非无条件首档，否则冷稿件整档 404。
    // 到这里的 video 档必然全 avc1（无 avc1 上面已判死），无需再滤编码
    const usableTier = (s) => flatUrls(s).map(x => x.url).filter(passesWhitelist);
    const tier = streams.find(s => usableTier(s).length);
    usable = tier ? [...new Set(usableTier(tier))] : [];
    cacheTier = tier || null;
  }
  if (!usable.length) return { usable: [], noAvc1: false };
  // 键的 page 成分必须跟内容走：显式 cid 请求经 view.pages 反解真实分P；
  // 反解不出（cid 陈旧/上游抖动）用 cid 本身入键——宁可键不合并，绝不
  // 让 P2 字节写进 p1 键错位喂出
  let pagePart = `p${pageWanted}`;
  if (cidExplicit) {
    const view = await biliFetch(`/x/web-interface/view?bvid=${bvid}`).catch(() => null);
    const idx = (Array.isArray(view?.pages) ? view.pages : [])
      .findIndex(pg => String(pg?.cid) === String(cid));
    pagePart = idx >= 0 ? `p${idx + 1}` : `c${cid}`;
  }
  return { usable, cacheTier, cacheMuxed, pagePart, noAvc1: false };
}

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
    // 非数字 cid 视为未传——与解析段 cidExplicit 判定同口径（脏参数入键
    // 会把 'cabc' 与真实 cid 键错开，语义上也确实不是合法 cid）
    const rawCid = c.req.query('cid');
    const cidParam = /^\d+$/.test(String(rawCid || '')) ? rawCid : '';
    // prefer=best 消耗的是运营者大会员轨——配了 DOWNLOAD_TOKEN 的部署里
    // 要求带令牌才放行，匿名访客按常规档处理（不报错，静默回落）。
    // 已登录会话与令牌等效（c.get('user') 由 authGate 验过）。
    // 令牌门在合流键之前算——best 与常规档产不同字节实体，绝不能共用键
    const wantBest = c.req.query('prefer') === 'best';
    const token = process.env.DOWNLOAD_TOKEN || '';
    const prefer = wantBest && (!hasBiliCookie() || !token || c.get('user')
      || tokenMatches(c.req.header('x-download-token'), token)) ? 'best' : '';
    const set = await resolveStreamSetShared({ bvid, cidParam, pageWanted, kind, prefer });
    // 搭车等待期间本客户端可能已断连——产物是共享的，写响应按自己的 signal 判
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    if (set.noAvc1) {
      return c.json({ code: 404, message: 'no playable (avc1) video stream' }, 404);
    }
    if (!set.usable.length) {
      return c.json({ code: 404, message: `该视频没有可代理的${kind === 'video' ? '视频' : '音频'}流` }, 404);
    }
    // vault token 化——登录态 baseUrl 带 mid/uipk/deadline，不出进程；
    // cacheKey 挂字节实体指纹（codec+bandwidth+流 id）——签名过期照样
    // 命中盘上档
    const cacheKey = mediaCache.keyOf('bv', bvid, set.pagePart, kind === 'video' ? 'v' : 'a',
      mediaCache.fingerprintOf(set.cacheTier?.mimeType || (set.cacheMuxed ? 'video/mp4' : ''),
        set.cacheTier?.bandwidth ?? 0, set.cacheTier?.codecs, set.cacheTier?.id));
    const cacheMeta = {
      muxed: set.cacheMuxed,
      codec: set.cacheTier?.codecs || mediaCache.codecOf(set.cacheTier?.mimeType) || null,
      br: set.cacheTier?.bandwidth ?? null,
      h: set.cacheTier?.height || 0,
      w: set.cacheTier?.width || 0,
    };
    return c.redirect(withBasePath(`/audio-proxy/t/${streamVault.mint(set.usable, { cacheKey, cacheMeta })}`), 302);
  } catch (e) {
    // 客户端断连不算服务端错误（与 resolve/audio-proxy 同口径）
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    console.error('[bilibili] stream 失败:', e.message);
    return c.json({ code: 502, message: `B 站流地址获取失败: ${stripAbsolutePaths(e?.message || '未知错误')}` }, 502);
  }
});

module.exports = app;

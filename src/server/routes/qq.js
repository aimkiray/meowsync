const { Hono } = require('hono');
const { fail } = require('../lib/http-error');
const { tokenMatches } = require('../lib/token-eq');
const { stripAbsolutePaths } = require('../lib/sanitize');
const { rateLimit } = require('../lib/rate-limit');
const { createTtlCache } = require('../lib/stream-resolve-cache');
const streamVault = require('../lib/stream-vault');
// 外发 Location 必须拼回部署前缀——entryFetch 剥前缀后路由按根路径工作，
// 裸 /audio-proxy/t/… 在 BASE_PATH 子目录部署下回客户端即 404
const { withBasePath } = require('../lib/base-path');
const { matchWithBudget, matchTracksPool, toMatchedJson } = require('../services/netease-match');
const {
  hasQqCookie, PLAY_LADDER, BEST_LADDER, SONGMID_RE,
  getSongDetail, pickStreamUrl, getLyric, getPlaylist, searchSongs,
  searchPlaylists, searchSuggest, getHotkeys,
  resolveQqInput,
} = require('../lib/qq');
// 手选媒体源绑定消费步：自有源腿败亡时绑定点名媒体顶替（本端点天然
// audio-only 无 kind 闸）；绑媒体 mint 裸 urls 不蹭播过路缓存键
const { manualStreamOverride } = require('../services/unlock/manual-stream');
// 外源解锁腿（第三腿）：F1 共享解锁链 + F2 qq 伪行装配——qq_<mid> 键域
// 直通（[canonical:ID-PASSTHROUGH]）；源序恒 youtube→bilibili
//（QQ_UNLOCK_SOURCES——pyncmd 是数值 id 直解器，对 qq_<mid> 无语义永不入集）
const { resolveTrackUnlock, qqUnlockInfo } = require('../services/netease-api');
const { QQ_UNLOCK_SOURCES } = require('../services/unlock');
const mediaCache = require('../services/media-cache');

const app = new Hono();

// QQ 音源：qq_<songmid> 外部源形态（与 bv_/yt_ 同构），差异是 QQ 自带真实元
// 数据与权威双语歌词——网易云匹配只做封面/歌词源兜底而非主要元数据来源。
// 法务面：腾讯对第三方抓取有明确律师函史（lx-music/MusicFree）——本路由是
// 自托管个人工具实现，QQ_COOKIE 由部署者自带（强烈建议小号，勿用主力号）

// 曲目归一 → 前端歌单元件（buildQQSong 与下载器共用口径）。
// publishTime 是 normalizeTrack 的条件键（归一失败不留键）——白名单
// 条件透传，不下发明文 undefined
const trackJson = (t) => ({
  mid: t.mid,
  songId: t.songId,
  name: t.name,
  artists: t.artists,
  album: t.album,
  albummid: t.albummid,
  duration: t.intervalSec,
  cover: t.cover,
  mediaMid: t.mediaMid,
  payPlay: t.payPlay,
  vipOnly: t.vipOnly,
  ...(t.publishTime ? { publishTime: t.publishTime } : {}),
});

// vkey 档梯挑选：与 file-downloader 共用 lib/qq.js 的 pickStreamUrl
// （midurlinfo 逐档 purl 为空即无权限；sip 逐条过 normalizeOutboundUrl+
// QQ_STREAM_HOST_OK——sip 可能回裸 IP 条目，后缀判定天然拒绝自动降级）。
// 短 TTL 正缓存叠在 lib 的 pickStreamInflight 单飞之上：inflight 只挡
// 并发重复，正缓存挡「下一次播放重取」——vkey ~22h 寿命，10min 复用把
// 客户端冷跳/重复 open 的 vkey 回源打成一次内存读。命中先于 inflight：
// 有成品直接出，不进共享链。prefer 用令牌门之后的终值——best（VIP/
// 无损档）与常规档产不同字节实体，绝不共键（bilibili 令牌门同口径）
const qqResolveCache = createTtlCache({ max: 256, ttlMs: 10 * 60_000 });
// skipCache（?retry=1）：绕过读、照常写（治愈写——重试取到的新 vkey 落回
// 常规键治好可能已死的旧档，yt/bili 同口径）。lib 侧 pickStreamInflight
// 合流键不含 retry 位：在途产物本来就是新解，合流无陈腐面——与 yt/bili
// 的「retry 入 inflight 键」不矛盾，那里防的是链内二级缓存判定（gateCache）
// 与键面同构，qq 链内没有可绕的内层判定
const pickStream = (mid, mediaMid, prefer, extraSignal, skipCache) => {
  const cacheKey = `${mid}|${mediaMid}|${prefer || ''}`;
  if (!skipCache) {
    const hit = qqResolveCache.get(cacheKey);
    if (hit) return hit;
  }
  return pickStreamUrl(mid, {
    mediaMid, signal: extraSignal,
    ladder: prefer === 'best' ? BEST_LADDER : PLAY_LADDER,
  }).then((h) => {
    // 只缓存非空 hit——null（无权限/地域限制）不写，负结果不固化；
    // 等待方 abort 穿透（pickStreamUrl 抛 'aborted'）同样不写，
    // 与共享链「产物归未断连的搭车者」同口径
    if (h) qqResolveCache.set(cacheKey, h);
    return h;
  });
};

// 凭据状态透出（MA provider status 同款只读事实）：前端据此调整 VIP 曲的
// 可播性判定——配了 VIP cookie 的部署里 payPlay 曲实际可播。只回布尔
// 枚举不回任何凭据本体
app.get('/qq/status', (c) => c.json({ code: 200, loggedIn: hasQqCookie() }));

app.get('/qq/resolve', async (c) => {
  if (!rateLimit(c, 'qq-resolve', 12)) {
    return c.json({ code: 429, message: '请求太频繁，稍后再试' }, 429);
  }
  const parsed = await resolveQqInput(c.req.query('input') || '', c.req.raw.signal);
  if (c.req.raw.signal?.aborted) return c.body(null, 499);
  if (!parsed?.mid && !parsed?.songid) {
    // disstid 带字段下发——前端收到后自动转歌单导入（编码 p= 形态前端谓词看不穿，
    // 只能由服务端跳解兜底；裸提示会让已粘顶栏的用户陷入死循环指引）
    if (parsed?.disstid) return fail(c, 400, '这是 QQ 歌单链接，正在为你导入歌单', { disstid: parsed.disstid });
    if (parsed?.albummid) return c.json({ code: 400, message: '这是专辑链接，暂不支持（可用单曲/歌单链接）' }, 400);
    return c.json({ code: 400, message: '无法从输入解析 QQ 音乐歌曲（支持 songDetail/分享链接/songmid/songid）' }, 400);
  }
  try {
    const t = await getSongDetail(parsed.mid || parsed.songid, c.req.raw.signal,
      parsed.mid ? 'mid' : 'songid');
    // QQ 自带真实元数据——网易云匹配只当封面/歌词兜底源：候选串从精准到宽
    const candidates = [...new Set([
      `${t.artists.join(' ')} ${t.name}`.trim(), t.name,
    ].filter(Boolean))].slice(0, 3);
    // 匹配预算收敛进 services/netease-match.js:matchWithBudget
    const { song: matched, query: matchedBy, score: matchScore } = await matchWithBudget({
      candidates, durationSec: t.intervalSec, tag: 'qq',
      reqSignal: c.req.raw.signal,
      // QQ 自带真实元数据——artists 数组直接喂打分器（比 join 的作者串更准）；
      // trackId 与客户端 buildQQSong 的 id 同构（qq_<mid>）接 song_match 缓存键
      sourceInfo: {
        title: t.name, author: t.artists.join(' '),
        artists: t.artists, trackId: `qq_${t.mid}`,
        // 曲库发行日（epoch ms）喂匹配侧时间证据——与 bv/yt 路由同轴
        // （srcPubMsOf 只认正有限数，缺席归 0=未知不扰判定）
        publishedAt: t.publishTime || 0,
      },
    });
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    return c.json({
      code: 200,
      ...trackJson(t),
      matched: toMatchedJson(matched),
      matchedBy,
      matchScore: matchScore ?? null,
    });
  } catch (e) {
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    console.error('[qq] resolve 失败:', e.message);
    return c.json({ code: 502, message: `QQ 音乐解析失败: ${stripAbsolutePaths(e?.message || '未知错误')}` }, 502);
  }
});

// QQ 匿名取流关停是上游凭据级事实（2026-04 实测 104009/1000）——无 cookie
// 每次播放都打一发注定拒答的 vkey 纯属喂风控信号。进程级标量负 memo：
// 实锤后 TTL 内直接跳过自有腿；有 cookie / retry=1 / 过期不查 memo
//（凭据变了/显式重试要重探 reopening）。下载腿不挂 memo——任务级
// 延迟不敏感且 task retry 已兜瞬时毛刺。
let qqAnonDeniedAt = 0;
const QQ_ANON_DENY_TTL_MS = 10 * 60 * 1000;
// 外源腿等待方预算：双源串行最坏 ~120s+AI，75s 内单源命中即回——预算
// 断只让本等待方离场（共享链后台续跑产物照落缓存，retry 搭 inflight/60s
// 正档不二次烧上游，[canonical:SHARED-GATE]）
const QQ_UNLOCK_ENDPOINT_BUDGET_MS = 75_000;
// googlevideo URL 恒带 itag 参数——指纹段防同 codec 同 br 的不同上游流
// 撞键（routes/youtube.js 同款取法）；畸形 URL 不落指纹段
const itagOf = (u) => {
  try { return new URL(u).searchParams.get('itag') || ''; } catch { return ''; }
};

// 播放流地址：vkey 与 (guid,uin,请求方IP) 绑定且 ~22h 过期——每次播放重取，
// 302 进 audio-proxy 由代理回源（白名单 stream.qqmusic.qq.com 系已放行）。
// 腿序「官方直解 → 手动绑定 → 外源解锁（yt→bv）」：自有源腿败亡（无流/
// 凭据拒答/瞬时抛错）时先查 song_unlock_manual——用户「换源」点名的
// 绑定媒体顶替（绑定不压过活的自有源，休眠不触发）；绑定缺席/失败再走
// F1 共享解锁链（youtube→bilibili 串行），产物一律 vault 化下发——
// 词源 neteaseId/song_match 不入音频链任何判据
app.get('/qq/stream', async (c) => {
  if (!rateLimit(c, 'qq-stream', 60)) {
    return c.json({ code: 429, message: '请求太频繁，稍后再试' }, 429);
  }
  const mid = c.req.query('mid') || '';
  if (!SONGMID_RE.test(mid)) {
    return c.json({ code: 400, message: 'invalid songmid' }, 400);
  }
  const mmid = SONGMID_RE.test(c.req.query('mmid') || '') ? c.req.query('mmid') : '';
  // prefer=best 消耗登录态 VIP/无损档——与 bilibili 同款令牌门：配了
  // QQ_COOKIE+DOWNLOAD_TOKEN 时要求 x-download-token，匿名请求静默回落常规档。
  // 已登录会话（c.get('user')，authGate 验过）与令牌等效——启用登录的部署
  // 里浏览器不带 x-download-token，否则会话用户被静默降档
  const wantBest = c.req.query('prefer') === 'best';
  const token = process.env.DOWNLOAD_TOKEN || '';
  const prefer = wantBest && (!hasQqCookie() || !token || c.get('user')
    || tokenMatches(c.req.header('x-download-token'), token)) ? 'best' : '';
  try {
    // ?retry=1 旁路正缓存读（治愈写照常在 pickStream 内落常规键）——
    // 前端 _streamRetried 重试不再吃到同一份死档
    const retried = c.req.query('retry') === '1';
    // 匿名拒答负 memo：实锤后 TTL 内、无 cookie、非显式重试时整腿跳过——
    // 合成 ownErr 让终错分档与实锤同口径（qqAnonDenied 502 诚实面）
    const skipDoomedAnon = !hasQqCookie() && !retried
      && Date.now() - qqAnonDeniedAt < QQ_ANON_DENY_TTL_MS;
    let hit = null;
    let ownErr = null; // 自有源错误存外侧——绑定腿/外源腿也空/死时回原分档路径
    if (skipDoomedAnon) {
      ownErr = { qqAnonDenied: true };
    } else {
      try {
        hit = await pickStream(mid, mmid, prefer, c.req.raw.signal, retried);
      } catch (e) {
        if (e?.aborted || c.req.raw.signal?.aborted) throw e; // 走外层 499
        ownErr = e;                                          // 含 qqAnonDenied
        // 无 cookie 的拒答实锤盖 memo 章——凭据级事实 TTL 内免重打
        if (e?.qqAnonDenied && !hasQqCookie()) qqAnonDeniedAt = Date.now();
      }
    }
    // 搭车等待期间本客户端可能已断连——产物是共享的，写响应按自己的
    // signal 判（bilibili/stream 同位同口径）：abort 请求不白烧绑定步的
    // repo 读+resolveById
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    if (!hit) {
      // 自有源腿败亡→手动绑定媒体顶替（轨道键 qq_<mid> 与 buildQQSong id
      // 同构）；purpose 沿令牌门终值，retry=1 旁路手动缓存读照常写
      const manual = await manualStreamOverride(`qq_${mid}`, {
        purpose: prefer === 'best' ? 'download' : 'playback',
        signal: c.req.raw.signal,
        skipCache: retried,
      });
      if (manual) {
        console.info(`[qq/stream] qq_${mid} → 手动绑定 ${manual.source}/${manual.mediaId}`);
        c.header('x-manual-source', manual.source);
        // mint 不带 cacheKey/cacheMeta——resolveById 产物无 mimeType/codec
        // 指纹材料，绑媒体不蹭播过路缓存键
        return c.redirect(withBasePath(`/audio-proxy/t/${streamVault.mint(manual.urls)}`), 302);
      }
      // 绑定缺席/败亡→外源解锁腿：qq_<mid> 键域直通 F1 共享链，
      // includeManual=false——绑定已被上一步专职消费（[canonical:MANUAL-ONCE]），
      // 链内 repo 读与手动步全省。独立限流桶——重放烧不起上游检索扇出
      if (!rateLimit(c, 'qq-unlock', 20)) {
        return c.json({ code: 429, message: '请求太频繁，稍后再试' }, 429);
      }
      // AbortSignal.any 并预算——请求断连与 75s 阈值任一先到都让本等待方
      // 离场；signal 只门控消费权，不进共享 produce 链
      const budget = AbortSignal.any([
        c.req.raw.signal,
        AbortSignal.timeout(QQ_UNLOCK_ENDPOINT_BUDGET_MS),
      ]);
      let unlocked = null;
      try {
        unlocked = await resolveTrackUnlock(`qq_${mid}`, {
          purpose: prefer === 'best' ? 'download' : 'playback',
          sources: QQ_UNLOCK_SOURCES,
          proxied: true,
          includeManual: false,
          skipCache: retried,
          buildInfo: () => qqUnlockInfo(mid, {}),
          signal: budget,
        });
      } catch (e) {
        if (c.req.raw.signal?.aborted) return c.body(null, 499);
        if (e?.aborted || budget.aborted) {
          // 预算断：等待方离场，共享链后台续跑——诚实文案引导重试
          return c.json({ code: 502, message: '外源解锁超时——可稍后重试' }, 502);
        }
        throw e; // 其余异常回外层 502 分档
      }
      const resolved = unlocked?.resolved;
      if (resolved) {
        console.info(`[qq/stream] qq_${mid} 自有源败亡——外源解锁 ${resolved.source}/${resolved.mediaId || '-'} 命中`);
        c.header('x-unlock-source', resolved.source);
        if (resolved.mediaId) {
          // mediaId 在场 → 挂播过路缓存键：媒体 id+字节实体指纹（codec/br/
          // itag 段）——重解换签名不变键，同曲重播/下载相位直吃盘上档
          //（bilibili.js :602-614 先例）
          const fp = mediaCache.fingerprintOf(null, resolved.br, resolved.ext,
            resolved.source === 'youtube' ? itagOf(resolved.url) : null);
          const cacheKey = resolved.source === 'bilibili'
            ? mediaCache.keyOf('bv', resolved.mediaId, 'p1', 'a', fp)
            : mediaCache.keyOf('yt', resolved.mediaId, 'a', fp);
          const cacheMeta = {
            muxed: false, codec: resolved.ext || null, br: resolved.br ?? null, h: 0, w: 0,
          };
          return c.redirect(withBasePath(`/audio-proxy/t/${streamVault.mint(resolved.urls, { cacheKey, cacheMeta })}`), 302);
        }
        // mediaId 缺席 → 裸 mint 降级（与手动腿绑媒体同口径——不蹭缓存键）
        return c.redirect(withBasePath(`/audio-proxy/t/${streamVault.mint(resolved.urls)}`), 302);
      }
      // 全灭：逐源归因留痕 + body.unlockErrors 加性机读面（排障/客户端可
      // 程序区分 nomatch/authwall/breaker）
      const unlockErrors = unlocked?.errors || [];
      console.warn(`[qq/stream] qq_${mid} 外源解锁全灭（unlock=${
        unlockErrors.map(x => `${x.source}: ${x.msg}`).join('；') || '无逐源记录'}）`);
      if (ownErr?.qqAnonDenied) {
        return c.json({ code: 502, unlockErrors, message: 'QQ 已关闭匿名取流——请在设置页配置 QQ Cookie 后重试' }, 502);
      }
      if (ownErr) throw ownErr; // 回外层既有分档（stripPaths 502 verbatim）
      // 无登录态下「无流」的真因几乎恒为上游已关匿名取流——文案给可执行
      // 指引；有 cookie 时保留 VIP/地域口径（那时它才可能是真因）
      return c.json({ code: 404, unlockErrors, message: hasQqCookie()
        ? '该歌曲没有可用的播放流（自有档与外源解锁均未命中——可能需 VIP 权限或存在地域限制）'
        : '该歌曲暂无可播流——QQ 已关闭匿名取流且外源解锁未命中（可配置 Cookie 或绑定手动媒体源）' }, 404);
    }
    // 经 vault 换 opaque token——purl 明文带 uin/vkey/guid，不进 Location/前端可见面
    return c.redirect(withBasePath(`/audio-proxy/t/${streamVault.mint(hit.url)}`), 302);
  } catch (e) {
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    // vkey 凭据级拒答（lib 打标 qqAnonDenied——匿名取流已关停）出诚实
    // 错误面：可执行指引而非含糊上游错；已知终态不刷错误日志
    if (e?.qqAnonDenied) {
      return c.json({ code: 502, message: 'QQ 已关闭匿名取流——请在设置页配置 QQ Cookie 后重试' }, 502);
    }
    console.error('[qq] stream 失败:', e.message);
    return c.json({ code: 502, message: `QQ 音乐流地址获取失败: ${stripAbsolutePaths(e?.message || '未知错误')}` }, 502);
  }
});

// QQ 自带权威歌词（base64 LRC + 翻译）——qq_ 曲无需走网易云词源嫁接
app.get('/qq/lyric', async (c) => {
  if (!rateLimit(c, 'qq-lyric', 30)) {
    return c.json({ code: 429, message: '请求太频繁，稍后再试' }, 429);
  }
  const mid = c.req.query('mid') || '';
  if (!SONGMID_RE.test(mid)) return c.json({ code: 400, message: 'invalid songmid' }, 400);
  try {
    const { lyric, trans } = await getLyric(mid, c.req.raw.signal);
    return c.json({ code: 200, lyric, trans });
  } catch (e) {
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    console.error('[qq] lyric 失败:', e.message);
    return c.json({ code: 502, message: `QQ 歌词获取失败: ${stripAbsolutePaths(e?.message || '未知错误')}` }, 502);
  }
});

// 曲库搜索——点歌台 qq: 前缀搜索用。p/limit 是深挖翻页参数（QQ 源用
// 上游页码 p 而非 offset）；total 是上游真值，挖不到归 null——前端
// 「加载更多」键按 null 灭灯
app.get('/qq/search', async (c) => {
  if (!rateLimit(c, 'qq-search', 20)) {
    return c.json({ code: 429, message: '请求太频繁，稍后再试' }, 429);
  }
  const q = (c.req.query('q') || '').trim();
  if (!q || q.length > 100) return c.json({ code: 400, message: 'invalid query' }, 400);
  // p 上限钳 1000——QQ 深挖页码直透上游，无界页码会放大上游翻页扇面
  const page = Math.min(1000, Math.max(1, Math.floor(+c.req.query('p')) || 1));
  const limit = Math.min(Math.max(1, Math.floor(+c.req.query('limit')) || 20), 30);
  try {
    const { list, total } = await searchSongs(q, { limit, page }, c.req.raw.signal);
    return c.json({ code: 200, list: list.map(trackJson), total, page });
  } catch (e) {
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    console.error('[qq] search 失败:', e.message);
    return c.json({ code: 502, message: `QQ 音乐搜索失败: ${stripAbsolutePaths(e?.message || '未知错误')}` }, 502);
  }
});

// 搜索建议（typeahead）：smartbox → 网易 search_suggest 归一形态
// {allMatch,songs,artists,albums}。客户端自行防抖——服务端不限连发节奏
// groundwork:全局切源(P5)消费
app.get('/qq/suggest', async (c) => {
  if (!rateLimit(c, 'qq-suggest', 30)) {
    return c.json({ code: 429, message: '请求太频繁，稍后再试' }, 429);
  }
  const key = (c.req.query('key') || '').trim();
  if (!key || key.length > 100) return c.json({ code: 400, message: 'invalid key' }, 400);
  try {
    const result = await searchSuggest(key, c.req.raw.signal);
    return c.json({ code: 200, result });
  } catch (e) {
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    console.error('[qq] suggest 失败:', e.message);
    return c.json({ code: 502, message: `QQ 搜索建议失败: ${stripAbsolutePaths(e?.message || '未知错误')}` }, 502);
  }
});

// 热搜：gethotkey → 网易 search_hot 归一形态 {hots:[{first}]}
// groundwork:全局切源(P5)消费
app.get('/qq/hot', async (c) => {
  if (!rateLimit(c, 'qq-hot', 20)) {
    return c.json({ code: 429, message: '请求太频繁，稍后再试' }, 429);
  }
  try {
    const result = await getHotkeys(c.req.raw.signal);
    return c.json({ code: 200, result });
  } catch (e) {
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    console.error('[qq] hot 失败:', e.message);
    return c.json({ code: 502, message: `QQ 热搜获取失败: ${stripAbsolutePaths(e?.message || '未知错误')}` }, 502);
  }
});

// 歌单搜索：client_music_search_songlist → PlaylistGrid 归一卡
// （provider:'qq' 让前端点卡走 /qq/playlist 导入链而非 getPlaylistDetail）
app.get('/qq/search-playlists', async (c) => {
  if (!rateLimit(c, 'qq-search-playlists', 20)) {
    return c.json({ code: 429, message: '请求太频繁，稍后再试' }, 429);
  }
  const q = (c.req.query('q') || '').trim();
  if (!q || q.length > 100) return c.json({ code: 400, message: 'invalid query' }, 400);
  const page = Math.max(1, Math.floor(+c.req.query('p')) || 1);
  const limit = Math.min(Math.max(1, Math.floor(+c.req.query('limit')) || 20), 50);
  try {
    const { playlists, total } = await searchPlaylists(q, { page, limit }, c.req.raw.signal);
    // page 回传——与 /qq/search 分页契约同轴（深挖键按真页码续拉）
    return c.json({ code: 200, playlists, total, page });
  } catch (e) {
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    console.error('[qq] search-playlists 失败:', e.message);
    return c.json({ code: 502, message: `QQ 歌单搜索失败: ${stripAbsolutePaths(e?.message || '未知错误')}` }, 502);
  }
});

// 相似曲：上游相似接口（GetSimilarSongs/GetSingerSongList/get_radio_track）
// 匿名一律拒绝——艺人搜索降级实装（与 usePlayer 相关接续同款降级语义），
// degraded 标记透出给前端区分「真相似」与降级面。种子曲自身从结果剔除
// groundwork:全局切源(P5)消费
app.get('/qq/similar', async (c) => {
  if (!rateLimit(c, 'qq-similar', 20)) {
    return c.json({ code: 429, message: '请求太频繁，稍后再试' }, 429);
  }
  const mid = c.req.query('songmid') || '';
  if (!SONGMID_RE.test(mid)) return c.json({ code: 400, message: 'invalid songmid' }, 400);
  try {
    const t = await getSongDetail(mid, c.req.raw.signal, 'mid');
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    const artist = (t?.artists || [])[0];
    if (!artist) return c.json({ code: 200, list: [], degraded: true });
    const { list } = await searchSongs(artist, { limit: 20 }, c.req.raw.signal);
    return c.json({
      code: 200,
      // 剔种子用 detail 归一后的 t.mid——请求串 mid 可能与归一产物不同
      //（songid 入参被解成 songmid 等），比错对象自身会混进相似列表
      list: list.filter(x => x.mid !== t.mid).map(trackJson),
      degraded: true,
    });
  } catch (e) {
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    console.error('[qq] similar 失败:', e.message);
    return c.json({ code: 502, message: `QQ 相似歌曲获取失败: ${stripAbsolutePaths(e?.message || '未知错误')}` }, 502);
  }
});

// 歌单导入：disstid → 归一歌单元件（前端落成 local_pl_ 本地歌单——
// 与手动创建歌单同等待遇：mix 分享/服务端镜像下载全链复用）。
// matched 兼封面/词兜底；音频可播性由 /qq/stream 外源解锁腿承担——
// 词源匹配并发池与 bilibili favlist 同构：
// 总预算到点 abort，余曲 matched=null 照常下发可播可导
const QQ_PL_MATCH_BUDGET_MS = 45000;
const QQ_PL_MATCH_CONCURRENCY = 3;
app.get('/qq/playlist', async (c) => {
  if (!rateLimit(c, 'qq-playlist', 12)) {
    return c.json({ code: 429, message: '请求太频繁，稍后再试' }, 429);
  }
  const id = c.req.query('id') || '';
  if (!/^\d{1,15}$/.test(id)) return c.json({ code: 400, message: 'invalid disstid' }, 400);
  try {
    const pl = await getPlaylist(id, c.req.raw.signal);
    if (!pl) return c.json({ code: 404, message: '歌单不存在或无权限' }, 404);
    // 词源匹配并发池收敛进 services/netease-match.js:matchTracksPool——
    // 对 normalizeTrack 产物就地写 matched/matchedBy/matchScore；超 1000
    // 曲截断场景匹配照常跑（预算自控，掐断的余曲按无匹配下发）
    const matchedCount = await matchTracksPool(pl.tracks, {
      signal: c.req.raw.signal, budgetMs: QQ_PL_MATCH_BUDGET_MS,
      concurrency: QQ_PL_MATCH_CONCURRENCY, tag: 'qq-playlist',
      // 候选串/打分上下文与 /qq/resolve 同口径：艺人组合 → 裸名（≤3），
      // artists/trackId（qq_<mid> 接 song_match 缓存键）/发行日直喂
      candidatesOf: (t) => [...new Set(
        [`${t.artists.join(' ')} ${t.name}`.trim(), t.name]
          .filter(Boolean))].slice(0, 3),
      durationOf: (t) => t.intervalSec,
      infoOf: (t) => ({
        title: t.name, author: t.artists.join(' '), artists: t.artists,
        trackId: `qq_${t.mid}`, publishedAt: t.publishTime || 0,
      }),
      // 池级异常降级 matchedCount=0——词源匹配是增强不是门禁，
      // 不炸歌单导入本体（曲目照常下发，只是无回链弹药）
    }).catch(e => {
      console.warn('[qq] playlist 匹配池异常:', e?.message || e);
      return 0;
    });
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    return c.json({
      code: 200,
      ...pl,
      matchedCount,
      // trackJson 是共享白名单（search/resolve/similar/hot 同用）不动——
      // 匹配三字段只在 playlist 的投影里扩展
      tracks: pl.tracks.map((t) => ({
        ...trackJson(t),
        matched: toMatchedJson(t.matched),
        matchedBy: t.matchedBy ?? null,
        matchScore: t.matchScore ?? null,
      })),
      // 与 bili/yt 歌单同型契约——超上限截断必须透出，不然前端按完整列表渲染
      truncated: pl.truncated === true,
    });
  } catch (e) {
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    console.error('[qq] playlist 失败:', e.message);
    return c.json({ code: 502, message: `QQ 歌单获取失败: ${stripAbsolutePaths(e?.message || '未知错误')}` }, 502);
  }
});

module.exports = app;

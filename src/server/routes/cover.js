// qq_ 无专辑曲封面惰性解析：QQ 上游对无专辑单曲（如同人曲 EMA 系）回
// album/albummid/cover 全空——客户端 buildQQSong 的 al.picUrl 三条腿
// （cover/matched.al.picUrl/艺人重合闸）全灭落占位图。本端点按轨道 id
// 惰性补封面（客户端歌单库加载后逐曲打一次）：
//   GET /cover?id=<trackId>[&ne=<neteaseId>]
//                          —— id 只收 qq_<mid>（其余 id 无上游可解，400）
//   1) getSongDetail 有 albummid → y.gtimg.cn T002R300 直构回发
//      （专辑曲防御支——构建期封面腿已活的曲不会再进本端点，
//        进来的是「构建期详情缺 albummid」的存量/漂移个案）
//   2) 网易词源绑定腿（机会腿）：?ne= hint（客户端曲对象自带
//      neteaseId）/song_match 正向行给出 netease_id → song_detail
//      专辑官封——绑定是「同作品」权威证据（导入期歌词匹配产物，
//      只消费封面元数据不涉音频语义），官封比外源缩略图可靠；
//      生效否决集内的 id 不问（判过非同作品的封面也不该贴）。
//      单候选失败续打下一候选、整腿降级不连坐 3) 兜底
//   3) 无专辑 → yt/bv 手动挑选池合流，pickTitleDurationMatch 双闸
//     （标题含歌名+±10s）选定——防植物视频/无关内容缩略图当封面；
//      命中候选的 cover 再过 IMG_PROXY_HOSTS 白名单（客户端
//      proxiedCoverUrl 只代理名单内图床，非名单域放出去必裂图——
//      fail-closed 归 null 比发裂链诚实）
//   4) 10min 进程 memo 正/负都记——负结果不固化会每次歌单渲染都重打
//      上游扇出；瞬断 502 不缓存（上游抖动不该被钉 10min）
// 首段 '/cover' 登记在 lib/api-path.js PREFIXES——不登记会被 authGate 判成
// 非 API 公开 GET（未鉴权白打上游扇出）且未命中子路径吃 SPA index.html
// 而非 JSON 404（unlock-manual.js 头注同款登记义务）
const { Hono } = require('hono');
const { rateLimit } = require('../lib/rate-limit');
const { stripAbsolutePaths } = require('../lib/sanitize');
const { createTtlCache } = require('../lib/stream-resolve-cache');
const { getSongDetail } = require('../lib/qq');
const { PROVIDERS } = require('../services/unlock');
const { pickTitleDurationMatch } = require('../services/unlock/match');
// 网易绑定腿两件套：song_match 直读绑定行/生效否决集 + song_detail 官封上游
const { getMatchRow, getVetoedIds } = require('../repositories/songMatch');
const { callNeteaseApi } = require('../services/netease-api');
const { QQ_SONG_ID_RE, NETEASE_ID_BOUNDED_RE } = require('../../shared/predicates.js'); // CJS require(ESM)
// 封面白名单与 img-proxy 回源闸/客户端 proxiedCoverUrl 同一张表——
// 本端点发出的 cover 必然走 /img-proxy 回源，非名单域在这里掐死
const { isImgProxyHost } = require('../../shared/img-proxy-hosts.js'); // CJS require(ESM)

const app = new Hono();

// 手动挑选池扇出集——与 unlock-manual 的 CANDIDATE_SOURCES 同口径（只挑
// 搜索型源；pyncmd 是零错配官方直解无候选面）。封面解析不消费音频语义，
// 独立成表不借 QQ_UNLOCK_SOURCES——键名撞了语义不同，改源序时两边互伤
const COVER_SOURCES = ['youtube', 'bilibili'];
const coverMemo = createTtlCache({ max: 256, ttlMs: 10 * 60_000 });

// cover 出闸：http(s) 绝对链 + 图床白名单域 + 无凭据/非标端口——fail-closed。
// 候选 cover 是上游字段（yt mqdefault 推导、 bv 归一 pic），名单外域
// （含畸形 URL）一律归 null——「无封面」好过「发个裂图/越权回源链」。
// port/userinfo 判据与客户端 proxiedCoverUrl（song.js）镜像：客户端判死的
// 形态这里放行会产「非空但永不渲染」的毒化 picUrl（heal 收口径也不再重问）
const okCover = (u) => {
  if (typeof u !== 'string' || !/^https?:\/\//i.test(u)) return false;
  try {
    const parsed = new URL(u);
    return !parsed.port && !parsed.username && !parsed.password
      && isImgProxyHost(parsed.hostname);
  } catch { return false; }
};

app.get('/cover', async (c) => {
  // 上游扇出端点（detail + 双源检索）——与 /qq/resolve 同档桶；
  // memo 挡的是同曲重打，限流挡的是异曲扫库
  if (!rateLimit(c, 'cover-resolve', 12)) {
    return c.json({ code: 429, message: '请求太频繁，稍后再试' }, 429);
  }
  const m = String(c.req.query('id') || '').trim().match(QQ_SONG_ID_RE);
  if (!m) {
    return c.json({ code: 400, message: '封面惰性解析只支持 qq_<mid> 曲目 id' }, 400);
  }
  const mid = m[1];
  const cached = coverMemo.get(mid);
  if (cached) return c.json(cached);
  // 终态回包统一走 done——正（cover 串）/负（null）同键 memo；
  // 非终态（502/499）不落 memo，下轮照常重试。
  // album 非空串才随包附键——官封/直构伴随的专辑名供客户端同补
  // 「未知专辑」展示；负包与无名专不落键（键在有义）
  const done = (cover, album = '') => {
    const body = { code: 200, cover };
    if (typeof album === 'string' && album) body.album = album;
    coverMemo.set(mid, body);
    return c.json(body);
  };
  try {
    const t = await getSongDetail(mid, c.req.raw.signal, 'mid');
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    // 专辑曲防御支：albummid 在手直构——不走外源挑选池（上游自家图床
    // 比第三方缩略图权威；构造形态与 lib/qq.js normalizeTrack 同款）。
    // t.album 名有 albummid 时大概率在场，顺带随包供客户端补 al.name
    if (t?.albummid) {
      return done(`https://y.gtimg.cn/music/photo_new/T002R300x300M000${t.albummid}.jpg`, t.album);
    }
    // 网易词源绑定腿（机会腿，位在 name/时长免扇出闸之前：id 直查
    // 不依赖检索词，QQ 元数据稀薄的绑定曲不该被闸错杀）：候选按序
    // 为 ?ne= hint → song_match 正向行——绑定是「同作品」权威证据，
    // 官封比外源缩略图可靠。任一环节失败只降级本腿——网易云挂/库读
    // 坏不连坐下方 yt/bv 兜底
    try {
      const trackId = `qq_${mid}`;
      const neIds = [];
      // ne 查询参：客户端自有绑定 hint（曲对象 neteaseId 缺席——如
      // 镜像行——时下方 song_match 行仍兜）。数值形态校验，非法静默
      // 丢不 400——hint 是增强不是契约
      const hinted = String(c.req.query('ne') || '').trim();
      if (NETEASE_ID_BOUNDED_RE.test(hinted)) neIds.push(hinted);
      // getMatchRow 直读（非 getMatch）：无 freshness/模型键闸——
      // 绑定存在即「同作品」证据，封面语义不受负行 TTL/换模作废约束
      const bound = getMatchRow(trackId)?.netease_id;
      if (bound != null) neIds.push(String(bound));
      // 生效否决集（默认 '' 模型=永生效条目）：判过非同作品的 id
      // 其封面也不该贴——hint 与库行同口径排除
      const vetoed = getVetoedIds(trackId);
      for (const neId of new Set(neIds)) {
        if (vetoed.has(neId)) continue;
        try {
          const res = await callNeteaseApi('song_detail', { ids: neId },
            { signal: c.req.raw.signal });
          const al = res?.body?.songs?.[0]?.al;
          // picUrl 与候选池同走 okCover 白名单闸（p*.music.126.net 在册）；
          // al.name 随包——客户端顺带愈「未知专辑」
          if (al && okCover(al.picUrl)) return done(al.picUrl, al.name);
        } catch { /* 单候选失败（上游错/超时）续打下一候选 */ }
      }
    } catch { /* 候选装配/库读失败——降级本腿照常走外源兜底 */ }
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    // name/时长缺一即负 memo 终态免扇出——pickTitleDurationMatch 双闸
    //（标题含歌名+±10s，name 空白同判否）必否，放上行是稳定白打一跳
    if (!String(t?.name || '').trim() || !(t?.intervalSec > 0)) return done(null);
    // 检索词派生：name - 首艺人（[canonical KWFORM] 同族，截到首艺人——
    // 同人曲多 artist 串稀释检索相关性）
    const keyword = [t.name, (t.artists || [])[0]].filter(Boolean).join(' - ');
    // 两源并发扇出 + 故障隔离：单源失败不翻整池，双灭才 502
    // （unlock/candidates 同口径——封面是增强面，一颗源死了另一颗照常）
    const settled = await Promise.allSettled(COVER_SOURCES.map(
      s => PROVIDERS[s].search(keyword, { signal: c.req.raw.signal })));
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    const pool = [];
    let failures = 0;
    settled.forEach((r) => {
      if (r.status === 'fulfilled') pool.push(...(r.value || []));
      else failures++;
    });
    if (failures === COVER_SOURCES.length) {
      return c.json({ code: 502, message: '媒体源检索失败' }, 502);
    }
    // 标题含歌名 + ±10s 双闸（AI 全否兜底同款选定器——封面语境不引
    // AI 仲裁，确定性闸一步到位；不命中=无可信封面，宁 null 不错贴）
    const cand = pickTitleDurationMatch(pool, {
      name: t.name, durationMs: t.intervalSec * 1000,
    });
    return done(cand && okCover(cand.cover) ? cand.cover : null);
  } catch (e) {
    if (e?.aborted || c.req.raw.signal?.aborted) return c.body(null, 499);
    console.error('[cover] 解析失败:', e?.message || e);
    return c.json({ code: 502, message: `封面解析失败: ${stripAbsolutePaths(e?.message || '未知错误')}` }, 502);
  }
});

module.exports = app;

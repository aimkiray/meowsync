// 手选媒体源绑定路由（「换源」的服务端半侧）——自动解锁链是「系统
// 判官」，错配/败亡时用户是终审。id 收网易数值曲目 id（解锁链手动步
// 消费）或 qq_/bv_/yt_ 自有源轨道 id（自有源流端点失败触发步+下载
// 手动腿消费——canonManualTrackId 闸后归一入键）：
//   GET    /unlock/candidates?id=<轨道id>&keyword=<可选>
//     youtube/bilibili 两源并发扇出手动挑选池——单源失败进 errors 随包
//     下发、他源照常（故障隔离），双灭 502；keyword 缺席时数值 id 走
//     song_detail + baseUnlockInfo 兜底派生并回显实际用掉的词（客户端
//     首载恒显式传派生词，本兜底只服务直调 API——零多一跳）；外源 id
//     无 detail 兜底源，缺词直接 400
//   GET    /unlock/resolve-media?input=<B站链接或ID≤500>
//     SourcePicker 直绑行的只读远端解析：av 号/BV 号/b23.tv·bili2233.cn
//     短链（含「标题+链接」包裹分享文本）/bilibili.com 链接 → 谓词收单
//     → resolveBiliLink 逐跳白名单跳解 → view 存在性校验+展示快照 →
//     {code:200, source:'bilibili', mediaId(净形BV), title, owner,
//     durationSec} 喂既有 POST /unlock/manual（契约零改动）。
//     错误分诊 kind 七值：invalid(400 谓词拒)/favlist(400 附 favlist 字段)
//     /live/bangumi/other(400)/unresolved(404 跳解不出)/gone(404 view
//     确定性码 -400/-403/-404)；BV 净形在手 view 瞬态失败 → degraded
//     200 放行（POST resolveById 再验存在性，resolve 不谎报），aid 形
//     无规范 BV 可降 → 502。12/min；30s 端级预算级联进跳解/view；
//     60s TTL 只存已分类终态（degraded/unresolved/502/429 不缓存）
//   GET    /unlock/manual?id=<轨道id>
//     当前手选绑定：{code:200, hit:{source,mediaId,title,owner,
//     durationSec,updatedAt}}；未绑 404
//   POST   /unlock/manual {id, source, mediaId, title?, owner?, durationSec?}
//     点名绑定：先 resolveById 真取流验证（30s 子预算+请求 signal 合流）
//     通过才落库——「绑定即承诺此刻可取流」；只存指针不存回链
//     （googlevideo/bilivideo 签名链是易失品，落库即死链）；落库后
//     forgetSongUnlock 清 60s 解锁缓存/判定簿 + forgetManualStream 清
//     手动流正/负档让下次播放吃到新绑定
//   DELETE /unlock/manual?id=<轨道id>
//     解绑：幂等 200（没绑过也回 200——「目标状态=无绑定」已达成）+
//     forgetSongUnlock/forgetManualStream（恢复自动链要清掉绑定期产物）
// /unlock 首段登记见 lib/api-path.js PREFIXES + lib/protected-write.js
// PROTECTED_WRITE_PREFIXES——两处缺一即整条路由静默失守（authGate API
// 语义 + SPA JSON 404 + DOWNLOAD_TOKEN 写闸）
const { Hono } = require('hono');
const { rateLimit } = require('../lib/rate-limit');
const { csrfOriginOk } = require('../lib/auth-gate');
const { parseJsonBody } = require('../lib/validate');
const { fail } = require('../lib/http-error');
const { stripAbsolutePaths } = require('../lib/sanitize');
const unlockManualRepo = require('../repositories/unlockManual');
const { PROVIDERS } = require('../services/unlock');
// 路由 require netease-api（候选兜底派生+forgetSongUnlock）；netease-api
// 顶层 require 的是 repositories/unlockManual 不回指路由——无真环
const {
  callNeteaseApi, baseUnlockInfo, forgetSongUnlock,
} = require('../services/netease-api');
const { unlockManualPickBody } = require('../../shared/contracts.js');
const {
  NETEASE_ID_BOUNDED_RE, YT_ID_RE, BVID_RE,
  QQ_SONG_ID_RE, BV_TRACK_ID_RE, YT_TRACK_ID_RE,
  isBiliDirectBindInput,
} = require('../../shared/predicates.js');
const { forgetManualStream } = require('../services/unlock/manual-stream');
// 直绑行远端解析的上游原语：resolveBiliLink 逐跳白名单跳解（SSRF 防线
// 全在 lib 侧）+ biliFetch/viewQuery 查 view 存在性与展示快照
const { resolveBiliLink, biliFetch, viewQuery } = require('../lib/bilibili');
const { createTtlCache } = require('../lib/stream-resolve-cache');

const app = new Hono();

// 轨道 id 闸+归一：网易数值曲照旧去前导零（'000123'→'123'，原理由不动——
// 落库键与 resolveOne 消费键 String(item.id) 不一致=僵尸绑定）；
// 前缀轨道 id 按各自 RE 收，bv_ 段 canonicalize 成 BV 大写头——
// BV_TRACK_ID_RE 是 /i 宽形，'BV_xxx'/'bv_bv...' 非规范形经直调 API 可过闸，
// 落库键与播放链 song.id/下载链 task.songId/端点轨道键的规范形错一字节=
// 永不消费的僵尸绑定（与数值支 normSongId 同一防死道理；客户端 sp-direct
// 行 bv.replace(/^bv/i,'BV') 同法先例）。qq_/yt_ RE 无 /i，原样即规范形。
// file_/mix_/ext_ 词源命名空间不收（同型撞名区见 predicates L37-61）——
// 返 null=非法形态；必须在过闸后调，Number('')=0 会洗出假 '0'
const canonManualTrackId = (id) => {
  const s = String(id ?? '').trim();
  if (NETEASE_ID_BOUNDED_RE.test(s)) return String(Number(s));
  const bvM = s.match(BV_TRACK_ID_RE);
  if (bvM) {
    // _p 尾段同归一：/bilibili/stream 只在 pageWanted>1 时产 _pN 轨道键
    //（?p=0/1→裸 bv_X、?p=03→_p3；与 buildBilibiliSong id 编码及端点
    // trackKey 同构公式）。_p0/_p1/_p01 原样落库=端点永不命中的僵尸
    // 绑定族；parseInt 一并收掉 RE /i 放行的大写 '_P03' 与前导零
    const p = bvM[2] ? parseInt(bvM[2], 10) : 0;
    return `bv_${'BV' + bvM[1].slice(2)}${p > 1 ? `_p${p}` : ''}`;
  }
  if (QQ_SONG_ID_RE.test(s) || YT_TRACK_ID_RE.test(s)) return s;
  return null;
};
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
// mediaId 严校（SSRF 口径）：服务端永不接 URL 串——b23.tv/bili2233.cn
// 短链与 av 号经 GET /unlock/resolve-media 远端解析归一成净形 BV 后
// 进本面；只收源私有 id 净形
const MEDIA_ID_RES = { youtube: YT_ID_RE, bilibili: BVID_RE };
const mediaIdOk = (source, mediaId) => !!MEDIA_ID_RES[source]?.test(mediaId);
// BVID 净形归一：BVID_RE 是 /i 宽形，小写 'bv…'/'bV…' 输入按规范大写头
// 回写——POST 闸/落库键/resolveById 全链吃同一规范形，拒收非 BV1 形
const canonBvid = (v) => (typeof v === 'string' && BVID_RE.test(v) ? `BV${v.slice(2)}` : null);
// 候选源扇出表——与 PROVIDERS 键同名（「手动挑选池」只对搜索型源有意义，
// pyncmd 是零错配官方直解无候选面）
const CANDIDATE_SOURCES = ['youtube', 'bilibili'];

// GET /unlock/candidates —— 手动挑选池。未鉴权即直连上游扇出（两源）——
// 限流防把服务端 IP 刷进上游风控（桶档同 lyric-cand 五路宽检口径）
app.get('/unlock/candidates', async (c) => {
  if (!rateLimit(c, 'unlock-cand', 20)) {
    return c.json({ code: 429, message: '请求太频繁，稍后再试' }, 429);
  }
  const id = canonManualTrackId(c.req.query('id'));
  if (!id) {
    return c.json({ code: 400, message: '非法 id' }, 400);
  }
  // 检索词上限与 /youtube/search q≤200 同口径
  let keyword = str(c.req.query('keyword'), 200);
  try {
    // keyword 缺席时兜底派生：song_detail + baseUnlockInfo——[canonical
    // KWFORM]「name - artists.join(' / ')」同一公式源，不复制不引 AI 规整
    //（交互端点要确定性+零 AI 尾延迟；客户端镜像派生恒传词，本支路只
    // 服务直调 API）
    if (!keyword) {
      if (!NETEASE_ID_BOUNDED_RE.test(id)) {
        // 外源曲没有 song_detail 兜底源（detail 只认网易数值 id）——确定性
        // 拒绝不为注定空回的派生支路白烧一跳上游；客户端首载恒显式传派生
        // 词，本分支只服务直调 API。400 是输入缺陷的诚实归类——
        // 502 会把「入参缺欠」谎报成「上游故障」
        return c.json({ code: 400, message: '外源曲目须显式携带检索关键词（该曲形态无 song_detail 兜底源）' }, 400);
      }
      let row = null;
      try {
        const detail = await callNeteaseApi('song_detail', { ids: id },
          { signal: c.req.raw.signal });
        row = (detail.body?.songs || [])[0] || null;
      } catch (e) {
        if (e?.aborted || c.req.raw.signal?.aborted) return c.body(null, 499);
        row = null;
      }
      keyword = row ? (baseUnlockInfo(row)?.keyword || '') : '';
      if (!keyword) {
        return c.json({ code: 502, message: '曲目详情获取失败' }, 502);
      }
    }
    // 并发扇出+故障隔离：单源失败记 errors 随包下发（前端横幅「部分源
    // 检索失败」）不翻整池；双源全灭才 502
    const settled = await Promise.allSettled(CANDIDATE_SOURCES.map(
      s => PROVIDERS[s].search(keyword, { signal: c.req.raw.signal })));
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    const candidates = [];
    const errors = [];
    settled.forEach((r, i) => {
      const source = CANDIDATE_SOURCES[i];
      if (r.status === 'fulfilled') {
        // 源组序下发（youtube 块→bilibili 块）——时长贴近排序在客户端做
        // （服务端不收 duration 参数、不掺展示态）；mediaId 是客户端面
        // 统一键名（provider 内仍叫 videoId）
        for (const cand of (r.value || [])) {
          candidates.push({
            source,
            mediaId: cand.videoId,
            title: String(cand.title || ''),
            owner: String(cand.owner || ''),
            durationSec: Number.isFinite(cand.durationSec) ? cand.durationSec : null,
            // cover 为 https 绝对形（yt 由 videoId 推导、bv 取归一 pic）——
            // 封面链路两端各自守口（客户端 proxiedCoverUrl 走 /img-proxy）
            cover: typeof cand.cover === 'string' ? cand.cover : '',
            ...(cand.publishedTimeText ? { publishedTimeText: String(cand.publishedTimeText) } : {}),
            ...(cand.channelId ? { channelId: String(cand.channelId) } : {}),
          });
        }
      } else {
        const msg = String(r.reason?.message || r.reason || '检索失败')
          .replace(/[\r\n]+/g, ' ');
        console.warn(`[unlock-manual] 候选检索失败 ${source}: ${msg}`);
        errors.push({ source, msg });
      }
    });
    if (errors.length === CANDIDATE_SOURCES.length) {
      return c.json({ code: 502, message: '媒体源检索失败' }, 502);
    }
    // 回显实际用掉的词——前端「恢复默认」判定与预填都吃它；
    // errors 仅单源失败时在场
    return c.json({ code: 200, keyword, candidates, ...(errors.length ? { errors } : {}) });
  } catch (e) {
    // abort 归一双查同 lyric-manual：错误携带 aborted 标记或请求自身
    // 已断连都归一成 499
    if (e?.aborted || c.req.raw.signal?.aborted) return c.body(null, 499);
    console.error('[unlock-manual] 候选池查询失败:', e?.message || e);
    return c.json({ code: 502, message: '媒体源候选查询失败' }, 502);
  }
});

// GET /unlock/resolve-media?input= —— 直绑行只读远端解析（契约见头注）。
// 未鉴权即直连上游（跳解+view）——限流防把服务端 IP 刷进上游风控；
// 30s 端级预算与请求 signal 合流，级联进 resolveBiliLink（每跳再叠 10s
// 闸）与 biliFetch（再叠 15s 闸）。60s TTL 只存已分类终态——瞬态失败
// 重试必须真打新一跳
const resolveMediaCache = createTtlCache({ max: 128, ttlMs: 60_000 });
app.get('/unlock/resolve-media', async (c) => {
  if (!rateLimit(c, 'unlock-resolve', 12)) {
    return c.json({ code: 429, message: '请求太频繁，稍后再试' }, 429);
  }
  const input = str(c.req.query('input'), 500);
  // 谓词收单：非 B 站形态/语境一律 invalid——错绑比拒绑代价大
  if (!isBiliDirectBindInput(input)) {
    return c.json({ code: 400, kind: 'invalid', message: '输入不是支持的 B 站链接或 ID' }, 400);
  }
  const cached = resolveMediaCache.get(input);
  if (cached) return c.json(cached.body, cached.status);
  const done = (status, body, cacheable) => {
    if (cacheable) resolveMediaCache.set(input, { status, body });
    return c.json(body, status);
  };
  // 端级 30s 预算与客户端断联合流——客户端断开/预算耗尽都不留僵尸上游
  const sig = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30000)]);
  try {
    // 输入分诊：净形直查 view（零跳解）；其余过 resolveBiliLink 按
    // kind 分诊——favlist/live/bangumi/other/null 各归各位
    let id = null;
    if (BVID_RE.test(input)) {
      id = canonBvid(input);
    } else if (/^av\d+$/i.test(input)) {
      // safe-integer+正值闸：av+16 位以上 Number 丢精度会让 view 解出另一支
      // 视频——错绑比拒绑代价大；av0/av00 是非法稿件号，出站前拒不白烧
      // 一跳 view，也不把「aid=0 gone」钉进 60s 缓存
      const aid = Number(input.slice(2));
      if (!Number.isSafeInteger(aid) || aid <= 0) {
        return c.json({ code: 400, kind: 'invalid', message: '输入不是支持的 B 站链接或 ID' }, 400);
      }
      id = { aid };
    } else {
      const link = await resolveBiliLink(input, sig);
      if (!link) {
        return c.json({ code: 404, kind: 'unresolved', message: '无法解析该链接（短链失效或重定向链中断）' }, 404);
      }
      if (link.kind === 'favlist') {
        // favlist 字段与 /bilibili/resolve 同构——前端可转歌单导入
        return done(400, { code: 400, kind: 'favlist', message: '这是收藏夹链接，请到顶部搜索框粘贴导入', favlist: link.fid }, true);
      }
      if (link.kind === 'live') {
        return done(400, { code: 400, kind: 'live', message: '直播间链接不支持绑定媒体源' }, true);
      }
      if (link.kind === 'bangumi') {
        return done(400, { code: 400, kind: 'bangumi', message: '番剧链接不支持绑定媒体源' }, true);
      }
      if (link.kind === 'other') {
        return done(400, { code: 400, kind: 'other', message: '链接指向的内容不支持绑定为媒体源' }, true);
      }
      if (link.kind === 'video') id = link.id;
      if (!id) {
        return c.json({ code: 404, kind: 'unresolved', message: '无法解析该链接（短链失效或重定向链中断）' }, 404);
      }
    }
    // 跳解产出的 bvid 可能带小写头（href 大小写原样带出）——调 view 前
    // 归一到规范形，与直输 bv 支同一判决（degraded/媒体键也都吃规范形）；
    // {aid} 对象形 canonBvid 返 null 原样放行
    id = canonBvid(id) || id;
    // view 存在性校验+展示快照：mediaId 恒回 view.bvid 规范形——aid 输入
    // 经 view 换取规范 BV；view.bvid 缺席防御支回 BV+净形（仅 bvid 形 id
    // 有净形可回，aid 形拿不到规范 BV 属上游异常 → 502）
    let view;
    try {
      view = await biliFetch(`/x/web-interface/view?${viewQuery(id)}`, sig);
    } catch (e) {
      if (e?.aborted || c.req.raw.signal?.aborted) return c.body(null, 499);
      // 确定性业务码（/bilibili/favlist 同款码表）——稿件不存在/不可见
      const code = Number(e?.message?.match(/code=(-?\d+)/)?.[1]);
      if ([-400, -403, -404].includes(code)) {
        return done(404, { code: 404, kind: 'gone', message: '该视频不存在或已失效' }, true);
      }
      // 瞬态失败：净形 BV 在手降级放行——POST resolveById 会再验存在性，
      // resolve 不替它谎报；aid 形无规范 BV 可降，按瞬态 → 502
      const bv = canonBvid(id);
      if (bv) {
        return c.json({ code: 200, source: 'bilibili', mediaId: bv, degraded: true });
      }
      throw e;
    }
    const mediaId = canonBvid(view?.bvid) || canonBvid(id);
    if (!mediaId) {
      return c.json({ code: 502, message: 'B 站解析失败：view 响应缺 bvid' }, 502);
    }
    // 快照按 POST schema 上限预整形：title/owner 走 str() 截 300/200；
    // durationSec 条件挂键判舍入后值——schema 是 optional（只容缺席不容
    // null）且 positive().max(7200)：0<d<0.5 四舍五入出 0 注定被 400 拒，
    // 发注定被拒的值不如「无快照时长」透传（resolve 200 → POST 必 400 是
    // 把成功解析变成必然失败的死链）；7200.x 舍入回 7200 内的照常挂键
    const durationSec = Number.isFinite(view?.duration) ? Math.round(view.duration) : 0;
    return done(200, {
      code: 200, source: 'bilibili', mediaId,
      title: str(view?.title, 300),
      owner: str(view?.owner?.name, 200),
      ...(durationSec > 0 && durationSec <= 7200 ? { durationSec } : {}),
    }, true);
  } catch (e) {
    if (e?.aborted || c.req.raw.signal?.aborted) return c.body(null, 499);
    // 回显先过 stripAbsolutePaths（routes/bilibili 同款回显全过的本端点
    // 家族唯一缺位对齐）再截 120——先剥后截，截断不会把半条路径留在包里
    const msg = stripAbsolutePaths(
      String(e?.message || e || '未知错误').replace(/[\r\n]+/g, ' ')
    ).slice(0, 120);
    console.error(`[unlock-manual] resolve-media 失败: ${msg}`);
    return c.json({ code: 502, message: `B 站解析失败：${msg}` }, 502);
  }
});

// GET /unlock/manual?id= —— 当前手选绑定；未绑 404
app.get('/unlock/manual', (c) => {
  if (!rateLimit(c, 'unlock-manual', 30)) {
    return c.json({ code: 429, message: '请求太频繁' }, 429);
  }
  const id = canonManualTrackId(c.req.query('id'));
  if (!id) {
    return c.json({ code: 400, message: '非法 songId' }, 400);
  }
  const hit = unlockManualRepo.getManual(id);
  if (!hit) return c.json({ code: 404, message: '未绑定手选媒体源' }, 404);
  return c.json({ code: 200, hit });
});

// POST /unlock/manual {id, source, mediaId, title?, owner?, durationSec?}
// —— 点名绑定（先验证后落库：「绑定即承诺此刻可取流」）
app.post('/unlock/manual', async (c) => {
  // 写请求 CSRF 纵深（lyric-manual 同口径）：session 写经 authGate 查过，
  // 但 DOWNLOAD_TOKEN 旁路/开放部署不经那一道——无登录态下跨站 POST
  // 也能打上游取流+写库
  if (!csrfOriginOk(c)) return fail(c, 403, 'Forbidden');
  // 写端点独立桶更紧：pick 要发上游取流验证一跳+写库，GET 读流量不占写配额
  if (!rateLimit(c, 'unlock-manual:write', 15)) {
    return c.json({ code: 429, message: '请求太频繁' }, 429);
  }
  const { data: body, error } = await parseJsonBody(c, unlockManualPickBody, 16 * 1024);
  if (error) return error;
  const id = canonManualTrackId(body.id);
  const source = String(body.source ?? '').trim();
  const mediaId = String(body.mediaId ?? '').trim();
  if (!id) return c.json({ code: 400, message: '非法 songId' }, 400);
  // source 枚举已被 schema 收窄到 youtube/bilibili；再断言 provider 真
  // 具备 resolveById 能力（能力面未部署的源不许绑）
  const provider = PROVIDERS[source];
  if (!provider?.resolveById) {
    return c.json({ code: 400, message: '该源不支持手动绑定' }, 400);
  }
  if (!mediaIdOk(source, mediaId)) {
    return c.json({ code: 400, message: '非法 mediaId' }, 400);
  }
  try {
    // 先验证后落库：resolveById 真取流——30s 子预算与请求 signal 合流
    // （客户端断连即弃验）。验流产物（签名 url/urls/br）用完即弃——
    // 指针表永不存回链。purpose=playback 验流即可覆盖 download 共享
    // 语义：同一 mediaId 两用途只是选档偏好不同，playback 能解出的流
    // download 必能
    const proof = await provider.resolveById(mediaId, {
      purpose: 'playback',
      signal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30000)]),
    });
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    if (!proof || !proof.url) {
      return c.json({ code: 404, message: '该媒体源已失效或不可播' }, 404);
    }
    unlockManualRepo.upsertManual(id, {
      source,
      mediaId,
      title: str(body.title, 300),
      owner: str(body.owner, 200),
      durationSec: Number.isFinite(body.durationSec) && body.durationSec > 0
        ? Math.round(body.durationSec) : null,
    });
    // 60s unlockCache/verdict 簿里的错配产物不清，绑定写了也读到旧链——
    // 调在 upsert 成功之后（绑定落库才该清负状态）；forgetManualStream
    // 收手动流缓存的正/负档（同媒体重绑撞旧负档是键带绑定身份的唯一洞），
    // 外源曲「刚绑完立刻听到绑的」靠它即时生效。前缀 id 调入
    // forgetSongUnlock 是安全空调用（键尾段 `|<id>` 天然全不命中）照旧保门面
    forgetSongUnlock(id);
    forgetManualStream(id);
    // 回权威行（含 updatedAt）——绑定时刻展示快照已按 str() 截断落库
    return c.json({ code: 200, hit: unlockManualRepo.getManual(id) });
  } catch (e) {
    if (e?.aborted || c.req.raw.signal?.aborted) return c.body(null, 499);
    // 凭据级证据（风控墙/会员墙）单独成消息——与编排层 authwall 归类
    // 同语义，500 系而非入参错
    if (e?.authRejected) {
      return c.json({ code: 502, message: '源站凭据被拒（风控）' }, 502);
    }
    console.error('[unlock-manual] 媒体源验证失败:', e?.message || e);
    return c.json({ code: 502, message: '媒体源验证失败' }, 502);
  }
});

// DELETE /unlock/manual?id= —— 解绑；幂等 200
app.delete('/unlock/manual', (c) => {
  if (!csrfOriginOk(c)) return fail(c, 403, 'Forbidden');
  if (!rateLimit(c, 'unlock-manual:write', 15)) {
    return c.json({ code: 429, message: '请求太频繁' }, 429);
  }
  const id = canonManualTrackId(c.req.query('id'));
  if (!id) return c.json({ code: 400, message: '非法 songId' }, 400);
  unlockManualRepo.deleteManual(id);
  // 恢复自动链必须清绑定期产物（unlockCache 里可能躺着手动步产出）；
  // 手动流缓存同点收（前缀 id 对 forgetSongUnlock 安全空转照旧）
  forgetSongUnlock(id);
  forgetManualStream(id);
  return c.json({ code: 200 });
});

module.exports = app;

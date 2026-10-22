// 手选媒体源绑定路由（「换源」的服务端半侧）——自动解锁链是「系统
// 判官」，错配时用户是终审：
//   GET    /unlock/candidates?id=<数字>&keyword=<可选>
//     youtube/bilibili 两源并发扇出手动挑选池——单源失败进 errors 随包
//     下发、他源照常（故障隔离），双灭 502；keyword 缺席走 song_detail +
//     baseUnlockInfo 兜底派生并回显实际用掉的词（客户端首载恒显式传
//     派生词，本兜底只服务直调 API——零多一跳）
//   GET    /unlock/manual?id=<数字>
//     当前手选绑定：{code:200, hit:{source,mediaId,title,owner,
//     durationSec,updatedAt}}；未绑 404
//   POST   /unlock/manual {id, source, mediaId, title?, owner?, durationSec?}
//     点名绑定：先 resolveById 真取流验证（30s 子预算+请求 signal 合流）
//     通过才落库——「绑定即承诺此刻可取流」；只存指针不存回链
//     （googlevideo/bilivideo 签名链是易失品，落库即死链）；落库后
//     forgetSongUnlock 清 60s 解锁缓存/判定簿让下次播放吃到新绑定
//   DELETE /unlock/manual?id=<数字>
//     解绑：幂等 200（没绑过也回 200——「目标状态=无绑定」已达成）+
//     forgetSongUnlock（恢复自动链要清掉绑定期产物）
// /unlock 首段登记见 lib/api-path.js PREFIXES + lib/protected-write.js
// PROTECTED_WRITE_PREFIXES——两处缺一即整条路由静默失守（authGate API
// 语义 + SPA JSON 404 + DOWNLOAD_TOKEN 写闸）
const { Hono } = require('hono');
const { rateLimit } = require('../lib/rate-limit');
const { csrfOriginOk } = require('../lib/auth-gate');
const { parseJsonBody } = require('../lib/validate');
const { fail } = require('../lib/http-error');
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
} = require('../../shared/predicates.js');

const app = new Hono();

// songId 形闸：手动绑定只对解锁链生效，而解锁链只服务网易数值曲——刻意
// 不复用 lyric-manual 的 SONG_ID_RES 宽集（bv_/yt_/qq_/file_ 曲走自有源
// 不进解锁链，收下=存了永不消费的僵尸绑定）
const songIdOk = (id) => NETEASE_ID_BOUNDED_RE.test(id);
// id 过闸后归一数值形（'000123'→'123'）：前导零形能过 \d{1,20} 闸，
// 但落库键 '000123' 与 resolveOne 消费键 String(item.id)='123' 不一致
// =存了永不消费的僵尸绑定。必须在 songIdOk 之后调——Number('')=0 会
// 把空 id 洗成过闸的 '0'。Number 舍入与消费端 JS number 同口径
const normSongId = (id) => String(Number(id));
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
// mediaId 严校（SSRF 口径）：服务端永不接 URL 串——粘贴解析全在客户端
// （b23.tv 短链/av 号不收：跳解需出站，本批不做）。只收源私有 id 净形
const MEDIA_ID_RES = { youtube: YT_ID_RE, bilibili: BVID_RE };
const mediaIdOk = (source, mediaId) => !!MEDIA_ID_RES[source]?.test(mediaId);
// 候选源扇出表——与 PROVIDERS 键同名（「手动挑选池」只对搜索型源有意义，
// pyncmd 是零错配官方直解无候选面）
const CANDIDATE_SOURCES = ['youtube', 'bilibili'];

// GET /unlock/candidates —— 手动挑选池。未鉴权即直连上游扇出（两源）——
// 限流防把服务端 IP 刷进上游风控（桶档同 lyric-cand 五路宽检口径）
app.get('/unlock/candidates', async (c) => {
  if (!rateLimit(c, 'unlock-cand', 20)) {
    return c.json({ code: 429, message: '请求太频繁，稍后再试' }, 429);
  }
  let id = String(c.req.query('id') || '').trim();
  if (!songIdOk(id)) {
    return c.json({ code: 400, message: '非法 id' }, 400);
  }
  id = normSongId(id);
  // 检索词上限与 /youtube/search q≤200 同口径
  let keyword = str(c.req.query('keyword'), 200);
  try {
    // keyword 缺席时兜底派生：song_detail + baseUnlockInfo——[canonical
    // KWFORM]「name - artists.join(' / ')」同一公式源，不复制不引 AI 规整
    //（交互端点要确定性+零 AI 尾延迟；客户端镜像派生恒传词，本支路只
    // 服务直调 API）
    if (!keyword) {
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

// GET /unlock/manual?id= —— 当前手选绑定；未绑 404
app.get('/unlock/manual', (c) => {
  if (!rateLimit(c, 'unlock-manual', 30)) {
    return c.json({ code: 429, message: '请求太频繁' }, 429);
  }
  let id = String(c.req.query('id') || '').trim();
  if (!songIdOk(id)) {
    return c.json({ code: 400, message: '非法 songId' }, 400);
  }
  id = normSongId(id);
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
  let id = String(body.id ?? '').trim();
  const source = String(body.source ?? '').trim();
  const mediaId = String(body.mediaId ?? '').trim();
  if (!songIdOk(id)) return c.json({ code: 400, message: '非法 songId' }, 400);
  id = normSongId(id);
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
    // 调在 upsert 成功之后（绑定落库才该清负状态）
    forgetSongUnlock(id);
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
  let id = String(c.req.query('id') || '').trim();
  if (!songIdOk(id)) return c.json({ code: 400, message: '非法 songId' }, 400);
  id = normSongId(id);
  unlockManualRepo.deleteManual(id);
  // 恢复自动链必须清绑定期产物（unlockCache 里可能躺着手动步产出）
  forgetSongUnlock(id);
  return c.json({ code: 200 });
});

module.exports = app;

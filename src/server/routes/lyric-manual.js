// 手选词源绑定路由（手动歌词匹配的服务端半侧）——级联是「系统判官」，
// 错配时用户是终审：
//   GET    /lyric/candidates?id=&title=&artist=&duration=
//     五路外源宽检候选池（services/lyric-external.searchLyricCandidates）：
//     无标题闸/艺人闸/时长硬滤——人眼终审要看全池，含刻意可挑的异时长版
//   GET    /lyric/manual?id=
//     当前手选绑定：{code:200, hit:{lrc,plain,source,extId,synced}}；
//     未绑 404（「没挑过」是正常状态，但走 404 语义让前端省一次形状判）
//   POST   /lyric/manual {id, extId, token?}
//     点名绑定：服务端按 extId 重取词文整行落库（词文必须落库——kugou_
//     词源 accesskey 不落 extId，无 refetch 通道，token 是 download 唯一
//     凭证；只存指针重读拿不出词）
//   DELETE /lyric/manual?id=
//     解绑：幂等 200（没绑过也回 200——「目标状态=无绑定」已达成）
// 与 /lyric/external 同挂 /lyric 首段下：首段 'lyric' 在 ALLOWED_APIS
// 白名单内，isApiPath 命中即拿到「API 语义」全家桶——authGate 按 API
// 鉴权、SPA 兜底不喂 HTML、未匹配落 JSON 404
const { Hono } = require('hono');
const { rateLimit } = require('../lib/rate-limit');
const { csrfOriginOk } = require('../lib/auth-gate');
const { parseJsonBody } = require('../lib/validate');
const { fail } = require('../lib/http-error');
const lyricManualRepo = require('../repositories/lyricManual');
const { searchLyricCandidates, fetchByExtId } = require('../services/lyric-external');
const { lyricManualPickBody } = require('../../shared/contracts.js');
const {
  NETEASE_ID_RE, FILE_TRACK_ID_RE, QQ_SONG_ID_RE,
  BV_TRACK_ID_RE, YT_TRACK_ID_RE, EXT_LYRIC_ID_STRICT_RE,
} = require('../../shared/predicates.js');

const app = new Hono();

// song_id 词归属键白名单：与 routes/songmeta.js 同一份谓词集——数字网易、
// file_ 上传、qq_/bv_/yt_ 轨道、外源词源 id（词属主键同样可手选绑词），
// 形态集合跟词源 id 族同步演进不散养
const SONG_ID_RES = [
  NETEASE_ID_RE, FILE_TRACK_ID_RE, QQ_SONG_ID_RE,
  BV_TRACK_ID_RE, YT_TRACK_ID_RE, EXT_LYRIC_ID_STRICT_RE,
];
const songIdOk = (id) => SONG_ID_RES.some(re => re.test(id));

// 落库词文体量闸（字符数）：pick 是「上游取啥存啥」的整存面——上游被劫/
// 畸形回包吐出超大载荷时，落库行与 GET 回包都得吞它（上游响应体 2MB
// 闸在 fetch 层，但单字段仍可逼近）。512K 字已远超真实歌词体量；超限
// 拒绝不截断——半截词比「取词失败」更误导（用户以为绑成却拿到残词）
const MANUAL_LYRIC_MAX_CHARS = 512 * 1024;

// GET /lyric/candidates —— 候选池检索。未鉴权即直连上游扇出——限流防把
// 服务端 IP 刷进上游风控（同 /lyric/external 口径，宽检五路扇出再收一档）
app.get('/lyric/candidates', async (c) => {
  if (!rateLimit(c, 'lyric-cand', 20)) {
    return c.json({ code: 429, message: '请求太频繁，稍后再试' }, 429);
  }
  // 入参闸与 /lyric/external 同口径：id 作缓存键成分与 yt_ videoId 抽取
  // 源（形态不收敛，服务层自行抽源私有定位）；title/artist 是检索词；
  // duration 非法/缺省归一 null 而非 400——「不声明时长」是合法检索面
  const id = String(c.req.query('id') || '').trim();
  if (id && !/^[\w-]{1,80}$/.test(id)) {
    return c.json({ code: 400, message: '非法 id' }, 400);
  }
  const title = String(c.req.query('title') || '').trim();
  const artist = String(c.req.query('artist') || '').trim();
  if (title.length > 300 || artist.length > 200) {
    return c.json({ code: 400, message: 'title/artist 超长' }, 400);
  }
  const dur = Number(c.req.query('duration'));
  const durationSec = Number.isFinite(dur) && dur > 0 && dur <= 7200 ? dur : null;
  // 无 id 又无检索词 = 无米下锅（yt_ 的 videoId 只从 id 里抽）
  if (!id && !title) {
    return c.json({ code: 400, message: '缺少 id 或 title' }, 400);
  }
  try {
    const candidates = await searchLyricCandidates({
      songId: id, title, artist, durationSec, signal: c.req.raw.signal,
    });
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    return c.json({ code: 200, candidates });
  } catch (e) {
    // abort 归一双查：错误携带 aborted 标记或请求自身已断连都归一成
    // 499——与 routes/lyric-external.js 同口径
    if (e?.aborted || c.req.raw.signal?.aborted) return c.body(null, 499);
    console.error('[lyric-manual] 候选池查询失败:', e?.message || e);
    return c.json({ code: 502, message: '外部歌词源查询失败' }, 502);
  }
});

// GET /lyric/manual?id= —— 当前手选绑定；未绑 404
app.get('/lyric/manual', (c) => {
  if (!rateLimit(c, 'lyric-manual', 30)) {
    return c.json({ code: 429, message: '请求太频繁' }, 429);
  }
  const id = String(c.req.query('id') || '').trim();
  if (!songIdOk(id)) {
    return c.json({ code: 400, message: '非法 songId' }, 400);
  }
  const hit = lyricManualRepo.getManual(id);
  if (!hit) return c.json({ code: 404, message: '未绑定手选词源' }, 404);
  return c.json({ code: 200, hit });
});

// POST /lyric/manual {id, extId, token?} —— 点名绑定
app.post('/lyric/manual', async (c) => {
  // 写请求 CSRF 纵深（与 songmeta/lyric-align 同口径）：session 写经
  // authGate 查过，但 DOWNLOAD_TOKEN 旁路/开放部署不经那一道——无登录
  // 态下跨站 POST 也能打上游取词+写库
  if (!csrfOriginOk(c)) return fail(c, 403, 'Forbidden');
  // 写端点独立桶更紧（songmeta:write 同口径）：pick 要发上游 download
  // +写库，GET 读流量不占写配额
  if (!rateLimit(c, 'lyric-manual:write', 15)) {
    return c.json({ code: 429, message: '请求太频繁' }, 429);
  }
  const { data: body, error } = await parseJsonBody(c, lyricManualPickBody, 16 * 1024);
  if (error) return error;
  const id = String(body.id ?? '').trim();
  const extId = String(body.extId ?? '').trim();
  if (!songIdOk(id)) return c.json({ code: 400, message: '非法 songId' }, 400);
  if (!EXT_LYRIC_ID_STRICT_RE.test(extId)) {
    return c.json({ code: 400, message: '非法 extId' }, 400);
  }
  try {
    // 服务端重取词文整存而非存指针：kugou_ 无 refetch 通道（accesskey
    // 不落 extId），token 透回走 download 直达；lrclib_/ytm_ 走既有
    // /api/get 与 YTM 支路；进程内 LRU 里级联刚产出的词先吃（免一跳）
    const hit = await fetchByExtId(extId, {
      signal: c.req.raw.signal,
      token: typeof body.token === 'string' ? body.token : undefined,
    });
    if (c.req.raw.signal?.aborted) return c.body(null, 499);
    if (!hit || !String(hit.lrc || '').trim()) {
      return c.json({ code: 404, message: '词源取词失败' }, 404);
    }
    // 体量闸先于落库——上游面脏载荷不固化进绑定表（502 与「词源侧
    // 产出不可用」同口径，不是客户端入参错）
    if (String(hit.lrc).length > MANUAL_LYRIC_MAX_CHARS
      || String(hit.plain || '').length > MANUAL_LYRIC_MAX_CHARS) {
      return c.json({ code: 502, message: '词源内容过大' }, 502);
    }
    const stored = {
      lrc: String(hit.lrc),
      plain: String(hit.plain || ''),
      source: String(hit.source || ''),
      extId: String(hit.extId || extId),
      synced: Boolean(hit.synced),
    };
    lyricManualRepo.upsertManual(id, stored);
    return c.json({ code: 200, hit: stored });
  } catch (e) {
    if (e?.aborted || c.req.raw.signal?.aborted) return c.body(null, 499);
    console.error('[lyric-manual] 取词绑定失败:', e?.message || e);
    return c.json({ code: 502, message: '词源取词失败' }, 502);
  }
});

// DELETE /lyric/manual?id= —— 解绑；幂等 200
app.delete('/lyric/manual', (c) => {
  if (!csrfOriginOk(c)) return fail(c, 403, 'Forbidden');
  if (!rateLimit(c, 'lyric-manual:write', 15)) {
    return c.json({ code: 429, message: '请求太频繁' }, 429);
  }
  const id = String(c.req.query('id') || '').trim();
  if (!songIdOk(id)) return c.json({ code: 400, message: '非法 songId' }, 400);
  lyricManualRepo.deleteManual(id);
  return c.json({ code: 200 });
});

module.exports = app;

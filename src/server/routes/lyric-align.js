const { Hono } = require('hono');
const path = require('path');
const { createHash } = require('crypto');
const { parseJsonBody } = require('../lib/validate');
const { lyricAlignBody } = require('../../shared/contracts.js');
const { fail } = require('../lib/http-error');
const { rateLimit } = require('../lib/rate-limit');
const { csrfOriginOk } = require('../lib/auth-gate');
const { alignAudioToLrc } = require('../services/lyric-align');
const { isUnderDownloadDir, pathPresent } = require('../services/download-fs');
const downloadTasksRepo = require('../repositories/downloadTasks');
const { parseLrcLines } = require('../services/lyric-verify');
const { callNeteaseApi } = require('../services/netease-api');
const {
  NETEASE_ID_BOUNDED_RE, QQ_SONG_ID_RE, FILE_TRACK_ID_RE,
} = require('../../shared/predicates.js');

const app = new Hono();

// 歌词行上限：与 ai.js 翻译上限同量级——超长多半是逐字滚动歌词拆分，
// 整单对齐既不经济也无必要；songId 拉词源路径超限时截断（不全单拒掉）
const MAX_ALIGN_LINES = 600;
// 同 (音频,行集) 在途去重：并发重复提交共享首个对齐结果而非再烧一遍
// ffmpeg+AI（与 routes/ai.js 的 inflight 门同思路；值直接载 payload——
// 对齐结果不落库，无「重查缓存」可等）
const inflightAlign = new Map();

// songId → 盘上音频工件：跨歌单扫描（下载按 (playlist,song) 分行登记，
// 播放入口不总带歌单上下文——与 getSongDownloadStatus 的跨单口径一致）。
// 只认 completed 且文件真在盘上的行；file_ 上传曲允许 videoPath 兜底
// （video-only 上传没有音频工件，mp4/webm 音轨 ffmpeg 照解——
// getTaskArtifactPath 同口径）
function resolveDownloadedAudio(songId) {
  for (const t of downloadTasksRepo.listTasksBySongId(songId)) {
    if (t.status !== 'completed') continue;
    const cand = t.audioPath || (FILE_TRACK_ID_RE.test(t.songId) ? t.videoPath : null);
    if (cand && isUnderDownloadDir(cand) && pathPresent(cand)) return cand;
  }
  return null;
}

// songId → 歌词行文本：网易云/QQ 才有自家词源可拉（与 routes/ai.js 的
// fetchLyricRaw 同口径：qq 业务码无词归一成空、传输层错误上抛）。
// 外部 id（bv_/yt_/file_）返回 null——调用方须自带 lines
async function fetchLyricLines(songId, signal) {
  const qqM = songId.match(QQ_SONG_ID_RE);
  let lrc;
  if (qqM) {
    const { getLyric } = require('../lib/qq');
    try {
      lrc = (await getLyric(qqM[1], signal)).lyric || '';
    } catch (e) {
      if (e && e.bizCode !== undefined) lrc = '';
      else throw e;
    }
  } else {
    const res = await callNeteaseApi('lyric', { id: songId }, { signal });
    lrc = res.body?.lrc?.lyric || '';
  }
  // 与 lines 直传同口径截：单行 ≤500（schema 上限）、总数 ≤600 截断记
  // truncated——词源拉取没有 schema 闸，不截会让上游畸形词稿烧穿 AI 配额
  const parsed = parseLrcLines(lrc).map(l => l.text.slice(0, 500));
  return { lines: parsed.slice(0, MAX_ALIGN_LINES), truncated: parsed.length > MAX_ALIGN_LINES };
}

// POST /lyric-align {songId?, lines?, audioPath?}
// 音频来源二选一：audioPath 直指（限下载目录内，防任意文件探测 oracle）
// 或 songId 查 download_tasks 已落盘工件。歌词行：lines 直传，或按
// songId 拉词源 lrc 解析。产出 {lrc, alignedBy, confidenceHint}——
// 结果不落库，持久化由调用方（下载相位/前端落 .lrc 工件）负责
app.post('/lyric-align', async (c) => {
  // 写请求 CSRF 纵深（与 routes/match.js 同口径）——无登录局域网部署下
  // 跨站 POST 也能触发 ffmpeg 解码+AI 配额消耗，不是登录态专属风险
  if (!csrfOriginOk(c)) return c.json({ code: 403, message: 'Forbidden' }, 403);
  const { data: body, error } = await parseJsonBody(c, lyricAlignBody, 512 * 1024);
  if (error) return error;
  const signal = c.req.raw.signal;
  const songId = body.songId !== undefined && body.songId !== null
    ? String(body.songId).trim() : '';

  // ── 音频定位 ──
  let audioPath = null;
  if (body.audioPath) {
    const p = path.resolve(String(body.audioPath));
    if (!isUnderDownloadDir(p)) return fail(c, 400, 'audioPath 必须在下载目录内');
    if (!pathPresent(p)) return fail(c, 404, '音频文件不存在');
    audioPath = p;
  } else if (songId) {
    audioPath = resolveDownloadedAudio(songId);
    if (!audioPath) return fail(c, 404, '该曲目没有已下载的音频文件');
  } else {
    return fail(c, 400, '缺少 audioPath 或 songId');
  }

  // ── 歌词行来源 ──
  let lines = Array.isArray(body.lines)
    ? body.lines.map(l => String(l ?? '').trim()).filter(Boolean)
    : [];
  // 缺行时才需要词源拉取；无词源 id 直传 lines 是调用方责任
  const needFetch = !lines.length;
  if (needFetch && !songId) return fail(c, 400, '缺少歌词行（lines）');
  const hasLyricSource = NETEASE_ID_BOUNDED_RE.test(songId) || QQ_SONG_ID_RE.test(songId);
  if (needFetch && !hasLyricSource) {
    return fail(c, 400, '该曲目无词源可查，请直接传 lines');
  }
  if (lines.length > MAX_ALIGN_LINES) return fail(c, 400, '歌词行数超出对齐上限');

  // 校验全过完才限流——ffmpeg 解码+AI 是重活，但纯参数错误不该吃配额
  if (!rateLimit(c, 'lyric-align', 12)) return fail(c, 429, '请求过于频繁');

  let truncated = false;
  if (needFetch) {
    try {
      const fetched = await fetchLyricLines(songId, signal);
      lines = fetched.lines;
      truncated = fetched.truncated;
    } catch (e) {
      if (signal?.aborted) return c.body(null, 499);
      console.error('[lyric-align] 词源拉取失败:', e?.message || e);
      return fail(c, 502, '歌词源拉取失败');
    }
    if (!lines.length) return fail(c, 404, '该歌曲无歌词');
  }
  if (signal?.aborted) return c.body(null, 499);

  // 在途去重键：音频路径+行集签名（同曲重提交/双击共享首个结果）
  const key = createHash('sha1')
    .update(audioPath).update('')
    .update(lines.join('\n'))
    .digest('hex').slice(0, 16);
  while (inflightAlign.has(key)) {
    const shared = await inflightAlign.get(key);
    if (shared) return c.json(shared);
    // 首个失败：循环重查——若有新 gate 搭上它的车，否则自行抢 gate
  }
  let release;
  const myGate = new Promise((r) => { release = r; });
  inflightAlign.set(key, myGate);

  // gate 在 finally 统一结算：任何早退路径（abort/异常）都必须放行了
  // waiter——否则搭车者 await 一个永不 settle 的 gate 挂死。payload 成功
  // 才赋值；失败/断连放 null，waiter 落空后自行重查 gate/重跑
  let payload = null;
  try {
    if (signal?.aborted) return c.body(null, 499);
    const r = await alignAudioToLrc({ audioPath, lines, signal });
    payload = {
      code: 200,
      lrc: r.lrc,
      alignedBy: r.alignedBy,
      confidenceHint: r.confidenceHint,
      snappedRatio: r.snappedRatio,
      durationMs: r.durationMs,
      lineCount: lines.length,
      ...(truncated ? { truncated: true } : {}),
    };
    if (signal?.aborted) return c.body(null, 499);
    return c.json(payload);
  } catch (e) {
    if (e?.aborted || signal?.aborted) return c.body(null, 499);
    // 错误消息含盘路径/上游细节——响应只给定性描述，细节留服务端日志
    console.error('[lyric-align] 对齐失败:', e?.message || e);
    // ffmpeg 缺席是环境病不是音频坏——单独映射 503（部署可治），
    // 与解码失败 502 区分开
    if (String(e?.message || '').includes('ffmpeg 不可用')) {
      return fail(c, 503, 'ffmpeg 不可用，无法执行音频对齐');
    }
    return fail(c, 502, '音频对齐失败');
  } finally {
    release(payload);
    if (inflightAlign.get(key) === myGate) inflightAlign.delete(key);
  }
});

module.exports = app;

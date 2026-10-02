// 闸控感知的 YouTube 流解析编排层——routes/youtube.js（/stream 播放链）与
// services/unlock/youtube.js（网易曲解锁定链）共用。lib/youtube.js 只做
// Innertube 原语（无下载/守卫依赖，保持 leaf）；探测用的 SSRF 守卫流式
// 抓取（fetchStream）在 services 层，故编排落在这里而非 lib。
const { fetchPlayer, fetchPlayerWith, pickStreamList } = require('../lib/youtube');
const { fetchStream } = require('./download-io');
const { normalizeOutboundUrl, isProxyAllowedHost: isAllowedHost } = require('../lib/net-guard');

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

/**
 * 闸控感知解析：fetchPlayer → 探测 SABR 闸控（30min 缓存）→ 命中则
 * VISIONOS 客户端重解 → 自适应候选 + progressive 合流拼尾。
 * @returns {Promise<{streams: Array<{url: string, mimeType: string, br: number|null}>, gated: boolean|null}>}
 *   streams 已过代理白名单预筛且按 url 去重；progressive 档 br 一律 null
 *   （容器总码率不能当音轨码率报，会污染下游时长对账）。
 *   排序语义：正常/无定论 → [自适应…, 合流…]；闸控且 VISIONOS 重解失败 →
 *   [合流…, 已证 403 的自适应…]——死链押尾让单 URL 消费方（unlock 取
 *   首位）拿到的是真活链，代理逐试场景也少打空炮。
 */
async function resolveYoutubeStreams(videoId, { kind = 'audio', prefer = '', signal } = {}) {
  let sd = (await fetchPlayer(videoId, signal)).streamingData;
  let adaptive = pickStreamList(sd, kind, prefer);
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
    // LRU touch：命中挪尾——满容淘汰按插入序删头，不刷新会让
    // 高频热播视频的旧判定先被挤掉（stream-vault resolve 同款）
    gateCache.delete(videoId);
    gateCache.set(videoId, gate);
  } else if (probeTarget) {
    gated = await probeGated(probeTarget, signal);
    if (gated !== null) {
      // 陈旧键覆盖前先删——Map.set 对已存在 key 保留原插入位，不删会让
      // 刷新后的热判定仍排在旧位置被满容淘汰先挤掉（与命中 touch 同口径）
      gateCache.delete(videoId);
      if (gateCache.size >= GATE_CACHE_MAX) {
        gateCache.delete(gateCache.keys().next().value);
      }
      gateCache.set(videoId, { gated, ts: Date.now() });
    }
  }

  let deadAdaptive = false;
  if (gated) {
    console.info(`[youtube] ${videoId} SABR 闸控命中——VISIONOS 客户端重解`);
    try {
      const vp = await fetchPlayerWith(videoId, signal, 'VISIONOS');
      if (vp?.streamingData) {
        sd = vp.streamingData;
        adaptive = pickStreamList(sd, kind, prefer);
        const prog = pickProgressiveMp4(sd);
        // progressive 跨批结转：VISIONOS 不一定回 formats——保住原批
        // 合流兜底档，别因换客户端丢掉最后的活路（fd progressiveCarry 同款）
        if (prog.length) progressive = prog;
      }
    } catch (e) {
      // VISIONOS 也拿不到就用原批——链尾合流档照样能播；abort 穿透。
      // 原批自适应已证 403：押尾，合流提首——否则单 URL 消费方拿到死链
      if (signal?.aborted) throw e;
      deadAdaptive = true;
      console.warn(`[youtube] ${videoId} VISIONOS 重解失败，回落原批:`, e.message);
    }
  }

  // 候选回链逐个过代理白名单——signatureCipher 跳过、非 googlevideo
  // 域拒；整条链随 token/返回值下发，代理/调用方试到第一个能通的档
  const seen = new Set();
  const streams = [];
  for (const [f, prog] of (deadAdaptive
    ? [...progressive.map(x => [x, true]), ...adaptive.map(x => [x, false])]
    : [...adaptive.map(x => [x, false]), ...progressive.map(x => [x, true])])) {
    const checked = normalizeOutboundUrl(f.url);
    if (!checked.ok || !isAllowedHost(checked.url.hostname)) continue;
    if (seen.has(f.url)) continue;
    seen.add(f.url);
    streams.push({ url: f.url, mimeType: f.mimeType || '', br: prog ? null : (f.bitrate || null) });
  }
  return { streams, gated };
}

module.exports = { resolveYoutubeStreams };

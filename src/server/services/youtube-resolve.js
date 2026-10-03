// 闸控感知的 YouTube 流解析编排层——routes/youtube.js（/stream 播放链）与
// services/unlock/youtube.js（网易曲解锁定链）共用。lib/youtube.js 只做
// Innertube 原语（无下载/守卫依赖，保持 leaf）；探测用的 SSRF 守卫流式
// 抓取（fetchStream）在 services 层，故编排落在这里而非 lib。
const { fetchPlayer, fetchPlayerWith, pickStreamList } = require('../lib/youtube');
const { fetchStream } = require('./download-io');
const { normalizeOutboundUrl, isProxyAllowedHost: isAllowedHost } = require('../lib/net-guard');

// 「SABR 闸控」探测缓存：`${videoId}:${kind}` → {gated, ts}。自适应流被闸
// 时签名批寿命 ~6h，探测结果缓存 30min 同量级——连播/重试不重复白打上游。
// 键带 kind：同曲音/视频 resolve 并发且探测目标不同（音轨≠视轨），共键
// 会让后落地的假阴覆盖先到的真阳——实测 video 假阴就把整曲钉错 30min
const GATE_TTL_MS = 30 * 60e3;
const GATE_CACHE_MAX = 512;
const gateCache = new Map();
// 同键探测单飞：播放管线里 audio/video 两个 resolve 几乎并发，不共享在途
// 探测会各探各写互踩（visitorDataInflight 同款先例）
const probeInflight = new Map();

// 闸控指纹：闸控签名批对「无界 Range」一律 403——bytes=0- 正是 Chrome 媒体
// 元素的首请求形态（客户端不带 Range 时代理侧也注入同形），即用户实际
// 可见的指纹。旧指纹探 2MiB 有界窗——闸控放行窗按时长计而非定长，高码率
// 视频档 2MiB 必在窗内，是系统性假阴（实测 itag299 放行 ~64MB）。
// 主探 bytes=0-；通了再补一发 ~90% 深处无界探针（= 客户端 seek/续播的
// 真实请求形态）抓「头放行深位拒」的另一半。
// 三态：false=未闸（两探皆过或探针越 EOF 416），true=闸控（任一 403），
// null=无定论（超时/5xx/白名单外——不写缓存，逐请求退化照常走兜底链）。
// 对 googlevideo 恒发带 Range 的 GET——裸 HEAD/无 Range 探测会毒化该 URL
// 的后续请求（上游按请求形态记账），探测形状因此与客户端同形。
// 共享探测不带调用方 signal：断连方的 await 侧自查 signal 抛错，探测本身
// 诚实跑完再写缓存——被 abort 吞成无定论会拒绝写缓存逐请求退化白打上游
async function probeGated(url, contentLength, signal) {
  const checked = normalizeOutboundUrl(url);
  if (!checked.ok || !isAllowedHost(checked.url.hostname)) return null;
  const tryRange = async (range) => {
    try {
      const resp = await fetchStream(url, {
        timeout: 6000, signal,
        headers: { Range: range }
      });
      resp.data?.destroy?.();
      return 'ok';
    } catch (e) {
      if (signal?.aborted) throw e;
      // 按机读状态码判（fetchStream 在 err.upstreamStatus 上挂的）——
      // 403=闸控；416=探针越过 EOF 但 Range 通道畅通，恰证明未闸
      // （小文件深位探测会撞上），归 null 会让短流每次请求都白打探测
      if (e?.upstreamStatus === 403) return 'gated';
      if (e?.upstreamStatus === 416) return 'ok';
      return null;
    }
  };
  const head = await tryRange('bytes=0-');
  if (head !== 'ok') return head === 'gated' ? true : null;
  const cl = parseInt(contentLength) || 0;
  if (!cl) return false;   // 不知总长无法选深位——头探已过按未闸
  const deep = await tryRange(`bytes=${Math.floor(cl * 0.9)}-`);
  if (deep === 'gated') return true;
  // 头通+深位无定论：「全程畅通」没证完，不给未闸背书
  return deep === 'ok' ? false : null;
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
 *   排序语义：正常/无定论 → [自适应…, 合流…]；闸控且 VISIONOS 重解/复验
 *   失败 → [合流…, 已证 403 的自适应…]——消费方只取首链（跨字节实体
 *   不能混排换档），死链押尾让首链恒是最优活档。
 */
async function resolveYoutubeStreams(videoId, { kind = 'audio', prefer = '', signal, skipCache = false } = {}) {
  let sd = (await fetchPlayer(videoId, signal)).streamingData;
  let adaptive = pickStreamList(sd, kind, prefer);
  // progressive 合流档是闸控视频的保底命——无条件拼链尾；audio kind
  // 同样放：合流 mp4 含 AAC 轨，<audio> 按容器嗅探照播
  let progressive = pickProgressiveMp4(sd);

  // SABR 闸控探测（结果缓存）：被闸的视频换 VISIONOS 客户端重解——
  // 同一批自适应流它签的 URL 完全不受限，能放回真最高档（实测 itag251
  // 全量 200）。只有确定性判定（2xx/403/416）才写缓存——超时/断连等
  // 无定论结果落缓存会把一次抖动放大成 30min 的误判。
  // 探测目标 = 实际将下发的首个自适应候选（pickStreamList 排序头名过
  // 白名单预筛）——探测对象必须与下发对象同一：旧口径取 contentLength
  // 最大条目，kind=video 时探的是永不下发的 vp9 巨档（放行窗按文件时长
  // 计，巨档窗口必含探针点），系统性假阴把整批判成未闸→死链下发→
  // 换档糊片。
  // 下发链无可服务自适应（缺 avc1 回落合流）时退回旧口径作批次签名
  // 代表：探合流无信息量（合流签名批本就不被闸，恒放行=假阴），而同
  // kind 自适应档能证明「这批签名被闸」→ VISIONOS 重解可能给出可服务
  // 自适应；取 contentLength 最大者窗口最窄、403 最确证
  const probeTargetOf = (fmts, sdData) => {
    const progUrls = new Set(pickProgressiveMp4(sdData).map(f => f.url));
    const served = (fmts || []).find(f => {
      if (progUrls.has(f?.url)) return false;      // 合流壳不探——恒放行
      if (typeof f?.url !== 'string' || !f.url) return false;
      const chk = normalizeOutboundUrl(f.url);
      return chk.ok && isAllowedHost(chk.url.hostname);
    });
    if (served) return served;
    return (Array.isArray(sdData?.adaptiveFormats) ? sdData.adaptiveFormats : [])
      .filter(f => typeof f?.url === 'string' && f.url
        && (f.mimeType || '').startsWith(kind === 'video' ? 'video/' : 'audio/')
        && (parseInt(f.contentLength) || 0) > 0)
      .sort((a, b) => (parseInt(b.contentLength) || 0) - (parseInt(a.contentLength) || 0))
      .find(f => {
        const chk = normalizeOutboundUrl(f.url);
        return chk.ok && isAllowedHost(chk.url.hostname);
      });
  };
  // 键不含 prefer：闸控判定是签名批级而非候选级——不同 prefer 的探针
  // 目标不同，但「这批签名被不被闸」的答案是同一个
  const gateKey = `${videoId}:${kind}`;
  const gate = skipCache ? null : gateCache.get(gateKey);
  let gated = null;
  if (gate && Date.now() - gate.ts <= GATE_TTL_MS) {
    gated = gate.gated;
    // LRU touch：命中挪尾——满容淘汰按插入序删头，不刷新会让
    // 高频热播视频的旧判定先被挤掉（stream-vault resolve 同款）
    gateCache.delete(gateKey);
    gateCache.set(gateKey, gate);
  } else {
    const target = probeTargetOf(adaptive, sd);
    if (target) {
      // 同键探测单飞：audio/video resolve 几乎并发，各探各写会互踩；
      // 共享探测不带首调用方 signal——abort 穿透不污染缓存的语义靠各
      // 等待方自查 signal 保住（visitorDataInflight 同款先例）
      if (!probeInflight.has(gateKey)) {
        probeInflight.set(gateKey, (async () => {
          const g = await probeGated(target.url, target.contentLength, null);
          if (g !== null) {
            // 陈旧键覆盖前先删——Map.set 对已存在 key 保留原插入位，不删
            // 会让刷新后的热判定仍排在旧位置被满容淘汰先挤掉
            gateCache.delete(gateKey);
            if (gateCache.size >= GATE_CACHE_MAX) {
              gateCache.delete(gateCache.keys().next().value);
            }
            gateCache.set(gateKey, { gated: g, ts: Date.now() });
          }
          return g;
        })().finally(() => probeInflight.delete(gateKey)));
      }
      gated = await probeInflight.get(gateKey);
      if (signal?.aborted) throw new Error('aborted');
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
        // 复验：新批签名同样可能被闸——将下发的首链再过同款探针；坐实
        // 403 按死批处理让合流提首，无定论/通过都保留新批（它已是最好
        // 的牌）。每趟重解必验：新签名批的闸态与原批无继承关系
        const nv = probeTargetOf(adaptive, sd);
        if (nv && (await probeGated(nv.url, nv.contentLength, signal)) === true) {
          deadAdaptive = true;
        }
      } else {
        // 无 streamingData 的回应（当前 fetchPlayerWith 不可达，属纵深防御）：
        // 原批自适应已判闸，不补 else 会以正常序下发死链
        deadAdaptive = true;
      }
    } catch (e) {
      // VISIONOS 也拿不到就用原批——链尾合流档照样能播；abort 穿透。
      // 原批自适应按本批探测或缓存判定已证被闸：押尾，合流提首——
      // 否则单 URL 消费方拿到死链
      if (signal?.aborted) throw e;
      deadAdaptive = true;
      console.warn(`[youtube] ${videoId} VISIONOS 重解失败，回落原批:`, e.message);
    }
  }

  // 候选回链逐个过代理白名单——signatureCipher 跳过、非 googlevideo
  // 域拒。消费方只取 streams[0]（跨分辨率/编码的候选是不同字节文件，
  // 混排换档会把同一 offset 的另一文件字节拼给客户端——/stream 与解锁
  // 链都只 mint 首链）；排序语义因此就是活链语义：首链即最优活档
  const seen = new Set();
  // pickStreamList('video') 在批内无 avc1 时会把 progressive mp4 从 adaptive
  // 通道送回——按 url 属集补判 prog，否则合流档被标 false、br 拿容器总
  // 码率冒充音轨码率污染下游对账
  const progUrls = new Set(progressive.map(f => f.url));
  const streams = [];
  for (const [f, viaProgList] of (deadAdaptive
    ? [...progressive.map(x => [x, true]), ...adaptive.map(x => [x, false])]
    : [...adaptive.map(x => [x, false]), ...progressive.map(x => [x, true])])) {
    const checked = normalizeOutboundUrl(f.url);
    if (!checked.ok || !isAllowedHost(checked.url.hostname)) continue;
    if (seen.has(f.url)) continue;
    seen.add(f.url);
    const prog = viaProgList || progUrls.has(f.url);
    streams.push({ url: f.url, mimeType: f.mimeType || '', br: prog ? null : (f.bitrate || null) });
  }
  return { streams, gated };
}

module.exports = { resolveYoutubeStreams };

// YouTube Innertube 原语——routes/youtube.js 与解锁层（services/unlock/youtube.js）
// 共用。公开 web 客户端 key（嵌在 youtube.com 前端里，供匿名访客调 youtubei）。
// ANDROID/IOS 客户端的 streamingData 直返可播 url（无 signatureCipher 混淆
// 签名）——正是不需要 yt-dlp 的原因；ANDROID 优先，被风控/改版时退 IOS。
// key/客户端版本号摘自 youtube.com 前端与 yt-dlp 上游（会随 YouTube 改版过期——
// resolve 报「无流数据」率升高时对照 yt-dlp 仓库同步 clientVersion）
const YT_TIMEOUT_MS = 15000;
const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const INNERTUBE_CLIENTS = [
  {
    name: 'ANDROID', clientId: 3,
    client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, hl: 'zh' },
    headers: { 'User-Agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip' },
  },
  {
    name: 'IOS', clientId: 5,
    client: { clientName: 'IOS', clientVersion: '20.10.4', deviceModel: 'iPhone16,2', hl: 'zh' },
    headers: { 'User-Agent': 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_4 like Mac OS X)' },
  },
  {
    // 反 SABR 闸控档：部分视频 ANDROID/IOS 回的自适应流只吃首段窗外全 403，
    // 同视频 VISIONOS 签名却完全不受限（实测 itag251 全量 200、任意 Range 206）。
    // 排最后：正常视频轮不到它，前两形态失败/流被闸时才上场
    name: 'VISIONOS', clientId: 101, needsVisitor: true,
    client: {
      clientName: 'VISIONOS', clientVersion: '1.02', deviceMake: 'Apple',
      deviceModel: 'RealityDevice17,1', osName: 'visionOS', osVersion: '26.5.23O471',
      // context 内嵌 UA 与 HTTP 头一致是风控校验点——缺了会吃 LOGIN_REQUIRED
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
      hl: 'zh'
    },
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15' },
  },
];

// X-YouTube-Client-* 是 Innertube 形态自证头——与 context 不一致会触发风控
const clientHeaders = (form, vd) => ({
  'Content-Type': 'application/json',
  'X-YouTube-Client-Name': String(form.clientId),
  'X-YouTube-Client-Version': String(form.client.clientVersion),
  ...(vd ? { 'X-Goog-Visitor-Id': vd } : {}),
  ...form.headers
});

// visitorData 是 Innertube 风控的匿名会话凭据（yt-dlp 同款来源：抓
// youtube.com 首页 ytcfg 提取）——VISIONOS 无匿名通路必挂，其余客户端
// 吃 LOGIN_REQUIRED 时挂上原地重试一次。模块级缓存 30min
let visitorDataCache = null;
let visitorDataAt = 0;
const VISITOR_TTL_MS = 30 * 60e3;
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';

async function getVisitorData(extraSignal) {
  if (visitorDataCache && Date.now() - visitorDataAt < VISITOR_TTL_MS) {
    return visitorDataCache;
  }
  const res = await fetch('https://www.youtube.com', {
    headers: { 'User-Agent': DESKTOP_UA },
    signal: timedSignal(extraSignal),
  });
  if (!res.ok) throw new Error(`visitorData 抓取 HTTP ${res.status}`);
  const html = await res.text();
  const m = html.match(/"VISITOR_DATA":"([^"]+)"/);
  if (!m) throw new Error('visitorData 提取失败');
  visitorDataCache = m[1];
  visitorDataAt = Date.now();
  return visitorDataCache;
}

// 指定客户端形态直解：clientName 用于「已知 ANDROID 流被闸」的升级路径——
// 跳过无谓的前两形态白打，直接拿 VISIONOS 签名批。
// 每形态至多两试：首试裸匿名，LOGIN_REQUIRED 后补 visitorData 原地重试
async function fetchPlayerWith(videoId, extraSignal, clientName) {
  const forms = clientName
    ? INNERTUBE_CLIENTS.filter(f => f.name === clientName)
    : INNERTUBE_CLIENTS;
  let lastErr = null;
  for (const form of forms) {
    let formErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (extraSignal?.aborted) throw new Error('aborted');
      // needsVisitor 形态（VISIONOS）首试就挂；其余形态第二试才补——
      // 缓存热时顺手带给所有形态（白来的风控豁免）
      const vd = visitorDataCache
        || (form.needsVisitor || attempt > 0
          ? await getVisitorData(extraSignal).catch(() => null)
          : null);
      let body;
      try {
        const res = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}`, {
          method: 'POST',
          headers: clientHeaders(form, vd),
          body: JSON.stringify({
            context: { client: vd ? { ...form.client, visitorData: vd } : form.client },
            videoId
          }),
          signal: timedSignal(extraSignal),
        });
        if (!res.ok) throw new Error(`innertube HTTP ${res.status}`);
        body = await res.json();
      } catch (e) {
        formErr = lastErr = e;
        if (extraSignal?.aborted) throw new Error('aborted');
        break;  // 网络层失败重试同形态无意义——换下一形态
      }
      const ps = body?.playabilityStatus;
      // OK / LIVE_EDGE 才有流；LOGIN_REQUIRED/ERROR 等带 reason 落 formErr
      if (!ps?.status || ['OK', 'LIVE_EDGE'].includes(ps.status)) {
        if (body?.streamingData) return body;
        formErr = lastErr = new Error('无流数据');
        break;
      }
      formErr = lastErr = new Error(`不可播放: ${ps.reason || ps.status}`);
      // 匿名被风控 → 补 visitorData 原地重试一次（二试必带 vd）
      if (ps.status === 'LOGIN_REQUIRED' && attempt === 0) continue;
      break;
    }
    console.warn(`[youtube] ${form.name} 客户端取流失败:`, formErr.message);
  }
  throw lastErr || new Error('所有客户端形态均失败');
}

const timedSignal = (extraSignal, ms = YT_TIMEOUT_MS) => extraSignal
  ? AbortSignal.any([AbortSignal.timeout(ms), extraSignal])
  : AbortSignal.timeout(ms);

// 播放器响应：依次尝试客户端形态，第一个给出可用流的为准。
// extraSignal 级联客户端断连——上游请求不随客户端断开变僵尸
const fetchPlayer = (videoId, extraSignal) => fetchPlayerWith(videoId, extraSignal);

// 关键词搜索：解锁层的「网易曲目 → YouTube 候选」入口（替代 unm 的 yt-dlp
// spawn 链）。候选期即拿 lengthSeconds——比 ytsearch1 dump-json 后盲探测更强。
// 客户端表回落与 fetchPlayer 同口径：Innertube 风控按客户端形态整体生效，
// ANDROID 被封时 search 若写死单形态会在 player 回落链之前就整源死亡
async function innertubeSearch(keyword, extraSignal, limit = 5) {
  // 递归扫 videoRenderer（web 客户端形态）与 compactVideoRenderer
  // （ANDROID/IOS 移动客户端形态）——twoColumnSearchResultsRenderer 的
  // 嵌套深度随 YouTube 改版漂移，按节点形状收集比按路径深取稳
  const textOf = (n) => (n?.runs || []).map(r => r.text).join('') || n?.simpleText || '';
  const seen = new Set(); // 同 videoId 会在主结果与相关推荐栏重复出现——去重防重复打 player
  const walk = (node, out) => {
    if (!node || typeof node !== 'object' || out.length >= limit) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, out);
      return;
    }
    const v = node.videoRenderer || node.compactVideoRenderer;
    if (v?.videoId && !seen.has(v.videoId)) {
      seen.add(v.videoId);
      // lengthText 两种形态都出现：simpleText（web）或 runs（compact）——
      // 统一走 textOf；部分形态直接给 lengthSeconds 数字
      const lt = textOf(v.lengthText);
      // +null=0 会被 isFinite 当合法时长（0s 反而绕过下游对账）——null/空串先归 NaN
      const ls = v.lengthSeconds == null || v.lengthSeconds === ''
        ? NaN : Number(v.lengthSeconds);
      out.push({
        videoId: v.videoId,
        title: textOf(v.title),
        owner: textOf(v.ownerText) || textOf(v.shortBylineText),
        durationSec: Number.isFinite(ls) && ls > 0 ? ls
          : (lt ? lt.split(':').reduce((s, p) => s * 60 + (+p || 0), 0) : null),
      });
    }
    for (const key of Object.keys(node)) {
      if (key === 'videoRenderer' || key === 'compactVideoRenderer') continue;
      walk(node[key], out);
    }
  };
  let lastErr = null;
  for (const form of INNERTUBE_CLIENTS) {
    if (extraSignal?.aborted) throw new Error('aborted');
    try {
      const res = await fetch(`https://www.youtube.com/youtubei/v1/search?key=${INNERTUBE_KEY}`, {
        method: 'POST',
        headers: clientHeaders(form, visitorDataCache),
        body: JSON.stringify({
          context: { client: visitorDataCache ? { ...form.client, visitorData: visitorDataCache } : form.client },
          query: String(keyword || ''),
          // sp=EgIQAQ%3D%3D 对应「仅视频」过滤——歌单/频道卡片不占候选位
          params: 'EgIQAQ==',
        }),
        signal: timedSignal(extraSignal),
      });
      if (!res.ok) throw new Error(`innertube search HTTP ${res.status}`);
      const body = await res.json();
      const out = [];
      walk(body?.contents, out);
      // 空壳响应（风控时常见 200+无 renderer）视为失败换下一客户端——
      // 与 fetchPlayer 的「无 streamingData 即换形态」同口径
      if (!out.length) throw new Error('搜索结果无候选（空壳响应/风控）');
      return out;
    } catch (e) {
      lastErr = e;
      if (extraSignal?.aborted) throw new Error('aborted');
      console.warn(`[youtube] ${form.name} 客户端搜索失败:`, e.message);
    }
  }
  throw lastErr || new Error('所有客户端形态搜索均失败');
}

// 选流：音频默认优先 mp4a/m4a 容器（audio/mp4——webm opus 在 Safari 的
// <audio> 不通）；prefer='best'（下载档）直接按 bitrate 排全部音频——
// opus itag251（~136k 全频带到 20kHz）优于 aac itag140（~130k 且 16kHz
// 低通截断），播放器兼容性由用户本地承担，归档就该拿第一代完整频带。
// video 取 adaptive avc1（H.264 全浏览器可放），按分辨率/bitrate 降序。
// signatureCipher 混淆流（无 url 只有签名参数）跳过——本服务不做签名反解
function pickStreamList(data, kind, prefer = '') {
  const adaptive = Array.isArray(data?.adaptiveFormats) ? data.adaptiveFormats : [];
  const progressive = Array.isArray(data?.formats) ? data.formats : [];
  const usable = (f) => typeof f?.url === 'string' && f.url;
  if (kind === 'audio') {
    // 多配音/口述影像轨（MrBeast 类稿件）带 audioTrack 元数据——非默认轨
    // 不该按码率赢过原声轨（否则下载/播放拿到外语配音）
    const audios = adaptive.filter(f => usable(f)
      && (f.mimeType || '').startsWith('audio/')
      && f.audioTrack?.audioIsDefault !== false);
    if (prefer === 'best') {
      return audios.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    }
    const mp4 = audios.filter(f => (f.mimeType || '').startsWith('audio/mp4'));
    return (mp4.length ? mp4 : audios).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  }
  const avc = adaptive.filter(f =>
    usable(f) && (f.mimeType || '').startsWith('video/mp4')
    && (f.mimeType || '').includes('avc1'));
  // progressive 兜底同样限 video/mp4——webm 合并流 Safari 放不了，宁缺毋滥
  // （hasVideo 语义 = 浏览器解得动的流存在）
  const mp4Progressive = progressive.filter(f =>
    usable(f) && (f.mimeType || '').startsWith('video/mp4'));
  return (avc.length ? avc : mp4Progressive)
    .sort((a, b) => ((b.height || 0) * (b.width || 0)) - ((a.height || 0) * (a.width || 0)));
}

module.exports = { fetchPlayer, fetchPlayerWith, innertubeSearch, pickStreamList, YT_TIMEOUT_MS };

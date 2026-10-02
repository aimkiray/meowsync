// YouTube Innertube 原语——消费方：routes/youtube.js（/resolve、歌单页）、
// services/youtube-resolve.js（闸控感知取流，/stream 与解锁链共用）、
// services/file-downloader.js（服务端下载）。
// 公开 web 客户端 key（嵌在 youtube.com 前端里，供匿名访客调 youtubei）。
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
let visitorDataFailAt = 0;          // 抓取失败负缓存——首页不可达时别每请求白打
let visitorDataInflight = null;     // 冷缓存并发单飞：在途抓取共享同一 promise
const VISITOR_TTL_MS = 30 * 60e3;
const VISITOR_FAIL_TTL_MS = 2 * 60e3;
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';

// browse 端点走 WEB 形态——INNERTUBE_CLIENTS 的移动形态是为 player 选流
// 服务的（ANDROID 优先直返可播 url），歌单页 renderer 结构按桌面端解析
const WEB_CLIENT = {
  name: 'WEB', clientId: 1,
  client: { clientName: 'WEB', clientVersion: '2.20250219.01.00', hl: 'zh' },
  headers: { 'User-Agent': DESKTOP_UA },
};

// 只读取用：新鲜才给、过期/null 都回 null——不发请求。给「有则带上、
// 无则匿名」的消费方（innertubeSearch/各形态首试）用，不触发网络
const freshVisitorData = () =>
  (visitorDataCache && Date.now() - visitorDataAt < VISITOR_TTL_MS)
    ? visitorDataCache : null;

// 主动取用：新鲜直返、过期重抓、失败冷却期直接 null（不抛）。
// 「必须带凭据」的消费方（VISIONOS/LOGIN_REQUIRED 重试）统一走这里——
// 新鲜度判断集中在这一个入口，别处裸读缓存会把过期凭据无限期发出去
async function getVisitorData(extraSignal) {
  if (freshVisitorData()) return visitorDataCache;
  if (Date.now() - visitorDataFailAt < VISITOR_FAIL_TTL_MS) return null;
  // 单飞：冷缓存并发（VISIONOS 升级/LOGIN_REQUIRED 重试各源同时触发）
  // 共享一次首页抓取。共享 promise 不带调用方 signal——首调用方断连
  // 不该让搭车者陪绑（unlock.js inflightRank 同款先例）；抓取自身只挂
  // 内部超时。搭车者用自己 signal 决定吃不吃结果
  if (!visitorDataInflight) {
    visitorDataInflight = (async () => {
      try {
        const res = await fetch('https://www.youtube.com', {
          headers: { 'User-Agent': DESKTOP_UA },
          signal: AbortSignal.timeout(YT_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`visitorData 抓取 HTTP ${res.status}`);
        const html = await res.text();
        const m = html.match(/"VISITOR_DATA":"([^"]+)"/);
        if (!m) throw new Error('visitorData 提取失败');
        visitorDataCache = m[1];
        visitorDataAt = Date.now();
        return visitorDataCache;
      } catch (e) {
        // 内部超时/上游失败才盖负缓存章——调用方 abort 根本到不了这里
        visitorDataFailAt = Date.now();
        console.warn('[youtube] visitorData 抓取失败:', e.message);
        return null;
      }
    })().finally(() => { visitorDataInflight = null; });
  }
  const vd = await visitorDataInflight;
  // 等待期间调用方断连：abort 穿透语义与旧版一致（fetchPlayerWith 上层
  // 靠 throw 判取消）。已作废的结果照常回填缓存——下一调用方仍受益
  if (extraSignal?.aborted) throw new Error('aborted');
  return vd;
}

// 指定客户端形态直解：clientName 用于「已知 ANDROID 流被闸」的升级路径——
// 跳过无谓的前两形态白打，直接拿 VISIONOS 签名批。
// 每形态至多两试：首试裸匿名，LOGIN_REQUIRED 后补 visitorData 原地重试
async function fetchPlayerWith(videoId, extraSignal, clientName) {
  const forms = clientName
    ? INNERTUBE_CLIENTS.filter(f => f.name === clientName)
    : INNERTUBE_CLIENTS;
  if (!forms.length) throw new Error(`未知客户端形态: ${clientName}`);
  let lastErr = null;
  for (const form of forms) {
    let formErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (extraSignal?.aborted) throw new Error('aborted');
      // needsVisitor 形态（VISIONOS）/重试轮主动取（过期自动重抓）；
      // 其余形态首试只用热缓存——不触发网络，缓存过期视同匿名
      const vd = form.needsVisitor || attempt > 0
        ? await getVisitorData(extraSignal)
        : freshVisitorData();
      // 拿不到凭据就不发：VISIONOS 无匿名通路必败；重试轮没补上 vd 的
      // 请求与首试逐字节相同，同样注定重败——两类都直接换形态
      if ((form.needsVisitor || attempt > 0) && !vd) {
        formErr = lastErr = new Error('visitorData 获取失败');
        break;
      }
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
      // 匿名被风控 → 补 visitorData 原地重试一次。已带 vd 还吃
      // LOGIN_REQUIRED 时重试是逐字节相同请求——注定重败，直接换形态
      if (ps.status === 'LOGIN_REQUIRED' && attempt === 0 && !vd) continue;
      break;
    }
    console.warn(`[youtube] ${form.name} 客户端取流失败:`, formErr?.message || '未知错误');
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
      const vd = freshVisitorData();
      const res = await fetch(`https://www.youtube.com/youtubei/v1/search?key=${INNERTUBE_KEY}`, {
        method: 'POST',
        headers: clientHeaders(form, vd),
        body: JSON.stringify({
          context: { client: vd ? { ...form.client, visitorData: vd } : form.client },
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

// renderer 树通用读文本——runs 拼接优先，simpleText 兜底
const rendererText = (n) => (n?.runs || []).map(r => r.text).join('') || n?.simpleText || '';

// 歌单页一页：首屏走 browseId=VL<listId>，续页走 continuation token。
// 条目节点递归收集（嵌套深度随 YouTube 改版漂移，按节点形状取比按路径
// 深取稳——与 innertubeSearch 同款防御）。失效条目（isPlayable:false/
// 无 videoId/sentinel 标题）计入 skipped 透出给前端
async function fetchYtPlaylistPage({ listId, continuation, extraSignal }) {
  const vd = freshVisitorData();
  const res = await fetch(`https://www.youtube.com/youtubei/v1/browse?key=${INNERTUBE_KEY}`, {
    method: 'POST',
    headers: clientHeaders(WEB_CLIENT, vd),
    body: JSON.stringify({
      context: { client: vd ? { ...WEB_CLIENT.client, visitorData: vd } : WEB_CLIENT.client },
      // VL 前缀输入已是 browseId 形态——幂等而非二次加前缀
      ...(continuation ? { continuation } : { browseId: /^VL/i.test(listId) ? listId : `VL${listId}` }),
    }),
    signal: timedSignal(extraSignal),
  });
  if (!res.ok) throw new Error(`innertube browse HTTP ${res.status}`);
  const body = await res.json();

  // 私有/不存在/被删的歌单：200 + alerts[].alertRenderer.type='ERROR'
  // ——对用户是「不可访问」语义，挂 upstreamCode 供路由映射 404；
  // 登录/风控类 alert（sign in/bot）是本机信誉问题而非歌单问题，分档 502
  const alert = (body?.alerts || []).find(a => a?.alertRenderer?.type === 'ERROR');
  if (alert) {
    const text = rendererText(alert.alertRenderer.text);
    const e = new Error(`播放列表不可用: ${text || 'ERROR'}`);
    e.upstreamCode = /sign in|log ?in|bot|登录|登入|验证|確認/i.test(text) ? 'ALERT_AUTH' : 'ALERT_ERROR';
    throw e;
  }
  // 200 但三棵内容根与 header 全空——风控空壳/响应畸形，不是「歌单不存在」
  if (!body?.header && !body?.contents && !body?.onResponseReceivedActions
    && !body?.onResponseReceivedEndpoints && !body?.continuationContents) {
    const e = new Error('innertube browse 空壳响应');
    e.upstreamCode = 'EMPTY_SHELL';
    throw e;
  }

  const items = [];
  const seen = new Set();
  let skipped = 0;
  let next = null;
  // 失效条目标题哨兵（各语言形态）——lockup 形态里失效项仍带 videoId，
  // 只能靠标题判；整串匹配防 'Private Eyes' 类真标题误杀；无标题/无
  // videoId 的节点同样不可播
  const DEAD_TITLE = /^\s*[\[【「『(]?\s*(?:(?:deleted|private|removed|unavailable)\s*video|已[删刪]除的?[视影]片|已移除的?[视影]片|已设为私享的?[视影]片|私享[视影]片|私人[视影]片|无法播放的?[视影]片|削除された(?:動画|ビデオ)|삭제된 동영상)\s*[\]】」』)]?\s*$/i;
  // 找 part 里的频道跳转（browseEndpoint.browseId='UC…'）——比按语言
  // 匹配「by/创建者」前缀更稳（lockup 行与 pageHeader 共用）
  const hasChannelLink = (m) => {
    if (!m || typeof m !== 'object') return false;
    if (Array.isArray(m)) return m.some(hasChannelLink);
    const bid = m.browseEndpoint?.browseId;
    if (typeof bid === 'string' && bid.startsWith('UC')) return true;
    return Object.keys(m).some(k => hasChannelLink(m[k]));
  };
  const parseSecs = (t) => /^\d+(?::\d{1,2})+$/.test(t || '')
    ? t.split(':').reduce((s, p) => s * 60 + (+p || 0), 0) : 0;
  const pushItem = (videoId, title, owner, durationSec) => {
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId || '') || !title || DEAD_TITLE.test(title)) {
      skipped++; return;
    }
    if (seen.has(videoId)) return;
    seen.add(videoId);
    items.push({ videoId, title, owner: owner || '', durationSec });
  };
  // 新版 lockupViewModel（ViewModel 架构迁移后的条目形态）：
  // contentId=videoId；标题在 lockupMetadataViewModel.title.content；
  // 频道在 metadataRows 首行首个文本；时长在缩略图角标 badge
  const parseLockup = (lv) => {
    if (lv.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO') { return; } // 频道/合集卡不算失效
    const meta = lv.metadata?.lockupMetadataViewModel;
    const rows = meta?.metadata?.contentMetadataViewModel?.metadataRows || [];
    let badge = '';
    const findBadge = (n) => {
      if (badge || !n || typeof n !== 'object') return;
      if (Array.isArray(n)) { for (const i of n) findBadge(i); return; }
      const t = n.thumbnailBadgeViewModel?.text;
      if (typeof t === 'string' && /^\d+:\d{2}/.test(t)) { badge = t; return; }
      for (const k of Object.keys(n)) findBadge(n[k]);
    };
    findBadge(lv.contentImage);
    // 频道名：优先带 UC 跳转的 part（合并行里视图计数无频道端点），
    // 兜底首文本 part 按「•」截段剥尾噪
    const row0 = rows[0]?.metadataParts || [];
    const partText = (p) => p?.text?.content
      || p?.avatarStack?.avatarStackViewModel?.text?.content || p?.avatarStack?.text?.content || '';
    const ownerPart = row0.find(p => hasChannelLink(p?.text?.commandRuns || p?.avatarStack?.avatarStackViewModel?.text?.commandRuns))
      || row0.find(p => partText(p));
    const owner = partText(ownerPart).split(/\s*[•·]\s*/)[0].trim();
    pushItem(lv.contentId, meta?.title?.content || '', owner, parseSecs(badge));
  };
  let nextAlt = null; // 非哨兵位 continuationCommand 兜底（哨兵优先）
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const it of node) walk(it); return; }
    if (node.lockupViewModel) parseLockup(node.lockupViewModel);
    const v = node.playlistVideoRenderer;
    if (v) {
      // 失效/私有条目：无 videoId 或 isPlayable:false
      if (!v.videoId || v.isPlayable === false || DEAD_TITLE.test(rendererText(v.title))) { skipped++; }
      else {
        pushItem(v.videoId, rendererText(v.title),
          rendererText(v.shortBylineText) || rendererText(v.longBylineText),
          parseSecs(rendererText(v.lengthText)));
      }
    }
    // 续页 token：哨兵位优先（continuationItem*/nextContinuationData 是
    // 明确的加载更多语境），裸 continuationCommand 仅兜底——子树继续
    // 下钻找 token（lockup/continuationItem 内嵌形态），条目由 seen 去重
    const sentinel = node.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token
      || node.continuationItemViewModel?.continuationCommand?.innertubeCommand?.continuationCommand?.token
      || node.nextContinuationData?.continuation
      || node.nextContinuationData?.continuationEndpoint?.continuationCommand?.token;
    if (sentinel && !next) next = sentinel;
    if (!nextAlt) {
      nextAlt = node.continuationEndpoint?.continuationCommand?.token
        || node.continuationCommand?.token || null;
    }
    for (const key of Object.keys(node)) walk(node[key]);
  };
  // 续页响应根字段随版本漂移（onResponseReceivedActions/Endpoints /
  // continuationContents）——四棵候选根都扫，各自子树不重叠
  walk(body?.contents);
  walk(body?.onResponseReceivedActions);
  walk(body?.onResponseReceivedEndpoints);
  walk(body?.continuationContents);
  if (!next) next = nextAlt;

  // 首屏才有 header；新旧两种形态（playlistHeaderRenderer / pageHeaderRenderer）。
  // 新版元信息在 metadataRows 文本行里（「创建者：X」「N 个视频」）
  const ph = body?.header?.playlistHeaderRenderer;
  const pg = body?.header?.pageHeaderRenderer;
  const metaParts = [];
  const collectParts = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(collectParts); return; }
    const c = n.metadataParts;
    if (Array.isArray(c)) {
      // 新版 header 把创建者文本塞在 avatarStack 节点里；创建者项带
      // 频道 browseEndpoint（UC…）——比按语言匹配前缀更稳
      for (const p of c) {
        const tx = p?.text || p?.avatarStack?.text || p?.avatarStack?.avatarStackViewModel?.text;
        const content = tx?.content;
        if (!content) continue;
        metaParts.push({ text: content, isChannel: hasChannelLink(tx?.commandRuns) });
      }
    }
    for (const k of Object.keys(n)) if (k !== 'metadataParts') collectParts(n[k]);
  };
  collectParts(pg?.content?.pageHeaderViewModel?.metadata);
  const title = rendererText(ph?.title)
    || (typeof pg?.pageTitle === 'string' ? pg.pageTitle : rendererText(pg?.pageTitle))
    || pg?.content?.pageHeaderViewModel?.title?.dynamicTextViewModel?.text?.content || '';
  // by 前缀剥除要求分隔符/词边界——'Byron'/'By2' 频道名不得啃
  const BY_PREFIX = /^(?:创建者|by)(?:\s*[:：]\s*|\s+)/i;
  const owner = rendererText(ph?.ownerText)
    || (metaParts.find(p => p.isChannel)?.text
      || metaParts.find(p => BY_PREFIX.test(p.text))?.text || '')
      .replace(BY_PREFIX, '');
  const countDigits = rendererText(ph?.numVideosText).replace(/\D/g, '')
    || (metaParts.map(p => p.text.match(/^(\d[\d,.]*)\s*(?:个视频|部视频|videos?)/i)?.[1]).find(Boolean) || '').replace(/\D/g, '');
  const cover = ph?.playlistHeaderBanner?.heroThumbnailRenderer?.thumbnail?.thumbnails?.at(-1)?.url
    || (items[0] ? `https://i.ytimg.com/vi/${items[0].videoId}/hqdefault.jpg` : '');
  return {
    title, owner, cover,
    mediaCount: countDigits ? Number(countDigits) : null,
    items, skipped, continuation: next,
  };
}

module.exports = { fetchPlayer, fetchPlayerWith, innertubeSearch, fetchYtPlaylistPage, pickStreamList, YT_TIMEOUT_MS };

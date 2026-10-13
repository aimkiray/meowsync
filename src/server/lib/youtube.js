// YouTube Innertube 原语——消费方：routes/youtube.js（/resolve、歌单页）、
// services/youtube-resolve.js（闸控感知取流，/stream 与解锁链共用）、
// services/file-downloader.js（服务端下载）。
// 公开 web 客户端 key（嵌在 youtube.com 前端里，供匿名访客调 youtubei）。
// ANDROID/IOS 客户端的 streamingData 直返可播 url（无 signatureCipher 混淆
// 签名）——正是不需要 yt-dlp 的原因；ANDROID 优先，被风控/改版时退 IOS。
// key/客户端版本号摘自 youtube.com 前端与 yt-dlp 上游（会随 YouTube 改版过期——
// resolve 报「无流数据」率升高时对照 yt-dlp 仓库同步 clientVersion）
const { createHash } = require('crypto');
// 懒读而非启动快照：app_settings 覆盖/env 经 lib/settings 解析——设置页
// 热改即刻生效，重启不追陈值（biliCookie/qqCookie 同口径）
const { effectiveValue } = require('./settings');
// YT 出站代理（YT_PROXY）：ytDispatcher() 懒建共享——配了就把
// youtube.com/youtubei 出口全部换道，未配 {} 空展开回落直连
const { ytDispatcher } = require('./yt-proxy');
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

// 代理附加位：代理未配 → 空对象空展开，fetch opts 与旧版逐字节同；
// 在位 → dispatcher 全部 youtube.com 系请求共享同一个 ProxyAgent
// （懒建缓存见 lib/yt-proxy.js）。cookie 与代理正交可叠加——
// 认证头是请求内容，代理是传输通道
const ytFetchOpts = () => {
  const d = ytDispatcher();
  return d ? { dispatcher: d } : {};
};

// browse 端点走 WEB 形态——INNERTUBE_CLIENTS 的移动形态是为 player 选流
// 服务的（ANDROID 优先直返可播 url），歌单页 renderer 结构按桌面端解析
const WEB_CLIENT = {
  name: 'WEB', clientId: 1,
  // clientVersion 跟随 yt-dlp INNERTUBE_CONTEXT['web'] 现值（月度日戳滚动，
  // 认证请求审查更严——陈旧代际差会被风控当信号）。与 DESKTOP_UA 的对齐口径
  // 是代际级：UA 钉发版时在位的 Safari 大版本代（Safari 26 覆盖
  // 2025-09→2026-09，含本戳 2026-07；Intel Mac 停在 15_7_x 安全分支，串恒合法）
  client: { clientName: 'WEB', clientVersion: '2.20260708.00.00', hl: 'zh' },
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
          ...ytFetchOpts(),
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

// ── 可选登录态（YT_COOKIE）─────────────────────────────────────
// 匿名 Innertube 全形态吃反机器人墙（「请登录，以便我们确认你不是聊天
// 机器人」→ /stream 502）——带登录态 cookie 的 WEB 形态档排轮替链最前
// 绕行。cookie 值不出进程：只随认证档发 youtubei 端点，不落日志/错误消息
// 按值去重——覆盖热改后新坏值要重新告警，同一坏值不重复刷日志
let ytCookieWarned = '';
function ytCookie() {
  const raw = (effectiveValue('yt_cookie') || '').trim();
  if (!raw) return '';
  // header 负载要求 latin1——粘贴串带进换行/中文会让 undici 抛头校验错，
  // 全部 YouTube 请求静默 502（设置页写入侧已挡非 ASCII，这里是 env
  // 直配与脏库行双保险；biliCookie 同款消毒）
  const ascii = raw.replace(/[^\x20-\x7e]/g, '');
  if (ascii !== raw && ytCookieWarned !== raw) {
    ytCookieWarned = raw;
    console.warn('[youtube] YT_COOKIE 含控制字符/非 ASCII，已剔除——cookie 值应为纯 ASCII');
  }
  return ascii;
}
// 对外只暴露「是否配了登录态」的布尔面——cookie 值不出进程
const hasYtCookie = () => Boolean(ytCookie());

// SAPISID*HASH 是 Innertube 登录态自证头（yt-dlp _get_sid_authorization_header
// 同款三 scheme 拼装）——签名键按桶各产各的段，不是互相顶替的备选：
//   SAPISIDHASH   ← SAPISID（缺席时 __Secure-3PAPISID 顶位——YouTube 同款回落）
//   SAPISID1PHASH ← __Secure-1PAPISID
//   SAPISID3PHASH ← __Secure-3PAPISID
//   Authorization: <scheme> <ts>_<sha1("<ts> <sid> https://www.youtube.com")> …
// 各段 ' '.join，键缺席则该段略；全缺 → 无 Authorization 裸 Cookie 降级
const YT_ORIGIN = 'https://www.youtube.com';
const SID_SEGMENTS = [
  { scheme: 'SAPISIDHASH', keys: ['SAPISID', '__Secure-3PAPISID'] },
  { scheme: 'SAPISID1PHASH', keys: ['__Secure-1PAPISID'] },
  { scheme: 'SAPISID3PHASH', keys: ['__Secure-3PAPISID'] },
];
// [^;]+ 会吃进 "SAPISID=abc ;SID=x" 的尾空格——trim 后才作签名料；
// 抠出空值继续轮下个键（yt-dlp `or` 链同语义）
const sidValue = (cookie, keys) => {
  for (const name of keys) {
    const m = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    const v = m?.[1]?.trim();
    if (v) return v;
  }
  return '';
};
const sidHash = (scheme, sid, ts = Math.floor(Date.now() / 1000)) =>
  `${scheme} ${ts}_${createHash('sha1')
    .update(`${ts} ${sid} ${YT_ORIGIN}`).digest('hex')}`;

// 认证头构造（yt-dlp generate_api_headers 的凭据面）——player/search/browse
// 三条链共用。Origin 恒定附（真实浏览器同款伴随头）；X-Origin 仅随签名头
// 发——它声明的是 hash 的 origin 绑定，无签名时是空指令。SAPISID 系键全缺
// 降级裸 Cookie（按值记一次 warn）：缺签名头登录态大概率不采信，但照发比
// 直接判死强——其余字段仍可能起访客凭据作用
let sapisidWarnedFor = '';
const ytAuthHeaders = () => {
  const cookie = ytCookie();
  if (!cookie) return null;
  const auth = SID_SEGMENTS.map(({ scheme, keys }) => {
    const sid = sidValue(cookie, keys);
    return sid ? sidHash(scheme, sid) : '';
  }).filter(Boolean).join(' ');
  if (!auth && sapisidWarnedFor !== cookie) {
    sapisidWarnedFor = cookie;
    console.warn('[youtube] YT_COOKIE 缺 SAPISID/__Secure-1PAPISID/__Secure-3PAPISID 签名键——'
      + 'Authorization 头省略，登录态可能不被采信');
  }
  return {
    Origin: YT_ORIGIN,
    Cookie: cookie,
    ...(auth ? { Authorization: auth, 'X-Origin': YT_ORIGIN } : {}),
  };
};

// 认证档构造：UA/context.client 复用 DESKTOP_UA/WEB_CLIENT——
// Authorization↔UA↔context 一致性是风控校验点（VISIONOS 内嵌 UA 同款）。
// auth 标记供各链在轮替尾记账（见 noteAuth*），不进 headers/clientHeaders
const ytAuthForms = () => {
  const headers = ytAuthHeaders();
  if (!headers) return [];
  return [{
    name: 'WEB_AUTH', auth: true, clientId: WEB_CLIENT.clientId,
    client: { ...WEB_CLIENT.client, userAgent: DESKTOP_UA },
    headers: { 'User-Agent': DESKTOP_UA, ...headers },
  }];
};

// 认证档失效负缓存：WEB_AUTH 档连续被拒（过期/失效 cookie 被风控拒采——
// LOGIN_REQUIRED、HTTP 401/403、登录类 alert）到阈盖章 10min，期内三条
// Innertube 链（player/search/browse）都跳过认证档直走匿名形态，窗过期
// 自动重探——失效 cookie 的每请求白打既慢又是风控放大信号
// （visitorDataFailAt 同款负缓存口径）
const AUTH_FAIL_THRESHOLD = 3;
const AUTH_FAIL_TTL_MS = 10 * 60e3;
let authFailStreak = 0;   // 连续凭据被拒计数——成功即清零（连败语义）
let authFailUntil = 0;    // 负缓存截止戳

// 认证档排头、匿名档殿后的轮替链拼装：负缓存窗内跳过认证档——
// ytAuthForms() 在 cookie 未配时本就回空，匿名口径与旧版逐字节同
const formsWithAuth = (anonForms) =>
  (Date.now() < authFailUntil ? anonForms : [...ytAuthForms(), ...anonForms]);

// 认证档一次成功：cookie 有效——连败清零（恢复期内已转匿名，成功说明
// 凭据回春/重配，立即撤负缓存语义回认证排头）
const noteAuthOk = () => { authFailStreak = 0; };
// 认证档一次失败记账：只有 err.authRejected（明确凭据被拒：LOGIN_REQUIRED/
// 401/403/ALERT_AUTH）才计连败到阈盖章。传输层超时/5xx/空壳不算凭据证据
// ——网络抖动把负缓存盖上会让健康 cookie 被冤枉跳过 10min
const noteAuthVerdict = (err) => {
  if (!err?.authRejected) return;
  authFailStreak++;
  if (authFailStreak >= AUTH_FAIL_THRESHOLD) {
    authFailUntil = Date.now() + AUTH_FAIL_TTL_MS;
    console.warn(`[youtube] 认证档连续 ${authFailStreak} 次凭据被拒（cookie 疑似失效），`
      + `${Math.round(AUTH_FAIL_TTL_MS / 60000)} 分钟内跳过认证档改走匿名形态`);
  }
};

// 指定客户端形态直解：clientName 用于「已知 ANDROID 流被闸」的升级路径——
// 跳过无谓的前两形态白打，直接拿 VISIONOS 签名批。
// 每形态至多两试：首试裸匿名，LOGIN_REQUIRED 后补 visitorData 原地重试
async function fetchPlayerWith(videoId, extraSignal, clientName) {
  // 认证档只进默认轮替链（排头，负缓存窗内跳过）——指名形态
  // （VISIONOS 升级路）维持匿名口径不动；cookie 未配时链与旧版逐字节相同
  const forms = clientName
    ? INNERTUBE_CLIENTS.filter(f => f.name === clientName)
    : formsWithAuth(INNERTUBE_CLIENTS);
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
          ...ytFetchOpts(),
        });
        if (!res.ok) {
          const err = new Error(`innertube HTTP ${res.status}`);
          // 401/403 是凭据被拒的明确信号——认证档记账靠它，匿名档挂上无害
          if (res.status === 401 || res.status === 403) err.authRejected = true;
          throw err;
        }
        body = await res.json();
      } catch (e) {
        formErr = lastErr = e;
        if (extraSignal?.aborted) throw new Error('aborted');
        break;  // 网络层失败重试同形态无意义——换下一形态
      }
      const ps = body?.playabilityStatus;
      // OK / LIVE_EDGE 才有流；LOGIN_REQUIRED/ERROR 等带 reason 落 formErr
      if (!ps?.status || ['OK', 'LIVE_EDGE'].includes(ps.status)) {
        if (body?.streamingData) {
          if (form.auth) noteAuthOk();
          return body;
        }
        formErr = lastErr = new Error('无流数据');
        break;
      }
      formErr = lastErr = new Error(`不可播放: ${ps.reason || ps.status}`);
      // LOGIN_REQUIRED 是凭据被拒的明确信号（匿名吃它=bot 墙，认证档吃它
      // =cookie 失效）——负缓存只凭认证档的 verdict 记账
      if (ps.status === 'LOGIN_REQUIRED') formErr.authRejected = true;
      // 匿名被风控 → 补 visitorData 原地重试一次。已带 vd 还吃
      // LOGIN_REQUIRED 时重试是逐字节相同请求——注定重败，直接换形态
      if (ps.status === 'LOGIN_REQUIRED' && attempt === 0 && !vd) continue;
      break;
    }
    if (form.auth) noteAuthVerdict(formErr);
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

// ── 描述文本本家声明解析 ──────────────────────────────────────────
// utaite/翻唱投稿的描述普遍带投稿者自署的出处行（'本家：URL'、'original:
// youtu.be/…'、'原曲 URL'）——同题异曲（'Moonlight' 撞 moumoon 与 shima/
// VY1 同名曲）在标题/作者元数据层不可分，这手第一方声明是唯一能分它的
// 证据。行级语义：标记词与出处须同行（跨行拼接是歌词/名单噪声区）；
// 行序优先、同行取首个非自指链接——多条声明行时首行即作者认定的那条。
// 出处两种形态：YT 链接（{videoId}，可回源反解元数据）与纯文本声明
// '本家：Artist - Title'（{author,title}——niconico 本家/免链声明没有
// 可回源的 videoId）；同行链接形态优先——链可反解，证据比文本硬。
// 拉丁标记词要词边界——'resources'/'originality' 的词干内嵌不误吃
const ORIG_MARK_RE = /本家|原曲|元曲|元動画|原動画|オリジナル|原视频|原影片|\boriginal\b|\bsource\b/i;
// 链接形态与 shared/predicates YT_URL_RES 同口径（watch?v=/youtu.be/
// shorts//embed//live/），但这里要保行内位序逐个扫——extractYouTubeId
// 按表序返回而非按位置，本场景取的是「行内首个链接」
const ORIG_LINK_RE = /youtu\.be\/([A-Za-z0-9_-]{11})|youtube(?:-nocookie)?\.com\/(?:watch\?[^\s]*?\bv=|shorts\/|embed\/|live\/)([A-Za-z0-9_-]{11})/gi;

// 文本声明的标记尾界：标记词后容许一截短连接尾——'様'/'はこちら'/'楽曲'
// 类敬称・助词尾（\W 域即非 [A-Za-z0-9_]，CJK/假名/标点全落此域）与一
// 个短 ASCII 词缀（'MV'/'mix'/'ver' 类），且必须以 ':'/'：' 收口才出
// 声明文本。限长防跨句跳吃（'本家の記事はこちら。詳細：…' 长噪不进门）；
// 'source material:' 这类词组延伸超词缀上限同样不收
const ORIG_DECL_SEP_RE = /^\W{0,8}(?:[A-Za-z]{1,4})?[:：]/;
const ORIG_DECL_PAIRS = { '(': ')', '（': '）', '[': ']', '［': '］', '【': '】', '「': '」', '『': '』' };
// '标记词[:]后的声明尾' → {author,title}|null。清洗只去尾噪不硬猜：
// '#标签'起/裸 URL 起一律截断（走到文本形态的 URL 都不是本家证据——
// YT 链已在链接形态先扫，nico 链/外链只算噪声）；整串成对外层括号
// （'「A - B」'）与尾随括注（' (full ver.)'/'【MV】'，含未闭合半截）
// 逐轮剥除；最后只认 ' - '（半角连字符两侧空白）单分隔——artist/title
// 任一侧空即弃
function parseOriginalDeclText(tail) {
  const sep = ORIG_DECL_SEP_RE.exec(tail);
  if (!sep) return null;
  let s = tail.slice(sep[0].length)
    .split(/(?:^|\s)[#＃]/, 1)[0]
    .split(/https?:\/\/|www\./i, 1)[0]
    .trim();
  // 外层包裹与尾随括注逐轮交替剥——外层剥露出的新尾可能又是括注
  // （'「A - B」（cover）'）；任一轮剥空则声明不成立
  for (;;) {
    let t = s;
    const close = ORIG_DECL_PAIRS[t[0]];
    if (close && t.length > 1 && t.endsWith(close)) {
      // 开括号的配对闭括号恰好落在串尾才算包裹——'(A) - (B)' 首括号
      // 中途闭合不算包裹形态，不剥
      let depth = 0, wrapped = true;
      for (let i = 0; i < t.length; i++) {
        if (t[i] === t[0]) depth++;
        else if (t[i] === close && --depth === 0 && i < t.length - 1) { wrapped = false; break; }
      }
      if (wrapped && depth === 0) t = t.slice(1, -1).trim();
    }
    t = t.replace(/\s*[\(（\[【『「［].*?[\)）\]】』」］]?\s*$/, '').trim();
    if (t === s) break;
    s = t;
    if (!s) return null;
  }
  // ' - '（半角连字符两侧空白）取首个分隔——艺人名罕含 ' - '，曲名常带
  // ' - feat.' 类尾段，首个以后整段归 title
  const d = /^(.*?)\s+-\s+(.+)$/.exec(s);
  if (!d) return null;
  const author = d[1].trim();
  const title = d[2].trim();
  return author && title ? { author, title } : null;
}

// 命中返回判别式联合：链接形态 {videoId} / 文本声明形态 {author,title}
// ——videoId 缺席即文本形态，消费方按有无 videoId 分派是否回源
function parseOriginalRef(description, selfVideoId) {
  for (const line of String(description || '').split(/\r\n|\r|\n/)) {
    const mark = ORIG_MARK_RE.exec(line);
    if (!mark) continue;
    // 同行先扫链接形态（见上——链可回源反解，证据硬度高于文本）
    ORIG_LINK_RE.lastIndex = 0;
    let m;
    while ((m = ORIG_LINK_RE.exec(line))) {
      const id = m[1] || m[2];
      // 自指链跳过（'本家：本稿' 引流/系列互推形态不构成出处证据）
      if (id && id !== selfVideoId) return { videoId: id };
    }
    // 链接缺席（或只剩自指链）→ 退回文本声明形态
    const decl = parseOriginalDeclText(line.slice(mark.index + mark[0].length));
    if (decl) return decl;
  }
  return null;
}

// 本家元数据解析链：描述在手直用（调用方 resolve 期已拿过 player——省
// 一跳回源），缺席才补打 self 的 player 取 shortDescription；命中链接
// 形态再一跳取本家 {title,author}，文本形态声明已内联 author/title——
// 零回本家跳、返回不带 videoId。全链 fail-soft——本家证据是增强不是
// 门禁，任何一环失败（异常/超时/缺字段）按「无声明」交回，不抛
async function resolveOriginalInfoOnce({ videoId, description, signal }) {
  try {
    // 描述缺席时经 fetchVideoBasics 补跳——与发布日解析共享同一跳 player
    // 与同一本 memo（见下「视频基础信息」段）：microformat 与
    // videoDetails.shortDescription 同包回，拆成两条上行链会把 yt_
    // 每曲的一跳翻成两跳。调者经 resolveOriginalInfo 共享计算进场时
    // signal 恒为 null（memo 纪律），等待方在簿外自查自己的 signal
    const desc = typeof description === 'string'
      ? description
      : (await fetchVideoBasics(videoId, signal))?.description || '';
    const ref = parseOriginalRef(desc, videoId);
    if (!ref) return null;
    // 文本声明形态：author/title 已在描述里内联——直交，videoId 缺席
    if (!ref.videoId) {
      const title = String(ref.title || '').trim();
      return title ? { title, author: String(ref.author || '').trim() } : null;
    }
    const vd = (await fetchPlayer(ref.videoId, signal))?.videoDetails || {};
    const title = String(vd.title || '').trim();
    if (!title) return null;
    return { videoId: ref.videoId, title, author: String(vd.author || '').trim() };
  } catch {
    return null;
  }
}

// 进程级 memo（lyric-verify declaredMemo 同款思路提升到库层）：verify/
// match/级联三条链曾各自回源反解同一 videoId——全链共享一次解析。
// 存 promise 而非落地值：并发首调天然单飞去重（await 同一 p 不各打一跳）。
// TTL 按落地值分档——正结果 6h（本家出处几乎不翻转）/ null 10min
// （短窗防「一次抽风固化失败」）；cap 500 FIFO 挤出（Map 键序=插入序）。
// 调用方带 description 时绕过读缓存、算完写回——import 期短描述是一手
// 新料，不让旧缓存挡住当日解析。signal 不进键：结果是 videoId 级事实
const ORIG_MEMO_OK_MS = 6 * 3600e3;
const ORIG_MEMO_NULL_MS = 10 * 60e3;
const ORIG_MEMO_CAP = 500;
const origMemo = new Map();   // videoId -> {p:Promise<res|null>, at}
async function resolveOriginalInfo({ videoId, description, signal }) {
  // 调用方已断连不进场——Once 时代 abort 归 null 的契约收在本函数边界；
  // 早退也避免为死调用方白烧上游跳数（更不占簿位）
  if (signal?.aborted) return null;
  if (typeof description !== 'string') {
    const hit = origMemo.get(videoId);
    if (hit) {
      const res = await hit.p.catch(() => undefined);
      // 命中即单飞——在途与落地同一条 promise；过期/异常即弃不占位
      if (res !== undefined
        && Date.now() - hit.at < (res ? ORIG_MEMO_OK_MS : ORIG_MEMO_NULL_MS)) {
        return res;
      }
      // 身份闸：await 期间带 description 的写通路可能已覆盖上新鲜条目
      // ——过期清理只删自己读到的这条，别把别人的热条目误逐
      if (origMemo.get(videoId) === hit) origMemo.delete(videoId);
    }
  }
  // 共享计算不吃调用方 signal——首调用方的 8s 闸（lyric-verify）/55s
  // 预算（match）/级联 deadline 烙进共享 promise 会让搭车者陪绑，且任一方
  // abort 经 Once catch 归 null 会被 ORIG_MEMO_NULL_MS 固化成 10min 伪
  // null（声明挑战旁路病灶放大）。链内各跳本有 timedSignal 自净超时；
  // 带 description 的写穿路同口径。等待方 await 后自查自己的 signal 再
  // 消费结果——getVisitorData(:95-102) 与 routes/youtube.js
  // ytStreamInflight(:30-46) 同款先例
  const p = resolveOriginalInfoOnce({ videoId, description, signal: null });
  if (origMemo.size >= ORIG_MEMO_CAP && !origMemo.has(videoId)) {
    origMemo.delete(origMemo.keys().next().value);   // 写前挤最旧（FIFO）
  }
  origMemo.set(videoId, { p, at: Date.now() });
  const res = await p;   // Once fail-soft 归 null 不抛——await 安全
  // 等待期间本调用方断连：abort 归 null 的原契约只落在消费侧——结果真值
  // 已落簿（videoId 级事实），后续调用方照吃不浪费这趟回源
  if (signal?.aborted) return null;
  return res;
}
// 测试钩（_clearDeclaredMemo 先例）：memoize 跨用例残留会污染 fetch 计数断言。
// 连带清 basicsMemo——origMemo 产物的描述轴原料正是经 fetchVideoBasics 取的，
// 只清结果簿不清原料簿会让「清后重打」的用例吃到残留 basics（链冷语义）
const _clearOriginalMemo = () => { origMemo.clear(); basicsMemo.clear(); };

// ── 视频基础信息（发布日 + 描述）─────────────────────────────────────
// 源视频发布日与描述共享一条 player 上行链与同一本 memo：
// publishDate/uploadDate 在 microformat.playerMicroformatRenderer 里与
// videoDetails.shortDescription 同包回——publishedAt 解析（匹配/核验的
// 时间证据）与本家声明解析若各走一条链，yt_ 每曲的一跳就翻成两跳。
//
// 数据源取舍：①player 响应 microformat.publishDate（ISO 日粒度，选定）：
// 既有 fetchPlayer 原语直读零成本、惰性路径与声明解析共享一跳、格式非
// 本地化可 Date.parse；②/youtubei/v1/next engagementPanels
// publishDate.simpleText（"Apr 7, 2020"）：本地化文本需语言相关解析、
// 多一个端点多一个反爬面，弃；③watch 页 HTML meta[itemprop=datePublished]
// （ISO）：整页 ~1MB 抓取+HTML 解析太重，弃。microformat 在部分客户端
// 形态的 player 响应里可缺席——归 null，fail-soft。
// publishDate 优先于 uploadDate：定时首播/预售稿的「公开日」是
// publishDate（uploadDate 可远早），倒挂判据吃的是公开日。

// 来源侧日期合法性窗（规格要求各文件就地实现同一公式）：
//   下限 2000-01-01（YT 2005/B 站 2009 上线前不存在真发布日，再早必脏）；
//   上限 now+24h（容忍时钟偏差；真实未来首播/预售超出此界按未知处理——
//   发布日尚在未来极罕见的视频此刻也播不了，损失可忽略）
const sanePublishMs = (v) => {
  const ms = Number(v);
  return Number.isFinite(ms) && ms >= 946684800000 && ms <= Date.now() + 86400e3 ? ms : 0;
};

// memo 纪律与 origMemo（见上「进程级 memo」段）逐条对齐：存 promise 不存
// 落地值（并发首调天然单飞去重）；共享计算不吃调用方 signal（首调用方
// 断连不陪绑搭车者——Once catch 归 null，await 安全）；等待方 await 后
// 自查自己的 signal 再消费；cap 500 FIFO 写前挤最旧。
// TTL 分档锚在「发布日轴是否拿到」上而非整条落地值上：拿到发布日是
// 稳定事实按 6h（与 origMemo 同档——basics 同时喂 description 轴，
// TTL 不得劣于声明解析旧界）；发布日缺席（microformat 缺形态或整条
// 失败）按 10min 负结果短窗——microformat 缺哪种形态是轮替变量不是
// 稳定事实，短窗给下一形态一次翻身机会，别把「这次没拿到」固化成
// 「它没有」
const BASICS_MEMO_OK_MS = 6 * 3600e3;
const BASICS_MEMO_NULL_MS = 10 * 60e3;
const BASICS_MEMO_CAP = 500;
const basicsMemo = new Map();   // videoId -> {p:Promise<basics|null>, at}

// player 响应 → {publishedAt, description}；字段缺席/脏值各自归 null。
// 原始值按型分流：microformat 契约是日期字符串（ISO）走 Date.parse；
// 数字原始值不是日期串——Date.parse('5') 会宽容成 2001-05 脏数据骗过
// 合法性窗，按 ms 轴直接消毒
const basicsOf = (player) => {
  const vd = player?.videoDetails || {};
  const mf = player?.microformat?.playerMicroformatRenderer || {};
  const raw = mf.publishDate || mf.uploadDate;
  const ms = sanePublishMs(typeof raw === 'number' ? raw : Date.parse(String(raw || '')));
  return {
    publishedAt: ms || null,
    description: typeof vd.shortDescription === 'string' ? vd.shortDescription : null,
  };
};

// 单跳自源基础信息——全链 fail-soft，增强证据不抛（LOGIN_REQUIRED/
// 风控/超时/缺字段一律归 null）
async function fetchVideoBasicsOnce(videoId) {
  try { return basicsOf(await fetchPlayer(videoId, null)); }
  catch { return null; }
}

async function fetchVideoBasics(videoId, signal) {
  // 调用方已断连不进场——早退不占簿位（resolveOriginalInfo 同口径）
  if (signal?.aborted) return null;
  const hit = basicsMemo.get(videoId);
  if (hit) {
    const res = await hit.p.catch(() => undefined);
    // 命中即单飞——在途与落地同一条 promise；过期/异常即弃不占位
    if (res !== undefined
      && Date.now() - hit.at < (res?.publishedAt ? BASICS_MEMO_OK_MS : BASICS_MEMO_NULL_MS)) {
      return res;
    }
    // 身份闸：await 期间 player 直给写穿可能已覆盖上新鲜条目——
    // 过期清理只删自己读到的这条，别把别人的热条目误逐
    if (basicsMemo.get(videoId) === hit) basicsMemo.delete(videoId);
  }
  const p = fetchVideoBasicsOnce(videoId);
  if (basicsMemo.size >= BASICS_MEMO_CAP && !basicsMemo.has(videoId)) {
    basicsMemo.delete(basicsMemo.keys().next().value);   // 写前挤最旧（FIFO）
  }
  basicsMemo.set(videoId, { p, at: Date.now() });
  const res = await p;   // Once fail-soft 归 null 不抛——await 安全
  // 等待期间本调用方断连：结果真值已落簿（videoId 级事实），后续调用方
  // 照吃不浪费这趟回源——abort 只落在消费侧
  if (signal?.aborted) return null;
  return res;
}

// 自源视频发布日（epoch ms|null）：player 在手（/resolve 路由解析期刚
// 拿过）→ 同步提取 + 写穿 basicsMemo——一手新料焐热让 match/verify 的
// 惰性消费零上行，旧缓存条目不挡当日解析；否则走 memo 单飞回源。
// 全链 fail-soft——日期是增强证据不是门禁，任何环节失败归 null
async function resolvePublishedAt({ videoId, player, signal }) {
  if (signal?.aborted) return null;
  if (player) {
    const basics = basicsOf(player);
    // 写穿前 merge 已有条目：publishedAt/description 两轴都是单调事实——
    // 本次直给的 player 若落在缺 microformat 形态上，写穿 {null,null} 会把
    // 簿内焓热正条目的日期与描述双轴降级 10min（新 null 覆盖旧真值不更优）。
    // await 在途条目同口径——直给写穿本是 async 函数，等半拍换不降级
    const old = basicsMemo.get(videoId);
    if (old) {
      const prev = await old.p.catch(() => null);   // 在途/落地同一条 p
      basics.publishedAt = basics.publishedAt ?? prev?.publishedAt ?? null;
      basics.description = basics.description ?? prev?.description ?? null;
    }
    if (basicsMemo.size >= BASICS_MEMO_CAP && !basicsMemo.has(videoId)) {
      basicsMemo.delete(basicsMemo.keys().next().value);   // 写前挤最旧（FIFO）
    }
    basicsMemo.set(videoId, { p: Promise.resolve(basics), at: Date.now() });
    // 等待 merge 期间本调用方断连：merge 真值已落簿（videoId 级事实），
    // abort 只落在消费侧——后续调用方照吃不浪费
    return signal?.aborted ? null : basics.publishedAt;
  }
  return (await fetchVideoBasics(videoId, signal))?.publishedAt ?? null;
}
// 测试钩（_clearOriginalMemo 先例）：basics 簿位独立清——只读发布日/
// 描述轴的用例不该被迫拖 origMemo 一起冷
const _clearBasicsMemo = () => basicsMemo.clear();

// ── 曲库搜索 / 相关（search/next 端点）────────────────────────────────
// ownerText/shortBylineText/longBylineText runs 里的频道端点（UC 前缀
// browseId）即 channelId——videoRenderer/compactVideoRenderer 同位字段名相同
const channelIdOf = (v) => {
  for (const byline of [v.ownerText, v.shortBylineText, v.longBylineText]) {
    for (const r of byline?.runs || []) {
      const bid = r?.navigationEndpoint?.browseEndpoint?.browseId;
      if (typeof bid === 'string' && bid.startsWith('UC')) return bid;
    }
  }
  return null;
};

// videoRenderer/compactVideoRenderer → 通用条目 {videoId,title,owner,
// durationSec,channelId?,publishedTimeText?}。publishedTimeText 是本地化
// 相对时间文本（'3 年前'）——原样透传不解析（ISO 发布日另走
// resolvePublishedAt/microformat 轴）；channelId/publishedTimeText 在场才挂键
const videoItemOf = (v) => {
  // lengthText 两种形态都出现：simpleText（web）或 runs（compact）——
  // 统一走 rendererText；部分形态直接给 lengthSeconds 数字
  const lt = rendererText(v.lengthText);
  // +null=0 会被 isFinite 当合法时长（0s 反而绕过下游对账）——null/空串先归 NaN
  const ls = v.lengthSeconds == null || v.lengthSeconds === ''
    ? NaN : Number(v.lengthSeconds);
  const channelId = channelIdOf(v);
  const publishedTimeText = rendererText(v.publishedTimeText);
  return {
    videoId: v.videoId,
    title: rendererText(v.title),
    owner: rendererText(v.ownerText) || rendererText(v.shortBylineText),
    durationSec: Number.isFinite(ls) && ls > 0 ? ls
      : (lt ? lt.split(':').reduce((s, p) => s * 60 + (+p || 0), 0) : null),
    ...(channelId ? { channelId } : {}),
    ...(publishedTimeText ? { publishedTimeText } : {}),
  };
};

// 续页 token 提取（fetchYtPlaylistPage 的哨兵槽+plcToken 兜底模式泛化）：
// continuationItemRenderer/continuationItemViewModel/nextContinuationData/
// reloadContinuationData 是明确的加载更多语境——哨兵位优先收；
// *Continuation 尾段容器与 continuations 数组兜底（哨兵未命中才启用）。
// 任意节点的裸 continuationCommand 不裸收——条目内「继续观看」类非分页
// 指令会被当翻页游标（产出死循环续页请求，与歌单页注释同口径）
const contTokenOf = (c) => c?.continuation
  || c?.continuationEndpoint?.continuationCommand?.token
  || c?.continuationCommand?.token
  || (Array.isArray(c?.continuations) ? c.continuations : [])
    .map(x => x?.nextContinuationData?.continuation
      || x?.nextContinuationData?.continuationEndpoint?.continuationCommand?.token
      || x?.continuationEndpoint?.continuationCommand?.token
      || x?.continuationCommand?.token)
    .find(Boolean)
  || null;
// 哨兵容器（continuationItemRenderer/continuationItemViewModel）内 token 槽
// 随版本漂移——continuationEndpoint/commandExecutorCommand/button.command/
// innertubeCommand 各家形态都在容器内递归收；容器本体就是分页语境，裸槽敢收
const deepContToken = (n) => {
  if (!n || typeof n !== 'object') return null;
  if (Array.isArray(n)) {
    for (const i of n) { const t = deepContToken(i); if (t) return t; }
    return null;
  }
  const t = (typeof n.continuation === 'string' ? n.continuation : null)
    || n.continuationCommand?.token
    || n.continuationEndpoint?.continuationCommand?.token
    || n.nextContinuationData?.continuation
    || n.nextContinuationData?.continuationEndpoint?.continuationCommand?.token;
  if (t) return t;
  for (const k of Object.keys(n)) {
    // 哨兵容器内嵌的条目节点不下钻——条目内的「继续观看」类指令不是分页游标
    if (k === 'videoRenderer' || k === 'compactVideoRenderer' || k === 'lockupViewModel') continue;
    const r = deepContToken(n[k]);
    if (r) return r;
  }
  return null;
};

// 登录/风控类 alert 文本判据（sign in/bot 语义）——innertubePost 与
// fetchYtPlaylistPage 共用口径：命中记 ALERT_AUTH（凭据被拒，挂
// authRejected 供认证档负缓存记账）；未命中的 ERROR alert 落
// ALERT_ERROR——上游终态，逐字节重发同结果，不烧轮转
const ALERT_AUTH_RE = /sign in|log ?in|bot|登录|登入|验证|確認/i;

// youtubei POST 轮替共用段（search/next 同构）：认证档排头+匿名档殿后、
// 负缓存窗内跳认证（formsWithAuth）、vd/clientHeaders/timedSignal/代理
// 接线、401-403 凭据证据打 authRejected 旗、认证档成败记账
// （noteAuthOk/noteAuthVerdict）——与 fetchPlayer/旧搜索同口径。
// parseBody 把回包收成业务产物——空壳/无效响应抛错按失败轮转下一形态
async function innertubePost(endpoint, anonForms, fields, extraSignal, parseBody) {
  let lastErr = null;
  for (const form of formsWithAuth(anonForms)) {
    if (extraSignal?.aborted) throw new Error('aborted');
    const vd = freshVisitorData();
    // needsVisitor 形态（VISIONOS）无匿名通路——缓存无 vd 时发了必败，
    // 跳过换下一形态（fetchPlayer 轮替 :267-272 同款口径）
    if (form.needsVisitor && !vd) continue;
    try {
      const res = await fetch(`https://www.youtube.com/youtubei/v1/${endpoint}?key=${INNERTUBE_KEY}`, {
        method: 'POST',
        headers: clientHeaders(form, vd),
        body: JSON.stringify({
          context: { client: vd ? { ...form.client, visitorData: vd } : form.client },
          ...fields,
        }),
        signal: timedSignal(extraSignal),
        ...ytFetchOpts(),
      });
      if (!res.ok) {
        const err = new Error(`innertube ${endpoint} HTTP ${res.status}`);
        // 401/403 是凭据被拒的明确信号——认证档记账靠它，匿名档挂上无害
        if (res.status === 401 || res.status === 403) err.authRejected = true;
        throw err;
      }
      const parsed = await res.json();
      // search/next 同样回 alerts[].alertRenderer——以前它混在业务解析里
      // 被当空壳轮转，认证档吃登录墙时 authRejected 缺席导致负缓存永不
      // 记账（死 cookie 每请求白打三档）。判据与 fetchYtPlaylistPage 同款：
      // type==='ERROR' 或文本含 sign-in/bot 语义即收；登录语义挂
      // authRejected+ALERT_AUTH，其余 ERROR 落 ALERT_ERROR 终态直抛
      const alert = (parsed?.alerts || []).find(a => {
        const r = a?.alertRenderer;
        return r?.type === 'ERROR' || ALERT_AUTH_RE.test(rendererText(r?.text));
      });
      if (alert) {
        const text = rendererText(alert.alertRenderer.text);
        const err = new Error(`innertube ${endpoint} alert: ${text || 'ERROR'}`);
        err.upstreamCode = ALERT_AUTH_RE.test(text) ? 'ALERT_AUTH' : 'ALERT_ERROR';
        // ALERT_AUTH 是凭据被拒的明确信号——认证档记账靠它，匿名档挂上无害
        if (err.upstreamCode === 'ALERT_AUTH') err.authRejected = true;
        throw err;
      }
      const result = parseBody(parsed);
      if (form.auth) noteAuthOk();
      return result;
    } catch (e) {
      lastErr = e;
      if (extraSignal?.aborted) throw new Error('aborted');
      // ALERT_ERROR 是上游终态（与歌单页同口径）——匿名重试逐字节同结果
      // 不重复打；ALERT_AUTH/空壳/传输错才可能换形态翻身
      if (e.upstreamCode === 'ALERT_ERROR') throw e;
      if (form.auth) noteAuthVerdict(e);
      console.warn(`[youtube] ${form.name} 客户端 ${endpoint} 失败:`, e.message);
    }
  }
  throw lastErr || new Error(`所有客户端形态 ${endpoint} 均失败`);
}

// 关键词搜索：顶栏 yt: 曲库搜索与解锁层「网易曲目 → YouTube 候选」共用
// 入口（替代 unm 的 yt-dlp spawn 链）。候选期即拿 lengthSeconds——比
// ytsearch1 dump-json 后盲探测更强。
// 双签名：对象形 (keyword, {signal, limit, continuation}) 回
// {items,continuation}——深挖游标新契约；旧位置形 (keyword, signal, limit)
// 回裸 items 数组——解锁链调用点（unlock 域零改）与既有直调桩原样可用。
// continuation 是不透明上游翻页 token——带 token 时请求只发
// {context,continuation}（query/params 已烙在 token 里，重发会双重过滤），
// 响应根换成 continuationContents 系（四根全扫与歌单页同口径）
async function innertubeSearch(keyword, opts, legacyLimit) {
  const o = opts && typeof opts === 'object' && typeof opts.addEventListener !== 'function'
    ? opts
    : { signal: opts ?? null, limit: legacyLimit ?? 5, legacy: true };
  const { signal: extraSignal, limit = 5, continuation = null } = o;
  const seen = new Set(); // 同 videoId 会在主结果与相关推荐栏重复出现——去重防重复打 player
  const parseBody = (body) => {
    const items = [];
    let next = null;    // 哨兵槽 token（明确分页语境，优先）
    let nextAlt = null; // 容器槽 token 兜底（哨兵未命中才启用）
    // 递归扫三族条目节点：videoRenderer/compactVideoRenderer（旧形态，
    // web/移动客户端）与 lockupViewModel（ViewModel 迁移后的条目卡——
    // 与 /next、歌单页共用 lockupItem 解析）——twoColumnSearchResultsRenderer
    // 的嵌套深度随 YouTube 改版漂移，按节点形状收集比按路径深取稳。
    // limit 满而 token 未到时继续扫——条目槽在 token 槽前，先满就停会
    // 漏游标掐死深挖。
    // 收集闸统一（相关面同款）：合法 11 位 videoId + 有标题 + 非失效哨兵
    // 标题——漏收 lockup 形态的响应 items 全空，会被「结构在位零条目」
    // 误判成真实空结果（挡掉轮替、空表如实下发）
    const pushItem = (it) => {
      if (it && items.length < limit && /^[A-Za-z0-9_-]{11}$/.test(it.videoId || '')
        && it.title && !DEAD_TITLE.test(it.title) && !seen.has(it.videoId)) {
        seen.add(it.videoId);
        items.push(it);
      }
    };
    const walk = (node) => {
      if (!node || typeof node !== 'object' || (items.length >= limit && next)) return;
      if (Array.isArray(node)) { for (const it of node) walk(it); return; }
      const v = node.videoRenderer || node.compactVideoRenderer;
      if (v) pushItem(videoItemOf(v));
      if (node.lockupViewModel) pushItem(lockupItem(node.lockupViewModel));
      if (node.continuationItemRenderer || node.continuationItemViewModel) {
        const t = deepContToken(node.continuationItemRenderer || node.continuationItemViewModel);
        if (t && !next) next = t;
      }
      const sentinel = node.nextContinuationData?.continuation
        || node.nextContinuationData?.continuationEndpoint?.continuationCommand?.token
        || node.reloadContinuationData?.continuation
        || node.reloadContinuationData?.continuationEndpoint?.continuationCommand?.token;
      if (sentinel && !next) next = sentinel;
      if (!nextAlt) {
        // 续页容器槽位随版本漂移（itemSectionContinuation/
        // sectionListContinuation 等尾段、continuations 数组）——
        // 按容器形状兜底，哨兵未命中才启用
        for (const k of Object.keys(node)) {
          if (/Continuation$/.test(k) && node[k] && typeof node[k] === 'object') {
            nextAlt = contTokenOf(node[k]);
            if (nextAlt) break;
          }
        }
        if (!nextAlt && Array.isArray(node.continuations)) nextAlt = contTokenOf(node);
      }
      for (const key of Object.keys(node)) {
        // 已消费的条目节点不再下钻——其内部字段（角标/端点）里可能嵌着
        // 非分页 continuation-ish 结构，裸收会误当翻页游标
        if (key === 'videoRenderer' || key === 'compactVideoRenderer' || key === 'lockupViewModel') continue;
        walk(node[key]);
      }
    };
    // 续页响应根字段随版本漂移（onResponseReceivedActions/Endpoints /
    // continuationContents）——四棵候选根都扫，各自子树不重叠
    const roots = [body?.contents, body?.onResponseReceivedActions,
      body?.onResponseReceivedEndpoints, body?.continuationContents];
    for (const r of roots) walk(r);
    // 四根全空=风控空壳（200+无内容骨架）——轮转下一形态与 fetchPlayer
    // 「无 streamingData 即换形态」同口径；结构在位但零视频项是真实空
    // 结果（无此关键词），按空表交回不当上游故障
    if (!items.length && !roots.some(Boolean)) {
      throw new Error('搜索结果无候选（空壳响应/风控）');
    }
    return { items, continuation: next || nextAlt || null };
  };
  const r = await innertubePost('search', INNERTUBE_CLIENTS,
    // sp=EgIQAQ== 对应「仅视频」过滤——歌单/频道卡片不占候选位
    continuation ? { continuation } : { query: String(keyword || ''), params: 'EgIQAQ==' },
    extraSignal, parseBody);
  return o.legacy ? r.items : r;
}

// 选流：音频默认优先 mp4a/m4a 容器（audio/mp4——webm opus 在 Safari 的
// <audio> 不通）；prefer='best'（下载档）直接按 bitrate 排全部音频——
// opus itag251（~136k 全频带到 20kHz）优于 aac itag140（~130k 且 16kHz
// 低通截断），播放器兼容性由用户本地承担，归档就该拿第一代完整频带。
// video 取 adaptive avc1（H.264 全浏览器可放），按分辨率/bitrate 降序。
// signatureCipher 混淆流（无 url 只有签名参数）跳过——本服务不做签名反解
function pickStreamList(data, kind, prefer = '', opts = {}) {
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
  // adaptiveOnly（下载链）：合流档自带音轨，混进 videos 会让 ffmpegMux 产出
  // 双音轨 mp4——下载侧合流由 file-downloader 的 progressive 兜底相位接管，
  // 这里只交纯净 video-only 轨；播放链（未传参）保持合流兜底旧语义。
  // 编码面放开：>1080p（1440p/2160p/HDR）只发 vp9/av01 的 video/webm——
  // vp09/av01 进 mp4 是合法封装（ffmpeg -c copy），像素更高的非 avc1 档
  // 反超；同像素仍优先 avc1 保浏览器直放，决胜序：像素→编码→fps→码率
  if (opts.adaptiveOnly) {
    const avcRank = (f) => (f.mimeType || '').includes('avc1') ? 1 : 0;
    return adaptive.filter(f => usable(f) && (f.mimeType || '').startsWith('video/'))
      .sort((a, b) => ((b.height || 0) * (b.width || 0)) - ((a.height || 0) * (a.width || 0))
        || avcRank(b) - avcRank(a)
        || (b.fps || 0) - (a.fps || 0)
        || (b.bitrate || 0) - (a.bitrate || 0));
  }
  // progressive 兜底同样限 video/mp4——webm 合并流 Safari 放不了，宁缺毋滥
  // （hasVideo 语义 = 浏览器解得动的流存在）
  const mp4Progressive = progressive.filter(f =>
    usable(f) && (f.mimeType || '').startsWith('video/mp4'));
  // 同像素决胜帧率再比码率——1080p60 与 1080p30 同面积，裸像素序撞上谁
  // 在前取谁（Innertube 序不定）；fps/bitrate 都是上游直给字段，缺省 0
  return (avc.length ? avc : mp4Progressive)
    .slice().sort((a, b) => ((b.height || 0) * (b.width || 0)) - ((a.height || 0) * (a.width || 0))
      || (b.fps || 0) - (a.fps || 0)
      || (b.bitrate || 0) - (a.bitrate || 0));
}

// renderer 树通用读文本——runs 拼接优先，simpleText 兜底
const rendererText = (n) => (n?.runs || []).map(r => r.text).join('') || n?.simpleText || '';

// 失效条目标题哨兵（各语言形态）——lockup 形态里失效项仍带 videoId，
// 只能靠标题判；整串匹配防 'Private Eyes' 类真标题误杀；无标题/无
// videoId 的节点同样不可播。歌单页与 /next 相关面共用
const DEAD_TITLE = /^\s*[\[【「『(]?\s*(?:(?:deleted|private|removed|unavailable)\s*video|已[删刪]除的?[视影]片|已移除的?[视影]片|已设为私享的?[视影]片|私享[视影]片|私人[视影]片|无法播放的?[视影]片|削除された(?:動画|ビデオ)|삭제된 동영상)\s*[\]】」』)]?\s*$/i;
// 找 part 里的频道跳转（browseEndpoint.browseId='UC…'）——比按语言
// 匹配「by/创建者」前缀更稳（lockup 行与 pageHeader 共用）
const channelBrowseId = (m) => {
  if (!m || typeof m !== 'object') return null;
  if (Array.isArray(m)) {
    for (const i of m) { const r = channelBrowseId(i); if (r) return r; }
    return null;
  }
  const bid = m.browseEndpoint?.browseId;
  if (typeof bid === 'string' && bid.startsWith('UC')) return bid;
  for (const k of Object.keys(m)) { const r = channelBrowseId(m[k]); if (r) return r; }
  return null;
};
const hasChannelLink = (m) => Boolean(channelBrowseId(m));
const parseSecs = (t) => /^\d+(?::\d{1,2})+$/.test(t || '')
  ? t.split(':').reduce((s, p) => s * 60 + (+p || 0), 0) : 0;

// 新版 lockupViewModel（ViewModel 架构迁移后的条目形态）→
// {videoId,title,owner,durationSec,channelId?}：contentId=videoId；标题在
// lockupMetadataViewModel.title.content；频道在 metadataRows 首行首个带
// UC 跳转的文本 part；时长在缩略图角标 badge。歌单页与 /next 相关面共用
// ——renderer 形态同族；非 VIDEO 卡（频道/合集）归 null 由调用方判
const lockupItem = (lv) => {
  if (lv.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO') return null; // 频道/合集卡不算失效
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
  // 频道名：优先带 UC 跳转的 part（合并行里视图计数无频道端点）——
  // browseId 值顺带就是 channelId，身份证据与 id 一处取；
  // 兜底首文本 part 按「•」截段剥尾噪
  const row0 = rows[0]?.metadataParts || [];
  const partText = (p) => p?.text?.content
    || p?.avatarStack?.avatarStackViewModel?.text?.content || p?.avatarStack?.text?.content || '';
  let channelId = null;
  const ownerPart = row0.find(p => {
    const bid = channelBrowseId(p?.text?.commandRuns || p?.avatarStack?.avatarStackViewModel?.text?.commandRuns);
    if (bid) { channelId = bid; return true; }
    return false;
  }) || row0.find(p => partText(p));
  const owner = partText(ownerPart).split(/\s*[•·]\s*/)[0].trim();
  return {
    videoId: lv.contentId, title: meta?.title?.content || '', owner,
    durationSec: parseSecs(badge),
    ...(channelId ? { channelId } : {}),
  };
};

// 歌单页一页：首屏走 browseId=VL<listId>，续页走 continuation token。
// 条目节点递归收集（嵌套深度随 YouTube 改版漂移，按节点形状取比按路径
// 深取稳——与 innertubeSearch 同款防御）。失效条目（isPlayable:false/
// 无 videoId/sentinel 标题）计入 skipped 透出给前端
async function fetchYtPlaylistPage({ listId, continuation, extraSignal }) {
  const vd = freshVisitorData();
  // cookie 在位时认证档打头、匿名 WEB 档殿后（头构造与 player/search 共用
  // ytAuthForms，负缓存窗内认证档被跳过）——bot 墙若按端点生效，歌单导入
  // 同受益。认证档失败回落匿名再试一次：过期/畸形 cookie 不该打死本来
  // 匿名就能过的歌单导入
  const forms = formsWithAuth([WEB_CLIENT]);
  let body = null;
  let lastErr = null;
  for (const form of forms) {
    if (extraSignal?.aborted) throw new Error('aborted');
    try {
      const res = await fetch(`https://www.youtube.com/youtubei/v1/browse?key=${INNERTUBE_KEY}`, {
        method: 'POST',
        headers: clientHeaders(form, vd),
        body: JSON.stringify({
          context: { client: vd ? { ...form.client, visitorData: vd } : form.client },
          // VL 前缀输入已是 browseId 形态——幂等而非二次加前缀
          ...(continuation ? { continuation } : { browseId: /^VL/i.test(listId) ? listId : `VL${listId}` }),
        }),
        signal: timedSignal(extraSignal),
        ...ytFetchOpts(),
      });
      if (!res.ok) {
        const err = new Error(`innertube browse HTTP ${res.status}`);
        if (res.status === 401 || res.status === 403) err.authRejected = true;
        throw err;
      }
      const parsed = await res.json();
      // 私有/不存在/被删的歌单：200 + alerts[].alertRenderer.type='ERROR'
      // ——对用户是「不可访问」语义，挂 upstreamCode 供路由映射 404；
      // 登录/风控类 alert（sign in/bot）是本机信誉问题而非歌单问题，分档 502
      const alert = (parsed?.alerts || []).find(a => a?.alertRenderer?.type === 'ERROR');
      if (alert) {
        const text = rendererText(alert.alertRenderer.text);
        const e = new Error(`播放列表不可用: ${text || 'ERROR'}`);
        e.upstreamCode = ALERT_AUTH_RE.test(text) ? 'ALERT_AUTH' : 'ALERT_ERROR';
        // ALERT_AUTH 是凭据被拒的明确信号——认证档负缓存记账靠它
        if (e.upstreamCode === 'ALERT_AUTH') e.authRejected = true;
        throw e;
      }
      // 200 但三棵内容根与 header 全空——风控空壳/响应畸形，不是「歌单不存在」
      if (!parsed?.header && !parsed?.contents && !parsed?.onResponseReceivedActions
        && !parsed?.onResponseReceivedEndpoints && !parsed?.continuationContents) {
        const e = new Error('innertube browse 空壳响应');
        e.upstreamCode = 'EMPTY_SHELL';
        throw e;
      }
      body = parsed;
      if (form.auth) noteAuthOk();
      break;
    } catch (e) {
      lastErr = e;
      if (extraSignal?.aborted) throw new Error('aborted');
      // ALERT_ERROR 是歌单级终态（私有/不存在）——匿名重试逐字节同结果不
      // 重复打；ALERT_AUTH/空壳/传输错是凭据级失败，匿名档还有一次机会
      if (e.upstreamCode === 'ALERT_ERROR') throw e;
      if (form.auth) noteAuthVerdict(e);
      console.warn(`[youtube] ${form.name} 客户端歌单页抓取失败:`, e.message);
    }
  }
  if (!body) throw lastErr || new Error('innertube browse 各形态均失败');

  const items = [];
  const seen = new Set();
  let skipped = 0;
  let next = null;
  const pushItem = (videoId, title, owner, durationSec) => {
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId || '') || !title || DEAD_TITLE.test(title)) {
      skipped++; return;
    }
    if (seen.has(videoId)) return;
    seen.add(videoId);
    items.push({ videoId, title, owner: owner || '', durationSec });
  };
  // 新版 lockupViewModel（ViewModel 架构迁移后的条目形态）——条目解析与
  // /next 相关面共用 lockupItem；pushItem 负责失效判定/skipped 记账
  // （非 VIDEO 卡 lockupItem 归 null——频道/合集卡不算失效）
  const parseLockup = (lv) => {
    const it = lockupItem(lv);
    if (it) pushItem(it.videoId, it.title, it.owner, it.durationSec);
  };
  let nextAlt = null; // playlistVideoListContinuation 已知槽位兜底（哨兵优先）
  // 歌单续页续流指令只出现在已知槽位——任意节点上的裸
  // continuationEndpoint/continuationCommand 可能是条目内「继续观看」等
  // 非分页指令，裸收会把无关 token 当翻页游标（产出死循环续页请求）
  const plcToken = (plc) => plc?.continuation
    || plc?.continuationEndpoint?.continuationCommand?.token
    || plc?.continuationCommand?.token
    || (Array.isArray(plc?.continuations) ? plc.continuations : [])
      .map(x => x?.nextContinuationData?.continuation
        || x?.nextContinuationData?.continuationEndpoint?.continuationCommand?.token
        || x?.continuationEndpoint?.continuationCommand?.token
        || x?.continuationCommand?.token)
      .find(Boolean)
    || null;
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
    if (!nextAlt && node.playlistVideoListContinuation) {
      nextAlt = plcToken(node.playlistVideoListContinuation);
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

// /next 端点：watch 页相关视频（secondaryResults——实机 ~20 条
// lockupViewModel）。renderer 形态与歌单页同族：lockupViewModel 为主
//（ViewModel 迁移后的条目形态，解析器与 fetchYtPlaylistPage 共用
// lockupItem），compactVideoRenderer 兜底；radioRenderer.playlistId 与
// PLAYLIST 类 RD 前缀 lockup 都是 YouTube Mix 自动生成单——单列字段
// 回传不混进视频 items。
// 收集域收窄到 secondaryResults 键位 + 续页容器：主列 results.results
// 里的结构化描述/商品卡（engagement panel 系）同样长 lockupViewModel，
// contents 全树扫会把主列卡混进 related——M2 复审发现。
// WEB 形态+formsWithAuth 轮替（桌面端 renderer 结构——与 browse 歌单页
// 同口径），authRejected/空壳记账与 innertubeSearch 一致（innertubePost
// 共用段）
const WATCH_NEXT_CAP = 40;  // 收集帽：related 常态 ~20 条，病理回包防膨胀
async function fetchWatchNext(videoId, extraSignal) {
  const seen = new Set();
  const parseBody = (body) => {
    const items = [];
    let mixPlaylistId = null;
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { for (const it of node) walk(it); return; }
      const lv = node.lockupViewModel;
      if (lv) {
        // YouTube Mix 的 lockup 形态：PLAYLIST 卡 + RD 前缀 contentId——
        // 与 radioRenderer.playlistId 二取一（先到先采，同类 id 同源）
        if (!mixPlaylistId && lv.contentType === 'LOCKUP_CONTENT_TYPE_PLAYLIST'
          && /^RD/.test(lv.contentId || '')) {
          mixPlaylistId = lv.contentId;
        }
        const it = lockupItem(lv);
        // 失效/私有卡（哨兵标题）与畸形 id 按歌单页口径剔除——不计
        // skipped（相关面非导入面，无透出消费方）
        if (it && items.length < WATCH_NEXT_CAP
          && /^[A-Za-z0-9_-]{11}$/.test(it.videoId || '')
          && it.title && !DEAD_TITLE.test(it.title) && !seen.has(it.videoId)) {
          seen.add(it.videoId);
          items.push(it);
        }
      }
      const v = node.compactVideoRenderer;
      if (v?.videoId && !seen.has(v.videoId) && items.length < WATCH_NEXT_CAP) {
        const it = videoItemOf(v);
        if (it.title && !DEAD_TITLE.test(it.title)) {
          seen.add(v.videoId);
          items.push(it);
        }
      }
      // YouTube Mix（radioRenderer 自动生成单）——单列字段不混视频 items
      if (!mixPlaylistId && typeof node.radioRenderer?.playlistId === 'string') {
        mixPlaylistId = node.radioRenderer.playlistId;
      }
      for (const key of Object.keys(node)) {
        // 已消费的条目节点不再下钻（search walk 同款口径）
        if (key === 'compactVideoRenderer' || key === 'lockupViewModel') continue;
        walk(node[key]);
      }
    };
    // 相关域定位：secondaryResults 键位（twoColumnWatchNextResults 下）与
    // 续页容器（*Continuation 尾段键/continuations[] 数组）才是 related
    // 语境——只把它们作收集根，其余子树（含主列）留在外面
    const scopeRoots = [];
    const findScope = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { for (const i of node) findScope(i); return; }
      for (const k of Object.keys(node)) {
        if (k === 'secondaryResults' || k === 'continuations' || /Continuation$/.test(k)) {
          // 命中的子树整体作收集根，不再向内找根（walk 会覆盖其全域）
          if (node[k] && typeof node[k] === 'object') scopeRoots.push(node[k]);
        } else {
          findScope(node[k]);
        }
      }
    };
    findScope(body?.contents);
    for (const r of scopeRoots) walk(r);
    // 有效 videoId 恒有相关条——四根全空按空壳轮转（与 search 同口径）；
    // 结构在位但零条目（私享/下架稿的退化页）按空表交回
    const roots = [body?.contents, body?.onResponseReceivedActions,
      body?.onResponseReceivedEndpoints, body?.continuationContents];
    if (!items.length && !roots.some(Boolean)) {
      throw new Error('watch next 空壳响应（无相关条目/风控）');
    }
    return { items, mixPlaylistId };
  };
  return innertubePost('next', [WEB_CLIENT], { videoId }, extraSignal, parseBody);
}

// 搜索建议（typeahead）：suggestqueries.google.com 的 firefox client 路径
// 回纯 JSON [q,[suggestions…]]——clients6.youtube.com 的同参端点回
// window.google.ac.h(...) JSONP 壳，别走那条。代理面：google.com 与
// youtube.com 同墙——ytFetchOpts 不查域名，配了 YT_PROXY 的部署直连必
// 超时，挂上让代理顺带承运
async function ytSuggest(q, extraSignal) {
  if (extraSignal?.aborted) throw new Error('aborted');
  const url = 'https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q='
    + encodeURIComponent(String(q || ''));
  const res = await fetch(url, {
    headers: { 'User-Agent': DESKTOP_UA },
    signal: timedSignal(extraSignal, 5000), // typeahead 语义：5s 预算
    ...ytFetchOpts(),
  });
  if (!res.ok) throw new Error(`yt suggest HTTP ${res.status}`);
  const j = await res.json().catch(() => null);
  if (extraSignal?.aborted) throw new Error('aborted');
  // 契约 [q,[suggestions…]]——JSONP 壳/非数组载荷防御性归空
  return {
    suggestions: (Array.isArray(j?.[1]) ? j[1] : [])
      .filter(s => typeof s === 'string' && s),
  };
}

module.exports = { fetchPlayer, fetchPlayerWith, innertubeSearch, fetchWatchNext, ytSuggest, fetchYtPlaylistPage, pickStreamList, hasYtCookie, parseOriginalRef, resolveOriginalInfo, _clearOriginalMemo, resolvePublishedAt, _clearBasicsMemo, YT_TIMEOUT_MS };

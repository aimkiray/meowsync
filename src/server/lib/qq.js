// QQ 音乐 web 端协议原语——u.y.qq.com musicu.fcg 统一网关 + c.y.qq.com 旧式 fcg。
// 纯 fetch 自研（零依赖）：协议口径参照 yt-dlp extractor/qqmusic.py（公有领域）、
// Meting(MIT) tencent provider、listen1 qq.js 的调用形态——各上游接口 2019 年
// 至今骨架稳定。匿名 uin=0 可得 C400/M500 档；无损/VIP 档需 QQ_COOKIE（uin +
// qm_keyst/qqmusic_key）。注意 vkey 与 (guid,uin,请求方IP) 绑定——播放端必须
// 每次都重取，且最终拉流要么本进程要么经 /audio-proxy 回源（不能拿 vkey 的
// 机器与拉流的机器不同 IP）。
const { normalizeOutboundUrl, resolvesToPublicIp, makeGuardedLookup } = require('./net-guard');
const { SONGMID_RE, pickQqFromUrl } = require('../../shared/predicates.js');
const { createHash } = require('crypto');
const { Agent } = require('undici');

const QQ_TIMEOUT_MS = 15000;

// ── Cookie：可选登录态（VIP/无损档只对登录账号下发）。只发 *.qq.com 域。
// 懒读而非启动快照：续期会把新凭据写 process.env.NEW_QQ_COOKIE
// （qm_keyst ~3 天过期，到期前 10min 窗口内自动续）——每次请求读最新值。
// 与 BILI_COOKIE 同款 ASCII 清洗——粘贴串带进换行/中文会让 undici 头校验
// 抛错，全部 QQ 请求静默 502
let cookieWarned = false;
function qqCookie() {
  const raw = (process.env.NEW_QQ_COOKIE || process.env.QQ_COOKIE || '').trim();
  if (!raw) return '';
  const ascii = raw.replace(/[^\x20-\x7e]/g, '');
  if (ascii !== raw && !cookieWarned) {
    cookieWarned = true;
    console.warn('[qq] QQ_COOKIE 含控制字符/非 ASCII，已剔除——cookie 值应为纯 ASCII');
  }
  maybeRenewQqCookie(ascii);
  return ascii;
}
const hasQqCookie = () => Boolean(qqCookie());

// musickey_createtime + 3d（秒）是 qm_keyst 生命周期（unm 同款口径）；
// 到期前 600s 窗口内触发续期——老 key 在此窗口仍有效，后台续期无缝交接
const QQ_KEY_LIFETIME_SEC = 259200;
const QQ_RENEW_WINDOW_SEC = 600;
// 失败退避：refresh_token 死了/上游持续拒时，没有冷却会变成「每个 QQ
// 请求一次 Login 外呼」——频控维度上比不续期更糟
const QQ_RENEW_COOLDOWN_MS = 10 * 60 * 1000;
let renewalInflight = null;
let lastRenewAttemptAt = 0;

// LoginServer/Login 用 refresh_token 换新 musickey，回写 NEW_QQ_COOKIE。
// 只在 qqCookie() 里惰性触发——读 cookie 的请求自然带上续期检查。
// 字段名兼容真实导出形态：QQ 网页 cookie 的 refresh 键是 psrf_ 前缀族
// （unm 靠无锚定子串匹配顺带命中）；微信态走 wxrefresh_token。
// musicid 直接以数字字面量拼 JSON——wxuin 有 19 位超 MAX_SAFE_INTEGER，
// parseInt/JSON.stringify 双截断会把 musicid 写坏（上游要求 Number 类型）
async function renewQqCookie(cookie) {
  const refreshToken = cookieVal(cookie, 'psrf_qqrefresh_token')
    || cookieVal(cookie, 'qqrefresh_token')
    || cookieVal(cookie, 'wxrefresh_token');
  const musickey = qqKey(cookie)
    || cookieVal(cookie, 'psrf_qqmusic_key') || cookieVal(cookie, 'psrf_qm_keyst');
  const uinDigits = qqUin(cookie); // qqUin 已保证纯数字
  if (!refreshToken || !musickey || !uinDigits) {
    console.warn('[qq] cookie 续期缺字段（refresh_token/musickey/uin），跳过——'
      + '到期后 QQ 源将降级匿名档');
    return;
  }
  try {
    const res = await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      // musicid 拼裸数字串绕过 MAX_SAFE_INTEGER 精度截断
      body: `{"req":{"module":"music.login.LoginServer","method":"Login",`
        + `"param":{"refresh_token":${JSON.stringify(refreshToken)},`
        + `"musickey":${JSON.stringify(musickey)},"musicid":${uinDigits}}}}`,
      signal: AbortSignal.timeout(10000),
    });
    const body = await res.json();
    const req = body?.req || {};
    const data = req.data || {};
    if (req.code !== 0 || !data.musickey) {
      console.warn(`[qq] cookie 续期被拒（code=${req.code} ${data.errMsg || req.errMsg || ''}）——`
        + 'refresh_token 可能已失效，需重新导出 cookie');
      return;
    }
    // createtime 必须是 epoch 整数——上游若回 "2024-08-03 22:05:59" 形态，
    // 写回后 parseInt 出 2024 → 永远判定在续期窗内 → 每请求一次外呼死循环
    if (!Number.isFinite(+data.musickeyCreateTime) || +data.musickeyCreateTime < 1e9) {
      console.warn('[qq] cookie 续期应答的 musickeyCreateTime 非 epoch 秒，放弃写回');
      return;
    }
    // 按名重写而非正则子串：'qqmusic_key=' 是 'psrf_qqmusic_key=' 的子串、
    // 'musickey_createtime=' 是 'psrf_musickey_createtime=' 的子串——首个命中
    // 语义下键序碰巧就会把独立键晾成旧值，createtime 永不前进 → 每个请求
    // 都触发一次续期外呼死循环。缺失键补尾部（导出的 cookie 未必带齐变体）
    const renewMap = {
      qqmusic_key: data.musickey, qm_keyst: data.musickey,
      musickey_createtime: String(+data.musickeyCreateTime),
      psrf_musickey_createtime: String(+data.musickeyCreateTime),
    };
    // 上游若轮换 refresh_token/access_token 则落回对应名（仅非空才覆盖——
    // 部分应答形态回空串，盲写会清掉现有 token）；只重写已存在的键
    if (data.refresh_token) {
      for (const n of ['psrf_qqrefresh_token', 'qqrefresh_token', 'wxrefresh_token']) {
        if (cookieVal(cookie, n)) renewMap[n] = data.refresh_token;
      }
    }
    if (data.access_token) {
      for (const n of ['psrf_qqaccess_token', 'qqaccess_token', 'wxaccess_token']) {
        if (cookieVal(cookie, n)) renewMap[n] = data.access_token;
      }
    }
    const seen = new Set();
    const parts = cookie.split(';').map(p => p.trim()).filter(Boolean)
      .map(p => {
        const eq = p.indexOf('=');
        if (eq === -1) return p; // 无等号裸片段不动
        const n = p.slice(0, eq).trim();
        if (!(n in renewMap)) return p;
        seen.add(n);
        return `${n}=${renewMap[n]}`;
      });
    for (const n of ['qqmusic_key', 'qm_keyst', 'musickey_createtime', 'psrf_musickey_createtime']) {
      if (!seen.has(n)) parts.push(`${n}=${renewMap[n]}`);
    }
    process.env.NEW_QQ_COOKIE = parts.join('; ');
    console.info('[qq] cookie 已自动续期（qm_keyst 刷新）');
  } catch (e) {
    console.warn('[qq] cookie 续期失败:', e.message);
  }
}

// 参数化 cookie 快照而非回读 qqCookie()——后者会再次进入本函数形成
// 无限互递归（renewalInflight 赋值在 await 之前，拦不住同步段）。
// 触发键兼容 psrf_ 变体：只导出 psrf_musickey_createtime 的 cookie
// 形态不能让续期永远判定「不在窗口」；无时间戳但有 refresh_token 的
// cookie 视为「需要续期」，直接发起
function maybeRenewQqCookie(cookie) {
  if (renewalInflight || !cookie) return;
  if (Date.now() - lastRenewAttemptAt < QQ_RENEW_COOLDOWN_MS) return;
  const created = parseInt(cookieVal(cookie, 'musickey_createtime'), 10)
    || parseInt(cookieVal(cookie, 'psrf_musickey_createtime'), 10);
  const hasRefresh = cookieVal(cookie, 'psrf_qqrefresh_token')
    || cookieVal(cookie, 'qqrefresh_token') || cookieVal(cookie, 'wxrefresh_token');
  if (!created && !hasRefresh) return;
  if (created && created + QQ_KEY_LIFETIME_SEC - Date.now() / 1000 >= QQ_RENEW_WINDOW_SEC) return;
  lastRenewAttemptAt = Date.now();
  // .catch 兜住提取段理论上的同步抛——finally 链保留 rejection 会成 unhandled
  renewalInflight = renewQqCookie(cookie)
    .catch(() => {})
    .finally(() => { renewalInflight = null; });
}

// cookie 里的登录参数：uin（QQ 登录，"o0956…" 形态需剥 o 前缀与前导零）或
// wxuin/p_luin（微信登录）+ qqmusic_key/qm_keyst。参数化 cookie 快照——单次
// 请求内 unm 续期写 NEW_QQ_COOKIE 也不会拼出跨凭据的 uin/key 组合
function cookieVal(cookie, name) {
  const m = String(cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  if (!m) return '';
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }  // 残缺 %xx 不崩进程
}
const qqUin = (cookie) => {
  const raw = cookieVal(cookie, 'uin') || cookieVal(cookie, 'wxuin') || cookieVal(cookie, 'p_luin');
  const digits = raw.replace(/^o0*/, '');
  return /^\d+$/.test(digits) ? digits : '';
};
const qqKey = (cookie) => cookieVal(cookie, 'qm_keyst') || cookieVal(cookie, 'qqmusic_key');

// g_tk = djb2(qqmusic_key)——登录态接口会校验 g_tk↔cookie 一致性；
// 空串哈希恰为 5381（匿名态口径），故匿名无需特判
const gtkOf = (key) => {
  let n = 5381;
  for (const ch of String(key || '')) n = (n + (n << 5) + ch.charCodeAt(0)) & 0x7fffffff;
  return n;
};

const qqHeaders = (cookie = qqCookie()) => ({
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Referer': 'https://y.qq.com/',
  ...(cookie ? { Cookie: cookie } : {}),
});
// 短链跳解只要 Location——公共头（不带 Cookie），与 bilibili BILI_PUBLIC_HEADERS 同口径
const QQ_PUBLIC_HEADERS = {
  'User-Agent': qqHeaders('')['User-Agent'],
  'Referer': 'https://y.qq.com/',
};
// QQ 分享短链只活在 *.y.qq.com 系（i./c./c6./m.y.qq.com）——裸 qq.com 根域
// 无合法用例，收窄避免"qq.com/任意路径"触发多余的外联跳解
const isQqLinkHost = (h) => h === 'y.qq.com' || h.endsWith('.y.qq.com');

const timedSignal = (extraSignal, ms = QQ_TIMEOUT_MS) => extraSignal
  ? AbortSignal.any([AbortSignal.timeout(ms), extraSignal])
  : AbortSignal.timeout(ms);

// ── zzc 签名（2024.07 现行代，SHA1 重组）：算法参照 jixunmoe/qmweb-sign（MIT）、
// netease-qq-music-api tencent/utils.rs、lx-music tx/utils/crypto.js 三处独立
// 实现互证。musics.fcg（网页端正主）要求 sign；musicu.fcg 匿名可用但会被风控
// 打回 code=2001+feedbackURL（lx-music 实测）——命中该信号自动升级签名通道
const ZZC_PART1 = [23, 14, 6, 36, 16, 40, 7, 19].filter(i => i < 40); // JS 原版 filter(i<40)：40 被丢
const ZZC_PART2 = [16, 1, 32, 12, 19, 27, 8, 5];
const ZZC_SCRAMBLE = [89, 39, 179, 150, 218, 82, 58, 252, 177, 52, 186, 123, 120, 64, 242, 133, 143, 161, 121, 179];
function zzcSign(payload) {
  const h = createHash('sha1').update(payload).digest('hex').toUpperCase();
  const xor = Buffer.from(ZZC_SCRAMBLE.map((v, i) => v ^ parseInt(h.slice(i * 2, i * 2 + 2), 16)));
  const b64 = xor.toString('base64').replace(/[\\/+=]/g, '');
  const pick = (arr) => arr.map(i => h[i]).join('');
  return `zzc${pick(ZZC_PART1)}${b64}${pick(ZZC_PART2)}`.toLowerCase();
}

// musicu.fcg 统一信封：comm 匿名档 + 可选登录字段；响应 key 与请求 key 镜像。
// cookie 可由调用方透传同一快照——vkey 这类 param.uin 也吃 cookie 的接口
// 若调用方与信封各读一次 env，unm 续期恰落在两次读之间会拼出跨凭据请求。
// signed=true 切 musics.fcg（签名对象是整个 body 串——必须先 stringify 再签
// 再发，key 序逐字节一致）；风控命中时内部自动升级重试一次
async function musicu(module, method, param, extraSignal, reqKey = 'req_0', cookie = qqCookie(), signed = false) {
  const uin = qqUin(cookie);
  const key = qqKey(cookie);
  const comm = {
    cv: 4747474, ct: 24, format: 'json',
    inCharset: 'utf-8', outCharset: 'utf-8', notice: 0,
    platform: 'yqq.json', needNewCode: 1,
    uin: uin || '0', g_tk: gtkOf(key), g_tk_new_20200303: gtkOf(key),
  };
  if (uin && key) comm.authst = key;
  const bodyStr = JSON.stringify({ comm, [reqKey]: { module, method, param } });
  const url = signed
    ? `https://u.y.qq.com/cgi-bin/musics.fcg?_=${Date.now()}&sign=${zzcSign(bodyStr)}`
    : 'https://u.y.qq.com/cgi-bin/musicu.fcg';
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...qqHeaders(cookie), 'Content-Type': 'application/json' },
    body: bodyStr,
    signal: timedSignal(extraSignal),
  });
  if (!res.ok) throw new Error(`qq musicu ${module} HTTP ${res.status}`);
  const body = await res.json();
  const node = body?.[reqKey];
  // 风控信号：code=2001 + feedbackURL 要求登录——同一 body 换签名通道重试。
  // 2001 可出现在 body 顶层或 node 层（{"req":{"code":2001}} 为 node 形态）
  if (!signed && (body?.code === 2001 || node?.code === 2001 || node?.data?.feedbackURL || body?.data?.feedbackURL)) {
    return musicu(module, method, param, extraSignal, reqKey, cookie, true);
  }
  if (body?.code !== 0 || !node || node.code !== 0) {
    throw new Error(`qq musicu ${module} code=${body?.code}/${node?.code} ${node?.data?.msg || ''}`);
  }
  return node.data;
}

// 旧式 fcg GET（歌单/歌词/单曲详情仍走这批端点，Referer 是硬门槛）；
// 调用方 URL 里的 g_tk= 占位统一按本次 cookie 快照重写（登录态校验一致性）。
// host/headers 可覆写：shc.y.qq.com 是移动端 H5 口径兜底宿主（配移动 UA）
async function fcg(path, extraSignal, { host = 'c.y.qq.com', headers } = {}) {
  const cookie = qqCookie();
  const res = await fetch(`https://${host}${path.replace(/g_tk=\d+/, `g_tk=${gtkOf(qqKey(cookie))}`)}`, {
    headers: headers || qqHeaders(cookie),
    signal: timedSignal(extraSignal),
  });
  if (!res.ok) throw new Error(`qq fcg ${path.split('?')[0]} HTTP ${res.status}`);
  return res.json();
}

// songmid（字母数字 ~14 位）与 songid（纯数字）是两把键——文件名用 media_mid。
// SONGMID_RE 与 pickQqFromUrl 的唯一真相源在 src/shared/predicates.js（顶部 require）

// QQ 音流 sip 宿主白名单（routes/qq.js 与 file-downloader 共用）：qqmusic.qq.com
// 全族（ws./isure./dl./cc.stream.qqmusic.qq.com 等）+ tc.qq.com 的音乐子族。
// tc.qq.com 是腾讯通用 CDN（视频/小程序/广告），整棵后缀域不能进代理白名单
// 与 proxy.js 白名单同用 endsWith 语义——picker 集合必须是代理集合的子集，
// 否则 sip 返回 *.aqqmusic.tc.qq.com 形态时 picker 丢弃可播流
const QQ_STREAM_HOST_OK = (h) => h === 'qqmusic.qq.com' || h.endsWith('.qqmusic.qq.com')
  || h === 'aqqmusic.tc.qq.com' || h.endsWith('.aqqmusic.tc.qq.com')
  || h === 'qqmusic.tc.qq.com' || h.endsWith('.qqmusic.tc.qq.com')
  || h === 'music.tc.qq.com' || h.endsWith('.music.tc.qq.com');

// ── 音质档梯：vkey filename = {前缀}{mediaMid}.{扩展名}
// 播放默认档匿名稳态（M800 对免费曲多数亦下发，拿不到自然落空往下走）；
// prefer=best 追加无损/Hi-Res——VIP 档没权限时 midurlinfo.purl 为空，天然降级
const QUALITY_TIERS = {
  RS01: { prefix: 'RS01', ext: 'flac', label: 'Hi-Res FLAC' },
  F000: { prefix: 'F000', ext: 'flac', label: 'FLAC' },
  M800: { prefix: 'M800', ext: 'mp3', label: '320k MP3' },
  M500: { prefix: 'M500', ext: 'mp3', label: '128k MP3' },
  C400: { prefix: 'C400', ext: 'm4a', label: '96k AAC' },
};
const PLAY_LADDER = ['M800', 'M500', 'C400'];
const BEST_LADDER = ['RS01', 'F000', 'M800', 'M500', 'C400'];
// sip 兜底固定宿主（yt-dlp urljoin/Meting _CDN/UNM sip[3] 同源共识）
const QQ_FIXED_SIPS = ['https://dl.stream.qqmusic.qq.com/', 'https://isure.stream.qqmusic.qq.com/'];

// 一次请求把整条档梯丢上去：songmid/filename 数组同序复制，midurlinfo 逐条回
// purl——为空即该档无权限，挑第一个有 purl 的。比逐档串行省 4 次上游往返
async function getStreamCandidates(mid, mediaMid, ladder, extraSignal) {
  const cookie = qqCookie();  // 单快照：param.uin 与 musicu 信封同源
  const fileMid = mediaMid || mid;
  const names = ladder.map(t => `${QUALITY_TIERS[t].prefix}${fileMid}.${QUALITY_TIERS[t].ext}`);
  const data = await musicu('vkey.GetVkeyServer', 'CgiGetVkey', {
    guid: String(Math.floor(Math.random() * 1e10)),
    songmid: names.map(() => mid),
    songtype: names.map(() => 0),
    filename: names,
    uin: qqUin(cookie) || '0',
    loginflag: 1,
    platform: '20',
  }, extraSignal, 'req_0', cookie);
  // https sip 优先——明文 http 链路上 MITM 可整体替换音频内容（无完整性校验），
  // 排序后 https 宿主先被选，失败了才轮明文
  const sips = (data?.sip || []).filter(s => /^https?:\/\/[a-z0-9.-]+/i.test(s))
    .sort((a, b) => (b.startsWith('https:') ? 1 : 0) - (a.startsWith('https:') ? 1 : 0));
  // sip 全被宿主白名单滤掉时的兜底：dl./isure. 是 yt-dlp/Meting/UNM 三处
  // 验证过的固定宿主（vkey 绑 uin+IP 不绑宿主，换宿主不影响鉴权）
  const sipPool = [...sips, ...QQ_FIXED_SIPS];
  const infos = Array.isArray(data?.midurlinfo) ? data.midurlinfo : [];
  return infos.map((info, i) => {
    const filename = info?.filename || names[i];
    // tier 按返回 filename 的前缀反查——上游若重排/丢档，位置映射会标错档
    // （影响下游扩展名选择：mp3 字节落 .flac）
    const tier = Object.keys(QUALITY_TIERS).find(t => filename.startsWith(QUALITY_TIERS[t].prefix)) || ladder[i];
    // purl 的 uin 参数不参与鉴权（vkey 已绑 uin+IP；UNM 多年写死 uin=0 实证）——
    // 脱敏掉登录态 uin，防它经代理 URL/日志外泄
    const purl = (info?.purl || info?.wifiurl || '').replace(/([?&])uin=\d+/g, '$1uin=0');
    return {
      tier, purl, filename,
      result: info?.result ?? data?.retcode,
      // purl 已含 filename+vkey+guid 完整 query，直接拼 sip
      urls: purl ? sipPool.map(s => s + purl) : [],
    };
  });
}

// 档梯取第一条能过宿主校验的回链（routes/qq.js 与 file-downloader 共用——
// 只带档梯差异，宿主校验/mediaMid 回填两处同一份实现）
async function pickStreamUrl(mid, { mediaMid = '', ladder = PLAY_LADDER, signal } = {}) {
  const usable = async (mm) => {
    const cands = await getStreamCandidates(mid, mm, ladder, signal);
    for (const cand of cands) {
      const url = cand.urls.find(u => {
        const checked = normalizeOutboundUrl(u);
        return checked.ok && QQ_STREAM_HOST_OK(checked.url.hostname);
      });
      if (url) return { url, tier: cand.tier };
    }
    return null;
  };
  let hit = await usable(mediaMid);
  if (!hit) {
    // filename 需 media_mid——多数歌 media_mid==songmid；调用方传的 mmid 也可能
    // 过期（details 里的 mediaMid 会迁移），失败时一律拿详情回填重试一次
    const tried = mediaMid || mid;
    const detail = await getSongDetail(mid, signal, 'mid').catch((e) => {
      if (!signal?.aborted) console.warn(`[qq] ${mid} 详情回填失败：${e.message}`);
      return null;
    });
    if (detail?.mediaMid && detail.mediaMid !== tried) hit = await usable(detail.mediaMid);
  }
  return hit;
}

// 单曲详情：songmid/songid 都收。keyHint 由调用方按命名空间给（'mid'/'songid'）：
// mid 命名空间的纯数字串先按 songmid 试——先 songid 会在恰好撞上别的歌的
// songid 时静默返回错歌元数据。无 hint 时纯数字先 songid 后 songmid。
// 返回字段是旧式命名（songmid/songname/singer/albumname/albummid/strMediaMid）
async function getSongDetail(idOrMid, extraSignal, keyHint) {
  const params = keyHint === 'mid' ? ['songmid', 'songid']
    : keyHint === 'songid' ? ['songid']
    : /^\d+$/.test(idOrMid) ? ['songid', 'songmid'] : ['songmid'];
  for (const param of params) {
    if (extraSignal?.aborted) break;
    const body = await fcg(`/v8/fcg-bin/fcg_play_single_song.fcg?${param}=${encodeURIComponent(idOrMid)}&format=json&tpl=yqq_song_detail&platform=yqq&needNewCode=0`, extraSignal).catch(() => null);
    if (body?.code === 0 && body?.data?.[0]) return normalizeTrack(body.data[0]);
  }
  throw new Error(`qq 详情获取失败 ${idOrMid}`);
}

// 曲库搜索三层兜底：c.y.qq.com（桌面口径）→ shc.y.qq.com（移动 H5 口径，
// 移动端 UA——eIsland/lyrix/LDDC 定位为备用通道）→ musicu
// DoSearchForQQMusicDesktop（匿名风控空回时 musicu 自动升级签名通道）。
// 健康空结果（code=0+空 list）不回落——真空搜索不白打上游
const SHC_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  'Referer': 'https://y.qq.com/',
};
async function searchSongs(query, limit = 20, extraSignal) {
  const n = Math.min(limit, 30);
  for (const hop of [
    () => fcg(`/soso/fcgi-bin/search_for_qq_cp?w=${encodeURIComponent(query)}&n=${n}&p=1&format=json&g_tk=5381&platform=yqq&needNewCode=0`, extraSignal),
    () => fcg(`/soso/fcgi-bin/search_for_qq_cp?w=${encodeURIComponent(query)}&n=${n}&p=1&format=json&platform=h5&needNewCode=1&zhidaqu=1&catZhida=1&t=0&flag=1&ie=utf-8&aggr=0&perpage=${n}&remoteplace=txt.mqq.all`, extraSignal, { host: 'shc.y.qq.com', headers: SHC_HEADERS }),
  ]) {
    try {
      const body = await hop();
      const list = body?.data?.song?.list;
      if (body?.code === 0 && Array.isArray(list)) {
        return list.map(normalizeTrack).filter(Boolean);
      }
    } catch (e) {
      if (extraSignal?.aborted) throw e;  // abort 不回落
      /* 落到下一跳 */
    }
  }
  // searchid 用上游公式形态（netease-qq-music-api utils.rs）——
  // 时间戳取模混入两段随机数，比 Date.now()%1e17 更像真值
  const searchid = String((1 + Math.floor(Math.random() * 20)) * 18014398509481984
    + Math.floor(Math.random() * 4194305) * 4294967296 + (Date.now() % 86400000));
  const data = await musicu('music.search.SearchCgiService', 'DoSearchForQQMusicDesktop', {
    query: String(query || ''), search_type: 0, page_num: 1,
    num_per_page: n, remoteplace: 'txt.yqq.top', grp: 1, highlight: 1,
    searchid,
  }, extraSignal, 'req_1');
  const list = data?.body?.song?.list;
  return Array.isArray(list) ? list.map(normalizeTrack).filter(Boolean) : [];
}

// 歌单详情（fcg_ucc_getcdinfo）：disstid 纯数字；song_begin/song_num 分页
async function getPlaylist(disstid, extraSignal, maxTracks = 1000) {
  const PAGE = 200;
  const tracks = [];
  let meta = null;
  for (let begin = 0; begin < maxTracks; begin += PAGE) {
    if (extraSignal?.aborted) {
      const e = new Error('已取消');
      e.aborted = true;
      throw e;  // 路由层据此回 499——客户端断连不该被报成 404「歌单不存在」
    }
    const cookie = qqCookie();
    const body = await fcg(`/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?type=1&json=1&utf8=1&onlysong=0&new_format=1&disstid=${encodeURIComponent(disstid)}&song_begin=${begin}&song_num=${Math.min(PAGE, maxTracks - begin)}&g_tk=5381&loginUin=${qqUin(cookie) || 0}&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0`, extraSignal);
    const cd = body?.cdlist?.[0];
    if (!cd) {
      // begin==0 无 cdlist = 歌单不存在/无权限——回 null 让路由出 404 而非 502
      if (begin === 0) return null;
      break;
    }
    meta ||= {
      // 裸 disstid 而非 qq_ 前缀——qq_<songmid> 是歌曲命名空间，歌单 id 不混入
      id: String(disstid),
      name: cd.dissname || `QQ 歌单 ${disstid}`,
      creator: cd.nickname || 'QQ 音乐',
      cover: cd.logo || cd.dir_pic_url2 || '',
      desc: (cd.desc || '').slice(0, 500),
      songCount: cd.songnum || 0,
    };
    // 终止判定以原始返回数为准——下架/灰曲条目仍占位但缺 mid，
    // 按过滤后长度判末页会在满页中间误截断
    const rawLen = Array.isArray(cd.songlist) ? cd.songlist.length : 0;
    tracks.push(...(rawLen ? cd.songlist.map(normalizeTrack).filter(Boolean) : []));
    if (rawLen < Math.min(PAGE, maxTracks - begin)) break;
    // songnum 缺省/非法时不得参与判定（>=0 恒真会退化成单页）
    if (cd.songnum > 0 && tracks.length >= cd.songnum) break;
  }
  return meta ? { ...meta, tracks } : null;
}

// 歌词：base64 LRC + base64 翻译；纯音乐占位词按无词处理
async function getLyric(mid, extraSignal) {
  const body = await fcg(`/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${encodeURIComponent(mid)}&format=json&g_tk=5381&platform=yqq&needNewCode=0`, extraSignal);
  if (body?.code !== 0 && body?.retcode !== 0) {
    // 业务码（-1901/-1301 无词等）打标——下载链据此映射 NO_LYRICS 判缺词跳过，
    // 传输层错误照旧抛走重试
    const err = new Error(`qq 歌词 code=${body?.code ?? body?.retcode}`);
    err.bizCode = body?.code ?? body?.retcode;
    throw err;
  }
  const dec = (s) => {
    try { return s ? Buffer.from(s, 'base64').toString('utf8') : ''; } catch { return ''; }
  };
  const lyric = dec(body?.lyric);
  const trans = dec(body?.trans);
  // 剥掉 [ti:]/[ar:] 等标签头再探占位词——歌名含 instrumental 会误伤；
  // 窗口放宽到 800 字符防超长头把标记词挤出切片
  const stripped = lyric.replace(/\[[^\]\n]{1,120}\]/g, ' ');
  const empty = /纯音乐|没有填词|instrumental/i.test(stripped.slice(0, 800));
  return { lyric: empty ? '' : lyric, trans };
}

// ── 字段归一：新旧两套命名（songmid/songname/... vs mid/name/singer[]）→ 统一形态
function normalizeTrack(s) {
  if (!s || typeof s !== 'object') return null;
  const mid = s.mid || s.songmid;
  if (!mid) return null;
  // s.singer 可能是字符串/对象——单条脏数据不能炸掉整个歌单/搜索列表
  const singers = (Array.isArray(s.singer) ? s.singer : []).map(x => x?.name).filter(Boolean);
  const albummid = s.album?.mid || s.albummid || '';
  const file = s.file || {};
  const pay = s.pay || {};
  return {
    mid,
    songId: s.id || s.songid || null,
    name: s.name || s.songname || '',
    artists: singers.length ? singers : [s.singername].filter(Boolean),
    album: s.album?.name || s.albumname || '',
    albummid,
    intervalSec: s.interval || 0,
    mediaMid: file.media_mid || s.strMediaMid || mid,
    // 付费/可播标记：pay_play=1 需付费，time_free=1 限免期；vkey 实际返回才是
    // 最终判据。新旧接口字段名两套（pay_play/time_free vs payplay/timefree）
    payPlay: (pay.pay_play ?? pay.payplay) === 1 && (pay.time_free ?? pay.timefree) !== 1,
    vipOnly: (pay.pay_month ?? pay.paytrackmouth) === 1,
    cover: albummid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albummid}.jpg` : '',
  };
}

// ── 分享链接解析用共享表 pickQqFromUrl（src/shared/predicates.js）；
// c.y.qq.com/base/fcgi-bin/u?__= 短链——手动逐跳跟随（与 parseBvid 同款防线：
// 每跳过 normalizeOutboundUrl + *.qq.com 域白 + 公网 IP + 钉扎建连）
async function resolveQqInput(input, extraSignal) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/^\d{1,12}$/.test(s)) return { songid: s };
  // qq:<mid> 显式前缀（前端 qq: 输入法直接透传到 resolve）
  const prefMid = s.match(/^qq:([0-9A-Za-z]{10,20})$/i)?.[1];
  if (prefMid) return { mid: prefMid };
  if (SONGMID_RE.test(s)) return { mid: s };
  const direct = pickQqFromUrl(s);
  if (direct) return direct;
  // 裸串前缀与前端 isQQInput 同口径收 *.y.qq.com/qqmusic.*——固定列表会在
  // 非常规子域（如 n2.y.qq.com）上产生"前端认、服务端 400"的口径分裂
  let href = /^https?:\/\//i.test(s) ? s : (/^(?:[a-z0-9-]+\.)*y\.qq\.com\//i.test(s) || /^qqmusic\.[\w.]+\//i.test(s) ? `https://${s}` : null);
  if (!href) return null;
  for (let hop = 0; hop <= 3; hop++) {
    if (extraSignal?.aborted) return null;
    const checked = normalizeOutboundUrl(href);
    if (!checked.ok) return null;
    const u = checked.url;
    if (!isQqLinkHost(u.hostname)) return null;
    if (!(await resolvesToPublicIp(u.hostname))) return null;
    const found = pickQqFromUrl(u.href);
    if (found) return found;
    const dispatcher = new Agent({ connect: { lookup: makeGuardedLookup() }, keepAliveTimeout: 1000 });
    try {
      const res = await fetch(u.href, {
        headers: QQ_PUBLIC_HEADERS,  // 跳解只要 Location——不发 Cookie
        redirect: 'manual',
        signal: AbortSignal.any([AbortSignal.timeout(10000), extraSignal].filter(Boolean)),
        dispatcher,
      });
      await res.body?.cancel().catch(() => {});
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        href = new URL(loc, u.href).toString();
        continue;
      }
      return null;
    } catch {
      return null;
    } finally {
      dispatcher.destroy().catch(() => {});
    }
  }
  return null;
}

module.exports = {
  hasQqCookie, QQ_STREAM_HOST_OK,
  QUALITY_TIERS, PLAY_LADDER, BEST_LADDER, SONGMID_RE,
  musicu, fcg, normalizeTrack,
  getSongDetail, getStreamCandidates, pickStreamUrl, getLyric, getPlaylist, searchSongs,
  resolveQqInput,
};

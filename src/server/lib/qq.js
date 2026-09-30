// QQ 音乐 web 端协议原语——u.y.qq.com musicu.fcg 统一网关 + c.y.qq.com 旧式 fcg。
// 纯 fetch 自研（零依赖）：协议口径参照 yt-dlp extractor/qqmusic.py（公有领域）、
// Meting(MIT) tencent provider、listen1 qq.js 的调用形态——各上游接口 2019 年
// 至今骨架稳定。匿名 uin=0 可得 C400/M500 档；无损/VIP 档需 QQ_COOKIE（uin +
// qm_keyst/qqmusic_key）。注意 vkey 与 (guid,uin,请求方IP) 绑定——播放端必须
// 每次都重取，且最终拉流要么本进程要么经 /audio-proxy 回源（不能拿 vkey 的
// 机器与拉流的机器不同 IP）。
const { normalizeOutboundUrl, resolvesToPublicIp, makeGuardedLookup } = require('./net-guard');
const { Agent } = require('undici');

const QQ_TIMEOUT_MS = 15000;

// ── Cookie：可选登录态（VIP/无损档只对登录账号下发）。只发 *.qq.com 域。
// 与 BILI_COOKIE 同款 ASCII 清洗——粘贴串带进换行/中文会让 undici 头校验
// 抛错，全部 QQ 请求静默 502
const QQ_COOKIE = (() => {
  const raw = (process.env.QQ_COOKIE || '').trim();
  if (!raw) return '';
  const ascii = raw.replace(/[^\x20-\x7e]/g, '');
  if (ascii !== raw) {
    console.warn('[qq] QQ_COOKIE 含控制字符/非 ASCII，已剔除——cookie 值应为纯 ASCII');
  }
  return ascii;
})();

// cookie 里的登录参数：uin（QQ 登录）或 wxuin（微信登录）+ qqmusic_key/qm_keyst
function cookieVal(name) {
  const m = QQ_COOKIE.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : '';
}
const QQ_UIN = cookieVal('uin') || cookieVal('wxuin') || '';
const QQ_KEY = cookieVal('qm_keyst') || cookieVal('qqmusic_key') || '';

const QQ_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Referer': 'https://y.qq.com/',
  ...(QQ_COOKIE ? { Cookie: QQ_COOKIE } : {}),
};
// 短链跳解/落地页只发公共头——Cookie 不出 *.qq.com 之外，share 域（i.y.qq.com
// 等）虽同属腾讯但按最小泄露面仍只给 API 头（c.y.qq.com 短链在 *.qq.com 内，
// 带上 Cookie 无害且对齐登录态行为：QQ_SHARE_DOMAINS 全部 *.qq.com）
const QQ_LINK_HOSTS = ['y.qq.com', 'qq.com'];
const isQqLinkHost = (h) => h === 'y.qq.com' || h === 'qq.com' || h.endsWith('.y.qq.com');

const timedSignal = (extraSignal, ms = QQ_TIMEOUT_MS) => extraSignal
  ? AbortSignal.any([AbortSignal.timeout(ms), extraSignal])
  : AbortSignal.timeout(ms);

// musicu.fcg 统一信封：comm 匿名档 + 可选登录字段；响应 key 与请求 key 镜像
async function musicu(module, method, param, extraSignal, reqKey = 'req_0') {
  const comm = {
    cv: 4747474, ct: 24, format: 'json',
    inCharset: 'utf-8', outCharset: 'utf-8', notice: 0,
    platform: 'yqq.json', needNewCode: 1,
    uin: QQ_UIN || '0', g_tk: 5381, g_tk_new_20200303: 5381,
  };
  if (QQ_UIN && QQ_KEY) comm.authst = QQ_KEY;
  const res = await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'POST',
    headers: { ...QQ_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ comm, [reqKey]: { module, method, param } }),
    signal: timedSignal(extraSignal),
  });
  if (!res.ok) throw new Error(`qq musicu ${module} HTTP ${res.status}`);
  const body = await res.json();
  const node = body?.[reqKey];
  if (body?.code !== 0 || !node || node.code !== 0) {
    throw new Error(`qq musicu ${module} code=${body?.code}/${node?.code} ${node?.data?.msg || ''}`);
  }
  return node.data;
}

// 旧式 fcg GET（歌单/歌词/单曲详情仍走这批端点，Referer 是硬门槛）
async function fcg(path, extraSignal) {
  const res = await fetch(`https://c.y.qq.com${path}`, {
    headers: QQ_HEADERS,
    signal: timedSignal(extraSignal),
  });
  if (!res.ok) throw new Error(`qq fcg ${path.split('?')[0]} HTTP ${res.status}`);
  return res.json();
}

// songmid（字母数字 ~14 位）与 songid（纯数字）是两把键——文件名用 media_mid
const SONGMID_RE = /^[0-9A-Za-z]{10,20}$/;

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

// 一次请求把整条档梯丢上去：songmid/filename 数组同序复制，midurlinfo 逐条回
// purl——为空即该档无权限，挑第一个有 purl 的。比逐档串行省 4 次上游往返
async function getStreamCandidates(mid, mediaMid, ladder, extraSignal) {
  const fileMid = mediaMid || mid;
  const names = ladder.map(t => `${QUALITY_TIERS[t].prefix}${fileMid}.${QUALITY_TIERS[t].ext}`);
  const data = await musicu('vkey.GetVkeyServer', 'CgiGetVkey', {
    guid: String(Math.floor(Math.random() * 1e10)),
    songmid: names.map(() => mid),
    songtype: names.map(() => 0),
    filename: names,
    uin: QQ_UIN || '0',
    loginflag: 1,
    platform: '20',
  }, extraSignal);
  const sips = (data?.sip || []).filter(s => /^https?:\/\/[a-z0-9.-]+/i.test(s));
  const infos = Array.isArray(data?.midurlinfo) ? data.midurlinfo : [];
  return infos.map((info, i) => ({
    tier: ladder[i],
    purl: info?.purl || '',
    result: info?.result ?? data?.retcode,
    filename: info?.filename || names[i],
    // purl 已含 filename+vkey+guid 完整 query，直接拼 sip
    urls: info?.purl ? sips.map(s => s + info.purl) : [],
  }));
}

// 单曲详情：songmid/songid 都收（fcg_play_single_song 两个参数键各试）。
// 返回字段是旧式命名（songmid/songname/singer/albumname/albummid/strMediaMid）
async function getSongDetail(idOrMid, extraSignal) {
  // 纯数字= songid，否则按 songmid（SONGMID_RE 的字符集本身也罩住数字，先判数字）
  const param = /^\d+$/.test(idOrMid) ? 'songid' : 'songmid';
  const body = await fcg(`/v8/fcg-bin/fcg_play_single_song.fcg?${param}=${encodeURIComponent(idOrMid)}&format=json&tpl=yqq_song_detail&platform=yqq&needNewCode=0`, extraSignal);
  if (body?.code !== 0 || !body?.data?.[0]) throw new Error(`qq 详情 code=${body?.code}`);
  return normalizeTrack(body.data[0]);
}

// 曲库搜索：实测匿名态下 DoSearchForQQMusicDesktop 与 client_search_cp 均回
// 空列表（风控收紧），search_for_qq_cp 仍正常工作——主用它，musicu 兜底
async function searchSongs(query, limit = 20, extraSignal) {
  const n = Math.min(limit, 30);
  try {
    const body = await fcg(`/soso/fcgi-bin/search_for_qq_cp?w=${encodeURIComponent(query)}&n=${n}&p=1&format=json&g_tk=5381&platform=yqq&needNewCode=0`, extraSignal);
    const list = body?.data?.song?.list;
    if (Array.isArray(list) && list.length) {
      return list.map(normalizeTrack).filter(Boolean);
    }
  } catch { /* 落到 musicu 兜底 */ }
  const data = await musicu('music.search.SearchCgiService', 'DoSearchForQQMusicDesktop', {
    query: String(query || ''), search_type: 0, page_num: 1,
    num_per_page: n, remoteplace: 'txt.yqq.top',
    searchid: String(Date.now() % 1e17),
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
    if (extraSignal?.aborted) return null;
    const body = await fcg(`/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?type=1&json=1&utf8=1&onlysong=0&new_format=1&disstid=${encodeURIComponent(disstid)}&song_begin=${begin}&song_num=${Math.min(PAGE, maxTracks - begin)}&g_tk=5381&loginUin=0&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0`, extraSignal);
    const cd = body?.cdlist?.[0];
    if (!cd) {
      if (begin === 0) throw new Error(`qq 歌单 code=${body?.code}（不存在或无权限）`);
      break;
    }
    meta ||= {
      id: `qq_${disstid}`,
      name: cd.dissname || `QQ 歌单 ${disstid}`,
      creator: cd.nickname || 'QQ 音乐',
      cover: cd.logo || cd.dir_pic_url2 || '',
      desc: (cd.desc || '').slice(0, 500),
      songCount: cd.songnum || 0,
    };
    const batch = Array.isArray(cd.songlist) ? cd.songlist.map(normalizeTrack).filter(Boolean) : [];
    tracks.push(...batch);
    if (batch.length < Math.min(PAGE, maxTracks - begin) || tracks.length >= (cd.songnum || 0)) break;
  }
  return meta ? { ...meta, tracks } : null;
}

// 歌词：base64 LRC + base64 翻译；纯音乐占位词按无词处理
async function getLyric(mid, extraSignal) {
  const body = await fcg(`/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${encodeURIComponent(mid)}&format=json&g_tk=5381&platform=yqq&needNewCode=0`, extraSignal);
  if (body?.code !== 0 && body?.retcode !== 0) throw new Error(`qq 歌词 code=${body?.code}`);
  const dec = (s) => {
    try { return s ? Buffer.from(s, 'base64').toString('utf8') : ''; } catch { return ''; }
  };
  const lyric = dec(body?.lyric);
  const trans = dec(body?.trans);
  const empty = /纯音乐|没有填词|instrumental/i.test(lyric.slice(0, 200));
  return { lyric: empty ? '' : lyric, trans };
}

// ── 字段归一：新旧两套命名（songmid/songname/... vs mid/name/singer[]）→ 统一形态
function normalizeTrack(s) {
  if (!s || typeof s !== 'object') return null;
  const mid = s.mid || s.songmid;
  if (!mid) return null;
  const singers = (s.singer || []).map(x => x?.name).filter(Boolean);
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

// ── 分享链接解析：提取 songmid/songid/disstid/albummid；c.y.qq.com 短链逐跳跟随
function pickQqFromUrl(href) {
  // ?qq=<mid> 是本站分享链形态——与 ?yt= 同口径也在这里收
  const mid = href.match(/[?&]qq=([0-9A-Za-z]{10,20})/i)?.[1]
    || href.match(/songmid=([0-9A-Za-z]{10,20})/i)?.[1]
    || href.match(/songDetail\/([0-9A-Za-z]{10,20})/i)?.[1]
    || href.match(/\/song\/([0-9A-Za-z]{10,20})\.html/i)?.[1];
  if (mid) return { mid };
  const songid = href.match(/songid=(\d+)/i)?.[1];
  if (songid) return { songid };
  const diss = href.match(/taoge\.html\?[^#]*?\bid=(\d+)/i)?.[1]
    || href.match(/\/playlist\/(\d+)/i)?.[1];
  if (diss) return { disstid: diss };
  const albummid = href.match(/albumDetail\/([0-9A-Za-z]{10,20})/i)?.[1];
  if (albummid) return { albummid };
  return null;
}

// c.y.qq.com/base/fcgi-bin/u?__= 短链——手动逐跳跟随（与 parseBvid 同款防线：
// 每跳过 normalizeOutboundUrl + *.qq.com 域白 + 公网 IP + 钉扎建连）
async function resolveQqInput(input, extraSignal) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/^\d{1,12}$/.test(s)) return { songid: s };
  if (SONGMID_RE.test(s)) return { mid: s };
  const direct = pickQqFromUrl(s);
  if (direct) return direct;
  let href = /^https?:\/\//i.test(s) ? s : (/^(?:c|c6|i|y|m)\.y?\.?qq\.com\//i.test(s) ? `https://${s}` : null);
  if (!href && /^qqmusic:\/\//i.test(s)) return pickQqFromUrl(s);
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
        headers: QQ_HEADERS,
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
  QQ_COOKIE, QQ_UIN,
  QUALITY_TIERS, PLAY_LADDER, BEST_LADDER, SONGMID_RE,
  musicu, fcg, normalizeTrack,
  getSongDetail, getStreamCandidates, getLyric, getPlaylist, searchSongs,
  resolveQqInput,
};

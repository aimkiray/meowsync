// B 站上游原语——routes/bilibili.js（HTTP 层：限流/vault/SSRF 白名单/302）
// 与 services/file-downloader.js（下载层：直接 fetchStream 落盘）共用。
// 移动边界：上游交互（cookie 头形态、API 调用、流挑选、输入解析）全在这里；
// HTTP 语义留在路由。两份实现漂移会让"能播不能下/能下不能播"互不知情
const { Agent } = require('undici');
const { normalizeOutboundUrl, resolvesToPublicIp, makeGuardedLookup } = require('./net-guard');
const { BVID_RE, BVID_IN_TEXT_RE } = require('../../shared/predicates.js');

// B 站 API 统一请求头：Referer 是防盗链硬门槛（缺它 403），UA 伪造浏览器。
// BILI_COOKIE 可选登录态——杜比/Hi-Res 音轨只对有权限的账号下发
// （Hi-Res 通常需大会员），Cookie 只发给 api.bilibili.com 不外泄
const BILI_COOKIE = (() => {
  const raw = (process.env.BILI_COOKIE || '').trim();
  if (!raw) return '';
  // header 值要求 latin1——粘贴串带进换行/中文会让 undici 抛头校验错，
  // 全部 B 站请求静默 502；剔除控制字符并显式告警
  const ascii = raw.replace(/[^\x20-\x7e]/g, '');
  if (ascii !== raw) {
    console.warn('[bilibili] BILI_COOKIE 含控制字符/非 ASCII，已剔除——cookie 值应为纯 ASCII');
  }
  // 登录态下 B 站校验 Cookie 内 CURRENT_FNVAL 与请求 fnval 一致——浏览器
  // 导出的 cookie 里该值是用户最后播放的格式（常是 16），原样带上会被
  // 静默扣发杜比/Hi-Res 轨；剥掉重写成与请求一致的 4048
  const parts = ascii.split(';').map(s => s.trim())
    .filter(s => s && s.split('=')[0].trim().toLowerCase() !== 'current_fnval');
  parts.push('CURRENT_FNVAL=4048');
  return parts.join('; ');
})();
const BILI_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Referer': 'https://www.bilibili.com',
  ...(BILI_COOKIE ? { Cookie: BILI_COOKIE } : {}),
};
// 短链跳解只需要公共头——UA/Referer 足够拿 location，Cookie 不发 b23.tv
const BILI_PUBLIC_HEADERS = {
  'User-Agent': BILI_HEADERS['User-Agent'],
  'Referer': BILI_HEADERS['Referer'],
};
const BILI_TIMEOUT_MS = 15000;

// 允许发起重定向解析的域：仅 b23.tv 短链与 bilibili.com 本系。
// 严格 hostname 判定（等值或带点分隔后缀）——userinfo/尾界欺骗
// （b23.tv@内网、bilibili.com.evil.com）在 URL parse 层挡掉
const BILI_LINK_HOSTS = ['b23.tv', 'bilibili.com'];
const isBiliLinkHost = (h) => BILI_LINK_HOSTS.some(x => h === x || h.endsWith('.' + x));

function pickBvidFromUrl(href) {
  // 大小写宽容：三层口径统一（前端 isBilibiliInput/?bili= 都收小写）——
  // bvid 本身大小写敏感，错大小写交给上游 view API 判（-404 照常报错）
  const m = href.match(BVID_IN_TEXT_RE);
  if (m) return m[0];
  const av = href.match(/(?:^|[/?&=])av(\d+)/i);
  if (av) return { aid: Number(av[1]) };
  return null;
}

// bvid 解析：BV 号 / av 号 / 完整 URL。b23.tv 短链本身不含 BV——
// 手动逐跳跟随（redirect:manual），每一跳都重新过 normalizeOutboundUrl
// （限 80/443/剥 credentials）+ B 站域白名单 + 公网 IP 校验 + 钉扎建连
// （audio-proxy 同款防线），重定向到任何非 B 站域即拒绝——防 SSRF 绕道
async function parseBvid(input, extraSignal) {
  const s = String(input || '').trim();
  if (!s) return null;
  const direct = pickBvidFromUrl(s);
  if (direct) return direct;
  // 裸短链补协议头（b23.tv/xxx 无 scheme 时 new URL 抛错直接拒）
  let href = /^https?:\/\//i.test(s) ? s : (/^b23\.tv\//i.test(s) ? `https://${s}` : null);
  if (!href) return null;
  for (let hop = 0; hop <= 3; hop++) {
    if (extraSignal?.aborted) return null;
    const checked = normalizeOutboundUrl(href);
    if (!checked.ok) return null;
    const u = checked.url;
    if (!isBiliLinkHost(u.hostname)) return null;
    if (!(await resolvesToPublicIp(u.hostname))) return null;
    const found = pickBvidFromUrl(u.href);
    if (found) return found;
    const dispatcher = new Agent({
      connect: { lookup: makeGuardedLookup() },
      keepAliveTimeout: 1000,
    });
    try {
      const res = await fetch(u.href, {
        headers: BILI_PUBLIC_HEADERS,
        redirect: 'manual',
        signal: extraSignal
          ? AbortSignal.any([AbortSignal.timeout(10000), extraSignal])
          : AbortSignal.timeout(10000),
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

// extraSignal 级联客户端断连——上游请求不随客户端断开变僵尸（audio-proxy 同款语义）
async function biliFetch(path, extraSignal) {
  const res = await fetch(`https://api.bilibili.com${path}`, {
    headers: BILI_HEADERS,
    signal: extraSignal
      ? AbortSignal.any([AbortSignal.timeout(BILI_TIMEOUT_MS), extraSignal])
      : AbortSignal.timeout(BILI_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`bilibili ${path.split('?')[0]} HTTP ${res.status}`);
  const body = await res.json();
  if (body.code !== 0) throw new Error(`bilibili ${path.split('?')[0]} code=${body.code} ${body.message || ''}`);
  return body.data;
}

const viewQuery = (id) => typeof id === 'string' ? `bvid=${id}` : `aid=${id.aid}`;

// playurl 选流：音频按 bandwidth 降序（30280≈192k > 30232≈108k > 30216≈64k）；
// prefer='best'（下载档）把 dash.flac.audio（Hi-Res 无损）与 dash.dolby.audio
// （杜比）排在常规 AAC 前——flac > dolby > aac：无损严格优于有损空间音频，
// 这两条轨需要 fnval 相应位标志且大多要登录态，缺席时自然回落常规档。
// 视频优先 avc1（H.264 全浏览器可放）再按分辨率降序——hevc/av01 老设备放不了。
// 返回排序后的完整数组——单档流的备份 URL 全被端口策略拒时还能降级到下一档
function pickStreamList(data, kind, prefer = '') {
  const dash = data?.dash || {};
  if (kind === 'audio') {
    const audioArr = Array.isArray(dash.audio) ? dash.audio : [];
    const regular = audioArr.slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
    if (prefer === 'best') {
      // hasUrl 认全部四个地址字段——只带 backupUrl 的条目不该被预过滤丢档
      const hasUrl = (f) => f && (f.baseUrl || f.base_url
        || (Array.isArray(f.backupUrl) && f.backupUrl.length)
        || (Array.isArray(f.backup_url) && f.backup_url.length));
      // flac.audio 文档形态是单对象；上游若改成多档数组 concat 也兼容
      const flac = [].concat(dash.flac?.audio || []).filter(hasUrl);
      const dolby = (Array.isArray(dash.dolby?.audio) ? dash.dolby.audio : [])
        .filter(hasUrl).sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
      return [...flac, ...dolby, ...regular];
    }
    return regular;
  }
  const avc = (dash.video || []).filter(v => (v.codecs || '').startsWith('avc1'));
  return (avc.length ? avc : dash.video || [])
    .slice().sort((a, b) => (b.height * b.width) - (a.height * a.width));
}
const pickStreams = (data) => ({
  audio: pickStreamList(data, 'audio')[0] || null,
  video: pickStreamList(data, 'video')[0] || null,
});

// 分P参数：?p=N 从输入 URL 提取（多分P稿件导哪P播哪P，默认P1）
function pickPageParam(input) {
  const m = String(input || '').match(/[?&]p=(\d+)/);
  return m ? Math.max(1, parseInt(m[1], 10)) : 1;
}

// 分P cid 定位：pages[p-1].cid ?? view.cid——playurl cid 自愈与 /resolve 共用。
// 不能回落裸 view.cid（那是 P1，会把分P导入的曲静默拉回第一P）
function pickCidFromView(view, pageWanted) {
  const pages = Array.isArray(view?.pages) ? view.pages : [];
  const idx = Math.min(pageWanted, Math.max(pages.length, 1)) - 1;
  return pages[idx]?.cid ?? view.cid;
}

// 下载侧 playurl 解析：providerData.cid 缺失/过期自愈（UP 主换源/调 P 后
// 库存 cid 失效——按 p 重查对应分P）。fnval 4048=DASH 全轨响应，1=MP4 合流
// （durl 形态，无 ffmpeg 环境的视频兜底路）。
async function resolveBiliPlayurl({ bvid, cid, page = 1, signal, fnval = 4048 }) {
  const playurlOf = (useCid) =>
    biliFetch(`/x/player/playurl?bvid=${bvid}&cid=${useCid}&fnval=${fnval}&fourk=1`, signal);
  // cid 缺省时先查 view 定位分P cid——直接发 cid=undefined 是上游 400
  let useCid = /^\d+$/.test(String(cid || '')) ? String(cid) : null;
  if (!useCid) {
    const view = await biliFetch(`/x/web-interface/view?bvid=${bvid}`, signal);
    useCid = pickCidFromView(view, page);
  }
  try {
    return await playurlOf(useCid);
  } catch (e) {
    // cid 过期自愈：只对「调用方传了合法数字 cid」自愈——本来就没有 cid 的
    // 输入重查 view 也只会得到同一个值，再试是浪费一跳
    if (!/^\d+$/.test(String(cid || ''))) throw e;
    const view = await biliFetch(`/x/web-interface/view?bvid=${bvid}`, signal);
    return await playurlOf(pickCidFromView(view, page));
  }
}

// 单档流的主链+备份链摊平成顺序候选——端口策略/边缘拒绝按档降级
const flatUrls = (s, extra = {}) =>
  [s?.baseUrl, s?.base_url,
    ...(Array.isArray(s?.backupUrl) ? s.backupUrl : (s?.backup_url || []))]
    .filter(u => typeof u === 'string' && u)
    .map(url => ({ url, ...extra }));

// 音频下载候选：prefer='best' 让 Hi-Res/杜比轨排在常规 AAC 前（BILI_COOKIE
// 有权限才下发，否则自然回落最高码率 AAC）。
async function resolveBiliAudio({ bvid, cid, page = 1, signal }) {
  const playurl = await resolveBiliPlayurl({ bvid, cid, page, signal });
  return pickStreamList(playurl, 'audio', 'best')
    .flatMap(s => flatUrls(s, { mimeType: s?.mimeType || '', br: s?.bandwidth || null }));
}

// 视频下载物料：DASH 自适应视频轨（avc1 分辨率降序）+ 常规 AAC 音轨（合流用——
// flac/杜比轨塞不进 mp4 容器）+ 懒取 MP4 合流兜底（无 ffmpeg 时 fnval=1 再打一跳）
async function resolveBiliMedia({ bvid, cid, page = 1, signal }) {
  const dash = await resolveBiliPlayurl({ bvid, cid, page, signal, fnval: 4048 });
  return {
    // 合流只留 avc1（H.264）——pickStreamList 的 hevc/av01 兜底是给播放器
    // 探测用的，塞进 mp4 容器产的是解不动的文件
    videos: pickStreamList(dash, 'video', 'best')
      .filter(s => (s?.codecs || '').startsWith('avc1'))
      .flatMap(s => flatUrls(s, {
        mimeType: s?.mimeType || '', br: s?.bandwidth || null,
        w: s?.width || 0, h: s?.height || 0
      })),
    audios: pickStreamList(dash, 'audio')
      .flatMap(s => flatUrls(s, { mimeType: s?.mimeType || '', br: s?.bandwidth || null })),
    // MP4 合流（durl）：无 ffmpeg 环境下的兜底——分辨率受合流档限制但自带音轨
    progressive: async () => {
      const data = await resolveBiliPlayurl({ bvid, cid, page, signal, fnval: 1 });
      return (Array.isArray(data?.durl) ? data.durl : [])
        .filter(d => typeof d?.url === 'string' && d.url)
        .map(d => ({ url: d.url, mimeType: 'video/mp4', br: null }));
    }
  };
}

module.exports = {
  BILI_COOKIE, BILI_HEADERS, BILI_PUBLIC_HEADERS, BILI_TIMEOUT_MS,
  biliFetch, pickStreamList, pickStreams, pickPageParam, pickCidFromView,
  viewQuery, parseBvid, isBiliLinkHost, resolveBiliAudio, resolveBiliMedia,
  BVID_RE,
};

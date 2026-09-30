// 共享 URL 工具：HTTPS 页面下 http:// 外链（网易图床 *.music.126.net、
// 各解锁源 CDN 等均支持 TLS）会被浏览器混拦为 mixed content——统一升级。
// 仅在 HTTPS 页面升级：纯 HTTP 部署（自托管常态）下服务端回链
// （/audio-proxy?url=... 由 requestOrigin 拼出，scheme 跟随入站请求）就是
// 合法 http 地址，对只讲 HTTP 的源做 TLS 会握手失败；http 页面本就没有混拦
export function httpsCover(url) {
  const s = String(url || '');
  // 非浏览器环境（worker/测试/SSR 复用）同样不升级——对只讲 HTTP 的源做
  // TLS 必然握手失败，未知协议环境下保持原样是更安全的默认
  if (typeof window === 'undefined' || window.location?.protocol !== 'https:') {
    return s;
  }
  return s.replace(/^http:\/\//i, 'https://');
}

// B 站输入识别：BV 号（真实 bvid 恒 BV1 头+9 位）、av 号、
// bilibili.com/b23.tv 链接。\b 词边界防长 token 误吞
export function isBilibiliInput(input) {
  const s = String(input || '');
  return /\bBV1[0-9A-Za-z]{9}\b/i.test(s) // 小写 bv 也收下——服务端会校验真实 bvid
    || /bilibili\.com|b23\.tv/i.test(s)
    || /(?:^|\/)av\d+/i.test(s);
}

// YouTube URL 形态表（顺序敏感）——与服务端 pickYouTubeId 前半段逐字符一致
const YT_URL_RES = [
  /(?:youtube(?:-nocookie)?\.com|music\.youtube\.com)\/(?:watch\?[^ ]*?\bv=|shorts\/|embed\/|live\/|v\/)([A-Za-z0-9_-]{11})/i,
  /youtu\.be\/([A-Za-z0-9_-]{11})/i,
  /[?&]yt=([A-Za-z0-9_-]{11})/i,
];

// YouTube 视频 id 提取：URL 形态 + 裸 11 位 id（须含非数字，纯数字与网易云 id 撞型）。
// 与服务端 pickYouTubeId 同一套形态表
export function extractYouTubeId(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  for (const re of YT_URL_RES) {
    const m = s.match(re);
    if (m) return m[1];
  }
  // 裸 id 兜底：与服务端 pickYouTubeId 形态表对齐；前端调用点被
  // isYouTubeInput（仅 URL 形态）门控后实际吃不到这条，保留只为表完整
  return (/^[A-Za-z0-9_-]{11}$/.test(s) && /\D/.test(s)) ? s : null;
}

// YouTube 输入识别：只认无歧义的 URL 形态——裸 11 位串与搜索关键词天然歧义
// （`lofi1234567` 这类 11 位词会被误当 videoId 劫持进导入流程），裸 id 输入
// 走正常搜索；想用裸 id 可以拼 youtu.be/<id>
export function isYouTubeInput(input) {
  const s = String(input || '').trim();
  return !!s && YT_URL_RES.some(re => re.test(s));
}

// 网易云歌曲 id 提取：music.163.com/song?id= / song/N / ?song=N / 裸数字。
// 点歌框语境下裸数字即歌曲 id（歌单 id 歧义由外层语义决定）
export function extractNeteaseSongId(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  // song\? 吃掉字面 ? 后接 \bid=——id 是首参（song?id=N）或非首参（song?x=1&id=N）
  // 都命中；不要再要求第二个 [?&]，否则主流形式全灭退回关键词搜索
  const m = s.match(/song\?[^ ]*?\bid=(\d+)/i)        // music.163.com/[#/]song?id=N
    || s.match(/\/song\/(\d+)/i)                      // .../song/N
    || s.match(/[?&]song=(\d+)/i);                    // 本站 ?song=N 分享链
  if (m) return m[1];
  return /^\d+$/.test(s) ? s : null;
}

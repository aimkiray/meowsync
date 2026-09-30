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

// 网易云歌曲 id 提取：music.163.com/song?id= / song/N / ?song=N / 裸数字。
// 点歌框语境下裸数字即歌曲 id（歌单 id 歧义由外层语义决定）
export function extractNeteaseSongId(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  const m = s.match(/song\?[^ ]*?[?&]id=(\d+)/i)      // music.163.com/song?id=N
    || s.match(/\/song\/(\d+)/i)                      // .../song/N
    || s.match(/[?&]song=(\d+)/i);                    // 本站 ?song=N 分享链
  if (m) return m[1];
  return /^\d+$/.test(s) ? s : null;
}

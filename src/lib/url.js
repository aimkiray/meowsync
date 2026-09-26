// 共享 URL 工具：HTTPS 页面下 http:// 外链（网易图床 *.music.126.net、
// 各解锁源 CDN 等均支持 TLS）会被浏览器混拦为 mixed content——统一升级。
// 仅在 HTTPS 页面升级：纯 HTTP 部署（自托管常态）下服务端回链
// （/audio-proxy?url=... 由 requestOrigin 拼出，scheme 跟随入站请求）就是
// 合法 http 地址，对只讲 HTTP 的源做 TLS 会握手失败；http 页面本就没有混拦
export function httpsCover(url) {
  const s = String(url || '');
  if (typeof window !== 'undefined' && window.location?.protocol !== 'https:') {
    return s;
  }
  return s.replace(/^http:\/\//i, 'https://');
}

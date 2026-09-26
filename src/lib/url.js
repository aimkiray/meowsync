// 共享 URL 工具：HTTPS 部署下 http:// 外链（网易图床 *.music.126.net 等均支持 TLS）
// 会被浏览器混拦为 mixed content——所有落到 <img>/媒体 src 的上游 URL 统一升级
export function httpsCover(url) {
  return String(url || '').replace(/^http:\/\//, 'https://');
}

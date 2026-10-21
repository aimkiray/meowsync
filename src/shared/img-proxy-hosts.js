// 图片代理可回源域白名单：服务端 src/server/routes/img-proxy.js 的回源闸与
// 客户端 src/lib/song.js:proxiedCoverUrl 的「要不要包 /img-proxy」判定共用同
// 一张表——两份私有名单漂移会出现「客户端没包 → 直连裂图」或「客户端包了 →
// 服务端 403」的静默错位。双端消费：服务端 CJS require(ESM)（engines 已要求
// Node ^20.19 || >=22.12），客户端经 Vite import。
//
// 只收封面图床域，刻意不含音频 CDN（googlevideo/bilivideo/qqmusic.tc.qq.com
// 归 server/lib/net-guard.js PROXY_ALLOWED_HOSTS 管）——本表只服务 image/*
// 回源，名单越窄「任意人让服务器代取」的开放中转面越小：
//   ytimg.com / ggpht.com  YouTube 视频缩略图（i.ytimg.com）与频道/歌单头像（yt3.ggpht.com）
//   hdslb.com              B 站图床（i0~i2.hdslb.com 封面、收藏夹图）
//   music.126.net          网易图床 p* 子域（歌单/专辑封面；与音频白名单同款收窄口径）
//   gtimg.cn / qpic.cn     QQ 音乐图床（y.gtimg.cn 专辑封面、p.qpic.cn 歌单封面）
//   music-file.y.qq.com / qpic.y.qq.com
//                          QQ 歌单封面实测宿主（imgurl/diss_cover/logo 落点——
//                          https 侧与 http 明文侧）；收窄两个专用子域而非全
//                          y.qq.com：u./c./shc 是 musicu/fcg JSON 端点域，
//                          宽入会扩大「任意人让服务器代取」的回源面
//   kuwo.cn                酷我系 CDN——与音频白名单同口径保留给可选源/自定义封面
export const IMG_PROXY_HOSTS = [
  'ytimg.com', 'ggpht.com',
  'hdslb.com',
  'music.126.net',
  'gtimg.cn', 'qpic.cn',
  'music-file.y.qq.com', 'qpic.y.qq.com', // QQ 歌单封面 CDN（音乐文件/封面专用子域——非全 y.qq.com，收窄服务面）
  'kuwo.cn',
]

// 判定口径与 server/lib/net-guard.js isProxyAllowedHost 同款（=== 或
// .endsWith('.'+d)）：挡 xytimg.com 蹭名与 ytimg.com.evil.com 尾挂。
// 标准入口传 URL.hostname——parser 已小写化/IDN 已 punycode 化；这里仍兜底
// toLowerCase——裸字符串调用方（旧持久化字段/手工拼链）不依赖上游归一化。
// 尾点 FQDN（'ytimg.com.'）服务端 normalizeOutboundUrl 会剥、本谓词不剥：
// 不命中即不代理/直接放行——两侧口径同向收敛（漏包=浏览器直连旧行为）。
export function isImgProxyHost(hostname) {
  const h = String(hostname || '').toLowerCase()
  return IMG_PROXY_HOSTS.some((d) => h === d || h.endsWith('.' + d))
}

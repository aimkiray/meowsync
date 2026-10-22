// 解锁源注册表——替代 @unblockneteasemusic/server 的 match()。
// 每个 provider：async resolve(info, ctx) → {url, urls?, br, durationSec?, ext?} | null
//   urls = 可选镜像组——仅限同一字节实体的备份 URL（跨分辨率/编码的候选
//     是不同文件，混排换档会把同 offset 的另一文件字节拼给客户端）；编排
//     层逐条校验后整组 mint 进 vault，代理只在镜像间轮换
//   ext  = 可选音频工件后缀——URL 推导拿不到真实容器时由 provider 显式
//     供值（bilibili .m4s 链），编排层 unblocked.ext || extOf(url) 消费
//   info = {id, name, artists[], keyword, durationMs}
//   ctx  = {signal, purpose:'playback'|'download'}
// 返回 null/抛错 = 该源不可用，编排层续下一源（与 unm match 语义对齐）
// 可选能力（仅搜索型源实现；pyncmd 是「零错配官方直解」无候选面不加）：
//   async search(keyword, {signal}) → 候选 [{videoId,title,owner,durationSec,cover?,...}]
//     ——手动挑选池；provider 自管归一/去重/截断，不回 resolve 的时长筛/AI 簿
//   async resolveById(mediaId, {signal, purpose}) → {url,urls,br,durationSec?,ext?}|null
//     ——点名直解：跳过搜索/±5s筛/AI仲裁/verdict记忆/死簿，
//       手动绑定唯一信任状是「此刻能否产出可用流」
const pyncmd = require('./pyncmd');
const youtube = require('./youtube');
const bilibili = require('./bilibili');

const PROVIDERS = {
  pyncmd,   // GD Studio 网易聚合 API：id 直解回 *.music.126.net，零错配面（无 search/resolveById）
  youtube,  // Innertube 搜索+选流：候选期有 lengthSeconds，需 /audio-proxy（+search/resolveById）
  bilibili, // SSR 岛搜索+playurl 音轨：B 站搬运第三源——bilivideo 回链需
            // Referer（播放 /audio-proxy、下载 file-downloader 按主机名注入）（+search/resolveById）
};

// 源优先级（删 unm 后）：
// - pyncmd：网易自家 CDN 回链，一次 API 调用出完整文件，非搜索零错配
// - youtube：Innertube 匿名可用且流质量稳定
// - bilibili 第三源：日系术力口/anisong 在 B 站常有搬运——youtube 搜索
//   真空/候选全灭段兜底；排在 youtube 后（匿名搜索面更薄、风控更敏感）
// - qq 不是解锁源：QQ 音乐与网易云同级（曲库+歌单导入），qq_<mid> 曲走
//   routes/qq.js + lib/qq.js 自有直链——拿别家曲库去「解锁」网易曲目是
//   张冠李戴（错配曲/翻唱会被当成正主源回链），整源移除
// （kuwo 已退化 ~11s 剪辑整源移除；kugou/bodian 存活可二期再评）
const PLAYBACK_SOURCES = ['pyncmd', 'youtube', 'bilibili'];
const DOWNLOAD_SOURCES = ['pyncmd', 'youtube', 'bilibili'];

module.exports = { PROVIDERS, PLAYBACK_SOURCES, DOWNLOAD_SOURCES };

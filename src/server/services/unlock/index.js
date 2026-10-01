// 解锁源注册表——替代 @unblockneteasemusic/server 的 match()。
// 每个 provider：async resolve(info, ctx) → {url, br, durationSec?} | null
//   info = {id, name, artists[], keyword, durationMs}
//   ctx  = {signal, purpose:'playback'|'download'}
// 返回 null/抛错 = 该源不可用，编排层续下一源（与 unm match 语义对齐）
const pyncmd = require('./pyncmd');
const youtube = require('./youtube');
const qq = require('./qq');

const PROVIDERS = {
  pyncmd,   // GD Studio 网易聚合 API：id 直解回 *.music.126.net，零错配面
  youtube,  // Innertube 搜索+选流：候选期有 lengthSeconds，需 /audio-proxy
  qq,       // lib/qq.js：musicu vkey 档梯，VIP 档读 QQ_COOKIE，需 /audio-proxy
};

// 源优先级（删 unm 后）：
// - pyncmd：网易自家 CDN 回链，一次 API 调用出完整文件，非搜索零错配
// - playback 侧 youtube 先于 qq：Innertube 匿名可用且流质量稳定；
//   qq 匿名档只剩 M500/C400，VIP 档依赖 QQ_COOKIE 健康度
// - download 侧 qq 先于 youtube：BEST_LADDER 能出 FLAC，归档优先无损
// （kuwo 已退化 ~11s 剪辑整源移除；kugou/bodian 存活可二期再评）
const PLAYBACK_SOURCES = ['pyncmd', 'youtube', 'qq'];
const DOWNLOAD_SOURCES = ['pyncmd', 'qq', 'youtube'];

module.exports = { PROVIDERS, PLAYBACK_SOURCES, DOWNLOAD_SOURCES };

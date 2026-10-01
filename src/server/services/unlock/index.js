// 解锁源注册表——替代 @unblockneteasemusic/server 的 match()。
// 每个 provider：async resolve(info, ctx) → {url, br, durationSec?} | null
//   info = {id, name, artists[], keyword, durationMs}
//   ctx  = {signal, purpose:'playback'|'download'}
// 返回 null/抛错 = 该源不可用，编排层续下一源（与 unm match 语义对齐）
const pyncmd = require('./pyncmd');
const youtube = require('./youtube');

const PROVIDERS = {
  pyncmd,   // GD Studio 网易聚合 API：id 直解回 *.music.126.net，零错配面
  youtube,  // Innertube 搜索+选流：候选期有 lengthSeconds，需 /audio-proxy
};

// 源优先级（删 unm 后）：
// - pyncmd：网易自家 CDN 回链，一次 API 调用出完整文件，非搜索零错配
// - youtube 兜底：Innertube 匿名可用且流质量稳定
// - qq 不是解锁源：QQ 音乐与网易云同级（曲库+歌单导入），qq_<mid> 曲走
//   routes/qq.js + lib/qq.js 自有直链——拿别家曲库去「解锁」网易曲目是
//   张冠李戴（错配曲/翻唱会被当成正主源回链），整源移除
// （kuwo 已退化 ~11s 剪辑整源移除；kugou/bodian 存活可二期再评）
const PLAYBACK_SOURCES = ['pyncmd', 'youtube'];
const DOWNLOAD_SOURCES = ['pyncmd', 'youtube'];

module.exports = { PROVIDERS, PLAYBACK_SOURCES, DOWNLOAD_SOURCES };

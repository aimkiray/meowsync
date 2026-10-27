// 手动媒体源绑定 · 外源流端点消费步：qq_/bv_/yt_ 轨道在 song_unlock_manual
// 有行、且自有源解析已败亡（null/空集/抛错——调用方在失败分支才进本步）
// 时，绑定点名媒体经 resolveById 现解顶替。位序与数值域「官方直解→手动→
// 外源解锁」同构投影：官方直解（自有源腿）→ 手动绑定 → 外源解锁——绑定
// 不压过活的官方源（绑定媒体是「终审替换物」，自有源活着说明无需顶替——
// 与数值域「绑定存在但 pyncmd 健康 → 播官方源」同一语义）。数值 id 的
// 绑定消费在 resolveOne 手动步，不经此。abort 穿透（路由层归一 499），
// 其余失败 console.warn+60s 负档——死绑定期内每次失败不重复烧上游。
// kind=video 由调用方闸住不进本步——绑定语义是音源顶替，resolveById
// 只产音频流，视频模式恒为自有媒体
const unlockManualRepo = require('../../repositories/unlockManual');
const { PROVIDERS } = require('./index');
const { createTtlCache } = require('../../lib/stream-resolve-cache');
const { BVID_RE, YT_ID_RE } = require('../../../shared/predicates.js');
// 持久行严校面与路由 POST 闸同一口径：mediaId 只收源私有 id 净形，
// 永不接 URL 串（SSRF 口径）
const MEDIA_ID_RES = { youtube: YT_ID_RE, bilibili: BVID_RE };

// 60s 与 unlockCache 同档：正档复用签名产物（上游签名寿命以小时计），
// 负档挡「死绑定反复重解」。键带绑定身份（trackId|source|mediaId）——
// 换绑天然换键，解绑后 repo 读 null 根本不进缓存；唯一洞=同媒体重绑后
// 60s 内命中旧负档——POST/DELETE 在路由层补 forgetManualStream 收掉
const manualCache = createTtlCache({ max: 256, ttlMs: 60000 });

// → {source, mediaId, urls, br, ext} | null。null 三分支语义归一：未绑/
// 绑定源无 resolveById 能力/绑定媒体此刻取不出流（含负档命中）——调用方
// 按「无可用顶替」回原自有源错误分档，不区分死因（死因在 warn 日志里）
async function manualStreamOverride(trackId, { purpose = 'playback', signal = null, skipCache = false } = {}) {
  const tid = String(trackId);
  let manual = null;
  try { manual = unlockManualRepo.getManual(tid); } catch { /* 库不可用按无绑定放行 */ }
  if (!manual) return null;
  // 绑定行防御校：行正常只能由已过同款严校的 POST 写入——手工改库/
  // 语义漂移出的脏行（source 枚举外、mediaId 不严形）按无绑处理并
  // warn，不拿脏 mediaId 去烧 provider 解析
  if (!MEDIA_ID_RES[manual.source]?.test(manual.mediaId)) {
    console.warn(`[manual-stream] ${tid} 绑定行形态非法(${manual.source}/${manual.mediaId})，按无绑定放行`);
    return null;
  }
  const provider = PROVIDERS[manual.source];
  if (!provider?.resolveById) return null;
  const key = `${tid}|${manual.source}|${manual.mediaId}`;
  if (!skipCache) {
    const hit = manualCache.get(key);
    if (hit !== undefined) return hit.neg ? null : hit;
  }
  try {
    const r = await provider.resolveById(manual.mediaId, { purpose, signal });
    // 元素类型过滤：{urls:[null]} 这类脏形态不放进 mint——透传会让
    // vault 产 't/null' 死链（POST 验流闸下实际不可达，理论面也收掉）；
    // 空集天然落下方 !urls.length 负档支
    const urls = (Array.isArray(r?.urls) ? r.urls : (r?.url ? [r.url] : []))
      .filter(u => typeof u === 'string' && u);
    if (!urls.length) { manualCache.set(key, { neg: true }); return null; }
    const out = { source: manual.source, mediaId: manual.mediaId, urls, br: r.br ?? null, ext: r.ext ?? null };
    manualCache.set(key, out);
    return out;
  } catch (e) {
    if (e?.aborted || signal?.aborted) throw e; // abort 穿透——端点归一 499
    console.warn(`[manual-stream] ${tid} 绑定媒体 ${manual.source}/${manual.mediaId} 解析失败，原自有源错误照报: ${String(e?.message || e).replace(/[\r\n]+/g, ' ')}`);
    manualCache.set(key, { neg: true });
    return null;
  }
}

// 绑/解绑即时生效口：清该轨道所有绑定身份的缓存位（负档/旧绑定残档）。
// 键前缀 `${trackId}|`——| 界符防 id 前缀误配（unlockCache 同款纪律）
function forgetManualStream(trackId) {
  const prefix = `${String(trackId)}|`;
  for (const k of [...manualCache.keys()]) if (k.startsWith(prefix)) manualCache.delete(k);
}

module.exports = { manualStreamOverride, forgetManualStream };

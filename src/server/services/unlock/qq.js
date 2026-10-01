// qq 解锁源：复用 lib/qq.js 的完整客户端（searchSongs → pickStreamUrl）——
// 替代 unm 的 qq provider。本版更强：档梯式 vkey、mediaMid 回填重试、
// sip 宿主白名单、zzcSign 风控升级签名都是现成能力。
// 读 QQ_COOKIE/NEW_QQ_COOKIE 环境变量（unm 同款约定）解锁 VIP 档；
// purl 的 vkey 绑本机 IP——播放必须经 /audio-proxy（resolveSongUrls
// 的 source==='qq' 分支），明文链下发必然 403 + 凭据外泄
const {
  searchSongs, pickStreamUrl, PLAY_LADDER, BEST_LADDER, QUALITY_TIERS,
} = require('../../lib/qq');
const { pickByDuration } = require('./match');

// QUALITY_TIERS 档位名 → 标称码率（flac 实际码率随源文件波动，给量级即可——
// 下载端时长对账以它为分母估时长，量级对了就够用）
const TIER_BR = { RS01: 1500000, F000: 800000, M800: 320000, M500: 128000, C400: 96000 };

/**
 * @param {{keyword: string, durationMs: number|null}} info
 * @returns {{url: string, br: number|null, durationSec: number|null}|null}
 */
async function resolve(info, { signal, purpose } = {}) {
  // 无真实元数据（song_detail 缺失）时 keyword 为空/裸 id——搜索会
  // 命中无关内容且时长对账缺席，宁缺毋滥直接放弃本源
  if (!info.keyword || !info.name) return null;
  const tracks = await searchSongs(info.keyword, 8, signal);
  const usable = pickByDuration(tracks, info.durationMs, t => t.intervalSec);
  if (!usable.length) return null;
  const ladder = purpose === 'download' ? BEST_LADDER : PLAY_LADDER;
  for (const track of usable.slice(0, 3)) {
    if (signal?.aborted) throw new Error('aborted');
    try {
      const hit = await pickStreamUrl(track.mid, { mediaMid: track.mediaMid, ladder, signal });
      if (hit?.url) {
        return { url: hit.url, br: TIER_BR[hit.tier] ?? null, durationSec: track.intervalSec };
      }
    } catch (e) {
      if (signal?.aborted) throw e;
      // 无权限档/风控失败的候选换下一个
    }
  }
  return null;
}

module.exports = { resolve };

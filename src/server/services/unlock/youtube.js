// youtube 解锁源：Innertube 搜索 → 时长选候选 → fetchPlayer 取流。
// 替代 unm 的 yt-dlp provider（spawn yt-dlp ytsearch1 + 盲 range 探测）——
// 候选期就有 lengthSeconds，选错的概率更低；且不再需要 Docker 里的 yt-dlp。
// 回链是 googlevideo 带 ip= 签名的本机绑定链——播放必须经 /audio-proxy
// 中转（resolveSongUrls 的 source==='youtube' 分支），直发客户端必 403
const { fetchPlayer, innertubeSearch, pickStreamList } = require('../../lib/youtube');
const { pickByDuration } = require('./match');

/**
 * @param {{keyword: string, durationMs: number|null}} info
 * @returns {{url: string, br: number|null, durationSec: number|null}|null}
 */
async function resolve(info, { signal, purpose } = {}) {
  // 无真实元数据（song_detail 缺失）时 keyword 为空/裸 id——搜索会
  // 命中无关内容且时长对账缺席，宁缺毋滥直接放弃本源
  if (!info.keyword || !info.name) return null;
  const candidates = await innertubeSearch(info.keyword, signal, 5);
  const usable = pickByDuration(candidates, info.durationMs, c => c.durationSec);
  if (!usable.length) return null;
  for (const cand of usable) {
    if (signal?.aborted) throw new Error('aborted');
    try {
      const player = await fetchPlayer(cand.videoId, signal);
      const audio = pickStreamList(player.streamingData, 'audio',
        purpose === 'download' ? 'best' : '')[0];
      if (audio?.url) {
        return { url: audio.url, br: audio.bitrate || null, durationSec: cand.durationSec };
      }
    } catch (e) {
      if (signal?.aborted) throw e;
      // 单候选不可播放（地区锁/年龄门）换下一个候选
    }
  }
  return null;
}

module.exports = { resolve };

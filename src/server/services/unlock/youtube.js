// youtube 解锁源：Innertube 搜索 → 时长选候选 → AI 核验 → fetchPlayer 取流。
// 替代 unm 的 yt-dlp provider（spawn yt-dlp ytsearch1 + 盲 range 探测）——
// 候选期就有 lengthSeconds，选错的概率更低；且不再需要 Docker 里的 yt-dlp。
// 回链是 googlevideo 带 ip= 签名的本机绑定链——播放必须经 /audio-proxy
// 中转（resolveSongUrls 的 source==='youtube' 分支），直发客户端必 403
const { fetchPlayer, innertubeSearch, pickStreamList } = require('../../lib/youtube');
const { pickByDuration } = require('./match');
const { aiEnabled, askAiJson, AI_MODEL } = require('../../lib/ai');
const { getVerdict, upsertVerdict } = require('../../repositories/lyricAi');

// 进 prompt 的字段剥换行/方括号——候选标题/频道名是第三方数据
const cleanField = (s) => String(s ?? '')
  .replace(/[\r\n\[\]]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);

// 解锁判定键：(歌曲, 候选视频, 模型) 三元组——同一首歌下被批的候选重试即
// 命中不再问模型；换模型自动失效重判。只持久化 ok=1（正面批准）；ok=0 的
// 全否不持久化——一次「全都不像」的误判不该把候选永久判死
const unlockVkey = (songId, videoId) => `${songId}@yt_${videoId}@${AI_MODEL}`;

// AI 核验时长闸筛过的候选：时长分辨不了 live/remix/翻唱/伴奏等同长错配。
// 判定记忆先行（ok=1 前置、ok=0 剔除），未判批次一次调用择最优；
// AI 不可用/哑火 → 原序放行（AI 是增强不是门禁）
async function aiRankCandidates(info, usable, signal) {
  const approved = [];
  const unjudged = [];
  for (const cand of usable) {
    let v = null;
    try { v = getVerdict(unlockVkey(info.id, cand.videoId), 'unlock'); } catch { /* 库不可用不阻塞解锁 */ }
    if (v?.ok === 0) continue;
    (v?.ok === 1 ? approved : unjudged).push(cand);
  }
  if (!unjudged.length) return approved;
  if (!aiEnabled() || signal?.aborted) return [...approved, ...unjudged];
  try {
    const desc = unjudged.map((c, i) =>
      `${i + 1}. ${cleanField(c.title)} — ${cleanField(c.owner)}（${c.durationSec || '?'}s）`).join('\n');
    const ans = await askAiJson({
      timeoutMs: 10000,
      maxTokens: 32,
      signal,
      system: '你是音乐解锁助手。从视频站候选里选出与目标同一首歌的正式音源'
        + '（官方音源/Official Audio/MV/自动投稿/同曲完整版可算；live/remix/翻唱'
        + '/nightcore/8D/伴奏/卡拉OK/短剪辑不算，除非目标本身就是该版本）。'
        + '都不像返回 {"pick":0}，能确定返回 {"pick":编号}。只输出 JSON。',
      user: `目标：${cleanField(info.name)} — ${cleanField((info.artists || []).join(' / '))}`
        + `（${Math.round((info.durationMs || 0) / 1000) || '?'}s）\n候选：\n${desc}`,
    });
    const n = Number(ans?.pick);
    if (!Number.isInteger(n) || n < 0 || n > unjudged.length) return [...approved, ...unjudged];
    if (n === 0) {
      console.info(`[unlock] ${info.id} AI 判定 ${unjudged.length} 条 YouTube 候选均非目标曲`);
      return approved;
    }
    const picked = unjudged[n - 1];
    try {
      upsertVerdict(unlockVkey(info.id, picked.videoId), 'unlock', 1, cleanField(picked.title).slice(0, 200));
    } catch { /* verdict 落库失败不阻塞解锁 */ }
    console.info(`[unlock] ${info.id} AI 选定候选 ${n}/${unjudged.length}: ${cleanField(picked.title)}`);
    return [...approved, picked, ...unjudged.filter((_, i) => i !== n - 1)];
  } catch {
    return [...approved, ...unjudged];
  }
}

/**
 * @param {{id: any, name: string, artists?: string[], keyword: string, durationMs: number|null}} info
 * @returns {{url: string, br: number|null, durationSec: number|null}|null}
 */
async function resolve(info, { signal, purpose } = {}) {
  // 无真实元数据（song_detail 缺失）时 keyword 为空/裸 id——搜索会
  // 命中无关内容且时长对账缺席，宁缺毋滥直接放弃本源
  if (!info.keyword || !info.name) return null;
  const candidates = await innertubeSearch(info.keyword, signal, 5);
  const usable = pickByDuration(candidates, info.durationMs, c => c.durationSec);
  if (!usable.length) return null;
  // AI 核验/排序后的候选序：批准记忆与模型选定在前，未判候选按原序殿后
  const ordered = await aiRankCandidates(info, usable, signal);
  for (const cand of ordered) {
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

module.exports = { resolve, aiRankCandidates };

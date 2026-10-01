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

// 进程内冷却（非持久 verdict——瞬时态不该进库）：
// - deadCands：批准过的候选取流失败进死簿 30min——死视频每次 resolve 都被
//   前置再死一遍（fetchPlayer 最坏 ~45s）会顶穿 60s 解锁预算；不写 verdict
//   因为「死」是瞬态（风控/可恢复），永久 ok=0 会把对的歌判死
// - rejectedAt：AI 全否（pick:0）冷却 10min——verdict 不持久化否决的代价是
//   重试即重问，冷却把「一直被否的歌反复播放」的 AI 开销收敛到有界
const deadCands = new Map();
const rejectedAt = new Map();
// 在途 AI 判定单飞：同曲同候选集的并发 resolve 共享一次模型调用——
// 键里带候选集指纹，候选变化（新视频进榜）即新键不复用
const inflightRank = new Map();
const DEAD_TTL_MS = 30 * 60 * 1000;
const REJECT_TTL_MS = 10 * 60 * 1000;
const deadKey = (info, cand) => `${info.id}:${cand.videoId}`;
const pruneExpired = (m, ttl) => {
  const now = Date.now();
  for (const [k, ts] of m) if (now - ts > ttl) m.delete(k);
};

// AI 核验时长闸筛过的候选：时长分辨不了 live/remix/翻唱/伴奏等同长错配。
// 判定记忆先行（ok=1 前置、ok=0 剔除——剔除路径给手工 veto 与未来的
// 确定性否决 writer 预留），未判批次一次调用择最优；
// AI 关闭/哑火 → 判定记忆仍生效、未判候选原序放行（记忆是累积知识，
// 不随开关旁路；AI 是增强不是门禁）
async function aiRankCandidates(info, usable, signal) {
  // info.id 是 verdict 键的曲维——缺了会把不同歌的判定串到同一键域，宁退
  if (info?.id == null) return usable;
  const approved = [];
  const unjudged = [];
  const dead = [];
  pruneExpired(deadCands, DEAD_TTL_MS);
  for (const cand of usable) {
    let v = null;
    try { v = getVerdict(unlockVkey(info.id, cand.videoId), 'unlock'); } catch { /* 库不可用不阻塞解锁 */ }
    if (v?.ok === 0) continue;
    if (v?.ok === 1) {
      (deadCands.has(deadKey(info, cand)) ? dead : approved).push(cand);
    } else unjudged.push(cand);
  }
  if (!unjudged.length) return [...approved, ...dead];
  if (!aiEnabled() || signal?.aborted) return [...approved, ...unjudged, ...dead];
  // 全否冷却：近期被判「全都不像」且无新候选结论时本轮直接跳过 AI——
  // 负结果无持久化，冷却是「一直被否的歌反复解锁」的开销闸
  const rejTs = rejectedAt.get(info.id);
  if (rejTs && Date.now() - rejTs < REJECT_TTL_MS) {
    return [...approved, ...dead];   // 未判候选本轮全部跳过
  }
  // 单飞：同一 (曲,候选集) 的在途判定直接搭车。promise 承载的是首调用方的
  // signal——它 abort 时共享调用方拿到 null 走原序放行，属可接受的降级
  const fkey = `${info.id}:${unjudged.map(c => c.videoId).join(',')}`;
  if (!inflightRank.has(fkey)) {
    inflightRank.set(fkey, (async () => {
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
      // 直接对原始值验类型——Number(true)/Number("0")/Number([]) 都会伪装成
      // 合法整数（pick:true 曾被转成 1 把未认可候选写成批准 verdict）
      return Number.isInteger(ans?.pick) && ans.pick >= 0 && ans.pick <= unjudged.length
        ? ans : null;
    })().catch(() => null).finally(() => inflightRank.delete(fkey)));
  }
  const ans = await inflightRank.get(fkey);
  if (signal?.aborted || ans == null) return [...approved, ...unjudged, ...dead];
  if (ans.pick === 0) {
    rejectedAt.set(info.id, Date.now());
    pruneExpired(rejectedAt, REJECT_TTL_MS);
    console.info(`[unlock] ${info.id} AI 判定 ${unjudged.length} 条 YouTube 候选均非目标曲`);
    return [...approved, ...dead];
  }
  const picked = unjudged[ans.pick - 1];
  try {
    upsertVerdict(unlockVkey(info.id, picked.videoId), 'unlock', 1, cleanField(picked.title));
  } catch { /* verdict 落库失败不阻塞解锁 */ }
  console.info(`[unlock] ${info.id} AI 选定候选 ${ans.pick}/${unjudged.length}: ${cleanField(picked.title)}`);
  return [...approved, picked, ...unjudged.filter((_, i) => i !== ans.pick - 1), ...dead];
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
  // AI 核验/排序后的候选序：批准记忆与模型选定在前，死候选押尾
  const ordered = await aiRankCandidates(info, usable, signal);
  if (!ordered.length) {
    console.info(`[unlock] ${info.id} youtube: ${usable.length} 候选全部被判定记忆否决`);
    return null;
  }
  let failed = 0;
  for (const cand of ordered) {
    if (signal?.aborted) throw new Error('aborted');
    try {
      const player = await fetchPlayer(cand.videoId, signal);
      const audio = pickStreamList(player.streamingData, 'audio',
        purpose === 'download' ? 'best' : '')[0];
      if (audio?.url) {
        return { url: audio.url, br: audio.bitrate || null, durationSec: cand.durationSec };
      }
      failed += 1;
      deadCands.set(deadKey(info, cand), Date.now());
    } catch (e) {
      if (signal?.aborted) throw e;
      failed += 1;
      deadCands.set(deadKey(info, cand), Date.now());
      // 单候选不可播放（地区锁/年龄门）换下一个候选
    }
  }
  if (failed) console.info(`[unlock] ${info.id} youtube: ${failed}/${ordered.length} 候选取流失败`);
  return null;
}

module.exports = { resolve, aiRankCandidates };

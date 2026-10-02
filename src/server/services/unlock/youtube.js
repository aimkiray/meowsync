// youtube 解锁源：Innertube 搜索 → 时长选候选 → AI 核验 → 闸控感知取流
//（services/youtube-resolve.js：探测 SABR 闸控 → VISIONOS 升级 → 合流兜底）。
// 替代 unm 的 yt-dlp provider（spawn yt-dlp ytsearch1 + 盲 range 探测）——
// 候选期就有 lengthSeconds，选错的概率更低；且不再需要 Docker 里的 yt-dlp。
// 回链是 googlevideo 带 ip= 签名的本机绑定链——播放必须经 /audio-proxy
// 中转（resolveSongUrls 的 source==='youtube' 分支），直发客户端必 403
const { innertubeSearch } = require('../../lib/youtube');
const { resolveYoutubeStreams } = require('../youtube-resolve');
const { pickByDuration } = require('./match');
const { aiEnabled, askAiJson, AI_MODEL } = require('../../lib/ai');
const { getVerdict, upsertVerdict } = require('../../repositories/lyricAi');

// 进 prompt 的字段剥换行/方括号/控制符——候选标题/频道名是第三方数据，
// C0/C1 控制符（ANSI 转义等）原样进日志与 verdict detail 列，一并剥除
const cleanField = (s) => String(s ?? '')
  .replace(/[\x00-\x1f\x7f-\x9f\r\n\[\]]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);

// 解锁判定键：(歌曲, 候选视频, 模型) 三元组——同一首歌下被批的候选重试即
// 命中不再问模型；换模型自动失效重判
const unlockVkey = (songId, videoId) => `${songId}@yt_${videoId}@${AI_MODEL}`;

// 进程内冷却（非持久 verdict——瞬时态不该进库）：
// - deadCands：取流失败的候选进死簿 30min 押尾——死视频每次 resolve 都被
//   前置再死一遍（resolveYoutubeStreams 含探测最坏 ~55s）会顶穿 60s 解锁预算。同一对反复
//   死（n>=2）升级写 ok=0 verdict 收敛——一次死可能是风控/瞬断，反复死
//   不是；verdict 一旦落库就永久剔除出 AI 候选池与排序
// - rejectedAt：AI 全否（pick:0）冷却 10min——verdict 不持久化否决的代价是
//   重试即重问；冷却按「被拒候选集」生效：搜索漂移出新视频即重新评估，
//   不让一次 pick:0 把换代后的候选集也吞掉
// - inflightRank：在途 AI 判定单飞，键带候选集指纹——同曲同候选集的并发
//   resolve 共享一次模型调用；指纹含顺序是故意的：ans.pick 是首调用方
//   数组下标，同序才保证搭车者映射回同一个候选
const deadCands = new Map();   // deadKey -> {at, n}
const rejectedAt = new Map();  // String(songId) -> {at, ids: Set<videoId>}
const inflightRank = new Map();
const DEAD_TTL_MS = 30 * 60 * 1000;
const REJECT_TTL_MS = 10 * 60 * 1000;
const deadKey = (info, cand) => `${info.id}:${cand.videoId}`;
const isDead = (info, cand) => {
  const d = deadCands.get(deadKey(info, cand));
  return !!d && Date.now() - d.at < DEAD_TTL_MS;
};
const markDead = (info, cand) => {
  const key = deadKey(info, cand);
  const n = (deadCands.get(key)?.n || 0) + 1;
  deadCands.set(key, { at: Date.now(), n });
  if (n >= 2) {
    try {
      upsertVerdict(unlockVkey(info.id, cand.videoId), 'unlock', 0, `stream-dead x${n}`);
    } catch { /* verdict 落库失败不阻塞解锁 */ }
  }
};
const pruneExpired = (m, ttl) => {
  const now = Date.now();
  for (const [k, v] of m) if (now - (v.at ?? v) > ttl) m.delete(k);
};

// AI 核验时长闸筛过的候选：时长分辨不了 live/remix/翻唱/伴奏等同长错配。
// 判定记忆先行（ok=1 前置、ok=0 剔除），未判批次一次调用择最优；
// AI 关闭/哑火 → 判定记忆仍生效、未判候选原序放行（记忆是累积知识，
// 不随开关旁路；AI 是增强不是门禁）。
// 返回 {ordered, pickedId}：批准 verdict（ok=1）延迟到 resolve() 里
// 该候选取流验证成功才落库——先写库遇到死流会让死候选
// 永久压在队首反复重死，顶穿解锁预算
async function aiRankCandidates(info, usable, signal) {
  const pass = (ordered) => ({ ordered, pickedId: null });
  // info.id 是 verdict 键的曲维——缺了会把不同歌的判定串到同一键域，宁退
  if (info?.id == null) return pass(usable);
  const sid = String(info.id);
  const approved = [];
  const unjudged = [];
  const dead = [];
  pruneExpired(deadCands, DEAD_TTL_MS);
  for (const cand of usable) {
    let v = null;
    try { v = getVerdict(unlockVkey(info.id, cand.videoId), 'unlock'); } catch { /* 库不可用不阻塞解锁 */ }
    if (v?.ok === 0) continue;
    // 死簿对全量候选生效：未判候选死过同样押尾、不再喂回 AI prompt
    if (v?.ok === 1) (isDead(info, cand) ? dead : approved).push(cand);
    else (isDead(info, cand) ? dead : unjudged).push(cand);
  }
  if (!unjudged.length) return pass([...approved, ...dead]);
  if (!aiEnabled() || signal?.aborted) return pass([...approved, ...unjudged, ...dead]);
  // 全否冷却按被拒候选集生效：候选集原封未变才跳过 AI；有任何新视频
  // 进榜即重新评估（负结果不持久化的设计意图延伸到冷却层）
  const rej = rejectedAt.get(sid);
  if (rej && Date.now() - rej.at < REJECT_TTL_MS
      && unjudged.every(c => rej.ids.has(c.videoId))) {
    console.info(`[unlock] ${sid} 候选集命中全否冷却，跳过 AI（${unjudged.length} 条）`);
    return pass([...approved, ...dead]);
  }
  // 单飞：同一 (曲,候选集) 的在途判定直接搭车。共享 promise 不带调用方
  // signal——首调用方 abort 不该让搭车者陪绑降级（同 unlockInfoInflight
  // 先例）；10s timeoutMs 是内层自净上限。搭车者用自己的 signal 决定吃不吃结果
  const fkey = `${sid}:${unjudged.map(c => c.videoId).join(',')}`;
  if (!inflightRank.has(fkey)) {
    inflightRank.set(fkey, (async () => {
      const desc = unjudged.map((c, i) =>
        `${i + 1}. ${cleanField(c.title)} — ${cleanField(c.owner)}（${c.durationSec || '?'}s）`).join('\n');
      const ans = await askAiJson({
        timeoutMs: 10000,
        maxTokens: 32,
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
  if (signal?.aborted || ans == null) return pass([...approved, ...unjudged, ...dead]);
  if (ans.pick === 0) {
    rejectedAt.set(sid, { at: Date.now(), ids: new Set(unjudged.map(c => c.videoId)) });
    pruneExpired(rejectedAt, REJECT_TTL_MS);
    console.info(`[unlock] ${sid} AI 判定 ${unjudged.length} 条 YouTube 候选均非目标曲`);
    return pass([...approved, ...dead]);
  }
  const picked = unjudged[ans.pick - 1];
  console.info(`[unlock] ${sid} AI 选定候选 ${ans.pick}/${unjudged.length}: ${cleanField(picked.title)}`);
  return {
    ordered: [...approved, picked, ...unjudged.filter((_, i) => i !== ans.pick - 1), ...dead],
    pickedId: picked.videoId
  };
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
  const { ordered, pickedId } = await aiRankCandidates(info, usable, signal);
  if (!ordered.length) {
    console.info(`[unlock] ${info.id} youtube: ${usable.length} 候选全部被判定记忆否决`);
    return null;
  }
  let failed = 0;
  for (const cand of ordered) {
    if (signal?.aborted) throw new Error('aborted');
    try {
      // 闸控感知取流（services/youtube-resolve.js）：SABR 闸控的视频
      // 探测→VISIONOS 重解，自适应批已证 403 时合流档提首——此前这里
      // 裸拿 ANDROID/IOS 自适应首条，被闸视频解锁「成功」却回链 403。
      // 单候选 30s 子预算：探测+重解病态叠加最坏 ~55s，不封顶会让 1 号
      // 候选烧穿 60s 整源预算、后排候选永不出场——超时按死候选记簿续试
      const candSignal = AbortSignal.any(
        [AbortSignal.timeout(30000), ...(signal ? [signal] : [])]);
      const { streams } = await resolveYoutubeStreams(cand.videoId, {
        kind: 'audio',
        prefer: purpose === 'download' ? 'best' : '',
        signal: candSignal,
      });
      const head = streams[0];
      if (head) {
        // AI 选定候选取流验证成功才落批准 verdict——「批准」承诺的是
        // 「是这首歌且能播」，未经流验证的批准会把死候选永久压队首
        if (pickedId && cand.videoId === pickedId) {
          try {
            upsertVerdict(unlockVkey(info.id, pickedId), 'unlock', 1, cleanField(cand.title));
          } catch { /* verdict 落库失败不阻塞解锁 */ }
        }
        // 整条候选链透出：探测无定论（gated=null）但实际被闸时首链仍
        // 可能死——下游 vault 逐链 mint，代理侧试到活档钉位，合流尾档
        // 兜底（与 /stream 同权，不再押注单链）
        return {
          url: head.url,
          urls: streams.map(s => s.url),
          br: head.br,
          durationSec: cand.durationSec
        };
      }
      failed += 1;
      markDead(info, cand);
    } catch (e) {
      if (signal?.aborted) throw e;
      failed += 1;
      markDead(info, cand);
      // 单候选不可播放（地区锁/年龄门）换下一个候选
    }
  }
  if (failed) console.info(`[unlock] ${info.id} youtube: ${failed}/${ordered.length} 候选取流失败`);
  return null;
}

module.exports = { resolve, aiRankCandidates };

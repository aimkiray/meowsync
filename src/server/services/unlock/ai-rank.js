// 解锁 AI 核验共享面——原 youtube.js 内联实现泛化而来（yt_/bv_ 键域分簿）。
// 每个搜索型解锁源 createAiRank 一份独立状态：死簿/全否冷却/判定单飞
// 按源分簿——候选 id 跨源无共享语义（bvid 与 videoId 同形也不同物），
// 共用簿会让 youtube 的全否冷却把同曲 B 站候选集一并吞掉。
// 候选契约统一为 {videoId, title, owner, durationSec}——provider 在各自
// 边界归一（youtube 候选天然此形；bilibili 搜索行映射 bvid→videoId、
// author→owner）。
const { aiEnabled, askAiJson, aiModel } = require('../../lib/ai');
const { getVerdict, upsertVerdict } = require('../../repositories/lyricAi');
const { getDb } = require('../../db/client');

// 进 prompt 的字段剥换行/方括号/控制符——候选标题/频道名是第三方数据，
// C0/C1 控制符（ANSI 转义等）原样进日志与 verdict detail 列，一并剥除
const cleanField = (s) => String(s ?? '')
  .replace(/[\x00-\x1f\x7f-\x9f\r\n\[\]]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);

// song_ai_verdict 的 unlock 行按 vkey 前缀整删（hard retry）。repo 的
// deleteUnlockVerdicts 把 GLOB 前缀钉死 '@yt_*'——bv_/后续源由此参数化
// 同款删除。SQL 与 repo 逐字一致（GLOB 只 '*' 通配、LIKE '_' 单字宽匹
// 不适用、值全量绑定），长期该下沉成 repo 形参；当前受文件域约束落这里
function deleteUnlockVerdictsByPrefix(songId, keyPrefix) {
  return getDb().prepare(
    `DELETE FROM song_ai_verdict WHERE kind = 'unlock' AND song_id GLOB ?`
  ).run(`${String(songId)}@${keyPrefix}*`).changes;
}

// 进程内冷却（非持久 verdict——瞬时态不该进库）：
// - deadCands：取流失败的候选进死簿 30min 押尾——死视频每次 resolve 都被
//   前置再死一遍会顶穿 60s 解锁预算。同一对反复
//   死（n>=2）升级写 ok=0 verdict 收敛——一次死可能是风控/瞬断，反复死
//   不是；verdict 一旦落库就永久剔除出 AI 候选池与排序
// - rejectedAt：AI 全否（pick:0）冷却 10min——verdict 不持久化否决的代价是
//   重试即重问；冷却按「被拒候选集」生效：搜索漂移出新视频即重新评估，
//   不让一次 pick:0 把换代后的候选集也吞掉
// - inflightRank：在途 AI 判定单飞，键带候选集指纹——同曲同候选集的并发
//   resolve 共享一次模型调用；指纹含顺序是故意的：ans.pick 是首调用方
//   数组下标，同序才保证搭车者映射回同一个候选
const DEAD_TTL_MS = 30 * 60 * 1000;
const REJECT_TTL_MS = 10 * 60 * 1000;

/**
 * @param {{keyPrefix: string, sourceLabel: string, deleteVerdicts: (sid: string) => any}} opts
 *   keyPrefix：判定键域（'yt_'/'bv_'）——vkey = <曲id>@<keyPrefix><候选id>@<模型>
 *   sourceLabel：日志行内源名（'YouTube'/'B站'）
 *   deleteVerdicts(sid)：持久 verdict 整组删除钩——youtube 走 repo
 *     deleteUnlockVerdicts（@yt_*），bilibili 走 deleteUnlockVerdictsByPrefix
 * @returns {{aiRankCandidates: Function, markDead: Function,
 *   unlockVkey: Function, forgetSong: Function}}
 */
function createAiRank({ keyPrefix, sourceLabel, deleteVerdicts }) {
  // 解锁判定键：(歌曲, 候选视频, 模型) 三元组——同一首歌下被批的候选重试即
  // 命中不再问模型；换模型自动失效重判
  const unlockVkey = (songId, videoId) => `${songId}@${keyPrefix}${videoId}@${aiModel()}`;
  const aiTag = `${String(keyPrefix).replace(/_+$/, '')}-rank`;

  const deadCands = new Map();   // deadKey -> {at, n}
  const rejectedAt = new Map();  // String(songId) -> {at, ids: Set<videoId>}
  const inflightRank = new Map();
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
      const p = (async () => {
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
          tag: aiTag,
        });
        // 直接对原始值验类型——Number(true)/Number("0")/Number([]) 都会伪装成
        // 合法整数（pick:true 曾被转成 1 把未认可候选写成批准 verdict）
        return Number.isInteger(ans?.pick) && ans.pick >= 0 && ans.pick <= unjudged.length
          ? ans : null;
      })().catch(() => null)
        // 身份守卫同 unlockInflight 口径：forgetSong 外部清键后旧链仍在途——
        // finally 只逐自身，防误删后注册的同键 gate（回调异步触发，越 TDZ）
        .finally(() => { if (inflightRank.get(fkey) === p) inflightRank.delete(fkey); });
      inflightRank.set(fkey, p);
    }
    const ans = await inflightRank.get(fkey);
    if (signal?.aborted || ans == null) return pass([...approved, ...unjudged, ...dead]);
    if (ans.pick === 0) {
      rejectedAt.set(sid, { at: Date.now(), ids: new Set(unjudged.map(c => c.videoId)) });
      pruneExpired(rejectedAt, REJECT_TTL_MS);
      console.info(`[unlock] ${sid} AI 判定 ${unjudged.length} 条 ${sourceLabel} 候选均非目标曲`);
      return pass([...approved, ...dead]);
    }
    const picked = unjudged[ans.pick - 1];
    console.info(`[unlock] ${sid} AI 选定候选 ${ans.pick}/${unjudged.length}: ${cleanField(picked.title)}`);
    return {
      ordered: [...approved, picked, ...unjudged.filter((_, i) => i !== ans.pick - 1), ...dead],
      pickedId: picked.videoId
    };
  }

  // 按曲清解锁负状态（手动重试 = hard retry）：死簿/全否冷却/在途判定单飞
  // 按曲前缀清——共享 promise 仍在飞的无法取消，但新 resolve 不再搭车；
  // 持久 verdict（ok=0 否决与 ok=1 批准）经 deleteVerdicts 钩整组删——
  // 批准侧虽可惜但「候选是好是坏」在墙期采集的证据本就不可信，重新判定
  // 代价只是一次 AI 调用。DB 不可用不阻塞重试链。
  function forgetSong(songId) {
    const sid = String(songId);
    const prefix = `${sid}:`;
    for (const k of deadCands.keys()) if (k.startsWith(prefix)) deadCands.delete(k);
    rejectedAt.delete(sid);
    for (const k of inflightRank.keys()) if (k.startsWith(prefix)) inflightRank.delete(k);
    try { deleteVerdicts?.(sid); } catch { /* DB 不可用不阻塞重试 */ }
  }

  return { aiRankCandidates, markDead, unlockVkey, forgetSong };
}

module.exports = { cleanField, createAiRank, deleteUnlockVerdictsByPrefix };

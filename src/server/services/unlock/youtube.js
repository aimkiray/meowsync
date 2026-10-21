// youtube 解锁源：Innertube 搜索 → 时长选候选 → AI 核验 → 闸控感知取流
//（services/youtube-resolve.js：探测 SABR 闸控 → VISIONOS 升级 → 合流兜底）。
// 替代 unm 的 yt-dlp provider（spawn yt-dlp ytsearch1 + 盲 range 探测）——
// 候选期就有 lengthSeconds，选错的概率更低；且不再需要 Docker 里的 yt-dlp。
// 回链是 googlevideo 带 ip= 签名的本机绑定链——播放必须经 /audio-proxy
// 中转（resolveSongUrls 的 source==='youtube' 分支），直发客户端必 403
const { innertubeSearch } = require('../../lib/youtube');
const { resolveYoutubeStreams } = require('../youtube-resolve');
// degradedKeyword 与 bilibili 共用（./match.js）——搜索真空降级词只此一份
const { pickByDuration, degradedKeyword } = require('./match');
const { upsertVerdict, deleteUnlockVerdicts } = require('../../repositories/lyricAi');
const { cleanField, createAiRank } = require('./ai-rank');
// 源级熔断记账——authRejected 是 IP 信誉证据而非候选死活
const sourceHealth = require('./health');

// AI 核验/判定记忆/死簿/全否冷却/在途单飞走共享面（./ai-rank.js）——
// yt_ 键域实例：持久 verdict 删除走 repo 的 deleteUnlockVerdicts
// （GLOB <sid>@yt_*）。语义与原内联实现逐字一致
const { aiRankCandidates, markDead, unlockVkey, forgetSong } = createAiRank({
  keyPrefix: 'yt_', sourceLabel: 'YouTube', deleteVerdicts: deleteUnlockVerdicts,
});

/**
 * @param {{id: any, name: string, artists?: string[], keyword: string, durationMs: number|null}} info
 * @returns {{url: string, urls: string[], br: number|null, durationSec: number|null}|null}
 * @throws 候选含 authRejected 证据（authSeen>0 全灭）时抛带 err.authRejected/
 *         err.authCounted 的 Error——编排层据此归 authwall 且不重复记连败
 */
async function resolve(info, { signal, purpose } = {}) {
  // 无真实元数据（song_detail 缺失）时 keyword 为空/裸 id——搜索会
  // 命中无关内容且时长对账缺席，宁缺毋滥直接放弃本源
  if (!info.keyword || !info.name) return null;
  let candidates = await innertubeSearch(info.keyword, signal, 5);
  // 搜索真空降级：只在 items 零条目时触发（时长筛空/AI 全否均不算——
  // 那些是「搜到了但不配」，换词重搜没有依据）。剥掉歌名尾缀版本修饰
  // 重建 name - artists 词重试一次；剥后与原词相同说明无可剥，省第二跳
  if (!candidates.length) {
    const degraded = degradedKeyword(info);
    if (degraded && degraded !== info.keyword) {
      console.info(`[unlock] ${info.id} youtube: 首搜零条目，剥版本后缀重试「${degraded}」`);
      candidates = await innertubeSearch(degraded, signal, 5);
    }
  }
  const usable = pickByDuration(candidates, info.durationMs, c => c.durationSec);
  if (!usable.length) return null;
  // AI 核验/排序后的候选序：批准记忆与模型选定在前，死候选押尾
  const { ordered, pickedId } = await aiRankCandidates(info, usable, signal);
  if (!ordered.length) {
    console.info(`[unlock] ${info.id} youtube: ${usable.length} 候选全部被判定记忆否决`);
    return null;
  }
  let failed = 0;
  let authSeen = 0;
  let wallSeen = false;
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
        // 回链单实体：跨码率/编码的候选是不同字节文件，混排换档会把同一
        // offset 的另一文件字节拼给代理/下载器（bilibili 同字节镜像先例的
        // 反面）——只下发首链；排序语义已保证首链即最优活档（闸控判定的
        // deadAdaptive 场景合流在首）。死档由上游重试触发重解
        return {
          url: head.url,
          urls: [head.url],
          br: head.br,
          durationSec: cand.durationSec
        };
      }
      failed += 1;
      markDead(info, cand);
    } catch (e) {
      // abort 重抛先于记账——裸 authRejected 透出由编排层单记，此路径绝不可挂 authCounted
      if (signal?.aborted) throw e;
      failed += 1;
      if (e?.authRejected) {
        authSeen += 1;
        // 不进死簿：bot 墙下候选没死，死簿 n>=2 还会把健康视频永久写成
        // ok=0 verdict——墙期证据污染判定记忆是本事故次生伤。连败到阈
        // 即整源停打：剩余候选继续跑只是给风控喂信号
        if (sourceHealth.noteAuthRejected('youtube')) { wallSeen = true; break; }
        continue;
      }
      markDead(info, cand);
      // 单候选不可播放（地区锁/年龄门）换下一个候选
    }
  }
  if (failed) console.info(`[unlock] ${info.id} youtube: ${failed}/${ordered.length} 候选取流失败`);
  // authwall 透出：回 null 会被编排层记成 nomatch 丢真因——抛 authRejected
  // 错让 cls=authwall；单发（1 候选会员专享）也抛，盖不盖章由 health
  // 连败判据独立决定，与本抛错解耦
  if (authSeen > 0) {
    const err = new Error(`Innertube 凭据被拒（${authSeen}/${ordered.length} 候选${wallSeen ? '，源已熔断' : ''}）`);
    err.authRejected = true;
    err.authCounted = true;   // [canonical MARKER] 连败已在逐候选处记账，防编排层双计
    throw err;
  }
  return null;
}

module.exports = { resolve, aiRankCandidates, forgetSong };

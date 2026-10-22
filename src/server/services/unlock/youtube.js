// youtube 解锁源：Innertube 搜索 → 时长选候选 → AI 核验 → 闸控感知取流
//（services/youtube-resolve.js：探测 SABR 闸控 → VISIONOS 升级 → 合流兜底）。
// 替代 unm 的 yt-dlp provider（spawn yt-dlp ytsearch1 + 盲 range 探测）——
// 候选期就有 lengthSeconds，选错的概率更低；且不再需要 Docker 里的 yt-dlp。
// 回链是 googlevideo 带 ip= 签名的本机绑定链——播放必须经 /audio-proxy
// 中转（resolveSongUrls 的 source==='youtube' 分支），直发客户端必 403
const { innertubeSearch } = require('../../lib/youtube');
const { resolveYoutubeStreams } = require('../youtube-resolve');
// videoId 形闸唯一真相源在共享谓词层（CJS require(ESM) 直读）——
// 与路由层 POST /unlock/manual 的 mediaId 严校同一份正则，不养第二份
const { YT_ID_RE } = require('../../../shared/predicates.js');
// durationPool/degradedKeyword 与 bilibili 共用（./match.js）——
// 时长选候选三态池与搜索真空降级词只此一份
const { durationPool, degradedKeyword } = require('./match');
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

// 下游可对账判据：候选自带正时长——编排层 durationSec>0 时 estMs 直接
// 取它比对（netease-api.js）。lockupItem 无角标兜底 0/videoItemOf 缺
// 字段归 null 的候选胜出链是 googlevideo——裸 HEAD 会毒化签名链被
// 编排层刻意跳过 → estMs null → 时长对账静默放行。仲裁池划分与胜出
// 留痕共用这一判据（bilibili 侧同型，见 unlock/bilibili.js durOk 注）
const durOk = (c) => Number.isFinite(c?.durationSec) && c.durationSec > 0;

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
  // ±5s 筛仍是首选；筛空但候选在场时不弃——全候选（search 截断 5 条内）
  // 交 AI 语义仲裁。±5s 比编排层 DURATION_TOLERANCE(youtube 0.4)严一个
  // 量级：官方上传/MV 带片头尾超窗却是真命候选（实机假阴性）；AI 的
  // 「官方音源/MV 可算，live/remix/翻唱/短剪辑不算」判定才是错配正主闸，
  // 下游时长对账仍是最终硬墙
  const { pool: usable, arbitrated } = durationPool(candidates, info.durationMs, c => c.durationSec);
  if (arbitrated) {
    console.info(`[unlock] ${info.id} youtube: ±5s 时长筛全灭，${usable.length} 候选交 AI 仲裁`);
  }
  if (!usable.length) return null;
  // AI 核验/排序后的候选序：批准记忆与模型选定在前，死候选押尾
  const { ordered: ranked, pickedId } = await aiRankCandidates(info, usable, signal);
  if (!ranked.length) {
    console.info(`[unlock] ${info.id} youtube: ${usable.length} 候选全部被判定记忆否决`
      + `${arbitrated ? '（±5s 全灭仲裁池）' : ''}`);
    return null;
  }
  // 仲裁池限定——缺时长候选稳定划分押尾（bilibili 同型）：不可对账
  // 候选（durOk 注）胜出会让下游时长对账静默缺位，故只允许它们在
  // 全灭后才被摸，缺墙暴露面压到最窄。划分保各组内相对序——AI 语义
  // 排序（verdict/批准/冷却）已在 aiRankCandidates 内生效不受扰，
  // 只是可对账候选先试错。非仲裁池不动：±5s 命中集自带正时长
  // （筛子判据即 Number.isFinite），durationMs 缺席时连对账基准都不存在
  const ordered = arbitrated
    ? [...ranked.filter(durOk), ...ranked.filter(c => !durOk(c))]
    : ranked;
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
        // 胜出候选缺时长 → googlevideo 刻意跳裸 HEAD → estMs null →
        // 对账墙缺位——诚实留痕（划分已把缺时长押尾，能走到这意味
        // 可对账候选全灭/不在池）
        if (arbitrated && !durOk(cand)) {
          console.info(`[unlock] ${info.id} youtube: 仲裁选中候选缺时长字段，下游对账缺位`);
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

// ── 可选能力（仅搜索型源实现；pyncmd 是「零错配官方直解」无候选面不加）──
//   async search(keyword, {signal}) → 候选 [{videoId,title,owner,durationSec,cover?,...}]
//     ——手动挑选池；provider 自管归一/去重/截断，不回 resolve 的时长筛/AI 簿
//   async resolveById(mediaId, {signal, purpose}) → {url,urls,br,durationSec?,ext?}|null
//     ——点名直解：跳过搜索/±5s筛/AI仲裁/verdict记忆/死簿，
//       手动绑定唯一信任状是「此刻能否产出可用流」

// 手动挑选池：位置形 innertubeSearch 与 resolve 内 L41/L49 同式（回裸 items
// 数组）。放宽到 8 条——自动链 5 条截断正是漏真命候选的来源之一；不回
// 时长筛/AI 簿——人眼终审要看全池。cover 由 videoId 确定性推导零上行
// （mqdefault 恒存在档），i.ytimg.com 在 IMG_PROXY_HOSTS 白名单内
async function search(keyword, { signal } = {}) {
  const items = await innertubeSearch(keyword, signal, 8);
  return (items || []).map(it => ({
    ...it,
    cover: `https://i.ytimg.com/vi/${it.videoId}/mqdefault.jpg`,
  }));
}

// 点名直解：YT_ID_RE 形闸前置（非法 videoId 不烧上游一跳）→ 30s 子预算
//（与 resolve 内逐候选同口径：探测+重解病态叠加最坏 ~55s 必须封顶）→
// 闸控感知取流 → 首流映射（跨档混排=不同字节实体，resolve 内同戒律）。
// 不写 verdict/deadCands——候选语义 info 不在场，死簿只记自动链证据；
// authRejected 裸抛透出由路由/编排层分类消费（本函数未逐候选记账，
// 故不挂 authCounted——编排层会单记一次连败）
async function resolveById(videoId, { signal, purpose } = {}) {
  if (!YT_ID_RE.test(String(videoId || ''))) return null;
  const candSignal = AbortSignal.any(
    [AbortSignal.timeout(30000), ...(signal ? [signal] : [])]);
  const { streams } = await resolveYoutubeStreams(videoId, {
    kind: 'audio',
    prefer: purpose === 'download' ? 'best' : '',
    signal: candSignal,
  });
  const head = streams?.[0];
  if (!head) return null;
  return {
    url: head.url,
    urls: [head.url],
    br: head.br ?? null,
    durationSec: null,   // 点名解没有候选期时长——编排层对账取绑定行快照
  };
}

module.exports = { resolve, search, resolveById, aiRankCandidates, forgetSong };

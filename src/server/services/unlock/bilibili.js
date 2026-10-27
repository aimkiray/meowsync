// bilibili 解锁源（第三源）：SSR 数据岛搜索 → 时长选候选 → AI 核验 →
// playurl 自适应音轨取链。日系术力口/anisong 在 B 站常有搬运稿——
// youtube 搜索真空/候选全灭时兜底。
// 链路全走 lib/bilibili 现成原语：biliSearchVideos（window.__pinia 岛，
// 匿名唯一可达的搜索面）+ resolveBiliAudio（fnval=4048 playurl →
// 'best' 排序音轨：flac > dolby > AAC）。
// 回链是 upos-*.bilivideo.com CDN 链——Referer/UA 是防盗链硬门槛，由
// 下游注入（播放端 /audio-proxy 已注入，routes/proxy.js；下载端
// file-downloader 按主机名注入），本层只产链。
const { biliSearchVideos, resolveBiliAudio } = require('../../lib/bilibili');
// bvid 形闸唯一真相源在共享谓词层（CJS require(ESM) 直读）——
// 与路由层 POST /unlock/manual 的 mediaId 严校同一份正则，不养第二份
const { BVID_RE } = require('../../../shared/predicates.js');
// durationPool/degradedKeyword 与 youtube 共用（./match.js）——
// 时长选候选三态池与搜索真空降级词只此一份
const { durationPool, degradedKeyword } = require('./match');
const { upsertVerdict } = require('../../repositories/lyricAi');
const { cleanField, createAiRank, deleteUnlockVerdictsByPrefix } = require('./ai-rank');

// AI 核验/判定记忆/死簿/全否冷却/在途单飞共享面实例——bv_ 键域：同曲
// yt/bv 判定互不串簿。持久 verdict 删除走 bv_ 前缀 GLOB（repo 的
// deleteUnlockVerdicts 钉死 @yt_*，见 ai-rank.js 注）
const { aiRankCandidates, markDead, unlockVkey, forgetSong } = createAiRank({
  keyPrefix: 'bv_', sourceLabel: 'B站',
  deleteVerdicts: (sid) => deleteUnlockVerdictsByPrefix(sid, 'bv_'),
});

// transient 判据与编排层 UNLOCK_TRANSIENT_RE（netease-api.js，私有表）
// 同口径的最小复刻：已命中形态（5xx/429/超时/网络层）原样透传不加标记
const TRANSIENT_LIKE_RE = /HTTP (5\d\d|429)|超时|timed?\s*out|abort|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket hang up/i;

// B 站风控/瞬断归 transient：HTTP 412（v_voucher 风控墙同族的实名风控码）、
// code=-412、岛漂移、重定向越域等搜索失败裸抛会被编排层归 nomatch——
// 下载任务直接 fatal 终判，而风控窗内重试本可能恢复。附「HTTP 429 等价」
// 可识别标记让 classifyUnlockError 归 transient（退避重试语义）
function asTransientErr(tag, e) {
  const msg = String(e?.message || e);
  if (TRANSIENT_LIKE_RE.test(msg)) return e;
  return new Error(`${tag}：${msg}（风控/瞬断——按 HTTP 429 等价归类）`);
}

// 取流段风控证据判别：HTTP 412 / code=-412 / code=-352（风控校验失败）/
// code=-799（请求过于频繁——限流同族码，与 -404 系「稿件不可访问」
// 判据不搭界）是 IP 信誉信号不是稿件死活——进死簿会把健康候选押尾，
// n>=2 还会升级 ok=0 verdict 永久判死（routes/bilibili.js 对 code 的
// 分档口径：-400/-403/-404 确定性错误映射 404，-352/-412 风控族仍 502
// ——本表即「风控族」一侧）。\b 界挡 code=-3520 式前缀误配。
// （youtube 侧 authRejected 不入死簿的同口径：墙证据不污染判定记忆）
const BILI_WALL_RE = /HTTP 412|code=-(352|412|799)\b/i;
const isWallErr = (e) => BILI_WALL_RE.test(String(e?.message || e));
// 墙证据本地停打阈（youtube 侧 sourceHealth.noteAuthRejected 到阈 break
// 同口径——本域未接 sourceHealth，阈自守）：仲裁池放宽后至多 8 候选 ×
// ~3 跳 playurl/view/cid 自愈，墙期持续 -352/-412/-799 只是给风控喂
// 信号——第 2 记墙证据即停打剩余候选（计数取累计墙数非连败：混排的
// 普通死候选不抵消「IP 已被拦」这一事实）
const WALL_EVIDENCE_CAP = 2;

// resolveBiliAudio 把全部档（flac/杜比/AAC 多档）摊平成单列表，档界已失。
// urls 契约 = 同一字节实体的镜像组：同档 baseUrl/backup_url 仅换 CDN
// 主机、pathname 相同（档位码在文件名里），跨档必不同 path——按「与
// 首条同 pathname」取前缀组还原该档镜像。镜像 path 漂移时组自动截断，
// 退化为少镜像甚至单链——宁可少镜像绝不跨档拼实体（组内换档拼的是
// 不同文件的字节）
const pathOf = (u) => { try { return new URL(u).pathname; } catch { return null; } };
function mirrorGroup(cands) {
  const urls = [cands[0].url];
  const headPath = pathOf(cands[0].url);
  if (headPath != null) {
    for (let i = 1; i < cands.length; i++) {
      if (pathOf(cands[i].url) !== headPath) break;
      urls.push(cands[i].url);
    }
  }
  return urls;
}

// 回链 ext 按选定流的真实容器显式下发：B 站 DASH 音轨是 ISOBMFF 段
// （pathname 尾 .m4s）或 flac——.m4s 段标记不在编排层 extOf 白名单、
// 链上也不带 mime= 参数，不显式供 ext 全链会错落 mp3 壳（SF-2）。
// 映射表与下载端 download-io MIME_EXT / file-downloader AUDIO_EXTS
// 同口径的最小复刻——值域只许音频工件后缀；B 站侧可产容器：AAC/
// 杜比（eac3 同 mp4 封装）→ m4a、Hi-Res → flac，余为上游漂移兜底
const BILI_AUDIO_EXT = {
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a',
  'audio/eac3': 'm4a', 'audio/ac3': 'm4a', 'audio/ec-3': 'm4a',
  'audio/flac': 'flac', 'audio/x-flac': 'flac',
  'audio/webm': 'webm', 'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
  'audio/aac': 'aac', 'audio/x-aac': 'aac',
  'audio/wav': 'wav', 'audio/x-wav': 'wav',
};
// 音频工件后缀白名单 = 映射表值域（同源不两份）
const AUDIO_EXT_WHITELIST = new Set(Object.values(BILI_AUDIO_EXT));
function extOfStream(s) {
  // 流表 mimeType 优先（上游 DASH 声明的真实容器）；带 ;codecs= 参数剥掉
  const mime = String(s?.mimeType || '').split(';')[0].trim().toLowerCase();
  const byMime = BILI_AUDIO_EXT[mime];
  if (byMime) return byMime;
  // mime 缺席/未收录时看 pathname 尾缀白名单（裸 .flac 链实测存在）——
  // .m4s 段标记不在名单归 null：编排层 extOf 兜底，行为与不供 ext 的旧
  // 路径一致（宁缺不谎报）
  const m = (pathOf(s?.url || '') || '').match(/\.([a-z0-9]{2,5})$/i);
  const ext = m && m[1].toLowerCase();
  return ext && AUDIO_EXT_WHITELIST.has(ext) ? ext : null;
}

// 选档头下标（resolve 逐候选与 resolveById 共用同一判据——两份口径必
// 漂移）：播放档优先首个 audio/mp4 通用容器轨作头——flac/杜比档（登录态
// 才下发）经 audio-proxy 喂 <audio>，Safari 与旧浏览器放不了；下载档
// 保 'best' 首项（无损优先是归档语义）
function pickHeadIdx(cands, purpose) {
  if (purpose !== 'download') {
    const i = cands.findIndex(c => (c?.mimeType || '').startsWith('audio/mp4'));
    if (i >= 0) return i;
  }
  return 0;
}

// 下游可对账判据：候选自带正时长——编排层 durationSec>0 时 estMs 直接
// 取它比对（netease-api.js）。durationSecOf 坏形态归 0/字段缺席的候选
// 胜出后，estMs 只能走 br×size 的 HEAD 估算支路——裸 HEAD 不带 Referer
// 对 upos CDN 必遭防盗链拦截 → 对账墙静默缺位。仲裁池划分与胜出留痕
// 共用这一判据（youtube 侧同型，见 unlock/youtube.js durOk 注）
const durOk = (c) => Number.isFinite(c?.durationSec) && c.durationSec > 0;

// 搜索行归一到共享候选契约 {videoId,title,owner,durationSec,pic}：bvid 作
// 候选 id 进死簿/verdict 键；不做分区白名单过滤——搬运稿常落音乐区外
// （动画/综合），时长筛+AI 核验即错配闸。限 8 条压 AI prompt 与取流试错
// 面（B 站相关性排序前段才是真候选）。resolve 与 search 共用同一归一——
// 两份归一必漂移；pic 一并携带（search 面取它作封面——videoItemToRow
// 归一行已把协议相对形补成 https:），resolve 路径忽略它零害。
// SSR 岛列表会重复下发同 bvid——同 videoId 在一次 resolve 内出现两次
// 会让同一 deadKey 连死两次、直接 n=2 升级 ok=0 verdict（健康候选
// 永久误判）；按 videoId 去重保首见序，同时滤掉无 bvid 脏行（N-7）
function normalizeCands(items) {
  const seenBv = new Set();
  const candidates = [];
  for (const v of (items || []).slice(0, 8)) {
    if (!v?.bvid || seenBv.has(v.bvid)) continue;
    seenBv.add(v.bvid);
    candidates.push({
      videoId: v.bvid, title: v.title, owner: v.author, durationSec: v.durationSec,
      pic: v.pic,
    });
  }
  return candidates;
}

/**
 * @param {{id: any, name: string, artists?: string[], keyword: string,
 *   durationMs: number|null, album?: string|null}} info
 * @returns {{url: string, urls: string[], br: number|null,
 *   durationSec: number|null, ext: string|null, mediaId: string}|null}
 *   ext = 选定流真实容器的音频工件后缀（m4a/flac 等）——编排层优先于
 *   URL 推导消费；推导不出归 null（extOf 兜底，行为同旧路径）
 *   mediaId = 胜出候选 bvid（归一候选 videoId 即 bvid）——编排层透传到
 *   resolved（qq_ 端点 mint cacheKey 用），数值域消费者不读它
 * @throws 搜索段失败抛 transient 标记错；候选取流全灭且含风控证据时抛
 *         transient 标记错——编排层归 transient 走退避重试而非 fatal
 */
async function resolve(info, { signal, purpose } = {}) {
  // 同 youtube 守门：keyword/name 缺一时搜索只会命中无关内容
  if (!info.keyword || !info.name) return null;
  let items;
  try {
    ({ items } = await biliSearchVideos(info.keyword, { signal }));
    // 搜索真空降级（youtube 同款，共享 match.js degradedKeyword——N-11）：
    // 只在 items 零条目时触发——时长筛空/AI 全否是「搜到了但不配」，换词
    // 重搜没有依据。剥歌名尾缀版本修饰重建 name - artists 词重试一次；
    // 剥后与原词相同说明无可剥，省第二跳
    if (!items?.length) {
      const degraded = degradedKeyword(info);
      if (degraded && degraded !== info.keyword) {
        console.info(`[unlock] ${info.id} bilibili: 首搜零条目，剥版本后缀重试「${degraded}」`);
        ({ items } = await biliSearchVideos(degraded, { signal }));
      }
    }
  } catch (e) {
    if (signal?.aborted) throw e;
    throw asTransientErr('B 站搜索失败', e);
  }
  // 搜索行归一/去重/截断走模块级 normalizeCands（与 search 能力同源——
  // 口径注释见该函数头注；pic 在 resolve 路径忽略零害）
  const candidates = normalizeCands(items);
  // ±5s 筛仍是首选；筛空但候选在场时不弃——全候选（上方截断 8 条内）
  // 交 AI 语义仲裁（youtube 同款三层闸：±5s 比编排层 DURATION_TOLERANCE
  // 严一个量级，搬运稿件片头尾超窗却是真命候选；AI 语义判定是错配正主
  // 闸，下游时长对账仍是最终硬墙）
  const { pool: usable, arbitrated } = durationPool(candidates, info.durationMs, c => c.durationSec);
  if (arbitrated) {
    console.info(`[unlock] ${info.id} bilibili: ±5s 时长筛全灭，${usable.length} 候选交 AI 仲裁`);
  }
  if (!usable.length) return null;
  // AI 核验/排序后的候选序：批准记忆与模型选定在前，死候选押尾
  const { ordered: ranked, pickedId } = await aiRankCandidates(info, usable, signal);
  if (!ranked.length) {
    console.info(`[unlock] ${info.id} bilibili: ${usable.length} 候选全部被判定记忆否决`
      + `${arbitrated ? '（±5s 全灭仲裁池）' : ''}`);
    return null;
  }
  // 仲裁池限定——缺时长候选稳定划分押尾（youtube 同型）：不可对账候选
  // （durOk 注）胜出会让下游时长对账静默缺位，故只允许它们在全灭后才
  // 被摸，缺墙暴露面压到最窄。划分保各组内相对序——AI 语义排序
  // （verdict/批准/冷却）已在 aiRankCandidates 内生效不受扰，只是
  // 可对账候选先试错。非仲裁池不动：±5s 命中集自带正时长（筛子判据
  // 即 Number.isFinite），durationMs 缺席时连对账基准都不存在
  const ordered = arbitrated
    ? [...ranked.filter(durOk), ...ranked.filter(c => !durOk(c))]
    : ranked;
  let failed = 0;
  let wallSeen = 0;
  for (const cand of ordered) {
    if (signal?.aborted) throw new Error('aborted');
    try {
      // 单候选 30s 子预算（youtube 同款）：无 cid 时 playurl 链最坏
      // view+playurl+cid 自愈三跳 × 15s——不封顶会让 1 号候选烧穿 60s 整源预算
      const candSignal = AbortSignal.any(
        [AbortSignal.timeout(30000), ...(signal ? [signal] : [])]);
      // 搜索行无 cid——resolveBiliAudio 缺 cid 自查 view 定位，cid 过期
      // 自愈同 routes/bilibili.js 口径，全部复用不重抄
      const cands = await resolveBiliAudio({ bvid: cand.videoId, signal: candSignal });
      if (!cands.length) {
        // 空音轨 = 候选死（稿件下架/会员墙/无 DASH 音轨）——死簿记账
        failed += 1;
        markDead(info, cand);
        continue;
      }
      // 播放档优先通用容器轨、下载档保 'best' 首项——判据与 resolveById
      // 共用模块级 pickHeadIdx（口径注释见该函数头注）
      const headIdx = pickHeadIdx(cands, purpose);
      const urls = mirrorGroup(cands.slice(headIdx));
      // AI 选定候选取流验证成功才落批准 verdict——「批准」承诺的是
      // 「是这首歌且能播」，未经流验证的批准会把死候选永久压队首
      if (pickedId && cand.videoId === pickedId) {
        try {
          upsertVerdict(unlockVkey(info.id, pickedId), 'unlock', 1, cleanField(cand.title));
        } catch { /* verdict 落库失败不阻塞解锁 */ }
      }
      // 胜出候选缺时长 → 下游 estMs 拿不到 → 对账墙缺位——诚实留痕
      // （划分已把缺时长押尾，能走到这意味可对账候选全灭/不在池）
      if (arbitrated && !durOk(cand)) {
        console.info(`[unlock] ${info.id} bilibili: 仲裁选中候选缺时长字段，下游对账缺位`);
      }
      // durationSec 取搜索行的稿件时长——对账口径与候选筛选同源
      // （pickByDuration 用的就是它），playurl 音轨时长与稿件一致
      return {
        url: urls[0],
        urls,
        br: cands[headIdx].br ?? null,
        durationSec: cand.durationSec,
        // 选定档真实容器显式下发——.m4s 链走编排层 extOf 会错落 mp3 壳
        ext: extOfStream(cands[headIdx]),
        // 归一候选 videoId 即 bvid——与死簿/vkey 键域同源，供编排层透传
        mediaId: cand.videoId,
      };
    } catch (e) {
      if (signal?.aborted) throw e;
      failed += 1;
      // 风控证据不进死簿：墙期判死会污染判定记忆（候选没死，是 IP 被拦）。
      // 累计墙证据到阈即整源停打——剩余候选继续跑只是给风控喂信号
      // （youtube authRejected 到阈 break 同口径，见 WALL_EVIDENCE_CAP 注）
      if (isWallErr(e)) {
        wallSeen += 1;
        if (wallSeen >= WALL_EVIDENCE_CAP) break;
        continue;
      }
      markDead(info, cand);
    }
  }
  if (failed) console.info(`[unlock] ${info.id} bilibili: ${failed}/${ordered.length} 候选取流失败`);
  // 风控全灭透出 transient——回 null 会被编排层归 nomatch 丢真因，
  // IP 信誉窗内退避重试本可能恢复（搜索段同口径）
  if (wallSeen > 0) {
    throw new Error(
      `B 站风控拦截取流（${wallSeen}/${ordered.length} 候选——等价 HTTP 429 归 transient）`);
  }
  return null;
}

// ── 可选能力（仅搜索型源实现；pyncmd 是「零错配官方直解」无候选面不加）──
//   async search(keyword, {signal}) → 候选 [{videoId,title,owner,durationSec,cover?,...}]
//     ——手动挑选池；provider 自管归一/去重/截断，不回 resolve 的时长筛/AI 簿
//   async resolveById(mediaId, {signal, purpose}) → {url,urls,br,durationSec?,ext?,mediaId?}|null
//     ——点名直解：跳过搜索/±5s筛/AI仲裁/verdict记忆/死簿，
//       手动绑定唯一信任状是「此刻能否产出可用流」；mediaId 回传入值（bvid）

// 手动挑选池：与 resolve 同一片搜索水域（不做分区过滤——搬运稿常落音乐
// 区外，候选池必须与自动链同水域）；归一/去重/截断共用 normalizeCands，
// cover 取归一行 pic（已补 https:）。搜索段失败包 asTransientErr 与
// resolve 同口径（B 站风控/瞬断归 transient 供编排层退避重试）
async function search(keyword, { signal } = {}) {
  let items;
  try {
    ({ items } = await biliSearchVideos(keyword, { signal }));
  } catch (e) {
    if (signal?.aborted) throw e;
    throw asTransientErr('B 站搜索失败', e);
  }
  return normalizeCands(items).map(v => ({ ...v, cover: v.pic }));
}

// 点名直解：BVID_RE 形闸前置（非法 bvid 不烧上游一跳）→ 30s 子预算
//（与 resolve 内逐候选同口径：无 cid 时 view+playurl+cid 自愈三跳必须
// 封顶）→ playurl 音轨 → headIdx 选档（播放=首个 audio/mp4 轨，下载=
// best 首项）→ mirrorGroup 同字节镜像组 → ext 显式下发（.m4s 链走
// extOf 会错落 mp3 壳）。不写 verdict/死簿——候选语义 info 不在场，
// 死簿只记自动链证据；风控判定照旧抛（路由/编排层分类消费）
async function resolveById(bvid, { signal, purpose } = {}) {
  if (!BVID_RE.test(String(bvid || ''))) return null;
  const candSignal = AbortSignal.any(
    [AbortSignal.timeout(30000), ...(signal ? [signal] : [])]);
  // 搜索行无 cid——resolveBiliAudio 缺 cid 自查 view 定位，cid 过期
  // 自愈同 routes/bilibili.js 口径，全部复用不重抄
  const cands = await resolveBiliAudio({ bvid, signal: candSignal });
  if (!cands.length) return null;
  const headIdx = pickHeadIdx(cands, purpose);
  const urls = mirrorGroup(cands.slice(headIdx));
  return {
    url: urls[0],
    urls,
    br: cands[headIdx].br ?? null,
    durationSec: null,   // 点名解没有候选期时长——编排层对账取绑定行快照
    ext: extOfStream(cands[headIdx]),
    mediaId: bvid,
  };
}

module.exports = { resolve, search, resolveById, aiRankCandidates, forgetSong };

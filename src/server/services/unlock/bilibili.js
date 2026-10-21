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
// degradedKeyword 与 youtube 共用（./match.js）——搜索真空降级词只此一份
const { pickByDuration, degradedKeyword } = require('./match');
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

/**
 * @param {{id: any, name: string, artists?: string[], keyword: string, durationMs: number|null}} info
 * @returns {{url: string, urls: string[], br: number|null,
 *   durationSec: number|null, ext: string|null}|null}
 *   ext = 选定流真实容器的音频工件后缀（m4a/flac 等）——编排层优先于
 *   URL 推导消费；推导不出归 null（extOf 兜底，行为同旧路径）
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
  // 搜索行归一到共享候选契约 {videoId,title,owner,durationSec}：bvid 作
  // 候选 id 进死簿/verdict 键；不做分区白名单过滤——搬运稿常落音乐区外
  // （动画/综合），时长筛+AI 核验即错配闸。限 8 条压 AI prompt 与
  // 取流试错面（B 站相关性排序前段才是真候选）。
  // SSR 岛列表会重复下发同 bvid——同 videoId 在一次 resolve 内出现两次
  // 会让同一 deadKey 连死两次、直接 n=2 升级 ok=0 verdict（健康候选
  // 永久误判）；按 videoId 去重保首见序，同时滤掉无 bvid 脏行（N-7）
  const seenBv = new Set();
  const candidates = [];
  for (const v of (items || []).slice(0, 8)) {
    if (!v?.bvid || seenBv.has(v.bvid)) continue;
    seenBv.add(v.bvid);
    candidates.push({
      videoId: v.bvid, title: v.title, owner: v.author, durationSec: v.durationSec,
    });
  }
  const usable = pickByDuration(candidates, info.durationMs, c => c.durationSec);
  if (!usable.length) return null;
  // AI 核验/排序后的候选序：批准记忆与模型选定在前，死候选押尾
  const { ordered, pickedId } = await aiRankCandidates(info, usable, signal);
  if (!ordered.length) {
    console.info(`[unlock] ${info.id} bilibili: ${usable.length} 候选全部被判定记忆否决`);
    return null;
  }
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
      // 播放档优先通用容器轨：flac/杜比档（登录态才下发）经 audio-proxy
      // 喂 <audio>，Safari 与旧浏览器放不了——首选首个 audio/mp4 项作头；
      // 下载档保 'best' 首项（无损优先是归档语义）
      let headIdx = 0;
      if (purpose !== 'download') {
        const i = cands.findIndex(c => (c?.mimeType || '').startsWith('audio/mp4'));
        if (i >= 0) headIdx = i;
      }
      const urls = mirrorGroup(cands.slice(headIdx));
      // AI 选定候选取流验证成功才落批准 verdict——「批准」承诺的是
      // 「是这首歌且能播」，未经流验证的批准会把死候选永久压队首
      if (pickedId && cand.videoId === pickedId) {
        try {
          upsertVerdict(unlockVkey(info.id, pickedId), 'unlock', 1, cleanField(cand.title));
        } catch { /* verdict 落库失败不阻塞解锁 */ }
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
      };
    } catch (e) {
      if (signal?.aborted) throw e;
      failed += 1;
      // 风控证据不进死簿：墙期判死会污染判定记忆（候选没死，是 IP 被拦）
      if (isWallErr(e)) { wallSeen += 1; continue; }
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

module.exports = { resolve, aiRankCandidates, forgetSong };

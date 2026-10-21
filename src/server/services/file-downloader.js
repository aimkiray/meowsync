const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { spawn, spawnSync } = require('child_process');
const { callNeteaseApi, resolveSongUrls } = require('./netease-api');
// 字节流原语（fetchStream/streamToFile/fatalError 等）在 download-io.js——
// 本文件只做 provider 媒体编排与四类工件下载入口
const {
  MIME_EXT, mergeLrcTrans, fatalError, errnoToFatal, penetratesCandidates,
  throwIfAborted, describeError, fetchStream, removePartial, streamToFile,
  extFromUrl, pathWithExt,
} = require('./download-io');
const qq = require('../lib/qq');
const { resolveBiliAudio, resolveBiliMedia, biliFetch, BILI_PUBLIC_HEADERS } = require('../lib/bilibili');
const { fetchPlayer: ytFetchPlayer, fetchPlayerWith: ytFetchPlayerWith, pickStreamList: ytPickStreamList } = require('../lib/youtube');
const lyricAiRepo = require('../repositories/lyricAi');
const downloadTasksRepo = require('../repositories/downloadTasks');
// 手选词源绑定表：用户在「手动匹配」里点名的词即终审——下载相位与播放链
// （getManualLyric 覆盖层）同口径，绑定在场压过全部自动词源
const lyricManualRepo = require('../repositories/lyricManual');
const { pathPresent, isUnderDownloadDir } = require('./download-fs');
// 封面宿主白名单与 download-manager.deriveCoverUrl 同一闸（CJS require(ESM)）：
// 派生点闸只能管住新落库的 cover_url——存量脏行在 downloadCover 消费点
// 仍要再过一次同款判定
const { isImgProxyHost } = require('../../shared/img-proxy-hosts.js');
const { verifyDownloadOwnership } = require('./lyric-verify');
// 外源滚动词级联（YTM→LRCLIB→酷狗）：bv_/yt_ 未匹配网易云词源 / qq_ 词空
// 回落也空时的兜底——命中走与嫁接词同款的归属核验→译文合并→.part 落盘
const { fetchExternalLyric } = require('./lyric-external');
// 播放流字节缓存复用：/audio-proxy 旁路落盘的完整档（media-cache）直接当
// 已下载工件——命中即不重解不拉流（签名过期/SABR 闸控都无所谓）。
// 缓存是优化路径：任何环节失败静默落空走原下载链
const mediaCache = require('./media-cache');
// 纯文本词自动补轴：包络+LLM/启发式对齐的进程内入口（不走 HTTP——与
// routes/lyric-align 同一条 alignAudioToLrc 编排）
const { alignAudioToLrc } = require('./lyric-align');

// qq_<songmid> / bv_<bvid>[_pN] / yt_<videoId> 曲目的服务端下载分发：
// 各源自有流直取（不经网易云解锁链——别家曲库不是它们的源），
// 回落路径与网易云链同构（fetchStream SSRF 守卫 + streamToFile .part 对账）。
// 流地址宿主与 routes/qq.js 共用 lib/qq.js 的 QQ_STREAM_HOST_OK（sip 可能回
// 裸 IP——后缀判定天然拒绝）
const { QQ_SONG_ID_RE: QQ_ID_RE, BV_TRACK_ID_RE, YT_TRACK_ID_RE, NETEASE_ID_RE } = require('../../shared/predicates.js');
const { mergeLrcText, neteaseLyricBody } = require('../../shared/lrc.js');
const { LYRIC_ALIGN_MAX_LINES, LYRIC_ALIGN_MAX_LINE_CHARS } = require('../../shared/contracts.js');
// RS01/F000=null：FLAC/Hi-Res 是 VBR，无固定码率可算——download-manager 的
// durationLooksTruncated 对 falsy br 短路跳过，完整性由 streamToFile 的
// content-length 对账兜底
const QQ_TIER_BR = { RS01: null, F000: null, M800: 320000, M500: 128000, C400: 96000 };

// 体积上限：明文源站被 302 到无限流/超大文件的威胁模型下，写完再对账已经磁盘写满
const MAX_AUDIO_BYTES = 512 * 1024 * 1024;
const MAX_COVER_BYTES = 32 * 1024 * 1024;
// 解锁源实际回的非 mp3 格式白名单——URL path 后缀不在名单内一律回退 mp3/jpg，
// 防止上游注入怪异扩展名（.php/.html）落盘
const AUDIO_EXTS = new Set(['mp3', 'flac', 'm4a', 'aac', 'ogg', 'wav', 'webm']);
const COVER_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp']);

// 任务码率映射档梯：bitrate 是"目标下限"语义——<320k 的队列请求说明用户只要
// 省流量档，不给拉无损；>=320k（含默认）走完整档梯，归档取最优
const qqLadderFor = (br) => (br && br < 320000 ? ['M500', 'C400'] : qq.BEST_LADDER);

// 外部导入曲（bv_/yt_）下载：从各自网站直取最优音轨——prefer='best' 下
// B 站拿 Hi-Res FLAC/杜比轨（BILI_COOKIE 有权限才下发，否则回落最高码率
// AAC），YouTube 拿 opus251；不经网易云解锁链。候选档降序铺开，单链
// 403/断流换下一档——备份 URL 已在 resolve 侧摊平成同一数组。
// 一轮全灭重解一次：每次 resolve 拿到的签名批绑到同一 CDN 边缘节点，
// 实测 googlevideo 出现过整批 403 换批即愈——单批候选间换档救不了这种故障
// 部分 googlevideo 流拒全量 GET（实测 403）——bytes=0- 语义等同全量，
// 走 206 通道绕开；B 站 CDN 带上也无副作用（其防盗链只认 Referer/UA）
const RANGE_ALL = { Range: 'bytes=0-' };

// 播放缓存档 → 下载工件的搬运：流式管线——GB 级档用 copyFileSync 会把
// 事件循环摁住秒级 stall。先落 .part 再 rename 与 streamToFile 同口径
// （崩溃不留半截最终工件）。.part 写与 streamToFile 同闸 O_NOFOLLOW：
// 预埋的符号链接不能把拷贝引到下载树外——ELOOP 落下方共享 catch；
// copyFile 只收路径表达不了 O_NOFOLLOW，FICLONE 瞬时克隆随之放弃
async function copyCachedFile(src, dest) {
  const partPath = `${dest}.part`;
  try {
    const partFd = fs.openSync(partPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW);
    // fd 是裸数字无 GC——createWriteStream 构造期抛错要手动收
    let writer;
    try {
      writer = fs.createWriteStream(partPath, { fd: partFd, autoClose: true });
    } catch (e) {
      try { fs.closeSync(partFd); } catch { /* already closed */ }
      throw e;
    }
    // pipeline 任一端出错都销毁两侧——writer autoClose 收 fd；src 读不了
    // （缓存档被并发清）也走同路径清 .part
    await pipeline(fs.createReadStream(src), writer);
    fs.renameSync(partPath, dest);
  } catch (e) {
    removePartial(partPath);
    throw e;
  }
}

// bv_ 缓存键的 page 成分必须跟实际内容走：providerData 带显式 cid 时
// 播放/下载的字节由 cid 决定而非 page 序（与 /bilibili/stream mint 侧
// 同口径）——经 view.pages 反解 cid→真实分P；反解不出（cid 过期/上游
// 抖动）用 c<cid> 键段：宁可键不合并，也绝不让 P2 字节命中 p1 键
async function biliCachePagePart(bvM, providerData, signal) {
  const b = providerData?.bilibili || {};
  const bvid = b.bvid || bvM[1];
  const cid = /^\d+$/.test(String(b.cid || '')) ? String(b.cid) : '';
  if (!cid) return `p${+b.page || +bvM[2] || 1}`;
  try {
    const view = await biliFetch(`/x/web-interface/view?bvid=${bvid}`, signal);
    const pages = Array.isArray(view?.pages) ? view.pages : [];
    const idx = pages.findIndex(pg => String(pg?.cid) === cid);
    return idx >= 0 ? `p${idx + 1}` : `c${cid}`;
  } catch {
    return `c${cid}`;
  }
}

// streamingData.formats 里的 progressive mp4 合流档——SABR 闸控视频下
// 唯一可全量拉取的物料（自适应流的 Range 只放首段窗，实测中段/全量
// 一律 403）。按分辨率降序，音视频相位共用同一张兜底表
function pickYtProgressive(sd) {
  return (Array.isArray(sd?.formats) ? sd.formats : [])
    .filter(f => typeof f?.url === 'string' && f.url
      && (f.mimeType || '').startsWith('video/mp4'))
    .sort((a, b) => ((b.height || 0) * (b.width || 0)) - ((a.height || 0) * (a.width || 0)))
    .map(f => ({ url: f.url, mimeType: f.mimeType || '', br: f.bitrate || null, h: f.height || 0 }));
}

async function downloadExternalAudio(bvM, ytM, outputPath, bitrate, onProgress, signal, providerData) {
  // 播过路的完整档直接复用——缓存键前缀与 /bilibili|youtube/stream 的
  // mint 侧同构（bv_<bvid>_p<page>_a_ / yt_<videoId>_a_）：命中即跳过
  // 整段解析+拉流。失败只落空进原链（取消语义照常穿透，errno 确定性病穿透）
  // minBr=目标码率 80%：下载侧 prefer='best' 语义是「能拿多好拿多好」——
  // 播放链缓存的常规 AAC 档低于底线时不该截胡真下载；br 缺失（'x' 指纹）
  // 的档不在复用面（findComplete 内 br<minBr 自然滤掉）
  const audioCachePrefix = (bvM
    ? mediaCache.keyOf('bv', providerData?.bilibili?.bvid || bvM[1],
        await biliCachePagePart(bvM, providerData, signal), 'a')
    : mediaCache.keyOf('yt', providerData?.youtube?.videoId || ytM[1], 'a')) + '_';
  try {
    const hit = mediaCache.findComplete(audioCachePrefix, { minBr: (Number(bitrate) || 0) * 0.8 });
    if (hit) {
      throwIfAborted(signal);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      // 扩展名按 meta.contentType 真实容器判：video/mp4 合流档整段 mp4
      // 即音频工件（与尾部 progressive 相位无 ffmpeg 的兜底同口径——
      // 浏览器按容器嗅探照播）；音频轨走 MIME_EXT→白名单，不在册回 m4a
      const mime = String(hit.meta.contentType || '').split(';')[0].trim().toLowerCase();
      const mimeExt = MIME_EXT[mime];
      const ext = (hit.meta.muxed === true || mime === 'video/mp4')
        ? 'mp4'
        : (mimeExt && AUDIO_EXTS.has(mimeExt) ? mimeExt : 'm4a');
      const finalPath = pathWithExt(outputPath, ext);
      await copyCachedFile(hit.binPath, finalPath);
      onProgress && onProgress(100); // 复用无下载进度段——直报满档
      console.info(`[media-cache] 命中缓存 ${hit.meta.key}（${(hit.meta.size / 1048576).toFixed(1)} MB）`);
      return {
        path: finalPath, size: fs.statSync(finalPath).size,
        // url 下游没人消费——给 'media-cache' 哨兵串而非 null 防万一被
        // 当 URL 解析；fromCache 供调用方/日志辨认复用路径
        url: 'media-cache', br: hit.meta.br ?? null,
        fromCache: true, unblocked: false, unblockedSource: null,
      };
    }
  } catch (e) {
    throwIfAborted(signal);   // 取消语义不被缓存误差吞掉
    errnoToFatal(e);
    if (penetratesCandidates(e)) throw e; // ENOSPC/EROFS 这类病去下载也是死，直接穿透
    console.warn('[media-cache] 音频缓存复用失败，回落下载链:', e?.message || e);
  }
  // B 站 CDN 缺 Referer/UA 直接 403；googlevideo 自带签名不需要附加头
  const headers = bvM ? { ...BILI_PUBLIC_HEADERS, ...RANGE_ALL } : RANGE_ALL;
  // 每轮解析给两类物料：自适应音轨（优先，纯音轨体积小/频带宽）与
  // progressive 合流兜底（仅 yt——B 站侧无闸控形态观测，不徒增复杂度）
  let clientEscalated = false;
  let progressiveCarry = [];
  const resolveCandidates = async () => {
    if (bvM) {
      const b = providerData?.bilibili || {};
      return {
        adaptive: await resolveBiliAudio({
          bvid: b.bvid || bvM[1],
          cid: b.cid,
          page: +b.page || +bvM[2] || 1,
          signal
        }),
        progressive: []
      };
    }
    const videoId = providerData?.youtube?.videoId || ytM[1];
    // 第二轮起升级 VISIONOS 直解：ANDROID/IOS 批被 SABR 闸控（首段窗外全
    // 403）时换签名体系——实测同一批自适应流它完全不受限，能拿到真最高
    // 音质 opus251；首轮解析自身失败时它也顺带当第三客户端兜底
    if (clientEscalated) {
      console.info(`[youtube] ${videoId} 自适应流批次不可用——升级 VISIONOS 签名批重解`);
    }
    const player = clientEscalated
      ? await ytFetchPlayerWith(videoId, signal, 'VISIONOS')
      : await ytFetchPlayer(videoId, signal);
    clientEscalated = true;
    const sd = player.streamingData || {};
    // progressive 跨轮结转：VISIONOS 不一定回 formats——保住上一轮已
    // 验证可拉的合流兜底档，别因换客户端丢掉最后的活路
    const prog = pickYtProgressive(sd);
    if (prog.length) progressiveCarry = prog;
    return {
      adaptive: ytPickStreamList(sd, 'audio', 'best')
        .map(f => ({ url: f.url, mimeType: f.mimeType || '', br: f.bitrate || null })),
      progressive: progressiveCarry
    };
  };
  let lastErr = null;
  for (let round = 0; round < 2; round++) {
    let lists;
    try {
      lists = await resolveCandidates();
    } catch (e) {
      // abort 是最高优先语义——上游库抛的 Error('aborted') 无 aborted 标记，
      // 以 signal 为地面真相，别让取消被吞成可重试失败
      throwIfAborted(signal);
      // resolve 段的非致命上游错（412 风控/瞬断）也吃重解红利；fatal/abort 穿透
      if (e?.fatal || e?.aborted) throw e;
      lastErr = e;
      continue;
    }
    if (!lists.adaptive.length && !lists.progressive.length) {
      throw fatalError(`${bvM ? 'B 站' : 'YouTube'} 无可下载音轨`);
    }
    // mkdir 提到候选循环外：ENOSPC/EACCES 这类确定性 errno 若在 try 内会
    // 因无 fatal 标记而遍历所有候选空转——放外面直接穿透到顶层 errnoToFatal。
    // 先查 abort：resolve 返回与 mkdir 之间的取消窗口不该复活已清扫的目录骨架
    throwIfAborted(signal);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    for (const cand of lists.adaptive) {
      throwIfAborted(signal);
      try {
        const resp = await fetchStream(cand.url, { timeout: 300000, signal, headers });
        if (resp.status !== 200 && resp.status !== 206) {
          resp.data.destroy();
          continue;
        }
        // 扩展名按真实容器判：响应 Content-Type（最诚实）→ 流表 mimeType → URL
        // mime=/path——B 站 flac 轨 url 无后缀，靠 content-type 落 .flac。
        // MIME_EXT 推导结果仍要过音频白名单：image/* 响应会把音频工件落成
        // .png/.jpg（上游错标/投毒），白名单外一律走 URL 推导/默认档
        const mime = (String(resp.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
          || String(cand.mimeType || '').split(';')[0].trim().toLowerCase());
        const mimeExt = MIME_EXT[mime];
        const ext = (mimeExt && AUDIO_EXTS.has(mimeExt))
          ? mimeExt
          : extFromUrl(cand.url, AUDIO_EXTS, 'm4a');
        const finalPath = pathWithExt(outputPath, ext);
        const saved = await streamToFile(resp, finalPath, {
          maxBytes: MAX_AUDIO_BYTES, onProgress, maxTotalMs: 300000
        });
        return {
          path: saved.path, size: saved.size, url: cand.url,
          // br 供时长对账：B 站 bandwidth / YouTube bitrate 都是 bps 真实码率；
          // 均非解锁回链——unblocked 保持 false，source 仅留痕不进徽章语义
          br: cand.br ?? null,
          unblocked: false, unblockedSource: null
        };
      } catch (e) {
        throwIfAborted(signal);   // fetch 的 AbortError DOMException 同样无标记
        if (e?.aborted) throw e;  // 取消语义穿透候选循环
        // 上游 4xx fatal 只判死本条 URL；带 errno 的本地确定性失败才穿透
        if (penetratesCandidates(e)) throw e;
        lastErr = e;
      }
    }
    // 本轮自适应全灭不急着动 progressive——下一轮升级 VISIONOS 可能拿回
    // 不受闸的更高档（闸控视频的 opus251 vs 合流 AAC 差距悬殊）；合流兜底
    // 只在客户端阶梯用尽后出场
  }
  // 自适应全阶梯全灭（极端闸控/仅 progressive 的老视频）→ 合流兜底：
  // ffmpeg 在则 -vn -c:a copy 抽 AAC 轨落 m4a；缺席则合流 mp4 原样作
  // 音频工件——浏览器按容器嗅探照播，代价是文件里多带一路视频轨
  // mkdir 在候选循环外（与自适应段同口径）：全轮死在 resolve 阶段时这里
  // 才首次建目录；确定性 errno 不空转候选，abort 后不复活目录骨架
  if (progressiveCarry.length) {
    throwIfAborted(signal);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  }
  for (const cand of progressiveCarry) {
    throwIfAborted(signal);
    const tmpPath = `${outputPath}.prog.mp4`;
    try {
      const resp = await fetchStream(cand.url, { timeout: 300000, signal, headers });
      if (resp.status !== 200 && resp.status !== 206) {
        resp.data.destroy();
        continue;
      }
      const saved = await streamToFile(resp, tmpPath, {
        // progressive 兜底下的是整段合流 mp4（含视频轨）——5min 闸在慢链
        // 上会硬截断，与视频相位同口径给 MAX_VIDEO_MS
        maxBytes: MAX_VIDEO_BYTES, onProgress, maxTotalMs: MAX_VIDEO_MS
      });
      // progressive 的 f.bitrate 是音画容器总码率——抽出来的纯音轨/或是
      // 留下的 mp4 都不能拿它当音频码率报，给下游对账一个错值不如给 null
      if (!FFMPEG_OK) {
        const finalPath = pathWithExt(outputPath, 'mp4');
        fs.renameSync(saved.path, finalPath);
        return {
          path: finalPath, size: saved.size, url: cand.url,
          br: null, unblocked: false, unblockedSource: null
        };
      }
      const finalPath = pathWithExt(outputPath, 'm4a');
      await ffmpegExtractAudio(saved.path, finalPath, signal);
      return {
        path: finalPath, size: fs.statSync(finalPath).size, url: cand.url,
        br: null, unblocked: false, unblockedSource: null
      };
    } catch (e) {
      throwIfAborted(signal);
      if (e?.aborted || penetratesCandidates(e)) throw e;
      lastErr = e;
    } finally {
      // ffmpeg 抽完/全灭后清掉合流中间件——它不该成为最终工件
      try { fs.unlinkSync(tmpPath); } catch { /* 未产即空/已改名 */ }
    }
  }
  throw lastErr || fatalError('外部源所有候选流均失败');
}

// ── 外部源视频下载（bv_/yt_ 任务的 downloadVideo 工件）──────────────────
// ffmpeg 在：adaptive 最高画质视频轨（avc1 分辨率降序）+ AAC 音轨 -c copy 合流，
//   不重编码即真·源画质；音轨刻意用常规档——opus/flac/杜比塞不进 mp4 容器。
// ffmpeg 缺席：回落源站 MP4 合流档（YouTube formats / B 站 fnval=1 durl），
//   分辨率受合流档限制但产物自包含可播；两者皆无才报失败。
// 8GiB：4K VP9 ~45Mbps 码率下约 25 分钟，1080p 约 2.2h——压真实归档需求
// 之上只挡失控流；2GB 对 4K 是 ~6 分钟的静默降档陷阱（超限fatal无 .code
// 不穿透，候选循环自动吃下一档更低分辨率）
const MAX_VIDEO_BYTES = 8 * 1024 * 1024 * 1024;
// 视频整段总时长闸 30min：2GB 需 ~9Mbps、8GB 需 ~36Mbps 持续带宽——慢链
// 上 5min 闸会把能拉完的高档硬生生降级
const MAX_VIDEO_MS = 30 * 60 * 1000;

const FFMPEG_OK = (() => {
  try {
    const ok = spawnSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' }).status === 0;
    if (!ok) console.warn('[video-dl] 未检测到 ffmpeg——外部源视频下载将回落低清合流档（yt≈360p / bv≤720p），安装 ffmpeg 才能拿到高画质');
    return ok;
  } catch {
    console.warn('[video-dl] 未检测到 ffmpeg——外部源视频下载将回落低清合流档（yt≈360p / bv≤720p），安装 ffmpeg 才能拿到高画质');
    return false;
  }
})();

// -c copy 纯封装不重编码：音乐视频尺度下秒级完成。out 先落 .mux 再 rename——
// ffmpeg 直接写最终路径时崩溃会留半截 .mp4，与 .part 语义同构
function ffmpegMux(videoPath, audioPath, outPath, signal, codec) {
  return new Promise((resolve, reject) => {
    const muxPath = `${outPath}.mux`;
    if (signal?.aborted) {
      // 已 abort 的 signal 挂 listener 永不触发——快拒，别白 spawn 一个
      // 要跑满超时的死进程
      const e = new Error('已取消');
      e.aborted = true;
      return reject(e);
    }
    // hev1（B 站 4K/HDR 档）裸进 mp4 默认 hev1 tag——Apple/QuickTime 系不认，
    // hvc1 tag 才是通用档。dvh1（杜比视界）的合法 tag 就是 dvh1——强转 hvc1
    // 会抹掉 DV 配置盒，只能放行；avc1/vp09/av01 同样裸写即可
    const tagArgs = /^hev/i.test(codec || '') ? ['-tag:v', 'hvc1'] : [];
    const child = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', videoPath, '-i', audioPath,
      // 显式选流：默认流选择对非常规输入（视频文件自带音轨等）可能多选——
      // 钉死 0 号输入首个视频轨 + 1 号输入首个音频轨
      '-map', '0:v:0', '-map', '1:a:0',
      // .mux 中间态后缀 ffmpeg 猜不出封装格式——必须显式 -f mp4
      '-c', 'copy', ...tagArgs, '-f', 'mp4', '-movflags', '+faststart', muxPath
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let errTail = '';
    child.stderr.on('data', d => { errTail = (errTail + d).slice(-500); });
    child.stderr.on('error', () => { /* 管道级错误不入错尾，但必须挂监听防 uncaught */ });
    // ffmpeg 无内建超时——封装正常秒级，挂死会把任务钉死在 downloading
    // 直到队列 abort。等效速率按 25MiB/s 估：faststart 需读入+写 .mux+
    // 二次搬迁共 ~3× 体量的 I/O，50MiB/s 假设在 HDD/SMR/NAS 上会误杀
    // （被杀后换候选重下又被同一超时杀，回到 N 段白下形态）
    const inputBytes = [videoPath, audioPath]
      .reduce((sum, p) => { try { return sum + fs.statSync(p).size; } catch { return sum; } }, 0);
    const muxTimeoutMs = 120000 + Math.ceil(inputBytes / (25 * 1024 * 1024)) * 1000;
    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* 进程已退 */ }
    }, muxTimeoutMs);
    const onAbort = () => { try { child.kill('SIGKILL'); } catch { /* 进程已退 */ } };
    signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
    };
    child.on('error', (e) => {
      cleanup();
      try { fs.unlinkSync(muxPath); } catch { /* 未产即空 */ }
      // spawn 级失败白名单：ENOENT/EACCES/ENOEXEC 是确定性环境病（二进制
      // 缺失/不可执行/格式错）标 fatal 穿透候选循环，否则每段视频下完才
      // 死在 mux、N 档全烧一遍；EAGAIN/ENOMEM/EMFILE/ETXTBSY 是瞬时资源
      // 压力，保持候选级让下一个候选重试
      if (e?.code === 'ENOENT' || e?.code === 'EACCES' || e?.code === 'ENOEXEC') {
        e.fatal = true;
      }
      reject(e);
    });
    child.on('close', (code, killedBy) => {
      cleanup();
      const fail = (err) => {
        // reject 路径清 .mux 半截——别让残片活到下次启动 reap
        try { fs.unlinkSync(muxPath); } catch { /* 未产即空 */ }
        reject(err);
      };
      if (signal?.aborted) {
        // abort 也走 fail——SIGKILL 中途正是最可能留半截 .mux 的路径
        const e = new Error('已取消');
        e.aborted = true;
        return fail(e);
      }
      if (code !== 0) {
        // 三种死法分开报：我方超时杀 / 外部杀（OOM、人工 kill）/ 真崩 exit N
        const why = timedOut ? `超 ${Math.round(muxTimeoutMs / 1000)}s 被 SIGKILL`
          : killedBy ? `被${killedBy}杀（外部信号）` : `exit ${code}`;
        return fail(new Error(`ffmpeg 合流失败（${why}）: ${errTail || '无输出'}`));
      }
      try {
        fs.renameSync(muxPath, outPath);
        resolve(outPath);
      } catch (e) { fail(errnoToFatal(e)); }
    });
  });
}

// progressive mp4 → 抽 AAC 音轨落 m4a（SABR 闸控视频的音频兜底产物）。
// 与 ffmpegMux 同构：.mux 中间态 + 崩溃不留半截最终件 + abort 杀进程
function ffmpegExtractAudio(inPath, outPath, signal) {
  return new Promise((resolve, reject) => {
    const muxPath = `${outPath}.mux`;
    if (signal?.aborted) {
      const e = new Error('已取消');
      e.aborted = true;
      return reject(e);
    }
    const child = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', inPath, '-vn', '-c:a', 'copy',
      // m4a 的规范封装是 ipod muxer（MP4 变体）；.mux 中间态后缀不可推断，显式给
      '-f', 'ipod', muxPath
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let errTail = '';
    child.stderr.on('data', d => { errTail = (errTail + d).slice(-500); });
    child.stderr.on('error', () => { /* 管道级错误不入错尾，但必须挂监听防 uncaught */ });
    // 超时随输入体量伸缩（与 ffmpegMux 同口径 25MiB/s 等效速率——抽轨少
    // 一半写但慢盘余量仍要留）
    let inputBytes = 0;
    try { inputBytes = fs.statSync(inPath).size; } catch { /* 0 按最小超时 */ }
    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* 进程已退 */ }
    }, 120000 + Math.ceil(inputBytes / (25 * 1024 * 1024)) * 1000);
    const onAbort = () => { try { child.kill('SIGKILL'); } catch { /* 进程已退 */ } };
    signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
    };
    child.on('error', (e) => {
      cleanup();
      try { fs.unlinkSync(muxPath); } catch { /* 未产即空 */ }
      // spawn 级失败白名单与 ffmpegMux 同口径——确定性环境病才穿透
      if (e?.code === 'ENOENT' || e?.code === 'EACCES' || e?.code === 'ENOEXEC') {
        e.fatal = true;
      }
      reject(e);
    });
    child.on('close', (code, killedBy) => {
      cleanup();
      const fail = (err) => {
        try { fs.unlinkSync(muxPath); } catch { /* 未产即空 */ }
        reject(err);
      };
      if (signal?.aborted) {
        const e = new Error('已取消');
        e.aborted = true;
        return fail(e);
      }
      if (code !== 0) {
        const why = timedOut ? `超时被 SIGKILL` : killedBy ? `被${killedBy}杀（外部信号）` : `exit ${code}`;
        return fail(new Error(`ffmpeg 抽轨失败（${why}）: ${errTail || '无输出'}`));
      }
      try {
        fs.renameSync(muxPath, outPath);
        resolve(outPath);
      } catch (e) { fail(errnoToFatal(e)); }
    });
  });
}

async function downloadExternalVideo(bvM, ytM, outputPath, onProgress, signal, providerData) {
  const headers = bvM ? { ...BILI_PUBLIC_HEADERS, ...RANGE_ALL } : RANGE_ALL;
  // 播过路的完整视频档两种复用形态：muxed=合流整段 mp4=最终工件零跳产出；
  // video-only 自适应轨=合流管线的视频源（照旧走 ffmpegMux，需 ffmpeg 在
  // 且能解到音轨）。键前缀与 /bilibili|youtube/stream mint 侧同构——
  // bv 侧 page 成分同样跟 cid 反解出的真实分P 走（biliCachePagePart）
  const videoCachePrefix = (bvM
    ? mediaCache.keyOf('bv', providerData?.bilibili?.bvid || bvM[1],
        await biliCachePagePart(bvM, providerData, signal), 'v')
    : mediaCache.keyOf('yt', providerData?.youtube?.videoId || ytM[1], 'v')) + '_';
  let cachedVideoOnly = null;
  try {
    const vHit = mediaCache.findComplete(videoCachePrefix);
    if (vHit && vHit.meta.muxed === true) {
      throwIfAborted(signal);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      await copyCachedFile(vHit.binPath, outputPath);
      const size = fs.statSync(outputPath).size;
      onProgress && onProgress(100);
      console.info(`[media-cache] 命中缓存 ${vHit.meta.key}（${(vHit.meta.size / 1048576).toFixed(1)} MB，合流整段直落）`);
      return {
        path: outputPath, size, url: 'media-cache', fromCache: true,
        videoMeta: {
          h: vHit.meta.h || 0, w: vHit.meta.w || 0,
          codec: vHit.meta.codec || null, br: vHit.meta.br ?? null,
          source: 'media-cache',
        },
      };
    }
    // 裸视频轨只有 ffmpeg 在才成工件——缺席时缓存档帮不上忙，照常走原链
    if (vHit && FFMPEG_OK) cachedVideoOnly = vHit;
  } catch (e) {
    throwIfAborted(signal);
    errnoToFatal(e);
    if (penetratesCandidates(e)) throw e;
    console.warn('[media-cache] 视频缓存复用探测失败，回落下载链:', e?.message || e);
  }
  // 一轮解析给三类物料：自适应视频轨、合流用 AAC 音轨、MP4 合流兜底
  let clientEscalated = false;
  let progressiveCarry = [];
  const resolveMedia = async () => {
    if (bvM) {
      const b = providerData?.bilibili || {};
      return await resolveBiliMedia({
        bvid: b.bvid || bvM[1], cid: b.cid, page: +b.page || +bvM[2] || 1, signal
      });
    }
    const videoId = providerData?.youtube?.videoId || ytM[1];
    // 同音频侧口径：第二轮升级 VISIONOS 签名批，闸控视频换它才拿得到
    // 自适应高画质轨
    if (clientEscalated) {
      console.info(`[youtube] ${videoId} 自适应视频批不可用——升级 VISIONOS 签名批重解`);
    }
    const player = clientEscalated
      ? await ytFetchPlayerWith(videoId, signal, 'VISIONOS')
      : await ytFetchPlayer(videoId, signal);
    clientEscalated = true;
    const sd = player.streamingData || {};
    const prog = pickYtProgressive(sd);
    if (prog.length) progressiveCarry = prog;
    return {
      // adaptiveOnly：合流 formats 混入 videos 会让 ffmpegMux 产出双音轨 mp4
      // ——合流兜底走尾部 progressive 相位，不进自适应候选表
      videos: ytPickStreamList(sd, 'video', 'best', { adaptiveOnly: true })
        .map(f => ({ url: f.url, mimeType: f.mimeType || '', br: f.bitrate || null, h: f.height || 0, w: f.width || 0 })),
      // 合流音轨硬过滤 audio/mp4：opus webm 塞进 mp4 容器 Safari 无声
      audios: ytPickStreamList(sd, 'audio')
        .filter(f => (f.mimeType || '').startsWith('audio/mp4'))
        .map(f => ({ url: f.url, mimeType: f.mimeType || '', br: f.bitrate || null })),
      progressive: async () => progressiveCarry
    };
  };
  const fetchTo = async (cand, dest, base, span) => {
    const resp = await fetchStream(cand.url, { timeout: 300000, signal, headers });
    if (resp.status !== 200 && resp.status !== 206) {
      resp.data.destroy();
      throw new Error(`上游返回 ${resp.status}`);
    }
    return await streamToFile(resp, dest, {
      maxBytes: MAX_VIDEO_BYTES,
      onProgress: onProgress && ((p) => onProgress(base + Math.floor(p * span / 100))),
      maxTotalMs: MAX_VIDEO_MS
    });
  };
  // 候选失败即降档是静默路径——日志留痕让"实际到手档位"可回溯
  const downgradeWarn = (cand, e) =>
    console.warn(`[video-dl] ${cand.h || '?'}p 档下载失败（${e.message}），尝试下一档`);
  // 实际到手档位快照：mimeType 抽编码串，落 video_meta 列供对账/展示
  const codecOf = (mimeType) =>
    (String(mimeType || '').match(/codecs="?([a-zA-Z0-9._-]+)/) || [])[1] || null;
  const metaOf = (cand, source) => ({
    h: cand.h || 0, w: cand.w || 0, codec: cand.codec || codecOf(cand.mimeType),
    br: cand.br || null, source
  });
  let lastErr = null;
  let lastMedia = null;
  // winners 相位已试过的合流 URL——尾部兜底消费同一批时跳过确定性重败
  const triedProgressive = new Set();
  for (let round = 0; round < 2; round++) {
    let media;
    try {
      media = await resolveMedia();
    } catch (e) {
      throwIfAborted(signal);
      if (e?.fatal || e?.aborted) throw e;
      lastErr = e;
      continue;
    }
    lastMedia = media;
    throwIfAborted(signal);
    const videoDir = path.dirname(outputPath);
    fs.mkdirSync(videoDir, { recursive: true });
    // 匿名 B 站 DASH 在低热度稿封顶 480p，而 durl 合流档能给到 720p（qn=80
    // 名义 1080p 目标——账户/稿件压不到 1080 但可能压到 720-1080 区间）——
    // 自适应最优低于 1080p 时多打这一跳比高（更高清就先用合流直落，自带
    // 音轨连 ffmpeg 都省）。videos 空时 bestH=0 必然触发——合流直接接管。
    // yt 合流天花板 360p 只在自适应全灭/低档时才会赢，语义自洽
    const bestH = media.videos[0]?.h || 0;
    if (bestH < 1080) {
      let prog = null;
      try {
        prog = await media.progressive();
      } catch (e) {
        throwIfAborted(signal);
        if (penetratesCandidates(e)) throw e;
        lastErr = lastErr || e;
      }
      // 只消费「真反超」的档——probe 判门看的是最高档，若它失败不能让
      // 低于 bestH 的合流档截胡（那比自适应还差），低档留给尾部兜底
      const winners = (prog || []).filter(c => (c.h || 0) > bestH);
      if (winners.length) {
        console.info(`[video-dl] 合流档 ${winners[0].h}p 反超自适应 ${bestH}p——直落合流`);
        for (const cand of winners) {
          throwIfAborted(signal);
          // 记已试——尾部兜底与下一轮 VISIONOS 的 winners 都消费同一批
          // URL，确定性失败不重复整段下载（单文件可达 GB 级）
          if (triedProgressive.has(cand.url)) continue;
          triedProgressive.add(cand.url);
          try {
            const saved = await fetchTo(cand, outputPath, 0, 100);
            return { path: saved.path, size: saved.size, url: cand.url, videoMeta: metaOf(cand, 'progressive') };
          } catch (e) {
            throwIfAborted(signal);
            if (penetratesCandidates(e)) throw e;
            downgradeWarn(cand, e);
            lastErr = e;
          }
        }
      }
    }
    // 盘上完整视频轨可当合流源——排候选首位（null 槽位是缓存档标记），
    // 命中即省整段视频拉流；缓存档只消费一次（本轮取走即清——mux/坏档
    // 失败由后续候选走真下载自愈，下一轮不该再把它顶回首位连环重试）
    const cachedSrc = cachedVideoOnly;
    cachedVideoOnly = null;
    const videoSources = (FFMPEG_OK && cachedSrc) ? [null, ...media.videos] : media.videos;
    if (FFMPEG_OK && videoSources.length && !media.audios.length) {
      // 音轨表为空时逐候选白下整段视频注定在合流前抛——记语义错误
      // 直接换下一轮/相位（下一轮重解可能拿到带音轨的批）
      lastErr = lastErr || new Error('该视频无可用音轨，无法合流');
    } else if (FFMPEG_OK && videoSources.length) {
      // 音轨跨视频候选复用——换视频档重下音轨是纯浪费
      let audioTmp = null;
      try {
        for (const v of videoSources) {
          throwIfAborted(signal);
          const videoTmp = `${outputPath}.v${videoSources.indexOf(v)}`;
          try {
            // codec 透传：bv 候选自带 codecs 字段，yt 从 mimeType 抽——
            // hev1 源要 hvc1 tag 才是通用 mp4；缓存档 codec 记存在 meta 里
            let vcodec;
            let vMeta;
            if (v === null) {
              await copyCachedFile(cachedSrc.binPath, videoTmp);
              console.info(`[media-cache] 命中缓存 ${cachedSrc.meta.key}（作合流视频轨）`);
              onProgress && onProgress(75);
              vcodec = cachedSrc.meta.codec || codecOf(cachedSrc.meta.contentType);
              vMeta = {
                h: cachedSrc.meta.h || 0, w: cachedSrc.meta.w || 0,
                codec: vcodec || null, br: cachedSrc.meta.br ?? null,
                source: 'media-cache',
              };
            } else {
              await fetchTo(v, videoTmp, 0, 75);
              vcodec = v.codec || codecOf(v.mimeType);
              vMeta = null;
            }
            if (!audioTmp) {
              // 音轨落盘成功才置位——置位先行会让下一个视频候选对着不
              // 存在的 .audio 合流，且整批音轨失去重试机会
              const tmp = `${outputPath}.audio`;
              let audioOk = false;
              for (const a of media.audios) {
                try { await fetchTo(a, tmp, 75, 15); audioOk = true; break; } catch (e) {
                  throwIfAborted(signal);
                  if (penetratesCandidates(e)) throw e;
                  lastErr = e;
                }
              }
              if (!audioOk) {
                try { fs.unlinkSync(tmp); } catch { /* 未产即空 */ }
                throw lastErr || new Error('音轨候选全部失败');
              }
              audioTmp = tmp;
            }
            try {
              await ffmpegMux(videoTmp, audioTmp, outputPath, signal, vcodec);
            } catch (muxErr) {
              // mux 输入之一可能是坏工件（截断音轨/畸形视频轨）——作废
              // audioTmp 让下一候选重走音轨链；否则同一坏音轨把整轮
              // 视频候选全毒化（spawn/环境级 fatal 已在上层穿透）
              if (audioTmp) {
                try { fs.unlinkSync(audioTmp); } catch { /* 已清 */ }
                audioTmp = null;
              }
              throw muxErr;
            }
            onProgress && onProgress(100);
            const size = fs.statSync(outputPath).size;
            return {
              path: outputPath, size,
              url: v === null ? 'media-cache' : v.url,
              videoMeta: v === null ? vMeta : metaOf(v, 'adaptive'),
            };
          } catch (e) {
            throwIfAborted(signal);
            // 上游 4xx 的 fatal 只判死这一条 URL——换候选；带 errno 的本地
            // 确定性失败（ENOSPC/EROFS）才是真穿透，候选级循环不该为它空转
            if (penetratesCandidates(e)) throw e;
            downgradeWarn(v || { h: '缓存档' }, e);
            lastErr = e;
          } finally {
            try { fs.unlinkSync(videoTmp); } catch { /* 未产即空 */ }
          }
        }
      } finally {
        if (audioTmp) { try { fs.unlinkSync(audioTmp); } catch { /* 已清 */ } }
      }
    }
    // 本轮自适应全灭不动 progressive——下一轮 VISIONOS 升级批可能拿回
    // 不受闸的高画质轨；合流兜底只在客户端阶梯用尽后出场。
    // 无 ffmpeg 时自适应相位整体跳过，第二轮重解纯属白打一跳——直连
    if (!FFMPEG_OK) break;
  }
  // 自适应阶梯用尽/无 ffmpeg → MP4 合流兜底（B 站 thunk 懒取 durl；
  // yt 走跨轮结转的 formats 批——VISIONOS 不回 formats 时仍有 ANDROID 的）。
  // thunk 瞬时失败记 lastErr 而非吞成"无合流格式"——412/超时这类错误
  // 是可重试的，不能因为消息撒谎再叠个 fatal 把重试权判死
  const progressive = lastMedia
    ? await lastMedia.progressive().catch(e => {
        throwIfAborted(signal);
        lastErr = e;
        return progressiveCarry;
      })
    : progressiveCarry;
  for (const cand of progressive.length ? progressive : progressiveCarry) {
    throwIfAborted(signal);
    if (triedProgressive.has(cand.url)) continue;
    try {
      const saved = await fetchTo(cand, outputPath, 0, 100);
      return { path: saved.path, size: saved.size, url: cand.url, videoMeta: metaOf(cand, 'progressive') };
    } catch (e) {
      throwIfAborted(signal);
      if (penetratesCandidates(e)) throw e;
      downgradeWarn(cand, e);
      lastErr = e;
    }
  }
  if (!FFMPEG_OK && !progressive.length && !progressiveCarry.length && !lastErr) {
    lastErr = fatalError(
      `${bvM ? 'B 站' : 'YouTube'} 未提供合流格式且未检测到 ffmpeg——安装 ffmpeg 才能下载高画质视频`
    );
  }
  throw lastErr || fatalError('外部源视频流全部候选均失败');
}

// 视频工件分发：只有 bv_/yt_ 有源站视频可取——别的源不该带 download_video 位
async function downloadVideo(songId, outputPath, onProgress, signal, providerData) {
  try {
    const bvM = String(songId).match(BV_TRACK_ID_RE);
    const ytM = !bvM && String(songId).match(YT_TRACK_ID_RE);
    if (!bvM && !ytM) {
      throw fatalError('该来源不支持视频下载');
    }
    return await downloadExternalVideo(bvM, ytM, outputPath, onProgress, signal, providerData);
  } catch (error) {
    errnoToFatal(error);
    const err = new Error(`下载视频失败: ${describeError(error)}`);
    err.code = error.code;
    err.aborted = Boolean(error.aborted) || error.code === 'ERR_CANCELED' || signal?.aborted;
    err.fatal = Boolean(error.fatal);
    throw err;
  }
}

// 数字 id（网易云）取流管线：song_url → resolveSongUrls 共享解锁 →
// fetchStream → streamToFile .part 对账。qq_ 腿断时的 neteaseId 词源回链
// 复用同一函数——不复制两遍
async function downloadNeteaseAudio(neteaseId, outputPath, bitrate, onProgress, signal) {
  // 进程内直调上游模块 + 共享解锁后处理（purpose=download：不走 audio-proxy），
  // 不经过 HTTP 自调——避免依赖服务端口配置，也省去一圈 loopback 开销
  let result;
  try {
    result = await callNeteaseApi('song_url', { id: neteaseId, br: bitrate });
  } catch (error) {
    // 上游 song_url 模块对不存在的 songId 会拿到 body.data=undefined 再 .sort() 抛
    // TypeError——这是确定性错误（每次必崩），标 fatal 跳过重试；网络类错误照常重试
    if (error instanceof TypeError) {
      throw fatalError('无法获取歌曲信息');
    }
    throw error;
  }
  const items = result?.body?.data;
  if (!Array.isArray(items) || items.length === 0) {
    throw fatalError('无法获取歌曲信息');
  }
  // signal 透传进解锁链：任务取消/排空时逐源中止——否则已 abort 的任务
  // 仍要把整条解锁链（song_detail + 2 源试错 + HEAD 探测，最坏分钟级）
  // 跑完才在下方 throwIfAborted 被发现
  await resolveSongUrls(items, { purpose: 'download', signal });

  // items[0] 可能解锁失败但后续条目有 url——选第一个可用的，而不是永远盯着第一个
  const songData = items.find(i => i.url && !i.unlockFailed) || items[0];
  if (songData.unlockFailed) {
    // 逐源归因进错误消息（L1）：flatMap 收全 items——单曲下载即该曲全部
    // 源记录；breaker 条目是「该源本次没跑」的证据而非 transient
    const errs = items.flatMap(i => Array.isArray(i.unlockErrors) ? i.unlockErrors : []);
    const detail = errs.map(e => `${e.source}: ${e.msg}`).join('；');
    const msg = `解锁失败，逐源均无匹配（${detail || '无逐源记录'}）`;
    // L4：任一源瞬时失败 → 普通 Error 走 retryAfter 退避（≤3 次自动重试）；
    // 全 nomatch/authwall/breaker 是窗口内确定性结果——维持 fatal 不白打
    if (errs.some(e => e.cls === 'transient')) throw new Error(msg);
    throw fatalError(msg);
  }
  if (songData.freeTrialInfo) {
    throw fatalError('仅获取到试听片段，可能受版权限制');
  }
  if (!songData.url) {
    throw fatalError('无法获取歌曲链接');
  }

  throwIfAborted(signal);
  // 扩展名按真实来源修正（youtube→m4a 等）：路径互斥锁仍挂在占位 .mp3 键上，
  // 互斥语义不变（同一歌单同曲永远同键），只是落盘文件名更诚实
  const finalPath = pathWithExt(outputPath, extFromUrl(songData.url, AUDIO_EXTS, 'mp3'));
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });

  // googlevideo 签名 URL 按请求形态记账：裸 GET 既可能 403 又会毒化该
  // URL 的后续 Range 请求——解锁链产出 googlevideo（youtube provider）
  // 时与下行直链同口径带 bytes=0-（语义同全量，其他 CDN 无副作用）
  const audioResponse = await fetchStream(songData.url, { timeout: 300000, signal, headers: RANGE_ALL });
  if (audioResponse.status !== 200 && audioResponse.status !== 206) {
    audioResponse.data.destroy();
    throw fatalError(`上游返回 ${audioResponse.status}`);
  }

  const saved = await streamToFile(audioResponse, finalPath, {
    maxBytes: MAX_AUDIO_BYTES,
    onProgress,
    maxTotalMs: 300000 // 总时长与头超时对齐 5min
  });
  return {
    path: saved.path,
    size: saved.size,
    url: songData.url,
    // 落盘后时长对账需要**文件真实码率**：解锁源的 item.br 仍是网易声明值
    // （请求 320k 时恒 320000），真实码率在 unblockedBr（youtube 常 130k）——
    // 用错分母会把完整文件误判成剪辑。unblockedBr 为 null（progressive 合流
    // 兜底链——容器总码率不可当音轨码率）时保持 null 跳过对账，别拿声明值
    // 复活成假分母（闸控链码率与声明值差 2-3 倍，截断闸会名存实亡）
    br: songData.unblocked
      ? (songData.unblockedBr ?? null)
      : (songData.br ?? null),
    unblocked: songData.unblocked || false,
    unblockedSource: songData.unblockedSource || null
  };
}

// providerData：任务行快照的源私有字段（{qq:{mediaMid}}/{bilibili:{bvid,cid,page}}/
// {youtube:{videoId}}/neteaseId）——mediaMid 是 vkey filename 键，带了可省一次
// 注定失败的 vkey 空调用 + detail 回填往返；neteaseId 是导入期词源匹配产物，
// qq_ 腿断时充回链键。缺省/过期都安全，各解析器内部仍兜底
async function downloadAudio(songId, outputPath, bitrate = 320000, onProgress, signal, providerData) {
  try {
    // bv_<bvid>[_pN] / yt_<videoId> 分发：自有站直链
    const bvM = String(songId).match(BV_TRACK_ID_RE);
    const ytM = !bvM && String(songId).match(YT_TRACK_ID_RE);
    if (bvM || ytM) {
      return await downloadExternalAudio(bvM, ytM, outputPath, bitrate, onProgress, signal, providerData);
    }
    // qq_<songmid> 分发：QQ 源直链（BEST 档梯）→ 同一条 fetchStream 守卫管线。
    // QQ 已关闭匿名取流——pickStreamUrl 回 null（code=0 但全档 purl 空）或抛
    // qqAnonDenied（凭据级拒答打标）时，providerData.neteaseId 是匿名可播的
    // 唯一腿：走与数字 id 支同一条网易云管线回链（providerData 只读不改）
    const qqM = String(songId).match(QQ_ID_RE);
    if (qqM) {
      let hit = null;
      let qqErr = null;
      try {
        hit = await qq.pickStreamUrl(qqM[1], {
          mediaMid: providerData?.qq?.mediaMid || '',
          ladder: qqLadderFor(bitrate),
          signal
        });
      } catch (e) {
        // 非匿名拒答形态（瞬断/风控/abort）不进回链判定——照旧穿透
        if (!e?.qqAnonDenied) throw e;
        qqErr = e;
      }
      // 回链把「词源匹配」的 matched.id 当音频源——产品取舍在案：
      // LYRIC_MATCH_CRITERIA 验收的是词同作品（翻唱/live 词同录音不同也收），
      // 回链下载会把错录音固化成本地工件。匹配器的验收闸（matchScore）是
      // 当前唯一可信判据；播放链（usePlayer 的 neteaseId 回落支）同暴露面，
      // 下载只是把它固化。matchScore 已随 provider 块持久化留证，后续要
      // 收紧回链闸（分数阈值/时长核验）有现成判据可取
      const relayId = String(providerData?.neteaseId ?? '');
      // relayErr 挂外侧：两腿全灭时终错要拼上回链死因，不再只留 console.warn
      let relayErr = null;
      if (!hit && NETEASE_ID_RE.test(relayId)) {
        try {
          const relayed = await downloadNeteaseAudio(relayId, outputPath, bitrate, onProgress, signal);
          console.info(`[download] qq_${qqM[1]} 直链不可达——词源回链 netease ${relayId} 成功`);
          // 回链产物照数字支语义如实报 unblocked/br；unblockedSource 缺席时
          // 烙 qq→netease——它本质就是解锁回链，血缘不进徽章语义也不丢
          return { ...relayed, unblockedSource: relayed.unblockedSource || 'qq→netease' };
        } catch (e) {
          throwIfAborted(signal);
          errnoToFatal(e);
          // 本地确定性病（ENOSPC 等）换源也救不了——穿透判死而非报 qq 错
          if (penetratesCandidates(e)) throw e;
          console.warn(`[download] qq_${qqM[1]} 网易回链(${relayId})失败: ${describeError(e)}`);
          relayErr = e;
        }
      }
      // neteaseId 缺席/两条腿全灭——原始 qq 错为主因重抛（含 qqAnonDenied
      // 标记若适用）不吞因；回链已尝试的死因拼上终错消息不再只留日志。
      // 不原地改 message：pickStreamInflight 单飞的共享错会被并发等待方
      // 重复拼接
      if (qqErr) {
        if (!relayErr) throw qqErr;
        const combined = new Error(`${qqErr.message}（netease=${describeError(relayErr)}）`);
        if (qqErr.qqAnonDenied) combined.qqAnonDenied = true;
        throw combined;
      }
      if (!hit) {
        // 文案分档：无登录态下「无流」的真因几乎恒为匿名取流关停——可执行
        // 指引与 /qq/stream 404 同口径；配了 cookie 才轮到 VIP/地域解释
        const base = qq.hasQqCookie()
          ? 'QQ 音乐无可用音源（可能需要 VIP 权限或地域限制）'
          : 'QQ 音乐无可用音源——QQ 已关闭匿名取流，请在设置页配置 QQ Cookie';
        const msg = relayErr ? `${base}（netease=${describeError(relayErr)}）` : base;
        // fatal 分档：neteaseId 缺席（根本没进回链）是确定性失败维持
        // fatal；回链瞬时死（relayErr 非 fatal）不带 fatal 走 ≤3 重试——
        // 与 qqErr 重抛同权，同一瞬时网易故障不该因 qq 腿死法
        // （null vs throw）丢重试权
        if (relayErr && !relayErr.fatal) throw new Error(msg);
        throw fatalError(msg);
      }
      throwIfAborted(signal);
      const finalPath = pathWithExt(outputPath, qq.QUALITY_TIERS[hit.tier]?.ext || 'm4a');
      fs.mkdirSync(path.dirname(finalPath), { recursive: true });
      const resp = await fetchStream(hit.url, { timeout: 300000, signal });
      if (resp.status !== 200 && resp.status !== 206) {
        resp.data.destroy();
        throw fatalError(`上游返回 ${resp.status}`);
      }
      const saved = await streamToFile(resp, finalPath, {
        maxBytes: MAX_AUDIO_BYTES, onProgress, maxTotalMs: 300000
      });
      return {
        path: saved.path, size: saved.size, url: hit.url,
        br: QQ_TIER_BR[hit.tier] ?? null,
        unblocked: false, unblockedSource: `qq/${hit.tier}`
      };
    }
    return await downloadNeteaseAudio(String(songId), outputPath, bitrate, onProgress, signal);
  } catch (error) {
    errnoToFatal(error);
    const err = new Error(`下载音频失败: ${describeError(error)}`);
    err.code = error.code;
    // aborted/fatal 标记对称透传：processTask 靠它们区分取消/可重试/确定性失败
    // signal?.aborted 兜底与 downloadVideo 同口径——上游抛的裸 Error
    // （如 DOMException AbortError）无 aborted 标记，以 signal 为地面真相
    err.aborted = Boolean(error.aborted) || error.code === 'ERR_CANCELED' || signal?.aborted;
    err.fatal = Boolean(error.fatal);
    // 业务标记同口径透传——qqAnonDenied 供上层区分「匿名取流关停」终态
    if (error?.qqAnonDenied) err.qqAnonDenied = true;
    throw err;
  }
}

// 多层行合并（罗马音/译文双层落盘）：实现收敛在共享层 mergeLrcText——
// 每层独立对齐面、逐原词行后按入参序贴齐；同文跳过与播放面
// mergeTranslations 同口径（AI 译文缓存的原文占位行不落盘成双），
// 且同用 0.5s 最近邻窗（旧实现整毫秒键严格相等会静默丢译文）
const mergeLrcLayers = (lrc, ...layers) => mergeLrcText(lrc, ...layers);

// 网易 lyric 回包的词文提取（qq 合成包同构适用）：nolyric/uncollected
// 旗标与纯占位词（'纯音乐，请欣赏' 式整词占位）归一成空——归一口径
// 收敛在共享层 neteaseLyricBody；空词让外源级联兜底照常接管，占位串
// 不落盘也不判「已取词」
const neteaseLyricOf = (body) => neteaseLyricBody(body).lrc;

// 外源词兜底相位的本曲上下文：按 songId 跨歌单扫任务行（与 routes/
// lyric-align 的 resolveDownloadedAudio 同款寻址，但不卡 completed——
// 本任务的音频相位刚写完 audio_path 时行还在 downloading）。
// 产出 {audioPath, durationSec}：audioPath 供纯文本词自动补轴与外源
// 时长筛的实测探测输入、durationSec 是任务行元数据时长（只对曲库 id
// 可信——bv_/yt_ 行该值是视频时长，调用方须改用 probeMediaDurationSec
// 探盘档或干脆不传）；行查不到/盘无档/DB 抖动都归一成空值，调用方各自
// 降级（不补轴/不做时长过滤），不炸歌词相位
function extSongContext(songId) {
  try {
    const rows = downloadTasksRepo.listTasksBySongId(songId);
    const audioPath = rows
      .map(t => t.audioPath)
      .find(p => p && isUnderDownloadDir(p) && pathPresent(p)) || null;
    const durationMs = rows.map(t => t.durationMs).find(d => d > 0) || 0;
    return { audioPath, durationSec: durationMs ? durationMs / 1000 : undefined };
  } catch {
    return { audioPath: null, durationSec: undefined };
  }
}

// 探盘档真实时长（秒）：bv_/yt_ 任务行的 durationMs 是视频元数据时长
// （含片头/口播，与落盘音频漂移可 >15s）——喂给 LRCLIB/酷狗的 ±15s 硬筛
// 会把正确词滤掉。歌词相位跑时音频工件常已落盘，直接探盘档取真实时长。
// ffprobe 优先（输出干净）；它未必与 ffmpeg 同在 PATH——缺席/失败退
// ffmpeg -i 的 stderr Duration 行。都探不出归 undefined：调用方不传
// durationSec（外源层 !durationSec || diff<=15 语义下 diff 变 null 只进
// 排序，豁免硬闸）。spawn 全程异步——探针卡死不该把事件循环摁住
async function probeMediaDurationSec(mediaPath, signal) {
  const num = (v) => (Number.isFinite(v) && v > 0 ? v : undefined);
  const probe = (cmd, args, pick, okOnly) => new Promise((resolve) => {
    if (signal?.aborted) return resolve(undefined);
    let child;
    try { child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { return resolve(undefined); } // 同步 spawn 失败（ENOENT 等）
    let out = '';
    let errTail = '';
    child.stdout.on('data', d => { out = (out + d).slice(-2000); });
    child.stderr.on('data', d => { errTail = (errTail + d).slice(-4000); });
    child.stdout.on('error', () => { /* 管道级错误必须有监听 */ });
    child.stderr.on('error', () => { /* 同上 */ });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 进程已退 */ }
    }, 15000);
    const onAbort = () => { try { child.kill('SIGKILL'); } catch { /* 进程已退 */ } };
    signal?.addEventListener('abort', onAbort, { once: true });
    const done = (v) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(v);
    };
    child.on('error', () => done(undefined));
    // okOnly：ffprobe 只认干净退出；ffmpeg -i 无输出文件恒非零退出，
    // Duration 在 stderr 照解（pick 自行判能否解析）
    child.on('close', (code) => done(okOnly && code !== 0 ? undefined : pick(out, errTail)));
  });
  const sec = await probe('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', mediaPath,
  ], (out) => num(parseFloat(out)), true);
  if (sec !== undefined) return sec;
  return probe('ffmpeg', ['-hide_banner', '-i', mediaPath], (o, err) => {
    const m = String(err).match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    return m ? num(+m[1] * 3600 + +m[2] * 60 + +m[3]) : undefined;
  }, false);
}

// 纯文本词 → 进程内 lyric-align 补轴。预算闸 90s：对齐挂在下载相位里，
// ffmpeg 解码+LLM 任何一段拖死都不能把任务钉住——超时/失败回 null，
// 调用方照旧落纯文本（有词好过没词）。任务级取消（外层 signal）穿透不降级
const PLAIN_ALIGN_BUDGET_MS = 90000;
async function alignPlainLrc(audioPath, plainText, signal) {
  // 与路由口径齐（lyricAlignBody 同一份上限常量）：单行超字截断、
  // 行数超限截断——外源纯文本是 UGC 不可信输入，不截会烧穿对齐预算
  const lines = String(plainText || '').split('\n')
    .map(l => l.trim().slice(0, LYRIC_ALIGN_MAX_LINE_CHARS)).filter(Boolean)
    .slice(0, LYRIC_ALIGN_MAX_LINES);
  if (!lines.length) return null;
  const alignSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(PLAIN_ALIGN_BUDGET_MS)])
    : AbortSignal.timeout(PLAIN_ALIGN_BUDGET_MS);
  try {
    const r = await alignAudioToLrc({ audioPath, lines, signal: alignSignal });
    const lrc = String(r?.lrc || '').trim();
    if (!lrc) return null;
    console.info(`[download] 纯文本词自动对齐完成（${r.alignedBy}，${lines.length} 行）`);
    return { lrc: r.lrc, alignedBy: r.alignedBy };
  } catch (e) {
    // 外层取消穿透——只对齐预算超时/ffmpeg 失败才吞成降级
    throwIfAborted(signal);
    console.warn(`[download] 纯文本词自动对齐失败，落纯文本：${describeError(e)}`);
    return null;
  }
}

async function downloadLyrics(songId, outputPath, signal, providerData) {
  try {
    // 上游 lyric 模块是进程内调用，请求级 abort 传不进去——在调用前后各查一次
    // signal，取消语义不丢（请求本身时长很短，段间检查足够）
    if (signal?.aborted) {
      const err = new Error('已取消');
      err.aborted = true;
      throw err;
    }
    // bv_/yt_ 导入曲的词源是导入时匹配到的网易云 id（providerData.neteaseId）——
    // 无匹配词源时先走外部词源级联（YTM→LRCLIB→酷狗），全灭才判 NO_LYRICS
    // 「缺词不算失败」，别让外部曲死等歌词段
    const extM = String(songId).match(BV_TRACK_ID_RE) || String(songId).match(YT_TRACK_ID_RE);
    // qq_ 轨道 id（自家词空且网易云回落也空时同样吃外源兜底）
    const qqM0 = !extM && String(songId).match(QQ_ID_RE);
    // .part 对账落盘与既有路径同构——外源词命中也走同一写出原语
    const writeLrcFile = (lyricText) => {
      throwIfAborted(signal);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      const partPath = `${outputPath}.part`;
      try {
        // .part 写与 streamToFile 同闸 O_NOFOLLOW：预埋符号链接不能把词文
        // 引到下载树外——ELOOP 落共享 catch 走 errnoToFatal（在 FATAL_ERRNOS 册）
        const fd = fs.openSync(partPath,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW);
        try {
          fs.writeFileSync(fd, lyricText, 'utf-8');
        } finally {
          fs.closeSync(fd); // fd 是裸数字无 GC——写成败两路都必须收
        }
        fs.renameSync(partPath, outputPath);
      } catch (writeError) {
        removePartial(partPath); // 写一半失败不留孤儿 .lrc.part
        throw writeError;
      }
      return { path: outputPath, size: Buffer.byteLength(lyricText, 'utf-8') };
    };
    // 级联命中/手选绑定 → 落盘公共尾段（两者同构 {lrc, plain, source,
    // extId, synced}）：归属核验 → 纯文本补轴 → 词源元行烙记 → AI 译文
    // 合并 → .part 对账写。skipVerify 只给手选绑定用——用户显式点名的
    // 词是终审（播放链 getManualLyric 直贴无核验同口径）：核验面可能
    // 正压着当年错判该词源的 verdict/署名闸记录，复核会把「终审」挡回
    // 门外——手选功能恰为修这种错判而生，不能自噬
    const writeExtHit = async (hit, ctx, { skipVerify = false } = {}) => {
      // hit.plain 是「同条目附赠的纯文本形态」——synced 缺席时源内已把
      // plain 填进 lrc 槽，这里的 plain 分支不可达，只取 lrc
      let text = String(hit?.lrc || '');
      if (!hit || !text.trim()) return null;
      // 与嫁接词同款归属核验——词源键挂源内 extId（ytm_/lrclib_/kugou_
      // 前缀，与网易云 id 空间隔离）；qq_ 走 grafted 支路取顶层签名。
      // candidate 携级联命中条目的候选身份（hit.meta，{title,artist,album}
      // 与核验侧同口径）——署名闸据此对 extId 词源可达（extId 无网易条目
      // 可反查）；ytm 支路/缓存反查/手选绑定无 meta 的形态不传走原路径
      if (!skipVerify) {
        const ownership = await verifyDownloadOwnership({
          songId, lyricId: hit.extId, providerData,
          grafted: !extM, lrc: text, signal,
          ...(hit.meta ? { candidate: hit.meta } : {}),
        });
        if (ownership === false) {
          console.info(`[download] ${songId} 外源歌词（${hit.source}）归属核验不符，跳过落盘`);
          return null;
        }
      }
      // 纯文本词（无时间戳）且盘上已有本曲音频工件 → 进程内自动对齐补轴；
      // 音频没下完/对齐失败都照旧落纯文本——有词好过没词
      let alignedBy = null;
      if (!hit.synced && ctx.audioPath) {
        const aligned = await alignPlainLrc(ctx.audioPath, text, signal);
        if (aligned) { text = aligned.lrc; alignedBy = aligned.alignedBy; }
      }
      // 外源产物落盘留痕：补轴词/外源同步词与官方词同形无法区分词源——
      // 首部插 LRC 元行（[re:]=制作工具、[ve:]=版本，标准 id 标签位）把
      // extId/补轴方式烙进工件。parseLrcLines/mergeLrcTrans/前端
      // parseLyrics 只认时间戳行——元行各层透传无副作用
      text = `[re:MeowSync ${hit.extId}]`
        + `${alignedBy ? `\n[ve:align-${alignedBy}]` : ''}\n${text}`;
      // AI 译文缓存键同样挂 extId——ai.js 词源白名单扩展后下载链零改动受益
      const extTrans = lyricAiRepo.getCachedTranslation(hit.extId)?.tlyric || '';
      const written = writeLrcFile(mergeLrcTrans(text, extTrans));
      // 补轴产物的质量档透出给调用方/日志（alignedBy='llm'|'heuristic'）
      if (alignedBy) written.alignedBy = alignedBy;
      return written;
    };
    // 外源词兜底相位：源签名 bv_/yt_ 取 providerData.<provider> 嵌套块、
    // qq_ 取顶层 title/author（与 download-fs providerDataOf 投影同口径）；
    // 老镜像行字段缺省按空串降级——LRCLIB/酷狗无检索词自然全灭回 null，
    // yt_ 只靠 songId 抽出的 videoId 也仍能走 YTM 支路
    const externalLyricHit = async () => {
      const pd = providerData || {};
      const src = pd.bilibili || pd.youtube || null;
      // 本曲任务行上下文：audioPath 供纯文本词补轴与外源时长筛的实测
      // 探测；时长入参分源——bv_/yt_ 行 durationMs 是视频时长（与音频漂移
      // 可 >15s，喂 ±15s 硬筛会误杀正确词）：盘档在就探真实时长，无盘档/
      // 探不出则不传（diff 变 null 只进排序豁免硬闸）。qq_/数字行的
      // durationMs 是曲库元数据，可信照旧传
      const ctx = extSongContext(songId);
      const durationSec = extM
        ? (ctx.audioPath ? await probeMediaDurationSec(ctx.audioPath, signal) : undefined)
        : ctx.durationSec;
      const hit = await fetchExternalLyric({
        songId,
        title: String(src?.title || pd.title || ''),
        artist: String(src?.author || pd.author || ''),
        videoId: String(pd.youtube?.videoId || ''),
        durationSec,
        signal,
      });
      return writeExtHit(hit, ctx);
    };
    // 手选绑定终审（用户点名的词压过网易/QQ/外源级联全部自动词源——与
    // 播放链 getManualLyric 覆盖层同口径）：song_lyric_manual 有行即当
    // 级联命中走同一落盘尾段，外源级联与归属核验整链跳过。键域与路由
    // 同源（数字/file_/qq_/bv_/yt_/ext 词源 id）。行词文为空（畸形行）
    // 归 null 落回自动链——手动层是覆盖层，永不许锁死词载主链
    let manual = null;
    try { manual = lyricManualRepo.getManual(songId); } catch { /* DB 抖动归无绑定 */ }
    if (manual) {
      const written = await writeExtHit(manual, extSongContext(songId), { skipVerify: true });
      if (written) return written;
    }
    if (extM && !NETEASE_ID_RE.test(String(providerData?.neteaseId ?? ''))) {
      const ext = await externalLyricHit();
      if (ext) return ext;
      const err = new Error('歌词不存在');
      err.code = 'NO_LYRICS';
      throw err;
    }
    let lyricId = extM ? String(providerData.neteaseId) : songId;
    const qqLm = String(lyricId).match(QQ_ID_RE);
    // qq 侧：无词曲（空 lyric 或上游业务码 -1901/-1301 等）映射成 NO_LYRICS——
    // 与网易云链同口径判「缺词不算失败」，否则音画已下完的任务会因歌词段重试
    // 耗尽被标 failed；传输层错误（无 bizCode 标记）照旧抛走重试
    let qqDefinitiveEmpty = false;
    let response = qqLm
      ? await qq.getLyric(qqLm[1], signal)
        .then(r => ({ body: { code: 200, lrc: { lyric: r.lyric || '' }, trans: r.trans || '' } }))
        .catch(e => {
          if (e && e.bizCode !== undefined) { qqDefinitiveEmpty = true; return null; }
          throw e;
        })
      : await callNeteaseApi('lyric', { id: lyricId }, { signal });
    // qq 词源缺词时回落已匹配的网易云词源（与播放链同口径）——嫁接词过
    // 下方同一个归属核验（来源即 QQ 曲自身的名/艺人快照）
    let qqGrafted = false;
    if (qqLm && !neteaseLyricOf(response?.body)
        && NETEASE_ID_RE.test(String(providerData?.neteaseId ?? ''))) {
      const fb = await callNeteaseApi('lyric', { id: String(providerData.neteaseId) }, { signal })
        .catch(() => null);
      if (fb?.body?.code === 200 && neteaseLyricOf(fb.body)) {
        response = fb;
        lyricId = String(providerData.neteaseId);
        qqGrafted = true;
      }
    }
    if (qqDefinitiveEmpty && !neteaseLyricOf(response?.body)) {
      // qq 自家词确定性缺 + 回落也空——外源级联再接一手才判缺词
      const ext = await externalLyricHit();
      if (ext) return ext;
      const err = new Error('歌词不存在');
      err.code = 'NO_LYRICS';
      throw err;
    }
    if (signal?.aborted) {
      const err = new Error('已取消');
      err.aborted = true;
      throw err;
    }

    if (!response || !response.body || response.body.code !== 200) {
      throw new Error('无法获取歌词');
    }

    // 词文提取走 neteaseLyricOf：nolyric/uncollected 旗标与纯占位词
    // 一律归缺词；非字符串 lyric 是上游畸形数据，与缺词同待遇
    // （确定性，不该重试——code 契约而非消息串匹配，下游按 NO_LYRICS
    // 判定"缺词不算失败"）
    const lrcText = neteaseLyricOf(response.body);
    if (!lrcText) {
      // 外源曲（qq_ 词空非 bizCode 形态 / bv_·yt_ 有匹配但网易词空）先吃
      // 外源级联一手，仍空才定缺词
      if (extM || qqM0) {
        const ext = await externalLyricHit();
        if (ext) return ext;
      }
      const err = new Error('歌词不存在');
      err.code = 'NO_LYRICS';
      throw err;
    }

    // 错词不落盘：嫁接词源（bv_/yt_ 经匹配、qq 缺词回落网易云）可能是错配——
    // 与播放链同 verdict 签名核验归属，决策收敛在 lyric-verify：
    // 已落库判定不随 aiEnabled 旁路；AI 关只影响新判定的来源
    if (extM || qqGrafted) {
      const ownership = await verifyDownloadOwnership({
        songId, lyricId, providerData, grafted: qqGrafted, lrc: lrcText, signal
      });
      if (ownership === false) {
        console.info(`[download] ${songId} 歌词归属核验不符，跳过落盘`);
        // 「核验判否=错配」恰是外源兜底要兜的入口——级联先接一手，命中即
        // 用（级联内 verifyHit 走同一 vkey 体系会再挡错源）；全灭才判缺词
        const ext = await externalLyricHit();
        if (ext) return ext;
        const err = new Error('歌词与来源不匹配');
        err.code = 'NO_LYRICS';
        throw err;
      }
    }

    // 官方译文按同刻时间戳插到原文行后落盘（标准合并 LRC 格式——播放器
    // 同刻双行显示原文+译文；网易 tlyric 与 QQ trans 同口径处理，qq 嫁接
    // 网易云的回落响应也是 tlyric 形态）；无官方译文时吃 AI/历史译文缓存。
    // romalrc（eapi lyric 端点 rv:-1 回包，此前未消费）作为独立层一同落盘
    // ——日语歌罗马音滚动词；与译文层顺序合成 o→roma→trans 三层同刻块
    const trans = (response.body.tlyric?.lyric || response.body.trans)
      || lyricAiRepo.getCachedTranslation(lyricId)?.tlyric || '';
    const roma = response.body.romalrc?.lyric || '';
    const lyricText = mergeLrcLayers(lrcText, roma, trans);

    return writeLrcFile(lyricText);
  } catch (error) {
    if (error.code === 'NO_LYRICS') {
      throw error;
    }
    errnoToFatal(error);
    const err = new Error(`下载歌词失败: ${describeError(error)}`);
    err.code = error.code;
    // 取消语义不得被包装吞掉——processTask 靠 aborted 标记区分取消与失败
    err.aborted = Boolean(error.aborted) || error.code === 'ERR_CANCELED';
    err.fatal = Boolean(error.fatal);
    throw err;
  }
}

async function downloadCover(coverUrl, outputPath, signal) {
  try {
    if (!coverUrl) {
      throw fatalError('封面链接不存在');
    }
    // 消费端闸与 download-manager.deriveCoverUrl 同款：派生闸落地前已
    // 入库的任务行可能带脏 cover_url——按「无封面」收敛而非回源任意
    // 宿主（http(s) + 图床白名单，fatal 不重试）
    let parsedCover = null;
    try { parsedCover = new URL(coverUrl); } catch { /* 非法 URL → 按无封面 */ }
    if (!parsedCover
      || (parsedCover.protocol !== 'http:' && parsedCover.protocol !== 'https:')
      || !isImgProxyHost(parsedCover.hostname)) {
      throw fatalError('封面地址不在图床白名单');
    }

    throwIfAborted(signal);
    const finalPath = pathWithExt(outputPath, extFromUrl(coverUrl, COVER_EXTS, 'jpg'));
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });

    // hdslb（B 站图床）防盗链：空 Referer 目前放行，但 axios 默认 UA 是
    // 非浏览器形态、一旦收紧即 403——与 proxy.js 对 BILI_CDN_HOSTS 注头
    // 同口径，对 hdslb 封面附 UA+Referer；其他图床（ytimg/126/gtimg）
    // 不查防盗链，不附带
    const coverHost = parsedCover.hostname; // 上方已 parse 且过白名单
    const coverHeaders = (coverHost === 'hdslb.com' || coverHost.endsWith('.hdslb.com'))
      ? BILI_PUBLIC_HEADERS : undefined;

    // 白名单谓词下传逐跳重验：入口闸只管首发 URL——封面图床若 302 到
    // 白名单外宿主（重定向投毒回源任意域），fetchStream 每跳同闸拦下
    const response = await fetchStream(coverUrl, {
      timeout: 60000, signal, headers: coverHeaders, allowedHost: isImgProxyHost
    });
    if (response.status !== 200) {
      response.data.destroy();
      throw fatalError(`上游返回 ${response.status}`);
    }

    const saved = await streamToFile(response, finalPath, {
      maxBytes: MAX_COVER_BYTES,
      maxTotalMs: 60000 // 与头超时对齐 60s
    });
    return { path: saved.path, size: saved.size };
  } catch (error) {
    errnoToFatal(error);
    const err = new Error(`下载封面失败: ${describeError(error)}`);
    err.code = error.code;
    err.aborted = Boolean(error.aborted) || error.code === 'ERR_CANCELED';
    err.fatal = Boolean(error.fatal);
    throw err;
  }
}

module.exports = {
  downloadAudio,
  downloadLyrics,
  downloadCover,
  downloadVideo,
};


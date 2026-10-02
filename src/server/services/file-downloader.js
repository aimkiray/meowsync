const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { callNeteaseApi, resolveSongUrls } = require('./netease-api');
// 字节流原语（fetchStream/streamToFile/fatalError 等）在 download-io.js——
// 本文件只做 provider 媒体编排与四类工件下载入口
const {
  MIME_EXT, mergeLrcTrans, fatalError, errnoToFatal, throwIfAborted,
  describeError, fetchStream, removePartial, streamToFile,
  extFromUrl, pathWithExt,
} = require('./download-io');
const qq = require('../lib/qq');
const { resolveBiliAudio, resolveBiliMedia, BILI_PUBLIC_HEADERS } = require('../lib/bilibili');
const { fetchPlayer: ytFetchPlayer, fetchPlayerWith: ytFetchPlayerWith, pickStreamList: ytPickStreamList } = require('../lib/youtube');
const lyricAiRepo = require('../repositories/lyricAi');
const { verifyDownloadOwnership } = require('./lyric-verify');

// qq_<songmid> / bv_<bvid>[_pN] / yt_<videoId> 曲目的服务端下载分发：
// 各源自有流直取（不经网易云解锁链——别家曲库不是它们的源），
// 回落路径与网易云链同构（fetchStream SSRF 守卫 + streamToFile .part 对账）。
// 流地址宿主与 routes/qq.js 共用 lib/qq.js 的 QQ_STREAM_HOST_OK（sip 可能回
// 裸 IP——后缀判定天然拒绝）
const { QQ_SONG_ID_RE: QQ_ID_RE, BV_TRACK_ID_RE, YT_TRACK_ID_RE, NETEASE_ID_RE } = require('../../shared/predicates.js');
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

async function downloadExternalAudio(bvM, ytM, outputPath, onProgress, signal, providerData) {
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
        // mime=/path——B 站 flac 轨 url 无后缀，靠 content-type 落 .flac
        const mime = (String(resp.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
          || String(cand.mimeType || '').split(';')[0].trim().toLowerCase());
        const ext = MIME_EXT[mime] || extFromUrl(cand.url, AUDIO_EXTS, 'm4a');
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
        if (e?.fatal && e?.code) throw e;
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
  for (const cand of progressiveCarry) {
    throwIfAborted(signal);
    const tmpPath = `${outputPath}.prog.mp4`;
    try {
      const resp = await fetchStream(cand.url, { timeout: 300000, signal, headers });
      if (resp.status !== 200 && resp.status !== 206) {
        resp.data.destroy();
        continue;
      }
      fs.mkdirSync(path.dirname(tmpPath), { recursive: true });
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
      if (e?.aborted || (e?.fatal && e?.code)) throw e;
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
    // 直到队列 abort。faststart 要整文件二次搬迁，超时按下限 50MB/s 随
    // 输入体量伸缩——8GiB 在慢盘上 ~3min，定值 120s 会误杀
    const inputBytes = [videoPath, audioPath]
      .reduce((sum, p) => { try { return sum + fs.statSync(p).size; } catch { return sum; } }, 0);
    const muxTimeoutMs = 120000 + Math.ceil(inputBytes / (50 * 1024 * 1024)) * 1000;
    const killTimer = setTimeout(() => {
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
      // spawn 级失败（ENOENT/EACCES 库损坏）是环境病不是候选病——标 fatal
      // 穿透候选循环，否则每段视频下完才死在 mux，N 档全烧一遍
      e.fatal = true;
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
        // killedBy=SIGKILL 超时杀与真崩 exit N 要在日志里分得开
        const why = killedBy ? `被${killedBy}杀（超时或中止）` : `exit ${code}`;
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
    // 超时随输入体量伸缩（与 ffmpegMux 同口径，抽轨比封装少一半写但同阶）
    let inputBytes = 0;
    try { inputBytes = fs.statSync(inPath).size; } catch { /* 0 按最小超时 */ }
    const killTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 进程已退 */ }
    }, 120000 + Math.ceil(inputBytes / (50 * 1024 * 1024)) * 1000);
    const onAbort = () => { try { child.kill('SIGKILL'); } catch { /* 进程已退 */ } };
    signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
    };
    child.on('error', (e) => {
      cleanup();
      // spawn 级失败是环境病——标 fatal 穿透候选循环（与 ffmpegMux 同口径）
      e.fatal = true;
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
        const why = killedBy ? `被${killedBy}杀（超时或中止）` : `exit ${code}`;
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
        if (e?.fatal && e?.code) throw e;
        lastErr = lastErr || e;
      }
      // 只消费「真反超」的档——probe 判门看的是最高档，若它失败不能让
      // 低于 bestH 的合流档截胡（那比自适应还差），低档留给尾部兜底
      const winners = (prog || []).filter(c => (c.h || 0) > bestH);
      if (winners.length) {
        console.info(`[video-dl] 合流档 ${winners[0].h}p 反超自适应 ${bestH}p——直落合流`);
        for (const cand of winners) {
          throwIfAborted(signal);
          // 记已试——尾部兜底循环消费同一批 URL，确定性失败不重复打
          triedProgressive.add(cand.url);
          try {
            const saved = await fetchTo(cand, outputPath, 0, 100);
            return { path: saved.path, size: saved.size, url: cand.url, videoMeta: metaOf(cand, 'progressive') };
          } catch (e) {
            throwIfAborted(signal);
            if (e?.fatal && e?.code) throw e;
            downgradeWarn(cand, e);
            lastErr = e;
          }
        }
      }
    }
    if (FFMPEG_OK && media.videos.length && !media.audios.length) {
      // 音轨表为空时逐候选白下整段视频注定在合流前抛——记语义错误
      // 直接换下一轮/相位（下一轮重解可能拿到带音轨的批）
      lastErr = lastErr || new Error('该视频无可用音轨，无法合流');
    } else if (FFMPEG_OK && media.videos.length) {
      // 音轨跨视频候选复用——换视频档重下音轨是纯浪费
      let audioTmp = null;
      try {
        for (const v of media.videos) {
          throwIfAborted(signal);
          const videoTmp = `${outputPath}.v${media.videos.indexOf(v)}`;
          try {
            await fetchTo(v, videoTmp, 0, 75);
            if (!audioTmp) {
              // 音轨落盘成功才置位——置位先行会让下一个视频候选对着不
              // 存在的 .audio 合流，且整批音轨失去重试机会
              const tmp = `${outputPath}.audio`;
              let audioOk = false;
              for (const a of media.audios) {
                try { await fetchTo(a, tmp, 75, 15); audioOk = true; break; } catch (e) {
                  throwIfAborted(signal);
                  if (e?.fatal && e?.code) throw e;
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
              // codec 透传：bv 候选自带 codecs 字段，yt 从 mimeType 抽——
              // hev1 源要 hvc1 tag 才是通用 mp4
              await ffmpegMux(videoTmp, audioTmp, outputPath, signal, v.codec || codecOf(v.mimeType));
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
            return { path: outputPath, size, url: v.url, videoMeta: metaOf(v, 'adaptive') };
          } catch (e) {
            throwIfAborted(signal);
            // 上游 4xx 的 fatal 只判死这一条 URL——换候选；带 errno 的本地
            // 确定性失败（ENOSPC/EROFS）才是真穿透，候选级循环不该为它空转
            if (e?.fatal && e?.code) throw e;
            downgradeWarn(v, e);
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
      if (e?.fatal && e?.code) throw e;
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

// providerData：任务行快照的源私有字段（{qq:{mediaMid}}/{bilibili:{bvid,cid,page}}/
// {youtube:{videoId}}）——mediaMid 是 vkey filename 键，带了可省一次注定失败的
// vkey 空调用 + detail 回填往返；缺省/过期都安全，各解析器内部仍兜底
async function downloadAudio(songId, outputPath, bitrate = 320000, onProgress, signal, providerData) {
  try {
    // bv_<bvid>[_pN] / yt_<videoId> 分发：自有站直链
    const bvM = String(songId).match(BV_TRACK_ID_RE);
    const ytM = !bvM && String(songId).match(YT_TRACK_ID_RE);
    if (bvM || ytM) {
      return await downloadExternalAudio(bvM, ytM, outputPath, onProgress, signal, providerData);
    }
    // qq_<songmid> 分发：QQ 源直链（BEST 档梯）→ 同一条 fetchStream 守卫管线
    const qqM = String(songId).match(QQ_ID_RE);
    if (qqM) {
      const hit = await qq.pickStreamUrl(qqM[1], {
        mediaMid: providerData?.qq?.mediaMid || '',
        ladder: qqLadderFor(bitrate),
        signal
      });
      if (!hit) throw fatalError('QQ 音乐无可用音源（可能需要 VIP 权限或地域限制）');
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
    // 进程内直调上游模块 + 共享解锁后处理（purpose=download：不走 audio-proxy），
    // 不经过 HTTP 自调——避免依赖服务端口配置，也省去一圈 loopback 开销
    let result;
    try {
      result = await callNeteaseApi('song_url', { id: songId, br: bitrate });
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
    // 仍要把整条解锁链（song_detail + 4源试错 + HEAD 探测，最坏分钟级）
    // 跑完才在下方 throwIfAborted 被发现
    await resolveSongUrls(items, { purpose: 'download', signal });

    // items[0] 可能解锁失败但后续条目有 url——选第一个可用的，而不是永远盯着第一个
    const songData = items.find(i => i.url && !i.unlockFailed) || items[0];
    if (songData.unlockFailed) {
      throw fatalError('解锁失败，所有可用源均无匹配');
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

    const audioResponse = await fetchStream(songData.url, { timeout: 300000, signal });
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
  } catch (error) {
    errnoToFatal(error);
    const err = new Error(`下载音频失败: ${describeError(error)}`);
    err.code = error.code;
    // aborted/fatal 标记对称透传：processTask 靠它们区分取消/可重试/确定性失败
    err.aborted = Boolean(error.aborted) || error.code === 'ERR_CANCELED';
    err.fatal = Boolean(error.fatal);
    throw err;
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
    // 无匹配即无词源，按 NO_LYRICS 判「缺词不算失败」，别让外部曲死等歌词段
    const extM = String(songId).match(BV_TRACK_ID_RE) || String(songId).match(YT_TRACK_ID_RE);
    if (extM && !NETEASE_ID_RE.test(String(providerData?.neteaseId ?? ''))) {
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
    if (qqLm && !response?.body?.lrc?.lyric
        && NETEASE_ID_RE.test(String(providerData?.neteaseId ?? ''))) {
      const fb = await callNeteaseApi('lyric', { id: String(providerData.neteaseId) }, { signal })
        .catch(() => null);
      if (fb?.body?.code === 200 && fb.body.lrc?.lyric) {
        response = fb;
        lyricId = String(providerData.neteaseId);
        qqGrafted = true;
      }
    }
    if (qqDefinitiveEmpty && !response?.body?.lrc?.lyric) {
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

    const lrc = response.body.lrc;
    if (!lrc || typeof lrc.lyric !== 'string' || !lrc.lyric) {
      // code 契约而非消息串匹配——下游按 NO_LYRICS 判定"缺词不算失败"；
      // 非字符串 lyric 是上游畸形数据，与缺词同待遇（确定性，不该重试）
      const err = new Error('歌词不存在');
      err.code = 'NO_LYRICS';
      throw err;
    }

    // 错词不落盘：嫁接词源（bv_/yt_ 经匹配、qq 缺词回落网易云）可能是错配——
    // 与播放链同 verdict 签名核验归属，决策收敛在 lyric-verify：
    // 已落库判定不随 aiEnabled 旁路；AI 关只影响新判定的来源
    if (extM || qqGrafted) {
      const ownership = await verifyDownloadOwnership({
        songId, lyricId, providerData, grafted: qqGrafted, lrc: lrc.lyric, signal
      });
      if (ownership === false) {
        console.info(`[download] ${songId} 歌词归属核验不符，跳过落盘`);
        const err = new Error('歌词与来源不匹配');
        err.code = 'NO_LYRICS';
        throw err;
      }
    }

    // 官方译文按同刻时间戳插到原文行后落盘（标准合并 LRC 格式——播放器
    // 同刻双行显示原文+译文；网易 tlyric 与 QQ trans 同口径处理，qq 嫁接
    // 网易云的回落响应也是 tlyric 形态）；无官方译文时吃 AI/历史译文缓存
    const trans = (response.body.tlyric?.lyric || response.body.trans)
      || lyricAiRepo.getCachedTranslation(lyricId)?.tlyric || '';
    const lyricText = mergeLrcTrans(lrc.lyric, trans);

    throwIfAborted(signal);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    const partPath = `${outputPath}.part`;
    try {
      fs.writeFileSync(partPath, lyricText, 'utf-8');
      fs.renameSync(partPath, outputPath);
    } catch (writeError) {
      removePartial(partPath); // 写一半失败不留孤儿 .lrc.part
      throw writeError;
    }

    return {
      path: outputPath,
      size: Buffer.byteLength(lyricText, 'utf-8')
    };
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

    throwIfAborted(signal);
    const finalPath = pathWithExt(outputPath, extFromUrl(coverUrl, COVER_EXTS, 'jpg'));
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });

    // hdslb（B 站图床）防盗链：空 Referer 目前放行，但 axios 默认 UA 是
    // 非浏览器形态、一旦收紧即 403——与 proxy.js 对 BILI_CDN_HOSTS 注头
    // 同口径，对 hdslb 封面附 UA+Referer；其他图床（ytimg/126/gtimg）
    // 不查防盗链，不附带
    let coverHost = '';
    try { coverHost = new URL(coverUrl).hostname; } catch { /* 下行 fetchStream 会给 BAD_URL */ }
    const coverHeaders = (coverHost === 'hdslb.com' || coverHost.endsWith('.hdslb.com'))
      ? BILI_PUBLIC_HEADERS : undefined;

    const response = await fetchStream(coverUrl, { timeout: 60000, signal, headers: coverHeaders });
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


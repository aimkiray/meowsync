// 下载域的文件系统/路径与纯计算助手层——从 download-manager 抽出的无会话
// 状态部分（intactCache/sanitizeMemo 是幂等 memo，不是流程状态）。
// download-manager 保留：队列/任务生命周期、控制器状态机、引擎协程。
const path = require('path');
const fs = require('fs');
const downloadTasksRepo = require('../repositories/downloadTasks');
const { dataDir } = require('../db/client');
const { estimateDuration } = require('./netease-api');
const { sanitizeFilename } = require('./download-io');
const { stripAbsolutePaths } = require('../lib/sanitize');
const { BV_TRACK_ID_RE, YT_TRACK_ID_RE } = require('../../shared/predicates.js');

// 下载文件根目录：<dataDir>/downloads，可用 DOWNLOAD_DIR 覆盖（容器内指到挂载卷）
// resolve 归一化：路径安全比较依赖绝对路径
const DOWNLOAD_BASE_DIR = path.resolve(process.env.DOWNLOAD_DIR || path.join(dataDir, 'downloads'));

const retryDelayMs = (retryCount) => Math.min(2000 * (2 ** retryCount), 30000);

// 外部源曲（自有站媒体）判定：只有它们存在可下载的源站视频工件——
// downloadVideo 位对网易云/QQ 曲无意义，入队即裁
const isExternalSongId = (id) =>
  BV_TRACK_ID_RE.test(String(id)) || YT_TRACK_ID_RE.test(String(id));

// 落盘后时长对账：HEAD 探测失败会跳过解锁端的时长校验，预览剪辑就此溜过——
// 用真实字节数+真实码率（解锁源用 unblockedBr）估算时长，显著短于元数据即是
// 剪辑（只查"短"，不查"长"：
// VBR/码率虚标只会让估算偏大，而偏大不构成剪辑证据）
function durationLooksTruncated(sizeBytes, br, durationMs) {
  if (!sizeBytes || !br || !durationMs) return false;
  const estimated = estimateDuration(sizeBytes, br);
  return estimated !== null && estimated < durationMs * 0.8;
}

// 排空等待上限：上游解锁/取链等不可中止阶段可能卡住（无 signal 无超时），
// 排空不能无限等——超时后放行清扫，残余写入由后续孤儿文件清理兜底
const DRAIN_TIMEOUT_MS = 30000;
function drainWithTimeout(promise, ms = DRAIN_TIMEOUT_MS) {
  return Promise.race([
    Promise.resolve(promise).catch(() => {}),
    // unref：drain 早已 settle 的兜底计时器不该拖住进程退出
    new Promise(resolve => {
      const t = setTimeout(resolve, ms);
      t.unref?.();
    })
  ]);
}

// 来源侧日期合法性窗（规格要求各文件就地实现同一公式）：
//   下限 2000-01-01（YT 2005/B 站 2009 上线前不存在真发布日，再早必脏）；
//   上限 now+24h（容忍时钟偏差；真实未来首播/预售超出此界按未知处理——
//   发布日尚在未来极罕见的视频此刻也播不了，损失可忽略）
const sanePublishMs = (v) => {
  const ms = Number(v);
  return Number.isFinite(ms) && ms >= 946684800000 && ms <= Date.now() + 86400e3 ? ms : 0;
};

// 任务行快照的源私有字段：qq=mediaMid（vkey filename 键）；bv_/yt_ 导
// 入曲带自有源流定位（bilibili=bvid/cid/page、youtube=videoId）+ neteaseId
// （匹配到的网易词源）——落 provider_data 让任务跨重启可重放、
// 词源不依赖内存态歌单对象
function providerDataOf(track) {
  const qqMid = track.qq?.mediaMid;
  if (qqMid) {
    return {
      qq: { mediaMid: qqMid },
      // qq 曲缺词时回落 neteaseId 词源——核验签名需要曲自身名/艺人快照
      neteaseId: /^\d+$/.test(String(track.neteaseId ?? '')) ? String(track.neteaseId) : null,
      title: String(track.name || '').slice(0, 300) || null,
      author: String((Array.isArray(track.ar) ? track.ar : track.artists || [])
        .map(a => a?.name).filter(Boolean).join(' ')).slice(0, 120) || null
    };
  }
  const neteaseId = /^\d+$/.test(String(track.neteaseId ?? '')) ? String(track.neteaseId) : null;
  if (track.bilibili?.bvid) {
    return {
      bilibili: {
        bvid: String(track.bilibili.bvid),
        cid: /^\d+$/.test(String(track.bilibili.cid ?? '')) ? String(track.bilibili.cid) : null,
        page: Math.max(1, parseInt(track.bilibili.page, 10) || 1),
        // 来源标题/作者随 providerData 走——歌词归属核验的 verdict 签名
        // 需要它们，缺了只能跳过核验（老镜像行的无损降级）
        title: String(track.bilibili.title || '').slice(0, 300) || null,
        author: String(track.bilibili.author || '').slice(0, 120) || null,
        // 源稿发布日（epoch ms）：缺席/脏值不出键——providerData 投影面有
        // 既有深等于断言，无字段曲目不产键才能零扰动
        ...(sanePublishMs(track.bilibili.publishedAt)
          ? { publishedAt: sanePublishMs(track.bilibili.publishedAt) } : {})
      },
      neteaseId
    };
  }
  if (track.youtube?.videoId) {
    return {
      youtube: {
        videoId: String(track.youtube.videoId),
        title: String(track.youtube.title || '').slice(0, 300) || null,
        author: String(track.youtube.author || '').slice(0, 120) || null,
        ...(sanePublishMs(track.youtube.publishedAt)
          ? { publishedAt: sanePublishMs(track.youtube.publishedAt) } : {})
      },
      neteaseId
    };
  }
  // 外部曲缺 provider 定位字段（老镜像/畸形行）但已匹配词源——neteaseId
  // 单独落 providerData，别让歌词段连词源一起丢
  if (neteaseId && (BV_TRACK_ID_RE.test(String(track.id)) || YT_TRACK_ID_RE.test(String(track.id)))) {
    return { neteaseId };
  }
  return null;
}

function isUnderDownloadDir(filePath) {
  const relative = path.relative(DOWNLOAD_BASE_DIR, path.resolve(filePath));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

// errorMessage 会经 API 透出——剥掉绝对路径，避免把服务器文件系统布局暴露
// 给客户端：先保留 <downloads> 可读标记，其余绝对路径（tmpdir/dbPath 相关
// fs 错误）用通用剥离兜底
function sanitizeErrorMessage(message) {
  return stripAbsolutePaths(
    String(message || '').split(DOWNLOAD_BASE_DIR).join('<downloads>')
  );
}

// 任务对象经 API 透出前把绝对路径相对化（audio/xxx.mp3）：与 sanitizeErrorMessage 同一
// 意图——错误消息剥了路径，任务字段却把服务器布局明文发给客户端说不通。
// 相对路径对前端 diff 语义无损（比较一致性保持不变）
function toPublicTask(task) {
  if (!task) return task;
  // path.relative 在 Windows 宿主会产反斜杠——API 字段统一归一为 '/'
  const rel = p => (
    typeof p === 'string' && p && isUnderDownloadDir(p)
      ? path.relative(DOWNLOAD_BASE_DIR, p).split(path.sep).join('/')
      : null
  );
  return {
    ...task,
    // completed 行但登记文件被外部删除 → filesIntact:false——前端据此不把
    // 它当"已下载"展示（下载入口重新露出，点了会自愈重跑）。轮询热路径走
    // 缓存直读+后台异步探测（filesIntactCached）——逐行同步 stat 在挂载卷
    // 上是事件循环 stall；冷 miss 先缺省（!==false 口径即「未知按在位」），
    // 下一轮轮询见真值
    filesIntact: task.status !== 'completed' || filesIntactCached(task),
    audioPath: rel(task.audioPath),
    lyricsPath: rel(task.lyricsPath),
    coverPath: rel(task.coverPath),
    videoPath: rel(task.videoPath)
  };
}

function deleteFiles(filePaths) {
  let deletedFiles = 0;

  for (const filePath of filePaths.filter(Boolean)) {
    if (!isUnderDownloadDir(filePath)) continue;
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        deletedFiles += 1;
      }
    } catch {
      // 文件被在途流持有（Windows EPERM）等：跳过不中断批量删除
    }
  }

  return deletedFiles;
}

// deleteFiles 的异步版：歌单级联的批量 unlink 挪到 detached 协程后改走
// fs.promises——N 首歌 ~4N 次串行同步 unlink 在挂载卷上每个 op 一个 RTT，
// 会把事件循环摁死在请求路径上。口径与同步版逐项一致：下载根外路径跳过、
// 单文件失败吞掉不中断（ENOENT=本就不在，等同 existsSync 门；EPERM=在途
// 流持有）、返回实删数。有界并发：一次性铺开全部 unlink 会打满 libuv
// 线程池/fd
const DELETE_FILE_CONCURRENCY = 8;
async function deleteFilesAsync(filePaths) {
  const candidates = filePaths.filter(Boolean).filter(isUnderDownloadDir);
  let deletedFiles = 0;
  let cursor = 0;
  const worker = async () => {
    // 读下标与 cursor++ 之间无 await——单线程下并发 worker 不会抢同一元素
    while (cursor < candidates.length) {
      const filePath = candidates[cursor++];
      try {
        await fs.promises.unlink(filePath);
        deletedFiles += 1;
      } catch {
        // 单文件失败跳过不中断批量删除（同 deleteFiles 口径）
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(DELETE_FILE_CONCURRENCY, candidates.length) }, worker)
  );
  return deletedFiles;
}

// songId 来自上游元数据，直接拼路径（消歧后缀/covers 文件名）必须消毒——
// '../' 之类可逃出 covers/ 甚至 DOWNLOAD_BASE_DIR；纯数字也截断防 ENAMETOOLONG
const getSafeSongId = (task) => {
  const raw = String(task.songId);
  return /^\d+$/.test(raw) ? raw.slice(0, 40) : `task-${task.id}`;
};

// "completed 行"的真实校验：登记过的文件必须还在盘上。音频启用时 audioPath
// 缺失直接判不完整；歌词/封面只查"登记过却被外部删掉"（NO_LYRICS/封面失败
// 本就不登记路径，不能当缺失判）。幂等返回/收养前都要过这道闸——文件被
// 外部删掉的 completed 行是幻影，应回退到重跑而不是继续报"已下载"
const pathPresent = (p) => {
  try {
    fs.statSync(p);
    return true;
  } catch (e) {
    // ENOENT/ENOTDIR = 文件确实不在；EPERM/EIO/挂载卷抖动一律判"在"——
    // 反向判会把瞬时 IO 故障放大成全量重置重下，误删/虚报方向相反更安全
    return e?.code !== 'ENOENT' && e?.code !== 'ENOTDIR';
  }
};

// TTL 缓存：listTasks/getQueue 轮询对每行 completed 打 3 次同步 stat，
// 挂载卷上每个 stat 一个 RTT——队列卡 2s 轮询 × N 行会把事件循环摁死。
// 指纹含全部路径字段：行被重置/改写后缓存自然失效，TTL 只是"外部删文件"
// 这一信号的探测延迟上限
const INTACT_CACHE_TTL_MS = 3000;
const intactCache = new Map(); // taskId -> { fp, result, at }
function taskFilesIntact(task) {
  if (!task || task.status !== 'completed') return false;
  const fp = `${task.audioPath}|${task.lyricsPath}|${task.coverPath}|${task.videoPath}`;
  const hit = intactCache.get(task.id);
  if (hit && hit.fp === fp && Date.now() - hit.at < INTACT_CACHE_TTL_MS) {
    return hit.result;
  }
  const result =
    !(task.downloadAudio && !(task.audioPath && pathPresent(task.audioPath)))
    && !(task.lyricsPath && !pathPresent(task.lyricsPath))
    && !(task.coverPath && !pathPresent(task.coverPath))
    && !(task.videoPath && !pathPresent(task.videoPath));
  if (intactCache.size > 4096) intactCache.clear();
  intactCache.set(task.id, { fp, result, at: Date.now() });
  return result;
}

// pathPresent 的异步版——filesIntact 后台探测专用，判读口径逐项对齐：
// ENOENT/ENOTDIR 才判「不在」，其余 IO 错一律判「在」（反向判会把瞬时
// IO 故障放大成重置重下，误报方向相反更安全）
const pathPresentAsync = (p) => fs.promises.stat(p)
  .then(() => true, (e) => e?.code !== 'ENOENT' && e?.code !== 'ENOTDIR');

// toPublicTask 的 filesIntact 投影走「缓存直读 + 有界并发异步探测」：
// 列表端点每轮对全行 completed 过 toPublicTask，逐行同步 statSync 在挂载卷
// 上是每波数秒的事件循环 stall（2000 行 ×≤4 stat）——TTL 只降频不削峰。
//   - 未过期命中：直返缓存值
//   - 过期命中：先返陈旧值、探测排进小并发池后台刷新——「外部删文件」探测
//     延迟上限从 TTL 变 TTL+一轮探测时长，字段口径不变（仍只在 false 时
//     判幻影）
//   - 冷 miss / 指纹漂移（行被重置改写过）：不拿响应线程换真值——返
//     undefined（前端 filesIntact!==false 口径 = 未知按在位），探测结果
//     下一轮轮询生效
// 正确性调用方（收养 keepCompleted/status 幂等短路/补视频判定等）不许走
// 这里——它们用 taskFilesIntact 拿当拍真值
const INTACT_PROBE_CONCURRENCY = 8;
const intactInflight = new Map(); // task.id -> fp（排队与在途统一按指纹去重）
const intactQueue = [];
let intactActive = 0;
const pumpIntactQueue = () => {
  while (intactActive < INTACT_PROBE_CONCURRENCY && intactQueue.length) {
    const job = intactQueue.shift();
    intactActive++;
    job().catch(() => {}).finally(() => {
      intactActive--;
      pumpIntactQueue();
    });
  }
};
function enqueueIntactProbe(task, fp) {
  if (intactInflight.get(task.id) === fp) return; // 同指纹探测已在途/在排
  intactInflight.set(task.id, fp);
  // 探测前快照登记字段——行对象若在排队期间被复写也不混进本次判读
  const t = {
    downloadAudio: task.downloadAudio,
    audioPath: task.audioPath,
    lyricsPath: task.lyricsPath,
    coverPath: task.coverPath,
    videoPath: task.videoPath
  };
  intactQueue.push(async () => {
    try {
      // 判读式与 taskFilesIntact 逐项同构：audio 段被 downloadAudio flag
      // 门控（相位关闭时缺档不算不完整），lyrics/cover/video 只查「登记
      // 过却被外删」
      const result =
        !(t.downloadAudio && !(t.audioPath && await pathPresentAsync(t.audioPath)))
        && !(t.lyricsPath && !await pathPresentAsync(t.lyricsPath))
        && !(t.coverPath && !await pathPresentAsync(t.coverPath))
        && !(t.videoPath && !await pathPresentAsync(t.videoPath));
      if (intactCache.size > 4096) intactCache.clear();
      intactCache.set(task.id, { fp, result, at: Date.now() });
    } finally {
      intactInflight.delete(task.id);
    }
  });
  pumpIntactQueue();
}
function filesIntactCached(task) {
  const fp = `${task.audioPath}|${task.lyricsPath}|${task.coverPath}|${task.videoPath}`;
  const hit = intactCache.get(task.id);
  if (hit && hit.fp === fp) {
    if (Date.now() - hit.at < INTACT_CACHE_TTL_MS) return hit.result;
    enqueueIntactProbe(task, fp);
    return hit.result; // 过期先返陈旧值——探测在飞，下轮轮询换新值
  }
  enqueueIntactProbe(task, fp);
  return undefined;
}

// sanitizeFilename 是纯函数；兄弟扫描为每个任务重复消毒全歌单名字（O(N²) CPU）。
// 有界 memo 去掉大头；超限整体清空（清比重排实现简单，命中率在歌单尺度下已足够）
const sanitizeMemo = new Map();
const memoSanitize = (name, maxBytes) => {
  const key = `${maxBytes}:${name}`;
  let out = sanitizeMemo.get(key);
  if (out === undefined) {
    out = sanitizeFilename(name, maxBytes);
    if (sanitizeMemo.size > 4096) sanitizeMemo.clear();
    sanitizeMemo.set(key, out);
  }
  return out;
};

// 计算一个任务会占用的写路径——processTask 用它取锁，expireDeferred 用它判断
// 锁是否仍被持有（续期 vs 判失败）。两处必须用同一套逻辑，否则判定不一致
const taskLockKeys = (task) => {
  const outputDir = path.join(DOWNLOAD_BASE_DIR, task.playlistId.toString());
  // 每段各留预算：文件名总长（含 ' - '/songId 后缀/扩展名）不得超 ext4 的 255B
  const sanitizedArtist = memoSanitize(task.artist, 90);
  const sanitizedSongName = memoSanitize(task.songName, 110);
  // 同歌单内不同 songId 可能消毒后撞名：原始名不同（如 "x?" vs "x<"、"x." vs "x"）
  // 会被 sanitizeFilename 坍缩成同一文件名互相覆盖——碰撞检测必须比较消毒后的名字
  const siblings = downloadTasksRepo.listTasksByPlaylist(task.playlistId);
  const nameCollision = siblings.some(
    t => t.id !== task.id
      && memoSanitize(t.artist, 90) === sanitizedArtist
      && memoSanitize(t.songName, 110) === sanitizedSongName
  );
  const safeSongId = getSafeSongId(task);
  const baseFilename = nameCollision
    ? `${sanitizedArtist} - ${sanitizedSongName} (${safeSongId})`
    : `${sanitizedArtist} - ${sanitizedSongName}`;
  return [
    task.downloadAudio ? path.join(outputDir, 'audio', `${baseFilename}.mp3`) : null,
    task.downloadLyrics ? path.join(outputDir, 'lyrics', `${baseFilename}.lrc`) : null,
    (task.downloadCover && task.coverUrl)
      ? path.join(outputDir, 'covers', `${safeSongId}.jpg`)
      : null,
    (task.downloadVideo && isExternalSongId(task.songId))
      ? path.join(outputDir, 'videos', `${baseFilename}.mp4`)
      : null
  ].filter(Boolean);
};

module.exports = {
  DOWNLOAD_BASE_DIR,
  isExternalSongId,
  durationLooksTruncated,
  drainWithTimeout,
  DRAIN_TIMEOUT_MS,
  providerDataOf,
  retryDelayMs,
  isUnderDownloadDir,
  sanitizeErrorMessage,
  toPublicTask,
  deleteFiles,
  deleteFilesAsync,
  getSafeSongId,
  pathPresent,
  taskFilesIntact,
  memoSanitize,
  taskLockKeys,
};

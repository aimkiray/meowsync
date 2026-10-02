// 用户上传/自建曲目：音频/视频/封面/歌词文件的接管端点。
//
// 模型：上传资产不落 multipart（全量进内存），走 application/octet-stream
// 手写流式落盘——与 readBodyText 同款的 ReadableStream 逐 chunk 消费，但
// 直写文件而非缓冲拼接（音视频动辄几百 MB，内存拼接不可行）。
//
// 登记面：一曲一行的 download_tasks（UNIQUE(playlist_id, song_id)）挂在
// local_uploads 伪歌单下——4 个 *_path 列正好一列一类（audio/video/cover/
// lyrics），status=completed 使 /downloads/songs/:id/file 端点直接可用；
// reapOrphanFiles 只扫 <DL>/ 下数字名目录，uploads/ 天然不被收割，删除
// 走 deleteSongFiles 的登记行+文件双清语义。
//
// 歌单镜像刻意不收 file_ 曲（isResolvableTrackId 不放行）——资产归属 uploads
// 伪歌单，删除歌单不该级联删掉曲目的唯一音源。
const { Hono } = require('hono');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DOWNLOAD_BASE_DIR, isUnderDownloadDir } = require('../services/download-fs');
const downloadTasksRepo = require('../repositories/downloadTasks');
const playlistsRepo = require('../repositories/playlists');
const downloadManager = require('../services/download-manager');
const { isNeteasePlaylistDeleting, deletingPlaylists } = require('../lib/deletion-locks');
const { fail, handleError, httpError } = require('../lib/http-error');
const { FILE_TRACK_ID_RE } = require('../../shared/predicates.js');
const { rateLimit } = require('../lib/rate-limit');

const app = new Hono();

// uploads 伪歌单锚点：文件资产的 playlist 归属（netease_playlist_id 列承载）。
// 此行是承重不变量——对应歌单行永不可级联删（deletePlaylistCascade 服务层
// 400 拦）；绕过删除会让全部 file_* 登记失联、uploads/ 目录出收割视野成
// 永久孤儿。懒建自愈只保证锚行存在，救不回失联登记
const UPLOADS_PLAYLIST_ID = 'local_uploads';

// 扩展名白名单——文件名可伪造，白名单决定落盘形态与 file 端点的 MIME
const KIND_DEFS = {
  audio: { exts: new Set(['mp3', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'webm']), maxBytes: 512 * 1024 * 1024, dir: 'audio' },
  video: { exts: new Set(['mp4', 'webm', 'mkv', 'mov']), maxBytes: 2 * 1024 * 1024 * 1024, dir: 'video' },
  cover: { exts: new Set(['jpg', 'jpeg', 'png', 'webp']), maxBytes: 32 * 1024 * 1024, dir: 'cover' },
  // 歌词小文件——内嵌 track 会让 raw_json 在每份歌单镜像里重复携带，走文件列
  lyrics: { exts: new Set(['lrc', 'txt']), maxBytes: 4 * 1024 * 1024, dir: 'lyrics' },
};
const KIND_PATH_COL = { audio: 'audioPath', video: 'videoPath', cover: 'coverPath', lyrics: 'lyricsPath' };
// 对应的 download_* 就位标记列——filesIntact 的 audio 完整性检查是 flag 门控，
// 补传/换源不置位会留「path 有值但 flag=0」的幻影已下载态
const KIND_DL_FIELD = { audio: 'downloadAudio', video: 'downloadVideo', cover: 'downloadCover', lyrics: 'downloadLyrics' };

const uploadsDir = (kind) => path.join(DOWNLOAD_BASE_DIR, 'uploads', KIND_DEFS[kind].dir);

function newFileSongId() {
  return `file_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
}

// 在飞上传互斥锁：同 songId 并发 POST 会共享 .part/交错写/撞 UNIQUE——
// 服务端不依赖调用方自律（串行 await 只是客户端纪律）。
// 键级 songId：同曲的 audio+cover 并发也互斥（串行 20/min 桶够宽，不饿）
const inflightUploads = new Set();
const MAX_INFLIGHT = 4; // 并发闸：无认证部署的打盘面由它兜（20×2GB/min 的请求限流管不了体量）

// 伪歌单懒建：先查在建——upsert 是 ON CONFLICT DO UPDATE，裸调会把
// updated_at/last_synced_at 每次刷新（伪歌单在列表里随每次上传置顶）。
// 缺口并发由 UNIQUE(netease_playlist_id) 兜底收敛
function ensureUploadsPlaylist() {
  const existing = playlistsRepo.findPlaylistByNeteaseId(UPLOADS_PLAYLIST_ID);
  if (existing) return existing;
  return playlistsRepo.upsertPlaylist({
    neteasePlaylistId: UPLOADS_PLAYLIST_ID,
    name: '本地上传',
    coverImgUrl: '',
    creatorNickname: '我',
    trackCount: 0,
    source: 'local',
  });
}

// 请求体流 → .part → rename 就位（与 streamToFile 同款的半成品隔离语义：
// 中途断开/超限留 .part 残片—— uploads/ 不在 reapOrphanFiles 收割视野
//（只扫数字名目录），残片由 catch 自收 + 启动清扫兜底之外自担）
async function streamRequestBody(c, outputPath, maxBytes) {
  const declared = Number(c.req.header('content-length') || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw httpError(413, `文件超过大小上限 ${Math.round(maxBytes / 1024 / 1024)}MB`);
  }
  const body = c.req.raw.body;
  if (!body || typeof body.getReader !== 'function') {
    throw httpError(400, '缺少请求体');
  }
  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  } catch (e) {
    throw e?.code === 'ENOSPC' ? httpError(507, '磁盘空间不足') : e;
  }
  // 磁盘余量预检：声明长度 > 可用空间直接 507——不写到一半才 ENOSPC 白烧带宽
  //（ENOSPC 仍由写路径兜底；statfs 不可用的平台跳过这道闸）
  try {
    if (declared > 0) {
      const st = fs.statfsSync(path.dirname(outputPath));
      if (st.bavail * st.bsize < declared) throw httpError(507, '磁盘空间不足');
    }
  } catch (e) { if (e?.status) throw e; /* statfs 不可用的平台跳过 */ }
  // .part 名带随机段：同 songId 并发/重试不共享残片（inflight 锁已挡并发，
  // 随机段是纵深——锁失效路径下也不互相 truncate）
  const partPath = `${outputPath}.${crypto.randomBytes(4).toString('hex')}.part`;
  const ws = fs.createWriteStream(partPath);
  // ws 'error' 全程要有人接：无监听时 ENOSPC/EIO 直接 uncaughtException 杀进程。
  // 必须用 on 不用 once——对已 error/destroy 的流再 write/end 会再发 'error'，
  // once 摘除后第二次 error 无监听照样杀进程。errP settle 后再 reject 是 no-op，
  // 监听器常驻只为吸收迟到 error（download-io.js 的 error noop sink 同族先例）
  const errP = new Promise((_, reject) => ws.on('error', reject));
  const reader = body.getReader();
  let total = 0;
  const cleanup = async () => {
    ws.destroy();
    // destroy 先于挂起的 fs.open 完成时，open 会迟到落地把路径重新建出来
    //（先 rm 再重建 = 漏收孤儿 .part——大单 chunk 首片即超限时正撞此窗）。
    // 等 'close'（fd 真正关闭，此后不再有重建源）再删才闭环；5s 上限防
    // open 病态挂死拖住请求——超时后漏收的残片由启动期 reapUploadPartFiles 兜
    if (!ws.closed) {
      await Promise.race([
        new Promise(r => ws.once('close', r)),
        new Promise(r => { const t = setTimeout(r, 5000); t.unref?.(); }),
      ]);
    }
    try { fs.rmSync(partPath, { force: true }); } catch { /* Windows 句柄未释兜底 */ }
  };
  // 停滞看门狗（watchStall 同族）：限流管次数不管字节——慢速攻击每 <stall 发
  // 1 字节即可长期占满 MAX_INFLIGHT 工位，合法上传全 429。destroy 触发 error
  // → errP 冒泡成 408，与断流同路径清理。
  // 总量硬顶：只判「距上片」不够——滴流每 <60s 发 1 字节就能无限刷新停滞计
  // 时（watchStall 的 maxTotalMs 同款防御）。30min 对应 2GB 视频 1.1MB/s 下限
  const STALL_MS = 60000;
  const MAX_TOTAL_MS = 30 * 60 * 1000;
  const startedAt = Date.now();
  let lastChunkAt = startedAt;
  const stallTimer = setInterval(() => {
    const now = Date.now();
    if (now - lastChunkAt <= STALL_MS && now - startedAt <= MAX_TOTAL_MS) return;
    Promise.resolve(reader.cancel()).catch(() => { /* cancel 拒绝无害 */ });
    ws.destroy(httpError(408, '上传停滞/超时'));
  }, 5000);
  stallTimer.unref();
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), errP]);
      if (done) break;
      lastChunkAt = Date.now();
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* 忽略 */ }
        throw httpError(413, `文件超过大小上限 ${Math.round(maxBytes / 1024 / 1024)}MB`);
      }
      // 背压：write 返回 false 时等 drain 再读下一片；errP 竞速防 ws error 卡死
      if (!ws.write(Buffer.from(value))) {
        await Promise.race([new Promise(r => ws.once('drain', r)), errP]);
      }
    }
    // end 也要竞速——finish/error 都可能先到
    await Promise.race([
      new Promise((resolve, reject) => ws.end(err => err ? reject(err) : resolve())),
      errP,
    ]);
  } catch (err) {
    await cleanup();
    try { await reader.cancel(); } catch { /* 忽略 */ }
    throw err?.code === 'ENOSPC' ? httpError(507, '磁盘空间不足') : err;
  } finally {
    clearInterval(stallTimer);
    reader.releaseLock?.();
  }
  if (total === 0) {
    await cleanup();
    throw httpError(400, '空文件');
  }
  try {
    fs.renameSync(partPath, outputPath);
  } catch (err) {
    await cleanup();
    throw err?.code === 'ENOSPC' ? httpError(507, '磁盘空间不足') : err;
  }
  return total;
}

// POST /uploads?kind=audio|video|cover|lyrics&songId=<file_*?>&filename=<原名>
// 同 songId 复传同 kind = 换源：旧路径文件清掉再登记新路径（换扩展名不留孤儿）
app.post('/uploads', async (c) => {
  try {
    // 停机窗：10s 强推窗口内的在途上传会被截成 .part 孤儿（downloads 系同闸）
    if (downloadManager.isShuttingDown?.()) return fail(c, 503, '服务正在停机，请稍后再试');
    if (!rateLimit(c, 'uploads', 20)) {
      return fail(c, 429, '上传过于频繁，请稍后再试');
    }
    const kind = String(c.req.query('kind') || '');
    const def = KIND_DEFS[kind];
    if (!def) return fail(c, 400, 'kind 必须是 audio|video|cover|lyrics');

    // 扩展名先抽再截：先 slice(0,240) 会把 >240 字符名尾部的 .mp3 砍掉，
    // 报「（无扩展名）」把有扩展名的合法文件拒了
    const filename = String(c.req.query('filename') || '');
    const ext = (filename.match(/\.([0-9A-Za-z]{1,8})$/)?.[1] || '').toLowerCase();
    if (!def.exts.has(ext)) {
      return fail(c, 400, `不支持的文件类型 ${ext ? `.${ext}` : '（无扩展名）'}（${kind} 允许：${[...def.exts].join('/')}）`);
    }

    let songId = String(c.req.query('songId') || '');
    if (songId && !FILE_TRACK_ID_RE.test(songId)) {
      return fail(c, 400, '非法 songId');
    }
    if (!songId) songId = newFileSongId();

    // 在飞互斥：同 songId 并发（双击/重试/多端）会共享 .part 交错写、
    // 撞 UNIQUE 且负者留未登记孤儿文件——直接 409 拒绝后来者
    if (inflightUploads.has(songId)) return fail(c, 409, '该曲目有上传正在进行');
    if (inflightUploads.size >= MAX_INFLIGHT) return fail(c, 429, '并发上传已满，请稍后再试');
    inflightUploads.add(songId);
    try {
      return await handleUpload(c, { kind, def, ext, filename, songId });
    } finally {
      inflightUploads.delete(songId);
    }
  } catch (error) {
    return handleError(c, error, '上传失败');
  }
});

async function handleUpload(c, { kind, def, ext, filename, songId }) {
  // 伪歌单墓碑窗：整个歌单被级联删除期间 upsert 会复活行、登记撞 FK——先拒
  if (isNeteasePlaylistDeleting(UPLOADS_PLAYLIST_ID)) {
    throw httpError(409, '上传区正在清理中，请稍后再试');
  }
  const pl = ensureUploadsPlaylist();
  if (deletingPlaylists.has(pl.id)) throw httpError(409, '上传区正在清理中，请稍后再试');
  const outputPath = path.join(uploadsDir(kind), `${songId}.${ext}`);
  // 纵深：构造路径必须在下载根下（songId 过了正则白名单但仍不放宽闸）
  if (!isUnderDownloadDir(outputPath)) return fail(c, 400, '非法落盘路径');

  // 同 songId 的既有行一律接管（不限 completed——残留 failed/pending 行
  // 也会让 createTask 撞 UNIQUE(playlist_id, song_id)）。唯一索引直查，
  // 不扫全表
  const existing = downloadTasksRepo.findAnyTaskByPlaylistAndSongId(pl.id, songId);

  const size = await streamRequestBody(c, outputPath, def.maxBytes);

  // 登记前复查删除窗：流式写盘可能跑了几十秒，窗口内伪歌单行若被级联
  // 删掉，登记会撞 FK / 行目标漂移——新文件就地回收不登记
  const alive = playlistsRepo.findPlaylistByNeteaseId(UPLOADS_PLAYLIST_ID);
  if (!alive || deletingPlaylists.has(alive.id)) {
    fs.rmSync(outputPath, { force: true });
    throw httpError(409, '上传区正在清理中，请稍后再试');
  }

  // 新文件就位后再清旧资产：同 kind 换扩展名（.mp3→.flac）会留孤儿；
  // 删在写后——写失败时旧文件与旧登记行都还是活的有效状态
  const oldPath = existing?.[KIND_PATH_COL[kind]];
  if (oldPath && oldPath !== outputPath && isUnderDownloadDir(oldPath) && fs.existsSync(oldPath)) {
    fs.rmSync(oldPath, { force: true });
  }

  const displayName = filename.slice(0, 240).replace(/\.[0-9A-Za-z]{1,8}$/, '') || songId;
  // 曲名/原始文件名/fileSize 只随媒体工件更新——后传的封面/歌词不该把
  // 显示名覆盖成封面文件名、把行 fileSize 从 500MB mp3 降成 4KB lrc
  const isMediaKind = kind === 'audio' || kind === 'video';
  // 登记段统一兜底：任何失败（撞 UNIQUE/行被并发 DELETE 抹掉/DB IO 错）新文件
  // 都回收——uploads/ 不在 reapOrphanFiles 视野，漏回收 = 永久孤儿。
  // 有损边角：同扩展名换源时旧文件已被 rename 覆盖，登记失败删新文件后行
  // 还在但 filesIntact=false——前端重新露出上传入口，属可自愈方向
  try {
    if (existing) {
      const updated = downloadTasksRepo.updateTask(existing.id, {
        [KIND_PATH_COL[kind]]: outputPath,
        [KIND_DL_FIELD[kind]]: true,
        // 接管的不一定是 completed 行（failed/pending 残留也走这路）——不复位
        // status 会留「文件在盘+flag 置位但 status=failed」的幻影，file 端点
        // 按 status==='completed' 查直接 404
        status: 'completed',
        progress: 100,
        errorMessage: null,
        completedAt: new Date().toISOString(),
        ...(isMediaKind ? { fileSize: size, songName: displayName } : {}),
        providerData: { ...(existing.providerData || {}), upload: true, ...(isMediaKind ? { originalName: filename.slice(0, 240) } : {}) },
      });
      // 行在写盘窗口内被并发 DELETE 抹掉：updateTask 对不存在行静默 0 行——
      // 不校验就 200 假成功+隐形孤儿（外层 catch 统一回收新文件）
      if (!updated) throw httpError(409, '曲目登记行已不存在，请重试');
    } else {
      let task;
      try {
        task = downloadTasksRepo.createTask({
          playlistId: alive.id,
          songId,
          songName: displayName,
          artist: '',
          album: null,
          coverUrl: null,
          status: 'completed',
          progress: 100,
          durationMs: 0,
          // 资产就位标记：对应 kind 的 download_* 列=1 使行语义=「该工件已在盘」
          downloadAudio: kind === 'audio',
          downloadVideo: kind === 'video',
          downloadCover: kind === 'cover',
          downloadLyrics: kind === 'lyrics',
          providerData: { upload: true, originalName: filename.slice(0, 240) },
        });
      } catch (e) {
        // UNIQUE 撞行（窗口内并发插入/墓碑行残留）：回收新文件回落接管
        if (!/UNIQUE/i.test(e.message || '')) throw e;
        throw httpError(409, '曲目登记冲突，请重试');
      }
      // stamp 与 createTask 同步相邻——今天撞不上删行窗；仍校验固化不变量
      //（一旦中间插入 await，行窗口消失假 200 就会复活）
      const stamped = downloadTasksRepo.updateTask(task.id, { [KIND_PATH_COL[kind]]: outputPath, fileSize: size });
      if (!stamped) throw httpError(409, '曲目登记行已不存在，请重试');
    }
  } catch (e) {
    fs.rmSync(outputPath, { force: true });
    throw e;
  }

  // 不透出服务器绝对路径（toPublicTask 相对化同口径）——客户端只消费 songId。
  // 包封走仓惯例 {code, data:{...}}
  return c.json({ code: 200, data: { songId, kind, size } });
}

// DELETE /uploads/:songId —— 删登记行 + 全部资产文件（复用删除语义：
// 行先删文件后删，孤儿留清扫兜底）
app.delete('/uploads/:songId', async (c) => {
  try {
    if (!rateLimit(c, 'uploads-del', 30)) return fail(c, 429, '操作过于频繁');
    const songId = c.req.param('songId');
    if (!FILE_TRACK_ID_RE.test(songId)) return fail(c, 400, '非法 songId');
    if (inflightUploads.has(songId)) return fail(c, 409, '该曲目有上传正在进行');
    await downloadManager.deleteSongFiles(UPLOADS_PLAYLIST_ID, songId);
    return c.json({ code: 200, data: { songId, deleted: true } });
  } catch (error) {
    return handleError(c, error, '删除上传文件失败');
  }
});

module.exports = app;

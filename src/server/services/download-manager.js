const path = require('path');
const fs = require('fs');
const downloadTasksRepo = require('../repositories/downloadTasks');
const downloadQueuesRepo = require('../repositories/downloadQueues');
const playlistTracksRepo = require('../repositories/playlistTracks');
const playlistsRepo = require('../repositories/playlists');
const { importPlaylistFromNetease } = require('./playlist-sync');
const fileDownloader = require('./file-downloader');
const { getDb } = require('../db/client');
const { httpError } = require('../lib/http-error');
const { FILE_TRACK_ID_RE, NETEASE_ID_RE } = require('../../shared/predicates.js');
const { deletingPlaylists, deletingQueues, deletingNeteasePlaylists, isNeteasePlaylistDeleting, markNeteasePlaylistDeleted } = require('../lib/deletion-locks');
// 路径/fs/纯计算助手已抽到 download-fs.js（DOWNLOAD_BASE_DIR 唯一来源也在那）
const {
  DOWNLOAD_BASE_DIR, isExternalSongId, durationLooksTruncated,
  drainWithTimeout, DRAIN_TIMEOUT_MS, providerDataOf, retryDelayMs,
  isUnderDownloadDir, sanitizeErrorMessage, toPublicTask, deleteFiles,
  taskFilesIntact, taskLockKeys, pathPresent,
} = require('./download-fs');

// 运行中队列的控制器集合：queueId -> { paused, cancelled, abort, done }
// done = processQueue 协程的 settle promise：删除/停机时先 abort 再 await done 排空在途任务，
// 否则"任务行已删但流还在写"会产生永远无人认领的孤儿文件
const activeQueues = new Map();
// 在途文件写入锁：同一目标路径只允许一个下载（歌单重复入队/并发单曲防交叉写坏文件）
const activePaths = new Set();
// 独立单曲任务的在跑集合：taskId -> { abort, done }。并发重复点击不得并发跑同一行；
// abort/done 让停机与歌单删除能中止并排空 standalone 下载（原先 null signal 完全不可中止）
const standaloneRunning = new Map();
// 已 cancel 但协程仍在排空收尾的控制器：deleteQueue/deletePlaylistFiles/shutdownAll
// 必须连它们一起排空——否则 cancel 后立即 delete 会跳过排空，"删后落盘"留孤儿文件
const drainingQueues = new Map();
// 超时兜底把 draining 条目提前释放后，协程本身可能还在跑（卡在不可中止阶段）——
// 从两个 Map 中消失即"僵尸"：没有任何机制能再定位它在途的流，删除/停机排空
// 都会漏掉它。timeout 释放时入列追踪，done settle 时出列。
// 注意不并入 drainingQueues：Map<queueId,controller> 单值结构放不下同一队列的
// 多个旧协程（cancel→start→cancel→delete 边沿），Set 才够
const zombieControllers = new Set();
// "队列是否有活着的协程"的唯一判据：DB status 不可信（cancelled 行可能仍在排空/
// 僵尸）。所有调度/删除/收养决策走这一个入口，禁止复制三 Map 表达式
function queueHasLiveController(queueId) {
  if (activeQueues.has(queueId) || drainingQueues.has(queueId)) return true;
  for (const z of zombieControllers) if (z.queueId === queueId) return true;
  return false;
}
// deletingPlaylists/deletingQueues 来自 lib/deletion-locks（共享给 playlist-sync
// 的刷新路径用——直接 import 本模块会成环）
// 停机期间拒绝新建/启动下载，避免半途任务留下脏状态
let shuttingDown = false;

// 可重试失败的下次派发时刻：taskId -> epochMs。瞬时错误（网络抖动/429/5xx）
// 立即重捞等于全速空转打上游；指数退避让任务在 pending 里"等待"而不被派发。
// 进程内状态即可——重启后天然清表，正好立即重试。
// 行删除路径（deleteTask/deleteQueue/deleteSongFiles/级联）都在提交后清对应条目；
// 漏网条目也无害：taskId 是 AUTOINCREMENT 不复用，到期自然失效，另有 >1024 惰性清扫兜底
const retryAfter = new Map();




// 仅查本地、绝不触发远端导入：GET/DELETE 等读/删操作不允许产生写副作用
function findExistingPlaylistId(playlistId) {
  if (playlistId === undefined || playlistId === null) return null;
  const str = String(playlistId).trim();
  if (!str) return null;
  const numericId = Number(str);
  if (Number.isInteger(numericId)) {
    const byLocalId = playlistsRepo.findPlaylistById(numericId);
    if (byLocalId) return byLocalId.id;
  }
  // 与 resolvePlaylistId 同一前导零归一化：'000123' 命中已存 '123' 行，
  // 不为等价 id 多烧一次上游往返
  const byNeteaseId = playlistsRepo.findPlaylistByNeteaseId(
    str.replace(/^0+(?=\d)/, '')
  );
  return byNeteaseId ? byNeteaseId.id : null;
}

// 写操作（创建队列/下载单曲）专用：本地未命中时尝试从网易云导入
async function resolvePlaylistId(playlistId) {
  const localId = findExistingPlaylistId(playlistId);
  if (localId !== null) return localId;
  const str = String(playlistId ?? '').trim().replace(/^0+(?=\d)/, ''); // 前导零归一化
  // 上游导入只认纯数字 id——非数字输入必然 404/502，前置拦掉这次无效往返；
  // 长度上限防超长数字串被拼进上游 URL
  if (!/^\d{1,20}$/.test(str)) {
    throw httpError(400, '无效的歌单 ID');
  }
  // 墓碑快速失败：导入事务内的复查能兜底正确性，这里省掉一次最长
  // ~120s 的上游往返才发现该歌单正在删除
  if (isNeteasePlaylistDeleting(str)) {
    throw httpError(409, '该歌单正在删除中');
  }
  const imported = await importPlaylistFromNetease(str);
  if (imported?.id) {
    return imported.id;
  }
  throw httpError(404, '歌单不存在');
}

// 防路径逃逸：任务记录的文件路径来自 DB，只允许删除 DOWNLOAD_BASE_DIR 内的文件
// 用 path.relative 判断逃逸（".." 开头或在盘外即越界），比字符串前缀更稳




async function createDownloadQueue(playlistId, options = {}) {
  if (shuttingDown) {
    throw httpError(409, '服务正在停机');
  }

  const resolvedPlaylistId = await resolvePlaylistId(playlistId);
  // await 上游导入窗口内可能开始停机/级联删除——两项都要复查
  if (shuttingDown) {
    throw httpError(409, '服务正在停机');
  }
  if (deletingPlaylists.has(resolvedPlaylistId)) {
    throw httpError(409, '该歌单正在删除中');
  }
  const playlist = playlistsRepo.findPlaylistById(resolvedPlaylistId);
  if (!playlist) {
    throw httpError(404, '歌单不存在');
  }

  const tracks = playlistTracksRepo.listTracksByPlaylistId(resolvedPlaylistId);
  if (tracks.length === 0) {
    throw httpError(400, '歌单中没有歌曲');
  }

  // 同歌单已有 pending/running/paused 队列时拒绝再建——重复队列会并发写同一批文件
  const siblings = downloadQueuesRepo.listQueues().filter(
    q => q.playlistId === resolvedPlaylistId
  );
  const active = siblings.find(q => ['pending', 'running', 'paused'].includes(q.status));
  if (active) {
    throw httpError(409, `该歌单已有进行中的下载队列 (#${active.id})`);
  }

  // 终态队列原地复活而非另立新行：收养逻辑本就把它掏空，再建行的结果是
  // "队列列表里同名歌单成对出现"（旧壳 + 新队）。复用最新一行——队列 id 稳定、
  // 任务行经收养/复位回收、计数在末尾重算。
  // 选 id 最大的未锁定终态行：活体控制器/删除窗口下的行不可复活（协程的
  // abort-reset 会把"已取消"写回刚复位的任务行——与收养段 ownerBusy 同源）；
  // 最新行被锁时降级到更旧的干净行，全部锁定才 409
  const reusable = siblings
    .slice()
    .sort((a, b) => b.id - a.id)
    .find(q => !queueHasLiveController(q.id) && !deletingQueues.has(q.id)) || null;
  if (!reusable && siblings.length) {
    throw httpError(409, '该歌单有下载任务仍在收尾，请稍后再试');
  }

  // 队列行 + 全部任务行在同一个事务里写入：半途抛错不留"有队列没任务"的脏数据
  const db = getDb();
  // 完整性 stat 预热放在事务外：txn 内跑文件 I/O 会把 SQLite 写锁摁在整个
  // stat 风暴上（挂载卷每个 stat 一个 RTT）。TTL 缓存让 txn 内同款调用全部
  // 命中——预热与事务在同一同步段，无并发窗口使缓存过期失真。
  // 补视频判定要看的 videoPath 盘上存在性同口径预热进 Map——它没有 TTL
  // 缓存可蹭，txn 内逐行 stat 等于把风暴搬进写锁。queue.downloadVideo 此刻
  // 未落成，但恒等于 options.downloadVideo === true，预热判据直接用它
  const videoPathOnDisk = new Map(); // taskId -> 登记视频档的盘上存在性
  for (const track of tracks) {
    const songId = String(track.id);
    const existing = downloadTasksRepo.findAnyTaskByPlaylistAndSongId(
      resolvedPlaylistId, songId);
    if (existing && existing.status === 'completed') taskFilesIntact(existing);
    if (existing && options.downloadVideo === true
        && isExternalSongId(songId) && existing.videoPath) {
      videoPathOnDisk.set(existing.id, pathPresent(existing.videoPath));
    }
  }
  const oldOwnerQueueIds = new Set(); // 收养搬走任务后待回调计数的旧属主队列
  const adoptedPaths = []; // 收养重置清掉的旧文件路径——提交后才删（txn 内 unlink 会留回滚窗口）
  const adoptedTaskIds = [];
  const createWithTasks = db.transaction(() => {
    // 复活路径：回写名称/选项/状态而不新建行——queueId 保持稳定
    const queue = reusable
      ? downloadQueuesRepo.updateQueue(reusable.id, {
        name: playlist.name,
        status: 'pending',
        completedAt: null,
        createdAt: new Date().toISOString(),
        bitrate: options.bitrate || 320000,
        downloadAudio: options.downloadAudio !== false,
        downloadLyrics: options.downloadLyrics !== false,
        downloadCover: options.downloadCover !== false,
        downloadVideo: options.downloadVideo === true,
        concurrentLimit: options.concurrentLimit || 3
      })
      : downloadQueuesRepo.createQueue({
        playlistId: resolvedPlaylistId,
        name: playlist.name,
        totalTasks: 0,
        bitrate: options.bitrate || 320000,
        downloadAudio: options.downloadAudio !== false,
        downloadLyrics: options.downloadLyrics !== false,
        downloadCover: options.downloadCover !== false,
        downloadVideo: options.downloadVideo === true,
        concurrentLimit: options.concurrentLimit || 3
      });

    // 歌单内可能重复含同一首歌：按 songId 去重；计数在末尾由任务行重算
    const seen = new Set();
    for (const track of tracks) {
      const songId = String(track.id);
      if (seen.has(songId)) continue;
      seen.add(songId);

      // (playlist_id, song_id) 有唯一约束：standalone 单曲任务、以及归属
      // "已完结"旧队列（completed/cancelled/failed）的任务收养进本队列——
      // completed 计入完成数，failed/pending 重置重跑。仍属活跃队列的任务跳过：
      // 旧队列还在调度该歌，不在本队列重复计
      const existing = downloadTasksRepo.findAnyTaskByPlaylistAndSongId(resolvedPlaylistId, songId);
      if (existing) {
        // 内存态在跑的 standalone 收养会造成队列/单曲协程互踢路径锁——跳过，留给
        // 原执行者跑完。只看 standaloneRunning：DB 里 status='downloading' 但不在
        // map 里的是崩溃/异常残留的孤儿行，收养重置才是自愈路径
        const standaloneActive = standaloneRunning.has(existing.id);
        const owner = existing.queueId
          ? downloadQueuesRepo.findQueueById(existing.queueId)
          : null;
        // 内存控制器才是真判据：cancelled 队列的协程可能还在 draining/僵尸集里
        // 跑（不可中止上游调用超 DRAIN_TIMEOUT）——此时收养会让新旧协程对同一
        // 批行双调度，僵尸的 abort 复位还会把"已取消"写进新队列的行
        const ownerBusy = existing.queueId != null
          && queueHasLiveController(existing.queueId);
        // 属主队列行已终态但协程仍活着（draining/僵尸）：跳过收养会让新队列
        // 静默缺歌——宁可 409 让调用方等收尾后重建
        if (ownerBusy) {
          throw httpError(409, '该歌单有下载任务仍在收尾，请稍后再试');
        }
        // 属主正在删除中同样不可收养——否则"删队列=删其文件"的语义被悄悄改成
        // "文件随任务搬去新队列"，DELETE 调用方预期落空
        if (existing.queueId != null && deletingQueues.has(existing.queueId)) {
          throw httpError(409, '该歌单有队列正在删除中，请稍后再试');
        }
        // owner 为 null = queue_id 指向已消失队列的孤儿行，同样收养；
        // owner 即本次复活的队列自身时也按收养处理——其行上的任务正是要
        // keepCompleted 保留 / reset 重跑的对象，跳过会让失败任务永久滞留
        const ownerActive = owner && owner.id !== queue.id
          && ['pending', 'running', 'paused'].includes(owner.status);
        if (!standaloneActive && (existing.queueId == null || !ownerActive)) {
          // completed 但文件已被外部删掉的行是幻影——按未完成收养重跑补回
          const keepCompleted = existing.status === 'completed' && taskFilesIntact(existing);
          // 队列级补视频：完好完成行在 downloadVideo 队列里缺视频档时翻
          // pending——与 standalone 补视频分支（~1516/~1618）同语义；audioPath 等
          // 保留，相位按 existsSync 幂等跳过已落盘段，只跑视频相位。
          // videoPath「登记位+盘上存在」双查而不只看登记位：intactCache 的
          // TTL 快照还热着时登记档刚被外删，应按缺失判交幂等相位补回。
          // 存在性读事务外预热表不真打盘（与事务同一同步段所填，无并发
          // 窗口）；表意外缺键回落真 stat 保正确性，宁多一次 stat 不误判幻影
          const needsVideoBackfill = keepCompleted
            && queue.downloadVideo && isExternalSongId(songId)
            && !(existing.videoPath && (videoPathOnDisk.has(existing.id)
              ? videoPathOnDisk.get(existing.id)
              : pathPresent(existing.videoPath)));
          // 重置重跑的任务同步新队列的下载选项——否则按旧行开关/码率跑，
          // "completed" 的歌可能实际没有音频/封面；旧路径字段一并清掉：
          // 残留的路径可能已指向别的任务的文件，后续删除会按它误删
          downloadTasksRepo.updateTask(existing.id, keepCompleted && !needsVideoBackfill
            ? {
              queueId: queue.id,
              status: 'completed',
              progress: existing.progress,
              errorMessage: null,
              retryCount: 0
            }
            : needsVideoBackfill
              ? {
                // 只置 downloadVideo 位：audioPath/lyricsPath/coverPath 与各
                // 相位 flag 一律不动（standalone 同口径只设 video）——文件在
                // 盘上，分段幂等自然只跑视频相位
                queueId: queue.id,
                status: 'pending',
                progress: 0,
                errorMessage: null,
                completedAt: null,
                downloadVideo: true,
                // retryCount 相位级预算归零——老行若在音频相位打满 3 次，
                // 补视频首个瞬态错误就直接判死（standalone 同口径）
                retryCount: 0,
                providerData: providerDataOf(track)
              }
              : resetTaskFields({
                queueId: queue.id,
                bitrate: queue.bitrate,
                downloadAudio: queue.downloadAudio,
                downloadLyrics: queue.downloadLyrics,
                downloadCover: queue.downloadCover,
                downloadVideo: queue.downloadVideo && isExternalSongId(songId),
                // providerData 同步最新镜像行：title/author/neteaseId 会变
                // （改题、词源重匹配），收养重跑不该拿建行时的旧快照
                providerData: providerDataOf(track)
              }));
          // 重跑前清路径同时也要清旧文件：行先清、文件后删（崩溃留孤儿文件
          // 由 reap 兜底，比幻影登记路径安全）。扩展名现已随源浮动，不删会
          // 让不同扩展名的旧文件以未登记状态无限期滞留。文件 unlink 收集后
          // 推迟到事务提交——txn 内删文件遇回滚会留"路径还在但文件没了"
          // keepCompleted 行也要进 adoptedTaskIds——陈旧 retryAfter 条目得清，
          // 否则日后复位重跑会白等最长 30s 退避
          adoptedTaskIds.push(existing.id);
          if (!keepCompleted) {
            adoptedPaths.push(existing.audioPath, existing.lyricsPath, existing.coverPath, existing.videoPath);
          }
          // 旧属主队列的计数器虚高（任务被搬走后不再重算）——记录待回调；
          // 属主即本队列时不记：末尾 recountQueueCounters(queue.id) 已覆盖
          if (existing.queueId && existing.queueId !== queue.id) {
            oldOwnerQueueIds.add(existing.queueId);
          }
        }
        continue;
      }

      const artists = track.ar || track.artists || [];
      const album = track.al || track.album || {};
      const artistName = artists.filter(Boolean).map(a => a.name).join(', ') || '未知艺术家';
      const albumName = album.name || '未知专辑';
      const coverUrl = album.picUrl || album.pic_str || null;

      downloadTasksRepo.createTask({
        playlistId: resolvedPlaylistId,
        queueId: queue.id,
        songId,
        songName: track.name,
        artist: artistName,
        album: albumName,
        coverUrl,
        bitrate: queue.bitrate,
        providerData: providerDataOf(track),
        durationMs: track.dt || track.duration || 0,
        downloadAudio: queue.downloadAudio,
        downloadLyrics: queue.downloadLyrics,
        downloadCover: queue.downloadCover,
        // 视频工件只对 bv_/yt_ 存在——网易云/QQ 任务带位也是空转，入队即裁
        downloadVideo: Boolean(queue.downloadVideo) && isExternalSongId(songId)
      });
    }

    // 计数从任务行状态派生：收养的 completed 任务自动计入完成数，
    // 手工记数会让"跳过活跃属主"等分支漏配漂移
    recountQueueCounters(queue.id);
    return downloadQueuesRepo.findQueueById(queue.id);
  });

  const created = createWithTasks();
  // 事务提交后才动文件与内存态：收养即时入队——陈旧退避不该拖住新队列
  for (const id of adoptedTaskIds) retryAfter.delete(id);
  deleteFiles(adoptedPaths);
  // 事务提交后回调旧属主计数：死队列不会自己走收尾重算，不重算则永久虚高
  for (const qid of oldOwnerQueueIds) {
    recountQueueCounters(qid);
  }
  // 收养掏空的其他终态壳行顺手清掉——文件随任务行走，0 任务的壳删除无文件副作用；
  // 任务未被收养完（属主活跃跳过等）的壳保留，等下轮调用自愈
  for (const shell of siblings) {
    if (shell.id === created.id) continue;
    if (queueHasLiveController(shell.id) || deletingQueues.has(shell.id)) continue;
    if (downloadTasksRepo.listTasksByQueue(shell.id).length === 0) {
      try { downloadQueuesRepo.deleteQueue(shell.id); } catch { /* 壳已消失 */ }
    }
  }
  // 透出复用标记：前端据此区分"新建队列"与"复活旧队列"的提示文案
  if (reusable) created.reused = true;
  return created;
}

async function startQueue(queueId) {
  if (shuttingDown) {
    throw httpError(409, '服务正在停机');
  }

  const queue = downloadQueuesRepo.findQueueById(queueId);
  if (!queue) {
    throw httpError(404, '队列不存在');
  }

  if (activeQueues.has(queueId)) {
    throw httpError(409, '队列已在运行中');
  }
  // 旧控制器还在排空（cancel 后的收尾窗口）或排空超时仍在跑（僵尸集）——
  // 此时 start 会让新旧协程对同一批任务双重调度，deleteQueue 的排空语义
  // 也被破坏。路径锁能串行化文件写，但零锁键任务（只要封面且无 coverUrl）
  // 无任何互斥。active/draining/zombie 三态合一判定走 queueHasLiveController
  if (queueHasLiveController(queueId)) {
    throw httpError(409, '队列正在收尾，请稍后再试');
  }
  // 队列删除窗口内不许起新协程：行删后协程还在跑会成为永久失联的孤儿
  if (deletingQueues.has(queueId)) {
    throw httpError(409, '队列正在删除中');
  }
  // 歌单删除窗口内不许起新协程：行级联删除后在途流会继续写孤儿文件
  if (deletingPlaylists.has(queue.playlistId)) {
    throw httpError(409, '该歌单正在删除中');
  }

  // failed/completed 队列没有可跑行时拒绝启动——直接启动会走正常收尾把
  // failed 覆写成 completed，失败痕迹被掩盖（重试应走 /retry 接口）。
  // 例外：终态下仍残留 pending/downloading 行（崩溃漂移/状态迁移写失败
  // 钉死的行——新协程收尾会先把无主 downloading 行收敛回 pending）——
  // 不放行它们就永远没有任何重启入口
  if (queue.status === 'failed' || queue.status === 'completed') {
    const hasRunnable = downloadTasksRepo.listTasksByQueue(queueId)
      .some(t => t.status === 'pending' || t.status === 'downloading');
    if (!hasRunnable) {
      throw httpError(409, '队列已完结，请使用重试接口');
    }
  }

  // 复活 failed/completed 队列时清 completedAt——否则中途再 cancel 会落
  // 「cancelled + 陈旧 completed_at」的展示漂移
  downloadQueuesRepo.updateQueue(queueId, { status: 'running', completedAt: null });

  // ⚠️ 检查→登记段（上方各 409 到此行）必须全程无 await——单协程不变量
  // 靠「has/liveController 检查与 activeQueues.set 同事件循环原子」成立，
  // 任何 await 都会开窗让第二协程启动，双闭包 inflightTaskIds 互判 stranded
  const controller = {
    queueId,
    playlistId: queue.playlistId,
    paused: false,
    cancelled: false,
    abort: new AbortController(),
    done: null,
    settled: false
  };
  activeQueues.set(queueId, controller);

  // done 供 deleteQueue/deletePlaylistFiles/shutdownAll 排空等待：
  // abort 之后必须等在途 processTask 全部收尾（含路径记录、removePartial），
  // 再做文件清扫，否则"删后落盘"留下孤儿文件
  controller.done = processQueue(queueId, controller).catch(error => {
    console.error(`队列 ${queueId} 处理失败:`, error);
    try {
      // 并发 cancel 的终态不许被崩溃路径覆盖——cancelled 优先于 failed
      const row = downloadQueuesRepo.findQueueById(queueId);
      if (row && row.status !== 'cancelled') {
        // 终态必须与任务集合自洽：还有 pending/downloading 行时判 failed
        // 会永久搁浅它们（failed_tasks=0 时 retryQueue 拒收、startQueue 拒
        // 空终态）——回 pending 保留启动入口；downloading 行由下次协程
        // 收尾的收敛步骤复位重跑
        const rows = downloadTasksRepo.listTasksByQueue(queueId);
        const status = rows.some(t => t.status === 'pending' || t.status === 'downloading')
          ? 'pending'
          : rows.some(t => t.status === 'failed') ? 'failed' : 'completed';
        downloadQueuesRepo.updateQueue(queueId, { status });
      }
      recountQueueCounters(queueId); // 崩溃路径跳过了 processQueue 收尾，补一次重算
    } catch { /* 行可能已删 */ }
  }).finally(() => {
    controller.settled = true;
    zombieControllers.delete(controller); // 超时被入列的僵尸在这里回收
    // 僵尸协程可能在 timeout-release 的 recount 之后仍翻转了任务行（在途写
    // 的完成/失败落库晚于重算）——settle 时补一次幂等重算收掉这段漂移
    recountQueueCounters(queueId);
    if (activeQueues.get(queueId) === controller) {
      activeQueues.delete(queueId);
    }
  });

  return downloadQueuesRepo.findQueueById(queueId);
}

async function processQueue(queueId, controller) {
  const queue = downloadQueuesRepo.findQueueById(queueId);
  // 队列可能已被 DELETE 移除：控制器取消即可返回，避免对空行裸取字段
  if (!queue) {
    activeQueues.delete(queueId);
    return;
  }
  // 历史脏数据兜底：concurrent_limit 为 NULL 时 null>=n 恒真 → Promise.race([]) 死等
  const concurrentLimit = Number.isInteger(queue.concurrentLimit) && queue.concurrentLimit > 0
    ? queue.concurrentLimit
    : 3;
  const runningTasks = [];
  // 本协程派出的在途任务 id——「行是 downloading 但 id 不在此集合」即钉死行
  // （processTask 派发即翻 downloading，只有状态迁移写持续失败才留不住终态）。
  // 与 runningTasks 同步生灭，供收敛步骤区分"真在跑"与"钉死"
  const inflightTaskIds = new Set();
  // 路径锁 409 的延迟重试集合：持锁方（其他任务/standalone 下载）可能写几十秒，
  // 每轮立即重捞重试等于全速空转打 DB。记入 deferred 本轮跳过重试；
  // 任一在途任务 settle（说明有锁释放）或全卡死时 sleep 退避后清空重试。
  // since 记录首次延迟时间——锁泄漏/不可中止的卡死任务会让队列永远
  // 空转不收尾，超过上限按失败处理。
  // 等锁延迟任务表：taskId -> { since, keys }（三平行 Map 合一——同生同死，
  // 三处分别 delete 的写法既啰嗦又容易漏配）
  // - since：连续等锁的首次 409 时刻——派发前不得清：等锁空转每轮都会重捞
  //   重试撞 409，删了它时间戳永不可达。只有锁释放（放行重试）与硬顶判失败
  //   两条出路；行离开 pending 后条目由 expireDeferred 复查清理
  // - keys：409 时真实冲突的锁键——siblings 快照会漂移（兄弟任务删除后重算出
  //   的碰撞键会变），用重算的键判 activePaths 会把"锁已释放"误判成"仍持有"
  const deferred = new Map();
  // 硬顶：正常持锁有物理上限（解锁60s×2 + 取链30s + 流300s ≈ 460s），
  // 连续持锁超 15min 大概率是锁泄漏（activePaths 残留无人释放）——判失败收敛
  const DEFER_HARD_LIMIT_MS = 15 * 60 * 1000;
  const expireDeferred = () => {
    const now = Date.now();
    for (const [taskId, entry] of deferred) {
      const stillHeld = (entry.keys || []).some(k => activePaths.has(k));
      if (!stillHeld) {
        // 锁已释放：立即放行，下一轮自然重试——锁空闲时判失败是误杀
        deferred.delete(taskId);
        continue;
      }
      if (now - entry.since <= DEFER_HARD_LIMIT_MS) continue; // 持锁未到硬顶：继续等
      const row = downloadTasksRepo.findTaskById(taskId);
      deferred.delete(taskId);
      if (!row || row.status !== 'pending') continue; // 已离开等锁状态，纯清理
      try {
        downloadTasksRepo.updateTask(taskId, {
          status: 'failed',
          errorMessage: '等待文件写入锁超时'
        });
        recountQueueCounters(queueId);
      } catch { /* 任务行可能已被删 */ }
    }
  };
  // 「downloading 且无在途 promise」的行收敛：完成/失败/复位的状态迁移写在
  // DB 瞬时故障窗口内连续失败会把行钉在 downloading——pending 过滤看不见它、
  // 终态判定又把它当"还在跑"，队列会判成 completed 而它永无恢复入口。
  // retryCount 预算内复位 pending（分段幂等重跑补齐），耗尽判 failed；
  // 复位必须消耗预算——状态写持续失败时"复位→重下→再钉死"会无界循环打上游
  const convergeStrandedDownloading = () => {
    for (const row of downloadTasksRepo.listTasksByQueue(queueId)) {
      if (row.status !== 'downloading' || inflightTaskIds.has(row.id)) continue;
      try {
        downloadTasksRepo.updateTask(row.id, row.retryCount < 3
          ? { status: 'pending', retryCount: row.retryCount + 1, progress: 0, errorMessage: '下载中断，已复位待重跑' }
          : { status: 'failed', errorMessage: '下载中断' });
      } catch { /* 行可能已删 */ }
    }
  };
  // unref：race 输掉的退避/暂停 timer 不该拖住进程退出
  const sleep = (ms) => new Promise(resolve => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });

  const waitWhilePaused = async () => {
    // 取消在暂停等待中也要生效——否则 cancelled 队列的协程永久自旋。
    // 暂停期间 since 不能继续老化：暂停一夜后恢复，等锁时长里
    // 混进了冻结时间，硬顶会把全部等锁任务误杀——恢复时把时间戳整体后移
    let pausedAt = null;
    while (controller.paused && !controller.cancelled) {
      if (pausedAt === null) pausedAt = Date.now();
      await sleep(1000);
    }
    if (pausedAt !== null) {
      const frozenFor = Date.now() - pausedAt;
      for (const entry of deferred.values()) entry.since += frozenFor;
    }
  };

  // 每轮重新捞 pending：processTask 失败后会把 retryCount<3 的任务置回 pending，
  // 开头取一次快照的写法会让任务内重试永不发生；退出条件是"无 pending 且无在途"——
  // Promise.all 之后在途任务仍可能把失败任务复位 pending，不能捞完一轮就收尾
  while (true) {
    if (controller.cancelled) break;
    await waitWhilePaused();
    if (controller.cancelled) break;

    const pendingTasks = downloadTasksRepo.listTasksByQueue(queueId)
      .filter(t => t.status === 'pending' && !deferred.has(t.id)
        && !(retryAfter.get(t.id) > Date.now())); // 退避期任务按 pending 留行但不派发
    if (pendingTasks.length === 0) {
      if (runningTasks.length === 0) {
        expireDeferred();
        // 钉死的 downloading 行先收敛再判终态——复位 pending 的行下一轮
        // 自然重派，判 failed 的进终态计数
        convergeStrandedDownloading();
        // 收尾的唯一条件是"库里没有 pending 行"：expireDeferred 放行等锁任务的
        // 瞬间 deferred 会清空，但行仍是 pending 待派发——按 deferred.size 判断
        // 会提前 break，队列标 completed 而歌单缺歌（且无恢复入口：startQueue 拒
        // completed、retryQueue 要 failed）。反过来行已离开 pending 而 deferred
        // 残留（外部删行/改状态）也必须放行退出，不能空转
        const pendingRows = downloadTasksRepo.listTasksByQueue(queueId)
          .filter(t => t.status === 'pending');
        if (pendingRows.length === 0) break;
        // 剩余 pending 全部是退避中任务时睡到最近到期点（50ms–1s 钳位）——
        // 固定节拍忙轮询会在长退避窗内空扫几十次 listTasksByQueue
        const backoffAt = pendingRows.map(t => retryAfter.get(t.id) || 0)
          .filter(at => at > Date.now());
        if (backoffAt.length === pendingRows.length && backoffAt.length > 0) {
          await sleep(Math.min(Math.max(Math.min(...backoffAt) - Date.now(), 50), 1000));
          continue;
        }
        // 全部剩余任务都在等路径锁（或退避与等锁并存）：睡一轮再重试。
        // 忙轮询在长持锁/长退避窗口内空扫 DB——2s 探测粒度对锁释放与
        // 退避到期都足够快，且不死等（退避到期分支上一条已精确睡到点）
        // 不得 deferred.clear()——clear 会销毁 since 时间戳，锁泄漏场景下
        // 每轮重建即"全新冲突"，15min 硬顶永不可达；expireDeferred 已放行
        // 锁释放的条目，仍持锁的必须留住计时
        await sleep(2000);
        continue;
      }
      // 在途任务可能把失败任务复位 pending 或释放路径锁——等一个 settle 再重查。
      // race 加超时：在途任务全卡在不可中止的上游调用（解锁/取链无超时）时
      // race 永不返回，expireDeferred 会被饿死
      await Promise.race([...runningTasks, sleep(60000)]);
      expireDeferred(); // 锁已释放的条目放行；仍持锁的保留 since 继续老化
      continue;
    }

    for (const task of pendingTasks) {
      if (controller.cancelled) break;
      await waitWhilePaused();
      if (controller.cancelled) break;

      while (runningTasks.length >= concurrentLimit && !controller.cancelled) {
        // race 补超时兜底：在途全卡不可中止上游段时 expireDeferred 与循环
        // 会同步饿死（与上方空-pending 分支的 race+sleep 同一写法对齐）
        await Promise.race([...runningTasks, sleep(60000)]);
        // 容量满的等待期间 deferred 硬顶也在老化——与空-pending 分支对齐，
        // 否则硬顶判失败要拖到下次排到空快照轮才执行。不 clear：
        // expireDeferred 已放行锁释放的条目，持锁条目的 since 必须保住
        expireDeferred();
      }
      if (controller.cancelled) break;
      // 容量等待期间收到 pause：循环只看 cancelled，槽位一释放就会在暂停态
      // 漏派一个任务——派发前复查暂停态
      await waitWhilePaused();
      if (controller.cancelled) break;

      inflightTaskIds.add(task.id);
      const taskPromise = processTask(task, queueId, controller.abort.signal)
        .then(() => {
          // 正常收尾（含内部自吞的失败）：本轮等锁结束——清掉时间戳化石，
          // 否则下次全新冲突会继承旧 since，被硬顶无等待秒杀
          deferred.delete(task.id);
        })
        .catch(error => {
          // processTask 内部已自吞常规失败；走到这里的是 try 之前的早期抛错。
          // 路径锁冲突(409)是瞬时态（另一任务正在写同路径），任务保持 pending 留给下一轮重试，
          // 只有真正的启动失败才标 failed——否则会让 Promise.all 砸掉整个队列
          // 409 但无 lockKeys：锁冲突必然带命中键——空键集是未知 409 来源，
          // 当 deferred 会立即被 expireDeferred 放行→重派→再 409 空转死循环
          if (error.status === 409 && error.lockKeys?.length > 0) {
            // 能走到这里条目必然已被放行（deferred 条目拦截派发）——即上次记的
            // 锁键已释放，本轮是全新冲突，记新计时起点。记录本次实际命中的锁键：
            // 过期检查据此判"锁是否仍被持有"，不能用 taskLockKeys 重算——
            // siblings 快照漂移会让键集变化
            deferred.set(task.id, { since: Date.now(), keys: error.lockKeys });
            return;
          }
          deferred.delete(task.id);
          console.error(`任务 ${task.id} 启动失败:`, error.message);
          try {
            downloadTasksRepo.updateTask(task.id, {
              status: 'failed',
              errorMessage: sanitizeErrorMessage(error.message)
            });
            recountQueueCounters(queueId);
          } catch {
            // 任务行可能已随队列删除
          }
        })
        .finally(() => {
          inflightTaskIds.delete(task.id);
          const index = runningTasks.indexOf(taskPromise);
          if (index > -1) {
            runningTasks.splice(index, 1);
          }
        });
      runningTasks.push(taskPromise);
    }
  }

  await Promise.all(runningTasks);

  // cancel→start 竞态：本协程的控制器可能已被新 startQueue 替换——
  // 收尾写库前必须确认所有权还在自己手里，否则会把新运行写回 cancelled 并从 map 删掉新控制器
  if (activeQueues.get(queueId) !== controller) {
    return;
  }

  // 收尾窗口内队列可能被删除或被取消：已删则直接返回，cancelled 不得改写为 completed
  const finalQueue = downloadQueuesRepo.findQueueById(queueId);
  if (!finalQueue) {
    activeQueues.delete(queueId);
    return;
  }

  // 在途 promise 全部 settle 后再收一次口：它们的终态写若也失败，行会钉在
  // downloading——收敛后复位/判死的结果才进终态判定（cancelled 时同理，
  // 复位行留给下次启动消费）
  convergeStrandedDownloading();

  const taskRows = downloadTasksRepo.listTasksByQueue(queueId);
  const failedCount = taskRows.filter(t => t.status === 'failed').length;
  // 收敛后仍有 pending/downloading 行 = 工作未完：写 completed 会把它带进
  // 「终态且无重启入口」的死态（前端对 completed 不露出启动键）——收回
  // pending 保持可再启动，startQueue/retryQueue 的放行口径已允许带可跑行
  const hasUnfinished = taskRows.some(t => t.status === 'pending' || t.status === 'downloading');

  // 有失败任务的队列不应标 completed——"完成但缺歌"会掩盖失败痕迹，
  // failed 终态让前端露出"重试"入口（retryQueue 正是为它设计的）。
  // 状态写与计数重算同事务：终态落库的瞬间计数即对齐，无中间漂移窗口
  getDb().transaction(() => {
    downloadQueuesRepo.updateQueue(queueId, controller.cancelled
      ? { status: 'cancelled' }
      : {
          status: hasUnfinished ? 'pending'
            : failedCount > 0 ? 'failed' : 'completed',
          completedAt: hasUnfinished ? null : new Date().toISOString()
        });
    recountQueueCounters(queueId);
  })();

  activeQueues.delete(queueId);
}




// 状态迁移写（completed/failed/复位 pending）是行归属的关键写：瞬时 DB 故障
// （SQLITE_BUSY 打满 busy_timeout、SQLITE_IOERR 抖动）下裸吞会把行钉在
// downloading——无在途 promise、retryTask/删除/启动各入口都不认它。
// 做一次有限重试再交给调用方兜底（标 failed 或收尾收敛步骤）
async function updateTaskWithRetry(taskId, fields, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    try {
      return downloadTasksRepo.updateTask(taskId, fields);
    } catch (error) {
      if (attempt >= retries) throw error;
      await new Promise(resolve => {
        const t = setTimeout(resolve, 100);
        t.unref?.();
      });
    }
  }
}

async function processTask(task, queueId, signal) {
  // 锁获取也进 try：taskLockKeys 的 siblings 查询等早期抛错若越过 try，
  // 会被外层当"启动失败"直接判死——绕过 retryCount 重试，与 try 内同等
  // 瞬时错误（SQLITE_BUSY 等）的重试语义不对称
  let lockKeys = [];
  let lockHeld = false;

  const throwIfAborted = () => {
    if (signal?.aborted) {
      const err = new Error('已取消');
      err.aborted = true;
      throw err;
    }
  };

  try {
    // 派发即视为"退避已到期"：后续失败会重新记账；完成/失败/删除路径另清
    retryAfter.delete(task.id);
    lockKeys = taskLockKeys(task);

    // 同路径并发写锁：两个写者同时 createWriteStream 会交错 truncate 写坏文件
    const heldKeys = lockKeys.filter(key => activePaths.has(key));
    if (heldKeys.length > 0) {
      const err = httpError(409, '该歌曲已有下载任务进行中');
      // 只记真实命中的键：调用方据此判"连续同段等待"——记录全候选键会把
      // 已释放的旧键当成仍持有，新冲突继承旧时间戳被硬顶秒杀
      err.lockKeys = heldKeys;
      throw err;
    }
    lockKeys.forEach(key => activePaths.add(key));
    lockHeld = true;

    const audioPath = task.downloadAudio
      ? lockKeys.find(k => k.endsWith('.mp3'))
      : null;
    const lyricsPath = task.downloadLyrics
      ? lockKeys.find(k => k.endsWith('.lrc'))
      : null;
    const coverPath = (task.downloadCover && task.coverUrl)
      ? lockKeys.find(k => k.endsWith('.jpg'))
      : null;
    const videoPath = (task.downloadVideo && isExternalSongId(task.songId))
      ? lockKeys.find(k => k.endsWith('.mp4'))
      : null;

    // 任务行可能在入队快照后被 DELETE——复查存在性再动工，否则写出无人认领的孤儿文件。
    // 必须在 try 内执行：此处 updateTask 抛错（SQLITE_BUSY 等）若越过 try，
    // 锁键会永久残留在 activePaths，该路径之后所有任务恒 409
    const current = downloadTasksRepo.updateTask(task.id, {
      status: 'downloading',
      progress: 0,
      errorMessage: null
    });
    if (!current) return;

    let totalProgress = 0;
    let lastReported = -1;
    const reportProgress = (value) => {
      // progress 回调每 chunk 触发一次——按百分点节流，且 DB 写入失败不得穿透 'data' 监听器
      // 高水位钳位：视频候选降档重试会让源内 progress 回卷（90→0）——进度
      // 条语义是「任务整体完成度」，相位间回退不写库
      const rounded = Math.max(lastReported, Math.floor(value));
      if (rounded === lastReported) return;
      lastReported = rounded;
      try {
        downloadTasksRepo.updateTask(task.id, { progress: rounded });
      } catch { /* 行可能已被删 */ }
    };
    // 视频相位拉走大头权重：音频 70→45，视频 35（两脚下载+合流远超一段音频）。
    // 权重按「本任务真会跑的相位」归一化到 100——相位在工件路径键缺位时
    // 不跑（downloadAudio=false 的 API 调用方、缺 coverUrl 的封面相位），
    // 不归一的话被裁相位空占权重，进度中途封顶 <100 再跳变
    const rawWeights = videoPath
      ? { audio: 45, video: 35, lyrics: 10, cover: 10 }
      : { audio: 70, video: 0, lyrics: 15, cover: 15 };
    const phasePaths = { audio: audioPath, video: videoPath, lyrics: lyricsPath, cover: coverPath };
    const activePhases = Object.keys(rawWeights)
      .filter(k => phasePaths[k] && rawWeights[k] > 0);
    const rawSum = activePhases.reduce((s, k) => s + rawWeights[k], 0);
    const weights = { audio: 0, video: 0, lyrics: 0, cover: 0 };
    if (rawSum > 0) {
      // progress 列是 INTEGER——取整漂移贴给末个活跃相位兜底，总和恒 100
      let remain = 100;
      activePhases.forEach((k, i) => {
        weights[k] = i === activePhases.length - 1
          ? remain
          : Math.round(rawWeights[k] * 100 / rawSum);
        remain -= weights[k];
      });
    }

    if (audioPath) {
      // 分阶段幂等：上次尝试已完成的分段（abort/重试复位不清路径字段）跳过重下——
      // 登记过的路径意味着文件已通过完整性对账，重试只补缺失阶段，10MB 音频
      // 不因歌词抖动而重下
      const existingAudio = current.audioPath && fs.existsSync(current.audioPath);
      if (!existingAudio) {
        const result = await fileDownloader.downloadAudio(
          task.songId,
          audioPath,
          task.bitrate,
          (progress) => reportProgress(totalProgress + Math.floor(progress * weights.audio / 100)),
          signal,
          task.providerData
        );
        // 落盘后时长对账：HEAD 探测失败时解锁端校验会漏放预览剪辑——
        // 真实字节数+真实码率是最后一道闸门（只查"短"，见 durationLooksTruncated）。
        // 外部源（bv_/yt_）豁免：其 durationMs 是匹配到的网易云曲元数据时长，
        // 与源站真实时长天然漂移（实测同曲差 37s）——对账只会误伤；
        // 且自有源没有"试听剪辑"这一失效形态，闸门防的是不存在的东西
        if (!isExternalSongId(task.songId)
            && durationLooksTruncated(result.size, result.br, task.durationMs)) {
          // 剪辑已 rename 就位但永不登记——就地删掉，否则每次重试换扩展名
          // 时旧剪辑以未登记文件无限期滞留（reap 只在启动期跑）
          try { fs.unlinkSync(result.path); } catch { /* 删失败留给 reap */ }
          throw new Error(`下载内容与歌曲时长不符（${result.size} 字节 vs 预期 ${task.durationMs}ms）`);
        }
        // 真实落盘路径入库：扩展名由解锁源 URL 决定（youtube 常回 m4a），
        // 占位锁键只承担互斥语义
        const audioRow = downloadTasksRepo.updateTask(task.id, {
          audioPath: result.path,
          fileSize: result.size,
          progress: totalProgress + weights.audio
        });
        // 行在此窗口被删：新文件永不登记——就地回收（等同剪辑处理路径）
        if (!audioRow) {
          try { fs.unlinkSync(result.path); } catch { /* 留给 reap */ }
          return;
        }
      }
      totalProgress += weights.audio;
    }

    // 段间补一次显式 signal 检查：上一段完成后队列可能已被取消，
    // 取消不必等下一段请求自然超时才生效
    throwIfAborted();

    if (videoPath) {
      const existingVideo = current.videoPath && fs.existsSync(current.videoPath);
      if (!existingVideo) {
        const result = await fileDownloader.downloadVideo(
          task.songId,
          videoPath,
          (progress) => reportProgress(totalProgress + Math.floor(progress * weights.video / 100)),
          signal,
          task.providerData
        );
        const videoRow = downloadTasksRepo.updateTask(task.id, {
          videoPath: result.path,
          // 实际到手档位快照落库——候选降档/合流兜底从此可对账
          videoMeta: result.videoMeta || null,
          progress: totalProgress + weights.video
        });
        // 行在写盘窗口被删：新文件永不登记——就地回收（同音频段处理）
        if (!videoRow) {
          try { fs.unlinkSync(result.path); } catch { /* 留给 reap */ }
          return;
        }
      }
      totalProgress += weights.video;
      throwIfAborted();
    }

    if (lyricsPath) {
      const existingLyrics = current.lyricsPath && fs.existsSync(current.lyricsPath);
      if (!existingLyrics) {
        try {
          const lrcResult = await fileDownloader.downloadLyrics(task.songId, lyricsPath, signal, task.providerData);
          const lrcRow = downloadTasksRepo.updateTask(task.id, {
            lyricsPath: lrcResult.path,
            progress: totalProgress + weights.lyrics
          });
          // 行在写盘窗口被删：新文件永不登记——就地回收（同音频段处理）
          if (!lrcRow) {
            try { fs.unlinkSync(lrcResult.path); } catch { /* 留给 reap */ }
            return;
          }
        } catch (error) {
          // NO_LYRICS 是上游确定性"无词"，不算任务失败；其余错误照常冒泡
          if (error.code !== 'NO_LYRICS') {
            throw error;
          }
        }
      }
      totalProgress += weights.lyrics;
    }

    throwIfAborted();

    if (coverPath) {
      const existingCover = current.coverPath && fs.existsSync(current.coverPath);
      if (!existingCover) {
        try {
          const coverResult = await fileDownloader.downloadCover(task.coverUrl, coverPath, signal);
          const coverRow = downloadTasksRepo.updateTask(task.id, {
            coverPath: coverResult.path,
            progress: totalProgress + weights.cover
          });
          if (!coverRow) {
            try { fs.unlinkSync(coverResult.path); } catch { /* 留给 reap */ }
            return;
          }
        } catch (error) {
          if (signal?.aborted) throw error;
          console.warn(`封面下载失败 (${task.songId}):`, error.message);
        }
      }
      totalProgress += weights.cover;
    }

    try {
      const done = await updateTaskWithRetry(task.id, {
        status: 'completed',
        progress: 100,
        completedAt: new Date().toISOString()
      });
      // updateTask 对不存在行返回 null 而非抛错——行已删时不再给队列计数
      if (!done) return;
      retryAfter.delete(task.id);
    } catch {
      // 重试仍败（行已删或 DB 持续故障）：裸吞会把行钉在 downloading——
      // 队列收尾按 pending 过滤判 completed 而它永无入口。兜底标 failed
      // 让重试链接管；这步再失败交给收尾的「无在途 downloading 行」收敛
      try {
        downloadTasksRepo.updateTask(task.id, {
          status: 'failed',
          errorMessage: '完成状态写入失败'
        });
      } catch { /* DB 持续故障——收尾收敛步骤兜底 */ }
      return;
    }

    if (queueId !== null && queueId !== undefined) {
      recountQueueCounters(queueId);
    }

  } catch (error) {
    // 路径锁冲突(409)不是任务失败——透传给外层走 deferred/退避重试。
    // 必须带 lockKeys：无键 409 是未知来源（如下游 AxiosError 漏出），
    // 走正常失败路径拿 retryCount 兜底而非绕过重试
    if (error.status === 409 && error.lockKeys?.length > 0) {
      throw error;
    }
    if (signal?.aborted || error.aborted) {
      // 取消/停机中止：残文件由 downloader 清理；任务复位 pending 供下次重跑
      retryAfter.delete(task.id); // 取消即清退避，恢复后应可立即重跑
      try {
        await updateTaskWithRetry(task.id, {
          status: 'pending',
          progress: 0,
          errorMessage: '已取消'
        });
      } catch {
        // 任务行可能已随队列级联删除；钉住的 downloading 由收尾收敛兜底
      }
      return;
    }

    console.error(`任务 ${task.id} 失败:`, error);

    // fatal（解锁失败/试听片段）是确定性失败，重试只会重复打上游；可重试错误走 retryCount 路径。
    // 每步 DB 写独立兜底：行/队列可能已被并发删除；瞬时故障下裸吞会把行钉在
    // downloading（无在途且无恢复入口）——状态迁移走有限重试，仍败则兜底
    // 标 failed 或交给收尾收敛
    if (!error.fatal && task.retryCount < 3) {
      try {
        await updateTaskWithRetry(task.id, {
          retryCount: task.retryCount + 1,
          status: 'pending',
          errorMessage: sanitizeErrorMessage(error.message)
        });
        // 指数退避记账：瞬时错误立即重捞=全速空转打上游；pendingTasks 过滤会
        // 跳过到期前任务，进程重启后表空即立即重试。基数用递增后的新次数
        // （与 standalone 路径读到的行值同相位）。条目膨胀护栏：只清已到期项
        retryAfter.set(task.id, Date.now() + retryDelayMs(task.retryCount + 1));
        if (retryAfter.size > 1024) {
          const now = Date.now();
          for (const [id, at] of retryAfter) {
            if (at <= now) retryAfter.delete(id);
          }
        }
      } catch {
        // 复位写持续失败且行未被删：留在 downloading 等于钉死——尽力改判
        // failed 让重试入口接住；再失败交给收尾收敛/重启恢复
        try {
          downloadTasksRepo.updateTask(task.id, {
            status: 'failed',
            errorMessage: '状态写入失败'
          });
        } catch { /* 行已删/DB 持续故障 */ }
      }
    } else {
      retryAfter.delete(task.id);
      try {
        await updateTaskWithRetry(task.id, {
          status: 'failed',
          errorMessage: sanitizeErrorMessage(error.message)
        });
      } catch { /* 行已删/DB 持续故障——收尾收敛兜底 */ }
      if (queueId !== null && queueId !== undefined) {
        recountQueueCounters(queueId);
      }
    }
  } finally {
    // 只释放实际持有的键：409 路径上一个键都没加过——无条件 delete 会
    // 拆掉别的任务正在持有的同键锁
    if (lockHeld) {
      lockKeys.forEach(key => activePaths.delete(key));
    }
  }
}

async function pauseQueue(queueId) {
  if (deletingQueues.has(queueId)) {
    throw httpError(409, '队列正在删除中');
  }
  // 级联窗口对称检查：级联只持 deletingPlaylists——查到即可快失败，
  // 查不到也无害（控制器已随排空移出 Map，下面 get 空 409）
  if (deletingPlaylists.has(downloadQueuesRepo.findQueueById(queueId)?.playlistId)) {
    throw httpError(409, '该歌单正在删除中');
  }
  const controller = activeQueues.get(queueId);
  if (!controller) {
    throw httpError(409, '队列未运行');
  }

  controller.paused = true;
  downloadQueuesRepo.updateQueue(queueId, { status: 'paused' });

  return downloadQueuesRepo.findQueueById(queueId);
}

async function resumeQueue(queueId) {
  if (deletingQueues.has(queueId)) {
    throw httpError(409, '队列正在删除中');
  }
  // 对称检查同 pauseQueue：级联锁是 deletingPlaylists，本函数原只查队列锁
  if (deletingPlaylists.has(downloadQueuesRepo.findQueueById(queueId)?.playlistId)) {
    throw httpError(409, '该歌单正在删除中');
  }
  const controller = activeQueues.get(queueId);
  if (!controller) {
    throw httpError(409, '队列未运行');
  }

  controller.paused = false;
  downloadQueuesRepo.updateQueue(queueId, { status: 'running' });

  return downloadQueuesRepo.findQueueById(queueId);
}

// 中止运行中控制器：置 cancelled + 解除暂停自旋 + abort 在途下载流
function abortController(controller) {
  controller.cancelled = true;
  controller.paused = false;
  controller.abort?.abort();
}

// 任务行"复位重跑"的公共字段形状：状态/计数/路径整体清零——残留的旧路径
// 可能已指向别的任务的文件（逐站点手写 updateTask 易漏字段且漂移）
const resetTaskFields = (extra = {}) => ({
  status: 'pending',
  progress: 0,
  errorMessage: null,
  completedAt: null,
  retryCount: 0,
  audioPath: null,
  lyricsPath: null,
  coverPath: null,
  videoPath: null,
  videoMeta: null,
  fileSize: null,
  ...extra
});

// 计数器唯一真相来源：状态派生的先读后写（子查询 COUNT 替代手工增减）。
// 手工 increment/decrement 在任何异常/并发路径漏配即永久漂移——全部调用方
// 一律走这个收口，漂移面归零。idx_download_tasks_queue 覆盖 queue_id 维度，
// status 在索引内过滤——歌单规模下 COUNT 成本可忽略
function recountQueueCounters(queueId) {
  try {
    const db = getDb();
    // 先读后写：计数没变时不动 updated_at——前端按 updatedAt diff 刷新，
    // 幂等空写会让 UI 把"无变化"当变更且淹没真正的配置更新时间
    const row = db.prepare(`
      SELECT
        total_tasks AS storedTotal,
        completed_tasks AS storedCompleted,
        failed_tasks AS storedFailed,
        (SELECT COUNT(*) FROM download_tasks WHERE queue_id = @q) AS total,
        (SELECT COUNT(*) FROM download_tasks WHERE queue_id = @q AND status = 'completed') AS completed,
        (SELECT COUNT(*) FROM download_tasks WHERE queue_id = @q AND status = 'failed') AS failed
      FROM download_queues WHERE id = @q
    `).get({ q: queueId });
    if (!row) return;
    if (row.total === row.storedTotal
        && row.completed === row.storedCompleted
        && row.failed === row.storedFailed) return;
    db.prepare(`
      UPDATE download_queues SET
        total_tasks = @total,
        completed_tasks = @completed,
        failed_tasks = @failed,
        updated_at = @now
      WHERE id = @q
    `).run({ ...row, now: new Date().toISOString(), q: queueId });
  } catch (error) {
    // 事务内失败必须冒泡让外层回滚——吞掉会变成"行删了计数没动"的半提交。
    // 事务外（settle 回调/排空兜底）吞掉合理：队列行已删时读为空 return
    // 本就不写，能进 catch 的都是一次性读写失败
    if (getDb().inTransaction) throw error;
  }
}

// 终态自洽收尾：failed 队列在失败/完成行被删光后既无 failed 也无
// pending/downloading 行——留在 failed 是无入口死壳（start 拒空终态、
// retry 要 failed 行、前端只剩「删除」），收回 pending 让用户可再启动
// （无任务时启动会自然收尾成 completed 空壳，建队路径也会收养复活它）
function reconcileTerminalQueue(queueId) {
  const queue = downloadQueuesRepo.findQueueById(queueId);
  if (!queue || queue.status !== 'failed') return;
  if (queueHasLiveController(queueId)) return;
  const hasRunnable = downloadTasksRepo.listTasksByQueue(queueId)
    .some(t => t.status === 'pending' || t.status === 'failed' || t.status === 'downloading');
  if (!hasRunnable) {
    downloadQueuesRepo.updateQueue(queueId, { status: 'pending', completedAt: null });
  }
}

async function cancelQueue(queueId) {
  const queue = downloadQueuesRepo.findQueueById(queueId);
  if (!queue) {
    throw httpError(404, '队列不存在');
  }
  // 删除锁持有期间不许再把控制器搬来搬去——deleteQueue 的排空集合是
  // 一次性快照，排空后新出现的活跃控制器不会被等待
  if (deletingQueues.has(queueId) || deletingPlaylists.has(queue.playlistId)) {
    throw httpError(409, '队列正在删除中');
  }

  const controller = activeQueues.get(queueId);
  if (controller) {
    abortController(controller);
    // 控制器移入 draining：协程仍在排空收尾，deleteQueue 等路径必须连它一起等
    activeQueues.delete(queueId);
    drainingQueues.set(queueId, controller);
    const release = () => {
      // 身份校验：cancel→start→cancel 会让旧控制器的 done 回调抹掉新条目
      if (drainingQueues.get(queueId) === controller) drainingQueues.delete(queueId);
      // 若无新控制器接管（未重启/未删除），补一次计数重算——取消路径跳过
      // processQueue 收尾 recount 兜底，这里的失败计数漂移不会长期残留
      if (!activeQueues.has(queueId) && !drainingQueues.has(queueId)) {
        recountQueueCounters(queueId);
      }
    };
    Promise.resolve(controller.done).finally(release).catch(() => {});
    // done 若卡死在不可中止的上游调用永不 settle——超时兜底释放条目，
    // 否则永久残留；但协程本身可能还在跑——追进僵尸集，让删除/停机
    // 路径仍能 abort 并排空它在途的流
    setTimeout(() => {
      try {
        if (!controller.settled) zombieControllers.add(controller);
        release(); // recountQueueCounters 可能踩已删行——不能让 timer 回调炸进程
      } catch { /* 尽力而为 */ }
    }, DRAIN_TIMEOUT_MS + 5000).unref?.();
  }

  // 终态队列不应被改写为 cancelled（completed/failed 是有意义的终态）
  if (queue.status === 'pending' || queue.status === 'running' || queue.status === 'paused') {
    downloadQueuesRepo.updateQueue(queueId, { status: 'cancelled' });
  }
  activeQueues.delete(queueId);

  return downloadQueuesRepo.findQueueById(queueId);
}

// DELETE /queues/:id：管理页的"删除歌单"语义是整个歌单下载足迹——队列行只是
// 足迹的视图句柄。只删本队列会留下同歌单的 standalone 单曲任务（queue_id=NULL）、
// 其他队列任务与歌单登记行：文件仍在盘上且收割器视其为在册，永不清理。
// 因此 playlistId 在册的队列升级为歌单级联——排空该歌单全部控制器、删全部
// 任务/队列/歌单行、事务后清文件（语义收敛进 deletePlaylistCascade）。
// playlistId 悬空的孤儿队列走下方窄删：中止运行中的控制器、排空在途任务、
// 清掉已落盘文件，再删行——不做这些会留下永远失联的孤儿文件；排空尤其关键：
// abort 后 processTask 的收尾（路径写库/removePartial）是异步的，直接扫文件
// 会漏掉"写完未记档"的落盘
async function deleteQueue(queueId) {
  const queue = downloadQueuesRepo.findQueueById(queueId);
  if (!queue) {
    throw httpError(404, '队列不存在');
  }
  // 级联自带的 deletingPlaylists 锁与排空逻辑是窄删检查的超集——重复登记
  // deletingQueues 反而会让"队列正在删除中"与"歌单正在删除中"两种 409 语义并存
  if (queue.playlistId != null) {
    await deletePlaylistCascade(queue.playlistId);
    return;
  }
  // 可重入 + 排空窗口锁：并发 DELETE 不重复排空，且排空 await 期间拒绝
  // startQueue/retryTask 起新协程——否则行删后新协程仍在写盘，永久失联。
  // 到此 playlistId 必为 null（在册队列上方已升级级联）：孤儿队列不属任何
  // 歌单，deletingPlaylists 交叉锁对它无意义
  if (deletingQueues.has(queueId)) {
    throw httpError(409, '队列正在删除中');
  }
  deletingQueues.add(queueId);

  try {
  // 排空覆盖 activeQueues 与 drainingQueues（刚 cancel 的队列协程还在收尾，
  // 跳过排空会漏"写完未记档"的落盘）；排空有时限——不可中止的上游调用
  // 不能让整个 HTTP 请求死等。
  // cancel→start→delete 会让两个 Map 各持一个控制器——必须全部排空而非 || 取一；
  // 僵尸控制器同排：超时从 draining 释放后仍在跑的旧协程不扫会漏排空
  const controllers = new Set();
  for (const map of [activeQueues, drainingQueues]) {
    const c = map.get(queueId);
    if (c) controllers.add(c);
  }
  for (const z of zombieControllers) {
    if (z.queueId === queueId) controllers.add(z);
  }
  for (const c of controllers) abortController(c);
  await Promise.all(
    [...controllers].map(c => drainWithTimeout(c.done))
  );
  // drain 超时的协程可能仍在跑——追进僵尸集，shutdownAll/歌单级联还能兜底中止
  for (const c of controllers) {
    if (!c.settled) zombieControllers.add(c);
  }
  // 身份校验删除：排空窗口内如有漏网新协程接管（不应发生，deletingQueues 已拦），
  // 按引用比对避免误删新控制器的追踪项
  for (const c of controllers) {
    if (activeQueues.get(queueId) === c) activeQueues.delete(queueId);
    if (drainingQueues.get(queueId) === c) drainingQueues.delete(queueId);
  }

  const tasks = downloadTasksRepo.listTasksByQueue(queueId);
  // 行先删、文件后删（理由同 deleteTask）；显式删行不依赖 FK——老库的
  // queue_id 列是 ALTER 补的、没有级联声明。事务化：半途 SQLITE_BUSY/IOERR
  // 不留"子行删一半、队列行还在"的不一致
  const filePaths = tasks.flatMap(t => [t.audioPath, t.lyricsPath, t.coverPath, t.videoPath]);
  getDb().transaction(() => {
    for (const task of tasks) {
      downloadTasksRepo.deleteTask(task.id);
    }
    downloadQueuesRepo.deleteQueue(queueId);
  })();
  for (const task of tasks) retryAfter.delete(task.id);
  // 在途任务的流已被 abort：正在写的那段残片由 downloader 的 removePartial 清，
  // 已落盘的前段（如 audio 已完成、歌词在途）仍要删；空目录骨架顺手剪掉
  // （目录非空时 rmdirSync 安全跳过——同歌单 standalone/其他队列文件不受影响）
  cleanupPlaylistFilesAndDirs(queue.playlistId, filePaths);
  } finally {
    deletingQueues.delete(queueId);
  }
}

function getQueueProgress(queueId) {
  const queue = downloadQueuesRepo.findQueueById(queueId);
  if (!queue) {
    throw httpError(404, '队列不存在');
  }

  const tasks = downloadTasksRepo.listTasksByQueue(queueId);
  const statusCounts = downloadTasksRepo.countTasksByQueueAndStatus(queueId);

  return {
    queue,
    tasks,
    statusCounts,
    isActive: queueHasLiveController(queueId)
  };
}

const VALID_TASK_STATUSES = new Set(['pending', 'downloading', 'completed', 'failed']);

// 任务列表查询：playlistId 支持本地 id 或网易云 id（未导入则空数组，不触发导入）。
// standalone=1 收窄到 queue_id IS NULL 的单曲任务（「未入队单曲」分节专属面）。
// 参数优先级 queueId > playlistId(+standalone) > status——组合传入时静默按
// 超集回落（如 queueId+standalone 只回队列任务），不报错
function listTasks({ playlistId, queueId, status, standalone } = {}) {
  if (queueId !== undefined && queueId !== null && queueId !== '') {
    const n = Number(queueId);
    if (!Number.isInteger(n) || n <= 0) {
      throw httpError(400, '无效的 queueId');
    }
    return downloadTasksRepo.listTasksByQueue(n);
  }
  if (playlistId !== undefined && playlistId !== null && playlistId !== '') {
    const resolved = findExistingPlaylistId(playlistId);
    if (resolved === null) return [];
    const wantStandalone = standalone === true || standalone === 1
      || standalone === '1' || standalone === 'true';
    return wantStandalone
      ? downloadTasksRepo.listStandaloneTasksByPlaylist(resolved)
      : downloadTasksRepo.listTasksByPlaylist(resolved);
  }
  if (status) {
    if (!VALID_TASK_STATUSES.has(status)) {
      throw httpError(400, '无效的 status');
    }
    return downloadTasksRepo.listTasksByStatus(status);
  }
  throw httpError(400, '需要提供 playlistId、queueId 或 status 参数');
}

// 删除任务记录及其已落盘文件（进行中的任务拒绝删除——下载流仍持有句柄）
function deleteTask(taskId) {
  const task = downloadTasksRepo.findTaskById(taskId);
  if (!task) {
    throw httpError(404, '任务不存在');
  }
  // 只看内存态：DB status='downloading' 但不在 standaloneRunning/任何队列控制器
  // 里的是残留行（下次启动 recoverStaleStates 才复位），不应永远挡住删除
  if (standaloneRunning.has(task.id)
    || (task.status === 'downloading' && task.queueId
        && queueHasLiveController(task.queueId))) {
    // standalone 任务没有"所在队列"可取消——文案按归属分支给可执行指引
    throw httpError(409, task.queueId
      ? '任务正在下载中，请先取消所在队列'
      : '任务正在下载中，请稍候再删');
  }
  // 删除窗口锁：级联排空会先把控制器移出 Map 再 await——窗口内"在跑"判定
  // 失效，行删后协程继续写盘成孤儿文件
  if (task.queueId && deletingQueues.has(task.queueId)) {
    throw httpError(409, '所在队列正在删除中');
  }
  if (deletingPlaylists.has(task.playlistId)) {
    throw httpError(409, '该歌单正在删除中');
  }

  // 行先删、文件后删：崩溃窗口反过来留的是"行还在但文件没了"的幻影
  // completed（收养时计成已下载、静默缺歌），比孤儿文件危害大。
  // 行删+计数重算+终态自洽同事务：半途 SQLITE_BUSY 不留漂移；
  // 删光 failed 队列的最后行后它不能停在无入口的 failed 死壳
  getDb().transaction(() => {
    downloadTasksRepo.deleteTask(taskId);
    if (task.queueId) {
      recountQueueCounters(task.queueId);
      reconcileTerminalQueue(task.queueId);
    }
  })();
  retryAfter.delete(taskId); // 行已不存在，退避条目失去意义
  const deletedFiles = deleteFiles([task.audioPath, task.lyricsPath, task.coverPath, task.videoPath]);
  // 单任务删除同口径剪空骨架——否则最后一条 standalone 删完仍留
  // downloads/<pl>/ 空目录等下次启动 reapOrphanFiles 兜底
  pruneEmptyPlaylistDirs(task.playlistId);
  return { success: true, deletedFiles };
}

// 独立任务（queueId=null）没有队列调度器消费 pending：原地循环执行，
// processTask 内部会把 retryCount<3 的失败者置回 pending，循环即真实重试。
// 间错 300ms 防止路径锁冲突等瞬时失败时紧循环空转。
// 挂 AbortController：停机/歌单删除必须能中止并排空，否则在途流继续落盘成孤儿文件
async function runStandaloneTask(task) {
  // 调用方前置检查与这里之间隔了 await（resolvePlaylistId 走上游要秒级）——
  // shutdown 可能在窗口内跑完排空；入口复查防止停机后仍派发 standalone 协程
  if (shuttingDown) {
    throw httpError(409, '服务正在停机');
  }
  if (standaloneRunning.has(task.id)) {
    throw httpError(409, '该任务正在下载中');
  }
  const entry = { abort: new AbortController(), done: null };
  standaloneRunning.set(task.id, entry);
  entry.done = (async () => {
    let current = task;
    do {
      if (current !== task) {
        // 与队列路径同一退避：行内 retryCount 已被 processTask 递增。
        // abort 立即打断（不睡满退避）+ unref 不拖进程退出
        await new Promise(resolve => {
          const t = setTimeout(resolve, retryDelayMs(current.retryCount));
          t.unref?.();
          entry.abort.signal.addEventListener('abort', () => {
            clearTimeout(t);
            resolve();
          }, { once: true });
        });
      }
      // abort 后不把复位 pending 的任务再跑一遍——那是取消语义不是重试
      if (entry.abort.signal.aborted) break;
      await processTask(current, null, entry.abort.signal);
      current = downloadTasksRepo.findTaskById(current.id);
    } while (current && current.status === 'pending' && !entry.abort.signal.aborted);

    // 先判完成：下载恰好跑完时撞上 abort（如并发歌单删除）文件已完整落盘，
    // 此时报"已取消"是错误语义——completed 优先
    if (current?.status === 'completed') {
      return current;
    }
    if (entry.abort.signal.aborted) {
      throw httpError(409, '下载已取消');
    }
    throw httpError(502, current?.errorMessage || '下载失败');
  })().finally(() => {
    standaloneRunning.delete(task.id);
  });
  return entry.done;
}

// 提交即返回：下载在后台协程跑，调用方拿 pending 任务行，终态由
// GET /songs/:id/status 轮询。catch 兜底防 unhandled rejection——
// 行级失败已由 processTask 落库，这里只为日志可见
const dispatchStandalone = (task) => {
  // completed-残缺/failed 行的原地重跑带着旧 status 进协程——先翻回 pending：
  // 响应体若声称旧终态，前端会当幂等完成跳过轮询而文件实际还在下；
  // retryCount 也必须清零——failed 行带着 retryCount>=MAX 直接派活，
  // 首个瞬态错误就再次落 failed。路径字段保留：分段幂等靠它只补缺失段
  if (task.status !== 'pending') {
    downloadTasksRepo.updateTask(task.id, {
      status: 'pending',
      progress: 0,
      errorMessage: null,
      completedAt: null,
      retryCount: 0
    });
    retryAfter.delete(task.id);
  }
  // 翻行后必须重捞再派：processTask 的重试判定读的是传入对象的 retryCount，
  // 把旧快照（retryCount>=MAX 的 failed 行）递进去会让首个瞬态错误直接判死
  const fresh = downloadTasksRepo.findTaskById(task.id) || task;
  runStandaloneTask(fresh).catch(error => {
    // 只有带 lockKeys 的 409 才是路径锁冲突（standalone 无队列 deferred
    // 重试机制，静默放着行会永远挂 pending）。"已在下载/已取消/停机"的
    // 409 是幂等语义，行归在跑的协程管——标 failed 会污染别人的任务
    if (error?.status === 409 && Array.isArray(error?.lockKeys)) {
      try {
        // 复查防 clobber：entry 摘除与本 catch 之间是微任务窗——新请求
        // 可能已完成整轮 dispatch 起了新协程，盲标 failed 会作废它
        const cur = standaloneRunning.has(task.id) ? null
          : downloadTasksRepo.findTaskById(task.id);
        if (cur && cur.status === 'pending') {
          downloadTasksRepo.updateTask(task.id, {
            status: 'failed',
            errorMessage: '输出路径被其他下载任务占用，请稍后重试'
          });
        }
      } catch { /* 行可能已被删 */ }
      return;
    }
    if (error?.status !== 409) {
      console.error(`单曲任务 ${task.id} 后台执行失败:`, error?.message || error);
    }
  });
  return downloadTasksRepo.findTaskById(task.id) || task;
};

// 下载单首歌曲到服务器（提交任务即返回任务行；调用方轮询 status 接口等终态）
async function downloadSingleSong(playlistId, songId, options = {}) {
  if (shuttingDown) {
    throw httpError(409, '服务正在停机');
  }

  const resolvedPlaylistId = await resolvePlaylistId(playlistId);
  // await 上游导入窗口内可能已开始停机——停机排空已结束后再建行/派协程
  // 会落没有任何消费者的 pending 孤儿行（与 createDownloadQueue 同口径复查）
  if (shuttingDown) {
    throw httpError(409, '服务正在停机');
  }
  if (deletingPlaylists.has(resolvedPlaylistId)) {
    throw httpError(409, '该歌单正在删除中');
  }
  const tracks = playlistTracksRepo.listTracksByPlaylistId(resolvedPlaylistId);
  const track = tracks.find(t => String(t.id) === String(songId));

  if (!track) {
    throw httpError(404, '歌曲不存在');
  }

  const artists = track.ar || track.artists || [];
  const album = track.al || track.album || {};
  const artistName = artists.filter(Boolean).map(a => a.name).join(', ') || '未知艺术家';
  const albumName = album.name || '未知专辑';
  const coverUrl = album.picUrl || album.pic_str || null;

  // 任务查询覆盖全部任务（含队列任务）：同一首歌经队列下载过就不再重复下载；
  // 队列拥有的任务不能代跑——standalone 执行会往别的队列写计数
  const existing = downloadTasksRepo.listTasksByPlaylist(resolvedPlaylistId)
    .filter(t => t.songId === String(songId));
  const queueTask = existing.find(t => t.queueId !== null && t.queueId !== undefined);

  if (queueTask) {
    // 队列删除窗口前置拦：completed 行连同文件即将被删，此时返回它等于给
    // 客户端一个指向已删文件的"下载成功"；接管更是把行摘出清扫清单
    if (deletingQueues.has(queueTask.queueId)) {
      throw httpError(409, '所在队列正在删除中');
    }
    // 幂等返回只认"completed 且文件还在"——登记路径被外部删掉的行回退到
    // 接管/重跑分支补回文件（否则客户端拿到的是指向已删文件的"已下载"）。
    // 例外：「补视频」请求且行缺视频工件时必须翻 pending 真跑——裸 return
    // 会让前端 toast「视频下载成功」而实际什么都没下。摘出队列（standalone
    // 代跑队列行会往旧队列写计数），保留完好路径字段——分段幂等自动跳过
    // 已落盘段，只补视频相位；旧队列计数回调对齐
    if (queueTask.status === 'completed' && taskFilesIntact(queueTask)) {
      // 「缺视频工件」按登记位+盘上存在双查（队列版同口径）：登记档刚被
      // 外删而 taskFilesIntact 的 TTL 快照还热着时是幻影行，该翻 pending 补回
      if (options.downloadVideo === true && isExternalSongId(songId)
          && !(queueTask.videoPath && pathPresent(queueTask.videoPath))) {
        // 摘出=改写队列成员关系——活体队列（含控制器排空/僵尸态）按非完好
        // 分支同款 ownerActive 纪律 409，等队列终结再补；否则任务会从
        // 运行中队列的详情页飞行中消失，且 standalone 绕过队列并发限额。
        // DB 判据只认 running/paused——pending 无控制器的队列（建了没启动/
        // 重启复位残留）没在跑任何东西，拿它挡单曲下载会让用户永远 409
        const owner = downloadQueuesRepo.findQueueById(queueTask.queueId);
        const ownerBusy = queueHasLiveController(queueTask.queueId);
        if (ownerBusy || (owner && ['running', 'paused'].includes(owner.status))) {
          throw httpError(409, '该歌曲所属下载队列仍在运行，请等队列结束后再补视频');
        }
        // 纵深防御闸：standaloneRunning 里的行 queueId 恒为 null（dispatch
        // 前置先摘队列），正常不可达——但不变量若被未来写入点破坏，翻
        // pending 在跑行会 clobber 协程且 dispatch 409 静默吞成行卡死
        if (standaloneRunning.has(queueTask.id)) {
          throw httpError(409, '该歌曲正在下载中');
        }
        getDb().transaction(() => {
          downloadTasksRepo.updateTask(queueTask.id, {
            queueId: null,
            status: 'pending',
            progress: 0,
            errorMessage: null,
            completedAt: null,
            downloadVideo: true,
            // retryCount 是相位级预算——老行若在音频相位打满 3 次，补视频
            // 首个瞬态错误就判死；翻 pending 时归零
            retryCount: 0,
            providerData: providerDataOf(track)
          });
          // 摘空壳回收：单曲队列摘完留 completed 0/0 幽灵壳——start/retry
          // 均不可用的纯残留顺手删（无活控制器已由上方 ownerBusy 闸保证）；
          // 非空才 recount——对将删行写计数是浪费
          if (owner && downloadTasksRepo.listTasksByQueue(queueTask.queueId).length === 0) {
            try { downloadQueuesRepo.deleteQueue(queueTask.queueId); } catch { /* 壳已消失 */ }
          } else {
            recountQueueCounters(queueTask.queueId);
          }
        })();
        retryAfter.delete(queueTask.id);
        return dispatchStandalone(downloadTasksRepo.findTaskById(queueTask.id) || queueTask);
      }
      return queueTask;
    }
    const owner = downloadQueuesRepo.findQueueById(queueTask.queueId);
    // 内存控制器是真判据：队列 status 已 cancelled 但协程仍在排空/僵尸集里跑
    // 时（不可中止上游调用超 DRAIN_TIMEOUT），接管会双调度同批文件。
    // DB 判据只认 running/paused——pending 无控制器=建了没启动/重启复位
    // 残留，不是活跃调度源，拿它挡单曲下载会永久锁死成员行
    const ownerBusy = queueHasLiveController(queueTask.queueId);
    const ownerActive = ownerBusy
      || (owner && ['running', 'paused'].includes(owner.status));
    if (ownerActive) {
      throw httpError(409, '该歌曲所属下载队列仍在运行，请等队列结束后再重试');
    }
    // 纵深防御闸（与补视频摘出同口径）：standaloneRunning 行 queueId 恒
    // null 让这恒假，但不变量破了时接管会清掉协程正在写的路径字段
    if (standaloneRunning.has(queueTask.id)) {
      throw httpError(409, '该歌曲正在下载中');
    }
    // 属主队列已终结（cancelled/failed）或行已消失：接管该行原地重跑——
    // 否则被弃队列的歌从此永远无法单曲下载。置回 standalone 语义，不给死队列写计数。
    // 同步本次请求的下载选项——否则按旧行开关/码率跑，可能"completed 却没音频"
    // 接管复位+死队列计数回调同事务：半途失败不留"行摘走了旧队列计数还虚高"
    getDb().transaction(() => {
      downloadTasksRepo.updateTask(queueTask.id, resetTaskFields({
        queueId: null,
        bitrate: options.bitrate || 320000,
        downloadAudio: options.downloadAudio !== false,
        downloadLyrics: options.downloadLyrics !== false,
        downloadCover: options.downloadCover !== false,
        downloadVideo: options.downloadVideo === true && isExternalSongId(queueTask.songId),
        providerData: providerDataOf(track)
      }));
      // 摘空壳回收与补视频摘出同口径——单任务终态队列被接管摘空后不留
      // 0/0 幽灵行；非空才 recount（死队列不再走收尾重算，接管会让计数
      // 永久虚高，回调对齐）
      if (owner && downloadTasksRepo.listTasksByQueue(queueTask.queueId).length === 0) {
        try { downloadQueuesRepo.deleteQueue(queueTask.queueId); } catch { /* 壳已消失 */ }
      } else {
        recountQueueCounters(queueTask.queueId);
      }
    })();
    retryAfter.delete(queueTask.id);
    // 行清后删文件：清路径却不删文件会让旧文件（可能不同扩展名）成运行期孤儿
    deleteFiles([queueTask.audioPath, queueTask.lyricsPath, queueTask.coverPath, queueTask.videoPath]);
    return dispatchStandalone(downloadTasksRepo.findTaskById(queueTask.id) || queueTask);
  }

  // completed 但文件缺失的行跳过 completed 短路——落回下方重跑补回缺失段
  // （processTask 的分段幂等会只补不存在的文件，不重下还在的）
  let task = existing.find(t => !t.queueId && t.status === 'completed' && taskFilesIntact(t))
    || existing.find(t => !t.queueId);

  if (task && task.status === 'completed' && taskFilesIntact(task)) {
    // 已下载行上的「补视频」请求：翻 pending 让协程只跑缺失的视频相位——
    // audioPath/lyricsPath/coverPath 保留，分段幂等自动跳过已落盘工件。
    // 「缺失」同队列版按登记位+盘上存在双查：登记档刚被外删而 intactCache
    // TTL 快照还热着时是幻影行，裸 return 会把补视频请求吞成幂等完成
    if (options.downloadVideo === true && isExternalSongId(songId)
        && !(task.videoPath && pathPresent(task.videoPath))) {
      // 完成写库与 standaloneRunning 摘 entry 之间有微任务薄窗——在跑协程
      // 的行翻 pending 后 dispatch 会 409 被吞，行永卡 pending 无人消费
      if (standaloneRunning.has(task.id)) {
        throw httpError(409, '该歌曲正在下载中');
      }
      task = downloadTasksRepo.updateTask(task.id, {
        status: 'pending',
        progress: 0,
        errorMessage: null,
        completedAt: null,
        downloadVideo: true,
        // retryCount 相位级预算归零——老行打满 3 次后补视频首个瞬态错误
        // 直接判死（与摘出分支同口径）
        retryCount: 0
      });
    } else {
      return task;
    }
  }
  // 只看内存态：DB 里残留的 downloading/pending 孤儿行不在
  // standaloneRunning 里，不挡下载（原地重跑即自愈）；在跑与退避窗内的
  // 任务一律 409——pending 退避行也算在跑（协程持有，重试钟还没走完），
  // 放行会让本次 flag 同步改写别人协程的行却无人派新协程
  if (task && standaloneRunning.has(task.id)) {
    throw httpError(409, '该歌曲正在下载中');
  }

  if (task) {
    // 既有 pending/failed standalone 行按本次请求同步下载选项——否则「补视频」
    // 这类请求会拿建行时的旧 flag 跑，downloadVideo 位永远缺席
    task = downloadTasksRepo.updateTask(task.id, {
      bitrate: options.bitrate || 320000,
      downloadAudio: options.downloadAudio !== false,
      downloadLyrics: options.downloadLyrics !== false,
      downloadCover: options.downloadCover !== false,
      downloadVideo: options.downloadVideo === true && isExternalSongId(songId),
      // 幻影清册：路径登记但文件已被外删、本次请求又不开对应相位——留着
      // 它 taskFilesIntact 永假，行在 UI 永远钉在「未下载」且任何普通重跑
      // 都修不好（相位按 flag 跳过）。清册让完好文件重新算 intact；文件
      // 还在的登记保留（del 语义不归 flag 同步管）。开相位的幻影不清——
      // processTask 的 existsSync 幂等检查会真补回那段
      ...(!(options.downloadVideo === true && isExternalSongId(songId))
        && task.videoPath && !pathPresent(task.videoPath)
        ? { videoPath: null, videoMeta: null } : {}),
      ...(options.downloadLyrics === false
        && task.lyricsPath && !pathPresent(task.lyricsPath)
        ? { lyricsPath: null } : {}),
      ...(options.downloadCover === false
        && task.coverPath && !pathPresent(task.coverPath)
        ? { coverPath: null } : {}),
      // audioPath 幻影同口径——只在音频相位显式关闭时清（开着会由
      // processTask 的 existsSync 幂等真补回）；fileSize 是音频档的
      // 体积登记，连同清掉
      ...(options.downloadAudio === false
        && task.audioPath && !pathPresent(task.audioPath)
        ? { audioPath: null, fileSize: null } : {}),
      providerData: providerDataOf(track)
    }) || task;
  } else {
    task = downloadTasksRepo.createTask({
      playlistId: resolvedPlaylistId,
      queueId: null,
      songId: String(songId),
      songName: track.name,
      artist: artistName,
      album: albumName,
      coverUrl,
      bitrate: options.bitrate || 320000,
      providerData: providerDataOf(track),
      durationMs: track.dt || track.duration || 0,
      downloadAudio: options.downloadAudio !== false,
      downloadLyrics: options.downloadLyrics !== false,
      downloadCover: options.downloadCover !== false,
      downloadVideo: options.downloadVideo === true && isExternalSongId(songId)
    });
  }

  return dispatchStandalone(task);
}

// 查询歌曲下载状态（读操作：歌单未导入时返回未下载，不触发远端导入；
// 队列任务与独立任务统一口径——状态显示与删除路径一致）
async function getSongDownloadStatus(playlistId, songId) {
  const resolvedPlaylistId = findExistingPlaylistId(playlistId);
  const all = resolvedPlaylistId === null
    ? []
    : downloadTasksRepo.listTasksByPlaylist(resolvedPlaylistId)
        .filter(t => t.songId === String(songId));
  const task = all.find(t => t.status === 'completed') || all[0] || null;

  // 视频工件单独报可用性，且跨歌单寻址：downloaded/filesIntact 是全工件
  // 存在性合取，歌词/封面档缺失会把在盘 mp4 误杀；任务行又按
  // (playlist,song) 唯一登记——暂存/搜索队列或别单借源的播放入口不带
  // 归属歌单上下文，只按本单查会漏掉视频在另一歌单的情形。任一歌单的
  // completed 行 videoPath 在盘即可播；命中行带出的 playlistId 是 /file
  // 端点的寻址键（工件按歌单目录组织，URL 必须带对的 playlistId）
  // 多歌单各持一份时取最新完成的工件（completed_at DESC）——老歌单可能
  // 躺着早期下载的劣化/旧版本档，新下载的档该赢。在盘判定用 pathPresent：
  // EPERM/EIO/挂载抖动一律判「在」（误回落在线流的方向比误报在盘安全）。
  // 音/视频各持一枚游标：最新行可能只有其一，按工件维度各自取新——
  // audioReady 给播放链本地优先用（播放只看音频档在不在盘，不看全工件）
  let videoPlaylistId = null;
  let audioPlaylistId = null;
  for (const t of downloadTasksRepo.listTasksBySongId(String(songId))) {
    if (t.status !== 'completed') continue;
    // file_ 行的 kind=audio 有 videoPath 回落（上传曲 video-only 工件，
    // getTaskArtifactPath 同口径）——audioReady 反映的是「/file 能供音频」
    const audioCandidate = t.audioPath || (FILE_TRACK_ID_RE.test(t.songId) ? t.videoPath : null);
    if (videoPlaylistId === null && t.videoPath
      && isUnderDownloadDir(t.videoPath) && pathPresent(t.videoPath)) {
      videoPlaylistId = t.playlistId;
    }
    if (audioPlaylistId === null && audioCandidate
      && isUnderDownloadDir(audioCandidate) && pathPresent(audioCandidate)) {
      audioPlaylistId = t.playlistId;
    }
    if (videoPlaylistId !== null && audioPlaylistId !== null) break;
  }

  return {
    // completed 行但文件被外部删掉 → 如实报未下载，让前端重新露出下载入口
    // （行不预改：下次下载走幂等校验/收养路径会自愈重跑）
    downloaded: Boolean(task && task.status === 'completed' && taskFilesIntact(task)),
    videoReady: videoPlaylistId !== null,
    videoPlaylistId,
    audioReady: audioPlaylistId !== null,
    audioPlaylistId,
    task: toPublicTask(task || null)
  };
}

// 已下载工件的盘内绝对路径寻址——/downloads/songs/:id/file 端点专用。
// 只认 completed 且文件真在盘上的行（与 status 端点同口径）；路径一律再
// 过 isUnderDownloadDir——DB 字段可信但纵深校验不留「读库直接开文件」通道
function getTaskArtifactPath(playlistId, songId, kind = 'audio') {
  const resolvedPlaylistId = findExistingPlaylistId(playlistId);
  if (resolvedPlaylistId === null) {
    throw httpError(404, '歌单不存在');
  }
  // kind 映射：audio/video 是播放工件；cover/lyrics 服务上传曲的封面回看与
  // 歌词读取（uploads 登记行的 cover_path/lyrics_path 列）
  const field = kind === 'video' ? 'videoPath'
    : kind === 'cover' ? 'coverPath'
    : kind === 'lyrics' ? 'lyricsPath'
    : 'audioPath';
  const tasks = downloadTasksRepo.listTasksByPlaylist(resolvedPlaylistId)
    .filter(t => t.songId === String(songId) && t.status === 'completed');
  for (const t of tasks) {
    // audio 缺位时回落 videoPath 仅限 file_ 上传曲：video-only 上传没有音频
    // 工件，mp4/webm 的音轨浏览器能直解（Howl format 含 mp4/webm），比 404 强。
    // bv_/yt_ 任务不回落——UI 提交恒 downloadAudio:true，出现「无 audioPath
    // 有 videoPath」的行只可能是手工 API 构造，拿 mp4 当音频源等于在 watch
    // 页外消费视频档（与「视频只在 watch 页可见」口径冲突）
    const candidate = t[field] || (kind === 'audio' && FILE_TRACK_ID_RE.test(t.songId) ? t.videoPath : null);
    if (candidate && isUnderDownloadDir(candidate) && fs.existsSync(candidate)) {
      // 文件级符号链接拒供：登记路径叶子是链接时 openSync 会跟链把下载根
      // 外的文件喂出来——isUnderDownloadDir 只验链接路径自身。目录级链接
      // 是支持的部署形态（audio/ 等整目录重定向到挂载卷），只拦叶子
      try {
        if (fs.lstatSync(candidate).isSymbolicLink()) continue;
      } catch {
        continue; // 竞态消失/不可读——按不存在收敛
      }
      return candidate;
    }
  }
  return null;
}

// 删除歌曲文件：同一首歌可能同时有独立任务和队列任务（队列全量重跑会重复落盘同一文件），
// 必须清掉全部任务行——否则删了一条后另一条仍报"已下载"指到已删文件
async function deleteSongFiles(playlistId, songId) {
  const resolvedPlaylistId = findExistingPlaylistId(playlistId);
  if (resolvedPlaylistId === null) {
    throw httpError(404, '歌单不存在');
  }

  const tasks = downloadTasksRepo.listTasksByPlaylist(resolvedPlaylistId)
    .filter(t => t.songId === String(songId));

  if (tasks.length === 0) {
    throw httpError(404, '任务不存在');
  }
  // 同上：只拒真实在跑的任务（内存控制器），孤儿 downloading 行不挡删除。
  // 僵尸协程同样算在跑——它还在写这个队列的文件
  const blocking = tasks.find(t => standaloneRunning.has(t.id)
    || (t.status === 'downloading' && t.queueId
        && queueHasLiveController(t.queueId)));
  if (blocking) {
    throw httpError(409, blocking.queueId
      ? '任务正在下载中，请先取消所在队列'
      : '任务正在下载中，请稍候再删');
  }
  // 删除窗口锁（理由同 deleteTask）：排空期间在跑判定会失效
  if (deletingPlaylists.has(resolvedPlaylistId)
      || tasks.some(t => t.queueId && deletingQueues.has(t.queueId))) {
    throw httpError(409, '该歌单或队列正在删除中');
  }

  // 行先删、文件后删（理由同 deleteTask：幻影 completed 行比孤儿文件危害大）。
  // 行删+计数重算+终态自洽同事务——半途失败不留"删了一半/计数漂移"
  getDb().transaction(() => {
    const affectedQueues = new Set();
    for (const task of tasks) {
      downloadTasksRepo.deleteTask(task.id);
      if (task.queueId) affectedQueues.add(task.queueId);
    }
    for (const qid of affectedQueues) {
      recountQueueCounters(qid);
      reconcileTerminalQueue(qid);
    }
  })();
  for (const task of tasks) retryAfter.delete(task.id);
  const allPaths = [...new Set(tasks.flatMap(t => [t.audioPath, t.lyricsPath, t.coverPath, t.videoPath]))];
  const deletedFiles = deleteFiles(allPaths);
  pruneEmptyPlaylistDirs(resolvedPlaylistId); // 与 deleteTask 同口径剪空骨架

  return { success: true, deletedFiles };
}

// 删除歌单全部已下载文件：独立任务与队列任务都处理，进行中的任务跳过
async function deletePlaylistDownloadedFiles(playlistId) {
  const resolvedPlaylistId = findExistingPlaylistId(playlistId);
  if (resolvedPlaylistId === null) {
    throw httpError(404, '歌单不存在');
  }
  // local_uploads 伪歌单是全部 file_ 上传曲的资产登记锚——批量清文件等于
  // 一键删光所有上传音源（DELETE /playlists/:id 的路由层拦截挡不住这条
  // playlistId→files 路径）。服务层收敛成不变量：要删走 /uploads/:songId 逐曲删
  const plRow = playlistsRepo.findPlaylistById(resolvedPlaylistId);
  if (plRow?.neteasePlaylistId === 'local_uploads') {
    throw httpError(400, '本地上传资产库不可批量清空');
  }
  // 删除窗口锁（理由同 deleteTask）：cascade/队列排空期间控制器已移出 Map，
  // 窗口内下载中的任务会被错判为"未在跑"而删行——协程继续写盘成孤儿
  if (deletingPlaylists.has(resolvedPlaylistId)) {
    throw httpError(409, '该歌单正在删除中');
  }
  const tasks = downloadTasksRepo.listTasksByPlaylist(resolvedPlaylistId);
  if (tasks.some(t => t.queueId && deletingQueues.has(t.queueId))) {
    throw httpError(409, '该歌单下有队列正在删除中');
  }
  const downloadedTasks = tasks.filter(
    task => !standaloneRunning.has(task.id)
      && !(task.status === 'downloading' && task.queueId
          && queueHasLiveController(task.queueId))
      // pending 行可能携已完成分段的路径（abort/重试复位不清路径字段）——
      // 那些文件属于待续跑的任务，删了会缺歌；只收终态行
      && (task.status === 'completed' || task.status === 'failed')
  );

  // 行先删、文件后删（理由同 deleteTask）；行删+计数重算+终态自洽同事务
  getDb().transaction(() => {
    const affectedQueues = new Set();
    for (const task of downloadedTasks) {
      downloadTasksRepo.deleteTask(task.id);
      if (task.queueId) affectedQueues.add(task.queueId);
    }
    for (const qid of affectedQueues) {
      recountQueueCounters(qid);
      reconcileTerminalQueue(qid);
    }
  })();
  for (const task of downloadedTasks) retryAfter.delete(task.id);
  const allPaths = [...new Set(
    downloadedTasks.flatMap(t => [t.audioPath, t.lyricsPath, t.coverPath, t.videoPath])
  )];
  const deletedFiles = deleteFiles(allPaths);
  pruneEmptyPlaylistDirs(resolvedPlaylistId); // 与 deleteTask 同口径剪空骨架

  return {
    success: true,
    deletedSongs: downloadedTasks.length,
    deletedFiles
  };
}

// 删除歌单前清理：中止该歌单的活跃队列与 standalone 任务、排空后收集待删文件路径
// 返回给调用方（真正的 unlink 在行删除事务提交后，见 deletePlaylistCascade）。
// 排空保证 "写完未记档" 的文件路径也被最终快照收集到。
// 本函数不管 deletingPlaylists 锁——由 deletePlaylistCascade 在外层持有到行删除后。
// 锁外调用会让"排空集合建立"与"行删除"之间开窗（新协程写入成孤儿）——契约断言
async function deletePlaylistFiles(playlistId) {
  if (!deletingPlaylists.has(playlistId)) {
    throw new Error('deletePlaylistFiles 必须在 deletingPlaylists 锁内调用');
  }
  {
    const drains = [];
    const drainedControllers = new Set(); // 追踪 drain 超时后仍在跑的协程
    for (const map of [activeQueues, drainingQueues]) {
      for (const [queueId, controller] of map) {
        const queue = downloadQueuesRepo.findQueueById(queueId);
        if (queue && queue.playlistId === playlistId) {
          abortController(controller);
          map.delete(queueId);
          drainedControllers.add(controller);
          drains.push(controller.done);
        }
      }
    }

    // 该歌单的 standalone 单曲下载同样要中止并排空——原先这些任务无 signal，
    // 歌单删了流还继续写，产出整套孤儿文件
    const playlistTasks = downloadTasksRepo.listTasksByPlaylist(playlistId);
    const playlistTaskIds = new Set(playlistTasks.map(t => t.id));
    for (const [taskId, entry] of standaloneRunning) {
      if (playlistTaskIds.has(taskId)) {
        entry.abort.abort();
        drains.push(entry.done);
      }
    }

    // 排空有时限：不可中止的上游调用（解锁/取链）不能让 HTTP 请求死等
    await Promise.all(drains.map(d => drainWithTimeout(d)));
    // drain 超时仍未 settle 的协程可能还在写本歌单的文件——追进僵尸集，
    // 否则后续 shutdownAll/重扫都摸不到它
    for (const c of drainedControllers) {
      if (!c.settled) zombieControllers.add(c);
    }

    // 等待窗口内漏网者重扫：并发 cancelQueue 会把控制器新搬进 drainingQueues，
    // startQueue/retryTask 虽已拦 deletingPlaylists，仍兜底重扫三个 Map。
    // 并行排空——串行 await 会让 k 个卡死控制器拖累成 k×DRAIN_TIMEOUT
    const rescan = [];
    for (const map of [activeQueues, drainingQueues]) {
      for (const [queueId, controller] of map) {
        const queue = downloadQueuesRepo.findQueueById(queueId);
        if (queue && queue.playlistId === playlistId) {
          abortController(controller);
          map.delete(queueId);
          rescan.push(drainWithTimeout(controller.done).then(() => {
            if (!controller.settled) zombieControllers.add(controller);
          }));
        }
      }
    }
    const freshTaskIds = new Set(
      downloadTasksRepo.listTasksByPlaylist(playlistId).map(t => t.id)
    );
    for (const [taskId, entry] of standaloneRunning) {
      if (freshTaskIds.has(taskId)) {
        entry.abort.abort();
        rescan.push(drainWithTimeout(entry.done));
      }
    }
    // 僵尸协程兜底：timeout-release 后不在任何 Map 但可能还在写本歌单的文件
    for (const z of zombieControllers) {
      if (z.playlistId === playlistId) {
        abortController(z);
        rescan.push(drainWithTimeout(z.done));
      }
    }
    await Promise.all(rescan);

    // 排空后再取一次任务快照：窗口内漏网的新建行也一并清文件。
    // 只收集不删——文件 unlink 推迟到行删除事务提交后（行先删、文件后删：
    // 崩溃留孤儿文件可被整目录清扫兜底，幻影 completed 行却会静默缺歌）
    return downloadTasksRepo.listTasksByPlaylist(playlistId)
      .flatMap(t => [t.audioPath, t.lyricsPath, t.coverPath, t.videoPath]);
  }
}

// 空目录修剪：type 目录与歌单根目录仅全空才删——同歌单其他任务
// （standalone/兄弟队列）的文件在场时 rmdirSync 安全跳过
function pruneEmptyPlaylistDirs(playlistId) {
  const playlistDir = path.join(DOWNLOAD_BASE_DIR, String(playlistId));
  try {
    // 规范数字目录名闸（reapOrphanFiles 同口径）：函数已透出给测试，
    // 'uploads'/'x' 这类非歌单 id 一律不碰——本应用的目录永远是纯数字
    const name = String(playlistId);
    if (!/^\d+$/.test(name) || name !== String(Number(name)) || Number(name) <= 0) return;
    if (!isUnderDownloadDir(playlistDir)) return;
    // 在途写者闸：同歌单兄弟任务的锁键持满 processTask 全程——fetch
    // 等待期 type 目录真空，盲剪会抽走 mkdir→createWriteStream 间隙的
    // 目录（ENOENT 靠重试自愈但烧 retryCount），有持锁者本轮不剪
    for (const k of activePaths) {
      if (k.startsWith(playlistDir + path.sep)) return;
    }
    for (const sub of ['audio', 'lyrics', 'covers', 'videos']) {
      const subDir = path.join(playlistDir, sub);
      // symlink/junction 不剪：Windows 下 rmdirSync 拆的是链接本身——
      // 用户的目录重定向布置不该被顺手拆掉（reapOrphanFiles 同口径）
      if (fs.existsSync(subDir) && !fs.lstatSync(subDir).isSymbolicLink()
          && fs.readdirSync(subDir).length === 0) {
        fs.rmdirSync(subDir);
      }
    }
    if (fs.existsSync(playlistDir) && !fs.lstatSync(playlistDir).isSymbolicLink()
        && fs.readdirSync(playlistDir).length === 0) {
      fs.rmdirSync(playlistDir);
    }
  } catch {
    // 目录清理失败无害——跳过不阻塞删除流程
  }
}

// 行删除事务提交后执行文件与目录清理（配合 deletePlaylistFiles 的返回值）
function cleanupPlaylistFilesAndDirs(playlistId, filePaths) {
  deleteFiles(filePaths);
  pruneEmptyPlaylistDirs(playlistId);
}

// 歌单删除的完整级联：deletingPlaylists 锁必须持到 playlist 行级联删除之后才释放——
// 否则锁释放到行删除之间的窗口里 downloadSingleSong/createDownloadQueue 可过检查
// 建新行，行随即被级联删掉，在途流成孤儿。路由只调本函数，不单独调 deletePlaylist
async function deletePlaylistCascade(playlistId) {
  // 可重入防护：两个并发 DELETE 会重复排空 + 第二个拿到误导性的 404
  if (deletingPlaylists.has(playlistId)) {
    throw httpError(409, '该歌单正在删除中');
  }
  deletingPlaylists.add(playlistId);
  // tombstoneRow 的读取必须在 try 内：findPlaylistById 抛瞬时 DB 错时若锁已
  // 登记而 finally 不执行 → 该歌单被"正在删除中"封禁到进程重启
  let tombstoneNeteaseId = null;
  try {
    // 按网易云 id 记墓碑：级联删除期间到达的导入 upsert 会以同一
    // netease_playlist_id 重建新行（本地 id 全新，deletingPlaylists 拦不住）
    const tombstoneRow = playlistsRepo.findPlaylistById(playlistId);
    // local_uploads 伪歌单是全部 file_ 上传资产的登记锚——级联会删行并清掉
    // 所有上传音源（曲目还在但资产没了）。队列删除升级为级联后这条径也通到
    // 这里，路由层拦截只管 DELETE /playlists/:id 一路——不变量收敛在服务层
    if (tombstoneRow?.neteasePlaylistId === 'local_uploads') {
      throw httpError(400, '本地上传资产库不可删除');
    }
    // 墓碑只兜「在途上游导入复活已删行」一条竞态——importPlaylistFromNetease
    // 的准入闸（resolvePlaylistId 与 /playlists/import 同口径）只放纯数字 id，
    // local_pl_/saved_queue_ 等本地命名空间永远走不到那条路：给它们立碑零防护
    // 价值，却把镜像重放（mirror 路由前置 + local-mirror 事务内复查）封禁满
    // TTL。镜像行的复活竞态由 deletingPlaylists 行锁（持满级联全程）+ 镜像
    // 事务内行 id 复查覆盖——同步单事务无在途 fetch 窗，不需要 netease 域墓碑
    if (tombstoneRow?.neteasePlaylistId
        && NETEASE_ID_RE.test(String(tombstoneRow.neteasePlaylistId))) {
      tombstoneNeteaseId = String(tombstoneRow.neteasePlaylistId);
      // 级联进行中 = Infinity（在途墓碑），见 deletion-locks.js 生命周期说明
      deletingNeteasePlaylists.set(tombstoneNeteaseId, Infinity);
    }
    const pendingFiles = await deletePlaylistFiles(playlistId);
    // 排空快照与删行事务之间隔着一次 microtask 跳变——漏网协程在此窗内写完
    // 记档的路径会逃出 pendingFiles。事务前重取任务快照求并集把窗口归零；
    // 同时这份快照就是待删 taskIds 的来源
    const finalTasks = downloadTasksRepo.listTasksByPlaylist(playlistId);
    const taskIds = finalTasks.map(t => t.id);
    const allPendingFiles = [...new Set([
      ...pendingFiles,
      ...finalTasks.flatMap(t => [t.audioPath, t.lyricsPath, t.coverPath, t.videoPath])
    ])];
    // 显式删子表行：FK 级联依赖建表期声明，老库 ALTER 补的列可能没带
    // REFERENCES/ON DELETE CASCADE——不能把行删除押在 schema 史上。
    // 三条 DELETE 同事务：半途失败整体回滚，不留子表已删父表还在的不一致
    const deleted = getDb().transaction(() => {
      for (const id of taskIds) {
        downloadTasksRepo.deleteTask(id);
      }
      downloadQueuesRepo.deleteQueuesByPlaylist(playlistId);
      return playlistsRepo.deletePlaylist(playlistId);
    })();
    for (const id of taskIds) retryAfter.delete(id);
    // 行删提交后再清文件与目录骨架（见 deletePlaylistFiles 尾注）
    cleanupPlaylistFilesAndDirs(playlistId, allPendingFiles);
    return deleted;
  } finally {
    deletingPlaylists.delete(playlistId);
    if (tombstoneNeteaseId) {
      // 不立即删墓碑：级联毫秒级完成而导入的 upstream fetch 最长 ~120s——
      // 立即释放会让"删除先于在途 fetch 返回"的导入照样复活行。
      // TTL 化成短期墓碑，窗口内再导入收到可重试的 409
      markNeteasePlaylistDeleted(tombstoneNeteaseId);
    }
  }
}

async function retryTask(taskId) {
  if (shuttingDown) {
    throw httpError(409, '服务正在停机');
  }

  const task = downloadTasksRepo.findTaskById(taskId);
  if (!task) {
    throw httpError(404, '任务不存在');
  }
  // 失败任务可重试；standalone 崩溃残留的 pending（无人消费）也允许就地重跑；
  // queue_id 指向已删队列的 pending 孤儿行同此——没有消费者会捞它。
  // 在跑任务排除——standalone 协程的重试退避间隙 status 恰为 pending，
  // 放行会先动行再被 runStandaloneTask 409，状态已被污染
  const orphanedPending = task.status === 'pending'
    && (!task.queueId || !downloadQueuesRepo.findQueueById(task.queueId));
  // standalone 行钉死 downloading（终态写全部失败后）：与孤儿 pending 同质——
  // 无消费者。队列行的同款情形由 processQueue 的 converge 与重启期
  // recoverStaleStates 覆盖，不在此放宽（有活体协程语义要守）
  const orphanedDownloading = task.status === 'downloading' && !task.queueId;
  const retriable = (task.status === 'failed' || orphanedPending || orphanedDownloading)
    && !standaloneRunning.has(taskId);
  if (!retriable) {
    throw httpError(409, '只能重试失败的任务');
  }

  // 歌单删除窗口内重跑 standalone 会让在途流在行级联删除后继续写孤儿文件。
  // 必须在写库前置检——否则先复位 pending 再抛错，留一次无意义写
  if (deletingPlaylists.has(task.playlistId)) {
    throw httpError(409, '该歌单正在删除中');
  }
  // 队列删除窗口同理：对将被删的行做复位/计数是无意义写，且结果可能落空
  if (task.queueId && deletingQueues.has(task.queueId)) {
    throw httpError(409, '所在队列正在删除中');
  }

  const queue = task.queueId ? downloadQueuesRepo.findQueueById(task.queueId) : null;

  // queueId 指向已不存在的队列（孤儿行）时一并归位 standalone——
  // 否则任务永远绑着死队列。复位+计数重算+队列状态回 pending 同事务：
  // 半途失败不留"任务复位了队列还在 failed"（failed 队列拒绝 start）
  // 复位时顺手刷新 providerData——镜像行的 title/author/neteaseId 可能比
  // 建行时新（改题/重匹配），旧快照会让歌词归属核验按陈旧签名放行
  const trackRow = playlistTracksRepo.findTrackBySongId(task.playlistId, task.songId);
  const freshProviderData = trackRow ? providerDataOf(trackRow) : undefined;

  getDb().transaction(() => {
    downloadTasksRepo.updateTask(taskId, {
      ...resetTaskFields(queue ? {} : { queueId: null }),
      ...(freshProviderData !== undefined ? { providerData: freshProviderData } : {})
    });
    if (queue) {
      recountQueueCounters(queue.id);
      if (queue.status === 'failed' || queue.status === 'completed' || queue.status === 'cancelled') {
        downloadQueuesRepo.updateQueue(queue.id, {
          status: 'pending',
          completedAt: null
        });
      }
    }
  })();
  retryAfter.delete(taskId); // 人工重试即用户明确再等——退避不该挡它
  deleteFiles([task.audioPath, task.lyricsPath, task.coverPath, task.videoPath]); // 行先清文件后删

  if (queue) {
    // 队列置回 pending 后没有消费者——"重试"语义上应当即跑，
    // 否则任务永远停在"等待中"直到用户手动启动
    try {
      await startQueue(queue.id);
    } catch (e) {
      // 排空窗口内（draining）启动会 409——任务仍 pending，等下一次启动接管。
      // 非 409 是真故障，至少留痕
      if (e?.status !== 409) console.error(`队列 ${queue.id} 自动重启失败:`, e);
    }
    return downloadTasksRepo.findTaskById(taskId);
  }

  // 独立任务没有队列消费 pending——就地起后台协程；并发删除窗口内行可能已消失。
  // 提交即返回（与单曲下载同一异步语义），调用方轮询任务状态看终态
  const fresh = downloadTasksRepo.findTaskById(taskId);
  if (!fresh) {
    throw httpError(404, '任务不存在');
  }
  return dispatchStandalone(fresh);
}

async function retryQueue(queueId) {
  if (shuttingDown) {
    throw httpError(409, '服务正在停机');
  }

  const queue = downloadQueuesRepo.findQueueById(queueId);
  if (!queue) {
    throw httpError(404, '队列不存在');
  }

  // 运行中队列重置 failed→pending 会产生两套调度来源（活控制器与新协程），
  // 且 status=pending 覆写 running 造成状态漂移——要求先取消再重试。
  // draining 同理：排空协程的 abort-reset 会与新调度来源交错
  if (queueHasLiveController(queueId)) {
    throw httpError(409, '队列正在运行中，请先取消');
  }
  if (deletingQueues.has(queueId)) {
    throw httpError(409, '队列正在删除中');
  }
  if (deletingPlaylists.has(queue.playlistId)) {
    throw httpError(409, '该歌单正在删除中');
  }

  const tasks = downloadTasksRepo.listTasksByQueue(queueId);
  const failedTasks = tasks.filter(task => task.status === 'failed');

  if (failedTasks.length === 0) {
    // 无 failed 但还有 pending/downloading 行（崩溃兜底回 pending、删除路径
    // 收回、状态写失败钉死的行）——「没有可重试任务」会把这批行永久搁浅：
    // failed_tasks=0 时 start 拒终态、retry 拒无失败，任何入口都不通。
    // 退化为启动语义让协程正常消费/收尾（含无主 downloading 行的收敛）
    if (tasks.some(t => t.status === 'pending' || t.status === 'downloading')) {
      return startQueue(queueId);
    }
    throw httpError(400, '没有可重试的失败任务');
  }

  // 行更新+队列状态同事务：半途失败不留"部分任务复位、队列还停在 failed"。
  // retryCount 必须重置——否则 retryCount=3 的任务重试一次又判死
  // providerData 一并刷新到最新镜像行：title/author/neteaseId 会变。
  // 同 song_id 重复行取首个——与 createQueue 的 seen 去重/retryTask 的
  // find 同口径，三处对同一首歌必须取同一行
  const mirrorRows = playlistTracksRepo.listTracksByPlaylistId(queue.playlistId);
  const providerMap = new Map();
  for (const t of mirrorRows) {
    const k = String(t.id);
    if (!providerMap.has(k)) providerMap.set(k, providerDataOf(t));
  }
  const resetPaths = [];
  getDb().transaction(() => {
    for (const task of failedTasks) {
      const freshProviderData = providerMap.get(String(task.songId));
      downloadTasksRepo.updateTask(task.id, {
        ...resetTaskFields(),
        ...(freshProviderData !== undefined ? { providerData: freshProviderData } : {})
      });
      resetPaths.push(task.audioPath, task.lyricsPath, task.coverPath, task.videoPath);
    }
    // completedTasks 不动：失败任务从未计入完成数；复位后的计数由任务行重算
    downloadQueuesRepo.updateQueue(queueId, {
      status: 'pending',
      completedAt: null
    });
    recountQueueCounters(queueId);
  })();
  for (const task of failedTasks) retryAfter.delete(task.id);
  deleteFiles(resetPaths); // 行先清、文件后删

  // 重试即启动：pending 队列没有消费者，用户预期"重试"是直接跑起来
  try {
    await startQueue(queueId);
  } catch {
    // 理论不可达（活体控制器已前置拦截）——保守起见仍返回重置后的队列
  }

  return downloadQueuesRepo.findQueueById(queueId);
}

// 停机：abort 全部活跃控制器（队列 + standalone）并排空在途任务收尾，
// 否则被 SIGKILL 窗口截断的半成品文件无人清理
async function shutdownAll() {
  shuttingDown = true;
  const drains = [];
  const tracked = new Set(); // 排空超时仍在跑的要追进僵尸集——Map clear 后就摸不到了
  for (const map of [activeQueues, drainingQueues]) {
    for (const [queueId, controller] of map) {
      abortController(controller);
      drains.push(controller.done);
      tracked.add(controller);
      try {
        downloadQueuesRepo.updateQueue(queueId, { status: 'cancelled' });
      } catch { /* 停机路径尽力而为 */ }
    }
  }
  activeQueues.clear();
  drainingQueues.clear();

  // 僵尸协程也中止排空——它们已不在任何 Map，不扫就会漏掉在途的流
  for (const z of zombieControllers) {
    abortController(z);
    drains.push(z.done);
  }

  for (const entry of standaloneRunning.values()) {
    entry.abort.abort();
    drains.push(entry.done);
  }

  // 停机排空预算必须小于进程强退窗口（server 端 10s 强退兜底）——
  // 用默认 30s 排空会让强退永远先触发，半成品文件照样成孤儿
  await Promise.all(drains.map(d => drainWithTimeout(d, 5000)));

  // 排空超时仍在跑的协程追进僵尸集——与其他排空路径同一处理：
  // 进程强退前它们还可能翻转任务行，settle 时的幂等 recount 收掉漂移
  for (const controller of tracked) {
    if (!controller.settled) zombieControllers.add(controller);
  }

  // 复位写逐行容错——DB 故障时一行写挂不该中断剩余行的复位
  // （recoverStaleStates 下次启动同口径收敛，这里只尽量多救）
  for (const task of downloadTasksRepo.listTasksByStatus('downloading')) {
    try {
      downloadTasksRepo.updateTask(task.id, {
        status: task.queueId ? 'pending' : 'failed',
        errorMessage: '服务停机中断'
      });
    } catch { /* 剩余行继续 */ }
  }
  // 与 recoverStaleStates 同口径：无消费者的 standalone pending 是死态
  for (const task of downloadTasksRepo.listTasksByStatus('pending')) {
    if (!task.queueId) {
      try {
        downloadTasksRepo.updateTask(task.id, {
          status: 'failed',
          errorMessage: '服务停机中断'
        });
      } catch { /* 剩余行继续 */ }
    }
  }
}

// 启动期孤儿文件清扫（仅限启动调用：运行期"文件写完未落库"窗口会误删在途落盘）。
// 崩溃/SIGKILL/OOM 截断在途流会把半成品留在最终文件名上而路径从未落库
// （FD pipeline 完成与 updateTask 之间、行删与 unlink 之间）。
// DB 是唯一事实源——歌单目录在 playlists 表里无行的整棵删除；歌单还在的，
// audio/lyrics/covers/videos 子目录里未被任何任务行引用的文件删除。
// 保守边界：只动 downloads/<规范数字目录名>/{audio,lyrics,covers,videos} 下的文件；
// 空库（DB 丢失/新建）不判任何目录为孤儿——丢一个 DB 文件不该抹掉下载库；
// symlink 一律跳过（lstat 不跟随）——downloads/<id>/audio 链到大盘时不得
// 顺着链接删光目标目录；目录搬迁特征（登记路径全在 base 外）跳过并告警
// uploads/ 半成品收割：POST /uploads 的 .part 残片在进程崩溃/SIGKILL 时无
// catch 兜底（正常错误路径自收）。只删 *.part 且 mtime>60s——在写文件不吃。
// 独立于下面的空库/空任务表护栏：.part 永不进登记行，任何 DB 态下删都安全
function reapUploadPartFiles() {
  let removed = 0;
  const root = path.join(DOWNLOAD_BASE_DIR, 'uploads');
  // 根也要 lstat——existsSync 跟随 symlink，子目录有闸根没有就不对称
  try {
    if (!fs.lstatSync(root).isDirectory()) return removed;
  } catch { return removed; }
  for (const sub of fs.readdirSync(root, { withFileTypes: true })) {
    if (!sub.isDirectory()) continue;
    const dir = path.join(root, sub.name);
    // lstat 不跟随：symlink 子目录整段跳过——顺链接会删到目标目录的真文件
    if (!fs.lstatSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.part')) continue;
      const fp = path.join(dir, f);
      try {
        const st = fs.statSync(fp);
        if (Date.now() - st.mtimeMs < 60000) continue;
        fs.rmSync(fp, { force: true });
        removed += 1;
      } catch { /* 单文件失败不阻塞整体清扫 */ }
    }
  }
  return removed;
}

function reapOrphanFiles() {
  let removedDirs = 0;
  let removedFiles = 0;
  try {
    if (!fs.existsSync(DOWNLOAD_BASE_DIR)) return { removedDirs, removedFiles };
    removedFiles += reapUploadPartFiles();
    // 空库护栏：getDb 会对缺失/损坏的 sqlite 自动建空库——此时 playlists 表
    // 为空，若无护栏整棵 downloads 树都会被当作"无歌单"删掉。新装不会有
    // downloads 内容，跳过清扫零代价
    if (playlistsRepo.listPlaylists().length === 0) return { removedDirs, removedFiles };
    // 对称护栏：playlists 非空但任务表为空/被清空（部分备份恢复）时，每个歌单
    // 目录的 referenced 都为空集——按"未登记=孤儿"会把全部在册文件删光，
    // 与空 playlists 库是同一类 DB 丢失信号；若磁盘上确有内容，跳过要留痕
    if (getDb().prepare('SELECT COUNT(*) AS c FROM download_tasks').get().c === 0) {
      // 下载目录也为空是常态（歌单在、还没下载过）——只有磁盘确有规范歌单
      // 目录时才是"任务表疑似丢失"信号；.DS_Store/lost+found 之类不算内容
      const hasContent = fs.readdirSync(DOWNLOAD_BASE_DIR)
        .some(n => /^\d+$/.test(n) && n === String(Number(n)) && Number(n) > 0);
      if (hasContent) {
        console.warn('[downloads] 任务表为空但歌单与下载文件存在（疑似任务表丢失），跳过孤儿文件清扫');
      }
      return { removedDirs, removedFiles };
    }
    for (const entry of fs.readdirSync(DOWNLOAD_BASE_DIR, { withFileTypes: true })) {
      try { // 单个坏条目（EPERM/ENOTDIR/BUSY）不中止后续歌单目录的清扫
        // isDirectory 不跟随 symlink（顶层安全）；目录名必须是规范数字形式——
        // '007' 这类非规范名不是本应用产物，跳过而不是按 playlist 7 处理
        if (!entry.isDirectory() || !/^\d+$/.test(entry.name)
            || entry.name !== String(Number(entry.name))) continue;
        const playlistId = Number(entry.name);
        if (playlistId <= 0) continue; // '0' 规范但绝非本应用产物
        const playlistDir = path.join(DOWNLOAD_BASE_DIR, entry.name);
        if (!playlistsRepo.findPlaylistById(playlistId)) {
          fs.rmSync(playlistDir, { recursive: true, force: true });
          removedDirs += 1;
          continue;
        }
        // Windows 的 path.relative 大小写不敏感（isUnderDownloadDir 对
        // 'D:\Data' vs 'd:\data' 判"内"），但 Set 比对是大小写敏感的纯
        // 字符串相等——盘符/大小写写法变更会打穿护栏把全部在册文件当孤儿删。
        // win32 下双端统一小写归一
        const normalizePath = p => {
          const r = path.resolve(p);
          return process.platform === 'win32' ? r.toLowerCase() : r;
        };
        const referenced = new Set(
          downloadTasksRepo.listTasksByPlaylist(playlistId)
            .flatMap(t => [t.audioPath, t.lyricsPath, t.coverPath, t.videoPath])
            .filter(Boolean)
            .map(normalizePath)
        );
        // 搬迁特征：DATA_DIR/DOWNLOAD_DIR 改路径或卷整体移动后，存量登记路径
        // 指向旧位置——此时按"未登记=孤儿"会把仍在册的文件全删光，留幻影
        // completed 行指向已删文件。只要有任一登记路径落在 base 外就是异常
        // 信号（混合新旧路径正是"搬迁后又下过新歌"的形态），宁可不扫
        if ([...referenced].some(p => !isUnderDownloadDir(p))) {
          console.warn(`[downloads] 歌单 ${playlistId} 存在下载根之外的登记路径（疑似目录搬迁/脏行），跳过清扫`);
          continue;
        }
        for (const sub of ['audio', 'lyrics', 'covers', 'videos']) {
          const subDir = path.join(playlistDir, sub);
          // lstat 不跟随：symlink 子目录整段跳过——顺着链接会删到目标目录的真文件
          if (!fs.existsSync(subDir) || !fs.lstatSync(subDir).isDirectory()) continue;
          for (const f of fs.readdirSync(subDir)) {
            const fp = path.join(subDir, f);
            try {
              if (referenced.has(normalizePath(fp)) || !fs.lstatSync(fp).isFile()) continue;
              // 新鲜文件不删：共享 DATA_DIR 的多实例/重叠拉起场景下，另一进程
              // 可能正在写这个 .part 或刚 rename 未登记——mtime 在 60s 内的
              // 文件留给下一轮启动清扫（单实例下该护栏不生效：启动时没有在写者）
              const st = fs.statSync(fp);
              if (Date.now() - st.mtimeMs < 60000) continue;
              fs.rmSync(fp, { force: true });
              removedFiles += 1;
            } catch { /* 单个文件失败不阻塞整体清扫 */ }
          }
        }
        // 空目录骨架复用现有剪枝（参数为空数组即只剪不删文件）
        cleanupPlaylistFilesAndDirs(playlistId, []);
      } catch (error) {
        console.warn(`[downloads] 清扫歌单目录 ${entry.name} 失败:`, error?.message || error);
      }
    }
  } catch (error) {
    console.warn('[downloads] 孤儿文件清扫失败:', error?.message || error);
  }
  if (removedDirs > 0 || removedFiles > 0) {
    console.log(`[downloads] 孤儿清理: ${removedDirs} 个目录, ${removedFiles} 个文件`);
  }
  return { removedDirs, removedFiles };
}

// 启动恢复：上次崩溃/强杀残留的 running/paused 队列与 downloading 任务
// 没有任何内存控制器了，复位为 pending 让用户可再次启动
function recoverStaleStates() {
  for (const queue of downloadQueuesRepo.listQueues()) {
    if (queue.status === 'running' || queue.status === 'paused') {
      downloadQueuesRepo.updateQueue(queue.id, { status: 'pending' });
    }
  }
  for (const task of downloadTasksRepo.listTasksByStatus('downloading')) {
    downloadTasksRepo.updateTask(task.id, {
      // standalone 置 failed：无消费者的 pending 是死态（UI 对 pending 藏
      // 删除键、重试只认 failed），failed 行才有重试+删除入口
      status: task.queueId ? 'pending' : 'failed',
      progress: 0,
      errorMessage: '服务重启中断'
    });
  }
  // 退避协程内被 SIGKILL 的 standalone 停在 pending——同样是孤儿死态，一并收敛
  for (const task of downloadTasksRepo.listTasksByStatus('pending')) {
    if (!task.queueId) {
      downloadTasksRepo.updateTask(task.id, {
        status: 'failed',
        progress: 0,
        errorMessage: '服务重启中断'
      });
    }
  }
  // 老库 playlist_id/queue_id 是 ALTER 补列、无 FK 级联——父行已删的子行残留
  // 会成幻影 completed（指向已删文件），孤儿行在启动时清理。
  // 顺序：孤儿队列先删（其 playlist 缺失），再按 queue/playlist 维度清任务——
  // 否则任务先清 playlist 维度会留下"queue 指向已删孤儿队列"的悬空行；
  // NULL 补列残留（老库 ALTER 默认 NULL，不可经任何接口触达）一并清；
  // playlist_tracks 孤儿行同样不可达，同一事务内收敛
  getDb().transaction(() => {
    const db = getDb();
    db.prepare('DELETE FROM download_queues WHERE playlist_id IS NULL OR playlist_id NOT IN (SELECT id FROM playlists)').run();
    db.prepare('DELETE FROM download_tasks WHERE queue_id IS NOT NULL AND queue_id NOT IN (SELECT id FROM download_queues)').run();
    db.prepare('DELETE FROM download_tasks WHERE playlist_id IS NULL OR playlist_id NOT IN (SELECT id FROM playlists)').run();
    db.prepare('DELETE FROM playlist_tracks WHERE playlist_id IS NULL OR playlist_id NOT IN (SELECT id FROM playlists)').run();
  })();
  // 全量计数重算：迁移期去重删行、崩溃窗口漏配等历史漂移在启动时一次性收敛——
  // recount 幂等且空变化不写 updated_at，成本可以忽略
  for (const queue of downloadQueuesRepo.listQueues()) {
    recountQueueCounters(queue.id);
  }
}

module.exports = {
  createDownloadQueue,
  startQueue,
  pauseQueue,
  resumeQueue,
  cancelQueue,
  deleteQueue,
  deleteTask,
  deletePlaylistFiles,
  deletePlaylistCascade,
  retryTask,
  retryQueue,
  getQueueProgress,
  listTasks,
  downloadSingleSong,
  getSongDownloadStatus,
  getTaskArtifactPath,
  toPublicTask,
  providerDataOf,
  deleteSongFiles,
  deletePlaylistDownloadedFiles,
  recoverStaleStates,
  reapOrphanFiles,
  shutdownAll,
  isShuttingDown: () => shuttingDown,
  // 测试缝：剪目录的持锁闸只有 activePaths 可注入才能确定性地打——
  // 生产路径照常走 deleteTask/deleteSongFiles/deletePlaylistDownloadedFiles
  pruneEmptyPlaylistDirs,
  activePaths
};

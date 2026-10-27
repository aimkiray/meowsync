// 下载栈三层（download-io/download-fs/file-downloader/download-manager）的调用级
// smoke——搬移式重构曾引入「require 不炸、调用才炸」的自由变量断链
// （fileDownloader.sanitizeFilename 残留、AUDIO_EXTS/DRAIN_TIMEOUT_MS 漏导入），
// 纯加载测试抓不住。这里的用例真的调用跨层函数，钉住整条引用链。
// DATA_DIR 指向临时目录：download-fs 的 DOWNLOAD_BASE_DIR 与 repo 都建在其下。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { mkdirSync, writeFileSync, existsSync, symlinkSync, readdirSync, statSync } from 'node:fs';
import { tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-dlstack-');
const require = createRequire(import.meta.url);

let io, fs, fd, dm, playlistsRepo, downloadTasksRepo;
before(() => {
  io = require('../src/server/services/download-io.js');
  fs = require('../src/server/services/download-fs.js');
  fd = require('../src/server/services/file-downloader.js');
  dm = require('../src/server/services/download-manager.js');
  playlistsRepo = require('../src/server/repositories/playlists.js');
  downloadTasksRepo = require('../src/server/repositories/downloadTasks.js');
});

const task = (over = {}) => ({
  id: 1, playlistId: 999, songId: 'bv_BV1xx411c7mD', songName: '歌名?', artist: 'UP:主',
  coverUrl: '', downloadAudio: true, downloadLyrics: true, downloadCover: false, downloadVideo: false,
  ...over
});

test('io→fs 原语链：sanitizeFilename/memoSanitize/getSafeSongId 可达且输出合法', () => {
  // 直调 io 层（非法字符→下划线，Windows 保留名兜底）
  assert.equal(io.sanitizeFilename('a/b\\c:d'), 'a_b_c_d');
  // fs 层 memoSanitize 是这条链曾经的断点（fileDownloader 残留引用）
  assert.equal(fs.memoSanitize('x<y', 90), 'x_y');
  // 非数字 songId（bv_/yt_/qq_）回落 task-<rowid>；数字 id（网易云）原样用
  assert.equal(fs.getSafeSongId(task()), 'task-1');
  assert.equal(fs.getSafeSongId(task({ songId: '12345' })), '12345');
});

test('taskLockKeys 走通 repo+路径链：锁键全部落在下载根内且含消毒后名字', () => {
  const keys = fs.taskLockKeys(task());
  assert.equal(keys.length, 2); // audio + lyrics（无 coverUrl/video 位）
  for (const k of keys) {
    assert.ok(fs.isUnderDownloadDir(k), `${k} 须在下载根内`);
    assert.ok(k.includes('UP_主 - 歌名_'), '消毒后的 artist/name 应进文件名');
  }
});

test('toPublicTask 不泄漏绝对路径', () => {
  const abs = join(fs.DOWNLOAD_BASE_DIR, '999', 'audio', 'a.mp3');
  const pub = fs.toPublicTask(task({ audioPath: abs, status: 'completed' }));
  assert.equal(pub.audioPath, '999/audio/a.mp3');
  assert.ok(!JSON.stringify(pub).includes(fs.DOWNLOAD_BASE_DIR), '公共投影不得含绝对根');
});

test('toPublicTask.filesIntact：冷 miss 不落同步 stat——缺省返回，后台探测后轮询见真值', async () => {
  const aud = join(fs.DOWNLOAD_BASE_DIR, '880021', 'audio', 's-intact.mp3');
  mkdirSync(dirname(aud), { recursive: true });
  writeFileSync(aud, 'a');
  const t = task({ id: 880021, status: 'completed', audioPath: aud, downloadLyrics: false });
  // 冷 miss：投影路径不拿响应线程换真值——字段缺省（前端 !==false 口径即
  // 「未知按在位」），有界并发池后台探测结果下一轮轮询生效
  assert.equal(fs.toPublicTask(t).filesIntact, undefined);
  await new Promise(r => setTimeout(r, 80));
  assert.equal(fs.toPublicTask(t).filesIntact, true);
  // 幻影行同路径：登记档不在盘——冷 miss 缺省，探测落 cache 后如实报缺
  const ghost = task({
    id: 880022, status: 'completed', downloadLyrics: false,
    audioPath: join(fs.DOWNLOAD_BASE_DIR, '880021', 'audio', 'gone.mp3')
  });
  assert.equal(fs.toPublicTask(ghost).filesIntact, undefined);
  await new Promise(r => setTimeout(r, 80));
  assert.equal(fs.toPublicTask(ghost).filesIntact, false);
});

test('getTaskArtifactPath：文件级 symlink 拒供，目录级链接放行', () => {
  const pl = playlistsRepo.upsertPlaylist({ neteasePlaylistId: 'local_pl_flink', name: 'flink' });
  const plDir = join(fs.DOWNLOAD_BASE_DIR, String(pl.id));
  const outsideDir = join(dirname(fs.DOWNLOAD_BASE_DIR), 'flink-outside');
  const outsideFile = join(outsideDir, 'real.mp3');
  const linkLeaf = join(plDir, 'audio', 'leaf.mp3');
  mkdirSync(dirname(linkLeaf), { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(outsideFile, 'outside-bytes');
  try {
    symlinkSync(outsideFile, linkLeaf);
  } catch {
    return; // 平台不许建链接（Windows 未开开发者模式）——本用例无意义
  }
  const t = downloadTasksRepo.createTask({
    playlistId: pl.id, queueId: null, songId: 's-flink', songName: 'n', artist: 'a',
    status: 'completed'
  });
  downloadTasksRepo.updateTask(t.id, { audioPath: linkLeaf });
  assert.equal(dm.getTaskArtifactPath(pl.neteasePlaylistId, 's-flink', 'audio'), null,
    '叶子是符号链接的登记档不得供出——existsSync 跟链真在也拒');

  // 对照：目录级链接是支持的部署形态（audio/ 整目录指到挂载卷）——
  // 链接目录下的真文件照常可寻址
  const pl2 = playlistsRepo.upsertPlaylist({ neteasePlaylistId: 'local_pl_dlink', name: 'dlink' });
  const pl2Dir = join(fs.DOWNLOAD_BASE_DIR, String(pl2.id));
  mkdirSync(pl2Dir, { recursive: true });
  try {
    symlinkSync(outsideDir, join(pl2Dir, 'audio'), 'dir');
  } catch {
    return;
  }
  const viaDir = join(pl2Dir, 'audio', 'real.mp3');
  const t2 = downloadTasksRepo.createTask({
    playlistId: pl2.id, queueId: null, songId: 's-dlink', songName: 'n', artist: 'a',
    status: 'completed'
  });
  downloadTasksRepo.updateTask(t2.id, { audioPath: viaDir });
  assert.equal(dm.getTaskArtifactPath(pl2.neteasePlaylistId, 's-dlink', 'audio'), viaDir,
    '目录级链接（整卷重定向部署形态）下的真文件必须放行');
});

test('file-downloader→io 常量链：downloadCover 空 URL 走 fatalError 早退', async () => {
  // 空 URL 触发 fatalError 分支——若 io 未导出所需符号这里会 ReferenceError
  await assert.rejects(
    fd.downloadCover('', join(fs.DOWNLOAD_BASE_DIR, 't', 'covers', 'x.jpg'), null),
    /封面链接不存在/
  );
});

test('file-downloader：downloadCover 非白名单/异 scheme coverUrl 按无封面 fatal 拒取', async () => {
  // 消费点兜底闸（与 download-manager.deriveCoverUrl 同款 isImgProxyHost）：
  // 修复前落库的脏 cover_url 行不得回源任意宿主——异 scheme、非白名单域、
  // 非法 URL 全部 fatal 拒（上层把封面相位按「无封面」收敛，不重试）
  for (const bad of [
    'https://evil.example/c.jpg',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'not-a-url',
    // 点边界三形态：尾挂（白名单域作中段）、前缀蹭名、形似 126.net 的非名单域
    'https://ytimg.com.evil.example/x',
    'https://xytimg.com/x',
    'https://evil-126.net/x',
    // y.qq.com 收窄同口径：裸域与 musicu/fcg 端点子域不在封面白名单
    'https://y.qq.com/n/ryqq/playlist/8313',
    'https://u.y.qq.com/cgi-bin/musicu.fcg',
    'https://qpic.y.qq.com.evil.example/x',
  ]) {
    const err = await fd.downloadCover(bad, join(fs.DOWNLOAD_BASE_DIR, 't', 'covers', 'x.jpg'), null)
      .then(() => null, (e) => e);
    assert.equal(err?.fatal, true, `${bad} 应 fatal 拒取`);
    assert.match(err?.message || '', /白名单/);
  }
  // 白名单域过入口闸：用非标端口让下游 normalizeOutboundUrl 确定性快拒
  // （不打真网络）——能拿到「端口不受支持」说明闸没拦宿主
  for (const ok of [
    'https://i.ytimg.com:8443/vi/x/hqdefault.jpg',
    'https://music-file.y.qq.com:8443/mcover/x.jpg', // 新入白的 QQ 歌单封面宿主同口径
  ]) {
    const okErr = await fd.downloadCover(ok,
      join(fs.DOWNLOAD_BASE_DIR, 't', 'covers', 'y.jpg'), null).then(() => null, (e) => e);
    assert.ok(okErr, `${ok} 白名单域名应放行到取流阶段`);
    assert.ok(!/白名单/.test(okErr.message || ''), `${ok} 白名单域名不得被入口闸误拒`);
  }
});

test('download-manager 对上层的 re-export 面完整', () => {
  for (const name of ['providerDataOf', 'toPublicTask', 'createDownloadQueue', 'shutdownAll']) {
    assert.equal(typeof dm[name], 'function', `download-manager 应透出 ${name}`);
  }
});

test('penetratesCandidates：本地 errno fatal 穿透，DNS guard/上游 4xx 只死本条 URL', () => {
  // 本地确定性 errno（ENOSPC 等）→ 穿透候选循环
  const enospc = new Error('no space'); enospc.code = 'ENOSPC';
  assert.equal(io.penetratesCandidates(io.errnoToFatal(enospc)), true);
  // socket 层 DNS guard 拦截有合成 code 但不是本地 errno——候选级
  // （与 URL 阶段 checkHostPublic 的 fatalError 无 code 同口径）：一条
  // URL 命中私网解析不该剥夺 backup_url/下一档的机会
  const guard = new Error('blocked'); guard.code = 'ERR_DNS_GUARD_BLOCKED';
  const marked = io.errnoToFatal(guard);
  assert.equal(marked.fatal, true);
  assert.equal(io.penetratesCandidates(marked), false);
  // 上游 4xx fatalError 无 code——候选级
  assert.equal(io.penetratesCandidates(io.fatalError('HTTP 403')), false);
  // EFBIG 不再穿透：FAT32 落盘目录 4GiB 天花板是候选体积问题，低档能装
  const efbig = new Error('too big'); efbig.code = 'EFBIG';
  assert.equal(io.penetratesCandidates(io.errnoToFatal(efbig)), false);
});

// pruneEmptyPlaylistDirs：deleteTask/deleteSongFiles/deletePlaylistDownloadedFiles
// 共用的骨架清理——只有全空才剪，持锁/符号链接/越界三种保命闸各有专测。

test('pruneEmptyPlaylistDirs：四类子目录全空 → 连歌单根一起剪', () => {
  const plDir = join(fs.DOWNLOAD_BASE_DIR, '880011');
  for (const sub of ['audio', 'lyrics', 'covers', 'videos']) {
    mkdirSync(join(plDir, sub), { recursive: true });
  }
  dm.pruneEmptyPlaylistDirs(880011);
  assert.ok(!existsSync(plDir), '全空的歌单目录应整个消失');
});

test('pruneEmptyPlaylistDirs：兄弟任务的文件在场 → 该目录与歌单根都留', () => {
  const plDir = join(fs.DOWNLOAD_BASE_DIR, '880012');
  for (const sub of ['audio', 'lyrics', 'covers', 'videos']) {
    mkdirSync(join(plDir, sub), { recursive: true });
  }
  writeFileSync(join(plDir, 'audio', 'sibling.mp3'), 'x'); // 别条任务的文件
  dm.pruneEmptyPlaylistDirs(880012);
  assert.ok(existsSync(join(plDir, 'audio', 'sibling.mp3')));
  assert.ok(!existsSync(join(plDir, 'lyrics')), '空 lyrics 照剪');
  assert.ok(!existsSync(join(plDir, 'covers')) && !existsSync(join(plDir, 'videos')));
  assert.ok(existsSync(plDir), 'audio 还活着——歌单根不剪');
});

test('pruneEmptyPlaylistDirs：activePaths 持锁路径落在歌单根下 → 整轮不剪', () => {
  const plDir = join(fs.DOWNLOAD_BASE_DIR, '880013');
  for (const sub of ['audio', 'lyrics']) mkdirSync(join(plDir, sub), { recursive: true });
  // 在途写者：mkdir 已过、createWriteStream 未开——锁键已持满 processTask 全程
  const lockKey = join(plDir, 'audio', 'inflight.mp3');
  dm.activePaths.add(lockKey);
  try {
    dm.pruneEmptyPlaylistDirs(880013);
    assert.ok(existsSync(join(plDir, 'lyrics')), '持锁期间空目录也不能剪');
    assert.ok(existsSync(plDir));
  } finally {
    dm.activePaths.delete(lockKey);
  }
  dm.pruneEmptyPlaylistDirs(880013); // 锁释放后同一调用正常收敛
  assert.ok(!existsSync(plDir));
});

test('pruneEmptyPlaylistDirs：符号链接目录不拆（用户重定向布置）', () => {
  const plDir = join(fs.DOWNLOAD_BASE_DIR, '880014');
  const target = join(dirname(fs.DOWNLOAD_BASE_DIR), 'redirect-target-880014');
  mkdirSync(join(plDir, 'audio'), { recursive: true });
  mkdirSync(join(plDir, 'videos'), { recursive: true }); // 循环序在 covers 之后
  mkdirSync(target, { recursive: true });
  try {
    symlinkSync(target, join(plDir, 'covers'), 'dir');
  } catch {
    return; // 平台不允许建链接时本用例无意义（Windows 未开开发者模式）
  }
  dm.pruneEmptyPlaylistDirs(880014);
  assert.ok(existsSync(join(plDir, 'covers')), '符号链接本身不能被 rmdir');
  assert.ok(existsSync(target), '链接目标更不能被动到');
  assert.ok(!existsSync(join(plDir, 'audio')), '真空目录照剪');
  // POSIX 上 rmdirSync(链接)抛 ENOTDIR 且中止整轮——没有 lstat 闸时
  // 排在 covers 之后的 videos 会因提前 throw 幸存，此断言在 POSIX 也钉得住
  assert.ok(!existsSync(join(plDir, 'videos')), '链接闸缺失会让后续真空目录漏剪');
});

test('pruneEmptyPlaylistDirs：逃出下载根的 playlistId 一律不碰', () => {
  // playlistId 进 path.join 前只 String()——'..' 段能逃出 DOWNLOAD_BASE_DIR，
  // isUnderDownloadDir 闸是唯一防线
  const escapeDir = join(dirname(fs.DOWNLOAD_BASE_DIR), 'escape-sentinel-880015');
  mkdirSync(escapeDir, { recursive: true });
  dm.pruneEmptyPlaylistDirs('../escape-sentinel-880015');
  assert.ok(existsSync(escapeDir), '下载根外的目录不许被剪');
});

test('listTasks：standalone 旗标只在 playlistId 分支生效且精确匹配', () => {
  // 服务端收窄面的调度闸——repo 层已证 SQL 正确，这里钉服务层的旗标
  // 解析与优先级：'1'/'true'/1/true 收 standalone；其余按超集回落
  const pl = playlistsRepo.upsertPlaylist({ neteasePlaylistId: 'local_pl_std_disp', name: 'std-disp' });
  const qRepo = require('../src/server/repositories/downloadQueues.js');
  const q = qRepo.createQueue({ playlistId: pl.id, name: 'qd', totalTasks: 0 });
  downloadTasksRepo.createTask({ playlistId: pl.id, queueId: null, songId: 's-d1', songName: '独立', artist: 'a' });
  downloadTasksRepo.createTask({ playlistId: pl.id, queueId: q.id, songId: 's-d2', songName: '入队', artist: 'a' });
  const onlyLone = (r) => r.map(t => t.songId);
  assert.deepEqual(onlyLone(dm.listTasks({ playlistId: pl.neteasePlaylistId, standalone: '1' })), ['s-d1']);
  assert.deepEqual(onlyLone(dm.listTasks({ playlistId: pl.neteasePlaylistId, standalone: 'true' })), ['s-d1']);
  assert.deepEqual(onlyLone(dm.listTasks({ playlistId: pl.neteasePlaylistId, standalone: 1 })), ['s-d1']);
  assert.deepEqual(onlyLone(dm.listTasks({ playlistId: pl.neteasePlaylistId, standalone: true })), ['s-d1']);
  // 非白名单值按超集回落——'false'/'0' 不得误触发 standalone 模式
  assert.deepEqual(onlyLone(dm.listTasks({ playlistId: pl.neteasePlaylistId, standalone: 'false' })), ['s-d1', 's-d2']);
  assert.deepEqual(onlyLone(dm.listTasks({ playlistId: pl.neteasePlaylistId, standalone: '0' })), ['s-d1', 's-d2']);
  assert.deepEqual(onlyLone(dm.listTasks({ playlistId: pl.neteasePlaylistId })), ['s-d1', 's-d2']);
  // queueId 优先级最高——与 standalone 组合也不收窄（静默超集回落）
  assert.deepEqual(onlyLone(dm.listTasks({ queueId: q.id, standalone: '1' })), ['s-d2']);
});

test('deleteTask 端到端：行删后文件删、空骨架剪净', () => {
  const pl = playlistsRepo.upsertPlaylist({ neteasePlaylistId: 'local_pl_prune_e2e', name: 'prune' });
  const t = downloadTasksRepo.createTask({
    playlistId: pl.id, queueId: null, songId: 's-prune', songName: 'n', artist: 'a',
    status: 'completed'
  });
  const plDir = join(fs.DOWNLOAD_BASE_DIR, String(pl.id));
  const audio = join(plDir, 'audio', 's-prune.mp3');
  const lyrics = join(plDir, 'lyrics', 's-prune.lrc');
  mkdirSync(dirname(audio), { recursive: true });
  mkdirSync(dirname(lyrics), { recursive: true });
  writeFileSync(audio, 'a');
  writeFileSync(lyrics, 'l');
  downloadTasksRepo.updateTask(t.id, { audioPath: audio, lyricsPath: lyrics });
  const res = dm.deleteTask(t.id);
  assert.equal(res.deletedFiles, 2);
  assert.ok(!existsSync(audio) && !existsSync(lyrics));
  assert.ok(!existsSync(plDir), '最后一条任务的骨架应剪净——不再有 reap 兜底等待');
  assert.equal(readdirSync(fs.DOWNLOAD_BASE_DIR).includes(String(pl.id)), false);
});

test('deletePlaylistDownloadedFiles 端到端：deletedFiles 返回异步批删的真实计数', async () => {
  const pl = playlistsRepo.upsertPlaylist({ neteasePlaylistId: 'local_pl_batchdel', name: 'batchdel' });
  const plDir = join(fs.DOWNLOAD_BASE_DIR, String(pl.id));
  // 两条 completed 行各带 audio+lyrics——deletedFiles 是响应载荷，必须等到
  // 异步批删真实 unlink 完才计数（detached 会返回 0/undefined），钉 4
  const gone = [];
  for (const sid of ['s-bd1', 's-bd2']) {
    const t = downloadTasksRepo.createTask({
      playlistId: pl.id, queueId: null, songId: sid, songName: 'n', artist: 'a',
      status: 'completed'
    });
    const audio = join(plDir, 'audio', `${sid}.mp3`);
    const lyrics = join(plDir, 'lyrics', `${sid}.lrc`);
    mkdirSync(dirname(audio), { recursive: true });
    mkdirSync(dirname(lyrics), { recursive: true });
    writeFileSync(audio, 'a');
    writeFileSync(lyrics, 'l');
    downloadTasksRepo.updateTask(t.id, { audioPath: audio, lyricsPath: lyrics });
    gone.push(audio, lyrics);
  }
  // 对照：pending 行的登记路径是待续跑任务的已完成分段——只收终态行，不删
  const pending = downloadTasksRepo.createTask({
    playlistId: pl.id, queueId: null, songId: 's-bd3', songName: 'n', artist: 'a',
    status: 'pending'
  });
  const pendingSeg = join(plDir, 'audio', 's-bd3.mp3');
  writeFileSync(pendingSeg, 'seg');
  downloadTasksRepo.updateTask(pending.id, { audioPath: pendingSeg });

  const res = await dm.deletePlaylistDownloadedFiles(pl.neteasePlaylistId);
  assert.equal(res.deletedSongs, 2);
  assert.equal(res.deletedFiles, 4, '响应载荷的 deletedFiles 须是 await 后的真实 unlink 数');
  for (const p of gone) assert.ok(!existsSync(p), `${p} 应已删`);
  assert.ok(existsSync(pendingSeg), 'pending 行的登记分段不许删');
  assert.ok(existsSync(plDir), 'audio/ 还有 pending 分段——歌单根骨架不剪');
});

test('getSongDownloadStatus：videoReady 跨歌单寻址且最新完成工件优先', async () => {
  const songId = 'yt_crossplvid';
  // 歌单 A 持视频档（老档），歌单 B 同曲只有音频——无 playlistId 的
  // 播放上下文（暂存/搜索队列）也要能找到 A 的视频并回带寻址键
  const plA = playlistsRepo.upsertPlaylist({ neteasePlaylistId: 'local_pl_xv_a', name: 'xv-a' });
  const plB = playlistsRepo.upsertPlaylist({ neteasePlaylistId: 'local_pl_xv_b', name: 'xv-b' });
  const vidA = join(fs.DOWNLOAD_BASE_DIR, String(plA.id), 'videos', 'x.mp4');
  mkdirSync(dirname(vidA), { recursive: true });
  writeFileSync(vidA, 'v');
  const tA = downloadTasksRepo.createTask({ playlistId: plA.id, queueId: null, songId, songName: 'n', artist: 'a' });
  const tB = downloadTasksRepo.createTask({ playlistId: plB.id, queueId: null, songId, songName: 'n', artist: 'a' });
  downloadTasksRepo.updateTask(tA.id, {
    status: 'completed', videoPath: vidA, completedAt: '2024-01-01T00:00:00.000Z'
  });
  downloadTasksRepo.updateTask(tB.id, {
    status: 'completed', completedAt: '2024-06-01T00:00:00.000Z'
  });

  // playlistId 缺省（无归属上下文）：仍命中 A 的档
  const stNoPl = await dm.getSongDownloadStatus(null, songId);
  assert.equal(stNoPl.videoReady, true);
  assert.equal(stNoPl.videoPlaylistId, plA.id);
  // 归属歌单是 B（本单无视频档）：寻址也回落到 A——借源播放能放
  const stPlB = await dm.getSongDownloadStatus(plB.neteasePlaylistId, songId);
  assert.equal(stPlB.videoReady, true);
  assert.equal(stPlB.videoPlaylistId, plA.id);

  // 双份在盘工件：B 的 completed_at 更晚 → 新档赢——老歌单躺着的早期
  // 下载不该盖过新下载的档
  const vidB = join(fs.DOWNLOAD_BASE_DIR, String(plB.id), 'videos', 'x.mp4');
  mkdirSync(dirname(vidB), { recursive: true });
  writeFileSync(vidB, 'v2');
  downloadTasksRepo.updateTask(tB.id, { videoPath: vidB });
  const stBoth = await dm.getSongDownloadStatus(null, songId);
  assert.equal(stBoth.videoPlaylistId, plB.id, '双份在盘工件取最新 completed_at 的歌单');
});

test('getSongDownloadStatus：audioReady 跨歌单寻址且独立于全工件合取', async () => {
  const songId = 'yt_crossplaud';
  // B 单只有音频档（歌词/封面未下或缺失）——downloaded 全工件合取为假
  // 也不挡 audioReady：播放只看音频档在不在盘
  const plB = playlistsRepo.upsertPlaylist({ neteasePlaylistId: 'local_pl_xa_b', name: 'xa-b' });
  const audB = join(fs.DOWNLOAD_BASE_DIR, String(plB.id), 'audio', 'x.m4a');
  mkdirSync(dirname(audB), { recursive: true });
  writeFileSync(audB, 'a');
  const tB = downloadTasksRepo.createTask({ playlistId: plB.id, queueId: null, songId, songName: 'n', artist: 'a' });
  downloadTasksRepo.updateTask(tB.id, {
    status: 'completed', audioPath: audB, completedAt: '2024-03-01T00:00:00.000Z'
  });

  // 无归属上下文：跨歌单命中 B 的音频档并回带寻址键
  const st = await dm.getSongDownloadStatus(null, songId);
  assert.equal(st.audioReady, true);
  assert.equal(st.audioPlaylistId, plB.id);
  assert.equal(st.downloaded, false, '无 playlistId 时本单 task 缺席——downloaded 不参与播放判定');
  assert.equal(st.videoReady, false);

  // 幻影档（行在档删）不报 ready；另一歌单的新档顶上
  const plA = playlistsRepo.upsertPlaylist({ neteasePlaylistId: 'local_pl_xa_a', name: 'xa-a' });
  const audA = join(fs.DOWNLOAD_BASE_DIR, String(plA.id), 'audio', 'x.m4a');
  const tA = downloadTasksRepo.createTask({ playlistId: plA.id, queueId: null, songId, songName: 'n', artist: 'a' });
  downloadTasksRepo.updateTask(tA.id, {
    status: 'completed', audioPath: audA, completedAt: '2024-05-01T00:00:00.000Z'
  });
  // A 的 completed_at 更晚但档不在盘——B 的实档仍应赢（幻影不盖真档）
  const st2 = await dm.getSongDownloadStatus(null, songId);
  assert.equal(st2.audioPlaylistId, plB.id, 'completed_at 更新的幻影档（行在档删）不得盖住实档');
  mkdirSync(dirname(audA), { recursive: true });
  writeFileSync(audA, 'a2');
  const st3 = await dm.getSongDownloadStatus(null, songId);
  assert.equal(st3.audioPlaylistId, plA.id, '双份在盘音频档取最新 completed_at 的歌单');
});

test('routes/downloads 写端点 CSRF：异源 Origin → 403（开放部署裸奔面收口）', async () => {
  // 真路由真库：闸在任何业务判定之前，无需准备队列/任务行
  const downloadsRoute = require('../src/server/routes/downloads.js');
  const evil = { origin: 'https://evil.example' };
  const start = await downloadsRoute.request('http://t/downloads/queues/1/start', {
    method: 'POST', headers: evil,
  });
  assert.equal(start.status, 403);
  const del = await downloadsRoute.request('http://t/downloads/queues/1', {
    method: 'DELETE', headers: evil,
  });
  assert.equal(del.status, 403);
  const mirror = await downloadsRoute.request('http://t/downloads/local/mirror', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...evil },
    body: JSON.stringify({ localId: 'local_pl_csrf', name: 'x', tracks: [{ id: '1' }] }),
  });
  assert.equal(mirror.status, 403);
  // 对照：无 Origin 的同请求过闸走到业务层（非 403——非浏览器客户端不受影响）
  const noOrigin = await downloadsRoute.request('http://t/downloads/queues/1/start', { method: 'POST' });
  assert.notEqual(noOrigin.status, 403);
});

test('routes/downloads 写端点限流：同 IP 第 31 次写 → 429（上游扇出+写盘收口）', async (t) => {
  // TRUST_PROXY + 独用 XFF 隔离桶——csrf 用例的无 Origin 请求打的是 'local'
  // 共享桶，不复用存量计数也不污染它（settings.test.mjs 写面限流同款隔离法）
  const downloadsRoute = require('../src/server/routes/downloads.js');
  const savedTp = process.env.TRUST_PROXY;
  process.env.TRUST_PROXY = '1';
  t.after(() => {
    if (savedTp === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = savedTp;
  });
  // '{}' 缺必填 playlistId → 恒 400 早退——探针不依赖 DB 队列行有无，
  // 也不会真建队列/拉起下载协程；限流闸在 body 校验之前，每次命中都计数
  const post = () => downloadsRoute.request('http://t/downloads/queues', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.88' },
    body: '{}',
  });
  for (let i = 0; i < 30; i++) {
    assert.equal((await post()).status, 400, `第 ${i + 1} 次写应在配额内`);
  }
  assert.equal((await post()).status, 429);
});

test('getSongDownloadStatus：纯视频档行不误报 audioReady（bv/yt 的 videoPath 不是音频工件）', async () => {
  const songId = 'bv_vonly';
  // 只下载视频的任务行（download_audio=0）：videoPath 在盘但它是视频字节——
  // audioReady 必须保持假，否则播放链会 _localFile 钉一份注定 404 的 kind=audio
  const pl = playlistsRepo.upsertPlaylist({ neteasePlaylistId: 'local_pl_vo', name: 'vo' });
  const vid = join(fs.DOWNLOAD_BASE_DIR, String(pl.id), 'videos', 'x.mp4');
  mkdirSync(dirname(vid), { recursive: true });
  writeFileSync(vid, 'v');
  const t = downloadTasksRepo.createTask({ playlistId: pl.id, queueId: null, songId, songName: 'n', artist: 'a' });
  downloadTasksRepo.updateTask(t.id, {
    status: 'completed', videoPath: vid, completedAt: '2024-06-01T00:00:00.000Z'
  });

  const st = await dm.getSongDownloadStatus(null, songId);
  assert.equal(st.videoReady, true);
  assert.equal(st.audioReady, false, 'bv_/yt_ 行的 videoPath 不得算作音频工件');
  assert.equal(st.audioPlaylistId, null);
});

test('getSongDownloadStatus：audioArtifactAt/audioEtag 与 /file 实发同源，boundUpdatedAt 回带绑定戳', async () => {
  const songId = 'yt_stamp_probe';
  const pl = playlistsRepo.upsertPlaylist({ neteasePlaylistId: 'local_pl_stamp', name: 'stamp' });
  const aud = join(fs.DOWNLOAD_BASE_DIR, String(pl.id), 'audio', 's.mp3');
  mkdirSync(dirname(aud), { recursive: true });
  writeFileSync(aud, 'audio-bytes');
  const t = downloadTasksRepo.createTask({ playlistId: pl.id, queueId: null, songId, songName: 'n', artist: 'a' });
  downloadTasksRepo.updateTask(t.id, {
    status: 'completed', audioPath: aud, completedAt: '2024-04-01T00:00:00.000Z'
  });

  const st = await dm.getSongDownloadStatus(null, songId);
  assert.equal(st.audioReady, true);
  const stat = statSync(aud);
  // 线型整数契约：audioArtifactAt 是 trunc(mtimeMs)——浮点直发会让客户端
  // Long 型解码炸；etag 侧仍保浮点逐字（与 /file 实发对账，截断会让同毫秒
  // 换源撞 tag）
  assert.equal(st.audioArtifactAt, Math.trunc(stat.mtimeMs),
    '工件戳须是命中档 mtimeMs 的截断整数');
  assert.ok(Number.isInteger(st.audioArtifactAt), 'audioArtifactAt 必须是整数');
  assert.equal(st.audioEtag, `W/"${stat.size}-${stat.mtimeMs}"`, 'etag 生成式须与 /file 同款');
  assert.equal(st.boundUpdatedAt, null, '未绑定歌曲绑定戳归 null');
  // 与 /file 实发 ETag 逐字节一致——客户端拿它对账本地档，偏一个字节都会误换源
  const downloadsRoute = require('../src/server/routes/downloads.js');
  const fileRes = await downloadsRoute.request(
    `http://t/downloads/songs/${songId}/file?playlistId=${pl.neteasePlaylistId}`);
  assert.equal(fileRes.status, 200);
  assert.equal(fileRes.headers.get('etag'), st.audioEtag, 'status 回带 etag 须等于 /file 实发值');

  // HTTP 面回包钉：线型必须是 JSON 整数字面量（非仅服务层数值——序列化出
  // 1700000000123.4 形如浮点即违约），且值与服务层戳一致
  const statusRes = await downloadsRoute.request(
    `http://t/downloads/songs/${songId}/status?playlistId=${pl.neteasePlaylistId}`);
  assert.equal(statusRes.status, 200);
  const raw = await statusRes.text();
  const wireAt = /"audioArtifactAt":(-?\d+(?:\.\d+)?)/.exec(raw);
  assert.ok(wireAt, 'status 回包须带 audioArtifactAt');
  assert.ok(!wireAt[1].includes('.'), `audioArtifactAt 线型须为整数字面量，实发 ${wireAt[1]}`);
  assert.equal(Number(wireAt[1]), Math.trunc(stat.mtimeMs));

  // 绑定落库后回带 song_unlock_manual.updated_at 的 UTC epoch ms——
  // sqlite CURRENT_TIMESTAMP 裸串补 'Z' 解析。updated_at 钉成已知裸串、
  // 断言固定 UTC 值：两侧同式对拍（实现与断言都写 `串+Z`）证不了时区——
  // 若实现丢了 'Z'，裸串落本地时区，与 UTC 固定值差 UTC 偏移小时数
  const unlockManualRepo = require('../src/server/repositories/unlockManual.js');
  const { getDb } = require('../src/server/db/client.js');
  unlockManualRepo.upsertManual(songId, {
    source: 'bilibili', mediaId: 'BV1xx411c7mD', title: 't', owner: 'o', durationSec: 200
  });
  try {
    getDb().prepare(
      `UPDATE song_unlock_manual SET updated_at = '2020-01-01 00:00:00' WHERE song_id = ?`
    ).run(songId);
    const st2 = await dm.getSongDownloadStatus(null, songId);
    assert.equal(st2.boundUpdatedAt, Date.parse('2020-01-01 00:00:00Z'),
      'sqlite UTC 裸串须按 UTC 解析为 1577836800000（丢 Z 会落本地时区）');
  } finally {
    unlockManualRepo.deleteManual(songId);
  }

  // audioReady 未命中（无档曲目）→ 工件戳/etag 双 null；无绑定同归 null
  const st3 = await dm.getSongDownloadStatus(null, 'yt_no_artifact_probe');
  assert.equal(st3.audioReady, false);
  assert.equal(st3.audioArtifactAt, null);
  assert.equal(st3.audioEtag, null);
  assert.equal(st3.boundUpdatedAt, null);
});

// audio_br（br-gate 音质对账列）：完成行落 downloadAudio 实到码率 result.br——
// bitrate 是「请求的档」，audio_br 是「到手的档」，降档/换源无痕正是本列要
// 钉的案；status 把命中音频工件行的 audio_br 回带成 audioBitrate。
// 存量行/无档 NULL=未知（无证据不降级，老档不误判）
const waitTerminalRow = async (taskId, ms = 3000) => {
  const t0 = Date.now();
  for (;;) {
    const t = downloadTasksRepo.findTaskById(taskId);
    if (!t || t.status === 'completed' || t.status === 'failed') return t;
    if (Date.now() - t0 > ms) return t;
    await new Promise(r => setTimeout(r, 20));
  }
};

test('audio_br：完成行落库实到码率，status/HTTP 回带 audioBitrate', async (t) => {
  const songId = 'yt_braudit0001';
  // fd.downloadAudio 原位打桩：download-manager 经模块对象动态调它（同一
  // exports 面）——写真档再报 path/size/br，走通 processTask 整段落库链
  const realDownloadAudio = fd.downloadAudio;
  fd.downloadAudio = async (sid, outputPath) => {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, 'fake-audio-bytes');
    return { path: outputPath, size: 1234567, br: 192000 };
  };
  t.after(() => { fd.downloadAudio = realDownloadAudio; });

  const mirror = require('../src/server/services/local-mirror.js');
  const pl = mirror.mirrorLocalPlaylist('local_pl_br', '歌单', '', [
    { id: songId, name: '歌', ar: [{ name: 'a' }], al: { name: 'z' }, dt: 200000 }
  ]);
  const submitted = await dm.downloadSingleSong('local_pl_br', songId, {
    downloadAudio: true, downloadLyrics: false, downloadCover: false, downloadVideo: false
  });
  const done = await waitTerminalRow(submitted.id);
  assert.equal(done.status, 'completed', `实跑行未达终态: ${done?.errorMessage || done?.status}`);
  // 192k ≠ 请求档默认 320k——落库必须是 result.br 实到值而非请求值
  assert.equal(done.audioBr, 192000);
  const raw = require('../src/server/db/client.js').getDb()
    .prepare('SELECT audio_br FROM download_tasks WHERE id = ?').get(done.id);
  assert.equal(raw.audio_br, 192000, 'audio_br 列须持久化实到码率到 sqlite');

  const st = await dm.getSongDownloadStatus(null, songId);
  assert.equal(st.audioReady, true);
  assert.equal(st.audioPlaylistId, pl.id);
  assert.equal(st.audioBitrate, 192000, '命中音频工件的行须回带其 audio_br');

  // HTTP 线型钉：契约键名是 data.audioBitrate（app 侧 DTO 按此解码）
  const downloadsRoute = require('../src/server/routes/downloads.js');
  const res = await downloadsRoute.request(`http://t/downloads/songs/${songId}/status`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).data.audioBitrate, 192000);
});

test('getSongDownloadStatus.audioBitrate：存量行未登记 / 无档 → NULL', async () => {
  // 存量行形态：completed + 工件在盘但 audio_br 从未写（本列后加，老行
  // 天然 NULL）——请求档 bitrate 不得冒充实到码率回带
  const pl = playlistsRepo.upsertPlaylist({ neteasePlaylistId: 'local_pl_brnull', name: 'brnull' });
  const aud = join(fs.DOWNLOAD_BASE_DIR, String(pl.id), 'audio', 'x.mp3');
  mkdirSync(dirname(aud), { recursive: true });
  writeFileSync(aud, 'a');
  const tk = downloadTasksRepo.createTask({
    playlistId: pl.id, queueId: null, songId: 'br_legacy_song', songName: 'n', artist: 'a'
  });
  downloadTasksRepo.updateTask(tk.id, {
    status: 'completed', audioPath: aud, completedAt: '2024-04-01T00:00:00.000Z'
  });
  const row = downloadTasksRepo.findTaskById(tk.id);
  assert.equal(row.bitrate, 320000, '对照：请求档在库但与实到码率无涉');
  assert.equal(row.audioBr, null);

  const st = await dm.getSongDownloadStatus(null, 'br_legacy_song');
  assert.equal(st.audioReady, true);
  assert.equal(st.audioBitrate, null, 'audio_br 未登记的存量档按未知回 NULL——闸放行不误降');

  // 无档：连命中行都没有——audioReady/audioBitrate 双双归空
  const stNone = await dm.getSongDownloadStatus(null, 'br_no_artifact');
  assert.equal(stNone.audioReady, false);
  assert.equal(stNone.audioBitrate, null);
});

// 下载栈三层（download-io/download-fs/file-downloader/download-manager）的调用级
// smoke——搬移式重构曾引入「require 不炸、调用才炸」的自由变量断链
// （fileDownloader.sanitizeFilename 残留、AUDIO_EXTS/DRAIN_TIMEOUT_MS 漏导入），
// 纯加载测试抓不住。这里的用例真的调用跨层函数，钉住整条引用链。
// DATA_DIR 指向临时目录：download-fs 的 DOWNLOAD_BASE_DIR 与 repo 都建在其下。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { mkdirSync, writeFileSync, existsSync, symlinkSync, readdirSync } from 'node:fs';
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

test('file-downloader→io 常量链：downloadCover 空 URL 走 fatalError 早退', async () => {
  // 空 URL 触发 fatalError 分支——若 io 未导出所需符号这里会 ReferenceError
  await assert.rejects(
    fd.downloadCover('', join(fs.DOWNLOAD_BASE_DIR, 't', 'covers', 'x.jpg'), null),
    /封面链接不存在/
  );
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
});

test('pruneEmptyPlaylistDirs：逃出下载根的 playlistId 一律不碰', () => {
  // playlistId 进 path.join 前只 String()——'..' 段能逃出 DOWNLOAD_BASE_DIR，
  // isUnderDownloadDir 闸是唯一防线
  const escapeDir = join(dirname(fs.DOWNLOAD_BASE_DIR), 'escape-sentinel-880015');
  mkdirSync(escapeDir, { recursive: true });
  dm.pruneEmptyPlaylistDirs('../escape-sentinel-880015');
  assert.ok(existsSync(escapeDir), '下载根外的目录不许被剪');
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

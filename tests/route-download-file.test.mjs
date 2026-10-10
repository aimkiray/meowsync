// routes/downloads.js GET /downloads/songs/:id/file 的打开侧钉板：
// O_NOFOLLOW 把 lstat→open 的换链窗口收敛进同一 syscall——叶子在 open 时
// 已是符号链接（getTaskArtifactPath 的 lstat 检查与 openSync 之间的
// TOCTOU），ELOOP 必须映射成既有 404 而非 500 漏出目标字节。
// 确定性打法：seed download-manager 只换 getTaskArtifactPath（返回值可例
// 内翻转）——真路由真 fs，链接在 openSync 一刻就位。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { seed, tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-route-dlfile-');
const require = createRequire(import.meta.url);

// 例内可翻转的工件寻址：真实现已在 lstat 层拒叶子链接，够不着 openSync；
// 桩直接回传指定路径，把「open 时叶子是链接」的竞态终态钉成稳态
let artifactPath = null;
seed('../src/server/services/download-manager.js', {
  getTaskArtifactPath: () => artifactPath,
  toPublicTask: (t) => t,
});

let app, fsHelpers;
before(() => {
  app = require('../src/server/routes/downloads.js');
  fsHelpers = require('../src/server/services/download-fs.js');
});
after(() => { rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

const getFile = (songId = 's1', playlistId = 'pl1') =>
  app.request(`http://t/downloads/songs/${songId}/file?playlistId=${playlistId}`);

test('downloads /file：叶子在 open 时是符号链接 → ELOOP 归 404 而非 500/漏字节', async () => {
  const outsideDir = join(dirname(fsHelpers.DOWNLOAD_BASE_DIR), 'dlfile-outside');
  const outsideFile = join(outsideDir, 'secret.mp3');
  const linkLeaf = join(fsHelpers.DOWNLOAD_BASE_DIR, 'probe', 'linked.mp3');
  mkdirSync(outsideDir, { recursive: true });
  mkdirSync(dirname(linkLeaf), { recursive: true });
  writeFileSync(outsideFile, 'outside-secret-bytes');
  try {
    symlinkSync(outsideFile, linkLeaf);
  } catch {
    return; // 平台不许建链接（Windows 未开开发者模式）——本用例无意义
  }
  artifactPath = linkLeaf;
  const res = await getFile();
  assert.equal(res.status, 404, 'O_NOFOLLOW 的 ELOOP 应映射成既有 404');
  const body = await res.text();
  assert.ok(!body.includes('outside-secret-bytes'), '链接目标字节不得透出');
});

test('downloads /file：常规文件照常 200 供出（O_NOFOLLOW 不误伤）', async () => {
  const real = join(fsHelpers.DOWNLOAD_BASE_DIR, 'probe', 'real.mp3');
  mkdirSync(dirname(real), { recursive: true });
  writeFileSync(real, 'real-audio-bytes');
  artifactPath = real;
  const res = await getFile();
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'real-audio-bytes');
  assert.equal(res.headers.get('content-type'), 'audio/mpeg');
});

test('downloads /file：目录路径 → 同 fd 的 isFile 闸归 404（不再流出目录句柄）', async () => {
  artifactPath = join(fsHelpers.DOWNLOAD_BASE_DIR, 'probe'); // 存在的目录
  const res = await getFile();
  assert.equal(res.status, 404);
});

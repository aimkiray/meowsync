// file-downloader 全灭分流钉板（spec-retry-heal-b 单元 B / L4）：解锁失败
// 错误消息拼逐源归因（[canonical FAILMSG]：全角分号连接 source: msg），
// 任一 transient → 普通 Error（无 fatal）走 download-manager 的 retryAfter
// 退避 ≤3 次；全 nomatch/authwall/breaker/空归因 → fatal 不白打。
// netease-api 整模块桩——被测面是 downloadAudio 的全灭分支而非解锁链本体；
// download-io.fatalError 用真身（fatal 标记即被测面）。桩面须给全量顶层
// 解构成员：file-downloader 顶部解构 {callNeteaseApi, resolveSongUrls,
// resolveTrackUnlock, qqUnlockInfo}，缺成员会让未来扩展在桩下静默拿到
// undefined
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { seed, tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-dl-unlockfail-');
const require = createRequire(import.meta.url);

let callApiImpl = async () => ({ body: { data: [] } });
seed('../src/server/services/netease-api.js', {
  callNeteaseApi: (...a) => callApiImpl(...a),
  resolveSongUrls: async (items) => items, // 恒等桩——items 自带 unlockFailed/unlockErrors
  // qq_ 外源解锁两出口——数值域用例永不触达；throw 桩钉死「不得静默
  // 拿到 undefined 后悄悄走通」
  resolveTrackUnlock: async () => { throw new Error('netease-api 桩：resolveTrackUnlock 不应被数值域触达'); },
  qqUnlockInfo: async () => { throw new Error('netease-api 桩：qqUnlockInfo 不应被数值域触达'); },
  needsUnlock: () => true,
  MAX_UNLOCK_ITEMS: 20,
  apiModules: {},
  estimateDuration: () => null,
  forgetSongUnlock: () => {},
});

const { downloadAudio } = require('../src/server/services/file-downloader.js');
const outDir = tmpDataDir('meowsync-dl-unlockfail-out-');

// 全灭形态驱动：song_url 回一条 unlockFailed 项（恒等 resolveSongUrls 原样透下）
const run = (unlockErrors) => {
  const item = { id: 12345, url: null, fee: 1, time: 0, unlockFailed: true };
  if (unlockErrors !== undefined) item.unlockErrors = unlockErrors;
  callApiImpl = async () => ({ body: { data: [item] } });
  return downloadAudio('12345', join(outDir, 'x.mp3'), 320000, null, null, {})
    .then(() => null, (e) => e);
};

beforeEach(() => { callApiImpl = async () => ({ body: { data: [] } }); });

test('transient 归因在场 → 普通 Error（fatal=false）留给 retryAfter 退避重试', async () => {
  const err = await run([{ source: 'pyncmd', msg: 'pyncmd HTTP 503', cls: 'transient' }]);
  assert.equal(err.fatal, false, '任一 transient 在场不得标 fatal——瞬时失败该走自动重试');
  assert.equal(err.message, '下载音频失败: 解锁失败，逐源均无匹配（pyncmd: pyncmd HTTP 503）');
});

test('nomatch/authwall/breaker 全确定性归因 → fatal', async () => {
  for (const cls of ['nomatch', 'authwall', 'breaker']) {
    const err = await run([{ source: 'youtube', msg: `x-${cls}`, cls }]);
    assert.equal(err.fatal, true, `${cls} 应维持 fatal——窗内确定性结果不白打上游`);
    assert.equal(err.message, `下载音频失败: 解锁失败，逐源均无匹配（youtube: x-${cls}）`);
  }
});

test('无逐源记录（unlockErrors 缺席/空数组）→ fatal「无逐源记录」', async () => {
  const err = await run(undefined);
  assert.equal(err.fatal, true);
  assert.equal(err.message, '下载音频失败: 解锁失败，逐源均无匹配（无逐源记录）');
  const err2 = await run([]);
  assert.equal(err2.fatal, true);
  assert.equal(err2.message, '下载音频失败: 解锁失败，逐源均无匹配（无逐源记录）');
});

test('多源多条归因以全角分号连接；transient 混入即转可重试', async () => {
  const err = await run([
    { source: 'pyncmd', msg: 'pyncmd HTTP 404', cls: 'nomatch' },
    { source: 'youtube', msg: '源熔断中：凭据被拒连败（疑似反机器人墙）', cls: 'breaker' },
  ]);
  assert.equal(err.fatal, true);
  assert.equal(err.message,
    '下载音频失败: 解锁失败，逐源均无匹配（pyncmd: pyncmd HTTP 404；youtube: 源熔断中：凭据被拒连败（疑似反机器人墙））');

  const err2 = await run([
    { source: 'pyncmd', msg: 'pyncmd HTTP 503', cls: 'transient' },
    { source: 'youtube', msg: '无候选', cls: 'nomatch' },
  ]);
  assert.equal(err2.fatal, false, 'transient 混在确定性归因里仍应判可重试');
  assert.equal(err2.message, '下载音频失败: 解锁失败，逐源均无匹配（pyncmd: pyncmd HTTP 503；youtube: 无候选）');
});

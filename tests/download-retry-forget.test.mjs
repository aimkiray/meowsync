// 手动重试 = hard retry 钉板（spec-retry-heal-b §5 单元 C）：retryTask/
// retryQueue 在派活前按曲调 forgetSongUnlock 清解锁链负状态（unlockCache/
// inflight/deadCands/全否冷却/verdict）——否则重跑只是复读同一条注定失败的链。
// file-downloader 全桩挂起防真下载；netease-api 保留真 exports、只把
// forgetSongUnlock 覆写成记账 spy（B 侧导出未落地时此桩即被测契约面）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { seed, tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-retry-forget-');
const require = createRequire(import.meta.url);

// 同一条事件流水记两类动作：forget:<sid> = 负状态清理调用，audio:<songId> =
// 真实派活（processTask 触达 downloadAudio）。「清理先于派活」断言两事件在
// 序列里的相对位置——不掺时间戳，杜绝时钟抖动假阴性
const events = [];
// 命中的 songId 让 spy 抛错：验证 best-effort——清理失败不挡重试主路径
let forgetThrowsOn = new Set();

const hangUntilAbort = (...args) => new Promise((_, reject) => {
  const signal = args.find(a => a && typeof a.aborted === 'boolean' && typeof a.addEventListener === 'function');
  const abort = () => reject(Object.assign(new Error('下载已取消'), { name: 'AbortError' }));
  if (signal?.aborted) return abort();
  signal?.addEventListener('abort', abort, { once: true });
});
// 全桩：download-manager 只消费这四个入口；挂起形态让「派活序」可观测
// （桩必须早于 download-manager 加载——require.cache 预播种）
seed('../src/server/services/file-downloader.js', {
  downloadAudio: (songId, ...rest) => {
    events.push(`audio:${songId}`);
    return hangUntilAbort(songId, ...rest);
  },
  downloadVideo: hangUntilAbort,
  downloadLyrics: hangUntilAbort,
  downloadCover: hangUntilAbort
});

// 真身 exports 全保留：playlist-sync 等传递消费方解构的 callNeteaseApi 仍是
// 真函数；只覆写被测面 forgetSongUnlock（B 侧未落地时真身本无此导出，
// 显式键覆盖——落地后同理不被真值顶掉）
const realNeteaseApi = require('../src/server/services/netease-api.js');
seed('../src/server/services/netease-api.js', {
  ...realNeteaseApi,
  forgetSongUnlock: (songId) => {
    events.push(`forget:${String(songId)}`);
    if (forgetThrowsOn.has(String(songId))) throw new Error('清理簿爆炸');
  }
});

const tasksRepo = require('../src/server/repositories/downloadTasks.js');
const queuesRepo = require('../src/server/repositories/downloadQueues.js');
const playlistsRepo = require('../src/server/repositories/playlists.js');
const tracksRepo = require('../src/server/repositories/playlistTracks.js');
const dm = require('../src/server/services/download-manager.js');

const forgetCalls = () => events.filter(e => e.startsWith('forget:')).map(e => e.slice(7));
const audioCalls = () => events.filter(e => e.startsWith('audio:')).map(e => e.slice(6));
// 末次 forget 的下标必须早于首次派活——「新链跑起来前负状态已清」的时序不变量
const forgetBeforeDispatch = () => {
  const lastForget = events.reduce((acc, e, i) => e.startsWith('forget:') ? i : acc, -1);
  const firstAudio = events.findIndex(e => e.startsWith('audio:'));
  return lastForget !== -1 && firstAudio !== -1 && lastForget < firstAudio;
};

const seedPlaylist = (neteaseId) =>
  playlistsRepo.upsertPlaylist({ neteasePlaylistId: neteaseId, name: `pl-${neteaseId}` });
const seedFailedTask = (playlistId, songId, queueId = null, providerData) => tasksRepo.createTask({
  playlistId, queueId, songId, songName: '歌', artist: '艺人',
  status: 'failed', errorMessage: '解锁失败，所有可用源均无匹配',
  downloadAudio: true, downloadLyrics: false, downloadCover: false, downloadVideo: false,
  ...(providerData ? { providerData } : {})
});
// 派活发生在协程微任务链上——断言前先放一跳，等 downloadAudio 挂起点被触达
const settleTick = () => new Promise(r => setImmediate(r));

test('retryTask（队列内 failed 行）：forgetSongUnlock 恰调 1 次、实参 songId、先于派活', async () => {
  events.length = 0; forgetThrowsOn = new Set();
  const pl = seedPlaylist('778801');
  const queue = queuesRepo.createQueue({ playlistId: pl.id, name: pl.name, status: 'failed', totalTasks: 1 });
  const task = seedFailedTask(pl.id, '778801001', queue.id);

  await dm.retryTask(task.id);
  await settleTick();

  assert.deepEqual(forgetCalls(), ['778801001'], 'failed 行重试应恰好按曲清一次');
  assert.ok(forgetBeforeDispatch(), '负状态清理必须先于 startQueue 派活');
  assert.ok(audioCalls().includes('778801001'), '复位后任务应真被派出去');
  assert.equal(queuesRepo.findQueueById(queue.id).status, 'running');

  await dm.cancelQueue(queue.id); // 收尾：abort 挂起的协程
});

test('retryTask（standalone failed 行）：同口径——forget 先行、dispatchStandalone 随后', async () => {
  events.length = 0; forgetThrowsOn = new Set();
  const pl = seedPlaylist('778802');
  const task = seedFailedTask(pl.id, '778802001', null);

  await dm.retryTask(task.id);
  await settleTick();

  assert.deepEqual(forgetCalls(), ['778802001']);
  assert.ok(forgetBeforeDispatch(), '负状态清理必须先于 dispatchStandalone');
  assert.ok(audioCalls().includes('778802001'));
  // 挂起态下协程卡在 downloadAudio——行应已翻过 downloading
  assert.equal(tasksRepo.findTaskById(task.id).status, 'downloading');
  // 挂起的 standalone 协程无活跃句柄，随进程退出自然回收
});

test('retryQueue：按 songId 去重逐曲清，全部清理先于派活', async () => {
  events.length = 0; forgetThrowsOn = new Set();
  const pl = seedPlaylist('778803');
  const pl2 = seedPlaylist('778804');
  const queue = queuesRepo.createQueue({ playlistId: pl.id, name: pl.name, status: 'failed', totalTasks: 3 });
  seedFailedTask(pl.id, '778803a', queue.id);
  seedFailedTask(pl.id, '778803b', queue.id);
  // 同曲第二任务行：(playlist_id,song_id) 唯一约束挡同歌单双行——挂别的
  // playlistId 共用 queue_id 构造「同曲多行」形态（任务行被收养/搬移后的
  // 真实存在面），listTasksByQueue 只按 queue_id 过滤会把它捞进来
  seedFailedTask(pl2.id, '778803a', queue.id);

  await dm.retryQueue(queue.id);
  await settleTick();

  assert.equal(forgetCalls().length, 2, '同 songId 重复行不重复清');
  assert.deepEqual(forgetCalls().slice().sort(), ['778803a', '778803b']);
  assert.ok(forgetBeforeDispatch(), '全部负状态清理必须先于 startQueue 派活');
  assert.equal(queuesRepo.findQueueById(queue.id).status, 'running');

  await dm.cancelQueue(queue.id);
});

test('清理异常被吞：forgetSongUnlock 抛错不阻塞重试主路径', async () => {
  // retryTask 口径：spy 抛错 → warn 吞掉 → 照常复位派活
  events.length = 0;
  const pl = seedPlaylist('778805');
  const task = seedFailedTask(pl.id, '778805boom', null);
  forgetThrowsOn = new Set(['778805boom']);

  await dm.retryTask(task.id);
  await settleTick();
  assert.deepEqual(forgetCalls(), ['778805boom'], '清理仍被尝试调用');
  assert.ok(audioCalls().includes('778805boom'), '清理失败不得挡派活');
  assert.equal(tasksRepo.findTaskById(task.id).status, 'downloading');

  // retryQueue 口径：一曲清理爆炸不牵连其余曲、队列照常置 pending 启动
  events.length = 0;
  const pl2 = seedPlaylist('778806');
  const queue = queuesRepo.createQueue({ playlistId: pl2.id, name: pl2.name, status: 'failed', totalTasks: 2 });
  seedFailedTask(pl2.id, '778806ok', queue.id);
  seedFailedTask(pl2.id, '778806boom', queue.id);
  forgetThrowsOn = new Set(['778806boom']);

  await dm.retryQueue(queue.id);
  await settleTick();
  assert.deepEqual(forgetCalls().slice().sort(), ['778806boom', '778806ok'], '抛错行与正常行都被尝试清理');
  assert.ok(forgetBeforeDispatch(), '清理（含失败项）全部先于派活');
  assert.equal(queuesRepo.findQueueById(queue.id).status, 'running', '清理异常后队列仍应启动');

  await dm.cancelQueue(queue.id);
  forgetThrowsOn = new Set();
});

test('retryTask（非网易云 songId）：forgetSongUnlock 无闸照调、外部源 id 幂等无害', async () => {
  // §5d：songId 无 NETEASE_ID_RE 过滤——yt_ 等外部 id 进 forgetSongUnlock 是
  // 幂等空操作（各簿键型不匹配零命中），断言「调了且无害」而非「没调」
  events.length = 0; forgetThrowsOn = new Set();
  const pl = seedPlaylist('778807');
  const task = seedFailedTask(pl.id, 'yt_abc123def45', null);

  await dm.retryTask(task.id);
  await settleTick();

  assert.deepEqual(forgetCalls(), ['yt_abc123def45'], '无闸设计：外部源 id 也照常按曲清');
  assert.ok(forgetBeforeDispatch(), '负状态清理必须先于 dispatchStandalone');
  assert.ok(audioCalls().includes('yt_abc123def45'), '复位后任务应真被派出去');
  assert.equal(tasksRepo.findTaskById(task.id).status, 'downloading');
});

test('retryQueue（无 failed 行早退）：pending/completed 队列零 forget 调用', async () => {
  // 空 failedTasks 的早退分支在清理循环之前——退化为 startQueue 语义时也不许
  // 顺路按曲清；pending 行照常派出而 forget 计数恒零，才钉住「早退早于清理」
  events.length = 0; forgetThrowsOn = new Set();
  const pl = seedPlaylist('778808');
  const queue = queuesRepo.createQueue({ playlistId: pl.id, name: pl.name, status: 'pending', totalTasks: 2 });
  tasksRepo.createTask({
    playlistId: pl.id, queueId: queue.id, songId: '778808p', songName: '歌', artist: '艺人',
    status: 'pending',
    downloadAudio: true, downloadLyrics: false, downloadCover: false, downloadVideo: false
  });
  tasksRepo.createTask({
    playlistId: pl.id, queueId: queue.id, songId: '778808c', songName: '歌2', artist: '艺人',
    status: 'completed',
    downloadAudio: true, downloadLyrics: false, downloadCover: false, downloadVideo: false
  });

  await dm.retryQueue(queue.id);
  await settleTick();

  assert.deepEqual(forgetCalls(), [], '无 failed 行 → 早退分支不得触达清理循环');
  assert.ok(audioCalls().includes('778808p'), '退化为 startQueue：pending 行应被派出');
  assert.equal(queuesRepo.findQueueById(queue.id).status, 'running');

  await dm.cancelQueue(queue.id); // 收尾：abort 挂起的协程
});

test('retryTask（qq_ 外源解锁腿）：providerData.neteaseId 不入集——songId=qq_<mid> 是权威键', async () => {
  // qq_ 外源解锁负状态键控在 qq_<mid> 本身（resolveTrackUnlock trackId
  // 直通）。providerData.neteaseId 是词源嫁接字段——拿它当解锁键会误清
  // 另一首网易数值曲的解锁状态，再不得入集
  events.length = 0; forgetThrowsOn = new Set();
  const pl = seedPlaylist('778809');
  const task = seedFailedTask(pl.id, 'qq_778809mid001', null,
    { qq: { mediaMid: 'm01' }, neteaseId: '77880911' });

  await dm.retryTask(task.id);
  await settleTick();

  assert.deepEqual(forgetCalls(), ['qq_778809mid001'],
    '只按 qq_<mid> 清——neteaseId 键不入集（误清数值网易曲解锁态）');
  assert.ok(!forgetCalls().includes('77880911'));
  assert.ok(forgetBeforeDispatch(), '负状态清理必须先于 dispatchStandalone');
  assert.ok(audioCalls().includes('qq_778809mid001'), '复位后任务应真被派出去');
});

test('retryTask（qq_ 外源解锁腿）：镜像行 neteaseId 重匹配后 providerData 刷新照旧、清理仍只按 songId', async () => {
  // providerData 刷新逻辑与清理键域无关——词源重匹配照旧写回新快照；
  // 但新旧两个 neteaseId 键都不再进 forget 集
  events.length = 0; forgetThrowsOn = new Set();
  const pl = seedPlaylist('778810');
  tracksRepo.replaceTracksForPlaylist(pl.id, [{
    id: 'qq_778810mid002', name: '歌', ar: [{ name: '艺人' }],
    qq: { mediaMid: 'm02' }, neteaseId: '77881022'
  }]);
  const task = seedFailedTask(pl.id, 'qq_778810mid002', null,
    { qq: { mediaMid: 'm02' }, neteaseId: '77881011' });

  await dm.retryTask(task.id);
  await settleTick();

  assert.deepEqual(forgetCalls(), ['qq_778810mid002'],
    '新旧 neteaseId 键都不入集——清理域只有 songId');
  // providerData 刷新照旧发生——新镜像行快照写回任务行（含 artists 投影）
  assert.equal(tasksRepo.findTaskById(task.id).providerData?.neteaseId, '77881022');
});

test('retryQueue（qq_ 外源解锁腿）：只按 songId 集去重——快照/镜像 neteaseId 一律不入集', async () => {
  // 批量口径同 retryTask：清理域只有 songId。三行任务各带数字
  // neteaseId（含镜像行重匹配键）——全部不得出现在 forget 序列
  events.length = 0; forgetThrowsOn = new Set();
  const pl = seedPlaylist('778811');
  tracksRepo.replaceTracksForPlaylist(pl.id, [
    { id: 'qq_778811mid003', name: '歌', ar: [{ name: '艺人' }], qq: { mediaMid: 'm03' }, neteaseId: '77881133' },
    { id: 'qq_778811mid004', name: '歌2', ar: [{ name: '艺人' }], qq: { mediaMid: 'm04' }, neteaseId: '77881155' },
    { id: 'qq_778811mid006', name: '歌3', ar: [{ name: '艺人' }], qq: { mediaMid: 'm06' }, neteaseId: '77881166' }
  ]);
  const queue = queuesRepo.createQueue({ playlistId: pl.id, name: pl.name, status: 'failed', totalTasks: 3 });
  seedFailedTask(pl.id, 'qq_778811mid003', queue.id, { qq: { mediaMid: 'm03' }, neteaseId: '77881133' });
  seedFailedTask(pl.id, 'qq_778811mid004', queue.id, { qq: { mediaMid: 'm04' }, neteaseId: '77881144' });
  seedFailedTask(pl.id, 'qq_778811mid006', queue.id, { qq: { mediaMid: 'm06' }, neteaseId: '778811xx' });

  await dm.retryQueue(queue.id);
  await settleTick();

  assert.deepEqual(forgetCalls().slice().sort(), [
    'qq_778811mid003', 'qq_778811mid004', 'qq_778811mid006'
  ].sort(), '清理域只有 songId——任何 neteaseId 键（快照/镜像/脏值）都不入集');
  assert.ok(!forgetCalls().some(c => /^\d+$/.test(c)),
    '纯数字键零出现——neteaseId 永不成清簿键');
  assert.ok(forgetBeforeDispatch(), '全部负状态清理必须先于 startQueue 派活');
  assert.equal(queuesRepo.findQueueById(queue.id).status, 'running');

  await dm.cancelQueue(queue.id);
});

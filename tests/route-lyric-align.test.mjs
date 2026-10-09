// routes/lyric-align.js 冒烟：参数校验 / audioPath 目录约束 / songId→任务
// 行寻址 / 词源拉取降级 / 端到端 LRC 产出（桩 AI + 真 wav + 真 DB）。
// ffmpeg 依赖的端到端用例在无 ffmpeg 环境自动跳过；参数校验路径不需要它。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { seed, tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-ralign-');
const require = createRequire(import.meta.url);

// AI 桩 + 词源桩（lyric 拉取路径用）；真 service/真 db/真盘工件
let aiOn = false;
let aiAnswer = null;
const aiCalls = [];
seed('../src/server/lib/ai.js', {
  aiEnabled: () => aiOn,
  aiModel: () => 'test-model',
  askAiJson: async (a) => {
    aiCalls.push(a);
    return typeof aiAnswer === 'function' ? aiAnswer(a) : aiAnswer;
  },
});
let lyricBody = { lrc: { lyric: '' }, tlyric: { lyric: '' } };
seed('../src/server/services/netease-api.js', {
  callNeteaseApi: async () => ({ body: lyricBody }),
  apiModules: {},
  estimateDuration: () => null,
});
// lyric-align 服务桩：默认委托真身（ffmpeg e2e 用例照旧全真），单例可替换
// impl 钉「ffmpeg 缺席」这类真身打不出的错误映射。真身须在 seed 前加载——
// 否则 require.cache 被桩顶替后再也拿不到真模块
const realAlignSvc = require('../src/server/services/lyric-align.js');
let alignImpl = null;
seed('../src/server/services/lyric-align.js', {
  alignAudioToLrc: (args) => (alignImpl ? alignImpl(args) : realAlignSvc.alignAudioToLrc(args)),
});

let app, downloadTasksRepo, playlistsRepo, DOWNLOAD_BASE_DIR;
before(() => {
  app = require('../src/server/routes/lyric-align.js');
  downloadTasksRepo = require('../src/server/repositories/downloadTasks.js');
  playlistsRepo = require('../src/server/repositories/playlists.js');
  DOWNLOAD_BASE_DIR = require('../src/server/services/download-fs.js').DOWNLOAD_BASE_DIR;
});
after(() => { rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

const post = (body) => app.request('http://t/lyric-align', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const json = async (res) => ({ status: res.status, body: await res.json() });

const FFMPEG_OK = (() => {
  try {
    const { spawnSync } = require('child_process');
    return spawnSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' }).status === 0;
  } catch { return false; }
})();

// 盘上工件：2s wav（0.6s 静音 + 1kHz 音）——够产 ~10 帧包络与起音
function makeWavFile(rel = '900/audio/t.wav') {
  const sr = 8000;
  const samples = new Array(2 * sr).fill(0);
  for (let i = Math.floor(0.6 * sr); i < 2 * sr; i++) {
    samples[i] = Math.round(12000 * Math.sin(2 * Math.PI * 1000 * i / sr));
  }
  const data = samples.length * 2;
  const buf = Buffer.alloc(44 + data);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + data, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(data, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], 44 + i * 2);
  const p = join(DOWNLOAD_BASE_DIR, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, buf);
  return p;
}

// ── 参数校验与寻址（无 ffmpeg 依赖）───────────────────────────────────────

test('lyric-align：缺 audioPath/songId → 400；缺 lines 且 songId 无词源形态 → 400', async () => {
  const r = await post({});
  assert.equal(r.status, 400);
  // 有音频无 lines 且 songId 无词源形态（bv_）→ 400 要求自带 lines。
  // 音频寻址先于行校验——必须给 bv_ 曲配一条 completed 任务行+真文件
  // 才进得到 lines 分支
  const fakeAudio = join(DOWNLOAD_BASE_DIR, '903/audio/blob.bin');
  mkdirSync(join(fakeAudio, '..'), { recursive: true });
  writeFileSync(fakeAudio, Buffer.alloc(64));
  const pl = playlistsRepo.upsertPlaylist({ neteasePlaylistId: 'local_pl_align_bv', name: 'bv' });
  const task = downloadTasksRepo.createTask({
    playlistId: pl.id, queueId: null, songId: 'bv_BV1xx411c7mD1', songName: '外部', artist: 'a',
  });
  downloadTasksRepo.updateTask(task.id, { status: 'completed', audioPath: fakeAudio });
  const r2 = await post({ songId: 'bv_BV1xx411c7mD1' });
  assert.equal(r2.status, 400);
  assert.match((await r2.json()).message, /lines/);
  // 音频工件不存在/任务未完成的同型 id → 404（先死在音频寻址）
  const r3 = await post({ songId: 'bv_BV1xx411c7mD2' });
  assert.equal(r3.status, 404);
});

test('lyric-align：audioPath 逃出下载目录 → 400；目录内不存在 → 404', async () => {
  const r = await post({ audioPath: '/etc/passwd', lines: ['a'] });
  assert.equal(r.status, 400);
  const inside = join(DOWNLOAD_BASE_DIR, 'ghost.wav');
  const r2 = await post({ audioPath: inside, lines: ['a'] });
  assert.equal(r2.status, 404);
  // .. 逃逸相对化后同样被拒
  const r3 = await post({ audioPath: join(DOWNLOAD_BASE_DIR, '..', 'x.wav'), lines: ['a'] });
  assert.equal(r3.status, 400);
});

test('lyric-align：songId 无下载任务行 → 404；schema 形态错 → 400', async () => {
  const r = await post({ songId: '880099', lines: ['a'] });
  assert.equal(r.status, 404);
  // lines 非数组元素过 schema：超长行 (>500) 直接 400
  const r2 = await post({ audioPath: '/x.wav', lines: ['a'.repeat(600)] });
  assert.equal(r2.status, 400);
  const r3 = await post({ audioPath: '/x.wav', lines: Array(601).fill('a') });
  assert.equal(r3.status, 400);
});

// ── 端到端（需 ffmpeg）───────────────────────────────────────────────────

test('lyric-align e2e：audioPath+lines 直传 → LLM 轴产 [mm:ss.xx] LRC', async (t) => {
  if (!FFMPEG_OK) return t.skip('环境无 ffmpeg');
  const wav = makeWavFile();
  aiOn = true;
  aiAnswer = { times: [700, 1400] };
  const r = await json(await post({ audioPath: wav, lines: ['第一句', '第二句'] }));
  assert.equal(r.status, 200);
  assert.equal(r.body.code, 200);
  assert.equal(r.body.alignedBy, 'llm');
  assert.equal(r.body.confidenceHint, 'medium');
  assert.equal(r.body.lineCount, 2);
  const rows = r.body.lrc.split('\n');
  assert.equal(rows.length, 2);
  assert.match(rows[0], /^\[00:0[01]\.\d{2}\]第一句$/); // 700ms 吸附到 ~600ms 起音
  assert.match(rows[1], /^\[00:01\.[0-4]\d\]第二句$/);
  assert.equal(aiCalls.length >= 1, true);
});

test('lyric-align e2e：AI 关 → heuristic 降级照常产 LRC', async (t) => {
  if (!FFMPEG_OK) return t.skip('环境无 ffmpeg');
  const wav = makeWavFile('900/audio/t-heur.wav');
  aiOn = false;
  const r = await json(await post({ audioPath: wav, lines: ['甲', '乙'] }));
  assert.equal(r.status, 200);
  assert.equal(r.body.alignedBy, 'heuristic');
  assert.equal(r.body.confidenceHint, 'low');
  const rows = r.body.lrc.split('\n');
  assert.equal(rows.length, 2);
  for (const row of rows) assert.match(row, /^\[\d{2}:\d{2}\.\d{2}\]/);
});

test('lyric-align e2e：songId 一行打通——任务行找音频 + 词源拉歌词', async (t) => {
  if (!FFMPEG_OK) return t.skip('环境无 ffmpeg');
  const wav = makeWavFile('901/audio/s.wav');
  const pl = playlistsRepo.upsertPlaylist({ neteasePlaylistId: 'local_pl_align_e2e', name: 'align' });
  const task = downloadTasksRepo.createTask({
    playlistId: pl.id, queueId: null, songId: '880101', songName: '对齐', artist: 'a',
  });
  downloadTasksRepo.updateTask(task.id, { status: 'completed', audioPath: wav });
  lyricBody = { lrc: { lyric: '[00:00.50]天外词一\n[00:01.00]天外词二' }, tlyric: { lyric: '' } };
  aiOn = true;
  aiAnswer = { times: [600, 1200] };
  const r = await json(await post({ songId: '880101' }));
  assert.equal(r.status, 200);
  assert.equal(r.body.alignedBy, 'llm');
  const rows = r.body.lrc.split('\n');
  assert.deepEqual(rows.map(l => l.replace(/^\[[^\]]+\]/, '')), ['天外词一', '天外词二']);
});

// ── 安全与错误映射 ──

test('lyric-align：异源 Origin 的写请求被 CSRF 闸拒 403', async () => {
  const r = await app.request('http://t/lyric-align', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
    body: JSON.stringify({ audioPath: '/etc/passwd', lines: ['a'] }),
  });
  assert.equal(r.status, 403);
  // 同路径不带 Origin（非浏览器客户端/自家 SPA 语义）→ 照常进校验 400/404
  const r2 = await post({ audioPath: '/etc/passwd', lines: ['a'] });
  assert.equal(r2.status, 400);
});

test('lyric-align：ffmpeg 缺席错误单独映射 503（与解码失败 502 区分）', async (t) => {
  if (!FFMPEG_OK) return t.skip('环境无 ffmpeg——本用例桩代其缺席');
  const wav = makeWavFile('904/audio/noff.wav');
  alignImpl = async () => { throw new Error('ffmpeg 不可用，无法分析音频'); };
  try {
    const r = await post({ audioPath: wav, lines: ['a'] });
    assert.equal(r.status, 503);
    assert.match((await r.json()).message, /ffmpeg/);
  } finally {
    alignImpl = null;
  }
});

test('lyric-align e2e：songId 有任务但词源无词 → 404', async (t) => {
  if (!FFMPEG_OK) return t.skip('环境无 ffmpeg');
  const wav = makeWavFile('902/audio/s.wav');
  const pl = playlistsRepo.upsertPlaylist({ neteasePlaylistId: 'local_pl_align_nolrc', name: 'nolrc' });
  const task = downloadTasksRepo.createTask({
    playlistId: pl.id, queueId: null, songId: '880102', songName: '无词', artist: 'a',
  });
  downloadTasksRepo.updateTask(task.id, { status: 'completed', audioPath: wav });
  lyricBody = { lrc: { lyric: '' }, tlyric: { lyric: '' } };
  const r = await post({ songId: '880102' });
  assert.equal(r.status, 404);
});

test('lyric-align：songId 词源是占位/无词标记 → neteaseLyricBody 归空 → 404', async () => {
  // 占位词（'纯音乐，请欣赏' 式）与 nolyric 旗标同走缺词归一——不该被
  // plainTextLines 剥出占位行当词源喂给对齐
  const fakeAudio = join(DOWNLOAD_BASE_DIR, '907/audio/ph.bin');
  mkdirSync(join(fakeAudio, '..'), { recursive: true });
  writeFileSync(fakeAudio, Buffer.alloc(64));
  const pl = playlistsRepo.upsertPlaylist({ neteasePlaylistId: 'local_pl_align_ph', name: 'ph' });
  const task = downloadTasksRepo.createTask({
    playlistId: pl.id, queueId: null, songId: '880105', songName: '占位', artist: 'a',
  });
  downloadTasksRepo.updateTask(task.id, { status: 'completed', audioPath: fakeAudio });
  try {
    lyricBody = {
      lrc: { lyric: '[99:00.00]纯音乐，请欣赏' },
      tlyric: { lyric: '[99:00.00]instrumental' },
    };
    const r1 = await post({ songId: '880105' });
    assert.equal(r1.status, 404);
    lyricBody = { nolyric: true, lrc: { lyric: '[00:01.00]不该到的词' }, tlyric: {} };
    const r2 = await post({ songId: '880105' });
    assert.equal(r2.status, 404);
  } finally {
    lyricBody = { lrc: { lyric: '' }, tlyric: { lyric: '' } };
  }
});

// ── 纯文本词兜底与叶子符号链接（alignImpl 桩免 ffmpeg）────────────────────

test('lyric-align：songId 词源是纯文本 → plainTextLines 兜底进对齐而非 404', async () => {
  // 无时间戳词走 songId 路径旧口径 parseLrcLines 空集即 404——本端点职责
  // 就是给「没轴的词」补轴；桩 align 直收行集断言它真被喂到
  const fakeAudio = join(DOWNLOAD_BASE_DIR, '905/audio/pt.bin');
  mkdirSync(join(fakeAudio, '..'), { recursive: true });
  writeFileSync(fakeAudio, Buffer.alloc(64));
  const pl = playlistsRepo.upsertPlaylist({ neteasePlaylistId: 'local_pl_align_pt', name: 'pt' });
  const task = downloadTasksRepo.createTask({
    playlistId: pl.id, queueId: null, songId: '880103', songName: '纯文', artist: 'a',
  });
  downloadTasksRepo.updateTask(task.id, { status: 'completed', audioPath: fakeAudio });
  lyricBody = { lrc: { lyric: '作词：某人\n第一段词文\n第二段词文' }, tlyric: { lyric: '' } };
  let gotLines = null;
  alignImpl = async ({ lines }) => {
    gotLines = lines;
    return { lrc: lines.map((t, i) => `[00:0${i}.00]${t}`).join('\n'), alignedBy: 'llm' };
  };
  try {
    const r = await json(await post({ songId: '880103' }));
    assert.equal(r.status, 200);
    // 剥戳/剥元行后词文行进对齐——「作词：某人」无方括号形态照样收
    // （plainTextLines 只滤 [tag:] 元行，署名行留给对齐引擎自行处理）
    assert.deepEqual(gotLines, ['作词：某人', '第一段词文', '第二段词文']);
    assert.match(r.body.lrc, /第二段词文/);
  } finally {
    alignImpl = null;
    lyricBody = { lrc: { lyric: '' }, tlyric: { lyric: '' } };
  }
});

test('lyric-align：叶子符号链接拒供——audioPath 直链与任务行两种入口都 404', async () => {
  // 链接路径自身在下载目录内但指向目录外真身——isUnderDownloadDir 只验
  // 链接路径；lstat 叶子链接即拒（目录级部署符号链接不受影响）
  const outside = join(process.env.DATA_DIR, 'outside.wav');
  writeFileSync(outside, Buffer.alloc(64));
  const link = join(DOWNLOAD_BASE_DIR, '906/audio/link.wav');
  mkdirSync(join(link, '..'), { recursive: true });
  symlinkSync(outside, link);
  // audioPath 分支：按不存在归 404（不给「存在但不可用」的信号差）
  const r1 = await post({ audioPath: link, lines: ['a'] });
  assert.equal(r1.status, 404);
  // songId 分支：任务行的 audioPath 是叶子链接 → 跳过该任务行 → 404
  const pl = playlistsRepo.upsertPlaylist({ neteasePlaylistId: 'local_pl_align_ln', name: 'ln' });
  const task = downloadTasksRepo.createTask({
    playlistId: pl.id, queueId: null, songId: '880104', songName: '链接', artist: 'a',
  });
  downloadTasksRepo.updateTask(task.id, { status: 'completed', audioPath: link });
  const r2 = await post({ songId: '880104', lines: ['a'] });
  assert.equal(r2.status, 404);
});

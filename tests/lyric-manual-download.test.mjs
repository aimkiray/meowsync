// 下载相位手选绑定短路（file-downloader.downloadLyrics）：
//   · song_lyric_manual 有绑定行 → 词文当级联命中直走同一落盘尾段——
//     外源级联、归属核验、网易 lyric/QQ getLyric 整链一次都不该被摸到
//     （用户终审压过全部自动词源，与播放链 getManualLyric 覆盖层同口径）
//   · 未绑定对照臂：级联照常出词落盘（writeExtHit 尾段重构的回归钉）
//   · 绑定行词文空白（畸形行）→ 落回自动链——手动层是覆盖层不锁死词载
// 真库绑定行 + 桩化 lyric-external/netease-api/lyric-verify/qq/lyric-align：
// 短路语义靠「桩一次没被摸到」钉死，落盘内容断全串。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { readFileSync, rmSync } from 'node:fs';
import { seed, tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-dlmanual-');
const require = createRequire(import.meta.url);

// 外源级联桩：录参——绑定在场时一次都不该被摸到；被摸到回一条级联词
// （未绑定对照臂靠它出词）
const extCalls = [];
seed('../src/server/services/lyric-external.js', {
  fetchExternalLyric: async (args) => {
    extCalls.push(args);
    return { lrc: '[00:01.00]级联词', source: 'lrclib', extId: 'lrclib_casc', synced: true };
  },
});
// 网易云 API 桩：绑定在场的数字 id 连 lyric 端点都不该打
const neCalls = [];
seed('../src/server/services/netease-api.js', {
  apiModules: { lyric: {} },
  callNeteaseApi: async (name, q) => {
    neCalls.push({ name, q });
    return { body: { code: 200, lrc: { lyric: '[00:01.00]网易词' } } };
  },
  resolveSongUrls: async () => {},
  needsUnlock: () => false,
  MAX_UNLOCK_ITEMS: 20,
});
// 归属核验桩：录参——绑定路径不该问到判官（核验面可能正压着当年错判
// 该词源的 verdict/署名闸记录，复核会把用户终审挡回门外）
const verifyCalls = [];
seed('../src/server/services/lyric-verify.js', {
  verifyDownloadOwnership: async (a) => { verifyCalls.push(a); return true; },
});
// QQ 词源桩：qq_ 绑定在场时 getLyric 不该被打
const qqCalls = [];
seed('../src/server/lib/qq.js', {
  getLyric: async (mid) => { qqCalls.push(mid); return { lyric: '[00:01.00]QQ词', trans: '' }; },
  pickStreamUrl: async () => null,
  BEST_LADDER: ['M500'],
  QUALITY_TIERS: { M500: { ext: 'm4a' } },
});
// 纯文本补轴桩：不真起 ffmpeg/LLM（录参判补轴是否触发）
const alignCalls = [];
seed('../src/server/services/lyric-align.js', {
  alignAudioToLrc: async (a) => { alignCalls.push(a); return null; },
});

let fd, lyricManualRepo;
before(() => {
  fd = require('../src/server/services/file-downloader.js');
  lyricManualRepo = require('../src/server/repositories/lyricManual.js');
});
after(() => { rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

const outFor = (name) => join(process.env.DATA_DIR, `${name}.lrc`);
const bind = (songId, over) => lyricManualRepo.upsertManual(songId, over);

test('downloadLyrics：yt_ 绑定在场 → 手选词直落盘，级联/核验零触碰', async () => {
  bind('yt_boundvid001', {
    extId: 'lrclib_7', source: 'lrclib',
    lrc: '[00:01.00]手选一\n[00:02.00]手选二', plain: '手选一\n手选二', synced: true,
  });
  const out = outFor('manual-yt');
  const r = await fd.downloadLyrics('yt_boundvid001', out, null, {
    youtube: { videoId: 'boundvid001', title: '题', author: '人' },
  });
  assert.equal(r.path, out);
  // 与外源命中同款落盘形态：词源 extId 烙进首部 [re:] 元行
  assert.equal(readFileSync(out, 'utf-8'),
    '[re:MeowSync lrclib_7]\n[00:01.00]手选一\n[00:02.00]手选二');
  assert.equal(extCalls.length, 0, '绑定在场不该触发外源级联');
  assert.equal(verifyCalls.length, 0, '用户终审不该被归属核验复核');
  assert.equal(neCalls.length, 0, 'yt_ 支路的网易 lyric 端点也不该碰');
});

test('downloadLyrics：数字 id 绑定在场 → 手选词压过网易词（整链覆盖）', async () => {
  bind('880300', {
    extId: 'kugou_k1', source: 'kugou', lrc: '[00:05.00]手选狗词', plain: '', synced: true,
  });
  const out = outFor('manual-ne');
  const r = await fd.downloadLyrics('880300', out, null, null);
  assert.equal(readFileSync(out, 'utf-8'), '[re:MeowSync kugou_k1]\n[00:05.00]手选狗词');
  assert.equal(neCalls.filter((c) => c.name === 'lyric').length, 0,
    '绑定在场连网易 lyric 端点都不该打');
});

test('downloadLyrics：qq_ 绑定在场 → getLyric 不打；纯文本绑定词照落', async () => {
  bind('qq_ab12cd34ef', {
    extId: 'ytm_ab12cd34ef', source: 'ytm',
    lrc: '纯文手选一\n纯文手选二', plain: '', synced: false,
  });
  const out = outFor('manual-qq');
  const r = await fd.downloadLyrics('qq_ab12cd34ef', out, null, { title: 't', author: 'a' });
  // synced=false 且盘上无音频工件 → 不补轴，纯文本照落（有词好过没词）
  assert.equal(readFileSync(out, 'utf-8'), '[re:MeowSync ytm_ab12cd34ef]\n纯文手选一\n纯文手选二');
  assert.equal(qqCalls.length, 0, 'qq_ 绑定在场不该打 getLyric');
  assert.equal(alignCalls.length, 0, '无音频工件不触发补轴');
});

test('downloadLyrics：未绑定对照——级联照常出词、过核验、落盘', async () => {
  extCalls.length = 0;
  verifyCalls.length = 0;
  const out = outFor('cascade-ctl');
  await fd.downloadLyrics('yt_unbound0001', out, null, {
    youtube: { videoId: 'unbound0001', title: 't', author: 'a' },
  });
  assert.equal(extCalls.length, 1, '未绑定应走外源级联');
  assert.equal(verifyCalls.length, 1, '级联命中仍过归属核验');
  assert.equal(readFileSync(out, 'utf-8'), '[re:MeowSync lrclib_casc]\n[00:01.00]级联词');
});

test('downloadLyrics：绑定行词文空白 → 落回级联（手动层不锁死词载）', async () => {
  bind('yt_blankman011', {
    extId: 'lrclib_b', source: 'lrclib', lrc: '   ', plain: '', synced: false,
  });
  extCalls.length = 0;
  const out = outFor('manual-blank');
  await fd.downloadLyrics('yt_blankman011', out, null, {
    youtube: { videoId: 'blankman011', title: 't', author: 'a' },
  });
  assert.equal(extCalls.length, 1, '空白绑定行应落回级联');
  assert.equal(readFileSync(out, 'utf-8'), '[re:MeowSync lrclib_casc]\n[00:01.00]级联词');
});

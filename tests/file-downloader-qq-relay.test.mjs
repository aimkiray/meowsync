// file-downloader qq_ 回链钉板：QQ 已关匿名取流，qq_ 任务 pickStreamUrl 回
// null（code=0 全档 purl 空的「健康」形态）或抛 qqAnonDenied（凭据级拒答
// 打标）时，providerData.neteaseId 是匿名可播唯一腿——走与数字 id 支同一
// 条 downloadNeteaseAudio 管线（song_url → resolveSongUrls → fetchStream →
// streamToFile），产物 metadata 照数字支语义（unblocked/unblockedSource/br，
// source 缺席烙 'qq→netease' 血缘标记）。
// 钉面：
//   - null 直链 + 合法 neteaseId → 网易腿成功，song_url 入参 {id,br} 原样
//   - qqAnonDenied + neteaseId → 同样回链成功
//   - 两腿全灭 → 抛原始 qq 错（wrapped 后 qqAnonDenied 标记存活，不吞因），
//     终错消息拼回链死因（netease=<err>）不再只留日志
//   - null-hit + 回链瞬时死 → 终错非 fatal（与 qqErr 重抛同权走 ≤3 重试）
//   - 无回链（neteaseId 缺席）终错文案按凭据态分档——匿名指引 vs VIP/地域
//   - neteaseId 缺席/畸形 → 不打网易腿，原始错穿透
//   - QQ 直链健康时照常走自身管线不触网易
//   - providerData 只读（冻结对象下不炸）
//   - 低档升级腿：M500/C400 hit（tier 码率 < 请求档）+ 合法 neteaseId 时
//     再试一脚回链——br 过 margin（>qqTier×1.25）换用并烙 qq→netease；
//     br null 只认无损容器（flac/wav）算真升级（合流 mp4/m4a 不换）；
//     回链声明时长与 expectedMs 差 >20% 判错配录音不换用；
//     br ≤ margin/非无损/错配弃回链产物保 qq hit；回链失败只降级不丢
//     兜底件；M800 达标/F000 顶格/无 neteaseId 均不触发
//   - bilivideo 系回链经 downloadNeteaseAudio 时 fetchStream 注
//     BILI_PUBLIC_HEADERS（UA+Referer 两件套）
//   - 落盘扩展名判定：URL path/mime= 推导优先，推导不出吃 item.type
//     （解锁链 resolved.ext 覆写产物——bilibili .m4s 链供 'm4a'），
//     type 白名单外/缺省仍回 mp3 兜底不扩面
// qq/netease-api 整模块桩；download-io 保留真身助手仅桩 fetchStream/
// streamToFile 字节腿——errnoToFatal/penetratesCandidates 是被测语义一部分
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { seed, tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-dl-qqrelay-');
const require = createRequire(import.meta.url);

// ── lib/qq 桩：pickStreamUrl 可翻转；QUALITY_TIERS/BEST_LADDER 同真身形状；
// hasQqCookie 供「无流」终错文案分档（匿名指引 vs VIP/地域）──
let pickImpl = async () => null;
let cookieOn = false;
const pickCalls = [];
seed('../src/server/lib/qq.js', {
  hasQqCookie: () => cookieOn,
  BEST_LADDER: ['F000', 'M800', 'M500', 'C400'],
  QUALITY_TIERS: {
    RS01: { ext: 'flac' }, F000: { ext: 'flac' },
    M800: { ext: 'mp3' }, M500: { ext: 'mp3' }, C400: { ext: 'm4a' },
  },
  pickStreamUrl: async (...a) => { pickCalls.push(a); return pickImpl(...a); },
});

// ── netease-api 桩面（与 file-downloader-unlockfail 同款全量解构面）─────────
const apiCalls = [];
let callApiImpl = async () => ({ body: { data: [] } });
// song_detail 派发支：校验闸的绑条元数据应答做在派发层——各用例的 callApiImpl
// 赋值点（song_url 等）零改动。detailSongs 默认绑条；detailImpl 在场按 ids
// 分支应答（freshId 两跳不同绑条）；detailThrow 注入传输故障（deferred 面）
let detailSongs = [{ id: 777001, name: '绑条', ar: [{ name: '绑艺人' }], dt: 200000 }];
let detailImpl = null;
let detailThrow = false;
const resolveCalls = [];
seed('../src/server/services/netease-api.js', {
  callNeteaseApi: (...a) => {
    apiCalls.push(a);
    if (a[0] === 'song_detail') {
      if (detailThrow) return Promise.reject(new Error('song_detail upstream boom'));
      if (detailImpl) return Promise.resolve(detailImpl(a[1], a[2]));
      return Promise.resolve({ body: { songs: detailSongs } });
    }
    return callApiImpl(...a);
  },
  resolveSongUrls: async (items, o) => { resolveCalls.push(o); return items; },
  needsUnlock: () => true,
  MAX_UNLOCK_ITEMS: 20,
  apiModules: {},
  estimateDuration: () => null,
  forgetSongUnlock: () => {},
});

// ── download-io：真身助手 + 桩字节腿（fetchStream/streamToFile 录参回放）────
const realIo = require('../src/server/services/download-io.js');
const fetchCalls = [];
const streamCalls = [];
let fetchImpl = async (url) => ({ status: 200, data: { destroy() {} }, headers: {}, url });
let streamImpl = async (resp, outputPath) => ({ path: outputPath, size: 4096 });
seed('../src/server/services/download-io.js', {
  ...realIo,
  fetchStream: (url, o) => { fetchCalls.push([url, o]); return fetchImpl(url, o); },
  streamToFile: (resp, outputPath, o) => {
    streamCalls.push([resp, outputPath, o]);
    return streamImpl(resp, outputPath, o);
  },
});

// AI 启用态桩：freshId 自救的 song_match 模型键读侧口径 aiEnabled()?aiModel():''
seed('../src/server/lib/ai.js', {
  aiEnabled: () => false,
  aiModel: () => '',
  askAiJson: async () => null,
});

const { downloadAudio } = require('../src/server/services/file-downloader.js');
const { getDb } = require('../src/server/db/client.js');
const songMatchRepo = require('../src/server/repositories/songMatch.js');
const { _resetRelayCaches } = require('../src/server/services/relay-gate.js');
const outDir = tmpDataDir('meowsync-dl-qqrelay-out-');

// 升级腿的胜出换名/弃用清理是真 fs 操作（renameSync/unlinkSync）——默认
// streamImpl 不落盘会让这些断言无实体可对。写穿 stub 让 streamToFile 真
// 写文件，内容烙来源 URL 供断言「最终主档是谁的字节」
const streamWriteThrough = async (resp, outputPath) => {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `bytes:${resp.url || ''}`);
  return { path: outputPath, size: 4096 };
};
// 主档族清点：升级腿只允许留下一件最终工件（.relay.* 中间件与败方档都不许残留）
const familyOf = (stem) => readdirSync(outDir).filter(f => f.startsWith(`${stem}.`)).sort();
const QQ_ID = 'qq_0034M8WL3V4oHA';
const deniedErr = () => {
  const e = new Error('qq musicu vkey.GetVkeyServer code=0/1000');
  e.qqAnonDenied = true; e.nodeCode = 1000; e.retcode = 104009;
  return e;
};

beforeEach(() => {
  pickImpl = async () => null;
  cookieOn = false;
  callApiImpl = async () => ({ body: { data: [] } });
  detailSongs = [{ id: 777001, name: '绑条', ar: [{ name: '绑艺人' }], dt: 200000 }];
  detailImpl = null;
  detailThrow = false;
  fetchImpl = async (url) => ({ status: 200, data: { destroy() {} }, headers: {}, url });
  streamImpl = async (resp, outputPath) => ({ path: outputPath, size: 4096 });
  pickCalls.length = apiCalls.length = resolveCalls.length = fetchCalls.length = streamCalls.length = 0;
  // 闸的账面清台：veto 行按 vkey=<trackId>@<nid>@<sig> 跨用例驻留会
  // 污染后续判定（块/放都快路零上行），freshId 用的 song_match 行同清；
  // detail 正/负档缓存是进程级态，同 nid 跨用例会命中陈旧绑条
  try {
    getDb().exec("DELETE FROM song_ai_verdict WHERE kind = 'audio_relay'");
    getDb().exec('DELETE FROM song_match');
  } catch { /* 首发用例表未建时兜底 */ }
  _resetRelayCaches();
});

test('qq 直链 null + providerData.neteaseId → 网易腿成功：song_url 原 id/br，产物烙 qq→netease', async () => {
  callApiImpl = async (name, args) => ({ body: { data: [
    { id: +args.id, url: 'https://m701.music.126.net/x.mp3', br: 320000 },
  ] } });
  const providerData = Object.freeze({ neteaseId: '777001', qq: { mediaMid: 'mm9' } });
  const r = await downloadAudio(QQ_ID, join(outDir, 'a.mp3'), 320000, null, null, providerData);
  assert.equal(r.size, 4096);
  assert.equal(r.unblocked, false);
  assert.equal(r.unblockedSource, 'qq→netease', '解锁血缘缺席时烙回链标记——血缘不进徽章语义也不丢');
  assert.deepEqual(apiCalls.filter(c => c[0] === 'song_url'), [['song_url', { id: '777001', br: 320000 }]]);
  assert.deepEqual(
    apiCalls.filter(c => c[0] === 'song_detail').map(c => [c[0], c[1]]),
    [['song_detail', { ids: '777001' }]],
    '回链消费前校验闸先取绑条 detail 做同一录音判定（第三参 signal 不比对）');
  // pickStreamUrl 吃到 providerData.qq.mediaMid + 码率档梯（省一次 vkey 空调用）
  assert.equal(pickCalls[0][0], '0034M8WL3V4oHA');
  assert.equal(pickCalls[0][1].mediaMid, 'mm9');
  assert.deepEqual(resolveCalls, [{ purpose: 'download', signal: null }]);
});

test('qq 抛 qqAnonDenied + neteaseId → 同样回链成功（拒答标记不阻断回链腿）', async () => {
  pickImpl = async () => { throw deniedErr(); };
  callApiImpl = async () => ({ body: { data: [
    { id: 42, url: 'https://m701.music.126.net/y.mp3', br: 320000,
      unblocked: true, unblockedBr: 128000, unblockedSource: 'kuwo' },
  ] } });
  const r = await downloadAudio(QQ_ID, join(outDir, 'b.mp3'), 320000, null, null,
    { neteaseId: '42' });
  assert.equal(r.unblocked, true);
  assert.equal(r.unblockedSource, 'kuwo', '解锁链自带 source 信息保留——回链标记不覆盖它');
  assert.equal(r.br, 128000, 'unblockedBr 真实码率语义与数字支一致');
});

test('两腿全灭 → 抛原始 qq 错：wrapped 后 qqAnonDenied 存活，回链死因拼上终错', async () => {
  pickImpl = async () => { throw deniedErr(); };
  callApiImpl = async () => ({ body: { data: [] } }); // fatalError('无法获取歌曲信息')：fatal 无 errno 不穿透
  const e = await downloadAudio(QQ_ID, join(outDir, 'c.mp3'), 320000, null, null,
    { neteaseId: '777001' }).then(() => null, x => x);
  assert.equal(e.qqAnonDenied, true, '回链失败不吞原因——匿名关停标记透给上层');
  assert.match(e.message, /code=0\/1000/);
  assert.match(e.message, /netease=无法获取歌曲信息/,
    '回链已尝试的死因拼上终错消息——不只留 console.warn');
});

test('neteaseId 缺席 → 不打网易腿；qqAnonDenied 原样穿透', async () => {
  pickImpl = async () => { throw deniedErr(); };
  const e = await downloadAudio(QQ_ID, join(outDir, 'd.mp3'), 320000, null, null, {})
    .then(() => null, x => x);
  assert.equal(e.qqAnonDenied, true);
  assert.equal(apiCalls.length, 0, '无回链键不该打 song_url');
});

test('neteaseId 形态非法（非纯数字）→ 同样不打网易腿，原始错穿透', async () => {
  pickImpl = async () => { throw deniedErr(); };
  const e = await downloadAudio(QQ_ID, join(outDir, 'e.mp3'), 320000, null, null,
    { neteaseId: 'abc/evil' }).then(() => null, x => x);
  assert.equal(e.qqAnonDenied, true);
  assert.equal(apiCalls.length, 0);
});

test('pickStreamUrl 抛未标记错（瞬断/风控非拒答形态）→ 不进回链判定：不打 song_url、原错穿透', async () => {
  pickImpl = async () => { throw new Error('qq musicu vkey.GetVkeyServer code=0/2000'); };
  const e = await downloadAudio(QQ_ID, join(outDir, 'e2.mp3'), 320000, null, null,
    { neteaseId: '777001' }).then(() => null, x => x);
  assert.match(e.message, /code=0\/2000/);
  assert.equal(e.qqAnonDenied, undefined, '未标记错不是凭据级拒答——回链判据不认它');
  assert.equal(apiCalls.length, 0, 'neteaseId 在场也不该打 song_url——照旧穿透');
});

test('null-hit + 回链瞬时死 → 终错非 fatal（与 qqErr 重抛同权走 ≤3 重试）且拼 netease= 死因', async () => {
  // ECONNRESET 不在 FATAL_ERRNOS——errnoToFatal 不标它，回链死是瞬时的
  callApiImpl = async () => {
    const e = new Error('netease ECONNRESET'); e.code = 'ECONNRESET'; throw e;
  };
  const e = await downloadAudio(QQ_ID, join(outDir, 'e3.mp3'), 320000, null, null,
    { neteaseId: '777001' }).then(() => null, x => x);
  assert.equal(e.fatal, false,
    '回链瞬时故障不带 fatal——同一瞬时网易故障不该因 qq 腿死法（null vs throw）丢重试权');
  assert.match(e.message, /netease=netease ECONNRESET/, '终错拼上回链死因');
  assert.equal(apiCalls.filter(c => c[0] === 'song_url').length, 1, '回链确实尝试过');
});

test('qq null 且无回链（neteaseId 缺席）→ 终错文案按凭据态分档', async () => {
  // 无 cookie：匿名取流关停的可执行指引（与 /qq/stream 404 同口径）
  let e = await downloadAudio(QQ_ID, join(outDir, 'e4.mp3'), 320000, null, null, {})
    .then(() => null, x => x);
  assert.equal(e.fatal, true, 'neteaseId 缺席=根本没进回链，确定性失败维持 fatal');
  assert.match(e.message, /QQ 已关闭匿名取流，请在设置页配置 QQ Cookie/);
  // 有 cookie：匿名关停不适用——保留 VIP/地域口径
  cookieOn = true;
  e = await downloadAudio(QQ_ID, join(outDir, 'e5.mp3'), 320000, null, null, {})
    .then(() => null, x => x);
  assert.equal(e.fatal, true);
  assert.match(e.message, /可能需要 VIP 权限或地域限制/);
});

test('qq null 且无 neteaseId → 维持原「无可用音源」fatal', async () => {
  const e = await downloadAudio(QQ_ID, join(outDir, 'f.mp3'), 320000, null, null, {})
    .then(() => null, x => x);
  assert.equal(e.fatal, true);
  assert.match(e.message, /QQ 音乐无可用音源/);
  assert.equal(e.qqAnonDenied, undefined, 'null 形态不打拒答标记——健康空与拒答是两种面');
  assert.equal(apiCalls.length, 0);
});

test('QQ 直链健康 → 走自身管线不触网易腿（tier→ext/br/unblockedSource 契约不变）', async () => {
  pickImpl = async () => ({ url: 'https://stream.qqmusic.qq.com/ok.mp3', tier: 'M800' });
  const r = await downloadAudio(QQ_ID, join(outDir, 'g.mp3'), 320000, null, null,
    { neteaseId: '777001' }); // neteaseId 在场也不得抢直链的活
  assert.equal(r.size, 4096);
  assert.equal(r.unblockedSource, 'qq/M800');
  assert.equal(r.br, 320000); // QQ_TIER_BR['M800']
  assert.equal(apiCalls.length, 0);
  assert.equal(fetchCalls[0][0], 'https://stream.qqmusic.qq.com/ok.mp3');
  assert.match(streamCalls[0][1], /g\.mp3$/);
});

// ── 低档升级腿：hit 在手但 tier 码率低于请求档 + neteaseId 在场 → 再试回链 ──

test('M500 hit（128k < 请求 320k）+ neteaseId → 回链被尝试且更优时换用，烙 qq→netease', async () => {
  pickImpl = async () => ({ url: 'https://stream.qqmusic.qq.com/low.mp3', tier: 'M500' });
  callApiImpl = async (name, args) => ({ body: { data: [
    { id: +args.id, url: 'https://m701.music.126.net/hi.mp3', br: 320000 },
  ] } });
  streamImpl = streamWriteThrough;
  const r = await downloadAudio(QQ_ID, join(outDir, 'up1.mp3'), 320000, null, null,
    { neteaseId: '777001' });
  assert.equal(apiCalls.filter(c => c[0] === 'song_url').length, 1, '到手档低于请求档该打回链升级');
  assert.deepEqual(apiCalls.filter(c => c[0] === 'song_url')[0], ['song_url', { id: '777001', br: 320000 }]);
  assert.equal(r.path, join(outDir, 'up1.mp3'), '回链胜出后换名入主档族');
  assert.equal(r.br, 320000, '报回链真实码率而非 qq 档位');
  assert.equal(r.unblockedSource, 'qq→netease', '与既有 !hit 回链同款血缘烙记');
  assert.equal(readFileSync(r.path, 'utf8'), 'bytes:https://m701.music.126.net/hi.mp3',
    '主档必须是回链字节——同扩展名时 rename 顶替而非两档并存');
  assert.deepEqual(familyOf('up1'), ['up1.mp3'],
    '主档族只留一件：.relay.* 中间件与 qq 低档档都不许残留');
});

test('M500 hit + 回链 br null（flac/unblocked 不可比形态）→ 视为更优换用，解锁源血缘保留', async () => {
  pickImpl = async () => ({ url: 'https://stream.qqmusic.qq.com/low.mp3', tier: 'M500' });
  callApiImpl = async () => ({ body: { data: [
    { id: 777001, url: 'https://upos-sz-mirrorcoso1.bilivideo.com/ugax/x.flac',
      unblocked: true, unblockedBr: null, unblockedSource: 'bilibili' },
  ] } });
  streamImpl = streamWriteThrough;
  const r = await downloadAudio(QQ_ID, join(outDir, 'up2.mp3'), 320000, null, null,
    { neteaseId: '777001' });
  assert.equal(r.path, join(outDir, 'up2.flac'), '回链真实扩展名换名入主档族');
  assert.equal(r.br, null, 'br 不可比保持 null——不拿声明值复活假分母');
  assert.equal(r.unblocked, true);
  assert.equal(r.unblockedSource, 'bilibili', '解锁链自带 source 不覆盖——同既有语义');
  assert.deepEqual(familyOf('up2'), ['up2.flac'],
    '扩展名不同名时 qq .mp3 低档档也被收走——不留双档');
  // 顺带钉死：bilibili 解锁源回链的 BILI_PUBLIC_HEADERS 注入在升级腿
  // 同样生效（UA+Referer 两件套——缺 UA 部分 CDN 判机器人 403）
  assert.deepEqual(fetchCalls[1][1].headers, {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Referer': 'https://www.bilibili.com',
    'Range': 'bytes=0-',
  });
});

test('M500 hit + 回链 br ≤ qq 档 → 弃回链产物保 qq hit（弃件清走不留双档）', async () => {
  pickImpl = async () => ({ url: 'https://stream.qqmusic.qq.com/low.mp3', tier: 'M500' });
  callApiImpl = async () => ({ body: { data: [
    { id: 777001, url: 'https://m701.music.126.net/lo.mp3', br: 96000 },
  ] } });
  streamImpl = streamWriteThrough;
  const r = await downloadAudio(QQ_ID, join(outDir, 'up3.mp3'), 320000, null, null,
    { neteaseId: '777001' });
  assert.equal(r.unblockedSource, 'qq/M500');
  assert.equal(r.br, 128000);
  assert.equal(r.path, join(outDir, 'up3.mp3'));
  assert.equal(readFileSync(r.path, 'utf8'), 'bytes:https://stream.qqmusic.qq.com/low.mp3',
    '回链不更优时主档仍是 qq 字节——旁系落盘保证 qq hit 没被先毁掉');
  assert.deepEqual(familyOf('up3'), ['up3.mp3'],
    '弃用回链产物（up3.mp3.relay.mp3）必须清走防残留双档');
  // 等码率也弃：br === qqTierBr 不属于「高于」
  callApiImpl = async () => ({ body: { data: [
    { id: 777001, url: 'https://m701.music.126.net/eq.mp3', br: 128000 },
  ] } });
  const r2 = await downloadAudio(QQ_ID, join(outDir, 'up4.mp3'), 320000, null, null,
    { neteaseId: '777001' });
  assert.equal(r2.unblockedSource, 'qq/M500');
  assert.deepEqual(familyOf('up4'), ['up4.mp3']);
});

test('M500 hit + 回链瞬时失败 → qq hit 保留兜底（升级腿只降级不吞活）', async () => {
  pickImpl = async () => ({ url: 'https://stream.qqmusic.qq.com/low.mp3', tier: 'M500' });
  callApiImpl = async () => { const e = new Error('netease ECONNRESET'); e.code = 'ECONNRESET'; throw e; };
  streamImpl = streamWriteThrough;
  const r = await downloadAudio(QQ_ID, join(outDir, 'up5.mp3'), 320000, null, null,
    { neteaseId: '777001' });
  assert.equal(apiCalls.filter(c => c[0] === 'song_url').length, 1, '回链确实尝试过');
  assert.equal(r.unblockedSource, 'qq/M500', '回链失败不丢已下载的 qq hit');
  assert.equal(readFileSync(r.path, 'utf8'), 'bytes:https://stream.qqmusic.qq.com/low.mp3');
  assert.deepEqual(familyOf('up5'), ['up5.mp3']);
});

test('M500 hit + neteaseId 缺席 → 升级腿不进，低档兜底照常', async () => {
  pickImpl = async () => ({ url: 'https://stream.qqmusic.qq.com/low.mp3', tier: 'M500' });
  const r = await downloadAudio(QQ_ID, join(outDir, 'up6.mp3'), 320000, null, null, {});
  assert.equal(r.unblockedSource, 'qq/M500');
  assert.equal(r.br, 128000);
  assert.equal(apiCalls.length, 0, '无回链键不该打 song_url');
});

test('F000 无损档（QQ_TIER_BR null）不触发升级腿——null 不得按 0 参与比较', async () => {
  pickImpl = async () => ({ url: 'https://stream.qqmusic.qq.com/hi.flac', tier: 'F000' });
  const r = await downloadAudio(QQ_ID, join(outDir, 'up7.mp3'), 320000, null, null,
    { neteaseId: '777001' });
  assert.equal(r.unblockedSource, 'qq/F000');
  assert.equal(r.br, null);
  assert.equal(apiCalls.length, 0, 'FLAC 已是顶格——升级腿不空打');
});

// ── bilivideo 系回链 BILI_PUBLIC_HEADERS 注入（downloadNeteaseAudio
// fetchStream 头）：防盗链两件套 UA+Referer 缺一 CDN 403 ──

test('bilivideo/bilivideo.cn/hdslb 回链 → fetchStream 注 UA+Referer；其他宿主保持裸 RANGE_ALL', async () => {
  streamImpl = streamWriteThrough;
  for (const [i, host] of [
    'upos-sz-mirrorcoso1.bilivideo.com', 'upos.bilivideo.cn', 'i0.hdslb.com',
  ].entries()) {
    fetchCalls.length = 0;
    callApiImpl = async () => ({ body: { data: [
      { id: 88, url: `https://${host}/ugax/x.m4a`, br: 320000 },
    ] } });
    await downloadAudio('88', join(outDir, `bv${i}.mp3`), 320000, null, null, {});
    assert.deepEqual(fetchCalls[0][1].headers, {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Referer': 'https://www.bilibili.com',
      'Range': 'bytes=0-',
    }, `${host} 防盗链要 UA+Referer 两件套（BILI_PUBLIC_HEADERS）——缺任一半套 403`);
  }
  // 非 bili 宿主不附带 Referer（googlevideo 等现有行为不动）
  fetchCalls.length = 0;
  callApiImpl = async () => ({ body: { data: [
    { id: 88, url: 'https://rr1---sn-x.googlevideo.com/v?mime=audio/mp4', br: 128000 },
  ] } });
  await downloadAudio('88', join(outDir, 'bv9.mp3'), 320000, null, null, {});
  assert.deepEqual(fetchCalls[0][1].headers, { Range: 'bytes=0-' });
  // URL 解析失败按非 bili 处理——不附带 Referer（fetchStream 桩不校 URL 合法性）
  fetchCalls.length = 0;
  callApiImpl = async () => ({ body: { data: [{ id: 88, url: 'not a url', br: 128000 }] } });
  await downloadAudio('88', join(outDir, 'bv8.mp3'), 320000, null, null, {});
  assert.deepEqual(fetchCalls[0][1].headers, { Range: 'bytes=0-' });
});

// ── 升级腿换用前时长闸：回链声明时长（song_url time 字段）与任务
// expectedMs 差 >20% 判错配录音——lyric 匹配容翻唱/live 不同录音，
// 换用后落盘对账判剪辑 unlink 而 qq 兜底已失＝新失败形态 ──

test('M500 hit + 回链声明时长与 expectedMs 差 >20% → 不换用保 qq hit（疑错配录音）', async () => {
  pickImpl = async () => ({ url: 'https://stream.qqmusic.qq.com/low.mp3', tier: 'M500' });
  // 闸的绑条时长（detail dt）须在 3%/8s 容差内先放行——本钉要考的是
  // 闸过后旧「song_url time 差 >20%」轴照常裁决（否则用例被闸拦成假过）
  detailSongs = [{ id: 777001, name: '绑条', ar: [{ name: '绑艺人' }], dt: 295000 }];
  callApiImpl = async () => ({ body: { data: [
    { id: 777001, url: 'https://m701.music.126.net/hi.mp3', br: 320000, time: 90000 },
  ] } });
  streamImpl = streamWriteThrough;
  const r = await downloadAudio(QQ_ID, join(outDir, 'dg1.mp3'), 320000, null, null,
    { neteaseId: '777001' }, 300000);
  // 90s vs 300s＝70% 偏差（live/翻唱级错配）——br 再优也不换：
  // 换用后 download-manager 的 durationLooksTruncated 会判剪辑 unlink
  // 结果，而 qq 兜底档已被收走＝M500 成功任务反成失败
  assert.equal(r.unblockedSource, 'qq/M500', '时长不符判错配录音不换用');
  assert.equal(readFileSync(r.path, 'utf8'), 'bytes:https://stream.qqmusic.qq.com/low.mp3');
  assert.deepEqual(familyOf('dg1'), ['dg1.mp3'], '弃用回链产物必须清走');
});

test('M500 hit + 回链声明时长差 ≤20% → 时长闸放行照常择优换用', async () => {
  pickImpl = async () => ({ url: 'https://stream.qqmusic.qq.com/low.mp3', tier: 'M500' });
  detailSongs = [{ id: 777001, name: '绑条', ar: [{ name: '绑艺人' }], dt: 295000 }];
  callApiImpl = async () => ({ body: { data: [
    { id: 777001, url: 'https://m701.music.126.net/hi.mp3', br: 320000, time: 250000 },
  ] } });
  streamImpl = streamWriteThrough;
  const r = await downloadAudio(QQ_ID, join(outDir, 'dg2.mp3'), 320000, null, null,
    { neteaseId: '777001' }, 300000);
  // 250s vs 300s＝16.7% 偏差——同录音跨平台声明漂移面，闸不误杀
  assert.equal(r.unblockedSource, 'qq→netease');
  assert.equal(readFileSync(r.path, 'utf8'), 'bytes:https://m701.music.126.net/hi.mp3');
  assert.deepEqual(familyOf('dg2'), ['dg2.mp3']);
});

test('expectedMs 缺省 → 时长闸不触发：回链 timeMs 在场也照常换用', async () => {
  pickImpl = async () => ({ url: 'https://stream.qqmusic.qq.com/low.mp3', tier: 'M500' });
  callApiImpl = async () => ({ body: { data: [
    { id: 777001, url: 'https://m701.music.126.net/hi.mp3', br: 320000, time: 60000 },
  ] } });
  streamImpl = streamWriteThrough;
  const r = await downloadAudio(QQ_ID, join(outDir, 'dg3.mp3'), 320000, null, null,
    { neteaseId: '777001' }); // 无 expectedMs——省流/无时长任务不降级
  assert.equal(r.unblockedSource, 'qq→netease', '无任务时长跳过时长闸');
  assert.equal(readFileSync(r.path, 'utf8'), 'bytes:https://m701.music.126.net/hi.mp3');
});

test('expectedMs 在场但回链 timeMs 缺席 → 跳过闸照常择优（不误伤换用）', async () => {
  pickImpl = async () => ({ url: 'https://stream.qqmusic.qq.com/low.mp3', tier: 'M500' });
  detailSongs = [{ id: 777001, name: '绑条', ar: [{ name: '绑艺人' }], dt: 295000 }];
  callApiImpl = async () => ({ body: { data: [
    { id: 777001, url: 'https://m701.music.126.net/hi.mp3', br: 320000 }, // 无 time 字段
  ] } });
  streamImpl = streamWriteThrough;
  const r = await downloadAudio(QQ_ID, join(outDir, 'dg4.mp3'), 320000, null, null,
    { neteaseId: '777001' }, 300000);
  assert.equal(r.unblockedSource, 'qq→netease', '回链无声明时长不该误伤换用');
  assert.equal(r.timeMs, null, 'timeMs 缺席如实报 null');
});

// ── N-1 择优收紧：br null 只认无损容器；可比码率要 margin 才换 ──

test('M500 hit + 回链 br null 且扩展名非无损（progressive 合流 m4a）→ 不换用', async () => {
  pickImpl = async () => ({ url: 'https://stream.qqmusic.qq.com/low.mp3', tier: 'M500' });
  // youtube progressive 合流档：unblockedBr 恒 null——容器总码率不可当
  // 音轨码率；旧「null 恒赢」口径会把带视频轨的降级 mp4 换进音频位
  callApiImpl = async () => ({ body: { data: [
    { id: 777001, url: 'https://rr1---sn-x.googlevideo.com/v?mime=video/mp4',
      unblocked: true, unblockedBr: null, unblockedSource: 'youtube' },
  ] } });
  streamImpl = streamWriteThrough;
  const r = await downloadAudio(QQ_ID, join(outDir, 'n1a.mp3'), 320000, null, null,
    { neteaseId: '777001' });
  assert.equal(r.unblockedSource, 'qq/M500', '非无损的 br null 不可比不算赢');
  assert.equal(readFileSync(r.path, 'utf8'), 'bytes:https://stream.qqmusic.qq.com/low.mp3');
  assert.deepEqual(familyOf('n1a'), ['n1a.mp3'], '弃用的 *.relay.m4a 必须清走');
});

test('M500 hit + 回链 br 130k vs 128k 档（margin 内平级）→ 不换用', async () => {
  pickImpl = async () => ({ url: 'https://stream.qqmusic.qq.com/low.mp3', tier: 'M500' });
  // youtube ~130k opus 换 128k mp3：128k×1.25=160k 未越——花整段回链
  // 流量买边际提升的平级替换不触发
  callApiImpl = async () => ({ body: { data: [
    { id: 777001, url: 'https://rr1---sn-x.googlevideo.com/v?mime=audio/webm',
      unblocked: true, unblockedBr: 130000, unblockedSource: 'youtube' },
  ] } });
  streamImpl = streamWriteThrough;
  const r = await downloadAudio(QQ_ID, join(outDir, 'n1b.mp3'), 320000, null, null,
    { neteaseId: '777001' });
  assert.equal(r.unblockedSource, 'qq/M500', 'margin 内平级不触发换用');
  assert.equal(readFileSync(r.path, 'utf8'), 'bytes:https://stream.qqmusic.qq.com/low.mp3');
  assert.deepEqual(familyOf('n1b'), ['n1b.mp3']);
});

test('M500 hit + 回链 br 192k > 128k×1.25 → 过 margin 换用', async () => {
  pickImpl = async () => ({ url: 'https://stream.qqmusic.qq.com/low.mp3', tier: 'M500' });
  callApiImpl = async () => ({ body: { data: [
    { id: 777001, url: 'https://m701.music.126.net/hi.mp3', br: 192000 },
  ] } });
  streamImpl = streamWriteThrough;
  const r = await downloadAudio(QQ_ID, join(outDir, 'n1c.mp3'), 320000, null, null,
    { neteaseId: '777001' });
  assert.equal(r.unblockedSource, 'qq→netease');
  assert.equal(r.br, 192000);
  assert.equal(readFileSync(r.path, 'utf8'), 'bytes:https://m701.music.126.net/hi.mp3');
  assert.deepEqual(familyOf('n1c'), ['n1c.mp3']);
});

// ── 落盘扩展名判定（downloadNeteaseAudio 的 extFromUrl fallback）──
// URL path/mime= 推导优先（直链最诚实）；推导不出吃 item.type——解锁链
// resolved.ext 覆写进它的 provider 显式供值（bilibili .m4s 链供 'm4a'）；
// type 白名单外/缺省仍回 mp3，AUDIO_EXTS.has 闸不扩面。

test('.m4s 尾缀 + item.type=m4a（bilibili 解锁链形态）→ 落盘 .m4a 不套 mp3 壳', async () => {
  // bilibili 解锁回链：DASH 音轨是 ISOBMFF/AAC 段，pathname 尾 .m4s 不在
  // 音频白名单、链上也不带 mime= 参数——旧码错落 .mp3 壳
  callApiImpl = async () => ({ body: { data: [
    { id: 88, url: 'https://upos-sz-mirrorcoso1.bilivideo.com/ugax/code/abc.m4s',
      br: 320000, unblocked: true, unblockedBr: 192000,
      unblockedSource: 'bilibili', type: 'm4a' },
  ] } });
  const r = await downloadAudio('88', join(outDir, 'ext1.mp3'), 320000, null, null, {});
  assert.match(r.path, /ext1\.m4a$/,
    'URL 推导不出时吃 item.type——.m4s 壳真实容器是 m4a');
  assert.match(streamCalls[0][1], /ext1\.m4a$/, 'streamToFile 收到的落盘路径同口径');
});

test('item.type 缺省/非白名单 → URL 推导与 mp3 兜底照旧，且 URL 优先于 type', async () => {
  // type 缺席：URL path 推导照常（既有行为不变）
  callApiImpl = async () => ({ body: { data: [
    { id: 88, url: 'https://m701.music.126.net/x.flac', br: 320000 },
  ] } });
  let r = await downloadAudio('88', join(outDir, 'ext2.mp3'), 320000, null, null, {});
  assert.match(r.path, /ext2\.flac$/, 'type 缺席不影响 URL path 推导');

  // type 在场但 URL 可推导：URL 优先——网易/yt 直链 path/mime= 最诚实
  callApiImpl = async () => ({ body: { data: [
    { id: 88, url: 'https://m701.music.126.net/x.flac', br: 320000, type: 'm4a' },
  ] } });
  r = await downloadAudio('88', join(outDir, 'ext3.mp3'), 320000, null, null, {});
  assert.match(r.path, /ext3\.flac$/, 'URL 推导优先于 item.type');

  // type 非白名单值 + URL 推不出：AUDIO_EXTS.has 闸挡回 mp3——type 不扩面
  callApiImpl = async () => ({ body: { data: [
    { id: 88, url: 'https://upos-sz-mirrorcoso1.bilivideo.com/ugax/x.m4s',
      br: 320000, type: 'php' },
  ] } });
  r = await downloadAudio('88', join(outDir, 'ext4.mp3'), 320000, null, null, {});
  assert.match(r.path, /ext4\.mp3$/, '白名单外 type 值被闸挡——仍回 mp3 兜底');
});

// ── 词源回链音频校验闸接入面（services/relay-gate.js——真判定层+真 veto 账
// + 真 song_match 自救）──
// providerData.title/author 是期望曲快照（download-fs 投影）：绑条 detail
// 先过「同一录音」判定才进字节腿。block→fatal 不打 song_url（veto/sig 窗内
// 重判恒同果）；freshId 自救换 song_match 正绑续腿；detail 不可达→deferred
// 非 fatal 保 ≤3 重试权；升级腿 block/unknown 都保在手 hit 不进腿。

test('主回链腿·闸 block：绑条艺人/时长与期望不符 → 不打 song_url，fatal 终错拼 netease= 死因', async () => {
  detailSongs = [{ id: 777001, name: '娘子', ar: [{ name: '叶藏澈' }], dt: 326000 }];
  const e = await downloadAudio('qq_GATEBLOCK1', join(outDir, 'gb1.mp3'), 320000, null, null,
    { neteaseId: '777001', title: '娘子', author: '周杰伦' }, 271000)
    .then(() => null, x => x);
  assert.equal(e.fatal, true, '闸拒=确定性判定——不浪费任务级 ≤3 重试');
  assert.match(e.message, /netease=词源回链音频校验未过/);
  assert.match(e.message, /artist_mismatch/);
  assert.equal(apiCalls.filter(c => c[0] === 'song_url').length, 0,
    '被拦绑条不该再付一次 song_url/字节流');
});

test('主回链腿·闸 block + qqAnonDenied → 终错拼双死因且拒答标记存活', async () => {
  pickImpl = async () => { throw deniedErr(); };
  detailSongs = [{ id: 777002, name: '娘子', ar: [{ name: '叶藏澈' }], dt: 326000 }];
  const e = await downloadAudio('qq_GATEBLOCK2', join(outDir, 'gb2.mp3'), 320000, null, null,
    { neteaseId: '777002', title: '娘子', author: '周杰伦' }, 271000)
    .then(() => null, x => x);
  assert.equal(e.qqAnonDenied, true, '闸拒也不吞匿名关停标记——透给上层分档');
  assert.match(e.message, /code=0\/1000/);
  assert.match(e.message, /netease=词源回链音频校验未过/);
  assert.equal(e.fatal, false,
    '有意口径：combined 终错跟主错 qqErr 的非 fatal 档（qqAnonDenied 是凭据态可修'
    + '——补 Cookie/换绑即可翻身，重试权不因拼上闸拒死因而缩水）；与无 qqErr 时'
    + '闸拒单发的 fatal 定档不同。重试也便宜——veto 快路零上行，换绑正行还能经'
    + ' freshId 自救放行');
});

test('主回链腿·freshId 自救：快照绑条被拦 + song_match 正绑异 id 过闸 → song_url 入参换正绑', async () => {
  songMatchRepo.upsertMatch('qq_FRESHID001', '777002', '娘子 周杰伦', 90, '');
  detailImpl = (args) => ({ body: { songs: String(args.ids) === '777002'
    ? [{ id: 777002, name: '娘子', ar: [{ name: '周杰伦' }], dt: 272000 }]
    : [{ id: 777001, name: '娘子', ar: [{ name: '叶藏澈' }], dt: 326000 }] } });
  callApiImpl = async () => ({ body: { data: [
    { id: 777002, url: 'https://m701.music.126.net/fresh.mp3', br: 320000 },
  ] } });
  streamImpl = streamWriteThrough;
  const r = await downloadAudio('qq_FRESHID001', join(outDir, 'gf.mp3'), 320000, null, null,
    { neteaseId: '777001', title: '娘子', author: '周杰伦' }, 271000);
  assert.equal(r.unblockedSource, 'qq→netease');
  assert.deepEqual(apiCalls.filter(c => c[0] === 'song_url'),
    [['song_url', { id: '777002', br: 320000 }]],
    'freshId 过闸后下载腿换 song_match 正绑 id——provider_data 快照滞后期自赎');
  assert.deepEqual(apiCalls.filter(c => c[0] === 'song_detail').map(c => c[1].ids),
    ['777001', '777002'], '原绑条被拦后对正绑重判一跳');
  assert.equal(readFileSync(r.path, 'utf8'), 'bytes:https://m701.music.126.net/fresh.mp3');
});

test('主回链腿·freshId 无解：正绑同 id/在否决簿不当候选 → 落 fatal（连 detail 跳都不付）', async () => {
  // 正绑在 song_match 词源否决簿内——freshRelayId 明确不拿它当候选
  songMatchRepo.upsertMatch('qq_FRESHVETO1', '777002', 'q', 90, '');
  songMatchRepo.mergeVetoed('qq_FRESHVETO1', ['777002'], '');
  // 777002 的 detail 即便能过也不该被问——否决簿挡候选先于判定
  detailImpl = (args) => ({ body: { songs: [
    { id: +String(args.ids), name: '娘子', ar: [{ name: '周杰伦' }], dt: 272000 }] } });
  const e = await downloadAudio('qq_FRESHVETO1', join(outDir, 'gv.mp3'), 320000, null, null,
    { neteaseId: '777001', title: '娘子', author: '叶藏澈' }, 326000)
    .then(() => null, x => x);
  assert.equal(e.fatal, true);
  assert.deepEqual(apiCalls.filter(c => c[0] === 'song_detail').map(c => c[1].ids),
    ['777001'], '否决簿内 id 不当自救候选');
  assert.equal(apiCalls.filter(c => c[0] === 'song_url').length, 0);
  // 正绑与快照同 id → 自救无意义不续腿（同 nid 还吃上正档缓存零新跳）
  songMatchRepo.upsertMatch('qq_FRESHSAME1', '777001', 'q', 90, '');
  const e2 = await downloadAudio('qq_FRESHSAME1', join(outDir, 'gv2.mp3'), 320000, null, null,
    { neteaseId: '777001', title: '娘子', author: '叶藏澈' }, 326000)
    .then(() => null, x => x);
  assert.equal(e2.fatal, true);
  assert.equal(apiCalls.filter(c => c[0] === 'song_detail').length, 1,
    '同 nid 二跳吃 detail 正档缓存——零边际上行');
});

test('主回链腿·freshId 自救失败（正绑也不过闸）→ 落 fatal，两跳 detail 都留痕', async () => {
  songMatchRepo.upsertMatch('qq_FRESHBLOCK', '777002', 'q', 90, '');
  detailImpl = (args) => ({ body: { songs: [
    { id: +String(args.ids), name: '娘子', ar: [{ name: '叶藏澈' }], dt: 326000 }] } });
  const e = await downloadAudio('qq_FRESHBLOCK', join(outDir, 'gb3.mp3'), 320000, null, null,
    { neteaseId: '777001', title: '娘子', author: '周杰伦' }, 271000)
    .then(() => null, x => x);
  assert.equal(e.fatal, true, '自救不过闸落回原判 block——一次为限不递归');
  assert.deepEqual(apiCalls.filter(c => c[0] === 'song_detail').map(c => c[1].ids),
    ['777001', '777002'], '原绑条与正绑各付一跳 detail 并各自落 veto 账');
  assert.equal(apiCalls.filter(c => c[0] === 'song_url').length, 0);
});

test('主回链腿·detail 不可达 → deferred：终错非 fatal 保 ≤3 重试权，不打 song_url', async () => {
  detailThrow = true;
  const e = await downloadAudio('qq_GATEDEFER1', join(outDir, 'gd.mp3'), 320000, null, null,
    { neteaseId: '777003', title: '娘子', author: '周杰伦' }, 271000)
    .then(() => null, x => x);
  assert.equal(e.fatal, false, 'detail 不可达=瞬时面——不固化未验证文件也不判死');
  assert.match(e.message, /netease=词源回链校验上游暂不可达/);
  assert.equal(apiCalls.filter(c => c[0] === 'song_url').length, 0);
});

test('升级腿·闸 block → 不进 .relay 升级保 qq hit（familyOf 单档不破）', async () => {
  pickImpl = async () => ({ url: 'https://stream.qqmusic.qq.com/low.mp3', tier: 'M500' });
  detailSongs = [{ id: 777004, name: '娘子', ar: [{ name: '叶藏澈' }], dt: 326000 }];
  streamImpl = streamWriteThrough;
  const r = await downloadAudio('qq_GATEUPBLK1', join(outDir, 'gu.mp3'), 320000, null, null,
    { neteaseId: '777004', title: '娘子', author: '周杰伦' }, 271000);
  assert.equal(r.unblockedSource, 'qq/M500', '被拦不进升级腿——在手档不丢');
  assert.equal(readFileSync(r.path, 'utf8'), 'bytes:https://stream.qqmusic.qq.com/low.mp3');
  assert.deepEqual(familyOf('gu'), ['gu.mp3'], '不产生 .relay.* 中间件——闸先于下载');
  assert.equal(apiCalls.filter(c => c[0] === 'song_url').length, 0);
});

test('升级腿·detail 不可达 → 跳过升级保 hit（不为不可证证据降级在手档）', async () => {
  pickImpl = async () => ({ url: 'https://stream.qqmusic.qq.com/low.mp3', tier: 'M500' });
  detailThrow = true;
  streamImpl = streamWriteThrough;
  const r = await downloadAudio('qq_GATEUPUNK1', join(outDir, 'gu2.mp3'), 320000, null, null,
    { neteaseId: '777005' });
  assert.equal(r.unblockedSource, 'qq/M500');
  assert.equal(apiCalls.filter(c => c[0] === 'song_url').length, 0,
    'detail 拿不到不打 song_url——尽力腿静默保 hit');
  assert.deepEqual(familyOf('gu2'), ['gu2.mp3']);
});

test('同 nid 两腿只一跳 detail：主腿过后升级腿吃正档缓存/veto 账零上行', async () => {
  callApiImpl = async () => ({ body: { data: [
    { id: 777006, url: 'https://m701.music.126.net/leg1.mp3', br: 320000 },
  ] } });
  detailSongs = [{ id: 777006, name: 'X', ar: [{ name: 'Y' }], dt: 200000 }];
  streamImpl = streamWriteThrough;
  // 第一发 null-hit 主腿：detail 一跳 + 过闸下载
  await downloadAudio('qq_GATETWOLEG', join(outDir, 'tl.mp3'), 320000, null, null,
    { neteaseId: '777006' });
  // 第二发 M500 hit 升级腿：同 nid——detail 正档命中不再上行（异 trackId
  // 绕开 veto 快路，钉死的是 detail 缓存面；同 trackId 则 veto 零上行）
  pickImpl = async () => ({ url: 'https://stream.qqmusic.qq.com/low.mp3', tier: 'M500' });
  await downloadAudio('qq_GATETWOLG2', join(outDir, 'tl2.mp3'), 320000, null, null,
    { neteaseId: '777006' });
  assert.equal(apiCalls.filter(c => c[0] === 'song_detail').length, 1,
    '两腿同 nid 只付一跳 detail');
});

test('veto 双向账：block 落账后二次同参判定走快路零上行，否决不自动失效', async () => {
  detailSongs = [{ id: 777007, name: '娘子', ar: [{ name: '叶藏澈' }], dt: 326000 }];
  const pd = { neteaseId: '777007', title: '娘子', author: '周杰伦' };
  const e1 = await downloadAudio('qq_GATEVETO01', join(outDir, 'vt.mp3'), 320000, null, null, pd, 271000)
    .then(() => null, x => x);
  assert.equal(e1.fatal, true);
  assert.equal(apiCalls.filter(c => c[0] === 'song_detail').length, 1, '首判付一跳 detail');
  const e2 = await downloadAudio('qq_GATEVETO01', join(outDir, 'vt2.mp3'), 320000, null, null, pd, 271000)
    .then(() => null, x => x);
  assert.equal(e2.fatal, true, 'vetoed block 仍拦——证据性判定，重试不产新证据');
  assert.equal(apiCalls.filter(c => c[0] === 'song_detail').length, 1,
    '二次判定 veto 快路——零上行零重判');
});

test('providerData 冻结对象下闸组装不炸（只读契约）', async () => {
  detailSongs = [{ id: 777008, name: '娘子', ar: [{ name: '周杰伦' }], dt: 272000 }];
  callApiImpl = async () => ({ body: { data: [
    { id: 777008, url: 'https://m701.music.126.net/fz.mp3', br: 320000 },
  ] } });
  const r = await downloadAudio('qq_GATEFROZEN', join(outDir, 'fz.mp3'), 320000, null, null,
    Object.freeze({ neteaseId: '777008', title: '娘子', author: '周杰伦',
      qq: Object.freeze({ mediaMid: 'mm' }) }), 271000);
  assert.equal(r.unblockedSource, 'qq→netease');
});

test('期望艺人哨兵值（QQ 音乐兜底名）→ 剔出比对不误拦（neutral→pass）', async () => {
  detailSongs = [{ id: 777009, name: 'X', ar: [{ name: '某艺人' }], dt: 200000 }];
  callApiImpl = async () => ({ body: { data: [
    { id: 777009, url: 'https://m701.music.126.net/s.mp3', br: 320000 },
  ] } });
  const r = await downloadAudio('qq_GATESENT01', join(outDir, 'st.mp3'), 320000, null, null,
    { neteaseId: '777009', title: 'X', author: 'QQ 音乐' });
  assert.equal(r.unblockedSource, 'qq→netease',
    '无艺人兜底名按无信息处理——哨兵不剔会全场误拦');
});

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
// qq/netease-api 整模块桩；download-io 保留真身助手仅桩 fetchStream/
// streamToFile 字节腿——errnoToFatal/penetratesCandidates 是被测语义一部分
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
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
  QUALITY_TIERS: { M800: { ext: 'mp3' }, M500: { ext: 'mp3' } },
  pickStreamUrl: async (...a) => { pickCalls.push(a); return pickImpl(...a); },
});

// ── netease-api 桩面（与 file-downloader-unlockfail 同款全量解构面）─────────
const apiCalls = [];
let callApiImpl = async () => ({ body: { data: [] } });
const resolveCalls = [];
seed('../src/server/services/netease-api.js', {
  callNeteaseApi: (...a) => { apiCalls.push(a); return callApiImpl(...a); },
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

const { downloadAudio } = require('../src/server/services/file-downloader.js');
const outDir = tmpDataDir('meowsync-dl-qqrelay-out-');
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
  fetchImpl = async (url) => ({ status: 200, data: { destroy() {} }, headers: {}, url });
  streamImpl = async (resp, outputPath) => ({ path: outputPath, size: 4096 });
  pickCalls.length = apiCalls.length = resolveCalls.length = fetchCalls.length = streamCalls.length = 0;
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
  assert.deepEqual(apiCalls, [['song_url', { id: '777001', br: 320000 }]]);
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
  assert.equal(apiCalls.length, 1, '回链确实尝试过');
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

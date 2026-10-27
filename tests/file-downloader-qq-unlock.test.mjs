// file-downloader qq_ 外源解锁钉板（spec §4.1 腿序 + §12 S3 断言面）：
// QQ 已关匿名取流，qq_ 任务 pickStreamUrl 回 null（code=0 全档 purl 空
// 「健康」形态）或抛 qqAnonDenied（凭据级拒答打标）时，腿序 =
// 自有 pickStream → 手动绑定（外层腿专职消费）→ 外源解锁
//（resolveTrackUnlock 共享链，QQ_UNLOCK_SOURCES=youtube→bilibili——
// pyncmd 是网易数值 id 直解器对 qq_<mid> 无语义）。
// 钉面：
//   - QQ 直链健康 → qq/<tier> 血缘照旧，resolveTrackUnlock 与
//     callNeteaseApi('song_url') 双双零触达（pd.neteaseId 在场也不抢活）
//   - MANUAL-ONCE：绑定腿成功 → 共享链零调用；绑定腿死 → 共享链兜底
//     （includeManual:false——链内手动步连 repo 读都跳过）
//   - 调参钉死：trackId=qq_<mid> 直通、purpose=download、proxied=false、
//     sources=['youtube','bilibili']（pyncmd 永不入列）、
//     originalDt=expectedMs、buildInfo 惰性装配 qqUnlockInfo
//   - 外源命中 verbatim：url/urls/br/ext/timeMs 保真 + unblockedSource
//     'qq→<src>' 血缘烙记
//   - 镜像组逐试：urls[0] 403 自动换 urls[1]，usedUrl 如实回
//   - errors→终错：全确定性 → fatal + 逐源「source: msg」全角分号串；
//     任一 transient → 非 fatal 保 ≤3 重试；errors 空 → 无逐源记录文案
//   - pd.neteaseId 在场 → song_url/resolveSongUrls 双双零调用
//    （词源字段非音频源——qq 音频零消费红线）
//   - 低档升级腿：M500/C400 hit（tier 码率 < 请求档）→ 第二跳
//     sources=['bilibili'] 独源（bv-only——yt ~130k opus 对 128k×1.25
//     永不胜）；br>margin/无损容器换用烙 qq→bilibili；候选不胜出/
//     链抛错 resolve 期早退保在手 hit，零字节浪费；M800 达标/F000
//     顶格不烧升级一跳
//   - qqAnonDenied + 外源全灭 → 拒答标记存活 + （unlock=…）死因拼终错
//   - 终错文案按凭据态分档 + providerData 冻结对象只读契约
//   - 数值域委托面回归：'88' 仍 song_url→resolveSongUrls→persist 同形
// qq/netease-api/unlock 索引整模块桩；download-io 保留真身助手仅桩
// fetchStream/streamToFile 字节腿——errnoToFatal/penetratesCandidates
// 是被测语义一部分；lib/bilibili+lib/youtube 桩喂手动绑定腿
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { seed, tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-dl-qqunlock-');
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

// ── netease-api 桩面（全量解构面 + resolveTrackUnlock/qqUnlockInfo 新出口）──
// callNeteaseApi/resolveSongUrls 仅供数值域用例；resolveTrackUnlock 是 qq_
// 外源/升级两腿唯一通道——录参回放 {resolved,errors}
const apiCalls = [];
let callApiImpl = async () => ({ body: { data: [] } });
const resolveCalls = [];
const unlockCalls = [];
let unlockImpl = async () => ({ resolved: null, errors: [] });
const qqInfoCalls = [];
seed('../src/server/services/netease-api.js', {
  callNeteaseApi: (...a) => { apiCalls.push(a); return callApiImpl(...a); },
  resolveSongUrls: async (items, o) => { resolveCalls.push(o); return items; },
  resolveTrackUnlock: async (trackId, o) => {
    unlockCalls.push([trackId, o]); return unlockImpl(trackId, o);
  },
  // qqUnlockInfo 真身做伪 songRow 装配+detail 回探——桩只录参回形，
  // 钉死的是「下载腿喂它什么」（title/author/artists/durationMs 四字段）
  qqUnlockInfo: (mid, o) => {
    qqInfoCalls.push([mid, o]);
    return { id: `qq_${mid}`, name: o?.title ?? null,
      artists: (o?.artists?.length ? o.artists : [o?.author].filter(Boolean)),
      durationMs: o?.durationMs ?? null };
  },
  needsUnlock: () => true,
  MAX_UNLOCK_ITEMS: 20,
  apiModules: {},
  estimateDuration: () => null,
  forgetSongUnlock: () => {},
});

// ── unlock 索引桩：只钉 QQ_UNLOCK_SOURCES 常量面（provider 模块不上行）──
seed('../src/server/services/unlock/index.js', {
  PROVIDERS: {},
  PLAYBACK_SOURCES: ['pyncmd', 'youtube', 'bilibili'],
  DOWNLOAD_SOURCES: ['pyncmd', 'youtube', 'bilibili'],
  QQ_UNLOCK_SOURCES: ['youtube', 'bilibili'],
});

// ── download-io：真身助手 + 桩字节腿（fetchStream/streamToFile 录参回放）──
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

// ── lib/bilibili + lib/youtube 桩：手动绑定腿（downloadExternalAudio）的字节
// 通道——同 file-downloader-ext-manual 面 ──
const biliAudioCalls = [];
let biliAudioImpl = async () => [];
const realBv = require('../src/server/lib/bilibili.js');
seed('../src/server/lib/bilibili.js', {
  ...realBv,
  resolveBiliAudio: async (o) => { biliAudioCalls.push(o); return biliAudioImpl(o); },
  biliFetch: async () => ({ pages: [] }),
});
let ytPlayerImpl = async () => ({ streamingData: { adaptiveFormats: [], formats: [] } });
const realYt = require('../src/server/lib/youtube.js');
seed('../src/server/lib/youtube.js', {
  ...realYt,
  fetchPlayer: async (videoId) => ytPlayerImpl(videoId),
  fetchPlayerWith: async (videoId) => ytPlayerImpl(videoId),
});

// ── unlockManual repo：真库 + getManual 记账（绑定消费位序断言面）──
const realManualRepo = require('../src/server/repositories/unlockManual.js');
const getManualCalls = [];
seed('../src/server/repositories/unlockManual.js', {
  ...realManualRepo,
  getManual: (id) => { getManualCalls.push(String(id)); return realManualRepo.getManual(id); },
});

const { downloadAudio } = require('../src/server/services/file-downloader.js');
const outDir = tmpDataDir('meowsync-dl-qqunlock-out-');

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
const ytAdaptive = (url, br = 130000) => ({ streamingData: { adaptiveFormats: [
  { url, mimeType: 'audio/mp4', bitrate: br, itag: 140 },
], formats: [] } });
const QQ_ID = 'qq_0034M8WL3V4oHA';
const BOUND_VID = 'BOUNDVID111';     // 11 位严形合法
const bind = (trackId, source, mediaId) => realManualRepo.upsertManual(trackId,
  { source, mediaId, title: '', owner: '', durationSec: null });
const deniedErr = () => {
  const e = new Error('qq musicu vkey.GetVkeyServer code=0/1000');
  e.qqAnonDenied = true; e.nodeCode = 1000; e.retcode = 104009;
  return e;
};
const resolvedOf = (over = {}) => ({ resolved: {
  source: 'youtube', url: 'https://rr1---sn-x.googlevideo.com/v?mime=audio/mp4',
  br: 130000, ext: 'm4a', timeMs: 271000, ...over,
}, errors: [] });

beforeEach(() => {
  pickImpl = async () => null;
  cookieOn = false;
  callApiImpl = async () => ({ body: { data: [] } });
  unlockImpl = async () => ({ resolved: null, errors: [] });
  fetchImpl = async (url) => ({ status: 200, data: { destroy() {} }, headers: {}, url });
  streamImpl = async (resp, outputPath) => ({ path: outputPath, size: 4096 });
  biliAudioImpl = async () => [];
  ytPlayerImpl = async () => ({ streamingData: { adaptiveFormats: [], formats: [] } });
  pickCalls.length = apiCalls.length = resolveCalls.length = 0;
  unlockCalls.length = qqInfoCalls.length = fetchCalls.length = streamCalls.length = 0;
  biliAudioCalls.length = getManualCalls.length = 0;
  realManualRepo.deleteManual(QQ_ID);
});

// ── 腿序 N1：自有源命中 → 外源解锁与网易腿双双零触达 ──

test('QQ 直链健康 → qq/<tier> 血缘照旧：resolveTrackUnlock 与 song_url 双双零调用', async () => {
  pickImpl = async () => ({ url: 'https://stream.qqmusic.qq.com/ok.mp3', tier: 'M800' });
  const r = await downloadAudio(QQ_ID, join(outDir, 'n1.mp3'), 320000, null, null,
    { neteaseId: '777001' }); // neteaseId 在场也不得抢直链的活
  assert.equal(r.size, 4096);
  assert.equal(r.unblockedSource, 'qq/M800');
  assert.equal(r.br, 320000); // QQ_TIER_BR['M800']
  assert.equal(r.unblocked, false);
  assert.equal(unlockCalls.length, 0, 'hit 在手——外源腿与升级腿都不烧');
  assert.equal(apiCalls.length, 0, 'qq 音频对 callNeteaseApi 零消费');
  assert.equal(fetchCalls[0][0], 'https://stream.qqmusic.qq.com/ok.mp3');
  assert.match(streamCalls[0][1], /n1\.mp3$/);
});

// ── MANUAL-ONCE：绑定腿在外源解锁之前且唯一消费位 ──

test('自有源败亡 + 绑定在场 → manual→<src> 顶替：共享链零调用', async () => {
  bind(QQ_ID, 'youtube', BOUND_VID);
  ytPlayerImpl = async (v) => ytAdaptive(`https://rr1---sn-x.googlevideo.com/v?sig=${v}`);
  const r = await downloadAudio(QQ_ID, join(outDir, 'm1.mp3'), 320000, null, null,
    { neteaseId: '777001' });
  assert.equal(r.unblockedSource, 'manual→youtube');
  assert.equal(r.unblocked, false);
  assert.equal(unlockCalls.length, 0,
    '绑定腿成功——共享链根本不被触达（[canonical:MANUAL-ONCE] 绑定唯一消费位是外层腿）');
  assert.equal(apiCalls.length, 0);
  assert.equal(getManualCalls.filter(id => id === QQ_ID).length, 1, '外层读口一次');
});

test('绑定腿死（瞬时）→ 外源解锁兜底成功：includeManual:false 链内不重读绑定', async () => {
  bind(QQ_ID, 'youtube', BOUND_VID);
  ytPlayerImpl = async () => { const e = new Error('yt ECONNRESET'); e.code = 'ECONNRESET'; throw e; };
  unlockImpl = async () => resolvedOf({ source: 'bilibili',
    url: 'https://upos-sz-m1.bilivideo.com/x.m4s', br: 192000 });
  const r = await downloadAudio(QQ_ID, join(outDir, 'm2.mp3'), 320000, null, null,
    { neteaseId: '777001' });
  assert.equal(r.unblockedSource, 'qq→bilibili', '绑定腿死——外源解锁兜底');
  assert.equal(unlockCalls.length, 1);
  assert.equal(unlockCalls[0][1].includeManual, false,
    '链内手动步对 qq_ 恒关——绑定已被外层腿消费，双读/双消费不许');
  assert.equal(getManualCalls.filter(id => id === QQ_ID).length, 1,
    '绑定表只被外层腿读一次');
});

// ── 共享链调参钉死（F1 直通 + 源序 + 惰性装配）──

test('resolveTrackUnlock 调参：trackId 直通 + sources=[youtube,bilibili] + proxied:false + includeManual:false + originalDt', async () => {
  unlockImpl = async () => resolvedOf();
  const r = await downloadAudio(QQ_ID, join(outDir, 's1.mp3'), 320000, null, null,
    { title: '娘子', author: '周杰伦', artists: ['周杰伦'],
      qq: { mediaMid: 'mm9' }, neteaseId: '777001' }, 271000);
  assert.equal(r.unblockedSource, 'qq→youtube');
  assert.equal(unlockCalls.length, 1);
  const [trackId, opts] = unlockCalls[0];
  assert.equal(trackId, QQ_ID, 'F1：qq_<mid> 键直通共享链——不改写不拆键');
  assert.deepEqual(opts.sources, ['youtube', 'bilibili'],
    'QQ_UNLOCK_SOURCES——pyncmd 永不入列（它是数值 id 直解器）');
  assert.equal(opts.purpose, 'download');
  assert.equal(opts.proxied, false, '下载侧进程内——拿明文直链不过 vault');
  assert.equal(opts.includeManual, false);
  assert.equal(opts.originalDt, 271000, 'expectedMs → 共享链时长对账基准');
  // buildInfo 惰性装配：providerData 快照 → qqUnlockInfo 四字段
  const info = await opts.buildInfo();
  assert.deepEqual(qqInfoCalls, [['0034M8WL3V4oHA', {
    title: '娘子', author: '周杰伦', artists: ['周杰伦'], durationMs: 271000,
  }]]);
  assert.equal(info.id, 'qq_0034M8WL3V4oHA');
  // pickStreamUrl 照吃 providerData.qq.mediaMid + 档梯（省一次 vkey 空调用）
  assert.equal(pickCalls[0][0], '0034M8WL3V4oHA');
  assert.equal(pickCalls[0][1].mediaMid, 'mm9');
});

// ── 外源命中 verbatim + 血缘烙记 ──

test('外源命中：resolved 元数据 verbatim（url/br/ext/timeMs）+ qq→<src> 血缘 + unblocked:true', async () => {
  unlockImpl = async () => resolvedOf({
    source: 'youtube',
    url: 'https://rr1---sn-x.googlevideo.com/v?mime=audio/mp4',
    br: 130000, ext: 'm4a', timeMs: 271000 });
  streamImpl = streamWriteThrough;
  const r = await downloadAudio(QQ_ID, join(outDir, 'v1.mp3'), 320000, null, null, {});
  assert.equal(r.unblocked, true, '解锁产物戴 unblocked 徽章');
  assert.equal(r.unblockedSource, 'qq→youtube', '血缘烙记 qq→<resolved.source>');
  assert.equal(r.url, 'https://rr1---sn-x.googlevideo.com/v?mime=audio/mp4');
  assert.equal(r.br, 130000, 'resolved.br 真实码率（落盘时长对账分母）');
  assert.equal(r.timeMs, 271000, 'resolved.timeMs 回传不回吞');
  assert.match(r.path, /v1\.m4a$/, 'resolved.ext 供值推导落盘后缀');
  assert.equal(readFileSync(r.path, 'utf8'),
    'bytes:https://rr1---sn-x.googlevideo.com/v?mime=audio/mp4');
});

// ── 镜像组逐试 + 源归因 ──

test('urls[] 镜像组逐试：首链 403 自动换镜像，usedUrl 如实 + 非 bili 宿主头不污染', async () => {
  unlockImpl = async () => resolvedOf({ source: 'bilibili',
    url: 'https://upos-sz-m1.bilivideo.com/a.m4s',
    urls: ['https://upos-sz-m1.bilivideo.com/a.m4s',
      'https://upos-sz-m2.bilivideo.com/b.m4s'],
    br: 192000, ext: 'm4a' });
  fetchImpl = async (url) => url.includes('m1.bilivideo')
    ? { status: 403, data: { destroy() {} }, headers: {}, url }
    : { status: 200, data: { destroy() {} }, headers: {}, url };
  streamImpl = streamWriteThrough;
  const r = await downloadAudio(QQ_ID, join(outDir, 'mir.mp3'), 320000, null, null, {});
  assert.equal(r.unblockedSource, 'qq→bilibili');
  assert.equal(r.url, 'https://upos-sz-m2.bilivideo.com/b.m4s',
    '镜像组第二链胜——usedUrl 如实回');
  assert.equal(readFileSync(r.path, 'utf8'),
    'bytes:https://upos-sz-m2.bilivideo.com/b.m4s');
  assert.deepEqual(fetchCalls.map(c => c[0]), [
    'https://upos-sz-m1.bilivideo.com/a.m4s',
    'https://upos-sz-m2.bilivideo.com/b.m4s',
  ], '同字节镜像组逐条试——首链死掉自动换');
  // bilivideo 防盗链两件套（UA+Referer）在镜像逐试下照常注入
  assert.equal(fetchCalls[0][1].headers['Referer'], 'https://www.bilibili.com');
  assert.equal(fetchCalls[1][1].headers['Referer'], 'https://www.bilibili.com');
});

test('镜像组全灭 → 终错拼 unlock= 死因且 fatal（上游 4xx 窗内确定性）', async () => {
  unlockImpl = async () => resolvedOf({ source: 'bilibili',
    url: 'https://upos-sz-m1.bilivideo.com/a.m4s',
    urls: ['https://upos-sz-m1.bilivideo.com/a.m4s',
      'https://upos-sz-m2.bilivideo.com/b.m4s'],
    br: 192000, ext: 'm4a' });
  fetchImpl = async (url) => ({ status: 403, data: { destroy() {} }, headers: {}, url });
  const e = await downloadAudio(QQ_ID, join(outDir, 'mir2.mp3'), 320000, null, null, {})
    .then(() => null, x => x);
  assert.equal(e.fatal, true, '上游 4xx 无重试权（fatalError 无 errno 不穿透但带 fatal）');
  assert.match(e.message, /unlock=上游返回 403/, '落盘失败死因也拼上终错');
  assert.deepEqual(fetchCalls.map(c => c[0]), [
    'https://upos-sz-m1.bilivideo.com/a.m4s',
    'https://upos-sz-m2.bilivideo.com/b.m4s',
  ], '两条镜像都试过才判死');
});

// ── errors→终错分档（L4 同款）──

test('errors 全确定性 → fatal + 逐源「source: msg」全角分号串拼终错', async () => {
  unlockImpl = async () => ({ resolved: null, errors: [
    { source: 'youtube', msg: '候选时长全灭', cls: 'nomatch' },
    { source: 'bilibili', msg: '风控拦截', cls: 'authwall' },
  ] });
  const e = await downloadAudio(QQ_ID, join(outDir, 'e1.mp3'), 320000, null, null, {})
    .then(() => null, x => x);
  assert.equal(e.fatal, true, 'nomatch/authwall/breaker 是窗内确定性——重试不产新证据');
  assert.match(e.message, /unlock=youtube: 候选时长全灭；bilibili: 风控拦截/,
    '逐源归因「source: msg」以全角分号串拼上终错');
});

test('errors 任一 transient → 终错非 fatal 保 ≤3 重试权', async () => {
  unlockImpl = async () => ({ resolved: null, errors: [
    { source: 'youtube', msg: '候选时长全灭', cls: 'nomatch' },
    { source: 'bilibili', msg: 'ECONNRESET', cls: 'transient' },
  ] });
  const e = await downloadAudio(QQ_ID, join(outDir, 'e2.mp3'), 320000, null, null, {})
    .then(() => null, x => x);
  assert.equal(e.fatal, false, '任一 transient 让整个终错回 ≤3 重试');
  assert.match(e.message, /unlock=.*bilibili: ECONNRESET/);
});

test('errors 空 → 「外源解锁无逐源记录」占位且 fatal', async () => {
  unlockImpl = async () => ({ resolved: null, errors: [] });
  const e = await downloadAudio(QQ_ID, join(outDir, 'e3.mp3'), 320000, null, null, {})
    .then(() => null, x => x);
  assert.equal(e.fatal, true);
  assert.match(e.message, /外源解锁无逐源记录/);
});

// ── pd.neteaseId 零消费红线 ──

test('pd.neteaseId 在场 → song_url/resolveSongUrls 双双零调用（词源字段非音频源）', async () => {
  unlockImpl = async () => resolvedOf();
  await downloadAudio(QQ_ID, join(outDir, 'r1.mp3'), 320000, null, null,
    { neteaseId: '777001' });
  assert.equal(apiCalls.filter(c => c[0] === 'song_url').length, 0,
    'neteaseId 在场也不许打 song_url——qq 音频零消费否决项红线');
  assert.equal(apiCalls.length, 0, 'callNeteaseApi 整面零触达');
  assert.equal(resolveCalls.length, 0, 'resolveSongUrls 也不该被 qq 触达');
  assert.equal(unlockCalls.length, 1, '唯一腿是共享链');
  // 解锁全灭态同样零网易调用
  unlockImpl = async () => ({ resolved: null, errors: [{ source: 'youtube', msg: 'x', cls: 'nomatch' }] });
  await downloadAudio(QQ_ID, join(outDir, 'r2.mp3'), 320000, null, null,
    { neteaseId: '777001' }).then(() => null, () => {});
  assert.equal(apiCalls.length, 0, '全灭态 neteaseId 也不复活成音频键');
});

// ── 终错拼装 / 拒答标记 / 文案分档 ──

test('qqAnonDenied + 外源全灭 → 原始拒答错重抛：标记存活 + unlock= 死因拼上', async () => {
  pickImpl = async () => { throw deniedErr(); };
  unlockImpl = async () => ({ resolved: null, errors: [
    { source: 'youtube', msg: 'no match', cls: 'nomatch' },
    { source: 'bilibili', msg: 'breaker 窗内拒', cls: 'breaker' },
  ] });
  const e = await downloadAudio(QQ_ID, join(outDir, 'd1.mp3'), 320000, null, null, {})
    .then(() => null, x => x);
  assert.equal(e.qqAnonDenied, true, '外源败亡不吞匿名关停标记——透给上层分档');
  assert.match(e.message, /code=0\/1000/, '原始 qq 错为主因不吞');
  assert.match(e.message, /unlock=youtube: no match；bilibili: breaker 窗内拒/);
});

test('qqAnonDenied + 绑定败亡 + 外源全灭 → 终错拼 manual=+unlock= 双死因', async () => {
  bind(QQ_ID, 'youtube', BOUND_VID);
  pickImpl = async () => { throw deniedErr(); };
  ytPlayerImpl = async () => { const e = new Error('yt ECONNRESET'); e.code = 'ECONNRESET'; throw e; };
  unlockImpl = async () => ({ resolved: null, errors: [
    { source: 'youtube', msg: 'no match', cls: 'nomatch' }] });
  const e = await downloadAudio(QQ_ID, join(outDir, 'd2.mp3'), 320000, null, null,
    { neteaseId: '777001' }).then(() => null, x => x);
  assert.equal(e.qqAnonDenied, true);
  assert.match(e.message, /manual=yt ECONNRESET/, '绑定腿死因拼上终错');
  assert.match(e.message, /unlock=youtube: no match/, '解锁死因拼上终错');
  assert.equal(e.fatal, false,
    '两腿死因含瞬时（manual ECONNRESET）——combined 跟主错非 fatal 档走 ≤3 重试');
});

test('pickStreamUrl 抛未标记错（瞬断/风控非拒答形态）→ 不进解锁判定：零调用原错穿透', async () => {
  pickImpl = async () => { throw new Error('qq musicu vkey.GetVkeyServer code=0/2000'); };
  const e = await downloadAudio(QQ_ID, join(outDir, 'd3.mp3'), 320000, null, null,
    { neteaseId: '777001' }).then(() => null, x => x);
  assert.match(e.message, /code=0\/2000/);
  assert.equal(e.qqAnonDenied, undefined, '未标记错不是凭据级拒答');
  assert.equal(unlockCalls.length, 0, '瞬断上抛交任务级重试管——不为毛刺烧解锁链');
  assert.equal(apiCalls.length, 0);
});

test('qq null 且外源全灭 → 终错文案按凭据态分档', async () => {
  unlockImpl = async () => ({ resolved: null, errors: [{ source: 'youtube', msg: 'x', cls: 'nomatch' }] });
  // 无 cookie：匿名关停+外源未命中的可执行指引
  let e = await downloadAudio(QQ_ID, join(outDir, 'd4.mp3'), 320000, null, null, {})
    .then(() => null, x => x);
  assert.equal(e.fatal, true, '全确定性 → fatal');
  assert.match(e.message, /QQ 已关闭匿名取流且外源解锁未命中/);
  assert.match(e.message, /配置 Cookie 或绑定手动媒体源/);
  // 有 cookie：VIP/地域或外源无候选口径
  cookieOn = true;
  e = await downloadAudio(QQ_ID, join(outDir, 'd5.mp3'), 320000, null, null, {})
    .then(() => null, x => x);
  assert.equal(e.fatal, true);
  assert.match(e.message, /自有档与外源解锁均未命中/);
  assert.match(e.message, /VIP\/地域或外源无候选/);
});

// ── 低档升级腿：bv-only 外源解锁 ──

test('M500 hit（128k < 请求 320k）→ 第二跳 sources=[bilibili] 独源；bilibili 192k 换用烙 qq→bilibili', async () => {
  pickImpl = async () => ({ url: 'https://stream.qqmusic.qq.com/low.mp3', tier: 'M500' });
  unlockImpl = async () => resolvedOf({ source: 'bilibili',
    url: 'https://upos-sz-m1.bilivideo.com/hi.m4s',
    urls: ['https://upos-sz-m1.bilivideo.com/hi.m4s'],
    br: 192000, ext: 'm4a', timeMs: 271000 });
  streamImpl = streamWriteThrough;
  const r = await downloadAudio(QQ_ID, join(outDir, 'u1.mp3'), 320000, null, null,
    { neteaseId: '777001' }, 271000);
  assert.equal(unlockCalls.length, 1, 'hit 在手只跑升级一跳');
  assert.equal(unlockCalls[0][0], QQ_ID, '同一 qq_<mid> 键');
  assert.deepEqual(unlockCalls[0][1].sources, ['bilibili'],
    'bv-only——yt ~130-160k opus 对 M500 128k×1.25 margin 永不胜（裁决 D2）');
  assert.equal(unlockCalls[0][1].purpose, 'download');
  assert.equal(unlockCalls[0][1].includeManual, false);
  assert.equal(unlockCalls[0][1].originalDt, 271000,
    '错配录音时长判定已吸收进共享链 originalDt 对账');
  assert.equal(r.path, join(outDir, 'u1.m4a'), '回链真实扩展名换名入主档族');
  assert.equal(r.unblocked, true);
  assert.equal(r.unblockedSource, 'qq→bilibili', '升级血缘烙 qq→bilibili——绝不 qq→netease');
  assert.equal(r.br, 192000, '报回链真实码率而非 qq 档位');
  assert.equal(r.timeMs, 271000);
  assert.equal(readFileSync(r.path, 'utf8'), 'bytes:https://upos-sz-m1.bilivideo.com/hi.m4s',
    '主档必须是回链字节');
  assert.deepEqual(familyOf('u1'), ['u1.m4a'],
    '主档族只留一件：.relay.* 中间件与 qq 低档档都不许残留');
});

test('升级不胜出保 hit：br margin 内 / br null 非无损容器——resolve 期早退零字节下载', async () => {
  pickImpl = async () => ({ url: 'https://stream.qqmusic.qq.com/low.mp3', tier: 'M500' });
  streamImpl = streamWriteThrough;
  // margin 内平级：130k ≤ 128k×1.25=160k → 不换（且 resolved.url 一次不拉）
  unlockImpl = async () => resolvedOf({ source: 'bilibili',
    url: 'https://upos-sz-m1.bilivideo.com/lo.m4s', br: 130000, ext: 'm4a' });
  let r = await downloadAudio(QQ_ID, join(outDir, 'k1.mp3'), 320000, null, null, {});
  assert.equal(r.unblockedSource, 'qq/M500');
  assert.equal(r.br, 128000);
  assert.equal(fetchCalls.filter(c => c[0].includes('bilivideo')).length, 0,
    'br/ext 早退根治旧腿「整件下载再比」——候选不胜出零字节浪费');
  assert.deepEqual(familyOf('k1'), ['k1.mp3']);
  // br null + 非无损容器（m4a）→ 不换
  unlockImpl = async () => resolvedOf({ source: 'bilibili',
    url: 'https://upos-sz-m1.bilivideo.com/lo.m4s', br: null, ext: 'm4a' });
  r = await downloadAudio(QQ_ID, join(outDir, 'k2.mp3'), 320000, null, null, {});
  assert.equal(r.unblockedSource, 'qq/M500',
    'br 不可比只认无损容器——合流/降级 m4a 不换进音频工件位');
  assert.deepEqual(familyOf('k2'), ['k2.mp3']);
});

test('升级候选 br null + flac（无损容器）→ 换用烙 qq→bilibili', async () => {
  pickImpl = async () => ({ url: 'https://stream.qqmusic.qq.com/low.mp3', tier: 'M500' });
  unlockImpl = async () => resolvedOf({ source: 'bilibili',
    url: 'https://upos-sz-m1.bilivideo.com/hi.flac', br: null, ext: 'flac' });
  streamImpl = streamWriteThrough;
  const r = await downloadAudio(QQ_ID, join(outDir, 'k3.mp3'), 320000, null, null, {});
  assert.equal(r.unblockedSource, 'qq→bilibili');
  assert.equal(r.br, null, 'br 不可比如实 null——不拿声明值复活假分母');
  assert.match(r.path, /k3\.flac$/);
  assert.deepEqual(familyOf('k3'), ['k3.flac']);
});

test('升级腿 resolved null / 链抛瞬时错 → 保在手 hit（尽力腿只降级不吞活）', async () => {
  pickImpl = async () => ({ url: 'https://stream.qqmusic.qq.com/low.mp3', tier: 'M500' });
  streamImpl = streamWriteThrough;
  unlockImpl = async () => ({ resolved: null, errors: [{ source: 'bilibili', msg: 'no match', cls: 'nomatch' }] });
  let r = await downloadAudio(QQ_ID, join(outDir, 'k4.mp3'), 320000, null, null, {});
  assert.equal(r.unblockedSource, 'qq/M500');
  assert.equal(readFileSync(r.path, 'utf8'), 'bytes:https://stream.qqmusic.qq.com/low.mp3');
  assert.deepEqual(familyOf('k4'), ['k4.mp3']);
  // 链抛瞬时错——非穿透错只 warn 降级
  unlockImpl = async () => { const e = new Error('ECONNRESET'); e.code = 'ECONNRESET'; throw e; };
  r = await downloadAudio(QQ_ID, join(outDir, 'k5.mp3'), 320000, null, null, {});
  assert.equal(r.unblockedSource, 'qq/M500', '解锁链瞬时败亡不丢已下载的 qq hit');
  assert.equal(readFileSync(r.path, 'utf8'), 'bytes:https://stream.qqmusic.qq.com/low.mp3');
  assert.deepEqual(familyOf('k5'), ['k5.mp3']);
});

test('M800 达标 / F000 顶格（QQ_TIER_BR null）→ 升级腿不烧一跳', async () => {
  pickImpl = async () => ({ url: 'https://stream.qqmusic.qq.com/ok.mp3', tier: 'M800' });
  let r = await downloadAudio(QQ_ID, join(outDir, 'g1.mp3'), 320000, null, null,
    { neteaseId: '777001' });
  assert.equal(r.unblockedSource, 'qq/M800');
  pickImpl = async () => ({ url: 'https://stream.qqmusic.qq.com/hi.flac', tier: 'F000' });
  r = await downloadAudio(QQ_ID, join(outDir, 'g2.mp3'), 320000, null, null,
    { neteaseId: '777001' });
  assert.equal(r.unblockedSource, 'qq/F000');
  assert.equal(r.br, null);
  assert.equal(unlockCalls.length, 0, 'F000 无损已是顶格——null 不得按 0 参与比较');
});

test('省流短梯请求（bitrate<320k）砍 qq 候选档但不砍升级闸——M500 hit 仍跑升级一跳', async () => {
  pickImpl = async () => ({ url: 'https://stream.qqmusic.qq.com/low.mp3', tier: 'M500' });
  unlockImpl = async () => resolvedOf({ source: 'bilibili',
    url: 'https://upos-sz-m1.bilivideo.com/hi.m4s', br: 192000, ext: 'm4a' });
  streamImpl = streamWriteThrough;
  const r = await downloadAudio(QQ_ID, join(outDir, 'g3.mp3'), 192000, null, null, {});
  assert.equal(unlockCalls.length, 1, '192k 请求拿到 128k hit——升级闸照旧');
  assert.deepEqual(unlockCalls[0][1].sources, ['bilibili']);
  assert.equal(r.unblockedSource, 'qq→bilibili');
});

// ── 只读契约 / abort 纪律 ──

test('providerData 冻结对象下外源腿不炸（只读契约）', async () => {
  unlockImpl = async () => resolvedOf();
  const r = await downloadAudio(QQ_ID, join(outDir, 'fz.mp3'), 320000, null, null,
    Object.freeze({ neteaseId: '777001', title: '娘子', author: '周杰伦',
      artists: Object.freeze(['周杰伦']),
      qq: Object.freeze({ mediaMid: 'mm' }) }), 271000);
  assert.equal(r.unblockedSource, 'qq→youtube');
  const info = await unlockCalls[0][1].buildInfo();
  assert.equal(info.name, '娘子');
});

test('升级腿内 abort → 穿透判死不兜底（abort 标记存活）', async () => {
  pickImpl = async () => ({ url: 'https://stream.qqmusic.qq.com/low.mp3', tier: 'M500' });
  unlockImpl = async () => { const e = new Error('aborted'); e.aborted = true; throw e; };
  const e = await downloadAudio(QQ_ID, join(outDir, 'ab.mp3'), 320000, null, null, {})
    .then(() => null, x => x);
  assert.equal(e.aborted, true, '升级腿 abort 穿透——不降级保 hit 也不吞标记');
});

// ── 数值域委托面回归：persistResolvedItem 抽出不改数值支行为 ──

test('数值域 song_url→resolveSongUrls→persist 同形（委托后零行为差）', async () => {
  callApiImpl = async (name, args) => ({ body: { data: [
    { id: +args.id, url: 'https://m701.music.126.net/x.mp3', br: 320000 },
  ] } });
  const r = await downloadAudio('88', join(outDir, 'num1.mp3'), 320000, null, null, {});
  assert.equal(r.size, 4096);
  assert.equal(r.unblocked, false);
  assert.deepEqual(apiCalls, [['song_url', { id: '88', br: 320000 }]]);
  assert.deepEqual(resolveCalls, [{ purpose: 'download', signal: null }]);
  assert.equal(unlockCalls.length, 0, '数值支走 resolveSongUrls——不触 resolveTrackUnlock');
});

test('数值域 bilivideo 回链 BILI_PUBLIC_HEADERS 注入不变（persistResolvedItem 内部）', async () => {
  streamImpl = streamWriteThrough;
  for (const [i, host] of [
    'upos-sz-mirrorcoso1.bilivideo.com', 'upos.bilivideo.cn', 'i0.hdslb.com',
  ].entries()) {
    fetchCalls.length = 0;
    callApiImpl = async () => ({ body: { data: [
      { id: 88, url: `https://${host}/ugax/x.m4a`, br: 320000 },
    ] } });
    await downloadAudio('88', join(outDir, `nb${i}.mp3`), 320000, null, null, {});
    assert.deepEqual(fetchCalls[0][1].headers, {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Referer': 'https://www.bilibili.com',
      'Range': 'bytes=0-',
    }, `${host} 防盗链要 UA+Referer 两件套`);
  }
  // 非 bili 宿主不附带 Referer（googlevideo 等现有行为不动）
  fetchCalls.length = 0;
  callApiImpl = async () => ({ body: { data: [
    { id: 88, url: 'https://rr1---sn-x.googlevideo.com/v?mime=audio/mp4', br: 128000 },
  ] } });
  await downloadAudio('88', join(outDir, 'nb9.mp3'), 320000, null, null, {});
  assert.deepEqual(fetchCalls[0][1].headers, { Range: 'bytes=0-' });
});

test('数值域落盘扩展名判定：URL 推导优先 > item.type 白名单回落 > mp3 兜底', async () => {
  // .m4s 尾缀 + item.type=m4a（bilibili 解锁链形态）→ 落盘 .m4a
  callApiImpl = async () => ({ body: { data: [
    { id: 88, url: 'https://upos-sz-mirrorcoso1.bilivideo.com/ugax/code/abc.m4s',
      br: 320000, unblocked: true, unblockedBr: 192000,
      unblockedSource: 'bilibili', type: 'm4a' },
  ] } });
  let r = await downloadAudio('88', join(outDir, 'ext1.mp3'), 320000, null, null, {});
  assert.match(r.path, /ext1\.m4a$/, 'URL 推导不出时吃 item.type');
  // type 非白名单值 + URL 推不出 → 闸挡回 mp3
  callApiImpl = async () => ({ body: { data: [
    { id: 88, url: 'https://upos-sz-mirrorcoso1.bilivideo.com/ugax/x.m4s',
      br: 320000, type: 'php' },
  ] } });
  r = await downloadAudio('88', join(outDir, 'ext2.mp3'), 320000, null, null, {});
  assert.match(r.path, /ext2\.mp3$/, '白名单外 type 值被闸挡——仍回 mp3 兜底');
});

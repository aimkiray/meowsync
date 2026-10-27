// routes/qq.js 冒烟：状态透出 / resolve 解析分流（disstid 歌单跳）/
// stream 三腿（自有→手动绑定→外源解锁）302 进 vault / anon 拒答负 memo /
// lyric/search/playlist 成功形状 + 入参 400。
// lib/qq（musicu 上游）与 netease-match（词源匹配）全桩——桩面走
// helpers.seedMatchModule 保持与 netease-match.test.mjs 同口径。
// netease-api 整模块桩（resolveTrackUnlock 必桩——外源腿真模块会真打
// 上游检索扇出）；unlock/index 桩挡 provider 图，QQ_UNLOCK_SOURCES 同值。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { seed, seedMatchModule, tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-route-qq-');
// 限流桶按 IP 分：XFF 独立 IP 防跨用例配额互耗（qq-unlock 20/min 桶的
// 钉板需要同 IP 计数确定——manual-stream-override 同款手法）
process.env.TRUST_PROXY = '1';
const require = createRequire(import.meta.url);

// ── 桩：QQ 上游 lib ──
const TRACK = {
  mid: '001ABCdef23456', songId: 42, name: '歌名', artists: ['艺人甲', '艺人乙'],
  album: '专辑', albummid: 'albmid', intervalSec: 200, cover: 'https://c/c.jpg',
  mediaMid: 'mmid123', payPlay: 0, vipOnly: 0,
};
// 带 publishTime 的第二首——trackJson 白名单条件透传钉（无键不下发）
const OTHER = { ...TRACK, mid: '002OTHERsongXXX', publishTime: 1193932800000 };
// 歌单搜索归一卡（lib 侧 normalizePlaylistCard 的产物形态）
const PL_CARD = {
  id: 'local_pl_qq_7097197259', disstid: '7097197259', name: '催专累了',
  coverImgUrl: 'https://y.gtimg.cn/x.jpg', creator: { nickname: '念安娜' },
  trackCount: 108, playCount: 91998486, provider: 'qq',
};
const SUGGEST = {
  allMatch: [{ keyword: '青花瓷 - 周杰伦' }],
  songs: [{ name: '青花瓷', artists: [{ name: '周杰伦' }] }],
  artists: [{ name: '周杰伦' }],
  albums: [{ name: '我很忙', artist: { name: '周杰伦' } }],
};
let resolvedInput = null;
let pickStreamHit = { url: 'https://stream.qqmusic.qq.com/x.m4a?u=1' };
let pickStreamImpl = async () => pickStreamHit; // 可换抛错实现——路径剥离钉用
// searchSongs 新契约 {list,total}——调用面记录分页参数；内容可换
let searchArgs = null;
let searchList = [TRACK];
let searchTotal = 600;
let searchImpl = async () => ({ list: searchList, total: searchTotal });
let plSearchArgs = null;
let plSearchImpl = async () => ({ playlists: [PL_CARD], total: 46689 });
let suggestArgs = null;
let suggestImpl = async () => SUGGEST;
let hotImpl = async () => ({ hots: [{ first: '我们的歌' }] });
let songDetailImpl = async (id) => ({ ...TRACK, mid: String(id) });
// 凭据态/歌单内容可翻转：stream 404 文案按 hasQqCookie 分档、playlist 匹配
// 面按曲目集断言——两处用例都要换底
let cookieOn = false;
const defaultPl = () => ({
  id: '777', name: 'QQ歌单', creator: 'tester', cover: '', desc: '',
  songCount: 1, tracks: [{ ...TRACK }], truncated: false,
});
let plImpl = defaultPl;
seed('../src/server/lib/qq.js', {
  hasQqCookie: () => cookieOn,
  PLAY_LADDER: ['m800'], BEST_LADDER: ['flac'],
  SONGMID_RE: /^[0-9A-Za-z]{10,20}$/,
  getSongDetail: async (...a) => songDetailImpl(...a),
  pickStreamUrl: async (...a) => pickStreamImpl(...a),
  getLyric: async () => ({ lyric: '[00:01.00]词', trans: '[00:01.00]译' }),
  // 与 lib/qq.js getPlaylist 真身同形（id/name/creator/cover/desc/songCount/
  // tracks/truncated）——路由显式透 truncated 契约字段，桩缺它会让该字段
  // 恒 false 且无断言兜住。曲目克隆下发：匹配池就地写 matched/matchedBy/
  // matchScore，共享 fixture 被写脏会跨用例漏
  getPlaylist: async (...a) => plImpl(...a),
  searchSongs: async (q, opts, sig) => {
    searchArgs = { q, opts };
    return searchImpl(q, opts, sig);
  },
  searchPlaylists: async (q, opts) => {
    plSearchArgs = { q, opts };
    return plSearchImpl(q, opts);
  },
  searchSuggest: async (key) => { suggestArgs = key; return suggestImpl(key); },
  getHotkeys: async () => hotImpl(),
  resolveQqInput: async () => resolvedInput,
});
const matchCalls = [];
let matchImpl = async () => ({ song: { id: 998877, name: '匹配曲', ar: [{ name: '网艺' }], al: {} }, query: 'q1' });
seedMatchModule(matchCalls, () => matchImpl);

// F1 共享解锁链整桩：外源腿调用面全录（trackId/opts），impl 用例内可换——
// 命中产物/全灭 errors/预算 abort 三态都从这出
const unlockCalls = [];
let unlockImpl = async () => ({ resolved: null, errors: [] });
const qqInfoCalls = [];
seed('../src/server/services/netease-api.js', {
  resolveTrackUnlock: async (trackId, opts) => {
    unlockCalls.push([trackId, opts]);
    return unlockImpl(trackId, opts);
  },
  qqUnlockInfo: async (mid, opts) => {
    qqInfoCalls.push([mid, opts]);
    return { id: `qq_${mid}`, name: TRACK.name, artists: TRACK.artists, keyword: 'k', durationMs: 200000 };
  },
});
// unlock 源注册表整桩：真 index 拉整条 provider 图（yt/bv 检索 client、
// repo、AI 层）——路由取 QQ_UNLOCK_SOURCES 常量、manual-stream 取
// PROVIDERS.resolveById 都走本桩（绑定命中腿的产物流）
const resolveByIdCalls = [];
let ytResolveByIdImpl = async (mediaId) => ({
  url: `https://rr1---sn-t.googlevideo.com/v?itag=251&sig=BOUND_${mediaId}`,
  urls: [`https://rr1---sn-t.googlevideo.com/v?itag=251&sig=BOUND_${mediaId}`],
  br: 128000,
});
seed('../src/server/services/unlock/index.js', {
  PROVIDERS: {
    youtube: {
      resolveById: async (mediaId, o) => {
        resolveByIdCalls.push([mediaId, o]);
        return ytResolveByIdImpl(mediaId, o);
      },
    },
    bilibili: { resolveById: async () => null },
  },
  QQ_UNLOCK_SOURCES: ['youtube', 'bilibili'],
});

let app, unlockManualRepo;
before(() => {
  app = require('../src/server/routes/qq.js');
  unlockManualRepo = require('../src/server/repositories/unlockManual.js');
});
after(() => {
  delete process.env.TRUST_PROXY;
  rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

let ipSeq = 200;
const nextIp = () => `10.77.${++ipSeq}.1`;
// 每发独立 XFF——限流桶互不染（只有 429 钉板用例传固定 ip 共桶计数）
const get = (path, ip) => app.request(`http://t${path}`,
  { headers: { 'x-forwarded-for': ip || nextIp() } });
const json = async (res) => ({ status: res.status, body: await res.json().catch(() => null) });

test('qq：/qq/status 只回凭据布尔——不带本体', async () => {
  const r = await json(await get('/qq/status'));
  assert.deepEqual(r.body, { code: 200, loggedIn: false });
});

test('qq：resolve 入参解析失败 → 400；disstid 带跳转字段', async () => {
  resolvedInput = null;
  const r = await json(await get('/qq/resolve?input=garbage'));
  assert.equal(r.status, 400);

  resolvedInput = { disstid: '9988' };
  const r2 = await json(await get('/qq/resolve?input=x'));
  assert.equal(r2.status, 400);
  assert.equal(r2.body.disstid, '9988'); // 前端据此自动转歌单导入
});

test('qq：resolve 成功形状——trackJson 投影 + matched 兜底源', async () => {
  resolvedInput = { mid: TRACK.mid };
  const r = await json(await get(`/qq/resolve?input=${TRACK.mid}`));
  assert.equal(r.status, 200);
  assert.equal(r.body.mid, TRACK.mid);
  assert.equal(r.body.name, TRACK.name);
  assert.equal(r.body.duration, 200);
  assert.deepEqual(r.body.matched, { id: 998877, name: '匹配曲', ar: [{ name: '网艺' }], al: {} });
  assert.equal(r.body.matchedBy, 'q1');
});

test('qq：stream 非法 mid 400；自有源命中 → 302 进 vault（外源腿不触发）', async () => {
  const bad = await get('/qq/stream?mid=!!');
  assert.equal(bad.status, 400);

  unlockCalls.length = 0;
  const r = await get(`/qq/stream?mid=${TRACK.mid}`);
  assert.equal(r.status, 302);
  const loc = r.headers.get('location');
  assert.match(loc, /^\/audio-proxy\/t\//);
  assert.equal(r.headers.get('x-unlock-source'), null, '自有源命中不带外源头');
  assert.equal(r.headers.get('x-manual-source'), null, '自有源命中不带绑定头');
  // vault token 能解出原 URL——mint 语义钉住（purl 不出前端）
  const streamVault = require('../src/server/lib/stream-vault.js');
  const entry = streamVault.resolve(loc.split('/audio-proxy/t/')[1]);
  assert.equal(entry.urls[0], 'https://stream.qqmusic.qq.com/x.m4a?u=1');
  assert.equal(unlockCalls.length, 0, '自有源腿命中——外源解锁零调用（腿序钉）');
});

test('qq：stream 的 Location 在 BASE_PATH 子目录部署下带前缀', async () => {
  // 服务端剥前缀后路由按根路径工作——外发链不拼回前缀的话客户端会拿
  // /audio-proxy/t/… 根链撞上 entryFetch 的 base-外 404（线上回归钉）
  const saved = process.env.BASE_PATH;
  process.env.BASE_PATH = '/music';
  try {
    const r = await get(`/qq/stream?mid=${TRACK.mid}`);
    assert.equal(r.status, 302);
    assert.match(r.headers.get('location') || '', /^\/music\/audio-proxy\/t\//);
  } finally {
    if (saved === undefined) delete process.env.BASE_PATH;
    else process.env.BASE_PATH = saved;
  }
});

test('qq：stream 502 消息剥离绝对路径——不泄服务器文件系统布局', async () => {
  pickStreamImpl = async () => {
    throw new Error("ENOENT: no such file or directory, open '/data/meowsync/qq.cache'");
  };
  try {
    // 换没缓存过的 mid——上面的 302 用例已把 TRACK.mid 写进正缓存，
    // 同键会吃到缓存命中而到不了桩的错误面
    const r = await json(await get('/qq/stream?mid=001ERRxxx23456'));
    assert.equal(r.status, 502);
    assert.ok(!r.body.message.includes('/data/meowsync'), `路径泄漏: ${r.body.message}`);
    assert.match(r.body.message, /<path>/);
  } finally { pickStreamImpl = async () => pickStreamHit; }
});

test('qq：stream 无可用档 + 外源全灭 → 404 + unlockErrors 机读面', async () => {
  pickStreamHit = null;
  // 同上——null 不缓存，但也得用没被 302 用例写过的键
  const r = await json(await get('/qq/stream?mid=001NILxxx23456'));
  assert.equal(r.status, 404);
  assert.deepEqual(r.body.unlockErrors, []);
  pickStreamHit = { url: 'https://stream.qqmusic.qq.com/x.m4a?u=1' };
});

test('qq：外源腿——自有源败亡+绑定缺席 → yt 命中 302 + x-unlock-source + cacheKey 指纹 mint', async () => {
  pickStreamHit = null;
  unlockCalls.length = 0;
  qqInfoCalls.length = 0;
  const mid = '006EXTyt00001';
  const ytUrl = 'https://rr1---sn-t.googlevideo.com/videoplayback?itag=251&expire=9';
  unlockImpl = async (trackId, opts) => {
    // buildInfo 惰性装配钉：实跑链才调，且经 qqUnlockInfo 桩（F2 接线）
    const info = await opts.buildInfo();
    assert.equal(info?.id, `qq_${mid}`);
    return { resolved: {
      url: ytUrl, urls: [ytUrl], br: 130000, source: 'youtube',
      ext: 'webm', size: 4000000, timeMs: 200000, mediaId: 'dQw4w9WgXcQ',
    }, errors: [] };
  };
  try {
    const r = await get(`/qq/stream?mid=${mid}`);
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('x-unlock-source'), 'youtube');
    const loc = r.headers.get('location');
    assert.match(loc, /^\/audio-proxy\/t\//);
    const streamVault = require('../src/server/lib/stream-vault.js');
    const entry = streamVault.resolve(loc.split('/audio-proxy/t/')[1]);
    assert.deepEqual(entry.urls, [ytUrl]);
    // 媒体 id+字节实体指纹（codec/br/itag 段）挂播过路缓存键——与
    // routes/youtube.js 指纹口径同轴（yt_<id>_a_<codec>_<br>_i<itag>）
    assert.equal(entry.cacheKey, 'yt_dQw4w9WgXcQ_a_webm_130000_i251');
    assert.deepEqual(entry.cacheMeta, { muxed: false, codec: 'webm', br: 130000, h: 0, w: 0 });
    // 调用面钉：qq_<mid> 键域直通、恒 QQ_UNLOCK_SOURCES 源序、proxied、
    // includeManual=false（MANUAL-ONCE）、AbortSignal.any 预算腿
    const [tid, opts] = unlockCalls.at(-1);
    assert.equal(tid, `qq_${mid}`);
    assert.deepEqual(opts.sources, ['youtube', 'bilibili']);
    assert.equal(opts.proxied, true);
    assert.equal(opts.includeManual, false);
    assert.equal(opts.purpose, 'playback');
    assert.equal(opts.skipCache, false);
    assert.ok(opts.signal instanceof AbortSignal, '预算腿 signal 在位');
    assert.equal(typeof opts.buildInfo, 'function');
    assert.deepEqual(qqInfoCalls.at(-1), [mid, {}], 'buildInfo 经 qqUnlockInfo(mid,{})');
  } finally {
    pickStreamHit = { url: 'https://stream.qqmusic.qq.com/x.m4a?u=1' };
    unlockImpl = async () => ({ resolved: null, errors: [] });
  }
});

test('qq：外源腿——bv 命中挂 bv_<bvid>_p1_a_ 键；mediaId 缺席退裸 mint', async () => {
  pickStreamHit = null;
  const bvUrl = 'https://upos-sz-m1.bilivideo.com/x.m4s?sig=B';
  const streamVault = require('../src/server/lib/stream-vault.js');
  try {
    unlockImpl = async () => ({ resolved: {
      url: bvUrl, urls: [bvUrl], br: 192000, source: 'bilibili',
      ext: 'm4a', size: 5000000, timeMs: 200000, mediaId: 'BV1xx411c7mD',
    }, errors: [] });
    const r = await get('/qq/stream?mid=006EXTbv00002');
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('x-unlock-source'), 'bilibili');
    const t1 = /\/audio-proxy\/t\/([^\s]+)/.exec(r.headers.get('location'))?.[1];
    const e1 = streamVault.resolve(t1);
    assert.equal(e1.cacheKey, 'bv_BV1xx411c7mD_p1_a_m4a_192000');
    assert.deepEqual(e1.cacheMeta, { muxed: false, codec: 'm4a', br: 192000, h: 0, w: 0 });

    // mediaId 缺席 → 绑媒体同款裸 mint（cacheKey/cacheMeta 不编，不蹭缓存键）
    unlockImpl = async () => ({ resolved: {
      url: 'https://upos-sz-m1.bilivideo.com/y.m4s?sig=C',
      urls: ['https://upos-sz-m1.bilivideo.com/y.m4s?sig=C'],
      br: null, source: 'bilibili', ext: null, size: null, timeMs: null,
    }, errors: [] });
    const r2 = await get('/qq/stream?mid=006EXTno0003');
    assert.equal(r2.status, 302);
    const t2 = /\/audio-proxy\/t\/([^\s]+)/.exec(r2.headers.get('location'))?.[1];
    const e2 = streamVault.resolve(t2);
    assert.equal(e2.cacheKey, null);
    assert.equal(e2.cacheMeta, null);
  } finally {
    pickStreamHit = { url: 'https://stream.qqmusic.qq.com/x.m4a?u=1' };
    unlockImpl = async () => ({ resolved: null, errors: [] });
  }
});

test('qq：外源腿 retry=1 → skipCache 透传给共享链', async () => {
  pickStreamHit = null;
  unlockCalls.length = 0;
  try {
    const r = await get('/qq/stream?mid=006RETRY00004&retry=1');
    assert.equal(r.status, 404); // 全灭终态不重要——钉的是透传位
    const [, opts] = unlockCalls.at(-1);
    assert.equal(opts.skipCache, true);
  } finally {
    pickStreamHit = { url: 'https://stream.qqmusic.qq.com/x.m4a?u=1' };
  }
});

test('qq：腿序钉——自有败亡+手动绑定命中 → 302+x-manual-source，外源腿零调用', async () => {
  pickStreamHit = null;
  unlockCalls.length = 0;
  resolveByIdCalls.length = 0;
  const mid = '007MANUAL0001';
  unlockManualRepo.upsertManual(`qq_${mid}`, {
    source: 'youtube', mediaId: 'dQw4w9WgXcQ', title: '', owner: '', durationSec: null,
  });
  try {
    const r = await get(`/qq/stream?mid=${mid}`);
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('x-manual-source'), 'youtube');
    assert.equal(resolveByIdCalls.length, 1, '绑定媒体经 resolveById 现解');
    assert.equal(unlockCalls.length, 0, '手动腿命中——外源解锁零调用（MANUAL-ONCE 位序）');
  } finally {
    unlockManualRepo.deleteManual(`qq_${mid}`);
    pickStreamHit = { url: 'https://stream.qqmusic.qq.com/x.m4a?u=1' };
  }
});

test('qq：外源腿全灭 → unlockErrors 逐源机读面透传（分档文案外排障用）', async () => {
  pickStreamHit = null;
  unlockImpl = async () => ({ resolved: null, errors: [
    { source: 'youtube', msg: '风控', cls: 'authwall' },
    { source: 'bilibili', msg: '无候选', cls: 'nomatch' },
  ] });
  try {
    const r = await json(await get('/qq/stream?mid=007ERRFUL0001'));
    assert.equal(r.status, 404);
    assert.deepEqual(r.body.unlockErrors, [
      { source: 'youtube', msg: '风控', cls: 'authwall' },
      { source: 'bilibili', msg: '无候选', cls: 'nomatch' },
    ]);
  } finally {
    pickStreamHit = { url: 'https://stream.qqmusic.qq.com/x.m4a?u=1' };
    unlockImpl = async () => ({ resolved: null, errors: [] });
  }
});

test('qq：外源腿预算 abort → 502 超时文案（重试搭 inflight/正档）', async () => {
  pickStreamHit = null;
  unlockImpl = async () => {
    const e = new Error('aborted');
    e.aborted = true;
    throw e;
  };
  try {
    const r = await json(await get('/qq/stream?mid=007BUDGET0001'));
    assert.equal(r.status, 502);
    assert.equal(r.body.message, '外源解锁超时——可稍后重试');
  } finally {
    pickStreamHit = { url: 'https://stream.qqmusic.qq.com/x.m4a?u=1' };
    unlockImpl = async () => ({ resolved: null, errors: [] });
  }
});

test('qq：qq-unlock 独立桶 20/min——第 21 发 429 且不再进共享链', async () => {
  pickStreamHit = null;
  const ip = '10.66.0.1'; // 固定 IP 共桶计数——钉死 20/min 配额界
  const n0 = unlockCalls.length;
  try {
    for (let i = 0; i < 20; i++) {
      const r = await get('/qq/stream?mid=008RATE00001', ip);
      assert.equal(r.status, 404, `第 ${i + 1} 发应走通外源腿后 404`);
    }
    assert.equal(unlockCalls.length - n0, 20, '20 发各进一次共享链');
    const r = await get('/qq/stream?mid=008RATE00002', ip);
    assert.equal(r.status, 429);
    const b = await r.json();
    assert.equal(b.code, 429);
    assert.equal(unlockCalls.length - n0, 20, '超限请求不进 resolveTrackUnlock');
  } finally {
    pickStreamHit = { url: 'https://stream.qqmusic.qq.com/x.m4a?u=1' };
  }
});

test('qq：stream 无流 404 文案按凭据态分档——匿名给外源/绑定指引，有 cookie 保留 VIP/地域口径', async () => {
  pickStreamHit = null;
  try {
    cookieOn = false;
    let r = await json(await get('/qq/stream?mid=005NILxx00001'));
    assert.equal(r.status, 404);
    assert.equal(r.body.message, '该歌曲暂无可播流——QQ 已关闭匿名取流且外源解锁未命中（可配置 Cookie 或绑定手动媒体源）');
    assert.ok(!/网易|词源/.test(r.body.message), '旧「匹配网易词源」文案必须消灭');
    cookieOn = true;
    r = await json(await get('/qq/stream?mid=005NILxx00002'));
    assert.equal(r.status, 404);
    assert.equal(r.body.message, '该歌曲没有可用的播放流（自有档与外源解锁均未命中——可能需 VIP 权限或存在地域限制）');
  } finally {
    cookieOn = false;
    pickStreamHit = { url: 'https://stream.qqmusic.qq.com/x.m4a?u=1' };
  }
});

// ── anon 拒答负 memo（本用例盖章进程级 qqAnonDeniedAt——必须排在所有
//    依赖自有腿实况的 /qq/stream 用例之后，后续用例只走非流路由）──
test('qq：qqAnonDenied → 502 诚实文案+memo 章（TTL 内不重打 pickStream；retry=1/cookie 绕 memo）', async () => {
  cookieOn = false;
  let pickN = 0;
  pickStreamImpl = async () => {
    pickN++;
    const e = new Error('qq musicu vkey.GetVkeyServer code=0/1000');
    e.qqAnonDenied = true; e.nodeCode = 1000; e.retcode = 104009;
    throw e;
  };
  try {
    // 实锤盖章：自有腿真打一次拒答 → 502 + unlockErrors 机读面
    let r = await json(await get('/qq/stream?mid=005DENIED0001'));
    assert.equal(r.status, 502);
    assert.equal(r.body.message, 'QQ 已关闭匿名取流——请在设置页配置 QQ Cookie 后重试');
    assert.deepEqual(r.body.unlockErrors, []);
    assert.equal(pickN, 1);

    // TTL 内无 cookie：合成 ownErr 整腿跳过——pickStream 零新调用仍 502
    r = await json(await get('/qq/stream?mid=005DENIED0002'));
    assert.equal(r.status, 502);
    assert.equal(r.body.message, 'QQ 已关闭匿名取流——请在设置页配置 QQ Cookie 后重试');
    assert.equal(pickN, 1, '负 memo 生效——注定拒答的 vkey 不再喂风控信号');

    // retry=1 显式重探 reopening：绕 memo 重打自有腿
    r = await json(await get('/qq/stream?mid=005DENIED0003&retry=1'));
    assert.equal(r.status, 502);
    assert.equal(pickN, 2, 'retry=1 绕 memo——显式重试要重探');

    // cookie 在场同绕 memo（凭据变了必须重探）
    cookieOn = true;
    r = await json(await get('/qq/stream?mid=005DENIED0004'));
    assert.equal(r.status, 502);
    assert.equal(pickN, 3, 'cookie 在场绕 memo——拒答可能是旧凭据态');
  } finally {
    cookieOn = false;
    pickStreamImpl = async () => pickStreamHit;
  }
});

test('qq：lyric 非法 mid 400；正常返回双语', async () => {
  assert.equal((await get('/qq/lyric?mid=!!')).status, 400);
  const r = await json(await get(`/qq/lyric?mid=${TRACK.mid}`));
  assert.equal(r.body.lyric, '[00:01.00]词');
  assert.equal(r.body.trans, '[00:01.00]译');
});

test('qq：search 空 query 400；命中回 trackJson 列表 + total/page 契约', async () => {
  assert.equal((await get('/qq/search?q=%20')).status, 400);
  const r = await json(await get('/qq/search?q=test'));
  assert.equal(r.body.list.length, 1);
  assert.equal(r.body.list[0].mid, TRACK.mid);
  // 缺省 p=1；total 直透上游真值
  assert.deepEqual(searchArgs, { q: 'test', opts: { limit: 20, page: 1 } });
  assert.equal(r.body.total, 600);
  assert.equal(r.body.page, 1);
});

test('qq：search p/limit 翻页参数透传 + 钳位', async () => {
  await get('/qq/search?q=x&p=2&limit=5');
  assert.deepEqual(searchArgs.opts, { limit: 5, page: 2 });
  // p=0 / 负 / 非数 → 归一回 1；limit 超上限钳 30（lib 层 n≤30）
  await get('/qq/search?q=x&p=0&limit=999');
  assert.deepEqual(searchArgs.opts, { limit: 30, page: 1 });
  await get('/qq/search?q=x&p=-9');
  assert.equal(searchArgs.opts.page, 1);
  await get('/qq/search?q=x&p=abc');
  assert.equal(searchArgs.opts.page, 1);
});

test('qq：search trackJson 带 publishTime 时透传，缺席不留键', async () => {
  searchList = [TRACK, OTHER];
  try {
    const r = await json(await get('/qq/search?q=pub'));
    assert.ok(!('publishTime' in r.body.list[0]), '无值曲不留 publishTime 键');
    assert.equal(r.body.list[1].publishTime, 1193932800000);
  } finally { searchList = [TRACK]; }
});

test('qq：suggest 形状/校验——key 缺省与超长 400，命中回网易 suggest 形态', async () => {
  assert.equal((await get('/qq/suggest')).status, 400);
  assert.equal((await get('/qq/suggest?key=%20')).status, 400);
  assert.equal((await get(`/qq/suggest?key=${'x'.repeat(101)}`)).status, 400);
  const r = await json(await get('/qq/suggest?key=青花瓷'));
  assert.equal(r.status, 200);
  assert.equal(suggestArgs, '青花瓷');
  assert.deepEqual(r.body.result, SUGGEST);
});

test('qq：hot 回网易 search_hot 归一形态 {hots:[{first}]}', async () => {
  const r = await json(await get('/qq/hot'));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { code: 200, result: { hots: [{ first: '我们的歌' }] } });
});

test('qq：search-playlists 校验 + 归一卡/total/分页透传', async () => {
  assert.equal((await get('/qq/search-playlists')).status, 400);
  assert.equal((await get('/qq/search-playlists?q=%20')).status, 400);
  const r = await json(await get('/qq/search-playlists?q=周杰伦&p=2&limit=3'));
  assert.equal(r.status, 200);
  assert.deepEqual(plSearchArgs, { q: '周杰伦', opts: { page: 2, limit: 3 } });
  assert.equal(r.body.total, 46689);
  assert.deepEqual(r.body.playlists, [PL_CARD]); // provider:'qq' 卡契约整体钉
});

test('qq：similar 校验 + 艺人搜索降级 + degraded 标记 + 种子剔除', async () => {
  assert.equal((await get('/qq/similar')).status, 400);
  assert.equal((await get('/qq/similar?songmid=!!')).status, 400);

  const seedMid = '003SEEDmid0001'; // SONGMID_RE /^[0-9A-Za-z]{10,20}$/
  searchList = [TRACK, { ...TRACK, mid: seedMid }];
  try {
    const r = await json(await get(`/qq/similar?songmid=${seedMid}`));
    assert.equal(r.status, 200);
    // 详情 artists[0] 做搜索词（艺人甲）；种子曲自身从结果剔除
    assert.equal(searchArgs.q, '艺人甲');
    assert.deepEqual(searchArgs.opts, { limit: 20 });
    assert.equal(r.body.degraded, true);
    assert.equal(r.body.list.length, 1);
    assert.equal(r.body.list[0].mid, TRACK.mid);
  } finally { searchList = [TRACK]; }

  // 详情拿不到艺人 → 空降级面而不是炸
  songDetailImpl = async () => ({ ...TRACK, artists: [] });
  try {
    const r = await json(await get('/qq/similar?songmid=003SEEDmid0002'));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { code: 200, list: [], degraded: true });
  } finally { songDetailImpl = async (id) => ({ ...TRACK, mid: String(id) }); }
});

test('qq：playlist 非法 disstid 400；命中回歌单+归一曲目+truncated 契约', async () => {
  assert.equal((await get('/qq/playlist?id=abc')).status, 400);
  const r = await json(await get('/qq/playlist?id=777'));
  assert.equal(r.status, 200);
  assert.equal(r.body.name, 'QQ歌单');
  assert.equal(r.body.tracks[0].mid, TRACK.mid);
  assert.equal(r.body.truncated, false); // 与 bili/yt 路由同型的契约字段
});

test('qq：playlist 匹配池——命中曲带 matched/matchedBy/matchScore、matchedCount 计数、调用面与 resolve 同口径', async () => {
  plImpl = async () => ({
    id: '778', name: 'QQ歌单', creator: 't', cover: '', desc: '',
    songCount: 2, tracks: [{ ...TRACK }, { ...OTHER }], truncated: false,
  });
  matchCalls.length = 0;
  matchImpl = async (candidates, dur, tag, signal, src) => {
    assert.equal(tag, 'qq-playlist');
    return src.trackId === `qq_${OTHER.mid}`
      ? { song: { id: 555, name: 'Hit', ar: [{ name: '歌手' }], al: { id: 1 } }, query: 'q-hit', score: 88 }
      : { song: null, query: null };
  };
  try {
    const r = await json(await get('/qq/playlist?id=778'));
    assert.equal(r.status, 200);
    assert.equal(r.body.matchedCount, 1);
    // 命中曲（OTHER）：投影三字段随曲目下发——neteaseId 回链弹药经此进
    // buildQQSong → providerData
    const t1 = r.body.tracks[1];
    assert.deepEqual(t1.matched, { id: 555, name: 'Hit', ar: [{ name: '歌手' }], al: { id: 1 } });
    assert.equal(t1.matchedBy, 'q-hit');
    assert.equal(t1.matchScore, 88);
    // 未命中曲：三字段归 null 照常下发（预算耗尽余曲同形态）
    const t0 = r.body.tracks[0];
    assert.equal(t0.matched, null);
    assert.equal(t0.matchedBy, null);
    assert.equal(t0.matchScore, null);
    // 调用面钉：候选串 艺人组合→裸名、duration=intervalSec、
    // sourceInfo.trackId/artists/publishedAt 与 /qq/resolve 同口径
    const trackCall = matchCalls.find(c => c[4].trackId === `qq_${TRACK.mid}`);
    assert.deepEqual(trackCall[0], ['艺人甲 艺人乙 歌名', '歌名']);
    assert.equal(trackCall[1], 200);
    assert.equal(trackCall[4].publishedAt, 0); // TRACK 无 publishTime → 归 0
    const otherCall = matchCalls.find(c => c[4].trackId === `qq_${OTHER.mid}`);
    assert.equal(otherCall[4].publishedAt, OTHER.publishTime); // 发行日时间证据透传
    assert.equal(otherCall[4].artists.join(' '), '艺人甲 艺人乙');
  } finally {
    plImpl = defaultPl;
    matchImpl = async () => ({ song: { id: 998877, name: '匹配曲', ar: [{ name: '网艺' }], al: {} }, query: 'q1' });
  }
});

test('qq：playlist 默认桩每曲皆中——matchedCount 等于曲目数', async () => {
  // 默认 matchImpl 恒命中：单曲歌单 matchedCount=1
  const r = await json(await get('/qq/playlist?id=777'));
  assert.equal(r.status, 200);
  assert.equal(r.body.matchedCount, 1);
  assert.equal(r.body.tracks[0].matched.id, 998877);
});

test('qq：playlist 匹配池级异常 → 200 + matchedCount=0（匹配降级不炸导入本体）', async () => {
  plImpl = async () => ({
    id: '779', name: 'QQ歌单', creator: 't', cover: '', desc: '',
    songCount: 1, tracks: [{ ...TRACK }], truncated: false,
  });
  // 池级故障（同步抛穿 matchTracksPool——区别于单曲落空被 stub 吞成
  // song:null）：catch 降级 matchedCount=0，曲目照常下发只是无回链弹药
  matchImpl = () => { throw new Error('池级故障'); };
  try {
    const r = await json(await get('/qq/playlist?id=779'));
    assert.equal(r.status, 200);
    assert.equal(r.body.matchedCount, 0);
    assert.equal(r.body.tracks.length, 1);
    assert.equal(r.body.tracks[0].mid, TRACK.mid);
    assert.equal(r.body.tracks[0].matched, null);
  } finally {
    plImpl = defaultPl;
    matchImpl = async () => ({ song: { id: 998877, name: '匹配曲', ar: [{ name: '网艺' }], al: {} }, query: 'q1' });
  }
});

test('qq：playlist 匹配在途断连 → 499（abort 静默优先于导入回包）', async () => {
  const ctrl = new AbortController();
  plImpl = async () => ({
    id: '780', name: 'QQ歌单', creator: 't', cover: '', desc: '',
    songCount: 1, tracks: [{ ...TRACK }], truncated: false,
  });
  // 匹配在途时客户端断连——池跑完后 abort 检查先返回 499 静默
  matchImpl = async () => { ctrl.abort(); return { song: { id: 1 }, query: 'q' }; };
  try {
    const res = await app.request(new Request('http://t/qq/playlist?id=780', { signal: ctrl.signal }));
    assert.equal(res.status, 499);
  } finally {
    plImpl = defaultPl;
    matchImpl = async () => ({ song: { id: 998877, name: '匹配曲', ar: [{ name: '网艺' }], al: {} }, query: 'q1' });
  }
});

test('qq：resolve 的 sourceInfo 携 publishTime → 匹配侧 publishedAt 时间证据', async () => {
  // matchCalls 记录位序：[candidates, durationSec, tag, null, sourceInfo]
  const pubMs = 1193932800000;
  resolvedInput = { mid: TRACK.mid };
  matchCalls.length = 0;
  songDetailImpl = async (id) => ({ ...TRACK, mid: String(id), publishTime: pubMs });
  try {
    const r = await json(await get(`/qq/resolve?input=${TRACK.mid}`));
    assert.equal(r.status, 200);
    const src = matchCalls.at(-1)?.[4];
    assert.equal(src.publishedAt, pubMs);          // 与 bv/yt 路由同轴——喂 srcPubMsOf
    assert.equal(src.trackId, `qq_${TRACK.mid}`);
  } finally {
    songDetailImpl = async (id) => ({ ...TRACK, mid: String(id) });
    resolvedInput = null;
  }
});

test('qq：resolve 详情无 publishTime → sourceInfo.publishedAt 归 0（未知不扰判定）', async () => {
  resolvedInput = { mid: TRACK.mid };
  matchCalls.length = 0;
  const r = await json(await get(`/qq/resolve?input=${TRACK.mid}`));
  assert.equal(r.status, 200);
  assert.equal(matchCalls.at(-1)?.[4]?.publishedAt, 0);
  resolvedInput = null;
});

test('qq：search p 上限钳 1000——超界页码不放大上游翻页扇面', async () => {
  await get('/qq/search?q=x&p=5000');
  assert.equal(searchArgs.opts.page, 1000);
  await get('/qq/search?q=x&p=1000');
  assert.equal(searchArgs.opts.page, 1000);
});

test('qq：search-playlists 回包带 page——与 /qq/search 分页契约同轴', async () => {
  const r = await json(await get('/qq/search-playlists?q=x&p=3'));
  assert.equal(r.status, 200);
  assert.equal(r.body.page, 3);
});

test('qq：similar 剔种子用 detail 归一后的 t.mid——不是请求原串', async () => {
  // detail 归一出与请求串不同的 mid（如 songid 入参被解成 songmid 形态）：
  // 种子剔除必须拿归一结果比对，否则自身混进相似列表
  const reqMid = '004REQmid00001';
  const resolvedMid = '004RESolvedMID';
  songDetailImpl = async () => ({ ...TRACK, mid: resolvedMid });
  searchList = [TRACK, { ...TRACK, mid: resolvedMid }];
  try {
    const r = await json(await get(`/qq/similar?songmid=${reqMid}`));
    assert.equal(r.status, 200);
    const mids = r.body.list.map(t => t.mid);
    assert.deepEqual(mids, [TRACK.mid]); // 归一 mid 的自身曲被剔除
  } finally {
    songDetailImpl = async (id) => ({ ...TRACK, mid: String(id) });
    searchList = [TRACK];
  }
});

test('qq：四条新路由上游失败 → 502（search-playlists/suggest/hot/similar）', async () => {
  plSearchImpl = async () => { throw new Error('上游挂'); };
  suggestImpl = async () => { throw new Error('上游挂'); };
  hotImpl = async () => { throw new Error('上游挂'); };
  searchImpl = async () => { throw new Error('上游挂'); };
  try {
    for (const path of [
      '/qq/search-playlists?q=x',
      '/qq/suggest?key=x',
      '/qq/hot',
      `/qq/similar?songmid=${TRACK.mid}`, // detail 正常、艺人搜索挂 → 502
    ]) {
      const r = await json(await get(path));
      assert.equal(r.status, 502, `${path} 上游失败应 502`);
      assert.equal(r.body.code, 502);
    }
  } finally {
    plSearchImpl = async () => ({ playlists: [PL_CARD], total: 46689 });
    suggestImpl = async () => SUGGEST;
    hotImpl = async () => ({ hots: [{ first: '我们的歌' }] });
    searchImpl = async () => ({ list: searchList, total: searchTotal });
  }
});

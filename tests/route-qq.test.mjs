// routes/qq.js 冒烟：状态透出 / resolve 解析分流（disstid 歌单跳）/
// stream 302 进 vault / lyric/search/playlist 成功形状 + 入参 400。
// lib/qq（musicu 上游）与 netease-match（词源匹配）全桩——桩面走
// helpers.seedMatchModule 保持与 netease-match.test.mjs 同口径。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { seed, seedMatchModule, tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-route-qq-');
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
seed('../src/server/lib/qq.js', {
  hasQqCookie: () => false,
  PLAY_LADDER: ['m800'], BEST_LADDER: ['flac'],
  SONGMID_RE: /^[0-9A-Za-z]{10,20}$/,
  getSongDetail: async (...a) => songDetailImpl(...a),
  pickStreamUrl: async (...a) => pickStreamImpl(...a),
  getLyric: async () => ({ lyric: '[00:01.00]词', trans: '[00:01.00]译' }),
  // 与 lib/qq.js getPlaylist 真身同形（id/name/creator/cover/desc/songCount/
  // tracks/truncated）——路由显式透 truncated 契约字段，桩缺它会让该字段
  // 恒 false 且无断言兜住
  getPlaylist: async () => ({
    id: '777', name: 'QQ歌单', creator: 'tester', cover: '', desc: '',
    songCount: 1, tracks: [TRACK], truncated: false,
  }),
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

let app;
before(() => { app = require('../src/server/routes/qq.js'); });
after(() => { rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

const get = (path) => app.request(`http://t${path}`);
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

test('qq：stream 非法 mid 400；命中 → 302 进 vault 令牌而非裸链', async () => {
  const bad = await get('/qq/stream?mid=!!');
  assert.equal(bad.status, 400);

  const r = await get(`/qq/stream?mid=${TRACK.mid}`);
  assert.equal(r.status, 302);
  const loc = r.headers.get('location');
  assert.match(loc, /^\/audio-proxy\/t\//);
  // vault token 能解出原 URL——mint 语义钉住（purl 不出前端）
  const streamVault = require('../src/server/lib/stream-vault.js');
  const entry = streamVault.resolve(loc.split('/audio-proxy/t/')[1]);
  assert.equal(entry.urls[0], 'https://stream.qqmusic.qq.com/x.m4a?u=1');
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

test('qq：stream 无可用档 → 404', async () => {
  pickStreamHit = null;
  // 同上——null 不缓存，但也得用没被 302 用例写过的键
  const r = await get('/qq/stream?mid=001NILxxx23456');
  assert.equal(r.status, 404);
  pickStreamHit = { url: 'https://stream.qqmusic.qq.com/x.m4a?u=1' };
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

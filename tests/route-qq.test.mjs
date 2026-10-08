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
let resolvedInput = null;
let pickStreamHit = { url: 'https://stream.qqmusic.qq.com/x.m4a?u=1' };
let pickStreamImpl = async () => pickStreamHit; // 可换抛错实现——路径剥离钉用
seed('../src/server/lib/qq.js', {
  hasQqCookie: () => false,
  PLAY_LADDER: ['m800'], BEST_LADDER: ['flac'],
  SONGMID_RE: /^[0-9A-Za-z]{10,20}$/,
  getSongDetail: async (id) => ({ ...TRACK, mid: String(id) }),
  pickStreamUrl: async (...a) => pickStreamImpl(...a),
  getLyric: async () => ({ lyric: '[00:01.00]词', trans: '[00:01.00]译' }),
  // 与 lib/qq.js getPlaylist 真身同形（id/name/creator/cover/desc/songCount/
  // tracks/truncated）——路由显式透 truncated 契约字段，桩缺它会让该字段
  // 恒 false 且无断言兜住
  getPlaylist: async () => ({
    id: '777', name: 'QQ歌单', creator: 'tester', cover: '', desc: '',
    songCount: 1, tracks: [TRACK], truncated: false,
  }),
  searchSongs: async () => [TRACK],
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
    const r = await json(await get(`/qq/stream?mid=${TRACK.mid}`));
    assert.equal(r.status, 502);
    assert.ok(!r.body.message.includes('/data/meowsync'), `路径泄漏: ${r.body.message}`);
    assert.match(r.body.message, /<path>/);
  } finally { pickStreamImpl = async () => pickStreamHit; }
});

test('qq：stream 无可用档 → 404', async () => {
  pickStreamHit = null;
  const r = await get(`/qq/stream?mid=${TRACK.mid}`);
  assert.equal(r.status, 404);
  pickStreamHit = { url: 'https://stream.qqmusic.qq.com/x.m4a?u=1' };
});

test('qq：lyric 非法 mid 400；正常返回双语', async () => {
  assert.equal((await get('/qq/lyric?mid=!!')).status, 400);
  const r = await json(await get(`/qq/lyric?mid=${TRACK.mid}`));
  assert.equal(r.body.lyric, '[00:01.00]词');
  assert.equal(r.body.trans, '[00:01.00]译');
});

test('qq：search 空 query 400；命中回 trackJson 列表', async () => {
  assert.equal((await get('/qq/search?q=%20')).status, 400);
  const r = await json(await get('/qq/search?q=test'));
  assert.equal(r.body.list.length, 1);
  assert.equal(r.body.list[0].mid, TRACK.mid);
});

test('qq：playlist 非法 disstid 400；命中回歌单+归一曲目+truncated 契约', async () => {
  assert.equal((await get('/qq/playlist?id=abc')).status, 400);
  const r = await json(await get('/qq/playlist?id=777'));
  assert.equal(r.status, 200);
  assert.equal(r.body.name, 'QQ歌单');
  assert.equal(r.body.tracks[0].mid, TRACK.mid);
  assert.equal(r.body.truncated, false); // 与 bili/yt 路由同型的契约字段
});

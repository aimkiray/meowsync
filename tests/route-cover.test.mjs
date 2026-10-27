// routes/cover.js 冒烟：qq_ 无专辑曲封面惰性解析——专辑曲直构 y.gtimg /
// 外源挑选池命中回 cover / 标题双闸不中回 null / 非白名单域 fail-closed /
// 非 qq_ id 400 / 10min memo 正负同键不重复上行。
// lib/qq（getSongDetail 上游）与 unlock/index（PROVIDER 挑选池）全桩；
// pickTitleDurationMatch 用真实现（纯函数选定器，无上游依赖——双闸语义
// 钉在真闸上才算钉住「防无关内容当封面」的规格）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { seed, tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-route-cover-');
// 限流桶按 IP 分：XFF 独立 IP 防跨用例配额互耗（route-qq 同款手法）
process.env.TRUST_PROXY = '1';
const require = createRequire(import.meta.url);

// ── 桩：QQ 上游 lib ──
// 无专辑单曲归一形态（normalizeTrack 产物）：albummid 空、cover 空——
// 客户端三腿全灭正是靠这个组合钉的
const TRACK_NO_ALBUM = {
  mid: '003NOALBUM0000', songId: 7, name: '目标曲', artists: ['EMA'],
  album: '', albummid: '', intervalSec: 200, cover: '',
  mediaMid: 'mm', payPlay: 0, vipOnly: 0,
};
const TRACK_WITH_ALBUM = {
  ...TRACK_NO_ALBUM, mid: '003HASALBUM000',
  album: '某专', albummid: 'albmXYZ',
};
let detailCalls = 0;
let detailImpl = async (id) => ({ ...TRACK_NO_ALBUM, mid: String(id) });
seed('../src/server/lib/qq.js', {
  getSongDetail: async (...a) => { detailCalls++; return detailImpl(...a); },
});

// ── 桩：provider 手动挑选池 ──
// search 调用面记录（keyword 派生钉）；候选内容 per-case 换底
const searchCalls = [];
let ytSearchImpl = async () => [];
let bvSearchImpl = async () => [];
seed('../src/server/services/unlock/index.js', {
  PROVIDERS: {
    youtube: { search: async (kw, o) => { searchCalls.push(['youtube', kw]); return ytSearchImpl(kw, o); } },
    bilibili: { search: async (kw, o) => { searchCalls.push(['bilibili', kw]); return bvSearchImpl(kw, o); } },
  },
});

let app;
before(() => {
  app = require('../src/server/routes/cover.js');
});
after(() => {
  delete process.env.TRUST_PROXY;
  rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

let ipSeq = 40;
// 每发独立 XFF——cover-resolve 12/min 桶互不染
const get = (path) => app.request(`http://t${path}`,
  { headers: { 'x-forwarded-for': `10.88.${++ipSeq}.1` } });
const json = async (res) => ({ status: res.status, body: await res.json().catch(() => null) });

test('cover：非 qq_ 轨道 id → 400（网易数值/yt_/bv_ 一律不收）', async () => {
  for (const id of ['12345678', 'yt_dQw4w9WgXcQ', 'bv_BV1xx411c7mD', 'qq_short', '']) {
    const r = await json(await get(`/cover?id=${encodeURIComponent(id)}`));
    assert.equal(r.status, 400, `id=${id} 应 400`);
    assert.equal(r.body.code, 400);
  }
});

test('cover：有 albummid → 直构 y.gtimg.cn T002R300 封面（不走挑选池）', async () => {
  detailImpl = async () => TRACK_WITH_ALBUM;
  searchCalls.length = 0;
  try {
    const r = await json(await get(`/cover?id=qq_${TRACK_WITH_ALBUM.mid}`));
    assert.equal(r.status, 200);
    assert.equal(r.body.cover,
      `https://y.gtimg.cn/music/photo_new/T002R300x300M000${TRACK_WITH_ALBUM.albummid}.jpg`);
    assert.equal(searchCalls.length, 0, '专辑支不烧外源检索扇出');
  } finally {
    detailImpl = async (id) => ({ ...TRACK_NO_ALBUM, mid: String(id) });
  }
});

test('cover：无专辑 + 挑选池标题/时长双闸命中 → 回白名单 cover', async () => {
  ytSearchImpl = async () => [
    { videoId: 'v', title: 'X - 目标曲', durationSec: 200,
      cover: 'https://i.ytimg.com/vi/v/mqdefault.jpg' },
  ];
  try {
    const r = await json(await get(`/cover?id=qq_${TRACK_NO_ALBUM.mid}`));
    assert.equal(r.status, 200);
    assert.equal(r.body.cover, 'https://i.ytimg.com/vi/v/mqdefault.jpg');
    // keyword 派生钉：name - 首艺人
    assert.equal(searchCalls.at(-1)[1], '目标曲 - EMA');
  } finally {
    ytSearchImpl = async () => [];
  }
});

test('cover：池内候选标题无关 → cover:null（不拿无关缩略图当封面）', async () => {
  ytSearchImpl = async () => [
    { videoId: 'p', title: '室内绿植养护教程', durationSec: 200,
      cover: 'https://i.ytimg.com/vi/p/mqdefault.jpg' },
  ];
  bvSearchImpl = async () => [
    { videoId: 'BV1xx411c7mD', title: '完全不相关', durationSec: 199,
      cover: 'https://i0.hdslb.com/bfs/archive/x.jpg' },
  ];
  try {
    const r = await json(await get('/cover?id=qq_003NOMATCH000'));
    assert.equal(r.status, 200);
    assert.equal(r.body.cover, null);
  } finally {
    ytSearchImpl = async () => [];
    bvSearchImpl = async () => [];
  }
});

test('cover：命中候选 cover 落非白名单域 → fail-closed 归 null', async () => {
  ytSearchImpl = async () => [
    { videoId: 'e', title: 'EMA - 目标曲', durationSec: 200,
      cover: 'https://evil.example/x.jpg' },
  ];
  try {
    const r = await json(await get('/cover?id=qq_003EVILCOV000'));
    assert.equal(r.status, 200);
    assert.equal(r.body.cover, null);
  } finally {
    ytSearchImpl = async () => [];
  }
});

test('cover：memo 正负同键——二次请求零上行（detail/search 调用计数钉）', async () => {
  const mid = '003MEMO0000001';
  const n0 = detailCalls;
  // 负结果（空池 → cover:null）也进 memo：歌单渲染反复打同曲不重烧上游
  const r1 = await json(await get(`/cover?id=qq_${mid}`));
  assert.equal(r1.status, 200);
  assert.equal(r1.body.cover, null);
  assert.equal(detailCalls - n0, 1);
  const r2 = await json(await get(`/cover?id=qq_${mid}`));
  assert.equal(r2.status, 200);
  assert.equal(r2.body.cover, null);
  assert.equal(detailCalls - n0, 1, 'memo 命中——二次请求不重打 getSongDetail');
});

test('cover：双源检索全灭 → 502 且不固化进 memo', async () => {
  ytSearchImpl = async () => { throw new Error('风控'); };
  bvSearchImpl = async () => { throw new Error('瞬断'); };
  const mid = '003ALLFAIL0001';
  const n0 = detailCalls;
  try {
    const r = await json(await get(`/cover?id=qq_${mid}`));
    assert.equal(r.status, 502);
    assert.equal(r.body.code, 502);
  } finally {
    ytSearchImpl = async () => [];
    bvSearchImpl = async () => [];
  }
  // 502 是瞬态档——同一 mid 立刻可重探（若被 memo 固化会 10min 假死）
  const r2 = await json(await get(`/cover?id=qq_${mid}`));
  assert.equal(r2.status, 200);
  assert.equal(detailCalls - n0, 2, '502 未固化——恢复后重打上游');
});

test('cover：命中候选 cover 带 userinfo/非标端口 → 客户端同判据 fail-closed 归 null', async () => {
  // 客户端 proxiedCoverUrl（song.js）对 port/userinfo 判死——服务端放行
  // 会产「非空但永不渲染」的毒化 picUrl，且 heal 收口径不再重问
  for (const [mid, cover] of [
    ['003USERINFO0001', 'https://u:p@i.ytimg.com/x.jpg'],
    ['003BADPORT00001', 'https://i.ytimg.com:8443/x.jpg'],
  ]) {
    ytSearchImpl = async () => [
      { videoId: 'v', title: 'EMA - 目标曲', durationSec: 200, cover },
    ];
    try {
      const r = await json(await get(`/cover?id=qq_${mid}`));
      assert.equal(r.status, 200);
      assert.equal(r.body.cover, null, `${cover} 应 fail-closed`);
    } finally {
      ytSearchImpl = async () => [];
    }
  }
});

test('cover：detail 无 name → 免扇出直接 cover:null（选定闸恒否白打一跳）', async () => {
  detailImpl = async () => ({ ...TRACK_NO_ALBUM, mid: '003NONAME00001', name: '' });
  searchCalls.length = 0;
  try {
    const r = await json(await get('/cover?id=qq_003NONAME00001'));
    assert.equal(r.status, 200);
    assert.equal(r.body.cover, null);
    assert.equal(searchCalls.length, 0, '无 name 不烧外源检索扇出');
  } finally {
    detailImpl = async (id) => ({ ...TRACK_NO_ALBUM, mid: String(id) });
  }
});

test('cover：/cover 在 isApiPath PREFIXES 表内（authGate/SPA 兜底同源分类）', () => {
  const { isApiPath } = require('../src/server/lib/api-path.js');
  assert.equal(isApiPath('/cover'), true);
  assert.equal(isApiPath('/cover/extra'), true);
});

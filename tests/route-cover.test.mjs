// routes/cover.js 冒烟：qq_ 无专辑曲封面惰性解析——专辑曲直构 y.gtimg /
// 网易词源绑定腿（ne hint/song_match 正行 → song_detail 官封+专辑名）/
// 外源挑选池命中回 cover / 标题双闸不中回 null / 非白名单域 fail-closed /
// 非 qq_ id 400 / 10min memo 正负同键不重复上行。
// lib/qq（getSongDetail 上游）与 unlock/index（PROVIDER 挑选池）全桩；
// songMatch 库（getMatchRow/getVetoedIds）与 netease-api（song_detail
// 上游）同桩——绑定腿候选装配、否决跳过、失败续打各语义钉在桩面上。
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

// ── 桩：网易绑定腿（song_match 库行直读 + song_detail 上游）──
// getMatchRow 正向行 / getVetoedIds 生效集 per-case 换底（默认无绑定、
// 零否决——存量用例默认过空腿落外源池，行为不漂）；callNeteaseApi 录
// 调用面（候选序/否决跳过/失败续打计数钉），per-case 换底回包
const neCalls = [];
let neDetailImpl = async () => ({ body: { songs: [] } });
let matchRowImpl = () => undefined;
let vetoedImpl = () => new Set();
seed('../src/server/repositories/songMatch.js', {
  getMatchRow: (id) => matchRowImpl(id),
  getVetoedIds: (id) => vetoedImpl(id),
});
seed('../src/server/services/netease-api.js', {
  callNeteaseApi: async (api, params) => {
    neCalls.push([api, params]);
    return neDetailImpl(api, params);
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
    assert.equal(r.body.album, TRACK_WITH_ALBUM.album,
      '直构支顺带回发专辑名——客户端同补「未知专辑」');
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

// ── 网易词源绑定腿 ──
test('cover：ne 参数 hint → song_detail 官封+专辑名回发（yt/bv 零扇出）', async () => {
  // 客户端曲对象自带绑定随 ?ne= 上行——绑定腿最前候选，命中即终态
  neDetailImpl = async (api, params) => {
    assert.equal(api, 'song_detail');
    assert.equal(params.ids, '26130076');
    return { body: { songs: [{ al: { name: '告白 - Original Soundtrack', picUrl: 'https://p2.music.126.net/x.jpg' } }] } };
  };
  searchCalls.length = 0;
  try {
    const r = await json(await get('/cover?id=qq_000d5uID17aiNJ&ne=26130076'));
    assert.equal(r.status, 200);
    assert.equal(r.body.cover, 'https://p2.music.126.net/x.jpg');
    assert.equal(r.body.album, '告白 - Original Soundtrack', '官封伴随专辑名随包');
    assert.equal(neCalls.length, 1);
    assert.equal(searchCalls.length, 0, '绑定腿命中不烧外源检索扇出');
  } finally {
    neDetailImpl = async () => ({ body: { songs: [] } });
    neCalls.length = 0;
  }
});

test('cover：无 ne 参 → song_match 正向行绑定照解官封', async () => {
  // 曲对象 neteaseId 缺席（镜像行等）——服务端库行仍兜；数值列 String 化
  matchRowImpl = (id) => (id === 'qq_003MATCHED0001' ? { netease_id: 26130076 } : undefined);
  neDetailImpl = async (api, params) => {
    assert.equal(params.ids, '26130076');
    return { body: { songs: [{ al: { name: '某专', picUrl: 'https://p3.music.126.net/y.jpg' } }] } };
  };
  searchCalls.length = 0;
  try {
    const r = await json(await get('/cover?id=qq_003MATCHED0001'));
    assert.equal(r.status, 200);
    assert.equal(r.body.cover, 'https://p3.music.126.net/y.jpg');
    assert.equal(r.body.album, '某专');
    assert.equal(neCalls.length, 1);
    assert.equal(searchCalls.length, 0);
  } finally {
    matchRowImpl = () => undefined;
    neDetailImpl = async () => ({ body: { songs: [] } });
    neCalls.length = 0;
  }
});

test('cover：生效否决集命中的候选跳过零上行 → 落下一候选', async () => {
  // ne hint '111' 在否决集（判过非同作品——其封面也不该贴），
  // 库行 '222' 落为实际候选；否决者连 song_detail 都不该烧
  vetoedImpl = () => new Set(['111']);
  matchRowImpl = () => ({ netease_id: '222' });
  neDetailImpl = async (api, params) => {
    assert.equal(params.ids, '222');
    return { body: { songs: [{ al: { picUrl: 'https://p4.music.126.net/z.jpg' } }] } };
  };
  try {
    const r = await json(await get('/cover?id=qq_003VETOSKIP001&ne=111'));
    assert.equal(r.status, 200);
    assert.equal(r.body.cover, 'https://p4.music.126.net/z.jpg');
    assert.equal(r.body.album, undefined, 'al.name 缺位不落 album 键');
    assert.deepEqual(neCalls.map(c => c[1].ids), ['222'], '否决候选零上游调用');
  } finally {
    vetoedImpl = () => new Set();
    matchRowImpl = () => undefined;
    neDetailImpl = async () => ({ body: { songs: [] } });
    neCalls.length = 0;
  }
});

test('cover：ne 非法形静默丢——不 400、零网易上行、照常落外源兜底', async () => {
  // hint 是增强不是契约：非数字/越界形态与缺席同处理，不判 400
  const cases = ['abc', '1e5', '26130076;DROP', '-1', '1'.repeat(21)];
  for (let i = 0; i < cases.length; i++) {
    const r = await json(await get(
      `/cover?id=qq_003BADNE00${i}X&ne=${encodeURIComponent(cases[i])}`));
    assert.equal(r.status, 200, `ne=${cases[i]} 不应 400`);
    assert.equal(r.body.cover, null, '空池负终态——非法 hint 无副作用');
  }
  assert.equal(neCalls.length, 0, '非法 hint 不产生 song_detail 上行');
});

test('cover：绑定腿候选全灭（上游抛错+空曲集）→ 回落 yt/bv 池照常', async () => {
  // 机会腿败亡不连坐兜底：'111' 上游抛错续打 '222'、'222' 回空 songs
  // ——两腿全灭落挑选池，双闸命中照常回缩略图
  matchRowImpl = () => ({ netease_id: '222' });
  neDetailImpl = async (api, params) => {
    if (params.ids === '111') throw new Error('网易云 502');
    return { body: { songs: [] } };
  };
  ytSearchImpl = async () => [
    { videoId: 'v', title: 'EMA - 目标曲', durationSec: 200,
      cover: 'https://i.ytimg.com/vi/v/mqdefault.jpg' },
  ];
  try {
    const r = await json(await get('/cover?id=qq_003NEFALLBACK1&ne=111'));
    assert.equal(r.status, 200);
    assert.deepEqual(neCalls.map(c => c[1].ids), ['111', '222'],
      '候选序 hint 先库行后，单候选失败续打下一候选');
    assert.equal(r.body.cover, 'https://i.ytimg.com/vi/v/mqdefault.jpg');
    assert.equal(r.body.album, undefined, '外源池支无专辑名不落键');
  } finally {
    matchRowImpl = () => undefined;
    neDetailImpl = async () => ({ body: { songs: [] } });
    ytSearchImpl = async () => [];
    neCalls.length = 0;
  }
});

test('cover：/cover 在 isApiPath PREFIXES 表内（authGate/SPA 兜底同源分类）', () => {
  const { isApiPath } = require('../src/server/lib/api-path.js');
  assert.equal(isApiPath('/cover'), true);
  assert.equal(isApiPath('/cover/extra'), true);
});

// /bilibili/search|suggest|related 路由回归网——参数校验/限流分桶/行形归一
//（buildBilibiliSong 直喂形，与 /favlist 同口径 biliSearchRow）/音乐分区
// 白名单默认过滤（all=1 放行）/种曲剔除/错误分档（502 上游失败、429 限流、
// 499 断连静默）。lib/bilibili、rate-limit、netease-match 预播种 stub；
// 路由只留 HTTP 语义与组装逻辑可测（pinia 提取与上游字段归一在 lib 侧钉过）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { seed, getJson, seedMatchModule } from './helpers.mjs';

const require = createRequire(import.meta.url);

let rateImpl = () => true;
const rateBuckets = [];                    // 分桶录证 [bucket, n]
let searchImpl = async () => ({ items: [], seid: null, numResults: 0 });
let suggestImpl = async () => [];
let relatedImpl = async () => [];
const searchArgs = [];                     // biliSearchVideos 录参簿

seed('../src/server/lib/rate-limit.js', {
  rateLimit: (c, bucket, n) => { rateBuckets.push([bucket, n]); return rateImpl(c, bucket, n); },
});
// 音乐分区白名单语义与真实现同表（lib 侧 bilibili-search.test.mjs 已钉真集合；
// 路由钉的是「默认过滤/all=1 放行」的开关语义，不复刻集合本体）
const MUSIC_ZONE = new Set([28, 29, 30, 31, 59, 130, 193, 265, 266, 267]);
seed('../src/server/lib/bilibili.js', {
  biliFetch: async () => { throw new Error('unstubbed'); },
  resolveBiliLink: async () => null,
  pickStreamList: () => [], pickStreams: () => ({ audio: null, video: null }),
  pickPageParam: () => 1, pickCidFromView: () => null,
  flatUrls: () => [], viewQuery: (id) => `bvid=${id}`,
  hasBiliCookie: () => false, QN_HEIGHT: {},
  biliSearchVideos: (...a) => { searchArgs.push(a); return searchImpl(...a); },
  biliSuggest: (...a) => suggestImpl(...a),
  biliRelated: (...a) => relatedImpl(...a),
  musicZoneOf: (t) => MUSIC_ZONE.has(Number(t)),
});
// netease-match 同文件 /resolve、/favlist 链消费——播种防真模块拖 DB
seedMatchModule([], () => async () => ({ song: null, query: null }));
const app = require('../src/server/routes/bilibili.js');

// lib videoItemToRow 归一行（搜索桶产出形）——路由再经 biliSearchRow 转
// buildBilibiliSong 直喂形
const ROW = (over = {}) => ({
  bvid: 'BV1xx411c7XE',
  title: '青花瓷 官方MV',
  author: '杰威尔音乐',
  durationSec: 240,
  pic: 'https://i1.hdslb.com/x.jpg',
  typeid: 193,               // MV——音乐白名单内
  typename: 'MV',
  pubdate: 1193932800,       // → publishedAt 1193932800000
  ...over,
});

const reset = () => {
  rateImpl = () => true; rateBuckets.length = 0; searchArgs.length = 0;
  searchImpl = async () => ({ items: [], seid: null, numResults: 0 });
  suggestImpl = async () => [];
  relatedImpl = async () => [];
};

test('search：行形归一（buildBilibiliSong 直喂形）+ total 恒 null + signal 级联', async () => {
  reset();
  searchImpl = async () => ({ items: [ROW()], seid: 's1', numResults: 1000 });
  const { status, body } = await getJson(app, '/bilibili/search?q=' + encodeURIComponent('青花瓷'));
  assert.equal(status, 200);
  assert.equal(body.code, 200);
  // SSR 只有第 1 页可达——numResults 不透出，total 恒 null 灭深挖键
  assert.equal(body.total, null);
  const it = body.items[0];
  assert.equal(it.bvid, 'BV1xx411c7XE');
  assert.equal(it.cid, null, 'cid 由播放/下载链 view 自愈（收藏夹同口径）');
  assert.equal(it.page, 1);
  assert.equal(it.title, '青花瓷 官方MV');
  assert.equal(it.owner, '杰威尔音乐');
  assert.equal(it.cover, 'https://i1.hdslb.com/x.jpg');
  assert.equal(it.duration, 240);
  assert.equal(it.publishedAt, 1193932800000, 'pubdate unix 秒 → epoch ms');
  assert.equal(it.songName, '青花瓷 官方MV');
  assert.equal(it.hasVideo, true);
  assert.equal(it.hasDownloadableVideo, true);
  assert.equal(it.matched, null);
  assert.equal(it.matchedBy, null);
  assert.equal(it.matchScore, null);
  // signal 级联透传给 lib（客户端断连可掐上游）
  assert.ok(searchArgs[0][1].signal, 'extraSignal 透传');
  assert.equal(searchArgs[0][0], '青花瓷');
  // pubdate 缺席/脏值不产键（与 favlist 同口径——无字段不落 publishedAt）
  searchImpl = async () => ({ items: [ROW({ bvid: 'BV1xx411c7XF', pubdate: 0 })] });
  const r2 = await getJson(app, '/bilibili/search?q=x');
  assert.equal('publishedAt' in r2.body.items[0], false);
});

test('search：合法零视频词（lib 归空态）→ 200 空表不归 502', async () => {
  reset();
  // 上游 result[] 桶表合法但无 video 桶时 lib 归 {items:[]}——路由透出
  // 200 空表而非 502（空态是「没搜到」，漂移才是网关错）
  searchImpl = async () => ({ items: [], seid: 's0', numResults: 7 });
  const r = await getJson(app, '/bilibili/search?q=' + encodeURIComponent('零视频词'));
  assert.equal(r.status, 200);
  assert.equal(r.body.code, 200);
  assert.deepEqual(r.body.items, []);
  assert.equal(r.body.total, null);
});

test('search：音乐分区白名单默认过滤，all=1 放行全桶', async () => {
  reset();
  searchImpl = async () => ({
    items: [
      ROW({ bvid: 'BV1xx411c7XE', typeid: 130 }),                    // 音乐综合
      ROW({ bvid: 'BV1xx411c7XF', typeid: 243, title: '乐评视频' }), // 乐评——剔除
      ROW({ bvid: 'BV1xx411c7XG', typeid: 17, title: '游戏视频' }),  // 游戏——剔除
      ROW({ bvid: 'BV1xx411c7XH', typeid: 28 }),                     // 原创音乐
    ],
  });
  let r = await getJson(app, '/bilibili/search?q=x');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.items.map(i => i.bvid), ['BV1xx411c7XE', 'BV1xx411c7XH']);
  r = await getJson(app, '/bilibili/search?q=x&all=1');
  assert.equal(r.body.items.length, 4, 'all=1 放行全部分区桶');
  // all=0/其它值不放行
  r = await getJson(app, '/bilibili/search?q=x&all=0');
  assert.equal(r.body.items.length, 2);
});

test('search：q 校验/限流/502/499', async () => {
  reset();
  let r = await getJson(app, '/bilibili/search');
  assert.equal(r.status, 400);
  r = await getJson(app, '/bilibili/search?q=');
  assert.equal(r.status, 400);
  r = await getJson(app, '/bilibili/search?q=' + 'x'.repeat(201));
  assert.equal(r.status, 400);
  r = await getJson(app, '/bilibili/search?q=' + 'x'.repeat(200));
  assert.equal(r.status, 200, '200 字符边界放行');
  // pinia 岛解析失败/上游非 200 → 502 透出 message
  searchImpl = async () => { throw new Error('bilibili search 数据岛解析失败（pinia 缺席或形态漂移）'); };
  r = await getJson(app, '/bilibili/search?q=x');
  assert.equal(r.status, 502);
  assert.match(r.body.message, /B 站搜索失败.*数据岛解析失败/);
  // 在途断连 → 499 静默
  const ctrl = new AbortController();
  searchImpl = async () => { ctrl.abort(); return { items: [ROW()] }; };
  const res499 = await app.request(new Request('http://t/bilibili/search?q=x', { signal: ctrl.signal }));
  assert.equal(res499.status, 499);
  // 限流分桶 bili-search 20/min
  searchImpl = async () => ({ items: [] });
  rateImpl = () => false;
  r = await getJson(app, '/bilibili/search?q=x');
  assert.equal(r.status, 429);
  assert.ok(rateBuckets.some(([b, n]) => b === 'bili-search' && n === 20));
});

test('suggest：归一 {allMatch:[{keyword}]} + 校验/限流/502/499', async () => {
  reset();
  suggestImpl = async () => ['青花瓷', '青花瓷 粤语'];
  let r = await getJson(app, '/bilibili/suggest?term=' + encodeURIComponent('青花'));
  assert.equal(r.status, 200);
  assert.equal(r.body.code, 200);
  assert.deepEqual(r.body.result.allMatch, [{ keyword: '青花瓷' }, { keyword: '青花瓷 粤语' }]);
  suggestImpl = async () => [];
  r = await getJson(app, '/bilibili/suggest?term=x');
  assert.deepEqual(r.body.result.allMatch, []);
  r = await getJson(app, '/bilibili/suggest');
  assert.equal(r.status, 400);
  r = await getJson(app, '/bilibili/suggest?term=' + 'x'.repeat(101));
  assert.equal(r.status, 400);
  suggestImpl = async () => { throw new Error('bilibili /x/web-interface/suggest HTTP 503'); };
  r = await getJson(app, '/bilibili/suggest?term=x');
  assert.equal(r.status, 502);
  assert.match(r.body.message, /B 站搜索建议失败/);
  const ctrl = new AbortController();
  suggestImpl = async () => { ctrl.abort(); return ['x']; };
  const res499 = await app.request(new Request('http://t/bilibili/suggest?term=x', { signal: ctrl.signal }));
  assert.equal(res499.status, 499);
  suggestImpl = async () => [];
  rateImpl = () => false;
  r = await getJson(app, '/bilibili/suggest?term=x');
  assert.equal(r.status, 429);
  assert.ok(rateBuckets.some(([b, n]) => b === 'bili-suggest' && n === 30));
});

test('related：bvid 校验/行形/种曲剔除/限流/502/499', async () => {
  reset();
  let r = await getJson(app, '/bilibili/related');
  assert.equal(r.status, 400);
  r = await getJson(app, '/bilibili/related?bvid=abc');
  assert.equal(r.status, 400);
  r = await getJson(app, '/bilibili/related?bvid=' + 'BV1xx411c7XE!'); // 尾缀脏字符
  assert.equal(r.status, 400);
  relatedImpl = async () => [
    ROW({ bvid: 'BV1xx411c7XJ', title: '相关一' }),
    ROW({ bvid: 'BV1XX411C7XE' }), // 种曲大小写异形——按 lower 比对剔除
    ROW({ bvid: 'BV1xx411c7XK', title: '相关二' }),
  ];
  r = await getJson(app, '/bilibili/related?bvid=BV1xx411c7XE');
  assert.equal(r.status, 200);
  assert.equal(r.body.code, 200);
  assert.equal(r.body.items.length, 2, '种曲剔除防相关面板自环');
  assert.ok(!r.body.items.some(i => i.bvid.toLowerCase() === 'bv1xx411c7xe'));
  assert.equal(r.body.items[0].bvid, 'BV1xx411c7XJ');
  assert.equal(r.body.items[0].hasVideo, true);
  relatedImpl = async () => [];
  r = await getJson(app, '/bilibili/related?bvid=BV1xx411c7XE');
  assert.deepEqual(r.body.items, []);
  relatedImpl = async () => { throw new Error('bilibili /x/web-interface/archive/related code=-404'); };
  r = await getJson(app, '/bilibili/related?bvid=BV1xx411c7XE');
  assert.equal(r.status, 502);
  assert.match(r.body.message, /B 站相关获取失败/);
  const ctrl = new AbortController();
  relatedImpl = async () => { ctrl.abort(); return [ROW()]; };
  const res499 = await app.request(new Request('http://t/bilibili/related?bvid=BV1xx411c7XE', { signal: ctrl.signal }));
  assert.equal(res499.status, 499);
  relatedImpl = async () => [];
  rateImpl = () => false;
  r = await getJson(app, '/bilibili/related?bvid=BV1xx411c7XE');
  assert.equal(r.status, 429);
  assert.ok(rateBuckets.some(([b, n]) => b === 'bili-related' && n === 30));
});

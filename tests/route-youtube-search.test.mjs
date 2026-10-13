// /youtube/search|related|suggest 路由回归网——参数校验/限流分桶/
// 行形归一（buildYouTubeSong 直喂形，与 /resolve 同口径 extractYtSong 剥洗）/
// continuation 不透明透传/种子稿剔除/错误分档（502 上游失败、429 限流、
// 499 断连静默）。lib/youtube、rate-limit、netease-match 预播种 stub；
// 路由只留 HTTP 语义与组装逻辑可测
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { seed, getJson, seedMatchModule } from './helpers.mjs';

const require = createRequire(import.meta.url);

let rateImpl = () => true;
const rateBuckets = [];                    // 分桶录证 [bucket, n]
let searchImpl = async () => ({ items: [], continuation: null });
let nextImpl = async () => ({ items: [], mixPlaylistId: null });
let suggestImpl = async () => ({ suggestions: [] });
const searchArgs = [];                     // innertubeSearch 录参簿

seed('../src/server/lib/rate-limit.js', {
  rateLimit: (c, bucket, n) => { rateBuckets.push([bucket, n]); return rateImpl(c, bucket, n); },
});
seed('../src/server/lib/youtube.js', {
  fetchPlayer: async () => ({}),
  fetchPlayerWith: async () => ({}),
  pickStreamList: () => [],
  fetchYtPlaylistPage: async () => { throw new Error('unstubbed'); },
  innertubeSearch: (...a) => { searchArgs.push(a); return searchImpl(...a); },
  fetchWatchNext: (...a) => nextImpl(...a),
  ytSuggest: (...a) => suggestImpl(...a),
});
// netease-match 同文件 /resolve 链消费——播种防真模块拖 DB（新三路不消费它）
seedMatchModule([], () => async () => ({ song: null, query: null }));
const app = require('../src/server/routes/youtube.js');

// buildYouTubeSong 直喂形行料——search/next 共用 ytSearchRow 剥洗
const ROW = (over = {}) => ({
  videoId: 'abcdefghijk',
  title: '歌手 - 曲名 (Official Video)',
  owner: '歌手 - Topic',
  durationSec: 200,
  channelId: 'UCxxxxxxxxxxxxxxxxxxxxxx',
  publishedTimeText: '3 年前',
  ...over,
});

const reset = () => {
  rateImpl = () => true; rateBuckets.length = 0; searchArgs.length = 0;
  searchImpl = async () => ({ items: [], continuation: null });
  nextImpl = async () => ({ items: [], mixPlaylistId: null });
  suggestImpl = async () => ({ suggestions: [] });
};

test('search：行形归一（buildYouTubeSong 直喂形）+ continuation 回传', async () => {
  reset();
  searchImpl = async () => ({ items: [ROW()], continuation: 'tok-1' });
  const { status, body } = await getJson(app, '/youtube/search?q=' + encodeURIComponent('曲名'));
  assert.equal(status, 200);
  assert.equal(body.code, 200);
  assert.equal(body.continuation, 'tok-1');
  const it = body.items[0];
  assert.equal(it.videoId, 'abcdefghijk');
  assert.equal(it.title, '歌手 - 曲名 (Official Video)');
  assert.equal(it.author, '歌手 - Topic');
  assert.equal(it.authorClean, '歌手', "' - Topic' 尾剥");
  assert.equal(it.duration, 200);
  assert.equal(it.cover, 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg');
  assert.equal(it.songName, '曲名', '括号修饰剥洗后歌名');
  assert.equal(it.matched, null);
  assert.equal(it.publishedAt, null, '相对时间文本不解析成日期');
  assert.equal(it.hasVideo, true);
  assert.equal(it.hasDownloadableVideo, true);
  assert.equal(it.channelId, 'UCxxxxxxxxxxxxxxxxxxxxxx');
  assert.equal(it.publishedTimeText, '3 年前');
  // 条件键缺席不落——上游没给的字段不凭空生键
  searchImpl = async () => ({ items: [{ videoId: 'bcdefghijkl', title: 'T', owner: 'O', durationSec: 30 }], continuation: null });
  const r2 = await getJson(app, '/youtube/search?q=x');
  assert.equal('channelId' in r2.body.items[0], false);
  assert.equal('publishedTimeText' in r2.body.items[0], false);
});

test('search：q 校验/limit 钳位/continuation 不透明透传/限流/502/499', async () => {
  reset();
  let r = await getJson(app, '/youtube/search');
  assert.equal(r.status, 400);
  r = await getJson(app, '/youtube/search?q=');
  assert.equal(r.status, 400);
  r = await getJson(app, '/youtube/search?q=' + 'x'.repeat(201));
  assert.equal(r.status, 400);
  // limit 钳 5–30 默认 20；continuation 不校验格式原样进 lib
  await getJson(app, '/youtube/search?q=x&limit=99&continuation=' + encodeURIComponent('tok?weird&='));
  assert.deepEqual(searchArgs[0][1].limit, 30);
  assert.equal(searchArgs[0][1].continuation, 'tok?weird&=');
  await getJson(app, '/youtube/search?q=x&limit=1');
  assert.equal(searchArgs[1][1].limit, 5);
  await getJson(app, '/youtube/search?q=x');
  assert.equal(searchArgs[2][1].limit, 20, '缺省 20');
  assert.equal(searchArgs[2][1].continuation, null);
  // 空结果——{items:[],continuation:null}
  r = await getJson(app, '/youtube/search?q=zzz');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.items, []);
  assert.equal(r.body.continuation, null);
  // 上游全灭/凭据墙 → 502 透出 message
  searchImpl = async () => { throw new Error('innertube search HTTP 500'); };
  r = await getJson(app, '/youtube/search?q=x');
  assert.equal(r.status, 502);
  assert.match(r.body.message, /YouTube 搜索失败/);
  // 在途断连 → 499 静默（桩内 abort 复现客户端断连）
  const ctrl = new AbortController();
  searchImpl = async () => { ctrl.abort(); return { items: [ROW()], continuation: null }; };
  const res499 = await app.request(new Request('http://t/youtube/search?q=x', { signal: ctrl.signal }));
  assert.equal(res499.status, 499);
  // 限流分桶 yt-search 20/min
  searchImpl = async () => ({ items: [], continuation: null });
  rateImpl = () => false;
  r = await getJson(app, '/youtube/search?q=x');
  assert.equal(r.status, 429);
  assert.ok(rateBuckets.some(([b, n]) => b === 'yt-search' && n === 20));
});

test('related：v 校验/行形/种子剔除/mixPlaylistId/限流/502/499', async () => {
  reset();
  let r = await getJson(app, '/youtube/related?v=abc');           // 短 id
  assert.equal(r.status, 400);
  r = await getJson(app, '/youtube/related?v=' + 'a'.repeat(12)); // 长度错
  assert.equal(r.status, 400);
  r = await getJson(app, '/youtube/related?v=abc!defghij');
  assert.equal(r.status, 400);
  r = await getJson(app, '/youtube/related');
  assert.equal(r.status, 400);
  nextImpl = async () => ({
    items: [ROW(), ROW({ videoId: 'seedseedsee' }), ROW({ videoId: 'bcdefghijkl', title: 'T2', owner: 'O2', durationSec: 30 })],
    mixPlaylistId: 'RDmix1234567',
  });
  r = await getJson(app, '/youtube/related?v=seedseedsee');
  assert.equal(r.status, 200);
  assert.equal(r.body.code, 200);
  assert.equal(r.body.mixPlaylistId, 'RDmix1234567');
  assert.equal(r.body.items.length, 2, '种子稿自身剔除防相关面板自环');
  assert.ok(!r.body.items.some(i => i.videoId === 'seedseedsee'));
  assert.equal(r.body.items[0].cover, 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg');
  nextImpl = async () => ({ items: [], mixPlaylistId: null });
  r = await getJson(app, '/youtube/related?v=seedseedsee');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.items, []);
  assert.equal(r.body.mixPlaylistId, null);
  nextImpl = async () => { throw new Error('watch next 空壳响应'); };
  r = await getJson(app, '/youtube/related?v=seedseedsee');
  assert.equal(r.status, 502);
  const ctrl = new AbortController();
  nextImpl = async () => { ctrl.abort(); return { items: [ROW()], mixPlaylistId: null }; };
  const res499 = await app.request(new Request('http://t/youtube/related?v=seedseedsee', { signal: ctrl.signal }));
  assert.equal(res499.status, 499);
  rateImpl = () => false;
  r = await getJson(app, '/youtube/related?v=seedseedsee');
  assert.equal(r.status, 429);
  assert.ok(rateBuckets.some(([b, n]) => b === 'yt-related' && n === 30));
});

test('suggest：归一 {allMatch:[{keyword}]} + 校验/限流/502/499', async () => {
  reset();
  suggestImpl = async () => ({ suggestions: ['青花瓷', '青花瓷 粤语'] });
  let r = await getJson(app, '/youtube/suggest?q=' + encodeURIComponent('青花'));
  assert.equal(r.status, 200);
  assert.equal(r.body.code, 200);
  assert.deepEqual(r.body.result.allMatch, [{ keyword: '青花瓷' }, { keyword: '青花瓷 粤语' }]);
  suggestImpl = async () => ({ suggestions: [] });
  r = await getJson(app, '/youtube/suggest?q=x');
  assert.deepEqual(r.body.result.allMatch, []);
  r = await getJson(app, '/youtube/suggest');
  assert.equal(r.status, 400);
  r = await getJson(app, '/youtube/suggest?q=' + 'x'.repeat(201));
  assert.equal(r.status, 400);
  suggestImpl = async () => { throw new Error('yt suggest HTTP 503'); };
  r = await getJson(app, '/youtube/suggest?q=x');
  assert.equal(r.status, 502);
  const ctrl = new AbortController();
  suggestImpl = async () => { ctrl.abort(); return { suggestions: ['x'] }; };
  const res499 = await app.request(new Request('http://t/youtube/suggest?q=x', { signal: ctrl.signal }));
  assert.equal(res499.status, 499);
  rateImpl = () => false;
  r = await getJson(app, '/youtube/suggest?q=x');
  assert.equal(r.status, 429);
  assert.ok(rateBuckets.some(([b, n]) => b === 'yt-suggest' && n === 30));
});

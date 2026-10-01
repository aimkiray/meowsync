// /youtube/playlist 路由回归网——continuation 翻页/失效过滤/预算制匹配/
// 见底语义/错误分档/resolve 歌单重定向。lib/youtube（Innertube 原语）、
// netease-match、rate-limit 预播种 stub；路由只留 HTTP 语义与组装逻辑可测
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let pageScript = {};   // 'first'→首页夹具 | '<token>'→续页夹具（值可 Error）
let pageCalls = 0;
let lastListId = null; // stub 透传观测——VL 双前缀缺陷钉（不带 i 的 VL 前缀须原样下传）
const matchCalls = [];
let matchImpl = async () => ({ song: null, query: null });
let rateImpl = () => true;

const seed = (path, exports) => {
  const p = require.resolve(path);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
seed('../src/server/lib/rate-limit.js', { rateLimit: (...a) => rateImpl(...a) });
seed('../src/server/lib/youtube.js', {
  fetchYtPlaylistPage: async ({ listId, continuation }) => {
    pageCalls++;
    lastListId = listId;
    const v = continuation ? pageScript[continuation] : pageScript.first;
    if (v instanceof Error) throw v;
    if (!v) throw new Error(`unstubbed page continuation=${continuation}`);
    return { title: '', owner: '', cover: '', mediaCount: null, items: [], skipped: 0, continuation: null, ...v };
  },
  fetchPlayer: async () => ({}), fetchPlayerWith: async () => ({}),
  pickStreamList: () => [],
});
seed('../src/server/services/netease-match.js', {
  matchNeteaseSong: (...args) => { matchCalls.push(args); return matchImpl(...args); },
});
const app = require('../src/server/routes/youtube.js');

const item = (i, over = {}) => ({
  videoId: `vid${String(i).padStart(8, '0')}`, title: `歌${i}`,
  owner: `频道${i}`, durationSec: 200 + i, ...over
});
const reset = () => {
  pageScript = {}; pageCalls = 0; rateImpl = () => true;
  matchCalls.length = 0; matchImpl = async () => ({ song: null, query: null });
};
const getJson = async (path) => {
  const res = await app.request(`http://t${path}`);
  return { status: res.status, body: await res.json().catch(() => null) };
};

test('continuation 翻页 + 失效过滤 + 曲目归一', async () => {
  reset();
  pageScript = {
    first: {
      title: '测试歌单', owner: '单主', cover: 'https://i.ytimg.com/x.jpg', mediaCount: 25,
      items: [item(1), item(2)], skipped: 1, continuation: 'tok1',
    },
    tok1: { items: [item(3)], skipped: 0, continuation: null },
  };
  const { status, body } = await getJson('/youtube/playlist?input=' +
    encodeURIComponent('https://www.youtube.com/playlist?list=PLabcdefghijklmnop'));
  assert.equal(status, 200);
  assert.equal(body.listId, 'PLabcdefghijklmnop');
  assert.equal(body.name, '测试歌单');
  assert.equal(body.creator, '单主');
  assert.equal(body.mediaCount, 25);
  assert.equal(body.tracks.length, 3);
  assert.equal(body.skipped, 1);
  assert.equal(body.truncated, false);
  assert.equal(pageCalls, 2, '应消费 continuation 翻页');
  const t0 = body.tracks[0];
  assert.equal(t0.videoId, 'vid00000001');
  assert.equal(t0.author, '频道1');
  assert.equal(t0.authorClean, '频道1');
  assert.equal(t0.hasVideo, true);
  assert.equal(t0.cover, 'https://i.ytimg.com/vi/vid00000001/hqdefault.jpg');
  assert.equal(t0.matched, null);
  assert.equal(t0.candidates, undefined, '内部匹配字段不下发');
  assert.equal(t0.songName, '歌1', 'extractYtSong 清洗结果透出');
});

test('词源匹配并发池：命中的曲目带 matched/matchedBy，未中不阻塞', async () => {
  reset();
  pageScript = { first: { items: [item(1), item(2), item(3)] } };
  matchImpl = async (candidates, dur, tag, signal, src) => {
    assert.equal(tag, 'youtube-pl');
    return src.title === '歌2'
      ? { song: { id: 888, name: 'Hit', ar: [{ name: '歌手' }], al: {} }, query: '歌2' }
      : { song: null, query: null };
  };
  const { status, body } = await getJson('/youtube/playlist?input=PLabcdefghijklmnop');
  assert.equal(status, 200);
  assert.equal(matchCalls.length, 3);
  assert.equal(body.matchedCount, 1);
  assert.equal(body.tracks[1].matched.id, 888);
  assert.equal(body.tracks[1].matchedBy, '歌2', 'matchedBy 透出（与 favlist 断言同口径）');
  assert.equal(body.tracks[0].matched, null);
});

test('错误分档：ERROR alert/HTTP 4xx → 404；其它 → 502；空响应 → 404', async () => {
  reset();
  const alertErr = Object.assign(new Error('播放列表不可用: The playlist does not exist'), { upstreamCode: 'ALERT_ERROR' });
  pageScript = { first: alertErr };
  let r = await getJson('/youtube/playlist?input=PLabcdefghijklmnop');
  assert.equal(r.status, 404);
  pageScript = { first: new Error('innertube browse HTTP 400') };
  r = await getJson('/youtube/playlist?input=PLabcdefghijklmnop');
  assert.equal(r.status, 404);
  pageScript = { first: new Error('innertube browse HTTP 500') };
  r = await getJson('/youtube/playlist?input=PLabcdefghijklmnop');
  assert.equal(r.status, 502);
  assert.match(r.body.message, /歌单获取失败/);
  pageScript = { first: { items: [] } };
  r = await getJson('/youtube/playlist?input=PLabcdefghijklmnop');
  assert.equal(r.status, 404);
});

test('入参兜底与限流：裸 id/list 参数/无法解析 400/429', async () => {
  reset();
  pageScript = { first: { title: 'T', items: [item(1)] } };
  let r = await getJson('/youtube/playlist?input=' +
    encodeURIComponent('https://music.youtube.com/playlist?list=OLAK5uy_abcdefghijk'));
  assert.equal(r.status, 200);
  assert.equal(r.body.listId, 'OLAK5uy_abcdefghijk');
  // watch?v=&list= 复合链——歌单语境优先（resolve 同口径重定向）
  r = await getJson('/youtube/playlist?input=' +
    encodeURIComponent('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLw0xabcdefghi'));
  assert.equal(r.body.listId, 'PLw0xabcdefghi');
  // 裸未知前缀 id 兜底（VL 写法直传——listId 原样进 lib，双前缀防回归）
  r = await getJson('/youtube/playlist?input=VLPLw0xabcdefghi');
  assert.equal(r.body.listId, 'VLPLw0xabcdefghi');
  assert.equal(lastListId, 'VLPLw0xabcdefghi');
  // ?list= 查询通道（resolve 回喂只用 input，这里直接打 list 参数）
  r = await getJson('/youtube/playlist?list=PLabcdefghijklmnop');
  assert.equal(r.status, 200);
  assert.equal(r.body.listId, 'PLabcdefghijklmnop');
  // 短裸 token（<13 位）按垃圾拒——真实 listId 全 ≥13，不白打上游一跳
  r = await getJson('/youtube/playlist?input=abcdefghij');
  assert.equal(r.status, 400);
  r = await getJson('/youtube/playlist?input=hello world');
  assert.equal(r.status, 400);
  rateImpl = () => false;
  r = await getJson('/youtube/playlist?input=PLabcdefghijklmnop');
  assert.equal(r.status, 429);
});

test('匹配抛错/续页翻车不毁导入：部分结果按截断返回', async () => {
  reset();
  matchImpl = async () => { throw new Error('match boom'); };
  pageScript = { first: { title: 'T', items: [item(1), item(2)] } };
  let r = await getJson('/youtube/playlist?input=PLabcdefghijklmnop');
  assert.equal(r.status, 200);
  assert.equal(r.body.tracks.length, 2);
  assert.equal(r.body.matchedCount, 0);
  // 续页翻车：首页 2 条保住，truncated
  pageScript = {
    first: { title: 'T', items: [item(1), item(2)], continuation: 'tok1' },
    tok1: new Error('innertube browse HTTP 503'),
  };
  r = await getJson('/youtube/playlist?input=PLabcdefghijklmnop');
  assert.equal(r.status, 200);
  assert.equal(r.body.tracks.length, 2);
  assert.equal(r.body.truncated, true);
});

test('截断语义：续页不断供则 truncated；续页耗尽见底不标', async () => {
  reset();
  // 每页 100 条且 continuation 不断——扫满 200 上限时上游仍有货
  pageScript = {
    first: { title: 'T', mediaCount: 500, items: Array.from({ length: 100 }, (_, i) => item(i)), continuation: 'tok1' },
    tok1: { items: Array.from({ length: 100 }, (_, i) => item(100 + i)), continuation: 'tok2' },
  };
  let r = await getJson('/youtube/playlist?input=PLbigbigbigxx');
  assert.equal(r.body.tracks.length, 200);
  assert.equal(r.body.truncated, true);
  // 续页耗尽（continuation=null）见底——200 条全有效也不标截断
  pageScript = {
    first: { title: 'T', items: Array.from({ length: 100 }, (_, i) => item(i)), continuation: 'tok1' },
    tok1: { items: Array.from({ length: 100 }, (_, i) => item(100 + i)) },
  };
  r = await getJson('/youtube/playlist?input=PLbigbigbigxx');
  assert.equal(r.body.tracks.length, 200);
  assert.equal(r.body.truncated, false);
  // 跨页重复 videoId 去重（上游漂移防御）
  pageScript = {
    first: { title: 'T', items: [item(1), item(2)], continuation: 'tok1' },
    tok1: { items: [item(2), item(3)] },
  };
  r = await getJson('/youtube/playlist?input=PLbigbigbigxx');
  assert.equal(r.body.tracks.length, 3);
});

test('页数上限：8 页扫满而上游仍有货 → truncated', async () => {
  reset();
  pageScript = { first: { title: 'T', items: Array.from({ length: 10 }, (_, i) => item(i)), continuation: 'tok1' } };
  for (let p = 1; p <= 7; p++) {
    pageScript[`tok${p}`] = { items: Array.from({ length: 10 }, (_, i) => item(p * 10 + i)), continuation: `tok${p + 1}` };
  }
  const r = await getJson('/youtube/playlist?input=PLbigbigbigxx');
  assert.equal(r.status, 200);
  assert.equal(r.body.tracks.length, 80);
  assert.equal(pageCalls, 8, '第 9 页不再请求');
  assert.equal(r.body.truncated, true, '页上限扫满非见底');
});

test('resolve 遇歌单链 → 400 带 playlist 字段（前端自动转歌单导入）', async () => {
  reset();
  let { status, body } = await getJson('/youtube/resolve?input=' +
    encodeURIComponent('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLredirect'));
  assert.equal(status, 400);
  assert.equal(body.playlist, 'PLredirect');
  // 纯视频链不受影响——走 video 分支正常返回（未被歌单判定劫持）
  ({ status, body } = await getJson('/youtube/resolve?input=' +
    encodeURIComponent('https://youtu.be/dQw4w9WgXcQ')));
  assert.equal(status, 200);
  assert.equal(body.videoId, 'dQw4w9WgXcQ');
  assert.equal(body.playlist, undefined);
});

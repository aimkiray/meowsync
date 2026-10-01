// /bilibili/favlist 路由回归网——翻页拉全/失效过滤/预算制匹配/resolve 收藏夹重定向。
// lib/bilibili（上游原语）与 netease-match（云搜+AI）预播种 stub；路由只留
// HTTP 语义与组装逻辑可测
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let biliScript = {};              // path 片段 → data | Error
let biliCalls = [];
let linkResult = null;            // resolveBiliLink 返回值覆写
const matchCalls = [];
let matchImpl = async () => ({ song: null, query: null });

const seed = (path, exports) => {
  const p = require.resolve(path);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
// 轻量版 resolveBiliLink：直接命中形态复用共享谓词，不模拟 b23 跳解
const { extractBiliFavlistId } = require('../src/shared/predicates.js');
seed('../src/server/lib/bilibili.js', {
  biliFetch: async (path) => {
    biliCalls.push(path);
    for (const [frag, v] of Object.entries(biliScript)) {
      if (path.includes(frag)) {
        if (v instanceof Error) throw v;
        return v;
      }
    }
    throw new Error(`unstubbed ${path}`);
  },
  resolveBiliLink: async (input) => {
    if (linkResult) return linkResult;
    const s = String(input || '');
    const fid = extractBiliFavlistId(s);
    if (fid) return { kind: 'favlist', fid };
    const bv = s.match(/BV1[0-9A-Za-z]{9}/i);
    return bv ? { kind: 'video', id: bv[0] } : null;
  },
  // 单曲 resolve/stream 路径的解构面占位（本文件不测它们）
  pickStreamList: () => [], pickStreams: () => ({ audio: null, video: null }),
  pickPageParam: () => 1, pickCidFromView: () => null,
  viewQuery: (id) => `bvid=${id}`, parseBvid: async () => null,
  BILI_COOKIE: false, QN_HEIGHT: {},
});
seed('../src/server/services/netease-match.js', {
  matchNeteaseSong: (...args) => { matchCalls.push(args); return matchImpl(...args); },
});
const app = require('../src/server/routes/bilibili.js');

const media = (i, over = {}) => ({
  type: 2, bvid: `BV1xx411c7${String(i).padStart(2, '0')}`, title: `歌${i}`,
  cover: `https://i0.hdslb.com/c${i}.jpg`, duration: 200 + i, page: 1,
  upper: { mid: i, name: `UP${i}` }, ...over
});
const favPage = (medias, count) => ({
  info: { title: '测试收藏夹', upper: { name: '夹主' }, media_count: count, cover: 'https://i0.hdslb.com/fav.jpg' },
  medias,
});
const reset = () => {
  biliScript = {}; biliCalls = []; linkResult = null;
  matchCalls.length = 0; matchImpl = async () => ({ song: null, query: null });
};
const getJson = async (path) => {
  const res = await app.request(`http://t${path}`);
  return { status: res.status, body: await res.json() };
};

test('翻页拉全 + 失效/非视频过滤 + 曲目归一', async () => {
  reset();
  // pn=1 满 20 条才继续翻（medias.length<ps 即尾页）；过滤掉 2 条
  biliScript = {
    'pn=1': favPage([
      ...Array.from({ length: 18 }, (_, i) => media(100 + i)),
      { type: 24, title: '合集条目' },
      { type: 2, title: '已失效视频' },
    ], 21),
    'pn=2': favPage([media(3)], 21),
  };
  const { status, body } = await getJson('/bilibili/favlist?input=space.bilibili.com/2/favlist?fid=9');
  assert.equal(status, 200);
  assert.equal(body.name, '测试收藏夹');
  assert.equal(body.creator, '夹主');
  assert.equal(body.fid, '9');
  assert.equal(body.tracks.length, 19);
  assert.equal(body.skipped, 2);
  assert.ok(biliCalls.some(p => p.includes('pn=2')), '应翻到第 2 页');
  const t0 = body.tracks[0];
  assert.equal(t0.bvid, 'BV1xx411c7100');
  assert.equal(t0.owner, 'UP100');
  assert.equal(t0.page, 1);
  assert.equal(t0.pageCount, 1);
  assert.equal(t0.hasVideo, true);
  assert.equal(t0.cid, null);              // cid 留空——流链自愈
  assert.equal(t0.matched, null);
});

test('词源匹配并发池：命中的曲目带 matched/matchedBy，未中不阻塞', async () => {
  reset();
  biliScript = { 'resource/list': favPage([media(1), media(2), media(3)], 3) };
  matchImpl = async (candidates, dur, tag, signal, src) => {
    assert.equal(tag, 'bilibili-fav');
    return src.title === '歌2'
      ? { song: { id: 777, name: 'Hit', ar: [{ name: '歌手' }], al: { id: 1 } }, query: '歌2' }
      : { song: null, query: null };
  };
  const { status, body } = await getJson('/bilibili/favlist?input=ml123456');
  assert.equal(status, 200);
  assert.equal(matchCalls.length, 3);
  assert.equal(body.matchedCount, 1);
  assert.equal(body.tracks[1].matched.id, 777);
  assert.equal(body.tracks[1].matchedBy, '歌2');
  assert.equal(body.tracks[0].matched, null);
});

test('上游拒绝（私有夹/风控）→ 502 透出消息；info 缺省 → 404', async () => {
  reset();
  biliScript = { 'resource/list': new Error('bilibili /x/v3/fav/resource/list code=-400 请求错误') };
  let r = await getJson('/bilibili/favlist?input=ml999');
  assert.equal(r.status, 502);
  assert.match(r.body.message, /收藏夹获取失败/);
  biliScript = { 'resource/list': { medias: [] } };
  r = await getJson('/bilibili/favlist?input=ml999');
  assert.equal(r.status, 404);
});

test('resolve 遇收藏夹链 → 400 带 favlist 字段（前端自动转歌单导入）', async () => {
  reset();
  const { status, body } = await getJson('/bilibili/resolve?input=space.bilibili.com/2/favlist?fid=55');
  assert.equal(status, 400);
  assert.equal(body.favlist, '55');
});

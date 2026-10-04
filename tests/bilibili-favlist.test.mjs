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

// seed/getJson 公共脚手架在 tests/helpers.mjs
import { seed, getJson, seedMatchModule } from './helpers.mjs';

// 限流桶按源 IP 计数（合成请求全是 'local'）——用例数会超 6/min 配额，
// 预播种可控 stub；429 用例通过 rateImpl 翻转
let rateImpl = () => true;
seed('../src/server/lib/rate-limit.js', { rateLimit: (...a) => rateImpl(...a) });
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
  hasBiliCookie: () => false, QN_HEIGHT: {},
});
seedMatchModule(matchCalls, () => matchImpl);
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
  biliScript = {}; biliCalls = []; linkResult = null; rateImpl = () => true;
  matchCalls.length = 0; matchImpl = async () => ({ song: null, query: null });
};
test('翻页拉全 + 失效/非视频过滤 + 曲目归一', async () => {
  reset();
  // pn=1 满 20 条才继续翻（medias.length<ps 即尾页）；过滤掉 3 条
  // （type≠2 / 标题哨兵 / attr=9 UP自删 三种失效形态各一）
  biliScript = {
    'pn=1': favPage([
      ...Array.from({ length: 17 }, (_, i) => media(100 + i)),
      { type: 24, title: '合集条目' },
      { type: 2, bvid: 'BV1xx411c7xX', title: '已失效视频' },
      { type: 2, bvid: 'BV1xx411c7yY', title: '保留原标题的失效', attr: 9 },
    ], 21),
    'pn=2': favPage([media(3)], 21),
  };
  const { status, body } = await getJson(app, '/bilibili/favlist?input=space.bilibili.com/2/favlist?fid=9');
  assert.equal(status, 200);
  assert.equal(body.name, '测试收藏夹');
  assert.equal(body.creator, '夹主');
  assert.equal(body.fid, '9');
  assert.equal(body.tracks.length, 18);
  assert.equal(body.skipped, 3);
  assert.equal(body.truncated, false);       // 扫到尾不标截断
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
  const { status, body } = await getJson(app, '/bilibili/favlist?input=ml123456');
  assert.equal(status, 200);
  assert.equal(matchCalls.length, 3);
  assert.equal(body.matchedCount, 1);
  assert.equal(body.tracks[1].matched.id, 777);
  assert.equal(body.tracks[1].matchedBy, '歌2');
  assert.equal(body.tracks[0].matched, null);
});

test('上游错误分档：私有夹 -400 → 404；风控 -352 → 502；info 缺省 → 404', async () => {
  reset();
  // 私有/不存在夹的上游业务码对用户是「不可访问」——映射 404
  biliScript = { 'resource/list': new Error('bilibili /x/v3/fav/resource/list code=-400 请求错误') };
  let r = await getJson(app, '/bilibili/favlist?input=ml999999');
  assert.equal(r.status, 404);
  // 风控等其它上游故障仍 502 透出
  biliScript = { 'resource/list': new Error('bilibili /x/v3/fav/resource/list code=-352 风控校验失败') };
  r = await getJson(app, '/bilibili/favlist?input=ml999999');
  assert.equal(r.status, 502);
  assert.match(r.body.message, /收藏夹获取失败/);
  // code=0 但无 info 的异常形态 → 404
  biliScript = { 'resource/list': { medias: [] } };
  r = await getJson(app, '/bilibili/favlist?input=ml999999');
  assert.equal(r.status, 404);
});

test('裸 fid/裸 mlN 兜底可达；无法解析 → 400；限流 → 429', async () => {
  reset();
  biliScript = { 'resource/list': favPage([media(1)], 1) };
  // resolve 重定向回喂闭环的承重路径：结构化 fid 以裸数字回传
  let r = await getJson(app, '/bilibili/favlist?input=88');
  assert.equal(r.status, 200);
  assert.equal(r.body.fid, '88');
  r = await getJson(app, '/bilibili/favlist?fid=77');
  assert.equal(r.status, 200);
  assert.equal(r.body.fid, '77');
  r = await getJson(app, '/bilibili/favlist?input=ml654321');
  assert.equal(r.status, 200);
  assert.equal(r.body.fid, '654321');
  r = await getJson(app, '/bilibili/favlist?input=hello');
  assert.equal(r.status, 400);
  rateImpl = () => false;
  r = await getJson(app, '/bilibili/favlist?input=ml654321');
  assert.equal(r.status, 429);
});

test('匹配抛错/中途翻车不毁导入：部分结果按截断返回', async () => {
  reset();
  matchImpl = async () => { throw new Error('match boom'); };
  biliScript = { 'resource/list': favPage([media(1), media(2)], 2) };
  let r = await getJson(app, '/bilibili/favlist?input=ml777777');
  assert.equal(r.status, 200);
  assert.equal(r.body.tracks.length, 2);
  assert.equal(r.body.matchedCount, 0);
  // 第 3 页翻车：已扫到的 40 条保住，按截断返回而非整单 502
  // （pn=2 必须满页——短页会被 has_more 缺省推断判成见底不再翻）
  biliScript = {
    'pn=1&': favPage(Array.from({ length: 20 }, (_, i) => media(i)), 60),
    'pn=2&': favPage(Array.from({ length: 20 }, (_, i) => media(40 + i)), 60),
    'pn=3&': new Error('bilibili /x/v3/fav/resource/list code=-352'),
  };
  r = await getJson(app, '/bilibili/favlist?input=ml777777');
  assert.equal(r.status, 200);
  assert.equal(r.body.tracks.length, 40);
  assert.equal(r.body.truncated, true);
});

test('截断语义：上限按扫描位计——失效项挤占后余量未扫仍标 truncated', async () => {
  reset();
  // 每页 15 有效 + 5 失效，media_count=300：扫满 10 页后 tracks 只有
  // 150 条，但还有 100 条没扫到——truncated 必须为 true（计数法漏报点）
  biliScript = {
    'resource/list': favPage([
      ...Array.from({ length: 15 }, (_, i) => media(i)),
      ...Array.from({ length: 5 }, (_, i) => ({ type: 2, bvid: `BV1xx411c7z${i}`, title: '已失效视频' })),
    ], 300),
  };
  let r = await getJson(app, '/bilibili/favlist?input=ml888888');
  assert.equal(r.body.tracks.length, 150);
  assert.equal(r.body.skipped, 50);
  assert.equal(r.body.truncated, true);
  // 恰好 200 条全有效：扫到尾 exhausted → 不标截断（反向误报钉死）
  biliScript = { 'resource/list': favPage(Array.from({ length: 20 }, (_, i) => media(i)), 200) };
  r = await getJson(app, '/bilibili/favlist?input=ml888888');
  assert.equal(r.body.tracks.length, 200);
  assert.equal(r.body.truncated, false);
  // 超 200 全有效：第 10 页扫满上限且上游还有货 → 截断
  biliScript = { 'resource/list': favPage(Array.from({ length: 20 }, (_, i) => media(i)), 500) };
  r = await getJson(app, '/bilibili/favlist?input=ml888888');
  assert.equal(r.body.tracks.length, 200);
  assert.equal(r.body.truncated, true);
});

test('resolve 遇收藏夹链 → 400 带 favlist 字段（前端自动转歌单导入）', async () => {
  reset();
  const { status, body } = await getJson(app, '/bilibili/resolve?input=space.bilibili.com/2/favlist?fid=55');
  assert.equal(status, 400);
  assert.equal(body.favlist, '55');
});

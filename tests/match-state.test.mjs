// routes/match.js GET /match/state 冒烟：song_match 绑定态只读取口——
// 正绑 song_detail 回水化出 matched 投影 / 回水化失败退裸 id 壳 /
// 负行·无行 match:null / 读侧模型键控与 cachedMatch 同口径 / 否决簿过滤 /
// trackId 校验；POST /match/retry 只钉「excludeIds 先落账再匹配」时序。
// 真库（临时 DATA_DIR）写读 song_match 行；匹配引擎整模块走 helpers 种子面
//（本路由只消费其 toMatchedJson 投影与 retry 的 matchWithBudget），
// 上游 song_detail 与 AI 启用态全桩。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { seed, seedMatchModule, tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-match-state-');
const require = createRequire(import.meta.url);

// AI 启用态桩：读侧模型键与 cachedMatch 同口径取 aiEnabled()?aiModel():''
let aiOn = false;
let aiModelName = 'stub';
seed('../src/server/lib/ai.js', {
  aiEnabled: () => aiOn,
  aiModel: () => aiModelName,
  askAiJson: async () => null,
});
// song_detail 回水化桩：detailSongs 即 songs 应答数组；detailThrow 注入传输故障
let detailSongs = [];
let detailThrow = false;
const apiCalls = [];
seed('../src/server/services/netease-api.js', {
  callNeteaseApi: async (name, params) => {
    apiCalls.push({ name, params });
    if (detailThrow) throw new Error(`${name} upstream boom`);
    return { body: { songs: detailSongs } };
  },
});
// retry 用例要钉「落账先于匹配运行」——impl 置可变桩，用例内重赋后生效；
// 其余路径只要 {song:null} 满足路由 require 接线
let retryImpl = async () => ({ song: null });
seedMatchModule([], () => (...args) => retryImpl(...args));

let app, songMatchRepo;
before(() => {
  app = require('../src/server/routes/match.js');
  songMatchRepo = require('../src/server/repositories/songMatch.js');
});
after(() => { rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

const get = (path, headers) => app.request(`http://t${path}`, { headers });
const json = async (res) => ({ status: res.status, body: await res.json() });
const postRetry = (body) => app.request('http://t/match/retry', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

test('match-state：正绑行 → song_detail 回水化出完整 match 投影', async () => {
  detailSongs = [{ id: 2068956580, name: '少女レイ', ar: [{ name: 'みきとP' }], al: { name: 'アルバムX' } }];
  songMatchRepo.upsertMatch('yt_STATE1', '2068956580', '少女レイ みきとP', 88, '');
  const r = await json(await get('/match/state?trackId=yt_STATE1'));
  assert.equal(r.status, 200);
  assert.equal(r.body.code, 200);
  // toMatchedJson 同款投影 + matchedBy/score 诊断列
  assert.deepEqual(r.body.match, {
    id: 2068956580, name: '少女レイ',
    ar: [{ name: 'みきとP' }], al: { name: 'アルバムX' },
    matchedBy: '少女レイ みきとP', score: 88,
  });
  const det = apiCalls.at(-1);
  assert.equal(det.name, 'song_detail');
  assert.equal(det.params.ids, '2068956580');   // 回水化按裸 netease_id 发起
});

test('match-state：正绑但回水化拿不到 → 裸 id 形态（客户端只补 neteaseId 也能用）', async () => {
  // songs 空 → 拿不到详情，退裸壳；数字 id 归一成 Number（cachedMatch 同口径）
  songMatchRepo.upsertMatch('bv_BARE1', '998877', '旧串', 60, '');
  detailSongs = [];
  const n = apiCalls.length;
  let r = await json(await get('/match/state?trackId=bv_BARE1'));
  assert.equal(r.status, 200);
  assert.equal(r.body.match.id, 998877);
  assert.equal(r.body.match.name, undefined);
  assert.equal(r.body.match.matchedBy, '旧串');
  assert.equal(r.body.match.score, 60);
  assert.equal(apiCalls.slice(n).filter(x => x.name === 'song_detail').length, 1);
  // 回水化传输故障同口径回落——只读口不炸
  songMatchRepo.upsertMatch('yt_BARE2', '123', '串2', null, '');
  detailThrow = true;
  try {
    r = await json(await get('/match/state?trackId=yt_BARE2'));
    assert.equal(r.status, 200);
    assert.equal(r.body.match.id, 123);
    assert.equal(r.body.match.score, null);      // score 列 NULL → null
  } finally { detailThrow = false; }
});

test('match-state：负缓存行与无行 → match:null', async () => {
  // '' 键控负行（fresh）会被 getMatch 命中读出，但 netease_id NULL → 未绑定
  songMatchRepo.upsertMatch('bv_NEGSTATE', null, '搜过没中的串', null, '');
  const r1 = await json(await get('/match/state?trackId=bv_NEGSTATE'));
  assert.equal(r1.status, 200);
  assert.equal(r1.body.code, 200);
  assert.equal(r1.body.match, null);
  const r2 = await json(await get('/match/state?trackId=yt_NOSUCHROW'));
  assert.equal(r2.body.match, null);
});

test('match-state：读侧模型键控——AI 判定行换模型/关 AI 读不出，启发式行永命中', async () => {
  aiOn = true; aiModelName = 'm1';
  try {
    songMatchRepo.upsertMatch('yt_MODEL1', '777', 'q', 80, 'm1');
    detailSongs = [{ id: 777, name: 'N1', ar: [], al: {} }];
    const r1 = await json(await get('/match/state?trackId=yt_MODEL1'));
    assert.equal(r1.body.match.id, 777);          // 同模型命中
    aiModelName = 'm2';                            // 换模型 → AI 判定行失效
    const r2 = await json(await get('/match/state?trackId=yt_MODEL1'));
    assert.equal(r2.body.match, null);
    aiOn = false;                                  // 关 AI → '' 键控面仍读不出
    const r3 = await json(await get('/match/state?trackId=yt_MODEL1'));
    assert.equal(r3.body.match, null);
    // 纯启发式正行（model=''）任何键面都命中
    songMatchRepo.upsertMatch('yt_MODEL2', '888', 'q', 80, '');
    detailSongs = [{ id: 888, name: 'N2', ar: [], al: {} }];
    const r4 = await json(await get('/match/state?trackId=yt_MODEL2'));
    assert.equal(r4.body.match.id, 888);
  } finally { aiOn = false; aiModelName = 'stub'; }
});

test('match-state：非法/缺席 trackId → 400；异源 Origin 不拦（GET 只读免 CSRF）', async () => {
  assert.equal((await get('/match/state')).status, 400);                        // 缺参
  assert.equal((await get('/match/state?trackId=')).status, 400);               // 空值
  assert.equal((await get('/match/state?trackId=bad%20id')).status, 400);       // 空格
  assert.equal((await get('/match/state?trackId=a.b')).status, 400);            // 路径字符
  // 超长按文件内 str() 口径截断到 80 再校验——合法字符集截出有效 id → 200 空绑定
  const long = await json(await get('/match/state?trackId=' + 'x'.repeat(81)));
  assert.equal(long.status, 200);
  assert.equal(long.body.match, null);
  // CSRF 纵深只管写请求——只读口对异源 Origin 照常应答（与全站 GET 同口径）
  songMatchRepo.upsertMatch('yt_CSRFOK', '555', 'q', 70, '');
  detailSongs = [{ id: 555, name: 'N', ar: [], al: {} }];
  const r = await get('/match/state?trackId=yt_CSRFOK', { origin: 'http://evil.example' });
  assert.equal(r.status, 200);
});

// ── 跨会话否决簿（vetoed_json）────────────────────────────────────
// 被否正行不下发（水合复活面堵死）；异模条目在 '' 读面不生效；
// retry 入口落账先于匹配运行——abort/预算耗尽否决也留下

test('match-state：被否正行 → match:null；异模否决不挡、未否正行照下', async () => {
  // '' 条目永生效（无 AI 期否决）——被否 id 按未命中回
  songMatchRepo.upsertMatch('yt_VETO1', '424242', 'q', 80, '');
  songMatchRepo.mergeVetoed('yt_VETO1', ['424242'], '');
  const r1 = await json(await get('/match/state?trackId=yt_VETO1'));
  assert.equal(r1.status, 200);
  assert.equal(r1.body.match, null);
  // 异模条目在 '' 读面不生效——正行照下（换模重判是新判定窗口）
  songMatchRepo.upsertMatch('yt_VETO2', '555666', 'q', 80, '');
  songMatchRepo.mergeVetoed('yt_VETO2', ['555666'], 'm-other');
  detailSongs = [{ id: 555666, name: 'N', ar: [], al: {} }];
  const r2 = await json(await get('/match/state?trackId=yt_VETO2'));
  assert.equal(r2.body.match.id, 555666);
  // 簿外 id 的正行不受否决簿存在本身影响
  songMatchRepo.upsertMatch('yt_VETO3', '777', 'q', 80, '');
  songMatchRepo.mergeVetoed('yt_VETO3', ['999'], '');
  detailSongs = [{ id: 777, name: 'N2', ar: [], al: {} }];
  const r3 = await json(await get('/match/state?trackId=yt_VETO3'));
  assert.equal(r3.body.match.id, 777);
});

test('match-retry：excludeIds 先落账——matchWithBudget 被调时否决已可见', async () => {
  let seenAtCall = null;
  retryImpl = async () => {
    // 匹配运行时点的读面：入口落账必须先于它——先于预算/abort 任何结局
    seenAtCall = songMatchRepo.getVetoedIds('yt_VETOENTRY', '');
    return { song: null };
  };
  try {
    const res = await postRetry({
      trackId: 'yt_VETOENTRY', title: 'x', author: 'a',
      candidates: ['x'], excludeIds: ['42', 7],     // 数字 id 同落账
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.matched, null);
    assert.ok(seenAtCall.has('42') && seenAtCall.has('7'));   // 运行前已落账
    assert.ok(songMatchRepo.getVetoedIds('yt_VETOENTRY', '').has('42'));
  } finally { retryImpl = async () => ({ song: null }); }
});

test('match-retry：材料缺席注定 400 的请求不落否决账', async () => {
  // 落账点在 queries 400 校验之后——脏请求（无 title/candidates）不得
  // 往簿里灌 excludeIds，连 stub 行都不该产
  const res = await postRetry({ trackId: 'yt_VETO400', excludeIds: ['42'] });
  assert.equal(res.status, 400);
  assert.equal(songMatchRepo.getMatchRow('yt_VETO400'), undefined);
});

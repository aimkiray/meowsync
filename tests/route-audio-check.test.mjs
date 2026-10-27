// routes/match.js GET /match/audio-check 契约钉板：词源回链音频校验闸的
// 只读端点——参数严校 / 'match-audio-check' 限流桶 / 回包键形冻结 /
// detail 缓存与负档 / veto 双向快路 / freshId 自救 / abort 归一 499 /
// 上游失败收敛 verdict:'unknown' 不产 5xx。
// 真库（临时 DATA_DIR）写读 song_ai_verdict/song_match；判定层用真
// shared/relay-gate.js（编排面钉板在此，判定三轴逻辑另谱直钉）；
// 上游 song_detail、AI 启用态与匹配引擎全桩。
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { seed, seedMatchModule, tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-audio-check-');
// 限流桶按 IP 分：TRUST_PROXY=1 下 XFF 决定桶键——各限流用例自带独立
// IP 不互相消耗（其余用例无 XFF 共 'local' 桶，总量远低于 60 上限）
process.env.TRUST_PROXY = '1';
const require = createRequire(import.meta.url);

// AI 启用态桩：freshId 自救的 song_match 模型键读侧口径
seed('../src/server/lib/ai.js', {
  aiEnabled: () => false,
  aiModel: () => '',
  askAiJson: async () => null,
});
// song_detail 桩：detailSongs 默认绑条；detailImpl 在场按 ids 分支应答
// （freshId 两跳不同绑条）；detailThrow 注入传输故障；detailHold 悬挂
// 绑 detail 跳（abort 499 用例——共享跳不吃调用方 signal 不会自醒）
const apiCalls = [];
let detailSongs = [{ id: 555001, name: '同名', ar: [{ name: '同艺人' }], dt: 200000 }];
let detailImpl = null;
let detailThrow = false;
let detailHold = false;
seed('../src/server/services/netease-api.js', {
  callNeteaseApi: async (name, args) => {
    apiCalls.push({ name, args });
    if (name !== 'song_detail') return { body: {} };
    if (detailHold) return new Promise(() => {});
    if (detailThrow) throw new Error('song_detail upstream boom');
    if (detailImpl) return detailImpl(args);
    return { body: { songs: detailSongs } };
  },
});
seedMatchModule([], () => async () => ({ song: null }));

let app, getDb, songMatchRepo, resetRelayCaches;
before(() => {
  app = require('../src/server/routes/match.js');
  getDb = require('../src/server/db/client.js').getDb;
  songMatchRepo = require('../src/server/repositories/songMatch.js');
  resetRelayCaches = require('../src/server/services/relay-gate.js')._resetRelayCaches;
});
after(() => { rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

beforeEach(() => {
  detailSongs = [{ id: 555001, name: '同名', ar: [{ name: '同艺人' }], dt: 200000 }];
  detailImpl = null;
  detailThrow = false;
  detailHold = false;
  apiCalls.length = 0;
  try {
    getDb().exec("DELETE FROM song_ai_verdict WHERE kind = 'audio_relay'");
    getDb().exec('DELETE FROM song_match');
  } catch { /* 表未建兜底 */ }
  // 进程级 detail 正/负档缓存清台——同 nid 跨用例会命中陈旧绑条
  resetRelayCaches();
});

const get = async (path, headers) => {
  const res = await app.request(`http://t${path}`, { headers });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const detailCount = () => apiCalls.filter(c => c.name === 'song_detail').length;
const qs = (o) => '?' + Object.entries(o)
  .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
const verdictRows = () => getDb().prepare(
  "SELECT song_id, ok, detail FROM song_ai_verdict WHERE kind = 'audio_relay'").all();

// ── 参数严校 ─────────────────────────────────────────────────────

test('参数严校：nid 缺席/非数字/超长、title 缺席、trackId 非法 → 各 400', async () => {
  assert.equal((await get('/match/audio-check')).status, 400);                    // nid 缺席
  assert.equal((await get('/match/audio-check?nid=abc&title=x')).status, 400);    // 非数字
  assert.equal((await get('/match/audio-check?nid=' + '1'.repeat(21) + '&title=x')).status, 400); // 超 20 位
  assert.equal((await get('/match/audio-check?nid=555001')).status, 400);         // title 缺席
  assert.equal((await get('/match/audio-check?nid=555001&title=%20%20')).status, 400); // 空白 title
  assert.equal((await get('/match/audio-check?nid=555001&title=x&trackId=bad%20id')).status, 400); // 非法 trackId
  assert.equal(detailCount(), 0, '形闸拒在入口处——不付上行');
});

test('artists JSON 非法串/超 1200B → 按空集照样判（fail-soft 不 400）', async () => {
  let r = await get('/match/audio-check' + qs({ nid: '555001', title: '同名', artists: '{oops' }));
  assert.equal(r.status, 200);
  assert.equal(r.body.code, 200);
  assert.equal(r.body.verdict, 'pass', '期望艺人缺席走 neutral 轴不降级');
  // 超 1200B 的 artists 被 str() 截成非法 JSON——同归空集
  r = await get('/match/audio-check' + qs({
    nid: '555001', title: '同名',
    artists: JSON.stringify(Array(30).fill('很'.repeat(60))),
  }));
  assert.equal(r.status, 200);
});

test('artists 合法 JSON 数组成员级比对（含 /、空格艺人名零碰撞）', async () => {
  detailSongs = [{ id: 555001, name: 'X', ar: [{ name: 'Utada Hikaru' }], dt: 200000 }];
  const r = await get('/match/audio-check' + qs({
    nid: '555001', title: 'X',
    artists: JSON.stringify(['宇多田ヒカル/某 feat 人', 'Utada Hikaru']),
  }));
  assert.equal(r.status, 200);
  assert.equal(r.body.verdict, 'pass');
});

// ── 回包契约 ─────────────────────────────────────────────────────

test('回包键形冻结：{code,verdict,reasons,cand:{id,name,artists,dtMs}}', async () => {
  detailSongs = [{ id: 555002, name: '同名', ar: [{ name: '同艺人' }], dt: 200000 }];
  const r = await get('/match/audio-check' + qs({ nid: '555002', title: '同名', artists: '["同艺人"]' }));
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ['cand', 'code', 'reasons', 'verdict']);
  assert.equal(r.body.code, 200);
  assert.equal(r.body.verdict, 'pass');
  assert.ok(Array.isArray(r.body.reasons));
  assert.deepEqual(r.body.cand, { id: 555002, name: '同名', artists: ['同艺人'], dtMs: 200000 });
});

test('判定 block：绑条艺人/时长错配 → reasons 含判因，cand 投影在场', async () => {
  detailSongs = [{ id: 555003, name: '娘子', ar: [{ name: '叶藏澈' }], dt: 326000 }];
  const r = await get('/match/audio-check' + qs({
    nid: '555003', title: '娘子', artists: '["周杰伦"]', durMs: 271000,
  }));
  assert.equal(r.body.verdict, 'block');
  assert.ok(r.body.reasons.includes('artist_mismatch'));
  assert.ok(r.body.reasons.includes('duration_off'));
  assert.equal(r.body.cand.id, 555003);
});

test('durMs 负值/非数钳 0=无时长证据：时长轴跳过不误拦', async () => {
  detailSongs = [{ id: 555004, name: '娘子', ar: [{ name: '周杰伦' }], dt: 326000 }];
  // 同艺人但时长差 55s——durMs 钳 0 则跳过时长轴 → pass；durMs=271000 则拦
  let r = await get('/match/audio-check' + qs({
    nid: '555004', title: '娘子', artists: '["周杰伦"]', durMs: '-1',
  }));
  assert.equal(r.body.verdict, 'pass', 'durMs 钳 0 → 时长证据缺席不误拦');
  r = await get('/match/audio-check' + qs({
    nid: '555004', title: '娘子', artists: '["周杰伦"]', durMs: 'abc',
  }));
  assert.equal(r.body.verdict, 'pass');
  r = await get('/match/audio-check' + qs({
    nid: '555004', title: '娘子', artists: '["周杰伦"]', durMs: '271000',
  }));
  assert.equal(r.body.verdict, 'block', '时长证据在场 55s 偏差必拦');
});

// ── detail 缓存与负档 ────────────────────────────────────────────

test('detail 缓存：同 nid 二连请求只付一跳上行（正档命中）', async () => {
  const q = qs({ nid: '555005', title: '同名', artists: '["同艺人"]' });
  const r1 = await get('/match/audio-check' + q);
  const r2 = await get('/match/audio-check' + q);
  assert.equal(r1.body.verdict, 'pass');
  assert.equal(r2.body.verdict, 'pass');
  assert.equal(detailCount(), 1);
});

test('detail 负档：传输故障收敛 unknown（不产 5xx），60s 内同 nid 不重打', async () => {
  detailThrow = true;
  const q = qs({ nid: '555006', title: '同名' });
  const r1 = await get('/match/audio-check' + q);
  assert.equal(r1.status, 200, '上游失败不产 5xx');
  assert.equal(r1.body.verdict, 'unknown');
  assert.deepEqual(r1.body.reasons, ['detail_unavailable']);
  assert.equal(r1.body.cand, null);
  const r2 = await get('/match/audio-check' + q);
  assert.equal(r2.body.verdict, 'unknown');
  assert.equal(detailCount(), 1, '负档 60s 内不重打上行');
});

test('并发同 nid 两请求 → detail 单飞合流一跳（R10a-N9）', async () => {
  const q = '/match/audio-check' + qs({ nid: '555015', title: '同名', artists: '["同艺人"]' });
  const [r1, r2] = await Promise.all([get(q), get(q)]);
  assert.equal(r1.body.verdict, 'pass');
  assert.equal(r2.body.verdict, 'pass');
  assert.equal(detailCount(), 1, '并发同 nid 共享 detailInflight——不各自打上行');
});

// ── veto 双向快路（trackId 在场才键控）─────────────────────────────

test('veto 快路：block 落账后同参二判零上行，reasons 烙 vetoed', async () => {
  detailSongs = [{ id: 555007, name: '娘子', ar: [{ name: '叶藏澈' }], dt: 326000 }];
  const q = qs({ nid: '555007', title: '娘子', artists: '["周杰伦"]', durMs: '271000', trackId: 'qq_ACVETO01' });
  const r1 = await get('/match/audio-check' + q);
  assert.equal(r1.body.verdict, 'block');
  assert.equal(detailCount(), 1);
  assert.equal(verdictRows().length, 1, 'block 落账——审计痕+快路原料');
  assert.equal(verdictRows()[0].ok, 0);
  assert.ok(verdictRows()[0].song_id.startsWith('qq_ACVETO01@555007@'), 'vkey=<trackId>@<nid>@<sig>');
  const r2 = await get('/match/audio-check' + q);
  assert.equal(r2.body.verdict, 'block');
  assert.equal(r2.body.reasons[0], 'vetoed', '快路判否烙 vetoed 判因');
  assert.equal(detailCount(), 1, '二判零上行');
});

test('veto 快路：pass 落账同键零上行（vetoed_pass），换 nid 不撞旧判', async () => {
  const base = { title: '同名', artists: '["同艺人"]', trackId: 'qq_ACVETO02' };
  const r1 = await get('/match/audio-check' + qs({ ...base, nid: '555008' }));
  assert.equal(r1.body.verdict, 'pass');
  assert.equal(verdictRows()[0].ok, 1, 'pass 也落账——已批绑定不重复烧 detail 跳');
  const r2 = await get('/match/audio-check' + qs({ ...base, nid: '555008' }));
  assert.equal(r2.body.verdict, 'pass');
  assert.equal(r2.body.reasons[0], 'vetoed_pass');
  assert.equal(detailCount(), 1, 'pass 快路零上行');
  // 换绑 nid → vkey 不同不撞旧否决——重新付一跳判定
  const r3 = await get('/match/audio-check' + qs({ ...base, nid: '555009' }));
  assert.equal(r3.body.verdict, 'pass');
  assert.equal(detailCount(), 2);
});

test('trackId 缺席：照样判但不着账——二判不产 vetoed 快路', async () => {
  detailSongs = [{ id: 555010, name: '娘子', ar: [{ name: '叶藏澈' }], dt: 326000 }];
  const q = qs({ nid: '555010', title: '娘子', artists: '["周杰伦"]', durMs: '271000' });
  const r1 = await get('/match/audio-check' + q);
  assert.equal(r1.body.verdict, 'block');
  assert.equal(verdictRows().length, 0, '游离调用不落 veto 账');
  const r2 = await get('/match/audio-check' + q);
  assert.equal(r2.body.verdict, 'block');
  assert.notEqual(r2.body.reasons[0], 'vetoed', '无账可快路——每判都走真判定');
});

// ── freshId 自救 ────────────────────────────────────────────────

test('freshId 自救：快照绑条被拦 + song_match 正绑异 id 过闸 → pass 且 cand.id 换正绑', async () => {
  songMatchRepo.upsertMatch('qq_ACFRESH01', '555012', '娘子 周杰伦', 90, '');
  detailImpl = (args) => ({ body: { songs: String(args.ids) === '555012'
    ? [{ id: 555012, name: '娘子', ar: [{ name: '周杰伦' }], dt: 272000 }]
    : [{ id: 555011, name: '娘子', ar: [{ name: '叶藏澈' }], dt: 326000 }] } });
  const r = await get('/match/audio-check' + qs({
    nid: '555011', title: '娘子', artists: '["周杰伦"]', durMs: '271000', trackId: 'qq_ACFRESH01',
  }));
  assert.equal(r.body.verdict, 'pass', '正绑过闸——快照滞后自赎');
  assert.equal(r.body.cand.id, 555012, 'cand.id 即核准播放 id——客户端按它取流');
  assert.deepEqual(apiCalls.map(c => c.args.ids), ['555011', '555012']);
});

test('veto 死锁自救（S1）：判否落账 → song_match 换绑异 id → 同参二判脱 veto 走正绑', async () => {
  // veto 钉的是快照 nid——/match/retry 只写 song_match 不改 provider_data
  // 快照，「判否落账→重匹配→重试」会被旧 veto 快路永拦（§4.3 逃逸通道
  // 失灵面）。ok=0 快路必须先查库行现行正绑（纯本地读零上行）
  detailImpl = (args) => ({ body: { songs: String(args.ids) === '555012'
    ? [{ id: 555012, name: '娘子', ar: [{ name: '周杰伦' }], dt: 272000 }]
    : [{ id: 555011, name: '娘子', ar: [{ name: '叶藏澈' }], dt: 326000 }] } });
  const q = qs({
    nid: '555011', title: '娘子', artists: '["周杰伦"]', durMs: '271000', trackId: 'qq_ACVETO03',
  });
  const r1 = await get('/match/audio-check' + q);
  assert.equal(r1.body.verdict, 'block');
  assert.equal(detailCount(), 1);
  assert.equal(verdictRows().length, 1);
  assert.equal(verdictRows()[0].ok, 0, '判否落账——快路原料');
  // 重匹配换绑正行（快照 nid 不变）——同参二判应脱 veto 死锁走正绑
  songMatchRepo.upsertMatch('qq_ACVETO03', '555012', '娘子 周杰伦', 90, '');
  const r2 = await get('/match/audio-check' + q);
  assert.equal(r2.body.verdict, 'pass', 'veto 快路先查现行正绑——候选在场不死锁');
  assert.equal(r2.body.cand.id, 555012, '核准播放 id=库现行正绑');
  assert.equal(detailCount(), 2,
    '原 nid veto 零上行——只多 fresh nid 一跳 detail');
  assert.equal(verdictRows().length, 2, 'fresh 自身 vkey 照常落账（ok=1）');
});

// ── 限流桶与 abort ──────────────────────────────────────────────

test('限流桶：match-audio-check 60/min——61 连发末节 429', async () => {
  const headers = { 'x-forwarded-for': '10.77.7.7' }; // 独立 IP 桶，不消耗其他用例
  let last = null;
  for (let i = 0; i < 61; i++) {
    last = await get('/match/audio-check?nid=555013&title=x', headers);
  }
  assert.equal(last.status, 429);
  assert.equal(last.body.code, 429);
});

test('客户端断连 → 499（共享 detail 跳不陪绑，waitAbort 即时醒）', async () => {
  detailHold = true; // detail 跳悬挂——只有调用方 abort 能解
  const ctl = new AbortController();
  const p = app.request('http://t/match/audio-check?nid=555014&title=x', { signal: ctl.signal });
  ctl.abort();
  const res = await p;
  assert.equal(res.status, 499);
});

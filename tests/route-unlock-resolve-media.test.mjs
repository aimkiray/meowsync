// GET /unlock/resolve-media 端点谱——SourcePicker 直绑行只读远端解析
//（av 号/BV 号/b23.tv·bili2233.cn 短链（含包裹分享文本）/bilibili.com 链 →
// 谓词收单 → resolveBiliLink 分诊 → view 快照/存在性 → 净形 mediaId）。
// lib/bilibili 预播种可控 stub（bilibili-favlist L22-58 同款范式），路由只留
// HTTP 语义/分诊/缓存/限流可测；POST /unlock/manual 零改动面顺带钉板。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { seed, getJson, tmpDataDir } from './helpers.mjs';

// repo（POST 回归面）走真库——隔离 DATA_DIR 不开 dev 库
process.env.DATA_DIR = tmpDataDir('meowsync-rresolvemedia-');
const require = createRequire(import.meta.url);

// AI 层桩——netease-api require 链挂着 lib/ai（route-unlock-manual 同范式）
seed('../src/server/lib/ai.js', {
  aiEnabled: () => false,
  aiModel: () => 'test-model',
  askAiJson: async () => null,
});

// 限流桩：rateImpl 翻转验 429；rateCalls 记录桶实参（钉 'unlock-resolve' 契约）
let rateImpl = () => true;
const rateCalls = [];
seed('../src/server/lib/rate-limit.js', {
  rateLimit: (...a) => { rateCalls.push(a); return rateImpl(...a); },
});

// lib/bilibili 上游原语桩：resolveBiliLink/biliFetch 逐用例可编程；
// viewQuery 复制真实现——bvid/aid 双形（aid 面须真 aid= 形态才验得到）
const linkCalls = [];
const fetchCalls = [];
let linkImpl = async () => null;
let fetchImpl = async () => { throw new Error('unstubbed'); };
seed('../src/server/lib/bilibili.js', {
  resolveBiliLink: async (input, sig) => { linkCalls.push({ input, sig }); return linkImpl(input, sig); },
  biliFetch: async (path, sig) => { fetchCalls.push({ path, sig }); return fetchImpl(path, sig); },
  viewQuery: (id) => (typeof id === 'string' ? `bvid=${id}` : `aid=${id.aid}`),
});

// provider 桩：POST 回归面只需 bilibili.resolveById 记账
const resolveByIdCalls = [];
let bvResolveByIdImpl = async () => ({ url: 'https://upos.example/x.m4s?sig=S', urls: ['https://upos.example/x.m4s?sig=S'], br: 192000 });
seed('../src/server/services/unlock/index.js', {
  PROVIDERS: {
    youtube: { search: async () => [], resolveById: async () => null, forgetSong: () => {} },
    bilibili: {
      search: async () => [],
      resolveById: async (mediaId, o) => { resolveByIdCalls.push({ mediaId, ctx: o }); return bvResolveByIdImpl(mediaId, o); },
      forgetSong: () => {},
    },
  },
  PLAYBACK_SOURCES: ['pyncmd', 'youtube', 'bilibili'],
  DOWNLOAD_SOURCES: ['pyncmd', 'youtube', 'bilibili'],
});
// 网易门面桩（netease-api 解构面——本谱不打 candidates，callNeteaseApi 缺席兜底）
seed('../src/server/services/netease/index.js', {
  callNeteaseApi: async () => { throw new Error('unexpected api'); },
  apiModules: {},
});

const app = require('../src/server/routes/unlock-manual.js');

const get = (input) => getJson(app, `/unlock/resolve-media?input=${encodeURIComponent(input)}`);
const post = async (body) => {
  const res = await app.request('http://t/unlock/manual', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const VIEW = (over = {}) => ({
  bvid: 'BV1xx411c7mD', aid: 170001, cid: 1, title: '投稿标题',
  owner: { name: 'UP主' }, duration: 200, ...over
});
const reset = () => {
  linkCalls.length = 0; fetchCalls.length = 0; rateCalls.length = 0;
  resolveByIdCalls.length = 0;
  linkImpl = async () => null;
  fetchImpl = async () => { throw new Error('unstubbed'); };
  rateImpl = () => true;
  bvResolveByIdImpl = async () => ({ url: 'https://upos.example/x.m4s?sig=S', urls: [], br: 192000 });
};

test('成功面：短链 → video → view 快照——mediaId 规范形+source+快照透传', async () => {
  reset();
  linkImpl = async () => ({ kind: 'video', id: 'BV1xx411c7mD' });
  fetchImpl = async () => VIEW();
  const { status, body } = await get('https://b23.tv/abc123');
  assert.equal(status, 200);
  assert.deepEqual(body, {
    code: 200, source: 'bilibili', mediaId: 'BV1xx411c7mD',
    title: '投稿标题', owner: 'UP主', durationSec: 200,
  });
  assert.equal(linkCalls[0].input, 'https://b23.tv/abc123');
  assert.ok(linkCalls[0].sig instanceof AbortSignal, '30s 端级预算级联进跳解');
  assert.equal(fetchCalls[0].path, '/x/web-interface/view?bvid=BV1xx411c7mD');
  assert.ok(fetchCalls[0].sig instanceof AbortSignal, '同一预算级联进 view');
  // 限流桶契约：unlock-resolve / 12
  assert.equal(rateCalls[0][1], 'unlock-resolve');
  assert.equal(rateCalls[0][2], 12);
});

test('净形支：av → aid view → 规范 BVID；裸 BV（含小写头）直查零跳解', async () => {
  reset();
  fetchImpl = async () => VIEW();
  let r = await get('av170001');
  assert.equal(r.status, 200);
  assert.equal(fetchCalls[0].path, '/x/web-interface/view?aid=170001');
  assert.equal(r.body.mediaId, 'BV1xx411c7mD', 'aid 输入经 view 换规范 BV');
  assert.equal(linkCalls.length, 0, '净形输入零跳解');
  fetchCalls.length = 0;
  r = await get('AV2');
  assert.equal(fetchCalls[0].path, '/x/web-interface/view?aid=2', '大写 AV 前缀同收');
  fetchCalls.length = 0;
  r = await get('bv1xx411c7mD');
  assert.equal(r.status, 200);
  assert.equal(fetchCalls[0].path, '/x/web-interface/view?bvid=BV1xx411c7mD');
  assert.equal(r.body.mediaId, 'BV1xx411c7mD', '小写 bv 入参按规范形回写');
  assert.equal(linkCalls.length, 0);
});

test('kind 分诊：favlist 附 favlist 字段 / live / bangumi / other 各归各位', async () => {
  reset();
  linkImpl = async () => ({ kind: 'favlist', fid: '55' });
  let r = await get('https://b23.tv/fav');
  assert.equal(r.status, 400);
  assert.equal(r.body.kind, 'favlist');
  assert.equal(r.body.favlist, '55', '与 /bilibili/resolve 同构的 favlist 字段');
  linkImpl = async () => ({ kind: 'live' });
  r = await get('https://b23.tv/lv');
  assert.equal(r.status, 400);
  assert.equal(r.body.kind, 'live');
  linkImpl = async () => ({ kind: 'bangumi' });
  r = await get('https://b23.tv/bg');
  assert.equal(r.status, 400);
  assert.equal(r.body.kind, 'bangumi');
  linkImpl = async () => ({ kind: 'other' });
  r = await get('https://b23.tv/ot');
  assert.equal(r.status, 400);
  assert.equal(r.body.kind, 'other');
  assert.equal(fetchCalls.length, 0, '非 video 分诊不打 view');
});

test('unresolved：resolveBiliLink null → 404 且不缓存（复活重试真打新跳）', async () => {
  reset();
  let r = await get('https://b23.tv/dead');
  assert.equal(r.status, 404);
  assert.equal(r.body.kind, 'unresolved');
  assert.equal(linkCalls.length, 1);
  // unresolved 不缓存——同键第二次必须真打新一跳（瞬态失败重试语义）
  linkImpl = async () => ({ kind: 'video', id: 'BV1xx411c7mD' });
  fetchImpl = async () => VIEW();
  r = await get('https://b23.tv/dead');
  assert.equal(r.status, 200, '短链复活后同键不再 404');
  assert.equal(linkCalls.length, 2);
});

test('gone：view 确定性码 -400/-403/-404 → 404 且入缓存', async () => {
  reset();
  const bvids = ['BV1xx411c7aA', 'BV1xx411c7bB', 'BV1xx411c7cC'];
  const codes = [-400, -403, -404];
  for (let i = 0; i < codes.length; i++) {
    fetchImpl = async () => { throw new Error(`bilibili /x/web-interface/view code=${codes[i]} 请求错误`); };
    const r = await get(bvids[i]);
    assert.equal(r.status, 404, `code=${codes[i]}`);
    assert.equal(r.body.kind, 'gone');
    assert.equal(r.body.message, '该视频不存在或已失效');
  }
  // gone 是已分类终态——60s 内同键零上游
  const n = fetchCalls.length;
  const r2 = await get(bvids[0]);
  assert.equal(r2.status, 404);
  assert.equal(fetchCalls.length, n, 'gone 入缓存：同键二次不打上游');
});

test('degraded：BV 净形+view 瞬态 → 200 degraded 无快照（不缓存，复活真打）', async () => {
  reset();
  fetchImpl = async () => { throw new Error('bilibili /x/web-interface/view HTTP 503'); };
  let r = await get('BV1xx411c7dD');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { code: 200, source: 'bilibili', mediaId: 'BV1xx411c7dD', degraded: true });
  // degraded 不缓存——同键重试真打新一跳，恢复后拿完整快照
  fetchImpl = async () => VIEW();
  r = await get('BV1xx411c7dD');
  assert.equal(r.status, 200);
  assert.equal(r.body.title, '投稿标题');
  assert.ok(!('degraded' in r.body));
  assert.equal(fetchCalls.length, 2);
});

test('502：aid 净形 view 瞬态无规范 BV 可降 → 502 不带 kind；不缓存复问真打新跳', async () => {
  reset();
  fetchImpl = async () => { throw new Error('bilibili /x/web-interface/view HTTP 503'); };
  let r = await get('av998877');
  assert.equal(r.status, 502);
  assert.match(r.body.message, /^B 站解析失败：/);
  assert.ok(!('kind' in r.body), '502 体不带 kind');
  // 502 不缓存（与 degraded/unresolved 同律）——同键复问必须真打新一跳 view
  const n502 = fetchCalls.length;
  r = await get('av998877');
  assert.equal(r.status, 502);
  assert.equal(fetchCalls.length, n502 + 1, '502 不入缓存：同键复问真打新跳而非回旧包');
  // view 成功但缺 bvid（aid 形无净形可回）→ 上游异常归 502
  fetchImpl = async () => ({ aid: 998877, title: 'x' });
  r = await get('av887766');
  assert.equal(r.status, 502);
  assert.match(r.body.message, /缺 bvid/);
  // 防御支对照：bvid 形 id 有净形可回——view 缺 bvid 仍回规范 mediaId
  fetchImpl = async () => ({ title: 'x', owner: { name: 'o' }, duration: 10 });
  r = await get('BV1xx411c7eE');
  assert.equal(r.status, 200);
  assert.equal(r.body.mediaId, 'BV1xx411c7eE');
});

test('跳解 video {aid} → aid view → 规范 BV；跳解 bvid 瞬态同享 degraded 面', async () => {
  reset();
  linkImpl = async () => ({ kind: 'video', id: { aid: 42 } });
  fetchImpl = async () => VIEW();
  let r = await get('https://b23.tv/aidform');
  assert.equal(r.status, 200);
  assert.equal(fetchCalls[0].path, '/x/web-interface/view?aid=42');
  assert.equal(r.body.mediaId, 'BV1xx411c7mD');
  linkImpl = async () => ({ kind: 'video', id: 'BV1xx411c7fF' });
  fetchImpl = async () => { throw new Error('bilibili /x/web-interface/view HTTP 500'); };
  r = await get('https://b23.tv/bvdg');
  assert.equal(r.status, 200);
  assert.equal(r.body.mediaId, 'BV1xx411c7fF');
  assert.equal(r.body.degraded, true, '净形 BV 在手瞬态降级放行——POST 再验');
  // 跳解产出的小写 bv 在调 view 前归一——与直输 bv 支同一判决（两入口不两判）
  linkImpl = async () => ({ kind: 'video', id: 'bv1xx411c7zZ' });
  fetchImpl = async () => VIEW({ bvid: 'BV1xx411c7zZ' });
  r = await get('https://b23.tv/lowerbv');
  assert.equal(r.status, 200);
  assert.equal(fetchCalls.at(-1).path, '/x/web-interface/view?bvid=BV1xx411c7zZ', '跳解小写 bv 须归一成规范形再问 view');
});

test('abort 归一 499：biliFetch 抛 aborted 标记不吞成 502', async () => {
  reset();
  const e = new Error('aborted');
  e.aborted = true;
  fetchImpl = async () => { throw e; };
  const res = await app.request('http://t/unlock/resolve-media?input=BV1xx411c7gG');
  assert.equal(res.status, 499);
});

test('abort 半支：请求 signal 真断连（错误不带 aborted 标）→ 499 而非 502/unresolved', async () => {
  reset();
  // c.req.raw.signal?.aborted 半支钉板：上游抛普通错但客户端已在飞断连
  const ctrl = new AbortController();
  fetchImpl = async () => { ctrl.abort(); throw new Error('bilibili /x/web-interface/view HTTP 503'); };
  const res = await app.request(new Request('http://t/unlock/resolve-media?input=BV1xx411c7aB', { signal: ctrl.signal }));
  assert.equal(res.status, 499, 'raw.signal 断连须归一 499——普通错不被吞成 502');
});

test('缓存：已分类终态 60s 内同输入只打一跳（video 快照/favlist 同律）', async () => {
  reset();
  linkImpl = async () => ({ kind: 'video', id: 'BV1xx411c7hH' });
  fetchImpl = async () => VIEW();
  let r = await get('https://b23.tv/cache1');
  assert.equal(r.status, 200);
  r = await get('https://b23.tv/cache1');
  assert.equal(r.status, 200);
  assert.equal(r.body.mediaId, 'BV1xx411c7mD', 'mediaId 恒回 view.bvid 规范形');
  assert.equal(linkCalls.length, 1, '缓存命中零跳解');
  assert.equal(fetchCalls.length, 1, '缓存命中零 view');
  linkImpl = async () => ({ kind: 'favlist', fid: '9' });
  r = await get('https://b23.tv/favc');
  assert.equal(r.status, 400);
  assert.equal(r.body.kind, 'favlist');
  r = await get('https://b23.tv/favc');
  assert.equal(linkCalls.length, 2, 'favlist 终态入缓存——第二次零跳解');
});

test('谓词收单：非 B 站形态/语境 → 400 invalid 零出站', async () => {
  reset();
  for (const bad of [
    'random text', 'example.com/av123', 'foo?av=1', 'notbilibili.com/x',
    'xb23.tv/x', 'b23.tv.evil.com/x', 'qq:av1', 'av170001 尾巴',
    '12345678901', 'ml1052622027', '',
  ]) {
    const r = await get(bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal(r.body.kind, 'invalid');
    assert.equal(r.body.message, '输入不是支持的 B 站链接或 ID');
  }
  assert.equal(linkCalls.length, 0, '谓词拒收零跳解');
  assert.equal(fetchCalls.length, 0, '谓词拒收零 view');
});

test('限流：桶拒 → 429 不带 kind，零出站', async () => {
  reset();
  rateImpl = () => false;
  const r = await get('BV1xx411c7iI');
  assert.equal(r.status, 429);
  assert.equal(r.body.code, 429);
  assert.ok(!('kind' in r.body));
  assert.equal(linkCalls.length, 0);
  assert.equal(fetchCalls.length, 0);
});

test('快照透传闸：durationSec 缺席/≤0/>7200 三形态键缺席（POST 必拒值不外发）', async () => {
  reset();
  linkImpl = async () => ({ kind: 'video', id: 'BV1xx411c7mD' });
  for (const [label, dur] of [['缺席', undefined], ['零', 0], ['负', -5], ['超上限', 7201], ['零点四', 0.4]]) {
    fetchImpl = async () => VIEW({ duration: dur });
    const r = await get(`https://b23.tv/dur${label}`);
    assert.equal(r.status, 200, label);
    assert.equal(r.body.code, 200);
    // schema optional 只容缺席不容 null——钉「键缺席」而非「值为 null」
    assert.ok(!('durationSec' in r.body), `${label}：durationSec 键须缺席`);
    assert.equal(r.body.mediaId, 'BV1xx411c7mD');
  }
  // 对照：合法值照常挂键并取整；title/owner 按 POST 上限（300/200）预截
  fetchImpl = async () => VIEW({ duration: 200.6, title: 't'.repeat(400), owner: { name: 'o'.repeat(250) } });
  const r = await get('https://b23.tv/durok');
  assert.equal(r.status, 200);
  assert.equal(r.body.durationSec, 201, '合法时长取整透传');
  assert.equal(r.body.title.length, 300);
  assert.equal(r.body.owner.length, 200);
  // 挂键判舍入后值：7200.4 舍回 7200 内照常挂键（闸在 round 后不在原值）
  fetchImpl = async () => VIEW({ duration: 7200.4 });
  const r2 = await get('https://b23.tv/dur7200x');
  assert.equal(r2.status, 200);
  assert.equal(r2.body.durationSec, 7200, '7200.4 舍入回上限内照常挂键');
});

test('av 净形闸：超精度/aid≤0 输入 → invalid 400 零出站（错绑>拒绑）', async () => {
  reset();
  const r = await get('av9007199254740993'); // > MAX_SAFE_INTEGER——Number 丢精度会错绑另一支
  assert.equal(r.status, 400);
  assert.equal(r.body.kind, 'invalid');
  // aid≤0 同闸：av0/av00 出站前拒——不白烧一跳 view，不把「aid=0 gone」钉缓存
  for (const bad of ['av0', 'av00']) {
    const r2 = await get(bad);
    assert.equal(r2.status, 400, bad);
    assert.equal(r2.body.kind, 'invalid');
  }
  assert.equal(fetchCalls.length, 0, '不拿错位/零值 aid 白烧一跳 view');
  assert.equal(linkCalls.length, 0, '净形支零跳解');
});

test('502 message 契约：单行 ≤120 截断 + 绝对路径剥除（换行洗成空格）', async () => {
  reset();
  fetchImpl = async () => { throw new Error(`上游\n故障明细${'x'.repeat(300)}`); };
  const r = await get('av334455');
  assert.equal(r.status, 502);
  assert.match(r.body.message, /^B 站解析失败：/);
  assert.ok(!/[\r\n]/.test(r.body.message), 'message 单行不外泄堆栈/多行');
  assert.ok(r.body.message.length <= 'B 站解析失败：'.length + 120, `len=${r.body.message.length}`);
  // 回显过 stripAbsolutePaths——本地 fs/上游错误里的部署目录不透给未鉴权调用方
  fetchImpl = async () => { throw new Error(`ENOENT open '/var/lib/meowsync/secret.json'`); };
  const r2 = await get('av334456');
  assert.equal(r2.status, 502);
  assert.ok(!r2.body.message.includes('/var/lib'), `路径未剥除: ${r2.body.message}`);
  assert.ok(r2.body.message.includes('<path>'));
});

test('包裹分享文本：整串过谓词送 resolveBiliLink（端点级形态钉板）', async () => {
  reset();
  linkImpl = async () => ({ kind: 'video', id: 'BV1xx411c7mD' });
  fetchImpl = async () => VIEW();
  const wrapped = '【标题】 https://b23.tv/xx 快来围观';
  const r = await get(wrapped);
  assert.equal(r.status, 200);
  assert.equal(r.body.mediaId, 'BV1xx411c7mD');
  assert.equal(linkCalls[0].input, wrapped, '整串原样送跳解——抽取在 lib 侧');
});

test('防御支：link.kind=video 但 id 缺席（假对象漂移）→ 404 unresolved 不缓存', async () => {
  reset();
  linkImpl = async () => ({ kind: 'video' }); // id 缺席——契约漂移防御面
  let r = await get('https://b23.tv/fakevid');
  assert.equal(r.status, 404);
  assert.equal(r.body.kind, 'unresolved');
  assert.equal(fetchCalls.length, 0, '无 id 不打 view');
  // unresolved 不缓存——同键复问必须真打新一跳
  linkImpl = async () => ({ kind: 'video', id: 'BV1xx411c7mD' });
  fetchImpl = async () => VIEW();
  r = await get('https://b23.tv/fakevid');
  assert.equal(r.status, 200);
  assert.equal(linkCalls.length, 2);
});

test('缓存：live/bangumi/other 已分类终态入缓存——同键二次零跳解', async () => {
  reset();
  for (const kind of ['live', 'bangumi', 'other']) {
    linkImpl = async () => ({ kind });
    let r = await get(`https://b23.tv/c${kind}`);
    assert.equal(r.status, 400);
    assert.equal(r.body.kind, kind);
    const n = linkCalls.length;
    r = await get(`https://b23.tv/c${kind}`);
    assert.equal(r.body.kind, kind);
    assert.equal(linkCalls.length, n, `${kind} 已分类终态——缓存命中零跳解`);
  }
  assert.equal(fetchCalls.length, 0, '非 video 终态从不打 view');
});

test('缓存键=trim 后 input：首尾空白变体共键只打一跳', async () => {
  reset();
  linkImpl = async () => ({ kind: 'video', id: 'BV1xx411c7mD' });
  fetchImpl = async () => VIEW();
  await get('https://b23.tv/tk');
  const r = await get('  https://b23.tv/tk  ');
  assert.equal(r.status, 200);
  assert.equal(r.body.mediaId, 'BV1xx411c7mD');
  assert.equal(linkCalls.length, 1, 'trim 归一键——空白变体不重复跳解');
});

test('POST /unlock/manual 零改动钉板：av/短链/完整链直送仍 400，净形 BV 照常', async () => {
  reset();
  for (const mediaId of [
    'av170001', 'https://b23.tv/abc123', 'b23.tv/abc123',
    'https://www.bilibili.com/video/BV1xx411c7mD', 'BV1xx411c7mD 尾随文本',
  ]) {
    const r = await post({ id: '880200', source: 'bilibili', mediaId });
    assert.equal(r.status, 400, `mediaId=${mediaId}`);
  }
  assert.equal(resolveByIdCalls.length, 0, 'URL 串不烧上游验流');
  const r = await post({ id: '880200', source: 'bilibili', mediaId: 'BV1xx411c7mD', title: 't', owner: 'o', durationSec: 200 });
  assert.equal(r.status, 200);
  assert.equal(r.body.hit.mediaId, 'BV1xx411c7mD');
  assert.equal(resolveByIdCalls[0].mediaId, 'BV1xx411c7mD');
});

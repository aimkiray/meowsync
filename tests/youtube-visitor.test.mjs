// lib/youtube.js visitorData 单飞/负缓存/TTL/abort 穿透钉。
// 被测对象用真实现（getVisitorData/fetchPlayerWith 模块私有 → 经
// fetchPlayerWith('v', sig, 'VISIONOS') 驱动），globalThis.fetch 上桩：
// - 'https://www.youtube.com' GET 首页 → 返回嵌 VISITOR_DATA 的 HTML
// - '…/youtubei/v1/player' POST → 返回 streamingData
// 每用例 delete require.cache 重载拿干净模块级缓存（vd/失败冷却/单飞簿）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const YT_PATH = '../src/server/lib/youtube.js';

const calls = [];                 // fetch 调用流水（url 字符串）
let homepageImpl = async () => ({
  ok: true, text: async () => '<x>"VISITOR_DATA":"vd-stub"</x>'
});
let playerImpl = async () => ({
  ok: true,
  json: async () => ({ playabilityStatus: { status: 'OK' }, streamingData: { adaptiveFormats: [] } })
});

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  calls.push({ url: String(url), opts });
  return String(url).includes('/youtubei/') ? playerImpl(url, opts) : homepageImpl(url, opts);
};
process.on('exit', () => { globalThis.fetch = realFetch; });

const homepageCalls = () => calls.filter(c => !c.url.includes('/youtubei/')).length;
const playerCalls = () => calls.filter(c => c.url.includes('/youtubei/')).length;
const reset = () => {
  calls.length = 0;
  homepageImpl = async () => ({ ok: true, text: async () => '<x>"VISITOR_DATA":"vd-stub"</x>' });
  playerImpl = async () => ({
    ok: true,
    json: async () => ({ playabilityStatus: { status: 'OK' }, streamingData: { adaptiveFormats: [] } })
  });
};
// 模块级 vd 缓存/失败冷却/单飞簿——每用例全新模块隔离
const freshYt = () => {
  const p = require.resolve(YT_PATH);
  delete require.cache[p];
  return require(YT_PATH);
};

test('冷缓存并发两调用单飞：首页只抓一发，两者都拿到 vd 继续走 player', async () => {
  reset();
  const yt = freshYt();
  const [a, b] = await Promise.all([
    yt.fetchPlayerWith('v1111111111', null, 'VISIONOS'),
    yt.fetchPlayerWith('v2222222222', null, 'VISIONOS'),
  ]);
  assert.equal(homepageCalls(), 1);                 // 单飞——不重复抓首页
  assert.equal(playerCalls(), 2);                   // 两路各自完成 player 请求
  assert.ok(a.streamingData && b.streamingData);
  // vd 注入 context.client.visitorData + X-Goog-Visitor-Id 头
  const post = calls.find(c => c.url.includes('/youtubei/'));
  assert.equal(post.opts.headers['X-Goog-Visitor-Id'], 'vd-stub');
  assert.equal(JSON.parse(post.opts.body).context.client.visitorData, 'vd-stub');
});

test('首页抓取失败 → 负缓存盖章，冷却期内不再白打；VISIONOS 报 vd 失败', async () => {
  reset();
  const yt = freshYt();
  homepageImpl = async () => { throw new Error('connection refused'); };
  await assert.rejects(() => yt.fetchPlayerWith('v1111111111', null, 'VISIONOS'), /visitorData/);
  assert.equal(homepageCalls(), 1);
  // 冷却期内第二调直接 null 短路——首页零重打
  await assert.rejects(() => yt.fetchPlayerWith('v2222222222', null, 'VISIONOS'), /visitorData/);
  assert.equal(homepageCalls(), 1);
});

test('vd 成功入缓存后 30min TTL 内零重抓；过期重抓', async () => {
  reset();
  const yt = freshYt();
  await yt.fetchPlayerWith('v1111111111', null, 'VISIONOS');
  await yt.fetchPlayerWith('v2222222222', null, 'VISIONOS');
  assert.equal(homepageCalls(), 1);
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 31 * 60e3;
    await yt.fetchPlayerWith('v3333333333', null, 'VISIONOS');
    assert.equal(homepageCalls(), 2);               // TTL 过期 → 重抓一次
  } finally { Date.now = realNow; }
});

test('调用方 abort 穿透：陪绑者仍吃共享结果，且结果照常回填缓存', async () => {
  reset();
  const yt = freshYt();
  // 首页抓取挂起——可控时机（先 abort 一方再放行）
  let release;
  homepageImpl = () => new Promise(r => { release = r; });
  const ctl = new AbortController();
  const doomed = yt.fetchPlayerWith('v1111111111', ctl.signal, 'VISIONOS')
    .then(() => 'resolved', (e) => `threw:${e.message}`);
  const survivor = yt.fetchPlayerWith('v2222222222', null, 'VISIONOS');
  ctl.abort();                                       // 共享抓取仍在途时断连
  release({ ok: true, text: async () => '"VISITOR_DATA":"vd-ok"' });
  assert.equal(await doomed, 'threw:aborted');       // 调用方侧 abort 穿透
  assert.ok((await survivor).streamingData);         // 陪绑者不受影响
  assert.equal(homepageCalls(), 1);
  // 结果已回填缓存——再来一发零抓取
  await yt.fetchPlayerWith('v3333333333', null, 'VISIONOS');
  assert.equal(homepageCalls(), 1);
});

test('首页响应无 VISITOR_DATA → 提取失败走负缓存', async () => {
  reset();
  const yt = freshYt();
  homepageImpl = async () => ({ ok: true, text: async () => '<html>nothing</html>' });
  await assert.rejects(() => yt.fetchPlayerWith('v1111111111', null, 'VISIONOS'), /visitorData/);
  assert.equal(homepageCalls(), 1);
});

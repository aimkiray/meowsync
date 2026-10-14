// lib/ai.js 直测钉板——该模块此前零直测，覆盖面全在各业务侧的桩后。
// settings.aiConfig 与 globalThis.fetch 全桩（无网络无 DB）；Response
// 用真身（undici 全局类）——readJsonCapped 的 stream 读径与 drain/
// arrayBuffer 都是真语义。钉点：
//   - 400/404/422 → 裸回退（response_format/reasoning_effort 剥离）
//   - 200+{error} 包络 → null；fenced/散文包 JSON → 最末平衡段胜出
//   - 429（Retry-After）/5xx/网络错 → 瞬态退避重发 ≤2 次后归 null
//   - >256KB 响应体 → 闸断归 null；signal abort → 静默 null
//   - 成功面 console.info 单行（tag/model/token/ms）留痕
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { seed } from './helpers.mjs';

const require = createRequire(import.meta.url);

// aiConfig 桩：settings 真身要 DB/env——seed 必须在 require ai.js 之前
let cfg = { baseUrl: 'http://ai.local/v1', apiKey: 'k', model: 'm-test', timeoutMs: 30000 };
seed('../src/server/lib/settings.js', { aiConfig: () => cfg });

let ai;
const calls = [];   // {url, body}——断言跳数与请求体形态
let fetchImpl = async () => { throw new Error('未桩 fetch'); };
const realFetch = globalThis.fetch;
const savedInfo = console.info;
const infos = [];
before(() => {
  globalThis.fetch = (u, o) => { calls.push({ url: String(u), body: o?.body }); return fetchImpl(u, o); };
  console.info = (...a) => infos.push(a.join(' '));
  ai = require('../src/server/lib/ai.js');
  ai._setRetryDelays([1, 1]);   // 退避缩 ~0——钉分支不钉节奏
});
after(() => {
  globalThis.fetch = realFetch;
  console.info = savedInfo;
});

// chat completions 200 包络：content 是 JSON 串（模型输出形态）
const okChat = (payload, extra = {}) => new Response(JSON.stringify({
  choices: [{ message: { content: typeof payload === 'string' ? payload : JSON.stringify(payload) },
    finish_reason: 'stop' }],
  usage: { prompt_tokens: 11, completion_tokens: 7 },
  ...extra,
}), { status: 200, headers: { 'content-type': 'application/json' } });

const ask = (o = {}) => ai.askAiJson({ system: 's', user: 'u', ...o });
const reset = () => { calls.length = 0; infos.length = 0; cfg.baseUrl = 'http://ai.local/v1'; };

test('lib-ai：response_format 400 → 裸回退成功（response_format/reasoning_effort 剥掉）', async () => {
  reset();
  fetchImpl = async (u, o) => {
    const body = JSON.parse(o.body);
    if (body.response_format) return new Response('bad param', { status: 400 });
    return okChat({ ok: true });
  };
  const r = await ask();
  assert.deepEqual(r, { ok: true });
  assert.equal(calls.length, 2);
  const bare = JSON.parse(calls[1].body);
  assert.ok(!bare.response_format && !('reasoning_effort' in bare));
});

test('lib-ai：200 + {error} 包络（聚合网关上游失败）→ null', async () => {
  reset();
  fetchImpl = async () => new Response(JSON.stringify({ error: { message: 'upstream boom' } }),
    { status: 200, headers: { 'content-type': 'application/json' } });
  const r = await ask();
  assert.equal(r, null);
  assert.equal(calls.length, 2);   // 空 content 触发过裸回退，回包同形仍 null
});

test('lib-ai：```json 围栏回答照常解析', async () => {
  reset();
  fetchImpl = async () => okChat('```json\n{"ok":true,"n":1}\n```');
  const r = await ask();
  assert.deepEqual(r, { ok: true, n: 1 });
});

test('lib-ai：散文夹多对象 → 最末平衡段胜出（示例对象在前不当答案）', async () => {
  reset();
  fetchImpl = async () => okChat('按示例 {"t":{"0":"样板"}} 回答：{"t":{"0":"真译"}}');
  const r = await ask();
  assert.deepEqual(r, { t: { '0': '真译' } });
});

test('lib-ai：429 + Retry-After → 退避重发后成功', async () => {
  reset();
  let n = 0;
  fetchImpl = async () => {
    n++;
    if (n === 1) return new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } });
    return okChat({ ok: 1 });
  };
  const r = await ask();
  assert.deepEqual(r, { ok: 1 });
  assert.equal(calls.length, 2);
});

test('lib-ai：500 连错到底 → 重试 2 次后归 null（共 3 跳）', async () => {
  reset();
  fetchImpl = async () => new Response('boom', { status: 500 });
  const r = await ask();
  assert.equal(r, null);
  assert.equal(calls.length, 3);
});

test('lib-ai：fetch 网络抛错（非 abort）→ 同瞬态重试，终 null', async () => {
  reset();
  fetchImpl = async () => { throw new TypeError('fetch failed'); };
  const r = await ask();
  assert.equal(r, null);
  assert.equal(calls.length, 3);
});

test('lib-ai：响应体超 256KB 闸 → null（不整坨进内存）', async () => {
  reset();
  // 合法 JSON 包络 + pad 填充顶过闸线——无闸时 JSON.parse 成功、content
  // 解出 {ok:1} 正常返回（旧版 invalid-JSON 体有无闸都归 null，钉不住闸）；
  // 有闸时 readJsonCapped 半路抛「响应体超限」落 catch 归 null
  fetchImpl = async () => new Response(JSON.stringify({
    choices: [{ message: { content: '{"ok":1}' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
    pad: 'x'.repeat(300 * 1024),
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  const r = await ask();
  assert.equal(r, null);
  assert.equal(calls.length, 1);
});

test('lib-ai：baseUrl 闸后热改非法 → new URL 故障标 noRetry，零退避跳数', async () => {
  reset();
  // aiEnabled() 与 postChat() 各读一次 baseUrl：首读合法放闸、再读非法——
  // 模拟并发热改竞态。getter 计数即 postChat 发起跳数（每跳必读一次
  // aiConfig）；无 noRetry 标记时同一 TypeError 会按瞬态路径退避重发 2 次
  // （reads=4），标记后直抛（reads=2）
  let reads = 0;
  Object.defineProperty(cfg, 'baseUrl', {
    configurable: true,
    get: () => (++reads === 1 ? 'http://ai.local/v1' : ':::bad'),
  });
  try {
    const r = await ask();
    assert.equal(r, null);
    assert.equal(reads, 2);          // aiEnabled 1 次 + postChat 1 次——不进重试环
    assert.equal(calls.length, 0);   // fetch 从未被达到
  } finally {
    delete cfg.baseUrl;              // 摘除 getter 恢复数据属性（后续 reset 走普通赋值）
    cfg.baseUrl = 'http://ai.local/v1';
  }
});

test('lib-ai：调用方 signal abort → 静默 null；在途挂起被 abort 打断同归 null', async () => {
  reset();
  // 预中止：fetch 看到已 aborted signal 即拒（真 fetch 同形态）
  fetchImpl = async (u, o) => {
    if (o.signal?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    return okChat({ ok: 1 });
  };
  assert.equal(await ask({ signal: AbortSignal.abort() }), null);
  // 在途挂起：signal 触发后 fetch 拒 AbortError——真实断连形态
  const ctl = new AbortController();
  fetchImpl = (u, o) => new Promise((_, rej) => {
    o.signal.addEventListener('abort', () => {
      const e = new Error('aborted'); e.name = 'AbortError'; rej(e);
    }, { once: true });
  });
  const p = ask({ signal: ctl.signal });
  ctl.abort();
  assert.equal(await p, null);
});

test('lib-ai：成功面 console.info 单行——tag/model/token/ms 齐；缺省 tag=chat', async () => {
  reset();
  fetchImpl = async () => okChat({ ok: 1 });
  await ask({ tag: 'verify' });
  await ask();
  const v = infos.find(l => l.includes('tag=verify'));
  assert.ok(v, 'verify 调用应产成功 info 行');
  assert.match(v, /^\[ai\] tag=verify model=m-test in=11 out=7 ms=\d+$/);
  const d = infos.find(l => l.includes('tag=chat'));
  assert.ok(d, '缺省 tag 应落 chat');
});

test('lib-ai：AI 未配置 → 零上行归 null（aiEnabled 闸）', async () => {
  reset();
  cfg.baseUrl = '';
  const r = await ask();
  assert.equal(r, null);
  assert.equal(calls.length, 0);
});

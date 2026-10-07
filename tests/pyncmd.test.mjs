// unlock/pyncmd.js 第三方 API 防御钉：redirect:'manual' 不裸跟跳转 +
// 响应体 2MB 闸（超限 cancel 拒收）+ 正常形态解析回链。
// globalThis.fetch 上桩——新 Response 的 body 是真 ReadableStream，
// 走 readJsonCapped 的 stream 分支而非桩降级的 res.json()。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolve } = require('../src/server/services/unlock/pyncmd.js');

const realFetch = globalThis.fetch;
let recordedOpts = null;
let fetchImpl = async () => new Response(
  JSON.stringify({ url: 'https://m701.music.126.net/x.mp3', br: 320, size: 9999 }),
  { status: 200 });
globalThis.fetch = async (url, opts) => { recordedOpts = { url: String(url), opts }; return fetchImpl(url, opts); };
after(() => { globalThis.fetch = realFetch; });

test('正常回包：{url,br,size} 解析且请求带 redirect:manual', async () => {
  const r = await resolve({ id: 123 }, {});
  assert.equal(r.url, 'https://m701.music.126.net/x.mp3');
  assert.equal(r.br, 320000);
  assert.equal(r.size, 9999);
  assert.equal(recordedOpts.opts.redirect, 'manual',
    '第三方 API 无合法跳转语义——必须 manual 不裸跟');
});

test('响应体超 2MB：cancel 拒收抛错，不整坨进内存', async () => {
  const big = Buffer.alloc(2 * 1024 * 1024 + 1, 0x61); // 2MB+1
  fetchImpl = async () => new Response(big, { status: 200 });
  await assert.rejects(() => resolve({ id: 456 }, {}), /响应体超限/);
});

test('3xx 不裸跟——manual 下 302 显式落 HTTP 错误走「源失败换下一源」', async () => {
  fetchImpl = async () => new Response(null, {
    status: 302, headers: { location: 'https://evil.example/x.mp3' } });
  await assert.rejects(() => resolve({ id: 789 }, {}), /HTTP 302/);
});

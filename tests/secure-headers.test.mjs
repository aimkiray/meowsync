// secure-headers 收紧后钉板（U5）：CSP 全文逐条断言 + index.html 内联脚本
// sha256 实算比对（漂移钉板——改脚本忘重算会让生产首帧被 CSP 掐死，此处
// 直接翻车）；img/media/font/style 不得含 http:/https: 源站字面量与
// googleapis/gstatic；connect-src 保四协议跨源兼容位；非 HTML 响应无 CSP；
// /audio-proxy 路径与反代预置 CSP 两条逃逸面同步钉住。
// 最小 Hono app 只挂 secureHeaders 一个中间件，app.request 直发不走网络。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const { Hono } = require('hono');
const { secureHeaders } = require('../src/server/lib/secure-headers.js');

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

let app;
before(() => {
  app = new Hono();
  app.use('*', secureHeaders());
  app.get('/', (c) => c.html('<html><body>x</body></html>'));
  app.get('/api/json', (c) => c.json({ ok: true }));
  app.get('/audio-proxy', (c) => c.text('proxied'));
  // 反代预置 CSP 的逃逸口形态：响应自带 CSP 时中间件整段不覆写
  app.get('/preset-csp', (c) => {
    c.header('Content-Security-Policy', "media-src 'self' https:");
    return c.html('<html></html>');
  });
});

const cspOf = async (path) =>
  (await app.request(`http://t${path}`)).headers.get('content-security-policy');

test('HTML 响应 CSP 全文钉板（收紧后 canonical 形）', async () => {
  assert.equal(await cspOf('/'), [
    "default-src 'self'",
    "script-src 'self' 'sha256-pADVm4OreZWjbx4BMy3eguDHGUp6u17ELX/GgnIjmfQ='",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob: data:",
    "font-src 'self' data:",
    "connect-src 'self' http: https: ws: wss:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; '));
});

test('script-src sha256 与 index.html 内联脚本体实算一致（防漂移）', async () => {
  // CSP 的 sha256 源是 <script> 开闭标签之间的原始字节（含缩进换行）——
  // 必须从文件实算而非复刻字面量，否则本测试自己也会随脚本漂移
  const bodies = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(bodies.length, 1, 'index.html 应恰有一段内联脚本；新增段需各自挂 hash');
  const expectHash = `'sha256-${createHash('sha256').update(bodies[0], 'utf8').digest('base64')}'`;
  const csp = await cspOf('/');
  assert.ok(
    csp.includes(`script-src 'self' ${expectHash}`),
    `script-src 不含实算 hash ${expectHash}——index.html 脚本体已漂移`,
  );
});

test('img/media/font/style 无 http:/https: 字面量；全表无 googleapis/gstatic', async () => {
  const csp = await cspOf('/');
  assert.ok(!/googleapis|gstatic/i.test(csp), 'CSP 不得残留 Google Fonts 域');
  for (const d of ['img-src', 'media-src', 'font-src', 'style-src']) {
    const m = csp.match(new RegExp(`${d} ([^;]*)`));
    assert.ok(m, `${d} 指令缺失`);
    assert.ok(
      !/\bhttps?:/.test(m[1]),
      `${d} 不得含 http:/https: 源站字面量——实得 "${m[1]}"`,
    );
  }
});

test('connect-src 保留 http/https/ws/wss 四协议（VITE_API_BASE_URL 跨源兼容位）', async () => {
  const m = (await cspOf('/')).match(/connect-src ([^;]*)/);
  assert.ok(m, 'connect-src 指令缺失');
  const tokens = m[1].trim().split(/\s+/);
  for (const t of ["'self'", 'http:', 'https:', 'ws:', 'wss:']) {
    assert.ok(tokens.includes(t), `connect-src 缺 ${t}——实得 "${m[1]}"`);
  }
});

test('非 HTML 响应不写 CSP（基线安全头照下）；/audio-proxy 路径整条跳过', async () => {
  const api = await app.request('http://t/api/json');
  assert.equal(api.headers.get('content-security-policy'), null);
  assert.equal(api.headers.get('x-content-type-options'), 'nosniff');

  // /audio-proxy 有自己的独立头面（CSP sandbox + ACAO:* 由 proxy.js 下发），
  // 全局中间件连 nosniff 都不该插手——钉「整条 return」语义
  const proxy = await app.request('http://t/audio-proxy');
  assert.equal(proxy.headers.get('content-security-policy'), null);
  assert.equal(proxy.headers.get('x-content-type-options'), null);
});

test('反代预置 CSP 逃逸口：响应已有 CSP 时中间件不覆写', async () => {
  const res = await app.request('http://t/preset-csp');
  assert.equal(res.headers.get('content-security-policy'), "media-src 'self' https:");
});

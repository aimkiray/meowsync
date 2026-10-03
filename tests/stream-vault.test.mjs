// server/lib/stream-vault.js 回归网——opaque token / TTL / LRU 语义
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mint, resolve } = require('../src/server/lib/stream-vault.js');

test('mint→resolve 往返；token 是 192bit opaque（不含原 URL 痕迹）', () => {
  const url = 'https://isure.stream.qqmusic.qq.com/fcg?uin=87123&vkey=secret';
  const token = mint(url);
  assert.ok(/^[A-Za-z0-9_-]{32}$/.test(token));
  assert.ok(!token.includes('uin'));
  // 候选链形态：单 URL 也归一成 {urls, idx}——代理侧据 idx 钉住可用档
  assert.deepEqual(resolve(token).urls, [url]);
  assert.equal(resolve(token).idx, 0);
});

test('mint 支持候选数组（同字节镜像组——bilibili baseUrl/backup_url 先例）', () => {
  const urls = ['https://a.example/1', 'https://a.example/2'];
  const token = mint(urls);
  const entry = resolve(token);
  assert.deepEqual(entry.urls, urls);
  entry.idx = 1; // 代理成功钉位——下次 resolve 同 entry 读到
  assert.equal(resolve(token).idx, 1);
});

test('mint 空候选数组 → null（路由据此回 404 而不是 mint 出废 token）', () => {
  assert.equal(mint([]), null);
  assert.equal(mint(['']), null);
});

test('未发行 token → null（不返回 500 猜测面）', () => {
  assert.equal(resolve('a'.repeat(32)), null);
  assert.equal(resolve(''), null);
  assert.equal(resolve(null), null);
});

test('TTL：过期 token 惰性清除；滑动续期生效', () => {
  const dead = mint('https://x', { ttlMs: -1 });
  assert.equal(resolve(dead), null); // 已过滑动窗
  const live = mint('https://y', { ttlMs: 60_000 });
  assert.deepEqual(resolve(live).urls, ['https://y']);
});

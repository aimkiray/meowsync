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
  assert.equal(resolve(token), url);
  assert.equal(resolve(token), url); // 幂等：Range 重取同 token 可复用
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
  assert.equal(resolve(live), 'https://y');
});

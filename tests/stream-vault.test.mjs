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

test('绝对上限 24h：notAfter 越过即死，滑动窗还活着也救不回', () => {
  const realNow = Date.now;
  try {
    // 铸造时刻回拨 25h；ttlMs 26h 让 expiresAt 尚在 +1h——死掉只能
    // 是 notAfter（mint+24h = -1h）独立生效，不是滑动窗到期
    Date.now = () => realNow() - 25 * 3600e3;
    const dead = mint('https://vault-25h', { ttlMs: 26 * 3600e3 });
    Date.now = realNow;
    assert.equal(resolve(dead), null);

    // 23h 前铸造（ttlMs 24h → expiresAt=+1h）仍在硬顶窗内 → 活
    Date.now = () => realNow() - 23 * 3600e3;
    const alive = mint('https://vault-23h', { ttlMs: 24 * 3600e3 });
    Date.now = realNow;
    assert.deepEqual(resolve(alive).urls, ['https://vault-23h']);
  } finally {
    Date.now = realNow;
  }
});

test('LRU：满容 2048 逐最旧；resolve touch 把活跃 token 挪出淘汰线', () => {
  const old = mint('https://vault-old');            // 注定最早被淘汰
  const fill = [];
  for (let i = 0; i < 2050; i++) fill.push(mint(`https://vault-f${i}`));
  // 2048 封顶：存量+2050 溢出，插入序最前的依次出局——old 与 fill[0..1]
  // 已被逐（老条目先垫背），fill[2] 起为现存最旧
  assert.equal(resolve(old), null);
  assert.equal(resolve(fill[0]), null);
  assert.equal(resolve(fill[1]), null);

  const oldest = fill[2];
  assert.ok(resolve(oldest));                        // touch → 移到插入序尾
  const victim = fill[3];                            // 现存最旧让位给 oldest
  const late = mint('https://vault-late');           // 满容再 mint：逐最旧
  assert.equal(resolve(victim), null);               // 被淘汰的是 victim
  assert.ok(resolve(oldest));                        // touch 过的活着
  assert.ok(resolve(late));
});

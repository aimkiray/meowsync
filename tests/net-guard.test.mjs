// makeGuardedLookup family 落空 fail-closed 钉（F5）：指定 family 无匹配
// 记录即 ERR_DNS_GUARD_BLOCKED——静默回落全表会把要求 v6 的连接绑到 v4
// （或反向），family 语义被架空。首查与 pin 表复用两条路径同口径。
// dns 是 CJS 内建模块——require.cache 预播种生效（resolve 后先查缓存）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { seed } from './helpers.mjs';

const require = createRequire(import.meta.url);

// 域名恒定只有一条公网 v4——family:6 请求必须拒而非回落
const V4 = { address: '93.184.216.34', family: 4 };
seed('dns', {
  lookup: (host, opts, cb) => {
    if (opts && opts.all) process.nextTick(() => cb(null, [V4]));
    else process.nextTick(() => cb(null, V4.address, V4.family));
  },
  promises: { lookup: async () => [V4] },
});

const { makeGuardedLookup } = require('../src/server/lib/net-guard.js');
// lookup 回调签名归一：(hostname, options) → {err|args}
const call = (lookup, hostname, options) => new Promise((resolve) => {
  lookup(hostname, options, (...a) => resolve(a));
});

test('family:6 请求对纯 v4 域名 fail closed——不回落另一族', async () => {
  const lookup = makeGuardedLookup();
  const [err] = await call(lookup, 'v4-only.test', { family: 6 });
  assert.equal(err.code, 'ERR_DNS_GUARD_BLOCKED');
  assert.match(err.message, /family=6/);
});

test('pin 表路径同口径：先 v4 钉住，后 family:6 复查仍拒', async () => {
  const lookup = makeGuardedLookup();
  // 首查 all：钉住 [v4]
  const [, list] = await call(lookup, 'v4-only.test', { all: true });
  assert.deepEqual(list, [V4]);
  // 复用 pin 的 family:6 建连——同样拒绝
  const [err] = await call(lookup, 'v4-only.test', { all: true, family: 6 });
  assert.equal(err.code, 'ERR_DNS_GUARD_BLOCKED');
  // family:4 正常放行——过滤不误伤匹配族
  const [err4, list4] = await call(lookup, 'v4-only.test', { all: true, family: 4 });
  assert.equal(err4, null);
  assert.deepEqual(list4, [V4]);
});

test('非 all 单地址回调签名不变', async () => {
  const lookup = makeGuardedLookup();
  const [err, addr, family] = await call(lookup, 'v4-only.test', {});
  assert.equal(err, null);
  assert.equal(addr, V4.address);
  assert.equal(family, 4);
});

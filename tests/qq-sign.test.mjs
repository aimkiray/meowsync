// lib/qq.js zzc 签名 golden 钉：SHA1 重组参数（PART1/PART2/SCRAMBLE）
// 任一字节漂移都会换签名串——musics.fcg 风控升级通道静默全灭。
// 向量来源：jixunmoe/qmweb-sign（MIT）、lx-music tx/utils/crypto.js、
// netease-qq-music-api tencent/utils.rs 三处独立实现互证。
// settings 预播种隔离凭据面（同 qq-inflight 惯例——离网可跑）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { seed, tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-qq-sign-');
const require = createRequire(import.meta.url);

seed('../src/server/lib/settings.js', {
  effectiveValue: () => null,
  qqCookieOverride: () => '',
  persistRenewedQqCookie: () => {},
});

const { zzcSign } = require('../src/server/lib/qq.js');

test('zzcSign golden：zzcSign("123") 与上游三源实现输出对拍', () => {
  assert.equal(
    zzcSign('123'),
    'zzcec1b555gzqzg7laztguyjl2bu20r6x1w50c55f60',
  );
});

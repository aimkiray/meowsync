// 自研 NetEase 层回归：端点表↔路由白名单一致性、候选时长匹配、
// cookie 解析、envelope 语义。离网可跑——加密正确性由 netease-crypto.test.mjs 对拍
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ENDPOINTS } = require('../src/server/services/netease/endpoints.js');
const { ALLOWED_APIS } = require('../src/server/routes/music.js');
const { pickByDuration } = require('../src/server/services/unlock/match.js');
const { cookieToJson, cookieObjToString } = require('../src/server/services/netease/request.js');
const { PROVIDERS, PLAYBACK_SOURCES, DOWNLOAD_SOURCES } = require('../src/server/services/unlock/index.js');

test('端点表覆盖白名单且名称双向一致', () => {
  for (const name of ALLOWED_APIS) {
    assert.ok(ENDPOINTS[name], `白名单端点 ${name} 缺实现`);
    assert.equal(typeof ENDPOINTS[name].handler, 'function');
  }
  for (const name of Object.keys(ENDPOINTS)) {
    assert.ok(ALLOWED_APIS.has(name), `端点 ${name} 不在白名单——会成未鉴权面`);
  }
});

test('pickByDuration：±5s 内命中、跨窗拒绝、无基准放前三', () => {
  const cands = [{ s: 100 }, { s: 200 }, { s: 322 }, { s: 400 }];
  const got = pickByDuration(cands, 326000, c => c.s);
  assert.deepEqual(got, [{ s: 322 }]);
  // 全部超窗 → 空（不回退首条——unm 的 list[0] 兜底是错配主源）
  assert.deepEqual(pickByDuration(cands, 60000, c => c.s), []);
  // 基准缺失 → 前 3 条原序放行（交给下游对账）
  assert.deepEqual(pickByDuration(cands, null, c => c.s), cands.slice(0, 3));
  // 候选缺时长字段不命中
  assert.deepEqual(pickByDuration([{ s: null }], 326000, c => c.s), []);
});

test('解锁源梯队只引用已注册 provider', () => {
  for (const s of [...PLAYBACK_SOURCES, ...DOWNLOAD_SOURCES]) {
    assert.ok(PROVIDERS[s], `梯队引用了不存在的 provider: ${s}`);
    assert.equal(typeof PROVIDERS[s].resolve, 'function');
  }
});

test('cookieToJson 复刻上游「恰一个等号」语义', () => {
  assert.deepEqual(cookieToJson('a=1; b=2'), { a: '1', b: '2' });
  // base64 值（多等号）按上游 split('=').length==2 口径丢弃
  assert.deepEqual(cookieToJson('x=abc=='), {});
  assert.deepEqual(cookieToJson('MUSIC_U=deadbeef; k=v=1'), { MUSIC_U: 'deadbeef' });
  assert.deepEqual(cookieToJson(''), {});
});

test('cookieObjToString 键值均 encodeURIComponent', () => {
  assert.equal(cookieObjToString({ a: 'x y', 'k;k': 'v' }), 'a=x%20y; k%3Bk=v');
});

test('端点 crypto 通道分布与上游一致（eapi 默认 / weapi 显式）', () => {
  const weapi = Object.keys(ENDPOINTS).filter(n => ENDPOINTS[n].crypto === 'weapi').sort();
  assert.deepEqual(weapi, ['album', 'artists', 'check_music', 'personalized', 'search_suggest', 'song_detail'].sort());
});

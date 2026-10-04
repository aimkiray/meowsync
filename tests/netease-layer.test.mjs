// 自研 NetEase 层回归：端点表↔路由白名单一致性、候选时长匹配、
// cookie 解析、envelope 语义。离网可跑——加密正确性由 netease-crypto.test.mjs 对拍
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { tmpDataDir } from './helpers.mjs';

// qqCookie/biliCookie 经 settings 层读 app_settings——不隔离 DATA_DIR 会
// 开真实 dev 库（续期测试的 persistRenewedQqCookie 可能覆盖真凭据）
process.env.DATA_DIR = tmpDataDir('meowsync-netlayer-');
const require = createRequire(import.meta.url);
const { ENDPOINTS } = require('../src/server/services/netease/endpoints.js');
const { ALLOWED_APIS } = require('../src/server/routes/music.js');
const { pickByDuration } = require('../src/server/services/unlock/match.js');
const { cookieToJson, cookieObjToString } = require('../src/server/services/netease/request.js');
const { PROVIDERS, PLAYBACK_SOURCES, DOWNLOAD_SOURCES } = require('../src/server/services/unlock/index.js');
const { hasQqCookie } = require('../src/server/lib/qq.js');
const { isApiPath } = require('../src/server/lib/api-path.js');

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

// 回归钉：qqCookie→maybeRenewQqCookie→qqCookie 曾互递归（cookie 非空即栈溢出，
// 所有 QQ 功能在配了 QQ_COOKIE 的部署下静默全灭——恰是续期要保护的路径）
test('qqCookie 非空路径不递归（惰性续期只读快照不回读）', () => {
  const saved = { QQ_COOKIE: process.env.QQ_COOKIE, NEW_QQ_COOKIE: process.env.NEW_QQ_COOKIE };
  // createtime 远在未来 → 在生命周期内不触发续期外呼
  process.env.QQ_COOKIE = 'uin=o0123; musickey_createtime=9999999999; qm_keyst=abc; qqrefresh_token=rt';
  delete process.env.NEW_QQ_COOKIE;
  try {
    assert.equal(hasQqCookie(), true);
  } finally {
    if (saved.QQ_COOKIE === undefined) delete process.env.QQ_COOKIE;
    else process.env.QQ_COOKIE = saved.QQ_COOKIE;
    if (saved.NEW_QQ_COOKIE === undefined) delete process.env.NEW_QQ_COOKIE;
    else process.env.NEW_QQ_COOKIE = saved.NEW_QQ_COOKIE;
  }
});

// isApiPath 收口钉：摘除的上游路由家族仍判 API（JSON 404），SPA 路径不被误伤
test('isApiPath：旧上游家族判 API，SPA/静态与真端点不误伤', () => {
  for (const p of ['/login/qr/check', '/user/detail', '/playlist/create', '/comment/like']) {
    assert.equal(isApiPath(p), true, `${p} 应判为 API 路径`);
  }
  // 真端点与自有前缀仍在
  assert.equal(isApiPath('/song_url'), true);
  assert.equal(isApiPath('/downloads/list'), true);
  assert.equal(isApiPath('/settings'), true);
  assert.equal(isApiPath('/settings/ai-test'), true);
  // SPA 壳与未知前端路径仍非 API（/settings 已是自有 API 前缀——不能作反例）
  for (const p of ['/', '/index.html', '/assets/index.js', '/settings-page']) {
    assert.equal(isApiPath(p), false, `${p} 不应判为 API`);
  }
});

// 续期 fire 路径回归钉：真实 QQ cookie 的 refresh 键是 psrf_qqrefresh_token
// （unm 靠无锚定子串命中），锚定 cookieVal 曾让续期对文档化形态整链失效；
// createtime 到期 + fetch stub 回新 key → NEW_QQ_COOKIE 四键重写
test('QQ 续期：psrf_qqrefresh_token 命中 + 按名重写 NEW_QQ_COOKIE', async () => {
  const saved = {
    QQ_COOKIE: process.env.QQ_COOKIE,
    NEW_QQ_COOKIE: process.env.NEW_QQ_COOKIE,
    fetch: globalThis.fetch,
  };
  // musickey_createtime 极旧 → 必然落在续期窗内
  process.env.QQ_COOKIE = 'uin=o123456; psrf_qqrefresh_token=RT_OLD; qqmusic_key=MK_OLD; '
    + 'musickey_createtime=1; psrf_musickey_createtime=1';
  delete process.env.NEW_QQ_COOKIE;
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    seen.push({ url, body: opts?.body });
    return new Response(JSON.stringify({
      req: { code: 0, data: { musickey: 'MK_NEW', musickeyCreateTime: 1999999999 } },
    }), { status: 200 });
  };
  try {
    assert.equal(hasQqCookie(), true); // 惰性触发续期
    // 等 microtask+inflight 完成：轮询落证而非定长 sleep——慢机上 50ms
    // 偶发不够（续期写回在 fetch resolve 后的 microtask 里）
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline &&
           !(seen.length === 1 && process.env.NEW_QQ_COOKIE)) {
      await new Promise(r => setTimeout(r, 10));
    }
    assert.equal(seen.length, 1, '应恰好一次 LoginServer 外呼');
    assert.match(seen[0].url, /u\.y\.qq\.com/);
    const sent = JSON.parse(seen[0].body);
    assert.equal(sent.req.param.refresh_token, 'RT_OLD'); // psrf_ 键被命中
    assert.equal(sent.req.param.musickey, 'MK_OLD');
    assert.equal(sent.req.param.musicid, 123456); // uin=o123456 剥前缀
    const renewed = process.env.NEW_QQ_COOKIE || '';
    assert.match(renewed, /qqmusic_key=MK_NEW/);
    assert.match(renewed, /qm_keyst=MK_NEW/); // 缺失键补尾
    assert.match(renewed, /musickey_createtime=1999999999/);
    assert.match(renewed, /psrf_qqrefresh_token=RT_OLD/); // 无轮换应答则保留
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.QQ_COOKIE === undefined) delete process.env.QQ_COOKIE;
    else process.env.QQ_COOKIE = saved.QQ_COOKIE;
    if (saved.NEW_QQ_COOKIE === undefined) delete process.env.NEW_QQ_COOKIE;
    else process.env.NEW_QQ_COOKIE = saved.NEW_QQ_COOKIE;
  }
});

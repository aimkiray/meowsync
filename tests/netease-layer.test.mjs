// 自研 NetEase 层回归：端点表↔路由白名单一致性、候选时长匹配、
// cookie 解析、envelope 语义。离网可跑——明文 /api 通道化后无加密面需对拍
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { tmpDataDir } from './helpers.mjs';

// qqCookie/biliCookie 经 settings 层读 app_settings——不隔离 DATA_DIR 会
// 开真实 dev 库（续期测试的 persistRenewedQqCookie 可能覆盖真凭据）
process.env.DATA_DIR = tmpDataDir('meowsync-netlayer-');
const require = createRequire(import.meta.url);
const { ENDPOINTS } = require('../src/server/services/netease/endpoints.js');
const { callNeteaseApi } = require('../src/server/services/netease/index.js');
const { ALLOWED_APIS } = require('../src/server/routes/music.js');
const { pickByDuration, degradedKeyword } = require('../src/server/services/unlock/match.js');
const { cookieToJson, cookieObjToString } = require('../src/server/services/netease/request.js');
const { PROVIDERS, PLAYBACK_SOURCES, DOWNLOAD_SOURCES } = require('../src/server/services/unlock/index.js');
const { hasQqCookie } = require('../src/server/lib/qq.js');
const { isApiPath } = require('../src/server/lib/api-path.js');

test('端点表覆盖白名单且名称双向一致', () => {
  for (const name of ALLOWED_APIS) {
    assert.ok(ENDPOINTS[name], `白名单端点 ${name} 缺实现`);
    assert.equal(typeof ENDPOINTS[name].handler, 'function');
  }
  // lyric_new 早已摘除；song_url_v1/check_music/album/artists/banner/toplist
  // 本轮同因摘——零前端消费，收白名单攻击面。ENDPOINTS 定义保留作进程内/
  // 兼容留档；白名单外端点路由层直回 404，天然不在鉴权面上
  const NOT_PASSED_THROUGH = new Set([
    'lyric_new', 'song_url_v1', 'check_music', 'album', 'artists', 'banner', 'toplist',
  ]);
  for (const name of Object.keys(ENDPOINTS)) {
    if (NOT_PASSED_THROUGH.has(name)) continue;
    assert.ok(ALLOWED_APIS.has(name), `端点 ${name} 存在但未做白名单登记决策`);
  }
  // 反向钉：摘除名不得回白名单——正向循环对它们 continue，摘名复活进
  // ALLOWED_APIS 时上面断言照样全绿，只有这里能红（lyric_new 同罩住）
  for (const n of NOT_PASSED_THROUGH) {
    assert.ok(!ALLOWED_APIS.has(n), `端点 ${n} 复活进白名单`);
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

// 搜索真空降级词钉板：youtube/bilibili 两源共用同一实现（match.js）——
// 剥尾缀括号群重建 name - artists；词中括号、剥后分隔符尾、无 artists
// 形态逐钉
test('degradedKeyword：只剥尾段连续括号群，重建 name - artists', () => {
  const info = (name, artists, keyword) => ({ name, artists, keyword });
  assert.equal(
    degradedKeyword(info('ぱられループ を歌ってみた (2024 Radio Edit)', ['Jeku'])),
    'ぱられループ を歌ってみた - Jeku');
  // 连续尾缀括号群整串剥掉 + 全/半角混排
  assert.equal(degradedKeyword(info('曲名【Cover】(2024 Remaster)', ['a'])), '曲名 - a');
  // 剥后残留分隔符尾一并清（「曲名 - (Live)」→「曲名」）
  assert.equal(degradedKeyword(info('曲名 - (Live)', ['a'])), '曲名 - a');
  // 词中括号是合法本名成分不剥
  assert.equal(degradedKeyword(info('Song (feat. X) 尾', ['a'])), 'Song (feat. X) 尾 - a');
  // 无 artists → 裸 name 形态
  assert.equal(degradedKeyword(info('曲名 (Live)', [])), '曲名');
  // 无尾缀括号原样重建（调用方据此与 keyword 比对判「无可剥」省第二跳）
  assert.equal(degradedKeyword(info('繭色', ['sajou no hana'])), '繭色 - sajou no hana');
});

test('解锁源梯队只引用已注册 provider，序为 pyncmd→youtube→bilibili', () => {
  // 序即降级链：pyncmd 直解优先，youtube 兜底，bilibili 第三源收尾——
  // 顺序错排会让更薄/更敏感的匿名面先挨打
  assert.deepEqual(PLAYBACK_SOURCES, ['pyncmd', 'youtube', 'bilibili']);
  assert.deepEqual(DOWNLOAD_SOURCES, ['pyncmd', 'youtube', 'bilibili']);
  for (const s of [...PLAYBACK_SOURCES, ...DOWNLOAD_SOURCES]) {
    assert.ok(PROVIDERS[s], `梯队引用了不存在的 provider: ${s}`);
    assert.equal(typeof PROVIDERS[s].resolve, 'function');
    // forgetSong 是可选钩（编排层 p?.forgetSong?.() 调用）——pyncmd 无态不提供；
    // 提供了就必须是函数（签名面钉板）
    if (PROVIDERS[s].forgetSong !== undefined) {
      assert.equal(typeof PROVIDERS[s].forgetSong, 'function', `${s}.forgetSong 须为函数`);
    }
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

// 明文 /api 通道钉板：迁移后端点表不得残留 crypto 死元数据——重新引入
// 通道字段说明有人复活了加密分支（request() 签名已无 crypto 入参）
test('端点表无 crypto 字段——明文 /api 通道化后通道元数据已退役', () => {
  for (const [name, ep] of Object.entries(ENDPOINTS)) {
    assert.equal(ep.crypto, undefined, `${name} 不应带 crypto 字段`);
    assert.deepEqual(Object.keys(ep), ['handler'], `${name} 应只剩 handler`);
  }
});

// 门面存在性判定必须走 Object.hasOwn——裸索引（ENDPOINTS[name]）下
// 'constructor'/'hasOwnProperty' 等原型键 truthy，会越过 not found 检查
// 拿 Function 当 ep 后崩 TypeError（路由层包装成 500 假错而非 404 语义）。
// 钉死「原型键名 → Error('API ... not found')」而非原型遮蔽崩溃
test('callNeteaseApi：原型键名拒作端点——Error not found 而非 TypeError 崩', async () => {
  for (const name of ['constructor', 'hasOwnProperty', '__proto__', 'toString']) {
    await assert.rejects(
      callNeteaseApi(name, {}),
      (err) => err instanceof Error && !(err instanceof TypeError)
        && err.message === `API '${name}' not found`,
      name,
    );
  }
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

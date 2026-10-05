// lib/youtube.js YT_COOKIE 登录态钉：认证 WEB 档插链条件（有/无 cookie）、
// SAPISID*HASH 三 scheme 段拼装逐字节口径（yt-dlp 同款 ts_sha1 + ' '.join）、
// 键缺席略段/全缺降级、签名料尾空格剔除、Origin/X-Origin 伴随头、
// search/browse 链共用认证档、cookie ASCII 消毒、认证档失败轮转且凭据
// 不渗匿名档/日志、browse 认证档失败回落匿名档（ALERT_ERROR 终态不重打）。
// lib/settings 预播种 stub 控 yt_cookie 生效值——真 settings 会经
// repositories 开 dev DB。globalThis.fetch 上桩录请求头断言凭据走向；
// 每用例 delete require.cache 重载拿干净模块级告警去重簿。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { seed } from './helpers.mjs';

const require = createRequire(import.meta.url);
const YT_PATH = '../src/server/lib/youtube.js';

let cookieValue = '';              // settings stub 的 yt_cookie 生效值
seed('../src/server/lib/settings.js', {
  effectiveValue: (k) => (k === 'yt_cookie' && cookieValue ? cookieValue : null),
});

const calls = [];                  // fetch 调用流水 {url, opts}
const warns = [];                  // console.warn 捕获（凭据不泄漏断言面）
let homepageImpl = async () => ({
  ok: true, text: async () => '<x>"VISITOR_DATA":"vd-stub"</x>'
});
let playerImpl = async () => ({
  ok: true,
  json: async () => ({ playabilityStatus: { status: 'OK' }, streamingData: { adaptiveFormats: [] } })
});

const realFetch = globalThis.fetch;
const realWarn = console.warn;
globalThis.fetch = async (url, opts) => {
  calls.push({ url: String(url), opts });
  return String(url).includes('/youtubei/') ? playerImpl(url, opts) : homepageImpl(url, opts);
};
console.warn = (...a) => { warns.push(a.map(String).join(' ')); };
process.on('exit', () => { globalThis.fetch = realFetch; console.warn = realWarn; });

const playerCalls = () => calls.filter(c => c.url.includes('/youtubei/v1/player'));
const reset = () => {
  calls.length = 0;
  warns.length = 0;
  cookieValue = '';
  homepageImpl = async () => ({ ok: true, text: async () => '<x>"VISITOR_DATA":"vd-stub"</x>' });
  playerImpl = async () => ({
    ok: true,
    json: async () => ({ playabilityStatus: { status: 'OK' }, streamingData: { adaptiveFormats: [] } })
  });
};
// 模块级告警去重簿（ytCookieWarned/sapisidWarnedFor）——每用例全新模块隔离
const freshYt = () => {
  const p = require.resolve(YT_PATH);
  delete require.cache[p];
  return require(YT_PATH);
};
// 钉死 ts 后逐字节重算——签名头断言不走「模式匹配像就行」，要算对
const frozenNow = () => 1_700_000_000_000;
const segAuth = (scheme, sapisid) => `${scheme} 1700000000_${createHash('sha1')
  .update(`1700000000 ${sapisid} https://www.youtube.com`).digest('hex')}`;

test('无 YT_COOKIE：轮替链首仍是 ANDROID 且不带任何凭据头', async () => {
  reset();
  const yt = freshYt();
  assert.equal(yt.hasYtCookie(), false);
  await yt.fetchPlayer('vidcookie00a', null);
  assert.equal(playerCalls().length, 1);
  const h = playerCalls()[0].opts.headers;
  assert.equal(h['X-YouTube-Client-Name'], '3');       // ANDROID 链首不变
  assert.ok(!('Cookie' in h) && !('Authorization' in h));
});

test('YT_COOKIE 在位：WEB_AUTH 档排头，Cookie+SAPISIDHASH 逐字节正确', async () => {
  reset();
  cookieValue = 'SAPISID=sapisid-val; SID=sid-val';
  const yt = freshYt();
  assert.equal(yt.hasYtCookie(), true);
  const realNow = Date.now;
  try {
    Date.now = frozenNow;
    await yt.fetchPlayer('vidcookie00b', null);
  } finally { Date.now = realNow; }
  assert.equal(playerCalls().length, 1);               // 首档即成——不烧匿名档
  const h = playerCalls()[0].opts.headers;
  assert.equal(h['X-YouTube-Client-Name'], '1');       // WEB 形态
  assert.equal(h['X-YouTube-Client-Version'], '2.20260708.00.00');
  assert.equal(h.Cookie, cookieValue);
  assert.equal(h.Authorization, segAuth('SAPISIDHASH', 'sapisid-val'));
  // Origin/X-Origin 双头并发（yt-dlp/真实浏览器同款伴随头）
  assert.equal(h.Origin, 'https://www.youtube.com');
  assert.equal(h['X-Origin'], 'https://www.youtube.com');
  // UA 与 DESKTOP_UA 一致是风控校验点（auth↔UA↔context.client 一致性）
  assert.match(h['User-Agent'], /^Mozilla\/5\.0 \(Macintosh/);
});

test('SAPISID 三键各产各的 scheme 段、空格 join 拼装（yt-dlp 同款）', async () => {
  reset();
  const yt = freshYt();
  const realNow = Date.now;
  try {
    Date.now = frozenNow;
    // 三键并存 → 三段全出：SAPISID→SAPISIDHASH、1P→1PHASH、3P→3PHASH
    cookieValue = '__Secure-1PAPISID=v1p; SAPISID=main-sid; __Secure-3PAPISID=v3p';
    await yt.fetchPlayer('vidcookie00c', null);
    assert.equal(playerCalls().at(-1).opts.headers.Authorization,
      `${segAuth('SAPISIDHASH', 'main-sid')} ${segAuth('SAPISID1PHASH', 'v1p')} ${segAuth('SAPISID3PHASH', 'v3p')}`);
    // SAPISID 本体缺席 → 3P 顶位进 SAPISIDHASH，自身 3PHASH 段照产
    calls.length = 0;
    cookieValue = '__Secure-1PAPISID=v1p; __Secure-3PAPISID=v3p';
    await yt.fetchPlayer('vidcookie00d', null);
    assert.equal(playerCalls().at(-1).opts.headers.Authorization,
      `${segAuth('SAPISIDHASH', 'v3p')} ${segAuth('SAPISID1PHASH', 'v1p')} ${segAuth('SAPISID3PHASH', 'v3p')}`);
    // 只带 1P 变体 → 仅 SAPISID1PHASH 段（缺席键不占位）
    calls.length = 0;
    cookieValue = '__Secure-1PAPISID=v1p; OTHER=x';
    await yt.fetchPlayer('vidcookie00e', null);
    assert.equal(playerCalls().at(-1).opts.headers.Authorization, segAuth('SAPISID1PHASH', 'v1p'));
    // "SAPISID=abc ;SID=x" 尾空格不进签名料（[^;]+ 捕获后 trim）
    calls.length = 0;
    cookieValue = 'SAPISID=abc ; SID=x';
    await yt.fetchPlayer('vidcookie00f', null);
    assert.equal(playerCalls().at(-1).opts.headers.Authorization, segAuth('SAPISIDHASH', 'abc'));
  } finally { Date.now = realNow; }
});

test('cookie 缺 SAPISID 系键：Authorization 省略 Cookie 照发，warn 一次且不含凭据', async () => {
  reset();
  cookieValue = 'SID=only-sid; HSID=h-val';
  const yt = freshYt();
  await yt.fetchPlayer('vidcookie00f', null);
  const h = playerCalls()[0].opts.headers;
  assert.equal(h.Cookie, cookieValue);
  assert.ok(!('Authorization' in h));
  // X-Origin 声明 hash 的 origin 绑定——无签名头时一并省略（yt-dlp 同口径）；
  // Origin 是恒定伴随头，无签名仍发
  assert.ok(!('X-Origin' in h));
  assert.equal(h.Origin, 'https://www.youtube.com');
  assert.equal(warns.length, 1);
  assert.match(warns[0], /SAPISID/);
  assert.ok(!warns[0].includes('only-sid'));           // 凭据不落日志
  // 同一 cookie 第二次取流不再重复刷 warn（按值去重）
  warns.length = 0;
  await yt.fetchPlayer('vidcookie00g', null);
  assert.equal(warns.length, 0);
});

test('YT_COOKIE 含控制字符/非 ASCII：剔除后发出，warn 一次不回显脏值', async () => {
  reset();
  cookieValue = 'SAPISID=abc\n中文; SID=x';
  const yt = freshYt();
  await yt.fetchPlayer('vidcookie00h', null);
  const h = playerCalls()[0].opts.headers;
  assert.equal(h.Cookie, 'SAPISID=abc; SID=x');        // 消毒后负载
  assert.ok(warns.some(w => w.includes('非 ASCII')));
  assert.ok(!warns.some(w => w.includes('中文')));
});

test('认证档吃 LOGIN_REQUIRED 按失败轮转——补 vd 重试后落 ANDROID，凭据不渗匿名档', async () => {
  reset();
  cookieValue = 'SAPISID=dead-sid; SID=s';
  const yt = freshYt();
  // 带 Cookie 头的一律回登录墙（过期 cookie 语义）；匿名档放行
  playerImpl = async (url, opts) => (opts.headers.Cookie
    ? { ok: true, json: async () => ({ playabilityStatus: { status: 'LOGIN_REQUIRED', reason: '请登录' } }) }
    : { ok: true, json: async () => ({ playabilityStatus: { status: 'OK' }, streamingData: { adaptiveFormats: [] } }) });
  const body = await yt.fetchPlayer('vidcookie00i', null);
  assert.ok(body.streamingData);
  const seq = playerCalls();
  // 认证档两试（LOGIN_REQUIRED 补 visitorData 原地重试——失败语义与
  // 匿名档同口径，cookie 过期不钉死整链），随后 ANDROID 匿名成功
  assert.equal(seq.length, 3);
  assert.equal(seq[0].opts.headers['X-YouTube-Client-Name'], '1');
  assert.equal(seq[0].opts.headers.Cookie, cookieValue);
  assert.equal(seq[1].opts.headers['X-YouTube-Client-Name'], '1');
  assert.equal(seq[1].opts.headers['X-Goog-Visitor-Id'], 'vd-stub');
  assert.equal(seq[1].opts.headers.Cookie, cookieValue);
  assert.equal(seq[2].opts.headers['X-YouTube-Client-Name'], '3');
  assert.ok(!('Cookie' in seq[2].opts.headers));       // 凭据不渗匿名档
  assert.ok(!('Authorization' in seq[2].opts.headers));
});

test('cookie 在位：search/browse 链同走认证档（凭据随全部 youtubei 请求）', async () => {
  reset();
  cookieValue = 'SAPISID=sapisid-val; SID=s';
  const yt = freshYt();
  playerImpl = async (url) => {
    const u = String(url);
    if (u.includes('/search')) {
      return {
        ok: true,
        json: async () => ({ contents: { videoRenderer: {
          videoId: 'vidsearch0a', title: { simpleText: 'T' },
          lengthText: { simpleText: '1:23' },
        } } }),
      };
    }
    if (u.includes('/browse')) {
      return {
        ok: true,
        json: async () => ({
          header: { playlistHeaderRenderer: { title: { simpleText: 'pl' } } },
          contents: { playlistVideoRenderer: {
            videoId: 'vidbrowse0a', title: { simpleText: 'I' },
          } },
        }),
      };
    }
    return { ok: true, json: async () => ({ playabilityStatus: { status: 'OK' }, streamingData: {} }) };
  };
  const found = await yt.innertubeSearch('kw', null, 5);
  assert.equal(found[0].videoId, 'vidsearch0a');
  const sHeaders = calls.find(c => c.url.includes('/search')).opts.headers;
  assert.equal(sHeaders['X-YouTube-Client-Name'], '1');   // 认证 WEB 档排头
  assert.equal(sHeaders.Cookie, cookieValue);
  assert.match(sHeaders.Authorization, /^SAPISIDHASH \d+_[0-9a-f]{40}$/);
  assert.equal(sHeaders.Origin, 'https://www.youtube.com');
  calls.length = 0;
  const page = await yt.fetchYtPlaylistPage({ listId: 'PLtestlist0001', extraSignal: null });
  assert.equal(page.items[0].videoId, 'vidbrowse0a');
  const bHeaders = calls.find(c => c.url.includes('/browse')).opts.headers;
  assert.equal(bHeaders.Cookie, cookieValue);
  assert.ok(bHeaders.Authorization);
});

test('search 认证档失败轮转匿名档：Cookie/Authorization 不渗匿名请求', async () => {
  reset();
  cookieValue = 'SAPISID=dead-sid; SID=s';
  const yt = freshYt();
  // 带 Cookie 头的一律 403（过期 cookie 语义）；匿名档放行
  playerImpl = async (url, opts) => (opts.headers.Cookie
    ? { ok: false, status: 403 }
    : {
      ok: true,
      json: async () => ({ contents: { videoRenderer: {
        videoId: 'vidsearch0b', title: { simpleText: 'T' },
        lengthText: { simpleText: '1:23' },
      } } }),
    });
  const found = await yt.innertubeSearch('kw', null, 5);
  assert.equal(found[0].videoId, 'vidsearch0b');
  const seq = calls.filter(c => c.url.includes('/search'));
  assert.equal(seq.length, 2);                          // 认证档一发失败后轮转 ANDROID
  assert.equal(seq[0].opts.headers['X-YouTube-Client-Name'], '1');
  assert.equal(seq[0].opts.headers.Cookie, cookieValue);
  assert.equal(seq[1].opts.headers['X-YouTube-Client-Name'], '3');
  assert.ok(!('Cookie' in seq[1].opts.headers));        // 凭据不渗匿名档
  assert.ok(!('Authorization' in seq[1].opts.headers));
});

test('browse 认证档 HTTP 错：回落匿名 WEB 档兜底且凭据不渗第二发', async () => {
  reset();
  cookieValue = 'SAPISID=dead-sid; SID=s';
  const yt = freshYt();
  // 带 Cookie 头的一律 403（过期 cookie 语义）；匿名档放行
  playerImpl = async (url, opts) => (opts.headers.Cookie
    ? { ok: false, status: 403 }
    : {
      ok: true,
      json: async () => ({
        header: { playlistHeaderRenderer: { title: { simpleText: 'pl' } } },
        contents: { playlistVideoRenderer: {
          videoId: 'vidbrowse0b', title: { simpleText: 'I' },
        } },
      }),
    });
  const page = await yt.fetchYtPlaylistPage({ listId: 'PLfallback01', extraSignal: null });
  assert.equal(page.items[0].videoId, 'vidbrowse0b');
  const seq = calls.filter(c => c.url.includes('/browse'));
  assert.equal(seq.length, 2);                          // 认证档一发失败后匿名兜底
  assert.equal(seq[0].opts.headers.Cookie, cookieValue);
  assert.ok(!('Cookie' in seq[1].opts.headers));        // 凭据不渗匿名档
  assert.ok(!('Authorization' in seq[1].opts.headers));
});

test('browse 认证档回 ALERT_ERROR：歌单级终态直接抛，不烧匿名档重试', async () => {
  reset();
  cookieValue = 'SAPISID=sapisid-val; SID=s';
  const yt = freshYt();
  // 200 + alerts[].alertRenderer.type='ERROR'（无登录语义文本 → ALERT_ERROR）
  playerImpl = async () => ({
    ok: true,
    json: async () => ({
      alerts: [{ alertRenderer: { type: 'ERROR', text: { simpleText: 'Playlist unavailable' } } }],
    }),
  });
  await assert.rejects(
    () => yt.fetchYtPlaylistPage({ listId: 'PLdeadlist001', extraSignal: null }),
    (e) => { assert.equal(e.upstreamCode, 'ALERT_ERROR'); return true; }
  );
  const seq = calls.filter(c => c.url.includes('/browse'));
  assert.equal(seq.length, 1);                          // 确定性失败不回落重打
});

test('全形态失败：抛错与告警均不含 cookie 片段（凭据不出进程面）', async () => {
  reset();
  cookieValue = 'SAPISID=topsecret-sid; SID=topsecret-sid2';
  const yt = freshYt();
  playerImpl = async () => ({
    ok: true, json: async () => ({ playabilityStatus: { status: 'LOGIN_REQUIRED', reason: '请登录' } })
  });
  await assert.rejects(() => yt.fetchPlayer('vidcookie00j', null), (e) => {
    assert.ok(!e.message.includes('topsecret'));
    return true;
  });
  assert.ok(!warns.some(w => w.includes('topsecret')));
});

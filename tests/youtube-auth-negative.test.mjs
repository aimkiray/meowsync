// WEB_AUTH 认证档负缓存钉（F6）：cookie 在位时认证档排轮替链头；
// 连续 3 次「凭据被拒」（LOGIN_REQUIRED）盖章 ~10min——期内三条链
// 跳过认证档直走匿名，窗过期自动重探。
// 反例钉死：传输层失败（网络抖动）不计连败——健康 cookie 不被冤枉跳档。
// fetch 全桩按 Authorization 头分派认证/匿名口径记账；时钟用 Date.now
// 补丁做窗过期（生产戳只读 Date.now，AbortSignal 不受影响）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { seed, tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-yt-authneg-');
const require = createRequire(import.meta.url);

// SAPISID 在位 → ytAuthForms() 非空 → WEB_AUTH 档排链头
seed('../src/server/lib/settings.js', {
  effectiveValue: (k) => (k === 'yt_cookie' ? 'SAPISID=fake_sid_value; HSID=x' : null),
});

const events = [];               // 'auth'/'anon'/'home' 事件流水——链序断言用
let loginRequired = true;        // 认证档是否吃 LOGIN_REQUIRED
let authTransportFail = false;   // 认证档传输层失败（不计连败的判据）
const jsonRes = (body) => new Response(JSON.stringify(body), { status: 200 });
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u === 'https://www.youtube.com') {          // visitorData 首页抓取
    events.push('home');
    return new Response('"VISITOR_DATA":"vdTok123"', { status: 200 });
  }
  if (u.includes('/youtubei/v1/player')) {
    if (opts?.headers?.Authorization) {
      events.push('auth');
      if (authTransportFail) throw new TypeError('fetch failed');
      if (loginRequired) {
        return jsonRes({ playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Sign in' } });
      }
    } else {
      events.push('anon');
    }
    return jsonRes({ playabilityStatus: { status: 'OK' }, streamingData: { formats: [] } });
  }
  throw new Error(`unexpected fetch ${u}`);
};
after(() => { globalThis.fetch = realFetch; });

const { fetchPlayer } = require('../src/server/lib/youtube.js');
const count = (k) => events.filter(e => e === k).length;

test('传输层失败不计连败——认证档不被冤枉跳档', async () => {
  events.length = 0;
  authTransportFail = true;
  for (let i = 0; i < 4; i++) {
    const body = await fetchPlayer('dQw4w9WgXcQ');
    assert.ok(body.streamingData);
  }
  assert.equal(count('auth'), 4, '每次调用认证档仍排头——传输错不盖章');
  assert.equal(count('anon'), 4);
  authTransportFail = false;
});

test('连败 3 次盖章 10min：期内跳认证直走匿名，窗过期自动重探', async () => {
  events.length = 0;
  loginRequired = true;
  // 3 次连败：每次 WEB_AUTH attempt0 LOGIN_REQUIRED → 补 vd 原地重试
  // 仍拒 → 记账；匿名 ANDROID 殿后照常出流
  for (let i = 0; i < 3; i++) {
    const body = await fetchPlayer('dQw4w9WgXcQ');
    assert.ok(body.streamingData);
  }
  // 首连败 2 次认证打头（无 vd → 补 vd 原地重试仍拒）；后两次 vd 热缓存
  // 随首试带上，LOGIN_REQUIRED 直接换形态——4 发而非 6
  assert.equal(count('auth'), 4);
  assert.equal(count('anon'), 3);
  assert.equal(count('home'), 1, 'visitorData 只抓一次（热缓存复用）');

  // 负缓存窗内：认证档被整体跳过，匿名直出
  const before = count('auth');
  const body = await fetchPlayer('kJQP7kiw5Fk');
  assert.ok(body.streamingData);
  assert.equal(count('auth'), before, '盖章期内不再打认证档');
  assert.equal(events.at(-1), 'anon');

  // 窗过期自动重探：认证档回排头
  const realNow = Date.now;
  Date.now = () => realNow() + 11 * 60e3;
  try {
    const body2 = await fetchPlayer('9bZkp7q19f0');
    assert.ok(body2.streamingData);
  } finally { Date.now = realNow; }
  assert.ok(count('auth') > before, '窗过期后认证档恢复排头重探');
});

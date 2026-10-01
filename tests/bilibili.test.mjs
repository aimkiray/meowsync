// server/lib/bilibili.js 回归网——CURRENT_FNVAL 同步 / durl 分段守卫 / thunk memoize
// fetch 全局 stub：模块内 biliFetch → fetch(`https://api.bilibili.com${path}`)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// cookie 在模块加载时快照——必须在 require 之前注入
process.env.BILI_COOKIE = 'SESSDATA=fake; bili_jct=x; CURRENT_FNVAL=16';
const { biliFetch, resolveBiliMedia, QN_HEIGHT } = require('../src/server/lib/bilibili.js');

const okJson = (data) => ({ ok: true, status: 200, json: async () => ({ code: 0, data }) });

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, headers: opts.headers || {} });
    return handler(u);
  };
  return calls;
}

const DASH_480P = {
  dash: {
    video: [
      { id: 64, codecs: 'avc1.4d401f', mimeType: 'video/mp4', width: 852, height: 480, bandwidth: 500000, baseUrl: 'https://upos.example/dash-480.m4s' },
    ],
    audio: [{ id: 30232, mimeType: 'audio/mp4', bandwidth: 108000, baseUrl: 'https://upos.example/audio.m4a' }],
  },
};

test('CURRENT_FNVAL 与请求 fnval 自解析同步；登录 cookie 剥离后重写', async () => {
  const calls = stubFetch(() => okJson({ ok: 1 }));
  await biliFetch('/x/player/playurl?bvid=BV1x&cid=1&fnval=1&fourk=1&qn=80');
  await biliFetch('/x/web-interface/view?bvid=BV1x');
  const cookie1 = calls[0].headers.Cookie;
  const cookie2 = calls[1].headers.Cookie;
  assert.ok(cookie1.includes('CURRENT_FNVAL=1'), cookie1);
  assert.ok(cookie2.includes('CURRENT_FNVAL=4048'), cookie2);
  assert.ok(!cookie1.includes('CURRENT_FNVAL=16'));
  assert.ok(cookie1.includes('SESSDATA=fake'));
});

test('progressive：durl 单段 + qn=80 反超判高；memoize 只打一跳', async () => {
  const calls = stubFetch((u) => {
    if (u.includes('fnval=1')) {
      return okJson({ quality: 64, durl: [{ url: 'https://upos.example/full-720.mp4', backup_url: ['https://bak.example/full-720.mp4'] }] });
    }
    return okJson(DASH_480P);
  });
  const media = await resolveBiliMedia({ bvid: 'BV1x', cid: '7' });
  const [a, b] = await Promise.all([media.progressive(), media.progressive()]);
  assert.equal(a, b);
  assert.equal(a.length, 2); // 主链+备链（同文件镜像）
  assert.equal(a[0].h, QN_HEIGHT[64]);
  assert.equal(a[0].h, 720);
  const fnval1Calls = calls.filter(c => c.url.includes('fnval=1'));
  assert.equal(fnval1Calls.length, 1);
  assert.ok(fnval1Calls[0].url.includes('qn=80'));
});

test('progressive：durl 多段（分段视频）→ 返回空，不摊平成候选', async () => {
  stubFetch((u) => {
    if (u.includes('fnval=1')) {
      return okJson({ quality: 64, durl: [
        { url: 'https://upos.example/seg1.mp4', order: 1 },
        { url: 'https://upos.example/seg2.mp4', order: 2 },
      ] });
    }
    return okJson(DASH_480P);
  });
  const media = await resolveBiliMedia({ bvid: 'BV1x', cid: '7' });
  assert.deepEqual(await media.progressive(), []);
});

test('progressive：durl 拉取失败不缓存——重试会真打新一跳', async () => {
  let n = 0;
  stubFetch((u) => {
    if (u.includes('fnval=1')) {
      n++;
      return { ok: false, status: 500, json: async () => ({}) };
    }
    // view 自愈路径给个可用 view（含 cid），保证 heal 重试会再打到 fnval=1
    if (u.includes('/x/web-interface/view')) return okJson({ cid: 8, pages: [{ cid: 8, page: 1 }] });
    return okJson(DASH_480P);
  });
  const media = await resolveBiliMedia({ bvid: 'BV1x', cid: '7' });
  await assert.rejects(() => media.progressive(), /HTTP 500/);
  const afterFirst = n;
  assert.ok(afterFirst >= 1);
  // 失败不缓存——再次调用必须真打网络（含自愈重试）
  await assert.rejects(() => media.progressive(), /HTTP 500/);
  assert.ok(n > afterFirst);
});

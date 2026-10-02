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

test('DASH playurl 显式求顶档 qn=127——缺省会让 accept_quality 高档不进 dash.video', async () => {
  const calls = stubFetch(() => okJson(DASH_480P));
  await resolveBiliMedia({ bvid: 'BV1x', cid: '7' });
  const dashCalls = calls.filter(c => c.url.includes('fnval=4048'));
  assert.equal(dashCalls.length, 1);
  assert.ok(dashCalls[0].url.includes('qn=127'), dashCalls[0].url);
});

test('pickStreamList video 次键：同像素先比帧率再比码率（1080P60 优先 1080P）', async () => {
  const { pickStreamList } = require('../src/server/lib/bilibili.js');
  const lowFps = { id: 80, codecs: 'avc1.640028', mimeType: 'video/mp4', width: 1920, height: 1080, frameRate: '30.000', bandwidth: 1500000, baseUrl: 'https://a/1080p30' };
  const hiFps = { id: 116, codecs: 'avc1.640032', mimeType: 'video/mp4', width: 1920, height: 1080, frameRate: '60.000', bandwidth: 3000000, baseUrl: 'https://a/1080p60' };
  const hiBr = { id: 112, codecs: 'avc1.640028', mimeType: 'video/mp4', width: 1920, height: 1080, frame_rate: '30.000', bandwidth: 4000000, baseUrl: 'https://a/1080p+' };
  // 上游序打乱时排序也必须拿 60 帧档（fps 先于 bandwidth）；frame_rate
  // 蛇形拼法也认（上游两种字段名都出现过）
  const out = pickStreamList({ dash: { video: [lowFps, hiBr, hiFps] } }, 'video', 'best');
  assert.equal(out[0].id, 116);
  assert.equal(out[1].id, 112); // 同为 30fps 段时 bandwidth 决胜
  assert.equal(out[2].id, 80);
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

test('pickStreamList video anyCodec：4K hev1 反超 1080p avc1，同像素仍 avc1 优先', async () => {
  const { pickStreamList } = require('../src/server/lib/bilibili.js');
  const avc1080 = { id: 80, codecs: 'avc1.640032', mimeType: 'video/mp4', width: 1920, height: 1080, frameRate: '30', bandwidth: 2000000, baseUrl: 'https://a/avc1080' };
  const hev4k = { id: 120, codecs: 'hev1.1.6.L153', mimeType: 'video/mp4', width: 3840, height: 2160, frameRate: '30', bandwidth: 12000000, baseUrl: 'https://a/hev4k' };
  const hev1080 = { id: 116, codecs: 'hev1.1.6.L120', mimeType: 'video/mp4', width: 1920, height: 1080, frameRate: '30', bandwidth: 3000000, baseUrl: 'https://a/hev1080' };
  // 下载链放开编码面：>1080p 档（只发 hev1/av01 的 4K/8K/HDR）必须可达
  const out = pickStreamList({ dash: { video: [avc1080, hev4k, hev1080] } }, 'video', 'best', { anyCodec: true });
  assert.equal(out[0].id, 120);
  // 同像素仍 avc1 优先——hev1 轨留在候选表里做下一档降级而非首选
  assert.equal(out[1].id, 80);
  assert.equal(out[2].id, 116);
});

test('pickStreamList video 默认档不受 anyCodec 影响——播放链 avc1 兜底语义保留', async () => {
  const { pickStreamList } = require('../src/server/lib/bilibili.js');
  const avc1080 = { id: 80, codecs: 'avc1.640032', mimeType: 'video/mp4', width: 1920, height: 1080, frameRate: '30', bandwidth: 2000000 };
  const hev4k = { id: 120, codecs: 'hev1.1.6.L153', mimeType: 'video/mp4', width: 3840, height: 2160, frameRate: '30', bandwidth: 12000000 };
  // 播放链（prefer='best' 但不传 anyCodec）：avc 存在即只交 avc——
  // 4K hev1 不外泄给浏览器直放（DASH 裸轨 Safari 解不动）
  const out = pickStreamList({ dash: { video: [hev4k, avc1080] } }, 'video', 'best');
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 80);
  // 无 avc 时仍兜底全档（原语义：宁拿 hev1 也不空手）
  const out2 = pickStreamList({ dash: { video: [hev4k] } }, 'video', 'best');
  assert.equal(out2[0].id, 120);
});

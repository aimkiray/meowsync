// server/lib/bilibili.js 回归网——CURRENT_FNVAL 同步 / durl 分段守卫 / thunk memoize
// fetch 全局 stub：模块内 biliFetch → fetch(`https://api.bilibili.com${path}`)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { seed, tmpDataDir } from './helpers.mjs';

const require = createRequire(import.meta.url);

// biliCookie 经 settings 层读 app_settings——不隔离 DATA_DIR 会开真实 dev 库
process.env.DATA_DIR = tmpDataDir('meowsync-bili-');
process.env.BILI_COOKIE = 'SESSDATA=fake; bili_jct=x; CURRENT_FNVAL=16';
// net-guard 播种：resolveBiliLink 跳解谱需要 resolvesToPublicIp 可控（真 DNS
// 在沙箱/CI 不稳）；normalizeOutboundUrl/makeGuardedLookup 保真——跳解防线
// 本体（URL 卫生/域白名单/钉扎 lookup 构造）走真实现，只有 DNS 判定可编程
let dnsImpl = async () => true;
const realNetGuard = require('../src/server/lib/net-guard.js');
seed('../src/server/lib/net-guard.js', {
  ...realNetGuard,
  resolvesToPublicIp: async (h) => dnsImpl(h),
});
const { biliFetch, resolveBiliMedia, resolveBiliLink, isBiliLinkHost, QN_HEIGHT } = require('../src/server/lib/bilibili.js');

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

test('pickStreamList 健壮性：null 条目与 codecs 缺失档不炸穿排序', async () => {
  const { pickStreamList } = require('../src/server/lib/bilibili.js');
  const avc = { id: 80, codecs: 'avc1.640028', mimeType: 'video/mp4', width: 1920, height: 1080, bandwidth: 2e6, baseUrl: 'https://a/80' };
  // dash.video 含 null/字符串脏条目——裸 .bandwidth/.codecs 会 TypeError
  const out = pickStreamList({ dash: { video: [null, avc, 'garbage'] } }, 'video', 'best');
  assert.equal(out[0].id, 80);
  const out2 = pickStreamList({ dash: { video: [null, avc] } }, 'video', 'best', { anyCodec: true });
  assert.equal(out2[0].id, 80);
  // audio 路同口径：null 条目不能把 prefer=best 排序炸掉
  const audio = pickStreamList({ dash: { audio: [null, { id: 1, bandwidth: 1e5, baseUrl: 'https://a/a' }] } }, 'audio', 'best');
  assert.equal(audio[0].id, 1);
});

test('pickStreamList audio prefer=best：dolby 单对象形态参与排序', async () => {
  const { pickStreamList } = require('../src/server/lib/bilibili.js');
  const aac = { id: 30280, bandwidth: 2e5, baseUrl: 'https://a/aac' };
  const dash = {
    audio: [aac],
    dolby: { type: 2, audio: { id: 30251, bandwidth: 4e5, baseUrl: 'https://a/ec3' } }, // 单对象非数组
  };
  const out = pickStreamList({ dash }, 'audio', 'best');
  assert.equal(out[0].id, 30251);
  assert.equal(out[1].id, 30280);
});

test('flatUrls：同值 baseUrl/base_url 去重 + 非字符串 backup 过滤', async () => {
  const { flatUrls } = require('../src/server/lib/bilibili.js');
  const out = flatUrls({
    baseUrl: 'https://a/main', base_url: 'https://a/main', // 上游常同值双发
    backup_url: ['https://a/bk1', null, 42, 'https://a/bk1'],
  });
  assert.deepEqual(out.map(x => x.url), ['https://a/main', 'https://a/bk1']);
});

// ── resolveBiliLink：跳解谱（dnsImpl/stubFetch 可控，防线本体走真实现）──
const redirectTo = (loc, status = 302) => ({
  ok: false, status,
  headers: { get: (k) => (String(k).toLowerCase() === 'location' ? loc : null) },
  body: { cancel: async () => {} },
});
const terminalRes = (status) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: () => null },
  body: { cancel: async () => {} },
});

test('resolveBiliLink：bili2233.cn 裸短链补 scheme 入白名单跳解 → video', async () => {
  dnsImpl = async () => true;
  const calls = stubFetch((u) => {
    if (u === 'https://bili2233.cn/abc') return redirectTo('https://www.bilibili.com/video/BV1xx411c7mD');
    return terminalRes(404);
  });
  const r = await resolveBiliLink('bili2233.cn/abc');
  assert.deepEqual(r, { kind: 'video', id: 'BV1xx411c7mD' });
  assert.equal(calls[0].url, 'https://bili2233.cn/abc');
  assert.equal(calls.length, 1, '落地页 pick 在 fetch 前命中——不多打跳');
});

test('resolveBiliLink：bili2233 子域过白名单；仿冒域连接面为零', async () => {
  dnsImpl = async () => true;
  assert.ok(isBiliLinkHost('bili2233.cn'));
  assert.ok(isBiliLinkHost('m.bili2233.cn'));
  assert.ok(!isBiliLinkHost('xbili2233.cn'));
  assert.ok(!isBiliLinkHost('bili2233.cn.evil.com'));
  // 尾界欺骗域名进不了跳解循环（isBiliLinkHost 直接拒）——零 fetch
  const calls = stubFetch(() => terminalRes(200));
  assert.equal(await resolveBiliLink('https://bili2233.cn.evil.com/abc'), null);
  assert.equal(calls.length, 0);
});

test('resolveBiliLink：包裹分享文本抽取内嵌短链入跳解（带/不带 scheme 两态）', async () => {
  dnsImpl = async () => true;
  const calls = stubFetch((u) =>
    u === 'https://b23.tv/xyz777' ? redirectTo('https://www.bilibili.com/video/BV1xx411c7mD') : terminalRes(404));
  const r = await resolveBiliLink('【标题】 https://b23.tv/xyz777 快来围观');
  assert.deepEqual(r, { kind: 'video', id: 'BV1xx411c7mD' });
  assert.equal(calls[0].url, 'https://b23.tv/xyz777');
  // 无 scheme 包裹形态同收；中文尾随在 [A-Za-z0-9]+ 界内截断不脏链接
  const calls2 = stubFetch((u) =>
    u === 'https://bili2233.cn/abc9' ? redirectTo('https://www.bilibili.com/video/BV1xx411c7mD') : terminalRes(404));
  const r2 = await resolveBiliLink('分享 bili2233.cn/abc9 看看这个视频');
  assert.deepEqual(r2, { kind: 'video', id: 'BV1xx411c7mD' });
  assert.equal(calls2[0].url, 'https://bili2233.cn/abc9');
});

test('resolveBiliLink：直播/番剧落地页早类——不抢 video、零跳解', async () => {
  const calls = stubFetch(() => terminalRes(200));
  assert.deepEqual(await resolveBiliLink('https://live.bilibili.com/12345'), { kind: 'live' });
  assert.deepEqual(await resolveBiliLink('https://www.bilibili.com/live/12345'), { kind: 'live' });
  assert.deepEqual(await resolveBiliLink('https://www.bilibili.com/bangumi/play/ep12345'), { kind: 'bangumi' });
  assert.deepEqual(await resolveBiliLink('https://bangumi.bilibili.com/anime/123'), { kind: 'bangumi' });
  assert.equal(calls.length, 0, '早类在 pick 层判定——零出站');
  // video 判定优先于早类：URL 内嵌 BV 的罕见形态仍按视频归
  assert.deepEqual(await resolveBiliLink('https://www.bilibili.com/live/BV1xx411c7mD'), { kind: 'video', id: 'BV1xx411c7mD' });
});

test('resolveBiliLink：终态 2xx 无可绑 id → {kind:"other"}；4xx → null', async () => {
  dnsImpl = async () => true;
  stubFetch((u) => (u === 'https://b23.tv/p1' ? redirectTo('https://www.bilibili.com/read/cv123') : terminalRes(200)));
  assert.deepEqual(await resolveBiliLink('https://b23.tv/p1'), { kind: 'other' });
  stubFetch(() => terminalRes(404));
  assert.equal(await resolveBiliLink('https://b23.tv/dead'), null);
});

test('resolveBiliLink 安全面不回归：越域重定向零连接、跳数上限、DNS 拒则断', async () => {
  dnsImpl = async () => true;
  // 302 到非 B 站域（实案形态 b23.tv→qr.qq.com）：建连前域闸拒——第二跳零 fetch
  const calls = stubFetch((u) => (u === 'https://b23.tv/YTVGHGM' ? redirectTo('https://qr.qq.com/abc') : terminalRes(200)));
  assert.equal(await resolveBiliLink('https://b23.tv/YTVGHGM'), null);
  assert.equal(calls.length, 1, '越域重定向不得发起第二跳连接');
  // 跳数上限：连环 302 打满 4 跳（hop 0..3）仍 3xx → null
  const calls2 = stubFetch(() => redirectTo('https://b23.tv/next'));
  assert.equal(await resolveBiliLink('https://b23.tv/loop'), null);
  assert.equal(calls2.length, 4);
  // DNS 解析非公网 → 断链零 fetch（rebinding 防线在连接前置位）
  dnsImpl = async () => false;
  const calls3 = stubFetch(() => terminalRes(200));
  assert.equal(await resolveBiliLink('https://b23.tv/abc'), null);
  assert.equal(calls3.length, 0);
  dnsImpl = async () => true;
});

test('resolveBiliLink：落地页 av 形态 → {kind:"video", id:{aid}}', async () => {
  dnsImpl = async () => true;
  stubFetch((u) => (u === 'https://b23.tv/av' ? redirectTo('https://www.bilibili.com/video/av170001') : terminalRes(404)));
  const r = await resolveBiliLink('https://b23.tv/av');
  assert.deepEqual(r, { kind: 'video', id: { aid: 170001 } });
});

test('resolveBiliLink：短链单子域（sub.b23.tv/m.bili2233.cn）保留前缀入跳解', async () => {
  dnsImpl = async () => true;
  // scheme-less 支：谓词收的子域形态不再被子域不匹配甩进包裹抽取丢前缀
  const calls = stubFetch((u) =>
    u === 'https://sub.b23.tv/abc' ? redirectTo('https://www.bilibili.com/video/BV1xx411c7mD') : terminalRes(404));
  const r = await resolveBiliLink('sub.b23.tv/abc');
  assert.deepEqual(r, { kind: 'video', id: 'BV1xx411c7mD' });
  assert.equal(calls[0].url, 'https://sub.b23.tv/abc', '子域前缀保留——解用户贴的路径而非 apex');
  // 包裹抽取支同捕获可选子域（m.bili2233.cn 经 isBiliLinkHost 白名单照过）
  const calls2 = stubFetch((u) =>
    u === 'https://m.bili2233.cn/xy' ? redirectTo('https://www.bilibili.com/video/BV1xx411c7mD') : terminalRes(404));
  const r2 = await resolveBiliLink('看看 m.bili2233.cn/xy 这个');
  assert.deepEqual(r2, { kind: 'video', id: 'BV1xx411c7mD' });
  assert.equal(calls2[0].url, 'https://m.bili2233.cn/xy');
});

test('resolveBiliLink：302 中点落 live.bilibili.com → {kind:"live"} 早类——零第二跳', async () => {
  dnsImpl = async () => true;
  const calls = stubFetch((u) =>
    u === 'https://b23.tv/lv1' ? redirectTo('https://live.bilibili.com/12345') : terminalRes(200));
  const r = await resolveBiliLink('https://b23.tv/lv1');
  assert.deepEqual(r, { kind: 'live' });
  assert.equal(calls.length, 1, '中点早类在 pick 层判定——不发第二跳');
});

test('resolveBiliLink：落地页超精度 aid（>MAX_SAFE_INTEGER）不出 video——错绑>拒绑', async () => {
  dnsImpl = async () => true;
  stubFetch(() => terminalRes(200));
  const r = await resolveBiliLink('https://www.bilibili.com/video/av9007199254740993');
  // 精度丢失的 aid 不落 video 支——终态可达归 other 而非拿错位值问 view
  assert.deepEqual(r, { kind: 'other' });
});

test('resolveBiliLink：av 右界——不透明短码不被 av(\\d+) 前缀截获，纯数字短链仍零跳解', async () => {
  dnsImpl = async () => true;
  // b23.tv/av4KxEp：av4 只是短码前缀——右界闸后不被本地截获，真出 fetch 跳解
  const calls = stubFetch((u) =>
    u === 'https://b23.tv/av4KxEp' ? redirectTo('https://www.bilibili.com/video/BV1xx411c7mD') : terminalRes(404));
  const r = await resolveBiliLink('https://b23.tv/av4KxEp');
  assert.deepEqual(r, { kind: 'video', id: 'BV1xx411c7mD' });
  assert.equal(calls.length, 1, '不透明短码必须真打跳解——不得本地截获 av4 错绑 aid=4');
  assert.equal(calls[0].url, 'https://b23.tv/av4KxEp');
  // 包裹文本里的同型短码同律：抽取支入跳解而非 av 截获
  const calls2 = stubFetch((u) =>
    u === 'https://b23.tv/av9Yz' ? redirectTo('https://www.bilibili.com/video/BV1xx411c7mD') : terminalRes(404));
  const r2 = await resolveBiliLink('看这个 https://b23.tv/av9Yz 视频');
  assert.deepEqual(r2, { kind: 'video', id: 'BV1xx411c7mD' });
  assert.equal(calls2.length, 1);
  assert.equal(calls2[0].url, 'https://b23.tv/av9Yz');
  // 对照保留：纯数字旧式短链 b23.tv/av170001 仍归 video{aid} 零跳解
  const calls3 = stubFetch(() => terminalRes(404));
  const r3 = await resolveBiliLink('b23.tv/av170001');
  assert.deepEqual(r3, { kind: 'video', id: { aid: 170001 } });
  assert.equal(calls3.length, 0, '纯数字 av 短链仍是本地 aid 快路径——零出站');
});

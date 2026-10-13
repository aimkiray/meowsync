// lib/youtube.js 曲库搜索/相关/建议钉板：
//   innertubeSearch 对象签名 (kw, {signal,limit,continuation}) → {items,continuation}
//     ——channelId（ownerText runs UC browseId）/publishedTimeText/seen 去重/
//     limit 封顶不掐死游标；lockupViewModel 条目收集（ViewModel 迁移形态，
//     与 /next 共用 lockupItem + id/标题/死卡统一闸）；续页 token 哨兵槽
//     （continuationItemRenderer/continuationItemViewModel/直挂
//     nextContinuationData/reloadContinuationData）+ 容器兜底（*Continuation
//     尾段/continuations 数组）；续页请求只发 token（query/params 已烙在
//     token 里）；四根全空=风控空壳轮转判死、结构在位零条目=真实空结果
//     不轮转；旧位置签名 (kw,signal,limit) → 裸 items 数组（unlock 链零改
//     兼容钉）；alerts 登录墙=ALERT_AUTH/authRejected 轮转记账、非登录
//     ERROR=ALERT_ERROR 终态直抛；VISIONOS needsVisitor 无 vd 缓存跳过
//   fetchWatchNext — /next secondaryResults：lockupViewModel 主解（与歌单页
//     共用 lockupItem）+ compactVideoRenderer 兜底 + radioRenderer.playlistId
//     /PLAYLIST 类 RD 前缀 lockup → mixPlaylistId 单列；非 VIDEO 卡/死卡
//     剔除；收集域收窄 secondaryResults+续页容器（主列 lockup 不混 related）；
//     items 帽 40；WEB 单形态轮替
//   ytSuggest — suggestqueries JSON [q,[…]]；JSONP 壳/异形载荷归空、HTTP 错抛出
// lib/settings 预播种（yt_cookie/yt_proxy 关断走纯匿名形态）；globalThis.fetch
// 上桩录包/喂包；每用例 freshYt() 重载拿干净 authFail/visitorData 簿
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { seed } from './helpers.mjs';

const require = createRequire(import.meta.url);
const YT_PATH = '../src/server/lib/youtube.js';

seed('../src/server/lib/settings.js', {
  effectiveValue: () => null,   // yt_cookie/yt_proxy 全关——纯匿名形态
});

const calls = [];   // fetch 调用流水 {url, opts}
let upstreamImpl = async () => ({ ok: true, json: async () => ({}) });

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  calls.push({ url: String(url), opts });
  return upstreamImpl(String(url), opts);
};
process.on('exit', () => { globalThis.fetch = realFetch; });

const reset = () => {
  calls.length = 0;
  upstreamImpl = async () => ({ ok: true, json: async () => ({}) });
};
const freshYt = () => {
  const p = require.resolve(YT_PATH);
  delete require.cache[p];
  return require(YT_PATH);
};

const okJson = (body) => ({ ok: true, json: async () => body });
const VID = (n) => `vid${String(n).padStart(8, '0')}`;  // 11 位合法 videoId

// WEB 形态搜索条目骨架：title/owner(带 UC 跳转)/lengthText/publishedTimeText
const videoRenderer = (id, over = {}) => ({
  videoRenderer: {
    videoId: id,
    title: { runs: [{ text: `曲-${id}` }] },
    ownerText: { runs: [{ text: `频道-${id}`, navigationEndpoint: { browseEndpoint: { browseId: `UC${id}` } } }] },
    lengthText: { simpleText: '3:21' },
    publishedTimeText: { simpleText: '3 年前' },
    ...over,
  },
});

// /next 的 lockupViewModel 条目骨架（ViewModel 条目形态）：
// contentId/title.content/metadataRows 首行频道 part（UC commandRuns）/
// 缩略图角标时长 badge
const lockup = (id, title, owner) => ({
  lockupViewModel: {
    contentId: id,
    contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
    metadata: { lockupMetadataViewModel: {
      title: { content: title },
      metadata: { contentMetadataViewModel: { metadataRows: [
        { metadataParts: [{ text: { content: owner, commandRuns: [{ browseEndpoint: { browseId: `UC${id}` } }] } }] },
      ] } },
    } },
    contentImage: { collectionThumbnailViewModel: { primaryThumbnail: { thumbnailViewModel: { badges: [{ thumbnailBadgeViewModel: { text: '4:02' } }] } } } },
  },
});

test('innertubeSearch 对象签名：条目五件 + channelId/publishedTimeText + 哨兵 token + 去重', async () => {
  reset();
  const yt = freshYt();
  upstreamImpl = async () => okJson({
    contents: {
      twoColumnSearchResultsRenderer: {
        primaryContents: { sectionListRenderer: { contents: [
          { itemSectionRenderer: { contents: [
            videoRenderer(VID(1)),
            videoRenderer(VID(2)),
            videoRenderer(VID(1)),   // 同 videoId 重复——seen 去重
          ] } },
          { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'tok-A' } } } },
        ] } },
      },
    },
  });
  const r = await yt.innertubeSearch('曲', { limit: 20 });
  assert.equal(r.items.length, 2);
  const it = r.items[0];
  assert.equal(it.videoId, VID(1));
  assert.equal(it.title, `曲-${VID(1)}`);
  assert.equal(it.owner, `频道-${VID(1)}`);
  assert.equal(it.durationSec, 201);            // '3:21' → 201s
  assert.equal(it.channelId, `UC${VID(1)}`);    // ownerText runs 的 UC browseId
  assert.equal(it.publishedTimeText, '3 年前');
  assert.equal(r.continuation, 'tok-A');
  const body = JSON.parse(calls.find(c => c.url.includes('/v1/search')).opts.body);
  assert.equal(body.query, '曲');
  assert.equal(body.params, 'EgIQAQ==', '仅视频过滤参数');
  assert.equal(body.continuation, undefined, '首页不带 continuation 键');
});

test('continuation 入参：请求只发 token + 续页容器兜底收新 token', async () => {
  reset();
  const yt = freshYt();
  upstreamImpl = async () => okJson({
    continuationContents: {
      itemSectionContinuation: {
        contents: [{ itemSectionRenderer: { contents: [videoRenderer(VID(3))] } }],
        continuations: [{ nextContinuationData: { continuation: 'tok-B' } }],
      },
    },
  });
  const r = await yt.innertubeSearch('曲', { limit: 20, continuation: 'tok-A' });
  const body = JSON.parse(calls.find(c => c.url.includes('/v1/search')).opts.body);
  assert.equal(body.continuation, 'tok-A', 'token 原样透传');
  assert.equal(body.query, undefined, '续页不重发 query——已烙在 token 里');
  assert.equal(body.params, undefined);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].videoId, VID(3));
  assert.equal(r.continuation, 'tok-B', 'continuations[].nextContinuationData 兜底收');
});

test('limit 封顶不掐死游标：条目满额仍继续扫到 continuationItemRenderer', async () => {
  reset();
  const yt = freshYt();
  upstreamImpl = async () => okJson({
    contents: { list: [
      videoRenderer(VID(1)),
      videoRenderer(VID(2)),
      { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'tok-late' } } } },
      videoRenderer(VID(3)),
    ] },
  });
  const r = await yt.innertubeSearch('曲', { limit: 2 });
  assert.equal(r.items.length, 2, 'limit 封顶');
  assert.equal(r.continuation, 'tok-late', '满额后仍须扫到 token 槽——深挖靠它');
});

test('旧位置签名兼容：(kw, signal, limit) → 裸 items 数组（unlock 链零改钉）', async () => {
  reset();
  const yt = freshYt();
  upstreamImpl = async () => okJson({ contents: { videoRenderer: { videoId: VID(9), title: { simpleText: 'T' }, lengthSeconds: 61 } } });
  const found = await yt.innertubeSearch('kw', null, 5);
  assert.ok(Array.isArray(found), '旧契约回裸数组');
  assert.equal(found[0].videoId, VID(9));
  assert.equal(found[0].durationSec, 61, 'lengthSeconds 数字形态直用');
  // AbortSignal 第二参同样落旧契约（解锁链真形）
  const sig = new AbortController().signal;
  const found2 = await yt.innertubeSearch('kw', sig, 5);
  assert.ok(Array.isArray(found2));
});

test('空壳/真空分流：四根全空轮转判死；结构在位零条目归空表不抛', async () => {
  reset();
  const yt = freshYt();
  upstreamImpl = async () => okJson({ responseContext: {} });   // 纯骨架=风控空壳
  await assert.rejects(yt.innertubeSearch('x', { limit: 5 }), /搜索结果无候选/);
  const seq = calls.filter(c => c.url.includes('/v1/search'));
  assert.equal(seq.length, 2, '匿名两档轮转——VISIONOS needsVisitor 且无 vd 缓存跳过');
  assert.ok(!seq.some(c => c.opts.headers['X-YouTube-Client-Name'] === '101'),
    'needsVisitor 档无 vd 不打空炮');
  calls.length = 0;
  // 结构在位（contents 根在）但零视频项——真实「无结果」，不当上游故障
  upstreamImpl = async () => okJson({ contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: [] } } } } });
  const r = await yt.innertubeSearch('不存在的关键词zz', { limit: 5 });
  assert.deepEqual(r, { items: [], continuation: null });
  assert.equal(calls.filter(c => c.url.includes('/v1/search')).length, 1, '真实空结果不轮转');
});

test('HTTP 错误轮转下一形态：首发 500 后次档成功即收', async () => {
  reset();
  const yt = freshYt();
  let n = 0;
  upstreamImpl = async () => {
    n++;
    return n === 1
      ? { ok: false, status: 500 }
      : okJson({ contents: { videoRenderer: { videoId: VID(4), title: { simpleText: 'T' } } } });
  };
  const r = await yt.innertubeSearch('kw', { limit: 5 });
  assert.equal(r.items[0].videoId, VID(4));
  assert.equal(calls.filter(c => c.url.includes('/v1/search')).length, 2);
});

test('fetchWatchNext：lockup 主解 + compact 兜底 + mix 单列 + 非视频/死卡剔除', async () => {
  reset();
  const yt = freshYt();
  upstreamImpl = async () => okJson({
    contents: { twoColumnWatchNextResults: { secondaryResults: { secondaryResults: { results: [
      lockup(VID(5), '相关曲A', '频道A'),
      { lockupViewModel: { contentId: VID(6), contentType: 'LOCKUP_CONTENT_TYPE_CHANNEL' } }, // 频道卡不收
      { compactVideoRenderer: { videoId: VID(7), title: { simpleText: '相关曲B' }, ownerText: { runs: [{ text: '频道B' }] }, lengthText: { simpleText: '2:10' } } },
      { lockupViewModel: { contentId: VID(8), contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
        metadata: { lockupMetadataViewModel: { title: { content: 'Deleted video' } } } } },   // 死卡剔除
      { radioRenderer: { playlistId: 'RDmix123456789' } },
    ] } } } },
  });
  const r = await yt.fetchWatchNext('seedvideo01', null);
  assert.deepEqual(r.items.map(i => i.videoId), [VID(5), VID(7)]);
  const l = r.items[0];
  assert.equal(l.title, '相关曲A');
  assert.equal(l.owner, '频道A');
  assert.equal(l.channelId, `UC${VID(5)}`, 'lockup 频道 part 的 UC browseId');
  assert.equal(l.durationSec, 242);            // '4:02'
  assert.equal(r.items[1].durationSec, 130);   // compact '2:10'
  assert.equal(r.mixPlaylistId, 'RDmix123456789', 'radioRenderer.playlistId 单列');
  assert.ok(!r.items.some(i => i.videoId === 'RDmix123456789'), 'mix 不混进 items');
  const body = JSON.parse(calls.find(c => c.url.includes('/v1/next')).opts.body);
  assert.equal(body.videoId, 'seedvideo01');
  const h = calls.find(c => c.url.includes('/v1/next')).opts.headers;
  assert.equal(h['X-YouTube-Client-Name'], '1', 'WEB 形态——桌面端 renderer 结构');
});

test('fetchWatchNext 空壳：四根全空 → 轮转判死（WEB 单形态一发即止）', async () => {
  reset();
  const yt = freshYt();
  upstreamImpl = async () => okJson({ responseContext: {} });
  await assert.rejects(yt.fetchWatchNext('seedvideo01', null), /watch next 空壳/);
  assert.equal(calls.filter(c => c.url.includes('/v1/next')).length, 1);
});

test('ytSuggest：JSON 契约 + JSONP 壳/异形载荷归空 + HTTP 错抛出', async () => {
  reset();
  const yt = freshYt();
  upstreamImpl = async () => okJson(['青花瓷', ['青花瓷', '青花瓷 粤语', '青花瓷 钢琴']]);
  const s = await yt.ytSuggest('青花', null);
  assert.deepEqual(s.suggestions, ['青花瓷', '青花瓷 粤语', '青花瓷 钢琴']);
  assert.ok(calls[0].url.startsWith('https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q='));
  // JSONP 壳——上游回非 JSON 文本时 res.json() 抛，防御性归空
  upstreamImpl = async () => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token w'); } });
  assert.deepEqual((await yt.ytSuggest('x', null)).suggestions, []);
  // 可解析但非 [q,[…]] 契约——同样归空
  upstreamImpl = async () => okJson({ weird: 'shape' });
  assert.deepEqual((await yt.ytSuggest('x', null)).suggestions, []);
  upstreamImpl = async () => okJson(['q', 'not-an-array']);
  assert.deepEqual((await yt.ytSuggest('x', null)).suggestions, []);
  // HTTP 层错误照常抛——路由据此分档 502
  upstreamImpl = async () => ({ ok: false, status: 503 });
  await assert.rejects(yt.ytSuggest('x', null), /yt suggest HTTP 503/);
});

test('innertubeSearch 收 lockupViewModel 条目（ViewModel 迁移形态）+ 统一闸剔死卡/畸形/无标题', async () => {
  reset();
  const yt = freshYt();
  upstreamImpl = async () => okJson({
    contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: [
      { itemSectionRenderer: { contents: [
        lockup(VID(1), '曲-lockup', '频道L'),
        { lockupViewModel: { contentId: VID(2), contentType: 'LOCKUP_CONTENT_TYPE_CHANNEL' } },   // 频道卡不收
        { lockupViewModel: { contentId: VID(3), contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',          // 死卡哨兵标题不收
          metadata: { lockupMetadataViewModel: { title: { content: 'Deleted video' } } } } },
        { lockupViewModel: { contentId: 'short', contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',         // 畸形 id 不收
          metadata: { lockupMetadataViewModel: { title: { content: 'X' } } } } },
        videoRenderer(VID(4)),
        { videoRenderer: { videoId: VID(9) } },                                                    // 无标题 renderer 不收（统一闸）
      ] } },
      { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'tok-l1' } } } },
    ] } } } },
  });
  const r = await yt.innertubeSearch('曲', { limit: 20 });
  // 摘了 lockupViewModel 收集闸本用例即红：只剩 VID(4) 独苗
  assert.deepEqual(r.items.map(i => i.videoId), [VID(1), VID(4)]);
  assert.equal(r.items[0].title, '曲-lockup');
  assert.equal(r.items[0].owner, '频道L');
  assert.equal(r.items[0].durationSec, 242);           // lockup 角标 '4:02'
  assert.equal(r.continuation, 'tok-l1', 'lockup 在场时游标照常收');
});

test('续页提取：continuationItemViewModel 哨兵 + 直挂 nextContinuationData/reloadContinuationData 键', async () => {
  reset();
  const yt = freshYt();
  // ViewModel 形态哨兵：token 埋 innertubeCommand 嵌套（歌单页同款槽位）
  upstreamImpl = async () => okJson({
    contents: { list: [
      videoRenderer(VID(1)),
      { continuationItemViewModel: { continuationCommand: { innertubeCommand: { continuationCommand: { token: 'tok-vm' } } } } },
    ] },
  });
  let r = await yt.innertubeSearch('x', { limit: 20 });
  assert.equal(r.continuation, 'tok-vm', 'continuationItemViewModel 哨兵槽');
  // 直挂 nextContinuationData——哨兵槽位随版本漂移的另一形态
  upstreamImpl = async () => okJson({
    contents: { section: { contents: [videoRenderer(VID(2))], nextContinuationData: { continuation: 'tok-ncd' } } },
  });
  r = await yt.innertubeSearch('x', { limit: 20 });
  assert.equal(r.continuation, 'tok-ncd', 'nextContinuationData.continuation 直挂');
  // 直挂 reloadContinuationData
  upstreamImpl = async () => okJson({
    contents: { section: { contents: [videoRenderer(VID(3))],
      reloadContinuationData: { continuationEndpoint: { continuationCommand: { token: 'tok-rl' } } } } },
  });
  r = await yt.innertubeSearch('x', { limit: 20 });
  assert.equal(r.continuation, 'tok-rl', 'reloadContinuationData 直挂');
});

test('innertubeSearch {signal} 对象形：中途 abort 停止轮替不再打下形态', async () => {
  reset();
  const yt = freshYt();
  const ctrl = new AbortController();
  upstreamImpl = async () => { ctrl.abort(); return { ok: false, status: 500 }; };
  await assert.rejects(yt.innertubeSearch('x', { signal: ctrl.signal, limit: 5 }), /aborted/);
  assert.equal(calls.filter(c => c.url.includes('/v1/search')).length, 1,
    'abort 落地后不再轮转下一档（摘了 catch 里的 aborted 检查即红）');
});

test('search：alerts 登录墙=ALERT_AUTH/authRejected 轮转；非登录 ERROR=ALERT_ERROR 终态直抛', async () => {
  reset();
  const yt = freshYt();
  // 「Sign in…bot」语义 alert——凭据被拒信号，按失败轮转；匿名全灭后
  // 抛回的仍是 alert 错而非空壳错（摘了 alerts 检查会落成「搜索结果无候选」即红）
  upstreamImpl = async () => okJson({
    alerts: [{ alertRenderer: { type: 'ERROR', text: { simpleText: 'Sign in to confirm you are not a bot' } } }],
  });
  await assert.rejects(yt.innertubeSearch('x', { limit: 5 }), (e) => {
    assert.equal(e.upstreamCode, 'ALERT_AUTH');
    assert.equal(e.authRejected, true);
    return true;
  });
  const seq = calls.filter(c => c.url.includes('/v1/search'));
  assert.equal(seq.length, 2, '匿名两档轮转——VISIONOS needsVisitor 且无 vd 缓存跳过');
  calls.length = 0;
  // 非登录语义 ERROR alert——上游终态，逐字节重发同结果不烧轮转（browse 链同口径）
  upstreamImpl = async () => okJson({
    alerts: [{ alertRenderer: { type: 'ERROR', text: { simpleText: 'Something went wrong' } } }],
  });
  await assert.rejects(yt.innertubeSearch('x', { limit: 5 }),
    (e) => e.upstreamCode === 'ALERT_ERROR' && !e.authRejected);
  assert.equal(calls.filter(c => c.url.includes('/v1/search')).length, 1,
    'ALERT_ERROR 终态不重打（摘了 catch 里的 ALERT_ERROR 直抛即红）');
});

test('fetchWatchNext：收集域收窄——主列 results.results 的 lockup/compact 不进 related', async () => {
  reset();
  const yt = freshYt();
  upstreamImpl = async () => okJson({
    contents: { twoColumnWatchNextResults: {
      // 主列：结构化描述/商品卡（engagement panel 系）也长 lockupViewModel
      // ——contents 全树扫会混进 related（摘了 scope 收窄即红：多收两条主列卡）
      results: { results: { contents: [
        lockup(VID(1), '主列描述卡', '频道P'),
        { compactVideoRenderer: { videoId: VID(2), title: { simpleText: '主列卡' } } },
      ] } },
      secondaryResults: { secondaryResults: { results: [
        lockup(VID(5), '相关曲A', '频道A'),
        // Mix 的 lockup 形态：PLAYLIST 卡 + RD 前缀 contentId——与 radioRenderer 二取一
        { lockupViewModel: { contentId: 'RDmix00000001', contentType: 'LOCKUP_CONTENT_TYPE_PLAYLIST' } },
      ] } },
    } },
  });
  const r = await yt.fetchWatchNext('seedvideo01', null);
  assert.deepEqual(r.items.map(i => i.videoId), [VID(5)], '只收 secondaryResults 域');
  assert.equal(r.mixPlaylistId, 'RDmix00000001', 'PLAYLIST 类 RD lockup 提 mixPlaylistId');
  assert.ok(!r.items.some(i => i.videoId === 'RDmix00000001'), 'mix 卡不混进 items');
});

test('fetchWatchNext：items 收集帽 40——病理回包防膨胀', async () => {
  reset();
  const yt = freshYt();
  const many = Array.from({ length: 45 }, (_, i) => lockup(VID(100 + i), `相关${i}`, '频道'));
  upstreamImpl = async () => okJson({
    contents: { secondaryResults: { results: many } },
  });
  const r = await yt.fetchWatchNext('seedvideo01', null);
  assert.equal(r.items.length, 40, '帽 40（related 常态 ~20）——摘了 WATCH_NEXT_CAP 即红');
  assert.equal(r.items[0].videoId, VID(100));
});

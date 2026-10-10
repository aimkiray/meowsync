// /bilibili/stream 与 /youtube/stream 的缓存键 mint 语义：
//   - 显式 ?cid= 在位时键的 page 成分跟「cid 反解出的真实分P」走，
//     反解不出用 c<cid> 键段——绝不让 P2 字节写进 p1 键错位喂出
//   - cid 过期自愈后内容跟分P 序走，键段回到 p<pageWanted>
//   - 指纹带流 id 段（bv tier id / yt itag）防同 codec+br 撞键
// 上游全桩：biliFetch/youtube-resolve 不打真网络；vault.resolve 回看
// mint 出的 cacheKey 断言键形。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { seed, tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-stream-keys-');
const require = createRequire(import.meta.url);

const VIEW = {
  bvid: 'BV1xx411c7mD', cid: 111,
  pages: [{ cid: 111, page: 1 }, { cid: 222, page: 2 }],
};
const PLAYURL = {
  dash: {
    audio: [{
      id: 30280, mimeType: 'audio/mp4', codecs: 'mp4a.40.5', bandwidth: 129024,
      baseUrl: 'https://upos-sz-mirrorcos.bilivideo.com/a.m4s',
    }],
    video: [],
  },
};
// playurl 可按 cid 设死——cid 过期自愈路径用
const deadCids = new Set();
const realBv = require('../src/server/lib/bilibili.js');
seed('../src/server/lib/bilibili.js', {
  ...realBv,
  biliFetch: async (path) => {
    if (path.includes('/x/web-interface/view')) return VIEW;
    if (path.includes('/x/player/playurl')) {
      const cid = /[?&]cid=(\d+)/.exec(path)?.[1];
      if (deadCids.has(cid)) throw new Error('playurl code=-404 dead cid');
      return PLAYURL;
    }
    throw new Error(`unexpected upstream ${path}`);
  },
});
// yt 侧桩 resolveYoutubeStreams——googlevideo URL 恒带 itag 参数
const realYtResolve = require('../src/server/services/youtube-resolve.js');
seed('../src/server/services/youtube-resolve.js', {
  ...realYtResolve,
  resolveYoutubeStreams: async () => ({
    streams: [{
      url: 'https://rr1---sn-abcde.googlevideo.com/videoplayback?itag=251&expire=999',
      mimeType: 'audio/webm; codecs="opus"', br: 140000,
    }],
    gated: false,
  }),
});

let biliApp, ytApp, streamVault;
before(() => {
  biliApp = require('../src/server/routes/bilibili.js');
  ytApp = require('../src/server/routes/youtube.js');
  streamVault = require('../src/server/lib/stream-vault.js');
});
after(() => rmSync(process.env.DATA_DIR, { recursive: true, force: true }));

// 302 → vault token → cacheKey
const mintedKey = async (app, path) => {
  const r = await app.request(`http://t${path}`);
  assert.equal(r.status, 302, `预期 302，实际 ${r.status}`);
  const loc = r.headers.get('location') || '';
  const token = /\/audio-proxy\/t\/([^\s]+)/.exec(loc)?.[1];
  assert.ok(token, `Location 应挂 vault token：${loc}`);
  return streamVault.resolve(token)?.cacheKey;
};

test('bilibili/stream：无显式 cid——键按 ?p 分P序（现状语义保留）', async () => {
  assert.equal(
    await mintedKey(biliApp, '/bilibili/stream?bvid=BV1xx411c7mD&p=2'),
    'bv_BV1xx411c7mD_p2_a_mp4a.40.5_129024_i30280'
  );
});

test('bilibili/stream：?p=1&cid=222——键跟 cid 反解的真实分P（p2），不挂 ?p', async () => {
  assert.equal(
    await mintedKey(biliApp, '/bilibili/stream?bvid=BV1xx411c7mD&p=1&cid=222'),
    'bv_BV1xx411c7mD_p2_a_mp4a.40.5_129024_i30280'
  );
});

test('bilibili/stream：cid 反解不出——c<cid> 键段，宁可不合并绝不错位', async () => {
  assert.equal(
    await mintedKey(biliApp, '/bilibili/stream?bvid=BV1xx411c7mD&p=1&cid=999'),
    'bv_BV1xx411c7mD_c999_a_mp4a.40.5_129024_i30280'
  );
});

test('bilibili/stream：显式 cid 过期自愈——内容回到 p<pageWanted>，键同口径', async () => {
  // 正缓存按请求参数记忆上次成品——用上面用例没缓存过的 cid，
  // 同键复用会吃到缓存命中而到不了自愈链
  deadCids.add('444');
  try {
    assert.equal(
      await mintedKey(biliApp, '/bilibili/stream?bvid=BV1xx411c7mD&p=1&cid=444'),
      'bv_BV1xx411c7mD_p1_a_mp4a.40.5_129024_i30280'
    );
  } finally {
    deadCids.delete('444');
  }
});

test('youtube/stream：指纹带 itag 段——同 codec+br 流实体不撞键', async () => {
  assert.equal(
    await mintedKey(ytApp, '/youtube/stream?v=ABCDEFGHIJK'),
    'yt_ABCDEFGHIJK_a_opus_140000_i251'
  );
});

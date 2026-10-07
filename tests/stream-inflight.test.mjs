// /bilibili/stream 与 /youtube/stream 在途合流钉 + 客户端错误消息路径剥离钉。
// 上游全桩：biliFetch/youtube-resolve 记账计数且可挂起——并发同键请求必须
// 共享一条解析链；异键（kind/prefer/retry）不合流。
// 沿用 route-stream-keys.test.mjs 的桩面（真身 spread + 局部覆写）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { seed, tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-stream-inflight-');
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
    video: [{
      id: 80, mimeType: 'video/mp4', codecs: 'avc1.640028', bandwidth: 800000,
      width: 1920, height: 1080, baseUrl: 'https://upos-sz-mirrorcos.bilivideo.com/v.m4s',
    }],
  },
};
const biliCalls = [];                       // biliFetch 调用流水（path）
let biliViewGate = null;                    // 非空时 view 查询挂起等放行
let biliFetchImpl = async (path) => {
  if (path.includes('/x/web-interface/view')) return VIEW;
  if (path.includes('/x/player/playurl')) return PLAYURL;
  throw new Error(`unexpected upstream ${path}`);
};
const realBv = require('../src/server/lib/bilibili.js');
seed('../src/server/lib/bilibili.js', {
  ...realBv,
  biliFetch: async (path) => {
    biliCalls.push(path);
    if (biliViewGate && path.includes('/x/web-interface/view')) await biliViewGate;
    return biliFetchImpl(path);
  },
});

const ytCalls = [];                         // resolveYoutubeStreams 实参流水
let ytImpl = async () => ({
  streams: [{
    url: 'https://rr1---sn-abcde.googlevideo.com/videoplayback?itag=251&expire=999',
    mimeType: 'audio/webm; codecs="opus"', br: 140000,
  }],
});
seed('../src/server/services/youtube-resolve.js', {
  resolveYoutubeStreams: (...a) => ytImpl(...a),
});

let biliApp, ytApp;
before(() => {
  biliApp = require('../src/server/routes/bilibili.js');
  ytApp = require('../src/server/routes/youtube.js');
});
after(() => rmSync(process.env.DATA_DIR, { recursive: true, force: true }));

const playurlCalls = () => biliCalls.filter(p => p.includes('/x/player/playurl')).length;
const reset = () => { biliCalls.length = 0; ytCalls.length = 0; biliViewGate = null; };

test('bilibili/stream：同 (bvid,p,kind) 并发合流——上游扇出只跑一遍', async () => {
  reset();
  let release;
  biliViewGate = new Promise(r => { release = r; });   // 挂住首跳造重叠窗
  const path = '/bilibili/stream?bvid=BV1xx411c7mD&p=1';
  const [r1, r2] = [biliApp.request(`http://t${path}`), biliApp.request(`http://t${path}`)];
  await new Promise(r => setTimeout(r, 10));
  release();
  const [res1, res2] = await Promise.all([r1, r2]);
  assert.equal(res1.status, 302);
  assert.equal(res2.status, 302);
  assert.equal(biliCalls.length, 2, 'view+playurl 各一跳——第二路共享不发新扇出');
  assert.equal(playurlCalls(), 1);
});

test('bilibili/stream：kind 不同不合流——音频/视频是不同字节实体', async () => {
  reset();
  let release;
  biliViewGate = new Promise(r => { release = r; });
  const [r1, r2] = [
    biliApp.request('http://t/bilibili/stream?bvid=BV1xx411c7mD&p=1'),
    biliApp.request('http://t/bilibili/stream?bvid=BV1xx411c7mD&p=1&kind=video'),
  ];
  await new Promise(r => setTimeout(r, 10));
  release();
  const [res1, res2] = await Promise.all([r1, r2]);
  assert.equal(res1.status, 302);
  assert.equal(res2.status, 302);
  assert.equal(playurlCalls(), 2, 'audio/video 键不同——各自跑解析链');
});

test('youtube/stream：同 (v,kind) 并发合流；retry=1 不与常规请求同键', async () => {
  reset();
  let release;
  const gate = new Promise(r => { release = r; });
  ytImpl = async (...a) => { ytCalls.push(a); await gate; return {
    streams: [{
      url: 'https://rr1---sn-abcde.googlevideo.com/videoplayback?itag=251&expire=999',
      mimeType: 'audio/webm; codecs="opus"', br: 140000,
    }],
  }; };
  const [r1, r2, r3] = [
    ytApp.request('http://t/youtube/stream?v=ABCDEFGHIJK'),
    ytApp.request('http://t/youtube/stream?v=ABCDEFGHIJK'),
    // retry=1 刻意旁路 gateCache——与常规请求合流会吃到它要绕开的判定
    ytApp.request('http://t/youtube/stream?v=ABCDEFGHIJK&retry=1'),
  ];
  await new Promise(r => setTimeout(r, 10));
  release();
  const [res1, res2, res3] = await Promise.all([r1, r2, r3]);
  assert.equal(res1.status, 302);
  assert.equal(res2.status, 302);
  assert.equal(res3.status, 302);
  assert.equal(ytCalls.length, 2, '两发常规请求合流；retry 请求独立成链');
  // 合流链不吃调用方 signal——共享调用应拿到 signal 缺省/undefined
  assert.equal(ytCalls[0][1]?.signal, undefined);
});

test('错误透出路径剥离：bilibili stream 502 不泄绝对路径', async () => {
  reset();
  biliFetchImpl = async () => { throw new Error("ENOENT open '/srv/meowsync/cache/lock'"); };
  try {
    const res = await biliApp.request('http://t/bilibili/stream?bvid=BV1xx411c7mD&cid=333');
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.ok(!body.message.includes('/srv/meowsync'), `路径泄漏: ${body.message}`);
    assert.match(body.message, /<path>/);
  } finally { biliFetchImpl = async (path) => {
    if (path.includes('/x/web-interface/view')) return VIEW;
    if (path.includes('/x/player/playurl')) return PLAYURL;
    throw new Error(`unexpected upstream ${path}`);
  }; }
});

test('错误透出路径剥离：youtube stream 502 不泄绝对路径', async () => {
  reset();
  ytImpl = async () => { throw new Error("ENOENT open '/data/meowsync/secret'"); };
  try {
    const res = await ytApp.request('http://t/youtube/stream?v=ABCDEFGHIJK');
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.ok(!body.message.includes('/data/meowsync'), `路径泄漏: ${body.message}`);
    assert.match(body.message, /<path>/);
  } finally { ytImpl = async () => ({
    streams: [{
      url: 'https://rr1---sn-abcde.googlevideo.com/videoplayback?itag=251&expire=999',
      mimeType: 'audio/webm; codecs="opus"', br: 140000,
    }],
  }); }
});

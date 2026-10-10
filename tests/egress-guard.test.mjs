// 两条出站数据流收口钉板：
// a) download-manager 封面宿主闸——al.picUrl/pic_str 是客户端可控的镜像
//    raw_json 字段（/downloads/local/mirror 对 al 整对象原样放行），非图床
//    白名单宿主一律派生 null，防「任意公网 URL 回源 + /file?kind=cover
//    读回」受限 SSRF。两处派生点各钉一次：createDownloadQueue 任务构造、
//    downloadSingleSong 独立单曲路径。
// b) 白名单图床 URL 原样派生，且真的到达 fileDownloader.downloadCover
//    （调用记录断言——闸若失守 evil 域会进记录而不是打真网络）。
// c) proxy.js capStreamBytes 转发字节闸：上限内全量透传，超限 cancel
//    上游 + error 截断（512MiB 常量没法真打满，小 maxBytes 直驱流）。
// DATA_DIR 指向临时目录；file-downloader 播种 stub——唯一会被封面相位
// 触达的出站口被记账，其余相位本测试全关仍给兜底 stub。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { seed, tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-egress-');
const require = createRequire(import.meta.url);

const downloaderCalls = { cover: [] };
seed('../src/server/services/file-downloader.js', {
  downloadCover: async (url, out) => {
    downloaderCalls.cover.push(url);
    return { path: `${out}.jpg`, size: 1 };
  },
  downloadAudio: async () => { throw new Error('stub audio'); },
  downloadLyrics: async () => { throw new Error('stub lyrics'); },
  downloadVideo: async () => { throw new Error('stub video'); },
});
// net-guard 播种：路由级钉板要 /audio-proxy 过白名单+公网校验但不打真
// DNS——其余判定函数沿用真实现（展开真模块），只短路 resolvesToPublicIp；
// 真 fetch 在用例内按 globalThis.fetch 临时替换
const realNetGuard = require('../src/server/lib/net-guard.js');
seed('../src/server/lib/net-guard.js', {
  ...realNetGuard,
  resolvesToPublicIp: async () => true,
});

let dm, mirror, downloadTasksRepo, proxyApp;
before(() => {
  dm = require('../src/server/services/download-manager.js');
  mirror = require('../src/server/services/local-mirror.js');
  downloadTasksRepo = require('../src/server/repositories/downloadTasks.js');
  proxyApp = require('../src/server/routes/proxy.js');
});
after(() => { rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

const mirrorTrack = (id, al) => ({ id, name: '歌', ar: [{ name: 'a' }], al, dt: 100 });
const noFetchOpts = {
  downloadAudio: false, downloadLyrics: false, downloadCover: true, downloadVideo: false,
};
const waitTerminal = async (taskId, ms = 3000) => {
  const t0 = Date.now();
  for (;;) {
    const t = downloadTasksRepo.findTaskById(taskId);
    if (!t || t.status === 'completed' || t.status === 'failed') return t;
    if (Date.now() - t0 > ms) return t;
    await new Promise(r => setTimeout(r, 20));
  }
};

test('封面宿主闸：非白名单 picUrl/pic_str/畸形串 → coverUrl null（队列派生点）', async () => {
  mirror.mirrorLocalPlaylist('local_pl_cg_deny', '歌单', '', [
    mirrorTrack('cg001', { name: 'z', picUrl: 'https://evil.example/x.jpg' }),
    mirrorTrack('cg002', { name: 'z', pic_str: 'https://cdn.evil.example/y.jpg' }),
    mirrorTrack('cg003', { name: 'z', picUrl: 'not-a-url' }),
    // 白名单域 + 非 http(s) 协议同样裁掉——闸看整条 URL 形态不只看宿主
    mirrorTrack('cg004', { name: 'z', picUrl: 'ftp://i.ytimg.com/x.jpg' }),
  ]);
  const q = await dm.createDownloadQueue('local_pl_cg_deny', noFetchOpts);
  const tasks = downloadTasksRepo.listTasksByQueue(q.id);
  assert.equal(tasks.length, 4);
  for (const t of tasks) {
    assert.equal(t.coverUrl, null, `${t.songId} 非白名单/畸形封面须裁 null`);
  }
  // 队列停在 pending 未启动——纯派生断言，无协程拉起
});

test('封面宿主闸：白名单图床 URL 原样派生 + 脏 picUrl 兜到净 pic_str', async () => {
  mirror.mirrorLocalPlaylist('local_pl_cg_allow', '歌单', '', [
    mirrorTrack('cg011', { name: 'z', picUrl: 'https://i.ytimg.com/vi/x/hq.jpg' }),
    mirrorTrack('cg012', { name: 'z', pic_str: 'http://p1.music.126.net/c.jpg' }),
    mirrorTrack('cg013', { name: 'z', picUrl: '', pic_str: 'https://i0.hdslb.com/bfs/c.jpg' }),
    // 「视为 null」语义沿用 || 兜底序——脏 picUrl 不株连净 pic_str
    mirrorTrack('cg014', { name: 'z', picUrl: 'https://evil.example/x.jpg', pic_str: 'https://y.gtimg.cn/c.jpg' }),
  ]);
  const q = await dm.createDownloadQueue('local_pl_cg_allow', noFetchOpts);
  const bySong = Object.fromEntries(
    downloadTasksRepo.listTasksByQueue(q.id).map(t => [t.songId, t]));
  assert.equal(bySong.cg011.coverUrl, 'https://i.ytimg.com/vi/x/hq.jpg');
  assert.equal(bySong.cg012.coverUrl, 'http://p1.music.126.net/c.jpg');
  assert.equal(bySong.cg013.coverUrl, 'https://i0.hdslb.com/bfs/c.jpg');
  assert.equal(bySong.cg014.coverUrl, 'https://y.gtimg.cn/c.jpg');
});

test('封面宿主闸：downloadSingleSong 同口径；白名单 URL 真到 downloadCover', async () => {
  mirror.mirrorLocalPlaylist('local_pl_cg_solo', '歌单', '', [
    mirrorTrack('cg021', { name: 'z', picUrl: 'https://evil.example/steal.png' }),
    mirrorTrack('cg022', { name: 'z', picUrl: 'https://i.ytimg.com/vi/ok/hq.jpg' }),
  ]);
  const denied = await dm.downloadSingleSong('local_pl_cg_solo', 'cg021', noFetchOpts);
  assert.equal(denied.coverUrl, null);
  const allowed = await dm.downloadSingleSong('local_pl_cg_solo', 'cg022', noFetchOpts);
  assert.equal(allowed.coverUrl, 'https://i.ytimg.com/vi/ok/hq.jpg');
  // 被裁行零锁键零相位直接完成；放行行封面相位调 downloadCover stub
  assert.equal((await waitTerminal(denied.id)).status, 'completed');
  assert.equal((await waitTerminal(allowed.id)).status, 'completed');
  // 出站面钉死：downloadCover 只见过白名单 URL——闸若破 evil.example
  // 会出现在调用记录里（断言失败而非真回源）
  assert.deepEqual(downloaderCalls.cover, ['https://i.ytimg.com/vi/ok/hq.jpg']);
});

const collect = async (stream) => {
  const reader = stream.getReader();
  const chunks = [];
  let error = null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } catch (e) { error = e; }
  return { bytes: chunks.reduce((n, c) => n + c.byteLength, 0), error };
};

test('audio-proxy 字节闸：上限内全量透传 + 正常收尾', async () => {
  const src = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(10));
      controller.enqueue(new Uint8Array(15));
      controller.close();
    },
  });
  const { bytes, error } = await collect(proxyApp.capStreamBytes(src, 100));
  assert.equal(bytes, 25);
  assert.equal(error, null);
});

test('audio-proxy 字节闸：超限即销上游 + error 截断（触发块不转发）', async () => {
  let cancelled = false;
  const src = new ReadableStream({
    start(controller) { for (let i = 0; i < 5; i++) controller.enqueue(new Uint8Array(10)); },
    cancel() { cancelled = true; },
  });
  const { bytes, error } = await collect(proxyApp.capStreamBytes(src, 25));
  // 两块（20B）过闸，第三块把 sent 推过 25 上限被丢弃——已发字节自然截断
  assert.equal(bytes, 20);
  // error 而非静默 close：透传的 Content-Length 已声明全长，
  // close 截短会让客户端把残档当完整响应
  assert.match(String(error?.message), /byte cap/);
  assert.equal(cancelled, true); // 上游流被销毁——源端停止产字节
});

test('audio-proxy 字节闸：常量 512MiB；下游 cancel 级联销上游', async () => {
  assert.equal(proxyApp.MAX_AUDIO_PROXY_BYTES, 512 * 1024 * 1024);
  let cancelled = false;
  const src = new ReadableStream({
    pull() { /* 不产字节——客户端断连场景 */ },
    cancel() { cancelled = true; },
  });
  await proxyApp.capStreamBytes(src, 8).cancel();
  assert.equal(cancelled, true);
});

// 路由级钉板：cap 接线在裸 ?url= 链上（开放中转面），vault /t/:token 是
// 服务端 mint 的能力凭证不设闸——否则 WatchView 的 1080p 长录播会被误伤。
// stub fetch 回 fake-byteLength 巨块流：ReadableStream 不校验 chunk 形态，
// {byteLength} 计数块让 512MiB 常量上限在路由级可驱动且不占真内存
test('audio-proxy 路由级字节闸：裸 ?url= 超限被截断，vault 通道全量透传', async () => {
  const realFetch = globalThis.fetch;
  const MIB = 1024 * 1024;
  // 3×300MiB：第二块把累计推过 512MiB 被弃——裸口应只见首块 + 流错误
  const fatStream = () => new ReadableStream({
    start(ctrl) {
      for (let i = 0; i < 3; i++) ctrl.enqueue({ byteLength: 300 * MIB });
      ctrl.close();
    },
  });
  globalThis.fetch = async () => new Response(fatStream(), {
    status: 200, headers: { 'content-type': 'audio/mp4' },
  });
  try {
    const res = await proxyApp.request(
      `http://t/audio-proxy?url=${encodeURIComponent('https://p1.music.126.net/x.mp3')}`);
    assert.equal(res.status, 200);
    const capped = await collect(res.body);
    assert.equal(capped.bytes, 300 * MIB); // 首块过闸，第二块越界从响应丢弃
    assert.match(String(capped.error?.message), /byte cap/);

    // vault 对照：同形态超限流经 /t/:token 全量透传（能力凭证不吃 cap）
    const vault = require('../src/server/lib/stream-vault.js');
    const token = vault.mint('https://p1.music.126.net/x.mp3');
    const vres = await proxyApp.request(`http://t/audio-proxy/t/${token}`);
    assert.equal(vres.status, 200);
    const uncapped = await collect(vres.body);
    assert.equal(uncapped.bytes, 900 * MIB);
    assert.equal(uncapped.error, null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

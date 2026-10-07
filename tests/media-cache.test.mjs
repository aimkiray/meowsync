// services/media-cache.js 单测：键指纹（codec+br）/乱序区间合并→complete/
// TTL 过期 lookup null/LRU 挤兑/serveComplete Range 语义（200/206/416/400）/
// meta 损坏防御。DATA_DIR 指向临时目录，MAX_MB 压到 1MB 让挤兑可测。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-media-cache-');
process.env.MEDIA_CACHE_MAX_MB = '1'; // 1MB 封顶——LRU 挤兑用小文件即可触发
const require = createRequire(import.meta.url);
const mc = require('../src/server/services/media-cache.js');

after(() => { rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

// fake Hono context：serveComplete 只用 req.header('range')/req.method/
// body()/json() 四个面
const fakeC = (rangeHeader, method = 'GET') => ({
  req: {
    method,
    header: (n) => (String(n).toLowerCase() === 'range' ? rangeHeader : undefined),
    raw: { signal: null },
  },
  body: (data, status = 200, headers = {}) => ({ data, status, headers }),
  json: (data, status = 200) => ({ json: data, status }),
});
const bodyText = async (res) => new Response(res.data).text();

// 一次完整捕获（可选分段/起始偏移/附加 meta 字段）
const capture = async (key, { bytes, startOffset = 0, size, contentType = 'audio/mp4', ...extra } = {}) => {
  const cap = mc.beginCapture(key, { contentType, size: size ?? bytes.length, startOffset, ...extra });
  assert.ok(cap, 'beginCapture 不应落空');
  await cap.tap(Buffer.from(bytes));
  await cap.close();
};

test('keyOf/fingerprintOf：codec+br 指纹与键形（文件名安全字符）', () => {
  const fp = mc.fingerprintOf('audio/mp4; codecs="mp4a.40.2"', 131024);
  assert.equal(fp, 'mp4a.40.2_131024');
  assert.equal(mc.keyOf('yt', 'ABCDEFGHIJK', 'a', fp), 'yt_ABCDEFGHIJK_a_mp4a.40.2_131024');
  // mimeType 无 codecs 参数时 codecHint 补位（B 站 dash 的 codecs 是独立字段）
  assert.equal(mc.fingerprintOf('audio/mp4', 30280, 'mp4a.40.5'), 'mp4a.40.5_30280');
  // 全无信息回落 mime 主型 + 'x' 码率位（'/' 收成 '_'）
  assert.equal(mc.fingerprintOf('video/mp4', null), 'video_mp4_x');
  assert.equal(mc.fingerprintOf('', null), 'bin_x');
  // 流 id 段（yt itag / bv tier id）：同 codec+br 撞键防护，缺省不落段
  assert.equal(mc.fingerprintOf('audio/webm; codecs="opus"', 140000, null, 251), 'opus_140000_i251');
  assert.equal(mc.fingerprintOf('audio/mp4', 129024, 'mp4a.40.5', 30280), 'mp4a.40.5_129024_i30280');
  assert.equal(mc.fingerprintOf('audio/mp4', 129024, 'mp4a.40.5', null), 'mp4a.40.5_129024');
  // 合流判定：codecs 段多枚编码 = 音画同档
  assert.equal(mc.muxedOf('video/mp4; codecs="avc1.42001f, mp4a.40.2"'), true);
  assert.equal(mc.muxedOf('audio/mp4; codecs="mp4a.40.2"'), false);
  assert.equal(mc.muxedOf(''), false);
});

test('beginCapture：乱序两段写入→ranges 相邻合并→complete 置位', async () => {
  const key = mc.keyOf('t', 'merge1');
  // 先写尾巴 [5,6]，再写头 [0,4]——相邻合并成 [0,6]，size=7 覆盖满即 complete
  await capture(key, { bytes: 'fg', startOffset: 5, size: 7 });
  let meta = mc.lookup(key);
  assert.deepEqual(meta.ranges, [[5, 6]]);
  assert.equal(meta.complete, false);
  await capture(key, { bytes: 'abcde', startOffset: 0, size: 7 });
  meta = mc.lookup(key);
  assert.deepEqual(meta.ranges, [[0, 6]]);
  assert.equal(meta.complete, true);
  assert.equal(readFileSync(join(mc.CACHE_DIR, `${key}.bin`), 'utf8'), 'abcdefg');
});

test('beginCapture：重叠区间合并；覆盖不满不置 complete', async () => {
  const key = mc.keyOf('t', 'merge2');
  await capture(key, { bytes: '01234', startOffset: 0, size: 10 });
  await capture(key, { bytes: '3456', startOffset: 3, size: 10 }); // 重叠 [3,6]
  const meta = mc.lookup(key);
  assert.deepEqual(meta.ranges, [[0, 6]]);
  assert.equal(meta.complete, false); // [7,9] 还缺
});

test('beginCapture：并发同键不同区间交错写——定位写互不覆盖，区间各自落账', async () => {
  const key = mc.keyOf('t', 'interleave');
  // 两个捕获并发同 key：a 走 'wx' 新建，b 的 'r+' 续同一 inode——定位写
  // 天然不交叠，meta 读改写经 withKeyLock 串行
  const a = mc.beginCapture(key, { contentType: 'audio/mp4', size: 10, startOffset: 0 });
  const b = mc.beginCapture(key, { contentType: 'audio/mp4', size: 10, startOffset: 5 });
  assert.ok(a && b);
  await a.tap(Buffer.from('aaa'));
  await b.tap(Buffer.from('BBB'));
  await a.tap(Buffer.from('aa')); // a 推进到 [0,4]，b 写到 [5,7]——交错
  await b.tap(Buffer.from('BB'));
  await a.close();
  await b.close();
  const meta = mc.lookup(key);
  assert.deepEqual(meta.ranges, [[0, 9]]);
  assert.equal(meta.complete, true);
  assert.equal(readFileSync(join(mc.CACHE_DIR, `${key}.bin`), 'utf8'), 'aaaaaBBBBB');
});

test('beginCapture：新建档（isFresh）close 丢弃旧 meta 区间——防零洞毒档', async () => {
  const key = mc.keyOf('t', 'freshrebase');
  // 旧档 [0,4] 已落账；sweep/外力只删 bin 留下 meta（drop 双 unlink 之间
  // 被新捕获插进干净 bin 的同形窗口）
  await capture(key, { bytes: 'aaaaa', startOffset: 0, size: 10 });
  rmSync(join(mc.CACHE_DIR, `${key}.bin`));
  const cap = mc.beginCapture(key, { contentType: 'audio/mp4', size: 10, startOffset: 5 });
  assert.ok(cap);
  await cap.tap(Buffer.from('BBBBB'));
  await cap.close();
  const meta = mc.lookup(key);
  // 旧区间 [0,4] 的字节随旧 inode 消失——并入新账会把没写的零洞记成已写，
  // ranges 必须只含本次实写 [5,9]
  assert.deepEqual(meta.ranges, [[5, 9]]);
  assert.equal(meta.complete, false);
  const bin = readFileSync(join(mc.CACHE_DIR, `${key}.bin`));
  assert.equal(bin.subarray(5).toString(), 'BBBBB');
  assert.deepEqual([...bin.subarray(0, 5)], [0, 0, 0, 0, 0]); // 稀疏洞没进账
});

test('beginCapture：捕获 fd 的 inode 被替换（死文件写入）→ close 不落账', async () => {
  const key = mc.keyOf('t', 'deadino');
  const a = mc.beginCapture(key, { contentType: 'audio/mp4', size: 8, startOffset: 0 });
  assert.ok(a);
  await a.tap(Buffer.from('aaaa'));
  // sweep/外力在捕获途中删 bin：a 的 fd 指向已 unlink 的 inode，新捕获
  // 'wx' 在同路径重建——a 的字节全进死文件，落账即毒档
  rmSync(join(mc.CACHE_DIR, `${key}.bin`));
  const b = mc.beginCapture(key, { contentType: 'audio/mp4', size: 8, startOffset: 4 });
  assert.ok(b);
  await b.tap(Buffer.from('BBBB'));
  await a.close(); // ino 对账不符——a 的 [0,3] 不得入账
  await b.close();
  const meta = mc.lookup(key);
  assert.deepEqual(meta.ranges, [[4, 7]]); // 只有 b 真实落盘的区间
  assert.equal(meta.complete, false);
});

test('teeStream：消费方 cancel → 半截区间落账，续补可接力到 complete', async () => {
  const key = mc.keyOf('t', 'tee-cancel');
  const src = new ReadableStream({
    start(c) { c.enqueue(Buffer.from('aaaa')); c.enqueue(Buffer.from('bbbb')); c.close(); },
  });
  const cap = mc.beginCapture(key, { contentType: 'audio/mp4', size: 8, startOffset: 0 });
  assert.ok(cap);
  const reader = mc.teeStream(src, cap).getReader();
  assert.equal((await reader.read()).value.toString(), 'aaaa');
  await reader.cancel(); // 断连语义——已写 [0,3] 照常落账
  let meta = mc.lookup(key);
  assert.deepEqual(meta.ranges, [[0, 3]]);
  assert.equal(meta.complete, false);
  // 续补接力：新捕获 'r+' 续同一 inode 写后半段
  await capture(key, { bytes: 'bbbb', startOffset: 4, size: 8 });
  meta = mc.lookup(key);
  assert.deepEqual(meta.ranges, [[0, 7]]);
  assert.equal(meta.complete, true);
  assert.equal(readFileSync(join(mc.CACHE_DIR, `${key}.bin`), 'utf8'), 'aaaabbbb');
});

test('beginCapture：写链异步化后 close 自 drain——不依赖 tap 的 await 即完整落盘', async () => {
  const key = mc.keyOf('t', 'tee-drain');
  const cap = mc.beginCapture(key, { contentType: 'audio/mp4', size: 6, startOffset: 0 });
  assert.ok(cap);
  // 不 await tap 直接 close——close 必须自带写链 drain（flush 语义），
  // 否则 meta 记账区间指向截断档
  const p1 = cap.tap(Buffer.from('abc'));
  const p2 = cap.tap(Buffer.from('def'));
  await cap.close();
  await Promise.all([p1, p2]);
  assert.equal(readFileSync(join(mc.CACHE_DIR, `${key}.bin`), 'utf8'), 'abcdef');
  const res = await mc.serveComplete(fakeC(), key);
  assert.equal(res.status, 200);
  assert.equal(await bodyText(res), 'abcdef', '命中的是完整档而非截断档');
});

test('touchAccess：命中刷新不得回滚锁链窗口内落盘的 meta（lost update）', async () => {
  const key = mc.keyOf('t', 'touch-lu');
  await capture(key, { bytes: 'abcdefgh', size: 8 });
  // cap2 的 close 把 extra 字段（br）写进 meta——先把它排进 key 的串行链
  //（链上函数走微任务，此刻盘上仍是 v1 快照），再让 serveComplete 的
  // touchAccess 带着 v1 旧快照排它后面。链内不重读 fresh meta 的话，
  // touchAccess 落盘会把 close 写的字段整体回滚
  const cap2 = mc.beginCapture(key, { contentType: 'audio/mp4', size: 8, startOffset: 0, br: 999000 });
  assert.ok(cap2);
  await cap2.tap(Buffer.from('abcdefgh'));
  const p2 = cap2.close();
  // 一个微任务跳：close() 内部的 writeChain.then→withKeyLock 入队先跑——
  // 让 close2 的 meta 改写挂上链但还没执行（盘上仍是 v1）；此时
  // serveComplete 的 lookup 读 v1、touchAccess 排到 close2 之后。顺序
  // 错了钉不住回归（touchAccess 先落盘的话旧快照照样被 close2 覆盖）
  await Promise.resolve();
  const res = await mc.serveComplete(fakeC(), key); // 同步段即 touchAccess 入队
  assert.equal(res.status, 200);
  await p2;
  await bodyText(res); // 消费响应流收 fd
  await new Promise(r => setTimeout(r, 30)); // touchAccess 落盘窗口
  const meta = JSON.parse(readFileSync(join(mc.CACHE_DIR, `${key}.json`), 'utf8'));
  assert.equal(meta.br, 999000, 'close 写的字段被 touchAccess 旧快照回滚——lost update');
  assert.ok(Date.now() - meta.lastAccessAt < 5000, '访问时点照常刷新');
});

test('findComplete：br 优选 / 键尾码率回落 / minBr 门槛 / codec 质量序', async () => {
  // 同前缀两档——高 br 赢
  await capture(mc.keyOf('t', 'sel', 'a', 'mp4a.40.2_131072'), { bytes: 'aaaa', size: 4, br: 131072 });
  await capture(mc.keyOf('t', 'sel', 'a', 'opus_140000'), { bytes: 'bbbb', size: 4, br: 140000 });
  let hit = mc.findComplete('t_sel_a_');
  assert.equal(hit.meta.key, 't_sel_a_opus_140000');
  // minBr 门槛：低于底线与 br 缺失的档都出局（下载侧音质底线语义）
  assert.equal(mc.findComplete('t_sel_a_', { minBr: 150000 }), null);
  // meta.br 缺失时从键指纹尾段解析码率（'_i<streamId>' 段不干扰）
  const tailKey = mc.keyOf('t', 'selk', 'a', 'mp4a.40.5_30280_i30280');
  await capture(tailKey, { bytes: 'cccc', size: 4 });
  hit = mc.findComplete('t_selk_a_', { minBr: 30000 });
  assert.equal(hit.meta.key, tailKey);
  assert.equal(mc.findComplete('t_selk_a_', { minBr: 40000 }), null);
  hit = mc.findComplete('t_sel_a_'); // 无门槛——opus_140000 仍最优
  assert.equal(hit.meta.key, 't_sel_a_opus_140000');

  // codec 质量序：flac 档 br 缺省（_x 尾）也压过有 br 的 AAC——
  // prefer=best 的 flac>杜比>AAC 同口径，无损轨不被码率排序挤掉
  const flacKey = mc.keyOf('t', 'sel2', 'a', 'audio_flac_x');
  await capture(flacKey, { bytes: 'ffff', size: 4, contentType: 'audio/flac', codec: 'flac' });
  const aacKey = mc.keyOf('t', 'sel2', 'a', 'mp4a.40.2_400000');
  await capture(aacKey, { bytes: 'gggg', size: 4, br: 400000 });
  const dolbyKey = mc.keyOf('t', 'sel2', 'a', 'ec-3_500000');
  await capture(dolbyKey, { bytes: 'dddd', size: 4, br: 500000, codec: 'ec-3' });
  hit = mc.findComplete('t_sel2_a_');
  assert.equal(hit.meta.key, flacKey); // 无损 > 杜比 > 常规
  // minBr 在位时按码率门槛筛：flac（br 缺失）出局，杜比过线
  hit = mc.findComplete('t_sel2_a_', { minBr: 450000 });
  assert.equal(hit.meta.key, dolbyKey);
  assert.equal(mc.findComplete('t_sel2_a_', { minBr: 600000 }), null);
});

test('lookup：过期档按不存在处理；meta 损坏同样落空', async () => {
  const key = mc.keyOf('t', 'expire');
  await capture(key, { bytes: 'x'.repeat(8), size: 8 });
  assert.ok(mc.lookup(key));
  // lastAccessAt 回拨过 TTL——lookup 即死
  const mp = join(mc.CACHE_DIR, `${key}.json`);
  const meta = JSON.parse(readFileSync(mp, 'utf8'));
  meta.lastAccessAt = Date.now() - 73 * 3600e3;
  writeFileSync(mp, JSON.stringify(meta));
  assert.equal(mc.lookup(key), null);
  assert.equal(mc.findComplete('t_expire'), null);

  // meta 损坏 JSON → 当不存在（bin 还在也不认）
  const badKey = mc.keyOf('t', 'corrupt');
  writeFileSync(join(mc.CACHE_DIR, `${badKey}.bin`), 'bytes');
  writeFileSync(join(mc.CACHE_DIR, `${badKey}.json`), '{oops');
  assert.equal(mc.lookup(badKey), null);
});

test('serveComplete：200 全量 / 206 单段与后缀段 / 416 越界 / 400 畸形', async () => {
  const key = mc.keyOf('t', 'serve');
  await capture(key, { bytes: 'hello world', size: 11 });
  // 不完整档不命中——serveComplete 回 false 让调用方走原路
  const partial = mc.keyOf('t', 'serve-part');
  await capture(partial, { bytes: 'hel', size: 11 });
  assert.equal(await mc.serveComplete(fakeC(), partial), false);
  assert.equal(await mc.serveComplete(fakeC(), mc.keyOf('t', 'nosuch')), false);

  const full = await mc.serveComplete(fakeC(), key);
  assert.equal(full.status, 200);
  assert.equal(full.headers['Content-Length'], '11');
  assert.equal(full.headers['Accept-Ranges'], 'bytes');
  assert.equal(full.headers['Access-Control-Allow-Origin'], '*');
  assert.equal(full.headers['Content-Type'], 'audio/mp4');
  assert.equal(await bodyText(full), 'hello world');

  const part = await mc.serveComplete(fakeC('bytes=1-3'), key);
  assert.equal(part.status, 206);
  assert.equal(part.headers['Content-Range'], 'bytes 1-3/11');
  assert.equal(part.headers['Content-Length'], '3');
  assert.equal(await bodyText(part), 'ell');

  const suffix = await mc.serveComplete(fakeC('bytes=-4'), key);
  assert.equal(suffix.status, 206);
  assert.equal(await bodyText(suffix), 'orld');

  const oob = await mc.serveComplete(fakeC('bytes=99-'), key);
  assert.equal(oob.status, 416);
  assert.equal(oob.headers['Content-Range'], 'bytes */11');

  const reversed = await mc.serveComplete(fakeC('bytes=5-3'), key);
  assert.equal(reversed.status, 416);

  for (const bad of ['nonsense', 'bytes=-', 'bytes=0-1,3-5']) {
    const r = await mc.serveComplete(fakeC(bad), key);
    assert.equal(r.status, 400, bad);
  }

  // 命中刷新 lastAccessAt（LRU/TTL 滑动基准）
  const meta = JSON.parse(readFileSync(join(mc.CACHE_DIR, `${key}.json`), 'utf8'));
  assert.ok(Date.now() - meta.lastAccessAt < 5000);
});

test('sweep：过期档连 bin+json 删；孤儿文件收尸', async () => {
  const key = mc.keyOf('t', 'sweep-exp');
  await capture(key, { bytes: 'dead', size: 4 });
  const mp = join(mc.CACHE_DIR, `${key}.json`);
  const meta = JSON.parse(readFileSync(mp, 'utf8'));
  meta.lastAccessAt = Date.now() - 100 * 3600e3;
  writeFileSync(mp, JSON.stringify(meta));
  // 孤儿：无 meta 的陈旧 bin + 无 bin 的 meta
  const orphanBin = join(mc.CACHE_DIR, 't_orphanbin.bin');
  writeFileSync(orphanBin, 'x');
  const past = new Date(Date.now() - 3600e3);
  utimesSync(orphanBin, past, past); // 越过在途捕获宽限
  const orphanMeta = join(mc.CACHE_DIR, 't_orphanmeta.json');
  writeFileSync(orphanMeta, JSON.stringify({ key: 't_orphanmeta', ranges: [], complete: false }));

  const r = mc.sweep();
  // 过期计数含上一个用例拨过 TTL 的 't_expire'——只断语义不断精确数
  assert.ok(r.expired >= 1);
  assert.ok(r.orphans >= 2);
  assert.equal(existsSync(join(mc.CACHE_DIR, `${key}.bin`)), false);
  assert.equal(existsSync(mp), false);
  assert.equal(existsSync(orphanBin), false);
  assert.equal(existsSync(orphanMeta), false);
});

test('sweep：总量超 MAX_MB 按 lastAccessAt LRU 挤兑', async () => {
  const MB = 1024 * 1024;
  const oldKey = mc.keyOf('t', 'lru-old');
  const newKey = mc.keyOf('t', 'lru-new');
  await capture(oldKey, { bytes: Buffer.alloc(600 * 1024, 'a'), size: 600 * 1024 });
  await capture(newKey, { bytes: Buffer.alloc(600 * 1024, 'b'), size: 600 * 1024 });
  // old 访问时间拨旧——LRU 受害者
  const oldMp = join(mc.CACHE_DIR, `${oldKey}.json`);
  const oldMeta = JSON.parse(readFileSync(oldMp, 'utf8'));
  oldMeta.lastAccessAt = Date.now() - 3600e3;
  writeFileSync(oldMp, JSON.stringify(oldMeta));

  const r = mc.sweep();
  assert.equal(r.evicted, 1);
  assert.equal(mc.lookup(oldKey), null);
  assert.ok(mc.lookup(newKey), '较新的档应存活');
});

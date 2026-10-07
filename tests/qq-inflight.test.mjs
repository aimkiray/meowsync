// lib/qq.js pickStreamUrl 在途单飞钉：同 (mid, mmid, 档梯) 并发共享一条
// vkey 解析链；共享链不吃调用方 signal——等待方 abort 只影响自己。
// globalThis.fetch 桩记 musicu 调用；settings 预播种隔离凭据面。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { seed, tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-qq-inflight-');
const require = createRequire(import.meta.url);

seed('../src/server/lib/settings.js', {
  effectiveValue: () => null,
  qqCookieOverride: () => '',
  persistRenewedQqCookie: () => {},
});

let musicuCalls = 0;
let fetchGate = null;   // 非空时 musicu 应答挂起等放行
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('musicu.fcg')) {
    musicuCalls++;
    if (fetchGate) await fetchGate;
    return new Response(JSON.stringify({
      code: 0,
      req_0: { code: 0, data: {
        sip: ['https://ws.stream.qqmusic.qq.com/'],
        midurlinfo: [{ filename: 'M800mm1.mp3', purl: 'x.m4a?vkey=k1&uin=0', result: 0 }],
      } },
    }), { status: 200 });
  }
  throw new Error(`unexpected fetch ${u}`);
};
process.on('exit', () => { globalThis.fetch = realFetch; });

const { pickStreamUrl } = require('../src/server/lib/qq.js');

test('同 (mid,mmid,档梯) 并发单飞：上游 vkey 请求只打一发', async () => {
  musicuCalls = 0;
  let release;
  fetchGate = new Promise(r => { release = r; });
  const [a, b] = [
    pickStreamUrl('midAAAA0001', { mediaMid: 'mm1' }),
    pickStreamUrl('midAAAA0001', { mediaMid: 'mm1' }),
  ];
  await new Promise(r => setTimeout(r, 10));
  release();
  const [ha, hb] = await Promise.all([a, b]);
  assert.equal(musicuCalls, 1);
  assert.equal(ha.url, 'https://ws.stream.qqmusic.qq.com/x.m4a?vkey=k1&uin=0');
  assert.equal(hb.url, ha.url);
});

test('等待方 abort 不杀共享链：本调用方退出，链照常完成', async () => {
  musicuCalls = 0;
  let release;
  fetchGate = new Promise(r => { release = r; });
  const ctl = new AbortController();
  const doomed = pickStreamUrl('midBBBB0002', { mediaMid: 'mm2', signal: ctl.signal })
    .then(() => 'resolved', (e) => `threw:${e.message}`);
  const survivor = pickStreamUrl('midBBBB0002', { mediaMid: 'mm2' });
  await new Promise(r => setTimeout(r, 10));
  ctl.abort();
  release();
  assert.equal(await doomed, 'threw:aborted');
  assert.equal((await survivor).tier, 'M800');
  assert.equal(musicuCalls, 1);
});

test('异键不合流：不同 mid/档梯各自成链', async () => {
  musicuCalls = 0;
  let release;
  fetchGate = new Promise(r => { release = r; });
  const [a, b] = [
    pickStreamUrl('midCCCC0003', { mediaMid: 'mm3' }),
    pickStreamUrl('midDDDD0004', { mediaMid: 'mm4' }),
  ];
  await new Promise(r => setTimeout(r, 10));
  release();
  await Promise.all([a, b]);
  assert.equal(musicuCalls, 2);
});

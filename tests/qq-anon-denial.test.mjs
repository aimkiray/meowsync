// lib/qq.js 匿名取流关停钉板（2026-04 实机：vkey.GetVkeyServer 匿名恒回
// req_0.code=1000 + data.retcode=104009、全档 purl/sip 空）：
//   - musicu 抛错挂 nodeCode/retcode 不吞
//   - 无登录态下该签名经 pickStreamUrl 抛错带 qqAnonDenied（路由 502 诚实面
//     / file-downloader 回链判据）；有 cookie 的同码形态不打标——凭据失效
//     是另一诊断
//   - code=1000 不触发 2001 风控升级闸（凭据级拒答签名通道同返，升级白打）
//   - inflight 单飞共享链上标记跨等待方存活
//   - 匿名「健康空」形态（code=0 + 全档 purl 空 + sip 空）归 null
//   - getPlaylist cover 过 normalizeCoverUrl：// 协议相对补 https:，
//     非 http(s) 形态归 ''
// settings 预播种隔离凭据面；上游全经 globalThis.fetch 桩截断，无网络
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { seed, tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-qq-anon-');
const require = createRequire(import.meta.url);

// qqCookieOverride 读可变 jar——用例内翻转登录态（cookie 内容只需形似：
// uin/qm_keyst 在场即算登录态；不含 createtime/refresh_token 不触续期）
let cookieJar = '';
seed('../src/server/lib/settings.js', {
  effectiveValue: () => null,
  qqCookieOverride: () => cookieJar,
  persistRenewedQqCookie: () => {},
});

const realFetch = globalThis.fetch;
let fetchImpl = async () => { throw new Error('未桩 fetch'); };
const fetchUrls = []; // 实发 URL 记录——musics.fcg 升级闸断言用
globalThis.fetch = (u, o) => { fetchUrls.push(String(u)); return fetchImpl(u, o); };
after(() => {
  globalThis.fetch = realFetch;
  rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

const J = (body) => ({ ok: true, status: 200, json: async () => body });
// 实机匿名拒绝形态：信封 code=0，node.code=1000，data.retcode=104009
const ANON_DENIED = J({ code: 0, req_0: { code: 1000, data: { retcode: 104009 } } });
const DENIED_MSG = 'qq musicu vkey.GetVkeyServer code=0/1000';

const qq = require('../src/server/lib/qq.js');

test('vkey 匿名拒绝：无 cookie → 抛错带 qqAnonDenied + nodeCode/retcode；不升级 musics.fcg', async () => {
  cookieJar = '';
  fetchUrls.length = 0;
  fetchImpl = async () => ANON_DENIED;
  await assert.rejects(
    () => qq.pickStreamUrl('0034M8WL3V4oHA', { mediaMid: 'mm1' }),
    (e) => {
      assert.equal(e.qqAnonDenied, true);
      assert.equal(e.nodeCode, 1000);
      assert.equal(e.retcode, 104009);
      assert.match(e.message, /code=0\/1000/);
      return true;
    });
  assert.equal(fetchUrls.length, 1, '凭据级拒答只打一跳——不进 2001 升级闸');
  assert.match(fetchUrls[0], /musicu\.fcg/);
  assert.ok(!fetchUrls.some(u => u.includes('musics.fcg')), 'code=1000 不得升级签名通道（同返实测）');
});

test('vkey 同码拒绝 + 有 cookie：nodeCode/retcode 照挂但不打 qqAnonDenied', async () => {
  cookieJar = 'uin=o0123456789; qm_keyst=fakekey';
  fetchUrls.length = 0;
  fetchImpl = async () => ANON_DENIED;
  try {
    await assert.rejects(
      () => qq.pickStreamUrl('0034M8WL3V4oHB', { mediaMid: 'mm2' }),
      (e) => {
        assert.equal(e.qqAnonDenied, undefined, '有凭据的同码拒答是凭据失效——不打匿名标记');
        assert.equal(e.nodeCode, 1000);
        assert.equal(e.retcode, 104009);
        return true;
      });
  } finally { cookieJar = ''; }
});

test('qqAnonDenied 标记过 inflight 单飞存活：同键并发两调用方拿到同一标记错', async () => {
  cookieJar = '';
  let release;
  const gate = new Promise(r => { release = r; });
  fetchUrls.length = 0;
  fetchImpl = () => gate.then(() => ANON_DENIED);
  const [a, b] = [
    qq.pickStreamUrl('0034M8WL3V4oHC', { mediaMid: 'mm3' }),
    qq.pickStreamUrl('0034M8WL3V4oHC', { mediaMid: 'mm3' }),
  ];
  await new Promise(r => setTimeout(r, 10));
  release();
  const [ea, eb] = await Promise.all([
    a.then(() => null, e => e), b.then(() => null, e => e),
  ]);
  assert.equal(ea.qqAnonDenied, true);
  assert.equal(eb.qqAnonDenied, true);
  assert.equal(ea, eb, '共享链拒绝按引用分发——标记天然存活');
  assert.equal(fetchUrls.length, 1, '单飞：上游只打一发');
});

test('匿名「健康空」形态：code=0 + 全档 purl 空 + sip 空 → pickStreamUrl 归 null（非打标错）', async () => {
  cookieJar = '';
  fetchUrls.length = 0;
  fetchImpl = async (u) => {
    const s = String(u);
    if (s.includes('musicu.fcg')) {
      return J({ code: 0, req_0: { code: 0, data: {
        retcode: 0, sip: [],
        midurlinfo: [
          { filename: 'M800mmX.mp3', purl: '', result: 0 },
          { filename: 'M500mmX.mp3', purl: '', result: 0 },
          { filename: 'C400mmX.m4a', purl: '', result: 0 },
        ],
      } } });
    }
    // mediaMid 回填的详情跳挂掉——hit 仍归 null（回填失败本就 catch 归 null）
    if (s.includes('fcg_play_single_song')) throw new Error('detail 挂');
    throw new Error('unexpected ' + s);
  };
  const hit = await qq.pickStreamUrl('0034M8WL3V4oHD', { mediaMid: 'mmX' });
  assert.equal(hit, null);
});

test('vkey 拒答签名单边命中也打标：nodeCode=1000 无 retcode / retcode=104009 配其它 nodeCode', async () => {
  cookieJar = '';
  // 打标条件是「或」——nodeCode=1000 但 data 无 retcode 即命中
  fetchImpl = async () => J({ code: 0, req_0: { code: 1000, data: {} } });
  await assert.rejects(
    () => qq.pickStreamUrl('0034M8WL3V4oHF', { mediaMid: 'mm5' }),
    (e) => {
      assert.equal(e.qqAnonDenied, true, 'nodeCode=1000 单边命中即打标');
      assert.equal(e.nodeCode, 1000);
      assert.equal(e.retcode, undefined);
      return true;
    });
  // retcode=104009 配其它 nodeCode（非 2001 不进升级闸）——同按「或」命中
  fetchImpl = async () => J({ code: 0, req_0: { code: 2000, data: { retcode: 104009 } } });
  await assert.rejects(
    () => qq.pickStreamUrl('0034M8WL3V4oHG', { mediaMid: 'mm6' }),
    (e) => {
      assert.equal(e.qqAnonDenied, true, 'retcode=104009 单边命中即打标');
      assert.equal(e.nodeCode, 2000);
      assert.equal(e.retcode, 104009);
      return true;
    });
});

test('vkey 其它业务码（非 104009/1000）不打 qqAnonDenied', async () => {
  cookieJar = '';
  fetchImpl = async () => J({ code: 0, req_0: { code: 2000, data: { retcode: -500 } } });
  await assert.rejects(
    () => qq.pickStreamUrl('0034M8WL3V4oHE', { mediaMid: 'mm4' }),
    (e) => {
      assert.equal(e.qqAnonDenied, undefined);
      assert.equal(e.nodeCode, 2000);
      assert.equal(e.retcode, -500);
      return true;
    });
});

test('getPlaylist cover 归一：// 协议相对补 https:；ftp/缺席归空；dir_pic_url2 兜底', async () => {
  const song = { songmid: '000AAA111bbb', songname: 't', singer: [{ name: 'a' }] };
  // 单页收尾形态：songlist 原始长度 < 请求量即 exhausted
  const page = (cd) => J({ code: 0, cdlist: [{ dissname: '单', songnum: 1, songlist: [song], ...cd }] });

  fetchImpl = async () => page({ logo: '//y.qq.com/x.png' });
  assert.equal((await qq.getPlaylist('91001')).cover, 'https://y.qq.com/x.png');

  fetchImpl = async () => page({ logo: 'ftp://x/y.png', dir_pic_url2: 'ftp://z/q.png' });
  assert.equal((await qq.getPlaylist('91002')).cover, '', '非 http(s) 形态归空——不消费协议异形');

  fetchImpl = async () => page({ logo: '', dir_pic_url2: '' });
  assert.equal((await qq.getPlaylist('91003')).cover, '');

  fetchImpl = async () => page({ dir_pic_url2: 'https://y.qq.com/d.jpg' });
  assert.equal((await qq.getPlaylist('91004')).cover, 'https://y.qq.com/d.jpg',
    'logo 缺席时 dir_pic_url2 兜底且同过归一');
});

test('getPlaylist：begin=0 无 cdlist → null（路由据此 404）——归一不扰既有契约', async () => {
  fetchImpl = async () => J({ code: 0, cdlist: [] });
  assert.equal(await qq.getPlaylist('91005'), null);
});

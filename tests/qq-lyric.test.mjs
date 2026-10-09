// lib/qq.js getLyric 钉板：响应体缺席 / 业务码 / base64 解码 /
// 纯音乐占位词归一空。上游 fcg 经 globalThis.fetch 桩截（qq.js 在
// 调用点读全局 fetch——例内替换无需模块级 seed）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-qq-lyric-');
const require = createRequire(import.meta.url);

let qq;
const realFetch = globalThis.fetch;
let fetchImpl = async () => { throw new Error('未桩 fetch'); };
before(() => {
  globalThis.fetch = (...a) => fetchImpl(...a);
  qq = require('../src/server/lib/qq.js');
});
after(() => {
  globalThis.fetch = realFetch;
  rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

const fcgRes = (body) => ({ ok: true, json: async () => body });

test('qq getLyric：响应体缺席（null/非 JSON）抛错且无 bizCode——传输层语义', async () => {
  fetchImpl = async () => fcgRes(null);
  await assert.rejects(() => qq.getLyric('m0000000000001'), (e) => {
    assert.equal(e.bizCode, undefined); // 无业务码可读 → 不当「确定无词」固化
    return true;
  });
});

test('qq getLyric：业务码（code≠0）打标 bizCode——下载链据此映射 NO_LYRICS', async () => {
  fetchImpl = async () => fcgRes({ code: -1901, lyric: '' });
  await assert.rejects(() => qq.getLyric('m0000000000001'), (e) => {
    assert.equal(e.bizCode, -1901);
    return true;
  });
});

test('qq getLyric：正常词 base64 解码；占位词归一空；畸形 base64 不抛', async () => {
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  fetchImpl = async () => fcgRes({
    code: 0, lyric: b64('[00:01.00]第一句'), trans: b64('[00:01.00]译'),
  });
  const r = await qq.getLyric('m0000000000001');
  assert.equal(r.lyric, '[00:01.00]第一句');
  assert.equal(r.trans, '[00:01.00]译');
  // 「纯音乐，请欣赏」式占位词按无词处理——不当真词下发
  fetchImpl = async () => fcgRes({ code: 0, lyric: b64('[99:00.00]纯音乐，请欣赏'), trans: '' });
  assert.equal((await qq.getLyric('m0000000000001')).lyric, '');
  // 畸形 base64 静默截断不抛——Buffer.from 对非法字符不 raise
  fetchImpl = async () => fcgRes({ code: 0, lyric: '!!!不是base64!!!', trans: '' });
  const r2 = await qq.getLyric('m0000000000001');
  assert.equal(typeof r2.lyric, 'string');
});

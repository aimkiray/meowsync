// services/lyric-verify.js：判定键稳定性 + verdict 读写 + 降级行为。
// lib/ai 与 lyricAi 仓库预播种 stub（require 时解构绑定，必先就位）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let aiScript = [];
let verdictRows = {};
const writes = [];

import { seed } from './helpers.mjs';
let askCalls = 0;
let aiOn = true;
seed('../src/server/lib/ai.js', {
  aiEnabled: () => aiOn,
  // shift 出啥算啥——塞 Promise 可挂起在途调用验单飞
  askAiJson: async () => { askCalls += 1; return aiScript.length ? aiScript.shift() : null; },
  AI_MODEL: 'stub-model',
});
seed('../src/server/repositories/lyricAi.js', {
  getVerdict: (vkey) => verdictRows[vkey],
  upsertVerdict: (vkey, kind, ok, detail) => writes.push({ vkey, kind, ok, detail }),
});
const { parseLrcLines, lyricVerdictKey, judgeLyricLines, verifyDownloadOwnership } = require('../src/server/services/lyric-verify.js');

const lrc = '[00:01.00]line one\n[00:02.00]line two\n[00:03.00]line three\n';
const lines = parseLrcLines(lrc);
const reset = () => { aiScript = []; verdictRows = {}; writes.length = 0; askCalls = 0; aiOn = true; };

test('vkey 含词源 id/模型/源签名；源签名对标题作者敏感', () => {
  const a = lyricVerdictKey('123', 'Title', 'Author');
  const b = lyricVerdictKey('123', 'Title', 'Author');
  const c = lyricVerdictKey('123', 'Other', 'Author');
  const d = lyricVerdictKey('456', 'Title', 'Author');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
  assert.match(a, /^123@stub-model@[0-9a-f]{12}$/);
});

test('判不符 → 落库 kind=lyric ok=0 并返回 false', async () => {
  reset();
  aiScript = [{ ok: false }];
  const vkey = lyricVerdictKey('9', '源标题', '源作者');
  const r = await judgeLyricLines({ vkey, lines, title: '源标题', author: '源作者' });
  assert.equal(r, false);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].kind, 'lyric');
  assert.equal(writes[0].ok, false);   // 布尔入参，0/1 落库转换在真仓库层
  assert.equal(writes[0].vkey, vkey);
});

test('缓存命中不再问模型；哑火不落库', async () => {
  reset();
  verdictRows['k1'] = { ok: 1 };
  const r1 = await judgeLyricLines({ vkey: 'k1', lines, title: 't', author: 'a' });
  assert.equal(r1, true);
  assert.equal(writes.length, 0);

  aiScript = [null, { ok: 'yes' }, {}];   // 哑火/畸形一律不判
  const r2 = await judgeLyricLines({ vkey: 'k2', lines, title: 't', author: 'a' });
  assert.equal(r2, null);
  assert.equal(writes.length, 0);
});

test('vkey 双链等价：播放链全量 title 与下载链截断值产同键', () => {
  // 截断顺序钉死：raw[0:300].norm 而非 norm(raw)[0:300]——前导空白/
  // 边界空白下两序不同。播放链传全量、下载链传 providerData 截断值
  const long = 'x'.repeat(400);
  const pad = '   ' + 'y'.repeat(400);
  assert.equal(lyricVerdictKey('1', long, 'a'), lyricVerdictKey('1', long.slice(0, 300), 'a'));
  assert.equal(lyricVerdictKey('1', pad, 'a'), lyricVerdictKey('1', pad.slice(0, 300), 'a'));
  // 空白边界在第 300 码元——截断顺序恰好分叉的用例
  const edge = 'z'.repeat(299) + ' ' + 'w'.repeat(50);
  assert.equal(lyricVerdictKey('1', edge, 'a'), lyricVerdictKey('1', edge.slice(0, 300), 'a'));
});

test('judgeLyricLines 同 vkey 单飞：并发搭车只打一次模型', async () => {
  reset();
  let resolveAi;
  aiScript = [new Promise(r => { resolveAi = r; })];  // 挂起在途调用
  const p1 = judgeLyricLines({ vkey: 'sf', lines, title: 't', author: 'a' });
  const p2 = judgeLyricLines({ vkey: 'sf', lines, title: 't', author: 'a' });
  await new Promise(r => setTimeout(r, 0));
  assert.equal(askCalls, 1);                    // 搭车者没打第二发模型
  resolveAi({ ok: true });
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1, true);
  assert.equal(r2, true);
  assert.equal(writes.length, 1);               // verdict 也只写一次
});

// verifyDownloadOwnership：下载链落盘前的核验决策——AI 关时缓存判定仍生效、
// 不产新判定；源签名按 songId 前缀选而非 providerData 字段短路
const BV_ID = 'bv_BV1xx411c7mD';
const PD = { bilibili: { bvid: 'BV1xx411c7mD', title: '来源标题', author: 'UP主' }, neteaseId: '321' };

test('verifyDownloadOwnership：AI 关 + 无缓存 → 放行且零调用；缓存否决仍生效', async () => {
  reset(); aiOn = false;
  const r = await verifyDownloadOwnership({ songId: BV_ID, lyricId: '321', providerData: PD, lrc });
  assert.equal(r, true);
  assert.equal(askCalls, 0);
  // AI 关后已落库的否决依旧拦截——判定记忆不随开关旁路
  verdictRows[lyricVerdictKey('321', '来源标题', 'UP主')] = { ok: 0 };
  const r2 = await verifyDownloadOwnership({ songId: BV_ID, lyricId: '321', providerData: PD, lrc });
  assert.equal(r2, false);
  verdictRows[lyricVerdictKey('321', '来源标题', 'UP主')] = { ok: 1 };
  const r3 = await verifyDownloadOwnership({ songId: BV_ID, lyricId: '321', providerData: PD, lrc });
  assert.equal(r3, true);
});

test('verifyDownloadOwnership：双字段畸形 providerData 按 songId 前缀选源', async () => {
  reset();
  // bv_ 曲但 providerData 同时混进 youtube 字段——必须核验 bilibili 签名
  const pd = { bilibili: { title: 'B标题', author: 'B作者' }, youtube: { title: 'Y标题', author: 'Y作者' } };
  aiScript = [{ ok: false }];
  const r = await verifyDownloadOwnership({ songId: BV_ID, lyricId: '9', providerData: pd, lrc });
  assert.equal(r, false);
  assert.equal(writes[0].vkey, lyricVerdictKey('9', 'B标题', 'B作者'));
});

test('verifyDownloadOwnership：无源签名/0 行词/纯网易云曲 → 放行', async () => {
  reset();
  // providerData 缺 title（老镜像行）→ 无签名可核，放行
  assert.equal(await verifyDownloadOwnership({ songId: BV_ID, lyricId: '321', providerData: { bilibili: { bvid: 'BV1xx411c7mD' } }, lrc }), true);
  // 纯文本词 parse 出 0 行——没东西可验
  assert.equal(await verifyDownloadOwnership({ songId: BV_ID, lyricId: '321', providerData: PD, lrc: '没有时间戳的文本词' }), true);
  // 网易云自身曲（非嫁接）无核验对象
  assert.equal(await verifyDownloadOwnership({ songId: '12345', lyricId: '12345', providerData: null, lrc }), true);
  assert.equal(askCalls, 0);
});

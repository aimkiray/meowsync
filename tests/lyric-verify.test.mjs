// services/lyric-verify.js：判定键稳定性 + verdict 读写 + 降级行为。
// lib/ai 与 lyricAi 仓库预播种 stub（require 时解构绑定，必先就位）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let aiScript = [];
let verdictRows = {};
const writes = [];

const seed = (path, exports) => {
  const p = require.resolve(path);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
seed('../src/server/lib/ai.js', {
  aiEnabled: () => true,
  askAiJson: async () => (aiScript.length ? aiScript.shift() : null),
  AI_MODEL: 'stub-model',
});
seed('../src/server/repositories/lyricAi.js', {
  getVerdict: (vkey) => verdictRows[vkey],
  upsertVerdict: (vkey, kind, ok, detail) => writes.push({ vkey, kind, ok, detail }),
});
const { parseLrcLines, lyricVerdictKey, judgeLyricLines } = require('../src/server/services/lyric-verify.js');

const lrc = '[00:01.00]line one\n[00:02.00]line two\n[00:03.00]line three\n';
const lines = parseLrcLines(lrc);
const reset = () => { aiScript = []; verdictRows = {}; writes.length = 0; };

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

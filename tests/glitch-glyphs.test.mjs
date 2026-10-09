// lib/glitch-glyphs.js 分池腐蚀回归网——书写系统归类、自映射禁则、
// rand 注入确定性、池完整性、fonts.css unicode-range 机械化覆盖闸
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  POOL_HANZI, POOL_KANA, POOL_HANGUL, POOL_FALLBACK,
  GLYPH_LATIN, corruptGlyphFor,
} from '../src/lib/glitch-glyphs.js';

// rand 扫池：返回第 i 项的确定性 rand（+0.5 避开 i/len 的浮点贴边）
const at = (i, len) => () => (i + 0.5) / len;
// 对 ch 全位扫描，断言每个返回值都满足 pred
const sweep = (ch, len, pred) => {
  for (let i = 0; i < len; i++) pred(corruptGlyphFor(ch, at(i, len)), i);
};

// 用例 1：汉字系（含 Kangxi 部首/记号/注音构件/astral 扩展B）→ POOL_HANZI
test('hanzi 源字符 → POOL_HANZI', () => {
  for (const ch of ['你', '發', '⼀', '〇', '々', 'ㄅ', '㇀', '𠀀'])
    sweep(ch, POOL_HANZI.length, (g, i) =>
      assert.ok(POOL_HANZI.includes(g), `${ch} @${i} → ${g} 不在 POOL_HANZI`));
});

// 用例 2：假名系（平/片/半角/变体/语音扩展/・中点——规格 §2 归 kana 池不特判）→ POOL_KANA
test('kana 源字符 → POOL_KANA', () => {
  for (const ch of ['あ', 'ア', 'ｱ', 'ヶ', 'ㇰ', '・'])
    sweep(ch, POOL_KANA.length, (g, i) =>
      assert.ok(POOL_KANA.includes(g), `${ch} @${i} → ${g} 不在 POOL_KANA`));
});

// 用例 3：谚文（音节 D55C / 兼容 jamo 3131 / jamo 1100）→ POOL_HANGUL
test('hangul 源字符 → POOL_HANGUL', () => {
  for (const ch of ['한', 'ㄱ', 'ᄀ'])
    sweep(ch, POOL_HANGUL.length, (g, i) =>
      assert.ok(POOL_HANGUL.includes(g), `${ch} @${i} → ${g} 不在 POOL_HANGUL`));
});

// 用例 4：拉丁/数字 → GLYPH_LATIN 逐键映射且 ≠ 输入
test('latin 源字符 → GLYPH_LATIN 对应数组且不等于输入', () => {
  for (const ch of ['a', 'A', '5', 'Z']) {
    const list = GLYPH_LATIN[ch];
    sweep(ch, list.length, (g, i) => {
      assert.ok(list.includes(g), `${ch} @${i} → ${g} 不在 GLYPH_LATIN.${ch}`);
      assert.notEqual(g, ch, `${ch} @${i} 自映射穿透`);
    });
  }
});

// 用例 5：标点/全角/未登记拉丁/emoji 簇 → POOL_FALLBACK
test('fallback 源字符 → POOL_FALLBACK', () => {
  for (const ch of ['!', '。', '、', '！', '，', '５', '·', '€', 'é', '👍', '👨‍👩‍👧'])
    sweep(ch, POOL_FALLBACK.length, (g, i) =>
      assert.ok(POOL_FALLBACK.includes(g), `${ch} @${i} → ${g} 不在 POOL_FALLBACK`));
});

// 用例 6：自映射禁则——池内字符作输入时永不返回自身（全位扫描）
test('自映射禁则：池内字符不被映射为自身', () => {
  for (const [ch, len] of [['▓', POOL_FALLBACK.length], ['鬱', POOL_HANZI.length], ['×', POOL_FALLBACK.length]])
    sweep(ch, len, (g, i) => assert.notEqual(g, ch, `${ch} @${i} 自映射穿透`));
});

// 用例 7：rand 注入确定性——()=>0 取首项、()=>0.999 取末项
test('rand 注入：()=>0 → 各池首项，()=>0.999 → 末项', () => {
  const first = () => 0, last = () => 0.999;
  for (const [ch, pool] of [['你', POOL_HANZI], ['あ', POOL_KANA], ['한', POOL_HANGUL], ['!', POOL_FALLBACK]]) {
    assert.equal(corruptGlyphFor(ch, first), pool[0]);
    assert.equal(corruptGlyphFor(ch, last), pool[pool.length - 1]);
  }
  // latin 同理
  assert.equal(corruptGlyphFor('a', first), GLYPH_LATIN.a[0]);
  assert.equal(corruptGlyphFor('a', last), GLYPH_LATIN.a[GLYPH_LATIN.a.length - 1]);
});

// 用例 8：池完整性——无重复项；leet 每条 list 不含自身键；所有值=单字素非空串
test('池完整性：无重复/无自映射键/单字素', () => {
  for (const pool of [POOL_HANZI, POOL_KANA, POOL_HANGUL, POOL_FALLBACK])
    assert.equal(new Set(pool).size, pool.length, '池内存在重复项');
  for (const [k, list] of Object.entries(GLYPH_LATIN)) {
    assert.ok(!list.includes(k), `GLYPH_LATIN.${k} 含自身键`);
    assert.equal(new Set(list).size, list.length, `GLYPH_LATIN.${k} 有重复项`);
  }
  for (const g of [...POOL_HANZI, ...POOL_KANA, ...POOL_HANGUL, ...POOL_FALLBACK,
                   ...Object.values(GLYPH_LATIN).flat()])
    assert.equal([...g].length, 1, `非单字素项: ${JSON.stringify(g)}`);
});

// 用例 9：字体覆盖闸——POOL_* ∪ GLYPH_LATIN 值 ⊆ fonts.css unicode-range 并集
//         ∪ 希腊 sysfallback 白名单（规格 §4 照抄解析骨架）
test('字体覆盖闸：池内字符均落在 fonts.css unicode-range 并集或希腊白名单', () => {
  const fontsCss = readFileSync(new URL('../src/fonts/fonts.css', import.meta.url), 'utf8');
  const covered = new Set();
  for (const m of fontsCss.matchAll(/unicode-range:\s*([^;]+)/g))
    for (const t of m[1].split(',')) {
      const tok = t.trim();
      // 形态闸：fetch-fonts 再生产生 `U+4??` 通配等异态时 fail-loud，防静默假并集
      assert.match(tok, /^U\+[0-9a-f]+(-[0-9a-f]+)?$/i,
        `unicode-range token 形态异常: ${JSON.stringify(tok)}`);
      const [a,b] = tok.slice(2).split('-').map(x=>parseInt(x,16));
      for (let cp=a; cp<=(b??a); cp++) covered.add(cp);
    }
  const whitelist = new Set([...'αΛΒΔΣΓεβνκργϱωΩ']); // sysfallback 显式登记（15 符）
  const bad = g => {
    const cp = g.codePointAt(0);
    return !covered.has(cp) && !whitelist.has(g);
  };
  for (const pool of [POOL_HANZI, POOL_KANA, POOL_HANGUL, POOL_FALLBACK])
    assert.deepEqual(pool.filter(bad), [], '池字符越出 fonts.css 覆盖');
  for (const [k, list] of Object.entries(GLYPH_LATIN))
    assert.deepEqual(list.filter(bad), [], `GLYPH_LATIN.${k} 越出覆盖/白名单`);
});

// 用例 10：永不返回空——用例 1/5 全组（含默认 rand）返回非空单字素
test('永不返回空串', () => {
  const chars = ['你', '發', '⼀', '〇', '々', 'ㄅ', '㇀', '𠀀',
                 '!', '。', '、', '！', '，', '５', '·', '€', 'é', '👍', '👨‍👩‍👧'];
  for (const ch of chars) {
    const g = corruptGlyphFor(ch);
    assert.equal(typeof g, 'string');
    assert.ok([...g].length >= 1, `${ch} 返回空串`);
  }
});

// 用例 11：rand 越界钳制——rand()≥1/负值/NaN 一律钳回 [0,len)，不产 undefined 入 Map
test('rand 越界（≥1/负值/NaN）→ 钳回池内，不返回 undefined', () => {
  for (const [ch, pool] of [['あ', POOL_KANA], ['!', POOL_FALLBACK], ['a', GLYPH_LATIN.a]])
    for (const r of [() => 1, () => 2.9, () => -0.3, () => -1.7, () => NaN]) {
      const g = corruptGlyphFor(ch, r);
      assert.ok(pool.includes(g), `${ch} rand=${r()} → ${g} 越出池`);
    }
  // 钳后顺移联动：'▓' 在 POOL_FALLBACK[0]，rand=1 卷回 i=0 命中自身 → 取 [1]='░'
  assert.equal(corruptGlyphFor('▓', () => 1), '░');
});

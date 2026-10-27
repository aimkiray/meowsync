// src/shared/relay-gate.js 钉板——词源回链音频校验闸纯判定层。
// canonical §7 测试矩阵：13 实锤必拦样本（直钉 reason 轴）+ 必放行/边界；
// §3.1 归一化校准（romajiKey 四钉：クラムボン→krambon / clammbon→klambon /
// にゃーろんず→nyaronz / nyarons→nyarons）。
// 纯函数直 import shared ESM，无 CJS 桩。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  judgeRelayCand, relayExpectedOf,
  normArtist, splitMembers, splitArtists, kanaToRomaji, romajiKey,
  diceBigram, artistVerdict, candArtistTerms,
  markerPresent, hasCoverMarker, durationAxis, markerAxis,
  RELAY_DUR_ABS_MS, RELAY_DUR_RATIO, DICE_MIN, ARTIST_SENTINEL,
  COVER_MARKER, RULE_VERSION,
} from '../src/shared/relay-gate.js';

const exp = (title, artists, durationMs) => ({ title, artists, durationMs });
const cand = (name, ar, dt) => ({ name, ar, dt });

// ── §7 必拦：13 实锤样本（错艺人翻唱/错绑真身）─────────────────────────
const BLOCKS = [
  ['娘子 双轴', exp('娘子', ['周杰伦'], 271000),
    cand('娘子', [{ name: '叶藏澈' }], 326000), ['artist_mismatch', 'duration_off']],
  ['火车叨位去', exp('火车叨位去', ['周杰伦'], 276000),
    cand('火车叨位去', [{ name: '矣金冉' }], 274000), ['artist_mismatch']],
  ['山梨・雪・寒い kidlit×含CJK假名不比', exp('山梨・雪・寒い', ['深水チエ'], 255000),
    cand('山梨・雪・寒い', [{ name: 'kidlit' }], 258000), ['artist_mismatch']],
  ['Cinnamon', exp('Cinnamon', ['明透'], 249000),
    cand('Cinnamon', [{ name: '化步' }], 249000), ['artist_mismatch']],
  ['koori no naka', exp('koori no naka', ['ヒロネちゃん'], 157000),
    cand('koori no naka', [{ name: 'mekakushe' }], 158000), ['artist_mismatch']],
  ['nekomeshi', exp('nekomeshi', ['药师丸悦子'], 259000),
    cand('nekomeshi', [{ name: '欣乃ちゃん' }], 261000), ['artist_mismatch']],
  ['うさぎ大爆発', exp('うさぎ大爆発', ['しばやん'], 389000),
    cand('うさぎ大爆発', [{ name: '坂上なち' }], 389000), ['artist_mismatch']],
  ['小説夏と罰(上) 多艺人绑条', exp('小説夏と罰(上)', ['EMA'], 229000),
    cand('小説夏と罰(上)', [{ name: '傘村トータ' }, { name: '猫村いろは' }, { name: 'KAITO' }], 227000),
    ['artist_mismatch']],
  // F8 修订：同艺人+单侧 cover 标不再拦——QQ 源标题常不携带 cover 注记而
  // 源录音本身就是该 cover（下方 F8 实机钉判 pass）。本钉绑条改中性艺人
  // 'V.A.'（isPlaceholderAuthor 哨兵→neutral）：neutral 下不对称标记仍是
  // 唯一可用拦据——V.A. 类绑条的 cover 注记正是可用证据（§3.4 F8）
  ['回る空うさぎ 中性艺人+单侧cover标', exp('回る空うさぎ', ['花譜'], 186000),
    cand('回る空うさぎ (Cover)', [{ name: 'V.A.' }], 186000), ['cover_marker']],
  ['ARTIFICIAL SKIN', exp('ARTIFICIAL SKIN', ['EMA'], 0),
    cand('ARTIFICIAL SKIN', [{ name: 'PSGOZ' }], 0), ['artist_mismatch']],
  ['Meru', exp('Meru', ['Nako'], 0),
    cand('Meru', [{ name: 'かんせる' }], 0), ['artist_mismatch']],
  ['懐中道標', exp('懐中道標', ['EMA'], 0),
    cand('懐中道標', [{ name: '宁决' }], 0), ['artist_mismatch']],
  ['食虫植物 fan声真似', exp('食虫植物', ['EMA'], 0),
    cand('食虫植物', [{ name: 'fan声真似' }], 0), ['artist_mismatch']],
];

for (const [label, expected, c, wantReasons] of BLOCKS) {
  test(`必拦 ${label}`, () => {
    const { verdict, reasons } = judgeRelayCand(expected, c, null);
    assert.equal(verdict, 'block');
    // deepEqual 钉全集而非 includes 钉子集——多喷 reason（如意外
    // cover_marker/duration_off）也要变红（R10a-N1）
    assert.deepEqual([...reasons].sort(), [...wantReasons].sort(),
      `reasons 不符，实得 ${JSON.stringify(reasons)}`);
  });
}

// ── §7 必放行（正确绑 + 边界）────────────────────────────────────────
const PASS_CASES = [
  ['P1 同名同艺人±1s(sc100 进不了判定)', exp('同名曲', ['艺人甲'], 271000),
    cand('同名曲', [{ name: '艺人甲' }], 272000), 100],
  ['P2 杉惠×杉恵 异体折叠', exp('エンドルフィン', ['杉惠'], 250000),
    cand('エンドルフィン', [{ name: '杉恵' }], 250000), null],
  ['P3 clammbon×クラムボン Dice≈0.67', exp('波よせて', ['clammbon'], 300000),
    cand('波よせて', [{ name: 'クラムボン' }], 300000), null],
  ['P3b tns 槽直中', exp('波よせて', ['clammbon'], 300000),
    cand('波よせて', [{ name: 'クラムボン', tns: ['clammbon'] }], 300000), null],
  ['P4 多艺人同组异序(成员重叠)', exp('神様のいうとおり', ['吉岡聖恵 水野良樹 山下穂尊'], 250000),
    cand('神様のいうとおり', [{ name: '山下穂尊' }, { name: '吉岡聖恵' }, { name: '水野良樹' }], 251000), null],
  ['P5 Nyarons×にゃーろんず Dice≈0.83', exp('サンプル', ['Nyarons'], 200000),
    cand('サンプル', [{ name: 'にゃーろんず' }], 200000), null],
  ['P6 Utada Hikaru×宇多田ヒカル(tns 桥)', exp('First Love', ['Utada Hikaru'], 260000),
    cand('First Love', [{ name: '宇多田ヒカル', tns: ['Utada Hikaru'] }], 260000), null],
  ['P7 时长差≤3s 同艺人', exp('曲', ['艺人乙'], 100000),
    cand('曲', [{ name: '艺人乙' }], 103000), null],
  ['P9 双侧同带 cover 标记(对称不拦)', exp('曲名 (Cover)', ['张三'], 180000),
    cand('曲名【歌ってみた】', [{ name: '张三' }], 180000), null],
  ['P10 durMs=0 时长轴跳过', exp('曲', ['艺人'], 0),
    cand('曲', [{ name: '艺人' }], 999999), null],
  ['P10b cand.dt 缺席', exp('曲', ['艺人'], 200000),
    cand('曲', [{ name: '艺人' }], 0), null],
  ["P15 'Cover Girl' 裸token不触发", exp('Cover Girl', ['艺人'], 200000),
    cand('Cover Girl', [{ name: '艺人' }], 200000), null],
  ["P15b 'Discovery' 词内不碰撞", exp('Discovery', ['艺人'], 200000),
    cand('Discovery', [{ name: '艺人' }], 200000), null],
  ["P15c 'Cover Girl (2020 Remaster)'", exp('Cover Girl', ['艺人'], 200000),
    cand('Cover Girl (2020 Remaster)', [{ name: '艺人' }], 200000), null],
  ['P18 expected.title 缺席→marker 轴跳过', exp('', ['艺人'], 200000),
    cand('任意 (Cover)', [{ name: '艺人' }], 200000), null],
  ['P19 (Live) 期望侧 version 族不拦', exp('曲 (Live)', ['艺人'], 200000),
    cand('曲', [{ name: '艺人' }], 200000), null],
  ['P20 202→202 (New Mix) 同艺人+1s', exp('202', ['艺人'], 200000),
    cand('202 (New Mix)', [{ name: '艺人' }], 201000), null],
  ['P21 ar[].alias 命中', exp('First Love', ['Utada Hikaru'], 260000),
    cand('First Love', [{ name: '宇多田ヒカル', alias: ['Utada Hikaru'] }], 260000), null],
];

for (const [label, expected, c, score] of PASS_CASES) {
  test(`放行 ${label}`, () => {
    const { verdict, reasons } = judgeRelayCand(expected, c, score);
    assert.equal(verdict, 'pass', `reasons=${JSON.stringify(reasons)}`);
    assert.deepEqual(reasons, []);
  });
}

// ── §3.4 F8 修订（实机验收钉板）：cover_marker 不对称加艺人轴门 ──────
// 不对称标记只在 artistAxis!=='match' 时进 reasons——同艺人+标题干相同的
// 单侧 (Cover)/翻唱 注记是版本标注非错录音（QQ 源标题常不携带 cover 注记
// 而源录音本身就是该 cover），改投 evidence 'cover_marker_diff' 不拦；
// mismatch 时照进 reasons 作叠加轴；neutral（哨兵/缺失）照拦。
test('F8 实机钉：期望「回る空うさぎ at I SCREAM LIVE」/花譜 × 绑条「…(Cover)」/花譜 → pass', () => {
  const { verdict, reasons, evidence } = judgeRelayCand(
    exp('回る空うさぎ at I SCREAM LIVE', ['花譜'], 186000),
    cand('回る空うさぎ at I SCREAM LIVE (Cover)', [{ name: '花譜' }], 186499), null);
  assert.equal(verdict, 'pass', `实机误拦样本应放行，reasons=${JSON.stringify(reasons)}`);
  assert.deepEqual(reasons, []);
  assert.ok(evidence.includes('cover_marker_diff'),
    `同艺人下的单侧 cover 标差异应进 evidence 诊断，实得 ${JSON.stringify(evidence)}`);
});

test('F8 艺人 neutral+不对称照拦：V.A. 哨兵绑条 cover 注记仍是拦据', () => {
  const { verdict, reasons, evidence } = judgeRelayCand(
    exp('食虫植物', ['EMA'], 166000),
    cand('食虫植物（25时声真似）', [{ name: 'V.A.' }], 162000), null);
  assert.equal(verdict, 'block');
  assert.deepEqual(reasons, ['cover_marker'],
    `neutral 下不对称标记是唯一可用拦据，实得 ${JSON.stringify(reasons)}`);
  assert.ok(evidence.includes('artist_unverifiable'), '哨兵艺人照记 artist_unverifiable');
});

test('F8 艺人 mismatch+不对称叠加：reasons 双含 artist_mismatch/cover_marker', () => {
  const { verdict, reasons } = judgeRelayCand(
    exp('食虫植物', ['EMA'], 166000),
    cand('食虫植物（25时声真似）', [{ name: 'fan声真似' }], 162000), null);
  assert.equal(verdict, 'block');
  assert.deepEqual([...reasons].sort(), ['artist_mismatch', 'cover_marker'],
    'mismatch 下不对称标记作叠加轴——主导拦因仍是 artist_mismatch');
});

test('P8 expected 哨兵艺人 → neutral → pass + artist_unverifiable 证据', () => {
  for (const sentinel of ['QQ 音乐', '未知艺术家', '_']) {
    const { verdict, reasons, evidence } = judgeRelayCand(
      exp('曲', [sentinel], 200000), cand('曲', [{ name: '誰でも' }], 200000), null);
    assert.equal(verdict, 'pass', `${sentinel}: reasons=${JSON.stringify(reasons)}`);
    assert.deepEqual(reasons, []);
    assert.ok(evidence.includes('artist_unverifiable'), `${sentinel} 应记 artist_unverifiable`);
  }
});

test('P16 -11s/4.8% 必拦 duration_off（229s 期望）', () => {
  const { verdict, reasons } = judgeRelayCand(
    exp('曲', ['EMA'], 229000), cand('曲', [{ name: 'EMA' }], 218000), null);
  assert.equal(verdict, 'block');
  assert.ok(reasons.includes('duration_off'));
  assert.ok(!reasons.includes('artist_mismatch'));
});

test('P17 时长边界四钉：8000 放/8001 拦；300s 曲 8.9s 放/9.1s 拦', () => {
  const j = (ms, dt) => judgeRelayCand(exp('曲', ['A'], ms), cand('曲', [{ name: 'A' }], dt), null);
  assert.equal(j(250000, 258000).verdict, 'pass');   // diff==8000 严格大于才拦
  assert.equal(j(250000, 258001).verdict, 'block');  // 8001
  assert.equal(j(300000, 308900).verdict, 'pass');   // 8.9s < 3%=9s
  assert.equal(j(300000, 309100).verdict, 'block');  // 9.1s > 3%=9s
});

test('score 不进判定：高分照拦、低分照放（§3.5）', () => {
  assert.equal(judgeRelayCand(
    exp('娘子', ['周杰伦'], 271000),
    cand('娘子', [{ name: '叶藏澈' }], 326000), 97).verdict, 'block');
  const r = judgeRelayCand(exp('曲', ['A'], 100000), cand('曲', [{ name: 'A' }], 101000), 20);
  assert.equal(r.verdict, 'pass');
  assert.ok(r.evidence.includes('score:20'));
});

// ── §3.1 归一化钉板 ──────────────────────────────────────────────────
test('normArtist：NFKC 前置（全角拉丁/半角カナ）+ 异体折叠 + 剥非字母数字', () => {
  assert.equal(normArtist('Ｕｔａｄａ　Ｈｉｋａｒｕ'), 'utadahikaru'); // 全角拉丁+全角空白
  assert.equal(normArtist('ｸﾗﾑﾎﾞﾝ'), 'クラムボン');                  // 半角カナ→全角
  assert.equal(normArtist('杉恵'), '杉惠');                          // CJK_FOLD 恵→惠
  assert.equal(normArtist(' A-B_c '), 'abc');
});

test('splitMembers：哨兵整串/成员剔除 + 噪声闸 + len≥2', () => {
  assert.deepEqual(splitMembers('QQ 音乐'), []);
  assert.deepEqual(splitMembers('未知艺术家'), []);
  assert.deepEqual(splitMembers('周杰伦 未知艺术家'), ['周杰伦']);
  assert.deepEqual(splitMembers('AA × BB'), ['aa', 'bb']);
  assert.deepEqual(splitMembers('AA feat. BB'), ['aa', 'bb']);
  assert.deepEqual(splitMembers('EMA'), ['ema']); // 单字符成员被 len≥2 滤掉：
  assert.deepEqual(splitMembers('Z'), []);       //   'Z'→[]（§3.1 口径）
  assert.deepEqual(splitArtists('Utada Hikaru'), ['utada', 'hikaru']);
  assert.ok(ARTIST_SENTINEL.has('qq音乐') && ARTIST_SENTINEL.has('未知艺术家'));
});

test('kanaToRomaji/romajiKey：§3.1 四校准钉', () => {
  assert.equal(kanaToRomaji('クラムボン'), 'kuramubon');
  assert.equal(romajiKey('クラムボン'), 'krambon');
  assert.equal(romajiKey('clammbon'), 'klambon');
  assert.equal(romajiKey('にゃーろんず'), 'nyaronz');
  assert.equal(romajiKey('nyarons'), 'nyarons');
});

test('diceBigram：≥4 字符才参与，校准比过阈', () => {
  assert.ok(Math.abs(diceBigram('klambon', 'krambon') - 2 * 4 / 12) < 1e-9);
  assert.ok(diceBigram('klambon', 'krambon') >= DICE_MIN);
  assert.ok(diceBigram('nyarons', 'nyaronz') >= DICE_MIN);
  assert.equal(diceBigram('abc', 'abcdef'), 0); // 短边 <4 不参与
});

test('markerPresent：拉丁 token 限括号群；CJK 子串全串命中', () => {
  assert.equal(markerPresent('回る空うさぎ (Cover)'), true);
  assert.equal(markerPresent('曲【翻唱】'), true);
  assert.equal(markerPresent('曲 歌ってみた'), true);
  assert.equal(markerPresent('Cover Girl'), false);
  assert.equal(markerPresent('Discovery'), false);
  assert.equal(markerPresent('Cover Girl (2020 Remaster)'), false);
  assert.equal(markerPresent('(Discovery)'), false); // 括号内词内碰撞也不中
  assert.equal(markerPresent('ｶﾊﾞｰ付き'), true);      // 半角カナ经 NFKC 命中
  assert.equal(hasCoverMarker('X (self-cover)'), true);
  assert.ok(COVER_MARKER.cjk.includes('カバー') && COVER_MARKER.latin.test('cover'));
});

test('durationAxis/markerAxis：缺参跳过不降级', () => {
  assert.equal(durationAxis(0, 5000), null);
  assert.equal(durationAxis(5000, 0), null);
  assert.equal(durationAxis(250000, 258000), null);   // 边界=阈 放行
  assert.equal(durationAxis(250000, 258001), 'duration_off');
  assert.equal(markerAxis('', 'X (Cover)'), null);
  assert.equal(markerAxis('X', ''), null);
  assert.equal(markerAxis('X', 'X (Cover)'), 'cover_marker');
  assert.equal(markerAxis('X (Cover)', 'X【歌ってみた】'), null);
});

test('artistVerdict 三态 + candArtistTerms tns/alias 并入', () => {
  assert.equal(artistVerdict(['Abc'], ['Abc']), 'match');
  assert.equal(artistVerdict(['Ab'], ['Cd']), 'mismatch');
  assert.equal(artistVerdict(['QQ 音乐'], ['Bcd']), 'neutral');
  assert.equal(artistVerdict(['Ab'], []), 'neutral');
  const terms = candArtistTerms({ ar: [{ name: '宇多田ヒカル', tns: ['Utada Hikaru'], alias: ['UL'] }] });
  assert.deepEqual(terms.sort(), ['UL', 'Utada Hikaru', '宇多田ヒカル'].sort());
});

// ── R10a-S2：成员等值命中的文字感知长度闸 ────────────────────────────
// 纯拉丁成员等值需 ≥3 字符——'dj'=='dj' 式短前缀碰撞会把 'DJ Genki'×
// 'DJ Noriken' 误判同艺人；CJK 双字等值不受闸（'王菲'=='王菲' 照中）。
test("'DJ X' 等值漏判：纯拉丁短成员等值不抵同名 → artist_mismatch", () => {
  const { verdict, reasons } = judgeRelayCand(
    exp('曲', ['DJ Genki'], 200000), cand('曲', [{ name: 'DJ Noriken' }], 200000), null);
  assert.equal(verdict, 'block');
  assert.deepEqual(reasons, ['artist_mismatch']);
  // 回归：CJK 双字等值不受影响（非纯拉丁不受长度闸）
  assert.equal(artistVerdict(['王菲'], ['王菲']), 'match');
  // 回归：≥3 字符纯拉丁等值照常命中
  assert.equal(artistVerdict(['Ema'], ['Ema']), 'match');
  // 2 字符纯拉丁等值即长度闸对象——'dj'=='dj' 不再命中
  assert.equal(artistVerdict(['DJ'], ['DJ']), 'mismatch');
});

test('relayExpectedOf：providerData 组装 + 缺参归空', () => {
  assert.deepEqual(relayExpectedOf({ title: '娘子', author: '周杰伦', neteaseId: '1' }, 271000),
    { title: '娘子', artists: ['周杰伦'], durationMs: 271000 });
  assert.deepEqual(relayExpectedOf(null, 0), { title: '', artists: [], durationMs: 0 });
  assert.deepEqual(relayExpectedOf({ title: 'x', author: '' }, undefined),
    { title: 'x', artists: [], durationMs: 0 });
});

test('常量面冻结', () => {
  assert.equal(RELAY_DUR_ABS_MS, 8000);
  assert.equal(RELAY_DUR_RATIO, 0.03);
  assert.equal(DICE_MIN, 0.6);
  assert.equal(RULE_VERSION, 'a2'); // F8 cover_marker 艺人轴门——规则修订换盐，旧判自然失效
});

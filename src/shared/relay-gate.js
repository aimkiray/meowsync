// ─────────────────────────────────────────────────────────────────────────
// 词源回链音频校验闸——纯判定层（唯一实现，canonical §3 判决定案）
//
// 纯 ESM、零 IO、零依赖外模块副作用——服务端 CJS 经 require(ESM) 消费
// （同 predicates.js/text-norm.js/title-variants.js 形态）。客户端不复刻
// 判定（canonical §8 #6）：播放侧经 /match/audio-check 端点收口。
//
// 判据三轴（§3.6 伪码顺序）：
//   axis1 艺人一致性三态（match/mismatch/neutral——tns/alias 跨文字桥第一通道）
//   axis2 时长偏差（|Δ| > max(8s, 3%·expected) → duration_off，严格大于）
//   axis3 cover 族标记不对称（拉丁 token 限括号群，CJK 子串全串）
// reasons 可多重命中，任一非空即 block；'neutral'/version 族/score 只进
// evidence 诊断不进判定（§3.4/§3.5）。
// ─────────────────────────────────────────────────────────────────────────

import { foldCjkCompat } from './text-norm.js';
import { isPlaceholderAuthor } from './title-variants.js';

// ── 常量面（§4.2 冻结）──────────────────────────────────────────────────
const RULE_VERSION = 'a1';        // 规则版本盐：修订换键，旧判自动失效
const RELAY_DUR_ABS_MS = 8000;    // 时长绝对阈 8s（§3.3 短曲地板）
const RELAY_DUR_RATIO = 0.03;     // 时长比例阈 3%（取两者较大者）
const DICE_MIN = 0.6;             // 跨文字 romajiKey bigram Dice 阈（§3.2c）
const ARTIST_CONTAIN_MIN = 3;     // 成员互包含短边下限（§3.2b/c）

// 哨兵艺人名（normArtist 后键）：QQ 无艺人兜底 'QQ 音乐'（external-songs.js:145
// QQ_ARTIST_FALLBACK）与 download-manager join 兜底 '未知艺术家' 是期望侧
// 实有值——不剔会全场误拦；'youtube'/'bilibili' 同族站位名照收（§3.2）。
// isPlaceholderAuthor（'_'/'unknown'/'va'/'群星' 等）在 splitMembers 内同收。
const ARTIST_SENTINEL = new Set(['qq音乐', 'qqmusic', '未知艺术家', 'youtube', 'bilibili']);

// ── §3.1 归一化 ─────────────────────────────────────────────────────────
// 比较面归一：NFKC 显式前置（全角拉丁→ASCII、半角カナ→全角——normToken
// 本身不含 NFKC）→ lowercase → CJK 异体折叠 → 剥非 \p{L}\p{N}。
// 键不回流持久化/展示。
const normArtist = (s) => foldCjkCompat(
  String(s ?? '').normalize('NFKC').toLowerCase()
).replace(/[^\p{L}\p{N}]+/gu, '');

// 艺人拆分/噪声闸镜像 netease-score.js（ARTIST_SPLIT_RE :76、QUERY_NOISE
// :22-32）——shared 层不可反向依赖服务端模块（netease-score 的 additive 导出
// 供 CJS 编排层消费），判据语义以彼为准、声明各自一份，改动须两侧对齐。
const ARTIST_SPLIT_RE = /\s*(?:\bfeat\.?\b|\bft\.?\b|[、×&，,／/]|\s+)/iu;
const ARTIST_MEMBER_NOISE = new Set([
  'cover', 'covers', 'covered', 'coverver', '커버', '翻唱', '翻弹', '演奏',
  'live', 'official', 'mv', 'audio', 'video', 'lyric', 'lyrics',
  'hd', '4k', '8k', 'remix', 'full', '完整版', '完整',
  'feat', 'ft', 'by', 'ver', 'version', 'ep', 'op', 'ed', 'ost',
  'mix', 'edit', 'demo', 'pv', 'inst', 'instrumental', 'acoustic',
  'karaoke', '8d', 'slowed', 'sped', 'remaster', 'remastered',
  'single', 'album', 'topic',
  '现场', '伴奏', '演唱会', '单曲', '专辑', '中字', '字幕', '合集',
  '试听', '自制', '搬运', '转载',
]);

// 成员级拆分（str|arr）：整串哨兵/占位先行剔除（'QQ 音乐' 整串哨兵命中，
// 防其 'qq'/'音乐' 碎片漏进成员集）；拆分后成员过 isPlaceholderAuthor +
// 哨兵 + QUERY_NOISE 闸，normArtist 后 len≥2。两侧同口径——哨兵剔除
// 对 cand 侧同施（'V.A.' 类无信息条目归 neutral 不拦，§3.2「无信息不罚」）。
const splitMembers = (input) => {
  const list = Array.isArray(input) ? input : [input];
  const out = new Set();
  for (const item of list) {
    const raw = String(item ?? '');
    if (!raw.trim() || isPlaceholderAuthor(raw) || ARTIST_SENTINEL.has(normArtist(raw))) continue;
    for (const piece of raw.split(ARTIST_SPLIT_RE)) {
      if (!piece.trim() || isPlaceholderAuthor(piece)) continue;
      const m = normArtist(piece);
      if (m.length >= 2 && !ARTIST_MEMBER_NOISE.has(m) && !ARTIST_SENTINEL.has(m)) out.add(m);
    }
  }
  return [...out];
};
const splitArtists = splitMembers;

// ── 假名→Hepburn 近似转写（比较面非学术转写——表本体是实现细节，
//    以 §7 校准样本钉板为准）──────────────────────────────────────────
// 拗音二字组合先查表、促音っ并入后辅音（っち→tchi）、长音ー展开为前元音
// 重复（叠字母塌缩交由 romajiKey 收平）；片假名先归并平假名再查表，
// 非假名字符（汉字/拉丁/数字）原样透传进键。
const KANA_DIGRAPH = new Map(Object.entries({
  きゃ: 'kya', きゅ: 'kyu', きょ: 'kyo', しゃ: 'sha', しゅ: 'shu', しょ: 'sho',
  ちゃ: 'cha', ちゅ: 'chu', ちょ: 'cho', にゃ: 'nya', にゅ: 'nyu', にょ: 'nyo',
  ひゃ: 'hya', ひゅ: 'hyu', ひょ: 'hyo', みゃ: 'mya', みゅ: 'myu', みょ: 'myo',
  りゃ: 'rya', りゅ: 'ryu', りょ: 'ryo', ぎゃ: 'gya', ぎゅ: 'gyu', ぎょ: 'gyo',
  じゃ: 'ja', じゅ: 'ju', じょ: 'jo', ぢゃ: 'ja', ぢゅ: 'ju', ぢょ: 'jo',
  びゃ: 'bya', びゅ: 'byu', びょ: 'byo', ぴゃ: 'pya', ぴゅ: 'pyu', ぴょ: 'pyo',
}));
const KANA_TABLE = new Map(Object.entries({
  あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o',
  か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko',
  さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so',
  た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to',
  な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no',
  は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho',
  ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo',
  や: 'ya', ゆ: 'yu', よ: 'yo', ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro',
  わ: 'wa', ゐ: 'wi', ゑ: 'we', を: 'wo', ん: 'n',
  が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go',
  ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo',
  だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do',
  ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo',
  ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po', ゔ: 'vu',
  ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o',
  ゃ: 'ya', ゅ: 'yu', ょ: 'yo', ゎ: 'wa', ゕ: 'ka', ゖ: 'ke',
}));
const toHira = (c) => {
  const k = c.codePointAt(0);
  return k >= 0x30A1 && k <= 0x30F6 ? String.fromCodePoint(k - 0x60) : c;
};
const hasKana = (s) => /[ぁ-ゖァ-ヶー]/.test(s);

const kanaToRomaji = (s) => {
  const src = String(s ?? '');
  // 第 i 位的转写单元：拗音双字优先（len=2），否则单字；非假名原样
  const unitAt = (i) => {
    if (i + 1 < src.length) {
      const d = KANA_DIGRAPH.get(toHira(src[i]) + toHira(src[i + 1]));
      if (d) return { r: d, len: 2 };
    }
    const r = KANA_TABLE.get(toHira(src[i]));
    return r ? { r, len: 1 } : { r: src[i], len: 1 };
  };
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === 'ー' || ch === 'ｰ') {                    // 长音并入前元音
      const m = /([aiueo])[^aiueo]*$/.exec(out);
      if (m) out += m[1];
      continue;
    }
    if (ch === 'っ' || ch === 'ッ') {                    // 促音并入后辅音
      const r = i + 1 < src.length ? unitAt(i + 1).r : '';
      out += r.startsWith('ch') ? 't'                    // っち → tchi
        : (/^[bcdfghjklmnpqrstvwxyz]/.test(r) ? r[0] : 't');
      continue;
    }
    const { r, len } = unitAt(i);
    out += r;
    i += len - 1;
  }
  return out;
};

// romajiKey（§3.1）：normArtist → 含假名侧逐字转写 → 宽松折叠。
// 折叠面：c→k（两侧同函数同口径，'ch'→'kh' 对双方等价）、叠字母塌缩
// （mm→m / 长音展开后的 aa→a）、辅音间非重读 u 剔除。
// l→r 只施于假名转写产出（转写本就没有 l/r 对立）；对纯拉丁串保留 l/r
// 区别——'clammbon'→'klambon' vs 'クラムボン'→'krambon' 靠 Dice≈0.67
// 跨文字桥命中而非强等值，canonical §3.1 校准钉板即此形态。
const WEAK_U_RE = /([kstnhmrgzdbp])u(?=[kstnhmrgzdbp]|$)/g;
const romajiKey = (s) => {
  const n = normArtist(s);
  if (!n) return '';
  let t = hasKana(n) ? kanaToRomaji(n).replace(/l/g, 'r') : n;
  t = t.replace(/c/g, 'k')
    .replace(/([a-z])\1+/g, '$1')
    .replace(WEAK_U_RE, '$1');
  return t;
};

// romajiKey 字符 bigram 集合 Dice = 2|A∩B|/(|A|+|B|)；两侧均须 ≥4 字符
// 才参与（防小集合噪声——§3.1）
const diceBigram = (a, b) => {
  if (a.length < 4 || b.length < 4) return 0;
  const grams = (s) => {
    const g = new Set();
    for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2));
    return g;
  };
  const A = grams(a), B = grams(b);
  let hit = 0;
  for (const g of A) if (B.has(g)) hit++;
  return (2 * hit) / (A.size + B.size);
};

// ── §3.2 艺人一致性三态 ────────────────────────────────────────────────
// expectedArtists：期望侧艺人名数组（providerData.author ' ' join 原样入列，
// 成员拆分归 splitMembers）；candArtists：candArtistTerms 扁平串数组
// （ar[].name ∪ tns ∪ alias——跨文字桥第一通道）。
// 返回 'match' | 'mismatch' | 'neutral'（任一侧空集=无信息不奖不罚）。
const PURE_LATIN_RE = /^[a-z0-9]+$/;
const artistVerdict = (expectedArtists, candArtists) => {
  const exp = splitMembers(expectedArtists);
  const can = splitMembers(candArtists);
  if (!exp.length || !can.length) return 'neutral';
  for (const a of exp) {
    for (const b of can) {
      // a) 等值——纯拉丁成员等值需 ≥3 字符（'dj'=='dj' 式短前缀碰撞
      // 会把 'DJ Genki'×'DJ Noriken' 误判同艺人）；CJK 双字等值不受
      // 闸（'王菲' 非纯拉丁照中）——与互包含短边下限同阈
      if (a === b && (a.length >= ARTIST_CONTAIN_MIN || !PURE_LATIN_RE.test(a))) {
        return 'match';
      }
      if (Math.min(a.length, b.length) >= ARTIST_CONTAIN_MIN
        && (a.includes(b) || b.includes(a))) return 'match';           // b) 互包含
      // c) 跨文字桥：一侧纯拉丁另一侧含假名 → romajiKey 等值/互包含/Dice；
      //    双侧含假名同款桥（平/片假名异写：にゃーろんず×ニャーロンズ）。
      //    转写键须纯拉丁才参与——'深水チエ'→'深水khie' 含 CJK 不比（§3.2 钉）
      const cross = (PURE_LATIN_RE.test(a) && hasKana(b))
        || (hasKana(a) && PURE_LATIN_RE.test(b))
        || (hasKana(a) && hasKana(b));
      if (!cross) continue;
      const ka = romajiKey(a), kb = romajiKey(b);
      if (!PURE_LATIN_RE.test(ka) || !PURE_LATIN_RE.test(kb)) continue;
      if (ka === kb) return 'match';
      if (Math.min(ka.length, kb.length) >= ARTIST_CONTAIN_MIN
        && (ka.includes(kb) || kb.includes(ka))) return 'match';
      if (diceBigram(ka, kb) >= DICE_MIN) return 'match';
    }
  }
  return 'mismatch';
};

// 候选侧艺人词面全集：song_detail ar[].name ∪ ar[].tns[] ∪ ar[].alias[]
// （tns/alias 是网易艺人条目译名/别名槽——上游真字段）；artists[] 同构
// 兼容，元素偶发裸字符串也收（netease-score candArtistNames 同口径）。
const candArtistTerms = (cand) => {
  const arr = Array.isArray(cand?.ar) ? cand.ar
    : (Array.isArray(cand?.artists) ? cand.artists : []);
  const out = [];
  for (const a of arr) {
    if (typeof a === 'string') { if (a) out.push(a); continue; }
    if (a?.name) out.push(a.name);
    for (const k of ['tns', 'alias']) {
      if (Array.isArray(a?.[k])) out.push(...a[k].filter(Boolean));
    }
  }
  return out;
};

// ── §3.3 时长偏差 ──────────────────────────────────────────────────────
// 任一参缺失 → 跳过本轴不降级；严格大于——diff==8000 放行、8001 拦。
const durationAxis = (expectedMs, candMs) => {
  const e = Number(expectedMs), c = Number(candMs);
  if (!(e > 0) || !(c > 0)) return null;
  return Math.abs(c - e) > Math.max(RELAY_DUR_ABS_MS, e * RELAY_DUR_RATIO)
    ? 'duration_off' : null;
};

// ── §3.4 cover 族标记不对称 ────────────────────────────────────────────
// 词表 canonical 原样。拉丁 token 限括号群内命中（修 'Cover Girl'/
// 'Discovery' 词内碰撞——裸 token 不中）；CJK/假名类无词边界问题，
// 标题串内子串命中即算（含括内外）。
const COVER_MARKER = {
  latin: /\b(?:cover|covers|covered|coverver|selfcover|self-cover)\b/i,
  cjk: ['カバー', 'カヴァー', '翻唱', '翻唱版', '歌ってみた', '歌みた',
    '歌いました', '弾いてみた', '声真似', 'セルフカバー'],
};
// 全括号群提取（镜像 netease-score.js:38 BRACKET_GROUP_RE——同层不可
// 反向依赖，声明各自一份）
const BRACKET_GROUP_RE = /[[(（【][^[\]()（）【】]{0,60}?[\])）】]/g;

const markerPresent = (title) => {
  const s = String(title ?? '').normalize('NFKC');
  if (!s) return false;
  for (const m of s.matchAll(BRACKET_GROUP_RE)) {
    if (COVER_MARKER.latin.test(m[0])) return true;
  }
  return COVER_MARKER.cjk.some((k) => s.includes(k));
};
const hasCoverMarker = markerPresent;

// version 族（ver./remix/New Mix/live/remaster/acoustic）【不进否决词表】——
// 同艺人同曲名版本注释常是同一录音标注（'202'→'202 (New Mix)' 实据，
// remaster 音频语义等价）；只进 evidence 诊断。与拉丁 cover 同纪律限括号群。
const VERSION_MARKER_RE = /\b(?:ver(?:sion)?\.?|remix|new\s*mix|live|remaster(?:ed)?|acoustic)\b/i;
const versionMarkerPresent = (title) => {
  const s = String(title ?? '').normalize('NFKC');
  if (!s) return false;
  for (const m of s.matchAll(BRACKET_GROUP_RE)) {
    if (VERSION_MARKER_RE.test(m[0])) return true;
  }
  return false;
};

// 两侧标题任一缺席 → 本轴整体跳过（缺参不降级，与时长闸同口径）。
// 双向不对称都拦：期望无标+候选有=绑到翻唱条目；期望有标+候选无=
// 源曲是翻唱版却绑到原曲录音——同为错录音。
const markerAxis = (expectedTitle, candName) => {
  if (!expectedTitle || !candName) return null;
  return markerPresent(candName) !== markerPresent(expectedTitle)
    ? 'cover_marker' : null;
};

// ── §3.6 判定总控 ──────────────────────────────────────────────────────
// expected={title,artists[],durationMs}；cand=song_detail 绑条原始形态
// {name, ar|artists[{name,tns,alias}], dt|dtMs|duration}；score 只透传
// evidence 不进分支（§3.5）。返回 {verdict:'pass'|'block', reasons[],
// evidence[]}——reasons 可多重命中（娘子=artist_mismatch+duration_off），
// 'neutral'→'artist_unverifiable'、version 族差异只进 evidence 不拦。
function judgeRelayCand(expected, cand, score) {
  const reasons = [], evidence = [];
  const av = artistVerdict(expected?.artists, candArtistTerms(cand));
  if (av === 'mismatch') reasons.push('artist_mismatch');
  else if (av === 'neutral') evidence.push('artist_unverifiable');

  const dur = durationAxis(expected?.durationMs,
    cand?.dt ?? cand?.dtMs ?? cand?.duration);
  if (dur) reasons.push(dur);

  const mk = markerAxis(expected?.title, cand?.name);
  if (mk) reasons.push(mk);
  else if (expected?.title && cand?.name
    && versionMarkerPresent(expected.title) !== versionMarkerPresent(cand.name)) {
    evidence.push('version_marker_diff');
  }

  if (Number.isFinite(score)) evidence.push(`score:${score}`);
  return { verdict: reasons.length ? 'block' : 'pass', reasons, evidence };
}

// ── §4.2 期望曲元数据组装 ──────────────────────────────────────────────
// providerData 快照（download-fs.js 任务块：title≤300 / author≤120，
// author 为 ar[].name join(' ') 串——原样单条入列，成员拆分归 splitMembers，
// ARTIST_SPLIT_RE 本就为 ' ' join 设计）。缺参归空：判据逐轴跳过不降级
// （老任务 providerData=null → 各轴全跳 → pass）。
const relayExpectedOf = (providerData, expectedMs) => {
  const title = typeof providerData?.title === 'string' ? providerData.title : '';
  const author = typeof providerData?.author === 'string' ? providerData.author.trim() : '';
  return {
    title,
    artists: author ? [author] : [],
    durationMs: Number.isFinite(expectedMs) && expectedMs > 0 ? Math.round(expectedMs) : 0,
  };
};

export {
  RULE_VERSION, RELAY_DUR_ABS_MS, RELAY_DUR_RATIO, DICE_MIN,
  ARTIST_CONTAIN_MIN, ARTIST_SENTINEL, COVER_MARKER,
  normArtist, splitMembers, splitArtists,
  kanaToRomaji, romajiKey, diceBigram,
  artistVerdict, candArtistTerms,
  durationAxis, markerPresent, hasCoverMarker, markerAxis,
  versionMarkerPresent,
  judgeRelayCand, relayExpectedOf,
};

// 候选打分器（纯函数，零 IO）：把「这首网易云候选是不是源视频/源曲」拆成
// title(0-50)/artist(0-30)/duration(0-20)/flags 修正四维证据，替代旧的
// 「首个 shareName 命中即收」。reject=硬闸否决（源有时长且差>45s、源无伴奏
// 标记而候选带伴奏标记，rejectKind 区分 dur/marker）；title 证据过弱（<15）
// 时总分封顶在 GRAY 下沿——纯时长/纯艺人命中永远进不了确定性收线，
// 与「错歌词比没歌词更糟」同哲学。中立艺人分（源/候选任一缺艺人信息）配
// 非精确 title（<50）同样压到灰区下——同名异曲在艺人缺位时无反证。
//
// src = { titles:[str], artists:[str], durationSec }
//   titles：本请求已知标题面（查询串 ∪ 候选串 ∪ 源标题）——任一配对命中即给分
//   artists：源艺人参照（源 author ∪ artists[]），空=无艺人信息→中立分 15
//   durationSec：源秒数；0/缺失=无时长证据（不加分也不硬闸）

// CJK 繁→简折叠表与 normToken 归一化已上提到共享层 src/shared/
// text-norm.js（title-variants normKey、lyric-external normName 与
// 打分比对共用同一份折叠口径）——本文件透传导出，消费方签名不变
const { foldCjkCompat, normToken } = require('../../shared/text-norm.js');


// 修饰/噪声词表：艺人参照成员过滤与查询 token 判定共用（子串碰撞面注释
// 保留原考据——'ep'⊂'deeppurple'、'olive'吞'live' 这类假交集教训）
const QUERY_NOISE = new Set([
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
const noiseKey = (t) => String(t ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

// 歌名第二变体：全括号群剥除——「乐园(粤)」「Title (Live)」「歌名【翻唱】」
// 的括内修饰参与比对只会稀释相似度；配对时使用剥除变体命中×0.9 降权
// （剥了才长得像≠原串真相等）
const BRACKET_GROUP_RE = /[[(（【][^[\]()（）【】]{0,60}?[\])）】]/g;
const stripBrackets = (s) => String(s || '').replace(BRACKET_GROUP_RE, ' ');

const ACCEPT_SCORE = 75;  // ≥75 确定性收（matchedBy=查询串）
const GRAY_SCORE = 50;    // 50-74 灰区：有 AI 复核、无 AI 宽松收；<50 丢
const DUR_HARD_GATE_SEC = 45; // 沿用旧 MATCH_DUR_TOLERANCE_SEC 的硬闸值

// 归一化串两两比对：精确=50；互包含=35+15×短长比（短串全嵌长串是强信号，
// 但长串里掺了多少修饰要折损）；<2 字符无比对价值
const pairTitleScore = (na, nb) => {
  if (na.length < 2 || nb.length < 2) return 0;
  if (na === nb) return 50;
  if (na.includes(nb) || nb.includes(na)) {
    return 35 + 15 * (Math.min(na.length, nb.length) / Math.max(na.length, nb.length));
  }
  return 0;
};

// token Jaccard：跨语/噪声标题下互包含会失效，词袋重合是兜底证据。
// token 过滤噪声词（'cover'/'live' 满天飞，会让两个无关串假性重合）
const titleTokensOf = (s) => new Set(
  String(s || '').split(/[^\p{L}\p{N}]+/u)
    .map(noiseKey)
    .filter(t => t.length >= 2 && !QUERY_NOISE.has(t)));

const jaccardTitleScore = (a, b) => {
  const ta = titleTokensOf(a);
  const tb = titleTokensOf(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const j = inter / (ta.size + tb.size - inter);
  return j >= 0.6 ? 20 + 15 * (j - 0.6) / 0.4 : 0;
};

// 艺人拆分：'A feat. B'、'A/B'、'A、B'、'A,B'、'A×B'、'A&B' 与裸空格多写
// （QQ 侧 author 就是 join(' ') 产物）。成员过噪声闸——'feat'/'ft' 碎片、
// 'DJ X' 拆出的 'dj' 这类不掺和比对
const ARTIST_SPLIT_RE = /\s*(?:\bfeat\.?\b|\bft\.?\b|[、×&，,／/]|\s+)/iu;
const artistMembers = (s) => String(s || '').split(ARTIST_SPLIT_RE)
  .map(normToken).filter(t => t.length >= 2 && !QUERY_NOISE.has(noiseKey(t)));

// 候选艺人名数组（云搜 ar/artists[].name；元素偶发裸字符串也收）
const candArtistNames = (song) => {
  const arr = Array.isArray(song?.ar || song?.artists) ? (song.ar || song.artists) : [];
  return arr.map(a => (typeof a === 'object' ? a?.name : a)).filter(Boolean);
};

// 艺人分：整串精确=30；整串互包含（短边≥2，'王菲' 类短名艺人合法）=25；
// 成员级（exact/包含，短边≥3——'DJ Snake' vs 'DJ Okawari' 的 'dj' 碰撞
// 不收）=25；源或候选任一缺失艺人信息=中立 15（无信息不奖不罚，feats
// 立 artistNeutral 标——该分不得参与确定性收，见 scoreCandidate 尾部）；
// 有参照却零交集=0（不给负分——翻唱/异唱合法，靠其他维与 AI 兜）
function artistScore(srcArtists, candNames, feats) {
  const refWholes = new Set();
  const refMembers = new Set();
  for (const a of (Array.isArray(srcArtists) ? srcArtists : [])) {
    const w = normToken(a);
    if (w.length >= 2 && !QUERY_NOISE.has(noiseKey(a))) refWholes.add(w);
    for (const m of artistMembers(a)) refMembers.add(m);
  }
  const candWholes = new Set();
  const candMembers = new Set();
  for (const a of candNames) {
    const w = normToken(a);
    if (w.length >= 2 && !QUERY_NOISE.has(noiseKey(a))) candWholes.add(w);
    for (const m of artistMembers(a)) candMembers.add(m);
  }
  if (!refWholes.size && !refMembers.size) { feats.artistNeutral = true; return 15; }
  if (!candWholes.size && !candMembers.size) { feats.artistNeutral = true; return 15; }
  let best = 0;
  for (const r of refWholes) {
    for (const cw of candWholes) {
      if (r === cw) return 30;
      if (r.includes(cw) || cw.includes(r)) best = 25;
    }
  }
  for (const r of refMembers) {
    for (const m of candMembers) {
      if (r === m ? Math.min(r.length, m.length) >= 3
        : (r.includes(m) && m.length >= 3) || (m.includes(r) && r.length >= 3)) {
        best = Math.max(best, 25);
      }
    }
  }
  return best;
}

// 候选名变体标记：inst/伴奏/カラオケ 类在源无同标时是另一类内容（硬拒）；
// Live/remix/ver. 类在源无同标时是版本错位（−10 降权不判死）
const CAND_INST_RE = /\b(?:inst(?:rumental)?s?|off[\s-]?vocal|karaoke)\b|伴奏|カラオケ/i;
const CAND_LIVE_RE = /\blive\b|\bremix\b|\bver\.?\d*\b|\bversion\b|现场|演唱会/i;

// song: cloudsearch 原始条目 {id,name,ar|artists,al|album,dt|duration}
// 返回 {score, feats:{title,artist,dur,penalty,durDiff,artistNeutral},
//       reject, rejectKind:'dur'|'marker'}
function scoreCandidate(song, src) {
  const feats = { title: 0, artist: 0, dur: 0, penalty: 0, durDiff: null, artistNeutral: false };
  const candName = String(song?.name || '');
  const candNorm = normToken(candName);
  const candStrip = normToken(stripBrackets(candName));
  const titles = (Array.isArray(src?.titles) ? src.titles : [])
    .map(t => String(t || '')).filter(t => t.trim());
  for (const t of titles) {
    const tNorm = normToken(t);
    const tStrip = normToken(stripBrackets(t));
    let best = pairTitleScore(candNorm, tNorm);
    // 任一侧剥除变体参与的配对按 0.9 降权（剥了才像的相似度打折）
    if (candStrip !== candNorm || tStrip !== tNorm) {
      best = Math.max(best, pairTitleScore(candStrip, tStrip) * 0.9);
    }
    best = Math.max(best, jaccardTitleScore(candName, t));
    if (best > feats.title) feats.title = best;
  }
  feats.artist = artistScore(src?.artists, candArtistNames(song), feats);

  const srcDur = Number.isFinite(src?.durationSec) ? src.durationSec : 0;
  const candSec = (Number(song?.dt) || Number(song?.duration) || 0) / 1000;
  if (srcDur > 0 && candSec > 0) {
    feats.durDiff = Math.abs(candSec - srcDur);
    // rejectKind='dur'：时长类硬拒留在 AI 兜底池（长片头视频靠 pick 120s
    // 粗闸救济是设计意图）；'marker' 才整池开除
    if (feats.durDiff > DUR_HARD_GATE_SEC) return { score: 0, feats, reject: true, rejectKind: 'dur' };
    feats.dur = feats.durDiff <= 2 ? 20 : feats.durDiff <= 5 ? 16
      : feats.durDiff <= 15 ? 10 : feats.durDiff <= 30 ? 5 : 2;
  }

  const srcText = titles.join(' ');
  if (CAND_INST_RE.test(candName) && !CAND_INST_RE.test(srcText)) {
    return { score: 0, feats, reject: true, rejectKind: 'marker' };
  }
  if (CAND_LIVE_RE.test(candName) && !CAND_LIVE_RE.test(srcText)) feats.penalty = 10;

  let score = feats.title + feats.artist + feats.dur - feats.penalty;
  // title 证据 <15 = 名几乎不沾边——时长/艺人再合也不能过灰区下沿
  if (feats.title < 15) score = Math.min(score, GRAY_SCORE - 1);
  // 中立艺人分配非精确 title：同名异曲在艺人信息缺位时没有反证，互含
  // title 45 + 中立 15 + 时长近 16 = 76 能越过确定性线——压到灰区下；
  // 候选仍在已见集里，AI 兜底挑回的路留着
  if (feats.artistNeutral && feats.title < 50) score = Math.min(score, GRAY_SCORE - 1);
  return { score: Math.max(0, Math.round(score)), feats, reject: false };
}

module.exports = {
  scoreCandidate, normToken, noiseKey, stripBrackets, foldCjkCompat, QUERY_NOISE,
  ACCEPT_SCORE, GRAY_SCORE, DUR_HARD_GATE_SEC,
  ARTIST_SPLIT_RE, artistMembers, candArtistNames,
};

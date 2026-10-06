// ─────────────────────────────────────────────────────────────────────────
// UGC 标题变体层（唯一真相源）
//
// 纯 ESM、零 IO、零顶层 await——服务端 CJS 经 require(ESM)（Node ≥20.19 /
// ≥22.12）消费同一文件，与 predicates.js 同形态。两处消费：
//   services/lyric-external.js  外源歌词级联的检索词展开（LRCLIB/酷狗）
//   services/netease-match.js   网易云匹配漏斗的 candidates 展开
// 规则/正则只在这里维护一份——两处各写一份的漂移面正是本文件要消灭的。
// ─────────────────────────────────────────────────────────────────────────

// 归一化键：trim + 小写 + 空白折叠——变体去重、级联缓存键、匹配候选去重共用
export const normKey = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// 检索标题清理：视频站标题的「MV/官方/4K/字幕」类括弧装饰会稀释检索命中
// ——只剥明显视频语境的括弧段；live/cover 这类版本限定词保留（剥了会
// 错配录音室版词）
const VIDEO_TAG_RE = /[【\[（(][^\]】)）]{0,60}(?:mv|official|video|audio|hd|uhd|4k|8k|lyrics?|官方|字幕|高清|完整版|音乐录像带)[^\[（(【\]】)）]{0,60}[\]】)）]/gi;
export function cleanQueryTitle(title) {
  const raw = String(title || '').replace(/\s+/g, ' ').trim();
  const cleaned = raw.replace(VIDEO_TAG_RE, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || raw;
}

// UGC 投稿标题剥艺人候选：bv_/yt_ 语境的 artist 实为 UP 主/频道名，
// artistHit 硬滤对曲库艺人名必灭——从标题形态里补一个真实艺人候选：
//   'A - B' / 'A – B'  YouTube「Artist - Song」与 B 站「UP主 - 标题」同形
//   'A《B》'           书名号前段常是艺人（'周杰伦《晴天》'）
//   '【A】B'           B 站前缀段（艺人/栏目——【4K】这类已在 cleanQueryTitle
//                      剥掉；残存误候选由归属核验兜）
// 剥不出归 ''。只产候选不改写 title——检索词仍用完整标题
export function artistFromTitle(title) {
  const t = cleanQueryTitle(title);
  const strip = (s) => String(s || '').replace(/[【】\[\]（）()「」『』]/g, '').trim();
  let m = t.match(/^\s*(.{1,40}?)\s+[-–—]\s+\S/);
  if (m) return strip(m[1]);
  m = t.match(/^\s*(.{1,40}?)\s*《[^》]{1,80}》/);
  if (m) return strip(m[1]);
  m = t.match(/^\s*【([^】]{1,30})】\s*\S/);
  if (m) return strip(m[1]);
  return '';
}

// 无信息量占位作者判定：UGC 元数据的 author 常是 '_'/'unknown'/'VA'/
// 'Various Artists'/'anonymous'/'群星'/'佚名'/'名無し'/'ななし' 这类占位符，
// 或 '--'/'__' 纯标点/下划线串、'ー'/'ｰ' 纯日文长音符串。
// 占位作者不算艺人参照——进 artists 槽稀释比对、作艺人锚会误吃标题首词。
// 大小写不敏感、trim 后判；比对键剥掉非标点字（'V.A.'/'v_a'/'UNKNOWN!' 同归）。
const PLACEHOLDER_AUTHOR_KEYS = new Set([
  'unknown', 'anonymous', 'various', 'variousartists', 'va',
  '群星', '佚名', '名無し', 'ななし',
]);
export function isPlaceholderAuthor(author) {
  const s = String(author ?? '').trim();
  if (!s) return true;                        // 空串=无信息
  // 纯标点/下划线串（'_'/'--'/'__'）；日文长音符 'ー'/'ｰ' 挂 \p{Lm} 字母
  // 籍，非标点剥除抓不到——先剔再判，纯长音/长音混标点（'ー_'）同收
  if (!/[\p{L}\p{N}]/u.test(s.replace(/\p{Lm}+/gu, ''))) return true;
  return PLACEHOLDER_AUTHOR_KEYS.has(s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''));
}

// 检索标题变体：VTuber/翻唱投稿标题常带检索噪声段——'ver.<歌姬>' 尾缀、
// cover 标记、尾括弧、'Artist - Title' 前缀、【栏目】头、feat. 尾、
// '曲 ／ 演唱者' 斜杠尾、'を歌いました/歌ってみた' 日语翻唱语尾、
// 中文字幕/中字/CC字幕 字幕组标记、艺人名头尾缀。
// 实证病例：'Dream Play Sick ver.EMA' 原始形态级联全灭、剥成
// 'Dream Play Sick' 后 LRCLIB 命中（lrclib_25010661）；
// 'ロストアンブレラを歌いました ／ rei sirose' 要斜杠尾+歌系中缀双剥才出真名。
// 基座 = cleanQueryTitle（已剥 MV/官方类视频语境括弧）占首，规则集对基座
// 各剥一层产单变体——剥一层即止不滚雪球；normKey 去重，总量上限 4 项。
// 「激进变体」= 全规则迭代到不动点（≤3 趟）：单规则产不出的复合噪声形态
// 靠它兜底，保底末位槽（最冒险最后试）——它有效时单变体只取前 2 给它
// 留位，无效/与已有项重复时单变体取满 3 不浪费槽位。
// 变体只喂检索词——归属核验签名仍用调用方原始 title（见 cascade）。
// ver/feat/艺人锚剥缀带边界断言：'Conver. x'/'Somewith you'/'EMAIL'/
// 'ver.EMA' 这类词干内嵌的形态不误剥出残片变体。
// routes/youtube.js extractYtSong 的 candidates 补腿与 a 规则同口径——
// VER_TAIL_RE 改动要两边同步。
const VER_TAIL_RE = /\s*[-–—~\/|：:]?\s*(?<![\p{L}\p{N}])ver(?:sion)?[\.。]\s*[\p{L}\p{N}][\p{L}\p{N}\s_'&·-]{0,30}$/iu;
// b 系 cover 尾缀三件：cover 语义的尾括弧组 / 'covered by X'（'×' 多人连接
// 不挡路——cover 语后整段剥）/ 分隔符引导的裸 cover 尾
const COVER_BRACKET_TAIL_RE = /[（(【\[][^（）()【】\[\]]{0,38}?\bcover(?:ed|s)?\b[^（）()【】\[\]]{0,38}?[)）】\]]\s*$/iu;
const COVER_BY_TAIL_RE = /[\s\-–—~\/|：:／]+cover(?:ed)?\s+by\s+\S.{0,38}$/iu;
const BARE_COVER_TAIL_RE = /[\s\-–—~\/|：:／]+covers?\s*$/iu;
const TAIL_GROUP_RE = /(?:（[^（）]{1,40}）|\([^()]{1,40}\)|【[^【】]{1,40}】|\[[^\[\]]{1,40}\])\s*$/u;
const ARTIST_DASH_HEAD_RE = /^.{1,40}?\s*[-–—]\s+/;
const HEAD_BANG_RE = /^【[^【】]{1,40}】\s*/u;
const FEAT_TAIL_RE = /\s*(?<![\p{L}\p{N}])(?:feat\.?|ft\.?|featuring|with)\s+.{1,40}$/i;
// 斜杠尾：'X ／ Y'/'X / Y'（全/半角、前后空格可缺）尾段 ≤40 字——VTuber
// 标题挂演唱者尾巴的常见形态（'幸福な死を ／ 久遠千歳'）
const SLASH_TAIL_RE = /\s*[/／]\s*[^/／]{1,40}\s*$/u;
// 日语翻唱语尾/中缀：を歌いました/歌ってみた/歌った/歌わせて頂きました/
// 歌ってみたよ——仅近行尾才剥（尾段 ≤12 字且不含斜杠/括弧），标题中段的
// 歌系词不剥，叠了斜杠尾的形态留给激进变体双剥
const UTA_TAIL_RE = /\s*[をはが]?\s*歌(?:いました|ってみた|った|わせて頂きました|ってみたよ)[^\/／（(【\[]{0,12}$/iu;
// 字幕组标记：出现即剥（剥完非空才收，push 闸把空结果滤掉）——长短语
// 先列（'中文字幕' 先于子串 '中字'，'付き' 先于 '付'）
const SUBTITLE_TAG_RE = /\s*(?:CC字幕|中文字幕|字幕付き|歌詞付き|歌词付き|字幕付|歌詞付|歌词付|中字)\s*/giu;
// 艺人锚用归一分隔符字符集（与归一化剥除同族，加冒号/全角斜杠/波浪）
const NAME_SEP_CH = String.raw`\s\-_·•、,，。&+＋/／\\'’"（）()【】\[\]:：~～|`;
const NAME_SEP_RUN = new RegExp(`[${NAME_SEP_CH}]+`);
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// artist 可缺省：级联传调用方原始 artist——变体生成是输入清洗，与归属
// 轮次（roundArtist 降轮）解耦；匹配漏斗传「首个非占位艺人」（占位传 ''）
export function titleVariantsOf(title, artist = '') {
  const base = cleanQueryTitle(title);
  const seen = new Set([normKey(base)]);
  // 单规则变体先全量收集（normKey 去重、保规则序）——席位在末尾拼装时
  // 再切，好给激进变体保底末位槽（见 return 前注释）
  const singles = [];
  const collect = (v) => {
    const t = String(v || '').replace(/\s+/g, ' ').trim();
    if (!t) return;
    const k = normKey(t);
    if (seen.has(k)) return;
    seen.add(k);
    singles.push(t);
  };
  // 艺人锚：parts 间容许任意连接料（与归一后比同口径），锚后须分隔符或
  // 行尾——'EMA' 不切进 'EMAIL'/'ver.EMA' 的词干粘连
  const ap = String(artist || '').trim().split(NAME_SEP_RUN).filter(Boolean).map(escRe);
  const ab = ap.join(`[${NAME_SEP_CH}]*`);
  // 规则集：每条对输入剥一层——单规则变体对基座各剥一次；激进变体对
  // 进化中的串迭代应用
  const rules = [
    // a. 尾缀 ver.<名>——$ 锚定只剥尾巴，标题中段的 ver. 不动
    (s) => s.replace(VER_TAIL_RE, ''),
    // b. cover 尾缀——cleanQueryTitle 故意保 cover 括弧作版本限定，但作
    //    检索变体剥掉是对的（cover 与原曲同词）
    (s) => s.replace(COVER_BRACKET_TAIL_RE, '')
            .replace(COVER_BY_TAIL_RE, '')
            .replace(BARE_COVER_TAIL_RE, ''),
    // c. 尾括弧组：'乐园(粤)' → '乐园'——只剥最后一个、组内 ≤40 字
    (s) => s.replace(TAIL_GROUP_RE, ''),
    // d. 'Artist - Title' 前缀——artistFromTitle 的 title 侧补腿
    (s) => s.replace(ARTIST_DASH_HEAD_RE, ''),
    // e. 头部【…】B 站栏目头
    (s) => s.replace(HEAD_BANG_RE, ''),
    // f. 尾缀 feat./ft./featuring/with X
    (s) => s.replace(FEAT_TAIL_RE, ''),
    // g. 斜杠尾
    (s) => s.replace(SLASH_TAIL_RE, ''),
    // h. 日语翻唱语尾/中缀
    (s) => s.replace(UTA_TAIL_RE, ''),
    // i. 字幕组标记
    (s) => s.replace(SUBTITLE_TAG_RE, ' '),
    // j/k. 艺人锚前缀/尾缀（'EMA rumor'→'rumor'；'X ／ artist'、
    //      'X by artist'、裸 artist 尾——artist 缺省时规则缺席）
    ...(ab ? [
      (s) => s.replace(new RegExp(`^[${NAME_SEP_CH}]*${ab}(?:[${NAME_SEP_CH}]+|$)`, 'iu'), ''),
      (s) => s.replace(new RegExp(`[${NAME_SEP_CH}]+(?:by[${NAME_SEP_CH}]+)?${ab}[${NAME_SEP_CH}]*$`, 'iu'), ''),
    ] : []),
  ];
  for (const r of rules) collect(r(base));
  // 激进变体：全规则迭代到不动点（≤3 趟）——'Xを歌いました ／ Y' 这类复合
  // 噪声要斜杠尾+歌系中缀双剥才出真名，单规则各剥一层产不出
  let agg = base;
  for (let pass = 0; pass < 3; pass++) {
    const next = rules.reduce((s, r) => r(s), agg).replace(/\s+/g, ' ').trim();
    if (normKey(next) === normKey(agg)) break;
    agg = next;
  }
  agg = String(agg || '').replace(/\s+/g, ' ').trim();
  const aggOk = Boolean(agg) && !seen.has(normKey(agg));
  // 拼装：raw 永远占首（空基座也保形——级联按一次正常尝试消费）；激进
  // 变体保底末位槽——复合噪声正是它的设计目标病例形态（'【栏】A - B
  // (cover) ／ 演唱者' 这类标题单规则恰占满 3 席时，真名只有全剥才得出）。
  // agg 有效→单变体只取前 2 给它留位；无效/重复→取满 3 不浪费槽位
  const out = [base, ...singles.slice(0, aggOk ? 2 : 3)];
  if (aggOk) out.push(agg);
  return out;
}

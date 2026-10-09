// ─────────────────────────────────────────────────────────────────────────
// UGC 标题变体层（唯一真相源）
//
// 纯 ESM、零 IO、零顶层 await——服务端 CJS 经 require(ESM)（Node ≥20.19 /
// ≥22.12）消费同一文件，与 predicates.js 同形态。两处消费：
//   services/lyric-external.js  外源歌词级联的检索词展开（LRCLIB/酷狗）
//   services/netease-match.js   网易云匹配漏斗的 candidates 展开
// 规则/正则只在这里维护一份——两处各写一份的漂移面正是本文件要消灭的。
// ─────────────────────────────────────────────────────────────────────────

import { foldCjkCompat } from './text-norm.js';

// 归一化键：trim + 小写 + 空白折叠 + CJK 异体折叠——变体去重、级联
// 缓存键、匹配候选去重共用（懐中道標/懐中道标 同键）。只进比较面，
// 不回显不落库
export const normKey = (s) => foldCjkCompat(String(s || '').trim().toLowerCase().replace(/\s+/g, ' '));

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
// 中文字幕/中字/CC字幕 字幕组标记、艺人名头尾缀、全大写署名头
// （'EMA rumor' 类搬运形态——不锚 artist 的末位兜底腿）。
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
// feat/ft 尾缀的空白分案：日文曲名惯写 'ft.初音ミク'/'feat.歌姫'——句点后
// 无空格直接接名，故带句点形态 (feat.|ft.) 容许 \s* 零空白（前向
// (?<![\p{L}\p{N}]) 已挡 'shift.x' 类字母粘连、'.\s*' 配 $ 锚限纯尾部，
// 'draft.ft.x' 只剥尾段）；裸词 feat/ft/featuring/with 仍须 \s+ ——
// 'feature X'/'ftX'/'Somewith you' 这类词干粘连不误剥残片。
// /u 旗标不可省：无 u 时 \p{L} 退化为字面量 'p{L}'，前向断言形同虚设
const FEAT_TAIL_RE = /\s*(?<![\p{L}\p{N}])(?:(?:feat|ft)\.\s*|(?:feat|ft|featuring|with)\s+).{1,40}$/iu;
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
// 全大写署名头：YouTube 搬运标题的「歌手 tag + 曲名」形态（'EMA rumor'、
// 'TK from 凛として時雨'）——token1 全大写拉丁/数字/&/'（2-15 字），
// token2 以「非大写字母」开头：'SUMMER NIGHT'/'NOT CRYING' 全大写
// 词组不是署名；负断言吃 \p{Lu} 全集而非 ASCII——'É'（'ABBA Étude'）/
// 'В'（'SUMMER ВЕЧЕР'）/'Ａ' 这类非 ASCII 大写字母同样挡。'EMA - X'
// 连字符形态归 d 规则、'RTRT(Mili) x' 括弧粘连无空白不剥、'_'/标点
// 开头不剥（剥出 '- X' 类残片纯属噪声）。
// 刻意不锚 artist：author 是搬运号/占位时 j/k 锚规则缺席，此变体只作
// 末位兜底检索串——剥错（'TK from X'→'from X' 类垃圾）由下游
// strictTitle 闸 + AI 核验兜
const CAPS_HEAD_RE = /^[A-Z0-9&']{2,15}\s+((?!\p{Lu})\p{L}.*)$/u;
// 艺人锚用归一分隔符字符集（与归一化剥除同族，加冒号/全角斜杠/波浪）
// 艺人名分隔字符集——titleVariantsOf 艺人锚规则与 lyric-external
// normName 剥除面共用（导出供级联侧归一比对对齐同一分隔集）
export const NAME_SEP_CH = String.raw`\s\-_·•、,，。&+＋/／\\'’"（）()【】\[\]:：~～|「」『』`;
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
  // 艺人锚/括弧规则剥缀会留 dangling 装饰角括号——'EMA『懐中道標』'
  // 的艺人锚剥 'EMA『' 后残 '懐中道標』'。变体只喂检索词，落单角括号
  // 稀释命中——收进席位前剥掉头尾游离 「」『』
  const trimBrackets = (v) => String(v || '')
    .replace(/^[「」『』]+/, '')
    .replace(/[「」『』]+$/, '');
  const collect = (v) => {
    const t = trimBrackets(String(v || '').replace(/\s+/g, ' ')).trim();
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
    // f. 尾缀 feat./ft./featuring/with X（含日文惯写 'ft.歌姫' 无空格形）
    (s) => s.replace(FEAT_TAIL_RE, ''),
    // f2. 整包围引号壳剥除：'A - 'B' ft.X' 剥头剥尾后剩 ''B'' 单层壳，
    //     检索串带引号稀释命中。只剥「首字符即引号且同对收尾」的整包围
    //     单层——ASCII '/" 同形对用后向引用 \1；弯引号 U+2018/2019 与
    //     U+201C/201D、书名号 「…」/『…』是异形成对（\1 对异形对不成立）
    //     各立分支。
    //     'don't stop' 词中撇号、'x' mid 类不整包围形态由 ^$ 锚天然挡；
    //     剥出空串由 collect 的 Boolean 闸滤掉
    (s) => s.replace(/^\s*(['"])([\s\S]{1,80}?)\1\s*$/u, '$2')
            .replace(/^\s*‘([\s\S]{1,80}?)’\s*$/u, '$1')
            .replace(/^\s*“([\s\S]{1,80}?)”\s*$/u, '$1')
            .replace(/^\s*「([\s\S]{1,80}?)」\s*$/u, '$1')
            .replace(/^\s*『([\s\S]{1,80}?)』\s*$/u, '$1'),
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
    // l. 全大写署名头剥除（'EMA rumor'→'rumor'）——不锚 artist 的兜底腿，
    //    恒排规则最末：单变体序位最低，挤不进席时激进腿同效迭代兜底
    (s) => s.replace(CAPS_HEAD_RE, '$1'),
  ];
  for (const r of rules) {
    const v = r(base);
    // 规则恒等输出不收集——否则 collect 的 trimBrackets 会把未命中的基座
    // 剥出新变体（'「曲名』' 异形对不跨对收的形态会被剥出幻影 '曲名'）
    if (v !== base) collect(v);
  }
  // 激进变体：全规则迭代到不动点（≤3 趟）——'Xを歌いました ／ Y' 这类复合
  // 噪声要斜杠尾+歌系中缀双剥才出真名，单规则各剥一层产不出
  let agg = base;
  for (let pass = 0; pass < 3; pass++) {
    const next = rules.reduce((s, r) => r(s), agg).replace(/\s+/g, ' ').trim();
    if (normKey(next) === normKey(agg)) break;
    agg = next;
  }
  // 迭代未改动基座时不产激进变体——同上单规则面，纯 trim 不出幻影变体
  const aggTrim = trimBrackets(String(agg || '').replace(/\s+/g, ' ')).trim();
  const aggOk = agg !== base && Boolean(aggTrim) && !seen.has(normKey(aggTrim));
  agg = aggTrim;
  // 拼装：raw 永远占首（空基座也保形——级联按一次正常尝试消费）；激进
  // 变体保底末位槽——复合噪声正是它的设计目标病例形态（'【栏】A - B
  // (cover) ／ 演唱者' 这类标题单规则恰占满 3 席时，真名只有全剥才得出）。
  // agg 有效→单变体只取前 2 给它留位；无效/重复→取满 3 不浪费槽位
  const out = [base, ...singles.slice(0, aggOk ? 2 : 3)];
  if (aggOk) out.push(agg);
  return out;
}

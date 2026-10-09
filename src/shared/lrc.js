// ─────────────────────────────────────────────────────────────────────────
// LRC 核心层（唯一真相源）：解析 / [offset:] / 多时间戳展开 / 纯文本剥戳 /
// 译文窗口合并 / 落盘合并 / 纯音乐占位判定——原散在客户端 api/music.js、
// usePlayer、服务端 lyric-verify、download-io、file-downloader 的 5 份平行
// 实现全部收敛到这里，语义统一为「播放与落盘同一份词同一份时序」。
//
// 纯 ESM、零依赖、无顶层 await——前端经 Vite 直 import，服务端 CJS 经
// require(ESM) 消费同一文件（与 predicates.js/title-variants.js 同形态）。
//
// 口径：时间戳 [mm:ss] [mm:ss.xx] [mm:ss:xx] 均收，毫秒段 1–3 位右补零
// （'.5'=500ms）；一行多戳展开为多行；[offset:ms] 整体平移后负值钳 0；
// 行内增强戳 <mm:ss.xx> 剥除；纯元标签行（[ti:]/[ar:] 等）不产生词条。
// ─────────────────────────────────────────────────────────────────────────

// 行首/行内时间戳：[mm:ss(.|:)ms]，秒段 1-2 位、毫秒段 1-3 位
const TIME_TAG_RE = /\[(\d+):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
// 行内增强戳 <mm:ss.xx>（karaoke 逐字戳）——进词面就是噪音
const INLINE_TAG_RE = /<\d+:\d{1,2}(?:[.:]\d{1,3})?>/g;
// [offset:±ms] 锚定行首——正文里恰好出现的 "[offset:xxx]" 不该污染全局时序
const OFFSET_TAG_RE = /^\s*\[offset:\s*([+-]?\d+)\s*\]/im;
// 译文与原行对齐的最近邻窗口（播放层 mergeTranslations 与落盘
// mergeLrcText 同一口径——500ms 内的微偏移译文视为同行）
export const MERGE_WINDOW_SEC = 0.5;

// 单个戳串 → 秒（'mm:ss(.|:)mss'；毫秒段右补零成 3 位）
const tagSec = (tag) => {
  const m = /^(\d+):(\d{1,2})(?:[.:](\d{1,3}))?$/.exec(tag);
  if (!m) return null;
  const ms = m[3] ? parseInt(m[3].padEnd(3, '0'), 10) : 0;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + ms / 1000;
};

// LRC [offset:] 标签（毫秒）：正值=歌词整体提前显示（显示时间=标签时间-offset）。
// 返回 null 表示未声明（调用方用主歌词 offset 兜底）
export function lrcOffsetSec(text) {
  const m = String(text ?? '').match(OFFSET_TAG_RE);
  return m ? parseInt(m[1], 10) / 1000 : null;
}

// 保 tag 逐行解析（文件序、不施加 offset、空文本行保留）——落盘重建
// （tag 含方括号，回贴原样）与行体检视（词性核验的行序敏感抽样）用；
// 播放/合并不走这条（走 parseLrc 的偏移+排序+空行滤除）
export function parseLrcTagged(text) {
  const rows = [];
  for (const line of String(text ?? '').split('\n')) {
    const clean = line.replace(INLINE_TAG_RE, '');
    TIME_TAG_RE.lastIndex = 0;
    const tags = [...clean.matchAll(TIME_TAG_RE)];
    if (!tags.length) continue;
    const body = clean.replace(TIME_TAG_RE, '').trim();
    for (const m of tags) rows.push({ tag: m[0], time: tagSec(m[0].slice(1, -1)), text: body });
  }
  return rows;
}

// 播放面解析：[offset:] 平移 + 负值钳 0 + 时间升序。fallbackOffsetSec
// 供「附属层无自身 offset 时继承主层」的调用（译文合并/落盘合并）
export function parseLrc(text, fallbackOffsetSec = null) {
  const off = lrcOffsetSec(text) ?? fallbackOffsetSec ?? 0;
  const rows = [];
  for (const r of parseLrcTagged(text)) {
    if (!r.text) continue; // 空文本戳行不产词条（播放面不渲染空行）
    rows.push({ time: Math.max(0, r.time - off), text: r.text });
  }
  return rows.sort((a, b) => a.time - b.time);
}

// 无戳纯文本 → 静态行（time:Infinity——同步循环天然不匹配，渲染层照常
// 显行）。口径=原 usePlayer plainRowsOf：先剥行首时间戳串再判元行
// （判定必须在剥戳后——\w 含数字，先判会把 [0:05] 短戳词行误杀）
export function plainLyricLines(text) {
  return String(text ?? '').split('\n')
    .map((l) => l.replace(/^\s*(?:\[\d+:[^\]]*\]\s*)+/, '').trim())
    .filter((l) => l && !/^\[[\w-]+:/.test(l))
    .map((t) => ({ time: Infinity, text: t }));
}

// 译文行集并入原行集：双指针 O(n+m)（两集均按时间升序），窗口内最近
// 邻行挂 translation；无挂点行留 ''。AI 译文里未译行回填的是原文
// （占住时间戳防邻行错贴）——同文即未译不显示
export function mergeTranslations(lyrics, translations, windowSec = MERGE_WINDOW_SEC) {
  const t = translations || [];
  let j = 0;
  return (lyrics || []).map((lyric) => {
    while (j < t.length - 1
           && Math.abs(t[j + 1].time - lyric.time) <= Math.abs(t[j].time - lyric.time)) {
      j++;
    }
    const translation = t[j] && Math.abs(t[j].time - lyric.time) < windowSec ? t[j].text : '';
    return { ...lyric, translation: translation === lyric.text ? '' : translation };
  });
}

// 窗口内最近邻（与播放层 mergeTranslations 同策略同窗口——落盘合并与
// 屏显合并产同一份对齐，毫秒级偏差的译文不再丢）。text 与源行相同
// 不重复贴（重复段 lrc 原文已自带）
const nearestText = (rows, t, srcText) => {
  let best = null;
  let bd = Infinity;
  for (const r of rows) {
    const d = Math.abs(r.time - t);
    if (d < bd) { bd = d; best = r; }
  }
  return (best && bd < MERGE_WINDOW_SEC && best.text.trim() !== srcText) ? best.text : null;
};

// 主 LRC + 附属层（译文/罗马音…）→ 合并 LRC 文本（落盘形态）。附属层
// 无自身 [offset:] 时继承主层 offset（与播放面同口径）；主行戳原样
// 回贴（保主层毫秒精度），附属行跟在主行后同戳落
export function mergeLrcText(lrc, ...layers) {
  const mainOff = lrcOffsetSec(lrc) ?? 0;
  const layerRows = layers.map((l) => parseLrc(l, mainOff)).filter((r) => r.length);
  if (!layerRows.length) return String(lrc || '');
  return String(lrc || '').split('\n').map((line) => {
    const m = line.match(/^\[(\d+:\d{1,2}(?:[.:]\d{1,3})?)\]/);
    if (!m) return line;
    const t = Math.max(0, tagSec(m[1]) - mainOff);
    const srcText = line.slice(m[0].length).trim();
    const extras = layerRows.map((rows) => nearestText(rows, t, srcText)).filter(Boolean);
    return extras.length ? `${line}\n${extras.map((x) => `${m[0]}${x}`).join('\n')}` : line;
  }).join('\n');
}

// 歌词行消毒：换行/方括号会破坏 LRC 行结构（伪造时间戳注入）、Cf 零宽
// 字符剥除——原 routes/ai.js cleanText / lyric-external·lyric-align
// cleanLine 三份同口径实现归一
export const cleanLrcLineText = (s) => String(s ?? '')
  .replace(/[\r\n]+/g, ' ')
  .replace(/\[[^\]]*\]/g, ' ')
  .replace(/[\[\]]/g, ' ')
  .replace(/\p{Cf}/gu, '')
  .replace(/\s+/g, ' ')
  .trim();

// ── 纯音乐/无词占位判定 ──
// 「这份词整体只是占位声明」才算——剥掉元行与署名行后剩 ≤2 行，且每行
// 都含占位关键词（纯音乐/純音樂/没有填词/沒有填詞/instrumental，大小写
// 不敏感）且够短（≤40 字）。非整行匹配是刻意的：QQ/网易的占位措辞形态
// 多（'此歌曲为纯音乐，请您欣赏'/'純音樂，請欣賞'/'纯音乐，敬请欣赏'），
// 关键词+短行钉住的是「整份词没有真词文」而非某个固定模板；正文夹带
// 关键词不算（≥3 行或任一行无关键词直接出局）——真实词不误伤
const CREDIT_LINE_RE = /^(?:作?词|作?曲|编曲|演唱|制作|监制|出品|录入|歌词?制作|词|曲|op|sp|music)\s*[:：]/i;
const PLACEHOLDER_KW_RE = /纯音乐|純音樂|没有填词|沒有填詞|instrumental/i;
export function isInstrumentalPlaceholder(text) {
  const body = plainLyricLines(text).map((l) => l.text).filter((t) => !CREDIT_LINE_RE.test(t));
  return body.length > 0 && body.length <= 2
    && body.every((t) => t.length <= 40 && PLACEHOLDER_KW_RE.test(t));
}

// 网易云 /lyric 回包的词文提取（唯一真相源——客户端 getLyrics、下载链
// neteaseLyricOf、AI 翻译拉词 fetchLyricRaw、对齐拉词 fetchLyricLines
// 四处同口径）：nolyric/uncollected 旗标或主词即占位声明 → lrc=''。
// 占位主词不透 tlyric——「纯音乐」的翻译层没有语义，透下去反而会被
// 下游（isLikelyChineseLyric 等）当成真词稿
export function neteaseLyricBody(body) {
  if (body?.nolyric === true || body?.uncollected === true) return { lrc: '', tlyric: '' };
  const lrc = typeof body?.lrc?.lyric === 'string' && body.lrc.lyric ? body.lrc.lyric : '';
  if (!lrc || isInstrumentalPlaceholder(lrc)) return { lrc: '', tlyric: '' };
  return { lrc, tlyric: typeof body?.tlyric?.lyric === 'string' ? body.tlyric.lyric : '' };
}

// 候选时长匹配——替代 unm provider/select.js 的弱实现
// （原版：前 5 条里第一个 |duration差|<5s 的，全不中退回 list[0]——
// 兜底形态正是错配主源）。本版：不达标直接不中选，错配风险由
// resolveSongUrls 的时长对账 + 下载端 durationLooksTruncated 双闸兜底
//
// 归一化键唯一真相源在共享层（CJS require(ESM) 直读——与 youtube.js 的
// predicates.js 同款）：trim+小写+空白折叠+CJK 异体折叠，只进比较面
const { normKey } = require('../../../shared/title-variants.js');

const DURATION_MATCH_TOLERANCE_SEC = 5;

/**
 * 候选按目标时长过滤（≤5s 差），durationMs 缺失（无对账基准）时放行
 * 原序前 3 条——多候选交由下游时长对账/逐源试错兜底；基准存在但全部
 * 不命中则返回空（不回退首条——unm 的 list[0] 兜底是错配主源）
 * @param {Array} cands
 * @param {number|null|undefined} durationMs 网易原始曲目时长（毫秒）
 * @param {(cand: any) => number|null|undefined} getSec 取候选秒数
 * @returns {Array} 按时长匹配过滤后的候选（保持原序）
 */
function pickByDuration(cands, durationMs, getSec) {
  if (!Array.isArray(cands) || !cands.length) return [];
  const targetSec = durationMs > 0 ? durationMs / 1000 : null;
  if (targetSec == null) return cands.slice(0, 3);
  const matched = cands.filter(c => {
    const sec = getSec(c);
    return Number.isFinite(sec) && Math.abs(sec - targetSec) <= DURATION_MATCH_TOLERANCE_SEC;
  });
  return matched;
}

/**
 * 时长选候选的三态池（youtube/bilibili 共用的 pickByDuration 上层入口）：
 * - ±5s 筛命中 → {pool:命中集, arbitrated:false}——首选语义不变
 * - 筛空但候选在场 → {pool:全候选, arbitrated:true}——不弃池：±5s 硬筛
 *   比编排层真正的错配闸 DURATION_TOLERANCE（netease-api.js，youtube 0.4/
 *   其余 0.2 比例闸）严一个量级，官方 MV/搬运稿带几秒~十几秒片头尾常超窗
 *   却是真命候选（实机确诊假阴性：dt=258.5s 曲配 279s 官方上传——7.7%
 *   偏差过 0.4 闸却死在 ±5s）。全候选交 aiRankCandidates 语义仲裁——AI 的
 *   「官方音源/MV 可算，live/remix/翻唱/卡拉OK/短剪辑不算」判定本就是错配
 *   正主闸；下游时长对账仍是最终硬墙。pool 即 cands 本体，保 provider
 *   现有截断上限（youtube 5/bilibili 8），此处不再加闸
 * - cands 空 → {pool:[], arbitrated:false}——搜索真空无池可兜
 * - durationMs 缺席（无对账基准）→ pickByDuration 已回前 3 条，走首支
 *   arbitrated:false——仲裁语义不适用，行为与旧路径一致
 * @param {Array} cands
 * @param {number|null|undefined} durationMs 网易原始曲目时长（毫秒）
 * @param {(cand: any) => number|null|undefined} getSec 取候选秒数
 * @returns {{pool: Array, arbitrated: boolean}}
 *   arbitrated=true 时调用方须打一行留痕（诊断链不撒谎）并把全候选喂
 *   aiRankCandidates——verdict 记忆/死簿/全否冷却对该池照常生效
 */
function durationPool(cands, durationMs, getSec) {
  const pool = pickByDuration(cands, durationMs, getSec);
  if (pool.length) return { pool, arbitrated: false };
  // 走到这 = 时长筛产出空集。cands 空是搜索真空无池可兜；cands 非空则
  // durationMs 基准必定在场（缺席时 pickByDuration 回前 3 条非空，已在上行
  // 返回）——即 ±5s 全灭而候选在场，全候选兜底交 AI 仲裁
  if (!Array.isArray(cands) || !cands.length) return { pool: [], arbitrated: false };
  return { pool: cands, arbitrated: true };
}

// ── 搜索真空降级词（youtube/bilibili 共用，勿双份复刻）───────────────
// 剥 info.name 尾段连续括号群（全/半角圆方尖）——
// 「ぱられループ を歌ってみた (2024 Radio Edit)」→「ぱられループ を歌ってみた」。
// 日系术力口/anisong 带版本后缀的检索词实测零命中，剥版本后缀后有命中希望。
// 只剥尾缀：词中括号是合法本名成分（feat./原名标注），剥中段反而跑偏；
// 括号群内不许再出现闭括号——嵌套/混排形态不匹配即不剥（保守）
const TRAIL_BRACKET_RE = /\s*[(\[（【][^)\]）】]*[)\]）】]\s*$/;
// 尾段连续括号群整串剥掉（degradedKeyword 与 pickTitleDurationMatch 的
// name core 共用——剥法唯一处，双份复刻必漂移）
function stripTrailBrackets(s) {
  let name = String(s || '');
  for (;;) {
    const stripped = name.replace(TRAIL_BRACKET_RE, '');
    if (stripped === name) break;
    name = stripped;
  }
  return name;
}
function degradedKeyword(info) {
  let name = stripTrailBrackets(info.name);
  // 剥掉括号后残留的分隔符（「曲名 - (Live)」→「曲名 -」→「曲名」）
  name = name.replace(/[\s\-–—]+$/, '');
  if (!name) return '';
  const artists = Array.isArray(info.artists) ? info.artists : [];
  return artists.length ? `${name} - ${artists.join(' / ')}` : name;
}

// ── AI 全否兜底：标题含歌名 + 时长贴近的确定性选定 ──────────────────
// 实锤漏判：QQ 曲「ぱられループ を歌ってみた / Jeku / 259s」（实为 aori
// 原曲的 Jeku Remix），候选池多条 260s「aori - ぱられループ を歌ってみた
// (Jeku Remix)」是正主，AI 因期望艺人 Jeku vs 标题 aori + remix 标注
// 误判全否 → 曲目诚实失败。规则：AI 全否时标题里找得到歌名（容跨语言/
// 罗马音写法）且时长贴近的候选，选首条命中者。
// ±10s 比 ±5s 首选窗宽——兜底针对「AI 判死但确定性证据在场」的候选，
// 上传版片头尾/分轨差异常超 5s；下游时长对账仍是最终硬墙
const TITLE_FALLBACK_TOLERANCE_SEC = 10;

// 括号两档处理（开闭符集与 TRAIL_BRACKET_RE 同族——全/半角圆方括号）：
// - 剥括号符留内容：真名常藏在候选括弧段里——「Mayuiro - sajou no hana
//   （繭色）」的（繭色）正是歌名残留，整段剥掉证据就没了，故候选键与
//   歌名针都只剥符不剥段
// - 括号段整段剥（含内容）：仅歌名侧取 token 时用——「曲名 (Live)」的
//   live 是版本标注噪声，不该成命中依据；「ぱられループ を歌ってみた
//   (2024 Radio Edit)」同理
const BRACKET_MARK_RE = /[()\[\]（）【】]/g;
const BRACKET_SEG_RE = /[(\[（【][^)\]）】]*[)\]）】]/g;

// 归一比较键：剥括号符 → normKey → 去全部空白——「aori - ぱられループ
// を歌ってみた (Jeku Remix)」与歌名「ぱられループ を歌ってみた」的
// 空白/括弧差异不挡包含判定
const titleKey = (s) => normKey(String(s || '').replace(BRACKET_MARK_RE, ' '))
  .replace(/\s+/g, '');

/**
 * AI 全否兜底选定：候选中找「标题含歌名 + 时长贴近」的首条。
 * 启用前提 info.durationMs > 0——「时长差不多」无基准无法验证，缺基准
 * 不回退（与 pickByDuration 的 durationMs 缺席放行相反：那里是筛子
 * 放宽，这里是选定依据缺席，宁缺不选）。
 * 标题判定（剥括号符+归一+去空白后的全串包含，任一命中即算）：
 *   a) 候选标题含歌名整串——歌名带尾缀版本标注（「曲名 (Live)」）时
 *      另剥出 name core（尾缀括号群整串剥）作第二根针，任一命中即算；
 *   b) 歌名括号外主干的每个空白 token 都出现在候选标题里——乱序/夹字
 *      可容。注意是全 token 命中：「Aori - Parallel Loop / ぱられループ
 *      (Jeku Remix)」对「ぱられループ を歌ってみた」缺「を歌ってみた」
 *      token，不中 b、由 c 兜；
 *   c) 歌名最长 token（≥4 字符）出现在候选标题里——译名/罗马音混排
 *      标题只保留歌名主干时兜底（上例即此形）。残余面：常见英文词
 *      （take/love/life 类 4 字符 token）在 ±10s 内仍有子串误选面——
 *      规格取舍已裁决，下游时长对账+人工 veto 是最后闸。
 * 已知边界（诚实不命中）：跨语言完全翻译（纯「Parallel Loop」无日文
 * 残留）确定性规则无法判等——宁可走 AI 全否原路径，不拿翻译语义赌。
 * @param {Array} cands 候选 [{videoId,title,durationSec,...}]
 * @param {{name?: string, durationMs?: number|null}} info
 * @returns {object|null} 首条命中候选（保原序）；无命中 null
 */
function pickTitleDurationMatch(cands, info) {
  if (!Array.isArray(cands) || !cands.length) return null;
  if (!(Number.isFinite(info?.durationMs) && info.durationMs > 0)) return null;
  const name = String(info?.name || '');
  if (!name.trim()) return null;
  const targetSec = info.durationMs / 1000;
  // 歌名针：全称与 name core 两形，剥后同形去重——任一被候选标题包含
  // 即中 a。name core 套 degradedKeyword 同款分隔符尾清理（「曲名 -
  // (Live)」剥括号群残「曲名 -」，死尾让裸名候选永远中不了）。文数字
  // 下限与下方 token 侧同句：纯标点歌名（「???」「※」）剥出的针无判等
  // 价值，否则「候选标题恰好含符号+时长贴近」即成裸针误选（pickedId→
  // ok=1 verdict 永久批准放大误伤）；不设长度下限——2 字符 CJK 歌名
  // （繭色）依赖短针
  const needles = [...new Set([name, stripTrailBrackets(name).replace(/[\s\-–—]+$/, '')]
    .map(titleKey).filter(t => /[\p{L}\p{N}]/u.test(t)))];
  if (!needles.length) return null;
  // token 证据只取括号外主干（括号段整段剥，见 BRACKET_SEG_RE 注）；
  // 纯标点 token（「-」「/」残留）无判等价值一并滤掉
  const tokens = normKey(name.replace(BRACKET_SEG_RE, ' ').replace(BRACKET_MARK_RE, ' '))
    .split(' ').filter(t => /[\p{L}\p{N}]/u.test(t));
  let longTok = '', longLen = 0;
  for (const t of tokens) {
    const n = [...t].length;
    if (n > longLen) { longTok = t; longLen = n; }
  }
  if (longLen < 4) longTok = '';   // 短 token 命中面太宽，c 规则缺席
  for (const c of cands) {
    const sec = c?.durationSec;
    if (!Number.isFinite(sec) || sec <= 0) continue;
    if (Math.abs(sec - targetSec) > TITLE_FALLBACK_TOLERANCE_SEC) continue;
    const ck = titleKey(c?.title);
    if (!ck) continue;
    if (needles.some(n => ck.includes(n))) return c;                        // a
    if (tokens.length && tokens.every(t => ck.includes(t))) return c;       // b
    if (longTok && ck.includes(longTok)) return c;                          // c
  }
  return null;
}

module.exports = { pickByDuration, durationPool, degradedKeyword, pickTitleDurationMatch, DURATION_MATCH_TOLERANCE_SEC, TITLE_FALLBACK_TOLERANCE_SEC };

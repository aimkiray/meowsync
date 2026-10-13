// 歌词归属核验核心——routes/ai.js:/ai/lyric-verify 与 file-downloader 的
// 下载词落盘前核验共用一套：判定对象、采样、prompt、verdict 落库。
// 「错歌词比没歌词更糟」；AI 是增强不是门禁——返回 null = 无法判定，
// 调用方按相符放行且不写 verdict（一次哑火不固化）
const { createHash } = require('crypto');
const { aiEnabled, askAiJson, aiModel } = require('../lib/ai');
const lyricAiRepo = require('../repositories/lyricAi');
const { BV_TRACK_ID_RE, YT_TRACK_ID_RE, YT_ID_RE, NETEASE_ID_BOUNDED_RE } = require('../../shared/predicates.js');
// 持模块对象而非解构绑定：resolveOriginalInfo 的调用点写成
// ytLib.resolveOriginalInfo?.() ——测试侧对 lib/youtube 的原位覆写桩
// （lyric-external.test.mjs 钉 ytLib.resolveOriginalInfo = stub）才能
// 接管；解构会把真身定死在 require 时、绕开桩层直打真实上行
const ytLib = require('../lib/youtube');
// LRC 解析唯一真相源（与前端 parseLyrics、落盘合并同一实现）——
// 核验侧只消费 {tag, text}：判定签名与持久化 vkey 都吃文本不吃
// 时间值，共享层附带的偏移/排序语义不碰任何已落键
const { parseLrcTagged, plainLyricLines } = require('../../shared/lrc.js');

// 与共享层 parseLrcTagged 同口径，收敛为本域形状 [{tag, text}]——
// tag 保留原始时间戳串（含方括号），翻译重建时原样回贴；空文本
// 戳行不产词条
function parseLrcLines(lrc) {
  return parseLrcTagged(lrc)
    .filter((r) => r.text)
    .map(({ tag, text }) => ({ tag, text }));
}

// 纯文本词 → 判定抽样行：剥行首时间戳与 [tag:] 元行取词文——「没轴的
// 文本词」也过 AI 归属核验。出参与 parseLrcLines 同构 {text}
// （judgeInner/composerCreditNames 只消费 .text）。级联 verifyHit 与
// 下载链 verifyDownloadOwnership 共用同一口径
const plainTextLines = (lrc) => plainLyricLines(lrc).map((l) => ({ text: l.text }));

// 进 prompt 的输入剥换行/方括号——标题作者与歌词原文都是不可信输入，
// 去掉结构字符至少让注入不能伪造消息边界/键控协议
const sanitizePrompt = (s) => String(s || '')
  .replace(/[\r\n\[\]]+/g, ' ').replace(/\s+/g, ' ').trim();

// 来源发布日合法性窗（chrono-guard 规格 §3.1 同式——不为 3 行函数建共享
// 依赖，A/B/C 各消费文件就地实现）：下限 2000-01-01——YT 2005/B 站 2009
// 上线前不存在真发布日，再早必脏；上限 now+24h 容忍时钟偏差——超界的
// 「未来发布日」按未知处理不构成证据。isoDay 展示统一 UTC 日粒度
// （YYYY-MM-DD，不受服务器 TZ 影响，测试可钉）
const sanePublishMs = (v) => {
  const ms = Number(v);
  return Number.isFinite(ms) && ms >= 946684800000 && ms <= Date.now() + 86400e3 ? ms : 0;
};
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
// 候选侧（网易条目 publishTime）只滤明显脏数据——未来上架日是合法证据
// （首发预售条目对现存视频本就不可能，嫌疑判面天然覆盖），不设业务上限；
// 只夹 Date 值域——t >= 8.64e15（约 ±10 万年）时 new Date(t).toISOString()
// 抛 RangeError，超此必脏数据按无日期处理（与 sanePublishMs 的窗语义同族）
const candPubMsOf = (s) => {
  const t = Number(s?.publishTime);
  return Number.isFinite(t) && t > 0 && t <= 8640000000000000 ? t : 0;
};

// 判定对象是「(词源, 来源视频, 模型) 三元组」而非词源本身：同一 neteaseId
// 可能被不同视频匹配到，A 视频的错配不能污染 B 视频的正常取用；换模型后
// 旧判定自动失效重判（避免旧模型的误判被永久固化）
function lyricVerdictKey(lyricId, sourceTitle, sourceAuthor, poolMark, declMark, chronoMark) {
  // sig 输入在键函数内单边收口（slice 口径 = mirror 投影的 300/120）——
  // 播放链传全量、下载链传投影截断值，两侧对同一首歌必须产同一个键。
  // 必须先 slice 后 trim：trim(raw)[0:300] ≠ trim(raw[0:300])——前导空白
  // 或第 300 位恰是空白时两序产不同 sig（截断顺序不可交换）
  // 版本段：v2=判定输入含候选条目身份（judgeInner 的 candidate 段）——
  // v1 键下落的旧判定（无候选信息的保守放行/错判）不能被新判定吃到；
  // v3=判定输入再含同题候选池（candidate.pool 段）——pool 改变判定语境
  // （单候选盲审 → 候选间相对比较），v2 下落的单盲判定不能被 pool 判定
  // 复用，反之亦然：两个口径的判否记忆各自存续、互不命中；
  // v4=判定 prompt 补语言证据条款（judgeInner system 段「词文文字体系
  // 与来源语境完全无关即强否证」）——v3 盐下落、旧 prompt 口径的保守
  // 放行错判（实案：日文圈翻唱来源配西里尔词文判 ok）不被新语义复用，
  // 免清库重判。无池盲审口径仍走 v2 盐：播放/下载链盲审判定记忆存续
  // （盲审侧不能改吃 'v3'——会与带池旧判撞盐复用错语境判定）。
  // 声明位：判定携自署本家证据（declared→declSeg 进 prompt）时盐尾
  // 并 'd3'（v2d3/v4d3）——声明内容不进签名料（语境证据而非判定身份），
  // 但「有无声明语境」必须分键：无声明语境落的持久 verdict 不能被
  // 声明到场后的重判吃到——否则声明轮/末轮同 extId 重进时旧键直接
  // 命中、自署证据根本没进判（choose 侧 pickMemo 'd|' 键位是同义分
  // 键）。'd2'→'d3' 是声明语境语义换代：declGuide 署名条款由旁证
  // 「倾向判 false」升级为判定规则（署名显示候选条目是第三方独立
  // 原创=同题异曲、判 false；编曲/译词署名明言不作否证），旧声明
  // 语境落的判定不复用。routes/ai.js 与
  // verifyDownloadOwnership 现亦携 declared（yt_ 来源反解成功时产
  // d3 键，与级联同键复用）；无声明键面逐位不动，存量判定记忆存续
  // 时间位：判定语境携来源发布日证据（publishedAt→judgeInner pubSeg 进
  // prompt）时盐尾再并 'c1'（v2c1/v4d3c1）——chronoMark 只锚源侧：
  // 候选 publishTime 是条目身份面（lyricId 已在键内）且要到 song_detail
  // 才能取，若进键会把「查键」变成「先付上行」，破坏缓存命中零上行
  // 纪律。chronoMark 由调用方以 srcPubMs > 0 携入，与 judgeInner 的
  // pubSeg 出场条件逐字对齐（declMark 同款对齐纪律——日期实参在场即
  // 分键，无日期语境落的旧判定不能被携日期重判吃到：本案形态的无
  // 日期假 ok 不会被携证据重判的旧键复用）；无日期键面逐位不动
  const sig = createHash('sha1')
    .update(`${poolMark ? 'v4' : 'v2'}${declMark ? 'd3' : ''}${chronoMark ? 'c1' : ''}|${String(sourceTitle).slice(0, 300).toLowerCase().trim()}|${String(sourceAuthor).slice(0, 120).toLowerCase().trim()}`)
    .digest('hex').slice(0, 12);
  return `${lyricId}@${aiModel()}@${sig}`;
}

// vkey 级单飞：路由层 inflightVerify 只管 HTTP 调用方，file-downloader 的
// 并发下载任务直调本函数——同一 vkey 的两个任务不内聚会各烧一次 AI、
// 且模型非确定下可能一个落词一个 NO_LYRICS。共享 promise 不吃调用方
// signal（首调用方 abort 不该让搭车者陪绑），AI_TIMEOUT_MS 上游超时是自净上限
const judgeInflight = new Map();

// ── 确定性署名否证闸 ──
// 实案病灶：声明本家「ポップしなないで」+ 候选条目「早く帰りたい /
// wholicoji」，词头「作曲 : wholicoji」——自署作曲=第三方独立原创=
// 同题异曲，模型在这类硬边界上 true/false 抖动、错判落 verdict 即固化
// 为错词。该证据链是确定性的，不交模型裁量：词头作曲署名归一后等于
// 候选艺人名、且与声明本家名既不相等也不互含 → 判否。
// 闸位先于 verdict 缓存与 AI 调用（aiEnabled 无关——证据闸不是 AI
// 辅助）：同键下已固化的 AI 抖动错判也被压回 false，确定性证据优先
// 于判定记忆；判否不落 verdict——闸重算即得不占判定记忆表，也避免
// 词源上游改词（署名行消失）后沉淀过期否决。
// 安全面：翻唱条目惯例沿用原曲署名——署名=声明本家或与本家名互含
// （成员名「かわむら」署名对上声明「かわむら/ポップしなないで」）不
// 触发，交回缓存/AI 正常路径；无署名行/无候选艺人/无声明任一缺席即
// 不适用（路由盲审与下载链的 candidate 由 resolveCreditGateCandidate
// 惰性补料——条件不齐归 null 静默不适用，调用形态向后兼容）。
// 已知误否余量：本家创作成员以个人名义再发布（条目艺人=成员名=作曲
// 署名、声明写团名）会被误否——按「宁可无词不可错词」方向接受，该
// 形态极罕见。
const normCreditName = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
// 制作署名行：词头元信息「作詞 : X / 作曲：Y / Lyrics: Z」形态；关键词
// 与冒号间允许空白——实案词头是「作曲 : wholicoji」（冒号前有空格，
// 缺 \s* 会漏锚）。行形态识别含作词/编曲/译词/制作，但参与否证的只有
// 「曲作者」类——翻唱沿用原曲署名锚的是作曲者，作词/编曲栏常换人不
// 证异曲（与 declGuide「编曲/译词署名不作否证」同口径）
const CREDIT_LINE_RE = /^(作詞|作词|作曲|編曲|编曲|制作|詞|曲|Lyrics?|Composed?|Music|Composer|Lyricist)\s*[：:]\s*(.+)$/i;
const COMPOSER_CREDIT_RE = /^(作曲|compose|composed|composer|music)$/i;

// 采样词头前 10 行取全部作曲署名值——署名闸的「有无可否证料」预检面：
// 空数组即词内无作曲署名，调用方据此跳过候选艺人反查（对照料缺席时
// 闸本就不适用，不值得为它付上行）
function composerCreditNames(lines) {
  const out = [];
  for (const l of (Array.isArray(lines) ? lines : []).slice(0, 10)) {
    const m = CREDIT_LINE_RE.exec(String(l?.text || '').trim());
    if (!m || !COMPOSER_CREDIT_RE.test(m[1])) continue;
    const sig = String(m[2] || '').trim();
    if (sig) out.push(sig);
  }
  return out;
}

// 采样词头前 10 行取作曲署名——返回触发否证的署名原文（进日志）；
// 对照轴缺席（无候选艺人/无声明本家名）或署名与本家相关归 null
function composerCreditRefutes(lines, candArtist, declAuthor) {
  const decl = normCreditName(declAuthor);
  const artist = normCreditName(candArtist);
  if (!decl || !artist) return null;   // 对照轴缺一即不适用
  for (const sig of composerCreditNames(lines)) {
    const nSig = normCreditName(sig);
    if (nSig === artist && nSig !== decl && !nSig.includes(decl) && !decl.includes(nSig)) {
      return sig;
    }
  }
  return null;
}

// 署名闸对照轴 + 候选上架日的惰性补料（routes/ai.js 播放链与下方
// verifyDownloadOwnership 共用）：播放/下载链手里本没有候选条目身份
// （级联 verifyHit 自带 meta 不走此路）——满足任一触发位才付一跳
// song_detail 反查；两触发位全缺即归 null（无声明/无署名行/无日期语境/
// 外源词源的主路径零上行零成本，extId/qq_ 由形态闸天然跳过）。
// 双触发位：
//   wantArtist——声明在场 + 词内确有作曲署名行：署名否证闸要候选艺人
//     （wholicoji 实案病灶的三条件齐备才付跳）；
//   wantDates——源侧发布日在场（调用方 srcPubMs>0、vkey c1 位已锚）：
//     时间轴要候选上架日对照——本案形态正是无声明曲，只锚声明位会让
//     候选日期永远装不进判定语境。
// song_detail 同跳提取 publishTime 与艺人——署名闸要艺人、时间轴要上架
// 日，一跳双供；反查只为证据供料：拿到什么进什么（{artist?, publishTime?}
// 全缺归 null），拿不到/上游故障同归 null——闸/日期轴自动不适用，不落
// 回旧的「宁放行」语义外任何变化
async function resolveCreditGateCandidate({ id, lines, declared, signal, wantDates = false }) {
  if (!NETEASE_ID_BOUNDED_RE.test(String(id))) return null;
  const wantArtist = normCreditName(declared?.author) && composerCreditNames(lines).length;
  if (!wantArtist && !wantDates) return null;
  try {
    // 惰性 require：仅闸供料路径才拉起 netease 上行层——顶载会把 API
    // 依赖面挂进 lyric-verify 的全部引用方（含只消费解析面的调用链）
    const { callNeteaseApi } = require('./netease-api');
    const res = await callNeteaseApi('song_detail', { ids: String(id) }, { signal });
    const s = res?.body?.songs?.[0];
    const ar = Array.isArray(s?.ar || s?.artists) ? (s.ar || s.artists) : [];
    const artist = ar.map(a => a?.name).filter(Boolean).join('/');
    const publishTime = candPubMsOf(s) || undefined;
    if (!artist && !publishTime) return null;
    return { artist: artist || undefined, publishTime };
  } catch {
    return null;
  }
}

// lines 为 parseLrcLines 产出。署名否证闸最先跑——确定性证据判否压过
// 一切（含已固化 verdict 与 AI）；命中 verdict 缓存直接返回（不消耗 AI）；
// 判定为布尔时写 kind='lyric' verdict 后返回；模型未给合法判定返回 null。
// candidate（可选）= 外源检索命中条目的平台元数据 {title, artist, album}——
// 词面撞名时「候选条目身份」是同名异曲拦截的关键证据（无候选信息的旧
// 判定口径见 lyricVerdictKey 的 v2 版本段说明）；candidate.pool（可选）
// = 同次检索排序后的同题候选集身份 [{title, artist, album}, ...]——单盲
// 审分不清的同题异曲靠它判「来源实际所唱哪条」（v4 版本段说明同上）；
// declared（可选）= 级联声明轮反解出的「投稿描述自署本家」{title,author}
// ——语境证据而非判定身份：进 prompt；「有无声明」由调用方在 lyricVerdictKey
// 的 declMark 位携进 vkey 盐尾分键（内容不进签名料——声明随来源视频走，
// 键面已含来源题/名；与 verifyDownloadOwnership 的键约定不污染）；
// publishedAt（可选）= 源发布日 epoch ms——同构的语境证据：「源侧日期
// 有无」由调用方在 vkey 的 c1 位携进盐尾分键（chronoMark 与 pubSeg 出场
// 条件逐字对齐，srcPubMs>0 即分键）；候选上架日不进键——经 candidate
// .publishTime 携进 prompt（条目身份面已在 lyricId 内）
async function judgeLyricLines({ vkey, lines, title, author, candidate, signal, declared, publishedAt }) {
  // 署名否证闸先于缓存命中/abort/单飞/AI——同键下已固化的 AI 抖动
  // 错判也被确定性证据压回（判否不落 verdict，重算即得）
  const refuteSig = composerCreditRefutes(lines, candidate?.artist, declared?.author);
  if (refuteSig !== null) {
    console.info(`[lyric-verify] 署名否证: 作曲「${sanitizePrompt(refuteSig).slice(0, 120)}」=候选艺人≠声明本家「${sanitizePrompt(declared?.author).slice(0, 120)}」`);
    return false;
  }
  const cached = lyricAiRepo.getVerdict(vkey, 'lyric');
  if (cached) return !!cached.ok;
  if (signal?.aborted) return null;
  const gate = judgeInflight.get(vkey);
  if (gate) {
    const shared = await gate;
    // 搭车者用自己的 signal 决定吃不吃结果——返回前复查
    return signal?.aborted ? null : shared;
  }
  const p = judgeInner(vkey, lines, title, author, candidate, declared, publishedAt)
    .finally(() => judgeInflight.delete(vkey));
  judgeInflight.set(vkey, p);
  return p;
}

async function judgeInner(vkey, lines, title, author, candidate, declared, publishedAt) {

  const sourceTitle = sanitizePrompt(title).slice(0, 500);
  const sourceAuthor = sanitizePrompt(author).slice(0, 200);

  // 候选条目身份段：来源视频是 'Twig' 而词源条目是 'Pinocchio Twig /
  // Koosje' 时，词里撞见 'twig' 不足以证相符。字段与来源标题同走
  // sanitizePrompt（不可信输入不伪造消息边界）；判定指引随段同给——
  // 身份与词文双不符才判 false；翻唱借词豁免带「文字体系与来源语境
  // 相容」限定——不然「词文与候选条目语义一致」会被读成压过语言证据
  // 强否证条款的回 true 出口（西里尔词文配日文圈来源恰是语义对得上
  // 的借词形态，体系无关仍判 false）
  const candTitle = sanitizePrompt(candidate?.title).slice(0, 200);
  const candArtist = sanitizePrompt(candidate?.artist).slice(0, 120);
  const candAlbum = sanitizePrompt(candidate?.album).slice(0, 200);
  // 时间证据段（chrono-guard）：源侧发布日成 pubSeg 单独出行（插
  // declSeg 后）；候选侧上架日并入候选条目行尾（/ 上架 YYYY-MM-DD）——
  // wantDates 补料形态下 publishTime 可能是唯一到手的候选字段，故
  // candSeg 出场条件加 || candPubDay（日期-only 候选也产段，缺席槽位
  // 填「未知」同身份字段惯例）。候选 publishTime 只过 finite>0——未来
  // 上架日是合法嫌疑证据，不夹源侧上限
  const srcPubMs = sanePublishMs(publishedAt);
  const srcPubDay = srcPubMs ? isoDay(srcPubMs) : '';
  const pubSeg = srcPubDay ? `\n来源发布日：${srcPubDay}` : '';
  const candPubMs = candPubMsOf(candidate);
  const candPubDay = candPubMs ? isoDay(candPubMs) : '';
  const candSeg = (candTitle || candArtist || candAlbum || candPubDay)
    ? `\n候选条目：标题 ${candTitle || '未知'} / 艺人 ${candArtist || '未知'} / 专辑 ${candAlbum || '未知'}${candPubDay ? ` / 上架 ${candPubDay}` : ''}`
    : '';
  const candGuide = candSeg
    ? '若候选条目标题/艺人与来源明显不同且歌词内容语言/主题也不符，判 false；'
      + '翻唱曲借用原词但词文语义一致、且文字体系与来源语境相容才判 true。'
    : '';

  // 同题候选池段：级联把本次检索排序后前 8 条的条目身份一并喂给判官——
  // 单候选盲审分不清「同题异曲」（翻唱投稿撞原曲名：来源 'Flamingo／
  // rei shirose' 对上 Earl Bostic 与 米津玄師 两条同题条目），摆在一起
  // 才能判当前候选是不是来源实际所唱那首。字段同走 sanitizePrompt 消毒
  // + 截断（检索回包同为不可信输入）；至多 8 条防池子挤爆提示词
  const pool = (Array.isArray(candidate?.pool) ? candidate.pool : [])
    .slice(0, 8)
    .map((p) => ({
      title: sanitizePrompt(p?.title).slice(0, 200),
      artist: sanitizePrompt(p?.artist).slice(0, 120),
      album: sanitizePrompt(p?.album).slice(0, 200),
    }))
    .filter((p) => p.title || p.artist || p.album);
  const poolSeg = pool.length
    ? `\n同题候选池（供判歧义）：\n${pool.map((p, i) => `${i + 1}. ${p.title || '未知'} / ${p.artist || '未知'} / ${p.album || '未知'}`).join('\n')}`
    : '';
  const poolGuide = poolSeg
    ? '来源常是翻唱/节选投稿。候选池若含多个同题条目，判定当前候选是否为来源实际所唱那首——'
      + '结合来源标题/作者语境（日文圈翻唱命名形态如「X／歌手」「Xを歌いました」对应的原曲通常是日文歌），'
      + '明显不合语境的同题异曲判 false。'
    : '';

  // 本家声明段：级联声明轮反解出的「投稿描述自署本家」{title,author}——
  // 同题异曲在元数据层不可分（'Moonlight' 池里 moumoon vs VY1 都是日文
  // 圈条目）时它是分野的一手证据。出场条件与措辞同 netease-match 的
  // origDeclLine 口径：题/名有一即产段（author-only 自署也是艺人轴证
  // 据）、缺席槽位填「未知」、与候选一致是强证据、未自署/不合不否证。
  // 语境证据而非判定身份——declared 内容不进 vkey 签名料（「有无声明」
  // 位由调用方在 lyricVerdictKey 盐尾并 'd3'）；字段同走 sanitizePrompt
  // 消毒截断
  const declTitle = sanitizePrompt(declared?.title).slice(0, 200);
  const declAuthor = sanitizePrompt(declared?.author).slice(0, 120);
  const declSeg = (declTitle || declAuthor)
    ? `\n来源描述声明本家：${declTitle || '未知'} — ${declAuthor || '未知'}`
    : '';
  const declGuide = declSeg
    ? '来源描述自署的本家（原曲出处）与候选一致是强证据；未自署不构成否决。'
      + '词内制作署名（作曲/作词行）是归属证据：与声明本家一致是强正证；'
      + '署名显示候选条目是第三方独立原创（作曲署名=候选艺人自身或其他无关第三方，'
      + '而非声明本家或其创作成员）则该条目是同题异曲、判 false'
      + '——翻唱条目惯例沿用原曲署名，自署作曲的非本家条目词文必然不同；'
      + '候选无署名行不适用此条。编曲/译词署名不作否证。'
    : '';

  // 时间证据条款（chrono-guard）：双侧日期轴任一在场才注入——「上架」
  // 是曲库数字上架/再压盘日而非歌曲诞生日（审计 9/9 旗标全是压盘误报的
  // 教训），明言单独不构成否证；只有「候选是来源发布之后才首次发表的
  // 独立新作条目」这一真倒挂形态才是否决证据（本案：翻唱投稿比所谓
  // 「原曲」首发单曲早 4 年，时间上不可能采用其词）。日期是 AI 判定
  // 语境证据而非机械闸——candSeg 只有日期字段也照常产段出场
  const chronoGuide = (pubSeg || (candSeg && candPubDay))
    ? '日期证据：「上架」是曲库数字上架/再压盘日而非歌曲诞生日——老条目上架晚于'
      + '来源发布日数年仍可能是同曲，单独不构成否证；但候选若为来源发布之后才首次'
      + '发表的独立新作条目（无关艺人的首发单曲/新歌），来源投稿不可能采用该词——'
      + '结合词文与条目身份判 false。'
    : '';

  // 抽样而非全文：首 4 行抓歌名植入（很多歌词开头点题），中段 6 行看主题；
  // 同文行（多时间戳副歌展开）去重，不浪费采样位
  const seenSample = new Set();
  const sample = [...lines.slice(0, 4), ...lines.slice(4).filter((_, i) => i % Math.max(1, Math.floor(lines.length / 6)) === 0)]
    .map(l => sanitizePrompt(l.text).slice(0, 200))
    .filter(t => t && !seenSample.has(t) && seenSample.add(t))
    .slice(0, 10);

  // 语言证据条款（保守原则句后的明言例外）：词文文字体系与来源语境
  // 完全无关是强否证而非「拿不准」——实案病灶：来源 'Boi ver.EMA /
  // otaku'（日文圈翻唱投稿）配候选 'Boi / Dina Jashari' 西里尔词文
  // 'Бои / Сакам да гледам…'，旧 prompt 被保守放行判 ok。条款须压在
  // 保守原则句后写死「不吃兜底」，否则被「拿不准回 true」盖掉；
  // 音译/双语两条既有豁免在前句已给，条款只管「体系无关」的硬否证
  const ans = await askAiJson({
    system: '你是音乐内容核验助手。给定来源音/视频的标题与作者，以及从音乐平台配到的歌词抽样，'
      + '判断这份歌词是否明显属于另一首歌（完全不同的主题/内容/语言体系）。'
      + '罗马音/音译词视同语言相符；双语对照歌词按原文判。'
      + '保守原则：只有「明显是别的歌」才判不符；拿不准、纯音乐标注、语言相符但主题难判都回 true。'
      + '但词文文字体系与来源语种语境完全无关即强否证、不吃保守原则兜底：'
      + '日文圈翻唱投稿配西里尔/希腊/阿拉伯等非日/英/中/韩语词文判 false。'
      + candGuide
      + poolGuide
      + declGuide
      + chronoGuide
      + '只输出 JSON {"ok":true|false}',
    user: `来源标题：${sourceTitle}\n来源作者/频道：${sourceAuthor || '未知'}${declSeg}${pubSeg}${candSeg}${poolSeg}\n歌词抽样：\n${sample.map((t, i) => `${i + 1}. ${t}`).join('\n')}`,
    maxTokens: 64,
  });
  if (ans == null || typeof ans.ok !== 'boolean') return null;
  // detail 是人读审计列——来源题外烙声明/时间语境位：vkey 的 'd3'/'c1'
  // 盐位机器可判但行内审计看不到，decl:<自署题/名> 与 pub:<源发布日>
  // 让「该判定携自署/日期证据落下」可回放（无对应段的 detail 逐位不动）
  lyricAiRepo.upsertVerdict(vkey, 'lyric', ans.ok,
    sourceTitle.slice(0, 200) + (declSeg ? `|decl:${declTitle || declAuthor}` : '')
      + (pubSeg ? `|pub:${srcPubDay}` : ''));
  return ans.ok;
}

// 同题异曲整池消歧：级联 strictTitle 检索轮把排序后同题候选池整盘喂给
// 模型做单发选择题——「来源最可能翻唱池中哪条」的相对判定比逐候选布尔
// 盲审更决断（实证：pool-in-prompt 逐题形态把 KKB 英文版 Flamingo 判 ok
// 收录；同池单发选择题直接指中 米津玄師）。
// 返回 {pick, answered} 把「判官的裁决」与「通道可用性」拆开——旧形态
// 单 null 兼表两种语义，否决与故障分不开就没法收紧兜底：
//   {pick:0基下标, answered:true}  —— 挑中池内条目
//   {pick:null,    answered:true}  —— 应答且明言「池中无合理候选」：全池
//     否决。调用方据此判死该变体、跳过逐候选核验兜底——盲审「拿不准判真」
//     对同题异曲太松（precise 优先：错词比没词更糟，没词走 rematch 自愈）
//   {pick:null,    answered:false} —— AI 关/abort/空池/哑火/畸形/超界
//     应答：通道没给出裁决，调用方落回逐候选核验（降级期不缩召回）
// 应答合法面只收两种形：pick ∈ 1..N 整数序号、pick:null 明言否决；其余
// 一律 answered:false。
// 刻意不写 verdict 表：级联结果本身已按 (songId,title,artist,dur) 进
// lyric 结果缓存；pick 是「池内相对」判定——同一条目换个池可能改判，
// 落单候选键会把相对结论固化成绝对归属记忆（与逐候选 ok/false 的绝对
// 判定不同义，verdict 复用语义不成立）
// declared（可选）= 级联声明轮反解出的「投稿描述自署本家」{title,author}
// ——与 judgeInner 同口径的语境证据：进 prompt 行，不构成否决理由
async function judgePoolPick({ title, author, pool, signal, declared }) {
  if (!aiEnabled() || signal?.aborted) return { pick: null, answered: false };
  const sourceTitle = sanitizePrompt(title).slice(0, 500);
  const sourceAuthor = sanitizePrompt(author).slice(0, 200);
  // 池行不滤空——返回下标要对齐调用方原池：滤了序号会错位，全空行在
  // 提示词里只是「未知/未知/未知」模型不选即可。字段同走 sanitizePrompt
  // + 截断（检索回包同为不可信输入），至多 8 条防池子挤爆提示词
  const rows = (Array.isArray(pool) ? pool : [])
    .slice(0, 8)
    .map((p) => ({
      title: sanitizePrompt(p?.title).slice(0, 200),
      artist: sanitizePrompt(p?.artist).slice(0, 120),
      album: sanitizePrompt(p?.album).slice(0, 200),
    }));
  if (!rows.length) return { pick: null, answered: false };
  // 本家声明段同 judgeInner——投稿自署的一手出处是同题异曲池里分野的
  // 强证据；题/名有一即产段（origDeclLine 同口径——author-only 也是艺
  // 人轴证据），全缺席不产行（模型看不到这档证据就不该为它扣分）
  const declTitle = sanitizePrompt(declared?.title).slice(0, 200);
  const declAuthor = sanitizePrompt(declared?.author).slice(0, 120);
  const declSeg = (declTitle || declAuthor)
    ? `\n来源描述声明本家：${declTitle || '未知'} — ${declAuthor || '未知'}`
    : '';
  const declGuide = declSeg
    ? '来源描述自署的本家（原曲出处）与池中条目一致是强证据；未自署不构成否决。'
    : '';
  const ans = await askAiJson({
    system: '你是音乐曲库消歧助手。来源是一条翻唱/节选投稿音视频的标题与作者。'
      + '候选池是外源歌词库按标题搜出的同题条目（同题异曲常见）。'
      + '判断来源视频最可能翻唱的是池中哪一条——结合来源作者/标题语境'
      + '（日文圈翻唱命名如「X／歌手」对应的原曲几乎总是日文原曲；'
      + '同题异曲选语境最合的那条）。'
      + declGuide
      + '若池中没有任何合理候选，或没有把握'
      + '指认具体某条，回 null——同题异曲宁可否决也不硬猜。'
      + '只输出 JSON {"pick":序号或null}',
    user: `来源标题：${sourceTitle}\n来源作者/频道：${sourceAuthor || '未知'}${declSeg}\n候选池：\n`
      + rows.map((p, i) => `${i + 1}. ${p.title || '未知'} / ${p.artist || '未知'} / ${p.album || '未知'}`).join('\n'),
    maxTokens: 64,
  });
  // 明言否决：模型按约回 {"pick":null} 才是「全池无合理候选」的裁决——
  // 与哑火/畸形应答（answered:false）分家，否决面只信这个显式形态
  const pick = ans?.pick;
  if (pick === null) return { pick: null, answered: true };
  // 只收 1..N 整数序号——超界/非数/缺键一律按未应答落回逐候选核验
  if (!Number.isInteger(pick) || pick < 1 || pick > rows.length) {
    return { pick: null, answered: false };
  }
  return { pick: pick - 1, answered: true };
}

// yt_ 来源的自署本家解析（下载链 verifyDownloadOwnership 与 routes/ai.js
// 播放链共用入口）：投稿描述 original:/本家: 声明反解 {title,author}——
// 同题异曲在元数据层不可分时它是判官的确定性证据。
// fail-soft：上游故障/超时/无声明/函数缺席一律归 null，调用方按无声明
// 旧路径走（声明是增强不是门禁——abort 被 impl 吞成 null 也合语义：
// 归「无声明」后下游 signal?.aborted 闸照常截停）。
// 双层限时：resolveOriginalInfo 内部 timedSignal 只兜单跳 fetch（多形态
// 轮替叠加可上分钟级），这里再压 8s 硬闸并经 AbortSignal.any 合进内层
// signal——race 胜出后 fetchPlayer 链随 abort 收尸，不留孤儿上游请求
// 空烧（形态参考 lyric-external.js 级联的 resolveDeclared）。
// videoId 级短 TTL memoize：播放/下载两链各自反解同一 videoId，成败抖动
// 会把 vkey 声明位劈成 v2/v2d3 两键（持久 verdict 不复用、判定可能不一致）；
// 播放链每次 verify 也不必先付一跳 YT 上行才查到缓存判定。存的是落地
// 结果不是 promise 半成品；负结果（无声明/超时/故障/abort 归 null）同入
// 缓存——投稿描述的声明一分钟内不翻转，该窗内「无声明」按稳定事实记。
// 命中跳过 race——signal 语义在命中时不适用（上游零调用无泄漏）。
// AbortSignal.any 对 truthy 非 signal 入参会同步 TypeError 抛在 .catch
// 链外——整个函数体收进 try/catch，fail-soft 归 null 不漏同步抛
const DECLARED_RESOLVE_MS = 8000;
const DECLARED_MEMO_MS = 60000;
// 容量帽（FIFO 挤出——Map 键序=插入序）：进程级 memo 不设界会让
// 每首 yt_ 的反解条目随会话只涨不消；读命中顺手清过期条目
const DECLARED_MEMO_CAP = 500;
const declaredMemo = new Map();   // videoId -> {res, at}（res 含 null 负结果）
function resolveYtDeclared(videoId, signal) {
  try {
    const hit = declaredMemo.get(videoId);
    if (hit) {
      if (Date.now() - hit.at < DECLARED_MEMO_MS) return Promise.resolve(hit.res);
      declaredMemo.delete(videoId); // 过期即弃——不留在表里占位
    }
    const inner = signal
      ? AbortSignal.any([AbortSignal.timeout(DECLARED_RESOLVE_MS), signal])
      : AbortSignal.timeout(DECLARED_RESOLVE_MS);
    const TIMEOUT = {};
    return Promise.race([
      Promise.resolve().then(() => ytLib.resolveOriginalInfo?.({ videoId, signal: inner })),
      new Promise((res) => {
        const t = setTimeout(() => res(TIMEOUT), DECLARED_RESOLVE_MS);
        t.unref?.();
      }),
    ]).then((r) => (r && r !== TIMEOUT && String(r.title || '').trim()
      ? { title: String(r.title).trim(), author: String(r.author || '').trim() }
      : null))
      .catch(() => null)
      .then((res) => {
        if (declaredMemo.size >= DECLARED_MEMO_CAP && !declaredMemo.has(videoId)) {
          declaredMemo.delete(declaredMemo.keys().next().value);
        }
        declaredMemo.set(videoId, { res, at: Date.now() });
        return res;
      });
  } catch {
    return Promise.resolve(null);
  }
}
// yt_ 来源发布日的惰性解析（下载链 verifyDownloadOwnership 与 routes/ai.js
// 播放链共用入口）——resolveYtDeclared 的时间轴镜像：microformat 发布日
// 反解 epoch ms，作「时间倒挂嫌疑」的源侧证据进判定语境（pubSeg/c1 位）。
// 纪律与 resolveYtDeclared 逐条同构，理由照录：
// fail-soft——上游故障/超时/无日期/导出缺席（旧桩面无 resolvePublishedAt
// 时 ?. 调归 undefined）一律归 null，调用方按「无日期证据」走旧路径
// （日期是增强不是门禁——abort 被 impl 吞成 null 也合语义：归「无日期」
// 后下游 signal?.aborted 闸照常截停）。
// 双层限时同款：resolvePublishedAt 内部共享计算恒 signal:null（memo 纪律
// ——搭车者不陪绑），链内各跳本有 timedSignal 自净超时（多形态轮替叠加
// 可上分钟级）；这里再压 8s 硬闸并经 AbortSignal.any 合进内层 signal——
// race 超时只释放本侧等待方，底层 fetch 靠自带超时自净，落地真值仍焐热
// basicsMemo（对后续 match/verify 的惰性消费是红利，不算空烧）。
// videoId 级短 TTL memoize（独立 pubMemo 簿）：vkey 的 c1 语境位吃「源侧
// 日期有无」——解析成败抖动会把同曲键面劈成 v2/v2c1 两键（持久 verdict
// 不复用、同一判定语境下的判否记忆被旁路）；播放链每次 verify 也不必
// 先付一跳 YT 上行才查到缓存判定。存落地结果不是 promise 半成品；负结果
// （无日期/超时/故障/abort 归 null）同入缓存——视频发布日一分钟内不
// 翻转，该窗内「无日期」按稳定事实记。命中跳过 race——signal 语义在
// 命中时不适用（上游零调用无泄漏）。
// AbortSignal.any 对 truthy 非 signal 入参会同步 TypeError 抛在 .catch
// 链外——整个函数体收进 try/catch，fail-soft 归 null 不漏同步抛
const PUBDATE_RESOLVE_MS = 8000;
const PUBDATE_MEMO_MS = 60000;
// 容量帽与 declaredMemo 同口径（FIFO 挤出——Map 键序=插入序）
const PUBDATE_MEMO_CAP = 500;
const pubMemo = new Map();   // videoId -> {res, at}（res 含 null 负结果）
function resolveYtPublishDate(videoId, signal) {
  try {
    const hit = pubMemo.get(videoId);
    if (hit) {
      if (Date.now() - hit.at < PUBDATE_MEMO_MS) return Promise.resolve(hit.res);
      pubMemo.delete(videoId); // 过期即弃——不留在表里占位
    }
    const inner = signal
      ? AbortSignal.any([AbortSignal.timeout(PUBDATE_RESOLVE_MS), signal])
      : AbortSignal.timeout(PUBDATE_RESOLVE_MS);
    const TIMEOUT = {};
    return Promise.race([
      Promise.resolve().then(() => ytLib.resolvePublishedAt?.({ videoId, signal: inner })),
      new Promise((res) => {
        const t = setTimeout(() => res(TIMEOUT), PUBDATE_RESOLVE_MS);
        t.unref?.();
      }),
    ]).then((r) => {
      // 落地值过源侧合法性窗——impl 归 null/脏值/超时同归「无日期」负结果
      const ms = r && r !== TIMEOUT ? sanePublishMs(r) : 0;
      return ms || null;
    })
      .catch(() => null)
      .then((res) => {
        if (pubMemo.size >= PUBDATE_MEMO_CAP && !pubMemo.has(videoId)) {
          pubMemo.delete(pubMemo.keys().next().value);
        }
        pubMemo.set(videoId, { res, at: Date.now() });
        return res;
      });
  } catch {
    return Promise.resolve(null);
  }
}
// 测试钩子：videoId 级事实 memo（声明+发布日）两簿同清——memoize 命中
// 会绕过 ytLib 原位覆写桩，用例间不清缓存会把前例的解析结果带进后例
const _clearDeclaredMemo = () => { declaredMemo.clear(); pubMemo.clear(); };

// 下载链归属核验的决策收敛点（file-downloader 在落盘前调）：
// 1) 源签名按 songId 前缀正则选取——畸形 providerData 的 bilibili/youtube
//    双字段并存时「bilibili || youtube」短路会选错核验对象
// 2) 已落库判定不随 aiEnabled 旁路——记忆是累积知识，AI 关只影响新判定
// 3) 纯文本词（无时间戳）与真空词分开：plainTextLines 剥标签行后仍有
//    词文的照常进判定链（署名闸+AI，与级联 verifyHit 同口径）——剥完
//    真空（纯元行/纯 instrumental 标记这类没词文的形态）或 AI 关才放行
// candidate（可选）= 调用方已持有的候选条目身份 {title,artist,album}
//   （级联命中的 hit.meta）——在手直用、跳过 song_detail 反查；extId
//   词源（ytm_/lrclib_/kugou_）无网易条目可反查，candidate 在手署名闸
//   照常生效（判定链与「resolved 到网易 candidate」走完全同一套）
// 返回 true=放行 / false=判不符 / null=核验通道故障（调用方按放行处理）；
// 只有 aborted 异常穿透，其余故障一律归 null 不炸下载任务
async function verifyDownloadOwnership({ songId, lyricId, providerData, grafted, lrc, signal, candidate = null }) {
  try {
    const ytM = YT_TRACK_ID_RE.exec(String(songId));
    const extSrc = BV_TRACK_ID_RE.test(String(songId)) ? providerData?.bilibili
      : ytM ? providerData?.youtube
      : grafted ? {
        title: providerData?.title, author: providerData?.author,
        // qq_ grafted 行的时间证据槽位——与 bv/yt 嵌套块同轴（providerData
        // 投影在 download-fs.js 条件透传，缺席归 undefined=未知）
        publishedAt: providerData?.qq?.publishedAt,
      }
      : null;
    if (!extSrc?.title?.trim()) return true;
    // 词文采样先于声明解析——剥完真空的纯文本/元行词直接放行，省一跳反解
    // 上行（缓存查询/aiEnabled 半支不动，仍在声明键落定后走原序）；
    // 无时戳但有词文的形态 plainTextLines 兜底取样，照常进判定链
    let lines = parseLrcLines(lrc);
    if (!lines.length) lines = plainTextLines(lrc);
    if (!lines.length) return true;
    // 声明解析先于 vkey——缓存键的声明位落定后才能查到「声明语境」已落
    // 的判定行（先算无声明键会把级联携证据落的 v2d3 判否 verdict 旁路
    // 掉，自署证据根本没机会生效）。providerData.youtube.videoId 是任务
    // 行快照的源视频 id——先过 YT_ID_RE 形态校验，缺席/畸形回落 songId
    // 自带 yt_ 段（file-downloader 的 `providerData?.youtube?.videoId ||
    // ytM[1]` 同款口径：快照字段缺席不等于没有源视频 id）；解析失败/
    // 无声明归 null——无声明旧键逐位不动
    const pdVid = String(providerData?.youtube?.videoId || '');
    const declared = ytM
      ? await resolveYtDeclared(YT_ID_RE.test(pdVid) ? pdVid : ytM[1], signal)
      : null;
    // 源发布日（vkey c1 语境位）与 declared 同位同纪律解析——缓存键的
    // 时间位落定后才能查到「日期语境」已落的判定行。只向网易条目词源
    // 供证据：extId 词源（ytm_/lrclib_/kugou_）无候选日期对照轴，级联
    // verifyHit 也无此语境，两侧同键面才互命中；bv_ 吃 providerData 持久
    // 字段（无服务端惰性解析），yt_ 持久缺席回退惰性反解（与 declared
    // 同 videoId 回落口径：快照 videoId 缺席/畸形回落 ytM[1]）
    const srcPubMs = NETEASE_ID_BOUNDED_RE.test(String(lyricId))
      ? (sanePublishMs(extSrc?.publishedAt)
        || (ytM ? (await resolveYtPublishDate(YT_ID_RE.test(pdVid) ? pdVid : ytM[1], signal)) || 0 : 0))
      : 0;
    // 刻意不传 poolMark——下载链手里没有检索候选池可比对，盲审口径独立
    // 存续：级联内 pool 语境判否落的 v4 行与本链 v2 行互不命中；声明位
    // 同口径——级联无池+声明语境落的 v2d3 行与本链产同键复用。declMark
    // 与 judgeInner declSeg 出场条件逐字对齐（declTitle||declAuthor）——
    // 声明实参在场但题/名全空（消毒后无段可产）时键与 prompt 不劈叉；
    // chronoMark 同纪律携 srcPubMs>0——与 judgeInner pubSeg 出场条件逐字
    // 对齐，携日期语境的判定与无日期旧键分家互不命中。
    // vkey/缓存查询先于候选补料——与 routes/ai.js 播放链同序（那边
    // getVerdict 命中早退在 resolveCreditGateCandidate 之前）：命中路径
    // 不消费候选上架日则不为它付上行（wantDates &&= !cached）——缓存
    // 命中零上行纪律；未命中逐位同旧
    const vkey = lyricVerdictKey(lyricId, extSrc.title, extSrc.author || '', false,
      Boolean(declared?.title || declared?.author), srcPubMs > 0);
    const cached = lyricAiRepo.getVerdict(vkey, 'lyric');
    // 署名闸候选艺人补料 + 闸判定都先于本函数的一切短路（verdict 缓存命中
    // 与 !aiEnabled 放行）：闸的语义是确定性证据压过已固化判定——光把反查
    // 提前不够，judgeLyricLines 里的同款闸够不着本函数自己的 cached/AI 关
    // 早退，不内联跑一次同键已固化的放行错判会绕过闸直放（wholicoji 病灶
    // 形态）。判否不落 verdict——闸重算即得；对照轴不齐（无 candidate/无
    // 声明）时 composerCreditRefutes 前置归 null，零成本不适用。
    // 候选身份双通道：调用方在手（级联命中的 hit.meta）直用——extId 词源
    // 没有网易条目可反查，candidate 在手署名闸照常生效；缺省才走
    // song_detail 惰性补料（网易 lyricId 可反查的那半）。双触发位：
    //   wantArtist（署名闸要艺人）——声明+署名行齐备即付跳，缓存命中照跑
    //     （闸仍先于透传判定，压实放行错判）；
    //   wantDates（时间轴要上架日）——srcPubMs>0 且缓存未命中才付跳：
    //     命中时取回的 publishTime 零消费，白付一跳（route 链同纪律）
    const cand = candidate
      || await resolveCreditGateCandidate({ id: lyricId, lines, declared, signal,
        wantDates: srcPubMs > 0 && !cached });
    const refuteSig = composerCreditRefutes(lines, cand?.artist, declared?.author);
    if (refuteSig !== null) {
      console.info(`[lyric-verify] 署名否证: 作曲「${sanitizePrompt(refuteSig).slice(0, 120)}」=候选艺人≠声明本家「${sanitizePrompt(declared?.author).slice(0, 120)}」`);
      return false;
    }
    if (cached) return !!cached.ok;
    // AI 关只挡新判定——已落库判定行上面已查（记忆不随开关旁路）
    if (!aiEnabled()) return true;
    return await judgeLyricLines({ vkey, lines, title: extSrc.title, author: extSrc.author || '', candidate: cand, signal, declared, publishedAt: srcPubMs || undefined });
  } catch (e) {
    if (e?.aborted || signal?.aborted) throw e?.aborted ? e : Object.assign(new Error('已取消'), { aborted: true });
    return null;
  }
}

module.exports = { parseLrcLines, plainTextLines, lyricVerdictKey, judgeLyricLines, judgePoolPick, verifyDownloadOwnership, resolveYtDeclared, resolveYtPublishDate, resolveCreditGateCandidate, composerCreditNames, composerCreditRefutes, sanitizePrompt, _clearDeclaredMemo };

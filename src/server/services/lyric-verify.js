// 歌词归属核验核心——routes/ai.js:/ai/lyric-verify 与 file-downloader 的
// 下载词落盘前核验共用一套：判定对象、采样、prompt、verdict 落库。
// 「错歌词比没歌词更糟」；AI 是增强不是门禁——返回 null = 无法判定，
// 调用方按相符放行且不写 verdict（一次哑火不固化）
const { createHash } = require('crypto');
const { aiEnabled, askAiJson, aiModel } = require('../lib/ai');
const lyricAiRepo = require('../repositories/lyricAi');
const { BV_TRACK_ID_RE, YT_TRACK_ID_RE } = require('../../shared/predicates.js');

// 与前端 parseLyrics 同口径的 LRC 行解析（服务端无 ESM 共享）：
// 返回 [{tag, text}]——tag 保留原始时间戳串，翻译重建时原样回贴
function parseLrcLines(lrc) {
  const out = [];
  const tagRe = /\[(\d+):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  for (const line of String(lrc || '').split('\n')) {
    const tags = [...line.matchAll(tagRe)];
    if (!tags.length) continue;
    const text = line.replace(tagRe, '')
      .replace(/<\d+:\d{1,2}(?:[.:]\d{1,3})?>/g, '')
      .trim();
    if (!text) continue;
    for (const t of tags) out.push({ tag: t[0], text });
  }
  return out;
}

// 进 prompt 的输入剥换行/方括号——标题作者与歌词原文都是不可信输入，
// 去掉结构字符至少让注入不能伪造消息边界/键控协议
const sanitizePrompt = (s) => String(s || '')
  .replace(/[\r\n\[\]]+/g, ' ').replace(/\s+/g, ' ').trim();

// 判定对象是「(词源, 来源视频, 模型) 三元组」而非词源本身：同一 neteaseId
// 可能被不同视频匹配到，A 视频的错配不能污染 B 视频的正常取用；换模型后
// 旧判定自动失效重判（避免旧模型的误判被永久固化）
function lyricVerdictKey(lyricId, sourceTitle, sourceAuthor, poolMark) {
  // sig 输入在键函数内单边收口（slice 口径 = mirror 投影的 300/120）——
  // 播放链传全量、下载链传投影截断值，两侧对同一首歌必须产同一个键。
  // 必须先 slice 后 trim：trim(raw)[0:300] ≠ trim(raw[0:300])——前导空白
  // 或第 300 位恰是空白时两序产不同 sig（截断顺序不可交换）
  // 版本段：v2=判定输入含候选条目身份（judgeInner 的 candidate 段）——
  // v1 键下落的旧判定（无候选信息的保守放行/错判）不能被新判定吃到；
  // v3=判定输入再含同题候选池（candidate.pool 段）——pool 改变判定语境
  // （单候选盲审 → 候选间相对比较），v2 下落的单盲判定不能被 pool 判定
  // 复用，反之亦然：两个口径的判否记忆各自存续、互不命中
  const sig = createHash('sha1')
    .update(`${poolMark ? 'v3' : 'v2'}|${String(sourceTitle).slice(0, 300).toLowerCase().trim()}|${String(sourceAuthor).slice(0, 120).toLowerCase().trim()}`)
    .digest('hex').slice(0, 12);
  return `${lyricId}@${aiModel()}@${sig}`;
}

// vkey 级单飞：路由层 inflightVerify 只管 HTTP 调用方，file-downloader 的
// 并发下载任务直调本函数——同一 vkey 的两个任务不内聚会各烧一次 AI、
// 且模型非确定下可能一个落词一个 NO_LYRICS。共享 promise 不吃调用方
// signal（首调用方 abort 不该让搭车者陪绑），10s 默认超时是自净上限
const judgeInflight = new Map();

// lines 为 parseLrcLines 产出。命中 verdict 缓存直接返回（不消耗 AI）；
// 判定为布尔时写 kind='lyric' verdict 后返回；模型未给合法判定返回 null。
// candidate（可选）= 外源检索命中条目的平台元数据 {title, artist, album}——
// 词面撞名时「候选条目身份」是同名异曲拦截的关键证据（无候选信息的旧
// 判定口径见 lyricVerdictKey 的 v2 版本段说明）；candidate.pool（可选）
// = 同次检索排序后的同题候选集身份 [{title, artist, album}, ...]——单盲
// 审分不清的同题异曲靠它判「来源实际所唱哪条」（v3 版本段说明同上）
async function judgeLyricLines({ vkey, lines, title, author, candidate, signal }) {
  const cached = lyricAiRepo.getVerdict(vkey, 'lyric');
  if (cached) return !!cached.ok;
  if (signal?.aborted) return null;
  const gate = judgeInflight.get(vkey);
  if (gate) {
    const shared = await gate;
    // 搭车者用自己的 signal 决定吃不吃结果——返回前复查
    return signal?.aborted ? null : shared;
  }
  const p = judgeInner(vkey, lines, title, author, candidate)
    .finally(() => judgeInflight.delete(vkey));
  judgeInflight.set(vkey, p);
  return p;
}

async function judgeInner(vkey, lines, title, author, candidate) {

  const sourceTitle = sanitizePrompt(title).slice(0, 500);
  const sourceAuthor = sanitizePrompt(author).slice(0, 200);

  // 候选条目身份段：来源视频是 'Twig' 而词源条目是 'Pinocchio Twig /
  // Koosje' 时，词里撞见 'twig' 不足以证相符。字段与来源标题同走
  // sanitizePrompt（不可信输入不伪造消息边界）；判定指引随段同给——
  // 身份与词文双不符才判 false，翻唱借词（语义一致）仍判 true
  const candTitle = sanitizePrompt(candidate?.title).slice(0, 200);
  const candArtist = sanitizePrompt(candidate?.artist).slice(0, 120);
  const candAlbum = sanitizePrompt(candidate?.album).slice(0, 200);
  const candSeg = (candTitle || candArtist || candAlbum)
    ? `\n候选条目：标题 ${candTitle || '未知'} / 艺人 ${candArtist || '未知'} / 专辑 ${candAlbum || '未知'}`
    : '';
  const candGuide = candSeg
    ? '若候选条目标题/艺人与来源明显不同且歌词内容语言/主题也不符，判 false；翻唱曲借用原词但词文语义一致判 true。'
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

  // 抽样而非全文：首 4 行抓歌名植入（很多歌词开头点题），中段 6 行看主题；
  // 同文行（多时间戳副歌展开）去重，不浪费采样位
  const seenSample = new Set();
  const sample = [...lines.slice(0, 4), ...lines.slice(4).filter((_, i) => i % Math.max(1, Math.floor(lines.length / 6)) === 0)]
    .map(l => sanitizePrompt(l.text).slice(0, 200))
    .filter(t => t && !seenSample.has(t) && seenSample.add(t))
    .slice(0, 10);

  const ans = await askAiJson({
    system: '你是音乐内容核验助手。给定来源音/视频的标题与作者，以及从音乐平台配到的歌词抽样，'
      + '判断这份歌词是否明显属于另一首歌（完全不同的主题/内容/语言体系）。'
      + '罗马音/音译词视同语言相符；双语对照歌词按原文判。'
      + '保守原则：只有「明显是别的歌」才判不符；拿不准、纯音乐标注、语言相符但主题难判都回 true。'
      + candGuide
      + poolGuide
      + '只输出 JSON {"ok":true|false}',
    user: `来源标题：${sourceTitle}\n来源作者/频道：${sourceAuthor || '未知'}${candSeg}${poolSeg}\n歌词抽样：\n${sample.map((t, i) => `${i + 1}. ${t}`).join('\n')}`,
    maxTokens: 64,
  });
  if (ans == null || typeof ans.ok !== 'boolean') return null;
  lyricAiRepo.upsertVerdict(vkey, 'lyric', ans.ok, sourceTitle.slice(0, 200));
  return ans.ok;
}

// 同题异曲整池消歧：级联免时长末轮把排序后同题候选池整盘喂给模型做
// 单发选择题——「来源最可能翻唱池中哪条」的相对判定比逐候选布尔盲审
// 更决断（实证：pool-in-prompt 逐题形态把 KKB 英文版 Flamingo 判 ok
// 收录；同池单发选择题直接指中 米津玄師）。
// 返回命中候选的 0 基下标；pick 超界/非数/哑火/AI 关/abort 归 null，
// 调用方按「未选中」落回逐候选核验。
// 刻意不写 verdict 表：级联结果本身已按 (songId,title,artist,dur) 进
// lyric 结果缓存；pick 是「池内相对」判定——同一条目换个池可能改判，
// 落单候选键会把相对结论固化成绝对归属记忆（与逐候选 ok/false 的绝对
// 判定不同义，verdict 复用语义不成立）
async function judgePoolPick({ title, author, pool, signal }) {
  if (!aiEnabled() || signal?.aborted) return null;
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
  if (!rows.length) return null;
  const ans = await askAiJson({
    system: '你是音乐曲库消歧助手。来源是一条翻唱/节选投稿音视频的标题与作者。'
      + '候选池是外源歌词库按标题搜出的同题条目（同题异曲常见）。'
      + '判断来源视频最可能翻唱的是池中哪一条——结合来源作者/标题语境'
      + '（日文圈翻唱命名如「X／歌手」对应的原曲几乎总是日文原曲；'
      + '同题异曲选语境最合的那条）。若池中没有任何合理候选回 null。'
      + '只输出 JSON {"pick":序号或null}',
    user: `来源标题：${sourceTitle}\n来源作者/频道：${sourceAuthor || '未知'}\n候选池：\n`
      + rows.map((p, i) => `${i + 1}. ${p.title || '未知'} / ${p.artist || '未知'} / ${p.album || '未知'}`).join('\n'),
    maxTokens: 64,
  });
  // 只收 1..N 整数序号——超界/非数/对象畸形一律按未选中落回迭代
  const pick = ans?.pick;
  if (!Number.isInteger(pick) || pick < 1 || pick > rows.length) return null;
  return pick - 1;
}

// 下载链归属核验的决策收敛点（file-downloader 在落盘前调）：
// 1) 源签名按 songId 前缀正则选取——畸形 providerData 的 bilibili/youtube
//    双字段并存时「bilibili || youtube」短路会选错核验对象
// 2) 已落库判定不随 aiEnabled 旁路——记忆是累积知识，AI 关只影响新判定
// 3) 无时间戳纯文本词 parse 出 0 行（没东西可验）或 AI 关 → 放行
// 返回 true=放行 / false=判不符 / null=核验通道故障（调用方按放行处理）；
// 只有 aborted 异常穿透，其余故障一律归 null 不炸下载任务
async function verifyDownloadOwnership({ songId, lyricId, providerData, grafted, lrc, signal }) {
  try {
    const extSrc = BV_TRACK_ID_RE.test(String(songId)) ? providerData?.bilibili
      : YT_TRACK_ID_RE.test(String(songId)) ? providerData?.youtube
      : grafted ? { title: providerData?.title, author: providerData?.author }
      : null;
    if (!extSrc?.title?.trim()) return true;
    // 刻意不传 poolMark——下载链手里没有检索候选池可比对，盲审口径独立
    // 存续：级联内 pool 语境判否落的 v3 行与本链 v2 行互不命中（此处复审
    // 的是「已落盘候选 vs 来源」的单候选判定，与级联同键复用无涉）
    const vkey = lyricVerdictKey(lyricId, extSrc.title, extSrc.author || '');
    const cached = lyricAiRepo.getVerdict(vkey, 'lyric');
    if (cached) return !!cached.ok;
    const lines = parseLrcLines(lrc);
    if (!lines.length || !aiEnabled()) return true;
    return await judgeLyricLines({ vkey, lines, title: extSrc.title, author: extSrc.author || '', signal });
  } catch (e) {
    if (e?.aborted || signal?.aborted) throw e?.aborted ? e : Object.assign(new Error('已取消'), { aborted: true });
    return null;
  }
}

module.exports = { parseLrcLines, lyricVerdictKey, judgeLyricLines, judgePoolPick, verifyDownloadOwnership };

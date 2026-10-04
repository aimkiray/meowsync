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
function lyricVerdictKey(lyricId, sourceTitle, sourceAuthor) {
  // sig 输入在键函数内单边收口（slice 口径 = mirror 投影的 300/120）——
  // 播放链传全量、下载链传投影截断值，两侧对同一首歌必须产同一个键。
  // 必须先 slice 后 trim：trim(raw)[0:300] ≠ trim(raw[0:300])——前导空白
  // 或第 300 位恰是空白时两序产不同 sig（截断顺序不可交换）
  const sig = createHash('sha1')
    .update(`${String(sourceTitle).slice(0, 300).toLowerCase().trim()}|${String(sourceAuthor).slice(0, 120).toLowerCase().trim()}`)
    .digest('hex').slice(0, 12);
  return `${lyricId}@${aiModel()}@${sig}`;
}

// vkey 级单飞：路由层 inflightVerify 只管 HTTP 调用方，file-downloader 的
// 并发下载任务直调本函数——同一 vkey 的两个任务不内聚会各烧一次 AI、
// 且模型非确定下可能一个落词一个 NO_LYRICS。共享 promise 不吃调用方
// signal（首调用方 abort 不该让搭车者陪绑），10s 默认超时是自净上限
const judgeInflight = new Map();

// lines 为 parseLrcLines 产出。命中 verdict 缓存直接返回（不消耗 AI）；
// 判定为布尔时写 kind='lyric' verdict 后返回；模型未给合法判定返回 null
async function judgeLyricLines({ vkey, lines, title, author, signal }) {
  const cached = lyricAiRepo.getVerdict(vkey, 'lyric');
  if (cached) return !!cached.ok;
  if (signal?.aborted) return null;
  const gate = judgeInflight.get(vkey);
  if (gate) {
    const shared = await gate;
    // 搭车者用自己的 signal 决定吃不吃结果——返回前复查
    return signal?.aborted ? null : shared;
  }
  const p = judgeInner(vkey, lines, title, author)
    .finally(() => judgeInflight.delete(vkey));
  judgeInflight.set(vkey, p);
  return p;
}

async function judgeInner(vkey, lines, title, author) {

  const sourceTitle = sanitizePrompt(title).slice(0, 500);
  const sourceAuthor = sanitizePrompt(author).slice(0, 200);

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
      + '只输出 JSON {"ok":true|false}',
    user: `来源标题：${sourceTitle}\n来源作者/频道：${sourceAuthor || '未知'}\n歌词抽样：\n${sample.map((t, i) => `${i + 1}. ${t}`).join('\n')}`,
    maxTokens: 64,
  });
  if (ans == null || typeof ans.ok !== 'boolean') return null;
  lyricAiRepo.upsertVerdict(vkey, 'lyric', ans.ok, sourceTitle.slice(0, 200));
  return ans.ok;
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

module.exports = { parseLrcLines, lyricVerdictKey, judgeLyricLines, verifyDownloadOwnership };

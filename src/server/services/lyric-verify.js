// 歌词归属核验核心——routes/ai.js:/ai/lyric-verify 与 file-downloader 的
// 下载词落盘前核验共用一套：判定对象、采样、prompt、verdict 落库。
// 「错歌词比没歌词更糟」；AI 是增强不是门禁——返回 null = 无法判定，
// 调用方按相符放行且不写 verdict（一次哑火不固化）
const { createHash } = require('crypto');
const { askAiJson, AI_MODEL } = require('../lib/ai');
const lyricAiRepo = require('../repositories/lyricAi');

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
  const sig = createHash('sha1')
    .update(`${String(sourceTitle).toLowerCase().trim()}|${String(sourceAuthor).toLowerCase().trim()}`)
    .digest('hex').slice(0, 12);
  return `${lyricId}@${AI_MODEL}@${sig}`;
}

// lines 为 parseLrcLines 产出。命中 verdict 缓存直接返回（不消耗 AI）；
// 判定为布尔时写 kind='lyric' verdict 后返回；模型未给合法判定返回 null
async function judgeLyricLines({ vkey, lines, title, author, signal }) {
  const cached = lyricAiRepo.getVerdict(vkey, 'lyric');
  if (cached) return !!cached.ok;
  if (signal?.aborted) return null;

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
    signal,
  });
  if (ans == null || typeof ans.ok !== 'boolean') return null;
  lyricAiRepo.upsertVerdict(vkey, 'lyric', ans.ok, sourceTitle.slice(0, 200));
  return ans.ok;
}

module.exports = { parseLrcLines, lyricVerdictKey, judgeLyricLines };

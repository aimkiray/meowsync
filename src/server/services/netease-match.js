const { callNeteaseApi } = require('./netease-api');
const { aiEnabled, askAiJson } = require('../lib/ai');

// 外部导入曲（B 站/YouTube）匹配网易云词源：候选串逐个搜，第一条通过
// sanity 校验的为准。sanity = 歌名互相包含 或 时长差 ≤45s——纯「有结果就取」
// 会把噪声标题的错配永久固化进壳与历史（错歌词比没歌词更糟），校验不过就
// 放弃匹配用源站元数据
const MATCH_DUR_TOLERANCE_SEC = 45;

const shareName = (a, b) => {
  const na = String(a || '').toLowerCase().replace(/[\s《》【】（）()\-—–_~～·]/g, '');
  const nb = String(b || '').toLowerCase().replace(/[\s《》【】（）()\-—–_~～·]/g, '');
  return na.length >= 2 && nb.length >= 2 && (na.includes(nb) || nb.includes(na));
};

// 进 prompt 的字段统一净化：来源标题/频道名是 UGC、上游歌名/歌手/专辑
// 是第三方数据——剥换行与方括号，至少让注入无法伪造消息边界/候选行
const cleanPrompt = (s) => String(s ?? '')
  .replace(/[\r\n\[\]]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);

const songDesc = (s) => {
  const arr = Array.isArray(s?.ar || s?.artists) ? (s.ar || s.artists) : [];
  const artists = arr.map(a => a?.name).filter(Boolean).join('/') || '未知';
  const dur = Math.round((s?.dt || s?.duration || 0) / 1000);
  const album = s?.al?.name || s?.album?.name || '未知';
  return `${cleanPrompt(s?.name)} — ${cleanPrompt(artists)}（${dur}s，专辑《${cleanPrompt(album)}》）`;
};

// AI 确认：时长-only 命中是错配高发场景（歌名不互包含只靠时长窗）——
// 有能力时让模型复核；模型拒答/超时返回 null 按原启发式放行（AI 是增强不是门禁）
async function aiConfirmMatch(song, sourceInfo, durationSec, signal) {
  const ans = await askAiJson({
    system: '你是音乐识别助手。判断候选歌曲与来源音/视频是不是同一首歌'
      + '（同一录音、官方版本，或同一首歌的不同平台发布）。歌名不同语言/译名差异属正常。'
      + '只输出 JSON {"match":true|false}。',
    user: `来源：${cleanPrompt(sourceInfo.title)} — ${cleanPrompt(sourceInfo.author) || '未知'}（${durationSec || '?'}s）\n候选：${songDesc(song)}`,
    maxTokens: 32,
    signal,
  });
  return ans && typeof ans.match === 'boolean' ? ans.match : null;
}

// AI 再生查询：启发式候选串全是脏标题时（韩翻「歌名┃频道 COVER」、搬运号
// 塞梗词等），云搜只回噪声、池子里根本没有正主——让模型从标题/作者抽出
// 干净查询词再搜一轮，把正主装进候选池。产出串同样要过下方的 sanity 闸
async function aiExtractQueries(sourceInfo, signal) {
  const ans = await askAiJson({
    system: '你是音乐识别助手。从音/视频标题与作者名提取用于音乐平台搜索的查询词。'
      + '标题常带频道名/COVER/翻唱/分隔符等噪声，作者常是翻唱者而非原唱。'
      + '给出至多 3 条查询（首选干净歌名，其次「原唱/艺人 歌名」组合）。'
      + '提取不出返回 {"queries":[]}。只输出 JSON。',
    user: `标题：${cleanPrompt(sourceInfo.title)}\n作者/频道：${cleanPrompt(sourceInfo.author) || '未知'}`,
    maxTokens: 96,
    signal,
  });
  const raw = Array.isArray(ans?.queries) ? ans.queries : [];
  return [...new Set(raw
    .map(q => String(q ?? '').replace(/\s+/g, ' ').trim())
    .filter(q => q && q.length <= 80))]
    .slice(0, 3);
}

// AI 兜底：启发式全失败时，把所有查询见过的候选整批给模型挑——
// 一次调用覆盖 ≤10 候选，比逐候选问省额度且上下文更全
async function aiPickMatch(seenSongs, sourceInfo, durationSec, signal, vetoedIds = null) {
  // 已被 aiConfirmMatch 否决的候选不进池——否决后再被兜底挑回是语义矛盾
  const list = [...seenSongs.values()]
    .filter(s => !vetoedIds?.has(s.id))
    .slice(0, 10);
  if (!list.length) return null;
  const desc = list.map((s, i) => `${i + 1}. ${songDesc(s)}`).join('\n');
  const ans = await askAiJson({
    system: '你是音乐识别助手。从候选列表选出与来源音/视频同一首歌的编号'
      + '（同一录音/官方版本/同名同曲的不同发布都算；翻唱/混音/live 版本不算）。'
      + '都不符返回 {"match":0}，能确定返回 {"match":编号}。只输出 JSON。',
    user: `来源：${cleanPrompt(sourceInfo.title)} — ${cleanPrompt(sourceInfo.author) || '未知'}（${durationSec || '?'}s）\n候选：\n${desc}`,
    maxTokens: 32,
    signal,
  });
  // match:true（模型混用 confirm 形态）Number(true)=1 会假命中第 1 候选——
  // 布尔与 null 显式排除后再转数字
  if (typeof ans?.match !== 'number' && typeof ans?.match !== 'string') return null;
  const n = Number(ans.match);
  if (!Number.isInteger(n) || n < 1 || n > list.length) return null;
  const pick = list[n - 1];
  // AI 兜底仍过粗粒度时长闸（120s，约为确定性窗口的 3 倍——片头尾垫长
  // 可过，但「时长差几分钟的另一首歌」不能仅凭模型点头就命中）
  const pickDt = (pick.dt || pick.duration || 0) / 1000;
  if (durationSec > 0 && pickDt > 0 && Math.abs(pickDt - durationSec) > 120) {
    console.info(`[ai-pick] 时长差 ${Math.round(Math.abs(pickDt - durationSec))}s 超闸，弃票: ${songDesc(pick)}`);
    return null;
  }
  return pick;
}

// candidates 按优先级排（提取名/频道歌手组合 → 清洗标题），逐个云搜；
// 每个候选内两遍优选：歌名包含是最强信号（跨语翻唱同名必中），时长命中
// 取差最小者——顺序「首个过线」会让时长恰好在窗内的噪声压过排后的正主。
// signal：客户端断连/调用方主动作废时早退，不刷无意义的上游云搜。
// sourceInfo={title,author}：AI 增强用——时长-only 命中复核 + 启发式全灭时
// 从已见候选整批挑一个。AI 未配置时语义与之前完全一致
async function matchNeteaseSong(candidates, durationSec, tag = 'import', signal = null, sourceInfo = null) {
  const seenSongs = new Map();
  const vetoedIds = new Set();
  const useAi = aiEnabled() && !!sourceInfo?.title;

  // 单条查询的云搜 + 启发式命中：命中即返回，未命中也把结果记入 seenSongs
  // 供 AI 再生/兜底复用。AI 否决的时长候选进 vetoedIds 不再复活
  const searchOnce = async (q) => {
    const res = await callNeteaseApi('cloudsearch', { keywords: q, type: '1', limit: '5' });
    const songs = res.body?.result?.songs;
    if (!Array.isArray(songs) || !songs.length) return null;
    for (const s of songs) if (s?.id != null) seenSongs.set(s.id, s);
    const byName = songs.find(s => shareName(s.name, q));
    // name 命中不查 vetoedIds——确定性的歌名互包含是强证据，
    // 优先于弱证据（纯时长）场景下模型给出的否决
    if (byName) return { song: byName, query: q };
    // 时长 sanity 只在有真实时长时启用——源时长 0（live/首映/字段缺失）会把
    // ≤45s 的短曲错配（|x-0|≤45 窗口对 0 恒成立的方向性失真）
    if (Number.isFinite(durationSec) && durationSec > 0) {
      // 被 AI 否决过的歌直接从时长候选池剔除——本串及后续串都不再重问
      // （省额度的一票否决）；本串否决即记 veto 不算命中，次优只能在
      // 后续串的搜索结果里因正主被过滤而胜出时才获得复核机会
      const byDur = songs
        .map(s => ({ s, diff: Math.abs((s.dt || s.duration || 0) / 1000 - durationSec) }))
        .filter(x => x.diff <= MATCH_DUR_TOLERANCE_SEC && !vetoedIds.has(x.s.id))
        .sort((a, b) => a.diff - b.diff)[0];
      if (byDur) {
        // 纯时长命中（歌名不含）是错配高发位——AI 复核，明确否决才弃票
        if (useAi) {
          const verdict = await aiConfirmMatch(byDur.s, sourceInfo, durationSec, signal);
          if (verdict === false) {
            vetoedIds.add(byDur.s.id);
            console.info(`[${tag}] AI 否决时长匹配: ${songDesc(byDur.s)} ← ${sourceInfo.title}`);
            return null;
          }
        }
        return { song: byDur.s, query: q };
      }
    }
    return null;
  };

  const warnFail = (q, e) => {
    // 上游 reject(answer) 形态无 .message——归一化再记
    const why = e?.message || (e?.body ? `code=${e.body.code ?? '?'}` : String(e));
    console.warn(`[${tag}] 网易云搜索「${q}」失败:`, why);
  };

  for (const q of candidates) {
    if (signal?.aborted) break;
    if (!q) continue;
    try {
      const hit = await searchOnce(q);
      if (hit) return hit;
    } catch (e) {
      warnFail(q, e);
    }
  }
  // 启发式链全灭 → ①AI 再生干净查询词补一轮（脏标题串搜不到正主时
  // 唯一把正主装进候选池的路），产出仍过 shareName/时长/否决闸；
  // ②AI 兜底从全量已见候选里挑（如『短视频标题串了梗词导致
  // 所有搜索串都搜不到正主』的场景——直接看整批候选比再搜一轮更有效）
  if (useAi && !signal?.aborted) {
    const regen = await aiExtractQueries(sourceInfo, signal).catch(() => []);
    for (const q of regen) {
      if (signal?.aborted) break;
      try {
        const hit = await searchOnce(q);
        if (hit) {
          console.info(`[${tag}] AI 再生查询命中「${q}」: ${songDesc(hit.song)} ← ${sourceInfo.title}`);
          return { song: hit.song, query: `ai:${q}` };
        }
      } catch (e) {
        warnFail(q, e);
      }
    }
  }
  if (useAi && seenSongs.size && !signal?.aborted) {
    // 畸形上游数据（ar 非数组等）在 desc 构建处可能 TypeError——
    // 兜底是增强路径，异常按「无兜底」降级而非 502
    const pick = await aiPickMatch(seenSongs, sourceInfo, durationSec, signal, vetoedIds)
      .catch(() => null);
    if (pick) {
      console.info(`[${tag}] AI 兜底命中: ${songDesc(pick)} ← ${sourceInfo.title}`);
      return { song: pick, query: 'ai' };
    }
  }
  return { song: null, query: null };
}

module.exports = { matchNeteaseSong, shareName, MATCH_DUR_TOLERANCE_SEC };

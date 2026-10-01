const { callNeteaseApi } = require('./netease-api');
const { aiEnabled, askAiJson } = require('../lib/ai');

// 外部导入曲（B 站/YouTube）匹配网易云词源：候选串逐个搜，第一条通过
// sanity 校验的为准。sanity = 歌名互相包含 或 时长差 ≤45s——纯「有结果就取」
// 会把噪声标题的错配永久固化进壳与历史（错歌词比没歌词更糟），校验不过就
// 放弃匹配用源站元数据
const MATCH_DUR_TOLERANCE_SEC = 45;

// 规范化成「艺人/歌名互比」口径——与 shareName 同款剥法
const normToken = (s) => String(s || '')
  .toLowerCase().replace(/[\s《》【】（）()\-—–_~～·]/g, '');

// 名命中是否需要 AI 复核：查询是多 token 组合（「艺人 歌名」形态）且候选
// 艺人与（源作者 ∪ 查询内 token）零交集 → 同名错配风险真实存在。
// 单 token 纯歌名查询的名互包含是强证据，不为它多花一次模型调用；
// 候选艺人字段缺失同样判不出交集——按「需要复核」处理
// 查询串里的修饰 token 不算艺人引用——'recovery' 含 'cover'、'olive' 含
// 'live' 这类子串碰撞会制造假 overlap 跳过本应触发的复核。成员判定用
// 剥离全部非标点/字母/数字的严归一（normToken 不剥 ASCII 标点，'cover.'
// /'[mv]' 会绕过精确匹配集合）
const QUERY_NOISE = new Set([
  'cover', 'covers', 'covered', 'coverver', '커버', '翻唱', '翻弹', '演奏',
  'live', 'official', 'mv', 'audio', 'video', 'lyric', 'lyrics',
  'hd', '4k', '8k', 'remix', 'full', '完整版', '完整',
  // 高频碰撞面：短词 token 极易被艺人名吸收成假交集（'ep'⊂'deeppurple'、
  // 'ost'⊂'ghost'、'op'⊂'hope'、'ed'⊂'edsheeran'、'by'⊂'baby'）
  'feat', 'ft', 'by', 'ver', 'version', 'ep', 'op', 'ed', 'ost',
  'mix', 'edit', 'demo', 'pv', 'inst', 'instrumental', 'acoustic',
  'karaoke', '8d', 'slowed', 'sped', 'remaster', 'remastered',
  'single', 'album', 'topic',
  '现场', '伴奏', '演唱会', '单曲', '专辑', '中字', '字幕', '合集',
  '试听', '自制', '搬运', '转载',
]);
const noiseKey = (t) => String(t ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const nameHitNeedsConfirm = (song, q, sourceInfo) => {
  const tokens = String(q).trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return false;
  // author 同样过噪声闸——频道名就叫 'Cover'/'LIVE官方' 时它是假引用
  const refs = [sourceInfo?.author, ...tokens]
    .filter(t => !QUERY_NOISE.has(noiseKey(t)))
    .map(normToken).filter(x => x.length >= 2);
  const arts = (Array.isArray(song.ar || song.artists) ? (song.ar || song.artists) : [])
    .map(a => normToken(a?.name)).filter(x => x.length >= 2);
  return !arts.some(a => refs.some(r =>
    a.includes(r)
    // 反向（ref 吞艺人名）加两道闸：艺人本身叫 'Live'/'MV' 之类的噪声词，
    // 或短到 <3 字符——'olive' 吞 'live'、'lemon' 吞 'lemo' 都是假交集
    || (a.length >= 3 && !QUERY_NOISE.has(noiseKey(a)) && r.includes(a))));
};

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
    // match 路径嵌在 25s resolve 预算内——AI 单次调用收窄到 10s，
    // 慢端点（挂起/排队）不能独占整个预算让启发式链没机会跑
    timeoutMs: 10000,
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
    timeoutMs: 10000,
    signal,
  });
  const raw = Array.isArray(ans?.queries) ? ans.queries : [];
  return [...new Set(raw
    // 只收字符串元素——对象/数字经 String() 会产垃圾查询白烧上游；
    // 控制符（C0/DEL/bidi）会进 keywords 与日志/持久化 matchedBy，一并剥
    .filter(q => typeof q === 'string')
    .map(q => q.replace(/[\p{C}]+/gu, ' ').replace(/\s+/g, ' ').trim())
    .filter(q => q.length >= 2 && q.length <= 80))]
    .slice(0, 3);
}

// AI 兜底：启发式全失败时，把所有查询见过的候选整批给模型挑——
// 一次调用覆盖 ≤10 候选，比逐候选问省额度且上下文更全
async function aiPickMatch(seenSongs, sourceInfo, durationSec, signal, vetoedIds = null, preferIds = null) {
  // 已被 aiConfirmMatch 否决的候选不进池——否决后再被兜底挑回是语义矛盾。
  // preferIds（再生轮新装入的候选）排在截断窗口前部——seenSongs 是插入序
  // Map，启发式批先填 ≥10 时再生批会被 slice 挤掉，而那恰是正主在的批
  const all = [...seenSongs.values()].filter(s => !vetoedIds?.has(s.id));
  const list = (preferIds?.size
    ? [...all.filter(s => preferIds.has(s.id)), ...all.filter(s => !preferIds.has(s.id))]
    : all).slice(0, 10);
  if (!list.length) return null;
  const desc = list.map((s, i) => `${i + 1}. ${songDesc(s)}`).join('\n');
  const ans = await askAiJson({
    system: '你是音乐识别助手。从候选列表选出与来源音/视频同一首歌的编号'
      + '（同一录音/官方版本/同名同曲的不同发布都算；翻唱/混音/live 版本不算）。'
      + '都不符返回 {"match":0}，能确定返回 {"match":编号}。只输出 JSON。',
    user: `来源：${cleanPrompt(sourceInfo.title)} — ${cleanPrompt(sourceInfo.author) || '未知'}（${durationSec || '?'}s）\n候选：\n${desc}`,
    maxTokens: 32,
    timeoutMs: 10000,
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
  // 供 AI 再生/兜底复用。AI 否决的时长候选进 vetoedIds 不再复活。
  // collect：本轮新装入的候选 id（再生轮优先池用）。nameHit 标记供
  // 再生轮区分「确定性互包含」与「时长命中」（前者要补一次 AI 复核——
  // 模型产出的查询串比启发式候选离 ground truth 远一跳，不能免检）
  const searchOnce = async (q, collect = null) => {
    const res = await callNeteaseApi('cloudsearch', { keywords: q, type: '1', limit: '5' }, { signal });
    if (signal?.aborted) return null;
    // 上游数组混入 null 元素会让下游 .find/.map 裸取字段 TypeError——先净化
    const songs = (res.body?.result?.songs || []).filter(s => s && typeof s === 'object');
    if (!songs.length) return null;
    for (const s of songs) if (s.id != null) { seenSongs.set(s.id, s); collect?.add(s.id); }
    const byName = songs.find(s => !vetoedIds.has(s.id) && shareName(s.name, q));
    // veto 是「(源,候选)对」级判定与证据类型无关——被否的 id 不经任何
    // 路径复活（含后续串的名命中），否则同一错配换个查询串就钻回来。
    // 接受的代价：模型误否的正主在本请求内不再被名命中救回——
    // 漏配（退回源站元数据）优于错配（固化错词源），与文件头哲学一致
    if (byName) {
      // 「艺人 歌名」组合查询的名命中是同名错配高发口：查询串含艺人成分时
      // 任何同名曲都满足双向包含（'coverer Lemon' 搜出 米津玄師 的 Lemon）。
      // 候选艺人与（源作者 ∪ 查询 token）零交集则过一次 AI 复核——翻唱场景
      // 必然零交集（AI 判同一首歌的翻唱为 true 放行，真同名异曲被否）
      if (useAi && nameHitNeedsConfirm(byName, q, sourceInfo)) {
        const verdict = await aiConfirmMatch(byName, sourceInfo, durationSec, signal);
        if (verdict === false) {
          vetoedIds.add(byName.id);
          console.info(`[${tag}] AI 否决组合名命中: ${songDesc(byName)} ← ${q}`);
          return null;
        }
        return { song: byName, query: q, nameHit: true, aiChecked: true };
      }
      return { song: byName, query: q, nameHit: true };
    }
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
  // 唯一把正主装进候选池的路），产出仍过 shareName/时长/否决闸——且
  // 再生轮 name 命中额外过一次 AI 复核（模型产出的查询串离 ground truth
  // 远一跳，臆造真实歌名会被 shareName 确定性放行，不能免检）；
  // ②AI 兜底从全量已见候选里挑（如『短视频标题串了梗词导致
  // 所有搜索串都搜不到正主』的场景——直接看整批候选比再搜一轮更有效）
  // query/matchedBy 值域：'<搜索串>'（启发式）/ 'ai:regen:<串>' / 'ai:pick'
  const regenIds = new Set();
  if (useAi && !signal?.aborted) {
    const candSet = new Set(candidates.map(q => String(q || '').trim().toLowerCase()));
    const regen = (await aiExtractQueries(sourceInfo, signal).catch(() => []))
      .filter(q => !candSet.has(q.toLowerCase())); // 与已试过的串去重，不白烧上游
    for (const q of regen) {
      if (signal?.aborted) break;
      try {
        const hit = await searchOnce(q, regenIds);
        if (!hit) continue;
        // 再生轮的名命中必过一次复核（模型产出的查询串离 ground truth 远
        // 一跳，臆造真实歌名会被 shareName 确定性放行）；searchOnce 内已
        // 问过的同对（aiChecked——verdict 为 null 的哑火也标，同请求内
        // AI 哑是粘性的重问白烧）不重复问
        if (hit.nameHit && !hit.aiChecked) {
          const verdict = await aiConfirmMatch(hit.song, sourceInfo, durationSec, signal);
          if (verdict === false) {
            vetoedIds.add(hit.song.id);
            console.info(`[${tag}] AI 否决再生名命中: ${songDesc(hit.song)} ← ${q}`);
            continue;
          }
        }
        console.info(`[${tag}] AI 再生查询命中「${q}」: ${songDesc(hit.song)} ← ${sourceInfo.title}`);
        return { song: hit.song, query: `ai:regen:${q}` };
      } catch (e) {
        warnFail(q, e);
      }
    }
  }
  if (useAi && seenSongs.size && !signal?.aborted) {
    // 畸形上游数据（ar 非数组等）在 desc 构建处可能 TypeError——
    // 兜底是增强路径，异常按「无兜底」降级而非 502；再生批优先入池
    const pick = await aiPickMatch(seenSongs, sourceInfo, durationSec, signal, vetoedIds, regenIds)
      .catch(() => null);
    if (pick) {
      console.info(`[${tag}] AI 兜底命中: ${songDesc(pick)} ← ${sourceInfo.title}`);
      return { song: pick, query: 'ai:pick' };
    }
  }
  return { song: null, query: null };
}

module.exports = { matchNeteaseSong, shareName, nameHitNeedsConfirm, MATCH_DUR_TOLERANCE_SEC };

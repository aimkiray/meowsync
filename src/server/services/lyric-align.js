// 「粗粒度能量包络 → LLM 对齐 → LRC」流水线核心——不做 ASR：
// ffmpeg 把音频抽成 8kHz 单声道 PCM（人声带通 300-3400 削弱伴奏遮蔽），
// 每 200ms 帧算 RMS 归一化到峰值、量化成 0-9 单字符——4min 歌约 1200
// 字符，连同已知歌词行喂模型，让它映射每行行首时间戳，产出 LRC。
//
// 分层（纯函数段全部可测，不依赖 ffmpeg/AI）：
//   pcmToEnergies/quantizeEnvelope  PCM → 归一化帧能量 → 包络字符流
//   detectOnsets                    帧间能量突升位置（行首吸附靶点）
//   detectVocalSegments             能量阈值 → 人声段集合（启发式铺行用）
//   snapToOnsets/enforceMonotonic   吸附 ±600ms 内最近起音 + 单调钳位
//   heuristicTimes                  无 AI 降级：按行字符数加权铺进人声段
//   llmAlignTimes                   60 行/块逐块对齐，块间给 startHintMs
//   extractEnvelope                 ffmpeg → PCM → 以上全套
//   alignAudioToLrc                 端到端入口（路由/file-downloader 相位用）
//
// AI 是增强不是门禁：aiEnabled=false 或模型输出违例重试仍坏 → 纯算法
// 降级铺轴（alignedBy:'heuristic' 供上游甄别），绝不因 AI 缺失报失败。
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const { aiEnabled, askAiJson } = require('../lib/ai');
const { cleanLrcLineText } = require('../../shared/lrc.js');

// 帧宽 200ms：行级对齐 ±0.5s 精度足够，且 4min 歌 = 1200 帧 = 单行 prompt
const FRAME_MS = 200;
const SAMPLE_RATE = 8000;
// PCM 缓冲上限 48MB ≈ 50min（16KB/s）——超长播单/直播流不无限吃内存
const MAX_PCM_BYTES = 48 * 1024 * 1024;

// 起音探测：归一化能量差 ≥0.22（量化阶梯约 2 格）且落到非噪底帧；
// 400ms 最小间隔防缓坡能量把相邻帧全标成起音（吸附只需每行首一个靶点）
const ONSET_MIN_DELTA = 0.22;
const ONSET_MIN_LEVEL = 0.15;
const ONSET_MIN_GAP_MS = 400;

// 吸附窗 ±600ms：LLM 指对区段即可，行首一定落在起音附近是物理先验
const SNAP_WINDOW_MS = 600;
// 行距下限：吸附后强制单调时后行 ≥ 前行+200ms（LRC 行间隔现实下界）
const MIN_LINE_GAP_MS = 200;

// 人声段阈值/合并/最短段：能量 ≥0.22 为「在唱」；≤1.5s 的静默当作句间
// 换气/间奏小缝合并；<800ms 的能量段容不下一行词，判为打击乐噪声丢弃
const SEG_MIN_LEVEL = 0.22;
const SEG_MERGE_GAP_MS = 1500;
const SEG_MIN_MS = 800;

// LLM 分块：60 行/块与翻译链的 40 行/块同思路——长歌词防单次输出截断；
// 块间靠 startHintMs（上一块已对齐的末行时刻）衔接，不重叠送行。
// 单调时间闸同 TRANSLATE_DEADLINE_MS 思路：到点不再开新块，整曲降级
const ALIGN_CHUNK = 60;
const ALIGN_DEADLINE_MS = 240000;
const LLM_TIMEOUT_MS = 60000;
// 起音表进 prompt 的上限——超长音频按步长抽稀，保住 token 预算
const PROMPT_MAX_ONSETS = 1200;
// 包络串进 prompt 的字符上限：200ms/帧下 50min 曲 ≈15k 字符逼近模型上下
// 文——超限按步长抽稀，frameMs 同步放大保住「第 i 字符 = i*frameMs」语义
const PROMPT_MAX_ENVELOPE_CHARS = 8000;

// ── PCM → 帧能量 ─────────────────────────────────────────────────────────
// pcm 为 s16le 单声道字节流。返回 energies（每帧 RMS 归一化到全曲峰值，
// 区间 [0,1]）与真实 durationMs（按字节数算，含不足一帧的尾巴）
function pcmToEnergies(pcm, { frameMs = FRAME_MS, sampleRate = SAMPLE_RATE } = {}) {
  const durationMs = Math.round(pcm.length / 2 / sampleRate * 1000);
  const samplesPerFrame = Math.floor(sampleRate * frameMs / 1000);
  const bytesPerFrame = samplesPerFrame * 2;
  const frameCount = Math.floor(pcm.length / bytesPerFrame);
  const energies = new Array(frameCount).fill(0);
  if (!frameCount) return { energies, durationMs };
  const rms = new Float64Array(frameCount);
  let peak = 0;
  for (let f = 0; f < frameCount; f++) {
    let sum = 0;
    const base = f * bytesPerFrame;
    for (let i = 0; i < bytesPerFrame; i += 2) {
      const s = pcm.readInt16LE(base + i);
      sum += s * s;
    }
    rms[f] = Math.sqrt(sum / samplesPerFrame);
    if (rms[f] > peak) peak = rms[f];
  }
  // 峰值归一化而非固定 dB 标尺：安静录音与大响度压限曲在同一张 0-9 表上
  for (let f = 0; f < frameCount; f++) energies[f] = peak > 0 ? rms[f] / peak : 0;
  return { energies, durationMs };
}

// 0-9 单字符量化——LLM 可读的包络字符流（'0012335678999…'）
function quantizeEnvelope(energies) {
  let out = '';
  for (const e of energies) out += Math.min(9, Math.max(0, Math.round(e * 9)));
  return out;
}

// ── 起音/人声段探测 ──────────────────────────────────────────────────────
function detectOnsets(energies, {
  frameMs = FRAME_MS, minDelta = ONSET_MIN_DELTA,
  minLevel = ONSET_MIN_LEVEL, minGapMs = ONSET_MIN_GAP_MS,
} = {}) {
  const onsets = [];
  let last = -Infinity;
  for (let i = 1; i < energies.length; i++) {
    if (energies[i] < minLevel) continue;
    if (energies[i] - energies[i - 1] < minDelta) continue;
    const t = i * frameMs;
    if (t - last < minGapMs) continue; // 一帧最多一个 onset；缓坡不重复计
    onsets.push(t);
    last = t;
  }
  return onsets;
}

function detectVocalSegments(energies, {
  frameMs = FRAME_MS, level = SEG_MIN_LEVEL,
  mergeGapMs = SEG_MERGE_GAP_MS, minSegMs = SEG_MIN_MS,
} = {}) {
  const raw = [];
  let start = -1;
  for (let i = 0; i < energies.length; i++) {
    if (energies[i] >= level) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      raw.push([start, i]);
      start = -1;
    }
  }
  if (start >= 0) raw.push([start, energies.length]);
  // 缝合小缝（句间停顿/呼吸），再丢弃短段（鼓点/拨弦类孤立能量峰）
  const merged = [];
  for (const [s, e] of raw) {
    const prev = merged[merged.length - 1];
    if (prev && (s - prev[1]) * frameMs <= mergeGapMs) prev[1] = e;
    else merged.push([s, e]);
  }
  return merged
    .filter(([s, e]) => (e - s) * frameMs >= minSegMs)
    .map(([s, e]) => ({ startMs: s * frameMs, endMs: e * frameMs }));
}

// ── 吸附与单调钳位 ───────────────────────────────────────────────────────
// 每行吸附到 ±windowMs 内最近 onset；窗内无 onset 的行保留原值。
// 返回 {times, snapped}——snapped 计数给 confidenceHint 参考
function snapToOnsets(times, onsets, windowMs = SNAP_WINDOW_MS) {
  let snapped = 0;
  const out = times.map((t) => {
    // 二分下界：onsets 已按升序（detectOnsets 产出单调序列）
    let lo = 0;
    let hi = onsets.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (onsets[m] < t) lo = m + 1; else hi = m;
    }
    let best = null;
    let bestD = Infinity;
    for (const j of [lo - 1, lo]) { // 最近 onset 只会是下界或其左邻
      if (j < 0 || j >= onsets.length) continue;
      const d = Math.abs(onsets[j] - t);
      if (d <= windowMs && d < bestD) { best = onsets[j]; bestD = d; }
    }
    if (best !== null) { snapped++; return best; }
    return t;
  });
  return { times: out, snapped };
}

// 后行 ≥ 前行 + minGapMs；同时不超 maxMs（收尾行撞到时长上限时并允许
// 持平——保持「单调不减」语义，不为满足行距把行推出音频外）
function enforceMonotonic(times, { minGapMs = MIN_LINE_GAP_MS, maxMs } = {}) {
  const out = new Array(times.length);
  let prev = null;
  for (let i = 0; i < times.length; i++) {
    let t = Number.isFinite(times[i]) ? Math.round(times[i]) : (prev ?? 0);
    if (prev !== null) t = Math.max(t, prev + minGapMs);
    if (Number.isFinite(maxMs)) t = Math.min(t, maxMs);
    out[i] = t;
    prev = t;
  }
  return out;
}

// ── 无 AI 降级：按行字符数加权把各行铺进人声段 ──────────────────────────
// 段间跳行自然成立（上一段铺满才进下一段）；段内行距按字符数比例分——
// 长行唱得久是普遍先验
function heuristicTimes({ lines, energies, frameMs = FRAME_MS, durationMs }) {
  const n = lines.length;
  if (!n) return [];
  const segs = detectVocalSegments(energies, { frameMs });
  const totalSegMs = segs.reduce((s, g) => s + (g.endMs - g.startMs), 0);
  const weights = lines.map(l => Math.max(1, String(l ?? '').trim().length));
  const totalW = weights.reduce((a, b) => a + b, 0);
  const out = new Array(n);
  // 全曲探不出人声段（纯噪/阈值全灭）→ 均匀铺满全程的保底轴
  if (!segs.length || totalSegMs <= 0 || totalW <= 0) {
    for (let i = 0; i < n; i++) out[i] = Math.round(durationMs * i / n);
    return out;
  }
  let cum = 0;
  let segIdx = 0;
  let segCum = 0; // 当前段之前的累计有声时长
  for (let i = 0; i < n; i++) {
    // 行首落在「字符累计权重占比 × 有声总时长」对应的段内位置
    const target = (cum / totalW) * totalSegMs;
    while (segIdx < segs.length - 1
      && target >= segCum + (segs[segIdx].endMs - segs[segIdx].startMs)) {
      segCum += segs[segIdx].endMs - segs[segIdx].startMs;
      segIdx++;
    }
    out[i] = Math.round(segs[segIdx].startMs + Math.max(0, target - segCum));
    cum += weights[i];
  }
  return out;
}

// ── LLM 响应校验：长度/单调/范围三件套，违例拒收（调用方重试或降级）─────
// 兼容 {times:[...]} 与裸数组两种回包
function normalizeLlmTimes(raw, count, durationMs) {
  const arr = Array.isArray(raw) ? raw : raw?.times;
  if (!Array.isArray(arr) || arr.length !== count) return null;
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    const t = Number(arr[i]);
    if (!Number.isFinite(t)) return null;
    out[i] = Math.round(t);
  }
  for (let i = 0; i < count; i++) {
    if (out[i] < 0 || out[i] > durationMs) return null;
    if (i > 0 && out[i] < out[i - 1]) return null;
  }
  return out;
}

const ALIGN_SYSTEM = '你是歌词时间轴对齐器。输入 JSON：durationMs=音频总时长(ms)；'
  + 'frameMs=能量帧宽；envelope=字符串，第 i 个字符是 [i*frameMs,(i+1)*frameMs) '
  + '区间的人声能量级 0-9（0≈无人声/间奏，9=全曲峰值）；onsets=起音点毫秒表'
  + '（能量突升位置，歌词行首通常落在附近）；lines=按序歌词行；'
  + 'startHintMs=上一块已对齐到的位置，本块首行不得早于它。'
  + '只输出 JSON {"times":[t0,t1,...]}：times 与 lines 等长、单调不减、'
  + '每项是行首毫秒且 ∈[0,durationMs]。'
  + '规则：能量为 0/低的长段是前奏/间奏/尾奏——不要把行塞进去；'
  + '行首尽量贴近最近的起音点；相邻行间隔通常 ≥1 秒；'
  + '拿不准时把剩余行在剩余有声段内按行数均摊。';

async function llmAlignTimes({ envelope, onsets, durationMs, frameMs, lines, signal }) {
  const startedAt = Date.now();
  // 起音表抽稀进 prompt：密度越高位置越糙时少报几个也比截断尾部强
  const promptOnsets = onsets.length <= PROMPT_MAX_ONSETS
    ? onsets
    : onsets.filter((_, i) => i % Math.ceil(onsets.length / PROMPT_MAX_ONSETS) === 0);
  // 包络同法抽稀：抽稀后每字符代表 envStep 帧——frameMs 必须同步放大，
  // 否则模型把字符序号乘错时间基（位置全部偏早）
  const envStep = Math.max(1, Math.ceil(String(envelope).length / PROMPT_MAX_ENVELOPE_CHARS));
  const promptEnvelope = envStep === 1 ? envelope
    : [...envelope].filter((_, i) => i % envStep === 0).join('');
  const promptFrameMs = frameMs * envStep;
  const all = [];
  for (let off = 0; off < lines.length && Date.now() - startedAt < ALIGN_DEADLINE_MS;
    off += ALIGN_CHUNK) {
    if (signal?.aborted) return null;
    const chunk = lines.slice(off, off + ALIGN_CHUNK);
    const startHintMs = all.length ? all[all.length - 1] : 0;
    let times = null;
    // 违例重试一次：模型偶发少行/乱序，重抽一次大概率自愈；
    // 两次都坏说明本块模型抓不住结构——整曲交回启发式，不产混源轴
    for (let attempt = 0; attempt < 2 && times === null; attempt++) {
      const ans = await askAiJson({
        system: ALIGN_SYSTEM,
        user: JSON.stringify({
          durationMs, frameMs: promptFrameMs, envelope: promptEnvelope,
          onsets: promptOnsets, startHintMs, lines: chunk,
        }),
        maxTokens: Math.min(8192, chunk.length * 24 + 512),
        timeoutMs: LLM_TIMEOUT_MS,
        signal,
      });
      if (signal?.aborted) return null;
      times = normalizeLlmTimes(ans, chunk.length, durationMs);
    }
    if (times === null) return null;
    all.push(...times);
  }
  return all.length === lines.length ? all : null;
}

// ── LRC 产出 ─────────────────────────────────────────────────────────────
// 行文本净化与 routes/ai.js 翻译净化同口径（共享 cleanLrcLineText）：
// 剥换行、成对/落单方括号（会把幻影时间戳带进 LRC）、Cf 格式字符——
// 歌词行是 UGC 不可信输入
const cleanLine = cleanLrcLineText;

function msToLrcTag(ms) {
  const t = Math.max(0, Math.round(ms));
  const mm = Math.floor(t / 60000);
  const ss = Math.floor((t % 60000) / 1000);
  const xx = Math.floor((t % 1000) / 10);
  return `[${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(xx).padStart(2, '0')}]`;
}

function buildLrc(lines, times) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const text = cleanLine(lines[i]);
    if (!text) continue; // 净化后空行不带时间戳进产物（tag 孤儿行无意义）
    out.push(`${msToLrcTag(times[i])}${text}`);
  }
  return out.join('\n');
}

// ── ffmpeg 包络提取（spawn 风格照 file-downloader 的 ffmpegMux 口径）─────
// stderr 收尾留错尾、按输入体量伸缩的超时杀、signal abort 杀、半截不留
const FFMPEG_OK = (() => {
  try {
    const ok = spawnSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' }).status === 0;
    if (!ok) console.warn('[lyric-align] 未检测到 ffmpeg——歌词时间轴对齐不可用');
    return ok;
  } catch {
    console.warn('[lyric-align] 未检测到 ffmpeg——歌词时间轴对齐不可用');
    return false;
  }
})();

function ffmpegPcm(audioPath, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const e = new Error('已取消');
      e.aborted = true;
      return reject(e);
    }
    const child = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', audioPath,
      // 人声带通 300-3400Hz 削弱伴奏遮蔽。设计稿的 bandpass=f=300:h=3400
      // 写法在 ffmpeg 实测报「Option not found」——bandpass 的 h 是
      // width_type 枚举常量名（Hz）而非高截止频率；HP+LP 级联等价且显式
      '-af', 'highpass=f=300,lowpass=f=3400',
      '-ar', String(SAMPLE_RATE), '-ac', '1', '-f', 's16le', '-',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let errTail = '';
    child.stderr.on('data', d => { errTail = (errTail + d).slice(-500); });
    child.stderr.on('error', () => { /* 管道级错误不入错尾，但必须挂监听 */ });
    const chunks = [];
    let pcmBytes = 0;
    let overflow = false;
    child.stdout.on('data', (d) => {
      pcmBytes += d.length;
      if (pcmBytes > MAX_PCM_BYTES) {
        // 超长音频不再收——kill 走 close 分支统一报错
        overflow = true;
        try { child.kill('SIGKILL'); } catch { /* 进程已退 */ }
        return;
      }
      chunks.push(d);
    });
    child.stdout.on('error', () => { /* 同上 */ });
    // 与 ffmpegMux 同口径：按输入体量 25MiB/s 等效速率伸缩超时，
    // 慢盘/大文件不被固定超时误杀
    let inputBytes = 0;
    try { inputBytes = fs.statSync(audioPath).size; } catch { /* 0 按最小超时 */ }
    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* 进程已退 */ }
    }, 120000 + Math.ceil(inputBytes / (25 * 1024 * 1024)) * 1000);
    const onAbort = () => { try { child.kill('SIGKILL'); } catch { /* 进程已退 */ } };
    signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
    };
    child.on('error', (e) => {
      cleanup();
      reject(e); // spawn 级失败（ENOENT 等）原样上抛，路由层统一映射
    });
    child.on('close', (code, killedBy) => {
      cleanup();
      if (signal?.aborted) {
        const e = new Error('已取消');
        e.aborted = true;
        return reject(e);
      }
      if (overflow) return reject(new Error('音频时长超出对齐上限'));
      if (code !== 0) {
        const why = timedOut ? '超时被 SIGKILL'
          : killedBy ? `被${killedBy}杀（外部信号）` : `exit ${code}`;
        return reject(new Error(`ffmpeg 解 PCM 失败（${why}）: ${errTail || '无输出'}`));
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

// audioPath → {durationMs, frameMs, energies, envelope, onsets}
async function extractEnvelope(audioPath, { signal } = {}) {
  if (!FFMPEG_OK) throw new Error('ffmpeg 不可用，无法分析音频');
  const pcm = await ffmpegPcm(audioPath, signal);
  const { energies, durationMs } = pcmToEnergies(pcm);
  if (!energies.length) throw new Error('音频过短或无法解码');
  return {
    durationMs,
    frameMs: FRAME_MS,
    energies,
    envelope: quantizeEnvelope(energies),
    onsets: detectOnsets(energies),
  };
}

// ── 对齐编排 ─────────────────────────────────────────────────────────────
// env 预取后的对齐段单独导出：测试可用合成 env 驱动全链（不依赖 ffmpeg）
async function alignWithEnvelope({ env, lines, signal }) {
  const { durationMs, frameMs, energies, envelope, onsets } = env;
  let times = null;
  if (aiEnabled()) {
    times = await llmAlignTimes({ envelope, onsets, durationMs, frameMs, lines, signal });
  }
  const alignedBy = times ? 'llm' : 'heuristic';
  if (!times) times = heuristicTimes({ lines, energies, frameMs, durationMs });
  // 吸附在单调钳位之前：先各自贴最近起音，再用行距下限把塌掉的撑开
  const snapped = snapToOnsets(times, onsets);
  const final = enforceMonotonic(snapped.times, { maxMs: durationMs });
  return {
    times: final,
    alignedBy,
    snappedRatio: lines.length ? Math.round(snapped.snapped / lines.length * 100) / 100 : 0,
    lrc: buildLrc(lines, final),
    durationMs,
  };
}

// 端到端：音频路径 → LRC。alignedBy='llm'|'heuristic' 供上游甄别质量档；
// confidenceHint 是人工可读档（LLM 对齐仍是粗粒度，不给 high）
async function alignAudioToLrc({ audioPath, lines, signal }) {
  const env = await extractEnvelope(audioPath, { signal });
  const r = await alignWithEnvelope({ env, lines, signal });
  return {
    ...r,
    confidenceHint: r.alignedBy === 'llm' ? 'medium' : 'low',
  };
}

module.exports = {
  FRAME_MS,
  SAMPLE_RATE,
  SNAP_WINDOW_MS,
  MIN_LINE_GAP_MS,
  pcmToEnergies,
  quantizeEnvelope,
  detectOnsets,
  detectVocalSegments,
  snapToOnsets,
  enforceMonotonic,
  heuristicTimes,
  normalizeLlmTimes,
  msToLrcTag,
  buildLrc,
  extractEnvelope,
  alignWithEnvelope,
  alignAudioToLrc,
};

// lyric-align 服务核心用例：PCM→包络量化、起音/人声段探测、snap-to-onset、
// 单调钳位、启发式降级铺轴、LLM 回包校验与重试降级、LRC 产出形态。
// 纯函数段零外部依赖；ffmpeg 集成段在没有 ffmpeg 的环境自动跳过。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seed } from './helpers.mjs';

const require = createRequire(import.meta.url);

// AI 客户端桩：aiEnabled/askAiJson 全程可控，调用记录可观测
let aiOn = false;
let aiAnswer = null;
const aiCalls = [];
seed('../src/server/lib/ai.js', {
  aiEnabled: () => aiOn,
  aiModel: () => 'test-model',
  askAiJson: async (a) => {
    aiCalls.push(a);
    return typeof aiAnswer === 'function' ? aiAnswer(a) : aiAnswer;
  },
});

const svc = require('../src/server/services/lyric-align.js');

// ── 工具：合成 PCM s16le（frameMs=200、8kHz → 1600 样本/帧）──────────────
// levels: 每帧的振幅档（0=静音，1≈满幅正弦）→ 返回 Buffer
function synthPcm(levels, { sampleRate = 8000, frameMs = 200, freq = 1000 } = {}) {
  const per = Math.floor(sampleRate * frameMs / 1000);
  const buf = Buffer.alloc(levels.length * per * 2);
  for (let f = 0; f < levels.length; f++) {
    const amp = Math.round(30000 * levels[f]);
    for (let i = 0; i < per; i++) {
      const s = Math.round(amp * Math.sin(2 * Math.PI * freq * i / sampleRate));
      buf.writeInt16LE(Math.max(-32768, Math.min(32767, s)), (f * per + i) * 2);
    }
  }
  return buf;
}

const env = (energies, extra = {}) => ({
  durationMs: energies.length * 200,
  frameMs: 200,
  energies,
  envelope: svc.quantizeEnvelope(energies),
  onsets: svc.detectOnsets(energies),
  ...extra,
});

before(() => { aiOn = false; aiAnswer = null; aiCalls.length = 0; });

// ── PCM → 包络量化 ───────────────────────────────────────────────────────

test('包络量化：静音段=0、脉冲段=9，帧数与 PCM 长度吻合', () => {
  const pcm = synthPcm([...Array(10).fill(0), ...Array(10).fill(1)]);
  const { energies, durationMs } = svc.pcmToEnergies(pcm);
  assert.equal(energies.length, 20);
  assert.equal(durationMs, 4000); // 20 帧 × 200ms
  const e = svc.quantizeEnvelope(energies);
  assert.equal(e.length, 20);
  assert.equal(e.slice(0, 10), '0000000000');
  assert.equal(e.slice(10), '9999999999'); // 唯一峰值帧族 → 归一化=1 → '9'
});

test('包络量化：半截尾巴不计帧但计入 durationMs；全静默产全零串', () => {
  const pcm = synthPcm(Array(5).fill(0)); // 5 帧 = 16000B
  const tailed = Buffer.concat([pcm, Buffer.alloc(1600)]); // +800 样本 = 0.5 帧
  const { energies, durationMs } = svc.pcmToEnergies(tailed);
  assert.equal(energies.length, 5); // 尾巴不足一帧不产帧
  assert.equal(durationMs, 1100); // 17600B/2/8000 = 1.1s——尾巴仍计入真实时长
  assert.equal(svc.quantizeEnvelope(energies), '00000');
});

test('包络量化：渐变能量产中间档位（0-9 单调映射）', () => {
  const pcm = synthPcm([0, 0.5, 1]);
  const { energies } = svc.pcmToEnergies(pcm);
  const e = svc.quantizeEnvelope(energies);
  // 半幅 RMS≈峰值一半 → 四舍五入 4-5 档；峰值帧恒 '9'
  assert.equal(e[0], '0');
  assert.ok(['4', '5'].includes(e[1]), `半幅应落 4-5 档，实际 ${e[1]}`);
  assert.equal(e[2], '9');
});

// ── 起音与人声段 ─────────────────────────────────────────────────────────

test('detectOnsets：能量突升帧标起音，时间=帧首 ms；minGap 防连帧重复', () => {
  const energies = [...Array(5).fill(0), ...Array(5).fill(0.9), 0.3, ...Array(4).fill(0.9)];
  const onsets = svc.detectOnsets(energies, { minGapMs: 400 });
  // 帧 5（1000ms）第一次突升必中；帧 11（2200ms）0.9-0.3=0.6>0.22 也中
  assert.deepEqual(onsets, [1000, 2200]);
  // minGap 收紧到 0：连帧缓升每帧都计
  const dense = svc.detectOnsets([0, 0.3, 0.55, 0.8], { minGapMs: 0 });
  assert.deepEqual(dense, [200, 400, 600]);
});

test('detectOnsets：噪底微涨不计（minLevel 拦截）', () => {
  const onsets = svc.detectOnsets([0, 0.1, 0.14, 0.9]);
  assert.deepEqual(onsets, [600]); // 仅帧3的 0.14→0.9
});

test('detectVocalSegments：小缝合并成段、大缝切段、短段丢弃', () => {
  // 帧 10-20 有声，帧 21-25 静（1s 小缝<1.5s 合并），帧 26-40 有声 → 一整段
  const e1 = [
    ...Array(10).fill(0), ...Array(11).fill(0.8), ...Array(5).fill(0),
    ...Array(15).fill(0.8), ...Array(9).fill(0),
  ];
  const segs = svc.detectVocalSegments(e1);
  assert.deepEqual(segs, [{ startMs: 2000, endMs: 8200 }]);
  // 大缝 3s >1.5s → 两段；尾段只有 3 帧(600ms)<800ms → 丢弃
  const e2 = [
    ...Array(10).fill(0), ...Array(10).fill(0.8), ...Array(15).fill(0),
    ...Array(10).fill(0.8), ...Array(20).fill(0), ...Array(3).fill(0.8),
  ];
  const segs2 = svc.detectVocalSegments(e2);
  assert.deepEqual(segs2, [{ startMs: 2000, endMs: 4000 }, { startMs: 7000, endMs: 9000 }]);
});

// ── snap-to-onset 与单调钳位 ─────────────────────────────────────────────

test('snapToOnsets：±600ms 内吸附最近 onset，窗外原样保留', () => {
  const onsets = [1000, 5000];
  const { times, snapped } = svc.snapToOnsets([1400, 5500, 9000], onsets);
  assert.deepEqual(times, [1000, 5000, 9000]); // 1400→1000、5500→5000、9000 窗外
  assert.equal(snapped, 2);
  // 等距取近邻之一（1300 距 1000/1600 各 300/300——断言落到其一即可）
  const r2 = svc.snapToOnsets([1300], [1000, 1600]);
  assert.ok(r2.times[0] === 1000 || r2.times[0] === 1600);
});

test('enforceMonotonic：行距钳到 +200ms，越界行压回 durationMs', () => {
  assert.deepEqual(svc.enforceMonotonic([100, 150, 5000]), [100, 300, 5000]);
  // 末行超 durationMs 压回上限——可能撞平前行（单调不减允许持平）
  assert.deepEqual(svc.enforceMonotonic([100, 300, 5000], { maxMs: 2000 }), [100, 300, 2000]);
  assert.deepEqual(svc.enforceMonotonic([], { maxMs: 2000 }), []);
});

// ── 启发式降级铺轴 ───────────────────────────────────────────────────────

test('heuristic：行按字符权重铺进人声段，首行贴段首', () => {
  const energies = [...Array(10).fill(0), ...Array(20).fill(0.9), ...Array(20).fill(0)];
  // 段 {2000,6000} 长 4000ms；行权重 4/2/8 → 位置 0/4/6 份
  const times = svc.heuristicTimes({
    lines: ['aaaa', 'bb', 'cccccccc'], energies, durationMs: 10000,
  });
  assert.deepEqual(times, [2000, Math.round(2000 + 4 / 14 * 4000), Math.round(2000 + 6 / 14 * 4000)]);
});

test('heuristic：段间跳行（第二段第一行落在段首区）', () => {
  const energies = [
    ...Array(10).fill(0), ...Array(10).fill(0.9), ...Array(15).fill(0),
    ...Array(10).fill(0.9), ...Array(5).fill(0),
  ];
  // 两段各 2000ms 等长 → 权重各占一半的两行应分别落两段首
  const times = svc.heuristicTimes({
    lines: ['aa', 'bb'], energies, durationMs: 10000,
  });
  assert.equal(times[0], 2000);
  assert.equal(times[1], 7000); // 第二段帧 35 起 = 7000ms
});

test('heuristic：全静默无人声段 → 均匀铺满全程且单调', () => {
  const times = svc.heuristicTimes({
    lines: ['a', 'b', 'c'], energies: Array(20).fill(0), durationMs: 4000,
  });
  assert.deepEqual(times, [0, 1333, 2667]);
  const mono = svc.enforceMonotonic(times, { maxMs: 4000 });
  assert.deepEqual(mono, [0, 1333, 2667]); // 已单调不塌
});

// ── LLM 回包校验 ─────────────────────────────────────────────────────────

test('normalizeLlmTimes：长度错/非数/乱序/越界一律拒收', () => {
  const ok = svc.normalizeLlmTimes({ times: [0, 1000, 2000] }, 3, 10000);
  assert.deepEqual(ok, [0, 1000, 2000]);
  assert.equal(svc.normalizeLlmTimes({ times: [0, 1000] }, 3, 10000), null); // 短
  assert.equal(svc.normalizeLlmTimes({ times: [0, 'x', 2000] }, 3, 10000), null); // 非数
  assert.equal(svc.normalizeLlmTimes({ times: [0, 3000, 2000] }, 3, 10000), null); // 乱序
  assert.equal(svc.normalizeLlmTimes({ times: [0, 1000, 99999] }, 3, 10000), null); // 越界
  assert.equal(svc.normalizeLlmTimes({ times: [-50, 1000, 2000] }, 3, 10000), null); // 负
  assert.equal(svc.normalizeLlmTimes([0, 1000, 2000], 3, 10000) !== null, true); // 裸数组兼容
  assert.equal(svc.normalizeLlmTimes({}, 3, 10000), null);
});

// ── LRC 产出 ─────────────────────────────────────────────────────────────

test('buildLrc：[mm:ss.xx] 形态 + 行文本净化（方括号/换行/Cf 剥光）', () => {
  const lrc = svc.buildLrc(
    ['第一句', '带[00:99.00]幻影戳', '换行\n进来'],
    [0, 61500, 122999],
  );
  const rows = lrc.split('\n');
  assert.equal(rows[0], '[00:00.00]第一句');
  assert.equal(rows[1], '[01:01.50]带 幻影戳');
  assert.equal(rows[2], '[02:02.99]换行 进来');
  // 净化后全空的行不产 tag 孤儿
  assert.equal(svc.buildLrc(['[[[]]'], [0]), '');
});

test('msToLrcTag：分钟/秒/厘秒位补齐，负值钳 0', () => {
  assert.equal(svc.msToLrcTag(0), '[00:00.00]');
  assert.equal(svc.msToLrcTag(75432), '[01:15.43]');
  assert.equal(svc.msToLrcTag(-100), '[00:00.00]');
});

// ── alignWithEnvelope 编排（桩 AI）───────────────────────────────────────

test('编排：LLM 给轴 → alignedBy=llm，吸附 onset 后产 LRC', async () => {
  aiOn = true;
  const energies = [...Array(10).fill(0), ...Array(30).fill(0.9), ...Array(10).fill(0)];
  aiAnswer = { times: [2400, 5200] };
  const r = await svc.alignWithEnvelope({ env: env(energies), lines: ['行一', '行二'] });
  assert.equal(r.alignedBy, 'llm');
  assert.equal(r.confidenceHint, undefined); // confidenceHint 只在端到端层拼
  // 2400 距 onset(2000)=400≤600 → 吸到 2000；5200 无近邻 onset 保留
  assert.equal(r.lrc, '[00:02.00]行一\n[00:05.20]行二');
  assert.equal(r.snappedRatio, 0.5);
  // 桩收到完整包络+起音表+行
  const sent = JSON.parse(aiCalls.at(-1).user);
  assert.equal(sent.durationMs, 10000);
  assert.equal(sent.frameMs, 200);
  assert.equal(sent.envelope.length, 50);
  assert.ok(Array.isArray(sent.onsets) && sent.onsets.includes(2000));
  assert.deepEqual(sent.lines, ['行一', '行二']);
});

test('编排：AI 关 → heuristic 降级，轴仍单调且在时长内', async () => {
  aiOn = false;
  const energies = [...Array(10).fill(0), ...Array(20).fill(0.9), ...Array(10).fill(0)];
  const beforeCalls = aiCalls.length;
  const r = await svc.alignWithEnvelope({ env: env(energies), lines: ['a', 'bb', 'ccc'] });
  assert.equal(r.alignedBy, 'heuristic');
  assert.equal(aiCalls.length, beforeCalls, 'AI 关闭不该发起调用');
  assert.ok(r.times[0] <= r.times[1] && r.times[1] <= r.times[2]);
  assert.ok(r.times.every(t => t >= 0 && t <= 8000));
  assert.match(r.lrc, /^\[00:0[24]\.\d{2}\]a\n/); // 首行应铺在人声段附近
});

test('编排：LLM 回包违例 → 重试一次仍坏 → 整曲降级 heuristic', async () => {
  aiOn = true;
  const energies = [...Array(10).fill(0), ...Array(20).fill(0.9), ...Array(10).fill(0)];
  // 第一次长度错、第二次乱序——两次机会耗尽
  let n = 0;
  aiAnswer = () => (++n === 1 ? { times: [1000] } : { times: [5000, 3000] });
  const before = aiCalls.length;
  const r = await svc.alignWithEnvelope({ env: env(energies), lines: ['a', 'b'] });
  assert.equal(aiCalls.length - before, 2, '违例只重试一次');
  assert.equal(r.alignedBy, 'heuristic');
  aiAnswer = null;
});

test('编排：LLM 首试坏二试好 → 用二试结果（不重抽第三次）', async () => {
  aiOn = true;
  const energies = [...Array(10).fill(0), ...Array(20).fill(0.9), ...Array(10).fill(0)];
  let n = 0;
  aiAnswer = () => (++n === 1 ? null : { times: [2200, 4400] });
  const r = await svc.alignWithEnvelope({ env: env(energies), lines: ['a', 'b'] });
  assert.equal(r.alignedBy, 'llm');
  assert.deepEqual(r.times, [2000, 4400]); // 2200 吸附 onset 2000
  aiAnswer = null;
});

test('编排：长曲包络超 prompt 上限 → 抽稀进模型且 frameMs 同步放大', async () => {
  aiOn = true;
  // 9000 帧包络（30min）→ 步长 2 抽稀到 4500 字符；frameMs 200→400 保时间基
  const energies = Array(9000).fill(0.8);
  const sent = [];
  aiAnswer = (a) => { sent.push(JSON.parse(a.user)); return { times: [400, 800] }; };
  await svc.alignWithEnvelope({ env: env(energies), lines: ['a', 'b'] });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].frameMs, 400);
  assert.ok(sent[0].envelope.length <= 8000 && sent[0].envelope.length >= 4400,
    `包络应抽稀到 8000 内，实际 ${sent[0].envelope.length}`);
  assert.equal(sent[0].durationMs, 1800000);
  aiAnswer = null;
  // 短曲不抽稀：frameMs 原样透传
  aiAnswer = (a) => { sent.push(JSON.parse(a.user)); return { times: [0, 200] }; };
  sent.length = 0;
  const short = [...Array(10).fill(0), ...Array(20).fill(0.9), ...Array(10).fill(0)];
  await svc.alignWithEnvelope({ env: env(short), lines: ['x', 'y'] });
  assert.equal(sent[0].frameMs, 200);
  assert.equal(sent[0].envelope.length, 40);
  aiAnswer = null;
});

test('编排：>60 行分块对齐，块间 startHintMs 衔接', async () => {
  aiOn = true;
  const energies = [...Array(10).fill(0), ...Array(80).fill(0.85), ...Array(10).fill(0)];
  const lines = Array.from({ length: 130 }, (_, i) => `行${i}`);
  const hints = [];
  aiAnswer = (a) => {
    const u = JSON.parse(a.user);
    hints.push(u.startHintMs);
    return { times: u.lines.map((_, i) => u.startHintMs + (i + 1) * 100) };
  };
  const r = await svc.alignWithEnvelope({ env: env(energies), lines });
  assert.equal(r.alignedBy, 'llm');
  assert.equal(hints.length, 3, '130 行 = 3 块（60+60+10）');
  assert.equal(hints[0], 0);
  assert.ok(hints[1] > 0 && hints[2] > hints[1], '块间 hint 应递进');
  assert.equal(r.times.length, 130);
  aiAnswer = null;
});

// ── ffmpeg 集成（无 ffmpeg 环境自动跳过）─────────────────────────────────

const FFMPEG_OK = (() => {
  try {
    const { spawnSync } = require('child_process');
    return spawnSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' }).status === 0;
  } catch { return false; }
})();

function wavOf(samples, sampleRate = 8000) {
  const data = samples.length * 2;
  const buf = Buffer.alloc(44 + data);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + data, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(data, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], 44 + i * 2);
  return buf;
}

test('extractEnvelope：真 ffmpeg 解 wav → 包络帧数/起音位置正确', async (t) => {
  if (!FFMPEG_OK) return t.skip('环境无 ffmpeg');
  const dir = mkdtempSync(join(tmpdir(), 'meowsync-lalign-ff-'));
  try {
    // 5s：0-1s 静音，1-2.6s 1kHz 音（带通内），2.6-3s 静，3-4.6s 音，4.6-5s 静
    const sr = 8000;
    const samples = new Array(5 * sr).fill(0);
    for (const [a, b] of [[1.0, 2.6], [3.0, 4.6]]) {
      for (let i = Math.floor(a * sr); i < Math.floor(b * sr); i++) {
        samples[i] = Math.round(12000 * Math.sin(2 * Math.PI * 1000 * i / sr));
      }
    }
    const wav = join(dir, 'tone.wav');
    writeFileSync(wav, wavOf(samples));
    const out = await svc.extractEnvelope(wav);
    assert.equal(out.frameMs, 200);
    assert.ok(Math.abs(out.durationMs - 5000) <= 200, `durationMs=${out.durationMs}`);
    assert.ok(out.envelope.length >= 20 && out.envelope.length <= 30);
    assert.equal(out.envelope[0], '0');
    // 两个音段开头各应有一个起音，滤波器群延迟允许 ±400ms 漂移
    assert.ok(out.onsets.length >= 2, `onsets=${out.onsets}`);
    assert.ok(out.onsets.some(o => Math.abs(o - 1000) <= 400));
    assert.ok(out.onsets.some(o => Math.abs(o - 3000) <= 400));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

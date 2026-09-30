const { callNeteaseApi } = require('../services/netease-api');

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

// candidates 按优先级排（提取名/频道歌手组合 → 清洗标题），逐个云搜；
// 每个候选内两遍优选：歌名包含是最强信号（跨语翻唱同名必中），时长命中
// 取差最小者——顺序「首个过线」会让时长恰好在窗内的噪声压过排后的正主。
// signal：客户端断连/调用方主动作废时早退，不刷无意义的上游云搜
async function matchNeteaseSong(candidates, durationSec, tag = 'import', signal = null) {
  for (const q of candidates) {
    if (!q || signal?.aborted) continue;
    try {
      const res = await callNeteaseApi('cloudsearch', { keywords: q, type: '1', limit: '5' });
      const songs = res.body?.result?.songs;
      if (!Array.isArray(songs) || !songs.length) continue;
      const byName = songs.find(s => shareName(s.name, q));
      if (byName) return { song: byName, query: q };
      // 时长 sanity 只在有真实时长时启用——源时长 0（live/首映/字段缺失）会把
      // ≤45s 的短曲错配（|x-0|≤45 窗口对 0 恒成立的方向性失真）
      if (Number.isFinite(durationSec) && durationSec > 0) {
        const byDur = songs
          .map(s => ({ s, diff: Math.abs((s.dt || s.duration || 0) / 1000 - durationSec) }))
          .filter(x => x.diff <= MATCH_DUR_TOLERANCE_SEC)
          .sort((a, b) => a.diff - b.diff)[0];
        if (byDur) return { song: byDur.s, query: q };
      }
      // 有结果但全不过 sanity：继续试下一个候选，整条候选链不过才算无匹配
    } catch (e) {
      // 上游 reject(answer) 形态无 .message——归一化再记
      const why = e?.message || (e?.body ? `code=${e.body.code ?? '?'}` : String(e));
      console.warn(`[${tag}] 网易云搜索「${q}」失败:`, why);
    }
  }
  return { song: null, query: null };
}

module.exports = { matchNeteaseSong, shareName, MATCH_DUR_TOLERANCE_SEC };

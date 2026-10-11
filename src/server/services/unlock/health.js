// 解锁源健康闸（源级熔断）：某源被反机器人墙/凭据墙整源打瘫时连败到阈盖章
// BREAKER_TTL_MS——期内编排层整源跳过：每次解锁重跑注定失败的完整试错链
// （youtube 每候选 3 形态 × 至多 2 试 + 30s 子预算）既拖长 resolve 又持续
// 给风控喂信号。窗过期自然半开重探，复败复盖（streak 仍在阈上，首败即复盖）。
// 与 lib/youtube.js 的 authFailUntil/AUTH_FAIL_THRESHOLD 同款「连败盖章」
// 口径：只认 authRejected 明确凭据证据——pyncmd 瞬时 5xx/超时永不进账
// （瞬时不该让唯一其余源缺席），单视频会员专享 LOGIN_REQUIRED 单发也不到阈。
// leaf 模块（无 require）：unlock/youtube.js 与 services/netease-api.js 双向
// 消费，放独立文件而非 index.js——测试对 index.js 的 seed 桩不携带本面。
const BREAKER_TTL_MS = 10 * 60e3;
const BREAKER_THRESHOLD = 2;
const BREAKER_REASON = '凭据被拒连败（疑似反机器人墙）';
const streaks = new Map();   // source -> 连续「凭据被拒」计数（成功即清）
const stamped = new Map();   // source -> {until, reason}

const isOpen = (source) => {
  const s = stamped.get(source);
  return !!s && Date.now() < s.until;
};
const breakerReason = (source) => stamped.get(source)?.reason || null;

// 一次「凭据被拒」证据记账：到阈盖章。返回 true = 本次调用触发盖章——
// provider 据此提前终止候选循环（剩余候选继续跑只是给风控喂信号）
const noteAuthRejected = (source) => {
  const n = (streaks.get(source) || 0) + 1;
  streaks.set(source, n);
  if (n >= BREAKER_THRESHOLD && !isOpen(source)) {
    stamped.set(source, { until: Date.now() + BREAKER_TTL_MS, reason: BREAKER_REASON });
    console.warn(`[unlock] ${source} 源熔断 ${Math.round(BREAKER_TTL_MS / 60000)}min：${BREAKER_REASON}`);
    return true;
  }
  return false;
};
// 源一次成功 = 凭据面回春——连败清零。已盖章的不撤销（窗内仍跳过，到期
// 自然半开）；盖章过期后 streak 未清，复败一次即复盖
const noteSourceOk = (source) => { streaks.delete(source); };
// 测试钩：模块级簿跨用例残留会污染断言（_clearOriginalMemo 同款先例）
const _resetForTest = () => { streaks.clear(); stamped.clear(); };

module.exports = {
  isOpen, breakerReason, noteAuthRejected, noteSourceOk, _resetForTest,
  BREAKER_TTL_MS, BREAKER_THRESHOLD, BREAKER_REASON,
};

// token 比较：先 sha256 再 timingSafeEqual——摘要等长，既消除逐字节
// 时序差也避免长度差提前返回。握手/令牌拒绝路径本身对时序不敏感，
// 但该写法成本极低，顺带防御时序侧信道探测
const { createHash, timingSafeEqual } = require('crypto');

function tokenMatches(provided, expected) {
  // 空值对空值绝不命中：sha256('') === sha256('')，不挡空串会让
  // 「expected 未配置 + provided 缺省」的调用静默放行
  if (!provided || !expected) return false;
  const a = createHash('sha256').update(String(provided)).digest();
  const b = createHash('sha256').update(String(expected)).digest();
  return timingSafeEqual(a, b);
}

module.exports = { tokenMatches };

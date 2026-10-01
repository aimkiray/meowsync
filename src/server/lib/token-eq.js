// token 比较：先 sha256 再 timingSafeEqual——摘要等长，既消除逐字节
// 时序差也避免长度差提前返回。握手/令牌拒绝路径本身对时序不敏感，
// 但该写法成本极低，顺带防御时序侧信道探测
const { createHash, timingSafeEqual } = require('crypto');

function tokenMatches(provided, expected) {
  const a = createHash('sha256').update(provided ?? '').digest();
  const b = createHash('sha256').update(expected ?? '').digest();
  return timingSafeEqual(a, b);
}

module.exports = { tokenMatches };

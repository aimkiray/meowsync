// 环境变量单一解析点：同一开关多处解析会随时间漂移（TRUST_PROXY 曾散在
// music.js/rate-limit.js/remote.js 三处各写一遍）。
// 懒读函数形态而非启动快照——进程内改 env 的测试/续期场景不拿陈值。
function trustProxyEnabled() {
  return ['1', 'true'].includes((process.env.TRUST_PROXY || '').toLowerCase());
}

module.exports = { trustProxyEnabled };

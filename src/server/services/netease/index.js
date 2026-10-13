// 自研 NetEase 客户端门面——对外契约对齐旧 apiModules 体系：
// - callNeteaseApi(apiName, params, options) 供网关与进程内消费方调用
// - apiModules 仍导出（routes/music.js 的存在性判定、api-path.js 的首段集）
// 内部实现见 endpoints.js（端点表）/request.js（cookie+envelope）
const { ENDPOINTS } = require('./endpoints');

// apiModules[name] 的 truthy 判定形态不变——值为端点描述对象而非函数
const apiModules = ENDPOINTS;

async function callNeteaseApi(apiName, params, options = {}) {
  // hasOwn 判存在：'constructor'/'__proto__' 等原型键在裸索引下 truthy，
  // 会越过 not found 检查拿 Function 当 ep 崩 500
  if (!Object.hasOwn(ENDPOINTS, apiName)) throw new Error(`API '${apiName}' not found`);
  const ep = ENDPOINTS[apiName];
  // timeoutMs 可覆盖：千曲歌单的 playlist_detail/track_all 慢链路可超 30s
  return ep.handler(params, { timeoutMs: options.timeoutMs, signal: options.signal });
}

module.exports = { callNeteaseApi, apiModules };

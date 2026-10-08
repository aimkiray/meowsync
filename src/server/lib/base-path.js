// 部署子路径（BASE_PATH / VITE_BASE_PATH）单一解析点 + 外发 URL 拼前缀收口。
//
// 契约：服务端对外发的 URL（302 Location、JSON 里回给客户端取数的链）都必须
// 经 withBasePath() 拼回前缀——entryFetch（netease-api-server.js）在 fetch 入口
// 把 ${BASE_PATH}/x 剥成 /x 再交路由，app 内路由/服务一律按根相对路径工作。
// 剥前缀（入口）与拼前缀（外发）吃同一个 env 源才不会漂移——曾各自私有
// normalize 是两份实现互相漂的温床（lib/env.js 头注同款教训）。
// x-forwarded-prefix 故意不支持：本项目模型是「服务端自持 BASE_PATH 做剥/拼」
// （见 entryFetch 注释），不是「反代改写路径」——反代场景 BASE_PATH 与构建期
// VITE_BASE_PATH 同值（compose 透传），采信请求头反而引入伪造面。

// 归一化为 '/x' 形式（无尾斜杠，'/' 表根）：'music/'→'/music'、'/'→'/'、空→'/'
const normalizeBasePath = (v) => {
  const s = String(v || '').trim();
  if (!s || s === '/') return '/';
  const withSlash = s.startsWith('/') ? s : `/${s}`;
  return withSlash.replace(/\/+$/, '') || '/';
};

// 每次调用重读 env 而非模块级快照：normalize 一次就 3 个字符串操作，换得
// 测试里 process.env.BASE_PATH= 直接生效（免 require 缓存 reset）。
// 与 lib/env.js「懒读不拿陈值」同口径
const basePath = () => normalizeBasePath(process.env.BASE_PATH || process.env.VITE_BASE_PATH);

// 给外发的根相对路径补部署前缀：根部署（'/'）恒等返回原串；
// 子路径部署 '/music' + '/audio-proxy/t/x' → '/music/audio-proxy/t/x'
function withBasePath(path) {
  const bp = basePath();
  if (bp === '/') return path;
  // 非 '/' 开头/空串拼出来是 '/musicundefined' 式坏链——告警并原样返回。
  // 调用方契约就是「根相对路径」，这里防的是未来新调用方静默踩雷
  if (typeof path !== 'string' || !path.startsWith('/')) {
    console.warn(`[base-path] withBasePath 收到非根相对路径，原样返回: ${path}`);
    return path;
  }
  return bp + path;
}

module.exports = { normalizeBasePath, basePath, withBasePath };

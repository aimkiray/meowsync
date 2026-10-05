const fs = require('fs');
const path = require('path');

// 加载环境变量
require('dotenv').config();

const { serve } = require('@hono/node-server');
const { serveStatic } = require('@hono/node-server/serve-static');
const { Hono } = require('hono');
const { cors } = require('hono/cors');

const app = new Hono();
// 逐变量校验：API_PORT='abc'（非法但真值）时不应吞掉合法的 PORT；
// 严格纯数字——parseInt 会吞尾部垃圾（'3101abc'→3101、'80.9'→80）
const parsePort = (v) => {
  if (!/^\d{1,5}$/.test(String(v || '').trim())) return null;
  const n = Number(v);
  return n > 0 && n <= 65535 ? n : null;
};
const parsedApiPort = parsePort(process.env.API_PORT);
if (process.env.API_PORT && parsedApiPort === null) {
  // 非法值静默回落到 PORT/默认会让部署者以为端口生效——留痕可观测
  console.warn(`[config] API_PORT='${process.env.API_PORT}' 不是合法端口，已忽略`);
}
const parsedFallbackPort = parsePort(process.env.PORT);
if (parsedApiPort === null && process.env.PORT && parsedFallbackPort === null) {
  console.warn(`[config] PORT='${process.env.PORT}' 不是合法端口，已忽略`);
}
const PORT = parsedApiPort || parsedFallbackPort || 3101;
const HOST = process.env.HOST || '0.0.0.0';

// 解析CORS来源配置（WebSocket Origin 校验共用此白名单）。
// CORS 白名单收敛进 lib/env.js（HTTP cors / WS Origin / auth CSRF 三处共用）
const { corsOrigins: corsOriginsFn } = require('./src/server/lib/env');
const corsOrigins = corsOriginsFn();
// 「这是 API 请求吗」唯一判定源——serveStatic Range 剥离与 SPA 兜底共用
const { isApiPath } = require('./src/server/lib/api-path');

// 子路径部署支持（VITE_BASE_PATH=/music/ 构建后所有资源/API 都在前缀下）。
// 实测：app.basePath() 下 c.req.path 仍返回带前缀的全路径——会让 authGate 的
// isApiPath 公开判定、protectedWrite、SPA 兜底全部失真（API GET 被误判为静态
// 资源 → 鉴权绕过）。故不用 basePath，改在 serve() fetch 入口剥前缀：
// app 内所有中间件/路由/兜底看到的都是根相对路径，零改动兼容。
// 归一化为 '/x' 形式（无尾斜杠，'/' 表根）
const normalizeBasePath = (v) => {
  const s = String(v || '').trim();
  if (!s || s === '/') return '/';
  const withSlash = s.startsWith('/') ? s : `/${s}`;
  return withSlash.replace(/\/+$/, '') || '/';
};
const BASE_PATH = normalizeBasePath(process.env.BASE_PATH || process.env.VITE_BASE_PATH);

// 中间件
app.use('*', cors({
  origin: (origin) => (origin && corsOrigins.includes(origin)) ? origin : null,
  credentials: true,
}));

// 安全响应头（/audio-proxy 响应跳过——它的 ACAO:*/CSP:sandbox 已就位）
const { secureHeaders } = require('./src/server/lib/secure-headers');
app.use('*', secureHeaders());

// 进站大门：users 表为空时全放行（向后兼容局域网无登录部署）。
// session cookie 优先，x-download-token 作为脚本旁路
const { authGate } = require('./src/server/lib/auth-gate');
const { rateLimit } = require('./src/server/lib/rate-limit');
app.use('*', authGate);

// gzip/deflate（CompressionStream，hono/compress 只出这两种）：
// 挂在 authGate 后——401/403 早退小响应不值得压；下游静态文件/SPA fallback/
// API JSON 全覆盖。中间件自带豁免面：206/HEAD/Transfer-Encoding/已编码/
// no-transform/非可压 MIME（audio/woff2/png 等）一律放行，媒体流不受影。
const { compress } = require('hono/compress');
app.use('*', compress());

// 健康检查：/ping 只探活；/healthz 探 DB 写路径（Docker HEALTHCHECK 用它）——
// SELECT 1 是纯内存查询，磁盘满时照样通过；必须在事务里产生真实 WAL 写入，
// 磁盘满/DB 损坏才暴露为 503 而不是"进程活着但功能全挂"
app.get('/ping', (c) => c.json({ ok: true }));
app.get('/healthz', (c) => {
  // 未认证的写探测端点必须限流——每调一次就是一趟 WAL fsync，
  // 裸奔会被刷成 IO 放大型 DoS（SD 卡/廉价 VPS 盘上真实）
  if (!rateLimit(c, 'healthz', 30)) {
    return c.json({ ok: false, message: 'rate limited' }, 429);
  }
  try {
    const db = getDb();
    // 共享连接正在跑别的写事务时 BEGIN IMMEDIATE 会抛嵌套事务错——
    // 此时 DB 显然是活的，误报 503 会造成容器健康检查抖动/幻影重启。
    // 用连接状态预检（而非捕获后回滚）：异常路径里的 ROLLBACK 会误伤
    // 人家在跑的事务
    if (db.inTransaction) return c.json({ ok: true });
    try {
      db.exec('BEGIN IMMEDIATE');
      db.prepare('INSERT INTO _healthz (ts) VALUES (?)').run(Date.now());
      db.exec('DELETE FROM _healthz');
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* 连接已坏 */ }
      throw error;
    }
    return c.json({ ok: true });
  } catch {
    return c.json({ ok: false, message: 'database unavailable' }, 503);
  }
});

// 生产模式：托管前端构建产物
// 注意路由顺序：静态资源优先匹配（'/' -> index.html），再进入业务API
// root 使用与 hasDist 检测一致的绝对路径——serveStatic 的相对 root 是按 process.cwd() 解析的，
// 从其他目录启动（PM2/Docker 未设 WORKDIR）时 './dist' 会静默失配
const distDir = path.join(__dirname, 'dist');
const hasDist = fs.existsSync(path.join(distDir, 'index.html'));
if (hasDist) {
  const staticMiddleware = serveStatic({
    root: distDir,
    // dist 出现 .br/.gz 伴生档即自动投送（postbuild 产物；暂无也无害，仅
    // 多一次 stat；.zst 变体也支持但 postbuild 不产）。Accept-Encoding 不带
    // br 的客户端静默走压缩中间件的 gzip
    precompressed: true,
    onFound: (_p, c) => {
      // /assets/* 文件名带内容 hash（Vite [name]-[hash]）——内容变名就变，
      // 可永久缓存（此前被 authGate 默认 no-store 盖掉，每次访问全量重拉
      // 400KB+ 的字体与 JS）。index.html 与未哈希 public/ 档同名换内容必须
      // 回源再验证——serveStatic 不处理条件请求，no-cache 再验证是整文件 200
      c.header('Cache-Control', c.req.path.startsWith('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'no-cache');
    }
  });
  // 仅 GET/HEAD 走静态文件（Express serve-static 语义），其余方法放行给 API/404。
  // 仅静态档剥 Range——precompressed 对 Range 会按 .br/.gz 切段报 206，解码必废
  // （hono/node-server 上游缺陷）。API 路径不剥：/downloads 文件路由与
  // /audio-proxy 的 206/If-Range 是活逻辑，媒体 seek 依赖 Range 透传
  app.use('/*', (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next();
    if (!isApiPath(c.req.path)) c.req.raw.headers.delete('range');
    return staticMiddleware(c, next);
  });
}

// 可选写操作鉴权：DOWNLOAD_TOKEN 设置后，/downloads 与 /playlists 等的非 GET
// 请求必须携带匹配的 x-download-token 头——局域网部署时防止任意主机触发下载
// 把磁盘写满。同一 token 在 authGate 里是服务对服务/脚本的全量 API 旁路凭据
// （含 GET）；浏览器登录态（session cookie）视为等效凭据：启用登录后浏览器
// 不再构建期注入 token。
// 懒读 env（中间件内每次取）而非启动快照——启动时未设、运行后注入
// DOWNLOAD_TOKEN 也必须生效，与 authGate 的口径一致
{
  const { sessionFromCookieHeader } = require('./src/server/lib/auth-gate');
  const { tokenMatches } = require('./src/server/lib/token-eq');
  app.use('*', async (c, next) => {
    const downloadToken = process.env.DOWNLOAD_TOKEN || '';
    if (!downloadToken) return next();
    const p = c.req.path;
    const protectedWrite = (p === '/downloads' || p.startsWith('/downloads/')
      || p === '/playlists' || p.startsWith('/playlists/')
      || p === '/ai' || p.startsWith('/ai/')
      || p === '/settings' || p.startsWith('/settings/')
      || p === '/song-meta' || p.startsWith('/song-meta/')
      || p === '/match' || p.startsWith('/match/')
      || p === '/uploads' || p.startsWith('/uploads/')
      || p === '/lyric-align' || p.startsWith('/lyric-align/'))
      && c.req.method !== 'GET' && c.req.method !== 'HEAD';
    if (!protectedWrite) return next();
    // 已登录会话放行（authGate 已验过并 set('user')——直接消费不二次查库）
    if (c.get('user') || sessionFromCookieHeader(c.req.header('cookie'))) return next();
    // 与 authGate/remote.js/qq.js 同一份 tokenMatches——手写 sha256+timingSafeEqual
    // 的第四处拷贝会漂（且裸 digest 比较缺 tokenMatches 的空值保护）
    if (!tokenMatches(c.req.header('x-download-token'), downloadToken)) {
      return c.json({ code: 401, message: '未授权：缺少或错误的下载令牌' }, 401);
    }
    return next();
  });
}

// 路由：音频代理 → 歌单/下载管理 → 受限的网易云API
// Hono 路由中静态路径（/audio-proxy、/healthz、/playlists、/downloads/*）优先级高于参数路由（/:apiName）
app.route('/', require('./src/server/routes/auth'));
app.route('/', require('./src/server/routes/proxy'));
app.route('/', require('./src/server/routes/playlists'));
app.route('/', require('./src/server/routes/downloads'));
app.route('/', require('./src/server/routes/uploads'));
app.route('/', require('./src/server/routes/songmeta'));
app.route('/', require('./src/server/routes/bilibili'));
app.route('/', require('./src/server/routes/youtube'));
app.route('/', require('./src/server/routes/qq'));
app.route('/', require('./src/server/routes/match'));
app.route('/', require('./src/server/routes/ai'));
app.route('/', require('./src/server/routes/lyric-align'));
app.route('/', require('./src/server/routes/settings'));
// 外部歌词兜底链（/lyric/external）——先注册不碍事：首段 'lyric' 亦在
// ALLOWED_APIS，但 /:apiName 只匹配单段路径，多段路由不会撞车
app.route('/', require('./src/server/routes/lyric-external'));
const musicRoutes = require('./src/server/routes/music');
app.route('/', musicRoutes);

// SPA 兜底：未被任何路由处理的 GET 返回 index.html；
// API 前缀（downloads/playlists/audio-proxy/remote）不进兜底——
// 未匹配的 API GET 必须返回 JSON 404，否则 axios 拿到 HTML 解析失败而非业务 404。
// 多段路径（/song_url/123）也要兜：首段命中白名单 API 名同样是 API 请求
if (hasDist) {
  const indexHtml = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
  app.get('*', (c) => {
    const p = c.req.path;
    // apiFirstSegments = ALLOWED_APIS ∪ apiModules（自研端点表 17 名），
    // 前端如果将来引入 vue-router，新增路由必须避开这些名字，否则会被判成 API 404。
    // /assets/ 与带扩展名的资源同样不喂 HTML——浏览器拿到 MIME 错乱的 200
    if (isApiPath(p)
      || p.toLowerCase().startsWith('/assets/')
      || /\.[a-z0-9]+$/i.test(p)) {
      return c.json({ code: 404, message: 'Not Found' }, 404);
    }
    // 与 serveStatic 的 index.html 同口径：壳同名换内容必须回源再验证
    // （authGate 的 no-store 默认只对未显式声明的响应生效）
    c.header('Cache-Control', 'no-cache');
    return c.html(indexHtml);
  });
}

// 未匹配的其余请求（非 GET、无 dist 时的 GET）返回 JSON 404，与 API 错误格式一致
app.notFound((c) => c.json({ code: 404, message: 'Not Found' }, 404));

// 统一 JSON 错误处理：exposed httpError 透传其状态码与消息（路由 catch 未兜到的
// 部分——如未来中间件抛错）；其余一律压成 500，不透内部细节
app.onError((err, c) => {
  if (err?.exposed === true && Number.isInteger(err.status)
    && err.status >= 400 && err.status < 600) {
    return c.json({ code: err.status, message: String(err.message || '请求失败') }, err.status);
  }
  console.error(`[api] ${c.req.method} ${c.req.path} 处理失败:`, err?.message || err);
  return c.json({ code: 500, message: 'Internal Server Error' }, 500);
});

const downloadManager = require('./src/server/services/download-manager');
const { getDb } = require('./src/server/db/client');

// 先初始化 DB（迁移 + 崩溃残留状态复位）再开监听——serve() 之后恢复会有一段
// 窗口期：期间 startQueue 写入的 running 会被 recover 改回 pending，造成状态漂移
try {
  getDb();
  downloadManager.recoverStaleStates();
} catch (error) {
  console.error('[db] 初始化/状态恢复失败:', error);
  process.exit(1);
}

// 过期会话清扫：启动跑一遍 + 每小时续扫（unref 不拦进程退出）
{
  const sessionsRepo = require('./src/server/repositories/sessions');
  try { sessionsRepo.sweepExpired(); } catch { /* 表刚建/无权限均不致命 */ }
  setInterval(() => {
    try { sessionsRepo.sweepExpired(); } catch { /* 同上 */ }
  }, 3600 * 1000).unref();
}
// 孤儿文件清扫放在 serve() 之前同步跑——崩溃残片/未落库写盘此刻无协程引用，
// DB 是唯一事实源；失败只告警不阻塞启动（不把它押进上面的致命分支）
try {
  downloadManager.reapOrphanFiles();
} catch (error) {
  console.warn('[downloads] 孤儿文件清扫失败:', error?.message || error);
}

// 启动服务器（serve() 返回原生 http.Server，可挂 WebSocket upgrade）。
// autoCleanupIncoming 显式声明：多条路由故意不读 body（401/400 早退、纯触发型 POST
// /downloads/queues/:id/start 等），未读完的 body 靠它自动 drain——若按性能建议
// 关掉，所有不读 body 的请求都会泄漏 keep-alive socket
// fetch 入口剥 BASE_PATH 前缀（见上方 normalizeBasePath 注释——不能用
// app.basePath()）：前缀内请求重写为根相对路径再交 app；'/' 302 进 base；
// /ping、/healthz 根级豁免（Docker HEALTHCHECK 与负载探针不认子路径）；
// 其余 base 外路径一律 JSON 404——不用 HTML 兜底，探测方拿不到歧义 200
const entryFetch = BASE_PATH === '/'
  ? app.fetch
  : (req, ctx) => {
      const url = new URL(req.url);
      const p = url.pathname;
      if (p === '/ping' || p === '/healthz') return app.fetch(req, ctx);
      if (p === '/') {
        return new Response(null, {
          status: 302,
          headers: { Location: `${BASE_PATH}/` }
        });
      }
      if (p === BASE_PATH || p.startsWith(`${BASE_PATH}/`)) {
        url.pathname = p.slice(BASE_PATH.length) || '/';
        return app.fetch(new Request(url, req), ctx);
      }
      return new Response(
        JSON.stringify({ code: 404, message: 'Not Found' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    };
const server = serve({
  fetch: entryFetch,
  port: PORT,
  hostname: HOST,
  autoCleanupIncoming: true
}, (info) => {
  const wsPath = (BASE_PATH === '/' ? '' : BASE_PATH) + '/remote';
  console.log(`\n🎵 MeowSync Server is running!`);
  console.log(`📍 Server: http://${HOST}:${info.port}${BASE_PATH === '/' ? '' : BASE_PATH}/`);
  console.log(`🎮 Remote WS: ws://${HOST}:${info.port}${wsPath}`);
  console.log(`\n✨ Ready to serve music data!\n`);
});

// 端口冲突等错误必须退出，避免进程假活
server.on('error', (err) => {
  console.error('❌ 服务器启动失败:', err);
  process.exit(1);
});

const { attachRemoteControl } = require('./src/server/ws/remote');
const remote = attachRemoteControl(server, {
  allowedOrigins: corsOrigins,
  token: process.env.REMOTE_TOKEN || '',
  // WS upgrade 不经 fetch 管道——BASE_PATH 前缀在这里单独对齐
  basePath: BASE_PATH
});
// 开放监听 + 无遥控令牌：同网段任意主机都能接管 host 角色/操控播放——
// 局域网自用可忽略，公网/共享网络部署必须设 REMOTE_TOKEN。
// 覆盖所有"监听全网卡"写法：0.0.0.0/::/::0/[::]/0（Node 对这些都绑定全网卡）。
// 登录启用后 WS 有会话门——两条警告的共同前提都是「门全空」
const { authEnabled } = require('./src/server/lib/auth-gate');
const authReady = (() => { try { return authEnabled(); } catch { return false } })();
const onAllInterfaces = ['0.0.0.0', '::', '::0', '[::]', '0'].includes(HOST.trim());
if (!process.env.REMOTE_TOKEN && !authReady && onAllInterfaces) {
  console.warn('[remote] REMOTE_TOKEN 未设置且登录未启用：任何可达客户端都能控制播放。公网部署请配置 REMOTE_TOKEN 或完成 /auth/setup');
}
// 空 users 表 = 登录未启用 = 公网裸奔窗口：/auth/setup 在无登录态时保持开放
// （首启建号是设计行为），任何先到者都能接管管理员。启动时大声提示——
// 公网部署的正确姿势是先本机完成 setup 再开放监听
if (!authReady && onAllInterfaces) {
  console.warn('[auth] 登录体系未初始化：对外监听时任何人都能执行 /auth/setup 抢建管理员。'
    + '公网部署请先以 HOST=127.0.0.1 启动 → 本机浏览器完成 /auth/setup → 再改回开放端口重启');
}

// 优雅停机：SIGTERM/SIGINT 后停止接收新连接；空闲 keep-alive 立即回收，
// WS 连接由 remote.close() 立即 terminate（升级 socket 不归 close()/
// closeAllConnections() 管，但计入 server._connections，不销毁则 'close'
// 永不触发）；在途 HTTP 请求给 3s 排空窗口后强推，最迟 10s 强退兜底
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[api] 收到 ${signal}，正在优雅关闭...`);

  const forceExit = setTimeout(() => {
    console.error('[api] 优雅关闭超时，强制退出');
    process.exit(1);
  }, 10000);
  forceExit.unref();

  // abort 在途下载并排空（processTask 收尾/removePartial），否则强退窗口内
  // 写了一半的文件会成永久孤儿。排空与连接关闭并行，谁慢等谁，10s 强退兜底
  const downloadsDrained = Promise.resolve()
    .then(() => downloadManager.shutdownAll())
    .catch(error => console.error('[api] 停止下载队列失败:', error));

  server.close(() => { downloadsDrained.finally(() => process.exit(0)); });
  server.closeIdleConnections?.();
  remote?.close?.();
  setTimeout(() => server.closeAllConnections?.(), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// 错误处理：uncaughtException 说明进程状态已不可信，记录后退出交由进程管理器重启
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

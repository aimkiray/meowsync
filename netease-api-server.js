const fs = require('fs');
const path = require('path');

// 加载环境变量
require('dotenv').config();

const { ensureAnonymousToken } = require('./src/lib/init-anonymous-token');
ensureAnonymousToken();

// 补丁：修复 migu 源（必须在 require unblockneteasemusic 之前）
require('./src/lib/patch-migu');

const { serve } = require('@hono/node-server');
const { serveStatic } = require('@hono/node-server/serve-static');
const { Hono } = require('hono');
const { cors } = require('hono/cors');

const app = new Hono();
// 逐变量校验：API_PORT='abc'（非法但真值）时不应吞掉合法的 PORT
const parsePort = (v) => {
  const n = parseInt(v || '', 10);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
};
const PORT = parsePort(process.env.API_PORT) || parsePort(process.env.PORT) || 3101;
const HOST = process.env.HOST || '0.0.0.0';

// 解析CORS来源配置（WebSocket Origin 校验共用此白名单）
const corsOrigins = (process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',')
  : ['http://localhost:3100', 'http://127.0.0.1:3100', 'http://localhost:3101', 'http://127.0.0.1:3101', 'http://poi.boats:31000', 'http://poi.boats:31001']
).map(o => o.trim()).filter(Boolean);

// 中间件
app.use('*', cors({
  origin: (origin) => (origin && corsOrigins.includes(origin)) ? origin : null,
  credentials: true,
}));

// 健康检查：/ping 只探活（Docker HEALTHCHECK 用它）；/healthz 探 DB 写路径——
// SELECT 1 是纯内存查询，磁盘满时照样通过；必须在事务里产生真实 WAL 写入，
// 磁盘满/DB 损坏才暴露为 503 而不是"进程活着但功能全挂"
app.get('/ping', (c) => c.json({ ok: true }));
app.get('/healthz', (c) => {
  try {
    const db = getDb();
    db.exec('BEGIN IMMEDIATE');
    try {
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
  const staticMiddleware = serveStatic({ root: distDir });
  // 仅 GET/HEAD 走静态文件（Express serve-static 语义），其余方法放行给 API/404
  app.use('/*', (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next();
    return staticMiddleware(c, next);
  });
}

// 可选写操作鉴权：DOWNLOAD_TOKEN 设置后，/downloads 与 /playlists 的非 GET 请求
// 必须携带匹配的 x-download-token 头——局域网部署时防止任意主机触发下载把磁盘写满
const downloadToken = process.env.DOWNLOAD_TOKEN || '';
if (downloadToken) {
  const crypto = require('crypto');
  // 双方先 sha256 再比较：等长摘要消除长度侧信道（长度不同的猜测耗时更短），
  // 与 ws/remote.js 的 REMOTE_TOKEN 校验同一写法
  const expectedHash = crypto.createHash('sha256').update(downloadToken).digest();
  app.use('*', async (c, next) => {
    const p = c.req.path;
    const protectedWrite = (p === '/downloads' || p.startsWith('/downloads/')
      || p === '/playlists' || p.startsWith('/playlists/'))
      && c.req.method !== 'GET' && c.req.method !== 'HEAD';
    if (!protectedWrite) return next();
    const providedHash = crypto.createHash('sha256')
      .update(c.req.header('x-download-token') || '')
      .digest();
    if (!crypto.timingSafeEqual(providedHash, expectedHash)) {
      return c.json({ code: 401, message: '未授权：缺少或错误的下载令牌' }, 401);
    }
    return next();
  });
}

// 路由：音频代理 → 歌单/下载管理 → 受限的网易云API
// Hono 路由中静态路径（/audio-proxy、/healthz、/playlists、/downloads/*）优先级高于参数路由（/:apiName）
app.route('/', require('./src/server/routes/proxy'));
app.route('/', require('./src/server/routes/playlists'));
app.route('/', require('./src/server/routes/downloads'));
const musicRoutes = require('./src/server/routes/music');
app.route('/', musicRoutes);

// SPA 兜底：未被任何路由处理的 GET 返回 index.html；
// API 前缀（downloads/playlists/audio-proxy/remote）不进兜底——
// 未匹配的 API GET 必须返回 JSON 404，否则 axios 拿到 HTML 解析失败而非业务 404。
// 多段路径（/song_url/123）也要兜：首段命中白名单 API 名同样是 API 请求
if (hasDist) {
  const indexHtml = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
  const API_PREFIXES = ['/downloads', '/playlists', '/audio-proxy', '/remote', '/ping', '/healthz'];
  const apiNames = musicRoutes.ALLOWED_APIS || new Set();
  // 未白名单的上游模块名（/login/xxx 之类）与 /assets/ 静态资源同样不喂 HTML：
  // 前者会让 axios 把 index.html 当 JSON 解析，后者让浏览器拿到 MIME 错乱的 200
  const { apiModules } = require('./src/server/services/netease-api');
  const apiFirstSegments = new Set([...apiNames, ...Object.keys(apiModules)]);
  app.get('*', (c) => {
    const p = c.req.path;
    // 首段判定时统一小写——/Song_url/x 之类的变体同样是 API 请求，不该喂 HTML。
    // 注意：apiFirstSegments 覆盖全量上游模块名（login/search/album/... 约 300 个），
    // 前端如果将来引入 vue-router，新增路由必须避开这些名字，否则会被判成 API 404
    const firstSegment = (p.split('/')[1] || '').toLowerCase();
    // 前缀匹配同样按小写：/Downloads/x、/Api/xxx 之类部署层误配不该喂 HTML
    const lowerPath = p.toLowerCase();
    if (API_PREFIXES.some(px => lowerPath === px || lowerPath.startsWith(px + '/'))
      || apiFirstSegments.has(firstSegment)
      || p.startsWith('/assets/')
      || /\.[a-z0-9]+$/i.test(p)) {
      return c.json({ code: 404, message: 'Not Found' }, 404);
    }
    return c.html(indexHtml);
  });
}

// 未匹配的其余请求（非 GET、无 dist 时的 GET）返回 JSON 404，与 API 错误格式一致
app.notFound((c) => c.json({ code: 404, message: 'Not Found' }, 404));

// 统一 JSON 错误处理
app.onError((err, c) => {
  console.error(`[api] ${c.req.method} ${c.req.path} 处理失败:`, err);
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

// 启动服务器（serve() 返回原生 http.Server，可挂 WebSocket upgrade）。
// autoCleanupIncoming 显式声明：多条路由故意不读 body（401/400 早退、纯触发型 POST
// /downloads/queues/:id/start 等），未读完的 body 靠它自动 drain——若按性能建议
// 关掉，所有不读 body 的请求都会泄漏 keep-alive socket
const server = serve({
  fetch: app.fetch,
  port: PORT,
  hostname: HOST,
  autoCleanupIncoming: true
}, (info) => {
  console.log(`\n🎵 MeowSync Server is running!`);
  console.log(`📍 Server: http://${HOST}:${info.port}`);
  console.log(`🎮 Remote WS: ws://${HOST}:${info.port}/remote`);
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
  token: process.env.REMOTE_TOKEN || ''
});

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

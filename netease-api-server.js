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

// 健康检查：/ping 只探活（Docker HEALTHCHECK 用它）；/healthz 额外探 DB，
// 磁盘满/DB 损坏时能暴露为 503 而不是"进程活着但功能全挂"
app.get('/ping', (c) => c.json({ ok: true }));
app.get('/healthz', (c) => {
  try {
    getDb().prepare('SELECT 1').get();
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

// 路由：音频代理 → 歌单/下载管理 → 受限的网易云API
// Hono 路由中静态路径（/audio-proxy、/healthz、/playlists、/downloads/*）优先级高于参数路由（/:apiName）
app.route('/', require('./src/server/routes/proxy'));
app.route('/', require('./src/server/routes/playlists'));
app.route('/', require('./src/server/routes/downloads'));
app.route('/', require('./src/server/routes/music'));

// SPA 兜底：未被任何路由处理的 GET 返回 index.html；
// API 前缀（downloads/playlists/audio-proxy/remote）不进兜底——
// 未匹配的 API GET 必须返回 JSON 404，否则 axios 拿到 HTML 解析失败而非业务 404
if (hasDist) {
  const indexHtml = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
  const API_PREFIXES = ['/downloads', '/playlists', '/audio-proxy', '/remote', '/ping', '/healthz'];
  app.get('*', (c) => {
    if (API_PREFIXES.some(p => c.req.path === p || c.req.path.startsWith(p + '/'))) {
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

// 启动服务器（serve() 返回原生 http.Server，可挂 WebSocket upgrade）
const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
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

const downloadManager = require('./src/server/services/download-manager');
const { getDb } = require('./src/server/db/client');

// 启动即初始化 DB（运行迁移）并恢复崩溃残留的 running/downloading 假死状态
try {
  getDb();
  downloadManager.recoverStaleStates();
} catch (error) {
  console.error('[db] 初始化/状态恢复失败:', error);
  process.exit(1);
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

  server.close(() => process.exit(0));
  server.closeIdleConnections?.();
  remote?.close?.();
  // 取消运行中的下载队列并把 downloading 任务复位为 pending，避免重启后假状态
  try {
    downloadManager.shutdownAll();
  } catch (error) {
    console.error('[api] 停止下载队列失败:', error);
  }
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

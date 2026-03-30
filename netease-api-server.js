const express = require('express');
const cors = require('cors');
const http = require('http');

// 加载环境变量
require('dotenv').config();

const { ensureAnonymousToken } = require('./src/lib/init-anonymous-token');
ensureAnonymousToken();

// 补丁：修复 migu 源（必须在 require unblockneteasemusic 之前）
require('./src/lib/patch-migu');

const app = express();
const PORT = process.env.API_PORT || process.env.PORT || 3002;
const HOST = process.env.HOST || '0.0.0.0';

// 解析CORS来源配置
const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',')
  : ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:3001'];

// 中间件
app.use(cors({ origin: corsOrigins, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 路由
app.use('/', require('./src/server/routes/proxy'));
app.use('/', require('./src/server/routes/music'));

// 启动服务器（使用 http.Server 以支持 WebSocket upgrade）
const server = http.createServer(app);

const { attachRemoteControl } = require('./src/server/ws/remote');
attachRemoteControl(server);

server.listen(PORT, HOST, () => {
  console.log(`\n🎵 NeteaseCloudMusicApi Server is running!`);
  console.log(`📍 Server: http://${HOST}:${PORT}`);
  console.log(`🎮 Remote WS: ws://${HOST}:${PORT}/remote`);
  console.log(`\n✨ Ready to serve music data!\n`);
});

// 错误处理
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

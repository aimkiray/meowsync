const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

// 加载环境变量
require('dotenv').config();

const { ensureAnonymousToken } = require('./src/lib/init-anonymous-token');
ensureAnonymousToken();

// 导入NeteaseCloudMusicApi的request工具
const request = require('./node_modules/NeteaseCloudMusicApi/util/request');

// 导入UnblockNeteaseMusic用于解锁灰色歌曲
require('./src/lib/patch-migu');
const unblockmatch = require('@unblockneteasemusic/server');

// 通过 Content-Length + 码率估算音频时长（毫秒）
function estimateDuration(contentLength, br) {
  if (!contentLength || !br) return null;
  return Math.round((contentLength * 8) / br * 1000);
}

// HEAD 请求获取 Content-Length
function getContentLength(url) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(url, { method: 'HEAD', timeout: 5000 }, (res) => {
      resolve(parseInt(res.headers['content-length']) || null);
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// 动态导入所有API模块
const apiModules = {};
const modulePath = path.join(__dirname, 'node_modules', 'NeteaseCloudMusicApi', 'module');

// 读取所有模块文件
if (fs.existsSync(modulePath)) {
  const files = fs.readdirSync(modulePath);
  files.forEach(file => {
    if (file.endsWith('.js')) {
      const moduleName = file.replace('.js', '');
      try {
        apiModules[moduleName] = require(path.join(modulePath, file));
      } catch (error) {
        console.warn(`Failed to load module ${moduleName}:`, error.message);
      }
    }
  });
}

const app = express();
const PORT = process.env.API_PORT || process.env.PORT || 3002;
const HOST = process.env.HOST || '0.0.0.0';

// 解析CORS来源配置
const corsOrigins = process.env.CORS_ORIGINS 
  ? process.env.CORS_ORIGINS.split(',')
  : ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:3001'];

// 配置选项
const config = {
  enableRequestLog: process.env.ENABLE_REQUEST_LOG === 'true',
  logLevel: process.env.LOG_LEVEL || 'info',
  apiTimeout: parseInt(process.env.API_TIMEOUT) || 10000
};

// 中间件
app.use(cors({
  origin: corsOrigins,
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 音频代理：用于转发 googlevideo 等需要服务端 IP 的音频流
app.get('/audio-proxy', (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ error: 'missing url' });

  let parsed;
  try { parsed = new URL(targetUrl); } catch { return res.status(400).json({ error: 'invalid url' }); }
  if (!parsed.hostname.endsWith('googlevideo.com')) {
    return res.status(403).json({ error: 'forbidden host' });
  }

  const proxyHeaders = { 'User-Agent': 'Mozilla/5.0' };
  if (req.headers['range']) proxyHeaders['Range'] = req.headers['range'];

  const mod = parsed.protocol === 'https:' ? https : http;
  const proxyReq = mod.request(targetUrl, { headers: proxyHeaders }, (proxyRes) => {
    const resHeaders = {
      'Content-Type': proxyRes.headers['content-type'] || 'audio/mp4',
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
    };
    if (proxyRes.headers['content-length']) resHeaders['Content-Length'] = proxyRes.headers['content-length'];
    if (proxyRes.headers['content-range']) resHeaders['Content-Range'] = proxyRes.headers['content-range'];
    res.writeHead(proxyRes.statusCode, resHeaders);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (e) => res.status(502).json({ error: e.message }));
  proxyReq.end();
});


app.get('/', (req, res) => {
  const availableApis = Object.keys(apiModules).sort();
  res.json({
    message: 'NeteaseCloudMusicApi Server',
    version: '1.0.0',
    availableApis: availableApis,
    usage: 'GET/POST /:apiName with query parameters or body data',
    examples: [
      '/search?keywords=周杰伦',
      '/song/url?id=33894312',
      '/playlist/detail?id=24381616',
      '/lyric?id=33894312'
    ]
  });
});

// 动态路由处理
app.all('/:apiName', async (req, res) => {
  const { apiName } = req.params;
  const query = req.query;
  const body = req.body;
  const params = { ...query, ...body };

  // 检查API是否存在
  if (!apiModules[apiName]) {
    return res.status(404).json({
      code: 404,
      message: `API '${apiName}' not found`,
      availableApis: Object.keys(apiModules).sort()
    });
  }

  try {
    // 根据配置决定是否记录请求日志
    if (config.enableRequestLog) {
      console.log(`[${new Date().toISOString()}] ${req.method} /${apiName}`, params);
    }

    // 调用对应的API模块，传入request函数
    const result = await apiModules[apiName](params, request);

    // 对 song_url 接口：若 url 为空或为试听版则尝试 UnblockNeteaseMusic fallback
    if (apiName === 'song_url' && result.body?.data) {
      // 获取原曲时长（毫秒），用于验证解锁音源
      const ids = result.body.data.map(i => i.id).filter(Boolean).join(',');
      let originalDurations = {};
      if (ids && apiModules['song_detail']) {
        try {
          const detail = await apiModules['song_detail']({ ids }, request);
          (detail.body?.songs || []).forEach(s => { originalDurations[s.id] = s.dt; });
        } catch (e) { /* 获取失败不阻塞 */ }
      }

      const sources = ['migu', 'kuwo', 'ytdlp'];
      const unlockTasks = result.body.data.map(async (item) => {
        const isTrial = item.freeTrialInfo != null || (item.url && item.time > 0 && item.time <= 60000);
        if ((!item.url || isTrial) && item.id) {
          const originalDt = originalDurations[item.id] || item.dt || null;
          let unlocked = false;
          for (const source of sources) {
            try {
              const unblocked = await unblockmatch(item.id, [source]);
              if (!unblocked?.url) continue;

              // 验证时长：估算解锁音源时长，误差超过 20% 则跳过
              if (originalDt && unblocked.br) {
                const contentLength = await getContentLength(unblocked.url);
                const estimated = estimateDuration(contentLength, unblocked.br);
                if (estimated && Math.abs(estimated - originalDt) / originalDt > 0.2) {
                  console.warn(`[unlock] ${item.id} source=${source} duration mismatch: estimated=${estimated}ms original=${originalDt}ms, skipping`);
                  continue;
                }
              }

              item.url = source === 'ytdlp'
                ? `http://poi.boats:30002/audio-proxy?url=${encodeURIComponent(unblocked.url)}`
                : unblocked.url;
              item.unblocked = true;
              item.unblockedSource = source;
              item.freeTrialInfo = null;
              unlocked = true;
              break;
            } catch (e) {
              // 该源失败，继续下一个
            }
          }
          // 所有源都失败，标记无法解锁
          if (!unlocked) {
            item.unlockFailed = true;
            console.warn(`[unlock] ${item.id} all sources failed or duration mismatch`);
          }
        }
        return item;
      });
      result.body.data = await Promise.all(unlockTasks);
    }

    // 返回结果
    res.json(result);
  } catch (error) {
    console.error(`Error in /${apiName}:`, error);
    res.status(500).json({
      code: 500,
      message: error.message || 'Internal Server Error',
      error: error.toString()
    });
  }
});

// 启动服务器
app.listen(PORT, HOST, () => {
  console.log(`\n🎵 NeteaseCloudMusicApi Server is running!`);
  console.log(`📍 Server: http://${HOST}:${PORT}`);
  console.log(`📚 API Docs: http://${HOST}:${PORT}`);
  console.log(`🔧 Loaded ${Object.keys(apiModules).length} API modules`);
  console.log(`🌐 CORS Origins: ${corsOrigins.join(', ')}`);
  console.log(`📝 Request Logging: ${config.enableRequestLog ? 'Enabled' : 'Disabled'}`);
  console.log(`⏱️  API Timeout: ${config.apiTimeout}ms`);
  console.log(`\n✨ Ready to serve music data!\n`);
});

// 错误处理
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
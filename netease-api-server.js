const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

// 导入NeteaseCloudMusicApi的request工具
const request = require('./node_modules/NeteaseCloudMusicApi/util/request');

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
const PORT = process.env.PORT || 3002;

// 中间件
app.use(cors({
  origin: ['http://localhost:3000', 'http://127.0.0.1:3000'],
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 根路径返回API文档
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
    console.log(`[${new Date().toISOString()}] ${req.method} /${apiName}`, params);
    
    // 调用对应的API模块，传入request函数
    const result = await apiModules[apiName](params, request);
    
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
app.listen(PORT, () => {
  console.log(`\n🎵 NeteaseCloudMusicApi Server is running!`);
  console.log(`📍 Server: http://localhost:${PORT}`);
  console.log(`📚 API Docs: http://localhost:${PORT}`);
  console.log(`🔧 Loaded ${Object.keys(apiModules).length} API modules`);
  console.log(`\n✨ Ready to serve music data!\n`);
});

// 错误处理
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
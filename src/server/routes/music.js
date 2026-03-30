const { Router } = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');

const router = Router();

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
const modulePath = path.join(__dirname, '../../../node_modules', 'NeteaseCloudMusicApi', 'module');

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

const request = require(path.join(__dirname, '../../../node_modules/NeteaseCloudMusicApi/util/request'));
const unblockmatch = require('@unblockneteasemusic/server');

const sources = ['kuwo', 'ytdlp'];

router.get('/', (req, res) => {
  res.json({
    message: 'NeteaseCloudMusicApi Server',
    version: '1.0.0',
    availableApis: Object.keys(apiModules).sort(),
    usage: 'GET/POST /:apiName with query parameters or body data',
    examples: [
      '/search?keywords=周杰伦',
      '/song/url?id=33894312',
      '/playlist/detail?id=24381616',
      '/lyric?id=33894312'
    ]
  });
});

router.all('/:apiName', async (req, res) => {
  const { apiName } = req.params;
  const params = { ...req.query, ...req.body };

  if (!apiModules[apiName]) {
    return res.status(404).json({
      code: 404,
      message: `API '${apiName}' not found`,
      availableApis: Object.keys(apiModules).sort()
    });
  }

  try {
    const result = await apiModules[apiName](params, request);

    // 对 song_url 接口：若 url 为空或为试听版则尝试 UnblockNeteaseMusic fallback
    if (apiName === 'song_url' && result.body?.data) {
      const ids = result.body.data.map(i => i.id).filter(Boolean).join(',');
      let originalDurations = {};
      if (ids && apiModules['song_detail']) {
        try {
          const detail = await apiModules['song_detail']({ ids }, request);
          (detail.body?.songs || []).forEach(s => { originalDurations[s.id] = s.dt; });
        } catch (e) { /* 获取失败不阻塞 */ }
      }

      const unlockTasks = result.body.data.map(async (item) => {
        const isTrial = item.freeTrialInfo != null || (item.url && item.time > 0 && item.time <= 60000);
        if ((!item.url || isTrial) && item.id) {
          const originalDt = originalDurations[item.id] || item.dt || null;
          let unlocked = false;
          for (const source of sources) {
            try {
              const unblocked = await unblockmatch(item.id, [source]);
              if (!unblocked?.url) continue;

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
          if (!unlocked) {
            item.unlockFailed = true;
            console.warn(`[unlock] ${item.id} all sources failed or duration mismatch`);
          }
        }
        return item;
      });
      result.body.data = await Promise.all(unlockTasks);
    }

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

module.exports = router;

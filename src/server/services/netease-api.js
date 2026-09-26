const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { resolvesToPublicIp } = require('../lib/net-guard');

// NeteaseCloudMusicApi 安装路径经 require.resolve 解析，避免依赖 process.cwd()/__dirname 布局
function resolvePackageDir(pkg) {
  try {
    return path.dirname(require.resolve(`${pkg}/package.json`));
  } catch {
    return path.join(__dirname, '../../../node_modules', pkg);
  }
}

// 动态导入所有API模块
const apiModules = Object.create(null);
const modulePath = path.join(resolvePackageDir('NeteaseCloudMusicApi'), 'module');
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

let request;
try {
  request = require('NeteaseCloudMusicApi/util/request');
} catch {
  request = require(path.join(resolvePackageDir('NeteaseCloudMusicApi'), 'util', 'request'));
}
const unblockmatch = require('@unblockneteasemusic/server');

// 试听版判定阈值：上游返回的 url 时长不超过 60s 视为试听片段
const TRIAL_MAX_DURATION_MS = 60000;
// 解锁结果的时长校验容差（估算时长与原始时长偏差占比）
const DURATION_TOLERANCE = { ytdlp: 0.4, default: 0.2 };
// 播放走 ytdlp 优先（音质稳定）；下载走 kuwo 优先（ytdlp 直连源站对服务端下载无增益且慢）
const PLAYBACK_SOURCES = ['ytdlp', 'kuwo'];
const DOWNLOAD_SOURCES = ['kuwo', 'ytdlp'];

// 通过 Content-Length + 码率估算音频时长（毫秒）
function estimateDuration(contentLength, br) {
  if (!contentLength || !br) return null;
  return Math.round((contentLength * 8) / br * 1000);
}

// HEAD 请求获取 Content-Length（跟随有限重定向；30x 响应体的 length 不是目标文件大小）。
// 与 fetchStream 同一威胁模型：每跳都过 resolvesToPublicIp——明文源站被 302 到内网/
// 云元数据即成盲 SSRF（端口/存活探测侧信道）；userinfo 一并剥掉（相对重定向会继承
// credentials，转发到异构主机即泄露）。探测失败一律降级 null = 跳过时长校验，不阻塞下载
async function getContentLength(url, hops = 0) {
  if (hops > 3) return null;
  let current;
  try {
    current = new URL(url);
  } catch {
    return null;
  }
  if (current.protocol !== 'http:' && current.protocol !== 'https:') {
    return null;
  }
  current.username = '';
  current.password = '';
  if (!(await resolvesToPublicIp(current.hostname))) {
    return null;
  }
  const cleanUrl = current.toString();
  return new Promise((resolve) => {
    const mod = cleanUrl.startsWith('https') ? https : http;
    const req = mod.request(cleanUrl, { method: 'HEAD', timeout: 5000 }, (res) => {
      // res 在 drain 期间仍可能收 socket 错误（对端 RST）——IncomingMessage 无
      // error 监听会抛 uncaughtException 打崩进程（上游 URL 可被 302 投毒，远程可触发）
      res.on('error', () => resolve(null));
      res.resume(); // 消费响应，及时释放 keep-alive socket
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // 回调内同步执行——畸形 Location 必须吞掉，否则抛错穿透 emit 成 uncaughtException
        let next;
        try {
          const u = new URL(res.headers.location, cleanUrl);
          // 只允许 http/https 跳——file:///javascript: 之类直接放弃
          if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad scheme');
          next = u.toString();
        } catch {
          resolve(null);
          return;
        }
        resolve(getContentLength(next, hops + 1));
        return;
      }
      // 仅 2xx 的 content-length 是文件大小——405/500 错误页的 length 会被当作
      // 文件大小做时长估算，误杀本来可用的解锁源
      resolve(res.statusCode >= 200 && res.statusCode < 300
        ? (parseInt(res.headers['content-length']) || null)
        : null);
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// 上游模块/解锁调用没有 AbortSignal 概念，且无内建超时——一个挂死的 upstream
// 请求会让队列排空（drain）无限等待、任务卡在不可中止阶段。race 一个总时限兜底
const UPSTREAM_TIMEOUT_MS = 30000;
const UNBLOCK_TIMEOUT_MS = 60000; // unblockmatch 内部串行试多个源站，给得宽一些
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} 超时`)), ms);
      timer.unref();
    })
  ]).finally(() => clearTimeout(timer));
}

async function callNeteaseApi(apiName, params, options = {}) {
  if (!apiModules[apiName]) {
    throw new Error(`API '${apiName}' not found`);
  }
  // timeoutMs 可覆盖：千曲歌单的 playlist_detail/track_all 慢链路可超 30s
  const timeoutMs = options.timeoutMs || UPSTREAM_TIMEOUT_MS;
  return withTimeout(apiModules[apiName](params, request), timeoutMs, `上游接口 ${apiName}`);
}

// 对 song_url 返回的 data 数组做解锁后处理（原地修改并返回）
// - url 为空或为试听片段的条目尝试 unblockmatch 回退源
// - purpose='download' 时：源顺序 kuwo 优先；kuwo 链接跳过时长校验（其元数据不可靠）；
//   且不走 /audio-proxy（代理是给浏览器用的，服务端下载直连源站）
// - purpose='playback' 时：ytdlp 命中经 proxyOrigin 拼 /audio-proxy 回链
async function resolveSongUrls(items, { purpose = 'playback', proxyOrigin = null } = {}) {
  if (!Array.isArray(items)) return items;

  const sources = purpose === 'download' ? DOWNLOAD_SOURCES : PLAYBACK_SOURCES;
  const ids = items.map(i => i.id).filter(Boolean).join(',');

  const originalDurations = {};
  if (ids && apiModules['song_detail']) {
    try {
      const detail = await withTimeout(
        apiModules['song_detail']({ ids }, request),
        UPSTREAM_TIMEOUT_MS, '上游接口 song_detail'
      );
      (detail.body?.songs || []).forEach(s => { originalDurations[s.id] = s.dt; });
    } catch (e) { /* 获取失败不阻塞 */ }
  }

  await Promise.all(items.map(async (item) => {
    // 试听判定：freeTrialInfo 是明确标记；时长启发式只对付费曲目生效——
    // 免费短歌（intro/间奏 <60s）fee=0 且 url 即完整曲，误判会错误触发解锁
    const isTrial = item.freeTrialInfo != null
      || (item.url && item.time > 0 && item.time <= TRIAL_MAX_DURATION_MS && item.fee > 0);
    if ((!item.url || isTrial) && item.id) {
      const originalDt = originalDurations[item.id] || item.dt || null;
      let unlocked = false;
      for (const source of sources) {
        try {
          const unblocked = await withTimeout(
            unblockmatch(item.id, [source]),
            UNBLOCK_TIMEOUT_MS, `解锁源 ${source}`
          );
          if (!unblocked?.url) continue;

          const validateDuration = !(purpose === 'download' && source === 'kuwo');
          if (originalDt && unblocked.br && validateDuration) {
            // match() 内部 check() 已发过 range 请求并解析出 size——优先复用，少发一次 HEAD
            const size = Number.isFinite(unblocked.size) && unblocked.size > 0
              ? unblocked.size
              : await getContentLength(unblocked.url);
            const estimated = estimateDuration(size, unblocked.br);
            const tolerance = DURATION_TOLERANCE[source] ?? DURATION_TOLERANCE.default;
            if (estimated && Math.abs(estimated - originalDt) / originalDt > tolerance) {
              console.warn(
                `[unlock] ${item.id} purpose=${purpose} source=${source} duration mismatch: estimated=${estimated}ms original=${originalDt}ms, skipping`
              );
              continue;
            }
          }

          const useProxy = purpose === 'playback' && source === 'ytdlp' && !!proxyOrigin;
          item.url = useProxy
            ? `${proxyOrigin}/audio-proxy?url=${encodeURIComponent(unblocked.url)}`
            : unblocked.url;
          item.unblocked = true;
          item.unblockedSource = source;
          item.usedAudioProxy = useProxy;
          item.freeTrialInfo = null;
          unlocked = true;
          console.info(`[unlock] ${item.id} purpose=${purpose} source=${source} proxy=${useProxy}`);
          break;
        } catch (e) {
          // 该源失败，继续下一个
        }
      }
      if (!unlocked) {
        item.unlockFailed = true;
        // 试听片段/失效链不再下发——否则下载端会把 30s 残片当完整曲落盘并标 completed
        item.url = null;
        console.warn(`[unlock] ${item.id} purpose=${purpose} all sources failed or duration mismatch`);
      }
    }
    return item;
  }));

  return items;
}

module.exports = { callNeteaseApi, apiModules, request, resolveSongUrls };

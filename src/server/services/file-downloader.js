const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { callNeteaseApi, resolveSongUrls } = require('./netease-api');
const { resolvesToPublicIp } = require('../lib/net-guard');

// 下载 URL 来自上游 API/歌单元数据（网易云/解锁源），不是直接用户输入——但明文 http 源站
// 可被链路篡改成 302 到内网/云元数据地址，与 proxy.js 同一威胁模型：每跳都做公网校验
const MAX_REDIRECTS = 5;
const MAX_FILENAME_BYTES = 120;
// Windows 保留名：即便在 mac/linux 生成，用户最终可能在 Windows 上操作这些文件
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

function sanitizeFilename(filename, maxBytes = MAX_FILENAME_BYTES) {
  let cleaned = String(filename || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  // 按 UTF-8 字节截断：slice 可能切出半个多字节字符（孤立代理项），结尾再剥掉
  while (Buffer.byteLength(cleaned, 'utf8') > maxBytes) {
    cleaned = cleaned.slice(0, -8);
  }
  cleaned = cleaned.replace(/[\uD800-\uDFFF]/g, ''); // 剥孤立代理项（截断半个 UTF-8 字符的产物）
  cleaned = cleaned.replace(/[ .]+$/, ''); // 尾随空格/点 Windows 非法
  if (!cleaned || WINDOWS_RESERVED.test(cleaned)) {
    return 'untitled';
  }
  return cleaned;
}

// 确定性失败（版权限制/解锁失败/空文件声明）：标 fatal，上层不再重试白打上游
function fatalError(message) {
  const err = new Error(message);
  err.fatal = true;
  return err;
}

// 上游 callNeteaseApi 对非 200 是 reject(answer 对象)——不是 Error，没有 .message
function describeError(error) {
  if (error?.message) return error.message;
  if (error?.body?.msg) return String(error.body.msg);
  if (error?.body?.code) return `上游错误 code=${error.body.code}`;
  return '未知错误';
}

// 下载地址校验：只允许 http/https，剥离内嵌 credentials
function toDownloadUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('无效的下载链接');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('仅支持 http/https 下载');
  }
  parsed.username = '';
  parsed.password = '';
  return parsed;
}

// 手动逐跳跟随重定向：axios maxRedirects 内部跟随、每跳不再过校验，
// 302→http://169.254.169.254 之类的重定向投毒必须逐跳拦截
async function fetchStream(rawUrl, { timeout, signal }) {
  let url = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const parsed = toDownloadUrl(url);
    // IP 字面量判段、域名走 DNS 解析：任一落入私网/保留段即拒（fail closed）
    if (!(await resolvesToPublicIp(parsed.hostname))) {
      throw new Error('下载地址解析到非公网地址');
    }

    const response = await axios({
      method: 'get',
      url: parsed.toString(),
      responseType: 'stream',
      timeout,
      maxRedirects: 0,
      signal,
      // 3xx 由本层处理；4xx/5xx 也进 then 以便给出干净错误
      validateStatus: s => (s >= 200 && s < 300) || (s >= 300 && s < 400)
    });

    if (response.status >= 300 && response.status < 400) {
      response.data.destroy(); // 释放连接，不留悬挂 socket
      const location = response.headers.location;
      if (!location) throw new Error(`上游重定向缺少 Location (${response.status})`);
      try {
        url = new URL(location, parsed.toString()).toString();
      } catch {
        throw new Error('上游重定向地址无效');
      }
      continue;
    }

    return response;
  }
  throw new Error('重定向次数过多');
}

function removePartial(outputPath) {
  try {
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }
  } catch {
    // Windows 下句柄未释放时 unlink 会失败——残留文件下次清理路径兜底
  }
}

async function downloadAudio(songId, outputPath, bitrate = 320000, onProgress, signal) {
  try {
    // 进程内直调上游模块 + 共享解锁后处理（purpose=download：kuwo 优先、不走 audio-proxy），
    // 不经过 HTTP 自调——避免依赖服务端口配置，也省去一圈 loopback 开销
    let result;
    try {
      result = await callNeteaseApi('song_url', { id: songId, br: bitrate });
    } catch (error) {
      // 上游 song_url 模块对不存在的 songId 会拿到 body.data=undefined 再 .sort() 抛
      // TypeError——这是确定性错误（每次必崩），标 fatal 跳过重试；网络类错误照常重试
      if (error instanceof TypeError) {
        throw fatalError('无法获取歌曲信息');
      }
      throw error;
    }
    const items = result?.body?.data;
    if (!Array.isArray(items) || items.length === 0) {
      throw fatalError('无法获取歌曲信息');
    }
    await resolveSongUrls(items, { purpose: 'download' });

    const songData = items[0];
    if (songData.unlockFailed) {
      throw fatalError('解锁失败，所有可用源均无匹配');
    }
    if (songData.freeTrialInfo) {
      throw fatalError('仅获取到试听片段，可能受版权限制');
    }
    if (!songData.url) {
      throw fatalError('无法获取歌曲链接');
    }

    const dir = path.dirname(outputPath);
    fs.mkdirSync(dir, { recursive: true });

    const audioResponse = await fetchStream(songData.url, { timeout: 300000, signal });
    if (audioResponse.status !== 200 && audioResponse.status !== 206) {
      audioResponse.data.destroy();
      throw new Error(`上游返回 ${audioResponse.status}`);
    }

    const totalLength = parseInt(audioResponse.headers['content-length'], 10);
    let downloadedLength = 0;
    let lastProgress = -1;

    audioResponse.data.on('data', (chunk) => {
      downloadedLength += chunk.length;
      if (onProgress && totalLength > 0) {
        const progress = Math.round((downloadedLength / totalLength) * 100);
        if (progress !== lastProgress) {
          lastProgress = progress;
          onProgress(progress);
        }
      }
    });

    // pipeline 任一端出错都会销毁两侧流（abort 时 axios 流 reject → writer 同步销毁），
    // 不再手写 finish/error 监听——原先 finish 里同步 statSync 抛错会穿透成 uncaughtException
    await pipeline(audioResponse.data, fs.createWriteStream(outputPath));

    const stats = fs.statSync(outputPath);
    if (stats.size === 0) {
      throw new Error('下载内容为空');
    }
    // content-length 与落盘大小对账：framing 完整但服务端截断的残文件不能当完成
    if (totalLength > 0 && stats.size !== totalLength) {
      throw new Error(`下载不完整（${stats.size}/${totalLength} 字节）`);
    }
    return {
      path: outputPath,
      size: stats.size,
      url: songData.url,
      unblocked: songData.unblocked || false,
      unblockedSource: songData.unblockedSource || null,
      usedAudioProxy: songData.usedAudioProxy || false
    };
  } catch (error) {
    removePartial(outputPath);
    const err = new Error(`下载音频失败: ${describeError(error)}`);
    err.fatal = Boolean(error.fatal);
    throw err;
  }
}

async function downloadLyrics(songId, outputPath) {
  try {
    const response = await callNeteaseApi('lyric', { id: songId });

    if (!response || !response.body || response.body.code !== 200) {
      throw new Error('无法获取歌词');
    }

    const lrc = response.body.lrc;
    if (!lrc || !lrc.lyric) {
      throw new Error('歌词不存在');
    }

    const dir = path.dirname(outputPath);
    fs.mkdirSync(dir, { recursive: true });

    try {
      fs.writeFileSync(outputPath, lrc.lyric, 'utf-8');
    } catch (writeError) {
      removePartial(outputPath); // 写一半失败不留孤儿 .lrc
      throw writeError;
    }

    return {
      path: outputPath,
      size: Buffer.byteLength(lrc.lyric, 'utf-8')
    };
  } catch (error) {
    if (error.message === '歌词不存在') {
      throw error;
    }
    throw new Error(`下载歌词失败: ${describeError(error)}`);
  }
}

async function downloadCover(coverUrl, outputPath, signal) {
  try {
    if (!coverUrl) {
      throw fatalError('封面链接不存在');
    }

    const dir = path.dirname(outputPath);
    fs.mkdirSync(dir, { recursive: true });

    const response = await fetchStream(coverUrl, { timeout: 60000, signal });
    if (response.status !== 200) {
      response.data.destroy();
      throw new Error(`上游返回 ${response.status}`);
    }

    await pipeline(response.data, fs.createWriteStream(outputPath));

    const stats = fs.statSync(outputPath);
    if (stats.size === 0) {
      throw new Error('下载内容为空');
    }
    return {
      path: outputPath,
      size: stats.size
    };
  } catch (error) {
    removePartial(outputPath);
    const err = new Error(`下载封面失败: ${describeError(error)}`);
    err.fatal = Boolean(error.fatal);
    throw err;
  }
}

module.exports = {
  downloadAudio,
  downloadLyrics,
  downloadCover,
  sanitizeFilename
};

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { callNeteaseApi, resolveSongUrls } = require('./netease-api');

// 文件名过长会触发 ENAMETOOLONG（ext4 上限 255 字节，CJK 一字符 3 字节）——按 UTF-8 字节截断
const MAX_FILENAME_BYTES = 180;

function sanitizeFilename(filename) {
  let cleaned = String(filename || '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  while (Buffer.byteLength(cleaned, 'utf8') > MAX_FILENAME_BYTES) {
    cleaned = cleaned.slice(0, -8);
  }
  return cleaned || 'untitled';
}

// 下载地址校验：URL 来自上游响应/DB 字段，只允许 http/https，剥离内嵌 credentials
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
  return parsed.toString();
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
    const result = await callNeteaseApi('song_url', { id: songId, br: bitrate });
    const items = result?.body?.data;
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('无法获取歌曲信息');
    }
    await resolveSongUrls(items, { purpose: 'download' });

    const songData = items[0];
    if (songData.unlockFailed) {
      throw new Error('解锁失败，所有可用源均无匹配');
    }
    if (songData.freeTrialInfo) {
      throw new Error('仅获取到试听片段，可能受版权限制');
    }
    if (!songData.url) {
      throw new Error('无法获取歌曲链接');
    }

    const dir = path.dirname(outputPath);
    fs.mkdirSync(dir, { recursive: true });

    const audioResponse = await axios({
      method: 'get',
      url: toDownloadUrl(songData.url),
      responseType: 'stream',
      timeout: 300000,
      maxRedirects: 5,
      signal
    });

    const totalLength = parseInt(audioResponse.headers['content-length'], 10);
    let downloadedLength = 0;

    audioResponse.data.on('data', (chunk) => {
      downloadedLength += chunk.length;
      if (onProgress && totalLength) {
        const progress = Math.round((downloadedLength / totalLength) * 100);
        onProgress(progress);
      }
    });

    // pipeline 任一端出错都会销毁两侧流（abort 时 axios 流 reject → writer 同步销毁），
    // 不再手写 finish/error 监听——原先 finish 里同步 statSync 抛错会穿透成 uncaughtException
    await pipeline(audioResponse.data, fs.createWriteStream(outputPath));

    const stats = fs.statSync(outputPath);
    if (stats.size === 0) {
      throw new Error('下载内容为空');
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
    throw new Error(`下载音频失败: ${error.message}`);
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

    fs.writeFileSync(outputPath, lrc.lyric, 'utf-8');

    return {
      path: outputPath,
      size: Buffer.byteLength(lrc.lyric, 'utf-8')
    };
  } catch (error) {
    if (error.message === '歌词不存在') {
      throw error;
    }
    throw new Error(`下载歌词失败: ${error.message}`);
  }
}

async function downloadCover(coverUrl, outputPath, signal) {
  try {
    if (!coverUrl) {
      throw new Error('封面链接不存在');
    }

    const dir = path.dirname(outputPath);
    fs.mkdirSync(dir, { recursive: true });

    const response = await axios({
      method: 'get',
      url: toDownloadUrl(coverUrl),
      responseType: 'stream',
      timeout: 60000,
      signal
    });

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
    throw new Error(`下载封面失败: ${error.message}`);
  }
}

module.exports = {
  downloadAudio,
  downloadLyrics,
  downloadCover,
  sanitizeFilename
};

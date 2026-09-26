const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { callNeteaseApi, resolveSongUrls } = require('./netease-api');

function sanitizeFilename(filename) {
  return filename.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim();
}

async function downloadAudio(songId, outputPath, bitrate = 320000, onProgress) {
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
    if (!songData.url) {
      throw new Error('无法获取歌曲链接');
    }

    const dir = path.dirname(outputPath);
    fs.mkdirSync(dir, { recursive: true });

    const audioResponse = await axios({
      method: 'get',
      url: songData.url,
      responseType: 'stream',
      timeout: 300000,
      maxRedirects: 5
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

    const writer = fs.createWriteStream(outputPath);
    audioResponse.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        const stats = fs.statSync(outputPath);
        resolve({
          path: outputPath,
          size: stats.size,
          url: songData.url,
          unblocked: songData.unblocked || false,
          unblockedSource: songData.unblockedSource || null,
          usedAudioProxy: songData.usedAudioProxy || false
        });
      });
      writer.on('error', reject);
      audioResponse.data.on('error', reject);
    });
  } catch (error) {
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }
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

async function downloadCover(coverUrl, outputPath) {
  try {
    if (!coverUrl) {
      throw new Error('封面链接不存在');
    }

    const dir = path.dirname(outputPath);
    fs.mkdirSync(dir, { recursive: true });

    const response = await axios({
      method: 'get',
      url: coverUrl,
      responseType: 'stream',
      timeout: 60000
    });

    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        const stats = fs.statSync(outputPath);
        resolve({
          path: outputPath,
          size: stats.size
        });
      });
      writer.on('error', reject);
      response.data.on('error', reject);
    });
  } catch (error) {
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }
    throw new Error(`下载封面失败: ${error.message}`);
  }
}

module.exports = {
  downloadAudio,
  downloadLyrics,
  downloadCover,
  sanitizeFilename
};

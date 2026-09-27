const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { callNeteaseApi, resolveSongUrls } = require('./netease-api');
const { checkHostPublic } = require('../lib/net-guard');

// 下载 URL 来自上游 API/歌单元数据（网易云/解锁源），不是直接用户输入——但明文 http 源站
// 可被链路篡改成 302 到内网/云元数据地址，与 proxy.js 同一威胁模型：每跳都做公网校验
const MAX_REDIRECTS = 5;
const MAX_FILENAME_BYTES = 120;
// 体积上限：明文源站被 302 到无限流/超大文件的威胁模型下，写完再对账已经磁盘写满
const MAX_AUDIO_BYTES = 512 * 1024 * 1024;
const MAX_COVER_BYTES = 32 * 1024 * 1024;
// Windows 保留名：即便在 mac/linux 生成，用户最终可能在 Windows 上操作这些文件
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

function sanitizeFilename(filename, maxBytes = MAX_FILENAME_BYTES) {
  let cleaned = String(filename || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    // 只剥孤立代理项（截断半个 UTF-8 字符/脏数据的产物）：[\uD800-\uDFFF] 全量匹配
    // 会把合法 surrogate pair（emoji、CJK 扩展 B）两半都删掉
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // 按 UTF-8 字节截断：按 code point 推进一次到位，不切半个多字节字符；
  // 上游可控的超长名字下 while-slice 是 O(n²)，病态输入会拖慢整队列
  if (Buffer.byteLength(cleaned, 'utf8') > maxBytes) {
    let bytes = 0;
    let end = 0;
    for (const ch of cleaned) {
      bytes += Buffer.byteLength(ch, 'utf8');
      if (bytes > maxBytes) break;
      end += ch.length;
    }
    cleaned = cleaned.slice(0, end);
  }
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

// 不可中止的上游阶段（解锁/取链）最多拖住协程 ~200s，远超删除/停机排空预算——
// abort 生效前最后一个落盘副作用是 mkdirSync：已 abort 的协程若在排空清扫后
// 跑到这里，会把刚被 rmdirSync 剪掉的目录骨架复活（歌单/队列已删而目录重现）
function throwIfAborted(signal) {
  if (signal?.aborted) {
    const err = new Error('已取消');
    err.aborted = true;
    throw err;
  }
}

// 上游 callNeteaseApi 对非 200 是 reject(answer 对象)——不是 Error，没有 .message
function describeError(error) {
  if (error?.message) return error.message;
  if (error?.body?.msg) return String(error.body.msg);
  if (error?.body?.code) return `上游错误 code=${error.body.code}`;
  return '未知错误';
}

// 下载地址校验：只允许 http/https，剥离内嵌 credentials（确定性错误标 fatal）
function toDownloadUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw fatalError('无效的下载链接');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw fatalError('仅支持 http/https 下载');
  }
  parsed.username = '';
  parsed.password = '';
  return parsed;
}

// 流停滞看门狗：axios 的 timeout 在拿到响应头后经 settle 就失效——一个
// "响应头之后停流"的上游会无限期占住并发工位。data 事件刷新时间戳，
// 超过 stallMs 无数据即毁流（错误冒泡到 pipeline，走正常失败路径）
const STALL_MS = 30000;
function watchStall(stream, stallMs = STALL_MS, maxTotalMs = 0) {
  let lastData = Date.now();
  const started = Date.now();
  const onData = () => { lastData = Date.now(); };
  const timer = setInterval(() => {
    if (Date.now() - lastData > stallMs) {
      stream.destroy(new Error('下载流停滞超时'));
      return;
    }
    // 总时长兜底：滴流（每 <stallMs 发 1 字节）能无限刷新停滞计时，
    // 配合 512MiB 上限可无限期占住工位——加个硬顶
    if (maxTotalMs > 0 && Date.now() - started > maxTotalMs) {
      stream.destroy(new Error('下载总时长超限'));
    }
  }, Math.min(stallMs, 10000));
  timer.unref();
  stream.on('data', onData);
  stream.on('close', () => clearInterval(timer));
}

// content-encoding 判定：identity 是 RFC 7231 合法 token（显式声明无编码），
// 部分 CDN/IIS 链路会下发——与 decompress:false 配合下它不影响字节对账，放行
function hasNonIdentityEncoding(headers) {
  const enc = String(headers?.['content-encoding'] || '').trim().toLowerCase();
  return enc !== '' && enc !== 'identity';
}

// 手动逐跳跟随重定向：axios maxRedirects 内部跟随、每跳不再过校验，
// 302→http://169.254.169.254 之类的重定向投毒必须逐跳拦截
async function fetchStream(rawUrl, { timeout, signal }) {
  let url = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const parsed = toDownloadUrl(url);
    // 与 proxy.js 同一收口：明文 http 源被 302 投毒成 http://公网IP:任意端口/
    // 的探测面——每跳只放标准端口
    const port = parsed.port === ''
      ? (parsed.protocol === 'http:' ? 80 : 443)
      : Number(parsed.port);
    if (port !== 80 && port !== 443) {
      throw fatalError('下载地址端口不受支持');
    }
    // 三态判定：'blocked'（解析到私网）是确定性拦截→fatal；'error'（DNS 瞬时故障：
    // SERVFAIL/临时断网）保持可重试，否则一次抖动就永久剥夺重试机会
    const hostCheck = await checkHostPublic(parsed.hostname);
    if (hostCheck === 'blocked') {
      throw fatalError('下载地址解析到非公网地址');
    }
    if (hostCheck !== 'ok') {
      throw new Error('下载地址 DNS 解析失败');
    }

    let response;
    try {
      response = await axios({
        method: 'get',
        url: parsed.toString(),
        responseType: 'stream',
        timeout,
        maxRedirects: 0,
        signal,
        // identity + decompress:false：axios 默认透明解压且删掉 content-encoding 头，
        // 落盘字节与声明 content-length 不一致会让对账确定性误判"下载不完整"。
        // 关掉解压后若上游仍回编码内容，响应头里能看到——按上游违规判 fatal
        decompress: false,
        headers: { 'Accept-Encoding': 'identity' },
        // 3xx 由本层处理以便逐跳校验；其余状态码进 catch 统一处理
        validateStatus: s => s >= 200 && s < 400
      });
    } catch (error) {
      // 4xx/5xx 的响应流无人消费会悬挂 keep-alive socket——显式销毁
      error.response?.data?.destroy?.();
      // 4xx（除 429）对该 URL 是确定性失败：重试三次白打上游。5xx/429/超时保留可重试
      const status = error.response?.status;
      if (status >= 400 && status < 500 && status !== 429) {
        throw fatalError(`上游返回 ${status}`);
      }
      throw error;
    }

    if (response.status >= 300 && response.status < 400) {
      response.data.destroy(); // 释放连接，不留悬挂 socket
      const location = response.headers.location;
      if (!location) throw fatalError(`上游重定向缺少 Location (${response.status})`);
      try {
        url = new URL(location, parsed.toString()).toString();
      } catch {
        throw fatalError('上游重定向地址无效');
      }
      continue;
    }

    return response;
  }
  throw fatalError('重定向次数过多');
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

    // items[0] 可能解锁失败但后续条目有 url——选第一个可用的，而不是永远盯着第一个
    const songData = items.find(i => i.url && !i.unlockFailed) || items[0];
    if (songData.unlockFailed) {
      throw fatalError('解锁失败，所有可用源均无匹配');
    }
    if (songData.freeTrialInfo) {
      throw fatalError('仅获取到试听片段，可能受版权限制');
    }
    if (!songData.url) {
      throw fatalError('无法获取歌曲链接');
    }

    throwIfAborted(signal);
    const dir = path.dirname(outputPath);
    fs.mkdirSync(dir, { recursive: true });

    const audioResponse = await fetchStream(songData.url, { timeout: 300000, signal });
    if (audioResponse.status !== 200 && audioResponse.status !== 206) {
      audioResponse.data.destroy();
      throw fatalError(`上游返回 ${audioResponse.status}`);
    }
    // decompress:false 下 content-encoding 可见：上游回非 identity 编码，
    // 此时 content-length 与落盘字节不可对账——确定性违规，不浪费时间传完
    if (hasNonIdentityEncoding(audioResponse.headers)) {
      audioResponse.data.destroy();
      throw fatalError('上游返回了压缩内容，无法校验完整性');
    }

    const totalLength = parseInt(audioResponse.headers['content-length'], 10);
    // 声明就已超限：headers 到手即拒，不把 512MiB 先流一遍
    if (totalLength > MAX_AUDIO_BYTES) {
      audioResponse.data.destroy();
      throw fatalError(`文件超过大小上限 ${MAX_AUDIO_BYTES}`);
    }
    let downloadedLength = 0;
    let lastProgress = -1;

    watchStall(audioResponse.data, STALL_MS, 300000); // 总时长与头超时对齐 5min
    audioResponse.data.on('data', (chunk) => {
      downloadedLength += chunk.length;
      // 超限即毁流——pipeline 会把该错误冒泡，removePartial 清残片
      if (downloadedLength > MAX_AUDIO_BYTES) {
        audioResponse.data.destroy(fatalError(`文件超过大小上限 ${MAX_AUDIO_BYTES}`));
        return;
      }
      if (onProgress && totalLength > 0) {
        // 上游低报 content-length 时进度可能超 100——钳位到 100
        const progress = Math.min(Math.round((downloadedLength / totalLength) * 100), 100);
        if (progress !== lastProgress) {
          lastProgress = progress;
          try {
            onProgress(progress);
          } catch {
            // 回调异常不得穿透 'data' 监听器成 uncaughtException
          }
        }
      }
    });

    // pipeline 任一端出错都会销毁两侧流（abort 时 axios 流 reject → writer 同步销毁），
    // 不再手写 finish/error 监听——原先 finish 里同步 statSync 抛错会穿透成 uncaughtException
    await pipeline(audioResponse.data, fs.createWriteStream(outputPath));

    const stats = fs.statSync(outputPath);
    if (stats.size === 0) {
      // 上游 200 但空 body 对该 URL 是确定性失败——标 fatal 不浪费重试
      throw fatalError('下载内容为空');
    }
    // content-length 与落盘大小对账：framing 完整但服务端截断的残文件不能当完成
    // （截断是传输瞬时问题，保持可重试）
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
    // aborted 标记与歌词路径对称透传：processTask 靠它区分取消与可重试失败
    err.aborted = Boolean(error.aborted);
    err.fatal = Boolean(error.fatal);
    throw err;
  }
}

async function downloadLyrics(songId, outputPath, signal) {
  try {
    // 上游 lyric 模块是进程内调用，请求级 abort 传不进去——在调用前后各查一次
    // signal，取消语义不丢（请求本身时长很短，段间检查足够）
    if (signal?.aborted) {
      const err = new Error('已取消');
      err.aborted = true;
      throw err;
    }
    const response = await callNeteaseApi('lyric', { id: songId });
    if (signal?.aborted) {
      const err = new Error('已取消');
      err.aborted = true;
      throw err;
    }

    if (!response || !response.body || response.body.code !== 200) {
      throw new Error('无法获取歌词');
    }

    const lrc = response.body.lrc;
    if (!lrc || !lrc.lyric) {
      throw new Error('歌词不存在');
    }

    throwIfAborted(signal);
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
    const err = new Error(`下载歌词失败: ${describeError(error)}`);
    // 取消语义不得被包装吞掉——processTask 靠 aborted 标记区分取消与失败
    err.aborted = Boolean(error.aborted);
    err.fatal = Boolean(error.fatal);
    throw err;
  }
}

async function downloadCover(coverUrl, outputPath, signal) {
  try {
    if (!coverUrl) {
      throw fatalError('封面链接不存在');
    }

    throwIfAborted(signal);
    const dir = path.dirname(outputPath);
    fs.mkdirSync(dir, { recursive: true });

    const response = await fetchStream(coverUrl, { timeout: 60000, signal });
    if (response.status !== 200) {
      response.data.destroy();
      throw fatalError(`上游返回 ${response.status}`);
    }
    if (hasNonIdentityEncoding(response.headers)) {
      response.data.destroy();
      throw fatalError('上游返回了压缩内容，无法校验完整性');
    }

    const coverLength = parseInt(response.headers['content-length'], 10);
    if (coverLength > MAX_COVER_BYTES) {
      response.data.destroy();
      throw fatalError(`封面超过大小上限 ${MAX_COVER_BYTES}`);
    }
    let coverBytes = 0;
    watchStall(response.data, STALL_MS, 60000); // 与头超时对齐 60s
    response.data.on('data', (chunk) => {
      coverBytes += chunk.length;
      if (coverBytes > MAX_COVER_BYTES) {
        response.data.destroy(fatalError(`封面超过大小上限 ${MAX_COVER_BYTES}`));
      }
    });

    await pipeline(response.data, fs.createWriteStream(outputPath));

    const stats = fs.statSync(outputPath);
    if (stats.size === 0) {
      throw fatalError('下载内容为空');
    }
    // 封面同音频：服务端截断的残图不能当完成（截断瞬时，可重试）
    if (coverLength > 0 && stats.size !== coverLength) {
      throw new Error(`下载不完整（${stats.size}/${coverLength} 字节）`);
    }
    return {
      path: outputPath,
      size: stats.size
    };
  } catch (error) {
    removePartial(outputPath);
    const err = new Error(`下载封面失败: ${describeError(error)}`);
    err.aborted = Boolean(error.aborted);
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

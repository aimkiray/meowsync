const axios = require('axios');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { spawn, spawnSync } = require('child_process');
const { callNeteaseApi, resolveSongUrls } = require('./netease-api');
const { checkHostPublic, normalizeOutboundUrl, makeGuardedLookup } = require('../lib/net-guard');
const qq = require('../lib/qq');
const { resolveBiliAudio, resolveBiliMedia, BILI_PUBLIC_HEADERS } = require('../lib/bilibili');
const { fetchPlayer: ytFetchPlayer, fetchPlayerWith: ytFetchPlayerWith, pickStreamList: ytPickStreamList } = require('../lib/youtube');

// qq_<songmid> / bv_<bvid>[_pN] / yt_<videoId> 曲目的服务端下载分发：
// 各源自有流直取（不经网易云解锁链——别家曲库不是它们的源），
// 回落路径与网易云链同构（fetchStream SSRF 守卫 + streamToFile .part 对账）。
// 流地址宿主与 routes/qq.js 共用 lib/qq.js 的 QQ_STREAM_HOST_OK（sip 可能回
// 裸 IP——后缀判定天然拒绝）
const { QQ_SONG_ID_RE: QQ_ID_RE, BV_TRACK_ID_RE, YT_TRACK_ID_RE, NETEASE_ID_RE } = require('../../shared/predicates.js');
// RS01/F000=null：FLAC/Hi-Res 是 VBR，无固定码率可算——download-manager 的
// durationLooksTruncated 对 falsy br 短路跳过，完整性由 streamToFile 的
// content-length 对账兜底
const QQ_TIER_BR = { RS01: null, F000: null, M800: 320000, M500: 128000, C400: 96000 };

// 任务码率映射档梯：bitrate 是"目标下限"语义——<320k 的队列请求说明用户只要
// 省流量档，不给拉无损；>=320k（含默认）走完整档梯，归档取最优
const qqLadderFor = (br) => (br && br < 320000 ? ['M500', 'C400'] : qq.BEST_LADDER);

// LRC 译文合并：同刻时间戳的译文行插到原文行后（标准合并格式）；
// 译文无对应时间戳的孤儿行丢弃——贴错行比没译文更糟。
// 键归一到毫秒：lrc [00:01.23] 与 trans [00:01.230] 精度/补零不同
// 时严格字符串相等会静默丢整曲译文
function lrcTsKey(tag) {
  const m = tag.match(/^\[(\d+):(\d+(?:\.\d+)?)\]$/);
  return m ? Math.round((+m[1] * 60 + +m[2]) * 1000) : null;
}
function mergeLrcTrans(lrc, trans) {
  if (!trans || typeof trans !== 'string') return lrc;
  const transMap = new Map();
  for (const line of trans.split('\n')) {
    const m = line.match(/^(\[[\d:.]+\])\s*(.+)$/);
    const key = m && lrcTsKey(m[1]);
    if (key != null) transMap.set(key, { tag: m[1], text: m[2] });
  }
  if (!transMap.size) return lrc;
  return lrc.split('\n').map(line => {
    const m = line.match(/^(\[[\d:.]+\])/);
    const hit = m && transMap.get(lrcTsKey(m[1]));
    return hit ? `${line}\n${m[1]}${hit.text}` : line;
  }).join('\n');
}

// 下载 URL 来自上游 API/歌单元数据（网易云/解锁源），不是直接用户输入——但明文 http 源站
// 可被链路篡改成 302 到内网/云元数据地址，与 proxy.js 同一威胁模型：每跳都做公网校验
const MAX_REDIRECTS = 5;
const MAX_FILENAME_BYTES = 120;
// 体积上限：明文源站被 302 到无限流/超大文件的威胁模型下，写完再对账已经磁盘写满
const MAX_AUDIO_BYTES = 512 * 1024 * 1024;
const MAX_COVER_BYTES = 32 * 1024 * 1024;
// Windows 保留名：即便在 mac/linux 生成，用户最终可能在 Windows 上操作这些文件
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

// 解锁源实际回的非 mp3 格式白名单——URL path 后缀不在名单内一律回退 mp3/jpg，
// 防止上游注入怪异扩展名（.php/.html）落盘
const AUDIO_EXTS = new Set(['mp3', 'flac', 'm4a', 'aac', 'ogg', 'wav', 'webm']);
const COVER_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp']);

function sanitizeFilename(filename, maxBytes = MAX_FILENAME_BYTES) {
  let cleaned = String(filename || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    // 只剥孤立代理项（截断半个 UTF-8 字符/脏数据的产物）：D800-DFFF 全量匹配
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

// 确定性失败（版权限制/解锁失败/空文件声明/磁盘满）：标 fatal，上层不再重试白打上游
function fatalError(message) {
  const err = new Error(message);
  err.fatal = true;
  return err;
}

// 本地确定性失败 errno：磁盘满/配额满/只读文件系统/路径形态冲突/路径超长——
// 重试 N 次结果必然相同，全部映射成 fatal 终止重试。
// 不在列的：EPERM/EACCES（Windows 上杀软扫描、句柄释放延迟是瞬时的）、
// EMFILE/ENFILE（fd 压力随并发释放自愈）——这些重试可能成功
const FATAL_ERRNOS = new Set(['ENOSPC', 'EDQUOT', 'EROFS', 'ENAMETOOLONG', 'EISDIR', 'ENOTDIR', 'ENOTEMPTY', 'ELOOP', 'EFBIG']);
// POSIX 上 EACCES 是真权限拒绝（确定性），Windows 上它常与 EPERM 同义瞬时
if (process.platform !== 'win32') FATAL_ERRNOS.add('EACCES');
function errnoToFatal(error) {
  // ERR_DNS_GUARD_BLOCKED：guarded lookup 拦下私网/空结果/超时——
  // 对该 URL 是确定性拦截，重试必然同果
  if (error && (FATAL_ERRNOS.has(error.code) || error.code === 'ERR_DNS_GUARD_BLOCKED')) {
    error.fatal = true;
  }
  return error;
}

// 不可中止的上游阶段（解锁/取链）拖住协程可达数分钟，远超删除/停机排空预算——
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
  if (typeof error === 'string') return error;
  if (error?.message) return error.message;
  if (error?.body?.msg) return String(error.body.msg);
  if (error?.body?.code) return `上游错误 code=${error.body.code}`;
  return '未知错误';
}

// 流停滞看门狗：上游"响应头之后停流"会无限期占住并发工位（axios 的 timeout 是
// socket 空闲超时，与这里双保险）。data 事件刷新时间戳，超过 stallMs 无数据即毁流
// （错误冒泡到 pipeline，走正常失败路径）。停滞不标 fatal：重试会重跑取链/
// 解锁流程，可能换到健康源——TCP 拥塞性停滞不该一次判死任务。
// 已知盲区：写端背压（慢盘）与上游停滞都会停发 'data'，极端慢盘会被误判停滞
const STALL_MS = 30000;
function watchStall(stream, stallMs = STALL_MS, maxTotalMs = 0) {
  let lastData = Date.now();
  const started = Date.now();
  const onData = () => { lastData = Date.now(); };
  const timer = setInterval(() => {
    if (stream.destroyed) return;
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
  // 兜底吸收 destroy 后的迟到 'error'：不依赖 axios 内部监听，防 uncaughtException
  stream.on('error', () => {});
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
async function fetchStream(rawUrl, { timeout, signal, headers }) {
  let url = rawUrl;
  // 整次请求（含全部重定向跳）共享一张 pin 表：URL 阶段 checkHostPublic 与
  // 实际建连是两次独立解析（TOCTOU），socket 层 lookup 强制每次建连只能落
  // 在已验证的公网 IP 集上——见 net-guard.makeGuardedLookup
  const lookup = makeGuardedLookup();
  // keepAlive:false：下载是一次性长流，不留 keep-alive 复用；响应流 close
  // 时 socket 即关，agent 本体随 pin 表一起 GC 即可
  const agents = {
    httpAgent: new http.Agent({ lookup, keepAlive: false }),
    httpsAgent: new https.Agent({ lookup, keepAlive: false }),
  };
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const checked = normalizeOutboundUrl(url);
    if (!checked.ok) {
      throw fatalError(checked.reason);
    }
    const parsed = checked.url;
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
        // socket 层强制解析钉扎：跳与跳之间的建连都经 guarded lookup
        httpAgent: agents.httpAgent,
        httpsAgent: agents.httpsAgent,
        // identity + decompress:false：axios 默认透明解压且删掉 content-encoding 头，
        // 落盘字节与声明 content-length 不一致会让对账确定性误判"下载不完整"。
        // 关掉解压后若上游仍回编码内容，响应头里能看到——按上游违规判 fatal
        decompress: false,
        // 源站自带防盗链头的提供商（B 站 CDN 缺 Referer/UA 直接 403）由调用方下传
        headers: { 'Accept-Encoding': 'identity', ...headers },
        // 3xx 由本层处理以便逐跳校验；其余状态码进 catch 统一处理
        validateStatus: s => s >= 200 && s < 400
      });
    } catch (error) {
      // 4xx/5xx 的响应流无人消费会悬挂 keep-alive socket——显式销毁
      error.response?.data?.destroy?.();
      // 4xx（除 429）对该 URL 是确定性失败：重试三次白打上游。5xx/429/超时保留可重试
      const status = error.response?.status;
      if (status >= 400 && status < 500 && status !== 429) {
        // upstreamStatus 挂状态码——跨模块消费者（如 routes/youtube 的
        // 闸控探测）按码判定，不耦合 message 文案
        const err = fatalError(`上游返回 ${status}`);
        err.upstreamStatus = status;
        throw err;
      }
      throw errnoToFatal(error);
    }

    if (response.status >= 300 && response.status < 400) {
      response.data.destroy(); // 释放连接，不留悬挂 socket
      const location = response.headers.location;
      if (!location) throw fatalError(`上游重定向缺少 Location (${response.status})`);
      try {
        // 相对 Location（/path、//host/path）必须按当前跳为基解析——
        // 裸传给 normalizeOutboundUrl 会被判成无效 URL 误杀
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

// 半成品文件一律以 outputPath+'.part' 落盘，完成后 renameSync 就位：
// - 下载中/崩溃残留永远是 .part，最终路径上不会出现半截文件；
// - 重试不再 truncate 已完成的同名文件（旧文件只在新文件完整校验后被替换）；
// - 崩溃残留的 .part 永不入库登记，启动期 reapOrphanFiles"未登记即删"必然收走
function removePartial(partPath) {
  try {
    if (fs.existsSync(partPath)) {
      fs.unlinkSync(partPath);
    }
  } catch {
    // Windows 下句柄未释放时 unlink 会失败——残留 .part 由清扫路径兜底
  }
}

// 音频/封面共用的"响应流 → .part → 校验 → rename 就位"骨架
// 返回 {path(最终路径), size}
async function streamToFile(response, outputPath, { maxBytes, onProgress, maxTotalMs }) {
  const partPath = `${outputPath}.part`;
  try {
    // decompress:false 下 content-encoding 可见：上游回非 identity 编码时
    // content-length 与落盘字节不可对账——确定性违规，不浪费时间传完
    if (hasNonIdentityEncoding(response.headers)) {
      response.data.destroy();
      throw fatalError('上游返回了压缩内容，无法校验完整性');
    }
    const totalLength = parseInt(response.headers['content-length'], 10);
    // 声明就已超限：headers 到手即拒，不把上限先流一遍
    if (totalLength > maxBytes) {
      response.data.destroy();
      throw fatalError(`文件超过大小上限 ${maxBytes}`);
    }

    let downloadedLength = 0;
    let lastProgress = -1;
    // 顺序前提：watchStall/计数监听与 pipeline 必须在同一同步 tick 附着——
    // 'data' 监听让流进入 flowing，中间插 await 会丢 chunk
    watchStall(response.data, STALL_MS, maxTotalMs);
    response.data.on('data', (chunk) => {
      downloadedLength += chunk.length;
      // 超限即毁流——pipeline 会把该错误冒泡，removePartial 清残片
      if (downloadedLength > maxBytes) {
        response.data.destroy(fatalError(`文件超过大小上限 ${maxBytes}`));
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

    // pipeline 任一端出错都会销毁两侧流（abort 时 axios 流 reject → writer 同步销毁）
    await pipeline(response.data, fs.createWriteStream(partPath));

    const stats = fs.statSync(partPath);
    if (stats.size === 0) {
      // 上游 200 但空 body 对该 URL 是确定性失败——标 fatal 不浪费重试
      throw fatalError('下载内容为空');
    }
    // content-length 与落盘大小对账：
    // - 小于声明 = 服务端截断（瞬时传输问题，可重试）
    // - 大于声明 = 上游虚报 length（确定性违规，重试结果相同）→ fatal
    if (totalLength > 0 && stats.size > totalLength) {
      throw fatalError(`上游虚报长度（${stats.size}/${totalLength} 字节）`);
    }
    if (totalLength > 0 && stats.size !== totalLength) {
      throw new Error(`下载不完整（${stats.size}/${totalLength} 字节）`);
    }
    // 校验全部通过才替换就位——半途失败留下的是 .part 残片，旧完整文件不动
    fs.renameSync(partPath, outputPath);
    return { path: outputPath, size: stats.size };
  } catch (error) {
    removePartial(partPath);
    throw errnoToFatal(error);
  }
}

// googlevideo 等 URL path 无后缀，扩展名藏在 mime=audio/mp4 查询参数里
const MIME_EXT = { 'audio/mp4': 'm4a', 'video/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a', 'audio/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/x-flac': 'flac', 'image/png': 'png', 'image/webp': 'webp', 'image/jpeg': 'jpg' };

// 从已解析的下载 URL 推断落盘扩展名：优先 path 后缀（白名单过滤），
// 其次 mime= 查询参数（googlevideo 系），都不在名单内一律回默认——
// 防止上游注入怪异扩展名（.php/.html）落盘
function extFromUrl(rawUrl, allowed, fallback) {
  try {
    const u = new URL(rawUrl);
    const m = u.pathname.match(/\.([a-z0-9]{2,5})$/i);
    const ext = m && m[1].toLowerCase();
    if (ext && allowed.has(ext)) return ext;
    const mime = (u.searchParams.get('mime') || '').toLowerCase();
    const mimeExt = mime && MIME_EXT[mime];
    return mimeExt && allowed.has(mimeExt) ? mimeExt : fallback;
  } catch {
    return fallback;
  }
}

// outputPath 是锁键占位路径（.mp3/.jpg 后缀参与并发互斥）——真实扩展名取决于
// 解锁后 URL（youtube 回链多为 m4a 等），实际文件按 extFromUrl 换后缀落盘，
// 返回的 path 才是写库/清理要用的真实路径
function pathWithExt(outputPath, ext) {
  return outputPath.replace(/\.[a-z0-9]+$/i, `.${ext}`);
}

// 外部导入曲（bv_/yt_）下载：从各自网站直取最优音轨——prefer='best' 下
// B 站拿 Hi-Res FLAC/杜比轨（BILI_COOKIE 有权限才下发，否则回落最高码率
// AAC），YouTube 拿 opus251；不经网易云解锁链。候选档降序铺开，单链
// 403/断流换下一档——备份 URL 已在 resolve 侧摊平成同一数组。
// 一轮全灭重解一次：每次 resolve 拿到的签名批绑到同一 CDN 边缘节点，
// 实测 googlevideo 出现过整批 403 换批即愈——单批候选间换档救不了这种故障
// 部分 googlevideo 流拒全量 GET（实测 403）——bytes=0- 语义等同全量，
// 走 206 通道绕开；B 站 CDN 带上也无副作用（其防盗链只认 Referer/UA）
const RANGE_ALL = { Range: 'bytes=0-' };

// streamingData.formats 里的 progressive mp4 合流档——SABR 闸控视频下
// 唯一可全量拉取的物料（自适应流的 Range 只放首段窗，实测中段/全量
// 一律 403）。按分辨率降序，音视频相位共用同一张兜底表
function pickYtProgressive(sd) {
  return (Array.isArray(sd?.formats) ? sd.formats : [])
    .filter(f => typeof f?.url === 'string' && f.url
      && (f.mimeType || '').startsWith('video/mp4'))
    .sort((a, b) => ((b.height || 0) * (b.width || 0)) - ((a.height || 0) * (a.width || 0)))
    .map(f => ({ url: f.url, mimeType: f.mimeType || '', br: f.bitrate || null, h: f.height || 0 }));
}

async function downloadExternalAudio(bvM, ytM, outputPath, onProgress, signal, providerData) {
  // B 站 CDN 缺 Referer/UA 直接 403；googlevideo 自带签名不需要附加头
  const headers = bvM ? { ...BILI_PUBLIC_HEADERS, ...RANGE_ALL } : RANGE_ALL;
  // 每轮解析给两类物料：自适应音轨（优先，纯音轨体积小/频带宽）与
  // progressive 合流兜底（仅 yt——B 站侧无闸控形态观测，不徒增复杂度）
  let clientEscalated = false;
  let progressiveCarry = [];
  const resolveCandidates = async () => {
    if (bvM) {
      const b = providerData?.bilibili || {};
      return {
        adaptive: await resolveBiliAudio({
          bvid: b.bvid || bvM[1],
          cid: b.cid,
          page: +b.page || +bvM[2] || 1,
          signal
        }),
        progressive: []
      };
    }
    const videoId = providerData?.youtube?.videoId || ytM[1];
    // 第二轮起升级 VISIONOS 直解：ANDROID/IOS 批被 SABR 闸控（首段窗外全
    // 403）时换签名体系——实测同一批自适应流它完全不受限，能拿到真最高
    // 音质 opus251；首轮解析自身失败时它也顺带当第三客户端兜底
    if (clientEscalated) {
      console.info(`[youtube] ${videoId} 自适应流批次不可用——升级 VISIONOS 签名批重解`);
    }
    const player = clientEscalated
      ? await ytFetchPlayerWith(videoId, signal, 'VISIONOS')
      : await ytFetchPlayer(videoId, signal);
    clientEscalated = true;
    const sd = player.streamingData || {};
    // progressive 跨轮结转：VISIONOS 不一定回 formats——保住上一轮已
    // 验证可拉的合流兜底档，别因换客户端丢掉最后的活路
    const prog = pickYtProgressive(sd);
    if (prog.length) progressiveCarry = prog;
    return {
      adaptive: ytPickStreamList(sd, 'audio', 'best')
        .map(f => ({ url: f.url, mimeType: f.mimeType || '', br: f.bitrate || null })),
      progressive: progressiveCarry
    };
  };
  let lastErr = null;
  for (let round = 0; round < 2; round++) {
    let lists;
    try {
      lists = await resolveCandidates();
    } catch (e) {
      // abort 是最高优先语义——上游库抛的 Error('aborted') 无 aborted 标记，
      // 以 signal 为地面真相，别让取消被吞成可重试失败
      throwIfAborted(signal);
      // resolve 段的非致命上游错（412 风控/瞬断）也吃重解红利；fatal/abort 穿透
      if (e?.fatal || e?.aborted) throw e;
      lastErr = e;
      continue;
    }
    if (!lists.adaptive.length && !lists.progressive.length) {
      throw fatalError(`${bvM ? 'B 站' : 'YouTube'} 无可下载音轨`);
    }
    // mkdir 提到候选循环外：ENOSPC/EACCES 这类确定性 errno 若在 try 内会
    // 因无 fatal 标记而遍历所有候选空转——放外面直接穿透到顶层 errnoToFatal。
    // 先查 abort：resolve 返回与 mkdir 之间的取消窗口不该复活已清扫的目录骨架
    throwIfAborted(signal);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    for (const cand of lists.adaptive) {
      throwIfAborted(signal);
      try {
        const resp = await fetchStream(cand.url, { timeout: 300000, signal, headers });
        if (resp.status !== 200 && resp.status !== 206) {
          resp.data.destroy();
          continue;
        }
        // 扩展名按真实容器判：响应 Content-Type（最诚实）→ 流表 mimeType → URL
        // mime=/path——B 站 flac 轨 url 无后缀，靠 content-type 落 .flac
        const mime = (String(resp.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
          || String(cand.mimeType || '').split(';')[0].trim().toLowerCase());
        const ext = MIME_EXT[mime] || extFromUrl(cand.url, AUDIO_EXTS, 'm4a');
        const finalPath = pathWithExt(outputPath, ext);
        const saved = await streamToFile(resp, finalPath, {
          maxBytes: MAX_AUDIO_BYTES, onProgress, maxTotalMs: 300000
        });
        return {
          path: saved.path, size: saved.size, url: cand.url,
          // br 供时长对账：B 站 bandwidth / YouTube bitrate 都是 bps 真实码率；
          // 均非解锁回链——unblocked 保持 false，source 仅留痕不进徽章语义
          br: cand.br ?? null,
          unblocked: false, unblockedSource: null
        };
      } catch (e) {
        throwIfAborted(signal);   // fetch 的 AbortError DOMException 同样无标记
        if (e?.aborted) throw e;  // 取消语义穿透候选循环
        // 上游 4xx fatal 只判死本条 URL；带 errno 的本地确定性失败才穿透
        if (e?.fatal && e?.code) throw e;
        lastErr = e;
      }
    }
    // 本轮自适应全灭不急着动 progressive——下一轮升级 VISIONOS 可能拿回
    // 不受闸的更高档（闸控视频的 opus251 vs 合流 AAC 差距悬殊）；合流兜底
    // 只在客户端阶梯用尽后出场
  }
  // 自适应全阶梯全灭（极端闸控/仅 progressive 的老视频）→ 合流兜底：
  // ffmpeg 在则 -vn -c:a copy 抽 AAC 轨落 m4a；缺席则合流 mp4 原样作
  // 音频工件——浏览器按容器嗅探照播，代价是文件里多带一路视频轨
  for (const cand of progressiveCarry) {
    throwIfAborted(signal);
    const tmpPath = `${outputPath}.prog.mp4`;
    try {
      const resp = await fetchStream(cand.url, { timeout: 300000, signal, headers });
      if (resp.status !== 200 && resp.status !== 206) {
        resp.data.destroy();
        continue;
      }
      fs.mkdirSync(path.dirname(tmpPath), { recursive: true });
      const saved = await streamToFile(resp, tmpPath, {
        maxBytes: MAX_VIDEO_BYTES, onProgress, maxTotalMs: 300000
      });
      // progressive 的 f.bitrate 是音画容器总码率——抽出来的纯音轨/或是
      // 留下的 mp4 都不能拿它当音频码率报，给下游对账一个错值不如给 null
      if (!FFMPEG_OK) {
        const finalPath = pathWithExt(outputPath, 'mp4');
        fs.renameSync(saved.path, finalPath);
        return {
          path: finalPath, size: saved.size, url: cand.url,
          br: null, unblocked: false, unblockedSource: null
        };
      }
      const finalPath = pathWithExt(outputPath, 'm4a');
      await ffmpegExtractAudio(saved.path, finalPath, signal);
      return {
        path: finalPath, size: fs.statSync(finalPath).size, url: cand.url,
        br: null, unblocked: false, unblockedSource: null
      };
    } catch (e) {
      throwIfAborted(signal);
      if (e?.aborted || (e?.fatal && e?.code)) throw e;
      lastErr = e;
    } finally {
      // ffmpeg 抽完/全灭后清掉合流中间件——它不该成为最终工件
      try { fs.unlinkSync(tmpPath); } catch { /* 未产即空/已改名 */ }
    }
  }
  throw lastErr || fatalError('外部源所有候选流均失败');
}

// ── 外部源视频下载（bv_/yt_ 任务的 downloadVideo 工件）──────────────────
// ffmpeg 在：adaptive 最高画质视频轨（avc1 分辨率降序）+ AAC 音轨 -c copy 合流，
//   不重编码即真·源画质；音轨刻意用常规档——opus/flac/杜比塞不进 mp4 容器。
// ffmpeg 缺席：回落源站 MP4 合流档（YouTube formats / B 站 fnval=1 durl），
//   分辨率受合流档限制但产物自包含可播；两者皆无才报失败。
const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;

const FFMPEG_OK = (() => {
  try {
    return spawnSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' }).status === 0;
  } catch { return false; }
})();

// -c copy 纯封装不重编码：音乐视频尺度下秒级完成。out 先落 .mux 再 rename——
// ffmpeg 直接写最终路径时崩溃会留半截 .mp4，与 .part 语义同构
function ffmpegMux(videoPath, audioPath, outPath, signal) {
  return new Promise((resolve, reject) => {
    const muxPath = `${outPath}.mux`;
    const child = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', videoPath, '-i', audioPath,
      // .mux 中间态后缀 ffmpeg 猜不出封装格式——必须显式 -f mp4
      '-c', 'copy', '-f', 'mp4', '-movflags', '+faststart', muxPath
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let errTail = '';
    child.stderr.on('data', d => { errTail = (errTail + d).slice(-500); });
    const onAbort = () => { try { child.kill('SIGKILL'); } catch { /* 进程已退 */ } };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => { signal?.removeEventListener('abort', onAbort); reject(e); });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      const fail = (err) => {
        // reject 路径清 .mux 半截——别让残片活到下次启动 reap
        try { fs.unlinkSync(muxPath); } catch { /* 未产即空 */ }
        reject(err);
      };
      if (signal?.aborted) {
        // abort 也走 fail——SIGKILL 中途正是最可能留半截 .mux 的路径
        const e = new Error('已取消');
        e.aborted = true;
        return fail(e);
      }
      if (code !== 0) return fail(new Error(`ffmpeg 合流失败(${code}): ${errTail || '无输出'}`));
      try {
        fs.renameSync(muxPath, outPath);
        resolve(outPath);
      } catch (e) { fail(errnoToFatal(e)); }
    });
  });
}

// progressive mp4 → 抽 AAC 音轨落 m4a（SABR 闸控视频的音频兜底产物）。
// 与 ffmpegMux 同构：.mux 中间态 + 崩溃不留半截最终件 + abort 杀进程
function ffmpegExtractAudio(inPath, outPath, signal) {
  return new Promise((resolve, reject) => {
    const muxPath = `${outPath}.mux`;
    const child = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', inPath, '-vn', '-c:a', 'copy',
      // m4a 的规范封装是 ipod muxer（MP4 变体）；.mux 中间态后缀不可推断，显式给
      '-f', 'ipod', muxPath
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let errTail = '';
    child.stderr.on('data', d => { errTail = (errTail + d).slice(-500); });
    const onAbort = () => { try { child.kill('SIGKILL'); } catch { /* 进程已退 */ } };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => { signal?.removeEventListener('abort', onAbort); reject(e); });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      const fail = (err) => {
        try { fs.unlinkSync(muxPath); } catch { /* 未产即空 */ }
        reject(err);
      };
      if (signal?.aborted) {
        const e = new Error('已取消');
        e.aborted = true;
        return fail(e);
      }
      if (code !== 0) return fail(new Error(`ffmpeg 抽轨失败(${code}): ${errTail || '无输出'}`));
      try {
        fs.renameSync(muxPath, outPath);
        resolve(outPath);
      } catch (e) { fail(errnoToFatal(e)); }
    });
  });
}

async function downloadExternalVideo(bvM, ytM, outputPath, onProgress, signal, providerData) {
  const headers = bvM ? { ...BILI_PUBLIC_HEADERS, ...RANGE_ALL } : RANGE_ALL;
  // 一轮解析给三类物料：自适应视频轨、合流用 AAC 音轨、MP4 合流兜底
  let clientEscalated = false;
  let progressiveCarry = [];
  const resolveMedia = async () => {
    if (bvM) {
      const b = providerData?.bilibili || {};
      return await resolveBiliMedia({
        bvid: b.bvid || bvM[1], cid: b.cid, page: +b.page || +bvM[2] || 1, signal
      });
    }
    const videoId = providerData?.youtube?.videoId || ytM[1];
    // 同音频侧口径：第二轮升级 VISIONOS 签名批，闸控视频换它才拿得到
    // 自适应高画质轨
    if (clientEscalated) {
      console.info(`[youtube] ${videoId} 自适应视频批不可用——升级 VISIONOS 签名批重解`);
    }
    const player = clientEscalated
      ? await ytFetchPlayerWith(videoId, signal, 'VISIONOS')
      : await ytFetchPlayer(videoId, signal);
    clientEscalated = true;
    const sd = player.streamingData || {};
    const prog = pickYtProgressive(sd);
    if (prog.length) progressiveCarry = prog;
    return {
      videos: ytPickStreamList(sd, 'video', 'best')
        .map(f => ({ url: f.url, mimeType: f.mimeType || '', br: f.bitrate || null, h: f.height || 0 })),
      audios: ytPickStreamList(sd, 'audio')
        .map(f => ({ url: f.url, mimeType: f.mimeType || '', br: f.bitrate || null })),
      progressive: async () => progressiveCarry
    };
  };
  const fetchTo = async (cand, dest, base, span) => {
    const resp = await fetchStream(cand.url, { timeout: 300000, signal, headers });
    if (resp.status !== 200 && resp.status !== 206) {
      resp.data.destroy();
      throw new Error(`上游返回 ${resp.status}`);
    }
    return await streamToFile(resp, dest, {
      maxBytes: MAX_VIDEO_BYTES,
      onProgress: onProgress && ((p) => onProgress(base + Math.floor(p * span / 100))),
      maxTotalMs: 300000
    });
  };
  let lastErr = null;
  let lastMedia = null;
  for (let round = 0; round < 2; round++) {
    let media;
    try {
      media = await resolveMedia();
    } catch (e) {
      throwIfAborted(signal);
      if (e?.fatal || e?.aborted) throw e;
      lastErr = e;
      continue;
    }
    lastMedia = media;
    throwIfAborted(signal);
    const videoDir = path.dirname(outputPath);
    fs.mkdirSync(videoDir, { recursive: true });
    // 匿名 B 站 DASH 在低热度稿封顶 480p，而 durl 合流档能给到 720p——
    // 自适应最优低于 720p 时才多打这一跳比高（更高清就先用合流直落，
    // 自带音轨连 ffmpeg 都省）。yt 合流天花板 360p 天然走不进此分支
    const bestH = media.videos[0]?.h || 0;
    if (bestH && bestH < 720) {
      let prog = null;
      try {
        prog = await media.progressive();
      } catch (e) {
        throwIfAborted(signal);
        if (e?.fatal && e?.code) throw e;
        lastErr = lastErr || e;
      }
      if (prog && (prog[0]?.h || 0) > bestH) {
        console.info(`[video-dl] 合流档 ${prog[0].h}p 反超自适应 ${bestH}p——直落合流`);
        for (const cand of prog) {
          throwIfAborted(signal);
          try {
            const saved = await fetchTo(cand, outputPath, 0, 100);
            return { path: saved.path, size: saved.size, url: cand.url };
          } catch (e) {
            throwIfAborted(signal);
            if (e?.fatal && e?.code) throw e;
            lastErr = e;
          }
        }
      }
    }
    if (FFMPEG_OK && media.videos.length && !media.audios.length) {
      // 音轨表为空时逐候选白下整段视频注定在合流前抛——记语义错误
      // 直接换下一轮/相位（下一轮重解可能拿到带音轨的批）
      lastErr = lastErr || new Error('该视频无可用音轨，无法合流');
    } else if (FFMPEG_OK && media.videos.length) {
      // 音轨跨视频候选复用——换视频档重下音轨是纯浪费
      let audioTmp = null;
      try {
        for (const v of media.videos) {
          throwIfAborted(signal);
          const videoTmp = `${outputPath}.v${media.videos.indexOf(v)}`;
          try {
            await fetchTo(v, videoTmp, 0, 75);
            if (!audioTmp) {
              // 音轨落盘成功才置位——置位先行会让下一个视频候选对着不
              // 存在的 .audio 合流，且整批音轨失去重试机会
              const tmp = `${outputPath}.audio`;
              let audioOk = false;
              for (const a of media.audios) {
                try { await fetchTo(a, tmp, 75, 15); audioOk = true; break; } catch (e) {
                  throwIfAborted(signal);
                  if (e?.fatal && e?.code) throw e;
                  lastErr = e;
                }
              }
              if (!audioOk) {
                try { fs.unlinkSync(tmp); } catch { /* 未产即空 */ }
                throw lastErr || new Error('音轨候选全部失败');
              }
              audioTmp = tmp;
            }
            await ffmpegMux(videoTmp, audioTmp, outputPath, signal);
            onProgress && onProgress(100);
            const size = fs.statSync(outputPath).size;
            return { path: outputPath, size, url: v.url };
          } catch (e) {
            throwIfAborted(signal);
            // 上游 4xx 的 fatal 只判死这一条 URL——换候选；带 errno 的本地
            // 确定性失败（ENOSPC/EROFS）才是真穿透，候选级循环不该为它空转
            if (e?.fatal && e?.code) throw e;
            lastErr = e;
          } finally {
            try { fs.unlinkSync(videoTmp); } catch { /* 未产即空 */ }
          }
        }
      } finally {
        if (audioTmp) { try { fs.unlinkSync(audioTmp); } catch { /* 已清 */ } }
      }
    }
    // 本轮自适应全灭不动 progressive——下一轮 VISIONOS 升级批可能拿回
    // 不受闸的高画质轨；合流兜底只在客户端阶梯用尽后出场
  }
  // 自适应阶梯用尽/无 ffmpeg → MP4 合流兜底（B 站 thunk 懒取 durl；
  // yt 走跨轮结转的 formats 批——VISIONOS 不回 formats 时仍有 ANDROID 的）。
  // thunk 瞬时失败记 lastErr 而非吞成"无合流格式"——412/超时这类错误
  // 是可重试的，不能因为消息撒谎再叠个 fatal 把重试权判死
  const progressive = lastMedia
    ? await lastMedia.progressive().catch(e => {
        throwIfAborted(signal);
        lastErr = e;
        return progressiveCarry;
      })
    : progressiveCarry;
  for (const cand of progressive.length ? progressive : progressiveCarry) {
    throwIfAborted(signal);
    try {
      const saved = await fetchTo(cand, outputPath, 0, 100);
      return { path: saved.path, size: saved.size, url: cand.url };
    } catch (e) {
      throwIfAborted(signal);
      if (e?.fatal && e?.code) throw e;
      lastErr = e;
    }
  }
  if (!FFMPEG_OK && !progressive.length && !progressiveCarry.length && !lastErr) {
    lastErr = fatalError(
      `${bvM ? 'B 站' : 'YouTube'} 未提供合流格式且未检测到 ffmpeg——安装 ffmpeg 才能下载高画质视频`
    );
  }
  throw lastErr || fatalError('外部源视频流全部候选均失败');
}

// 视频工件分发：只有 bv_/yt_ 有源站视频可取——别的源不该带 download_video 位
async function downloadVideo(songId, outputPath, onProgress, signal, providerData) {
  try {
    const bvM = String(songId).match(BV_TRACK_ID_RE);
    const ytM = !bvM && String(songId).match(YT_TRACK_ID_RE);
    if (!bvM && !ytM) {
      throw fatalError('该来源不支持视频下载');
    }
    return await downloadExternalVideo(bvM, ytM, outputPath, onProgress, signal, providerData);
  } catch (error) {
    errnoToFatal(error);
    const err = new Error(`下载视频失败: ${describeError(error)}`);
    err.code = error.code;
    err.aborted = Boolean(error.aborted) || error.code === 'ERR_CANCELED' || signal?.aborted;
    err.fatal = Boolean(error.fatal);
    throw err;
  }
}

// providerData：任务行快照的源私有字段（{qq:{mediaMid}}/{bilibili:{bvid,cid,page}}/
// {youtube:{videoId}}）——mediaMid 是 vkey filename 键，带了可省一次注定失败的
// vkey 空调用 + detail 回填往返；缺省/过期都安全，各解析器内部仍兜底
async function downloadAudio(songId, outputPath, bitrate = 320000, onProgress, signal, providerData) {
  try {
    // bv_<bvid>[_pN] / yt_<videoId> 分发：自有站直链
    const bvM = String(songId).match(BV_TRACK_ID_RE);
    const ytM = !bvM && String(songId).match(YT_TRACK_ID_RE);
    if (bvM || ytM) {
      return await downloadExternalAudio(bvM, ytM, outputPath, onProgress, signal, providerData);
    }
    // qq_<songmid> 分发：QQ 源直链（BEST 档梯）→ 同一条 fetchStream 守卫管线
    const qqM = String(songId).match(QQ_ID_RE);
    if (qqM) {
      const hit = await qq.pickStreamUrl(qqM[1], {
        mediaMid: providerData?.qq?.mediaMid || '',
        ladder: qqLadderFor(bitrate),
        signal
      });
      if (!hit) throw fatalError('QQ 音乐无可用音源（可能需要 VIP 权限或地域限制）');
      throwIfAborted(signal);
      const finalPath = pathWithExt(outputPath, qq.QUALITY_TIERS[hit.tier]?.ext || 'm4a');
      fs.mkdirSync(path.dirname(finalPath), { recursive: true });
      const resp = await fetchStream(hit.url, { timeout: 300000, signal });
      if (resp.status !== 200 && resp.status !== 206) {
        resp.data.destroy();
        throw fatalError(`上游返回 ${resp.status}`);
      }
      const saved = await streamToFile(resp, finalPath, {
        maxBytes: MAX_AUDIO_BYTES, onProgress, maxTotalMs: 300000
      });
      return {
        path: saved.path, size: saved.size, url: hit.url,
        br: QQ_TIER_BR[hit.tier] ?? null,
        unblocked: false, unblockedSource: `qq/${hit.tier}`
      };
    }
    // 进程内直调上游模块 + 共享解锁后处理（purpose=download：不走 audio-proxy），
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
    // signal 透传进解锁链：任务取消/排空时逐源中止——否则已 abort 的任务
    // 仍要把整条解锁链（song_detail + 4源试错 + HEAD 探测，最坏分钟级）
    // 跑完才在下方 throwIfAborted 被发现
    await resolveSongUrls(items, { purpose: 'download', signal });

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
    // 扩展名按真实来源修正（youtube→m4a 等）：路径互斥锁仍挂在占位 .mp3 键上，
    // 互斥语义不变（同一歌单同曲永远同键），只是落盘文件名更诚实
    const finalPath = pathWithExt(outputPath, extFromUrl(songData.url, AUDIO_EXTS, 'mp3'));
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });

    const audioResponse = await fetchStream(songData.url, { timeout: 300000, signal });
    if (audioResponse.status !== 200 && audioResponse.status !== 206) {
      audioResponse.data.destroy();
      throw fatalError(`上游返回 ${audioResponse.status}`);
    }

    const saved = await streamToFile(audioResponse, finalPath, {
      maxBytes: MAX_AUDIO_BYTES,
      onProgress,
      maxTotalMs: 300000 // 总时长与头超时对齐 5min
    });
    return {
      path: saved.path,
      size: saved.size,
      url: songData.url,
      // 落盘后时长对账需要**文件真实码率**：解锁源的 item.br 仍是网易声明值
      // （请求 320k 时恒 320000），真实码率在 unblockedBr（youtube 常 130k）——
      // 用错分母会把完整文件误判成剪辑
      br: songData.unblockedBr ?? songData.br ?? null,
      unblocked: songData.unblocked || false,
      unblockedSource: songData.unblockedSource || null
    };
  } catch (error) {
    errnoToFatal(error);
    const err = new Error(`下载音频失败: ${describeError(error)}`);
    err.code = error.code;
    // aborted/fatal 标记对称透传：processTask 靠它们区分取消/可重试/确定性失败
    err.aborted = Boolean(error.aborted) || error.code === 'ERR_CANCELED';
    err.fatal = Boolean(error.fatal);
    throw err;
  }
}

async function downloadLyrics(songId, outputPath, signal, providerData) {
  try {
    // 上游 lyric 模块是进程内调用，请求级 abort 传不进去——在调用前后各查一次
    // signal，取消语义不丢（请求本身时长很短，段间检查足够）
    if (signal?.aborted) {
      const err = new Error('已取消');
      err.aborted = true;
      throw err;
    }
    // bv_/yt_ 导入曲的词源是导入时匹配到的网易云 id（providerData.neteaseId）——
    // 无匹配即无词源，按 NO_LYRICS 判「缺词不算失败」，别让外部曲死等歌词段
    const extM = String(songId).match(BV_TRACK_ID_RE) || String(songId).match(YT_TRACK_ID_RE);
    if (extM && !NETEASE_ID_RE.test(String(providerData?.neteaseId ?? ''))) {
      const err = new Error('歌词不存在');
      err.code = 'NO_LYRICS';
      throw err;
    }
    const lyricId = extM ? String(providerData.neteaseId) : songId;
    const qqLm = String(lyricId).match(QQ_ID_RE);
    // qq 侧：无词曲（空 lyric 或上游业务码 -1901/-1301 等）映射成 NO_LYRICS——
    // 与网易云链同口径判「缺词不算失败」，否则音画已下完的任务会因歌词段重试
    // 耗尽被标 failed；传输层错误（无 bizCode 标记）照旧抛走重试
    const response = qqLm
      ? await qq.getLyric(qqLm[1], signal)
        .then(r => ({ body: { code: 200, lrc: { lyric: r.lyric || '' }, trans: r.trans || '' } }))
        .catch(e => {
          if (e && e.bizCode !== undefined) {
            const err = new Error('歌词不存在');
            err.code = 'NO_LYRICS';
            throw err;
          }
          throw e;
        })
      : await callNeteaseApi('lyric', { id: lyricId });
    if (signal?.aborted) {
      const err = new Error('已取消');
      err.aborted = true;
      throw err;
    }

    if (!response || !response.body || response.body.code !== 200) {
      throw new Error('无法获取歌词');
    }

    const lrc = response.body.lrc;
    if (!lrc || typeof lrc.lyric !== 'string' || !lrc.lyric) {
      // code 契约而非消息串匹配——下游按 NO_LYRICS 判定"缺词不算失败"；
      // 非字符串 lyric 是上游畸形数据，与缺词同待遇（确定性，不该重试）
      const err = new Error('歌词不存在');
      err.code = 'NO_LYRICS';
      throw err;
    }

    // 官方译文按同刻时间戳插到原文行后落盘（标准合并 LRC 格式——播放器
    // 同刻双行显示原文+译文；网易 tlyric 与 QQ trans 同口径处理）
    const trans = qqLm ? response.body.trans : response.body.tlyric?.lyric;
    const lyricText = mergeLrcTrans(lrc.lyric, trans);

    throwIfAborted(signal);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    const partPath = `${outputPath}.part`;
    try {
      fs.writeFileSync(partPath, lyricText, 'utf-8');
      fs.renameSync(partPath, outputPath);
    } catch (writeError) {
      removePartial(partPath); // 写一半失败不留孤儿 .lrc.part
      throw writeError;
    }

    return {
      path: outputPath,
      size: Buffer.byteLength(lyricText, 'utf-8')
    };
  } catch (error) {
    if (error.code === 'NO_LYRICS') {
      throw error;
    }
    errnoToFatal(error);
    const err = new Error(`下载歌词失败: ${describeError(error)}`);
    err.code = error.code;
    // 取消语义不得被包装吞掉——processTask 靠 aborted 标记区分取消与失败
    err.aborted = Boolean(error.aborted) || error.code === 'ERR_CANCELED';
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
    const finalPath = pathWithExt(outputPath, extFromUrl(coverUrl, COVER_EXTS, 'jpg'));
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });

    const response = await fetchStream(coverUrl, { timeout: 60000, signal });
    if (response.status !== 200) {
      response.data.destroy();
      throw fatalError(`上游返回 ${response.status}`);
    }

    const saved = await streamToFile(response, finalPath, {
      maxBytes: MAX_COVER_BYTES,
      maxTotalMs: 60000 // 与头超时对齐 60s
    });
    return { path: saved.path, size: saved.size };
  } catch (error) {
    errnoToFatal(error);
    const err = new Error(`下载封面失败: ${describeError(error)}`);
    err.code = error.code;
    err.aborted = Boolean(error.aborted) || error.code === 'ERR_CANCELED';
    err.fatal = Boolean(error.fatal);
    throw err;
  }
}

module.exports = {
  downloadAudio,
  downloadLyrics,
  downloadCover,
  downloadVideo,
  sanitizeFilename,
  fetchStream
};

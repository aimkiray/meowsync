// 下载链路的字节流原语层——无 provider/队列知识：SSRF 守卫式 fetch、
// .part 对账落盘、失速看门狗、文件名清洗、LRC 译文合并。
// file-downloader（provider 媒体编排）与 download-fs（路径助手）都建立在本层之上。
const axios = require('axios');
const http = require('http');
const https = require('https');
const fs = require('fs');
const { pipeline } = require('stream/promises');
const { checkHostPublic, normalizeOutboundUrl, makeGuardedLookup } = require('../lib/net-guard');
// YouTube 出站代理（yt_proxy）：googlevideo 拉流/SABR 探测/ytimg 封面命中
// 时整跳换隧道型 agent 对——判定与隧道装配在 lib/yt-proxy.js，
// 未配/非 YT 域一律 null 短路走原样
const { ytAxiosProxyFor } = require('../lib/yt-proxy');

// LRC 译文合并：实现收敛在共享层 src/shared/lrc.js mergeLrcText——
// 与播放面 mergeTranslations 同窗口（0.5s）同最近邻策略，毫秒级
// 偏差的译文不再对不上键（旧实现按整毫秒键严格相等会静默丢译
// 文）；同文行不重复贴（AI 译文未译行是原文占位），译文无对应
// 时间戳的孤儿行照旧丢弃——贴错行比没译文更糟
const { mergeLrcText } = require('../../shared/lrc.js');
const mergeLrcTrans = (lrc, trans) =>
  (trans && typeof trans === 'string' ? mergeLrcText(lrc, trans) : lrc);

// 下载 URL 来自上游 API/歌单元数据（网易云/解锁源），不是直接用户输入——但明文 http 源站
// 可被链路篡改成 302 到内网/云元数据地址，与 proxy.js 同一威胁模型：每跳都做公网校验
const MAX_REDIRECTS = 5;
const MAX_FILENAME_BYTES = 120;
// Windows 保留名：即便在 mac/linux 生成，用户最终可能在 Windows 上操作这些文件
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

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
// EMFILE/ENFILE（fd 压力随并发释放自愈）——这些重试可能成功；
// EFBIG 也不在——它是「这条候选体积超限」的候选级确定性（FAT32 落盘目录
// 4GiB 天花板），后面的低档候选可能装得下，穿透会把它们一并判死
const FATAL_ERRNOS = new Set(['ENOSPC', 'EDQUOT', 'EROFS', 'ENAMETOOLONG', 'EISDIR', 'ENOTDIR', 'ENOTEMPTY', 'ELOOP']);
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

// 任务级穿透谓词：fatal+errno = 本地确定性病（换 URL/换档结果必然相同），
// 候选循环不该为它空转，直接穿透到任务判死。
// 只 fatal 无 errno 的（上游 4xx、ERR_DNS_GUARD_BLOCKED 的 socket 层拦截）
// 是「这条 URL 死了」的候选级语义——backup_url/下一档还有机会，不能穿透。
// DNS guard 的 .code 是合成标记不是本地 errno——round-robin/split-horizon
// DNS 下一条 URL 被拦不该剥夺兄弟候选的机会，与 URL 阶段拦截同级
function penetratesCandidates(e) {
  return Boolean(e?.fatal && e?.code && e.code !== 'ERR_DNS_GUARD_BLOCKED');
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
async function fetchStream(rawUrl, { timeout, signal, headers, allowedHost }) {
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
    // 可选的逐跳宿主谓词：默认不带即现状零扰动；调用方给了（封面图床
    // 白名单）每跳都要重验——入口闸只管首发 URL，302 跳出名单的重定向
    // 投毒（ytimg→任意域）在此收口，判 fatal 不重试
    if (allowedHost && !allowedHost(parsed.hostname)) {
      throw fatalError('下载地址宿主不在白名单');
    }
    // YouTube 族命中 yt_proxy 时整跳换道：本机公网校验与 socket 钉扎都只对
    // 「本机直连」有意义——代理通道下目标 DNS 在代理端解析，本机答案（墙内
    // 对 googlevideo 常是污染的 fake-IP/私网结果）无关且会拦死走代理的
    // 本意，故 yp 在位时跳过 checkHostPublic。SSRF 收敛在上方
    // normalizeOutboundUrl（协议/端口/credentials）+ yt-proxy 域族判定
    const yp = ytAxiosProxyFor(parsed.hostname);
    if (!yp) {
      // 三态判定：'blocked'（解析到私网）是确定性拦截→fatal；'error'（DNS 瞬时故障：
      // SERVFAIL/临时断网）保持可重试，否则一次抖动就永久剥夺重试机会
      const hostCheck = await checkHostPublic(parsed.hostname);
      if (hostCheck === 'blocked') {
        throw fatalError('下载地址解析到非公网地址');
      }
      if (hostCheck !== 'ok') {
        throw new Error('下载地址 DNS 解析失败');
      }
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
        // socket 层强制解析钉扎：跳与跳之间的建连都经 guarded lookup。
        // 代理跳换成隧道型 agent 对顶替同字段位（agent 不同而已，目标
        // DNS 移交代理端解析）——若沿用钉扎 agent，guarded lookup 会去
        // 解析代理 host（127.0.0.1 私网字面量必拦死）。axios proxy 选项
        // 对 https 目标只发 absolute-form 明文，严格 CONNECT-only 代理
        // 回 400——故走 lib/yt-proxy.js 的隧道 agent 对，proxy:false
        // 显式挡住 env 代理变量叠加
        ...(yp || {
          httpAgent: agents.httpAgent,
          httpsAgent: agents.httpsAgent,
        }),
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
        // upstreamStatus 挂状态码——跨模块消费者（services/youtube-resolve
        // 的闸控探测）按码判定，不耦合 message 文案
        const err = fatalError(`上游返回 ${status}`);
        err.upstreamStatus = status;
        throw err;
      }
      // AxiosError 的 config/request（response.config/request 是同对象
      // 回挂）带着隧道 agent——agent.proxy.href/connectOpts 内嵌可解码
      // 代理凭据，失败日志 console.error 整对象 inspect、AxiosError
      // toJSON 序列化都会带出去；抛前整剥。上层只读 .message/.code/
      // .fatal/.upstreamStatus（4xx 分支另抛新 Error），不受影响
      delete error.config;
      delete error.request;
      if (error.response) {
        delete error.response.config;
        delete error.response.request;
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
    let totalLength = parseInt(response.headers['content-length'], 10);
    // 206 必须按 Content-Range 对账而非 content-length：局部窗（自适应流只放
    // 首段的实测行为）的 content-length 与窗口字节一致，会骗过对账把截断
    // 工件当完整件登记。要求 `bytes 0-N/TOTAL`（start=0），体积闸与落盘校验
    // 都用 TOTAL；缺/畸形头的 206 判**可重试**而非 fatal——非严格上游可能只是
    // 少发头仍回全量字节，下次取链可能换到健康源（判死反而制造硬失败）
    if (response.status === 206) {
      const rangeHeader = String(response.headers['content-range'] || '').trim();
      const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(rangeHeader);
      const rangeTotal = m && m[3] !== '*' ? parseInt(m[3], 10) : NaN;
      if (!m || parseInt(m[1], 10) !== 0 || !Number.isFinite(rangeTotal) || rangeTotal <= 0) {
        response.data.destroy();
        throw new Error(`上游 206 响应缺少有效 Content-Range（${rangeHeader || '无此头'}）`);
      }
      totalLength = rangeTotal;
    }
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

    // O_NOFOLLOW on the .part write: a symlink planted at partPath must not
    // redirect the write outside the download tree — ELOOP lands in the
    // shared catch below (FATAL_ERRNOS already lists it → deterministic)
    const partFd = fs.openSync(partPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW);
    // fd 是裸数字无 GC——createWriteStream 构造期抛错要手动收
    let writer;
    try {
      writer = fs.createWriteStream(partPath, { fd: partFd, autoClose: true });
    } catch (e) {
      try { fs.closeSync(partFd); } catch { /* already closed */ }
      throw e;
    }
    // pipeline 任一端出错都会销毁两侧流（abort 时 axios 流 reject → writer 同步销毁）
    await pipeline(response.data, writer);

    const stats = fs.statSync(partPath);
    if (stats.size === 0) {
      // 上游 200 但空 body 对该 URL 是确定性失败——标 fatal 不浪费重试
      throw fatalError('下载内容为空');
    }
    // 声明长度（200 的 content-length / 206 的 Content-Range TOTAL）与落盘大小对账：
    // - 小于声明 = 服务端截断/局部窗（瞬时传输问题，可重试）
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


module.exports = {
  MIME_EXT,
  mergeLrcTrans,
  sanitizeFilename,
  fatalError,
  errnoToFatal,
  penetratesCandidates,
  throwIfAborted,
  describeError,
  fetchStream,
  removePartial,
  streamToFile,
  extFromUrl,
  pathWithExt,
};

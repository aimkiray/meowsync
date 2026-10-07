// 在线播放流的本地字节缓存：/audio-proxy 代理过的媒体字节按 opaque key
// 落盘（<key>.bin 数据 + <key>.json 侧车 meta），命中完整档直接以
// 200/206 喂响应——googlevideo/bilivideo 签名过期无所谓，字节已在盘上；
// 下载相位（file-downloader）经 findComplete 复用同一批档不再重拉。
// 设计前提：
//   - 缓存是优化不是必需路径——读写盘任何失败只 warn/落空，绝不拖累响应流
//   - meta.ranges 存合并后的闭区间：断连半截档保留已写区间，下次播放续补；
//     coverage==size 才置 complete，命中门槛只看 complete
//   - 并发写同 key 不同区间安全：fd 定位写天然不交叠，meta 读改写经
//     per-key promise 链串行化
//   - 本模块不碰任何对外网络；sweep 定时器由入口文件（netease-api-server.js）挂
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { dataDir } = require('../db/client');

const CACHE_DIR = path.join(dataDir, 'media-cache');
// TTL 滑动基准是 lastAccessAt（命中/捕获都会刷新）：热播内容不该在
// 「签名寿命后 + 固定写时点」上被误删；LRU 挤兑与过期共用这一个时钟域
const TTL_MS = Math.max(1, Number(process.env.MEDIA_CACHE_TTL_HOURS) || 72) * 3600e3;
const MAX_BYTES = Math.max(0, Number(process.env.MEDIA_CACHE_MAX_MB) || 4096) * 1024 * 1024;
// 在途捕获的 .bin 可能暂时没有 meta（meta 只在 close 时落）——孤儿清扫
// 给新鲜文件留宽限，别把正在写的档扫掉（unlinked fd 不受 unlink 伤，
// 但文件没了 meta 落盘也成孤儿，纯浪费一次捕获）
const ORPHAN_GRACE_MS = 60e3;

const binPath = (key) => path.join(CACHE_DIR, `${key}.bin`);
const metaPath = (key) => path.join(CACHE_DIR, `${key}.json`);

// 文件名安全化：键成分可能带 mime/codec 的引号、分号、逗号、空格——
// 收成 fs 合法字符；前导点剥掉防隐藏文件/特殊名
const safePart = (s) => String(s ?? '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '');
// 键形如 yt_<videoId>_a_mp4a.40.2_131024 / bv_<bvid>_p2_v_avc1.640028_3000000
// ——空成分被滤掉（调用方拿它拼前缀用），同一字节实体指纹恒定即同键
function keyOf(...parts) {
  return parts.map(safePart).filter(Boolean).join('_');
}

// mimeType 的 codec 段：'audio/mp4; codecs="mp4a.40.2"' → 'mp4a.40.2'；
// 多编码（合流）取首枚——指纹只要稳定，不求穷举
function codecOf(mimeType) {
  const m = /codecs?\s*=\s*"?([^";,\s]+)/i.exec(String(mimeType || ''));
  return m ? m[1].trim() : '';
}
// 档指纹 = codec 段（缺省回落 mime 主型）+ br；br 未知/零 → 'x'；
// 可选 streamId（yt itag / bv 流 tier id）追加 '_i<id>' 段——同 codec
// 同 br 的不同上游流实体不撞键；缺省/旧键无此段，前缀匹配不受影响
function fingerprintOf(mimeType, br, codecHint, streamId) {
  const base = codecOf(mimeType) || codecHint
    || String(mimeType || '').split(';')[0].trim() || 'bin';
  const brPart = Number.isFinite(+br) && +br > 0 ? String(Math.round(+br)) : 'x';
  const idPart = (streamId === undefined || streamId === null || streamId === '')
    ? '' : `_i${safePart(streamId)}`;
  return `${safePart(base)}_${brPart}${idPart}`;
}
// 合流判定：codecs 参数列了多枚编码 = 音画混合单文件（yt progressive mp4）。
// B 站 durl 合流由生产侧显式标 muxed，不靠这里
function muxedOf(mimeType) {
  const m = /codecs?\s*=\s*("[^"]*"|[^;]+)/i.exec(String(mimeType || ''));
  return !!m && m[1].replace(/"/g, '').split(',').map(s => s.trim()).filter(Boolean).length > 1;
}

// meta JSON 形态：{key, contentType, size, ranges:[[start,end]…], complete,
//   ino?, muxed?, br?, codec?, h?, w?, createdAt, updatedAt, lastAccessAt}
// ino 记 bin 的 inode——ranges 描述的字节属于这个 inode，换档重建后旧
// 区间必须作废（见 close 的 inode 对账）
// 损坏/形态不符一律当不存在——缓存宁缺毋滥
function readMeta(key) {
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath(key), 'utf8'));
    if (!meta || typeof meta !== 'object' || meta.key !== key) return null;
    meta.ranges = (Array.isArray(meta.ranges) ? meta.ranges : [])
      .filter(r => Array.isArray(r) && Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[0] <= r[1]);
    return meta;
  } catch {
    return null;
  }
}
const isExpired = (meta) =>
  Date.now() - (meta.lastAccessAt || meta.updatedAt || meta.createdAt || 0) > TTL_MS;

// fd 定位写的异步形态：tee 热路径不许用 writeSync——DATA_DIR 落挂载卷时
// 单块同步写阻塞数十~数百 ms，多路并发代理流的逐块写入会叠成全事件循环
// stall。fs.write 走 libuv 线程池，配合捕获内串行链保写序
const writeAt = (fd, buf, off, len, pos) => new Promise((resolve, reject) => {
  fs.write(fd, buf, off, len, pos, (e, written) => (e ? reject(e) : resolve(written)));
});

function lookup(key) {
  const meta = readMeta(key);
  if (!meta || isExpired(meta)) return null;
  // bin 缺席的 meta 是孤儿——不当命中，留给 sweep 收尸
  try { fs.statSync(binPath(key)); } catch { return null; }
  return meta;
}

// 闭区间合并：重叠或相邻（next.start <= last.end+1）都并——相邻即连续覆盖
function mergeRanges(ranges) {
  const sorted = ranges.slice().sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

// meta 读-改-写的 per-key 串行链：并发 close()/touchAccess 同 key 时
// 区间合并结果必须互斥落盘，否则后写覆盖先写丢区间
const metaChains = new Map();
function withKeyLock(key, fn) {
  // 链上即吞错：一处 fn 拒绝（盘故障等）不该把该 key 的后续读改写链
  // 永久饿死——存进链表的是吞错后的 promise；调用方拿到的 p 恒 fulfill，
  // 返回值语义不变（原本就靠各自 .catch 兜底）
  const p = (metaChains.get(key) || Promise.resolve()).then(fn).catch(() => {});
  metaChains.set(key, p);
  const cleanup = () => { if (metaChains.get(key) === p) metaChains.delete(key); };
  p.then(cleanup);
  return p;
}

// 命中刷新 lastAccessAt（fire-and-forget：刷不进只影响 LRU/TTL 精度）。
// 链内必须重读 fresh meta、只改访问时点写回：调用方快照是 readMeta 的旧
// 版——它到本锁的排队窗口里 close() 可能已把 ranges/muxed/codec/ino/
// updatedAt 整段重写，拿旧快照回写就是 lost update 整体回滚。fresh 已
// 不在（sweep/孤儿回收清掉）则跳过——不为一次访问刷新复活 meta
function touchAccess(key, meta) {
  if (meta) meta.lastAccessAt = Date.now(); // 调用方快照同步刷新（语义保持）
  withKeyLock(key, () => {
    try {
      const fresh = readMeta(key);
      if (!fresh) return;
      fresh.lastAccessAt = Date.now();
      fs.writeFileSync(metaPath(key), JSON.stringify(fresh));
    } catch { /* 无碍 */ }
  }).catch(() => {});
}

// 捕获写入器：调用方把经过响应的每块 buffer 喂 tap()（tee 语义），
// 内部按 startOffset+序写入定位到 <key>.bin；close() 把本次覆盖区间
// 合并进 meta。写盘一旦失败本次捕获静默弃档（dead）——绝不影响响应
function beginCapture(key, opts = {}) {
  const { contentType = '', size = 0, startOffset = 0 } = opts;
  if (!key || !(size > 0) || startOffset < 0) return null;
  // 生产侧 mint 时已知的档形态快照原样入 meta——下载复用侧按它们决策
  // （muxed 决定直用还是走合流、codec 决定 ffmpeg tag、h/w/br 进 videoMeta）
  const extra = {};
  for (const k of ['muxed', 'br', 'codec', 'h', 'w']) {
    if (opts[k] !== undefined && opts[k] !== null) extra[k] = opts[k];
  }
  let fd;
  // isFresh：本次新建档（非续旧档）——close 合并 meta 时旧 meta.ranges
  // 描述的是已消失 inode 的字节，必须整段丢弃
  let isFresh = false;
  // 排他创建环：ENOENT → 'wx' 独占新建；EEXIST 说明并发捕获者抢先建好
  // ——回落 'r+' 续它的 inode。若用裸 'w'，后到者会 truncate 前者已写
  // 字节：文件变零洞但 pos/ranges 继续推进，close 把没写的字节记成已写，
  // 产出 complete 毒档被永久喂出。有限次重试吸掉 ENOENT/EEXIST 抖动
  for (let attempt = 0; attempt < 3 && !fd; attempt++) {
    try {
      // 'r+' 保已有分片不截断——续补旧档是常态（上轮断连留下的半截区间）
      fd = fs.openSync(binPath(key), 'r+');
    } catch (e) {
      if (e?.code !== 'ENOENT') {
        console.warn(`[media-cache] 落盘文件不可写，放弃捕获 ${key}:`, e?.message || e);
        return null;
      }
      try {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        fd = fs.openSync(binPath(key), 'wx');
        isFresh = true;
      } catch (e2) {
        if (e2?.code === 'EEXIST') continue; // 竞争者已建——下轮换 'r+' 续上
        console.warn(`[media-cache] 落盘文件创建失败，放弃捕获 ${key}:`, e2?.message || e2);
        return null;
      }
    }
  }
  if (!fd) {
    console.warn(`[media-cache] 落盘文件反复被重建/删除，放弃捕获 ${key}`);
    return null;
  }
  // 捕获到的 inode——close 时与盘上活档对账：fd 指向的 inode 被换掉
  // （sweep 删 bin 后他人重建）说明本次字节喂给了死文件，不能落账
  let ino = 0;
  try { ino = fs.fstatSync(fd).ino; } catch { /* 取不到按未知——close 只做单向丢弃 */ }
  let pos = startOffset;
  let dead = false;
  let closed = false;
  // tap 写链：与 metaChains 同构的串行异步链——块在入队瞬间序记账 pos、
  // 带着占位偏移排进链尾，链上写序 == 入队序，并发 tap 永不交叠错位
  // （与旧 writeSync 严格同序）。时序语义钉死：
  //   - tap 返回链尾 promise：调用方 await 即获「本块及之前各块已落盘」
  //     的确定性；teeStream 的 pull 全程 await 顺带拿到慢盘背压——写不动
  //     就不再读上游，内存不会因写盘追不上而膨胀
  //   - 链内一步写失败置 dead + 就地关 fd，后续排队块直接跳写
  //   - close() 先 drain 整条写链再做 inode 对账/落 meta——ranges 记账的
  //     字节必须已在盘上可读，否则 meta 会指向截断档（flush 语义）
  //   链内函数全 try 包裹保链永不 reject——断链会把后续 tap 的写静默吞
  //   掉而 pos 照推进，close 就把没写的字节记成已写（complete 毒档）
  let writeChain = Promise.resolve();
  const tap = (buf) => {
    if (dead || closed || !buf || !buf.length) return writeChain;
    const at = pos;
    pos += buf.length;
    // 存进链尾的是吞错后的 promise——链上任何一环意外 reject 都会让后续
    // tap 的写静默跳过而 pos 照推进（close 据此记账即毒档）；与
    // withKeyLock 的吞错存链同构
    const step = writeChain.then(async () => {
      if (dead) return;
      try {
        let off = 0;
        while (off < buf.length) {
          off += await writeAt(fd, buf, off, buf.length - off, at + off);
        }
      } catch (e) {
        dead = true;
        try { fs.closeSync(fd); } catch { /* 已关 */ }
        console.warn(`[media-cache] 捕获写失败，弃档 ${key}:`, e?.message || e);
      }
    });
    writeChain = step.catch(() => {});
    return step;
  };
  let closePromise = null;
  const close = () => {
    if (closePromise) return closePromise;
    closed = true;
    // 先等写链 drain 再落 meta——serveComplete/findComplete 只能经 meta 命中，
    // drain 后才写的 meta 天然保证「记账区间 = 盘上可读字节」
    closePromise = writeChain.then(() => withKeyLock(key, () => {
      try { fs.closeSync(fd); } catch { /* 已关 */ }
      // 弃档/零字节捕获不落 meta——空段无信息量还白占键位
      if (dead || pos <= startOffset) return;
      // 活档 inode 对账：盘上 bin 可能已不是捕获开头打开的 inode
      // （sweep/外力删档后被新捕获重建——unlinked fd 照写不误，字节全进
      // 死文件）。本 fd ≠ 活档时本次区间绝不能入账：把没写的字节记成
      // 已写就产出 complete 毒档
      let liveIno = 0;
      try { liveIno = fs.statSync(binPath(key)).ino; } catch { /* 活档缺席 */ }
      if (ino && ino !== liveIno) return;
      const meta = readMeta(key) || { key, ranges: [], createdAt: Date.now() };
      // meta.ranges 必须描述活档 inode 的字节：本次新建（isFresh——旧文件
      // 在我们 open 前就已消失，例如 sweep 删 bin 后 meta 还短暂在位）或
      // meta 记档 inode 与活档不符时，旧区间整段重基
      if (isFresh || (meta.ino !== undefined && meta.ino !== liveIno)) {
        meta.ranges = [];
      }
      meta.contentType = meta.contentType || contentType;
      meta.size = meta.size || size;
      meta.ino = liveIno || meta.ino;
      Object.assign(meta, extra);
      meta.ranges = mergeRanges([...meta.ranges, [startOffset, pos - 1]]);
      meta.complete = meta.size > 0 && meta.ranges.length === 1
        && meta.ranges[0][0] === 0 && meta.ranges[0][1] >= meta.size - 1;
      meta.updatedAt = Date.now();
      meta.lastAccessAt = meta.updatedAt;
      try {
        fs.writeFileSync(metaPath(key), JSON.stringify(meta));
      } catch (e) {
        console.warn(`[media-cache] meta 写失败 ${key}:`, e?.message || e);
      }
    }));
    return closePromise;
  };
  return { tap, close };
}

// 代理响应流的旁路落盘：逐 chunk 先写盘再放行给客户端。客户端断连/
// 流中止经 cancel/error 路径触发 close()——已写区间照常落 meta 续补用。
// meta 写完再 controller.close()：消费方读尽时捕获已落账（测试可依赖）
function teeStream(body, capture) {
  const reader = body.getReader();
  let finished = false;
  const finish = () => {
    if (finished) return Promise.resolve();
    finished = true;
    return Promise.resolve(capture.close()).catch(() => {});
  };
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          await finish();
          controller.close();
          return;
        }
        try { await capture.tap(value); } catch { /* 弃档不碍响应 */ }
        controller.enqueue(value);
      } catch (e) {
        await finish();
        try { await reader.cancel(); } catch { /* 已销 */ }
        try { controller.error(e); } catch { /* 已关 */ }
      }
    },
    async cancel() {
      try { await reader.cancel(); } catch { /* 已断 */ }
      await finish();
    }
  });
}

// 完整档直接喂响应：单段 Range 语义与 downloads.js /file 端点同口径
// （bytes=s-e 解析、bytes=-N 后缀段、畸形 400、越界 416、Content-Range/
// Accept-Ranges/ACAO:*）；防护头对齐 proxy 透传链。
// 命中返回 Response（truthy——调用方直接回），不完整/不存在/盘故障回 false
async function serveComplete(c, key) {
  const meta = lookup(key);
  if (!meta || !meta.complete) return false;
  let fd;
  try {
    fd = fs.openSync(binPath(key), 'r');
  } catch {
    return false;
  }
  const closeFd = () => { try { fs.closeSync(fd); } catch { /* 已关 */ } };
  let stream;
  let status;
  let headers;
  try {
    // 尺寸以盘上真实文件为准——meta.size 是声明值，写超/截短时不该透出去
    const stat = fs.fstatSync(fd);
    let start = 0;
    let end = stat.size - 1;
    status = 200;
    const range = c.req.header('range');
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/i.exec(range.trim());
      if (!m || (!m[1] && !m[2])) {
        closeFd();
        return c.json({ code: 400, message: 'unsupported range' }, 400);
      }
      if (!m[1]) {
        start = Math.max(0, stat.size - parseInt(m[2], 10));
      } else {
        start = parseInt(m[1], 10);
        if (m[2]) end = Math.min(parseInt(m[2], 10), stat.size - 1);
      }
      if (start > end || start >= stat.size) {
        closeFd();
        return c.body(null, 416, { 'Content-Range': `bytes */${stat.size}` });
      }
      status = 206;
    }
    headers = {
      'Content-Type': meta.contentType || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Content-Length': String(end - start + 1),
      'Access-Control-Allow-Origin': '*',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': 'sandbox',
    };
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    touchAccess(key, meta);
    if (stat.size === 0) {
      closeFd();
      return c.body(null, 200, headers);
    }
    if (c.req.method === 'HEAD') {
      closeFd();
      return c.body(null, status, headers);
    }
    // fd 交给流持有（autoClose）——stat→stream 同一 inode 锁定，
    // sweep/淘汰并发删文件时 body 仍是完整字节
    stream = fs.createReadStream(binPath(key), { fd, start, end, autoClose: true });
  } catch (e) {
    closeFd();
    console.warn(`[media-cache] 命中响应构造失败 ${key}:`, e?.message || e);
    return false;
  }
  return c.body(Readable.toWeb(stream), status, headers);
}

// codec 质量档序：与 lib 选流 prefer='best' 的 flac>杜比>AAC 同口径——
// 无损/杜比轨 bandwidth 常缺省（指纹 '_x' 尾），裸比 br 会被普通 AAC
// 挤掉；缺省 br 的档按白名单序仍应优先于有 br 的低码率档
const CODEC_QUALITY_RANK = (codec) => {
  const s = String(codec || '');
  return /flac|alac|pcm|wav/i.test(s) ? 2
    : (/ec-?3|ac-?[34]|eac-?3|dolby|dts/i.test(s) ? 1 : 0);
};

// 前缀扫描找最优完整档：providerKeyPrefix 形如 'yt_<videoId>_a_' /
// 'bv_<bvid>_p2_v_'——返回 codec 质量档序最高（同档比 br，再平手取最近
// 访问）的 {binPath, meta}。opts.minBr：低于该码率的档不复用（下载侧
// prefer='best' 的音质底线——br 缺失的 '_x' 档天然过不了门槛）
function findComplete(prefix, { minBr = 0 } = {}) {
  let names;
  try {
    names = fs.readdirSync(CACHE_DIR);
  } catch {
    return null; // 目录不存在 = 无缓存
  }
  let best = null;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const key = name.slice(0, -'.json'.length);
    if (!key.startsWith(prefix)) continue;
    const meta = readMeta(key);
    if (!meta || !meta.complete || isExpired(meta)) continue;
    let stat;
    try {
      stat = fs.statSync(binPath(key));
    } catch {
      continue; // bin 缺席的 meta 孤儿
    }
    // meta.size 声明与盘上对账——被外力截短的档不能当完整复用
    if (meta.size > 0 && stat.size < meta.size) continue;
    // br 取自 meta 快照，缺省回落键指纹尾段（'_i<streamId>' 段要剥掉）
    const br = (Number.isFinite(meta.br) && meta.br > 0)
      ? meta.br
      : (parseInt(/_(\d+)(?:_i[^_]+)?$/.exec(key)?.[1] || '0', 10) || 0);
    if (br < minBr) continue;
    const rank = CODEC_QUALITY_RANK(meta.codec || codecOf(meta.contentType) || key);
    if (!best || rank > best.rank
        || (rank === best.rank && (br > best.br
          || (br === best.br && (meta.lastAccessAt || 0) > (best.meta.lastAccessAt || 0))))) {
      best = { binPath: binPath(key), meta, br, rank };
    }
  }
  if (best) touchAccess(best.meta.key, best.meta);
  return best;
}

// 周期清扫：过期档删、meta 损坏/bin 孤儿清、总量超限按 lastAccessAt
// LRU 挤兑。全部失败路径静默——缓存清扫不配有炸进程权
function sweep() {
  let names;
  try {
    names = fs.readdirSync(CACHE_DIR);
  } catch {
    return { expired: 0, evicted: 0, orphans: 0 };
  }
  const now = Date.now();
  const drop = (key) => {
    try { fs.unlinkSync(binPath(key)); } catch { /* 缺席/占用皆无碍 */ }
    try { fs.unlinkSync(metaPath(key)); } catch { /* 同上 */ }
  };
  const liveKeys = new Set();
  const live = [];
  let expired = 0;
  let orphans = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const key = name.slice(0, -'.json'.length);
    const meta = readMeta(key);
    let binSize = null;
    try {
      binSize = fs.statSync(binPath(key)).size;
    } catch { /* bin 缺席 */ }
    if (!meta || binSize === null) {
      // meta 损坏/bin 孤儿：成对清（留着永远读不出）
      drop(key);
      orphans++;
      continue;
    }
    if (isExpired(meta)) {
      drop(key);
      expired++;
      continue;
    }
    liveKeys.add(key);
    live.push({ key, meta, bytes: binSize });
  }
  // 无 meta 的孤儿 .bin（写盘崩/进程死的产物）；mtime 新鲜的留给在途捕获
  for (const name of names) {
    if (!name.endsWith('.bin')) continue;
    const key = name.slice(0, -'.bin'.length);
    if (liveKeys.has(key)) continue;
    try {
      const st = fs.statSync(binPath(key));
      if (now - st.mtimeMs < ORPHAN_GRACE_MS) continue;
      fs.unlinkSync(binPath(key));
      orphans++;
    } catch { /* 已不在 */ }
  }
  let evicted = 0;
  let total = live.reduce((s, l) => s + l.bytes, 0);
  if (total > MAX_BYTES) {
    live.sort((a, b) => (a.meta.lastAccessAt || 0) - (b.meta.lastAccessAt || 0));
    for (const l of live) {
      if (total <= MAX_BYTES) break;
      drop(l.key);
      total -= l.bytes;
      evicted++;
    }
  }
  if (expired || evicted || orphans) {
    console.info(`[media-cache] sweep：过期 ${expired} / LRU 挤兑 ${evicted} / 孤儿 ${orphans}`);
  }
  return { expired, evicted, orphans };
}

module.exports = {
  CACHE_DIR,
  TTL_MS,
  MAX_BYTES,
  keyOf,
  fingerprintOf,
  codecOf,
  muxedOf,
  lookup,
  serveComplete,
  beginCapture,
  teeStream,
  findComplete,
  sweep,
};

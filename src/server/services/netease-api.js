const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { resolvesToPublicIp, normalizeOutboundUrl, makeGuardedLookup, isProxyAllowedHost } = require('../lib/net-guard');
const streamVault = require('../lib/stream-vault');
const { aiEnabled, askAiJson } = require('../lib/ai');

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
// 先加载补丁再引入库：库内 request() 的每次出站连接经 guarded lookup
// 强校验公网 IP（match() 内部探测请求是盲 SSRF 面，补丁幂等可重复加载）
require('../../lib/patch-unm-request');
const unblockmatch = require('@unblockneteasemusic/server');

// 试听版判定阈值：上游返回的 url 时长不超过 60s 视为试听片段
const TRIAL_MAX_DURATION_MS = 60000;
// 解锁结果的时长校验容差（估算时长与原始时长偏差占比）
const DURATION_TOLERANCE = { ytdlp: 0.4, default: 0.2 };
// 源优先级（2026-09 实测）：
// - pyncmd：网易自家 m801.music.126.net，一次 API 调用出完整文件，最快最稳
// - bodian：bd-er.kuwo.cn 完整文件（与 kuwo 不同的 CDN 路径）
// - ytdlp：googlevideo 完整文件，但需本机 yt-dlp 且解析有秒级延迟
// - kuwo：antiserver/trackmedia 现已退化为 ~11s 预览剪辑，只作兜底——
//   时长校验会识别剪辑并跳过，不会把残片当完整曲下发
// qq：unm 自带的 QQ 音乐源（musicu.fcg vkey 链）——给网易云灰曲兜底，
// 读 QQ_COOKIE 环境变量解锁 VIP 档；排末位（需要 QQ 侧不地域限制+额度健康）
const PLAYBACK_SOURCES = ['pyncmd', 'ytdlp', 'bodian', 'kuwo', 'qq'];
const DOWNLOAD_SOURCES = ['pyncmd', 'bodian', 'ytdlp', 'kuwo', 'qq'];

// 通过 Content-Length + 码率估算音频时长（毫秒）
function estimateDuration(contentLength, br) {
  if (!contentLength || !br) return null;
  return Math.round((contentLength * 8) / br * 1000);
}

// HEAD 请求获取 Content-Length（跟随有限重定向；30x 响应体的 length 不是目标文件大小）。
// 与 fetchStream 同一威胁模型：每跳都过 resolvesToPublicIp——明文源站被 302 到内网/
// 云元数据即成盲 SSRF（端口/存活探测侧信道）；userinfo 一并剥掉（相对重定向会继承
// credentials，转发到异构主机即泄露）。探测失败一律降级 null = 跳过时长校验，不阻塞下载
async function getContentLength(url, hops = 0, lookup = makeGuardedLookup()) {
  if (hops > 3) return null;
  // 与 fetchStream/proxy.js 同一收口：协议/端口/credentials 判定共用
  // normalizeOutboundUrl，任何一项不过都降级跳过探测
  const checked = normalizeOutboundUrl(url);
  if (!checked.ok) return null;
  const current = checked.url;
  if (!(await resolvesToPublicIp(current.hostname))) {
    return null;
  }
  const cleanUrl = current.toString();
  return new Promise((resolve) => {
    const mod = cleanUrl.startsWith('https') ? https : http;
    let req;
    try {
      // "一切失败 → null"是函数契约：http.request 对畸形 URL/选项会同步抛，
      // 不能让 reject 漏给调用方。lookup 跨跳共享 pin 表（socket 层强制）
      req = mod.request(cleanUrl, { method: 'HEAD', timeout: 5000, lookup }, (res) => {
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
        resolve(getContentLength(next, hops + 1, lookup));
        return;
      }
      // 仅 2xx 的 content-length 是文件大小——405/500 错误页的 length 会被当作
      // 文件大小做时长估算，误杀本来可用的解锁源
      resolve(res.statusCode >= 200 && res.statusCode < 300
        ? (parseInt(res.headers['content-length']) || null)
        : null);
      });
    } catch {
      resolve(null);
      return;
    }
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

// 单请求内解锁扇出的硬上限：song_url 接受逗号分隔多 id，逐项又会并发跑
// 4 源 × match() 出站请求——无界扇出会把服务端 FD/上游配额打爆
const MAX_UNLOCK_ITEMS = 20;
// 解锁并发池：每项的 4 源串行试错，但项与项之间限 4 并发——瞬时起几十条
// match() 链会耗尽 socket，且各源站对突发并发的容忍度低
const UNLOCK_CONCURRENCY = 4;
// 解锁结果短缓存：60s 窗口吸收"点歌→超时→重试→换码率重试"的重复链
// （签名 URL 有效期以小时计，60s 不失效）；Key 含 purpose 保留源序差异
const UNLOCK_CACHE_TTL_MS = 60000;
const unlockCache = new Map(); // `${purpose}|${id}` -> {url, br, source, at}
const unlockCacheGet = (purpose, id) => {
  const hit = unlockCache.get(`${purpose}|${id}`);
  if (hit && Date.now() - hit.at < UNLOCK_CACHE_TTL_MS) return hit;
  if (hit) unlockCache.delete(`${purpose}|${id}`);
  return null;
};
const unlockCacheSet = (purpose, id, value) => {
  if (unlockCache.size > 256) unlockCache.clear();
  unlockCache.set(`${purpose}|${id}`, { ...value, at: Date.now() });
};

// ── AI 解锁辅助 ────────────────────────────────────────────────
// unm match() 内部的 select 用 keyword（name - artists）在各源站搜候选——
// 歌名带 "(Live)/(Remaster)/DJ版/翻自xx" 等版本修饰时，跨平台检索的命中率与
// 准确度都会掉（搜到同名的剪辑/live 而非正主）。AI 规整出「歌曲本名+原唱」
// 喂给 match 的 data 参数，从检索源头减少错配；时长对账仍在下游兜底。
// 任何一步失败都返回 null → 调用方退回默认 find(id) 路径，无 AI 不变行为
// 正缓存 30min；负缓存（模型没给规整结果/请求失败）只压 2min——AI 端点
// 瞬时抖动不该把同曲半小时内的规整尝试全部掐掉
const UNLOCK_INFO_TTL_MS = 30 * 60 * 1000;
const UNLOCK_INFO_NEG_TTL_MS = 2 * 60 * 1000;
const unlockInfoCache = new Map(); // songId -> {data, at}
const unlockInfoInflight = new Map(); // songId -> Promise<data|null>（同曲单飞）

async function aiUnlockInfoInner(songRow, signal) {
  const artists = (songRow.ar || []).map(a => a.name).filter(Boolean);
  const ans = await askAiJson({
    system: '你是音乐元数据规整器。给定歌曲元数据，提取用于跨平台检索的标准形态：'
      + '去掉版本/介质修饰（Live/Remaster/DJ版/加速版/翻自xx/完整版/剪辑版等），'
      + '保留歌曲本名与原唱歌手；本身就规范则原样返回。只输出 JSON {"name":"...","artists":["..."]}。',
    user: JSON.stringify({ name: songRow.name, artists, album: songRow.al?.name || '' }),
    maxTokens: 128,
    // 规整是检索关键词的增强而非门禁——10s 够小模型出 100 token 结果，
    // 慢于此直接回基线（unm 自抓 detail），别把 AI 延迟放大进解锁链
    timeoutMs: 10000,
    signal,
  });
  let data = null;
  if (ans && typeof ans.name === 'string' && ans.name.trim()) {
    // artists 元素只收字符串——模型可能回 [{name:"x"}] 对象形态，
    // String({}) = "[object Object]" 进检索词比不规整更糟
    const list = Array.isArray(ans.artists)
      ? ans.artists.filter(a => typeof a === 'string' && a.trim())
          .map(a => a.trim().slice(0, 40)).slice(0, 4)
      : [];
    data = { name: ans.name.trim().slice(0, 120), artists: list.length ? list : artists };
  }
  return data;
}

async function aiUnlockInfo(songRow, signal) {
  const key = String(songRow.id);
  const hit = unlockInfoCache.get(key);
  if (hit) {
    const ttl = hit.data ? UNLOCK_INFO_TTL_MS : UNLOCK_INFO_NEG_TTL_MS;
    if (Date.now() - hit.at < ttl) return hit.data;
    unlockInfoCache.delete(key);
  }
  // 同 id 并发请求合到首个在途调用——批量解锁同曲重复项/并发刷新不重复扣额度
  const gate = unlockInfoInflight.get(key);
  if (gate) return gate;
  const p = aiUnlockInfoInner(songRow, signal).finally(() => unlockInfoInflight.delete(key));
  unlockInfoInflight.set(key, p);
  const data = await p;
  // abort 中途返回的 null 不落缓存——那不是「规整不了」而是「被打断」
  if (signal?.aborted) return data;
  if (unlockInfoCache.size > 512) unlockInfoCache.clear();
  unlockInfoCache.set(key, { data, at: Date.now() });
  return data;
}

// unm find(id, data) 的 data 形态：{id,name,alias,duration,album,artists}
// ——注意是原始 detail 字段名（artists/album/duration），不是规整后的 ar/al/dt
// 「注入即承诺」硬契约：data truthy 时 unm 不再自抓 detail，且 getFormatData
// 产出空 name/非对象 album/非数组 artists 会让该源直接 reject 不回落——
// 所以这里必须保证 name 非空 + album/artists 恒为正确形态，malformed data
// 比 undefined 更差（undefined 走 unm 自抓，malformed 让全部源同因失败）
function buildUnmData(songRow, info) {
  const artists = info.artists.map(name => ({ name }));
  if (!info.name || !artists.length) return null;
  return {
    id: songRow.id,
    name: info.name,
    alias: Array.isArray(songRow.alia) ? songRow.alia : [],
    duration: songRow.dt || 0,
    album: { id: songRow.al?.id, name: songRow.al?.name },
    artists,
  };
}

// 对 song_url 返回的 data 数组做解锁后处理（原地修改并返回）
// - url 为空或为试听片段的条目尝试 unblockmatch 回退源
// - 时长校验对所有源生效（kuwo 已退化为预览剪辑，校验即识别机制）；
//   purpose='download' 走 DOWNLOAD_SOURCES 顺序且不经 /audio-proxy（直连源站）
// - purpose='playback' 时：ytdlp 命中经 proxyOrigin 拼 /audio-proxy 回链
// - signal：客户端断开/超时由路由层透传进来，逐源检查即止血——否则一次
//   客户端超时仍留整条解锁链在跑，重试只会叠加僵尸请求
async function resolveSongUrls(items, { purpose = 'playback', proxyOrigin = null, signal = null } = {}) {
  if (!Array.isArray(items)) return items;
  const throwIfAborted = () => { if (signal?.aborted) throw new Error('aborted'); };

  const allSources = purpose === 'download' ? DOWNLOAD_SOURCES : PLAYBACK_SOURCES;
  // 试听判定：freeTrialInfo 是明确标记；时长启发式只对付费曲目生效——
  // 免费短歌（intro/间奏 <60s）fee=0 且 url 即完整曲，误判会错误触发解锁
  const needsUnlock = (item) => {
    if (!item.id) return false;
    const isTrial = item.freeTrialInfo != null
      || (item.url && item.time > 0 && item.time <= TRIAL_MAX_DURATION_MS && item.fee > 0);
    return !item.url || isTrial;
  };
  const unlockTargets = items.filter(needsUnlock);
  if (unlockTargets.length > MAX_UNLOCK_ITEMS) {
    // 路由层已限量；这里截断是兜底——丢弃项必须标失败并清链，
    // 不能把"未经后处理"的原始 url 静默透下去（试听片会漏到客户端）
    for (const dropped of unlockTargets.splice(MAX_UNLOCK_ITEMS)) {
      dropped.url = null;
      dropped.unlockFailed = true;
    }
  }
  throwIfAborted();

  // 仅在确实有歌要解锁时才打 song_detail——正常播放（url 完整）的热路径
  // 不该为校验基准多付一次上游往返
  const ids = unlockTargets.map(i => i.id).join(',');
  const originalDurations = {};
  const songRows = {}; // AI 规整用——unlockInfo 需要完整 name/ar/al 字段
  if (ids && apiModules['song_detail']) {
    try {
      const detail = await withTimeout(
        apiModules['song_detail']({ ids }, request),
        UPSTREAM_TIMEOUT_MS, '上游接口 song_detail'
      );
      (detail.body?.songs || []).forEach(s => {
        originalDurations[s.id] = s.dt;
        songRows[s.id] = s;
      });
    } catch (e) {
      // 静默降级会让 kuwo 剪辑漏检——留痕才能发现"上游抖动→成片剪辑入库"的因果
      console.warn(`[unlock] song_detail 获取失败，时长校验降级（逐源统计仍生效）: ${e?.message || e}`);
    }
  }

  const runUnlock = async (item) => {
    throwIfAborted();
    if (item.id) {
      // song_url 返回项无 dt 字段——基准时长只可能来自 song_detail
      const originalDt = originalDurations[item.id] || null;
      let resolved = unlockCacheGet(purpose, item.id);
      const wasCached = Boolean(resolved);
      if (!resolved) {
        // AI 规整检索元数据：一次提取全源复用（unm 内部按 keyword 搜候选，
        // 干净的 name/artists 让每个源的 select 都更准）。失败/未配置 →
        // matchData=null → unm 走自己的 detail 抓取，行为与旧版一致
        let matchData = null;
        const songRow = songRows[item.id];
        if (songRow && aiEnabled()) {
          try {
            const info = await aiUnlockInfo(songRow, signal);
            matchData = info ? buildUnmData(songRow, info) : null;
          } catch { /* AI 规整失败不阻塞解锁主路径 */ }
        }
        for (const source of allSources) {
          throwIfAborted();
          try {
            const unblocked = await withTimeout(
              unblockmatch(item.id, [source], matchData || undefined),
              UNBLOCK_TIMEOUT_MS, `解锁源 ${source}`
            );
            // 选源期就排除不合规回链：协议/端口过 normalizeOutboundUrl，
            // 域名再逐跳过公网 IP 校验——私网解析的 URL 若选中即 break，
            // 下载端 fatal 整任务死、可用源被白跳（pyncmd 是第三方 API，
            // 其回链属攻击者可影响数据，校验严格度必须与下载端一致。
            // 注意盲区：match() 内部 check() 的 range 探测发生在本校验之前，
            // 由 patch-unm-request 的 socket 层 guarded lookup 兜底）
            const checked = unblocked?.url ? normalizeOutboundUrl(unblocked.url) : null;
            if (!checked?.ok) continue;
            if (!(await resolvesToPublicIp(checked.url.hostname))) continue;

            // 会被包进 /audio-proxy 的回链必须过代理白名单预筛——否则产出
            // "已解析却 403"的死链并缓存 60s。qq 源必须算在内：其 https purl
            // 明文带 uin/vkey 且 vkey 绑本机 IP，不代理既是凭据泄露又必然 403；
            // sip 偶发裸 IP/非音乐 tc.qq.com 子域同样挡下。
            // purpose 不设限：download 场景（浏览器拉 blob）同样拿 vault token——
            // 明文签名链进 JSON 等于把 uin/vkey/出口 IP 发给访客；进程内调用方
            // （file-downloader）不传 proxyOrigin，天然仍拿明文直链
            const willProxy = !!proxyOrigin
              && (source === 'ytdlp' || source === 'qq' || checked.url.protocol === 'http:');
            if (willProxy && !isProxyAllowedHost(checked.url.hostname)) continue;

            // kuwo 已退化为 ~11s 预览剪辑，时长校验是拒收它的唯一机制——
            // 校验需 dt 基准+br 双输入，任一缺失时 kuwo 必须 fail-closed
            // 剔除（其余源无剪辑退化史，放行）
            if (source === 'kuwo' && (!originalDt || !unblocked.br)) continue;

            // 时长校验对所有源生效——剪辑/错配文件下发会被当完整曲播放/落盘
            if (originalDt && unblocked.br) {
              // match() 内部 check() 已发过 range 请求并解析出 size——优先复用，少发一次 HEAD
              // HEAD 探测超时应视为"拿不到 size"（null），与 getContentLength 的
              // 失败降级契约对齐——慢而健康的 CDN 不该因探测超时被整条否决
              const size = Number.isFinite(unblocked.size) && unblocked.size > 0
                ? unblocked.size
                : await withTimeout(getContentLength(checked.url.toString()), 8000, 'HEAD 探测')
                  .catch(() => null);
              const estimated = estimateDuration(size, unblocked.br);
              const tolerance = DURATION_TOLERANCE[source] ?? DURATION_TOLERANCE.default;
              if (estimated && Math.abs(estimated - originalDt) / originalDt > tolerance) {
                console.warn(
                  `[unlock] ${item.id} purpose=${purpose} source=${source} duration mismatch: estimated=${estimated}ms original=${originalDt}ms, skipping`
                );
                continue;
              }
            }

            resolved = { url: checked.url.toString(), br: unblocked.br || null, source };
            unlockCacheSet(purpose, item.id, resolved);
            break;
          } catch (e) {
            if (signal?.aborted) throw e;
            // 该源失败，继续下一个
          }
        }
      }
      if (resolved) {
        // 走代理的情形：ytdlp 的 googlevideo URL 带 ip= 绑定（浏览器直连
        // 必然 403），或上游回 http 链（HTTPS 页面直连会被混合内容拦截）。
        // 用归一化后的协议判定——原始串 startsWith 会被大写 scheme 绕过
        const isHttp = resolved.url.toLowerCase().startsWith('http:');
        const useProxy = !!proxyOrigin
          && (resolved.source === 'ytdlp' || resolved.source === 'qq' || isHttp);
        // 代理面统一经 vault token——解锁回链可能带上游凭据（qq purl uin/vkey、
        // googlevideo ip=），明文嵌进 JSON 等于把运营者凭据发给每个访客
        item.url = useProxy
          ? `${proxyOrigin}/audio-proxy/t/${streamVault.mint(resolved.url)}`
          : resolved.url;
        item.unblocked = true;
        item.unblockedSource = resolved.source;
        // 解锁文件的真实码率（item.br 仍是网易声明值）：下载端落盘后时长
        // 对账以它为分母，直接用声明值会把低码率解锁误判成剪辑
        item.unblockedBr = resolved.br;
        item.usedAudioProxy = useProxy;
        item.freeTrialInfo = null;
        console.info(`[unlock] ${item.id} purpose=${purpose} source=${resolved.source} proxy=${useProxy}${wasCached ? ' (cached)' : ''}`);
      } else {
        item.unlockFailed = true;
        // 试听片段/失效链不再下发——否则下载端会把 30s 残片当完整曲落盘并标 completed
        item.url = null;
        console.warn(`[unlock] ${item.id} purpose=${purpose} all sources failed or duration mismatch`);
      }
    }
    return item;
  };

  // 有限并发池代替裸 Promise.all：逐项内部已是 4 源串行试错
  const queue = [...unlockTargets];
  const workers = Array.from(
    { length: Math.min(UNLOCK_CONCURRENCY, queue.length) },
    async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (!item) break;
        await runUnlock(item);
      }
    }
  );
  await Promise.all(workers);

  return items;
}

module.exports = { callNeteaseApi, apiModules, request, resolveSongUrls, estimateDuration };

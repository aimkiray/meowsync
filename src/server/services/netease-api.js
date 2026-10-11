const http = require('http');
const https = require('https');
const { resolvesToPublicIp, normalizeOutboundUrl, makeGuardedLookup, isProxyAllowedHost } = require('../lib/net-guard');
const streamVault = require('../lib/stream-vault');
// 外发回链必须拼回部署前缀——entryFetch 剥前缀后 app 按根路径工作，
// 裸 /audio-proxy/t/… 在 BASE_PATH 子目录部署下回客户端即 404
const { withBasePath } = require('../lib/base-path');
const { aiEnabled, askAiJson } = require('../lib/ai');
const { callNeteaseApi, apiModules } = require('./netease');
const { PROVIDERS, PLAYBACK_SOURCES, DOWNLOAD_SOURCES } = require('./unlock');
// 源级熔断健康闸——独立路径而非 ./unlock 解构：既有测试对 index.js 的
// seed 桩面只有 {PROVIDERS, PLAYBACK_SOURCES, DOWNLOAD_SOURCES} 三字段，
// 从门面解构 health 会在桩下拿到 undefined 崩掉
const sourceHealth = require('./unlock/health');

// 试听版判定阈值：上游返回的 url 时长不超过 60s 视为试听片段
const TRIAL_MAX_DURATION_MS = 60000;
// 解锁结果的时长校验容差（估算时长与原始时长偏差占比）
// youtube 现场版/剪辑版时长差异大给宽；其余源 20%
const DURATION_TOLERANCE = { youtube: 0.4, default: 0.2 };

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
  // googlevideo 签名链对裸 HEAD 不友好：上游按请求形态记账，HEAD 会毒化
  // 该 URL 的后续 Range 请求（探测语义见 services/youtube-resolve probeGated
  // 注释——对 googlevideo 恒带 Range 的 GET）——探不到 size 按 null 降级，
  // youtube 源反正有 durationSec/br 可供时长对账
  if (current.hostname === 'googlevideo.com' || current.hostname.endsWith('.googlevideo.com')) {
    return null;
  }
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

// getContentLength 的 HEAD 探测基于裸 http.request（非 AbortSignal 体系）——
// race 一个总时限兜底防挂死
const UNBLOCK_TIMEOUT_MS = 60000; // 单源 resolve 上限（provider 内每次 fetch 真取消）
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

// callNeteaseApi/apiModules 由 ./netease 门面提供（自研客户端——
// services/netease/{crypto,request,endpoints}.js，替代 NeteaseCloudMusicApi）

// 单请求内解锁扇出的硬上限：song_url 接受逗号分隔多 id，逐项又会并发跑
// 2 源 × match() 出站请求——无界扇出会把服务端 FD/上游配额打爆
const MAX_UNLOCK_ITEMS = 20;
// 解锁并发池：每项的 2 源串行试错，但项与项之间限 4 并发——瞬时起几十条
// match() 链会耗尽 socket，且各源站对突发并发的容忍度低
const UNLOCK_CONCURRENCY = 4;
// 解锁结果短缓存：60s 窗口吸收"点歌→超时→重试→换码率重试"的重复链
// （签名 URL 有效期以小时计，60s 不失效）；Key 含 purpose 保留源序差异，
// 还要含「有/无代理」语境——带 proxyOrigin 的链路选源期过代理白名单预筛，
// 两语境共享同一键会让带代理的读消费直连写入的集合（绕过预筛产死链），
// 或让直连的读消费被白名单筛过的集合（平白丢可用镜像）
const UNLOCK_CACHE_TTL_MS = 60000;
const UNLOCK_CACHE_MAX = 256;
const unlockCache = new Map(); // `${purpose}|${'px'|'direct'}|${id}` -> {url, br, source, at}
const unlockCacheKey = (purpose, id, proxied) => `${purpose}|${proxied ? 'px' : 'direct'}|${id}`;
const unlockCacheGet = (purpose, id, proxied) => {
  const key = unlockCacheKey(purpose, id, proxied);
  const hit = unlockCache.get(key);
  if (hit && Date.now() - hit.at < UNLOCK_CACHE_TTL_MS) return hit;
  if (hit) unlockCache.delete(key);
  return null;
};
const unlockCacheSet = (purpose, id, proxied, value) => {
  const key = unlockCacheKey(purpose, id, proxied);
  // 满容逐最旧键淘汰而非整表 clear()——突发满容全清会把仍在窗内的热键
  // 一并冲掉造成缓存抖动（net-guard dnsCache 同款先例）；delete+set
  // 刷新插入序，反复命中的热键不居队首被先挤掉
  unlockCache.delete(key);
  if (unlockCache.size >= UNLOCK_CACHE_MAX) {
    unlockCache.delete(unlockCache.keys().next().value);
  }
  unlockCache.set(key, { ...value, at: Date.now() });
};
// 同键（purpose|代理语境|id）在途解锁单飞：song_url 批量里的重复 id 与
// 并发请求此前各跑一遍完整解锁链（detail 规整→逐源 resolve→校验/HEAD）。
// 共享 promise 不吃调用方 signal——首调用方断连不该让搭车者陪绑降级；
// 各等待方 await 后用自己的 signal 决定吃不吃结果
// （unlockInfoInflight / net-guard dnsInflight 同款先例）
const unlockInflight = new Map(); // unlockCacheKey 同型键 -> Promise<{resolved, errors}>

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
  // 同 id 并发请求合到首个在途调用——批量解锁同曲重复项/并发刷新不重复扣额度。
  // 内层不传调用方 signal：规整结果是按 id 共享的通用元数据，首个调用方
  // 断连不该让同 inflight 的 waiter 陪绑降级（10s 超时已是内层自净上限）
  const gate = unlockInfoInflight.get(key);
  if (gate) return gate;
  // 身份守卫与 unlockInflight 同口径：forgetSongUnlock 清键后旧链
  // finally 不得误逐后注册的新 gate
  const p = aiUnlockInfoInner(songRow).finally(() => { if (unlockInfoInflight.get(key) === p) unlockInfoInflight.delete(key); });
  unlockInfoInflight.set(key, p);
  const data = await p;
  if (signal?.aborted) return data;
  // 满容逐最旧键淘汰而非整表 clear()——与 unlockCache/dnsCache 同口径；
  // delete+set 刷新插入序
  unlockInfoCache.delete(key);
  if (unlockInfoCache.size >= 512) {
    unlockInfoCache.delete(unlockInfoCache.keys().next().value);
  }
  unlockInfoCache.set(key, { data, at: Date.now() });
  return data;
}

// 解锁检索 info：{id, name, artists[], keyword, durationMs}
// ——provider 拿 keyword 去外站搜候选。keyword 形态对齐 unm 的
// 「name - artists.join(' / ')」（外站检索的多年实证形态）
// 「注入即承诺」：info.name 必须非空 + artists 恒为字符串数组，
// malformed 形态会让全部搜索型源同因失败——name 缺失直接返回 null
function buildUnlockInfo(songRow, info) {
  if (!info.name) return null;
  const artists = Array.isArray(info.artists) ? info.artists : [];
  return {
    id: songRow.id,
    name: info.name,
    artists,
    keyword: artists.length ? `${info.name} - ${artists.join(' / ')}` : info.name,
    durationMs: songRow.dt || null,
  };
}

// 无 AI 规整时的基线 info：直接用 song_detail 原始字段拼 keyword
function baseUnlockInfo(songRow) {
  const artists = (songRow.ar || []).map(a => a?.name).filter(Boolean);
  return buildUnlockInfo(songRow, { name: songRow.name, artists });
}

// 试听判定：freeTrialInfo 是明确标记；时长启发式只对付费曲目生效——
// 免费短歌（intro/间奏 <60s）fee=0 且 url 即完整曲，误判会错误触发解锁。
// 模块级导出给 routes/music.js 的批量上限判定——400 阈值该数「待解锁项」
// 而非 data 全量，否则 21 首全可播的 song_url 也被拒
const needsUnlock = (item) => {
  if (!item.id) return false;
  const isTrial = item.freeTrialInfo != null
    || (item.url && item.time > 0 && item.time <= TRIAL_MAX_DURATION_MS && item.fee > 0);
  return !item.url || isTrial;
};

// 回链扩展名：优先 pathname 尾缀（126/purl 链自带 .flac/.mp3），googlevideo
// 无尾缀时看 mime= 参数。写回 item.type 让前端下载文件名扩展名与内容一致
function extOf(url) {
  const m = (url.pathname || '').match(/\.(flac|mp3|m4a|ogg|opus|aac|webm|wav)$/i);
  if (m) return m[1].toLowerCase();
  const mime = url.searchParams.get('mime') || '';
  if (mime.startsWith('audio/mp4')) return 'm4a';
  if (mime.startsWith('audio/webm')) return 'webm';
  // progressive 合流兜底（闸控链下排到首位的形态）：video/mp4 容器含
  // AAC 轨——下载端 MIME_EXT 同口径按音频工件落 m4a，前端 type 同步
  if (mime.startsWith('video/mp4')) return 'm4a';
  return null;
}

// 逐源异常 → unlockErrors cls 分类（[canonical CLSRULE]）：authRejected 是
// 凭据级证据归 authwall；HTTP 5xx/429/超时/网络层归 transient（决定 L4
// 全灭时任务走退避重试而非 fatal）；其余含 4xx/空回/未知抛错兜底 nomatch
const UNLOCK_TRANSIENT_RE = /HTTP (5\d\d|429)|超时|timed?\s*out|abort|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket hang up|visitorData 获取失败/i;
const classifyUnlockError = (e) => {
  if (e?.authRejected) return 'authwall';
  return UNLOCK_TRANSIENT_RE.test(String(e?.message || e || '')) ? 'transient' : 'nomatch';
};

// 对 song_url 返回的 data 数组做解锁后处理（原地修改并返回）
// - url 为空或为试听片段的条目尝试 ./unlock 注册表里的 provider 回退源
// - 时长校验对所有源生效（provider 候选期已知 durationSec 直接比对，
//   否则 size×br 估算——剪辑/错配文件一律拒收）；
//   purpose='download' 走 DOWNLOAD_SOURCES 顺序且不经 /audio-proxy（直连源站）
// - proxyOrigin 在场时回链经 return 前的发射 post-pass 统一 vault 化
//   （/audio-proxy/t/<token>）——非解锁官方直链与解锁裸链同口径
// - signal：客户端断开/超时由路由层透传进来，逐源检查即止血——否则一次
//   客户端超时仍留整条解锁链在跑，重试只会叠加僵尸请求
async function resolveSongUrls(items, { purpose = 'playback', proxyOrigin = null, signal = null } = {}) {
  if (!Array.isArray(items)) return items;
  const throwIfAborted = () => { if (signal?.aborted) throw new Error('aborted'); };

  const allSources = purpose === 'download' ? DOWNLOAD_SOURCES : PLAYBACK_SOURCES;
  const unlockTargets = items.filter(needsUnlock);
  if (unlockTargets.length > MAX_UNLOCK_ITEMS) {
    // 路由层已限量；这里截断是兜底——丢弃项必须标失败并清链，
    // 不能把"未经后处理"的原始 url 静默透下去（试听片会漏到客户端）
    for (const dropped of unlockTargets.splice(MAX_UNLOCK_ITEMS)) {
      dropped.url = null;
      dropped.unlockFailed = true;
      dropped.unlockErrors = [{ source: '-', msg: '超出单次解锁条数上限，未尝试', cls: 'nomatch' }];
    }
  }
  throwIfAborted();

  // 仅在确实有歌要解锁时才打 song_detail——正常播放（url 完整）的热路径
  // 不该为校验基准多付一次上游往返
  const ids = unlockTargets.map(i => i.id).join(',');
  const originalDurations = {};
  const songRows = {}; // AI 规整用——unlockInfo 需要完整 name/ar/al 字段
  if (ids) {
    try {
      const detail = await callNeteaseApi('song_detail', { ids }, { signal });
      (detail.body?.songs || []).forEach(s => {
        originalDurations[s.id] = s.dt;
        songRows[s.id] = s;
      });
    } catch (e) {
      // 客户端断连的 abort 会经 request.js 包成 {status:502} answer——非 Error
      // 打不出 message，这里按 aborted 跳过避免「[object Object]」误导日志
      if (!signal?.aborted) {
        const msg = e?.message || (typeof e === 'object' && e !== null
          ? `answer.status=${e.status}` : String(e));
        // 静默降级会让剪辑错配漏检——留痕才能发现"上游抖动→成片剪辑入库"的因果
        console.warn(`[unlock] song_detail 获取失败，时长校验降级（逐源统计仍生效）: ${msg}`);
      }
    }
  }

  // 单 id 解锁链本体：AI 规整 → 逐源 resolve → 回链校验/白名单预筛/时长
  // 对账 → 写缓存，产出 {url,urls,br,source,ext,size,timeMs} | null。
  // 产出经 unlockInflight 键共享给并发搭车者，故本函数不消费调用方
  // signal（自净上限靠每次 provider 调用的 UNBLOCK_TIMEOUT_MS）；并发等待
  // 方在 await 共享 promise 后自查自己的 signal 决定吃不吃结果
  const resolveOne = async (item, originalDt) => {
    // 逐源失败归因——不直写 item：产出经 unlockInflight 键共享给并发
    // 搭车者，errors 必须随共享结果 {resolved, errors} 一起走，否则
    // 搭车 item 无归因（L1）
    const errors = [];
    // AI 规整检索元数据：一次提取全源复用（provider 拿 keyword 去外站
    // 搜候选，干净的 name/artists 让候选选择更准）。失败 → 退回
    // song_detail 原始字段拼 keyword；连 songRow 都没有时 info=null——
    // 搜索型源会拿不到 keyword，仅 id 直解源（pyncmd）仍可用
    let info = null;
    const songRow = songRows[item.id];
    if (songRow) {
      if (aiEnabled()) {
        try {
          const normalized = await aiUnlockInfo(songRow, null);
          if (normalized) info = buildUnlockInfo(songRow, normalized);
        } catch { /* AI 规整失败不阻塞解锁主路径 */ }
      }
      if (!info) info = baseUnlockInfo(songRow);
    }
    for (const source of allSources) {
      const provider = PROVIDERS[source];
      if (!provider) continue;
      // 源级熔断闸（L2）：盖章窗内整源跳过——每次解锁重跑注定失败的
      // 完整试错链（youtube 每候选 3 形态 × 至多 2 试 + 30s 子预算）既
      // 拖长 resolve 又持续给风控喂信号；breaker 条目记「该源本次没跑」
      if (sourceHealth.isOpen(source)) {
        const msg = `源熔断中：${sourceHealth.breakerReason(source) || '连败判据'}`;
        errors.push({ source, msg, cls: 'breaker' });
        console.info(`[unlock] ${item.id} ${source}: ${msg}`);
        continue;
      }
      try {
        const unblocked = await provider.resolve(
          info ? { ...info } : { id: item.id, keyword: '' },
          {
            purpose,
            // 真实取消透传：provider 内每次 fetch 都吃这个 signal。
            // 共享链不接调用方 signal（断连不陪绑）——60s 内部超时即自净上限
            signal: AbortSignal.timeout(UNBLOCK_TIMEOUT_MS),
          },
        );
        // 选源期就排除不合规回链：协议/端口过 normalizeOutboundUrl，
        // 域名再逐跳过公网 IP 校验——私网解析的 URL 若选中即 break，
        // 下载端 fatal 整任务死、可用源被白跳（pyncmd 是第三方 API，
        // 其回链属攻击者可影响数据，校验严格度必须与下载端一致）。
        // 逐源失败必须留痕——全静默 continue 下线上「该解的歌不解」无法
        // 区分是搜索空回/风控/SSRF 拦截还是白名单预筛。
        // unblocked.urls（同字节镜像组）：整条候选链逐条过同一套校验，
        // 活链集随 resolved 下发——代理逐试钉位，首链死掉自动换镜像；
        // 无 urls 的源退化为单链（契约向后兼容）。跨字节实体的候选
        // （不同分辨率/编码）不允许混排——代理换档语义见 proxy.js
        const rawUrls = Array.isArray(unblocked?.urls) && unblocked.urls.length
          ? unblocked.urls : [unblocked?.url];
        const urls = [];
        let checked = null;
        for (const u of rawUrls) {
          const chk = typeof u === 'string' && u ? normalizeOutboundUrl(u) : null;
          if (!chk?.ok) continue;
          if (!(await resolvesToPublicIp(chk.url.hostname))) continue;
          if (!checked) checked = chk;
          urls.push(chk.url.toString());
        }
        if (!checked) {
          // 区分两类真因：源回 null/AI 全否（unblocked 空）与「有回链被
          // 归一化/公网校验杀」——下游 FAILMSG 直接消费这段文案
          errors.push({ source, msg: unblocked ? '回链归一化/公网校验全拒' : '源未产出候选', cls: 'nomatch' });
          console.info(`[unlock] ${item.id} ${source}: 无可用回链或归一化/公网校验全拒`);
          continue;
        }

        // proxyOrigin 在场即过代理白名单预筛：发射收口（return 前 post-pass）
        // 把一切回链统一 vault 化，名单外候选注定是"已解析却 403"的死链——
        // 整条候选都须过，漏一条等于往 vault 里混一条空打一跳的死链或裸
        // 凭据外发。googlevideo 的 ip= 绑定签名链本就必须代理；https
        // 官方/解锁裸链现同口径（post-pass 统一 mint）。
        // purpose 不设限：download 场景（浏览器拉 blob）同样拿 vault token——
        // 明文签名链进 JSON 等于把链内签名/出口 IP 发给访客；进程内调用方
        // （file-downloader）不传 proxyOrigin，天然仍拿明文直链
        if (proxyOrigin) {
          for (let i = urls.length - 1; i >= 0; i--) {
            if (!isProxyAllowedHost(new URL(urls[i]).hostname)) urls.splice(i, 1);
          }
          if (!urls.length) {
            errors.push({ source, msg: '回链不在代理白名单', cls: 'nomatch' });
            console.info(`[unlock] ${item.id} ${source}: 不在代理白名单`);
            continue;
          }
          // splice 可能换掉首链——checked 对齐过滤后的 urls[0]，
          // extOf/HEAD 探测的口径必须是最终下发链而非被滤掉的链
          checked = normalizeOutboundUrl(urls[0]);
        }

        // 时长校验对所有源生效——剪辑/错配文件下发会被当完整曲播放/落盘。
        // 候选期已知秒数的源（youtube）直接比对原始时长；
        // 其余按 size×br 估算（unm range 探测已随库删除，回落 HEAD）
        let estMs = null;
        let sizeBytes = null;
        if (originalDt) {
          const tolerance = DURATION_TOLERANCE[source] ?? DURATION_TOLERANCE.default;
          if (Number.isFinite(unblocked.durationSec) && unblocked.durationSec > 0) {
            estMs = unblocked.durationSec * 1000;
          } else if (unblocked.br) {
            // HEAD 探测超时应视为"拿不到 size"（null），与 getContentLength 的
            // 失败降级契约对齐——慢而健康的 CDN 不该因探测超时被整条否决
            sizeBytes = Number.isFinite(unblocked.size) && unblocked.size > 0
              ? unblocked.size
              : await withTimeout(getContentLength(checked.url.toString()), 8000, 'HEAD 探测')
                .catch(() => null);
            estMs = estimateDuration(sizeBytes, unblocked.br);
          }
          if (estMs && Math.abs(estMs - originalDt) / originalDt > tolerance) {
            errors.push({ source, msg: `时长校验不符（估算${Math.round(estMs)}ms/原始${originalDt}ms）`, cls: 'nomatch' });
            console.warn(
              `[unlock] ${item.id} purpose=${purpose} source=${source} duration mismatch: estimated=${Math.round(estMs)}ms original=${originalDt}ms, skipping`
            );
            continue;
          }
        }

        const resolved = {
          url: urls[0], urls, br: unblocked.br || null, source,
          // 真实文件形态写回：试听片的 time/size/type 透给下载端会
          // 落出「mp3 壳装 flac/m4a 肉、30s 残片时长」的错文件。
          // size 优先 provider/HEAD 实测值；youtube 无 size 但知道
          // br+durationSec——按 br×时长估值（标称码率，量级对即可，
          // 至少比残片字节数更接近真相）
          ext: extOf(checked.url),
          size: sizeBytes
            || (Number.isFinite(unblocked.size) && unblocked.size > 0 ? unblocked.size : null)
            || (estMs && unblocked.br ? Math.round(unblocked.br * estMs / 8000) : null),
          timeMs: estMs || originalDt || null,
        };
        unlockCacheSet(purpose, item.id, !!proxyOrigin, resolved);
        // 源一次成功 = 凭据面回春——连败清零（已盖章的不撤，窗内仍跳过）
        sourceHealth.noteSourceOk(source);
        // errors 可能非空：前序源失败留痕随成功结果一起下发
        return { resolved, errors };
      } catch (e) {
        const cls = classifyUnlockError(e);
        // [canonical MARKER] provider 内已逐候选记过账的 authRejected
        // 不重复计——否则单 resolve 单证据计 2 次即误触盖章
        if (cls === 'authwall' && !e.authCounted) sourceHealth.noteAuthRejected(source);
        errors.push({ source, msg: String(e?.message || e).replace(/[\r\n]+/g, ' '), cls });
        // 该源失败，继续下一个——留一行 info 让「逐源全灭」可排障
        console.info(`[unlock] ${item.id} ${source}: ${e?.message || e}`);
      }
    }
    return { resolved: null, errors };
  };

  const runUnlock = async (item) => {
    throwIfAborted();
    if (item.id) {
      // song_url 返回项无 dt 字段——基准时长只可能来自 song_detail
      const originalDt = originalDurations[item.id] || null;
      let resolved = unlockCacheGet(purpose, item.id, !!proxyOrigin);
      const wasCached = Boolean(resolved);
      let shared = false;
      if (!resolved) {
        // in-flight 合流：同键已有在途链则搭车共享（批量重复 id/并发双发
        // 不再各跑一遍完整解锁链）；无则本调用方建链，结果照常进缓存。
        // 共享 promise 不吃本调用方 signal——await 后自查 abort 才消费结果
        const gateKey = unlockCacheKey(purpose, item.id, !!proxyOrigin);
        let gate = unlockInflight.get(gateKey);
        if (!gate) {
          gate = resolveOne(item, originalDt)
            // 身份守卫：forgetSongUnlock 会在旧链在途时清键——旧 gate 的
            // finally 无条件删会把后注册的新 gate 误逐（同键双链破坏单飞）
            .finally(() => { if (unlockInflight.get(gateKey) === gate) unlockInflight.delete(gateKey); });
          unlockInflight.set(gateKey, gate);
        } else {
          shared = true;
        }
        const out = await gate;
        resolved = out?.resolved ?? null;
        // errors 随共享结果下发——本 item 可能是搭车者（resolveOne 跑的是
        // 首调用方的 item），归因不能落在别人对象上
        if (out?.errors?.length) item.unlockErrors = out.errors;
        throwIfAborted();
      }
      if (resolved) {
        // vault 化统一收在 return 前的发射 post-pass——此处只落原始回链。
        // 镜像组经 item.urls 递交给 post-pass 做 mint(urls[])（保代理逐试
        // failover 语义）；proxyOrigin 缺席时进程内调用方（file-downloader）
        // 拿明文直链，urls 字段不落地避免污染其消费面
        item.url = resolved.url;
        if (proxyOrigin && Array.isArray(resolved.urls) && resolved.urls.length > 1) {
          item.urls = resolved.urls;
        }
        item.unblocked = true;
        item.unblockedSource = resolved.source;
        // 解锁文件的真实码率（item.br 仍是网易声明值）：下载端落盘后时长
        // 对账以它为分母，直接用声明值会把低码率解锁误判成剪辑
        item.unblockedBr = resolved.br;
        item.usedAudioProxy = false;
        item.freeTrialInfo = null;
        // 解锁回链的真实形态覆写试听片字段（type 影响前端下载扩展名、
        // time/size 影响展示与字节对账）——上游原值是残片/空链的元数据
        if (resolved.ext) item.type = resolved.ext;
        if (resolved.size) item.size = resolved.size;
        if (resolved.timeMs) item.time = resolved.timeMs;
        console.info(`[unlock] ${item.id} purpose=${purpose} source=${resolved.source} proxy=${!!proxyOrigin}${wasCached ? ' (cached)' : shared ? ' (shared)' : ''}`);
      } else {
        item.unlockFailed = true;
        // 试听片段/失效链不再下发——否则下载端会把 30s 残片当完整曲落盘并标 completed
        item.url = null;
        console.warn(`[unlock] ${item.id} purpose=${purpose} all sources failed or duration mismatch`);
      }
    }
    return item;
  };

  // 有限并发池代替裸 Promise.all：逐项内部已是 2 源串行试错
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

  // 发射收口（不变式：浏览器不直连源站）——proxyOrigin 在场时一切回链
  // 换 vault token：非解锁项的官方 music.126.net 直链与解锁分支的
  // http/https 裸链同口径，源站 URL 不出服务端进程。镜像组经
  // streamVault.mint(urls[]) 保候选逐试 failover；freeTrialInfo 试听档
  // 不 mint（省 vault 容量）但试听残片链同样不落 JSON——置空 url，
  // 客户端试听文案走 freeTrialInfo 字段判定（isUnavailableTrack 不吃 url）；
  // 已代理项双保险跳过；归一化失败或候选含白名单外域 fail-closed 置
  // url:null——下处死链比明文外发诚实。
  // 进程内调用方（file-downloader）不传 proxyOrigin，本段整体跳过
  if (proxyOrigin) {
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      // 镜像候选数组不得进 JSON（明文即破不变式）——先收进 src 再删字段，
      // 对跳过项同样生效（belt-and-suspenders：上游若带 urls 字段也摘掉）
      const src = Array.isArray(item.urls) && item.urls.length ? item.urls : null;
      delete item.urls;
      if (!item.url || item.usedAudioProxy) continue;
      // 试听链不外泄：能带 freeTrialInfo 活到这里的只剩无 id 项（带 id 的
      // 试听项必经解锁链——成功清 freeTrialInfo、失败已 url=null），置空
      // 而非透传，DEPLOYMENT「一切回链 vault 化」口径不留豁免口
      if (item.freeTrialInfo) {
        item.url = null;
        continue;
      }
      // 候选逐条过 normalizeOutboundUrl 再判白名单：裸 hostname 判会放进
      // 坏协议/坏端口/带凭据候选（mint 进 vault 即烧死跳），FQDN 尾点
      // （m701.music.126.net.）不先归一又会被 isProxyAllowedHost 误杀。
      // 任一不过 → 整项 fail-closed；mint 入组用归一化后的形态
      const candidates = src || [item.url];
      const mintable = [];
      let proxiable = true;
      for (const u of candidates) {
        const chk = typeof u === 'string' && u ? normalizeOutboundUrl(u) : null;
        if (!chk?.ok || !isProxyAllowedHost(chk.url.hostname)) {
          proxiable = false;
          break;
        }
        mintable.push(chk.url.toString());
      }
      const token = proxiable ? streamVault.mint(mintable) : null;
      if (!token) {
        item.url = null;
        console.warn(`[song_url] ${item.id} 回链不可代理，fail-closed 置空 url`);
        continue;
      }
      // proxyOrigin 只是裸 origin（proto://host）：BASE_PATH 子目录部署
      // 必须经 withBasePath 补前缀，否则客户端拿根相对链撞 base-外 404
      item.url = `${proxyOrigin}${withBasePath(`/audio-proxy/t/${token}`)}`;
      item.usedAudioProxy = true;
    }
  }

  return items;
}

// 手动重试 = hard retry：把该曲在解锁链各层的负状态一次清掉——否则重跑
// 只是复读同一条注定失败的链（60s unlockCache 里可能是已死签名链、
// deadCands/verdict 里躺着墙期误判、rejectedAt 冷却挡住 AI 重评）。
// 编排层缓存按键尾段 |<id> 匹配（键型 `${purpose}|${'px'|'direct'}|${id}`，
// 尾段即歌曲 id，| 界符天然防 id 前缀误配）；provider 级负状态由各自
// forgetSong 钩自清（pyncmd 无态、youtube 死簿/冷却/verdict 三簿）。
// 全程 best-effort：任一环失败不阻塞重试主路径。
function forgetSongUnlock(songId) {
  const id = String(songId);
  const suffix = `|${id}`;
  for (const k of [...unlockCache.keys()]) if (k.endsWith(suffix)) unlockCache.delete(k);
  for (const k of [...unlockInflight.keys()]) if (k.endsWith(suffix)) unlockInflight.delete(k);
  unlockInfoCache.delete(id);
  unlockInfoInflight.delete(id);
  for (const p of Object.values(PROVIDERS)) {
    try { p?.forgetSong?.(id); } catch (e) {
      console.warn(`[unlock] forgetSong(${id}) 清理失败:`, e?.message || e);
    }
  }
}

module.exports = { callNeteaseApi, apiModules, resolveSongUrls, estimateDuration, needsUnlock, MAX_UNLOCK_ITEMS, forgetSongUnlock };

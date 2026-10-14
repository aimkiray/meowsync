// B 站上游原语——routes/bilibili.js（HTTP 层：限流/vault/SSRF 白名单/302）
// 与 services/file-downloader.js（下载层：直接 fetchStream 落盘）共用。
// 移动边界：上游交互（cookie 头形态、API 调用、流挑选、输入解析）全在这里；
// HTTP 语义留在路由。两份实现漂移会让"能播不能下/能下不能播"互不知情
const { Agent } = require('undici');
const vm = require('node:vm');
const v8 = require('node:v8');
const { normalizeOutboundUrl, resolvesToPublicIp, makeGuardedLookup } = require('./net-guard');
const { BVID_RE, BVID_IN_TEXT_RE, extractBiliFavlistId } = require('../../shared/predicates.js');

// B 站 API 统一请求头：Referer 是防盗链硬门槛（缺它 403），UA 伪造浏览器。
// BILI_COOKIE 可选登录态——杜比/Hi-Res 音轨只对有权限的账号下发
// （Hi-Res 通常需大会员），Cookie 只发给 api.bilibili.com 不外泄。
// 懒读而非启动快照：app_settings 覆盖/env 经 lib/settings 解析——设置页
// 热改即刻生效，重启不追陈值（与 qqCookie 同口径）
const { effectiveValue } = require('./settings');
// 按值去重——覆盖热改后新坏值要重新告警，同一坏值不重复刷日志
let cookieWarned = '';
function biliCookie() {
  const raw = (effectiveValue('bili_cookie') || '').trim();
  if (!raw) return '';
  // header 值要求 latin1——粘贴串带进换行/中文会让 undici 抛头校验错，
  // 全部 B 站请求静默 502；剔除控制字符并显式告警（设置页写入侧已挡
  // 非 ASCII，这里是 env 直配与脏库行双保险）
  const ascii = raw.replace(/[^\x20-\x7e]/g, '');
  if (ascii !== raw && cookieWarned !== raw) {
    cookieWarned = raw;
    console.warn('[bilibili] BILI_COOKIE 含控制字符/非 ASCII，已剔除——cookie 值应为纯 ASCII');
  }
  // 登录态下 B 站校验 Cookie 内 CURRENT_FNVAL 与请求 fnval 一致——浏览器
  // 导出的 cookie 里该值是用户最后播放的格式（常是 16），原样带上会被
  // 静默扣发杜比/Hi-Res 轨；剥掉，发请求时按该请求的 fnval 补写
  return ascii.split(';').map(s => s.trim())
    .filter(s => s && s.split('=')[0].trim().toLowerCase() !== 'current_fnval')
    .join('; ');
}
// hasBiliCookie 对外暴露「是否配了登录态」的布尔面即可——值不出进程
const hasBiliCookie = () => Boolean(biliCookie());
const biliHeadersFor = (fnval = 4048) => {
  const cookie = biliCookie();
  return {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Referer': 'https://www.bilibili.com',
    ...(cookie ? { Cookie: `${cookie}; CURRENT_FNVAL=${fnval}` } : {}),
  };
};
// 短链跳解只需要公共头——UA/Referer 足够拿 location，Cookie 不发 b23.tv
const BILI_PUBLIC_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Referer': 'https://www.bilibili.com',
};
const BILI_TIMEOUT_MS = 15000;

// 允许发起重定向解析的域：仅 b23.tv 短链与 bilibili.com 本系。
// 严格 hostname 判定（等值或带点分隔后缀）——userinfo/尾界欺骗
// （b23.tv@内网、bilibili.com.evil.com）在 URL parse 层挡掉
const BILI_LINK_HOSTS = ['b23.tv', 'bilibili.com'];
const isBiliLinkHost = (h) => BILI_LINK_HOSTS.some(x => h === x || h.endsWith('.' + x));

function pickBvidFromUrl(href) {
  // 大小写宽容：三层口径统一（前端 isBilibiliInput/?bili= 都收小写）——
  // bvid 本身大小写敏感，错大小写交给上游 view API 判（-404 照常报错）
  const m = href.match(BVID_IN_TEXT_RE);
  if (m) return m[0];
  const av = href.match(/(?:^|[/?&=])av(\d+)/i);
  if (av) return { aid: Number(av[1]) };
  return null;
}

// B 站链接归一化：BV/av/完整 URL 归 {kind:'video', id}，收藏夹链
// （favlist?fid=/medialist/mlN）归 {kind:'favlist', fid}。
// b23.tv 短链本身不含目标——手动逐跳跟随（redirect:manual），每一跳都
// 重新过 normalizeOutboundUrl（限 80/443/剥 credentials）+ B 站域白名单
// + 公网 IP 校验 + 钉扎建连（audio-proxy 同款防线），重定向到任何非
// B 站域即拒绝——防 SSRF 绕道
async function resolveBiliLink(input, extraSignal) {
  const s = String(input || '').trim();
  if (!s) return null;
  const pick = (href) => {
    // favlist 先判：medialist/play/mlN?bvid=BV…（连播页复制地址栏的常态
    // 形态）同时含两种信号——收藏夹语境更具体，与前端分发顺序同口径
    const fid = extractBiliFavlistId(href);
    if (fid) return { kind: 'favlist', fid };
    const v = pickBvidFromUrl(href);
    return v ? { kind: 'video', id: v } : null;
  };
  const direct = pick(s);
  if (direct) return direct;
  // 裸短链补协议头（b23.tv/xxx 无 scheme 时 new URL 抛错直接拒）——
  // bilibili.com 域名内容 pick 已先行命中，进循环的只有待跳转短链
  let href = /^https?:\/\//i.test(s) ? s : (/^b23\.tv\//i.test(s) ? `https://${s}` : null);
  if (!href) return null;
  for (let hop = 0; hop <= 3; hop++) {
    if (extraSignal?.aborted) return null;
    const checked = normalizeOutboundUrl(href);
    if (!checked.ok) return null;
    const u = checked.url;
    if (!isBiliLinkHost(u.hostname)) return null;
    if (!(await resolvesToPublicIp(u.hostname))) return null;
    const found = pick(u.href);
    if (found) return found;
    const dispatcher = new Agent({
      connect: { lookup: makeGuardedLookup() },
      keepAliveTimeout: 1000,
    });
    try {
      const res = await fetch(u.href, {
        headers: BILI_PUBLIC_HEADERS,
        redirect: 'manual',
        signal: extraSignal
          ? AbortSignal.any([AbortSignal.timeout(10000), extraSignal])
          : AbortSignal.timeout(10000),
        dispatcher,
      });
      await res.body?.cancel().catch(() => {});
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        href = new URL(loc, u.href).toString();
        continue;
      }
      return null;
    } catch {
      return null;
    } finally {
      dispatcher.destroy().catch(() => {});
    }
  }
  return null;
}

// 单曲口径薄壳：只取 video 判别（favlist 判给 /bilibili/favlist 路由处理）
async function parseBvid(input, extraSignal) {
  const r = await resolveBiliLink(input, extraSignal);
  return r?.kind === 'video' ? r.id : null;
}

// extraSignal 级联客户端断连——上游请求不随客户端断开变僵尸（audio-proxy 同款语义）。
// CURRENT_FNVAL 从 path 自解析而非靠调用方自觉传参——写错/漏传会静默扣发高规格轨
async function biliFetch(path, extraSignal) {
  const res = await fetch(`https://api.bilibili.com${path}`, {
    headers: biliHeadersFor(Number(path.match(/[?&]fnval=(\d+)/)?.[1]) || 4048),
    signal: extraSignal
      ? AbortSignal.any([AbortSignal.timeout(BILI_TIMEOUT_MS), extraSignal])
      : AbortSignal.timeout(BILI_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`bilibili ${path.split('?')[0]} HTTP ${res.status}`);
  const body = await res.json();
  if (body.code !== 0) throw new Error(`bilibili ${path.split('?')[0]} code=${body.code} ${body.message || ''}`);
  return body.data;
}

// ── 搜索/相关/建议上游面 ─────────────────────────────────────────────
// B 站曲库搜索的匿名通路只有 SSR 数据岛：search.bilibili.com/video?keyword=
// 返回的 HTML 里 `window.__pinia=<IIFE>` 语句（实测 ~115KB）携带完整
// searchAllResponse——result[] 分桶，只取 result_type==='video' 的 data[]。
// page/p 参数对 SSR 无效（恒回第 1 页）：续页走 WBI 签名接口，匿名已被
// v_voucher 风控墙死（本机实锤）——WBI 路径刻意不实现，pinia 即全量。
// 搜索页在 search.bilibili.com（www 域系）而非 api.bilibili.com——请求
// 只带 BILI_PUBLIC_HEADERS，biliCookie 是 api 域专属不外泄（域闸保持）。

// window.__pinia 数据岛求值：indexOf 定位赋值点 + </script> 截断（岛内
// 字符串的 '<' 上游已转义）。沙箱是隔离 context 域而非「喂宿主对象」——
// Object.create(null) 作 context 全局、window 用 context 内 var 建立
// （IIFE 的 this/window.constructor 落在 context 域内建对象上，摸不到宿主
// Function）；codeGeneration 关死 eval/new Function——window.constructor.
// constructor('return process')() 这类逃逸在字符串代码生成处掐断成
// EvalError；microtaskMode:'afterEvaluate' 把岛内微任务排水收进同一份
// timeout 预算——context 全局 Promise 已先一步置 undefined，
// Promise.resolve().then(()=>while(1)) 这型在求值期就同步 TypeError
// 死、根本排不进微任务。
// 返回物不走跨域对象引渡：context 内 JSON.stringify 出文本、宿主侧
// JSON.parse——调用方读键永不踩 context getter（getter 只在岛内 stringify
// 里跑，仍吃 timeout 预算）。payload 非 JSON 可表达（BigInt/环引用）即判
// 畸形归 null——数据岛契约本就是纯数据。vm 域隔离收窄了逃逸面但不是
// 绝对边界（context 内建对象间的旁路理论存在），上面几道闸缺一不可。
// 岛内 promise 拒绝的残面：context 域 promise 仍向宿主 unhandledRejection
// 上报（宿主无进程级兜底→崩进程）——eval 同步窗口内挂 promiseHooks.init
// 给每个新生 promise 补 swallow-catch；窗口是同步段，其他代码构造的
// promise 不会混入。
// 已知残面（Node bug nodejs/node#38503）：async/await 是语法级内建不受
// Promise 影子化管——`(async()=>{await 0;while(1){}})()` 仍能排进排水被
// timeout 掐断，但掐断点落在微任务排水里会弄坏 async_hooks 记账栈，
// 进程可能稍后 assert 崩（node --test 下必现；无 hooks 的裸进程实测存活）。
// 比宿主事件循环挂死强（崩溃可自愈、挂死是僵尸），且攻击者要先能写
// bilibili 域 SSR 页 HTML。返回 null = 岛缺席/求值失败/超时——调用方按
// 「解析失败」抛
function evalPiniaIsland(html, { timeoutMs = 3000 } = {}) {
  const s = String(html || '');
  const anchor = 'window.__pinia';
  const i = s.indexOf(anchor);
  if (i < 0) return null;
  const eq = s.indexOf('=', i + anchor.length);
  const end = eq < 0 ? -1 : s.indexOf('</script>', eq);
  if (eq < 0 || end < 0) return null;
  // 尾分号剥掉再包圆括号——裸对象字面量会被当块语句误解析（{a:1} 读成
  // label），IIFE 包括号语义不变，两种产出形态通吃
  const stmt0 = s.slice(eq + 1, end).trim().replace(/;+$/, '');
  if (!stmt0) return null;

  const sandbox = Object.create(null);
  vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false }, // 禁 eval/new Function/编译型逃逸
    microtaskMode: 'afterEvaluate',                  // 微任务排水收进 timeout 预算
  });
  // window 建在 context 域（宿主传对象会把宿主 constructor 链送进门内）；
  // __msj 钉住真 JSON.stringify——岛语句若覆写 JSON 全局不波及串行化；
  // Promise 置 undefined——微任务/拒绝的命名通道在求值期同步 TypeError
  // 死（async/await 语法级残面见上方块注释），数据岛契约本不需要 Promise
  vm.runInContext('var window = {}; var __msj = JSON.stringify; var Promise = undefined;', sandbox);
  // 首评+截断重试共享同一份 timeoutMs 总预算（起评时刻起算）——每刀独立
  // 吃满会让病态岛（每次都耗到超时才败的漂移串）叠出 5×timeoutMs 的同步
  // 事件循环冻结；余额 <50ms 直接弃刀归 null。vm timeout 必须是整数
  // （分数会 ERR_OUT_OF_RANGE）——floor 后下发
  const t0 = Date.now();
  const evalFrag = (frag) => {
    const left = Math.floor(timeoutMs - (Date.now() - t0));
    if (left < 50) return null;
    const json = vm.runInContext(
      // IIFE 可自赋 window.__pinia 而不返回值——v===undefined 兜一眼 window
      `(function(){var v=(${frag});if(v===undefined)v=window.__pinia;return __msj(v)})()`,
      sandbox, { timeout: left });
    if (typeof json !== 'string') return null;
    const v = JSON.parse(json); // JSON.parse 产物是宿主域纯数据
    return v && typeof v === 'object' ? v : null;
  };

  // 岛内 promise 构造即挂 swallow-catch——拒绝不外溢宿主 unhandledRejection。
  // swallowing 闸断 .then 衍生物的递归钩（衍生物构造同样触发 init）。
  // 必须走宿主内建 Promise.prototype.then.call：岛可经
  // (async()=>{})().constructor.prototype 摸到 context 域 Promise.prototype
  // 并覆写 .then——裸 promise.then(...) 会被钓走导致吞咽失效、拒绝照样外溢；
  // 宿主内建对 context 域 promise 可直接调用（内部槽位跨 realm 通用），
  // 衍生物仍落 context 域、构造时照触 init——swallowing 闸语义不变
  let swallowing = false;
  const stopHook = v8.promiseHooks.createHook({
    init(promise) {
      if (swallowing) return;
      swallowing = true;
      try { Promise.prototype.then.call(promise, undefined, () => {}); } finally { swallowing = false; }
    },
  });
  try {
    // 多语句岛残面：RHS 后混同 script 块其它语句时整段必炸——求值失败
    // 从尾往前逐 ;/, 截断重试（至多 4 刀防无限）。残面：逗号刀可能切开
    // 合法尾逗号表达式，但只在已失败后兜底——完整形永远先行
    let frag = stmt0;
    for (let cuts = 0; frag;) {
      try {
        const v = evalFrag(frag);
        if (v) return v;
      } catch { /* 语法漂移/内部 throw/超时同归——不细分，截尾重试 */ }
      if (++cuts > 4) return null;
      const cut = Math.max(frag.lastIndexOf(';'), frag.lastIndexOf(','));
      if (cut <= 0) return null;
      frag = frag.slice(0, cut).trim().replace(/;+$/, '');
    }
    return null;
  } finally {
    stopHook();
  }
}

// 搜索高亮剥洗：<em class="keyword">词</em>（title/suggest value 都可能带）
const stripSearchEm = (s) => String(s ?? '').replace(/<em[^>]*>|<\/em>/g, '');
// 上游 pic 常是 '//i*.hdslb.com/…' 协议相对形态——补 https:；非 http(s)
// 串不落（与前端 pickAlbumCover 的非 http 排除同口径）
const httpsPic = (p) => {
  const s = String(p || '');
  return s.startsWith('//') ? `https:${s}` : (/^https?:\/\//i.test(s) ? s : '');
};
// duration 双形态归一到秒：搜索页是 'M:SS'/'H:MM:SS' 字符串（'4:0'/'55:17'），
// view/related 系是秒数数字。坏形态归 0——时长是展示/匹配参考不是门禁
function durationSecOf(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
  const parts = String(v || '').split(':').map(p => Number(p.trim()));
  if (parts.length < 2 || parts.length > 3 || parts.some(n => !Number.isFinite(n) || n < 0)) return 0;
  return Math.round(parts.reduce((acc, n) => acc * 60 + n, 0));
}
// 搜索/相关条目归一行：{bvid,title,author,durationSec,pic,typeid,typename,pubdate}。
// 两路字段名不同源——搜索桶给 author/typeid/typename（typeid 是字符串!），
// archive/related 给 owner.name/tid/tname（数字）——同孔径双吃
const videoItemToRow = (v) => ({
  bvid: typeof v?.bvid === 'string' ? v.bvid : '',
  title: stripSearchEm(v?.title).trim(),
  author: String(v?.author ?? v?.owner?.name ?? ''),
  durationSec: durationSecOf(v?.duration),
  pic: httpsPic(v?.pic),
  typeid: Number(v?.typeid ?? v?.tid) || 0,
  typename: String(v?.typename ?? v?.tname ?? ''),
  pubdate: Number(v?.pubdate) || 0,
});

// 音乐分区白名单（原创28/现场29/VU30/翻唱31/演奏59/音乐综合130/MV193/
// AI音乐265/饭拍266/电台267）——搜索=音乐源语义的默认过滤面；乐评243/
// 教学244 等非音乐桶剔除。typeid 入参是字符串——先转 Number 再集合判
const MUSIC_ZONE_TYPEIDS = new Set([28, 29, 30, 31, 59, 130, 193, 265, 266, 267]);
const musicZoneOf = (typeid) => MUSIC_ZONE_TYPEIDS.has(Number(typeid));

// 搜索页逐跳域闸：302 链上每一跳建连前验 host——外站/scheme 漂移的连接
// 根本不发生；只认 bilibili.com 本系（b23.tv 只是跳解跳房，不出 pinia
// 岛，不放进）
const isBiliPageHost = (h) => h === 'bilibili.com' || h.endsWith('.bilibili.com');
// 岛页体积闸：实测 pinia 岛 ~115KB——2MB 上限余量充足又挡住畸形巨页
const BILI_SEARCH_MAX_BYTES = 2 * 1024 * 1024;
// 有界读体：头侧 content-length 早拒（可谎报/缺省），流侧逐块累计超界
// 断流（img-proxy readBoundedBody 同款）；测试桩无 body 时退 res.text()
async function readSearchHtml(res) {
  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > BILI_SEARCH_MAX_BYTES) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`bilibili search body content-length ${declared} 超限`);
  }
  const stream = res.body;
  if (stream && typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value?.byteLength || 0;
      if (total > BILI_SEARCH_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error(`bilibili search body 超 ${BILI_SEARCH_MAX_BYTES}B`);
      }
      chunks.push(value);
    }
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
    return new TextDecoder().decode(buf);
  }
  return res.text();
}

// B 站曲库搜索：SSR 页 → pinia 岛 → video 桶归一行。返回 {items,seid,
// numResults}；岛缺席/求值失败/形态漂移一律抛（路由转 502）——静默空态
// 会把上游改版伪装成「没搜到」。唯独 video 桶缺席不是漂移：result[] 桶表
// 合法但词只命中直播/用户等非视频分区时上游不下发 video 桶——合法零视频
// 词归空态；漂移判定只剩 result 缺席/非数组/桶非对象/video 桶 data 非数组。
// evalTimeoutMs 是测试参数通道——微任务 DoS 钉板不等满 3s 默认预算
async function biliSearchVideos(q, { signal, evalTimeoutMs } = {}) {
  const reqUrl = `https://search.bilibili.com/video?keyword=${encodeURIComponent(q)}`;
  // 逐跳手动跟 302（redirect:'manual'）——裸 fetch 的 follow 模式会先把连接
  // 打到 302 指向的任意 host/port/scheme（含 http://内网IP），再验 res.url
  // 终态域是马后炮：连接已经发生了（盲 SSRF）。范式同 resolveBiliLink：
  // 每跳建连前先过 normalizeOutboundUrl（限 http/https + 80/443 + 剥
  // credentials + 尾点归一）+ isBiliPageHost 域白名单——只认 bilibili.com
  // 本系（b23.tv 是短链跳解跳房，归 resolveBiliLink 链，本链不收），
  // 跳数上限 ≤3。与 resolveBiliLink 的差异：本链入口是服务端构造的常量
  // URL 而非用户输入，逐跳域白名单已把连接面钉死在 B 站本系——不引
  // resolvesToPublicIp/makeGuardedLookup（*.bilibili.com 解析进私网需要
  // 上游 DNS 本身被控，彼时 SSR 页已是敌意输入，防线在 eval 沙箱不在
  // 建连层）。域闸前置后 res.url 终态断言被结构性取代（manual 下 res.url
  // 即本跳已校验 URL，post-check 无增量）——缺席的 res.url 不再判越域
  const sig = signal
    ? AbortSignal.any([AbortSignal.timeout(BILI_TIMEOUT_MS), signal])
    : AbortSignal.timeout(BILI_TIMEOUT_MS); // 整链共享一份总预算——跳解不放大超时面
  let href = reqUrl;
  let res = null;
  for (let hop = 0; hop <= 3; hop++) {
    const checked = normalizeOutboundUrl(href);
    if (!checked.ok) throw new Error(`bilibili search 目标非法（${checked.code}）`);
    if (!isBiliPageHost(checked.url.hostname)) {
      throw new Error(`bilibili search 重定向越域（终态 ${checked.url.hostname}）`);
    }
    res = await fetch(checked.url.href, {
      headers: BILI_PUBLIC_HEADERS,
      redirect: 'manual',
      signal: sig,
    });
    const loc = res.status >= 300 && res.status < 400 ? res.headers?.get?.('location') : null;
    if (!loc) break; // 终态（含无 location 的 3xx——!res.ok 在下方统一抛）
    await res.body?.cancel().catch(() => {}); // 跳解响应体不读——排水后放掉
    try { href = new URL(loc, checked.url.href).toString(); }
    catch { throw new Error('bilibili search 重定向 location 畸形'); }
    res = null;
  }
  if (!res) throw new Error('bilibili search 重定向跳数超限（>3 跳仍 3xx）');
  if (!res.ok) throw new Error(`bilibili search HTTP ${res.status}`);
  const pinia = evalPiniaIsland(await readSearchHtml(res), { timeoutMs: evalTimeoutMs });
  const all = pinia?.searchResponse?.searchAllResponse;
  const buckets = Array.isArray(all?.result) ? all.result : null;
  let videoData = null;
  if (buckets && buckets.every(b => b && typeof b === 'object')) {
    const hit = buckets.find(b => b.result_type === 'video');
    if (!hit) videoData = [];                     // 合法零视频命中——空态不归 502
    else if (Array.isArray(hit.data)) videoData = hit.data;
  }
  if (videoData === null) {
    throw new Error('bilibili search 数据岛解析失败（pinia 缺席或形态漂移）');
  }
  return {
    items: videoData.map(videoItemToRow).filter(v => v.bvid),
    seid: all.seid ?? null,
    numResults: Number(all.numResults) || 0,
  };
}

// 搜索建议：web-interface/suggest → result.tag[].value（高亮在 name 字段，
// value 是纯文本；em 剥洗仍做——上游字段互换防御）。免签名免 cookie
async function biliSuggest(term, { signal } = {}) {
  const data = await biliFetch(`/x/web-interface/suggest?term=${encodeURIComponent(term)}`, signal);
  const tags = data?.result?.tag;
  if (!Array.isArray(tags)) return [];
  return tags.map(t => stripSearchEm(t?.value ?? t?.name))
    .map(s => s.trim()).filter(Boolean).slice(0, 20);
}

// 相关视频：archive/related → data[]（免签名，上游给 ~40 条上限）。
// 归一与搜索同孔径（owner.name→author、duration 秒数数字、tid→typeid）；
// 种曲剔除与分区裁剪都归路由层——本函数只做上游搬运
async function biliRelated(bvid, { signal } = {}) {
  const data = await biliFetch(`/x/web-interface/archive/related?bvid=${encodeURIComponent(bvid)}`, signal);
  return (Array.isArray(data) ? data : []).map(videoItemToRow).filter(v => v.bvid);
}

const viewQuery = (id) => typeof id === 'string' ? `bvid=${id}` : `aid=${id.aid}`;

// playurl 选流：音频按 bandwidth 降序（30280≈192k > 30232≈108k > 30216≈64k）；
// prefer='best'（下载档）把 dash.flac.audio（Hi-Res 无损）与 dash.dolby.audio
// （杜比）排在常规 AAC 前——flac > dolby > aac：无损严格优于有损空间音频，
// 这两条轨需要 fnval 相应位标志且大多要登录态，缺席时自然回落常规档。
// 视频优先 avc1（H.264 全浏览器可放）再按分辨率降序——hevc/av01 老设备放不了；
// opts.anyCodec（仅下载链）放开全编码排序——同像素仍 avc1 优先，但 4K/8K/HDR
// 的非 avc1 档可达。返回排序后的完整数组——单档流的备份 URL 全被端口策略拒时
// 还能降级到下一档
function pickStreamList(data, kind, prefer = '', opts = {}) {
  const dash = data?.dash || {};
  if (kind === 'audio') {
    const audioArr = Array.isArray(dash.audio) ? dash.audio : [];
    // 数组条目可能是 null/非对象（上游脏数据）——sort 比较器与视频路同
    // 口径用 ?.，否则一个脏条目就 TypeError 炸穿整个 502
    const regular = audioArr.slice().sort((a, b) => (b?.bandwidth || 0) - (a?.bandwidth || 0));
    if (prefer === 'best') {
      // hasUrl 认全部四个地址字段——只带 backupUrl 的条目不该被预过滤丢档
      const hasUrl = (f) => f && (f.baseUrl || f.base_url
        || (Array.isArray(f.backupUrl) && f.backupUrl.length)
        || (Array.isArray(f.backup_url) && f.backup_url.length));
      // flac.audio 文档形态是单对象；上游若改成多档数组 concat 也兼容
      const flac = [].concat(dash.flac?.audio || []).filter(hasUrl);
      // dolby.audio 同 flac 兼容单对象/数组形态——routes 的 hasDolby 谓词
      // 两种形态都认，这里漏单对象会让「有杜比标」的稿件下载不到杜比轨
      const dolby = [].concat(dash.dolby?.audio || [])
        .filter(hasUrl).sort((a, b) => (b?.bandwidth || 0) - (a?.bandwidth || 0));
      return [...flac, ...dolby, ...regular];
    }
    return regular;
  }
  // 同像素决胜帧率再比码率——1080P / 1080P高码率 / 1080P60 的 h*w 相同，
  // 裸像素序靠上游数组顺序碰巧正确（首项即最高 id），上游改序即静默降级。
  // frameRate/frame_rate 上游两种拼法都出现过；bandwidth 天然随档位递增
  const bvFps = (v) => Number(v?.frameRate ?? v?.frame_rate) || 0;
  const px = (v) => (v?.height || 0) * (v?.width || 0);
  const all = Array.isArray(dash.video) ? dash.video : [];
  if (opts.anyCodec) {
    // 下载档放开编码面：4K/8K/HDR/杜比视界常只发 hev1/av01——像素更高的
    // 非 avc1 档必须可达（hev1/dvh1/av01/vp9 进 mp4 均合法封装）；同像素
    // 仍优先 avc1 保浏览器直放——播放链不传 anyCodec，兼容性口径不受牵连
    const avcRank = (v) => (v?.codecs || '').startsWith('avc1') ? 1 : 0;
    return all.slice().sort((a, b) => px(b) - px(a)
      || avcRank(b) - avcRank(a)
      || bvFps(b) - bvFps(a)
      || (b?.bandwidth || 0) - (a?.bandwidth || 0));
  }
  const avc = all.filter(v => (v?.codecs || '').startsWith('avc1'));
  return (avc.length ? avc : all)
    .slice().sort((a, b) => px(b) - px(a)
      || bvFps(b) - bvFps(a)
      || (b?.bandwidth || 0) - (a?.bandwidth || 0));
}
const pickStreams = (data) => ({
  audio: pickStreamList(data, 'audio')[0] || null,
  video: pickStreamList(data, 'video')[0] || null,
});

// 分P参数：?p=N 从输入 URL 提取（多分P稿件导哪P播哪P，默认P1）
function pickPageParam(input) {
  const m = String(input || '').match(/[?&]p=(\d+)/);
  return m ? Math.max(1, parseInt(m[1], 10)) : 1;
}

// 分P cid 定位：pages[p-1].cid ?? view.cid——playurl cid 自愈与 /resolve 共用。
// 不能回落裸 view.cid（那是 P1，会把分P导入的曲静默拉回第一P）
function pickCidFromView(view, pageWanted) {
  const pages = Array.isArray(view?.pages) ? view.pages : [];
  const idx = Math.min(pageWanted, Math.max(pages.length, 1)) - 1;
  return pages[idx]?.cid ?? view.cid;
}

// B 站质量号 → 近似像素高度：合流 durl 只回 quality 号不带 w/h，与
// 自适应轨比较高低的共用口径（80/116/120 等档到不了原值，取下档保守估计）
const QN_HEIGHT = { 127: 4320, 125: 4320, 121: 2160, 120: 2160, 117: 1080, 116: 1080, 112: 1080, 100: 1080, 80: 1080, 74: 720, 64: 720, 32: 480, 16: 360, 15: 360, 6: 240 };

// 下载侧 playurl 解析：providerData.cid 缺失/过期自愈（UP 主换源/调 P 后
// 库存 cid 失效——按 p 重查对应分P）。fnval 4048=DASH 全轨响应，1=MP4 合流
// （durl 形态，无 ffmpeg 环境的视频兜底路）；qn 是目标质量号——对 durl 档
// 缺省按 16 给 360p；对 DASH 缺省会让 accept_quality 列出的高档（116/120/
// 125/127 等）不进 dash.video[]——求高画质必须显式给。DASH 统一补 127，
// 权限不足上游自动钳回账户/稿件天花板，无副作用
async function resolveBiliPlayurl({ bvid, cid, page = 1, signal, fnval = 4048, qn = 0 }) {
  const effQn = qn || (fnval === 1 ? 0 : 127);
  const playurlOf = (useCid) =>
    biliFetch(`/x/player/playurl?bvid=${bvid}&cid=${useCid}&fnval=${fnval}&fourk=1${effQn ? `&qn=${effQn}` : ''}`, signal);
  // cid 缺省时先查 view 定位分P cid——直接发 cid=undefined 是上游 400
  let useCid = /^\d+$/.test(String(cid || '')) ? String(cid) : null;
  if (!useCid) {
    const view = await biliFetch(`/x/web-interface/view?bvid=${bvid}`, signal);
    useCid = pickCidFromView(view, page);
  }
  try {
    return await playurlOf(useCid);
  } catch (e) {
    // cid 过期自愈：只对「调用方传了合法数字 cid」自愈——本来就没有 cid 的
    // 输入重查 view 也只会得到同一个值，再试是浪费一跳
    if (!/^\d+$/.test(String(cid || ''))) throw e;
    const view = await biliFetch(`/x/web-interface/view?bvid=${bvid}`, signal);
    return await playurlOf(pickCidFromView(view, page));
  }
}

// 单档流的主链+备份链摊平成顺序候选——端口策略/边缘拒绝按档降级。
// 上游常同时下发值相同的 baseUrl 与 base_url——URL 级去重防同链烧两次
// 候选位；主 url 在前、backup 殿后
const flatUrls = (s, extra = {}) =>
  [...new Set(
    [s?.baseUrl, s?.base_url,
      ...(Array.isArray(s?.backupUrl) ? s.backupUrl
        : (Array.isArray(s?.backup_url) ? s.backup_url : []))]
      .filter(u => typeof u === 'string' && u)
  )].map(url => ({ url, ...extra }));

// 音频下载候选：prefer='best' 让 Hi-Res/杜比轨排在常规 AAC 前（BILI_COOKIE
// 有权限才下发，否则自然回落最高码率 AAC）。
async function resolveBiliAudio({ bvid, cid, page = 1, signal }) {
  const playurl = await resolveBiliPlayurl({ bvid, cid, page, signal });
  return pickStreamList(playurl, 'audio', 'best')
    .flatMap(s => flatUrls(s, { mimeType: s?.mimeType || '', br: s?.bandwidth || null }));
}

// 视频下载物料：DASH 自适应视频轨（全编码，像素降序、同像素 avc1 优先）
// + 常规 AAC 音轨（合流用——
// flac/杜比轨塞不进 mp4 容器）+ 懒取 MP4 合流兜底（无 ffmpeg 时 fnval=1 再打一跳）
async function resolveBiliMedia({ bvid, cid, page = 1, signal }) {
  const dash = await resolveBiliPlayurl({ bvid, cid, page, signal, fnval: 4048 });
  return {
    // 全编码档摊平：4K/8K 常只有 hev1/av01——hev1/dvh1 合流时 ffmpegMux
    // 给 -tag:v hvc1 保 Apple 兼容；同像素仍优先 avc1（pickStreamList best
    // 档已排序），mp4 容器对这些编码均合法
    videos: pickStreamList(dash, 'video', 'best', { anyCodec: true })
      .flatMap(s => flatUrls(s, {
        mimeType: s?.mimeType || '', br: s?.bandwidth || null,
        w: s?.width || 0, h: s?.height || 0,
        codec: s?.codecs || ''
      })),
    // 合流音轨限 audio/mp4 与 yt 侧口径对齐——上游若混入 opus/eac3 等非
    // mp4 封装轨，-c:a copy 进 mp4 产的是浏览器无声文件
    audios: pickStreamList(dash, 'audio')
      .filter(s => (s?.mimeType || '').startsWith('audio/mp4'))
      .flatMap(s => flatUrls(s, { mimeType: s?.mimeType || '', br: s?.bandwidth || null })),
    // MP4 合流（durl）：无 ffmpeg 兜底 + 匿名 DASH 封顶 480p 时反超到 720p
    // 的升级路——实测同一稿件 dash 只回 480p/360p 而 fnval=1&qn=80 的 durl
    // 给到 720p。h 挂质量号折算高度供调用方与自适应轨比高低；memoize 存
    // promise 本身——「比高」与「兜底」两处消费（含并发）只打一跳。
    // durl 是分段数组（d.order 递增），length>1 时各段是顺序拼接而非镜像——
    // 摊平成候选会只下/播首段，保守放弃整条合流路让自适应接管
    progressive: (() => {
      let pending = null;
      return () => {
        pending = pending || resolveBiliPlayurl({ bvid, cid, page, signal, fnval: 1, qn: 80 })
          .then(data => {
            const durl = Array.isArray(data?.durl) ? data.durl : [];
            if (durl.length !== 1) return [];
            const h = QN_HEIGHT[data?.quality] || 0;
            return [durl[0]?.url, ...(Array.isArray(durl[0]?.backup_url) ? durl[0].backup_url : [])]
              .filter(u => typeof u === 'string' && u)
              .map(url => ({ url, mimeType: 'video/mp4', br: null, h }));
          })
          .catch(e => { pending = null; throw e; });
        return pending;
      };
    })(),
  };
}

module.exports = {
  // 带 Cookie 的完整头不导出——外部误用于其他 fnval/非 api 域请求会错配
  // 或泄 cookie；公共面只有 BILI_PUBLIC_HEADERS 与 hasBiliCookie 布尔面
  hasBiliCookie, BILI_PUBLIC_HEADERS, BILI_TIMEOUT_MS, QN_HEIGHT,
  biliFetch, pickStreamList, pickStreams, pickPageParam, pickCidFromView,
  flatUrls,
  viewQuery, parseBvid, resolveBiliLink, isBiliLinkHost, resolveBiliAudio, resolveBiliMedia,
  // 曲库面：SSR 数据岛搜索/建议/相关 + 音乐分区白名单 + 条目归一
  biliSearchVideos, biliSuggest, biliRelated, musicZoneOf, videoItemToRow,
  BVID_RE,
};

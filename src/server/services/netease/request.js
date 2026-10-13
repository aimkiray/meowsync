// NetEase 上游请求层——明文 /api/ 通道。本机零 cookie 实测（2026-10）：
// music.163.com/api/* 明文 POST 全部 17 端点存活，应答 schema 与旧
// weapi/eapi 通道逐位相同（eapi 应答本就不加密 e_r:false），
// weapi/eapi 加密面已整体退役。
// 保留的可观察语义：cookie 组装（游客 MUSIC_A、随机 NMTID/_ntes_nuid、
// 进程级 WNMCID/deviceId——风控指纹与加密无关）、web 表单形态（Chrome
// UA + Referer + csrf_token 直铺）、{status, body, cookie[]} 应答契约、
// 特殊业务码 → 200 映射、非 200 reject(answer)（非 Error——消费方靠形态识别）。
// 传输换原生 fetch + AbortSignal（超时是真取消，不再留 axios 僵尸请求）。
const crypto = require('crypto');

const DOMAIN = 'https://music.163.com';
const DEFAULT_TIMEOUT_MS = 30000;

// 进程级稳定标识（上游用 global.deviceId/WNMCID 同款惰性语义——原实现里
// global.deviceId 从未被赋值恒 undefined；此处生成随机 hex 仅改善指纹一致性。
// 真机格式对齐上游 data/deviceid.txt：52 字符大写 hex）
const DEVICE_ID = crypto.randomBytes(26).toString('hex').toUpperCase();
const WNMCID = (() => {
  let s = '';
  for (let i = 0; i < 6; i++) s += 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)];
  return `${s}.${Date.now()}.01.0`;
})();

// 上游 osMap：cookie.os 是选择器键（'pc'/'linux'/'android'/'iphone'→整套指纹），
// 不是终值——显式 cookie.os='pc' 要产出整套 pc 指纹而非 pc+iOS 缝合体
const OS_MAP = {
  pc: { os: 'pc', appver: '3.0.18.203152', osver: 'Microsoft-Windows-10-Professional-build-22631-64bit', channel: 'netease' },
  linux: { os: 'linux', appver: '1.2.1.0428', osver: 'Deepin 20.9', channel: 'netease' },
  android: { os: 'android', appver: '8.20.20.231215173437', osver: '14', channel: 'xiaomi' },
  iphone: { os: 'iPhone OS', appver: '9.0.90', osver: '16.2', channel: 'distribution' },
};

// 明文 /api 走 web 表单形态——Chrome UA（旧 weapi 通道同款头面；
// eapi 的 iPhone 缝合头随加密通道一并退役）
const UA_WEB = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0';

const SPECIAL_BODY_CODES = new Set([201, 302, 400, 502, 800, 801, 802, 803]);

function cookieToJson(str) {
  if (!str) return {};
  const obj = {};
  for (const part of String(str).split(';')) {
    const idx = part.indexOf('=');
    // 上游按 split('=') 且长度恰为 2 才收录——多 '=' 的值（base64）会被丢弃。
    // indexOf 版本保留多 '=' 值更符合浏览器 cookie 语义，但为忠实对齐上游
    // 形态沿用「恰好一个等号」判定
    if (idx > 0 && part.indexOf('=', idx + 1) === -1) {
      obj[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    }
  }
  return obj;
}

const cookieObjToString = (cookie) => Object.keys(cookie)
  .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(cookie[k])}`)
  .join('; ');

const hex = (n) => crypto.randomBytes(n).toString('hex');

// 组装上游期望的 cookie 面：调用方 cookie（网关已白名单过滤）+ 游客态默认字段。
// 无 MUSIC_U 时注空 MUSIC_A——对齐 init-anonymous-token 建空文件的现状语义
function buildCookie(cookie) {
  if (typeof cookie === 'string') cookie = cookieToJson(cookie);
  if (typeof cookie !== 'object' || !cookie) return { map: {} };
  // 上游 _ntes_nuid 是 randomBytes(16) = 32 hex 字符——hex(32) 产 64 字符，
  // 指纹长度在风控眼里是异常信号（同函数 NMTID hex(16) 已与上游一致）。
  // _ntes_nnid 拼接 nuid 一并继承正确长度
  const nuid = hex(16);
  const os = OS_MAP[cookie.os] || OS_MAP.iphone;
  const map = {
    ...cookie,
    __remember_me: 'true',
    ntes_kaola_ad: '1',
    _ntes_nuid: cookie._ntes_nuid || nuid,
    _ntes_nnid: cookie._ntes_nnid || `${nuid},${Date.now()}`,
    WNMCID: cookie.WNMCID || WNMCID,
    WEVNSM: cookie.WEVNSM || '1.0.0',
    osver: cookie.osver || os.osver,
    deviceId: cookie.deviceId || DEVICE_ID,
    os: cookie.os || os.os,
    channel: cookie.channel || os.channel,
    appver: cookie.appver || os.appver,
  };
  // MUSIC_A 兜底在 merge 内而非单通道分支——上游 request.js:113-116 同位置
  // 且仍带 !MUSIC_U 门（登录态不该多写 MUSIC_A 键位）；匿名 token 非空时
  // 两通道都应携带（当前空 token 下 wire 等价）
  if (!map.MUSIC_U) map.MUSIC_A = map.MUSIC_A || '';
  return { map };
}

/**
 * @returns Promise<{status, body, cookie[]}>——非 200 业务码 reject(answer)
 * 而非 resolve（playlist-sync/music.js 的 isUpstreamAnswer 依赖此形态）
 */
async function request(uri, data, { cookie, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  const cookieObj = typeof cookie === 'string' ? cookieToJson(cookie)
    : (typeof cookie === 'object' && cookie) || {};
  const csrfToken = cookieObj.__csrf || '';
  const headers = {};

  // 明文通道：业务字段直铺 form（无 params= 密文）。Cookie map 仍注整套
  // 指纹——NMTID/_ntes_nuid/deviceId/WNMCID 是风控身份而非加密部件；
  // 旧 weapi 分支的 login 门沿用（登录链不该被注入的 NMTID 覆盖上游下发值）
  const { map } = buildCookie(cookieObj);
  if (uri.indexOf('login') === -1) map.NMTID = hex(16);
  headers.Referer = DOMAIN;
  headers['User-Agent'] = UA_WEB;
  headers.Cookie = cookieObjToString(map);
  // csrf_token 写在 spread 后——data 夹带的伪造 csrf_token 被真值覆盖
  const form = { ...data, csrf_token: csrfToken };
  const url = `${DOMAIN}${uri}`;

  const answer = { status: 500, body: {}, cookie: [] };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
      // 上游用 node querystring.stringify——undefined 值产出 'key=' 空值而
      // 非丢键（丢 undefined 是 qs 库语义）；此处滤掉是对齐 qs 系干净形态
      // 的主动选择：URLSearchParams 会序列化出 'key=undefined' 字面量
      body: new URLSearchParams(
        Object.fromEntries(Object.entries(form).filter(([, v]) => v !== undefined))
      ).toString(),
      // Fixed-domain upstream has no legitimate redirect semantics — never
      // follow silently; a 3xx arrives verbatim and is forced into the error
      // path below instead of being re-targeted cross-origin
      redirect: 'manual',
      signal: AbortSignal.any([
        AbortSignal.timeout(timeoutMs),
        ...(signal ? [signal] : []),
      ]),
    });
    answer.cookie = res.headers.getSetCookie()
      .map(x => x.replace(/\s*Domain=[^(;|$)]+;*/g, ''));
    const raw = await res.text();
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      // 不可解析体仍归 raw 字符串走原形态，不新造错误路径
      body = raw;
    }
    // 上游偶发把明文 /api 请求回 eapi 密文——两种形态都留痕：裸 32+ 位
    // hex 应答体（JSON.parse 失败归 raw），或 JSON 壳里 data 字段塞整段
    // hex。对消费方是不可解析噪声，warn 便于定位通道侧漂移
    if (/^[0-9a-f]{32,}/.test(raw.trim())
      || (body && typeof body === 'object' && typeof body.data === 'string'
        && /^[0-9a-f]{32,}$/.test(body.data))) {
      console.warn('[netease] 明文 /api 应答疑似密文:', uri);
    }
    answer.body = body;
    if (body && typeof body === 'object' && body.code) body.code = Number(body.code);
    answer.status = Number(body?.code || res.status);
    if (body && typeof body === 'object' && SPECIAL_BODY_CODES.has(body.code)) {
      answer.status = 200;
    }
    // A real 3xx (redirect:'manual' above) must not be laundered into success
    // by a body-level code — {code:302} on an HTTP 302 would otherwise hit
    // SPECIAL_BODY_CODES and map to 200
    if (res.status >= 300 && res.status < 400) answer.status = res.status;
    if (!(answer.status > 100 && answer.status < 600)) answer.status = 400;
  } catch (e) {
    // 网络/超时错误对齐上游 502 envelope；msg 放 err.message 而非 Error 对象
    // （上游塞的是 err 本体，消费方实际只用 code/msg 字符串）
    answer.status = 502;
    answer.body = { code: 502, msg: e?.message || String(e) };
  }
  if (answer.status === 200) return answer;
  throw answer;
}

module.exports = { request, cookieToJson, cookieObjToString };

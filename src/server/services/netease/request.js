// NetEase 上游请求层——复刻 NeteaseCloudMusicApi/util/request.js 的可观察语义：
// cookie 组装（游客 MUSIC_A、随机 NMTID/_ntes_nuid、进程级 WNMCID/deviceId）、
// weapi/eapi 通道的 UA 与 Cookie 头形态、{status, body, cookie[]} 应答契约、
// 特殊业务码 → 200 映射、非 200 reject(answer)（非 Error——消费方靠形态识别）。
// 传输换原生 fetch + AbortSignal（超时是真取消，不再留 axios 僵尸请求）。
const crypto = require('crypto');
const { weapiEncrypt, eapiEncrypt } = require('./crypto');

const DOMAIN = 'https://music.163.com';
const API_DOMAIN = 'https://interface.music.163.com';
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

const UA = {
  weapi: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
  eapi: 'NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)',
};

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
  const nuid = hex(32);
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
async function request(uri, data, { crypto: mode = 'eapi', cookie, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  const cookieObj = typeof cookie === 'string' ? cookieToJson(cookie)
    : (typeof cookie === 'object' && cookie) || {};
  const csrfToken = cookieObj.__csrf || '';
  const headers = {};
  let url, form;
  const payload = { ...data };

  if (mode === 'weapi') {
    const { map } = buildCookie(cookieObj);
    if (uri.indexOf('login') === -1) map.NMTID = hex(16);
    headers.Referer = DOMAIN;
    headers['User-Agent'] = UA.weapi;
    headers.Cookie = cookieObjToString(map);
    payload.csrf_token = csrfToken;
    form = weapiEncrypt(payload);
    url = `${DOMAIN}/weapi/${uri.slice(5)}`;
  } else {
    // eapi：Cookie 头只含重建的 header 对象（上游 request.js:158-180 语义——
    // header 读 merge 后的 cookie 字段，os='pc' 这类选择器经 osMap 展开后
    // 要渗透进这里；versioncode/mobilename/buildver/resolution 是 header
    // 独占字段不经 merge）。MUSIC_U/MUSIC_A 上游是 if-truthy 条件写入——
    // 空 anonymous_token 下键位本身缺席而非空值
    const { map } = buildCookie(cookieObj);
    const header = {
      osver: map.osver,
      deviceId: map.deviceId,
      os: map.os,
      appver: map.appver,
      versioncode: cookieObj.versioncode || '140',
      mobilename: cookieObj.mobilename || '',
      buildver: cookieObj.buildver || Date.now().toString().slice(0, 10),
      resolution: cookieObj.resolution || '1920x1080',
      __csrf: csrfToken,
      channel: map.channel,
      requestId: `${Date.now()}_${Math.floor(Math.random() * 1000).toString().padStart(4, '0')}`,
    };
    if (map.MUSIC_U) header.MUSIC_U = map.MUSIC_U;
    if (map.MUSIC_A) header.MUSIC_A = map.MUSIC_A;
    headers.Cookie = cookieObjToString(header);
    headers['User-Agent'] = UA.eapi;
    payload.header = header;
    // 上游恒写 e_r:false（APP_CONF.encryptResponse=false 且 e_r 在网关
    // BLOCKED_PARAMS 内）——不实现 eapiResDecrypt 即不需要真值
    payload.e_r = false;
    form = eapiEncrypt(uri, payload);
    url = `${API_DOMAIN}/eapi/${uri.slice(5)}`;
  }

  const answer = { status: 500, body: {}, cookie: [] };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
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
      body = raw;
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

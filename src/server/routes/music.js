const { Hono } = require('hono');
const { apiModules, callNeteaseApi, resolveSongUrls } = require('../services/netease-api');
// 流式限长读取：Content-Length 只是声明值，chunked 请求必须读流按字节截断
const { readParamsBody } = require('../lib/http-body');
const { stripAbsolutePaths } = require('../lib/sanitize');
const { trustProxyEnabled } = require('../lib/env');

const app = new Hono();

// 仅放行前端实际使用的只读 API，避免暴露登录、发短信等高危端点
const ALLOWED_APIS = new Set([
  'search',
  'cloudsearch',
  'search_suggest',
  'search_hot',
  'playlist_detail',
  'playlist_track_all',
  'toplist',
  'song_url',
  'song_url_v1',
  'song_detail',
  'lyric',
  'lyric_new',
  'check_music',
  'album',
  'artists',
  'banner',
  'personalized',
]);

// 请求体上限：这些 API 只需小 JSON/表单参数，大包只会消耗内存（解析前按 Content-Length 拒绝）
const MAX_BODY_BYTES = 1024 * 1024;

// 上游模块会消费的危险参数（比较前统一转小写，覆盖 realIP 等大小写变体）：
// proxy 可把上游请求走私到攻击者代理，real_ip/realIP 可伪造客户端IP；
// crypto='api' 会让上游走明文无签名通道、ua 允许篡改发往网易的 User-Agent、
// e_r 改变上游响应形态——三者都是 createOption() 的 option 通道参数，前端从不下发，统一封禁
const BLOCKED_PARAMS = new Set([
  'proxy', 'real_ip', 'realip', 'crypto', 'ua', 'e_r',
  // request.js: options.ip 同样会写进 X-Real-IP/X-Forwarded-For（IP 伪造）
  'ip',
  // Enhanced 分叉识别的扩展参数——本版本不存在但封上没坏处：
  // domain 可整包重定向上游请求（连带转发的登录 Cookie 一起漏给攻击者主机）
  'domain', 'checktoken', 'randomcnip'
]);

// Cookie 转发上游的白名单：仅网易登录态相关键（MUSIC_U 全系/CSRF/NMTID 等）。
// 客户端 Cookie 头里可能混着本站域的 SSO/网关凭据——整包转发即外泄
const NETEASE_COOKIE_KEYS = new Set([
  'MUSIC_U', 'MUSIC_U_T', 'MUSIC_U_E', 'MUSIC_A', 'MUSIC_A_T',
  '__csrf', '__remember_me', 'NMTID', 'NTES_PASSPORT', 'P_INFO',
  'ntes_kaola_ad', 'sDeviceId', 'WM_NI', 'WM_NIKE', 'WM_TID'
]);

// 由请求推导对外访问源
// x-forwarded-* 头仅在 TRUST_PROXY=1/true 时采信——否则客户端可伪造该头，污染下发给前端的 audio-proxy 地址
// c.req.url 由 @hono/node-server 基于 Host 头与 socket 加密状态构建（Host 是客户端实际拨号的地址）
function requestOrigin(c) {
  const url = new URL(c.req.url);
  const trustProxy = trustProxyEnabled();
  const fwdProto = trustProxy ? c.req.header('x-forwarded-proto') : null;
  const fwdHost = trustProxy ? c.req.header('x-forwarded-host') : null;
  const proto = (fwdProto || url.protocol.replace(':', '')).split(',')[0].trim();
  const host = (fwdHost || url.host).split(',')[0].trim();
  return `${proto}://${host}`;
}

// 上游统一返回结构 {status, body, cookie}
// 注意：NeteaseCloudMusicApi 的 request() 对非 200 响应是 reject(answer) 而非 resolve，
// 因此该函数同时供 try（resolve 路径）与 catch（reject 路径）复用
function sendUpstreamResult(c, answer) {
  // Cookie 回传：上游的 Set-Cookie（登录态/匿名token）透传给客户端。
  // 滤掉与本站会话同名的项——上游若下发 ms_session=xxx 会覆盖客户端的
  // 有效会话 cookie（造不出合法 token，但能把用户踢回登录页）
  if (Array.isArray(answer.cookie)) {
    for (const cookieStr of answer.cookie) {
      if (/^ms_session=/i.test(String(cookieStr).trim())) continue;
      c.header('Set-Cookie', cookieStr, { append: true });
    }
  }
  // 上游 4xx/5xx 状态透传为 HTTP 状态码（301 等非错误码仍返回 200，错误细节在 body.code）
  const upstreamStatus = Number.isInteger(answer.status) && answer.status >= 400 && answer.status < 600
    ? answer.status
    : 200;
  c.status(upstreamStatus);
  // answer.body 缺失时不能把整个 envelope（status/cookie）序列化出去——
  // cookie 明文会落进响应体。但也不能回 {}——那会破坏 {code,message} 契约，
  // 前端 extractErrorMessage 只得 undefined 回落到 axios 英文错误
  let body = answer.body ?? {
    code: upstreamStatus >= 400 ? upstreamStatus : 500,
    message: '上游请求失败'
  };
  // body 本身若非 plain object（Error/AxiosError/数组/字符串错误页）：
  // AxiosError 的 toJSON 会把 stack 和 config.headers.Cookie（含转发的
  // MUSIC_U 登录态）序列化透出；字符串 body 可能是上游 HTML 错误页。
  // 一律收敛为 {code,message} 信封（code 不能是 200——前端会当正常数据渲染）。
  // 用 getPrototypeOf 而非 constructor——上游 body 可能自带 constructor 键遮蔽
  // 非 object（含 null/字符串）直接判非 plain；object 再比原型
  const isPlainObject = body !== null && typeof body === 'object'
    && [Object.prototype, null].includes(Object.getPrototypeOf(body));
  if (!isPlainObject) {
    body = { code: upstreamStatus >= 400 ? upstreamStatus : 500, message: '上游请求失败' };
  } else {
    // msg 是活的 AxiosError 时取其 message；msg/message 字符串都可能带
    // 服务器绝对路径（fs ENOENT、tmpdir 读失败）——统一剥离
    const cleaned = {};
    for (const key of ['msg', 'message']) {
      if (body[key] && typeof body[key] === 'object') {
        cleaned[key] = stripAbsolutePaths(String(body[key].message || '上游请求失败'));
      } else if (typeof body[key] === 'string') {
        cleaned[key] = stripAbsolutePaths(body[key]);
      }
    }
    body = { ...body, ...cleaned };
  }
  return c.json(body);
}

// 判断 catch 到的是否为上游 answer 对象（区别于真正的 Error/字符串异常）。
// body 可缺省——上游 reject({status:460}) 无 body 时也必须被识别，否则直接 500。
// 排除 Error 实例：axios/fetch 错误可能带 status 字段，走 400 会丢错误详情
function isUpstreamAnswer(err) {
  return err != null && typeof err === 'object' && !(err instanceof Error)
    && Number.isInteger(err.status);
}

app.get('/', (c) => {
  return c.json({
    message: 'MeowSync Music API Server',
    version: '1.0.0',
    availableApis: [...ALLOWED_APIS].sort(),
    usage: 'GET/POST /:apiName with query parameters or body data',
    examples: [
      '/search?keywords=周杰伦',
      '/song_url?id=33894312',
      '/playlist_detail?id=24381616',
      '/lyric?id=33894312'
    ]
  });
});

app.all('/:apiName', async (c) => {
  const apiName = c.req.param('apiName');

  if (!ALLOWED_APIS.has(apiName) || !apiModules[apiName]) {
    return c.json({ code: 404, message: `API '${apiName}' not found` }, 404);
  }

  // 合并 query 与 body 参数
  let body = {};
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    try {
      body = await readParamsBody(c, MAX_BODY_BYTES);
    } catch (error) {
      // 只认显式标记的 body 超限：裸 .status 不可信（axios 错误也带 status）
      if (error.exposed === true && error.status === 413) {
        return c.json({ code: 413, message: 'Payload Too Large' }, 413);
      }
      // 慢速/断流上传的非 413 读流错误：静默回落会把"客户端异常"打成正常上游请求，
      // 至少留日志可排障
      console.warn(`[music] ${apiName} 请求体读取失败，按空 body 处理:`, error.message);
      body = {};
    }
  }
  const params = { ...c.req.query(), ...body };
  for (const key of Object.keys(params)) {
    if (BLOCKED_PARAMS.has(key.toLowerCase())) delete params[key];
  }
  // 内部参数：purpose 只影响服务端解锁后处理，不透传给上游模块
  const purpose = params.purpose === 'download' ? 'download' : 'playback';
  delete params.purpose;
  // Cookie 双向透传：客户端显式携带的 Cookie 转发给上游（登录态支持）。
  // 白名单收敛到网易登录态键——整包转发会把本站域下的其他凭据
  // （SSO 网关的 CF_Authorization/oauth2-proxy 会话等）一并泄给第三方
  const clientCookie = c.req.header('cookie');
  if (clientCookie && !params.cookie) {
    params.cookie = clientCookie.split(';')
      .map(part => part.trim())
      .filter(part => {
        const name = part.split('=', 1)[0];
        return NETEASE_COOKIE_KEYS.has(name);
      })
      .join('; ');
    if (!params.cookie) delete params.cookie;
  }
  // 注意：body/query 显式携带的 params.cookie 不过滤是有意为之——白名单防的
  // 是浏览器自动附带的本域 ambient 凭据（SSO/网关头）外泄；显式 cookie 参数
  // 是调用方自填值，等价于他直连网易，不构成凭据泄露
  // JSON body 传来的数值参数（id/ids/uid 等）会让上游模块的 .split 抛
  // TypeError——所有安全整数统一转字符串（逗号多 id 串本身原样放行）
  for (const key of Object.keys(params)) {
    const v = params[key];
    if (typeof v === 'number' && Number.isSafeInteger(v)) {
      params[key] = String(v);
    }
  }
  // 上游慢链路（千曲歌单 detail/track_all 常超 30s 默认）放宽到 120s，
  // 与 playlist-sync 同口径——否则 UI 加载大歌单必死且每次重试另起上游请求
  const upstreamOptions = ['playlist_detail', 'playlist_track_all'].includes(apiName)
    ? { timeoutMs: 120000 }
    : {};

  try {
    const result = await callNeteaseApi(apiName, params, upstreamOptions);

    // 对 song_url 接口：若 url 为空或为试听版则尝试 UnblockNeteaseMusic fallback
    if (['song_url', 'song_url_v1'].includes(apiName) && Array.isArray(result.body?.data)) {
      const count = result.body.data.length;
      if (count > 20) {
        return c.json({ code: 400, message: `一次最多处理 20 首歌曲的解锁（收到 ${count}）` }, 400);
      }
      await resolveSongUrls(result.body.data, {
        purpose,
        proxyOrigin: requestOrigin(c),
        // 客户端断开/超时即中断逐源试错——不传播的 abort 会让每条超时请求
        // 都留一整条解锁链在后台跑完，重试只会叠加僵尸
        signal: c.req.raw.signal,
      });
    }

    return sendUpstreamResult(c, result);
  } catch (error) {
    // request() 对上游非 200 响应会 reject(answer)：还原真实状态码/body/cookie，而不是吞成 500
    if (isUpstreamAnswer(error)) {
      return sendUpstreamResult(c, error);
    }
    // 客户端主动断开（resolveSongUrls 透传 signal 中止）：响应已无法送达，
    // 按 499 语义返回且不打 error 级日志（正常断流不是服务故障）
    if (c.req.raw.signal?.aborted) {
      return c.body(null, 499);
    }
    // 只记 message：AxiosError 直接 dump 会把 config.headers.Cookie
    // （客户端转发的登录态）写进服务日志
    console.error(`Error in /${apiName}:`, error?.message || error);
    return c.json({ code: 500, message: 'Internal Server Error' }, 500);
  }
});

module.exports = app;
// SPA 兜底需要知道哪些首段是 API 名（多段路径 /song_url/x 也要返回 JSON 404）
module.exports.ALLOWED_APIS = ALLOWED_APIS;

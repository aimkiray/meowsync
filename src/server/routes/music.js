const { Hono } = require('hono');
const { apiModules, callNeteaseApi, resolveSongUrls } = require('../services/netease-api');

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
const BLOCKED_PARAMS = new Set(['proxy', 'real_ip', 'realip', 'crypto', 'ua', 'e_r']);

// 由请求推导对外访问源
// x-forwarded-* 头仅在 TRUST_PROXY=1/true 时采信——否则客户端可伪造该头，污染下发给前端的 audio-proxy 地址
// c.req.url 由 @hono/node-server 基于 Host 头与 socket 加密状态构建（Host 是客户端实际拨号的地址）
function requestOrigin(c) {
  const url = new URL(c.req.url);
  const trustProxy = ['1', 'true'].includes((process.env.TRUST_PROXY || '').toLowerCase());
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
  // Cookie 回传：上游的 Set-Cookie（登录态/匿名token）透传给客户端
  if (Array.isArray(answer.cookie)) {
    for (const cookieStr of answer.cookie) {
      c.header('Set-Cookie', cookieStr, { append: true });
    }
  }
  // 上游 4xx/5xx 状态透传为 HTTP 状态码（301 等非错误码仍返回 200，错误细节在 body.code）
  const upstreamStatus = Number.isInteger(answer.status) && answer.status >= 400 && answer.status < 600
    ? answer.status
    : 200;
  c.status(upstreamStatus);
  return c.json(answer.body ?? answer);
}

// 判断 catch 到的是否为上游 answer 对象（区别于真正的 Error/字符串异常）
function isUpstreamAnswer(err) {
  return err != null && typeof err === 'object'
    && Number.isInteger(err.status) && err.body !== undefined;
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
    // 声明长度超限直接拒绝，避免 parseBody/json 把整个大包读进内存
    // （无 Content-Length 的 chunked 请求仍会被解析，但不受此限——Node/代理层自行兜底）
    const declaredLength = Number(c.req.header('content-length') || 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      return c.json({ code: 413, message: 'Payload Too Large' }, 413);
    }
    const contentType = c.req.header('content-type') || '';
    try {
      const parsed = contentType.includes('json') ? await c.req.json() : await c.req.parseBody();
      // 仅对象形态 body 可展开为参数；数组/原始值 JSON（如 "foo"、[1,2]）展开只会产生数字键垃圾参数
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        body = parsed;
      }
    } catch {
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
  // Cookie 双向透传：客户端显式携带的 Cookie 转发给上游（登录态支持）
  // 显式 cookie 参数优先；空字符串视为未提供，回落到 Cookie 头
  const clientCookie = c.req.header('cookie');
  if (clientCookie && !params.cookie) {
    params.cookie = clientCookie;
  }

  try {
    const result = await callNeteaseApi(apiName, params);

    // 对 song_url 接口：若 url 为空或为试听版则尝试 UnblockNeteaseMusic fallback
    if (apiName === 'song_url' && Array.isArray(result.body?.data)) {
      await resolveSongUrls(result.body.data, {
        purpose,
        proxyOrigin: requestOrigin(c),
      });
    }

    return sendUpstreamResult(c, result);
  } catch (error) {
    // request() 对上游非 200 响应会 reject(answer)：还原真实状态码/body/cookie，而不是吞成 500
    if (isUpstreamAnswer(error)) {
      return sendUpstreamResult(c, error);
    }
    console.error(`Error in /${apiName}:`, error);
    return c.json({ code: 500, message: 'Internal Server Error' }, 500);
  }
});

module.exports = app;

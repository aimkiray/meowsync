/**
 * Monkey-patch for @unblockneteasemusic/server 的内部出站请求。
 *
 * 背景：库内 match() → provider.check() 会对源站 API 返回的媒体 URL 自发
 * 一次 Range 探测（src/request.js），且自行跟随 301/302 跳转——全程无协议/
 * 端口/私网判定。源站响应属攻击者可影响数据，选源期的 normalizeOutboundUrl
 * 校验发生在它返回之后，挡不住这次"盲打"（SSRF 侧信道）。
 *
 * 做法：当库内 request.js require('http'|'https') 时，返回 request() 被包装
 * 过的模块——每次调用注入一份独立的 makeGuardedLookup()：该次连接（含其
 * 全部重定向跳共享的每次 request 各一张）只允许落在解析结果全公网的地址上。
 *
 * 生效前提：本补丁必须在该库首次被 require 之前加载。
 * 加载点：netease-api-server.js（紧邻 patch-migu）+ netease-api.js 顶部。
 */

const Module = require('module');
const path = require('path');
const net = require('net');
const { makeGuardedLookup, isPrivateIp, stripIpv6Brackets } = require('./net-guard');

if (!global.__meowsyncUnmRequestPatched) {
  global.__meowsyncUnmRequestPatched = true;

  let reqPath;
  try {
    reqPath = require.resolve('@unblockneteasemusic/server/src/request.js');
  } catch {
    reqPath = path.resolve(
      __dirname, '../../../node_modules/@unblockneteasemusic/server/src/request.js'
    );
  }
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const REQ_PATH = norm(reqPath);
  const HTTP_MODULES = new Set(['http', 'https', 'node:http', 'node:https']);

  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    const loaded = originalLoad.apply(this, arguments);
    // 只改包该库 request.js 拿到的 http/https：全局替换会污染宿主全部请求
    if (
      !HTTP_MODULES.has(request) ||
      !parent ||
      norm(parent.filename || '') !== REQ_PATH ||
      !loaded ||
      typeof loaded.request !== 'function'
    ) {
      return loaded;
    }
    const origRequest = loaded.request;
    const wrappedRequest = function (a, b, c) {
      // http.request 两种签名：(options[, cb]) 与 (url[, options][, cb])
      const lookup = makeGuardedLookup();
      const guardLiteral = (hostSource) => {
        // net.connect 对 IP 字面量跳过自定义 lookup——socket 守卫拦不到，
        // 必须在发请求前同步判掉私网字面量（云元数据/内网探测目标全是 IP）。
        // hostSource 可为 options 对象 / URL / url.parse 结果 / 字符串
        let raw = hostSource?.hostname || hostSource?.host || '';
        if (!raw && typeof hostSource === 'string') {
          try { raw = new URL(hostSource).hostname; } catch { return; }
        }
        // 'host' 可能带端口（'a.com:8080'）——hostname 则已是净主机名
        if (typeof raw === 'string' && raw.includes(':') && net.isIP(raw) === 0) {
          raw = raw.split(':')[0];
        }
        const host = stripIpv6Brackets(String(raw));
        const fam = net.isIP(host);
        if (fam !== 0 && isPrivateIp(host, fam)) {
          const err = new Error(`拒绝连接非公网地址: ${host}`);
          err.code = 'ERR_DNS_GUARD_BLOCKED';
          throw err;
        }
      };
      if (typeof a === 'string' || a instanceof URL) {
        let options = b;
        let cb = c;
        if (typeof b === 'function') { cb = b; options = {}; }
        options = { ...(options || {}), lookup: options?.lookup || lookup };
        guardLiteral(options.hostname ? options : a);
        return origRequest.call(this, a, options, cb);
      }
      const options = { ...(a || {}), lookup: a?.lookup || lookup };
      guardLiteral(options);
      return origRequest.call(this, options, b);
    };
    return { ...loaded, request: wrappedRequest };
  };
}

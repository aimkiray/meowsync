const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const HEARTBEAT_INTERVAL_MS = 30000;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const CONTROL_TYPES = new Set(['play', 'pause', 'next', 'prev', 'seek', 'volume', 'play_song']);

let hostSocket = null;
const controllers = new Set();

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) {
    // 单个客户端 send 抛错（如 socket 正处于 CLOSING）不应中断广播循环、
    // 更不应冒泡成 uncaughtException 打挂进程
    try {
      ws.send(JSON.stringify(msg));
    } catch { /* 该客户端的失败由 close/error 事件接管清理 */ }
  }
}

function broadcastToControllers(msg) {
  for (const ctrl of controllers) {
    send(ctrl, msg);
  }
}

function notifyControllerCount() {
  if (hostSocket && hostSocket.readyState === hostSocket.OPEN) {
    send(hostSocket, { type: 'info', payload: { controllers: controllers.size } });
  }
}

/**
 * 解析客户端消息：仅接受 JSON 对象。
 * 关键：JSON.parse('null') 得到 null，直接读 msg.type 会抛 TypeError——
 * ws 不捕获监听器异常，会冒泡成 uncaughtException 终止进程，
 * 所以必须先做对象形态校验
 */
function parseMessage(data) {
  let msg;
  try {
    msg = JSON.parse(data);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
  return msg;
}

/**
 * 拒绝 upgrade 请求。
 * 参照 ws 库 abortHandshake 的做法：用 socket.end() 把响应写完后
 * 再随 'finish' 销毁，避免 write()+destroy() 的 RST 把响应丢弃。
 */
function rejectUpgrade(socket, code, message) {
  const body = `${message}\n`;
  socket.once('finish', () => socket.destroy());
  socket.end(
    `HTTP/1.1 ${code} ${message}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: text/plain\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      '\r\n' +
      body
  );
}

/**
 * token 比较：先 sha256 再 timingSafeEqual——摘要等长，既消除逐字节
 * 时序差也避免长度差提前返回。握手拒绝路径本身对时序不敏感，
 * 但该写法成本极低，顺带防御局域网内的时序侧信道探测
 */
function tokenMatches(provided, expected) {
  const a = crypto.createHash('sha256').update(provided ?? '').digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Origin 是否被允许：命中白名单，或与请求 Host 同源。
 * 单进程部署时页面由本服务托管，Origin host === Host header，
 * 即便 CORS_ORIGINS 未配置该域名也不应误拒自家页面。
 */
function isOriginAllowed(origin, hostHeader, allowedOrigins) {
  if (allowedOrigins.includes(origin)) return true;
  if (!hostHeader) return false;
  try {
    const o = new URL(origin);
    return (
      (o.protocol === 'http:' || o.protocol === 'https:') &&
      o.host.toLowerCase() === hostHeader.toLowerCase()
    );
  } catch {
    return false;
  }
}

/**
 * Attach WebSocket remote control to an existing HTTP server.
 * @param {import('http').Server} server
 * @param {{ allowedOrigins?: string[], token?: string }} options
 *   allowedOrigins: Origin 白名单（浏览器跨站劫持防护；非浏览器客户端无 Origin 头则放行）
 *   token: 设置后客户端必须通过 ?token= 提供相同令牌
 */
function attachRemoteControl(server, options = {}) {
  const { allowedOrigins = [], token = '' } = options;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

  const onUpgrade = (req, socket, head) => {
    // 握手完成前 socket 出错也要兜底销毁，避免未处理的 'error' 事件抛出
    socket.once('error', () => socket.destroy());

    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }

    // 精确匹配 /remote，避免 /remotexxx 误命中
    if (url.pathname !== '/remote') {
      socket.destroy();
      return;
    }

    // Origin 校验：浏览器发起 WS 必带 Origin 头，可拦跨站劫持；
    // 非浏览器客户端无 Origin 头则放行。
    // Host 头浏览器不可伪造（即实际拨号目标）；但 TRUST_PROXY 场景下反代
    // 可能把 Host 重写为内部地址，此时同源比较应基于 X-Forwarded-Host
    // （浏览器无法设置该头，仅代理想写入，采信是安全的）
    const origin = req.headers.origin;
    const trustProxy = ['1', 'true'].includes((process.env.TRUST_PROXY || '').toLowerCase());
    const fwdHost = trustProxy
      ? (req.headers['x-forwarded-host'] || '').split(',')[0].trim()
      : '';
    const hostHeader = fwdHost || req.headers.host;
    // 注意：不能加 allowedOrigins.length > 0 的跳过门——白名单为空时
    // isOriginAllowed 退化为仅同源放行，而不是放开任意站点；否则
    // CORS_ORIGINS 配空（如只有分隔符）会静默关闭整个 Origin 防护，
    // 局域网部署下任意网页都能跨站 WS 劫持（HTTP CORS 却仍是全拒，自相矛盾）
    if (origin && !isOriginAllowed(origin, hostHeader, allowedOrigins)) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }

    // 可选 token 鉴权（REMOTE_TOKEN 未设置时保持开放，兼容局域网自用）
    if (token && !tokenMatches(url.searchParams.get('token'), token)) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, url);
    });
  };
  server.on('upgrade', onUpgrade);

  // noServer 模式下 wss 自身极少触发 error，但无监听器时一旦触发会
  // 冒泡成 uncaughtException，挂个日志兜底
  wss.on('error', (err) => console.error('[remote] WebSocketServer error:', err));

  // 心跳：每 30s ping 一次，清理半开连接（手机休眠/断网导致的僵尸 socket）
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  // 兜底：心跳定时器不应单独阻止进程退出
  heartbeat.unref();

  wss.on('close', () => clearInterval(heartbeat));

  // noServer 模式下 wss.close() 不会被宿主 server 自动调用，
  // 必须在 server 'close' 时手动清理，否则心跳 interval 永久泄漏。
  // 关键：升级成功的 WS socket 不受 http.Server 的连接追踪管理
  // （server.close() / closeAllConnections() 都不会销毁它），但仍计入
  // server._connections——不主动 terminate，'close' 事件永远不会触发，
  // 优雅停机只能干等兜底强退。因此把清理句柄返回给调用方，供停机流程
  // 在 server.close() 之后立即调用
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(heartbeat);
    server.removeListener('upgrade', onUpgrade);
    // terminate() 对仍处 CONNECTING 态的 socket 会抛错，停机路径上吞掉
    for (const ws of wss.clients) {
      try { ws.terminate(); } catch { /* 已在关闭中 */ }
    }
    wss.close();
  };
  server.on('close', cleanup);

  wss.on('connection', (ws, req, url) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', () => { /* close 事件会接管清理 */ });

    const role = url.searchParams.get('role') || 'controller';

    if (role === 'host') {
      // Only one host allowed at a time
      if (hostSocket && hostSocket !== ws && hostSocket.readyState === hostSocket.OPEN) {
        hostSocket.close(4000, 'replaced by new host');
      }
      hostSocket = ws;
      console.log('[remote] host connected');

      send(ws, { type: 'info', payload: { controllers: controllers.size } });

      ws.on('message', (data) => {
        const msg = parseMessage(data);
        // host sends state_update → forward to all controllers
        // 只转发白名单字段，防止 host 塞入多余键污染下游
        if (msg && msg.type === 'state_update') {
          broadcastToControllers({ type: 'state_update', payload: msg.payload });
        }
      });

      ws.on('close', () => {
        // 仅当关闭的是当前 host 时才通知（被顶替的旧 host 不触发广播）
        if (hostSocket === ws) {
          hostSocket = null;
          console.log('[remote] host disconnected');
          broadcastToControllers({ type: 'host_disconnected' });
        }
      });

    } else {
      // controller
      controllers.add(ws);
      console.log(`[remote] controller connected (total: ${controllers.size})`);
      notifyControllerCount();

      // If host is connected, ask it to send current state
      if (hostSocket && hostSocket.readyState === hostSocket.OPEN) {
        send(hostSocket, { type: 'request_state' });
      }

      ws.on('message', (data) => {
        const msg = parseMessage(data);
        // Forward control commands to host（只转发 {type, payload} 白名单形状）
        if (msg && CONTROL_TYPES.has(msg.type) && hostSocket && hostSocket.readyState === hostSocket.OPEN) {
          send(hostSocket, { type: msg.type, payload: msg.payload });
        }
      });

      ws.on('close', () => {
        controllers.delete(ws);
        notifyControllerCount();
        console.log(`[remote] controller disconnected (total: ${controllers.size})`);
      });
    }
  });

  console.log('[remote] WebSocket remote control ready at ws://.../remote');

  // 停机流程须在 server.close() 后调用 close() 主动 terminate WS 客户端，
  // 否则升级 socket 卡住 _connections，'close' 事件不触发
  return { close: cleanup };
}

module.exports = { attachRemoteControl };

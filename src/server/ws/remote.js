const { WebSocketServer } = require('ws');

const HEARTBEAT_INTERVAL_MS = 30000;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const CONTROL_TYPES = new Set(['play', 'pause', 'next', 'prev', 'seek', 'volume', 'play_song']);

let hostSocket = null;
const controllers = new Set();

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
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
    // 非浏览器客户端无 Origin 头则放行
    const origin = req.headers.origin;
    if (
      origin &&
      allowedOrigins.length > 0 &&
      !isOriginAllowed(origin, req.headers.host, allowedOrigins)
    ) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }

    // 可选 token 鉴权（REMOTE_TOKEN 未设置时保持开放，兼容局域网自用）
    if (token && url.searchParams.get('token') !== token) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, url);
    });
  };
  server.on('upgrade', onUpgrade);

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
  // 必须在 server 'close' 时手动清理，否则心跳 interval 永久泄漏
  server.on('close', () => {
    clearInterval(heartbeat);
    server.removeListener('upgrade', onUpgrade);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  });

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
        let msg;
        try {
          msg = JSON.parse(data);
        } catch { return; }
        // host sends state_update → forward to all controllers
        if (msg.type === 'state_update') {
          broadcastToControllers(msg);
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
        let msg;
        try {
          msg = JSON.parse(data);
        } catch { return; }
        // Forward control commands to host
        if (CONTROL_TYPES.has(msg.type) && hostSocket && hostSocket.readyState === hostSocket.OPEN) {
          send(hostSocket, msg);
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
}

module.exports = { attachRemoteControl };

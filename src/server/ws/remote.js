const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const HEARTBEAT_INTERVAL_MS = 30000;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_CONTROLLERS = 32;
// 每连接消息限流：controller 只在点按时发消息；host 峰值在音量拖动——
// watch 逐帧推 state_update，高刷屏下可达 ~144/s，host 桶取 200 留足余量
const HOST_MSG_PER_SEC = 200;
const CONTROLLER_MSG_PER_SEC = 30;
const CONTROL_TYPES = new Set(['play', 'pause', 'next', 'prev', 'seek', 'volume', 'play_song']);
// controller→host 的 payload 形状校验：type 白名单之外再核形状，畸形直接丢
// （host 端的 seek/volume 数值校验是最终防线，但先把垃圾挡在转发路径上）
const CONTROL_PAYLOAD_GUARDS = {
  play: (p) => p === undefined || p === null,
  pause: (p) => p === undefined || p === null,
  next: (p) => p === undefined || p === null,
  prev: (p) => p === undefined || p === null,
  seek: (p) => typeof p === 'number' && Number.isFinite(p),
  volume: (p) => typeof p === 'number' && Number.isFinite(p),
  play_song: (p) => (typeof p === 'string' && p.length <= 128)
    || (typeof p === 'number' && Number.isSafeInteger(p))
};

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

const clampStr = (v, max) => typeof v === 'string' ? v.slice(0, max) : undefined;
const clampNum = (v) => typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/**
 * state_update payload 的服务端白名单序列化：host 不是可信端——局域网开放模式下
 * 任何人都能抢 host 角色，畸形 currentSong（如 ar 是字符串）会在每个 controller
 * 的渲染 computed 里抛 TypeError 崩掉页面。只透 controller 真正消费的字段，
 * 逐字段类型收敛；整体不合法则整条丢（比转发一半安全）
 */
function sanitizeRemoteSong(song) {
  if (!song || typeof song !== 'object' || Array.isArray(song)) return undefined;
  const artists = Array.isArray(song.ar) ? song.ar : [];
  // picUrl 只收 http(s)——恶意 host 能广播任意 URL，至少封掉 javascript:/
  // data: 之类会在 <img> 上下文语义异常的 scheme（外链本身即指 roplatform）
  const picRaw = clampStr(song.al?.picUrl, 500);
  const picUrl = picRaw && /^https?:/i.test(picRaw) ? picRaw : '';
  return {
    id: clampNum(song.id) ?? clampStr(song.id, 64) ?? null,
    name: clampStr(song.name, 300) ?? '',
    al: { picUrl },
    ar: artists.slice(0, 20).map(a => ({ name: clampStr(a?.name, 200) ?? '' }))
  };
}

function sanitizeStatePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const song = payload.currentSong;
  let currentSong = null;
  if (song !== null && song !== undefined) {
    if (typeof song !== 'object' || Array.isArray(song)) return null;
    currentSong = sanitizeRemoteSong(song);
  }
  // 待播队列：封顶 50 条，与 currentSong 同款形状校验；
  // 无效条目被丢弃而非整条作废——队列是辅助 UI，一首脏数据不该清空广播
  const queue = Array.isArray(payload.queue)
    ? payload.queue.slice(0, 50).map(sanitizeRemoteSong).filter(s => s && s.id !== null)
    : undefined;
  const queueIndexRaw = clampNum(payload.queueIndex);
  const queueIndex = queueIndexRaw === undefined
    ? -1
    : Math.min(Math.max(Math.trunc(queueIndexRaw), -1), 49);
  // 数值除 isFinite 外再做语义钳制：负时长/负进度/超大音量会让 controller
  // 的 :max 绑定与滑块渲染异常
  const clampNonNeg = (v) => {
    const n = clampNum(v);
    return n === undefined ? undefined : Math.max(0, n);
  };
  const volume = clampNonNeg(payload.volume);
  return {
    isPlaying: payload.isPlaying === true,
    currentSong,
    currentTime: clampNonNeg(payload.currentTime) ?? 0,
    duration: clampNonNeg(payload.duration) ?? 0,
    volume: volume === undefined ? 0 : Math.min(volume, 100),
    queue,
    queueIndex
  };
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

// 每连接滑动窗口限流：返回 false 表示超限（调用方掐断连接）。
// 1s 窗口内的宽松阈值足以覆盖音量逐帧推送，又挡住泛洪脚本
function allowMessage(ws, perSec) {
  const now = Date.now();
  if (now - (ws.msgWindowStart || 0) >= 1000) {
    ws.msgWindowStart = now;
    ws.msgWindowCount = 0;
  }
  return ++ws.msgWindowCount <= perSec;
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
 * 从 Sec-WebSocket-Protocol 头提取 remote.<token> 凭据：
 * ?token= 走 URL 会落进反代/浏览器历史日志，子协议头则不会——
 * 客户端优先用子协议通道，URL 参数仅为兼容保留
 */
function tokenFromProtocols(req) {
  const header = req.headers['sec-websocket-protocol'] || '';
  const proto = header.split(',').map(s => s.trim())
    .find(s => s.startsWith('remote.'));
  return proto ? proto.slice('remote.'.length) : null;
}

/**
 * Attach WebSocket remote control to an existing HTTP server.
 * @param {import('http').Server} server
 * @param {{ allowedOrigins?: string[], token?: string }} options
 *   allowedOrigins: Origin 白名单（浏览器跨站劫持防护；非浏览器客户端无 Origin 头则放行）
 *   token: 设置后客户端必须通过 ?token= 或 Sec-WebSocket-Protocol: remote.<token> 提供相同令牌
 */
function attachRemoteControl(server, options = {}) {
  const { allowedOrigins = [], token = '' } = options;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD_BYTES,
    // 音频遥控消息小且低频，PMD 的 zlib 上下文是纯粹的 CPU 放大面
    perMessageDeflate: false,
    // 回显 remote.<token> 子协议完成握手；不匹配则不协商（等效不带）
    handleProtocols: (protocols) => {
      if (!token) return false;
      for (const p of protocols) {
        if (p.startsWith('remote.') && tokenMatches(p.slice(7), token)) return p;
      }
      return false;
    }
  });

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

    // 可选 token 鉴权：子协议优先（不落 URL 日志），?token= 兼容旧客户端。
    // 先于容量检查——未认证客户端不应能经 401/503 差异探测连接数状态
    // （REMOTE_TOKEN 未设置时保持开放，兼容局域网自用——公网部署务必配置，
    // 入口有启动 warning）
    const provided = tokenFromProtocols(req) ?? url.searchParams.get('token');
    if (token && !tokenMatches(provided, token)) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }

    // controller 容量上限在升级阶段拒——handleUpgrade 后再踢仍会完成握手，
    // 观感是"连上即断"，提前拒语义更准确。注意判定必须与 connection 阶段
    // 一致：非 'host' 一律计入 controller 容量（role=x 不得绕过上限）
    if (url.searchParams.get('role') !== 'host'
      && controllers.size >= MAX_CONTROLLERS) {
      rejectUpgrade(socket, 503, 'Service Unavailable');
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
      // Only one host allowed at a time。判活用 !== CLOSED 而非 === OPEN：
      // 老 host 正处 CLOSING 时跳过顶替逻辑会让它按时序"正常关闭→触发重连"
      // 把新 host 反踢，形成踢皮球循环
      if (hostSocket && hostSocket !== ws && hostSocket.readyState !== hostSocket.CLOSED) {
        hostSocket.close(4000, 'replaced by new host');
      }
      hostSocket = ws;
      console.log('[remote] host connected');
      // controllers 需要知道 host 就位（区别于从未有过 host 的空态）
      broadcastToControllers({ type: 'host_joined' });
      // 新 host 可能刚接管：主动要一次状态，controller 立即拿到当前曲目
      send(ws, { type: 'request_state' });

      send(ws, { type: 'info', payload: { controllers: controllers.size } });

      ws.on('message', (data) => {
        if (!allowMessage(ws, HOST_MSG_PER_SEC)) {
          ws.close(1008, 'rate limited');
          return;
        }
        const msg = parseMessage(data);
        // host sends state_update → forward to all controllers。
        // payload 经服务端白名单序列化——host 不可信，畸形对象会崩掉
        // 所有 controller 的渲染（artistName computed 对 song.ar 无守卫）
        if (msg && msg.type === 'state_update') {
          const payload = sanitizeStatePayload(msg.payload);
          if (payload) {
            broadcastToControllers({ type: 'state_update', payload });
          }
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

      // If host is connected, ask it to send current state；无 host 时明示空态
      // （controller UI 靠 host_disconnected/host_absent 区分"断了"与"从未有过"）
      if (hostSocket && hostSocket.readyState === hostSocket.OPEN) {
        send(hostSocket, { type: 'request_state' });
      } else {
        send(ws, { type: 'host_absent' });
      }

      ws.on('message', (data) => {
        if (!allowMessage(ws, CONTROLLER_MSG_PER_SEC)) {
          ws.close(1008, 'rate limited');
          return;
        }
        const msg = parseMessage(data);
        // Forward control commands to host（type+payload 双层白名单形状）
        if (msg && CONTROL_TYPES.has(msg.type)
          && CONTROL_PAYLOAD_GUARDS[msg.type]?.(msg.payload)
          && hostSocket && hostSocket.readyState === hostSocket.OPEN) {
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

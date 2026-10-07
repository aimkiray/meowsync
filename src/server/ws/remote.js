const { tokenMatches } = require('../lib/token-eq');
const { trustProxyEnabled, clientIpFromHeaders } = require('../lib/env');
const { rateLimitForIp } = require('../lib/rate-limit');
const { WebSocketServer } = require('ws');
// 控制面契约与共享表对齐（src/shared/protocol.js）——controller/host 三端同源
const { CONTROL_TYPES, CONTROL_PAYLOAD_GUARDS, REMOTE_LIMITS, MSG_TYPES } = require('../../shared/protocol.js');
// 登录会话优先于 REMOTE_TOKEN——浏览器 WS 握手带 cookie，遥控器页面登录后零改造
const { sessionFromCookieHeader, sessionTokenFromCookie, authEnabled } = require('../lib/auth-gate');
// tokenId 用于把会话身份钉到 ws 上——logout/全量吊销要按它收掉已建连接
const sessionsRepo = require('../repositories/sessions');

const HEARTBEAT_INTERVAL_MS = 30000;
const MAX_PAYLOAD_BYTES = REMOTE_LIMITS.MAX_PAYLOAD_BYTES;
const MAX_CONTROLLERS = REMOTE_LIMITS.MAX_CONTROLLERS;
// 状态帧（host→server→controllers 广播）与控制帧（controller→server）
// 分开封顶：广播帧限定出向扇出体积，控制帧合法载荷 ≤ ~200B 用 1KB 小顶
const MAX_STATE_BYTES = REMOTE_LIMITS.MAX_STATE_PAYLOAD_BYTES;
const MAX_CONTROL_BYTES = REMOTE_LIMITS.MAX_CONTROL_PAYLOAD_BYTES;
// 广播背压：单个 controller 的 socket 发送缓冲超 1MB 说明对端消费跟不上
// （弱网/挂起标签页）。state_update 是全量快照——跳帧安全，靠下次快照追平
const SLOW_CONSUMER_BYTES = 1024 * 1024;
// 连续超限帧数阈值：瞬态卡顿（GC/突发大快照）不误杀，持续积压才掐断
const SLOW_CONSUMER_FRAMES = 3;
// 未认证 WS 升级的滑动窗限流（/min/IP）——握手成本（DB 会话查询/写密钥交换）
// 不该被探测脚本无限白嫖
const UPGRADE_LIMIT_PER_MIN = 20;
// 每连接消息限流：controller 只在点按时发消息；host 峰值在音量拖动——
// watch 逐帧推 state_update，高刷屏下可达 ~144/s，host 桶取 200 留足余量
const HOST_MSG_PER_SEC = 200;
const CONTROLLER_MSG_PER_SEC = 30;
// 全量 upgrade 的宽松 per-IP 限流（/min）：不只计鉴权失败——合法页面加载+
// 断线重连的量级 <10/min，60 足以挡住「鉴权通过但狂连」的连接风暴。
// 桶键带 attach 序号：同进程多次 attach（测试场景）各自独立计数
const UPGRADE_ALL_LIMIT_PER_MIN = 60;
let attachSeq = 0;

let hostSocket = null;
const controllers = new Set();
// 最近一份消毒后的 state_update 快照：新 controller 入会优先回它，
// 不为每人再打扰 host 要 REQUEST_STATE（上行 200msg/s 面下每新客一次
// 请求都是放大点）。产出它的 host 断线即清——陈快照会让新客看到僵尸状态
let lastState = null;
let lastStateFrom = null;

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) {
    // 单个客户端 send 抛错（如 socket 正处于 CLOSING）不应中断广播循环、
    // 更不应冒泡成 uncaughtException 打挂进程
    try {
      ws.send(JSON.stringify(msg));
    } catch { /* 该客户端的失败由 close/error 事件接管清理 */ }
  }
}

function broadcastStr(str) {
  for (const ctrl of controllers) {
    if (ctrl.readyState !== ctrl.OPEN) continue;
    // 背压：缓冲超限就跳帧（state_update 快照可丢，下帧自然追平）；
    // 连续 SLOW_CONSUMER_FRAMES 帧都超限才 close——瞬态毛刺不误踢
    if (ctrl.bufferedAmount > SLOW_CONSUMER_BYTES) {
      ctrl.overBudgetFrames = (ctrl.overBudgetFrames || 0) + 1;
      if (ctrl.overBudgetFrames >= SLOW_CONSUMER_FRAMES) {
        ctrl.overBudgetFrames = 0;
        ctrl.close(1013, 'slow consumer');
      }
      continue;
    }
    ctrl.overBudgetFrames = 0;
    try {
      ctrl.send(str);
    } catch { /* 该客户端的失败由 close/error 事件接管清理 */ }
  }
}

function broadcastToControllers(msg) {
  // 一次序列化全员复用——原先每连接各 JSON.stringify 一遍纯属浪费
  broadcastStr(JSON.stringify(msg));
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
  // picUrl 收 http(s) 或本服务工件的相对路径（'/' 开头非 '//'——file_ 封面
  // 以 apiBase 相对形态上线，controller 用自身基址拼回；'//' 协议相对形态
  // 等于任意外链，与 javascript:/data: 之类异 scheme 同拒）
  const picRaw = clampStr(song.al?.picUrl, 500);
  const picUrl = picRaw && (/^https?:/i.test(picRaw)
    || (picRaw.startsWith('/') && !picRaw.startsWith('//'))) ? picRaw : '';
  return {
    // id 截断与 CONTROL_PAYLOAD_GUARDS.play_song 的 128 上限同值——队列点歌
    // 回送的 id 若被截短成 64，host 侧 findIndex 会失配静默拒播
    id: clampNum(song.id) ?? clampStr(song.id, 128) ?? null,
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
 * @param {{ allowedOrigins?: string[], token?: string, basePath?: string }} options
 *   allowedOrigins: Origin 白名单（浏览器跨站劫持防护；非浏览器客户端无 Origin 头则放行）
 *   token: 设置后客户端必须通过 ?token= 或 Sec-WebSocket-Protocol: remote.<token> 提供相同令牌
 *   basePath: 部署子路径（归一化 '/x' 形式，'/' 为根）——WS 端点随之为 ${basePath}/remote
 */
function attachRemoteControl(server, options = {}) {
  const { allowedOrigins = [], token = '', basePath = '/' } = options;
  // 与 serve() 入口的 BASE_PATH 剥前缀同口径：WS upgrade 不走 fetch 管道，
  // 握手路径在这里单独对齐（base '/' → '/remote'；'/music' → '/music/remote'）
  const remotePath = (basePath === '/' ? '' : basePath) + '/remote';
  const upgradeBucketKey = `remote-upgrade-all#${++attachSeq}`;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD_BYTES,
    // 音频遥控消息小且低频，PMD 的 zlib 上下文是纯粹的 CPU 放大面
    perMessageDeflate: false,
    // 回显客户端自报的 remote.* 子协议完成协商——鉴权在 onUpgrade 的
    // session|token 级联里已完成，这里不匹配 token：浏览器要求服务端
    // 从 offered 列表回选一个，回 false 会因协商失败主动断连（会话已
    // 认证但 VITE_REMOTE_TOKEN 陈旧/不一致的场景会莫名连不上）
    handleProtocols: (protocols) => {
      for (const p of protocols) {
        if (p.startsWith('remote.')) return p;
      }
      return false;
    }
  });

  const onUpgrade = (req, socket, head) => {
    // 握手完成前 socket 出错也要兜底销毁，避免未处理的 'error' 事件抛出；
    // 具名以便升级成功后摘除——ws 接管 socket 后留着它会把传输期普通
    // error 再翻译成 destroy() 误杀已建连接
    const onPreUpgradeError = () => socket.destroy();
    socket.once('error', onPreUpgradeError);

    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }

    // 精确匹配 remotePath，避免 /remotexxx 误命中
    if (url.pathname !== remotePath) {
      socket.destroy();
      return;
    }

    // 全量 upgrade 的宽松限流先于 Origin/鉴权——计数不看成败：未认证洪泛
    // 另有 'remote-upgrade' 20/min 收紧桶兜底，这里 60/min 管的是「鉴权能过
    // 但狂连」（撞库成功的会话/合法 token 脚本）的连接风暴面
    const upgradeIp = clientIpFromHeaders(req.headers, req.socket?.remoteAddress);
    if (!rateLimitForIp(upgradeBucketKey, upgradeIp, UPGRADE_ALL_LIMIT_PER_MIN)) {
      rejectUpgrade(socket, 429, 'Too Many Requests');
      return;
    }

    // Origin 校验：浏览器发起 WS 必带 Origin 头，可拦跨站劫持；
    // 非浏览器客户端无 Origin 头则放行。
    // Host 头浏览器不可伪造（即实际拨号目标）；但 TRUST_PROXY 场景下反代
    // 可能把 Host 重写为内部地址，此时同源比较应基于 X-Forwarded-Host
    // （浏览器无法设置该头，仅代理想写入，采信是安全的）
    const origin = req.headers.origin;
    const trustProxy = trustProxyEnabled();
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

    // 'upgrade' 事件监听器抛错直达 uncaughtException 杀进程——鉴权级联
    // （session 解析走 DB）起所有异常必须就地收敛成 HTTP 拒绝
    // 会话身份钉件（仅 cookie 会话；REMOTE_TOKEN 旁路无会话可钉）：
    // logout/deleteAllForUser 吊销会话时按它收掉已建连接——WS 不吃
    // HTTP 401 语义，不主动收会一直挂着死会话收发控制面消息
    let wsSession = null;
    try {
      // 鉴权级联：session cookie（浏览器登录态，同源握手天然携带）→
      // REMOTE_TOKEN 子协议/?token=（非浏览器客户端旁路，不落 URL 日志优先）。
      // 先于容量检查——未认证客户端不应能经 401/503 差异探测连接数状态。
      // 两者皆未配置时保持开放（局域网自用兼容；公网部署必须启用登录或配 token）
      const sess = sessionFromCookieHeader(req.headers.cookie || '');
      if (sess) {
        wsSession = {
          userId: sess.userId,
          tokenId: sessionsRepo.tokenId(sessionTokenFromCookie(req.headers.cookie || ''))
        };
      }
      if (!sess) {
        const provided = tokenFromProtocols(req) ?? url.searchParams.get('token');
        // 启用登录后 REMOTE_TOKEN 未配也必须拒——否则「登录开着、WS 裸奔」
        // 形成旁路洞（旧逻辑只在 token 非空时才校验）
        if (token ? !tokenMatches(provided, token) : authEnabled()) {
          // 未认证升级的滑动窗限流：与 HTTP 侧同一 TRUST_PROXY 取 IP 实现 +
          // 同一桶表核心——伪造 XFF 在这里同样无效
          const ip = clientIpFromHeaders(req.headers, req.socket?.remoteAddress);
          if (!rateLimitForIp('remote-upgrade', ip, UPGRADE_LIMIT_PER_MIN)) {
            rejectUpgrade(socket, 429, 'Too Many Requests');
            return;
          }
          rejectUpgrade(socket, 401, 'Unauthorized');
          return;
        }
      }

      // controller 容量上限在升级阶段拒——handleUpgrade 后再踢仍会完成握手，
      // 观感是"连上即断"，提前拒语义更准确。注意判定必须与 connection 阶段
      // 一致：非 'host' 一律计入 controller 容量（role=x 不得绕过上限）
      if (url.searchParams.get('role') !== 'host'
        && controllers.size >= MAX_CONTROLLERS) {
        rejectUpgrade(socket, 503, 'Service Unavailable');
        return;
      }
    } catch (err) {
      console.error('[remote] upgrade 鉴权阶段异常:', err?.message || err);
      try {
        rejectUpgrade(socket, 500, 'Internal Server Error');
      } catch { socket.destroy(); }
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      // 握手完成——握手前的 error 兜底摘除，之后由 ws 自身的 error/close 接管
      socket.removeListener('error', onPreUpgradeError);
      if (wsSession) {
        ws.sessionUserId = wsSession.userId;
        ws.sessionTokenId = wsSession.tokenId;
      }
      // 握手完成后连接回调的异常无法再回 HTTP 拒绝——就地 terminate
      try {
        wss.emit('connection', ws, req, url);
      } catch (err) {
        console.error('[remote] connection 处理异常:', err?.message || err);
        try { ws.terminate(); } catch { /* 已在关闭中 */ }
      }
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
      // Only one host allowed at a time——任何鉴权者带 ?role=host 都可顶替
      // 现 host（「第二个窗口夺权」是有意保留的 UX，不加 force 闸——闸了
      // 合法第二窗口也接管不了）。被踢端客户端侧自愈：降级成 controller
      // 观望连接，host 位空出后自动回接管——抢占粘性消解于双方都活着。
      // 判活用 !== CLOSED 而非 === OPEN：
      // 老 host 正处 CLOSING 时跳过顶替逻辑会让它按时序"正常关闭→触发重连"
      // 把新 host 反踢，形成踢皮球循环
      if (hostSocket && hostSocket !== ws && hostSocket.readyState !== hostSocket.CLOSED) {
        hostSocket.close(4000, 'replaced by new host');
        // 优雅 close 依赖对端配合：旧 host 若不按约定断开（恶意/卡死客户端），
        // 连接会堆在 CLOSING 态绕过 controller 上限——5s 兜底强拆
        const stale = hostSocket;
        setTimeout(() => {
          if (stale.readyState !== stale.CLOSED) {
            try { stale.terminate(); } catch { /* 已断 */ }
          }
        }, 5000).unref();
      }
      hostSocket = ws;
      console.log('[remote] host connected');
      // controllers 需要知道 host 就位（区别于从未有过 host 的空态）
      broadcastToControllers({ type: MSG_TYPES.HOST_JOINED });
      // 新 host 可能刚接管：主动要一次状态，controller 立即拿到当前曲目
      send(ws, { type: MSG_TYPES.REQUEST_STATE });

      ws.on('message', (data) => {
        if (!allowMessage(ws, HOST_MSG_PER_SEC)) {
          ws.close(1008, 'rate limited');
          return;
        }
        const msg = parseMessage(data);
        // host sends state_update → forward to all controllers。
        // payload 经服务端白名单序列化——host 不可信，畸形对象会崩掉
        // 所有 controller 的渲染（artistName computed 对 song.ar 无守卫）
        if (msg && msg.type === MSG_TYPES.STATE_UPDATE) {
          const payload = sanitizeStatePayload(msg.payload);
          if (!payload) return;
          // 广播帧封顶（与 host 发送侧共用 REMOTE_LIMITS 同值）：扇出代价
          // = 帧字节 × controller 数。queue 是唯一弹性字段——超帧砍尾重算
          // （queueIndex 越界归 -1，错位点亮比空槽更糟）；砍空仍超说明
          // currentSong 单体超限，整帧丢。裁剪而非拒帧：未截断的旧 host
          // 客户端照样有画面，不至于全量丢帧静默断更
          let str = JSON.stringify({ type: MSG_TYPES.STATE_UPDATE, payload });
          // 封顶按线上字节量（str.length 把中文按 1 计——UTF-8 实际占 3B，
          // CJK 歌名队列会钻出 ~3x 上限）
          while (Buffer.byteLength(str) > MAX_STATE_BYTES && payload.queue?.length) {
            payload.queue = payload.queue.slice(0, Math.ceil(payload.queue.length / 2));
            if (payload.queueIndex >= payload.queue.length) payload.queueIndex = -1;
            str = JSON.stringify({ type: MSG_TYPES.STATE_UPDATE, payload });
          }
          if (Buffer.byteLength(str) > MAX_STATE_BYTES) return;
          lastState = payload;
          lastStateFrom = ws;
          broadcastStr(str);
        }
      });

      ws.on('close', () => {
        // 仅当关闭的是当前 host 时才通知（被顶替的旧 host 不触发广播）
        if (hostSocket === ws) {
          hostSocket = null;
          console.log('[remote] host disconnected');
          broadcastToControllers({ type: MSG_TYPES.HOST_DISCONNECTED });
        }
        // 快照归属按产出者清（被顶替时也清——顶替后的新 host 会随即供新帧）
        if (lastStateFrom === ws) {
          lastState = null;
          lastStateFrom = null;
        }
      });

    } else {
      // controller
      controllers.add(ws);
      console.log(`[remote] controller connected (total: ${controllers.size})`);

      // 优先回服务端缓存的最近消毒快照——host 2s 一拍+变更即推，缓存时效
      // 足够，不必为每位新客打扰 host 要 REQUEST_STATE（上行放大面）；
      // 无快照且 host 在位才回源要一次；无 host 时明示空态
      // （controller UI 靠 host_disconnected/host_absent 区分"断了"与"从未有过"）
      if (lastState) {
        send(ws, { type: MSG_TYPES.STATE_UPDATE, payload: lastState });
      } else if (hostSocket && hostSocket.readyState === hostSocket.OPEN) {
        send(hostSocket, { type: MSG_TYPES.REQUEST_STATE });
      } else {
        send(ws, { type: MSG_TYPES.HOST_ABSENT });
      }

      ws.on('message', (data) => {
        if (!allowMessage(ws, CONTROLLER_MSG_PER_SEC)) {
          ws.close(1008, 'rate limited');
          return;
        }
        // 控制帧小顶：合法指令 ≤ ~200B——超限帧在解析前丢（大载荷丢进
        // 白名单校验只会白费 JSON.parse），与畸形消息同口径不炸连
        if (data.length > MAX_CONTROL_BYTES) return;
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
        console.log(`[remote] controller disconnected (total: ${controllers.size})`);
      });
    }
  });

  console.log(`[remote] WebSocket remote control ready at ws://...${remotePath}`);

  // 停机流程须在 server.close() 后调用 close() 主动 terminate WS 客户端，
  // 否则升级 socket 卡住 _connections，'close' 事件不触发
  return { close: cleanup };
}

/**
 * 会话吊销钩子：按握手时钉在 ws 上的会话身份收掉关联连接。
 *   logout → revokeConnections({ tokenId })（只收该会话）
 *   deleteAllForUser → revokeConnections({ userId })（该用户全部端）
 * close(1008) 而非 terminate：对端走正常 close→重连，握手自然撞 401 收束；
 * 仍赖着的半截连接交给心跳 isAlive 兜底 terminate
 */
function revokeConnections({ userId, tokenId } = {}) {
  const all = hostSocket ? [hostSocket, ...controllers] : [...controllers];
  for (const ws of all) {
    if ((tokenId && ws.sessionTokenId === tokenId)
      || (userId != null && ws.sessionUserId === userId)) {
      try { ws.close(1008, 'session revoked'); } catch { /* 已在关闭中 */ }
    }
  }
}

module.exports = { attachRemoteControl, revokeConnections };

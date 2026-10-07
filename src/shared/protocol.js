// ─────────────────────────────────────────────────────────────────────────
// WS 遥控协议契约（前后端唯一真相源）
//
// 三端（host=App.vue 宿主侧 / controller=RemoteController.vue / 服务端中继
// ws/remote.js）靠同一组常量与守卫对齐——此前三处各写一份靠注释同步。
// 纯 ESM 零 IO；守卫是纯形状谓词，前端引入也无害（服务端仍是执行边界）。
// ─────────────────────────────────────────────────────────────────────────

// controller→host 指令类型白名单
export const CONTROL_TYPES = new Set(['play', 'pause', 'next', 'prev', 'seek', 'volume', 'play_song']);

// controller→host 的 payload 形状校验：type 白名单之外再核形状，畸形直接丢
// （host 端的 seek/volume 数值校验是最终防线，但先把垃圾挡在转发路径上）
export const CONTROL_PAYLOAD_GUARDS = {
  play: (p) => p === undefined || p === null,
  pause: (p) => p === undefined || p === null,
  next: (p) => p === undefined || p === null,
  prev: (p) => p === undefined || p === null,
  seek: (p) => typeof p === 'number' && Number.isFinite(p),
  volume: (p) => typeof p === 'number' && Number.isFinite(p),
  play_song: (p) => (typeof p === 'string' && p.length <= 128)
    || (typeof p === 'number' && Number.isSafeInteger(p)),
};

// 线协议消息形态（remote.js 实现为准）：
//   controller→server: {type: <CONTROL_TYPES 其一>, payload} —— 双层白名单校验
//   server→host:       {type: <控制指令原样转发>} | {type:'request_state'}
//   （'info' 消息型常量保留于下方 MSG_TYPES，服务端已停发——无消费端）
//   host→server:       {type:'state_update', payload} —— 经 sanitizeStatePayload 白名单投影
//   （payload.currentSong.al.picUrl 只放行 http(s) 或 '/'+非'//' 开头的本服务
//   相对路径——file_ 封面以 apiBase 相对形态上线，controller 端自行拼回）
//   server→controller: {type:'state_update', payload} | 'host_joined' | 'host_disconnected' | 'host_absent'
export const MSG_TYPES = {
  STATE_UPDATE: 'state_update',
  INFO: 'info',
  REQUEST_STATE: 'request_state',
  HOST_JOINED: 'host_joined',
  HOST_DISCONNECTED: 'host_disconnected',
  HOST_ABSENT: 'host_absent',
};

// 连线约束（服务端执行，前端仅作展示一致性参考）
export const REMOTE_LIMITS = {
  // 单帧硬顶（ws maxPayload）：一切入向帧的兜底上限
  MAX_PAYLOAD_BYTES: 64 * 1024,
  MAX_CONTROLLERS: 32,
  // 状态帧专用上限：广播帧（state_update）扇出代价 = 字节 × controller 数，
  // 8KB 卡住「200msg/s × 64KB × 32」的放大面。发送侧（host）与广播侧
  // （服务端消毒后裁剪 queue 尾）共用同值
  MAX_STATE_PAYLOAD_BYTES: 8 * 1024,
  // 控制帧专用上限（controller→server 入向原始帧）：合法指令 ≤ ~200B，
  // 1KB 足够宽松；超限帧直接丢（不浪费解析成本，也不误杀连接）
  MAX_CONTROL_PAYLOAD_BYTES: 1024,
};

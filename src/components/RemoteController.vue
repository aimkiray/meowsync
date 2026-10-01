<template>
  <div class="remote-controller">
    <div v-if="!connected || hostDisconnected" class="rc-connecting">
      <div v-if="!gaveUp" class="rc-spinner pixel-loading pixel-loading--on-ink"></div>
      <p>{{ gaveUp ? '无法连接主机' : (hostDisconnected ? '主机已断开，等待重连...' : '正在连接主机...') }}</p>
      <button v-if="gaveUp" class="rc-btn rc-retry" @click="retry">重新连接</button>
    </div>

    <template v-else>
      <!-- 封面 + 歌曲信息 -->
      <div class="rc-cover-wrap">
        <img
          v-if="state.currentSong?.al?.picUrl || state.currentSong?.album?.picUrl"
          :src="httpsCover(state.currentSong?.al?.picUrl || state.currentSong?.album?.picUrl)"
          :alt="state.currentSong?.name || '专辑封面'"
          class="rc-cover"
          :class="{ 'playing-animation': state.isPlaying }"
        />
        <div v-else class="rc-cover rc-cover-placeholder"><PixelIcon name="note" :size="56" /></div>
      </div>

      <div class="rc-song-info">
        <div class="rc-song-name">{{ state.currentSong?.name || '未在播放' }}</div>
        <div class="rc-artist">{{ artistName }}</div>
      </div>

      <!-- 进度条 -->
      <div class="rc-progress-wrap">
        <span class="rc-time">{{ formatTime(state.currentTime) }}</span>
        <input
          type="range"
          class="rc-slider pg-range pg-range--on-ink"
          aria-label="播放进度"
          :value="state.currentTime"
          :max="state.duration || 1"
          step="1"
          @input="onSeekInput"
          @change="onSeek"
          @pointerdown="onSeekPointerDown"
          @pointerup="onDragPointerEnd"
          @pointercancel="onDragPointerEnd"
          @lostpointercapture="onDragPointerEnd"
        />
        <span class="rc-time">{{ formatTime(state.duration) }}</span>
      </div>

      <!-- 控制按钮 -->
      <div class="rc-controls">
        <button class="rc-btn" @click="send('prev')" title="上一首" aria-label="上一首"><PixelIcon name="prev" :size="20" /></button>
        <button class="rc-btn rc-btn-main" @click="send(state.isPlaying ? 'pause' : 'play')" :title="state.isPlaying ? '暂停' : '播放'" :aria-label="state.isPlaying ? '暂停' : '播放'">
          <PixelIcon :name="state.isPlaying ? 'pause' : 'play'" :size="state.isPlaying ? 30 : 35" />
        </button>
        <button class="rc-btn" @click="send('next')" title="下一首" aria-label="下一首"><PixelIcon name="next" :size="20" /></button>
      </div>

      <!-- 音量 -->
      <div class="rc-volume-wrap">
        <span class="rc-vol-icon"><PixelIcon name="vol-low" :size="16" /></span>
        <input
          type="range"
          class="rc-slider pg-range pg-range--on-ink"
          aria-label="音量"
          :value="state.volume"
          min="0"
          max="100"
          step="1"
          @input="onVolumeInput"
          @change="onVolume"
          @pointerdown="onVolumePointerDown"
          @pointerup="onDragPointerEnd"
          @pointercancel="onDragPointerEnd"
          @lostpointercapture="onDragPointerEnd"
        />
        <span class="rc-vol-icon"><PixelIcon name="vol" :size="16" /></span>
      </div>

      <!-- 待播队列：host 广播的播放快照，点选跳转 -->
      <div v-if="queueItems.length" class="rc-queue">
        <div class="rc-queue-title">待播队列</div>
        <div class="rc-queue-list">
          <button
            v-for="(s, i) in queueItems"
            :key="`${s.id}-${i}`"
            class="rc-queue-row"
            :class="{ 'rc-queue-row--current': i === state.queueIndex }"
            @click="send('play_song', s.id)"
          >
            <span class="rc-queue-idx"><PixelIcon v-if="i === state.queueIndex" name="play" :size="16" /><template v-else>{{ i + 1 }}</template></span>
            <span class="rc-queue-name">{{ s.name }}</span>
            <span class="rc-queue-artist">{{ queueArtist(s) }}</span>
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { formatTime } from '../lib/format'
import { httpsCover } from '../lib/url'
// WS 消息类型与 shared/protocol.js 同源——字面量漂移会被服务端拒收
import { MSG_TYPES } from '../shared/protocol.js'
import PixelIcon from './PixelIcon.vue'

const props = defineProps({
  // 完整 WS URL，须已包含 ?role=controller（由 App.vue 构建）
  wsUrl: { type: String, required: true },
  // token 经 Sec-WebSocket-Protocol 携带（不落 URL 日志）；空/undefined 即无凭据
  wsProtocols: { type: Array, default: undefined }
})

const connected = ref(false)
const hostDisconnected = ref(false)
// 重连超限后给出可读的终态提示，而不是永远停在“正在连接”
const gaveUp = ref(false)
// 拖动滑块期间屏蔽本地推进/远端推送回写，防止 thumb 被拽回旧值
const seekDragging = ref(false)
const volumeDragging = ref(false)
// 记录发起拖动的 pointerId：window 级 pointerup/pointercancel 只在同一指针时
// 释放标志位，避免双指分别拖进度/音量两个滑块时互相误清
let seekPointerId = null
let volumePointerId = null
const state = ref({
  isPlaying: false,
  currentSong: null,
  currentTime: 0,
  duration: 0,
  volume: 80,
  queue: [],
  queueIndex: -1
})

// 队列渲染：白名单已保证数组形状，这里只需对元素个体防御
const queueItems = computed(() =>
  Array.isArray(state.value.queue) ? state.value.queue.filter(s => s && s.id != null) : []
)

const queueArtist = (s) => {
  const list = s?.ar || s?.artists
  if (!Array.isArray(list)) return ''
  return list.map(a => a?.name ?? '').filter(Boolean).join(' / ')
}

let ws = null
let reconnectTimer = null
let progressTickTimer = null
let destroyed = false
let retries = 0

function connect() {
  if (destroyed) return
  ws = new WebSocket(props.wsUrl, props.wsProtocols)

  ws.onopen = () => {
    retries = 0
    connected.value = true
    hostDisconnected.value = false
    gaveUp.value = false // 防御性复位：未来若出现重连路径可自动恢复
  }

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data)
      if (msg.type === MSG_TYPES.STATE_UPDATE) {
        hostDisconnected.value = false
        const payload = msg.payload || {}
        // 拖动中不回写对应字段，避免 thumb 被远端旧值拽回
        if (seekDragging.value) delete payload.currentTime
        if (volumeDragging.value) delete payload.volume
        // sanitize 后 queue 可能整个键缺席（非数组被丢）——不补默认值会留着旧队列
        if (!Array.isArray(payload.queue)) payload.queue = []
        state.value = { ...state.value, ...payload }
      } else if (msg.type === MSG_TYPES.HOST_DISCONNECTED || msg.type === MSG_TYPES.HOST_ABSENT) {
        // 断开与"从未有 host"共用空态 UI
        hostDisconnected.value = true
        // v-if 会摘除滑块元素，悬挂的拖动标志（pointerup 可能不再派发）必须复位
        resetDragState()
      } else if (msg.type === MSG_TYPES.HOST_JOINED) {
        // host 就位（含顶替旧 host 后新主接管）：等它的 state_update，先摘掉空态遮罩
        hostDisconnected.value = false
      }
    } catch {}
  }

  ws.onclose = () => {
    connected.value = false
    ws = null
    resetDragState() // 同上：滑块随 connected=false 被摘除，不能留下悬挂标志
    if (destroyed) return
    // 重连上限：握手被 401/403 拒绝时避免无限重试
    if (++retries > 5) {
      console.warn('[remote] controller 重连次数超限，停止重连')
      gaveUp.value = true
      return
    }
    reconnectTimer = setTimeout(connect, 3000)
  }

  // 用闭包局部 sock 而非共享 ws——与未来多 socket 场景对齐 App.vue 的纪律
  const sock = ws
  ws.onerror = () => {
    sock.close()
  }
}

// 重连超限后的手动重试：复位计数重新走 connect
function retry() {
  retries = 0
  gaveUp.value = false
  connect()
}

function send(type, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, payload }))
  }
}

function onSeekPointerDown(e) {
  seekPointerId = e.pointerId
  seekDragging.value = true
}

function onVolumePointerDown(e) {
  volumePointerId = e.pointerId
  volumeDragging.value = true
}

// pointerup/pointercancel/lostpointercapture 共用释放逻辑（按 pointerId 匹配）。
// 同时挂到 window 兜底：鼠标没有隐式捕获，在滑块外松开时 pointerup 不会派发到
// 滑块元素上；此时若值恰好未变，@change 也不会触发，元素级监听不足以复位标志
function onDragPointerEnd(e) {
  if (e.pointerId === seekPointerId) {
    seekPointerId = null
    seekDragging.value = false
  }
  if (e.pointerId === volumePointerId) {
    volumePointerId = null
    volumeDragging.value = false
  }
}

function resetDragState() {
  seekPointerId = null
  volumePointerId = null
  seekDragging.value = false
  volumeDragging.value = false
}

// 拖动中仅本地预览（不发包），松手 @change 时一次性提交并发送
function onSeekInput(e) {
  state.value.currentTime = Number(e.target.value)
}

function onSeek(e) {
  seekPointerId = null
  seekDragging.value = false
  const t = Number(e.target.value)
  // 本地立即提交：host 每 2s 才推送一次，不回写会闪回旧进度
  state.value.currentTime = t
  send('seek', t)
}

function onVolumeInput(e) {
  state.value.volume = Number(e.target.value)
}

function onVolume(e) {
  volumePointerId = null
  volumeDragging.value = false
  const v = Number(e.target.value)
  state.value.volume = v
  send('volume', v)
}

const artistName = computed(() => {
  const song = state.value.currentSong
  if (!song) return ''
  // host 上游不可信：服务端虽已白名单序列化，渲染端仍守卫类型
  const list = song.ar || song.artists
  if (!Array.isArray(list)) return ''
  return list.map(a => a?.name ?? '').filter(Boolean).join(' / ')
})

onMounted(() => {
  connect()
  // host 每 2s 才推送一次进度；期间本地按秒推进让进度条平滑，下一次推送会校准漂移
  progressTickTimer = setInterval(() => {
    const s = state.value
    if (s.isPlaying && !seekDragging.value && s.duration > 0 && s.currentTime < s.duration) {
      s.currentTime = Math.min(s.currentTime + 1, s.duration)
    }
  }, 1000)
  window.addEventListener('pointerup', onDragPointerEnd)
  window.addEventListener('pointercancel', onDragPointerEnd)
  // 指针在窗口外松开时 pointerup/cancel 都不派发——blur/隐藏兜底清拖动标志
  window.addEventListener('blur', resetDragState)
  document.addEventListener('visibilitychange', resetDragState)
})
onUnmounted(() => {
  destroyed = true
  clearTimeout(reconnectTimer)
  clearInterval(progressTickTimer)
  window.removeEventListener('pointerup', onDragPointerEnd)
  window.removeEventListener('pointercancel', onDragPointerEnd)
  window.removeEventListener('blur', resetDragState)
  document.removeEventListener('visibilitychange', resetDragState)
  if (ws) {
    ws.onclose = null // 阻止卸载后异步 close 触发重连
    ws.close()
    ws = null
  }
})
</script>

<style scoped>
/* 墨条遥控面板：整版 --ink 墨面 + --paper 纸字，发丝用 --white-16/--white-40 */
.remote-controller {
  /* 遥控页恒暗面——就地 pin 住消费的令牌，不随应用 data-theme 翻转 */
  --ink: #1e1e1e;
  --paper: #fefefe;
  --label-grey: #dedede;
  --white-16: rgba(255, 255, 255, .16);
  --white-40: rgba(255, 255, 255, .40);
  --white-80: rgba(255, 255, 255, .8);
  /* 全局 scrollbar 走 --ink-30/64——暗面上 pin 成白 alpha，防未来滚动容器继承暗上暗柄 */
  --ink-30: rgba(255, 255, 255, .30);
  --ink-64: rgba(255, 255, 255, .64);
  --accent-magenta: #fc8eac;
  --accent-magenta-on-ink: var(--accent-magenta);
  /* 字体也 pin——glitch 主题会把 --font-* 整体翻成像素族；
     mono 链与 style.css:74 保持一致，改链需双同步 */
  --font-body: 'Inter', 'Noto Sans SC', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, 'PingFang SC', 'Noto Sans SC', monospace;
  --font-display: 'Space Grotesk', 'Inter', 'Noto Sans SC', sans-serif;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  min-height: 100dvh;
  padding: 24px 20px;
  background: var(--ink);
  color: var(--paper);
  gap: 20px;
}

.rc-connecting {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  color: var(--label-grey);
  font-size: 13px;
}

/* 复用 .pixel-loading--on-ink 点阵灯（等宽步进旋转）；这里只放大尺寸 */
.rc-spinner {
  width: 40px;
  height: 40px;
}

.rc-cover-wrap {
  width: 220px;
  height: 220px;
}

.rc-cover {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border: 1.2px solid var(--white-40);
  image-rendering: pixelated;
  display: block;
}

.rc-cover-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--white-16);
  color: var(--label-grey);
}

.rc-song-info {
  text-align: center;
}

.rc-song-name {
  font-family: var(--font-display);
  font-size: 20px;
  font-weight: 700;
  margin-bottom: 6px;
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rc-artist {
  font-size: 13px;
  color: var(--label-grey);
}

.rc-progress-wrap,
.rc-volume-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  max-width: 320px;
}

.rc-time {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--label-grey);
  min-width: 36px;
  text-align: center;
}

.rc-vol-icon {
  display: flex;
  color: var(--label-grey);
}

/* 轨道/柄色由 .pg-range + .pg-range--on-ink 全局供给；这里只补布局、焦点环、14px 加大柄（触屏遥控） */
.rc-slider {
  flex: 1;
  outline: none;
}
.rc-slider:focus-visible { outline: 2px solid var(--paper); outline-offset: 2px; }
.rc-slider::-webkit-slider-thumb { width: 14px; height: 14px; margin-top: -5px; }
.rc-slider::-moz-range-thumb { width: 14px; height: 14px; }

.rc-controls {
  display: flex;
  align-items: center;
  gap: 24px;
}

/* 发丝方键：white-40 描边纸字；主播放键纸白反白 */
.rc-btn {
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1.2px solid var(--white-40);
  color: var(--paper);
  cursor: pointer;
  line-height: 1;
  transition: color .2s, background .12s;
}

.rc-btn:hover { color: var(--accent-magenta-on-ink); }
.rc-btn:active { background: var(--white-16); }

.rc-retry {
  width: auto;
  height: auto;
  padding: 11px 26px;
  background: var(--paper);
  border: none;
  color: var(--ink);
  font-family: var(--font-display);
  font-weight: 500;
  font-size: 13px;
  letter-spacing: .02em;
}

.rc-retry:hover { background: var(--label-grey); }
.rc-retry:active { background: var(--label-grey); }

.rc-btn-main {
  width: 72px;
  height: 72px;
  background: var(--paper);
  border-color: var(--paper);
  color: var(--ink);
}

.rc-btn-main:active { background: var(--label-grey); }

/* 待播队列：留白节奏行，当前行品红左记 */
.rc-queue {
  width: 100%;
  max-width: 360px;
}

.rc-queue-title {
  font-family: var(--font-mono);
  font-weight: 300;
  font-size: 12px;
  letter-spacing: .05em;
  color: var(--label-grey);
  padding-bottom: 8px;
  /* 暗面分区头与亮面同律降档：white-40 → white-16 */
  border-bottom: 1.2px solid var(--white-16);
}

.rc-queue-list {
  max-height: 240px;
  overflow-y: auto;
  scrollbar-gutter: stable;
  /* 暗面上的滚动条柄要换浅柄——全局 ink 柄在此不可见 */
  scrollbar-color: var(--label-grey) transparent;
}
.rc-queue-list::-webkit-scrollbar-thumb {
  background: var(--label-grey);
  border: 2px solid transparent;
  background-clip: padding-box;
}
/* scoped 覆写特异性高于全局 :hover——hover 反馈在此单独补回 */
.rc-queue-list::-webkit-scrollbar-thumb:hover {
  background: var(--white-80);
  background-clip: padding-box;
}

.rc-queue-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 8px;
  background: none;
  border: none;
  border-left: 1.2px solid transparent;
  color: var(--white-80);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: background .12s, color .12s;
}

.rc-queue-row:hover {
  background: var(--white-16);
  color: var(--paper);
}

.rc-queue-row:active {
  background: var(--white-16);
}

.rc-queue-row--current {
  border-left-color: var(--accent-magenta);
  background: var(--white-16);
  color: var(--paper);
}

.rc-queue-idx {
  width: 18px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--label-grey);
}

.rc-queue-row--current .rc-queue-idx {
  color: var(--accent-magenta-on-ink);
}

.rc-queue-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rc-queue-artist {
  flex-shrink: 0;
  max-width: 40%;
  font-size: 11px;
  color: var(--label-grey);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
